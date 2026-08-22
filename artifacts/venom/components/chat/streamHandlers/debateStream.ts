import type {
  DebateTurnLive,
  DeliberationRosterVoice,
  LocalDebate,
} from "@/components/chat/chatTypes";

/**
 * Debate-mode SSE events, isolated from the other response modes: roster
 * metadata, per-turn markers, per-turn chunks, and turn endings. The handler
 * owns the debate accumulators for one send; `handleEvent` returns true when
 * it consumed the event — debate lines must never fall through into the
 * generic content branch, or debate text leaks into a single answer bubble.
 */
export function createDebateStreamHandler(deps: {
  /** Mirrors the live round into transient UI state. */
  publish: (snapshot: LocalDebate) => void;
  setShowTyping: (value: boolean) => void;
  /**
   * Persist a finished turn immediately so it survives a stop or reload and
   * syncs to other devices as a normal attributed assistant message. The
   * caller also appends it to the running debate history. Returns the
   * persisted message id so a settling turn can be identified later.
   */
  persistTurn: (turn: DebateTurnLive, content: string) => string;
  /** Between turns is where user interjections take effect. */
  hasPendingInterjections: () => boolean;
}) {
  let roster: DeliberationRosterVoice[] | null = null;
  let plannedTurns = 0;
  let currentTurn: DebateTurnLive | null = null;
  const failedNames: string[] = [];
  let restartRound = false;
  // The round's conclusion — the closing turn, if it landed — is the only
  // debate text the Brain may absorb.
  let settledTurn: { id: string; content: string } | null = null;

  const sync = () => {
    if (!roster) return;
    deps.publish({
      roster,
      of: plannedTurns,
      current: currentTurn ? { ...currentTurn } : null,
      failedNames: [...failedNames],
    });
  };

  return {
    /** An interjection is waiting: the reader should end this round. */
    get restartRequested() {
      return restartRound;
    },
    /** The closing turn that settled this round, if it landed with content. */
    get settledTurn() {
      return settledTurn;
    },
    /** A fresh round is starting (first or after an interjection restart). */
    beginRound() {
      restartRound = false;
      // Each round settles on its own closing turn; a restarted round
      // starts unsettled.
      settledTurn = null;
    },
    /** The queued interjections joined the history; drop the half-spoken turn. */
    applyInterjections() {
      currentTurn = null;
      sync();
    },
    handleEvent(parsed: any): boolean {
      if (parsed.debate?.voices && Array.isArray(parsed.debate.voices)) {
        roster = parsed.debate.voices as DeliberationRosterVoice[];
        plannedTurns =
          typeof parsed.debate.turns === "number"
            ? parsed.debate.turns
            : roster.length;
        deps.setShowTyping(false);
        sync();
        return true;
      }
      if (parsed.debateTurn) {
        currentTurn = {
          index: Number(parsed.debateTurn.index ?? 0),
          voiceId: String(parsed.debateTurn.voiceId ?? ""),
          name: String(parsed.debateTurn.name ?? "Voice"),
          modelId:
            typeof parsed.debateTurn.modelId === "string"
              ? parsed.debateTurn.modelId
              : undefined,
          modelName:
            typeof parsed.debateTurn.modelName === "string"
              ? parsed.debateTurn.modelName
              : undefined,
          content: "",
        };
        if (typeof parsed.debateTurn.of === "number") {
          plannedTurns = parsed.debateTurn.of;
        }
        sync();
        return true;
      }
      if (typeof parsed.turn === "number" && roster) {
        const turn = currentTurn;
        if (parsed.turnStatus === "ok" || parsed.turnStatus === "failed") {
          if (turn && parsed.turnStatus === "ok" && turn.content.trim()) {
            const persistedContent = turn.content.trim();
            const persistedId = deps.persistTurn(turn, persistedContent);
            // The round's final planned turn is its conclusion: the closing
            // voice weighs the exchange and lands the final word. Only that
            // turn can settle the debate for the Brain.
            if (plannedTurns > 0 && turn.index === plannedTurns - 1) {
              settledTurn = { id: persistedId, content: persistedContent };
            }
          } else if (turn) {
            // A failed voice doesn't kill the round; the debate carries on
            // and the miss is noted in the live panel.
            failedNames.push(turn.name);
          }
          currentTurn = null;
          sync();
          if (deps.hasPendingInterjections()) {
            restartRound = true;
          }
        } else if (turn && parsed.content && parsed.turn === turn.index) {
          turn.content += parsed.content;
          sync();
        }
        return true;
      }
      return false;
    },
  };
}

export type DebateStreamHandler = ReturnType<typeof createDebateStreamHandler>;
