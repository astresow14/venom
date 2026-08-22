import { lazy, Suspense, useMemo } from "react";
import { useRoute, useLocation, Link } from "wouter";
import {
  useGetVenomApp,
  useDeleteVenomApp,
  useListVenomBuildRuns,
  getGetVenomAppQueryKey,
  getListVenomBuildRunsQueryKey,
} from "@workspace/api-client-react";
import {
  Hexagon,
  ArrowLeft,
  Trash2,
  ExternalLink,
  Activity,
  FileArchive,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  History,
  Loader2,
  Plus,
  Rocket,
  Sparkles,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { asList } from "@/lib/as-list";
import { hasActiveImportJob, resolveAppDetailState } from "@/lib/appPortfolio";
import { isVenomBuildRunListRow } from "@/lib/buildRuns";
import SharingPanel from "@/components/workspace/apps/sharing-panel";

const AiUsagePanel = lazy(
  () => import("@/components/workspace/apps/ai-usage-panel"),
);
import UploadVersionDialog from "@/components/workspace/apps/upload-version-dialog";
import {
  EvolutionTimeline,
  ImproveAppDialog,
  ImprovementSignalBanner,
  KnowledgeContextCard,
} from "@/components/workspace/apps/app-iteration-panels";

export default function AppDetailPage() {
  const [, params] = useRoute("/workspace/apps/:id");
  const [, setLocation] = useLocation();
  const appId = params?.id;
  const { toast } = useToast();

  const detailQuery = useGetVenomApp(appId!, {
    query: {
      enabled: !!appId,
      queryKey: getGetVenomAppQueryKey(appId!),
      // If there's an active job, refetch every 2 seconds. The callback sees
      // the raw payload before the resolver runs, so it reads defensively.
      refetchInterval: (query) =>
        hasActiveImportJob(query.state.data) ? 2000 : false,
    },
  });
  // The generated client resolves failed requests (401/5xx) to the JSON
  // error body as data, so the record is validated before anything reads it
  // — the same contract as the SOP detail page.
  const detailState = useMemo(
    () =>
      resolveAppDetailState({
        data: detailQuery.data,
        isLoading: detailQuery.isLoading,
        isError: detailQuery.isError,
      }),
    [detailQuery.data, detailQuery.isLoading, detailQuery.isError],
  );

  const { data: buildRunsResponse } = useListVenomBuildRuns(
    { appId: appId! },
    {
      query: { enabled: !!appId, queryKey: getListVenomBuildRunsQueryKey({ appId: appId! }) },
    },
  );
  const buildRuns = asList(buildRunsResponse).filter(isVenomBuildRunListRow);

  const deleteApp = useDeleteVenomApp();

  if (detailState.status === "loading") {
    return (
      <div className="p-8 max-w-5xl mx-auto w-full space-y-8">
        <Skeleton className="h-12 w-64 rounded-xl bg-muted/20" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="md:col-span-2 space-y-4">
            <Skeleton className="h-32 rounded-xl bg-muted/20" />
            <Skeleton className="h-64 rounded-xl bg-muted/20" />
          </div>
          <Skeleton className="h-96 rounded-xl bg-muted/20" />
        </div>
      </div>
    );
  }

  if (detailState.status === "error") {
    return (
      <div
        className="flex flex-col items-center justify-center h-full p-8 text-center"
        role="alert"
        data-testid="status-app-detail-error"
      >
        <AlertTriangle className="h-12 w-12 text-destructive mb-4" />
        <h2 className="text-xl font-semibold tracking-tight">
          App unavailable
        </h2>
        <p className="text-muted-foreground text-sm mt-2 mb-6 max-w-md">
          {detailState.reason === "malformed-response"
            ? "This app record came back in an unexpected shape. It may have been removed, it may belong to another account, or the portfolio may be answering incorrectly."
            : "We could not load this app. Try again in a moment."}
        </p>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            onClick={() => {
              void detailQuery.refetch();
            }}
            disabled={detailQuery.isFetching}
            className="rounded-md font-medium border-destructive/30 text-destructive hover:bg-destructive hover:text-destructive-foreground transition-colors"
            data-testid="button-retry-app-detail"
          >
            {detailQuery.isFetching ? "Retrying" : "Try again"}
          </Button>
          <Link 
            href="/workspace/apps"
            className="inline-flex items-center justify-center whitespace-nowrap text-sm h-10 px-4 py-2 border border-border/60 rounded-md font-medium shadow-soft"
            data-testid="link-return-matrix"
          >
            Return to Portfolio
          </Link>
        </div>
      </div>
    );
  }

  const detail = detailState.detail;
  const { app, versions, importJobs, timeline } = detail;

  const handleDelete = async () => {
    try {
      await deleteApp.mutateAsync({ appId: app.id });
      toast({
         title: "App deleted",
         description: "The app record and its private source packages were deleted.",
      });
      setLocation("/workspace/apps");
    } catch (err: any) {
      toast({
        title: "Deletion failed",
         description: err.message || "Unable to delete the app.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="flex h-full flex-col bg-background overflow-hidden relative">
      <div className="absolute inset-0 bg-foreground/[0.01] pointer-events-none" />

      {/* Header */}
      <header className="shrink-0 border-b border-border/40 px-6 py-6 relative z-10 bg-background/80 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <Link
              href="/workspace/apps"
              className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-foreground mb-4 transition-colors group"
            >
              <ArrowLeft className="mr-2 h-3 w-3 group-hover:-translate-x-1 transition-transform" />
               App portfolio
            </Link>
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-3xl font-semibold tracking-tight text-foreground">
                {app.name}
              </h1>
              <AppStatusBadge status={app.status} />
              {app.liveReleaseId ? (
                <span
                  className="inline-flex items-center gap-1.5 rounded-full border border-foreground/30 bg-foreground/[0.04] px-2.5 py-1 text-[11px] font-semibold tracking-tight"
                  title={
                    app.livePublishedAt
                      ? `Published ${new Date(app.livePublishedAt).toLocaleString()}`
                      : undefined
                  }
                  data-testid={`badge-live-version-${app.id}`}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-foreground animate-pulse"
                    aria-hidden="true"
                  />
                  {app.liveIterationNumber != null
                    ? app.latestIterationNumber > app.liveIterationNumber
                      ? `Live v${app.liveIterationNumber} · newest v${app.latestIterationNumber}`
                      : `Live v${app.liveIterationNumber}`
                    : "Live"}
                </span>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              {app.brand} / {app.id.split("-")[0]}
            </p>
          </div>

          <div className="flex items-center gap-3">
            {app.deploymentUrl && (
              <a href={app.deploymentUrl} target="_blank" rel="noopener noreferrer">
                <Button 
                  className="rounded-md font-medium shadow-soft bg-foreground text-background hover:bg-foreground/90 transition-all"
                  data-testid={`link-launch-${app.id}`}
                >
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Launch
                </Button>
              </a>
            )}

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  className="rounded-md font-medium border-border/60 text-destructive hover:bg-destructive hover:text-destructive-foreground transition-all"
                  data-testid={`button-delete-app-${app.id}`}
                >
                  <Trash2 className="h-4 w-4 md:mr-2" />
                   <span className="hidden md:inline">Delete</span>
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="rounded-2xl border-border/60 surface p-0 sm:max-w-[420px] shadow-lift">
                <div className="p-6">
                  <AlertDialogHeader>
                    <AlertDialogTitle className="text-xl font-semibold tracking-tight text-destructive flex items-center gap-2">
                      <AlertTriangle className="h-5 w-5" />
                       Delete app record?
                    </AlertDialogTitle>
                    <AlertDialogDescription className="text-sm mt-2">
                       This cannot be undone. The app record, private source packages,
                       deployment links, and import history will be permanently deleted.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter className="mt-8">
                    <AlertDialogCancel className="rounded-md font-medium border-border/60 hover:bg-accent hover:text-accent-foreground">
                       Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDelete}
                      disabled={deleteApp.isPending}
                      className="rounded-md font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-soft"
                    >
                      {deleteApp.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                         "Delete app"
                      )}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </div>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6 relative z-10">
        <div className="max-w-6xl mx-auto">
          <ImprovementSignalBanner app={app} />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-8">
            <section>
              <h2 className="text-base font-semibold tracking-tight border-b border-border/60 pb-2 mb-4 flex items-center gap-2">
                <FileArchive className="h-4 w-4" />
                Import jobs
              </h2>
              {importJobs.length === 0 ? (
                <EmptyState message="No import history found." />
              ) : (
                <div className="grid gap-3">
                  {importJobs.map((job) => (
                    <JobCard key={job.id} job={job} appId={app.id} />
                  ))}
                </div>
              )}
            </section>

            <section>
              <h2 className="text-base font-semibold tracking-tight border-b border-border/60 pb-2 mb-4 flex items-center gap-2">
                <Hexagon className="h-4 w-4" />
                Source versions
              </h2>
              {versions.length === 0 ? (
                <EmptyState message="No source versions available." />
              ) : (
                <div className="grid gap-3">
                  {versions.map((ver) => (
                    <VersionCard key={ver.id} version={ver} />
                  ))}
                </div>
              )}
            </section>

            <section>
              <h2 className="text-base font-semibold tracking-tight border-b border-border/60 pb-2 mb-4 flex items-center gap-2">
                <History className="h-4 w-4" />
                Evolution
              </h2>
              <EvolutionTimeline
                appId={app.id}
                timeline={timeline}
                timelineTotal={detail.timelineTotal}
                timelineTruncated={detail.timelineTruncated}
              />
            </section>
          </div>

          <div className="space-y-6">
            <div className="border border-border/60 surface p-5 rounded-xl shadow-soft">
              <h3 className="text-sm font-semibold tracking-tight mb-4">
                Operations
              </h3>
              <div className="space-y-3">
                <ImproveAppDialog app={app}>
                  <Button
                    className="w-full rounded-md font-medium shadow-soft bg-foreground text-background hover:bg-foreground/90 transition-transform hover:scale-[1.02] active:scale-[0.98]"
                    data-testid={`button-improve-app-${app.id}`}
                  >
                    <Sparkles className="mr-2 h-4 w-4" />
                    Improve this app
                  </Button>
                </ImproveAppDialog>
                <Link
                  href={`/workspace/builds/new?appId=${app.id}`}
                  className="inline-flex w-full"
                >
                  <Button
                    variant="outline"
                    className="w-full rounded-md font-medium border-border/60 shadow-soft hover:bg-foreground hover:text-background transition-transform hover:scale-[1.02] active:scale-[0.98]"
                  >
                    <Rocket className="mr-2 h-4 w-4" />
                    New build
                  </Button>
                </Link>
                <UploadVersionDialog appId={app.id}>
                  <Button
                    variant="outline"
                    className="w-full rounded-md font-medium border-border/60 shadow-soft hover:bg-foreground hover:text-background transition-transform hover:scale-[1.02] active:scale-[0.98]"
                    data-testid={`button-upload-source-${app.id}`}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Upload Source
                  </Button>
                </UploadVersionDialog>
              </div>
            </div>

            <SharingPanel app={app} />

            <Suspense fallback={null}>
              <AiUsagePanel app={app} />
            </Suspense>

            <KnowledgeContextCard app={app} />

            {buildRuns && buildRuns.length > 0 && (
              <div className="border border-border/60 surface p-5 rounded-xl shadow-soft">
                <h3 className="text-sm font-semibold tracking-tight mb-4">
                  Build runs
                </h3>
                <div className="space-y-3">
                  {buildRuns.slice(0, 5).map(run => (
                    <Link
                      key={run.id}
                      href={`/workspace/builds/${run.id}`}
                      className="group flex items-center justify-between py-2 border-b border-border/40 last:border-0 hover:bg-foreground/[0.03] transition-colors"
                    >
                      <div className="flex flex-col">
                        <span className="text-sm font-medium tracking-tight group-hover:underline underline-offset-2">
                          {new Date(run.createdAt).toLocaleDateString()}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {run.status}
                        </span>
                      </div>
                      <ArrowLeft className="h-3 w-3 rotate-180 opacity-0 group-hover:opacity-100 transition-all text-foreground transform -translate-x-2 group-hover:translate-x-0" />
                    </Link>
                  ))}
                </div>
              </div>
            )}

            <div className="border border-border/60 surface p-5 rounded-xl shadow-soft">
              <h3 className="text-sm font-semibold tracking-tight mb-4">
                Metadata
              </h3>
              <dl className="space-y-4 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground mb-1 font-medium">Purpose</dt>
                  <dd className="font-medium normal-case tracking-normal">
                    {app.purpose}
                  </dd>
                </div>
                {app.templateName && (
                  <div>
                    <dt className="text-xs text-muted-foreground mb-1 font-medium">
                      Template origin
                    </dt>
                    <dd
                      className="font-medium normal-case tracking-normal"
                      data-testid="text-template-origin"
                    >
                      {app.templateName}
                    </dd>
                  </div>
                )}
                <div>
                  <dt className="text-xs text-muted-foreground mb-1 font-medium">
                    Detected stack
                  </dt>
                  <dd>
                    {app.detectedStack.length > 0
                      ? app.detectedStack.join(", ")
                      : "Unknown"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground mb-1 font-medium">
                    Last update
                  </dt>
                  <dd>
                    {app.updatedAt
                      ? new Date(app.updatedAt).toLocaleString()
                      : "Never"}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function JobCard({ job, appId }: { job: any; appId: string }) {
  const isFailed = job.status === "failed";
  const isComplete = job.status === "complete";
  const isActive = !isFailed && !isComplete;

  return (
    <div
      className={cn(
        "border border-border/60 p-4 transition-all duration-300 rounded-lg shadow-soft surface",
        isFailed
          ? "border-destructive/30 bg-destructive/5"
          : isComplete
          ? "border-border/40 bg-foreground/[0.01]"
          : "border-foreground/30 bg-foreground/[0.03] shadow-md",
      )}
      data-testid={`job-${job.id}`}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          {isActive ? (
            <RefreshCw className="h-5 w-5 text-foreground animate-spin" />
          ) : isComplete ? (
             <CheckCircle2 className="h-5 w-5 text-foreground/70" />
          ) : (
            <XCircle className="h-5 w-5 text-destructive" />
          )}
          <div>
            <div className="font-medium text-sm">
              {job.archiveFilename}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {new Date(job.createdAt).toLocaleString()}
            </div>
          </div>
        </div>
        <div className="text-right flex flex-col items-end">
          <span
            className={cn(
              "text-xs font-medium px-2 py-1 border rounded-full",
              isFailed
                ? "text-destructive border-destructive/20 bg-destructive/10"
                : isComplete
                ? "text-muted-foreground border-border/50"
                : "text-foreground border-foreground/30 bg-foreground/5",
            )}
          >
            {job.status}
          </span>
          {isActive && job.progress > 0 && (
            <span className="text-xs mt-1">
              {job.progress}%
            </span>
          )}
        </div>
      </div>

      {isFailed && (
        <div className="mt-4 pt-3 border-t border-destructive/20 flex items-center justify-between">
          <div className="text-xs text-destructive max-w-md">
            [ERR: {job.failureCode || "UNKNOWN"}] {job.failureMessage}
          </div>
          <UploadVersionDialog
            appId={appId}
            retryJobId={job.id}
            retryFilename={job.archiveFilename}
             retryDeclaredBytes={job.declaredBytes}
          >
            <Button
              variant="outline"
              size="sm"
              className="rounded-md border-border/60 text-destructive hover:bg-destructive hover:text-destructive-foreground font-medium h-8 text-xs shadow-soft"
            >
              Retry
            </Button>
          </UploadVersionDialog>
        </div>
      )}
    </div>
  );
}

function VersionCard({ version }: { version: any }) {
  return (
    <div className="flex items-center justify-between border border-border/60 surface p-4 rounded-lg shadow-soft">
      <div className="flex items-center gap-4">
        <div className="grid h-10 w-10 place-items-center bg-foreground text-background font-semibold text-lg rounded-md">
          v{version.versionNumber}
        </div>
        <div>
          <div className="font-medium text-sm">
            {version.archiveFilename}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 flex gap-2 items-center">
            <span>{(version.archiveBytes / 1024 / 1024).toFixed(2)} MB</span>
            <span>&bull;</span>
            <span title={version.checksumSha256} className="font-mono text-[10px]">
              {version.checksumSha256.substring(0, 8)}...
            </span>
          </div>
        </div>
      </div>
      <div className="text-right">
        <div className="text-xs text-muted-foreground">
          {new Date(version.createdAt).toLocaleDateString()}
        </div>
        <div className="text-xs font-medium mt-0.5">
          {version.manifest?.totalEntries || 0} FILES
        </div>
      </div>
    </div>
  );
}

function AppStatusBadge({ status }: { status: string }) {
  return (
    <div
      className={cn(
        "px-2 py-1 text-xs font-medium rounded-full flex items-center gap-1.5",
        status === "ready"
          ? "bg-foreground text-background"
          : status === "importing"
          ? "bg-muted text-foreground border border-border"
          : status === "attention"
          ? "bg-destructive text-destructive-foreground animate-pulse"
          : "bg-transparent text-muted-foreground border border-border/50",
      )}
    >
      {status === "importing" && <Activity className="w-3 h-3 animate-pulse" />}
      {status}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="border border-dashed border-border/60 bg-foreground/[0.01] p-8 text-center text-sm text-muted-foreground rounded-xl">
      {message}
    </div>
  );
}
