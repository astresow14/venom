import { expect, test } from '@playwright/test';
import { stubWorkspaceApis } from './support/stubs';

const APP_ID = 'a0000000-0000-4000-8000-000000000003';
const RUN_ID = 'f0000000-0000-4000-8000-000000000009';
const RELEASE_ID = 'c0000000-0000-4000-8000-000000000021';
const LIVE_ITERATION_ID = 'b0000000-0000-4000-8000-000000000012';
const LATEST_ITERATION_ID = 'b0000000-0000-4000-8000-000000000013';

const APP = {
  id: APP_ID,
  name: 'Field Guide',
  brand: 'Venom Labs',
  status: 'active',
  purpose: 'Companion field guide app.',
  description: 'Companion site fed by the Atlas project.',
  sourceType: 'zip',
  sourceVersion: 3,
  importStatus: 'imported',
  detectedStack: [],
  linkedProjectId: 'proj-atlas',
  linkedProjectName: 'Atlas Research',
  latestIterationNumber: 3,
  liveReleaseId: RELEASE_ID,
  liveIterationNumber: 2,
  livePublishedAt: '2026-08-15T12:00:00.000Z',
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

const BASELINE = {
  iterationId: LATEST_ITERATION_ID,
  iterationNumber: 3,
  buildRunId: 'd0000000-0000-4000-8000-000000000031',
  revisionId: 'e0000000-0000-4000-8000-000000000041',
  packageTitle: 'Field Guide v3',
  resolvable: true,
  approvedAt: '2026-08-18T10:00:00.000Z',
};

const DIVERGED_CONTEXT = {
  appId: APP_ID,
  appName: 'Field Guide',
  linkedProject: { id: 'proj-atlas', name: 'Atlas Research' },
  baseline: BASELINE,
  live: {
    releaseId: RELEASE_ID,
    iterationId: LIVE_ITERATION_ID,
    iterationNumber: 2,
    packageTitle: 'Field Guide v2',
    publishedAt: '2026-08-15T12:00:00.000Z',
    restoredByRollback: true,
    resolvable: true,
    baselineSelectable: true,
    changes: {
      knowledgeChanges: 5,
      sourceChanges: 1,
      summary:
        'Since version 2: 5 knowledge updates and 1 source sync in Atlas Research.',
      since: '2026-08-15T12:00:00.000Z',
    },
  },
  divergence: 'live_behind',
  latestSourceVersion: null,
  suggestedSops: [],
  changes: {
    knowledgeChanges: 2,
    sourceChanges: 0,
    summary: 'Since version 3: 2 knowledge updates in Atlas Research.',
    since: '2026-08-18T10:00:00.000Z',
  },
  canIterate: true,
  blockedReason: null,
};

const IN_SYNC_CONTEXT = {
  ...DIVERGED_CONTEXT,
  live: {
    releaseId: RELEASE_ID,
    iterationId: LATEST_ITERATION_ID,
    iterationNumber: 3,
    packageTitle: 'Field Guide v3',
    publishedAt: '2026-08-18T12:00:00.000Z',
    restoredByRollback: false,
    resolvable: true,
    baselineSelectable: false,
    changes: null,
  },
  divergence: 'in_sync',
};

test.beforeEach(async ({ page }) => {
  await stubWorkspaceApis(page);
  await page.route(`**/venom/apps/${APP_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(DETAIL),
    }),
  );
});

test('surfaces approved/live divergence and lets the owner baseline on the live version', async ({
  page,
}) => {
  const iterationBodies: Array<Record<string, unknown>> = [];
  await page.route(`**/venom/apps/${APP_ID}/iteration-context`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(DIVERGED_CONTEXT),
    }),
  );
  await page.route(`**/venom/apps/${APP_ID}/iterations`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    iterationBodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: RUN_ID, status: 'queued' }),
    });
  });
  await page.route(`**/venom/build-runs/${RUN_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: RUN_ID,
        status: 'queued',
        progress: 0,
        targetType: 'website',
        targetName: 'Field Guide',
        runKind: 'app_iteration',
      }),
    }),
  );

  await page.goto(`/workspace/apps/${APP_ID}`);

  // The header names the version that is actually serving, not just the
  // newest approved package.
  const liveBadge = page.getByTestId(`badge-live-version-${APP_ID}`);
  await expect(liveBadge).toContainText('Live v2 · newest v3');

  await page.getByTestId(`button-improve-app-${APP_ID}`).click();

  // The dialog says so explicitly instead of assuming the newest package
  // is what users see — including why (rollback).
  const divergenceCard = page.getByTestId('panel-live-divergence');
  await expect(divergenceCard).toContainText('Approved v3, but v2 is live');
  await expect(divergenceCard).toContainText(
    'A rollback reset this app to the older version',
  );

  // Default baseline stays the newest approved package.
  await expect(page.getByTestId('radio-baseline-latest')).toBeChecked();
  const changesPanel = page.getByTestId('panel-iteration-changes');
  await expect(changesPanel).toContainText("What's new since v3");
  await expect(changesPanel).toContainText('2 knowledge updates');

  // Consciously choosing the live version flips the "what's new" delta to
  // count from what users are actually seeing.
  await expect(page.getByTestId('radio-baseline-live')).toBeVisible();
  await expect(divergenceCard).toContainText('restored by rollback');
  await page.getByTestId('radio-baseline-live').check();
  await expect(changesPanel).toContainText("What's new since v2");
  await expect(changesPanel).toContainText('5 knowledge updates');

  await page
    .getByTestId('input-iteration-instruction')
    .fill('Bring the rolled-back landing page up to date.');
  await page.getByTestId(`button-start-iteration-${APP_ID}`).click();

  // The request pins the conscious choice; success routes to the new run.
  await expect(page).toHaveURL(new RegExp(`/workspace/builds/${RUN_ID}$`));
  expect(iterationBodies).toHaveLength(1);
  expect(iterationBodies[0].baselineIterationId).toBe(LIVE_ITERATION_ID);
  expect(iterationBodies[0].instruction).toBe(
    'Bring the rolled-back landing page up to date.',
  );
  expect(iterationBodies[0]).not.toHaveProperty('constraints');
});

test('keeps the improve dialog quiet when the newest package is live', async ({
  page,
}) => {
  // Registered after beforeEach's detail route, so it wins: the app record
  // agrees with the in-sync context (newest approved package is serving).
  await page.route(`**/venom/apps/${APP_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...DETAIL,
        app: {
          ...APP,
          liveIterationNumber: 3,
          livePublishedAt: '2026-08-18T12:00:00.000Z',
        },
      }),
    }),
  );
  await page.route(`**/venom/apps/${APP_ID}/iteration-context`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(IN_SYNC_CONTEXT),
    }),
  );

  await page.goto(`/workspace/apps/${APP_ID}`);
  await expect(page.getByTestId(`badge-live-version-${APP_ID}`)).toContainText(
    /^Live v3$/,
  );

  await page.getByTestId(`button-improve-app-${APP_ID}`).click();
  await expect(page.getByTestId('panel-iteration-baseline')).toBeVisible();
  await expect(page.getByTestId('panel-live-divergence')).toHaveCount(0);
  await expect(page.getByTestId('radio-baseline-live')).toHaveCount(0);
});
