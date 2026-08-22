import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import {
  commitVenomCanonTeaching,
  extractVenomKnowledge,
  getGetSharedWorkspaceKnowledgeQueryKey,
  getGetVenomDeliberationQueryKey,
  getGetVenomIdentityQueryKey,
  getGetVenomModelsQueryKey,
  proposeVenomCanonTeaching,
  undoVenomKnowledgeMove,
  useGetVenomDeliberation,
  useGetVenomIdentity,
  useGetVenomModels,
  type ProjectSource,
  type SourceCitation,
  type VenomArchivedCitation,
  type VenomConversationBlend,
  type VenomMessage,
  type VenomMessageDeliberation,
  type VenomModelId,
  type VenomVoiceModelPick,
  type VenomWorkspaceFiling,
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
  Mic,
  AudioLines,
  Loader2,
  Github,
  Globe,
  ArrowUpRight,
  CloudOff,
} from "lucide-react";
import { useUnsyncedNoticeText } from "@/hooks/useUnsyncedNotice";
import { cn } from "@/lib/utils";
import { ToastAction } from "@/components/ui/toast";
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
import { ModelVoicesDialog } from "@/components/workspace/ModelVoicesDialog";
import {
  CitationText,
  DeliberationResult,
  DeliberationStreamPanel,
  type DeliberationRosterVoice,
  type StreamingDeliberation,
} from "@/components/workspace/DeliberationPanel";
import { messageCitationSegments } from "@/lib/messageCitations";
import { ResponseModeSwitch } from "@/components/workspace/ResponseModeSwitch";
import {
  CanonTeachCard,
  type CanonTeachState,
} from "@/components/workspace/CanonTeachCard";
import { canonTeachGate } from "@/lib/canon-teach";
import { type BlendPadCorner } from "@/components/workspace/BlendPad";
import {
  DebateStreamBlock,
  type DebateRosterVoice,
  type StreamingDebate,
} from "@/components/workspace/DebatePanel";
import {
  EVEN_BLEND,
  isResponseMode,
  normalizeConversationBlend,
  normalizeConversationVoiceModels,
  normalizeWeights,
  type BlendWeights,
  type ResponseMode,
} from "@/lib/blend";
import { normalizeModelPreferences } from "@/lib/workspaceState";
import { Paperclip } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { VenomMessageAttachment } from "@workspace/api-client-react";
import {
  ComposerAttachmentRow,
  FileDeliveryCard,
  FileWritingCard,
  MessageAttachmentChips,
} from "@/components/workspace/ChatFileCards";
import {
  attachmentStamp,
  chatFileErrorMessage,
  chatFileProblem,
  CHAT_FILE_ACCEPT,
  isImageFile,
  MAX_MESSAGE_ATTACHMENTS,
  uploadChatFile,
  type PendingChatFile,
} from "@/lib/chat-files";
import { makeImageThumbnail, prepareImageForUpload } from "@/lib/chat-images";
import {
  dictationSupported,
  MicPermissionError,
  startDictation,
  transcribeDictation,
  type DictationRecorder,
} from "@/lib/voice/dictation";

// Voice mode is a rarely-first-hit surface: everything behind it (audio
// adapter, orb, restraint) stays out of the entry chunk via this lazy edge.
const VoiceModeOverlay = React.lazy(
  () => import("@/components/workspace/voice/VoiceModeOverlay"),
);

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
  /** Machine-readable code accompanying an error event. */
  code?: string;
  /** File authoring plan, announced in the initial metadata event. */
  filePlan?: { format: string; title: string; switchedFrom?: string };
  /** File authoring: document growth heartbeat. */
  fileProgress?: { chars: number };
  /** File authoring: the stored, downloadable result. */
  file?: VenomMessageAttachment;
};

/** Options describing how a message wants to be answered. */
type SendOptions = {
  mode: ResponseMode;
  blend?: VenomConversationBlend;
  /** Explicit per-voice model picks (verify only). */
  voiceModels?: VenomVoiceModelPick[];
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
  /** File authoring: the announced plan, while a document is being written */
  filePlan?: { format: string; title: string; switchedFrom?: string };
  /** File authoring: characters of the document written so far */
  fileChars?: number;
  /** File authoring: the delivered file, once stored */
  file?: VenomMessageAttachment;
};

const GENERIC_PROJECT_NAMES = new Set(["global workspace", "workspace"]);

/** The three verify voices in pad-corner order, with offline label fallbacks. */
const VERIFY_VOICES: Array<{
  id: VenomVoiceModelPick["voiceId"];
  label: string;
}> = [
  { id: "direct", label: "First take" },
  { id: "skeptic", label: "Skeptic" },
  { id: "evidence", label: "Evidence" },
];

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
    syncStatus,
    addMessage,
    createNewConversation,
    setActiveConversation,
    clearConversation,
    applyKnowledgeInsights,
    applyFiledKnowledge,
    setActiveModelId,
    setConversationResponsePrefs,
  } = useVenomWorkspace();
  // Cloud-lag notice: after a failed save, this device is holding messages
  // the cloud does not have, and the person writing deserves to see that in
  // chat rather than in the sidebar status alone.
  const unsyncedNoticeText = useUnsyncedNoticeText(syncStatus);
  const queryClient = useQueryClient();

  const [, setLocation] = useLocation();

  const [inputValue, setInputValue] = useState(takePendingPrompt);
  const [isFocused, setIsFocused] = useState(false);

  // Files the composer is holding for the next message.
  const [pendingFiles, setPendingFiles] = useState<PendingChatFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { toast } = useToast();

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

  // Super admin flag for the canon teach flow. For everyone else this stays
  // false and chat behaves exactly as before; the server re-verifies the
  // role on every canon call, so this only decides whether to try.
  const { data: identity } = useGetVenomIdentity({
    query: {
      queryKey: getGetVenomIdentityQueryKey(),
      enabled: Boolean(userId),
      staleTime: 5 * 60_000,
      retry: 1,
    },
  });
  const canTeachCanon = identity?.superAdmin === true;

  // Canon teach flow state: the confirmation card pinned above the composer,
  // plus the deferred ordinary-chat dispatch for "just chat" and fail-open.
  const [canonTeach, setCanonTeach] = useState<CanonTeachState | null>(null);
  const canonFallThroughRef = useRef<{
    userMessageId: string;
    dispatch: () => void;
  } | null>(null);

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

  // The session a message lands in must belong to the project on screen,
  // which is the fallback project when nothing is explicitly selected
  // (mirrors the mobile app's onScreenProjectId).
  const onScreenProject =
    state?.projects?.find((p) => p.id === state?.activeProjectId) ||
    state?.projects?.[0];
  const onScreenProjectId: string | null =
    onScreenProject?.id ?? state?.activeProjectId ?? null;

  // A cited answer can lead back to the source it came from, so the reader
  // can open the rest of that source's evidence without leaving Venom.
  // Scoped to the on-screen project's connected sources — the same rule the
  // mobile chat applies — so a chip never points at another project's list.
  const sourceByCitationId = useMemo(() => {
    const map = new Map<string, ProjectSource>();
    for (const source of state?.sources ?? []) {
      if (source.projectId !== onScreenProjectId) continue;
      if (source.status !== "connected") continue;
      for (const citation of source.citations) {
        if (!map.has(citation.id)) map.set(citation.id, source);
      }
    }
    return map;
  }, [state?.sources, onScreenProjectId]);

  // Hands-free voice mode; the overlay only mounts (and loads) when opened.
  const [voiceModeOpen, setVoiceModeOpen] = useState(false);

  // Resolve active model ID from workspace preferences
  const modelPrefs = normalizeModelPreferences(state?.modelPreferences);
  const activeModelId = modelPrefs.activeModelId as VenomModelId;

  // ── Response mode & blend (per conversation, synced) ──────────────────────
  const responseMode: ResponseMode =
    deliberationAvailable && isResponseMode(activeConv?.responseMode)
      ? activeConv.responseMode
      : "talk";

  // Real models that could occupy pad corners: enabled AND currently
  // available AND on an account that can pay. The pad never shows a model
  // that cannot actually answer — a billing-dead provider would fail every
  // turn, and the pad's corners are sent as the debate roster.
  const cornerCandidates = useMemo(() => {
    if (!Array.isArray(modelsQuery.data)) return [];
    const available = new Map(
      modelsQuery.data
        .filter(
          (model) => model.available && model.accountHealth !== "unfunded",
        )
        .map((model) => [model.id, model]),
    );
    return modelPrefs.enabledModelIds
      .map((id) => available.get(id))
      .filter((model): model is NonNullable<typeof model> => Boolean(model));
  }, [modelsQuery.data, modelPrefs.enabledModelIds]);

  const personaVoices = deliberationQuery.data?.voices;

  // Per-conversation voice picks (verify): which enabled model plays each
  // deliberation voice. Normalized so junk from an older build or another
  // device never rides a request.
  const voicePicks = useMemo(
    () => normalizeConversationVoiceModels(activeConv?.voiceModels) ?? [],
    [activeConv?.voiceModels],
  );

  // Corner roster. Verify: the corners ARE the three deliberation voices,
  // with each voice's picked model (or Auto) as the sublabel. Debate: three
  // real models when at least three are usable; otherwise the deliberation
  // personas fill the corners so the pad always works.
  const { blendCorners, cornersPickable } = useMemo((): {
    blendCorners: [BlendPadCorner, BlendPadCorner, BlendPadCorner] | null;
    cornersPickable: boolean;
  } => {
    if (responseMode === "verify") {
      const nameById = new Map(
        (Array.isArray(modelsQuery.data) ? modelsQuery.data : []).map(
          (model) => [model.id, model.name],
        ),
      );
      const personaByVoice = new Map(
        (personaVoices ?? []).map((voice) => [voice.voiceId, voice.name]),
      );
      return {
        blendCorners: VERIFY_VOICES.map(({ id, label }) => {
          const pick = voicePicks.find((entry) => entry.voiceId === id);
          return {
            id,
            label: personaByVoice.get(id) ?? label,
            sublabel: pick
              ? (nameById.get(pick.modelId) ?? pick.modelId)
              : "Auto",
          };
        }) as [BlendPadCorner, BlendPadCorner, BlendPadCorner],
        cornersPickable: false,
      };
    }
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
  }, [
    responseMode,
    voicePicks,
    modelsQuery.data,
    cornerCandidates,
    personaVoices,
    activeConv?.blend,
  ]);

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
  // The combined models & voices popup — the single entry point for model
  // management, per-voice model picks, and the blend pad. The opener is
  // remembered so closing the dialog hands focus back to the exact control
  // that opened it (the dialog is controlled and has no Radix trigger).
  const [modelVoicesOpen, setModelVoicesOpen] = useState(false);
  const modelVoicesOpenerRef = useRef<HTMLElement | null>(null);
  const openModelVoices = useCallback(() => {
    modelVoicesOpenerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setModelVoicesOpen(true);
  }, []);

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

  // Assign a model to a verify voice (null returns the voice to Auto). The
  // picks ride the conversation's preference block, so they sync across
  // devices with the mode and blend.
  const handleVoicePickChange = useCallback(
    (voiceId: VenomVoiceModelPick["voiceId"], modelId: VenomModelId | null) => {
      if (!activeConvId) return;
      const next = voicePicks.filter((pick) => pick.voiceId !== voiceId);
      if (modelId) next.push({ voiceId, modelId });
      setConversationResponsePrefs(activeConvId, {
        voiceModels: next.length > 0 ? next : null,
      });
    },
    [activeConvId, voicePicks, setConversationResponsePrefs],
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
    // A pending teach card belongs to the account that asked; an account
    // switch discards it (nothing was committed).
    setCanonTeach(null);
    canonFallThroughRef.current = null;
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

  // A topic-classified filing landed in a shared workspace: say so, and give
  // the author one tap to pull it back. Undo restores the items to the
  // personal store's Unsorted holding area (the server hands the restored
  // records back so this device converges without waiting for a sync).
  const notifyWorkspaceFiling = useCallback(
    (
      conversationRef: { id: string; title: string; projectId: string | null },
      filing: VenomWorkspaceFiling,
    ) => {
      const labelSummary =
        filing.labels.length > 0
          ? filing.labels.slice(0, 3).join(", ") +
            (filing.labels.length > 3 ? "…" : "")
          : "New knowledge";
      toast({
        title: `Filed to ${filing.workspaceName}`,
        description: `${labelSummary} looked like ${filing.workspaceName} material, so it now lives in that workspace's Brain.`,
        action: (
          <ToastAction
            altText="Undo the workspace filing"
            data-testid={`button-undo-filing-${filing.noticeId}`}
            onClick={() => {
              void undoVenomKnowledgeMove(filing.noticeId)
                .then((result) => {
                  void queryClient.invalidateQueries({
                    queryKey: getGetSharedWorkspaceKnowledgeQueryKey(
                      filing.workspaceId,
                    ),
                  });
                  if (result.restored.length > 0) {
                    applyFiledKnowledge(conversationRef, result.restored);
                  }
                  toast({
                    title: "Filing undone",
                    description:
                      "It moved back to your private Unsorted items — find them under Brain.",
                  });
                })
                .catch(() => {
                  toast({
                    title: "Could not undo",
                    description:
                      "The filing may have changed since. Review it on the Brain page.",
                    variant: "destructive",
                  });
                });
            }}
          >
            Undo
          </ToastAction>
        ),
      });
    },
    [applyFiledKnowledge, queryClient, toast],
  );

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

      // Capture project ID for the request body. A session created in this
      // same turn is not in the captured state yet, so fall back to the
      // project on screen — the one the session was just opened under.
      const conv = state.conversations.find((item) => item.id === convId);
      const projectId = conv?.projectId ?? onScreenProjectId ?? "proj_default";

      // Debate: history the next round would continue from (persisted turns
      // plus any interjections), whether a restart was requested, and the
      // round's conclusion — the closing turn, if it landed — which is the
      // only debate text the Brain may absorb.
      const debateHistory: VenomMessage[] = [...messagesContext];
      let restartWith: VenomMessage[] | null = null;
      let settledDebateTurn: VenomMessage | null = null;

      // Background knowledge extraction for this turn. The messages payload
      // decides what the Brain absorbs, so callers hand in exactly the
      // settled exchange: raw debate turns (speaker-attributed messages)
      // never ride along — a debate contributes only through its settled
      // closing turn.
      const runKnowledgeExtraction = async (
        extractionMessages: Array<{
          id: string;
          role: "user" | "assistant";
          content: string;
        }>,
      ) => {
        const latestConv = state.conversations.find(
          (item) => item.id === convId,
        );
        if (!latestConv || extractionMessages.length === 0) return;
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
              // ontology store; `filed` carries the canonical records. Scope
              // is the server's call now (personal / workspace by topic /
              // Unsorted) — no user-chosen workspaceId rides along.
              file: true,
              conversation: {
                id: convId,
                title: conversationTitle,
                projectId: latestConv.projectId,
              },
              messages: extractionMessages,
            },
            { signal: extractionController.signal },
          );

          if (activeUserIdRef.current === userId) {
            const conversationRef = {
              id: convId,
              title: conversationTitle,
              projectId: latestConv.projectId,
            };
            // Topic classification filed some clusters straight into shared
            // workspaces. Their records never merge into the personal blob
            // (shared content must stay evictable) — refresh the cached
            // workspace knowledge and tell the author, with one-tap undo.
            const workspaceFilings = result.workspaceFilings ?? [];
            for (const filing of workspaceFilings) {
              void queryClient.invalidateQueries({
                queryKey: getGetSharedWorkspaceKnowledgeQueryKey(
                  filing.workspaceId,
                ),
              });
              notifyWorkspaceFiling(conversationRef, filing);
            }
            if (result.filedScope?.ownerType === 'org') {
              // Work in a company-shared project grows the company Brain
              // on the server. Never mirror it into the personal map —
              // even when filing hiccuped (`filed` missing), the fallback
              // below would misfile shared work as personal.
            } else if (result.filed && result.filed.length > 0) {
              // The server filed these into the ontology store already;
              // mirror its canonical records locally (Unsorted holdings
              // ride along with `unsorted: true`).
              applyFiledKnowledge(conversationRef, result.filed);
            } else if (!result.filed && workspaceFilings.length === 0) {
              // Older server or filing hiccup: fall back to local filing,
              // which reaches the store on the next workspace sync. Never
              // when workspace filings exist — those clusters live in
              // shared stores, and re-filing them locally would duplicate
              // them as personal.
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
      };

      // File authoring: the delivered stamp and any render-failure notice,
      // captured from stream events so the persisted message carries them.
      let deliveredFile: VenomMessageAttachment | undefined;
      let fileRenderFailed = false;

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
              ...(message.attachments && message.attachments.length > 0
                ? {
                    attachmentIds: message.attachments
                      .slice(0, MAX_MESSAGE_ATTACHMENTS)
                      .map((attachment) => attachment.id),
                  }
                : {}),
            })),
            projectContext: projectContext?.slice(0, 1000),
            projectId,
            modelId,
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
                  // Explicit per-voice model picks (verify only). The server
                  // enforces the argue-itself rule on these, so a stale or
                  // hand-crafted pick fails loudly rather than silently.
                  ...(mode === "verify" &&
                  options?.voiceModels &&
                  options.voiceModels.length > 0
                    ? { voiceModels: options.voiceModels }
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

          // Server-side error events – surface them explicitly. One code is
          // special: file_render_failed arrives AFTER the chat answer when
          // only the document could not be produced, and is followed by a
          // normal done — the streamed answer must survive it.
          if (data.error) {
            if (data.code === "file_render_failed") {
              fileRenderFailed = true;
              setStreaming((current) =>
                current?.id === streamId
                  ? { ...current, filePlan: undefined, fileChars: undefined }
                  : current,
              );
              return;
            }
            throw new Error(data.error);
          }

          // File authoring events ride the same stream. None of these end
          // the event's processing: the initial metadata event pairs the
          // plan with model attribution below.
          if (data.filePlan) {
            const filePlan = data.filePlan;
            setStreaming((current) =>
              current?.id === streamId ? { ...current, filePlan } : current,
            );
          }
          if (data.fileProgress) {
            const chars = data.fileProgress.chars;
            setStreaming((current) =>
              current?.id === streamId
                ? { ...current, fileChars: chars }
                : current,
            );
          }
          if (data.file) {
            deliveredFile = data.file;
            const file = data.file;
            setStreaming((current) =>
              current?.id === streamId ? { ...current, file } : current,
            );
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
                // The round's final planned turn is its conclusion: the
                // closing voice weighs the exchange and lands the final
                // word. Only that turn can settle the debate for the Brain.
                if (turn.index === debate.plannedTurns - 1) {
                  settledDebateTurn = persisted;
                }
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
          // A debate settles only when its round ran to a clean end and the
          // closing turn landed with content. Absorb exactly that outcome:
          // the thread minus the sparring, plus the conclusion anchored to
          // its persisted message. Stopped or truncated rounds — and rounds
          // whose closing voice failed — leave no trace in the Brain.
          // (Snapshot-cast: TS flow analysis cannot see the assignments made
          // inside consumeEvent.)
          const settledTurn = settledDebateTurn as VenomMessage | null;
          if (settledTurn && !abortController.signal.aborted) {
            await runKnowledgeExtraction([
              ...messagesContext
                .filter((message) => !message.speakerId)
                .slice(-47)
                .map((message) => ({
                  id: message.id,
                  role: message.role,
                  content: message.content.slice(0, 8000),
                })),
              {
                id: settledTurn.id,
                role: "assistant",
                content: settledTurn.content.slice(0, 8000),
              },
            ]);
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
          ...(deliveredFile ? { attachments: [deliveredFile] } : {}),
        });
        if (fileRenderFailed) {
          toast({
            title: "The document couldn't be created",
            description:
              "The answer above is intact — ask Venom to produce the file again.",
            variant: "destructive",
          });
        }
        setStreaming(null);
        if (abortControllerRef.current === abortController) {
          abortControllerRef.current = null;
        }

        // Update active model ID in workspace prefs if server used a different one
        if (attribution && attribution.modelId !== modelId) {
          setActiveModelId(attribution.modelId);
        }

        // Speaker-attributed messages are raw debate turns: argument, not
        // settled knowledge. They never enter an extraction window — a
        // debate contributes through its settled closing turn instead.
        await runKnowledgeExtraction([
          ...messagesContext
            .filter((message) => !message.speakerId)
            .slice(-47)
            .map((message) => ({
              id: message.id,
              role: message.role,
              content: message.content.slice(0, 8000),
            })),
          {
            id: streamId,
            role: "assistant",
            content: fullContent.slice(0, 8000),
          },
        ]);
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
    [addMessage, applyKnowledgeInsights, applyFiledKnowledge, setActiveModelId, state.conversations, onScreenProjectId, notifyWorkspaceFiling, queryClient, toast],
  );

  // Self-reference so a finishing debate round can start its successor
  // without a stale closure.
  const handleFetchStreamRef = useRef<typeof handleFetchStream | null>(null);
  useEffect(() => {
    handleFetchStreamRef.current = handleFetchStream;
  }, [handleFetchStream]);

  /** Add picked/dropped/pasted files, uploading each in the background. */
  const handlePickFiles = (list: FileList | File[] | null) => {
    const picked = list ? Array.from(list) : [];
    if (picked.length === 0) return;
    const room = MAX_MESSAGE_ATTACHMENTS - pendingFiles.length;
    if (picked.length > room) {
      toast({
        title: `Up to ${MAX_MESSAGE_ATTACHMENTS} files ride one message.`,
        variant: "destructive",
      });
    }
    const accepted: PendingChatFile[] = [];
    for (const file of picked.slice(0, Math.max(room, 0))) {
      const localId = `att_${crypto.randomUUID()}`;
      const problem = chatFileProblem(file);
      if (problem) {
        accepted.push({
          localId,
          name: file.name,
          size: file.size,
          status: "error",
          error: problem,
        });
        continue;
      }
      accepted.push({
        localId,
        name: file.name,
        size: file.size,
        status: "uploading",
      });
      void (async () => {
        try {
          // Images first get their tiny preview (it rides the stamp through
          // synced history), then upload a possibly-downscaled rendition.
          const image = isImageFile(file);
          const thumbnail = image
            ? ((await makeImageThumbnail(file)) ?? undefined)
            : undefined;
          if (thumbnail) {
            setPendingFiles((items) =>
              items.map((item) =>
                item.localId === localId ? { ...item, thumbnail } : item,
              ),
            );
          }
          const upload = image ? await prepareImageForUpload(file) : file;
          const stored = await uploadChatFile(upload);
          setPendingFiles((items) =>
            items.map((item) =>
              item.localId === localId
                ? {
                    ...item,
                    status: "ready" as const,
                    name: stored.name,
                    size: stored.size,
                    stamp: attachmentStamp(stored, thumbnail),
                  }
                : item,
            ),
          );
        } catch (error) {
          setPendingFiles((items) =>
            items.map((item) =>
              item.localId === localId
                ? {
                    ...item,
                    status: "error" as const,
                    error: chatFileErrorMessage(error),
                  }
                : item,
            ),
          );
        }
      })();
    }
    if (accepted.length > 0) {
      setPendingFiles((current) => [...current, ...accepted]);
    }
  };

  const removePendingFile = (localId: string) => {
    setPendingFiles((current) =>
      current.filter((item) => item.localId !== localId),
    );
  };

  // ── Dictation: one mic take transcribed into the input box ───────────────
  const [dictation, setDictation] = useState<
    "idle" | "recording" | "transcribing"
  >("idle");
  const dictationRecorderRef = useRef<DictationRecorder | null>(null);
  // Bumped by every cancel; a mic acquired under an older epoch (the user
  // left while the permission prompt was open) must be released on arrival.
  const dictationEpochRef = useRef(0);
  const dictationStartingRef = useRef(false);

  const cancelDictation = useCallback(() => {
    dictationEpochRef.current += 1;
    dictationRecorderRef.current?.cancel();
    dictationRecorderRef.current = null;
    setDictation("idle");
  }, []);

  // Leaving the page mid-take must release the microphone.
  useEffect(() => cancelDictation, [cancelDictation]);

  const appendDictatedText = (text: string) => {
    if (!text) return;
    setInputValue((current) =>
      current.trim() ? `${current.replace(/\s+$/, "")} ${text}` : text,
    );
    // The textarea auto-sizes from its change handler; a programmatic set
    // has to redo that by hand once the new value has rendered.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    });
  };

  const handleDictateToggle = async () => {
    if (dictation === "transcribing") return;
    if (dictation === "recording") {
      const recorder = dictationRecorderRef.current;
      dictationRecorderRef.current = null;
      if (!recorder) {
        setDictation("idle");
        return;
      }
      setDictation("transcribing");
      try {
        const take = await recorder.stop();
        if (take) appendDictatedText(await transcribeDictation(take));
      } catch (error) {
        toast({
          title: "That didn't make it into text.",
          description:
            error instanceof Error && error.message ? error.message : undefined,
          variant: "destructive",
        });
      } finally {
        setDictation("idle");
      }
      return;
    }
    if (!dictationSupported()) {
      toast({
        title: "This browser can't record audio.",
        variant: "destructive",
      });
      return;
    }
    // One start at a time: a second tap while the permission prompt is open
    // must not acquire a second stream.
    if (dictationStartingRef.current) return;
    dictationStartingRef.current = true;
    const epoch = dictationEpochRef.current;
    try {
      const recorder = await startDictation();
      if (dictationEpochRef.current !== epoch) {
        // The composer moved on (unmount, cancel) while the permission
        // prompt was open. Release the microphone immediately — never let
        // a recorder with no UI roll on toward the safety cap.
        recorder.cancel();
        return;
      }
      dictationRecorderRef.current = recorder;
      setDictation("recording");
    } catch (error) {
      if (dictationEpochRef.current !== epoch) return;
      const denied = error instanceof MicPermissionError;
      toast({
        title: denied
          ? "Microphone access was declined."
          : "The microphone could not be started.",
        description: denied
          ? "Allow the microphone in your browser settings to dictate."
          : undefined,
        variant: "destructive",
      });
    } finally {
      dictationStartingRef.current = false;
    }
  };

  // ── Drag-and-drop files onto the conversation ─────────────────────────────
  const dragDepthRef = useRef(0);
  const [dragActive, setDragActive] = useState(false);

  const dragHasFiles = (event: React.DragEvent) =>
    Array.from(event.dataTransfer.types).includes("Files");

  const handleSend = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!userId) return;
    // Wait out in-flight uploads: sending now would silently drop them.
    if (pendingFiles.some((item) => item.status === "uploading")) return;

    const input = inputValue.trim();
    const readyStamps = pendingFiles.flatMap((item) =>
      item.status === "ready" && item.stamp ? [item.stamp] : [],
    );
    if (!input && readyStamps.length === 0) return;
    setInputValue("");

    // Intercept only the user's explicit build request before it reaches
    // chat. A message carrying files is never rerouted — files are for chat.
    const match =
      readyStamps.length === 0
        ? input.match(
            /^(?:create|build|make|generate|design)\s+(?:an?\s+|the\s+|my\s+)?(?:new\s+)?(app|application|website|site|brand|customer[- ]?service(?:[- ]?flow)?)\b/i,
          )
        : null;
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
      if (onScreenProjectId) searchParams.set("projectId", onScreenProjectId);

      setLocation(`/workspace/builds/new?${searchParams.toString()}`);
      return;
    }

    // Never append to a session that belongs to another project — or to no
    // project at all: the answer is read as part of the project on screen, so
    // that is where it has to be filed. A missing or mismatched session means
    // the first message opens a fresh one under the on-screen project.
    let targetConvId = activeConvId ?? null;
    const targetConv = state?.conversations?.find(
      (c) => c.id === targetConvId,
    );
    if (!targetConvId || (targetConv?.projectId ?? null) !== onScreenProjectId) {
      targetConvId = createNewConversation(onScreenProjectId);
    }
    // After the guard the target session's project IS the on-screen project.
    const sendConv = targetConv?.id === targetConvId ? targetConv : undefined;

    const userMessageId = `msg_${crypto.randomUUID()}`;
    const userMessage: VenomMessage = {
      id: userMessageId,
      role: "user",
      content: input,
      status: "sent",
      createdAt: Date.now(),
      ...(readyStamps.length > 0 ? { attachments: readyStamps } : {}),
    };
    addMessage(targetConvId, {
      id: userMessageId,
      role: "user",
      content: input,
      status: "sent",
      ...(readyStamps.length > 0 ? { attachments: readyStamps } : {}),
    });
    // The files now ride that message; the composer starts clean.
    setPendingFiles([]);

    // Mid-debate send: the message joins the thread now and queues for the
    // next turn boundary, where the round restarts with it in context.
    if (
      streaming?.status === "sending" &&
      streaming.debate &&
      streaming.convId === targetConvId
    ) {
      pendingInterjectionsRef.current.push(userMessage);
      return;
    }

    const sendProject = state?.projects?.find(
      (p) => p.id === onScreenProjectId,
    );
    const contextMessages = [...(sendConv?.messages || []), userMessage];

    const projectContext = sendProject
      ? `Project: ${sendProject.name}\n${sendProject.description}`
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
            ...(responseMode === "verify" && voicePicks.length > 0
              ? { voiceModels: voicePicks }
              : {}),
          }
        : undefined;
    const dispatchTurn = () =>
      void handleFetchStream(
        targetConvId,
        userId,
        contextMessages,
        activeModelId,
        projectContext,
        input,
        options,
      );

    // Super admin teach interception: text-only messages that read like a
    // teach command go through propose → confirm → commit instead of
    // streaming. Everyone else — and every message with files, and every
    // miss of the cheap gate — takes the exact dispatch below, untouched.
    // The gate here only saves round-trips; the server re-checks the role
    // and re-runs its own gate.
    if (canTeachCanon && readyStamps.length === 0 && canonTeachGate(input)) {
      void beginCanonTeach(targetConvId, userMessageId, input, dispatchTurn);
      return;
    }

    dispatchTurn();
  };

  // Probing a possible teaching: the admin's message is already in the
  // thread; this decides whether the confirmation card replaces the
  // ordinary streamed answer. Any miss or failure falls open to that
  // answer — teach detection must never eat a message.
  const beginCanonTeach = async (
    convId: string,
    userMessageId: string,
    message: string,
    dispatch: () => void,
  ) => {
    const initiatingUserId = userId;
    if (!initiatingUserId) return;
    canonFallThroughRef.current = { userMessageId, dispatch };
    setCanonTeach({ convId, userMessageId, message, phase: "probing" });
    try {
      const conversation = state?.conversations?.find(
        (item) => item.id === convId,
      );
      const conversationTitle =
        conversation && conversation.title !== "New Session"
          ? conversation.title
          : undefined;
      const result = await proposeVenomCanonTeaching({
        message,
        conversationId: convId,
        ...(conversationTitle ? { conversationTitle } : {}),
      });
      if (activeUserIdRef.current !== initiatingUserId) {
        setCanonTeach(null);
        return;
      }
      if (result.teachIntent && result.draft) {
        setCanonTeach({
          convId,
          userMessageId,
          message,
          phase: "confirm",
          draft: result.draft,
        });
        return;
      }
    } catch {
      // Propose is best-effort; an error means this send is ordinary chat.
    }
    if (activeUserIdRef.current !== initiatingUserId) {
      setCanonTeach(null);
      return;
    }
    // No teach intent after all: fail open to the normal answer.
    setCanonTeach(null);
    canonFallThroughRef.current = null;
    dispatch();
  };

  // Committing a confirmed teaching: the only write path into canon from
  // chat, and it exists strictly behind the confirmation card. Failure keeps
  // the card up with the error; nothing half-commits.
  const handleCanonConfirm = async () => {
    const snapshot = canonTeach;
    if (!snapshot?.draft || snapshot.phase !== "confirm") return;
    const initiatingUserId = userId;
    if (!initiatingUserId) return;
    setCanonTeach({ ...snapshot, phase: "committing", error: null });
    try {
      const conversation = state?.conversations?.find(
        (item) => item.id === snapshot.convId,
      );
      const conversationTitle =
        conversation && conversation.title !== "New Session"
          ? conversation.title
          : undefined;
      const result = await commitVenomCanonTeaching({
        domain: snapshot.draft.domain,
        title: snapshot.draft.title,
        principles: snapshot.draft.principles,
        conversationId: snapshot.convId,
        ...(conversationTitle ? { conversationTitle } : {}),
      });
      if (activeUserIdRef.current !== initiatingUserId) return;
      // The acknowledgment lands as Venom's own turn in the thread.
      addMessage(snapshot.convId, {
        id: `msg_${crypto.randomUUID()}`,
        role: "assistant",
        content: result.acknowledgment,
        status: "sent",
      });
      setCanonTeach(null);
      canonFallThroughRef.current = null;
    } catch {
      setCanonTeach((prev) =>
        prev && prev.userMessageId === snapshot.userMessageId
          ? {
              ...prev,
              phase: "confirm",
              error: "Couldn't commit this to canon. Try again.",
            }
          : prev,
      );
    }
  };

  // Cancel means "just answer me": the drafted teaching is discarded and the
  // already-filed user message gets the ordinary streamed answer instead.
  const handleCanonCancel = () => {
    const snapshot = canonTeach;
    if (!snapshot || snapshot.phase === "committing") return;
    setCanonTeach(null);
    if (snapshot.phase !== "confirm") return;
    const pending = canonFallThroughRef.current;
    canonFallThroughRef.current = null;
    if (pending && pending.userMessageId === snapshot.userMessageId) {
      pending.dispatch();
    }
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
    <div
      className="relative z-0 flex h-full flex-1 flex-col bg-background"
      onDragEnter={(event) => {
        if (!dragHasFiles(event)) return;
        event.preventDefault();
        dragDepthRef.current += 1;
        setDragActive(true);
      }}
      onDragOver={(event) => {
        if (dragHasFiles(event)) event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (!dragHasFiles(event)) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDragActive(false);
      }}
      onDrop={(event) => {
        if (!dragHasFiles(event)) return;
        event.preventDefault();
        dragDepthRef.current = 0;
        setDragActive(false);
        if (!composerLocked) handlePickFiles(event.dataTransfer.files);
      }}
    >
      {dragActive && (
        <div
          className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center border-2 border-dashed border-foreground/50 bg-background/80"
          data-testid="overlay-drop-files"
        >
          <div className="flex items-center gap-2 rounded-xl border border-border/60 surface px-4 py-2 text-sm text-foreground shadow-lift">
            <Paperclip className="h-4 w-4" aria-hidden="true" />
            Drop files to attach
          </div>
        </div>
      )}
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
                {conversationProject?.name
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

                // The connected sources this answer cited, in the order they
                // appear. Each entry remembers the first citation the answer
                // quoted from that source, so the jump below can land the
                // reader on the exact quoted row — not just the card around
                // it (mirrors the mobile chat's cited-source chips).
                const citedSources: {
                  source: ProjectSource;
                  citationId: string;
                }[] = [];
                if (msg.role === "assistant") {
                  for (const segment of messageCitationSegments(
                    msg.content,
                    citationsById,
                    archivedCitationsById,
                  )) {
                    if (segment.kind !== "citation") continue;
                    const source = sourceByCitationId.get(segment.citation.id);
                    if (
                      !source ||
                      citedSources.some(
                        (entry) => entry.source.id === source.id,
                      )
                    ) {
                      continue;
                    }
                    citedSources.push({
                      source,
                      citationId: segment.citation.id,
                    });
                  }
                }

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
                              data-testid="status-caret"
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

                    {msg.role === "user" &&
                      msg.attachments &&
                      msg.attachments.length > 0 && (
                        <MessageAttachmentChips attachments={msg.attachments} />
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

                    {/* File authoring – the live writing card while the
                        document grows, then the delivered file with its
                        download once it is stored. */}
                    {msg.role === "assistant" &&
                      msg.status === "sending" &&
                      streaming &&
                      streaming.id === msg.id &&
                      streaming.filePlan &&
                      !streaming.file && (
                        <FileWritingCard
                          title={streaming.filePlan.title}
                          format={streaming.filePlan.format}
                          chars={streaming.fileChars}
                          switchedFrom={streaming.filePlan.switchedFrom}
                        />
                      )}
                    {msg.role === "assistant" &&
                      (msg.status === "sending" &&
                      streaming &&
                      streaming.id === msg.id &&
                      streaming.file
                        ? [streaming.file]
                        : msg.status === "sent"
                          ? (msg.attachments ?? [])
                          : []
                      ).map((attachment) => (
                        <FileDeliveryCard
                          key={attachment.id}
                          attachment={attachment}
                        />
                      ))}

                    {/* A cited answer leads back to its evidence: each chip
                        opens the Brain's sources view scrolled to the cited
                        source, landed on the exact quoted citation row. */}
                    {msg.role === "assistant" &&
                      msg.status !== "error" &&
                      citedSources.length > 0 && (
                        <div className="mt-2 flex w-full flex-wrap items-center gap-1.5">
                          {citedSources.map(({ source, citationId }) => (
                            <button
                              key={source.id}
                              type="button"
                              onClick={() =>
                                setLocation(
                                  `/workspace/brain?view=sources&source=${encodeURIComponent(source.id)}&citation=${encodeURIComponent(citationId)}`,
                                )
                              }
                              aria-label={`Show all ${source.citations.length} citation${source.citations.length === 1 ? "" : "s"} from ${source.name} in Venom`}
                              data-testid={`chat-open-source-${source.id}`}
                              className="flex max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-background px-3 py-1.5 text-xs transition-colors hover:border-foreground/50 hover:bg-foreground/5"
                            >
                              {source.provider === "github" ? (
                                <Github
                                  className="h-3 w-3 shrink-0"
                                  aria-hidden="true"
                                />
                              ) : (
                                <Globe
                                  className="h-3 w-3 shrink-0"
                                  aria-hidden="true"
                                />
                              )}
                              <span className="max-w-[14rem] truncate font-medium text-foreground">
                                {source.name}
                              </span>
                              <span className="shrink-0 text-muted-foreground">
                                {source.citations.length} citation
                                {source.citations.length === 1 ? "" : "s"}
                              </span>
                              <ArrowUpRight
                                className="h-3 w-3 shrink-0 text-muted-foreground"
                                aria-hidden="true"
                              />
                            </button>
                          ))}
                        </div>
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
        <AnimatePresence initial={false}>
          {unsyncedNoticeText && (
            <motion.div
              key="unsynced-notice"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              className="mx-auto mb-2 max-w-3xl"
            >
              <div
                role="status"
                data-testid="chat-unsynced-notice"
                className="flex items-center gap-2 rounded-xl border border-border/60 surface px-3 py-1.5 text-xs text-muted-foreground"
              >
                <CloudOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{unsyncedNoticeText}</span>
              </div>
            </motion.div>
          )}
          {dictation !== "idle" && (
            <motion.div
              key="dictation-status"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              className="mx-auto mb-2 max-w-3xl"
            >
              <div
                role="status"
                data-testid="dictation-status"
                className="flex items-center gap-2 rounded-xl border border-border/60 surface px-3 py-1.5 text-xs text-muted-foreground"
              >
                <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
                  {dictation === "recording" && (
                    <span className="absolute inline-flex h-full w-full rounded-full bg-foreground opacity-60 motion-safe:animate-ping" />
                  )}
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-foreground" />
                </span>
                <span>
                  {dictation === "recording"
                    ? "Listening — tap the mic again to finish"
                    : "Turning your words into text…"}
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {canonTeach && canonTeach.convId === activeConvId ? (
          <CanonTeachCard
            state={canonTeach}
            onConfirm={() => void handleCanonConfirm()}
            onCancel={handleCanonCancel}
          />
        ) : null}
        <form
          onSubmit={handleSend}
          className={cn(
            "mx-auto flex max-w-3xl flex-col rounded-2xl border surface p-2 shadow-lift transition-colors duration-200 sheen",
            isFocused ? "border-foreground/60" : "border-border/60",
          )}
          data-testid="form-composer"
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={CHAT_FILE_ACCEPT}
            multiple
            className="hidden"
            onChange={(event) => {
              handlePickFiles(event.target.files);
              event.target.value = "";
            }}
            data-testid="input-chat-file"
          />
          <ComposerAttachmentRow
            items={pendingFiles}
            onRemove={removePendingFile}
          />
          <div className="flex items-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => fileInputRef.current?.click()}
              disabled={
                composerLocked ||
                pendingFiles.length >= MAX_MESSAGE_ATTACHMENTS
              }
              className="mb-1 h-9 w-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
              aria-label="Attach files or images"
              title="Attach files or images — PDF, text, Markdown, CSV, JSON, PNG, JPEG, WEBP, GIF"
              data-testid="button-attach-file"
            >
              <Paperclip className="h-4 w-4" aria-hidden="true" />
            </Button>
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
                onPaste={(e) => {
                  const images = Array.from(
                    e.clipboardData?.files ?? [],
                  ).filter((file) => file.type.startsWith("image/"));
                  if (images.length === 0) return;
                  e.preventDefault();
                  handlePickFiles(images);
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
              type="button"
              variant={dictation === "recording" ? "default" : "outline"}
              size="icon"
              onClick={handleDictateToggle}
              disabled={composerLocked || dictation === "transcribing"}
              className="mb-1 h-9 w-9 shrink-0 rounded-full"
              aria-label={
                dictation === "recording"
                  ? "Finish dictating"
                  : "Dictate a message"
              }
              aria-pressed={dictation === "recording"}
              title={
                dictation === "recording"
                  ? "Finish dictating"
                  : "Dictate a message"
              }
              data-testid="button-dictate"
            >
              {dictation === "transcribing" ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Mic className="h-4 w-4" aria-hidden="true" />
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => {
                cancelDictation();
                setVoiceModeOpen(true);
              }}
              disabled={streaming?.status === "sending"}
              className="mb-1 h-9 w-9 shrink-0 rounded-full"
              aria-label="Talk to Venom out loud"
              title="Talk to Venom out loud"
              data-testid="button-voice-mode"
            >
              <AudioLines className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              type="submit"
              disabled={
                (!inputValue.trim() &&
                  !pendingFiles.some((item) => item.status === "ready")) ||
                pendingFiles.some((item) => item.status === "uploading") ||
                composerLocked
              }
              size="icon"
              className="mb-1 h-9 w-9 shrink-0 rounded-full"
              aria-label="Send message"
              data-testid="button-send"
            >
              <SendHorizontal className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>

          {/* Model selector row */}
          <div className="flex items-center gap-2 px-3 pb-1">
            <ModelSelector onOpen={openModelVoices} />
            <div className="ml-auto flex items-center gap-2">
              {deliberationAvailable && responseMode !== "talk" && (
                <button
                  type="button"
                  onClick={openModelVoices}
                  className="rounded-full border border-border/60 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-haspopup="dialog"
                  data-testid="button-open-voices"
                >
                  Voices
                </button>
              )}
              {deliberationAvailable && (
                <ResponseModeSwitch
                  value={responseMode}
                  onChange={handleModeChange}
                  disabled={streaming?.status === "sending"}
                />
              )}
            </div>
          </div>
        </form>
      </div>

      {/* Combined models & voices popup — model management, per-voice model
          picks, and the blend pad live behind every composer entry point. */}
      <ModelVoicesDialog
        open={modelVoicesOpen}
        onOpenChange={setModelVoicesOpen}
        openerRef={modelVoicesOpenerRef}
        responseMode={responseMode}
        deliberationAvailable={deliberationAvailable}
        distinctModels={deliberationQuery.data?.distinctModels !== false}
        personaVoices={personaVoices}
        voicePicks={voicePicks}
        onVoicePickChange={handleVoicePickChange}
        blendCorners={blendCorners}
        padWeights={padWeights}
        onPadChange={setDraftWeights}
        onPadCommit={commitBlend}
        padDisabled={debateInFlight}
        cornersPickable={cornersPickable}
        usableModels={cornerCandidates}
        onCornerToggle={handleCornerToggle}
      />

      {/* Hands-free voice mode — same loop as the phone, same thread. */}
      {voiceModeOpen && (
        <React.Suspense fallback={null}>
          <VoiceModeOverlay
            open={voiceModeOpen}
            activeProject={onScreenProject ?? null}
            onClose={() => setVoiceModeOpen(false)}
          />
        </React.Suspense>
      )}
    </div>
  );
}
