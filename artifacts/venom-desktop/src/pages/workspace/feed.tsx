import React, { useMemo } from 'react';
import { useVenomWorkspace } from '@/context/venom-workspace';
import { Skeleton } from '@/components/ui/skeleton';
import { Activity, CheckCircle2, MessageSquare, Clock } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { taskStatusForProject } from '@/lib/workspaceState';

type FeedItem = {
  id: string;
  type: 'task' | 'conversation' | 'cluster';
  title: string;
  subtitle: string;
  timestamp: number;
  icon: React.ElementType;
};

export default function FeedPage() {
  const { state } = useVenomWorkspace();

  const feedItems = useMemo(() => {
    if (!state) return [];
    const items: FeedItem[] = [];

    // Synthesize feed from tasks, conversations, and clusters
    state.projects?.forEach(project => {
      project.tasks?.forEach(task => {
        const status = taskStatusForProject(project, task);
        items.push({
          id: `task_${task.id}`,
          type: 'task',
          title: `Task ${status.replace('_', ' ')}`,
          subtitle: task.title,
          timestamp: task.createdAt,
          icon: CheckCircle2,
        });
      });
    });

    state.conversations?.forEach(conv => {
      if (conv.messages?.length) {
        items.push({
          id: `conv_${conv.id}`,
          type: 'conversation',
          title: 'Thread Updated',
          subtitle: conv.title || 'Untitled Thread',
          timestamp: conv.updatedAt,
          icon: MessageSquare,
        });
      }
    });

    state.clusters?.forEach(cluster => {
      if (cluster.lastUpdatedAt) {
        items.push({
          id: `cluster_${cluster.id}`,
          type: 'cluster',
          title: 'Knowledge Synthesized',
          subtitle: cluster.label,
          timestamp: cluster.lastUpdatedAt,
          icon: Activity,
        });
      }
    });

    return items.sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);
  }, [state]);

  if (!state) {
    return (
      <div className="p-8 space-y-6">
        <Skeleton className="w-48 h-8" />
        <Skeleton className="w-full h-24" />
        <Skeleton className="w-full h-24" />
        <Skeleton className="w-full h-24" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-background p-6 md:p-10">
      <div className="max-w-3xl mx-auto">
        <header className="mb-10 flex items-center justify-between border-b border-border pb-4">
          <div>
            <h1 className="text-3xl font-black uppercase tracking-tighter">Activity Feed</h1>
            <p className="font-mono text-sm text-muted-foreground mt-1">Recent changes in your workspace</p>
          </div>
          <div className="flex items-center gap-2 font-mono text-xs bg-muted px-3 py-1 text-foreground border border-border" aria-label="Current workspace activity">
            <span className="w-2 h-2 rounded-full bg-foreground" aria-hidden="true" />
            CURRENT
          </div>
        </header>

        {feedItems.length === 0 ? (
          <div className="text-center py-20 border border-dashed border-border bg-card/50">
            <Activity className="w-10 h-10 mx-auto text-muted-foreground mb-4" />
            <p className="font-mono text-muted-foreground">No recent activity logged.</p>
          </div>
        ) : (
          <div className="relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-border before:via-border before:to-transparent" role="feed">
            {feedItems.map((item, index) => {
              const Icon = item.icon;
              return (
                <article key={`${item.id}_${index}`} className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active mb-8" aria-labelledby={`title-${item.id}`}>
                  
                  {/* Timeline dot */}
                  <div className="flex items-center justify-center w-10 h-10 rounded-none border border-border bg-background shadow shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 z-10" aria-hidden="true">
                    <Icon className="w-4 h-4 text-foreground" />
                  </div>

                  {/* Content Card */}
                  <div className="w-[calc(100%-4rem)] md:w-[calc(50%-2.5rem)] p-4 border border-border bg-card shadow-sm hover:bg-muted/50 transition-colors">
                    <div className="flex items-center justify-between mb-1">
                      <div id={`title-${item.id}`} className="font-bold text-xs uppercase tracking-widest text-muted-foreground">
                        {item.title}
                      </div>
                      <time className="text-[10px] font-mono text-muted-foreground flex items-center gap-1" dateTime={new Date(item.timestamp).toISOString()}>
                        <Clock className="w-3 h-3" aria-hidden="true" />
                        {formatDistanceToNow(item.timestamp, { addSuffix: true })}
                      </time>
                    </div>
                    <div className="text-sm font-medium mt-2 leading-snug">
                      {item.subtitle}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
