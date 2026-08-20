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
  Modal,
  AccessibilityInfo,
  findNodeHandle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useAuth } from "@clerk/expo";
import { useRouter } from "expo-router";
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
  interpolate,
  Extrapolate,
  ReduceMotion,
  runOnJS,
  withTiming,
  useReducedMotion,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

import { useColors } from "@/hooks/useColors";
import { useTheme } from "@/context/ThemeContext";
import {
  useVenom,
  IS_READ_ONLY_UI_TEST,
  Message,
  KnowledgeCluster,
  Task,
  KanbanField,
  KanbanFieldType,
  KanbanStage,
} from "@/context/VenomContext";
import { extractVenomKnowledge } from "@workspace/api-client-react";
import { BrainNoteComposer } from "@/components/BrainNoteComposer";

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
  const { getToken, userId } = useAuth();
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
  const [text, setText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [showTyping, setShowTyping] = useState(false);
  const [localStreamingMessage, setLocalStreamingMessage] =
    useState<Message | null>(null);

  const inputRef = useRef<TextInput>(null);
  const initializedRef = useRef(false);
  const activeUserIdRef = useRef<string | null>(userId ?? null);
  const activeRequestAbortRef = useRef<AbortController | null>(null);

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
    const initiatingUserId = userId ?? null;
    if (!trimmed || isStreaming || !initiatingUserId) return;
    const initiatingProjectId = activeProject?.id ?? state.activeProjectId;
    const abortController = new AbortController();
    activeRequestAbortRef.current = abortController;

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
    let requestToken: string | null = null;
    const streamId = generateUniqueId();

    try {
      const domain = process.env.EXPO_PUBLIC_DOMAIN;
      if (!domain) throw new Error("API domain is unavailable");
      const token = await getToken();
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

      const response = await fetch(`${baseUrl}/api/venom/respond`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          messages: chatHistory,
          projectContext: activeProject
            ? `Project: ${activeProject.name}\n${activeProject.description}`
            : undefined,
        }),
        signal: abortController.signal,
      });

      if (activeUserIdRef.current !== initiatingUserId) return;
      if (!response.ok) throw new Error("Network error");

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No stream");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (activeUserIdRef.current !== initiatingUserId) {
          await reader.cancel();
          return;
        }

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
      if (activeUserIdRef.current !== initiatingUserId) return;
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
      if (activeUserIdRef.current !== initiatingUserId) return;
      if (activeRequestAbortRef.current === abortController) {
        activeRequestAbortRef.current = null;
      }
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

      if (fullContent && !requestFailed && requestToken) {
        const conversation = state.conversations.find(
          (item) => item.id === targetConvId,
        );
        const conversationTitle =
          conversation?.title === "New Session"
            ? `${trimmed.slice(0, 30)}...`
            : (conversation?.title ?? "New Session");

        void extractVenomKnowledge(
          {
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
            applyKnowledgeInsights(
              {
                id: targetConvId,
                title: conversationTitle,
                projectId: initiatingProjectId,
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
            paddingBottom: Math.max(
              insets.bottom,
              Platform.OS === "web" ? 34 : 16,
            ),
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

type GraphPoint = { x: number; y: number };
type GraphConnection = {
  id: string;
  from: KnowledgeCluster;
  to: KnowledgeCluster;
  index: number;
};

const MAX_LIVE_CONNECTIONS = 48;

const SYMBIOTE_LOBES = [
  { width: 210, height: 116, x: -105, y: -58, rotate: "-12deg" },
  { width: 104, height: 238, x: -52, y: -119, rotate: "18deg" },
  { width: 74, height: 188, x: -136, y: -94, rotate: "-48deg" },
  { width: 68, height: 212, x: 66, y: -106, rotate: "52deg" },
  { width: 54, height: 170, x: -27, y: -38, rotate: "82deg" },
] as const;

function SymbioteTendrilSegment({
  from,
  to,
  index,
  breath,
  reduceMotion,
}: {
  from: GraphPoint;
  to: GraphPoint;
  index: number;
  breath: SharedValue<number>;
  reduceMotion: boolean;
}) {
  const colors = useColors();
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const thickness = 5 + (index % 3);
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
}: {
  from: GraphPoint;
  to: GraphPoint;
  index: number;
  breath: SharedValue<number>;
  reduceMotion: boolean;
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
      />
      <SymbioteTendrilSegment
        from={control}
        to={to}
        index={index * 2 + 1}
        breath={breath}
        reduceMotion={reduceMotion}
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
  onPress,
}: {
  cluster: KnowledgeCluster;
  position: GraphPoint;
  index: number;
  isSelected: boolean;
  breath: SharedValue<number>;
  reduceMotion: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  const size = 34 + cluster.strength * 18;
  const depthScale = 0.88 + (position.y / 800) * 0.22;

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
            top: position.y + size / 2 + 10,
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
    renameKnowledgeCluster,
    deleteKnowledgeCluster,
    mergeKnowledgeClusters,
  } = useVenom();
  const captureButtonRef =
    useRef<React.ElementRef<typeof TouchableOpacity>>(null);
  const [composerProjectId, setComposerProjectId] = useState<string | null>(
    null,
  );
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(
    null,
  );
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [isChoosingMerge, setIsChoosingMerge] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const visibleClusters = useMemo<KnowledgeCluster[]>(
    () =>
      state.clusters.filter(
        (cluster: KnowledgeCluster) =>
          cluster.projectId === state.activeProjectId,
      ),
    [state.activeProjectId, state.clusters],
  );
  const selectedCluster =
    visibleClusters.find((cluster) => cluster.id === selectedClusterId) ?? null;
  const composerProject =
    state.projects.find((project) => project.id === composerProjectId) ?? null;

  const MAP_SIZE = 800;
  const CENTER = MAP_SIZE / 2;
  const baseGraphScale = Math.min(
    0.78,
    Math.max(0.46, (windowWidth - 20) / MAP_SIZE),
  );
  const breath = useSharedValue(0);
  const graphScale = useSharedValue(baseGraphScale);
  const savedGraphScale = useSharedValue(baseGraphScale);
  const tiltX = useSharedValue(0);
  const tiltY = useSharedValue(0);

  useEffect(() => {
    cancelAnimation(breath);
    cancelAnimation(graphScale);
    cancelAnimation(tiltX);
    cancelAnimation(tiltY);
    if (!isActive || reduceMotion || IS_READ_ONLY_UI_TEST) {
      breath.value = 0;
      tiltX.value = 0;
      tiltY.value = 0;
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
      cancelAnimation(graphScale);
      cancelAnimation(tiltX);
      cancelAnimation(tiltY);
    };
  }, [breath, graphScale, isActive, reduceMotion, tiltX, tiltY]);

  useEffect(() => {
    graphScale.value = baseGraphScale;
    savedGraphScale.value = baseGraphScale;
  }, [baseGraphScale, graphScale, savedGraphScale]);

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

  const clustersById = useMemo(
    () => new Map(visibleClusters.map((cluster) => [cluster.id, cluster])),
    [visibleClusters],
  );
  const liveConnections = useMemo<GraphConnection[]>(() => {
    const connections: GraphConnection[] = [];
    const seen = new Set<string>();

    for (const cluster of visibleClusters) {
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
  }, [clustersById, visibleClusters]);

  const getPos = useCallback(
    (c: KnowledgeCluster) => ({
      x: CENTER + c.x * 2.5,
      y: CENTER + c.y * 2.5,
    }),
    [CENTER],
  );

  const orbitGesture = Gesture.Pan()
    .onUpdate((event) => {
      tiltY.value = interpolate(
        event.translationX,
        [-windowWidth, windowWidth],
        [-20, 20],
        Extrapolate.CLAMP,
      );
      tiltX.value = interpolate(
        event.translationY,
        [-windowWidth, windowWidth],
        [18, -18],
        Extrapolate.CLAMP,
      );
    })
    .onEnd(() => {
      if (reduceMotion) {
        tiltX.value = 0;
        tiltY.value = 0;
      } else {
        tiltX.value = withSpring(0, { damping: 15, stiffness: 110 });
        tiltY.value = withSpring(0, { damping: 15, stiffness: 110 });
      }
    })
    .minDistance(12);

  const zoomGesture = Gesture.Pinch()
    .onUpdate((event) => {
      graphScale.value = Math.max(
        baseGraphScale * 0.8,
        Math.min(savedGraphScale.value * event.scale, 1.08),
      );
    })
    .onEnd(() => {
      savedGraphScale.value = graphScale.value;
    });

  const graphGesture = Gesture.Simultaneous(orbitGesture, zoomGesture);

  const graphMotionStyle = useAnimatedStyle(() => ({
    transform: [
      { perspective: 900 },
      { rotateX: `${tiltX.value}deg` },
      { rotateY: `${tiltY.value}deg` },
      { scale: graphScale.value * (reduceMotion ? 1 : 1 + breath.value * 0.018) },
    ],
  }));

  const auraMotionStyle = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 0.16 : 0.12 + breath.value * 0.16,
    transform: [{ scale: reduceMotion ? 1 : 0.9 + breath.value * 0.16 }],
  }));

  const resetView = () => {
    savedGraphScale.value = baseGraphScale;
    if (reduceMotion) {
      graphScale.value = baseGraphScale;
      tiltX.value = 0;
      tiltY.value = 0;
    } else {
      graphScale.value = withSpring(baseGraphScale, {
        damping: 16,
        stiffness: 120,
      });
      tiltX.value = withSpring(0, { damping: 15, stiffness: 110 });
      tiltY.value = withSpring(0, { damping: 15, stiffness: 110 });
    }
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
          <View
            testID="knowledge-map"
            style={[
              styles.symbioteStage,
              { backgroundColor: colors.symbioteBackdrop },
            ]}
            accessibilityLabel={`Living ontology with ${visibleClusters.length} selectable knowledge clusters`}
          >
            <View style={styles.symbioteHud} pointerEvents="none">
              <View>
                <Text
                  style={[
                    styles.symbioteEyebrow,
                    { color: colors.symbioteMuted },
                  ]}
                >
                  LIVE ONTOLOGY
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
                  {reduceMotion ? "STABLE" : "EVOLVING"}
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
                    graphMotionStyle,
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

                  {SYMBIOTE_LOBES.map((lobe, index) => (
                    <View
                      key={`symbiote-lobe-${index}`}
                      pointerEvents="none"
                      style={[
                        styles.symbioteLobe,
                        {
                          width: lobe.width,
                          height: lobe.height,
                          left: CENTER + lobe.x,
                          top: CENTER + lobe.y,
                          borderRadius:
                            Math.min(lobe.width, lobe.height) * 0.46,
                          backgroundColor: colors.symbioteSurface,
                          borderColor: colors.symbioteSoft,
                          shadowColor: colors.symbioteHighlight,
                          transform: [{ rotate: lobe.rotate }],
                        },
                      ]}
                    >
                      <View
                        style={[
                          styles.symbioteLobeSpecular,
                          {
                            width: Math.max(18, lobe.width * 0.26),
                            height: Math.max(4, lobe.height * 0.055),
                            borderRadius: lobe.width,
                            backgroundColor: colors.symbioteHighlight,
                          },
                        ]}
                      />
                    </View>
                  ))}

                  {liveConnections.map((connection) => (
                    <SymbioteConnection
                      key={connection.id}
                      from={getPos(connection.from)}
                      to={getPos(connection.to)}
                      index={connection.index}
                      breath={breath}
                      reduceMotion={reduceMotion}
                    />
                  ))}

                  {visibleClusters.map((cluster, index) => (
                    <SymbioteNode
                      key={cluster.id}
                      cluster={cluster}
                      position={getPos(cluster)}
                      index={index}
                      isSelected={selectedCluster?.id === cluster.id}
                      breath={breath}
                      reduceMotion={reduceMotion}
                      onPress={() => {
                        if (Platform.OS !== "web") Haptics.selectionAsync();
                        openCluster(cluster.id);
                      }}
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
                    ? "Motion reduced · explore clusters"
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
                          {source.excerpt}
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
        {!selectedCluster && (
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

  const openEditor = (task: Task) => {
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
          ]}
          testID={`kanban-card-${task.id}`}
        >
          <TouchableOpacity
            onPress={() => openEditor(task)}
            accessibilityRole="button"
            accessibilityLabel={`Edit task ${task.title}`}
            accessibilityHint="Long press and drag to move this card. Arrow buttons provide the same controls."
            style={styles.kanbanCardMain}
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
                      style={[
                        styles.columnAddButton,
                        { borderColor: colors.border },
                      ]}
                      onPress={() => {
                        setAddingStageId(stage.id);
                        setNewTaskTitle("");
                        setBoardError("");
                      }}
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
        animationType="fade"
        onRequestClose={closeEditor}
      >
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior="padding"
        >
          <View
            style={[
              styles.cardEditor,
              { backgroundColor: colors.background, borderColor: colors.border },
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
                        if (editorTaskId) {
                          deleteTask(activeProject.id, editorTaskId);
                          closeEditor();
                        }
                      }}
                      style={[
                        styles.destructiveButton,
                        { backgroundColor: colors.destructive },
                      ]}
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
          </View>
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

  const feedItems = useMemo(() => {
    if (!activeProject) return [];

    const conversations = state.conversations
      .filter((conversation) => conversation.projectId === activeProject.id)
      .map((conversation) => {
        const latestMessage =
          conversation.messages[conversation.messages.length - 1];
        return {
          id: `conversation-${conversation.id}`,
          type: "conversation" as const,
          icon: "message-square" as const,
          label: "Conversation",
          title: conversation.title,
          detail: latestMessage?.content || "A new conversation is ready.",
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
        detail: cluster.summary,
        timestamp: cluster.lastUpdatedAt,
        conversationId: undefined,
      }));

    return [...conversations, ...tasks, ...clusters]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 12);
  }, [activeProject, state.conversations, state.clusters]);

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
  const activeProject =
    state.projects.find((p) => p.id === state.activeProjectId) ||
    state.projects[0];

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
          activeIndex !== 2 &&
          activeIndex !== 3 &&
          Math.abs(gestureState.dx) > 18 &&
          Math.abs(gestureState.dx) > Math.abs(gestureState.dy) * 1.5,
        onPanResponderRelease: (_, gestureState) => {
          if (gestureState.dx < -70 && activeIndex < 3) {
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
        <View accessibilityRole="tablist" style={styles.navTabs}>
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
                style={[styles.navTab, isFocused && styles.navTabFocused]}
                hitSlop={10}
                testID={`workspace-tab-${title.toLowerCase().replace("-", "")}`}
                accessibilityRole="tab"
                accessibilityLabel={`Open ${title} workspace`}
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
            style={styles.navProject}
            activeOpacity={0.7}
            onPress={() => router.push("/projects")}
            testID="open-projects"
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
          <FeedWorkspace
            activeProject={activeProject}
            onOpenConversation={handleOpenConversation}
          />
        </View>
        <View
          testID="workspace-brain"
          style={[
            styles.workspacePage,
            activeIndex !== 2 && styles.workspacePageHidden,
          ]}
        >
          <KnowledgeWorkspace
            isActive={activeIndex === 2}
            onOpenConversation={handleOpenConversation}
          />
        </View>
        <View
          testID="workspace-todo"
          style={[
            styles.workspacePage,
            activeIndex !== 3 && styles.workspacePageHidden,
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
    flexShrink: 0,
  },
  navTab: {
    paddingVertical: 12,
    position: "relative",
    borderRadius: 6,
  },
  navTabFocused: {
    backgroundColor: "rgba(128, 128, 128, 0.2)",
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
  feedHeader: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    marginBottom: 24,
  },
  feedEyebrow: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    letterSpacing: 0.5,
    textTransform: "uppercase",
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
    textTransform: "uppercase",
    letterSpacing: 0.6,
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
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1.4,
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
    fontSize: 9,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
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
  symbioteLobe: {
    position: "absolute",
    borderWidth: 1,
    shadowOpacity: 0.24,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
    overflow: "hidden",
  },
  symbioteLobeSpecular: {
    position: "absolute",
    top: "13%",
    left: "17%",
    opacity: 0.38,
    transform: [{ rotate: "-18deg" }],
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
    textTransform: "uppercase",
    letterSpacing: 0.5,
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

const WORKSPACE_TABS = ["Chat", "Feed", "Brain", "To-Do"] as const;

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
