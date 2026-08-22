import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KnowledgeCluster } from "@/context/venom-workspace";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Building2,
  Check,
  ChevronDown,
  CornerDownRight,
  Download,
  Edit2,
  ExternalLink,
  Github,
  Globe,
  Inbox,
  Link as LinkIcon,
  Loader2,
  Lock,
  LockOpen,
  Minus,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldOff,
  Trash2,
  Users,
  WifiOff,
  X,
  ZoomIn,
  Info,
  BrainCircuit,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useVenomWorkspace } from "@/context/venom-workspace";
import { useSharedWorkspace } from "@/context/shared-workspace";
import {
  acceptVenomKnowledgeSuggestion,
  ApiError,
  applyVenomMasterSuggestion,
  dismissVenomKnowledgeSuggestion,
  dismissVenomMasterSuggestion,
  exportSharedWorkspaceMarkdown,
  exportVenomPersonalMarkdown,
  getListVenomKnowledgeMovesQueryKey,
  getVenomConversation,
  getVenomMasterBrain,
  getVenomMasterSuggestions,
  getVenomOntologyConcept,
  getVenomOrgBrain,
  moveVenomUnsortedConcept,
  promoteVenomConceptToOrg,
  searchVenomOntology,
  undoVenomKnowledgeMove,
  useGetSharedWorkspaceKnowledge,
  useListVenomKnowledgeMoves,
  useSetSharedWorkspaceConceptRestriction,
  useSetSharedWorkspaceConceptSensitivity,
  useSetSharedWorkspaceEvidenceSensitivity,
  getGetSharedWorkspaceKnowledgeQueryKey,
  type ProjectSource,
  type VenomKnowledgeCluster,
  type VenomKnowledgeMoveNotice,
  type VenomKnowledgeSuggestion,
  type VenomMasterBrain,
  type VenomMasterSuggestion,
  type VenomOntologyConceptDetail,
  type VenomOntologySearchResult,
  type VenomOrgBrain,
  type VenomRemoteConversation,
} from "@workspace/api-client-react";
import { useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  downloadMarkdown,
  markdownExportFileName,
} from "@/lib/download-markdown";
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
 * The Brain's two personal-tier faces: the knowledge map, and a flat list of
 * the connected sources' citations — the evidence a chat answer can cite and
 * lead back to (mirrors the mobile knowledge screen's view toggle).
 */
type KnowledgeView = "map" | "sources";

/** Case-insensitive match for the sources-view filter. */
function sourceTextMatches(value: string | undefined, query: string): boolean {
  return (value ?? "").toLowerCase().includes(query);
}

/**
 * Human copy for an automatic filing notice. Labels lead so the reader knows
 * what moved; the workspace name says where.
 */
function describeMoveNotice(notice: VenomKnowledgeMoveNotice): string {
  const shown = notice.labels.slice(0, 3).join(", ");
  const subject =
    (shown || "Some knowledge") + (notice.labels.length > 3 ? "…" : "");
  const workspace = notice.workspaceName ?? "a workspace";
  if (notice.kind === "auto_file") {
    return `${subject} — filed to ${workspace} automatically.`;
  }
  return notice.direction === "workspace_to_personal"
    ? `${subject} — moved out of ${workspace} into your Brain; it looked personal.`
    : `${subject} — moved from Unsorted to ${workspace}.`;
}

/**
 * Human-readable "last successful sync" label for a connected source card.
 * Mirrors the mobile app's `describeLastSync` wording exactly, so a card
 * reads the same on both clients.
 */
function describeLastSync(syncedAt: string, now: number): string {
  const MINUTE_MS = 60_000;
  const HOUR_MS = 60 * MINUTE_MS;
  const DAY_MS = 24 * HOUR_MS;

  const syncedTime = Date.parse(syncedAt);
  if (Number.isNaN(syncedTime)) return "Last synced recently";

  const elapsed = now - syncedTime;
  if (elapsed < 0 || elapsed < MINUTE_MS) return "Last synced just now";
  if (elapsed < HOUR_MS) {
    const minutes = Math.floor(elapsed / MINUTE_MS);
    return `Last synced ${minutes}m ago`;
  }
  if (elapsed < DAY_MS) {
    const hours = Math.floor(elapsed / HOUR_MS);
    return `Last synced ${hours}h ago`;
  }

  const days = Math.floor(elapsed / DAY_MS);
  if (days <= 30) return `Last synced ${days}d ago`;
  return `Last synced ${syncedAt.slice(0, 10)}`;
}

/**
 * A cited conversation that is not in local state. Evidence on a synced
 * concept usually points at conversations the device never synced either, so
 * the transcript is served read-only from the cloud snapshot on demand —
 * otherwise the trail of proof dead-ends one level below the concept.
 */
type RemoteConversationView = {
  conversationId: string;
  /** Title from the evidence row, shown while the transcript loads. */
  title: string;
  status: "loading" | "ready" | "offline" | "missing";
  detail: VenomRemoteConversation | null;
};
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
    isReady,
    orgs,
    setActiveProject,
    setActiveConversation,
    renameKnowledgeCluster,
    deleteKnowledgeCluster,
    mergeKnowledgeClusters,
    applyFiledKnowledge,
    markKnowledgeClusterSorted,
  } = useVenomWorkspace();
  const [, setLocation] = useLocation();
  // Every shared workspace the account belongs to. The Personal/workspace
  // axis lives here on the Brain page as a filter now — the global switcher
  // is gone, and scope is decided at filing time instead.
  const { workspaces } = useSharedWorkspace();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Which workspace the filter shows, if any. Derived against the live
  // membership list so losing membership drops the layer instantly.
  const [layerWorkspaceId, setLayerWorkspaceId] = useState<string | null>(
    null,
  );
  // The author-private Unsorted holding area: low-confidence filings wait
  // here, visible to no one else, until a destination becomes clear.
  const [isUnsortedLayer, setIsUnsortedLayer] = useState(false);
  const activeWorkspace = useMemo(
    () =>
      layerWorkspaceId
        ? (workspaces.find((entry) => entry.id === layerWorkspaceId) ?? null)
        : null,
    [layerWorkspaceId, workspaces],
  );
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

  // Sensitivity locks exist on the workspace tier only. The server returns
  // the updated cluster, which refreshes both the open pane and the list.
  const conceptSensitivity = useSetSharedWorkspaceConceptSensitivity();
  const evidenceSensitivity = useSetSharedWorkspaceEvidenceSensitivity();
  // Admin-only restrictions: the server rejects non-admin callers and never
  // serves restricted clusters to members, so this UI only ever renders for
  // people allowed to see the item.
  const conceptRestriction = useSetSharedWorkspaceConceptRestriction();
  const isWorkspaceAdmin = activeWorkspace?.role === "admin";
  const [exporting, setExporting] = useState(false);

  // Below the md breakpoint the floating header card would bury the map
  // under five-plus stacked rows, so its contents collapse into a single
  // pill bar that opens a menu instead. Rendered conditionally (not CSS-
  // hidden) so each control exists exactly once in the DOM at any width.
  const isMobile = useIsMobile();
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  useEffect(() => {
    if (!isMobile) setHeaderMenuOpen(false);
  }, [isMobile]);

  const applyUpdatedCluster = (updated: KnowledgeCluster) => {
    setSelectedCluster((current) =>
      current && current.id === updated.id ? updated : current,
    );
    if (activeWorkspace) {
      queryClient.invalidateQueries({
        queryKey: getGetSharedWorkspaceKnowledgeQueryKey(activeWorkspace.id),
      });
    }
  };

  const sensitivityFailed = () => {
    toast({
      title: "Could not update the lock",
      description: "Try again in a moment.",
      variant: "destructive",
    });
  };

  const handleConceptLock = (cluster: KnowledgeCluster, sensitive: boolean) => {
    if (!activeWorkspace || conceptSensitivity.isPending) return;
    conceptSensitivity.mutate(
      {
        workspaceId: activeWorkspace.id,
        conceptId: cluster.id,
        data: { sensitive },
      },
      { onSuccess: applyUpdatedCluster, onError: sensitivityFailed },
    );
  };

  const handleConceptRestriction = (
    cluster: KnowledgeCluster,
    adminOnly: boolean,
  ) => {
    if (!activeWorkspace || conceptRestriction.isPending) return;
    conceptRestriction.mutate(
      {
        workspaceId: activeWorkspace.id,
        conceptId: cluster.id,
        data: { adminOnly },
      },
      {
        onSuccess: applyUpdatedCluster,
        onError: () => {
          toast({
            title: "Could not update the restriction",
            description: "Try again in a moment.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleEvidenceLock = (
    cluster: KnowledgeCluster,
    conversationId: string,
    sensitive: boolean,
  ) => {
    if (!activeWorkspace || evidenceSensitivity.isPending) return;
    evidenceSensitivity.mutate(
      {
        workspaceId: activeWorkspace.id,
        conceptId: cluster.id,
        conversationId,
        data: { sensitive },
      },
      { onSuccess: applyUpdatedCluster, onError: sensitivityFailed },
    );
  };

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      // Exports follow the filter on screen: the workspace layer exports
      // that workspace's shared knowledge, the Unsorted layer exports only
      // the holding area, and the personal layer exports the sorted Brain.
      const markdown =
        isWorkspaceView && activeWorkspace
          ? await exportSharedWorkspaceMarkdown(activeWorkspace.id, "brain")
          : await exportVenomPersonalMarkdown("brain", {
              scope: isUnsortedLayer ? "unsorted" : "sorted",
            });
      downloadMarkdown(
        markdownExportFileName(
          isWorkspaceView && activeWorkspace
            ? activeWorkspace.name
            : isUnsortedLayer
              ? "unsorted"
              : "personal",
          "brain",
        ),
        markdown,
      );
    } catch {
      toast({
        title: "Export failed",
        description: "The download could not be prepared. Try again.",
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  };

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
  const [remoteConversation, setRemoteConversation] =
    useState<RemoteConversationView | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editLabel, setEditLabel] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState("");

  // Which Brain layer is on screen: `null` is the personal map, otherwise a
  // company id. The company layer renders the shared org ontology read-only.
  // A shared workspace, when active, takes the whole view instead.
  const [layerOrgId, setLayerOrgId] = useState<string | null>(null);
  const [orgBrain, setOrgBrain] = useState<VenomOrgBrain | null>(null);
  const [orgBrainFailed, setOrgBrainFailed] = useState(false);
  // The third tier: Venom's anonymous master map. Aggregate concepts and
  // connection patterns only — no names, excerpts, or account traces, and
  // nothing appears until it is common across many accounts.
  const [isNetworkLayer, setIsNetworkLayer] = useState(false);
  const [masterBrain, setMasterBrain] = useState<VenomMasterBrain | null>(
    null,
  );
  const [masterBrainFailed, setMasterBrainFailed] = useState(false);
  // "Related in the Venom network" chips for the personal/company layers.
  const [networkSuggestions, setNetworkSuggestions] = useState<
    VenomMasterSuggestion[]
  >([]);
  const [suggestionBusyLabel, setSuggestionBusyLabel] = useState<
    string | null
  >(null);
  const [promoteTargetOrgId, setPromoteTargetOrgId] = useState("");
  const [promoteStatus, setPromoteStatus] = useState<
    "idle" | "busy" | "done" | "error"
  >("idle");
  const [promoteMessage, setPromoteMessage] = useState<string | null>(null);
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

  // ── Sources view & citation jump ──────────────────────────────────────────
  // A chat citation chip lands here with `?view=sources&source=…&citation=…`:
  // the sources view opens scrolled to the cited card and, when the jump
  // carries the citation id, to the exact quoted row. A citation id without
  // its source names nothing worth marking, so it only counts alongside one
  // (mirrors the mobile knowledge screen).
  const locationSearch = useSearch();
  const jumpParams = useMemo(
    () => new URLSearchParams(locationSearch),
    [locationSearch],
  );
  const requestedSourceId = jumpParams.get("source") || null;
  const requestedCitationId = requestedSourceId
    ? jumpParams.get("citation") || null
    : null;
  const [view, setView] = useState<KnowledgeView>(
    jumpParams.get("view") === "sources" || requestedSourceId
      ? "sources"
      : "map",
  );
  const [sourceFilter, setSourceFilter] = useState("");
  const [highlightedSourceId, setHighlightedSourceId] = useState<
    string | null
  >(requestedSourceId);
  const [highlightedCitationId, setHighlightedCitationId] = useState<
    string | null
  >(requestedCitationId);
  // Card and row nodes by id, so a parked jump can scroll to them once they
  // exist (the DOM analog of the mobile screen's measured offsets).
  const sourceNodesRef = useRef(new Map<string, HTMLElement>());
  const citationNodesRef = useRef(new Map<string, HTMLElement>());
  const activeSourcesRef = useRef<ProjectSource[]>([]);
  // Parked from mount (or a later jump) until the target can actually be
  // scrolled to — the workspace may still be hydrating when the jump lands.
  const pendingScrollRef = useRef<{
    sourceId: string;
    citationId: string | null;
  } | null>(
    requestedSourceId
      ? { sourceId: requestedSourceId, citationId: requestedCitationId }
      : null,
  );

  const scrollToPendingSource = useCallback(() => {
    const pending = pendingScrollRef.current;
    if (!pending) return;
    const card = sourceNodesRef.current.get(pending.sourceId);
    if (!card) return;
    let target: HTMLElement = card;
    if (pending.citationId) {
      const source = activeSourcesRef.current.find(
        (entry) => entry.id === pending.sourceId,
      );
      // A jump can carry a citation id the source no longer holds (the row
      // was pruned by a later sync): land on the card instead of waiting
      // forever for a row that will never render.
      const citationExists =
        source?.citations.some(
          (citation) => citation.id === pending.citationId,
        ) ?? false;
      if (citationExists) {
        const row = citationNodesRef.current.get(pending.citationId);
        if (!row) return;
        target = row;
      }
    }
    pendingScrollRef.current = null;
    target.scrollIntoView({ block: "start" });
  }, []);

  // A jump can arrive while the page is already open (the URL changes under
  // the mounted screen): reopen the sources view, retire any open panes and
  // filter, and re-park the scroll on the new target.
  useEffect(() => {
    if (!requestedSourceId) return;
    setView("sources");
    setSelectedCluster(null);
    setRemoteConcept(null);
    setRemoteConversation(null);
    setSourceFilter("");
    setHighlightedSourceId(requestedSourceId);
    setHighlightedCitationId(requestedCitationId);
    pendingScrollRef.current = {
      sourceId: requestedSourceId,
      citationId: requestedCitationId,
    };
    scrollToPendingSource();
  }, [requestedSourceId, requestedCitationId, scrollToPendingSource]);

  // The target may not be in the DOM yet (hydration, filter changes), so the
  // parked scroll retries after every render until its card appears —
  // mirroring the mobile screen's retry from each row's onLayout.
  useEffect(() => {
    scrollToPendingSource();
  });

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

  // ── company Brain layer ───────────────────────────────────────────────────
  const activeOrg = useMemo(
    () =>
      layerOrgId ? (orgs.find((org) => org.id === layerOrgId) ?? null) : null,
    [layerOrgId, orgs],
  );
  const isCompanyLayer = activeOrg !== null && !isWorkspaceView;

  // Everything scoped to the current layer, cleared in one commit. Reused by
  // the voluntary layer switch and by involuntary access loss (membership
  // push, 403/404), so an open detail pane, its evidence rows, remote views,
  // and search results can never outlive membership.
  const clearLayerScopedState = () => {
    setOrgBrain(null);
    setOrgBrainFailed(false);
    setMasterBrain(null);
    setMasterBrainFailed(false);
    setNetworkSuggestions([]);
    setSuggestionBusyLabel(null);
    setSelectedCluster(null);
    setSelectedDetail(null);
    setRemoteConcept(null);
    setRemoteConversation(null);
    setIsEditing(false);
    setShowDeleteConfirm(false);
    setMergeTargetId("");
    setSearch("");
    setRemoteResults(null);
    setPromoteStatus("idle");
    setPromoteMessage(null);
  };

  // Membership can end while the layer is open (removed by an admin, company
  // deleted). The directory poll is authoritative: fall back to My Brain and
  // drop every company-derived pane atomically.
  useEffect(() => {
    if (layerOrgId && !orgs.some((org) => org.id === layerOrgId)) {
      setLayerOrgId(null);
      clearLayerScopedState();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerOrgId, orgs]);

  // Same for the workspace filter: membership can end while it is open. The
  // account-keyed membership list is authoritative — fall back to My Brain
  // and drop every workspace-derived pane atomically.
  useEffect(() => {
    if (
      layerWorkspaceId &&
      !workspaces.some((entry) => entry.id === layerWorkspaceId)
    ) {
      setLayerWorkspaceId(null);
      clearLayerScopedState();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerWorkspaceId, workspaces]);

  useEffect(() => {
    if (!layerOrgId) {
      setOrgBrain(null);
      setOrgBrainFailed(false);
      return;
    }
    let stale = false;
    setOrgBrain(null);
    setOrgBrainFailed(false);
    const load = () => {
      getVenomOrgBrain(layerOrgId)
        .then((brain) => {
          if (stale) return;
          setOrgBrain(brain);
          setOrgBrainFailed(false);
        })
        .catch((error) => {
          if (stale) return;
          if (
            error instanceof ApiError &&
            (error.status === 403 || error.status === 404)
          ) {
            // Access ended server-side; drop the layer and every
            // company-derived pane immediately.
            setLayerOrgId(null);
            clearLayerScopedState();
          } else {
            setOrgBrainFailed(true);
          }
        });
    };
    load();
    // Poll so teammates' chats and promotions surface without a reload.
    const interval = window.setInterval(load, 25_000);
    return () => {
      stale = true;
      window.clearInterval(interval);
    };
  }, [layerOrgId]);

  // Keep the open detail pane in step with the freshest org snapshot.
  useEffect(() => {
    if (!layerOrgId || !orgBrain) return;
    setSelectedCluster((current) =>
      current
        ? (orgBrain.concepts.find((concept) => concept.id === current.id) ??
          current)
        : current,
    );
  }, [layerOrgId, orgBrain]);

  const switchLayer = (orgId: string | null) => {
    setLayerOrgId(orgId);
    setIsNetworkLayer(false);
    setLayerWorkspaceId(null);
    setIsUnsortedLayer(false);
    clearLayerScopedState();
  };

  const switchToNetworkLayer = () => {
    setLayerOrgId(null);
    setIsNetworkLayer(true);
    setLayerWorkspaceId(null);
    setIsUnsortedLayer(false);
    clearLayerScopedState();
  };

  const switchToWorkspaceLayer = (workspaceId: string) => {
    setLayerOrgId(null);
    setIsNetworkLayer(false);
    setLayerWorkspaceId(workspaceId);
    setIsUnsortedLayer(false);
    // The workspace and Unsorted layers have no sources view; make sure the
    // map is what renders when the filter lands.
    setView("map");
    clearLayerScopedState();
  };

  const switchToUnsortedLayer = () => {
    setLayerOrgId(null);
    setIsNetworkLayer(false);
    setLayerWorkspaceId(null);
    setIsUnsortedLayer(true);
    setView("map");
    clearLayerScopedState();
  };

  // The aggregate map changes slowly (it is rebuilt from anonymous signals),
  // so one fetch per visit is enough — no polling.
  useEffect(() => {
    if (!isNetworkLayer) return;
    let stale = false;
    getVenomMasterBrain()
      .then((brain) => {
        if (stale) return;
        // A proxy or SPA fallback can answer 200 with a non-JSON body; treat
        // anything without the expected arrays as an unreachable network.
        if (Array.isArray(brain?.concepts) && Array.isArray(brain?.links)) {
          setMasterBrain(brain);
          setMasterBrainFailed(false);
        } else {
          setMasterBrainFailed(true);
        }
      })
      .catch(() => {
        if (!stale) setMasterBrainFailed(true);
      });
    return () => {
      stale = true;
    };
  }, [isNetworkLayer]);

  // Suggestions accompany the personal and company layers — never the
  // workspace tier, and not the network map itself.
  useEffect(() => {
    if (isWorkspaceView || isNetworkLayer || isUnsortedLayer) {
      setNetworkSuggestions([]);
      return;
    }
    let stale = false;
    getVenomMasterSuggestions(layerOrgId ? { org: layerOrgId } : undefined)
      .then((response) => {
        // A proxy or SPA fallback can answer 200 with a non-JSON body, so
        // never trust the shape blindly.
        if (!stale)
          setNetworkSuggestions(
            Array.isArray(response?.suggestions) ? response.suggestions : [],
          );
      })
      .catch(() => {
        // The map works fine without suggestions; stay quiet when offline.
        if (!stale) setNetworkSuggestions([]);
      });
    return () => {
      stale = true;
    };
  }, [isWorkspaceView, isNetworkLayer, isUnsortedLayer, layerOrgId]);

  const handleApplySuggestion = async (suggestion: VenomMasterSuggestion) => {
    if (suggestionBusyLabel) return;
    setSuggestionBusyLabel(suggestion.label);
    try {
      const result = await applyVenomMasterSuggestion({
        label: suggestion.label,
        ...(layerOrgId ? { orgId: layerOrgId } : {}),
      });
      setNetworkSuggestions((current) =>
        current.filter((entry) => entry.label !== suggestion.label),
      );
      if (result.filedScope.ownerType === "user") {
        // Absorb the server-filed rows through the same merge as chat
        // filing, so every device converges on identical concepts.
        applyFiledKnowledge(
          {
            id: "venom-master-suggestions",
            title: "Venom network suggestions",
            projectId: null,
          },
          result.filed ?? [],
        );
      } else if (layerOrgId) {
        // Company filing: pull the shared layer forward right away instead
        // of waiting out the poll.
        try {
          setOrgBrain(await getVenomOrgBrain(layerOrgId));
        } catch {
          // The 25s poll will catch up.
        }
      }
      toast({
        title: `“${suggestion.label}” added`,
        description:
          result.filedScope.ownerType === "org"
            ? `Now in the ${activeOrg?.name ?? "company"} Brain.`
            : "Now in your Brain.",
      });
    } catch {
      toast({
        title: "Could not add the suggestion",
        description: "Check your connection and try again.",
      });
    } finally {
      setSuggestionBusyLabel(null);
    }
  };

  const handleDismissSuggestion = async (
    suggestion: VenomMasterSuggestion,
  ) => {
    setNetworkSuggestions((current) =>
      current.filter((entry) => entry.label !== suggestion.label),
    );
    try {
      await dismissVenomMasterSuggestion({ label: suggestion.label });
    } catch {
      // Dismissal is per-account bookkeeping; a lost call only means the
      // chip may return on the next visit.
    }
  };

  // ── automatic filing activity ─────────────────────────────────────────────
  // Author-private ledger of what auto-sorting did (notices, each with undo)
  // and what it would like to share (pending personal→workspace suggestions).
  // Meaningful on the personal and Unsorted layers only, so the other tiers
  // pause the poll.
  const movesEnabled = !isWorkspaceView && !isCompanyLayer && !isNetworkLayer;
  const movesQuery = useListVenomKnowledgeMoves({
    query: {
      queryKey: getListVenomKnowledgeMovesQueryKey(),
      enabled: movesEnabled,
      refetchInterval: 30_000,
    },
  });
  const moveNotices = useMemo(
    () =>
      asList(movesQuery.data?.notices).filter(
        (notice) => notice.status === "active",
      ),
    [movesQuery.data],
  );
  const moveSuggestions = useMemo(
    () => asList(movesQuery.data?.suggestions),
    [movesQuery.data],
  );
  const [moveBusyId, setMoveBusyId] = useState<string | null>(null);
  const [unsortedBusyId, setUnsortedBusyId] = useState<string | null>(null);

  const refreshMoves = () =>
    queryClient.invalidateQueries({
      queryKey: getListVenomKnowledgeMovesQueryKey(),
    });

  // applyFiledKnowledge only lands records whose source conversation exists
  // locally, so find one among the restored records' evidence. When none is
  // on this device, the next sync delivers the restored items instead.
  const findRestoredConversation = (restored: VenomKnowledgeCluster[]) => {
    for (const cluster of restored) {
      for (const source of cluster.sources ?? []) {
        const conversation = state?.conversations.find(
          (entry) => entry.id === source.conversationId,
        );
        if (conversation) return conversation;
      }
    }
    return null;
  };

  const handleUndoMove = async (notice: VenomKnowledgeMoveNotice) => {
    if (moveBusyId) return;
    setMoveBusyId(notice.id);
    try {
      const result = await undoVenomKnowledgeMove(notice.id);
      // A non-2xx resolves to the error body: the undo window closed or the
      // records changed since the move. The notice is retired server-side,
      // so the refresh in `finally` drops it.
      const refusal = result as { restored?: unknown; error?: string } | null;
      if (!refusal || !Array.isArray(refusal.restored)) {
        toast({
          title: "Undo no longer available",
          description:
            refusal?.error ?? "This knowledge changed since the move.",
          variant: "destructive",
        });
        return;
      }
      if (notice.workspaceId) {
        void queryClient.invalidateQueries({
          queryKey: getGetSharedWorkspaceKnowledgeQueryKey(notice.workspaceId),
        });
      }
      const restored = asList(result.restored);
      if (restored.length > 0) {
        const conversation = findRestoredConversation(restored);
        if (conversation) applyFiledKnowledge(conversation, restored);
      }
      toast({
        title: "Move undone",
        description:
          notice.direction === "workspace_to_personal"
            ? `Back in ${notice.workspaceName ?? "the workspace"}.`
            : "Back in your private Unsorted items.",
      });
    } catch {
      toast({
        title: "Could not undo",
        description: "The move may have changed since. Try again in a moment.",
        variant: "destructive",
      });
    } finally {
      setMoveBusyId(null);
      void refreshMoves();
    }
  };

  const handleAcceptShare = async (suggestion: VenomKnowledgeSuggestion) => {
    if (moveBusyId) return;
    setMoveBusyId(suggestion.id);
    try {
      const result = await acceptVenomKnowledgeSuggestion(suggestion.id);
      // The personal copy just moved into the workspace store. Retire it
      // locally the way a manual delete would — the server already wrote a
      // permanent replaced marker, so no later sync can resurrect it.
      deleteKnowledgeCluster(suggestion.conceptId);
      void queryClient.invalidateQueries({
        queryKey: getGetSharedWorkspaceKnowledgeQueryKey(result.workspaceId),
      });
      toast({
        title: `Shared to ${result.workspaceName}`,
        description: "Everyone in that workspace can see it now.",
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        toast({
          title: "You're no longer in that workspace",
          description: "The suggestion no longer applies.",
          variant: "destructive",
        });
      } else if (error instanceof ApiError && error.status === 409) {
        toast({
          title: "Already handled",
          description: "This item changed since the suggestion was made.",
        });
      } else {
        toast({
          title: "Could not share it",
          description: "Check your connection and try again.",
          variant: "destructive",
        });
      }
    } finally {
      setMoveBusyId(null);
      void refreshMoves();
    }
  };

  const handleDismissShare = async (suggestion: VenomKnowledgeSuggestion) => {
    if (moveBusyId) return;
    setMoveBusyId(suggestion.id);
    try {
      await dismissVenomKnowledgeSuggestion(suggestion.id);
    } catch {
      // Bookkeeping only; the chip may return on the next poll.
    } finally {
      setMoveBusyId(null);
      void refreshMoves();
    }
  };

  // ── Unsorted review ───────────────────────────────────────────────────────
  const handleKeepPersonal = (cluster: { id: string; label: string }) => {
    markKnowledgeClusterSorted(cluster.id);
    setSelectedCluster(null);
    toast({
      title: "Kept personal",
      description: `“${cluster.label}” now lives in your Brain.`,
    });
  };

  const handleMoveUnsorted = async (
    cluster: { id: string; label: string },
    workspaceId: string,
  ) => {
    if (unsortedBusyId) return;
    setUnsortedBusyId(cluster.id);
    try {
      const result = await moveVenomUnsortedConcept(cluster.id, {
        workspaceId,
      });
      // Retire the local copy behind the server's permanent replaced marker.
      deleteKnowledgeCluster(cluster.id);
      setSelectedCluster(null);
      void queryClient.invalidateQueries({
        queryKey: getGetSharedWorkspaceKnowledgeQueryKey(result.workspaceId),
      });
      toast({
        title: `Moved to ${result.workspaceName}`,
        description: "Everyone in that workspace can see it now.",
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        toast({
          title: "You're no longer in that workspace",
          description: "Pick another destination, or keep it personal.",
          variant: "destructive",
        });
      } else if (
        error instanceof ApiError &&
        (error.status === 404 || error.status === 409)
      ) {
        toast({
          title: "Could not move it",
          description:
            "This item changed on another device — it may already be sorted.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Could not move it",
          description: "Check your connection and try again.",
          variant: "destructive",
        });
      }
    } finally {
      setUnsortedBusyId(null);
      void refreshMoves();
    }
  };

  // Whole-ontology search. The server store is the system of record (it can
  // hold more concepts than a device keeps locally), so ask it first and fall
  // back to the on-device copy when it is unreachable. Browser tests stub the
  // endpoint like every other backend read. The remote search covers the
  // personal store only, so it stays off in workspace view.
  useEffect(() => {
    const term = search.trim();
    if (
      term.length < 2 ||
      isWorkspaceView ||
      isNetworkLayer ||
      isUnsortedLayer
    ) {
      setRemoteResults(null);
      return;
    }
    let stale = false;
    const timer = window.setTimeout(() => {
      searchVenomOntology({
        q: term,
        limit: 20,
        ...(layerOrgId ? { org: layerOrgId } : {}),
      })
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
  }, [search, layerOrgId, isNetworkLayer, isUnsortedLayer]);

  useEffect(() => {
    const conceptId = selectedCluster?.id ?? null;
    setSelectedDetail(null);
    // Network concepts have no server detail: there is no evidence or
    // attribution behind them, only the aggregate row already on screen.
    if (!conceptId || IS_UI_TEST || isWorkspaceView || isNetworkLayer) return;
    let stale = false;
    getVenomOntologyConcept(
      conceptId,
      layerOrgId ? { org: layerOrgId } : undefined,
    )
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
  }, [selectedCluster?.id, isWorkspaceView, layerOrgId]);

  // Rows for the detail pane: who said it, in which conversation, when, and
  // the excerpt that backs the concept. Prefers the server detail; otherwise
  // the device copy is shown as the signed-in person's own words.
  const evidence = useMemo(() => {
    const empty = {
      total: 0,
      entries: [] as Array<{
        conversationId: string;
        conversationTitle: string;
        excerpt: string;
        person: string;
        date: string;
        sensitive: boolean;
      }>,
    };
    if (!selectedCluster) return empty;
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
    const entries = sources.slice(0, 8).map((source) => {
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
        excerpt: source.excerpt,
        person,
        sensitive: source.sensitive === true,
        date: new Date(capturedAt).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        }),
      };
    });
    return { total: sources.length, entries };
  }, [selectedCluster, selectedDetail, user]);

  // Aggregate network concepts rendered through the same cluster pipeline
  // as every other layer. Sources and evidence are empty by construction —
  // the network tier carries nothing beyond labels, categories, and
  // connection weights.
  const masterClusters = useMemo<KnowledgeCluster[]>(() => {
    if (!masterBrain) return [];
    const neighbors = new Map<string, string[]>();
    for (const link of masterBrain.links) {
      neighbors.set(link.a, [...(neighbors.get(link.a) ?? []), link.b]);
      neighbors.set(link.b, [...(neighbors.get(link.b) ?? []), link.a]);
    }
    return masterBrain.concepts.map((concept) => ({
      id: concept.id,
      projectId: null,
      label: concept.label,
      category: concept.category,
      strength: concept.strength,
      x: concept.x,
      y: concept.y,
      links: neighbors.get(concept.id) ?? [],
      summary:
        "A pattern common across many Venom accounts. Aggregate and anonymous — it carries no one's words.",
      mentionCount: 0,
      sources: [],
      lastUpdatedAt: 0,
    }));
  }, [masterBrain]);

  const clusters = useMemo(() => {
    if (isWorkspaceView) {
      // Everything the workspace shares, unfiltered by personal projects.
      return asList(workspaceKnowledgeQuery.data?.clusters);
    }
    if (isNetworkLayer) {
      return masterClusters;
    }
    if (isCompanyLayer) {
      return orgBrain && orgBrain.orgId === layerOrgId ? orgBrain.concepts : [];
    }
    if (!state?.clusters) return [];
    if (isUnsortedLayer) {
      // The holding pen is a review queue, not a map of the active project:
      // it spans every project so nothing waits out of sight.
      return state.clusters.filter((cluster) => cluster.unsorted === true);
    }
    return state.clusters.filter(
      (cluster) =>
        (cluster.projectId === state.activeProjectId ||
          cluster.projectId === null) &&
        cluster.unsorted !== true,
    );
  }, [
    state,
    isWorkspaceView,
    workspaceKnowledgeQuery.data,
    isNetworkLayer,
    masterClusters,
    isCompanyLayer,
    layerOrgId,
    orgBrain,
    isUnsortedLayer,
  ]);

  // Pill badge: how many items wait in the holding area, across all projects.
  const unsortedCount = useMemo(
    () =>
      (state?.clusters ?? []).filter((cluster) => cluster.unsorted === true)
        .length,
    [state?.clusters],
  );

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
    setRemoteConversation(null);
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
    if (
      term.length < 2 ||
      !state ||
      isWorkspaceView ||
      isCompanyLayer ||
      isNetworkLayer
    )
      return [];
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

  const localConversationIds = useMemo(
    () =>
      new Set(
        (state?.conversations ?? []).map((conversation) => conversation.id),
      ),
    [state?.conversations],
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
    setRemoteConversation(null);
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

  // Fetch the opened cited conversation the same way: retry re-enters
  // "loading" to re-run the effect, and closing the panel makes the
  // in-flight read stale.
  useEffect(() => {
    if (!remoteConversation || remoteConversation.status !== "loading") return;
    const { conversationId } = remoteConversation;
    let stale = false;
    getVenomConversation(conversationId)
      .then((detail) => {
        if (stale) return;
        setRemoteConversation((current) =>
          current?.conversationId === conversationId &&
          current.status === "loading"
            ? {
                ...current,
                status: "ready",
                detail,
                title: detail.conversation.title,
              }
            : current,
        );
      })
      .catch((error: unknown) => {
        if (stale) return;
        const missing = error instanceof ApiError && error.status === 404;
        setRemoteConversation((current) =>
          current?.conversationId === conversationId &&
          current.status === "loading"
            ? {
                ...current,
                status: missing ? "missing" : "offline",
                detail: null,
              }
            : current,
        );
      });
    return () => {
      stale = true;
    };
  }, [remoteConversation]);

  // An evidence row opens its cited conversation: in Chat when the device
  // holds it, otherwise as a read-only transcript served from the cloud.
  const openEvidenceConversation = (source: {
    conversationId: string;
    conversationTitle: string;
  }) => {
    const local = state?.conversations.find(
      (conversation) => conversation.id === source.conversationId,
    );
    if (local) {
      setActiveProject(local.projectId);
      setActiveConversation(local.id);
      setLocation("/workspace/chat");
      return;
    }
    setRemoteConversation({
      conversationId: source.conversationId,
      title: source.conversationTitle,
      status: "loading",
      detail: null,
    });
  };

  const handleRename = () => {
    if (isCompanyLayer || isNetworkLayer) return;
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
    if (!selectedCluster || isCompanyLayer || isNetworkLayer) return;
    deleteKnowledgeCluster(selectedCluster.id);
    setSelectedCluster(null);
    setShowDeleteConfirm(false);
  };

  // Who carried a company concept in from their personal Brain, if anyone.
  const promotedBy = useMemo(() => {
    if (!isCompanyLayer || !orgBrain || !selectedCluster) return null;
    return (
      orgBrain.audit.find((entry) => entry.conceptId === selectedCluster.id) ??
      null
    );
  }, [isCompanyLayer, orgBrain, selectedCluster]);

  const handlePromote = async () => {
    if (!selectedCluster || isCompanyLayer || isNetworkLayer) return;
    const targetOrgId = orgs.length === 1 ? orgs[0].id : promoteTargetOrgId;
    const target = orgs.find((org) => org.id === targetOrgId);
    if (!target) return;
    setPromoteStatus("busy");
    setPromoteMessage(null);
    try {
      await promoteVenomConceptToOrg(target.id, {
        concept: {
          ...selectedCluster,
          sources: selectedCluster.sources.slice(0, 8),
        },
      });
      setPromoteStatus("done");
      setPromoteMessage(`Now in the ${target.name} Brain.`);
    } catch (error) {
      setPromoteStatus("error");
      const data =
        error instanceof ApiError
          ? (error.data as { error?: unknown } | null)
          : null;
      setPromoteMessage(
        data && typeof data.error === "string" && data.error
          ? data.error
          : "Promotion failed. Try again.",
      );
    }
  };

  const updateZoom = (amount: number) =>
    setCamera((current) => ({
      ...current,
      zoom: clamp(current.zoom + amount, 0.62, 1.6),
    }));

  const resetView = () => setCamera(DEFAULT_CAMERA);

  /**
   * The layer filter, shared between the md+ header card and the phone
   * menu. `afterSelect` lets the menu close itself once a layer is picked;
   * `containerClassName` relaxes the stadium chrome where the pills wrap
   * over several rows inside the menu.
   */
  const renderLayerSwitcher = (
    afterSelect?: () => void,
    containerClassName?: string,
  ) => (
    <div
      data-testid="brain-layer-switcher"
      className={cn(
        "pointer-events-auto flex flex-wrap items-center gap-1 rounded-full border border-border/60 bg-background/80 p-1 shadow-soft backdrop-blur-xl",
        containerClassName,
      )}
      role="group"
      aria-label="Brain layer"
    >
      <button
        type="button"
        data-testid="brain-layer-personal"
        onClick={() => {
          switchLayer(null);
          afterSelect?.();
        }}
        aria-pressed={
          !isWorkspaceView &&
          !isCompanyLayer &&
          !isNetworkLayer &&
          !isUnsortedLayer
        }
        className={cn(
          "rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors",
          !isWorkspaceView &&
            !isCompanyLayer &&
            !isNetworkLayer &&
            !isUnsortedLayer
            ? "bg-foreground text-background"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        My Brain
      </button>
      <button
        type="button"
        data-testid="brain-layer-unsorted"
        onClick={() => {
          switchToUnsortedLayer();
          afterSelect?.();
        }}
        aria-pressed={isUnsortedLayer}
        className={cn(
          "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors",
          isUnsortedLayer
            ? "bg-foreground text-background"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Inbox className="h-3 w-3" aria-hidden="true" />
        Unsorted
        {unsortedCount > 0 && (
          <span
            className={cn(
              "rounded-full px-1.5 text-[10px] tabular-nums",
              isUnsortedLayer
                ? "bg-background/20 text-background"
                : "bg-foreground/10 text-foreground",
            )}
            data-testid="badge-unsorted-count"
          >
            {unsortedCount}
          </span>
        )}
      </button>
      {workspaces.map((workspace) => (
        <button
          key={workspace.id}
          type="button"
          data-testid={`brain-layer-workspace-${workspace.id}`}
          onClick={() => {
            switchToWorkspaceLayer(workspace.id);
            afterSelect?.();
          }}
          aria-pressed={layerWorkspaceId === workspace.id}
          className={cn(
            "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors",
            layerWorkspaceId === workspace.id
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Users className="h-3 w-3" aria-hidden="true" />
          <span className="max-w-[9rem] truncate">{workspace.name}</span>
        </button>
      ))}
      {orgs.map((org) => (
        <button
          key={org.id}
          type="button"
          data-testid={`brain-layer-org-${org.id}`}
          onClick={() => {
            switchLayer(org.id);
            afterSelect?.();
          }}
          aria-pressed={layerOrgId === org.id}
          className={cn(
            "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors",
            layerOrgId === org.id
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Building2 className="h-3 w-3" aria-hidden="true" />
          <span className="max-w-[9rem] truncate">{org.name}</span>
        </button>
      ))}
      <button
        type="button"
        data-testid="brain-layer-network"
        onClick={() => {
          switchToNetworkLayer();
          afterSelect?.();
        }}
        aria-pressed={isNetworkLayer}
        className={cn(
          "rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors",
          isNetworkLayer
            ? "bg-foreground text-background"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        Venom network
      </button>
    </div>
  );
  const layerSwitcher = renderLayerSwitcher();

  // Auto-sorting activity: automatic filings (with undo) and pending sharing
  // suggestions. Renders on the personal and Unsorted layers only — it is
  // author-private bookkeeping, never workspace content.
  const movesPanel =
    !isWorkspaceView &&
    !isCompanyLayer &&
    !isNetworkLayer &&
    (moveNotices.length > 0 || moveSuggestions.length > 0) ? (
      <div
        className="pointer-events-auto w-full max-w-xs space-y-2"
        data-testid="brain-move-activity"
      >
        {moveNotices.map((notice) => (
          <div
            key={notice.id}
            className="rounded-xl border border-border/60 bg-background/80 p-3 shadow-soft backdrop-blur-xl"
            data-testid={`move-notice-${notice.id}`}
          >
            <p className="text-[11px] leading-snug text-muted-foreground">
              {describeMoveNotice(notice)}
            </p>
            <button
              type="button"
              onClick={() => void handleUndoMove(notice)}
              disabled={moveBusyId !== null}
              className="mt-2 rounded-full border border-border/60 px-3 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-foreground/50 hover:text-foreground disabled:opacity-60"
              data-testid={`button-undo-move-${notice.id}`}
            >
              {moveBusyId === notice.id ? "Undoing…" : "Undo"}
            </button>
          </div>
        ))}
        {moveSuggestions.map((suggestion) => (
          <div
            key={suggestion.id}
            className="rounded-xl border border-border/60 bg-background/80 p-3 shadow-soft backdrop-blur-xl"
            data-testid={`move-suggestion-${suggestion.id}`}
          >
            <p className="text-[11px] leading-snug text-muted-foreground">
              “{suggestion.label}” looks like {suggestion.workspaceName}{" "}
              material. Share it? Everyone in that workspace would see it.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => void handleAcceptShare(suggestion)}
                disabled={moveBusyId !== null}
                className="rounded-full bg-foreground px-3 py-1 text-[11px] font-medium text-background transition-colors hover:bg-foreground/85 disabled:opacity-60"
                data-testid={`button-accept-share-${suggestion.id}`}
              >
                {moveBusyId === suggestion.id ? "Sharing…" : "Share it"}
              </button>
              <button
                type="button"
                onClick={() => void handleDismissShare(suggestion)}
                disabled={moveBusyId !== null}
                className="rounded-full border border-border/60 px-3 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-foreground/50 hover:text-foreground disabled:opacity-60"
                data-testid={`button-dismiss-share-${suggestion.id}`}
              >
                Not now
              </button>
            </div>
          </div>
        ))}
      </div>
    ) : null;

  const companyLoading = isCompanyLayer && !orgBrain && !orgBrainFailed;
  const networkLoading = isNetworkLayer && !masterBrain && !masterBrainFailed;

  // ── Sources view data ──────────────────────────────────────────────────────
  // The connected sources the reader can browse here: the active project's,
  // like the citations a chat answer in that project can cite (mirrors the
  // mobile knowledge screen's project scoping).
  const activeSources = useMemo(
    () =>
      (state?.sources ?? []).filter(
        (source) =>
          !state?.activeProjectId ||
          source.projectId === state.activeProjectId,
      ),
    [state?.sources, state?.activeProjectId],
  );
  activeSourcesRef.current = activeSources;

  // The filter narrows citations, not just cards: a match on the source name
  // keeps its whole list, otherwise only the rows whose title or excerpt
  // match stay — and sources left with nothing drop out entirely.
  const sourceQuery = sourceFilter.trim().toLowerCase();
  const filteredSources = !sourceQuery
    ? activeSources.map((source) => ({ source, citations: source.citations }))
    : activeSources
        .map((source) => ({
          source,
          citations: sourceTextMatches(source.name, sourceQuery)
            ? source.citations
            : source.citations.filter(
                (citation) =>
                  sourceTextMatches(citation.title, sourceQuery) ||
                  sourceTextMatches(citation.excerpt, sourceQuery),
              ),
        }))
        .filter(
          (entry) =>
            entry.citations.length > 0 ||
            sourceTextMatches(entry.source.name, sourceQuery),
        );

  // A jump can outlive its target: the cited source may have been
  // disconnected since the answer was written, or belong to another project.
  // Waiting for `isReady` keeps the notice from flashing while the workspace
  // is still hydrating and the source list is momentarily empty.
  const jumpTargetMissing =
    isReady &&
    highlightedSourceId !== null &&
    !activeSources.some((source) => source.id === highlightedSourceId);
  const jumpTargetElsewhere = jumpTargetMissing
    ? ((state?.sources ?? []).find(
        (source) => source.id === highlightedSourceId,
      ) ?? null)
    : null;
  const jumpTargetProjectName = jumpTargetElsewhere
    ? (state?.projects?.find(
        (project) => project.id === jumpTargetElsewhere.projectId,
      )?.name ?? null)
    : null;

  // Jump markers point at where the reader arrived, not a lasting selection:
  // leaving the sources view — or dismissing the notice — retires them and
  // whatever scroll is still parked on them.
  const retireJumpMarkers = () => {
    pendingScrollRef.current = null;
    setHighlightedSourceId(null);
    setHighlightedCitationId(null);
  };

  // Map ⇄ sources toggle. Personal tier only: connected sources belong to
  // the reader's projects, so company, network, and shared-workspace layers
  // have no evidence list to show. `afterSelect` closes the phone menu once
  // a view is picked.
  const renderViewToggle = (afterSelect?: () => void) =>
    !isWorkspaceView &&
    !isCompanyLayer &&
    !isNetworkLayer &&
    !isUnsortedLayer ? (
      <div
        role="group"
        aria-label="Knowledge view"
        className="pointer-events-auto flex w-fit items-center gap-1 rounded-full border border-border/60 bg-background/80 p-1 shadow-soft backdrop-blur-xl"
      >
        {(
          [
            { key: "map", label: "Map", aria: "Show knowledge map" },
            {
              key: "sources",
              label: `Sources · ${activeSources.length}`,
              aria: `Show ${activeSources.length} connected source${activeSources.length === 1 ? "" : "s"}`,
            },
          ] as const
        ).map((option) => {
          const isActive = view === option.key;
          return (
            <button
              key={option.key}
              type="button"
              aria-pressed={isActive}
              aria-label={option.aria}
              data-testid={`knowledge-view-${option.key}`}
              onClick={() => {
                if (option.key !== "map") {
                  // The map keeps its camera while hidden, but its open
                  // panes close so the same citation can't render twice.
                  setSelectedCluster(null);
                  setRemoteConcept(null);
                  setRemoteConversation(null);
                }
                if (option.key !== "sources") retireJumpMarkers();
                setView(option.key);
                afterSelect?.();
              }}
              className={cn(
                "rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors",
                isActive
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    ) : null;
  const viewToggle = renderViewToggle();

  /** What the collapsed phone bar names: the layer the map is showing. */
  const activeLayerLabel = isUnsortedLayer
    ? "Unsorted"
    : isNetworkLayer
      ? "Venom network"
      : isWorkspaceView && activeWorkspace
        ? activeWorkspace.name
        : isCompanyLayer && activeOrg
          ? activeOrg.name
          : "My Brain";

  /**
   * Everything the floating header card holds below its title: counts and
   * export, the view toggle, the layer switcher, and the layer-scoped extras
   * (auto-sort notices, company/network notes, network suggestions). Shared
   * verbatim between the md+ card and the phone menu so both carry identical
   * test ids and accessible names. `afterSelect` closes the phone menu when
   * a layer or view is picked; `inMenu` relaxes the pill chrome that only
   * makes sense floating over the map.
   */
  const renderHeaderControls = ({
    afterSelect,
    inMenu = false,
  }: {
    afterSelect?: () => void;
    inMenu?: boolean;
  } = {}) => {
    const toggle = renderViewToggle(afterSelect);
    return (
      <>
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium">
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
          {/* The network map has no export surface: aggregates stay in
              the app, where the privacy framing travels with them. */}
          {!isNetworkLayer && (
            <button
              type="button"
              onClick={handleExport}
              disabled={exporting}
              className="flex items-center gap-1.5 rounded-full border border-border/60 px-3 py-1 text-muted-foreground transition-colors hover:border-foreground/50 hover:text-foreground disabled:opacity-60"
              data-testid="button-export-brain"
              aria-label={
                isWorkspaceView
                  ? "Download this workspace's knowledge as Markdown"
                  : "Download your knowledge as Markdown"
              }
            >
              {exporting ? (
                <Loader2
                  className="h-3 w-3 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <Download className="h-3 w-3" aria-hidden="true" />
              )}
              Export .md
            </button>
          )}
        </div>
        {toggle && <div className="mt-3">{toggle}</div>}
        <div className="mt-3">
          {renderLayerSwitcher(
            afterSelect,
            inMenu ? "rounded-2xl border-0 bg-transparent p-0 shadow-none backdrop-blur-none" : undefined,
          )}
        </div>
        {movesPanel && <div className="mt-3">{movesPanel}</div>}
        {isCompanyLayer && (
          <p
            className="mt-3 max-w-[17rem] text-[11px] leading-snug text-muted-foreground"
            data-testid="brain-org-note"
          >
            Shared company layer — every member of {activeOrg?.name} sees
            this same map.
          </p>
        )}
        {isNetworkLayer && (
          <p
            className="mt-3 max-w-[17rem] text-[11px] leading-snug text-muted-foreground"
            data-testid="brain-network-note"
          >
            Venom's shared map — anonymous, aggregate patterns from
            accounts that chose to contribute. No names, no words, no
            traces.
          </p>
        )}
        {!isNetworkLayer && !isWorkspaceView && networkSuggestions.length > 0 && (
          <div
            className="mt-3 max-w-xs"
            data-testid="brain-network-suggestions"
          >
            <p className="mb-2 text-[11px] font-medium text-muted-foreground">
              Related in the Venom network
            </p>
            <div className="flex flex-wrap gap-1.5">
              {networkSuggestions.map((suggestion) => (
                <span
                  key={suggestion.label}
                  className={cn(
                    "flex items-center gap-1 rounded-full border border-border/60 bg-background/80 py-1 pl-3 pr-1 text-[11px] font-medium",
                    suggestionBusyLabel === suggestion.label &&
                      "opacity-60",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => void handleApplySuggestion(suggestion)}
                    disabled={suggestionBusyLabel !== null}
                    className="text-muted-foreground transition-colors hover:text-foreground disabled:cursor-default"
                    data-testid={`suggestion-apply-${suggestion.label}`}
                    title={
                      suggestion.relatedToLabels.length > 0
                        ? `Often connected to ${suggestion.relatedToLabels.join(", ")}`
                        : "From Venom's shared knowledge network"
                    }
                  >
                    + {suggestion.label}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDismissSuggestion(suggestion)}
                    disabled={suggestionBusyLabel !== null}
                    className="flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                    aria-label={`Dismiss ${suggestion.label}`}
                    data-testid={`suggestion-dismiss-${suggestion.label}`}
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
      </>
    );
  };

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

  // The sources view replaces the map wholesale — including its empty state:
  // a reader can have connected sources (and cited answers) before the Brain
  // has grown a single cluster.
  if (view === "sources" && !isWorkspaceView) {
    const now = Date.now();
    return (
      <div className="flex h-full flex-col overflow-hidden bg-background">
        <header className="z-20 flex flex-col gap-4 border-b border-border/60 p-6 pb-5 md:px-10 md:pt-8">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <h1 className="text-2xl font-medium tracking-tight">Brain</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Connected sources and every citation they carry, ready to
                open and verify.
              </p>
            </div>
            {viewToggle}
          </div>
          {activeSources.length > 0 && (
            <div className="group relative w-full max-w-md">
              <Search
                className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-foreground"
                aria-hidden="true"
              />
              <Input
                value={sourceFilter}
                onChange={(event) => setSourceFilter(event.target.value)}
                placeholder="Filter sources and citations..."
                aria-label="Filter sources and citations"
                data-testid="knowledge-source-filter"
                className="h-11 rounded-full border-border/60 bg-background/80 pl-11 pr-11 text-sm focus-visible:border-foreground/40 focus-visible:ring-0"
              />
              {sourceFilter.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSourceFilter("")}
                  aria-label="Clear source filter"
                  data-testid="knowledge-source-filter-clear"
                  className="absolute right-3 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          )}
        </header>

        <div
          className="flex-1 overflow-y-auto px-6 py-6 md:px-10"
          data-testid="knowledge-source-list"
        >
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 pb-10">
            {jumpTargetMissing && (
              <div
                className="flex items-start gap-3 rounded-2xl border border-border/60 bg-card p-4"
                role="status"
                data-testid="knowledge-jump-missing"
              >
                <Info
                  className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    That cited source isn't in this list
                  </p>
                  <p
                    className="mt-1 text-sm leading-relaxed text-muted-foreground"
                    data-testid="knowledge-jump-missing-reason"
                  >
                    {jumpTargetElsewhere
                      ? `“${jumpTargetElsewhere.name}” is connected to ${
                          jumpTargetProjectName
                            ? `the “${jumpTargetProjectName}” project`
                            : "a different project"
                        }, so nothing here is marked. Switch projects to browse its citations.`
                      : "The source that answer cited is no longer connected, so nothing here is marked."}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={retireJumpMarkers}
                  aria-label="Dismiss the cited source notice"
                  data-testid="knowledge-jump-missing-dismiss"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            )}

            {activeSources.length === 0 ? (
              <div
                className="flex flex-col items-center rounded-2xl border border-border/60 bg-card px-6 py-12 text-center"
                data-testid="knowledge-sources-empty"
              >
                <LinkIcon
                  className="mb-4 h-6 w-6 text-muted-foreground"
                  aria-hidden="true"
                />
                <h2 className="mb-2 text-lg font-medium">
                  No connected sources yet
                </h2>
                <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
                  Connect a GitHub repository or a website from the Venom
                  mobile app and its citations will be listed here, ready to
                  open and verify.
                </p>
              </div>
            ) : filteredSources.length === 0 ? (
              <div
                className="flex flex-col items-center rounded-2xl border border-border/60 bg-card px-6 py-12 text-center"
                data-testid="knowledge-filter-empty"
              >
                <Search
                  className="mb-4 h-6 w-6 text-muted-foreground"
                  aria-hidden="true"
                />
                <h2 className="mb-2 text-lg font-medium">
                  No matches for “{sourceFilter.trim()}”
                </h2>
                <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
                  {`Nothing in your ${activeSources.length} connected source${
                    activeSources.length === 1 ? "" : "s"
                  } matches that filter. Clear it to browse every citation again.`}
                </p>
                <Button
                  variant="outline"
                  className="mt-5 h-9 rounded-full px-4 text-sm font-normal"
                  onClick={() => setSourceFilter("")}
                  data-testid="knowledge-filter-empty-clear"
                >
                  Clear filter
                  <X className="ml-2 h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>
            ) : (
              filteredSources.map(({ source, citations }) => {
                const isHighlighted = highlightedSourceId === source.id;
                return (
                  <article
                    key={source.id}
                    ref={(node) => {
                      if (node) sourceNodesRef.current.set(source.id, node);
                      else sourceNodesRef.current.delete(source.id);
                    }}
                    className={cn(
                      "scroll-mt-4 rounded-2xl border bg-card p-4 transition-colors md:p-5",
                      isHighlighted ? "border-foreground/70" : "border-border/60",
                    )}
                    data-testid={`knowledge-source-${source.id}`}
                  >
                    {isHighlighted && (
                      <p
                        className="mb-3 flex w-fit items-center gap-1.5 rounded-full bg-foreground px-2.5 py-1 text-[11px] font-medium text-background"
                        data-testid={`knowledge-source-highlight-${source.id}`}
                      >
                        <CornerDownRight
                          className="h-3 w-3"
                          aria-hidden="true"
                        />
                        Cited in your answer
                      </p>
                    )}
                    <div className="flex items-center gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background">
                        {source.provider === "github" ? (
                          <Github className="h-4 w-4" aria-hidden="true" />
                        ) : (
                          <Globe className="h-4 w-4" aria-hidden="true" />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <h2 className="truncate text-sm font-medium">
                          {source.name}
                        </h2>
                        <p
                          className="truncate text-xs text-muted-foreground"
                          data-testid={`knowledge-source-meta-${source.id}`}
                        >
                          {`${
                            citations.length === source.citations.length
                              ? `${source.citations.length} citation${
                                  source.citations.length === 1 ? "" : "s"
                                }`
                              : `${citations.length} of ${source.citations.length} citations`
                          } · ${describeLastSync(source.syncedAt, now)}`}
                        </p>
                      </div>
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open ${source.name}`}
                        data-testid={`knowledge-open-source-${source.id}`}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                      >
                        <ExternalLink className="h-4 w-4" aria-hidden="true" />
                      </a>
                    </div>
                    {citations.length > 0 && (
                      <ul className="mt-4 flex flex-col gap-1 border-t border-border/60 pt-3">
                        {citations.map((citation) => {
                          const isCitationHighlighted =
                            isHighlighted &&
                            highlightedCitationId === citation.id;
                          return (
                            <li key={citation.id}>
                              <a
                                ref={(node) => {
                                  if (node) {
                                    citationNodesRef.current.set(
                                      citation.id,
                                      node,
                                    );
                                  } else {
                                    citationNodesRef.current.delete(
                                      citation.id,
                                    );
                                  }
                                }}
                                href={citation.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                aria-label={`Open source: ${citation.title}`}
                                data-testid={`knowledge-citation-${citation.id}`}
                                className={cn(
                                  "flex scroll-mt-4 items-start justify-between gap-3 rounded-xl border border-transparent px-3 py-2.5 transition-colors hover:bg-foreground/5",
                                  isCitationHighlighted &&
                                    "border-foreground/70 bg-foreground/[0.04]",
                                )}
                              >
                                <span className="min-w-0 flex-1">
                                  {isCitationHighlighted && (
                                    <span
                                      className="mb-1.5 flex w-fit items-center gap-1.5 rounded-full bg-foreground px-2.5 py-0.5 text-[11px] font-medium text-background"
                                      data-testid={`knowledge-citation-highlight-${citation.id}`}
                                    >
                                      <CornerDownRight
                                        className="h-3 w-3"
                                        aria-hidden="true"
                                      />
                                      Quoted in your answer
                                    </span>
                                  )}
                                  <span className="block truncate text-sm font-medium text-foreground">
                                    {citation.title}
                                  </span>
                                  <span className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                                    {citation.excerpt}
                                  </span>
                                </span>
                                <ExternalLink
                                  className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground"
                                  aria-hidden="true"
                                />
                              </a>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </article>
                );
              })
            )}
          </div>
        </div>
      </div>
    );
  }

  if (clusters.length === 0) {
    return (
      <div className="flex flex-col h-full bg-background relative overflow-hidden p-6 md:p-10">
        <header className="mb-8 z-20 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-medium tracking-tight">Brain</h1>
            {isWorkspaceView && activeWorkspace && (
              <p className="mt-1 text-sm text-muted-foreground">
                Shared · {activeWorkspace.name}
              </p>
            )}
          </div>
          <div className="flex flex-col items-start gap-3 md:items-end">
            {viewToggle}
            {layerSwitcher}
            {movesPanel}
          </div>
        </header>
        <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-border bg-background/50 text-muted-foreground">
          <BrainCircuit className="w-16 h-16 mb-6 opacity-20 text-foreground animate-pulse" />
          {isNetworkLayer ? (
            networkLoading ? (
              <p className="text-sm" data-testid="brain-network-loading">
                Reaching the Venom network…
              </p>
            ) : masterBrainFailed ? (
              <>
                <h2 className="mb-2 text-lg font-medium text-foreground">
                  Venom network unreachable
                </h2>
                <p className="max-w-sm text-center text-sm">
                  Venom keeps the shared map on the server. Check your
                  connection and try again.
                </p>
              </>
            ) : (
              <>
                <h2 className="mb-2 text-lg font-medium text-foreground">
                  The network map is still forming
                </h2>
                <p
                  className="max-w-sm text-center text-sm"
                  data-testid="brain-network-empty"
                >
                  Concepts appear here only once they are common across many
                  accounts — anonymous patterns of ideas, never anyone's
                  words.
                </p>
              </>
            )
          ) : isCompanyLayer ? (
            companyLoading ? (
              <p className="text-sm" data-testid="brain-org-loading">
                Reaching the company Brain…
              </p>
            ) : orgBrainFailed ? (
              <>
                <h2 className="mb-2 text-lg font-medium text-foreground">
                  Company Brain unreachable
                </h2>
                <p className="max-w-sm text-center text-sm">
                  Venom keeps retrying in the background. Check your
                  connection, or whether you are still a member of{" "}
                  {activeOrg?.name}.
                </p>
              </>
            ) : (
              <>
                <h2 className="mb-2 text-lg font-medium text-foreground">
                  Nothing shared yet
                </h2>
                <p className="max-w-sm text-center text-sm">
                  Chats in shared projects, company sources, and promoted
                  concepts grow this Brain for everyone in {activeOrg?.name}.
                </p>
              </>
            )
          ) : isUnsortedLayer ? (
            <>
              <h2 className="mb-2 text-lg font-medium text-foreground">
                Nothing waiting to be sorted
              </h2>
              <p
                className="max-w-sm text-center text-sm"
                data-testid="brain-unsorted-empty"
              >
                When Venom isn't sure whether something is personal or belongs
                to a workspace, it waits here — visible only to you — until
                the destination becomes clear.
              </p>
            </>
          ) : (
            <>
              <h2 className="mb-2 text-lg font-medium text-foreground">
                {isWorkspaceView ? "Nothing shared yet" : "Nothing mapped yet"}
              </h2>
              <p className="max-w-sm text-center text-sm">
                {isWorkspaceView
                  ? "Chat about this workspace's work and Venom will file what your team learns here, for every member."
                  : "Start a chat and Venom will build a map of what it learns."}
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background relative overflow-hidden">
      <header
        data-testid="brain-map-header"
        className="absolute top-0 left-0 right-0 p-4 md:p-8 flex flex-col md:flex-row md:items-start justify-between z-20 pointer-events-none gap-3 md:gap-6"
      >
        {isMobile ? (
          // Phone: the card collapses into a single pill bar so the map
          // stays visible; everything the card held lives in the menu.
          <div className="pointer-events-auto">
            <h1 className="sr-only">Brain</h1>
            <Popover open={headerMenuOpen} onOpenChange={setHeaderMenuOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-testid="brain-menu-trigger"
                  className="sheen flex h-11 w-full items-center gap-2 rounded-full border border-border/60 bg-background/80 pl-4 pr-3 shadow-lift backdrop-blur-xl transition-colors hover:border-foreground/40 focus-visible:border-foreground/60 focus-visible:outline-none"
                >
                  <span className="sr-only">Brain map menu:</span>
                  <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">
                    {activeLayerLabel}
                  </span>
                  <span className="shrink-0 rounded-full bg-foreground px-2.5 py-1 text-[11px] font-medium leading-none text-background">
                    {clusters.length} {clusters.length === 1 ? "node" : "nodes"}
                  </span>
                  {unsortedCount > 0 && (
                    <span
                      data-testid="badge-unsorted-count-collapsed"
                      title={`${unsortedCount} waiting in Unsorted`}
                      className="flex shrink-0 items-center gap-1 rounded-full border border-border/60 px-2 py-1 text-[11px] font-medium leading-none tabular-nums text-muted-foreground"
                    >
                      <Inbox className="h-3 w-3" aria-hidden="true" />
                      {unsortedCount}
                      <span className="sr-only">waiting in Unsorted</span>
                    </span>
                  )}
                  <ChevronDown
                    className={cn(
                      "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-300",
                      headerMenuOpen && "rotate-180",
                    )}
                    aria-hidden="true"
                  />
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                sideOffset={8}
                aria-label="Brain map menu"
                data-testid="brain-menu"
                className="max-h-[min(var(--radix-popover-content-available-height),70vh)] w-[var(--radix-popover-trigger-width)] overflow-y-auto rounded-2xl border-border/60 bg-background/95 p-4 shadow-lift backdrop-blur-xl"
              >
                {renderHeaderControls({
                  afterSelect: () => setHeaderMenuOpen(false),
                  inMenu: true,
                })}
              </PopoverContent>
            </Popover>
          </div>
        ) : (
          <div className="pointer-events-auto rounded-2xl border border-border/60 bg-background/80 p-4 shadow-lift backdrop-blur-xl md:p-5 sheen">
            <h1 className="mb-3 text-2xl font-semibold leading-none tracking-tight">
              Brain
            </h1>
            {renderHeaderControls()}
          </div>
        )}

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
                  "flex items-center gap-1.5 rounded-full px-3 py-1 whitespace-nowrap font-medium transition-all",
                  isSelected
                    ? "bg-foreground text-background scale-105 shadow-lift"
                    : "bg-background/70 text-foreground border border-border/60 backdrop-blur-sm shadow-soft group-hover:border-foreground/40",
                )}
                style={{ fontSize: Math.max(10, Math.min(13, 11 * node.scale)) }}
              >
                {node.cluster.sensitive === true && (
                  <Lock
                    className="h-3 w-3 shrink-0"
                    aria-label="Sensitive"
                    data-testid={`lock-node-${node.cluster.id}`}
                  />
                )}
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
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background">
                      {selectedCluster.category}
                    </div>
                    {isCompanyLayer && (
                      <div
                        className="flex min-w-0 items-center gap-1.5 rounded-full border border-border/60 px-3 py-1 text-xs font-medium text-muted-foreground"
                        data-testid="brain-detail-org-badge"
                      >
                        <Building2
                          className="h-3 w-3 shrink-0"
                          aria-hidden="true"
                        />
                        <span className="truncate">{activeOrg?.name}</span>
                      </div>
                    )}
                    {isNetworkLayer && (
                      <div
                        className="flex min-w-0 items-center gap-1.5 rounded-full border border-border/60 px-3 py-1 text-xs font-medium text-muted-foreground"
                        data-testid="brain-detail-network-badge"
                      >
                        <span className="truncate">Venom network</span>
                      </div>
                    )}
                    {selectedCluster.unsorted === true && (
                      <span
                        className="flex items-center gap-1.5 rounded-full border border-border/60 px-3 py-1 text-xs font-medium text-muted-foreground"
                        data-testid="badge-unsorted-concept"
                      >
                        <Inbox className="h-3 w-3" aria-hidden="true" />
                        Unsorted
                      </span>
                    )}
                    {selectedCluster.sensitive === true && (
                      <span
                        className="flex items-center gap-1.5 rounded-full border border-foreground px-3 py-1 text-xs font-medium text-foreground"
                        data-testid="badge-sensitive-concept"
                      >
                        <Lock className="h-3 w-3" aria-hidden="true" />
                        Sensitive
                      </span>
                    )}
                    {selectedCluster.adminOnly === true && (
                      <span
                        className="flex items-center gap-1.5 rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background"
                        data-testid="badge-restricted-concept"
                      >
                        <ShieldAlert className="h-3 w-3" aria-hidden="true" />
                        Admin-only
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => setSelectedCluster(null)}
                    className="flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                    aria-label="Close details"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {isWorkspaceView && (
                  <div className="mb-6 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        handleConceptLock(
                          selectedCluster,
                          selectedCluster.sensitive !== true,
                        )
                      }
                      disabled={conceptSensitivity.isPending}
                      className={cn(
                        "flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium transition-colors disabled:opacity-60",
                        selectedCluster.sensitive === true
                          ? "bg-foreground text-background hover:bg-foreground/85"
                          : "border border-border/60 text-muted-foreground hover:border-foreground/50 hover:text-foreground",
                      )}
                      data-testid="button-toggle-concept-sensitivity"
                    >
                      {conceptSensitivity.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      ) : selectedCluster.sensitive === true ? (
                        <LockOpen className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      {selectedCluster.sensitive === true
                        ? "Remove sensitivity lock"
                        : "Mark sensitive"}
                    </button>
                    {isWorkspaceAdmin && (
                      <button
                        type="button"
                        onClick={() =>
                          handleConceptRestriction(
                            selectedCluster,
                            selectedCluster.adminOnly !== true,
                          )
                        }
                        disabled={conceptRestriction.isPending}
                        className={cn(
                          "flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium transition-colors disabled:opacity-60",
                          selectedCluster.adminOnly === true
                            ? "bg-foreground text-background hover:bg-foreground/85"
                            : "border border-border/60 text-muted-foreground hover:border-foreground/50 hover:text-foreground",
                        )}
                        data-testid="button-toggle-concept-restriction"
                      >
                        {conceptRestriction.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        ) : selectedCluster.adminOnly === true ? (
                          <ShieldOff className="h-3.5 w-3.5" aria-hidden="true" />
                        ) : (
                          <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        {selectedCluster.adminOnly === true
                          ? "Remove admin-only restriction"
                          : "Restrict to admins"}
                      </button>
                    )}
                  </div>
                )}

                {selectedCluster.unsorted === true &&
                  !isWorkspaceView &&
                  !isCompanyLayer &&
                  !isNetworkLayer && (
                    <div
                      className="mb-6 rounded-xl border border-border/60 bg-foreground/[0.03] p-4"
                      data-testid="panel-unsorted-review"
                    >
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        Venom wasn't sure where this belongs, so only you can
                        see it. Keep it personal, or move it into a shared
                        workspace for your teammates.
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => handleKeepPersonal(selectedCluster)}
                          className="rounded-full bg-foreground px-4 py-2 text-xs font-medium text-background transition-colors hover:bg-foreground/85"
                          data-testid="button-keep-personal"
                        >
                          Keep personal
                        </button>
                        {workspaces.map((workspace) => (
                          <button
                            key={workspace.id}
                            type="button"
                            onClick={() =>
                              void handleMoveUnsorted(
                                selectedCluster,
                                workspace.id,
                              )
                            }
                            disabled={unsortedBusyId !== null}
                            className="flex items-center gap-1.5 rounded-full border border-border/60 px-4 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/50 hover:text-foreground disabled:opacity-60"
                            data-testid={`button-move-unsorted-${workspace.id}`}
                          >
                            <Users className="h-3 w-3" aria-hidden="true" />
                            {unsortedBusyId === selectedCluster.id
                              ? "Moving…"
                              : `Move to ${workspace.name}`}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                {isEditing &&
                !isWorkspaceView &&
                !isCompanyLayer &&
                !isNetworkLayer ? (
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
                      {!isWorkspaceView && !isCompanyLayer && !isNetworkLayer && (
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
                  {promotedBy && (
                    <p
                      className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground"
                      data-testid="brain-detail-promoted-by"
                    >
                      Promoted from a personal Brain by {promotedBy.actorName}
                    </p>
                  )}
                  {isNetworkLayer && (
                    <p
                      className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground"
                      data-testid="brain-detail-network-provenance"
                    >
                      Aggregated across the Venom network from accounts that
                      opted in. No names, excerpts, or account traces — only
                      concept-level patterns.
                    </p>
                  )}
                </div>

                <div className="space-y-8">
                  <div className="flex gap-4">
                    <div className="flex-1 rounded-xl border border-border/60 surface p-5 text-center">
                      <div className="mb-2 text-xs font-medium text-muted-foreground">
                        Mentions
                      </div>
                      <div className="text-3xl font-semibold tabular-nums">
                        {isNetworkLayer ? "—" : selectedCluster.mentionCount}
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

                  <div>
                    <div className="mb-4 border-b border-border/60 pb-2 text-sm font-medium">
                      Evidence · {evidence.total}
                    </div>
                    {evidence.entries.length === 0 ? (
                      <p
                        className="text-sm text-muted-foreground"
                        data-testid="text-evidence-empty"
                      >
                        {isNetworkLayer
                          ? "The network layer carries no evidence by design — only anonymous, aggregate patterns."
                          : "No conversation evidence is attached to this concept yet."}
                      </p>
                    ) : (
                      <ul className="space-y-2" data-testid="list-evidence">
                        {evidence.entries.map((entry, index) => (
                          <li
                            key={`${entry.conversationId}-${index}`}
                            className="rounded-xl border border-border/60 bg-foreground/[0.02] px-4 py-3"
                            data-testid={`evidence-row-${index}`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div
                                  className="flex items-center gap-2 text-sm font-medium"
                                  data-testid={`evidence-person-${index}`}
                                >
                                  {entry.person}
                                  {entry.sensitive && (
                                    <span
                                      className="flex items-center gap-1 rounded-full border border-foreground px-2 py-0.5 text-[10px] font-medium text-foreground"
                                      data-testid={`badge-sensitive-evidence-${index}`}
                                    >
                                      <Lock className="h-2.5 w-2.5" aria-hidden="true" />
                                      Sensitive
                                    </span>
                                  )}
                                </div>
                                <div className="mt-0.5 text-xs text-muted-foreground">
                                  {entry.conversationTitle} · {entry.date}
                                </div>
                              </div>
                              {isWorkspaceView && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleEvidenceLock(
                                      selectedCluster,
                                      entry.conversationId,
                                      !entry.sensitive,
                                    )
                                  }
                                  disabled={evidenceSensitivity.isPending}
                                  className="shrink-0 rounded-full border border-border/60 p-2 text-muted-foreground transition-colors hover:border-foreground/50 hover:text-foreground disabled:opacity-60"
                                  aria-label={
                                    entry.sensitive
                                      ? `Remove sensitivity lock from evidence in ${entry.conversationTitle}`
                                      : `Mark evidence in ${entry.conversationTitle} sensitive`
                                  }
                                  data-testid={`button-toggle-evidence-sensitivity-${index}`}
                                >
                                  {entry.sensitive ? (
                                    <LockOpen className="h-3.5 w-3.5" aria-hidden="true" />
                                  ) : (
                                    <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                                  )}
                                </button>
                              )}
                            </div>
                            <p
                              className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground"
                              data-testid={`evidence-excerpt-${index}`}
                            >
                              {knowledgeDisplayText(
                                entry.excerpt,
                                citationLookup,
                              )}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

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

                  {!isWorkspaceView && !isCompanyLayer && orgs.length > 0 && (
                    <div className="pt-4">
                      <div className="mb-4 flex items-center gap-2 border-b border-border/60 pb-2 text-sm font-medium">
                        <Building2 className="w-4 h-4" aria-hidden="true" />
                        Promote to company Brain
                      </div>
                      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                        Copies this concept and its evidence into the shared
                        company layer. Nothing else leaves your personal
                        Brain.
                      </p>
                      <div className="flex flex-col gap-3">
                        {orgs.length > 1 && (
                          <select
                            data-testid="brain-promote-org"
                            value={promoteTargetOrgId}
                            onChange={(event) =>
                              setPromoteTargetOrgId(event.target.value)
                            }
                            className="h-12 w-full appearance-none rounded-xl border border-border/60 bg-background px-4 text-sm outline-none focus-visible:border-foreground/40 focus-visible:ring-0"
                          >
                            <option value="">Choose a company…</option>
                            {orgs.map((org) => (
                              <option key={org.id} value={org.id}>
                                {org.name}
                              </option>
                            ))}
                          </select>
                        )}
                        <Button
                          size="lg"
                          data-testid="brain-promote-submit"
                          disabled={
                            promoteStatus === "busy" ||
                            (orgs.length > 1 && !promoteTargetOrgId)
                          }
                          className="h-12 w-full rounded-full font-medium"
                          onClick={() => void handlePromote()}
                        >
                          {promoteStatus === "busy"
                            ? "Promoting…"
                            : orgs.length === 1
                              ? `Promote to ${orgs[0].name}`
                              : "Promote"}
                        </Button>
                        {promoteMessage && (
                          <p
                            data-testid="brain-promote-status"
                            role="status"
                            className={cn(
                              "text-xs",
                              promoteStatus === "error"
                                ? "text-destructive"
                                : "text-muted-foreground",
                            )}
                          >
                            {promoteMessage}
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {!isWorkspaceView && !isCompanyLayer && clusters.filter(
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

              {!isWorkspaceView && !isCompanyLayer && (
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
                                  className="overflow-hidden rounded-xl border border-border/60 bg-background"
                                >
                                  <button
                                    type="button"
                                    onClick={() =>
                                      openEvidenceConversation(source)
                                    }
                                    className="w-full px-4 py-3 text-left transition-colors hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    data-testid={`brain-remote-evidence-${source.conversationId}`}
                                    aria-label={
                                      localConversationIds.has(
                                        source.conversationId,
                                      )
                                        ? `Open source conversation ${source.conversationTitle}`
                                        : `Open synced source conversation ${source.conversationTitle}`
                                    }
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
                                  </button>
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

      {/* Cited conversation panel: stacks over the concept panel so the
          trail of proof reads concept → evidence → transcript. Served from
          the cloud snapshot, read-only. */}
      <AnimatePresence>
        {remoteConversation && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="hidden md:block absolute inset-0 bg-background/40 backdrop-blur-sm z-40"
              onClick={() => setRemoteConversation(null)}
            />

            <motion.aside
              initial={{ opacity: 0, y: 100, x: 0 }}
              animate={{ opacity: 1, y: 0, x: 0 }}
              exit={{ opacity: 0, y: 50, x: 0, transition: { duration: 0.2 } }}
              className={cn(
                "absolute z-50 surface flex flex-col overflow-hidden shadow-lift border border-border/60",
                "left-0 right-0 bottom-0 h-[65vh] rounded-t-3xl pb-[env(safe-area-inset-bottom)]",
                "md:left-auto md:top-8 md:bottom-8 md:right-8 md:h-auto md:w-[420px] md:rounded-2xl",
              )}
              aria-labelledby="remote-conversation-title"
              data-testid="brain-remote-conversation"
            >
              <div
                className="md:hidden flex justify-center pt-4 pb-2 cursor-pointer"
                onClick={() => setRemoteConversation(null)}
              >
                <div className="w-12 h-1.5 rounded-full bg-foreground/20" />
              </div>

              <div className="flex-1 overflow-y-auto p-6 md:p-8 scroll-smooth">
                <div className="flex items-center justify-between mb-8">
                  <div className="rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background">
                    Synced conversation
                  </div>
                  <button
                    onClick={() => setRemoteConversation(null)}
                    className="flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                    aria-label="Close synced conversation"
                    data-testid="brain-conversation-close"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <div className="mb-2">
                  <h2
                    id="remote-conversation-title"
                    className="break-words text-3xl font-semibold leading-tight tracking-tight"
                  >
                    {remoteConversation.title}
                  </h2>
                </div>
                <p className="mb-8 text-xs font-medium text-muted-foreground">
                  {remoteConversation.detail
                    ? (remoteConversation.detail.projectName ??
                      "Unknown project")
                    : "From your synced brain"}
                  {" · "}read-only
                </p>

                {remoteConversation.status === "loading" && (
                  <div
                    className="space-y-4"
                    data-testid="brain-conversation-loading"
                  >
                    <Skeleton className="h-16 w-full rounded-xl bg-foreground/5" />
                    <Skeleton className="h-24 w-full rounded-xl bg-foreground/5" />
                    <Skeleton className="h-16 w-2/3 rounded-xl bg-foreground/5" />
                  </div>
                )}

                {remoteConversation.status === "offline" && (
                  <div
                    className="flex flex-col items-center rounded-xl border border-border/60 bg-foreground/[0.03] px-6 py-10 text-center"
                    data-testid="brain-conversation-offline"
                  >
                    <WifiOff
                      className="mb-4 h-8 w-8 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <h3 className="mb-2 text-lg font-medium">
                      Connect to view this conversation
                    </h3>
                    <p className="mb-6 max-w-xs text-sm text-muted-foreground">
                      This conversation lives in your synced brain, not on
                      this device. Go online to read the cited exchange.
                    </p>
                    <Button
                      className="h-11 rounded-full px-6 font-medium"
                      data-testid="brain-conversation-retry"
                      onClick={() =>
                        setRemoteConversation((current) =>
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

                {remoteConversation.status === "missing" && (
                  <div
                    className="rounded-xl border border-border/60 bg-foreground/[0.03] px-6 py-10 text-center text-sm text-muted-foreground"
                    data-testid="brain-conversation-missing"
                  >
                    This conversation is no longer in your synced workspace.
                    It may have been deleted on another device.
                  </div>
                )}

                {remoteConversation.status === "ready" &&
                  remoteConversation.detail && (
                    <div data-testid="brain-conversation-transcript">
                      {remoteConversation.detail.conversation.messages
                        .length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          This conversation has no messages yet.
                        </p>
                      ) : (
                        <ol className="space-y-3">
                          {remoteConversation.detail.conversation.messages.map(
                            (message) => (
                              <li
                                key={message.id}
                                className="rounded-xl border border-border/60 bg-background px-4 py-3"
                                data-testid={`brain-conversation-message-${message.id}`}
                              >
                                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                  {message.role === "user"
                                    ? "You"
                                    : (message.speakerName ?? "Venom")}
                                </p>
                                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                                  {knowledgeDisplayText(
                                    message.content,
                                    remoteCitationLookup,
                                  )}
                                </p>
                              </li>
                            ),
                          )}
                        </ol>
                      )}
                    </div>
                  )}
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
