import type { Page } from '@playwright/test';

/**
 * The workspace shell keeps its own state, but the chat composer reads the
 * managed model catalog and the Apps section reads the portfolio API. CI runs
 * the desktop bundle without an API server, so both reads are stubbed to keep
 * the regressions hermetic and deterministic.
 */
export const MANAGED_MODELS = [
  {
    id: 'venom-gpt',
    provider: 'openai',
    name: 'Venom GPT',
    family: 'GPT',
    summary: 'Balanced general-purpose reasoning.',
    available: true,
    availabilityText: 'Ready',
  },
  {
    id: 'venom-claude',
    provider: 'anthropic',
    name: 'Venom Claude',
    family: 'Claude',
    summary: 'Long-context writing and analysis.',
    available: true,
    availabilityText: 'Ready',
  },
];

export async function stubJsonGet(
  page: Page,
  url: string,
  body: unknown,
  status = 200,
) {
  await page.route(url, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

/** Stubs every backend read the workspace shell performs on load. */
export async function stubWorkspaceApis(page: Page) {
  await stubJsonGet(page, '**/venom/models', MANAGED_MODELS);
  await stubJsonGet(page, '**/venom/workspaces', []);
  await stubJsonGet(page, '**/venom/apps', []);
  await stubJsonGet(page, '**/venom/build-runs*', []);
  await stubJsonGet(page, '**/venom/community/briefing*', {
    community: [],
    agenda: [],
    calendarStatus: 'not_connected',
    viewerProfile: null,
    nextCursor: null,
  });
  await stubJsonGet(
    page,
    '**/venom/community/profile',
    { message: 'Community profile not set up' },
    404,
  );
  await stubJsonGet(page, '**/venom/sources/sync-alerts', { alerts: [] });
  // The Brain page polls filing-move notices and share suggestions.
  await stubJsonGet(page, '**/venom/knowledge/moves', {
    notices: [],
    suggestions: [],
  });
  // App detail pages read the whitelabeled AI overview; specs that exercise
  // the AI panel register their own stateful route after this default.
  await page.route('**/venom/apps/*/ai', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    const match = new URL(route.request().url()).pathname.match(
      /venom\/apps\/([^/]+)\/ai$/,
    );
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        appId: match?.[1] ?? '',
        paused: false,
        monthlyCapUsd: null,
        safetyCapUsd: 25,
        credential: null,
        usage: {
          periodStart: '2026-08-01',
          periodEnd: '2026-09-01',
          costUsd: 0,
          requests: 0,
          promptTokens: 0,
          outputTokens: 0,
          hasEstimates: false,
          models: [],
        },
        ownerMonthUsd: 0,
      }),
    });
  });
}
