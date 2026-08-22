import { useState } from "react";
import {
  getGetVenomAppAiQueryKey,
  useGetVenomAppAi,
  useRevokeVenomAppAiCredential,
  useRotateVenomAppAiCredential,
  useUpdateVenomAppAiSettings,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, Sparkles } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";

/**
 * Owner controls for an app's whitelabeled AI: metered usage for the current
 * calendar month, the monthly spend cap, the instant pause switch, and the
 * gateway credential (rotate / revoke).
 *
 * The credential secret is never available here — it is delivered only into
 * the provisioned app's secret storage. This panel sees a display prefix.
 */

type AiModelUsage = {
  modelId: string;
  modelName: string;
  costUsd: number;
  requests: number;
};

type AiOverview = {
  appId: string;
  paused: boolean;
  monthlyCapUsd: number | null;
  safetyCapUsd: number;
  credential: {
    displayPrefix: string;
    createdAt: string;
    lastUsedAt: string | null;
    delivered: boolean;
  } | null;
  usage: {
    periodStart: string;
    periodEnd: string;
    costUsd: number;
    requests: number;
    promptTokens: number;
    outputTokens: number;
    hasEstimates: boolean;
    models: AiModelUsage[];
  };
  ownerMonthUsd: number;
};

/**
 * The generated client resolves failed requests to their JSON error body,
 * so every read is guarded before use.
 */
function isAiOverview(data: unknown): data is AiOverview {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  return (
    typeof record.appId === "string" &&
    typeof record.paused === "boolean" &&
    typeof record.usage === "object" &&
    record.usage !== null &&
    typeof (record.usage as Record<string, unknown>).costUsd === "number"
  );
}

function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return "< $0.01";
  return `$${value.toFixed(2)}`;
}

export default function AiUsagePanel({
  app,
}: {
  app: { id: string; name: string };
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const aiKey = getGetVenomAppAiQueryKey(app.id);
  const aiQuery = useGetVenomAppAi(app.id, { query: { queryKey: aiKey } });
  const overview = isAiOverview(aiQuery.data) ? aiQuery.data : null;

  // null = not editing; the input shows the saved cap until touched.
  const [capDraft, setCapDraft] = useState<string | null>(null);

  const applyOverview = (data: unknown) => {
    if (isAiOverview(data)) {
      queryClient.setQueryData(aiKey, data);
    } else {
      void queryClient.invalidateQueries({ queryKey: aiKey });
    }
  };
  const mutationToastError = (title: string) => () =>
    toast({
      title,
      description: "Try again in a moment.",
      variant: "destructive",
    });

  const updateSettings = useUpdateVenomAppAiSettings({
    mutation: {
      onSuccess: data => {
        applyOverview(data);
        setCapDraft(null);
      },
      onError: mutationToastError("Couldn't update AI settings"),
    },
  });
  const rotateCredential = useRotateVenomAppAiCredential({
    mutation: {
      onSuccess: data => {
        applyOverview(data);
        toast({
          title: "AI key rotated",
          description:
            isAiOverview(data) && data.credential?.delivered
              ? "The app already has the new key."
              : "The new key ships with the app's next update.",
        });
      },
      onError: mutationToastError("Couldn't rotate the AI key"),
    },
  });
  const revokeCredential = useRevokeVenomAppAiCredential({
    mutation: {
      onSuccess: data => {
        applyOverview(data);
        toast({
          title: "AI key revoked",
          description: "The app's AI calls stop until you issue a new key.",
        });
      },
      onError: mutationToastError("Couldn't revoke the AI key"),
    },
  });

  const saveCap = () => {
    if (!overview) return;
    const raw = (capDraft ?? "").trim();
    let cap: number | null = null;
    if (raw !== "") {
      cap = Number(raw);
      if (!Number.isFinite(cap) || cap < 0.01 || cap > 100000) {
        toast({
          title: "Cap must be between $0.01 and $100,000",
          variant: "destructive",
        });
        return;
      }
    }
    updateSettings.mutate({
      appId: app.id,
      data: { paused: overview.paused, monthlyCapUsd: cap },
    });
  };

  const setPaused = (paused: boolean) => {
    if (!overview) return;
    updateSettings.mutate({
      appId: app.id,
      data: { paused, monthlyCapUsd: overview.monthlyCapUsd },
    });
  };

  const capValue = capDraft ?? overview?.monthlyCapUsd?.toString() ?? "";
  const capDirty =
    capDraft !== null &&
    capDraft.trim() !== (overview?.monthlyCapUsd?.toString() ?? "");

  return (
    <div
      className="border border-border/60 surface p-5 rounded-xl shadow-soft"
      data-testid={`card-app-ai-${app.id}`}
    >
      <div className="flex items-center justify-between gap-3 mb-1">
        <h3 className="text-sm font-semibold tracking-tight flex items-center gap-2">
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          App AI
        </h3>
        <Switch
          checked={overview ? !overview.paused : false}
          disabled={!overview || updateSettings.isPending}
          onCheckedChange={next => setPaused(!next)}
          aria-label="App AI enabled"
          data-testid={`switch-app-ai-${app.id}`}
        />
      </div>

      {aiQuery.isLoading ? (
        <div className="space-y-2 mt-3">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : !overview ? (
        <p className="text-xs text-muted-foreground mt-2">
          AI usage is unavailable right now. Try again in a moment.
        </p>
      ) : (
        <div className="space-y-4 mt-2">
          <p
            className="text-xs text-muted-foreground"
            data-testid={`text-app-ai-status-${app.id}`}
          >
            {overview.paused
              ? "Paused — the app's AI requests are refused instantly."
              : "The app's AI runs through Venom — no provider keys, metered here."}
          </p>

          <div>
            <div className="flex items-baseline justify-between gap-2">
              <span
                className="text-2xl font-semibold tracking-tight tabular-nums"
                data-testid={`text-app-ai-cost-${app.id}`}
              >
                {formatUsd(overview.usage.costUsd)}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {overview.usage.requests.toLocaleString()} request
                {overview.usage.requests === 1 ? "" : "s"} this month
              </span>
            </div>
            {overview.usage.models.length > 0 && (
              <ul className="mt-2 space-y-1">
                {overview.usage.models.map(model => (
                  <li
                    key={model.modelId}
                    className="flex items-center justify-between text-xs text-muted-foreground"
                    data-testid={`row-app-ai-model-${app.id}-${model.modelId}`}
                  >
                    <span>{model.modelName}</span>
                    <span className="tabular-nums">
                      {formatUsd(model.costUsd)} ·{" "}
                      {model.requests.toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] text-muted-foreground/80 mt-2">
              {overview.usage.hasEstimates
                ? "Includes estimated token counts for interrupted replies. "
                : ""}
              All your apps together: {formatUsd(overview.ownerMonthUsd)} this
              month.
            </p>
          </div>

          <div>
            <label
              className="text-xs font-medium text-foreground"
              htmlFor={`app-ai-cap-${app.id}`}
            >
              Monthly cap (USD)
            </label>
            <div className="flex items-center gap-2 mt-1">
              <Input
                id={`app-ai-cap-${app.id}`}
                inputMode="decimal"
                placeholder="No cap"
                value={capValue}
                onChange={event => setCapDraft(event.target.value)}
                className="h-8 text-xs"
                data-testid={`input-app-ai-cap-${app.id}`}
              />
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0 rounded-md border-border/60"
                disabled={!capDirty || updateSettings.isPending}
                onClick={saveCap}
                data-testid={`button-save-app-ai-cap-${app.id}`}
              >
                Save
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground/80 mt-1">
              Blank removes your cap. Venom's{" "}
              {formatUsd(overview.safetyCapUsd)} monthly safety cap always
              applies.
            </p>
          </div>

          <div className="border-t border-border/40 pt-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-medium flex items-center gap-1.5">
                  <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                  Gateway key
                </p>
                <p
                  className="text-xs text-muted-foreground font-mono mt-0.5 truncate"
                  data-testid={`text-app-ai-credential-${app.id}`}
                >
                  {overview.credential
                    ? `${overview.credential.displayPrefix}…`
                    : "No active key"}
                </p>
                {overview.credential && (
                  <p className="text-[11px] text-muted-foreground/80 mt-0.5">
                    {overview.credential.delivered
                      ? "Delivered to the app."
                      : "Ships with the app's next update."}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 rounded-md border-border/60"
                      disabled={rotateCredential.isPending}
                      data-testid={`button-rotate-app-ai-${app.id}`}
                    >
                      Rotate
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent className="rounded-2xl border-border/60 surface sm:max-w-[420px] shadow-lift">
                    <AlertDialogHeader>
                      <AlertDialogTitle className="text-lg font-semibold tracking-tight">
                        Rotate this app's AI key?
                      </AlertDialogTitle>
                      <AlertDialogDescription className="text-sm">
                        The current key stops working immediately. Venom
                        delivers the replacement straight into the app — if
                        that fails, it ships with the next update.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel className="rounded-md font-medium border-border/60">
                        Cancel
                      </AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() =>
                          rotateCredential.mutate({ appId: app.id })
                        }
                        data-testid={`button-confirm-rotate-app-ai-${app.id}`}
                      >
                        Rotate key
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 rounded-md border-border/60 text-destructive hover:text-destructive"
                      disabled={
                        revokeCredential.isPending || !overview.credential
                      }
                      data-testid={`button-revoke-app-ai-${app.id}`}
                    >
                      Revoke
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent className="rounded-2xl border-border/60 surface sm:max-w-[420px] shadow-lift">
                    <AlertDialogHeader>
                      <AlertDialogTitle className="text-lg font-semibold tracking-tight text-destructive">
                        Revoke this app's AI key?
                      </AlertDialogTitle>
                      <AlertDialogDescription className="text-sm">
                        The app loses AI access immediately and stays offline
                        until you rotate in a new key.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel className="rounded-md font-medium border-border/60">
                        Cancel
                      </AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        onClick={() =>
                          revokeCredential.mutate({ appId: app.id })
                        }
                        data-testid={`button-confirm-revoke-app-ai-${app.id}`}
                      >
                        Revoke key
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
