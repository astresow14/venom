import type { Page } from "@playwright/test";

/**
 * Deterministic stand-ins for the chat stream, mirroring the desktop
 * suite's shared staged stub (venom-desktop/e2e/support/chat-stream.ts).
 *
 * `page.route().fulfill()` can only deliver an SSE body atomically, so the
 * only place a reply can genuinely trickle — keeping the pre-token spinner,
 * the locked composer, and the half-written bubble on screen long enough to
 * assert — is a `window.fetch` override installed before the app loads.
 * That trick holds for this client because `expo/fetch` on web re-exports
 * `globalThis.fetch` at module evaluation, which happens after init scripts
 * run, so the wrapper captures the override.
 */

/** One scripted SSE event: [delay in ms before it is emitted, payload]. */
export type StreamScriptEvent = [number, unknown];

declare global {
  interface Window {
    __venomRespondCalls?: number;
  }
}

/**
 * Streams scripted events from inside the page. Each `/api/venom/respond`
 * call consumes the next script; the last script repeats for any further
 * calls. A script that ends without `{done: true}` closes the stream
 * mid-answer, which the client must surface as a failure rather than
 * persisting the partial reply.
 *
 * Every intercepted call increments `window.__venomRespondCalls`, so a test
 * can prove a locked composer fired no second request (read it through
 * `respondCallCount`).
 */
export async function mockStagedChatStream(
  page: Page,
  turns: StreamScriptEvent[][],
) {
  await page.addInitScript(
    (scriptedTurns: Array<Array<[number, unknown]>>) => {
      let call = 0;
      window.__venomRespondCalls = 0;
      const originalFetch = window.fetch.bind(window);
      window.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (!url.includes("/api/venom/respond")) {
          return originalFetch(input as RequestInfo, init);
        }
        const events = scriptedTurns[Math.min(call, scriptedTurns.length - 1)];
        call += 1;
        window.__venomRespondCalls = call;
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
          headers: { "Content-Type": "text/event-stream" },
        });
      }) as typeof window.fetch;
    },
    turns,
  );
}

/** How many `/api/venom/respond` calls the staged stub has served. */
export async function respondCallCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__venomRespondCalls ?? 0);
}
