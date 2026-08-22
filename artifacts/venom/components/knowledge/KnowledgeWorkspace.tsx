import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, ActivityIndicator, findNodeHandle, Platform, ScrollView, Text, TextInput, TouchableOpacity, useWindowDimensions, View } from "react-native";
import { useAuth } from "@clerk/expo";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { fetch } from "expo/fetch";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { cancelAnimation, Easing, runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { ApiError, applyVenomMasterSuggestion, dismissVenomMasterSuggestion, getVenomConversation, getVenomMasterBrain, getVenomMasterSuggestions, getVenomOntologyConcept, getVenomOrgBrain, promoteVenomConceptToOrg, searchVenomOntology, type VenomMasterBrain, type VenomMasterSuggestion, type VenomOntologyConceptDetail, type VenomOntologySearchResult, type VenomOrg, type VenomOrgBrain, type VenomRemoteConversation } from "@workspace/api-client-react";
import { deriveSatelliteNodes, layoutIslands, slimeCapacityForTierName, type SlimeEdge, type SlimeNode } from "@workspace/slime";
import { BrainNoteComposer } from "@/components/BrainNoteComposer";
import { clampGraphValue, DEFAULT_GRAPH_CAMERA, type GraphCamera, type GraphConnection, MAX_LIVE_CONNECTIONS, type ProjectedGraphCluster, projectGraphCluster } from "@/components/knowledge/graphProjection";
import { SymbioteConnection, SymbioteNode } from "@/components/knowledge/SymbioteGraph";
import { SymbioteSlime, type SlimeTelemetrySample } from "@/components/SymbioteSlime";
import { type KnowledgeCitationLookup, knowledgeDisplayText } from "@/context/knowledgeState";
import { IS_ORG_UI_TEST, IS_READ_ONLY_UI_TEST, IS_UI_TEST, KnowledgeCluster, type ProjectSource, useVenom } from "@/context/VenomContext";
import { useColors } from "@/hooks/useColors";
import { UI_TEST_CHAT_TOKEN } from "@/lib/uiTestChat";
import { styles } from "./styles";

/**
 * Test hook: `?slimeTier=full` pins the goo renderer tier so captures can
 * show the whole organism on software rasterizers that live rendering would
 * (correctly) tier down. Inert outside UI-test mode and on native.
 */
const SLIME_CAPACITY_OVERRIDE =
  IS_UI_TEST && typeof globalThis.location !== "undefined"
    ? slimeCapacityForTierName(
        new URLSearchParams(globalThis.location.search).get("slimeTier") ?? "",
      )
    : null;

/**
 * Test hook: `?slimeScale=0.5` pins the goo surface fraction and turns
 * frame-time adaptation off, so visual captures stay deterministic on
 * software rasterizers. Inert outside UI-test mode and on native.
 */
const SLIME_SCALE_OVERRIDE = (() => {
  if (!IS_UI_TEST || typeof globalThis.location === "undefined") return null;
  const raw = new URLSearchParams(globalThis.location.search).get("slimeScale");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 1) : null;
})();

/**
 * UI-test hook: `?slimeTier=off` skips mounting the GL slime layer entirely.
 * WebGL-unavailable is an already-supported product state (the plain map
 * keeps the full interaction contract), so specs that never assert the goo
 * ride this to skip SwiftShader context creation and shader compiles.
 */
const SLIME_DISABLED =
  IS_UI_TEST &&
  typeof globalThis.location !== "undefined" &&
  new URLSearchParams(globalThis.location.search).get("slimeTier") === "off";

/**
 * Dev-only goo performance HUD.
 *
 * On a phone (Expo Go or a dev build) the badge is always available so a
 * human can watch the adaptive surface fraction, cadence, and resize count
 * live — the hardware check for the layout-resize path needs eyes on a real
 * device, and this readout is what makes "did it sharpen, did it settle"
 * answerable without a debugger. On web it exists only for the UI-test spec
 * that proves the readout works (`?slimeHud=1`), so every other browser
 * capture stays clean. Production builds never include it.
 */
const SLIME_HUD_AVAILABLE =
  __DEV__ &&
  (Platform.OS !== "web"
    ? true
    : IS_UI_TEST &&
      typeof globalThis.location?.search === "string" &&
      new URLSearchParams(globalThis.location.search).has("slimeHud"));
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
export function KnowledgeWorkspace({
  onOpenConversation,
  isActive,
}: {
  onOpenConversation: (conversationId: string) => void;
  isActive: boolean;
}) {
  const colors = useColors();
  const router = useRouter();
  const { width: windowWidth } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const {
    state,
    orgs,
    setActiveProject,
    applyFiledKnowledge,
    renameKnowledgeCluster,
    deleteKnowledgeCluster,
    mergeKnowledgeClusters,
  } = useVenom();
  const { getToken } = useAuth();
  // Clerk can hand back a fresh getToken identity on any render; effects that
  // fetch with it must not re-arm because of that, so they read this ref.
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);
  const captureButtonRef =
    useRef<React.ElementRef<typeof TouchableOpacity>>(null);
  const [captureButtonFocused, setCaptureButtonFocused] = useState(false);
  // The GL slime is the one boot-time WebGL cost in the app, and workspace
  // pages mount at startup even though Brain may never be opened. Latch on
  // the first activation: nothing GL exists until the user actually visits
  // Brain, and after that the surface stays mounted (the pause contract
  // parks its loop while other tabs are selected).
  const [brainEverActive, setBrainEverActive] = useState(isActive);
  useEffect(() => {
    if (isActive) setBrainEverActive(true);
  }, [isActive]);
  const mountSlime = brainEverActive && !SLIME_DISABLED;
  const [composerProjectId, setComposerProjectId] = useState<string | null>(
    null,
  );
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(
    null,
  );
  // Concept under the user's finger (press-in, before release). Display-time
  // only: it drives the slime's touch reaction, never data.
  const [touchedClusterId, setTouchedClusterId] = useState<string | null>(
    null,
  );
  // Dev goo HUD (see SLIME_HUD_AVAILABLE). Samples arrive ~2/s only while
  // the panel is open; peak/last-resize bookkeeping lives in refs so a
  // closed panel costs nothing.
  const [slimeHudOpen, setSlimeHudOpen] = useState(false);
  const [slimeHudSample, setSlimeHudSample] =
    useState<SlimeTelemetrySample | null>(null);
  const slimeHudPeakRef = useRef(0);
  const slimeHudChangesRef = useRef(0);
  const slimeHudLastResizeAtRef = useRef<number | null>(null);
  const handleSlimeTelemetry = useCallback((sample: SlimeTelemetrySample) => {
    if (sample.scale > slimeHudPeakRef.current) {
      slimeHudPeakRef.current = sample.scale;
    }
    if (sample.changes > slimeHudChangesRef.current) {
      slimeHudChangesRef.current = sample.changes;
      slimeHudLastResizeAtRef.current = Date.now();
    }
    setSlimeHudSample(sample);
  }, []);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [isChoosingMerge, setIsChoosingMerge] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [remoteConcept, setRemoteConcept] = useState<RemoteConceptView | null>(
    null,
  );
  const [remoteConversation, setRemoteConversation] =
    useState<RemoteConversationView | null>(null);

  // ── company Brain layer ───────────────────────────────────────────────────
  const [layerOrgId, setLayerOrgId] = useState<string | null>(null);
  const [orgBrain, setOrgBrain] = useState<VenomOrgBrain | null>(null);
  const [orgBrainFailed, setOrgBrainFailed] = useState(false);
  const [isChoosingPromote, setIsChoosingPromote] = useState(false);
  const [promoteStatus, setPromoteStatus] = useState<
    "idle" | "busy" | "done" | "error"
  >("idle");
  const [promoteMessage, setPromoteMessage] = useState<string | null>(null);
  const activeOrg = useMemo(
    () =>
      layerOrgId ? (orgs.find((org) => org.id === layerOrgId) ?? null) : null,
    [layerOrgId, orgs],
  );
  const isCompanyLayer = activeOrg !== null;

  // ── Venom network layer (anonymous master map) ────────────────────────────
  const [isNetworkLayer, setIsNetworkLayer] = useState(false);
  const [masterBrain, setMasterBrain] = useState<VenomMasterBrain | null>(
    null,
  );
  const [masterBrainFailed, setMasterBrainFailed] = useState(false);
  const [networkSuggestions, setNetworkSuggestions] = useState<
    VenomMasterSuggestion[]
  >([]);
  const [suggestionBusyLabel, setSuggestionBusyLabel] = useState<
    string | null
  >(null);
  const isPersonalLayer = !isCompanyLayer && !isNetworkLayer;

  // Everything scoped to the current layer, cleared in one commit. Reused by
  // the voluntary layer switch and by involuntary access loss (membership
  // push, 403/404), so an open details sheet, remote views, and search
  // results can never outlive membership.
  const clearLayerScopedState = () => {
    setOrgBrain(null);
    setOrgBrainFailed(false);
    setMasterBrain(null);
    setMasterBrainFailed(false);
    setNetworkSuggestions([]);
    setSuggestionBusyLabel(null);
    setSelectedClusterId(null);
    setRemoteConcept(null);
    setRemoteConversation(null);
    setIsRenaming(false);
    setIsChoosingMerge(false);
    setIsConfirmingDelete(false);
    setEditError(null);
    setIsChoosingPromote(false);
    setPromoteStatus("idle");
    setPromoteMessage(null);
    setBrainQuery("");
    setBrainRemoteResults(null);
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

  useEffect(() => {
    if (!layerOrgId || (IS_UI_TEST && !IS_ORG_UI_TEST)) {
      setOrgBrain(null);
      setOrgBrainFailed(false);
      return;
    }
    let stale = false;
    setOrgBrain(null);
    setOrgBrainFailed(false);
    const load = async () => {
      try {
        const token = IS_UI_TEST ? null : await getTokenRef.current();
        if ((!token && !IS_UI_TEST) || stale) return;
        const brain = await getVenomOrgBrain(
          layerOrgId,
          token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
        );
        if (stale) return;
        setOrgBrain(brain);
        setOrgBrainFailed(false);
      } catch (error) {
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
      }
    };
    void load();
    // Poll so teammates' chats and promotions surface without a reload.
    const interval = setInterval(() => void load(), 25_000);
    return () => {
      stale = true;
      clearInterval(interval);
    };
  }, [layerOrgId]);

  // The anonymous master map. One fetch per visit — aggregates rebuild on a
  // slow server cadence, so polling would only burn battery. Plain UI-test
  // runs keep it quiet exactly like the org machinery; the org-enabled
  // browser suite stubs these endpoints alongside the others.
  useEffect(() => {
    if (!isNetworkLayer || (IS_UI_TEST && !IS_ORG_UI_TEST)) {
      return;
    }
    let stale = false;
    setMasterBrain(null);
    setMasterBrainFailed(false);
    (async () => {
      try {
        const token = IS_UI_TEST ? null : await getTokenRef.current();
        if ((!token && !IS_UI_TEST) || stale) return;
        const brain = await getVenomMasterBrain(
          token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
        );
        if (stale) return;
        // A proxy or SPA fallback can answer 200 with a non-JSON body; treat
        // anything without the expected arrays as an unreachable network.
        if (Array.isArray(brain?.concepts) && Array.isArray(brain?.links)) {
          setMasterBrain(brain);
          setMasterBrainFailed(false);
        } else {
          setMasterBrainFailed(true);
        }
      } catch {
        if (!stale) setMasterBrainFailed(true);
      }
    })();
    return () => {
      stale = true;
    };
  }, [isNetworkLayer]);

  // "Related in the Venom network" chips for the layer being mapped. Personal
  // and company layers only — the network layer is where they point to.
  useEffect(() => {
    if (isNetworkLayer || (IS_UI_TEST && !IS_ORG_UI_TEST)) {
      setNetworkSuggestions([]);
      return;
    }
    let stale = false;
    (async () => {
      try {
        const token = IS_UI_TEST ? null : await getTokenRef.current();
        if ((!token && !IS_UI_TEST) || stale) return;
        const response = await getVenomMasterSuggestions(
          layerOrgId ? { org: layerOrgId } : undefined,
          token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
        );
        // Never trust the shape blindly — a proxy can answer 200 with HTML.
        if (!stale)
          setNetworkSuggestions(
            Array.isArray(response?.suggestions) ? response.suggestions : [],
          );
      } catch {
        // No suggestions is a quiet, normal state (opted out, offline, or
        // nothing above the anonymity threshold yet).
        if (!stale) setNetworkSuggestions([]);
      }
    })();
    return () => {
      stale = true;
    };
  }, [isNetworkLayer, layerOrgId]);

  // Aggregate network concepts rendered through the same cluster shape the
  // living map already understands. No sources and no timestamps by design —
  // nothing tenant-scoped survives aggregation.
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
      summary: `Seen across the Venom network as ${concept.category}.`,
      mentionCount: 0,
      lastUpdatedAt: 0,
      sources: [],
    }));
  }, [masterBrain]);

  const visibleClusters = useMemo<KnowledgeCluster[]>(() => {
    if (isNetworkLayer) return masterClusters;
    if (isCompanyLayer) {
      // Every member sees the same map: the org store is the only source.
      return orgBrain && orgBrain.orgId === layerOrgId
        ? orgBrain.concepts
        : [];
    }
    // Unsorted holdings stay out of the personal graph: they wait in the
    // Brain page's Unsorted layer until classification (or the author)
    // settles where they belong.
    return state.clusters.filter(
      (cluster: KnowledgeCluster) =>
        cluster.projectId === state.activeProjectId &&
        cluster.unsorted !== true,
    );
  }, [
    isCompanyLayer,
    isNetworkLayer,
    layerOrgId,
    masterClusters,
    orgBrain,
    state.activeProjectId,
    state.clusters,
  ]);
  // Low-confidence extractions held back for review; the chip routes to the
  // Brain page's Unsorted layer, the one review surface for them.
  const unsortedCount = useMemo(
    () =>
      state.clusters.filter(
        (cluster: KnowledgeCluster) => cluster.unsorted === true,
      ).length,
    [state.clusters],
  );
  // Brain notes are summarized from conversation text, so they can carry the
  // same inline `[source:...]` markers an answer stores. Resolving them with
  // the project's citations keeps a live source reading as its title and a
  // disconnected one as its archived reference, never as a raw marker.
  const citationLookup = useMemo<KnowledgeCitationLookup>(
    () => ({
      citationsById: new Map(
        (state.sources ?? [])
          .filter(
            (source: ProjectSource) =>
              source.projectId === state.activeProjectId &&
              source.status === "connected",
          )
          .flatMap((source: ProjectSource) =>
            source.citations.map(
              (citation) => [citation.id, citation] as const,
            ),
          ),
      ),
      archivedById: new Map(
        (state.archivedCitations ?? []).map(
          (archived) => [archived.id, archived] as const,
        ),
      ),
    }),
    [state.activeProjectId, state.archivedCitations, state.sources],
  );
  const selectedCluster =
    visibleClusters.find((cluster) => cluster.id === selectedClusterId) ?? null;
  const composerProject =
    state.projects.find((project) => project.id === composerProjectId) ?? null;

  // Whole-ontology search. The server store is the system of record (it can
  // hold more concepts than a device keeps locally), so ask it first and fall
  // back to the on-device copy offline or in UI-test mode.
  const [brainQuery, setBrainQuery] = useState("");
  const [brainRemoteResults, setBrainRemoteResults] = useState<
    VenomOntologySearchResult[] | null
  >(null);
  useEffect(() => {
    const term = brainQuery.trim();
    // The network layer searches the aggregate map locally; the per-tenant
    // ontology store has nothing anonymous to add there.
    if (term.length < 2 || isNetworkLayer) {
      setBrainRemoteResults(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(async () => {
      try {
        // Browser UI tests stub this endpoint like every other backend read.
        const token = IS_UI_TEST ? UI_TEST_CHAT_TOKEN : await getTokenRef.current();
        if (!token || stale) return;
        const response = await searchVenomOntology(
          { q: term, limit: 20, ...(layerOrgId ? { org: layerOrgId } : {}) },
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!stale) setBrainRemoteResults(response.results);
      } catch {
        // Offline or the store is unreachable: the local list below still
        // answers from the device copy.
        if (!stale) setBrainRemoteResults(null);
      }
    }, 250);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [brainQuery, isNetworkLayer, layerOrgId]);

  const brainSearchResults = useMemo(() => {
    const term = brainQuery.trim().toLowerCase();
    if (term.length < 2) return [];
    const seen = new Set<string>();
    const rows: {
      id: string;
      label: string;
      category: string;
      projectId: string | null;
      evidenceCount: number;
    }[] = [];
    for (const result of brainRemoteResults ?? []) {
      if (seen.has(result.id)) continue;
      seen.add(result.id);
      rows.push({
        id: result.id,
        label: result.label,
        category: result.category,
        projectId: result.projectId,
        evidenceCount: result.evidenceCount,
      });
    }
    // On the company layer only shared concepts may answer; a personal
    // fallback would leak "My Brain" rows into the company view.
    const localPool = isNetworkLayer
      ? masterClusters
      : isCompanyLayer
        ? (orgBrain?.concepts ?? [])
        : state.clusters.filter(
            (cluster: KnowledgeCluster) => cluster.unsorted !== true,
          );
    for (const cluster of localPool) {
      if (seen.has(cluster.id)) continue;
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
  }, [
    brainQuery,
    brainRemoteResults,
    isCompanyLayer,
    isNetworkLayer,
    masterClusters,
    orgBrain,
    state.clusters,
  ]);
  const projectNameById = useMemo(
    () => new Map(state.projects.map((project) => [project.id, project.name])),
    [state.projects],
  );
  const handleOpenSearchResult = useCallback(
    (row: { id: string; label: string; projectId: string | null }) => {
      setIsRenaming(false);
      setIsChoosingMerge(false);
      setIsConfirmingDelete(false);
      setEditError(null);
      setBrainQuery("");
      setBrainRemoteResults(null);
      setRemoteConversation(null);
      if (isNetworkLayer) {
        // Every network row is already on the aggregate map; there is no
        // per-tenant server detail behind a master concept.
        setRemoteConcept(null);
        setSelectedClusterId(row.id);
        return;
      }
      const isLocal = state.clusters.some((cluster) => cluster.id === row.id);
      if (isLocal) {
        setRemoteConcept(null);
        // Company concepts all live on the shared map already; only personal
      // results may need to swap the active project first.
      if (!isCompanyLayer && row.projectId !== state.activeProjectId) {
          setActiveProject(row.projectId);
        }
        setSelectedClusterId(row.id);
        return;
      }
      // Not cached on this device: open the server-backed detail view instead
      // of switching projects toward a node the map cannot render.
      setSelectedClusterId(null);
      setRemoteConcept({
        conceptId: row.id,
        label: row.label,
        projectId: row.projectId,
        status: "loading",
        detail: null,
      });
    },
    [
      isCompanyLayer,
      isNetworkLayer,
      setActiveProject,
      state.activeProjectId,
      state.clusters,
    ],
  );

  // Fetch the opened remote concept. Retry re-enters "loading", which re-runs
  // this effect; closing or replacing the overlay makes the in-flight read
  // stale.
  useEffect(() => {
    if (!remoteConcept || remoteConcept.status !== "loading") return;
    const { conceptId } = remoteConcept;
    let stale = false;
    (async () => {
      try {
        const token = IS_UI_TEST ? UI_TEST_CHAT_TOKEN : await getToken();
        if (stale) return;
        if (!token) throw new Error("Not signed in");
        const detail = await getVenomOntologyConcept(conceptId, undefined, {
          headers: { Authorization: `Bearer ${token}` },
        });
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
      } catch (error) {
        if (stale) return;
        const missing = error instanceof ApiError && error.status === 404;
        setRemoteConcept((current) =>
          current?.conceptId === conceptId && current.status === "loading"
            ? {
                ...current,
                status: missing ? "missing" : "offline",
                detail: null,
              }
            : current,
        );
      }
    })();
    return () => {
      stale = true;
    };
  }, [getToken, remoteConcept]);

  // Fetch the opened cited conversation the same way: retry re-enters
  // "loading" to re-run the effect, and closing the overlay makes the
  // in-flight read stale.
  useEffect(() => {
    if (!remoteConversation || remoteConversation.status !== "loading") return;
    const { conversationId } = remoteConversation;
    let stale = false;
    (async () => {
      try {
        const token = IS_UI_TEST ? UI_TEST_CHAT_TOKEN : await getToken();
        if (stale) return;
        if (!token) throw new Error("Not signed in");
        const detail = await getVenomConversation(conversationId, {
          headers: { Authorization: `Bearer ${token}` },
        });
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
      } catch (error) {
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
      }
    })();
    return () => {
      stale = true;
    };
  }, [getToken, remoteConversation]);

  // A remote concept usually belongs to another project, so resolve its
  // citation markers against every connected source on the device — not just
  // the active project's — plus the archived record of retired ones.
  const remoteCitationLookup = useMemo<KnowledgeCitationLookup>(
    () => ({
      citationsById: new Map(
        (state.sources ?? [])
          .filter((source: ProjectSource) => source.status === "connected")
          .flatMap((source: ProjectSource) =>
            source.citations.map(
              (citation) => [citation.id, citation] as const,
            ),
          ),
      ),
      archivedById: new Map(
        (state.archivedCitations ?? []).map(
          (archived) => [archived.id, archived] as const,
        ),
      ),
    }),
    [state.archivedCitations, state.sources],
  );
  const localConversationIds = useMemo(
    () => new Set(state.conversations.map((conversation) => conversation.id)),
    [state.conversations],
  );

  const MAP_SIZE = 800;
  const CENTER = MAP_SIZE / 2;
  const baseGraphScale = Math.min(
    0.78,
    Math.max(0.46, (windowWidth - 20) / MAP_SIZE),
  );
  const breath = useSharedValue(0);
  const [graphCamera, setGraphCamera] =
    useState<GraphCamera>(DEFAULT_GRAPH_CAMERA);
  const graphCameraRef = useRef(graphCamera);
  const orbitStartRef = useRef<GraphCamera>(DEFAULT_GRAPH_CAMERA);
  const pinchStartRef = useRef<GraphCamera>(DEFAULT_GRAPH_CAMERA);

  useEffect(() => {
    graphCameraRef.current = graphCamera;
  }, [graphCamera]);

  const commitGraphCamera = useCallback((next: GraphCamera) => {
    graphCameraRef.current = next;
    setGraphCamera(next);
  }, []);

  useEffect(() => {
    cancelAnimation(breath);
    if (!isActive || reduceMotion || IS_READ_ONLY_UI_TEST) {
      breath.value = 0;
      return;
    }
    breath.value = withRepeat(
      withTiming(1, {
        duration: 2600,
        easing: Easing.inOut(Easing.cubic),
      }),
      -1,
      true,
    );
    return () => {
      cancelAnimation(breath);
    };
  }, [breath, isActive, reduceMotion]);

  useEffect(() => {
    if (
      selectedClusterId &&
      !visibleClusters.some((cluster) => cluster.id === selectedClusterId)
    ) {
      setSelectedClusterId(null);
      setIsRenaming(false);
      setIsChoosingMerge(false);
      setIsConfirmingDelete(false);
      setEditError(null);
    }
  }, [selectedClusterId, state.activeProjectId, visibleClusters]);

  // Display-time layout only: pull same-category concepts into visual
  // islands so the mass reads as clusters. Stored positions, counts and the
  // selectable clusters are untouched — these copies only feed geometry.
  const displayClusters = useMemo(
    () => layoutIslands(visibleClusters),
    [visibleClusters],
  );
  const clustersById = useMemo(
    () => new Map(displayClusters.map((cluster) => [cluster.id, cluster])),
    [displayClusters],
  );
  const liveConnections = useMemo<GraphConnection[]>(() => {
    const connections: GraphConnection[] = [];
    const seen = new Set<string>();

    for (const cluster of displayClusters) {
      for (const targetId of cluster.links) {
        const target = clustersById.get(targetId);
        if (!target) continue;

        const id = [cluster.id, target.id].sort().join("::");
        if (seen.has(id)) continue;
        seen.add(id);
        connections.push({
          id,
          from: cluster,
          to: target,
          index: connections.length,
        });
      }
    }

    return connections
      .sort(
        (left, right) =>
          right.from.strength +
          right.to.strength -
          (left.from.strength + left.to.strength),
      )
      .slice(0, MAX_LIVE_CONNECTIONS);
  }, [clustersById, displayClusters]);

  const projectedClusters = useMemo<ProjectedGraphCluster[]>(
    () =>
      displayClusters
        .map((cluster) => ({
          cluster,
          ...projectGraphCluster(cluster, graphCamera, baseGraphScale, CENTER),
        }))
        .sort((left, right) => left.depth - right.depth),
    [CENTER, baseGraphScale, graphCamera, displayClusters],
  );
  const projectedById = useMemo(
    () =>
      new Map(
        projectedClusters.map((projected) => [projected.cluster.id, projected]),
      ),
    [projectedClusters],
  );

  // Feed the slime the same projected geometry the nodes use, so the goo
  // orbits and dives with them instead of drifting behind. Each concept also
  // grows a handful of satellite micro-clumps sized from its real substance
  // (sources and mentions) — goo-only mass that is never counted or labelled.
  const slimeNodes = useMemo<SlimeNode[]>(() => {
    const cores = projectedClusters.map((projected) => ({
      id: projected.cluster.id,
      x: projected.x,
      y: projected.y,
      depth: projected.depth,
      radius: (34 + projected.cluster.strength * 18) * projected.scale * 1.1,
      sourceCount: projected.cluster.sources.length,
      mentionCount: projected.cluster.mentionCount,
    }));
    return [...cores, ...deriveSatelliteNodes(cores)];
  }, [projectedClusters]);

  const slimeEdges = useMemo<SlimeEdge[]>(
    () =>
      liveConnections.map((connection) => ({
        sourceId: connection.from.id,
        targetId: connection.to.id,
      })),
    [liveConnections],
  );

  const orbitGesture = Gesture.Pan()
    .runOnJS(true)
    .maxPointers(1)
    .minDistance(12)
    .onBegin(() => {
      orbitStartRef.current = graphCameraRef.current;
    })
    .onUpdate((event) => {
      const start = orbitStartRef.current;
      commitGraphCamera({
        ...start,
        yaw: start.yaw + event.translationX * 0.009,
        pitch: clampGraphValue(
          start.pitch - event.translationY * 0.007,
          -0.82,
          0.82,
        ),
      });
    })
    .onFinalize((_event, success) => {
      if (success) return;
      commitGraphCamera({
        ...graphCameraRef.current,
        yaw: orbitStartRef.current.yaw,
        pitch: orbitStartRef.current.pitch,
      });
    });

  const zoomGesture = Gesture.Pinch()
    .runOnJS(true)
    .onBegin(() => {
      pinchStartRef.current = graphCameraRef.current;
    })
    .onUpdate((event) => {
      commitGraphCamera({
        ...graphCameraRef.current,
        zoom: clampGraphValue(
          pinchStartRef.current.zoom * event.scale,
          0.7,
          1.65,
        ),
      });
    });

  const graphGesture = Gesture.Simultaneous(orbitGesture, zoomGesture);

  const auraMotionStyle = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 0.16 : 0.12 + breath.value * 0.16,
    transform: [{ scale: reduceMotion ? 1 : 0.9 + breath.value * 0.16 }],
  }));

  const resetView = () => {
    commitGraphCamera(DEFAULT_GRAPH_CAMERA);
  };

  const closeDetails = () => {
    setSelectedClusterId(null);
    setIsRenaming(false);
    setIsChoosingMerge(false);
    setIsConfirmingDelete(false);
    setEditError(null);
    setIsChoosingPromote(false);
    setPromoteStatus("idle");
    setPromoteMessage(null);
  };
  const switchLayer = (orgId: string | null) => {
    if (orgId === layerOrgId && !isNetworkLayer) return;
    setIsNetworkLayer(false);
    setLayerOrgId(orgId);
    clearLayerScopedState();
    if (Platform.OS !== "web") Haptics.selectionAsync();
  };

  const switchToNetworkLayer = () => {
    if (isNetworkLayer) return;
    setLayerOrgId(null);
    setIsNetworkLayer(true);
    clearLayerScopedState();
    if (Platform.OS !== "web") Haptics.selectionAsync();
  };

  const applyNetworkSuggestion = async (suggestion: VenomMasterSuggestion) => {
    if (suggestionBusyLabel) return;
    setSuggestionBusyLabel(suggestion.label);
    try {
      const token = IS_UI_TEST
        ? UI_TEST_CHAT_TOKEN
        : await getTokenRef.current();
      if (!token) return;
      const result = await applyVenomMasterSuggestion(
        { label: suggestion.label, ...(layerOrgId ? { orgId: layerOrgId } : {}) },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setNetworkSuggestions((current) =>
        current.filter((entry) => entry.label !== suggestion.label),
      );
      if (result.filedScope.ownerType === "user") {
        // Same merge chat filing uses, so the concept lands under a standing
        // "network suggestions" conversation instead of a phantom chat.
        applyFiledKnowledge(
          {
            id: "venom-master-suggestions",
            title: "Venom network suggestions",
            projectId: null,
          },
          result.filed ?? [],
        );
      } else if (layerOrgId) {
        try {
          const brain = await getVenomOrgBrain(layerOrgId, {
            headers: { Authorization: `Bearer ${token}` },
          });
          setOrgBrain(brain);
        } catch {
          // The regular company-brain poll will pick the new concept up.
        }
      }
      if (Platform.OS !== "web") {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    } catch {
      // Keep the chip so the user can retry; suggestions that fell below the
      // anonymity threshold disappear on the next fetch anyway.
    } finally {
      setSuggestionBusyLabel(null);
    }
  };

  const dismissNetworkSuggestion = (suggestion: VenomMasterSuggestion) => {
    setNetworkSuggestions((current) =>
      current.filter((entry) => entry.label !== suggestion.label),
    );
    void (async () => {
      try {
        const token = IS_UI_TEST
          ? UI_TEST_CHAT_TOKEN
          : await getTokenRef.current();
        if (!token) return;
        await dismissVenomMasterSuggestion(
          { label: suggestion.label },
          { headers: { Authorization: `Bearer ${token}` } },
        );
      } catch {
        // Dismissal is best-effort; the chip is already gone locally.
      }
    })();
  };


  const openNoteComposer = () => {
    if (!state.activeProjectId) return;
    closeDetails();
    setComposerProjectId(state.activeProjectId);
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  const closeNoteComposer = () => {
    setComposerProjectId(null);
    setTimeout(() => {
      const captureButton = captureButtonRef.current;
      if (Platform.OS === "web") {
        captureButton?.focus?.();
        return;
      }
      const node = findNodeHandle(captureButton);
      if (node) AccessibilityInfo.setAccessibilityFocus(node);
    }, 120);
  };

  const openCluster = (clusterId: string) => {
    setSelectedClusterId(clusterId);
    setRemoteConcept(null);
    setRemoteConversation(null);
    setIsRenaming(false);
    setIsChoosingMerge(false);
    setIsConfirmingDelete(false);
    setEditError(null);
    setIsChoosingPromote(false);
    setPromoteStatus("idle");
    setPromoteMessage(null);
  };
  // Who carried a company concept in from their personal Brain, if anyone.
  const promotedBy = useMemo(() => {
    if (!isCompanyLayer || !orgBrain || !selectedCluster) return null;
    return (
      orgBrain.audit.find((entry) => entry.conceptId === selectedCluster.id) ??
      null
    );
  }, [isCompanyLayer, orgBrain, selectedCluster]);

  const promoteToOrg = async (org: VenomOrg) => {
    if (!selectedCluster || isCompanyLayer || promoteStatus === "busy") return;
    setPromoteStatus("busy");
    setPromoteMessage(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not signed in");
      await promoteVenomConceptToOrg(
        org.id,
        {
          concept: {
            ...selectedCluster,
            sources: selectedCluster.sources.slice(0, 8),
          },
        },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setPromoteStatus("done");
      setPromoteMessage(`Now in the ${org.name} Brain.`);
      setIsChoosingPromote(false);
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
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


  const startRename = () => {
    if (!selectedCluster) return;
    setRenameDraft(selectedCluster.label);
    setEditError(null);
    setIsChoosingMerge(false);
    setIsConfirmingDelete(false);
    setIsRenaming(true);
  };

  const saveRename = () => {
    if (!selectedCluster) return;
    const label = renameDraft.trim();
    if (!label) {
      setEditError("Give this cluster a name before saving.");
      return;
    }
    const hasDuplicateLabel = visibleClusters.some(
      (cluster) =>
        cluster.id !== selectedCluster.id &&
        cluster.label.trim().toLocaleLowerCase() === label.toLocaleLowerCase(),
    );
    if (hasDuplicateLabel) {
      setEditError("That name already exists. Merge the duplicates instead.");
      return;
    }

    renameKnowledgeCluster(selectedCluster.id, label);
    setIsRenaming(false);
    setEditError(null);
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  const selectMergeSource = (sourceCluster: KnowledgeCluster) => {
    if (!selectedCluster) return;
    mergeKnowledgeClusters(selectedCluster.id, sourceCluster.id);
    setIsChoosingMerge(false);
    setEditError(null);
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  const confirmDelete = () => {
    if (!selectedCluster) return;
    deleteKnowledgeCluster(selectedCluster.id);
    closeDetails();
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
  };

  return (
    <View style={styles.workspaceContainer}>
      <View style={styles.knowledgeContainer}>
        {/* Every account can explore the anonymous network layer, so the
            switcher renders even without company memberships. */}
        {(
          <View style={styles.brainLayerRow} testID="brain-layer-switcher">
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.brainLayerRowContent}
              keyboardShouldPersistTaps="handled"
            >
              <TouchableOpacity
                testID="brain-layer-personal"
                style={[
                  styles.brainLayerChip,
                  {
                    backgroundColor: isPersonalLayer
                      ? colors.primary
                      : colors.secondary,
                    borderColor: isPersonalLayer
                      ? colors.primary
                      : colors.border,
                  },
                ]}
                onPress={() => switchLayer(null)}
                accessibilityRole="button"
                accessibilityLabel="Show my personal Brain"
                accessibilityState={{ selected: isPersonalLayer }}
              >
                <Feather
                  name="user"
                  size={12}
                  color={
                    isPersonalLayer
                      ? colors.primaryForeground
                      : colors.mutedForeground
                  }
                />
                <Text
                  style={[
                    styles.brainLayerChipText,
                    {
                      color: isPersonalLayer
                        ? colors.primaryForeground
                        : colors.foreground,
                    },
                  ]}
                >
                  My Brain
                </Text>
              </TouchableOpacity>
              {unsortedCount > 0 && (
                <TouchableOpacity
                  testID="brain-unsorted-pill"
                  style={[
                    styles.brainLayerChip,
                    {
                      backgroundColor: colors.secondary,
                      borderColor: colors.border,
                    },
                  ]}
                  onPress={() => router.push("/knowledge?scope=unsorted")}
                  accessibilityRole="button"
                  accessibilityLabel={`Review ${unsortedCount} unsorted ${
                    unsortedCount === 1 ? "item" : "items"
                  } on the Brain page`}
                >
                  <Feather
                    name="inbox"
                    size={12}
                    color={colors.mutedForeground}
                  />
                  <Text
                    style={[
                      styles.brainLayerChipText,
                      { color: colors.foreground },
                    ]}
                  >
                    Unsorted {unsortedCount}
                  </Text>
                </TouchableOpacity>
              )}
              {orgs.map((org) => {
                const selected = layerOrgId === org.id;
                return (
                  <TouchableOpacity
                    key={org.id}
                    testID={`brain-layer-${org.id}`}
                    style={[
                      styles.brainLayerChip,
                      {
                        backgroundColor: selected
                          ? colors.primary
                          : colors.secondary,
                        borderColor: selected ? colors.primary : colors.border,
                      },
                    ]}
                    onPress={() => switchLayer(org.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`Show the ${org.name} company Brain`}
                    accessibilityState={{ selected }}
                  >
                    <Feather
                      name="users"
                      size={12}
                      color={
                        selected
                          ? colors.primaryForeground
                          : colors.mutedForeground
                      }
                    />
                    <Text
                      style={[
                        styles.brainLayerChipText,
                        {
                          color: selected
                            ? colors.primaryForeground
                            : colors.foreground,
                        },
                      ]}
                      numberOfLines={1}
                    >
                      {org.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
              <TouchableOpacity
                testID="brain-layer-network"
                style={[
                  styles.brainLayerChip,
                  {
                    backgroundColor: isNetworkLayer
                      ? colors.primary
                      : colors.secondary,
                    borderColor: isNetworkLayer
                      ? colors.primary
                      : colors.border,
                  },
                ]}
                onPress={switchToNetworkLayer}
                accessibilityRole="button"
                accessibilityLabel="Show the Venom network map"
                accessibilityState={{ selected: isNetworkLayer }}
              >
                <Feather
                  name="share-2"
                  size={12}
                  color={
                    isNetworkLayer
                      ? colors.primaryForeground
                      : colors.mutedForeground
                  }
                />
                <Text
                  style={[
                    styles.brainLayerChipText,
                    {
                      color: isNetworkLayer
                        ? colors.primaryForeground
                        : colors.foreground,
                    },
                  ]}
                >
                  Venom network
                </Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        )}
        {!isNetworkLayer && networkSuggestions.length > 0 && (
          <View style={styles.networkSuggestRow} testID="network-suggestions">
            <Text
              style={[
                styles.networkSuggestLabel,
                { color: colors.mutedForeground },
              ]}
            >
              Related in the Venom network
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.networkSuggestRowContent}
              keyboardShouldPersistTaps="handled"
            >
              {networkSuggestions.map((suggestion) => (
                <View
                  key={suggestion.label}
                  style={[
                    styles.networkSuggestChip,
                    {
                      backgroundColor: colors.secondary,
                      borderColor: colors.border,
                      opacity:
                        suggestionBusyLabel === suggestion.label ? 0.5 : 1,
                    },
                  ]}
                >
                  <TouchableOpacity
                    style={styles.networkSuggestApply}
                    onPress={() => void applyNetworkSuggestion(suggestion)}
                    disabled={suggestionBusyLabel !== null}
                    accessibilityRole="button"
                    accessibilityLabel={`Add ${suggestion.label} to this Brain from the Venom network`}
                    testID={`suggestion-apply-${suggestion.label}`}
                  >
                    <Feather
                      name="plus"
                      size={12}
                      color={colors.mutedForeground}
                    />
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.networkSuggestText,
                        { color: colors.foreground },
                      ]}
                    >
                      {suggestion.label}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.networkSuggestDismiss}
                    onPress={() => dismissNetworkSuggestion(suggestion)}
                    disabled={suggestionBusyLabel !== null}
                    accessibilityRole="button"
                    accessibilityLabel={`Dismiss the ${suggestion.label} suggestion`}
                    hitSlop={8}
                    testID={`suggestion-dismiss-${suggestion.label}`}
                  >
                    <Feather
                      name="x"
                      size={12}
                      color={colors.mutedForeground}
                    />
                  </TouchableOpacity>
                </View>
              ))}
            </ScrollView>
          </View>
        )}
        <View style={styles.brainSearchWrap}>
          <View
            style={[
              styles.brainSearchField,
              {
                backgroundColor: colors.secondary,
                borderColor: colors.border,
              },
            ]}
          >
            <Feather name="search" size={14} color={colors.mutedForeground} />
            <TextInput
              testID="brain-search-input"
              style={[styles.brainSearchInput, { color: colors.foreground }]}
              placeholder="Search all knowledge"
              placeholderTextColor={colors.mutedForeground}
              value={brainQuery}
              onChangeText={setBrainQuery}
              autoCorrect={false}
              autoCapitalize="none"
              accessibilityLabel="Search all knowledge"
              returnKeyType="search"
            />
            {brainQuery.length > 0 && (
              <TouchableOpacity
                onPress={() => setBrainQuery("")}
                accessibilityRole="button"
                accessibilityLabel="Clear knowledge search"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Feather name="x" size={14} color={colors.mutedForeground} />
              </TouchableOpacity>
            )}
          </View>
          {brainQuery.trim().length >= 2 && (
            <View
              testID="brain-search-results"
              style={[
                styles.brainSearchResults,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                },
              ]}
            >
              {brainSearchResults.length === 0 ? (
                <Text
                  style={[
                    styles.brainSearchEmpty,
                    { color: colors.mutedForeground },
                  ]}
                >
                  No concepts match yet.
                </Text>
              ) : (
                <ScrollView
                  style={styles.brainSearchList}
                  keyboardShouldPersistTaps="handled"
                  nestedScrollEnabled
                >
                  {brainSearchResults.map((row) => (
                    <TouchableOpacity
                      key={row.id}
                      testID={`brain-search-result-${row.id}`}
                      style={styles.brainSearchRow}
                      onPress={() => handleOpenSearchResult(row)}
                      accessibilityRole="button"
                      accessibilityLabel={`Open concept ${row.label}`}
                    >
                      <View style={styles.brainSearchRowText}>
                        <Text
                          style={[
                            styles.brainSearchRowLabel,
                            { color: colors.foreground },
                          ]}
                          numberOfLines={1}
                        >
                          {row.label}
                        </Text>
                        <Text
                          style={[
                            styles.brainSearchRowMeta,
                            { color: colors.mutedForeground },
                          ]}
                          numberOfLines={1}
                        >
                          {row.projectId
                            ? (projectNameById.get(row.projectId) ??
                              "Unknown project")
                            : "No project"}
                          {" · "}
                          {row.category}
                        </Text>
                      </View>
                      <Text
                        style={[
                          styles.brainSearchRowCount,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        {row.evidenceCount}{" "}
                        {row.evidenceCount === 1 ? "source" : "sources"}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
            </View>
          )}
        </View>
        {visibleClusters.length === 0 ? (
          <View
            style={styles.knowledgeEmpty}
            testID={
              isNetworkLayer
                ? "knowledge-empty-network"
                : isCompanyLayer
                  ? "knowledge-empty-company"
                  : "knowledge-empty"
            }
          >
            <View
              style={[
                styles.knowledgeEmptyIcon,
                { backgroundColor: colors.secondary },
              ]}
            >
              <Feather
                name={
                  isNetworkLayer
                    ? "share-2"
                    : isCompanyLayer
                      ? "users"
                      : "git-branch"
                }
                size={24}
                color={colors.primary}
              />
            </View>
            <Text
              style={[styles.knowledgeEmptyTitle, { color: colors.foreground }]}
            >
              {isNetworkLayer
                ? !masterBrain && !masterBrainFailed
                  ? "Reaching the Venom network"
                  : masterBrainFailed
                    ? "The Venom network is unreachable"
                    : "The network map is still forming"
                : isCompanyLayer
                  ? !orgBrain && !orgBrainFailed
                    ? "Waking the company Brain"
                    : orgBrainFailed
                      ? "The company Brain is unreachable"
                      : "No shared knowledge yet"
                  : "Your knowledge map will grow here"}
            </Text>
            <Text
              style={[
                styles.knowledgeEmptyCopy,
                { color: colors.mutedForeground },
              ]}
            >
              {isNetworkLayer
                ? !masterBrain && !masterBrainFailed
                  ? "Fetching the anonymous map."
                  : masterBrainFailed
                    ? "Check your connection, then switch layers to retry."
                    : "Concepts join this map only once they are common across many accounts — anonymous patterns, never anyone's words."
                : isCompanyLayer
                  ? !orgBrain && !orgBrainFailed
                    ? "Fetching what your team has taught it."
                    : orgBrainFailed
                      ? "Venom keeps retrying on its own. Check your connection if this persists."
                      : "Chats in shared projects, company sources, and promoted concepts appear here for every member."
                  : "Finish a project conversation and Venom will map its topics, decisions, and dependencies."}
            </Text>
          </View>
        ) : (
          <View
            testID="knowledge-map"
            style={[
              styles.symbioteStage,
              { backgroundColor: colors.symbioteBackdrop },
            ]}
            accessibilityLabel={`Living ontology with ${visibleClusters.length} selectable knowledge clusters. Camera yaw ${graphCamera.yaw.toFixed(3)}, pitch ${graphCamera.pitch.toFixed(3)}, zoom ${graphCamera.zoom.toFixed(3)}`}
          >
            <View style={styles.symbioteHud} pointerEvents="none">
              <View>
                <Text
                  style={[
                    styles.symbioteEyebrow,
                    { color: colors.symbioteMuted },
                  ]}
                >
                  {isNetworkLayer
                    ? "Venom network · anonymous"
                    : isCompanyLayer
                      ? `${activeOrg?.name ?? "Company"} · shared`
                      : "Live knowledge"}
                </Text>
                <Text
                  style={[
                    styles.symbioteTitle,
                    { color: colors.symbioteHighlight },
                  ]}
                >
                  {visibleClusters.length} living nodes
                </Text>
              </View>
              <View
                style={[
                  styles.symbioteStatus,
                  {
                    backgroundColor: colors.symbiotePanel,
                    borderColor: colors.symbioteSoft,
                  },
                ]}
              >
                <View
                  style={[
                    styles.symbioteStatusDot,
                    { backgroundColor: colors.symbioteHighlight },
                  ]}
                />
                <Text
                  style={[
                    styles.symbioteStatusText,
                    { color: colors.symbioteMuted },
                  ]}
                >
                  {reduceMotion ? "Stable" : "Evolving"}
                </Text>
              </View>
            </View>

            <GestureDetector gesture={graphGesture}>
              <View style={styles.symbioteViewport}>
                <Animated.View
                  style={[
                    styles.symbioteMap,
                    {
                      left: (windowWidth - MAP_SIZE) / 2,
                      top: -36,
                    },
                  ]}
                >
                  <Animated.View
                    pointerEvents="none"
                    style={[
                      styles.symbioteAura,
                      {
                        left: CENTER - 180,
                        top: CENTER - 180,
                        borderColor: colors.symbioteGlow,
                        backgroundColor: colors.symbioteGlow,
                      },
                      auraMotionStyle,
                    ]}
                  />
                  <View
                    pointerEvents="none"
                    style={[
                      styles.symbioteOrbit,
                      {
                        left: CENTER - 235,
                        top: CENTER - 235,
                        borderColor: colors.symbioteGlow,
                      },
                    ]}
                  />
                  <View
                    pointerEvents="none"
                    style={[
                      styles.symbioteOrbitInner,
                      {
                        left: CENTER - 145,
                        top: CENTER - 145,
                        borderColor: colors.symbioteGlow,
                      },
                    ]}
                  />

                  {mountSlime ? (
                    <SymbioteSlime
                      nodes={slimeNodes}
                      edges={slimeEdges}
                      mapSize={MAP_SIZE}
                      isActive={isActive}
                      reduceMotion={reduceMotion}
                      selectedId={selectedCluster?.id ?? null}
                      touchedId={touchedClusterId}
                      capacityOverride={SLIME_CAPACITY_OVERRIDE}
                      surfaceFractionOverride={SLIME_SCALE_OVERRIDE}
                      exposeTelemetry={IS_UI_TEST}
                      onTelemetry={
                        SLIME_HUD_AVAILABLE && slimeHudOpen
                          ? handleSlimeTelemetry
                          : null
                      }
                    />
                  ) : null}

                  {liveConnections.map((connection) => {
                    const from = projectedById.get(connection.from.id);
                    const to = projectedById.get(connection.to.id);
                    if (!from || !to) return null;
                    return (
                      <SymbioteConnection
                        key={connection.id}
                        from={from}
                        to={to}
                        index={connection.index}
                        breath={breath}
                        reduceMotion={reduceMotion}
                        opacity={(from.opacity + to.opacity) / 2}
                      />
                    );
                  })}

                  {projectedClusters.map((projected, index) => (
                    <SymbioteNode
                      key={projected.cluster.id}
                      cluster={projected.cluster}
                      position={projected}
                      index={index}
                      isSelected={selectedCluster?.id === projected.cluster.id}
                      breath={breath}
                      reduceMotion={reduceMotion}
                      depthScale={projected.scale}
                      depthOpacity={projected.opacity}
                      onPress={() => {
                        if (Platform.OS !== "web") Haptics.selectionAsync();
                        openCluster(projected.cluster.id);
                      }}
                      onPressIn={() =>
                        setTouchedClusterId(projected.cluster.id)
                      }
                      onPressOut={() =>
                        setTouchedClusterId((current) =>
                          current === projected.cluster.id ? null : current,
                        )
                      }
                    />
                  ))}
                </Animated.View>
              </View>
            </GestureDetector>

            <View style={styles.symbioteHint} pointerEvents="none">
              <Feather name="move" size={12} color={colors.symbioteMuted} />
              <Text
                style={[
                  styles.symbioteHintText,
                  { color: colors.symbioteMuted },
                ]}
              >
                  {reduceMotion
                    ? "Motion reduced · drag to orbit"
                    : "Drag to orbit · pinch to dive"}
              </Text>
            </View>
            <TouchableOpacity
              style={[
                styles.symbioteReset,
                {
                  backgroundColor: colors.symbiotePanel,
                  borderColor: colors.symbioteSoft,
                },
              ]}
              onPress={resetView}
              testID="knowledge-reset-view"
              accessibilityRole="button"
              accessibilityLabel="Reset ontology view"
              accessibilityHint="Returns the ontology orientation and zoom to default"
            >
              <Feather
                name="maximize-2"
                size={14}
                color={colors.symbioteHighlight}
              />
              <Text
                style={[
                  styles.symbioteResetText,
                  { color: colors.symbioteHighlight },
                ]}
              >
                Reset view
              </Text>
            </TouchableOpacity>

            {SLIME_HUD_AVAILABLE && (
              <>
                <TouchableOpacity
                  style={[
                    styles.slimeHudToggle,
                    {
                      backgroundColor: colors.symbiotePanel,
                      borderColor: colors.symbioteSoft,
                    },
                  ]}
                  onPress={() => {
                    setSlimeHudOpen((open) => {
                      if (open) setSlimeHudSample(null);
                      return !open;
                    });
                  }}
                  testID="slime-hud-toggle"
                  accessibilityRole="button"
                  accessibilityLabel="Toggle goo performance stats"
                  accessibilityHint="Shows live render resolution and frame cadence for the goo surface"
                >
                  <Feather
                    name="activity"
                    size={12}
                    color={
                      slimeHudOpen
                        ? colors.symbioteHighlight
                        : colors.symbioteMuted
                    }
                  />
                  <Text
                    style={[
                      styles.slimeHudToggleText,
                      {
                        color: slimeHudOpen
                          ? colors.symbioteHighlight
                          : colors.symbioteMuted,
                      },
                    ]}
                  >
                    Goo stats
                  </Text>
                </TouchableOpacity>

                {slimeHudOpen && (
                  <View
                    style={[
                      styles.slimeHudPanel,
                      {
                        backgroundColor: colors.symbiotePanel,
                        borderColor: colors.symbioteSoft,
                      },
                    ]}
                    testID="slime-hud-panel"
                    pointerEvents="none"
                  >
                    {slimeHudSample ? (
                      <>
                        <Text
                          style={[
                            styles.slimeHudRow,
                            { color: colors.symbioteHighlight },
                          ]}
                          testID="slime-hud-surface"
                        >
                          {`surface ${slimeHudSample.scale.toFixed(3)} · peak ${slimeHudPeakRef.current.toFixed(3)}${slimeHudSample.pinned ? " · pinned" : ""}`}
                        </Text>
                        <Text
                          style={[
                            styles.slimeHudRow,
                            { color: colors.symbioteMuted },
                          ]}
                        >
                          {`floor ${slimeHudSample.minScale.toFixed(3)} · ceiling ${slimeHudSample.maxScale.toFixed(3)}`}
                        </Text>
                        <Text
                          style={[
                            styles.slimeHudRow,
                            { color: colors.symbioteMuted },
                          ]}
                          testID="slime-hud-buffer"
                        >
                          {`buffer ${slimeHudSample.bufferWidth}\u00d7${slimeHudSample.bufferHeight} · ${Math.round(slimeHudSample.fps)} fps`}
                        </Text>
                        <Text
                          style={[
                            styles.slimeHudRow,
                            { color: colors.symbioteMuted },
                          ]}
                          testID="slime-hud-resizes"
                        >
                          {`resizes ${slimeHudSample.changes}${
                            slimeHudLastResizeAtRef.current != null
                              ? ` · last ${Math.max(0, Math.round((Date.now() - slimeHudLastResizeAtRef.current) / 1000))}s ago`
                              : ""
                          }`}
                        </Text>
                      </>
                    ) : (
                      <Text
                        style={[
                          styles.slimeHudRow,
                          { color: colors.symbioteMuted },
                        ]}
                      >
                        waiting for goo frames…
                      </Text>
                    )}
                  </View>
                )}
              </>
            )}
          </View>
        )}

        {/* Info Panel Overlay */}
        {selectedCluster && (
          <View
            testID="knowledge-cluster-details"
            style={[
              styles.knowledgeInfoPanel,
              {
                backgroundColor: colors.background,
                borderTopColor: colors.border,
              },
            ]}
            accessibilityViewIsModal
            accessibilityLabel={`${selectedCluster.label} cluster details`}
          >
            <ScrollView
              style={styles.knowledgeInfoScroll}
              contentContainerStyle={styles.knowledgeInfoContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
            >
              <View style={styles.knowledgeInfoHeader}>
                <Text
                  style={[
                    styles.knowledgeInfoTitle,
                    { color: colors.foreground },
                  ]}
                >
                  {selectedCluster.label}
                </Text>
                <TouchableOpacity
                  onPress={closeDetails}
                  hitSlop={12}
                  accessibilityRole="button"
                  accessibilityLabel="Close cluster details"
                >
                  <Feather name="x" size={20} color={colors.mutedForeground} />
                </TouchableOpacity>
              </View>
              <Text
                style={[
                  styles.knowledgeInfoDesc,
                  { color: colors.mutedForeground },
                ]}
              >
                {knowledgeDisplayText(selectedCluster.summary, citationLookup)}
              </Text>
              {isCompanyLayer && (
                <Text
                  testID="knowledge-company-provenance"
                  style={[
                    styles.knowledgeCompanyProvenance,
                    { color: colors.mutedForeground },
                  ]}
                >
                  {promotedBy
                    ? `In the ${activeOrg?.name ?? "company"} Brain · promoted from a personal Brain by ${promotedBy.actorName}`
                    : `In the ${activeOrg?.name ?? "company"} Brain · grown from shared work`}
                </Text>
              )}
              {isNetworkLayer && (
                <Text
                  testID="knowledge-network-provenance"
                  style={[
                    styles.knowledgeCompanyProvenance,
                    { color: colors.mutedForeground },
                  ]}
                >
                  From the Venom network · an anonymous pattern aggregated
                  across many accounts. No names, chats, or excerpts travel
                  with it.
                </Text>
              )}
              {!isCompanyLayer && !isNetworkLayer && (
              <View style={styles.knowledgeEditActions}>
                <TouchableOpacity
                  style={[
                    styles.knowledgeEditButton,
                    { borderColor: colors.border },
                  ]}
                  onPress={startRename}
                  testID="knowledge-rename-cluster-button"
                  accessibilityRole="button"
                  accessibilityLabel={`Rename ${selectedCluster.label}`}
                  accessibilityHint="Edit this cluster's label"
                >
                  <Feather name="edit-2" size={15} color={colors.foreground} />
                  <Text
                    style={[
                      styles.knowledgeEditButtonText,
                      { color: colors.foreground },
                    ]}
                  >
                    Rename
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.knowledgeEditButton,
                    { borderColor: colors.border },
                  ]}
                  onPress={() => {
                    setIsRenaming(false);
                    setIsConfirmingDelete(false);
                    setEditError(null);
                    setIsChoosingMerge((value) => !value);
                  }}
                  testID="knowledge-merge-cluster-button"
                  accessibilityRole="button"
                  accessibilityLabel={`Merge another cluster into ${selectedCluster.label}`}
                  accessibilityHint="Moves another cluster's sources and connections into this one"
                >
                  <Feather
                    name="git-merge"
                    size={15}
                    color={colors.foreground}
                  />
                  <Text
                    style={[
                      styles.knowledgeEditButtonText,
                      { color: colors.foreground },
                    ]}
                  >
                    Merge
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.knowledgeEditButton,
                    { borderColor: colors.destructive },
                  ]}
                  onPress={() => {
                    setIsRenaming(false);
                    setIsChoosingMerge(false);
                    setEditError(null);
                    setIsConfirmingDelete((value) => !value);
                  }}
                  testID="knowledge-delete-cluster-button"
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${selectedCluster.label}`}
                  accessibilityHint="Shows a confirmation before permanently deleting this cluster"
                >
                  <Feather
                    name="trash-2"
                    size={15}
                    color={colors.destructive}
                  />
                  <Text
                    style={[
                      styles.knowledgeEditButtonText,
                      { color: colors.destructive },
                    ]}
                  >
                    Delete
                  </Text>
                </TouchableOpacity>
              </View>
              )}
              {!isCompanyLayer && !isNetworkLayer && orgs.length > 0 && (
                <View
                  style={[
                    styles.knowledgePromoteCard,
                    {
                      backgroundColor: colors.card,
                      borderColor: colors.border,
                    },
                  ]}
                >
                  {promoteStatus === "done" && promoteMessage ? (
                    <Text
                      testID="knowledge-promote-status"
                      style={[
                        styles.knowledgeEditHelp,
                        { color: colors.foreground },
                      ]}
                    >
                      {promoteMessage}
                    </Text>
                  ) : isChoosingPromote && orgs.length > 1 ? (
                    <>
                      <Text
                        style={[
                          styles.knowledgeEditLabel,
                          { color: colors.foreground },
                        ]}
                      >
                        Promote into which company?
                      </Text>
                      {orgs.map((org) => (
                        <TouchableOpacity
                          key={org.id}
                          testID={`knowledge-promote-org-${org.id}`}
                          style={[
                            styles.knowledgeMergeOption,
                            { borderColor: colors.border },
                          ]}
                          onPress={() => void promoteToOrg(org)}
                          disabled={promoteStatus === "busy"}
                          accessibilityRole="button"
                          accessibilityLabel={`Promote this concept into ${org.name}`}
                        >
                          <View style={styles.knowledgeMergeOptionCopy}>
                            <Text
                              numberOfLines={1}
                              style={[
                                styles.knowledgeMergeOptionTitle,
                                { color: colors.foreground },
                              ]}
                            >
                              {org.name}
                            </Text>
                          </View>
                          <Feather
                            name="arrow-up-right"
                            size={16}
                            color={colors.primary}
                          />
                        </TouchableOpacity>
                      ))}
                    </>
                  ) : (
                    <TouchableOpacity
                      testID="knowledge-promote-button"
                      style={styles.knowledgePromoteButton}
                      onPress={() => {
                        if (promoteStatus === "busy") return;
                        if (orgs.length === 1) {
                          void promoteToOrg(orgs[0]);
                        } else {
                          setPromoteStatus("idle");
                          setPromoteMessage(null);
                          setIsChoosingPromote(true);
                        }
                      }}
                      disabled={promoteStatus === "busy"}
                      accessibilityRole="button"
                      accessibilityLabel="Promote this concept into a company Brain"
                      accessibilityHint="Copies this concept and its evidence into the shared company Brain"
                      accessibilityState={{
                        disabled: promoteStatus === "busy",
                      }}
                    >
                      <Feather
                        name="arrow-up-right"
                        size={15}
                        color={colors.foreground}
                      />
                      <Text
                        style={[
                          styles.knowledgeEditButtonText,
                          { color: colors.foreground },
                        ]}
                      >
                        {promoteStatus === "busy"
                          ? "Promoting…"
                          : "Promote to company Brain"}
                      </Text>
                    </TouchableOpacity>
                  )}
                  {promoteStatus === "error" && promoteMessage && (
                    <Text
                      testID="knowledge-promote-status"
                      accessibilityRole="alert"
                      style={[
                        styles.knowledgeEditError,
                        { color: colors.destructive },
                      ]}
                    >
                      {promoteMessage}
                    </Text>
                  )}
                </View>
              )}
              {isRenaming && (
                <View
                  style={[
                    styles.knowledgeEditCard,
                    {
                      backgroundColor: colors.card,
                      borderColor: colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.knowledgeEditLabel,
                      { color: colors.foreground },
                    ]}
                  >
                    Rename cluster
                  </Text>
                  <TextInput
                    value={renameDraft}
                    onChangeText={(value) => {
                      setRenameDraft(value);
                      if (editError) setEditError(null);
                    }}
                    style={[
                      styles.knowledgeRenameInput,
                      {
                        color: colors.foreground,
                        borderColor: editError
                          ? colors.destructive
                          : colors.border,
                      },
                    ]}
                    placeholder="Cluster name"
                    placeholderTextColor={colors.mutedForeground}
                    autoFocus
                    maxLength={80}
                    returnKeyType="done"
                    onSubmitEditing={saveRename}
                    testID="knowledge-rename-input"
                    accessibilityLabel="New cluster name"
                  />
                  {editError && (
                    <Text
                      accessibilityRole="alert"
                      style={[
                        styles.knowledgeEditError,
                        { color: colors.destructive },
                      ]}
                    >
                      {editError}
                    </Text>
                  )}
                  <View style={styles.knowledgeEditCardActions}>
                    <TouchableOpacity
                      style={styles.knowledgeTextAction}
                      onPress={() => {
                        setIsRenaming(false);
                        setEditError(null);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Cancel rename"
                    >
                      <Text
                        style={[
                          styles.knowledgeEditCancelText,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        Cancel
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.knowledgeTextAction}
                      onPress={saveRename}
                      disabled={!renameDraft.trim()}
                      testID="knowledge-save-rename-button"
                      accessibilityRole="button"
                      accessibilityLabel="Save cluster name"
                      accessibilityState={{ disabled: !renameDraft.trim() }}
                    >
                      <Text
                        style={[
                          styles.knowledgeEditSaveText,
                          {
                            color: renameDraft.trim()
                              ? colors.primary
                              : colors.mutedForeground,
                          },
                        ]}
                      >
                        Save
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
              {isChoosingMerge && (
                <View
                  style={[
                    styles.knowledgeEditCard,
                    {
                      backgroundColor: colors.card,
                      borderColor: colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.knowledgeEditLabel,
                      { color: colors.foreground },
                    ]}
                  >
                    Merge a duplicate into {selectedCluster.label}
                  </Text>
                  <Text
                    style={[
                      styles.knowledgeEditHelp,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    Its sources, connections, and importance will be retained.
                  </Text>
                  {visibleClusters.length === 1 ? (
                    <Text
                      style={[
                        styles.knowledgeEditHelp,
                        { color: colors.mutedForeground },
                      ]}
                    >
                      There are no other clusters to merge yet.
                    </Text>
                  ) : (
                    <ScrollView
                      style={styles.knowledgeMergeOptions}
                      showsVerticalScrollIndicator={false}
                      nestedScrollEnabled
                    >
                      {visibleClusters
                        .filter((cluster) => cluster.id !== selectedCluster.id)
                        .map((cluster) => (
                          <TouchableOpacity
                            key={cluster.id}
                            style={[
                              styles.knowledgeMergeOption,
                              { borderColor: colors.border },
                            ]}
                            onPress={() => selectMergeSource(cluster)}
                            testID={`knowledge-merge-source-${cluster.id}`}
                            accessibilityRole="button"
                            accessibilityLabel={`Merge ${cluster.label} into ${selectedCluster.label}`}
                          >
                            <View style={styles.knowledgeMergeOptionCopy}>
                              <Text
                                numberOfLines={1}
                                style={[
                                  styles.knowledgeMergeOptionTitle,
                                  { color: colors.foreground },
                                ]}
                              >
                                {cluster.label}
                              </Text>
                              <Text
                                numberOfLines={1}
                                style={[
                                  styles.knowledgeMergeOptionMeta,
                                  { color: colors.mutedForeground },
                                ]}
                              >
                                {cluster.sources.length} sources ·{" "}
                                {cluster.links.length} connections
                              </Text>
                            </View>
                            <Feather
                              name="arrow-down-left"
                              size={16}
                              color={colors.primary}
                            />
                          </TouchableOpacity>
                        ))}
                    </ScrollView>
                  )}
                </View>
              )}
              {isConfirmingDelete && (
                <View
                  style={[
                    styles.knowledgeDeleteConfirm,
                    {
                      backgroundColor: colors.card,
                      borderColor: colors.destructive,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.knowledgeEditLabel,
                      { color: colors.foreground },
                    ]}
                  >
                    Delete {selectedCluster.label}?
                  </Text>
                  <Text
                    style={[
                      styles.knowledgeEditHelp,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    This removes the cluster and its saved sources from the map.
                  </Text>
                  <View style={styles.knowledgeEditCardActions}>
                    <TouchableOpacity
                      style={styles.knowledgeTextAction}
                      onPress={() => setIsConfirmingDelete(false)}
                      accessibilityRole="button"
                      accessibilityLabel="Cancel deleting cluster"
                    >
                      <Text
                        style={[
                          styles.knowledgeEditCancelText,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        Cancel
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.knowledgeTextAction}
                      onPress={confirmDelete}
                      testID="knowledge-confirm-delete-cluster-button"
                      accessibilityRole="button"
                      accessibilityLabel={`Confirm deletion of ${selectedCluster.label}`}
                    >
                      <Text
                        style={[
                          styles.knowledgeEditSaveText,
                          { color: colors.destructive },
                        ]}
                      >
                        Delete cluster
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
              <View style={styles.knowledgeInfoMeta}>
                <View
                  style={[
                    styles.metaBadge,
                    { backgroundColor: colors.secondary },
                  ]}
                >
                  <Text
                    style={[styles.metaBadgeText, { color: colors.foreground }]}
                  >
                    {selectedCluster.category}
                  </Text>
                </View>
                <View
                  style={[
                    styles.metaBadge,
                    { backgroundColor: colors.secondary },
                  ]}
                >
                  <Text
                    style={[styles.metaBadgeText, { color: colors.foreground }]}
                  >
                    {selectedCluster.links.length} connections
                  </Text>
                </View>
              </View>
              <Text
                style={[
                  styles.knowledgeSourcesLabel,
                  { color: colors.mutedForeground },
                ]}
              >
                {isNetworkLayer
                  ? "Sources · none by design"
                  : `Sources · ${selectedCluster.sources.length}`}
              </Text>
              <View style={styles.knowledgeSourcesList}>
                {selectedCluster.sources.map(
                  (
                    source: KnowledgeCluster["sources"][number],
                    index: number,
                  ) => (
                    <TouchableOpacity
                      key={`${source.conversationId}-${source.messageIds.join("-")}-${index}`}
                      style={[
                        styles.knowledgeSourceRow,
                        { borderColor: colors.border },
                      ]}
                      onPress={() => {
                        // Teammates' conversations don't exist on this
                        // device; company evidence reads in place instead.
                        if (!isCompanyLayer) {
                          onOpenConversation(source.conversationId);
                        }
                      }}
                      disabled={isCompanyLayer}
                      testID={`knowledge-source-${source.conversationId}`}
                      accessibilityRole={isCompanyLayer ? "text" : "button"}
                      accessibilityLabel={
                        isCompanyLayer
                          ? `Evidence from ${source.conversationTitle}`
                          : `Open source conversation ${source.conversationTitle}`
                      }
                    >
                      <View style={styles.knowledgeSourceCopy}>
                        <Text
                          numberOfLines={1}
                          style={[
                            styles.knowledgeSourceTitle,
                            { color: colors.foreground },
                          ]}
                        >
                          {source.conversationTitle}
                        </Text>
                        <Text
                          numberOfLines={2}
                          style={[
                            styles.knowledgeSourceExcerpt,
                            { color: colors.mutedForeground },
                          ]}
                        >
                          {knowledgeDisplayText(source.excerpt, citationLookup)}
                        </Text>
                      </View>
                      {!isCompanyLayer && (
                        <Feather
                          name="arrow-up-right"
                          size={16}
                          color={colors.primary}
                        />
                      )}
                    </TouchableOpacity>
                  ),
                )}
              </View>
            </ScrollView>
          </View>
        )}

        {/* Remote concept overlay: knowledge the server holds but this device
            has not cached. Same surface as the local panel, read-only. */}
        {remoteConcept && (
          <View
            testID="knowledge-remote-details"
            style={[
              styles.knowledgeInfoPanel,
              {
                backgroundColor: colors.background,
                borderTopColor: colors.border,
              },
            ]}
            accessibilityViewIsModal
            accessibilityLabel={`${remoteConcept.label} synced concept details`}
          >
            <ScrollView
              style={styles.knowledgeInfoScroll}
              contentContainerStyle={styles.knowledgeInfoContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
            >
              <View style={styles.knowledgeInfoHeader}>
                <Text
                  style={[
                    styles.knowledgeInfoTitle,
                    { color: colors.foreground },
                  ]}
                >
                  {remoteConcept.label}
                </Text>
                <TouchableOpacity
                  onPress={() => setRemoteConcept(null)}
                  hitSlop={12}
                  accessibilityRole="button"
                  accessibilityLabel="Close synced concept details"
                  testID="knowledge-remote-close"
                >
                  <Feather name="x" size={20} color={colors.mutedForeground} />
                </TouchableOpacity>
              </View>
              <Text
                style={[
                  styles.knowledgeRemoteMeta,
                  { color: colors.mutedForeground },
                ]}
              >
                {projectNameById.get(remoteConcept.projectId ?? "") ??
                  "Unknown project"}
                {" · not on this device"}
              </Text>

              {remoteConcept.status === "loading" && (
                <View
                  style={styles.knowledgeRemoteStatus}
                  testID="knowledge-remote-loading"
                >
                  <ActivityIndicator size="small" color={colors.primary} />
                  <Text
                    style={[
                      styles.knowledgeRemoteStatusCopy,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    Pulling this concept from your synced brain…
                  </Text>
                </View>
              )}

              {remoteConcept.status === "offline" && (
                <View
                  style={styles.knowledgeRemoteStatus}
                  testID="knowledge-remote-offline"
                >
                  <Feather
                    name="wifi-off"
                    size={26}
                    color={colors.mutedForeground}
                  />
                  <Text
                    style={[
                      styles.knowledgeRemoteStatusTitle,
                      { color: colors.foreground },
                    ]}
                  >
                    Connect to view evidence
                  </Text>
                  <Text
                    style={[
                      styles.knowledgeRemoteStatusCopy,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    This knowledge lives in your synced brain, not on this
                    device. Go online to pull its summary, evidence, and links.
                  </Text>
                  <TouchableOpacity
                    style={[
                      styles.knowledgeRemoteRetry,
                      { borderColor: colors.border },
                    ]}
                    onPress={() =>
                      setRemoteConcept((current) =>
                        current ? { ...current, status: "loading" } : current,
                      )
                    }
                    accessibilityRole="button"
                    accessibilityLabel="Try loading this concept again"
                    testID="knowledge-remote-retry"
                  >
                    <Feather
                      name="rotate-ccw"
                      size={14}
                      color={colors.foreground}
                    />
                    <Text
                      style={[
                        styles.knowledgeRemoteRetryText,
                        { color: colors.foreground },
                      ]}
                    >
                      Try again
                    </Text>
                  </TouchableOpacity>
                </View>
              )}

              {remoteConcept.status === "missing" && (
                <View
                  style={styles.knowledgeRemoteStatus}
                  testID="knowledge-remote-missing"
                >
                  <Text
                    style={[
                      styles.knowledgeRemoteStatusCopy,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    This concept is no longer in your knowledge base. It may
                    have been merged or deleted on another device.
                  </Text>
                </View>
              )}

              {remoteConcept.status === "ready" && remoteConcept.detail && (
                <>
                  <Text
                    style={[
                      styles.knowledgeInfoDesc,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    {knowledgeDisplayText(
                      remoteConcept.detail.concept.summary,
                      remoteCitationLookup,
                    )}
                  </Text>
                  <View style={styles.knowledgeRemoteBadges}>
                    <View
                      style={[
                        styles.knowledgeRemoteBadge,
                        { borderColor: colors.border },
                      ]}
                    >
                      <Text
                        style={[
                          styles.knowledgeRemoteBadgeText,
                          { color: colors.foreground },
                        ]}
                      >
                        {remoteConcept.detail.concept.category}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.knowledgeRemoteBadge,
                        { borderColor: colors.border },
                      ]}
                    >
                      <Text
                        style={[
                          styles.knowledgeRemoteBadgeText,
                          { color: colors.foreground },
                        ]}
                      >
                        {remoteConcept.detail.concept.mentionCount} mentions
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.knowledgeRemoteBadge,
                        { borderColor: colors.border },
                      ]}
                    >
                      <Text
                        style={[
                          styles.knowledgeRemoteBadgeText,
                          { color: colors.foreground },
                        ]}
                      >
                        {Math.round(
                          remoteConcept.detail.concept.strength * 100,
                        )}
                        % strength
                      </Text>
                    </View>
                  </View>

                  <Text
                    style={[
                      styles.knowledgeSourcesLabel,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    Evidence · {remoteConcept.detail.concept.sources.length}
                  </Text>
                  {remoteConcept.detail.concept.sources.length === 0 ? (
                    <Text
                      style={[
                        styles.knowledgeRemoteStatusCopy,
                        { color: colors.mutedForeground },
                      ]}
                    >
                      No conversation evidence is attached to this concept yet.
                    </Text>
                  ) : (
                    <View style={styles.knowledgeSourcesList}>
                      {remoteConcept.detail.concept.sources.map(
                        (source, index) => {
                          const isLocalConversation = localConversationIds.has(
                            source.conversationId,
                          );
                          return (
                            <TouchableOpacity
                              key={`${source.conversationId}-${index}`}
                              style={[
                                styles.knowledgeSourceRow,
                                { borderColor: colors.border },
                              ]}
                              onPress={() => {
                                if (isLocalConversation) {
                                  onOpenConversation(source.conversationId);
                                  return;
                                }
                                // Cited but never synced to this device:
                                // open the cloud copy read-only instead of
                                // dead-ending the trail of proof.
                                setRemoteConversation({
                                  conversationId: source.conversationId,
                                  title: source.conversationTitle,
                                  status: "loading",
                                  detail: null,
                                });
                              }}
                              testID={`knowledge-remote-source-${source.conversationId}`}
                              accessibilityRole="button"
                              accessibilityLabel={
                                isLocalConversation
                                  ? `Open source conversation ${source.conversationTitle}`
                                  : `Open synced source conversation ${source.conversationTitle}`
                              }
                            >
                              <View style={styles.knowledgeSourceCopy}>
                                <Text
                                  numberOfLines={1}
                                  style={[
                                    styles.knowledgeSourceTitle,
                                    { color: colors.foreground },
                                  ]}
                                >
                                  {source.conversationTitle}
                                </Text>
                                <Text
                                  numberOfLines={2}
                                  style={[
                                    styles.knowledgeSourceExcerpt,
                                    { color: colors.mutedForeground },
                                  ]}
                                >
                                  {knowledgeDisplayText(
                                    source.excerpt,
                                    remoteCitationLookup,
                                  )}
                                </Text>
                              </View>
                              {isLocalConversation ? (
                                <Feather
                                  name="arrow-up-right"
                                  size={16}
                                  color={colors.primary}
                                />
                              ) : (
                                <Feather
                                  name="cloud"
                                  size={16}
                                  color={colors.mutedForeground}
                                />
                              )}
                            </TouchableOpacity>
                          );
                        },
                      )}
                    </View>
                  )}

                  {remoteConcept.detail.neighbors.length > 0 && (
                    <>
                      <Text
                        style={[
                          styles.knowledgeSourcesLabel,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        Linked concepts
                      </Text>
                      <View style={styles.knowledgeNeighborChips}>
                        {remoteConcept.detail.neighbors.map((neighbor) => (
                          <TouchableOpacity
                            key={neighbor.id}
                            style={[
                              styles.knowledgeNeighborChip,
                              { borderColor: colors.border },
                            ]}
                            onPress={() =>
                              handleOpenSearchResult({
                                id: neighbor.id,
                                label: neighbor.label,
                                projectId: neighbor.projectId,
                              })
                            }
                            accessibilityRole="button"
                            accessibilityLabel={`Open linked concept ${neighbor.label}`}
                            testID={`knowledge-remote-neighbor-${neighbor.id}`}
                          >
                            <Feather
                              name="link"
                              size={12}
                              color={colors.foreground}
                            />
                            <Text
                              style={[
                                styles.knowledgeNeighborChipText,
                                { color: colors.foreground },
                              ]}
                            >
                              {neighbor.label}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </>
                  )}
                </>
              )}
            </ScrollView>
          </View>
        )}

        {/* Cited conversation overlay: stacks over the concept panel so the
            trail of proof reads concept → evidence → transcript. Served from
            the cloud snapshot, read-only. */}
        {remoteConversation && (
          <View
            testID="knowledge-conversation-details"
            style={[
              styles.knowledgeInfoPanel,
              {
                backgroundColor: colors.background,
                borderTopColor: colors.border,
              },
            ]}
            accessibilityViewIsModal
            accessibilityLabel={`${remoteConversation.title} synced conversation`}
          >
            <ScrollView
              style={styles.knowledgeInfoScroll}
              contentContainerStyle={styles.knowledgeInfoContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
            >
              <View style={styles.knowledgeInfoHeader}>
                <Text
                  style={[
                    styles.knowledgeInfoTitle,
                    { color: colors.foreground },
                  ]}
                >
                  {remoteConversation.title}
                </Text>
                <TouchableOpacity
                  onPress={() => setRemoteConversation(null)}
                  hitSlop={12}
                  accessibilityRole="button"
                  accessibilityLabel="Close synced conversation"
                  testID="knowledge-conversation-close"
                >
                  <Feather name="x" size={20} color={colors.mutedForeground} />
                </TouchableOpacity>
              </View>
              <Text
                style={[
                  styles.knowledgeRemoteMeta,
                  { color: colors.mutedForeground },
                ]}
              >
                {remoteConversation.detail
                  ? (remoteConversation.detail.projectName ??
                    "Unknown project")
                  : "From your synced brain"}
                {" · read-only"}
              </Text>

              {remoteConversation.status === "loading" && (
                <View
                  style={styles.knowledgeRemoteStatus}
                  testID="knowledge-conversation-loading"
                >
                  <ActivityIndicator size="small" color={colors.primary} />
                  <Text
                    style={[
                      styles.knowledgeRemoteStatusCopy,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    Pulling this conversation from your synced brain…
                  </Text>
                </View>
              )}

              {remoteConversation.status === "offline" && (
                <View
                  style={styles.knowledgeRemoteStatus}
                  testID="knowledge-conversation-offline"
                >
                  <Feather
                    name="wifi-off"
                    size={26}
                    color={colors.mutedForeground}
                  />
                  <Text
                    style={[
                      styles.knowledgeRemoteStatusTitle,
                      { color: colors.foreground },
                    ]}
                  >
                    Connect to view this conversation
                  </Text>
                  <Text
                    style={[
                      styles.knowledgeRemoteStatusCopy,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    This conversation lives in your synced brain, not on this
                    device. Go online to read the cited exchange.
                  </Text>
                  <TouchableOpacity
                    style={[
                      styles.knowledgeRemoteRetry,
                      { borderColor: colors.border },
                    ]}
                    onPress={() =>
                      setRemoteConversation((current) =>
                        current ? { ...current, status: "loading" } : current,
                      )
                    }
                    accessibilityRole="button"
                    accessibilityLabel="Try loading this conversation again"
                    testID="knowledge-conversation-retry"
                  >
                    <Feather
                      name="rotate-ccw"
                      size={14}
                      color={colors.foreground}
                    />
                    <Text
                      style={[
                        styles.knowledgeRemoteRetryText,
                        { color: colors.foreground },
                      ]}
                    >
                      Try again
                    </Text>
                  </TouchableOpacity>
                </View>
              )}

              {remoteConversation.status === "missing" && (
                <View
                  style={styles.knowledgeRemoteStatus}
                  testID="knowledge-conversation-missing"
                >
                  <Text
                    style={[
                      styles.knowledgeRemoteStatusCopy,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    This conversation is no longer in your synced workspace.
                    It may have been deleted on another device.
                  </Text>
                </View>
              )}

              {remoteConversation.status === "ready" &&
                remoteConversation.detail && (
                  <View
                    style={styles.knowledgeConversationTranscript}
                    testID="knowledge-conversation-transcript"
                  >
                    {remoteConversation.detail.conversation.messages.length ===
                    0 ? (
                      <Text
                        style={[
                          styles.knowledgeRemoteStatusCopy,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        This conversation has no messages yet.
                      </Text>
                    ) : (
                      remoteConversation.detail.conversation.messages.map(
                        (message) => (
                          <View
                            key={message.id}
                            style={[
                              styles.knowledgeConversationMessage,
                              { borderColor: colors.border },
                            ]}
                            testID={`knowledge-conversation-message-${message.id}`}
                          >
                            <Text
                              style={[
                                styles.knowledgeConversationSpeaker,
                                { color: colors.mutedForeground },
                              ]}
                            >
                              {message.role === "user"
                                ? "You"
                                : (message.speakerName ?? "Venom")}
                            </Text>
                            <Text
                              style={[
                                styles.knowledgeConversationBody,
                                { color: colors.foreground },
                              ]}
                            >
                              {knowledgeDisplayText(
                                message.content,
                                remoteCitationLookup,
                              )}
                            </Text>
                          </View>
                        ),
                      )
                    )}
                  </View>
                )}
            </ScrollView>
          </View>
        )}
        {!selectedCluster &&
          !remoteConcept &&
          !isCompanyLayer &&
          !isNetworkLayer && (
          <TouchableOpacity
            ref={captureButtonRef}
            style={[
              styles.knowledgeCaptureButton,
              {
                backgroundColor:
                  visibleClusters.length > 0
                    ? colors.symbioteHighlight
                    : colors.primary,
                borderColor:
                  visibleClusters.length > 0
                    ? colors.symbioteSoft
                    : colors.border,
              },
              captureButtonFocused
                ? { borderWidth: 2, borderColor: colors.foreground }
                : null,
            ]}
            onFocus={() => setCaptureButtonFocused(true)}
            onBlur={() => setCaptureButtonFocused(false)}
            onPress={openNoteComposer}
            disabled={!state.activeProjectId}
            accessibilityRole="button"
            accessibilityLabel="Capture a note into this project's Brain"
            accessibilityHint="Opens a reviewable multiline note composer"
            accessibilityState={{ disabled: !state.activeProjectId }}
            testID="brain-note-open"
          >
            <Feather
              name="plus"
              size={22}
              color={
                visibleClusters.length > 0
                  ? colors.symbioteSurface
                  : colors.primaryForeground
              }
            />
          </TouchableOpacity>
        )}
        {composerProjectId && (
          <BrainNoteComposer
            projectId={composerProjectId}
            projectName={composerProject?.name ?? "Selected project"}
            onClose={closeNoteComposer}
            onRetargetProject={setComposerProjectId}
          />
        )}
      </View>
    </View>
  );
}
