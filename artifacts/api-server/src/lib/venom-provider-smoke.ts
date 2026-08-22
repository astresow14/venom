/**
 * Live smoke check for the Venom managed model providers.
 *
 * Completes one short response through every managed model whose provider
 * credentials are provisioned, and reports a per-model verdict.
 *
 * Models whose provider is not provisioned are reported as "Not configured"
 * and skipped — they never fall back to another provider.
 *
 * Security: output is restricted to safe aliases, verdicts and response
 * lengths. Provider model IDs, prompts, response text, tokens and credentials
 * are never printed.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run smoke:venom-providers
 */
import {
  buildVenomCatalog,
  geminiDirectCredentialInUse,
  verifyGeminiDirectCapability,
  type VenomModelId,
  type VenomManagedModel,
} from "./venom-models";
import {
  isBillingClassProviderError,
  streamVenomResponse,
  type VenomMessage,
} from "./venom-provider-adapters";

/** Neutral prompt: short, deterministic, and free of any project content. */
const SMOKE_MESSAGES: VenomMessage[] = [
  { role: "system", content: "Reply with a single short word." },
  { role: "user", content: "Say ready." },
];

const TIMEOUT_MS = 45_000;

export type SmokeVerdict = {
  id: VenomModelId;
  name: string;
  family: VenomManagedModel["family"];
  /** "ready" = one response completed, "skipped" = provider not provisioned. */
  outcome: "ready" | "skipped" | "failed";
  /** Character count of the response. Never the response itself. */
  characters: number;
  /** Safe, provider-agnostic failure reason. Never provider or credential detail. */
  reason?: string;
};

function safeFailureReason(error: unknown, timedOut: boolean): string {
  if (timedOut) return "Timed out before completing a response";
  // Name the account problem so the verdict points at billing, not code.
  // Running this smoke also primes the in-process catalog overlay (the
  // adapters record billing-class evidence on every live call).
  if (isBillingClassProviderError(error)) {
    return "Provider account cannot cover requests (billing-class failure)";
  }
  if (error && typeof error === "object") {
    const candidate = error as { status?: unknown; statusCode?: unknown };
    const status =
      typeof candidate.status === "number"
        ? candidate.status
        : typeof candidate.statusCode === "number"
          ? candidate.statusCode
          : undefined;
    if (status) return `Provider returned HTTP ${status}`;
    const message = error instanceof Error ? error.message : "";
    if (
      message === "model is required and must be a string" ||
      message === "invalid model parameter"
    ) {
      return "Provider request has an invalid model reference";
    }
    if (message === "contents are required") {
      return "Provider request is missing conversation contents";
    }
    if (
      message === "ContentUnion is required" ||
      message === "PartListUnion is required"
    ) {
      return "Provider request has invalid conversation content";
    }
  }
  return "Provider did not complete the response";
}

/** Complete one response for a single managed model. */
export async function smokeTestModel(
  model: VenomManagedModel,
  timeoutMs = TIMEOUT_MS,
): Promise<SmokeVerdict> {
  const base = { id: model.id, name: model.name, family: model.family };

  if (!model.available) {
    return { ...base, outcome: "skipped", characters: 0, reason: "Not configured" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let characters = 0;
    for await (const token of streamVenomResponse(
      model.id,
      SMOKE_MESSAGES,
      controller.signal,
    )) {
      characters += token.length;
    }

    if (characters === 0) {
      return {
        ...base,
        outcome: "failed",
        characters,
        reason: controller.signal.aborted
          ? "Timed out before completing a response"
          : "Completed without producing any text",
      };
    }

    return { ...base, outcome: "ready", characters };
  } catch (error) {
    // The underlying error may carry provider detail, so it is deliberately
    // not surfaced or logged here.
    return {
      ...base,
      outcome: "failed",
      characters: 0,
      reason: safeFailureReason(error, controller.signal.aborted),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Run the smoke check across the whole managed catalog, one model at a time. */
export async function runVenomProviderSmoke(): Promise<SmokeVerdict[]> {
  const verdicts: SmokeVerdict[] = [];
  for (const model of buildVenomCatalog()) {
    verdicts.push(await smokeTestModel(model));
  }
  return verdicts;
}

export function formatVerdict(verdict: SmokeVerdict): string {
  const label = `${verdict.name} (${verdict.id})`.padEnd(32);
  switch (verdict.outcome) {
    case "ready":
      return `PASS  ${label} responded with ${verdict.characters} characters`;
    case "skipped":
      return `SKIP  ${label} ${verdict.reason}`;
    default:
      return `FAIL  ${label} ${verdict.reason}`;
  }
}

async function main(): Promise<void> {
  // Whenever a direct Gemini key is present the client uses it — even if the
  // managed pair is also configured — so resolve the capability check first;
  // the catalog below reflects the real gate. Managed-only environments have
  // nothing to verify (availability stays presence-based, like the others).
  if (geminiDirectCredentialInUse()) {
    const capability = await verifyGeminiDirectCapability();
    console.log(
      capability.ok
        ? "Gemini capability check: passed"
        : `Gemini capability check: failed (${capability.reason})`,
    );
  }

  const verdicts = await runVenomProviderSmoke();
  for (const verdict of verdicts) {
    console.log(formatVerdict(verdict));
  }

  const failed = verdicts.filter((verdict) => verdict.outcome === "failed");
  const skipped = verdicts.filter((verdict) => verdict.outcome === "skipped");
  const passed = verdicts.filter((verdict) => verdict.outcome === "ready");

  console.log(
    `\n${passed.length} ready, ${skipped.length} not configured, ${failed.length} failed.`,
  );

  if (failed.length > 0) process.exitCode = 1;
  else if (
    skipped.length > 0 &&
    process.env.VENOM_PROVIDER_SMOKE_REQUIRE_ALL === "1"
  ) {
    process.exitCode = 2;
  }
}

// Only run when executed as a script, not when imported by tests.
if (process.env.VENOM_PROVIDER_SMOKE_RUN === "1") {
  await main();
}
