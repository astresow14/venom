/**
 * Unit tests for the server-private usage pricing module: the char→token
 * estimation heuristic, completion-usage extraction with its flagged
 * fallback, token→micro-dollar cost math, and the micro→dollar conversion
 * the API layer uses. Pure module — no db, no env, no network.
 *
 * Run: pnpm --filter @workspace/api-server run test:usage
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeCostMicros,
  ESTIMATE_CHARS_PER_TOKEN,
  estimateTokensFromChars,
  microsToUsd,
  usageFromCompletion,
  VOICE_FLAT_COST_MICROS,
  VOICE_USAGE_ALIAS,
  VOICE_USAGE_DISPLAY_NAME,
} from "./venom-usage-pricing.js";

test("estimateTokensFromChars: four chars per token, rounded up", () => {
  assert.equal(estimateTokensFromChars(0), 0);
  assert.equal(estimateTokensFromChars(-50), 0);
  assert.equal(estimateTokensFromChars(Number.NaN), 0);
  assert.equal(estimateTokensFromChars(1), 1);
  assert.equal(estimateTokensFromChars(4), 1);
  assert.equal(estimateTokensFromChars(5), 2);
  assert.equal(estimateTokensFromChars(4000), 1000);
  // The constant is what the heuristic actually uses.
  assert.equal(
    estimateTokensFromChars(ESTIMATE_CHARS_PER_TOKEN * 123),
    123,
  );
});

test("usageFromCompletion: provider-reported counts pass through unflagged", () => {
  const usage = usageFromCompletion(
    { prompt_tokens: 812, completion_tokens: 96 },
    { promptChars: 999_999, outputChars: 999_999 },
  );
  assert.deepEqual(usage, {
    promptTokens: 812,
    outputTokens: 96,
    estimated: false,
  });
});

test("usageFromCompletion: zero is a real provider report, not a fallback trigger", () => {
  const usage = usageFromCompletion(
    { prompt_tokens: 0, completion_tokens: 0 },
    { promptChars: 400, outputChars: 400 },
  );
  assert.deepEqual(usage, {
    promptTokens: 0,
    outputTokens: 0,
    estimated: false,
  });
});

test("usageFromCompletion: missing usage falls back to a flagged char estimate", () => {
  for (const missing of [
    undefined,
    null,
    {},
    { prompt_tokens: 10 },
    { completion_tokens: 10 },
    { prompt_tokens: null, completion_tokens: 12 },
  ] as const) {
    const usage = usageFromCompletion(missing, {
      promptChars: 401,
      outputChars: 39,
    });
    assert.deepEqual(
      usage,
      { promptTokens: 101, outputTokens: 10, estimated: true },
      `fallback expected for ${JSON.stringify(missing)}`,
    );
  }
});

test("computeCostMicros: micro-dollar rates by venom alias", () => {
  // venom-gpt: 1.25 µ$/prompt token, 10 µ$/output token.
  assert.equal(computeCostMicros("venom-gpt", 1000, 500), 1250 + 5000);
  // venom-claude and venom-grok share 3 / 15.
  assert.equal(computeCostMicros("venom-claude", 200, 100), 600 + 1500);
  assert.equal(computeCostMicros("venom-grok", 200, 100), 600 + 1500);
  // venom-gemini: 0.3 / 2.5.
  assert.equal(computeCostMicros("venom-gemini", 1000, 200), 300 + 500);
});

test("computeCostMicros: rounds to the nearest micro-dollar", () => {
  // 1 prompt token on venom-gemini = 0.3 µ$ → rounds to 0; 2 → 0.6 → 1.
  assert.equal(computeCostMicros("venom-gemini", 1, 0), 0);
  assert.equal(computeCostMicros("venom-gemini", 2, 0), 1);
});

test("computeCostMicros: unknown aliases price at zero instead of throwing", () => {
  assert.equal(computeCostMicros("venom-mystery", 10_000, 10_000), 0);
  // The voice alias is flat-priced by its callers, never token-priced here.
  assert.equal(computeCostMicros(VOICE_USAGE_ALIAS, 10_000, 10_000), 0);
});

test("computeCostMicros: negative token counts clamp to zero", () => {
  assert.equal(computeCostMicros("venom-gpt", -100, -100), 0);
  assert.equal(computeCostMicros("venom-gpt", -100, 10), 100);
});

test("microsToUsd: micro-dollars to dollars, bigint sums included", () => {
  assert.equal(microsToUsd(0), 0);
  assert.equal(microsToUsd(6250), 0.00625);
  assert.equal(microsToUsd(1_000_000), 1);
  assert.equal(microsToUsd(12_345_678n), 12.345678);
});

test("voice flat estimates: positive, and cheaper than a minute of provider audio", () => {
  // The documented tradeoff prices a sub-minute utterance and a short
  // spoken reply; both must stay positive so voice legs never meter free.
  assert.ok(VOICE_FLAT_COST_MICROS.voice_transcribe > 0);
  assert.ok(VOICE_FLAT_COST_MICROS.voice_speak > 0);
  // Sanity ceiling: a flat leg should stay under one cent so the estimate
  // errs low-stakes; a change past this needs a deliberate decision.
  assert.ok(VOICE_FLAT_COST_MICROS.voice_transcribe <= 10_000);
  assert.ok(VOICE_FLAT_COST_MICROS.voice_speak <= 10_000);
});

test("voice alias and display name stay venom-branded", () => {
  assert.match(VOICE_USAGE_ALIAS, /^venom-/);
  assert.match(VOICE_USAGE_DISPLAY_NAME, /^Venom /);
});
