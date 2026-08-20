import React, { useEffect, useMemo, useRef, useState } from "react";
import type { KnowledgeCluster } from "@/context/venom-workspace";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Check,
  Edit2,
  Link as LinkIcon,
  Minus,
  RotateCcw,
  Search,
  Trash2,
  X,
  ZoomIn,
  Info,
  BrainCircuit,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useVenomWorkspace } from "@/context/venom-workspace";
import { motion, AnimatePresence } from "framer-motion";

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
  return (
    (hash % 210) - 105 + Math.sin(cluster.x * 0.06 + cluster.y * 0.04) * 32
  );
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

function sharpPath(from: ProjectedCluster, to: ProjectedCluster) {
  return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
}

export default function BrainPage() {
  const {
    state,
    renameKnowledgeCluster,
    deleteKnowledgeCluster,
    mergeKnowledgeClusters,
  } = useVenomWorkspace();

  const [search, setSearch] = useState("");
  const [selectedCluster, setSelectedCluster] =
    useState<KnowledgeCluster | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editLabel, setEditLabel] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [camera, setCamera] = useState<Camera>(DEFAULT_CAMERA);
  const [viewport, setViewport] = useState<Viewport>({
    width: 900,
    height: 620,
  });

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
        cluster.projectId === state.activeProjectId ||
        cluster.projectId === null,
    );
  }, [state]);

  const links = useMemo(() => {
    const visibleIds = new Set(clusters.map((cluster) => cluster.id));
    const unique = new Map<string, { sourceId: string; targetId: string }>();
    for (const source of clusters) {
      for (const targetId of source.links ?? []) {
        if (!visibleIds.has(targetId)) continue;
        const key = [source.id, targetId].sort().join("-");
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
    setMergeTargetId("");
    setEditLabel(cluster.label);
  };

  const handleRename = () => {
    if (
      selectedCluster &&
      editLabel.trim() &&
      editLabel !== selectedCluster.label
    ) {
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
    return (
      <div className="p-4 md:p-8">
        <Skeleton className="w-full h-full min-h-[600px] rounded-none bg-foreground/5" />
      </div>
    );
  }

  if (clusters.length === 0) {
    return (
      <div className="flex flex-col h-full bg-background relative overflow-hidden p-6 md:p-10">
        <header className="mb-8 z-20">
          <h1 className="text-4xl md:text-5xl font-black uppercase tracking-tighter">
            Brain Map
          </h1>
        </header>
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground border-2 border-border/30 bg-background/50">
          <BrainCircuit className="w-16 h-16 mb-6 opacity-20 text-foreground animate-pulse" />
          <h2 className="text-2xl font-black mb-2 text-foreground uppercase tracking-tight">
            Structure Absent
          </h2>
          <p className="font-mono text-center max-w-sm text-xs uppercase tracking-widest">
            The entity lacks data. Converse to seed the map.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background relative overflow-hidden">
      <header className="absolute top-0 left-0 right-0 p-4 md:p-8 flex flex-col md:flex-row md:items-start justify-between z-20 pointer-events-none gap-6">
        <div className="pointer-events-auto bg-background/90 backdrop-blur-xl p-4 md:p-5 rounded-none border-l-4 border-foreground shadow-[4px_4px_0_0_hsl(var(--border))]">
          <h1 className="text-3xl md:text-4xl font-black uppercase tracking-tighter leading-none mb-4">
            Brain Map
          </h1>
          <div className="flex items-center gap-3 font-mono text-[11px] font-bold uppercase tracking-widest">
            <span className="bg-foreground text-background px-3 py-1">
              {clusters.length} NODES
            </span>
            <span className="bg-background text-foreground px-3 py-1 border border-foreground/30">
              {links.length} CONNECTIONS
            </span>
          </div>
        </div>

        <div className="pointer-events-auto w-full md:w-80 shadow-[4px_4px_0_0_hsl(var(--border))]">
          <label htmlFor="search-brain" className="sr-only">
            Search map
          </label>
          <div className="relative group">
            <Search
              className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground group-focus-within:text-foreground transition-colors"
              aria-hidden="true"
            />
            <Input
              id="search-brain"
              placeholder="LOCATE CONCEPT..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-11 rounded-none border-foreground/30 bg-background/90 backdrop-blur-xl font-mono text-xs uppercase tracking-widest focus-visible:ring-0 focus-visible:border-foreground h-12"
            />
          </div>
        </div>
      </header>

      <main
        ref={canvasRef}
        className="flex-1 bg-background relative overflow-hidden touch-none select-none cursor-grab active:cursor-grabbing"
        aria-label="Knowledge map. Drag to orbit, use the zoom controls or mouse wheel to change depth."
        role="region"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          if ((event.target as HTMLElement).closest("[data-camera-control]"))
            return;
          if (event.target === event.currentTarget) {
            event.currentTarget.setPointerCapture(event.pointerId);
          }
          dragRef.current = {
            x: event.clientX,
            y: event.clientY,
            camera: cameraRef.current,
          };
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
        {/* Stark geometric grid */}
        <div className="absolute inset-0 pointer-events-none opacity-[0.03] [background-image:linear-gradient(to_right,hsl(var(--foreground))_2px,transparent_2px),linear-gradient(to_bottom,hsl(var(--foreground))_2px,transparent_2px)] [background-size:6rem_6rem] [mask-image:radial-gradient(ellipse_80%_80%_at_50%_50%,#000_10%,transparent_100%)]" />

        {/* Core focus sphere */}
        <div className="absolute left-1/2 top-1/2 w-[400px] h-[400px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-foreground/5 bg-foreground/[0.01] pointer-events-none animate-pulse-slow">
          <div className="absolute inset-10 rounded-full border border-foreground/10 -rotate-45" />
          <div className="absolute inset-20 rounded-full border border-foreground/5 rotate-90" />
        </div>

        <svg
          className="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
          aria-hidden="true"
        >
          {links.map((link) => {
            const from = projectedById.get(link.sourceId);
            const to = projectedById.get(link.targetId);
            if (!from || !to) return null;
            const depth = (from.depth + to.depth) / 2;
            const isSelectedLink =
              selectedCluster?.id === link.sourceId ||
              selectedCluster?.id === link.targetId;
            return (
              <path
                key={link.key}
                d={sharpPath(from, to)}
                fill="none"
                stroke="currentColor"
                strokeWidth={
                  isSelectedLink
                    ? clamp(2 + (depth + 160) / 200, 1.5, 4)
                    : clamp(1 + (depth + 160) / 300, 0.5, 2)
                }
                strokeOpacity={
                  isSelectedLink
                    ? 0.8
                    : clamp(0.05 + (depth + 180) / 600, 0.05, 0.3)
                }
                className={cn(
                  "transition-all duration-500",
                  isSelectedLink ? "text-foreground" : "text-foreground",
                )}
              />
            );
          })}
        </svg>

        {projectedClusters.map((node) => {
          const isSelected = selectedCluster?.id === node.cluster.id;
          const isFiltered =
            Boolean(search) &&
            !node.cluster.label.toLowerCase().includes(search.toLowerCase());
          const nodeSize = Math.round(
            (24 + node.cluster.strength * 12) * node.scale,
          );

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
                "absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-2 transition-[opacity,filter,transform] duration-300 focus-visible:outline-none group",
                isFiltered
                  ? "opacity-5 pointer-events-none"
                  : "hover:opacity-100 hover:z-[9999]",
                isSelected && "scale-110",
              )}
              style={{
                left: node.x,
                top: node.y,
                zIndex: Math.round(1000 + node.depth + (isSelected ? 500 : 0)),
                opacity: isFiltered ? 0.05 : node.opacity,
              }}
              aria-pressed={isSelected}
              aria-label={`Node: ${node.cluster.label}`}
            >
              <span
                className={cn(
                  "flex items-center justify-center transition-all duration-300 group-hover:scale-110 shadow-sm",
                  isSelected
                    ? "bg-foreground text-background rotate-45 scale-125"
                    : "bg-background border-2 border-foreground text-foreground group-hover:bg-foreground group-hover:text-background",
                )}
                style={{ width: nodeSize, height: nodeSize }}
                aria-hidden="true"
              >
                <span
                  className={cn(
                    "font-mono font-bold opacity-100",
                    isSelected ? "-rotate-45" : "",
                  )}
                  style={{ fontSize: Math.max(10, nodeSize * 0.4) }}
                >
                  {node.cluster.strength > 0.8 ? "★" : "X"}
                </span>
              </span>
              <span
                className={cn(
                  "px-3 py-1.5 font-mono whitespace-nowrap uppercase tracking-widest transition-all",
                  isSelected
                    ? "bg-foreground text-background font-bold border border-foreground scale-110 shadow-[4px_4px_0_0_rgba(0,0,0,0.1)]"
                    : "bg-background/90 text-foreground border border-foreground/30 group-hover:border-foreground",
                )}
                style={{ fontSize: Math.max(9, Math.min(12, 10 * node.scale)) }}
              >
                {node.cluster.label}
              </span>
            </button>
          );
        })}

        <div
          data-camera-control
          className="absolute left-6 bottom-6 md:left-8 md:bottom-8 z-20 flex items-center gap-2 bg-background/90 backdrop-blur-md p-2 border-2 border-foreground/20 shadow-sm"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-10 w-10 rounded-none hover:bg-foreground hover:text-background"
            onClick={() => updateZoom(-0.12)}
            aria-label="Zoom out"
          >
            <Minus className="w-5 h-5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-10 w-10 rounded-none hover:bg-foreground hover:text-background"
            onClick={() => updateZoom(0.12)}
            aria-label="Zoom in"
          >
            <ZoomIn className="w-5 h-5" />
          </Button>
          <div className="w-0.5 h-6 bg-foreground/20 mx-2" />
          <Button
            type="button"
            variant="ghost"
            className="h-10 px-4 rounded-none text-xs font-mono font-bold uppercase tracking-widest hover:bg-foreground hover:text-background"
            onClick={resetView}
          >
            <RotateCcw className="w-3.5 h-3.5 mr-2" /> Align
          </Button>
        </div>
      </main>

      {/* Details Panel */}
      <AnimatePresence>
        {selectedCluster && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="hidden md:block absolute inset-0 bg-background/40 backdrop-blur-sm z-20"
              onClick={() => setSelectedCluster(null)}
            />

            <motion.aside
              initial={{ opacity: 0, y: 100, x: 0 }}
              animate={{ opacity: 1, y: 0, x: 0 }}
              exit={{ opacity: 0, y: 50, x: 0, transition: { duration: 0.2 } }}
              className={cn(
                "absolute z-30 bg-background flex flex-col overflow-hidden shadow-[0_0_40px_rgba(0,0,0,0.2)]",
                "left-0 right-0 bottom-0 h-[65vh] border-t-4 border-foreground pb-[env(safe-area-inset-bottom)]", // Mobile
                "md:left-auto md:top-8 md:bottom-8 md:right-8 md:h-auto md:w-[420px] md:border-l-4 md:border-t-0", // Desktop
              )}
              aria-labelledby="detail-pane-title"
            >
              <div
                className="md:hidden flex justify-center pt-4 pb-2 bg-foreground/5 cursor-pointer"
                onClick={() => setSelectedCluster(null)}
              >
                <div className="w-16 h-1.5 bg-foreground/20" />
              </div>

              <div className="flex-1 overflow-y-auto p-6 md:p-8 scroll-smooth">
                <div className="flex items-center justify-between mb-8">
                  <div className="font-mono text-xs font-bold uppercase tracking-widest text-background bg-foreground px-3 py-1">
                    {selectedCluster.category}
                  </div>
                  <button
                    onClick={() => setSelectedCluster(null)}
                    className="text-foreground hover:text-background hover:bg-foreground h-10 w-10 flex items-center justify-center transition-colors border border-transparent hover:border-foreground"
                    aria-label="Close details"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {isEditing ? (
                  <div className="mb-8 space-y-4">
                    <label htmlFor="edit-node-label" className="sr-only">
                      Edit Concept Identifier
                    </label>
                    <Input
                      id="edit-node-label"
                      value={editLabel}
                      onChange={(event) => setEditLabel(event.target.value)}
                      className="font-black text-2xl h-16 rounded-none border-2 border-foreground uppercase tracking-tight"
                      autoFocus
                    />
                    <div className="flex gap-3">
                      <Button
                        size="lg"
                        onClick={handleRename}
                        className="flex-1 rounded-none font-black uppercase tracking-widest"
                      >
                        <Check className="w-4 h-4 mr-2" /> Lock
                      </Button>
                      <Button
                        size="lg"
                        variant="outline"
                        onClick={() => setIsEditing(false)}
                        className="flex-1 rounded-none border-2 font-bold uppercase tracking-widest"
                      >
                        <X className="w-4 h-4 mr-2" /> Abort
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mb-8 group">
                    <h2
                      id="detail-pane-title"
                      className="font-black text-4xl mb-2 flex items-start justify-between leading-none uppercase tracking-tighter"
                    >
                      <span className="break-words pr-4">
                        {selectedCluster.label}
                      </span>
                      <button
                        onClick={() => setIsEditing(true)}
                        className="text-muted-foreground hover:text-background md:opacity-0 md:group-hover:opacity-100 transition-opacity p-2 bg-foreground/10 hover:bg-foreground shrink-0 mt-1"
                        aria-label="Edit label"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                    </h2>
                  </div>
                )}

                <div className="p-5 bg-foreground/5 border-l-4 border-foreground mb-8">
                  <h3 className="font-mono text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-2">
                    <Info className="w-4 h-4" /> Data Profile
                  </h3>
                  <p className="text-[15px] leading-relaxed text-foreground font-medium">
                    {selectedCluster.summary}
                  </p>
                </div>

                <div className="space-y-8">
                  <div className="flex gap-4">
                    <div className="flex-1 p-5 border-2 border-border bg-card text-center">
                      <div className="font-mono text-[10px] font-bold uppercase tracking-widest mb-2 text-muted-foreground">
                        Mentions
                      </div>
                      <div className="text-3xl font-black">
                        {selectedCluster.mentionCount}
                      </div>
                    </div>
                    <div className="flex-1 p-5 border-2 border-border bg-card text-center relative overflow-hidden">
                      <div
                        className="absolute bottom-0 left-0 h-1 bg-foreground transition-all"
                        style={{ width: `${selectedCluster.strength * 100}%` }}
                      />
                      <div className="font-mono text-[10px] font-bold uppercase tracking-widest mb-2 text-muted-foreground">
                        Strength
                      </div>
                      <div className="text-3xl font-black">
                        {(selectedCluster.strength * 100).toFixed(0)}%
                      </div>
                    </div>
                  </div>

                  {selectedCluster.links?.length > 0 && (
                    <div>
                      <div className="font-mono text-xs font-bold uppercase tracking-widest mb-4 border-b-2 border-border/50 pb-2">
                        Synaptic Links
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {selectedCluster.links.map((id) => {
                          const linked = clusters.find(
                            (cluster) => cluster.id === id,
                          );
                          return linked ? (
                            <button
                              key={id}
                              onClick={() => handleSelectNode(linked)}
                              className="text-[11px] font-bold font-mono uppercase tracking-widest border border-foreground/30 px-3 py-2 bg-background hover:bg-foreground hover:text-background transition-colors flex items-center gap-2"
                            >
                              <LinkIcon className="w-3 h-3" />
                              {linked.label}
                            </button>
                          ) : null;
                        })}
                      </div>
                    </div>
                  )}

                  {clusters.filter(
                    (cluster) => cluster.id !== selectedCluster.id,
                  ).length > 0 && (
                    <div className="pt-4">
                      <label
                        htmlFor="merge-target"
                        className="font-mono text-xs font-bold uppercase tracking-widest block mb-4 border-b-2 border-border/50 pb-2"
                      >
                        Assimilate Concept
                      </label>
                      <div className="flex flex-col gap-3">
                        <select
                          id="merge-target"
                          value={mergeTargetId}
                          onChange={(event) =>
                            setMergeTargetId(event.target.value)
                          }
                          className="w-full border-2 border-border bg-background px-4 h-12 text-sm font-bold uppercase appearance-none outline-none focus-visible:border-foreground focus-visible:ring-0"
                        >
                          <option value="">SELECT TARGET...</option>
                          {clusters
                            .filter(
                              (cluster) => cluster.id !== selectedCluster.id,
                            )
                            .map((cluster) => (
                              <option key={cluster.id} value={cluster.id}>
                                {cluster.label}
                              </option>
                            ))}
                        </select>
                        <Button
                          size="lg"
                          disabled={!mergeTargetId}
                          className="rounded-none font-black uppercase tracking-widest h-12 w-full"
                          onClick={() => {
                            if (
                              mergeTargetId &&
                              window.confirm(
                                `Assimilate "${selectedCluster.label}" into the selected concept? Data will be fused irreversibly.`,
                              )
                            ) {
                              mergeKnowledgeClusters(
                                mergeTargetId,
                                selectedCluster.id,
                              );
                              setSelectedCluster(
                                clusters.find(
                                  (cluster) => cluster.id === mergeTargetId,
                                ) ?? null,
                              );
                              setMergeTargetId("");
                            }
                          }}
                        >
                          Assimilate
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="p-6 border-t-2 border-border/50 bg-background shrink-0">
                {showDeleteConfirm ? (
                  <div className="space-y-4">
                    <p className="text-[11px] font-black font-mono text-destructive uppercase tracking-widest text-center">
                      Delete this concept permanently?
                    </p>
                    <div className="flex gap-3">
                      <Button
                        variant="destructive"
                        className="flex-1 rounded-none font-black uppercase tracking-widest h-12"
                        onClick={handleDelete}
                      >
                        Delete
                      </Button>
                      <Button
                        variant="outline"
                        className="flex-1 rounded-none h-12 border-2 font-bold uppercase tracking-widest"
                        onClick={() => setShowDeleteConfirm(false)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    className="w-full text-destructive border-2 border-destructive/30 hover:bg-destructive hover:text-destructive-foreground rounded-none font-black uppercase tracking-widest text-sm h-12 transition-all"
                    onClick={() => setShowDeleteConfirm(true)}
                  >
                    <Trash2 className="w-4 h-4 mr-2" /> Delete Concept
                  </Button>
                )}
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
