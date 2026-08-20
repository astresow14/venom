import React, { useEffect, useState } from "react";
import { useLocation, Link, useRoute } from "wouter";
import {
  Activity,
  AlertTriangle,
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
      className={`flex min-h-11 items-center gap-3 rounded-xl px-3 text-[15px] transition-colors ${
        isActive
          ? "bg-accent text-accent-foreground font-medium"
          : "text-foreground/85 hover:bg-muted hover:text-foreground"
      }`}
      aria-current={isActive ? "page" : undefined}
      title={`${label} (${shortcut})`}
    >
      <Icon className="h-5 w-5 shrink-0" strokeWidth={1.8} />
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
    setDrawerOpen(false);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Mod+N (Ctrl+N or Cmd+N)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        const convId = createNewConversation(state?.activeProjectId || null);
        setActiveConversation(convId);
        setLocation("/workspace/chat");
      }

      // Alt+1..4
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

  if (!isReady || !state) {
    return (
      <div className="flex h-screen flex-col bg-background">
        <div className="flex h-14 items-center gap-3 border-b border-border px-4">
          <Skeleton className="h-9 w-9 rounded-full" />
          <Skeleton className="h-5 w-28" />
        </div>
        <div className="flex-1 p-4 md:p-8">
          <Skeleton className="h-full w-full rounded-2xl" />
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

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground selection:bg-foreground selection:text-background">
      <header className="flex h-14 shrink-0 items-center border-b border-border/70 px-3 md:px-4">
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetTrigger asChild>
            <button
              type="button"
              className="grid h-10 w-10 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Open navigation and chat history"
            >
              <Menu className="h-5 w-5" />
            </button>
          </SheetTrigger>
          <SheetContent
            side="left"
            className="flex w-[min(88vw,21rem)] flex-col gap-0 border-r border-border bg-sidebar p-0 sm:max-w-[21rem] [&>button]:right-4 [&>button]:top-5"
          >
            <SheetHeader className="border-b border-border/70 px-5 py-5 text-left">
              <SheetTitle className="flex items-center gap-2 text-2xl tracking-tight">
                <Hexagon className="h-6 w-6 fill-foreground" />
                Venom
              </SheetTitle>
              <SheetDescription className="sr-only">
                Workspace navigation and recent conversations
              </SheetDescription>
            </SheetHeader>

            <div className="px-3 pb-2 pt-3">
              <label htmlFor="drawer-project-context" className="sr-only">
                Active project
              </label>
              <div className="relative">
                <select
                  id="drawer-project-context"
                  value={activeProject?.id ?? ""}
                  onChange={(event) => handleProjectChange(event.target.value)}
                  className="h-11 w-full appearance-none rounded-xl border-0 bg-muted/70 px-3 pr-9 text-sm font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                  title={activeProject?.name || "Global Workspace"}
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            </div>

            <nav
              className="grid gap-1 px-3 py-2"
              aria-label="Workspace navigation"
            >
              <NavItem
                href="/workspace/chat"
                icon={MessageSquare}
                label="Chats"
                isActive={!!isChat}
                shortcut="Alt+1"
                onNavigate={() => setDrawerOpen(false)}
              />
              <NavItem
                href="/workspace/feed"
                icon={Activity}
                label="Feed"
                isActive={!!isFeed}
                shortcut="Alt+2"
                onNavigate={() => setDrawerOpen(false)}
              />
              <NavItem
                href="/workspace/brain"
                icon={BrainCircuit}
                label="Brain"
                isActive={!!isBrain}
                shortcut="Alt+3"
                onNavigate={() => setDrawerOpen(false)}
              />
              <NavItem
                href="/workspace/tasks"
                icon={CheckSquare}
                label="To-Do"
                isActive={!!isTasks}
                shortcut="Alt+4"
                onNavigate={() => setDrawerOpen(false)}
              />
            </nav>

            <div className="flex min-h-0 flex-1 flex-col pt-3">
              <div className="flex items-center justify-between px-5 pb-2">
                <span className="text-sm text-muted-foreground">Recents</span>
                <button
                  type="button"
                  onClick={handleNewConversation}
                  className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="New chat"
                  title="New chat"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
                {sortedProjectConversations.length > 0 ? (
                  <div className="grid gap-0.5">
                    {sortedProjectConversations.map((conversation) => (
                      <button
                        type="button"
                        key={conversation.id}
                        onClick={() =>
                          handleConversationSelect(conversation.id)
                        }
                        className={`min-h-10 truncate rounded-lg px-3 text-left text-[15px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                          state.activeConversationId === conversation.id
                            ? "bg-accent text-accent-foreground"
                            : "text-foreground/85 hover:bg-muted"
                        }`}
                        aria-current={
                          state.activeConversationId === conversation.id
                            ? "page"
                            : undefined
                        }
                      >
                        {conversation.title || "Untitled chat"}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="px-3 py-2 text-sm text-muted-foreground">
                    No conversations yet
                  </p>
                )}
              </div>
            </div>

            <div className="border-t border-border/70 p-3">
              <div
                className="mb-2 flex min-h-9 items-center gap-2 px-3 text-xs text-muted-foreground"
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
                    className="h-2 w-2 rounded-full bg-foreground"
                    aria-hidden="true"
                  />
                )}
                <span className="capitalize">
                  {syncStatus.replace("_", " ")}
                </span>
                {(syncStatus === "error" || syncStatus === "offline") && (
                  <button
                    type="button"
                    onClick={retrySync}
                    className="ml-auto underline underline-offset-2 text-foreground"
                  >
                    Retry
                  </button>
                )}
              </div>

              <button
                type="button"
                onClick={handleNewConversation}
                className="mb-2 flex h-11 w-full items-center justify-center gap-2 rounded-full bg-foreground px-4 text-sm font-medium text-background transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <Plus className="h-4 w-4" />
                New chat
              </button>

              <div className="flex items-center gap-2">
                <div
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-border bg-muted text-sm font-medium"
                  aria-hidden="true"
                >
                  {user?.firstName?.charAt(0) ||
                    user?.primaryEmailAddress?.emailAddress
                      ?.charAt(0)
                      .toUpperCase() ||
                    "V"}
                </div>
                <div className="min-w-0 flex-1 truncate text-sm">
                  {user?.firstName ||
                    user?.primaryEmailAddress?.emailAddress ||
                    "Account"}
                </div>
                <button
                  type="button"
                  onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                  className="grid h-9 w-9 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={
                    theme === "dark" ? "Use light mode" : "Use dark mode"
                  }
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
                  className="grid h-9 w-9 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="Sign out"
                  title="Sign out"
                >
                  <LogOut className="h-4 w-4" />
                </button>
              </div>
            </div>
          </SheetContent>
        </Sheet>

        <div className="ml-1 flex min-w-0 items-center gap-2">
          <Hexagon className="h-5 w-5 shrink-0 fill-foreground" />
          <span className="hidden text-sm font-semibold sm:inline">Venom</span>
          <span className="hidden text-muted-foreground sm:inline">/</span>
          <span className="truncate text-sm text-muted-foreground">
            {activeProject?.name || "Workspace"}
          </span>
        </div>

        <div
          className="ml-auto flex items-center gap-2"
          aria-live="polite"
          title={`Workspace sync: ${syncStatus}`}
        >
          {syncStatus === "syncing" ? (
            <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          ) : syncStatus === "error" ||
            syncStatus === "offline" ||
            syncStatus === "too_large" ? (
            <button
              type="button"
              onClick={retrySync}
              className="grid h-9 w-9 place-items-center rounded-full text-destructive hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Retry workspace sync"
            >
              <AlertTriangle className="h-4 w-4" />
            </button>
          ) : (
            <span
              className="h-2 w-2 rounded-full bg-foreground"
              aria-label="Workspace synced"
            />
          )}
        </div>
      </header>

      <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        {children}
      </main>
    </div>
  );
}
