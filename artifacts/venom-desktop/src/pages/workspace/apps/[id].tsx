import { useRoute, useLocation, Link } from "wouter";
import {
  useGetVenomApp,
  useDeleteVenomApp,
  getGetVenomAppQueryKey,
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
  Loader2,
  Plus,
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
import UploadVersionDialog from "@/components/workspace/apps/upload-version-dialog";

export default function AppDetailPage() {
  const [, params] = useRoute("/workspace/apps/:id");
  const [, setLocation] = useLocation();
  const appId = params?.id;
  const { toast } = useToast();

  const { data: detail, isLoading, isError } = useGetVenomApp(appId!, {
    query: {
      enabled: !!appId,
      queryKey: getGetVenomAppQueryKey(appId!),
      refetchInterval: (query) => {
        // If there's an active job, refetch every 2 seconds
        const activeJob = query.state.data?.importJobs?.some(
          (j) => !["complete", "failed"].includes(j.status),
        );
        return activeJob ? 2000 : false;
      },
    },
  });

  const deleteApp = useDeleteVenomApp();

  if (isLoading) {
    return (
      <div className="p-8 max-w-5xl mx-auto w-full space-y-8">
        <Skeleton className="h-12 w-64 rounded-none bg-muted/20" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="md:col-span-2 space-y-4">
            <Skeleton className="h-32 rounded-none bg-muted/20" />
            <Skeleton className="h-64 rounded-none bg-muted/20" />
          </div>
          <Skeleton className="h-96 rounded-none bg-muted/20" />
        </div>
      </div>
    );
  }

  if (isError || !detail) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <AlertTriangle className="h-12 w-12 text-destructive mb-4" />
        <h2 className="text-xl font-black uppercase tracking-tighter">
          App Not Found
        </h2>
        <p className="text-muted-foreground font-mono text-sm mt-2 mb-6">
          This app record does not exist or belongs to another account.
        </p>
        <Link 
          href="/workspace/apps"
          className="inline-flex items-center justify-center whitespace-nowrap text-sm h-10 px-4 py-2 border border-input bg-background hover:bg-accent hover:text-accent-foreground rounded-none font-bold uppercase"
          data-testid="link-return-matrix"
        >
          Return to Portfolio
        </Link>
      </div>
    );
  }

  const { app, versions, importJobs, deploymentLinks } = detail;

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
              className="inline-flex items-center text-[10px] font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground mb-4 transition-colors group"
            >
              <ArrowLeft className="mr-2 h-3 w-3 group-hover:-translate-x-1 transition-transform" />
               App Portfolio
            </Link>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-black uppercase tracking-tighter text-foreground">
                {app.name}
              </h1>
              <AppStatusBadge status={app.status} />
            </div>
            <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground mt-2">
              {app.brand} / {app.id.split("-")[0]}
            </p>
          </div>

          <div className="flex items-center gap-3">
            {app.deploymentUrl && (
              <a href={app.deploymentUrl} target="_blank" rel="noopener noreferrer">
                <Button 
                  className="rounded-none font-bold uppercase tracking-widest bg-foreground text-background hover:bg-foreground/90 transition-all"
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
                  className="rounded-none font-bold uppercase tracking-widest border-destructive/20 text-destructive hover:bg-destructive hover:text-destructive-foreground transition-all"
                  data-testid={`button-delete-app-${app.id}`}
                >
                  <Trash2 className="h-4 w-4 md:mr-2" />
                   <span className="hidden md:inline">Delete</span>
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="rounded-none border-border bg-background p-0 sm:max-w-[420px]">
                <div className="p-6">
                  <AlertDialogHeader>
                    <AlertDialogTitle className="text-xl font-black uppercase tracking-tighter text-destructive flex items-center gap-2">
                      <AlertTriangle className="h-5 w-5" />
                       Delete app record?
                    </AlertDialogTitle>
                    <AlertDialogDescription className="font-mono text-xs mt-2 uppercase tracking-widest">
                       This cannot be undone. The app record, private source packages,
                       deployment links, and import history will be permanently deleted.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter className="mt-8">
                    <AlertDialogCancel className="rounded-none font-bold uppercase tracking-widest border-border/50 hover:bg-foreground/[0.05]">
                       Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDelete}
                      disabled={deleteApp.isPending}
                      className="rounded-none font-bold uppercase tracking-widest bg-destructive text-destructive-foreground hover:bg-destructive/90"
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
        <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-8">
            <section>
              <h2 className="text-lg font-black uppercase tracking-tighter border-b border-border/40 pb-2 mb-4 flex items-center gap-2">
                <FileArchive className="h-4 w-4" />
                Import Jobs
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
              <h2 className="text-lg font-black uppercase tracking-tighter border-b border-border/40 pb-2 mb-4 flex items-center gap-2">
                <Hexagon className="h-4 w-4" />
                Source Versions
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
          </div>

          <div className="space-y-6">
            <div className="border border-border/40 bg-card p-5 shadow-xl">
              <h3 className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mb-4">
                Operations
              </h3>
              <UploadVersionDialog appId={app.id}>
                <Button 
                  className="w-full rounded-none font-bold uppercase tracking-widest bg-foreground text-background hover:bg-foreground/90 transition-transform hover:scale-[1.02] active:scale-[0.98]"
                  data-testid={`button-upload-source-${app.id}`}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Upload Source
                </Button>
              </UploadVersionDialog>
            </div>

            <div className="border border-border/40 bg-card p-5 shadow-xl">
              <h3 className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mb-4">
                Metadata
              </h3>
              <dl className="space-y-4 text-sm font-mono uppercase tracking-widest">
                <div>
                  <dt className="text-[9px] text-muted-foreground mb-1">Purpose</dt>
                  <dd className="font-medium normal-case tracking-normal">
                    {app.purpose}
                  </dd>
                </div>
                <div>
                  <dt className="text-[9px] text-muted-foreground mb-1">
                    Detected Stack
                  </dt>
                  <dd>
                    {app.detectedStack.length > 0
                      ? app.detectedStack.join(", ")
                      : "Unknown"}
                  </dd>
                </div>
                <div>
                  <dt className="text-[9px] text-muted-foreground mb-1">
                    Last Update
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
  );
}

function JobCard({ job, appId }: { job: any; appId: string }) {
  const isFailed = job.status === "failed";
  const isComplete = job.status === "complete";
  const isActive = !isFailed && !isComplete;

  return (
    <div
      className={cn(
        "border p-4 transition-all duration-300",
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
            <div className="font-bold text-sm uppercase tracking-tight">
              {job.archiveFilename}
            </div>
            <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mt-0.5">
              {new Date(job.createdAt).toLocaleString()}
            </div>
          </div>
        </div>
        <div className="text-right flex flex-col items-end">
          <span
            className={cn(
              "text-[9px] font-black uppercase tracking-widest px-2 py-1 border",
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
            <span className="text-[10px] font-mono mt-1">
              {job.progress}%
            </span>
          )}
        </div>
      </div>

      {isFailed && (
        <div className="mt-4 pt-3 border-t border-destructive/20 flex items-center justify-between">
          <div className="text-xs font-mono text-destructive uppercase tracking-widest max-w-md">
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
              className="rounded-none border-destructive/30 text-destructive hover:bg-destructive hover:text-destructive-foreground font-bold uppercase tracking-widest h-8 text-[10px]"
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
    <div className="flex items-center justify-between border border-border/40 bg-card p-4">
      <div className="flex items-center gap-4">
        <div className="grid h-10 w-10 place-items-center bg-foreground text-background font-black text-lg">
          v{version.versionNumber}
        </div>
        <div>
          <div className="font-bold text-sm uppercase tracking-tight">
            {version.archiveFilename}
          </div>
          <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mt-0.5 flex gap-2">
            <span>{(version.archiveBytes / 1024 / 1024).toFixed(2)} MB</span>
            <span>&bull;</span>
            <span title={version.checksumSha256}>
              {version.checksumSha256.substring(0, 8)}...
            </span>
          </div>
        </div>
      </div>
      <div className="text-right">
        <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
          {new Date(version.createdAt).toLocaleDateString()}
        </div>
        <div className="text-[10px] font-mono font-bold mt-0.5">
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
        "px-2 py-1 text-[9px] font-black uppercase tracking-widest flex items-center gap-1.5",
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
    <div className="border border-dashed border-border/40 bg-foreground/[0.01] p-8 text-center text-sm font-mono uppercase tracking-widest text-muted-foreground">
      {message}
    </div>
  );
}
