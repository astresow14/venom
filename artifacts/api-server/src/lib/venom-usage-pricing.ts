/**
 * Venom usage pricing — server-private.
 *
 * Per-model token rates used to precompute the cost of every usage-ledger
 * event. Rates are expressed in micro-dollars per token, which is
 * numerically identical to USD per million tokens.
 *
 * These numbers never leave the server: the usage API returns aggregated
 * dollar totals only, and clients render Venom-branded names. Keep rates —
 * like provider SKUs — out of logs and client payloads.
 *
 * Pure module by design (no db, no env): pricing math is unit-tested in
 * isolation and safe to import from anywhere.
 */

import type { VenomModelId } from "./venom-models";

/** Alias used on usage events for the voice pipeline's audio legs. */
export const VOICE_USAGE_ALIAS = "venom-voice";

/** Client-facing display name for the audio alias. */
export const VOICE_USAGE_DISPLAY_NAME = "Venom Voice";

type TokenRate = {
  /** µ$ per prompt token (== USD per million prompt tokens). */
  inputPerToken: number;
  /** µ$ per output token (== USD per million output tokens). */
  outputPerToken: number;
};

const TOKEN_RATES: Record<VenomModelId, TokenRate> = {
  "venom-gpt": { inputPerToken: 1.25, outputPerToken: 10 },
  "venom-claude": { inputPerToken: 3, outputPerToken: 15 },
  "venom-gemini": { inputPerToken: 0.3, outputPerToken: 2.5 },
  "venom-grok": { inputPerToken: 3, outputPerToken: 15 },
};

/**
 * Flat per-request cost estimates for the audio legs of voice mode, in
 * micro-dollars. Transcription and speech are duration-priced upstream, but
 * Venom never persists audio lengths anywhere, so a request-level flat
 * estimate is the documented tradeoff: transcribe assumes a sub-minute
 * utterance (~$0.006/min), speak a short spoken reply (~$0.015/min of audio
 * out). Events priced this way are always flagged `estimated`.
 */
export const VOICE_FLAT_COST_MICROS = {
  voice_transcribe: 5_000, // ≈ $0.005 per utterance
  voice_speak: 10_000, // ≈ $0.01 per spoken reply
} as const;

/**
 * Chars-per-token heuristic used whenever a provider omits usage metadata
 * (most commonly a stream cut off before its final usage frame). Four chars
 * per token is the industry rule of thumb for English prose.
 */
export const ESTIMATE_CHARS_PER_TOKEN = 4;

export function estimateTokensFromChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / ESTIMATE_CHARS_PER_TOKEN);
}

export type UsageTokenCounts = {
  promptTokens: number;
  outputTokens: number;
  /** True when the counts are char-based estimates, not provider-reported. */
  estimated: boolean;
};

/**
 * Token counts from a non-streaming OpenAI-shaped completion, falling back
 * to a flagged character estimate when the response carried no usage block.
 */
export function usageFromCompletion(
  usage:
    | { prompt_tokens?: number | null; completion_tokens?: number | null }
    | null
    | undefined,
  fallback: { promptChars: number; outputChars: number },
): UsageTokenCounts {
  if (
    usage &&
    typeof usage.prompt_tokens === "number" &&
    typeof usage.completion_tokens === "number"
  ) {
    return {
      promptTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      estimated: false,
    };
  }
  return {
    promptTokens: estimateTokensFromChars(fallback.promptChars),
    outputTokens: estimateTokensFromChars(fallback.outputChars),
    estimated: true,
  };
}

/**
 * Cost of a call in micro-dollars, rounded to the nearest micro-dollar.
 * Unknown aliases price at zero rather than throwing — the ledger must keep
 * recording even if a new alias ships before its rate does.
 */
export function computeCostMicros(
  modelAlias: string,
  promptTokens: number,
  outputTokens: number,
): number {
  const rate = (TOKEN_RATES as Record<string, TokenRate>)[modelAlias];
  if (!rate) return 0;
  const prompt = Math.max(0, promptTokens);
  const output = Math.max(0, outputTokens);
  return Math.round(
    prompt * rate.inputPerToken + output * rate.outputPerToken,
  );
}

/** Micro-dollars → dollars for API payloads. Accepts bigint SQL sums. */
export function microsToUsd(micros: number | bigint): number {
  return Number(micros) / 1_000_000;
}
