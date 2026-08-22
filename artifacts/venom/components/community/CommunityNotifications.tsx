import React, { useCallback, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useAuth } from "@clerk/expo";
import {
  listCommunityNotifications,
  getListCommunityNotificationsQueryKey,
  getListVenomSourceSyncAlertsQueryKey,
  useListVenomSourceSyncAlerts,
  useMarkAllVenomSourceSyncAlertsRead,
  useMarkCommunityNotificationRead,
  useMarkAllCommunityNotificationsRead,
  useGetCommunityNotificationUnreadCount,
  getGetCommunityNotificationUnreadCountQueryKey,
  type CommunityNotification,
  type CommunityNotificationPage,
  type VenomSourceSyncAlertList,
} from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { NotificationHeader } from "./NotificationHeader";

const PAGE_LIMIT = 30;

function notificationListQueryKey(userId: string | null | undefined) {
  return [
    ...getListCommunityNotificationsQueryKey({ limit: PAGE_LIMIT }),
    "account",
    userId ?? "ui-test",
    "infinite",
  ] as const;
}

function notificationCountQueryKey(userId: string | null | undefined) {
  return [
    ...getGetCommunityNotificationUnreadCountQueryKey(),
    "account",
    userId ?? "ui-test",
  ] as const;
}

function sourceSyncAlertsQueryKey(userId: string | null | undefined) {
  return [
    ...getListVenomSourceSyncAlertsQueryKey(),
    "account",
    userId ?? "ui-test",
  ] as const;
}

// Kept word-for-word identical with the desktop app so the nudge reads the
// same wherever it catches the user.
const GITHUB_ALERT_ACTION =
  "Venom's GitHub connection can't update this source. Reconnect GitHub or ask the workspace owner to restore access.";
const WEBSITE_ALERT_ACTION =
  "Venom can't reach this site on its schedule. Check that the address still works, or pause the schedule in Settings.";

function formatRelativeTime(dateString: string) {
  const date = new Date(dateString);
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diffInSeconds < 60) return "Just now";
  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) return `${diffInMinutes}m`;
  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) return `${diffInHours}h`;
  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays < 7) return `${diffInDays}d`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function CommunityNotifications({ isActive }: { isActive: boolean }) {
  const colors = useColors();
  const router = useRouter();
  const { userId } = useAuth();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState("");
  const listQueryKey = notificationListQueryKey(userId);
  const countQueryKey = notificationCountQueryKey(userId);

  const {
    data,
    isLoading,
    isError,
    isRefetching,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useInfiniteQuery({
    queryKey: listQueryKey,
    queryFn: ({ pageParam, signal }) =>
      listCommunityNotifications(
        {
          limit: PAGE_LIMIT,
          cursor: pageParam as string | undefined,
        },
        { signal },
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    enabled: isActive,
  });

  const { data: unreadData } = useGetCommunityNotificationUnreadCount({
    query: {
      enabled: isActive,
      refetchInterval: isActive ? 15000 : false,
      queryKey: countQueryKey,
    },
  });

  const alertsQueryKey = sourceSyncAlertsQueryKey(userId);
  const { data: alertData } = useListVenomSourceSyncAlerts({
    query: {
      enabled: isActive,
      refetchInterval: isActive ? 30000 : false,
      queryKey: alertsQueryKey,
    },
  });
  const alerts = alertData?.alerts ?? [];
  const hasUnreadAlerts = alerts.some((alert) => alert.readAt == null);

  const markReadMutation = useMarkCommunityNotificationRead({
    mutation: {
      onMutate: async ({ notificationId }) => {
        setActionError("");
        await Promise.all([
          queryClient.cancelQueries({ queryKey: listQueryKey }),
          queryClient.cancelQueries({ queryKey: countQueryKey }),
        ]);
        const previousList =
          queryClient.getQueryData<InfiniteData<CommunityNotificationPage>>(
            listQueryKey,
          );
        const previousCount = queryClient.getQueryData<{ count: number }>(
          countQueryKey,
        );
        const wasUnread = previousList?.pages.some((page) =>
          page.items.some(
            (item) => item.id === notificationId && item.readAt == null,
          ),
        );
        const readAt = new Date().toISOString();
        queryClient.setQueryData<InfiniteData<CommunityNotificationPage>>(
          listQueryKey,
          (current) =>
            current
              ? {
                  ...current,
                  pages: current.pages.map((page) => ({
                    ...page,
                    items: page.items.map((item) =>
                      item.id === notificationId
                        ? { ...item, readAt }
                        : item,
                    ),
                  })),
                }
              : current,
        );
        if (wasUnread && previousCount && previousCount.count > 0) {
          queryClient.setQueryData(countQueryKey, {
            count: previousCount.count - 1,
          });
        }
        return { previousList, previousCount };
      },
      onError: (_error, _variables, context) => {
        if (context?.previousList) {
          queryClient.setQueryData(listQueryKey, context.previousList);
        }
        if (context?.previousCount) {
          queryClient.setQueryData(countQueryKey, context.previousCount);
        }
        setActionError("Could not mark that notification read. Try again.");
      },
      onSettled: () => {
        void queryClient.invalidateQueries({ queryKey: listQueryKey });
        void queryClient.invalidateQueries({ queryKey: countQueryKey });
      },
    },
  });

  const markAllReadMutation = useMarkAllCommunityNotificationsRead({
    mutation: {
      onMutate: async () => {
        setActionError("");
        await Promise.all([
          queryClient.cancelQueries({ queryKey: listQueryKey }),
          queryClient.cancelQueries({ queryKey: countQueryKey }),
        ]);
        const previousList =
          queryClient.getQueryData<InfiniteData<CommunityNotificationPage>>(
            listQueryKey,
          );
        const previousCount = queryClient.getQueryData<{ count: number }>(
          countQueryKey,
        );
        const readAt = new Date().toISOString();
        queryClient.setQueryData<InfiniteData<CommunityNotificationPage>>(
          listQueryKey,
          (current) =>
            current
              ? {
                  ...current,
                  pages: current.pages.map((page) => ({
                    ...page,
                    items: page.items.map((item) => ({
                      ...item,
                      readAt: item.readAt ?? readAt,
                    })),
                  })),
                }
              : current,
        );
        queryClient.setQueryData(countQueryKey, { count: 0 });
        return { previousList, previousCount };
      },
      onError: (_error, _variables, context) => {
        if (context?.previousList) {
          queryClient.setQueryData(listQueryKey, context.previousList);
        }
        if (context?.previousCount) {
          queryClient.setQueryData(countQueryKey, context.previousCount);
        }
        setActionError("Could not mark all notifications read. Try again.");
      },
      onSettled: () => {
        void queryClient.invalidateQueries({ queryKey: listQueryKey });
        void queryClient.invalidateQueries({ queryKey: countQueryKey });
      },
    },
  });

  const alertsMarkAllMutation = useMarkAllVenomSourceSyncAlertsRead({
    mutation: {
      onMutate: async () => {
        setActionError("");
        await queryClient.cancelQueries({ queryKey: alertsQueryKey });
        const previousAlerts =
          queryClient.getQueryData<VenomSourceSyncAlertList>(alertsQueryKey);
        const readAt = new Date().toISOString();
        queryClient.setQueryData<VenomSourceSyncAlertList>(
          alertsQueryKey,
          (current) =>
            current
              ? {
                  alerts: current.alerts.map((alert) => ({
                    ...alert,
                    readAt: alert.readAt ?? readAt,
                  })),
                }
              : current,
        );
        return { previousAlerts };
      },
      onError: (_error, _variables, context) => {
        if (context?.previousAlerts) {
          queryClient.setQueryData(alertsQueryKey, context.previousAlerts);
        }
        setActionError("Could not mark all notifications read. Try again.");
      },
      onSettled: () => {
        void queryClient.invalidateQueries({ queryKey: alertsQueryKey });
        void queryClient.invalidateQueries({ queryKey: countQueryKey });
      },
    },
  });

  const notifications = useMemo(
    () => data?.pages.flatMap((page) => page.items) ?? [],
    [data?.pages],
  );

  const handleAlertPress = useCallback(() => {
    if (hasUnreadAlerts) {
      alertsMarkAllMutation.mutate();
    }
    // Source cards (and their schedules) live in Settings.
    router.push("/settings");
  }, [hasUnreadAlerts, alertsMarkAllMutation, router]);

  const handleNotificationPress = useCallback(
    (notification: CommunityNotification) => {
      if (!notification.readAt) {
        markReadMutation.mutate({ notificationId: notification.id });
      }
      if (notification.available) {
        router.push({
          pathname: "/community/[threadId]" as never,
          params: {
            threadId: notification.threadId,
            replyId: notification.replyId,
          },
        });
      }
    },
    [markReadMutation, router],
  );

  const renderItem = useCallback(
    ({ item }: { item: CommunityNotification }) => {
      const isUnread = !item.readAt;
      const actorName = item.actor.displayName;
      const isReplyToReply = !!item.parentReplyId;
      const contentText = !item.available
        ? `${actorName} replied, but that reply is no longer available.`
        : isReplyToReply
          ? `${actorName} replied to your reply.`
          : `${actorName} replied to your thread.`;

      return (
        <TouchableOpacity
          style={[
            styles.notificationItem,
            {
              backgroundColor: isUnread
                ? colors.symbiotePanel
                : colors.background,
              borderBottomColor: colors.border,
            },
          ]}
          onPress={() => handleNotificationPress(item)}
          disabled={!item.available && !isUnread}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`${isUnread ? "Unread notification. " : ""}${contentText} ${formatRelativeTime(item.createdAt)}.`}
          accessibilityHint={
            item.available
              ? "Opens the reply in its community thread and marks this notification read"
              : isUnread
                ? "Marks this unavailable notification read"
                : "This reply is no longer available"
          }
          accessibilityState={{
            busy:
              markReadMutation.isPending &&
              markReadMutation.variables?.notificationId === item.id,
            disabled: !item.available && !isUnread,
          }}
          testID={`notification-${item.id}`}
        >
          <View style={styles.notificationContent}>
            <View style={styles.iconContainer}>
              <Feather
                name="message-circle"
                size={17}
                color={
                  isUnread ? colors.foreground : colors.mutedForeground
                }
              />
            </View>
            <View style={styles.textContainer}>
              {isUnread && (
                <Text
                  style={[styles.unreadLabel, { color: colors.foreground }]}
                >
                  Unread
                </Text>
              )}
              <Text
                style={[
                  styles.notificationText,
                  {
                    color: isUnread
                      ? colors.foreground
                      : colors.mutedForeground,
                  },
                  isUnread && styles.notificationTextUnread,
                ]}
              >
                {contentText}
              </Text>
              <Text
                style={[styles.timeText, { color: colors.mutedForeground }]}
              >
                {formatRelativeTime(item.createdAt)}
              </Text>
            </View>
          </View>
          {!item.available && (
            <View
              style={[
                styles.unavailableBadge,
                { backgroundColor: colors.secondary },
              ]}
            >
              <Text
                style={[
                  styles.unavailableText,
                  { color: colors.secondaryForeground },
                ]}
              >
                Unavailable
              </Text>
            </View>
          )}
        </TouchableOpacity>
      );
    },
    [colors, handleNotificationPress],
  );
  const retryLoadingMore = () => {
    void refetch();
  };

  if (!isActive) return null;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {isLoading ? (
        <View
          style={styles.centerContainer}
          accessibilityLabel="Loading notifications"
        >
          <ActivityIndicator size="large" color={colors.foreground} />
        </View>
      ) : isError ? (
        <View style={styles.centerContainer}>
          <Feather
            name="alert-triangle"
            size={32}
            color={colors.mutedForeground}
            style={styles.errorIcon}
          />
          <Text
            style={[styles.errorText, { color: colors.mutedForeground }]}
            accessibilityRole="alert"
          >
            Notifications could not be loaded.
          </Text>
          <TouchableOpacity
            style={[styles.retryButton, { borderColor: colors.border }]}
            onPress={() => void refetch()}
            accessibilityRole="button"
            accessibilityLabel="Retry loading notifications"
          >
            <Text style={[styles.retryText, { color: colors.foreground }]}>
              Retry
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={notifications}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          onEndReached={() => {
            if (hasNextPage && !isFetchingNextPage) {
              void fetchNextPage();
            }
          }}
          onEndReachedThreshold={0.35}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={() => void refetch()}
              tintColor={colors.foreground}
            />
          }
          ListHeaderComponent={
            <>
              <NotificationHeader
                unreadCount={unreadData?.count ?? 0}
                isPending={
                  markAllReadMutation.isPending ||
                  alertsMarkAllMutation.isPending
                }
                onMarkAllRead={() => {
                  markAllReadMutation.mutate();
                  if (hasUnreadAlerts) alertsMarkAllMutation.mutate();
                }}
              />
              {alerts.map((alert) => {
                const isUnread = alert.readAt == null;
                const action =
                  alert.provider === "github"
                    ? GITHUB_ALERT_ACTION
                    : WEBSITE_ALERT_ACTION;
                const headline = `Scheduled updates for ${alert.sourceName} keep failing`;
                return (
                  <TouchableOpacity
                    key={alert.id}
                    style={[
                      styles.alertCard,
                      {
                        borderColor: isUnread
                          ? colors.foreground
                          : colors.border,
                        backgroundColor: isUnread
                          ? colors.symbiotePanel
                          : colors.background,
                      },
                    ]}
                    onPress={handleAlertPress}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={`${isUnread ? "Unread alert. " : ""}${headline}. ${action}`}
                    accessibilityHint="Opens Settings, where connected sources are managed, and marks these alerts read"
                    testID={`alert-source-sync-${alert.id}`}
                  >
                    {isUnread && (
                      <Text
                        style={[
                          styles.unreadLabel,
                          { color: colors.foreground },
                        ]}
                      >
                        Unread
                      </Text>
                    )}
                    <View style={styles.alertTitleRow}>
                      <Feather
                        name="alert-triangle"
                        size={16}
                        color={colors.foreground}
                      />
                      <Text
                        style={[
                          styles.alertTitle,
                          { color: colors.foreground },
                        ]}
                      >
                        {headline}
                      </Text>
                    </View>
                    <Text
                      style={[
                        styles.alertAction,
                        { color: colors.mutedForeground },
                      ]}
                    >
                      {action}
                    </Text>
                    <Text
                      style={[
                        styles.alertError,
                        { color: colors.mutedForeground },
                      ]}
                      numberOfLines={2}
                    >
                      {alert.lastError}
                    </Text>
                    <Text
                      style={[
                        styles.alertMeta,
                        { color: colors.mutedForeground },
                      ]}
                    >
                      {alert.consecutiveFailures} failed attempts ·{" "}
                      {formatRelativeTime(alert.lastFailedAt)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
              {actionError ? (
                <View
                  style={[
                    styles.actionError,
                    { borderColor: colors.destructive },
                  ]}
                >
                  <Text
                    style={[
                      styles.actionErrorText,
                      { color: colors.destructive },
                    ]}
                    accessibilityRole="alert"
                  >
                    {actionError}
                  </Text>
                </View>
              ) : null}
            </>
          }
          ListFooterComponent={
            isFetchingNextPage ? (
              <ActivityIndicator
                style={styles.pageLoader}
                size="small"
                color={colors.foreground}
                accessibilityLabel="Loading more notifications"
              />
            ) : isFetchNextPageError ? (
              <TouchableOpacity
                style={styles.loadMoreRetry}
                onPress={retryLoadingMore}
                accessibilityRole="button"
                accessibilityLabel="Retry loading more notifications"
              >
                <Text style={[styles.retryText, { color: colors.foreground }]}>
                  Retry loading more
                </Text>
              </TouchableOpacity>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Feather
                name="inbox"
                size={48}
                color={colors.mutedForeground}
                style={styles.emptyIcon}
              />
              {alerts.length === 0 && (
                <Text style={[styles.emptyText, { color: colors.foreground }]}>
                  All caught up
                </Text>
              )}
              <Text
                style={[
                  styles.emptySubtext,
                  { color: colors.mutedForeground },
                ]}
              >
                Replies to your community threads and replies will appear here.
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centerContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  errorIcon: {
    marginBottom: 12,
  },
  errorText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    marginBottom: 20,
  },
  retryButton: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1,
  },
  retryText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  listContent: {
    flexGrow: 1,
    paddingBottom: 24,
  },
  notificationItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    borderBottomWidth: 1,
  },
  notificationContent: {
    flexDirection: "row",
    alignItems: "flex-start",
    flex: 1,
    gap: 12,
  },
  iconContainer: {
    width: 24,
    alignItems: "center",
    paddingTop: 2,
  },
  textContainer: {
    flex: 1,
    gap: 4,
  },
  unreadLabel: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    textTransform: "uppercase",
    letterSpacing: 1.1,
  },
  notificationText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
  },
  notificationTextUnread: {
    fontFamily: "Inter_600SemiBold",
  },
  timeText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
  unavailableBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    marginLeft: 12,
  },
  unavailableText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 40,
    marginTop: 60,
  },
  emptyIcon: {
    marginBottom: 20,
    opacity: 0.5,
  },
  emptyText: {
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 22,
  },
  actionError: {
    marginHorizontal: 16,
    marginBottom: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  alertCard: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 6,
  },
  alertTitleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  alertTitle: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    lineHeight: 20,
  },
  alertAction: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  alertError: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    lineHeight: 16,
  },
  alertMeta: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  actionErrorText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  pageLoader: {
    marginVertical: 20,
  },
  loadMoreRetry: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
});
