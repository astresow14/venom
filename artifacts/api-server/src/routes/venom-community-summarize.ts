/**
 * venom-community-summarize.ts
 *
 * Performs safe thread summarization using the OpenAI integration.
 * Returns the persisted summary (generated or fallback).
 * Never logs body content or raw model output.
 */

import { db, threadSummariesTable, type ThreadSummary } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "../lib/logger";
import {
  buildFallbackSummary,
  buildSummaryUserMessage,
  containsInjectionPattern,
  normalizeSummaryOutput,
  SUMMARY_MAX_COMPLETION_TOKENS,
  SUMMARY_MODEL,
  SUMMARY_PROMPT_VERSION,
  SUMMARY_REQUEST_TIMEOUT_MS,
  SUMMARY_SYSTEM_PROMPT,
} from "../lib/community-summary";

// ---------------------------------------------------------------------------
// Injectable client interface — allows tests to inject a fake without real calls
// ---------------------------------------------------------------------------

export type SummaryClient = {
  chat: {
    completions: {
      create: (params: {
        model: string;
        max_completion_tokens: number;
        messages: Array<{ role: string; content: string }>;
      }, options?: {
        timeout?: number;
      }) => Promise<{
        model: string;
        choices: Array<{ message: { content: string | null } }>;
      }>;
    };
  };
};

// The default client is the real openai import. Tests override via setSummaryClient.
let _client: SummaryClient = openai as unknown as SummaryClient;

/** Inject a test client. Call with null to restore production client. */
export function setSummaryClient(client: SummaryClient | null): void {
  _client = (client ?? openai) as unknown as SummaryClient;
}

// ---------------------------------------------------------------------------
// Core summarization
// ---------------------------------------------------------------------------

type SummaryWrite = {
  text: string;
  status: "generated" | "fallback" | "pending";
  modelVersion: string | null;
  generatedAt: Date | null;
};

async function persistSummary(
  threadId: string,
  revision: number,
  write: SummaryWrite,
): Promise<ThreadSummary> {
  const { text, status, modelVersion, generatedAt } = write;

  // A newer revision always wins. Within one revision, terminal model results
  // may advance pending -> fallback/generated or fallback -> generated, but a
  // late fallback can never replace a generated summary.
  const rows = await db
    .insert(threadSummariesTable)
    .values({
      threadId,
      text,
      status,
      sourceRevision: revision,
      modelVersion,
      promptVersion: SUMMARY_PROMPT_VERSION,
      generatedAt,
    })
    .onConflictDoUpdate({
      target: threadSummariesTable.threadId,
      set: {
        text,
        status,
        sourceRevision: revision,
        modelVersion,
        promptVersion: SUMMARY_PROMPT_VERSION,
        generatedAt,
        updatedAt: new Date(),
      },
      setWhere: sql`
        ${threadSummariesTable.sourceRevision} < ${revision}
        OR (
          ${threadSummariesTable.sourceRevision} = ${revision}
          AND (
            (
              ${threadSummariesTable.status} = 'pending'
              AND ${status} IN ('fallback', 'generated')
            )
            OR (
              ${threadSummariesTable.status} = 'fallback'
              AND ${status} = 'generated'
            )
          )
        )
      `,
    })
    .returning();

  if (rows[0]) {
    return rows[0];
  }

  const [current] = await db
    .select()
    .from(threadSummariesTable)
    .where(eq(threadSummariesTable.threadId, threadId))
    .limit(1);

  if (!current) {
    return {
      id: "",
      threadId,
      text,
      status,
      sourceRevision: revision,
      modelVersion,
      promptVersion: SUMMARY_PROMPT_VERSION,
      generatedAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  return current;
}

/**
 * Persist a safe summary immediately on the request path. This is deliberately
 * independent of the optional model so publishing and editing remain available
 * during provider latency or outages.
 */
export function persistPendingSummary(
  threadId: string,
  body: string,
  revision: number,
): Promise<ThreadSummary> {
  return persistSummary(threadId, revision, {
    text: buildFallbackSummary(body),
    status: "pending",
    modelVersion: null,
    generatedAt: null,
  });
}

/**
 * Summarize a thread body and persist the result.
 *
 * Monotonicity: a slow completion for revision N cannot overwrite revision N+1,
 * and a same-revision fallback cannot replace an already generated result.
 */
export async function summarizeThread(
  threadId: string,
  body: string,
  revision: number,
): Promise<ThreadSummary> {
  let text: string | null = null;
  let status: "generated" | "fallback" = "fallback";
  let generatedAt: Date | null = null;
  let modelVersion: string | null = null;

  try {
    // Deliberately unmetered (see venom-usage-store): thread summaries are
    // community-shared infrastructure with no single asking account, and
    // charging whichever member happened to bump the revision would
    // misattribute personal spend.
    const response = await _client.chat.completions.create({
      model: SUMMARY_MODEL,
      max_completion_tokens: SUMMARY_MAX_COMPLETION_TOKENS,
      messages: [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        { role: "user", content: buildSummaryUserMessage(body) },
      ],
    }, {
      timeout: SUMMARY_REQUEST_TIMEOUT_MS,
    });

    const rawContent = response.choices[0]?.message?.content ?? null;
    // NOTE: never log rawContent — it may echo user text
    modelVersion = response.model ?? SUMMARY_MODEL;

    const normalized = normalizeSummaryOutput(rawContent);
    if (
      normalized !== null &&
      normalized.length > 0 &&
      !containsInjectionPattern(normalized)
    ) {
      text = normalized;
      status = "generated";
      generatedAt = new Date();
    }
  } catch (err) {
    // Model unavailable, moderation refusal, or other error — use fallback
    logger.warn(
      {
        threadId,
        op: "summarize_thread",
        errorType: err instanceof Error ? err.name : "UnknownError",
      },
      "Summary model unavailable, using fallback",
    );
  }

  // Fallback: deterministic safe excerpt from body
  if (text === null) {
    text = buildFallbackSummary(body);
    status = "fallback";
  }

  return persistSummary(threadId, revision, {
    text,
    status,
    modelVersion,
    generatedAt,
  });
}

/**
 * Start summarization only after the primary request has produced its response.
 * The provider request is bounded, and failures are contained to the background
 * job; neither path logs the post body or raw model output.
 */
export function scheduleThreadSummary(
  threadId: string,
  body: string,
  revision: number,
): void {
  setImmediate(() => {
    const startedAt = Date.now();
    void summarizeThread(threadId, body, revision)
      .then((summary) => {
        logger.info(
          {
            threadId,
            revision,
            status: summary.status,
            durationMs: Date.now() - startedAt,
            op: "summarize_thread_background",
          },
          "Community thread summary finished",
        );
      })
      .catch((err: unknown) => {
        logger.error(
          {
            threadId,
            revision,
            durationMs: Date.now() - startedAt,
            op: "summarize_thread_background",
            errorType: err instanceof Error ? err.name : "UnknownError",
          },
          "Community thread summary failed",
        );
      });
  });
}

/**
 * Fetch existing summary for a thread (read-only, no generation).
 */
export async function getThreadSummary(
  threadId: string,
): Promise<ThreadSummary | null> {
  const [row] = await db
    .select()
    .from(threadSummariesTable)
    .where(eq(threadSummariesTable.threadId, threadId))
    .limit(1);
  return row ?? null;
}
