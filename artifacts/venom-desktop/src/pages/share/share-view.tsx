import { useEffect, useState } from "react";
import { VenomMark } from "@/components/venom-mark";

/**
 * Shared plumbing for the public share surfaces (`/s/:slug` and
 * `/s/:slug/embed`). These routes are unauthenticated and load for anonymous
 * visitors, so they deliberately avoid the generated API client, react-query,
 * and the tailwind-merge `cn()` helper — a raw fetch with a narrow runtime
 * guard keeps the lazy chunk tiny and sidesteps the generated client's
 * error-body-as-data pitfall.
 *
 * Every non-live outcome (unknown slug, sharing disabled, no healthy
 * published release, network failure, malformed payload) collapses into the
 * same quiet branded fallback: public visitors never learn why.
 */

export type ShareResolution =
  | { status: "loading" }
  | { status: "unavailable" }
  | {
      status: "live";
      appName: string;
      viewMode: "frame" | "redirect";
      frameUrl: string;
    };

type LivePayload = Extract<ShareResolution, { status: "live" }>;

function isLivePayload(data: unknown): data is LivePayload {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  return (
    record.status === "live" &&
    typeof record.appName === "string" &&
    (record.viewMode === "frame" || record.viewMode === "redirect") &&
    typeof record.frameUrl === "string" &&
    /^https?:\/\//i.test(record.frameUrl)
  );
}

export function useShareResolution(slug: string | undefined): ShareResolution {
  const [resolution, setResolution] = useState<ShareResolution>({
    status: "loading",
  });

  useEffect(() => {
    if (!slug) {
      setResolution({ status: "unavailable" });
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(
          `/api/public/app-shares/${encodeURIComponent(slug)}`,
          {
            signal: controller.signal,
            headers: { Accept: "application/json" },
          },
        );
        if (!response.ok) throw new Error(`share resolve ${response.status}`);
        const data: unknown = await response.json();
        if (cancelled) return;
        setResolution(
          isLivePayload(data)
            ? {
                status: "live",
                appName: data.appName,
                viewMode: data.viewMode,
                frameUrl: data.frameUrl,
              }
            : { status: "unavailable" },
        );
      } catch (error) {
        const aborted =
          error instanceof DOMException && error.name === "AbortError";
        if (!cancelled && !aborted) setResolution({ status: "unavailable" });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [slug]);

  return resolution;
}

/** Keeps the tab title in sync while a share surface is mounted. */
export function useShareDocumentTitle(resolution: ShareResolution): void {
  useEffect(() => {
    const previous = document.title;
    document.title =
      resolution.status === "live"
        ? `${resolution.appName} · Venom`
        : "Shared app · Venom";
    return () => {
      document.title = previous;
    };
  }, [resolution]);
}

/**
 * The quiet branded state shown for every non-live outcome. Identical for
 * unknown, disabled, and not-live slugs — it must never hint at which.
 */
export function ShareFallback({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`flex w-full flex-col items-center justify-center gap-3 bg-[#0a0a0a] px-6 text-center ${
        compact ? "h-full min-h-[180px]" : "min-h-screen"
      }`}
      data-testid="share-fallback"
    >
      <VenomMark className="h-10 w-10 text-white/90" title="Venom" />
      <p className="text-sm font-semibold tracking-tight text-white/90">
        This app isn&apos;t live right now.
      </p>
      <p className="text-xs text-white/50">
        Powered by Venom — check back soon.
      </p>
    </div>
  );
}

export function ShareLoading({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`flex w-full items-center justify-center bg-[#0a0a0a] ${
        compact ? "h-full min-h-[180px]" : "min-h-screen"
      }`}
      data-testid="share-loading"
    >
      <VenomMark className="h-8 w-8 animate-pulse text-white/40" title="Loading" />
    </div>
  );
}

/** Full-bleed iframe onto the running app. */
export function ShareFrame({ src, title }: { src: string; title: string }) {
  return (
    <iframe
      data-testid="share-frame"
      src={src}
      title={title}
      className="absolute inset-0 h-full w-full border-0 bg-white"
      allow="clipboard-read; clipboard-write; fullscreen; autoplay; encrypted-media; picture-in-picture"
      allowFullScreen
      referrerPolicy="no-referrer"
    />
  );
}
