import React, { useEffect, useRef, useState } from "react";
import { Alert, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useAuth } from "@clerk/expo";
import { Feather } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  useGetVenomDeliberation,
  useGetVenomModels,
  type VenomManagedModel,
  type VenomMessageAttachment,
  type VenomResponseMode,
} from "@workspace/api-client-react";
import { type BlendCorner } from "@/components/BlendPad";
import { CanonTeachCard } from "@/components/chat/CanonTeachCard";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { generateUniqueId } from "@/components/chat/ids";
import { MessageList } from "@/components/chat/MessageList";
import { SessionControls } from "@/components/chat/SessionControls";
import { useChatSend } from "@/components/chat/useChatSend";
import { type PendingChatFile } from "@/components/ChatFileCards";
import {
  type BlendWeights,
  EVEN_BLEND,
  isResponseMode,
  normalizeConversationBlend,
} from "@/context/responsePrefs";
import {
  IS_UI_TEST,
  type ProjectSource,
  useVenom,
  type VenomModelId,
} from "@/context/VenomContext";
import { useColors } from "@/hooks/useColors";
import {
  attachmentStamp,
  CHAT_FILE_MIME_TYPES,
  chatFileErrorMessage,
  chatFileProblem,
  downloadChatFile,
  isImageName,
  MAX_MESSAGE_ATTACHMENTS,
  uploadChatFile,
  type ChatUploadSource,
} from "@/lib/chatFiles";
import {
  makeImageThumbnail,
  prepareImageForUpload,
  type PickedImageSource,
} from "@/lib/chatImages";
import { useUnsyncedIndicator } from "@/hooks/useUnsyncedIndicator";
import { UI_TEST_CHAT_TOKEN } from "@/lib/uiTestChat";
import { styles } from "./styles";

/**
 * The chat screen, as composition: session controls, the message list, and
 * the composer, wired to the send/stream loop in useChatSend. This component
 * keeps only what the pieces share — conversation/blend derivation, project
 * sources and citation maps, and the composer's file attachments.
 */
export function ChatWorkspace({
  isActive,
  activeProject,
}: {
  isActive: boolean;
  activeProject: any;
}) {
  const { getToken } = useAuth();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const {
    state,
    isReady,
    syncStatus,
    setActiveConversation,
    createNewConversation,
    setActiveModel,
    setConversationResponsePrefs,
  } = useVenom();
  // Live pad weights while a drag is in flight; null means show the stored
  // per-conversation blend.
  const [draftWeights, setDraftWeights] = useState<BlendWeights | null>(null);

  // Cloud-lag notice: after a save fails, this device is holding work the
  // cloud does not have, and the person writing deserves to see that in chat
  // rather than in Settings. The arm-on-failure / sustain-through-retry
  // timing lives in useUnsyncedIndicator, shared with the board notice and
  // the header cloud icon so every tab tells the same story.
  const showUnsyncedNotice = useUnsyncedIndicator(syncStatus);

  const unsyncedNoticeText = showUnsyncedNotice
    ? syncStatus === "too_large"
      ? "Latest messages are saved on this device only — this workspace is too large to sync right now."
      : "Latest messages are saved on this device only — they'll sync when the connection returns."
    : null;

  // Model preferences from workspace state
  const modelPreferences = state.modelPreferences;
  const activeModelId = (modelPreferences?.activeModelId ?? "venom-gpt") as VenomModelId;
  const enabledModelIds = (modelPreferences?.enabledModelIds ?? ["venom-gpt"]) as VenomModelId[];

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
  // Resolves a turn's model to its family for the speaker avatars; the
  // catalog is already fetched here, so leaf components never re-query.
  const familyForModel = (modelId: string) =>
    allModels.find((m) => m.id === modelId)?.family;

  const inputRef = useRef<TextInput>(null);
  const initializedRef = useRef(false);

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
  // Pad corners: enabled models that are actually available and whose
  // provider account can pay. With fewer than three real providers, the
  // deliberation personas fill the corners so the pad always works; the
  // control never shows models that cannot actually answer — the corners
  // double as the debate roster, so a billing-dead model must not be
  // auto-seated here.
  const cornerCandidates = allModels.filter(
    (model) =>
      model.available &&
      model.accountHealth !== "unfunded" &&
      enabledModelIds.includes(model.id as VenomModelId),
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

  // Files queued in the composer for the next message and the attachment
  // currently downloading; the live document-writing state rides the send
  // loop in useChatSend.
  const [pendingFiles, setPendingFiles] = useState<PendingChatFile[]>([]);
  const [downloadingFileId, setDownloadingFileId] = useState<string | null>(
    null,
  );

  const {
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
  } = useChatSend({
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
  });

  /**
   * Queue one picked source: preflight, chip, background upload. Images
   * additionally get a tiny synced thumbnail and a possibly-downscaled
   * (or HEIC→JPEG) upload rendition before the handshake.
   */
  const queueSource = (source: ChatUploadSource & PickedImageSource) => {
    const key = generateUniqueId();
    const name = source.name ?? "file";
    const size = source.size ?? 0;
    const problem = chatFileProblem(name, size);
    if (problem) {
      setPendingFiles((prev) => [
        ...prev,
        { key, name, size, status: "error", error: problem },
      ]);
      return;
    }
    setPendingFiles((prev) => [
      ...prev,
      { key, name, size, status: "uploading" },
    ]);
    void (async () => {
      try {
        const token = IS_UI_TEST ? UI_TEST_CHAT_TOKEN : await getToken();
        if (!token) throw new Error("Sign in to attach files.");
        const image = isImageName(name);
        const thumbnail = image
          ? ((await makeImageThumbnail(source)) ?? undefined)
          : undefined;
        if (thumbnail) {
          setPendingFiles((prev) =>
            prev.map((item) =>
              item.key === key ? { ...item, thumbnail } : item,
            ),
          );
        }
        const upload = image ? await prepareImageForUpload(source) : source;
        const file = await uploadChatFile(upload, token);
        setPendingFiles((prev) =>
          prev.map((item) =>
            item.key === key
              ? {
                  ...item,
                  status: "ready",
                  name: file.name,
                  size: file.size,
                  stamp: attachmentStamp(file, thumbnail),
                }
              : item,
          ),
        );
      } catch (error) {
        setPendingFiles((prev) =>
          prev.map((item) =>
            item.key === key
              ? {
                  ...item,
                  status: "error",
                  error: chatFileErrorMessage(error),
                }
              : item,
          ),
        );
      }
    })();
  };

  const handlePickFiles = async () => {
    if (isStreaming) return;
    const remaining = MAX_MESSAGE_ATTACHMENTS - pendingFiles.length;
    if (remaining <= 0) return;
    let result: DocumentPicker.DocumentPickerResult;
    try {
      result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
        type: CHAT_FILE_MIME_TYPES,
      });
    } catch {
      return; // Picker unavailable; nothing was queued.
    }
    if (result.canceled) return;
    for (const asset of result.assets.slice(0, remaining)) {
      queueSource(asset);
    }
  };

  const handlePickPhotos = async () => {
    if (isStreaming) return;
    const remaining = MAX_MESSAGE_ATTACHMENTS - pendingFiles.length;
    if (remaining <= 0) return;
    let result: ImagePicker.ImagePickerResult;
    try {
      const permission =
        await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          "Venom can't see your photos",
          "Allow photo access in Settings to attach images.",
        );
        return;
      }
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        selectionLimit: remaining,
        quality: 1,
      });
    } catch {
      return; // Picker unavailable; nothing was queued.
    }
    if (result.canceled) return;
    for (const asset of result.assets.slice(0, remaining)) {
      queueSource({
        uri: asset.uri,
        name: asset.fileName ?? `photo-${Date.now()}.jpg`,
        size: asset.fileSize ?? 0,
        mimeType: asset.mimeType ?? null,
        width: asset.width,
        height: asset.height,
        file: (asset as { file?: File }).file,
      });
    }
  };

  const removePendingFile = (key: string) => {
    setPendingFiles((prev) => prev.filter((item) => item.key !== key));
  };

  const handleDownloadAttachment = async (
    attachment: VenomMessageAttachment,
  ) => {
    if (downloadingFileId) return;
    setDownloadingFileId(attachment.id);
    try {
      const token = IS_UI_TEST ? UI_TEST_CHAT_TOKEN : await getToken();
      if (!token) throw new Error("Sign in to download files.");
      await downloadChatFile(attachment, token);
    } catch (error) {
      Alert.alert(
        "Download failed",
        chatFileErrorMessage(
          error,
          "The file couldn't be downloaded. Try again.",
        ),
      );
    } finally {
      setDownloadingFileId(null);
    }
  };

  // Transient turn UI renders only while the conversation that asked is the
  // one on screen. The state itself survives a switch — hiding is scoping,
  // not teardown — so coming back mid-turn restores the live panel.
  const liveTurnOnScreen =
    streamingConvId !== null && streamingConvId === state.activeConversationId;
  // The debate composer affordances (placeholder, stop, interject) follow the
  // same rule: they act on the debate's own chat, so they only show there.
  const debateOnScreen =
    Boolean(localDebate) && isStreaming && liveTurnOnScreen;

  const displayMessages =
    localStreamingMessage && liveTurnOnScreen
      ? [...contextMessages, localStreamingMessage]
      : contextMessages;

  const reversedMessages = [...displayMessages].reverse();

  return (
    <View style={styles.workspaceContainer}>
      <SessionControls
        colors={colors}
        activeProject={activeProject}
        onScreenProjectId={onScreenProjectId}
        hasMessages={contextMessages.length > 0}
        isStreaming={isStreaming}
      />
      <MessageList
        messages={reversedMessages}
        colors={colors}
        citationsById={citationsById}
        archivedCitationsById={archivedCitationsById}
        sourceByCitationId={sourceByCitationId}
        streamError={streamError}
        downloadingFileId={downloadingFileId}
        onDownloadAttachment={handleDownloadAttachment}
        liveTurnOnScreen={liveTurnOnScreen}
        localDebate={localDebate}
        localDeliberation={localDeliberation}
        localFileActivity={localFileActivity}
        showTyping={showTyping}
        familyForModel={familyForModel}
      />
      {canonTeach && canonTeach.convId === state.activeConversationId ? (
        <CanonTeachCard
          state={canonTeach}
          onConfirm={handleCanonConfirm}
          onCancel={handleCanonCancel}
        />
      ) : null}
      {filingNotices.length > 0 && (
        <View style={styles.filingNotices} testID="filing-notices">
          {filingNotices.map((notice) => (
            <View
              key={notice.noticeId}
              style={[
                styles.filingNotice,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
              testID={`filing-notice-${notice.noticeId}`}
            >
              <Feather name="inbox" size={14} color={colors.mutedForeground} />
              <Text
                style={[styles.filingNoticeText, { color: colors.foreground }]}
                numberOfLines={2}
              >
                Filed to {notice.workspaceName}
                {notice.labels.length > 0
                  ? ` — ${notice.labels.slice(0, 2).join(", ")}${
                      notice.labels.length > 2 ? "…" : ""
                    }`
                  : ""}
              </Text>
              <TouchableOpacity
                onPress={() => void undoFiling(notice)}
                accessibilityRole="button"
                accessibilityLabel={`Undo filing to ${notice.workspaceName}`}
                testID={`button-undo-filing-${notice.noticeId}`}
              >
                <Text
                  style={[styles.filingNoticeAction, { color: colors.primary }]}
                >
                  Undo
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => dismissFilingNotice(notice.noticeId)}
                accessibilityRole="button"
                accessibilityLabel="Dismiss filing notice"
                testID={`button-dismiss-filing-${notice.noticeId}`}
              >
                <Feather name="x" size={14} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}
      <ChatComposer
        colors={colors}
        insets={insets}
        activeProject={activeProject}
        deliberationAvailable={deliberationAvailable}
        responseMode={responseMode}
        onModeChange={handleModeChange}
        blendCorners={blendCorners}
        padWeights={padWeights}
        onPadChange={setDraftWeights}
        onPadCommit={commitBlend}
        cornersPickable={cornersPickable}
        cornerCandidates={cornerCandidates}
        onCornerPick={handleCornerPick}
        enabledModels={enabledModels}
        activeModelId={activeModelId}
        onSelectModel={setActiveModel}
        selectionPolicy={modelPreferences?.selectionPolicy ?? "manual"}
        unsyncedNoticeText={unsyncedNoticeText}
        pendingFiles={pendingFiles}
        onRemovePendingFile={removePendingFile}
        onPickFiles={handlePickFiles}
        onPickPhotos={handlePickPhotos}
        inputRef={inputRef}
        text={text}
        onChangeText={setText}
        isStreaming={isStreaming}
        debateOnScreen={debateOnScreen}
        onStopDebate={handleStopDebate}
        onSend={handleSend}
      />
    </View>
  );
}
