import Anthropic from "@anthropic-ai/sdk";

let _anthropic: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!_anthropic) {
    const directApiKey = process.env.ANTHROPIC_API_KEY;
    const managedApiKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
    const apiKey = directApiKey || managedApiKey;
    if (!apiKey) {
      throw new Error(
        "An Anthropic API key must be configured through Replit AI Integrations or the ANTHROPIC_API_KEY secret.",
      );
    }
    _anthropic = new Anthropic({
      apiKey,
      baseURL:
        (directApiKey ? undefined : process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL) ||
        "https://api.anthropic.com",
    });
  }
  return _anthropic;
}

/** Whether this provider's env vars are available */
export function isAnthropicAvailable(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
      (process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL &&
        process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY),
  );
}

/** Eagerly-resolved singleton for code that imports it directly. Throws if env vars are missing. */
export const anthropic = new Proxy({} as Anthropic, {
  get(_target, prop) {
    return (getAnthropicClient() as unknown as Record<string | symbol, unknown>)[prop];
  },
});
