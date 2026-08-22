import React, { useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { Feather } from "@expo/vector-icons";
import {
  getGetSharedWorkspaceAiControlsQueryKey,
  getGetSharedWorkspaceUsageQueryKey,
  getGetVenomBillingContextQueryKey,
  useClearSharedWorkspaceMemberAiCap,
  useGetSharedWorkspaceAiControls,
  useGetSharedWorkspaceUsage,
  useSetSharedWorkspaceMemberAiCap,
  useUpdateSharedWorkspaceAiControls,
  type VenomModelCostTier,
  type VenomWorkspaceAiControls,
} from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";

const COST_TIERS: VenomModelCostTier[] = ["$", "$$", "$$$"];

const POLICY_CHOICES: Array<{
  value: "off" | "auto-cheapest" | "auto-max-power";
  title: string;
  description: string;
}> = [
  {
    value: "off",
    title: "Members choose",
    description: "Everyone keeps their own model settings here.",
  },
  {
    value: "auto-cheapest",
    title: "Always cheapest",
    description: "Every workspace-billed reply runs on the cheapest healthy models.",
  },
  {
    value: "auto-max-power",
    title: "Always max power",
    description: "Every workspace-billed reply runs on the most capable models.",
  },
];

function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

/**
 * Parse an admin-entered dollar amount. Empty means "no cap"; anything else
 * must be a non-negative number (0 is a deliberate full block), capped at
 * the API's ceiling and rounded to cents. Returns undefined on bad input.
 */
function parseCapInput(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000) {
    return undefined;
  }
  return Math.round(value * 100) / 100;
}

/**
 * Admin-only spend visibility and AI controls for a workspace on the
 * Organization plan. Everything here concerns usage billed to the
 * workspace — members' personal spaces are structurally invisible: the
 * server only aggregates ledger rows whose payer is this workspace.
 */
export function WorkspaceAiControls({
  workspaceId,
  workspaceName,
  myUserId,
}: {
  workspaceId: string;
  workspaceName: string;
  myUserId: string | null;
}) {
  const colors = useColors();
  const queryClient = useQueryClient();

  const usageQuery = useGetSharedWorkspaceUsage(workspaceId, {
    query: { queryKey: getGetSharedWorkspaceUsageQueryKey(workspaceId) },
  });
  const controlsQuery = useGetSharedWorkspaceAiControls(workspaceId, {
    query: { queryKey: getGetSharedWorkspaceAiControlsQueryKey(workspaceId) },
  });
  const usage = usageQuery.data;
  const controls = controlsQuery.data;
  const memberRows = Array.isArray(usage?.members) ? usage.members : [];

  const updateControls = useUpdateSharedWorkspaceAiControls();
  const setMemberCap = useSetSharedWorkspaceMemberAiCap();
  const clearMemberCap = useClearSharedWorkspaceMemberAiCap();
  const busy =
    updateControls.isPending ||
    setMemberCap.isPending ||
    clearMemberCap.isPending;

  const [defaultCapDraft, setDefaultCapDraft] = useState<string | null>(null);
  const [memberEditor, setMemberEditor] = useState<{
    userId: string;
    draft: string;
  } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  /** Every write returns the fresh controls payload; states ride usage. */
  const acceptControls = async (fresh: VenomWorkspaceAiControls) => {
    setFormError(null);
    queryClient.setQueryData(
      getGetSharedWorkspaceAiControlsQueryKey(workspaceId),
      fresh,
    );
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: getGetSharedWorkspaceUsageQueryKey(workspaceId),
      }),
      // Members' composers and settings read lock/cap state from the
      // billing context; every param variant must refetch.
      queryClient.invalidateQueries({
        queryKey: getGetVenomBillingContextQueryKey(),
      }),
    ]);
  };

  const writeFailed = (error: unknown) => {
    const status = (error as { status?: number })?.status;
    setFormError(
      status === 403
        ? "Only admins of this workspace can change AI controls."
        : status === 404
          ? "They are no longer a member of this workspace."
          : "Could not save the change. Try again in a moment.",
    );
  };

  const saveControls = (patch: {
    defaultMemberCapUsd?: number | null;
    forcedSelectionPolicy?: "auto-cheapest" | "auto-max-power" | null;
    allowedCostTiers?: VenomModelCostTier[] | null;
  }) => {
    if (!controls || busy) return;
    updateControls.mutate(
      {
        workspaceId,
        data: {
          defaultMemberCapUsd:
            patch.defaultMemberCapUsd !== undefined
              ? patch.defaultMemberCapUsd
              : controls.defaultMemberCapUsd,
          forcedSelectionPolicy:
            patch.forcedSelectionPolicy !== undefined
              ? patch.forcedSelectionPolicy
              : controls.forcedSelectionPolicy,
          allowedCostTiers:
            patch.allowedCostTiers !== undefined
              ? patch.allowedCostTiers
              : controls.allowedCostTiers,
        },
      },
      {
        onSuccess: async (fresh) => {
          setDefaultCapDraft(null);
          await acceptControls(fresh);
        },
        onError: writeFailed,
      },
    );
  };

  const saveDefaultCap = () => {
    if (defaultCapDraft === null) return;
    const parsed = parseCapInput(defaultCapDraft);
    if (parsed === undefined) {
      setFormError("A monthly cap is a number like 25, or empty for no cap.");
      return;
    }
    saveControls({ defaultMemberCapUsd: parsed });
  };

  const saveMemberCapDraft = (userId: string, draft: string) => {
    const parsed = parseCapInput(draft);
    if (parsed === undefined) {
      setFormError("A member cap is a number like 25, or empty for no cap.");
      return;
    }
    setMemberCap.mutate(
      { workspaceId, memberUserId: userId, data: { capUsd: parsed } },
      {
        onSuccess: async (fresh) => {
          setMemberEditor(null);
          await acceptControls(fresh);
        },
        onError: writeFailed,
      },
    );
  };

  const useDefaultCap = (userId: string) => {
    clearMemberCap.mutate(
      { workspaceId, memberUserId: userId },
      {
        onSuccess: async (fresh) => {
          setMemberEditor(null);
          await acceptControls(fresh);
        },
        onError: writeFailed,
      },
    );
  };

  const activeTiers: VenomModelCostTier[] =
    controls?.allowedCostTiers ?? COST_TIERS;

  const toggleTier = (tier: VenomModelCostTier) => {
    if (!controls) return;
    const next = activeTiers.includes(tier)
      ? activeTiers.filter((entry) => entry !== tier)
      : COST_TIERS.filter(
          (entry) => activeTiers.includes(entry) || entry === tier,
        );
    // A lock can never allow nothing; keep the last tier on.
    if (next.length === 0) return;
    saveControls({
      allowedCostTiers: next.length === COST_TIERS.length ? null : next,
    });
  };

  const membersSpend = memberRows.reduce((sum, row) => sum + row.spentUsd, 0);
  const departedSpend = usage ? usage.totalUsd - membersSpend : 0;
  const forcedPolicyValue = controls?.forcedSelectionPolicy ?? "off";

  return (
    <View testID="section-workspace-ai-controls">
      {/* ── Per-member usage, workspace-billed only ─────────────────────── */}
      <View
        style={[
          local.card,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        {usageQuery.isLoading ? (
          <ActivityIndicator size="small" color={colors.mutedForeground} />
        ) : usageQuery.isError || !usage ? (
          <Text style={[local.errorText, { color: colors.destructive }]}>
            Usage could not be loaded.
          </Text>
        ) : (
          <>
            <View style={local.totalRow}>
              <Text style={[local.label, { color: colors.mutedForeground }]}>
                Workspace AI this period
              </Text>
              <Text
                style={[local.figures, { color: colors.foreground }]}
                testID="workspace-usage-total"
              >
                {formatUsd(usage.totalUsd)} of ${usage.allowanceUsd}
              </Text>
            </View>
            {memberRows.map((row) => {
              const editing = memberEditor?.userId === row.clerkUserId;
              return (
                <View
                  key={row.clerkUserId}
                  style={[local.memberRow, { borderTopColor: colors.border }]}
                  testID={`workspace-usage-row-${row.clerkUserId}`}
                >
                  <View style={local.memberLine}>
                    <View style={local.memberNameWrap}>
                      <Text
                        style={[local.memberName, { color: colors.foreground }]}
                        numberOfLines={1}
                      >
                        {row.name}
                        {row.clerkUserId === myUserId ? " (you)" : ""}
                      </Text>
                      {row.role === "admin" && (
                        <View
                          style={[local.roleBadge, { borderColor: colors.border }]}
                        >
                          <Text
                            style={[
                              local.roleBadgeText,
                              { color: colors.mutedForeground },
                            ]}
                          >
                            Admin
                          </Text>
                        </View>
                      )}
                    </View>
                    <Text
                      style={[
                        local.memberSpent,
                        {
                          color:
                            row.capState === "exhausted"
                              ? colors.destructive
                              : colors.foreground,
                        },
                      ]}
                      testID={`workspace-usage-spent-${row.clerkUserId}`}
                    >
                      {formatUsd(row.spentUsd)}
                    </Text>
                    <TouchableOpacity
                      onPress={() => {
                        setFormError(null);
                        setMemberEditor(
                          editing
                            ? null
                            : {
                                userId: row.clerkUserId,
                                draft:
                                  row.capUsd === null
                                    ? ""
                                    : String(row.capUsd),
                              },
                        );
                      }}
                      style={[local.capChip, { borderColor: colors.border }]}
                      accessibilityRole="button"
                      accessibilityLabel={`Edit ${row.name}'s monthly cap`}
                      accessibilityState={{ expanded: editing }}
                      aria-expanded={editing}
                      testID={`button-member-cap-${row.clerkUserId}`}
                    >
                      <Text
                        style={[
                          local.capChipText,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        {row.capUsd === null
                          ? "No cap"
                          : `${formatUsd(row.capUsd)}${row.capSource === "override" ? " · custom" : ""}`}
                      </Text>
                    </TouchableOpacity>
                  </View>
                  {row.capState && row.capState !== "ok" && (
                    <Text
                      style={[
                        local.capStateText,
                        {
                          color:
                            row.capState === "exhausted"
                              ? colors.destructive
                              : colors.mutedForeground,
                        },
                      ]}
                      testID={`workspace-usage-capstate-${row.clerkUserId}`}
                    >
                      {row.capState === "exhausted"
                        ? "At their cap — their chats here are paused."
                        : "Close to their cap."}
                    </Text>
                  )}
                  {editing && (
                    <View style={local.editorRow}>
                      <TextInput
                        value={memberEditor.draft}
                        onChangeText={(value) =>
                          setMemberEditor({
                            userId: row.clerkUserId,
                            draft: value,
                          })
                        }
                        placeholder="No cap"
                        placeholderTextColor={colors.mutedForeground}
                        keyboardType="decimal-pad"
                        inputMode="decimal"
                        style={[
                          local.capInput,
                          {
                            borderColor: colors.border,
                            color: colors.foreground,
                            backgroundColor: colors.background,
                          },
                        ]}
                        accessibilityLabel={`Monthly cap in dollars for ${row.name}`}
                        testID={`input-member-cap-${row.clerkUserId}`}
                      />
                      <TouchableOpacity
                        onPress={() =>
                          saveMemberCapDraft(row.clerkUserId, memberEditor.draft)
                        }
                        disabled={busy}
                        style={[
                          local.smallButton,
                          {
                            backgroundColor: colors.primary,
                            opacity: busy ? 0.5 : 1,
                          },
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel={`Save ${row.name}'s monthly cap`}
                        testID={`button-save-member-cap-${row.clerkUserId}`}
                      >
                        {setMemberCap.isPending ? (
                          <ActivityIndicator
                            size="small"
                            color={colors.primaryForeground}
                          />
                        ) : (
                          <Text
                            style={[
                              local.smallButtonText,
                              { color: colors.primaryForeground },
                            ]}
                          >
                            Set
                          </Text>
                        )}
                      </TouchableOpacity>
                      {row.capSource === "override" && (
                        <TouchableOpacity
                          onPress={() => useDefaultCap(row.clerkUserId)}
                          disabled={busy}
                          style={[
                            local.smallButton,
                            local.outlineButton,
                            {
                              borderColor: colors.border,
                              opacity: busy ? 0.5 : 1,
                            },
                          ]}
                          accessibilityRole="button"
                          accessibilityLabel={`Use the workspace default cap for ${row.name}`}
                          testID={`button-clear-member-cap-${row.clerkUserId}`}
                        >
                          <Text
                            style={[
                              local.smallButtonText,
                              { color: colors.foreground },
                            ]}
                          >
                            Use default
                          </Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  )}
                </View>
              );
            })}
            {departedSpend > 0.005 && (
              <Text style={[local.footNote, { color: colors.mutedForeground }]}>
                Includes {formatUsd(departedSpend)} by people no longer in the
                workspace.
              </Text>
            )}
            <Text style={[local.footNote, { color: colors.mutedForeground }]}>
              Only AI billed to this workspace is counted — nobody&rsquo;s
              personal space shows up here.
            </Text>
          </>
        )}
      </View>

      {/* ── Spend caps and model locks ──────────────────────────────────── */}
      <View
        style={[
          local.card,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        {controlsQuery.isLoading ? (
          <ActivityIndicator size="small" color={colors.mutedForeground} />
        ) : controlsQuery.isError || !controls ? (
          <Text style={[local.errorText, { color: colors.destructive }]}>
            Controls could not be loaded.
          </Text>
        ) : (
          <>
            <Text style={[local.controlTitle, { color: colors.foreground }]}>
              Monthly cap per member
            </Text>
            <Text style={[local.controlHint, { color: colors.mutedForeground }]}>
              Once someone spends this much workspace AI in a period, their
              chats here pause until it resets. Their personal space is never
              affected. Leave empty for no cap.
            </Text>
            <View style={local.editorRow}>
              <TextInput
                value={
                  defaultCapDraft ??
                  (controls.defaultMemberCapUsd === null
                    ? ""
                    : String(controls.defaultMemberCapUsd))
                }
                onChangeText={(value) => setDefaultCapDraft(value)}
                placeholder="No cap"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="decimal-pad"
                inputMode="decimal"
                style={[
                  local.capInput,
                  {
                    borderColor: colors.border,
                    color: colors.foreground,
                    backgroundColor: colors.background,
                  },
                ]}
                accessibilityLabel="Default monthly cap in dollars for every member"
                testID="input-default-member-cap"
              />
              <TouchableOpacity
                onPress={saveDefaultCap}
                disabled={busy || defaultCapDraft === null}
                style={[
                  local.smallButton,
                  {
                    backgroundColor: colors.primary,
                    opacity: busy || defaultCapDraft === null ? 0.5 : 1,
                  },
                ]}
                accessibilityRole="button"
                accessibilityLabel="Save the default monthly cap"
                testID="button-save-default-cap"
              >
                {updateControls.isPending ? (
                  <ActivityIndicator
                    size="small"
                    color={colors.primaryForeground}
                  />
                ) : (
                  <Text
                    style={[
                      local.smallButtonText,
                      { color: colors.primaryForeground },
                    ]}
                  >
                    Save
                  </Text>
                )}
              </TouchableOpacity>
            </View>

            <Text
              style={[
                local.controlTitle,
                local.controlTitleSpaced,
                { color: colors.foreground },
              ]}
            >
              Model choice in this workspace
            </Text>
            <Text style={[local.controlHint, { color: colors.mutedForeground }]}>
              Forcing a policy overrides members&rsquo; own model settings for
              work billed here — they&rsquo;ll see their controls locked,
              labeled &ldquo;Managed by {workspaceName}&rdquo;.
            </Text>
            <View
              accessibilityRole="radiogroup"
              accessibilityLabel="Forced model policy"
            >
              {POLICY_CHOICES.map((choice) => {
                const selected = forcedPolicyValue === choice.value;
                return (
                  <TouchableOpacity
                    key={choice.value}
                    onPress={() =>
                      saveControls({
                        forcedSelectionPolicy:
                          choice.value === "off" ? null : choice.value,
                      })
                    }
                    disabled={busy}
                    style={local.policyRow}
                    accessibilityRole="radio"
                    accessibilityLabel={choice.title}
                    accessibilityState={{ selected, checked: selected }}
                    aria-checked={selected}
                    testID={`forced-policy-${choice.value}`}
                  >
                    <View
                      style={[
                        local.radio,
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
                          size={11}
                          color={colors.primaryForeground}
                        />
                      )}
                    </View>
                    <View style={local.policyCopy}>
                      <Text
                        style={[local.policyTitle, { color: colors.foreground }]}
                      >
                        {choice.title}
                      </Text>
                      <Text
                        style={[
                          local.policyDescription,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        {choice.description}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text
              style={[
                local.controlTitle,
                local.controlTitleSpaced,
                { color: colors.foreground },
              ]}
            >
              Allowed price tiers
            </Text>
            <Text style={[local.controlHint, { color: colors.mutedForeground }]}>
              Turn a tier off to keep workspace-billed requests off those
              models. All tiers on means no restriction.
            </Text>
            <View style={local.tierRow} accessibilityLabel="Allowed model price tiers">
              {COST_TIERS.map((tier) => {
                const active = activeTiers.includes(tier);
                const lastActive = active && activeTiers.length === 1;
                return (
                  <TouchableOpacity
                    key={tier}
                    onPress={() => toggleTier(tier)}
                    disabled={busy || lastActive}
                    style={[
                      local.tierChip,
                      {
                        borderColor: active ? colors.primary : colors.border,
                        backgroundColor: active
                          ? colors.primary
                          : "transparent",
                        opacity: lastActive ? 0.7 : busy ? 0.5 : 1,
                      },
                    ]}
                    accessibilityRole="checkbox"
                    accessibilityLabel={`Allow ${tier} tier models`}
                    accessibilityState={{
                      checked: active,
                      disabled: busy || lastActive,
                    }}
                    aria-checked={active}
                    testID={`tier-toggle-${tier}`}
                  >
                    <Text
                      style={[
                        local.tierChipText,
                        {
                          color: active
                            ? colors.primaryForeground
                            : colors.mutedForeground,
                        },
                      ]}
                    >
                      {tier}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {formError && (
              <Text
                style={[local.errorText, { color: colors.destructive }]}
                accessibilityLiveRegion="polite"
                testID="workspace-ai-controls-error"
              >
                {formError}
              </Text>
            )}
          </>
        )}
      </View>
    </View>
  );
}

const local = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 10,
  },
  totalRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 8,
  },
  label: { fontSize: 12 },
  figures: { fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"] },
  memberRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: 10,
    paddingTop: 10,
  },
  memberLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  memberNameWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
  },
  memberName: { fontSize: 13, fontWeight: "600", flexShrink: 1 },
  roleBadge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  roleBadgeText: { fontSize: 10, fontWeight: "600" },
  memberSpent: {
    fontSize: 12,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  capChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  capChipText: { fontSize: 11, fontWeight: "500" },
  capStateText: { fontSize: 11, marginTop: 4 },
  editorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
    flexWrap: "wrap",
  },
  capInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
    width: 96,
  },
  smallButton: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  outlineButton: { borderWidth: 1, backgroundColor: "transparent" },
  smallButtonText: { fontSize: 12, fontWeight: "600" },
  footNote: { fontSize: 11, marginTop: 10, lineHeight: 15 },
  errorText: { fontSize: 12, marginTop: 8 },
  controlTitle: { fontSize: 13, fontWeight: "600" },
  controlTitleSpaced: { marginTop: 16 },
  controlHint: { fontSize: 11, lineHeight: 15, marginTop: 2, marginBottom: 6 },
  policyRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 7,
  },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  policyCopy: { flex: 1 },
  policyTitle: { fontSize: 13, fontWeight: "600" },
  policyDescription: { fontSize: 11, lineHeight: 15, marginTop: 1 },
  tierRow: { flexDirection: "row", gap: 8, marginTop: 2 },
  tierChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
    minWidth: 44,
    alignItems: "center",
  },
  tierChipText: { fontSize: 12, fontWeight: "700" },
});
