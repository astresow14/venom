/**
 * useVoiceConversation.ts — orchestrates the hands-free voice loop.
 *
 * One session = mic capture → end-of-speech → transcribe → the same
 * project-scoped /respond stream text chat uses → sentence-by-sentence
 * /voice/speak SSE → streamed playback → listen again. Both sides of every
 * turn are filed into the active conversation exactly like typed messages.
 *
 * The loop talks to audio hardware only through the VoiceAudioAdapter, so
 * browser preview, native devices, and UI tests all run the same code here.
 *
 * Failure stance: quiet and explicit. Mic permission, missing OpenAI audio
 * integration, and dropped connections each surface a small error state with
 * "try again" / "back to text" — never a hang.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSharedValue, type SharedValue } from "react-native-reanimated";
import { useAuth } from "@clerk/expo";
import { fetch as expoFetch } from "expo/fetch";
import { extractVenomKnowledge } from "@workspace/api-client-react";

import {
  useVenom,
  IS_UI_TEST,
  UI_TEST_USER_ID,
  type VenomVoicePresetId,
  type VenomVoiceTalkativeness,
} from "@/context/VenomContext";
import {
  DEFAULT_VOICE_PRESET_ID,
  DEFAULT_VOICE_TALKATIVENESS,
} from "@/context/workspaceSync";
import {
  createVoiceOutcomeTracker,
  resolveWindDownDelayMs,
  type VoiceDecisionOutcomeKind,
  type VoiceOutcomeTracker,
} from "@/hooks/voiceRestraint";
import { buildChatProjectContextBundle } from "@/context/sourceContext";
import {
  createSentenceChunker,
  createSseLineReader,
  type SentenceChunker,
} from "@/context/voiceSpeech";
import {
  getVoiceAudioAdapter,
  type VoiceCaptureEvent,
  type VoiceCaptureHandle,
  type VoicePlaybackEvent,
  type VoicePlaybackHandle,
} from "@/audio";
import type { ProjectSource } from "@/context/VenomContext";

// Mirrors the stand-in token chat uses in browser UI-test builds.
const UI_TEST_CHAT_TOKEN = "venom-ui-test-chat-token";

/** Utterances shorter than this are treated as stray noise, not speech. */
const MIN_UTTERANCE_MS = 300;

export type VoicePhase =
  | "idle"
  | "connecting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

export type VoiceErrorKind =
  | "mic"
  | "unavailable"
  | "unsupported"
  | "network";

export type VoiceError = { kind: VoiceErrorKind; message: string };

export type VoiceTranscriptEntry = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type VoiceCatalogPreset = {
  id: VenomVoicePresetId;
  name: string;
  persona: string;
  tone: string;
  sampleText: string;
  available: boolean;
};

type ActiveProjectLike = {
  id: string;
  name?: string;
  description?: string;
} | null;

let voiceIdCounter = 0;
function voiceId(prefix: string): string {
  voiceIdCounter += 1;
  return `${prefix}-${Date.now()}-${voiceIdCounter}-${Math.random()
    .toString(36)
    .slice(2, 9)}`;
}

class VoiceFlowError extends Error {
  kind: VoiceErrorKind;
  constructor(kind: VoiceErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = "VoiceFlowError";
  }
}

type VoiceTurn = {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  userText: string;
  assistantText: string;
  chunker: SentenceChunker;
  speakQueue: string[];
  pumping: boolean;
  respondDone: boolean;
  playbackBegun: boolean;
  speechFailed: boolean;
  speechUnavailable: boolean;
  finalized: boolean;
  modelId: string;
  modelName: string | null;
  historyForExtraction: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
  }>;
  conversationTitle: string;
  projectId: string | null;
  token: string;
  /** Brief acknowledgments skip knowledge extraction — there is nothing in
   * "Anytime." worth absorbing. */
  skipExtraction?: boolean;
};

type VoiceRun = {
  id: number;
  userId: string;
  capture: VoiceCaptureHandle;
  playback: VoicePlaybackHandle;
  aborts: Set<AbortController>;
  turn: VoiceTurn | null;
  stopping: boolean;
  /** Pairs each restraint decision with the outcome that followed it. */
  tracker: VoiceOutcomeTracker;
  /** Armed after a wind-down turn: sustained quiet eases the session shut. */
  windDownTimer: ReturnType<typeof setTimeout> | null;
  /** Set while an acknowledgment turn should arm wind-down once it finishes. */
  windDownAfterTurn: boolean;
};

/** What filing the user's side of a turn produced (shared by all paths). */
type TurnFiling = {
  conversationId: string;
  userMessageId: string;
  historyMessages: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
  }>;
  conversationTitle: string;
  onScreenProjectId: string | null;
};

/** The server's restraint call for one finished voice turn. */
type TurnDecision = {
  /** Absent when the decision row isn't durable — execute, don't track. */
  decisionId?: string;
  decision: "respond" | "acknowledge" | "silent";
  windDown: boolean;
  acknowledgment?: string;
};

export type VoiceConversation = {
  phase: VoicePhase;
  error: VoiceError | null;
  /** Soft, non-fatal notices ("Didn't catch that"). */
  notice: string | null;
  /** True when the session eased itself closed after a wind-down. */
  endedQuietly: boolean;
  userSpeaking: boolean;
  liveUserText: string | null;
  liveAssistantText: string;
  transcript: VoiceTranscriptEntry[];
  inputLevel: SharedValue<number>;
  outputLevel: SharedValue<number>;
  presets: VoiceCatalogPreset[];
  activePresetId: VenomVoicePresetId;
  activePreset: VoiceCatalogPreset | null;
  selectPreset: (id: VenomVoicePresetId) => void;
  begin: () => Promise<void>;
  end: () => void;
  interrupt: () => void;
  retry: () => void;
};

export function useVoiceConversation(
  activeProject: ActiveProjectLike,
): VoiceConversation {
  const { getToken, userId: authenticatedUserId } = useAuth();
  const userId = IS_UI_TEST ? UI_TEST_USER_ID : (authenticatedUserId ?? null);
  const {
    state,
    addMessage,
    createNewConversation,
    setActiveConversation,
    applyKnowledgeInsights,
    setVoicePreset,
  } = useVenom();

  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [error, setError] = useState<VoiceError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [endedQuietly, setEndedQuietly] = useState(false);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [liveUserText, setLiveUserText] = useState<string | null>(null);
  const [liveAssistantText, setLiveAssistantText] = useState("");
  const [transcript, setTranscript] = useState<VoiceTranscriptEntry[]>([]);
  const [presets, setPresets] = useState<VoiceCatalogPreset[]>([]);

  const inputLevel = useSharedValue(0);
  const outputLevel = useSharedValue(0);

  const stateRef = useRef(state);
  stateRef.current = state;
  const activeProjectRef = useRef(activeProject);
  activeProjectRef.current = activeProject;
  const phaseRef = useRef<VoicePhase>("idle");
  const runRef = useRef<VoiceRun | null>(null);
  const runCounter = useRef(0);

  const activePresetId: VenomVoicePresetId = (state.voicePreferences?.presetId ??
    DEFAULT_VOICE_PRESET_ID) as VenomVoicePresetId;
  const activePresetIdRef = useRef(activePresetId);
  activePresetIdRef.current = activePresetId;
  const activePreset =
    presets.find((preset) => preset.id === activePresetId) ?? null;

  const movePhase = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const resolveToken = useCallback(async (): Promise<string> => {
    const token = IS_UI_TEST ? UI_TEST_CHAT_TOKEN : await getToken();
    if (!token) {
      throw new VoiceFlowError("network", "You need to be signed in to talk.");
    }
    return token;
  }, [getToken]);

  const apiBase = useCallback((): string => {
    const domain = process.env.EXPO_PUBLIC_DOMAIN;
    if (!domain) {
      throw new VoiceFlowError("network", "The API server is unreachable.");
    }
    return `https://${domain}`;
  }, []);

  // ── Wind-down: sustained quiet eases the session shut ────────────────────

  // end() is declared far below; the timer reaches it through a ref, the
  // same way finalizeTurnRef breaks its cycle.
  const endRef = useRef<(() => void) | null>(null);

  const disarmWindDown = useCallback((run: VoiceRun) => {
    if (run.windDownTimer) {
      clearTimeout(run.windDownTimer);
      run.windDownTimer = null;
    }
    run.windDownAfterTurn = false;
  }, []);

  const armWindDown = useCallback((run: VoiceRun) => {
    if (run.windDownTimer) clearTimeout(run.windDownTimer);
    run.windDownTimer = setTimeout(() => {
      run.windDownTimer = null;
      if (runRef.current?.id !== run.id || run.stopping) return;
      // Only a session still quietly listening may ease itself closed; any
      // re-engagement (speech, a new turn) has already disarmed this timer.
      if (phaseRef.current !== "listening") return;
      run.tracker.woundDown();
      setEndedQuietly(true);
      endRef.current?.();
    }, resolveWindDownDelayMs());
  }, []);

  /** Fire-and-forget: outcomes are a training signal, never a failure mode. */
  const reportDecisionOutcome = useCallback(
    async (decisionId: string, outcome: VoiceDecisionOutcomeKind) => {
      try {
        const token = await resolveToken();
        await expoFetch(`${apiBase()}/api/venom/voice/decision-outcome`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ decisionId, outcome }),
        });
      } catch {
        // Losing an outcome report costs nothing the user can see.
      }
    },
    [apiBase, resolveToken],
  );

  /** Tear the whole session down. Keeps error/transcript state for the UI. */
  const teardown = useCallback(() => {
    const run = runRef.current;
    if (!run) return;
    run.stopping = true;
    disarmWindDown(run);
    for (const controller of run.aborts) controller.abort();
    run.aborts.clear();
    try {
      run.playback.stop();
    } catch {
      // best-effort
    }
    try {
      run.capture.stop();
    } catch {
      // best-effort
    }
    runRef.current = null;
    inputLevel.value = 0;
    outputLevel.value = 0;
    setUserSpeaking(false);
  }, [disarmWindDown, inputLevel, outputLevel]);

  const failSession = useCallback(
    (voiceError: VoiceError) => {
      // File any partial reply before the session goes down.
      const run = runRef.current;
      if (run?.turn && !run.turn.finalized) {
        finalizeTurnRef.current?.(run, { resume: false });
      }
      // A decision still waiting on its outcome ends with the session.
      run?.tracker.sessionClosed();
      teardown();
      setError(voiceError);
      movePhase("error");
    },
    [movePhase, teardown],
  );

  // ── Assistant turn finalization ───────────────────────────────────────────

  const finalizeTurnRef = useRef<
    ((run: VoiceRun, opts: { resume: boolean }) => void) | null
  >(null);

  finalizeTurnRef.current = (run: VoiceRun, opts: { resume: boolean }) => {
    const turn = run.turn;
    if (!turn || turn.finalized) return;
    turn.finalized = true;
    run.turn = null;

    const text = turn.assistantText.trim();
    if (text.length > 0) {
      addMessage(turn.conversationId, {
        id: turn.assistantMessageId,
        role: "assistant",
        content: text,
        status: "sent",
        ...(turn.modelId
          ? {
              modelId: turn.modelId as never,
              modelName: turn.modelName ?? undefined,
            }
          : {}),
      });
      setTranscript((entries) => [
        ...entries,
        { id: turn.assistantMessageId, role: "assistant", text },
      ]);

      // Same background knowledge extraction as typed chat.
      if (!turn.skipExtraction)
        void extractVenomKnowledge(
        {
          conversation: {
            id: turn.conversationId,
            title: turn.conversationTitle,
            projectId: turn.projectId,
          },
          messages: [
            ...turn.historyForExtraction,
            { id: turn.userMessageId, role: "user", content: turn.userText },
            {
              id: turn.assistantMessageId,
              role: "assistant",
              content: text.slice(0, 8000),
            },
          ],
        },
        { headers: { Authorization: `Bearer ${turn.token}` } },
      )
        .then((result) => {
          if (runRef.current?.id !== run.id && phaseRef.current === "idle") {
            return;
          }
          applyKnowledgeInsights(
            {
              id: turn.conversationId,
              title: turn.conversationTitle,
              projectId: turn.projectId,
            },
            result.clusters,
          );
        })
        .catch(() => {
          // Voice chat stays usable when extraction is unavailable.
        });
    }

    setLiveAssistantText("");
    setLiveUserText(null);
    outputLevel.value = 0;

    if (turn.speechUnavailable) {
      teardown();
      setError({
        kind: "unavailable",
        message:
          "Voice is not configured right now. Your conversation continues in text.",
      });
      movePhase("error");
      return;
    }

    if (opts.resume && runRef.current?.id === run.id && !run.stopping) {
      if (turn.speechFailed) {
        setNotice("Playback stumbled — the reply is in the thread.");
      }
      run.capture.resume();
      movePhase("listening");
      if (run.windDownAfterTurn) {
        // A wind-down closer played out: keep its decision pending and start
        // the quiet-close clock — the timer (wound_down), a re-engagement
        // (user_followed_up) or a manual close will settle it.
        run.windDownAfterTurn = false;
        armWindDown(run);
      } else {
        // The reply played out untouched (an interrupt settles first,
        // making this a no-op).
        run.tracker.replyCompleted();
      }
    }
  };

  // ── Speech synthesis queue ────────────────────────────────────────────────

  const speakSegment = useCallback(
    async (run: VoiceRun, turn: VoiceTurn, segment: string): Promise<void> => {
      const controller = new AbortController();
      run.aborts.add(controller);
      try {
        const response = await expoFetch(`${apiBase()}/api/venom/voice/speak`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            Authorization: `Bearer ${turn.token}`,
          },
          body: JSON.stringify({
            text: segment.slice(0, 2000),
            presetId: activePresetIdRef.current,
          }),
          signal: controller.signal,
        });
        if (response.status === 503) {
          turn.speechUnavailable = true;
          turn.speechFailed = true;
          return;
        }
        if (!response.ok) {
          turn.speechFailed = true;
          return;
        }
        const reader = response.body?.getReader();
        if (!reader) {
          turn.speechFailed = true;
          return;
        }
        const decoder = new TextDecoder();
        let streamFailed = false;
        const sse = createSseLineReader((payload) => {
          if (payload === "[DONE]") return;
          try {
            const parsed = JSON.parse(payload) as {
              format?: { sampleRate?: number };
              audio?: string;
              error?: string;
            };
            if (parsed.format && !turn.playbackBegun) {
              turn.playbackBegun = true;
              run.playback.begin({
                sampleRate: parsed.format.sampleRate ?? 24_000,
              });
            }
            if (parsed.audio && turn.playbackBegun && !turn.speechFailed) {
              run.playback.enqueueChunk(parsed.audio);
            }
            if (parsed.error) streamFailed = true;
          } catch {
            // Ignore malformed events; the missing audio is the signal.
          }
        });
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (run.stopping || turn.finalized) {
            await reader.cancel();
            return;
          }
          sse.push(decoder.decode(value, { stream: true }));
        }
        sse.end();
        if (streamFailed) turn.speechFailed = true;
      } catch (err) {
        if ((err as Error | null)?.name !== "AbortError") {
          turn.speechFailed = true;
        }
      } finally {
        run.aborts.delete(controller);
      }
    },
    [apiBase],
  );

  const maybeCloseTurnAudio = useCallback((run: VoiceRun) => {
    const turn = run.turn;
    if (!turn || turn.finalized) return;
    if (!turn.respondDone || turn.pumping || turn.speakQueue.length > 0) return;
    if (turn.playbackBegun && !turn.speechFailed) {
      // 'finished' from playback finalizes the turn.
      run.playback.end();
      return;
    }
    // Nothing speakable (empty reply or failed synthesis): finalize directly.
    finalizeTurnRef.current?.(run, { resume: true });
  }, []);

  const pumpSpeech = useCallback(
    async (run: VoiceRun) => {
      const turn = run.turn;
      if (!turn || turn.pumping) return;
      turn.pumping = true;
      try {
        while (
          runRef.current?.id === run.id &&
          run.turn === turn &&
          !turn.finalized &&
          !turn.speechFailed &&
          turn.speakQueue.length > 0
        ) {
          const segment = turn.speakQueue.shift();
          if (!segment) break;
          await speakSegment(run, turn, segment);
        }
      } finally {
        turn.pumping = false;
      }
      maybeCloseTurnAudio(run);
    },
    [maybeCloseTurnAudio, speakSegment],
  );

  const enqueueSpeech = useCallback(
    (run: VoiceRun, segment: string) => {
      const turn = run.turn;
      if (!turn || turn.finalized || turn.speechFailed) return;
      if (segment.trim().length === 0) return;
      turn.speakQueue.push(segment);
      void pumpSpeech(run);
    },
    [pumpSpeech],
  );

  // ── Filing the user's side of a turn ──────────────────────────────────────

  // Every decision path files the user's words identically — a remark that
  // earned silence still belongs to the conversation record.
  const fileUserTurn = useCallback(
    (userText: string): TurnFiling => {
      const snapshot = stateRef.current;
      const project = activeProjectRef.current;
      const onScreenProjectId: string | null =
        project?.id ?? snapshot.activeProjectId;

      // Never file into a session owned by another project (chat parity).
      let conversationId = snapshot.activeConversationId;
      const conversation = snapshot.conversations.find(
        (item) => item.id === conversationId,
      );
      if (
        !conversationId ||
        (conversation?.projectId ?? null) !== onScreenProjectId
      ) {
        conversationId = createNewConversation(onScreenProjectId);
        setActiveConversation(conversationId);
      }
      const historyMessages =
        (conversationId === snapshot.activeConversationId
          ? conversation?.messages
          : undefined) ?? [];

      const userMessageId = voiceId("voice-user");
      addMessage(conversationId, {
        id: userMessageId,
        role: "user",
        content: userText,
        status: "sent",
      });
      setTranscript((entries) => [
        ...entries,
        { id: userMessageId, role: "user", text: userText },
      ]);
      // The words now live in the transcript; keeping the live bubble too
      // would show the same utterance twice.
      setLiveUserText(null);

      const conversationTitle =
        !conversation || conversation.title === "New Session"
          ? `${userText.slice(0, 30)}...`
          : conversation.title;

      return {
        conversationId,
        userMessageId,
        historyMessages,
        conversationTitle,
        onScreenProjectId,
      };
    },
    [addMessage, createNewConversation, setActiveConversation],
  );

  // ── The assistant reply turn ──────────────────────────────────────────────

  const runAssistantTurn = useCallback(
    async (run: VoiceRun, userText: string, token: string) => {
      const snapshot = stateRef.current;
      const project = activeProjectRef.current;
      const {
        conversationId,
        userMessageId,
        historyMessages,
        conversationTitle,
        onScreenProjectId,
      } = fileUserTurn(userText);

      const projectSources = (snapshot.sources ?? []).filter(
        (source: ProjectSource) =>
          source.projectId === project?.id && source.status === "connected",
      );
      const {
        context: projectContext,
        citationIds: sourceCitationIds,
        sourceSnapshots,
      } = buildChatProjectContextBundle({
        projectName: project?.name,
        projectDescription: project?.description,
        sources: projectSources,
      });

      const sendingModelId =
        snapshot.modelPreferences?.activeModelId ?? "venom-gpt";

      const turn: VoiceTurn = {
        conversationId,
        userMessageId,
        assistantMessageId: voiceId("voice-assistant"),
        userText,
        assistantText: "",
        chunker: createSentenceChunker(),
        speakQueue: [],
        pumping: false,
        respondDone: false,
        playbackBegun: false,
        speechFailed: false,
        speechUnavailable: false,
        finalized: false,
        modelId: sendingModelId,
        modelName: null,
        historyForExtraction: historyMessages.slice(-46).map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content.slice(0, 8000),
        })),
        conversationTitle,
        projectId: onScreenProjectId,
        token,
      };
      run.turn = turn;
      movePhase("thinking");
      setLiveAssistantText("");

      const controller = new AbortController();
      run.aborts.add(controller);
      let streamCompleted = false;
      try {
        const response = await expoFetch(`${apiBase()}/api/venom/respond`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            messages: [
              ...historyMessages
                .slice(-23)
                .map((message) => ({
                  role: message.role,
                  content: message.content,
                })),
              { role: "user", content: userText },
            ],
            projectId: onScreenProjectId,
            modelId: sendingModelId,
            projectContext,
            sourceCitationIds,
            sourceSnapshots,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new VoiceFlowError(
            "network",
            response.status === 429
              ? "Venom needs a moment. Try again shortly."
              : "The reply could not be generated.",
          );
        }
        const reader = response.body?.getReader();
        if (!reader) {
          throw new VoiceFlowError("network", "No response stream received.");
        }
        const decoder = new TextDecoder();
        const sse = createSseLineReader((payload) => {
          if (payload === "[DONE]") {
            streamCompleted = true;
            return;
          }
          try {
            const parsed = JSON.parse(payload) as {
              content?: string;
              error?: string;
              done?: boolean;
              modelId?: string;
              modelName?: string;
            };
            if (parsed.error) {
              turn.speechFailed = true;
              throw new VoiceFlowError("network", parsed.error);
            }
            if (parsed.done === true) streamCompleted = true;
            if (parsed.modelId) turn.modelId = parsed.modelId;
            if (parsed.modelName) turn.modelName = parsed.modelName;
            if (parsed.content) {
              turn.assistantText += parsed.content;
              setLiveAssistantText(turn.assistantText);
              for (const segment of turn.chunker.push(parsed.content)) {
                enqueueSpeech(run, segment);
              }
            }
          } catch (parseError) {
            if (parseError instanceof VoiceFlowError) throw parseError;
            // Malformed events fail via the missing [DONE] marker instead.
          }
        });
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (run.stopping || turn.finalized) {
            await reader.cancel();
            return;
          }
          sse.push(decoder.decode(value, { stream: true }));
        }
        sse.end();
        if (!streamCompleted) {
          throw new VoiceFlowError("network", "The reply was interrupted.");
        }
        turn.respondDone = true;
        const tail = turn.chunker.flush();
        if (tail) enqueueSpeech(run, tail);
        maybeCloseTurnAudio(run);
      } catch (err) {
        if (run.stopping || turn.finalized) return;
        if ((err as Error | null)?.name === "AbortError") return;
        turn.respondDone = true;
        const message =
          err instanceof VoiceFlowError
            ? err.message
            : "The connection dropped mid-reply.";
        if (turn.assistantText.trim().length > 0) {
          // Keep what was said; surface a soft notice and keep listening.
          for (const controllerToStop of run.aborts) controllerToStop.abort();
          run.playback.stop();
          finalizeTurnRef.current?.(run, { resume: true });
          setNotice(message);
        } else {
          failSession({ kind: "network", message });
        }
      } finally {
        run.aborts.delete(controller);
      }
    },
    [
      apiBase,
      enqueueSpeech,
      failSession,
      fileUserTurn,
      maybeCloseTurnAudio,
      movePhase,
    ],
  );

  // ── The brief-acknowledgment turn ─────────────────────────────────────────

  // A short line ("Anytime." / "Good night.") spoken through the normal
  // synthesis path and filed like any reply — minus model attribution and
  // knowledge extraction, which have nothing to work with here.
  const runAcknowledgeTurn = useCallback(
    (
      run: VoiceRun,
      userText: string,
      acknowledgment: string,
      token: string,
      filing: TurnFiling,
    ) => {
      const turn: VoiceTurn = {
        conversationId: filing.conversationId,
        userMessageId: filing.userMessageId,
        assistantMessageId: voiceId("voice-assistant"),
        userText,
        assistantText: acknowledgment,
        chunker: createSentenceChunker(),
        speakQueue: [],
        pumping: false,
        respondDone: true,
        playbackBegun: false,
        speechFailed: false,
        speechUnavailable: false,
        finalized: false,
        modelId: "",
        modelName: null,
        historyForExtraction: [],
        conversationTitle: filing.conversationTitle,
        projectId: filing.onScreenProjectId,
        token,
        skipExtraction: true,
      };
      run.turn = turn;
      movePhase("thinking");
      setLiveAssistantText(acknowledgment);
      enqueueSpeech(run, acknowledgment);
      maybeCloseTurnAudio(run);
    },
    [enqueueSpeech, maybeCloseTurnAudio, movePhase],
  );

  // ── Turn-end restraint decision ───────────────────────────────────────────

  /**
   * Ask the server whether this turn deserves a reply at all. Every failure
   * mode — timeout, network, bad payload — resolves to null, which the
   * caller treats as "respond": restraint must never swallow a request.
   */
  const requestTurnDecision = useCallback(
    async (
      run: VoiceRun,
      transcriptText: string,
      token: string,
    ): Promise<TurnDecision | null> => {
      const snapshot = stateRef.current;
      const project = activeProjectRef.current;
      const onScreenProjectId: string | null =
        project?.id ?? snapshot.activeProjectId;
      const conversation = snapshot.conversations.find(
        (item) => item.id === snapshot.activeConversationId,
      );
      const recentTurns =
        (conversation?.projectId ?? null) === onScreenProjectId
          ? (conversation?.messages ?? [])
              .filter(
                (message) =>
                  (message.role === "user" || message.role === "assistant") &&
                  message.content.trim().length > 0,
              )
              .slice(-8)
              .map((message) => ({
                role: message.role,
                content: message.content.slice(0, 4000),
              }))
          : [];
      const talkativeness: VenomVoiceTalkativeness =
        snapshot.voicePreferences?.talkativeness ?? DEFAULT_VOICE_TALKATIVENESS;

      const controller = new AbortController();
      run.aborts.add(controller);
      const deadline = setTimeout(() => controller.abort(), 4_000);
      try {
        const response = await expoFetch(
          `${apiBase()}/api/venom/voice/decide`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              transcript: transcriptText.slice(0, 8000),
              recentTurns,
              talkativeness,
            }),
            signal: controller.signal,
          },
        );
        if (!response.ok) return null;
        const body = (await response.json()) as Partial<TurnDecision> | null;
        if (
          !body ||
          (body.decision !== "respond" &&
            body.decision !== "acknowledge" &&
            body.decision !== "silent")
        ) {
          return null;
        }
        return {
          // The server omits the id when the decision row isn't durable yet;
          // the decision still stands — the turn just goes untracked.
          decisionId:
            typeof body.decisionId === "string" && body.decisionId.length > 0
              ? body.decisionId
              : undefined,
          decision: body.decision,
          windDown: body.windDown === true,
          acknowledgment:
            typeof body.acknowledgment === "string" &&
            body.acknowledgment.trim().length > 0
              ? body.acknowledgment
              : undefined,
        };
      } catch {
        return null;
      } finally {
        clearTimeout(deadline);
        run.aborts.delete(controller);
      }
    },
    [apiBase],
  );

  // ── Utterance → transcription ─────────────────────────────────────────────

  const handleUtterance = useCallback(
    async (run: VoiceRun, audioBase64: string) => {
      run.capture.pause();
      setUserSpeaking(false);
      setNotice(null);
      movePhase("transcribing");
      let token: string;
      try {
        token = await resolveToken();
      } catch (err) {
        failSession({
          kind: "network",
          message: (err as Error).message,
        });
        return;
      }
      try {
        const response = await expoFetch(
          `${apiBase()}/api/venom/voice/transcribe`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ audioBase64 }),
          },
        );
        if (response.status === 503) {
          failSession({
            kind: "unavailable",
            message:
              "Voice is not configured right now. Your conversation continues in text.",
          });
          return;
        }
        if (!response.ok) {
          throw new Error(`Transcription failed (${response.status})`);
        }
        const body = (await response.json()) as { text?: string };
        const text = (body.text ?? "").trim();
        if (runRef.current?.id !== run.id || run.stopping) return;
        if (!text) {
          setNotice("Didn't catch that — go again.");
          run.capture.resume();
          movePhase("listening");
          return;
        }
        setLiveUserText(text);

        // A real utterance settles any quiet decision still waiting on
        // "did the user have to re-engage?".
        run.tracker.userSpoke();

        const decision = await requestTurnDecision(run, text, token);
        if (runRef.current?.id !== run.id || run.stopping) return;

        if (!decision || decision.decision === "respond") {
          if (decision?.decisionId) {
            run.tracker.register(decision.decisionId, "respond");
          }
          await runAssistantTurn(run, text, token);
          return;
        }

        // Quiet paths: the user's words are filed exactly like any turn.
        const filing = fileUserTurn(text);
        if (decision.decisionId) {
          run.tracker.register(decision.decisionId, decision.decision);
        }

        if (decision.decision === "acknowledge" && decision.acknowledgment) {
          if (decision.windDown) run.windDownAfterTurn = true;
          runAcknowledgeTurn(run, text, decision.acknowledgment, token, filing);
          return;
        }

        // Stay silent: no reply, no announcement — the orb just relaxes
        // back into listening. Wind-downs start the quiet-close clock.
        if (decision.windDown) armWindDown(run);
        run.capture.resume();
        movePhase("listening");
      } catch {
        if (runRef.current?.id !== run.id || run.stopping) return;
        // One bad utterance shouldn't end the session — keep listening.
        setNotice("That didn't come through. Say it again?");
        run.capture.resume();
        movePhase("listening");
      }
    },
    [
      apiBase,
      armWindDown,
      failSession,
      fileUserTurn,
      movePhase,
      requestTurnDecision,
      resolveToken,
      runAcknowledgeTurn,
      runAssistantTurn,
    ],
  );

  // ── Audio event plumbing ──────────────────────────────────────────────────

  const handleCaptureEvent = useCallback(
    (run: VoiceRun) => (event: VoiceCaptureEvent) => {
      if (runRef.current?.id !== run.id) return;
      switch (event.type) {
        case "level":
          inputLevel.value = event.level;
          break;
        case "speech-start":
          // The user re-engaged: a session about to ease itself closed
          // stays open the instant they start talking.
          disarmWindDown(run);
          if (phaseRef.current === "listening") {
            setUserSpeaking(true);
            setNotice(null);
          }
          break;
        case "utterance":
          if (phaseRef.current !== "listening") return;
          if (event.durationMs < MIN_UTTERANCE_MS) return;
          disarmWindDown(run);
          void handleUtterance(run, event.audioBase64);
          break;
        case "error":
          if (event.code === "permission_denied") {
            failSession({
              kind: "mic",
              message:
                "Venom can't hear you — microphone access is off. Allow the mic, or keep chatting by text.",
            });
          } else if (event.code === "unsupported") {
            failSession({
              kind: "unsupported",
              message:
                "This device can't run voice mode. Text chat still works.",
            });
          } else {
            failSession({
              kind: "network",
              message: event.message || "The microphone stopped working.",
            });
          }
          break;
      }
    },
    [disarmWindDown, failSession, handleUtterance, inputLevel],
  );

  const handlePlaybackEvent = useCallback(
    (run: VoiceRun) => (event: VoicePlaybackEvent) => {
      if (runRef.current?.id !== run.id) return;
      switch (event.type) {
        case "started":
          if (run.turn && !run.turn.finalized) movePhase("speaking");
          break;
        case "level":
          outputLevel.value = event.level;
          break;
        case "finished":
          outputLevel.value = 0;
          finalizeTurnRef.current?.(run, { resume: true });
          break;
        case "error":
          if (run.turn) run.turn.speechFailed = true;
          outputLevel.value = 0;
          finalizeTurnRef.current?.(run, { resume: true });
          break;
      }
    },
    [movePhase, outputLevel],
  );

  // ── Catalog ───────────────────────────────────────────────────────────────

  const loadCatalog = useCallback(
    async (token: string): Promise<VoiceCatalogPreset[]> => {
      const response = await expoFetch(`${apiBase()}/api/venom/voice/catalog`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 503) {
        throw new VoiceFlowError(
          "unavailable",
          "Voice is not configured right now. Chat continues in text.",
        );
      }
      if (!response.ok) {
        throw new VoiceFlowError(
          "network",
          "Voice mode could not connect. Check your connection and try again.",
        );
      }
      const catalog = (await response.json()) as VoiceCatalogPreset[];
      if (!Array.isArray(catalog) || catalog.length === 0) {
        throw new VoiceFlowError("network", "The voice list failed to load.");
      }
      if (catalog.every((preset) => preset.available === false)) {
        throw new VoiceFlowError(
          "unavailable",
          "Voice is not configured right now. Chat continues in text.",
        );
      }
      return catalog;
    },
    [apiBase],
  );

  // ── Session lifecycle ─────────────────────────────────────────────────────

  const begin = useCallback(async () => {
    if (runRef.current) return;
    setError(null);
    setNotice(null);
    setEndedQuietly(false);
    setTranscript([]);
    setLiveUserText(null);
    setLiveAssistantText("");
    movePhase("connecting");

    const adapter = getVoiceAudioAdapter();
    const support = adapter.isSupported();
    if (!support.supported) {
      setError({ kind: "unsupported", message: support.reason });
      movePhase("error");
      return;
    }
    if (!userId) {
      setError({
        kind: "network",
        message: "You need to be signed in to talk.",
      });
      movePhase("error");
      return;
    }

    let token: string;
    try {
      token = await resolveToken();
      setPresets(await loadCatalog(token));
    } catch (err) {
      const flowError =
        err instanceof VoiceFlowError
          ? err
          : new VoiceFlowError(
              "network",
              "Voice mode could not connect. Check your connection and try again.",
            );
      setError({ kind: flowError.kind, message: flowError.message });
      movePhase("error");
      return;
    }

    runCounter.current += 1;
    const run: VoiceRun = {
      id: runCounter.current,
      userId,
      capture: null as unknown as VoiceCaptureHandle,
      playback: null as unknown as VoicePlaybackHandle,
      aborts: new Set(),
      turn: null,
      stopping: false,
      tracker: createVoiceOutcomeTracker((decisionId, outcome) => {
        void reportDecisionOutcome(decisionId, outcome);
      }),
      windDownTimer: null,
      windDownAfterTurn: false,
    };
    run.capture = adapter.createCapture(handleCaptureEvent(run));
    run.playback = adapter.createPlayback(handlePlaybackEvent(run));
    runRef.current = run;

    await run.capture.start();
    if (runRef.current?.id !== run.id) return;
    // A capture error during start() moves the phase to 'error'; only a
    // still-connecting session may proceed to listening.
    if (phaseRef.current === "connecting") {
      movePhase("listening");
    }
  }, [
    handleCaptureEvent,
    handlePlaybackEvent,
    loadCatalog,
    movePhase,
    reportDecisionOutcome,
    resolveToken,
    userId,
  ]);

  const interrupt = useCallback(() => {
    const run = runRef.current;
    if (!run || !run.turn || run.turn.finalized) return;
    if (phaseRef.current !== "speaking" && phaseRef.current !== "thinking") {
      return;
    }
    // Cutting a reply off is itself the outcome — and it cancels any
    // wind-down: the user clearly wants the floor.
    run.tracker.replyInterrupted();
    disarmWindDown(run);
    for (const controller of run.aborts) controller.abort();
    run.aborts.clear();
    run.turn.speakQueue.length = 0;
    run.playback.stop();
    finalizeTurnRef.current?.(run, { resume: true });
  }, [disarmWindDown]);

  const end = useCallback(() => {
    const run = runRef.current;
    if (run) {
      if (run.turn && !run.turn.finalized) {
        for (const controller of run.aborts) controller.abort();
        run.playback.stop();
        finalizeTurnRef.current?.(run, { resume: false });
      }
      // Whatever decision was still open ends with the session; a quiet
      // call that had already proven itself settles as stayed_quiet.
      run.tracker.sessionClosed();
      teardown();
    }
    setNotice(null);
    setUserSpeaking(false);
    setLiveUserText(null);
    setLiveAssistantText("");
    movePhase("idle");
  }, [movePhase, teardown]);
  endRef.current = end;

  const retry = useCallback(() => {
    if (runRef.current) return;
    void begin();
  }, [begin]);

  const selectPreset = useCallback(
    (id: VenomVoicePresetId) => {
      setVoicePreset(id);
    },
    [setVoicePreset],
  );

  // The session is bound to the account that started it: if the signed-in
  // user changes mid-session, the loop must not keep filing messages.
  useEffect(() => {
    const run = runRef.current;
    if (run && run.userId !== userId) end();
  }, [end, userId]);

  useEffect(() => () => end(), [end]);

  return {
    phase,
    error,
    notice,
    endedQuietly,
    userSpeaking,
    liveUserText,
    liveAssistantText,
    transcript,
    inputLevel,
    outputLevel,
    presets,
    activePresetId,
    activePreset,
    selectPreset,
    begin,
    end,
    interrupt,
    retry,
  };
}
