/**
 * voiceRestraint.ts — client-side helpers for voice mode's restraint layer.
 *
 * The server decides whether a finished turn deserves a full reply, a brief
 * acknowledgment, or silence. This module owns everything the client layers
 * on top of that decision:
 *
 *  - plain-language copy for the talkativeness control,
 *  - the outcome tracker that pairs each decision with what actually
 *    happened next (the training signal the server stores), and
 *  - the wind-down timing that lets a session ease itself closed.
 *
 * Everything here is pure and timer-free: the tracker resolves outcomes
 * lazily from events + timestamps so it needs no cleanup and stays trivially
 * testable. Only voice mode uses this — typed chat always gets replies.
 */

import type { VenomVoiceTalkativeness } from '@workspace/api-client-react';

// ── Talkativeness copy ───────────────────────────────────────────────────────

export type TalkativenessOption = {
  id: VenomVoiceTalkativeness;
  label: string;
  /** One plain-language line: what this level changes, no jargon. */
  description: string;
};

/** Ordered chatty → reserved, matching the control's left-to-right layout. */
export const TALKATIVENESS_OPTIONS: TalkativenessOption[] = [
  {
    id: 'chatty',
    label: 'Chatty',
    description: 'Answers almost everything — even a stray “okay” gets a nod.',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'Answers real questions, lets throwaway remarks pass quietly.',
  },
  {
    id: 'reserved',
    label: 'Reserved',
    description: 'Speaks when spoken to. Asides and musings are left alone.',
  },
];

export function talkativenessOption(
  id: VenomVoiceTalkativeness | undefined,
): TalkativenessOption {
  return (
    TALKATIVENESS_OPTIONS.find((option) => option.id === id) ??
    TALKATIVENESS_OPTIONS[1]
  );
}

// ── Timing ───────────────────────────────────────────────────────────────────

/**
 * How long after a wind-down decision the session waits — listening, saying
 * nothing — before easing itself closed. Long enough that "alright, cool …
 * oh wait, one more thing" still lands; short enough that the app doesn't
 * sit there glowing all night.
 */
export const WIND_DOWN_CLOSE_DELAY_MS = 16_000;

/**
 * A quiet decision (acknowledge/silent) counts as "user re-engaged" when the
 * next utterance lands inside this window; afterwards it resolves as the
 * restraint having been right.
 */
export const FOLLOW_UP_WINDOW_MS = 30_000;

type WindDownGlobal = { __venomVoiceWindDownMs?: number };

/** UI tests shrink the wind-down wait via a window global (browser only). */
export function resolveWindDownDelayMs(): number {
  if (typeof window !== 'undefined') {
    const override = (window as unknown as WindDownGlobal)
      .__venomVoiceWindDownMs;
    if (typeof override === 'number' && override >= 0) return override;
  }
  return WIND_DOWN_CLOSE_DELAY_MS;
}

// ── Outcome tracking ─────────────────────────────────────────────────────────

export type VoiceDecisionKind = 'respond' | 'acknowledge' | 'silent';

export type VoiceDecisionOutcomeKind =
  | 'reply_completed'
  | 'reply_interrupted'
  | 'user_followed_up'
  | 'stayed_quiet'
  | 'wound_down'
  | 'session_closed';

export type OutcomeReporter = (
  decisionId: string,
  outcome: VoiceDecisionOutcomeKind,
) => void;

export type VoiceOutcomeTracker = {
  /** A fresh decision arrived; any unresolved quiet decision settles first. */
  register: (
    decisionId: string,
    decision: VoiceDecisionKind,
    now?: number,
  ) => void;
  /** The user finished another utterance (this resolves quiet decisions). */
  userSpoke: (now?: number) => void;
  /** The user cut a reply off mid-speech. */
  replyInterrupted: () => void;
  /** A reply (full or brief acknowledgment) played out untouched. */
  replyCompleted: () => void;
  /** The wind-down timer fired and the session is closing itself. */
  woundDown: () => void;
  /** The session is over (user closed it, or it eased shut). */
  sessionClosed: (now?: number) => void;
  /** True while a decision is awaiting its outcome. */
  hasPending: () => boolean;
};

/**
 * Pairs each server decision with the single outcome that follows it.
 *
 * One decision is in flight at a time — voice mode is strictly
 * turn-by-turn — and every registered decision emits exactly one outcome:
 *
 *   respond/acknowledge → reply_completed | reply_interrupted
 *   silent              → user_followed_up | stayed_quiet
 *   any + wind-down     → wound_down when the timer closes the session
 *   anything unresolved → session_closed when the session ends
 *
 * A quiet decision's meaning depends on *when* the next utterance lands:
 * inside the follow-up window it reads as "the user had to re-engage"
 * (restraint may have been wrong); after it, as "the moment passed quietly"
 * (restraint was right). Resolution happens lazily on the next event, so
 * the tracker owns no timers.
 */
export function createVoiceOutcomeTracker(
  report: OutcomeReporter,
): VoiceOutcomeTracker {
  let pending: {
    decisionId: string;
    decision: VoiceDecisionKind;
    registeredAt: number;
  } | null = null;

  const settle = (outcome: VoiceDecisionOutcomeKind) => {
    if (!pending) return;
    const { decisionId } = pending;
    pending = null;
    report(decisionId, outcome);
  };

  /** Quiet decisions read the clock; spoken ones must not linger here. */
  const settleQuietByClock = (now: number) => {
    if (!pending) return;
    if (pending.decision === 'respond') return;
    settle(
      now - pending.registeredAt <= FOLLOW_UP_WINDOW_MS
        ? 'user_followed_up'
        : 'stayed_quiet',
    );
  };

  return {
    register(decisionId, decision, now = Date.now()) {
      // A quiet decision still unresolved when the next turn starts means
      // the user spoke again — settle it against the clock first.
      settleQuietByClock(now);
      // A respond decision still pending here means finalize never fired
      // (e.g. stream fizzled); the reply neither completed nor was cut off
      // by the user, so the only honest label is that the turn moved on.
      settle('user_followed_up');
      pending = { decisionId, decision, registeredAt: now };
    },
    userSpoke(now = Date.now()) {
      settleQuietByClock(now);
    },
    replyInterrupted() {
      if (pending && pending.decision !== 'silent') {
        settle('reply_interrupted');
      }
    },
    replyCompleted() {
      if (pending && pending.decision !== 'silent') {
        settle('reply_completed');
      }
    },
    woundDown() {
      settle('wound_down');
    },
    sessionClosed(now = Date.now()) {
      if (!pending) return;
      if (
        pending.decision !== 'respond' &&
        now - pending.registeredAt > FOLLOW_UP_WINDOW_MS
      ) {
        // The quiet call had already proven itself before the session ended.
        settle('stayed_quiet');
        return;
      }
      settle('session_closed');
    },
    hasPending() {
      return pending !== null;
    },
  };
}
