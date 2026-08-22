/**
 * Venom provider adapters.
 *
 * Each adapter streams tokens from the underlying provider and yields string chunks
 * through an async generator. They accept the Venom-normalized message array and
 * translate to provider-specific formats internally.
 *
 * Security: provider model IDs and credentials never leave this module.
 * Logs must use safe alias only — never tokens, content, or secrets.
 */

import type { VenomModelId } from "./venom-models";
import {
  reportVenomModelAccountHealth,
  resolveProviderModelId,
  supportsVenomVision,
} from "./venom-models";
import { estimateTokensFromChars } from "./venom-usage-pricing";

export type VenomMessageImage = {
  /** Display name only — used in the substituted note for text-only models. */
  name: string;
  /** One of the accepted image content types (png/jpeg/webp/gif). */
  mimeType: string;
  dataBase64: string;
};

export type VenomMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  /**
   * Images attached to this (user) message. Vision-capable models receive
   * them in the provider's native multimodal shape; streamVenomResponse swaps
   * them for an honest textual note everywhere else, so a text-only voice in
   * a debate or deliberation says it cannot see the image instead of silently
   * ignoring it. Byte budgets are enforced upstream where images are loaded.
   */
  images?: VenomMessageImage[];
};

/** Fixed copy substituted for image parts on models that cannot see them. */
export function imagesUnviewableNote(images: VenomMessageImage[]): string {
  const names = images.map((image) => image.name).join(", ");
  const what =
    images.length === 1 ? "an image" : `${images.length} images`;
  return `[The user attached ${what} (${names}), but you cannot view images. Say so plainly and work from the text alone — never guess at what an image shows.]`;
}

/**
 * Strip image parts from every message, appending the fixed note so the
 * model acknowledges the attachment honestly. Applied per model at stream
 * time: in a debate one voice may see pixels while another gets the note.
 */
export function replaceImagesWithNotes(messages: VenomMessage[]): VenomMessage[] {
  return messages.map((message) => {
    if (!message.images || message.images.length === 0) return message;
    const note = imagesUnviewableNote(message.images);
    return {
      role: message.role,
      content: message.content ? `${message.content}\n\n${note}` : note,
    };
  });
}

type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/**
 * Discriminated so the SDK's ChatCompletionMessageParam union accepts it:
 * only user turns may carry content parts; other roles are plain strings.
 */
type OpenAIChatMessage =
  | { role: "user"; content: string | OpenAIContentPart[] }
  | { role: "assistant" | "system"; content: string };

export function toOpenAIMessages(messages: VenomMessage[]): OpenAIChatMessage[] {
  return messages.map((message): OpenAIChatMessage => {
    if (message.role === "user" && message.images?.length) {
      const parts: OpenAIContentPart[] = [];
      if (message.content) {
        parts.push({ type: "text", text: message.content });
      }
      for (const image of message.images) {
        parts.push({
          type: "image_url",
          image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` },
        });
      }
      return { role: "user", content: parts };
    }
    if (message.role === "user") {
      return { role: "user", content: message.content };
    }
    return { role: message.role, content: message.content };
  });
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
        data: string;
      };
    };

type AnthropicChatMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

/** Chat turns only (system already split off via splitSystemMessages). */
export function toAnthropicMessages(
  chat: VenomMessage[],
): AnthropicChatMessage[] {
  return chat.map((m): AnthropicChatMessage => {
    if (m.role === "user" && m.images?.length) {
      return {
        role: "user",
        content: [
          // Anthropic reads best with images ahead of the prompt text.
          ...m.images.map(
            (image): AnthropicContentBlock => ({
              type: "image",
              source: {
                type: "base64",
                // The upload allowlist admits exactly Anthropic's accepted
                // media types (png/jpeg/webp/gif), so the narrow cast holds.
                media_type: image.mimeType as
                  | "image/png"
                  | "image/jpeg"
                  | "image/webp"
                  | "image/gif",
                data: image.dataBase64,
              },
            }),
          ),
          ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
        ],
      };
    }
    return { role: m.role as "user" | "assistant", content: m.content };
  });
}

export function splitSystemMessages(messages: VenomMessage[]) {
  return {
    system: messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n"),
    chat: messages.filter((message) => message.role !== "system"),
  };
}

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

export function toGeminiContents(messages: VenomMessage[]) {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const parts: GeminiPart[] = [];
      if (message.role === "user" && message.images?.length) {
        for (const image of message.images) {
          parts.push({
            inlineData: { mimeType: image.mimeType, data: image.dataBase64 },
          });
        }
      }
      // Keep the text part unless it is empty AND images already fill the
      // turn — Gemini rejects a content entry with zero parts.
      if (message.content || parts.length === 0) {
        parts.push({ text: message.content });
      }
      return {
        role: message.role === "assistant" ? "model" as const : "user" as const,
        parts,
      };
    });
}

/**
 * Token usage of one streamed provider call, reported once per attempt.
 * When the provider's own usage metadata never arrived (most commonly a
 * stream cut off mid-flight), the counts are character-based estimates and
 * `estimated` is set so the ledger — and every view over it — can say so.
 */
export type VenomStreamUsage = {
  promptTokens: number;
  outputTokens: number;
  estimated: boolean;
};

export type StreamVenomResponseOptions = {
  /**
   * Called exactly once when this stream attempt ends — completed, aborted
   * mid-flight, or failed after producing content — with the tokens the
   * attempt consumed. Attempts that fail before producing anything (and
   * before any provider usage frame) report nothing: no tokens were
   * meaningfully bought. Exceptions thrown by the callback are swallowed;
   * metering must never break streaming.
   */
  onUsage?: (usage: VenomStreamUsage) => void;
  /**
   * Output-token ceiling forwarded to the provider (clamped to the provider
   * maximum). Callers that price spend up front (the app AI gateway) pass
   * this so a call's real cost stays inside its priced bound; absent, the
   * provider maximum applies.
   */
  maxOutputTokens?: number;
};

/** Hard per-call output ceiling every adapter enforces. */
const PROVIDER_MAX_OUTPUT_TOKENS = 8192;

function outputTokenCeiling(requested?: number): number {
  if (
    requested === undefined ||
    !Number.isFinite(requested) ||
    requested < 1
  ) {
    return PROVIDER_MAX_OUTPUT_TOKENS;
  }
  return Math.min(Math.floor(requested), PROVIDER_MAX_OUTPUT_TOKENS);
}

/** Mutable holder each adapter fills when provider usage metadata arrives. */
type UsageSink = {
  native: { promptTokens: number; outputTokens: number } | null;
};

/** Text chars the prompt carries — the basis for prompt-side estimates. */
function promptChars(messages: VenomMessage[]): number {
  let total = 0;
  for (const message of messages) total += message.content.length;
  return total;
}

/**
 * Stream tokens for the given model. Yields string chunks.
 * Throws ProviderUnavailableError if env vars are missing.
 * Throws ProviderError on API-level failures.
 */
export async function* streamVenomResponse(
  modelId: VenomModelId,
  messages: VenomMessage[],
  signal?: AbortSignal,
  options?: StreamVenomResponseOptions,
): AsyncGenerator<string, void, unknown> {
  // The vision gate lives here so every mode — talk, verify voices, debate
  // turns — resolves image handling per model with no caller cooperation.
  const prepared = supportsVenomVision(modelId)
    ? messages
    : replaceImagesWithNotes(messages);
  const usageSink: UsageSink = { native: null };
  let outputChars = 0;
  let streamedContent = false;
  try {
    for await (const token of streamProviderTokens(
      modelId,
      prepared,
      signal,
      usageSink,
      options?.maxOutputTokens,
    )) {
      if (!streamedContent) {
        streamedContent = true;
        // Real content proves the account can pay: clear any stale verdict so
        // a topped-up account heals on its next successful call.
        reportVenomModelAccountHealth(modelId, "ok");
      }
      outputChars += token.length;
      yield token;
    }
  } catch (error) {
    // Billing-class failures are durable account evidence, worth remembering
    // across requests; everything else stays transient. Recorded before the
    // error propagates so the catalog and voice planning see it no matter
    // which caller swallows the throw.
    if (isBillingClassProviderError(error)) {
      reportVenomModelAccountHealth(modelId, "unfunded");
    }
    throw error;
  } finally {
    // Runs on clean completion, thrown provider errors, and consumer
    // break/abort alike — a caller that stops reading (debate char budgets,
    // client disconnects) still pays for what streamed. Prefer the
    // provider's own numbers; estimate from characters only without them.
    if (options?.onUsage && (usageSink.native || streamedContent)) {
      const usage: VenomStreamUsage = usageSink.native
        ? {
            promptTokens: usageSink.native.promptTokens,
            outputTokens: usageSink.native.outputTokens,
            estimated: false,
          }
        : {
            // Image bytes are deliberately excluded: base64 length says
            // nothing useful about vision token cost, and overcounting a
            // prompt thousands-fold is worse than a flagged estimate.
            promptTokens: estimateTokensFromChars(promptChars(prepared)),
            outputTokens: estimateTokensFromChars(outputChars),
            estimated: true,
          };
      try {
        options.onUsage(usage);
      } catch {
        // Metering must never break the stream it observes.
      }
    }
  }
}

async function* streamProviderTokens(
  modelId: VenomModelId,
  messages: VenomMessage[],
  signal?: AbortSignal,
  usageSink?: UsageSink,
  maxOutputTokens?: number,
): AsyncGenerator<string, void, unknown> {
  switch (modelId) {
    case "venom-gpt":
      yield* streamOpenAI(messages, signal, usageSink, maxOutputTokens);
      break;
    case "venom-claude":
      yield* streamAnthropic(messages, signal, usageSink, maxOutputTokens);
      break;
    case "venom-gemini":
      yield* streamGemini(messages, signal, usageSink, maxOutputTokens);
      break;
    case "venom-grok":
      yield* streamOpenRouter(messages, signal, usageSink, maxOutputTokens);
      break;
    default: {
      // exhaustive check
      const _never: never = modelId;
      throw new ProviderUnavailableError(`Unknown model id: ${String(_never)}`);
    }
  }
}

/**
 * OpenAI-compatible streams (OpenAI, OpenRouter) attach usage to a chunk —
 * normally the final one, requested via stream_options.include_usage.
 */
function captureOpenAiCompatibleUsage(
  usageSink: UsageSink | undefined,
  usage:
    | { prompt_tokens?: number | null; completion_tokens?: number | null }
    | null
    | undefined,
): void {
  if (!usageSink || !usage) return;
  usageSink.native = {
    promptTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
  };
}

export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

export type ProviderErrorKind = "generic" | "account_billing";

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    readonly kind: ProviderErrorKind = "generic",
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * Safe, fixed copy for a billing-dead provider account. Distinguishes "the
 * account can't pay" from generic provider faults so nobody is told to simply
 * retry. Never contains provider error text, model IDs, or credentials.
 */
export const PROVIDER_ACCOUNT_ERROR_MESSAGE =
  "The selected model's provider account can't cover new replies right now. Retrying won't help until the account owner adds credits or updates the key.";

const BILLING_TEXT_PATTERN =
  /credit balance|insufficient credit|insufficient[_\s]quota|exceeded your current quota|plan and billing|purchase credits|billing hard limit|payment required/i;

/** Pull message/code strings from an SDK error and its nested error bodies. */
function collectErrorSignals(error: unknown): { texts: string[]; codes: string[] } {
  const texts: string[] = [];
  const codes: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (!value || typeof value !== "object" || depth > 3) return;
    const record = value as { message?: unknown; code?: unknown; error?: unknown };
    if (typeof record.message === "string") texts.push(record.message);
    if (typeof record.code === "string") codes.push(record.code);
    visit(record.error, depth + 1);
  };
  visit(error, 0);
  return { texts, codes };
}

/**
 * Billing-class provider failures: the account behind the credential cannot
 * pay (credits exhausted, quota spent, payment required). These are stable
 * account states, not transient faults — retrying cannot help until the
 * account owner intervenes. Matching is deliberately narrow — explicit
 * billing signals on a 4xx only — so transient per-minute rate limits and
 * server faults stay retryable. Classification never surfaces the matched
 * provider text anywhere.
 */
export function isBillingClassProviderError(error: unknown): boolean {
  if (error instanceof ProviderError) return error.kind === "account_billing";
  if (!error || typeof error !== "object") return false;
  const status = numericStatus(error);
  if (status === 402) return true;
  if (typeof status !== "number" || status < 400 || status >= 500) return false;
  const { texts, codes } = collectErrorSignals(error);
  if (codes.includes("insufficient_quota")) return true;
  return texts.some((text) => BILLING_TEXT_PATTERN.test(text));
}

function numericStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  const status =
    typeof candidate.status === "number"
      ? candidate.status
      : typeof candidate.statusCode === "number"
        ? candidate.statusCode
        : undefined;
  return status;
}

export function normalizeProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const status = numericStatus(error);
  // Checked ahead of the rate-limit branch: some providers report an unpaid
  // account as HTTP 429 (e.g. an exhausted prepaid quota), which no retry can
  // fix — treating it as rate limiting would promise recovery that never comes.
  if (isBillingClassProviderError(error)) {
    return new ProviderError(
      PROVIDER_ACCOUNT_ERROR_MESSAGE,
      status,
      false,
      "account_billing",
    );
  }
  if (status === 429) {
    return new ProviderError("The selected model is rate limited.", 429, true);
  }
  if (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    (typeof status === "number" && status >= 500)
  ) {
    return new ProviderError(
      "The selected model is temporarily unavailable.",
      status,
      true,
    );
  }
  return new ProviderError(
    "The selected model could not complete this response.",
    status,
    false,
  );
}

export type ProviderErrorClientPayload = {
  error: string;
  code:
    | "provider_account"
    | "provider_rate_limited"
    | "provider_timeout"
    | "provider_error";
  retryable: boolean;
};

/**
 * The one place a ProviderError becomes a client-visible payload. Every chat
 * mode (Talk, Verify, Debate) funnels provider failures — including the
 * runners' aggregated all-voices-failed errors — through this mapping, so a
 * billing-dead account always reaches the client as the fixed non-retryable
 * `provider_account` copy instead of advice to retry. Only fixed copy is
 * emitted; provider error bodies, model IDs, and credentials never pass
 * through.
 */
export function providerErrorClientPayload(
  error: ProviderError,
): ProviderErrorClientPayload {
  if (error.kind === "account_billing") {
    return {
      error: PROVIDER_ACCOUNT_ERROR_MESSAGE,
      code: "provider_account",
      retryable: false,
    };
  }
  if (error.status === 429) {
    return {
      error: "The selected model is rate limited. Please retry shortly.",
      code: "provider_rate_limited",
      retryable: error.retryable,
    };
  }
  if (error.status === 504) {
    return {
      error: "The selected model took too long to respond. Please retry.",
      code: "provider_timeout",
      retryable: error.retryable,
    };
  }
  return {
    error: "The selected model could not complete this response.",
    code: "provider_error",
    retryable: error.retryable,
  };
}

export async function* streamWithSingleRetry(
  createStream: () => AsyncGenerator<string, void, unknown>,
  signal?: AbortSignal,
  retryDelayMs = 250,
): AsyncGenerator<string, void, unknown> {
  let attempt = 0;
  while (attempt < 2) {
    let emitted = false;
    try {
      for await (const token of createStream()) {
        if (signal?.aborted) return;
        emitted = true;
        yield token;
      }
      return;
    } catch (error) {
      const providerError = normalizeProviderError(error);
      if (
        !emitted &&
        attempt === 0 &&
        providerError.retryable &&
        !signal?.aborted
      ) {
        attempt += 1;
        if (retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
        continue;
      }
      throw providerError;
    }
  }
}

// ─── OpenAI adapter ──────────────────────────────────────────────────────────

async function* streamOpenAI(
  messages: VenomMessage[],
  signal?: AbortSignal,
  usageSink?: UsageSink,
  maxOutputTokens?: number,
): AsyncGenerator<string> {
  const { openai } = await import(
    "@workspace/integrations-openai-ai-server"
  );
  const providerModel = resolveProviderModelId("venom-gpt");

  const stream = await openai.chat.completions.create(
    {
      model: providerModel,
      max_completion_tokens: outputTokenCeiling(maxOutputTokens),
      messages: toOpenAIMessages(messages),
      stream: true,
      // The final frame then carries real token counts (empty choices).
      stream_options: { include_usage: true },
    },
    { signal },
  );

  for await (const chunk of stream) {
    if (signal?.aborted) break;
    captureOpenAiCompatibleUsage(usageSink, chunk.usage);
    const content = chunk.choices[0]?.delta?.content;
    if (content) yield content;
  }
}

// ─── Anthropic adapter ───────────────────────────────────────────────────────

async function* streamAnthropic(
  messages: VenomMessage[],
  signal?: AbortSignal,
  usageSink?: UsageSink,
  maxOutputTokens?: number,
): AsyncGenerator<string> {
  const { isAnthropicAvailable, getAnthropicClient } = await import(
    "@workspace/integrations-anthropic-ai"
  );

  if (!isAnthropicAvailable()) {
    throw new ProviderUnavailableError("Anthropic provider is not configured");
  }

  const anthropic = getAnthropicClient();
  const providerModel = resolveProviderModelId("venom-claude");

  const { system, chat } = splitSystemMessages(messages);

  const stream = anthropic.messages.stream(
    {
      model: providerModel,
      max_tokens: outputTokenCeiling(maxOutputTokens),
      system: system || undefined,
      messages: toAnthropicMessages(chat),
    },
    { signal },
  );

  for await (const event of stream) {
    if (signal?.aborted) break;
    if (usageSink && event.type === "message_start") {
      // input_tokens is final at message_start; output_tokens still grows.
      usageSink.native = {
        promptTokens: event.message.usage.input_tokens ?? 0,
        outputTokens: event.message.usage.output_tokens ?? 0,
      };
    } else if (usageSink && event.type === "message_delta") {
      // Cumulative output count — the last delta seen wins.
      usageSink.native = {
        promptTokens: usageSink.native?.promptTokens ?? 0,
        outputTokens:
          event.usage.output_tokens ?? usageSink.native?.outputTokens ?? 0,
      };
    }
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      yield event.delta.text;
    }
  }
}

// ─── Gemini adapter ───────────────────────────────────────────────────────────

async function* streamGemini(
  messages: VenomMessage[],
  signal?: AbortSignal,
  usageSink?: UsageSink,
  maxOutputTokens?: number,
): AsyncGenerator<string> {
  const { isGeminiAvailable, getGeminiClient } = await import(
    "@workspace/integrations-gemini-ai"
  );

  if (!isGeminiAvailable()) {
    throw new ProviderUnavailableError("Gemini provider is not configured");
  }

  const geminiAI = getGeminiClient();
  const stream = await geminiAI.models.generateContentStream(
    buildGeminiRequest(messages, signal, maxOutputTokens),
  );

  for await (const chunk of stream) {
    if (signal?.aborted) break;
    if (usageSink) {
      // Gemini repeats usageMetadata on chunks; the last one is the total.
      // Thinking tokens are billed as output, so fold them in.
      const meta = chunk.usageMetadata;
      if (
        meta &&
        (meta.promptTokenCount != null || meta.candidatesTokenCount != null)
      ) {
        usageSink.native = {
          promptTokens: meta.promptTokenCount ?? 0,
          outputTokens:
            (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
        };
      }
    }
    const text = chunk.text;
    if (text) yield text;
  }
}

export function buildGeminiRequest(
  messages: VenomMessage[],
  signal?: AbortSignal,
  maxOutputTokens?: number,
) {
  // Gemini uses systemInstruction separately and "model" for assistant turns.
  const { system } = splitSystemMessages(messages);

  return {
    model: resolveProviderModelId("venom-gemini"),
    contents: toGeminiContents(messages),
    ...(system
      ? { systemInstruction: { parts: [{ text: system }] } }
      : {}),
    config: {
      maxOutputTokens: outputTokenCeiling(maxOutputTokens),
      abortSignal: signal,
    },
  };
}

// ─── OpenRouter adapter ───────────────────────────────────────────────────────

async function* streamOpenRouter(
  messages: VenomMessage[],
  signal?: AbortSignal,
  usageSink?: UsageSink,
  maxOutputTokens?: number,
): AsyncGenerator<string> {
  const { isOpenRouterAvailable, getOpenRouterClient } = await import(
    "@workspace/integrations-openrouter-ai"
  );

  if (!isOpenRouterAvailable()) {
    throw new ProviderUnavailableError("OpenRouter provider is not configured");
  }

  const client = getOpenRouterClient();
  const providerModel = resolveProviderModelId("venom-grok");

  const stream = await client.chat.completions.create(
    {
      model: providerModel,
      max_tokens: outputTokenCeiling(maxOutputTokens),
      messages: toOpenAIMessages(messages),
      stream: true,
      // OpenAI-compatible: the final frame then carries token counts.
      stream_options: { include_usage: true },
    },
    { signal },
  );

  for await (const chunk of stream) {
    if (signal?.aborted) break;
    captureOpenAiCompatibleUsage(usageSink, chunk.usage);
    const content = chunk.choices[0]?.delta?.content;
    if (content) yield content;
  }
}
