import type { Page } from '@playwright/test';

/**
 * Deterministic stand-ins for the chat endpoints.
 *
 * Browser tests run the desktop bundle in UI-test mode: nobody is signed in
 * and no API server is behind the dev server, so every chat request is served
 * from here. That keeps a chat turn exercisable in CI without live model
 * calls or real credentials.
 */

export const STUB_MODEL = {
  modelId: 'test-model',
  modelName: 'Test Model',
} as const;

/** Serialises the chunks the way `/api/venom/respond` streams them. */
export function sseBody(chunks: string[]): string {
  const events = chunks.map(
    (content) => `data: ${JSON.stringify({ content })}\n\n`,
  );
  events.push(`data: ${JSON.stringify(STUB_MODEL)}\n\n`);
  events.push(`data: ${JSON.stringify({ done: true })}\n\n`);
  return events.join('');
}

/** Answers the next chat turns with `chunks`, joined by the client. */
export async function mockChatStream(page: Page, chunks: string[]) {
  await page.route('**/api/venom/respond', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sseBody(chunks),
    });
  });
}

/** One scripted SSE event: [delay in ms before it is emitted, payload]. */
export type StreamScriptEvent = [number, unknown];

/** Window key where `mockStagedChatStream` records captured request bodies. */
const REQUEST_BODIES_KEY = '__chatStreamRequestBodies';

export interface StagedChatStreamOptions {
  /**
   * Record the raw body of every `/api/venom/respond` request on the page so
   * a test can assert what the client sent (mode, blend, interjection
   * context, …). Read them back with `capturedChatRequestBodies(page)`.
   */
  captureRequestBodies?: boolean;
}

/**
 * Streams scripted events from inside the page so mid-answer UI — the
 * pre-token "Thinking…" placeholder, the caret, the locked composer — stays
 * on screen long enough to assert. `page.route().fulfill()` can only deliver
 * an SSE body atomically, so the only place a reply can genuinely trickle is
 * a `window.fetch` override installed before the app loads.
 *
 * Each `/api/venom/respond` call consumes the next script; the last script
 * repeats for any further calls. The stream is abort-aware: when the caller's
 * signal aborts (stop button, interjection restart), it closes without
 * emitting further events. A script that ends without `{done: true}` closes
 * the stream mid-answer, which the client must surface as a failure rather
 * than persisting the partial reply.
 */
export async function mockStagedChatStream(
  page: Page,
  turns: StreamScriptEvent[][],
  options: StagedChatStreamOptions = {},
) {
  await page.addInitScript(
    ({
      scriptedTurns,
      captureKey,
    }: {
      scriptedTurns: Array<Array<[number, unknown]>>;
      captureKey: string | null;
    }) => {
      const captured = captureKey ? ([] as string[]) : null;
      if (captureKey && captured) {
        (window as unknown as Record<string, string[]>)[captureKey] = captured;
      }
      let call = 0;
      const originalFetch = window.fetch.bind(window);
      window.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (!url.includes('/api/venom/respond')) {
          return originalFetch(input as RequestInfo, init);
        }
        captured?.push(String(init?.body ?? ''));
        const events = scriptedTurns[Math.min(call, scriptedTurns.length - 1)];
        call += 1;
        const encoder = new TextEncoder();
        const signal = init?.signal ?? null;
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const [delay, payload] of events) {
              await new Promise((resolve) => setTimeout(resolve, delay));
              if (signal?.aborted) {
                try {
                  controller.close();
                } catch {
                  /* already closed */
                }
                return;
              }
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
              );
            }
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }) as typeof window.fetch;
    },
    {
      scriptedTurns: turns,
      captureKey: options.captureRequestBodies ? REQUEST_BODIES_KEY : null,
    },
  );
}

/**
 * Raw `/api/venom/respond` request bodies recorded by `mockStagedChatStream`
 * with `captureRequestBodies` on, oldest first.
 */
export async function capturedChatRequestBodies(page: Page): Promise<string[]> {
  return page.evaluate(
    (key) =>
      (window as unknown as Record<string, string[] | undefined>)[key] ?? [],
    REQUEST_BODIES_KEY,
  );
}

/** Answers the next chat turns with a server-side failure. */
export async function mockChatFailure(
  page: Page,
  error = 'The model is unavailable right now.',
) {
  await page.route('**/api/venom/respond', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error }),
    });
  });
}

/**
 * A completed reply kicks off background knowledge extraction. Stub it so the
 * dev server's HTML fallback never reaches code expecting clusters.
 */
export async function mockKnowledgeExtraction(
  page: Page,
  captured?: { bodies: unknown[] },
) {
  await page.route('**/api/venom/knowledge/extract', async (route) => {
    captured?.bodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ clusters: [] }),
    });
  });
}
