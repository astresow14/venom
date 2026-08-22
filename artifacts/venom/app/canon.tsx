import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useAuth } from "@clerk/expo";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  getGetVenomIdentityQueryKey,
  getListVenomCanonAdminsQueryKey,
  getListVenomCanonTeachingsQueryKey,
  grantVenomCanonAdmin,
  revokeVenomCanonAdmin,
  updateVenomCanonTeaching,
  useGetVenomIdentity,
  useListVenomCanonAdmins,
  useListVenomCanonTeachings,
  type VenomCanonTeaching,
} from "@workspace/api-client-react";
import { IS_UI_TEST, UI_TEST_USER_ID } from "@/context/VenomContext";
import { useColors } from "@/hooks/useColors";

/**
 * The canon: Venom's curated global teaching tier, visible only to super
 * admins. Everything here is doorway and stewardship UI — the server
 * re-verifies the role on every request, refuses outsiders opaquely, and is
 * the only place the role can actually be exercised.
 */
export default function CanonScreen() {
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { userId: authenticatedUserId } = useAuth();
  const myUserId = IS_UI_TEST ? UI_TEST_USER_ID : (authenticatedUserId ?? null);

  const { data: identity, isLoading: identityLoading } = useGetVenomIdentity({
    query: {
      queryKey: getGetVenomIdentityQueryKey(),
      enabled: Boolean(myUserId),
      staleTime: 5 * 60_000,
      retry: 1,
    },
  });
  const isAdmin = identity?.superAdmin === true;

  const teachingsQuery = useListVenomCanonTeachings({
    query: {
      queryKey: getListVenomCanonTeachingsQueryKey(),
      enabled: isAdmin,
      retry: 1,
    },
  });
  const adminsQuery = useListVenomCanonAdmins({
    query: {
      queryKey: getListVenomCanonAdminsQueryKey(),
      enabled: isAdmin,
      retry: 1,
    },
  });

  const [editing, setEditing] = useState<VenomCanonTeaching | null>(null);
  const [editDomain, setEditDomain] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editPrinciples, setEditPrinciples] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [statusBusyId, setStatusBusyId] = useState<string | null>(null);
  const [grantUserId, setGrantUserId] = useState("");
  const [grantBusy, setGrantBusy] = useState(false);
  const [revokeBusyId, setRevokeBusyId] = useState<string | null>(null);

  const teachings = teachingsQuery.data ?? [];
  const byDomain = useMemo(() => {
    const groups = new Map<string, VenomCanonTeaching[]>();
    for (const teaching of teachings) {
      const list = groups.get(teaching.domain) ?? [];
      list.push(teaching);
      groups.set(teaching.domain, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [teachings]);

  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: getListVenomCanonTeachingsQueryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: getListVenomCanonAdminsQueryKey(),
    });
  };

  const openEdit = (teaching: VenomCanonTeaching) => {
    setEditing(teaching);
    setEditDomain(teaching.domain);
    setEditTitle(teaching.title);
    setEditPrinciples(teaching.principles.join("\n"));
  };

  const saveEdit = async () => {
    if (!editing || editBusy) return;
    const principles = editPrinciples
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (!editDomain.trim() || !editTitle.trim() || principles.length === 0) {
      Alert.alert(
        "Incomplete",
        "A teaching needs a domain, a title, and at least one principle.",
      );
      return;
    }
    setEditBusy(true);
    try {
      await updateVenomCanonTeaching(editing.id, {
        domain: editDomain.trim(),
        title: editTitle.trim(),
        principles,
      });
      setEditing(null);
      refresh();
    } catch {
      Alert.alert("Couldn't save", "The teaching wasn't changed. Try again.");
    } finally {
      setEditBusy(false);
    }
  };

  const toggleStatus = async (teaching: VenomCanonTeaching) => {
    if (statusBusyId) return;
    setStatusBusyId(teaching.id);
    try {
      await updateVenomCanonTeaching(teaching.id, {
        status: teaching.status === "active" ? "retired" : "active",
      });
      refresh();
    } catch {
      Alert.alert(
        "Couldn't update",
        "The teaching's status wasn't changed. Try again.",
      );
    } finally {
      setStatusBusyId(null);
    }
  };

  const grant = async () => {
    const target = grantUserId.trim();
    if (!target || grantBusy) return;
    setGrantBusy(true);
    try {
      await grantVenomCanonAdmin({ userId: target });
      setGrantUserId("");
      refresh();
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      Alert.alert(
        "Couldn't grant",
        status === 400
          ? "No account with that id exists."
          : status === 409
            ? "That account is already a super admin."
            : "The role wasn't granted. Try again.",
      );
    } finally {
      setGrantBusy(false);
    }
  };

  const revoke = (targetUserId: string) => {
    Alert.alert(
      "Revoke super admin?",
      "They immediately lose the canon everywhere. Their past teachings stay.",
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Revoke",
          style: "destructive",
          onPress: () => {
            void (async () => {
              setRevokeBusyId(targetUserId);
              try {
                await revokeVenomCanonAdmin(targetUserId);
                refresh();
                void queryClient.invalidateQueries({
                  queryKey: getGetVenomIdentityQueryKey(),
                });
              } catch (error) {
                const status = (error as { status?: number } | null)?.status;
                Alert.alert(
                  "Couldn't revoke",
                  status === 409
                    ? "The canon must keep at least one steward."
                    : status === 400
                      ? "You can't revoke your own role."
                      : "The role wasn't revoked. Try again.",
                );
              } finally {
                setRevokeBusyId(null);
              }
            })();
          },
        },
      ],
    );
  };

  const formatDate = (iso: string) => {
    const time = Date.parse(iso);
    if (Number.isNaN(time)) return "";
    return new Date(time).toLocaleDateString([], {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  // Anyone without the role sees a dead end, never the canon itself. The
  // server refuses their requests anyway; the queries above never even run.
  if (!identityLoading && !isAdmin) {
    return (
      <View
        testID="canon-denied"
        style={[
          styles.container,
          {
            backgroundColor: colors.background,
            paddingTop: insets.top + 16,
            alignItems: "center",
            justifyContent: "center",
          },
        ]}
      >
        <Text style={{ color: colors.mutedForeground, fontSize: 14 }}>
          There's nothing here.
        </Text>
        <TouchableOpacity
          onPress={() => router.back()}
          style={[styles.backLink, { borderColor: colors.border }]}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text style={{ color: colors.text, fontSize: 13 }}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View
      testID="canon-screen"
      style={[
        styles.container,
        { backgroundColor: colors.background, paddingTop: insets.top },
      ]}
    >
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity
          testID="canon-back"
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.headerButton}
        >
          <Feather name="arrow-left" size={20} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>
            Canon
          </Text>
          <Text style={[styles.headerCaption, { color: colors.mutedForeground }]}>
            What Venom holds as taught truth, for everyone.
          </Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}
      >
        {teachingsQuery.isLoading || identityLoading ? (
          <ActivityIndicator
            size="small"
            color={colors.mutedForeground}
            style={{ marginVertical: 24 }}
          />
        ) : teachingsQuery.isError ? (
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
            The canon couldn't be loaded. Pull back and retry.
          </Text>
        ) : byDomain.length === 0 ? (
          <Text
            testID="canon-empty"
            style={[styles.emptyText, { color: colors.mutedForeground }]}
          >
            Nothing taught yet. Tell Venom in chat — "store these as core
            branding principles" — and confirm the card.
          </Text>
        ) : (
          byDomain.map(([domain, entries]) => (
            <View key={domain} style={{ marginBottom: 22 }}>
              <Text
                testID={`canon-domain-${domain}`}
                style={[styles.domainTitle, { color: colors.primary }]}
              >
                {domain}
              </Text>
              {entries.map((teaching) => (
                <View
                  key={teaching.id}
                  testID={`canon-teaching-${teaching.id}`}
                  style={[
                    styles.card,
                    {
                      borderColor: colors.border,
                      backgroundColor: colors.card,
                      opacity: teaching.status === "retired" ? 0.62 : 1,
                    },
                  ]}
                >
                  <View style={styles.cardHeader}>
                    <Text
                      style={[styles.cardTitle, { color: colors.text }]}
                      numberOfLines={2}
                    >
                      {teaching.title}
                    </Text>
                    <View
                      style={[
                        styles.statusChip,
                        {
                          borderColor:
                            teaching.status === "active"
                              ? colors.primary
                              : colors.border,
                        },
                      ]}
                    >
                      <Text
                        style={{
                          fontSize: 10,
                          letterSpacing: 0.8,
                          textTransform: "uppercase",
                          color:
                            teaching.status === "active"
                              ? colors.primary
                              : colors.mutedForeground,
                        }}
                      >
                        {teaching.status}
                      </Text>
                    </View>
                  </View>
                  {teaching.principles.map((principle, index) => (
                    <View key={index} style={styles.principleRow}>
                      <Text style={{ color: colors.mutedForeground }}>—</Text>
                      <Text
                        style={[styles.principleText, { color: colors.text }]}
                      >
                        {principle}
                      </Text>
                    </View>
                  ))}
                  <Text
                    style={[styles.provenance, { color: colors.mutedForeground }]}
                  >
                    Taught by {teaching.taughtByName ?? teaching.taughtByUserId}
                    {" · "}
                    {formatDate(teaching.taughtAt)}
                    {teaching.conversationTitle
                      ? ` · from "${teaching.conversationTitle}"`
                      : ""}
                  </Text>
                  <View style={styles.cardActions}>
                    <TouchableOpacity
                      testID={`canon-edit-${teaching.id}`}
                      onPress={() => openEdit(teaching)}
                      style={[styles.actionButton, { borderColor: colors.border }]}
                      accessibilityRole="button"
                      accessibilityLabel={`Edit ${teaching.title}`}
                    >
                      <Text style={{ color: colors.text, fontSize: 12 }}>
                        Edit
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      testID={`canon-toggle-${teaching.id}`}
                      onPress={() => void toggleStatus(teaching)}
                      disabled={statusBusyId === teaching.id}
                      style={[styles.actionButton, { borderColor: colors.border }]}
                      accessibilityRole="button"
                      accessibilityLabel={
                        teaching.status === "active"
                          ? `Retire ${teaching.title}`
                          : `Restore ${teaching.title}`
                      }
                    >
                      {statusBusyId === teaching.id ? (
                        <ActivityIndicator
                          size="small"
                          color={colors.mutedForeground}
                        />
                      ) : (
                        <Text style={{ color: colors.text, fontSize: 12 }}>
                          {teaching.status === "active" ? "Retire" : "Restore"}
                        </Text>
                      )}
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>
          ))
        )}

        <View style={{ marginTop: 8 }}>
          <Text style={[styles.domainTitle, { color: colors.primary }]}>
            Stewards
          </Text>
          <Text
            style={[
              styles.provenance,
              { color: colors.mutedForeground, marginBottom: 10 },
            ]}
          >
            Super admins can teach, edit, and retire canon — and grant or
            revoke this role. Regular accounts never see any of it.
          </Text>
          {(adminsQuery.data ?? []).map((admin) => (
            <View
              key={admin.userId}
              testID={`canon-admin-${admin.userId}`}
              style={[
                styles.adminRow,
                { borderColor: colors.border, backgroundColor: colors.card },
              ]}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontSize: 13 }}>
                  {admin.name ?? admin.userId}
                  {admin.userId === myUserId ? " (you)" : ""}
                </Text>
                <Text
                  style={{ color: colors.mutedForeground, fontSize: 11 }}
                  numberOfLines={1}
                >
                  {admin.grantedByUserId === null
                    ? "Original steward"
                    : "Granted"}
                  {" · "}
                  {formatDate(admin.grantedAt)}
                </Text>
              </View>
              {admin.userId !== myUserId ? (
                <TouchableOpacity
                  testID={`canon-revoke-${admin.userId}`}
                  onPress={() => revoke(admin.userId)}
                  disabled={revokeBusyId === admin.userId}
                  style={[styles.actionButton, { borderColor: colors.border }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Revoke super admin from ${admin.name ?? admin.userId}`}
                >
                  {revokeBusyId === admin.userId ? (
                    <ActivityIndicator
                      size="small"
                      color={colors.mutedForeground}
                    />
                  ) : (
                    <Text style={{ color: colors.destructive, fontSize: 12 }}>
                      Revoke
                    </Text>
                  )}
                </TouchableOpacity>
              ) : null}
            </View>
          ))}
          <View style={styles.grantRow}>
            <TextInput
              testID="canon-grant-input"
              value={grantUserId}
              onChangeText={setGrantUserId}
              placeholder="Account id (user_…)"
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="none"
              autoCorrect={false}
              style={[
                styles.grantInput,
                {
                  borderColor: colors.input,
                  color: colors.text,
                  backgroundColor: colors.card,
                },
              ]}
            />
            <TouchableOpacity
              testID="canon-grant-button"
              onPress={() => void grant()}
              disabled={grantBusy || !grantUserId.trim()}
              style={[
                styles.grantButton,
                {
                  backgroundColor: colors.primary,
                  opacity: grantBusy || !grantUserId.trim() ? 0.5 : 1,
                },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Grant super admin"
            >
              {grantBusy ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <Text
                  style={{
                    color: colors.primaryForeground,
                    fontSize: 13,
                    fontWeight: "600",
                  }}
                >
                  Grant
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>

      <Modal
        visible={editing !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setEditing(null)}
      >
        <View style={styles.modalBackdrop}>
          <View
            testID="canon-edit-modal"
            style={[
              styles.modalCard,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <Text style={[styles.cardTitle, { color: colors.text }]}>
              Edit teaching
            </Text>
            <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>
              Skill domain
            </Text>
            <TextInput
              testID="canon-edit-domain"
              value={editDomain}
              onChangeText={setEditDomain}
              autoCapitalize="none"
              style={[
                styles.fieldInput,
                {
                  borderColor: colors.input,
                  color: colors.text,
                  backgroundColor: colors.background,
                },
              ]}
            />
            <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>
              Title
            </Text>
            <TextInput
              testID="canon-edit-title"
              value={editTitle}
              onChangeText={setEditTitle}
              style={[
                styles.fieldInput,
                {
                  borderColor: colors.input,
                  color: colors.text,
                  backgroundColor: colors.background,
                },
              ]}
            />
            <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>
              Principles — one per line
            </Text>
            <TextInput
              testID="canon-edit-principles"
              value={editPrinciples}
              onChangeText={setEditPrinciples}
              multiline
              numberOfLines={6}
              textAlignVertical="top"
              style={[
                styles.fieldInput,
                styles.fieldMultiline,
                {
                  borderColor: colors.input,
                  color: colors.text,
                  backgroundColor: colors.background,
                },
              ]}
            />
            <View style={[styles.cardActions, { marginTop: 14 }]}>
              <Pressable
                testID="canon-edit-save"
                onPress={() => void saveEdit()}
                disabled={editBusy}
                style={({ pressed }) => [
                  styles.grantButton,
                  {
                    backgroundColor: colors.primary,
                    opacity: editBusy ? 0.6 : pressed ? 0.85 : 1,
                  },
                ]}
                accessibilityRole="button"
                accessibilityLabel="Save teaching"
              >
                {editBusy ? (
                  <ActivityIndicator
                    size="small"
                    color={colors.primaryForeground}
                  />
                ) : (
                  <Text
                    style={{
                      color: colors.primaryForeground,
                      fontSize: 13,
                      fontWeight: "600",
                    }}
                  >
                    Save
                  </Text>
                )}
              </Pressable>
              <Pressable
                testID="canon-edit-cancel"
                onPress={() => setEditing(null)}
                disabled={editBusy}
                style={({ pressed }) => [
                  styles.actionButton,
                  { borderColor: colors.border, opacity: pressed ? 0.85 : 1 },
                ]}
                accessibilityRole="button"
                accessibilityLabel="Cancel editing"
              >
                <Text style={{ color: colors.text, fontSize: 13 }}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerButton: { padding: 4 },
  headerTitle: { fontSize: 18, fontWeight: "700" },
  headerCaption: { fontSize: 12, marginTop: 2 },
  backLink: {
    marginTop: 14,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  emptyText: { fontSize: 13, lineHeight: 19, marginVertical: 16 },
  domainTitle: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.4,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  card: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    marginBottom: 10,
    gap: 6,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 8,
  },
  cardTitle: { fontSize: 15, fontWeight: "600", flex: 1 },
  statusChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  principleRow: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  principleText: { fontSize: 13, lineHeight: 19, flex: 1 },
  provenance: { fontSize: 11, lineHeight: 16, marginTop: 2 },
  cardActions: { flexDirection: "row", gap: 8, marginTop: 6 },
  actionButton: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  adminRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    marginBottom: 8,
  },
  grantRow: { flexDirection: "row", gap: 8, marginTop: 6 },
  grantInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
  },
  grantButton: {
    borderRadius: 10,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  modalCard: {
    width: "100%",
    maxWidth: 460,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
  },
  fieldLabel: {
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginTop: 10,
    marginBottom: 4,
  },
  fieldInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
  },
  fieldMultiline: { minHeight: 120 },
});
