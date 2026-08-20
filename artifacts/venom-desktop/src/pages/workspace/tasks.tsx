import React, { useState, useMemo } from 'react';
import { VenomTaskStatus } from '@workspace/api-client-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, CheckCircle2, Circle, Clock, Trash2, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useVenomWorkspace } from '@/context/venom-workspace';

export default function TasksPage() {
  const { state, addTask, updateTaskStatus, deleteTask } = useVenomWorkspace();
  
  const [newTaskTitle, setNewTaskTitle] = useState('');
  
  const activeProjectId = state?.activeProjectId;
  
  const tasks = useMemo(() => {
    if (!state) return [];
    
    let relevantProjects = state.projects || [];
    if (activeProjectId) {
      const active = relevantProjects.find(p => p.id === activeProjectId);
      if (active) relevantProjects = [active];
    }
    
    return relevantProjects.flatMap(p => (p.tasks || []).map(t => ({ ...t, projectId: p.id })));
  }, [state, activeProjectId]);

  const columns: { id: VenomTaskStatus; title: string; icon: React.ElementType }[] = [
    { id: 'todo', title: 'TODO', icon: Circle },
    { id: 'in_progress', title: 'IN PROGRESS', icon: Clock },
    { id: 'done', title: 'DONE', icon: CheckCircle2 }
  ];

  const handleCreateTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaskTitle.trim() || !activeProjectId) return;
    addTask(activeProjectId, newTaskTitle.trim());
    setNewTaskTitle('');
  };

  if (!state) {
    return <div className="p-8"><Skeleton className="w-full h-[600px]" /></div>;
  }

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden p-6 md:p-10">
      <header className="mb-8 flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-border pb-6">
        <div>
          <h1 className="text-3xl font-black uppercase tracking-tighter">Task Board</h1>
          <p className="font-mono text-sm text-muted-foreground mt-1">
            {activeProjectId 
              ? `Project: ${state.projects?.find(p => p.id === activeProjectId)?.name}` 
              : 'Global Workspace'}
          </p>
        </div>
        
        <form onSubmit={handleCreateTask} className="flex items-center w-full md:w-auto relative group">
          {!activeProjectId && (
             <div className="absolute -top-6 left-0 text-[10px] text-destructive font-mono flex items-center">
                <ShieldAlert className="w-3 h-3 mr-1" /> Requires active project context
             </div>
          )}
          <label htmlFor="new-task-input" className="sr-only">New task title</label>
          <Input 
            id="new-task-input"
            placeholder="New task…"
            value={newTaskTitle}
            onChange={(e) => setNewTaskTitle(e.target.value)}
            disabled={!activeProjectId}
            className="w-full md:w-64 rounded-none border-border font-mono rounded-l-sm focus-visible:ring-1 focus-visible:ring-foreground bg-background disabled:bg-muted"
          />
          <Button type="submit" disabled={!activeProjectId || !newTaskTitle.trim()} className="rounded-none font-bold uppercase rounded-r-sm h-10">
            <Plus className="w-4 h-4 mr-1" /> Add
          </Button>
        </form>
      </header>

      <div className="flex-1 flex flex-col md:flex-row gap-6 overflow-auto">
        {columns.map(col => {
          const colTasks = tasks.filter(t => t.status === col.id).sort((a, b) => b.createdAt - a.createdAt);
          const Icon = col.icon;
          
          return (
            <div key={col.id} className="flex-1 flex flex-col min-w-[300px] border border-border bg-card/30">
              <div className="p-3 border-b border-border bg-muted/50 flex items-center justify-between">
                <div className="flex items-center gap-2 font-bold text-xs uppercase tracking-widest">
                  <Icon className="w-4 h-4" aria-hidden="true" />
                  <h2>{col.title}</h2>
                </div>
                <div className="font-mono text-[10px] bg-background border border-border px-1.5 py-0.5" aria-label={`${colTasks.length} tasks`}>
                  {colTasks.length}
                </div>
              </div>
              
              <div className="flex-1 overflow-y-auto p-3 space-y-3" role="list">
                {colTasks.map(task => (
                  <div 
                    key={task.id} 
                    className="p-3 bg-card border border-border hover:border-foreground transition-colors group shadow-sm hover:shadow-md focus-within:border-foreground focus-within:ring-1 focus-within:ring-foreground"
                    role="listitem"
                  >
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <p className={cn(
                          "text-sm font-medium leading-snug mb-2 break-words",
                          task.status === 'done' && "text-muted-foreground line-through"
                        )}>
                          {task.title}
                        </p>
                        <div className="flex items-center justify-between mt-2">
                          <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">
                            {new Date(task.createdAt).toLocaleDateString()}
                          </span>
                          
                          {/* Quick Actions */}
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                            {col.id !== 'todo' && (
                              <button 
                                onClick={() => updateTaskStatus(task.projectId, task.id, 'todo')}
                                className="text-[10px] font-mono border border-border px-1.5 py-0.5 hover:bg-foreground hover:text-background transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground"
                                aria-label={`Move "${task.title}" to TODO`}
                              >
                                TODO
                              </button>
                            )}
                            {col.id !== 'in_progress' && (
                              <button 
                                onClick={() => updateTaskStatus(task.projectId, task.id, 'in_progress')}
                                className="text-[10px] font-mono border border-border px-1.5 py-0.5 hover:bg-foreground hover:text-background transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground"
                                aria-label={`Move "${task.title}" to IN PROGRESS`}
                              >
                                DOING
                              </button>
                            )}
                            {col.id !== 'done' && (
                              <button 
                                onClick={() => updateTaskStatus(task.projectId, task.id, 'done')}
                                className="text-[10px] font-mono border border-border px-1.5 py-0.5 hover:bg-foreground hover:text-background transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground"
                                aria-label={`Move "${task.title}" to DONE`}
                              >
                                DONE
                              </button>
                            )}
                            <button 
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Delete “${task.title}”? This cannot be undone.`,
                                  )
                                ) {
                                  deleteTask(task.projectId, task.id);
                                }
                              }}
                              className="text-[10px] font-mono border border-border text-destructive hover:bg-destructive hover:text-background px-1.5 py-0.5 ml-1 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive"
                              aria-label={`Delete "${task.title}"`}
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
                
                {colTasks.length === 0 && (
                  <div className="h-24 flex items-center justify-center border border-dashed border-border bg-card/50 text-muted-foreground font-mono text-xs uppercase tracking-widest">
                    Empty
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
