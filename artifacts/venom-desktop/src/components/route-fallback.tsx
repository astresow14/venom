import { Skeleton } from "@/components/ui/skeleton";
import { VenomMark } from "@/components/venom-mark";

/**
 * Route chunks are fetched on demand, so every route boundary needs a
 * placeholder. Both placeholders below stay invisible for a beat before they
 * fade in (`animate-delayed-reveal`): a chunk that is already cached resolves
 * well inside that delay, so a warm navigation shows nothing at all instead of
 * a one-frame flash.
 */

/**
 * Full-viewport placeholder for the top-level routes (landing and auth).
 *
 * Deliberately CSS-only. This is the one placeholder that can be shown before
 * any route chunk has arrived, so it must not depend on the Motion runtime —
 * otherwise the loading state would itself be waiting on a download.
 */
export function PageFallback() {
  return (
    <div
      className="flex h-[100dvh] w-full items-center justify-center bg-background text-foreground"
      role="status"
      aria-label="Loading Venom"
    >
      <span className="animate-delayed-reveal">
        <VenomMark className="h-10 w-10 animate-pulse motion-reduce:animate-none" />
      </span>
    </div>
  );
}

/**
 * Placeholder for workspace pages. The shell (sidebar, header, drawer) is
 * already painted around it, so this only stands in for the content column and
 * mirrors the skeletons the pages themselves use while their data hydrates.
 */
export function WorkspaceRouteFallback() {
  return (
    <div
      className="animate-delayed-reveal flex min-h-0 w-full flex-1 flex-col gap-6 p-4 md:p-10"
      role="status"
      aria-label="Loading page"
    >
      <Skeleton className="h-12 w-64 rounded-xl" />
      <Skeleton className="h-32 w-full rounded-2xl" />
      <Skeleton className="hidden h-32 w-full rounded-2xl md:block" />
    </div>
  );
}
