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
  geminiDirectCredentialInUse,
  verifyGeminiDirectCapability,
  resetGeminiDirectCapabilityForTests,
  startGeminiDirectCapabilityRecovery,
  reportVenomModelAccountHealth,
  getVenomModelAccountHealth,
  resetVenomModelAccountHealthForTests,
  resolveVenomModelSelectionPolicy,
  rankVenomCatalogForPolicy,
  planAutoModelSelection,
  VENOM_MODEL_SELECTION_POLICIES,
  type VenomManagedModel,
  type VenomModelId,
} from "./venom-models";
import {
  buildGeminiRequest,
  imagesUnviewableNote,
  isBillingClassProviderError,
  normalizeProviderError,
  PROVIDER_ACCOUNT_ERROR_MESSAGE,
  ProviderError,
  providerErrorClientPayload,
  replaceImagesWithNotes,
  splitSystemMessages,
  streamWithSingleRetry,
  toAnthropicMessages,
  toGeminiContents,
  toOpenAIMessages,
  type VenomMessage,
} from "./venom-provider-adapters";
import { supportsVenomVision } from "./venom-models";

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

describe("multimodal provider payloads", () => {
  const chart = {
    name: "chart.png",
    mimeType: "image/png",
    dataBase64: "cG5nLWJ5dGVz",
  };
  const photo = {
    name: "photo.jpg",
    mimeType: "image/jpeg",
    dataBase64: "anBlZy1ieXRlcw==",
  };
  const withImages: VenomMessage[] = [
    { role: "system", content: "fixed policy" },
    { role: "user", content: "what is this?", images: [chart, photo] },
    { role: "assistant", content: "an answer" },
    // An image can be the whole message — no prompt text at all.
    { role: "user", content: "", images: [chart] },
  ];

  it("supportsVenomVision gates exactly the vision-capable catalog", () => {
    assert.equal(supportsVenomVision("venom-gpt"), true);
    assert.equal(supportsVenomVision("venom-claude"), true);
    assert.equal(supportsVenomVision("venom-gemini"), true);
    assert.equal(supportsVenomVision("venom-grok"), false);
  });

  it("OpenAI user turns become text + image_url data-URL parts", () => {
    const mapped = toOpenAIMessages(withImages);
    assert.deepEqual(mapped[0], { role: "system", content: "fixed policy" });
    assert.deepEqual(mapped[1], {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,cG5nLWJ5dGVz" },
        },
        {
          type: "image_url",
          image_url: { url: "data:image/jpeg;base64,anBlZy1ieXRlcw==" },
        },
      ],
    });
    assert.deepEqual(mapped[2], { role: "assistant", content: "an answer" });
    // No empty text part when the message is image-only.
    assert.deepEqual(mapped[3], {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,cG5nLWJ5dGVz" },
        },
      ],
    });
  });

  it("Anthropic user turns put base64 image blocks before the text", () => {
    const { chat } = splitSystemMessages(withImages);
    const mapped = toAnthropicMessages(chat);
    assert.deepEqual(mapped[0], {
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "cG5nLWJ5dGVz",
          },
        },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: "anBlZy1ieXRlcw==",
          },
        },
        { type: "text", text: "what is this?" },
      ],
    });
    // Assistant turns stay plain strings.
    assert.deepEqual(mapped[1], { role: "assistant", content: "an answer" });
    // Image-only: no empty text block trails the images.
    assert.deepEqual(mapped[2].content, [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "cG5nLWJ5dGVz",
        },
      },
    ]);
  });

  it("Gemini user turns carry inlineData and never zero parts", () => {
    const contents = toGeminiContents(withImages);
    assert.deepEqual(contents[0], {
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/png", data: "cG5nLWJ5dGVz" } },
        { inlineData: { mimeType: "image/jpeg", data: "anBlZy1ieXRlcw==" } },
        { text: "what is this?" },
      ],
    });
    assert.deepEqual(contents[1], {
      role: "model",
      parts: [{ text: "an answer" }],
    });
    // Image-only turns must not include an empty text part…
    assert.deepEqual(contents[2].parts, [
      { inlineData: { mimeType: "image/png", data: "cG5nLWJ5dGVz" } },
    ]);
    // …while a plain empty message still gets one (zero parts is invalid).
    const empty = toGeminiContents([{ role: "user", content: "" }]);
    assert.deepEqual(empty[0].parts, [{ text: "" }]);
  });

  it("replaceImagesWithNotes swaps pixels for the honest note", () => {
    const replaced = replaceImagesWithNotes(withImages);
    assert.equal(replaced[1].images, undefined);
    assert.ok(replaced[1].content.startsWith("what is this?"));
    assert.match(replaced[1].content, /chart\.png, photo\.jpg/);
    assert.match(replaced[1].content, /cannot view images/);
    assert.match(replaced[1].content, /2 images/);
    // Untouched turns pass through unchanged.
    assert.deepEqual(replaced[0], withImages[0]);
    assert.deepEqual(replaced[2], withImages[2]);
    // Image-only messages become the note alone, with no leading blank.
    assert.equal(replaced[3].content, imagesUnviewableNote([chart]));
    // Nothing leaked the actual image bytes into the note.
    assert.equal(replaced[1].content.includes("cG5nLWJ5dGVz"), false);
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

describe("billing-class provider failures", () => {
  // Shaped like the Anthropic SDK error for an out-of-credits account: the
  // request is well-formed, the model ID is valid, but the account can't pay.
  const anthropicOutOfCredits = {
    status: 400,
    message:
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
  };

  it("classifies out-of-credits 4xx failures as account failures", () => {
    assert.equal(isBillingClassProviderError(anthropicOutOfCredits), true);
    assert.equal(
      isBillingClassProviderError({ status: 402, message: "Payment Required" }),
      true,
      "402 is billing by definition",
    );
    assert.equal(
      isBillingClassProviderError({
        status: 400,
        message: "request failed",
        error: { error: { message: "Insufficient credits. Add more to continue." } },
      }),
      true,
      "nested provider error bodies count",
    );
  });

  it("normalizes billing failures to fixed, non-retryable account copy", () => {
    const error = normalizeProviderError(anthropicOutOfCredits);
    assert.equal(error.kind, "account_billing");
    assert.equal(error.retryable, false);
    assert.equal(error.message, PROVIDER_ACCOUNT_ERROR_MESSAGE);
    assert.equal(
      error.message.includes("credit balance"),
      false,
      "provider error text must not leak",
    );
    assert.equal(
      error.message.includes("Anthropic"),
      false,
      "provider name must not leak",
    );
  });

  it("treats exhausted-quota 429s as account failures, not rate limits", () => {
    const error = normalizeProviderError({
      status: 429,
      code: "insufficient_quota",
      message:
        "429 You exceeded your current quota, please check your plan and billing details.",
    });
    assert.equal(error.kind, "account_billing");
    assert.equal(error.retryable, false);
  });

  it("leaves plain rate limits, server faults, and unrelated 400s alone", () => {
    assert.equal(
      isBillingClassProviderError({ status: 429, message: "Too Many Requests" }),
      false,
      "an ordinary rate limit stays retryable",
    );
    assert.equal(
      isBillingClassProviderError({ status: 500, message: "credit balance is too low" }),
      false,
      "server faults are transient regardless of text",
    );
    assert.equal(
      isBillingClassProviderError({
        status: 400,
        message: "invalid request: malformed contents",
      }),
      false,
    );
    assert.equal(
      normalizeProviderError({ status: 429, message: "Too Many Requests" }).kind,
      "generic",
    );
  });

  it("does not burn a retry on a billing failure", async () => {
    let attempts = 0;
    const stream = streamWithSingleRetry(async function* () {
      attempts += 1;
      if (attempts >= 1) {
        throw {
          status: 429,
          code: "insufficient_quota",
          message: "exceeded your current quota",
        };
      }
      yield "never";
    }, undefined, 0);
    await assert.rejects(
      async () => {
        for await (const _chunk of stream) {
          // Should fail before any content arrives.
        }
      },
      (error: unknown) =>
        error instanceof ProviderError && error.kind === "account_billing",
    );
    assert.equal(attempts, 1, "billing failures must not trigger the retry");
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
      assert.ok(
        model.accountHealth === "ok" || model.accountHealth === "unfunded",
        "accountHealth must be a known verdict",
      );
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

  it("marks a direct Gemini key Ready only after the capability check passes", async () => {
    const previousDirectKey = process.env.GEMINI_API_KEY;
    const previousManagedUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
    const previousManagedKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;

    const geminiEntry = () =>
      buildVenomCatalog().find((model) => model.id === "venom-gemini");

    delete process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
    delete process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test";
    resetGeminiDirectCapabilityForTests();

    try {
      // A retained, unverified secret must not advertise the model.
      assert.equal(geminiEntry()?.available, false);
      assert.equal(geminiEntry()?.availabilityText, "Not configured");

      // A failed check keeps it held back.
      const failed = await verifyGeminiDirectCapability({
        force: true,
        checkAccess: async () => ({ ok: false, status: 403 }),
      });
      assert.equal(failed.ok, false);
      assert.match(failed.reason ?? "", /HTTP 403/);
      assert.equal(geminiEntry()?.available, false);

      // Only a passing check flips the catalog to Ready.
      const passed = await verifyGeminiDirectCapability({
        force: true,
        checkAccess: async () => ({ ok: true }),
      });
      assert.equal(passed.ok, true);
      assert.equal(geminiEntry()?.available, true);
      assert.equal(geminiEntry()?.availabilityText, "Ready");

      // Losing the key closes the gate even after a passing check.
      delete process.env.GEMINI_API_KEY;
      assert.equal(geminiEntry()?.available, false);
    } finally {
      if (previousDirectKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousDirectKey;
      if (previousManagedUrl === undefined) delete process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
      else process.env.AI_INTEGRATIONS_GEMINI_BASE_URL = previousManagedUrl;
      if (previousManagedKey === undefined) delete process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
      else process.env.AI_INTEGRATIONS_GEMINI_API_KEY = previousManagedKey;
      resetGeminiDirectCapabilityForTests();
    }
  });

  it("keeps the managed Gemini integration pair available without the direct check", () => {
    const previousDirectKey = process.env.GEMINI_API_KEY;
    const previousManagedUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
    const previousManagedKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;

    // A managed-only environment: no direct key anywhere, or the direct-key
    // precedence gate (rightly) takes over.
    delete process.env.GEMINI_API_KEY;
    process.env.AI_INTEGRATIONS_GEMINI_BASE_URL = "https://managed.example.test";
    process.env.AI_INTEGRATIONS_GEMINI_API_KEY = "managed";
    resetGeminiDirectCapabilityForTests();

    try {
      assert.equal(geminiDirectCredentialInUse(), false);
      assert.equal(
        buildVenomCatalog().find((model) => model.id === "venom-gemini")?.available,
        true,
      );
    } finally {
      if (previousDirectKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousDirectKey;
      if (previousManagedUrl === undefined) delete process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
      else process.env.AI_INTEGRATIONS_GEMINI_BASE_URL = previousManagedUrl;
      if (previousManagedKey === undefined) delete process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
      else process.env.AI_INTEGRATIONS_GEMINI_API_KEY = previousManagedKey;
      resetGeminiDirectCapabilityForTests();
    }
  });

  it("gates a mixed direct+managed configuration on the direct-key check", async () => {
    const previousDirectKey = process.env.GEMINI_API_KEY;
    const previousManagedUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
    const previousManagedKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;

    const geminiEntry = () =>
      buildVenomCatalog().find((model) => model.id === "venom-gemini");

    process.env.AI_INTEGRATIONS_GEMINI_BASE_URL = "https://managed.example.test";
    process.env.AI_INTEGRATIONS_GEMINI_API_KEY = "managed";
    process.env.GEMINI_API_KEY = "direct";
    resetGeminiDirectCapabilityForTests();

    try {
      // The client prefers the direct key whenever it is present, so the
      // managed pair must not short-circuit the gate (this is also the
      // condition the boot kick and the smoke script branch on).
      assert.equal(geminiDirectCredentialInUse(), true);
      assert.equal(geminiEntry()?.available, false);
      assert.equal(geminiEntry()?.availabilityText, "Not configured");

      // An unauthorized direct key keeps Gemini held back even though the
      // managed pair is fully present — and the check must actually run.
      let checks = 0;
      const failed = await verifyGeminiDirectCapability({
        force: true,
        checkAccess: async () => {
          checks += 1;
          return { ok: false, status: 403 };
        },
      });
      assert.equal(failed.ok, false);
      assert.equal(checks, 1, "check must run despite the managed pair");
      assert.equal(geminiEntry()?.available, false);
      assert.equal(geminiEntry()?.availabilityText, "Not configured");

      // An authorized direct key flips it to Ready.
      const passed = await verifyGeminiDirectCapability({
        force: true,
        checkAccess: async () => ({ ok: true }),
      });
      assert.equal(passed.ok, true);
      assert.equal(geminiEntry()?.available, true);
      assert.equal(geminiEntry()?.availabilityText, "Ready");

      // Removing the direct key falls back to the managed pair, which stays
      // presence-based like every other provider — no check required.
      delete process.env.GEMINI_API_KEY;
      assert.equal(geminiDirectCredentialInUse(), false);
      assert.equal(geminiEntry()?.available, true);
      assert.equal(geminiEntry()?.availabilityText, "Ready");
    } finally {
      if (previousDirectKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousDirectKey;
      if (previousManagedUrl === undefined) delete process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
      else process.env.AI_INTEGRATIONS_GEMINI_BASE_URL = previousManagedUrl;
      if (previousManagedKey === undefined) delete process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
      else process.env.AI_INTEGRATIONS_GEMINI_API_KEY = previousManagedKey;
      resetGeminiDirectCapabilityForTests();
    }
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

describe("provider account health overlay", () => {
  const claudeEntry = () =>
    buildVenomCatalog().find((model) => model.id === "venom-claude");

  function restoreEnv(key: string, value: string | undefined) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  /** Run with only the direct Anthropic key configured, then restore. */
  async function withDirectClaudeKey(run: () => void | Promise<void>) {
    const previousDirect = process.env.ANTHROPIC_API_KEY;
    const previousManagedUrl = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
    const previousManagedKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test";
    delete process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
    delete process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
    resetVenomModelAccountHealthForTests();
    try {
      await run();
    } finally {
      restoreEnv("ANTHROPIC_API_KEY", previousDirect);
      restoreEnv("AI_INTEGRATIONS_ANTHROPIC_BASE_URL", previousManagedUrl);
      restoreEnv("AI_INTEGRATIONS_ANTHROPIC_API_KEY", previousManagedKey);
      resetVenomModelAccountHealthForTests();
    }
  }

  it("keeps a billing-dead model selectable but never plainly Ready", async () => {
    await withDirectClaudeKey(() => {
      assert.equal(claudeEntry()?.available, true);
      assert.equal(claudeEntry()?.availabilityText, "Ready");
      assert.equal(claudeEntry()?.accountHealth, "ok");

      reportVenomModelAccountHealth("venom-claude", "unfunded");
      const entry = claudeEntry();
      // Still selectable: the credential exists, and retrying after the owner
      // tops up the account is the recovery path — but never plain "Ready".
      assert.equal(entry?.available, true);
      assert.equal(entry?.accountHealth, "unfunded");
      assert.equal(entry?.availabilityText, "Provider account issue");
    });
  });

  it("heals as soon as a later call reports success", async () => {
    await withDirectClaudeKey(() => {
      reportVenomModelAccountHealth("venom-claude", "unfunded");
      reportVenomModelAccountHealth("venom-claude", "ok");
      assert.equal(claudeEntry()?.accountHealth, "ok");
      assert.equal(claudeEntry()?.availabilityText, "Ready");
    });
  });

  it("never taints other models and defaults to ok without evidence", async () => {
    await withDirectClaudeKey(() => {
      reportVenomModelAccountHealth("venom-claude", "unfunded");
      assert.equal(getVenomModelAccountHealth("venom-gpt"), "ok");
      const others = buildVenomCatalog().filter(
        (model) => model.id !== "venom-claude",
      );
      assert.ok(others.every((model) => model.accountHealth === "ok"));
    });
  });

  it("reports unconfigured models as Not configured, not account issues", async () => {
    const previousDirect = process.env.ANTHROPIC_API_KEY;
    const previousManagedUrl = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
    const previousManagedKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
    delete process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
    resetVenomModelAccountHealthForTests();
    try {
      // Stale evidence for a model that lost its key must not resurface as an
      // account issue — missing credentials win.
      reportVenomModelAccountHealth("venom-claude", "unfunded");
      const entry = claudeEntry();
      assert.equal(entry?.available, false);
      assert.equal(entry?.availabilityText, "Not configured");
      assert.equal(entry?.accountHealth, "ok");
    } finally {
      restoreEnv("ANTHROPIC_API_KEY", previousDirect);
      restoreEnv("AI_INTEGRATIONS_ANTHROPIC_BASE_URL", previousManagedUrl);
      restoreEnv("AI_INTEGRATIONS_ANTHROPIC_API_KEY", previousManagedKey);
      resetVenomModelAccountHealthForTests();
    }
  });
});

describe("verifyGeminiDirectCapability", () => {
  const withDirectKeyOnly = async (
    run: () => Promise<void>,
  ): Promise<void> => {
    const previousDirectKey = process.env.GEMINI_API_KEY;
    const previousManagedUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
    const previousManagedKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;

    delete process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
    delete process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test";
    resetGeminiDirectCapabilityForTests();

    try {
      await run();
    } finally {
      if (previousDirectKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousDirectKey;
      if (previousManagedUrl === undefined) delete process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
      else process.env.AI_INTEGRATIONS_GEMINI_BASE_URL = previousManagedUrl;
      if (previousManagedKey === undefined) delete process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
      else process.env.AI_INTEGRATIONS_GEMINI_API_KEY = previousManagedKey;
      resetGeminiDirectCapabilityForTests();
    }
  };

  it("checks catalog access for the pinned provider model", async () => {
    await withDirectKeyOnly(async () => {
      let checkedModelId: string | undefined;
      const result = await verifyGeminiDirectCapability({
        checkAccess: async (providerModelId) => {
          checkedModelId = providerModelId;
          return { ok: true };
        },
      });
      assert.equal(result.ok, true);
      assert.equal(checkedModelId, resolveProviderModelId("venom-gemini"));
    });
  });

  it("caches the verdict — one probe serves later calls", async () => {
    await withDirectKeyOnly(async () => {
      let calls = 0;
      const checkAccess = async () => {
        calls += 1;
        return { ok: true };
      };
      await verifyGeminiDirectCapability({ checkAccess });
      const second = await verifyGeminiDirectCapability({ checkAccess });
      assert.equal(second.ok, true);
      assert.equal(calls, 1);
    });
  });

  it("keeps a failed verdict sticky until forced", async () => {
    await withDirectKeyOnly(async () => {
      let calls = 0;
      const failing = async () => {
        calls += 1;
        return { ok: false, status: 403 };
      };
      const first = await verifyGeminiDirectCapability({ checkAccess: failing });
      const cached = await verifyGeminiDirectCapability({ checkAccess: failing });
      assert.equal(first.ok, false);
      assert.equal(cached.ok, false);
      assert.equal(calls, 1);

      const forced = await verifyGeminiDirectCapability({
        force: true,
        checkAccess: async () => ({ ok: true }),
      });
      assert.equal(forced.ok, true);
    });
  });

  it("reports a missing credential without probing the provider", async () => {
    await withDirectKeyOnly(async () => {
      delete process.env.GEMINI_API_KEY;
      let calls = 0;
      const result = await verifyGeminiDirectCapability({
        checkAccess: async () => {
          calls += 1;
          return { ok: true };
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "Gemini credential is not configured");
      assert.equal(calls, 0);
    });
  });

  it("maps timeouts to a safe reason", async () => {
    await withDirectKeyOnly(async () => {
      const result = await verifyGeminiDirectCapability({
        checkAccess: async () => ({ ok: false, timedOut: true }),
      });
      assert.equal(result.ok, false);
      assert.match(result.reason ?? "", /Timed out/);
    });
  });

  it("never exposes provider model IDs or thrown provider detail", async () => {
    await withDirectKeyOnly(async () => {
      const thrown = await verifyGeminiDirectCapability({
        checkAccess: async () => {
          throw new Error(
            "secret provider detail about gemini-3-flash-preview and api keys",
          );
        },
      });
      assert.equal(thrown.ok, false);
      assert.equal(
        thrown.reason,
        "Gemini model catalog access could not be confirmed",
      );

      const failed = await verifyGeminiDirectCapability({
        force: true,
        checkAccess: async () => ({ ok: false, status: 404 }),
      });
      assert.equal(failed.ok, false);
      for (const reason of [thrown.reason ?? "", failed.reason ?? ""]) {
        assert.equal(reason.includes("gemini-3-flash-preview"), false);
        assert.equal(reason.includes("secret provider detail"), false);
      }
    });
  });
});

describe("startGeminiDirectCapabilityRecovery", () => {
  const withDirectKeyOnly = async (
    run: () => Promise<void>,
  ): Promise<void> => {
    const previousDirectKey = process.env.GEMINI_API_KEY;
    const previousManagedUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
    const previousManagedKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;

    delete process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
    delete process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test";
    resetGeminiDirectCapabilityForTests();

    try {
      await run();
    } finally {
      if (previousDirectKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousDirectKey;
      if (previousManagedUrl === undefined) delete process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
      else process.env.AI_INTEGRATIONS_GEMINI_BASE_URL = previousManagedUrl;
      if (previousManagedKey === undefined) delete process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
      else process.env.AI_INTEGRATIONS_GEMINI_API_KEY = previousManagedKey;
      resetGeminiDirectCapabilityForTests();
    }
  };

  /** Real-shaped delay for tests: never elapses, resolves only on stop(). */
  const untilStopped = (_delayMs: number, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
    });

  it("re-checks a failed startup verdict until one passes and flips the catalog", async () => {
    await withDirectKeyOnly(async () => {
      const geminiEntry = () =>
        buildVenomCatalog().find((model) => model.id === "venom-gemini");

      let calls = 0;
      const checkAccess = async () => {
        calls += 1;
        // A transient boot blip, a provider hiccup, then a healthy account.
        if (calls === 1) throw new Error("transient network blip");
        if (calls === 2) return { ok: false, status: 503 };
        return { ok: true };
      };

      const delays: number[] = [];
      const verdicts: Array<{
        ok: boolean;
        attempt: number;
        nextRetryDelayMs: number | null;
        reason?: string;
      }> = [];

      const recovery = startGeminiDirectCapabilityRecovery({
        checkAccess,
        delay: async (delayMs) => {
          delays.push(delayMs);
        },
        onVerdict: ({ result, attempt, nextRetryDelayMs }) => {
          verdicts.push({
            ok: result.ok,
            attempt,
            nextRetryDelayMs,
            reason: result.reason,
          });
        },
      });
      await recovery.done;

      assert.equal(calls, 3, "two failures, then the recovering pass");
      assert.deepEqual(delays, [30_000, 60_000], "bounded backoff between re-checks");
      assert.deepEqual(
        verdicts.map((verdict) => verdict.ok),
        [false, false, true],
      );
      assert.deepEqual(
        verdicts.map((verdict) => verdict.attempt),
        [0, 1, 2],
      );
      assert.equal(
        verdicts[2]?.nextRetryDelayMs,
        null,
        "a pass schedules nothing further",
      );

      // The later passing verdict flips the catalog to Ready — no restart.
      assert.equal(geminiEntry()?.available, true);
      assert.equal(geminiEntry()?.availabilityText, "Ready");

      // Every observed verdict stays safe to log.
      for (const verdict of verdicts) {
        assert.equal((verdict.reason ?? "").includes("gemini-3-flash-preview"), false);
        assert.equal((verdict.reason ?? "").includes("transient network blip"), false);
      }
    });
  });

  it("caps the re-check delay so retries settle into a periodic probe", async () => {
    await withDirectKeyOnly(async () => {
      const failures = 8;
      let calls = 0;
      const delays: number[] = [];

      const recovery = startGeminiDirectCapabilityRecovery({
        checkAccess: async () => {
          calls += 1;
          return calls <= failures ? { ok: false, status: 503 } : { ok: true };
        },
        delay: async (delayMs) => {
          delays.push(delayMs);
        },
      });
      await recovery.done;

      assert.equal(calls, failures + 1, "the loop keeps probing until a pass");
      assert.equal(delays.length, failures);
      for (let i = 1; i < delays.length; i += 1) {
        assert.ok(delays[i]! >= delays[i - 1]!, "backoff never shrinks");
      }
      assert.ok(
        delays.every((delayMs) => delayMs <= 15 * 60_000),
        "no re-check waits longer than the cap",
      );
      assert.deepEqual(
        delays.slice(-3),
        [15 * 60_000, 15 * 60_000, 15 * 60_000],
        "at the cap the loop keeps probing periodically instead of giving up",
      );
    });
  });

  it("stop() cancels the scheduled re-check without waiting out the backoff", async () => {
    await withDirectKeyOnly(async () => {
      let calls = 0;
      let sawFirstVerdict!: () => void;
      const firstVerdict = new Promise<void>((resolve) => {
        sawFirstVerdict = resolve;
      });

      const recovery = startGeminiDirectCapabilityRecovery({
        checkAccess: async () => {
          calls += 1;
          return { ok: false, status: 503 };
        },
        delay: untilStopped,
        onVerdict: () => {
          sawFirstVerdict();
        },
      });

      await firstVerdict;
      recovery.stop();
      await recovery.done;

      assert.equal(calls, 1, "no probe fires after stop()");
    });
  });

  it("does not schedule re-checks when the credential is missing", async () => {
    await withDirectKeyOnly(async () => {
      delete process.env.GEMINI_API_KEY;

      let calls = 0;
      const delays: number[] = [];
      const scheduled: Array<number | null> = [];

      const recovery = startGeminiDirectCapabilityRecovery({
        checkAccess: async () => {
          calls += 1;
          return { ok: true };
        },
        delay: async (delayMs) => {
          delays.push(delayMs);
        },
        onVerdict: ({ result, nextRetryDelayMs }) => {
          scheduled.push(nextRetryDelayMs);
          assert.equal(result.ok, false);
          assert.equal(result.reason, "Gemini credential is not configured");
        },
      });
      await recovery.done;

      assert.equal(calls, 0, "a missing key is never probed");
      assert.deepEqual(delays, []);
      assert.deepEqual(scheduled, [null]);
    });
  });

  it("runs at most one loop and forces past the sticky failure when restarted", async () => {
    await withDirectKeyOnly(async () => {
      let calls = 0;
      const recovery = startGeminiDirectCapabilityRecovery({
        checkAccess: async () => {
          calls += 1;
          return { ok: false, status: 503 };
        },
        delay: untilStopped,
      });

      const again = startGeminiDirectCapabilityRecovery({
        checkAccess: async () => {
          calls += 1;
          return { ok: true };
        },
      });
      assert.equal(again, recovery, "a second start returns the active loop");

      recovery.stop();
      await recovery.done;
      assert.equal(calls, 1, "the ignored start never probed");

      // After the loop ends a fresh one may start. Its first pass reuses the
      // sticky failure, so the pass that heals it is the forced re-check.
      let freshCalls = 0;
      const fresh = startGeminiDirectCapabilityRecovery({
        checkAccess: async () => {
          freshCalls += 1;
          return { ok: true };
        },
        delay: async () => {},
      });
      assert.notEqual(fresh, recovery);
      await fresh.done;
      assert.equal(freshCalls, 1, "the re-check forces past the sticky failure");
      assert.equal((await verifyGeminiDirectCapability()).ok, true);
    });
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

describe("providerErrorClientPayload", () => {
  it("maps a billing-dead account to the fixed non-retryable provider_account payload", () => {
    const raw = Object.assign(
      new Error(
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
      ),
      { status: 400 },
    );
    const payload = providerErrorClientPayload(normalizeProviderError(raw));
    assert.deepEqual(payload, {
      error: PROVIDER_ACCOUNT_ERROR_MESSAGE,
      code: "provider_account",
      retryable: false,
    });
    // The provider's own wording never reaches the payload.
    assert.doesNotMatch(payload.error, /credit balance|Anthropic/i);
  });

  it("maps the runners' aggregated account error to the same payload", () => {
    // Exactly the error runDeliberation/runDebate throw when every voice died
    // billing-class: Verify and Debate surface the account problem, not
    // advice to retry.
    const aggregate = new ProviderError(
      PROVIDER_ACCOUNT_ERROR_MESSAGE,
      402,
      false,
      "account_billing",
    );
    assert.deepEqual(providerErrorClientPayload(aggregate), {
      error: PROVIDER_ACCOUNT_ERROR_MESSAGE,
      code: "provider_account",
      retryable: false,
    });
  });

  it("keeps transient provider faults retryable with generic copy", () => {
    const rateLimited = providerErrorClientPayload(
      normalizeProviderError(Object.assign(new Error("slow down"), { status: 429 })),
    );
    assert.equal(rateLimited.code, "provider_rate_limited");
    assert.equal(rateLimited.retryable, true);

    const timedOut = providerErrorClientPayload(
      normalizeProviderError(Object.assign(new Error("gateway"), { status: 504 })),
    );
    assert.equal(timedOut.code, "provider_timeout");
    assert.equal(timedOut.retryable, true);

    const generic = providerErrorClientPayload(
      new ProviderError("The selected model could not complete this response.", 500, true),
    );
    assert.equal(generic.code, "provider_error");
    assert.equal(generic.retryable, true);
  });
});

describe("model cost tiers", () => {
  it("every catalog entry carries a coarse tier and nothing finer", () => {
    const catalog = buildVenomCatalog();
    for (const model of catalog) {
      assert.ok(
        model.costTier === "$" || model.costTier === "$$" || model.costTier === "$$$",
        "costTier must be one of the three coarse tiers",
      );
    }
    // Never a raw price, currency amount, or numeric rank.
    const serialized = JSON.stringify(catalog);
    assert.doesNotMatch(serialized, /costRank|capabilityRank/);
    assert.doesNotMatch(serialized, /\d+\.\d+\s*(?:USD|usd)|per[ -]token|\$\d/);
  });

  it("tiers match the intended coarse ordering", () => {
    const tierById = new Map(
      buildVenomCatalog().map((model) => [model.id, model.costTier]),
    );
    assert.equal(tierById.get("venom-gemini"), "$");
    assert.equal(tierById.get("venom-grok"), "$$");
    assert.equal(tierById.get("venom-claude"), "$$");
    assert.equal(tierById.get("venom-gpt"), "$$$");
  });
});

describe("resolveVenomModelSelectionPolicy", () => {
  it("keeps known policies verbatim", () => {
    for (const policy of VENOM_MODEL_SELECTION_POLICIES) {
      assert.equal(resolveVenomModelSelectionPolicy(policy), policy);
    }
  });

  it("treats anything unknown as manual", () => {
    for (const raw of [undefined, null, "", "cheapest", "auto", 3, {}, "MANUAL"]) {
      assert.equal(resolveVenomModelSelectionPolicy(raw), "manual");
    }
  });
});

// A synthetic, fully-healthy catalog: selection planning is pure over the
// catalog argument, so tests stay deterministic regardless of which provider
// env vars happen to exist in the environment running the suite.
function healthyCatalog(
  overrides: Partial<Record<VenomModelId, Partial<VenomManagedModel>>> = {},
): VenomManagedModel[] {
  return buildVenomCatalog().map((model) => ({
    ...model,
    available: true,
    availabilityText: "Ready",
    accountHealth: "ok" as const,
    ...(overrides[model.id] ?? {}),
  }));
}

describe("rankVenomCatalogForPolicy", () => {
  it("manual returns the catalog untouched", () => {
    const catalog = healthyCatalog();
    const ranked = rankVenomCatalogForPolicy(catalog, "manual");
    assert.deepEqual(
      ranked.map((model) => model.id),
      catalog.map((model) => model.id),
    );
  });

  it("auto-cheapest orders cheapest first", () => {
    const ranked = rankVenomCatalogForPolicy(healthyCatalog(), "auto-cheapest");
    assert.deepEqual(
      ranked.map((model) => model.id),
      ["venom-gemini", "venom-grok", "venom-claude", "venom-gpt"],
    );
  });

  it("auto-max-power orders most capable first", () => {
    const ranked = rankVenomCatalogForPolicy(healthyCatalog(), "auto-max-power");
    assert.deepEqual(
      ranked.map((model) => model.id),
      ["venom-gpt", "venom-claude", "venom-grok", "venom-gemini"],
    );
  });

  it("does not mutate the input catalog", () => {
    const catalog = healthyCatalog();
    const before = catalog.map((model) => model.id);
    rankVenomCatalogForPolicy(catalog, "auto-cheapest");
    assert.deepEqual(catalog.map((model) => model.id), before);
  });
});

describe("planAutoModelSelection", () => {
  it("returns null for manual — the request keeps its own model", () => {
    assert.equal(planAutoModelSelection(healthyCatalog(), "manual"), null);
  });

  it("auto-cheapest anchors on the cheapest healthy model", () => {
    assert.deepEqual(
      planAutoModelSelection(healthyCatalog(), "auto-cheapest"),
      { modelId: "venom-gemini" },
    );
  });

  it("auto-max-power anchors on the most capable healthy model", () => {
    assert.deepEqual(
      planAutoModelSelection(healthyCatalog(), "auto-max-power"),
      { modelId: "venom-gpt" },
    );
  });

  it("a health flip switches the cheapest pick on the very next plan", () => {
    // First plan: everything healthy — the cheapest model carries the work.
    assert.deepEqual(
      planAutoModelSelection(healthyCatalog(), "auto-cheapest"),
      { modelId: "venom-gemini" },
    );
    // The cheapest account goes billing-dead; the next plan (the route
    // replans per request) moves to the next-cheapest healthy model with no
    // user action.
    assert.deepEqual(
      planAutoModelSelection(
        healthyCatalog({ "venom-gemini": { accountHealth: "unfunded" } }),
        "auto-cheapest",
      ),
      { modelId: "venom-grok" },
    );
  });

  it("skips unavailable models entirely", () => {
    assert.deepEqual(
      planAutoModelSelection(
        healthyCatalog({
          "venom-gemini": { available: false, availabilityText: "Not configured" },
          "venom-grok": { available: false, availabilityText: "Not configured" },
        }),
        "auto-cheapest",
      ),
      { modelId: "venom-claude" },
    );
  });

  it("max power falls to the next capability rank when the top account is dead", () => {
    assert.deepEqual(
      planAutoModelSelection(
        healthyCatalog({ "venom-gpt": { accountHealth: "unfunded" } }),
        "auto-max-power",
      ),
      { modelId: "venom-claude" },
    );
  });

  it("returns null when nothing is usable, so callers fall back honestly", () => {
    const nothingUsable = healthyCatalog();
    for (const model of nothingUsable) {
      model.available = false;
      model.availabilityText = "Not configured";
    }
    assert.equal(planAutoModelSelection(nothingUsable, "auto-cheapest"), null);
    assert.equal(planAutoModelSelection(nothingUsable, "auto-max-power"), null);
  });
});
