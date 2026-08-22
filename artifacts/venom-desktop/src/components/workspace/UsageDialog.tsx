/**
 * UsageDialog – the desktop surface for personal AI spend.
 *
 * Reads the account-scoped usage summary: what this month's AI calls cost
 * in dollars, how spend moved day by day, and which Venom models carried
 * it. Costs are computed server-side from a private pricing table — this
 * surface only ever sees dollar amounts under Venom-branded model names.
 * Entries the provider didn't report exactly (interrupted replies, voice
 * audio) arrive flagged, and the caveat renders whenever any are present.
 */

import React, { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  createVenomBillingCheckout,
  createVenomBillingPortal,
  getVenomBillingSummary,
  getVenomUsageSummary,
} from "@workspace/api-client-react";
import type {
  VenomBillingSummary,
  VenomUsageSummary,
} from "@workspace/api-client-react";

/** Dollar display: exact to the cent, honest about dust. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

/** Compact token/request counts: 940, 12.4k, 3.1M. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) {
    const k = value / 1_000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
  }
  const m = value / 1_000_000;
  return `${m >= 100 ? Math.round(m) : m.toFixed(1)}M`;
}

/** "2026-08-01" → "Aug 2026" (UTC month the period covers). */
function monthLabel(periodStart: string): string {
  const date = new Date(`${periodStart}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "This month";
  return date.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "2026-08-14" → "Aug 14" for bar tooltips and axis ends. */
function dayLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** ISO timestamp → "September 1, 2026" for renewal/reset lines. */
function renewalLabel(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "next period";
  return parsed.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The personal plan card: current plan, renewal, and an allowance meter of
 * this period's personally-billed spend against what the plan includes.
 * Workspace-billed usage never moves this meter — it isn't the member's
 * money. With Stripe unconfigured the card stays informative but quiet.
 */
function PlanCard({ billing }: { billing: VenomBillingSummary }) {
  const [busy, setBusy] = useState<"checkout" | "portal" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const allowance = billing.plan.allowanceUsd;
  const spentShare =
    allowance > 0 ? Math.min(billing.spentUsd / allowance, 1) : 1;
  const periodEndLabel = renewalLabel(billing.periodEnd);

  const openStripePage = async (kind: "checkout" | "portal") => {
    setBusy(kind);
    setActionError(null);
    try {
      const body = { returnUrl: window.location.href };
      const { url } =
        kind === "checkout"
          ? await createVenomBillingCheckout(body)
          : await createVenomBillingPortal(body);
      window.open(url, "_blank", "noopener");
    } catch {
      setActionError(
        kind === "checkout"
          ? "Checkout couldn't be started. Try again in a moment."
          : "The billing portal couldn't be opened. Try again in a moment.",
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="rounded-lg border border-border/60 p-4"
      data-testid="billing-plan-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Your plan
          </div>
          <div
            className="mt-0.5 text-lg font-semibold text-foreground"
            data-testid="billing-plan-name"
          >
            {billing.plan.name}
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {billing.plan.priceUsd > 0
                ? `$${billing.plan.priceUsd}/mo`
                : "Free"}
            </span>
          </div>
          <div
            className="mt-0.5 text-xs text-muted-foreground"
            data-testid="billing-renewal"
          >
            {billing.cancelAtPeriodEnd
              ? `Ends ${periodEndLabel}`
              : billing.renews
                ? `Renews ${periodEndLabel}`
                : `Allowance resets ${periodEndLabel}`}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {billing.configured ? (
            <>
              {billing.upgradePlan && (
                <button
                  type="button"
                  data-testid="billing-upgrade"
                  disabled={busy !== null}
                  onClick={() => void openStripePage("checkout")}
                  className="rounded-full bg-foreground px-3.5 py-1.5 text-sm font-semibold text-background transition-opacity hover:opacity-85 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {busy === "checkout" ? (
                    <Loader2
                      className="h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    `Upgrade to ${billing.upgradePlan.name}`
                  )}
                </button>
              )}
              {billing.manageable && (
                <button
                  type="button"
                  data-testid="billing-manage"
                  disabled={busy !== null}
                  onClick={() => void openStripePage("portal")}
                  className="rounded-full border border-border/60 px-3.5 py-1.5 text-sm font-medium text-foreground/80 transition-colors hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {busy === "portal" ? (
                    <Loader2
                      className="h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    "Manage billing"
                  )}
                </button>
              )}
            </>
          ) : (
            <span
              className="rounded-full border border-dashed border-border/60 px-3 py-1 text-xs text-muted-foreground"
              data-testid="billing-not-configured"
            >
              Billing not set up yet
            </span>
          )}
        </div>
      </div>

      {/* Allowance meter */}
      <div className="mt-3">
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-muted-foreground">Included AI this period</span>
          <span
            className="font-medium tabular-nums text-foreground"
            data-testid="billing-meter-figures"
          >
            {formatUsd(billing.spentUsd)} of ${allowance}
          </span>
        </div>
        <div
          className="mt-1.5 h-2 overflow-hidden rounded-full bg-foreground/10"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(spentShare * 100)}
          aria-label="Share of included AI used this period"
          data-testid="billing-meter"
        >
          <div
            className={cn(
              "h-full rounded-full bg-foreground/80 transition-[width]",
              billing.state === "exhausted" && "bg-destructive",
            )}
            style={{ width: `${Math.max(spentShare * 100, 2)}%` }}
          />
        </div>
        {billing.state === "exhausted" ? (
          <p
            className="mt-2 text-xs font-medium text-destructive"
            role="status"
            data-testid="billing-state-exhausted"
          >
            {billing.upgradePlan
              ? "You've used this period's included AI. Upgrade to keep going, or wait for the reset."
              : "You've used this period's included AI. It comes back at the reset."}
          </p>
        ) : billing.state === "approaching" ? (
          <p
            className="mt-2 text-xs font-medium text-foreground/80"
            role="status"
            data-testid="billing-state-approaching"
          >
            You're close to this period's included AI —{" "}
            {formatUsd(billing.remainingUsd)} left.
          </p>
        ) : null}
        {actionError && (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {actionError}
          </p>
        )}
      </div>
    </div>
  );
}

export default function UsageDialog({
  trigger,
}: {
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<VenomUsageSummary | null>(null);
  const [failed, setFailed] = useState(false);
  // Plan/allowance state loads beside the ledger; a billing hiccup only
  // hides the plan card — the spend view must never depend on Stripe.
  const [billing, setBilling] = useState<VenomBillingSummary | null>(null);
  // Bumps to refetch after a failure without reopening the dialog.
  const [attempt, setAttempt] = useState(0);

  // Fetch lazily: the ledger is only read once the dialog opens.
  useEffect(() => {
    if (!open) return;
    let stale = false;
    setFailed(false);
    getVenomUsageSummary()
      .then((data) => {
        if (!stale) setSummary(data);
      })
      .catch(() => {
        if (!stale) setFailed(true);
      });
    getVenomBillingSummary()
      .then((data) => {
        if (!stale) setBilling(data);
      })
      .catch(() => {
        if (!stale) setBilling(null);
      });
    return () => {
      stale = true;
    };
  }, [open, attempt]);

  const loading = summary === null && !failed;
  const empty = summary !== null && summary.totals.requests === 0;
  // Older cached payloads can predate the covered-workspaces field; treat
  // absence as "nothing covered" instead of crashing the dialog.
  const coveredByWorkspaces = summary?.coveredByWorkspaces ?? [];
  const maxDailyCost = summary
    ? Math.max(...summary.daily.map((day) => day.costUsd), 0)
    : 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-lg" data-testid="dialog-usage">
        <DialogHeader>
          <DialogTitle>Usage</DialogTitle>
          <DialogDescription>
            What your AI activity has cost this month, across all your
            devices. Only you can see this.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div
            className="flex items-center gap-2 py-6 text-sm text-muted-foreground"
            data-testid="usage-loading"
          >
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Adding up this month…
          </div>
        ) : failed ? (
          <div className="py-4" data-testid="usage-error">
            <p className="text-sm text-destructive" role="status">
              Your usage couldn&rsquo;t be loaded. Check your connection and
              try again.
            </p>
            <button
              type="button"
              data-testid="usage-retry"
              onClick={() => {
                setSummary(null);
                setAttempt((n) => n + 1);
              }}
              className="mt-3 rounded-full border border-border/60 px-3 py-1.5 text-sm font-medium text-foreground/80 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Try again
            </button>
          </div>
        ) : summary ? (
          <div className="space-y-5">
            {/* Render only a well-shaped summary: an SPA fallback or proxy
                can answer this endpoint with truthy non-JSON garbage. */}
            {billing?.plan && <PlanCard billing={billing} />}

            {/* Month headline */}
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {monthLabel(summary.periodStart)}
              </div>
              <div className="mt-1 flex items-baseline gap-3">
                <span
                  className="text-3xl font-semibold tabular-nums text-foreground"
                  data-testid="usage-month-total"
                >
                  {formatUsd(summary.totals.costUsd)}
                </span>
                <span
                  className="text-xs text-muted-foreground"
                  data-testid="usage-requests-total"
                >
                  {formatCount(summary.totals.requests)}{" "}
                  {summary.totals.requests === 1 ? "request" : "requests"} ·{" "}
                  {formatCount(
                    summary.totals.promptTokens + summary.totals.outputTokens,
                  )}{" "}
                  tokens
                </span>
              </div>
            </div>

            {empty ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="usage-empty"
              >
                Nothing metered yet this month. Costs appear here as soon as
                Venom answers you.
              </p>
            ) : (
              <>
                {/* Daily trend */}
                <div>
                  <div className="mb-2 text-sm font-semibold">Daily spend</div>
                  <div
                    className="flex h-20 items-end gap-[3px]"
                    role="img"
                    aria-label="Daily spend this month"
                    data-testid="usage-daily-trend"
                  >
                    {summary.daily.map((day) => {
                      const share =
                        maxDailyCost > 0 ? day.costUsd / maxDailyCost : 0;
                      return (
                        <div
                          key={day.date}
                          title={`${dayLabel(day.date)} — ${formatUsd(day.costUsd)} · ${formatCount(day.requests)} ${day.requests === 1 ? "request" : "requests"}`}
                          data-testid={`usage-day-${day.date}`}
                          className={cn(
                            "min-w-[6px] flex-1 rounded-t-sm bg-foreground/80",
                            share === 0 && "bg-foreground/20",
                          )}
                          style={{
                            height: `${Math.max(share * 100, day.costUsd > 0 ? 6 : 3)}%`,
                          }}
                        />
                      );
                    })}
                  </div>
                  {summary.daily.length > 0 && (
                    <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                      <span>{dayLabel(summary.daily[0].date)}</span>
                      {summary.daily.length > 1 && (
                        <span>
                          {dayLabel(
                            summary.daily[summary.daily.length - 1].date,
                          )}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Per-model breakdown */}
                <div>
                  <div className="mb-2 text-sm font-semibold">By model</div>
                  <ul className="space-y-1.5">
                    {summary.models.map((model) => (
                      <li
                        key={model.modelId}
                        data-testid={`usage-model-row-${model.modelId}`}
                        className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-foreground">
                            {model.modelName}
                            {model.hasEstimates && (
                              <span
                                className="text-muted-foreground"
                                title="Includes estimated entries"
                                aria-label="Includes estimated entries"
                              >
                                {" "}
                                *
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {formatCount(model.requests)}{" "}
                            {model.requests === 1 ? "request" : "requests"} ·{" "}
                            {formatCount(model.promptTokens)} in /{" "}
                            {formatCount(model.outputTokens)} out
                          </div>
                        </div>
                        <div className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
                          {formatUsd(model.costUsd)}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>

                {summary.hasEstimates && (
                  <p
                    className="text-xs leading-5 text-muted-foreground"
                    data-testid="usage-estimate-note"
                  >
                    * Some entries are estimates: a provider didn&rsquo;t
                    report exact token counts (interrupted replies, for
                    example), or the call was a voice audio leg, which is
                    metered at a flat per-request rate.
                  </p>
                )}
              </>
            )}

            {coveredByWorkspaces.length > 0 && (
              <p
                className="text-xs leading-5 text-muted-foreground"
                data-testid="usage-covered-note"
              >
                Some of your AI activity was covered by{" "}
                {coveredByWorkspaces
                  .map((workspace) => workspace.name)
                  .join(", ")}
                . It&rsquo;s billed to {coveredByWorkspaces.length === 1
                  ? "that workspace's plan"
                  : "those workspaces' plans"}{" "}
                and doesn&rsquo;t count against yours.
              </p>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
