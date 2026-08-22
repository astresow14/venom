import React, { useEffect, useRef, useState } from "react";
import { useLocation, Link, useRoute } from "wouter";
import {
  Activity,
  AlertTriangle,
  AudioLines,
  BarChart3,
  Bell,
  BookMarked,
  BrainCircuit,
  Building2,
  CheckSquare,
  ChevronDown,
  FolderInput,
  Hexagon,
  LayoutTemplate,
  LogOut,
  Menu,
  MessageSquare,
  Moon,
  Plus,
  RefreshCw,
  ScrollText,
  SquarePen,
  Sun,
  Trash2,
  Waypoints,
} from "lucide-react";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { VenomWordmark } from "@/components/venom-wordmark";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { useVenomWorkspace } from "@/context/venom-workspace";
import { useClerk, useUser } from "@clerk/react";
import { IS_UI_TEST } from "@/lib/ui-test";
import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";
import ProjectSopsDialog from "@/components/workspace/sops/ProjectSopsDialog";
import CreateProjectDialog from "@/components/workspace/CreateProjectDialog";
import VoicePreferencesDialog from "@/components/workspace/VoicePreferencesDialog";
import NetworkContributionDialog from "@/components/workspace/NetworkContributionDialog";
import UsageDialog from "@/components/workspace/UsageDialog";
import WorkspaceManager from "@/components/workspace/shared/WorkspaceManager";
import WorkspaceSwitcher from "@/components/workspace/shared/WorkspaceSwitcher";
import { useGetCommunityNotificationUnreadCount, getGetCommunityNotificationUnreadCountQueryKey, useGetVenomIdentity, getGetVenomIdentityQueryKey } from "@workspace/api-client-react";


type NavItemProps = {
  href: string;
  icon: React.ElementType;
  label: string;
  isActive: boolean;
  shortcut: string;
  onNavigate: () => void;
  badge?: number;
};

type ShellProject = {
  id: string;
  name: string;
};

type ShellConversation = {
  id: string;
  projectId: string | null;
  title?: string | null;
  updatedAt: number;
  messages: unknown[];
};

function NavItem({
  href,
  icon: Icon,
  label,
  isActive,
  shortcut,
  onNavigate,
  badge,
}: NavItemProps) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      data-testid={`link-nav-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`}
      className={cn(
        "flex min-h-10 items-center gap-3 rounded-md px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring relative",
        isActive
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
      )}
      aria-current={isActive ? "page" : undefined}
      title={`${label} (${shortcut})${badge ? ` - ${badge} unread` : ""}`}
      aria-label={`${label}${badge ? ` (${badge} unread)` : ""}`}
    >
      <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
      <span className="truncate flex-1">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="flex h-5 items-center justify-center rounded-full bg-foreground px-2 text-xs font-semibold tabular-nums text-background">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </Link>
  );
}

export default function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [, setLocation] = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Which unfiled conversation currently shows its inline "file into…"
  // project picker. A plain disclosure keeps the rarely-needed recovery
  // control out of the workspace bundle's weight budget (no portal menu) and
  // keeps keyboard focus in the list. Declared with the other hooks, above
  // the not-ready early return — a hook below it crashes the shell with
  // "Rendered more hooks than during the previous render" the moment real
  // (async) hydration finishes.
  const [filingConversationId, setFilingConversationId] = useState<
    string | null
  >(null);
  const drawerTriggerRef = useRef<HTMLButtonElement>(null);
  const drawerFocusTimerRef = useRef<number | null>(null);
  const [isChat] = useRoute("/workspace/chat");
  const [isFeed] = useRoute("/workspace/feed");
  const [isFeedThread] = useRoute("/workspace/feed/thread/:threadId");
  const isFeedActive = isFeed || isFeedThread;
  const [isNotifications] = useRoute("/workspace/notifications");
  const [isBrain] = useRoute("/workspace/brain");
  const [isTasks] = useRoute("/workspace/tasks");
  const [isApps] = useRoute("/workspace/apps/*?");
  const [isTemplates] = useRoute("/workspace/templates");
  const [isSops] = useRoute("/workspace/sops/*?");
  const [isCompany] = useRoute("/workspace/company");
  const [isCanon] = useRoute("/workspace/canon");

  const { signOut } = useClerk();
  const { user } = useUser();
  // Who Venom recognizes this account as: the server identity record is the
  // same one stamped onto captured knowledge. The Clerk client profile fills
  // in while it loads (or when the API is unreachable) so the account row
  // never goes blank.
  // Browser tests run without a Clerk session; the identity fetch still
  // fires there (stubbed per spec) so account-gated chrome — like the
  // super-admin canon entry — stays exercisable.
  const { data: identity } = useGetVenomIdentity({
    query: {
      queryKey: getGetVenomIdentityQueryKey(),
      enabled: Boolean(user) || IS_UI_TEST,
      staleTime: 5 * 60_000,
      retry: 1,
    },
  });
  const accountName =
    identity?.displayName || user?.fullName || user?.firstName || null;
  const accountEmail =
    identity?.email || user?.primaryEmailAddress?.emailAddress || null;
  const { theme, setTheme } = useTheme();

  const {
    state,
    isReady,
    syncStatus,
    retrySync,
    orgInvites,
    setActiveProject,
    deleteProject,
    pendingProjectRestore,
    restoreDeletedProject,
    setActiveConversation,
    createNewConversation,
    fileConversationToProject,
  } = useVenomWorkspace();
  const { toast } = useToast();

  const { data: unreadData } = useGetCommunityNotificationUnreadCount({
    query: {
      queryKey: [
        ...getGetCommunityNotificationUnreadCountQueryKey(),
        "account",
        user?.id ?? "signed-out",
      ],
      refetchInterval: 30000, // Poll every 30 seconds
    },
  });

  const handleSignOut = () => {
    const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
    void signOut({ redirectUrl: basePath || "/" });
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        // New sessions open under the project on screen — the selected one,
        // or the fallback first project when none is selected.
        const hotkeyProjects = state?.projects ?? [];
        const displayedProject =
          hotkeyProjects.find(
            (project) => project.id === state?.activeProjectId,
          ) ?? hotkeyProjects[0];
        const convId = createNewConversation(
          displayedProject?.id ?? state?.activeProjectId ?? null,
        );
        setActiveConversation(convId);
        setLocation("/workspace/chat");
      }
      if (e.altKey && e.key === "1") {
        e.preventDefault();
        setLocation("/workspace/chat");
      }
      if (e.altKey && e.key === "2") {
        e.preventDefault();
        setLocation("/workspace/feed");
      }
      if (e.altKey && e.key === "3") {
        e.preventDefault();
        setLocation("/workspace/brain");
      }
      if (e.altKey && e.key === "4") {
        e.preventDefault();
        setLocation("/workspace/tasks");
      }
      if (e.altKey && e.key === "5") {
        e.preventDefault();
        setLocation("/workspace/apps");
      }
      if (e.altKey && e.key === "6") {
        e.preventDefault();
        setLocation("/workspace/sops");
      }
      if (e.altKey && e.key === "7") {
        e.preventDefault();
        setLocation("/workspace/notifications");
      }
      if (e.altKey && e.key === "8") {
        e.preventDefault();
        setLocation("/workspace/company");
      }
      // Canon is a super-admin surface; for everyone else the shortcut does
      // not exist. The page and the server both re-check the role anyway.
      if (e.altKey && e.key === "9" && identity?.superAdmin === true) {
        e.preventDefault();
        setLocation("/workspace/canon");
      }
      // Alt+0 rather than renumbering: the 1–9 assignments are muscle
      // memory by now, and Templates arrived after them.
      if (e.altKey && e.key === "0") {
        e.preventDefault();
        setLocation("/workspace/templates");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    setLocation,
    createNewConversation,
    setActiveConversation,
    state?.activeProjectId,
    state?.projects,
    identity?.superAdmin,
  ]);

  useEffect(
    () => () => {
      if (drawerFocusTimerRef.current !== null) {
        window.clearTimeout(drawerFocusTimerRef.current);
      }
    },
    [],
  );

  // The undo window after a project deletion. The deletion itself is already
  // committed (tombstones and all, so it propagates to every device); Undo
  // rebuilds the captured content under fresh ids. The toast lives exactly as
  // long as the context's restore window and disappears with it.
  useEffect(() => {
    if (!pendingProjectRestore) return;
    const { key, projectName, expiresAt } = pendingProjectRestore;
    const { dismiss: dismissUndoToast } = toast({
      title: "Project deleted",
      description: `“${projectName}” and everything inside it is gone from every synced device.`,
      duration: Math.max(expiresAt - Date.now(), 1_000),
      action: (
        <ToastAction
          altText={`Undo deleting ${projectName}`}
          data-testid="button-undo-delete-project"
          onClick={() => {
            const restored = restoreDeletedProject();
            toast(
              restored
                ? {
                    title: "Project restored",
                    description: `“${projectName}” is back, with its chats, board, and knowledge.`,
                    duration: 5_000,
                  }
                : {
                    title: "Undo window closed",
                    description: `“${projectName}” could not be restored.`,
                    duration: 5_000,
                  },
            );
          }}
        >
          Undo
        </ToastAction>
      ),
    });
    // A new delete replaces the toast; expiry/dismissal simply hides it.
    return () => dismissUndoToast();
    // Keyed on the pending entry itself: a fresh delete (new key) re-fires.
  }, [pendingProjectRestore, restoreDeletedProject, toast]);

  if (!isReady || !state) {
    return (
      <div className="flex h-[100dvh] bg-background">
        <div className="hidden w-[270px] shrink-0 flex-col gap-3 border-r border-sidebar-border bg-sidebar p-4 md:flex">
          <Skeleton className="h-9 w-full rounded-lg" />
          <Skeleton className="h-9 w-full rounded-lg" />
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-14 items-center gap-3 border-b border-border px-4 md:hidden">
            <Skeleton className="h-8 w-8 rounded-lg" />
            <Skeleton className="h-5 w-32 rounded-md" />
          </div>
          <div className="flex-1 p-4 md:p-8">
            <Skeleton className="h-full w-full rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  const projects = (state.projects || []) as ShellProject[];
  const conversations = (state.conversations || []) as ShellConversation[];
  const activeProject =
    projects.find((project) => project.id === state.activeProjectId) ||
    projects[0];
  // The session a first message lands in must belong to the project on
  // screen, which is the fallback project when nothing is explicitly
  // selected (mirrors the mobile app's onScreenProjectId).
  const onScreenProjectId: string | null =
    activeProject?.id ?? state.activeProjectId ?? null;
  // A chat list shows only the on-screen project's own sessions. A session
  // with no project belongs to no project: listing it under whichever project
  // is open would let a message written "in" that project land outside it.
  const projectConvs = conversations.filter(
    (c) => c.projectId === onScreenProjectId,
  );
  const sortedProjectConversations = [...projectConvs].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
  // Sessions stranded with no project (old desktop behaviour, or a restored/
  // merged cloud snapshot) are listed under no project above, so once any
  // project exists they would be reachable nowhere. The Unfiled bucket is
  // their way back into view. It only appears while a project is on screen —
  // with no projects the main list above already shows project-less sessions
  // — and only lists sessions that hold messages, since an empty stranded
  // session has no words to recover. Reopening one never adopts it into the
  // open project; filing (below) is the one explicit action that does.
  const unfiledConversations =
    onScreenProjectId === null
      ? []
      : conversations
          .filter((c) => c.projectId === null && c.messages.length > 0)
          .sort((a, b) => b.updatedAt - a.updatedAt);

  const navigateTo = (path: string) => {
    setLocation(path);
    handleDrawerOpenChange(false);
  };

  // The workspace context moves the chat session with the project: it keeps
  // the current session only when it already belongs to the picked project,
  // reopens that project's own latest session otherwise, and never adopts a
  // session that belongs to no project.
  const handleProjectChange = (nextProjectId: string) => {
    setActiveProject(nextProjectId);
  };

  const handleNewConversation = () => {
    const id = createNewConversation(onScreenProjectId);
    setActiveConversation(id);
    navigateTo("/workspace/chat");
  };

  const handleConversationSelect = (conversationId: string) => {
    setActiveConversation(conversationId);
    navigateTo("/workspace/chat");
  };

  // Filing lands the workspace on the session in its new home (the context
  // aligns project and conversation), so the chat page is the natural place
  // to arrive.
  const handleFileConversation = (conversationId: string, projectId: string) => {
    setFilingConversationId(null);
    fileConversationToProject(conversationId, projectId);
    navigateTo("/workspace/chat");
  };

  function handleDrawerOpenChange(open: boolean) {
    if (drawerFocusTimerRef.current !== null) {
      window.clearTimeout(drawerFocusTimerRef.current);
      drawerFocusTimerRef.current = null;
    }

    setDrawerOpen(open);

    if (!open) {
      drawerFocusTimerRef.current = window.setTimeout(() => {
        drawerTriggerRef.current?.focus({ preventScroll: true });
        drawerFocusTimerRef.current = null;
      }, 350);
    }
  }

  const syncLabel =
    syncStatus === "syncing"
      ? "Syncing"
      : syncStatus === "too_large"
        ? "Workspace too large to sync"
        : syncStatus === "error"
          ? "Sync failed"
          : syncStatus === "offline"
            ? "Offline"
            : syncStatus === "loading"
              ? "Loading"
              : "Saved";
  const syncNeedsAttention = syncStatus === "error" || syncStatus === "offline";

  const sidebarBody = (idPrefix: string) => (
    <div className="flex h-full min-h-0 w-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex shrink-0 items-center px-3 pb-2 pt-[calc(env(safe-area-inset-top)+0.75rem)] md:pt-3">
        <VenomWordmark className="h-8 shrink-0" />
      </div>

      <div className="shrink-0 px-3 pb-2">
        <button
          type="button"
          onClick={handleNewConversation}
          data-testid={`button-new-chat-${idPrefix}`}
          className="flex min-h-10 w-full items-center gap-3 rounded-lg border border-sidebar-border bg-sidebar-accent/40 px-3 text-sm font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <SquarePen className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          New chat
        </button>
      </div>

      <WorkspaceSwitcher idPrefix={idPrefix} />
      <WorkspaceManager idPrefix={idPrefix} />

      <div className="shrink-0 px-3 pb-2">
        <label htmlFor={`${idPrefix}-project`} className="sr-only">
          Active project
        </label>
        <div className="flex items-center gap-1">
          <div className="relative min-w-0 flex-1">
            <select
              id={`${idPrefix}-project`}
              data-testid={`select-project-${idPrefix}`}
              value={activeProject?.id ?? ""}
              onChange={(event) => handleProjectChange(event.target.value)}
              className="h-10 w-full appearance-none rounded-lg border border-sidebar-border bg-transparent px-3 pr-9 text-sm text-sidebar-foreground outline-none transition-colors hover:bg-sidebar-accent/50 focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              title={activeProject?.name || "Workspace"}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <ChevronDown
              className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sidebar-foreground/70"
              aria-hidden="true"
            />
          </div>

          <CreateProjectDialog idPrefix={idPrefix}>
            <button
              type="button"
              data-testid={`button-new-project-${idPrefix}`}
              aria-label="New project"
              title="New project"
              className="grid h-10 w-9 shrink-0 place-items-center rounded-lg text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
            </button>
          </CreateProjectDialog>

          {activeProject && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button
                  type="button"
                  data-testid={`button-delete-project-${idPrefix}`}
                  aria-label={`Delete project ${activeProject.name}`}
                  title={`Delete project ${activeProject.name}`}
                  className="grid h-10 w-9 shrink-0 place-items-center rounded-lg text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent/60 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                >
                  <Trash2
                    className="h-4 w-4"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent className="rounded-2xl border-border/60 surface p-0 sm:max-w-[420px] shadow-lift">
                <div className="p-6">
                  <AlertDialogHeader>
                    <AlertDialogTitle className="flex items-center gap-2 text-xl font-semibold tracking-tight text-destructive">
                      <AlertTriangle className="h-5 w-5" />
                      Delete project?
                    </AlertDialogTitle>
                    <AlertDialogDescription className="mt-2 text-sm">
                      “{activeProject.name}” and all of its chats, board
                      tasks, and captured knowledge will be removed from every
                      synced device. You will have a few seconds to undo.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter className="mt-8">
                    <AlertDialogCancel className="rounded-md border-border/60 font-medium hover:bg-accent hover:text-accent-foreground">
                      Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => deleteProject(activeProject.id)}
                      data-testid={`button-confirm-delete-project-${idPrefix}`}
                      className="rounded-md bg-destructive font-medium text-destructive-foreground shadow-soft hover:bg-destructive/90"
                    >
                      Delete project
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </div>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>

        {activeProject && (
          <ProjectSopsDialog projectId={activeProject.id}>
            <button
              type="button"
              data-testid={`button-project-sops-${idPrefix}`}
              className="mt-1 flex min-h-9 w-full items-center gap-2 rounded-lg px-3 text-sm text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              aria-label="Manage project SOPs"
            >
              <ScrollText className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
              Project SOPs
            </button>
          </ProjectSopsDialog>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <h2 className="shrink-0 px-4 pb-1.5 pt-3 text-xs font-medium text-sidebar-foreground/70">
          Chats
        </h2>
        <div
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
          data-testid={`list-conversations-${idPrefix}`}
        >
          {sortedProjectConversations.length > 0 ? (
            <div className="grid gap-0.5">
              {sortedProjectConversations.map((conversation) => (
                <button
                  type="button"
                  key={conversation.id}
                  onClick={() => handleConversationSelect(conversation.id)}
                  data-testid={`button-conversation-${conversation.id}`}
                  className={cn(
                    "min-h-9 truncate rounded-lg px-3 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                    state.activeConversationId === conversation.id
                      ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                  )}
                  aria-current={
                    state.activeConversationId === conversation.id
                      ? "page"
                      : undefined
                  }
                >
                  {conversation.title || "New chat"}
                </button>
              ))}
            </div>
          ) : (
            <p className="px-3 py-2 text-sm text-sidebar-foreground/70">
              No chats yet
            </p>
          )}

          {unfiledConversations.length > 0 && (
            <section
              className="mt-4 border-t border-sidebar-border/70 pt-3"
              aria-label="Unfiled chats"
              data-testid={`section-unfiled-${idPrefix}`}
            >
              <h3 className="px-2 text-xs font-medium text-sidebar-foreground/70">
                Unfiled
              </h3>
              <p className="px-2 pb-1.5 pt-0.5 text-xs text-sidebar-foreground/50">
                Chats saved without a project
              </p>
              <div className="grid gap-0.5">
                {unfiledConversations.map((conversation) => {
                  const isFiling = filingConversationId === conversation.id;
                  const fileOptionsId = `${idPrefix}-file-options-${conversation.id}`;
                  return (
                    <div key={conversation.id}>
                      <div className="flex items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() =>
                            handleConversationSelect(conversation.id)
                          }
                          data-testid={`button-unfiled-conversation-${conversation.id}`}
                          className={cn(
                            "min-h-9 min-w-0 flex-1 truncate rounded-lg px-3 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                            state.activeConversationId === conversation.id
                              ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                              : "text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                          )}
                          aria-current={
                            state.activeConversationId === conversation.id
                              ? "page"
                              : undefined
                          }
                        >
                          {conversation.title || "New chat"}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setFilingConversationId(
                              isFiling ? null : conversation.id,
                            )
                          }
                          data-testid={`button-file-conversation-${conversation.id}`}
                          aria-label={`File "${conversation.title || "New chat"}" into a project`}
                          title="File into a project"
                          aria-expanded={isFiling}
                          aria-controls={isFiling ? fileOptionsId : undefined}
                          className={cn(
                            "grid h-9 w-8 shrink-0 place-items-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                            isFiling
                              ? "bg-sidebar-accent text-sidebar-accent-foreground"
                              : "text-sidebar-foreground/60 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                          )}
                        >
                          <FolderInput
                            className="h-4 w-4"
                            strokeWidth={1.75}
                            aria-hidden="true"
                          />
                        </button>
                      </div>
                      {isFiling && (
                        <div
                          id={fileOptionsId}
                          role="group"
                          aria-label={`File "${conversation.title || "New chat"}" into project`}
                          className="mb-1 ml-3 mt-0.5 border-l border-sidebar-border/70 pl-2"
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.stopPropagation();
                              setFilingConversationId(null);
                            }
                          }}
                        >
                          <p className="px-3 pb-0.5 pt-1 text-[11px] uppercase tracking-wide text-sidebar-foreground/50">
                            File into
                          </p>
                          {projects.map((project) => (
                            <button
                              key={project.id}
                              type="button"
                              data-testid={`button-file-into-${project.id}`}
                              onClick={() =>
                                handleFileConversation(
                                  conversation.id,
                                  project.id,
                                )
                              }
                              className="block min-h-8 w-full truncate rounded-lg px-3 text-left text-sm text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                            >
                              {project.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>

        <nav
          className="shrink-0 border-t border-sidebar-border/70 px-2 py-2"
          aria-label="Workspace navigation"
        >
          <div className="grid gap-0.5">
            <NavItem
              href="/workspace/chat"
              icon={MessageSquare}
              label="Chat"
              isActive={!!isChat}
              shortcut="Alt+1"
              onNavigate={() => handleDrawerOpenChange(false)}
            />
            <NavItem
              href="/workspace/feed"
              icon={Activity}
              label="Feed"
              isActive={!!isFeedActive}
              shortcut="Alt+2"
              onNavigate={() => handleDrawerOpenChange(false)}
            />
            <NavItem
              href="/workspace/brain"
              icon={BrainCircuit}
              label="Brain"
              isActive={!!isBrain}
              shortcut="Alt+3"
              onNavigate={() => handleDrawerOpenChange(false)}
            />
            <NavItem
              href="/workspace/tasks"
              icon={CheckSquare}
              label="To-Do"
              isActive={!!isTasks}
              shortcut="Alt+4"
              onNavigate={() => handleDrawerOpenChange(false)}
            />
            <NavItem
              href="/workspace/apps"
              icon={Hexagon}
              label="Apps"
              isActive={!!isApps}
              shortcut="Alt+5"
              onNavigate={() => handleDrawerOpenChange(false)}
            />
            <NavItem
              href="/workspace/templates"
              icon={LayoutTemplate}
              label="Templates"
              isActive={!!isTemplates}
              shortcut="Alt+0"
              onNavigate={() => handleDrawerOpenChange(false)}
            />
            <NavItem
              href="/workspace/sops"
              icon={ScrollText}
              label="SOPs"
              isActive={!!isSops}
              shortcut="Alt+6"
              onNavigate={() => handleDrawerOpenChange(false)}
            />
            <NavItem
              href="/workspace/notifications"
              icon={Bell}
              label="Notifications"
              isActive={!!isNotifications}
              shortcut="Alt+7"
              badge={unreadData?.count}
              onNavigate={() => handleDrawerOpenChange(false)}
            />
            <NavItem
              href="/workspace/company"
              icon={Building2}
              label="Company"
              isActive={!!isCompany}
              shortcut="Alt+8"
              badge={orgInvites.length > 0 ? orgInvites.length : undefined}
              onNavigate={() => handleDrawerOpenChange(false)}
            />
            {identity?.superAdmin === true && (
              <NavItem
                href="/workspace/canon"
                icon={BookMarked}
                label="Canon"
                isActive={!!isCanon}
                shortcut="Alt+9"
                onNavigate={() => handleDrawerOpenChange(false)}
              />
            )}
          </div>
        </nav>
      </div>

      <div className="shrink-0 border-t border-sidebar-border/70 px-3 pt-2 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
        <div
          className="flex min-h-8 items-center gap-2 px-1 text-xs text-sidebar-foreground/75"
          aria-live="polite"
          data-testid={`status-sync-${idPrefix}`}
        >
          {syncStatus === "syncing" ? (
            <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : syncNeedsAttention || syncStatus === "too_large" ? (
            <AlertTriangle className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
          ) : null}
          <span>{syncLabel}</span>
          {syncNeedsAttention && (
            <button
              type="button"
              onClick={retrySync}
              data-testid={`button-retry-sync-${idPrefix}`}
              className="ml-auto rounded-md px-2 py-1 font-medium text-sidebar-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            >
              Retry
            </button>
          )}
        </div>

        <div className="mt-1 flex items-center gap-2">
          <div
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-sidebar-accent text-sm font-semibold text-sidebar-accent-foreground"
            aria-hidden="true"
          >
            {(accountName || accountEmail || "V").charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1 text-sm text-sidebar-foreground/85">
            <div
              className="truncate font-medium text-sidebar-foreground"
              data-testid={`text-account-${idPrefix}`}
            >
              {accountName || accountEmail || "Your account"}
            </div>
            {accountName && accountEmail ? (
              <div
                className="truncate text-xs text-sidebar-foreground/60"
                data-testid={`text-account-email-${idPrefix}`}
              >
                {accountEmail}
              </div>
            ) : null}
          </div>
          <UsageDialog
            trigger={
              <button
                type="button"
                data-testid={`button-usage-${idPrefix}`}
                className="grid h-9 w-9 place-items-center rounded-lg text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                aria-label="Your AI usage"
                title="Your AI usage"
              >
                <BarChart3 className="h-4 w-4" aria-hidden="true" />
              </button>
            }
          />
          <VoicePreferencesDialog
            trigger={
              <button
                type="button"
                data-testid={`button-voice-preferences-${idPrefix}`}
                className="grid h-9 w-9 place-items-center rounded-lg text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                aria-label="Voice mode preferences"
                title="Voice mode preferences"
              >
                <AudioLines className="h-4 w-4" aria-hidden="true" />
              </button>
            }
          />
          <NetworkContributionDialog
            trigger={
              <button
                type="button"
                data-testid={`button-network-contribution-${idPrefix}`}
                className="grid h-9 w-9 place-items-center rounded-lg text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                aria-label="Venom network contribution"
                title="Venom network contribution"
              >
                <Waypoints className="h-4 w-4" aria-hidden="true" />
              </button>
            }
          />
          <button
            type="button"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            data-testid={`button-theme-${idPrefix}`}
            className="grid h-9 w-9 place-items-center rounded-lg text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            aria-label={theme === "dark" ? "Use light mode" : "Use dark mode"}
            title={theme === "dark" ? "Use light mode" : "Use dark mode"}
          >
            {theme === "dark" ? (
              <Sun className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Moon className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            onClick={handleSignOut}
            data-testid={`button-sign-out-${idPrefix}`}
            className="grid h-9 w-9 place-items-center rounded-lg text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-background text-foreground">
      <aside
        className="hidden w-[270px] shrink-0 border-r border-sidebar-border md:flex"
        aria-label="Chat history and workspace"
        data-testid="sidebar-desktop"
      >
        {sidebarBody("desktop")}
      </aside>

      <div className="relative flex h-full min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b border-border bg-background/90 px-2 pt-[env(safe-area-inset-top)] backdrop-blur-xl md:hidden">
          <Sheet open={drawerOpen} onOpenChange={handleDrawerOpenChange}>
            <SheetTrigger asChild>
              <button
                ref={drawerTriggerRef}
                type="button"
                data-testid="button-open-navigation"
                className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Open navigation"
              >
                <Menu className="h-5 w-5" aria-hidden="true" />
              </button>
            </SheetTrigger>
            <SheetContent
              side="left"
              onCloseAutoFocus={(event) => {
                event.preventDefault();
              }}
              className="h-[100dvh] w-[85vw] max-w-[320px] border-r border-sidebar-border bg-sidebar p-0"
              data-testid="drawer-navigation"
            >
              <SheetHeader className="sr-only">
                <SheetTitle>Navigation</SheetTitle>
                <SheetDescription>
                  Chats, projects, and workspace destinations
                </SheetDescription>
              </SheetHeader>
              {sidebarBody("drawer")}
            </SheetContent>
          </Sheet>

          <span
            className="min-w-0 flex-1 truncate text-sm font-medium"
            data-testid="text-active-project"
          >
            {activeProject?.name || "Workspace"}
          </span>

          {syncStatus === "syncing" ? (
            <RefreshCw
              className="h-4 w-4 shrink-0 text-muted-foreground motion-safe:animate-spin"
              aria-label="Syncing"
            />
          ) : syncNeedsAttention || syncStatus === "too_large" ? (
            <button
              type="button"
              onClick={retrySync}
              data-testid="button-retry-sync-header"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`${syncLabel}. Retry sync`}
            >
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : null}

          <button
            type="button"
            onClick={handleNewConversation}
            data-testid="button-new-chat-header"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="New chat"
            title="New chat"
          >
            <Plus className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}
