import React, { useEffect, useRef, useState } from "react";
import { useLocation, Link, useRoute } from "wouter";
import { motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  BrainCircuit,
  CheckSquare,
  ChevronDown,
  Combine,
  LogOut,
  Menu,
  MessageSquare,
  Moon,
  Plus,
  RefreshCw,
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
import { useVenomWorkspace } from "@/context/venom-workspace";
import { useClerk, useUser } from "@clerk/react";
import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";

type NavItemProps = {
  href: string;
  icon: React.ElementType;
  label: string;
  isActive: boolean;
  shortcut: string;
  onNavigate: () => void;
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
}: NavItemProps) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={cn(
        "relative flex min-h-12 items-center gap-4 rounded-none px-4 text-[15px] font-bold uppercase tracking-wider transition-all group outline-none focus-visible:ring-2 focus-visible:ring-ring border-l-2",
        isActive
          ? "text-background bg-foreground border-foreground"
          : "text-sidebar-foreground/70 border-transparent hover:bg-foreground/5 hover:text-sidebar-foreground",
      )}
      aria-current={isActive ? "page" : undefined}
      title={`${label} (${shortcut})`}
    >
      <Icon
        className={cn(
          "h-4 w-4 shrink-0 transition-transform",
          isActive
            ? "scale-110"
            : "group-hover:scale-110 motion-reduce:group-hover:scale-100",
        )}
        strokeWidth={isActive ? 2.5 : 2}
      />
      <span>{label}</span>
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
  const [isBrain] = useRoute("/workspace/brain");
  const [isTasks] = useRoute("/workspace/tasks");

  const { signOut } = useClerk();
  const { user } = useUser();
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

  const handleSignOut = () => {
    const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
    void signOut({ redirectUrl: basePath || "/" });
  };

  const navigateTo = (path: string) => {
    setLocation(path);
    handleDrawerOpenChange(false);
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
      <div className="flex h-[100dvh] flex-col bg-background">
        <div className="flex h-14 items-center gap-3 border-b border-border px-4">
          <Skeleton className="h-8 w-8 rounded-none" />
          <Skeleton className="h-5 w-32" />
        </div>
        <div className="flex-1 p-4 md:p-8">
          <Skeleton className="h-full w-full rounded-none" />
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

  const handleDrawerOpenChange = (open: boolean) => {
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
  };

  const DrawerContent = (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground w-full">
      <SheetHeader className="sr-only">
        <SheetTitle>Navigation Menu</SheetTitle>
        <SheetDescription>
          Access workspace features and settings
        </SheetDescription>
      </SheetHeader>

      <header className="flex shrink-0 items-center justify-between px-5 pb-6 pt-[calc(env(safe-area-inset-top)+1.5rem)] border-b border-border/50">
        <div className="flex items-center gap-3 text-2xl font-black uppercase tracking-tighter group cursor-pointer">
          <div className="relative flex items-center justify-center w-8 h-8 bg-sidebar-foreground text-sidebar overflow-hidden group-hover:scale-105 transition-transform duration-500 ease-out">
            <Combine className="w-4 h-4 relative z-10" />
          </div>
          Venom
        </div>
      </header>

      <div className="px-5 py-4 shrink-0 border-b border-border/50">
        <label htmlFor="drawer-project-context" className="sr-only">
          Active project
        </label>
        <div className="relative">
          <select
            id="drawer-project-context"
            value={activeProject?.id ?? ""}
            onChange={(event) => handleProjectChange(event.target.value)}
            className="h-11 w-full appearance-none rounded-none border border-border/50 bg-background/50 px-4 pr-10 text-sm font-bold uppercase tracking-wider outline-none transition-colors hover:bg-background hover:border-sidebar-foreground/50 focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            title={activeProject?.name || "Global Workspace"}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-sidebar-foreground" />
        </div>
      </div>

      <nav
        className="grid gap-1 px-3 py-4 shrink-0 border-b border-border/50"
        aria-label="Workspace navigation"
      >
        <NavItem
          href="/workspace/chat"
          icon={MessageSquare}
          label="Chats"
          isActive={!!isChat}
          shortcut="Alt+1"
          onNavigate={() => handleDrawerOpenChange(false)}
        />
        <NavItem
          href="/workspace/feed"
          icon={Activity}
          label="Feed"
          isActive={!!isFeed}
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
      </nav>

      <div className="flex min-h-0 flex-1 flex-col pt-4">
        <div className="flex items-center justify-between px-5 pb-3 shrink-0">
          <span className="text-xs font-bold uppercase tracking-widest text-sidebar-foreground/50">
            Recent Threads
          </span>
          <button
            type="button"
            onClick={handleNewConversation}
            className="grid h-7 w-7 place-items-center rounded-none border border-transparent bg-sidebar-foreground/5 text-sidebar-foreground transition-all hover:bg-sidebar-foreground hover:text-sidebar focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            aria-label="New chat"
            title="New chat"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
          {sortedProjectConversations.length > 0 ? (
            <div className="grid gap-1">
              {sortedProjectConversations.map((conversation) => (
                <button
                  type="button"
                  key={conversation.id}
                  onClick={() => handleConversationSelect(conversation.id)}
                  className={cn(
                    "min-h-10 truncate rounded-none px-3 text-left text-[13px] font-mono transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring border-l-2",
                    state.activeConversationId === conversation.id
                      ? "border-sidebar-foreground bg-sidebar-foreground/10 text-sidebar-foreground font-bold"
                      : "border-transparent text-sidebar-foreground/70 hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground hover:border-sidebar-foreground/30",
                  )}
                  aria-current={
                    state.activeConversationId === conversation.id
                      ? "page"
                      : undefined
                  }
                >
                  {conversation.title || "Untitled Thread"}
                </button>
              ))}
            </div>
          ) : (
            <p className="px-3 py-2 text-sm font-mono text-sidebar-foreground/50">
              Silence.
            </p>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-border/50 bg-sidebar px-5 pt-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
        <div
          className="mb-4 flex min-h-9 items-center gap-2 px-1 text-[11px] font-bold uppercase tracking-widest text-sidebar-foreground/60"
          aria-live="polite"
          title={`Workspace sync: ${syncStatus}`}
        >
          {syncStatus === "syncing" ? (
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          ) : syncStatus === "error" ||
            syncStatus === "offline" ||
            syncStatus === "too_large" ? (
            <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
          ) : (
            <span
              className="h-2 w-2 bg-sidebar-foreground animate-pulse"
              aria-hidden="true"
            />
          )}
          <span>{syncStatus.replace("_", " ")}</span>
          {(syncStatus === "error" || syncStatus === "offline") && (
            <button
              type="button"
              onClick={retrySync}
              className="ml-auto underline underline-offset-4 text-sidebar-foreground font-bold"
            >
              Retry
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={handleNewConversation}
          className="mb-5 flex h-12 w-full items-center justify-center gap-2 rounded-none bg-sidebar-foreground px-4 text-sm font-black uppercase tracking-widest text-sidebar transition-transform hover:scale-[1.02] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
        >
          <Plus className="h-4 w-4" />
          New chat
        </button>

        <div className="flex items-center gap-3">
          <div
            className="grid h-10 w-10 shrink-0 place-items-center rounded-none bg-sidebar-foreground text-sidebar text-lg font-black uppercase"
            aria-hidden="true"
          >
            {user?.firstName?.charAt(0) ||
              user?.primaryEmailAddress?.emailAddress?.charAt(0) ||
              "V"}
          </div>
          <div className="min-w-0 flex-1 truncate text-sm font-bold uppercase tracking-wide">
            {user?.firstName ||
              user?.primaryEmailAddress?.emailAddress ||
              "Host"}
          </div>
          <button
            type="button"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="grid h-10 w-10 place-items-center border border-border/50 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-foreground hover:text-sidebar focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            aria-label={theme === "dark" ? "Use light mode" : "Use dark mode"}
            title={theme === "dark" ? "Use light mode" : "Use dark mode"}
          >
            {theme === "dark" ? (
              <Sun className="h-4 w-4" />
            ) : (
              <Moon className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            onClick={handleSignOut}
            className="grid h-10 w-10 place-items-center border border-border/50 text-sidebar-foreground/70 transition-colors hover:bg-destructive hover:text-destructive-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-background text-foreground relative">
      {/* Main Content Area */}
      <div className="flex flex-1 flex-col min-w-0 h-full relative z-10">
        {/* Universal Header */}
        <header className="sticky top-0 z-30 flex h-[calc(4rem+env(safe-area-inset-top))] shrink-0 items-center justify-between border-b-2 border-border/40 bg-background/80 px-4 pt-[env(safe-area-inset-top)] backdrop-blur-xl md:px-6">
          <div className="flex items-center gap-4">
            <Sheet open={drawerOpen} onOpenChange={handleDrawerOpenChange}>
              <SheetTrigger asChild>
                <button
                  ref={drawerTriggerRef}
                  type="button"
                  className="grid h-12 w-12 place-items-center bg-transparent border border-transparent hover:border-foreground/20 text-foreground transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring -ml-3"
                  aria-label="Open navigation"
                >
                  <Menu className="h-6 w-6" />
                </button>
              </SheetTrigger>
              <SheetContent
                side="left"
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                }}
                className="h-[100dvh] w-[85vw] max-w-[340px] border-r border-border p-0 shadow-2xl [&>button]:top-[calc(env(safe-area-inset-top)+1.25rem)] [&>button]:right-5"
              >
                {DrawerContent}
              </SheetContent>
            </Sheet>

            <div className="flex items-center gap-3">
              <Combine className="h-5 w-5 text-foreground hidden sm:block" />
              <span className="text-sm font-black uppercase tracking-widest truncate max-w-[140px] md:max-w-[400px]">
                {activeProject?.name || "Global Workspace"}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3" aria-live="polite">
            {syncStatus === "syncing" ? (
              <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : syncStatus === "error" ||
              syncStatus === "offline" ||
              syncStatus === "too_large" ? (
              <button
                type="button"
                onClick={retrySync}
                className="grid h-9 w-9 place-items-center border border-destructive bg-destructive/10 text-destructive focus-visible:outline-none focus-visible:ring-2"
                aria-label="Retry sync"
              >
                <AlertTriangle className="h-4 w-4" />
              </button>
            ) : (
              <div className="flex items-center gap-2 px-2 py-1 bg-foreground text-background font-mono text-[10px] font-bold uppercase tracking-widest">
                <span
                  className="h-1.5 w-1.5 bg-background animate-pulse"
                  aria-label="Synced"
                />
                Synced
              </div>
            )}
          </div>
        </header>

        {/* Page Content */}
        <main className="relative flex-1 flex flex-col min-h-0 bg-transparent overflow-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}
