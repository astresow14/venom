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
} from "@workspace/api-client-react";

import { useColors } from "@/hooks/useColors";
import { Header } from "@/components/Header";
import { useVenom, type ProjectSource } from "@/context/VenomContext";
import {
  describeLastSync,
  sourceRefreshRequest,
} from "@/context/sourceState";

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
    removeSource,
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

  const { data: health, isError } = useHealthCheck();
  const isConnected = !!health && !isError;

  const activeProject = state.projects.find(
    (project) => project.id === state.activeProjectId,
  );
  const projectSources = (state.sources ?? []).filter(
    (source) => source.projectId === activeProject?.id,
  );

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
      onError: (error: Error) => setSourceError(error.message),
    },
  });

  const websiteSource = useConnectWebsiteSource({
    mutation: {
      onSuccess: (source) => {
        addSource(source);
        setWebsiteUrl("");
        setSourceError(null);
      },
      onError: (error: Error) => setSourceError(error.message),
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
      failRefresh(target, error.message);
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
  const accountLabel =
    user?.primaryEmailAddress?.emailAddress ?? "Authenticated account";

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
                >
                  Signed in
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

        {/* Model Configuration */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.primary }]}>
            Model and sync
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
                  name="cpu"
                  size={18}
                  color={colors.mutedForeground}
                />
                <Text style={[styles.rowTitle, { color: colors.foreground }]}>
                   Default model
                </Text>
              </View>
              <Text style={[styles.statusText, { color: colors.primary }]}>
                GPT-5.1
              </Text>
            </View>
            <View
              style={[styles.divider, { backgroundColor: colors.border }]}
            />
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
                  >
                    GitHub could not list repositories. Try again.
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
                    {refreshError && (
                      <Text
                        style={[
                          styles.refreshError,
                          { color: colors.destructive },
                        ]}
                        accessibilityLiveRegion="polite"
                        accessibilityRole="alert"
                        testID={`source-refresh-error-${source.id}`}
                      >
                        {refreshError}
                      </Text>
                    )}
                  </View>
                );
              })}
            </View>
          )}
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
  refreshError: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 16,
    marginTop: 4,
    marginLeft: 12,
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
