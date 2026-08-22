/**
 * Venom AI gateway: whitelabeled chat completions for provisioned apps.
 *
 * Deployed apps authenticate with their per-app runtime credential (minted
 * at provisioning handoff) and call an OpenAI-compatible surface:
 *
 *   POST {gateway}/v1/chat/completions   (JSON or SSE streaming)
 *   GET  {gateway}/v1/models             (safe alias catalog)
 *
 * Only safe alias models (venom-gpt, …) are accepted; Venom fronts the
 * providers through the existing adapters. Provider model IDs, keys, and
 * account details never appear in responses or errors — provider failures
 * pass through the same sanitized mapping the in-product chat uses, so a
 * billing-dead provider account surfaces as the fixed non-retryable
 * `provider_account` copy here too.
 *
 * Every call is metered into the canonical usage ledger against the app's
 * owner. Pause, the owner's monthly cap, and the global safety cap are
 * enforced server-side BEFORE any provider call, each with a distinct
 * machine-readable code, all distinct from provider trouble:
 *
 *   401 invalid_credential            403 app_ai_paused
 *   402 app_ai_cap_reached            402 app_ai_safety_cap_reached
 *   429 rate_limited (per credential, with Retry-After)
 *
 * This router is mounted BEFORE Clerk middleware (see app.ts): gateway
 * callers are deployed apps' servers, not Clerk sessions, and their bearer
 * tokens must never reach Clerk parsing. No CORS is granted on purpose —
 * the credential belongs in the hosted app's server environment, never in
 * a browser bundle.
 */

import { randomUUID } from "node:crypto";

import { db, venomPortfolioAppsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";

import {
  recordAppAiSettlement,
  appAiMaxOutputTokens,
  appAiReservationBoundMicros,
  reserveAppAiSpend,
  resolveAppAiCredentialByToken,
  touchAppAiCredentialUse,
} from "../lib/venom-app-ai-store";
import {
  buildVenomCatalog,
  VENOM_MODEL_IDS,
  type VenomModelId,
} from "../lib/venom-models";
import {
  PROVIDER_ACCOUNT_ERROR_MESSAGE,
  ProviderError,
  providerErrorClientPayload,
  streamVenomResponse,
  type VenomMessage,
  type VenomStreamUsage,
} from "../lib/venom-provider-adapters";

const router: IRouter = Router();

// ─── Test seams ───────────────────────────────────────────────────────────────

type GatewayStream = typeof streamVenomResponse;

let gatewayStream: GatewayStream = streamVenomResponse;

export function overrideAppAiGatewayStreamForTests(
  stream: GatewayStream,
): () => void {
  const previous = gatewayStream;
  gatewayStream = stream;
  return () => {
    gatewayStream = previous;
  };
}

// ─── Limits ───────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 90_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 30;
const MAX_MESSAGES = 50;
const MAX_MESSAGE_CHARS = 32_000;
const MAX_TOTAL_CHARS = 120_000;

/** Env-tunable so operators (and tests) can tighten it without a deploy. */
function rateLimitPerMinute(): number {
  const raw = Number(process.env.VENOM_APP_AI_RATE_LIMIT_PER_MINUTE);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_RATE_LIMIT_PER_MINUTE;
}

const credentialRateLimits = new Map<
  string,
  { count: number; resetAt: number }
>();

/** Fixed-window per-credential limiter: one embedded app cannot degrade the service. */
function takeGatewayRateLimitSlot(credentialId: string): {
  ok: boolean;
  retryAfterSeconds: number;
} {
  const now = Date.now();
  const current = credentialRateLimits.get(credentialId);
  if (!current || current.resetAt <= now) {
    credentialRateLimits.set(credentialId, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    });
    if (credentialRateLimits.size > 2_000) {
      for (const [key, limit] of credentialRateLimits) {
        if (limit.resetAt <= now) credentialRateLimits.delete(key);
      }
    }
    return { ok: true, retryAfterSeconds: 0 };
  }
  if (current.count >= rateLimitPerMinute()) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }
  current.count += 1;
  return { ok: true, retryAfterSeconds: 0 };
}

export function resetAppAiGatewayRateLimitsForTests(): void {
  credentialRateLimits.clear();
}

// ─── Error envelope ───────────────────────────────────────────────────────────

/**
 * OpenAI-style error envelope with Venom's machine-readable codes. Message
 * text is always fixed copy — request payloads, provider bodies, model SKUs,
 * and credentials never echo through here.
 */
type GatewayErrorBody = {
  error: {
    message: string;
    type: string;
    code: string;
    retryable?: boolean;
  };
};

function gatewayError(
  code: string,
  type: string,
  message: string,
  retryable?: boolean,
): GatewayErrorBody {
  return {
    error: {
      message,
      type,
      code,
      ...(retryable === undefined ? {} : { retryable }),
    },
  };
}

const INVALID_CREDENTIAL_BODY = gatewayError(
  "invalid_credential",
  "authentication_error",
  "Invalid or revoked AI credential.",
);

/** Provider failures → the same sanitized copy the in-product chat emits. */
function providerErrorBody(error: ProviderError): GatewayErrorBody {
  const payload = providerErrorClientPayload(error);
  return gatewayError(
    payload.code,
    "provider_error",
    payload.error,
    payload.retryable,
  );
}

const GENERIC_FAILURE_BODY = gatewayError(
  "provider_error",
  "provider_error",
  "The model could not complete this response.",
  true,
);

// ─── Auth ─────────────────────────────────────────────────────────────────────

type GatewayContext = {
  credentialId: string;
  appId: string;
  ownerUserId: string;
};

/**
 * Resolve the bearer credential to its app, uniformly rejecting missing,
 * malformed, unknown, and revoked tokens — and tokens whose app is gone.
 * A valid credential is scoped to exactly one app: everything downstream
 * (metering, caps, pause) keys off that app and its owner, so a leaked
 * credential can only ever spend against that one app's AI access.
 */
async function authenticateGatewayRequest(
  req: Request,
  res: Response,
): Promise<GatewayContext | null> {
  const header = req.headers.authorization;
  const token =
    typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice("Bearer ".length).trim()
      : null;
  if (!token) {
    res.status(401).json(INVALID_CREDENTIAL_BODY);
    return null;
  }
  const credential = await resolveAppAiCredentialByToken(token);
  if (!credential) {
    res.status(401).json(INVALID_CREDENTIAL_BODY);
    return null;
  }
  const [app] = await db
    .select({ id: venomPortfolioAppsTable.id })
    .from(venomPortfolioAppsTable)
    .where(
      and(
        eq(venomPortfolioAppsTable.id, credential.appId),
        eq(venomPortfolioAppsTable.clerkUserId, credential.clerkUserId),
      ),
    )
    .limit(1);
  if (!app) {
    res.status(401).json(INVALID_CREDENTIAL_BODY);
    return null;
  }
  touchAppAiCredentialUse(credential.id);
  return {
    credentialId: credential.id,
    appId: credential.appId,
    ownerUserId: credential.clerkUserId,
  };
}

// ─── Request validation ───────────────────────────────────────────────────────

const GatewayMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().max(MAX_MESSAGE_CHARS),
});

/** Unknown fields (temperature, top_p, …) are accepted and ignored. */
const ChatCompletionBodySchema = z.object({
  model: z.string().min(1).max(80),
  messages: z.array(GatewayMessageSchema).min(1).max(MAX_MESSAGES),
  stream: z.boolean().optional(),
  /**
   * OpenAI-compatible output ceiling. Honored — forwarded to the provider —
   * and priced into the spend reservation, so a tightly capped app can still
   * make small bounded calls that the default ceiling's bound would refuse.
   */
  max_tokens: z.number().int().min(1).max(8192).optional(),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

router.get("/v1/models", async (req, res): Promise<void> => {
  const context = await authenticateGatewayRequest(req, res);
  if (!context) return;
  res.json({
    object: "list",
    data: buildVenomCatalog().map((model) => ({
      id: model.id,
      object: "model",
      owned_by: "system",
    })),
  });
});

router.post("/v1/chat/completions", async (req, res): Promise<void> => {
  const context = await authenticateGatewayRequest(req, res);
  if (!context) return;

  const slot = takeGatewayRateLimitSlot(context.credentialId);
  if (!slot.ok) {
    res.setHeader("Retry-After", slot.retryAfterSeconds);
    res
      .status(429)
      .json(
        gatewayError(
          "rate_limited",
          "rate_limit_error",
          "Too many AI requests. Please retry shortly.",
        ),
      );
    return;
  }

  const parsed = ChatCompletionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json(
        gatewayError(
          "invalid_request",
          "invalid_request_error",
          "Invalid chat completion request.",
        ),
      );
    return;
  }
  const totalChars = parsed.data.messages.reduce(
    (sum, message) => sum + message.content.length,
    0,
  );
  if (totalChars > MAX_TOTAL_CHARS) {
    res
      .status(400)
      .json(
        gatewayError(
          "invalid_request",
          "invalid_request_error",
          "The conversation is too large for one request.",
        ),
      );
    return;
  }

  // Safe aliases only. Anything else — including provider SKUs — is refused
  // with the alias list, so integrators are never nudged toward SKUs.
  if (!VENOM_MODEL_IDS.has(parsed.data.model as VenomModelId)) {
    res
      .status(400)
      .json(
        gatewayError(
          "invalid_model",
          "invalid_request_error",
          `Unknown model. Use one of: ${[...VENOM_MODEL_IDS].join(", ")}.`,
        ),
      );
    return;
  }
  const modelId = parsed.data.model as VenomModelId;

  // Output ceiling for this call: forwarded to the provider AND priced into
  // the reservation below, so the gate's bound is honest, not a flat guess.
  const maxOutputTokens = appAiMaxOutputTokens(parsed.data.max_tokens);

  // Pause and caps: enforced server-side before any provider call, with
  // machine-readable codes distinct from provider trouble. An allowed gate
  // holds a reservation sized to this request's priced worst case — prompt
  // bound plus the output ceiling — which every path below MUST settle.
  const gate = await reserveAppAiSpend(
    context.ownerUserId,
    context.appId,
    appAiReservationBoundMicros(modelId, totalChars, maxOutputTokens),
  );
  if (!gate.allowed) {
    if (gate.code === "app_ai_paused") {
      res
        .status(403)
        .json(
          gatewayError(
            "app_ai_paused",
            "app_paused",
            "AI is paused for this app by its owner.",
          ),
        );
      return;
    }
    res
      .status(402)
      .json(
        gatewayError(
          gate.code,
          "quota_exceeded",
          gate.code === "app_ai_cap_reached"
            ? "This app reached its monthly AI spending cap."
            : "This app reached its monthly AI usage limit.",
        ),
      );
    return;
  }
  const reservationId = gate.reservationId;

  const catalogEntry = buildVenomCatalog().find((model) => model.id === modelId);
  if (!catalogEntry?.available) {
    recordAppAiSettlement(context.appId, reservationId, null);
    res
      .status(502)
      .json(
        gatewayError(
          "provider_error",
          "provider_error",
          "The selected model is not available right now.",
          true,
        ),
      );
    return;
  }
  if (catalogEntry.accountHealth === "unfunded") {
    // Known billing-dead account: fail fast with the existing sanitized
    // provider_account copy instead of burning a doomed provider call.
    recordAppAiSettlement(context.appId, reservationId, null);
    res
      .status(502)
      .json(
        gatewayError(
          "provider_account",
          "provider_error",
          PROVIDER_ACCOUNT_ERROR_MESSAGE,
          false,
        ),
      );
    return;
  }

  const messages: VenomMessage[] = parsed.data.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  res.on("close", () => controller.abort());

  const completionId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let usage: VenomStreamUsage | null = null;
  const onUsage = (reported: VenomStreamUsage): void => {
    usage = reported;
  };
  let settled = false;
  const meter = (): void => {
    // Settles exactly once per attempt: releases the spend reservation and,
    // when the attempt consumed tokens, writes the ledger row in the same
    // transaction.
    if (settled) return;
    settled = true;
    recordAppAiSettlement(
      context.appId,
      reservationId,
      usage
        ? {
            userId: context.ownerUserId,
            appId: context.appId,
            credentialId: context.credentialId,
            modelAlias: modelId,
            promptTokens: usage.promptTokens,
            outputTokens: usage.outputTokens,
            estimated: usage.estimated,
          }
        : null,
    );
  };

  const streaming = parsed.data.stream === true;

  try {
    if (!streaming) {
      let content = "";
      for await (const chunk of gatewayStream(
        modelId,
        messages,
        controller.signal,
        { onUsage, maxOutputTokens },
      )) {
        content += chunk;
      }
      const finalUsage: VenomStreamUsage = usage ?? {
        promptTokens: 0,
        outputTokens: 0,
        estimated: true,
      };
      res.json({
        id: completionId,
        object: "chat.completion",
        created,
        model: modelId,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: finalUsage.promptTokens,
          completion_tokens: finalUsage.outputTokens,
          total_tokens: finalUsage.promptTokens + finalUsage.outputTokens,
        },
      });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const writeFrame = (frame: unknown): void => {
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    };
    const chunkFrame = (
      delta: Record<string, unknown>,
      finishReason: string | null,
    ) => ({
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });

    writeFrame(chunkFrame({ role: "assistant" }, null));
    for await (const chunk of gatewayStream(
      modelId,
      messages,
      controller.signal,
      { onUsage, maxOutputTokens },
    )) {
      if (chunk) writeFrame(chunkFrame({ content: chunk }, null));
    }
    const finalUsage: VenomStreamUsage = usage ?? {
      promptTokens: 0,
      outputTokens: 0,
      estimated: true,
    };
    writeFrame({
      ...chunkFrame({}, "stop"),
      usage: {
        prompt_tokens: finalUsage.promptTokens,
        completion_tokens: finalUsage.outputTokens,
        total_tokens: finalUsage.promptTokens + finalUsage.outputTokens,
      },
    });
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    const aborted = controller.signal.aborted;
    if (error instanceof ProviderError) {
      // Sanitized fixed copy only; billing-dead accounts keep their
      // non-retryable provider_account shape. Statuses are logged, bodies
      // never are.
      req.log.warn(
        {
          modelAlias: modelId,
          appId: context.appId,
          httpStatus: error.status,
          status:
            error.kind === "account_billing"
              ? "provider-account"
              : "provider-error",
        },
        "App AI gateway provider error",
      );
      const body = providerErrorBody(error);
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify(body)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.status(502).json(body);
      }
    } else if (aborted) {
      // Client went away or the request timed out: nothing useful to say.
      if (res.headersSent) {
        res.end();
      } else {
        res
          .status(504)
          .json(
            gatewayError(
              "provider_timeout",
              "provider_error",
              "The model took too long to respond. Please retry.",
              true,
            ),
          );
      }
    } else {
      req.log.error(
        { modelAlias: modelId, appId: context.appId },
        "App AI gateway request failed",
      );
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify(GENERIC_FAILURE_BODY)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.status(502).json(GENERIC_FAILURE_BODY);
      }
    }
  } finally {
    clearTimeout(timeout);
    // Partial streams are still metered: onUsage fires once per attempt with
    // whatever tokens the attempt consumed, flagged estimated when the
    // provider omitted its usage frame.
    meter();
  }
});

export default router;
