import React, { useState, useMemo, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  FlatList,
  ActivityIndicator,
  Platform,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";

import {
  getGetVenomSopQueryKey,
  getListVenomProjectSopsQueryKey,
  getListVenomSopsQueryKey,
  useGetVenomSop,
  useListVenomProjectSops,
  useListVenomSops,
  useSelectVenomProjectSops,
  type VenomSop,
  type VenomSopDetail,
  type VenomSopLifecycle,
  type VenomSopProjectSelection,
  type VenomSopRevision,
} from "@workspace/api-client-react";

import { Header } from "@/components/Header";
import { useColors } from "@/hooks/useColors";
import { useVenom } from "@/context/VenomContext";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LIFECYCLE_LABELS: Record<string, string> = {
  draft: "Draft",
  active: "Active",
  archived: "Archived",
};

const CATEGORY_LABELS: Record<string, string> = {
  operations: "Operations",
  brand: "Brand",
  customer_service: "Customer Service",
};

const PROVENANCE_LABELS: Record<string, string> = {
  manual: "Manual",
  imported: "Imported",
  model_assisted: "Model-assisted",
};

function lifecycleIcon(lifecycle: string): keyof typeof Feather.glyphMap {
  if (lifecycle === "active") return "check-circle";
  if (lifecycle === "archived") return "archive";
  return "edit-3";
}

function provenanceIsTrusted(provenance: string): boolean {
  return provenance === "manual";
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ---------------------------------------------------------------------------
// UntrustedBanner
// ---------------------------------------------------------------------------

function UntrustedBanner({ provenance }: { provenance: string }) {
  const colors = useColors();
  if (provenanceIsTrusted(provenance)) return null;
  return (
    <View
      style={[
        styles.untrustedBanner,
        { backgroundColor: colors.secondary, borderColor: colors.border },
      ]}
      accessible
      accessibilityRole="alert"
      accessibilityLabel={`This SOP is ${PROVENANCE_LABELS[provenance] ?? provenance} content and should be treated as untrusted reference material. Do not enter credentials or regulated data.`}
    >
      <Feather name="alert-triangle" size={14} color={colors.mutedForeground} />
      <View style={styles.untrustedCopy}>
        <Text
          style={[styles.untrustedTitle, { color: colors.foreground }]}
          testID="untrusted-banner-title"
        >
          Untrusted Reference Material
        </Text>
        <Text style={[styles.untrustedBody, { color: colors.mutedForeground }]}>
          This SOP was {PROVENANCE_LABELS[provenance]?.toLowerCase() ?? provenance}. Verify independently before acting. Do not enter credentials or regulated data.
        </Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// SopListItem
// ---------------------------------------------------------------------------

function SopListItem({
  sop,
  isSelected,
  isProjectActive,
  onPress,
}: {
  sop: VenomSop;
  isSelected: boolean;
  isProjectActive: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  const trusted = provenanceIsTrusted(sop.provenance);

  return (
    <TouchableOpacity
      testID={`sop-list-item-${sop.id}`}
      accessibilityRole="button"
      accessibilityLabel={`${sop.title}, ${LIFECYCLE_LABELS[sop.lifecycle] ?? sop.lifecycle}, ${CATEGORY_LABELS[sop.category] ?? sop.category}${isProjectActive ? ", active for this project" : ""}${!trusted ? ", imported or model-assisted" : ""}`}
      accessibilityState={{ selected: isSelected }}
      aria-selected={isSelected}
      onPress={onPress}
      style={[
        styles.sopRow,
        {
          backgroundColor: isSelected ? colors.secondary : colors.card,
          borderColor: isSelected ? colors.foreground : colors.border,
        },
      ]}
      activeOpacity={0.75}
    >
      <View style={styles.sopRowLeft}>
        <Feather
          name={lifecycleIcon(sop.lifecycle)}
          size={16}
          color={
            sop.lifecycle === "active"
              ? colors.foreground
              : colors.mutedForeground
          }
        />
        <View style={styles.sopRowCopy}>
          <Text
            numberOfLines={2}
            style={[styles.sopTitle, { color: colors.foreground }]}
          >
            {sop.title}
          </Text>
          <Text
            style={[styles.sopMeta, { color: colors.mutedForeground }]}
            numberOfLines={1}
          >
            {LIFECYCLE_LABELS[sop.lifecycle] ?? sop.lifecycle}
            {" · "}
            {CATEGORY_LABELS[sop.category] ?? sop.category}
            {!trusted ? " · Unverified" : ""}
          </Text>
        </View>
      </View>
      <View style={styles.sopRowRight}>
        {isProjectActive && (
          <View
            accessible
            accessibilityLabel="Active for this project"
            style={[
              styles.activeChip,
              { borderColor: colors.border, backgroundColor: colors.accent },
            ]}
          >
            <Feather name="bookmark" size={11} color={colors.foreground} />
          </View>
        )}
        <Feather
          name={isSelected ? "chevron-up" : "chevron-right"}
          size={16}
          color={colors.mutedForeground}
        />
      </View>
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// RevisionRow
// ---------------------------------------------------------------------------

function RevisionRow({
  revision,
  isActive,
  isExpanded,
  onPress,
}: {
  revision: VenomSopRevision;
  isActive: boolean;
  isExpanded: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <TouchableOpacity
      testID={`sop-revision-${revision.id}`}
      accessibilityRole="button"
      accessibilityLabel={`Revision ${revision.versionNumber}, published ${formatDate(revision.publishedAt)}${isActive ? ", current active revision" : ""}. ${isExpanded ? "Hide" : "Inspect"} revision content.`}
      accessibilityState={{ expanded: isExpanded }}
      aria-expanded={isExpanded}
      onPress={onPress}
      style={[
        styles.revisionRow,
        { borderColor: colors.border },
      ]}
    >
      <View style={styles.revisionLeft}>
        <Text style={[styles.revisionNumber, { color: colors.foreground }]}>
          v{revision.versionNumber}
        </Text>
        <Text
          style={[styles.revisionDate, { color: colors.mutedForeground }]}
        >
          {formatDate(revision.publishedAt)}
        </Text>
      </View>
      <View style={styles.revisionRight}>
        {isActive && (
          <View
            style={[
              styles.activeRevisionBadge,
              { borderColor: colors.border, backgroundColor: colors.accent },
            ]}
          >
            <Text
              style={[styles.activeRevisionText, { color: colors.foreground }]}
            >
              ACTIVE
            </Text>
          </View>
        )}
        <Text
          style={[styles.revisionChecksum, { color: colors.mutedForeground }]}
          numberOfLines={1}
        >
          {revision.checksumSha256.slice(0, 10)}
        </Text>
        <Feather
          name={isExpanded ? "chevron-up" : "chevron-down"}
          size={14}
          color={colors.mutedForeground}
        />
      </View>
    </TouchableOpacity>
  );
}

function MobileRevisionSnapshot({ revision }: { revision: VenomSopRevision }) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.revisionSnapshot,
        { borderColor: colors.border, backgroundColor: colors.secondary },
      ]}
      accessibilityLabel={`Immutable content for revision ${revision.versionNumber}`}
    >
      <Text style={[styles.revisionSnapshotMeta, { color: colors.mutedForeground }]}>
        IMMUTABLE REVISION · {revision.id}
      </Text>
      <Text
        style={[
          styles.revisionSnapshotChecksum,
          { color: colors.mutedForeground },
        ]}
        testID={`sop-revision-checksum-${revision.id}`}
      >
        SHA-256 · {revision.checksumSha256}
      </Text>
      <SopContentSection title="Purpose" items={[revision.content.purpose]} />
      <SopContentSection
        title="Prerequisites"
        items={revision.content.prerequisites}
      />
      <SopContentSection title="Inputs" items={revision.content.inputs} />
      <SopContentSection
        title="Guidance"
        items={revision.content.guidance}
        numbered
      />
      <SopContentSection
        title="Required Approvals"
        items={revision.content.requiredApprovals}
      />
      <SopContentSection
        title="Acceptance Checks"
        items={revision.content.acceptanceChecks}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// SopDetail
// ---------------------------------------------------------------------------

function SopDetail({
  sopId,
  projectId,
  projectSelections,
  onClose,
  onToggleProjectSop,
  isTogglingProjectSop,
}: {
  sopId: string;
  projectId: string | null;
  projectSelections: VenomSopProjectSelection[];
  onClose: () => void;
  onToggleProjectSop: (sopId: string, currentlySelected: boolean) => void;
  isTogglingProjectSop: boolean;
}) {
  const colors = useColors();
  const [showRevisions, setShowRevisions] = useState(false);
  const [expandedRevisionId, setExpandedRevisionId] = useState<string | null>(
    null,
  );

  const detailQuery = useGetVenomSop(sopId, {
    query: {
      queryKey: getGetVenomSopQueryKey(sopId),
      enabled: Boolean(sopId),
    },
  });

  const detail = detailQuery.data;
  const sop = detail?.sop;

  const isProjectSelected = projectSelections.some((s) => s.sopId === sopId);
  const canToggle = Boolean(projectId) && Boolean(sop) && sop?.lifecycle === "active";

  if (detailQuery.isLoading || !detail || !sop) {
    return (
      <View
        style={[styles.detailPanel, { borderColor: colors.border, backgroundColor: colors.card }]}
      >
        {detailQuery.isError ? (
          <View style={styles.detailErrorState}>
            <Feather name="alert-circle" size={20} color={colors.mutedForeground} />
            <Text style={[styles.detailErrorText, { color: colors.mutedForeground }]}>
              Could not load SOP details.
            </Text>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => detailQuery.refetch()}
            >
              <Text style={[styles.retryLink, { color: colors.foreground }]}>
                Try again
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          <ActivityIndicator
            color={colors.foreground}
            style={styles.detailLoader}
            accessible
            accessibilityLabel="Loading SOP details"
          />
        )}
      </View>
    );
  }

  const trusted = provenanceIsTrusted(sop.provenance);
  const sortedRevisions = [...(detail.revisions ?? [])].sort(
    (a, b) => b.versionNumber - a.versionNumber,
  );

  return (
    <View
      style={[
        styles.detailPanel,
        { borderColor: colors.border, backgroundColor: colors.card },
      ]}
    >
      <View style={styles.detailHeader}>
        <View style={styles.detailHeaderLeft}>
          <Text
            style={[styles.detailTitle, { color: colors.foreground }]}
            testID="sop-detail-title"
          >
            {sop.title}
          </Text>
          <Text style={[styles.detailMeta, { color: colors.mutedForeground }]}>
            {LIFECYCLE_LABELS[sop.lifecycle] ?? sop.lifecycle}
            {" · "}
            {CATEGORY_LABELS[sop.category] ?? sop.category}
            {" · "}
            {PROVENANCE_LABELS[sop.provenance] ?? sop.provenance}
          </Text>
        </View>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Close SOP detail"
          onPress={onClose}
          hitSlop={12}
          testID="sop-detail-close"
        >
          <Feather name="x" size={20} color={colors.foreground} />
        </TouchableOpacity>
      </View>

      <UntrustedBanner provenance={sop.provenance} />

      <ScrollView
        style={styles.detailScroll}
        contentContainerStyle={styles.detailScrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Tags */}
        {sop.tags.length > 0 && (
          <View style={styles.tagRow} accessibilityRole="list" accessibilityLabel="Tags">
            {sop.tags.map((tag) => (
              <View
                key={tag}
                style={[styles.tag, { borderColor: colors.border }]}
              >
                <Text style={[styles.tagText, { color: colors.mutedForeground }]}>
                  {tag}
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* Structured content */}
        <SopContentSection title="Purpose" items={[sop.content.purpose]} />
        <SopContentSection title="Prerequisites" items={sop.content.prerequisites} />
        <SopContentSection title="Inputs" items={sop.content.inputs} />
        <SopContentSection title="Guidance" items={sop.content.guidance} numbered />
        <SopContentSection title="Required Approvals" items={sop.content.requiredApprovals} />
        <SopContentSection title="Acceptance Checks" items={sop.content.acceptanceChecks} />

        {/* Revision history */}
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={showRevisions ? "Hide revision history" : "Show revision history"}
          accessibilityState={{ expanded: showRevisions }}
          onPress={() => setShowRevisions((v) => !v)}
          style={styles.revisionsToggle}
          testID="sop-revisions-toggle"
        >
          <Text style={[styles.revisionsToggleText, { color: colors.foreground }]}>
            Revisions ({sortedRevisions.length})
          </Text>
          <Feather
            name={showRevisions ? "chevron-up" : "chevron-down"}
            size={16}
            color={colors.mutedForeground}
          />
        </TouchableOpacity>

        {showRevisions && sortedRevisions.length > 0 && (
          <View accessibilityRole="list" accessibilityLabel="Revision history">
            {sortedRevisions.map((rev) => (
              <React.Fragment key={rev.id}>
                <RevisionRow
                  revision={rev}
                  isActive={rev.id === sop.activeRevisionId}
                  isExpanded={expandedRevisionId === rev.id}
                  onPress={() =>
                    setExpandedRevisionId((current) =>
                      current === rev.id ? null : rev.id,
                    )
                  }
                />
                {expandedRevisionId === rev.id && (
                  <MobileRevisionSnapshot revision={rev} />
                )}
              </React.Fragment>
            ))}
          </View>
        )}

        {showRevisions && sortedRevisions.length === 0 && (
          <Text style={[styles.emptyRevisions, { color: colors.mutedForeground }]}>
            No published revisions yet.
          </Text>
        )}

        {/* Project selection */}
        {projectId && (
          <View style={[styles.projectSelectionRow, { borderTopColor: colors.border }]}>
            {!canToggle && sop.lifecycle !== "active" && (
              <Text style={[styles.selectionHint, { color: colors.mutedForeground }]}>
                Only active SOPs can be selected for a project.
              </Text>
            )}
            {canToggle && (
              <TouchableOpacity
                testID={isProjectSelected ? "sop-deselect-project" : "sop-select-project"}
                accessibilityRole="checkbox"
                accessibilityLabel={
                  isProjectSelected
                    ? `Remove ${sop.title} from the active project`
                    : `Add ${sop.title} to the active project`
                }
                accessibilityState={{ checked: isProjectSelected }}
                aria-checked={isProjectSelected}
                disabled={isTogglingProjectSop}
                onPress={() => onToggleProjectSop(sop.id, isProjectSelected)}
                style={[
                  styles.selectionButton,
                  {
                    backgroundColor: isProjectSelected
                      ? colors.foreground
                      : colors.secondary,
                    borderColor: colors.border,
                  },
                ]}
              >
                {isTogglingProjectSop ? (
                  <ActivityIndicator
                    size="small"
                    color={isProjectSelected ? colors.background : colors.foreground}
                  />
                ) : (
                  <>
                    <Feather
                      name={isProjectSelected ? "bookmark" : "bookmark"}
                      size={15}
                      color={isProjectSelected ? colors.background : colors.foreground}
                    />
                    <Text
                      style={[
                        styles.selectionButtonText,
                        {
                          color: isProjectSelected
                            ? colors.background
                            : colors.foreground,
                        },
                      ]}
                    >
                      {isProjectSelected
                        ? "Remove from Project"
                        : "Add to Project"}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------------------
// SopContentSection
// ---------------------------------------------------------------------------

function SopContentSection({
  title,
  items,
  numbered = false,
}: {
  title: string;
  items: string[];
  numbered?: boolean;
}) {
  const colors = useColors();
  if (!items || items.length === 0) return null;
  return (
    <View style={styles.contentSection}>
      <Text style={[styles.contentSectionTitle, { color: colors.mutedForeground }]}>
        {title.toUpperCase()}
      </Text>
      {items.map((item, i) => (
        <View
          key={i}
          style={styles.contentItem}
          accessibilityRole="text"
        >
          <Text style={[styles.contentBullet, { color: colors.mutedForeground }]}>
            {numbered ? `${i + 1}.` : "\u2022"}
          </Text>
          <Text style={[styles.contentItemText, { color: colors.foreground }]}>
            {item}
          </Text>
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function SopsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const queryClient = useQueryClient();
  const { state } = useVenom();

  const activeProject = state.projects.find(
    (p) => p.id === state.activeProjectId,
  );
  const projectId = activeProject?.id ?? null;

  const [query, setQuery] = useState("");
  const [lifecycleFilter, setLifecycleFilter] = useState<string>("active");
  const [selectedSopId, setSelectedSopId] = useState<string | null>(null);
  const useCompactDetail = Platform.OS !== "web" || width < 700;

  // List all SOPs with optional filter
  const sopsQuery = useListVenomSops(
    {
      query: query.trim() || undefined,
      lifecycle: lifecycleFilter
        ? (lifecycleFilter as VenomSopLifecycle)
        : undefined,
    },
    {
      query: {
        queryKey: getListVenomSopsQueryKey({
          query: query.trim() || undefined,
          lifecycle: lifecycleFilter
            ? (lifecycleFilter as VenomSopLifecycle)
            : undefined,
        }),
      },
    },
  );

  // Project SOP selections
  const projectSopsQuery = useListVenomProjectSops(projectId ?? "", {
    query: {
      queryKey: getListVenomProjectSopsQueryKey(projectId ?? ""),
      enabled: Boolean(projectId),
    },
  });

  const projectSelections: VenomSopProjectSelection[] =
    projectSopsQuery.data ?? [];

  // Mutation: select / deselect SOPs for active project
  const selectMutation = useSelectVenomProjectSops({
    mutation: {
      onSuccess: async () => {
        if (projectId) {
          await queryClient.invalidateQueries({
            queryKey: getListVenomProjectSopsQueryKey(projectId),
          });
        }
      },
    },
  });

  const handleToggleProjectSop = useCallback(
    (sopId: string, currentlySelected: boolean) => {
      if (!projectId) return;
      const currentIds = projectSelections.map((s) => s.sopId);
      const nextIds = currentlySelected
        ? currentIds.filter((id) => id !== sopId)
        : [...currentIds, sopId];
      selectMutation.mutate({
        projectId,
        data: { sopIds: nextIds },
      });
    },
    [projectId, projectSelections, selectMutation],
  );

  const filteredSops = useMemo(() => {
    return sopsQuery.data ?? [];
  }, [sopsQuery.data]);

  const LIFECYCLE_FILTERS = [
    { key: "active", label: "Active" },
    { key: "draft", label: "Draft" },
    { key: "archived", label: "Archived" },
    { key: "", label: "All" },
  ];

  return (
    <View
      style={[styles.screen, { backgroundColor: colors.background }]}
      testID="sops-screen"
    >
      <Header title="Procedures" showBack />

      {/* Project context */}
      <View
        style={[styles.projectBanner, { backgroundColor: colors.secondary, borderBottomColor: colors.border }]}
        accessible
        accessibilityLabel={
          activeProject
            ? `Active project: ${activeProject.name}`
            : "No active project selected"
        }
      >
        <Feather name="folder" size={13} color={colors.mutedForeground} />
        <Text style={[styles.projectBannerText, { color: colors.mutedForeground }]}>
          {activeProject ? activeProject.name.toUpperCase() : "NO PROJECT SELECTED"}
        </Text>
      </View>

      {/* Security notice */}
      <View
        style={[styles.securityNotice, { backgroundColor: colors.card, borderBottomColor: colors.border }]}
        accessible
        accessibilityRole="alert"
        accessibilityLabel="Do not enter credentials or regulated data into this interface."
        testID="security-notice"
      >
        <Feather name="shield" size={12} color={colors.mutedForeground} />
        <Text style={[styles.securityNoticeText, { color: colors.mutedForeground }]}>
          Read-only reference. Do not enter credentials or regulated data.
        </Text>
      </View>

      {/* Search */}
      <View style={[styles.searchRow, { borderBottomColor: colors.border, backgroundColor: colors.background }]}>
        <View
          style={[styles.searchInputWrapper, { backgroundColor: colors.secondary, borderColor: colors.border }]}
        >
          <Feather name="search" size={15} color={colors.mutedForeground} />
          <TextInput
            testID="sop-search-input"
            accessibilityLabel="Search procedures"
            style={[styles.searchInput, { color: colors.foreground }]}
            placeholder="Search procedures..."
            placeholderTextColor={colors.mutedForeground}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            returnKeyType="search"
          />
        </View>
      </View>

      {/* Lifecycle filter tabs */}
      <View
        style={[styles.filterRow, { borderBottomColor: colors.border, backgroundColor: colors.background }]}
        accessibilityRole="tablist"
        accessibilityLabel="Filter procedures by lifecycle"
      >
        {LIFECYCLE_FILTERS.map((f) => {
          const active = lifecycleFilter === f.key;
          return (
            <TouchableOpacity
              key={f.key}
              accessibilityRole="tab"
              accessibilityLabel={`Filter by ${f.label}`}
              accessibilityState={{ selected: active }}
              aria-selected={active}
              onPress={() => setLifecycleFilter(f.key)}
              style={[
                styles.filterTab,
                active && { borderBottomColor: colors.foreground, borderBottomWidth: 2 },
              ]}
              testID={`sop-filter-${f.key || "all"}`}
            >
              <Text
                style={[
                  styles.filterTabText,
                  {
                    color: active ? colors.foreground : colors.mutedForeground,
                    fontFamily: active ? "Inter_600SemiBold" : "Inter_500Medium",
                  },
                ]}
              >
                {f.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* List + detail layout */}
      <View style={styles.body}>
        {/* SOP list */}
        <View
          style={[
            styles.listColumn,
            selectedSopId
              ? useCompactDetail
                ? styles.listColumnHidden
                : styles.listColumnNarrow
              : null,
          ]}
        >
          {sopsQuery.isLoading ? (
            <View
              style={styles.centered}
              accessible
              accessibilityLabel="Loading procedures"
            >
              <ActivityIndicator color={colors.foreground} />
            </View>
          ) : sopsQuery.isError ? (
            <View style={styles.centered}>
              <Feather name="alert-circle" size={22} color={colors.mutedForeground} />
              <Text style={[styles.errorText, { color: colors.mutedForeground }]}>
                Could not load procedures.
              </Text>
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => sopsQuery.refetch()}
              >
                <Text style={[styles.retryLink, { color: colors.foreground }]}>
                  Try again
                </Text>
              </TouchableOpacity>
            </View>
          ) : filteredSops.length === 0 ? (
            <View style={styles.centered}>
              <Feather name="file-text" size={28} color={colors.mutedForeground} />
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
                {query ? "No matching procedures" : "No procedures found"}
              </Text>
              <Text style={[styles.emptyCopy, { color: colors.mutedForeground }]}>
                {query
                  ? "Try adjusting your search or filter."
                  : "No procedures are available in this view."}
              </Text>
            </View>
          ) : (
            <FlatList
              data={filteredSops}
              keyExtractor={(item) => item.id}
              contentContainerStyle={[
                styles.listContent,
                { paddingBottom: insets.bottom + 24 },
              ]}
              showsVerticalScrollIndicator={false}
              scrollEnabled={filteredSops.length > 0}
              renderItem={({ item }) => (
                <SopListItem
                  sop={item}
                  isSelected={selectedSopId === item.id}
                  isProjectActive={projectSelections.some((s) => s.sopId === item.id)}
                  onPress={() =>
                    setSelectedSopId((prev) => (prev === item.id ? null : item.id))
                  }
                />
              )}
            />
          )}
        </View>

        {/* Detail panel (shown when a SOP is selected) */}
        {selectedSopId && (
          <View
            style={[
              styles.detailColumn,
              useCompactDetail ? styles.detailColumnFull : null,
            ]}
          >
            <SopDetail
              sopId={selectedSopId}
              projectId={projectId}
              projectSelections={projectSelections}
              onClose={() => setSelectedSopId(null)}
              onToggleProjectSop={handleToggleProjectSop}
              isTogglingProjectSop={selectMutation.isPending}
            />
          </View>
        )}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  projectBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  projectBannerText: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
    letterSpacing: 1,
  },
  securityNotice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderBottomWidth: 1,
  },
  securityNoticeText: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    lineHeight: 16,
    flex: 1,
  },
  searchRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  searchInputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === "ios" ? 9 : 6,
  },
  searchInput: {
    flex: 1,
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    minHeight: 22,
  },
  filterRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    paddingHorizontal: 12,
  },
  filterTab: {
    paddingHorizontal: 10,
    paddingVertical: 10,
    marginRight: 4,
  },
  filterTabText: {
    fontSize: 13,
    letterSpacing: 0.2,
  },
  body: {
    flex: 1,
    flexDirection: "row",
  },
  listColumn: {
    flex: 1,
  },
  listColumnNarrow: {
    flex: 0.42,
  },
  listColumnHidden: {
    display: "none",
  },
  detailColumn: {
    flex: Platform.OS === "web" ? 0.58 : 1,
  },
  detailColumnFull: {
    flex: 1,
  },
  listContent: {
    padding: 10,
    gap: 6,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 12,
  },
  emptyTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
  },
  emptyCopy: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
  },
  errorText: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
  },
  retryLink: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    textDecorationLine: "underline",
  },
  // SopListItem
  sopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
  },
  sopRowLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  sopRowCopy: {
    flex: 1,
  },
  sopTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    lineHeight: 19,
  },
  sopMeta: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    marginTop: 3,
    letterSpacing: 0.2,
  },
  sopRowRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginLeft: 8,
  },
  activeChip: {
    borderWidth: 1,
    borderRadius: 4,
    padding: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  // Detail panel
  detailPanel: {
    flex: 1,
    borderTopWidth: Platform.OS === "web" ? 0 : 0,
    borderLeftWidth: Platform.OS === "web" ? 1 : 0,
  },
  detailLoader: {
    flex: 1,
    margin: 40,
  },
  detailErrorState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 12,
  },
  detailErrorText: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
  },
  detailHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    padding: 16,
    paddingBottom: 12,
  },
  detailHeaderLeft: {
    flex: 1,
    paddingRight: 12,
  },
  detailTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
    lineHeight: 22,
  },
  detailMeta: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    marginTop: 4,
    letterSpacing: 0.3,
  },
  detailScroll: {
    flex: 1,
  },
  detailScrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  // Untrusted banner
  untrustedBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 10,
    borderWidth: 1,
    borderRadius: 6,
  },
  untrustedCopy: {
    flex: 1,
  },
  untrustedTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
  },
  untrustedBody: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    lineHeight: 16,
    marginTop: 2,
  },
  // Tags
  tagRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: 14,
  },
  tag: {
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  tagText: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
  },
  // Content sections
  contentSection: {
    marginBottom: 16,
  },
  contentSectionTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
    letterSpacing: 1.1,
    marginBottom: 8,
  },
  contentItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    marginBottom: 6,
  },
  contentBullet: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    lineHeight: 20,
    minWidth: 16,
  },
  contentItemText: {
    flex: 1,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 20,
  },
  // Revisions
  revisionsToggle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: "transparent",
    marginTop: 8,
  },
  revisionsToggleText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  revisionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    borderTopWidth: 1,
  },
  revisionLeft: {
    gap: 2,
  },
  revisionNumber: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  revisionDate: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
  },
  revisionRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  activeRevisionBadge: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  activeRevisionText: {
    fontFamily: "Inter_700Bold",
    fontSize: 9,
    letterSpacing: 1,
  },
  revisionChecksum: {
    fontFamily: "Inter_500Medium",
    fontSize: 10,
    letterSpacing: 0.5,
  },
  revisionSnapshot: {
    borderWidth: 1,
    borderTopWidth: 0,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 2,
  },
  revisionSnapshotMeta: {
    fontFamily: "Inter_500Medium",
    fontSize: 9,
    letterSpacing: 0.7,
    marginBottom: 12,
  },
  revisionSnapshotChecksum: {
    fontFamily: "Inter_400Regular",
    fontSize: 9,
    lineHeight: 14,
    marginBottom: 10,
  },
  emptyRevisions: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    marginTop: 8,
  },
  // Project selection
  projectSelectionRow: {
    borderTopWidth: 1,
    paddingTop: 16,
    marginTop: 8,
  },
  selectionHint: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 17,
  },
  selectionButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 11,
    justifyContent: "center",
    minHeight: 44,
  },
  selectionButtonText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
});
