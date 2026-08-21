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
import { resolveProviderModelId } from "./venom-models";

export type VenomMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export function toOpenAIMessages(messages: VenomMessage[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
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

export function toGeminiContents(messages: VenomMessage[]) {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" as const : "user" as const,
      parts: [{ text: message.content }],
    }));
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
): AsyncGenerator<string, void, unknown> {
  switch (modelId) {
    case "venom-gpt":
      yield* streamOpenAI(messages, signal);
      break;
    case "venom-claude":
      yield* streamAnthropic(messages, signal);
      break;
    case "venom-gemini":
      yield* streamGemini(messages, signal);
      break;
    case "venom-grok":
      yield* streamOpenRouter(messages, signal);
      break;
    default: {
      // exhaustive check
      const _never: never = modelId;
      throw new ProviderUnavailableError(`Unknown model id: ${String(_never)}`);
    }
  }
}

export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
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
): AsyncGenerator<string> {
  const { openai } = await import(
    "@workspace/integrations-openai-ai-server"
  );
  const providerModel = resolveProviderModelId("venom-gpt");

  const stream = await openai.chat.completions.create(
    {
      model: providerModel,
      max_completion_tokens: 8192,
      messages: toOpenAIMessages(messages),
      stream: true,
    },
    { signal },
  );

  for await (const chunk of stream) {
    if (signal?.aborted) break;
    const content = chunk.choices[0]?.delta?.content;
    if (content) yield content;
  }
}

// ─── Anthropic adapter ───────────────────────────────────────────────────────

async function* streamAnthropic(
  messages: VenomMessage[],
  signal?: AbortSignal,
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
      max_tokens: 8192,
      system: system || undefined,
      messages: chat.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    },
    { signal },
  );

  for await (const event of stream) {
    if (signal?.aborted) break;
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
): AsyncGenerator<string> {
  const { isGeminiAvailable, getGeminiClient } = await import(
    "@workspace/integrations-gemini-ai"
  );

  if (!isGeminiAvailable()) {
    throw new ProviderUnavailableError("Gemini provider is not configured");
  }

  const geminiAI = getGeminiClient();
  const stream = await geminiAI.models.generateContentStream(
    buildGeminiRequest(messages, signal),
  );

  for await (const chunk of stream) {
    if (signal?.aborted) break;
    const text = chunk.text;
    if (text) yield text;
  }
}

export function buildGeminiRequest(
  messages: VenomMessage[],
  signal?: AbortSignal,
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
      maxOutputTokens: 8192,
      abortSignal: signal,
    },
  };
}

// ─── OpenRouter adapter ───────────────────────────────────────────────────────

async function* streamOpenRouter(
  messages: VenomMessage[],
  signal?: AbortSignal,
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
      max_tokens: 8192,
      messages: toOpenAIMessages(messages),
      stream: true,
    },
    { signal },
  );

  for await (const chunk of stream) {
    if (signal?.aborted) break;
    const content = chunk.choices[0]?.delta?.content;
    if (content) yield content;
  }
}
