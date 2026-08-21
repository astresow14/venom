import OpenAI from "openai";

let _openrouter: OpenAI | null = null;

export function getOpenRouterClient(): OpenAI {
  if (!_openrouter) {
    const directApiKey = process.env.OPENROUTER_API_KEY;
    const managedApiKey = process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY;
    const apiKey = directApiKey || managedApiKey;
    if (!apiKey) {
      throw new Error(
        "An OpenRouter API key must be configured through Replit AI Integrations or the OPENROUTER_API_KEY secret.",
      );
    }
    _openrouter = new OpenAI({
      baseURL:
        (directApiKey ? undefined : process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL) ||
        "https://openrouter.ai/api/v1",
      apiKey,
    });
  }
  return _openrouter;
}

/** Whether this provider's env vars are available */
export function isOpenRouterAvailable(): boolean {
  return Boolean(
    process.env.OPENROUTER_API_KEY ||
      (process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL &&
        process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY),
  );
}

/** Eagerly-resolved singleton for code that imports it directly. Throws if env vars are missing. */
export const openrouter = new Proxy({} as OpenAI, {
  get(_target, prop) {
    return (getOpenRouterClient() as unknown as Record<string | symbol, unknown>)[prop];
  },
});
