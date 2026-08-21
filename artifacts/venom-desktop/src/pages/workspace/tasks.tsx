import React, { useState, useMemo } from "react";
import { VenomTaskStatus } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Plus,
  CheckSquare,
  Circle,
  Clock,
  Trash2,
  ShieldAlert,
  GripVertical,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  availableTaskStatuses,
  taskStatusForProject,
} from "@/lib/workspaceState";
import { useVenomWorkspace } from "@/context/venom-workspace";
import { motion, AnimatePresence } from "framer-motion";

export default function TasksPage() {
  const { state, addTask, updateTaskStatus, deleteTask } = useVenomWorkspace();

  const [newTaskTitle, setNewTaskTitle] = useState("");

  const activeProjectId = state?.activeProjectId;
  const activeProject = state?.projects.find(
    (project) => project.id === activeProjectId,
  );
  const availableStatuses = useMemo(
    () => (activeProject ? availableTaskStatuses(activeProject) : []),
    [activeProject],
  );
  const canAddTask = availableStatuses.includes("todo");

  const tasks = useMemo(() => {
    if (!state) return [];

    let relevantProjects = state.projects || [];
    if (activeProjectId) {
      const active = relevantProjects.find((p) => p.id === activeProjectId);
      if (active) relevantProjects = [active];
    }

    return relevantProjects.flatMap((project) =>
      (project.tasks || []).map((task) => ({
        ...task,
        projectId: project.id,
        status: taskStatusForProject(project, task),
      })),
    );
  }, [state, activeProjectId]);

  const columns: {
    id: VenomTaskStatus;
    title: string;
    icon: React.ElementType;
  }[] = [
    { id: "todo", title: "Pending", icon: Circle },
    {
      id: "in_progress",
      title: "Executing",
      icon: Clock,
    },
    { id: "done", title: "Resolved", icon: CheckSquare },
  ];

  const handleCreateTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaskTitle.trim() || !activeProjectId || !canAddTask) return;
    addTask(activeProjectId, newTaskTitle.trim());
    setNewTaskTitle("");
  };

  if (!state) {
    return (
      <div className="p-4 md:p-8 flex gap-8 overflow-hidden h-full">
        <Skeleton className="w-[340px] h-full rounded-2xl shrink-0" />
        <Skeleton className="w-[340px] h-full rounded-2xl shrink-0 hidden md:block" />
        <Skeleton className="w-[340px] h-full rounded-2xl shrink-0 hidden lg:block" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden p-4 md:p-8 relative">
      <header className="mb-6 flex shrink-0 flex-col justify-between gap-4 border-b border-border pb-5 md:flex-row md:items-end">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">To-Do</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {activeProjectId
              ? `Project: ${state.projects?.find((p) => p.id === activeProjectId)?.name}`
              : "Global workspace"}
          </p>
        </div>

        <form
          onSubmit={handleCreateTask}
          className="flex items-center w-full md:w-auto relative group"
        >
          {(!activeProjectId || !canAddTask) && (
            <div className="absolute -top-8 left-0 text-xs text-destructive font-semibold flex items-center border border-destructive/60 rounded-md px-3 py-1 bg-destructive/10">
              <ShieldAlert className="w-3 h-3 mr-2" />
              {!activeProjectId ? "Select a project to add tasks" : "Tasks unavailable"}
            </div>
          )}
          <label htmlFor="new-task-input" className="sr-only">
            Identify new objective
          </label>
          <div className="relative w-full md:w-80 flex border border-border/60 focus-within:border-foreground transition-colors surface rounded-xl shadow-soft overflow-hidden">
            <Input
              id="new-task-input"
              placeholder="Add a task..."
              value={newTaskTitle}
              onChange={(e) => setNewTaskTitle(e.target.value)}
              disabled={!activeProjectId || !canAddTask}
              className="w-full border-0 font-medium bg-transparent shadow-none focus-visible:ring-0 disabled:opacity-50 h-12 placeholder:text-muted-foreground/60"
              autoComplete="off"
            />
            <Button
              type="submit"
              disabled={!activeProjectId || !canAddTask || !newTaskTitle.trim()}
              size="sm"
              variant="ghost"
              className="h-12 w-12 p-0 rounded-xl font-medium text-muted-foreground hover:text-foreground disabled:hover:bg-transparent"
            >
              <Plus className="w-5 h-5" />
            </Button>
          </div>
        </form>
      </header>

      {/* Kanban Board */}
      <div className="flex-1 flex gap-6 md:gap-8 overflow-x-auto pb-6 snap-x snap-mandatory hide-scrollbar">
        {columns
          .filter((col) => availableStatuses.includes(col.id))
          .map((col) => {
            const colTasks = tasks
              .filter((t) => t.status === col.id)
              .sort((a, b) => b.createdAt - a.createdAt);
            const Icon = col.icon;

            return (
              <div
                key={col.id}
                className="flex flex-col min-w-[320px] w-[85vw] md:w-[340px] shrink-0 snap-center surface rounded-2xl overflow-hidden h-full relative shadow-soft border border-border/60"
              >
                {/* Column header */}
                <div className="p-4 pb-6 flex items-center justify-between sticky top-0 z-10 bg-background/90 backdrop-blur-sm">
                  <div className="flex items-center gap-3 font-semibold text-base">
                    <Icon
                      className="w-5 h-5 text-foreground"
                      aria-hidden="true"
                    />
                    <h2>{col.title}</h2>
                  </div>
                  <div
                    className="text-xs font-medium bg-foreground text-background px-2.5 py-0.5 rounded-full"
                    aria-label={`${colTasks.length} objectives`}
                  >
                    {colTasks.length}
                  </div>
                </div>

                <div
                  className="flex-1 overflow-y-auto px-2 space-y-4"
                  role="list"
                >
                  <AnimatePresence>
                    {colTasks.map((task) => (
                      <motion.div
                        key={task.id}
                        layout
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{
                          opacity: 0,
                          scale: 0.95,
                          transition: { duration: 0.2 },
                        }}
                        className="p-5 bg-card border border-border/60 rounded-xl shadow-soft hover:shadow-lift transition-all duration-300 group focus-within:border-foreground/60 relative overflow-hidden"
                        role="listitem"
                      >
                        {/* Hover outline drawn on an overlay to avoid layout shifts */}
                        <div className="absolute inset-0 border border-transparent group-hover:border-foreground/20 rounded-xl transition-colors pointer-events-none" />

                        <div className="flex flex-col gap-4 relative z-10">
                          <p
                            className={cn(
                              "text-sm font-medium leading-snug break-words",
                              task.status === "done" &&
                                "text-muted-foreground line-through opacity-70",
                            )}
                          >
                            {task.title}
                          </p>

                          <div className="flex items-center justify-between mt-2 pt-4 border-t border-border/60 group-hover:border-foreground/20 transition-colors">
                            <span className="text-xs font-medium text-muted-foreground">
                              {new Date(task.createdAt).toLocaleDateString(
                                undefined,
                                { month: "short", day: "numeric" },
                              )}
                            </span>

                            {/* Quick Actions */}
                            <div className="flex items-center gap-1 opacity-100 md:opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                              {col.id !== "todo" &&
                                availableStatuses.includes("todo") && (
                                  <button
                                    onClick={() =>
                                      updateTaskStatus(
                                        task.projectId,
                                        task.id,
                                        "todo",
                                      )
                                    }
                                    className="flex h-11 w-11 md:h-9 md:w-9 shrink-0 items-center justify-center border border-border/60 rounded-full bg-background shadow-sm transition-colors hover:bg-foreground hover:text-background"
                                    aria-label={`Move "${task.title}" to Pending`}
                                    title="Move to Pending"
                                  >
                                    <Circle className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              {col.id !== "in_progress" &&
                                availableStatuses.includes("in_progress") && (
                                  <button
                                    onClick={() =>
                                      updateTaskStatus(
                                        task.projectId,
                                        task.id,
                                        "in_progress",
                                      )
                                    }
                                    className="flex h-11 w-11 md:h-9 md:w-9 shrink-0 items-center justify-center border border-border/60 rounded-full bg-background shadow-sm transition-colors hover:bg-foreground hover:text-background"
                                    aria-label={`Move "${task.title}" to Executing`}
                                    title="Move to Executing"
                                  >
                                    <Clock className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              {col.id !== "done" &&
                                availableStatuses.includes("done") && (
                                  <button
                                    onClick={() =>
                                      updateTaskStatus(
                                        task.projectId,
                                        task.id,
                                        "done",
                                      )
                                    }
                                    className="flex h-11 w-11 md:h-9 md:w-9 shrink-0 items-center justify-center border border-border/60 rounded-full bg-background shadow-sm transition-colors hover:bg-foreground hover:text-background"
                                    aria-label={`Move "${task.title}" to Resolved`}
                                    title="Move to Resolved"
                                  >
                                    <CheckSquare className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              <div className="w-[1px] h-4 bg-border mx-1" />
                              <button
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      `Delete task: "${task.title}"?`,
                                    )
                                  ) {
                                    deleteTask(task.projectId, task.id);
                                  }
                                }}
                                className="flex h-11 w-11 md:h-9 md:w-9 shrink-0 items-center justify-center border border-border/60 rounded-full bg-background shadow-sm transition-colors hover:border-destructive hover:bg-destructive hover:text-destructive-foreground"
                                aria-label={`Delete "${task.title}"`}
                                title="Delete"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>

                  {colTasks.length === 0 && (
                    <div className="h-24 flex items-center justify-center border border-dashed border-border/60 rounded-xl bg-background/20 text-sm text-muted-foreground font-medium">
                      No tasks yet
                    </div>
                  )}
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}
