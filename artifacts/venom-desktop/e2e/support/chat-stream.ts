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
export async function mockKnowledgeExtraction(page: Page) {
  await page.route('**/api/venom/knowledge/extract', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ clusters: [] }),
    });
  });
}
