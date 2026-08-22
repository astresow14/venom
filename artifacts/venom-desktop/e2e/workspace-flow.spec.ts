import { expect, test, type Page } from '@playwright/test';
import {
  mockChatStream,
  mockKnowledgeExtraction,
  STUB_MODEL,
} from './support/chat-stream';
import { stubWorkspaceApis } from './support/stubs';

/**
 * Core workspace regression for Venom Desktop.
 *
 * Covers the chat-first shell (persistent sidebar on wide screens, the drawer
 * on phones, sync status, thread list), the task board, and a full chat turn
 * against a stubbed model, which together are the flow every desktop session
 * goes through. Streaming edge cases (retry, composer keys) live in
 * chat-shell.spec.ts.
 *
 * Responsive layout, safe areas, and focus management live in
 * responsive-shell.spec.ts.
 */

test.beforeEach(async ({ page }) => {
  await stubWorkspaceApis(page);
});


/** A single readable record, used to prove the page recovers. */
const PORTFOLIO_APP = {
  id: '3f1d5a1c-7c2a-4c9e-9f2b-0f1a2b3c4d5e',
  name: 'Symbiote Desktop',
  purpose: 'Track the desktop source history.',
  brand: 'Venom',
  status: 'ready',
  detectedStack: ['react'],
  sourceType: 'zip',
  sourceVersion: 2,
  deploymentUrl: null,
  importStatus: null,
  sourceUpdatedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

const SOP_CONTENT = {
  purpose: 'Standardize the rollback path.',
  prerequisites: ['Deploy dashboard access'],
  inputs: [],
  guidance: ['Revert to the previous release.'],
  requiredApprovals: [],
  acceptanceChecks: ['Health checks pass'],
};

/** A single readable SOP, used to prove both SOP pages recover in place. */
const LIBRARY_SOP = {
  id: '9b8f6c2e-4d3a-4f1b-8a6d-2e5c7b9d0f13',
  title: 'Rollback a bad deploy',
  lifecycle: 'active',
  category: 'operations',
  tags: ['deploys'],
  provenance: 'manual',
  content: SOP_CONTENT,
  activeRevisionId: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
  activeRevisionNumber: 1,
  appIds: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  archivedAt: null,
};

const LIBRARY_SOP_REVISION = {
  id: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
  versionNumber: 1,
  provenance: 'manual',
  checksumSha256: 'f'.repeat(64),
  title: LIBRARY_SOP.title,
  category: 'operations',
  tags: ['deploys'],
  content: SOP_CONTENT,
  publishedAt: '2026-01-02T00:00:00.000Z',
};

/** A full detail record for the app above, used to prove recovery. */
const PORTFOLIO_APP_DETAIL = {
  app: PORTFOLIO_APP,
  versions: [],
  importJobs: [],
  deploymentLinks: [],
  iterations: [],
  provisioningReleases: [],
  timeline: [],
  timelineTotal: 0,
  timelineTruncated: false,
};

/** A reviewable build run, used to prove the Build run page recovers. */
const BUILD_RUN = {
  id: '7a2b9c4d-1e5f-4a8b-9c3d-6e7f8a9b0c1d',
  correlationId: '0f9e8d7c-6b5a-4f3e-8d1c-0b9a8f7e6d5c',
  appId: null,
  runKind: 'standalone',
  targetType: 'app',
  targetName: 'Symbiote Portal',
  status: 'review_required',
  progress: 100,
  attempt: 1,
  currentRevisionNumber: 1,
  approvedRevisionId: null,
  failureCode: null,
  failureMessage: null,
  cancelledReason: null,
  request: {
    targetType: 'app',
    targetName: 'Symbiote Portal',
    requirements: 'Build a portal that tracks symbiote activity.',
    constraints: null,
    brandDirection: null,
    appId: null,
    sourceVersionId: null,
    projectId: null,
    sopRevisionIds: [],
    changesSummary: null,
  },
  revisions: [
    {
      id: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e',
      buildRunId: '7a2b9c4d-1e5f-4a8b-9c3d-6e7f8a9b0c1d',
      revisionNumber: 1,
      reason: 'initial_compile',
      package: {
        formatVersion: 1,
        targetType: 'app',
        targetName: 'Symbiote Portal',
        productBrief: {
          summary: 'A portal for tracking symbiote activity.',
          audience: ['Operations'],
          outcomes: ['Faster triage'],
        },
        functionalScope: ['Sign-in'],
        brandDirection: ['Monochrome'],
        contentRequirements: [],
        serviceFlowRequirements: [],
        dataNeeds: [],
        integrationNeeds: [],
        acceptanceChecks: ['Loads without errors'],
        launchConstraints: [],
        sourceReferences: [],
        sopReferences: [],
        permissionRequests: [],
      },
      checksumSha256: 'e'.repeat(64),
      approvedAt: null,
      createdAt: '2026-01-03T00:04:00.000Z',
    },
  ],
  events: [],
  startedAt: '2026-01-03T00:00:00.000Z',
  completedAt: null,
  createdAt: '2026-01-03T00:00:00.000Z',
  updatedAt: '2026-01-03T00:05:00.000Z',
};

const PHONE = { width: 390, height: 740 };
async function openDrawer(page: Page) {
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await expect(drawer).toBeVisible();
  return drawer;
}

const sections: { link: string; assert: (page: Page) => Promise<void> }[] = [
  {
    link: 'Feed',
    assert: async (page) => {
      await expect(page).toHaveURL(/\/workspace\/feed$/);
      await expect(
        page.getByRole('heading', { name: 'Community Briefing' }),
      ).toBeVisible();
      await expect(page.getByText('No threads found')).toBeVisible();
    },
  },
  {
    link: 'Brain',
    assert: async (page) => {
      await expect(page).toHaveURL(/\/workspace\/brain$/);
      await expect(
        page.getByRole('region', { name: /Knowledge map with \d+ nodes/ }),
      ).toBeVisible();
    },
  },
  {
    link: 'To-Do',
    assert: async (page) => {
      await expect(page).toHaveURL(/\/workspace\/tasks$/);
      await expect(
        page.getByRole('heading', { name: 'To-Do' }),
      ).toBeVisible();
    },
  },
  {
    link: 'Apps',
    assert: async (page) => {
      await expect(page).toHaveURL(/\/workspace\/apps$/);
      await expect(
        page.getByRole('heading', { name: 'Apps', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'No apps registered' }),
      ).toBeVisible();
    },
  },
  {
    link: 'Chat',
    assert: async (page) => {
      await expect(page).toHaveURL(/\/workspace\/chat$/);
      await expect(page.getByTestId('text-chat-greeting')).toBeVisible();
    },
  },
];

test('routes into chat and moves between sections from the sidebar', async ({
  page,
}) => {
  await page.goto('/workspace');

  await expect(page).toHaveURL(/\/workspace\/chat$/);
  await expect(page.getByTestId('text-chat-greeting')).toBeVisible();

  const sidebar = page.getByTestId('sidebar-desktop');
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByTestId('select-project-desktop')).toBeVisible();
  await expect(sidebar.getByTestId('status-sync-desktop')).toContainText(
    'Saved',
  );

  for (const section of sections) {
    await sidebar
      .getByRole('link', { name: section.link, exact: true })
      .click();
    await section.assert(page);
    // The sidebar is persistent on wide screens.
    await expect(sidebar).toBeVisible();
  }
});

test('moves between sections from the drawer on a phone', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/workspace/chat');
  await expect(page.getByTestId('text-chat-greeting')).toBeVisible();
  await expect(page.getByTestId('sidebar-desktop')).toBeHidden();

  const header = page.getByRole('banner');
  await expect(header.getByTestId('text-active-project')).toHaveText(
    'General',
  );

  for (const section of sections) {
    const drawer = await openDrawer(page);
    await drawer.getByRole('link', { name: section.link, exact: true }).click();
    await section.assert(page);
    // The drawer closes itself on navigation; the next iteration reopens it.
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeHidden();
  }
});

test('keeps the Apps page readable when the portfolio comes back malformed', async ({
  page,
}) => {
  // An unavailable API, an error body, or an unauthenticated response all hand
  // the page something that is not a list. Registered after the beforeEach
  // stub, so this handler wins.
  let payload: unknown = { error: 'unauthorized' };
  await page.route('**/venom/apps', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });

  await page.goto('/workspace/apps');

  const failure = page.getByTestId('status-apps-error');
  await expect(failure).toBeVisible();
  await expect(failure).toContainText('Portfolio unavailable');
  // The route survives: the shell and the page header keep rendering, and the
  // error boundary's crash screen never takes over.
  await expect(
    page.getByRole('heading', { name: 'Apps', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Something went wrong' }),
  ).toHaveCount(0);

  // Recovery happens in place, without reloading the workspace.
  payload = [PORTFOLIO_APP];
  await page.getByTestId('button-retry-apps').click();

  await expect(page.getByTestId(`card-app-${PORTFOLIO_APP.id}`)).toBeVisible();
  await expect(failure).toHaveCount(0);
});

test('keeps the SOP library readable when the list comes back malformed', async ({
  page,
}) => {
  // Same failure class as the Apps page: the list endpoint answers with
  // something that is not a list, which used to crash the workspace route.
  let payload: unknown = { error: 'unauthorized' };
  await page.route('**/venom/sops', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });

  await page.goto('/workspace/sops');

  const failure = page.getByTestId('status-sops-error');
  await expect(failure).toBeVisible();
  await expect(failure).toContainText('Library unavailable');
  // The route survives: the page header keeps rendering and the error
  // boundary's crash screen never takes over.
  await expect(
    page.getByRole('heading', { name: 'SOP Library' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Something went wrong' }),
  ).toHaveCount(0);

  // Recovery happens in place, without reloading the workspace.
  payload = [LIBRARY_SOP];
  await page.getByTestId('button-retry-sops').click();

  await expect(page.getByTestId(`card-sop-${LIBRARY_SOP.id}`)).toBeVisible();
  await expect(failure).toHaveCount(0);
});

test('keeps the SOP detail page readable when the record comes back malformed', async ({
  page,
}) => {
  let payload: unknown = { error: 'unauthorized' };
  await page.route(`**/venom/sops/${LIBRARY_SOP.id}`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });

  await page.goto(`/workspace/sops/${LIBRARY_SOP.id}`);

  const failure = page.getByTestId('status-sop-detail-error');
  await expect(failure).toBeVisible();
  await expect(failure).toContainText('SOP unavailable');
  // The shell around the route survives; the crash screen never takes over.
  await expect(page.getByTestId('sidebar-desktop')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Something went wrong' }),
  ).toHaveCount(0);

  // Recovery happens in place: the editor seeds itself from the retried
  // response without a reload.
  payload = {
    sop: LIBRARY_SOP,
    revisions: [LIBRARY_SOP_REVISION],
    assignments: [],
  };
  await page.getByTestId('button-retry-sop-detail').click();

  await expect(page.getByLabel('SOP title')).toHaveValue(LIBRARY_SOP.title);
  await expect(failure).toHaveCount(0);
});

test('keeps the App detail page readable when the record comes back malformed', async ({
  page,
}) => {
  let payload: unknown = { error: 'unauthorized' };
  await page.route(`**/venom/apps/${PORTFOLIO_APP.id}`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });

  await page.goto(`/workspace/apps/${PORTFOLIO_APP.id}`);

  const failure = page.getByTestId('status-app-detail-error');
  await expect(failure).toBeVisible();
  await expect(failure).toContainText('App unavailable');
  // The shell around the route survives; the crash screen never takes over.
  await expect(page.getByTestId('sidebar-desktop')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Something went wrong' }),
  ).toHaveCount(0);

  // Recovery happens in place, without reloading the workspace.
  payload = PORTFOLIO_APP_DETAIL;
  await page.getByTestId('button-retry-app-detail').click();

  await expect(
    page.getByRole('heading', { name: PORTFOLIO_APP.name }),
  ).toBeVisible();
  await expect(failure).toHaveCount(0);
});

test('keeps the Build run page readable when the run comes back malformed', async ({
  page,
}) => {
  let payload: unknown = { error: 'unauthorized' };
  await page.route(`**/venom/build-runs/${BUILD_RUN.id}`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });
  // The page also reads provisioning state for the run; those stay healthy
  // so the failure under test is the run record itself.
  await page.route('**/venom/provisioning/runs**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]',
    });
  });
  await page.route('**/venom/provisioning/capability', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        health: 'healthy',
        summary: 'Provider ready.',
        supportedTargetTypes: ['app', 'website'],
        publishSupported: true,
        rollbackSupported: true,
        recoveryGuidance: null,
      }),
    });
  });

  await page.goto(`/workspace/builds/${BUILD_RUN.id}`);

  const failure = page.getByTestId('status-build-run-error');
  await expect(failure).toBeVisible();
  await expect(failure).toContainText('Build run unavailable');
  // The shell around the route survives; the crash screen never takes over.
  await expect(page.getByTestId('sidebar-desktop')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Something went wrong' }),
  ).toHaveCount(0);

  // Recovery happens in place, without reloading the workspace.
  payload = BUILD_RUN;
  await page.getByTestId('button-retry-build-run').click();

  await expect(
    page.getByRole('heading', { name: BUILD_RUN.targetName }),
  ).toBeVisible();
  await expect(failure).toHaveCount(0);
});

test('creates a task, advances it across the board, and deletes it', async ({
  page,
}) => {
  await page.goto('/workspace/tasks');

  await expect(page.getByRole('heading', { name: 'To-Do' })).toBeVisible();
  const seeded = await page.getByRole('listitem').count();
  expect(seeded).toBeGreaterThan(0);

  const title = 'Wire the desktop regression';
  const objectiveInput = page.getByLabel('Identify new objective');
  await objectiveInput.fill(title);
  await objectiveInput.press('Enter');

  const card = page.getByRole('listitem').filter({ hasText: title });
  await expect(card).toHaveCount(1);
  await expect(page.getByRole('listitem')).toHaveCount(seeded + 1);
  // The input clears so the next objective can be typed straight away.
  await expect(objectiveInput).toHaveValue('');

  // A new task starts in Pending, so only the forward moves are offered.
  await expect(
    page.getByRole('button', { name: `Move "${title}" to Pending` }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: `Move "${title}" to Executing` })
    .click();

  // Once executing, Pending becomes reachable again and Executing disappears.
  await expect(
    page.getByRole('button', { name: `Move "${title}" to Pending` }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: `Move "${title}" to Executing` }),
  ).toHaveCount(0);

  await page
    .getByRole('button', { name: `Move "${title}" to Resolved` })
    .click();
  await expect(
    page.getByRole('button', { name: `Move "${title}" to Resolved` }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: `Move "${title}" to Executing` }),
  ).toBeVisible();

  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain(title);
    void dialog.accept();
  });
  await page.getByRole('button', { name: `Delete "${title}"` }).click();

  await expect(card).toHaveCount(0);
  await expect(page.getByRole('listitem')).toHaveCount(seeded);
});

test('answers a message from a stubbed model and keeps the thread after a reload', async ({
  page,
}) => {
  await mockChatStream(page, ['Deterministic ', 'stub reply.']);
  await mockKnowledgeExtraction(page);

  await page.goto('/workspace/chat');
  await expect(page.getByTestId('text-chat-greeting')).toBeVisible();

  const question = 'What shipped this week?';
  const composer = page.getByTestId('input-message');
  await composer.fill(question);
  await page.getByTestId('button-send').click();

  await expect(page.getByTestId('message-user')).toHaveText(question);

  // Every streamed chunk is joined into one reply, attributed to the model
  // the server named.
  const assistant = page.getByTestId('message-assistant');
  await expect(assistant).toContainText('Deterministic stub reply.');
  await expect(assistant).toContainText(STUB_MODEL.modelName);
  await expect(page.getByTestId('status-thinking')).toHaveCount(0);
  await expect(page.getByTestId('alert-stream-error')).toHaveCount(0);

  // The composer clears and re-enables for the next turn, and the thread takes
  // its title from the question.
  await expect(composer).toHaveValue('');
  await expect(composer).toBeEnabled();
  await expect(page.getByTestId('text-conversation-title')).toHaveText(question);

  await page.reload();

  await expect(page.getByTestId('message-user')).toHaveText(question);
  await expect(page.getByTestId('message-assistant')).toContainText(
    'Deterministic stub reply.',
  );
  await expect(page.getByTestId('text-conversation-title')).toHaveText(question);

  // The reloaded session reopens on that same thread.
  const sidebar = page.getByTestId('sidebar-desktop');
  await expect(
    sidebar.getByTestId(/^button-conversation-/).filter({ hasText: question }),
  ).toHaveAttribute('aria-current', 'page');
});

test('starts a new thread from the sidebar and keeps it in the history', async ({
  page,
}) => {
  await page.goto('/workspace/chat');
  await expect(page.getByTestId('text-chat-greeting')).toBeVisible();

  const sidebar = page.getByTestId('sidebar-desktop');
  const threads = sidebar.getByTestId(/^button-conversation-/);
  await expect(threads).toHaveCount(1);

  await sidebar.getByTestId('button-new-chat-desktop').click();

  await expect(page).toHaveURL(/\/workspace\/chat$/);
  await expect(page.getByTestId('text-chat-greeting')).toBeVisible();
  await expect(threads).toHaveCount(2);
  // The freshly created thread is the selected one.
  await expect(sidebar.locator('button[aria-current="page"]')).toHaveCount(1);
  await expect(threads.first()).toHaveAttribute('aria-current', 'page');
});
