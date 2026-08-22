import { useEffect } from "react";
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
 * Public full-page share surface: `/s/:slug`. Unauthenticated — anyone with
 * the link sees the app's currently published release full-page, with a
 * small "Built with Venom" badge. When the provisioning provider cannot be
 * framed, the page redirects to the running app instead.
 */
export default function SharePage() {
  const [, params] = useRoute("/s/:slug");
  const resolution = useShareResolution(params?.slug);
  useShareDocumentTitle(resolution);

  const redirectTarget =
    resolution.status === "live" && resolution.viewMode === "redirect"
      ? resolution.frameUrl
      : null;
  useEffect(() => {
    if (redirectTarget) window.location.replace(redirectTarget);
  }, [redirectTarget]);

  if (resolution.status === "loading") return <ShareLoading />;
  if (resolution.status === "unavailable") return <ShareFallback />;

  if (resolution.viewMode === "redirect") {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center gap-3 bg-[#0a0a0a] px-6 text-center"
        data-testid="share-redirect"
      >
        <VenomMark className="h-8 w-8 text-white/80" title="Venom" />
        <p className="text-sm font-medium tracking-tight text-white/80">
          Opening {resolution.appName}…
        </p>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-[#0a0a0a]">
      <ShareFrame src={resolution.frameUrl} title={resolution.appName} />
      <a
        href={import.meta.env.BASE_URL}
        aria-label="Built with Venom — visit Venom"
        data-testid="link-share-badge"
        className="absolute bottom-3 right-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-black/85 px-3 py-1.5 text-[11px] font-semibold tracking-tight text-white shadow-lg ring-1 ring-white/15 transition-colors hover:bg-black"
      >
        <VenomMark className="h-3.5 w-3.5" />
        <span>Built with Venom</span>
      </a>
    </div>
  );
}
