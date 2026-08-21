/**
 * Server-owned sanitized model catalog for Venom.
 *
 * Safe (public) model IDs and metadata are surfaced to clients.
 * Actual provider model IDs are server-side only and never leave this module.
 *
 * Security: never log, expose in API responses, or transmit provider model IDs.
 */

export type VenomModelId = "venom-gpt" | "venom-claude" | "venom-gemini" | "venom-grok";

export type VenomManagedModel = {
  id: VenomModelId;
  provider: "openai" | "anthropic" | "gemini" | "openrouter";
  name: string;
  family: "GPT" | "Claude" | "Gemini" | "Grok";
  summary: string;
  available: boolean;
  availabilityText: string;
};

/** Allowlisted safe model IDs. Any value not in this set is rejected. */
export const VENOM_MODEL_IDS = new Set<VenomModelId>([
  "venom-gpt",
  "venom-claude",
  "venom-gemini",
  "venom-grok",
]);

/** Default model ID used when the caller omits modelId (legacy callers). */
export const DEFAULT_VENOM_MODEL_ID: VenomModelId = "venom-gpt";

export class InvalidVenomModelError extends Error {
  constructor() {
    super("Invalid managed model");
    this.name = "InvalidVenomModelError";
  }
}

/**
 * Actual provider model IDs — server-side only.
 * NEVER include these in any API response or log line.
 */
const PROVIDER_MODEL_IDS: Record<VenomModelId, string> = {
  "venom-gpt": "gpt-5.6-terra",
  "venom-claude": "claude-sonnet-4-6",
  "venom-gemini": "gemini-3-flash-preview",
  "venom-grok": "x-ai/grok-4.6",
};

/**
 * Managed env var pairs that indicate a provider is available. Direct provider
 * keys are also supported as a deliberate fallback when managed provisioning
 * is unavailable in this Repl.
 */
const PROVIDER_ENV_PAIRS: Record<VenomModelId, [string, string]> = {
  "venom-gpt": ["AI_INTEGRATIONS_OPENAI_BASE_URL", "AI_INTEGRATIONS_OPENAI_API_KEY"],
  "venom-claude": ["AI_INTEGRATIONS_ANTHROPIC_BASE_URL", "AI_INTEGRATIONS_ANTHROPIC_API_KEY"],
  "venom-gemini": ["AI_INTEGRATIONS_GEMINI_BASE_URL", "AI_INTEGRATIONS_GEMINI_API_KEY"],
  "venom-grok": ["AI_INTEGRATIONS_OPENROUTER_BASE_URL", "AI_INTEGRATIONS_OPENROUTER_API_KEY"],
};

const DIRECT_PROVIDER_KEYS: Partial<Record<VenomModelId, string>> = {
  "venom-claude": "ANTHROPIC_API_KEY",
  "venom-grok": "OPENROUTER_API_KEY",
};

const CATALOG_METADATA: Record<
  VenomModelId,
  Omit<VenomManagedModel, "available" | "availabilityText">
> = {
  "venom-gpt": {
    id: "venom-gpt",
    provider: "openai",
    name: "Venom GPT",
    family: "GPT",
    summary: "OpenAI's flagship model. Fast reasoning, strong code and analysis.",
  },
  "venom-claude": {
    id: "venom-claude",
    provider: "anthropic",
    name: "Venom Claude",
    family: "Claude",
    summary: "Anthropic's balanced model. Excellent for nuanced writing and long context.",
  },
  "venom-gemini": {
    id: "venom-gemini",
    provider: "gemini",
    name: "Venom Gemini",
    family: "Gemini",
    summary: "Google's hybrid reasoning model. Great for high-volume tasks and analysis.",
  },
  "venom-grok": {
    id: "venom-grok",
    provider: "openrouter",
    name: "Venom Grok",
    family: "Grok",
    summary: "xAI's Grok model via OpenRouter. Direct, technically sharp responses.",
  },
};

/** Whether a model's provider env vars are present (lazy check at call time). */
function isModelAvailable(id: VenomModelId): boolean {
  const [urlVar, keyVar] = PROVIDER_ENV_PAIRS[id];
  if (process.env[urlVar] && process.env[keyVar]) return true;
  // Gemini direct access is intentionally held back until its Google account
  // capability check succeeds. A retained, unverified secret must not make the
  // picker promise a model that cannot answer.
  if (id === "venom-gemini") {
    return Boolean(
      process.env.VENOM_ENABLE_GEMINI_DIRECT === "true" &&
        process.env.GEMINI_API_KEY,
    );
  }
  const directKey = DIRECT_PROVIDER_KEYS[id];
  return Boolean(directKey && process.env[directKey]);
}

/** Build the sanitized catalog. Safe to return in API responses. */
export function buildVenomCatalog(): VenomManagedModel[] {
  return (Object.keys(CATALOG_METADATA) as VenomModelId[]).map((id) => {
    const available = isModelAvailable(id);
    return {
      ...CATALOG_METADATA[id],
      available,
      availabilityText: available ? "Ready" : "Not configured",
    };
  });
}

/** Resolve an incoming safe model ID to the provider model ID. Server-side only. */
export function resolveProviderModelId(id: VenomModelId): string {
  return PROVIDER_MODEL_IDS[id];
}

/** Resolve a safe ID, using the existing GPT default only for legacy omissions. */
export function resolveVenomModelId(raw: VenomModelId | undefined | null): VenomModelId {
  if (!raw) return DEFAULT_VENOM_MODEL_ID;
  if (VENOM_MODEL_IDS.has(raw)) return raw;
  throw new InvalidVenomModelError();
}
