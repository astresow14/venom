import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  useWindowDimensions,
  TouchableOpacity,
  ScrollView,
  Animated as RNAnimated,
  PanResponder,
  TextInput,
  FlatList,
  ActivityIndicator,
  Platform,
  Keyboard,
  Linking,
  Modal,
  AccessibilityInfo,
  findNodeHandle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useAuth } from "@clerk/expo";
import { useFocusEffect, useRouter } from "expo-router";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { fetch } from "expo/fetch";
import * as Haptics from "expo-haptics";
import Animated, {
  Easing,
  type SharedValue,
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withRepeat,
  cancelAnimation,
  ReduceMotion,
  runOnJS,
  withTiming,
  useReducedMotion,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

import { useColors } from "@/hooks/useColors";
import { useTheme } from "@/context/ThemeContext";
import { claimFocusHandoff } from "@/lib/dialogFocusHandoff";
import {
  useVenom,
  IS_UI_TEST,
  IS_READ_ONLY_UI_TEST,
  UI_TEST_USER_ID,
  Message,
  KnowledgeCluster,
  Task,
  KanbanField,
  KanbanFieldType,
  KanbanStage,
  type ProjectSource,
  type VenomModelId,
} from "@/context/VenomContext";
import {
  ApiError,
  dismissVenomAppImprovementSuggestion,
  extractVenomKnowledge,
  getGetCommunityNotificationUnreadCountQueryKey,
  getGetSharedWorkspaceKnowledgeQueryKey,
  getListVenomAppsQueryKey,
  getVenomOntologyConcept,
  searchVenomOntology,
  useGetCommunityNotificationUnreadCount,
  useGetVenomDeliberation,
  useGetVenomModels,
  useListVenomApps,
  type VenomManagedModel,
  type VenomMessageDeliberation,
  type VenomModelId as ApiVenomModelId,
  type VenomOntologyConceptDetail,
  type VenomOntologySearchResult,
  type VenomResponseMode,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useSharedWorkspace } from "@/context/sharedWorkspace";
import {
  notifyWorkspaceAccessLost,
  WORKSPACE_ACCESS_DENIED_CODE,
} from "@/lib/workspaceAccess";
import { BrainNoteComposer } from "@/components/BrainNoteComposer";
import { VoiceModeOverlay } from "@/components/voice/VoiceModeOverlay";
import { ResponseModeSwitch } from "@/components/ResponseModeSwitch";
import { BlendPad, type BlendCorner } from "@/components/BlendPad";
import {
  EVEN_BLEND,
  isResponseMode,
  normalizeConversationBlend,
  type BlendWeights,
} from "@/context/responsePrefs";
import { SymbioteSlime } from "@/components/SymbioteSlime";
import { CommunityBriefing } from "@/components/community/CommunityBriefing";
import { CommunityNotifications } from "@/components/community/CommunityNotifications";
import { NotificationBadge } from "@/components/community/NotificationBadge";
import {
  deriveSatelliteNodes,
  layoutIslands,
  slimeCapacityForTierName,
  type SlimeEdge,
  type SlimeNode,
} from "@workspace/slime";
import { buildChatProjectContextBundle } from "@/context/sourceContext";
import {
  messageCitationPlainText,
  messageCitationSegments,
} from "@/context/messageCitations";
import {
  knowledgeDisplayText,
  type KnowledgeCitationLookup,
} from "@/context/knowledgeState";

// Browser UI tests run without a Clerk session, so chat uses a stand-in
// identity and token that only exist in the development UI-test bundle.
const UI_TEST_CHAT_TOKEN = "venom-ui-test-chat-token";

/**
 * Test hook: `?slimeTier=full` pins the goo renderer tier so captures can
 * show the whole organism on software rasterizers that live rendering would
 * (correctly) tier down. Inert outside UI-test mode and on native.
 */
const SLIME_CAPACITY_OVERRIDE =
  IS_UI_TEST && typeof globalThis.location !== "undefined"
    ? slimeCapacityForTierName(
        new URLSearchParams(globalThis.location.search).get("slimeTier") ?? "",
      )
    : null;

/**
 * Test hook: `?slimeScale=0.5` pins the goo surface fraction and turns
 * frame-time adaptation off, so visual captures stay deterministic on
 * software rasterizers. Inert outside UI-test mode and on native.
 */
const SLIME_SCALE_OVERRIDE = (() => {
  if (!IS_UI_TEST || typeof globalThis.location === "undefined") return null;
  const raw = new URLSearchParams(globalThis.location.search).get("slimeScale");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 1) : null;
})();
let messageCounter = 0;
function generateUniqueId(): string {
  messageCounter++;
  return `msg-${Date.now()}-${messageCounter}-${Math.random().toString(36).substr(2, 9)}`;
}

type DeliberationRosterVoice = {
  voiceId: string;
  name: string;
  tagline?: string;
  modelId?: string;
  modelName?: string;
};
function ChatWorkspace({
  isActive,
  activeProject,
}: {
  isActive: boolean;
  activeProject: any;
}) {
  const router = useRouter();
  const { getToken, userId: authenticatedUserId } = useAuth();
  const userId = IS_UI_TEST
    ? UI_TEST_USER_ID
    : (authenticatedUserId ?? null);
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const {
    state,
    isReady,
    addMessage,
    setActiveConversation,
    createNewConversation,
    applyKnowledgeInsights,
    applyFiledKnowledge,
    setActiveModel,
    setConversationResponsePrefs,
  } = useVenom();
  const [text, setText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [showTyping, setShowTyping] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [streamError, setStreamError] = useState<{ message: string; retryable: boolean } | null>(null);
  const [localStreamingMessage, setLocalStreamingMessage] =
    useState<Message | null>(null);
  // Transient multi-voice state for a deliberated turn; persisted messages
  // carry their own deliberation payload once the turn completes.
  const [localDeliberation, setLocalDeliberation] =
    useState<LocalDeliberation | null>(null);
  // Transient debate-round state: the roster, the turn currently streaming,
  // and voices that failed. Finished turns persist as ordinary messages.
  const [localDebate, setLocalDebate] = useState<LocalDebate | null>(null);
  // Live pad weights while a drag is in flight; null means show the stored
  // per-conversation blend.
  const [draftWeights, setDraftWeights] = useState<BlendWeights | null>(null);
  const [showCornerPicker, setShowCornerPicker] = useState(false);
  const [expandedTakeMessageIds, setExpandedTakeMessageIds] = useState<
    Set<string>
  >(() => new Set());
  const [voiceModeOpen, setVoiceModeOpen] = useState(false);
  const voiceButtonRef = useRef<React.ComponentRef<typeof TouchableOpacity>>(
    null,
  );

  // Model preferences from workspace state
  const modelPreferences = state.modelPreferences;
  const activeModelId = (modelPreferences?.activeModelId ?? "venom-gpt") as VenomModelId;
  const enabledModelIds = (modelPreferences?.enabledModelIds ?? ["venom-gpt"]) as VenomModelId[];

  const { activeWorkspace } = useSharedWorkspace();
  const queryClient = useQueryClient();

  const modelsQuery = useGetVenomModels({
    query: {
      queryKey: ["venom-models"],
      staleTime: 5 * 60 * 1000,
    },
  });

  // Deliberation availability; when the endpoint is missing or errors the
  // control simply stays hidden and chat behaves exactly as before.
  const deliberationQuery = useGetVenomDeliberation({
    query: {
      queryKey: ["venom-deliberation"],
      staleTime: 5 * 60 * 1000,
      retry: false,
    },
  });
  const deliberationAvailable = deliberationQuery.data?.available === true;

  const allModels: VenomManagedModel[] = modelsQuery.data ?? [];
  const enabledModels = allModels.filter((m) =>
    enabledModelIds.includes(m.id as VenomModelId),
  );
  const activeModel = allModels.find((m) => m.id === activeModelId) ?? null;

  const inputRef = useRef<TextInput>(null);
  const initializedRef = useRef(false);
  const activeUserIdRef = useRef<string | null>(userId ?? null);
  const activeRequestAbortRef = useRef<AbortController | null>(null);
  // Debate steering: messages the user sent mid-round (the next turns react
  // to them), which conversation the running debate belongs to, and whether
  // the user asked the round to stop.
  const pendingInterjectionsRef = useRef<string[]>([]);
  const debateConvIdRef = useRef<string | null>(null);
  const stopRequestedRef = useRef(false);

  useEffect(() => {
    activeUserIdRef.current = userId ?? null;
    return () => {
      if (activeUserIdRef.current === (userId ?? null)) {
        activeUserIdRef.current = null;
      }
      activeRequestAbortRef.current?.abort();
      activeRequestAbortRef.current = null;
    };
  }, [userId]);

  const activeConv = state.conversations.find(
    (c) => c.id === state.activeConversationId,
  );
  const contextMessages = activeConv?.messages || [];

  // Response mode is remembered per conversation; without the deliberation
  // endpoint everything is plain Talk and the controls stay hidden.
  const storedResponseMode = activeConv?.responseMode;
  const responseMode: VenomResponseMode =
    deliberationAvailable && isResponseMode(storedResponseMode)
      ? storedResponseMode
      : "talk";
  // Pad corners: enabled models that are actually available. With fewer than
  // three real providers, the deliberation personas fill the corners so the
  // pad always works; the control never shows models that are unavailable.
  const cornerCandidates = allModels.filter(
    (model) =>
      model.available && enabledModelIds.includes(model.id as VenomModelId),
  );
  const personaVoices = deliberationQuery.data?.voices;
  const storedBlend = normalizeConversationBlend(activeConv?.blend);
  let blendCorners: [BlendCorner, BlendCorner, BlendCorner] | null = null;
  let cornersPickable = false;
  if (cornerCandidates.length >= 3) {
    cornersPickable = cornerCandidates.length > 3;
    const candidateIds: string[] = cornerCandidates.map((model) => model.id);
    const storedCorners = storedBlend?.corners;
    const chosenIds =
      storedCorners && storedCorners.every((id) => candidateIds.includes(id))
        ? storedCorners
        : candidateIds.slice(0, 3);
    blendCorners = chosenIds.map((id) => ({
      id,
      name: cornerCandidates.find((model) => model.id === id)?.name ?? id,
    })) as [BlendCorner, BlendCorner, BlendCorner];
  } else if (personaVoices && personaVoices.length >= 3) {
    blendCorners = personaVoices
      .slice(0, 3)
      .map((voice) => ({ id: voice.voiceId, name: voice.name })) as [
      BlendCorner,
      BlendCorner,
      BlendCorner,
    ];
  }
  const storedWeights: BlendWeights =
    blendCorners &&
    storedBlend &&
    blendCorners.every(
      (corner, index) => storedBlend.corners[index] === corner.id,
    )
      ? (storedBlend.weights as BlendWeights)
      : EVEN_BLEND;
  const padWeights = draftWeights ?? storedWeights;

  const handleModeChange = (mode: VenomResponseMode) => {
    const convId = state.activeConversationId;
    if (!convId) return;
    setConversationResponsePrefs(convId, { responseMode: mode });
  };

  const commitBlend = (weights: BlendWeights) => {
    setDraftWeights(null);
    const convId = state.activeConversationId;
    if (!convId || !blendCorners) return;
    setConversationResponsePrefs(convId, {
      blend: {
        corners: blendCorners.map((corner) => corner.id),
        weights: [...weights],
      },
    });
  };

  // Stop ends the debate round cleanly: finished turns stay, the rest of the
  // round is cancelled, and any queued interjections stay ordinary messages.
  const handleStopDebate = () => {
    stopRequestedRef.current = true;
    pendingInterjectionsRef.current = [];
    activeRequestAbortRef.current?.abort();
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
  };

  // Swap a new model into the pad: it replaces the least-favored corner and
  // the weights reset to even, so the change reads predictably.
  const handleCornerPick = (modelId: string) => {
    const convId = state.activeConversationId;
    if (!convId || !blendCorners) return;
    const currentIds = blendCorners.map((corner) => corner.id);
    if (currentIds.includes(modelId)) return;
    let least = 0;
    for (let index = 1; index < 3; index += 1) {
      if (storedWeights[index] < storedWeights[least]) least = index;
    }
    const nextCorners = [...currentIds];
    nextCorners[least] = modelId;
    setConversationResponsePrefs(convId, {
      blend: { corners: nextCorners, weights: [...EVEN_BLEND] },
    });
  };
  const projectSources = (state.sources ?? []).filter(
    (source: ProjectSource) =>
      source.projectId === activeProject?.id && source.status === "connected",
  );
  const citationsById = new Map(
    projectSources.flatMap((source: ProjectSource) =>
      source.citations.map((citation) => [citation.id, citation] as const),
    ),
  );
  // A cited answer can lead back to the source it came from, so the reader can
  // check the rest of that source's evidence without leaving Venom.
  const sourceByCitationId = new Map(
    projectSources.flatMap((source: ProjectSource) =>
      source.citations.map((citation) => [citation.id, source] as const),
    ),
  );
  // Retired citations a refresh archived: answers written before the refresh
  // can still name (and open) the evidence they were based on.
  const archivedCitationsById = new Map(
    (state.archivedCitations ?? []).map(
      (archived) => [archived.id, archived] as const,
    ),
  );

  const displayMessages = localStreamingMessage
    ? [...contextMessages, localStreamingMessage]
    : contextMessages;

  const reversedMessages = [...displayMessages].reverse();

  // The session a first message lands in must belong to the project on screen,
  // which is the fallback project when nothing is explicitly selected.
  const onScreenProjectId: string | null =
    activeProject?.id ?? state.activeProjectId;

  useEffect(() => {
    if (isReady && !state.activeConversationId && !initializedRef.current) {
      initializedRef.current = true;
      const newId = createNewConversation(onScreenProjectId);
      setActiveConversation(newId);
    }
  }, [
    isReady,
    state.activeConversationId,
    createNewConversation,
    setActiveConversation,
    onScreenProjectId,
  ]);

  const BUILD_INTENT_REGEX = /^(?:create|build|make|generate|design)\s+(?:an?\s+)?(?:[\w-]+\s+){0,3}(app|application|website|site|brand|customer[- ]service(?:[- ]flow)?)\b/i;

  async function handleSend() {
    const trimmed = text.trim();
    const initiatingUserId = userId ?? null;
    if (!trimmed || !initiatingUserId) return;
    if (isStreaming) {
      // Mid-debate the composer stays open: the message lands in the thread
      // now and the following debater turns take it into account.
      if (
        localDebate &&
        debateConvIdRef.current &&
        debateConvIdRef.current === state.activeConversationId
      ) {
        setText("");
        addMessage(debateConvIdRef.current, {
          id: generateUniqueId(),
          role: "user",
          content: trimmed,
          status: "sent",
        });
        pendingInterjectionsRef.current.push(trimmed);
        if (Platform.OS !== "web") {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }
      }
      return;
    }

    const buildMatch = trimmed.match(BUILD_INTENT_REGEX);
    if (buildMatch) {
      const rawTargetType = buildMatch[1].toLowerCase().replace(/[- ]/g, "_");
      const targetType = rawTargetType.startsWith("customer")
        ? "customer_service_flow"
        : rawTargetType === "application"
          ? "app"
          : rawTargetType === "site"
            ? "website"
            : rawTargetType;
      const targetName = trimmed
        .match(/\b(?:called|named)\s+(.{1,120})$/i)?.[1]
        ?.trim();
      setText("");
      router.push({
        pathname: "/apps",
        params: {
          draftPrompt: trimmed,
          targetType,
          ...(targetName ? { targetName } : {}),
        },
      });
      return;
    }

    const initiatingProjectId = onScreenProjectId;
    let abortController = new AbortController();
    activeRequestAbortRef.current = abortController;
    // Capture the model being used at send time
    const sendingModelId = activeModelId;
    // Capture the shared-workspace selection at send time; the server
    // re-checks membership for every request.
    const sendingWorkspaceId = activeWorkspace?.id ?? null;
    // Mode and blend are captured at send time. Talk requests stay
    // byte-identical with today's chat: no mode key at all.
    const sendMode: VenomResponseMode = responseMode;
    const blendPayload =
      sendMode !== "talk" && blendCorners
        ? blendCorners.map((corner, index) => ({
            id: corner.id,
            weight: storedWeights[index],
          }))
        : null;
    stopRequestedRef.current = false;
    pendingInterjectionsRef.current = [];

    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    setText("");
    setStreamError(null);

    // Never append to a session that belongs to another project: the answer is
    // read as part of the project on screen, so that is where it has to be
    // filed.
    let targetConvId = state.activeConversationId;
    const targetConv = state.conversations.find(
      (conversation) => conversation.id === targetConvId,
    );
    if (!targetConvId || (targetConv?.projectId ?? null) !== onScreenProjectId) {
      targetConvId = createNewConversation(onScreenProjectId);
      setActiveConversation(targetConvId);
    }

    const userMessageId = generateUniqueId();
    addMessage(targetConvId, {
      id: userMessageId,
      role: "user",
      content: trimmed,
      status: "sent",
    });

    debateConvIdRef.current = sendMode === "debate" ? targetConvId : null;
    setIsStreaming(true);
    setShowTyping(true);

    let fullContent = "";
    let requestFailed = false;
    let streamCompleted = false;
    let hasReceivedFirstChunk = false;
    let requestToken: string | null = null;
    const streamId = generateUniqueId();
    // Metadata extracted from the SSE stream
    let streamModelId: VenomModelId | null = null;
    let streamModelName: string | null = null;
    // Deliberation accumulators (only used when this turn opted in)
    let deliberationRoster: DeliberationRosterVoice[] | null = null;
    let deliberationTakes: Record<string, DeliberationTakeState> = {};
    let deliberationStage: "voices" | "synthesis" = "voices";
    let finalDeliberation: VenomMessageDeliberation | null = null;
    const syncDeliberation = () => {
      if (!deliberationRoster) return;
      setLocalDeliberation({
        roster: deliberationRoster,
        stage: deliberationStage,
        takes: Object.fromEntries(
          Object.entries(deliberationTakes).map(([voiceId, take]) => [
            voiceId,
            { ...take },
          ]),
        ),
      });
    };
    // Debate accumulators (only used when this turn runs a debate round).
    let debateRoster: DeliberationRosterVoice[] | null = null;
    let debatePlannedTurns = 0;
    let currentDebateTurn: DebateTurnLive | null = null;
    const debateFailedNames: string[] = [];
    let restartRound = false;
    const syncDebate = () => {
      if (!debateRoster) return;
      setLocalDebate({
        roster: debateRoster,
        of: debatePlannedTurns,
        current: currentDebateTurn ? { ...currentDebateTurn } : null,
        failedNames: [...debateFailedNames],
      });
    };

    try {
      const domain = process.env.EXPO_PUBLIC_DOMAIN;
      if (!domain) throw new Error("API domain is unavailable");
      const token = IS_UI_TEST ? UI_TEST_CHAT_TOKEN : await getToken();
      if (
        !token ||
        activeUserIdRef.current !== initiatingUserId ||
        abortController.signal.aborted
      ) {
        throw new Error("Authentication session changed");
      }
      requestToken = token;
      const baseUrl = `https://${domain}`;
      const chatHistory = [
        ...contextMessages
          .slice(-23)
          .map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: trimmed },
      ];
      const {
        context: projectContext,
        citationIds: sourceCitationIds,
        sourceSnapshots,
      } = buildChatProjectContextBundle({
        projectName: activeProject?.name,
        projectDescription: activeProject?.description,
        sources: projectSources,
      });

      // Debate rounds restart when the user interjects between turns: the
      // history the next round continues from accumulates the persisted
      // turns and the user's new messages.
      const debateHistory = [...chatHistory];

      roundLoop: while (true) {
      streamCompleted = false;
      restartRound = false;

      const response = await fetch(`${baseUrl}/api/venom/respond`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          messages: debateHistory.slice(-24),
          projectId: initiatingProjectId,
          modelId: sendingModelId,
          projectContext,
          sourceCitationIds,
          sourceSnapshots,
          // The server re-checks membership on every call, so a stale
          // selection cannot leak workspace content.
          ...(sendingWorkspaceId ? { workspaceId: sendingWorkspaceId } : {}),
          // Talk stays exactly today's request; Verify and Debate declare
          // themselves and carry the blend when the pad is present.
          ...(sendMode !== "talk" ? { mode: sendMode } : {}),
          ...(sendMode !== "talk" && blendPayload
            ? { blend: blendPayload }
            : {}),
        }),
        signal: abortController.signal,
      });

      if (activeUserIdRef.current !== initiatingUserId) return;

      if (!response.ok) {
        const isRateLimit = response.status === 429;
        const isProviderError = response.status === 502;
        let errMsg = "The request failed. Please try again.";
        if (isRateLimit) errMsg = "Rate limit reached. Please wait a moment before sending again.";
        if (isProviderError) errMsg = "The selected model provider is temporarily unavailable. Try a different model or retry shortly.";
        if (response.status === 403) {
          try {
            const body = (await response.json()) as { code?: string; error?: string };
            if (body?.code === WORKSPACE_ACCESS_DENIED_CODE) {
              // Membership ended between selecting the workspace and sending:
              // evict cached workspace content and fall back to personal.
              notifyWorkspaceAccessLost();
              errMsg = body.error ?? "You no longer have access to that shared workspace.";
            }
          } catch {
            // not JSON – keep the generic message
          }
        }
        throw Object.assign(new Error(errMsg), { retryable: true, httpStatus: response.status });
      }

      const reader = response.body?.getReader();
      if (!reader) throw Object.assign(new Error("No response stream received."), { retryable: true });

      const decoder = new TextDecoder();
      let buffer = "";
      const processSseLine = (line: string) => {
        if (!line.startsWith("data: ")) return;
        const data = line.slice(6);
        if (data === "[DONE]") {
          streamCompleted = true;
          return;
        }

        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            const isRetryable = parsed.retryable !== false;
            throw Object.assign(new Error(parsed.error as string), {
              retryable: isRetryable,
            });
          }
          if (parsed.done === true) {
            streamCompleted = true;
            return;
          }
          // Debate events: roster metadata, per-turn markers, and per-turn
          // chunks. Consume them before the generic content branch so debate
          // text never leaks into a single answer bubble.
          if (parsed.debate?.voices && Array.isArray(parsed.debate.voices)) {
            debateRoster = parsed.debate.voices as DeliberationRosterVoice[];
            debatePlannedTurns =
              typeof parsed.debate.turns === "number"
                ? parsed.debate.turns
                : debateRoster.length;
            setShowTyping(false);
            syncDebate();
            return;
          }
          if (parsed.debateTurn) {
            currentDebateTurn = {
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
              debatePlannedTurns = parsed.debateTurn.of;
            }
            syncDebate();
            return;
          }
          if (typeof parsed.turn === "number" && debateRoster) {
            const turn = currentDebateTurn;
            if (parsed.turnStatus === "ok" || parsed.turnStatus === "failed") {
              if (turn && parsed.turnStatus === "ok" && turn.content.trim()) {
                // Persist the finished turn immediately so it survives a
                // stop or reload and syncs to other devices as a normal
                // attributed assistant message.
                const persistedContent = turn.content.trim();
                addMessage(targetConvId, {
                  id: generateUniqueId(),
                  role: "assistant",
                  content: persistedContent,
                  status: "sent",
                  ...(turn.modelId
                    ? {
                        modelId: turn.modelId as ApiVenomModelId,
                        ...(turn.modelName
                          ? { modelName: turn.modelName }
                          : {}),
                      }
                    : {}),
                  speakerId: turn.voiceId.slice(0, 64),
                  speakerName: turn.name.slice(0, 80),
                });
                debateHistory.push({
                  role: "assistant",
                  content: persistedContent,
                });
              } else if (turn) {
                // A failed voice doesn't kill the round; the debate carries
                // on and the miss is noted in the live panel.
                debateFailedNames.push(turn.name);
              }
              currentDebateTurn = null;
              syncDebate();
              // Between turns is where user interjections take effect.
              if (pendingInterjectionsRef.current.length > 0) {
                restartRound = true;
              }
            } else if (turn && parsed.content && parsed.turn === turn.index) {
              turn.content += parsed.content;
              syncDebate();
            }
            return;
          }
          // Deliberation events: roster metadata (no disagreements yet), the
          // final persisted summary, stage moves, and per-voice chunks.
          if (parsed.deliberation?.voices) {
            if (Array.isArray(parsed.deliberation.disagreements)) {
              finalDeliberation = {
                voices: parsed.deliberation.voices,
                disagreements: parsed.deliberation.disagreements,
              } as VenomMessageDeliberation;
              for (const take of finalDeliberation.voices) {
                deliberationTakes[take.voiceId] = {
                  content: take.content,
                  status: take.status === "failed" ? "failed" : "ok",
                };
              }
              syncDeliberation();
            } else {
              deliberationRoster =
                parsed.deliberation.voices as DeliberationRosterVoice[];
              deliberationTakes = Object.fromEntries(
                deliberationRoster.map((voice) => [
                  voice.voiceId,
                  { content: "", status: "streaming" as const },
                ]),
              );
              deliberationStage = "voices";
              setShowTyping(false);
              syncDeliberation();
            }
          }
          if (parsed.stage === "synthesis" && deliberationRoster) {
            deliberationStage = "synthesis";
            syncDeliberation();
          }
          if (typeof parsed.voice === "string") {
            // Voice chunks feed the transient panel, never the main answer.
            const take = deliberationTakes[parsed.voice] ?? {
              content: "",
              status: "streaming" as const,
            };
            deliberationTakes[parsed.voice] = take;
            if (parsed.content) take.content += parsed.content;
            if (parsed.voiceStatus === "ok" || parsed.voiceStatus === "failed") {
              take.status = parsed.voiceStatus;
            }
            syncDeliberation();
            return;
          }
          if (parsed.modelId && typeof parsed.modelId === "string") {
            streamModelId = parsed.modelId as VenomModelId;
          }
          if (parsed.modelName && typeof parsed.modelName === "string") {
            streamModelName = parsed.modelName as string;
          }
          if (parsed.content) {
            fullContent += parsed.content;

            if (!hasReceivedFirstChunk) {
              setShowTyping(false);
              hasReceivedFirstChunk = true;
            }

            setLocalStreamingMessage({
              id: streamId,
              role: "assistant",
              content: fullContent,
              createdAt: Date.now(),
              status: "sending",
            });
          }
        } catch (error) {
          // Re-throw structured errors; malformed events fail via the missing
          // completion marker rather than becoming completed messages.
          if (
            error instanceof Error &&
            (error as { retryable?: boolean }).retryable !== undefined
          ) {
            throw error;
          }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (buffer) processSseLine(buffer.replace(/\r$/, ""));
          break;
        }
        if (activeUserIdRef.current !== initiatingUserId) {
          await reader.cancel();
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          processSseLine(line.replace(/\r$/, ""));
        }

        if (restartRound) {
          // An interjection is waiting: stop reading this round and start a
          // fresh one that carries the new user message.
          await reader.cancel();
          try {
            abortController.abort();
          } catch {
            // Closing an already-finished stream is fine.
          }
          break;
        }
      }

      if (
        sendMode === "debate" &&
        pendingInterjectionsRef.current.length > 0 &&
        !stopRequestedRef.current &&
        activeUserIdRef.current === initiatingUserId
      ) {
        const interjections = pendingInterjectionsRef.current.splice(0);
        for (const interjection of interjections) {
          debateHistory.push({ role: "user", content: interjection });
        }
        currentDebateTurn = null;
        syncDebate();
        abortController = new AbortController();
        activeRequestAbortRef.current = abortController;
        continue roundLoop;
      }
      break;
      }

      if (!streamCompleted && !stopRequestedRef.current) {
        throw Object.assign(
          new Error("The response was interrupted. Please try again."),
          { retryable: true },
        );
      }
    } catch (error) {
      if (activeUserIdRef.current !== initiatingUserId) return;
      // A user-requested stop ends the round cleanly: turns that finished
      // stay in the thread, the half-spoken one is discarded, no error.
      if (stopRequestedRef.current) {
        fullContent = "";
        requestFailed = false;
        setShowTyping(false);
      } else {
        console.error(error);
        requestFailed = true;
        const isRetryable = (error as any)?.retryable !== false;
        const errMessage =
          error instanceof Error
            ? error.message
            : "I lost connection to the server. Please try again.";
        setShowTyping(false);
        setStreamError({ message: errMessage, retryable: isRetryable });
        setLocalStreamingMessage({
          id: streamId,
          role: "assistant",
          content: errMessage,
          createdAt: Date.now(),
          status: "error",
        });
        fullContent = errMessage;
      }
    } finally {
      if (activeUserIdRef.current !== initiatingUserId) return;
      if (activeRequestAbortRef.current === abortController) {
        activeRequestAbortRef.current = null;
      }
      setIsStreaming(false);
      setShowTyping(false);

      // A deliberated turn persists its takes and disagreements alongside the
      // collective answer; if the final summary event never arrived, fall
      // back to what accumulated while streaming.
      // Snapshot the closure-written accumulators: TS flow analysis cannot
      // see the assignments made inside processSseLine.
      const finalSnapshot = finalDeliberation as VenomMessageDeliberation | null;
      const rosterSnapshot = deliberationRoster as
        | DeliberationRosterVoice[]
        | null;
      const persistedDeliberation: VenomMessageDeliberation | null =
        finalSnapshot ??
        (rosterSnapshot
          ? ({
              voices: rosterSnapshot.map((voice) => {
                const take = deliberationTakes[voice.voiceId];
                return {
                  voiceId: voice.voiceId,
                  name: voice.name,
                  ...(voice.modelId ? { modelId: voice.modelId } : {}),
                  ...(voice.modelName ? { modelName: voice.modelName } : {}),
                  content: (take?.content ?? "").slice(0, 8000),
                  status:
                    take?.status === "failed"
                      ? ("failed" as const)
                      : ("ok" as const),
                };
              }),
              disagreements: [],
            } as VenomMessageDeliberation)
          : null);

      if (fullContent) {
        addMessage(targetConvId, {
          id: streamId,
          role: "assistant",
          content: fullContent,
          status: requestFailed ? "error" : "sent",
          // Persist model attribution on successfully completed messages
          ...((!requestFailed && (streamModelId ?? sendingModelId)) ? {
            modelId: (streamModelId ?? sendingModelId) as ApiVenomModelId,
            modelName: streamModelName ?? activeModel?.name ?? undefined,
          } : {}),
          ...(!requestFailed && persistedDeliberation
            ? { deliberation: persistedDeliberation }
            : {}),
        });
      }
      setLocalStreamingMessage(null);
      setLocalDeliberation(null);
      setLocalDebate(null);
      debateConvIdRef.current = null;
      pendingInterjectionsRef.current = [];
      stopRequestedRef.current = false;

      // Debate turns persist as they finish and skip knowledge extraction:
      // the exchange is argument, not settled knowledge to absorb.
      if (
        sendMode !== "debate" &&
        fullContent &&
        !requestFailed &&
        requestToken
      ) {
        const conversation = state.conversations.find(
          (item) => item.id === targetConvId,
        );
        const conversationTitle =
          conversation?.title === "New Session"
            ? `${trimmed.slice(0, 30)}...`
            : (conversation?.title ?? "New Session");

        void extractVenomKnowledge(
          {
            // Ask the server to file the insights straight into the ontology
            // store; `filed` in the response carries the canonical records.
            file: true,
            ...(sendingWorkspaceId ? { workspaceId: sendingWorkspaceId } : {}),
            conversation: {
              id: targetConvId,
              title: conversationTitle,
              projectId: initiatingProjectId,
            },
            messages: [
              ...contextMessages.slice(-46).map((message) => ({
                id: message.id,
                role: message.role,
                content: message.content.slice(0, 8000),
              })),
              {
                id: userMessageId,
                role: "user",
                content: trimmed,
              },
              {
                id: streamId,
                role: "assistant",
                content: fullContent.slice(0, 8000),
              },
            ],
          },
          { headers: { Authorization: `Bearer ${requestToken}` } },
        )
          .then((result) => {
            if (activeUserIdRef.current !== initiatingUserId) return;
            const conversationRef = {
              id: targetConvId,
              title: conversationTitle,
              projectId: initiatingProjectId,
            };
            if (result.filedWorkspaceId) {
              // Filed into the shared workspace store server-side. Never
              // mirror it into the synced personal snapshot — shared content
              // must stay evictable — just refresh the cached copy.
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
          })
          .catch((extractionError: unknown) => {
            // Chat remains usable when background extraction is unavailable —
            // but a workspace-access denial must still evict caches.
            const status = (extractionError as { status?: number } | null)?.status;
            const code = (extractionError as { data?: { code?: string } } | null)
              ?.data?.code;
            if (status === 403 && code === WORKSPACE_ACCESS_DENIED_CODE) {
              notifyWorkspaceAccessLost();
            }
          });
      }

      if (isActive && Platform.OS !== "web") {
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    }
  }

  // Shared renderer for assistant text: citation markers resolve to source
  // references (live links or archived labels), never raw [source:id] tags.
  const renderSegments = (
    segments: ReturnType<typeof messageCitationSegments>,
    keyPrefix: string,
  ) =>
    segments.map((segment, index) => {
      if (segment.kind === "text") return segment.text;
      if (segment.kind === "citation") {
        return (
          <Text
            key={`${keyPrefix}-${segment.citation.id}-${index}`}
            onPress={() => Linking.openURL(segment.citation.url)}
            accessibilityRole="link"
            accessibilityLabel={`Open source: ${segment.citation.title}`}
            style={[styles.citationLink, { color: colors.primary }]}
          >
            {segment.citation.title}
          </Text>
        );
      }
      const archived = segment.archived;
      if (archived && archived.url) {
        return (
          <Text
            key={`${keyPrefix}-${segment.citationId}-${index}`}
            onPress={() => Linking.openURL(archived.url)}
            accessibilityRole="link"
            accessibilityLabel={`Open archived source, no longer connected: ${archived.title}`}
            style={[
              styles.citationArchivedLink,
              { color: colors.mutedForeground },
            ]}
          >
            {segment.label}
          </Text>
        );
      }
      return (
        <Text
          key={`${keyPrefix}-${segment.citationId}-${index}`}
          accessibilityLabel={
            archived
              ? `Archived source, no longer connected: ${archived.title}`
              : "Archived source, no longer connected"
          }
          style={[
            styles.citationArchived,
            { color: colors.mutedForeground },
          ]}
        >
          {segment.label}
        </Text>
      );
    });

  const renderCitationText = (content: string, keyPrefix: string) =>
    renderSegments(
      messageCitationSegments(content, citationsById, archivedCitationsById),
      keyPrefix,
    );

  const toggleTakes = (messageId: string) => {
    setExpandedTakeMessageIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  };

  const renderMessage = ({ item }: { item: Message }) => {
    const isUser = item.role === "user";
    const isError = item.status === "error";
    const segments = isUser
      ? []
      : messageCitationSegments(
          item.content,
          citationsById,
          archivedCitationsById,
        );
    // The connected sources this answer cited, in the order they appear, so the
    // reader can open one and read the rest of the evidence it carries.
    const citedSources: ProjectSource[] = [];
    for (const segment of segments) {
      if (segment.kind !== "citation") continue;
      const source = sourceByCitationId.get(segment.citation.id);
      if (!source || citedSources.some((entry) => entry.id === source.id)) {
        continue;
      }
      citedSources.push(source);
    }
    const content = !isUser
      ? renderSegments(segments, item.id)
      : item.content;

    const deliberation = !isUser && !isError ? item.deliberation : undefined;
    const takesExpanded = deliberation
      ? expandedTakeMessageIds.has(item.id)
      : false;
    const deliberationOkCount = deliberation
      ? deliberation.voices.filter((take) => take.status === "ok").length
      : 0;
    const deliberationShowModels = deliberation
      ? new Set(
          deliberation.voices
            .filter((take) => take.status === "ok")
            .map((take) => take.modelId)
            .filter(Boolean),
        ).size > 1
      : false;

    // Debate turns carry their own speaker chip above the bubble, so the
    // trailing model attribution is suppressed for them.
    const speakerName = !isUser ? item.speakerName : undefined;
    const speakerModelLabel =
      speakerName && item.modelName && item.modelName !== speakerName
        ? item.modelName
        : null;
    const modelLabel = !isUser && !speakerName && item.modelName
      ? item.modelName
      : !isUser && !speakerName && item.modelId
        ? item.modelId
        : null;

    return (
      <View
        style={[
          styles.messageRow,
          isUser ? styles.messageUser : styles.messageAssistant,
        ]}
      >
        <View style={styles.messageWrap}>
          {speakerName && (
            <View style={styles.speakerChip} testID="chip-speaker">
              <View
                style={[
                  styles.speakerDot,
                  { backgroundColor: colors.foreground },
                ]}
              />
              <Text
                style={[styles.speakerName, { color: colors.foreground }]}
                numberOfLines={1}
              >
                {speakerName}
              </Text>
              {speakerModelLabel && (
                <Text
                  style={[
                    styles.speakerModel,
                    { color: colors.mutedForeground },
                  ]}
                  numberOfLines={1}
                >
                  {` · ${speakerModelLabel}`}
                </Text>
              )}
            </View>
          )}
          <View
            style={[
              styles.messageBubble,
              isUser
                ? [styles.bubbleUser, { backgroundColor: colors.secondary }]
                : styles.bubbleAssistant,
              isError && {
                borderColor: colors.destructive,
                borderWidth: 1,
              },
            ]}
          >
            {isError && (
              <View style={styles.errorBadge}>
                <Feather name="alert-circle" size={12} color={colors.destructive} />
                <Text style={[styles.errorBadgeText, { color: colors.destructive }]}>
                  {streamError?.retryable !== false ? "Tap send to retry" : "Error"}
                </Text>
              </View>
            )}
            <Text
              testID={isUser ? "chat-message-user" : "chat-message-assistant"}
              style={[
                styles.messageText,
                { color: colors.foreground },
              ]}
            >
              {content}
            </Text>
          </View>
          {deliberation && (
            <View style={styles.deliberationResult} testID="deliberation-result">
              {deliberation.disagreements.length > 0 ? (
                <View
                  style={[
                    styles.deliberationDisagreements,
                    { borderColor: colors.border, backgroundColor: colors.card },
                  ]}
                  testID="deliberation-disagreements"
                >
                  <View style={styles.deliberationDisagreeHeader}>
                    <Feather
                      name="git-branch"
                      size={12}
                      color={colors.foreground}
                    />
                    <Text
                      style={[
                        styles.deliberationDisagreeTitle,
                        { color: colors.foreground },
                      ]}
                    >
                      Where the voices split
                    </Text>
                  </View>
                  {deliberation.disagreements.map((note, index) => (
                    <View key={index} style={styles.deliberationDisagreeItem}>
                      <View
                        style={[
                          styles.deliberationDisagreeBullet,
                          { backgroundColor: colors.mutedForeground },
                        ]}
                      />
                      <Text
                        style={[
                          styles.deliberationDisagreeText,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        {renderCitationText(note, `${item.id}-dis-${index}`)}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : (
                <Text
                  style={[
                    styles.deliberationAgreement,
                    { color: colors.mutedForeground },
                  ]}
                  testID="deliberation-agreement"
                >
                  The voices converged without real disagreement.
                </Text>
              )}
              <TouchableOpacity
                onPress={() => toggleTakes(item.id)}
                style={styles.deliberationToggle}
                accessibilityRole="button"
                accessibilityState={{ expanded: takesExpanded }}
                accessibilityLabel={
                  takesExpanded ? "Hide the voice takes" : "Show the voice takes"
                }
                testID="toggle-deliberation-takes"
              >
                <Feather
                  name={takesExpanded ? "chevron-up" : "chevron-down"}
                  size={13}
                  color={colors.mutedForeground}
                />
                <Text
                  style={[
                    styles.deliberationToggleText,
                    { color: colors.mutedForeground },
                  ]}
                >
                  {takesExpanded
                    ? "Hide the takes"
                    : `Read the takes (${deliberationOkCount})`}
                </Text>
              </TouchableOpacity>
              {takesExpanded &&
                deliberation.voices.map((take) => (
                  <View
                    key={take.voiceId}
                    style={[
                      styles.deliberationTakeCard,
                      { borderColor: colors.border },
                    ]}
                    testID={`deliberation-take-${take.voiceId}`}
                  >
                    <View style={styles.deliberationVoiceHeader}>
                      <Text
                        style={[
                          styles.deliberationVoiceName,
                          { color: colors.foreground },
                        ]}
                        numberOfLines={1}
                      >
                        {take.name}
                      </Text>
                      {deliberationShowModels && take.modelName ? (
                        <Text
                          style={[
                            styles.deliberationVoiceModel,
                            { color: colors.mutedForeground },
                          ]}
                          numberOfLines={1}
                        >
                          {take.modelName}
                        </Text>
                      ) : null}
                    </View>
                    {take.status === "failed" ? (
                      <Text
                        style={[
                          styles.deliberationTakeText,
                          { color: colors.mutedForeground, opacity: 0.8 },
                        ]}
                      >
                        This voice didn't finish its take.
                      </Text>
                    ) : (
                      <Text
                        style={[
                          styles.deliberationTakeText,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        {renderCitationText(
                          take.content,
                          `${item.id}-take-${take.voiceId}`,
                        )}
                      </Text>
                    )}
                  </View>
                ))}
            </View>
          )}
          {citedSources.length > 0 && !isError && (
            <View style={styles.citedSourceRow}>
              {citedSources.map((source) => (
                <TouchableOpacity
                  key={source.id}
                  style={[
                    styles.citedSourceChip,
                    {
                      borderColor: colors.border,
                      backgroundColor: colors.card,
                    },
                  ]}
                  onPress={() =>
                    router.push({
                      pathname: "/knowledge",
                      params: { view: "sources", source: source.id },
                    })
                  }
                  accessibilityRole="button"
                  accessibilityLabel={`Show all ${source.citations.length} citation${
                    source.citations.length === 1 ? "" : "s"
                  } from ${source.name} in Venom`}
                  testID={`chat-open-source-${source.id}`}
                  activeOpacity={0.8}
                >
                  <Feather
                    name={source.provider === "github" ? "github" : "globe"}
                    size={11}
                    color={colors.primary}
                  />
                  <Text
                    style={[
                      styles.citedSourceChipText,
                      { color: colors.foreground },
                    ]}
                    numberOfLines={1}
                  >
                    {source.name}
                  </Text>
                  <Text
                    style={[
                      styles.citedSourceChipMeta,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    {`${source.citations.length} citation${
                      source.citations.length === 1 ? "" : "s"
                    }`}
                  </Text>
                  <Feather
                    name="arrow-up-right"
                    size={11}
                    color={colors.mutedForeground}
                  />
                </TouchableOpacity>
              ))}
            </View>
          )}
          {modelLabel && !isUser && !isError && (
            <Text
              style={[styles.messageAttribution, { color: colors.mutedForeground }]}
              numberOfLines={1}
            >
              {modelLabel}
            </Text>
          )}
        </View>
      </View>
    );
  };

  return (
    <View style={styles.workspaceContainer}>
      <FlatList
        style={styles.chatList}
        data={reversedMessages}
        keyExtractor={(item) => item.id}
        renderItem={renderMessage}
        inverted={reversedMessages.length > 0}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: 24, flexGrow: 1 },
        ]}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        scrollEnabled={reversedMessages.length > 0}
        ListHeaderComponent={
          localDebate ? (
            <DebateStreamCard
              debate={localDebate}
              colors={colors}
              renderContent={renderCitationText}
            />
          ) : localDeliberation ? (
            <DeliberationStreamCard
              deliberation={localDeliberation}
              colors={colors}
              renderContent={renderCitationText}
            />
          ) : showTyping ? (
            <View style={styles.typingContainer}>
              <ActivityIndicator size="small" color={colors.primary} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          !isStreaming && reversedMessages.length === 0 ? (
            <View style={styles.emptyContainer}>
              <View
                style={[
                  styles.emptyAvatar,
                  { backgroundColor: colors.secondary },
                ]}
              >
                <Feather name="zap" size={24} color={colors.primary} />
              </View>
              <Text style={[styles.emptyText, { color: colors.foreground }]}>
                How can I help?
              </Text>
              <Text
                style={[styles.emptySubtext, { color: colors.mutedForeground }]}
              >
                Ask anything about the project.
              </Text>
            </View>
          ) : null
        }
      />

      <View
        style={[
          styles.inputContainer,
          {
            backgroundColor: colors.background,
            paddingBottom: Math.max(
              insets.bottom,
              Platform.OS === "web" ? 34 : 16,
            ),
          },
        ]}
      >
        {/* Response mode: Talk / Verify / Debate, remembered per session. */}
        {deliberationAvailable && (
          <View style={styles.modeSwitchRow}>
            <ResponseModeSwitch
              mode={responseMode}
              onChange={handleModeChange}
              disabled={isStreaming}
            />
          </View>
        )}
        {/* Blend pad: who carries the exchange in Verify and Debate. */}
        {deliberationAvailable && responseMode !== "talk" && blendCorners && (
          <View style={styles.blendSection}>
            <BlendPad
              corners={blendCorners}
              weights={padWeights}
              onChange={(weights) => setDraftWeights(weights)}
              onCommit={commitBlend}
              disabled={isStreaming}
            />
            {cornersPickable && (
              <TouchableOpacity
                onPress={() => {
                  setShowCornerPicker((value) => !value);
                  if (Platform.OS !== "web") {
                    Haptics.selectionAsync();
                  }
                }}
                accessibilityRole="button"
                accessibilityState={{ expanded: showCornerPicker }}
                accessibilityLabel="Choose which three models take the corners"
                testID="button-blend-corners"
                hitSlop={6}
                style={styles.cornerPickerToggle}
              >
                <Text
                  style={[
                    styles.cornerPickerToggleText,
                    { color: colors.mutedForeground },
                  ]}
                >
                  {showCornerPicker
                    ? "Done choosing voices"
                    : "Choose the three voices"}
                </Text>
              </TouchableOpacity>
            )}
            {cornersPickable && showCornerPicker && (
              <View style={styles.cornerPickerRow} testID="blend-corner-picker">
                {cornerCandidates.map((model) => {
                  const inCorners = blendCorners.some(
                    (corner) => corner.id === model.id,
                  );
                  return (
                    <TouchableOpacity
                      key={model.id}
                      onPress={() => handleCornerPick(model.id)}
                      disabled={inCorners}
                      style={[
                        styles.cornerPickChip,
                        {
                          borderColor: inCorners
                            ? colors.foreground
                            : colors.border,
                          backgroundColor: inCorners
                            ? colors.foreground
                            : colors.card,
                        },
                      ]}
                      accessibilityRole="button"
                      accessibilityState={{ selected: inCorners }}
                      accessibilityLabel={
                        inCorners
                          ? `${model.name} holds a corner`
                          : `Give ${model.name} a corner`
                      }
                      testID={`button-corner-pick-${model.id}`}
                      hitSlop={4}
                    >
                      <Text
                        style={[
                          styles.cornerPickChipText,
                          {
                            color: inCorners
                              ? colors.background
                              : colors.mutedForeground,
                          },
                        ]}
                      >
                        {model.name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </View>
        )}
        {/* Shared-workspace indicator: answers may draw on team knowledge */}
        {activeWorkspace && (
          <View style={styles.workspaceChipRow}>
            <View
              style={[
                styles.workspaceChip,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
              accessibilityLabel={`Chatting with shared knowledge from ${activeWorkspace.name}`}
              testID="chip-shared-space"
            >
              <Feather name="users" size={11} color={colors.mutedForeground} />
              <Text
                style={[styles.workspaceChipText, { color: colors.mutedForeground }]}
                numberOfLines={1}
              >
                {activeWorkspace.name}
              </Text>
            </View>
          </View>
        )}

        {/* Model selector row */}
        {enabledModels.length > 1 && (
          <View style={styles.modelSelectorRow}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.modelSelectorScroll}
            >
              {enabledModels.map((model) => {
                const isSelected = model.id === activeModelId;
                return (
                  <TouchableOpacity
                    key={model.id}
                    onPress={() => {
                      setActiveModel(model.id as VenomModelId);
                      setShowModelPicker(false);
                    }}
                    style={[
                      styles.modelChip,
                      {
                        backgroundColor: isSelected ? colors.primary : colors.card,
                        borderColor: isSelected ? colors.primary : colors.border,
                      },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={`Use ${model.name}`}
                    accessibilityState={{ selected: isSelected }}
                    testID={`select-model-${model.id}`}
                  >
                    <Text
                      style={[
                        styles.modelChipText,
                        {
                          color: isSelected
                            ? colors.primaryForeground
                            : colors.mutedForeground,
                        },
                      ]}
                    >
                      {model.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        )}

        <VoiceModeOverlay
          visible={voiceModeOpen}
          activeProject={activeProject}
          onClose={() => {
            setVoiceModeOpen(false);
            // An animated modal's focus trap can strand focus while closing;
            // hand it back to the launcher explicitly (web only).
            if (Platform.OS === "web") {
              setTimeout(() => {
                (
                  voiceButtonRef.current as unknown as {
                    focus?: () => void;
                  } | null
                )?.focus?.();
              }, 80);
            }
          }}
        />

        <View
          style={[
            styles.inputWrapper,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <TextInput
            ref={inputRef}
            testID="chat-input"
            accessibilityLabel="Message Venom"
            style={[styles.input, { color: colors.foreground }]}
            placeholder={
              localDebate && isStreaming ? "Join the debate..." : "Message..."
            }
            placeholderTextColor={colors.mutedForeground}
            value={text}
            onChangeText={setText}
            multiline
            maxLength={1000}
            blurOnSubmit={false}
          />
          {localDebate && isStreaming && (
            <TouchableOpacity
              style={[styles.stopButton, { borderColor: colors.border }]}
              onPress={handleStopDebate}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Stop the debate after this turn"
              testID="stop-debate"
            >
              <View
                style={[
                  styles.stopButtonSquare,
                  { backgroundColor: colors.foreground },
                ]}
              />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            ref={voiceButtonRef}
            style={[
              styles.voiceButton,
              { borderColor: colors.border, backgroundColor: colors.card },
            ]}
            onPress={() => setVoiceModeOpen(true)}
            disabled={isStreaming}
            hitSlop={12}
            testID="open-voice-mode"
            accessibilityRole="button"
            accessibilityLabel="Start a voice conversation"
          >
            <Feather name="mic" size={16} color={colors.foreground} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.sendButton,
              {
                backgroundColor: text.trim()
                  ? colors.primary
                  : colors.secondary,
              },
            ]}
            onPress={handleSend}
            disabled={!text.trim() || (isStreaming && !localDebate)}
            hitSlop={12}
            testID="send-message-button"
            accessibilityRole="button"
            accessibilityLabel={
              localDebate && isStreaming
                ? "Send a message into the debate"
                : "Send message"
            }
          >
            <Feather
              name="arrow-up"
              size={18}
              color={
                text.trim() ? colors.primaryForeground : colors.mutedForeground
              }
            />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

type GraphPoint = { x: number; y: number };

type GraphCamera = { yaw: number; pitch: number; zoom: number };
type GraphConnection = {
  id: string;
  from: KnowledgeCluster;
  to: KnowledgeCluster;
  index: number;
};

const MAX_LIVE_CONNECTIONS = 48;

const DEFAULT_GRAPH_CAMERA: GraphCamera = { yaw: 0, pitch: 0, zoom: 1 };
function SymbioteTendrilSegment({
  from,
  to,
  index,
  breath,
  reduceMotion,
  opacity,
}: {
  from: GraphPoint;
  to: GraphPoint;
  index: number;
  breath: SharedValue<number>;
  reduceMotion: boolean;
  opacity: number;
}) {
  const colors = useColors();
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const thickness =
    (2.4 + (index % 3) * 0.55) *
    clampGraphValue(opacity + 0.25, 0.55, 1.2);
  const left = (from.x + to.x) / 2 - length / 2;
  const top = (from.y + to.y) / 2 - thickness / 2;

  const flowStyle = useAnimatedStyle(() => {
    if (reduceMotion) {
      return { transform: [{ translateX: 0 }], opacity: 0.62 };
    }
    return {
      transform: [
        {
          translateX: Math.sin(breath.value * Math.PI * 2 + index * 0.85) * 10,
        },
      ],
      opacity:
        0.4 + ((Math.sin(breath.value * Math.PI * 2 + index) + 1) / 2) * 0.55,
    };
  });

  return (
    <View
      pointerEvents="none"
      style={[
        styles.tendrilSegment,
        {
          left,
          top,
          width: length,
          height: thickness,
          borderRadius: thickness,
          backgroundColor: colors.symbioteSoft,
          borderColor: colors.symbioteSoft,
          shadowColor: colors.symbioteHighlight,
          opacity,
          transform: [{ rotate: `${angle}deg` }],
        },
      ]}
    >
      <View
        style={[
          styles.tendrilHighlight,
          {
            backgroundColor: colors.symbioteHighlight,
          },
        ]}
      />
      <Animated.View
        style={[
          styles.tendrilFlow,
          {
            backgroundColor: colors.symbioteHighlight,
            left: `${28 + (index % 3) * 18}%`,
          },
          flowStyle,
        ]}
      />
    </View>
  );
}

function SymbioteConnection({
  from,
  to,
  index,
  breath,
  reduceMotion,
  opacity,
}: {
  from: GraphPoint;
  to: GraphPoint;
  index: number;
  breath: SharedValue<number>;
  reduceMotion: boolean;
  opacity: number;
}) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
  const bend = ((index % 5) - 2) * 10;
  const control = {
    x: (from.x + to.x) / 2 + (-dy / length) * bend,
    y: (from.y + to.y) / 2 + (dx / length) * bend,
  };

  return (
    <>
      <SymbioteTendrilSegment
        from={from}
        to={control}
        index={index * 2}
        breath={breath}
        reduceMotion={reduceMotion}
        opacity={opacity}
      />
      <SymbioteTendrilSegment
        from={control}
        to={to}
        index={index * 2 + 1}
        breath={breath}
        reduceMotion={reduceMotion}
        opacity={opacity}
      />
    </>
  );
}

function SymbioteNode({
  cluster,
  position,
  index,
  isSelected,
  breath,
  reduceMotion,
  depthScale,
  depthOpacity,
  onPress,
  onPressIn,
  onPressOut,
}: {
  cluster: KnowledgeCluster;
  position: ProjectedGraphPoint;
  index: number;
  isSelected: boolean;
  breath: SharedValue<number>;
  reduceMotion: boolean;
  depthScale: number;
  depthOpacity: number;
  onPress: () => void;
  onPressIn?: () => void;
  onPressOut?: () => void;
}) {
  const colors = useColors();
  const size = 34 + cluster.strength * 18;

  const nodeMotion = useAnimatedStyle(() => {
    const wave = reduceMotion
      ? 0
      : Math.sin(breath.value * Math.PI * 2 + index * 0.9);
    return {
      transform: [
        {
          scale:
            depthScale *
            (isSelected ? 1.14 : 1) *
            (1 + ((wave + 1) / 2) * 0.055),
        },
        { rotate: `${wave * 2.5}deg` },
      ],
    };
  });

  return (
    <>
      <Animated.View
        style={[
          styles.symbioteNodeMotion,
          {
            left: position.x - size / 2,
            top: position.y - size / 2,
            width: size,
            height: size,
            zIndex: Math.round(1000 + position.depth),
            opacity: depthOpacity,
          },
          nodeMotion,
        ]}
      >
        <View
          pointerEvents="none"
          style={[
            styles.symbioteNodeHalo,
            {
              width: size + 20,
              height: size + 20,
              borderRadius: (size + 20) / 2,
              left: -10,
              top: -10,
              backgroundColor: colors.symbioteGlow,
              opacity: isSelected ? 0.6 : 0.24,
            },
          ]}
        />
        <TouchableOpacity
          testID={`knowledge-cluster-${cluster.id}`}
          accessibilityRole="button"
          accessibilityLabel={`Open ${cluster.label}, ${cluster.category} knowledge cluster, strength ${Math.round(cluster.strength * 100)} percent, ${cluster.links.length} connections`}
          accessibilityHint="Opens cluster details, editing actions, and linked sources"
          accessibilityState={{ selected: isSelected }}
          style={[
            styles.symbioteNode,
            {
              width: size,
              height: size,
              borderRadius: size * 0.42,
              backgroundColor: colors.symbioteSurface,
              borderColor: isSelected
                ? colors.symbioteHighlight
                : colors.symbioteSoft,
            },
          ]}
          onPress={onPress}
          onPressIn={onPressIn}
          onPressOut={onPressOut}
          activeOpacity={0.75}
        >
          <View
            pointerEvents="none"
            style={[
              styles.symbioteNodeReflection,
              {
                width: Math.max(8, size * 0.24),
                height: Math.max(4, size * 0.09),
                borderRadius: size,
                backgroundColor: colors.symbioteHighlight,
              },
            ]}
          />
          <Feather
            name={
              cluster.category === "core"
                ? "cpu"
                : cluster.category === "data"
                  ? "database"
                  : "hexagon"
            }
            size={14}
            color={colors.symbioteHighlight}
          />
        </TouchableOpacity>
      </Animated.View>
      <View
        pointerEvents="none"
        style={[
          styles.nodeLabelContainer,
          {
            left: position.x - 75,
            top: position.y + (size * depthScale) / 2 + 8,
            zIndex: Math.round(1000 + position.depth),
            opacity: depthOpacity,
          },
        ]}
      >
        <Text
          style={[
            styles.nodeLabel,
            {
              color: isSelected
                ? colors.symbioteHighlight
                : colors.symbioteMuted,
              fontFamily: isSelected ? "Inter_600SemiBold" : "Inter_500Medium",
            },
          ]}
        >
          {cluster.label}
        </Text>
      </View>
    </>
  );
}

/**
 * A search hit whose concept is not in local state. The device keeps at most
 * the newest slice of the ontology, so the concept itself — summary, evidence,
 * neighbors — has to come from the server on demand.
 */
type RemoteConceptView = {
  conceptId: string;
  /** Label from the search row, shown while the full concept loads. */
  label: string;
  projectId: string | null;
  status: "loading" | "ready" | "offline" | "missing";
  detail: VenomOntologyConceptDetail | null;
};
function KnowledgeWorkspace({
  onOpenConversation,
  isActive,
}: {
  onOpenConversation: (conversationId: string) => void;
  isActive: boolean;
}) {
  const colors = useColors();
  const { width: windowWidth } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const {
    state,
    setActiveProject,
    renameKnowledgeCluster,
    deleteKnowledgeCluster,
    mergeKnowledgeClusters,
  } = useVenom();
  const { getToken } = useAuth();
  const captureButtonRef =
    useRef<React.ElementRef<typeof TouchableOpacity>>(null);
  const [composerProjectId, setComposerProjectId] = useState<string | null>(
    null,
  );
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(
    null,
  );
  // Concept under the user's finger (press-in, before release). Display-time
  // only: it drives the slime's touch reaction, never data.
  const [touchedClusterId, setTouchedClusterId] = useState<string | null>(
    null,
  );
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [isChoosingMerge, setIsChoosingMerge] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [remoteConcept, setRemoteConcept] = useState<RemoteConceptView | null>(
    null,
  );
  const visibleClusters = useMemo<KnowledgeCluster[]>(
    () =>
      state.clusters.filter(
        (cluster: KnowledgeCluster) =>
          cluster.projectId === state.activeProjectId,
      ),
    [state.activeProjectId, state.clusters],
  );
  // Brain notes are summarized from conversation text, so they can carry the
  // same inline `[source:...]` markers an answer stores. Resolving them with
  // the project's citations keeps a live source reading as its title and a
  // disconnected one as its archived reference, never as a raw marker.
  const citationLookup = useMemo<KnowledgeCitationLookup>(
    () => ({
      citationsById: new Map(
        (state.sources ?? [])
          .filter(
            (source: ProjectSource) =>
              source.projectId === state.activeProjectId &&
              source.status === "connected",
          )
          .flatMap((source: ProjectSource) =>
            source.citations.map(
              (citation) => [citation.id, citation] as const,
            ),
          ),
      ),
      archivedById: new Map(
        (state.archivedCitations ?? []).map(
          (archived) => [archived.id, archived] as const,
        ),
      ),
    }),
    [state.activeProjectId, state.archivedCitations, state.sources],
  );
  const selectedCluster =
    visibleClusters.find((cluster) => cluster.id === selectedClusterId) ?? null;
  const composerProject =
    state.projects.find((project) => project.id === composerProjectId) ?? null;

  // Whole-ontology search. The server store is the system of record (it can
  // hold more concepts than a device keeps locally), so ask it first and fall
  // back to the on-device copy offline or in UI-test mode.
  const [brainQuery, setBrainQuery] = useState("");
  const [brainRemoteResults, setBrainRemoteResults] = useState<
    VenomOntologySearchResult[] | null
  >(null);
  useEffect(() => {
    const term = brainQuery.trim();
    if (term.length < 2) {
      setBrainRemoteResults(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(async () => {
      try {
        // Browser UI tests stub this endpoint like every other backend read.
        const token = IS_UI_TEST ? UI_TEST_CHAT_TOKEN : await getToken();
        if (!token || stale) return;
        const response = await searchVenomOntology(
          { q: term, limit: 20 },
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!stale) setBrainRemoteResults(response.results);
      } catch {
        // Offline or the store is unreachable: the local list below still
        // answers from the device copy.
        if (!stale) setBrainRemoteResults(null);
      }
    }, 250);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [brainQuery, getToken]);

  const brainSearchResults = useMemo(() => {
    const term = brainQuery.trim().toLowerCase();
    if (term.length < 2) return [];
    const seen = new Set<string>();
    const rows: {
      id: string;
      label: string;
      category: string;
      projectId: string | null;
      evidenceCount: number;
    }[] = [];
    for (const result of brainRemoteResults ?? []) {
      if (seen.has(result.id)) continue;
      seen.add(result.id);
      rows.push({
        id: result.id,
        label: result.label,
        category: result.category,
        projectId: result.projectId,
        evidenceCount: result.evidenceCount,
      });
    }
    for (const cluster of state.clusters) {
      if (seen.has(cluster.id)) continue;
      if (
        !cluster.label.toLowerCase().includes(term) &&
        !cluster.summary.toLowerCase().includes(term)
      ) {
        continue;
      }
      seen.add(cluster.id);
      rows.push({
        id: cluster.id,
        label: cluster.label,
        category: cluster.category,
        projectId: cluster.projectId,
        evidenceCount: cluster.sources.length,
      });
    }
    return rows.slice(0, 12);
  }, [brainQuery, brainRemoteResults, state.clusters]);
  const projectNameById = useMemo(
    () => new Map(state.projects.map((project) => [project.id, project.name])),
    [state.projects],
  );
  const handleOpenSearchResult = useCallback(
    (row: { id: string; label: string; projectId: string | null }) => {
      setIsRenaming(false);
      setIsChoosingMerge(false);
      setIsConfirmingDelete(false);
      setEditError(null);
      setBrainQuery("");
      setBrainRemoteResults(null);
      const isLocal = state.clusters.some((cluster) => cluster.id === row.id);
      if (isLocal) {
        setRemoteConcept(null);
        if (row.projectId !== state.activeProjectId) {
          setActiveProject(row.projectId);
        }
        setSelectedClusterId(row.id);
        return;
      }
      // Not cached on this device: open the server-backed detail view instead
      // of switching projects toward a node the map cannot render.
      setSelectedClusterId(null);
      setRemoteConcept({
        conceptId: row.id,
        label: row.label,
        projectId: row.projectId,
        status: "loading",
        detail: null,
      });
    },
    [setActiveProject, state.activeProjectId, state.clusters],
  );

  // Fetch the opened remote concept. Retry re-enters "loading", which re-runs
  // this effect; closing or replacing the overlay makes the in-flight read
  // stale.
  useEffect(() => {
    if (!remoteConcept || remoteConcept.status !== "loading") return;
    const { conceptId } = remoteConcept;
    let stale = false;
    (async () => {
      try {
        const token = IS_UI_TEST ? UI_TEST_CHAT_TOKEN : await getToken();
        if (stale) return;
        if (!token) throw new Error("Not signed in");
        const detail = await getVenomOntologyConcept(conceptId, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (stale) return;
        setRemoteConcept((current) =>
          current?.conceptId === conceptId && current.status === "loading"
            ? {
                ...current,
                status: "ready",
                detail,
                label: detail.concept.label,
                projectId: detail.concept.projectId,
              }
            : current,
        );
      } catch (error) {
        if (stale) return;
        const missing = error instanceof ApiError && error.status === 404;
        setRemoteConcept((current) =>
          current?.conceptId === conceptId && current.status === "loading"
            ? {
                ...current,
                status: missing ? "missing" : "offline",
                detail: null,
              }
            : current,
        );
      }
    })();
    return () => {
      stale = true;
    };
  }, [getToken, remoteConcept]);

  // A remote concept usually belongs to another project, so resolve its
  // citation markers against every connected source on the device — not just
  // the active project's — plus the archived record of retired ones.
  const remoteCitationLookup = useMemo<KnowledgeCitationLookup>(
    () => ({
      citationsById: new Map(
        (state.sources ?? [])
          .filter((source: ProjectSource) => source.status === "connected")
          .flatMap((source: ProjectSource) =>
            source.citations.map(
              (citation) => [citation.id, citation] as const,
            ),
          ),
      ),
      archivedById: new Map(
        (state.archivedCitations ?? []).map(
          (archived) => [archived.id, archived] as const,
        ),
      ),
    }),
    [state.archivedCitations, state.sources],
  );
  const localConversationIds = useMemo(
    () => new Set(state.conversations.map((conversation) => conversation.id)),
    [state.conversations],
  );

  const MAP_SIZE = 800;
  const CENTER = MAP_SIZE / 2;
  const baseGraphScale = Math.min(
    0.78,
    Math.max(0.46, (windowWidth - 20) / MAP_SIZE),
  );
  const breath = useSharedValue(0);
  const [graphCamera, setGraphCamera] =
    useState<GraphCamera>(DEFAULT_GRAPH_CAMERA);
  const graphCameraRef = useRef(graphCamera);
  const orbitStartRef = useRef<GraphCamera>(DEFAULT_GRAPH_CAMERA);
  const pinchStartRef = useRef<GraphCamera>(DEFAULT_GRAPH_CAMERA);

  useEffect(() => {
    graphCameraRef.current = graphCamera;
  }, [graphCamera]);

  const commitGraphCamera = useCallback((next: GraphCamera) => {
    graphCameraRef.current = next;
    setGraphCamera(next);
  }, []);

  useEffect(() => {
    cancelAnimation(breath);
    if (!isActive || reduceMotion || IS_READ_ONLY_UI_TEST) {
      breath.value = 0;
      return;
    }
    breath.value = withRepeat(
      withTiming(1, {
        duration: 2600,
        easing: Easing.inOut(Easing.cubic),
      }),
      -1,
      true,
    );
    return () => {
      cancelAnimation(breath);
    };
  }, [breath, isActive, reduceMotion]);

  useEffect(() => {
    if (
      selectedClusterId &&
      !visibleClusters.some((cluster) => cluster.id === selectedClusterId)
    ) {
      setSelectedClusterId(null);
      setIsRenaming(false);
      setIsChoosingMerge(false);
      setIsConfirmingDelete(false);
      setEditError(null);
    }
  }, [selectedClusterId, state.activeProjectId, visibleClusters]);

  // Display-time layout only: pull same-category concepts into visual
  // islands so the mass reads as clusters. Stored positions, counts and the
  // selectable clusters are untouched — these copies only feed geometry.
  const displayClusters = useMemo(
    () => layoutIslands(visibleClusters),
    [visibleClusters],
  );
  const clustersById = useMemo(
    () => new Map(displayClusters.map((cluster) => [cluster.id, cluster])),
    [displayClusters],
  );
  const liveConnections = useMemo<GraphConnection[]>(() => {
    const connections: GraphConnection[] = [];
    const seen = new Set<string>();

    for (const cluster of displayClusters) {
      for (const targetId of cluster.links) {
        const target = clustersById.get(targetId);
        if (!target) continue;

        const id = [cluster.id, target.id].sort().join("::");
        if (seen.has(id)) continue;
        seen.add(id);
        connections.push({
          id,
          from: cluster,
          to: target,
          index: connections.length,
        });
      }
    }

    return connections
      .sort(
        (left, right) =>
          right.from.strength +
          right.to.strength -
          (left.from.strength + left.to.strength),
      )
      .slice(0, MAX_LIVE_CONNECTIONS);
  }, [clustersById, displayClusters]);

  const projectedClusters = useMemo<ProjectedGraphCluster[]>(
    () =>
      displayClusters
        .map((cluster) => ({
          cluster,
          ...projectGraphCluster(cluster, graphCamera, baseGraphScale, CENTER),
        }))
        .sort((left, right) => left.depth - right.depth),
    [CENTER, baseGraphScale, graphCamera, displayClusters],
  );
  const projectedById = useMemo(
    () =>
      new Map(
        projectedClusters.map((projected) => [projected.cluster.id, projected]),
      ),
    [projectedClusters],
  );

  // Feed the slime the same projected geometry the nodes use, so the goo
  // orbits and dives with them instead of drifting behind. Each concept also
  // grows a handful of satellite micro-clumps sized from its real substance
  // (sources and mentions) — goo-only mass that is never counted or labelled.
  const slimeNodes = useMemo<SlimeNode[]>(() => {
    const cores = projectedClusters.map((projected) => ({
      id: projected.cluster.id,
      x: projected.x,
      y: projected.y,
      depth: projected.depth,
      radius: (34 + projected.cluster.strength * 18) * projected.scale * 1.1,
      sourceCount: projected.cluster.sources.length,
      mentionCount: projected.cluster.mentionCount,
    }));
    return [...cores, ...deriveSatelliteNodes(cores)];
  }, [projectedClusters]);

  const slimeEdges = useMemo<SlimeEdge[]>(
    () =>
      liveConnections.map((connection) => ({
        sourceId: connection.from.id,
        targetId: connection.to.id,
      })),
    [liveConnections],
  );

  const orbitGesture = Gesture.Pan()
    .runOnJS(true)
    .maxPointers(1)
    .minDistance(12)
    .onBegin(() => {
      orbitStartRef.current = graphCameraRef.current;
    })
    .onUpdate((event) => {
      const start = orbitStartRef.current;
      commitGraphCamera({
        ...start,
        yaw: start.yaw + event.translationX * 0.009,
        pitch: clampGraphValue(
          start.pitch - event.translationY * 0.007,
          -0.82,
          0.82,
        ),
      });
    })
    .onFinalize((_event, success) => {
      if (success) return;
      commitGraphCamera({
        ...graphCameraRef.current,
        yaw: orbitStartRef.current.yaw,
        pitch: orbitStartRef.current.pitch,
      });
    });

  const zoomGesture = Gesture.Pinch()
    .runOnJS(true)
    .onBegin(() => {
      pinchStartRef.current = graphCameraRef.current;
    })
    .onUpdate((event) => {
      commitGraphCamera({
        ...graphCameraRef.current,
        zoom: clampGraphValue(
          pinchStartRef.current.zoom * event.scale,
          0.7,
          1.65,
        ),
      });
    });

  const graphGesture = Gesture.Simultaneous(orbitGesture, zoomGesture);

  const auraMotionStyle = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 0.16 : 0.12 + breath.value * 0.16,
    transform: [{ scale: reduceMotion ? 1 : 0.9 + breath.value * 0.16 }],
  }));

  const resetView = () => {
    commitGraphCamera(DEFAULT_GRAPH_CAMERA);
  };

  const closeDetails = () => {
    setSelectedClusterId(null);
    setIsRenaming(false);
    setIsChoosingMerge(false);
    setIsConfirmingDelete(false);
    setEditError(null);
  };

  const openNoteComposer = () => {
    if (!state.activeProjectId) return;
    closeDetails();
    setComposerProjectId(state.activeProjectId);
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  const closeNoteComposer = () => {
    setComposerProjectId(null);
    setTimeout(() => {
      const captureButton = captureButtonRef.current;
      if (Platform.OS === "web") {
        captureButton?.focus?.();
        return;
      }
      const node = findNodeHandle(captureButton);
      if (node) AccessibilityInfo.setAccessibilityFocus(node);
    }, 120);
  };

  const openCluster = (clusterId: string) => {
    setSelectedClusterId(clusterId);
    setRemoteConcept(null);
    setIsRenaming(false);
    setIsChoosingMerge(false);
    setIsConfirmingDelete(false);
    setEditError(null);
  };

  const startRename = () => {
    if (!selectedCluster) return;
    setRenameDraft(selectedCluster.label);
    setEditError(null);
    setIsChoosingMerge(false);
    setIsConfirmingDelete(false);
    setIsRenaming(true);
  };

  const saveRename = () => {
    if (!selectedCluster) return;
    const label = renameDraft.trim();
    if (!label) {
      setEditError("Give this cluster a name before saving.");
      return;
    }
    const hasDuplicateLabel = visibleClusters.some(
      (cluster) =>
        cluster.id !== selectedCluster.id &&
        cluster.label.trim().toLocaleLowerCase() === label.toLocaleLowerCase(),
    );
    if (hasDuplicateLabel) {
      setEditError("That name already exists. Merge the duplicates instead.");
      return;
    }

    renameKnowledgeCluster(selectedCluster.id, label);
    setIsRenaming(false);
    setEditError(null);
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  const selectMergeSource = (sourceCluster: KnowledgeCluster) => {
    if (!selectedCluster) return;
    mergeKnowledgeClusters(selectedCluster.id, sourceCluster.id);
    setIsChoosingMerge(false);
    setEditError(null);
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  const confirmDelete = () => {
    if (!selectedCluster) return;
    deleteKnowledgeCluster(selectedCluster.id);
    closeDetails();
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
  };

  return (
    <View style={styles.workspaceContainer}>
      <View style={styles.knowledgeContainer}>
        <View style={styles.brainSearchWrap}>
          <View
            style={[
              styles.brainSearchField,
              {
                backgroundColor: colors.secondary,
                borderColor: colors.border,
              },
            ]}
          >
            <Feather name="search" size={14} color={colors.mutedForeground} />
            <TextInput
              testID="brain-search-input"
              style={[styles.brainSearchInput, { color: colors.foreground }]}
              placeholder="Search all knowledge"
              placeholderTextColor={colors.mutedForeground}
              value={brainQuery}
              onChangeText={setBrainQuery}
              autoCorrect={false}
              autoCapitalize="none"
              accessibilityLabel="Search all knowledge"
              returnKeyType="search"
            />
            {brainQuery.length > 0 && (
              <TouchableOpacity
                onPress={() => setBrainQuery("")}
                accessibilityRole="button"
                accessibilityLabel="Clear knowledge search"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Feather name="x" size={14} color={colors.mutedForeground} />
              </TouchableOpacity>
            )}
          </View>
          {brainQuery.trim().length >= 2 && (
            <View
              testID="brain-search-results"
              style={[
                styles.brainSearchResults,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                },
              ]}
            >
              {brainSearchResults.length === 0 ? (
                <Text
                  style={[
                    styles.brainSearchEmpty,
                    { color: colors.mutedForeground },
                  ]}
                >
                  No concepts match yet.
                </Text>
              ) : (
                <ScrollView
                  style={styles.brainSearchList}
                  keyboardShouldPersistTaps="handled"
                  nestedScrollEnabled
                >
                  {brainSearchResults.map((row) => (
                    <TouchableOpacity
                      key={row.id}
                      testID={`brain-search-result-${row.id}`}
                      style={styles.brainSearchRow}
                      onPress={() => handleOpenSearchResult(row)}
                      accessibilityRole="button"
                      accessibilityLabel={`Open concept ${row.label}`}
                    >
                      <View style={styles.brainSearchRowText}>
                        <Text
                          style={[
                            styles.brainSearchRowLabel,
                            { color: colors.foreground },
                          ]}
                          numberOfLines={1}
                        >
                          {row.label}
                        </Text>
                        <Text
                          style={[
                            styles.brainSearchRowMeta,
                            { color: colors.mutedForeground },
                          ]}
                          numberOfLines={1}
                        >
                          {row.projectId
                            ? (projectNameById.get(row.projectId) ??
                              "Unknown project")
                            : "No project"}
                          {" · "}
                          {row.category}
                        </Text>
                      </View>
                      <Text
                        style={[
                          styles.brainSearchRowCount,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        {row.evidenceCount}{" "}
                        {row.evidenceCount === 1 ? "source" : "sources"}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
            </View>
          )}
        </View>
        {visibleClusters.length === 0 ? (
          <View style={styles.knowledgeEmpty}>
            <View
              style={[
                styles.knowledgeEmptyIcon,
                { backgroundColor: colors.secondary },
              ]}
            >
              <Feather name="git-branch" size={24} color={colors.primary} />
            </View>
            <Text
              style={[styles.knowledgeEmptyTitle, { color: colors.foreground }]}
            >
              Your knowledge map will grow here
            </Text>
            <Text
              style={[
                styles.knowledgeEmptyCopy,
                { color: colors.mutedForeground },
              ]}
            >
              Finish a project conversation and Venom will map its topics,
              decisions, and dependencies.
            </Text>
          </View>
        ) : (
          <View
            testID="knowledge-map"
            style={[
              styles.symbioteStage,
              { backgroundColor: colors.symbioteBackdrop },
            ]}
            accessibilityLabel={`Living ontology with ${visibleClusters.length} selectable knowledge clusters. Camera yaw ${graphCamera.yaw.toFixed(3)}, pitch ${graphCamera.pitch.toFixed(3)}, zoom ${graphCamera.zoom.toFixed(3)}`}
          >
            <View style={styles.symbioteHud} pointerEvents="none">
              <View>
                <Text
                  style={[
                    styles.symbioteEyebrow,
                    { color: colors.symbioteMuted },
                  ]}
                >
                  Live knowledge
                </Text>
                <Text
                  style={[
                    styles.symbioteTitle,
                    { color: colors.symbioteHighlight },
                  ]}
                >
                  {visibleClusters.length} living nodes
                </Text>
              </View>
              <View
                style={[
                  styles.symbioteStatus,
                  {
                    backgroundColor: colors.symbiotePanel,
                    borderColor: colors.symbioteSoft,
                  },
                ]}
              >
                <View
                  style={[
                    styles.symbioteStatusDot,
                    { backgroundColor: colors.symbioteHighlight },
                  ]}
                />
                <Text
                  style={[
                    styles.symbioteStatusText,
                    { color: colors.symbioteMuted },
                  ]}
                >
                  {reduceMotion ? "Stable" : "Evolving"}
                </Text>
              </View>
            </View>

            <GestureDetector gesture={graphGesture}>
              <View style={styles.symbioteViewport}>
                <Animated.View
                  style={[
                    styles.symbioteMap,
                    {
                      left: (windowWidth - MAP_SIZE) / 2,
                      top: -36,
                    },
                  ]}
                >
                  <Animated.View
                    pointerEvents="none"
                    style={[
                      styles.symbioteAura,
                      {
                        left: CENTER - 180,
                        top: CENTER - 180,
                        borderColor: colors.symbioteGlow,
                        backgroundColor: colors.symbioteGlow,
                      },
                      auraMotionStyle,
                    ]}
                  />
                  <View
                    pointerEvents="none"
                    style={[
                      styles.symbioteOrbit,
                      {
                        left: CENTER - 235,
                        top: CENTER - 235,
                        borderColor: colors.symbioteGlow,
                      },
                    ]}
                  />
                  <View
                    pointerEvents="none"
                    style={[
                      styles.symbioteOrbitInner,
                      {
                        left: CENTER - 145,
                        top: CENTER - 145,
                        borderColor: colors.symbioteGlow,
                      },
                    ]}
                  />

                  <SymbioteSlime
                    nodes={slimeNodes}
                    edges={slimeEdges}
                    mapSize={MAP_SIZE}
                    reduceMotion={reduceMotion}
                    selectedId={selectedCluster?.id ?? null}
                    touchedId={touchedClusterId}
                    capacityOverride={SLIME_CAPACITY_OVERRIDE}
                    surfaceFractionOverride={SLIME_SCALE_OVERRIDE}
                    exposeTelemetry={IS_UI_TEST}
                  />

                  {liveConnections.map((connection) => {
                    const from = projectedById.get(connection.from.id);
                    const to = projectedById.get(connection.to.id);
                    if (!from || !to) return null;
                    return (
                      <SymbioteConnection
                        key={connection.id}
                        from={from}
                        to={to}
                        index={connection.index}
                        breath={breath}
                        reduceMotion={reduceMotion}
                        opacity={(from.opacity + to.opacity) / 2}
                      />
                    );
                  })}

                  {projectedClusters.map((projected, index) => (
                    <SymbioteNode
                      key={projected.cluster.id}
                      cluster={projected.cluster}
                      position={projected}
                      index={index}
                      isSelected={selectedCluster?.id === projected.cluster.id}
                      breath={breath}
                      reduceMotion={reduceMotion}
                      depthScale={projected.scale}
                      depthOpacity={projected.opacity}
                      onPress={() => {
                        if (Platform.OS !== "web") Haptics.selectionAsync();
                        openCluster(projected.cluster.id);
                      }}
                      onPressIn={() =>
                        setTouchedClusterId(projected.cluster.id)
                      }
                      onPressOut={() =>
                        setTouchedClusterId((current) =>
                          current === projected.cluster.id ? null : current,
                        )
                      }
                    />
                  ))}
                </Animated.View>
              </View>
            </GestureDetector>

            <View style={styles.symbioteHint} pointerEvents="none">
              <Feather name="move" size={12} color={colors.symbioteMuted} />
              <Text
                style={[
                  styles.symbioteHintText,
                  { color: colors.symbioteMuted },
                ]}
              >
                  {reduceMotion
                    ? "Motion reduced · drag to orbit"
                    : "Drag to orbit · pinch to dive"}
              </Text>
            </View>
            <TouchableOpacity
              style={[
                styles.symbioteReset,
                {
                  backgroundColor: colors.symbiotePanel,
                  borderColor: colors.symbioteSoft,
                },
              ]}
              onPress={resetView}
              testID="knowledge-reset-view"
              accessibilityRole="button"
              accessibilityLabel="Reset ontology view"
              accessibilityHint="Returns the ontology orientation and zoom to default"
            >
              <Feather
                name="maximize-2"
                size={14}
                color={colors.symbioteHighlight}
              />
              <Text
                style={[
                  styles.symbioteResetText,
                  { color: colors.symbioteHighlight },
                ]}
              >
                Reset view
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Info Panel Overlay */}
        {selectedCluster && (
          <View
            testID="knowledge-cluster-details"
            style={[
              styles.knowledgeInfoPanel,
              {
                backgroundColor: colors.background,
                borderTopColor: colors.border,
              },
            ]}
            accessibilityViewIsModal
            accessibilityLabel={`${selectedCluster.label} cluster details`}
          >
            <ScrollView
              style={styles.knowledgeInfoScroll}
              contentContainerStyle={styles.knowledgeInfoContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
            >
              <View style={styles.knowledgeInfoHeader}>
                <Text
                  style={[
                    styles.knowledgeInfoTitle,
                    { color: colors.foreground },
                  ]}
                >
                  {selectedCluster.label}
                </Text>
                <TouchableOpacity
                  onPress={closeDetails}
                  hitSlop={12}
                  accessibilityRole="button"
                  accessibilityLabel="Close cluster details"
                >
                  <Feather name="x" size={20} color={colors.mutedForeground} />
                </TouchableOpacity>
              </View>
              <Text
                style={[
                  styles.knowledgeInfoDesc,
                  { color: colors.mutedForeground },
                ]}
              >
                {knowledgeDisplayText(selectedCluster.summary, citationLookup)}
              </Text>
              <View style={styles.knowledgeEditActions}>
                <TouchableOpacity
                  style={[
                    styles.knowledgeEditButton,
                    { borderColor: colors.border },
                  ]}
                  onPress={startRename}
                  testID="knowledge-rename-cluster-button"
                  accessibilityRole="button"
                  accessibilityLabel={`Rename ${selectedCluster.label}`}
                  accessibilityHint="Edit this cluster's label"
                >
                  <Feather name="edit-2" size={15} color={colors.foreground} />
                  <Text
                    style={[
                      styles.knowledgeEditButtonText,
                      { color: colors.foreground },
                    ]}
                  >
                    Rename
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.knowledgeEditButton,
                    { borderColor: colors.border },
                  ]}
                  onPress={() => {
                    setIsRenaming(false);
                    setIsConfirmingDelete(false);
                    setEditError(null);
                    setIsChoosingMerge((value) => !value);
                  }}
                  testID="knowledge-merge-cluster-button"
                  accessibilityRole="button"
                  accessibilityLabel={`Merge another cluster into ${selectedCluster.label}`}
                  accessibilityHint="Moves another cluster's sources and connections into this one"
                >
                  <Feather
                    name="git-merge"
                    size={15}
                    color={colors.foreground}
                  />
                  <Text
                    style={[
                      styles.knowledgeEditButtonText,
                      { color: colors.foreground },
                    ]}
                  >
                    Merge
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.knowledgeEditButton,
                    { borderColor: colors.destructive },
                  ]}
                  onPress={() => {
                    setIsRenaming(false);
                    setIsChoosingMerge(false);
                    setEditError(null);
                    setIsConfirmingDelete((value) => !value);
                  }}
                  testID="knowledge-delete-cluster-button"
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${selectedCluster.label}`}
                  accessibilityHint="Shows a confirmation before permanently deleting this cluster"
                >
                  <Feather
                    name="trash-2"
                    size={15}
                    color={colors.destructive}
                  />
                  <Text
                    style={[
                      styles.knowledgeEditButtonText,
                      { color: colors.destructive },
                    ]}
                  >
                    Delete
                  </Text>
                </TouchableOpacity>
              </View>
              {isRenaming && (
                <View
                  style={[
                    styles.knowledgeEditCard,
                    {
                      backgroundColor: colors.card,
                      borderColor: colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.knowledgeEditLabel,
                      { color: colors.foreground },
                    ]}
                  >
                    Rename cluster
                  </Text>
                  <TextInput
                    value={renameDraft}
                    onChangeText={(value) => {
                      setRenameDraft(value);
                      if (editError) setEditError(null);
                    }}
                    style={[
                      styles.knowledgeRenameInput,
                      {
                        color: colors.foreground,
                        borderColor: editError
                          ? colors.destructive
                          : colors.border,
                      },
                    ]}
                    placeholder="Cluster name"
                    placeholderTextColor={colors.mutedForeground}
                    autoFocus
                    maxLength={80}
                    returnKeyType="done"
                    onSubmitEditing={saveRename}
                    testID="knowledge-rename-input"
                    accessibilityLabel="New cluster name"
                  />
                  {editError && (
                    <Text
                      accessibilityRole="alert"
                      style={[
                        styles.knowledgeEditError,
                        { color: colors.destructive },
                      ]}
                    >
                      {editError}
                    </Text>
                  )}
                  <View style={styles.knowledgeEditCardActions}>
                    <TouchableOpacity
                      style={styles.knowledgeTextAction}
                      onPress={() => {
                        setIsRenaming(false);
                        setEditError(null);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Cancel rename"
                    >
                      <Text
                        style={[
                          styles.knowledgeEditCancelText,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        Cancel
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.knowledgeTextAction}
                      onPress={saveRename}
                      disabled={!renameDraft.trim()}
                      testID="knowledge-save-rename-button"
                      accessibilityRole="button"
                      accessibilityLabel="Save cluster name"
                      accessibilityState={{ disabled: !renameDraft.trim() }}
                    >
                      <Text
                        style={[
                          styles.knowledgeEditSaveText,
                          {
                            color: renameDraft.trim()
                              ? colors.primary
                              : colors.mutedForeground,
                          },
                        ]}
                      >
                        Save
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
              {isChoosingMerge && (
                <View
                  style={[
                    styles.knowledgeEditCard,
                    {
                      backgroundColor: colors.card,
                      borderColor: colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.knowledgeEditLabel,
                      { color: colors.foreground },
                    ]}
                  >
                    Merge a duplicate into {selectedCluster.label}
                  </Text>
                  <Text
                    style={[
                      styles.knowledgeEditHelp,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    Its sources, connections, and importance will be retained.
                  </Text>
                  {visibleClusters.length === 1 ? (
                    <Text
                      style={[
                        styles.knowledgeEditHelp,
                        { color: colors.mutedForeground },
                      ]}
                    >
                      There are no other clusters to merge yet.
                    </Text>
                  ) : (
                    <ScrollView
                      style={styles.knowledgeMergeOptions}
                      showsVerticalScrollIndicator={false}
                      nestedScrollEnabled
                    >
                      {visibleClusters
                        .filter((cluster) => cluster.id !== selectedCluster.id)
                        .map((cluster) => (
                          <TouchableOpacity
                            key={cluster.id}
                            style={[
                              styles.knowledgeMergeOption,
                              { borderColor: colors.border },
                            ]}
                            onPress={() => selectMergeSource(cluster)}
                            testID={`knowledge-merge-source-${cluster.id}`}
                            accessibilityRole="button"
                            accessibilityLabel={`Merge ${cluster.label} into ${selectedCluster.label}`}
                          >
                            <View style={styles.knowledgeMergeOptionCopy}>
                              <Text
                                numberOfLines={1}
                                style={[
                                  styles.knowledgeMergeOptionTitle,
                                  { color: colors.foreground },
                                ]}
                              >
                                {cluster.label}
                              </Text>
                              <Text
                                numberOfLines={1}
                                style={[
                                  styles.knowledgeMergeOptionMeta,
                                  { color: colors.mutedForeground },
                                ]}
                              >
                                {cluster.sources.length} sources ·{" "}
                                {cluster.links.length} connections
                              </Text>
                            </View>
                            <Feather
                              name="arrow-down-left"
                              size={16}
                              color={colors.primary}
                            />
                          </TouchableOpacity>
                        ))}
                    </ScrollView>
                  )}
                </View>
              )}
              {isConfirmingDelete && (
                <View
                  style={[
                    styles.knowledgeDeleteConfirm,
                    {
                      backgroundColor: colors.card,
                      borderColor: colors.destructive,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.knowledgeEditLabel,
                      { color: colors.foreground },
                    ]}
                  >
                    Delete {selectedCluster.label}?
                  </Text>
                  <Text
                    style={[
                      styles.knowledgeEditHelp,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    This removes the cluster and its saved sources from the map.
                  </Text>
                  <View style={styles.knowledgeEditCardActions}>
                    <TouchableOpacity
                      style={styles.knowledgeTextAction}
                      onPress={() => setIsConfirmingDelete(false)}
                      accessibilityRole="button"
                      accessibilityLabel="Cancel deleting cluster"
                    >
                      <Text
                        style={[
                          styles.knowledgeEditCancelText,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        Cancel
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.knowledgeTextAction}
                      onPress={confirmDelete}
                      testID="knowledge-confirm-delete-cluster-button"
                      accessibilityRole="button"
                      accessibilityLabel={`Confirm deletion of ${selectedCluster.label}`}
                    >
                      <Text
                        style={[
                          styles.knowledgeEditSaveText,
                          { color: colors.destructive },
                        ]}
                      >
                        Delete cluster
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
              <View style={styles.knowledgeInfoMeta}>
                <View
                  style={[
                    styles.metaBadge,
                    { backgroundColor: colors.secondary },
                  ]}
                >
                  <Text
                    style={[styles.metaBadgeText, { color: colors.foreground }]}
                  >
                    {selectedCluster.category}
                  </Text>
                </View>
                <View
                  style={[
                    styles.metaBadge,
                    { backgroundColor: colors.secondary },
                  ]}
                >
                  <Text
                    style={[styles.metaBadgeText, { color: colors.foreground }]}
                  >
                    {selectedCluster.links.length} connections
                  </Text>
                </View>
              </View>
              <Text
                style={[
                  styles.knowledgeSourcesLabel,
                  { color: colors.mutedForeground },
                ]}
              >
                Sources · {selectedCluster.sources.length}
              </Text>
              <View style={styles.knowledgeSourcesList}>
                {selectedCluster.sources.map(
                  (
                    source: KnowledgeCluster["sources"][number],
                    index: number,
                  ) => (
                    <TouchableOpacity
                      key={`${source.conversationId}-${source.messageIds.join("-")}-${index}`}
                      style={[
                        styles.knowledgeSourceRow,
                        { borderColor: colors.border },
                      ]}
                      onPress={() => onOpenConversation(source.conversationId)}
                      testID={`knowledge-source-${source.conversationId}`}
                      accessibilityRole="button"
                      accessibilityLabel={`Open source conversation ${source.conversationTitle}`}
                    >
                      <View style={styles.knowledgeSourceCopy}>
                        <Text
                          numberOfLines={1}
                          style={[
                            styles.knowledgeSourceTitle,
                            { color: colors.foreground },
                          ]}
                        >
                          {source.conversationTitle}
                        </Text>
                        <Text
                          numberOfLines={2}
                          style={[
                            styles.knowledgeSourceExcerpt,
                            { color: colors.mutedForeground },
                          ]}
                        >
                          {knowledgeDisplayText(source.excerpt, citationLookup)}
                        </Text>
                      </View>
                      <Feather
                        name="arrow-up-right"
                        size={16}
                        color={colors.primary}
                      />
                    </TouchableOpacity>
                  ),
                )}
              </View>
            </ScrollView>
          </View>
        )}

        {/* Remote concept overlay: knowledge the server holds but this device
            has not cached. Same surface as the local panel, read-only. */}
        {remoteConcept && (
          <View
            testID="knowledge-remote-details"
            style={[
              styles.knowledgeInfoPanel,
              {
                backgroundColor: colors.background,
                borderTopColor: colors.border,
              },
            ]}
            accessibilityViewIsModal
            accessibilityLabel={`${remoteConcept.label} synced concept details`}
          >
            <ScrollView
              style={styles.knowledgeInfoScroll}
              contentContainerStyle={styles.knowledgeInfoContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
            >
              <View style={styles.knowledgeInfoHeader}>
                <Text
                  style={[
                    styles.knowledgeInfoTitle,
                    { color: colors.foreground },
                  ]}
                >
                  {remoteConcept.label}
                </Text>
                <TouchableOpacity
                  onPress={() => setRemoteConcept(null)}
                  hitSlop={12}
                  accessibilityRole="button"
                  accessibilityLabel="Close synced concept details"
                  testID="knowledge-remote-close"
                >
                  <Feather name="x" size={20} color={colors.mutedForeground} />
                </TouchableOpacity>
              </View>
              <Text
                style={[
                  styles.knowledgeRemoteMeta,
                  { color: colors.mutedForeground },
                ]}
              >
                {projectNameById.get(remoteConcept.projectId ?? "") ??
                  "Unknown project"}
                {" · not on this device"}
              </Text>

              {remoteConcept.status === "loading" && (
                <View
                  style={styles.knowledgeRemoteStatus}
                  testID="knowledge-remote-loading"
                >
                  <ActivityIndicator size="small" color={colors.primary} />
                  <Text
                    style={[
                      styles.knowledgeRemoteStatusCopy,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    Pulling this concept from your synced brain…
                  </Text>
                </View>
              )}

              {remoteConcept.status === "offline" && (
                <View
                  style={styles.knowledgeRemoteStatus}
                  testID="knowledge-remote-offline"
                >
                  <Feather
                    name="wifi-off"
                    size={26}
                    color={colors.mutedForeground}
                  />
                  <Text
                    style={[
                      styles.knowledgeRemoteStatusTitle,
                      { color: colors.foreground },
                    ]}
                  >
                    Connect to view evidence
                  </Text>
                  <Text
                    style={[
                      styles.knowledgeRemoteStatusCopy,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    This knowledge lives in your synced brain, not on this
                    device. Go online to pull its summary, evidence, and links.
                  </Text>
                  <TouchableOpacity
                    style={[
                      styles.knowledgeRemoteRetry,
                      { borderColor: colors.border },
                    ]}
                    onPress={() =>
                      setRemoteConcept((current) =>
                        current ? { ...current, status: "loading" } : current,
                      )
                    }
                    accessibilityRole="button"
                    accessibilityLabel="Try loading this concept again"
                    testID="knowledge-remote-retry"
                  >
                    <Feather
                      name="rotate-ccw"
                      size={14}
                      color={colors.foreground}
                    />
                    <Text
                      style={[
                        styles.knowledgeRemoteRetryText,
                        { color: colors.foreground },
                      ]}
                    >
                      Try again
                    </Text>
                  </TouchableOpacity>
                </View>
              )}

              {remoteConcept.status === "missing" && (
                <View
                  style={styles.knowledgeRemoteStatus}
                  testID="knowledge-remote-missing"
                >
                  <Text
                    style={[
                      styles.knowledgeRemoteStatusCopy,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    This concept is no longer in your knowledge base. It may
                    have been merged or deleted on another device.
                  </Text>
                </View>
              )}

              {remoteConcept.status === "ready" && remoteConcept.detail && (
                <>
                  <Text
                    style={[
                      styles.knowledgeInfoDesc,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    {knowledgeDisplayText(
                      remoteConcept.detail.concept.summary,
                      remoteCitationLookup,
                    )}
                  </Text>
                  <View style={styles.knowledgeRemoteBadges}>
                    <View
                      style={[
                        styles.knowledgeRemoteBadge,
                        { borderColor: colors.border },
                      ]}
                    >
                      <Text
                        style={[
                          styles.knowledgeRemoteBadgeText,
                          { color: colors.foreground },
                        ]}
                      >
                        {remoteConcept.detail.concept.category}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.knowledgeRemoteBadge,
                        { borderColor: colors.border },
                      ]}
                    >
                      <Text
                        style={[
                          styles.knowledgeRemoteBadgeText,
                          { color: colors.foreground },
                        ]}
                      >
                        {remoteConcept.detail.concept.mentionCount} mentions
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.knowledgeRemoteBadge,
                        { borderColor: colors.border },
                      ]}
                    >
                      <Text
                        style={[
                          styles.knowledgeRemoteBadgeText,
                          { color: colors.foreground },
                        ]}
                      >
                        {Math.round(
                          remoteConcept.detail.concept.strength * 100,
                        )}
                        % strength
                      </Text>
                    </View>
                  </View>

                  <Text
                    style={[
                      styles.knowledgeSourcesLabel,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    Evidence · {remoteConcept.detail.concept.sources.length}
                  </Text>
                  {remoteConcept.detail.concept.sources.length === 0 ? (
                    <Text
                      style={[
                        styles.knowledgeRemoteStatusCopy,
                        { color: colors.mutedForeground },
                      ]}
                    >
                      No conversation evidence is attached to this concept yet.
                    </Text>
                  ) : (
                    <View style={styles.knowledgeSourcesList}>
                      {remoteConcept.detail.concept.sources.map(
                        (source, index) => {
                          const isLocalConversation = localConversationIds.has(
                            source.conversationId,
                          );
                          return (
                            <TouchableOpacity
                              key={`${source.conversationId}-${index}`}
                              style={[
                                styles.knowledgeSourceRow,
                                { borderColor: colors.border },
                              ]}
                              onPress={() =>
                                onOpenConversation(source.conversationId)
                              }
                              disabled={!isLocalConversation}
                              testID={`knowledge-remote-source-${source.conversationId}`}
                              accessibilityRole="button"
                              accessibilityState={{
                                disabled: !isLocalConversation,
                              }}
                              accessibilityLabel={
                                isLocalConversation
                                  ? `Open source conversation ${source.conversationTitle}`
                                  : `Source conversation ${source.conversationTitle} is not on this device`
                              }
                            >
                              <View style={styles.knowledgeSourceCopy}>
                                <Text
                                  numberOfLines={1}
                                  style={[
                                    styles.knowledgeSourceTitle,
                                    { color: colors.foreground },
                                  ]}
                                >
                                  {source.conversationTitle}
                                </Text>
                                <Text
                                  numberOfLines={2}
                                  style={[
                                    styles.knowledgeSourceExcerpt,
                                    { color: colors.mutedForeground },
                                  ]}
                                >
                                  {knowledgeDisplayText(
                                    source.excerpt,
                                    remoteCitationLookup,
                                  )}
                                </Text>
                              </View>
                              {isLocalConversation && (
                                <Feather
                                  name="arrow-up-right"
                                  size={16}
                                  color={colors.primary}
                                />
                              )}
                            </TouchableOpacity>
                          );
                        },
                      )}
                    </View>
                  )}

                  {remoteConcept.detail.neighbors.length > 0 && (
                    <>
                      <Text
                        style={[
                          styles.knowledgeSourcesLabel,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        Linked concepts
                      </Text>
                      <View style={styles.knowledgeNeighborChips}>
                        {remoteConcept.detail.neighbors.map((neighbor) => (
                          <TouchableOpacity
                            key={neighbor.id}
                            style={[
                              styles.knowledgeNeighborChip,
                              { borderColor: colors.border },
                            ]}
                            onPress={() =>
                              handleOpenSearchResult({
                                id: neighbor.id,
                                label: neighbor.label,
                                projectId: neighbor.projectId,
                              })
                            }
                            accessibilityRole="button"
                            accessibilityLabel={`Open linked concept ${neighbor.label}`}
                            testID={`knowledge-remote-neighbor-${neighbor.id}`}
                          >
                            <Feather
                              name="link"
                              size={12}
                              color={colors.foreground}
                            />
                            <Text
                              style={[
                                styles.knowledgeNeighborChipText,
                                { color: colors.foreground },
                              ]}
                            >
                              {neighbor.label}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </>
                  )}
                </>
              )}
            </ScrollView>
          </View>
        )}
        {!selectedCluster && !remoteConcept && (
          <TouchableOpacity
            ref={captureButtonRef}
            style={[
              styles.knowledgeCaptureButton,
              {
                backgroundColor:
                  visibleClusters.length > 0
                    ? colors.symbioteHighlight
                    : colors.primary,
                borderColor:
                  visibleClusters.length > 0
                    ? colors.symbioteSoft
                    : colors.border,
              },
            ]}
            onPress={openNoteComposer}
            disabled={!state.activeProjectId}
            accessibilityRole="button"
            accessibilityLabel="Capture a note into this project's Brain"
            accessibilityHint="Opens a reviewable multiline note composer"
            accessibilityState={{ disabled: !state.activeProjectId }}
            testID="brain-note-open"
          >
            <Feather
              name="plus"
              size={22}
              color={
                visibleClusters.length > 0
                  ? colors.symbioteSurface
                  : colors.primaryForeground
              }
            />
          </TouchableOpacity>
        )}
        {composerProjectId && (
          <BrainNoteComposer
            projectId={composerProjectId}
            projectName={composerProject?.name ?? "Selected project"}
            onClose={closeNoteComposer}
            onRetargetProject={setComposerProjectId}
          />
        )}
      </View>
    </View>
  );
}

const FIELD_TYPE_LABELS: Record<KanbanFieldType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  single_select: "Single select",
  checkbox: "Checkbox",
};
function BoardWorkspace({ activeProject }: { activeProject: any }) {
  const colors = useColors();
  const {
    syncStatus,
    addTask,
    updateTask,
    moveTask,
    deleteTask,
    addStage,
    updateStage,
    reorderStage,
    removeStage,
    addFieldDefinition,
    updateFieldDefinition,
    reorderFieldDefinition,
    removeFieldDefinition,
  } = useVenom();
  const stages: KanbanStage[] = activeProject?.boardStages ?? [];
  const fields: KanbanField[] = activeProject?.fieldDefinitions ?? [];
  const tasks: Task[] = activeProject?.tasks ?? [];
  const reduceMotion = useReducedMotion();
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [addingStageId, setAddingStageId] = useState<string | null>(null);
  const [editorTaskId, setEditorTaskId] = useState<string | null>(null);
  const [editorTitle, setEditorTitle] = useState("");
  const [editorStageId, setEditorStageId] = useState("");
  const [editorValues, setEditorValues] = useState<
    Record<string, string | boolean>
  >({});
  const [pendingDeleteTaskId, setPendingDeleteTaskId] = useState<string | null>(
    null,
  );
  const [showSettings, setShowSettings] = useState(false);
  const [newStageName, setNewStageName] = useState("");
  const [newStageIsDone, setNewStageIsDone] = useState(false);
  const [removingStageId, setRemovingStageId] = useState<string | null>(null);
  const [reassignStageId, setReassignStageId] = useState("");
  const [newFieldName, setNewFieldName] = useState("");
  const [newFieldType, setNewFieldType] =
    useState<KanbanFieldType>("text");
  const [newFieldOptions, setNewFieldOptions] = useState("");
  const [pendingDeleteFieldId, setPendingDeleteFieldId] = useState<
    string | null
  >(null);
  const [focusedMoveControl, setFocusedMoveControl] = useState<string | null>(
    null,
  );
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const [focusedAddCardStageId, setFocusedAddCardStageId] = useState<
    string | null
  >(null);
  const editorAppear = useRef(new RNAnimated.Value(0)).current;
  const cardControlRefs = useRef<Map<string, CardControlHandles>>(new Map());
  const addCardControlRefs = useRef<Map<string, CardControlHandle>>(new Map());
  const pendingCardFocusRef = useRef<BoardFocusTarget | null>(null);
  const [boardError, setBoardError] = useState("");

  const tasksForStage = useCallback(
    (stageId: string) =>
      tasks
        .filter((task) => task.stageId === stageId)
        .sort(
          (left, right) =>
            left.position - right.position || left.id.localeCompare(right.id),
        ),
    [tasks],
  );

  const registerCardControl =
    (taskId: string, control: keyof CardControlHandles) =>
    (node: CardControlHandle | null) => {
      const handles = cardControlRefs.current.get(taskId) ?? {
        edit: null,
        next: null,
      };
      handles[control] = node;
      if (!handles.edit && !handles.next) {
        cardControlRefs.current.delete(taskId);
        return;
      }
      cardControlRefs.current.set(taskId, handles);
    };

  const registerAddCardControl =
    (stageId: string) => (node: CardControlHandle | null) => {
      if (node) {
        addCardControlRefs.current.set(stageId, node);
        return;
      }
      addCardControlRefs.current.delete(stageId);
    };

  // Keyboard users must keep their place after the editor closes. The card can
  // change stage on save, so the browser cannot restore focus by itself: the
  // element it remembers is unmounted with the old column.
  const focusCardControls = (taskId: string) => {
    const handles = cardControlRefs.current.get(taskId);
    if (!handles) return;
    const task = tasks.find((item) => item.id === taskId);
    const stageIndex = task
      ? stages.findIndex((stage) => stage.id === task.stageId)
      : -1;
    const canMoveNext = stageIndex >= 0 && stageIndex < stages.length - 1;
    const target = (canMoveNext ? handles.next : null) ?? handles.edit;
    target?.focus?.();
  };

  const handleEditorDismiss = () => {
    const target = pendingCardFocusRef.current;
    pendingCardFocusRef.current = null;
    if (!target) return;
    if (target.kind === "card") {
      focusCardControls(target.taskId);
      return;
    }
    addCardControlRefs.current.get(target.stageId)?.focus?.();
  };

  const openEditor = (task: Task) => {
    pendingCardFocusRef.current = null;
    setEditorTaskId(task.id);
    setEditorTitle(task.title);
    setEditorStageId(task.stageId);
    setPendingDeleteTaskId(null);
    setBoardError("");
    setEditorValues(
      Object.fromEntries(
        fields.map((field) => [
          field.id,
          field.type === "checkbox"
            ? task.values[field.id] === true
            : String(task.values[field.id] ?? ""),
        ]),
      ),
    );
  };

  const closeEditor = () => {
    setEditorTaskId(null);
    setPendingDeleteTaskId(null);
    setBoardError("");
  };

  const handleAddTask = (stageId: string) => {
    const trimmed = newTaskTitle.trim();
    if (!trimmed) {
      setBoardError("Enter a task title.");
      return;
    }
    if (tasks.length >= 2000) {
      setBoardError("This project has reached the 2,000-card limit.");
      return;
    }
    addTask(activeProject.id, trimmed, stageId);
    setNewTaskTitle("");
    setAddingStageId(null);
    setBoardError("");
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  const saveTask = () => {
    if (!editorTaskId || !editorTitle.trim()) {
      setBoardError("Task title is required.");
      return;
    }
    const values: Record<string, string | number | boolean> = {};
    for (const field of fields) {
      const value = editorValues[field.id];
      if (field.type === "checkbox") {
        if (typeof value === "boolean") values[field.id] = value;
      } else if (typeof value === "string" && value.trim()) {
        if (field.type === "number") {
          const numberValue = Number(value);
          if (
            !Number.isFinite(numberValue) ||
            numberValue < -1_000_000_000 ||
            numberValue > 1_000_000_000
          ) {
            setBoardError(
              `${field.name} must be a number between -1 billion and 1 billion.`,
            );
            return;
          }
          values[field.id] = numberValue;
        } else if (
          field.type === "date" &&
          !isValidCardDate(value.trim())
        ) {
          setBoardError(`${field.name} must be a valid date using YYYY-MM-DD.`);
          return;
        } else {
          values[field.id] = value.trim();
        }
      }
    }
    updateTask(activeProject.id, editorTaskId, {
      title: editorTitle,
      stageId: editorStageId,
      values,
    });
    pendingCardFocusRef.current = { kind: "card", taskId: editorTaskId };
    closeEditor();
  };

  // Deleting the edited card leaves nothing for the browser to return focus
  // to, so aim the post-dismiss focus at the closest surviving neighbour in
  // the card's stage — the next card, or the previous one when the last card
  // went — and at the stage's "Add card" control once the stage is empty.
  const deleteEditedTask = () => {
    if (!editorTaskId) return;
    const task = tasks.find((item) => item.id === editorTaskId);
    if (task) {
      const columnTasks = tasksForStage(task.stageId);
      const index = columnTasks.findIndex((item) => item.id === task.id);
      const neighbour =
        index >= 0
          ? (columnTasks[index + 1] ?? columnTasks[index - 1])
          : undefined;
      pendingCardFocusRef.current = neighbour
        ? { kind: "card", taskId: neighbour.id }
        : { kind: "addCard", stageId: task.stageId };
    }
    deleteTask(activeProject.id, editorTaskId);
    closeEditor();
  };

  const moveCard = (
    task: Task,
    stageId: string,
    position: number,
  ) => {
    moveTask(activeProject.id, task.id, stageId, position);
    if (Platform.OS !== "web") Haptics.selectionAsync();
  };

  const addNewStage = () => {
    const name = newStageName.trim();
    if (!name) {
      setBoardError("Stage name is required.");
      return;
    }
    if (stages.length >= 30) {
      setBoardError("A board can have up to 30 stages.");
      return;
    }
    if (
      stages.some(
        (stage) =>
          stage.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    ) {
      setBoardError("Stage names must be unique.");
      return;
    }
    addStage(activeProject.id, name, newStageIsDone);
    setNewStageName("");
    setNewStageIsDone(false);
    setBoardError("");
  };

  const beginRemoveStage = (stageId: string) => {
    const fallback = stages.find((stage) => stage.id !== stageId);
    if (!fallback) {
      setBoardError("A board must keep at least one stage.");
      return;
    }
    setRemovingStageId(stageId);
    setReassignStageId(fallback.id);
    setBoardError("");
  };

  const confirmRemoveStage = () => {
    if (!removingStageId || !reassignStageId) return;
    removeStage(activeProject.id, removingStageId, reassignStageId);
    setRemovingStageId(null);
    setReassignStageId("");
  };

  const addNewField = () => {
    const name = newFieldName.trim();
    const options = newFieldOptions
      .split(",")
      .map((option) => option.trim())
      .filter(Boolean);
    if (!name) {
      setBoardError("Field name is required.");
      return;
    }
    if (fields.length >= 40) {
      setBoardError("A board can have up to 40 custom fields.");
      return;
    }
    if (
      fields.some(
        (field) =>
          field.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    ) {
      setBoardError("Field names must be unique.");
      return;
    }
    if (newFieldType === "single_select" && options.length === 0) {
      setBoardError("Add at least one comma-separated option.");
      return;
    }
    addFieldDefinition(activeProject.id, {
      name,
      type: newFieldType,
      options,
      showOnCard: true,
    });
    setNewFieldName("");
    setNewFieldOptions("");
    setBoardError("");
  };

  const visibleFields = fields.filter((field) => field.showOnCard).slice(0, 3);
  const editingTask = tasks.find((task) => task.id === editorTaskId);
  const editorIsOpen = Boolean(editingTask);

  useEffect(() => {
    if (!editorIsOpen) return;
    editorAppear.setValue(reduceMotion ? 1 : 0);
    if (reduceMotion) return;
    const appearance = RNAnimated.timing(editorAppear, {
      toValue: 1,
      duration: 170,
      useNativeDriver: Platform.OS !== "web",
    });
    appearance.start();
    return () => appearance.stop();
  }, [editorAppear, editorIsOpen, reduceMotion]);

  const syncNotice =
    syncStatus === "too_large"
      ? "This board is saved on this device but is too large to sync. Remove unused cards or fields, then edit again to retry."
      : syncStatus === "error"
        ? "Cloud sync is unavailable. Your board remains saved on this device."
        : null;

  const renderCard = (
    task: Task,
    stage: KanbanStage,
    columnTasks: Task[],
  ) => {
    const stageIndex = stages.findIndex((item) => item.id === stage.id);
    const taskIndex = columnTasks.findIndex((item) => item.id === task.id);
    const handleDirectMove = (translationX: number, translationY: number) => {
      if (Math.abs(translationX) >= 72) {
        const targetStageIndex = Math.max(
          0,
          Math.min(
            stages.length - 1,
            stageIndex + (translationX > 0 ? 1 : -1),
          ),
        );
        if (targetStageIndex !== stageIndex) {
          const targetStage = stages[targetStageIndex];
          moveCard(
            task,
            targetStage.id,
            tasksForStage(targetStage.id).length,
          );
        }
        return;
      }
      if (Math.abs(translationY) >= 44) {
        const targetPosition = Math.max(
          0,
          Math.min(
            columnTasks.length - 1,
            taskIndex + (translationY > 0 ? 1 : -1),
          ),
        );
        if (targetPosition !== taskIndex) {
          moveCard(task, stage.id, targetPosition);
        }
      }
    };
    return (
      <DraggableKanbanCard key={task.id} onDragEnd={handleDirectMove}>
        <View
          style={[
            styles.kanbanCard,
            { backgroundColor: colors.card, borderColor: colors.border },
            focusedCardId === task.id && { borderColor: colors.primary },
          ]}
          testID={`kanban-card-${task.id}`}
        >
          <TouchableOpacity
            ref={registerCardControl(task.id, "edit")}
            onPress={() => openEditor(task)}
            accessibilityRole="button"
            accessibilityLabel={`Edit task ${task.title}`}
            accessibilityHint="Long press and drag to move this card. Arrow buttons provide the same controls."
            style={styles.kanbanCardMain}
            onFocus={() => setFocusedCardId(task.id)}
            onBlur={() =>
              setFocusedCardId((current) =>
                current === task.id ? null : current,
              )
            }
          >
            <Text
              style={[
                styles.kanbanCardTitle,
                {
                  color: stage.isDone
                    ? colors.mutedForeground
                    : colors.foreground,
                },
                stage.isDone && { textDecorationLine: "line-through" },
              ]}
            >
              {task.title}
            </Text>
            {visibleFields.map((field) => {
              const value = task.values[field.id];
              if (value === undefined || value === "") return null;
              return (
                <View key={field.id} style={styles.cardFieldRow}>
                  <Text
                    style={[
                      styles.cardFieldName,
                      { color: colors.mutedForeground },
                    ]}
                    numberOfLines={1}
                  >
                    {field.name}
                  </Text>
                  <Text
                    style={[
                      styles.cardFieldValue,
                      { color: colors.foreground },
                    ]}
                    numberOfLines={1}
                  >
                    {field.type === "checkbox"
                      ? value
                        ? "Yes"
                        : "No"
                      : String(value)}
                  </Text>
                </View>
              );
            })}
          </TouchableOpacity>
          <View style={styles.cardMoveActions}>
            <TouchableOpacity
              style={[
                styles.cardMoveButton,
                focusedMoveControl === `${task.id}:up` && {
                  borderColor: colors.primary,
                },
              ]}
              onPress={() => moveCard(task, stage.id, taskIndex - 1)}
              disabled={taskIndex === 0}
              accessibilityRole="button"
              accessibilityLabel={`Move ${task.title} up`}
              onFocus={() => setFocusedMoveControl(`${task.id}:up`)}
              onBlur={() => setFocusedMoveControl(null)}
            >
              <Feather
                name="arrow-up"
                size={13}
                color={
                  taskIndex === 0 ? colors.border : colors.mutedForeground
                }
              />
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.cardMoveButton,
                focusedMoveControl === `${task.id}:down` && {
                  borderColor: colors.primary,
                },
              ]}
              onPress={() => moveCard(task, stage.id, taskIndex + 1)}
              disabled={taskIndex === columnTasks.length - 1}
              accessibilityRole="button"
              accessibilityLabel={`Move ${task.title} down`}
              onFocus={() => setFocusedMoveControl(`${task.id}:down`)}
              onBlur={() => setFocusedMoveControl(null)}
            >
              <Feather
                name="arrow-down"
                size={13}
                color={
                  taskIndex === columnTasks.length - 1
                    ? colors.border
                    : colors.mutedForeground
                }
              />
            </TouchableOpacity>
            <View style={styles.cardMoveSpacer} />
            <TouchableOpacity
              style={[
                styles.cardMoveButton,
                focusedMoveControl === `${task.id}:previous` && {
                  borderColor: colors.primary,
                },
              ]}
              onPress={() =>
                moveCard(
                  task,
                  stages[stageIndex - 1].id,
                  tasksForStage(stages[stageIndex - 1].id).length,
                )
              }
              disabled={stageIndex === 0}
              accessibilityRole="button"
              accessibilityLabel={`Move ${task.title} to previous stage`}
              onFocus={() => setFocusedMoveControl(`${task.id}:previous`)}
              onBlur={() => setFocusedMoveControl(null)}
            >
              <Feather
                name="arrow-left"
                size={13}
                color={
                  stageIndex === 0 ? colors.border : colors.mutedForeground
                }
              />
            </TouchableOpacity>
            <TouchableOpacity
              ref={registerCardControl(task.id, "next")}
              style={[
                styles.cardMoveButton,
                focusedMoveControl === `${task.id}:next` && {
                  borderColor: colors.primary,
                },
              ]}
              onPress={() =>
                moveCard(
                  task,
                  stages[stageIndex + 1].id,
                  tasksForStage(stages[stageIndex + 1].id).length,
                )
              }
              disabled={stageIndex === stages.length - 1}
              accessibilityRole="button"
              accessibilityLabel={`Move ${task.title} to next stage`}
              onFocus={() => setFocusedMoveControl(`${task.id}:next`)}
              onBlur={() => setFocusedMoveControl(null)}
            >
              <Feather
                name="arrow-right"
                size={13}
                color={
                  stageIndex === stages.length - 1
                    ? colors.border
                    : colors.mutedForeground
                }
              />
            </TouchableOpacity>
          </View>
        </View>
      </DraggableKanbanCard>
    );
  };

  return (
    <View style={styles.workspaceContainer}>
      <ScrollView
        contentContainerStyle={styles.boardScrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.boardHeader}>
          <View>
            <Text style={[styles.boardTitle, { color: colors.foreground }]}>
              Task Board
            </Text>
            <Text
              style={[styles.boardSubtitle, { color: colors.mutedForeground }]}
            >
              {tasks.length} {tasks.length === 1 ? "card" : "cards"} ·{" "}
              {stages.length} {stages.length === 1 ? "stage" : "stages"}
            </Text>
          </View>
          <TouchableOpacity
            style={[
              styles.boardSettingsButton,
              { borderColor: colors.border, backgroundColor: colors.card },
            ]}
            onPress={() => {
              setShowSettings((shown) => !shown);
              setBoardError("");
            }}
            accessibilityRole="button"
            accessibilityLabel={
              showSettings ? "Close board settings" : "Open board settings"
            }
            testID="board-settings-button"
          >
            <Feather
              name={showSettings ? "x" : "sliders"}
              size={16}
              color={colors.foreground}
            />
          </TouchableOpacity>
        </View>

        {!!syncNotice && (
          <View
            style={[styles.boardError, { borderColor: colors.destructive }]}
            accessibilityRole="alert"
          >
            <Feather
              name="cloud-off"
              size={14}
              color={colors.destructive}
            />
            <Text style={[styles.boardErrorText, { color: colors.foreground }]}>
              {syncNotice}
            </Text>
          </View>
        )}

        {!!boardError && (
          <View
            style={[
              styles.boardError,
              { borderColor: colors.destructive },
            ]}
            accessibilityRole="alert"
          >
            <Feather
              name="alert-circle"
              size={14}
              color={colors.destructive}
            />
            <Text style={[styles.boardErrorText, { color: colors.destructive }]}>
              {boardError}
            </Text>
          </View>
        )}

        {showSettings && (
          <View
            style={[
              styles.boardSettings,
              { borderColor: colors.border, backgroundColor: colors.card },
            ]}
          >
            <Text
              style={[styles.settingsSectionTitle, { color: colors.foreground }]}
            >
              Stages
            </Text>
            <Text
              style={[
                styles.settingsSectionHelp,
                { color: colors.mutedForeground },
              ]}
            >
              Done stages mark cards complete. You can use more than one.
            </Text>
            {stages.map((stage, index) => (
              <View key={stage.id}>
                <View
                  style={[
                    styles.settingsRow,
                    { borderTopColor: colors.border },
                  ]}
                >
                  <TextInput
                    key={stage.id}
                    defaultValue={stage.name}
                    style={[
                      styles.settingsNameInput,
                      { color: colors.foreground, borderColor: colors.border },
                    ]}
                    maxLength={80}
                    accessibilityLabel={`Rename stage ${stage.name}`}
                    onChangeText={(name) => {
                      if (name.trim()) {
                        updateStage(activeProject.id, stage.id, { name });
                      }
                    }}
                    onEndEditing={(event) => {
                      const name = event.nativeEvent.text.trim();
                      if (!name) {
                        setBoardError("Stage name is required.");
                        return;
                      }
                      if (
                        stages.some(
                          (item) =>
                            item.id !== stage.id &&
                            item.name.toLocaleLowerCase() ===
                              name.toLocaleLowerCase(),
                        )
                      ) {
                        setBoardError("Stage names must be unique.");
                        return;
                      }
                      updateStage(activeProject.id, stage.id, { name });
                    }}
                  />
                  <TouchableOpacity
                    style={[
                      styles.doneToggle,
                      {
                        borderColor: stage.isDone
                          ? colors.primary
                          : colors.border,
                        backgroundColor: stage.isDone
                          ? colors.secondary
                          : "transparent",
                      },
                    ]}
                    onPress={() =>
                      stage.isDone &&
                      stages.filter((item) => item.isDone).length === 1
                        ? setBoardError(
                            "Keep at least one done stage so completion remains clear.",
                          )
                        : (updateStage(activeProject.id, stage.id, {
                            isDone: !stage.isDone,
                          }),
                          setBoardError(""))
                    }
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: stage.isDone }}
                    accessibilityLabel={`${stage.name} is a done stage`}
                    aria-checked={stage.isDone}
                  >
                    <Feather
                      name={stage.isDone ? "check-circle" : "circle"}
                      size={13}
                      color={
                        stage.isDone
                          ? colors.foreground
                          : colors.mutedForeground
                      }
                    />
                    <Text
                      style={[
                        styles.doneToggleText,
                        { color: colors.mutedForeground },
                      ]}
                    >
                      Done
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.settingsIconButton}
                    onPress={() =>
                      reorderStage(activeProject.id, stage.id, index - 1)
                    }
                    disabled={index === 0}
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${stage.name} left`}
                  >
                    <Feather
                      name="arrow-left"
                      size={14}
                      color={index === 0 ? colors.border : colors.foreground}
                    />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.settingsIconButton}
                    onPress={() =>
                      reorderStage(activeProject.id, stage.id, index + 1)
                    }
                    disabled={index === stages.length - 1}
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${stage.name} right`}
                  >
                    <Feather
                      name="arrow-right"
                      size={14}
                      color={
                        index === stages.length - 1
                          ? colors.border
                          : colors.foreground
                      }
                    />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.settingsIconButton}
                    onPress={() => beginRemoveStage(stage.id)}
                    disabled={stages.length <= 1}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove stage ${stage.name}`}
                  >
                    <Feather
                      name="trash-2"
                      size={14}
                      color={
                        stages.length <= 1
                          ? colors.border
                          : colors.destructive
                      }
                    />
                  </TouchableOpacity>
                </View>
                {removingStageId === stage.id && (
                  <View
                    style={[
                      styles.confirmPanel,
                      { borderColor: colors.destructive },
                    ]}
                  >
                    <Text
                      style={[
                        styles.confirmTitle,
                        { color: colors.foreground },
                      ]}
                    >
                      Move its {tasksForStage(stage.id).length} cards to:
                    </Text>
                    <View style={styles.choiceWrap}>
                      {stages
                        .filter((item) => item.id !== stage.id)
                        .map((target) => (
                          <TouchableOpacity
                            key={target.id}
                            style={[
                              styles.choiceChip,
                              {
                                borderColor:
                                  reassignStageId === target.id
                                    ? colors.primary
                                    : colors.border,
                                backgroundColor:
                                  reassignStageId === target.id
                                    ? colors.secondary
                                    : "transparent",
                              },
                            ]}
                            onPress={() => setReassignStageId(target.id)}
                            accessibilityRole="radio"
                            accessibilityState={{
                              selected: reassignStageId === target.id,
                            }}
                            accessibilityLabel={`Reassign cards to ${target.name}`}
                            aria-checked={reassignStageId === target.id}
                          >
                            <Text
                              style={[
                                styles.choiceChipText,
                                { color: colors.foreground },
                              ]}
                            >
                              {target.name}
                            </Text>
                          </TouchableOpacity>
                        ))}
                    </View>
                    <View style={styles.confirmActions}>
                      <TouchableOpacity
                        onPress={() => setRemovingStageId(null)}
                        accessibilityRole="button"
                      >
                        <Text
                          style={[
                            styles.textButton,
                            { color: colors.mutedForeground },
                          ]}
                        >
                          Cancel
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={confirmRemoveStage}
                        style={[
                          styles.destructiveButton,
                          { backgroundColor: colors.destructive },
                        ]}
                        accessibilityRole="button"
                      >
                        <Text
                          style={[
                            styles.destructiveButtonText,
                            { color: colors.primaryForeground },
                          ]}
                        >
                          Reassign & remove
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              </View>
            ))}
            <View style={styles.settingsAddRow}>
              <TextInput
                style={[
                  styles.settingsAddInput,
                  { color: colors.foreground, borderColor: colors.border },
                ]}
                value={newStageName}
                onChangeText={setNewStageName}
                placeholder="New stage"
                placeholderTextColor={colors.mutedForeground}
                maxLength={80}
                accessibilityLabel="New stage name"
              />
              <TouchableOpacity
                style={[
                  styles.doneToggle,
                  {
                    borderColor: newStageIsDone
                      ? colors.primary
                      : colors.border,
                  },
                ]}
                onPress={() => setNewStageIsDone((value) => !value)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: newStageIsDone }}
                accessibilityLabel="New stage is a done stage"
                aria-checked={newStageIsDone}
              >
                <Feather
                  name={newStageIsDone ? "check-circle" : "circle"}
                  size={13}
                  color={colors.mutedForeground}
                />
                <Text
                  style={[
                    styles.doneToggleText,
                    { color: colors.mutedForeground },
                  ]}
                >
                  Done
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.settingsAddButton,
                  { backgroundColor: colors.primary },
                ]}
                onPress={addNewStage}
                accessibilityRole="button"
                accessibilityLabel="Add stage"
              >
                <Feather
                  name="plus"
                  size={15}
                  color={colors.primaryForeground}
                />
              </TouchableOpacity>
            </View>

            <View
              style={[styles.settingsDivider, { backgroundColor: colors.border }]}
            />
            <Text
              style={[styles.settingsSectionTitle, { color: colors.foreground }]}
            >
              Card fields
            </Text>
            <Text
              style={[
                styles.settingsSectionHelp,
                { color: colors.mutedForeground },
              ]}
            >
              Choose which values appear on compact cards.
            </Text>
            {fields.map((field, index) => (
              <View key={field.id}>
                <View
                  style={[
                    styles.settingsRow,
                    { borderTopColor: colors.border },
                  ]}
                >
                  <TextInput
                    key={field.id}
                    defaultValue={field.name}
                    style={[
                      styles.settingsNameInput,
                      { color: colors.foreground, borderColor: colors.border },
                    ]}
                    maxLength={80}
                    accessibilityLabel={`Rename field ${field.name}`}
                    onChangeText={(name) => {
                      if (name.trim()) {
                        updateFieldDefinition(activeProject.id, field.id, {
                          name,
                        });
                      }
                    }}
                    onEndEditing={(event) => {
                      const name = event.nativeEvent.text.trim();
                      if (!name) {
                        setBoardError("Field name is required.");
                        return;
                      }
                      if (
                        fields.some(
                          (item) =>
                            item.id !== field.id &&
                            item.name.toLocaleLowerCase() ===
                              name.toLocaleLowerCase(),
                        )
                      ) {
                        setBoardError("Field names must be unique.");
                        return;
                      }
                      updateFieldDefinition(activeProject.id, field.id, {
                        name,
                      })
                      setBoardError("");
                    }}
                  />
                  <Text
                    style={[
                      styles.fieldTypeBadge,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    {FIELD_TYPE_LABELS[field.type]}
                  </Text>
                  <TouchableOpacity
                    style={styles.settingsIconButton}
                    onPress={() =>
                      updateFieldDefinition(activeProject.id, field.id, {
                        showOnCard: !field.showOnCard,
                      })
                    }
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: field.showOnCard }}
                    accessibilityLabel={`Show ${field.name} on cards`}
                    aria-checked={field.showOnCard}
                  >
                    <Feather
                      name={field.showOnCard ? "eye" : "eye-off"}
                      size={14}
                      color={colors.foreground}
                    />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.settingsIconButton}
                    onPress={() =>
                      reorderFieldDefinition(
                        activeProject.id,
                        field.id,
                        index - 1,
                      )
                    }
                    disabled={index === 0}
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${field.name} up`}
                  >
                    <Feather
                      name="arrow-up"
                      size={14}
                      color={index === 0 ? colors.border : colors.foreground}
                    />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.settingsIconButton}
                    onPress={() =>
                      reorderFieldDefinition(
                        activeProject.id,
                        field.id,
                        index + 1,
                      )
                    }
                    disabled={index === fields.length - 1}
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${field.name} down`}
                  >
                    <Feather
                      name="arrow-down"
                      size={14}
                      color={
                        index === fields.length - 1
                          ? colors.border
                          : colors.foreground
                      }
                    />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.settingsIconButton}
                    onPress={() => setPendingDeleteFieldId(field.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove field ${field.name}`}
                  >
                    <Feather
                      name="trash-2"
                      size={14}
                      color={colors.destructive}
                    />
                  </TouchableOpacity>
                </View>
                {field.type === "single_select" && (
                  <TextInput
                    key={`${field.id}-options-${field.updatedAt}`}
                    defaultValue={field.options.join(", ")}
                    style={[
                      styles.fieldOptionsInput,
                      { color: colors.foreground, borderColor: colors.border },
                    ]}
                    accessibilityLabel={`Options for ${field.name}`}
                    onEndEditing={(event) => {
                      const options = event.nativeEvent.text
                        .split(",")
                        .map((option) => option.trim())
                        .filter(Boolean);
                      if (options.length === 0) {
                        setBoardError(
                          `${field.name} needs at least one option.`,
                        );
                        return;
                      }
                      updateFieldDefinition(activeProject.id, field.id, {
                        options,
                      });
                      setBoardError("");
                    }}
                  />
                )}
                {pendingDeleteFieldId === field.id && (
                  <View
                    style={[
                      styles.confirmPanel,
                      { borderColor: colors.destructive },
                    ]}
                  >
                    <Text
                      style={[
                        styles.confirmTitle,
                        { color: colors.foreground },
                      ]}
                    >
                      Remove {field.name} and its values from every card?
                    </Text>
                    <View style={styles.confirmActions}>
                      <TouchableOpacity
                        onPress={() => setPendingDeleteFieldId(null)}
                      >
                        <Text
                          style={[
                            styles.textButton,
                            { color: colors.mutedForeground },
                          ]}
                        >
                          Cancel
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => {
                          removeFieldDefinition(activeProject.id, field.id);
                          setPendingDeleteFieldId(null);
                        }}
                        style={[
                          styles.destructiveButton,
                          { backgroundColor: colors.destructive },
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel={`Confirm removal of ${field.name}`}
                      >
                        <Text
                          style={[
                            styles.destructiveButtonText,
                            { color: colors.primaryForeground },
                          ]}
                        >
                          Remove field
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              </View>
            ))}
            <View style={styles.fieldTypePicker}>
              {(Object.keys(FIELD_TYPE_LABELS) as KanbanFieldType[]).map(
                (type) => (
                  <TouchableOpacity
                    key={type}
                    style={[
                      styles.choiceChip,
                      {
                        borderColor:
                          newFieldType === type
                            ? colors.primary
                            : colors.border,
                        backgroundColor:
                          newFieldType === type
                            ? colors.secondary
                            : "transparent",
                      },
                    ]}
                    onPress={() => setNewFieldType(type)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: newFieldType === type }}
                    accessibilityLabel={`${FIELD_TYPE_LABELS[type]} field type`}
                    aria-checked={newFieldType === type}
                  >
                    <Text
                      style={[
                        styles.choiceChipText,
                        { color: colors.foreground },
                      ]}
                    >
                      {FIELD_TYPE_LABELS[type]}
                    </Text>
                  </TouchableOpacity>
                ),
              )}
            </View>
            <View style={styles.settingsAddRow}>
              <TextInput
                style={[
                  styles.settingsAddInput,
                  { color: colors.foreground, borderColor: colors.border },
                ]}
                value={newFieldName}
                onChangeText={setNewFieldName}
                placeholder="New field"
                placeholderTextColor={colors.mutedForeground}
                maxLength={80}
                accessibilityLabel="New field name"
              />
              <TouchableOpacity
                style={[
                  styles.settingsAddButton,
                  { backgroundColor: colors.primary },
                ]}
                onPress={addNewField}
                accessibilityRole="button"
                accessibilityLabel="Add field"
              >
                <Feather
                  name="plus"
                  size={15}
                  color={colors.primaryForeground}
                />
              </TouchableOpacity>
            </View>
            {newFieldType === "single_select" && (
              <TextInput
                style={[
                  styles.fieldOptionsInput,
                  { color: colors.foreground, borderColor: colors.border },
                ]}
                value={newFieldOptions}
                onChangeText={setNewFieldOptions}
                placeholder="Options, separated by commas"
                placeholderTextColor={colors.mutedForeground}
                accessibilityLabel="New field options"
              />
            )}
          </View>
        )}

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.boardColumnsContainer}
          directionalLockEnabled
          nestedScrollEnabled
          accessibilityLabel="Kanban stages"
        >
          {stages.map((stage) => {
            const columnTasks = tasksForStage(stage.id);
            return (
              <View
                key={stage.id}
                style={[
                  styles.boardColumn,
                  { borderColor: colors.border, backgroundColor: colors.card },
                ]}
                accessibilityRole="list"
                accessibilityLabel={`${stage.name} stage`}
              >
                <View style={styles.boardColumnHeader}>
                  <View style={styles.boardColumnTitleRow}>
                    <Feather
                      name={stage.isDone ? "check-circle" : "circle"}
                      size={13}
                      color={colors.mutedForeground}
                    />
                    <Text
                      style={[
                        styles.boardColumnTitle,
                        { color: colors.foreground },
                      ]}
                      numberOfLines={1}
                    >
                      {stage.name}
                    </Text>
                  </View>
                  <Text
                    style={[
                      styles.boardColumnCount,
                      { color: colors.mutedForeground },
                    ]}
                    accessibilityLabel={`${columnTasks.length} cards`}
                  >
                    {columnTasks.length}
                  </Text>
                </View>
                <View style={styles.boardColumnList}>
                  {columnTasks.length === 0 && addingStageId !== stage.id && (
                    <View
                      style={[
                        styles.columnEmpty,
                        { borderColor: colors.border },
                      ]}
                    >
                      <Text
                        style={[
                          styles.columnEmptyText,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        No cards in {stage.name}
                      </Text>
                    </View>
                  )}
                  {columnTasks.map((task) =>
                    renderCard(task, stage, columnTasks),
                  )}
                  {addingStageId === stage.id ? (
                    <View
                      style={[
                        styles.addTaskForm,
                        { borderColor: colors.border },
                      ]}
                    >
                      <TextInput
                        style={[
                          styles.addTaskInput,
                          {
                            color: colors.foreground,
                            borderColor: colors.border,
                          },
                        ]}
                        placeholder={`Add to ${stage.name}`}
                        placeholderTextColor={colors.mutedForeground}
                        value={newTaskTitle}
                        onChangeText={setNewTaskTitle}
                        autoFocus
                        onSubmitEditing={() => handleAddTask(stage.id)}
                        returnKeyType="done"
                        maxLength={280}
                        accessibilityLabel={`New task title for ${stage.name}`}
                      />
                      <View style={styles.addTaskActions}>
                        <TouchableOpacity
                          onPress={() => {
                            setAddingStageId(null);
                            setNewTaskTitle("");
                          }}
                          accessibilityRole="button"
                        >
                          <Text
                            style={[
                              styles.textButton,
                              { color: colors.mutedForeground },
                            ]}
                          >
                            Cancel
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => handleAddTask(stage.id)}
                          style={[
                            styles.addTaskSubmit,
                            { backgroundColor: colors.primary },
                          ]}
                          accessibilityRole="button"
                        >
                          <Text
                            style={[
                              styles.addTaskSubmitText,
                              { color: colors.primaryForeground },
                            ]}
                          >
                            Add card
                          </Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  ) : (
                    <TouchableOpacity
                      ref={registerAddCardControl(stage.id)}
                      style={[
                        styles.columnAddButton,
                        { borderColor: colors.border },
                        focusedAddCardStageId === stage.id && {
                          borderColor: colors.primary,
                        },
                      ]}
                      onPress={() => {
                        setAddingStageId(stage.id);
                        setNewTaskTitle("");
                        setBoardError("");
                      }}
                      onFocus={() => setFocusedAddCardStageId(stage.id)}
                      onBlur={() =>
                        setFocusedAddCardStageId((current) =>
                          current === stage.id ? null : current,
                        )
                      }
                      accessibilityRole="button"
                      accessibilityLabel={`Add card to ${stage.name}`}
                      testID={`add-task-${stage.id}`}
                    >
                      <Feather
                        name="plus"
                        size={14}
                        color={colors.mutedForeground}
                      />
                      <Text
                        style={[
                          styles.columnAddText,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        Add card
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            );
          })}
        </ScrollView>
      </ScrollView>

      <Modal
        visible={Boolean(editingTask)}
        transparent
        // On web an animated dismissal keeps the dialog (and its focus trap)
        // mounted for the length of the fade, which pulls keyboard focus back
        // into the closing editor. Close immediately there instead.
        animationType={Platform.OS === "web" ? "none" : "fade"}
        onDismiss={handleEditorDismiss}
        onRequestClose={closeEditor}
      >
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior="padding"
        >
          <RNAnimated.View
            style={[
              styles.cardEditor,
              { backgroundColor: colors.background, borderColor: colors.border },
              {
                opacity: editorAppear,
                transform: [
                  {
                    translateY: editorAppear.interpolate({
                      inputRange: [0, 1],
                      outputRange: [10, 0],
                    }),
                  },
                ],
              },
            ]}
            accessibilityViewIsModal
            accessibilityLabel="Card editor"
          >
            <ScrollView
              contentContainerStyle={styles.cardEditorContent}
              keyboardShouldPersistTaps="handled"
            >
              <View style={styles.cardEditorHeader}>
                <Text
                  style={[styles.cardEditorTitle, { color: colors.foreground }]}
                >
                  Edit card
                </Text>
                <TouchableOpacity
                  style={styles.settingsIconButton}
                  onPress={closeEditor}
                  accessibilityRole="button"
                  accessibilityLabel="Close card editor"
                >
                  <Feather name="x" size={18} color={colors.foreground} />
                </TouchableOpacity>
              </View>
              <Text style={[styles.formLabel, { color: colors.foreground }]}>
                Title
              </Text>
              <TextInput
                style={[
                  styles.editorInput,
                  { color: colors.foreground, borderColor: colors.border },
                ]}
                value={editorTitle}
                onChangeText={setEditorTitle}
                maxLength={280}
                accessibilityLabel="Task title"
                autoFocus
              />
              <Text style={[styles.formLabel, { color: colors.foreground }]}>
                Stage
              </Text>
              <View style={styles.choiceWrap}>
                {stages.map((stage) => (
                  <TouchableOpacity
                    key={stage.id}
                    style={[
                      styles.choiceChip,
                      {
                        borderColor:
                          editorStageId === stage.id
                            ? colors.primary
                            : colors.border,
                        backgroundColor:
                          editorStageId === stage.id
                            ? colors.secondary
                            : "transparent",
                      },
                    ]}
                    onPress={() => setEditorStageId(stage.id)}
                    accessibilityRole="radio"
                    accessibilityState={{
                      selected: editorStageId === stage.id,
                    }}
                    accessibilityLabel={`Move card to ${stage.name}`}
                    aria-checked={editorStageId === stage.id}
                  >
                    <Feather
                      name={stage.isDone ? "check-circle" : "circle"}
                      size={12}
                      color={colors.mutedForeground}
                    />
                    <Text
                      style={[
                        styles.choiceChipText,
                        { color: colors.foreground },
                      ]}
                    >
                      {stage.name}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              {fields.map((field) => (
                <View key={field.id} style={styles.editorField}>
                  <Text style={[styles.formLabel, { color: colors.foreground }]}>
                    {field.name}
                  </Text>
                  {field.type === "checkbox" ? (
                    <TouchableOpacity
                      style={[
                        styles.checkboxField,
                        { borderColor: colors.border },
                      ]}
                      onPress={() =>
                        setEditorValues((values) => ({
                          ...values,
                          [field.id]: values[field.id] !== true,
                        }))
                      }
                      accessibilityRole="checkbox"
                      accessibilityState={{
                        checked: editorValues[field.id] === true,
                      }}
                      accessibilityLabel={field.name}
                      aria-checked={editorValues[field.id] === true}
                    >
                      <Feather
                        name={
                          editorValues[field.id] === true
                            ? "check-square"
                            : "square"
                        }
                        size={17}
                        color={colors.foreground}
                      />
                      <Text
                        style={[
                          styles.checkboxFieldText,
                          { color: colors.foreground },
                        ]}
                      >
                        {editorValues[field.id] === true ? "Yes" : "No"}
                      </Text>
                    </TouchableOpacity>
                  ) : field.type === "single_select" ? (
                    <View style={styles.choiceWrap}>
                      <TouchableOpacity
                        style={[
                          styles.choiceChip,
                          { borderColor: colors.border },
                        ]}
                        onPress={() =>
                          setEditorValues((values) => ({
                            ...values,
                            [field.id]: "",
                          }))
                        }
                        accessibilityRole="radio"
                        accessibilityState={{
                          selected: !editorValues[field.id],
                        }}
                        accessibilityLabel={`Clear ${field.name}`}
                        aria-checked={!editorValues[field.id]}
                      >
                        <Text
                          style={[
                            styles.choiceChipText,
                            { color: colors.mutedForeground },
                          ]}
                        >
                          None
                        </Text>
                      </TouchableOpacity>
                      {field.options.map((option) => (
                        <TouchableOpacity
                          key={option}
                          style={[
                            styles.choiceChip,
                            {
                              borderColor:
                                editorValues[field.id] === option
                                  ? colors.primary
                                  : colors.border,
                            },
                          ]}
                          onPress={() =>
                            setEditorValues((values) => ({
                              ...values,
                              [field.id]: option,
                            }))
                          }
                          accessibilityRole="radio"
                          accessibilityState={{
                            selected: editorValues[field.id] === option,
                          }}
                          accessibilityLabel={`Set ${field.name} to ${option}`}
                          aria-checked={editorValues[field.id] === option}
                        >
                          <Text
                            style={[
                              styles.choiceChipText,
                              { color: colors.foreground },
                            ]}
                          >
                            {option}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  ) : (
                    <TextInput
                      style={[
                        styles.editorInput,
                        {
                          color: colors.foreground,
                          borderColor: colors.border,
                        },
                      ]}
                      value={
                        typeof editorValues[field.id] === "string"
                          ? String(editorValues[field.id])
                          : ""
                      }
                      onChangeText={(value) =>
                        setEditorValues((values) => ({
                          ...values,
                          [field.id]: value,
                        }))
                      }
                      keyboardType={
                        field.type === "number" ? "decimal-pad" : "default"
                      }
                      placeholder={
                        field.type === "date" ? "YYYY-MM-DD" : undefined
                      }
                      placeholderTextColor={colors.mutedForeground}
                      accessibilityLabel={field.name}
                      maxLength={field.type === "text" ? 1000 : 80}
                    />
                  )}
                </View>
              ))}
              {!!boardError && (
                <Text
                  style={[
                    styles.editorError,
                    { color: colors.destructive },
                  ]}
                  accessibilityRole="alert"
                >
                  {boardError}
                </Text>
              )}
              {pendingDeleteTaskId === editorTaskId ? (
                <View
                  style={[
                    styles.confirmPanel,
                    { borderColor: colors.destructive },
                  ]}
                >
                  <Text
                    style={[styles.confirmTitle, { color: colors.foreground }]}
                  >
                    Delete this card? This cannot be undone.
                  </Text>
                  <View style={styles.confirmActions}>
                    <TouchableOpacity
                      onPress={() => setPendingDeleteTaskId(null)}
                      accessibilityRole="button"
                    >
                      <Text
                        style={[
                          styles.textButton,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        Cancel
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={deleteEditedTask}
                      style={[
                        styles.destructiveButton,
                        { backgroundColor: colors.destructive },
                      ]}
                      accessibilityRole="button"
                      testID="confirm-delete-card"
                    >
                      <Text
                        style={[
                          styles.destructiveButtonText,
                          { color: colors.primaryForeground },
                        ]}
                      >
                        Delete card
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <TouchableOpacity
                  style={styles.deleteCardButton}
                  onPress={() => setPendingDeleteTaskId(editorTaskId)}
                  accessibilityRole="button"
                >
                  <Feather
                    name="trash-2"
                    size={14}
                    color={colors.destructive}
                  />
                  <Text
                    style={[
                      styles.deleteCardText,
                      { color: colors.destructive },
                    ]}
                  >
                    Delete card
                  </Text>
                </TouchableOpacity>
              )}
            </ScrollView>
            <View
              style={[
                styles.cardEditorFooter,
                { borderTopColor: colors.border },
              ]}
            >
              <TouchableOpacity
                onPress={closeEditor}
                style={styles.editorCancelButton}
                accessibilityRole="button"
              >
                <Text
                  style={[
                    styles.editorCancelText,
                    { color: colors.mutedForeground },
                  ]}
                >
                  Cancel
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={saveTask}
                style={[
                  styles.editorSaveButton,
                  { backgroundColor: colors.primary },
                ]}
                accessibilityRole="button"
                testID="save-card-button"
              >
                <Text
                  style={[
                    styles.editorSaveText,
                    { color: colors.primaryForeground },
                  ]}
                >
                  Save card
                </Text>
              </TouchableOpacity>
            </View>
          </RNAnimated.View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function FeedWorkspace({
  activeProject,
  onOpenConversation,
}: {
  activeProject: any;
  onOpenConversation: (conversationId: string) => void;
}) {
  const colors = useColors();
  const { state } = useVenom();
  const router = useRouter();
  const { userId: feedUserId } = useAuth();

  const appsQuery = useListVenomApps({
    query: {
      enabled: Boolean(feedUserId),
      retry: 1,
      queryKey: getListVenomAppsQueryKey(),
    },
  });
  const improvementSuggestions = (appsQuery.data ?? []).filter(
    (app) => app.improvementSignal,
  );
  const [dismissingSuggestionId, setDismissingSuggestionId] = useState("");
  const handleDismissSuggestion = async (appId: string) => {
    setDismissingSuggestionId(appId);
    try {
      await dismissVenomAppImprovementSuggestion(appId);
      await appsQuery.refetch();
    } catch {
      // Keep the card visible so the user can retry from here or the record.
    } finally {
      setDismissingSuggestionId("");
    }
  };

  const feedItems = useMemo(() => {
    if (!activeProject) return [];

    // Previews reuse the chat renderer's view of citations so inline
    // `[source:...]` markers read as source names instead of raw text.
    const citationsById = new Map(
      (state.sources ?? [])
        .filter(
          (source: ProjectSource) =>
            source.projectId === activeProject.id &&
            source.status === "connected",
        )
        .flatMap((source: ProjectSource) =>
          source.citations.map((citation) => [citation.id, citation] as const),
        ),
    );
    const archivedCitationsById = new Map(
      (state.archivedCitations ?? []).map(
        (archived) => [archived.id, archived] as const,
      ),
    );

    const conversations = state.conversations
      .filter((conversation) => conversation.projectId === activeProject.id)
      .map((conversation) => {
        const latestMessage =
          conversation.messages[conversation.messages.length - 1];
        const preview = latestMessage
          ? messageCitationPlainText(
              latestMessage.content,
              citationsById,
              archivedCitationsById,
            )
          : "";
        return {
          id: `conversation-${conversation.id}`,
          type: "conversation" as const,
          icon: "message-square" as const,
          label: "Conversation",
          title: conversation.title,
          detail: preview || "A new conversation is ready.",
          timestamp: conversation.updatedAt,
          conversationId: conversation.id,
        };
      });

    const stageById = new Map(
      (activeProject.boardStages as KanbanStage[]).map((stage) => [
        stage.id,
        stage,
      ]),
    );
    const tasks = activeProject.tasks.map((task: Task) => {
      const stage = stageById.get(task.stageId);
      const stageName = stage?.name ?? "Unknown stage";
      return {
        id: `task-${task.id}`,
        type: "task" as const,
        icon: stage?.isDone
          ? ("check-circle" as const)
          : ("columns" as const),
        label: stage?.isDone ? "Completed task" : "Project task",
        title: task.title,
        detail: stage?.isDone
          ? `Completed in ${stageName}`
          : `Currently in ${stageName}`,
        timestamp: task.updatedAt,
        conversationId: undefined,
      };
    });

    const clusters = state.clusters
      .filter((cluster) => cluster.projectId === activeProject.id)
      .map((cluster) => ({
        id: `cluster-${cluster.id}`,
        type: "knowledge" as const,
        icon: "hexagon" as const,
        label: "Knowledge note",
        title: cluster.label,
        // Knowledge entries are summarized from the same answer text as the
        // conversation previews above, so they resolve markers the same way.
        detail:
          knowledgeDisplayText(cluster.summary, {
            citationsById,
            archivedById: archivedCitationsById,
          }) || "A knowledge note is ready.",
        timestamp: cluster.lastUpdatedAt,
        conversationId: undefined,
      }));

    return [...conversations, ...tasks, ...clusters]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 12);
  }, [
    activeProject,
    state.conversations,
    state.clusters,
    state.sources,
    state.archivedCitations,
  ]);

  return (
    <View style={styles.workspaceContainer}>
      <ScrollView
        contentContainerStyle={styles.feedScrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.feedHeader}>
          <View>
            <Text
              style={[styles.feedEyebrow, { color: colors.mutedForeground }]}
            >
              {activeProject?.name || "Workspace"}
            </Text>
            <Text style={[styles.feedTitle, { color: colors.foreground }]}>
              Feed
            </Text>
          </View>
          <Feather name="rss" size={18} color={colors.foreground} />
        </View>

        {improvementSuggestions.slice(0, 3).map((app) => (
          <TouchableOpacity
            key={`improve-${app.id}`}
            accessibilityRole="button"
            accessibilityLabel={`New data for ${app.name} since its last version. Open the portfolio to review an iteration.`}
            onPress={() => router.push("/apps" as never)}
            style={[
              styles.feedSuggestionCard,
              { backgroundColor: colors.foreground },
            ]}
            testID={`feed-suggestion-${app.id}`}
          >
            <View style={styles.feedSuggestionTop}>
              <Feather name="zap" size={13} color={colors.background} />
              <Text
                style={[
                  styles.feedSuggestionLabel,
                  { color: colors.background },
                ]}
              >
                Improvement suggestion
              </Text>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`Dismiss improvement suggestion for ${app.name}`}
                testID={`button-feed-dismiss-${app.id}`}
                disabled={dismissingSuggestionId === app.id}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                onPress={() => void handleDismissSuggestion(app.id)}
                style={{ marginLeft: "auto", padding: 2 }}
              >
                {dismissingSuggestionId === app.id ? (
                  <ActivityIndicator size="small" color={colors.background} />
                ) : (
                  <Feather name="x" size={14} color={colors.background} />
                )}
              </TouchableOpacity>
            </View>
            <Text
              style={[styles.feedSuggestionTitle, { color: colors.background }]}
              numberOfLines={1}
            >
              {app.name}
            </Text>
            <Text
              style={[styles.feedSuggestionCopy, { color: colors.background }]}
              numberOfLines={2}
            >
              {app.improvementSignal?.summary}
            </Text>
            <Text
              style={[styles.feedSuggestionHint, { color: colors.background }]}
            >
              Review first — nothing runs on its own
            </Text>
          </TouchableOpacity>
        ))}

        {feedItems.length === 0 ? (
          <View style={styles.feedEmpty}>
            <View
              style={[
                styles.feedEmptyIcon,
                { backgroundColor: colors.secondary },
              ]}
            >
              <Feather name="rss" size={22} color={colors.foreground} />
            </View>
            <Text style={[styles.feedEmptyTitle, { color: colors.foreground }]}>
              Your feed is quiet
            </Text>
            <Text
              style={[styles.feedEmptyText, { color: colors.mutedForeground }]}
            >
              Start a conversation or create a task to see project activity
              here.
            </Text>
          </View>
        ) : (
          <View style={styles.feedList}>
            {feedItems.map((item) => (
              <TouchableOpacity
                key={item.id}
                style={[
                  styles.feedCard,
                  { backgroundColor: colors.card, borderColor: colors.border },
                ]}
                onPress={() =>
                  item.conversationId && onOpenConversation(item.conversationId)
                }
                disabled={!item.conversationId}
                activeOpacity={0.75}
                accessibilityRole={item.conversationId ? "button" : "text"}
                accessibilityLabel={`${item.label}: ${item.title}`}
                testID={`feed-card-${item.type}`}
              >
                <View
                  style={[
                    styles.feedIcon,
                    { backgroundColor: colors.secondary },
                  ]}
                >
                  <Feather
                    name={item.icon}
                    size={15}
                    color={colors.foreground}
                  />
                </View>
                <View style={styles.feedCardBody}>
                  <View style={styles.feedCardMeta}>
                    <Text
                      style={[
                        styles.feedCardLabel,
                        { color: colors.mutedForeground },
                      ]}
                    >
                      {item.label}
                    </Text>
                    <Text
                      style={[
                        styles.feedCardTime,
                        { color: colors.mutedForeground },
                      ]}
                    >
                      {new Date(item.timestamp).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </Text>
                  </View>
                  <Text
                    style={[styles.feedCardTitle, { color: colors.foreground }]}
                    numberOfLines={2}
                  >
                    {item.title}
                  </Text>
                  <Text
                    style={[
                      styles.feedCardDetail,
                      { color: colors.mutedForeground },
                    ]}
                    numberOfLines={2}
                  >
                    {item.detail}
                  </Text>
                </View>
                {item.conversationId && (
                  <Feather
                    name="arrow-up-right"
                    size={15}
                    color={colors.mutedForeground}
                  />
                )}
              </TouchableOpacity>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// --- Main Screen ---

export default function WorkspaceScreen() {
  const router = useRouter();
  const { userId: workspaceUserId } = useAuth();
  const colors = useColors();
  const { theme, toggleTheme } = useTheme();
  const insets = useSafeAreaInsets();
  const {
    state,
    isReady,
    syncStatus,
    hasPendingLegacyImport,
    importDeviceWorkspace,
    startFreshWorkspace,
    setActiveConversation,
    setActiveProject,
  } = useVenom();

  const [activeIndex, setActiveIndex] = useState(0);
  const [focusedTabIndex, setFocusedTabIndex] = useState<number | null>(null);
  const tabRefs = useRef<Array<WorkspaceTabHandle | null>>([]);
  const projectSwitcherRef = useRef<{ focus?: () => void } | null>(null);
  const [projectSwitcherFocused, setProjectSwitcherFocused] = useState(false);
  const { data: notificationCount } =
    useGetCommunityNotificationUnreadCount({
      query: {
        queryKey: [
          ...getGetCommunityNotificationUnreadCountQueryKey(),
          "account",
          workspaceUserId ?? "ui-test",
        ],
        refetchInterval: 15000,
      },
    });
  const unreadNotificationCount = notificationCount?.count ?? 0;
  const activeProject =
    state.projects.find((p) => p.id === state.activeProjectId) ||
    state.projects[0];

  // Creating a project closes its dialog by popping straight back to this
  // screen, so that dialog cannot hand keyboard focus anywhere itself — its
  // whole screen unmounts (see projects.tsx). It records the intent instead,
  // and this claims it once the workspace is back on screen, landing focus on
  // the switcher that now names the project the user just created.
  useFocusEffect(
    useCallback(() => {
      if (!claimFocusHandoff("project-switcher")) return;
      const frame = requestAnimationFrame(() => {
        projectSwitcherRef.current?.focus?.();
      });
      return () => cancelAnimationFrame(frame);
    }, []),
  );

  const handleTabPress = useCallback((index: number) => {
    setActiveIndex(index);
    if (Platform.OS !== "web") {
      Haptics.selectionAsync();
    }
  }, []);

  const focusTab = useCallback((index: number) => {
    tabRefs.current[index]?.focus?.();
  }, []);

  const handleTabKeyDown = useCallback(
    (event: WebKeyboardEvent, index: number) => {
      const key = event.nativeEvent?.key ?? event.key;
      let nextIndex: number | null = null;

      if (key === "ArrowRight") {
        nextIndex = (index + 1) % WORKSPACE_TABS.length;
      } else if (key === "ArrowLeft") {
        nextIndex =
          (index - 1 + WORKSPACE_TABS.length) % WORKSPACE_TABS.length;
      } else if (key === "Home") {
        nextIndex = 0;
      } else if (key === "End") {
        nextIndex = WORKSPACE_TABS.length - 1;
      } else if (key === "Enter" || key === " ") {
        event.preventDefault?.();
        handleTabPress(index);
        return;
      } else {
        return;
      }

      event.preventDefault?.();
      focusTab(nextIndex);
    },
    [focusTab, handleTabPress],
  );

  useEffect(() => {
    if (Platform.OS !== "web" || !isReady || hasPendingLegacyImport) {
      return;
    }

    const listeners = tabRefs.current.map((element, index) => {
      const listener = (event: WebKeyboardEvent) =>
        handleTabKeyDown(event, index);
      element?.addEventListener?.("keydown", listener);
      return { element, listener };
    });

    return () => {
      listeners.forEach(({ element, listener }) => {
        element?.removeEventListener?.("keydown", listener);
      });
    };
  }, [handleTabKeyDown, hasPendingLegacyImport, isReady]);

  const workspaceSwipeResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gestureState) =>
          activeIndex !== 3 &&
          activeIndex !== 4 &&
          Math.abs(gestureState.dx) > 18 &&
          Math.abs(gestureState.dx) > Math.abs(gestureState.dy) * 1.5,
        onPanResponderRelease: (_, gestureState) => {
          if (
            gestureState.dx < -70 &&
            activeIndex < WORKSPACE_TABS.length - 1
          ) {
            handleTabPress(activeIndex + 1);
          } else if (gestureState.dx > 70 && activeIndex > 0) {
            handleTabPress(activeIndex - 1);
          }
        },
      }),
    [activeIndex, handleTabPress],
  );

  const handleOpenConversation = (conversationId: string) => {
    const conversation = state.conversations.find(
      (item) => item.id === conversationId,
    );
    if (!conversation) return;

    setActiveProject(conversation.projectId);
    setActiveConversation(conversation.id);
    handleTabPress(0);
  };

  if (!isReady) {
    return (
      <View
        style={[
          styles.restoreContainer,
          { backgroundColor: colors.background },
        ]}
      >
        <ActivityIndicator size="small" color={colors.primary} />
        <Text
          style={[styles.restoreText, { color: colors.mutedForeground }]}
        >
          Restoring workspace
        </Text>
      </View>
    );
  }

  if (hasPendingLegacyImport) {
    return (
      <View
        style={[
          styles.migrationContainer,
          { backgroundColor: colors.background },
        ]}
      >
        <View
          style={[
            styles.migrationCard,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <View
            style={[
              styles.migrationIcon,
              { backgroundColor: colors.secondary },
            ]}
          >
            <Feather name="hard-drive" size={22} color={colors.primary} />
          </View>
          <Text
            style={[styles.migrationTitle, { color: colors.foreground }]}
          >
            Workspace found on this device
          </Text>
          <Text
            style={[
              styles.migrationDescription,
              { color: colors.mutedForeground },
            ]}
          >
            Choose whether to securely attach the existing local workspace to
            this account. Nothing is uploaded until you confirm.
          </Text>
          <TouchableOpacity
            testID="import-device-workspace"
            style={[
              styles.migrationPrimary,
              { backgroundColor: colors.primary },
            ]}
            activeOpacity={0.78}
            onPress={importDeviceWorkspace}
          >
            <Text
              style={[
                styles.migrationPrimaryText,
                { color: colors.primaryForeground },
              ]}
            >
              Keep and sync
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="start-fresh-workspace"
            style={[
              styles.migrationSecondary,
              { borderColor: colors.border },
            ]}
            activeOpacity={0.7}
            onPress={startFreshWorkspace}
          >
            <Text
              style={[
                styles.migrationSecondaryText,
                { color: colors.mutedForeground },
              ]}
            >
              Start fresh instead
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={0}
    >
      {/* Custom Header Nav */}
      <View
        style={[
          styles.topNav,
          {
            paddingTop: Math.max(insets.top, Platform.OS === "web" ? 67 : 16),
            backgroundColor: colors.background,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.navTabsScroll}
          contentContainerStyle={styles.navTabs}
          accessibilityRole="tablist"
        >
          {WORKSPACE_TABS.map((title, i) => {
            const isActive = activeIndex === i;
            const isFocused = focusedTabIndex === i;
            return (
              <TouchableOpacity
                key={title}
                ref={(element) => {
                  tabRefs.current[i] =
                    element as unknown as WorkspaceTabHandle | null;
                }}
                onPress={() => handleTabPress(i)}
                onFocus={() => setFocusedTabIndex(i)}
                onBlur={() =>
                  setFocusedTabIndex((currentIndex) =>
                    currentIndex === i ? null : currentIndex,
                  )
                }
                style={[
                  styles.navTab,
                  isFocused && [
                    styles.navTabFocused,
                    { outlineColor: colors.foreground },
                  ],
                ]}
                hitSlop={10}
                testID={`workspace-tab-${title.toLowerCase().replace("-", "")}`}
                accessibilityRole="tab"
                accessibilityLabel={
                  title === "Notifications" && unreadNotificationCount > 0
                    ? `Open Notifications workspace, ${unreadNotificationCount} unread`
                    : `Open ${title} workspace`
                }
                accessibilityState={{ selected: isActive }}
                aria-selected={isActive}
                {...(Platform.OS === "web"
                  ? {
                      tabIndex:
                        focusedTabIndex === null
                          ? isActive
                            ? 0
                            : -1
                          : isFocused
                            ? 0
                            : -1,
                    }
                  : {})}
              >
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  <Text
                    style={[
                      styles.navTabText,
                      {
                        color: isActive
                          ? colors.foreground
                          : colors.mutedForeground,
                        fontFamily: isActive
                          ? "Inter_600SemiBold"
                          : "Inter_500Medium",
                      },
                    ]}
                  >
                    {title}
                  </Text>
                  {title === "Notifications" && (
                    <NotificationBadge count={unreadNotificationCount} />
                  )}
                </View>
                {isActive && (
                  <View
                    style={[
                      styles.navTabActiveLine,
                      { backgroundColor: colors.primary },
                    ]}
                  />
                )}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
        <View style={styles.navActions}>
          <TouchableOpacity
            onPress={() => router.push("/sops" as never)}
            style={styles.navIconButton}
            testID="open-sops"
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Open procedures library"
          >
            <Feather name="file-text" size={17} color={colors.foreground} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={toggleTheme}
            style={styles.themeButton}
            accessibilityRole="switch"
            accessibilityLabel={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            accessibilityState={{ checked: theme === "dark" }}
            testID="theme-toggle"
            hitSlop={8}
          >
            <Feather
              name={theme === "light" ? "moon" : "sun"}
              size={17}
              color={colors.foreground}
            />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => router.push("/settings")}
            style={styles.navIconButton}
            testID="open-settings"
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={
              syncStatus === "synced"
                ? "Open settings. Workspace synced."
                : `Open settings. Workspace sync status: ${syncStatus.replace("_", " ")}.`
            }
          >
            <Feather
              name={syncStatus === "synced" ? "cloud" : "cloud-off"}
              size={17}
              color={
                syncStatus === "synced"
                  ? colors.primary
                  : colors.mutedForeground
              }
            />
          </TouchableOpacity>
          <TouchableOpacity
            ref={(node: { focus?: () => void } | null) => {
              projectSwitcherRef.current = node;
            }}
            style={[
              styles.navProject,
              {
                borderColor: projectSwitcherFocused
                  ? colors.primary
                  : "transparent",
              },
            ]}
            activeOpacity={0.7}
            onPress={() => router.push("/projects")}
            onFocus={() => setProjectSwitcherFocused(true)}
            onBlur={() => setProjectSwitcherFocused(false)}
            testID="open-projects"
            accessibilityRole="button"
            accessibilityLabel={`Open projects. Current project: ${activeProject?.name || "Workspace"}.`}
          >
            <Text
              style={[styles.navProjectText, { color: colors.foreground }]}
              numberOfLines={1}
            >
              {activeProject?.name || "Workspace"}
            </Text>
            <Feather
              name="chevron-down"
              size={14}
              color={colors.mutedForeground}
            />
          </TouchableOpacity>
        </View>
      </View>

      <View
        style={styles.workspacePager}
        {...workspaceSwipeResponder.panHandlers}
      >
        <View
          testID="workspace-chat"
          style={[
            styles.workspacePage,
            activeIndex !== 0 && styles.workspacePageHidden,
          ]}
        >
          <ChatWorkspace
            isActive={activeIndex === 0}
            activeProject={activeProject}
          />
        </View>
        <View
          testID="workspace-feed"
          style={[
            styles.workspacePage,
            activeIndex !== 1 && styles.workspacePageHidden,
          ]}
        >
          <CommunityBriefing isActive={activeIndex === 1} />
        </View>
        <View
          testID="workspace-notifications"
          style={[
            styles.workspacePage,
            activeIndex !== 2 && styles.workspacePageHidden,
          ]}
        >
          <CommunityNotifications isActive={activeIndex === 2} />
        </View>
        <View
          testID="workspace-brain"
          style={[
            styles.workspacePage,
            activeIndex !== 3 && styles.workspacePageHidden,
          ]}
        >
          <KnowledgeWorkspace
            isActive={activeIndex === 3}
            onOpenConversation={handleOpenConversation}
          />
        </View>
        <View
          testID="workspace-todo"
          style={[
            styles.workspacePage,
            activeIndex !== 4 && styles.workspacePageHidden,
          ]}
        >
          <BoardWorkspace activeProject={activeProject} />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  restoreContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  restoreText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  migrationContainer: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  migrationCard: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 24,
  },
  migrationIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 22,
  },
  migrationTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 24,
    letterSpacing: -0.5,
  },
  migrationDescription: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    lineHeight: 21,
    marginTop: 10,
    marginBottom: 24,
  },
  migrationPrimary: {
    minHeight: 50,
    borderRadius: 25,
    alignItems: "center",
    justifyContent: "center",
  },
  migrationPrimaryText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  migrationSecondary: {
    minHeight: 50,
    borderWidth: 1,
    borderRadius: 25,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 12,
  },
  migrationSecondaryText: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  topNav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 0,
    borderBottomWidth: 1,
    zIndex: 10,
  },
  navTabs: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingRight: 8,
  },
  navTabsScroll: {
    flexShrink: 1,
  },
  navTab: {
    paddingVertical: 12,
    position: "relative",
    borderRadius: 6,
  },
  navTabFocused: {
    backgroundColor: "rgba(128, 128, 128, 0.2)",
    outlineStyle: "solid",
    outlineWidth: 2,
    outlineOffset: 2,
  },
  navTabText: {
    fontSize: 15,
  },
  navTabActiveLine: {
    position: "absolute",
    bottom: -1,
    left: 0,
    right: 0,
    height: 2,
    borderRadius: 1,
  },
  navProject: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
    marginLeft: 4,
    borderWidth: 1,
    borderRadius: 9,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  navActions: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
    marginLeft: 8,
  },
  themeButton: {
    width: 30,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  navIconButton: {
    width: 30,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  navProjectText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    flexShrink: 1,
  },
  workspacePager: {
    flex: 1,
    width: "100%",
  },
  workspacePage: {
    flex: 1,
    width: "100%",
  },
  workspacePageHidden: {
    display: "none",
  },
  workspaceContainer: {
    flex: 1,
  },
  feedScrollContent: {
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 40,
  },
  feedSuggestionCard: {
    borderRadius: 16,
    gap: 5,
    marginBottom: 14,
    padding: 16,
  },
  feedSuggestionTop: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
  },
  feedSuggestionLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    opacity: 0.7,
  },
  feedSuggestionTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 15,
  },
  feedSuggestionCopy: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 18,
    opacity: 0.78,
  },
  feedSuggestionHint: {
    fontFamily: "Inter_500Medium",
    fontSize: 9,
    letterSpacing: 0.6,
    marginTop: 3,
    opacity: 0.55,
    textTransform: "uppercase",
  },
  feedHeader: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    marginBottom: 24,
  },
  feedEyebrow: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    letterSpacing: 0,
    marginBottom: 6,
  },
  feedTitle: {
    fontSize: 30,
    fontFamily: "Inter_700Bold",
    letterSpacing: -1,
  },
  feedList: {
    gap: 10,
  },
  feedCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    gap: 12,
  },
  feedIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  feedCardBody: {
    flex: 1,
    minWidth: 0,
  },
  feedCardMeta: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 5,
  },
  feedCardLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0,
  },
  feedCardTime: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
  feedCardTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    lineHeight: 21,
    marginBottom: 4,
  },
  feedCardDetail: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 19,
  },
  feedEmpty: {
    alignItems: "center",
    paddingTop: 110,
    paddingHorizontal: 28,
  },
  feedEmptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  feedEmptyTitle: {
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 8,
  },
  feedEmptyText: {
    textAlign: "center",
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 21,
  },

  // Chat Styles
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  chatList: {
    flex: 1,
  },
  messageRow: {
    marginBottom: 24,
    flexDirection: "row",
  },
  messageUser: {
    justifyContent: "flex-end",
  },
  messageAssistant: {
    justifyContent: "flex-start",
  },
  messageWrap: {
    maxWidth: "85%",
    flexShrink: 1,
  },
  messageBubble: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 20,
  },
  bubbleUser: {
    borderBottomRightRadius: 4,
  },
  bubbleAssistant: {
    borderBottomLeftRadius: 4,
    backgroundColor: "transparent",
  },
  messageText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    lineHeight: 24,
  },
  messageAttribution: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    marginTop: 4,
    marginLeft: 4,
    letterSpacing: 0.1,
  },
  errorBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: 6,
  },
  errorBadgeText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
  },
  citationLink: {
    fontFamily: "Inter_600SemiBold",
    textDecorationLine: "underline",
  },
  citedSourceRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 8,
    marginLeft: 4,
  },
  citedSourceChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: "100%",
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  citedSourceChipText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    flexShrink: 1,
  },
  citedSourceChipMeta: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
  },
  citationArchived: {
    fontStyle: "italic",
  },
  citationArchivedLink: {
    fontStyle: "italic",
    textDecorationLine: "underline",
  },
  workspaceChipRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingHorizontal: 16,
    paddingBottom: 6,
  },
  workspaceChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    maxWidth: 220,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  workspaceChipText: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    flexShrink: 1,
  },
  modelSelectorRow: {
    marginBottom: 8,
  },
  modelSelectorScroll: {
    paddingHorizontal: 0,
    gap: 6,
    flexDirection: "row",
  },
  modelChip: {
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  modelChipText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    letterSpacing: 0.1,
  },
  // Both header-slot views render inside the list's padded content
  // container, so they carry no horizontal inset of their own — otherwise
  // they sit 16px right of the message column they hand off to.
  typingContainer: {
    paddingVertical: 12,
    marginBottom: 16,
    alignItems: "flex-start",
  },
  deliberationPanel: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 10,
    gap: 8,
    marginBottom: 16,
  },
  deliberationHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    paddingHorizontal: 4,
    paddingTop: 2,
  },
  deliberationHeaderTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
  },
  deliberationHeaderMeta: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    flexShrink: 1,
  },
  deliberationVoiceCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    gap: 6,
  },
  deliberationVoiceHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  deliberationVoiceName: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    flexShrink: 1,
  },
  deliberationVoiceModel: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    marginLeft: "auto",
  },
  deliberationDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  deliberationTakeText: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 18,
  },
  deliberationResult: {
    marginTop: 8,
    gap: 8,
    alignSelf: "stretch",
  },
  deliberationDisagreements: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    gap: 6,
  },
  deliberationDisagreeHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  deliberationDisagreeTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
  },
  deliberationDisagreeItem: {
    flexDirection: "row",
    gap: 8,
  },
  deliberationDisagreeBullet: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    marginTop: 8,
  },
  deliberationDisagreeText: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 20,
    flex: 1,
  },
  deliberationAgreement: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    marginLeft: 4,
  },
  deliberationToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 2,
    marginLeft: 2,
    alignSelf: "flex-start",
  },
  deliberationToggleText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
  },
  deliberationTakeCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    gap: 4,
  },
  modeSwitchRow: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  blendSection: {
    paddingHorizontal: 16,
    paddingBottom: 10,
    alignItems: "center",
    gap: 8,
  },
  cornerPickerToggle: {
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  cornerPickerToggleText: {
    fontSize: 11.5,
    fontWeight: "500",
    textDecorationLine: "underline",
  },
  cornerPickerRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 6,
  },
  cornerPickChip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 11,
  },
  cornerPickChipText: {
    fontSize: 11.5,
    fontWeight: "500",
  },
  stopButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 8,
    alignSelf: "flex-end",
    marginBottom: 4,
  },
  stopButtonSquare: {
    width: 10,
    height: 10,
    borderRadius: 2,
  },
  speakerChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
    paddingHorizontal: 2,
  },
  speakerDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  speakerName: {
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.1,
  },
  speakerModel: {
    fontSize: 11.5,
    flexShrink: 1,
  },
  debateFailedNote: {
    fontSize: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginBottom: 10,
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 80,
  },
  emptyAvatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 24,
  },
  emptyText: {
    fontSize: 20,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
  },
  inputContainer: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  inputWrapper: {
    flexDirection: "row",
    alignItems: "flex-end",
    borderWidth: 1,
    borderRadius: 24,
    paddingLeft: 16,
    paddingRight: 6,
    paddingVertical: 6,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 28,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    paddingTop: 8,
    paddingBottom: 8,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 8,
  },
  voiceButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 8,
  },

  // Knowledge Styles
  knowledgeContainer: {
    flex: 1,
    position: "relative",
  },
  brainSearchWrap: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 6,
    position: "relative",
    zIndex: 40,
  },
  brainSearchField: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 40,
  },
  brainSearchInput: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 0,
  },
  brainSearchResults: {
    position: "absolute",
    top: 54,
    left: 16,
    right: 16,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 4,
    overflow: "hidden",
  },
  brainSearchList: {
    maxHeight: 288,
  },
  brainSearchEmpty: {
    fontSize: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  brainSearchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  brainSearchRowText: {
    flex: 1,
    minWidth: 0,
  },
  brainSearchRowLabel: {
    fontSize: 14,
    fontWeight: "600",
  },
  brainSearchRowMeta: {
    fontSize: 11,
    marginTop: 2,
  },
  brainSearchRowCount: {
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  },
  knowledgeEmpty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 36,
  },
  knowledgeEmptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  knowledgeEmptyTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 18,
    textAlign: "center",
    marginBottom: 8,
  },
  knowledgeEmptyCopy: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
    maxWidth: 340,
  },
  knowledgeCaptureButton: {
    position: "absolute",
    left: 16,
    bottom: 14,
    zIndex: 30,
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    shadowOpacity: 0.2,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
    elevation: 8,
  },
  symbioteStage: {
    flex: 1,
    position: "relative",
    overflow: "hidden",
  },
  symbioteHud: {
    position: "absolute",
    top: 18,
    left: 16,
    right: 16,
    zIndex: 20,
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  symbioteEyebrow: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0,
    marginBottom: 4,
  },
  symbioteTitle: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: -0.35,
  },
  symbioteStatus: {
    minHeight: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    borderWidth: 1,
    borderRadius: 15,
    paddingHorizontal: 10,
  },
  symbioteStatusDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  symbioteStatusText: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0,
  },
  symbioteViewport: {
    flex: 1,
    overflow: "hidden",
  },
  symbioteMap: {
    position: "absolute",
    width: 800,
    height: 800,
  },
  symbioteAura: {
    position: "absolute",
    width: 360,
    height: 360,
    borderRadius: 180,
    borderWidth: 1,
  },
  symbioteOrbit: {
    position: "absolute",
    width: 470,
    height: 470,
    borderRadius: 235,
    borderWidth: 1,
    opacity: 0.34,
    transform: [{ scaleY: 0.44 }, { rotate: "-8deg" }],
  },
  symbioteOrbitInner: {
    position: "absolute",
    width: 290,
    height: 290,
    borderRadius: 145,
    borderWidth: 1,
    opacity: 0.46,
    transform: [{ scaleY: 0.52 }, { rotate: "22deg" }],
  },
  tendrilSegment: {
    position: "absolute",
    overflow: "visible",
    borderWidth: 0.5,
    shadowOpacity: 0.32,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
  tendrilHighlight: {
    position: "absolute",
    left: 5,
    right: 5,
    top: 1,
    height: 1,
    borderRadius: 1,
    opacity: 0.36,
  },
  tendrilFlow: {
    position: "absolute",
    top: -2,
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  symbioteNodeMotion: {
    position: "absolute",
    zIndex: 10,
  },
  symbioteNodeHalo: {
    position: "absolute",
  },
  symbioteNode: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    overflow: "hidden",
  },
  symbioteNodeReflection: {
    position: "absolute",
    top: 7,
    right: 8,
    opacity: 0.7,
    transform: [{ rotate: "-16deg" }],
  },
  symbioteHint: {
    position: "absolute",
    bottom: 18,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  symbioteHintText: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    letterSpacing: 0.2,
  },
  symbioteReset: {
    position: "absolute",
    right: 16,
    bottom: 14,
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    borderWidth: 1,
    borderRadius: 17,
    paddingHorizontal: 11,
  },
  symbioteResetText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
  },
  node: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
  },
  nodeLabelContainer: {
    position: "absolute",
    width: 150,
    alignItems: "center",
  },
  nodeLabel: {
    textAlign: "center",
    fontSize: 12,
  },
  knowledgeInfoPanel: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    borderTopWidth: 1,
    paddingBottom: 34, // Safe area roughly
    maxHeight: "72%",
  },
  knowledgeInfoScroll: {
    flexShrink: 1,
  },
  knowledgeInfoContent: {
    padding: 20,
  },
  knowledgeInfoHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  knowledgeInfoTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 18,
  },
  knowledgeInfoDesc: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    lineHeight: 22,
    marginBottom: 16,
  },
  knowledgeEditActions: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 16,
  },
  knowledgeEditButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 7,
    minHeight: 44,
  },
  knowledgeEditButtonText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  knowledgeEditCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
  },
  knowledgeEditLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  knowledgeEditHelp: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 17,
    marginTop: 4,
  },
  knowledgeRenameInput: {
    borderWidth: 1,
    borderRadius: 8,
    fontFamily: "Inter_400Regular",
    fontSize: 15,
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  knowledgeEditError: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 16,
    marginTop: 6,
  },
  knowledgeEditCardActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 18,
    marginTop: 12,
  },
  knowledgeTextAction: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  knowledgeEditCancelText: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  knowledgeEditSaveText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  knowledgeRemoteMeta: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    marginBottom: 14,
  },
  knowledgeRemoteStatus: {
    alignItems: "center",
    gap: 10,
    paddingVertical: 26,
    paddingHorizontal: 12,
  },
  knowledgeRemoteStatusTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
  },
  knowledgeRemoteStatusCopy: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },
  knowledgeRemoteRetry: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 10,
    marginTop: 6,
    minHeight: 44,
  },
  knowledgeRemoteRetryText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  knowledgeRemoteBadges: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 16,
  },
  knowledgeRemoteBadge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 5,
  },
  knowledgeRemoteBadgeText: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
  },
  knowledgeNeighborChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  knowledgeNeighborChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 36,
  },
  knowledgeNeighborChipText: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
  },
  knowledgeMergeOption: {
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: 1,
    marginTop: 10,
    paddingTop: 10,
  },
  knowledgeMergeOptions: {
    maxHeight: 180,
  },
  knowledgeMergeOptionCopy: {
    flex: 1,
    paddingRight: 12,
  },
  knowledgeMergeOptionTitle: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  knowledgeMergeOptionMeta: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    marginTop: 2,
  },
  knowledgeDeleteConfirm: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
  },
  knowledgeInfoMeta: {
    flexDirection: "row",
    gap: 8,
  },
  metaBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  metaBadgeText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  knowledgeSourcesLabel: {
    marginTop: 16,
    marginBottom: 6,
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    letterSpacing: 0,
  },
  knowledgeSourcesList: {
    flexShrink: 1,
  },
  knowledgeSourceRow: {
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: 1,
    paddingVertical: 10,
  },
  knowledgeSourceCopy: {
    flex: 1,
    paddingRight: 12,
  },
  knowledgeSourceTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  knowledgeSourceExcerpt: {
    marginTop: 3,
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 17,
  },

  // Board Styles
  boardScrollContent: {
    paddingVertical: 20,
    paddingBottom: 48,
  },
  boardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
    paddingHorizontal: 16,
  },
  boardTitle: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.6,
  },
  boardSubtitle: {
    marginTop: 4,
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  boardSettingsButton: {
    width: 42,
    height: 42,
    borderWidth: 1,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
  },
  boardError: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 10,
    marginHorizontal: 16,
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  boardErrorText: {
    flex: 1,
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    lineHeight: 17,
  },
  boardSettings: {
    borderWidth: 1,
    borderRadius: 16,
    marginHorizontal: 16,
    marginBottom: 18,
    padding: 14,
  },
  settingsSectionTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 15,
  },
  settingsSectionHelp: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 17,
    marginTop: 4,
    marginBottom: 10,
  },
  settingsRow: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderTopWidth: 1,
    paddingVertical: 7,
  },
  settingsNameInput: {
    flex: 1,
    minWidth: 80,
    minHeight: 38,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 7,
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  settingsIconButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
  },
  doneToggle: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 9,
  },
  doneToggleText: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
  },
  settingsAddRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 10,
  },
  settingsAddInput: {
    flex: 1,
    minHeight: 42,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 11,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
  },
  settingsAddButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
  },
  settingsDivider: {
    height: 1,
    marginVertical: 18,
  },
  fieldTypeBadge: {
    maxWidth: 74,
    fontFamily: "Inter_400Regular",
    fontSize: 10,
  },
  fieldTypePicker: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 10,
  },
  fieldOptionsInput: {
    minHeight: 40,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    marginBottom: 8,
    fontFamily: "Inter_400Regular",
    fontSize: 12,
  },
  confirmPanel: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 11,
    marginBottom: 8,
  },
  confirmTitle: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    lineHeight: 17,
  },
  confirmActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 16,
    marginTop: 11,
  },
  textButton: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    paddingVertical: 7,
  },
  destructiveButton: {
    minHeight: 38,
    borderRadius: 19,
    paddingHorizontal: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  destructiveButtonText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
  },
  choiceWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 7,
    marginTop: 8,
  },
  choiceChip: {
    minHeight: 36,
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 11,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  choiceChipText: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
  },
  boardColumnsContainer: {
    paddingHorizontal: 16,
    gap: 12,
    alignItems: "flex-start",
  },
  boardColumn: {
    width: 286,
    borderWidth: 1,
    borderRadius: 14,
    padding: 10,
  },
  boardColumnHeader: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
    paddingHorizontal: 3,
  },
  boardColumnTitleRow: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  boardColumnTitle: {
    flex: 1,
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0,
  },
  boardColumnCount: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
  },
  boardColumnList: {
    gap: 8,
  },
  columnEmpty: {
    minHeight: 76,
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    padding: 12,
  },
  columnEmptyText: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    textAlign: "center",
  },
  columnAddButton: {
    minHeight: 42,
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  columnAddText: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
  },
  addTaskForm: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
  },
  addTaskInput: {
    minHeight: 40,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    marginBottom: 10,
  },
  addTaskActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 14,
    alignItems: "center",
  },
  addTaskSubmit: {
    minHeight: 38,
    paddingHorizontal: 13,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  addTaskSubmitText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  kanbanCard: {
    borderWidth: 1,
    borderRadius: 10,
    overflow: "hidden",
  },
  kanbanCardMain: {
    padding: 11,
  },
  kanbanCardTitle: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    lineHeight: 19,
    marginBottom: 8,
  },
  cardFieldRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginTop: 4,
  },
  cardFieldName: {
    flex: 1,
    fontFamily: "Inter_400Regular",
    fontSize: 10,
  },
  cardFieldValue: {
    maxWidth: "58%",
    fontFamily: "Inter_500Medium",
    fontSize: 10,
  },
  cardMoveActions: {
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: "rgba(127,127,127,0.18)",
    paddingHorizontal: 4,
  },
  cardMoveButton: {
    width: 34,
    height: 34,
    borderWidth: 2,
    borderColor: "transparent",
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  cardMoveSpacer: {
    flex: 1,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.72)",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  cardEditor: {
    width: "100%",
    maxWidth: 560,
    maxHeight: "92%",
    borderWidth: 1,
    borderRadius: 18,
    overflow: "hidden",
  },
  cardEditorContent: {
    padding: 18,
    paddingBottom: 12,
  },
  cardEditorHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 18,
  },
  cardEditorTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 20,
  },
  formLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    marginBottom: 7,
  },
  editorInput: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 11,
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    marginBottom: 16,
  },
  editorField: {
    marginTop: 16,
  },
  checkboxField: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  checkboxFieldText: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  editorError: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    lineHeight: 17,
    marginTop: 14,
  },
  deleteCardButton: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    alignSelf: "flex-start",
    marginTop: 20,
  },
  deleteCardText: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
  },
  cardEditorFooter: {
    minHeight: 66,
    borderTopWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 14,
    paddingHorizontal: 18,
  },
  editorCancelButton: {
    minHeight: 42,
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  editorCancelText: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  editorSaveButton: {
    minHeight: 42,
    borderRadius: 21,
    paddingHorizontal: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  editorSaveText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
});

function DraggableKanbanCard({
  children,
  onDragEnd,
}: {
  children: React.ReactNode;
  onDragEnd: (translationX: number, translationY: number) => void;
}) {
  const dragX = useSharedValue(0);
  const dragY = useSharedValue(0);
  const dragging = useSharedValue(0);
  const dragGesture = Gesture.Pan()
    .activateAfterLongPress(220)
    .minDistance(6)
    .onBegin(() => {
      dragging.value = 1;
    })
    .onUpdate((event) => {
      dragX.value = event.translationX;
      dragY.value = event.translationY;
    })
    .onEnd((event) => {
      runOnJS(onDragEnd)(event.translationX, event.translationY);
    })
    .onFinalize(() => {
      dragging.value = 0;
      dragX.value = withSpring(0, {
        damping: 20,
        stiffness: 240,
        reduceMotion: ReduceMotion.System,
      });
      dragY.value = withSpring(0, {
        damping: 20,
        stiffness: 240,
        reduceMotion: ReduceMotion.System,
      });
    });
  const dragStyle = useAnimatedStyle(() => ({
    zIndex: dragging.value ? 10 : 0,
    opacity: dragging.value ? 0.84 : 1,
    transform: [
      { translateX: dragX.value },
      { translateY: dragY.value },
      { scale: dragging.value ? 1.02 : 1 },
    ],
  }));

  return (
    <GestureDetector gesture={dragGesture}>
      <Animated.View style={dragStyle}>{children}</Animated.View>
    </GestureDetector>
  );
}

function isValidCardDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function projectGraphCluster(
  cluster: KnowledgeCluster,
  camera: GraphCamera,
  baseScale: number,
  center: number,
): ProjectedGraphPoint {
  const worldX = cluster.x * 2.25;
  const worldY = cluster.y * 2.25;
  const worldZ = graphDepthForCluster(cluster);
  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);
  const cosPitch = Math.cos(camera.pitch);
  const sinPitch = Math.sin(camera.pitch);
  const afterYawX = worldX * cosYaw + worldZ * sinYaw;
  const afterYawZ = worldZ * cosYaw - worldX * sinYaw;
  const afterPitchY = worldY * cosPitch - afterYawZ * sinPitch;
  const depth = afterYawZ * cosPitch + worldY * sinPitch;
  const perspective = 700 / (700 - depth);
  const positionScale = clampGraphValue(
    baseScale * camera.zoom * perspective,
    0.28,
    1.35,
  );
  const scale = clampGraphValue(camera.zoom * perspective, 0.66, 1.45);

  return {
    x: center + afterYawX * positionScale,
    y: center + afterPitchY * positionScale,
    depth,
    scale,
    opacity: clampGraphValue(0.34 + (depth + 220) / 370, 0.34, 1),
  };
}

const WORKSPACE_TABS = ["Chat", "Feed", "Notifications", "Brain", "To-Do"] as const;

type CardControlHandle = {
  focus?: () => void;
};
type WorkspaceTabHandle = {
  focus?: () => void;
  addEventListener?: (
    type: "keydown",
    listener: (event: WebKeyboardEvent) => void,
  ) => void;
  removeEventListener?: (
    type: "keydown",
    listener: (event: WebKeyboardEvent) => void,
  ) => void;
};

type WebKeyboardEvent = {
  key?: string;
  nativeEvent?: { key?: string };
  preventDefault?: () => void;
};

type ProjectedGraphCluster = ProjectedGraphPoint & {
  cluster: KnowledgeCluster;
};

const clampGraphValue = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

type ProjectedGraphPoint = GraphPoint & {
  depth: number;
  scale: number;
  opacity: number;
};

function graphDepthForCluster(cluster: KnowledgeCluster) {
  let hash = 17;
  for (const character of cluster.id) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return (hash % 210) - 105 + Math.sin(cluster.x * 0.06 + cluster.y * 0.04) * 32;
}

type CardControlHandles = {
  edit: CardControlHandle | null;
  next: CardControlHandle | null;
};

/**
 * Where keyboard focus should land after the card editor closes: back on a
 * card's controls, or on a stage's "Add card" control when a deletion left
 * the stage without any card to return to.
 */
type BoardFocusTarget =
  | { kind: "card"; taskId: string }
  | { kind: "addCard"; stageId: string };

type DeliberationTakeState = {
  content: string;
  status: "streaming" | "ok" | "failed";
};

type LocalDeliberation = {
  roster: DeliberationRosterVoice[];
  takes: Record<string, DeliberationTakeState>;
  stage: "voices" | "synthesis";
};

type DebateTurnLive = {
  index: number;
  voiceId: string;
  name: string;
  modelId?: string;
  modelName?: string;
  content: string;
};
/** Small monochrome dot that breathes while a voice is still speaking. */
function BreathingDot({
  color,
  phase,
  testID,
}: {
  color: string;
  phase: number;
  testID?: string;
}) {
  const reduceMotion = useReducedMotion();
  const pulse = useSharedValue(0.35 + phase * 0.3);

  useEffect(() => {
    if (reduceMotion) {
      cancelAnimation(pulse);
      pulse.value = withTiming(0.9, { duration: 200 });
      return;
    }
    pulse.value = withRepeat(
      withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => cancelAnimation(pulse);
  }, [reduceMotion, pulse]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: pulse.value,
    transform: [{ scale: 0.8 + pulse.value * 0.2 }],
  }));

  return (
    <Animated.View
      testID={testID}
      style={[
        styles.deliberationDot,
        { backgroundColor: color },
        animatedStyle,
      ]}
    />
  );
}

/** The in-progress chamber: voice takes surfacing while the answer forms. */
function DeliberationStreamCard({
  deliberation,
  colors,
  renderContent,
}: {
  deliberation: LocalDeliberation;
  colors: ReturnType<typeof useColors>;
  renderContent: (content: string, keyPrefix: string) => React.ReactNode;
}) {
  const converging = deliberation.stage === "synthesis";
  const showModels =
    new Set(deliberation.roster.map((voice) => voice.modelId).filter(Boolean))
      .size > 1;

  return (
    <View
      style={[
        styles.deliberationPanel,
        { borderColor: colors.border, backgroundColor: colors.card },
      ]}
      testID="deliberation-panel"
    >
      <View style={styles.deliberationHeader}>
        <Text
          style={[styles.deliberationHeaderTitle, { color: colors.foreground }]}
        >
          {converging ? "Converging" : "Verifying"}
        </Text>
        <Text
          style={[
            styles.deliberationHeaderMeta,
            { color: colors.mutedForeground },
          ]}
          numberOfLines={1}
        >
          {converging
            ? "merging into one answer"
            : `${deliberation.roster.length} voices are checking the question`}
        </Text>
      </View>
      {deliberation.roster.map((voice, index) => {
        const take = deliberation.takes[voice.voiceId] ?? {
          content: "",
          status: "streaming" as const,
        };
        return (
          <View
            key={voice.voiceId}
            style={[
              styles.deliberationVoiceCard,
              {
                borderColor: colors.border,
                backgroundColor: colors.background,
                opacity: converging ? 0.65 : 1,
              },
            ]}
            testID={`deliberation-voice-${voice.voiceId}`}
          >
            <View style={styles.deliberationVoiceHeader}>
              {take.status === "streaming" ? (
                <BreathingDot
                  color={colors.foreground}
                  phase={index / 3}
                  testID={`deliberation-dot-${voice.voiceId}`}
                />
              ) : (
                <View
                  testID={`deliberation-dot-${voice.voiceId}`}
                  style={[
                    styles.deliberationDot,
                    take.status === "ok"
                      ? { backgroundColor: colors.foreground }
                      : {
                          borderWidth: 1,
                          borderColor: colors.mutedForeground,
                          backgroundColor: "transparent",
                        },
                  ]}
                />
              )}
              <Text
                style={[
                  styles.deliberationVoiceName,
                  { color: colors.foreground },
                ]}
                numberOfLines={1}
              >
                {voice.name}
              </Text>
              {showModels && voice.modelName ? (
                <Text
                  style={[
                    styles.deliberationVoiceModel,
                    { color: colors.mutedForeground },
                  ]}
                  numberOfLines={1}
                >
                  {voice.modelName}
                </Text>
              ) : null}
            </View>
            {take.status === "failed" ? (
              <Text
                style={[
                  styles.deliberationTakeText,
                  { color: colors.mutedForeground },
                ]}
              >
                Didn't finish — the others carry on.
              </Text>
            ) : take.content ? (
              <Text
                style={[
                  styles.deliberationTakeText,
                  { color: colors.mutedForeground },
                ]}
                numberOfLines={6}
              >
                {renderContent(take.content, `live-${voice.voiceId}`)}
              </Text>
            ) : (
              <Text
                style={[
                  styles.deliberationTakeText,
                  { color: colors.mutedForeground, opacity: 0.7 },
                ]}
              >
                Forming a take…
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

/**
 * The live debate: the roster, whose turn is streaming right now, and voices
 * that failed. Finished turns already sit in the thread as named messages —
 * this card only renders the in-flight one.
 */
function DebateStreamCard({
  debate,
  colors,
  renderContent,
}: {
  debate: LocalDebate;
  colors: ReturnType<typeof useColors>;
  renderContent: (content: string, keyPrefix: string) => React.ReactNode;
}) {
  const current = debate.current;
  const showModels =
    new Set(debate.roster.map((voice) => voice.modelId).filter(Boolean)).size >
    1;
  const currentIndexInRoster = current
    ? Math.max(
        0,
        debate.roster.findIndex((voice) => voice.voiceId === current.voiceId),
      )
    : 0;

  return (
    <View
      style={[
        styles.deliberationPanel,
        { borderColor: colors.border, backgroundColor: colors.card },
      ]}
      testID="debate-stream"
    >
      <View style={styles.deliberationHeader}>
        <Text
          style={[styles.deliberationHeaderTitle, { color: colors.foreground }]}
        >
          Debating
        </Text>
        <Text
          style={[
            styles.deliberationHeaderMeta,
            { color: colors.mutedForeground },
          ]}
          numberOfLines={1}
          testID="debate-status"
        >
          {current
            ? `Turn ${current.index + 1} of ${debate.of} · ${current.name} is speaking`
            : "the voices are gathering"}
        </Text>
      </View>
      {debate.failedNames.length > 0 && (
        <Text
          style={[
            styles.debateFailedNote,
            { color: colors.mutedForeground, borderColor: colors.border },
          ]}
          testID="chip-debate-failed"
        >
          {`${debate.failedNames.join(", ")} couldn't respond — the debate carries on.`}
        </Text>
      )}
      {current && (
        <View
          style={[
            styles.deliberationVoiceCard,
            { borderColor: colors.border, backgroundColor: colors.background },
          ]}
          testID={`debate-turn-${current.index}`}
        >
          <View style={styles.deliberationVoiceHeader}>
            <BreathingDot
              color={colors.foreground}
              phase={currentIndexInRoster / 3}
            />
            <Text
              style={[
                styles.deliberationVoiceName,
                { color: colors.foreground },
              ]}
              numberOfLines={1}
            >
              {current.name}
            </Text>
            {showModels && current.modelName ? (
              <Text
                style={[
                  styles.deliberationVoiceModel,
                  { color: colors.mutedForeground },
                ]}
                numberOfLines={1}
              >
                {current.modelName}
              </Text>
            ) : null}
          </View>
          {current.content ? (
            <Text
              style={[styles.deliberationTakeText, { color: colors.foreground }]}
            >
              {renderContent(current.content, `debate-${current.index}`)}
            </Text>
          ) : (
            <Text
              style={[
                styles.deliberationTakeText,
                { color: colors.mutedForeground, opacity: 0.7 },
              ]}
            >
              Forming a reply…
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

type LocalDebate = {
  roster: DeliberationRosterVoice[];
  of: number;
  current: DebateTurnLive | null;
  failedNames: string[];
};
