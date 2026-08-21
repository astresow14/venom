import { GoogleGenAI } from "@google/genai";

let _ai: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  if (!_ai) {
    const directApiKey = process.env.GEMINI_API_KEY;
    const managedApiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
    const apiKey = directApiKey || managedApiKey;
    if (!apiKey) {
      throw new Error(
        "A Gemini API key must be configured through Replit AI Integrations or the GEMINI_API_KEY secret.",
      );
    }
    const managedBaseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
    _ai = !directApiKey && managedBaseUrl
      ? new GoogleGenAI({
          apiKey,
          httpOptions: { apiVersion: "", baseUrl: managedBaseUrl },
        })
      : new GoogleGenAI({
          apiKey,
          // Pin the direct-key path to the Gemini Developer API so inherited
          // Google Cloud/Vertex environment settings cannot discard the key.
          vertexai: false,
        });
  }
  return _ai;
}

/** Whether this provider's env vars are available */
export function isGeminiAvailable(): boolean {
  return Boolean(
    process.env.GEMINI_API_KEY ||
      (process.env.AI_INTEGRATIONS_GEMINI_BASE_URL &&
        process.env.AI_INTEGRATIONS_GEMINI_API_KEY),
  );
}

/** Eagerly-resolved singleton for code that imports it directly. Throws if env vars are missing. */
export const ai = new Proxy({} as GoogleGenAI, {
  get(_target, prop) {
    return (getGeminiClient() as unknown as Record<string | symbol, unknown>)[prop];
  },
});
