import { expect, test } from '@playwright/test';
import { stubWorkspaceApis } from './support/stubs';

/**
 * Owner AI panel on the app detail page: metered month usage, the monthly
 * cap editor, the instant pause switch, and gateway credential rotation /
 * revocation. All API interactions are stubbed; assertions cover the exact
 * request bodies the server would receive.
 */

const APP_ID = 'a0000000-0000-4000-8000-000000000071';

const APP = {
  id: APP_ID,
  name: 'Field Guide',
  brand: 'Venom Labs',
  status: 'active',
  purpose: 'Companion field guide app.',
  sourceType: 'zip',
  sourceVersion: 3,
  importStatus: 'imported',
  detectedStack: [],
  linkedProjectId: null,
  linkedProjectName: null,
  latestIterationNumber: 2,
  liveReleaseId: null,
  liveIterationNumber: null,
  livePublishedAt: null,
  improvementSignal: null,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-19T10:00:00.000Z',
};

const DETAIL = {
  app: APP,
  versions: [],
  importJobs: [],
  deploymentLinks: [],
  provisioningReleases: [],
  iterations: [],
  timeline: [],
  timelineTotal: 0,
  timelineTruncated: false,
};

const CREDENTIAL = {
  displayPrefix: 'vak_11111111',
  createdAt: '2026-08-02T09:00:00.000Z',
  lastUsedAt: '2026-08-21T18:00:00.000Z',
  delivered: true,
};

const ROTATED_CREDENTIAL = {
  displayPrefix: 'vak_22222222',
  createdAt: '2026-08-22T09:00:00.000Z',
  lastUsedAt: null,
  delivered: true,
};

const BASE_OVERVIEW = {
  appId: APP_ID,
  paused: false,
  monthlyCapUsd: null as number | null,
  safetyCapUsd: 25,
  credential: CREDENTIAL as typeof CREDENTIAL | null,
  usage: {
    periodStart: '2026-08-01',
    periodEnd: '2026-09-01',
    costUsd: 3.42,
    requests: 128,
    promptTokens: 90000,
    outputTokens: 41000,
    hasEstimates: true,
    models: [
      { modelId: 'venom-gpt', modelName: 'Venom GPT', costUsd: 2.1, requests: 80 },
      {
        modelId: 'venom-claude',
        modelName: 'Venom Claude',
        costUsd: 1.32,
        requests: 48,
      },
    ],
  },
  ownerMonthUsd: 5.05,
};

type AiHarness = {
  putBodies: Array<Record<string, unknown>>;
  rotateCalls: number;
  revokeCalls: number;
};

async function installAiApi(
  page: import('@playwright/test').Page,
): Promise<AiHarness> {
  const state = JSON.parse(JSON.stringify(BASE_OVERVIEW)) as typeof BASE_OVERVIEW;
  const harness: AiHarness = { putBodies: [], rotateCalls: 0, revokeCalls: 0 };
  const respond = (route: Parameters<Parameters<typeof page.route>[1]>[0]) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(state),
    });

  await page.route(`**/venom/apps/${APP_ID}/ai`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await respond(route);
  });
  await page.route(`**/venom/apps/${APP_ID}/ai/settings`, async (route) => {
    const body = route.request().postDataJSON() as {
      paused: boolean;
      monthlyCapUsd: number | null;
    };
    harness.putBodies.push(body);
    state.paused = body.paused;
    state.monthlyCapUsd = body.monthlyCapUsd;
    await respond(route);
  });
  await page.route(
    `**/venom/apps/${APP_ID}/ai/credential/rotate`,
    async (route) => {
      harness.rotateCalls += 1;
      state.credential = { ...ROTATED_CREDENTIAL };
      await respond(route);
    },
  );
  await page.route(
    `**/venom/apps/${APP_ID}/ai/credential/revoke`,
    async (route) => {
      harness.revokeCalls += 1;
      state.credential = null;
      await respond(route);
    },
  );
  return harness;
}

test.beforeEach(async ({ page }) => {
  await stubWorkspaceApis(page);
  await page.route(`**/venom/apps/${APP_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(DETAIL),
    }),
  );
  await page.route(`**/venom/apps/${APP_ID}/iteration-context`, (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'No iteration context' }),
    }),
  );
  await page.route(`**/venom/apps/${APP_ID}/sharing`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        appId: APP_ID,
        enabled: false,
        slug: null,
        shareUrl: null,
        embedUrl: null,
        embedSnippet: null,
        publicStatus: 'live',
        liveIterationNumber: 2,
        livePublishedAt: '2026-08-15T12:00:00.000Z',
      }),
    }),
  );
});

test('usage renders and the cap editor validates before saving', async ({
  page,
}) => {
  const harness = await installAiApi(page);
  await page.goto(`/workspace/apps/${APP_ID}`);

  const panel = page.getByTestId(`card-app-ai-${APP_ID}`);
  await expect(panel).toBeVisible();
  await expect(page.getByTestId(`text-app-ai-cost-${APP_ID}`)).toHaveText(
    '$3.42',
  );
  await expect(panel).toContainText('128 requests this month');
  await expect(
    page.getByTestId(`row-app-ai-model-${APP_ID}-venom-gpt`),
  ).toContainText('Venom GPT');
  await expect(panel).toContainText('Includes estimated token counts');
  await expect(panel).toContainText('All your apps together: $5.05');
  await expect(panel).toContainText("Venom's $25.00 monthly safety cap");
  await expect(
    page.getByTestId(`text-app-ai-credential-${APP_ID}`),
  ).toContainText('vak_11111111…');
  await expect(panel).toContainText('Delivered to the app.');

  // An out-of-range cap never reaches the server.
  const capInput = page.getByTestId(`input-app-ai-cap-${APP_ID}`);
  const saveButton = page.getByTestId(`button-save-app-ai-cap-${APP_ID}`);
  await expect(saveButton).toBeDisabled();
  await capInput.fill('0.001');
  await saveButton.click();
  await expect(
    page.getByText('Cap must be between $0.01 and $100,000').first(),
  ).toBeVisible();
  expect(harness.putBodies).toEqual([]);

  // A valid cap saves the full settings body.
  await capInput.fill('12.5');
  await saveButton.click();
  await expect.poll(() => harness.putBodies).toEqual([
    { paused: false, monthlyCapUsd: 12.5 },
  ]);
  await expect(saveButton).toBeDisabled();
  await expect(capInput).toHaveValue('12.5');
});

test('pause is instant and carries the saved cap through', async ({
  page,
}) => {
  const harness = await installAiApi(page);
  await page.goto(`/workspace/apps/${APP_ID}`);

  const toggle = page.getByTestId(`switch-app-ai-${APP_ID}`);
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => harness.putBodies).toEqual([
    { paused: true, monthlyCapUsd: null },
  ]);
  await expect(
    page.getByTestId(`text-app-ai-status-${APP_ID}`),
  ).toContainText("Paused — the app's AI requests are refused instantly.");

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => harness.putBodies.length).toBe(2);
  expect(harness.putBodies[1]).toEqual({ paused: false, monthlyCapUsd: null });
});

test('rotate and revoke are confirmed and update the credential row', async ({
  page,
}) => {
  const harness = await installAiApi(page);
  await page.goto(`/workspace/apps/${APP_ID}`);

  await expect(
    page.getByTestId(`text-app-ai-credential-${APP_ID}`),
  ).toContainText('vak_11111111…');

  // Rotate behind an explicit confirmation.
  await page.getByTestId(`button-rotate-app-ai-${APP_ID}`).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByTestId(`button-confirm-rotate-app-ai-${APP_ID}`).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect.poll(() => harness.rotateCalls).toBe(1);
  await expect(
    page.getByTestId(`text-app-ai-credential-${APP_ID}`),
  ).toContainText('vak_22222222…');
  await expect(page.getByText('AI key rotated').first()).toBeVisible();

  // Revoke kills the key; the row reflects the missing credential.
  await page.getByTestId(`button-revoke-app-ai-${APP_ID}`).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByTestId(`button-confirm-revoke-app-ai-${APP_ID}`).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect.poll(() => harness.revokeCalls).toBe(1);
  await expect(
    page.getByTestId(`text-app-ai-credential-${APP_ID}`),
  ).toContainText('No active key');
  await expect(
    page.getByTestId(`button-revoke-app-ai-${APP_ID}`),
  ).toBeDisabled();
});
