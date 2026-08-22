import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Dimensions,
  TouchableOpacity,
  TextInput,
  Linking,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Svg, { Line } from 'react-native-svg';
import { useUser } from '@clerk/expo';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetVenomOntologyConcept,
  getGetVenomOntologyConceptQueryKey,
  useGetSharedWorkspaceKnowledge,
  getGetSharedWorkspaceKnowledgeQueryKey,
  useListVenomKnowledgeMoves,
  getListVenomKnowledgeMovesQueryKey,
  undoVenomKnowledgeMove,
  acceptVenomKnowledgeSuggestion,
  dismissVenomKnowledgeSuggestion,
  moveVenomUnsortedConcept,
  exportVenomPersonalMarkdown,
  exportSharedWorkspaceMarkdown,
  type VenomKnowledgeMoveNotice,
  type VenomKnowledgeSuggestion,
} from '@workspace/api-client-react';

import { useColors } from '@/hooks/useColors';
import {
  useVenom,
  IS_UI_TEST,
  KnowledgeCluster,
  ProjectSource,
  SourceCitation,
} from '@/context/VenomContext';
import { useSharedWorkspace } from '@/context/sharedWorkspace';
import { describeLastSync } from '@/context/sourceState';
import { spreadSourceClusters } from '@/context/sourceClusterLayout';
import { deliverMarkdown, markdownExportFileName } from '@/lib/downloadMarkdown';
import { Header } from '@/components/Header';

type MapCluster = KnowledgeCluster & { citations?: SourceCitation[] };
type KnowledgeView = 'map' | 'sources';

/**
 * The Brain's scope filter (the only place the personal/workspace axis
 * appears now that the nav-level switcher is gone): the personal Brain,
 * the author-private Unsorted holding area, or one shared workspace's
 * membership-checked store.
 */
type BrainScope =
  | { kind: 'personal' }
  | { kind: 'unsorted' }
  | { kind: 'workspace'; id: string };

const scopeKeyOf = (scope: BrainScope) =>
  scope.kind === 'workspace' ? `workspace:${scope.id}` : scope.kind;

const statusOf = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
};

/** Plain-words description of an automatic move, mirroring desktop copy. */
const describeMoveNotice = (notice: VenomKnowledgeMoveNotice): string => {
  const labels = (notice.labels ?? []).filter(Boolean);
  const subject =
    labels.length === 0
      ? 'Knowledge'
      : labels.length <= 2
        ? labels.join(' and ')
        : `${labels[0]} and ${labels.length - 1} more`;
  if (notice.direction === 'workspace_to_personal') {
    return `${subject} moved back to your personal Brain${
      notice.workspaceName ? ` from ${notice.workspaceName}` : ''
    }.`;
  }
  return `${subject} filed to ${notice.workspaceName ?? 'a shared workspace'}.`;
};

const matches = (value: string | undefined, query: string) =>
  (value ?? '').toLowerCase().includes(query);

const { width, height } = Dimensions.get('window');
const MAP_SIZE = 1000;
const CENTER_X = MAP_SIZE / 2;
const CENTER_Y = MAP_SIZE / 2;

export default function KnowledgeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    state,
    isReady,
    setActiveProject,
    applyFiledKnowledge,
    deleteKnowledgeCluster,
    markKnowledgeClusterSorted,
  } = useVenom();
  const params = useLocalSearchParams<{
    view?: string;
    source?: string;
    citation?: string;
    scope?: string;
  }>();
  // A chat citation can point at the source it came from, so the sources view
  // opens scrolled to that source with it marked out from the rest. When the
  // jump also names the citation the answer quoted, the exact row inside that
  // card is marked and scrolled to; without one, the card alone is the target.
  const requestedSourceId =
    typeof params.source === 'string' && params.source ? params.source : null;
  const requestedCitationId =
    requestedSourceId && typeof params.citation === 'string' && params.citation
      ? params.citation
      : null;

  const [selectedCluster, setSelectedCluster] = React.useState<MapCluster | null>(null);
  // Personal is the default scope; the filter never leaks across screens —
  // chatting needs no scope decision anywhere else in the app. The Brain
  // tab's unsorted pill deep-links straight into the holding area.
  const { workspaces } = useSharedWorkspace();
  const [scope, setScope] = React.useState<BrainScope>(
    params.scope === 'unsorted' ? { kind: 'unsorted' } : { kind: 'personal' },
  );
  const scopeWorkspaceId = scope.kind === 'workspace' ? scope.id : null;
  const scopeWorkspace = scopeWorkspaceId
    ? (workspaces.find(entry => entry.id === scopeWorkspaceId) ?? null)
    : null;
  // Membership can end while this scope is open (the global revocation
  // handler evicts its caches); fall back to Personal instead of parking the
  // reader on a dead query.
  React.useEffect(() => {
    if (
      scope.kind === 'workspace' &&
      !workspaces.some(entry => entry.id === scope.id)
    ) {
      setScope({ kind: 'personal' });
      setSelectedCluster(null);
    }
  }, [scope, workspaces]);
  const { user } = useUser();
  // Chat-derived evidence attribution: the server concept detail names who
  // captured each evidence row (legacy rows default to the ontology owner).
  // Offline, the device copy is shown as the signed-in person's own words.
  const chatCluster =
    selectedCluster && (selectedCluster.sources?.length ?? 0) > 0
      ? selectedCluster
      : null;
  const { data: conceptDetail } = useGetVenomOntologyConcept(
    chatCluster?.id ?? '',
    undefined,
    {
      query: {
        queryKey: getGetVenomOntologyConceptQueryKey(chatCluster?.id ?? ''),
        // Workspace-scope clusters live in the shared store, not the personal
        // ontology this endpoint reads; their evidence falls back to the
        // sources already on the cluster.
        enabled: Boolean(chatCluster) && scope.kind !== 'workspace',
        staleTime: 60_000,
        retry: 1,
      },
    },
  );
  const evidenceRows = React.useMemo(() => {
    if (!chatCluster) return [];
    const detail =
      conceptDetail && conceptDetail.concept.id === chatCluster.id
        ? conceptDetail
        : null;
    const sources = detail?.concept.sources ?? chatCluster.sources ?? [];
    const people = new Map(
      (detail?.people ?? []).map(person => [person.userId, person.displayName]),
    );
    const selfLabel =
      user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? 'You';
    return sources.slice(0, 3).map(source => {
      const capturedBy = source.capturedByUserId ?? null;
      const resolved = capturedBy ? people.get(capturedBy) : null;
      const person =
        resolved ??
        (capturedBy === null || capturedBy === user?.id
          ? selfLabel
          : 'Workspace member');
      const capturedAt = source.capturedAt ?? source.updatedAt;
      return {
        key: `${source.conversationId}-${capturedAt}`,
        person,
        title: source.conversationTitle,
        date: new Date(capturedAt).toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        }),
      };
    });
  }, [chatCluster, conceptDetail, user]);
  const [view, setView] = React.useState<KnowledgeView>(
    params.view === 'sources' || requestedSourceId ? 'sources' : 'map',
  );
  const [filter, setFilter] = React.useState('');
  const [mapQuery, setMapQuery] = React.useState('');
  const [highlightedSourceId, setHighlightedSourceId] = React.useState<
    string | null
  >(requestedSourceId);
  const [highlightedCitationId, setHighlightedCitationId] = React.useState<
    string | null
  >(requestedCitationId);

  // ——— Server-backed data for the non-personal scopes.
  const queryClient = useQueryClient();
  const workspaceKnowledgeQuery = useGetSharedWorkspaceKnowledge(
    scopeWorkspaceId ?? '',
    {
      query: {
        queryKey: getGetSharedWorkspaceKnowledgeQueryKey(scopeWorkspaceId ?? ''),
        enabled: Boolean(scopeWorkspaceId),
        staleTime: 30_000,
        retry: 1,
      },
    },
  );
  const workspaceClusters: MapCluster[] = React.useMemo(() => {
    if (!scopeWorkspaceId) return [];
    const data = workspaceKnowledgeQuery.data;
    // Failed generated-client calls surface non-array bodies; guard hard.
    return data && Array.isArray(data.clusters) ? data.clusters : [];
  }, [scopeWorkspaceId, workspaceKnowledgeQuery.data]);

  // Move activity — automatic filings with undo, plus personal→workspace
  // sharing suggestions — is personal-axis information: polled on the
  // Personal and Unsorted scopes, never inside a workspace view. UI-test
  // boots keep the query live so harnesses can stub the endpoint.
  const movesEnabled =
    (IS_UI_TEST || Boolean(user?.id)) && scope.kind !== 'workspace';
  const movesQuery = useListVenomKnowledgeMoves({
    query: {
      queryKey: getListVenomKnowledgeMovesQueryKey(),
      enabled: movesEnabled,
      refetchInterval: 30_000,
      retry: 1,
    },
  });
  const moveNotices = React.useMemo(() => {
    const data = movesQuery.data;
    const list = data && Array.isArray(data.notices) ? data.notices : [];
    return list.filter(notice => notice.status === 'active');
  }, [movesQuery.data]);
  const moveSuggestions = React.useMemo(() => {
    const data = movesQuery.data;
    return data && Array.isArray(data.suggestions) ? data.suggestions : [];
  }, [movesQuery.data]);

  const [moveBusyId, setMoveBusyId] = React.useState<string | null>(null);
  const [movesMessage, setMovesMessage] = React.useState<string | null>(null);
  const [unsortedBusy, setUnsortedBusy] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const refreshMoves = React.useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: getListVenomKnowledgeMovesQueryKey(),
    });
  }, [queryClient]);

  // Undo restores author-private unsorted records. They re-enter local state
  // through the same filing hook chats use, keyed to a conversation this
  // device still holds; without one, the server copy alone carries them until
  // the next filing pass.
  const findRestoredConversation = React.useCallback(
    (restored: KnowledgeCluster[]) => {
      for (const record of restored) {
        for (const source of record.sources ?? []) {
          const conversation = state.conversations.find(
            entry => entry.id === source.conversationId,
          );
          if (conversation) {
            return {
              id: conversation.id,
              title: conversation.title,
              projectId: conversation.projectId,
            };
          }
        }
      }
      return null;
    },
    [state.conversations],
  );

  const handleUndoMove = React.useCallback(
    async (notice: VenomKnowledgeMoveNotice) => {
      if (moveBusyId) return;
      setMoveBusyId(notice.id);
      setMovesMessage(null);
      try {
        const result = await undoVenomKnowledgeMove(notice.id);
        // A non-2xx resolves to the error body: the undo window closed or
        // the records changed since. The server retired the notice, so the
        // list refresh drops it.
        const refusal = result as { restored?: unknown; error?: string } | null;
        if (!refusal || !Array.isArray(refusal.restored)) {
          setMovesMessage(
            refusal?.error ?? 'Undo is no longer available for this move.',
          );
          refreshMoves();
          return;
        }
        if (notice.workspaceId) {
          void queryClient.invalidateQueries({
            queryKey: getGetSharedWorkspaceKnowledgeQueryKey(notice.workspaceId),
          });
        }
        const restored = Array.isArray(result?.restored) ? result.restored : [];
        if (restored.length > 0) {
          const conversationRef = findRestoredConversation(restored);
          if (conversationRef) applyFiledKnowledge(conversationRef, restored);
        }
        setMovesMessage(
          notice.direction === 'workspace_to_personal'
            ? `Move undone — it's back in ${notice.workspaceName ?? 'the workspace'}.`
            : "Move undone. It's back in Unsorted, visible only to you.",
        );
        refreshMoves();
      } catch {
        setMovesMessage(
          'Could not undo that move — it may already be handled on another device.',
        );
        refreshMoves();
      } finally {
        setMoveBusyId(null);
      }
    },
    [
      moveBusyId,
      queryClient,
      findRestoredConversation,
      applyFiledKnowledge,
      refreshMoves,
    ],
  );

  const handleAcceptShare = React.useCallback(
    async (suggestion: VenomKnowledgeSuggestion) => {
      if (moveBusyId) return;
      setMoveBusyId(suggestion.id);
      setMovesMessage(null);
      try {
        await acceptVenomKnowledgeSuggestion(suggestion.id);
        // The server marks the personal record replaced; retire the local
        // copy immediately behind that marker instead of waiting for sync.
        deleteKnowledgeCluster(suggestion.conceptId);
        void queryClient.invalidateQueries({
          queryKey: getGetSharedWorkspaceKnowledgeQueryKey(suggestion.workspaceId),
        });
        setMovesMessage(
          `Shared “${suggestion.label}” with ${suggestion.workspaceName}. Members there can see it now.`,
        );
        refreshMoves();
      } catch (error) {
        const status = statusOf(error);
        setMovesMessage(
          status === 403
            ? `You're no longer a member of ${suggestion.workspaceName}, so nothing was shared.`
            : status === 409
              ? 'That suggestion was already handled on another device.'
              : 'Could not share that right now. Try again in a moment.',
        );
        refreshMoves();
      } finally {
        setMoveBusyId(null);
      }
    },
    [moveBusyId, queryClient, deleteKnowledgeCluster, refreshMoves],
  );

  const handleDismissShare = React.useCallback(
    (suggestion: VenomKnowledgeSuggestion) => {
      if (moveBusyId) return;
      setMoveBusyId(suggestion.id);
      dismissVenomKnowledgeSuggestion(suggestion.id)
        .catch(() => {
          // Dismissal is best-effort; the row simply reappears next poll.
        })
        .finally(() => {
          setMoveBusyId(null);
          refreshMoves();
        });
    },
    [moveBusyId, refreshMoves],
  );

  const handleKeepPersonal = React.useCallback(
    (cluster: MapCluster) => {
      markKnowledgeClusterSorted(cluster.id);
      setSelectedCluster(null);
    },
    [markKnowledgeClusterSorted],
  );

  const handleMoveUnsorted = React.useCallback(
    async (cluster: MapCluster, workspace: { id: string; name: string }) => {
      if (unsortedBusy) return;
      setUnsortedBusy(true);
      setMovesMessage(null);
      try {
        await moveVenomUnsortedConcept(cluster.id, { workspaceId: workspace.id });
        deleteKnowledgeCluster(cluster.id);
        void queryClient.invalidateQueries({
          queryKey: getGetSharedWorkspaceKnowledgeQueryKey(workspace.id),
        });
        setSelectedCluster(null);
        setMovesMessage(
          `Moved “${cluster.label}” to ${workspace.name}. Members there can see it now.`,
        );
        refreshMoves();
      } catch (error) {
        const status = statusOf(error);
        setMovesMessage(
          status === 403
            ? `You're no longer a member of ${workspace.name}, so nothing moved.`
            : status === 404
              ? 'That item is no longer waiting to be sorted.'
              : status === 409
                ? 'That item was already sorted on another device.'
                : 'Could not move that item. Try again in a moment.',
        );
      } finally {
        setUnsortedBusy(false);
      }
    },
    [unsortedBusy, queryClient, deleteKnowledgeCluster, refreshMoves],
  );

  // Markdown export follows the filter: the sorted personal Brain, the
  // Unsorted holding area, or the open workspace's shared knowledge.
  const handleExport = React.useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      if (scope.kind === 'workspace') {
        if (!scopeWorkspace) return;
        const markdown = await exportSharedWorkspaceMarkdown(
          scopeWorkspace.id,
          'brain',
        );
        await deliverMarkdown(
          markdownExportFileName(scopeWorkspace.name, 'brain'),
          markdown,
        );
      } else {
        const markdown = await exportVenomPersonalMarkdown('brain', {
          scope: scope.kind === 'unsorted' ? 'unsorted' : 'sorted',
        });
        await deliverMarkdown(
          markdownExportFileName(
            scope.kind === 'unsorted' ? 'unsorted' : 'personal',
            'brain',
          ),
          markdown,
        );
      }
    } catch {
      setMovesMessage('The export could not be prepared. Try again in a moment.');
    } finally {
      setExporting(false);
    }
  }, [exporting, scope.kind, scopeWorkspace]);

  const sourceListRef = React.useRef<ScrollView | null>(null);
  const sourceOffsets = React.useRef<Record<string, number>>({});
  // Citation rows are nested two layouts deep inside their card, so landing on
  // one sums the card's offset, its citation list's offset within the card,
  // and the row's offset within that list.
  const citationListOffsets = React.useRef<Record<string, number>>({});
  const citationOffsets = React.useRef<Record<string, number>>({});
  const activeSourcesRef = React.useRef<ProjectSource[]>([]);
  const pendingScrollRef = React.useRef<{
    sourceId: string;
    citationId: string | null;
  } | null>(
    requestedSourceId
      ? { sourceId: requestedSourceId, citationId: requestedCitationId }
      : null,
  );

  // Switching scope resets per-scope UI: the selection, the map search, and —
  // outside Personal — the sources view plus any parked citation jump, since
  // connected sources are device-local personal data.
  const switchScope = (next: BrainScope) => {
    if (scopeKeyOf(next) === scopeKeyOf(scope)) return;
    setScope(next);
    setSelectedCluster(null);
    setMapQuery('');
    setMovesMessage(null);
    if (next.kind !== 'personal') {
      setView('map');
      pendingScrollRef.current = null;
      setHighlightedSourceId(null);
      setHighlightedCitationId(null);
    }
  };

  // The jump target may not be laid out yet, so the scroll is retried from each
  // card's and citation row's layout pass until the requested target reports
  // its offset. A citation id that no longer exists on the requested source
  // (say, retired by a refresh) falls back to the card so the jump still lands.
  const scrollToPendingSource = React.useCallback(() => {
    const pending = pendingScrollRef.current;
    if (!pending) return;
    const cardOffset = sourceOffsets.current[pending.sourceId];
    if (cardOffset === undefined) return;
    let target = cardOffset;
    if (pending.citationId) {
      const source = activeSourcesRef.current.find(
        entry => entry.id === pending.sourceId,
      );
      const citationExists = source?.citations.some(
        citation => citation.id === pending.citationId,
      );
      if (citationExists) {
        const listOffset = citationListOffsets.current[pending.sourceId];
        const rowOffset = citationOffsets.current[pending.citationId];
        if (listOffset === undefined || rowOffset === undefined) return;
        target = cardOffset + listOffset + rowOffset;
      }
    }
    pendingScrollRef.current = null;
    sourceListRef.current?.scrollTo({
      y: Math.max(target - 12, 0),
      animated: true,
    });
  }, []);

  // A jump can arrive while the screen is already open, and the filter must not
  // hide the source the reader was sent to.
  React.useEffect(() => {
    if (!requestedSourceId) return;
    setView('sources');
    setSelectedCluster(null);
    setFilter('');
    setHighlightedSourceId(requestedSourceId);
    setHighlightedCitationId(requestedCitationId);
    pendingScrollRef.current = {
      sourceId: requestedSourceId,
      citationId: requestedCitationId,
    };
    scrollToPendingSource();
  }, [requestedSourceId, requestedCitationId, scrollToPendingSource]);
  const now = Date.now();
  const activeSources = (state.sources ?? []).filter(
    source => !state.activeProjectId || source.projectId === state.activeProjectId,
  );
  activeSourcesRef.current = activeSources;

  // A jump can outlive its target: by the time the reader lands here the cited
  // source may have been disconnected, or it may be filed under a project that
  // is not the one on screen. Its card then never lays out and the pending
  // scroll never fires, so the reason is said out loud instead of dropping the
  // jump silently. Until the workspace has hydrated, "missing" is
  // indistinguishable from "still loading", so the notice waits for isReady
  // while the parked scroll keeps waiting for a card that may still arrive.
  const jumpTargetMissing =
    isReady &&
    highlightedSourceId !== null &&
    !activeSources.some(source => source.id === highlightedSourceId);
  const jumpTargetElsewhere = jumpTargetMissing
    ? ((state.sources ?? []).find(
        source => source.id === highlightedSourceId,
      ) ?? null)
    : null;
  const jumpTargetProject = jumpTargetElsewhere
    ? (state.projects.find(
        project => project.id === jumpTargetElsewhere.projectId,
      ) ?? null)
    : null;
  const jumpTargetProjectName = jumpTargetProject?.name ?? null;

  // Sources keep every citation when their own name matches, so a repository
  // can be filtered to as a whole; otherwise only matching citations remain.
  const query = filter.trim().toLowerCase();
  const filteredSources = !query
    ? activeSources.map(source => ({ source, citations: source.citations }))
    : activeSources
        .map(source => ({
          source,
          citations: matches(source.name, query)
            ? source.citations
            : source.citations.filter(
                citation =>
                  matches(citation.title, query) || matches(citation.excerpt, query),
              ),
        }))
        .filter(entry => entry.citations.length > 0 || matches(entry.source.name, query));
  // Source clusters ring the chat-derived ones on a golden-angle spiral, one
  // pod per source: the hub cluster rides the spiral and its satellites ring
  // it, so a source's dots stay together and their dashed links stay short
  // instead of criss-crossing the map. The layout is deterministic (same
  // workspace, same map — no jitter across renders) and collision-free, so no
  // dot can bury another and every node stays tappable no matter how many
  // sources a project connects.
  const sourceClusterEntries = activeSources.flatMap(source =>
    source.clusters.map((cluster, clusterIndex) => ({
      source,
      cluster,
      clusterIndex,
    })),
  );
  const sourceClusterPositions = spreadSourceClusters(
    // One pod size per source; sources without clusters contribute no points,
    // exactly as they contribute no entries above, so indexes stay aligned.
    activeSources.map(source => source.clusters.length),
    state.clusters.map(cluster => ({ x: cluster.x, y: cluster.y })),
  );
  const sourceClusters: MapCluster[] = sourceClusterEntries.map(
    ({ source, cluster, clusterIndex }, entryIndex) => ({
      id: cluster.id,
      projectId: source.projectId,
      label: cluster.label,
      category: cluster.category,
      strength: cluster.strength,
      x: sourceClusterPositions[entryIndex].x,
      y: sourceClusterPositions[entryIndex].y,
      links:
        clusterIndex === 0
          ? source.clusters.slice(1).map(item => item.id)
          : [source.clusters[0].id],
      summary: `Connected ${source.provider} source: ${source.name}`,
      mentionCount: 1,
      lastUpdatedAt: Date.parse(source.syncedAt) || Date.now(),
      sources: [],
      citations: source.citations.filter(citation =>
        cluster.citationIds.includes(citation.id),
      ),
    }),
  );
  // Personal hides unsorted items (they are a holding area, not yet Brain
  // knowledge); Unsorted shows exactly them, across every project; a
  // workspace scope shows the membership-checked server store. Source pods
  // are device-local and personal-only.
  const personalClusters = state.clusters.filter(
    cluster => cluster.unsorted !== true,
  );
  const unsortedClusters = state.clusters.filter(
    cluster => cluster.unsorted === true,
  );
  const unsortedCount = unsortedClusters.length;
  const clusters: MapCluster[] =
    scope.kind === 'workspace'
      ? workspaceClusters
      : scope.kind === 'unsorted'
        ? unsortedClusters
        : [...personalClusters, ...sourceClusters];

  const getPos = (c: KnowledgeCluster) => ({
    x: CENTER_X + c.x * 2,
    y: CENTER_Y + c.y * 2
  });

  // The map search never removes nodes: matches keep their label and full
  // presence while everything else dims, so the constellation keeps its shape
  // and the sought topic stands out inside it. Beyond labels and categories it
  // also reads each cluster's citation titles and excerpts — the same fields
  // the sources view filters on — so a phrase remembered from a cited document
  // finds the topic on the map, not just in the sources list.
  const mapSearch = mapQuery.trim().toLowerCase();
  const isMapSearching = mapSearch.length > 0;
  // Matches are walked strongest-first: index 0 is where the map pans as the
  // search narrows (the old jump-to-strongest), and the stepper carries on
  // from there through the weaker matches. The sort is stable, so equal
  // strengths keep their map order and the walk stays deterministic.
  const matchedClusters = isMapSearching
    ? clusters
        .filter(
          cluster =>
            matches(cluster.label, mapSearch) ||
            matches(cluster.category, mapSearch) ||
            (cluster.citations ?? []).some(
              citation =>
                matches(citation.title, mapSearch) ||
                matches(citation.excerpt, mapSearch),
            ),
        )
        .sort((a, b) => b.strength - a.strength)
    : [];
  const matchedClusterIds = new Set(matchedClusters.map(cluster => cluster.id));
  const matchCount = matchedClusters.length;
  // The step index is keyed to the normalized query AND the exact match
  // list, so any edit to either — a keystroke, even one that leaves the same
  // clusters matched ("memory" → "memo"), or a source connecting mid-search —
  // restarts the walk at the strongest match instead of pointing at whatever
  // now happens to sit at the old index. A stale key reads as index 0 in the
  // very same render, so no frame is ever aimed at the wrong cluster; the
  // effect then retires the abandoned walk for good, because a key that
  // later comes back (say the same query is retyped) must start fresh, not
  // resume mid-walk. The NUL separator cannot occur in typed text, so a
  // query can never masquerade as part of the id list.
  const walkKey = `${mapSearch}\u0000${matchedClusters
    .map(cluster => cluster.id)
    .join('|')}`;
  const [matchStep, setMatchStep] = React.useState({ key: '', index: 0 });
  React.useEffect(() => {
    setMatchStep(step =>
      step.key === walkKey ? step : { key: walkKey, index: 0 },
    );
  }, [walkKey]);
  const matchIndex = matchStep.key === walkKey ? matchStep.index : 0;
  const currentMatch = matchedClusters[matchIndex] ?? null;
  const currentMatchId = currentMatch?.id ?? null;
  const stepMatch = (delta: -1 | 1) => {
    if (matchCount < 2) return;
    setMatchStep({
      key: walkKey,
      index: (matchIndex + delta + matchCount) % matchCount,
    });
  };
  const currentMatchRef = React.useRef<MapCluster | null>(null);
  currentMatchRef.current = currentMatch;
  const mapScrollXRef = React.useRef<ScrollView | null>(null);
  const mapScrollYRef = React.useRef<ScrollView | null>(null);
  const mapViewportRef = React.useRef({ width, height });

  // Highlighting alone cannot find a topic that sits outside the viewport, so
  // the map pans to the current match and centers it — the strongest as the
  // search narrows, then each stop of the stepper's wrap-around walk.
  React.useEffect(() => {
    const target = currentMatchRef.current;
    if (!currentMatchId || !target) return;
    const position = { x: CENTER_X + target.x * 2, y: CENTER_Y + target.y * 2 };
    const viewport = mapViewportRef.current;
    const clampOffset = (value: number, max: number) =>
      Math.min(Math.max(value, 0), Math.max(max, 0));
    mapScrollXRef.current?.scrollTo({
      x: clampOffset(position.x - viewport.width / 2, MAP_SIZE - viewport.width),
      animated: true,
    });
    mapScrollYRef.current?.scrollTo({
      y: clampOffset(position.y - viewport.height / 2, MAP_SIZE - viewport.height),
      animated: true,
    });
  }, [currentMatchId]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Header
        title="Knowledge"
        showBack
      />

      {(workspaces.length > 0 ||
        unsortedCount > 0 ||
        scope.kind !== 'personal') && (
        <View style={styles.scopeBar} testID="brain-scope-bar">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.scopeRowContent}
          >
            <TouchableOpacity
              style={[
                styles.scopePill,
                {
                  borderColor:
                    scope.kind === 'personal' ? colors.foreground : colors.border,
                  backgroundColor:
                    scope.kind === 'personal' ? colors.card : 'transparent',
                },
              ]}
              onPress={() => switchScope({ kind: 'personal' })}
              accessibilityRole="button"
              accessibilityState={{ selected: scope.kind === 'personal' }}
              accessibilityLabel="Show your personal Brain"
              testID="brain-layer-personal"
              activeOpacity={0.85}
            >
              <Feather
                name="user"
                size={13}
                color={
                  scope.kind === 'personal'
                    ? colors.foreground
                    : colors.mutedForeground
                }
              />
              <Text
                style={[
                  styles.scopePillText,
                  {
                    color:
                      scope.kind === 'personal'
                        ? colors.foreground
                        : colors.mutedForeground,
                  },
                ]}
              >
                Personal
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.scopePill,
                {
                  borderColor:
                    scope.kind === 'unsorted' ? colors.foreground : colors.border,
                  backgroundColor:
                    scope.kind === 'unsorted' ? colors.card : 'transparent',
                },
              ]}
              onPress={() => switchScope({ kind: 'unsorted' })}
              accessibilityRole="button"
              accessibilityState={{ selected: scope.kind === 'unsorted' }}
              accessibilityLabel={
                unsortedCount > 0
                  ? `Show ${unsortedCount} unsorted item${unsortedCount === 1 ? '' : 's'} only you can see`
                  : 'Show the Unsorted holding area'
              }
              testID="brain-layer-unsorted"
              activeOpacity={0.85}
            >
              <Feather
                name="inbox"
                size={13}
                color={
                  scope.kind === 'unsorted'
                    ? colors.foreground
                    : colors.mutedForeground
                }
              />
              <Text
                style={[
                  styles.scopePillText,
                  {
                    color:
                      scope.kind === 'unsorted'
                        ? colors.foreground
                        : colors.mutedForeground,
                  },
                ]}
              >
                Unsorted
              </Text>
              {unsortedCount > 0 && (
                <View
                  style={[
                    styles.scopeBadge,
                    { backgroundColor: colors.foreground },
                  ]}
                  testID="badge-unsorted-count"
                >
                  <Text
                    style={[styles.scopeBadgeText, { color: colors.background }]}
                  >
                    {unsortedCount}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
            {workspaces.map(workspace => {
              const isActive = scopeWorkspaceId === workspace.id;
              return (
                <TouchableOpacity
                  key={workspace.id}
                  style={[
                    styles.scopePill,
                    {
                      borderColor: isActive ? colors.foreground : colors.border,
                      backgroundColor: isActive ? colors.card : 'transparent',
                    },
                  ]}
                  onPress={() =>
                    switchScope({ kind: 'workspace', id: workspace.id })
                  }
                  accessibilityRole="button"
                  accessibilityState={{ selected: isActive }}
                  accessibilityLabel={`Show shared knowledge from ${workspace.name}`}
                  testID={`brain-layer-workspace-${workspace.id}`}
                  activeOpacity={0.85}
                >
                  <Feather
                    name="users"
                    size={13}
                    color={isActive ? colors.foreground : colors.mutedForeground}
                  />
                  <Text
                    style={[
                      styles.scopePillText,
                      {
                        color: isActive
                          ? colors.foreground
                          : colors.mutedForeground,
                      },
                    ]}
                    numberOfLines={1}
                  >
                    {workspace.name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
          <TouchableOpacity
            style={[
              styles.scopeExport,
              { borderColor: colors.border, backgroundColor: colors.secondary },
            ]}
            onPress={() => void handleExport()}
            disabled={exporting}
            accessibilityRole="button"
            accessibilityLabel={
              scope.kind === 'workspace'
                ? `Export ${scopeWorkspace?.name ?? 'workspace'} knowledge as Markdown`
                : scope.kind === 'unsorted'
                  ? 'Export unsorted knowledge as Markdown'
                  : 'Export your personal Brain as Markdown'
            }
            testID="button-brain-export"
          >
            {exporting ? (
              <ActivityIndicator size="small" color={colors.mutedForeground} />
            ) : (
              <Feather name="download" size={14} color={colors.foreground} />
            )}
          </TouchableOpacity>
        </View>
      )}

      {movesMessage !== null && (
        <View
          style={[
            styles.messageStrip,
            { borderColor: colors.border, backgroundColor: colors.card },
          ]}
        >
          <Text
            style={[styles.movesMessage, { color: colors.mutedForeground }]}
            accessibilityLiveRegion="polite"
            testID="brain-moves-message"
          >
            {movesMessage}
          </Text>
          <TouchableOpacity
            onPress={() => setMovesMessage(null)}
            accessibilityRole="button"
            accessibilityLabel="Dismiss message"
            hitSlop={10}
            testID="brain-moves-message-dismiss"
          >
            <Feather name="x" size={13} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>
      )}

      {scope.kind !== 'workspace' &&
        (moveNotices.length > 0 || moveSuggestions.length > 0) && (
        <View
          style={[
            styles.movesPanel,
            { borderColor: colors.border, backgroundColor: colors.card },
          ]}
          testID="brain-move-activity"
        >
          {moveNotices.map(notice => (
            <View
              key={notice.id}
              style={styles.moveRow}
              testID={`move-notice-${notice.id}`}
            >
              <Feather
                name={
                  notice.direction === 'workspace_to_personal'
                    ? 'corner-up-left'
                    : 'inbox'
                }
                size={13}
                color={colors.mutedForeground}
                style={styles.moveIcon}
              />
              <Text
                style={[styles.moveText, { color: colors.foreground }]}
                numberOfLines={2}
              >
                {describeMoveNotice(notice)}
              </Text>
              <TouchableOpacity
                style={[styles.moveAction, { borderColor: colors.border }]}
                onPress={() => void handleUndoMove(notice)}
                disabled={moveBusyId !== null}
                accessibilityRole="button"
                accessibilityLabel={`Undo: ${describeMoveNotice(notice)}`}
                testID={`button-undo-move-${notice.id}`}
              >
                <Text
                  style={[styles.moveActionText, { color: colors.foreground }]}
                >
                  {moveBusyId === notice.id ? 'Undoing…' : 'Undo'}
                </Text>
              </TouchableOpacity>
            </View>
          ))}
          {moveSuggestions.map(suggestion => (
            <View
              key={suggestion.id}
              style={styles.moveRow}
              testID={`move-suggestion-${suggestion.id}`}
            >
              <Feather
                name="share-2"
                size={13}
                color={colors.mutedForeground}
                style={styles.moveIcon}
              />
              <Text
                style={[styles.moveText, { color: colors.foreground }]}
                numberOfLines={3}
              >
                {`Share “${suggestion.label}” with ${suggestion.workspaceName}? Members there would see it.`}
              </Text>
              <TouchableOpacity
                style={[styles.moveAction, { borderColor: colors.border }]}
                onPress={() => void handleAcceptShare(suggestion)}
                disabled={moveBusyId !== null}
                accessibilityRole="button"
                accessibilityLabel={`Share ${suggestion.label} with ${suggestion.workspaceName} — members there will see it`}
                testID={`button-accept-share-${suggestion.id}`}
              >
                <Text
                  style={[styles.moveActionText, { color: colors.foreground }]}
                >
                  {moveBusyId === suggestion.id ? 'Sharing…' : 'Share'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.moveAction, { borderColor: colors.border }]}
                onPress={() => handleDismissShare(suggestion)}
                disabled={moveBusyId !== null}
                accessibilityRole="button"
                accessibilityLabel={`Keep ${suggestion.label} personal`}
                testID={`button-dismiss-share-${suggestion.id}`}
              >
                <Text
                  style={[styles.moveActionText, { color: colors.foreground }]}
                >
                  Keep personal
                </Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      {scope.kind === 'personal' && (
      <View
        style={[
          styles.viewToggle,
          { borderColor: colors.border, backgroundColor: colors.secondary },
        ]}
        accessibilityRole="tablist"
      >
        {([
          { key: 'map' as const, label: 'Map' },
          { key: 'sources' as const, label: `Sources · ${activeSources.length}` },
        ]).map(option => {
          const isActive = view === option.key;
          return (
            <TouchableOpacity
              key={option.key}
              style={[
                styles.viewToggleOption,
                isActive && { backgroundColor: colors.card, borderColor: colors.border },
              ]}
              onPress={() => {
                // The map keeps its scroll position while hidden, so the detail
                // panel is dismissed to avoid two copies of the same citation.
                if (option.key !== 'map') setSelectedCluster(null);
                // Leaving the sources view retires the jump markers — and the
                // scroll still parked on them: they point at where the reader
                // arrived, not a lasting selection.
                if (option.key !== 'sources') {
                  pendingScrollRef.current = null;
                  setHighlightedSourceId(null);
                  setHighlightedCitationId(null);
                }
                setView(option.key);
              }}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
              accessibilityLabel={
                option.key === 'map'
                  ? 'Show knowledge map'
                  : `Show ${activeSources.length} connected sources`
              }
              testID={`knowledge-view-${option.key}`}
              activeOpacity={0.85}
            >
              <Text
                style={[
                  styles.viewToggleLabel,
                  { color: isActive ? colors.foreground : colors.mutedForeground },
                ]}
              >
                {option.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      )}

      {view === 'map' && clusters.length > 0 && (
        <View style={styles.filterRow}>
          <View
            style={[
              styles.filterInputWrapper,
              { borderColor: colors.border, backgroundColor: colors.secondary },
            ]}
          >
            <Feather name="search" size={15} color={colors.mutedForeground} />
            <TextInput
              style={[styles.filterInput, { color: colors.foreground }]}
              value={mapQuery}
              onChangeText={setMapQuery}
              placeholder="Search by label, category, or citation..."
              placeholderTextColor={colors.mutedForeground}
              accessibilityLabel="Search map clusters by label, category, or citation text"
              testID="knowledge-map-search"
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              returnKeyType="search"
            />
            {mapQuery.length > 0 && (
              <TouchableOpacity
                onPress={() => setMapQuery('')}
                accessibilityRole="button"
                accessibilityLabel="Clear map search"
                testID="knowledge-map-search-clear"
                hitSlop={12}
              >
                <Feather name="x" size={15} color={colors.mutedForeground} />
              </TouchableOpacity>
            )}
          </View>
          {isMapSearching && (
            <View style={styles.mapMatchRow}>
              <Text
                style={[styles.mapMatchCount, { color: colors.mutedForeground }]}
                accessibilityLiveRegion="polite"
                testID="knowledge-map-match-count"
              >
                {matchCount === 0
                  ? `No clusters match “${mapQuery.trim()}”. Search matches labels, categories, and citation text.`
                  : `${matchCount} of ${clusters.length} cluster${clusters.length === 1 ? '' : 's'} match`}
              </Text>
              {matchCount > 1 && currentMatch && (
                // With several matches lit, the stepper walks the viewport
                // through them in turn — wrapping at either end — so none of
                // them has to be hunted down by hand on a crowded map. A
                // single match needs no walk and keeps the plain count.
                <View
                  style={[
                    styles.mapMatchStepper,
                    {
                      borderColor: colors.border,
                      backgroundColor: colors.secondary,
                    },
                  ]}
                  testID="knowledge-map-match-stepper"
                >
                  <TouchableOpacity
                    style={styles.mapMatchStepButton}
                    onPress={() => stepMatch(-1)}
                    accessibilityRole="button"
                    accessibilityLabel="Go to previous match"
                    hitSlop={8}
                    testID="knowledge-map-match-prev"
                  >
                    <Feather
                      name="chevron-left"
                      size={15}
                      color={colors.foreground}
                    />
                  </TouchableOpacity>
                  <Text
                    style={[styles.mapMatchPosition, { color: colors.foreground }]}
                    accessibilityLiveRegion="polite"
                    accessibilityLabel={`Match ${matchIndex + 1} of ${matchCount}: ${currentMatch.label}`}
                    testID="knowledge-map-match-position"
                  >
                    {`${matchIndex + 1} of ${matchCount}`}
                  </Text>
                  <TouchableOpacity
                    style={styles.mapMatchStepButton}
                    onPress={() => stepMatch(1)}
                    accessibilityRole="button"
                    accessibilityLabel="Go to next match"
                    hitSlop={8}
                    testID="knowledge-map-match-next"
                  >
                    <Feather
                      name="chevron-right"
                      size={15}
                      color={colors.foreground}
                    />
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}
        </View>
      )}

      {view === 'sources' && activeSources.length > 0 && (
        <View style={styles.filterRow}>
          <View
            style={[
              styles.filterInputWrapper,
              { borderColor: colors.border, backgroundColor: colors.secondary },
            ]}
          >
            <Feather name="search" size={15} color={colors.mutedForeground} />
            <TextInput
              style={[styles.filterInput, { color: colors.foreground }]}
              value={filter}
              onChangeText={setFilter}
              placeholder="Filter sources and citations..."
              placeholderTextColor={colors.mutedForeground}
              accessibilityLabel="Filter sources and citations"
              testID="knowledge-source-filter"
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              returnKeyType="search"
            />
            {filter.length > 0 && (
              <TouchableOpacity
                onPress={() => setFilter('')}
                accessibilityRole="button"
                accessibilityLabel="Clear source filter"
                testID="knowledge-source-filter-clear"
                hitSlop={12}
              >
                <Feather name="x" size={15} color={colors.mutedForeground} />
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}

      {view === 'sources' && (
        <ScrollView
          ref={sourceListRef}
          style={styles.sourcesContainer}
          contentContainerStyle={[
            styles.sourcesContent,
            { paddingBottom: insets.bottom + 24 },
          ]}
          showsVerticalScrollIndicator={false}
          testID="knowledge-source-list"
        >
          {jumpTargetMissing && (
            <View
              style={[
                styles.jumpMissingNotice,
                { borderColor: colors.border, backgroundColor: colors.card },
              ]}
              accessibilityLiveRegion="polite"
              testID="knowledge-jump-missing"
            >
              <Feather
                name="info"
                size={15}
                color={colors.mutedForeground}
                style={styles.jumpMissingIcon}
              />
              <View style={styles.jumpMissingCopy}>
                <Text
                  style={[styles.jumpMissingTitle, { color: colors.foreground }]}
                >
                  That cited source isn't in this list
                </Text>
                <Text
                  style={[
                    styles.jumpMissingText,
                    { color: colors.mutedForeground },
                  ]}
                  testID="knowledge-jump-missing-reason"
                >
                  {jumpTargetElsewhere
                    ? `“${jumpTargetElsewhere.name}” is connected to ${
                        jumpTargetProjectName
                          ? `the “${jumpTargetProjectName}” project`
                          : 'a different project'
                      }, so nothing here is marked.${
                        jumpTargetProject
                          ? ''
                          : ' Switch projects to browse its citations.'
                      }`
                    : 'The source that answer cited is no longer connected, so nothing here is marked.'}
                </Text>
                {jumpTargetElsewhere && jumpTargetProject && (
                  <TouchableOpacity
                    style={[
                      styles.jumpMissingAction,
                      { borderColor: colors.border },
                    ]}
                    onPress={() => {
                      // Completes the parked jump in one tap. The scroll is
                      // re-parked first (idempotent while it still waits, and
                      // restores it if an earlier pass dropped it), then the
                      // project switches while this screen stays mounted: the
                      // source's card mounts, its layout pass reports offsets,
                      // and the parked scroll and highlight finish on their
                      // own. A filter typed while the notice was up must not
                      // hide the card the reader asked for — same rule as a
                      // jump arriving on an open screen — or the parked
                      // scroll would never resolve. Switching moves the chat
                      // session with it by design, so it only ever happens on
                      // this explicit tap.
                      setFilter('');
                      pendingScrollRef.current = {
                        sourceId: jumpTargetElsewhere.id,
                        citationId: highlightedCitationId,
                      };
                      setActiveProject(jumpTargetProject.id);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Switch to the ${jumpTargetProject.name} project`}
                    testID="knowledge-jump-switch-project"
                    activeOpacity={0.85}
                  >
                    <Text
                      style={[
                        styles.jumpMissingActionText,
                        { color: colors.foreground },
                      ]}
                    >
                      Switch to {jumpTargetProject.name}
                    </Text>
                    <Feather
                      name="arrow-right"
                      size={13}
                      color={colors.foreground}
                    />
                  </TouchableOpacity>
                )}
              </View>
              <TouchableOpacity
                onPress={() => {
                  // Dismissing retires the jump for good — the markers and the
                  // scroll parked on them — so none can fire on a later render.
                  pendingScrollRef.current = null;
                  setHighlightedSourceId(null);
                  setHighlightedCitationId(null);
                }}
                accessibilityRole="button"
                accessibilityLabel="Dismiss the cited source notice"
                hitSlop={12}
                testID="knowledge-jump-missing-dismiss"
              >
                <Feather name="x" size={15} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>
          )}
          {activeSources.length === 0 ? (
            <View
              style={[
                styles.sourcesEmpty,
                { borderColor: colors.border, backgroundColor: colors.card },
              ]}
              testID="knowledge-sources-empty"
            >
              <Feather name="link" size={20} color={colors.mutedForeground} />
              <Text style={[styles.sourcesEmptyTitle, { color: colors.foreground }]}>
                No connected sources yet
              </Text>
              <Text
                style={[styles.sourcesEmptyCopy, { color: colors.mutedForeground }]}
              >
                Connect a GitHub repository or a website and its citations will be
                listed here, ready to open and verify.
              </Text>
              <TouchableOpacity
                style={[styles.sourcesEmptyAction, { borderColor: colors.border }]}
                onPress={() => router.push('/settings')}
                accessibilityRole="button"
                accessibilityLabel="Connect a source in settings"
                testID="knowledge-connect-source"
                activeOpacity={0.85}
              >
                <Text
                  style={[styles.sourcesEmptyActionText, { color: colors.foreground }]}
                >
                  Connect a source
                </Text>
                <Feather name="arrow-right" size={14} color={colors.foreground} />
              </TouchableOpacity>
            </View>
          ) : filteredSources.length === 0 ? (
            <View
              style={[
                styles.sourcesEmpty,
                { borderColor: colors.border, backgroundColor: colors.card },
              ]}
              testID="knowledge-filter-empty"
            >
              <Feather name="search" size={20} color={colors.mutedForeground} />
              <Text style={[styles.sourcesEmptyTitle, { color: colors.foreground }]}>
                No matches for “{filter.trim()}”
              </Text>
              <Text style={[styles.sourcesEmptyCopy, { color: colors.mutedForeground }]}>
                {`Nothing in your ${activeSources.length} connected source${activeSources.length === 1 ? '' : 's'} matches that filter. Clear it to browse every citation again.`}
              </Text>
              <TouchableOpacity
                style={[styles.sourcesEmptyAction, { borderColor: colors.border }]}
                onPress={() => setFilter('')}
                accessibilityRole="button"
                accessibilityLabel="Clear source filter"
                testID="knowledge-filter-empty-clear"
                activeOpacity={0.85}
              >
                <Text style={[styles.sourcesEmptyActionText, { color: colors.foreground }]}>
                  Clear filter
                </Text>
                <Feather name="x" size={14} color={colors.foreground} />
              </TouchableOpacity>
            </View>
          ) : (
            filteredSources.map(({ source, citations }) => {
              const isHighlighted = highlightedSourceId === source.id;
              return (
              <View
                key={source.id}
                style={[
                  styles.sourceCard,
                  {
                    borderColor: isHighlighted ? colors.primary : colors.border,
                    backgroundColor: isHighlighted
                      ? colors.secondary
                      : colors.card,
                  },
                ]}
                onLayout={event => {
                  sourceOffsets.current[source.id] = event.nativeEvent.layout.y;
                  scrollToPendingSource();
                }}
                testID={`knowledge-source-${source.id}`}
              >
                {isHighlighted && (
                  <View
                    style={styles.sourceJumpBadge}
                    testID={`knowledge-source-highlight-${source.id}`}
                  >
                    <Feather
                      name="corner-down-right"
                      size={11}
                      color={colors.primary}
                    />
                    <Text
                      style={[styles.sourceJumpBadgeText, { color: colors.primary }]}
                    >
                      Cited in your answer
                    </Text>
                  </View>
                )}
                <View style={styles.sourceCardHeader}>
                  <View
                    style={[
                      styles.sourceIcon,
                      { borderColor: colors.border, backgroundColor: colors.secondary },
                    ]}
                  >
                    <Feather
                      name={source.provider === 'github' ? 'github' : 'globe'}
                      size={16}
                      color={colors.primary}
                    />
                  </View>
                  <View style={styles.sourceCopy}>
                    <Text
                      style={[styles.sourceName, { color: colors.foreground }]}
                      numberOfLines={1}
                    >
                      {source.name}
                    </Text>
                    <Text
                      style={[styles.sourceMeta, { color: colors.mutedForeground }]}
                      numberOfLines={1}
                      testID={`knowledge-source-meta-${source.id}`}
                    >
                      {`${
                        citations.length === source.citations.length
                          ? `${source.citations.length} citation${source.citations.length === 1 ? '' : 's'}`
                          : `${citations.length} of ${source.citations.length} citations`
                      } · ${describeLastSync(source.syncedAt, now)}`}
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => Linking.openURL(source.url)}
                    accessibilityRole="link"
                    accessibilityLabel={`Open ${source.name}`}
                    hitSlop={12}
                    testID={`knowledge-open-source-${source.id}`}
                  >
                    <Feather name="external-link" size={16} color={colors.primary} />
                  </TouchableOpacity>
                </View>

                <View
                  style={[styles.sourceCitations, { borderTopColor: colors.border }]}
                  onLayout={event => {
                    citationListOffsets.current[source.id] =
                      event.nativeEvent.layout.y;
                    scrollToPendingSource();
                  }}
                >
                  {citations.map(citation => {
                    const isCitationHighlighted =
                      isHighlighted && highlightedCitationId === citation.id;
                    return (
                    <TouchableOpacity
                      key={citation.id}
                      style={[
                        styles.citationRow,
                        isCitationHighlighted && [
                          styles.citationRowHighlighted,
                          {
                            borderColor: colors.primary,
                            backgroundColor: colors.card,
                          },
                        ],
                      ]}
                      onLayout={event => {
                        citationOffsets.current[citation.id] =
                          event.nativeEvent.layout.y;
                        scrollToPendingSource();
                      }}
                      onPress={() => Linking.openURL(citation.url)}
                      accessibilityRole="link"
                      accessibilityLabel={`Open source: ${citation.title}`}
                      testID={`knowledge-citation-${citation.id}`}
                      activeOpacity={0.7}
                    >
                      <View style={styles.citationCopy}>
                        {isCitationHighlighted && (
                          <View
                            style={styles.citationJumpBadge}
                            testID={`knowledge-citation-highlight-${citation.id}`}
                          >
                            <Feather
                              name="corner-down-right"
                              size={10}
                              color={colors.primary}
                            />
                            <Text
                              style={[
                                styles.citationJumpBadgeText,
                                { color: colors.primary },
                              ]}
                            >
                              Quoted in your answer
                            </Text>
                          </View>
                        )}
                        <Text
                          style={[styles.citationTitle, { color: colors.foreground }]}
                          numberOfLines={1}
                        >
                          {citation.title}
                        </Text>
                        <Text
                          style={[
                            styles.citationExcerpt,
                            { color: colors.mutedForeground },
                          ]}
                          numberOfLines={2}
                        >
                          {citation.excerpt}
                        </Text>
                      </View>
                      <Feather name="external-link" size={14} color={colors.primary} />
                    </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
              );
            })
          )}
        </ScrollView>
      )}

      <View
        style={[styles.mapContainer, view !== 'map' && styles.hidden]}
        testID="knowledge-map-viewport"
        onLayout={event => {
          mapViewportRef.current = {
            width: event.nativeEvent.layout.width,
            height: event.nativeEvent.layout.height,
          };
        }}
      >
        <ScrollView
          ref={mapScrollXRef}
          horizontal
          bounces={false}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ width: MAP_SIZE }}
          centerContent
        >
          <ScrollView
            ref={mapScrollYRef}
            bounces={false}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ height: MAP_SIZE, width: MAP_SIZE }}
            centerContent
          >
            <View style={{ width: MAP_SIZE, height: MAP_SIZE }}>
              {/* Draw Lines */}
              <Svg height={MAP_SIZE} width={MAP_SIZE} style={StyleSheet.absoluteFill}>
                {clusters.map(cluster => {
                  const p1 = getPos(cluster);
                  return cluster.links.map(targetId => {
                    const target = clusters.find(c => c.id === targetId);
                    if (!target) return null;
                    const p2 = getPos(target);
                    // Avoid double drawing
                    if (cluster.id > target.id) return null;
                    // A link fades with its nodes unless either end matches.
                    const isLineDimmed =
                      isMapSearching &&
                      !matchedClusterIds.has(cluster.id) &&
                      !matchedClusterIds.has(target.id);
                    return (
                      <Line
                        key={`${cluster.id}-${targetId}`}
                        x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
                        stroke={colors.border}
                        strokeOpacity={isLineDimmed ? 0.3 : 1}
                        strokeWidth="1"
                        strokeDasharray="4 4"
                      />
                    );
                  });
                })}
              </Svg>

              {/* Draw Nodes */}
              {clusters.map(cluster => {
                const p = getPos(cluster);
                const isSelected = selectedCluster?.id === cluster.id;
                const isMatch = matchedClusterIds.has(cluster.id);
                const isProminent = isSelected || (isMapSearching && isMatch);
                // Dimmed, never removed: a non-matching node keeps its place
                // (and stays tappable) so the map's shape survives the search.
                const isDimmed = isMapSearching && !isMatch && !isSelected;
                // With several matches lit the same way, a halo singles out
                // the one the stepper is parked on — the pan's destination.
                const isCurrentStop =
                  matchCount > 1 && cluster.id === currentMatchId;
                const size = 16 + cluster.strength * 24;

                return (
                  <View
                    key={cluster.id}
                    style={[styles.nodeWrap, {
                      left: p.x - size / 2,
                      top: p.y - size / 2,
                      width: size,
                      height: size,
                      opacity: isDimmed ? 0.25 : 1,
                    }]}
                    testID={`knowledge-map-node-${cluster.id}`}
                  >
                    {isCurrentStop && (
                      <View
                        pointerEvents="none"
                        style={[
                          styles.currentMatchRing,
                          { borderColor: colors.foreground },
                        ]}
                        testID={`knowledge-map-current-${cluster.id}`}
                      />
                    )}
                    <TouchableOpacity
                      style={[styles.node, {
                        borderRadius: size / 2,
                        backgroundColor: isSelected ? colors.primary : colors.accent,
                        borderColor: isProminent ? colors.foreground : colors.primary,
                        borderWidth: isProminent ? 2 : 1,
                        shadowColor: colors.foreground,
                      }]}
                      onPress={() => setSelectedCluster(cluster)}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${cluster.label} knowledge cluster`}
                      accessibilityState={{ selected: isSelected }}
                      activeOpacity={0.8}
                    >
                      {isSelected && (
                        <View style={[styles.pulse, { backgroundColor: colors.primary }]} />
                      )}
                    </TouchableOpacity>
                  </View>
                );
              })}

              {/* Draw Labels */}
              {clusters.map(cluster => {
                const p = getPos(cluster);
                const isSelected = selectedCluster?.id === cluster.id;
                const isMatch = matchedClusterIds.has(cluster.id);
                const isProminent = isSelected || (isMapSearching && isMatch);
                const isDimmed = isMapSearching && !isMatch && !isSelected;
                const size = 16 + cluster.strength * 24;
                // A match always shows its label, however weak the cluster;
                // without a search only strong clusters earn one.
                if (!isProminent && cluster.strength < 0.8) return null;

                return (
                  <Text
                    key={`label-${cluster.id}`}
                    testID={`knowledge-map-label-${cluster.id}`}
                    style={[styles.nodeLabel, {
                      left: p.x - 60,
                      top: p.y + size / 2 + 8,
                      color: isSelected
                        ? colors.primary
                        : isProminent
                          ? colors.foreground
                          : colors.mutedForeground,
                      opacity: isDimmed ? 0.25 : isProminent ? 1 : 0.7,
                    }]}
                  >
                    {cluster.label}
                  </Text>
                );
              })}
            </View>
          </ScrollView>
        </ScrollView>

        {scope.kind === 'unsorted' && clusters.length === 0 && (
          <View style={styles.mapEmpty} pointerEvents="none" testID="brain-unsorted-empty">
            <Feather name="inbox" size={22} color={colors.mutedForeground} />
            <Text style={[styles.mapEmptyTitle, { color: colors.foreground }]}>
              Nothing waiting to be sorted
            </Text>
            <Text style={[styles.mapEmptyCopy, { color: colors.mutedForeground }]}>
              When Venom can't confidently tell whether something belongs to a
              shared workspace, it holds the item here — visible only to you —
              until new knowledge makes the destination clear.
            </Text>
          </View>
        )}
        {scope.kind === 'workspace' &&
          (workspaceKnowledgeQuery.isLoading ? (
            <View style={styles.mapEmpty} pointerEvents="none" testID="brain-workspace-loading">
              <ActivityIndicator color={colors.mutedForeground} />
            </View>
          ) : workspaceKnowledgeQuery.isError ? (
            <View style={styles.mapEmpty} testID="brain-workspace-error">
              <Feather
                name="alert-circle"
                size={22}
                color={colors.mutedForeground}
              />
              <Text style={[styles.mapEmptyTitle, { color: colors.foreground }]}>
                Couldn't load this workspace's knowledge
              </Text>
              <Text
                style={[styles.mapEmptyCopy, { color: colors.mutedForeground }]}
              >
                Check your connection — and that you're still a member — then
                try again.
              </Text>
              <TouchableOpacity
                style={[styles.mapEmptyAction, { borderColor: colors.border }]}
                onPress={() => void workspaceKnowledgeQuery.refetch()}
                accessibilityRole="button"
                accessibilityLabel="Retry loading workspace knowledge"
                testID="brain-workspace-retry"
              >
                <Text
                  style={[styles.mapEmptyActionText, { color: colors.foreground }]}
                >
                  Retry
                </Text>
              </TouchableOpacity>
            </View>
          ) : clusters.length === 0 ? (
            <View style={styles.mapEmpty} pointerEvents="none" testID="brain-workspace-empty">
              <Feather name="users" size={22} color={colors.mutedForeground} />
              <Text style={[styles.mapEmptyTitle, { color: colors.foreground }]}>
                No shared knowledge yet
              </Text>
              <Text
                style={[styles.mapEmptyCopy, { color: colors.mutedForeground }]}
              >
                {`Chat about ${scopeWorkspace?.name ?? 'this workspace'}'s work and confidently matched knowledge will file here for every member.`}
              </Text>
            </View>
          ) : null)}

        {/* Selected Cluster Info */}
        {selectedCluster && (
          <View testID="knowledge-map-detail" style={[styles.infoPanel, {
            backgroundColor: colors.card,
            borderColor: colors.border,
            paddingBottom: insets.bottom + 16
          }]}>
            <View style={styles.infoHeader}>
              <Text style={[styles.infoTitle, { color: colors.foreground }]}>{selectedCluster.label}</Text>
              <TouchableOpacity
                onPress={() => setSelectedCluster(null)}
                accessibilityRole="button"
                accessibilityLabel="Close knowledge details"
                testID="knowledge-map-detail-close"
              >
                <Feather name="x" size={20} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>
            <View style={styles.infoStats}>
              <View style={styles.statItem}>
                <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>Category</Text>
                <Text style={[styles.statValue, { color: colors.primary }]}>{selectedCluster.category}</Text>
              </View>
              <View style={styles.statItem}>
                <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>Strength</Text>
                <Text style={[styles.statValue, { color: colors.primary }]}>{(selectedCluster.strength * 100).toFixed(0)}%</Text>
              </View>
              <View style={styles.statItem}>
                <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>Connections</Text>
                  <Text style={[styles.statValue, { color: colors.primary }]}>{selectedCluster.citations?.length ?? selectedCluster.links.length}</Text>
              </View>
            </View>
              {selectedCluster.unsorted === true && (
                <View
                  style={[
                    styles.unsortedBadge,
                    {
                      borderColor: colors.border,
                      backgroundColor: colors.secondary,
                    },
                  ]}
                  testID="badge-unsorted-concept"
                >
                  <Feather name="inbox" size={12} color={colors.mutedForeground} />
                  <Text
                    style={[
                      styles.unsortedBadgeText,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    Unsorted — only you can see this
                  </Text>
                </View>
              )}
              {selectedCluster.unsorted === true && (
                <View
                  style={[styles.citationList, { borderTopColor: colors.border }]}
                  testID="panel-unsorted-review"
                >
                  <Text
                    style={[styles.citationHeading, { color: colors.mutedForeground }]}
                  >
                    Sort it now
                  </Text>
                  <View style={styles.reviewActions}>
                    <TouchableOpacity
                      style={[styles.reviewAction, { borderColor: colors.border }]}
                      onPress={() => handleKeepPersonal(selectedCluster)}
                      disabled={unsortedBusy}
                      accessibilityRole="button"
                      accessibilityLabel={`Keep ${selectedCluster.label} in your personal Brain`}
                      testID="button-keep-personal"
                    >
                      <Feather name="user" size={13} color={colors.foreground} />
                      <Text
                        style={[styles.reviewActionText, { color: colors.foreground }]}
                      >
                        Keep personal
                      </Text>
                    </TouchableOpacity>
                    {workspaces.map(workspace => (
                      <TouchableOpacity
                        key={workspace.id}
                        style={[styles.reviewAction, { borderColor: colors.border }]}
                        onPress={() =>
                          void handleMoveUnsorted(selectedCluster, workspace)
                        }
                        disabled={unsortedBusy}
                        accessibilityRole="button"
                        accessibilityLabel={`Move ${selectedCluster.label} to ${workspace.name} — members there will see it`}
                        testID={`button-move-unsorted-${workspace.id}`}
                      >
                        <Feather name="users" size={13} color={colors.foreground} />
                        <Text
                          style={[styles.reviewActionText, { color: colors.foreground }]}
                          numberOfLines={1}
                        >
                          Move to {workspace.name}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              )}
              {selectedCluster.citations && selectedCluster.citations.length > 0 && (
                <View style={[styles.citationList, { borderTopColor: colors.border }]}>
                  <Text style={[styles.citationHeading, { color: colors.mutedForeground }]}>Source citations</Text>
                  {selectedCluster.citations.slice(0, 2).map(citation => (
                    <TouchableOpacity
                      key={citation.id}
                      style={styles.citationRow}
                      onPress={() => Linking.openURL(citation.url)}
                      testID={`knowledge-citation-${citation.id}`}
                    >
                      <View style={styles.citationCopy}>
                        <Text style={[styles.citationTitle, { color: colors.foreground }]} numberOfLines={1}>
                          {citation.title}
                        </Text>
                        <Text style={[styles.citationExcerpt, { color: colors.mutedForeground }]} numberOfLines={1}>
                          {citation.excerpt}
                        </Text>
                      </View>
                      <Feather name="external-link" size={14} color={colors.primary} />
                    </TouchableOpacity>
                  ))}
                </View>
              )}
              {evidenceRows.length > 0 && (
                <View style={[styles.citationList, { borderTopColor: colors.border }]}>
                  <Text style={[styles.citationHeading, { color: colors.mutedForeground }]}>Evidence</Text>
                  {evidenceRows.map((row, index) => (
                    <View
                      key={row.key}
                      style={styles.citationRow}
                      testID={`knowledge-evidence-${index}`}
                    >
                      <View style={styles.citationCopy}>
                        <Text style={[styles.citationTitle, { color: colors.foreground }]} numberOfLines={1}>
                          {row.person}
                        </Text>
                        <Text style={[styles.citationExcerpt, { color: colors.mutedForeground }]} numberOfLines={1}>
                          {row.title} · {row.date}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              )}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  mapContainer: { flex: 1 },
  hidden: { display: 'none' },
  viewToggle: {
    flexDirection: 'row',
    margin: 16,
    marginBottom: 0,
    padding: 3,
    borderRadius: 999,
    borderWidth: 1,
    gap: 3,
  },
  viewToggleOption: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  viewToggleLabel: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 12,
    letterSpacing: 0,
  },
  filterRow: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  filterInputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === 'ios' ? 10 : 6,
  },
  filterInput: {
    flex: 1,
    fontFamily: 'Inter_400Regular',
    fontSize: 13,
    minHeight: 22,
  },
  mapMatchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 8,
    paddingHorizontal: 6,
  },
  mapMatchCount: {
    flex: 1,
    fontFamily: 'Inter_400Regular',
    fontSize: 11,
  },
  mapMatchStepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  mapMatchStepButton: {
    padding: 3,
  },
  mapMatchPosition: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 11,
    letterSpacing: 0,
    minWidth: 42,
    textAlign: 'center',
  },
  currentMatchRing: {
    position: 'absolute',
    top: -5,
    left: -5,
    right: -5,
    bottom: -5,
    borderRadius: 999,
    borderWidth: 2,
  },
  sourcesContainer: { flex: 1 },
  sourcesContent: {
    padding: 16,
    gap: 12,
  },
  scopeBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 16,
    paddingRight: 16,
    paddingTop: 12,
  },
  scopeRowContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingRight: 8,
  },
  scopePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    maxWidth: 200,
  },
  scopePillText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 12,
    letterSpacing: 0,
  },
  scopeBadge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  scopeBadgeText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 10,
  },
  scopeExport: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  messageStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 16,
    marginTop: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  movesMessage: {
    flex: 1,
    fontFamily: 'Inter_400Regular',
    fontSize: 12,
    lineHeight: 17,
  },
  movesPanel: {
    marginHorizontal: 16,
    marginTop: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  moveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
  },
  moveIcon: {
    marginTop: 1,
  },
  moveText: {
    flex: 1,
    fontFamily: 'Inter_400Regular',
    fontSize: 12,
    lineHeight: 17,
  },
  moveAction: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  moveActionText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 11,
    letterSpacing: 0,
  },
  mapEmpty: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 10,
  },
  mapEmptyTitle: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 14,
    textAlign: 'center',
  },
  mapEmptyCopy: {
    fontFamily: 'Inter_400Regular',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    maxWidth: 300,
  },
  mapEmptyAction: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
    marginTop: 2,
  },
  mapEmptyActionText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 12,
  },
  unsortedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginTop: 12,
  },
  unsortedBadgeText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 11,
  },
  reviewActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  reviewAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    maxWidth: 240,
  },
  reviewActionText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 12,
  },
  sourcesEmpty: {
    borderWidth: 1,
    borderRadius: 18,
    padding: 20,
    alignItems: 'center',
    gap: 8,
  },
  sourcesEmptyTitle: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 15,
    letterSpacing: -0.2,
  },
  sourcesEmptyCopy: {
    fontFamily: 'Inter_400Regular',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  sourcesEmptyAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
  },
  sourcesEmptyActionText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 12,
  },
  sourceCard: {
    borderWidth: 1,
    borderRadius: 18,
    padding: 14,
  },
  jumpMissingNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderWidth: 1,
    borderRadius: 18,
    padding: 14,
  },
  jumpMissingIcon: {
    marginTop: 1,
  },
  jumpMissingCopy: { flex: 1 },
  jumpMissingTitle: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 13,
    letterSpacing: -0.2,
  },
  jumpMissingText: {
    fontFamily: 'Inter_400Regular',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 3,
  },
  jumpMissingAction: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    marginTop: 10,
    paddingVertical: 8,
    paddingHorizontal: 13,
    borderRadius: 999,
    borderWidth: 1,
  },
  jumpMissingActionText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 12,
    letterSpacing: -0.1,
  },
  sourceJumpBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 10,
  },
  sourceJumpBadgeText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 11,
    letterSpacing: 0,
  },
  sourceCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  sourceIcon: {
    width: 34,
    height: 34,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sourceCopy: { flex: 1 },
  sourceName: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 14,
    letterSpacing: -0.2,
  },
  sourceMeta: {
    fontFamily: 'Inter_400Regular',
    fontSize: 11,
    marginTop: 2,
  },
  sourceCitations: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    gap: 12,
  },
  nodeWrap: {
    position: 'absolute',
  },
  node: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.22,
    shadowRadius: 10,
    elevation: 5,
  },
  pulse: {
    width: '100%',
    height: '100%',
    borderRadius: 999,
    opacity: 0.3,
    transform: [{ scale: 1.5 }],
  },
  nodeLabel: {
    position: 'absolute',
    width: 120,
    textAlign: 'center',
    fontFamily: 'Inter_600SemiBold',
    fontSize: 11,
    letterSpacing: 0,
  },
  infoPanel: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    borderTopWidth: 1,
    padding: 16,
  },
  infoHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  infoTitle: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 18,
    letterSpacing: -0.3,
  },
  infoStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  citationList: {
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    gap: 10,
  },
  citationHeading: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 12,
    letterSpacing: 0,
  },
  citationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  citationRowHighlighted: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  citationJumpBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: 4,
  },
  citationJumpBadgeText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 10,
    letterSpacing: 0,
  },
  citationCopy: {
    flex: 1,
  },
  citationTitle: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 12,
  },
  citationExcerpt: {
    fontFamily: 'Inter_400Regular',
    fontSize: 11,
    marginTop: 2,
  },
  statItem: {},
  statLabel: {
    fontFamily: 'Inter_500Medium',
    fontSize: 11,
    letterSpacing: 0,
    marginBottom: 4,
  },
  statValue: {
    fontFamily: 'Inter_700Bold',
    fontSize: 16,
  }
});
