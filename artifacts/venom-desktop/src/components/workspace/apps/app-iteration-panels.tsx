import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useUpdateVenomApp,
  useGetVenomAppIterationContext,
  useCreateVenomAppIteration,
  useDismissVenomAppImprovementSuggestion,
  getVenomAppTimeline,
  getGetVenomAppQueryKey,
  getListVenomAppsQueryKey,
  getGetVenomAppIterationContextQueryKey,
  getListVenomBuildRunsQueryKey,
  type VenomApp,
  type VenomAppTimelineEntry,
} from "@workspace/api-client-react";
import {
  BrainCircuit,
  FileArchive,
  Hexagon,
  Link2,
  Loader2,
  Radio,
  Rocket,
  RotateCcw,
  Sparkles,
  Unlink,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useVenomWorkspace } from "@/context/venom-workspace";
import { cn } from "@/lib/utils";

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

async function invalidateAppQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  appId: string,
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: getGetVenomAppQueryKey(appId) }),
    queryClient.invalidateQueries({ queryKey: getListVenomAppsQueryKey() }),
    queryClient.invalidateQueries({
      queryKey: getGetVenomAppIterationContextQueryKey(appId),
    }),
  ]);
}

/* ------------------------------------------------------------------ */
/* Improvement suggestion banner                                       */
/* ------------------------------------------------------------------ */

export function ImprovementSignalBanner({ app }: { app: VenomApp }) {
  const signal = app.improvementSignal;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const dismiss = useDismissVenomAppImprovementSuggestion();

  if (!signal) return null;

  const handleDismiss = async () => {
    try {
      await dismiss.mutateAsync({ appId: app.id });
      await invalidateAppQueries(queryClient, app.id);
    } catch (err: any) {
      toast({
        title: "Could not dismiss",
        description: err?.message || "Try again in a moment.",
        variant: "destructive",
      });
    }
  };

  return (
    <div
      role="status"
      className="relative overflow-hidden rounded-xl bg-foreground text-background p-5 shadow-lift mb-8 animate-in fade-in slide-in-from-top-2 duration-500"
      data-testid={`banner-improvement-${app.id}`}
    >
      <div className="absolute -right-16 -top-16 h-48 w-48 rounded-full bg-background/10 blur-2xl pointer-events-none animate-breathe" />
      <div className="relative flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex items-start gap-3 min-w-0">
          <Sparkles className="h-5 w-5 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-tight">
              New data since package v{signal.baselineIterationNumber} — consider
              an iteration
            </p>
            <p className="mt-1 text-xs text-background/70 leading-relaxed max-w-2xl">
              {signal.summary}
            </p>
            <p className="mt-2 text-[11px] text-background/50">
              Review first — nothing runs without your approval.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <ImproveAppDialog app={app}>
            <Button
              variant="outline"
              className="rounded-md border-background/30 bg-transparent text-background hover:bg-background hover:text-foreground font-medium shadow-none transition-transform hover:scale-[1.02] active:scale-[0.98]"
              data-testid={`button-review-iterate-${app.id}`}
            >
              <Rocket className="mr-2 h-4 w-4" />
              Review &amp; iterate
            </Button>
          </ImproveAppDialog>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Dismiss suggestion"
            onClick={handleDismiss}
            disabled={dismiss.isPending}
            className="rounded-md text-background/60 hover:text-background hover:bg-background/10"
            data-testid={`button-dismiss-suggestion-${app.id}`}
          >
            {dismiss.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <X className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Knowledge context (linked project) card                             */
/* ------------------------------------------------------------------ */

export function KnowledgeContextCard({ app }: { app: VenomApp }) {
  const { state } = useVenomWorkspace();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateApp = useUpdateVenomApp();
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);

  const projects = state.projects;
  const selectable = useMemo(
    () => projects.filter((project) => project.id !== app.linkedProjectId),
    [projects, app.linkedProjectId],
  );

  const saveLink = async (linkedProjectId: string | null) => {
    setPendingProjectId(linkedProjectId);
    try {
      await updateApp.mutateAsync({
        appId: app.id,
        data: { linkedProjectId },
      });
      await invalidateAppQueries(queryClient, app.id);
      toast({
        title: linkedProjectId ? "Project linked" : "Project unlinked",
        description: linkedProjectId
          ? "Venom now watches this project's knowledge for this app."
          : "This app no longer follows a project's knowledge.",
      });
    } catch (err: any) {
      toast({
        title: "Could not update the link",
        description: err?.message || "Try again in a moment.",
        variant: "destructive",
      });
    } finally {
      setPendingProjectId(null);
    }
  };

  return (
    <div
      className="border border-border/60 surface p-5 rounded-xl shadow-soft"
      data-testid={`card-knowledge-context-${app.id}`}
    >
      <h3 className="text-sm font-semibold tracking-tight mb-1 flex items-center gap-2">
        <BrainCircuit className="h-4 w-4" aria-hidden="true" />
        Knowledge context
      </h3>
      <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
        Link a project so its Brain knowledge and sources feed this app's next
        iterations.
      </p>

      {app.linkedProjectId ? (
        <div className="flex items-center justify-between gap-2 border border-border/60 rounded-lg px-3 py-2.5 bg-foreground/[0.02]">
          <div className="flex items-center gap-2 min-w-0">
            <Link2 className="h-3.5 w-3.5 shrink-0 text-foreground/60" aria-hidden="true" />
            <span
              className="text-sm font-medium truncate"
              data-testid={`text-linked-project-${app.id}`}
            >
              {app.linkedProjectName ?? app.linkedProjectId}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => saveLink(null)}
            disabled={updateApp.isPending}
            aria-label="Unlink project"
            className="h-7 rounded-md text-xs text-muted-foreground hover:text-destructive"
            data-testid={`button-unlink-project-${app.id}`}
          >
            {updateApp.isPending && pendingProjectId === null ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Unlink className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      ) : null}

      {projects.length === 0 && !app.linkedProjectId ? (
        <p className="text-xs text-muted-foreground border border-dashed border-border/60 rounded-lg p-3">
          No projects in this workspace yet. Create one from the sidebar to
          connect knowledge.
        </p>
      ) : selectable.length > 0 ? (
        <div className={cn(app.linkedProjectId && "mt-3")}>
          <Select
            value=""
            onValueChange={(value) => saveLink(value)}
            disabled={updateApp.isPending}
          >
            <SelectTrigger
              className="rounded-md border-border/60 text-sm font-medium"
              aria-label={
                app.linkedProjectId ? "Change linked project" : "Link a project"
              }
              data-testid="select-linked-project"
            >
              <SelectValue
                placeholder={
                  app.linkedProjectId ? "Change project…" : "Link a project…"
                }
              />
            </SelectTrigger>
            <SelectContent className="rounded-md border-border/60">
              {selectable.map((project) => (
                <SelectItem
                  key={project.id}
                  value={project.id}
                  data-testid={`option-project-${project.id}`}
                >
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Improve-this-app dialog                                             */
/* ------------------------------------------------------------------ */

export function ImproveAppDialog({
  app,
  children,
}: {
  app: VenomApp;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [constraints, setConstraints] = useState("");
  const [baselineChoice, setBaselineChoice] = useState<"latest" | "live">(
    "latest",
  );
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createIteration = useCreateVenomAppIteration();

  const { data: context, isLoading: contextLoading } =
    useGetVenomAppIterationContext(app.id, {
      query: {
        enabled: open,
        queryKey: getGetVenomAppIterationContextQueryKey(app.id),
      },
    });

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setIdempotencyKey(newIdempotencyKey());
      setBaselineChoice("latest");
    }
  };

  // What the app is actually serving may differ from the newest approved
  // package (published earlier, or restored by a rollback). When the live
  // version is a valid alternative baseline, the owner chooses consciously.
  const live = context?.live ?? null;
  const divergence = context?.divergence ?? null;
  const liveBaselineOffered = Boolean(
    live?.baselineSelectable &&
      (divergence === "live_behind" || divergence === "live_ahead"),
  );
  const usingLiveBaseline = liveBaselineOffered && baselineChoice === "live";
  const effectiveChanges = usingLiveBaseline
    ? (live?.changes ?? null)
    : (context?.changes ?? null);
  const effectiveSinceNumber = usingLiveBaseline
    ? live?.iterationNumber
    : context?.baseline?.iterationNumber;

  const canSubmit =
    !!context?.canIterate &&
    instruction.trim().length > 0 &&
    !createIteration.isPending;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    try {
      const run = await createIteration.mutateAsync({
        appId: app.id,
        data: {
          instruction: instruction.trim(),
          ...(constraints.trim() ? { constraints: constraints.trim() } : {}),
          ...(usingLiveBaseline && live?.iterationId
            ? { baselineIterationId: live.iterationId }
            : {}),
          idempotencyKey,
        },
      });
      await Promise.all([
        invalidateAppQueries(queryClient, app.id),
        queryClient.invalidateQueries({
          queryKey: getListVenomBuildRunsQueryKey({ appId: app.id }),
        }),
      ]);
      toast({
        title: "Iteration started",
        description:
          "The next package version is being drafted. You review and approve before anything ships.",
      });
      setOpen(false);
      setInstruction("");
      setConstraints("");
      setLocation(`/workspace/builds/${run.id}`);
    } catch (err: any) {
      toast({
        title: "Could not start the iteration",
        description: err?.message || "Try again in a moment.",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="rounded-2xl border-border/60 surface sm:max-w-[560px] shadow-lift p-0 overflow-hidden">
        <div className="p-6">
          <DialogHeader>
            <DialogTitle className="text-xl font-semibold tracking-tight flex items-center gap-2">
              <Sparkles className="h-5 w-5" aria-hidden="true" />
              Improve {app.name}
            </DialogTitle>
            <DialogDescription className="text-sm mt-1">
              Starts the next reviewed package version from the current
              baseline. Nothing deploys without your approval.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-5 space-y-4">
            {contextLoading || !context ? (
              <div className="space-y-3">
                <Skeleton className="h-16 rounded-lg bg-muted/20" />
                <Skeleton className="h-12 rounded-lg bg-muted/20" />
              </div>
            ) : (
              <>
                {/* Baseline */}
                {context.baseline ? (
                  <div
                    className={cn(
                      "border rounded-lg p-3.5",
                      context.baseline.resolvable
                        ? "border-border/60 bg-foreground/[0.02]"
                        : "border-destructive/40 bg-destructive/5",
                    )}
                    data-testid="panel-iteration-baseline"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="grid h-9 w-9 shrink-0 place-items-center bg-foreground text-background font-semibold text-sm rounded-md">
                          v{context.baseline.iterationNumber}
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs text-muted-foreground">
                            Baseline package
                          </p>
                          <p className="text-sm font-medium truncate">
                            {context.baseline.packageTitle}
                          </p>
                        </div>
                      </div>
                      {context.latestSourceVersion ? (
                        <span className="text-[11px] text-muted-foreground shrink-0">
                          source v{context.latestSourceVersion.versionNumber}
                        </span>
                      ) : null}
                    </div>
                    {!context.baseline.resolvable && (
                      <p
                        className="mt-2.5 text-xs text-destructive font-medium"
                        role="alert"
                      >
                        The pinned baseline package can no longer be resolved.
                        Iterations are blocked so Venom never silently starts
                        from scratch.
                      </p>
                    )}
                  </div>
                ) : (
                  <div
                    className="border border-dashed border-border/60 rounded-lg p-3.5 text-xs text-muted-foreground"
                    data-testid="panel-iteration-no-baseline"
                  >
                    This app has no approved package yet. Run a build and
                    approve its package first — iterations always continue from
                    a known baseline.
                  </div>
                )}

                {/* Live-release divergence */}
                {live && divergence && divergence !== "in_sync" ? (
                  <div
                    className="border border-foreground/25 bg-foreground/[0.03] rounded-lg p-3.5"
                    role="status"
                    data-testid="panel-live-divergence"
                  >
                    <p className="text-xs font-semibold flex items-center gap-1.5">
                      <Radio className="h-3.5 w-3.5" aria-hidden="true" />
                      {divergence === "live_unversioned"
                        ? "Live release predates package tracking"
                        : `Approved v${context.baseline?.iterationNumber ?? "?"}, but v${live.iterationNumber ?? "?"} is live`}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                      {divergence === "live_unversioned"
                        ? "What's serving right now isn't tied to any approved package, so it can't be offered as a baseline. Iterations start from the newest approved package."
                        : divergence === "live_ahead"
                          ? "The live release maps to a newer package than the newest approved one on record."
                          : live.restoredByRollback
                            ? "A rollback reset this app to the older version — users are seeing it now."
                            : "The newest approved package was never published, so users are still on the older version."}
                    </p>
                    {liveBaselineOffered ? (
                      <fieldset className="mt-3 space-y-1.5">
                        <legend className="sr-only">
                          Baseline for this iteration
                        </legend>
                        <label className="flex items-start gap-2 text-xs cursor-pointer">
                          <input
                            type="radio"
                            name={`baseline-choice-${app.id}`}
                            checked={baselineChoice === "latest"}
                            onChange={() => setBaselineChoice("latest")}
                            className="mt-0.5 accent-foreground"
                            data-testid="radio-baseline-latest"
                          />
                          <span>
                            <span className="font-medium">
                              Newest approved — v
                              {context.baseline?.iterationNumber}
                            </span>{" "}
                            <span className="text-muted-foreground">
                              includes work that never went live
                            </span>
                          </span>
                        </label>
                        <label className="flex items-start gap-2 text-xs cursor-pointer">
                          <input
                            type="radio"
                            name={`baseline-choice-${app.id}`}
                            checked={baselineChoice === "live"}
                            onChange={() => setBaselineChoice("live")}
                            className="mt-0.5 accent-foreground"
                            data-testid="radio-baseline-live"
                          />
                          <span>
                            <span className="font-medium">
                              Live now — v{live.iterationNumber}
                            </span>{" "}
                            <span className="text-muted-foreground">
                              what users are seeing
                              {live.restoredByRollback
                                ? " (restored by rollback)"
                                : ""}
                            </span>
                          </span>
                        </label>
                      </fieldset>
                    ) : divergence !== "live_unversioned" ? (
                      <p className="mt-1.5 text-[11px] text-muted-foreground">
                        The live package can no longer be resolved as a
                        baseline, so this iteration continues from the newest
                        approved package.
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {/* What's new */}
                {effectiveChanges ? (
                  <div
                    className="border border-border/60 rounded-lg p-3.5"
                    data-testid="panel-iteration-changes"
                  >
                    <p className="text-xs font-semibold mb-1 flex items-center gap-1.5">
                      <BrainCircuit className="h-3.5 w-3.5" aria-hidden="true" />
                      What's new since v{effectiveSinceNumber ?? "?"}
                    </p>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {effectiveChanges.summary}
                    </p>
                  </div>
                ) : context.linkedProject ? null : (
                  <p className="text-[11px] text-muted-foreground">
                    No linked project — this iteration is driven only by your
                    request. Link a project to feed Brain knowledge into future
                    iterations.
                  </p>
                )}

                {/* Suggested SOPs */}
                {context.suggestedSops.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-muted-foreground font-medium">
                      Applies SOPs:
                    </span>
                    {context.suggestedSops.map((sop) => (
                      <span
                        key={sop.revisionId}
                        className="text-[11px] font-medium border border-border/60 rounded-full px-2 py-0.5"
                      >
                        {sop.title} · rev {sop.revisionNumber}
                      </span>
                    ))}
                  </div>
                )}

                <div>
                  <label
                    htmlFor={`iteration-instruction-${app.id}`}
                    className="text-xs font-semibold block mb-1.5"
                  >
                    What should improve?
                  </label>
                  <Textarea
                    id={`iteration-instruction-${app.id}`}
                    value={instruction}
                    onChange={(event) => setInstruction(event.target.value)}
                    maxLength={4000}
                    rows={4}
                    placeholder="e.g. Surface the newest findings on the landing page and tighten the signup flow."
                    className="rounded-md border-border/60 text-sm resize-none"
                    disabled={!context.canIterate}
                    data-testid="input-iteration-instruction"
                  />
                </div>

                <div>
                  <label
                    htmlFor={`iteration-constraints-${app.id}`}
                    className="text-xs font-semibold block mb-1.5 text-muted-foreground"
                  >
                    Constraints <span className="font-normal">(optional)</span>
                  </label>
                  <Textarea
                    id={`iteration-constraints-${app.id}`}
                    value={constraints}
                    onChange={(event) => setConstraints(event.target.value)}
                    maxLength={4000}
                    rows={2}
                    placeholder="Anything that must not change."
                    className="rounded-md border-border/60 text-sm resize-none"
                    disabled={!context.canIterate}
                    data-testid="input-iteration-constraints"
                  />
                </div>
              </>
            )}
          </div>

          <div className="mt-6 flex items-center justify-end gap-3">
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              className="rounded-md font-medium border-border/60"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="rounded-md font-medium shadow-soft bg-foreground text-background hover:bg-foreground/90 transition-transform hover:scale-[1.02] active:scale-[0.98]"
              data-testid={`button-start-iteration-${app.id}`}
            >
              {createIteration.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Rocket className="mr-2 h-4 w-4" />
              )}
              Start iteration
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Evolution timeline                                                  */
/* ------------------------------------------------------------------ */

function timelineIcon(kind: VenomAppTimelineEntry["kind"]) {
  switch (kind) {
    case "source_import":
      return FileArchive;
    case "package_iteration":
      return Hexagon;
    case "release_rolled_back":
      return RotateCcw;
    default:
      return Rocket;
  }
}

export function EvolutionTimeline({
  appId,
  timeline,
  timelineTotal,
  timelineTruncated,
}: {
  appId: string;
  timeline: VenomAppTimelineEntry[];
  timelineTotal?: number;
  timelineTruncated?: boolean;
}) {
  const [olderEntries, setOlderEntries] = useState<VenomAppTimelineEntry[]>(
    [],
  );
  // undefined = paging not started yet; null = server confirmed the end.
  const [nextCursor, setNextCursor] = useState<string | null | undefined>(
    undefined,
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // The embedded tail entry the older-page chain is anchored to. When a live
  // detail refresh shifts the capped embedded slice (a new entry displaces
  // the former tail), the cached older pages no longer continue from what is
  // on screen — the displaced entry would be in neither list. Reset paging so
  // the next load starts from the refreshed tail and recovers it.
  const [anchorTailId, setAnchorTailId] = useState<string | null>(null);

  const embeddedTailId =
    timeline.length > 0 ? timeline[timeline.length - 1].id : null;
  useEffect(() => {
    if (anchorTailId === null || embeddedTailId === anchorTailId) return;
    setOlderEntries([]);
    setNextCursor(undefined);
    setLoadError(false);
    setAnchorTailId(null);
  }, [anchorTailId, embeddedTailId]);

  const entries = useMemo(() => {
    const seen = new Set<string>();
    return [...timeline, ...olderEntries].filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
  }, [timeline, olderEntries]);

  const hasMore = Boolean(timelineTruncated) && nextCursor !== null;

  const loadOlderEntries = async () => {
    setLoadingMore(true);
    setLoadError(false);
    try {
      // Continue the server's keyset paging from the last entry on screen,
      // one page per click, so every entry stays reachable no matter how
      // long the history grows — no client-side cap.
      const last = entries[entries.length - 1];
      const cursor =
        nextCursor ?? (last ? `${last.occurredAt}~${last.id}` : undefined);
      const page = await getVenomAppTimeline(
        appId,
        cursor ? { limit: 200, cursor } : { limit: 200 },
      );
      setOlderEntries((current) => [...current, ...page.entries]);
      setNextCursor(page.nextCursor);
      setAnchorTailId((current) => current ?? embeddedTailId);
    } catch {
      setLoadError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  if (timeline.length === 0) {
    return (
      <div className="border border-dashed border-border/60 bg-foreground/[0.01] p-8 text-center text-sm text-muted-foreground rounded-xl">
        No history yet. Imports, package iterations, and releases will appear
        here as the app evolves.
      </div>
    );
  }

  return (
    <ol
      className="relative space-y-0"
      aria-label="App evolution timeline"
      data-testid={`timeline-app-${appId}`}
    >
      {entries.map((entry, index) => {
        const Icon = timelineIcon(entry.kind);
        const isLast = index === entries.length - 1;
        return (
          <li
            key={entry.id}
            className="relative flex gap-4 group"
            data-testid={`timeline-entry-${entry.id}`}
          >
            {/* Rail */}
            <div className="flex flex-col items-center">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border/60 bg-background text-foreground transition-colors group-hover:bg-foreground group-hover:text-background">
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              </div>
              {!isLast && (
                <div className="w-px flex-1 bg-border/60 my-1" aria-hidden="true" />
              )}
            </div>

            <div className={cn("min-w-0 flex-1", !isLast && "pb-5")}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium tracking-tight">
                  {entry.title}
                </span>
                <span className="text-[10px] font-medium uppercase tracking-wide border border-border/60 rounded-full px-1.5 py-0.5 text-muted-foreground">
                  {entry.status}
                </span>
              </div>
              {entry.detail && (
                <p className="mt-1 text-xs text-muted-foreground leading-relaxed line-clamp-3">
                  {entry.detail}
                </p>
              )}
              <p className="mt-1 text-[11px] text-muted-foreground/70">
                {entry.actor} ·{" "}
                <time dateTime={entry.occurredAt}>
                  {new Date(entry.occurredAt).toLocaleString()}
                </time>
              </p>
            </div>
          </li>
        );
      })}
      {hasMore ? (
        <li className="relative flex justify-center pt-2 list-none">
          <Button
            variant="outline"
            size="sm"
            className="rounded-md text-xs"
            onClick={() => void loadOlderEntries()}
            disabled={loadingMore}
            data-testid={`button-timeline-load-more-${appId}`}
          >
            {loadingMore ? (
              <>
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                Loading older entries…
              </>
            ) : loadError ? (
              "Could not load older entries — retry"
            ) : (
              `Load older entries (${entries.length}${
                timelineTotal ? ` of ${timelineTotal}` : ""
              } shown)`
            )}
          </Button>
        </li>
      ) : null}
    </ol>
  );
}
