import React from "react";
import {
  Alert,
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Linking,
  Modal,
  Platform,
  Pressable,
  Animated as RNAnimated,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReducedMotion } from "react-native-reanimated";
import { Feather } from "@expo/vector-icons";
import { useClerk, useUser } from "@clerk/expo";
import { useRouter } from "expo-router";
import {
  exportVenomPersonalMarkdown,
  getVenomMasterContribution,
  updateVenomMasterContribution,
  type VenomMasterContribution,
  useHealthCheck,
  useGetGitHubRepositories,
  useConnectGitHubSource,
  useConnectWebsiteSource,
  useGetVenomIdentity,
  getGetVenomIdentityQueryKey,
  useGetVenomModels,
  useGetVenomVoices,
  useGetVenomBillingContext,
  getGetVenomBillingContextQueryKey,
  useGetVenomUsageSummary,
  getGetVenomUsageSummaryQueryKey,
  useGetVenomBillingSummary,
  getGetVenomBillingSummaryQueryKey,
  createVenomBillingCheckout,
  createVenomBillingPortal,
  useListVenomProjectSops,
  getListVenomProjectSopsQueryKey,
  type VenomBillingSummary,
  type VenomManagedModel,
  type VenomUsageSummary,
} from "@workspace/api-client-react";
import {
  deliverMarkdown,
  markdownExportFileName,
} from "@/lib/downloadMarkdown";

import { useColors } from "@/hooks/useColors";
import { useSharedWorkspace } from "@/context/sharedWorkspace";
import { Header } from "@/components/Header";
import { VoicePresetList } from "@/components/voice/VoicePresetList";
import { useVoiceSample } from "@/hooks/useVoiceSample";
import {
  IS_UI_TEST,
  UI_TEST_USER_ID,
  useVenom,
  type ProjectSource,
  type VenomModelId,
  type VenomModelSelectionPolicy,
  type VenomVoicePresetId,
} from "@/context/VenomContext";
import {
  DEFAULT_VOICE_PRESET_ID,
  DEFAULT_VOICE_TALKATIVENESS,
} from "@/context/workspaceSync";
import { TalkativenessControl } from "@/components/voice/TalkativenessControl";
import {
  describeLastSync,
  describeSourceSchedule,
  sourceRefreshRequest,
  sourceScheduleCadence,
  SOURCE_SCHEDULE_CADENCES,
  SOURCE_SCHEDULE_CADENCE_LABELS,
  type SourceScheduleCadence,
} from "@/context/sourceState";

// The API client prefixes every failure with its HTTP status line. People need
// the server's own sentence — "your account is not authorized", "this website
// is too large" — not the protocol detail sitting in front of it.
const HTTP_STATUS_PREFIX = /^HTTP \d{3}[^:]*:\s*/;

function describeSourceFailure(error: unknown, fallback: string): string {
  const message =
    error instanceof Error
      ? error.message.replace(HTTP_STATUS_PREFIX, "").trim()
      : "";
  return message === "" || message.startsWith("HTTP ") ? fallback : message;
}

const USAGE_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const AnimatedPressable = RNAnimated.createAnimatedComponent(Pressable);

/**
 * The account-level model selection policy choices. Manual keeps today's
 * explicit picks; the auto modes hand the choice to the server on every
 * request, which is why their copy says who is choosing and why.
 */
const MODEL_POLICY_OPTIONS: Array<{
  id: VenomModelSelectionPolicy;
  title: string;
  description: string;
}> = [
  {
    id: "manual",
    title: "Manual",
    description: "You choose which models run.",
  },
  {
    id: "auto-cheapest",
    title: "Auto — cheapest",
    description:
      "Venom keeps you on the cheapest healthy models and switches the moment availability or account health changes.",
  },
  {
    id: "auto-max-power",
    title: "Auto — max power",
    description:
      "Venom runs the most capable models for complex, advanced thought and switches the moment availability changes.",
  },
];

type FocusableHandle = {
  focus?: () => void;
};

// Where keyboard focus should land once the remove-source dialog has fully
// dismissed: back on the remove control on cancel, or on a surviving row's
// remove control (else the always-present browse-sources entry) after a
// removal unmounts the row that opened the dialog.
type RemoveDismissFocusTarget =
  | { kind: "remove-button"; sourceId: string }
  | { kind: "neighbor-or-browse"; sourceId: string | null };

export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signOut } = useClerk();
  const { user } = useUser();
  const {
    state,
    syncStatus,
    lastSyncedAt,
    addSource,
    refreshSource,
    setSourceSchedule,
    removeSource,
    enableModel,
    removeModel,
    setDefaultModel,
    setModelSelectionPolicy,
    setVoicePreset,
    setVoiceTalkativeness,
    orgs,
    orgInvites,
  } = useVenom();

  const [showGitHubPicker, setShowGitHubPicker] = React.useState(false);
  const [websiteUrl, setWebsiteUrl] = React.useState("");
  const [sourceError, setSourceError] = React.useState<string | null>(null);
  const [refreshingSourceId, setRefreshingSourceId] = React.useState<
    string | null
  >(null);
  const [refreshErrors, setRefreshErrors] = React.useState<
    Record<string, string>
  >({});
  // Keeps the "last synced" labels honest while the screen stays open.
  const [now, setNow] = React.useState(() => Date.now());
  const [exportingKind, setExportingKind] = React.useState<
    "brain" | "sops" | null
  >(null);
  // Removing a source is destructive and propagates to every synced device
  // via tombstones (a removed source is retired for good), so the "x" control
  // never acts on one tap: it stages the source here and the dialog's own
  // destructive action performs the actual removal. The name is snapshotted
  // so the dialog stays coherent even if a sync merge rewrites the source
  // list while it is open.
  const [pendingRemove, setPendingRemove] = React.useState<{
    id: string;
    name: string;
  } | null>(null);
  const [focusedRemoveId, setFocusedRemoveId] = React.useState<string | null>(
    null,
  );
  const [cancelRemoveFocused, setCancelRemoveFocused] = React.useState(false);
  const [confirmRemoveFocused, setConfirmRemoveFocused] = React.useState(false);
  const reduceMotion = useReducedMotion();
  const dialogAppear = React.useRef(new RNAnimated.Value(0)).current;
  const cancelRemoveRef = React.useRef<FocusableHandle | null>(null);
  const removeButtonRefs = React.useRef<Map<string, FocusableHandle>>(
    new Map(),
  );
  const browseSourcesRef = React.useRef<FocusableHandle | null>(null);
  const removeDismissFocusRef = React.useRef<RemoveDismissFocusTarget | null>(
    null,
  );

  // Personal markdown export is always available and always scoped to this
  // account's personal tier — it contains no workspace content, so it keeps
  // working even after leaving a workspace.
  const handlePersonalExport = async (kind: "brain" | "sops") => {
    if (exportingKind) return;
    setExportingKind(kind);
    try {
      const markdown = await exportVenomPersonalMarkdown(kind);
      await deliverMarkdown(markdownExportFileName("personal", kind), markdown);
    } catch {
      Alert.alert(
        "Export failed",
        "The download could not be prepared. Try again.",
      );
    } finally {
      setExportingKind(null);
    }
  };

  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // The dialog animates its own card because the modal container must not
  // animate on web: an animated modal keeps its focus trap alive while it
  // fades out and strands keyboard focus (see app/projects.tsx for the
  // shared pattern).
  React.useEffect(() => {
    if (!pendingRemove) return;
    dialogAppear.setValue(reduceMotion ? 1 : 0);
    if (reduceMotion) return;
    const appearance = RNAnimated.timing(dialogAppear, {
      toValue: 1,
      duration: 170,
      useNativeDriver: Platform.OS !== "web",
    });
    appearance.start();
    return () => appearance.stop();
  }, [dialogAppear, pendingRemove, reduceMotion]);

  // The remove dialog holds no input to autoFocus, so focus is placed
  // explicitly on the safe action once the modal is mounted; without this,
  // keyboard focus would stay behind the open dialog.
  React.useEffect(() => {
    if (!pendingRemove) return;
    const frame = requestAnimationFrame(() => {
      cancelRemoveRef.current?.focus?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingRemove]);

  const modelPreferences = state.modelPreferences;
  const enabledModelIds = modelPreferences?.enabledModelIds ?? ["venom-gpt"];
  const defaultModelId = modelPreferences?.defaultModelId ?? "venom-gpt";
  const selectionPolicy = modelPreferences?.selectionPolicy ?? "manual";

  // Admin model locks ride the billing context of the active shared
  // workspace. Display only — the server clamps every workspace-billed
  // request regardless — so a failed read simply shows the user's own
  // settings while enforcement still holds.
  const { activeWorkspace } = useSharedWorkspace();
  const billingContextParams = activeWorkspace
    ? { workspaceId: activeWorkspace.id }
    : undefined;
  const billingContextQuery = useGetVenomBillingContext(billingContextParams, {
    query: {
      queryKey: getGetVenomBillingContextQueryKey(billingContextParams),
      enabled: Boolean(activeWorkspace),
      staleTime: 60_000,
      retry: 1,
    },
  });
  const modelLock = activeWorkspace
    ? (billingContextQuery.data?.modelLock ?? null)
    : null;
  const managedByName = activeWorkspace?.name ?? "this workspace";
  const forcedPolicy = modelLock?.forcedSelectionPolicy ?? null;
  const policyLocked = Boolean(forcedPolicy);
  // A workspace-forced policy takes precedence over the user's own while
  // work is billed there; the stored personal choice stays untouched.
  const effectivePolicy = forcedPolicy ?? selectionPolicy;
  const autoPolicyActive = effectivePolicy !== "manual";

  const modelsQuery = useGetVenomModels({
    query: {
      queryKey: ["venom-models"],
      staleTime: 5 * 60 * 1000,
    },
  });

  // Tier locks bind only when at least one catalog model sits in an allowed
  // tier — mirroring the server, which fails open rather than serving
  // nothing when a lock would empty the catalog.
  const allowedTiersRaw = modelLock?.allowedCostTiers ?? null;
  const tierLockLive = Boolean(
    allowedTiersRaw &&
      allowedTiersRaw.length > 0 &&
      (modelsQuery.data ?? []).some(
        (model: VenomManagedModel) =>
          model.costTier && allowedTiersRaw.includes(model.costTier),
      ),
  );
  const lockedTiers = tierLockLive ? allowedTiersRaw : null;

  const voicesQuery = useGetVenomVoices({
    query: {
      queryKey: ["venom-voices"],
      staleTime: 5 * 60 * 1000,
    },
  });
  const voiceSample = useVoiceSample();
  const selectedVoiceId: VenomVoicePresetId =
    state.voicePreferences?.presetId ?? DEFAULT_VOICE_PRESET_ID;
  const voicePresets = voicesQuery.data ?? [];
  const voiceUnavailable =
    voicePresets.length > 0 && voicePresets.every((p) => !p.available);
  const voicePalette = {
    rowBackground: colors.card,
    rowBorder: colors.border,
    selectedBorder: colors.primary,
    name: colors.foreground,
    persona: colors.mutedForeground,
    icon: colors.foreground,
    radioOn: colors.primary,
    radioOff: colors.mutedForeground,
  };
  const talkativeness =
    state.voicePreferences?.talkativeness ?? DEFAULT_VOICE_TALKATIVENESS;
  const talkativenessPalette = {
    segmentBackground: colors.card,
    segmentBorder: colors.border,
    selectedBackground: colors.primary,
    selectedText: colors.background,
    text: colors.mutedForeground,
    description: colors.mutedForeground,
  };

  const { data: health, isError } = useHealthCheck();
  const isConnected = !!health && !isError;

  const activeProject = state.projects.find(
    (project) => project.id === state.activeProjectId,
  );
  const projectSources = (state.sources ?? []).filter(
    (source) => source.projectId === activeProject?.id,
  );

  const projectSopsQuery = useListVenomProjectSops(activeProject?.id ?? "", {
    query: {
      queryKey: getListVenomProjectSopsQueryKey(activeProject?.id ?? ""),
      enabled: Boolean(activeProject?.id),
    },
  });
  const projectSopCount = projectSopsQuery.data?.length ?? 0;

  const githubRepositories = useGetGitHubRepositories({
    query: {
      queryKey: ["github-repositories"],
      enabled: showGitHubPicker,
    },
  });

  const githubSource = useConnectGitHubSource({
    mutation: {
      onSuccess: (source) => {
        addSource(source);
        setShowGitHubPicker(false);
        setSourceError(null);
      },
      onError: (error: Error) =>
        setSourceError(
          describeSourceFailure(
            error,
            "Venom could not connect this repository. Try again.",
          ),
        ),
    },
  });

  const websiteSource = useConnectWebsiteSource({
    mutation: {
      onSuccess: (source) => {
        addSource(source);
        setWebsiteUrl("");
        setSourceError(null);
      },
      onError: (error: Error) =>
        setSourceError(
          describeSourceFailure(
            error,
            "Venom could not connect this website. Try again.",
          ),
        ),
    },
  });

  const applyRefresh = React.useCallback(
    (previousSourceId: string, source: ProjectSource) => {
      refreshSource(previousSourceId, source);
      setNow(Date.now());
      setRefreshingSourceId((current) =>
        current === previousSourceId ? null : current,
      );
      setRefreshErrors((current) => {
        if (!(previousSourceId in current)) return current;
        const next = { ...current };
        delete next[previousSourceId];
        return next;
      });
    },
    [refreshSource],
  );

  const failRefresh = React.useCallback(
    (previousSourceId: string, message: string) => {
      setRefreshingSourceId((current) =>
        current === previousSourceId ? null : current,
      );
      setRefreshErrors((current) => ({
        ...current,
        [previousSourceId]: message,
      }));
    },
    [],
  );

  // The connect endpoints recompute a deterministic source id, so a refresh is
  // the original connect request replayed for one specific card.
  const refreshTargetRef = React.useRef<string | null>(null);

  const refreshHandlers = {
    onSuccess: (source: ProjectSource) => {
      const target = refreshTargetRef.current;
      if (!target) return;
      refreshTargetRef.current = null;
      applyRefresh(target, source);
    },
    onError: (error: Error) => {
      const target = refreshTargetRef.current;
      if (!target) return;
      refreshTargetRef.current = null;
      failRefresh(
        target,
        describeSourceFailure(
          error,
          "Venom could not refresh this source. Try again.",
        ),
      );
    },
  };

  const githubRefresh = useConnectGitHubSource({ mutation: refreshHandlers });
  const websiteRefresh = useConnectWebsiteSource({ mutation: refreshHandlers });

  const refreshConnectedSource = (source: ProjectSource) => {
    if (refreshingSourceId) return;

    const request = sourceRefreshRequest(source);
    if (!request) {
      failRefresh(
        source.id,
        "Venom cannot refresh this source automatically. Remove it and connect it again.",
      );
      return;
    }

    refreshTargetRef.current = source.id;
    setRefreshingSourceId(source.id);
    setRefreshErrors((current) => {
      if (!(source.id in current)) return current;
      const next = { ...current };
      delete next[source.id];
      return next;
    });

    if (request.provider === "github") {
      githubRefresh.mutate({
        projectId: request.projectId,
        data: { repository: request.repository },
      });
      return;
    }

    websiteRefresh.mutate({
      projectId: request.projectId,
      data: { url: request.url },
    });
  };

  // Venom network contribution (the anonymous master ontology). Off until
  // this account opts in; the server record is the source of truth. UI-test
  // runs get a deterministic "off" so no unstubbed fetch fires.
  const [networkContribution, setNetworkContribution] =
    React.useState<VenomMasterContribution | null>(null);
  const [networkContributionBusy, setNetworkContributionBusy] =
    React.useState(false);
  const [networkContributionFailed, setNetworkContributionFailed] =
    React.useState(false);
  React.useEffect(() => {
    if (IS_UI_TEST) {
      setNetworkContribution({ enabled: false });
      return;
    }
    let stale = false;
    (async () => {
      try {
        const contribution = await getVenomMasterContribution();
        if (!stale) setNetworkContribution(contribution);
      } catch {
        if (!stale) setNetworkContributionFailed(true);
      }
    })();
    return () => {
      stale = true;
    };
  }, []);
  const toggleNetworkContribution = async () => {
    if (networkContributionBusy || !networkContribution) return;
    const next = !networkContribution.enabled;
    setNetworkContributionBusy(true);
    try {
      const updated = await updateVenomMasterContribution({ enabled: next });
      setNetworkContribution(updated);
    } catch {
      Alert.alert(
        "Couldn't update",
        "Venom couldn't reach the network settings. Check your connection and try again.",
      );
    } finally {
      setNetworkContributionBusy(false);
    }
  };

  const syncLabels = {
    loading: "Restoring",
    pending: "Action needed",
    syncing: "Syncing",
    synced: "Synced",
    offline: "Offline",
    too_large: "Too large",
    error: "Retry needed",
  } as const;
  const isSyncHealthy = syncStatus === "synced" || syncStatus === "syncing";
  // Who Venom recognizes this account as. The server identity record is the
  // source of truth (it is what gets stamped onto captured knowledge); the
  // Clerk client profile fills in while it loads or offline. UI-test mode has
  // no Clerk session, so the placeholder account keeps this query live for
  // the browser suite's stubbed identity.
  const accountId = IS_UI_TEST ? UI_TEST_USER_ID : (user?.id ?? null);
  const { data: identity } = useGetVenomIdentity({
    query: {
      queryKey: getGetVenomIdentityQueryKey(),
      enabled: Boolean(accountId),
      staleTime: 5 * 60_000,
      retry: 1,
    },
  });
  // Personal AI spend for the current month. The server computes dollars from
  // its private pricing table and returns Venom-branded model names only.
  // UI-test runs render a deterministic fixture so no unstubbed fetch fires.
  const usageQuery = useGetVenomUsageSummary({
    query: {
      queryKey: getGetVenomUsageSummaryQueryKey(),
      enabled: !IS_UI_TEST,
      staleTime: 60_000,
      retry: 1,
    },
  });
  const usageSummary: VenomUsageSummary | null = IS_UI_TEST
    ? UI_TEST_USAGE_SUMMARY
    : (usageQuery.data ?? null);
  const usageFailed = !IS_UI_TEST && usageQuery.isError;
  const usageLoading = usageSummary === null && !usageFailed;
  const usageMaxDailyCost = usageSummary
    ? Math.max(...usageSummary.daily.map((day) => day.costUsd), 0)
    : 0;
  // Personal plan + allowance for the Billing section. Only personally-
  // billed spend moves this meter — workspace-billed chats never touch it.
  // UI-test mode renders a deterministic fixture so no unstubbed fetch fires.
  const billingQuery = useGetVenomBillingSummary({
    query: {
      queryKey: getGetVenomBillingSummaryQueryKey(),
      enabled: !IS_UI_TEST,
      staleTime: 60_000,
      retry: 1,
    },
  });
  const billingSummary: VenomBillingSummary | null = IS_UI_TEST
    ? UI_TEST_BILLING_SUMMARY
    : // Only trust a well-shaped summary — an SPA fallback or proxy can
      // answer with truthy non-JSON garbage that must not crash Settings.
      (billingQuery.data?.plan ? billingQuery.data : null);
  const billingFailed = !IS_UI_TEST && billingQuery.isError;
  const billingLoading = billingSummary === null && !billingFailed;
  const billingAllowance = billingSummary?.plan.allowanceUsd ?? 0;
  const billingShare = billingSummary
    ? billingAllowance > 0
      ? Math.min(billingSummary.spentUsd / billingAllowance, 1)
      : 1
    : 0;
  const [billingAction, setBillingAction] = React.useState<
    "checkout" | "portal" | null
  >(null);
  const [billingActionError, setBillingActionError] = React.useState<
    string | null
  >(null);

  // Upgrading and managing payment happen on Stripe-hosted pages — the app
  // only ever opens the URL the server minted; card details never pass
  // through Venom.
  const openBillingPage = async (kind: "checkout" | "portal") => {
    if (billingAction) return;
    setBillingAction(kind);
    setBillingActionError(null);
    try {
      const returnUrl =
        Platform.OS === "web" && typeof window !== "undefined"
          ? window.location.href
          : undefined;
      const { url } =
        kind === "checkout"
          ? await createVenomBillingCheckout(returnUrl ? { returnUrl } : {})
          : await createVenomBillingPortal(returnUrl ? { returnUrl } : {});
      await Linking.openURL(url);
    } catch {
      setBillingActionError(
        kind === "checkout"
          ? "Checkout couldn't be started. Try again in a moment."
          : "The billing portal couldn't be opened. Try again in a moment.",
      );
    } finally {
      setBillingAction(null);
    }
  };
  const accountName =
    identity?.displayName ?? user?.fullName ?? user?.firstName ?? null;
  const accountLabel =
    identity?.email ??
    user?.primaryEmailAddress?.emailAddress ??
    "Authenticated account";

  const handleSignOut = async () => {
    await signOut();
    router.replace("/(auth)/sign-in" as never);
  };

  const connectRepository = (repository: string) => {
    if (!activeProject) {
      setSourceError("Select a project before connecting a source.");
      return;
    }
    githubSource.mutate({
      projectId: activeProject.id,
      data: { repository },
    });
  };

  const connectWebsite = () => {
    if (!activeProject) {
      setSourceError("Select a project before connecting a source.");
      return;
    }
    if (!websiteUrl.trim()) return;
    websiteSource.mutate({
      projectId: activeProject.id,
      data: { url: websiteUrl.trim() },
    });
  };

  const registerRemoveButtonRef =
    (sourceId: string) => (node: FocusableHandle | null) => {
      if (node) removeButtonRefs.current.set(sourceId, node);
      else removeButtonRefs.current.delete(sourceId);
    };

  const requestRemoveSource = (source: ProjectSource) => {
    removeDismissFocusRef.current = null;
    setPendingRemove({ id: source.id, name: source.name });
  };

  const cancelRemoveSource = () => {
    // The source is untouched, so its remove control still exists: hand
    // focus straight back to it.
    if (pendingRemove) {
      removeDismissFocusRef.current = {
        kind: "remove-button",
        sourceId: pendingRemove.id,
      };
    }
    setPendingRemove(null);
  };

  const confirmRemoveSource = () => {
    if (!pendingRemove) return;
    // Confirming unmounts the row that opened this dialog, so the focus
    // destination must be computed from pre-removal state: the next source
    // in the rendered order, else the previous one. When neither exists (the
    // last source was removed) the target stays null and dismissal falls
    // back to the browse-sources entry that stays on screen.
    const index = projectSources.findIndex(
      (source) => source.id === pendingRemove.id,
    );
    const neighbor =
      index >= 0
        ? (projectSources[index + 1] ?? projectSources[index - 1])
        : undefined;
    removeDismissFocusRef.current = {
      kind: "neighbor-or-browse",
      sourceId: neighbor?.id ?? null,
    };
    removeSource(pendingRemove.id);
    setPendingRemove(null);
  };

  // Fires once the modal is actually gone (immediately on web) and its focus
  // trap has released, so an explicit focus target sticks.
  const handleRemoveDialogDismiss = () => {
    const target = removeDismissFocusRef.current;
    removeDismissFocusRef.current = null;
    if (!target) return;
    if (target.kind === "remove-button") {
      removeButtonRefs.current.get(target.sourceId)?.focus?.();
      return;
    }
    const preferred = target.sourceId
      ? removeButtonRefs.current.get(target.sourceId)
      : undefined;
    if (preferred?.focus) {
      preferred.focus();
      return;
    }
    browseSourcesRef.current?.focus?.();
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Header title="Settings" showBack />

      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 24 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Account */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.primary }]}>
            Account
          </Text>
          <View
            style={[
              styles.card,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <View style={styles.accountRow}>
              <View
                style={[
                  styles.avatar,
                  {
                    backgroundColor: colors.accent,
                    borderColor: colors.border,
                  },
                ]}
              >
                <Feather name="user" size={18} color={colors.primary} />
              </View>
              <View style={styles.accountCopy}>
                <Text
                  style={[styles.rowTitle, { color: colors.foreground }]}
                  numberOfLines={1}
                  testID="text-account-name"
                >
                  {accountName ?? "Signed in"}
                </Text>
                <Text
                  style={[
                    styles.accountEmail,
                    { color: colors.mutedForeground },
                  ]}
                  numberOfLines={1}
                  testID="text-account-email"
                >
                  {accountLabel}
                </Text>
              </View>
            </View>
            {user?.id ? (
              <View
                style={[
                  styles.accountIdentity,
                  { borderColor: colors.border },
                ]}
                testID="source-account-identity"
              >
                <Text
                  style={[
                    styles.accountIdentityHelp,
                    { color: colors.mutedForeground },
                  ]}
                >
                  Clerk ID for GitHub workspace authorization
                </Text>
                <Text
                  selectable
                  style={[
                    styles.accountIdentityValue,
                    { color: colors.foreground },
                  ]}
                  testID="clerk-user-id"
                >
                  {user.id}
                </Text>
              </View>
            ) : null}
          </View>
        </View>

        {/* Connection Status */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.primary }]}>
            Connection
          </Text>
          <View
            style={[
              styles.card,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <View style={styles.row}>
              <View style={styles.rowLeft}>
                <Feather
                  name="server"
                  size={18}
                  color={isConnected ? colors.primary : colors.destructive}
                />
                <Text style={[styles.rowTitle, { color: colors.foreground }]}>
                   Service
                </Text>
              </View>
              <Text
                style={[
                  styles.statusText,
                  {
                    color: isConnected ? colors.primary : colors.destructive,
                  },
                ]}
              >
                {isConnected ? "Online" : "Offline"}
              </Text>
            </View>
            <View
              style={[styles.divider, { backgroundColor: colors.border }]}
            />
            <View style={styles.row}>
              <View style={styles.rowLeft}>
                <Feather
                  name="activity"
                  size={18}
                  color={colors.mutedForeground}
                />
                <Text style={[styles.rowTitle, { color: colors.foreground }]}>
                  Latency
                </Text>
              </View>
              <Text
                style={[
                  styles.statusText,
                  { color: colors.mutedForeground },
                ]}
              >
                {isConnected ? "24ms" : "--"}
              </Text>
            </View>
          </View>
        </View>

        {/* AI Models */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.primary }]}>
            AI Models
          </Text>
          <Text
            style={[
              styles.sourceDescription,
              { color: colors.mutedForeground },
            ]}
          >
            Enable or remove managed models from your account. The default model
            is used when no specific selection is made.
          </Text>

          {/* Account-level selection policy: manual keeps explicit picks;
              the auto modes hand the choice to Venom on every reply. */}
          <View
            style={[
              styles.card,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
            accessibilityRole="radiogroup"
            accessibilityLabel="Model selection policy"
            testID="model-policy-control"
          >
            {MODEL_POLICY_OPTIONS.map((option, index) => {
              const selected = effectivePolicy === option.id;
              return (
                <React.Fragment key={option.id}>
                  {index > 0 && (
                    <View
                      style={[
                        styles.divider,
                        { backgroundColor: colors.border, marginLeft: 0 },
                      ]}
                    />
                  )}
                  <TouchableOpacity
                    onPress={() => setModelSelectionPolicy(option.id)}
                    disabled={policyLocked}
                    style={[
                      styles.policyRow,
                      policyLocked && { opacity: 0.55 },
                    ]}
                    accessibilityRole="radio"
                    accessibilityLabel={option.title}
                    accessibilityState={{
                      selected,
                      checked: selected,
                      disabled: policyLocked,
                    }}
                    aria-checked={selected}
                    testID={`policy-${option.id}`}
                  >
                    <View
                      style={[
                        styles.policyRadio,
                        {
                          borderColor: selected
                            ? colors.primary
                            : colors.border,
                          backgroundColor: selected
                            ? colors.primary
                            : "transparent",
                        },
                      ]}
                    >
                      {selected && (
                        <Feather
                          name="check"
                          size={12}
                          color={colors.primaryForeground}
                        />
                      )}
                    </View>
                    <View style={styles.policyCopy}>
                      <Text
                        style={[
                          styles.rowTitle,
                          { color: colors.foreground },
                        ]}
                      >
                        {option.title}
                      </Text>
                      <Text
                        style={[
                          styles.policyDescription,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        {option.description}
                      </Text>
                    </View>
                  </TouchableOpacity>
                </React.Fragment>
              );
            })}
          </View>

          {/* In auto modes the manual pickers below visibly hand over; a
              workspace-forced policy does the same, labeled with who manages
              it. The server clamps regardless of what this screen shows. */}
          {policyLocked ? (
            <View
              style={[
                styles.policyTakeover,
                {
                  borderColor: colors.border,
                  backgroundColor: colors.card,
                },
              ]}
              testID="model-policy-managed"
            >
              <Feather name="lock" size={14} color={colors.primary} />
              <Text
                style={[
                  styles.policyTakeoverText,
                  { color: colors.mutedForeground },
                ]}
              >
                Managed by {managedByName} — its admins{" "}
                {forcedPolicy === "auto-cheapest"
                  ? "route every reply billed to the workspace to the cheapest healthy models."
                  : "route every reply billed to the workspace to the most capable models."}{" "}
                Your own settings are kept and still apply in your personal
                space.
              </Text>
            </View>
          ) : autoPolicyActive ? (
            <View
              style={[
                styles.policyTakeover,
                {
                  borderColor: colors.border,
                  backgroundColor: colors.card,
                },
              ]}
              testID="model-policy-takeover"
            >
              <Feather name="zap" size={14} color={colors.primary} />
              <Text
                style={[
                  styles.policyTakeoverText,
                  { color: colors.mutedForeground },
                ]}
              >
                Venom is choosing —{" "}
                {effectivePolicy === "auto-cheapest"
                  ? "the cheapest healthy models carry every reply, and the account switches automatically when availability or account health changes."
                  : "the most capable models carry every reply, and the account switches automatically when availability changes."}{" "}
                Your manual picks below wake up again on Manual.
              </Text>
            </View>
          ) : null}

          {modelsQuery.isLoading ? (
            <View style={styles.modelLoading}>
              <ActivityIndicator size="small" color={colors.primary} />
            </View>
          ) : modelsQuery.isError ? (
            <View
              style={[
                styles.sourceError,
                {
                  borderColor: colors.destructive,
                  backgroundColor: colors.card,
                },
              ]}
            >
              <Feather
                name="alert-circle"
                size={15}
                color={colors.destructive}
              />
              <Text
                style={[
                  styles.sourceErrorText,
                  { color: colors.destructive },
                ]}
              >
                Could not load model catalog. Check your connection.
              </Text>
            </View>
          ) : (
            <View
              style={[
                styles.card,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
            >
              {(modelsQuery.data ?? []).map(
                (model: VenomManagedModel, index: number) => {
                  const isEnabled = enabledModelIds.includes(
                    model.id as VenomModelId,
                  );
                  const isDefault = defaultModelId === model.id;
                  const isOnlyEnabled =
                    enabledModelIds.length === 1 && isEnabled;
                  // The workspace tier lock excludes this model from
                  // workspace-billed replies; its controls stay visible but
                  // disabled, labeled managed. Removal stays allowed.
                  const managedOut = Boolean(
                    lockedTiers &&
                      !(
                        model.costTier &&
                        lockedTiers.includes(model.costTier)
                      ),
                  );

                  return (
                    <React.Fragment key={model.id}>
                      {index > 0 && (
                        <View
                          style={[
                            styles.divider,
                            {
                              backgroundColor: colors.border,
                              marginLeft: 0,
                            },
                          ]}
                        />
                      )}
                      <View style={styles.modelRow}>
                        <View style={styles.modelLeft}>
                          <View
                            style={[
                              styles.modelIcon,
                              {
                                backgroundColor: isEnabled
                                  ? colors.primary
                                  : colors.accent,
                                borderColor: isEnabled
                                  ? colors.primary
                                  : colors.border,
                              },
                            ]}
                          >
                            <Feather
                              name="cpu"
                              size={14}
                              color={
                                isEnabled
                                  ? colors.primaryForeground
                                  : colors.mutedForeground
                              }
                            />
                          </View>
                          <View style={styles.modelCopy}>
                            <View style={styles.modelNameRow}>
                              <Text
                                style={[
                                  styles.modelName,
                                  {
                                    color: isEnabled
                                      ? colors.foreground
                                      : colors.mutedForeground,
                                  },
                                ]}
                              >
                                {model.name}
                              </Text>
                              {isDefault && isEnabled && (
                                <View
                                  style={[
                                    styles.modelBadge,
                                    { borderColor: colors.border },
                                  ]}
                                >
                                  <Text
                                    style={[
                                      styles.modelBadgeText,
                                      { color: colors.primary },
                                    ]}
                                  >
                                    Default
                                  </Text>
                                </View>
                              )}
                              {model.costTier && (
                                <View
                                  style={[
                                    styles.modelBadge,
                                    { borderColor: colors.border },
                                  ]}
                                  accessibilityLabel={`Relative cost ${model.costTier} of $$$`}
                                  testID={`cost-badge-${model.id}`}
                                >
                                  <Text
                                    style={[
                                      styles.modelBadgeText,
                                      { color: colors.mutedForeground },
                                    ]}
                                  >
                                    {model.costTier}
                                  </Text>
                                </View>
                              )}
                              {managedOut && (
                                <View
                                  style={[
                                    styles.modelBadge,
                                    { borderColor: colors.border },
                                  ]}
                                  accessibilityLabel={`Not allowed in ${managedByName} — managed by its admins`}
                                  testID={`model-managed-${model.id}`}
                                >
                                  <Text
                                    style={[
                                      styles.modelBadgeText,
                                      { color: colors.mutedForeground },
                                    ]}
                                  >
                                    Managed
                                  </Text>
                                </View>
                              )}
                            </View>
                            <Text
                              style={[
                                styles.modelAvailability,
                                {
                                  // A configured model with a billing-dead
                                  // provider account keeps its toggle but its
                                  // status reads as a problem, not "Ready".
                                  color:
                                    model.available &&
                                    model.accountHealth !== "unfunded"
                                      ? colors.mutedForeground
                                      : colors.destructive,
                                },
                              ]}
                              numberOfLines={1}
                            >
                              {model.availabilityText}
                            </Text>
                          </View>
                        </View>
                        <View style={styles.modelActions}>
                          {isEnabled && !isDefault && (
                            <TouchableOpacity
                              onPress={() =>
                                setDefaultModel(model.id as VenomModelId)
                              }
                              disabled={autoPolicyActive || managedOut}
                              style={[
                                styles.modelActionButton,
                                {
                                  borderColor: colors.border,
                                  opacity:
                                    autoPolicyActive || managedOut ? 0.38 : 1,
                                },
                              ]}
                              accessibilityRole="button"
                              accessibilityLabel={`Set ${model.name} as default`}
                              accessibilityState={{
                                disabled: autoPolicyActive || managedOut,
                              }}
                              hitSlop={8}
                              testID={`set-default-model-${model.id}`}
                            >
                              <Feather
                                name="star"
                                size={13}
                                color={colors.mutedForeground}
                              />
                            </TouchableOpacity>
                          )}
                          {isEnabled && isDefault && (
                            <View
                              style={[
                                styles.modelActionButton,
                                {
                                  borderColor: colors.primary,
                                  backgroundColor: colors.primary,
                                },
                              ]}
                            >
                              <Feather
                                name="star"
                                size={13}
                                color={colors.primaryForeground}
                              />
                            </View>
                          )}
                          <TouchableOpacity
                            onPress={() =>
                              isEnabled
                                ? removeModel(model.id as VenomModelId)
                                : enableModel(model.id as VenomModelId)
                            }
                            disabled={
                              (isOnlyEnabled && isEnabled) ||
                              (!isEnabled && !model.available) ||
                              (!isEnabled && managedOut) ||
                              autoPolicyActive
                            }
                            style={[
                              styles.modelActionButton,
                              {
                                borderColor: isEnabled
                                  ? colors.destructive
                                  : colors.border,
                                opacity:
                                  (isOnlyEnabled && isEnabled) ||
                                  (!isEnabled && !model.available) ||
                                  (!isEnabled && managedOut) ||
                                  autoPolicyActive
                                    ? 0.38
                                    : 1,
                              },
                            ]}
                            accessibilityRole="button"
                            accessibilityLabel={
                              isEnabled
                                ? `Remove ${model.name}`
                                : `Enable ${model.name}`
                            }
                            accessibilityState={{
                              disabled:
                                (isOnlyEnabled && isEnabled) ||
                                (!isEnabled && !model.available) ||
                                (!isEnabled && managedOut) ||
                                autoPolicyActive,
                            }}
                            hitSlop={8}
                            testID={`toggle-model-${model.id}`}
                          >
                            <Feather
                              name={isEnabled ? "x" : "plus"}
                              size={13}
                              color={
                                isEnabled
                                  ? colors.destructive
                                  : colors.mutedForeground
                              }
                            />
                          </TouchableOpacity>
                        </View>
                      </View>
                    </React.Fragment>
                  );
                },
              )}
            </View>
          )}
        </View>

        {/* Voice */}
        <View style={styles.section} testID="voice-settings-section">
          <Text style={[styles.sectionTitle, { color: colors.primary }]}>
            Voice
          </Text>
          <Text
            style={[
              styles.sourceDescription,
              { color: colors.mutedForeground },
            ]}
          >
            Pick who talks back in hands-free voice mode. Tap play to hear a
            sample. Your choice follows your account across devices.
          </Text>

          {voicesQuery.isLoading ? (
            <View style={styles.modelLoading}>
              <ActivityIndicator size="small" color={colors.primary} />
            </View>
          ) : voicesQuery.isError ? (
            <Text
              style={[
                styles.sourceDescription,
                { color: colors.mutedForeground },
              ]}
              testID="voice-settings-error"
            >
              Voices are unreachable right now. Chat by text works as always.
            </Text>
          ) : (
            <>
              {voiceUnavailable && (
                <Text
                  style={[
                    styles.sourceDescription,
                    { color: colors.mutedForeground },
                  ]}
                  testID="voice-settings-unavailable"
                >
                  {voicePresets[0]?.availabilityText ??
                    "Voice isn't configured on the server yet."}
                </Text>
              )}
              <VoicePresetList
                presets={voicePresets}
                selectedId={selectedVoiceId}
                onSelect={(id) => setVoicePreset(id)}
                onPreview={(preset) =>
                  voiceSample.playSample(preset.id, preset.sampleText)
                }
                previewingId={voiceSample.previewingId}
                palette={voicePalette}
                previewsDisabled={voiceUnavailable}
              />
              {voiceSample.sampleError && (
                <Text
                  style={[
                    styles.sourceDescription,
                    { color: colors.mutedForeground },
                  ]}
                  testID="voice-settings-sample-error"
                >
                  {voiceSample.sampleError}
                </Text>
              )}
            </>
          )}

          <Text
            style={[
              styles.sectionTitle,
              { color: colors.primary, marginTop: 18 },
            ]}
          >
            Talkativeness
          </Text>
          <Text
            style={[
              styles.sourceDescription,
              { color: colors.mutedForeground },
            ]}
          >
            How eager Venom is to speak in voice mode when a remark doesn't
            clearly call for an answer. Direct questions always get a full
            reply. Synced across your devices.
          </Text>
          <TalkativenessControl
            value={talkativeness}
            onChange={setVoiceTalkativeness}
            palette={talkativenessPalette}
          />
        </View>

        {/* Sync and your data */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.primary }]}>
            Your data
          </Text>
          <View
            style={[
              styles.card,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <TouchableOpacity
              style={styles.row}
              onPress={() => handlePersonalExport("brain")}
              disabled={exportingKind !== null}
              accessibilityRole="button"
              accessibilityLabel="Download your Brain notes as Markdown"
              testID="button-export-personal-brain"
            >
              <View style={styles.rowLeft}>
                <Feather
                  name="download"
                  size={18}
                  color={colors.mutedForeground}
                />
                <View style={{ flexShrink: 1 }}>
                  <Text style={[styles.rowTitle, { color: colors.foreground }]}>
                    Download Brain notes (.md)
                  </Text>
                  <Text
                    style={[
                      styles.sourceDescription,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    Your personal knowledge as a Markdown file.
                  </Text>
                </View>
              </View>
              {exportingKind === "brain" ? (
                <ActivityIndicator
                  size="small"
                  color={colors.mutedForeground}
                />
              ) : (
                <Feather
                  name="chevron-right"
                  size={16}
                  color={colors.mutedForeground}
                />
              )}
            </TouchableOpacity>
            <View
              style={[styles.divider, { backgroundColor: colors.border }]}
            />
            <TouchableOpacity
              style={styles.row}
              onPress={() => handlePersonalExport("sops")}
              disabled={exportingKind !== null}
              accessibilityRole="button"
              accessibilityLabel="Download your SOPs as Markdown"
              testID="button-export-personal-sops"
            >
              <View style={styles.rowLeft}>
                <Feather
                  name="download"
                  size={18}
                  color={colors.mutedForeground}
                />
                <View style={{ flexShrink: 1 }}>
                  <Text style={[styles.rowTitle, { color: colors.foreground }]}>
                    Download SOPs (.md)
                  </Text>
                  <Text
                    style={[
                      styles.sourceDescription,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    Your personal procedures as a Markdown file.
                  </Text>
                </View>
              </View>
              {exportingKind === "sops" ? (
                <ActivityIndicator
                  size="small"
                  color={colors.mutedForeground}
                />
              ) : (
                <Feather
                  name="chevron-right"
                  size={16}
                  color={colors.mutedForeground}
                />
              )}
            </TouchableOpacity>
            <View
              style={[styles.divider, { backgroundColor: colors.border }]}
            />
            <View style={styles.row}>
              <View style={styles.rowLeft}>
                <Feather
                  name="database"
                  size={18}
                  color={colors.mutedForeground}
                />
                <Text style={[styles.rowTitle, { color: colors.foreground }]}>
                   Cloud backup
                </Text>
              </View>
              <View style={styles.syncCopy}>
                <Text
                  testID="cloud-sync-status"
                  style={[
                    styles.statusText,
                    {
                      color: isSyncHealthy
                        ? colors.primary
                        : colors.destructive,
                    },
                  ]}
                >
                  {syncLabels[syncStatus]}
                </Text>
                {lastSyncedAt ? (
                  <Text
                    style={[
                      styles.syncTime,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    {new Date(lastSyncedAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </Text>
                ) : null}
              </View>
            </View>
          </View>
        </View>

        {/* Venom network */}
        <View style={styles.section} testID="settings-network-section">
          <Text style={[styles.sectionTitle, { color: colors.primary }]}>
            Venom network
          </Text>
          <Text
            style={[
              styles.sourceDescription,
              { color: colors.mutedForeground },
            ]}
          >
            Help improve Venom's shared knowledge network. When this is on,
            your account contributes anonymous concept patterns — concept
            names, categories, and which concepts connect. Your chats, notes,
            sources, evidence, and identity never leave your account, and a
            concept stays hidden until it is common across many accounts.
            Turning this off also removes your influence from future updates.
          </Text>
          <TouchableOpacity
            testID="network-contribution-toggle"
            style={[
              styles.networkToggleRow,
              { borderColor: colors.border, backgroundColor: colors.card },
            ]}
            onPress={() => void toggleNetworkContribution()}
            disabled={networkContributionBusy || !networkContribution}
            accessibilityRole="switch"
            accessibilityLabel="Contribute anonymous concept patterns to the Venom network"
            accessibilityState={{
              checked: networkContribution?.enabled === true,
              disabled: networkContributionBusy || !networkContribution,
            }}
          >
            <View style={styles.networkToggleCopy}>
              <Text
                testID="network-contribution-state"
                style={[
                  styles.networkToggleTitle,
                  { color: colors.foreground },
                ]}
              >
                {networkContribution
                  ? networkContribution.enabled
                    ? "Contributing"
                    : "Off"
                  : networkContributionFailed
                    ? "Unavailable"
                    : "Checking…"}
              </Text>
              <Text
                style={[
                  styles.networkToggleCaption,
                  { color: colors.mutedForeground },
                ]}
              >
                {networkContribution?.enabled
                  ? "Anonymous patterns from this account are helping every Brain."
                  : "Nothing is shared until you turn this on."}
              </Text>
            </View>
            {networkContributionBusy ? (
              <ActivityIndicator size="small" color={colors.mutedForeground} />
            ) : (
              <Feather
                name={networkContribution?.enabled ? "check-circle" : "circle"}
                size={20}
                color={
                  networkContribution?.enabled
                    ? colors.primary
                    : colors.mutedForeground
                }
              />
            )}
          </TouchableOpacity>
        </View>

        {/* Billing */}
        <View style={styles.section} testID="settings-billing-section">
          <Text style={[styles.sectionTitle, { color: colors.primary }]}>
            Billing
          </Text>
          <Text
            style={[
              styles.sourceDescription,
              { color: colors.mutedForeground },
            ]}
          >
            Your personal plan covers AI in your personal space. Chats in a
            workspace with an Organization plan bill that workspace instead.
          </Text>
          <View
            style={[
              styles.usageCard,
              { borderColor: colors.border, backgroundColor: colors.card },
            ]}
          >
            {billingLoading ? (
              <View style={styles.usageStateRow} testID="billing-loading">
                <ActivityIndicator
                  size="small"
                  color={colors.mutedForeground}
                />
                <Text
                  style={[
                    styles.usageStateText,
                    { color: colors.mutedForeground },
                  ]}
                >
                  Checking your plan…
                </Text>
              </View>
            ) : billingFailed ? (
              <View testID="billing-error">
                <Text
                  style={[styles.usageStateText, { color: colors.destructive }]}
                >
                  Your plan couldn&rsquo;t be loaded. Check your connection
                  and try again.
                </Text>
                <TouchableOpacity
                  testID="billing-retry"
                  onPress={() => void billingQuery.refetch()}
                  accessibilityRole="button"
                  accessibilityLabel="Retry loading your plan"
                  style={[styles.usageRetry, { borderColor: colors.border }]}
                >
                  <Text
                    style={[
                      styles.usageRetryText,
                      { color: colors.foreground },
                    ]}
                  >
                    Try again
                  </Text>
                </TouchableOpacity>
              </View>
            ) : billingSummary ? (
              <>
                <View style={styles.billingHeaderRow}>
                  <View style={{ flexShrink: 1 }}>
                    <Text
                      testID="billing-plan-name"
                      style={[
                        styles.billingPlanName,
                        { color: colors.foreground },
                      ]}
                    >
                      {billingSummary.plan.name}
                    </Text>
                    <Text
                      testID="billing-renewal"
                      style={[
                        styles.billingPlanMeta,
                        { color: colors.mutedForeground },
                      ]}
                    >
                      {billingSummary.plan.priceUsd > 0
                        ? `$${billingSummary.plan.priceUsd}/mo · `
                        : "Free · "}
                      {billingSummary.cancelAtPeriodEnd
                        ? `ends ${billingDateLabel(billingSummary.periodEnd)}`
                        : billingSummary.renews
                          ? `renews ${billingDateLabel(billingSummary.periodEnd)}`
                          : `allowance resets ${billingDateLabel(billingSummary.periodEnd)}`}
                    </Text>
                  </View>
                  {!billingSummary.configured && (
                    <View
                      style={[
                        styles.billingBadge,
                        { borderColor: colors.border },
                      ]}
                      testID="billing-not-configured"
                    >
                      <Text
                        style={[
                          styles.billingBadgeText,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        Not set up yet
                      </Text>
                    </View>
                  )}
                </View>

                <View
                  style={[
                    styles.billingMeterTrack,
                    { backgroundColor: colors.accent },
                  ]}
                  accessibilityRole="progressbar"
                  accessibilityValue={{
                    min: 0,
                    max: 100,
                    now: Math.round(billingShare * 100),
                  }}
                  accessibilityLabel="Share of included AI used this period"
                  testID="billing-meter"
                >
                  <View
                    style={[
                      styles.billingMeterFill,
                      {
                        backgroundColor:
                          billingSummary.state === "exhausted"
                            ? colors.destructive
                            : colors.foreground,
                        width: `${Math.max(billingShare * 100, 2)}%`,
                      },
                    ]}
                  />
                </View>
                <View style={styles.billingMeterRow}>
                  <Text
                    style={[
                      styles.billingMeterLabel,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    Included AI this period
                  </Text>
                  <Text
                    testID="billing-meter-figures"
                    style={[
                      styles.billingMeterFigures,
                      { color: colors.foreground },
                    ]}
                  >
                    {formatUsdAmount(billingSummary.spentUsd)} of $
                    {billingSummary.plan.allowanceUsd}
                  </Text>
                </View>
                {billingSummary.state === "exhausted" ? (
                  <Text
                    testID="billing-state-exhausted"
                    style={[
                      styles.billingStateText,
                      { color: colors.destructive },
                    ]}
                  >
                    {billingSummary.upgradePlan
                      ? "You've used this period's included AI. Upgrade to keep going, or wait for the reset."
                      : "You've used this period's included AI. It comes back at the reset."}
                  </Text>
                ) : billingSummary.state === "approaching" ? (
                  <Text
                    testID="billing-state-approaching"
                    style={[
                      styles.billingStateText,
                      { color: colors.foreground },
                    ]}
                  >
                    You&rsquo;re close to this period&rsquo;s included AI —{" "}
                    {formatUsdAmount(billingSummary.remainingUsd)} left.
                  </Text>
                ) : null}
                {billingSummary.configured &&
                  (billingSummary.upgradePlan || billingSummary.manageable) && (
                    <View style={styles.billingActionsRow}>
                      {billingSummary.upgradePlan && (
                        <TouchableOpacity
                          testID="billing-upgrade"
                          disabled={billingAction !== null}
                          onPress={() => void openBillingPage("checkout")}
                          accessibilityRole="button"
                          accessibilityLabel={`Upgrade to ${billingSummary.upgradePlan.name}`}
                          style={[
                            styles.billingPrimaryButton,
                            {
                              backgroundColor: colors.foreground,
                              opacity: billingAction ? 0.5 : 1,
                            },
                          ]}
                        >
                          {billingAction === "checkout" ? (
                            <ActivityIndicator
                              size="small"
                              color={colors.background}
                            />
                          ) : (
                            <Text
                              style={[
                                styles.billingPrimaryButtonText,
                                { color: colors.background },
                              ]}
                            >
                              Upgrade to {billingSummary.upgradePlan.name}
                            </Text>
                          )}
                        </TouchableOpacity>
                      )}
                      {billingSummary.manageable && (
                        <TouchableOpacity
                          testID="billing-manage"
                          disabled={billingAction !== null}
                          onPress={() => void openBillingPage("portal")}
                          accessibilityRole="button"
                          accessibilityLabel="Manage billing"
                          style={[
                            styles.billingOutlineButton,
                            {
                              borderColor: colors.border,
                              opacity: billingAction ? 0.5 : 1,
                            },
                          ]}
                        >
                          {billingAction === "portal" ? (
                            <ActivityIndicator
                              size="small"
                              color={colors.foreground}
                            />
                          ) : (
                            <Text
                              style={[
                                styles.billingOutlineButtonText,
                                { color: colors.foreground },
                              ]}
                            >
                              Manage billing
                            </Text>
                          )}
                        </TouchableOpacity>
                      )}
                    </View>
                  )}
                {billingActionError && (
                  <Text
                    style={[
                      styles.billingStateText,
                      { color: colors.destructive },
                    ]}
                  >
                    {billingActionError}
                  </Text>
                )}
              </>
            ) : null}
          </View>
        </View>

        {/* Usage */}
        <View style={styles.section} testID="settings-usage-section">
          <Text style={[styles.sectionTitle, { color: colors.primary }]}>
            Usage
          </Text>
          <Text
            style={[
              styles.sourceDescription,
              { color: colors.mutedForeground },
            ]}
          >
            What your AI activity has cost this month, across your devices.
            Only you can see this.
          </Text>
          <View
            style={[
              styles.usageCard,
              { borderColor: colors.border, backgroundColor: colors.card },
            ]}
          >
            {usageLoading ? (
              <View style={styles.usageStateRow} testID="usage-loading">
                <ActivityIndicator
                  size="small"
                  color={colors.mutedForeground}
                />
                <Text
                  style={[
                    styles.usageStateText,
                    { color: colors.mutedForeground },
                  ]}
                >
                  Adding up this month…
                </Text>
              </View>
            ) : usageFailed ? (
              <View testID="usage-error">
                <Text
                  style={[styles.usageStateText, { color: colors.destructive }]}
                >
                  Your usage couldn&rsquo;t be loaded. Check your connection
                  and try again.
                </Text>
                <TouchableOpacity
                  testID="usage-retry"
                  onPress={() => void usageQuery.refetch()}
                  accessibilityRole="button"
                  accessibilityLabel="Retry loading usage"
                  style={[styles.usageRetry, { borderColor: colors.border }]}
                >
                  <Text
                    style={[
                      styles.usageRetryText,
                      { color: colors.foreground },
                    ]}
                  >
                    Try again
                  </Text>
                </TouchableOpacity>
              </View>
            ) : usageSummary ? (
              <>
                <Text
                  style={[
                    styles.usageMonthLabel,
                    { color: colors.mutedForeground },
                  ]}
                >
                  {usageMonthLabel(usageSummary.periodStart)}
                </Text>
                <Text
                  testID="usage-month-total"
                  style={[styles.usageSpend, { color: colors.foreground }]}
                >
                  {formatUsdAmount(usageSummary.totals.costUsd)}
                </Text>
                <Text
                  testID="usage-requests-total"
                  style={[
                    styles.usageCaption,
                    { color: colors.mutedForeground },
                  ]}
                >
                  {formatCompactCount(usageSummary.totals.requests)}{" "}
                  {usageSummary.totals.requests === 1
                    ? "request"
                    : "requests"}{" "}
                  ·{" "}
                  {formatCompactCount(
                    usageSummary.totals.promptTokens +
                      usageSummary.totals.outputTokens,
                  )}{" "}
                  tokens
                </Text>
                {usageSummary.totals.requests === 0 ? (
                  <Text
                    testID="usage-empty"
                    style={[
                      styles.usageEmptyText,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    Nothing metered yet this month. Costs appear here as soon
                    as Venom answers you.
                  </Text>
                ) : (
                  <>
                    <View
                      style={styles.usageTrendRow}
                      testID="usage-daily-trend"
                      accessibilityLabel="Daily spend this month"
                    >
                      {usageSummary.daily.map((day) => {
                        const share =
                          usageMaxDailyCost > 0
                            ? day.costUsd / usageMaxDailyCost
                            : 0;
                        return (
                          <View
                            key={day.date}
                            testID={`usage-day-${day.date}`}
                            style={[
                              styles.usageTrendBar,
                              {
                                backgroundColor: colors.foreground,
                                opacity: day.costUsd > 0 ? 0.85 : 0.25,
                                height: `${Math.max(
                                  share * 100,
                                  day.costUsd > 0 ? 8 : 4,
                                )}%`,
                              },
                            ]}
                          />
                        );
                      })}
                    </View>
                    {usageSummary.daily.length > 0 && (
                      <View style={styles.usageAxisRow}>
                        <Text
                          style={[
                            styles.usageAxisText,
                            { color: colors.mutedForeground },
                          ]}
                        >
                          {usageDayLabel(usageSummary.daily[0].date)}
                        </Text>
                        {usageSummary.daily.length > 1 && (
                          <Text
                            style={[
                              styles.usageAxisText,
                              { color: colors.mutedForeground },
                            ]}
                          >
                            {usageDayLabel(
                              usageSummary.daily[
                                usageSummary.daily.length - 1
                              ].date,
                            )}
                          </Text>
                        )}
                      </View>
                    )}
                    <View style={styles.usageModels}>
                      {usageSummary.models.map((model) => (
                        <View
                          key={model.modelId}
                          testID={`usage-model-row-${model.modelId}`}
                          style={[
                            styles.usageModelRow,
                            { borderColor: colors.border },
                          ]}
                        >
                          <View style={styles.usageModelCopy}>
                            <Text
                              style={[
                                styles.usageModelName,
                                { color: colors.foreground },
                              ]}
                            >
                              {model.modelName}
                              {model.hasEstimates ? " *" : ""}
                            </Text>
                            <Text
                              style={[
                                styles.usageModelCaption,
                                { color: colors.mutedForeground },
                              ]}
                            >
                              {formatCompactCount(model.requests)}{" "}
                              {model.requests === 1 ? "request" : "requests"}{" "}
                              · {formatCompactCount(model.promptTokens)} in /{" "}
                              {formatCompactCount(model.outputTokens)} out
                            </Text>
                          </View>
                          <Text
                            style={[
                              styles.usageModelCost,
                              { color: colors.foreground },
                            ]}
                          >
                            {formatUsdAmount(model.costUsd)}
                          </Text>
                        </View>
                      ))}
                    </View>
                    {usageSummary.hasEstimates && (
                      <Text
                        testID="usage-estimate-note"
                        style={[
                          styles.usageEstimateNote,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        * Some entries are estimates: a provider didn&rsquo;t
                        report exact token counts (an interrupted reply, for
                        example), or the call was a voice audio leg, metered
                        at a flat per-request rate.
                      </Text>
                    )}
                  </>
                )}
                {(usageSummary.coveredByWorkspaces ?? []).length > 0 && (
                  <Text
                    testID="usage-covered-note"
                    style={[
                      styles.usageCoveredNote,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    Some of your AI activity was covered by{" "}
                    {(usageSummary.coveredByWorkspaces ?? [])
                      .map((workspace) => workspace.name)
                      .join(", ")}
                    . It&rsquo;s billed to{" "}
                    {(usageSummary.coveredByWorkspaces ?? []).length === 1
                      ? "that workspace's plan"
                      : "those workspaces' plans"}{" "}
                    and doesn&rsquo;t count against yours.
                  </Text>
                )}
              </>
            ) : null}
          </View>
        </View>

        {/* Canon — visible only to super admins; the server re-verifies the
            role on every canon call, so this row is purely a doorway. */}
        {identity?.superAdmin === true ? (
          <View style={styles.section} testID="settings-canon-section">
            <Text style={[styles.sectionTitle, { color: colors.primary }]}>
              Canon
            </Text>
            <Text
              style={[
                styles.sourceDescription,
                { color: colors.mutedForeground },
              ]}
            >
              The teachings Venom holds for everyone — browse them by skill,
              see who taught what, edit or retire entries, and manage who can
              teach.
            </Text>
            <TouchableOpacity
              testID="settings-canon-open"
              style={[
                styles.networkToggleRow,
                { borderColor: colors.border, backgroundColor: colors.card },
              ]}
              onPress={() => router.push("/canon" as never)}
              accessibilityRole="button"
              accessibilityLabel="Open Venom's canon"
            >
              <View style={styles.networkToggleCopy}>
                <Text
                  style={[
                    styles.networkToggleTitle,
                    { color: colors.foreground },
                  ]}
                >
                  Venom's canon
                </Text>
                <Text
                  style={[
                    styles.networkToggleCaption,
                    { color: colors.mutedForeground },
                  ]}
                >
                  Curated principles that shape every answer.
                </Text>
              </View>
              <Feather
                name="chevron-right"
                size={20}
                color={colors.mutedForeground}
              />
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Project Sources */}
        <View style={styles.section}>
          <View style={styles.sourceHeading}>
            <View>
              <Text style={[styles.sectionTitle, { color: colors.primary }]}>
                Project sources
              </Text>
              <Text
                style={[
                  styles.projectCaption,
                  { color: colors.mutedForeground },
                ]}
              >
                {activeProject
                  ? activeProject.name
                  : "No project selected"}
              </Text>
            </View>
            <View
              style={[
                styles.sourceCount,
                {
                  borderColor: colors.border,
                  backgroundColor: colors.secondary,
                },
              ]}
            >
              <Text
                style={[styles.sourceCountText, { color: colors.primary }]}
              >
                {projectSources.length}
              </Text>
            </View>
          </View>

          <Text
            style={[
              styles.sourceDescription,
              { color: colors.mutedForeground },
            ]}
          >
            Connected source excerpts are available to chat and become cited
            clusters in the knowledge map.
          </Text>

          {sourceError && (
            <View
              style={[
                styles.sourceError,
                {
                  borderColor: colors.destructive,
                  backgroundColor: colors.card,
                },
              ]}
            >
              <Feather
                name="alert-circle"
                size={15}
                color={colors.destructive}
              />
              <Text
                style={[
                  styles.sourceErrorText,
                  { color: colors.destructive },
                ]}
                accessibilityLiveRegion="polite"
                accessibilityRole="alert"
                testID="source-error"
              >
                {sourceError}
              </Text>
            </View>
          )}

          <View
            style={[
              styles.card,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            {/* GitHub picker */}
            <TouchableOpacity
              style={styles.sourceAction}
              onPress={() => {
                setShowGitHubPicker((value) => !value);
                setSourceError(null);
              }}
              testID="open-github-source-picker"
            >
              <View
                style={[
                  styles.providerIcon,
                  {
                    borderColor: colors.border,
                    backgroundColor: colors.secondary,
                  },
                ]}
              >
                <Feather name="github" size={18} color={colors.foreground} />
              </View>
              <View style={styles.providerCopy}>
                <Text style={[styles.rowTitle, { color: colors.foreground }]}>
                  GitHub
                </Text>
                <Text
                  style={[
                    styles.providerDetail,
                    { color: colors.mutedForeground },
                  ]}
                >
                   Workspace authorization
                </Text>
              </View>
              <Feather
                name={showGitHubPicker ? "chevron-up" : "plus"}
                size={19}
                color={colors.primary}
              />
            </TouchableOpacity>

            {showGitHubPicker && (
              <View
                style={[
                  styles.repositoryPanel,
                  { borderTopColor: colors.border },
                ]}
              >
                <Text
                  style={[
                    styles.panelHint,
                    { color: colors.mutedForeground },
                  ]}
                >
                  Choose a repository to sync its overview, open issues, and
                  pull requests.
                </Text>
                {githubRepositories.isLoading ? (
                  <ActivityIndicator
                    size="small"
                    color={colors.primary}
                    style={styles.repoLoading}
                  />
                ) : githubRepositories.isError ? (
                  <Text
                    style={[
                      styles.panelHint,
                      { color: colors.destructive },
                    ]}
                    accessibilityLiveRegion="polite"
                    accessibilityRole="alert"
                    testID="github-repositories-error"
                  >
                    {describeSourceFailure(
                      githubRepositories.error,
                      "GitHub could not list repositories. Try again.",
                    )}
                  </Text>
                ) : (
                  (githubRepositories.data ?? []).slice(0, 12).map(
                    (repository) => (
                      <TouchableOpacity
                        key={repository.fullName}
                        style={[
                          styles.repositoryRow,
                          { borderColor: colors.border },
                        ]}
                        onPress={() => connectRepository(repository.fullName)}
                        disabled={githubSource.isPending}
                        testID={`connect-github-${repository.fullName}`}
                      >
                        <View style={styles.providerCopy}>
                          <Text
                            style={[
                              styles.repositoryName,
                              { color: colors.foreground },
                            ]}
                          >
                            {repository.fullName}
                          </Text>
                          {repository.description ? (
                            <Text
                              style={[
                                styles.repositoryDescription,
                                { color: colors.mutedForeground },
                              ]}
                              numberOfLines={1}
                            >
                              {repository.description}
                            </Text>
                          ) : null}
                        </View>
                        {githubSource.isPending ? (
                          <ActivityIndicator
                            size="small"
                            color={colors.primary}
                          />
                        ) : (
                          <Feather
                            name="arrow-up-right"
                            size={16}
                            color={colors.primary}
                          />
                        )}
                      </TouchableOpacity>
                    ),
                  )
                )}
              </View>
            )}

            <View
              style={[
                styles.inlineDivider,
                { backgroundColor: colors.border },
              ]}
            />

            {/* Website input */}
            <View style={styles.websitePanel}>
              <View style={styles.websiteLabel}>
                <Feather name="globe" size={17} color={colors.primary} />
                <Text style={[styles.rowTitle, { color: colors.foreground }]}>
                  Public website
                </Text>
              </View>
              <TextInput
                style={[
                  styles.websiteInput,
                  {
                    color: colors.foreground,
                    borderColor: colors.border,
                    backgroundColor: colors.background,
                  },
                ]}
                placeholder="https://example.com"
                placeholderTextColor={colors.mutedForeground}
                value={websiteUrl}
                onChangeText={setWebsiteUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                testID="website-source-url"
              />
              <TouchableOpacity
                style={[
                  styles.websiteButton,
                  {
                    backgroundColor: websiteUrl.trim()
                      ? colors.primary
                      : colors.accent,
                  },
                ]}
                onPress={connectWebsite}
                disabled={!websiteUrl.trim() || websiteSource.isPending}
                testID="connect-website-source"
              >
                {websiteSource.isPending ? (
                  <ActivityIndicator
                    size="small"
                    color={colors.primaryForeground}
                  />
                ) : (
                  <>
                    <Feather
                      name="link"
                      size={16}
                      color={
                        websiteUrl.trim()
                          ? colors.primaryForeground
                          : colors.mutedForeground
                      }
                    />
                    <Text
                      style={[
                        styles.websiteButtonText,
                        {
                          color: websiteUrl.trim()
                            ? colors.primaryForeground
                            : colors.mutedForeground,
                        },
                      ]}
                    >
                       Connect
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>

          {/* Browse the connected sources and their citations */}
          <TouchableOpacity
            ref={(node: FocusableHandle | null) => {
              browseSourcesRef.current = node;
            }}
            style={[
              styles.browseSources,
              { borderColor: colors.border, backgroundColor: colors.card },
            ]}
            onPress={() =>
              router.push({
                pathname: "/knowledge",
                params: { view: "sources" },
              })
            }
            accessibilityRole="button"
            accessibilityLabel="Browse connected sources and their citations"
            activeOpacity={0.7}
            testID="open-connected-sources"
          >
            <Feather name="book-open" size={16} color={colors.primary} />
            <Text
              style={[styles.browseSourcesText, { color: colors.foreground }]}
            >
              Browse sources and citations
            </Text>
            <Feather
              name="chevron-right"
              size={16}
              color={colors.mutedForeground}
            />
          </TouchableOpacity>

          {/* Connected sources list */}
          {projectSources.length > 0 && (
            <View style={styles.connectedSources}>
              <Text
                style={[
                  styles.connectedHeading,
                  { color: colors.mutedForeground },
                ]}
              >
                 Active in this project
              </Text>
              {projectSources.map((source) => {
                const isRefreshing = refreshingSourceId === source.id;
                const refreshError = refreshErrors[source.id];
                return (
                  <View key={source.id}>
                    <View
                      style={[
                        styles.connectedSource,
                        {
                          borderColor: colors.border,
                          backgroundColor: colors.card,
                        },
                      ]}
                    >
                      <View
                        style={[
                          styles.providerIcon,
                          {
                            borderColor: colors.border,
                            backgroundColor: colors.secondary,
                          },
                        ]}
                      >
                        <Feather
                          name={
                            source.provider === "github" ? "github" : "globe"
                          }
                          size={16}
                          color={colors.primary}
                        />
                      </View>
                      <View style={styles.providerCopy}>
                        <Text
                          style={[
                            styles.repositoryName,
                            { color: colors.foreground },
                          ]}
                          numberOfLines={1}
                        >
                          {source.name}
                        </Text>
                        <Text
                          style={[
                            styles.repositoryDescription,
                            { color: colors.mutedForeground },
                          ]}
                          numberOfLines={1}
                          testID={`source-sync-status-${source.id}`}
                        >
                          {isRefreshing
                            ? "Refreshing…"
                            : `${source.citations.length} citations · ${describeLastSync(source.syncedAt, now)}`}
                        </Text>
                      </View>
                      <TouchableOpacity
                        onPress={() => refreshConnectedSource(source)}
                        disabled={refreshingSourceId !== null}
                        accessibilityRole="button"
                        accessibilityLabel={`Refresh ${source.name}`}
                        accessibilityState={{
                          busy: isRefreshing,
                          disabled: refreshingSourceId !== null,
                        }}
                        hitSlop={12}
                        testID={`refresh-source-${source.id}`}
                      >
                        {isRefreshing ? (
                          <ActivityIndicator
                            size="small"
                            color={colors.primary}
                          />
                        ) : (
                          <Feather
                            name="refresh-cw"
                            size={16}
                            color={
                              refreshingSourceId
                                ? colors.border
                                : colors.mutedForeground
                            }
                          />
                        )}
                      </TouchableOpacity>
                      <TouchableOpacity
                        ref={registerRemoveButtonRef(source.id)}
                        onPress={() => requestRemoveSource(source)}
                        disabled={isRefreshing}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${source.name}`}
                        onFocus={() => setFocusedRemoveId(source.id)}
                        onBlur={() =>
                          setFocusedRemoveId((current) =>
                            current === source.id ? null : current,
                          )
                        }
                        style={[
                          styles.removeSourceButton,
                          focusedRemoveId === source.id && {
                            borderColor: colors.destructive,
                          },
                        ]}
                        hitSlop={12}
                        testID={`remove-source-${source.id}`}
                      >
                        <Feather
                          name="x"
                          size={18}
                          color={colors.mutedForeground}
                        />
                      </TouchableOpacity>
                    </View>
                    <View
                      style={styles.scheduleRow}
                      accessibilityRole="radiogroup"
                      accessibilityLabel={`Automatic updates for ${source.name}`}
                    >
                      <Text
                        style={[
                          styles.scheduleStatus,
                          { color: colors.mutedForeground },
                        ]}
                        numberOfLines={1}
                        testID={`source-schedule-status-${source.id}`}
                      >
                        {describeSourceSchedule(source, now) ??
                          "Manual updates only"}
                      </Text>
                      <View style={styles.scheduleOptions}>
                        {SCHEDULE_OPTIONS.map((option) => {
                          const selected =
                            sourceScheduleCadence(source) ===
                            (option.value ?? "off");
                          return (
                            <TouchableOpacity
                              key={option.label}
                              onPress={() =>
                                setSourceSchedule(source.id, option.value)
                              }
                              accessibilityRole="radio"
                              accessibilityLabel={`${option.label} updates for ${source.name}`}
                              accessibilityState={{ checked: selected }}
                              aria-checked={selected}
                              hitSlop={10}
                              testID={`source-schedule-${option.testId}-${source.id}`}
                              style={[
                                styles.scheduleOption,
                                {
                                  borderColor: selected
                                    ? colors.primary
                                    : colors.border,
                                  backgroundColor: selected
                                    ? colors.secondary
                                    : "transparent",
                                },
                              ]}
                            >
                              <Text
                                style={[
                                  styles.scheduleOptionText,
                                  {
                                    color: selected
                                      ? colors.foreground
                                      : colors.mutedForeground,
                                  },
                                ]}
                              >
                                {option.label}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </View>
                    {(refreshError || source.schedule?.lastError) && (
                      <Text
                        style={[
                          styles.refreshError,
                          { color: colors.destructive },
                        ]}
                        accessibilityLiveRegion="polite"
                        accessibilityRole="alert"
                        testID={`source-refresh-error-${source.id}`}
                      >
                        {refreshError ??
                          `Automatic update failed: ${source.schedule?.lastError}`}
                      </Text>
                    )}
                  </View>
                );
              })}
            </View>
          )}
        </View>

        {/* Shared workspaces */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.primary }]}>
            SHARED WORKSPACES
          </Text>
          <TouchableOpacity
            testID="open-shared-workspaces"
            accessibilityRole="button"
            accessibilityLabel="Open shared workspaces"
            style={[
              styles.card,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
            onPress={() => router.push("/workspaces" as never)}
            activeOpacity={0.75}
          >
            <View style={styles.row}>
              <View style={styles.rowLeft}>
                <Feather name="users" size={18} color={colors.mutedForeground} />
                <Text style={[styles.rowTitle, { color: colors.foreground }]}>
                  Shared Workspaces
                </Text>
              </View>
              <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
            </View>
          </TouchableOpacity>
        </View>

        {/* Company */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.primary }]}>
            COMPANY
          </Text>
          <TouchableOpacity
            testID="open-company"
            accessibilityRole="button"
            accessibilityLabel={
              orgInvites.length > 0
                ? `Open company workspaces. ${orgInvites.length} invitation${orgInvites.length === 1 ? "" : "s"} waiting.`
                : orgs.length > 0
                  ? `Open company workspaces. You belong to ${orgs.length}.`
                  : "Open company workspaces to create one or join a team."
            }
            style={[
              styles.card,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
            onPress={() => router.push("/company" as never)}
            activeOpacity={0.75}
          >
            <View style={styles.row}>
              <View style={styles.rowLeft}>
                <Feather name="users" size={18} color={colors.mutedForeground} />
                <Text style={[styles.rowTitle, { color: colors.foreground }]}>
                  Company Brains
                </Text>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                {orgInvites.length > 0 ? (
                  <Text style={[styles.statusText, { color: colors.primary }]}>
                    {orgInvites.length} INVITE{orgInvites.length === 1 ? "" : "S"}
                  </Text>
                ) : orgs.length > 0 ? (
                  <Text style={[styles.statusText, { color: colors.mutedForeground }]}>
                    {orgs.length} JOINED
                  </Text>
                ) : null}
                <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
              </View>
            </View>
          </TouchableOpacity>
        </View>

        {/* Procedures */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.primary }]}>
            PROCEDURES
          </Text>
          <TouchableOpacity
            testID="open-sops"
            accessibilityRole="button"
            accessibilityLabel={`Open procedures library. ${projectSopCount} active for this project.`}
            style={[
              styles.card,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
            onPress={() => router.push("/sops" as never)}
            activeOpacity={0.75}
          >
            <View style={styles.row}>
              <View style={styles.rowLeft}>
                <Feather name="file-text" size={18} color={colors.mutedForeground} />
                <Text style={[styles.rowTitle, { color: colors.foreground }]}>
                  Procedure Library
                </Text>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                {activeProject && (
                  <Text style={[styles.statusText, { color: colors.mutedForeground }]}>
                    {projectSopCount} ACTIVE
                  </Text>
                )}
                <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
              </View>
            </View>
          </TouchableOpacity>
        </View>

        {/* Sign out */}
        <TouchableOpacity
          testID="sign-out"
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          style={[
            styles.signOut,
            { borderColor: colors.border, backgroundColor: colors.card },
          ]}
          activeOpacity={0.7}
          onPress={handleSignOut}
        >
          <Feather name="log-out" size={18} color={colors.foreground} />
          <Text style={[styles.signOutText, { color: colors.foreground }]}>
            Sign out
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Delete all workspace data"
          style={[
            styles.dangerZone,
            {
              borderColor: colors.destructive,
              backgroundColor: colors.card,
            },
          ]}
          activeOpacity={0.7}
        >
          <Feather
            name="alert-triangle"
            size={18}
            color={colors.destructive}
          />
          <Text
            style={[styles.dangerText, { color: colors.destructive }]}
          >
            Delete all data
          </Text>
        </TouchableOpacity>
      </ScrollView>

      <Modal
        transparent
        visible={pendingRemove !== null}
        // On web an animated dismissal keeps the dialog (and its focus trap)
        // mounted while it fades and yanks keyboard focus back into the
        // closing dialog, so it closes immediately there (see
        // app/projects.tsx for the shared pattern).
        animationType={Platform.OS === "web" ? "none" : "fade"}
        onDismiss={handleRemoveDialogDismiss}
        onRequestClose={cancelRemoveSource}
      >
        <Pressable onPress={cancelRemoveSource} style={styles.modalBackdrop}>
          <AnimatedPressable
            onPress={(event) => event.stopPropagation()}
            style={[
              styles.modalCard,
              { backgroundColor: colors.card },
              {
                opacity: dialogAppear,
                transform: [
                  {
                    translateY: dialogAppear.interpolate({
                      inputRange: [0, 1],
                      outputRange: [10, 0],
                    }),
                  },
                ],
              },
            ]}
            accessibilityViewIsModal
            role="alertdialog"
            accessibilityLabel={
              pendingRemove ? `Remove ${pendingRemove.name}?` : undefined
            }
            testID="remove-source-dialog"
          >
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>
              Remove {pendingRemove?.name}?
            </Text>
            <Text
              style={[styles.confirmBody, { color: colors.mutedForeground }]}
            >
              Venom stops drawing on it: its citations and scheduled syncs are
              removed from every synced device. This cannot be undone.
            </Text>
            <View style={styles.modalActions}>
              <TouchableOpacity
                ref={(node: FocusableHandle | null) => {
                  cancelRemoveRef.current = node;
                }}
                accessibilityRole="button"
                onPress={cancelRemoveSource}
                onFocus={() => setCancelRemoveFocused(true)}
                onBlur={() => setCancelRemoveFocused(false)}
                style={[
                  styles.dialogTextButton,
                  cancelRemoveFocused && { borderColor: colors.foreground },
                ]}
                testID="cancel-remove-source"
              >
                <Text
                  style={[styles.cancel, { color: colors.mutedForeground }]}
                >
                  Cancel
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                onPress={confirmRemoveSource}
                onFocus={() => setConfirmRemoveFocused(true)}
                onBlur={() => setConfirmRemoveFocused(false)}
                style={[
                  styles.destructiveButton,
                  { backgroundColor: colors.destructive },
                  // A primary-colored ring is invisible on a filled control;
                  // the background-colored inset ring stays visible on the
                  // destructive fill in both themes.
                  confirmRemoveFocused && { borderColor: colors.background },
                ]}
                testID="confirm-remove-source"
              >
                <Text
                  style={[
                    styles.destructiveText,
                    { color: colors.destructiveForeground },
                  ]}
                >
                  Remove source
                </Text>
              </TouchableOpacity>
            </View>
          </AnimatedPressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16 },
  section: { marginBottom: 34 },
  sectionTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 18,
    letterSpacing: -0.35,
    marginBottom: 14,
    marginLeft: 2,
  },
  card: {
    borderWidth: 1,
    borderRadius: 20,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
  },
  rowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  rowTitle: {
    fontFamily: "Inter_500Medium",
    fontSize: 15,
  },
  accountRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  accountCopy: {
    flex: 1,
  },
  accountEmail: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    marginTop: 4,
  },
  accountIdentity: {
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  accountIdentityHelp: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    lineHeight: 16,
    marginBottom: 6,
  },
  accountIdentityValue: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
  },
  syncCopy: {
    alignItems: "flex-end",
  },
  syncTime: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    marginTop: 3,
  },
  statusText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    letterSpacing: 0,
  },
  divider: {
    height: 1,
    marginLeft: 46,
  },
  sourceHeading: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  projectCaption: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    letterSpacing: 0,
    marginTop: -8,
    marginLeft: 2,
  },
  sourceCount: {
    minWidth: 32,
    height: 28,
    borderWidth: 1,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  sourceCountText: {
    fontFamily: "Inter_700Bold",
    fontSize: 13,
  },
  sourceDescription: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 12,
  },
  networkToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderRadius: 20,
    padding: 14,
  },
  networkToggleCopy: { flex: 1, gap: 3 },
  networkToggleTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14.5,
  },
  networkToggleCaption: {
    fontFamily: "Inter_400Regular",
    fontSize: 12.5,
    lineHeight: 18,
  },
  usageCard: {
    borderWidth: 1,
    borderRadius: 20,
    padding: 16,
  },
  billingHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  billingPlanName: {
    fontFamily: "Inter_700Bold",
    fontSize: 22,
    letterSpacing: -0.5,
  },
  billingPlanMeta: {
    fontFamily: "Inter_400Regular",
    fontSize: 12.5,
    lineHeight: 18,
    marginTop: 3,
  },
  billingBadge: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  billingBadgeText: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
  },
  billingMeterTrack: {
    height: 8,
    borderRadius: 999,
    overflow: "hidden",
    marginTop: 14,
  },
  billingMeterFill: {
    height: "100%",
    borderRadius: 999,
  },
  billingMeterRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginTop: 6,
  },
  billingMeterLabel: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
  },
  billingMeterFigures: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12.5,
    fontVariant: ["tabular-nums"],
  },
  billingStateText: {
    fontFamily: "Inter_500Medium",
    fontSize: 12.5,
    lineHeight: 18,
    marginTop: 10,
  },
  billingActionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 14,
  },
  billingPrimaryButton: {
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  billingPrimaryButtonText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  billingOutlineButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  billingOutlineButtonText: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  usageCoveredNote: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 17,
    marginTop: 12,
  },
  usageStateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  usageStateText: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 19,
    flexShrink: 1,
  },
  usageRetry: {
    alignSelf: "flex-start",
    marginTop: 12,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  usageRetryText: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  usageMonthLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    letterSpacing: 1.1,
    textTransform: "uppercase",
  },
  usageSpend: {
    fontFamily: "Inter_700Bold",
    fontSize: 32,
    letterSpacing: -0.8,
    marginTop: 4,
    fontVariant: ["tabular-nums"],
  },
  usageCaption: {
    fontFamily: "Inter_400Regular",
    fontSize: 12.5,
    lineHeight: 18,
    marginTop: 2,
  },
  usageEmptyText: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 19,
    marginTop: 12,
  },
  usageTrendRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 3,
    height: 64,
    marginTop: 16,
  },
  usageTrendBar: {
    flex: 1,
    minWidth: 6,
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
  },
  usageAxisRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4,
  },
  usageAxisText: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
  },
  usageModels: {
    marginTop: 14,
    gap: 8,
  },
  usageModelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  usageModelCopy: { flex: 1, gap: 2 },
  usageModelName: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  usageModelCaption: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 17,
  },
  usageModelCost: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    fontVariant: ["tabular-nums"],
  },
  usageEstimateNote: {
    fontFamily: "Inter_400Regular",
    fontSize: 11.5,
    lineHeight: 17,
    marginTop: 12,
  },
  sourceError: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 14,
    padding: 10,
    marginBottom: 12,
  },
  sourceErrorText: {
    flex: 1,
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    lineHeight: 17,
  },
  sourceAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
  },
  providerIcon: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: 12,
  },
  providerCopy: {
    flex: 1,
  },
  providerDetail: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    letterSpacing: 0,
    marginTop: 3,
  },
  repositoryPanel: {
    borderTopWidth: 1,
    padding: 14,
    gap: 10,
  },
  panelHint: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 18,
  },
  repoLoading: {
    marginVertical: 14,
  },
  repositoryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderRadius: 14,
    padding: 10,
  },
  repositoryName: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  repositoryDescription: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    marginTop: 3,
  },
  inlineDivider: {
    height: 1,
  },
  websitePanel: {
    padding: 14,
  },
  websiteLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    marginBottom: 10,
  },
  websiteInput: {
    height: 42,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
  },
  websiteButton: {
    minHeight: 46,
    borderRadius: 14,
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  websiteButtonText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    letterSpacing: 0,
  },
  browseSources: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderRadius: 18,
  },
  browseSourcesText: {
    flex: 1,
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    letterSpacing: -0.2,
  },
  connectedSources: {
    marginTop: 16,
    gap: 8,
  },
  connectedHeading: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    letterSpacing: 0,
    marginLeft: 2,
  },
  connectedSource: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderRadius: 14,
    padding: 10,
  },
  scheduleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginTop: 6,
    marginLeft: 12,
  },
  scheduleStatus: {
    flexShrink: 1,
    fontFamily: "Inter_400Regular",
    fontSize: 11,
  },
  scheduleOptions: {
    flexDirection: "row",
    gap: 6,
  },
  scheduleOption: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  scheduleOptionText: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
  },
  // The remove control carries an always-on transparent border so gaining a
  // focus ring never shifts the row's layout.
  removeSourceButton: {
    alignItems: "center",
    borderColor: "transparent",
    borderRadius: 12,
    borderWidth: 2,
    justifyContent: "center",
    padding: 3,
  },
  modalBackdrop: {
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.58)",
    flex: 1,
    justifyContent: "center",
    padding: 20,
  },
  modalCard: { borderRadius: 26, padding: 22, width: "100%", maxWidth: 440 },
  modalTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 20,
    marginBottom: 18,
  },
  confirmBody: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 6,
  },
  modalActions: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 8,
    gap: 22,
  },
  cancel: { fontFamily: "Inter_500Medium", fontSize: 14 },
  // Dialog action buttons carry an always-on transparent border so gaining
  // a focus ring never shifts layout.
  dialogTextButton: {
    borderColor: "transparent",
    borderRadius: 12,
    borderWidth: 2,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 10,
  },
  destructiveButton: {
    borderColor: "transparent",
    borderRadius: 14,
    borderWidth: 2,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 18,
  },
  destructiveText: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
  refreshError: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 16,
    marginTop: 4,
    marginLeft: 12,
  },
  modelLoading: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 24,
  },
  modelRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    gap: 12,
  },
  modelLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  modelIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  modelCopy: {
    flex: 1,
  },
  modelNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  modelName: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  modelBadge: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  modelBadgeText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
    letterSpacing: 0.2,
  },
  policyRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  policyRadio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  policyCopy: {
    flex: 1,
    gap: 3,
  },
  policyDescription: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 17,
  },
  policyTakeover: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 10,
  },
  policyTakeoverText: {
    flex: 1,
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 17,
  },
  modelAvailability: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    marginTop: 2,
  },
  modelActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  modelActionButton: {
    width: 28,
    height: 28,
    borderRadius: 9,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  signOut: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
  },
  signOutText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    letterSpacing: 0,
  },
  dangerZone: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1,
    padding: 16,
    borderRadius: 16,
  },
  dangerText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    letterSpacing: 0,
  },
});

const SCHEDULE_OPTIONS: Array<{
  value: SourceScheduleCadence | null;
  label: string;
  testId: string;
}> = [
  { value: null, label: "Off", testId: "off" },
  ...SOURCE_SCHEDULE_CADENCES.map((cadence) => ({
    value: cadence,
    label: SOURCE_SCHEDULE_CADENCE_LABELS[cadence],
    testId: cadence,
  })),
];

const UI_TEST_USAGE_SUMMARY: VenomUsageSummary = {
  periodStart: "2026-08-01",
  periodEnd: "2026-09-01",
  totals: {
    costUsd: 1.86,
    requests: 42,
    promptTokens: 96_000,
    outputTokens: 31_000,
  },
  hasEstimates: true,
  daily: [
    { date: "2026-08-14", costUsd: 0.22, requests: 6 },
    { date: "2026-08-15", costUsd: 0.91, requests: 18 },
    { date: "2026-08-16", costUsd: 0.05, requests: 3 },
    { date: "2026-08-18", costUsd: 0.68, requests: 15 },
  ],
  models: [
    {
      modelId: "venom-gpt",
      modelName: "Venom GPT",
      costUsd: 1.24,
      requests: 26,
      promptTokens: 70_000,
      outputTokens: 22_000,
      hasEstimates: false,
    },
    {
      modelId: "venom-claude",
      modelName: "Venom Claude",
      costUsd: 0.57,
      requests: 12,
      promptTokens: 26_000,
      outputTokens: 9_000,
      hasEstimates: true,
    },
    {
      modelId: "venom-voice",
      modelName: "Venom Voice",
      costUsd: 0.05,
      requests: 4,
      promptTokens: 0,
      outputTokens: 0,
      hasEstimates: true,
    },
  ],
  coveredByWorkspaces: [
    { id: "6b1de5f2-9c1a-4a41-8f7e-2b6a5c9d0e33", name: "Design Guild" },
  ],
};

const UI_TEST_BILLING_SUMMARY: VenomBillingSummary = {
  configured: true,
  enforced: true,
  plan: { id: "free", name: "Free", priceUsd: 0, allowanceUsd: 5 },
  status: "none",
  cancelAtPeriodEnd: false,
  periodStart: "2026-08-01T00:00:00.000Z",
  periodEnd: "2026-09-01T00:00:00.000Z",
  renews: false,
  spentUsd: 1.86,
  remainingUsd: 3.14,
  state: "ok",
  upgradePlan: {
    id: "plus",
    name: "Venom Plus",
    priceUsd: 15,
    allowanceUsd: 50,
  },
  manageable: false,
};
function usageDayLabel(date: string): string {
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const name = USAGE_MONTHS[month - 1];
  return name && Number.isFinite(day) && day > 0
    ? `${name.slice(0, 3)} ${day}`
    : date;
}

function usageMonthLabel(periodStart: string): string {
  const month = Number(periodStart.slice(5, 7));
  const year = periodStart.slice(0, 4);
  const name = USAGE_MONTHS[month - 1];
  return name ? `${name} ${year}` : "This month";
}

/** ISO timestamp → "September 1, 2026" for plan renewal/reset lines. */
function billingDateLabel(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "next period";
  const month = USAGE_MONTHS[parsed.getUTCMonth()];
  return month
    ? `${month} ${parsed.getUTCDate()}, ${parsed.getUTCFullYear()}`
    : "next period";
}
/** Compact token/request counts: 940, 12.4k, 3.1M. */
function formatCompactCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) {
    const k = value / 1_000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
  }
  const m = value / 1_000_000;
  return `${m >= 100 ? Math.round(m) : m.toFixed(1)}M`;
}

/** Dollar display: exact to the cent, honest about dust. */
function formatUsdAmount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}
