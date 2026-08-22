import { expect, test, type Page } from '@playwright/test';
import { stubJsonGet, stubWorkspaceApis } from './support/stubs';

/**
 * The personal Usage surface on desktop.
 *
 * The shell's account area opens a dialog that reads the account-scoped
 * usage summary: this month's spend in dollars, a daily trend, and a
 * per-model breakdown under Venom-branded names, with flagged estimates
 * called out. The summary API is stubbed — the spec proves the client
 * contract: dollars only, branded names only, and the estimate caveat
 * whenever flagged entries are present.
 */

const DESKTOP = { width: 1280, height: 860 };
test.use({ viewport: DESKTOP });

const SUMMARY = {
  periodStart: '2026-08-01',
  periodEnd: '2026-09-01',
  totals: {
    costUsd: 1.86,
    requests: 42,
    promptTokens: 96_000,
    outputTokens: 31_000,
  },
  hasEstimates: true,
  daily: [
    { date: '2026-08-03', costUsd: 0.42, requests: 9 },
    { date: '2026-08-04', costUsd: 0.66, requests: 14 },
    { date: '2026-08-05', costUsd: 0.78, requests: 19 },
  ],
  models: [
    {
      modelId: 'venom-gpt',
      modelName: 'Venom GPT',
      costUsd: 1.24,
      requests: 20,
      promptTokens: 64_000,
      outputTokens: 21_000,
      hasEstimates: false,
    },
    {
      modelId: 'venom-claude',
      modelName: 'Venom Claude',
      costUsd: 0.57,
      requests: 12,
      promptTokens: 30_000,
      outputTokens: 9_500,
      hasEstimates: true,
    },
    {
      modelId: 'venom-voice',
      modelName: 'Venom Voice',
      costUsd: 0.05,
      requests: 10,
      promptTokens: 0,
      outputTokens: 0,
      hasEstimates: true,
    },
  ],
};

const EMPTY_SUMMARY = {
  periodStart: '2026-08-01',
  periodEnd: '2026-09-01',
  totals: { costUsd: 0, requests: 0, promptTokens: 0, outputTokens: 0 },
  hasEstimates: false,
  daily: [],
  models: [],
};

async function openWorkspace(page: Page) {
  await stubWorkspaceApis(page);
  await page.goto('/workspace/chat');
  await expect(page.getByTestId('form-composer')).toBeVisible();
}

test('the account area opens a monthly usage view in dollars under Venom names', async ({
  page,
}) => {
  await stubJsonGet(page, '**/api/venom/usage/summary', SUMMARY);
  await openWorkspace(page);

  await page.getByTestId('button-usage-desktop').click();
  await expect(page.getByTestId('dialog-usage')).toBeVisible();

  // Month headline: dollars, request and token counts.
  await expect(page.getByTestId('usage-month-total')).toHaveText('$1.86');
  await expect(page.getByTestId('usage-requests-total')).toHaveText(
    '42 requests · 127k tokens',
  );

  // Daily trend: one bar per reported day.
  await expect(page.getByTestId('usage-daily-trend')).toBeVisible();
  await expect(page.getByTestId('usage-day-2026-08-03')).toBeAttached();
  await expect(page.getByTestId('usage-day-2026-08-05')).toBeAttached();

  // Per-model breakdown: Venom-branded names and dollar amounts only —
  // never provider SKUs or per-token rates.
  const gptRow = page.getByTestId('usage-model-row-venom-gpt');
  await expect(gptRow).toContainText('Venom GPT');
  await expect(gptRow).toContainText('$1.24');
  await expect(gptRow).toContainText('20 requests · 64.0k in / 21.0k out');
  await expect(gptRow).not.toContainText('*');

  const claudeRow = page.getByTestId('usage-model-row-venom-claude');
  await expect(claudeRow).toContainText('Venom Claude');
  await expect(claudeRow).toContainText('*');

  const voiceRow = page.getByTestId('usage-model-row-venom-voice');
  await expect(voiceRow).toContainText('Venom Voice');
  await expect(voiceRow).toContainText('$0.05');

  // Flagged entries exist, so the caveat explains the asterisk.
  await expect(page.getByTestId('usage-estimate-note')).toContainText(
    'Some entries are estimates',
  );

  // The whole dialog stays in the product's vocabulary: no raw SKU-looking
  // identifiers anywhere in the rendered surface.
  const dialogText = (await page.getByTestId('dialog-usage').innerText()) ?? '';
  expect(dialogText).not.toMatch(/gpt-\d|claude-\d|gemini-\d|grok-\d/i);
});

test('a failed summary load offers retry and recovers', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/venom/usage/summary', async (route) => {
    calls += 1;
    if (calls === 1) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Usage summary is unavailable' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(SUMMARY),
    });
  });
  await openWorkspace(page);

  await page.getByTestId('button-usage-desktop').click();
  await expect(page.getByTestId('usage-error')).toBeVisible();

  await page.getByTestId('usage-retry').click();
  await expect(page.getByTestId('usage-month-total')).toHaveText('$1.86');
  expect(calls).toBe(2);
});

test('an unmetered month reads as zero, not an error', async ({ page }) => {
  await stubJsonGet(page, '**/api/venom/usage/summary', EMPTY_SUMMARY);
  await openWorkspace(page);

  await page.getByTestId('button-usage-desktop').click();
  await expect(page.getByTestId('usage-month-total')).toHaveText('$0.00');
  await expect(page.getByTestId('usage-empty')).toContainText(
    'Nothing metered yet this month',
  );
  await expect(page.getByTestId('usage-estimate-note')).not.toBeAttached();
});
