import { Loader2 } from "lucide-react";
import type { VenomCanonDraft } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";

export type CanonTeachState = {
  /** Conversation the teaching came from; the card renders only there. */
  convId: string;
  /** The admin message the draft was distilled from. */
  userMessageId: string;
  message: string;
  phase: "probing" | "confirm" | "committing";
  draft?: VenomCanonDraft;
  error?: string | null;
};

/**
 * The teach confirmation card: before anything becomes canon, the super
 * admin sees exactly what Venom is about to keep — the skill domain and the
 * distilled principles — and nothing commits until they say so. Cancel turns
 * the message back into an ordinary chat turn.
 *
 * Rendered only for super admins (the flow that sets its state is gated on
 * the identity flag, and the server re-verifies the role on every call), so
 * regular users never see this surface. Mirror of the mobile card
 * (artifacts/venom/components/chat/CanonTeachCard.tsx) — keep behavior in
 * both.
 */
export function CanonTeachCard({
  state,
  onConfirm,
  onCancel,
}: {
  state: CanonTeachState;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const busy = state.phase === "committing";

  return (
    <div
      data-testid="canon-teach-card"
      className="mx-auto mb-2 w-full max-w-3xl rounded-2xl border border-border/60 surface p-4 text-sm"
    >
      {state.phase === "probing" ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          <span>Reading this as a teaching…</span>
        </div>
      ) : (
        <div className="grid gap-2">
          <p className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            Add to canon · {state.draft?.domain}
          </p>
          <p
            data-testid="canon-teach-title"
            className="font-semibold text-foreground"
          >
            {state.draft?.title}
          </p>
          <ul className="grid gap-1.5">
            {(state.draft?.principles ?? []).map((principle, index) => (
              <li key={index} className="flex gap-2 leading-relaxed">
                <span className="text-muted-foreground" aria-hidden="true">
                  —
                </span>
                <span className="flex-1 text-foreground/90">{principle}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            This will shape Venom's answers for everyone. Nothing is stored
            until you confirm.
          </p>
          {state.error ? (
            <p
              data-testid="canon-teach-error"
              className="text-xs text-destructive"
            >
              {state.error}
            </p>
          ) : null}
          <div className="mt-1 flex gap-2">
            <Button
              type="button"
              size="sm"
              data-testid="canon-teach-confirm"
              disabled={busy}
              onClick={onConfirm}
            >
              {busy ? (
                <Loader2
                  className="mr-1.5 h-3.5 w-3.5 animate-spin"
                  aria-hidden="true"
                />
              ) : null}
              Make it canon
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="canon-teach-cancel"
              disabled={busy}
              onClick={onCancel}
            >
              Just chat
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
