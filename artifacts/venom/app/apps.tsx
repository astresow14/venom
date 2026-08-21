import React, { useMemo, useRef, useState, useEffect } from "react";
import {
  ActivityIndicator,
  Animated as RNAnimated,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Crypto from "expo-crypto";
import * as DocumentPicker from "expo-document-picker";
import { useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { Easing, useSharedValue, useAnimatedStyle, withRepeat, withTiming, withSequence, useReducedMotion } from "react-native-reanimated";
import { useLocalSearchParams } from "expo-router";

import {
  getGetVenomAppQueryKey,
  getListVenomAppsQueryKey,
  getGetVenomAppIterationContextQueryKey,
  useCompleteVenomAppImportUpload,
  useCreateVenomApp,
  useCreateVenomAppImport,
  useCreateVenomAppIteration,
  useDismissVenomAppImprovementSuggestion,
  useGetVenomApp,
  useGetVenomAppIterationContext,
  getVenomAppTimeline,
  type VenomAppTimelineEntry,
  useListVenomApps,
  useRetryVenomAppImport,
  useUpdateVenomApp,
  type VenomImportJob,
  useListVenomBuildRuns,
  useCreateVenomBuildRun,
  useGetVenomBuildRun,
  useCancelVenomBuildRun,
  useRetryVenomBuildRun,
  useApproveVenomBuildRun,
  useRejectVenomBuildRun,
  useListVenomSops,
  VenomBuildTargetType,
  getListVenomBuildRunsQueryKey,
  getGetVenomBuildRunQueryKey,
  type VenomBuildRunSummary,
  useGetProvisioningCapability,
  getGetProvisioningCapabilityQueryKey,
  useListProvisioningRuns,
  getListProvisioningRunsQueryKey,
  useGetProvisioningRun,
  getGetProvisioningRunQueryKey,
  useProvisionBuildRun,
  useCancelProvisioningRun,
  useRetryProvisioningRun,
  usePublishProvisioningCandidate,
  useRollbackProvisioningRelease,
  type ProvisioningRunSummary,
  type ProvisioningRun,
  type ProvisioningCandidateRelease
} from "@workspace/api-client-react";

import { Header } from "@/components/Header";
import { useColors } from "@/hooks/useColors";
import { useVenom } from "@/context/VenomContext";

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

type FocusableHandle = {
  focus?: () => void;
};

function statusLabel(status: string | null | undefined): string {
  return (status ?? "draft").replaceAll("_", " ");
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : (error as any)?.response?.data?.message || "Something went wrong. Please try again.";
}

function OrganicIndicator({ color, size = 8 }: { color: string; size?: number }) {
  const reducedMotion = useReducedMotion();
  const breath = useSharedValue(0.5);

  useEffect(() => {
    if (!reducedMotion) {
      breath.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.5, { duration: 1200, easing: Easing.inOut(Easing.ease) })
        ),
        -1,
        true
      );
    } else {
      breath.value = 1;
    }
  }, [reducedMotion]);

  const style = useAnimatedStyle(() => {
    if (reducedMotion) return { opacity: 1, transform: [{ scale: 1 }] };
    return {
      opacity: breath.value,
      transform: [{ scale: 0.8 + 0.4 * breath.value }]
    };
  });

  return (
    <Animated.View style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }, style]} />
  );
}

// -----------------------------------------
// PORTFOLIO VIEW
// -----------------------------------------
function PortfolioView({
  onIterationStarted,
}: {
  onIterationStarted: (runId: string) => void;
}) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { state: workspaceState } = useVenom();
  const [selectedAppId, setSelectedAppId] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [isSubmittingCreate, setIsSubmittingCreate] = useState(false);
  const [createButtonFocused, setCreateButtonFocused] = useState(false);
  const [focusedAppCardId, setFocusedAppCardId] = useState<string | null>(
    null,
  );
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [brand, setBrand] = useState("");
  const [deploymentUrl, setDeploymentUrl] = useState("");
  const [localStatus, setLocalStatus] = useState("");
  const [error, setError] = useState("");
  const lastAssetRef = useRef<DocumentPicker.DocumentPickerAsset | null>(null);
  const reducedMotion = useReducedMotion();
  const createDialogAppear = useRef(new RNAnimated.Value(0)).current;
  const createButtonRef = useRef<FocusableHandle | null>(null);
  const appCardRefs = useRef<Map<string, FocusableHandle>>(new Map());
  const pendingCreateFocusRef = useRef<string | null>(null);

  const appsQuery = useListVenomApps();
  const detailQuery = useGetVenomApp(selectedAppId, {
    query: {
      enabled: Boolean(selectedAppId),
      refetchInterval: selectedAppId ? 2_000 : false,
      queryKey: getGetVenomAppQueryKey(selectedAppId),
    },
  });
  const createApp = useCreateVenomApp();
  const createImport = useCreateVenomAppImport();
  const completeImport = useCompleteVenomAppImportUpload();
  const retryImport = useRetryVenomAppImport();
  const updateApp = useUpdateVenomApp();
  const dismissSuggestion = useDismissVenomAppImprovementSuggestion();
  const createIteration = useCreateVenomAppIteration();

  const [linkPickerVisible, setLinkPickerVisible] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [improveVisible, setImproveVisible] = useState(false);
  const [improveInstruction, setImproveInstruction] = useState("");
  const [improveConstraints, setImproveConstraints] = useState("");
  const [improveError, setImproveError] = useState("");
  const [improveIdemKey, setImproveIdemKey] = useState("");
  const [expandedTimelineAppId, setExpandedTimelineAppId] = useState("");
  const [olderTimelines, setOlderTimelines] = useState<
    Record<
      string,
      {
        entries: VenomAppTimelineEntry[];
        nextCursor: string | null;
        anchorTailId: string | null;
      }
    >
  >({});
  const [timelineLoadingAppId, setTimelineLoadingAppId] = useState("");
  const [timelineErrorAppId, setTimelineErrorAppId] = useState("");

  const handleTimelineToggle = (appId: string) => {
    setExpandedTimelineAppId(expandedTimelineAppId === appId ? "" : appId);
  };

  // One keyset page per tap — no client-side cap, so every entry stays
  // reachable however long the history grows. Failures surface inline with
  // a retry that keeps the view expanded.
  const handleTimelineLoadMore = async (
    appId: string,
    shownEntries: VenomAppTimelineEntry[],
    embeddedTailId: string | null,
  ) => {
    setTimelineLoadingAppId(appId);
    setTimelineErrorAppId("");
    try {
      const stored = olderTimelines[appId];
      const last = shownEntries[shownEntries.length - 1];
      const cursor =
        stored?.nextCursor ??
        (last ? `${last.occurredAt}~${last.id}` : undefined);
      const page = await getVenomAppTimeline(
        appId,
        cursor ? { limit: 200, cursor } : { limit: 200 },
      );
      setOlderTimelines((current) => ({
        ...current,
        [appId]: {
          entries: [...(current[appId]?.entries ?? []), ...page.entries],
          nextCursor: page.nextCursor,
          anchorTailId: current[appId]?.anchorTailId ?? embeddedTailId,
        },
      }));
    } catch {
      setTimelineErrorAppId(appId);
    } finally {
      setTimelineLoadingAppId("");
    }
  };

  const iterationContextQuery = useGetVenomAppIterationContext(selectedAppId, {
    query: {
      enabled: Boolean(selectedAppId) && improveVisible,
      queryKey: getGetVenomAppIterationContextQueryKey(selectedAppId),
    },
  });

  const detail = detailQuery.data;

  // Live detail refreshes (2s polling) can shift the capped embedded timeline
  // slice: a new entry displaces the former tail, and cached older pages no
  // longer continue from what is on screen — the displaced entry would be in
  // neither list. Reset that app's paging so the next load starts from the
  // refreshed tail and recovers it.
  useEffect(() => {
    if (!detail) return;
    const stored = olderTimelines[detail.app.id];
    if (!stored) return;
    const tailId =
      detail.timeline.length > 0
        ? detail.timeline[detail.timeline.length - 1].id
        : null;
    if (stored.anchorTailId === tailId) return;
    setOlderTimelines((current) => {
      const next = { ...current };
      delete next[detail.app.id];
      return next;
    });
    setTimelineErrorAppId((current) =>
      current === detail.app.id ? "" : current,
    );
  }, [detail, olderTimelines]);
  const activeJob = useMemo(
    () =>
      detail?.importJobs.find((job) =>
        ["awaiting_upload", "uploading", "validating", "inspecting"].includes(
          job.status,
        ),
      ),
    [detail?.importJobs],
  );

  const refresh = async (appId?: string) => {
    await queryClient.invalidateQueries({ queryKey: getListVenomAppsQueryKey() });
    if (appId) {
      await queryClient.invalidateQueries({ queryKey: getGetVenomAppQueryKey(appId) });
    }
  };

  // The dialog animates its own card because the modal container must not
  // animate on web: an animated modal keeps its focus trap alive while it
  // fades out and strands keyboard focus (see the card editor in
  // BoardWorkspace for the shared pattern).
  useEffect(() => {
    if (!isCreating) return;
    createDialogAppear.setValue(reducedMotion ? 1 : 0);
    if (reducedMotion) return;
    const appearance = RNAnimated.timing(createDialogAppear, {
      toValue: 1,
      duration: 170,
      useNativeDriver: Platform.OS !== "web",
    });
    appearance.start();
    return () => appearance.stop();
  }, [createDialogAppear, isCreating, reducedMotion]);

  const registerAppCard =
    (appId: string) => (node: FocusableHandle | null) => {
      if (node) appCardRefs.current.set(appId, node);
      else appCardRefs.current.delete(appId);
    };

  const openCreateDialog = () => {
    pendingCreateFocusRef.current = null;
    setIsCreating(true);
  };

  const cancelCreateDialog = () => {
    pendingCreateFocusRef.current = null;
    setIsCreating(false);
  };

  // Fires once the modal is actually gone (immediately on web) and its focus
  // trap has released. Prefers the card of the app the dialog just created;
  // the create button is the fallback that always exists.
  const handleCreateDialogDismiss = () => {
    const appId = pendingCreateFocusRef.current;
    pendingCreateFocusRef.current = null;
    const target =
      (appId ? appCardRefs.current.get(appId) : undefined) ??
      createButtonRef.current;
    target?.focus?.();
  };

  const handleCreate = async () => {
    if (
      !name.trim() ||
      !purpose.trim() ||
      !brand.trim() ||
      isSubmittingCreate
    ) {
      return;
    }
    setError("");
    setIsSubmittingCreate(true);
    try {
      const created = await createApp.mutateAsync({
        data: {
          name: name.trim(),
          purpose: purpose.trim(),
          brand: brand.trim(),
          deploymentUrl: deploymentUrl.trim() || null,
        },
      });
      setSelectedAppId(created.id);
      // Keep the dialog up until the refreshed list contains the new app, so
      // dismissal can hand keyboard focus to the created card rather than to
      // a control that does not exist yet.
      await refresh(created.id);
      setName("");
      setPurpose("");
      setBrand("");
      setDeploymentUrl("");
      pendingCreateFocusRef.current = created.id;
      setIsCreating(false);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setIsSubmittingCreate(false);
    }
  };

  const uploadAsset = async (appId: string, asset: DocumentPicker.DocumentPickerAsset, retryJob?: VenomImportJob) => {
    const size = asset.size ?? 0;
    if (!asset.name.toLowerCase().endsWith(".zip")) { setError("Choose a ZIP archive."); return; }
    if (size < 1 || size > MAX_ARCHIVE_BYTES) { setError("ZIP archives must be 50 MB or smaller."); return; }
    if (retryJob && (asset.name !== retryJob.archiveFilename || size !== retryJob.declaredBytes)) {
      setError("Choose the same ZIP file used by this failed import.");
      return;
    }
    setError("");
    setLocalStatus("Preparing secure upload");
    lastAssetRef.current = asset;
    try {
      const ticket = retryJob
        ? await retryImport.mutateAsync({ appId, importJobId: retryJob.id })
        : await createImport.mutateAsync({
            appId,
            data: { filename: asset.name, size, idempotencyKey: Crypto.randomUUID().replaceAll("-", "_") },
          });

      setLocalStatus("Uploading private source package");
      const fileResponse = await fetch(asset.uri);
      const blob = await fileResponse.blob();
      const uploadResponse = await fetch(ticket.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": ticket.requiredContentType },
        body: blob,
      });
      if (!uploadResponse.ok) throw new Error("The archive upload did not complete.");

      setLocalStatus("Validating archive");
      await completeImport.mutateAsync({ appId, importJobId: ticket.job.id });
      await refresh(appId);
      setLocalStatus("");
    } catch (nextError) {
      setLocalStatus("");
      setError(errorMessage(nextError));
      await refresh(appId);
    }
  };

  const pickArchive = async (retryJob?: VenomImportJob) => {
    if (!selectedAppId) return;
    const result = await DocumentPicker.getDocumentAsync({ type: ["application/zip", "application/x-zip-compressed"], copyToCacheDirectory: true, multiple: false });
    if (!result.canceled) await uploadAsset(selectedAppId, result.assets[0], retryJob);
  };

  const retryFailedJob = async (job: VenomImportJob) => {
    if (!lastAssetRef.current) {
      setError("Choose the same ZIP again to retry this import.");
      await pickArchive(job);
      return;
    }
    await uploadAsset(selectedAppId, lastAssetRef.current, job);
  };

  const saveProjectLink = async (linkedProjectId: string | null) => {
    setLinkError("");
    try {
      await updateApp.mutateAsync({ appId: selectedAppId, data: { linkedProjectId } });
      await refresh(selectedAppId);
      setLinkPickerVisible(false);
    } catch (nextError) {
      setLinkError(errorMessage(nextError));
    }
  };

  const openImprove = () => {
    setImproveInstruction("");
    setImproveConstraints("");
    setImproveError("");
    setImproveIdemKey(Crypto.randomUUID().replaceAll("-", "_"));
    setImproveVisible(true);
  };

  const startIteration = async () => {
    if (!improveInstruction.trim()) return;
    setImproveError("");
    try {
      const run = await createIteration.mutateAsync({
        appId: selectedAppId,
        data: {
          instruction: improveInstruction.trim(),
          ...(improveConstraints.trim() ? { constraints: improveConstraints.trim() } : {}),
          idempotencyKey: improveIdemKey,
        },
      });
      setImproveVisible(false);
      await queryClient.invalidateQueries({ queryKey: getListVenomBuildRunsQueryKey() });
      await refresh(selectedAppId);
      onIterationStarted(run.id);
    } catch (nextError) {
      setImproveError(errorMessage(nextError));
    }
  };

  const dismissSignal = async () => {
    try {
      await dismissSuggestion.mutateAsync({ appId: selectedAppId });
      await refresh(selectedAppId);
    } catch (nextError) {
      setError(errorMessage(nextError));
    }
  };

  const iterationContext = iterationContextQuery.data;
  const canStartIteration =
    Boolean(iterationContext?.canIterate) &&
    Boolean(improveInstruction.trim()) &&
    !createIteration.isPending;

  const currentStatus = localStatus || (activeJob ? `${statusLabel(activeJob.status)} · ${activeJob.progress}%` : "");

  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.heading, { marginTop: 0 }]}>
        <View style={styles.headingCopy}>
          <Text style={[styles.title, { color: colors.foreground }]}>App Portfolio</Text>
        </View>
        <TouchableOpacity
          ref={(node: FocusableHandle | null) => {
            createButtonRef.current = node;
          }}
          accessibilityRole="button"
          accessibilityLabel="Create app record"
          onPress={openCreateDialog}
          onFocus={() => setCreateButtonFocused(true)}
          onBlur={() => setCreateButtonFocused(false)}
          style={[
            styles.createButton,
            { backgroundColor: colors.foreground },
            createButtonFocused && {
              borderWidth: 2,
              borderColor: colors.background,
            },
          ]}
        >
          <Feather name="plus" color={colors.background} size={18} />
        </TouchableOpacity>
      </View>

      {appsQuery.isLoading ? (
        <View accessible accessibilityLabel="Loading app portfolio" style={styles.loading}>
          <ActivityIndicator color={colors.foreground} />
        </View>
      ) : appsQuery.isError ? (
        <View style={[styles.empty, { borderColor: colors.border }]}>
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Portfolio unavailable</Text>
          <TouchableOpacity accessibilityRole="button" onPress={() => appsQuery.refetch()}>
            <Text style={[styles.actionText, { color: colors.foreground }]}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : appsQuery.data?.length ? (
        <View style={styles.list}>
          {appsQuery.data.map((app) => {
            const selected = selectedAppId === app.id;
            return (
              <TouchableOpacity
                key={app.id}
                ref={registerAppCard(app.id)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`Open ${app.name}, ${statusLabel(app.status)}, source version ${app.sourceVersion}`}
                onPress={() => setSelectedAppId(app.id)}
                onFocus={() => setFocusedAppCardId(app.id)}
                onBlur={() =>
                  setFocusedAppCardId((current) =>
                    current === app.id ? null : current,
                  )
                }
                style={[
                  styles.appCard,
                  {
                    backgroundColor: selected ? colors.foreground : colors.card,
                    // Focus uses an inverted ring on the selected (filled)
                    // card so the indicator stays visible on either surface.
                    borderColor:
                      focusedAppCardId === app.id
                        ? selected
                          ? colors.background
                          : colors.primary
                        : selected
                          ? colors.foreground
                          : colors.border,
                  },
                ]}
              >
                <View style={styles.cardTop}>
                  <Text numberOfLines={1} style={[styles.appName, { color: selected ? colors.background : colors.foreground }]}>{app.name}</Text>
                  <Text style={[styles.status, { color: selected ? colors.background : colors.mutedForeground }]}>{statusLabel(app.importStatus ?? app.status)}</Text>
                </View>
                <Text numberOfLines={2} style={[styles.purpose, { color: selected ? colors.background : colors.mutedForeground }]}>{app.purpose}</Text>
                <Text style={[styles.meta, { color: selected ? colors.background : colors.mutedForeground }]}>{app.brand} · {app.sourceType} · v{app.sourceVersion}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ) : (
        <View style={[styles.empty, { borderColor: colors.border }]}>
          <Feather name="box" size={28} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No products registered</Text>
          <Text style={[styles.emptyCopy, { color: colors.mutedForeground }]}>Create an app record, then hand off a private ZIP when the source is ready.</Text>
        </View>
      )}

      {selectedAppId ? (
        <View style={[styles.detail, { borderColor: colors.foreground }]}>
          {detailQuery.isLoading || !detail ? (
            <ActivityIndicator color={colors.foreground} />
          ) : (
            <>
              <View style={styles.detailHeader}>
                <View style={styles.detailCopy}>
                  <Text style={[styles.detailTitle, { color: colors.foreground }]}>{detail.app.name}</Text>
                  <Text style={[styles.detailMeta, { color: colors.mutedForeground }]}>{detail.app.brand} · {statusLabel(detail.app.status)}</Text>
                </View>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close app detail" onPress={() => setSelectedAppId("")} hitSlop={12}>
                  <Feather name="x" size={20} color={colors.foreground} />
                </TouchableOpacity>
              </View>

              {detail.app.detectedStack.length > 0 && (
                <View style={styles.stack}>
                  {detail.app.detectedStack.map((item) => (
                    <Text key={item} style={[styles.stackChip, { borderColor: colors.border, color: colors.foreground }]}>{item}</Text>
                  ))}
                </View>
              )}

              {detail.app.improvementSignal && (
                <View
                  accessibilityLiveRegion="polite"
                  accessible
                  accessibilityLabel={`New data since package version ${detail.app.improvementSignal.baselineIterationNumber}. Consider an iteration.`}
                  style={[styles.suggestionPanel, { backgroundColor: colors.foreground }]}
                  testID={`banner-improvement-${detail.app.id}`}
                >
                  <Text style={[styles.versionTitle, { color: colors.background }]}>
                    New data since package v{detail.app.improvementSignal.baselineIterationNumber}
                  </Text>
                  <Text style={[styles.suggestionCopy, { color: colors.background }]}>
                    {detail.app.improvementSignal.summary}
                  </Text>
                  <Text style={[styles.suggestionHint, { color: colors.background }]}>
                    Review first — nothing runs without your approval.
                  </Text>
                  <View style={styles.suggestionActions}>
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel="Review and start an iteration" onPress={openImprove} testID={`button-review-iterate-${detail.app.id}`}>
                      <Text style={[styles.actionText, { color: colors.background }]}>Review & iterate</Text>
                    </TouchableOpacity>
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel="Dismiss suggestion" disabled={dismissSuggestion.isPending} onPress={dismissSignal} hitSlop={10} testID={`button-dismiss-suggestion-${detail.app.id}`}>
                      <Feather name="x" size={16} color={colors.background} />
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {currentStatus && (
                <View accessibilityLiveRegion="polite" accessible accessibilityLabel={`Import status ${currentStatus}`} style={[styles.progressPanel, { backgroundColor: colors.secondary }]}>
                  <ActivityIndicator size="small" color={colors.foreground} />
                  <Text style={[styles.progressText, { color: colors.foreground }]}>{currentStatus}</Text>
                </View>
              )}

              {error && (
                <Text accessibilityLiveRegion="assertive" style={[styles.error, { color: colors.foreground }]}>{error}</Text>
              )}

              <View style={styles.actions}>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={`Improve ${detail.app.name}`}
                  onPress={openImprove}
                  style={[styles.primaryAction, { backgroundColor: colors.foreground }]}
                  testID={`button-improve-app-${detail.app.id}`}
                >
                  <Feather name="zap" size={16} color={colors.background} />
                  <Text style={[styles.primaryActionText, { color: colors.background }]}>Improve</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={`Upload a new ZIP version for ${detail.app.name}`}
                  disabled={Boolean(activeJob) || Boolean(localStatus)}
                  onPress={() => pickArchive()}
                  style={[styles.secondaryAction, { borderColor: colors.border, opacity: activeJob || localStatus ? 0.5 : 1 }]}
                >
                  <Feather name="upload" size={16} color={colors.foreground} />
                  <Text style={[styles.secondaryActionText, { color: colors.foreground }]}>Upload ZIP</Text>
                </TouchableOpacity>
                {detail.app.deploymentUrl && (
                  <TouchableOpacity
                    accessibilityRole="link"
                    accessibilityLabel={`Open deployment for ${detail.app.name}`}
                    onPress={() => Linking.openURL(detail.app.deploymentUrl!)}
                    style={[styles.secondaryAction, { borderColor: colors.border }]}
                  >
                    <Feather name="external-link" size={16} color={colors.foreground} />
                    <Text style={[styles.secondaryActionText, { color: colors.foreground }]}>Launch</Text>
                  </TouchableOpacity>
                )}
              </View>

              <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>KNOWLEDGE CONTEXT</Text>
              <View style={[styles.versionRow, { borderColor: colors.border }]}>
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={[styles.versionTitle, { color: colors.foreground }]} testID={`text-linked-project-${detail.app.id}`}>
                    {detail.app.linkedProjectName ?? detail.app.linkedProjectId ?? "No linked project"}
                  </Text>
                  <Text style={[styles.versionMeta, { color: colors.mutedForeground }]}>
                    {detail.app.linkedProjectId
                      ? "Feeds Brain knowledge and sources into iterations"
                      : "Link a project so new knowledge can drive iterations"}
                  </Text>
                </View>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={detail.app.linkedProjectId ? "Change linked project" : "Link a project"}
                  onPress={() => { setLinkError(""); setLinkPickerVisible(true); }}
                  testID="button-open-link-picker"
                >
                  <Text style={[styles.actionText, { color: colors.foreground }]}>
                    {detail.app.linkedProjectId ? "Change" : "Link"}
                  </Text>
                </TouchableOpacity>
              </View>

              <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>SOURCE HISTORY</Text>
              {detail.versions.length ? (
                detail.versions.map((version) => (
                  <View key={version.id} style={[styles.versionRow, { borderColor: colors.border }]}>
                    <View>
                      <Text style={[styles.versionTitle, { color: colors.foreground }]}>Version {version.versionNumber}</Text>
                      <Text style={[styles.versionMeta, { color: colors.mutedForeground }]}>{version.archiveFilename} · {formatBytes(version.archiveBytes)}</Text>
                    </View>
                    <Text style={[styles.versionStack, { color: colors.mutedForeground }]}>{version.manifest.detectedStack.slice(0, 2).join(" · ") || "Stack pending"}</Text>
                  </View>
                ))
              ) : (
                <Text style={[styles.emptyCopy, { color: colors.mutedForeground }]}>No source package has been accepted yet.</Text>
              )}

              {detail.importJobs.filter((job) => job.status === "failed").slice(0, 1).map((job) => (
                <View key={job.id} style={[styles.failure, { borderColor: colors.border }]}>
                  <Text style={[styles.versionTitle, { color: colors.foreground }]}>Import needs attention</Text>
                  <Text style={[styles.emptyCopy, { color: colors.mutedForeground }]}>{job.failureMessage}</Text>
                  <TouchableOpacity accessibilityRole="button" onPress={() => retryFailedJob(job)}>
                    <Text style={[styles.actionText, { color: colors.foreground }]}>Retry same file</Text>
                  </TouchableOpacity>
                </View>
              ))}

              {detail.timeline.length > 0 && (
                <>
                  <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>EVOLUTION</Text>
                  <View accessibilityRole="list" testID={`timeline-app-${detail.app.id}`}>
                    {(expandedTimelineAppId === detail.app.id
                      ? [
                          ...detail.timeline,
                          ...(olderTimelines[detail.app.id]?.entries ?? []),
                        ]
                      : detail.timeline.slice(0, 12)
                    ).map((entry) => (
                      <View
                        key={entry.id}
                        accessible
                        accessibilityLabel={`${entry.title}, ${entry.status}, by ${entry.actor}`}
                        style={[styles.timelineRow, { borderColor: colors.border }]}
                        testID={`timeline-entry-${entry.id}`}
                      >
                        <Feather
                          name={
                            entry.kind === "source_import"
                              ? "package"
                              : entry.kind === "package_iteration"
                                ? "layers"
                                : entry.kind === "release_rolled_back"
                                  ? "rotate-ccw"
                                  : "upload-cloud"
                          }
                          size={14}
                          color={colors.mutedForeground}
                          style={{ marginTop: 3 }}
                        />
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.versionTitle, { color: colors.foreground }]}>{entry.title}</Text>
                          {entry.detail ? (
                            <Text numberOfLines={2} style={[styles.versionMeta, { color: colors.mutedForeground }]}>{entry.detail}</Text>
                          ) : null}
                          <Text style={[styles.versionMeta, { color: colors.mutedForeground }]}>
                            {entry.actor} · {new Date(entry.occurredAt).toLocaleString()}
                          </Text>
                        </View>
                        <Text style={[styles.versionStack, { color: colors.mutedForeground }]}>{entry.status}</Text>
                      </View>
                    ))}
                  </View>
                  {(detail.timeline.length > 12 || detail.timelineTruncated) && (
                    <TouchableOpacity
                      accessibilityRole="button"
                      testID={`button-timeline-toggle-${detail.app.id}`}
                      onPress={() => handleTimelineToggle(detail.app.id)}
                    >
                      <Text style={[styles.actionText, { color: colors.foreground }]}>
                        {expandedTimelineAppId === detail.app.id
                          ? "Show fewer entries"
                          : `Show history (${detail.timelineTotal ?? detail.timeline.length} entries)`}
                      </Text>
                    </TouchableOpacity>
                  )}
                  {expandedTimelineAppId === detail.app.id &&
                    detail.timelineTruncated &&
                    olderTimelines[detail.app.id]?.nextCursor !== null && (
                      <View>
                        {timelineErrorAppId === detail.app.id ? (
                          <View testID={`timeline-error-${detail.app.id}`}>
                            <Text style={[styles.emptyCopy, { color: colors.mutedForeground }]}>
                              Couldn't load older entries.
                            </Text>
                            <TouchableOpacity
                              accessibilityRole="button"
                              testID={`button-timeline-retry-${detail.app.id}`}
                              onPress={() =>
                                void handleTimelineLoadMore(
                                  detail.app.id,
                                  [
                                    ...detail.timeline,
                                    ...(olderTimelines[detail.app.id]?.entries ?? []),
                                  ],
                                  detail.timeline.length > 0
                                    ? detail.timeline[detail.timeline.length - 1].id
                                    : null,
                                )
                              }
                            >
                              <Text style={[styles.actionText, { color: colors.foreground }]}>
                                Retry
                              </Text>
                            </TouchableOpacity>
                          </View>
                        ) : (
                          <TouchableOpacity
                            accessibilityRole="button"
                            testID={`button-timeline-more-${detail.app.id}`}
                            disabled={timelineLoadingAppId === detail.app.id}
                            onPress={() =>
                              void handleTimelineLoadMore(
                                detail.app.id,
                                [
                                  ...detail.timeline,
                                  ...(olderTimelines[detail.app.id]?.entries ?? []),
                                ],
                                detail.timeline.length > 0
                                  ? detail.timeline[detail.timeline.length - 1].id
                                  : null,
                              )
                            }
                          >
                            <Text style={[styles.actionText, { color: colors.foreground }]}>
                              {timelineLoadingAppId === detail.app.id
                                ? "Loading older entries…"
                                : `Load older entries (${
                                    detail.timeline.length +
                                    (olderTimelines[detail.app.id]?.entries.length ?? 0)
                                  }${detail.timelineTotal ? ` of ${detail.timelineTotal}` : ""} shown)`}
                            </Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    )}
                </>
              )}
            </>
          )}
        </View>
      ) : null}

      <Modal
        transparent
        visible={isCreating}
        // On web an animated dismissal keeps the dialog (and its focus trap)
        // mounted for the length of the fade, which pulls keyboard focus back
        // into the closing dialog. Close immediately there instead; the card
        // below animates its own entrance.
        animationType={Platform.OS === "web" ? "none" : "fade"}
        onDismiss={handleCreateDialogDismiss}
        onRequestClose={cancelCreateDialog}
      >
        <View style={styles.modalBackdrop}>
          <RNAnimated.View
            accessibilityViewIsModal
            style={[
              styles.modalCard,
              { backgroundColor: colors.card },
              {
                opacity: createDialogAppear,
                transform: [
                  {
                    translateY: createDialogAppear.interpolate({
                      inputRange: [0, 1],
                      outputRange: [10, 0],
                    }),
                  },
                ],
              },
            ]}
          >
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>Register product</Text>
            {[
              ["Product name", name, setName, "app-name"],
              ["Purpose", purpose, setPurpose, "app-purpose"],
              ["Brand", brand, setBrand, "app-brand"],
              ["Deployment URL (optional)", deploymentUrl, setDeploymentUrl, "app-deployment-url"],
            ].map(([placeholder, value, onChange, testID]) => (
              <TextInput
                key={testID as string}
                autoFocus={testID === "app-name"}
                accessibilityLabel={placeholder as string}
                value={value as string}
                onChangeText={onChange as (value: string) => void}
                placeholder={placeholder as string}
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize={testID === "app-deployment-url" ? "none" : "sentences"}
                keyboardType={testID === "app-deployment-url" ? "url" : "default"}
                style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background }]}
              />
            ))}
            {error && <Text accessibilityLiveRegion="assertive" style={[styles.error, { color: colors.foreground }]}>{error}</Text>}
            <View style={styles.modalActions}>
              <TouchableOpacity accessibilityRole="button" onPress={cancelCreateDialog}>
                <Text style={[styles.cancel, { color: colors.mutedForeground }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                disabled={!name.trim() || !purpose.trim() || !brand.trim() || isSubmittingCreate}
                accessibilityState={{ disabled: !name.trim() || !purpose.trim() || !brand.trim() || isSubmittingCreate }}
                onPress={handleCreate}
                style={[styles.saveButton, { backgroundColor: colors.foreground, opacity: !name.trim() || !purpose.trim() || !brand.trim() ? 0.45 : 1 }]}
              >
                <Text style={[styles.saveText, { color: colors.background }]}>{isSubmittingCreate ? "Creating…" : "Create"}</Text>
              </TouchableOpacity>
            </View>
          </RNAnimated.View>
        </View>
      </Modal>

      <Modal transparent visible={linkPickerVisible} animationType="fade" onRequestClose={() => setLinkPickerVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View accessibilityViewIsModal style={[styles.modalCard, { backgroundColor: colors.card }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>Knowledge context</Text>
            <Text style={[styles.emptyCopy, { color: colors.mutedForeground, textAlign: "left", marginBottom: 12 }]}>
              Link one of your projects so its Brain knowledge and sources feed this app's iterations.
            </Text>
            {workspaceState.projects.length === 0 ? (
              <Text style={[styles.emptyCopy, { color: colors.mutedForeground, textAlign: "left" }]}>
                No projects in this workspace yet. Create a project first, then link it here.
              </Text>
            ) : (
              workspaceState.projects.map((project) => {
                const checked = detail?.app.linkedProjectId === project.id;
                return (
                  <TouchableOpacity
                    key={project.id}
                    accessibilityRole="radio"
                    accessibilityState={{ checked }}
                    aria-checked={checked}
                    disabled={updateApp.isPending}
                    onPress={() => saveProjectLink(project.id)}
                    style={[styles.versionRow, { borderColor: colors.border }]}
                    testID={`option-link-project-${project.id}`}
                  >
                    <Text style={[styles.versionTitle, { color: colors.foreground }]}>{project.name}</Text>
                    {checked ? <Feather name="check" size={16} color={colors.foreground} /> : null}
                  </TouchableOpacity>
                );
              })
            )}
            {detail?.app.linkedProjectId ? (
              <TouchableOpacity
                accessibilityRole="button"
                disabled={updateApp.isPending}
                onPress={() => saveProjectLink(null)}
                testID="button-unlink-project"
              >
                <Text style={[styles.actionText, { color: colors.foreground }]}>Remove link</Text>
              </TouchableOpacity>
            ) : null}
            {linkError ? (
              <Text accessibilityLiveRegion="assertive" style={[styles.error, { color: colors.destructive }]}>{linkError}</Text>
            ) : null}
            <View style={styles.modalActions}>
              <TouchableOpacity accessibilityRole="button" onPress={() => setLinkPickerVisible(false)}>
                <Text style={[styles.cancel, { color: colors.mutedForeground }]}>{updateApp.isPending ? "Saving…" : "Close"}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal transparent visible={improveVisible} animationType="slide" onRequestClose={() => setImproveVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View accessibilityViewIsModal style={[styles.modalCard, { backgroundColor: colors.card, maxHeight: "90%" }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>Improve {detail?.app.name ?? "this app"}</Text>
            <ScrollView style={{ flexGrow: 0 }} keyboardShouldPersistTaps="handled">
              {iterationContextQuery.isLoading || !iterationContext ? (
                <View accessible accessibilityLabel="Loading iteration context" style={{ paddingVertical: 20 }}>
                  <ActivityIndicator color={colors.foreground} />
                </View>
              ) : (
                <>
                  {iterationContext.baseline ? (
                    <View style={[styles.baselinePanel, { borderColor: iterationContext.baseline.resolvable ? colors.border : colors.destructive }]}>
                      <Text style={[styles.versionTitle, { color: colors.foreground }]}>
                        Baseline · package v{iterationContext.baseline.iterationNumber}
                      </Text>
                      <Text style={[styles.versionMeta, { color: colors.mutedForeground }]}>
                        {iterationContext.baseline.packageTitle}
                        {iterationContext.latestSourceVersion ? ` · source v${iterationContext.latestSourceVersion.versionNumber}` : ""}
                      </Text>
                      {!iterationContext.baseline.resolvable && (
                        <Text accessibilityLiveRegion="polite" style={[styles.error, { color: colors.destructive, marginTop: 8 }]}>
                          The pinned baseline package can no longer be resolved. Iterations are blocked so Venom never silently starts from scratch.
                        </Text>
                      )}
                    </View>
                  ) : (
                    <Text style={[styles.emptyCopy, { color: colors.mutedForeground, textAlign: "left", marginBottom: 12 }]}>
                      This app has no approved package yet. Run a build and approve its package first — iterations always continue from a known baseline.
                    </Text>
                  )}

                  {iterationContext.changes && (
                    <View style={[styles.baselinePanel, { borderColor: colors.border }]}>
                      <Text style={[styles.versionTitle, { color: colors.foreground }]}>
                        What's new since v{iterationContext.baseline?.iterationNumber ?? "?"}
                      </Text>
                      <Text style={[styles.versionMeta, { color: colors.mutedForeground }]}>{iterationContext.changes.summary}</Text>
                    </View>
                  )}

                  {iterationContext.suggestedSops.length > 0 && (
                    <Text style={[styles.versionMeta, { color: colors.mutedForeground, marginBottom: 10 }]}>
                      Applies SOPs: {iterationContext.suggestedSops.map((sop) => `${sop.title} rev ${sop.revisionNumber}`).join(", ")}
                    </Text>
                  )}

                  <TextInput
                    accessibilityLabel="What should improve"
                    value={improveInstruction}
                    onChangeText={setImproveInstruction}
                    editable={Boolean(iterationContext.canIterate)}
                    placeholder="What should improve in the next version?"
                    placeholderTextColor={colors.mutedForeground}
                    multiline
                    maxLength={4000}
                    style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background, minHeight: 88, textAlignVertical: "top" }]}
                    testID="input-iteration-instruction"
                  />
                  <TextInput
                    accessibilityLabel="Constraints, optional"
                    value={improveConstraints}
                    onChangeText={setImproveConstraints}
                    editable={Boolean(iterationContext.canIterate)}
                    placeholder="Constraints (optional)"
                    placeholderTextColor={colors.mutedForeground}
                    multiline
                    maxLength={4000}
                    style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background, minHeight: 56, textAlignVertical: "top" }]}
                    testID="input-iteration-constraints"
                  />
                </>
              )}
            </ScrollView>
            {improveError ? (
              <Text accessibilityLiveRegion="assertive" style={[styles.error, { color: colors.destructive, marginBottom: 8 }]}>{improveError}</Text>
            ) : null}
            <View style={styles.modalActions}>
              <TouchableOpacity accessibilityRole="button" onPress={() => setImproveVisible(false)}>
                <Text style={[styles.cancel, { color: colors.mutedForeground }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                disabled={!canStartIteration}
                accessibilityState={{ disabled: !canStartIteration }}
                onPress={startIteration}
                style={[styles.saveButton, { backgroundColor: colors.foreground, opacity: canStartIteration ? 1 : 0.45 }]}
                testID="button-start-iteration"
              >
                <Text style={[styles.saveText, { color: colors.background }]}>
                  {createIteration.isPending ? "Starting…" : "Start iteration"}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// -----------------------------------------
// BUILD PACKAGES VIEW
// -----------------------------------------
function BuildRunRow({ run, onSelect, selected }: { run: VenomBuildRunSummary, onSelect: () => void, selected: boolean }) {
  const colors = useColors();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`Build ${run.targetName}, type ${run.targetType}, status ${statusLabel(run.status)}`}
      onPress={onSelect}
      style={[styles.appCard, { backgroundColor: selected ? colors.foreground : colors.card, borderColor: selected ? colors.foreground : colors.border }]}
    >
      <View style={styles.cardTop}>
        <Text style={[styles.appName, { color: selected ? colors.background : colors.foreground }]}>{run.targetName}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {["queued", "preparing"].includes(run.status) && <OrganicIndicator color={selected ? colors.background : colors.foreground} />}
          <Text style={[styles.status, { color: selected ? colors.background : colors.mutedForeground, marginLeft: 0 }]}>
            {statusLabel(run.status)}
          </Text>
        </View>
      </View>
      <Text numberOfLines={2} style={[styles.purpose, { color: selected ? colors.background : colors.mutedForeground }]}>
        {run.targetType.replace(/_/g, ' ').toUpperCase()}
      </Text>
    </TouchableOpacity>
  );
}

function BuildPackagesView({
  initialDraftPrompt,
  initialTargetType,
  initialTargetName,
  initialSelectedRunId,
}: {
  initialDraftPrompt?: string;
  initialTargetType?: VenomBuildTargetType;
  initialTargetName?: string;
  initialSelectedRunId?: string;
}) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { state } = useVenom();

  const [selectedRunId, setSelectedRunId] = useState(initialSelectedRunId || "");
  const [isCreating, setIsCreating] = useState(Boolean(initialDraftPrompt));

  const [targetType, setTargetType] = useState<VenomBuildTargetType>(initialTargetType || "app");
  const [targetName, setTargetName] = useState(initialTargetName || "");
  const [requirements, setRequirements] = useState(initialDraftPrompt || "");
  const [constraints, setConstraints] = useState("");
  const [brandDirection, setBrandDirection] = useState("");
  const [selectedAppId, setSelectedAppId] = useState<string>("");
  const [selectedSourceVersionId, setSelectedSourceVersionId] = useState<string>("");
  const [selectedSops, setSelectedSops] = useState<Record<string, boolean>>({});

  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionStatus, setActionStatus] = useState("");

  const [approvalModalVisible, setApprovalModalVisible] = useState(false);
  const [rejectModalVisible, setRejectModalVisible] = useState(false);
  const [cancelModalVisible, setCancelModalVisible] = useState(false);
  const [provisionModalVisible, setProvisionModalVisible] = useState(false);
  const [publishModalVisible, setPublishModalVisible] = useState(false);
  const [rollbackModalVisible, setRollbackModalVisible] = useState(false);
  const [provisionCancelModalVisible, setProvisionCancelModalVisible] = useState(false);

  const [reasonInput, setReasonInput] = useState("");
  const [confirmTargetInput, setConfirmTargetInput] = useState("");
  const [pendingRevisionId, setPendingRevisionId] = useState("");
  const [activeReleaseId, setActiveReleaseId] = useState("");
  const [modalIdempotencyKey, setModalIdempotencyKey] = useState("");

  const runsQuery = useListVenomBuildRuns(undefined, {
    query: { queryKey: getListVenomBuildRunsQueryKey(), refetchInterval: 5000 }
  });

  const detailQuery = useGetVenomBuildRun(selectedRunId, {
    query: {
      queryKey: getGetVenomBuildRunQueryKey(selectedRunId),
      enabled: Boolean(selectedRunId),
      refetchInterval: (query) => query.state.data && ["queued", "preparing"].includes(query.state.data.status) ? 2000 : false
    }
  });

  const provisioningRunsQuery = useListProvisioningRuns(
    { buildRunId: selectedRunId },
    {
      query: {
        queryKey: getListProvisioningRunsQueryKey({ buildRunId: selectedRunId }),
        enabled: Boolean(selectedRunId),
        refetchInterval: 5000
      }
    }
  );

  const activeProvisioningRun = provisioningRunsQuery.data?.[0]; // latest run

  const provisioningRunDetailQuery = useGetProvisioningRun(activeProvisioningRun?.id || "", {
    query: {
      queryKey: getGetProvisioningRunQueryKey(activeProvisioningRun?.id || ""),
      enabled: Boolean(activeProvisioningRun?.id),
      refetchInterval: (query: any) => query.state.data && ["queued", "checking_capability", "creating_project", "handing_off", "building", "testing", "publishing"].includes(query.state.data.status) ? 2000 : false
    }
  });

  const capabilityQuery = useGetProvisioningCapability({
    query: {
      queryKey: getGetProvisioningCapabilityQueryKey(),
      enabled: Boolean(selectedRunId),
      refetchInterval: 10000, // Re-check periodically
    }
  });

  const sopsQuery = useListVenomSops({ lifecycle: "active" });
  const appsQuery = useListVenomApps();
  const selectedAppDetailQuery = useGetVenomApp(selectedAppId, {
    query: { enabled: Boolean(selectedAppId), queryKey: getGetVenomAppQueryKey(selectedAppId) }
  });

  const createRun = useCreateVenomBuildRun();
  const cancelRun = useCancelVenomBuildRun();
  const retryRun = useRetryVenomBuildRun();
  const approveRun = useApproveVenomBuildRun();
  const rejectRun = useRejectVenomBuildRun();

  const provisionBuildRun = useProvisionBuildRun();
  const cancelProvisioningRun = useCancelProvisioningRun();
  const retryProvisioningRun = useRetryProvisioningRun();
  const publishProvisioningCandidate = usePublishProvisioningCandidate();
  const rollbackProvisioningRelease = useRollbackProvisioningRelease();

  const handleCreate = async () => {
    if (!targetName.trim() || !requirements.trim()) return;
    setError("");
    setActionStatus("");
    try {
      const sopRevisionIds = Object.keys(selectedSops).filter(k => selectedSops[k]);
      const created = await createRun.mutateAsync({
        data: {
          targetType,
          targetName: targetName.trim(),
          requirements: requirements.trim(),
          constraints: constraints.trim(),
          brandDirection: brandDirection.trim(),
          appId: selectedAppId || null,
          sourceVersionId: selectedSourceVersionId || null,
          projectId: state.activeProjectId || null,
          sopRevisionIds,
          idempotencyKey: Crypto.randomUUID().replaceAll("-", "_"),
        }
      });
      setIsCreating(false);
      setSelectedRunId(created.id);
      await queryClient.invalidateQueries({ queryKey: getListVenomBuildRunsQueryKey() });
      setTargetName("");
      setRequirements("");
      setConstraints("");
      setBrandDirection("");
      setSelectedAppId("");
      setSelectedSourceVersionId("");
      setSelectedSops({});
      setActionStatus("Build package request created.");
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const handleApprove = async () => {
    if (!pendingRevisionId) return;
    setActionError("");
    try {
      await approveRun.mutateAsync({ buildRunId: selectedRunId, data: { revisionId: pendingRevisionId } });
      setApprovalModalVisible(false);
      await queryClient.invalidateQueries({ queryKey: getGetVenomBuildRunQueryKey(selectedRunId) });
      await queryClient.invalidateQueries({ queryKey: getListVenomBuildRunsQueryKey() });
      setActionStatus("Package approved and ready for a separate provisioning step.");
    } catch(e) { setActionError(errorMessage(e)); }
  };

  const handleReject = async () => {
    if (!reasonInput.trim()) { setActionError("Reason is required."); return; }
    setActionError("");
    try {
      await rejectRun.mutateAsync({ buildRunId: selectedRunId, data: { reason: reasonInput.trim() } });
      setRejectModalVisible(false);
      await queryClient.invalidateQueries({ queryKey: getGetVenomBuildRunQueryKey(selectedRunId) });
      await queryClient.invalidateQueries({ queryKey: getListVenomBuildRunsQueryKey() });
      setActionStatus("Package rejected.");
    } catch(e) { setActionError(errorMessage(e)); }
  };

  const handleCancel = async () => {
    if (!reasonInput.trim()) { setActionError("Reason is required."); return; }
    setActionError("");
    try {
      await cancelRun.mutateAsync({ buildRunId: selectedRunId, data: { reason: reasonInput.trim() } });
      setCancelModalVisible(false);
      await queryClient.invalidateQueries({ queryKey: getGetVenomBuildRunQueryKey(selectedRunId) });
      await queryClient.invalidateQueries({ queryKey: getListVenomBuildRunsQueryKey() });
      setActionStatus("Build run cancelled.");
    } catch(e) { setActionError(errorMessage(e)); }
  };

  const handleRetry = async () => {
    setActionError("");
    try {
      await retryRun.mutateAsync({ buildRunId: selectedRunId });
      await queryClient.invalidateQueries({ queryKey: getGetVenomBuildRunQueryKey(selectedRunId) });
      await queryClient.invalidateQueries({ queryKey: getListVenomBuildRunsQueryKey() });
      setActionStatus("Build run restarted.");
    } catch(e) { setActionError(errorMessage(e)); }
  };

  const handleProvision = async () => {
    if (!currentRun || !approvedRevision || confirmTargetInput !== currentRun.targetName) {
      setActionError("Exact target name must match to proceed.");
      return;
    }
    setActionError("");
    try {
      await provisionBuildRun.mutateAsync({
        buildRunId: selectedRunId,
        data: {
          approvedRevisionId: approvedRevision.id,
          idempotencyKey: modalIdempotencyKey || Crypto.randomUUID().replaceAll("-", "_"),
          targetName: confirmTargetInput,
          requestedIntegrations: approvedRevision.package.integrationNeeds || [],
          deploymentIntent: "create_candidate"
        }
      });
      setProvisionModalVisible(false);
      setConfirmTargetInput("");
      setModalIdempotencyKey("");
      await queryClient.invalidateQueries({ queryKey: getGetVenomBuildRunQueryKey(selectedRunId) });
      await queryClient.invalidateQueries({ queryKey: getListVenomBuildRunsQueryKey() });
      await queryClient.invalidateQueries({ queryKey: getListProvisioningRunsQueryKey({ buildRunId: selectedRunId }) });
      await queryClient.invalidateQueries({ queryKey: getListVenomAppsQueryKey() }); // it might create a new app record
      setActionStatus("Provisioning started.");
    } catch (e) { setActionError(errorMessage(e)); }
  };

  const handleCancelProvisioning = async () => {
    if (!reasonInput.trim()) { setActionError("Reason is required."); return; }
    if (!activeProvisioningRun) return;
    setActionError("");
    try {
      const result = await cancelProvisioningRun.mutateAsync({ provisioningRunId: activeProvisioningRun.id, data: { reason: reasonInput.trim() } });
      setProvisionCancelModalVisible(false);
      setReasonInput("");
      await queryClient.invalidateQueries({ queryKey: getGetProvisioningRunQueryKey(activeProvisioningRun.id) });
      await queryClient.invalidateQueries({ queryKey: getListProvisioningRunsQueryKey({ buildRunId: selectedRunId }) });
      setActionStatus(
        result.status === "cancelled"
          ? "Provisioning cancelled."
          : "Cancellation requested. Venom will keep checking until the active provider step stops.",
      );
    } catch (e) { setActionError(errorMessage(e)); }
  };

  const handleRetryProvisioning = async () => {
    if (!activeProvisioningRun) return;
    setActionError("");
    try {
      await retryProvisioningRun.mutateAsync({ provisioningRunId: activeProvisioningRun.id });
      await queryClient.invalidateQueries({ queryKey: getGetProvisioningRunQueryKey(activeProvisioningRun.id) });
      await queryClient.invalidateQueries({ queryKey: getListProvisioningRunsQueryKey({ buildRunId: selectedRunId }) });
      setActionStatus("Provisioning retried.");
    } catch (e) { setActionError(errorMessage(e)); }
  };

  const handlePublish = async () => {
    if (!activeReleaseId) return;
    const activeRelease = releases.find(r => r.id === activeReleaseId);
    if (!activeRelease) return;
    const targetName = activeRelease.targetName || "";
    if (!targetName) { setActionError("Release target name is unknown."); return; }
    if (confirmTargetInput !== targetName) {
       setActionError("Exact target name must match to publish.");
       return;
    }
    setActionError("");
    try {
      const idempotencyKey = "publishIdempotencyKey" in activeRelease && typeof activeRelease.publishIdempotencyKey === "string"
        ? activeRelease.publishIdempotencyKey
        : modalIdempotencyKey;

      const result = await publishProvisioningCandidate.mutateAsync({
        provisioningRunId: activeRelease.provisioningRunId,
        data: {
          candidateReleaseId: activeReleaseId,
          idempotencyKey,
          confirmTargetName: confirmTargetInput
        }
      });
      if (result.status === "published") {
        setPublishModalVisible(false);
        setConfirmTargetInput("");
        setModalIdempotencyKey("");
        setActionStatus("Publishing completed successfully.");
      } else {
        setActionError(result.failureMessage || "Publishing failed to complete.");
      }
      await queryClient.invalidateQueries({ queryKey: getGetProvisioningRunQueryKey(activeRelease.provisioningRunId) });
      await queryClient.invalidateQueries({ queryKey: getListProvisioningRunsQueryKey({ buildRunId: selectedRunId }) });
      await queryClient.invalidateQueries({ queryKey: getGetVenomAppQueryKey(activeRelease.appId || "") });
    } catch (e) { setActionError(errorMessage(e)); }
  };

  const handleRollback = async () => {
    if (!activeReleaseId) return;
    const activeRelease = releases.find(r => r.id === activeReleaseId);
    if (!activeRelease) return;
    const targetName = activeRelease.targetName || "";
    if (!targetName) { setActionError("Release target name is unknown."); return; }
    if (confirmTargetInput !== targetName) {
       setActionError("Exact target name must match to rollback.");
       return;
    }
    setActionError("");
    try {
      const idempotencyKey = "rollbackIdempotencyKey" in activeRelease && typeof activeRelease.rollbackIdempotencyKey === "string"
        ? activeRelease.rollbackIdempotencyKey
        : modalIdempotencyKey;

      const result = await rollbackProvisioningRelease.mutateAsync({
        releaseId: activeReleaseId,
        data: {
          idempotencyKey,
          confirmTargetName: confirmTargetInput
        }
      });
      if (result.status === "published") {
        setRollbackModalVisible(false);
        setConfirmTargetInput("");
        setModalIdempotencyKey("");
        setActionStatus("Rollback completed successfully.");
      } else {
        setActionError("Rollback failed to reach published status.");
      }
      await queryClient.invalidateQueries({ queryKey: getGetProvisioningRunQueryKey(activeRelease.provisioningRunId) });
      await queryClient.invalidateQueries({ queryKey: getListProvisioningRunsQueryKey({ buildRunId: selectedRunId }) });
      await queryClient.invalidateQueries({ queryKey: getGetVenomAppQueryKey(activeRelease.appId || "") });
    } catch (e) { setActionError(errorMessage(e)); }
  };

  const currentRun = detailQuery.data;
  const currentRevision = currentRun?.revisions?.[0]; // latest for review UI
  const approvedRevision = currentRun?.revisions?.find(r => r.id === currentRun?.approvedRevisionId); // strict find by approvedRevisionId
  const provRunDetail = provisioningRunDetailQuery.data;

  const appQueryForReleases = useGetVenomApp(provRunDetail?.appId || "", {
    query: {
      queryKey: getGetVenomAppQueryKey(provRunDetail?.appId || ""),
      enabled: Boolean(provRunDetail?.appId)
    }
  });
  const releases: ProvisioningCandidateRelease[] = appQueryForReleases.data?.provisioningReleases || provRunDetail?.releases || [];


  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.heading, { marginTop: 0 }]}>
        <View style={styles.headingCopy}>
          <Text style={[styles.title, { color: colors.foreground }]}>Build Packages</Text>
        </View>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Create Build Package"
          onPress={() => setIsCreating(true)}
          style={[styles.createButton, { backgroundColor: colors.foreground }]}
        >
          <Feather name="plus" color={colors.background} size={18} />
        </TouchableOpacity>
      </View>

      {runsQuery.isLoading ? (
        <View style={styles.loading} accessible accessibilityLabel="Loading builds"><ActivityIndicator color={colors.foreground} /></View>
      ) : runsQuery.data?.length ? (
        <View style={styles.list}>
          {runsQuery.data.map((run) => (
            <BuildRunRow key={run.id} run={run} selected={selectedRunId === run.id} onSelect={() => setSelectedRunId(run.id)} />
          ))}
        </View>
      ) : (
        <View style={[styles.empty, { borderColor: colors.border }]}>
          <Feather name="layers" size={28} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No active builds</Text>
          <Text style={[styles.emptyCopy, { color: colors.mutedForeground }]}>Create a build package to start.</Text>
        </View>
      )}

      {selectedRunId && currentRun && (
        <View style={[styles.detail, { borderColor: colors.foreground }]} accessibilityLiveRegion="polite">
           <View style={styles.detailHeader}>
              <View style={styles.detailCopy}>
                <Text style={[styles.detailTitle, { color: colors.foreground }]}>{currentRun.targetName}</Text>
                <Text style={[styles.detailMeta, { color: colors.mutedForeground }]}>{currentRun.targetType.replace(/_/g, ' ')} · {statusLabel(currentRun.status)}</Text>
              </View>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close run details" onPress={() => setSelectedRunId("")} hitSlop={12}>
                <Feather name="x" size={20} color={colors.foreground} />
              </TouchableOpacity>
           </View>
           {actionStatus ? (
             <Text accessibilityLiveRegion="polite" style={[styles.purpose, { color: colors.foreground, marginTop: 12 }]}>
               {actionStatus}
             </Text>
           ) : null}
           {actionError ? (
             <Text accessibilityLiveRegion="assertive" style={[styles.error, { color: colors.destructive }]}>
               {actionError}
             </Text>
           ) : null}

           {["queued", "preparing"].includes(currentRun.status) && (
              <View style={[styles.progressPanel, { backgroundColor: colors.secondary, marginTop: 18 }]} accessibilityLiveRegion="polite">
                <OrganicIndicator color={colors.foreground} />
                <Text style={[styles.progressText, { color: colors.foreground }]}>Working on it... {currentRun.progress}%</Text>
              </View>
           )}

           {provRunDetail && !["failed", "cancelled"].includes(provRunDetail.status) && (
             <View style={[styles.progressPanel, { backgroundColor: colors.secondary, marginTop: 18 }]} accessibilityLiveRegion="polite">
                {["candidate_ready", "published"].includes(provRunDetail.status) ? (
                   <Feather name="check-circle" size={16} color={colors.foreground} />
                ) : (
                   <OrganicIndicator color={colors.foreground} />
                )}
                <Text style={[styles.progressText, { color: colors.foreground }]}>
                  Provisioning: {statusLabel(provRunDetail.status)} {provRunDetail.progress < 100 && `· ${provRunDetail.progress}%`}
                </Text>
             </View>
           )}

           {currentRevision && (
             <View style={{ marginTop: 24, gap: 16 }}>
                <Text style={[styles.sectionLabel, { color: colors.mutedForeground, marginTop: 0 }]}>PACKAGE CONTENTS (REV {currentRevision.revisionNumber})</Text>

                {currentRevision.package.productBrief?.summary && (
                  <View>
                    <Text style={[styles.versionTitle, { color: colors.foreground, marginBottom: 4 }]}>Brief</Text>
                    <Text style={[styles.purpose, { color: colors.foreground }]}>{currentRevision.package.productBrief.summary}</Text>
                  </View>
                )}

                {currentRevision.package.functionalScope?.length > 0 && (
                  <View>
                    <Text style={[styles.versionTitle, { color: colors.foreground, marginBottom: 4 }]}>Scope</Text>
                    {currentRevision.package.functionalScope.map((s, i) => <Text key={i} style={[styles.purpose, { color: colors.foreground }]}>• {s}</Text>)}
                  </View>
                )}

                {currentRevision.package.brandDirection?.length > 0 && (
                  <View>
                    <Text style={[styles.versionTitle, { color: colors.foreground, marginBottom: 4 }]}>Brand</Text>
                    {currentRevision.package.brandDirection.map((s, i) => <Text key={i} style={[styles.purpose, { color: colors.foreground }]}>• {s}</Text>)}
                  </View>
                )}

                 {currentRevision.package.productBrief?.audience?.length > 0 && (
                   <View>
                     <Text style={[styles.versionTitle, { color: colors.foreground, marginBottom: 4 }]}>Audience</Text>
                     {currentRevision.package.productBrief.audience.map((s, i) => <Text key={i} style={[styles.purpose, { color: colors.foreground }]}>• {s}</Text>)}
                   </View>
                 )}

                 {currentRevision.package.productBrief?.outcomes?.length > 0 && (
                   <View>
                     <Text style={[styles.versionTitle, { color: colors.foreground, marginBottom: 4 }]}>Outcomes</Text>
                     {currentRevision.package.productBrief.outcomes.map((s, i) => <Text key={i} style={[styles.purpose, { color: colors.foreground }]}>• {s}</Text>)}
                   </View>
                 )}

                {currentRevision.package.contentRequirements?.length > 0 && (
                  <View>
                    <Text style={[styles.versionTitle, { color: colors.foreground, marginBottom: 4 }]}>Content</Text>
                    {currentRevision.package.contentRequirements.map((s, i) => <Text key={i} style={[styles.purpose, { color: colors.foreground }]}>• {s}</Text>)}
                  </View>
                )}

                {currentRevision.package.serviceFlowRequirements?.length > 0 && (
                  <View>
                    <Text style={[styles.versionTitle, { color: colors.foreground, marginBottom: 4 }]}>Service Flows</Text>
                    {currentRevision.package.serviceFlowRequirements.map((s, i) => <Text key={i} style={[styles.purpose, { color: colors.foreground }]}>• {s}</Text>)}
                  </View>
                )}

                {currentRevision.package.permissionRequests?.length > 0 && (
                  <View>
                    <Text style={[styles.versionTitle, { color: colors.foreground, marginBottom: 4 }]}>Permissions</Text>
                    {currentRevision.package.permissionRequests.map((p, i) => (
                      <Text key={i} style={[styles.purpose, { color: colors.foreground }]}>• {p.capability} ({p.required ? 'Required' : 'Optional'}) - {p.reason}</Text>
                    ))}
                  </View>
                )}

                {currentRevision.package.integrationNeeds?.length > 0 && (
                  <View>
                    <Text style={[styles.versionTitle, { color: colors.foreground, marginBottom: 4 }]}>Integrations</Text>
                    {currentRevision.package.integrationNeeds.map((s, i) => <Text key={i} style={[styles.purpose, { color: colors.foreground }]}>• {s}</Text>)}
                  </View>
                )}

                 {currentRevision.package.dataNeeds?.length > 0 && (
                   <View>
                     <Text style={[styles.versionTitle, { color: colors.foreground, marginBottom: 4 }]}>Data Needs</Text>
                     {currentRevision.package.dataNeeds.map((s, i) => <Text key={i} style={[styles.purpose, { color: colors.foreground }]}>• {s}</Text>)}
                   </View>
                 )}

                {currentRevision.package.acceptanceChecks?.length > 0 && (
                  <View>
                    <Text style={[styles.versionTitle, { color: colors.foreground, marginBottom: 4 }]}>Acceptance Checks</Text>
                    {currentRevision.package.acceptanceChecks.map((s, i) => <Text key={i} style={[styles.purpose, { color: colors.foreground }]}>• {s}</Text>)}
                  </View>
                )}

                 {currentRevision.package.launchConstraints?.length > 0 && (
                   <View>
                     <Text style={[styles.versionTitle, { color: colors.foreground, marginBottom: 4 }]}>Launch Constraints</Text>
                     {currentRevision.package.launchConstraints.map((s, i) => <Text key={i} style={[styles.purpose, { color: colors.foreground }]}>• {s}</Text>)}
                   </View>
                 )}

                {currentRevision.package.sourceReferences?.length > 0 && (
                  <View>
                    <Text style={[styles.versionTitle, { color: colors.foreground, marginBottom: 4 }]}>Sources</Text>
                    {currentRevision.package.sourceReferences.map((s, i) => <Text key={i} style={[styles.purpose, { color: colors.foreground }]}>• {s.appName} (v{s.versionNumber})</Text>)}
                  </View>
                )}

                {currentRevision.package.sopReferences?.length > 0 && (
                  <View>
                    <Text style={[styles.versionTitle, { color: colors.foreground, marginBottom: 4 }]}>SOPs</Text>
                    {currentRevision.package.sopReferences.map((s, i) => <Text key={i} style={[styles.purpose, { color: colors.foreground }]}>• {s.title} (v{s.revisionNumber})</Text>)}
                  </View>
                )}
             </View>
           )}

           {currentRun.events && currentRun.events.length > 0 && (
             <View style={{ marginTop: 24 }}>
                <Text style={[styles.sectionLabel, { color: colors.mutedForeground, marginTop: 0 }]}>HISTORY</Text>
                {currentRun.events.slice().reverse().slice(0, 5).map(ev => (
                  <View key={ev.id} style={{ marginBottom: 6 }}>
                    <Text style={[styles.versionMeta, { color: colors.foreground, marginTop: 0 }]}>
                      {ev.eventType} - {ev.message}
                    </Text>
                  </View>
                ))}
             </View>
           )}

           {currentRun.status === "review_required" && currentRevision && !provRunDetail && (
             <View style={{ marginTop: 24 }}>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Approve this build package revision"
                    onPress={() => { setPendingRevisionId(currentRevision.id); setApprovalModalVisible(true); }}
                    style={[styles.primaryAction, { backgroundColor: colors.foreground }]}
                  >
                    <Feather name="check" size={16} color={colors.background} />
                    <Text style={[styles.primaryActionText, { color: colors.background }]}>Approve Package</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Reject this build package"
                    onPress={() => { setReasonInput(""); setActionError(""); setRejectModalVisible(true); }}
                    style={[styles.secondaryAction, { borderColor: colors.border }]}
                  >
                    <Feather name="x" size={16} color={colors.foreground} />
                    <Text style={[styles.secondaryActionText, { color: colors.foreground }]}>Reject</Text>
                  </TouchableOpacity>
                </View>
             </View>
           )}

           {currentRun.status === "ready_for_provisioning" && approvedRevision && (!provRunDetail || ["failed", "cancelled", "blocked"].includes(provRunDetail.status)) && capabilityQuery.data && (
             <View style={{ marginTop: 24 }}>
                <Text style={[styles.sectionLabel, { color: colors.mutedForeground, marginTop: 0 }]}>PROVISIONING CAPABILITY</Text>
                <View style={[styles.versionRow, { borderColor: colors.border, padding: 12 }]}>
                   <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                     <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: capabilityQuery.data.health === 'healthy' ? colors.foreground : capabilityQuery.data.health === 'degraded' ? colors.mutedForeground : colors.destructive }} />
                     <Text style={[styles.versionTitle, { color: colors.foreground }]}>
                       {capabilityQuery.data.health.toUpperCase()}
                     </Text>
                   </View>
                   <Text style={[styles.purpose, { color: colors.foreground }]}>{capabilityQuery.data.summary}</Text>
                   {capabilityQuery.data.recoveryGuidance && (
                     <Text style={[styles.purpose, { color: colors.mutedForeground, marginTop: 4 }]}>{capabilityQuery.data.recoveryGuidance}</Text>
                   )}
                </View>

                {["healthy", "degraded"].includes(capabilityQuery.data.health) && capabilityQuery.data.supportedTargetTypes?.includes(currentRun.targetType as any) && (
                  <View style={{ marginTop: 12 }}>
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel="Provision Candidate"
                      onPress={() => { setConfirmTargetInput(""); setActionError(""); setModalIdempotencyKey(Crypto.randomUUID().replaceAll("-", "_")); setProvisionModalVisible(true); }}
                      style={[styles.primaryAction, { backgroundColor: colors.foreground }]}
                    >
                      <Feather name="server" size={16} color={colors.background} />
                      <Text style={[styles.primaryActionText, { color: colors.background }]}>Provision Candidate</Text>
                    </TouchableOpacity>
                  </View>
                )}
             </View>
           )}

           {provRunDetail && (
             <View style={{ marginTop: 24 }}>
                <Text style={[styles.sectionLabel, { color: colors.mutedForeground, marginTop: 0 }]}>PROVISIONING RUN</Text>

                                {provRunDetail.status === "blocked" && (
                   <View style={{ marginBottom: 12 }}>
                      <Text style={[styles.error, { color: colors.destructive }]} accessibilityLiveRegion="assertive">
                        Blocked: {provRunDetail.blockedReason}
                      </Text>
                      <TouchableOpacity accessibilityRole="button" onPress={handleRetryProvisioning} style={[styles.secondaryAction, { borderColor: colors.border, marginTop: 10 }]}>
                         <Feather name="refresh-cw" size={16} color={colors.foreground} />
                         <Text style={[styles.secondaryActionText, { color: colors.foreground }]}>Retry Provisioning</Text>
                      </TouchableOpacity>
                   </View>
                )}

                {provRunDetail.status === "failed" && (
                   <View style={{ marginBottom: 12 }}>
                      <Text style={[styles.error, { color: colors.destructive }]} accessibilityLiveRegion="assertive">
                        {provRunDetail.failureMessage || "Provisioning failed"}
                      </Text>
                      <TouchableOpacity accessibilityRole="button" onPress={handleRetryProvisioning} style={[styles.secondaryAction, { borderColor: colors.border, marginTop: 10 }]}>
                         <Feather name="refresh-cw" size={16} color={colors.foreground} />
                         <Text style={[styles.secondaryActionText, { color: colors.foreground }]}>Retry Provisioning</Text>
                      </TouchableOpacity>
                   </View>
                )}

                {provRunDetail.status === "cancelled" && (
                   <View style={{ marginBottom: 12 }}>
                      <Text style={[styles.error, { color: colors.mutedForeground }]}>Cancelled</Text>
                      <TouchableOpacity accessibilityRole="button" onPress={handleRetryProvisioning} style={[styles.secondaryAction, { borderColor: colors.border, marginTop: 10 }]}>
                         <Feather name="refresh-cw" size={16} color={colors.foreground} />
                         <Text style={[styles.secondaryActionText, { color: colors.foreground }]}>Restart Provisioning</Text>
                      </TouchableOpacity>
                   </View>
                )}

                {["queued", "checking_capability", "creating_project", "handing_off", "building", "testing"].includes(provRunDetail.status) && (
                   <TouchableOpacity
                     accessibilityRole="button"
                     onPress={() => { setReasonInput(""); setActionError(""); setProvisionCancelModalVisible(true); }}
                     style={{ paddingVertical: 8, marginBottom: 12 }}
                   >
                      <Text style={[styles.actionText, { color: colors.mutedForeground, textDecorationLine: 'none', textAlign: 'center' }]}>Cancel Provisioning</Text>
                   </TouchableOpacity>
                )}

                {releases && releases.length > 0 && (
                   <View style={{ gap: 12, marginTop: 8 }}>
                     {releases.map(release => {
                         const releaseTargetName = release.targetName || "";
                         let statusDisplay = release.status as string;
                         if (release.status === "candidate") statusDisplay = "Candidate Preview";
                         if (release.status === "published") statusDisplay = "Live App";
                         if (release.status === "superseded") statusDisplay = "Previous Release";

                         return (
                       <View key={release.id} style={[styles.versionRow, { borderColor: colors.border }]}>
                         <View style={{ flex: 1 }}>
                            <Text style={[styles.versionTitle, { color: colors.foreground }]}>Release {release.providerReleaseId || release.providerCandidateId}</Text>
                            <Text style={[styles.versionMeta, { color: colors.mutedForeground }]}>Target: {releaseTargetName} · Revision: {release.approvedRevisionId.slice(0, 8)}</Text>
                            <Text style={[styles.versionMeta, { color: colors.foreground }]}>Status: {statusDisplay}</Text>
                         </View>
                         <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' }}>
                            {release.launchUrl && (
                              <TouchableOpacity accessibilityRole="link" onPress={() => Linking.openURL(release.launchUrl!)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                 <Feather name="external-link" size={14} color={colors.foreground} />
                                 <Text style={{ color: colors.foreground, fontSize: 12 }}>Launch</Text>
                              </TouchableOpacity>
                            )}
                            {release.status === "candidate" && capabilityQuery.data?.publishSupported && release.targetName && (
                              <TouchableOpacity accessibilityRole="button" onPress={() => { setActiveReleaseId(release.id); setConfirmTargetInput(""); setActionError(""); setModalIdempotencyKey(Crypto.randomUUID().replaceAll("-", "_")); setPublishModalVisible(true); }} style={{ padding: 6, backgroundColor: colors.foreground, borderRadius: 4 }}>
                                 <Text style={{ color: colors.background, fontSize: 11, fontFamily: "Inter_600SemiBold" }}>Publish</Text>
                              </TouchableOpacity>
                            )}
                            {release.status === "superseded" && capabilityQuery.data?.rollbackSupported && release.targetName && (
                              <TouchableOpacity accessibilityRole="button" onPress={() => { setActiveReleaseId(release.id); setConfirmTargetInput(""); setActionError(""); setModalIdempotencyKey(Crypto.randomUUID().replaceAll("-", "_")); setRollbackModalVisible(true); }} style={{ padding: 6, backgroundColor: colors.secondary, borderRadius: 4 }}>
                                 <Text style={{ color: colors.foreground, fontSize: 11, fontFamily: "Inter_600SemiBold" }}>Rollback</Text>
                              </TouchableOpacity>
                            )}
                         </View>
                       </View>
                     );})}
                   </View>
                )}

                {provRunDetail.events && provRunDetail.events.length > 0 && (
                  <View style={{ marginTop: 16 }}>
                    <Text style={[styles.sectionLabel, { color: colors.mutedForeground, marginTop: 0, fontSize: 10 }]}>PROVISIONING EVENTS</Text>
                    {provRunDetail.events.slice().reverse().slice(0, 5).map((ev: any) => (
                      <View key={ev.id} style={{ marginBottom: 6 }}>
                        <Text style={[styles.versionMeta, { color: colors.foreground, marginTop: 0 }]}>
                          {ev.eventType} - {ev.message}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
             </View>
           )}

           {currentRun.status === "failed" && (
             <View style={{ marginTop: 20 }}>
                <Text style={[styles.error, { color: colors.destructive }]} accessibilityLiveRegion="assertive">
                  {currentRun.failureMessage || "Build failed"}
                </Text>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Retry failed build"
                  onPress={handleRetry}
                  style={[styles.secondaryAction, { borderColor: colors.border, marginTop: 10 }]}
                >
                   <Feather name="refresh-cw" size={16} color={colors.foreground} />
                   <Text style={[styles.secondaryActionText, { color: colors.foreground }]}>Retry Build</Text>
                </TouchableOpacity>
             </View>
           )}

           {currentRun.status === "cancelled" && (
             <View style={{ marginTop: 20 }}>
                <Text style={[styles.error, { color: colors.mutedForeground }]}>Cancelled: {currentRun.cancelledReason}</Text>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Retry cancelled build"
                  onPress={handleRetry}
                  style={[styles.secondaryAction, { borderColor: colors.border, marginTop: 10 }]}
                >
                   <Feather name="refresh-cw" size={16} color={colors.foreground} />
                   <Text style={[styles.secondaryActionText, { color: colors.foreground }]}>Restart Build</Text>
                </TouchableOpacity>
             </View>
           )}

           {["queued", "preparing"].includes(currentRun.status) && (
             <TouchableOpacity
               accessibilityRole="button"
               accessibilityLabel="Cancel this build run"
               onPress={() => { setReasonInput(""); setActionError(""); setCancelModalVisible(true); }}
               style={{ marginTop: 24, paddingVertical: 8 }}
             >
                <Text style={[styles.actionText, { color: colors.mutedForeground, textDecorationLine: 'none', textAlign: 'center' }]}>Cancel Build</Text>
             </TouchableOpacity>
           )}
        </View>
      )}

      {/* CREATE MODAL */}
      <Modal transparent visible={isCreating} animationType="slide">
        <View style={styles.modalBackdrop}>
          <View accessibilityViewIsModal style={[styles.modalCard, { backgroundColor: colors.card, maxHeight: '90%' }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>New Build Package</Text>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40, gap: 12 }}>

              <View>
                <Text style={[styles.versionTitle, { color: colors.foreground, marginBottom: 8 }]}>Target Type</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {(["app", "website", "brand", "customer_service_flow"] as VenomBuildTargetType[]).map(type => (
                    <TouchableOpacity
                      key={type}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: targetType === type }}
                      aria-checked={targetType === type}
                      onPress={() => setTargetType(type)}
                      style={[styles.stackChip, {
                        borderColor: targetType === type ? colors.foreground : colors.border,
                        backgroundColor: targetType === type ? colors.foreground : 'transparent',
                      }]}
                    >
                      <Text style={{
                        fontFamily: "Inter_500Medium", fontSize: 11,
                        color: targetType === type ? colors.background : colors.foreground
                      }}>
                        {type.replace(/_/g, ' ').toUpperCase()}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              <TextInput
                accessibilityLabel="Target Name"
                 maxLength={120}
                placeholder="Target Name (e.g. Acme Web)"
                placeholderTextColor={colors.mutedForeground}
                value={targetName}
                onChangeText={setTargetName}
                style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background, marginBottom: 0 }]}
              />

              <TextInput
                accessibilityLabel="Requirements"
                 maxLength={8000}
                placeholder="Requirements (What to build)"
                placeholderTextColor={colors.mutedForeground}
                value={requirements}
                onChangeText={setRequirements}
                multiline
                style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background, minHeight: 80, textAlignVertical: 'top', marginBottom: 0 }]}
              />

              <TextInput
                accessibilityLabel="Constraints"
                 maxLength={4000}
                placeholder="Constraints (Optional)"
                placeholderTextColor={colors.mutedForeground}
                value={constraints}
                onChangeText={setConstraints}
                multiline
                style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background, minHeight: 60, textAlignVertical: 'top', marginBottom: 0 }]}
              />

              <TextInput
                accessibilityLabel="Brand Direction"
                 maxLength={3000}
                placeholder="Brand Direction (Optional)"
                placeholderTextColor={colors.mutedForeground}
                value={brandDirection}
                onChangeText={setBrandDirection}
                multiline
                style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background, minHeight: 60, textAlignVertical: 'top', marginBottom: 0 }]}
              />

              {appsQuery.data && appsQuery.data.length > 0 && (
                <View>
                  <Text style={[styles.versionTitle, { color: colors.foreground, marginBottom: 8, marginTop: 4 }]}>Source App (Optional)</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                    <TouchableOpacity
                       accessibilityRole="radio"
                       accessibilityState={{ checked: selectedAppId === "" }}
                       aria-checked={selectedAppId === ""}
                       onPress={() => { setSelectedAppId(""); setSelectedSourceVersionId(""); }}
                       style={[styles.stackChip, { borderColor: selectedAppId === "" ? colors.foreground : colors.border, backgroundColor: selectedAppId === "" ? colors.foreground : 'transparent' }]}
                    >
                      <Text style={{ color: selectedAppId === "" ? colors.background : colors.foreground, fontSize: 11 }}>None</Text>
                    </TouchableOpacity>
                    {appsQuery.data.map(app => (
                      <TouchableOpacity
                        key={app.id}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: selectedAppId === app.id }}
                        aria-checked={selectedAppId === app.id}
                        onPress={() => { setSelectedAppId(app.id); setSelectedSourceVersionId(""); }}
                        style={[styles.stackChip, { borderColor: selectedAppId === app.id ? colors.foreground : colors.border, backgroundColor: selectedAppId === app.id ? colors.foreground : 'transparent' }]}
                      >
                        <Text style={{ color: selectedAppId === app.id ? colors.background : colors.foreground, fontSize: 11 }}>{app.name}</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>
              )}

              {selectedAppId && selectedAppDetailQuery.data?.versions?.length ? (
                <View>
                  <Text style={[styles.versionTitle, { color: colors.foreground, marginBottom: 8, marginTop: 4 }]}>Source Version (Required if App selected)</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                    {selectedAppDetailQuery.data.versions.map(v => (
                      <TouchableOpacity
                        key={v.id}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: selectedSourceVersionId === v.id }}
                        aria-checked={selectedSourceVersionId === v.id}
                        onPress={() => setSelectedSourceVersionId(v.id)}
                        style={[styles.stackChip, { borderColor: selectedSourceVersionId === v.id ? colors.foreground : colors.border, backgroundColor: selectedSourceVersionId === v.id ? colors.foreground : 'transparent' }]}
                      >
                        <Text style={{ color: selectedSourceVersionId === v.id ? colors.background : colors.foreground, fontSize: 11 }}>v{v.versionNumber}</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>
              ) : selectedAppId && selectedAppDetailQuery.data && selectedAppDetailQuery.data.versions.length === 0 ? (
                <Text style={{ color: colors.destructive, fontSize: 12 }}>This app has no uploaded source versions.</Text>
              ) : null}

              {sopsQuery.data && sopsQuery.data.length > 0 && (
                <View>
                  <Text style={[styles.versionTitle, { color: colors.foreground, marginBottom: 8, marginTop: 4 }]}>SOPs (Optional)</Text>
                  <View style={{ flexWrap: 'wrap', flexDirection: 'row', gap: 8 }}>
                    {sopsQuery.data.map(sop => {
                      if (!sop.activeRevisionId) return null;
                      const active = !!selectedSops[sop.activeRevisionId];
                      return (
                        <TouchableOpacity
                          key={sop.id}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: active }}
                          aria-checked={active}
                          onPress={() => setSelectedSops(prev => ({ ...prev, [sop.activeRevisionId as string]: !active }))}
                          style={[styles.stackChip, { borderColor: active ? colors.foreground : colors.border, backgroundColor: active ? colors.foreground : 'transparent' }]}
                        >
                          <Text style={{ color: active ? colors.background : colors.foreground, fontSize: 11 }}>{sop.title}</Text>
                        </TouchableOpacity>
                      )
                    })}
                  </View>
                </View>
              )}

              {error ? <Text accessibilityLiveRegion="assertive" style={[styles.error, { color: colors.foreground, marginTop: 0 }]}>{error}</Text> : null}

              <View style={[styles.modalActions, { marginTop: 12 }]}>
                <TouchableOpacity accessibilityRole="button" onPress={() => setIsCreating(false)}>
                  <Text style={[styles.cancel, { color: colors.mutedForeground }]}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="button"
                  disabled={!targetName.trim() || !requirements.trim() || (selectedAppId !== "" && !selectedSourceVersionId) || createRun.isPending}
                  accessibilityState={{ disabled: !targetName.trim() || !requirements.trim() || (selectedAppId !== "" && !selectedSourceVersionId) || createRun.isPending }}
                  onPress={handleCreate}
                  style={[styles.saveButton, { backgroundColor: colors.foreground, opacity: !targetName.trim() || !requirements.trim() || (selectedAppId !== "" && !selectedSourceVersionId) ? 0.45 : 1 }]}
                >
                  <Text style={[styles.saveText, { color: colors.background }]}>{createRun.isPending ? "Creating..." : "Create"}</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* APPROVAL MODAL */}
      <Modal transparent visible={approvalModalVisible} animationType="fade">
        <View style={styles.modalBackdrop}>
          <View accessibilityViewIsModal style={[styles.modalCard, { backgroundColor: colors.card }]} accessibilityRole="alert" accessibilityLiveRegion="assertive">
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>Approve Revision {currentRevision?.revisionNumber}</Text>
            <Text style={[styles.purpose, { color: colors.foreground, marginBottom: 20 }]}>
              Are you sure you want to approve this package revision? This will only make the package ready for a separate provisioning step. It does not execute, publish, or deploy anything.
            </Text>
            {actionError ? <Text accessibilityLiveRegion="assertive" style={[styles.error, { color: colors.destructive, marginBottom: 12 }]}>{actionError}</Text> : null}
            <View style={styles.modalActions}>
              <TouchableOpacity accessibilityRole="button" onPress={() => setApprovalModalVisible(false)}>
                <Text style={[styles.cancel, { color: colors.mutedForeground }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" disabled={approveRun.isPending} accessibilityState={{ disabled: approveRun.isPending }} onPress={handleApprove} style={[styles.saveButton, { backgroundColor: colors.foreground }]}>
                <Text style={[styles.saveText, { color: colors.background }]}>{approveRun.isPending ? "Approving..." : "Approve Package"}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* REJECT MODAL */}
      <Modal transparent visible={rejectModalVisible} animationType="fade">
        <View style={styles.modalBackdrop}>
          <View accessibilityViewIsModal style={[styles.modalCard, { backgroundColor: colors.card }]} accessibilityRole="alert">
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>Reject Package</Text>
            <Text style={[styles.purpose, { color: colors.foreground, marginBottom: 12 }]}>Provide a reason for rejection.</Text>
            <TextInput
              accessibilityLabel="Rejection Reason"
              placeholder="Reason..."
              placeholderTextColor={colors.mutedForeground}
              value={reasonInput}
              onChangeText={setReasonInput}
              style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background }]}
            />
            {actionError ? <Text accessibilityLiveRegion="assertive" style={[styles.error, { color: colors.destructive, marginBottom: 12 }]}>{actionError}</Text> : null}
            <View style={styles.modalActions}>
              <TouchableOpacity accessibilityRole="button" onPress={() => setRejectModalVisible(false)}>
                <Text style={[styles.cancel, { color: colors.mutedForeground }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" disabled={!reasonInput.trim() || rejectRun.isPending} accessibilityState={{ disabled: !reasonInput.trim() || rejectRun.isPending }} onPress={handleReject} style={[styles.saveButton, { backgroundColor: colors.foreground, opacity: !reasonInput.trim() ? 0.5 : 1 }]}>
                <Text style={[styles.saveText, { color: colors.background }]}>{rejectRun.isPending ? "Rejecting..." : "Reject"}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* CANCEL MODAL */}
      <Modal transparent visible={cancelModalVisible} animationType="fade">
        <View style={styles.modalBackdrop}>
          <View accessibilityViewIsModal style={[styles.modalCard, { backgroundColor: colors.card }]} accessibilityRole="alert">
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>Cancel Build</Text>
            <Text style={[styles.purpose, { color: colors.foreground, marginBottom: 12 }]}>Provide a reason for cancellation.</Text>
            <TextInput
              accessibilityLabel="Cancellation Reason"
              placeholder="Reason..."
              placeholderTextColor={colors.mutedForeground}
              value={reasonInput}
              onChangeText={setReasonInput}
              style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background }]}
            />
            {actionError ? <Text accessibilityLiveRegion="assertive" style={[styles.error, { color: colors.destructive, marginBottom: 12 }]}>{actionError}</Text> : null}
            <View style={styles.modalActions}>
              <TouchableOpacity accessibilityRole="button" onPress={() => setCancelModalVisible(false)}>
                <Text style={[styles.cancel, { color: colors.mutedForeground }]}>Back</Text>
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" disabled={!reasonInput.trim() || cancelRun.isPending} accessibilityState={{ disabled: !reasonInput.trim() || cancelRun.isPending }} onPress={handleCancel} style={[styles.saveButton, { backgroundColor: colors.foreground, opacity: !reasonInput.trim() ? 0.5 : 1 }]}>
                <Text style={[styles.saveText, { color: colors.background }]}>{cancelRun.isPending ? "Cancelling..." : "Confirm Cancel"}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* PROVISIONING CONFIRM MODAL */}
      <Modal transparent visible={provisionModalVisible} animationType="fade">
        <View style={styles.modalBackdrop}>
          <ScrollView contentContainerStyle={{ padding: 20, flexGrow: 1, justifyContent: 'center' }}>
            <View accessibilityViewIsModal style={[styles.modalCard, { backgroundColor: colors.card, width: '100%' }]} accessibilityRole="alert" accessibilityLiveRegion="assertive">
              <Text style={[styles.modalTitle, { color: colors.foreground }]}>Confirm Provisioning</Text>

              <Text style={[styles.purpose, { color: colors.foreground, marginBottom: 16 }]}>
                This will create and link an isolated Replit project, transfer the approved immutable package and source code, and build a candidate. It will not publish.
              </Text>

              {currentRevision && (
                <View style={{ marginBottom: 16, gap: 8 }}>
                  <Text style={[styles.versionMeta, { color: colors.foreground }]}>Target: {currentRun?.targetName}</Text>
                  <Text style={[styles.versionMeta, { color: colors.foreground }]}>Revision: {currentRevision.id.slice(0, 8)} (v{currentRevision.revisionNumber})</Text>
                  {currentRevision.package.sourceReferences?.map(s => (
                    <Text key={s.appId} style={[styles.versionMeta, { color: colors.mutedForeground }]}>
                      Source: {s.appName} (v{s.versionNumber}) - {s.checksumSha256.slice(0, 8)}
                    </Text>
                  ))}
                  {currentRevision.package.integrationNeeds?.length > 0 && (
                    <Text style={[styles.versionMeta, { color: colors.mutedForeground }]}>
                      Integrations: {currentRevision.package.integrationNeeds.join(", ")}
                    </Text>
                  )}
                  {currentRevision.package.permissionRequests?.length > 0 && (
                    <Text style={[styles.versionMeta, { color: colors.mutedForeground }]}>
                      Permissions: {currentRevision.package.permissionRequests.map(p => p.capability).join(", ")}
                    </Text>
                  )}
                </View>
              )}

              <Text style={[styles.purpose, { color: colors.foreground, marginBottom: 8, fontFamily: "Inter_600SemiBold" }]}>
                Type "{currentRun?.targetName}" to confirm:
              </Text>

              <TextInput
                accessibilityLabel="Confirm Target Name"
                placeholder={currentRun?.targetName || ""}
                placeholderTextColor={colors.mutedForeground}
                value={confirmTargetInput}
                onChangeText={setConfirmTargetInput}
                style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background }]}
              />

              {actionError ? <Text accessibilityLiveRegion="assertive" style={[styles.error, { color: colors.destructive, marginBottom: 12 }]}>{actionError}</Text> : null}

              <View style={styles.modalActions}>
                <TouchableOpacity accessibilityRole="button" onPress={() => setProvisionModalVisible(false)}>
                  <Text style={[styles.cancel, { color: colors.mutedForeground }]}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                   accessibilityRole="button"
                   disabled={confirmTargetInput !== currentRun?.targetName || provisionBuildRun.isPending}
                   accessibilityState={{ disabled: confirmTargetInput !== currentRun?.targetName || provisionBuildRun.isPending }}
                   onPress={handleProvision}
                   style={[styles.saveButton, { backgroundColor: colors.foreground, opacity: confirmTargetInput !== currentRun?.targetName ? 0.5 : 1 }]}
                >
                  <Text style={[styles.saveText, { color: colors.background }]}>{provisionBuildRun.isPending ? "Provisioning..." : "Provision"}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>

            {/* PUBLISH MODAL */}
      <Modal transparent visible={publishModalVisible} animationType="fade">
        <View style={styles.modalBackdrop}>
          <View accessibilityViewIsModal style={[styles.modalCard, { backgroundColor: colors.card }]} accessibilityRole="alert">
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>Publish Candidate</Text>
            <Text style={[styles.purpose, { color: colors.foreground, marginBottom: 12 }]}>
              This will publish the candidate live. The previous deployment will be preserved on failure.
              Type "{(() => {
                const activeRelease = releases.find(r => r.id === activeReleaseId);
                return activeRelease ? (activeRelease.targetName || "") : "";
              })()}" to confirm.
            </Text>
            <TextInput
              accessibilityLabel="Confirm Target Name to Publish"
              placeholder={(() => {
                const activeRelease = releases.find(r => r.id === activeReleaseId);
                return activeRelease ? (activeRelease.targetName || "") : "";
              })()}
              placeholderTextColor={colors.mutedForeground}
              value={confirmTargetInput}
              onChangeText={setConfirmTargetInput}
              style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background }]}
            />
            {actionError ? <Text accessibilityLiveRegion="assertive" style={[styles.error, { color: colors.destructive, marginBottom: 12 }]}>{actionError}</Text> : null}
            <View style={styles.modalActions}>
              <TouchableOpacity accessibilityRole="button" onPress={() => setPublishModalVisible(false)}>
                <Text style={[styles.cancel, { color: colors.mutedForeground }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" disabled={confirmTargetInput !== (() => {
                const activeRelease = releases.find(r => r.id === activeReleaseId);
                return activeRelease ? (activeRelease.targetName || "") : "";
              })() || publishProvisioningCandidate.isPending} accessibilityState={{ disabled: confirmTargetInput !== (() => {
                const activeRelease = releases.find(r => r.id === activeReleaseId);
                return activeRelease ? (activeRelease.targetName || "") : "";
              })() || publishProvisioningCandidate.isPending }} onPress={handlePublish} style={[styles.saveButton, { backgroundColor: colors.foreground, opacity: confirmTargetInput !== (() => {
                const activeRelease = releases.find(r => r.id === activeReleaseId);
                return activeRelease ? (activeRelease.targetName || "") : "";
              })() ? 0.5 : 1 }]}>
                <Text style={[styles.saveText, { color: colors.background }]}>{publishProvisioningCandidate.isPending ? "Publishing..." : "Publish Live"}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ROLLBACK MODAL */}
      <Modal transparent visible={rollbackModalVisible} animationType="fade">
        <View style={styles.modalBackdrop}>
          <View accessibilityViewIsModal style={[styles.modalCard, { backgroundColor: colors.card }]} accessibilityRole="alert">
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>Rollback Release</Text>
            <Text style={[styles.purpose, { color: colors.foreground, marginBottom: 12 }]}>
              This will roll back the live deployment to a previous state. Type "{(() => {
                const activeRelease = releases.find(r => r.id === activeReleaseId);
                return activeRelease ? (activeRelease.targetName || "") : "";
              })()}" to confirm.
            </Text>
            <TextInput
              accessibilityLabel="Confirm Target Name to Rollback"
              placeholder={(() => {
                const activeRelease = releases.find(r => r.id === activeReleaseId);
                return activeRelease ? (activeRelease.targetName || "") : "";
              })()}
              placeholderTextColor={colors.mutedForeground}
              value={confirmTargetInput}
              onChangeText={setConfirmTargetInput}
              style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background }]}
            />
            {actionError ? <Text accessibilityLiveRegion="assertive" style={[styles.error, { color: colors.destructive, marginBottom: 12 }]}>{actionError}</Text> : null}
            <View style={styles.modalActions}>
              <TouchableOpacity accessibilityRole="button" onPress={() => setRollbackModalVisible(false)}>
                <Text style={[styles.cancel, { color: colors.mutedForeground }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" disabled={confirmTargetInput !== (() => {
                const activeRelease = releases.find(r => r.id === activeReleaseId);
                return activeRelease ? (activeRelease.targetName || "") : "";
              })() || rollbackProvisioningRelease.isPending} accessibilityState={{ disabled: confirmTargetInput !== (() => {
                const activeRelease = releases.find(r => r.id === activeReleaseId);
                return activeRelease ? (activeRelease.targetName || "") : "";
              })() || rollbackProvisioningRelease.isPending }} onPress={handleRollback} style={[styles.saveButton, { backgroundColor: colors.foreground, opacity: confirmTargetInput !== (() => {
                const activeRelease = releases.find(r => r.id === activeReleaseId);
                return activeRelease ? (activeRelease.targetName || "") : "";
              })() ? 0.5 : 1 }]}>
                <Text style={[styles.saveText, { color: colors.background }]}>{rollbackProvisioningRelease.isPending ? "Rolling back..." : "Confirm Rollback"}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* CANCEL PROVISIONING MODAL */}
      <Modal transparent visible={provisionCancelModalVisible} animationType="fade">
        <View style={styles.modalBackdrop}>
          <View accessibilityViewIsModal style={[styles.modalCard, { backgroundColor: colors.card }]} accessibilityRole="alert">
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>Cancel Provisioning</Text>
            <Text style={[styles.purpose, { color: colors.foreground, marginBottom: 12 }]}>Provide a reason for cancellation.</Text>
            <TextInput
              accessibilityLabel="Cancellation Reason"
              placeholder="Reason..."
              placeholderTextColor={colors.mutedForeground}
              value={reasonInput}
              onChangeText={setReasonInput}
              style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background }]}
            />
            {actionError ? <Text accessibilityLiveRegion="assertive" style={[styles.error, { color: colors.destructive, marginBottom: 12 }]}>{actionError}</Text> : null}
            <View style={styles.modalActions}>
              <TouchableOpacity accessibilityRole="button" onPress={() => setProvisionCancelModalVisible(false)}>
                <Text style={[styles.cancel, { color: colors.mutedForeground }]}>Back</Text>
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" disabled={!reasonInput.trim() || cancelProvisioningRun.isPending} accessibilityState={{ disabled: !reasonInput.trim() || cancelProvisioningRun.isPending }} onPress={handleCancelProvisioning} style={[styles.saveButton, { backgroundColor: colors.foreground, opacity: !reasonInput.trim() ? 0.5 : 1 }]}>
                <Text style={[styles.saveText, { color: colors.background }]}>{cancelProvisioningRun.isPending ? "Cancelling..." : "Confirm Cancel"}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  )
}

export default function AppsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    draftPrompt?: string;
    targetType?: string;
    targetName?: string;
  }>();
  const initialTargetType = (
    ["app", "website", "brand", "customer_service_flow"] as VenomBuildTargetType[]
  ).includes(params.targetType as VenomBuildTargetType)
    ? params.targetType as VenomBuildTargetType
    : undefined;
  const [tab, setTab] = useState<"builds" | "portfolio">(params.draftPrompt ? "builds" : "portfolio");
  const [handoffRunId, setHandoffRunId] = useState("");

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Header title="Control Plane" showBack />

      <View style={{ flexDirection: 'row', paddingHorizontal: 20, paddingTop: 10, paddingBottom: 20, gap: 20 }} accessibilityRole="tablist">
         <TouchableOpacity accessibilityRole="tab" accessibilityState={{ selected: tab === "portfolio" }} aria-selected={tab === "portfolio"} onPress={() => setTab("portfolio")} style={{ borderBottomWidth: 2, borderBottomColor: tab === "portfolio" ? colors.foreground : 'transparent', paddingBottom: 8 }}>
            <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 14, color: tab === "portfolio" ? colors.foreground : colors.mutedForeground }}>Portfolio</Text>
         </TouchableOpacity>
         <TouchableOpacity accessibilityRole="tab" accessibilityState={{ selected: tab === "builds" }} aria-selected={tab === "builds"} onPress={() => setTab("builds")} style={{ borderBottomWidth: 2, borderBottomColor: tab === "builds" ? colors.foreground : 'transparent', paddingBottom: 8 }}>
            <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 14, color: tab === "builds" ? colors.foreground : colors.mutedForeground }}>Builds</Text>
         </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40, paddingTop: 0 }]}>
        {tab === "portfolio" ? (
          <PortfolioView
            onIterationStarted={(runId) => {
              setHandoffRunId(runId);
              setTab("builds");
            }}
          />
        ) : (
          <BuildPackagesView
            initialDraftPrompt={params.draftPrompt}
            initialTargetType={initialTargetType}
            initialTargetName={params.targetName}
            initialSelectedRunId={handoffRunId}
          />
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 20 },
  heading: {
    alignItems: "flex-end",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 24,
  },
  headingCopy: { flex: 1, paddingRight: 20 },
  title: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 28,
    letterSpacing: -1,
  },
  createButton: {
    alignItems: "center",
    borderRadius: 18,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  list: { gap: 10 },
  appCard: { borderRadius: 16, borderWidth: 1, padding: 17 },
  cardTop: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 7,
  },
  appName: { flex: 1, fontFamily: "Inter_600SemiBold", fontSize: 17 },
  status: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
    letterSpacing: 0.8,
    marginLeft: 10,
    textTransform: "uppercase",
  },
  purpose: { fontFamily: "Inter_400Regular", fontSize: 13, lineHeight: 19 },
  meta: {
    fontFamily: "Inter_500Medium",
    fontSize: 10,
    letterSpacing: 0.5,
    marginTop: 12,
    textTransform: "uppercase",
  },
  loading: { alignItems: "center", minHeight: 180, justifyContent: "center" },
  empty: {
    alignItems: "center",
    borderRadius: 18,
    borderWidth: 1,
    gap: 10,
    padding: 28,
  },
  emptyTitle: { fontFamily: "Inter_600SemiBold", fontSize: 18 },
  emptyCopy: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },
  detail: { borderTopWidth: 2, marginTop: 28, paddingTop: 22 },
  detailHeader: {
    alignItems: "flex-start",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  detailCopy: { flex: 1, paddingRight: 20 },
  detailTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 26,
    letterSpacing: -0.8,
  },
  detailMeta: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
    marginTop: 5,
    textTransform: "uppercase",
  },
  stack: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 18 },
  stackChip: {
    borderRadius: 20,
    borderWidth: 1,
    overflow: "hidden",
    paddingHorizontal: 10,
    paddingVertical: 6,
    justifyContent: 'center',
    alignItems: 'center'
  },
  progressPanel: {
    alignItems: "center",
    borderRadius: 12,
    flexDirection: "row",
    gap: 10,
    marginTop: 18,
    padding: 13,
  },
  progressText: { fontFamily: "Inter_500Medium", fontSize: 13 },
  error: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 12,
  },
  actions: { flexDirection: "row", gap: 9, marginTop: 18 },
  primaryAction: {
    alignItems: "center",
    borderRadius: 12,
    flex: 1,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    minHeight: 48,
  },
  primaryActionText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  secondaryAction: {
    alignItems: "center",
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 18,
  },
  secondaryActionText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  sectionLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
    letterSpacing: 1.2,
    marginBottom: 10,
    marginTop: 28,
  },
  versionRow: {
    alignItems: "center",
    borderTopWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 14,
  },
  versionTitle: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
  versionMeta: { fontFamily: "Inter_400Regular", fontSize: 11, marginTop: 4 },
  versionStack: {
    fontFamily: "Inter_500Medium",
    fontSize: 10,
    marginLeft: 14,
    maxWidth: "38%",
    textAlign: "right",
  },
  failure: { borderTopWidth: 1, gap: 8, marginTop: 20, paddingTop: 16 },
  suggestionPanel: {
    borderRadius: 14,
    gap: 6,
    marginTop: 18,
    padding: 15,
  },
  suggestionCopy: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 18,
    opacity: 0.78,
  },
  suggestionHint: {
    fontFamily: "Inter_500Medium",
    fontSize: 10,
    letterSpacing: 0.4,
    opacity: 0.55,
    textTransform: "uppercase",
  },
  suggestionActions: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 2,
  },
  timelineRow: {
    borderTopWidth: 1,
    flexDirection: "row",
    gap: 10,
    paddingVertical: 13,
  },
  baselinePanel: {
    borderRadius: 12,
    borderWidth: 1,
    gap: 4,
    marginBottom: 12,
    padding: 13,
  },
  actionText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    marginTop: 4,
    textDecorationLine: "underline",
  },
  modalBackdrop: {
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.72)",
    flex: 1,
    justifyContent: "center",
    padding: 20,
  },
  modalCard: { borderRadius: 20, padding: 20, width: "100%" },
  modalTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 22,
    marginBottom: 18,
  },
  input: {
    borderRadius: 12,
    borderWidth: 1,
    fontFamily: "Inter_400Regular",
    fontSize: 15,
    marginBottom: 11,
    minHeight: 48,
    padding: 13,
  },
  modalActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: 22,
    justifyContent: "flex-end",
    marginTop: 10,
  },
  cancel: { fontFamily: "Inter_500Medium", fontSize: 14 },
  saveButton: { borderRadius: 10, paddingHorizontal: 19, paddingVertical: 12 },
  saveText: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
});
