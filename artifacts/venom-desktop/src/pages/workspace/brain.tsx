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
  WifiOff,
  X,
  ZoomIn,
  Info,
  BrainCircuit,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useVenomWorkspace } from "@/context/venom-workspace";
import { useSharedWorkspace } from "@/context/shared-workspace";
import {
  ApiError,
  getVenomOntologyConcept,
  searchVenomOntology,
  useGetSharedWorkspaceKnowledge,
  getGetSharedWorkspaceKnowledgeQueryKey,
  type VenomOntologyConceptDetail,
  type VenomOntologySearchResult,
} from "@workspace/api-client-react";
import { useUser } from "@clerk/react";
import { asList } from "@/lib/as-list";
import { IS_UI_TEST } from "@/lib/ui-test";
import {
  knowledgeDisplayText,
  type KnowledgeCitationLookup,
} from "@/lib/messageCitations";
import { motion, AnimatePresence } from "framer-motion";
import {
  deriveSatelliteNodes,
  layoutIslands,
  type SlimeEdge,
  type SlimeNode,
} from "@workspace/slime";
import { SlimeFieldCanvas } from "@/components/workspace/slime-field";

type Camera = { yaw: number; pitch: number; zoom: number };
type Viewport = { width: number; height: number };

/**
 * A search hit whose concept is not in local state. The device keeps at most
 * the newest slice of the ontology, so the concept itself — summary, evidence,
 * neighbors — has to come from the server on demand.
 */
type RemoteConceptView = {
  conceptId: string;
  /** Label from the search row, shown while the full concept loads. */
  label: string;
  projectId: string | null;
  status: "loading" | "ready" | "offline" | "missing";
  detail: VenomOntologyConceptDetail | null;
};
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
  center: { x: number; y: number },
): ProjectedCluster {
  // The constellation has a fixed world spread, so on a narrow viewport the
  // outer nodes and their labels used to land past the edge and get clipped.
  // Shrink the spread to fit the container; 900x620 and larger is unchanged.
  const spread =
    2.25 * clamp(Math.min(viewport.width / 900, viewport.height / 620), 0.42, 1);
  // Cluster coordinates are not centred on the origin, so orbiting around the
  // origin swings the whole map off to one side. Orbit its own centroid.
  const worldX = (cluster.x - center.x) * spread;
  const worldY = (cluster.y - center.y) * spread;
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
    setActiveProject,
    renameKnowledgeCluster,
    deleteKnowledgeCluster,
    mergeKnowledgeClusters,
  } = useVenomWorkspace();
  const { activeWorkspace } = useSharedWorkspace();
  // Shared-workspace knowledge is never in the synced blob: it is read from
  // the membership-checked endpoint and cached only in react-query, where the
  // revocation handler can evict it.
  const isWorkspaceView = Boolean(activeWorkspace);
  const workspaceKnowledgeQuery = useGetSharedWorkspaceKnowledge(
    activeWorkspace?.id ?? "",
    {
      query: {
        queryKey: getGetSharedWorkspaceKnowledgeQueryKey(
          activeWorkspace?.id ?? "",
        ),
        enabled: isWorkspaceView,
      },
    },
  );

  const [search, setSearch] = useState("");
  const [remoteResults, setRemoteResults] = useState<
    VenomOntologySearchResult[] | null
  >(null);
  const [selectedCluster, setSelectedCluster] =
    useState<KnowledgeCluster | null>(null);
  // Concept under the pointer (or keyboard focus). Display-time only: it
  // drives the slime's touch reaction, never data or layout.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [remoteConcept, setRemoteConcept] = useState<RemoteConceptView | null>(
    null,
  );
  const [isEditing, setIsEditing] = useState(false);
  const [editLabel, setEditLabel] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState("");
  const { user } = useUser();
  // Server-side concept detail for the selected node: carries per-evidence
  // attribution (who captured it, legacy rows defaulted to the ontology
  // owner) plus resolved person names.
  const [selectedDetail, setSelectedDetail] =
    useState<VenomOntologyConceptDetail | null>(null);
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

  // A cluster selected in one tier must not linger when the view switches.
  useEffect(() => {
    setSelectedCluster(null);
    setIsEditing(false);
    setShowDeleteConfirm(false);
    setMergeTargetId("");
  }, [activeWorkspace?.id]);

  // Whole-ontology search. The server store is the system of record (it can
  // hold more concepts than a device keeps locally), so ask it first and fall
  // back to the on-device copy when it is unreachable. Browser tests stub the
  // endpoint like every other backend read. The remote search covers the
  // personal store only, so it stays off in workspace view.
  useEffect(() => {
    const term = search.trim();
    if (term.length < 2 || isWorkspaceView) {
      setRemoteResults(null);
      return;
    }
    let stale = false;
    const timer = window.setTimeout(() => {
      searchVenomOntology({ q: term, limit: 20 })
        .then((response) => {
          if (!stale) setRemoteResults(response.results);
        })
        .catch(() => {
          // Offline or the store is unreachable: the local list below still
          // answers from the device copy.
          if (!stale) setRemoteResults(null);
        });
    }, 250);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [search]);

  useEffect(() => {
    const conceptId = selectedCluster?.id ?? null;
    setSelectedDetail(null);
    if (!conceptId || IS_UI_TEST || isWorkspaceView) return;
    let stale = false;
    getVenomOntologyConcept(conceptId)
      .then((detail) => {
        if (!stale) setSelectedDetail(detail);
      })
      .catch(() => {
        // Offline or a local-only concept: the evidence list falls back to
        // the device copy, attributed to the signed-in owner.
      });
    return () => {
      stale = true;
    };
  }, [selectedCluster?.id, isWorkspaceView]);

  // Rows for the detail pane: who said it, in which conversation, and when.
  // Prefers the server detail; otherwise the device copy is shown as the
  // signed-in person's own words.
  const evidenceEntries = useMemo(() => {
    if (!selectedCluster) return [];
    const detail =
      selectedDetail && selectedDetail.concept.id === selectedCluster.id
        ? selectedDetail
        : null;
    const sources = detail?.concept.sources ?? selectedCluster.sources ?? [];
    const people = new Map(
      (detail?.people ?? []).map((person) => [
        person.userId,
        person.displayName,
      ]),
    );
    const selfLabel =
      user?.fullName ||
      user?.firstName ||
      user?.primaryEmailAddress?.emailAddress ||
      "You";
    return sources.slice(0, 8).map((source) => {
      const capturedBy = source.capturedByUserId ?? null;
      const resolved = capturedBy ? people.get(capturedBy) : null;
      const person =
        resolved ??
        (capturedBy === null || capturedBy === user?.id
          ? selfLabel
          : "Workspace member");
      const capturedAt = source.capturedAt ?? source.updatedAt;
      return {
        conversationId: source.conversationId,
        conversationTitle: source.conversationTitle,
        person,
        date: new Date(capturedAt).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        }),
      };
    });
  }, [selectedCluster, selectedDetail, user]);

  const clusters = useMemo(() => {
    if (isWorkspaceView) {
      // Everything the workspace shares, unfiltered by personal projects.
      return asList(workspaceKnowledgeQuery.data?.clusters);
    }
    if (!state?.clusters) return [];
    return state.clusters.filter(
      (cluster) =>
        cluster.projectId === state.activeProjectId ||
        cluster.projectId === null,
    );
  }, [state, isWorkspaceView, workspaceKnowledgeQuery.data]);

  // Display-time layout only: pull same-category concepts into visual
  // islands so the mass reads as clusters. Stored positions and the counts in
  // the pills are untouched — these copies only feed geometry.
  const displayClusters = useMemo(() => layoutIslands(clusters), [clusters]);

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

  const worldCenter = useMemo(() => {
    if (displayClusters.length === 0) return { x: 0, y: 0 };
    const xs = displayClusters.map((cluster) => cluster.x);
    const ys = displayClusters.map((cluster) => cluster.y);
    // Midpoint of the bounding box rather than the mean, so one dense corner
    // cannot drag the whole map off to one side.
    return {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
    };
  }, [displayClusters]);

  const projectedClusters = useMemo(
    () =>
      displayClusters
        .map((cluster) => projectCluster(cluster, camera, viewport, worldCenter))
        .sort((left, right) => left.depth - right.depth),
    [camera, displayClusters, viewport, worldCenter],
  );

  const projectedById = useMemo(
    () => new Map(projectedClusters.map((node) => [node.cluster.id, node])),
    [projectedClusters],
  );

  // The slime reads the same projected geometry as the labels above it, so the
  // goo always sits exactly under the node it belongs to. Nodes filtered out by
  // search are withheld, which makes the mass visibly dissolve as you narrow.
  // Every surviving concept also grows satellite micro-clumps sized from its
  // real substance (sources and mentions) — goo-only, never counted.
  const slimeNodes = useMemo<SlimeNode[]>(() => {
    const term = search.trim().toLowerCase();
    const cores = projectedClusters
      .filter(
        (node) => !term || node.cluster.label.toLowerCase().includes(term),
      )
      .map((node) => ({
        id: node.cluster.id,
        x: node.x,
        y: node.y,
        depth: node.depth,
        radius: (24 + node.cluster.strength * 12) * node.scale * 1.1,
        sourceCount: node.cluster.sources.length,
        mentionCount: node.cluster.mentionCount,
      }));
    return [...cores, ...deriveSatelliteNodes(cores)];
  }, [projectedClusters, search]);

  const slimeEdges = useMemo<SlimeEdge[]>(
    () =>
      links.map((link) => ({
        sourceId: link.sourceId,
        targetId: link.targetId,
      })),
    [links],
  );

  const handleSelectNode = (cluster: KnowledgeCluster) => {
    setSelectedCluster(cluster);
    setRemoteConcept(null);
    setIsEditing(false);
    setShowDeleteConfirm(false);
    setMergeTargetId("");
    setEditLabel(cluster.label);
  };

  // Concepts the map itself cannot show: matches from other projects, plus
  // concepts the server knows but this device has not cached (snapshots keep
  // only the newest slice of the ontology, so even the active project can
  // have knowledge that only exists remotely).
  const crossProjectResults = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (term.length < 2 || !state || isWorkspaceView) return [];
    const localIds = new Set(state.clusters.map((cluster) => cluster.id));
    const seen = new Set<string>();
    const rows: {
      id: string;
      label: string;
      category: string;
      projectId: string | null;
      evidenceCount: number;
    }[] = [];
    for (const result of remoteResults ?? []) {
      if (seen.has(result.id)) continue;
      const onThisMap =
        localIds.has(result.id) &&
        (result.projectId === state.activeProjectId ||
          result.projectId === null);
      if (onThisMap) continue;
      seen.add(result.id);
      rows.push({
        id: result.id,
        label: result.label,
        category: result.category,
        projectId: result.projectId,
        evidenceCount: result.evidenceCount,
      });
    }
    for (const cluster of state.clusters) {
      if (
        cluster.projectId === state.activeProjectId ||
        cluster.projectId === null ||
        seen.has(cluster.id)
      ) {
        continue;
      }
      if (
        !cluster.label.toLowerCase().includes(term) &&
        !cluster.summary.toLowerCase().includes(term)
      ) {
        continue;
      }
      seen.add(cluster.id);
      rows.push({
        id: cluster.id,
        label: cluster.label,
        category: cluster.category,
        projectId: cluster.projectId,
        evidenceCount: cluster.sources.length,
      });
    }
    return rows.slice(0, 12);
  }, [remoteResults, search, state]);

  const projectNameById = useMemo(
    () =>
      new Map((state?.projects ?? []).map((project) => [project.id, project.name])),
    [state],
  );

  // Cluster summaries and evidence excerpts are distilled from conversation
  // text, so they can carry the same inline `[source:...]` markers an
  // assistant answer stores. Resolution mirrors the chat bubble: a live
  // citation reads as its source title, a retired one as an archived
  // reference — the raw marker never reaches the reader.
  const citationLookup = useMemo<KnowledgeCitationLookup>(
    () => ({
      citationsById: new Map(
        (state?.sources ?? [])
          .filter(
            (source) =>
              source.projectId === state?.activeProjectId &&
              source.status === "connected",
          )
          .flatMap((source) =>
            source.citations.map(
              (citation) => [citation.id, citation] as const,
            ),
          ),
      ),
      archivedById: new Map(
        (state?.archivedCitations ?? []).map(
          (archived) => [archived.id, archived] as const,
        ),
      ),
    }),
    [state?.activeProjectId, state?.archivedCitations, state?.sources],
  );

  // The server-backed detail pane can show a concept from another project, so
  // its markers resolve against that project's connected sources instead.
  const remoteConceptProjectId =
    remoteConcept?.projectId ?? state?.activeProjectId ?? null;
  const remoteCitationLookup = useMemo<KnowledgeCitationLookup>(
    () => ({
      citationsById: new Map(
        (state?.sources ?? [])
          .filter(
            (source) =>
              source.projectId === remoteConceptProjectId &&
              source.status === "connected",
          )
          .flatMap((source) =>
            source.citations.map(
              (citation) => [citation.id, citation] as const,
            ),
          ),
      ),
      archivedById: new Map(
        (state?.archivedCitations ?? []).map(
          (archived) => [archived.id, archived] as const,
        ),
      ),
    }),
    [remoteConceptProjectId, state?.archivedCitations, state?.sources],
  );

  const jumpToResult = (row: {
    id: string;
    label: string;
    projectId: string | null;
  }) => {
    const cluster = state?.clusters.find((item) => item.id === row.id);
    setSearch("");
    setRemoteResults(null);
    if (cluster) {
      setRemoteConcept(null);
      setActiveProject(row.projectId);
      handleSelectNode(cluster);
      return;
    }
    // Not cached on this device: open the server-backed detail view instead
    // of switching projects toward a node the map cannot render.
    setSelectedCluster(null);
    setRemoteConcept({
      conceptId: row.id,
      label: row.label,
      projectId: row.projectId,
      status: "loading",
      detail: null,
    });
  };

  // Fetch the opened remote concept. Retry re-enters "loading", which re-runs
  // this effect; closing or replacing the panel makes the in-flight read stale.
  useEffect(() => {
    if (!remoteConcept || remoteConcept.status !== "loading") return;
    const { conceptId } = remoteConcept;
    let stale = false;
    getVenomOntologyConcept(conceptId)
      .then((detail) => {
        if (stale) return;
        setRemoteConcept((current) =>
          current?.conceptId === conceptId && current.status === "loading"
            ? {
                ...current,
                status: "ready",
                detail,
                label: detail.concept.label,
                projectId: detail.concept.projectId,
              }
            : current,
        );
      })
      .catch((error: unknown) => {
        if (stale) return;
        const missing = error instanceof ApiError && error.status === 404;
        setRemoteConcept((current) =>
          current?.conceptId === conceptId && current.status === "loading"
            ? { ...current, status: missing ? "missing" : "offline", detail: null }
            : current,
        );
      });
    return () => {
      stale = true;
    };
  }, [remoteConcept]);

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

  if (!state || (isWorkspaceView && workspaceKnowledgeQuery.isLoading)) {
    return (
      <div className="p-4 md:p-8">
        <Skeleton className="w-full h-full min-h-[600px] rounded-2xl bg-foreground/5" />
      </div>
    );
  }

  if (isWorkspaceView && workspaceKnowledgeQuery.isError) {
    return (
      <div className="flex flex-col h-full bg-background relative overflow-hidden p-6 md:p-10">
        <header className="mb-8 z-20">
          <h1 className="text-2xl font-medium tracking-tight">Brain</h1>
        </header>
        <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-border bg-background/50 text-muted-foreground">
          <BrainCircuit className="w-16 h-16 mb-6 opacity-20 text-foreground" />
          <h2 className="mb-2 text-lg font-medium text-foreground">
            Shared knowledge unavailable
          </h2>
          <p className="max-w-sm text-center text-sm">
            {activeWorkspace?.name
              ? `The knowledge in ${activeWorkspace.name} could not be loaded. Check your connection and try again.`
              : "This workspace could not be loaded."}
          </p>
        </div>
      </div>
    );
  }

  if (clusters.length === 0) {
    return (
      <div className="flex flex-col h-full bg-background relative overflow-hidden p-6 md:p-10">
        <header className="mb-8 z-20">
          <h1 className="text-2xl font-medium tracking-tight">Brain</h1>
          {isWorkspaceView && activeWorkspace && (
            <p className="mt-1 text-sm text-muted-foreground">
              Shared · {activeWorkspace.name}
            </p>
          )}
        </header>
        <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-border bg-background/50 text-muted-foreground">
          <BrainCircuit className="w-16 h-16 mb-6 opacity-20 text-foreground animate-pulse" />
          <h2 className="mb-2 text-lg font-medium text-foreground">
            {isWorkspaceView ? "Nothing shared yet" : "Nothing mapped yet"}
          </h2>
          <p className="max-w-sm text-center text-sm">
            {isWorkspaceView
              ? "Chat while this workspace is selected and Venom will map what your team learns, for every member."
              : "Start a chat and Venom will build a map of what it learns."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background relative overflow-hidden">
      <header className="absolute top-0 left-0 right-0 p-4 md:p-8 flex flex-col md:flex-row md:items-start justify-between z-20 pointer-events-none gap-6">
        <div className="pointer-events-auto rounded-2xl border border-border/60 bg-background/80 p-4 shadow-lift backdrop-blur-xl md:p-5 sheen">
          <h1 className="mb-3 text-2xl font-semibold leading-none tracking-tight">
            Brain
          </h1>
          <div className="flex items-center gap-2 text-[11px] font-medium">
            {isWorkspaceView && activeWorkspace && (
              <span
                className="max-w-[180px] truncate rounded-full border border-foreground/60 px-3 py-1 text-foreground"
                data-testid="badge-workspace-brain"
                title={`Shared knowledge from ${activeWorkspace.name}`}
              >
                Shared · {activeWorkspace.name}
              </span>
            )}
            <span className="rounded-full bg-foreground px-3 py-1 text-background">
              {clusters.length} nodes
            </span>
            <span className="rounded-full border border-border/60 px-3 py-1 text-muted-foreground">
              {links.length} connections
            </span>
          </div>
        </div>

        <div className="pointer-events-auto w-full md:w-80">
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
              placeholder="Search concepts"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-12 rounded-full border-border/60 bg-background/80 pl-11 text-sm shadow-soft backdrop-blur-xl focus-visible:border-foreground/40 focus-visible:ring-0"
            />
          </div>
          {crossProjectResults.length > 0 && (
            <div
              data-testid="brain-cross-project-results"
              className="mt-2 overflow-hidden rounded-2xl border border-border/60 bg-background/90 shadow-lift backdrop-blur-xl"
            >
              <p className="px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground">
                Beyond this map
              </p>
              <ul className="max-h-64 overflow-y-auto pb-2">
                {crossProjectResults.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      data-testid={`brain-search-result-${row.id}`}
                      onClick={() => jumpToResult(row)}
                      className="flex w-full items-baseline justify-between gap-3 px-4 py-2 text-left transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:bg-foreground/10"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {row.label}
                        </span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {projectNameById.get(row.projectId ?? "") ??
                            "Unknown project"}
                          {" · "}
                          {row.category}
                        </span>
                      </span>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {row.evidenceCount}{" "}
                        {row.evidenceCount === 1 ? "source" : "sources"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </header>

      <main
        ref={canvasRef}
        // `isolate` is load-bearing: nodes below carry z-indexes in the
        // thousands to sort by depth, and without a stacking context here they
        // escape and paint over the header, search field and detail pane.
        className="flex-1 bg-background relative isolate overflow-hidden touch-none select-none cursor-grab active:cursor-grabbing"
        aria-label={`Knowledge map with ${clusters.length} nodes. Drag to orbit, use the zoom controls or mouse wheel to change depth. Camera yaw ${camera.yaw.toFixed(3)}, pitch ${camera.pitch.toFixed(3)}, zoom ${camera.zoom.toFixed(3)}.`}
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
        <SlimeFieldCanvas
          nodes={slimeNodes}
          edges={slimeEdges}
          selectedId={selectedCluster?.id ?? null}
          hoveredId={hoveredId}
        />

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
              onPointerEnter={() => setHoveredId(node.cluster.id)}
              onPointerLeave={() =>
                setHoveredId((current) =>
                  current === node.cluster.id ? null : current,
                )
              }
              // Keyboard focus earns the same reaction as the pointer.
              onFocus={() => setHoveredId(node.cluster.id)}
              onBlur={() =>
                setHoveredId((current) =>
                  current === node.cluster.id ? null : current,
                )
              }
              className={cn(
                "absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-2 transition-[opacity,filter,transform] duration-300 focus-visible:outline-none group",
                isFiltered ? "opacity-5 pointer-events-none" : "hover:opacity-100",
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
                  "flex items-center justify-center rounded-full transition-all duration-300 group-hover:scale-110 shadow-soft",
                  isSelected
                    ? "bg-foreground scale-110"
                    : "bg-background/70 border border-foreground/50 backdrop-blur-sm group-hover:bg-foreground/20",
                )}
                style={{ width: nodeSize, height: nodeSize }}
                aria-hidden="true"
              >
                {/* Core reads strength without needing a glyph. */}
                <span
                  className={cn(
                    "rounded-full transition-all duration-300",
                    isSelected ? "bg-background" : "bg-foreground",
                  )}
                  style={{
                    width: Math.max(4, nodeSize * (0.2 + node.cluster.strength * 0.22)),
                    height: Math.max(4, nodeSize * (0.2 + node.cluster.strength * 0.22)),
                  }}
                />
              </span>
              <span
                className={cn(
                  "rounded-full px-3 py-1 whitespace-nowrap font-medium transition-all",
                  isSelected
                    ? "bg-foreground text-background scale-105 shadow-lift"
                    : "bg-background/70 text-foreground border border-border/60 backdrop-blur-sm shadow-soft group-hover:border-foreground/40",
                )}
                style={{ fontSize: Math.max(10, Math.min(13, 11 * node.scale)) }}
              >
                {node.cluster.label}
              </span>
            </button>
          );
        })}

        <div
          data-camera-control
          /* Above the depth-sorted nodes, which reach ~1700, but still inside
             the map's own stacking context. */
          className="absolute left-6 bottom-6 md:left-8 md:bottom-8 z-[2000] flex items-center gap-1 rounded-full border border-border/60 bg-background/80 p-1.5 shadow-lift backdrop-blur-xl sheen"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-10 w-10 rounded-full hover:bg-foreground/10"
            onClick={() => updateZoom(-0.12)}
            aria-label="Zoom out"
          >
            <Minus className="w-5 h-5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-10 w-10 rounded-full hover:bg-foreground/10"
            onClick={() => updateZoom(0.12)}
            aria-label="Zoom in"
          >
            <ZoomIn className="w-5 h-5" />
          </Button>
          <div className="mx-1 h-5 w-px bg-border" />
          <Button
            type="button"
            variant="ghost"
            className="h-10 rounded-full px-4 text-sm font-medium hover:bg-foreground/10"
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
                "absolute z-30 surface flex flex-col overflow-hidden shadow-lift border border-border/60",
                "left-0 right-0 bottom-0 h-[65vh] rounded-t-3xl pb-[env(safe-area-inset-bottom)]", // Mobile
                "md:left-auto md:top-8 md:bottom-8 md:right-8 md:h-auto md:w-[420px] md:rounded-2xl", // Desktop
              )}
              aria-labelledby="detail-pane-title"
            >
              <div
                className="md:hidden flex justify-center pt-4 pb-2 cursor-pointer"
                onClick={() => setSelectedCluster(null)}
              >
                <div className="w-12 h-1.5 rounded-full bg-foreground/20" />
              </div>

              <div className="flex-1 overflow-y-auto p-6 md:p-8 scroll-smooth">
                <div className="flex items-center justify-between mb-8">
                  <div className="rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background">
                    {selectedCluster.category}
                  </div>
                  <button
                    onClick={() => setSelectedCluster(null)}
                    className="flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                    aria-label="Close details"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {isEditing && !isWorkspaceView ? (
                  <div className="mb-8 space-y-4">
                    <label htmlFor="edit-node-label" className="sr-only">
                      Edit concept label
                    </label>
                    <Input
                      id="edit-node-label"
                      value={editLabel}
                      onChange={(event) => setEditLabel(event.target.value)}
                      className="h-16 rounded-xl border-border/60 text-2xl font-semibold tracking-tight"
                      autoFocus
                    />
                    <div className="flex gap-3">
                      <Button
                        size="lg"
                        onClick={handleRename}
                        className="flex-1 rounded-full font-medium"
                      >
                        <Check className="w-4 h-4 mr-2" /> Save
                      </Button>
                      <Button
                        size="lg"
                        variant="outline"
                        onClick={() => setIsEditing(false)}
                        className="flex-1 rounded-full border-border/60 font-medium"
                      >
                        <X className="w-4 h-4 mr-2" /> Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mb-8 group">
                    <h2
                      id="detail-pane-title"
                      className="mb-2 flex items-start justify-between text-3xl font-semibold leading-tight tracking-tight"
                    >
                      <span className="break-words pr-4">
                        {selectedCluster.label}
                      </span>
                      {!isWorkspaceView && (
                        <button
                          onClick={() => setIsEditing(true)}
                          className="mt-1 shrink-0 rounded-full bg-foreground/5 p-2 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground md:opacity-0 md:group-hover:opacity-100"
                          aria-label="Edit label"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                      )}
                    </h2>
                  </div>
                )}

                <div className="mb-8 rounded-xl border border-border/60 bg-foreground/[0.03] p-5">
                  <h3 className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <Info className="w-4 h-4" /> Data profile
                  </h3>
                  <p className="text-[15px] leading-relaxed text-foreground">
                    {knowledgeDisplayText(selectedCluster.summary, citationLookup)}
                  </p>
                </div>

                <div className="space-y-8">
                  <div className="flex gap-4">
                    <div className="flex-1 rounded-xl border border-border/60 surface p-5 text-center">
                      <div className="mb-2 text-xs font-medium text-muted-foreground">
                        Mentions
                      </div>
                      <div className="text-3xl font-semibold tabular-nums">
                        {selectedCluster.mentionCount}
                      </div>
                    </div>
                    {/* The one glow on this screen: strength is the single
                        number worth looking at. */}
                    <div className="relative flex-1 overflow-hidden rounded-xl border border-border/60 surface p-5 text-center">
                      <div
                        className="glow-line absolute bottom-0 left-0 h-0.5 transition-all"
                        style={{ width: `${selectedCluster.strength * 100}%` }}
                      />
                      <div className="mb-2 text-xs font-medium text-muted-foreground">
                        Strength
                      </div>
                      <div className="glow-text text-3xl font-semibold tabular-nums">
                        {(selectedCluster.strength * 100).toFixed(0)}%
                      </div>
                    </div>
                  </div>

                  {evidenceEntries.length > 0 && (
                    <div>
                      <div className="mb-4 border-b border-border/60 pb-2 text-sm font-medium">
                        Evidence
                      </div>
                      <ul className="space-y-2" data-testid="list-evidence">
                        {evidenceEntries.map((entry, index) => (
                          <li
                            key={`${entry.conversationId}-${index}`}
                            className="rounded-xl border border-border/60 bg-foreground/[0.02] px-4 py-3"
                            data-testid={`evidence-row-${index}`}
                          >
                            <div
                              className="text-sm font-medium"
                              data-testid={`evidence-person-${index}`}
                            >
                              {entry.person}
                            </div>
                            <div className="mt-0.5 text-xs text-muted-foreground">
                              {entry.conversationTitle} · {entry.date}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {selectedCluster.links?.length > 0 && (
                    <div>
                      <div className="mb-4 border-b border-border/60 pb-2 text-sm font-medium">
                        Synaptic links
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {selectedCluster.links.map((id: string) => {
                          const linked = clusters.find(
                            (cluster) => cluster.id === id,
                          );
                          return linked ? (
                            <button
                              key={id}
                              onClick={() => handleSelectNode(linked)}
                              className="flex items-center gap-2 rounded-full border border-border/60 bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-foreground hover:text-background"
                            >
                              <LinkIcon className="w-3 h-3" />
                              {linked.label}
                            </button>
                          ) : null;
                        })}
                      </div>
                    </div>
                  )}

                  {!isWorkspaceView && clusters.filter(
                    (cluster) => cluster.id !== selectedCluster.id,
                  ).length > 0 && (
                    <div className="pt-4">
                      <label
                        htmlFor="merge-target"
                        className="mb-4 block border-b border-border/60 pb-2 text-sm font-medium"
                      >
                        Assimilate concept
                      </label>
                      <div className="flex flex-col gap-3">
                        <select
                          id="merge-target"
                          value={mergeTargetId}
                          onChange={(event) =>
                            setMergeTargetId(event.target.value)
                          }
                          className="h-12 w-full appearance-none rounded-xl border border-border/60 bg-background px-4 text-sm outline-none focus-visible:border-foreground/40 focus-visible:ring-0"
                        >
                          <option value="">Select a concept…</option>
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
                          className="h-12 w-full rounded-full font-medium"
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

              {!isWorkspaceView && (
              <div className="shrink-0 border-t border-border/60 p-6">
                {showDeleteConfirm ? (
                  <div className="space-y-4">
                    <p className="text-center text-sm font-medium text-destructive">
                      Delete this concept permanently?
                    </p>
                    <div className="flex gap-3">
                      <Button
                        variant="destructive"
                        className="h-12 flex-1 rounded-full font-medium"
                        onClick={handleDelete}
                      >
                        Delete
                      </Button>
                      <Button
                        variant="outline"
                        className="h-12 flex-1 rounded-full border-border/60 font-medium"
                        onClick={() => setShowDeleteConfirm(false)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    className="h-12 w-full rounded-full border-destructive/30 text-sm font-medium text-destructive transition-all hover:bg-destructive hover:text-destructive-foreground"
                    onClick={() => setShowDeleteConfirm(true)}
                  >
                    <Trash2 className="w-4 h-4 mr-2" /> Delete concept
                  </Button>
                )}
              </div>
              )}
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Remote concept panel: knowledge the server holds but this device has
          not cached. Same surface as the local details pane, read-only. */}
      <AnimatePresence>
        {remoteConcept && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="hidden md:block absolute inset-0 bg-background/40 backdrop-blur-sm z-20"
              onClick={() => setRemoteConcept(null)}
            />

            <motion.aside
              initial={{ opacity: 0, y: 100, x: 0 }}
              animate={{ opacity: 1, y: 0, x: 0 }}
              exit={{ opacity: 0, y: 50, x: 0, transition: { duration: 0.2 } }}
              className={cn(
                "absolute z-30 surface flex flex-col overflow-hidden shadow-lift border border-border/60",
                "left-0 right-0 bottom-0 h-[65vh] rounded-t-3xl pb-[env(safe-area-inset-bottom)]",
                "md:left-auto md:top-8 md:bottom-8 md:right-8 md:h-auto md:w-[420px] md:rounded-2xl",
              )}
              aria-labelledby="remote-concept-title"
              data-testid="brain-remote-concept"
            >
              <div
                className="md:hidden flex justify-center pt-4 pb-2 cursor-pointer"
                onClick={() => setRemoteConcept(null)}
              >
                <div className="w-12 h-1.5 rounded-full bg-foreground/20" />
              </div>

              <div className="flex-1 overflow-y-auto p-6 md:p-8 scroll-smooth">
                <div className="flex items-center justify-between mb-8">
                  <div className="rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background">
                    {remoteConcept.detail?.concept.category ?? "Synced knowledge"}
                  </div>
                  <button
                    onClick={() => setRemoteConcept(null)}
                    className="flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                    aria-label="Close concept details"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <div className="mb-2">
                  <h2
                    id="remote-concept-title"
                    className="break-words text-3xl font-semibold leading-tight tracking-tight"
                  >
                    {remoteConcept.label}
                  </h2>
                </div>
                <p className="mb-8 text-xs font-medium text-muted-foreground">
                  {projectNameById.get(remoteConcept.projectId ?? "") ??
                    "Unknown project"}
                  {" · "}not on this device
                </p>

                {remoteConcept.status === "loading" && (
                  <div className="space-y-4" data-testid="brain-remote-loading">
                    <Skeleton className="h-24 w-full rounded-xl bg-foreground/5" />
                    <Skeleton className="h-16 w-full rounded-xl bg-foreground/5" />
                    <Skeleton className="h-16 w-2/3 rounded-xl bg-foreground/5" />
                  </div>
                )}

                {remoteConcept.status === "offline" && (
                  <div
                    className="flex flex-col items-center rounded-xl border border-border/60 bg-foreground/[0.03] px-6 py-10 text-center"
                    data-testid="brain-remote-offline"
                  >
                    <WifiOff
                      className="mb-4 h-8 w-8 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <h3 className="mb-2 text-lg font-medium">
                      Connect to view evidence
                    </h3>
                    <p className="mb-6 max-w-xs text-sm text-muted-foreground">
                      This knowledge lives in your synced brain, not on this
                      device. Go online to pull its summary, evidence, and
                      links.
                    </p>
                    <Button
                      className="h-11 rounded-full px-6 font-medium"
                      data-testid="brain-remote-retry"
                      onClick={() =>
                        setRemoteConcept((current) =>
                          current
                            ? { ...current, status: "loading" }
                            : current,
                        )
                      }
                    >
                      <RotateCcw className="w-4 h-4 mr-2" /> Try again
                    </Button>
                  </div>
                )}

                {remoteConcept.status === "missing" && (
                  <div
                    className="rounded-xl border border-border/60 bg-foreground/[0.03] px-6 py-10 text-center text-sm text-muted-foreground"
                    data-testid="brain-remote-missing"
                  >
                    This concept is no longer in your knowledge base. It may
                    have been merged or deleted on another device.
                  </div>
                )}

                {remoteConcept.status === "ready" && remoteConcept.detail && (
                  <>
                    <div className="mb-8 rounded-xl border border-border/60 bg-foreground/[0.03] p-5">
                      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        <Info className="w-4 h-4" /> Data profile
                      </h3>
                      <p className="text-[15px] leading-relaxed text-foreground">
                        {knowledgeDisplayText(
                          remoteConcept.detail.concept.summary,
                          remoteCitationLookup,
                        )}
                      </p>
                    </div>

                    <div className="space-y-8">
                      <div className="flex gap-4">
                        <div className="flex-1 rounded-xl border border-border/60 surface p-5 text-center">
                          <div className="mb-2 text-xs font-medium text-muted-foreground">
                            Mentions
                          </div>
                          <div className="text-3xl font-semibold tabular-nums">
                            {remoteConcept.detail.concept.mentionCount}
                          </div>
                        </div>
                        <div className="flex-1 rounded-xl border border-border/60 surface p-5 text-center">
                          <div className="mb-2 text-xs font-medium text-muted-foreground">
                            Strength
                          </div>
                          <div className="text-3xl font-semibold tabular-nums">
                            {(remoteConcept.detail.concept.strength * 100).toFixed(0)}%
                          </div>
                        </div>
                      </div>

                      <div>
                        <div className="mb-4 border-b border-border/60 pb-2 text-sm font-medium">
                          Evidence ·{" "}
                          {remoteConcept.detail.concept.sources.length}
                        </div>
                        {remoteConcept.detail.concept.sources.length === 0 ? (
                          <p className="text-sm text-muted-foreground">
                            No conversation evidence is attached to this
                            concept yet.
                          </p>
                        ) : (
                          <ul className="space-y-3">
                            {remoteConcept.detail.concept.sources.map(
                              (source, index) => (
                                <li
                                  key={`${source.conversationId}-${index}`}
                                  className="rounded-xl border border-border/60 bg-background px-4 py-3"
                                  data-testid={`brain-remote-evidence-${source.conversationId}`}
                                >
                                  <p className="truncate text-sm font-medium">
                                    {source.conversationTitle}
                                  </p>
                                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                                    {knowledgeDisplayText(
                                      source.excerpt,
                                      remoteCitationLookup,
                                    )}
                                  </p>
                                </li>
                              ),
                            )}
                          </ul>
                        )}
                      </div>

                      {remoteConcept.detail.neighbors.length > 0 && (
                        <div>
                          <div className="mb-4 border-b border-border/60 pb-2 text-sm font-medium">
                            Linked concepts
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {remoteConcept.detail.neighbors.map((neighbor) => (
                              <button
                                key={neighbor.id}
                                onClick={() =>
                                  jumpToResult({
                                    id: neighbor.id,
                                    label: neighbor.label,
                                    projectId: neighbor.projectId,
                                  })
                                }
                                className="flex items-center gap-2 rounded-full border border-border/60 bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-foreground hover:text-background"
                                data-testid={`brain-remote-neighbor-${neighbor.id}`}
                              >
                                <LinkIcon className="w-3 h-3" />
                                {neighbor.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
