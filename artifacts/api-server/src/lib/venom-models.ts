/**
 * Server-owned sanitized model catalog for Venom.
 *
 * Safe (public) model IDs and metadata are surfaced to clients.
 * Actual provider model IDs are server-side only and never leave this module.
 *
 * Security: never log, expose in API responses, or transmit provider model IDs.
 */

export type VenomModelId = "venom-gpt" | "venom-claude" | "venom-gemini" | "venom-grok";

/**
 * Coarse relative running cost, safe to show next to a model row. Never a
 * price, currency amount, or provider SKU — comparing tiers is all it is for.
 */
export type VenomModelCostTier = "$" | "$$" | "$$$";

export type VenomManagedModel = {
  id: VenomModelId;
  provider: "openai" | "anthropic" | "gemini" | "openrouter";
  name: string;
  family: "GPT" | "Claude" | "Gemini" | "Grok";
  summary: string;
  available: boolean;
  availabilityText: string;
  /**
   * Account-level health observed on live calls. "unfunded" means the
   * credential exists but the account behind it cannot pay for replies
   * (billing-class failures), so the model must not be presented as plainly
   * Ready. Optional so catalog payloads predating the field stay valid;
   * absent means "ok".
   */
  accountHealth?: VenomModelAccountHealth;
  /** Coarse relative cost tier for manual comparison in the pickers. */
  costTier?: VenomModelCostTier;
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

/** Human-readable provider names for user-facing copy (errors, notes). */
export const PROVIDER_LABELS: Record<VenomManagedModel["provider"], string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google",
  openrouter: "OpenRouter",
};

export function providerLabel(provider: VenomManagedModel["provider"]): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

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
 * Relative cost and capability ranking per alias — server-side only. Rank 1
 * is the best in its dimension (cheapest, or most capable). The fine-grained
 * ranks order automatic selection and never leave the process; clients only
 * ever see the coarse costTier from the catalog. Rankings are judgment calls
 * over the current provider price sheets, revisited whenever the mapping
 * above changes — never derived at runtime from provider APIs.
 */
const MODEL_RANKINGS: Record<
  VenomModelId,
  { costRank: number; capabilityRank: number; costTier: VenomModelCostTier }
> = {
  "venom-gemini": { costRank: 1, capabilityRank: 4, costTier: "$" },
  "venom-grok": { costRank: 2, capabilityRank: 3, costTier: "$$" },
  "venom-claude": { costRank: 3, capabilityRank: 2, costTier: "$$" },
  "venom-gpt": { costRank: 4, capabilityRank: 1, costTier: "$$$" },
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

// ─── Gemini direct-credential capability gate ────────────────────────────────
//
// The direct Google credential is enabled only after a server-side capability
// check confirms it can access the Gemini model catalog. A retained,
// unverified secret must not make the picker promise a model that cannot
// answer. The verdict is cached per process: plain calls reuse it, and a
// failure stays sticky for them until a caller passes `force`. The server
// boots through startGeminiDirectCapabilityRecovery, which re-checks a failed
// verdict on a bounded backoff — a transient blip at startup cannot park
// Gemini offline until someone restarts the process.

export type GeminiDirectCapabilityResult = { ok: boolean; reason?: string };

type GeminiAccessCheckOutcome = { ok: boolean; status?: number; timedOut?: boolean };
type GeminiAccessCheck = (
  providerModelId: string,
  timeoutMs: number,
) => Promise<GeminiAccessCheckOutcome>;

const GEMINI_CAPABILITY_TIMEOUT_MS = 10_000;

const GEMINI_CREDENTIAL_MISSING_REASON = "Gemini credential is not configured";

let geminiDirectVerified = false;
let geminiDirectFailure: string | null = null;
let geminiDirectInFlight: Promise<GeminiDirectCapabilityResult> | null = null;
let geminiRecoveryHandle: GeminiCapabilityRecoveryHandle | null = null;

async function defaultGeminiAccessCheck(
  providerModelId: string,
  timeoutMs: number,
): Promise<GeminiAccessCheckOutcome> {
  const { checkGeminiModelAccess } = await import(
    "@workspace/integrations-gemini-ai"
  );
  return checkGeminiModelAccess(providerModelId, timeoutMs);
}

/** Safe, provider-agnostic description. Never provider error text or IDs. */
function describeGeminiAccessFailure(check: GeminiAccessCheckOutcome): string {
  if (check.timedOut) return "Timed out before confirming Gemini model catalog access";
  if (check.status === 401 || check.status === 403) {
    return `Gemini credential cannot access the model catalog (HTTP ${check.status})`;
  }
  if (check.status === 404) {
    return "Gemini model catalog does not include the required model";
  }
  if (typeof check.status === "number") {
    return `Gemini model catalog check failed (HTTP ${check.status})`;
  }
  return "Gemini model catalog access could not be confirmed";
}

/**
 * Run (or reuse) the server-side Gemini capability check. The catalog marks
 * venom-gemini Ready over the direct credential only after this resolves ok.
 * The result is safe to log: no credentials, prompts, or provider model IDs.
 */
export async function verifyGeminiDirectCapability(
  options: {
    force?: boolean;
    timeoutMs?: number;
    /** Test seam — production callers use the real Gemini client check. */
    checkAccess?: GeminiAccessCheck;
  } = {},
): Promise<GeminiDirectCapabilityResult> {
  const {
    force = false,
    timeoutMs = GEMINI_CAPABILITY_TIMEOUT_MS,
    checkAccess = defaultGeminiAccessCheck,
  } = options;

  if (!process.env.GEMINI_API_KEY) {
    geminiDirectVerified = false;
    geminiDirectFailure = GEMINI_CREDENTIAL_MISSING_REASON;
    return { ok: false, reason: geminiDirectFailure };
  }

  if (!force) {
    if (geminiDirectVerified) return { ok: true };
    if (geminiDirectFailure) return { ok: false, reason: geminiDirectFailure };
    if (geminiDirectInFlight) return geminiDirectInFlight;
  }

  const run = (async (): Promise<GeminiDirectCapabilityResult> => {
    try {
      const check = await checkAccess(
        resolveProviderModelId("venom-gemini"),
        timeoutMs,
      );
      if (check.ok) {
        geminiDirectVerified = true;
        geminiDirectFailure = null;
        return { ok: true };
      }
      geminiDirectVerified = false;
      geminiDirectFailure = describeGeminiAccessFailure(check);
      return { ok: false, reason: geminiDirectFailure };
    } catch {
      // The underlying error may carry provider detail; never surface it.
      geminiDirectVerified = false;
      geminiDirectFailure = "Gemini model catalog access could not be confirmed";
      return { ok: false, reason: geminiDirectFailure };
    } finally {
      geminiDirectInFlight = null;
    }
  })();

  geminiDirectInFlight = run;
  return run;
}

/** Test-only: reset or prime the cached Gemini direct-capability verdict. */
export function resetGeminiDirectCapabilityForTests(
  state: "unverified" | "ready" | "failed" = "unverified",
): void {
  geminiRecoveryHandle?.stop();
  geminiRecoveryHandle = null;
  geminiDirectInFlight = null;
  geminiDirectVerified = state === "ready";
  geminiDirectFailure = state === "failed" ? "Primed by test" : null;
}

// ─── Gemini capability self-recovery ─────────────────────────────────────────
//
// A failed capability verdict is re-checked automatically: retries back off
// exponentially from 30 seconds to a 15-minute cap, then keep probing at the
// cap until a check passes. A later passing verdict flips the catalog to
// Ready with no restart, because buildVenomCatalog reads the live verdict on
// every call. Verdicts stay safe to log — reasons never carry credentials,
// prompts, or provider model IDs.

const GEMINI_CAPABILITY_RETRY_INITIAL_DELAY_MS = 30_000;
const GEMINI_CAPABILITY_RETRY_MAX_DELAY_MS = 15 * 60_000;

export type GeminiCapabilityRecoveryVerdict = {
  result: GeminiDirectCapabilityResult;
  /** 0 for the initial check, then 1, 2, … for each re-check. */
  attempt: number;
  /** Delay before the next re-check, or null when none is scheduled. */
  nextRetryDelayMs: number | null;
};

export type GeminiCapabilityRecoveryHandle = {
  /** Cancel any scheduled re-check; a probe already in flight still lands. */
  stop: () => void;
  /** Settles when the loop ends: a check passed, no credential, or stopped. */
  done: Promise<void>;
};

export type GeminiCapabilityRecoveryOptions = {
  timeoutMs?: number;
  /** Test seam — production callers use the real Gemini client check. */
  checkAccess?: GeminiAccessCheck;
  /** Observer for each verdict (safe to log); its errors never break the loop. */
  onVerdict?: (verdict: GeminiCapabilityRecoveryVerdict) => void;
  /** Test seam — production waits on an unref'd timer that stop() cancels. */
  delay?: (delayMs: number, signal: AbortSignal) => Promise<void>;
};

/** Wait without holding the process open just to re-check Gemini. */
function waitWithUnrefTimer(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run the capability check now and, while it keeps failing, re-check on a
 * bounded backoff until one passes — the boot-time kick with self-recovery.
 * A missing credential stops the loop: within one process the key cannot
 * appear later, so there is nothing to probe. At most one loop runs per
 * process; calling again while one is active returns the active handle.
 */
export function startGeminiDirectCapabilityRecovery(
  options: GeminiCapabilityRecoveryOptions = {},
): GeminiCapabilityRecoveryHandle {
  if (geminiRecoveryHandle) return geminiRecoveryHandle;

  const { timeoutMs, checkAccess, onVerdict, delay = waitWithUnrefTimer } = options;
  const controller = new AbortController();

  const run = (async (): Promise<void> => {
    let attempt = 0;
    // The first pass reuses any verdict (or probe) that already exists; only
    // re-checks force past the sticky failure they are trying to clear.
    let force = false;
    while (!controller.signal.aborted) {
      const result = await verifyGeminiDirectCapability({
        force,
        timeoutMs,
        checkAccess,
      });
      const retrying =
        !result.ok &&
        result.reason !== GEMINI_CREDENTIAL_MISSING_REASON &&
        !controller.signal.aborted;
      const nextRetryDelayMs = retrying
        ? Math.min(
            GEMINI_CAPABILITY_RETRY_INITIAL_DELAY_MS * 2 ** attempt,
            GEMINI_CAPABILITY_RETRY_MAX_DELAY_MS,
          )
        : null;
      try {
        onVerdict?.({ result, attempt, nextRetryDelayMs });
      } catch {
        // A logging observer must never break recovery.
      }
      if (nextRetryDelayMs === null) return;
      attempt += 1;
      force = true;
      await delay(nextRetryDelayMs, controller.signal);
    }
  })();

  const done = run.finally(() => {
    if (geminiRecoveryHandle === handle) geminiRecoveryHandle = null;
  });
  // The server starts this fire-and-forget; nothing in the loop should ever
  // reject, but a rejection must never surface as unhandled.
  done.catch(() => {});

  const handle: GeminiCapabilityRecoveryHandle = {
    stop: () => controller.abort(),
    done,
  };
  geminiRecoveryHandle = handle;
  return handle;
}

/**
 * Whether the Gemini credential the client would actually use is the direct
 * key. Mirrors getGeminiClient's selection exactly: the direct key wins
 * whenever it is present, even if the managed pair is also configured.
 */
export function geminiDirectCredentialInUse(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

// ─── Provider account health (billing-class) overlay ────────────────────────
//
// Present credentials do not prove the account behind them can pay: a key
// whose account has run out of credits keeps every env check green while each
// call fails fast with a billing-class error. Live calls report that evidence
// here (see streamVenomResponse in venom-provider-adapters), and the catalog
// stops presenting the model as plainly "Ready" until a later call streams
// real content again. Like the Gemini capability gate, the verdict is per
// process: a restart — or the next successful call — clears it.

export type VenomModelAccountHealth = "ok" | "unfunded";

const modelAccountHealth = new Map<VenomModelId, VenomModelAccountHealth>();

/**
 * Record account-health evidence from a live provider call. "unfunded" marks
 * billing-class failures (credits exhausted, quota spent, payment required);
 * "ok" is reported by any call that streams content, so a topped-up account
 * heals itself on the very next attempt — no restart needed.
 */
export function reportVenomModelAccountHealth(
  id: VenomModelId,
  health: VenomModelAccountHealth,
): void {
  modelAccountHealth.set(id, health);
}

/** Latest per-process account-health verdict; no evidence counts as ok. */
export function getVenomModelAccountHealth(
  id: VenomModelId,
): VenomModelAccountHealth {
  return modelAccountHealth.get(id) ?? "ok";
}

/** Test-only: clear recorded account-health verdicts. */
export function resetVenomModelAccountHealthForTests(): void {
  modelAccountHealth.clear();
}

/** Whether a model's provider env vars are present (lazy check at call time). */
function isModelAvailable(id: VenomModelId): boolean {
  // The Gemini client prefers the direct key whenever it is present, so the
  // catalog must follow the same precedence: with a direct key configured,
  // Ready requires the capability check to have passed — even when the
  // managed pair is also set (requests would still use the direct key).
  if (id === "venom-gemini" && geminiDirectCredentialInUse()) {
    return geminiDirectVerified;
  }
  const [urlVar, keyVar] = PROVIDER_ENV_PAIRS[id];
  if (process.env[urlVar] && process.env[keyVar]) return true;
  const directKey = DIRECT_PROVIDER_KEYS[id];
  return Boolean(directKey && process.env[directKey]);
}

/** Build the sanitized catalog. Safe to return in API responses. */
export function buildVenomCatalog(): VenomManagedModel[] {
  return (Object.keys(CATALOG_METADATA) as VenomModelId[]).map((id) => {
    const available = isModelAvailable(id);
    // Account health only qualifies a configured model; an unconfigured one
    // is simply "Not configured". The model stays `available` (selectable) on
    // an account issue so a retry after the owner fixes the account can
    // succeed and clear the verdict — but it is never plainly "Ready".
    const accountHealth = available ? getVenomModelAccountHealth(id) : "ok";
    return {
      ...CATALOG_METADATA[id],
      available,
      availabilityText: !available
        ? "Not configured"
        : accountHealth === "unfunded"
          ? "Provider account issue"
          : "Ready",
      accountHealth,
      costTier: MODEL_RANKINGS[id].costTier,
    };
  });
}

// ─── Account-level model selection policy ───────────────────────────────────
//
// Manual keeps every request on the models the caller named — byte-identical
// to the behavior before policies existed. The auto policies hand the choice
// to the server on every request: cheapest keeps the account on the cheapest
// currently-healthy models, max power on the most capable ones. Because the
// choice re-runs per request against the live catalog, an account going
// unfunded or a model losing availability switches the very next reply with
// no user action.

export type VenomModelSelectionPolicy =
  | "manual"
  | "auto-cheapest"
  | "auto-max-power";

export const VENOM_MODEL_SELECTION_POLICIES: readonly VenomModelSelectionPolicy[] =
  ["manual", "auto-cheapest", "auto-max-power"];

/** Coerce a stored/raw value to a policy; anything unknown means manual. */
export function resolveVenomModelSelectionPolicy(
  raw: unknown,
): VenomModelSelectionPolicy {
  return raw === "auto-cheapest" || raw === "auto-max-power" ? raw : "manual";
}

/**
 * Order a catalog by the active policy's ranking dimension: cheapest-first
 * for auto-cheapest, most-capable-first for auto-max-power. Manual returns
 * the catalog untouched. The sorted copy is what auto modes feed the voice
 * planners, so alternates and debate corners follow the same preference as
 * the anchor while the planners keep enforcing availability, funding, and
 * provider-distinctness exactly as before.
 */
export function rankVenomCatalogForPolicy(
  catalog: VenomManagedModel[],
  policy: VenomModelSelectionPolicy,
): VenomManagedModel[] {
  if (policy === "manual") return catalog;
  const rankOf = (model: VenomManagedModel) =>
    policy === "auto-cheapest"
      ? MODEL_RANKINGS[model.id].costRank
      : MODEL_RANKINGS[model.id].capabilityRank;
  return [...catalog].sort((a, b) => rankOf(a) - rankOf(b));
}

/**
 * Pick the model an auto policy would anchor on right now: the best-ranked
 * model that is available and not unfunded. Returns null for manual — and
 * null when nothing is currently usable, so the caller can fall back to the
 * request's own model and let the existing availability errors speak.
 */
export function planAutoModelSelection(
  catalog: VenomManagedModel[],
  policy: VenomModelSelectionPolicy,
): { modelId: VenomModelId } | null {
  if (policy === "manual") return null;
  const usable = rankVenomCatalogForPolicy(catalog, policy).find(
    (model) => model.available && model.accountHealth !== "unfunded",
  );
  return usable ? { modelId: usable.id } : null;
}

/**
 * Which managed models can read attached images. Grok rides a text-only
 * completion route here, so image parts are swapped for an honest textual
 * note before the request leaves the process (see streamVenomResponse).
 */
const VISION_CAPABLE: Record<VenomModelId, boolean> = {
  "venom-gpt": true,
  "venom-claude": true,
  "venom-gemini": true,
  "venom-grok": false,
};

/** Whether the model receives attached images as pixels (vs. a note). */
export function supportsVenomVision(id: VenomModelId): boolean {
  return VISION_CAPABLE[id];
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
