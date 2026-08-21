/**
 * Server-owned named voice preset catalog for Venom hands-free voice chat.
 *
 * Safe (public) preset IDs and display metadata are surfaced to clients.
 * Actual OpenAI voice IDs are server-side only and never leave this module,
 * mirroring how the managed model catalog hides provider model IDs.
 */

export type VenomVoicePresetId =
  | "sam"
  | "marcus"
  | "rowan"
  | "elijah"
  | "maya"
  | "isla";

/** OpenAI voices supported by the audio module. Server-side only. */
export type ProviderVoiceId =
  | "alloy"
  | "echo"
  | "fable"
  | "onyx"
  | "nova"
  | "shimmer";

export type VenomVoicePreset = {
  id: VenomVoicePresetId;
  name: string;
  persona: string;
  tone: "masculine" | "feminine" | "neutral";
  sampleText: string;
  available: boolean;
  availabilityText: string;
};

/** Allowlisted safe preset IDs. Any value not in this set is rejected. */
export const VENOM_VOICE_PRESET_IDS = new Set<VenomVoicePresetId>([
  "sam",
  "marcus",
  "rowan",
  "elijah",
  "maya",
  "isla",
]);

/** Default preset used when a caller has never chosen a voice. */
export const DEFAULT_VENOM_VOICE_PRESET_ID: VenomVoicePresetId = "sam";

export class InvalidVenomVoiceError extends Error {
  constructor() {
    super("Invalid voice preset");
    this.name = "InvalidVenomVoiceError";
  }
}

/**
 * Preset-to-provider voice mapping — server-side only.
 * NEVER include provider voice IDs in any API response or log line.
 */
const PROVIDER_VOICE_IDS: Record<VenomVoicePresetId, ProviderVoiceId> = {
  sam: "alloy",
  marcus: "echo",
  rowan: "fable",
  elijah: "onyx",
  maya: "nova",
  isla: "shimmer",
};

const CATALOG_METADATA: Record<
  VenomVoicePresetId,
  Omit<VenomVoicePreset, "available" | "availabilityText">
> = {
  sam: {
    id: "sam",
    name: "Sam",
    tone: "neutral",
    persona: "Even, clear, and balanced. The default voice.",
    sampleText: "Hey, I'm Sam. Even keel, clear head. Let's get into it.",
  },
  marcus: {
    id: "marcus",
    name: "Marcus",
    tone: "masculine",
    persona: "Warm and steady, with a low resonance.",
    sampleText: "I'm Marcus. Warm, steady, and straight to the point.",
  },
  rowan: {
    id: "rowan",
    name: "Rowan",
    tone: "neutral",
    persona: "Expressive and animated, a storyteller's cadence.",
    sampleText: "Hello, I'm Rowan. Every project is a story — let's tell yours.",
  },
  elijah: {
    id: "elijah",
    name: "Elijah",
    tone: "masculine",
    persona: "Deep, calm, and deliberate.",
    sampleText: "I'm Elijah. Calm, deep, and unhurried. Take your time.",
  },
  maya: {
    id: "maya",
    name: "Maya",
    tone: "feminine",
    persona: "Bright, quick, and friendly.",
    sampleText: "Hi, I'm Maya! Quick on my feet and easy to talk to.",
  },
  isla: {
    id: "isla",
    name: "Isla",
    tone: "feminine",
    persona: "Soft, airy, and precise.",
    sampleText: "Hi there, I'm Isla. Soft-spoken — but I don't miss much.",
  },
};

/**
 * Whether spoken audio can be produced at all: voice runs exclusively through
 * the OpenAI audio integration, so both managed env vars must be present.
 * Checked lazily at call time so a late provisioning is picked up.
 */
export function isVenomVoiceAvailable(): boolean {
  return Boolean(
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL &&
      process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  );
}

/** Build the sanitized preset catalog. Safe to return in API responses. */
export function buildVenomVoiceCatalog(): VenomVoicePreset[] {
  const available = isVenomVoiceAvailable();
  return (Object.keys(CATALOG_METADATA) as VenomVoicePresetId[]).map((id) => ({
    ...CATALOG_METADATA[id],
    available,
    availabilityText: available ? "Ready" : "Voice is not configured",
  }));
}

/** Validate an incoming preset ID. Throws for anything not allowlisted. */
export function resolveVenomVoicePresetId(raw: unknown): VenomVoicePresetId {
  if (
    typeof raw === "string" &&
    VENOM_VOICE_PRESET_IDS.has(raw as VenomVoicePresetId)
  ) {
    return raw as VenomVoicePresetId;
  }
  throw new InvalidVenomVoiceError();
}

/** Resolve a preset to the provider voice ID. Server-side only. */
export function resolveProviderVoice(id: VenomVoicePresetId): ProviderVoiceId {
  return PROVIDER_VOICE_IDS[id];
}
