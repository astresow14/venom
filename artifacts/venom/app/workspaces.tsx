import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/expo";
import { Feather } from "@expo/vector-icons";
import {
  getGetSharedWorkspaceKnowledgeQueryKey,
  getListSharedWorkspaceMembersQueryKey,
  getListSharedWorkspaceSopsQueryKey,
  getListSharedWorkspacesQueryKey,
  useAddSharedWorkspaceMember,
  useCreateSharedWorkspace,
  useGetSharedWorkspaceKnowledge,
  useListSharedWorkspaceMembers,
  useListSharedWorkspaceSops,
  useRemoveSharedWorkspaceMember,
  type SharedWorkspaceMember,
} from "@workspace/api-client-react";
import { Header } from "@/components/Header";
import { ScreenWrapper } from "@/components/ScreenWrapper";
import { useColors } from "@/hooks/useColors";
import { useSharedWorkspace } from "@/context/sharedWorkspace";

function statusOf(error: unknown): number | undefined {
  return (error as { status?: number } | null)?.status;
}

/**
 * Shared workspaces on mobile: create, switch between personal and shared
 * views, see members (admins add/remove), and read the workspace's shared
 * knowledge and procedures. Everything here comes from membership-checked
 * endpoints — nothing is stored in the synced personal snapshot.
 */
export default function WorkspacesScreen() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { userId: myUserId } = useAuth();
  const {
    workspaces,
    isLoading,
    activeWorkspace,
    selectWorkspace,
    accessLostNotice,
    dismissAccessLostNotice,
  } = useSharedWorkspace();

  const [newName, setNewName] = useState("");
  const [newMemberId, setNewMemberId] = useState("");
  const [newMemberRole, setNewMemberRole] = useState<"member" | "admin">(
    "member",
  );

  const isAdmin = activeWorkspace?.role === "admin";
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
          selectWorkspace(workspace.id);
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

  const performRemove = (member: SharedWorkspaceMember) => {
    if (!activeWorkspace) return;
    const removingSelf = member.userId === myUserId;
    removeMember.mutate(
      { workspaceId: activeWorkspace.id, memberUserId: member.userId },
      {
        onSuccess: async () => {
          if (removingSelf) {
            selectWorkspace(null);
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

        {/* Space picker */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.primary }]}>
            SPACE
          </Text>
          <View
            style={[
              styles.card,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <TouchableOpacity
              style={styles.row}
              onPress={() => selectWorkspace(null)}
              accessibilityRole="radio"
              accessibilityState={{ selected: !activeWorkspace }}
              accessibilityLabel="Use your personal space"
              testID="select-space-personal"
            >
              <View style={styles.rowLeft}>
                <Feather
                  name="user"
                  size={18}
                  color={
                    !activeWorkspace ? colors.primary : colors.mutedForeground
                  }
                />
                <Text style={[styles.rowTitle, { color: colors.foreground }]}>
                  Personal
                </Text>
              </View>
              {!activeWorkspace && (
                <Feather name="check" size={16} color={colors.primary} />
              )}
            </TouchableOpacity>

            {isLoading && (
              <View style={[styles.row, styles.rowBorder, { borderTopColor: colors.border }]}>
                <ActivityIndicator size="small" color={colors.mutedForeground} />
              </View>
            )}

            {workspaces.map((workspace) => {
              const selected = activeWorkspace?.id === workspace.id;
              return (
                <TouchableOpacity
                  key={workspace.id}
                  style={[styles.row, styles.rowBorder, { borderTopColor: colors.border }]}
                  onPress={() => selectWorkspace(workspace.id)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Use shared workspace ${workspace.name}`}
                  testID={`select-space-${workspace.id}`}
                >
                  <View style={styles.rowLeft}>
                    <Feather
                      name="users"
                      size={18}
                      color={selected ? colors.primary : colors.mutedForeground}
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
                  {selected && (
                    <Feather name="check" size={16} color={colors.primary} />
                  )}
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

            {/* Shared knowledge */}
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: colors.primary }]}>
                SHARED KNOWLEDGE
              </Text>
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
                      Nothing shared yet. Chat while this workspace is selected
                      and Venom will file what your team learns here.
                    </Text>
                  </View>
                ) : (
                  clusters.map((cluster, index) => (
                    <View
                      key={cluster.id}
                      style={[
                        styles.row,
                        index > 0 && styles.rowBorder,
                        index > 0 && { borderTopColor: colors.border },
                      ]}
                      testID={`row-workspace-cluster-${cluster.id}`}
                    >
                      <View style={styles.rowLeft}>
                        <Feather
                          name="share-2"
                          size={16}
                          color={colors.mutedForeground}
                        />
                        <View style={{ flexShrink: 1 }}>
                          <Text
                            style={[styles.rowTitle, { color: colors.foreground }]}
                            numberOfLines={1}
                          >
                            {cluster.label}
                          </Text>
                          <Text
                            style={[styles.rowMeta, { color: colors.mutedForeground }]}
                            numberOfLines={2}
                          >
                            {cluster.summary}
                          </Text>
                        </View>
                      </View>
                    </View>
                  ))
                )}
              </View>
            </View>

            {/* Shared procedures */}
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: colors.primary }]}>
                SHARED PROCEDURES
              </Text>
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
                  sops.map((sop, index) => (
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
                          name="file-text"
                          size={16}
                          color={colors.mutedForeground}
                        />
                        <View style={{ flexShrink: 1 }}>
                          <Text
                            style={[styles.rowTitle, { color: colors.foreground }]}
                            numberOfLines={1}
                          >
                            {sop.title}
                          </Text>
                          <Text
                            style={[styles.rowMeta, { color: colors.mutedForeground }]}
                            numberOfLines={2}
                          >
                            {sop.lifecycle.toUpperCase()}
                            {sop.activeRevisionNumber
                              ? ` · v${sop.activeRevisionNumber}`
                              : ""}{" "}
                            · {sop.content.purpose}
                          </Text>
                        </View>
                      </View>
                    </View>
                  ))
                )}
              </View>
            </View>
          </>
        )}
      </ScrollView>
    </ScreenWrapper>
  );
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
