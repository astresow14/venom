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
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Svg, { Line } from 'react-native-svg';
import { useUser } from '@clerk/expo';
import {
  useGetVenomOntologyConcept,
  getGetVenomOntologyConceptQueryKey,
} from '@workspace/api-client-react';

import { useColors } from '@/hooks/useColors';
import { useVenom, KnowledgeCluster, SourceCitation } from '@/context/VenomContext';
import { describeLastSync } from '@/context/sourceState';
import { Header } from '@/components/Header';

type MapCluster = KnowledgeCluster & { citations?: SourceCitation[] };
type KnowledgeView = 'map' | 'sources';

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
  const { state } = useVenom();
  const params = useLocalSearchParams<{ view?: string; source?: string }>();
  // A chat citation can point at the source it came from, so the sources view
  // opens scrolled to that source with it marked out from the rest.
  const requestedSourceId =
    typeof params.source === 'string' && params.source ? params.source : null;

  const [selectedCluster, setSelectedCluster] = React.useState<MapCluster | null>(null);
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
    {
      query: {
        queryKey: getGetVenomOntologyConceptQueryKey(chatCluster?.id ?? ''),
        enabled: Boolean(chatCluster),
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
  const sourceListRef = React.useRef<ScrollView | null>(null);
  const sourceOffsets = React.useRef<Record<string, number>>({});
  const pendingScrollRef = React.useRef<string | null>(requestedSourceId);

  // The jump target may not be laid out yet, so the scroll is retried from each
  // card's layout pass until the requested card reports its offset.
  const scrollToPendingSource = React.useCallback(() => {
    const pending = pendingScrollRef.current;
    if (!pending) return;
    const offset = sourceOffsets.current[pending];
    if (offset === undefined) return;
    pendingScrollRef.current = null;
    sourceListRef.current?.scrollTo({
      y: Math.max(offset - 12, 0),
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
    pendingScrollRef.current = requestedSourceId;
    scrollToPendingSource();
  }, [requestedSourceId, scrollToPendingSource]);
  const now = Date.now();
  const activeSources = (state.sources ?? []).filter(
    source => !state.activeProjectId || source.projectId === state.activeProjectId,
  );

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
  const sourceClusters: MapCluster[] = activeSources.flatMap((source, sourceIndex) =>
    source.clusters.map((cluster, clusterIndex) => ({
      id: cluster.id,
      projectId: source.projectId,
      label: cluster.label,
      category: cluster.category,
      strength: cluster.strength,
      x: ((sourceIndex * 149 + clusterIndex * 83) % 440) - 220,
      y: ((sourceIndex * 97 + clusterIndex * 131) % 300) - 150,
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
    })),
  );
  const clusters: MapCluster[] = [...state.clusters, ...sourceClusters];

  const getPos = (c: KnowledgeCluster) => ({
    x: CENTER_X + c.x * 2,
    y: CENTER_Y + c.y * 2
  });

  // The map search never removes nodes: matches keep their label and full
  // presence while everything else dims, so the constellation keeps its shape
  // and the sought topic stands out inside it.
  const mapSearch = mapQuery.trim().toLowerCase();
  const isMapSearching = mapSearch.length > 0;
  const matchedClusterIds = new Set(
    isMapSearching
      ? clusters
          .filter(
            cluster =>
              matches(cluster.label, mapSearch) ||
              matches(cluster.category, mapSearch),
          )
          .map(cluster => cluster.id)
      : [],
  );
  const matchCount = matchedClusterIds.size;
  const bestMatch = clusters.reduce<MapCluster | null>(
    (best, cluster) =>
      matchedClusterIds.has(cluster.id) &&
      (!best || cluster.strength > best.strength)
        ? cluster
        : best,
    null,
  );
  const bestMatchId = bestMatch?.id ?? null;
  const bestMatchRef = React.useRef<MapCluster | null>(null);
  bestMatchRef.current = bestMatch;
  const mapScrollXRef = React.useRef<ScrollView | null>(null);
  const mapScrollYRef = React.useRef<ScrollView | null>(null);
  const mapViewportRef = React.useRef({ width, height });

  // Highlighting alone cannot find a topic that sits outside the viewport, so
  // the map pans to the strongest match as the search narrows.
  React.useEffect(() => {
    const target = bestMatchRef.current;
    if (!bestMatchId || !target) return;
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
  }, [bestMatchId]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Header
        title="Knowledge"
        showBack
      />

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
                // Leaving the sources view retires the jump marker: it points
                // at where the reader arrived, not at a lasting selection.
                if (option.key !== 'sources') setHighlightedSourceId(null);
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
              placeholder="Search clusters by label or category..."
              placeholderTextColor={colors.mutedForeground}
              accessibilityLabel="Search map clusters by label or category"
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
            <Text
              style={[styles.mapMatchCount, { color: colors.mutedForeground }]}
              accessibilityLiveRegion="polite"
              testID="knowledge-map-match-count"
            >
              {matchCount === 0
                ? `No clusters match “${mapQuery.trim()}”. Search matches labels and categories.`
                : `${matchCount} of ${clusters.length} cluster${clusters.length === 1 ? '' : 's'} match`}
            </Text>
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
                >
                  {citations.map(citation => (
                    <TouchableOpacity
                      key={citation.id}
                      style={styles.citationRow}
                      onPress={() => Linking.openURL(citation.url)}
                      accessibilityRole="link"
                      accessibilityLabel={`Open source: ${citation.title}`}
                      testID={`knowledge-citation-${citation.id}`}
                      activeOpacity={0.7}
                    >
                      <View style={styles.citationCopy}>
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
                  ))}
                </View>
              </View>
              );
            })
          )}
        </ScrollView>
      )}

      <View
        style={[styles.mapContainer, view !== 'map' && styles.hidden]}
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
  mapMatchCount: {
    fontFamily: 'Inter_400Regular',
    fontSize: 11,
    marginTop: 8,
    paddingHorizontal: 6,
  },
  sourcesContainer: { flex: 1 },
  sourcesContent: {
    padding: 16,
    gap: 12,
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
