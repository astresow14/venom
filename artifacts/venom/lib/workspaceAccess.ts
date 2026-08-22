/**
 * Shared-workspace access loss, in one place (mobile twin of the desktop
 * module).
 *
 * The server answers every workspace-scoped read with
 * `403 { code: "workspace_access_denied" }` the moment the caller stops being
 * a member. Revocation must take effect on the *next request*, so the client
 * treats that response as an event, not an error to retry: evict cached
 * workspace content and fall back to the personal tier.
 *
 * Admin-only endpoints refuse members who lack the admin role with a
 * different code (`workspace_admin_required`). That one deliberately does
 * NOT match here: an admin demoted mid-session keeps their membership, so
 * their device must never evict the workspace as if they were removed.
 */

export const WORKSPACE_ACCESS_DENIED_CODE = "workspace_access_denied";

/**
 * Matches both the generated client's thrown `ApiError` (status + parsed
 * `data`) and hand-rolled fetch errors shaped the same way.
 */
export function isWorkspaceAccessDeniedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    status?: unknown;
    data?: { code?: unknown } | null;
  };
  if (candidate.status !== 403) return false;
  const data = candidate.data;
  if (!data || typeof data !== "object") return false;
  return data.code === WORKSPACE_ACCESS_DENIED_CODE;
}

type AccessLostHandler = () => void;

let handler: AccessLostHandler | null = null;

/** The SharedWorkspaceProvider registers its eviction routine here. */
export function registerWorkspaceAccessLostHandler(
  next: AccessLostHandler,
): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

/**
 * Fired from the QueryClient's error hooks and from the manual chat fetch
 * whenever the server says workspace access is gone.
 */
export function notifyWorkspaceAccessLost(): void {
  handler?.();
}
