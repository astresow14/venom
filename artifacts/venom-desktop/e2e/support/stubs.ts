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
}
