const PENDING_PROMPT_KEY = "venom.pendingPrompt";

/**
 * Carries a prompt typed on the signed-out landing page through the sign-in
 * round trip so the workspace composer opens pre-filled instead of empty.
 * Session storage is unavailable in some privacy modes, so every access is
 * best-effort.
 */
export function stashPendingPrompt(prompt: string) {
  const trimmed = prompt.trim();
  if (!trimmed) return;
  try {
    window.sessionStorage.setItem(PENDING_PROMPT_KEY, trimmed);
  } catch {
    // Ignored: the prompt simply is not carried over.
  }
}

export function takePendingPrompt(): string {
  try {
    const pending = window.sessionStorage.getItem(PENDING_PROMPT_KEY);
    if (pending) window.sessionStorage.removeItem(PENDING_PROMPT_KEY);
    return pending ?? "";
  } catch {
    return "";
  }
}
