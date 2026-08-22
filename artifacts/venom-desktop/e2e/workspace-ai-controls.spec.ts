import { expect, test, type Page } from '@playwright/test';
import { stubJsonGet, stubWorkspaceApis } from './support/stubs';

/**
 * Workspace admin spend & model controls (Task #280), desktop client half:
 *
 * - Admins of an org-covered workspace get a usage-and-controls section in
 *   the members dialog: per-member workspace-billed usage, cap editors and
 *   model locks, all writing the full-replace controls document.
 * - Members inside a managed workspace see model controls locked — visibly
 *   disabled and labeled "Managed by <workspace>", never hidden — plus cap
 *   warnings in the composer; switching back to the personal space restores
 *   their own settings untouched.
 *
 * Server enforcement (precedence, distinct block codes, the respond-route
 * lock) is pinned by the api-server integration suite; these tests pin the
 * client contract over stubbed APIs.
 */

const WORKSPACE = {
  id: '7d9f3c60-2222-4a4a-9c9c-3c3c3c3c3c3c',
  name: 'Symbiote Ops',
  role: 'admin' as const,
  memberCount: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const ADMIN_ID = 'user-admin-1';
const MEMBER_ID = 'user-member-2';

const MEMBERS = [
  { userId: ADMIN_ID, name: 'Eddie Brock', role: 'admin' as const },
  { userId: MEMBER_ID, name: 'Anne Weying', role: 'member' as const },
];

const WORKSPACE_BILLING = {
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
  spentUsd: 4.25,
  remainingUsd: 245.75,
  state: 'ok',
  manageable: false,
};

const USAGE = {
  covered: true,
  periodStart: '2026-08-01T00:00:00.000Z',
  periodEnd: '2026-09-01T00:00:00.000Z',
  totalUsd: 4.25, // members sum to 3.5; $0.75 belongs to departed accounts
  allowanceUsd: 250,
  members: [
    {
      clerkUserId: MEMBER_ID,
      name: 'Anne Weying',
      role: 'member',
      spentUsd: 2.5,
      capUsd: 1,
      capSource: 'override',
      capState: 'exhausted',
    },
    {
      clerkUserId: ADMIN_ID,
      name: 'Eddie Brock',
      role: 'admin',
      spentUsd: 1,
      capUsd: 2,
      capSource: 'default',
      capState: 'ok',
    },
  ],
};

/** Models with cost tiers, so tier locks have something to bite on. */
const TIERED_MODELS = [
  {
    id: 'venom-gpt',
    provider: 'openai',
    name: 'Venom GPT',
    family: 'GPT',
    summary: 'Model used by browser tests.',
    available: true,
    availabilityText: 'Ready',
    costTier: '$$$',
  },
  {
    id: 'venom-claude',
    provider: 'anthropic',
    name: 'Venom Claude',
    family: 'Claude',
    summary: 'Model used by browser tests.',
    available: true,
    availabilityText: 'Ready',
    costTier: '$$',
  },
  {
    id: 'venom-gemini',
    provider: 'gemini',
    name: 'Venom Gemini',
    family: 'Gemini',
    summary: 'Model used by browser tests.',
    available: true,
    availabilityText: 'Ready',
    costTier: '$',
  },
];

async function seedEnabledModels(page: Page) {
  await page.addInitScript(() => {
    const now = Date.now();
    const state = {
      projects: [],
      conversations: [
        {
          id: 'conv_default',
          title: 'New Session',
          projectId: 'proj_default',
          updatedAt: now,
          messages: [],
        },
      ],
      clusters: [],
      sources: [],
      activeProjectId: 'proj_default',
      activeConversationId: 'conv_default',
      tombstones: {
        projects: [],
        tasks: [],
        conversations: [],
        messages: [],
        clusters: [],
      },
      modelPreferences: {
        enabledModelIds: ['venom-gpt', 'venom-claude', 'venom-gemini'],
        defaultModelId: 'venom-gpt',
        activeModelId: 'venom-gpt',
        updatedAt: now,
      },
    };
    window.localStorage.setItem(
      '@venom_desktop_v1:venom-desktop-ui-test',
      JSON.stringify(state),
    );
  });
}

/**
 * Billing context stub: personal for no-param requests, workspace payer with
 * the given cap/lock state when a workspaceId rides along.
 */
async function stubBillingContext(
  page: Page,
  workspaceExtras: Record<string, unknown>,
) {
  await page.route('**/venom/billing/context*', async (route) => {
    const workspaceId = new URL(route.request().url()).searchParams.get(
      'workspaceId',
    );
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
              state: 'ok',
              ...workspaceExtras,
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
}

async function stubMemberWorkspaceReads(page: Page) {
  await stubJsonGet(page, '**/venom/workspaces', [
    { ...WORKSPACE, role: 'member' },
  ]);
  await stubJsonGet(page, `**/venom/workspaces/${WORKSPACE.id}/members`, MEMBERS);
  await stubJsonGet(page, `**/venom/workspaces/${WORKSPACE.id}/sops`, []);
  await stubJsonGet(page, `**/venom/workspaces/${WORKSPACE.id}/knowledge`, {
    clusters: [],
  });
  await stubJsonGet(page, '**/venom/models', TIERED_MODELS);
}

test.beforeEach(async ({ page }) => {
  await stubWorkspaceApis(page);
});

test('the members dialog gives admins usage visibility and cap/lock editors', async ({
  page,
}) => {
  await stubJsonGet(page, '**/venom/workspaces', [WORKSPACE]);
  await stubJsonGet(page, `**/venom/workspaces/${WORKSPACE.id}/members`, MEMBERS);
  await stubJsonGet(page, `**/venom/workspaces/${WORKSPACE.id}/sops`, []);
  await stubJsonGet(page, `**/venom/workspaces/${WORKSPACE.id}/settings`, {
    allowSensitiveExport: true,
  });
  await stubJsonGet(
    page,
    `**/venom/workspaces/${WORKSPACE.id}/billing`,
    WORKSPACE_BILLING,
  );
  await stubJsonGet(page, `**/venom/workspaces/${WORKSPACE.id}/usage`, USAGE);
  await stubBillingContext(page, {});

  // Stateful controls document: every write is a full replace, echoed back.
  let controlsState: Record<string, unknown> = {
    defaultMemberCapUsd: 2,
    forcedSelectionPolicy: null,
    allowedCostTiers: null,
    memberOverrides: [
      { clerkUserId: MEMBER_ID, name: 'Anne Weying', capUsd: 1 },
    ],
  };
  const controlPuts: Array<Record<string, unknown>> = [];
  const memberCapWrites: Array<{ method: string; url: string; body: unknown }> =
    [];
  await page.route(
    `**/venom/workspaces/${WORKSPACE.id}/ai-controls`,
    async (route) => {
      const method = route.request().method();
      if (method === 'PUT') {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        controlPuts.push(body);
        controlsState = { ...controlsState, ...body };
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(controlsState),
      });
    },
  );
  await page.route(
    `**/venom/workspaces/${WORKSPACE.id}/ai-controls/members/*`,
    async (route) => {
      const method = route.request().method();
      memberCapWrites.push({
        method,
        url: route.request().url(),
        body: method === 'PUT' ? route.request().postDataJSON() : null,
      });
      controlsState = {
        ...controlsState,
        memberOverrides:
          method === 'DELETE'
            ? []
            : [
                {
                  clerkUserId: MEMBER_ID,
                  name: 'Anne Weying',
                  capUsd: (route.request().postDataJSON() as { capUsd: number })
                    .capUsd,
                },
              ],
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(controlsState),
      });
    },
  );

  await page.goto('/workspace/chat');
  await page.getByTestId('button-workspace-manager-desktop').click();
  await page.getByTestId(`button-workspace-members-${WORKSPACE.id}`).click();

  // ── Usage: workspace-billed only, departed spend called out ─────────────
  const section = page.getByTestId('section-workspace-ai-controls');
  await expect(section).toBeVisible();
  await expect(page.getByTestId('workspace-usage-total')).toContainText(
    '$4.25',
  );
  await expect(
    page.getByTestId(`workspace-usage-spent-${MEMBER_ID}`),
  ).toHaveText('$2.50');
  await expect(
    page.getByTestId(`workspace-usage-capstate-${MEMBER_ID}`),
  ).toContainText('At their cap');
  await expect(section).toContainText('$0.75 by people no longer');
  await expect(section).toContainText('personal space');

  // ── Default cap: draft, save, full-replace body ──────────────────────────
  const defaultCap = page.getByTestId('input-default-member-cap');
  await expect(defaultCap).toHaveValue('2');
  await expect(page.getByTestId('button-save-default-cap')).toBeDisabled();
  await defaultCap.fill('3');
  await page.getByTestId('button-save-default-cap').click();
  await expect.poll(() => controlPuts.length).toBe(1);
  expect(controlPuts[0]).toEqual({
    defaultMemberCapUsd: 3,
    forcedSelectionPolicy: null,
    allowedCostTiers: null,
  });

  // ── Member override: set a custom cap, then return to the default ───────
  await page.getByTestId(`button-member-cap-${MEMBER_ID}`).click();
  await page.getByTestId(`input-member-cap-${MEMBER_ID}`).fill('5');
  await page.getByTestId(`button-save-member-cap-${MEMBER_ID}`).click();
  await expect.poll(() => memberCapWrites.length).toBe(1);
  expect(memberCapWrites[0].method).toBe('PUT');
  expect(memberCapWrites[0].url).toContain(
    `/ai-controls/members/${MEMBER_ID}`,
  );
  expect(memberCapWrites[0].body).toEqual({ capUsd: 5 });

  await page.getByTestId(`button-member-cap-${MEMBER_ID}`).click();
  await page.getByTestId(`button-clear-member-cap-${MEMBER_ID}`).click();
  await expect.poll(() => memberCapWrites.length).toBe(2);
  expect(memberCapWrites[1].method).toBe('DELETE');

  // ── Model lock editors: forced policy and tier toggles ──────────────────
  await page.getByTestId('select-forced-policy').click();
  await page
    .getByRole('option', { name: 'Always cheapest usable model' })
    .click();
  await expect.poll(() => controlPuts.length).toBe(2);
  expect(controlPuts[1].forcedSelectionPolicy).toBe('auto-cheapest');

  await page.getByTestId('tier-toggle-$$$').click();
  await expect.poll(() => controlPuts.length).toBe(3);
  expect(controlPuts[2].allowedCostTiers).toEqual(['$', '$$']);

  await page.getByTestId('tier-toggle-$$').click();
  await expect.poll(() => controlPuts.length).toBe(4);
  expect(controlPuts[3].allowedCostTiers).toEqual(['$']);

  // A lock can never allow nothing: the last tier standing is not clickable.
  await expect(page.getByTestId('tier-toggle-$')).toBeDisabled();
});

test('a tier lock disables blocked models in the popup instead of hiding them', async ({
  page,
}) => {
  await seedEnabledModels(page);
  await stubMemberWorkspaceReads(page);
  await stubBillingContext(page, {
    memberCapState: 'approaching',
    modelLock: { forcedSelectionPolicy: null, allowedCostTiers: ['$'] },
  });

  await page.goto('/workspace/chat');
  await page
    .getByTestId('select-shared-space-desktop')
    .selectOption(WORKSPACE.id);

  // The composer warns as the member approaches their admin-set cap.
  await expect(page.getByTestId('composer-payer-hint')).toContainText(
    'nearing your workspace limit',
  );
  // The active manual pick (venom-gpt, $$$) is tier-blocked, so the chip
  // announces the managed fallback instead of pretending the pick holds.
  await expect(page.getByTestId('model-chip-lock')).toBeVisible();

  await page.getByTestId('button-model-chip').click();
  const dialog = page.getByTestId('dialog-model-voices');
  await expect(dialog).toBeVisible();

  // Blocked models stay visible: managed badge on, actions off. The active
  // model has no Use button by design, so the badge is its whole story;
  // venom-claude ($$) shows the full locked treatment.
  await expect(page.getByTestId('tier-locked-venom-gpt')).toBeVisible();
  await expect(page.getByTestId('tier-locked-venom-claude')).toBeVisible();
  await expect(page.getByTestId('button-use-venom-claude')).toBeDisabled();
  // In-tier models keep working normally.
  await expect(page.getByTestId('tier-locked-venom-gemini')).toHaveCount(0);
  await expect(page.getByTestId('button-use-venom-gemini')).toBeEnabled();
});

test('a forced policy locks the popup and lifts off in the personal space', async ({
  page,
}) => {
  await seedEnabledModels(page);
  await stubMemberWorkspaceReads(page);
  await stubBillingContext(page, {
    memberCapState: 'exhausted',
    modelLock: {
      forcedSelectionPolicy: 'auto-cheapest',
      allowedCostTiers: null,
    },
  });

  await page.goto('/workspace/chat');
  const spaceSelect = page.getByTestId('select-shared-space-desktop');
  await spaceSelect.selectOption(WORKSPACE.id);

  // Cap exhausted: the composer says the WORKSPACE limit is the problem.
  const hint = page.getByTestId('composer-payer-hint');
  await expect(hint).toContainText('your workspace limit reached');

  // The chip carries the lock and the managed auto policy.
  await expect(page.getByTestId('model-chip-lock')).toBeVisible();
  await expect(page.getByTestId('text-active-model')).toContainText(/auto/i);

  await page.getByTestId('button-model-chip').click();
  await expect(page.getByTestId('dialog-model-voices')).toBeVisible();
  const managedNote = page.getByTestId('model-policy-managed');
  await expect(managedNote).toBeVisible();
  await expect(managedNote).toContainText(`Managed by ${WORKSPACE.name}`);
  await page.getByTestId('button-model-voices-done').click();

  // Back in the personal space: the member's own settings, untouched.
  await spaceSelect.selectOption({ label: 'Personal space' });
  await expect(hint).toContainText('Free plan');
  await expect(page.getByTestId('model-chip-lock')).toHaveCount(0);
  await expect(page.getByTestId('text-active-model')).toContainText(
    'Venom GPT',
  );
});
