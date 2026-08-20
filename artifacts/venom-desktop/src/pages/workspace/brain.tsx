import React, { useMemo, useState, useRef } from 'react';
import { VenomKnowledgeCluster } from '@workspace/api-client-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Search, Zap, Trash2, Edit2, Link as LinkIcon, Check, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useVenomWorkspace } from '@/context/venom-workspace';

export default function BrainPage() {
  const { 
    state,
    renameKnowledgeCluster,
    deleteKnowledgeCluster,
    mergeKnowledgeClusters
  } = useVenomWorkspace();
  
  const [search, setSearch] = useState('');
  const [selectedCluster, setSelectedCluster] = useState<VenomKnowledgeCluster | null>(null);
  
  // Edit mode state
  const [isEditing, setIsEditing] = useState(false);
  const [editLabel, setEditLabel] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState('');

  const canvasRef = useRef<HTMLDivElement>(null);

  const clusters = useMemo(() => {
    if (!state?.clusters) return [];
    return state.clusters.filter(c => c.projectId === state.activeProjectId || c.projectId === null);
  }, [state]);
  
  const links = useMemo(() => {
    const lines: { x1: number, y1: number, x2: number, y2: number, key: string }[] = [];
    const map = new Map(clusters.map(c => [c.id, c]));
    
    clusters.forEach(source => {
      source.links?.forEach(targetId => {
        const target = map.get(targetId);
        if (target) {
          const key = [source.id, target.id].sort().join('-');
          lines.push({
            x1: source.x,
            y1: source.y,
            x2: target.x,
            y2: target.y,
            key
          });
        }
      });
    });
    
    const unique = new Map();
    lines.forEach(l => unique.set(l.key, l));
    return Array.from(unique.values());
  }, [clusters]);

  if (!state) {
    return <div className="p-8"><Skeleton className="w-full h-[600px]" /></div>;
  }

  // Handle empty state gracefully
  if (clusters.length === 0) {
    return (
      <div className="flex flex-col h-full bg-background relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 p-6 flex items-center justify-between z-20 pointer-events-none">
          <div className="pointer-events-auto">
            <h1 className="text-3xl font-black uppercase tracking-tighter mix-blend-difference text-foreground bg-background px-2 py-1">Brain Map</h1>
          </div>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-6">
           <Zap className="w-12 h-12 mb-4 opacity-50 text-muted-foreground" />
           <p className="font-mono text-center max-w-sm">No knowledge has been saved for this project yet. Chat with Venom to begin building context.</p>
        </div>
      </div>
    );
  }

  const minX = Math.min(...clusters.map(c => c.x)) - 100;
  const maxX = Math.max(...clusters.map(c => c.x)) + 100;
  const minY = Math.min(...clusters.map(c => c.y)) - 100;
  const maxY = Math.max(...clusters.map(c => c.y)) + 100;

  const width = Math.max(800, maxX - minX);
  const height = Math.max(600, maxY - minY);

  const filteredClusters = clusters.filter(c => c.label.toLowerCase().includes(search.toLowerCase()));

  const handleSelectNode = (cluster: VenomKnowledgeCluster) => {
    setSelectedCluster(cluster);
    setIsEditing(false);
    setShowDeleteConfirm(false);
    setMergeTargetId('');
    setEditLabel(cluster.label);
  };

  const handleRename = () => {
    if (selectedCluster && editLabel.trim() && editLabel !== selectedCluster.label) {
      renameKnowledgeCluster(selectedCluster.id, editLabel.trim());
      setSelectedCluster({ ...selectedCluster, label: editLabel.trim() });
    }
    setIsEditing(false);
  };

  const handleDelete = () => {
    if (selectedCluster) {
      deleteKnowledgeCluster(selectedCluster.id);
      setSelectedCluster(null);
      setShowDeleteConfirm(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-background relative overflow-hidden">
      
      {/* Header overlay */}
      <div className="absolute top-0 left-0 right-0 p-6 flex flex-col md:flex-row md:items-center justify-between z-20 pointer-events-none gap-4">
        <div className="pointer-events-auto">
          <h1 className="text-3xl font-black uppercase tracking-tighter mix-blend-difference text-foreground bg-background px-2 py-1 inline-block">Brain Map</h1>
          <div className="flex items-center gap-2 mt-2 font-mono text-xs w-fit">
            <span className="bg-foreground text-background px-2 py-1 font-bold">{clusters.length} NODES</span>
            <span className="bg-muted text-foreground px-2 py-1 border border-border">{links.length} EDGES</span>
          </div>
        </div>
        
        <div className="pointer-events-auto w-full md:w-64">
          <div className="relative">
                <label htmlFor="search-brain" className="sr-only">Search knowledge</label>
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
            <Input 
              id="search-brain"
              placeholder="Search concepts..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 rounded-none border-foreground bg-background font-mono focus-visible:ring-1 focus-visible:ring-foreground"
            />
          </div>
        </div>
      </div>

      {/* Main Canvas */}
      <div className="flex-1 overflow-auto bg-card relative cursor-crosshair" ref={canvasRef} aria-label="Knowledge map" role="region">
        <div className="relative" style={{ width: `${width}px`, height: `${height}px`, margin: 'auto' }}>
          
          {/* Edges */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden="true">
            {links.map(l => (
              <line 
                key={l.key}
                x1={l.x1 - minX} 
                y1={l.y1 - minY} 
                x2={l.x2 - minX} 
                y2={l.y2 - minY}
                stroke="currentColor" 
                strokeWidth="1"
                className="text-border opacity-50"
              />
            ))}
          </svg>

          {/* Nodes */}
          {clusters.map(cluster => {
            const isSelected = selectedCluster?.id === cluster.id;
            const isFiltered = search && !cluster.label.toLowerCase().includes(search.toLowerCase());
            
            return (
              <button
                key={cluster.id}
                onClick={() => handleSelectNode(cluster)}
                className={cn(
                  "absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-1 transition-all group z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2",
                  isFiltered ? "opacity-20" : "opacity-100 hover:z-20"
                )}
                style={{ 
                  left: `${cluster.x - minX}px`, 
                  top: `${cluster.y - minY}px` 
                }}
                aria-pressed={isSelected}
                aria-label={`Node: ${cluster.label}`}
              >
                <div className={cn(
                  "w-4 h-4 border transition-transform duration-300 group-hover:scale-150 rotate-45 flex items-center justify-center",
                  isSelected 
                    ? "bg-foreground border-foreground scale-150" 
                    : "bg-background border-foreground shadow-[0_0_10px_rgba(0,0,0,0.1)] dark:shadow-none"
                )} aria-hidden="true">
                  {cluster.category === 'tactical' && <Zap className="w-2 h-2 -rotate-45" />}
                </div>
                <div className={cn(
                  "px-2 py-0.5 text-[10px] font-mono whitespace-nowrap border bg-background backdrop-blur-sm",
                  isSelected ? "border-foreground font-bold" : "border-transparent text-muted-foreground group-hover:border-border group-hover:text-foreground"
                )}>
                  {cluster.label}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Detail Pane */}
      {selectedCluster && (
        <div 
           className="absolute right-0 top-0 bottom-0 w-80 md:right-6 md:top-24 md:bottom-auto bg-background border-l md:border border-foreground shadow-2xl z-30 p-6 flex flex-col overflow-y-auto animate-in slide-in-from-right-4 fade-in"
           role="complementary"
           aria-labelledby="detail-pane-title"
        >
          <div className="flex items-center justify-between mb-4 border-b border-border pb-2">
            <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{selectedCluster.category}</div>
            <button 
              onClick={() => setSelectedCluster(null)} 
              className="text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground"
              aria-label="Close details"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {isEditing ? (
            <div className="mb-4 space-y-2">
               <label htmlFor="edit-node-label" className="sr-only">Edit Node Label</label>
               <Input 
                 id="edit-node-label"
                 value={editLabel} 
                 onChange={e => setEditLabel(e.target.value)} 
                 className="font-bold text-lg rounded-none border-foreground h-10 px-2"
                 autoFocus
               />
               <div className="flex gap-2">
                 <Button size="sm" onClick={handleRename} className="rounded-none font-mono text-xs flex-1"><Check className="w-3 h-3 mr-1" /> Save</Button>
                 <Button size="sm" variant="outline" onClick={() => setIsEditing(false)} className="rounded-none font-mono text-xs flex-1"><X className="w-3 h-3 mr-1" /> Cancel</Button>
               </div>
            </div>
          ) : (
            <div className="mb-4 group">
               <h3 id="detail-pane-title" className="font-bold text-xl mb-1 flex items-start justify-between">
                 <span className="break-words pr-2">{selectedCluster.label}</span>
                 <button onClick={() => setIsEditing(true)} className="text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity focus-visible:opacity-100" aria-label="Edit label">
                   <Edit2 className="w-4 h-4 shrink-0" />
                 </button>
               </h3>
            </div>
          )}

          <p className="text-sm leading-relaxed mb-6">{selectedCluster.summary}</p>
          
          <div className="space-y-6 flex-1">
            <div>
              <div className="font-mono text-xs uppercase tracking-widest mb-2 border-b border-border pb-1">Mentions</div>
              <div className="text-2xl font-mono">{selectedCluster.mentionCount}</div>
            </div>
            
            {selectedCluster.links && selectedCluster.links.length > 0 && (
              <div>
                <div className="font-mono text-xs uppercase tracking-widest mb-2 border-b border-border pb-1">Connected</div>
                <div className="flex flex-wrap gap-2">
                  {selectedCluster.links.map(id => {
                    const l = clusters.find(c => c.id === id);
                    return l ? (
                      <button 
                        key={id} 
                        onClick={() => handleSelectNode(l)}
                        className="text-[10px] font-mono border border-border px-2 py-1 bg-muted hover:bg-foreground hover:text-background transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground"
                      >
                        <LinkIcon className="w-2 h-2 inline-block mr-1" />
                        {l.label}
                      </button>
                    ) : null;
                  })}
                </div>
              </div>
            )}
            {clusters.filter((cluster) => cluster.id !== selectedCluster.id).length > 0 && (
              <div>
                <label htmlFor="merge-target" className="font-mono text-xs uppercase tracking-widest block mb-2 border-b border-border pb-1">
                  Merge into
                </label>
                <div className="flex gap-2">
                  <select
                    id="merge-target"
                    value={mergeTargetId}
                    onChange={(event) => setMergeTargetId(event.target.value)}
                    className="min-w-0 flex-1 border border-border bg-background px-2 py-1 text-xs font-mono"
                  >
                    <option value="">Choose concept</option>
                    {clusters
                      .filter((cluster) => cluster.id !== selectedCluster.id)
                      .map((cluster) => (
                        <option key={cluster.id} value={cluster.id}>
                          {cluster.label}
                        </option>
                      ))}
                  </select>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!mergeTargetId}
                    className="rounded-none font-mono text-xs"
                    onClick={() => {
                      if (
                        mergeTargetId &&
                        window.confirm(
                          `Merge “${selectedCluster.label}” into the selected concept? This cannot be undone.`,
                        )
                      ) {
                        mergeKnowledgeClusters(mergeTargetId, selectedCluster.id);
                        setSelectedCluster(
                          clusters.find((cluster) => cluster.id === mergeTargetId) ?? null,
                        );
                        setMergeTargetId('');
                      }
                    }}
                  >
                    Merge
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="mt-8 pt-4 border-t border-border">
             {showDeleteConfirm ? (
               <div className="space-y-2">
                  <p className="text-xs font-mono text-destructive uppercase tracking-widest text-center mb-2">Delete this concept?</p>
                 <div className="flex gap-2">
                   <Button variant="destructive" size="sm" onClick={handleDelete} className="rounded-none font-mono text-xs flex-1">CONFIRM</Button>
                   <Button variant="outline" size="sm" onClick={() => setShowDeleteConfirm(false)} className="rounded-none font-mono text-xs flex-1 border-foreground">CANCEL</Button>
                 </div>
               </div>
             ) : (
               <Button 
                 variant="ghost" 
                 size="sm" 
                 className="w-full text-destructive hover:text-destructive hover:bg-destructive/10 rounded-none font-mono text-xs uppercase tracking-widest"
                 onClick={() => setShowDeleteConfirm(true)}
               >
                 <Trash2 className="w-3 h-3 mr-2" /> Delete Node
               </Button>
             )}
          </div>
        </div>
      )}
      
    </div>
  );
}
