/**
 * Deliberately kept in its own module: the router needs this flag to decide
 * whether to enforce the auth gate, and importing it from the workspace
 * context would pull the whole workspace state machine into the entry chunk.
 */
export const IS_UI_TEST =
  import.meta.env.DEV && import.meta.env.VITE_VENOM_UI_TEST === 'true';

/**
 * Opt-in for browser specs that exercise the live company directory +
 * membership event stream. Off by default so every other spec keeps the
 * org machinery quiet (no unstubbed background fetches to satisfy).
 */
export const IS_ORG_UI_TEST =
  IS_UI_TEST &&
  typeof location !== 'undefined' &&
  new URLSearchParams(location.search).has('venomUiTestOrgs');

/**
 * Opt-in for browser specs that exercise the real workspace sync machinery
 * (hydrate → debounce → cloud save) against Playwright-stubbed workspace
 * endpoints, instead of the UI-test default of pinning the workspace to a
 * synced, local-only state. This is how failed-save UI — the chat
 * device-only notice, the sidebar retry — is testable end to end. Off by
 * default so every other spec keeps cloud sync quiet. Mirrors the mobile
 * app's `venomWorkspaceSyncTest` mode.
 */
export const IS_WORKSPACE_SYNC_UI_TEST =
  IS_UI_TEST &&
  typeof location !== 'undefined' &&
  new URLSearchParams(location.search).get('venomWorkspaceSyncTest') === 'true';
