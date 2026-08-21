import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  useGetCommunityBriefing,
  useGetCommunityFeed,
  getGetCommunityBriefingQueryKey,
  getGetCommunityFeedQueryKey,
  useListVenomBuildRuns,
  getListVenomBuildRunsQueryKey,
  useListVenomApps,
  getListVenomAppsQueryKey,
  useDismissVenomAppImprovementSuggestion,
  type VenomApp,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ThreadCard } from "@/components/community/ThreadCard";
import { AgendaSection } from "@/components/community/AgendaSection";
import { CreateThreadDialog } from "@/components/community/CreateThreadDialog";
import { ProfileDialog } from "@/components/community/ProfileDialog";
import { Activity, LayoutList, AlertCircle, PackageSearch, Sparkles, X, Loader2 } from "lucide-react";
import { Link } from "wouter";
import { asList } from "@/lib/as-list";
import { knowledgeDisplayText } from "@/lib/messageCitations";

function FeedSegment({
  cursor,
  order,
  isFirst,
  onNextCursor,
  onLoadedFirst,
}: {
  cursor?: string;
  order: "new" | "top";
  isFirst: boolean;
  onNextCursor: (c: string | null) => void;
  onLoadedFirst?: (agenda: any[], calStatus: any, profile: any) => void;
}) {
  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const briefingQuery = useGetCommunityBriefing(
    { timezone, order, cursor },
    {
      query: {
        queryKey: getGetCommunityBriefingQueryKey({ timezone, order, cursor }),
        enabled: isFirst,
        staleTime: 1000 * 30,
      },
    }
  );

  const feedQuery = useGetCommunityFeed(
    { order, cursor },
    {
      query: {
        queryKey: getGetCommunityFeedQueryKey({ order, cursor }),
        enabled: !isFirst,
        staleTime: 1000 * 30,
      },
    }
  );

  const query = isFirst ? briefingQuery : feedQuery;

  useEffect(() => {
    if (query.data) {
      onNextCursor(query.data.nextCursor);
      if (isFirst && onLoadedFirst) {
        const b = query.data as any;
        // Normalized at the boundary: everything downstream is typed as a
        // list, but this payload is whatever the request actually returned.
        onLoadedFirst(asList(b.agenda), b.calendarStatus, b.viewerProfile);
      }
    }
  }, [query.data, onNextCursor, isFirst, onLoadedFirst]);

  if (query.isLoading) {
    return (
      <div className="space-y-4 mb-4">
        <Skeleton className="h-32 w-full rounded-md" />
        <Skeleton className="h-32 w-full rounded-md" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="text-destructive text-sm font-medium p-5 border border-destructive/60 rounded-xl mb-4 flex flex-col items-center text-center bg-destructive/10 shadow-soft">
        <AlertCircle className="w-8 h-8 mb-3" />
        <p className="mb-4">Failed to load signals from the network.</p>
        <Button variant="outline" className="rounded-md border-destructive/60 text-destructive hover:bg-destructive hover:text-destructive-foreground" onClick={() => query.refetch()}>
          Retry connection
        </Button>
      </div>
    );
  }

  if (!query.data) return null;

  // A failed request still resolves here with an error body that carries
  // neither key, so this has to survive the field being absent.
  const threads = asList<any>(
    isFirst ? (query.data as any).community : (query.data as any).items,
  );

  if (threads.length === 0 && isFirst) {
    return (
      <div className="text-center py-20 border border-dashed border-border/60 rounded-2xl bg-background/30">
        <LayoutList className="w-8 h-8 mx-auto text-muted-foreground mb-4 opacity-50" />
        <p className="text-xs text-muted-foreground">
          No threads found. Be the first to broadcast.
        </p>
      </div>
    );
  }

  return (
    <>
      {threads.map((t: any) => (
        <ThreadCard key={t.id} thread={t} />
      ))}
    </>
  );
}

export default function FeedPage() {
  const [order, setOrder] = useState<"new" | "top">("new");
  const [extraCursors, setExtraCursors] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const { data: buildRuns } = useListVenomBuildRuns(
    {},
    {
      query: {
        queryKey: getListVenomBuildRunsQueryKey({}),
        refetchInterval: 5000,
      },
    },
  );
  const visibleBuildRuns = Array.isArray(buildRuns)
    ? buildRuns.slice(0, 5)
    : [];
  const { data: appsData } = useListVenomApps();
  const improvementSuggestions = asList<VenomApp>(appsData).filter(
    (app) => app?.improvementSignal,
  );
  const queryClient = useQueryClient();
  const dismissSuggestion = useDismissVenomAppImprovementSuggestion();
  const [dismissingAppId, setDismissingAppId] = useState<string | null>(null);
  const handleDismissSuggestion = async (appId: string) => {
    setDismissingAppId(appId);
    try {
      await dismissSuggestion.mutateAsync({ appId });
      await queryClient.invalidateQueries({
        queryKey: getListVenomAppsQueryKey(),
      });
    } catch {
      // Keep the card visible so the user can retry from here or the record.
    } finally {
      setDismissingAppId(null);
    }
  };

  // Agenda/Profile state hoisted from the first segment
  const [agendaData, setAgendaData] = useState<{
    agenda: any[];
    calendarStatus: any;
    viewerProfile: any;
  } | null>(null);

  // Reset cursors on order change
  useEffect(() => {
    setExtraCursors([]);
    setNextCursor(null);
  }, [order]);

  const handleLoadMore = () => {
    if (nextCursor && !extraCursors.includes(nextCursor)) {
      setExtraCursors((prev) => [...prev, nextCursor]);
      setNextCursor(null); // will be updated by the new segment when it loads
    }
  };

  const handleFirstLoaded = useCallback((agenda: any[], calendarStatus: any, viewerProfile: any) => {
    const next = { agenda, calendarStatus, viewerProfile };
    setAgendaData((current) =>
      current && JSON.stringify(current) === JSON.stringify(next)
        ? current
        : next,
    );
  }, []);

  return (
    <div className="flex-1 overflow-y-auto bg-background p-4 md:p-8 relative scroll-smooth h-full">
      <div className="max-w-6xl mx-auto pb-24 h-full flex flex-col">
        <header className="mb-10 flex flex-col md:flex-row md:items-end justify-between border-b border-border/60 pb-6 gap-6 sticky top-0 bg-background/95 backdrop-blur-md z-20 pt-4">
          <div>
            <h1 className="text-3xl md:text-4xl font-semibold tracking-tight flex items-center gap-3">
              <Activity className="w-8 h-8 text-foreground" />
              Community briefing
            </h1>
            <p className="text-sm font-medium text-muted-foreground mt-2">
              Global signals & personal agenda
            </p>
          </div>
          <div className="flex items-center gap-4">
            {agendaData?.viewerProfile === null && (
              <span className="text-xs font-medium text-muted-foreground hidden md:inline">
                Profile missing
              </span>
            )}
            <ProfileDialog />
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
          {/* Left Column: Agenda (Sticky on desktop) */}
          <div className="lg:col-span-4 lg:sticky lg:top-[8rem]">
            {improvementSuggestions.length ? (
              <section
                aria-labelledby="improvement-suggestions-title"
                className="mb-6 surface border border-border/60 rounded-xl p-5 shadow-soft"
              >
                <div className="mb-1 flex items-center gap-2">
                  <Sparkles
                    className="h-4 w-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <h2
                    id="improvement-suggestions-title"
                    className="text-sm font-semibold"
                  >
                    Improvement suggestions
                  </h2>
                </div>
                <p className="mb-4 text-[11px] text-muted-foreground">
                  New data since each app's last version. Review first —
                  nothing runs on its own.
                </p>
                <div className="space-y-2">
                  {improvementSuggestions.slice(0, 4).map((app) => (
                    <Link key={app.id} href={`/workspace/apps/${app.id}`}>
                      <div
                        className="relative rounded-md border border-border/60 px-3 py-2 pr-9 transition-colors hover:bg-foreground/5"
                        data-testid={`card-suggestion-${app.id}`}
                      >
                        <p className="truncate text-sm font-semibold">
                          {app.name}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                          {/* Server-built from knowledge deltas; resolve any
                              inline [source:...] marker that slips through so
                              a feed entry never shows the raw machine tag. */}
                          {knowledgeDisplayText(
                            app.improvementSignal?.summary ?? "",
                          )}
                        </p>
                        <button
                          type="button"
                          aria-label={`Dismiss suggestion for ${app.name}`}
                          data-testid={`button-feed-dismiss-${app.id}`}
                          disabled={dismissingAppId === app.id}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void handleDismissSuggestion(app.id);
                          }}
                          className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:opacity-50"
                        >
                          {dismissingAppId === app.id ? (
                            <Loader2
                              className="h-3.5 w-3.5 animate-spin"
                              aria-hidden="true"
                            />
                          ) : (
                            <X className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                        </button>
                      </div>
                    </Link>
                  ))}
                </div>
              </section>
            ) : null}
            {visibleBuildRuns.length ? (
              <section
                aria-labelledby="build-activity-title"
                className="mb-6 surface border border-border/60 rounded-xl p-5 shadow-soft"
              >
                <div className="mb-4 flex items-center gap-2">
                  <PackageSearch
                    className="h-4 w-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <h2
                    id="build-activity-title"
                    className="text-sm font-semibold"
                  >
                    Build activity
                  </h2>
                </div>
                <div className="space-y-2">
                  {visibleBuildRuns.map((buildRun) => (
                    <Link
                      key={buildRun.id}
                      href={`/workspace/builds/${buildRun.id}`}
                    >
                      <div className="rounded-md border border-border/60 px-3 py-2 transition-colors hover:bg-foreground/5">
                        <p className="truncate text-sm font-semibold">
                          {buildRun.targetName}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {buildRun.status.replace(/_/g, " ")}
                        </p>
                      </div>
                    </Link>
                  ))}
                </div>
              </section>
            ) : null}
            {agendaData ? (
              <AgendaSection
                agenda={agendaData.agenda}
                calendarStatus={agendaData.calendarStatus}
              />
            ) : (
              <div className="surface border border-border/60 rounded-xl shadow-soft p-5 space-y-4">
                <Skeleton className="h-6 w-32 rounded-md" />
                <Skeleton className="h-16 w-full rounded-md" />
                <Skeleton className="h-16 w-full rounded-md" />
              </div>
            )}
          </div>

          {/* Right Column: Feed */}
          <div className="lg:col-span-8 flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-6">
              <div className="flex bg-muted/30 p-1 border border-border/60 rounded-lg" role="tablist" aria-label="Sort order">
                <button
                  role="tab"
                  aria-selected={order === "new"}
                  aria-controls="feed-panel"
                  id="tab-new"
                  tabIndex={order === "new" ? 0 : -1}
                  className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${ order === "new" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground" }`}
                  onClick={() => setOrder("new")}
                >
                  New
                </button>
                <button
                  role="tab"
                  aria-selected={order === "top"}
                  aria-controls="feed-panel"
                  id="tab-top"
                  tabIndex={order === "top" ? 0 : -1}
                  className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${ order === "top" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground" }`}
                  onClick={() => setOrder("top")}
                >
                  Top
                </button>
              </div>
              <CreateThreadDialog />
            </div>

            <div id="feed-panel" role="tabpanel" aria-labelledby={`tab-${order}`} className="flex flex-col gap-4">
              <FeedSegment
                key={`${order}-first`}
                order={order}
                isFirst={true}
                onNextCursor={setNextCursor}
                onLoadedFirst={handleFirstLoaded}
              />

              {extraCursors.map((c) => (
                <FeedSegment
                  key={`${order}-${c}`}
                  cursor={c}
                  order={order}
                  isFirst={false}
                  onNextCursor={setNextCursor}
                />
              ))}

              {nextCursor && (
                <Button
                  variant="outline"
                  className="rounded-xl border-border/60 mt-4 font-medium py-6 border-dashed transition-colors hover:border-border shadow-sm"
                  onClick={handleLoadMore}
                >
                  Load more signals
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
