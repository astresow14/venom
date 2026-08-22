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

export type GeminiModelAccessCheck =
  | { ok: true }
  | { ok: false; status?: number; timedOut?: boolean };

class GeminiAccessCheckTimeout extends Error {
  constructor() {
    super("Gemini model access check timed out");
    this.name = "GeminiAccessCheckTimeout";
  }
}

/**
 * Verify the active credential (direct key preferred, managed fallback — the
 * same selection the streaming client uses) can read the given model from the
 * Gemini model catalog.
 *
 * Reports only a safe outcome: an ok flag, an HTTP status, or a timeout flag.
 * Never credential material, provider error text, or an echo of the model id,
 * so callers can log the result as-is.
 */
export async function checkGeminiModelAccess(
  modelId: string,
  timeoutMs = 10_000,
): Promise<GeminiModelAccessCheck> {
  if (!isGeminiAvailable()) return { ok: false };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new GeminiAccessCheckTimeout()), timeoutMs);
    });
    await Promise.race([getGeminiClient().models.get({ model: modelId }), timeout]);
    return { ok: true };
  } catch (error) {
    if (error instanceof GeminiAccessCheckTimeout) {
      return { ok: false, timedOut: true };
    }
    const candidate = error as { status?: unknown; statusCode?: unknown } | null;
    const status =
      typeof candidate?.status === "number"
        ? candidate.status
        : typeof candidate?.statusCode === "number"
          ? candidate.statusCode
          : undefined;
    return { ok: false, status };
  } finally {
    if (timer) clearTimeout(timer);
  }
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
