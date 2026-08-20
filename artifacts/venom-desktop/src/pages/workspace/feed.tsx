import React, { useMemo } from "react";
import { useVenomWorkspace } from "@/context/venom-workspace";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Combine,
  CheckSquare,
  MessageSquare,
  Clock,
  BrainCircuit,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { taskStatusForProject } from "@/lib/workspaceState";
import { motion, type Variants } from "framer-motion";

type FeedItem = {
  id: string;
  type: "task" | "conversation" | "cluster";
  title: string;
  subtitle: string;
  timestamp: number;
  icon: React.ElementType;
};

const containerVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
    },
  },
};

const itemVariants: Variants = {
  hidden: { x: -20, opacity: 0 },
  visible: {
    x: 0,
    opacity: 1,
    transition: { type: "spring", stiffness: 300, damping: 25 },
  },
};

export default function FeedPage() {
  const { state } = useVenomWorkspace();

  const feedItems = useMemo(() => {
    if (!state) return [];
    const items: FeedItem[] = [];

    state.projects?.forEach((project) => {
      project.tasks?.forEach((task) => {
        const status = taskStatusForProject(project, task);
        items.push({
          id: `task_${task.id}`,
          type: "task",
          title: `Task: ${status.replace("_", " ")}`,
          subtitle: task.title,
          timestamp: task.updatedAt || task.createdAt,
          icon: CheckSquare,
        });
      });
    });

    state.conversations?.forEach((conv) => {
      if (conv.messages?.length) {
        items.push({
          id: `conv_${conv.id}`,
          type: "conversation",
          title: "Neural Thread",
          subtitle: conv.title || "Untitled Sequence",
          timestamp: conv.updatedAt,
          icon: MessageSquare,
        });
      }
    });

    state.clusters?.forEach((cluster) => {
      if (cluster.lastUpdatedAt) {
        items.push({
          id: `cluster_${cluster.id}`,
          type: "cluster",
          title: "Concept Assimilated",
          subtitle: cluster.label,
          timestamp: cluster.lastUpdatedAt,
          icon: BrainCircuit,
        });
      }
    });

    return items.sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);
  }, [state]);

  if (!state) {
    return (
      <div className="p-4 md:p-10 space-y-6 max-w-4xl mx-auto w-full">
        <Skeleton className="w-64 h-12 rounded-none" />
        <Skeleton className="w-full h-32 rounded-none" />
        <Skeleton className="w-full h-32 rounded-none" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-background p-4 md:p-10 relative scroll-smooth">
      <div className="max-w-4xl mx-auto pb-24">
        <header className="mb-12 flex flex-col md:flex-row md:items-end justify-between border-b-2 border-border/50 pb-6 gap-6 sticky top-0 bg-background/90 backdrop-blur-md z-10 pt-4">
          <div>
            <h1 className="text-4xl md:text-5xl font-black uppercase tracking-tighter">
              Feed
            </h1>
            <p className="font-mono text-sm font-bold tracking-widest text-muted-foreground mt-2 uppercase">
              Real-time workspace modifications
            </p>
          </div>
          <div
            className="flex items-center gap-3 font-mono text-[11px] font-bold uppercase tracking-widest bg-foreground px-4 py-2 text-background border border-foreground w-fit"
            aria-label="Current workspace activity"
          >
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full bg-background opacity-40"></span>
              <span className="relative inline-flex h-2 w-2 bg-background"></span>
            </span>
            Live Sync
          </div>
        </header>

        {feedItems.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center py-32 border-2 border-dashed border-border/50 bg-background/30"
          >
            <Combine className="w-12 h-12 mx-auto text-muted-foreground mb-6 opacity-30 animate-pulse" />
            <h3 className="font-black text-2xl mb-2 uppercase tracking-tighter">
              Void Detected
            </h3>
            <p className="font-mono text-muted-foreground text-xs uppercase tracking-widest max-w-sm mx-auto">
              Your project activity will appear here.
            </p>
          </motion.div>
        ) : (
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="visible"
            className="relative before:absolute before:inset-0 before:ml-[1.1rem] md:before:ml-[2.5rem] before:h-full before:w-0.5 before:bg-border/50"
            role="feed"
          >
            {feedItems.map((item, index) => {
              const Icon = item.icon;
              return (
                <motion.article
                  variants={itemVariants}
                  key={`${item.id}_${index}`}
                  className="relative flex items-start gap-4 md:gap-8 group mb-8 md:mb-10"
                  aria-labelledby={`title-${item.id}`}
                >
                  {/* Timeline dot */}
                  <div
                    className="relative flex items-center justify-center w-9 h-9 md:w-12 md:h-12 rounded-none border-2 border-border bg-background text-muted-foreground shrink-0 z-10 group-hover:bg-foreground group-hover:text-background group-hover:border-foreground transition-all duration-300 mt-1"
                    aria-hidden="true"
                  >
                    <Icon className="w-4 h-4 md:w-5 md:h-5" />
                  </div>

                  {/* Content Card */}
                  <div className="flex-1">
                    <div className="p-5 md:p-6 border-l-4 border-border bg-card hover:bg-foreground/5 hover:border-foreground transition-all duration-300 cursor-default">
                      <div className="flex flex-col md:flex-row md:items-center justify-between mb-3 gap-2 md:gap-4">
                        <div
                          id={`title-${item.id}`}
                          className="font-bold text-xs md:text-[11px] uppercase tracking-widest text-muted-foreground flex items-center gap-2"
                        >
                          {item.title}
                        </div>
                        <time
                          className="text-[10px] font-mono font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2 shrink-0 opacity-70"
                          dateTime={new Date(item.timestamp).toISOString()}
                        >
                          <Clock className="w-3 h-3" aria-hidden="true" />
                          {formatDistanceToNow(item.timestamp, {
                            addSuffix: true,
                          })}
                        </time>
                      </div>
                      <div className="text-lg font-black leading-snug text-foreground uppercase tracking-tight">
                        {item.subtitle}
                      </div>
                    </div>
                  </div>
                </motion.article>
              );
            })}
          </motion.div>
        )}
      </div>
    </div>
  );
}
