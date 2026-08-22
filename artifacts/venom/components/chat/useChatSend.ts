import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Platform, TextInput } from "react-native";
import { useAuth } from "@clerk/expo";
import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { fetch } from "expo/fetch";
import {
  type VenomModelId as ApiVenomModelId,
  commitVenomCanonTeaching,
  extractVenomKnowledge,
  getGetSharedWorkspaceKnowledgeQueryKey,
  getGetVenomIdentityQueryKey,
  proposeVenomCanonTeaching,
  undoVenomKnowledgeMove,
  useGetVenomIdentity,
  type VenomManagedModel,
  type VenomMessageAttachment,
  type VenomResponseMode,
} from "@workspace/api-client-react";
import { type BlendCorner } from "@/components/BlendPad";
import { type CanonTeachState } from "@/components/chat/CanonTeachCard";
import {
  type LocalDebate,
  type LocalDeliberation,
} from "@/components/chat/chatTypes";
import { generateUniqueId } from "@/components/chat/ids";
import { createDebateStreamHandler } from "@/components/chat/streamHandlers/debateStream";
import { createDeliberationStreamHandler } from "@/components/chat/streamHandlers/deliberationStream";
import { createFileStreamHandler } from "@/components/chat/streamHandlers/fileStream";
import {
  type FileActivity,
  type PendingChatFile,
} from "@/components/ChatFileCards";
import { type BlendWeights } from "@/context/responsePrefs";
import { useSharedWorkspace } from "@/context/sharedWorkspace";
import { buildChatProjectContextBundle } from "@/context/sourceContext";
import {
  IS_UI_TEST,
  Message,
  type ProjectSource,
  UI_TEST_USER_ID,
  useVenom,
  type VenomModelId,
} from "@/context/VenomContext";
import { canonTeachGate } from "@/lib/canonTeach";
import { UI_TEST_CHAT_TOKEN } from "@/lib/uiTestChat";
import {
  notifyWorkspaceAccessLost,
  WORKSPACE_ACCESS_DENIED_CODE,
} from "@/lib/workspaceAccess";

const BUILD_INTENT_REGEX = /^(?:create|build|make|generate|design)\s+(?:an?\s+)?(?:[\w-]+\s+){0,3}(app|application|website|site|brand|customer[- ]service(?:[- ]flow)?)\b/i;

/**
 * A knowledge item the server auto-filed into a shared workspace during
 * background extraction. Surfaced as an in-chat banner with one-tap undo;
 * `conversationRef` remembers which chat produced it so an undo can land the
 * restored (author-private, unsorted) records straight back on this device.
 */
export type FilingNotice = {
  noticeId: string;
  workspaceId: string;
  workspaceName: string;
  labels: string[];
  conversationRef: { id: string; title: string; projectId: string | null };
};

/**
 * The chat send/stream loop: guards, build-intent routing, the SSE round
 * loop, and turn persistence. Owns every piece of transient stream state —
 * the streaming bubble, typing dots, deliberation chamber, debate round,
 * writing card, and the conversation the in-flight turn belongs to — plus
 * the refs that let a stop, an interjection, or an account switch cut the
 * stream safely.
 *
 * Mode-specific SSE events are delegated to the handlers in
 * ./streamHandlers, so a change to one response mode cannot reach into the
 * others; this hook keeps only the shared envelope (errors, completion,
 * attribution, plain content) and the talk path.
 */
export function useChatSend({
  isActive,
  activeProject,
  onScreenProjectId,
  contextMessages,
  projectSources,
  activeModelId,
  activeModel,
  responseMode,
  blendCorners,
  storedWeights,
  pendingFiles,
  setPendingFiles,
  inputRef,
}: {
  isActive: boolean;
  activeProject: any;
  onScreenProjectId: string | null;
  contextMessages: Message[];
  projectSources: ProjectSource[];
  activeModelId: VenomModelId;
  activeModel: VenomManagedModel | null;
  responseMode: VenomResponseMode;
  blendCorners: [BlendCorner, BlendCorner, BlendCorner] | null;
  storedWeights: BlendWeights;
  pendingFiles: PendingChatFile[];
  setPendingFiles: React.Dispatch<React.SetStateAction<PendingChatFile[]>>;
  inputRef: React.RefObject<TextInput | null>;
}) {
  const router = useRouter();
  const { getToken, userId: authenticatedUserId } = useAuth();
  // Chat sends bill the space the user is working in: the active shared
  // workspace rides the respond request so its plan pays and its admin
  // caps and model locks bind — exactly what the composer's "Billed to"
  // hint promises.
  const { activeWorkspace } = useSharedWorkspace();
  const userId = IS_UI_TEST
    ? UI_TEST_USER_ID
    : (authenticatedUserId ?? null);
  const {
    state,
    addMessage,
    setActiveConversation,
    createNewConversation,
    applyKnowledgeInsights,
    applyFiledKnowledge,
  } = useVenom();
  const queryClient = useQueryClient();

  const [text, setText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [showTyping, setShowTyping] = useState(false);
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
  // The conversation the in-flight turn is filing into. Every piece of
  // transient turn UI — chamber, debate card, typing dots, streaming bubble —
  // belongs to that conversation alone: a project switch mid-turn must not
  // drag it onto another chat, and switching back before the answer lands
  // brings it back, still live.
  const [streamingConvId, setStreamingConvId] = useState<string | null>(null);
  // The live document-writing state while a turn authors a file.
  const [localFileActivity, setLocalFileActivity] =
    useState<FileActivity | null>(null);
  // A super admin teach-in-flight: the propose round-trip, then the
  // confirmation card. Nothing reaches the canon until the admin confirms;
  // cancel (or an unclear draft) turns the message back into ordinary chat.
  const [canonTeach, setCanonTeach] = useState<CanonTeachState | null>(null);

  // Whether this account may teach canon at all. The flag only gates UI —
  // the server re-verifies the role on every canon call — and for everyone
  // else this stays false and chat behaves exactly as before.
  const { data: identity } = useGetVenomIdentity({
    query: {
      queryKey: getGetVenomIdentityQueryKey(),
      enabled: Boolean(userId),
      staleTime: 5 * 60_000,
      retry: 1,
    },
  });
  const canTeachCanon = identity?.superAdmin === true;

  // Auto-sorted workspace filings from background extraction, shown as
  // banners with one-tap undo until acted on or dismissed.
  const [filingNotices, setFilingNotices] = useState<FilingNotice[]>([]);

  const activeUserIdRef = useRef<string | null>(userId ?? null);
  const activeRequestAbortRef = useRef<AbortController | null>(null);
  // Debate steering: messages the user sent mid-round (the next turns react
  // to them), which conversation the running debate belongs to, and whether
  // the user asked the round to stop.
  const pendingInterjectionsRef = useRef<{ id: string; content: string }[]>(
    [],
  );
  const debateConvIdRef = useRef<string | null>(null);
  const stopRequestedRef = useRef(false);

  useEffect(() => {
    activeUserIdRef.current = userId ?? null;
    // A pending teach card belongs to the account that asked; an account
    // switch discards it (nothing was committed).
    setCanonTeach(null);
    return () => {
      if (activeUserIdRef.current === (userId ?? null)) {
        activeUserIdRef.current = null;
      }
      activeRequestAbortRef.current?.abort();
      activeRequestAbortRef.current = null;
    };
  }, [userId]);

  // Committing a confirmed teaching: the only write path into canon from
  // chat, and it exists strictly behind the confirmation card. Failure keeps
  // the card up with the error; nothing half-commits.
  const handleCanonConfirm = async () => {
    const snapshot = canonTeach;
    if (!snapshot?.draft || snapshot.phase !== "confirm") return;
    const initiatingUserId = userId ?? null;
    if (!initiatingUserId) return;
    setCanonTeach({ ...snapshot, phase: "committing", error: null });
    try {
      const token = IS_UI_TEST ? UI_TEST_CHAT_TOKEN : await getToken();
      if (!token || activeUserIdRef.current !== initiatingUserId) {
        throw new Error("Authentication session changed");
      }
      const conversation = state.conversations.find(
        (item) => item.id === snapshot.convId,
      );
      const conversationTitle =
        conversation && conversation.title !== "New Session"
          ? conversation.title
          : undefined;
      const result = await commitVenomCanonTeaching(
        {
          domain: snapshot.draft.domain,
          title: snapshot.draft.title,
          principles: snapshot.draft.principles,
          conversationId: snapshot.convId,
          ...(conversationTitle ? { conversationTitle } : {}),
        },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (activeUserIdRef.current !== initiatingUserId) return;
      // The acknowledgment lands as Venom's own turn in the thread.
      addMessage(snapshot.convId, {
        id: generateUniqueId(),
        role: "assistant",
        content: result.acknowledgment,
        status: "sent",
      });
      setCanonTeach(null);
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
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
    void runChatTurn(snapshot.message, [], {
      convId: snapshot.convId,
      userMessageId: snapshot.userMessageId,
      projectId: snapshot.projectId,
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

  async function handleSend() {
    const trimmed = text.trim();
    const initiatingUserId = userId ?? null;
    if (!initiatingUserId) return;
    // Ready uploads ride this message; a file alone is a valid send.
    const readyStamps = pendingFiles.flatMap((item) =>
      item.status === "ready" && item.stamp ? [item.stamp] : [],
    );
    if (!trimmed && readyStamps.length === 0) return;
    if (pendingFiles.some((item) => item.status === "uploading")) return;
    if (isStreaming) {
      if (!trimmed) return;
      // Mid-debate the composer stays open: the message lands in the thread
      // now and the following debater turns take it into account.
      if (
        localDebate &&
        debateConvIdRef.current &&
        debateConvIdRef.current === state.activeConversationId
      ) {
        setText("");
        const interjectionId = generateUniqueId();
        addMessage(debateConvIdRef.current, {
          id: interjectionId,
          role: "user",
          content: trimmed,
          status: "sent",
        });
        pendingInterjectionsRef.current.push({
          id: interjectionId,
          content: trimmed,
        });
        if (Platform.OS !== "web") {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }
      }
      return;
    }

    // A message carrying files is a request about those files, never a
    // build command.
    const buildMatch =
      readyStamps.length === 0 ? trimmed.match(BUILD_INTENT_REGEX) : null;
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

    // Super admin teach interception: text-only messages that read like a
    // teach command go through propose → confirm → commit instead of
    // streaming. Everyone else — and every message with files, and every
    // miss of the cheap gate — takes the exact send below, untouched. The
    // gate here only saves round-trips; the server re-checks the role and
    // re-runs its own gate.
    if (canTeachCanon && readyStamps.length === 0 && canonTeachGate(trimmed)) {
      // A lingering card is an unanswered question; a new send supersedes
      // it (nothing was committed).
      setCanonTeach(null);
      if (Platform.OS !== "web") {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
      setText("");
      setStreamError(null);
      // Same conversation targeting as an ordinary send: the admin's
      // message lands in the thread first, whatever happens next.
      let teachConvId = state.activeConversationId;
      const teachConv = state.conversations.find(
        (conversation) => conversation.id === teachConvId,
      );
      if (!teachConvId || (teachConv?.projectId ?? null) !== onScreenProjectId) {
        teachConvId = createNewConversation(onScreenProjectId);
        setActiveConversation(teachConvId);
      }
      const teachMessageId = generateUniqueId();
      addMessage(teachConvId, {
        id: teachMessageId,
        role: "user",
        content: trimmed,
        status: "sent",
      });
      const preset = {
        convId: teachConvId,
        userMessageId: teachMessageId,
        projectId: onScreenProjectId,
      };
      setCanonTeach({
        convId: teachConvId,
        userMessageId: teachMessageId,
        projectId: onScreenProjectId,
        message: trimmed,
        phase: "probing",
      });
      try {
        const token = IS_UI_TEST ? UI_TEST_CHAT_TOKEN : await getToken();
        if (!token || activeUserIdRef.current !== initiatingUserId) {
          throw new Error("Authentication session changed");
        }
        const conversationTitle =
          teachConv && teachConv.title !== "New Session"
            ? teachConv.title
            : undefined;
        const result = await proposeVenomCanonTeaching(
          {
            message: trimmed,
            conversationId: teachConvId,
            ...(conversationTitle ? { conversationTitle } : {}),
          },
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (activeUserIdRef.current !== initiatingUserId) {
          setCanonTeach(null);
          return;
        }
        if (result.teachIntent && result.draft) {
          setCanonTeach({
            convId: teachConvId,
            userMessageId: teachMessageId,
            projectId: onScreenProjectId,
            message: trimmed,
            phase: "confirm",
            draft: result.draft,
          });
          return;
        }
      } catch {
        // Propose is best-effort; an error means this send is ordinary chat.
      }
      // No teach intent after all: fail open to the normal answer.
      setCanonTeach(null);
      await runChatTurn(trimmed, [], preset);
      return;
    }

    await runChatTurn(trimmed, readyStamps, null);
  }

  /**
   * One full chat turn: capture send-time state, file the user message
   * (unless `preset` says it is already in the thread), stream the answer,
   * persist it, and hand settled outcomes to knowledge extraction. This is
   * the whole send path for every user; the teach flow above only decides
   * whether to enter it.
   */
  async function runChatTurn(
    trimmed: string,
    readyStamps: VenomMessageAttachment[],
    preset: {
      convId: string;
      userMessageId: string;
      projectId: string | null;
    } | null,
  ) {
    const initiatingUserId = userId ?? null;
    if (!initiatingUserId) return;
    const initiatingProjectId = preset ? preset.projectId : onScreenProjectId;
    // Captured once per send: every round of a debate (and the settle pass)
    // bills the space that started it, even if the user switches mid-turn.
    const initiatingWorkspaceId = activeWorkspace?.id ?? null;
    let abortController = new AbortController();
    activeRequestAbortRef.current = abortController;
    // Capture the model being used at send time
    const sendingModelId = activeModelId;
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

    if (!preset) {
      if (Platform.OS !== "web") {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
      setText("");
    }
    setStreamError(null);

    // Never append to a session that belongs to another project: the answer is
    // read as part of the project on screen, so that is where it has to be
    // filed. A preset means the teach flow already targeted the conversation
    // and filed the user message.
    let targetConvId = preset ? preset.convId : state.activeConversationId;
    if (!preset) {
      const targetConv = state.conversations.find(
        (conversation) => conversation.id === targetConvId,
      );
      if (
        !targetConvId ||
        (targetConv?.projectId ?? null) !== onScreenProjectId
      ) {
        targetConvId = createNewConversation(onScreenProjectId);
        setActiveConversation(targetConvId);
      }
    }
    if (!targetConvId) return;

    const userMessageId = preset ? preset.userMessageId : generateUniqueId();
    if (!preset) {
      addMessage(targetConvId, {
        id: userMessageId,
        role: "user",
        content: trimmed,
        status: "sent",
        ...(readyStamps.length > 0 ? { attachments: readyStamps } : {}),
      });
    }
    setPendingFiles([]);
    setLocalFileActivity(null);

    debateConvIdRef.current = sendMode === "debate" ? targetConvId : null;
    setStreamingConvId(targetConvId);
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
    // Debate rounds restart when the user interjects between turns: the
    // history the next round continues from accumulates the persisted
    // turns and the user's new messages. Declared here so the debate
    // handler can append to it and the round loop can resend from it.
    const debateHistory: { role: string; content: string }[] = [];
    // Interjections accumulate across restarts so a settled debate's capture
    // carries the user's whole side; the round's conclusion itself is
    // tracked by the debate handler.
    const debateInterjections: { id: string; content: string }[] = [];

    // Per-mode SSE accumulators live in their own handlers; each is used
    // only when this turn opted into that mode.
    const deliberation = createDeliberationStreamHandler({
      publish: setLocalDeliberation,
      setShowTyping,
    });
    const debate = createDebateStreamHandler({
      publish: setLocalDebate,
      setShowTyping,
      persistTurn: (turn, persistedContent) => {
        const persistedId = generateUniqueId();
        addMessage(targetConvId, {
          id: persistedId,
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
        return persistedId;
      },
      hasPendingInterjections: () =>
        pendingInterjectionsRef.current.length > 0,
    });
    const fileAuthoring = createFileStreamHandler({
      publish: setLocalFileActivity,
      setShowTyping,
    });

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
        ...contextMessages.slice(-23).map((m) => ({
          role: m.role,
          content: m.content,
          // Prior attachments stay on the wire so follow-ups keep their
          // file context — including files attached on another device.
          ...(m.attachments && m.attachments.length > 0
            ? {
                attachmentIds: m.attachments
                  .slice(0, 5)
                  .map((stamp) => stamp.id),
              }
            : {}),
        })),
        {
          role: "user",
          content: trimmed,
          ...(readyStamps.length > 0
            ? { attachmentIds: readyStamps.map((stamp) => stamp.id) }
            : {}),
        },
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

      debateHistory.push(...chatHistory);

      roundLoop: while (true) {
      streamCompleted = false;
      debate.beginRound();

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
          ...(initiatingWorkspaceId
            ? { workspaceId: initiatingWorkspaceId }
            : {}),
          modelId: sendingModelId,
          projectContext,
          sourceCitationIds,
          sourceSnapshots,
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
        if (response.status === 402) {
          // An allowance ran out. The server's copy says whose — the sender's
          // personal plan or this workspace's Organization plan — so surface
          // it verbatim. Retrying can't help until the plan changes or the
          // period resets.
          let blockedMsg = "This period's included AI is used up.";
          try {
            const body = (await response.json()) as { error?: string };
            if (body?.error) blockedMsg = body.error;
          } catch {
            // not JSON – keep the generic copy
          }
          throw Object.assign(new Error(blockedMsg), {
            retryable: false,
            httpStatus: 402,
          });
        }
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
            if (parsed.code === "file_render_failed") {
              fileAuthoring.markRenderFailed();
              return;
            }
            const isRetryable = parsed.retryable !== false;
            throw Object.assign(new Error(parsed.error as string), {
              retryable: isRetryable,
            });
          }
          if (parsed.done === true) {
            streamCompleted = true;
            return;
          }
          // Debate events consume their lines before the generic content
          // branch so debate text never leaks into a single answer bubble.
          if (debate.handleEvent(parsed)) return;
          // Deliberation events: voice chunks consume; roster, summary, and
          // stage moves fall through like any metadata event.
          if (deliberation.handleEvent(parsed)) return;
          // File authoring events never consume — attribution and content
          // can ride the same event.
          fileAuthoring.handleEvent(parsed);
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

        if (debate.restartRequested) {
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
          debateHistory.push({ role: "user", content: interjection.content });
          debateInterjections.push(interjection);
        }
        debate.applyInterjections();
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

      // A deliberated turn persists its takes and disagreements alongside
      // the collective answer; the handler falls back to what accumulated
      // while streaming if the final summary event never arrived.
      const persistedDeliberation = deliberation.persistedDeliberation();
      const deliveredFileSnapshot = fileAuthoring.deliveredFile;
      const renderFailed = fileAuthoring.renderFailed;
      // Captured before the shared cleanup below wipes them: whether the
      // user stopped this debate round, and whether an interjection was
      // still waiting for a restart when the stream ended.
      const debateWasStopped = stopRequestedRef.current;
      const debateInterjectionWaiting =
        pendingInterjectionsRef.current.length > 0;

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
          ...(!requestFailed && deliveredFileSnapshot
            ? { attachments: [deliveredFileSnapshot] }
            : {}),
        });
      }
      setLocalStreamingMessage(null);
      setLocalFileActivity(null);
      setLocalDeliberation(null);
      setLocalDebate(null);
      setStreamingConvId(null);
      debateConvIdRef.current = null;
      pendingInterjectionsRef.current = [];
      stopRequestedRef.current = false;

      // The reply survived; only the document failed. Announce it after the
      // turn persisted so the answer never looks lost.
      if (renderFailed && !requestFailed && fullContent) {
        Alert.alert(
          "Document not created",
          "Venom answered in chat, but the file couldn't be rendered. Ask again to retry.",
        );
      }

      // Knowledge extraction mines only settled outcomes. An ordinary or
      // verified answer settles by completing; a debate settles only when
      // its final round ran to a clean end — not stopped, not failed, no
      // restart pending — and the closing turn landed with content. That
      // conclusion is absorbed the way an ordinary answer is; the sparring
      // before it never is. Stopped, failed, or truncated rounds leave no
      // trace in the Brain.
      const settledTurnSnapshot = debate.settledTurn;
      const debateSettled =
        sendMode === "debate" &&
        streamCompleted &&
        !requestFailed &&
        !debateWasStopped &&
        !debateInterjectionWaiting &&
        settledTurnSnapshot !== null;
      const talkAnswered =
        sendMode !== "debate" && Boolean(fullContent) && !requestFailed;
      if ((debateSettled || talkAnswered) && requestToken) {
        const conversation = state.conversations.find(
          (item) => item.id === targetConvId,
        );
        const conversationTitle =
          conversation?.title === "New Session"
            ? `${trimmed.slice(0, 30)}...`
            : (conversation?.title ?? "New Session");

        // Speaker-attributed messages are raw debate turns: argument, not
        // settled knowledge. They never enter an extraction window — a
        // debate contributes through its settled conclusion instead.
        const plainContext = contextMessages.filter(
          (message) => !message.speakerId,
        );
        const recentInterjections = debateInterjections.slice(-12);
        const extractionMessages =
          debateSettled && settledTurnSnapshot
            ? [
                ...plainContext
                  .slice(-(46 - recentInterjections.length))
                  .map((message) => ({
                    id: message.id,
                    role: message.role,
                    content: message.content.slice(0, 8000),
                  })),
                {
                  id: userMessageId,
                  role: "user" as const,
                  content: trimmed,
                },
                ...recentInterjections.map((interjection) => ({
                  id: interjection.id,
                  role: "user" as const,
                  content: interjection.content.slice(0, 8000),
                })),
                {
                  id: settledTurnSnapshot.id,
                  role: "assistant" as const,
                  content: settledTurnSnapshot.content.slice(0, 8000),
                },
              ]
            : [
                ...plainContext.slice(-46).map((message) => ({
                  id: message.id,
                  role: message.role,
                  content: message.content.slice(0, 8000),
                })),
                {
                  id: userMessageId,
                  role: "user" as const,
                  content: trimmed,
                },
                {
                  id: streamId,
                  role: "assistant" as const,
                  content: fullContent.slice(0, 8000),
                },
              ];

        void extractVenomKnowledge(
          {
            // Ask the server to file the insights straight into the ontology
            // store; `filed` in the response carries the canonical records.
            file: true,
            conversation: {
              id: targetConvId,
              title: conversationTitle,
              projectId: initiatingProjectId,
            },
            messages: extractionMessages,
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
            if (result.filedScope && result.filedScope.ownerType === "org") {
              // Shared-project chat: the concepts belong to the company
              // Brain, never the personal one. The company layer poll picks
              // them up; filing locally would leak them into "My Brain".
              return;
            }
            // Auto-sorted workspace filings: refresh each workspace's cached
            // knowledge and surface a banner with undo. The records
            // themselves never enter the synced personal snapshot — shared
            // content must stay evictable.
            const workspaceFilings = Array.isArray(result.workspaceFilings)
              ? result.workspaceFilings
              : [];
            for (const filing of workspaceFilings) {
              void queryClient.invalidateQueries({
                queryKey: getGetSharedWorkspaceKnowledgeQueryKey(
                  filing.workspaceId,
                ),
              });
            }
            if (workspaceFilings.length > 0) {
              setFilingNotices((current) => [
                ...current,
                ...workspaceFilings.map((filing) => ({
                  noticeId: filing.noticeId,
                  workspaceId: filing.workspaceId,
                  workspaceName: filing.workspaceName,
                  labels: Array.isArray(filing.labels) ? filing.labels : [],
                  conversationRef,
                })),
              ]);
            }
            if (result.filed && result.filed.length > 0) {
              // The server filed these into the personal ontology store
              // already (including author-private unsorted holds); mirror
              // its canonical records locally.
              applyFiledKnowledge(conversationRef, result.filed);
            } else if (!result.filed && workspaceFilings.length === 0) {
              // Older server or filing hiccup: fall back to local filing,
              // which reaches the store on the next workspace sync. Never
              // when the server answered — refiling consumed clusters
              // locally would misfile workspace knowledge into "My Brain".
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

  // One-tap undo for an auto-filed workspace item: the server moves it back
  // to the author-private Unsorted holding area and returns the restored
  // records, which land straight back in this device's store.
  const undoFiling = useCallback(
    async (notice: FilingNotice) => {
      try {
        const result = await undoVenomKnowledgeMove(notice.noticeId);
        // A non-2xx resolves to the error body: undo window closed or the
        // record changed since filing. Terminal — drop the stale banner.
        const refusal = result as { restored?: unknown; error?: string } | null;
        if (!refusal || !Array.isArray(refusal.restored)) {
          setFilingNotices((current) =>
            current.filter((entry) => entry.noticeId !== notice.noticeId),
          );
          Alert.alert(
            'Undo unavailable',
            refusal?.error ??
              'This knowledge changed since it was filed, so it can no longer be undone automatically.',
          );
          return;
        }
        void queryClient.invalidateQueries({
          queryKey: getGetSharedWorkspaceKnowledgeQueryKey(notice.workspaceId),
        });
        const restored = Array.isArray(result.restored) ? result.restored : [];
        if (restored.length > 0) {
          applyFiledKnowledge(notice.conversationRef, restored);
        }
        setFilingNotices((current) =>
          current.filter((entry) => entry.noticeId !== notice.noticeId),
        );
      } catch {
        // Keep the banner so the user can retry; the Brain screen also
        // lists recent moves with undo.
        Alert.alert(
          "Could not undo",
          "The filing may have changed since. Recent moves are listed on the Brain screen.",
        );
      }
    },
    [queryClient, applyFiledKnowledge],
  );

  const dismissFilingNotice = useCallback((noticeId: string) => {
    setFilingNotices((current) =>
      current.filter((entry) => entry.noticeId !== noticeId),
    );
  }, []);

  return {
    text,
    setText,
    isStreaming,
    showTyping,
    streamError,
    localStreamingMessage,
    localDeliberation,
    localDebate,
    streamingConvId,
    localFileActivity,
    filingNotices,
    undoFiling,
    dismissFilingNotice,
    handleSend,
    handleStopDebate,
    canonTeach,
    handleCanonConfirm,
    handleCanonCancel,
  };
}
