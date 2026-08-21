import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import {
  extractVenomKnowledge,
  getGetSharedWorkspaceKnowledgeQueryKey,
  getGetVenomDeliberationQueryKey,
  getGetVenomModelsQueryKey,
  useGetVenomDeliberation,
  useGetVenomModels,
  type SourceCitation,
  type VenomArchivedCitation,
  type VenomConversationBlend,
  type VenomMessage,
  type VenomMessageDeliberation,
  type VenomModelId,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Trash2,
  RefreshCw,
  AlertTriangle,
  SendHorizontal,
  Square,
  Check,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSharedWorkspace } from "@/context/shared-workspace";
import {
  isWorkspaceAccessDeniedError,
  notifyWorkspaceAccessLost,
  WORKSPACE_ACCESS_DENIED_CODE,
} from "@/lib/workspace-access";
import { takePendingPrompt } from "@/lib/pending-prompt";
import {
  IS_UI_TEST,
  UI_TEST_USER_ID,
  useVenomWorkspace,
} from "@/context/venom-workspace";
import { useUser } from "@clerk/react";
import { motion, AnimatePresence } from "framer-motion";
import { ModelSelector } from "@/components/workspace/ModelSelector";
import {
  CitationText,
  DeliberationResult,
  DeliberationStreamPanel,
  type DeliberationRosterVoice,
  type StreamingDeliberation,
} from "@/components/workspace/DeliberationPanel";
import { ResponseModeSwitch } from "@/components/workspace/ResponseModeSwitch";
import { BlendPad, type BlendPadCorner } from "@/components/workspace/BlendPad";
import {
  DebateStreamBlock,
  type DebateRosterVoice,
  type StreamingDebate,
} from "@/components/workspace/DebatePanel";
import {
  EVEN_BLEND,
  isResponseMode,
  normalizeConversationBlend,
  normalizeWeights,
  type BlendWeights,
  type ResponseMode,
} from "@/lib/blend";
import { normalizeModelPreferences } from "@/lib/workspaceState";

// ─────────────────────────────────────────────────────────────────────────────
// SSE event shape from /api/venom/respond
// ─────────────────────────────────────────────────────────────────────────────
import { useLocation } from "wouter";

type StreamEvent = {
  content?: string;
  done?: boolean;
  error?: string;
  /** Server may echo the model that actually handled the request */
  modelId?: VenomModelId;
  modelName?: string;
  /** Deliberation: which voice a content chunk or status belongs to */
  voice?: string;
  voiceStatus?: "ok" | "failed";
  /** Deliberation: the stream moved from voice passes to the synthesis */
  stage?: string;
  /**
   * Deliberation roster (metadata event, no disagreements yet) or the final
   * persisted summary (carries the disagreements array).
   */
  deliberation?: {
    voices?: Array<
      DeliberationRosterVoice & { content?: string; status?: "ok" | "failed" }
    >;
    disagreements?: string[];
  };
  /** Debate roster announced by the metadata event. */
  debate?: {
    voices?: DebateRosterVoice[];
    turns?: number;
  };
  /** Debate: a named voice starts its turn. */
  debateTurn?: {
    index: number;
    of: number;
    voiceId: string;
    name: string;
    modelId?: VenomModelId;
    modelName?: string;
  };
  /** Debate: which turn a content chunk or status belongs to. */
  turn?: number;
  turnStatus?: "ok" | "failed";
};

/** Options describing how a message wants to be answered. */
type SendOptions = {
  mode: ResponseMode;
  blend?: VenomConversationBlend;
};
type MessageAttribution = {
  modelId: VenomModelId;
  modelName: string;
};

// Streaming state held in local React state (not persisted)
type StreamingState = {
  convId: string;
  id: string;
  content: string;
  status: "sending" | "sent" | "error";
  originalInput?: string;
  /** How this turn was requested (mode + blend), for retries */
  originalOptions?: SendOptions;
  /** Model attributed by the server during streaming */
  attribution?: MessageAttribution;
  /** Live multi-voice state while a deliberated answer generates */
  deliberation?: StreamingDeliberation;
  /** Live state while a debate round streams into the thread */
  debate?: StreamingDebate;
  /** User-visible error message (replaces generic "Connection lost") */
  errorMessage?: string;
};

const GENERIC_PROJECT_NAMES = new Set(["global workspace", "workspace"]);

/** Starter prompts for an empty chat, tuned to the conversation's project. */
function buildStarterPrompts(projectName?: string): string[] {
  const named =
    projectName && !GENERIC_PROJECT_NAMES.has(projectName.trim().toLowerCase())
      ? projectName.trim()
      : null;

  if (!named) {
    return [
      "Summarise where my work stands",
      "What did I decide recently?",
      "Draft the next steps for this week",
      "Turn this chat into to-dos",
    ];
  }

  return [
    `Summarise where ${named} stands`,
    `What did I decide recently in ${named}?`,
    `Draft the next steps for ${named}`,
    `Turn this chat into to-dos`,
  ];
}

export default function ChatPage() {
  const { user } = useUser();
  // Browser tests run the UI without a Clerk session; the workspace provider
  // uses the same placeholder account so chat stays exercisable.
  const userId = user?.id ?? (IS_UI_TEST ? UI_TEST_USER_ID : null);
  const {
    state,
    addMessage,
    createNewConversation,
    setActiveConversation,
    clearConversation,
    applyKnowledgeInsights,
    applyFiledKnowledge,
    setActiveModelId,
    setConversationResponsePrefs,
  } = useVenomWorkspace();
  const { activeWorkspace } = useSharedWorkspace();
  const queryClient = useQueryClient();

  const [, setLocation] = useLocation();

  const [inputValue, setInputValue] = useState(takePendingPrompt);
  const [isFocused, setIsFocused] = useState(false);

  // Local state for the message currently being streamed
  const [streaming, setStreaming] = useState<StreamingState | null>(null);

  // Deliberation availability; when the endpoint is missing or errors the
  // controls simply stay hidden and chat behaves exactly as before.
  const deliberationQuery = useGetVenomDeliberation({
    query: {
      staleTime: 5 * 60_000,
      retry: false,
      queryKey: getGetVenomDeliberationQueryKey(),
    },
  });
  const deliberationAvailable = deliberationQuery.data?.available === true;

  // Model catalog for the blend pad corners (already fetched by the model
  // picker, so this is a cache read in practice).
  const modelsQuery = useGetVenomModels({
    query: { staleTime: 60_000, retry: false, queryKey: getGetVenomModelsQueryKey() },
  });

  // Citation lookups so deliberation views resolve [source:id] markers to
  // source references (live links or archived labels), never raw markers.
  const citationsById = useMemo(() => {
    const map = new Map<string, SourceCitation>();
    for (const source of state?.sources ?? []) {
      for (const citation of source.citations) {
        if (!map.has(citation.id)) map.set(citation.id, citation);
      }
    }
    return map;
  }, [state?.sources]);
  const archivedCitationsById = useMemo(() => {
    const map = new Map<string, VenomArchivedCitation>();
    for (const entry of state?.archivedCitations ?? []) {
      if (!map.has(entry.id)) map.set(entry.id, entry);
    }
    return map;
  }, [state?.archivedCitations]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const extractionControllersRef = useRef<Set<AbortController>>(new Set());
  const activeUserIdRef = useRef<string | null>(null);
  const activeConvIdRef = useRef<string | null>(null);

  const activeConvId = state?.activeConversationId;
  const activeConv = state?.conversations?.find((c) => c.id === activeConvId);

  // Resolve active model ID from workspace preferences
  const modelPrefs = normalizeModelPreferences(state?.modelPreferences);
  const activeModelId = modelPrefs.activeModelId as VenomModelId;

  // ── Response mode & blend (per conversation, synced) ──────────────────────
  const responseMode: ResponseMode =
    deliberationAvailable && isResponseMode(activeConv?.responseMode)
      ? activeConv.responseMode
      : "talk";

  // Real models that could occupy pad corners: enabled AND currently
  // available. The pad never shows a model that cannot actually answer.
  const cornerCandidates = useMemo(() => {
    if (!Array.isArray(modelsQuery.data)) return [];
    const available = new Map(
      modelsQuery.data
        .filter((model) => model.available)
        .map((model) => [model.id, model]),
    );
    return modelPrefs.enabledModelIds
      .map((id) => available.get(id))
      .filter((model): model is NonNullable<typeof model> => Boolean(model));
  }, [modelsQuery.data, modelPrefs.enabledModelIds]);

  const personaVoices = deliberationQuery.data?.voices;

  // Corner roster: three real models when at least three real providers are
  // enabled and available; otherwise the deliberation personas fill the
  // corners so the pad always works.
  const { blendCorners, cornersPickable } = useMemo((): {
    blendCorners: [BlendPadCorner, BlendPadCorner, BlendPadCorner] | null;
    cornersPickable: boolean;
  } => {
    if (cornerCandidates.length >= 3) {
      const byId = new Map<string, (typeof cornerCandidates)[number]>(
        cornerCandidates.map((model) => [model.id, model]),
      );
      const stored = normalizeConversationBlend(activeConv?.blend);
      const storedValid =
        stored && stored.corners.every((corner) => byId.has(corner));
      const chosen = storedValid
        ? stored.corners.map((corner) => byId.get(corner)!)
        : cornerCandidates.slice(0, 3);
      return {
        blendCorners: chosen.map((model) => ({
          id: model.id,
          label: model.name,
        })) as [BlendPadCorner, BlendPadCorner, BlendPadCorner],
        cornersPickable: cornerCandidates.length > 3,
      };
    }
    if (personaVoices && personaVoices.length >= 3) {
      return {
        blendCorners: personaVoices.slice(0, 3).map((voice) => ({
          id: voice.voiceId,
          label: voice.name,
        })) as [BlendPadCorner, BlendPadCorner, BlendPadCorner],
        cornersPickable: false,
      };
    }
    return { blendCorners: null, cornersPickable: false };
  }, [cornerCandidates, personaVoices, activeConv?.blend]);

  // Stored weights for the current corners; even blend when nothing stored
  // or the stored corners no longer match.
  const storedBlend = normalizeConversationBlend(activeConv?.blend);
  const storedWeights: BlendWeights =
    storedBlend &&
    blendCorners &&
    blendCorners.every((corner, index) => storedBlend.corners[index] === corner.id)
      ? (normalizeWeights(storedBlend.weights) as BlendWeights)
      : ([...EVEN_BLEND] as BlendWeights);

  // Live pad position while dragging (uncommitted).
  const [draftWeights, setDraftWeights] = useState<BlendWeights | null>(null);
  const padWeights = draftWeights ?? storedWeights;
  const [cornerPickerOpen, setCornerPickerOpen] = useState(false);

  const commitBlend = useCallback(
    (weights: BlendWeights) => {
      setDraftWeights(null);
      if (!activeConvId || !blendCorners) return;
      setConversationResponsePrefs(activeConvId, {
        blend: {
          corners: blendCorners.map((corner) => corner.id),
          weights: [...normalizeWeights(weights)],
        },
      });
    },
    [activeConvId, blendCorners, setConversationResponsePrefs],
  );

  const handleModeChange = useCallback(
    (mode: ResponseMode) => {
      if (!activeConvId) return;
      setConversationResponsePrefs(activeConvId, { responseMode: mode });
    },
    [activeConvId, setConversationResponsePrefs],
  );

  // Corner picker: tap a listed model to swap it in or out. Selecting keeps
  // exactly three corners — a new pick replaces the least-favored corner —
  // and the weights reset to an even blend for the new roster.
  const handleCornerToggle = useCallback(
    (modelId: string) => {
      if (!activeConvId || !blendCorners) return;
      const currentIds = blendCorners.map((corner) => corner.id);
      let nextIds: string[];
      if (currentIds.includes(modelId)) {
        // Removing below three is not allowed; ignore the tap.
        return;
      }
      const weights = padWeights;
      let replaceIndex = 0;
      for (let index = 1; index < 3; index += 1) {
        if (weights[index] < weights[replaceIndex]) replaceIndex = index;
      }
      nextIds = [...currentIds];
      nextIds[replaceIndex] = modelId;
      setConversationResponsePrefs(activeConvId, {
        blend: { corners: nextIds, weights: [...EVEN_BLEND] },
      });
    },
    [activeConvId, blendCorners, padWeights, setConversationResponsePrefs],
  );

  // Debate interjections: messages the user sends while a round is running.
  // They enter the thread immediately and the round restarts from the next
  // turn boundary so the following debater turns take them into account.
  const pendingInterjectionsRef = useRef<VenomMessage[]>([]);

  useEffect(() => {
    const nextUserId = userId;
    if (activeUserIdRef.current && activeUserIdRef.current !== nextUserId) {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      extractionControllersRef.current.forEach((controller) =>
        controller.abort(),
      );
      extractionControllersRef.current.clear();
      setStreaming(null);
    }
    activeUserIdRef.current = nextUserId;
  }, [userId]);

  useEffect(() => {
    const extractionControllers = extractionControllersRef.current;
    return () => {
      abortControllerRef.current?.abort();
      extractionControllers.forEach((controller) => controller.abort());
      extractionControllers.clear();
    };
  }, []);

  useEffect(() => {
    activeConvIdRef.current = activeConvId || null;
    if (streaming && streaming.convId !== activeConvId) {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      setStreaming(null);
    }
  }, [activeConvId, streaming]);

  useEffect(() => {
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "end",
      });
    }
  }, [activeConv?.messages?.length, streaming?.content]);

  const handleFetchStream = useCallback(
    async (
      convId: string,
      userId: string,
      messagesContext: VenomMessage[],
      modelId: VenomModelId,
      projectContext?: string,
      originalInput?: string,
      options?: SendOptions,
    ) => {
      const mode: ResponseMode = options?.mode ?? "talk";
      const streamId = `msg_${crypto.randomUUID()}`;
      setStreaming({
        convId,
        id: streamId,
        content: "",
        status: "sending",
        originalInput,
        originalOptions: options,
      });

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      // Capture project ID for the request body
      const conv = state.conversations.find((item) => item.id === convId);
      const projectId = conv?.projectId ?? state.activeProjectId ?? "proj_default";

      // Shared-workspace context rides the request; the server re-checks
      // membership on every call, so this is advisory only.
      const workspaceId = activeWorkspace?.id;

      // Debate: history the next round would continue from (persisted turns
      // plus any interjections), and whether a restart was requested.
      const debateHistory: VenomMessage[] = [...messagesContext];
      let restartWith: VenomMessage[] | null = null;

      try {
        const response = await fetch("/api/venom/respond", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          credentials: "include",
          body: JSON.stringify({
            messages: messagesContext.slice(-24).map((message) => ({
              role: message.role,
              content: message.content,
            })),
            projectContext: projectContext?.slice(0, 1000),
            projectId,
            modelId,
            ...(workspaceId ? { workspaceId } : {}),
            // Talk requests stay byte-identical with today's chat: no mode
            // key at all. Verify and debate declare themselves explicitly.
            ...(mode === "verify" || mode === "debate"
              ? {
                  mode,
                  ...(options?.blend
                    ? {
                        blend: options.blend.corners.map((id, index) => ({
                          id,
                          weight: options.blend!.weights[index] ?? 0,
                        })),
                      }
                    : {}),
                }
              : {}),
          }),
          signal: abortController.signal,
        });

        if (!response.ok || !response.body) {
          let errorDetail = `HTTP ${response.status}`;
          try {
            const body = await response.json() as { error?: string; code?: string };
            if (body?.code === WORKSPACE_ACCESS_DENIED_CODE) {
              // Membership ended between selecting the workspace and sending:
              // evict cached workspace content and fall back to personal.
              notifyWorkspaceAccessLost();
            }
            if (body?.error) errorDetail = body.error;
          } catch {
            // not JSON – keep status code message
          }
          throw new Error(errorDetail);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = "";
        let buffer = "";
        let receivedDone = false;
        let attribution: MessageAttribution | undefined;
        let deliberation: StreamingDeliberation | undefined;
        let finalDeliberation: VenomMessageDeliberation | undefined;
        let debate: StreamingDebate | undefined;

        const syncDebate = () => {
          if (!debate) return;
          const snapshot: StreamingDebate = {
            ...debate,
            roster: [...debate.roster],
            failedVoices: [...debate.failedVoices],
            currentTurn: debate.currentTurn ? { ...debate.currentTurn } : undefined,
          };
          setStreaming((current) =>
            current?.id === streamId ? { ...current, debate: snapshot } : current,
          );
        };

        // A turn boundary is the only place a debate round may restart: the
        // user's interjections joined the thread already, so the next round
        // continues from the persisted turns plus those messages.
        const maybeRequestRestart = () => {
          if (pendingInterjectionsRef.current.length === 0) return false;
          const interjections = pendingInterjectionsRef.current.splice(0);
          restartWith = [...debateHistory, ...interjections];
          return true;
        };

        // Push an immutable snapshot of the live deliberation into React state
        const syncDeliberation = () => {
          if (!deliberation) return;
          const snapshot: StreamingDeliberation = {
            roster: deliberation.roster,
            stage: deliberation.stage,
            takes: Object.fromEntries(
              Object.entries(deliberation.takes).map(([voiceId, take]) => [
                voiceId,
                { ...take },
              ]),
            ),
          };
          setStreaming((current) =>
            current?.id === streamId
              ? { ...current, deliberation: snapshot }
              : current,
          );
        };

        const consumeEvent = (event: string) => {
          const dataString = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n")
            .trim();
          if (!dataString || dataString === "[DONE]") return;

          const data = JSON.parse(dataString) as StreamEvent;

          // Server-side error events – surface them explicitly
          if (data.error) {
            throw new Error(data.error);
          }

          // Debate events: the roster (metadata), each turn's start, its
          // streamed chunks, and its final status. Turn-tagged events are
          // consumed here and never reach the generic content branch.
          if (data.debate?.voices) {
            debate = {
              roster: data.debate.voices,
              plannedTurns: data.debate.turns ?? data.debate.voices.length,
              completedTurns: 0,
              failedVoices: [],
            };
            syncDebate();
            return;
          }
          if (data.debateTurn && debate) {
            debate.currentTurn = {
              index: data.debateTurn.index,
              voiceId: data.debateTurn.voiceId,
              name: data.debateTurn.name,
              modelId: data.debateTurn.modelId,
              modelName: data.debateTurn.modelName,
              content: "",
            };
            debate.plannedTurns = data.debateTurn.of;
            syncDebate();
            return;
          }
          if (typeof data.turn === "number" && debate) {
            const turn = debate.currentTurn;
            if (data.turnStatus) {
              if (turn && data.turnStatus === "ok" && turn.content.trim()) {
                // Persist the finished turn immediately so it survives a
                // stop, a reload, and syncs to other devices as a normal
                // attributed assistant message.
                const persisted: VenomMessage = {
                  id: `msg_${crypto.randomUUID()}`,
                  role: "assistant",
                  content: turn.content.trim(),
                  createdAt: Date.now(),
                  status: "sent",
                  ...(turn.modelId ? { modelId: turn.modelId } : {}),
                  ...(turn.modelName ? { modelName: turn.modelName } : {}),
                  speakerId: turn.voiceId,
                  speakerName: turn.name,
                };
                addMessage(convId, persisted);
                debateHistory.push(persisted);
              } else if (turn) {
                debate.failedVoices.push(turn.name);
              }
              debate.completedTurns += 1;
              debate.currentTurn = undefined;
              syncDebate();
              // Between turns is where user interjections take effect.
              if (maybeRequestRestart()) {
                abortController.abort();
              }
            } else if (turn && data.content && turn.index === data.turn) {
              turn.content += data.content;
              syncDebate();
            }
            return;
          }

          // Deliberation events: the roster announcement (metadata), the
          // final persisted summary (carries disagreements), stage moves,
          // and per-voice chunks. Voice chunks never touch the main answer.
          if (data.deliberation?.voices) {
            if (Array.isArray(data.deliberation.disagreements)) {
              finalDeliberation = {
                voices: data.deliberation.voices,
                disagreements: data.deliberation.disagreements,
              } as VenomMessageDeliberation;
              if (deliberation) {
                for (const take of finalDeliberation.voices) {
                  deliberation.takes[take.voiceId] = {
                    content: take.content,
                    status: take.status === "failed" ? "failed" : "ok",
                  };
                }
                syncDeliberation();
              }
            } else {
              deliberation = {
                roster: data.deliberation.voices,
                stage: "voices",
                takes: Object.fromEntries(
                  data.deliberation.voices.map((voice) => [
                    voice.voiceId,
                    { content: "", status: "streaming" as const },
                  ]),
                ),
              };
              syncDeliberation();
            }
          }
          if (data.stage === "synthesis" && deliberation) {
            deliberation.stage = "synthesis";
            syncDeliberation();
          }
          if (data.voice) {
            if (deliberation) {
              const take = (deliberation.takes[data.voice] ??= {
                content: "",
                status: "streaming",
              });
              if (data.content) take.content += data.content;
              if (data.voiceStatus) take.status = data.voiceStatus;
              syncDeliberation();
            }
            return;
          }

          // Capture model attribution from server metadata
          if (data.modelId && data.modelName && !attribution) {
            attribution = { modelId: data.modelId, modelName: data.modelName };
            setStreaming((current) =>
              current?.id === streamId
                ? { ...current, attribution }
                : current,
            );
          }

          if (data.done) {
            receivedDone = true;
            return;
          }
          if (data.content) {
            fullContent += data.content;
            setStreaming((current) =>
              current?.id === streamId
                ? { ...current, content: fullContent }
                : current,
            );
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (
            activeUserIdRef.current !== userId ||
            activeConvIdRef.current !== convId
          ) {
            await reader.cancel();
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() ?? "";
          for (const event of events) {
            consumeEvent(event);
          }
        }

        buffer += decoder.decode();
        if (buffer.trim()) consumeEvent(buffer);

        if (mode === "debate") {
          // Debate turns persist as they finish; the round has no single
          // final answer to require. An interjection near the end may still
          // be pending — the restart below picks it up.
          if (!receivedDone && !restartWith) {
            throw new Error("The response stream ended before completion.");
          }
          if (
            activeUserIdRef.current !== userId ||
            activeConvIdRef.current !== convId
          ) {
            return;
          }
          if (!restartWith) maybeRequestRestart();
          if (restartWith) {
            const nextContext = restartWith;
            restartWith = null;
            void handleFetchStreamRef.current?.(
              convId,
              userId,
              nextContext,
              modelId,
              projectContext,
              originalInput,
              options,
            );
            return;
          }
          setStreaming(null);
          if (abortControllerRef.current === abortController) {
            abortControllerRef.current = null;
          }
          return;
        }

        if (!receivedDone || !fullContent.trim()) {
          throw new Error("The response stream ended before completion.");
        }

        if (
          activeUserIdRef.current !== userId ||
          activeConvIdRef.current !== convId
        ) {
          return;
        }

        // A deliberated turn persists its takes and disagreements alongside
        // the collective answer. If the stream finished without the final
        // summary event, fall back to what accumulated while streaming.
        const persistedDeliberation: VenomMessageDeliberation | undefined =
          finalDeliberation ??
          (deliberation
            ? ({
                voices: deliberation.roster.map((voice) => {
                  const take = deliberation?.takes[voice.voiceId];
                  return {
                    voiceId: voice.voiceId,
                    name: voice.name,
                    ...(voice.modelId ? { modelId: voice.modelId } : {}),
                    ...(voice.modelName
                      ? { modelName: voice.modelName }
                      : {}),
                    content: (take?.content ?? "").slice(0, 8000),
                    status: take?.status === "failed" ? "failed" : "ok",
                  };
                }),
                disagreements: [],
              } as VenomMessageDeliberation)
            : undefined);

        // Persist message with optional model attribution
        addMessage(convId, {
          id: streamId,
          role: "assistant",
          content: fullContent,
          status: "sent",
          ...(attribution
            ? { modelId: attribution.modelId, modelName: attribution.modelName }
            : {}),
          ...(persistedDeliberation
            ? { deliberation: persistedDeliberation }
            : {}),
        });
        setStreaming(null);
        if (abortControllerRef.current === abortController) {
          abortControllerRef.current = null;
        }

        // Update active model ID in workspace prefs if server used a different one
        if (attribution && attribution.modelId !== modelId) {
          setActiveModelId(attribution.modelId);
        }

        const latestConv = state.conversations.find((item) => item.id === convId);
        if (latestConv) {
          const conversationTitle =
            latestConv.title === "New Session" && originalInput
              ? `${originalInput.slice(0, 30)}${originalInput.length > 30 ? "…" : ""}`
              : latestConv.title || "New Session";

          const extractionController = new AbortController();
          extractionControllersRef.current.add(extractionController);
          try {
            const result = await extractVenomKnowledge(
              {
                // Ask the server to file the insights straight into the
                // ontology store; `filed` carries the canonical records.
                file: true,
                ...(workspaceId ? { workspaceId } : {}),
                conversation: {
                  id: convId,
                  title: conversationTitle,
                  projectId: latestConv.projectId,
                },
                messages: [
                  ...messagesContext.slice(-47).map((message) => ({
                    id: message.id,
                    role: message.role,
                    content: message.content.slice(0, 8000),
                  })),
                  {
                    id: streamId,
                    role: "assistant",
                    content: fullContent.slice(0, 8000),
                  },
                ],
              },
              { signal: extractionController.signal },
            );

            if (activeUserIdRef.current === userId) {
              const conversationRef = {
                id: convId,
                title: conversationTitle,
                projectId: latestConv.projectId,
              };
              if (result.filedWorkspaceId) {
                // Filed into the shared workspace store server-side. Never
                // mirror it into the personal blob — shared content must stay
                // evictable — just refresh the cached workspace knowledge.
                void queryClient.invalidateQueries({
                  queryKey: getGetSharedWorkspaceKnowledgeQueryKey(
                    result.filedWorkspaceId,
                  ),
                });
              } else if (result.filed && result.filed.length > 0) {
                // The server filed these into the ontology store already;
                // mirror its canonical records locally.
                applyFiledKnowledge(conversationRef, result.filed);
              } else {
                // Older server or filing hiccup: fall back to local filing,
                // which reaches the store on the next workspace sync.
                applyKnowledgeInsights(conversationRef, result.clusters);
              }
            }
          } catch (extractionError) {
            // Background extraction fails silently — except when the server
            // says workspace access is gone, which must evict immediately.
            if (isWorkspaceAccessDeniedError(extractionError)) {
              notifyWorkspaceAccessLost();
            }
          } finally {
            extractionControllersRef.current.delete(extractionController);
          }
        }
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") {
          // A debate abort at a turn boundary is a restart, not a failure:
          // continue the round with the user's interjections included.
          if (restartWith) {
            const nextContext: VenomMessage[] = restartWith;
            restartWith = null;
            if (
              activeUserIdRef.current === userId &&
              activeConvIdRef.current === convId
            ) {
              void handleFetchStreamRef.current?.(
                convId,
                userId,
                nextContext,
                modelId,
                projectContext,
                originalInput,
                options,
              );
            }
          }
          return;
        }
        if (
          activeUserIdRef.current === userId &&
          activeConvIdRef.current === convId
        ) {
          const errorMessage =
            error instanceof Error && error.message
              ? error.message
              : "Connection lost";
          setStreaming((current) =>
            current?.id === streamId
              ? { ...current, status: "error", errorMessage }
              : current,
          );
        }
      } finally {
        if (abortControllerRef.current === abortController) {
          abortControllerRef.current = null;
        }
      }
    },
    [addMessage, applyKnowledgeInsights, applyFiledKnowledge, setActiveModelId, state.conversations, state.activeProjectId, activeWorkspace?.id, queryClient],
  );

  // Self-reference so a finishing debate round can start its successor
  // without a stale closure.
  const handleFetchStreamRef = useRef<typeof handleFetchStream | null>(null);
  useEffect(() => {
    handleFetchStreamRef.current = handleFetchStream;
  }, [handleFetchStream]);

  const handleSend = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputValue.trim() || !activeConvId || !userId) return;

    const input = inputValue.trim();
    setInputValue("");

    // Intercept only the user's explicit build request before it reaches chat.
    const match = input.match(
      /^(?:create|build|make|generate|design)\s+(?:an?\s+|the\s+|my\s+)?(?:new\s+)?(app|application|website|site|brand|customer[- ]?service(?:[- ]?flow)?)\b/i,
    );
    if (match) {
      let targetType = match[1].toLowerCase().replace(/[- ]/g, '_');
      if (targetType.startsWith("customer")) targetType = "customer_service_flow";
      if (targetType === "application") targetType = "app";
      if (targetType === "site") targetType = "website";

      const searchParams = new URLSearchParams();
      searchParams.set("type", targetType);
      searchParams.set("requirements", input);
      const namedTarget = input.match(/\b(?:called|named)\s+(.{1,120})$/i)?.[1]?.trim();
      if (namedTarget) searchParams.set("name", namedTarget);
      const projectId = activeConv?.projectId || state.activeProjectId;
      if (projectId) searchParams.set("projectId", projectId);

      setLocation(`/workspace/builds/new?${searchParams.toString()}`);
      return;
    }

    const userMessageId = `msg_${crypto.randomUUID()}`;
    const userMessage: VenomMessage = {
      id: userMessageId,
      role: "user",
      content: input,
      status: "sent",
      createdAt: Date.now(),
    };
    addMessage(activeConvId, {
      id: userMessageId,
      role: "user",
      content: input,
      status: "sent",
    });

    // Mid-debate send: the message joins the thread now and queues for the
    // next turn boundary, where the round restarts with it in context.
    if (
      streaming?.status === "sending" &&
      streaming.debate &&
      streaming.convId === activeConvId
    ) {
      pendingInterjectionsRef.current.push(userMessage);
      return;
    }

    const activeProject = state?.projects?.find(
      (p) => p.id === activeConv?.projectId,
    );
    const contextMessages = [...(activeConv?.messages || []), userMessage];

    const projectContext = activeProject
      ? `Project: ${activeProject.name}\n${activeProject.description}`
      : undefined;
    const options: SendOptions | undefined =
      responseMode !== "talk" && deliberationAvailable
        ? {
            mode: responseMode,
            ...(blendCorners
              ? {
                  blend: {
                    corners: blendCorners.map((corner) => corner.id),
                    weights: [...storedWeights],
                  },
                }
              : {}),
          }
        : undefined;
    void handleFetchStream(
      activeConvId,
      userId,
      contextMessages,
      activeModelId,
      projectContext,
      input,
      options,
    );
  };

  const handleRetry = () => {
    if (!streaming?.originalInput || !activeConvId || !userId) return;

    const activeProject = state?.projects?.find(
      (p) => p.id === activeConv?.projectId,
    );
    const projectContext = activeProject
      ? `Project: ${activeProject.name}\n${activeProject.description}`
      : undefined;
    void handleFetchStream(
      activeConvId,
      userId,
      activeConv?.messages || [],
      activeModelId,
      projectContext,
      streaming.originalInput,
      streaming.originalOptions,
    );
  };

  // Stop control: ends a debate round cleanly. Turns already spoken stay in
  // the thread; the current partial turn is discarded.
  const handleStopDebate = () => {
    pendingInterjectionsRef.current = [];
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setStreaming(null);
  };

  if (!state) {
    return (
      <div className="flex-1 flex items-center justify-center h-full bg-background">
        <Skeleton className="w-[300px] h-12 rounded-2xl bg-foreground/10" />
      </div>
    );
  }

  const messages = activeConv?.messages || [];
  const displayMessages = [...messages];
  if (streaming && streaming.convId === activeConvId) {
    displayMessages.push({
      id: streaming.id,
      role: "assistant",
      content: streaming.content,
      createdAt: Date.now(),
      status: streaming.status,
    } as VenomMessage);
  }

  // Debate rounds keep the composer open: the user is a participant and can
  // interject between turns. Everything else locks it while streaming.
  const debateInFlight = Boolean(
    streaming?.status === "sending" &&
      streaming.debate &&
      streaming.convId === activeConvId,
  );
  const composerLocked = streaming?.status === "sending" && !debateInFlight;

  const conversationProject = state?.projects?.find(
    (p) => p.id === activeConv?.projectId,
  );
  const starterPrompts = buildStarterPrompts(conversationProject?.name);

  const useStarterPrompt = (prompt: string) => {
    setInputValue(prompt);
    inputRef.current?.focus();
  };

  const handleClearConversation = () => {
    if (!activeConvId) return;
    if (window.confirm("Clear this chat? This cannot be undone.")) {
      clearConversation(activeConvId);
    }
  };

  return (
    <div className="relative z-0 flex h-full flex-1 flex-col bg-background">
      {/* Conversation bar */}
      <div className="sticky top-0 z-10 hidden h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-background/90 px-6 backdrop-blur-md md:flex">
        <div
          className="truncate text-sm font-medium text-foreground"
          data-testid="text-conversation-title"
        >
          {activeConv?.title || "New chat"}
        </div>
        {activeConvId && messages.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 rounded-lg text-sm font-normal text-muted-foreground hover:text-foreground"
            onClick={handleClearConversation}
            data-testid="button-clear-chat"
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" aria-hidden="true" /> Clear chat
          </Button>
        )}
      </div>

      {/* Messages Area */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto px-4 pb-40 pt-6 scroll-smooth md:px-6 md:pb-44 md:pt-8"
        role="log"
        aria-live="polite"
        aria-label="Conversation"
      >
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-6">
          {activeConvId && messages.length > 0 && (
            <div className="flex justify-end md:hidden">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 rounded-lg text-sm font-normal text-muted-foreground"
                onClick={handleClearConversation}
                data-testid="button-clear-chat-mobile"
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" aria-hidden="true" /> Clear chat
              </Button>
            </div>
          )}
          {displayMessages.length === 0 ? (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
              className="flex flex-1 flex-col justify-center pb-16"
            >
              <h1
                className="text-3xl font-semibold tracking-tight glow-text inline-block pb-1"
                data-testid="text-chat-greeting"
              >
                What are we working on?
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {activeWorkspace
                  ? `Shared knowledge from ${activeWorkspace.name} is included in this chat.`
                  : conversationProject?.name
                    ? `Context from ${conversationProject.name} is included in this chat.`
                    : "Project context is included in this chat."}
              </p>
              <div className="mt-6 grid gap-2 sm:grid-cols-2">
                {starterPrompts.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => useStarterPrompt(prompt)}
                    data-testid="button-starter-prompt"
                    className="rounded-xl border border-border px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </motion.div>
          ) : (
            <AnimatePresence initial={false}>
              {displayMessages.map((msg) => {
                // Resolve attribution for completed assistant messages
                const isStreaming =
                  streaming?.id === msg.id && streaming.convId === activeConvId;
                const streamingAttribution = isStreaming
                  ? streaming?.attribution
                  : undefined;
                // For persisted messages, read from msg directly
                const msgAttrib: MessageAttribution | undefined =
                  !isStreaming && msg.modelId && msg.modelName
                    ? { modelId: msg.modelId, modelName: msg.modelName }
                    : streamingAttribution;

                const errorMessage = isStreaming ? streaming?.errorMessage : undefined;
                const liveDeliberation = isStreaming
                  ? streaming?.deliberation
                  : undefined;
                const liveDebate = isStreaming ? streaming?.debate : undefined;
                const speakerName = !isStreaming ? msg.speakerName : undefined;
                const speakerModel =
                  speakerName &&
                  msg.modelName &&
                  msg.modelName !== speakerName
                    ? msg.modelName
                    : undefined;

                return (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                    className={cn(
                      "flex w-full flex-col",
                      msg.role === "user" ? "items-end" : "items-start",
                    )}
                    data-testid={`message-${msg.role}`}
                  >
                    {liveDeliberation && msg.status === "sending" && (
                      <DeliberationStreamPanel
                        deliberation={liveDeliberation}
                        citationsById={citationsById}
                        archivedById={archivedCitationsById}
                      />
                    )}

                    {/* Speaker chip – named debate voices own their turns */}
                    {speakerName && (
                      <div
                        className="mb-1 flex items-center gap-1.5 text-xs font-medium text-foreground/80"
                        data-testid="chip-speaker"
                      >
                        <span
                          className="inline-block h-1.5 w-1.5 rounded-full bg-foreground"
                          aria-hidden="true"
                        />
                        {speakerName}
                        {speakerModel && (
                          <span className="font-normal text-muted-foreground">
                            · {speakerModel}
                          </span>
                        )}
                      </div>
                    )}

                    {liveDebate && msg.status === "sending" ? (
                      <DebateStreamBlock
                        debate={liveDebate}
                        citationsById={citationsById}
                        archivedById={archivedCitationsById}
                      />
                    ) : (
                      <div
                        className={cn(
                          "text-[15px] leading-7",
                          msg.role === "user"
                            ? "max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-foreground"
                            : "w-full text-foreground prose prose-neutral max-w-none dark:prose-invert prose-p:leading-7 prose-pre:rounded-xl prose-pre:border prose-pre:border-border prose-pre:bg-muted",
                        )}
                      >
                        {/* Assistant text stores machine citation markers;
                            rendering resolves them to source references so a
                            reader never sees a raw `[source:...]`. A user's
                            own words stay verbatim. */}
                        {msg.role === "user" ? (
                          msg.content
                        ) : (
                          <CitationText
                            content={msg.content}
                            citationsById={citationsById}
                            archivedById={archivedCitationsById}
                          />
                        )}

                        {msg.status === "sending" &&
                          msg.role === "assistant" &&
                          (msg.content ? (
                            <span
                              className="ml-0.5 inline-block h-4 w-[2px] align-middle bg-foreground motion-safe:animate-pulse"
                              aria-hidden="true"
                            />
                          ) : liveDeliberation ? null : (
                            <span
                              className="text-sm text-muted-foreground motion-safe:animate-pulse"
                              data-testid="status-thinking"
                            >
                              Thinking…
                            </span>
                          ))}
                      </div>
                    )}

                    {msg.role === "assistant" &&
                      msg.status === "sent" &&
                      msg.deliberation && (
                        <DeliberationResult
                          deliberation={msg.deliberation}
                          citationsById={citationsById}
                          archivedById={archivedCitationsById}
                        />
                      )}

                    {msg.status === "error" && (
                      <div
                        className="mt-3 flex w-full flex-col gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between"
                        role="alert"
                        data-testid="alert-stream-error"
                      >
                        <span className="flex items-center gap-2 text-sm text-foreground">
                          <AlertTriangle
                            className="h-4 w-4 shrink-0 text-destructive"
                            aria-hidden="true"
                          />
                          {errorMessage && errorMessage !== "Connection lost"
                            ? errorMessage
                            : "The response could not be completed."}
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-fit rounded-lg text-sm font-normal"
                          onClick={handleRetry}
                          data-testid="button-retry"
                        >
                          <RefreshCw className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                          Retry
                        </Button>
                      </div>
                    )}

                    {/* Attribution – shown on completed assistant messages.
                        Speaker-attributed turns already name their model in
                        the chip, so they skip the footer line. */}
                    {msg.role === "assistant" &&
                      msg.status === "sent" &&
                      !speakerName &&
                      msgAttrib && (
                        <div
                          className="mt-1.5 text-xs text-muted-foreground"
                          aria-label={`Answered by ${msgAttrib.modelName}`}
                        >
                          {msgAttrib.modelName}
                        </div>
                      )}
                  </motion.div>
                );
              })}
            </AnimatePresence>
          )}
          <div ref={messagesEndRef} className="h-4" />
        </div>
      </div>

      {/* Composer – anchored to the bottom of the conversation column */}
      <div className="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-background via-background to-transparent px-4 pt-8 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] md:px-6 md:pb-6">
        <form
          onSubmit={handleSend}
          className={cn(
            "mx-auto flex max-w-3xl flex-col rounded-2xl border surface p-2 shadow-lift transition-colors duration-200 sheen",
            isFocused ? "border-foreground/60" : "border-border/60",
          )}
          data-testid="form-composer"
        >
          <div className="flex items-end gap-2">
            <div className="min-h-[44px] flex-1">
              <label htmlFor="chat-input" className="sr-only">
                Message Venom
              </label>
              <textarea
                id="chat-input"
                ref={inputRef}
                value={inputValue}
                onChange={(e) => {
                  setInputValue(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
                }}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend(e);
                  }
                }}
                placeholder={
                  debateInFlight ? "Join the debate" : "Message Venom"
                }
                className="max-h-[200px] w-full resize-none border-0 bg-transparent px-3 py-3 text-[16px] outline-none placeholder:text-muted-foreground md:text-[15px]"
                rows={1}
                disabled={composerLocked}
                data-testid="input-message"
              />
            </div>
            {debateInFlight && (
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={handleStopDebate}
                className="mb-1 h-9 w-9 shrink-0 rounded-full"
                aria-label="Stop the debate round"
                title="Stop the debate round"
                data-testid="button-debate-stop"
              >
                <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
              </Button>
            )}
            <Button
              type="submit"
              disabled={!inputValue.trim() || composerLocked}
              size="icon"
              className="mb-1 h-9 w-9 shrink-0 rounded-full"
              aria-label="Send message"
              data-testid="button-send"
            >
              <SendHorizontal className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>

          {/* Blend pad – how the voices split the work in Verify and Debate */}
          <AnimatePresence initial={false}>
            {deliberationAvailable && responseMode !== "talk" && blendCorners && (
              <motion.div
                key="blend-pad"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                className="overflow-hidden"
              >
                <div className="flex flex-col items-center gap-1 border-t border-border/40 px-3 pb-1 pt-2">
                  <BlendPad
                    corners={blendCorners}
                    weights={padWeights}
                    onChange={setDraftWeights}
                    onCommit={commitBlend}
                    disabled={debateInFlight}
                  />
                  {cornersPickable && (
                    <button
                      type="button"
                      onClick={() => setCornerPickerOpen((open) => !open)}
                      aria-expanded={cornerPickerOpen}
                      className="rounded-full px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      data-testid="button-blend-corners"
                    >
                      Choose the three voices
                    </button>
                  )}
                  {cornersPickable && cornerPickerOpen && (
                    <div
                      className="flex flex-wrap items-center justify-center gap-1.5 pb-1"
                      role="group"
                      aria-label="Choose which three models take the corners"
                      data-testid="blend-corner-picker"
                    >
                      {cornerCandidates.map((model) => {
                        const cornerIndex = blendCorners.findIndex(
                          (corner) => corner.id === model.id,
                        );
                        const selected = cornerIndex >= 0;
                        return (
                          <button
                            key={model.id}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => handleCornerToggle(model.id)}
                            className={cn(
                              "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              selected
                                ? "border-foreground bg-foreground text-background"
                                : "border-border/60 text-muted-foreground hover:text-foreground",
                            )}
                            data-testid={`button-corner-pick-${model.id}`}
                          >
                            {selected && (
                              <Check className="h-3 w-3" aria-hidden="true" />
                            )}
                            {model.name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Model selector row */}
          <div className="flex items-center gap-2 px-3 pb-1">
            <ModelSelector />
            {activeWorkspace && (
              <span
                className="flex min-w-0 items-center gap-1.5 rounded-full border border-border/60 bg-foreground/[0.04] px-2.5 py-1 text-[11px] font-medium text-muted-foreground"
                data-testid="chip-shared-space"
                title={`Answers may draw on ${activeWorkspace.name}'s shared knowledge and SOPs`}
              >
                <Users className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{activeWorkspace.name}</span>
              </span>
            )}
            {deliberationAvailable && (
              <ResponseModeSwitch
                value={responseMode}
                onChange={handleModeChange}
                disabled={streaming?.status === "sending"}
                className="ml-auto"
              />
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
