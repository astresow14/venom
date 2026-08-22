import { expect, test, type Page } from '@playwright/test';
import { stubJsonGet, stubWorkspaceApis } from './support/stubs';

/**
 * Subscription billing surfaces on desktop: the plan card inside the Usage
 * dialog (meter, renewal line, Stripe-hosted upgrade), the graceful keyless
 * state, the composer's payer hint following the active space, and the
 * Organization-plan section of the workspace members dialog.
 *
 * Enforcement, payer resolution, and webhook state transitions are pinned
 * by the api-server integration suite; these tests pin the client half:
 * what people see for each billing situation.
 */

const DESKTOP = { width: 1280, height: 860 };

const WORKSPACE = {
  id: '7d9f3c60-2222-4a4a-9c9c-3b3b3b3b3b3b',
  name: 'Symbiote Ops',
  role: 'admin' as const,
  memberCount: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const USAGE_SUMMARY = {
  periodStart: '2026-08-01',
  periodEnd: '2026-09-01',
  totals: { costUsd: 1.86, requests: 42, promptTokens: 96000, outputTokens: 31000 },
  hasEstimates: false,
  daily: [{ date: '2026-08-14', costUsd: 0.62, requests: 12 }],
  models: [
    {
      modelId: 'venom-gpt',
      modelName: 'Venom GPT',
      costUsd: 1.86,
      requests: 42,
      promptTokens: 96000,
      outputTokens: 31000,
      hasEstimates: false,
    },
  ],
  coveredByWorkspaces: [{ id: WORKSPACE.id, name: 'Design Guild' }],
};

const BILLING_SUMMARY = {
  configured: true,
  enforced: true,
  plan: { id: 'free', name: 'Free', priceUsd: 0, allowanceUsd: 5 },
  status: 'none',
  cancelAtPeriodEnd: false,
  periodStart: '2026-08-01T00:00:00.000Z',
  periodEnd: '2026-09-01T00:00:00.000Z',
  renews: false,
  spentUsd: 1.86,
  remainingUsd: 3.14,
  state: 'ok',
  upgradePlan: { id: 'plus', name: 'Plus', priceUsd: 15, allowanceUsd: 50 },
  manageable: false,
};

/** Capture Stripe-hosted page launches instead of opening tabs. */
async function captureWindowOpen(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __openedUrls: string[] }).__openedUrls = [];
    window.open = ((url?: string | URL) => {
      (window as unknown as { __openedUrls: string[] }).__openedUrls.push(
        String(url ?? ''),
      );
      return null;
    }) as typeof window.open;
  });
}

function openedUrls(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __openedUrls: string[] }).__openedUrls,
  );
}

test.use({ viewport: DESKTOP });

test.beforeEach(async ({ page }) => {
  await stubWorkspaceApis(page);
  await stubJsonGet(page, '**/venom/usage/summary*', USAGE_SUMMARY);
});

test('the usage dialog shows the personal plan card and opens Stripe checkout', async ({
  page,
}) => {
  await captureWindowOpen(page);
  await stubJsonGet(page, '**/venom/billing/summary*', BILLING_SUMMARY);
  await page.route('**/venom/billing/checkout', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ url: 'https://stripe.test/checkout-page' }),
    });
  });

  await page.goto('/workspace/chat');
  await page.getByTestId('button-usage-desktop').click();

  const card = page.getByTestId('billing-plan-card');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('billing-plan-name')).toContainText('Free');
  await expect(page.getByTestId('billing-renewal')).toContainText(/resets|renews/i);
  await expect(page.getByTestId('billing-meter')).toBeVisible();
  await expect(page.getByTestId('billing-meter-figures')).toContainText('$1.86');
  await expect(page.getByTestId('billing-meter-figures')).toContainText('$5');
  // Under the warn ratio: no state callout.
  await expect(page.getByTestId('billing-state-approaching')).toHaveCount(0);
  await expect(page.getByTestId('billing-state-exhausted')).toHaveCount(0);

  // Workspace-billed activity appears only as a covered note — no figures.
  const coveredNote = page.getByTestId('usage-covered-note');
  await expect(coveredNote).toContainText('Design Guild');

  // Upgrade goes to a Stripe-hosted page; the app never renders card forms.
  await page.getByTestId('billing-upgrade').click();
  await expect
    .poll(async () => openedUrls(page))
    .toContain('https://stripe.test/checkout-page');
});

test('billing shows a graceful "not set up" state without keys', async ({
  page,
}) => {
  await stubJsonGet(page, '**/venom/billing/summary*', {
    ...BILLING_SUMMARY,
    configured: false,
    manageable: false,
  });

  await page.goto('/workspace/chat');
  await page.getByTestId('button-usage-desktop').click();

  await expect(page.getByTestId('billing-plan-card')).toBeVisible();
  await expect(page.getByTestId('billing-not-configured')).toBeVisible();
  // No Stripe pages to offer keyless.
  await expect(page.getByTestId('billing-upgrade')).toHaveCount(0);
  await expect(page.getByTestId('billing-manage')).toHaveCount(0);
  // Usage itself keeps working.
  await expect(page.getByTestId('billing-meter-figures')).toContainText('$1.86');
});

test('the composer payer hint follows the space the chat lives in', async ({
  page,
}) => {
  await stubJsonGet(page, '**/venom/workspaces', [WORKSPACE]);
  await stubJsonGet(page, `**/venom/workspaces/${WORKSPACE.id}/members`, []);
  await stubJsonGet(page, `**/venom/workspaces/${WORKSPACE.id}/sops`, []);
  await stubJsonGet(page, `**/venom/workspaces/${WORKSPACE.id}/knowledge`, {
    clusters: [],
  });
  await page.route('**/venom/billing/context*', async (route) => {
    const requested = new URL(route.request().url());
    const workspaceId = requested.searchParams.get('workspaceId');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        workspaceId
          ? {
              configured: true,
              enforced: true,
              payer: 'workspace',
              planName: 'Organization',
              workspaceId,
              workspaceName: WORKSPACE.name,
              state: 'exhausted',
            }
          : {
              configured: true,
              enforced: true,
              payer: 'personal',
              planName: 'Free',
              state: 'ok',
              remainingUsd: 3.14,
            },
      ),
    });
  });

  await page.goto('/workspace/chat');

  // Personal space: the hint names the personal plan.
  const hint = page.getByTestId('composer-payer-hint');
  await expect(hint).toContainText('Free plan');

  // Inside an org-covered workspace the payer flips — and an exhausted
  // workspace announces that the workspace limit is the problem.
  await page.getByTestId('select-shared-space-desktop').selectOption(WORKSPACE.id);
  await expect(hint).toContainText(`Billed to ${WORKSPACE.name}`);
  await expect(hint).toContainText('limit reached');
});

test('a workspace admin can put the workspace on the Organization plan', async ({
  page,
}) => {
  await captureWindowOpen(page);
  await stubJsonGet(page, '**/venom/workspaces', [WORKSPACE]);
  await stubJsonGet(page, `**/venom/workspaces/${WORKSPACE.id}/members`, [
    { userId: 'user-admin-1', name: 'Eddie Brock', role: 'admin' },
  ]);
  await stubJsonGet(page, `**/venom/workspaces/${WORKSPACE.id}/sops`, []);
  await stubJsonGet(page, `**/venom/workspaces/${WORKSPACE.id}/knowledge`, {
    clusters: [],
  });
  await stubJsonGet(page, `**/venom/workspaces/${WORKSPACE.id}/settings`, {
    allowSensitiveExport: true,
  });
  await stubJsonGet(page, `**/venom/workspaces/${WORKSPACE.id}/billing`, {
    configured: true,
    enforced: true,
    covered: false,
    planName: 'Organization',
    role: 'admin',
    plan: { id: 'org', name: 'Organization', priceUsd: 99, allowanceUsd: 250 },
    status: 'none',
    cancelAtPeriodEnd: false,
    periodStart: '2026-08-01T00:00:00.000Z',
    periodEnd: '2026-09-01T00:00:00.000Z',
    spentUsd: 0,
    remainingUsd: 250,
    state: 'ok',
    manageable: false,
  });
  await page.route(
    `**/venom/workspaces/${WORKSPACE.id}/billing/checkout`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: 'https://stripe.test/org-checkout' }),
      });
    },
  );

  await page.goto('/workspace/chat');
  await page.getByTestId('select-shared-space-desktop').selectOption(WORKSPACE.id);
  await page.getByTestId('button-space-members-desktop').click();

  const section = page.getByTestId('section-workspace-billing');
  await expect(section).toBeVisible();
  // Uncovered: the pitch explains what the plan changes, then sells it.
  await expect(section).toContainText(/Organization/);
  const buy = page.getByTestId('button-workspace-billing-checkout');
  await expect(buy).toBeVisible();
  await buy.click();
  await expect
    .poll(async () => openedUrls(page))
    .toContain('https://stripe.test/org-checkout');
});

test('a covered workspace shows its allowance meter and manages via Stripe', async ({
  page,
}) => {
  await captureWindowOpen(page);
  await stubJsonGet(page, '**/venom/workspaces', [WORKSPACE]);
  await stubJsonGet(page, `**/venom/workspaces/${WORKSPACE.id}/members`, [
    { userId: 'user-admin-1', name: 'Eddie Brock', role: 'admin' },
  ]);
  await stubJsonGet(page, `**/venom/workspaces/${WORKSPACE.id}/sops`, []);
  await stubJsonGet(page, `**/venom/workspaces/${WORKSPACE.id}/knowledge`, {
    clusters: [],
  });
  await stubJsonGet(page, `**/venom/workspaces/${WORKSPACE.id}/settings`, {
    allowSensitiveExport: true,
  });
  await stubJsonGet(page, `**/venom/workspaces/${WORKSPACE.id}/billing`, {
    configured: true,
    enforced: true,
    covered: true,
    planName: 'Organization',
    role: 'admin',
    plan: { id: 'org', name: 'Organization', priceUsd: 99, allowanceUsd: 250 },
    status: 'active',
    cancelAtPeriodEnd: false,
    periodStart: '2026-08-01T00:00:00.000Z',
    periodEnd: '2026-09-01T00:00:00.000Z',
    spentUsd: 100,
    remainingUsd: 150,
    state: 'ok',
    manageable: true,
  });
  await page.route(
    `**/venom/workspaces/${WORKSPACE.id}/billing/portal`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: 'https://stripe.test/org-portal' }),
      });
    },
  );

  await page.goto('/workspace/chat');
  await page.getByTestId('select-shared-space-desktop').selectOption(WORKSPACE.id);
  await page.getByTestId('button-space-members-desktop').click();

  await expect(page.getByTestId('workspace-billing-plan')).toContainText(
    'Organization',
  );
  await expect(page.getByTestId('workspace-billing-meter')).toBeVisible();
  await expect(page.getByTestId('workspace-billing-figures')).toContainText(
    '$100.00',
  );
  await expect(page.getByTestId('workspace-billing-figures')).toContainText(
    '$250',
  );
  await expect(
    page.getByTestId('button-workspace-billing-checkout'),
  ).toHaveCount(0);

  const manage = page.getByTestId('button-workspace-billing-manage');
  await expect(manage).toBeVisible();
  await manage.click();
  await expect
    .poll(async () => openedUrls(page))
    .toContain('https://stripe.test/org-portal');
});
