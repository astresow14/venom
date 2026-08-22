import {
  getGetVenomAppSharingQueryKey,
  useGetVenomAppSharing,
  useUpdateVenomAppSharing,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";

/**
 * Owner controls for public distribution of a provisioned app: a stable
 * Venom-hosted share link plus a copy-paste iframe snippet. Private by
 * default; the toggle is the single kill switch — disabling it invalidates
 * the link and every embed immediately (the public endpoint is no-store).
 *
 * The slug survives disable/enable, so a re-enabled app keeps its old link.
 * What the link serves is resolved at visit time from the app's currently
 * published healthy release; this panel only reports that state.
 */

type SharingState = {
  appId: string;
  enabled: boolean;
  slug: string | null;
  shareUrl: string | null;
  embedUrl: string | null;
  embedSnippet: string | null;
  publicStatus: "live" | "unavailable";
  liveIterationNumber: number | null;
  livePublishedAt: string | null;
};

/**
 * The generated client resolves failed requests to their JSON error body,
 * so every read is guarded before use.
 */
function isSharingState(data: unknown): data is SharingState {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  return (
    typeof record.appId === "string" &&
    typeof record.enabled === "boolean" &&
    (record.publicStatus === "live" || record.publicStatus === "unavailable")
  );
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default function SharingPanel({
  app,
}: {
  app: { id: string; name: string };
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const sharingKey = getGetVenomAppSharingQueryKey(app.id);
  const sharingQuery = useGetVenomAppSharing(app.id, {
    query: { queryKey: sharingKey },
  });
  const sharing = isSharingState(sharingQuery.data) ? sharingQuery.data : null;

  const updateSharing = useUpdateVenomAppSharing({
    mutation: {
      onSuccess: data => {
        if (isSharingState(data)) {
          queryClient.setQueryData(sharingKey, data);
          toast({
            title: data.enabled ? "Sharing is on" : "Sharing is off",
            description: data.enabled
              ? "Anyone with the link can open this app."
              : "The link and any embeds stopped working immediately.",
          });
        } else {
          void queryClient.invalidateQueries({ queryKey: sharingKey });
        }
      },
      onError: () =>
        toast({
          title: "Couldn't update sharing",
          description: "Try again in a moment.",
          variant: "destructive",
        }),
    },
  });

  const copyText = async (value: string, confirmation: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast({ title: confirmation });
    } catch {
      toast({
        title: "Copy failed",
        description: "Select the text and copy it manually.",
        variant: "destructive",
      });
    }
  };

  // Server-composed URLs, with a client-side fallback so an exotic proxy
  // header never blanks the panel for an enabled share.
  const shareUrl =
    sharing?.enabled === true
      ? (sharing.shareUrl ??
        (sharing.slug ? `${window.location.origin}/s/${sharing.slug}` : null))
      : null;
  const embedUrl =
    sharing?.enabled === true
      ? (sharing.embedUrl ?? (shareUrl ? `${shareUrl}/embed` : null))
      : null;
  const embedSnippet =
    sharing?.enabled === true
      ? (sharing.embedSnippet ??
        (embedUrl
          ? `<iframe src="${embedUrl}" title="${escapeHtmlAttribute(app.name)}" style="border:0;width:100%;height:600px;border-radius:12px" allow="clipboard-write; fullscreen" loading="lazy"></iframe>`
          : null))
      : null;

  return (
    <div
      className="border border-border/60 surface p-5 rounded-xl shadow-soft"
      data-testid={`card-sharing-${app.id}`}
    >
      <div className="flex items-center justify-between gap-3 mb-1">
        <h3 className="text-sm font-semibold tracking-tight flex items-center gap-2">
          <Globe className="h-4 w-4" aria-hidden="true" />
          Public sharing
        </h3>
        <Switch
          checked={sharing?.enabled === true}
          disabled={!sharing || updateSharing.isPending}
          onCheckedChange={next =>
            updateSharing.mutate({ appId: app.id, data: { enabled: next } })
          }
          aria-label="Enable public sharing"
          data-testid={`switch-app-sharing-${app.id}`}
        />
      </div>

      {sharingQuery.isLoading ? (
        <div className="space-y-2 mt-3">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : !sharing ? (
        <p className="text-xs text-muted-foreground mt-2">
          Sharing is unavailable right now. Try again in a moment.
        </p>
      ) : !sharing.enabled ? (
        <p
          className="text-xs text-muted-foreground mt-2"
          data-testid={`text-sharing-status-${app.id}`}
        >
          Private — only you can open this app.
          {sharing.slug
            ? " Turning sharing back on restores the same link."
            : " Turn it on to get a stable link and embed code."}
        </p>
      ) : (
        <div className="space-y-3 mt-2">
          <p
            className="text-xs text-muted-foreground"
            data-testid={`text-sharing-status-${app.id}`}
          >
            {sharing.publicStatus === "live"
              ? sharing.liveIterationNumber
                ? `The link serves v${sharing.liveIterationNumber} — whatever is published, always.`
                : "The link serves the currently published release."
              : "Nothing is live right now — visitors see a quiet branded fallback."}
          </p>

          {shareUrl && (
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={shareUrl}
                onFocus={event => event.currentTarget.select()}
                aria-label="Public share link"
                className="h-8 text-xs font-mono"
                data-testid={`input-share-url-${app.id}`}
              />
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0 rounded-md border-border/60"
                onClick={() => void copyText(shareUrl, "Link copied")}
                data-testid={`button-copy-share-link-${app.id}`}
              >
                <Copy className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
                Copy
              </Button>
            </div>
          )}

          <div className="flex items-center gap-2">
            {embedSnippet && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 rounded-md border-border/60"
                onClick={() => void copyText(embedSnippet, "Embed code copied")}
                data-testid={`button-copy-embed-${app.id}`}
              >
                <Copy className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
                Copy embed code
              </Button>
            )}
            {shareUrl && (
              <a
                href={shareUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-8 items-center rounded-md px-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                data-testid={`link-open-share-${app.id}`}
              >
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
                Open
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
