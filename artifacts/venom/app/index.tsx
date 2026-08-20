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
  runOnJS,
  withTiming,
  useReducedMotion,
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
import { extractVenomKnowledge } from "@workspace/api-client-react";

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
    if (!isActive || reduceMotion) {
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

    const tasks = activeProject.tasks.map((task: Task) => ({
      id: `task-${task.id}`,
      type: "task" as const,
      icon:
        task.status === "done" ? ("check" as const) : ("check-square" as const),
      label: task.status === "done" ? "Completed task" : "Project task",
      title: task.title,
      detail:
        task.status === "in_progress"
          ? "Currently in progress"
          : task.status === "done"
            ? "Marked complete"
            : "Waiting to start",
      timestamp: task.createdAt,
      conversationId: undefined,
    }));

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
  const activeProject =
    state.projects.find((p) => p.id === state.activeProjectId) ||
    state.projects[0];

  const handleTabPress = useCallback((index: number) => {
    setActiveIndex(index);
    if (Platform.OS !== "web") {
      Haptics.selectionAsync();
    }
  }, []);

  const workspaceSwipeResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gestureState) =>
          activeIndex !== 2 &&
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
        <View style={styles.navTabs}>
          {["Chat", "Feed", "Brain", "To-Do"].map((title, i) => {
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
          <TouchableOpacity
            onPress={() => router.push("/settings")}
            style={styles.navIconButton}
            testID="open-settings"
            hitSlop={8}
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
