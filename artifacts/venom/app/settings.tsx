import React from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Switch,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useClerk, useUser } from "@clerk/expo";
import { useRouter } from "expo-router";
import {
  useHealthCheck,
  useGetGitHubRepositories,
  useConnectGitHubSource,
  useConnectWebsiteSource,
  useGetVenomIdentity,
  getGetVenomIdentityQueryKey,
  useGetVenomModels,
  useGetVenomVoices,
  useListVenomProjectSops,
  getListVenomProjectSopsQueryKey,
  type VenomManagedModel,
} from "@workspace/api-client-react";

import { useColors } from "@/hooks/useColors";
import { Header } from "@/components/Header";
import { VoicePresetList } from "@/components/voice/VoicePresetList";
import { useVoiceSample } from "@/hooks/useVoiceSample";
import {
  useVenom,
  type ProjectSource,
  type VenomModelId,
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
    setVoicePreset,
    setVoiceTalkativeness,
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

  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const modelPreferences = state.modelPreferences;
  const enabledModelIds = modelPreferences?.enabledModelIds ?? ["venom-gpt"];
  const defaultModelId = modelPreferences?.defaultModelId ?? "venom-gpt";

  const modelsQuery = useGetVenomModels({
    query: {
      queryKey: ["venom-models"],
      staleTime: 5 * 60 * 1000,
    },
  });

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
  // Clerk client profile fills in while it loads or offline.
  const { data: identity } = useGetVenomIdentity({
    query: {
      queryKey: getGetVenomIdentityQueryKey(),
      enabled: Boolean(user?.id),
      staleTime: 5 * 60_000,
      retry: 1,
    },
  });
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
                            </View>
                            <Text
                              style={[
                                styles.modelAvailability,
                                {
                                  color: model.available
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
                              style={[
                                styles.modelActionButton,
                                { borderColor: colors.border },
                              ]}
                              accessibilityRole="button"
                              accessibilityLabel={`Set ${model.name} as default`}
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
                              (!isEnabled && !model.available)
                            }
                            style={[
                              styles.modelActionButton,
                              {
                                borderColor: isEnabled
                                  ? colors.destructive
                                  : colors.border,
                                opacity:
                                  (isOnlyEnabled && isEnabled) ||
                                  (!isEnabled && !model.available)
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
                                (!isEnabled && !model.available),
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

        {/* Sync and privacy */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.primary }]}>
            Sync
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
                  name="eye"
                  size={18}
                  color={colors.mutedForeground}
                />
                <Text style={[styles.rowTitle, { color: colors.foreground }]}>
                   Private workspace
                </Text>
              </View>
              <Switch
                value={true}
                onValueChange={() => {}}
                accessibilityLabel="Private workspace"
                trackColor={{ false: colors.accent, true: colors.primary }}
                thumbColor={colors.background}
              />
            </View>
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
                        onPress={() => removeSource(source.id)}
                        disabled={isRefreshing}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${source.name}`}
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
