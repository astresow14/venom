import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { KnowledgeCluster } from '@/context/venom-workspace';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Check,
  Edit2,
  Link as LinkIcon,
  Minus,
  RotateCcw,
  Search,
  Trash2,
  X,
  Zap,
  ZoomIn,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useVenomWorkspace } from '@/context/venom-workspace';

type Camera = { yaw: number; pitch: number; zoom: number };
type Viewport = { width: number; height: number };
type ProjectedCluster = {
  cluster: KnowledgeCluster;
  x: number;
  y: number;
  depth: number;
  scale: number;
  opacity: number;
};

const DEFAULT_CAMERA: Camera = { yaw: -0.42, pitch: 0.24, zoom: 1 };
const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

function stableDepth(cluster: KnowledgeCluster) {
  let hash = 17;
  for (const character of cluster.id) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return (hash % 210) - 105 + Math.sin(cluster.x * 0.06 + cluster.y * 0.04) * 32;
}

function projectCluster(
  cluster: KnowledgeCluster,
  camera: Camera,
  viewport: Viewport,
): ProjectedCluster {
  const worldX = cluster.x * 2.25;
  const worldY = cluster.y * 2.25;
  const worldZ = stableDepth(cluster);
  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);
  const cosPitch = Math.cos(camera.pitch);
  const sinPitch = Math.sin(camera.pitch);
  const afterYawX = worldX * cosYaw + worldZ * sinYaw;
  const afterYawZ = worldZ * cosYaw - worldX * sinYaw;
  const afterPitchY = worldY * cosPitch - afterYawZ * sinPitch;
  const depth = afterYawZ * cosPitch + worldY * sinPitch;
  const perspective = 780 / (780 - depth);
  const scale = clamp(perspective * camera.zoom, 0.58, 1.75);

  return {
    cluster,
    x: viewport.width / 2 + afterYawX * scale,
    y: viewport.height / 2 + afterPitchY * scale,
    depth,
    scale,
    opacity: clamp(0.32 + (depth + 220) / 370, 0.32, 1),
  };
}

function curvePath(from: ProjectedCluster, to: ProjectedCluster, index: number) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.max(Math.hypot(dx, dy), 1);
  const bend = ((index % 5) - 2) * 13;
  const controlX = (from.x + to.x) / 2 + (-dy / length) * bend;
  const controlY = (from.y + to.y) / 2 + (dx / length) * bend;
  return `M ${from.x} ${from.y} Q ${controlX} ${controlY} ${to.x} ${to.y}`;
}

export default function BrainPage() {
  const {
    state,
    renameKnowledgeCluster,
    deleteKnowledgeCluster,
    mergeKnowledgeClusters,
  } = useVenomWorkspace();
  const [search, setSearch] = useState('');
  const [selectedCluster, setSelectedCluster] =
    useState<KnowledgeCluster | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editLabel, setEditLabel] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState('');
  const [camera, setCamera] = useState<Camera>(DEFAULT_CAMERA);
  const [viewport, setViewport] = useState<Viewport>({ width: 900, height: 620 });
  const canvasRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef(camera);
  const dragRef = useRef<{ x: number; y: number; camera: Camera } | null>(null);
  const didDragRef = useRef(false);

  useEffect(() => {
    cameraRef.current = camera;
  }, [camera]);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const updateViewport = () =>
      setViewport({
        width: Math.max(element.clientWidth, 320),
        height: Math.max(element.clientHeight, 420),
      });
    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const clusters = useMemo(() => {
    if (!state?.clusters) return [];
    return state.clusters.filter(
      (cluster) =>
        cluster.projectId === state.activeProjectId || cluster.projectId === null,
    );
  }, [state]);

  const links = useMemo(() => {
    const visibleIds = new Set(clusters.map((cluster) => cluster.id));
    const unique = new Map<string, { sourceId: string; targetId: string }>();
    for (const source of clusters) {
      for (const targetId of source.links ?? []) {
        if (!visibleIds.has(targetId)) continue;
        const key = [source.id, targetId].sort().join('-');
        unique.set(key, { sourceId: source.id, targetId });
      }
    }
    return [...unique.entries()].map(([key, link]) => ({ ...link, key }));
  }, [clusters]);

  const projectedClusters = useMemo(
    () =>
      clusters
        .map((cluster) => projectCluster(cluster, camera, viewport))
        .sort((left, right) => left.depth - right.depth),
    [camera, clusters, viewport],
  );
  const projectedById = useMemo(
    () => new Map(projectedClusters.map((node) => [node.cluster.id, node])),
    [projectedClusters],
  );

  const handleSelectNode = (cluster: KnowledgeCluster) => {
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
    if (!selectedCluster) return;
    deleteKnowledgeCluster(selectedCluster.id);
    setSelectedCluster(null);
    setShowDeleteConfirm(false);
  };

  const updateZoom = (amount: number) =>
    setCamera((current) => ({
      ...current,
      zoom: clamp(current.zoom + amount, 0.62, 1.6),
    }));
  const resetView = () => setCamera(DEFAULT_CAMERA);

  if (!state) {
    return <div className="p-8"><Skeleton className="w-full h-[600px]" /></div>;
  }

  if (clusters.length === 0) {
    return (
      <div className="flex flex-col h-full bg-background relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 p-6 z-20">
          <h1 className="text-3xl font-black uppercase tracking-tighter text-foreground bg-background px-2 py-1 inline-block">Brain Map</h1>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-6">
          <Zap className="w-12 h-12 mb-4 opacity-50" />
          <p className="font-mono text-center max-w-sm">No knowledge has been saved for this project yet. Chat with Venom to begin building context.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background relative overflow-hidden">
      <header className="absolute top-0 left-0 right-0 p-6 flex flex-col md:flex-row md:items-center justify-between z-20 pointer-events-none gap-4">
        <div className="pointer-events-auto">
          <h1 className="text-3xl font-black uppercase tracking-tighter text-foreground bg-background px-2 py-1 inline-block">Brain Map</h1>
          <div className="flex items-center gap-2 mt-2 font-mono text-xs w-fit">
            <span className="bg-foreground text-background px-2 py-1 font-bold">{clusters.length} NODES</span>
            <span className="bg-muted text-foreground px-2 py-1 border border-border">{links.length} EDGES</span>
          </div>
        </div>
        <div className="pointer-events-auto w-full md:w-64">
          <label htmlFor="search-brain" className="sr-only">Search knowledge</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
            <Input
              id="search-brain"
              placeholder="Search concepts..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-9 rounded-none border-foreground bg-background font-mono focus-visible:ring-1 focus-visible:ring-foreground"
            />
          </div>
        </div>
      </header>

      <main
        ref={canvasRef}
        className="flex-1 bg-card relative overflow-hidden touch-none select-none cursor-grab active:cursor-grabbing"
        aria-label="Knowledge map. Drag to orbit, use the zoom controls or mouse wheel to change depth."
        role="region"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          if ((event.target as HTMLElement).closest('[data-camera-control]')) return;
          if (event.target === event.currentTarget) {
            event.currentTarget.setPointerCapture(event.pointerId);
          }
          dragRef.current = { x: event.clientX, y: event.clientY, camera: cameraRef.current };
          didDragRef.current = false;
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag) return;
          const dx = event.clientX - drag.x;
          const dy = event.clientY - drag.y;
          if (Math.hypot(dx, dy) > 4) didDragRef.current = true;
          setCamera({
            ...drag.camera,
            yaw: drag.camera.yaw + dx * 0.009,
            pitch: clamp(drag.camera.pitch - dy * 0.007, -0.82, 0.82),
          });
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          dragRef.current = null;
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        onPointerLeave={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
            dragRef.current = null;
          }
        }}
        onWheel={(event) => {
          event.preventDefault();
          updateZoom(event.deltaY > 0 ? -0.08 : 0.08);
        }}
      >
        <div className="absolute inset-0 pointer-events-none opacity-45 [background-image:radial-gradient(circle_at_center,rgba(255,255,255,0.12),transparent_40%)]" />
        <div className="absolute left-1/2 top-1/2 w-44 h-44 -translate-x-1/2 -translate-y-1/2 rounded-[42%] border border-foreground/40 bg-foreground/[0.045] shadow-[0_0_90px_rgba(255,255,255,0.12)] pointer-events-none">
          <div className="absolute inset-7 rounded-[48%] border border-foreground/20 -rotate-12" />
          <div className="absolute inset-12 rounded-[48%] border border-foreground/30 rotate-45" />
        </div>

        <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible" aria-hidden="true">
          {links.map((link, index) => {
            const from = projectedById.get(link.sourceId);
            const to = projectedById.get(link.targetId);
            if (!from || !to) return null;
            const depth = (from.depth + to.depth) / 2;
            return (
              <path
                key={link.key}
                d={curvePath(from, to, index)}
                fill="none"
                stroke="currentColor"
                strokeWidth={clamp(1 + (depth + 160) / 250, 0.55, 1.8)}
                strokeOpacity={clamp(0.14 + (depth + 180) / 430, 0.14, 0.66)}
                className="text-foreground"
              />
            );
          })}
        </svg>

        {projectedClusters.map((node, index) => {
          const isSelected = selectedCluster?.id === node.cluster.id;
          const isFiltered =
            Boolean(search) &&
            !node.cluster.label.toLowerCase().includes(search.toLowerCase());
          const nodeSize = Math.round((15 + node.cluster.strength * 7) * node.scale);
          return (
            <button
              key={node.cluster.id}
              type="button"
              onClick={(event) => {
                if (didDragRef.current) {
                  event.preventDefault();
                  return;
                }
                handleSelectNode(node.cluster);
              }}
              className={cn(
                'absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-1 transition-[opacity,filter] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                isFiltered ? 'opacity-20' : 'hover:opacity-100',
              )}
              style={{
                left: node.x,
                top: node.y,
                zIndex: Math.round(1000 + node.depth + (isSelected ? 300 : 0)),
                opacity: isFiltered ? 0.2 : node.opacity,
              }}
              aria-pressed={isSelected}
              aria-label={`Node: ${node.cluster.label}. Depth ${node.depth > 0 ? 'foreground' : 'background'}.`}
            >
              <span
                className={cn(
                  'border rotate-45 flex items-center justify-center transition-transform group-hover:scale-125',
                  isSelected
                    ? 'bg-foreground border-foreground ring-2 ring-background'
                    : 'bg-background/95 border-foreground shadow-[0_0_14px_rgba(255,255,255,0.18)]',
                )}
                style={{ width: nodeSize, height: nodeSize }}
                aria-hidden="true"
              >
                {node.cluster.category === 'tactical' && (
                  <Zap className="-rotate-45" style={{ width: nodeSize * 0.45, height: nodeSize * 0.45 }} />
                )}
              </span>
              <span
                className={cn(
                  'px-2 py-0.5 text-[10px] font-mono whitespace-nowrap border bg-background/90 backdrop-blur-sm',
                  isSelected
                    ? 'border-foreground font-bold text-foreground'
                    : 'border-transparent text-muted-foreground',
                )}
                style={{ fontSize: Math.max(8, Math.min(11, 9 * node.scale)) }}
              >
                {node.cluster.label}
              </span>
            </button>
          );
        })}

        <div data-camera-control className="absolute left-6 bottom-6 z-20 flex items-center gap-1 border border-border bg-background/95 p-1 shadow-lg">
          <Button type="button" variant="ghost" size="icon" className="rounded-none h-8 w-8" onClick={() => updateZoom(-0.12)} aria-label="Zoom out">
            <Minus className="w-4 h-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon" className="rounded-none h-8 w-8" onClick={() => updateZoom(0.12)} aria-label="Zoom in">
            <ZoomIn className="w-4 h-4" />
          </Button>
          <Button type="button" variant="ghost" className="rounded-none h-8 px-2 text-xs font-mono" onClick={resetView}>
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Reset view
          </Button>
        </div>
        <p className="absolute right-6 bottom-7 z-10 text-[10px] font-mono uppercase tracking-wider text-muted-foreground pointer-events-none">
          Drag to orbit · scroll to zoom
        </p>
      </main>

      {selectedCluster && (
        <aside
          className="absolute right-0 top-0 bottom-0 w-80 md:right-6 md:top-24 md:bottom-auto bg-background border-l md:border border-foreground shadow-2xl z-30 p-6 flex flex-col overflow-y-auto animate-in slide-in-from-right-4 fade-in"
          aria-labelledby="detail-pane-title"
        >
          <div className="flex items-center justify-between mb-4 border-b border-border pb-2">
            <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{selectedCluster.category}</div>
            <button onClick={() => setSelectedCluster(null)} className="text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground" aria-label="Close details">
              <X className="w-4 h-4" />
            </button>
          </div>
          {isEditing ? (
            <div className="mb-4 space-y-2">
              <label htmlFor="edit-node-label" className="sr-only">Edit Node Label</label>
              <Input id="edit-node-label" value={editLabel} onChange={(event) => setEditLabel(event.target.value)} className="font-bold text-lg rounded-none border-foreground h-10 px-2" autoFocus />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleRename} className="rounded-none font-mono text-xs flex-1"><Check className="w-3 h-3 mr-1" /> Save</Button>
                <Button size="sm" variant="outline" onClick={() => setIsEditing(false)} className="rounded-none font-mono text-xs flex-1"><X className="w-3 h-3 mr-1" /> Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="mb-4 group">
              <h2 id="detail-pane-title" className="font-bold text-xl mb-1 flex items-start justify-between">
                <span className="break-words pr-2">{selectedCluster.label}</span>
                <button onClick={() => setIsEditing(true)} className="text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity focus-visible:opacity-100" aria-label="Edit label">
                  <Edit2 className="w-4 h-4 shrink-0" />
                </button>
              </h2>
            </div>
          )}
          <p className="text-sm leading-relaxed mb-6">{selectedCluster.summary}</p>
          <div className="space-y-6 flex-1">
            <div>
              <div className="font-mono text-xs uppercase tracking-widest mb-2 border-b border-border pb-1">Mentions</div>
              <div className="text-2xl font-mono">{selectedCluster.mentionCount}</div>
            </div>
            {selectedCluster.links?.length > 0 && (
              <div>
                <div className="font-mono text-xs uppercase tracking-widest mb-2 border-b border-border pb-1">Connected</div>
                <div className="flex flex-wrap gap-2">
                  {selectedCluster.links.map((id) => {
                    const linked = clusters.find((cluster) => cluster.id === id);
                    return linked ? (
                      <button key={id} onClick={() => handleSelectNode(linked)} className="text-[10px] font-mono border border-border px-2 py-1 bg-muted hover:bg-foreground hover:text-background transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground">
                        <LinkIcon className="w-2 h-2 inline-block mr-1" />{linked.label}
                      </button>
                    ) : null;
                  })}
                </div>
              </div>
            )}
            {clusters.filter((cluster) => cluster.id !== selectedCluster.id).length > 0 && (
              <div>
                <label htmlFor="merge-target" className="font-mono text-xs uppercase tracking-widest block mb-2 border-b border-border pb-1">Merge into</label>
                <div className="flex gap-2">
                  <select id="merge-target" value={mergeTargetId} onChange={(event) => setMergeTargetId(event.target.value)} className="min-w-0 flex-1 border border-border bg-background px-2 py-1 text-xs font-mono">
                    <option value="">Choose concept</option>
                    {clusters.filter((cluster) => cluster.id !== selectedCluster.id).map((cluster) => <option key={cluster.id} value={cluster.id}>{cluster.label}</option>)}
                  </select>
                  <Button size="sm" variant="outline" disabled={!mergeTargetId} className="rounded-none font-mono text-xs" onClick={() => {
                    if (mergeTargetId && window.confirm(`Merge “${selectedCluster.label}” into the selected concept? This cannot be undone.`)) {
                      mergeKnowledgeClusters(mergeTargetId, selectedCluster.id);
                      setSelectedCluster(clusters.find((cluster) => cluster.id === mergeTargetId) ?? null);
                      setMergeTargetId('');
                    }
                  }}>Merge</Button>
                </div>
              </div>
            )}
          </div>
          <div className="mt-8 pt-4 border-t border-border">
            {showDeleteConfirm ? (
              <div className="space-y-2">
                <p className="text-xs font-mono text-destructive uppercase tracking-widest text-center mb-2">Delete this concept?</p>
                <div className="flex gap-2">
                  <Button variant="destructive" size="sm" onClick={handleDelete} className="rounded-none font-mono text-xs flex-1">Confirm</Button>
                  <Button variant="outline" size="sm" onClick={() => setShowDeleteConfirm(false)} className="rounded-none font-mono text-xs flex-1 border-foreground">Cancel</Button>
                </div>
              </div>
            ) : (
              <Button variant="ghost" size="sm" className="w-full text-destructive hover:text-destructive hover:bg-destructive/10 rounded-none font-mono text-xs uppercase tracking-widest" onClick={() => setShowDeleteConfirm(true)}>
                <Trash2 className="w-3 h-3 mr-2" /> Delete Node
              </Button>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}