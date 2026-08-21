import React, { useMemo, useState, useCallback, useRef, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  Platform,
  Share,
  Alert,
} from "react-native";
import { useRouter } from "expo-router";
import * as Linking from "expo-linking";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import {
  getCommunityBriefing,
  getGetCommunityBriefingQueryKey,
  GetCommunityBriefingOrder,
  CommunityThread,
  PersonalAgendaItem,
  useListVenomApps,
  getListVenomAppsQueryKey,
  dismissVenomAppImprovementSuggestion,
} from "@workspace/api-client-react";
import { useCommunityVoting } from "./useCommunityVoting";

function formatRelativeTime(dateString: string) {
  const date = new Date(dateString);
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  
  if (diffInSeconds < 60) return "Just now";
  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) return `${diffInMinutes}m ago`;
  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) return `${diffInHours}h ago`;
  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays < 7) return `${diffInDays}d ago`;
  return date.toLocaleDateString();
}

interface CommunityBriefingProps {
  isActive?: boolean;
}

export function CommunityBriefing({ isActive = true }: CommunityBriefingProps) {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [order, setOrder] = useState<GetCommunityBriefingOrder>("top");

  // Determine timezone
  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const {
    data,
    isLoading,
    isError,
    refetch,
    isRefetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: [...getGetCommunityBriefingQueryKey({ timezone, order }), "infinite"],
    queryFn: ({ pageParam }) =>
      getCommunityBriefing({ timezone, order, cursor: pageParam as string | undefined, limit: 20 }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    enabled: isActive,
  });

  const { toggleVote, isPending } = useCommunityVoting();

  // Review-first improvement suggestions for spawned apps surface on the
  // feed as well as the app record. Dismissal is inline; nothing runs
  // without the user starting an iteration themselves.
  const appsQuery = useListVenomApps({
    query: {
      enabled: isActive,
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

  const handleShare = async (threadId: string, authorName: string) => {
    try {
      const url = process.env.EXPO_PUBLIC_DOMAIN 
        ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/community/${threadId}`
        : Linking.createURL(`/community/${threadId}`);
      
      await Share.share({
        message: Platform.OS === "web" ? url : `Read ${authorName}'s thread on Venom: ${url}`,
        url: Platform.OS === "ios" ? url : undefined,
      });
    } catch (e: any) {
      if (Platform.OS === 'web') {
        window.alert(`Could not share: ${e.message}`);
      } else {
        Alert.alert("Share Failed", e.message);
      }
    }
  };

  const pages = data?.pages ?? [];
  const firstPage = pages[0];
  const agenda = firstPage?.agenda ?? [];
  const calendarStatus = firstPage?.calendarStatus ?? "unavailable";
  const viewerProfile = firstPage?.viewerProfile ?? null;

  const handleActionRequiringProfile = useCallback(
    (action: () => void) => {
      if (!firstPage) return; // wait until data loads
      if (!viewerProfile) {
        if (Platform.OS !== 'web') {
          Alert.alert(
            "Profile Required",
            "You need to set up a quick community profile before interacting.",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Set Up Profile", onPress: () => router.push("/community/profile" as any) }
            ]
          );
        } else {
          router.push("/community/profile" as any);
        }
      } else {
        action();
      }
    },
    [firstPage, viewerProfile, router]
  );

  const threads = useMemo(() => {
    return pages.flatMap((page) => page.community);
  }, [pages]);

  const renderAgendaItem = ({ item }: { item: PersonalAgendaItem }) => {
    return (
      <View style={[styles.agendaCard, { backgroundColor: colors.symbiotePanel, borderColor: colors.border }]}>
        <View style={styles.agendaHeader}>
          <Text style={[styles.agendaPrivacy, { color: colors.symbioteMuted }]}>
            Personal Agenda
          </Text>
          <Feather name={item.source === "calendar" ? "calendar" : "check-square"} size={12} color={colors.symbioteMuted} />
        </View>
        <Text style={[styles.agendaTitle, { color: colors.symbioteHighlight }]}>{item.title}</Text>
        {item.detail ? (
          <Text style={[styles.agendaDetail, { color: colors.symbioteMuted }]} numberOfLines={2}>
            {item.detail}
          </Text>
        ) : null}
      </View>
    );
  };

  const renderThread = ({ item }: { item: CommunityThread }) => {
    return (
      <View style={[styles.threadCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.threadHeader}>
          <View style={styles.threadAuthorRow}>
            <View style={[styles.avatar, { backgroundColor: colors.secondary }]}>
              <Text style={[styles.avatarText, { color: colors.foreground }]}>
                {item.author.displayName.charAt(0).toUpperCase()}
              </Text>
            </View>
            <View>
              <Text style={[styles.authorName, { color: colors.foreground }]}>{item.author.displayName}</Text>
              <Text style={[styles.timeText, { color: colors.mutedForeground }]}>
                {formatRelativeTime(item.createdAt)}
              </Text>
            </View>
          </View>
          <TouchableOpacity 
            onPress={() => handleShare(item.id, item.author.displayName)} 
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={`Share thread by ${item.author.displayName}`}
          >
            <Feather name="share" size={16} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>

        <TouchableOpacity 
          activeOpacity={0.7} 
          onPress={() => router.push(`/community/${item.id}` as any)}
          accessibilityRole="link"
          accessibilityLabel={`Open thread: ${item.body.substring(0, 50)}...`}
        >
          <Text style={[styles.threadBody, { color: colors.foreground }]} numberOfLines={4}>
            {item.body}
          </Text>
          
          {item.summary && (
            <View style={[styles.summaryBox, { backgroundColor: colors.secondary }]}>
              <View style={styles.summaryHeader}>
                <Feather name="cpu" size={12} color={colors.primary} />
                <Text style={[styles.summaryLabel, { color: colors.primary }]}>{item.summary.label}</Text>
              </View>
              <Text style={[styles.summaryText, { color: colors.secondaryForeground }]} numberOfLines={2}>
                {item.summary.text}
              </Text>
            </View>
          )}
        </TouchableOpacity>

        <View style={styles.threadFooter}>
          <View style={styles.footerActions}>
            <TouchableOpacity
              style={[
                styles.actionButton,
                item.viewerHasUpvoted && { backgroundColor: colors.primary },
                isPending(item.id) && { opacity: 0.5 }
              ]}
              onPress={() => handleActionRequiringProfile(() => toggleVote(item.id, item.viewerHasUpvoted))}
              disabled={isPending(item.id)}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel={item.viewerHasUpvoted ? "Remove upvote" : "Upvote thread"}
              accessibilityState={{ checked: item.viewerHasUpvoted, disabled: isPending(item.id) }}
            >
              <Feather
                name="arrow-up"
                size={14}
                color={item.viewerHasUpvoted ? colors.primaryForeground : colors.mutedForeground}
              />
              <Text
                style={[
                  styles.actionText,
                  { color: item.viewerHasUpvoted ? colors.primaryForeground : colors.mutedForeground },
                ]}
              >
                {item.score}
              </Text>
            </TouchableOpacity>
            
            <TouchableOpacity 
              style={styles.actionButton}
              onPress={() => router.push(`/community/${item.id}` as any)}
              accessibilityRole="link"
              accessibilityLabel={`View ${item.replyCount} replies`}
            >
              <Feather name="message-circle" size={14} color={colors.mutedForeground} />
              <Text style={[styles.actionText, { color: colors.mutedForeground }]}>{item.replyCount}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  };

  const renderHeader = () => {
    return (
      <View style={styles.headerContainer}>
        <View style={[styles.briefingHeader, { paddingTop: Math.max(insets.top, 24) }]}>
          <View>
            <Text style={[styles.eyebrow, { color: colors.mutedForeground }]}>Good Morning</Text>
            <Text style={[styles.title, { color: colors.foreground }]}>Community Briefing</Text>
          </View>
        </View>

        {calendarStatus === "unavailable" && (
          <View style={[styles.alertBox, { backgroundColor: colors.destructive, opacity: 0.1 }]} />
        )}
        {calendarStatus === "unavailable" && (
          <View style={styles.alertContent}>
            <Feather name="alert-circle" size={14} color={colors.destructive} />
            <Text style={[styles.alertText, { color: colors.destructive }]}>
              Calendar sync is currently unavailable.
            </Text>
          </View>
        )}

        {improvementSuggestions.slice(0, 3).map((app) => (
          <TouchableOpacity
            key={`improve-${app.id}`}
            accessibilityRole="button"
            accessibilityLabel={`New data for ${app.name} since its last version. Open the portfolio to review an iteration.`}
            onPress={() => router.push("/apps" as never)}
            style={[
              styles.suggestionCard,
              { backgroundColor: colors.foreground },
            ]}
            testID={`feed-suggestion-${app.id}`}
          >
            <View style={styles.suggestionTop}>
              <Feather name="zap" size={13} color={colors.background} />
              <Text
                style={[styles.suggestionLabel, { color: colors.background }]}
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
                style={styles.suggestionDismiss}
              >
                {dismissingSuggestionId === app.id ? (
                  <ActivityIndicator size="small" color={colors.background} />
                ) : (
                  <Feather name="x" size={14} color={colors.background} />
                )}
              </TouchableOpacity>
            </View>
            <Text
              style={[styles.suggestionName, { color: colors.background }]}
              numberOfLines={1}
            >
              {app.name}
            </Text>
            <Text
              style={[styles.suggestionSummary, { color: colors.background }]}
              numberOfLines={2}
            >
              {app.improvementSignal?.summary}
            </Text>
            <Text
              style={[styles.suggestionReview, { color: colors.background }]}
            >
              Review first — nothing runs without your approval.
            </Text>
          </TouchableOpacity>
        ))}

        {agenda.length > 0 && (
          <View style={styles.agendaSection}>
            <FlatList
              horizontal
              data={agenda}
              renderItem={renderAgendaItem}
              keyExtractor={(item) => item.id}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.agendaList}
              snapToInterval={280 + 12}
              decelerationRate="fast"
            />
          </View>
        )}

        <View style={styles.feedTabs}>
          <TouchableOpacity
            style={[styles.feedTab, order === "top" && { borderBottomColor: colors.primary }]}
            onPress={() => setOrder("top")}
            accessibilityRole="button"
            accessibilityState={{ selected: order === "top" }}
          >
            <Text style={[styles.feedTabText, { color: order === "top" ? colors.foreground : colors.mutedForeground }]}>
              Top Discussions
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.feedTab, order === "new" && { borderBottomColor: colors.primary }]}
            onPress={() => setOrder("new")}
            accessibilityRole="button"
            accessibilityState={{ selected: order === "new" }}
          >
            <Text style={[styles.feedTabText, { color: order === "new" ? colors.foreground : colors.mutedForeground }]}>
              Latest
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  const renderEmpty = () => {
    if (isLoading) {
      return (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      );
    }
    if (isError) {
      return (
        <View style={styles.center}>
          <Feather name="alert-triangle" size={24} color={colors.mutedForeground} style={{ marginBottom: 12 }} />
          <Text style={{ color: colors.mutedForeground }}>Could not load briefing</Text>
          <TouchableOpacity style={[styles.retryBtn, { borderColor: colors.border }]} onPress={() => refetch()}>
            <Text style={{ color: colors.foreground }}>Retry</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <View style={styles.center}>
        <Feather name="wind" size={24} color={colors.mutedForeground} style={{ marginBottom: 12 }} />
        <Text style={{ color: colors.mutedForeground }}>No threads found.</Text>
      </View>
    );
  };

  return (
    <View
      testID="community-briefing"
      style={[styles.container, { backgroundColor: colors.background }]}
    >
      <FlatList
        data={threads}
        renderItem={renderThread}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={renderHeader}
        ListEmptyComponent={renderEmpty}
        contentContainerStyle={[styles.listContent, { paddingBottom: Math.max(insets.bottom, 100) }]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching && !isFetchingNextPage}
            onRefresh={refetch}
            tintColor={colors.primary}
          />
        }
        onEndReached={() => {
          if (hasNextPage && !isFetchingNextPage) {
            fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.5}
        ListFooterComponent={
          isFetchingNextPage ? (
            <ActivityIndicator style={{ marginVertical: 24 }} color={colors.primary} />
          ) : null
        }
      />
      <View style={[styles.fabContainer, { bottom: Math.max(insets.bottom + 16, 24) }]}>
        <TouchableOpacity
          style={[styles.fab, { backgroundColor: colors.primary }]}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Create a new thread"
          onPress={() => {
            handleActionRequiringProfile(() => {
              router.push("/community/new" as any);
            });
          }}
        >
          <Feather name="edit-2" size={20} color={colors.primaryForeground} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  listContent: { paddingBottom: 100 },
  suggestionCard: {
    marginHorizontal: 20,
    marginBottom: 16,
    borderRadius: 14,
    padding: 16,
  },
  suggestionTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 8,
  },
  suggestionLabel: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  suggestionDismiss: {
    marginLeft: "auto",
    padding: 2,
  },
  suggestionName: {
    fontSize: 15,
    fontWeight: "700",
    marginBottom: 4,
  },
  suggestionSummary: {
    fontSize: 12.5,
    lineHeight: 18,
    opacity: 0.75,
    marginBottom: 6,
  },
  suggestionReview: {
    fontSize: 10.5,
    opacity: 0.55,
  },
  headerContainer: { paddingBottom: 16 },
  briefingHeader: {
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  eyebrow: { fontSize: 13, fontFamily: "Inter_500Medium", marginBottom: 4 },
  title: { fontSize: 28, fontFamily: "Inter_700Bold", letterSpacing: -0.5 },
  agendaSection: { marginBottom: 24 },
  agendaList: { paddingHorizontal: 16, gap: 12 },
  agendaCard: {
    width: 280,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
  },
  agendaHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  agendaPrivacy: { fontSize: 11, fontFamily: "Inter_600SemiBold", textTransform: "uppercase", letterSpacing: 0.5 },
  agendaTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold", marginBottom: 4 },
  agendaDetail: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 18 },
  feedTabs: {
    flexDirection: "row",
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: "transparent",
  },
  feedTab: {
    paddingVertical: 12,
    marginRight: 24,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  feedTabText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  threadCard: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
  },
  threadHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  threadAuthorRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  avatar: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  authorName: { fontSize: 15, fontFamily: "Inter_600SemiBold", marginBottom: 2 },
  timeText: { fontSize: 12, fontFamily: "Inter_400Regular" },
  threadBody: { fontSize: 15, fontFamily: "Inter_400Regular", lineHeight: 22, marginBottom: 16 },
  summaryBox: { borderRadius: 12, padding: 12, marginBottom: 16 },
  summaryHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 },
  summaryLabel: { fontSize: 11, fontFamily: "Inter_600SemiBold", textTransform: "uppercase", letterSpacing: 0.5 },
  summaryText: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 18 },
  threadFooter: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  footerActions: { flexDirection: "row", gap: 8 },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: "transparent",
  },
  actionText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  center: { padding: 40, alignItems: "center", justifyContent: "center" },
  retryBtn: { borderWidth: 1, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 },
  fabContainer: {
    position: "absolute",
    right: 24,
  },
  fab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 4,
  },
  alertBox: { position: "absolute", top: 16, left: 16, right: 16, bottom: 0, borderRadius: 12 },
  alertContent: { paddingHorizontal: 32, paddingBottom: 16, flexDirection: "row", alignItems: "center", gap: 8 },
  alertText: { fontSize: 13, fontFamily: "Inter_500Medium" },
});
