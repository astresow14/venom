import React, { useEffect } from 'react';
import { useLocation, Link, useRoute } from 'wouter';
import { Hexagon, MessageSquare, Activity, BrainCircuit, CheckSquare, LogOut, ChevronDown, Plus, RefreshCw, AlertTriangle, User as UserIcon, Moon, Sun } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { useVenomWorkspace } from '@/context/venom-workspace';
import { useClerk, useUser } from '@clerk/react';
import { formatDistanceToNow } from 'date-fns';
import { useTheme } from '@/components/theme-provider';

type NavItemProps = {
  href: string;
  icon: React.ElementType;
  label: string;
  isActive: boolean;
  shortcut: string;
};

function NavItem({ href, icon: Icon, label, isActive, shortcut }: NavItemProps) {
  return (
    <Link href={href} className={`flex items-center gap-3 px-4 py-3 font-mono text-sm tracking-wide border-l-2 transition-colors ${
      isActive 
        ? 'border-foreground bg-accent text-accent-foreground font-bold' 
        : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground'
    }`} aria-label={label} title={`${label} (${shortcut})`}>
      <Icon className="w-5 h-5 shrink-0" />
      <span className="hidden lg:inline-block">{label}</span>
    </Link>
  );
}

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const [, setLocation] = useLocation();
  const [isChat] = useRoute('/workspace/chat');
  const [isFeed] = useRoute('/workspace/feed');
  const [isBrain] = useRoute('/workspace/brain');
  const [isTasks] = useRoute('/workspace/tasks');

  const { signOut } = useClerk();
  const { user } = useUser();
  const { theme, setTheme } = useTheme();

  const {
    state,
    isReady,
    syncStatus,
    lastSyncedAt,
    retrySync,
    refreshWorkspace,
    setActiveProject,
    setActiveConversation,
    createNewConversation
  } = useVenomWorkspace();

  const handleSignOut = () => {
    const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
    void signOut({ redirectUrl: basePath || '/' });
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Mod+N (Ctrl+N or Cmd+N)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        const convId = createNewConversation(state?.activeProjectId || null);
        setActiveConversation(convId);
        setLocation('/workspace/chat');
      }
      
      // Alt+1..4
      if (e.altKey && e.key === '1') { e.preventDefault(); setLocation('/workspace/chat'); }
      if (e.altKey && e.key === '2') { e.preventDefault(); setLocation('/workspace/feed'); }
      if (e.altKey && e.key === '3') { e.preventDefault(); setLocation('/workspace/brain'); }
      if (e.altKey && e.key === '4') { e.preventDefault(); setLocation('/workspace/tasks'); }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setLocation, createNewConversation, setActiveConversation, state?.activeProjectId]);

  if (!isReady || !state) {
    return (
      <div className="flex h-screen bg-background">
        <div className="w-20 lg:w-64 border-r border-border bg-sidebar flex flex-col p-4 gap-4">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
        <div className="flex-1 p-8">
          <Skeleton className="h-full w-full" />
        </div>
      </div>
    );
  }

  const activeProject = state.projects?.find(p => p.id === state.activeProjectId) || state.projects?.[0];
  const projectTasks = activeProject?.tasks || [];
  const projectConvs = state.conversations?.filter(c => c.projectId === activeProject?.id || c.projectId === null) || [];
  const projectClusters = state.clusters?.filter(c => c.projectId === activeProject?.id || c.projectId === null) || [];

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden selection:bg-foreground selection:text-background">
      {/* Left Sidebar */}
      <aside className="w-20 lg:w-64 shrink-0 border-r border-border bg-sidebar flex flex-col z-10 shadow-[4px_0_24px_rgba(0,0,0,0.02)] dark:shadow-none transition-all">
        <div className="p-4 border-b border-border flex items-center justify-center lg:justify-start gap-2 font-bold text-xl tracking-tight">
          <Hexagon className="w-6 h-6 fill-foreground shrink-0" />
          <span className="hidden lg:inline-block">VENOM</span>
        </div>

        {/* Project Selector */}
        <div className="p-2 lg:p-4 border-b border-border">
          <div className="hidden lg:block text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2">Active Context</div>
          <label htmlFor="project-context" className="sr-only">Active project</label>
          <div className="relative">
            <select
              id="project-context"
              value={activeProject?.id ?? ''}
              onChange={(event) => {
                const nextProjectId = event.target.value;
                const nextConversation = state.conversations
                  .filter((conversation) =>
                    conversation.projectId === nextProjectId ||
                    conversation.projectId === null
                  )
                  .sort((a, b) => b.updatedAt - a.updatedAt)[0];
                setActiveProject(nextProjectId);
                setActiveConversation(nextConversation?.id ?? null);
              }}
              className="w-full appearance-none p-2 pr-8 border border-border bg-background hover:bg-muted transition-colors font-bold text-sm truncate focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
              title={activeProject?.name || 'Global Workspace'}
            >
              {state.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <ChevronDown className="w-4 h-4 text-muted-foreground pointer-events-none absolute right-2 top-1/2 -translate-y-1/2" />
          </div>
        </div>

        <nav className="py-4 flex flex-col gap-1 shrink-0">
          <div className="px-4 text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2 mt-2 hidden lg:block">Modules</div>
          <NavItem href="/workspace/chat" icon={MessageSquare} label="CHAT" isActive={!!isChat} shortcut="Alt+1" />
          <NavItem href="/workspace/feed" icon={Activity} label="FEED" isActive={!!isFeed} shortcut="Alt+2" />
          <NavItem href="/workspace/brain" icon={BrainCircuit} label="BRAIN" isActive={!!isBrain} shortcut="Alt+3" />
          <NavItem href="/workspace/tasks" icon={CheckSquare} label="TASKS" isActive={!!isTasks} shortcut="Alt+4" />
        </nav>

        {/* Recent Conversations */}
        <div className="flex-1 overflow-y-auto hidden lg:flex flex-col border-t border-border pt-4">
           <div className="px-4 flex items-center justify-between mb-2">
             <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Recent Threads</span>
             <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => {
                const id = createNewConversation(activeProject?.id || null);
                setActiveConversation(id);
                setLocation('/workspace/chat');
              }} title="New conversation" aria-label="New conversation">
               <Plus className="w-3 h-3" />
             </Button>
           </div>
           <div className="flex flex-col gap-1 px-2">
             {projectConvs.sort((a,b) => b.updatedAt - a.updatedAt).slice(0, 10).map(conv => (
                <button 
                  key={conv.id}
                  onClick={() => {
                    setActiveConversation(conv.id);
                    setLocation('/workspace/chat');
                  }}
                  className={`text-left px-2 py-1.5 text-xs font-mono truncate hover:bg-muted transition-colors ${state.activeConversationId === conv.id ? 'bg-accent text-accent-foreground font-bold' : 'text-muted-foreground'}`}
                >
                  {conv.title || 'Untitled Thread'}
                </button>
             ))}
           </div>
        </div>

        <div className="p-4 border-t border-border">
          <div
            className="mb-3 px-0 lg:px-2 text-[10px] font-mono uppercase text-muted-foreground flex items-center justify-center lg:justify-start gap-2"
            aria-live="polite"
            title={`Workspace sync: ${syncStatus}`}
          >
            {(syncStatus === 'error' || syncStatus === 'offline' || syncStatus === 'too_large') ? (
              <AlertTriangle className="w-3 h-3 text-destructive" />
            ) : (
              <span className="w-2 h-2 bg-foreground rounded-full" aria-hidden="true" />
            )}
            <span className="hidden lg:inline">{syncStatus}</span>
            {(syncStatus === 'error' || syncStatus === 'offline') && (
              <button
                type="button"
                onClick={retrySync}
                className="hidden lg:inline underline underline-offset-2 text-foreground"
              >
                retry
              </button>
            )}
          </div>
          {user && (
            <div className="hidden lg:flex items-center gap-2 mb-4 px-2 overflow-hidden">
               <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center shrink-0 border border-border">
                 <UserIcon className="w-3 h-3" />
               </div>
               <div className="text-xs font-mono truncate text-muted-foreground">{user.primaryEmailAddress?.emailAddress}</div>
            </div>
          )}
          <Button
            variant="ghost"
            className="mb-1 w-full justify-center lg:justify-start text-muted-foreground hover:text-foreground font-mono text-sm rounded-none px-0 lg:px-4"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? 'Use light mode' : 'Use dark mode'}
          >
            {theme === 'dark' ? <Sun className="w-4 h-4 lg:mr-2 shrink-0" /> : <Moon className="w-4 h-4 lg:mr-2 shrink-0" />}
            <span className="hidden lg:inline-block">{theme === 'dark' ? 'LIGHT MODE' : 'DARK MODE'}</span>
          </Button>
          <Button variant="ghost" className="w-full justify-center lg:justify-start text-muted-foreground hover:text-foreground font-mono text-sm rounded-none px-0 lg:px-4" onClick={handleSignOut} title="Disconnect">
            <LogOut className="w-4 h-4 lg:mr-2 shrink-0" />
            <span className="hidden lg:inline-block">DISCONNECT</span>
          </Button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col relative overflow-hidden bg-background">
        <div className="absolute top-0 right-0 w-32 h-32 border-b border-l border-border opacity-20 pointer-events-none" />
        <div className="absolute bottom-0 left-0 w-32 h-32 border-t border-r border-border opacity-20 pointer-events-none" />
        
        {children}
      </main>

      {/* Right Contextual Panel */}
      <aside className="w-64 shrink-0 border-l border-border bg-sidebar hidden xl:flex flex-col z-10">
        <div className="p-4 border-b border-border font-bold text-sm tracking-widest uppercase">
          Telemetry
        </div>
        
        <div className="p-4 border-b border-border space-y-4">
          <div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-1">Context Sync</div>
            <div className="flex items-center gap-2 text-xs font-mono">
              {syncStatus === 'syncing' && <RefreshCw className="w-3 h-3 animate-spin" />}
                {(syncStatus === 'error' || syncStatus === 'offline' || syncStatus === 'too_large') && <AlertTriangle className="w-3 h-3 text-destructive" />}
              {syncStatus === 'synced' && <Hexagon className="w-3 h-3 text-foreground" />}
              <span className="uppercase">{syncStatus}</span>
            </div>
            {lastSyncedAt && (
              <div className="text-[10px] text-muted-foreground font-mono mt-1">
                Last: {formatDistanceToNow(new Date(lastSyncedAt), { addSuffix: true })}
              </div>
            )}
            <div className="flex gap-2 mt-3">
               <Button variant="outline" size="sm" className="h-7 text-[10px] font-mono rounded-none" onClick={refreshWorkspace}>REFRESH</Button>
                {(syncStatus === 'error' || syncStatus === 'offline') && (
                 <Button variant="default" size="sm" className="h-7 text-[10px] font-mono rounded-none" onClick={retrySync}>RETRY</Button>
               )}
            </div>
          </div>
        </div>

        <div className="p-4 border-b border-border space-y-4">
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2">Metrics</div>
          <div className="grid grid-cols-2 gap-2">
             <div className="border border-border p-2 bg-card">
               <div className="text-2xl font-bold">{projectTasks.length}</div>
               <div className="text-[10px] font-mono text-muted-foreground uppercase">Tasks</div>
             </div>
             <div className="border border-border p-2 bg-card">
               <div className="text-2xl font-bold">{projectConvs.length}</div>
               <div className="text-[10px] font-mono text-muted-foreground uppercase">Threads</div>
             </div>
             <div className="border border-border p-2 bg-card col-span-2">
               <div className="text-2xl font-bold">{projectClusters.length}</div>
               <div className="text-[10px] font-mono text-muted-foreground uppercase">Knowledge Nodes</div>
             </div>
          </div>
        </div>

        <div className="flex-1 p-4">
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-4">Command Reference</div>
          <ul className="space-y-2 text-xs font-mono text-muted-foreground">
            <li className="flex justify-between"><span>New Thread</span><kbd className="bg-muted px-1 border border-border">Mod+N</kbd></li>
            <li className="flex justify-between"><span>Go Chat</span><kbd className="bg-muted px-1 border border-border">Alt+1</kbd></li>
            <li className="flex justify-between"><span>Go Feed</span><kbd className="bg-muted px-1 border border-border">Alt+2</kbd></li>
            <li className="flex justify-between"><span>Go Brain</span><kbd className="bg-muted px-1 border border-border">Alt+3</kbd></li>
            <li className="flex justify-between"><span>Go Tasks</span><kbd className="bg-muted px-1 border border-border">Alt+4</kbd></li>
          </ul>
        </div>
        <div className="p-4 border-t border-border">
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2">Appearance</div>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start rounded-none font-mono text-xs"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? <Sun className="w-3 h-3 mr-2" /> : <Moon className="w-3 h-3 mr-2" />}
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </Button>
        </div>
      </aside>

    </div>
  );
}
