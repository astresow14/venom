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
  Dimensions,
  TouchableOpacity,
  ScrollView,
  Animated as RNAnimated,
  PanResponder,
  TextInput,
  FlatList,
  ActivityIndicator,
  Platform,
  Keyboard,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { fetch } from "expo/fetch";
import * as Haptics from "expo-haptics";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  interpolate,
  Extrapolate,
  runOnJS,
  withTiming,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

import { useColors } from "@/hooks/useColors";
import { useTheme } from "@/context/ThemeContext";
import {
  useVenom,
  Message,
  KnowledgeCluster,
  Task,
  TaskStatus,
} from "@/context/VenomContext";
import { useExtractVenomKnowledge } from "@workspace/api-client-react";

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");

let messageCounter = 0;
function generateUniqueId(): string {
  messageCounter++;
  return `msg-${Date.now()}-${messageCounter}-${Math.random().toString(36).substr(2, 9)}`;
}

// --- Components ---

function ChatWorkspace({
  isActive,
  activeProject,
}: {
  isActive: boolean;
  activeProject: any;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const {
    state,
    isReady,
    addMessage,
    setActiveConversation,
    createNewConversation,
    applyKnowledgeInsights,
  } = useVenom();
  const extractKnowledge = useExtractVenomKnowledge();

  const [text, setText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [showTyping, setShowTyping] = useState(false);
  const [localStreamingMessage, setLocalStreamingMessage] =
    useState<Message | null>(null);

  const inputRef = useRef<TextInput>(null);
  const initializedRef = useRef(false);

  const activeConv = state.conversations.find(
    (c) => c.id === state.activeConversationId,
  );
  const contextMessages = activeConv?.messages || [];

  const displayMessages = localStreamingMessage
    ? [...contextMessages, localStreamingMessage]
    : contextMessages;

  const reversedMessages = [...displayMessages].reverse();

  useEffect(() => {
    if (isReady && !state.activeConversationId && !initializedRef.current) {
      initializedRef.current = true;
      const newId = createNewConversation(state.activeProjectId);
      setActiveConversation(newId);
    }
  }, [
    isReady,
    state.activeConversationId,
    createNewConversation,
    setActiveConversation,
    state.activeProjectId,
  ]);

  async function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;

    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    setText("");

    let targetConvId = state.activeConversationId;
    if (!targetConvId) {
      targetConvId = createNewConversation(state.activeProjectId);
      setActiveConversation(targetConvId);
    }

    const userMessageId = generateUniqueId();
    addMessage(targetConvId, {
      id: userMessageId,
      role: "user",
      content: trimmed,
      status: "sent",
    });

    setIsStreaming(true);
    setShowTyping(true);

    let fullContent = "";
    let requestFailed = false;
    let hasReceivedFirstChunk = false;
    const streamId = generateUniqueId();

    try {
      const baseUrl = `https://${process.env.EXPO_PUBLIC_DOMAIN}`;
      const chatHistory = [
        ...contextMessages
          .slice(-23)
          .map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: trimmed },
      ];

      const response = await fetch(`${baseUrl}/api/venom/respond`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          messages: chatHistory,
          projectContext: activeProject
            ? `Project: ${activeProject.name}\n${activeProject.description}`
            : undefined,
        }),
      });

      if (!response.ok) throw new Error("Network error");

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No stream");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          if (data.includes('"done":true')) continue;

          try {
            const parsed = JSON.parse(data);
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
          } catch (e) {}
        }
      }
    } catch (error) {
      console.error(error);
      requestFailed = true;
      setShowTyping(false);
      setLocalStreamingMessage({
        id: streamId,
        role: "assistant",
        content: "I lost connection to the server. Please try again.",
        createdAt: Date.now(),
        status: "error",
      });
      fullContent = "I lost connection to the server. Please try again.";
    } finally {
      setIsStreaming(false);
      setShowTyping(false);

      if (fullContent) {
        addMessage(targetConvId, {
          id: streamId,
          role: "assistant",
          content: fullContent,
          status: "sent",
        });
      }
      setLocalStreamingMessage(null);

      if (fullContent && !requestFailed) {
        const conversation = state.conversations.find(
          (item) => item.id === targetConvId,
        );
        const conversationTitle =
          conversation?.title === "New Session"
            ? `${trimmed.slice(0, 30)}...`
            : conversation?.title ?? "New Session";

        void extractKnowledge
          .mutateAsync({
            data: {
              conversation: {
                id: targetConvId,
                title: conversationTitle,
                projectId: activeProject?.id ?? null,
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
          })
          .then((result) => {
            applyKnowledgeInsights(
              {
                id: targetConvId,
                title: conversationTitle,
                projectId: activeProject?.id ?? null,
              },
              result.clusters,
            );
          })
          .catch(() => {
            // Chat remains usable when background extraction is unavailable.
          });
      }

      if (isActive && Platform.OS !== "web") {
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    }
  }

  const renderMessage = ({ item }: { item: Message }) => {
    const isUser = item.role === "user";
    return (
      <View
        style={[
          styles.messageRow,
          isUser ? styles.messageUser : styles.messageAssistant,
        ]}
      >
        <View
          style={[
            styles.messageBubble,
            isUser
              ? [styles.bubbleUser, { backgroundColor: colors.secondary }]
              : styles.bubbleAssistant,
            item.status === "error" && {
              borderColor: colors.destructive,
              borderWidth: 1,
            },
          ]}
        >
          <Text
            style={[
              styles.messageText,
              { color: isUser ? colors.foreground : colors.foreground },
            ]}
          >
            {item.content}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.workspaceContainer}>
      <FlatList
        data={reversedMessages}
        keyExtractor={(item) => item.id}
        renderItem={renderMessage}
        inverted={reversedMessages.length > 0}
        contentContainerStyle={[styles.listContent, { paddingBottom: 24 }]}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        scrollEnabled={reversedMessages.length > 0}
        ListHeaderComponent={
          showTyping ? (
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
            paddingBottom: Math.max(insets.bottom, 16),
          },
        ]}
      >
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
            placeholder="Message..."
            placeholderTextColor={colors.mutedForeground}
            value={text}
            onChangeText={setText}
            multiline
            maxLength={1000}
            blurOnSubmit={false}
          />
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
            disabled={!text.trim() || isStreaming}
            hitSlop={12}
            testID="send-message-button"
            accessibilityRole="button"
            accessibilityLabel="Send message"
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

function KnowledgeWorkspace({
  onOpenConversation,
}: {
  onOpenConversation: (conversationId: string) => void;
}) {
  const colors = useColors();
  const {
    state,
    renameKnowledgeCluster,
    deleteKnowledgeCluster,
    mergeKnowledgeClusters,
  } = useVenom();
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(
    null,
  );
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [isChoosingMerge, setIsChoosingMerge] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const visibleClusters = state.clusters.filter(
    (cluster) => cluster.projectId === state.activeProjectId,
  );
  const selectedCluster =
    visibleClusters.find((cluster) => cluster.id === selectedClusterId) ??
    null;

  const MAP_SIZE = 800;
  const CENTER = MAP_SIZE / 2;

  const getPos = useCallback(
    (c: KnowledgeCluster) => ({
      x: CENTER + c.x * 2.5,
      y: CENTER + c.y * 2.5,
    }),
    [CENTER],
  );

  const closeDetails = () => {
    setSelectedClusterId(null);
    setIsRenaming(false);
    setIsChoosingMerge(false);
    setIsConfirmingDelete(false);
    setEditError(null);
  };

  const openCluster = (clusterId: string) => {
    setSelectedClusterId(clusterId);
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
          <ScrollView
            horizontal
            bounces={false}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ width: MAP_SIZE }}
            centerContent
          >
            <ScrollView
              bounces={false}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ height: MAP_SIZE, width: MAP_SIZE }}
              centerContent
            >
              <View style={{ width: MAP_SIZE, height: MAP_SIZE }}>
                {/* SVG Lines - Simplified for web compatibility/expo go without react-native-svg if needed,
                    using absolute views for simple lines */}
                {visibleClusters.map((cluster) => {
                  const p1 = getPos(cluster);
                  return cluster.links.map((targetId) => {
                    const target = visibleClusters.find(
                      (candidate) => candidate.id === targetId,
                    );
                    if (!target) return null;
                    if (cluster.id > target.id) return null;

                    const p2 = getPos(target);
                    const dx = p2.x - p1.x;
                    const dy = p2.y - p1.y;
                    const length = Math.sqrt(dx * dx + dy * dy);
                    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

                    return (
                      <View
                        key={`${cluster.id}-${targetId}`}
                        style={{
                          position: "absolute",
                          left: p1.x,
                          top: p1.y,
                          width: length,
                          height: 1,
                          backgroundColor: colors.border,
                          transform: [
                            { translateX: -length / 2 + dx / 2 },
                            { translateY: dy / 2 },
                            { rotate: `${angle}deg` },
                          ],
                        }}
                      />
                    );
                  });
                })}

                {/* Nodes */}
                {visibleClusters.map((cluster) => {
                  const p = getPos(cluster);
                  const isSelected = selectedCluster?.id === cluster.id;
                  const size = 32 + cluster.strength * 16;

                  return (
                    <TouchableOpacity
                      key={cluster.id}
                      testID={`knowledge-cluster-${cluster.id}`}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${cluster.label} knowledge cluster`}
                      style={[
                        styles.node,
                        {
                          left: p.x - size / 2,
                          top: p.y - size / 2,
                          width: size,
                          height: size,
                          borderRadius: size / 2,
                          backgroundColor: isSelected
                            ? colors.primary
                            : colors.card,
                          borderColor: isSelected
                            ? colors.primary
                            : colors.border,
                          borderWidth: 2,
                          shadowColor: colors.foreground,
                          shadowOpacity: isSelected ? 0.1 : 0.05,
                          shadowRadius: 8,
                          shadowOffset: { width: 0, height: 4 },
                          elevation: isSelected ? 4 : 2,
                        },
                      ]}
                      onPress={() => {
                        if (Platform.OS !== "web") Haptics.selectionAsync();
                        openCluster(cluster.id);
                      }}
                      activeOpacity={0.8}
                    >
                      <Feather
                        name={
                          cluster.category === "core"
                            ? "cpu"
                            : cluster.category === "data"
                              ? "database"
                              : "folder"
                        }
                        size={14}
                        color={
                          isSelected
                            ? colors.primaryForeground
                            : colors.mutedForeground
                        }
                      />
                    </TouchableOpacity>
                  );
                })}

                {/* Labels */}
                {visibleClusters.map((cluster) => {
                  const p = getPos(cluster);
                  const isSelected = selectedCluster?.id === cluster.id;
                  const size = 32 + cluster.strength * 16;

                  return (
                    <View
                      key={`label-${cluster.id}`}
                      style={[
                        styles.nodeLabelContainer,
                        {
                          left: p.x - 75,
                          top: p.y + size / 2 + 8,
                        },
                      ]}
                      pointerEvents="none"
                    >
                      <Text
                        style={[
                          styles.nodeLabel,
                          {
                            color: isSelected
                              ? colors.foreground
                              : colors.mutedForeground,
                            fontFamily: isSelected
                              ? "Inter_600SemiBold"
                              : "Inter_500Medium",
                          },
                        ]}
                      >
                        {cluster.label}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </ScrollView>
          </ScrollView>
        )}

        {/* Info Panel Overlay */}
        {selectedCluster && (
          <View
            style={[
              styles.knowledgeInfoPanel,
              {
                backgroundColor: colors.background,
                borderTopColor: colors.border,
              },
            ]}
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
                {selectedCluster.summary}
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
                >
                  <Feather name="git-merge" size={15} color={colors.foreground} />
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
                >
                  <Feather name="trash-2" size={15} color={colors.destructive} />
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
                    { backgroundColor: colors.card, borderColor: colors.border },
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
                    { backgroundColor: colors.card, borderColor: colors.border },
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
                {selectedCluster.sources.map((source) => (
                  <TouchableOpacity
                    key={source.conversationId}
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
                        {source.excerpt}
                      </Text>
                    </View>
                    <Feather
                      name="arrow-up-right"
                      size={16}
                      color={colors.primary}
                    />
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          </View>
        )}
      </View>
    </View>
  );
}

function BoardWorkspace({ activeProject }: { activeProject: any }) {
  const colors = useColors();
  const { addTask, updateTaskStatus, deleteTask } = useVenom();
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [isAdding, setIsAdding] = useState(false);

  const tasks = activeProject?.tasks || [];
  const todoTasks = tasks.filter((t: Task) => t.status === "todo");
  const inProgressTasks = tasks.filter((t: Task) => t.status === "in_progress");
  const doneTasks = tasks.filter((t: Task) => t.status === "done");

  const handleAddTask = () => {
    const trimmed = newTaskTitle.trim();
    if (trimmed && activeProject) {
      addTask(activeProject.id, trimmed);
      setNewTaskTitle("");
      setIsAdding(false);
      if (Platform.OS !== "web")
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  const handleToggleStatus = (task: Task) => {
    if (!activeProject) return;
    if (Platform.OS !== "web")
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    let nextStatus: TaskStatus = "todo";
    if (task.status === "todo") nextStatus = "in_progress";
    else if (task.status === "in_progress") nextStatus = "done";

    updateTaskStatus(activeProject.id, task.id, nextStatus);
  };

  const handleDelete = (task: Task) => {
    if (!activeProject) return;
    if (Platform.OS !== "web")
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    deleteTask(activeProject.id, task.id);
  };

  const renderTaskCard = (task: Task) => {
    return (
      <TouchableOpacity
        key={task.id}
        style={[
          styles.kanbanCard,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
        onPress={() => handleToggleStatus(task)}
        activeOpacity={0.7}
      >
        <Text
          style={[
            styles.kanbanCardTitle,
            {
              color:
                task.status === "done"
                  ? colors.mutedForeground
                  : colors.foreground,
            },
            task.status === "done" && { textDecorationLine: "line-through" },
          ]}
        >
          {task.title}
        </Text>
        <TouchableOpacity
          style={styles.kanbanCardDelete}
          onPress={() => handleDelete(task)}
          hitSlop={12}
        >
          <Feather name="x" size={12} color={colors.mutedForeground} />
        </TouchableOpacity>
      </TouchableOpacity>
    );
  };

  const renderColumn = (
    title: string,
    status: TaskStatus,
    columnTasks: Task[],
  ) => (
    <View style={styles.boardColumn}>
      <View style={styles.boardColumnHeader}>
        <Text style={[styles.boardColumnTitle, { color: colors.foreground }]}>
          {title}
        </Text>
        <Text
          style={[styles.boardColumnCount, { color: colors.mutedForeground }]}
        >
          {columnTasks.length}
        </Text>
      </View>
      <View style={styles.boardColumnList}>
        {columnTasks.map(renderTaskCard)}
      </View>
    </View>
  );

  return (
    <View style={styles.workspaceContainer}>
      <ScrollView
        contentContainerStyle={styles.boardScrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.boardHeader}>
          <Text style={[styles.boardTitle, { color: colors.foreground }]}>
            Task Board
          </Text>
          <TouchableOpacity
            style={[styles.addBoardBtn, { backgroundColor: colors.primary }]}
            onPress={() => setIsAdding(true)}
            testID="add-task-button"
          >
            <Feather name="plus" size={14} color={colors.primaryForeground} />
            <Text
              style={[
                styles.addBoardBtnText,
                { color: colors.primaryForeground },
              ]}
            >
              New Task
            </Text>
          </TouchableOpacity>
        </View>

        {isAdding && (
          <View
            style={[
              styles.addTaskForm,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <TextInput
              style={[styles.addTaskInput, { color: colors.foreground }]}
              placeholder="What needs to be done?"
              placeholderTextColor={colors.mutedForeground}
              value={newTaskTitle}
              onChangeText={setNewTaskTitle}
              autoFocus
              onSubmitEditing={handleAddTask}
              returnKeyType="done"
            />
            <View style={styles.addTaskActions}>
              <TouchableOpacity
                onPress={() => setIsAdding(false)}
                style={styles.addTaskCancel}
              >
                <Text
                  style={[
                    styles.addTaskCancelText,
                    { color: colors.mutedForeground },
                  ]}
                >
                  Cancel
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleAddTask}
                style={[
                  styles.addTaskSubmit,
                  {
                    backgroundColor: newTaskTitle.trim()
                      ? colors.primary
                      : colors.secondary,
                  },
                ]}
                disabled={!newTaskTitle.trim()}
              >
                <Text
                  style={[
                    styles.addTaskSubmitText,
                    {
                      color: newTaskTitle.trim()
                        ? colors.primaryForeground
                        : colors.mutedForeground,
                    },
                  ]}
                >
                  Add
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {tasks.length === 0 && !isAdding ? (
          <View style={styles.boardEmpty}>
            <Feather
              name="check-circle"
              size={32}
              color={colors.mutedForeground}
              style={{ opacity: 0.5, marginBottom: 12 }}
            />
            <Text style={[styles.boardEmptyText, { color: colors.foreground }]}>
              All caught up
            </Text>
            <Text
              style={[
                styles.boardEmptySubtext,
                { color: colors.mutedForeground },
              ]}
            >
              Create a task to get started.
            </Text>
          </View>
        ) : (
          <View style={styles.boardColumnsContainer}>
            {renderColumn("To Do", "todo", todoTasks)}
            {renderColumn("Active", "in_progress", inProgressTasks)}
            {renderColumn("Done", "done", doneTasks)}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// --- Main Screen ---

export default function WorkspaceScreen() {
  const colors = useColors();
  const { theme, toggleTheme } = useTheme();
  const insets = useSafeAreaInsets();
  const { state, setActiveConversation, setActiveProject } = useVenom();

  const [activeIndex, setActiveIndex] = useState(0);
  const activeProject =
    state.projects.find((p) => p.id === state.activeProjectId) ||
    state.projects[0];

  const scrollViewRef = useRef<ScrollView>(null);

  const handleTabPress = (index: number) => {
    setActiveIndex(index);
    scrollViewRef.current?.scrollTo({
      x: index * SCREEN_WIDTH,
      animated: true,
    });
    if (Platform.OS !== "web") {
      Haptics.selectionAsync();
    }
  };

  const handleScroll = (e: any) => {
    const offsetX = e.nativeEvent.contentOffset.x;
    const index = Math.round(offsetX / SCREEN_WIDTH);
    if (index !== activeIndex && index >= 0 && index < 3) {
      setActiveIndex(index);
    }
  };

  const handleOpenConversation = (conversationId: string) => {
    const conversation = state.conversations.find(
      (item) => item.id === conversationId,
    );
    if (!conversation) return;

    setActiveProject(conversation.projectId);
    setActiveConversation(conversation.id);
    handleTabPress(0);
  };

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
            paddingTop: Math.max(insets.top, 16),
            backgroundColor: colors.background,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <View style={styles.navTabs}>
          {["Chat", "Knowledge", "Board"].map((title, i) => {
            const isActive = activeIndex === i;
            return (
              <TouchableOpacity
                key={title}
                onPress={() => handleTabPress(i)}
                style={styles.navTab}
                hitSlop={10}
              >
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
        </View>
        <View style={styles.navActions}>
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
          <TouchableOpacity style={styles.navProject} activeOpacity={0.7}>
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

      {/* Swipeable Workspaces */}
      <ScrollView
        ref={scrollViewRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        bounces={false}
        onMomentumScrollEnd={handleScroll}
        scrollEventThrottle={16}
        style={styles.workspacePager}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.workspacePage, { width: SCREEN_WIDTH }]}>
          <ChatWorkspace
            isActive={activeIndex === 0}
            activeProject={activeProject}
          />
        </View>
        <View style={[styles.workspacePage, { width: SCREEN_WIDTH }]}>
          <KnowledgeWorkspace onOpenConversation={handleOpenConversation} />
        </View>
        <View style={[styles.workspacePage, { width: SCREEN_WIDTH }]}>
          <BoardWorkspace activeProject={activeProject} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
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
    gap: 16,
    flexShrink: 0,
  },
  navTab: {
    paddingVertical: 12,
    position: "relative",
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
  navProjectText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    flexShrink: 1,
  },
  workspacePager: {
    flex: 1,
  },
  workspacePage: {
    flex: 1,
  },
  workspaceContainer: {
    flex: 1,
  },

  // Chat Styles
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
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
  messageBubble: {
    maxWidth: "85%",
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
  typingContainer: {
    paddingVertical: 12,
    marginBottom: 16,
    alignItems: "flex-start",
    paddingHorizontal: 16,
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

  // Knowledge Styles
  knowledgeContainer: {
    flex: 1,
    position: "relative",
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
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.8,
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
    padding: 16,
    paddingBottom: 40,
  },
  boardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 20,
  },
  boardTitle: {
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
  },
  addBoardBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    gap: 4,
  },
  addBoardBtnText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  addTaskForm: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  addTaskInput: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    marginBottom: 16,
  },
  addTaskActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 12,
    alignItems: "center",
  },
  addTaskCancel: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  addTaskCancelText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  addTaskSubmit: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 16,
  },
  addTaskSubmitText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  boardEmpty: {
    padding: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  boardEmptyText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 4,
  },
  boardEmptySubtext: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  boardColumnsContainer: {
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-start",
  },
  boardColumn: {
    flex: 1,
  },
  boardColumnHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 12,
  },
  boardColumnTitle: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    textTransform: "uppercase",
  },
  boardColumnCount: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  boardColumnList: {
    gap: 8,
  },
  kanbanCard: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    position: "relative",
  },
  kanbanCardTitle: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
    paddingRight: 14,
  },
  kanbanCardDelete: {
    position: "absolute",
    top: 6,
    right: 6,
    padding: 4,
    opacity: 0.6,
  },
});
