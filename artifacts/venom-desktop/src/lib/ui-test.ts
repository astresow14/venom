/**
 * Deliberately kept in its own module: the router needs this flag to decide
 * whether to enforce the auth gate, and importing it from the workspace
 * context would pull the whole workspace state machine into the entry chunk.
 */
export const IS_UI_TEST =
  import.meta.env.DEV && import.meta.env.VITE_VENOM_UI_TEST === 'true';
