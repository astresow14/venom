import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/expo";
import { Feather } from "@expo/vector-icons";
import {
  exportSharedWorkspaceMarkdown,
  getGetSharedWorkspaceBillingQueryKey,
  getGetSharedWorkspaceKnowledgeQueryKey,
  getGetSharedWorkspaceSettingsQueryKey,
  getListSharedWorkspaceMembersQueryKey,
  getListSharedWorkspaceSopsQueryKey,
  getListSharedWorkspacesQueryKey,
  useAddSharedWorkspaceMember,
  useCreateSharedWorkspace,
  useCreateSharedWorkspaceBillingCheckout,
  useCreateSharedWorkspaceBillingPortal,
  useGetSharedWorkspaceBilling,
  useGetSharedWorkspaceKnowledge,
  useGetSharedWorkspaceSettings,
  useListSharedWorkspaceMembers,
  useListSharedWorkspaceSops,
  useRemoveSharedWorkspaceMember,
  useSetSharedWorkspaceConceptRestriction,
  useSetSharedWorkspaceConceptSensitivity,
  useUpdateSharedWorkspaceMemberRole,
  useSetSharedWorkspaceEvidenceSensitivity,
  useSetSharedWorkspaceSopRestriction,
  useSetSharedWorkspaceSopSensitivity,
  useUpdateSharedWorkspaceSettings,
  type SharedWorkspaceMember,
  type VenomKnowledgeCluster,
} from "@workspace/api-client-react";
import { Header } from "@/components/Header";
import { ScreenWrapper } from "@/components/ScreenWrapper";
import { WorkspaceAiControls } from "@/components/WorkspaceAiControls";
import { useColors } from "@/hooks/useColors";
import { useSharedWorkspace } from "@/context/sharedWorkspace";
import {
  deliverMarkdown,
  markdownExportFileName,
} from "@/lib/downloadMarkdown";

function statusOf(error: unknown): number | undefined {
  return (error as { status?: number } | null)?.status;
}

/**
 * Shared-workspace management on mobile: create workspaces, see members
 * (admins add/remove and change roles in place), and review each
 * workspace's shared knowledge and procedures. Everything here comes from
 * membership-checked endpoints — nothing is stored in the synced personal
 * snapshot.
 *
 * This screen is management only. There is no app-wide workspace
 * selection anymore: chat knowledge sorts itself at filing time, and the
 * Brain screen carries the Personal / workspace / Unsorted filter. Opening
 * a workspace here just expands its management panel.
 */
export default function WorkspacesScreen() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { userId: myUserId } = useAuth();
  const { workspaces, isLoading, accessLostNotice, dismissAccessLostNotice } =
    useSharedWorkspace();

  // Which workspace's management panel is open — screen-local state, not a
  // scope the rest of the app follows.
  const [managedId, setManagedId] = useState<string | null>(null);
  const activeWorkspace = useMemo(
    () => workspaces.find((entry) => entry.id === managedId) ?? null,
    [workspaces, managedId],
  );

  const [newName, setNewName] = useState("");
  const [newMemberId, setNewMemberId] = useState("");
  const [newMemberRole, setNewMemberRole] = useState<"member" | "admin">(
    "member",
  );

  const isAdmin = activeWorkspace?.role === "admin";

  // Organization plan: admins can put the whole workspace on a workspace-
  // level subscription; from then on AI used inside it draws on the
  // workspace allowance instead of members' personal plans. Dollar figures
  // and the buy/manage actions are admin-only — the server enforces that
  // boundary too, this gate just avoids a pointless query.
  const workspaceBillingQuery = useGetSharedWorkspaceBilling(
    activeWorkspace?.id ?? "",
    {
      query: {
        queryKey: getGetSharedWorkspaceBillingQueryKey(
          activeWorkspace?.id ?? "",
        ),
        enabled: Boolean(activeWorkspace) && isAdmin,
        staleTime: 60_000,
        retry: 1,
      },
    },
  );
  const workspaceBilling = workspaceBillingQuery.data ?? null;
  const workspaceCheckout = useCreateSharedWorkspaceBillingCheckout();
  const workspacePortal = useCreateSharedWorkspaceBillingPortal();
  const workspaceBillingBusy =
    workspaceCheckout.isPending || workspacePortal.isPending;

  // Purchase and management happen on Stripe-hosted pages; the app only
  // opens the URL the server minted. Card details never pass through Venom.
  const openWorkspaceBillingPage = (kind: "checkout" | "portal") => {
    if (!activeWorkspace || workspaceBillingBusy) return;
    const workspaceIdForBilling = activeWorkspace.id;
    const mutation = kind === "checkout" ? workspaceCheckout : workspacePortal;
    const returnUrl =
      Platform.OS === "web" && typeof window !== "undefined"
        ? window.location.href
        : undefined;
    mutation.mutate(
      {
        workspaceId: workspaceIdForBilling,
        data: returnUrl ? { returnUrl } : {},
      },
      {
        onSuccess: async ({ url }) => {
          await Linking.openURL(url);
          // Plan state may change while the Stripe page is open; refetch so
          // this section catches up when the person comes back.
          await queryClient.invalidateQueries({
            queryKey: getGetSharedWorkspaceBillingQueryKey(
              workspaceIdForBilling,
            ),
          });
        },
        onError: (error: unknown) => {
          const status = (error as { status?: number })?.status;
          Alert.alert(
            kind === "checkout"
              ? "Could not start checkout"
              : "Could not open the billing portal",
            status === 503
              ? "Billing isn't set up on this server yet."
              : status === 409
                ? kind === "checkout"
                  ? "This workspace is already on the Organization plan."
                  : "There's no workspace subscription to manage yet."
                : "Try again in a moment.",
          );
        },
      },
    );
  };
  const workspaceId = activeWorkspace?.id ?? "";

  const membersQuery = useListSharedWorkspaceMembers(workspaceId, {
    query: {
      queryKey: getListSharedWorkspaceMembersQueryKey(workspaceId),
      enabled: Boolean(activeWorkspace),
    },
  });
  const members = useMemo(
    () => (Array.isArray(membersQuery.data) ? membersQuery.data : []),
    [membersQuery.data],
  );

  const knowledgeQuery = useGetSharedWorkspaceKnowledge(workspaceId, {
    query: {
      queryKey: getGetSharedWorkspaceKnowledgeQueryKey(workspaceId),
      enabled: Boolean(activeWorkspace),
    },
  });
  const clusters = knowledgeQuery.data?.clusters ?? [];

  const sopsQuery = useListSharedWorkspaceSops(workspaceId, {
    query: {
      queryKey: getListSharedWorkspaceSopsQueryKey(workspaceId),
      enabled: Boolean(activeWorkspace),
    },
  });
  const sops = useMemo(
    () => (Array.isArray(sopsQuery.data) ? sopsQuery.data : []),
    [sopsQuery.data],
  );

  const createWorkspace = useCreateSharedWorkspace();
  const addMember = useAddSharedWorkspaceMember();
  const removeMember = useRemoveSharedWorkspaceMember();
  const updateMemberRole = useUpdateSharedWorkspaceMemberRole();

  // Sensitivity locks: any member may mark or unmark workspace knowledge and
  // procedures. The lock governs what leaves the workspace in exports, not
  // who inside the workspace can see the item.
  const conceptSensitivity = useSetSharedWorkspaceConceptSensitivity();
  const evidenceSensitivity = useSetSharedWorkspaceEvidenceSensitivity();
  const sopSensitivity = useSetSharedWorkspaceSopSensitivity();
  // Admin-only restrictions: the server filters restricted items out of
  // member responses entirely, so the badge and toggle below only ever
  // render for admins — members never receive a restricted row to show.
  const conceptRestriction = useSetSharedWorkspaceConceptRestriction();
  const sopRestriction = useSetSharedWorkspaceSopRestriction();
  const [expandedClusterId, setExpandedClusterId] = useState<string | null>(
    null,
  );
  const [exportingKind, setExportingKind] = useState<"brain" | "sops" | null>(
    null,
  );

  // The export policy is admin-only on the server, so the query stays off
  // for regular members.
  const settingsQuery = useGetSharedWorkspaceSettings(workspaceId, {
    query: {
      queryKey: getGetSharedWorkspaceSettingsQueryKey(workspaceId),
      enabled: Boolean(activeWorkspace) && isAdmin,
    },
  });
  const updateSettings = useUpdateSharedWorkspaceSettings();

  const lockFailed = () => {
    Alert.alert("Could not update the lock", "Try again in a moment.");
  };

  const invalidateKnowledge = () => {
    queryClient.invalidateQueries({
      queryKey: getGetSharedWorkspaceKnowledgeQueryKey(workspaceId),
    });
  };

  const handleConceptLock = (cluster: VenomKnowledgeCluster) => {
    if (!activeWorkspace || conceptSensitivity.isPending) return;
    conceptSensitivity.mutate(
      {
        workspaceId,
        conceptId: cluster.id,
        data: { sensitive: cluster.sensitive !== true },
      },
      { onSuccess: invalidateKnowledge, onError: lockFailed },
    );
  };

  const handleEvidenceLock = (
    cluster: VenomKnowledgeCluster,
    conversationId: string,
    sensitive: boolean,
  ) => {
    if (!activeWorkspace || evidenceSensitivity.isPending) return;
    evidenceSensitivity.mutate(
      { workspaceId, conceptId: cluster.id, conversationId, data: { sensitive } },
      { onSuccess: invalidateKnowledge, onError: lockFailed },
    );
  };

  const handleSopLock = (sopId: string, sensitive: boolean) => {
    if (!activeWorkspace || sopSensitivity.isPending) return;
    sopSensitivity.mutate(
      { workspaceId, sopId, data: { sensitive } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListSharedWorkspaceSopsQueryKey(workspaceId),
          });
        },
        onError: lockFailed,
      },
    );
  };

  const restrictionFailed = () => {
    Alert.alert("Could not update the restriction", "Try again in a moment.");
  };

  const handleConceptRestrict = (cluster: VenomKnowledgeCluster) => {
    if (!activeWorkspace || conceptRestriction.isPending) return;
    conceptRestriction.mutate(
      {
        workspaceId,
        conceptId: cluster.id,
        data: { adminOnly: cluster.adminOnly !== true },
      },
      { onSuccess: invalidateKnowledge, onError: restrictionFailed },
    );
  };

  const handleSopRestrict = (sopId: string, adminOnly: boolean) => {
    if (!activeWorkspace || sopRestriction.isPending) return;
    sopRestriction.mutate(
      { workspaceId, sopId, data: { adminOnly } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListSharedWorkspaceSopsQueryKey(workspaceId),
          });
        },
        onError: restrictionFailed,
      },
    );
  };

  const handlePolicyChange = (nextAllow: boolean) => {
    if (updateSettings.isPending) return;
    updateSettings.mutate(
      { workspaceId, data: { allowSensitiveExport: nextAllow } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getGetSharedWorkspaceSettingsQueryKey(workspaceId),
          });
        },
        onError: () => {
          Alert.alert("Could not update the policy", "Try again in a moment.");
        },
      },
    );
  };

  const handleExport = async (kind: "brain" | "sops") => {
    if (!activeWorkspace || exportingKind) return;
    setExportingKind(kind);
    try {
      const markdown = await exportSharedWorkspaceMarkdown(workspaceId, kind);
      await deliverMarkdown(
        markdownExportFileName(activeWorkspace.name, kind),
        markdown,
      );
    } catch {
      Alert.alert(
        "Export failed",
        "The download could not be prepared. Try again.",
      );
    } finally {
      setExportingKind(null);
    }
  };

  const handleCreate = () => {
    const name = newName.trim();
    if (!name || createWorkspace.isPending) return;
    createWorkspace.mutate(
      { data: { name } },
      {
        onSuccess: async (workspace) => {
          await queryClient.invalidateQueries({
            queryKey: getListSharedWorkspacesQueryKey(),
          });
          setManagedId(workspace.id);
          setNewName("");
        },
        onError: (error: unknown) => {
          Alert.alert(
            "Could not create workspace",
            statusOf(error) === 409
              ? "You have reached the shared workspace limit."
              : "Give the workspace a name and try again.",
          );
        },
      },
    );
  };

  const invalidateMembership = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: getListSharedWorkspaceMembersQueryKey(workspaceId),
      }),
      queryClient.invalidateQueries({
        queryKey: getListSharedWorkspacesQueryKey(),
      }),
    ]);
  };

  const handleAddMember = () => {
    const memberId = newMemberId.trim();
    if (!memberId || !activeWorkspace || addMember.isPending) return;
    addMember.mutate(
      {
        workspaceId: activeWorkspace.id,
        data: { userId: memberId, role: newMemberRole },
      },
      {
        onSuccess: async () => {
          await invalidateMembership();
          setNewMemberId("");
          setNewMemberRole("member");
        },
        onError: (error: unknown) => {
          const status = statusOf(error);
          Alert.alert(
            "Could not add member",
            status === 404
              ? "No Venom account matches that ID."
              : status === 409
                ? "They are already a member, or the workspace is full."
                : status === 502
                  ? "The account directory is unreachable right now."
                  : "Check the account ID and try again.",
          );
        },
      },
    );
  };

  // Role changes happen in place: nobody is removed, so the member's access
  // and cached workspace content never lapse.
  const performRoleChange = (member: SharedWorkspaceMember) => {
    if (!activeWorkspace) return;
    const nextRole = member.role === "admin" ? "member" : "admin";
    updateMemberRole.mutate(
      {
        workspaceId: activeWorkspace.id,
        memberUserId: member.userId,
        data: { role: nextRole },
      },
      {
        // The caller's own role also rides the workspace list.
        onSuccess: () => invalidateMembership(),
        onError: (error: unknown) => {
          const status = statusOf(error);
          Alert.alert(
            "Could not change the role",
            status === 409
              ? "A workspace needs at least one admin. Promote someone else first."
              : status === 404
                ? "They are no longer a member."
                : status === 403
                  ? "Only admins can change roles."
                  : "Try again in a moment.",
          );
        },
      },
    );
  };

  const handleRoleChange = (member: SharedWorkspaceMember) => {
    if (updateMemberRole.isPending) return;
    const demotingSelf =
      member.userId === myUserId && member.role === "admin";
    if (!demotingSelf) {
      performRoleChange(member);
      return;
    }
    // Stepping down is safe but not self-reversible; confirm it.
    const title = "Step down as admin?";
    const detail =
      "You keep your membership and access, but only another admin can promote you again.";
    if (Platform.OS === "web") {
      // RN Web's Alert has no buttons; confirm() keeps the guard.
      // eslint-disable-next-line no-alert
      if (window.confirm(`${title}\n\n${detail}`)) performRoleChange(member);
      return;
    }
    Alert.alert(title, detail, [
      { text: "Cancel", style: "cancel" },
      { text: "Step down", onPress: () => performRoleChange(member) },
    ]);
  };

  const performRemove = (member: SharedWorkspaceMember) => {
    if (!activeWorkspace) return;
    const removingSelf = member.userId === myUserId;
    removeMember.mutate(
      { workspaceId: activeWorkspace.id, memberUserId: member.userId },
      {
        onSuccess: async () => {
          if (removingSelf) {
            setManagedId(null);
            await queryClient.invalidateQueries({
              queryKey: getListSharedWorkspacesQueryKey(),
            });
            return;
          }
          await invalidateMembership();
        },
        onError: (error: unknown) => {
          const status = statusOf(error);
          Alert.alert(
            removingSelf ? "Could not leave" : "Could not remove member",
            status === 409
              ? "A workspace needs at least one admin. Promote someone first."
              : status === 404
                ? "They are no longer a member."
                : "Try again in a moment.",
          );
        },
      },
    );
  };

  const handleRemoveMember = (member: SharedWorkspaceMember) => {
    if (removeMember.isPending) return;
    const removingSelf = member.userId === myUserId;
    const title = removingSelf ? "Leave workspace?" : "Remove member?";
    const detail = removingSelf
      ? "You will lose access to this workspace's knowledge and procedures."
      : "Their access ends now: the server refuses their next workspace request and their devices drop the cached copy. Their personal space is untouched.";
    if (Platform.OS === "web") {
      // RN Web's Alert has no buttons; confirm() keeps the guard.
      // eslint-disable-next-line no-alert
      if (window.confirm(`${title}\n\n${detail}`)) performRemove(member);
      return;
    }
    Alert.alert(title, detail, [
      { text: "Cancel", style: "cancel" },
      {
        text: removingSelf ? "Leave" : "Remove",
        style: "destructive",
        onPress: () => performRemove(member),
      },
    ]);
  };

  return (
    <ScreenWrapper>
      <Header title="Shared Workspaces" showBack />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {accessLostNotice && (
          <TouchableOpacity
            style={[
              styles.notice,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
            onPress={dismissAccessLostNotice}
            accessibilityRole="button"
            accessibilityLabel="Dismiss access notice"
            testID="notice-access-lost"
          >
            <Feather name="slash" size={16} color={colors.destructive} />
            <Text style={[styles.noticeText, { color: colors.foreground }]}>
              {accessLostNotice}
            </Text>
            <Feather name="x" size={14} color={colors.mutedForeground} />
          </TouchableOpacity>
        )}

        {/* Workspace list: tap a workspace to open its management panel.
            Selection here is screen-local — knowledge files itself now, and
            the Brain screen owns the Personal / workspace / Unsorted view. */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.primary }]}>
            YOUR SHARED WORKSPACES
          </Text>
          <View
            style={[
              styles.card,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            {isLoading && (
              <View style={styles.row}>
                <ActivityIndicator size="small" color={colors.mutedForeground} />
              </View>
            )}

            {!isLoading && workspaces.length === 0 && (
              <View style={styles.row} testID="workspace-list-empty">
                <Text style={[styles.rowMeta, { color: colors.mutedForeground }]}>
                  No shared workspaces yet. Create one below to pool knowledge
                  with teammates.
                </Text>
              </View>
            )}

            {workspaces.map((workspace, index) => {
              const open = activeWorkspace?.id === workspace.id;
              return (
                <TouchableOpacity
                  key={workspace.id}
                  style={[
                    styles.row,
                    (isLoading || index > 0) && styles.rowBorder,
                    (isLoading || index > 0) && { borderTopColor: colors.border },
                  ]}
                  onPress={() => setManagedId(open ? null : workspace.id)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: open }}
                  accessibilityLabel={`Manage shared workspace ${workspace.name}`}
                  testID={`select-space-${workspace.id}`}
                >
                  <View style={styles.rowLeft}>
                    <Feather
                      name="users"
                      size={18}
                      color={open ? colors.primary : colors.mutedForeground}
                    />
                    <View style={{ flexShrink: 1 }}>
                      <Text
                        style={[styles.rowTitle, { color: colors.foreground }]}
                        numberOfLines={1}
                      >
                        {workspace.name}
                      </Text>
                      <Text
                        style={[styles.rowMeta, { color: colors.mutedForeground }]}
                      >
                        {workspace.memberCount}{" "}
                        {workspace.memberCount === 1 ? "member" : "members"} ·{" "}
                        {workspace.role}
                      </Text>
                    </View>
                  </View>
                  <Feather
                    name={open ? "chevron-up" : "chevron-down"}
                    size={16}
                    color={open ? colors.primary : colors.mutedForeground}
                  />
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Create */}
          <View
            style={[
              styles.card,
              styles.createCard,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <TextInput
              value={newName}
              onChangeText={setNewName}
              placeholder="New shared workspace…"
              placeholderTextColor={colors.mutedForeground}
              maxLength={80}
              style={[styles.input, { color: colors.foreground }]}
              accessibilityLabel="New shared workspace name"
              testID="input-new-workspace-name"
            />
            <TouchableOpacity
              onPress={handleCreate}
              disabled={!newName.trim() || createWorkspace.isPending}
              style={[
                styles.iconButton,
                {
                  backgroundColor: newName.trim()
                    ? colors.primary
                    : colors.secondary,
                },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Create shared workspace"
              testID="button-create-workspace"
            >
              {createWorkspace.isPending ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <Feather
                  name="plus"
                  size={18}
                  color={
                    newName.trim()
                      ? colors.primaryForeground
                      : colors.mutedForeground
                  }
                />
              )}
            </TouchableOpacity>
          </View>
        </View>

        {activeWorkspace && (
          <>
            {/* Members */}
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: colors.primary }]}>
                MEMBERS
              </Text>
              <View
                style={[
                  styles.card,
                  { backgroundColor: colors.card, borderColor: colors.border },
                ]}
              >
                {membersQuery.isLoading ? (
                  <View style={styles.row}>
                    <ActivityIndicator size="small" color={colors.mutedForeground} />
                  </View>
                ) : membersQuery.isError ? (
                  <View style={styles.row}>
                    <Text style={[styles.rowMeta, { color: colors.destructive }]}>
                      The member list could not be loaded.
                    </Text>
                  </View>
                ) : (
                  members.map((member, index) => {
                    const isSelf = member.userId === myUserId;
                    return (
                      <View
                        key={member.userId}
                        style={[
                          styles.row,
                          index > 0 && styles.rowBorder,
                          index > 0 && { borderTopColor: colors.border },
                        ]}
                        testID={`row-member-${member.userId}`}
                      >
                        <View style={styles.rowLeft}>
                          <View
                            style={[
                              styles.avatar,
                              { backgroundColor: colors.primary },
                            ]}
                          >
                            <Text
                              style={[
                                styles.avatarText,
                                { color: colors.primaryForeground },
                              ]}
                            >
                              {(member.name || member.userId)
                                .charAt(0)
                                .toUpperCase()}
                            </Text>
                          </View>
                          <View style={{ flexShrink: 1 }}>
                            <Text
                              style={[styles.rowTitle, { color: colors.foreground }]}
                              numberOfLines={1}
                            >
                              {member.name || member.userId}
                              {isSelf ? " (you)" : ""}
                            </Text>
                            <Text
                              style={[
                                styles.rowMeta,
                                { color: colors.mutedForeground },
                              ]}
                            >
                              {member.role.toUpperCase()}
                            </Text>
                          </View>
                        </View>
                        {isAdmin && (
                          <TouchableOpacity
                            onPress={() => handleRoleChange(member)}
                            disabled={updateMemberRole.isPending}
                            hitSlop={10}
                            accessibilityRole="button"
                            accessibilityLabel={
                              member.role === "admin"
                                ? isSelf
                                  ? "Step down to member"
                                  : `Make ${member.name || member.userId} a member`
                                : `Make ${member.name || member.userId} an admin`
                            }
                            testID={`button-toggle-member-role-${member.userId}`}
                          >
                            <Feather
                              name={
                                member.role === "admin" ? "shield-off" : "shield"
                              }
                              size={16}
                              color={colors.mutedForeground}
                            />
                          </TouchableOpacity>
                        )}
                        {isAdmin && (
                          <TouchableOpacity
                            onPress={() => handleRemoveMember(member)}
                            disabled={removeMember.isPending}
                            hitSlop={10}
                            accessibilityRole="button"
                            accessibilityLabel={
                              isSelf
                                ? "Leave workspace"
                                : `Remove ${member.name || member.userId}`
                            }
                            testID={`button-remove-member-${member.userId}`}
                          >
                            <Feather
                              name={isSelf ? "log-out" : "x"}
                              size={16}
                              color={colors.destructive}
                            />
                          </TouchableOpacity>
                        )}
                      </View>
                    );
                  })
                )}
              </View>

              {isAdmin && (
                <View
                  style={[
                    styles.card,
                    styles.createCard,
                    { backgroundColor: colors.card, borderColor: colors.border },
                  ]}
                >
                  <TextInput
                    value={newMemberId}
                    onChangeText={setNewMemberId}
                    placeholder="Add member by account ID (user_…)"
                    placeholderTextColor={colors.mutedForeground}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={[styles.input, styles.mono, { color: colors.foreground }]}
                    accessibilityLabel="New member account ID"
                    testID="input-new-member-id"
                  />
                  <TouchableOpacity
                    onPress={() =>
                      setNewMemberRole((role) =>
                        role === "member" ? "admin" : "member",
                      )
                    }
                    style={[styles.roleToggle, { borderColor: colors.border }]}
                    accessibilityRole="button"
                    accessibilityLabel={`New member role: ${newMemberRole}. Tap to change.`}
                    testID="toggle-new-member-role"
                  >
                    <Text
                      style={[styles.roleToggleText, { color: colors.foreground }]}
                    >
                      {newMemberRole === "admin" ? "ADMIN" : "MEMBER"}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={handleAddMember}
                    disabled={!newMemberId.trim() || addMember.isPending}
                    style={[
                      styles.iconButton,
                      {
                        backgroundColor: newMemberId.trim()
                          ? colors.primary
                          : colors.secondary,
                      },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="Add member"
                    testID="button-add-member"
                  >
                    {addMember.isPending ? (
                      <ActivityIndicator
                        size="small"
                        color={colors.primaryForeground}
                      />
                    ) : (
                      <Feather
                        name="user-plus"
                        size={16}
                        color={
                          newMemberId.trim()
                            ? colors.primaryForeground
                            : colors.mutedForeground
                        }
                      />
                    )}
                  </TouchableOpacity>
                </View>
              )}

              {myUserId && (
                <View style={styles.ownIdRow}>
                  <Text style={[styles.rowMeta, { color: colors.mutedForeground }]}>
                    Your account ID (share it to be added):
                  </Text>
                  <Text
                    selectable
                    style={[styles.mono, styles.ownId, { color: colors.foreground }]}
                    testID="text-own-account-id"
                  >
                    {myUserId}
                  </Text>
                </View>
              )}
            </View>

            {/* Admin-only export policy */}
            {isAdmin && (
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: colors.primary }]}>
                  SECURITY
                </Text>
                <View
                  style={[
                    styles.card,
                    { backgroundColor: colors.card, borderColor: colors.border },
                  ]}
                  testID="section-workspace-security"
                >
                  <View style={styles.row}>
                    <View style={styles.rowLeft}>
                      <Feather
                        name="lock"
                        size={16}
                        color={colors.mutedForeground}
                      />
                      <View style={{ flexShrink: 1 }}>
                        <Text
                          style={[styles.rowTitle, { color: colors.foreground }]}
                        >
                          Allow sensitive content in exports
                        </Text>
                        <Text
                          style={[
                            styles.rowMeta,
                            { color: colors.mutedForeground },
                          ]}
                        >
                          When off, locked items never leave this workspace:
                          downloads exclude them and say how many were withheld.
                        </Text>
                      </View>
                    </View>
                    {settingsQuery.isLoading ? (
                      <ActivityIndicator
                        size="small"
                        color={colors.mutedForeground}
                      />
                    ) : settingsQuery.isError ? (
                      <Text
                        style={[styles.rowMeta, { color: colors.destructive }]}
                      >
                        Unavailable
                      </Text>
                    ) : (
                      <Switch
                        value={settingsQuery.data?.allowSensitiveExport === true}
                        onValueChange={handlePolicyChange}
                        disabled={updateSettings.isPending}
                        accessibilityLabel="Allow sensitive content in exports"
                        trackColor={{
                          false: colors.accent,
                          true: colors.primary,
                        }}
                        thumbColor={colors.background}
                        testID="switch-allow-sensitive-export"
                      />
                    )}
                  </View>
                </View>
              </View>
            )}

            {/* Admin-only organization plan */}
            {isAdmin && (
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: colors.primary }]}>
                  ORGANIZATION PLAN
                </Text>
                <View
                  style={[
                    styles.card,
                    { backgroundColor: colors.card, borderColor: colors.border },
                  ]}
                  testID="section-workspace-billing"
                >
                  {workspaceBillingQuery.isLoading ? (
                    <ActivityIndicator
                      size="small"
                      color={colors.mutedForeground}
                    />
                  ) : workspaceBillingQuery.isError || !workspaceBilling ? (
                    <Text
                      style={[styles.rowMeta, { color: colors.destructive }]}
                    >
                      The workspace plan could not be loaded.
                    </Text>
                  ) : workspaceBilling.covered ? (
                    <View>
                      <Text
                        style={[styles.rowTitle, { color: colors.foreground }]}
                        testID="workspace-billing-plan"
                      >
                        {workspaceBilling.planName}
                        {workspaceBilling.plan
                          ? ` · $${workspaceBilling.plan.priceUsd}/mo`
                          : ""}
                      </Text>
                      <Text
                        style={[
                          styles.rowMeta,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        AI used inside this workspace draws on the workspace
                        allowance — never on members&rsquo; personal plans.
                      </Text>
                      {workspaceBilling.plan &&
                        typeof workspaceBilling.spentUsd === "number" &&
                        workspaceBilling.plan.allowanceUsd > 0 && (
                          <>
                            <View
                              style={[
                                billingStyles.meterTrack,
                                { backgroundColor: colors.accent },
                              ]}
                              accessibilityRole="progressbar"
                              accessibilityValue={{
                                min: 0,
                                max: 100,
                                now: Math.round(
                                  Math.min(
                                    workspaceBilling.spentUsd /
                                      workspaceBilling.plan.allowanceUsd,
                                    1,
                                  ) * 100,
                                ),
                              }}
                              accessibilityLabel="Share of the workspace's included AI used this period"
                              testID="workspace-billing-meter"
                            >
                              <View
                                style={[
                                  billingStyles.meterFill,
                                  {
                                    backgroundColor:
                                      workspaceBilling.state === "exhausted"
                                        ? colors.destructive
                                        : colors.foreground,
                                    width: `${Math.max(
                                      Math.min(
                                        workspaceBilling.spentUsd /
                                          workspaceBilling.plan.allowanceUsd,
                                        1,
                                      ) * 100,
                                      2,
                                    )}%`,
                                  },
                                ]}
                              />
                            </View>
                            <View style={billingStyles.meterRow}>
                              <Text
                                style={[
                                  billingStyles.label,
                                  { color: colors.mutedForeground },
                                ]}
                              >
                                Included AI this period
                              </Text>
                              <Text
                                style={[
                                  billingStyles.figures,
                                  { color: colors.foreground },
                                ]}
                                testID="workspace-billing-figures"
                              >
                                {formatBillingUsd(workspaceBilling.spentUsd)} of
                                ${workspaceBilling.plan.allowanceUsd}
                              </Text>
                            </View>
                          </>
                        )}
                      {workspaceBilling.state === "exhausted" ? (
                        <Text
                          style={[
                            billingStyles.stateText,
                            { color: colors.destructive },
                          ]}
                          testID="workspace-billing-exhausted"
                        >
                          The workspace has used this period&rsquo;s included
                          AI — chats here are paused until it resets or the
                          plan changes.
                        </Text>
                      ) : workspaceBilling.state === "approaching" ? (
                        <Text
                          style={[
                            billingStyles.stateText,
                            { color: colors.foreground },
                          ]}
                          testID="workspace-billing-approaching"
                        >
                          The workspace is close to this period&rsquo;s
                          included AI.
                        </Text>
                      ) : null}
                      {workspaceBilling.manageable && (
                        <TouchableOpacity
                          onPress={() => openWorkspaceBillingPage("portal")}
                          disabled={workspaceBillingBusy}
                          accessibilityRole="button"
                          accessibilityLabel="Manage the workspace plan"
                          style={[
                            billingStyles.actionButton,
                            billingStyles.outlineButton,
                            {
                              borderColor: colors.border,
                              opacity: workspaceBillingBusy ? 0.5 : 1,
                            },
                          ]}
                          testID="button-workspace-billing-manage"
                        >
                          {workspacePortal.isPending ? (
                            <ActivityIndicator
                              size="small"
                              color={colors.foreground}
                            />
                          ) : (
                            <Text
                              style={[
                                billingStyles.actionButtonText,
                                { color: colors.foreground },
                              ]}
                            >
                              Manage plan
                            </Text>
                          )}
                        </TouchableOpacity>
                      )}
                    </View>
                  ) : (
                    <View>
                      <Text
                        style={[styles.rowTitle, { color: colors.foreground }]}
                      >
                        Put this workspace on the {workspaceBilling.planName}{" "}
                        plan
                      </Text>
                      <Text
                        style={[
                          styles.rowMeta,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        {workspaceBilling.plan
                          ? `$${workspaceBilling.plan.priceUsd}/mo covers $${workspaceBilling.plan.allowanceUsd} of AI for everyone here — members' chats in this workspace stop drawing on their personal plans.`
                          : "Cover everyone's AI in this workspace with one workspace-level plan."}
                      </Text>
                      {workspaceBilling.configured ? (
                        <TouchableOpacity
                          onPress={() => openWorkspaceBillingPage("checkout")}
                          disabled={workspaceBillingBusy}
                          accessibilityRole="button"
                          accessibilityLabel="Put this workspace on the Organization plan"
                          style={[
                            billingStyles.actionButton,
                            {
                              backgroundColor: colors.foreground,
                              opacity: workspaceBillingBusy ? 0.5 : 1,
                            },
                          ]}
                          testID="button-workspace-billing-checkout"
                        >
                          {workspaceCheckout.isPending ? (
                            <ActivityIndicator
                              size="small"
                              color={colors.background}
                            />
                          ) : (
                            <Text
                              style={[
                                billingStyles.actionButtonText,
                                { color: colors.background },
                              ]}
                            >
                              Get the plan
                            </Text>
                          )}
                        </TouchableOpacity>
                      ) : (
                        <View
                          style={[
                            billingStyles.badge,
                            { borderColor: colors.border },
                          ]}
                          testID="workspace-billing-not-configured"
                        >
                          <Text
                            style={[
                              billingStyles.badgeText,
                              { color: colors.mutedForeground },
                            ]}
                          >
                            Billing not set up yet
                          </Text>
                        </View>
                      )}
                    </View>
                  )}
                </View>
              </View>
            )}

            {/* Admin-only: workspace-billed usage and AI controls. Only
                rendered on the Organization plan — without coverage there is
                no workspace-billed usage to meter or control. Members never
                see this section, and personal-space usage never appears. */}
            {isAdmin && activeWorkspace && workspaceBilling?.covered === true && (
              <View style={styles.section}>
                <View style={styles.sectionHeader}>
                  <Text
                    style={[styles.sectionTitle, { color: colors.primary }]}
                  >
                    AI USAGE & CONTROLS
                  </Text>
                </View>
                <WorkspaceAiControls
                  workspaceId={activeWorkspace.id}
                  workspaceName={activeWorkspace.name}
                  myUserId={myUserId ?? null}
                />
              </View>
            )}

            {/* Shared knowledge */}
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={[styles.sectionTitle, { color: colors.primary }]}>
                  SHARED KNOWLEDGE
                </Text>
                <TouchableOpacity
                  onPress={() => handleExport("brain")}
                  disabled={exportingKind !== null}
                  hitSlop={8}
                  style={[styles.exportButton, { borderColor: colors.border }]}
                  accessibilityRole="button"
                  accessibilityLabel="Download this workspace's knowledge as Markdown"
                  testID="button-export-workspace-brain"
                >
                  {exportingKind === "brain" ? (
                    <ActivityIndicator
                      size="small"
                      color={colors.mutedForeground}
                    />
                  ) : (
                    <Feather
                      name="download"
                      size={13}
                      color={colors.mutedForeground}
                    />
                  )}
                  <Text
                    style={[
                      styles.exportButtonText,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    .md
                  </Text>
                </TouchableOpacity>
              </View>
              <View
                style={[
                  styles.card,
                  { backgroundColor: colors.card, borderColor: colors.border },
                ]}
              >
                {knowledgeQuery.isLoading ? (
                  <View style={styles.row}>
                    <ActivityIndicator size="small" color={colors.mutedForeground} />
                  </View>
                ) : knowledgeQuery.isError ? (
                  <View style={styles.row}>
                    <Text style={[styles.rowMeta, { color: colors.destructive }]}>
                      Shared knowledge could not be loaded.
                    </Text>
                  </View>
                ) : clusters.length === 0 ? (
                  <View style={styles.row}>
                    <Text style={[styles.rowMeta, { color: colors.mutedForeground }]}>
                      Nothing shared yet. Keep this workspace selected while
                      you chat and Venom will file what your team learns here
                      — answers already draw on all your spaces.
                    </Text>
                  </View>
                ) : (
                  clusters.map((cluster, index) => {
                    const isLocked = cluster.sensitive === true;
                    const isRestricted = cluster.adminOnly === true;
                    const isExpanded = expandedClusterId === cluster.id;
                    return (
                      <View
                        key={cluster.id}
                        style={[
                          index > 0 && styles.rowBorder,
                          index > 0 && { borderTopColor: colors.border },
                        ]}
                        testID={`row-workspace-cluster-${cluster.id}`}
                      >
                        <View style={styles.row}>
                          <TouchableOpacity
                            style={styles.rowLeft}
                            onPress={() =>
                              setExpandedClusterId((current) =>
                                current === cluster.id ? null : cluster.id,
                              )
                            }
                            accessibilityRole="button"
                            accessibilityLabel={`${cluster.label}. ${
                              isExpanded ? "Hide" : "Show"
                            } evidence.`}
                            testID={`button-expand-cluster-${cluster.id}`}
                          >
                            <Feather
                              name={isLocked ? "lock" : "share-2"}
                              size={16}
                              color={
                                isLocked
                                  ? colors.foreground
                                  : colors.mutedForeground
                              }
                            />
                            <View style={{ flexShrink: 1 }}>
                              <Text
                                style={[
                                  styles.rowTitle,
                                  { color: colors.foreground },
                                ]}
                                numberOfLines={1}
                              >
                                {cluster.label}
                              </Text>
                              <Text
                                style={[
                                  styles.rowMeta,
                                  { color: colors.mutedForeground },
                                ]}
                                numberOfLines={2}
                              >
                                {isRestricted ? "ADMIN-ONLY · " : ""}
                                {isLocked ? "SENSITIVE · " : ""}
                                {cluster.summary}
                              </Text>
                            </View>
                          </TouchableOpacity>
                          <TouchableOpacity
                            onPress={() => handleConceptLock(cluster)}
                            disabled={conceptSensitivity.isPending}
                            hitSlop={10}
                            accessibilityRole="button"
                            accessibilityLabel={
                              isLocked
                                ? `Remove sensitivity lock from ${cluster.label}`
                                : `Mark ${cluster.label} sensitive`
                            }
                            testID={`button-toggle-cluster-sensitivity-${cluster.id}`}
                          >
                            <Feather
                              name={isLocked ? "unlock" : "lock"}
                              size={16}
                              color={
                                isLocked
                                  ? colors.foreground
                                  : colors.mutedForeground
                              }
                            />
                          </TouchableOpacity>
                          {isAdmin && (
                            <TouchableOpacity
                              onPress={() => handleConceptRestrict(cluster)}
                              disabled={conceptRestriction.isPending}
                              hitSlop={10}
                              style={styles.rowActionSpacing}
                              accessibilityRole="button"
                              accessibilityLabel={
                                isRestricted
                                  ? `Remove the admin-only restriction from ${cluster.label}`
                                  : `Restrict ${cluster.label} to admins`
                              }
                              testID={`button-toggle-cluster-restriction-${cluster.id}`}
                            >
                              <Feather
                                name={isRestricted ? "shield-off" : "shield"}
                                size={16}
                                color={
                                  isRestricted
                                    ? colors.foreground
                                    : colors.mutedForeground
                                }
                              />
                            </TouchableOpacity>
                          )}
                        </View>
                        {isExpanded &&
                          (cluster.sources ?? []).map((source) => {
                            const evidenceLocked = source.sensitive === true;
                            return (
                              <View
                                key={`${cluster.id}-${source.conversationId}`}
                                style={[
                                  styles.evidenceRow,
                                  { borderTopColor: colors.border },
                                ]}
                                testID={`row-workspace-evidence-${cluster.id}-${source.conversationId}`}
                              >
                                <View style={{ flexShrink: 1, flexGrow: 1 }}>
                                  <Text
                                    style={[
                                      styles.rowMeta,
                                      { color: colors.foreground },
                                    ]}
                                    numberOfLines={1}
                                  >
                                    {source.conversationTitle}
                                  </Text>
                                  <Text
                                    style={[
                                      styles.rowMeta,
                                      { color: colors.mutedForeground },
                                    ]}
                                    numberOfLines={2}
                                  >
                                    {evidenceLocked ? "SENSITIVE · " : ""}
                                    {source.excerpt}
                                  </Text>
                                </View>
                                <TouchableOpacity
                                  onPress={() =>
                                    handleEvidenceLock(
                                      cluster,
                                      source.conversationId,
                                      !evidenceLocked,
                                    )
                                  }
                                  disabled={evidenceSensitivity.isPending}
                                  hitSlop={10}
                                  accessibilityRole="button"
                                  accessibilityLabel={
                                    evidenceLocked
                                      ? `Remove sensitivity lock from evidence in ${source.conversationTitle}`
                                      : `Mark evidence in ${source.conversationTitle} sensitive`
                                  }
                                  testID={`button-toggle-evidence-sensitivity-${cluster.id}-${source.conversationId}`}
                                >
                                  <Feather
                                    name={evidenceLocked ? "unlock" : "lock"}
                                    size={14}
                                    color={
                                      evidenceLocked
                                        ? colors.foreground
                                        : colors.mutedForeground
                                    }
                                  />
                                </TouchableOpacity>
                              </View>
                            );
                          })}
                      </View>
                    );
                  })
                )}
              </View>
            </View>

            {/* Shared procedures */}
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={[styles.sectionTitle, { color: colors.primary }]}>
                  SHARED PROCEDURES
                </Text>
                <TouchableOpacity
                  onPress={() => handleExport("sops")}
                  disabled={exportingKind !== null}
                  hitSlop={8}
                  style={[styles.exportButton, { borderColor: colors.border }]}
                  accessibilityRole="button"
                  accessibilityLabel="Download this workspace's procedures as Markdown"
                  testID="button-export-workspace-sops"
                >
                  {exportingKind === "sops" ? (
                    <ActivityIndicator
                      size="small"
                      color={colors.mutedForeground}
                    />
                  ) : (
                    <Feather
                      name="download"
                      size={13}
                      color={colors.mutedForeground}
                    />
                  )}
                  <Text
                    style={[
                      styles.exportButtonText,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    .md
                  </Text>
                </TouchableOpacity>
              </View>
              <View
                style={[
                  styles.card,
                  { backgroundColor: colors.card, borderColor: colors.border },
                ]}
              >
                {sopsQuery.isLoading ? (
                  <View style={styles.row}>
                    <ActivityIndicator size="small" color={colors.mutedForeground} />
                  </View>
                ) : sopsQuery.isError ? (
                  <View style={styles.row}>
                    <Text style={[styles.rowMeta, { color: colors.destructive }]}>
                      Shared procedures could not be loaded.
                    </Text>
                  </View>
                ) : sops.length === 0 ? (
                  <View style={styles.row}>
                    <Text style={[styles.rowMeta, { color: colors.mutedForeground }]}>
                      No shared procedures yet. Create them from desktop and
                      every member sees them here.
                    </Text>
                  </View>
                ) : (
                  sops.map((sop, index) => {
                    const isLocked = sop.sensitive === true;
                    const isRestricted = sop.adminOnly === true;
                    return (
                      <View
                        key={sop.id}
                        style={[
                          styles.row,
                          index > 0 && styles.rowBorder,
                          index > 0 && { borderTopColor: colors.border },
                        ]}
                        testID={`row-workspace-sop-${sop.id}`}
                      >
                        <View style={styles.rowLeft}>
                          <Feather
                            name={isLocked ? "lock" : "file-text"}
                            size={16}
                            color={
                              isLocked
                                ? colors.foreground
                                : colors.mutedForeground
                            }
                          />
                          <View style={{ flexShrink: 1 }}>
                            <Text
                              style={[
                                styles.rowTitle,
                                { color: colors.foreground },
                              ]}
                              numberOfLines={1}
                            >
                              {sop.title}
                            </Text>
                            <Text
                              style={[
                                styles.rowMeta,
                                { color: colors.mutedForeground },
                              ]}
                              numberOfLines={2}
                            >
                              {isRestricted ? "ADMIN-ONLY · " : ""}
                              {isLocked ? "SENSITIVE · " : ""}
                              {sop.lifecycle.toUpperCase()}
                              {sop.activeRevisionNumber
                                ? ` · v${sop.activeRevisionNumber}`
                                : ""}{" "}
                              · {sop.content.purpose}
                            </Text>
                          </View>
                        </View>
                        <TouchableOpacity
                          onPress={() => handleSopLock(sop.id, !isLocked)}
                          disabled={sopSensitivity.isPending}
                          hitSlop={10}
                          accessibilityRole="button"
                          accessibilityLabel={
                            isLocked
                              ? `Remove sensitivity lock from ${sop.title}`
                              : `Mark ${sop.title} sensitive`
                          }
                          testID={`button-toggle-sop-sensitivity-${sop.id}`}
                        >
                          <Feather
                            name={isLocked ? "unlock" : "lock"}
                            size={16}
                            color={
                              isLocked
                                ? colors.foreground
                                : colors.mutedForeground
                            }
                          />
                        </TouchableOpacity>
                        {isAdmin && (
                          <TouchableOpacity
                            onPress={() => handleSopRestrict(sop.id, !isRestricted)}
                            disabled={sopRestriction.isPending}
                            hitSlop={10}
                            style={styles.rowActionSpacing}
                            accessibilityRole="button"
                            accessibilityLabel={
                              isRestricted
                                ? `Remove the admin-only restriction from ${sop.title}`
                                : `Restrict ${sop.title} to admins`
                            }
                            testID={`button-toggle-sop-restriction-${sop.id}`}
                          >
                            <Feather
                              name={isRestricted ? "shield-off" : "shield"}
                              size={16}
                              color={
                                isRestricted
                                  ? colors.foreground
                                  : colors.mutedForeground
                              }
                            />
                          </TouchableOpacity>
                        )}
                      </View>
                    );
                  })
                )}
              </View>
            </View>
          </>
        )}
      </ScrollView>
    </ScreenWrapper>
  );
}

/** Dollar display for the workspace allowance meter. */
function formatBillingUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}
const styles = StyleSheet.create({
  content: {
    padding: 16,
    paddingBottom: 48,
    gap: 24,
  },
  notice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
  noticeText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  section: {
    gap: 8,
  },
  sectionTitle: {
    fontSize: 11,
    letterSpacing: 1.2,
    fontFamily: "Inter_600SemiBold",
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  exportButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  exportButtonText: {
    fontSize: 10,
    letterSpacing: 0.6,
    fontFamily: "Inter_600SemiBold",
  },
  evidenceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginLeft: 44,
    paddingRight: 16,
    paddingVertical: 10,
  },
  card: {
    borderWidth: 1,
    borderRadius: 12,
    overflow: "hidden",
  },
  createCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowActionSpacing: {
    marginLeft: 16,
  },
  rowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flexShrink: 1,
    flex: 1,
  },
  rowTitle: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  rowMeta: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    marginTop: 1,
  },
  input: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    paddingVertical: 8,
  },
  mono: {
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
  },
  iconButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  roleToggle: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  roleToggleText: {
    fontSize: 10,
    letterSpacing: 0.8,
    fontFamily: "Inter_600SemiBold",
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  ownIdRow: {
    marginTop: 8,
    gap: 2,
  },
  ownId: {
    fontSize: 11,
  },
});

const billingStyles = StyleSheet.create({
  meterTrack: {
    height: 8,
    borderRadius: 999,
    overflow: "hidden",
    marginTop: 12,
  },
  meterFill: {
    height: "100%",
    borderRadius: 999,
  },
  meterRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginTop: 6,
  },
  label: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
  },
  figures: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12.5,
    fontVariant: ["tabular-nums"],
  },
  stateText: {
    fontFamily: "Inter_500Medium",
    fontSize: 12.5,
    lineHeight: 18,
    marginTop: 8,
  },
  actionButton: {
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 9,
    alignSelf: "flex-start",
    marginTop: 12,
  },
  actionButtonText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  outlineButton: {
    borderWidth: 1,
  },
  badge: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignSelf: "flex-start",
    marginTop: 10,
  },
  badgeText: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
  },
});
