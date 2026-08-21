type Loader = () => Promise<unknown>;

type ConnectionLike = {
  saveData?: boolean;
  effectiveType?: string;
};

/**
 * Skip speculative downloads when the browser tells us the connection is
 * expensive or slow. Prefetching whole route chunks on a 2G phone would
 * compete with the request the user is actually waiting on.
 */
function shouldPrefetch(): boolean {
  const connection = (navigator as Navigator & { connection?: ConnectionLike })
    .connection;
  if (!connection) return true;
  if (connection.saveData) return false;
  const effectiveType = connection.effectiveType ?? "";
  return effectiveType !== "slow-2g" && effectiveType !== "2g";
}

function whenIdle(run: () => void): () => void {
  const idle = (
    window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    }
  ).requestIdleCallback;

  if (idle) {
    const handle = idle(run, { timeout: 4000 });
    return () => {
      (
        window as Window & { cancelIdleCallback?: (handle: number) => void }
      ).cancelIdleCallback?.(handle);
    };
  }

  const timer = window.setTimeout(run, 1500);
  return () => window.clearTimeout(timer);
}

/**
 * Warm route chunks once the current route has painted, so switching tabs
 * stays instant even though each page is now a separate download. Returns a
 * cleanup function suitable for a `useEffect`.
 */
export function prefetchOnIdle(loaders: readonly Loader[]): () => void {
  if (typeof window === "undefined" || !shouldPrefetch()) return () => {};

  return whenIdle(() => {
    for (const load of loaders) {
      // A failed speculative fetch must stay silent; the real navigation will
      // retry it and surface any error through the route error boundary.
      void load().catch(() => {});
    }
  });
}
