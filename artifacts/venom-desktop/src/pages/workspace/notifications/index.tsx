import React, { useMemo } from "react";
import { Link } from "wouter";
import { useAuth } from "@clerk/react";
import {
  getGetCommunityNotificationUnreadCountQueryKey,
  getListCommunityNotificationsQueryKey,
  getListVenomSourceSyncAlertsQueryKey,
  listCommunityNotifications,
  useGetCommunityNotificationUnreadCount,
  useListVenomSourceSyncAlerts,
  useMarkAllCommunityNotificationsRead,
  useMarkAllVenomSourceSyncAlertsRead,
  useMarkCommunityNotificationRead,
  type CommunityNotification,
  type CommunityNotificationPage,
  type VenomSourceSyncAlert,
  type VenomSourceSyncAlertList,
} from "@workspace/api-client-react";
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  AlertCircle,
  AlertTriangle,
  Bell,
  Check,
  Clock,
  GitBranch,
  Globe,
  Inbox,
  RefreshCw,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const PAGE_LIMIT = 30;

function notificationListQueryKey(userId: string | null | undefined) {
  return [
    ...getListCommunityNotificationsQueryKey({ limit: PAGE_LIMIT }),
    "account",
    userId ?? "signed-out",
    "infinite",
  ] as const;
}

function notificationCountQueryKey(userId: string | null | undefined) {
  return [
    ...getGetCommunityNotificationUnreadCountQueryKey(),
    "account",
    userId ?? "signed-out",
  ] as const;
}

function sourceSyncAlertsQueryKey(userId: string | null | undefined) {
  return [
    ...getListVenomSourceSyncAlertsQueryKey(),
    "account",
    userId ?? "signed-out",
  ] as const;
}

// Kept word-for-word identical with the mobile app so the nudge reads the
// same wherever it catches the user.
const GITHUB_ALERT_ACTION =
  "Venom's GitHub connection can't update this source. Reconnect GitHub or ask the workspace owner to restore access.";
const WEBSITE_ALERT_ACTION =
  "Venom can't reach this site on its schedule. Check that the address still works, or pause the schedule in Settings.";

function sourceSyncAlertHeadline(alert: VenomSourceSyncAlert) {
  return `Scheduled updates for ${alert.sourceName} keep failing`;
}

function SourceSyncAlertCard({ alert }: { alert: VenomSourceSyncAlert }) {
  const isUnread = alert.readAt == null;
  const action =
    alert.provider === "github" ? GITHUB_ALERT_ACTION : WEBSITE_ALERT_ACTION;
  const ProviderIcon = alert.provider === "github" ? GitBranch : Globe;
  const attempts = `${alert.consecutiveFailures} failed attempts`;
  const lastTried = formatDistanceToNow(new Date(alert.lastFailedAt), {
    addSuffix: true,
  });

  return (
    <article
      className={cn(
        "border-b border-border/60 p-4 last:border-b-0 md:p-6",
        isUnread ? "bg-muted/20" : "bg-background",
      )}
      aria-label={`${isUnread ? "Unread alert. " : ""}${sourceSyncAlertHeadline(alert)}. ${action}`}
      data-testid={`alert-source-sync-${alert.id}`}
    >
      <div className="flex gap-4">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center border border-border/60 rounded-full bg-muted"
          aria-hidden="true"
        >
          <AlertTriangle className="h-5 w-5 text-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          {isUnread && (
            <span className="mb-1 block text-xs font-semibold text-foreground">
              Unread
            </span>
          )}
          <p
            className={cn(
              "text-sm leading-relaxed",
              isUnread ? "font-semibold text-foreground" : "text-muted-foreground",
            )}
          >
            {sourceSyncAlertHeadline(alert)}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{action}</p>
          <p className="mt-3 border border-dashed border-border/60 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
            {alert.lastError}
          </p>
          <span className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <ProviderIcon className="h-3 w-3" aria-hidden="true" />
            {attempts}
            <span aria-hidden="true">·</span>
            last tried {lastTried}
          </span>
        </div>
      </div>
    </article>
  );
}

function NotificationRow({
  notification,
  mutationPending,
  onMarkRead,
}: {
  notification: CommunityNotification;
  mutationPending: boolean;
  onMarkRead: (notification: CommunityNotification) => void;
}) {
  const isRead = notification.readAt != null;
  const actorName = notification.actor.displayName || "Someone";
  const message = !notification.available
    ? `${actorName} replied, but that reply is no longer available.`
    : notification.parentReplyId
      ? `${actorName} replied to your reply.`
      : `${actorName} replied to your thread.`;
  const accessibleLabel = `${isRead ? "" : "Unread notification. "}${message} ${formatDistanceToNow(new Date(notification.createdAt), { addSuffix: true })}.`;

  const content = (
    <div className="flex gap-4">
      <div className="pt-1" aria-hidden="true">
        {notification.actor.avatarUrl ? (
          <img
            src={notification.actor.avatarUrl}
            alt=""
            className="h-10 w-10 border border-border/60 rounded-full object-cover"
          />
        ) : (
          <span className="flex h-10 w-10 items-center justify-center border border-border/60 rounded-full bg-muted">
            <User className="h-5 w-5 text-muted-foreground" />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div>
            {!isRead && (
              <span className="mb-1 block text-xs font-semibold text-foreground">
                Unread
              </span>
            )}
            <p
              className={cn(
                "text-sm leading-relaxed",
                isRead
                  ? "text-muted-foreground"
                  : "font-semibold text-foreground",
              )}
            >
              {message}
            </p>
            <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" aria-hidden="true" />
              {formatDistanceToNow(new Date(notification.createdAt), {
                addSuffix: true,
              })}
            </span>
          </div>
        </div>
        {!notification.available && (
          <p className="mt-3 flex items-center gap-2 border border-dashed border-border/60 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            The related reply cannot be opened.
          </p>
        )}
      </div>
    </div>
  );

  const classes = cn(
    "block w-full border-b border-border/60 p-4 text-left outline-none transition-colors md:p-6",
    !isRead ? "bg-muted/20" : "bg-background",
    notification.available &&
      "cursor-pointer hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground",
  );

  if (notification.available) {
    return (
      <Link
        href={`/workspace/feed/thread/${notification.threadId}?replyId=${encodeURIComponent(notification.replyId)}#reply-${encodeURIComponent(notification.replyId)}`}
        onClick={() => {
          if (!isRead) onMarkRead(notification);
        }}
        className={classes}
        aria-label={accessibleLabel}
        data-testid={`link-notification-${notification.id}`}
      >
        {content}
      </Link>
    );
  }

  if (!isRead) {
    return (
      <button
        type="button"
        className={cn(
          classes,
          "cursor-pointer hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground",
        )}
        onClick={() => onMarkRead(notification)}
        disabled={mutationPending}
        aria-label={`${accessibleLabel} Mark as read.`}
        aria-busy={mutationPending}
        data-testid={`button-unavailable-notification-${notification.id}`}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      className={classes}
      aria-label={accessibleLabel}
      data-testid={`unavailable-notification-${notification.id}`}
    >
      {content}
    </div>
  );
}

export default function NotificationsPage() {
  const { userId } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
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
  });

  const { data: unreadData } = useGetCommunityNotificationUnreadCount({
    query: {
      queryKey: countQueryKey,
      refetchInterval: 30000,
    },
  });

  const alertsQueryKey = sourceSyncAlertsQueryKey(userId);
  const { data: alertData } = useListVenomSourceSyncAlerts({
    query: {
      queryKey: alertsQueryKey,
      refetchInterval: 30000,
    },
  });

  const notifications = useMemo(
    () => data?.pages.flatMap((page) => page.items) ?? [],
    [data?.pages],
  );
  const unreadCount = unreadData?.count ?? 0;
  const alerts = alertData?.alerts ?? [];
  const unreadAlertCount = alerts.filter(
    (alert) => alert.readAt == null,
  ).length;

  const markReadMutation = useMarkCommunityNotificationRead({
    mutation: {
      onMutate: async ({ notificationId }) => {
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
        toast({
          title: "Could not update notification",
          description: "Please try again.",
          variant: "destructive",
        });
      },
      onSettled: () => {
        void queryClient.invalidateQueries({ queryKey: listQueryKey });
        void queryClient.invalidateQueries({ queryKey: countQueryKey });
      },
    },
  });

  const markAllMutation = useMarkAllCommunityNotificationsRead({
    mutation: {
      onMutate: async () => {
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
        toast({
          title: "Could not mark all notifications read",
          description: "Please try again.",
          variant: "destructive",
        });
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
        toast({
          title: "Could not mark all notifications read",
          description: "Please try again.",
          variant: "destructive",
        });
      },
      onSettled: () => {
        void queryClient.invalidateQueries({ queryKey: alertsQueryKey });
        void queryClient.invalidateQueries({ queryKey: countQueryKey });
      },
    },
  });

  const markEverythingRead = () => {
    markAllMutation.mutate();
    if (unreadAlertCount > 0) alertsMarkAllMutation.mutate();
  };
  const markAllPending =
    markAllMutation.isPending || alertsMarkAllMutation.isPending;

  const refresh = () => {
    void Promise.all([
      refetch(),
      queryClient.invalidateQueries({ queryKey: countQueryKey }),
      queryClient.invalidateQueries({ queryKey: alertsQueryKey }),
    ]);
  };
  const retryLoadingMore = () => {
    void refetch();
  };

  return (
    <main className="h-full flex-1 overflow-y-auto bg-background p-4 md:p-8">
      <div className="mx-auto flex min-h-full max-w-4xl flex-col pb-24">
        <header className="sticky top-0 z-20 mb-8 flex flex-col justify-between gap-4 border-b border-border/60 bg-background/95 pb-6 pt-4 backdrop-blur-md md:flex-row md:items-end">
          <div>
            <h1 className="flex items-center gap-3 text-3xl font-bold tracking-tight text-foreground md:text-4xl">
              <Bell className="h-8 w-8" aria-hidden="true" />
              Notifications
            </h1>
            <p
              className="mt-2 text-sm text-muted-foreground"
              aria-live="polite"
            >
              {unreadCount === 0
                ? "No unread notifications"
                : `${unreadCount} unread ${unreadCount === 1 ? "notification" : "notifications"}`}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={refresh}
              disabled={isRefetching}
              aria-busy={isRefetching}
              aria-label="Refresh notifications"
              className="min-h-10 rounded-md"
            >
              <RefreshCw
                className={cn("mr-2 h-4 w-4", isRefetching && "animate-spin")}
                aria-hidden="true"
              />
              Refresh
            </Button>
            {unreadCount > 0 && (
              <Button
                size="sm"
                onClick={markEverythingRead}
                disabled={markAllPending}
                aria-busy={markAllPending}
                className="min-h-10 rounded-md"
                data-testid="button-mark-all-read"
              >
                <Check className="mr-2 h-4 w-4" aria-hidden="true" />
                Mark all read
              </Button>
            )}
          </div>
        </header>

        {alerts.length > 0 && (
          <section
            className="mb-6 overflow-hidden rounded-2xl border border-border/60 surface shadow-soft"
            aria-label="Source update alerts"
            data-testid="section-source-sync-alerts"
          >
            <div className="border-b border-border/60 bg-muted/30 px-4 py-3 md:px-6">
              <h2 className="text-sm font-semibold text-foreground">
                Source updates need attention
              </h2>
            </div>
            {alerts.map((alert) => (
              <SourceSyncAlertCard key={alert.id} alert={alert} />
            ))}
          </section>
        )}

        <section
          className="flex-1 overflow-hidden rounded-2xl border border-border/60 surface shadow-soft"
          aria-label="Community notifications"
        >
          {isLoading ? (
            <div
              className="space-y-4 p-4 md:p-6"
              aria-label="Loading notifications"
            >
              <Skeleton className="h-20 w-full rounded-md" />
              <Skeleton className="h-20 w-full rounded-md" />
              <Skeleton className="h-20 w-full rounded-md" />
            </div>
          ) : isError ? (
            <div className="p-12 text-center" role="alert">
              <AlertCircle className="mx-auto mb-3 h-8 w-8 text-destructive" />
              <p className="mb-4 text-sm font-semibold text-destructive">
                Notifications could not be loaded.
              </p>
              <Button variant="outline" onClick={() => void refetch()}>
                Retry
              </Button>
            </div>
          ) : notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-6 py-24 text-center">
              <Inbox className="mb-4 h-12 w-12 text-muted-foreground" />
              {alerts.length === 0 && (
                <h2 className="mb-2 text-xl font-semibold text-foreground">
                  All caught up
                </h2>
              )}
              <p className="max-w-md text-sm text-muted-foreground">
                Replies to your community threads and replies will appear here.
              </p>
            </div>
          ) : (
            <>
              {notifications.map((notification) => (
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                  mutationPending={markReadMutation.isPending}
                  onMarkRead={(item) =>
                    markReadMutation.mutate({ notificationId: item.id })
                  }
                />
              ))}
              <div className="p-6 text-center">
                {isFetchNextPageError ? (
                  <Button
                    variant="outline"
                    onClick={retryLoadingMore}
                  >
                    Retry loading more
                  </Button>
                ) : hasNextPage ? (
                  <Button
                    variant="outline"
                    onClick={() => void fetchNextPage()}
                    disabled={isFetchingNextPage}
                    aria-busy={isFetchingNextPage}
                    className="w-full max-w-sm"
                    data-testid="button-load-more-notifications"
                  >
                    {isFetchingNextPage
                      ? "Loading more…"
                      : "Load more notifications"}
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    You’re up to date.
                  </p>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}