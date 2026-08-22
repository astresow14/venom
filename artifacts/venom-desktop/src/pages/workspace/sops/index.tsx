import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  exportSharedWorkspaceMarkdown,
  exportVenomPersonalMarkdown,
  useListVenomSops,
  useListVenomApps,
  useListSharedWorkspaceSops,
  usePublishSharedWorkspaceSop,
  useSetSharedWorkspaceSopRestriction,
  useSetSharedWorkspaceSopSensitivity,
  getListVenomSopsQueryKey,
  getListVenomAppsQueryKey,
  getListSharedWorkspaceSopsQueryKey,
  type VenomSop,
  type ListVenomSopsParams,
  type SharedWorkspaceRole,
  type SharedWorkspaceSop,
} from "@workspace/api-client-react";
import {
  ScrollText,
  Plus,
  ArrowRight,
  Download,
  ServerCrash,
  PackageSearch,
  Book,
  Search,
  Loader2,
  Lock,
  LockOpen,
  ShieldAlert,
  ShieldOff,
  Users,
} from "lucide-react";
import {
  downloadMarkdown,
  markdownExportFileName,
} from "@/lib/download-markdown";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import CreateSopDialog from "@/components/workspace/sops/CreateSopDialog";
import { cn } from "@/lib/utils";
import { asList } from "@/lib/as-list";
import {
  resolveSharedSopLibraryState,
  resolveSopLibraryState,
} from "@/lib/sopLibrary";
import { useSharedWorkspace } from "@/context/shared-workspace";
import { useToast } from "@/hooks/use-toast";

const PERSONAL_SCOPE = "__personal__";

export default function SopsPage() {
  const [search, setSearch] = useState("");
  const [lifecycle, setLifecycle] = useState<string>("all");
  const [appId, setAppId] = useState<string>("all");
  const [exporting, setExporting] = useState(false);
  const { toast } = useToast();

  // Which SOP library is on screen. Page-local by design (Task #281): the
  // global workspace switcher is gone, so this page carries its own scope.
  // Deriving from the membership list means a lost membership snaps the view
  // back to the personal library on the next poll.
  const { workspaces } = useSharedWorkspace();
  const [scopeId, setScopeId] = useState<string>(PERSONAL_SCOPE);
  const activeWorkspace =
    scopeId === PERSONAL_SCOPE
      ? null
      : (workspaces.find((workspace) => workspace.id === scopeId) ?? null);
  const isWorkspaceView = Boolean(activeWorkspace);

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const markdown = activeWorkspace
        ? await exportSharedWorkspaceMarkdown(activeWorkspace.id, "sops")
        : await exportVenomPersonalMarkdown("sops");
      downloadMarkdown(
        markdownExportFileName(
          activeWorkspace ? activeWorkspace.name : "personal",
          "sops",
        ),
        markdown,
      );
    } catch {
      toast({
        title: "Export failed",
        description: "The download could not be prepared. Try again.",
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  };

  const { data: appsResponse } = useListVenomApps({
    query: {
      queryKey: getListVenomAppsQueryKey(),
      enabled: !isWorkspaceView,
    },
  });
  const appsData = asList(appsResponse);

  const personalParams: ListVenomSopsParams = {
    query: search.trim() || undefined,
    lifecycle: lifecycle !== "all" ? (lifecycle as any) : undefined,
    appId: appId !== "all" ? appId : undefined,
  };
  const personalQuery = useListVenomSops(personalParams, {
    query: {
      queryKey: getListVenomSopsQueryKey(personalParams),
      enabled: !isWorkspaceView,
    },
  });

  // Shared SOPs come only from the membership-checked endpoint and live in
  // the query cache, never in the synced personal snapshot.
  const workspaceQuery = useListSharedWorkspaceSops(activeWorkspace?.id ?? "", {
    query: {
      queryKey: getListSharedWorkspaceSopsQueryKey(activeWorkspace?.id ?? ""),
      enabled: isWorkspaceView,
    },
  });

  // The responses are never trusted to be lists: a failing backend, an error
  // payload, or an unauthenticated response hands these queries something
  // that is not an array, and mapping it directly used to crash the whole
  // workspace route instead of rendering this page's error state.
  const personalLibrary = useMemo(
    () =>
      resolveSopLibraryState({
        data: personalQuery.data,
        isLoading: personalQuery.isLoading,
        isError: personalQuery.isError,
      }),
    [personalQuery.data, personalQuery.isLoading, personalQuery.isError],
  );
  const workspaceLibrary = useMemo(
    () =>
      resolveSharedSopLibraryState({
        data: workspaceQuery.data,
        isLoading: workspaceQuery.isLoading,
        isError: workspaceQuery.isError,
      }),
    [workspaceQuery.data, workspaceQuery.isLoading, workspaceQuery.isError],
  );

  const workspaceSops = useMemo(() => {
    const rows =
      workspaceLibrary.status === "ready" ? workspaceLibrary.sops : [];
    const term = search.trim().toLowerCase();
    return rows.filter((sop) => {
      if (lifecycle !== "all" && sop.lifecycle !== lifecycle) return false;
      if (!term) return true;
      return (
        sop.title.toLowerCase().includes(term) ||
        sop.tags.some((tag) => tag.toLowerCase().includes(term)) ||
        sop.content.purpose.toLowerCase().includes(term)
      );
    });
  }, [workspaceLibrary, search, lifecycle]);

  const library = isWorkspaceView ? workspaceLibrary : personalLibrary;
  const activeQuery = isWorkspaceView ? workspaceQuery : personalQuery;
  const personalSops =
    personalLibrary.status === "ready" ? personalLibrary.sops : [];
  const visibleSops = isWorkspaceView ? workspaceSops : personalSops;

  return (
    <div className="flex h-full flex-col bg-background relative overflow-hidden">
      {/* Edgy background detail */}
      <div className="absolute top-0 left-0 -ml-32 -mt-32 w-[500px] h-[500px] bg-foreground/[0.02] rounded-full blur-3xl pointer-events-none animate-breathe" />

      <header className="shrink-0 border-b border-border/60 px-6 py-8 relative z-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between max-w-6xl mx-auto">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground flex items-center gap-3">
              <ScrollText className="h-8 w-8 text-foreground animate-pulse" strokeWidth={2.5} />
              SOP Library
              {isWorkspaceView && activeWorkspace && (
                <span
                  className="flex max-w-[220px] items-center gap-1.5 rounded-full border border-foreground/60 px-3 py-1 text-[11px] font-semibold text-foreground"
                  data-testid="badge-workspace-sops"
                >
                  <Users className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">{activeWorkspace.name}</span>
                </span>
              )}
            </h1>
            <p className="text-xs text-muted-foreground mt-2 max-w-xl">
              {isWorkspaceView
                ? "Procedures shared with every member of this workspace, served only while you belong to it"
                : "Explicit, reviewable, and revision-pinned methods to govern agent and human operations"}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={handleExport}
              disabled={exporting}
              className="rounded-md border-border/60 font-medium hover:border-foreground/50"
              data-testid="button-export-sops"
              aria-label={
                isWorkspaceView
                  ? "Download this workspace's SOPs as Markdown"
                  : "Download your SOPs as Markdown"
              }
            >
              {exporting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="mr-2 h-4 w-4" aria-hidden="true" />
              )}
              Export .md
            </Button>
            <CreateSopDialog
              workspace={
                activeWorkspace
                  ? { id: activeWorkspace.id, name: activeWorkspace.name }
                  : undefined
              }
            >
              <Button
                className="rounded-md bg-foreground text-background hover:bg-foreground/90 transition-transform hover:scale-[1.02] active:scale-[0.98] font-medium shadow-lift"
              >
                <Plus className="mr-2 h-4 w-4" />
                New SOP
              </Button>
            </CreateSopDialog>
          </div>
        </div>
      </header>

      <div className="border-b border-border/60 bg-background/50 backdrop-blur px-6 py-4 relative z-10 shrink-0">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input 
              placeholder="Search SOPs..." 
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 rounded-md border-border/60 bg-background/50 text-sm focus-visible:ring-1 focus-visible:ring-foreground"
            />
          </div>
          {workspaces.length > 0 && (
            <Select value={scopeId} onValueChange={setScopeId}>
              <SelectTrigger
                className="w-[200px] rounded-md border-border/60 bg-background/50 font-medium text-xs focus-visible:ring-1 focus-visible:ring-foreground"
                data-testid="select-sop-scope"
                aria-label="SOP library scope"
              >
                <SelectValue placeholder="Personal" />
              </SelectTrigger>
              <SelectContent className="rounded-lg border-border/60 bg-background shadow-lift">
                <SelectItem
                  value={PERSONAL_SCOPE}
                  className="font-medium text-xs rounded-md"
                >
                  Personal
                </SelectItem>
                {workspaces.map((workspace) => (
                  <SelectItem
                    key={workspace.id}
                    value={workspace.id}
                    className="font-medium text-xs rounded-md"
                  >
                    {workspace.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={lifecycle} onValueChange={setLifecycle}>
            <SelectTrigger className="w-[180px] rounded-md border-border/60 bg-background/50 font-medium text-xs focus-visible:ring-1 focus-visible:ring-foreground">
              <SelectValue placeholder="All Lifecycles" />
            </SelectTrigger>
            <SelectContent className="rounded-lg border-border/60 bg-background shadow-lift">
              <SelectItem value="all" className="font-medium text-xs rounded-md">All Lifecycles</SelectItem>
              <SelectItem value="draft" className="font-medium text-xs rounded-md">Drafts</SelectItem>
              <SelectItem value="active" className="font-medium text-xs rounded-md">Active</SelectItem>
              <SelectItem value="archived" className="font-medium text-xs rounded-md">Archived</SelectItem>
            </SelectContent>
          </Select>
          {!isWorkspaceView && (
            <Select value={appId} onValueChange={setAppId}>
              <SelectTrigger className="w-[180px] rounded-md border-border/60 bg-background/50 font-medium text-xs focus-visible:ring-1 focus-visible:ring-foreground">
                <SelectValue placeholder="All Apps" />
              </SelectTrigger>
              <SelectContent className="rounded-lg border-border/60 bg-background shadow-lift">
                <SelectItem value="all" className="font-medium text-xs rounded-md">All Apps</SelectItem>
                {appsData?.map(app => (
                  <SelectItem key={app.id} value={app.id} className="font-medium text-xs rounded-md">
                    {app.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 relative z-10">
        <div className="max-w-6xl mx-auto">
          {library.status === "loading" ? (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {[...Array(6)].map((_, i) => (
                <Skeleton
                  key={i}
                  className="h-48 rounded-lg border border-border/60 bg-muted/20"
                />
              ))}
            </div>
          ) : library.status === "error" ? (
            <div
              className="flex h-64 flex-col items-center justify-center border border-dashed border-destructive/30 rounded-xl bg-destructive/5 text-destructive p-8 text-center"
              role="alert"
              data-testid="status-sops-error"
            >
              <ServerCrash className="h-12 w-12 mb-4 opacity-80" />
              <h3 className="text-lg font-semibold">
                Library unavailable
              </h3>
              <p className="text-sm mt-2 opacity-80 max-w-md">
                {library.reason === "malformed-response"
                  ? "Your SOP records came back in an unexpected shape. Try again in a moment."
                  : "We could not load your SOP records. Try again in a moment."}
              </p>
              <Button
                variant="outline"
                className="mt-6 rounded-md font-medium border-destructive/30 text-destructive hover:bg-destructive hover:text-destructive-foreground transition-colors"
                onClick={() => {
                  void activeQuery.refetch();
                }}
                disabled={activeQuery.isFetching}
                data-testid="button-retry-sops"
              >
                {activeQuery.isFetching ? "Retrying" : "Try again"}
              </Button>
            </div>
          ) : library.status === "empty" || visibleSops.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center border border-border/60 surface rounded-xl">
              <PackageSearch className="h-16 w-16 text-muted-foreground mb-6 opacity-50" strokeWidth={1} />
              <h3 className="text-xl font-semibold tracking-tight mb-2">
                No SOPs found
              </h3>
              <p className="text-muted-foreground text-sm max-w-sm mb-8">
                {isWorkspaceView && activeWorkspace
                  ? `SOPs created in ${activeWorkspace.name} appear for every member.`
                  : "Create a standard operating procedure to begin standardizing your team's workflow."}
              </p>
              <CreateSopDialog
                workspace={
                  activeWorkspace
                    ? { id: activeWorkspace.id, name: activeWorkspace.name }
                    : undefined
                }
              >
                <Button 
                  variant="outline" 
                  className="rounded-md font-medium border-foreground/20 hover:bg-foreground hover:text-background transition-colors"
                >
                  Create First SOP
                </Button>
              </CreateSopDialog>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {isWorkspaceView && activeWorkspace
                ? workspaceSops.map((sop) => (
                    <WorkspaceSopCard
                      key={sop.id}
                      sop={sop}
                      workspace={activeWorkspace}
                    />
                  ))
                : personalSops.map((sop) => (
                    <SopCard key={sop.id} sop={sop} />
                  ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Shared SOPs have no personal detail page (that editor works on the local
 * store), so the card is read-only. Drafts get an inline Publish action —
 * publishing pins the revision for every member.
 */
function WorkspaceSopCard({
  sop,
  workspace,
}: {
  sop: SharedWorkspaceSop;
  workspace: { id: string; name: string; role: SharedWorkspaceRole };
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const publishSop = usePublishSharedWorkspaceSop();
  const sopSensitivity = useSetSharedWorkspaceSopSensitivity();
  // Admin-only restrictions: members never receive restricted SOPs from the
  // server, so the badge and toggle only ever render for admins.
  const sopRestriction = useSetSharedWorkspaceSopRestriction();
  const isSensitive = sop.sensitive === true;
  const isRestricted = sop.adminOnly === true;
  const isAdmin = workspace.role === "admin";

  const handleToggleRestriction = () => {
    if (sopRestriction.isPending) return;
    sopRestriction.mutate(
      {
        workspaceId: workspace.id,
        sopId: sop.id,
        data: { adminOnly: !isRestricted },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListSharedWorkspaceSopsQueryKey(workspace.id),
          });
        },
        onError: () => {
          toast({
            title: "Could not update the restriction",
            description: "Try again in a moment.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleToggleLock = () => {
    if (sopSensitivity.isPending) return;
    sopSensitivity.mutate(
      {
        workspaceId: workspace.id,
        sopId: sop.id,
        data: { sensitive: !isSensitive },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListSharedWorkspaceSopsQueryKey(workspace.id),
          });
        },
        onError: () => {
          toast({
            title: "Could not update the lock",
            description: "Try again in a moment.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handlePublish = () => {
    if (publishSop.isPending) return;
    publishSop.mutate(
      { workspaceId: workspace.id, sopId: sop.id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListSharedWorkspaceSopsQueryKey(workspace.id),
          });
          toast({
            title: "SOP published",
            description: `${sop.title} is now active for everyone in ${workspace.name}.`,
          });
        },
        onError: () => {
          toast({
            title: "Could not publish",
            description: "Try again in a moment.",
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <div
      className="group relative flex h-full flex-col border border-border/60 surface p-5 rounded-lg transition-all hover:border-foreground/50 hover:shadow-soft overflow-hidden"
      data-testid={`card-workspace-sop-${sop.id}`}
    >
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="text-[10px] text-muted-foreground mb-1">
            {sop.category.replace("_", " ")}
          </div>
          <h3 className="text-lg font-semibold tracking-tight">{sop.title}</h3>
        </div>
        <div className="flex items-center gap-1.5">
          {isSensitive && (
            <span
              className="flex items-center gap-1 rounded-full border border-foreground px-2.5 py-0.5 text-[11px] font-semibold text-foreground"
              data-testid={`badge-sensitive-sop-${sop.id}`}
            >
              <Lock className="h-3 w-3" aria-hidden="true" />
              Sensitive
            </span>
          )}
          {isRestricted && (
            <span
              className="flex items-center gap-1 rounded-full bg-foreground px-2.5 py-0.5 text-[11px] font-semibold text-background"
              data-testid={`badge-restricted-sop-${sop.id}`}
            >
              <ShieldAlert className="h-3 w-3" aria-hidden="true" />
              Admin-only
            </span>
          )}
          <SopStatusBadge status={sop.lifecycle} />
        </div>
      </div>

      <p className="text-sm text-muted-foreground line-clamp-2 mb-6 font-medium leading-relaxed flex-1">
        {sop.content.purpose}
      </p>

      {sop.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-4">
          {sop.tags.slice(0, 3).map((tag, i) => (
            <span key={i} className="text-[9px] font-medium px-2 py-0.5 border border-border/60 text-foreground/70 bg-muted/30 rounded-full">
              {tag}
            </span>
          ))}
          {sop.tags.length > 3 && (
            <span className="text-[9px] font-medium px-2 py-0.5 border border-border/60 text-foreground/70 bg-muted/30 rounded-full">
              +{sop.tags.length - 3}
            </span>
          )}
        </div>
      )}

      <div className="mt-auto pt-4 border-t border-border/60 flex items-center justify-between text-xs">
        <div className="flex items-center gap-2 text-foreground/70">
          <Book className="h-3 w-3" />
          {sop.activeRevisionNumber ? (
            <span className="font-medium">v{sop.activeRevisionNumber}</span>
          ) : (
            <span className="opacity-50">UNPUBLISHED</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleToggleLock}
            disabled={sopSensitivity.isPending}
            className="h-7 rounded-md border-foreground/20 px-3 text-[11px] font-semibold hover:bg-foreground hover:text-background"
            aria-label={
              isSensitive
                ? `Remove sensitivity lock from ${sop.title}`
                : `Mark ${sop.title} sensitive`
            }
            data-testid={`button-toggle-sop-sensitivity-${sop.id}`}
          >
            {sopSensitivity.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            ) : isSensitive ? (
              <>
                <LockOpen className="mr-1 h-3 w-3" aria-hidden="true" />
                Unlock
              </>
            ) : (
              <>
                <Lock className="mr-1 h-3 w-3" aria-hidden="true" />
                Lock
              </>
            )}
          </Button>
          {isAdmin && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleToggleRestriction}
              disabled={sopRestriction.isPending}
              className="h-7 rounded-md border-foreground/20 px-3 text-[11px] font-semibold hover:bg-foreground hover:text-background"
              aria-label={
                isRestricted
                  ? `Remove the admin-only restriction from ${sop.title}`
                  : `Restrict ${sop.title} to admins`
              }
              data-testid={`button-toggle-sop-restriction-${sop.id}`}
            >
              {sopRestriction.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              ) : isRestricted ? (
                <>
                  <ShieldOff className="mr-1 h-3 w-3" aria-hidden="true" />
                  Unrestrict
                </>
              ) : (
                <>
                  <ShieldAlert className="mr-1 h-3 w-3" aria-hidden="true" />
                  Restrict
                </>
              )}
            </Button>
          )}
          {sop.lifecycle === "draft" && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handlePublish}
              disabled={publishSop.isPending}
              className="h-7 rounded-md border-foreground/20 px-3 text-[11px] font-semibold hover:bg-foreground hover:text-background"
              data-testid={`button-publish-sop-${sop.id}`}
            >
              {publishSop.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              ) : (
                "Publish"
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function SopCard({ sop }: { sop: VenomSop }) {
  return (
    <Link 
      href={`/workspace/sops/${sop.id}`}
      className="group relative flex h-full flex-col border border-border/60 surface p-5 rounded-lg transition-all hover:border-foreground/50 hover:shadow-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground overflow-hidden cursor-pointer"
      data-testid={`card-sop-${sop.id}`}
    >
      <div className="absolute left-0 top-0 h-full w-1 bg-foreground transform -translate-x-full group-hover:translate-x-0 transition-transform duration-300 ease-out" />

      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="text-[10px] text-muted-foreground mb-1">
            {sop.category.replace("_", " ")}
          </div>
          <h3 className="text-lg font-semibold tracking-tight group-hover:underline underline-offset-4 decoration-foreground/30">
            {sop.title}
          </h3>
        </div>
        <SopStatusBadge status={sop.lifecycle} />
      </div>

      <p className="text-sm text-muted-foreground line-clamp-2 mb-6 font-medium leading-relaxed flex-1">
        {sop.content.purpose}
      </p>

      {sop.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-4">
          {sop.tags.slice(0, 3).map((tag, i) => (
            <span key={i} className="text-[9px] font-medium px-2 py-0.5 border border-border/60 text-foreground/70 bg-muted/30 rounded-full">
              {tag}
            </span>
          ))}
          {sop.tags.length > 3 && (
            <span className="text-[9px] font-medium px-2 py-0.5 border border-border/60 text-foreground/70 bg-muted/30 rounded-full">
              +{sop.tags.length - 3}
            </span>
          )}
        </div>
      )}

      <div className="mt-auto pt-4 border-t border-border/60 flex items-center justify-between text-xs">
        <div className="flex items-center gap-2 text-foreground/70">
          <Book className="h-3 w-3" />
          {sop.activeRevisionNumber ? (
            <span className="font-medium">v{sop.activeRevisionNumber}</span>
          ) : (
            <span className="opacity-50">UNPUBLISHED</span>
          )}
        </div>
        <ArrowRight className="h-4 w-4 text-foreground/40 group-hover:text-foreground transform group-hover:translate-x-1 transition-all" />
      </div>
    </Link>
  );
}

function SopStatusBadge({ status }: { status: VenomSop["lifecycle"] }) {
  return (
    <div
      className={cn(
        "px-2.5 py-0.5 text-[11px] font-semibold rounded-full flex items-center gap-1.5",
        status === "active"
          ? "bg-foreground text-background"
          : status === "draft"
          ? "bg-muted text-foreground border border-border/60"
          : "bg-transparent text-muted-foreground border border-border/60 opacity-60",
      )}
    >
      {status}
    </div>
  );
}
