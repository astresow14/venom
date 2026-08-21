import React, { useEffect, useRef, useState } from "react";
import { useLocation, Link, useRoute } from "wouter";
import {
  Activity,
  AlertTriangle,
  AudioLines,
  Bell,
  BrainCircuit,
  CheckSquare,
  ChevronDown,
  Hexagon,
  LogOut,
  Menu,
  MessageSquare,
  Moon,
  Plus,
  RefreshCw,
  ScrollText,
  SquarePen,
  Sun,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { VenomWordmark } from "@/components/venom-wordmark";
import { useVenomWorkspace } from "@/context/venom-workspace";
import { useClerk, useUser } from "@clerk/react";
import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";
import ProjectSopsDialog from "@/components/workspace/sops/ProjectSopsDialog";
import VoicePreferencesDialog from "@/components/workspace/VoicePreferencesDialog";
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
  const [isSops] = useRoute("/workspace/sops/*?");

  const { signOut } = useClerk();
  const { user } = useUser();
  // Who Venom recognizes this account as: the server identity record is the
  // same one stamped onto captured knowledge. The Clerk client profile fills
  // in while it loads (or when the API is unreachable) so the account row
  // never goes blank.
  const { data: identity } = useGetVenomIdentity({
    query: {
      queryKey: getGetVenomIdentityQueryKey(),
      enabled: Boolean(user),
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
    setActiveProject,
    setActiveConversation,
    createNewConversation,
  } = useVenomWorkspace();

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
        const convId = createNewConversation(state?.activeProjectId || null);
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
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    setLocation,
    createNewConversation,
    setActiveConversation,
    state?.activeProjectId,
  ]);

  useEffect(
    () => () => {
      if (drawerFocusTimerRef.current !== null) {
        window.clearTimeout(drawerFocusTimerRef.current);
      }
    },
    [],
  );

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
  const projectConvs = conversations.filter(
    (c) => c.projectId === activeProject?.id || c.projectId === null,
  );
  const sortedProjectConversations = [...projectConvs].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );

  const navigateTo = (path: string) => {
    setLocation(path);
    handleDrawerOpenChange(false);
  };

  const handleProjectChange = (nextProjectId: string) => {
    const nextConversation = conversations
      .filter(
        (conversation) =>
          conversation.projectId === nextProjectId ||
          conversation.projectId === null,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    setActiveProject(nextProjectId);
    setActiveConversation(nextConversation?.id ?? null);
  };

  const handleNewConversation = () => {
    const id = createNewConversation(activeProject?.id || null);
    setActiveConversation(id);
    navigateTo("/workspace/chat");
  };

  const handleConversationSelect = (conversationId: string) => {
    setActiveConversation(conversationId);
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

      <div className="shrink-0 px-3 pb-2">
        <label htmlFor={`${idPrefix}-project`} className="sr-only">
          Active project
        </label>
        <div className="relative">
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

      <div className="flex min-h-0 flex-1 flex-col">
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
