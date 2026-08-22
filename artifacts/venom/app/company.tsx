import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { Feather } from "@expo/vector-icons";
import { useAuth } from "@clerk/expo";

import { useColors } from "@/hooks/useColors";
import { Header } from "@/components/Header";
import { IS_ORG_UI_TEST, IS_UI_TEST, useVenom } from "@/context/VenomContext";
import {
  acceptVenomOrgInvite,
  ApiError,
  connectVenomOrgGitHubSource,
  connectVenomOrgWebsiteSource,
  createVenomOrg,
  declineVenomOrgInvite,
  deleteVenomOrg,
  getVenomOrgMasterContribution,
  getVenomOrgMembers,
  getVenomOrgProjects,
  getVenomOrgSources,
  inviteVenomOrgMember,
  removeVenomOrgMember,
  removeVenomOrgSource,
  revokeVenomOrgInvite,
  shareVenomOrgProject,
  unshareVenomOrgProject,
  updateVenomOrgMasterContribution,
  type VenomMasterContribution,
  type VenomOrgMember,
  type VenomOrgPendingInvite,
  type VenomOrgRole,
  type VenomOrgSharedProject,
  type VenomOrgSource,
} from "@workspace/api-client-react";

type OrgDetail = {
  orgId: string;
  members: VenomOrgMember[];
  pendingInvites: VenomOrgPendingInvite[];
  projects: VenomOrgSharedProject[];
  sources: VenomOrgSource[];
  masterContribution: VenomMasterContribution;
};

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const data = error.data as { error?: unknown } | null;
    if (data && typeof data.error === "string" && data.error) {
      return data.error;
    }
  }
  return "That didn't go through. Try again.";
}

function successHaptic() {
  if (Platform.OS !== "web") {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }
}

export default function CompanyScreen() {
  const colors = useColors();
  const { getToken } = useAuth();
  const { state, orgs, orgInvites, refreshOrgs } = useVenom();

  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrgDetail | null>(null);
  const [detailStatus, setDetailStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const [detailNonce, setDetailNonce] = useState(0);

  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<VenomOrgRole>("member");
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);

  const [repoInput, setRepoInput] = useState("");
  const [urlInput, setUrlInput] = useState("");

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Clerk can hand back a fresh getToken identity on any render; the detail
  // loader depends on authHeaders, so it reads the latest through a ref to
  // stay referentially stable.
  const getTokenRef = React.useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  const authHeaders = useCallback(async () => {
    // Browser specs have no Clerk session; stubs answer the requests.
    if (IS_UI_TEST) return {};
    const token = await getTokenRef.current();
    if (!token) throw new Error("Not signed in");
    return { headers: { Authorization: `Bearer ${token}` } };
  }, []);

  const selectedOrg = useMemo(
    () => orgs.find((org) => org.id === selectedOrgId) ?? null,
    [orgs, selectedOrgId],
  );
  const isAdmin = selectedOrg?.role === "admin";
  const selfMember = useMemo(
    () => detail?.members.find((member) => member.isSelf) ?? null,
    [detail],
  );

  // Land on the first company so the roster is one tap away.
  useEffect(() => {
    if (!selectedOrgId && orgs.length > 0) {
      setSelectedOrgId(orgs[0].id);
    }
  }, [orgs, selectedOrgId]);

  const reloadDetail = useCallback(() => {
    setDetailNonce((nonce) => nonce + 1);
  }, []);

  useEffect(() => {
    // Org-flagged browser specs stub the detail APIs, so the loader runs for
    // them; every other UI-test spec keeps the org machinery quiet.
    if (!selectedOrgId || (IS_UI_TEST && !IS_ORG_UI_TEST)) {
      setDetail(null);
      setDetailStatus("idle");
      return;
    }
    let stale = false;
    setDetailStatus("loading");
    void (async () => {
      try {
        const auth = await authHeaders();
        const [memberDir, projectList, sourceList, contribution] =
          await Promise.all([
            getVenomOrgMembers(selectedOrgId, auth),
            getVenomOrgProjects(selectedOrgId, auth),
            getVenomOrgSources(selectedOrgId, auth),
            getVenomOrgMasterContribution(selectedOrgId, auth),
          ]);
        if (stale) return;
        setDetail({
          orgId: selectedOrgId,
          members: memberDir.members,
          pendingInvites: memberDir.invites,
          projects: projectList.projects,
          sources: sourceList.sources,
          masterContribution: contribution,
        });
        setDetailStatus("idle");
      } catch (error) {
        if (stale) return;
        if (
          error instanceof ApiError &&
          (error.status === 403 || error.status === 404)
        ) {
          // Access ended (removed, or the company was deleted).
          setSelectedOrgId(null);
          setDetail(null);
          setDetailStatus("idle");
          refreshOrgs();
        } else {
          setDetailStatus("error");
        }
      }
    })();
    return () => {
      stale = true;
    };
  }, [authHeaders, refreshOrgs, selectedOrgId, detailNonce]);

  const run = useCallback(
    async (
      key: string,
      action: () => Promise<void>,
      options?: { skipReload?: boolean },
    ) => {
      if (busyKey) return;
      setBusyKey(key);
      setErrorMessage(null);
      try {
        await action();
        if (!options?.skipReload) reloadDetail();
        refreshOrgs();
      } catch (error) {
        setErrorMessage(errorText(error));
      } finally {
        setBusyKey(null);
        setConfirmKey(null);
      }
    },
    [busyKey, refreshOrgs, reloadDetail],
  );

  const confirmOrArm = (key: string, action: () => void) => {
    if (confirmKey === key) {
      action();
    } else {
      setConfirmKey(key);
    }
  };

  const handleSetContribution = (enabled: boolean) => {
    if (!selectedOrgId) return;
    const orgId = selectedOrgId;
    void run(
      "network-contribution",
      async () => {
        const auth = await authHeaders();
        const updated = await updateVenomOrgMasterContribution(
          orgId,
          { enabled },
          auth,
        );
        setDetail((current) =>
          current && current.orgId === orgId
            ? { ...current, masterContribution: updated }
            : current,
        );
        successHaptic();
      },
      { skipReload: true },
    );
  };

  const handleCreate = () => {
    const name = createName.trim();
    if (!name) return;
    void run("create", async () => {
      const auth = await authHeaders();
      const org = await createVenomOrg({ name }, auth);
      setCreateName("");
      setShowCreate(false);
      setSelectedOrgId(org.id);
      successHaptic();
    });
  };

  const handleAcceptInvite = (inviteId: string) => {
    void run(`invite-accept-${inviteId}`, async () => {
      const auth = await authHeaders();
      const org = await acceptVenomOrgInvite(inviteId, auth);
      setSelectedOrgId(org.id);
      successHaptic();
    });
  };

  const handleDeclineInvite = (inviteId: string) => {
    void run(`invite-decline-${inviteId}`, async () => {
      const auth = await authHeaders();
      await declineVenomOrgInvite(inviteId, auth);
    });
  };

  const handleInvite = () => {
    if (!selectedOrgId) return;
    const email = inviteEmail.trim();
    if (!email.includes("@")) {
      setInviteNotice(null);
      setErrorMessage("Enter the teammate's email address.");
      return;
    }
    void run("invite", async () => {
      const auth = await authHeaders();
      const result = await inviteVenomOrgMember(
        selectedOrgId,
        { email, role: inviteRole },
        auth,
      );
      setInviteEmail("");
      setInviteNotice(
        result.status === "added"
          ? "Already on Venom — added straight to the roster."
          : "Invite sent. It appears in their Venom when they open Company.",
      );
      successHaptic();
    });
  };

  const handleRemoveMember = (member: VenomOrgMember) => {
    if (!selectedOrgId) return;
    void run(`member-remove-${member.userId}`, async () => {
      const auth = await authHeaders();
      await removeVenomOrgMember(selectedOrgId, member.userId, auth);
    });
  };

  const handleRevokeInvite = (inviteId: string) => {
    if (!selectedOrgId) return;
    void run(`pending-revoke-${inviteId}`, async () => {
      const auth = await authHeaders();
      await revokeVenomOrgInvite(selectedOrgId, inviteId, auth);
    });
  };

  const handleShareProject = (projectId: string) => {
    if (!selectedOrgId) return;
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) return;
    void run(`share-${projectId}`, async () => {
      const auth = await authHeaders();
      await shareVenomOrgProject(
        selectedOrgId,
        projectId,
        {
          name: project.name,
          ...(project.description
            ? { description: project.description.slice(0, 1000) }
            : {}),
          ...(project.accent ? { accent: project.accent.slice(0, 32) } : {}),
        },
        auth,
      );
      successHaptic();
    });
  };

  const handleUnshareProject = (projectId: string) => {
    if (!selectedOrgId) return;
    void run(`unshare-${projectId}`, async () => {
      const auth = await authHeaders();
      await unshareVenomOrgProject(selectedOrgId, projectId, auth);
    });
  };

  const handleConnectRepo = () => {
    if (!selectedOrgId) return;
    const repository = repoInput.trim();
    if (!repository.includes("/")) {
      setErrorMessage("Repositories look like owner/name.");
      return;
    }
    void run("connect-github", async () => {
      const auth = await authHeaders();
      await connectVenomOrgGitHubSource(selectedOrgId, { repository }, auth);
      setRepoInput("");
      successHaptic();
    });
  };

  const handleConnectWebsite = () => {
    if (!selectedOrgId) return;
    const url = urlInput.trim();
    if (!url) return;
    void run("connect-website", async () => {
      const auth = await authHeaders();
      await connectVenomOrgWebsiteSource(
        selectedOrgId,
        { url: url.startsWith("http") ? url : `https://${url}` },
        auth,
      );
      setUrlInput("");
      successHaptic();
    });
  };

  const handleRemoveSource = (sourceId: string) => {
    if (!selectedOrgId) return;
    void run(`source-remove-${sourceId}`, async () => {
      const auth = await authHeaders();
      await removeVenomOrgSource(selectedOrgId, sourceId, auth);
    });
  };

  const handleLeave = () => {
    if (!selectedOrgId || !selfMember) return;
    void run(
      "leave",
      async () => {
        const auth = await authHeaders();
        await removeVenomOrgMember(selectedOrgId, selfMember.userId, auth);
        setSelectedOrgId(null);
        setDetail(null);
      },
      { skipReload: true },
    );
  };

  const handleDelete = () => {
    if (!selectedOrgId) return;
    void run(
      "delete",
      async () => {
        const auth = await authHeaders();
        await deleteVenomOrg(selectedOrgId, auth);
        setSelectedOrgId(null);
        setDetail(null);
      },
      { skipReload: true },
    );
  };

  const shareCandidates = useMemo(
    () =>
      state.projects.filter(
        (project) =>
          !project.orgMirror &&
          !project.orgId &&
          !(detail?.projects ?? []).some(
            (shared) => shared.projectId === project.id,
          ),
      ),
    [detail, state.projects],
  );

  const roleLabel = (role: VenomOrgRole) =>
    role === "admin" ? "Admin" : "Member";

  const renderRolePill = (role: VenomOrgRole) => (
    <View
      style={[
        styles.rolePill,
        {
          backgroundColor: role === "admin" ? colors.primary : colors.secondary,
          borderColor: role === "admin" ? colors.primary : colors.border,
        },
      ]}
    >
      <Text
        style={[
          styles.rolePillText,
          {
            color:
              role === "admin" ? colors.primaryForeground : colors.foreground,
          },
        ]}
      >
        {roleLabel(role)}
      </Text>
    </View>
  );

  const busy = (key: string) => busyKey === key;

  return (
    <View
      style={[styles.container, { backgroundColor: colors.background }]}
      testID="company-screen"
    >
      <Header title="Company" showBack />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {errorMessage && (
          <View
            testID="company-error"
            accessibilityRole="alert"
            style={[
              styles.errorBanner,
              { borderColor: colors.destructive, backgroundColor: colors.card },
            ]}
          >
            <Feather name="alert-circle" size={14} color={colors.destructive} />
            <Text style={[styles.errorText, { color: colors.destructive }]}>
              {errorMessage}
            </Text>
          </View>
        )}

        {/* Invites waiting on me */}
        {orgInvites.length > 0 && (
          <View style={styles.section} testID="company-invites">
            <Text style={[styles.sectionTitle, { color: colors.primary }]}>
              INVITATIONS
            </Text>
            {orgInvites.map((invite) => (
              <View
                key={invite.id}
                style={[
                  styles.card,
                  { backgroundColor: colors.card, borderColor: colors.border },
                ]}
              >
                <Text style={[styles.cardTitle, { color: colors.foreground }]}>
                  {invite.orgName}
                </Text>
                <Text
                  style={[styles.cardMeta, { color: colors.mutedForeground }]}
                >
                  {invite.invitedByName} invited you as{" "}
                  {roleLabel(invite.role).toLowerCase()}
                </Text>
                <View style={styles.rowActions}>
                  <TouchableOpacity
                    testID={`company-invite-accept-${invite.id}`}
                    style={[
                      styles.primaryButton,
                      { backgroundColor: colors.primary },
                    ]}
                    onPress={() => handleAcceptInvite(invite.id)}
                    disabled={busyKey !== null}
                    accessibilityRole="button"
                    accessibilityLabel={`Accept the invitation to ${invite.orgName}`}
                  >
                    {busy(`invite-accept-${invite.id}`) ? (
                      <ActivityIndicator
                        size="small"
                        color={colors.primaryForeground}
                      />
                    ) : (
                      <Text
                        style={[
                          styles.primaryButtonText,
                          { color: colors.primaryForeground },
                        ]}
                      >
                        Join
                      </Text>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    testID={`company-invite-decline-${invite.id}`}
                    style={[styles.ghostButton, { borderColor: colors.border }]}
                    onPress={() => handleDeclineInvite(invite.id)}
                    disabled={busyKey !== null}
                    accessibilityRole="button"
                    accessibilityLabel={`Decline the invitation to ${invite.orgName}`}
                  >
                    <Text
                      style={[
                        styles.ghostButtonText,
                        { color: colors.mutedForeground },
                      ]}
                    >
                      Decline
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* Directory */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.primary }]}>
            YOUR COMPANIES
          </Text>
          {orgs.length === 0 && !showCreate ? (
            <View
              testID="company-empty"
              style={[
                styles.card,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
            >
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>
                Run Venom as a team
              </Text>
              <Text
                style={[styles.cardMeta, { color: colors.mutedForeground }]}
              >
                A company gives your team a shared Brain: shared projects,
                shared sources, and a map every member sees. Personal chats
                stay personal.
              </Text>
            </View>
          ) : (
            <View style={styles.chipRow}>
              {orgs.map((org) => {
                const selected = org.id === selectedOrgId;
                return (
                  <TouchableOpacity
                    key={org.id}
                    testID={`company-org-${org.id}`}
                    style={[
                      styles.orgChip,
                      {
                        backgroundColor: selected
                          ? colors.primary
                          : colors.secondary,
                        borderColor: selected ? colors.primary : colors.border,
                      },
                    ]}
                    onPress={() => {
                      setSelectedOrgId(org.id);
                      setConfirmKey(null);
                      setInviteNotice(null);
                    }}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`Open ${org.name}`}
                  >
                    <Feather
                      name="users"
                      size={13}
                      color={
                        selected
                          ? colors.primaryForeground
                          : colors.mutedForeground
                      }
                    />
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.orgChipText,
                        {
                          color: selected
                            ? colors.primaryForeground
                            : colors.foreground,
                        },
                      ]}
                    >
                      {org.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {showCreate ? (
            <View
              style={[
                styles.card,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
            >
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>
                Name the company
              </Text>
              <TextInput
                testID="company-create-name"
                style={[
                  styles.input,
                  { color: colors.foreground, borderColor: colors.border },
                ]}
                placeholder="Acme Robotics"
                placeholderTextColor={colors.mutedForeground}
                value={createName}
                onChangeText={setCreateName}
                maxLength={80}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={handleCreate}
                accessibilityLabel="Company name"
              />
              <View style={styles.rowActions}>
                <TouchableOpacity
                  testID="company-create-submit"
                  style={[
                    styles.primaryButton,
                    {
                      backgroundColor: createName.trim()
                        ? colors.primary
                        : colors.secondary,
                    },
                  ]}
                  onPress={handleCreate}
                  disabled={!createName.trim() || busyKey !== null}
                  accessibilityRole="button"
                  accessibilityLabel="Create the company"
                >
                  {busy("create") ? (
                    <ActivityIndicator
                      size="small"
                      color={colors.primaryForeground}
                    />
                  ) : (
                    <Text
                      style={[
                        styles.primaryButtonText,
                        {
                          color: createName.trim()
                            ? colors.primaryForeground
                            : colors.mutedForeground,
                        },
                      ]}
                    >
                      Create company
                    </Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.ghostButton, { borderColor: colors.border }]}
                  onPress={() => {
                    setShowCreate(false);
                    setCreateName("");
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel creating a company"
                >
                  <Text
                    style={[
                      styles.ghostButtonText,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    Cancel
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <TouchableOpacity
              testID="company-create-toggle"
              style={[styles.newCompanyRow, { borderColor: colors.border }]}
              onPress={() => setShowCreate(true)}
              accessibilityRole="button"
              accessibilityLabel="Start a new company"
            >
              <Feather name="plus" size={15} color={colors.foreground} />
              <Text
                style={[styles.newCompanyText, { color: colors.foreground }]}
              >
                New company
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Selected company detail */}
        {selectedOrg && (
          <>
            {detailStatus === "loading" && !detail && (
              <View style={styles.loadingWrap} testID="company-detail-loading">
                <ActivityIndicator size="small" color={colors.primary} />
              </View>
            )}
            {detailStatus === "error" && (
              <View
                style={[
                  styles.card,
                  { backgroundColor: colors.card, borderColor: colors.border },
                ]}
              >
                <Text
                  style={[styles.cardMeta, { color: colors.mutedForeground }]}
                >
                  Couldn't load {selectedOrg.name}.
                </Text>
                <TouchableOpacity
                  testID="company-detail-retry"
                  style={[styles.ghostButton, { borderColor: colors.border }]}
                  onPress={reloadDetail}
                  accessibilityRole="button"
                  accessibilityLabel="Retry loading this company"
                >
                  <Text
                    style={[
                      styles.ghostButtonText,
                      { color: colors.foreground },
                    ]}
                  >
                    Retry
                  </Text>
                </TouchableOpacity>
              </View>
            )}
            {detail && detail.orgId === selectedOrg.id && (
              <>
                {/* Members */}
                <View style={styles.section} testID="company-members">
                  <Text
                    style={[styles.sectionTitle, { color: colors.primary }]}
                  >
                    MEMBERS · {detail.members.length}
                  </Text>
                  {detail.members.map((member) => (
                    <View
                      key={member.userId}
                      testID={`company-member-${member.userId}`}
                      style={[
                        styles.memberRow,
                        {
                          backgroundColor: colors.card,
                          borderColor: colors.border,
                        },
                      ]}
                    >
                      <View style={styles.memberCopy}>
                        <Text
                          numberOfLines={1}
                          style={[
                            styles.cardTitle,
                            { color: colors.foreground },
                          ]}
                        >
                          {member.name}
                          {member.isSelf ? " · You" : ""}
                        </Text>
                        {member.email ? (
                          <Text
                            numberOfLines={1}
                            style={[
                              styles.cardMeta,
                              { color: colors.mutedForeground },
                            ]}
                          >
                            {member.email}
                          </Text>
                        ) : null}
                      </View>
                      {renderRolePill(member.role)}
                      {isAdmin && !member.isSelf && (
                        <TouchableOpacity
                          testID={`company-member-remove-${member.userId}`}
                          style={[
                            styles.iconButton,
                            {
                              borderColor:
                                confirmKey === `member-remove-${member.userId}`
                                  ? colors.destructive
                                  : colors.border,
                            },
                          ]}
                          onPress={() =>
                            confirmOrArm(`member-remove-${member.userId}`, () =>
                              handleRemoveMember(member),
                            )
                          }
                          disabled={busyKey !== null}
                          accessibilityRole="button"
                          accessibilityLabel={
                            confirmKey === `member-remove-${member.userId}`
                              ? `Tap again to remove ${member.name}. They lose the company Brain immediately.`
                              : `Remove ${member.name} from the company`
                          }
                        >
                          {busy(`member-remove-${member.userId}`) ? (
                            <ActivityIndicator
                              size="small"
                              color={colors.destructive}
                            />
                          ) : (
                            <Feather
                              name={
                                confirmKey === `member-remove-${member.userId}`
                                  ? "alert-circle"
                                  : "user-minus"
                              }
                              size={15}
                              color={colors.destructive}
                            />
                          )}
                        </TouchableOpacity>
                      )}
                    </View>
                  ))}

                  {isAdmin && (
                    <View
                      style={[
                        styles.card,
                        {
                          backgroundColor: colors.card,
                          borderColor: colors.border,
                        },
                      ]}
                    >
                      <Text
                        style={[styles.cardTitle, { color: colors.foreground }]}
                      >
                        Invite a teammate
                      </Text>
                      <TextInput
                        testID="company-invite-email"
                        style={[
                          styles.input,
                          {
                            color: colors.foreground,
                            borderColor: colors.border,
                          },
                        ]}
                        placeholder="teammate@company.com"
                        placeholderTextColor={colors.mutedForeground}
                        value={inviteEmail}
                        onChangeText={(value) => {
                          setInviteEmail(value);
                          setInviteNotice(null);
                        }}
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="email-address"
                        maxLength={320}
                        accessibilityLabel="Teammate email address"
                      />
                      <View style={styles.roleChoiceRow}>
                        {(["member", "admin"] as VenomOrgRole[]).map((role) => {
                          const selected = inviteRole === role;
                          return (
                            <TouchableOpacity
                              key={role}
                              testID={`company-invite-role-${role}`}
                              style={[
                                styles.roleChoice,
                                {
                                  backgroundColor: selected
                                    ? colors.primary
                                    : colors.secondary,
                                  borderColor: selected
                                    ? colors.primary
                                    : colors.border,
                                },
                              ]}
                              onPress={() => setInviteRole(role)}
                              accessibilityRole="button"
                              accessibilityState={{ selected }}
                              accessibilityLabel={`Invite as ${roleLabel(role)}`}
                            >
                              <Text
                                style={[
                                  styles.roleChoiceText,
                                  {
                                    color: selected
                                      ? colors.primaryForeground
                                      : colors.foreground,
                                  },
                                ]}
                              >
                                {roleLabel(role)}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                        <TouchableOpacity
                          testID="company-invite-submit"
                          style={[
                            styles.primaryButton,
                            {
                              backgroundColor: inviteEmail.trim()
                                ? colors.primary
                                : colors.secondary,
                            },
                          ]}
                          onPress={handleInvite}
                          disabled={busyKey !== null}
                          accessibilityRole="button"
                          accessibilityLabel="Send the invitation"
                        >
                          {busy("invite") ? (
                            <ActivityIndicator
                              size="small"
                              color={colors.primaryForeground}
                            />
                          ) : (
                            <Text
                              style={[
                                styles.primaryButtonText,
                                {
                                  color: inviteEmail.trim()
                                    ? colors.primaryForeground
                                    : colors.mutedForeground,
                                },
                              ]}
                            >
                              Invite
                            </Text>
                          )}
                        </TouchableOpacity>
                      </View>
                      {inviteNotice && (
                        <Text
                          testID="company-invite-notice"
                          style={[
                            styles.cardMeta,
                            { color: colors.foreground },
                          ]}
                        >
                          {inviteNotice}
                        </Text>
                      )}
                    </View>
                  )}

                  {detail.pendingInvites.length > 0 && (
                    <View style={styles.subSection}>
                      <Text
                        style={[
                          styles.subSectionTitle,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        Waiting to join
                      </Text>
                      {detail.pendingInvites.map((invite) => (
                        <View
                          key={invite.id}
                          testID={`company-pending-${invite.id}`}
                          style={[
                            styles.memberRow,
                            {
                              backgroundColor: colors.card,
                              borderColor: colors.border,
                            },
                          ]}
                        >
                          <View style={styles.memberCopy}>
                            <Text
                              numberOfLines={1}
                              style={[
                                styles.cardTitle,
                                { color: colors.foreground },
                              ]}
                            >
                              {invite.email}
                            </Text>
                            <Text
                              style={[
                                styles.cardMeta,
                                { color: colors.mutedForeground },
                              ]}
                            >
                              Invited by {invite.invitedByName}
                            </Text>
                          </View>
                          {renderRolePill(invite.role)}
                          {isAdmin && (
                            <TouchableOpacity
                              testID={`company-pending-revoke-${invite.id}`}
                              style={[
                                styles.iconButton,
                                { borderColor: colors.border },
                              ]}
                              onPress={() => handleRevokeInvite(invite.id)}
                              disabled={busyKey !== null}
                              accessibilityRole="button"
                              accessibilityLabel={`Revoke the invitation for ${invite.email}`}
                            >
                              {busy(`pending-revoke-${invite.id}`) ? (
                                <ActivityIndicator
                                  size="small"
                                  color={colors.mutedForeground}
                                />
                              ) : (
                                <Feather
                                  name="x"
                                  size={15}
                                  color={colors.mutedForeground}
                                />
                              )}
                            </TouchableOpacity>
                          )}
                        </View>
                      ))}
                    </View>
                  )}
                </View>

                {/* Shared projects */}
                <View style={styles.section} testID="company-projects">
                  <Text
                    style={[styles.sectionTitle, { color: colors.primary }]}
                  >
                    SHARED PROJECTS · {detail.projects.length}
                  </Text>
                  <Text
                    style={[
                      styles.sectionHint,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    Chats inside shared projects teach the company Brain.
                    Everything else stays personal.
                  </Text>
                  {detail.projects.map((shared) => {
                    const canUnshare =
                      isAdmin ||
                      (selfMember !== null &&
                        shared.sharedByUserId === selfMember.userId);
                    return (
                      <View
                        key={shared.projectId}
                        testID={`company-project-${shared.projectId}`}
                        style={[
                          styles.memberRow,
                          {
                            backgroundColor: colors.card,
                            borderColor: colors.border,
                          },
                        ]}
                      >
                        <View style={styles.memberCopy}>
                          <Text
                            numberOfLines={1}
                            style={[
                              styles.cardTitle,
                              { color: colors.foreground },
                            ]}
                          >
                            {shared.name}
                          </Text>
                          <Text
                            numberOfLines={1}
                            style={[
                              styles.cardMeta,
                              { color: colors.mutedForeground },
                            ]}
                          >
                            Shared by{" "}
                            {selfMember &&
                            shared.sharedByUserId === selfMember.userId
                              ? "you"
                              : shared.sharedByName}
                          </Text>
                        </View>
                        {canUnshare && (
                          <TouchableOpacity
                            testID={`company-unshare-${shared.projectId}`}
                            style={[
                              styles.iconButton,
                              {
                                borderColor:
                                  confirmKey === `unshare-${shared.projectId}`
                                    ? colors.destructive
                                    : colors.border,
                              },
                            ]}
                            onPress={() =>
                              confirmOrArm(`unshare-${shared.projectId}`, () =>
                                handleUnshareProject(shared.projectId),
                              )
                            }
                            disabled={busyKey !== null}
                            accessibilityRole="button"
                            accessibilityLabel={
                              confirmKey === `unshare-${shared.projectId}`
                                ? `Tap again to stop sharing ${shared.name}`
                                : `Stop sharing ${shared.name}`
                            }
                          >
                            {busy(`unshare-${shared.projectId}`) ? (
                              <ActivityIndicator
                                size="small"
                                color={colors.destructive}
                              />
                            ) : (
                              <Feather
                                name={
                                  confirmKey === `unshare-${shared.projectId}`
                                    ? "alert-circle"
                                    : "x"
                                }
                                size={15}
                                color={colors.destructive}
                              />
                            )}
                          </TouchableOpacity>
                        )}
                      </View>
                    );
                  })}
                  {detail.projects.length === 0 && (
                    <Text
                      style={[
                        styles.cardMeta,
                        { color: colors.mutedForeground },
                      ]}
                    >
                      Nothing shared yet.
                    </Text>
                  )}
                  {shareCandidates.length > 0 && (
                    <View style={styles.subSection}>
                      <Text
                        style={[
                          styles.subSectionTitle,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        Share one of your projects
                      </Text>
                      {shareCandidates.map((project) => (
                        <View
                          key={project.id}
                          style={[
                            styles.memberRow,
                            {
                              backgroundColor: colors.card,
                              borderColor: colors.border,
                            },
                          ]}
                        >
                          <View style={styles.memberCopy}>
                            <Text
                              numberOfLines={1}
                              style={[
                                styles.cardTitle,
                                { color: colors.foreground },
                              ]}
                            >
                              {project.name}
                            </Text>
                          </View>
                          <TouchableOpacity
                            testID={`company-share-${project.id}`}
                            style={[
                              styles.ghostButton,
                              { borderColor: colors.border },
                            ]}
                            onPress={() => handleShareProject(project.id)}
                            disabled={busyKey !== null}
                            accessibilityRole="button"
                            accessibilityLabel={`Share ${project.name} with the company`}
                          >
                            {busy(`share-${project.id}`) ? (
                              <ActivityIndicator
                                size="small"
                                color={colors.foreground}
                              />
                            ) : (
                              <Text
                                style={[
                                  styles.ghostButtonText,
                                  { color: colors.foreground },
                                ]}
                              >
                                Share
                              </Text>
                            )}
                          </TouchableOpacity>
                        </View>
                      ))}
                    </View>
                  )}
                </View>

                {/* Knowledge sources */}
                <View style={styles.section} testID="company-sources">
                  <Text
                    style={[styles.sectionTitle, { color: colors.primary }]}
                  >
                    KNOWLEDGE SOURCES · {detail.sources.length}
                  </Text>
                  <Text
                    style={[
                      styles.sectionHint,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    Connected sources feed the shared Brain for every member.
                  </Text>
                  {detail.sources.map((source) => (
                    <View
                      key={source.id}
                      testID={`company-source-${source.id}`}
                      style={[
                        styles.memberRow,
                        {
                          backgroundColor: colors.card,
                          borderColor: colors.border,
                        },
                      ]}
                    >
                      <Feather
                        name={source.provider === "github" ? "github" : "globe"}
                        size={16}
                        color={colors.mutedForeground}
                      />
                      <View style={styles.memberCopy}>
                        <Text
                          numberOfLines={1}
                          style={[
                            styles.cardTitle,
                            { color: colors.foreground },
                          ]}
                        >
                          {source.name}
                        </Text>
                        <Text
                          numberOfLines={1}
                          style={[
                            styles.cardMeta,
                            { color: colors.mutedForeground },
                          ]}
                        >
                          Connected by {source.connectedByName}
                        </Text>
                      </View>
                      {isAdmin && (
                        <TouchableOpacity
                          testID={`company-source-remove-${source.id}`}
                          style={[
                            styles.iconButton,
                            {
                              borderColor:
                                confirmKey === `source-remove-${source.id}`
                                  ? colors.destructive
                                  : colors.border,
                            },
                          ]}
                          onPress={() =>
                            confirmOrArm(`source-remove-${source.id}`, () =>
                              handleRemoveSource(source.id),
                            )
                          }
                          disabled={busyKey !== null}
                          accessibilityRole="button"
                          accessibilityLabel={
                            confirmKey === `source-remove-${source.id}`
                              ? `Tap again to disconnect ${source.name}`
                              : `Disconnect ${source.name}`
                          }
                        >
                          {busy(`source-remove-${source.id}`) ? (
                            <ActivityIndicator
                              size="small"
                              color={colors.destructive}
                            />
                          ) : (
                            <Feather
                              name={
                                confirmKey === `source-remove-${source.id}`
                                  ? "alert-circle"
                                  : "trash-2"
                              }
                              size={15}
                              color={colors.destructive}
                            />
                          )}
                        </TouchableOpacity>
                      )}
                    </View>
                  ))}
                  {detail.sources.length === 0 && (
                    <Text
                      style={[
                        styles.cardMeta,
                        { color: colors.mutedForeground },
                      ]}
                    >
                      No company sources yet.
                    </Text>
                  )}
                  {isAdmin && (
                    <View
                      style={[
                        styles.card,
                        {
                          backgroundColor: colors.card,
                          borderColor: colors.border,
                        },
                      ]}
                    >
                      <Text
                        style={[styles.cardTitle, { color: colors.foreground }]}
                      >
                        Connect a source
                      </Text>
                      <View style={styles.connectRow}>
                        <TextInput
                          testID="company-github-repo"
                          style={[
                            styles.input,
                            styles.connectInput,
                            {
                              color: colors.foreground,
                              borderColor: colors.border,
                            },
                          ]}
                          placeholder="owner/repository"
                          placeholderTextColor={colors.mutedForeground}
                          value={repoInput}
                          onChangeText={setRepoInput}
                          autoCapitalize="none"
                          autoCorrect={false}
                          accessibilityLabel="GitHub repository to connect"
                        />
                        <TouchableOpacity
                          testID="company-github-connect"
                          style={[
                            styles.ghostButton,
                            { borderColor: colors.border },
                          ]}
                          onPress={handleConnectRepo}
                          disabled={busyKey !== null}
                          accessibilityRole="button"
                          accessibilityLabel="Connect the GitHub repository"
                        >
                          {busy("connect-github") ? (
                            <Text
                              style={[
                                styles.ghostButtonText,
                                { color: colors.mutedForeground },
                              ]}
                            >
                              Absorbing…
                            </Text>
                          ) : (
                            <Text
                              style={[
                                styles.ghostButtonText,
                                { color: colors.foreground },
                              ]}
                            >
                              Connect
                            </Text>
                          )}
                        </TouchableOpacity>
                      </View>
                      <View style={styles.connectRow}>
                        <TextInput
                          testID="company-website-url"
                          style={[
                            styles.input,
                            styles.connectInput,
                            {
                              color: colors.foreground,
                              borderColor: colors.border,
                            },
                          ]}
                          placeholder="docs.company.com"
                          placeholderTextColor={colors.mutedForeground}
                          value={urlInput}
                          onChangeText={setUrlInput}
                          autoCapitalize="none"
                          autoCorrect={false}
                          keyboardType="url"
                          accessibilityLabel="Website to connect"
                        />
                        <TouchableOpacity
                          testID="company-website-connect"
                          style={[
                            styles.ghostButton,
                            { borderColor: colors.border },
                          ]}
                          onPress={handleConnectWebsite}
                          disabled={busyKey !== null}
                          accessibilityRole="button"
                          accessibilityLabel="Connect the website"
                        >
                          {busy("connect-website") ? (
                            <Text
                              style={[
                                styles.ghostButtonText,
                                { color: colors.mutedForeground },
                              ]}
                            >
                              Absorbing…
                            </Text>
                          ) : (
                            <Text
                              style={[
                                styles.ghostButtonText,
                                { color: colors.foreground },
                              ]}
                            >
                              Connect
                            </Text>
                          )}
                        </TouchableOpacity>
                      </View>
                    </View>
                  )}
                </View>

                {/* Venom network contribution — admin-controlled company
                    consent for the anonymous master ontology. */}
                <View
                  style={styles.section}
                  testID="company-network-contribution"
                >
                  <Text
                    style={[styles.sectionTitle, { color: colors.primary }]}
                  >
                    VENOM NETWORK
                  </Text>
                  <View
                    style={[
                      styles.card,
                      {
                        backgroundColor: colors.card,
                        borderColor: colors.border,
                      },
                    ]}
                  >
                    <View style={styles.networkRow}>
                      <Text
                        style={[
                          styles.cardTitle,
                          styles.networkTitle,
                          { color: colors.foreground },
                        ]}
                      >
                        Help improve Venom's knowledge network
                      </Text>
                      {isAdmin ? (
                        <TouchableOpacity
                          testID="company-network-toggle"
                          style={[
                            styles.togglePill,
                            detail.masterContribution.enabled
                              ? {
                                  backgroundColor: colors.foreground,
                                  borderColor: colors.foreground,
                                }
                              : { borderColor: colors.border },
                          ]}
                          onPress={() =>
                            handleSetContribution(
                              !detail.masterContribution.enabled,
                            )
                          }
                          disabled={busyKey !== null}
                          accessibilityRole="switch"
                          accessibilityState={{
                            checked: detail.masterContribution.enabled,
                            disabled: busyKey !== null,
                          }}
                          accessibilityLabel="Contribute anonymous concept patterns to the Venom network"
                        >
                          <Text
                            style={[
                              styles.togglePillText,
                              {
                                color: detail.masterContribution.enabled
                                  ? colors.background
                                  : colors.mutedForeground,
                              },
                            ]}
                          >
                            {busy("network-contribution")
                              ? "Saving…"
                              : detail.masterContribution.enabled
                                ? "Contributing"
                                : "Off"}
                          </Text>
                        </TouchableOpacity>
                      ) : (
                        <View
                          testID="company-network-state"
                          style={[
                            styles.togglePill,
                            { borderColor: colors.border },
                          ]}
                        >
                          <Text
                            style={[
                              styles.togglePillText,
                              { color: colors.mutedForeground },
                            ]}
                          >
                            {detail.masterContribution.enabled
                              ? "Contributing"
                              : "Off"}
                          </Text>
                        </View>
                      )}
                    </View>
                    <Text
                      style={[
                        styles.cardMeta,
                        { color: colors.mutedForeground },
                      ]}
                    >
                      When on, {selectedOrg.name} shares anonymous
                      concept-level patterns — concept names, categories, and
                      which concepts connect — to make Venom's suggestions and
                      extraction smarter for everyone.
                    </Text>
                    <Text
                      style={[
                        styles.cardMeta,
                        { color: colors.mutedForeground },
                      ]}
                    >
                      Never shared: chats, notes, sources, evidence, or member
                      names. Rare concepts stay hidden until they are common
                      across many accounts, and turning this off removes the
                      company's influence from future network updates.
                    </Text>
                    {!isAdmin && (
                      <Text
                        testID="company-network-readonly"
                        style={[
                          styles.cardMeta,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        Only admins can change this.
                      </Text>
                    )}
                  </View>
                </View>

                {/* Danger zone */}
                <View style={styles.section} testID="company-danger">
                  <Text
                    style={[styles.sectionTitle, { color: colors.primary }]}
                  >
                    DANGER ZONE
                  </Text>
                  <TouchableOpacity
                    testID="company-leave"
                    style={[
                      styles.dangerRow,
                      {
                        borderColor:
                          confirmKey === "leave"
                            ? colors.destructive
                            : colors.border,
                        backgroundColor: colors.card,
                      },
                    ]}
                    onPress={() => confirmOrArm("leave", handleLeave)}
                    disabled={busyKey !== null}
                    accessibilityRole="button"
                    accessibilityLabel={
                      confirmKey === "leave"
                        ? `Tap again to leave ${selectedOrg.name}. You lose the company Brain immediately.`
                        : `Leave ${selectedOrg.name}`
                    }
                  >
                    <Feather
                      name="log-out"
                      size={15}
                      color={colors.destructive}
                    />
                    <Text
                      style={[styles.dangerText, { color: colors.destructive }]}
                    >
                      {busy("leave")
                        ? "Leaving…"
                        : confirmKey === "leave"
                          ? "Tap again to leave — access ends immediately"
                          : "Leave this company"}
                    </Text>
                  </TouchableOpacity>
                  {isAdmin && (
                    <TouchableOpacity
                      testID="company-delete"
                      style={[
                        styles.dangerRow,
                        {
                          borderColor:
                            confirmKey === "delete"
                              ? colors.destructive
                              : colors.border,
                          backgroundColor: colors.card,
                        },
                      ]}
                      onPress={() => confirmOrArm("delete", handleDelete)}
                      disabled={busyKey !== null}
                      accessibilityRole="button"
                      accessibilityLabel={
                        confirmKey === "delete"
                          ? `Tap again to delete ${selectedOrg.name} for every member`
                          : `Delete ${selectedOrg.name}`
                      }
                    >
                      <Feather
                        name="trash-2"
                        size={15}
                        color={colors.destructive}
                      />
                      <Text
                        style={[
                          styles.dangerText,
                          { color: colors.destructive },
                        ]}
                      >
                        {busy("delete")
                          ? "Deleting…"
                          : confirmKey === "delete"
                            ? "Tap again to delete for every member"
                            : "Delete this company"}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              </>
            )}
          </>
        )}

        <Text style={[styles.privacyNote, { color: colors.mutedForeground }]}>
          Personal chats and your personal Brain never enter a company Brain.
          Only shared projects, company sources, and concepts you promote.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 48,
    gap: 20,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  errorText: {
    flex: 1,
    fontSize: 12.5,
    lineHeight: 17,
    fontFamily: "Inter_500Medium",
  },
  section: {
    gap: 10,
  },
  sectionTitle: {
    fontSize: 11,
    letterSpacing: 1.2,
    fontFamily: "Inter_600SemiBold",
  },
  sectionHint: {
    fontSize: 12.5,
    lineHeight: 18,
    fontFamily: "Inter_400Regular",
  },
  subSection: {
    gap: 8,
    marginTop: 4,
  },
  subSectionTitle: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  card: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 8,
  },
  cardTitle: {
    fontSize: 14.5,
    fontFamily: "Inter_600SemiBold",
  },
  cardMeta: {
    fontSize: 12.5,
    lineHeight: 18,
    fontFamily: "Inter_400Regular",
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  orgChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 8,
    maxWidth: 240,
  },
  orgChipText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  newCompanyRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: 12,
    paddingVertical: 11,
  },
  newCompanyText: {
    fontSize: 13.5,
    fontFamily: "Inter_500Medium",
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  primaryButton: {
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 9,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 74,
  },
  primaryButtonText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  ghostButton: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 13,
    paddingVertical: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  ghostButtonText: {
    fontSize: 12.5,
    fontFamily: "Inter_500Medium",
  },
  loadingWrap: {
    paddingVertical: 24,
    alignItems: "center",
  },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  memberCopy: {
    flex: 1,
    gap: 2,
  },
  rolePill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  rolePillText: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
  },
  networkRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  networkTitle: {
    flex: 1,
  },
  togglePill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  togglePillText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  iconButton: {
    borderWidth: 1,
    borderRadius: 9,
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  roleChoiceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  roleChoice: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  roleChoiceText: {
    fontSize: 12.5,
    fontFamily: "Inter_500Medium",
  },
  connectRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  connectInput: {
    flex: 1,
  },
  dangerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  dangerText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  privacyNote: {
    fontSize: 12,
    lineHeight: 17,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    paddingHorizontal: 8,
  },
});
