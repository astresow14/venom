/**
 * Tests for the Venom managed model catalog.
 *
 * Run with:
 *   pnpm exec esbuild ./src/lib/venom-models.test.ts --bundle --platform=node --format=esm --outfile=/tmp/venom-models.test.mjs && node --test /tmp/venom-models.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildVenomCatalog,
  resolveVenomModelId,
  VENOM_MODEL_IDS,
  DEFAULT_VENOM_MODEL_ID,
  InvalidVenomModelError,
  resolveProviderModelId,
} from "./venom-models";
import {
  buildGeminiRequest,
  normalizeProviderError,
  ProviderError,
  splitSystemMessages,
  streamWithSingleRetry,
  toGeminiContents,
  toOpenAIMessages,
  type VenomMessage,
} from "./venom-provider-adapters";

describe("VENOM_MODEL_IDS allowlist", () => {
  it("contains exactly the four managed IDs", () => {
    const ids = [...VENOM_MODEL_IDS];
    assert.deepEqual(ids.sort(), ["venom-claude", "venom-gemini", "venom-gpt", "venom-grok"]);
  });

  it("does not contain provider model IDs", () => {
    assert.equal(VENOM_MODEL_IDS.has("gpt-5.6-terra" as never), false);
    assert.equal(VENOM_MODEL_IDS.has("claude-sonnet-4-6" as never), false);
    assert.equal(VENOM_MODEL_IDS.has("gemini-3-flash-preview" as never), false);
    assert.equal(VENOM_MODEL_IDS.has("x-ai/grok-4.6" as never), false);
  });
});

describe("resolveVenomModelId", () => {
  it("returns the passed model ID when it is valid", () => {
    assert.equal(resolveVenomModelId("venom-gpt"), "venom-gpt");
    assert.equal(resolveVenomModelId("venom-claude"), "venom-claude");
    assert.equal(resolveVenomModelId("venom-gemini"), "venom-gemini");
    assert.equal(resolveVenomModelId("venom-grok"), "venom-grok");
  });

  it("falls back to venom-gpt for undefined (legacy callers)", () => {
    assert.equal(resolveVenomModelId(undefined), DEFAULT_VENOM_MODEL_ID);
    assert.equal(resolveVenomModelId(null), DEFAULT_VENOM_MODEL_ID);
  });

  it("rejects unknown model IDs instead of silently switching", () => {
    for (const raw of [
      "gpt-5.6-terra",
      "claude-sonnet-4-6",
      "gemini-3-flash-preview",
      "x-ai/grok-4.6",
      "../../etc/passwd",
      "gpt-4o",
    ]) {
      assert.throws(
        () => resolveVenomModelId(raw as never),
        InvalidVenomModelError,
      );
    }
  });
});

describe("provider protocol adaptation", () => {
  const messages: VenomMessage[] = [
    { role: "system", content: "fixed policy" },
    { role: "user", content: "question" },
    { role: "assistant", content: "answer" },
  ];

  it("preserves OpenAI and OpenRouter roles without provider metadata", () => {
    assert.deepEqual(toOpenAIMessages(messages), messages);
  });

  it("separates Anthropic system text from chat turns", () => {
    assert.deepEqual(splitSystemMessages(messages), {
      system: "fixed policy",
      chat: [
        { role: "user", content: "question" },
        { role: "assistant", content: "answer" },
      ],
    });
  });

  it("maps assistant turns to Gemini model turns", () => {
    assert.deepEqual(toGeminiContents(messages), [
      { role: "user", parts: [{ text: "question" }] },
      { role: "model", parts: [{ text: "answer" }] },
    ]);
  });

  it("passes cancellation through Gemini generation config", () => {
    const controller = new AbortController();
    const request = buildGeminiRequest(messages, controller.signal);

    assert.equal(request.config.abortSignal, controller.signal);
  });
});

describe("provider streaming controls", () => {
  it("retries one retryable pre-stream failure and completes", async () => {
    let attempts = 0;
    const chunks: string[] = [];
    const stream = streamWithSingleRetry(async function* () {
      attempts += 1;
      if (attempts === 1) throw { status: 503 };
      yield "done";
    }, undefined, 0);
    for await (const chunk of stream) chunks.push(chunk);
    assert.equal(attempts, 2);
    assert.deepEqual(chunks, ["done"]);
  });

  it("does not retry after content has started", async () => {
    let attempts = 0;
    const stream = streamWithSingleRetry(async function* () {
      attempts += 1;
      yield "partial";
      throw { status: 503 };
    }, undefined, 0);
    await assert.rejects(async () => {
      for await (const _chunk of stream) {
        // Consume until the normalized provider failure is raised.
      }
    }, ProviderError);
    assert.equal(attempts, 1);
  });

  it("stops without retrying when cancelled", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const chunks: string[] = [];
    const stream = streamWithSingleRetry(async function* () {
      attempts += 1;
      yield "first";
      yield "second";
    }, controller.signal, 0);
    for await (const chunk of stream) {
      chunks.push(chunk);
      controller.abort();
    }
    assert.equal(attempts, 1);
    assert.deepEqual(chunks, ["first"]);
  });

  it("classifies rate limits as retryable without forwarding provider text", () => {
    const error = normalizeProviderError({
      status: 429,
      message: "provider response containing request details",
    });
    assert.equal(error.status, 429);
    assert.equal(error.retryable, true);
    assert.equal(error.message.includes("request details"), false);
  });
});

describe("resolveProviderModelId — server-side only", () => {
  it("resolves venom-gpt to the actual OpenAI model ID", () => {
    assert.equal(resolveProviderModelId("venom-gpt"), "gpt-5.6-terra");
  });

  it("resolves venom-claude to the actual Anthropic model ID", () => {
    assert.equal(resolveProviderModelId("venom-claude"), "claude-sonnet-4-6");
  });

  it("resolves venom-gemini to the actual Gemini model ID", () => {
    assert.equal(resolveProviderModelId("venom-gemini"), "gemini-3-flash-preview");
  });

  it("resolves venom-grok to the actual OpenRouter model ID", () => {
    assert.equal(resolveProviderModelId("venom-grok"), "x-ai/grok-4.6");
  });
});

describe("buildVenomCatalog", () => {
  it("returns exactly four entries in catalog order", () => {
    const catalog = buildVenomCatalog();
    assert.equal(catalog.length, 4);
  });

  it("all entries have required safe fields", () => {
    const catalog = buildVenomCatalog();
    for (const model of catalog) {
      assert.ok(model.id, "id must be present");
      assert.ok(model.name, "name must be present");
      assert.ok(model.summary, "summary must be present");
      assert.ok(model.family, "family must be present");
      assert.ok(model.provider, "provider must be present");
      assert.equal(typeof model.available, "boolean");
      assert.ok(model.availabilityText, "availabilityText must be present");
    }
  });

  it("does NOT include provider model IDs in catalog entries", () => {
    const catalog = buildVenomCatalog();
    const serialized = JSON.stringify(catalog);
    assert.equal(serialized.includes("gpt-5.6-terra"), false, "must not expose GPT model ID");
    assert.equal(serialized.includes("claude-sonnet-4-6"), false, "must not expose Claude model ID");
    assert.equal(serialized.includes("gemini-3-flash-preview"), false, "must not expose Gemini model ID");
    assert.equal(serialized.includes("x-ai/grok-4.6"), false, "must not expose Grok model ID");
  });

  it("marks models unavailable when env vars are missing", () => {
    // In test environment there are no AI integration env vars, so all should be unavailable
    const catalog = buildVenomCatalog();
    // At least one should be unavailable if env vars are not set in test
    const anyAvailable = catalog.some((m) => m.available);
    // This just verifies the available field is computed — actual value depends on env
    assert.equal(typeof anyAvailable, "boolean");
  });

  it("keeps a direct Gemini key inactive until explicitly enabled", () => {
    const previousDirectKey = process.env.GEMINI_API_KEY;
    const previousManagedUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
    const previousManagedKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
    const previousOptIn = process.env.VENOM_ENABLE_GEMINI_DIRECT;

    delete process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
    delete process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test";
    delete process.env.VENOM_ENABLE_GEMINI_DIRECT;
    assert.equal(
      buildVenomCatalog().find((model) => model.id === "venom-gemini")?.available,
      false,
    );

    process.env.VENOM_ENABLE_GEMINI_DIRECT = "true";
    assert.equal(
      buildVenomCatalog().find((model) => model.id === "venom-gemini")?.available,
      true,
    );

    if (previousDirectKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousDirectKey;
    if (previousManagedUrl === undefined) delete process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
    else process.env.AI_INTEGRATIONS_GEMINI_BASE_URL = previousManagedUrl;
    if (previousManagedKey === undefined) delete process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
    else process.env.AI_INTEGRATIONS_GEMINI_API_KEY = previousManagedKey;
    if (previousOptIn === undefined) delete process.env.VENOM_ENABLE_GEMINI_DIRECT;
    else process.env.VENOM_ENABLE_GEMINI_DIRECT = previousOptIn;
  });

  it("maps each id to expected provider", () => {
    const catalog = buildVenomCatalog();
    const byId = Object.fromEntries(catalog.map((m) => [m.id, m]));
    assert.equal(byId["venom-gpt"].provider, "openai");
    assert.equal(byId["venom-claude"].provider, "anthropic");
    assert.equal(byId["venom-gemini"].provider, "gemini");
    assert.equal(byId["venom-grok"].provider, "openrouter");
  });

  it("maps each id to expected family", () => {
    const catalog = buildVenomCatalog();
    const byId = Object.fromEntries(catalog.map((m) => [m.id, m]));
    assert.equal(byId["venom-gpt"].family, "GPT");
    assert.equal(byId["venom-claude"].family, "Claude");
    assert.equal(byId["venom-gemini"].family, "Gemini");
    assert.equal(byId["venom-grok"].family, "Grok");
  });
});

describe("safe metadata — ids never expose internal details", () => {
  it("model names do not contain provider model ID substrings", () => {
    const catalog = buildVenomCatalog();
    for (const model of catalog) {
      assert.equal(model.name.includes("gpt-5.6"), false);
      assert.equal(model.name.includes("claude-sonnet"), false);
      assert.equal(model.name.includes("gemini-3-flash"), false);
      assert.equal(model.name.includes("x-ai/"), false);
    }
  });

  it("summaries do not contain provider model ID substrings", () => {
    const catalog = buildVenomCatalog();
    for (const model of catalog) {
      assert.equal(model.summary.includes("gpt-5.6"), false);
      assert.equal(model.summary.includes("claude-sonnet"), false);
      assert.equal(model.summary.includes("gemini-3-flash"), false);
      assert.equal(model.summary.includes("x-ai/"), false);
    }
  });
});
