import { useRoute } from "wouter";
import { VenomMark } from "@/components/venom-mark";
import {
  ShareFallback,
  ShareFrame,
  ShareLoading,
  useShareDocumentTitle,
  useShareResolution,
} from "./share-view";

/**
 * Public embed surface: `/s/:slug/embed`. Minimal chrome — when live and
 * frameable it is nothing but the app's iframe, sized by whatever iframe the
 * host page pasted the snippet into. A frame-averse provider gets a compact
 * branded card with an "Open app" escape hatch (top-level navigation needs a
 * user gesture inside an embed, so no automatic redirect here).
 */
export default function ShareEmbedPage() {
  const [, params] = useRoute("/s/:slug/embed");
  const resolution = useShareResolution(params?.slug);
  useShareDocumentTitle(resolution);

  if (resolution.status === "loading") {
    return (
      <div className="fixed inset-0">
        <ShareLoading compact />
      </div>
    );
  }
  if (resolution.status === "unavailable") {
    return (
      <div className="fixed inset-0">
        <ShareFallback compact />
      </div>
    );
  }

  if (resolution.viewMode === "redirect") {
    return (
      <div
        className="fixed inset-0 flex flex-col items-center justify-center gap-3 bg-[#0a0a0a] px-6 text-center"
        data-testid="embed-redirect-card"
      >
        <VenomMark className="h-8 w-8 text-white/90" title="Venom" />
        <p className="text-sm font-semibold tracking-tight text-white/90">
          {resolution.appName}
        </p>
        <a
          href={resolution.frameUrl}
          target="_top"
          rel="noopener noreferrer"
          data-testid="link-embed-open"
          className="rounded-full bg-white px-4 py-1.5 text-xs font-bold tracking-tight text-black transition-colors hover:bg-white/90"
        >
          Open app
        </a>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-[#0a0a0a]">
      <ShareFrame src={resolution.frameUrl} title={resolution.appName} />
    </div>
  );
}
