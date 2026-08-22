import { useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { useAuth } from "@clerk/expo";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { dismissVenomAppImprovementSuggestion, getListVenomAppsQueryKey, useListVenomApps } from "@workspace/api-client-react";
import { knowledgeDisplayText } from "@/context/knowledgeState";
import { messageCitationPlainText } from "@/context/messageCitations";
import { KanbanStage, type ProjectSource, Task, useVenom } from "@/context/VenomContext";
import { useColors } from "@/hooks/useColors";
import { styles } from "./styles";

export function FeedWorkspace({
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
