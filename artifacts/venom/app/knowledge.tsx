import React, { useRef } from 'react';
import { View, Text, StyleSheet, ScrollView, Dimensions, TouchableOpacity, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import Svg, { Line } from 'react-native-svg';

import { useColors } from '@/hooks/useColors';
import { useVenom, KnowledgeCluster, SourceCitation } from '@/context/VenomContext';
import { Header } from '@/components/Header';

type MapCluster = KnowledgeCluster & { citations?: SourceCitation[] };

const { width, height } = Dimensions.get('window');
const MAP_SIZE = 1000;
const CENTER_X = MAP_SIZE / 2;
const CENTER_Y = MAP_SIZE / 2;

export default function KnowledgeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { state } = useVenom();

  const [selectedCluster, setSelectedCluster] = React.useState<MapCluster | null>(null);
  const activeSources = (state.sources ?? []).filter(
    source => !state.activeProjectId || source.projectId === state.activeProjectId,
  );
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

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Header
        title="KNOWLEDGE MATRIX"
        showBack
      />

      <View style={styles.mapContainer}>
        <ScrollView
          horizontal
          bounces={false}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ width: MAP_SIZE }}
          centerContent
        >
          <ScrollView
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
                    return (
                      <Line
                        key={`${cluster.id}-${targetId}`}
                        x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
                        stroke={colors.border}
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
                const size = 16 + cluster.strength * 24;

                return (
                  <TouchableOpacity
                    key={cluster.id}
                    style={[styles.node, {
                      left: p.x - size / 2,
                      top: p.y - size / 2,
                      width: size,
                      height: size,
                      borderRadius: size / 2,
                      backgroundColor: isSelected ? colors.primary : colors.accent,
                      borderColor: isSelected ? colors.foreground : colors.primary,
                      borderWidth: isSelected ? 2 : 1,
                    }]}
                    onPress={() => setSelectedCluster(cluster)}
                    activeOpacity={0.8}
                  >
                    {isSelected && (
                      <View style={[styles.pulse, { backgroundColor: colors.primary }]} />
                    )}
                  </TouchableOpacity>
                );
              })}

              {/* Draw Labels */}
              {clusters.map(cluster => {
                const p = getPos(cluster);
                const isSelected = selectedCluster?.id === cluster.id;
                const size = 16 + cluster.strength * 24;
                if (!isSelected && cluster.strength < 0.8) return null; // hide small labels

                return (
                  <Text key={`label-${cluster.id}`} style={[styles.nodeLabel, {
                    left: p.x - 60,
                    top: p.y + size / 2 + 8,
                    color: isSelected ? colors.primary : colors.mutedForeground,
                    opacity: isSelected ? 1 : 0.7
                  }]}>
                    {cluster.label}
                  </Text>
                );
              })}
            </View>
          </ScrollView>
        </ScrollView>

        {/* Selected Cluster Info */}
        {selectedCluster && (
          <View style={[styles.infoPanel, {
            backgroundColor: colors.card,
            borderColor: colors.border,
            paddingBottom: insets.bottom + 16
          }]}>
            <View style={styles.infoHeader}>
              <Text style={[styles.infoTitle, { color: colors.foreground }]}>{selectedCluster.label}</Text>
              <TouchableOpacity onPress={() => setSelectedCluster(null)}>
                <Feather name="x" size={20} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>
            <View style={styles.infoStats}>
              <View style={styles.statItem}>
                <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>CATEGORY</Text>
                <Text style={[styles.statValue, { color: colors.primary }]}>{selectedCluster.category.toUpperCase()}</Text>
              </View>
              <View style={styles.statItem}>
                <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>STRENGTH</Text>
                <Text style={[styles.statValue, { color: colors.primary }]}>{(selectedCluster.strength * 100).toFixed(0)}%</Text>
              </View>
              <View style={styles.statItem}>
                <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>CONNECTIONS</Text>
                  <Text style={[styles.statValue, { color: colors.primary }]}>{selectedCluster.citations?.length ?? selectedCluster.links.length}</Text>
              </View>
            </View>
              {selectedCluster.citations && selectedCluster.citations.length > 0 && (
                <View style={[styles.citationList, { borderTopColor: colors.border }]}>
                  <Text style={[styles.citationHeading, { color: colors.mutedForeground }]}>SOURCE CITATIONS</Text>
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
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  mapContainer: { flex: 1 },
  node: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#b4f536',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
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
    fontSize: 10,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
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
    fontFamily: 'Inter_700Bold',
    fontSize: 14,
    letterSpacing: 1,
    textTransform: 'uppercase',
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
    fontFamily: 'Inter_700Bold',
    fontSize: 10,
    letterSpacing: 1.2,
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
    fontSize: 10,
    letterSpacing: 1,
    marginBottom: 4,
  },
  statValue: {
    fontFamily: 'Inter_700Bold',
    fontSize: 16,
  }
});
