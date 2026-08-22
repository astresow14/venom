import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetSharedWorkspaceAiControlsQueryKey,
  getGetSharedWorkspaceUsageQueryKey,
  getGetVenomBillingContextQueryKey,
  useClearSharedWorkspaceMemberAiCap,
  useGetSharedWorkspaceAiControls,
  useGetSharedWorkspaceUsage,
  useSetSharedWorkspaceMemberAiCap,
  useUpdateSharedWorkspaceAiControls,
  type SharedWorkspace,
  type VenomModelCostTier,
  type VenomWorkspaceAiControls,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { asList } from "@/lib/as-list";
import { cn } from "@/lib/utils";
import { Gauge, Loader2 } from "lucide-react";
import { formatUsd } from "@/components/workspace/UsageDialog";

const COST_TIERS: VenomModelCostTier[] = ["$", "$$", "$$$"];

/**
 * Parse an admin-entered dollar amount. Empty means "no cap"; anything else
 * must be a non-negative number (0 is a deliberate full block), capped at
 * the API's ceiling and rounded to cents.
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
export default function WorkspaceAiControlsSection({
  workspace,
  enabled,
  myUserId,
}: {
  workspace: SharedWorkspace;
  enabled: boolean;
  myUserId: string | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const usageQuery = useGetSharedWorkspaceUsage(workspace.id, {
    query: {
      queryKey: getGetSharedWorkspaceUsageQueryKey(workspace.id),
      enabled,
    },
  });
  const controlsQuery = useGetSharedWorkspaceAiControls(workspace.id, {
    query: {
      queryKey: getGetSharedWorkspaceAiControlsQueryKey(workspace.id),
      enabled,
    },
  });
  const usage = usageQuery.data;
  const controls = controlsQuery.data;
  const memberRows = asList(usage?.members);

  const updateControls = useUpdateSharedWorkspaceAiControls();
  const setMemberCap = useSetSharedWorkspaceMemberAiCap();
  const clearMemberCap = useClearSharedWorkspaceMemberAiCap();
  const busy =
    updateControls.isPending || setMemberCap.isPending || clearMemberCap.isPending;

  const [defaultCapDraft, setDefaultCapDraft] = useState<string | null>(null);
  const [memberEditor, setMemberEditor] = useState<{
    userId: string;
    draft: string;
  } | null>(null);

  /** Every write returns the fresh controls payload; states ride usage. */
  const acceptControls = async (fresh: VenomWorkspaceAiControls) => {
    queryClient.setQueryData(
      getGetSharedWorkspaceAiControlsQueryKey(workspace.id),
      fresh,
    );
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: getGetSharedWorkspaceUsageQueryKey(workspace.id),
      }),
      // Members' composers and model popups read lock/cap state from the
      // billing context; every param variant must refetch.
      queryClient.invalidateQueries({
        queryKey: getGetVenomBillingContextQueryKey(),
      }),
    ]);
  };

  const writeFailed = (error: unknown) => {
    const status = (error as { status?: number })?.status;
    toast({
      title: "Could not save the change",
      description:
        status === 403
          ? "Only admins of this workspace can change AI controls."
          : status === 404
            ? "They are no longer a member of this workspace."
            : "Try again in a moment.",
      variant: "destructive",
    });
  };

  const saveControls = (patch: {
    defaultMemberCapUsd?: number | null;
    forcedSelectionPolicy?: "auto-cheapest" | "auto-max-power" | null;
    allowedCostTiers?: VenomModelCostTier[] | null;
  }) => {
    if (!controls || busy) return;
    updateControls.mutate(
      {
        workspaceId: workspace.id,
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
      toast({
        title: "Enter a dollar amount",
        description: "A monthly cap is a number like 25, or empty for no cap.",
        variant: "destructive",
      });
      return;
    }
    saveControls({ defaultMemberCapUsd: parsed });
  };

  const saveMemberCap = (userId: string, draft: string) => {
    const parsed = parseCapInput(draft);
    if (parsed === undefined) {
      toast({
        title: "Enter a dollar amount",
        description: "A member cap is a number like 25, or empty for no cap.",
        variant: "destructive",
      });
      return;
    }
    setMemberCap.mutate(
      {
        workspaceId: workspace.id,
        memberUserId: userId,
        data: { capUsd: parsed },
      },
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
      { workspaceId: workspace.id, memberUserId: userId },
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

  return (
    <div
      className="mt-5 border-t border-border/60 pt-5"
      data-testid="section-workspace-ai-controls"
    >
      <div className="flex items-center gap-2 text-[10px] font-medium text-muted-foreground">
        <Gauge className="h-3 w-3" aria-hidden="true" />
        AI usage &amp; controls
      </div>

      {/* ── Per-member usage, workspace-billed only ─────────────────────── */}
      <div className="mt-3 rounded-lg border border-border/60 bg-foreground/[0.03] px-3 py-3">
        {usageQuery.isLoading ? (
          <Skeleton className="h-16 w-full rounded-lg" />
        ) : usageQuery.isError || !usage ? (
          <p className="text-xs text-destructive">
            Usage could not be loaded.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="text-muted-foreground">
                Workspace AI this period
              </span>
              <span
                className="font-medium tabular-nums"
                data-testid="workspace-usage-total"
              >
                {formatUsd(usage.totalUsd)} of ${usage.allowanceUsd}
              </span>
            </div>
            <ul className="divide-y divide-border/40">
              {memberRows.map((row) => {
                const editing = memberEditor?.userId === row.clerkUserId;
                return (
                  <li
                    key={row.clerkUserId}
                    className="py-1.5"
                    data-testid={`workspace-usage-row-${row.clerkUserId}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <span className="truncate text-xs font-medium">
                          {row.name}
                          {row.clerkUserId === myUserId && (
                            <span className="ml-1 text-muted-foreground">
                              (you)
                            </span>
                          )}
                        </span>
                        {row.role === "admin" && (
                          <span className="ml-2 rounded-full border border-border/60 px-1.5 py-px text-[10px] text-muted-foreground">
                            Admin
                          </span>
                        )}
                      </div>
                      <span
                        className={cn(
                          "shrink-0 text-xs tabular-nums",
                          row.capState === "exhausted" && "text-destructive",
                          row.capState === "approaching" &&
                            "font-medium text-foreground/80",
                        )}
                        data-testid={`workspace-usage-spent-${row.clerkUserId}`}
                      >
                        {formatUsd(row.spentUsd)}
                      </span>
                      <button
                        type="button"
                        className="shrink-0 rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() =>
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
                          )
                        }
                        aria-expanded={editing}
                        aria-label={`Edit ${row.name}'s monthly cap`}
                        data-testid={`button-member-cap-${row.clerkUserId}`}
                      >
                        {row.capUsd === null
                          ? "No cap"
                          : `${formatUsd(row.capUsd)}${row.capSource === "override" ? " · custom" : ""}`}
                      </button>
                    </div>
                    {row.capState !== "ok" && (
                      <p
                        className={cn(
                          "mt-0.5 text-[11px]",
                          row.capState === "exhausted"
                            ? "text-destructive"
                            : "text-foreground/70",
                        )}
                        data-testid={`workspace-usage-capstate-${row.clerkUserId}`}
                      >
                        {row.capState === "exhausted"
                          ? "At their cap — their chats here are paused."
                          : "Close to their cap."}
                      </p>
                    )}
                    {editing && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step="1"
                          value={memberEditor.draft}
                          onChange={(event) =>
                            setMemberEditor({
                              userId: row.clerkUserId,
                              draft: event.target.value,
                            })
                          }
                          placeholder="No cap"
                          aria-label={`Monthly cap in dollars for ${row.name}`}
                          className="h-7 w-24 text-xs"
                          data-testid={`input-member-cap-${row.clerkUserId}`}
                        />
                        <Button
                          type="button"
                          size="sm"
                          className="h-7 rounded-full text-xs"
                          disabled={busy}
                          onClick={() =>
                            saveMemberCap(row.clerkUserId, memberEditor.draft)
                          }
                          data-testid={`button-save-member-cap-${row.clerkUserId}`}
                        >
                          {setMemberCap.isPending ? (
                            <Loader2
                              className="h-3 w-3 animate-spin"
                              aria-hidden="true"
                            />
                          ) : (
                            "Set"
                          )}
                        </Button>
                        {row.capSource === "override" && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 rounded-full text-xs"
                            disabled={busy}
                            onClick={() => useDefaultCap(row.clerkUserId)}
                            data-testid={`button-clear-member-cap-${row.clerkUserId}`}
                          >
                            Use workspace default
                          </Button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {departedSpend > 0.005 && (
              <p className="text-[11px] text-muted-foreground">
                Includes {formatUsd(departedSpend)} by people no longer in the
                workspace.
              </p>
            )}
            <p className="text-[11px] text-muted-foreground">
              Only AI billed to this workspace is counted — nobody&rsquo;s
              personal space shows up here.
            </p>
          </div>
        )}
      </div>

      {/* ── Spend caps and model locks ──────────────────────────────────── */}
      <div className="mt-3 rounded-lg border border-border/60 bg-foreground/[0.03] px-3 py-3">
        {controlsQuery.isLoading ? (
          <Skeleton className="h-16 w-full rounded-lg" />
        ) : controlsQuery.isError || !controls ? (
          <p className="text-xs text-destructive">
            Controls could not be loaded.
          </p>
        ) : (
          <div className="space-y-4">
            <div>
              <label
                htmlFor="workspace-default-cap"
                className="text-sm font-medium"
              >
                Monthly cap per member
              </label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Once someone spends this much workspace AI in a period, their
                chats here pause until it resets. Their personal space is
                never affected. Leave empty for no cap.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <Input
                  id="workspace-default-cap"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="1"
                  value={
                    defaultCapDraft ??
                    (controls.defaultMemberCapUsd === null
                      ? ""
                      : String(controls.defaultMemberCapUsd))
                  }
                  onChange={(event) => setDefaultCapDraft(event.target.value)}
                  placeholder="No cap"
                  className="h-8 w-28 text-xs"
                  data-testid="input-default-member-cap"
                />
                <Button
                  type="button"
                  size="sm"
                  className="h-8 rounded-full text-xs"
                  disabled={busy || defaultCapDraft === null}
                  onClick={saveDefaultCap}
                  data-testid="button-save-default-cap"
                >
                  {updateControls.isPending ? (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    "Save"
                  )}
                </Button>
              </div>
            </div>

            <div>
              <label
                htmlFor="workspace-forced-policy"
                className="text-sm font-medium"
              >
                Model choice in this workspace
              </label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Forcing a policy overrides members&rsquo; own model settings
                for work billed here — they&rsquo;ll see their controls
                locked. Personal spaces stay theirs.
              </p>
              <Select
                value={controls.forcedSelectionPolicy ?? "off"}
                onValueChange={(value) =>
                  saveControls({
                    forcedSelectionPolicy:
                      value === "off"
                        ? null
                        : (value as "auto-cheapest" | "auto-max-power"),
                  })
                }
                disabled={busy}
              >
                <SelectTrigger
                  id="workspace-forced-policy"
                  className="mt-2 h-8 w-full text-xs"
                  data-testid="select-forced-policy"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">Members choose</SelectItem>
                  <SelectItem value="auto-cheapest">
                    Always cheapest usable model
                  </SelectItem>
                  <SelectItem value="auto-max-power">
                    Always most capable model
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <span className="text-sm font-medium">Allowed price tiers</span>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Uncheck a tier to keep workspace-billed requests off those
                models. All tiers on means no restriction.
              </p>
              <div
                className="mt-2 flex items-center gap-2"
                role="group"
                aria-label="Allowed model price tiers"
              >
                {COST_TIERS.map((tier) => {
                  const active = activeTiers.includes(tier);
                  const lastActive = active && activeTiers.length === 1;
                  return (
                    <button
                      key={tier}
                      type="button"
                      role="checkbox"
                      aria-checked={active}
                      aria-label={`Allow ${tier} tier models`}
                      disabled={busy || lastActive}
                      onClick={() => toggleTier(tier)}
                      className={cn(
                        "rounded-full border px-3 py-1 font-mono text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        active
                          ? "border-foreground/60 bg-foreground text-background"
                          : "border-border/60 text-muted-foreground hover:bg-foreground/[0.06]",
                        lastActive && "cursor-not-allowed opacity-70",
                      )}
                      data-testid={`tier-toggle-${tier}`}
                    >
                      {tier}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
