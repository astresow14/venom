import React, { useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Modal,
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
import {
  getGetVenomAppQueryKey,
  getListVenomAppsQueryKey,
  useCompleteVenomAppImportUpload,
  useCreateVenomApp,
  useCreateVenomAppImport,
  useGetVenomApp,
  useListVenomApps,
  useRetryVenomAppImport,
  type VenomImportJob,
} from "@workspace/api-client-react";

import { Header } from "@/components/Header";
import { useColors } from "@/hooks/useColors";

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

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
    : "Something went wrong. Please try again.";
}

export default function AppsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [selectedAppId, setSelectedAppId] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [brand, setBrand] = useState("");
  const [deploymentUrl, setDeploymentUrl] = useState("");
  const [localStatus, setLocalStatus] = useState("");
  const [error, setError] = useState("");
  const lastAssetRef = useRef<DocumentPicker.DocumentPickerAsset | null>(null);

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

  const detail = detailQuery.data;
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
    await queryClient.invalidateQueries({
      queryKey: getListVenomAppsQueryKey(),
    });
    if (appId) {
      await queryClient.invalidateQueries({
        queryKey: getGetVenomAppQueryKey(appId),
      });
    }
  };

  const handleCreate = async () => {
    if (!name.trim() || !purpose.trim() || !brand.trim()) return;
    setError("");
    try {
      const created = await createApp.mutateAsync({
        data: {
          name: name.trim(),
          purpose: purpose.trim(),
          brand: brand.trim(),
          deploymentUrl: deploymentUrl.trim() || null,
        },
      });
      setName("");
      setPurpose("");
      setBrand("");
      setDeploymentUrl("");
      setIsCreating(false);
      setSelectedAppId(created.id);
      await refresh(created.id);
    } catch (nextError) {
      setError(errorMessage(nextError));
    }
  };

  const uploadAsset = async (
    appId: string,
    asset: DocumentPicker.DocumentPickerAsset,
    retryJob?: VenomImportJob,
  ) => {
    const size = asset.size ?? 0;
    if (!asset.name.toLowerCase().endsWith(".zip")) {
      setError("Choose a ZIP archive.");
      return;
    }
    if (size < 1 || size > MAX_ARCHIVE_BYTES) {
      setError("ZIP archives must be 50 MB or smaller.");
      return;
    }
    if (
      retryJob &&
      (asset.name !== retryJob.archiveFilename ||
        size !== retryJob.declaredBytes)
    ) {
      setError("Choose the same ZIP file used by this failed import.");
      return;
    }

    setError("");
    setLocalStatus("Preparing secure upload");
    lastAssetRef.current = asset;
    try {
      const ticket = retryJob
        ? await retryImport.mutateAsync({
            appId,
            importJobId: retryJob.id,
          })
        : await createImport.mutateAsync({
            appId,
            data: {
              filename: asset.name,
              size,
              idempotencyKey: Crypto.randomUUID().replaceAll("-", "_"),
            },
          });

      setLocalStatus("Uploading private source package");
      const fileResponse = await fetch(asset.uri);
      const blob = await fileResponse.blob();
      const uploadResponse = await fetch(ticket.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": ticket.requiredContentType },
        body: blob,
      });
      if (!uploadResponse.ok) {
        throw new Error("The archive upload did not complete.");
      }

      setLocalStatus("Validating archive");
      await completeImport.mutateAsync({
        appId,
        importJobId: ticket.job.id,
      });
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
    const result = await DocumentPicker.getDocumentAsync({
      type: ["application/zip", "application/x-zip-compressed"],
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (!result.canceled) {
      await uploadAsset(selectedAppId, result.assets[0], retryJob);
    }
  };

  const retryFailedJob = async (job: VenomImportJob) => {
    if (!lastAssetRef.current) {
      setError("Choose the same ZIP again to retry this import.");
      await pickArchive(job);
      return;
    }
    await uploadAsset(selectedAppId, lastAssetRef.current, job);
  };

  const currentStatus =
    localStatus ||
    (activeJob
      ? `${statusLabel(activeJob.status)} · ${activeJob.progress}%`
      : "");

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Header title="App Portfolio" showBack />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 40 },
        ]}
      >
        <View style={styles.heading}>
          <View style={styles.headingCopy}>
            <Text style={[styles.eyebrow, { color: colors.mutedForeground }]}>
              CONTROL PLANE
            </Text>
            <Text style={[styles.title, { color: colors.foreground }]}>
              Products in motion
            </Text>
          </View>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Create app record"
            onPress={() => setIsCreating(true)}
            style={[styles.createButton, { backgroundColor: colors.foreground }]}
            testID="create-app"
          >
            <Feather name="plus" color={colors.background} size={18} />
          </TouchableOpacity>
        </View>

        {appsQuery.isLoading ? (
          <View
            accessible
            accessibilityLabel="Loading app portfolio"
            style={styles.loading}
          >
            <ActivityIndicator color={colors.foreground} />
          </View>
        ) : appsQuery.isError ? (
          <View style={[styles.empty, { borderColor: colors.border }]}>
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
              Portfolio unavailable
            </Text>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => appsQuery.refetch()}
            >
              <Text style={[styles.actionText, { color: colors.foreground }]}>
                Try again
              </Text>
            </TouchableOpacity>
          </View>
        ) : appsQuery.data?.length ? (
          <View style={styles.list}>
            {appsQuery.data.map((app) => {
              const selected = selectedAppId === app.id;
              return (
                <TouchableOpacity
                  key={app.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Open ${app.name}, ${statusLabel(app.status)}, source version ${app.sourceVersion}`}
                  onPress={() => setSelectedAppId(app.id)}
                  style={[
                    styles.appCard,
                    {
                      backgroundColor: selected
                        ? colors.foreground
                        : colors.card,
                      borderColor: selected
                        ? colors.foreground
                        : colors.border,
                    },
                  ]}
                  testID={`portfolio-app-${app.id}`}
                >
                  <View style={styles.cardTop}>
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.appName,
                        {
                          color: selected
                            ? colors.background
                            : colors.foreground,
                        },
                      ]}
                    >
                      {app.name}
                    </Text>
                    <Text
                      style={[
                        styles.status,
                        {
                          color: selected
                            ? colors.background
                            : colors.mutedForeground,
                        },
                      ]}
                    >
                      {statusLabel(app.importStatus ?? app.status)}
                    </Text>
                  </View>
                  <Text
                    numberOfLines={2}
                    style={[
                      styles.purpose,
                      {
                        color: selected
                          ? colors.background
                          : colors.mutedForeground,
                      },
                    ]}
                  >
                    {app.purpose}
                  </Text>
                  <Text
                    style={[
                      styles.meta,
                      {
                        color: selected
                          ? colors.background
                          : colors.mutedForeground,
                      },
                    ]}
                  >
                    {app.brand} · {app.sourceType} · v{app.sourceVersion}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ) : (
          <View style={[styles.empty, { borderColor: colors.border }]}>
            <Feather name="box" size={28} color={colors.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
              No products registered
            </Text>
            <Text style={[styles.emptyCopy, { color: colors.mutedForeground }]}>
              Create an app record, then hand off a private ZIP when the source
              is ready.
            </Text>
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
                    <Text style={[styles.detailTitle, { color: colors.foreground }]}>
                      {detail.app.name}
                    </Text>
                    <Text style={[styles.detailMeta, { color: colors.mutedForeground }]}>
                      {detail.app.brand} · {statusLabel(detail.app.status)}
                    </Text>
                  </View>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Close app detail"
                    onPress={() => setSelectedAppId("")}
                    hitSlop={12}
                  >
                    <Feather name="x" size={20} color={colors.foreground} />
                  </TouchableOpacity>
                </View>

                {detail.app.detectedStack.length > 0 ? (
                  <View style={styles.stack}>
                    {detail.app.detectedStack.map((item) => (
                      <Text
                        key={item}
                        style={[
                          styles.stackChip,
                          {
                            borderColor: colors.border,
                            color: colors.foreground,
                          },
                        ]}
                      >
                        {item}
                      </Text>
                    ))}
                  </View>
                ) : null}

                {currentStatus ? (
                  <View
                    accessibilityLiveRegion="polite"
                    accessible
                    accessibilityLabel={`Import status ${currentStatus}`}
                    style={[
                      styles.progressPanel,
                      { backgroundColor: colors.secondary },
                    ]}
                  >
                    <ActivityIndicator size="small" color={colors.foreground} />
                    <Text style={[styles.progressText, { color: colors.foreground }]}>
                      {currentStatus}
                    </Text>
                  </View>
                ) : null}

                {error ? (
                  <Text
                    accessibilityLiveRegion="assertive"
                    style={[styles.error, { color: colors.foreground }]}
                  >
                    {error}
                  </Text>
                ) : null}

                <View style={styles.actions}>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={`Upload a new ZIP version for ${detail.app.name}`}
                    disabled={Boolean(activeJob) || Boolean(localStatus)}
                    onPress={() => pickArchive()}
                    style={[
                      styles.primaryAction,
                      {
                        backgroundColor: colors.foreground,
                        opacity: activeJob || localStatus ? 0.5 : 1,
                      },
                    ]}
                    testID="upload-app-zip"
                  >
                    <Feather name="upload" size={16} color={colors.background} />
                    <Text style={[styles.primaryActionText, { color: colors.background }]}>
                      Upload ZIP
                    </Text>
                  </TouchableOpacity>
                  {detail.app.deploymentUrl ? (
                    <TouchableOpacity
                      accessibilityRole="link"
                      accessibilityLabel={`Open deployment for ${detail.app.name}`}
                      onPress={() => Linking.openURL(detail.app.deploymentUrl!)}
                      style={[
                        styles.secondaryAction,
                        { borderColor: colors.border },
                      ]}
                    >
                      <Feather
                        name="external-link"
                        size={16}
                        color={colors.foreground}
                      />
                      <Text style={[styles.secondaryActionText, { color: colors.foreground }]}>
                        Launch
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                </View>

                <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
                  SOURCE HISTORY
                </Text>
                {detail.versions.length ? (
                  detail.versions.map((version) => (
                    <View
                      key={version.id}
                      style={[styles.versionRow, { borderColor: colors.border }]}
                    >
                      <View>
                        <Text style={[styles.versionTitle, { color: colors.foreground }]}>
                          Version {version.versionNumber}
                        </Text>
                        <Text style={[styles.versionMeta, { color: colors.mutedForeground }]}>
                          {version.archiveFilename} · {formatBytes(version.archiveBytes)}
                        </Text>
                      </View>
                      <Text style={[styles.versionStack, { color: colors.mutedForeground }]}>
                        {version.manifest.detectedStack.slice(0, 2).join(" · ") ||
                          "Stack pending"}
                      </Text>
                    </View>
                  ))
                ) : (
                  <Text style={[styles.emptyCopy, { color: colors.mutedForeground }]}>
                    No source package has been accepted yet.
                  </Text>
                )}

                {detail.importJobs
                  .filter((job) => job.status === "failed")
                  .slice(0, 1)
                  .map((job) => (
                    <View
                      key={job.id}
                      style={[styles.failure, { borderColor: colors.border }]}
                    >
                      <Text style={[styles.versionTitle, { color: colors.foreground }]}>
                        Import needs attention
                      </Text>
                      <Text style={[styles.emptyCopy, { color: colors.mutedForeground }]}>
                        {job.failureMessage}
                      </Text>
                      <TouchableOpacity
                        accessibilityRole="button"
                        onPress={() => retryFailedJob(job)}
                      >
                        <Text style={[styles.actionText, { color: colors.foreground }]}>
                          Retry same file
                        </Text>
                      </TouchableOpacity>
                    </View>
                  ))}
              </>
            )}
          </View>
        ) : null}
      </ScrollView>

      <Modal transparent visible={isCreating} animationType="fade">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close create app dialog"
          onPress={() => setIsCreating(false)}
          style={styles.modalBackdrop}
        >
          <Pressable
            accessibilityViewIsModal
            onPress={(event) => event.stopPropagation()}
            style={[styles.modalCard, { backgroundColor: colors.card }]}
          >
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>
              Register product
            </Text>
            {[
              ["Product name", name, setName, "app-name"],
              ["Purpose", purpose, setPurpose, "app-purpose"],
              ["Brand", brand, setBrand, "app-brand"],
              [
                "Deployment URL (optional)",
                deploymentUrl,
                setDeploymentUrl,
                "app-deployment-url",
              ],
            ].map(([placeholder, value, onChange, testID]) => (
              <TextInput
                key={testID as string}
                accessibilityLabel={placeholder as string}
                value={value as string}
                onChangeText={onChange as (value: string) => void}
                placeholder={placeholder as string}
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize={
                  testID === "app-deployment-url" ? "none" : "sentences"
                }
                keyboardType={
                  testID === "app-deployment-url" ? "url" : "default"
                }
                style={[
                  styles.input,
                  {
                    borderColor: colors.border,
                    color: colors.foreground,
                    backgroundColor: colors.background,
                  },
                ]}
                testID={testID as string}
              />
            ))}
            {error ? (
              <Text
                accessibilityLiveRegion="assertive"
                style={[styles.error, { color: colors.foreground }]}
              >
                {error}
              </Text>
            ) : null}
            <View style={styles.modalActions}>
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => setIsCreating(false)}
              >
                <Text style={[styles.cancel, { color: colors.mutedForeground }]}>
                  Cancel
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                disabled={
                  !name.trim() ||
                  !purpose.trim() ||
                  !brand.trim() ||
                  createApp.isPending
                }
                onPress={handleCreate}
                style={[
                  styles.saveButton,
                  {
                    backgroundColor: colors.foreground,
                    opacity:
                      !name.trim() || !purpose.trim() || !brand.trim() ? 0.45 : 1,
                  },
                ]}
                testID="save-app"
              >
                <Text style={[styles.saveText, { color: colors.background }]}>
                  {createApp.isPending ? "Creating…" : "Create"}
                </Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
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
  eyebrow: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    letterSpacing: 1.3,
    marginBottom: 7,
  },
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
    fontFamily: "Inter_500Medium",
    fontSize: 11,
    overflow: "hidden",
    paddingHorizontal: 10,
    paddingVertical: 6,
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