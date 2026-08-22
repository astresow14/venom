/**
 * NetworkContributionDialog – the desktop consent surface for Venom's
 * anonymous master ontology ("the Venom network").
 *
 * Contribution is an explicit choice and stays off until the account turns
 * it on. The dialog spells out exactly what leaves the account when it is
 * on — concept labels, categories, and connection pairs, as anonymous
 * aggregate signals — and what never does: chats, notes, sources, evidence,
 * names. The server enforces the same boundary; this surface only reads and
 * writes the consent flag.
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
  getVenomMasterContribution,
  updateVenomMasterContribution,
} from "@workspace/api-client-react";

export default function NetworkContributionDialog({
  trigger,
}: {
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // null = still loading the current setting.
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  // Fetch lazily: the setting is only needed once the dialog opens.
  useEffect(() => {
    if (!open) return;
    let stale = false;
    setFailed(false);
    getVenomMasterContribution()
      .then((setting) => {
        if (!stale) setEnabled(setting.enabled);
      })
      .catch(() => {
        if (!stale) setFailed(true);
      });
    return () => {
      stale = true;
    };
  }, [open]);

  const choose = async (next: boolean) => {
    if (busy || enabled === null || next === enabled) return;
    setBusy(true);
    setFailed(false);
    try {
      const updated = await updateVenomMasterContribution({ enabled: next });
      setEnabled(updated.enabled);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        className="max-w-md"
        data-testid="dialog-network-contribution"
      >
        <DialogHeader>
          <DialogTitle>Venom network</DialogTitle>
          <DialogDescription>
            Help improve Venom's shared knowledge network — an anonymous map
            of how ideas connect, built only from accounts that choose to
            contribute.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div>
            <div className="mb-2 text-sm font-semibold">Contribution</div>
            {enabled === null && !failed ? (
              <div
                className="flex items-center gap-2 text-sm text-muted-foreground"
                data-testid="network-contribution-loading"
              >
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Checking your setting…
              </div>
            ) : (
              <div
                role="radiogroup"
                aria-label="Contribution"
                className="grid grid-cols-2 gap-2"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={enabled === false}
                  data-testid="network-contribution-off"
                  disabled={busy || enabled === null}
                  onClick={() => void choose(false)}
                  className={cn(
                    "rounded-full border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
                    enabled === false
                      ? "border-foreground bg-foreground text-background"
                      : "border-border/60 bg-transparent text-foreground/80 hover:bg-muted",
                  )}
                >
                  Keep private
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={enabled === true}
                  data-testid="network-contribution-on"
                  disabled={busy || enabled === null}
                  onClick={() => void choose(true)}
                  className={cn(
                    "rounded-full border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
                    enabled === true
                      ? "border-foreground bg-foreground text-background"
                      : "border-border/60 bg-transparent text-foreground/80 hover:bg-muted",
                  )}
                >
                  Contribute
                </button>
              </div>
            )}
            {failed && (
              <p
                className="mt-2 text-xs text-destructive"
                role="status"
                data-testid="network-contribution-error"
              >
                That didn't reach the server. Check your connection and try
                again.
              </p>
            )}
          </div>

          <div className="space-y-3 text-xs leading-5 text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">
                Shared when on:
              </span>{" "}
              concept names, their categories, and which concepts connect —
              as anonymous, aggregate signals.
            </p>
            <p>
              <span className="font-medium text-foreground">
                Never shared:
              </span>{" "}
              chats, notes, sources, evidence, file contents, or anything
              identifying you. Rare concepts stay hidden until they are
              common across many accounts.
            </p>
            <p data-testid="network-contribution-optout-note">
              Off unless you turn it on. Turning it off stops contribution
              and removes your influence from future network updates.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
