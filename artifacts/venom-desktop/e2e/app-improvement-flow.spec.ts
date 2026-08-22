import { expect, test, type Route } from '@playwright/test';
import { stubWorkspaceApis } from './support/stubs';

/**
 * Improve-this-app loop: a new-data suggestion on the app page leads to the
 * Improve dialog (baseline + what's-new context), starting an iteration lands
 * on the build-run page, and the run shows up as the next package version on
 * the evolution timeline. Dismissing the suggestion hides it without starting
 * anything. All iteration endpoints are stubbed so the flow stays hermetic.
 */

const APP_ID = 'a0000000-0000-4000-8000-000000000031';
const RUN_ID = 'b0000000-0000-4000-8000-000000000032';
const BASELINE_ITERATION_ID = 'c0000000-0000-4000-8000-000000000033';
const BASELINE_BUILD_RUN_ID = 'c0000000-0000-4000-8000-000000000034';
const BASELINE_REVISION_ID = 'c0000000-0000-4000-8000-000000000035';
const CORRELATION_ID = 'c0000000-0000-4000-8000-000000000036';
const SOURCE_VERSION_ID = 'c0000000-0000-4000-8000-000000000037';
const NOW = '2026-08-20T12:00:00.000Z';
const SIGNAL_SUMMARY =
  'Atlas Research absorbed 3 new concepts and refreshed 1 source since package v1.';
const INSTRUCTION = 'Surface the newest Atlas findings on the landing page.';
const CONSTRAINTS = 'Keep the current navigation.';

const SIGNAL = {
  since: '2026-08-18T09:00:00.000Z',
  knowledgeChanges: 3,
  sourceChanges: 1,
  totalChanges: 4,
  summary: SIGNAL_SUMMARY,
  baselineIterationNumber: 1,
};

const APP = {
  id: APP_ID,
  name: 'Field Guide',
  purpose: 'Companion field guide app.',
  brand: 'Venom Labs',
  status: 'active',
  detectedStack: [],
  sourceType: 'zip',
  sourceVersion: 3,
  deploymentUrl: null,
  importStatus: 'imported',
  sourceUpdatedAt: NOW,
  linkedProjectId: 'proj_alpha',
  linkedProjectName: 'Atlas Research',
  latestIterationNumber: 1,
  improvementSignal: SIGNAL,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: NOW,
};

const ITERATION_CONTEXT = {
  appId: APP_ID,
  appName: 'Field Guide',
  linkedProject: { id: 'proj_alpha', name: 'Atlas Research' },
  baseline: {
    iterationId: BASELINE_ITERATION_ID,
    iterationNumber: 1,
    buildRunId: BASELINE_BUILD_RUN_ID,
    revisionId: BASELINE_REVISION_ID,
    packageTitle: 'Field Guide package',
    approvedAt: NOW,
    resolvable: true,
  },
  latestSourceVersion: {
    id: SOURCE_VERSION_ID,
    versionNumber: 3,
    archiveFilename: 'field-guide-v3.zip',
  },
  suggestedSops: [],
  changes: {
    since: '2026-08-18T09:00:00.000Z',
    knowledgeChanges: 3,
    sourceChanges: 1,
    summary: SIGNAL_SUMMARY,
  },
  canIterate: true,
  blockedReason: null,
};

/** The run created by POST /iterations — queued, no revisions yet. */
const ITERATION_RUN = {
  id: RUN_ID,
  correlationId: CORRELATION_ID,
  appId: APP_ID,
  runKind: 'app_iteration',
  targetType: 'app',
  targetName: 'Field Guide',
  status: 'queued',
  progress: 0,
  currentRevisionNumber: 0,
  approvedRevisionId: null,
  failureMessage: null,
  cancelledReason: null,
  createdAt: NOW,
  updatedAt: NOW,
  request: {
    targetType: 'app',
    targetName: 'Field Guide',
    requirements: INSTRUCTION,
    constraints: CONSTRAINTS,
    brandDirection: '',
    appId: APP_ID,
    sourceVersionId: SOURCE_VERSION_ID,
    projectId: 'proj_alpha',
    sopRevisionIds: [],
    baselineIterationId: BASELINE_ITERATION_ID,
    baselineRevisionId: BASELINE_REVISION_ID,
    changesSummary: SIGNAL_SUMMARY,
  },
  revisions: [],
  events: [
    {
      id: 'd0000000-0000-4000-8000-000000000038',
      eventType: 'queued',
      message: 'Iteration request queued.',
      createdAt: NOW,
    },
  ],
  attempt: 1,
  failureCode: null,
  startedAt: null,
  completedAt: null,
};

const CAPABILITY = {
  health: 'healthy',
  summary: 'Provisioning agent connected.',
  recoveryGuidance: null,
  supportedTargetTypes: ['app', 'website'],
  rollbackSupported: true,
  publishSupported: true,
  permissionSummary: null,
};

function timelineEntry(n: number, status: string, occurredAt: string) {
  return {
    id: `evt-iter-${n}`,
    kind: 'package_iteration',
    title: `Iteration ${n}`,
    detail: null,
    actor: 'You',
    status,
    occurredAt,
    buildRunId: n === 2 ? RUN_ID : BASELINE_BUILD_RUN_ID,
    releaseId: null,
    sourceVersionId: null,
    iterationNumber: n,
  };
}

function appDetail(app: Record<string, unknown>, timeline: unknown[]) {
  return {
    app,
    versions: [],
    importJobs: [],
    deploymentLinks: [],
    provisioningReleases: [],
    iterations: [],
    timeline,
    timelineTotal: timeline.length,
    timelineTruncated: false,
  };
}

const DETAIL_BEFORE = appDetail(APP, [
  timelineEntry(1, 'approved', '2026-08-05T10:00:00.000Z'),
]);

// After the iteration starts, the suggestion is consumed and the new package
// version heads the timeline.
const DETAIL_AFTER = appDetail({ ...APP, improvementSignal: null }, [
  timelineEntry(2, 'queued', NOW),
  timelineEntry(1, 'approved', '2026-08-05T10:00:00.000Z'),
]);

function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

test.beforeEach(async ({ page }) => {
  await stubWorkspaceApis(page);
});

test('walks an improvement suggestion into the next package version', async ({
  page,
}) => {
  const iterationPosts: Array<Record<string, unknown>> = [];
  let started = false;

  await page.route(`**/venom/apps/${APP_ID}`, (route) =>
    fulfillJson(route, started ? DETAIL_AFTER : DETAIL_BEFORE),
  );
  await page.route(`**/venom/apps/${APP_ID}/iteration-context`, (route) =>
    fulfillJson(route, ITERATION_CONTEXT),
  );
  await page.route(`**/venom/apps/${APP_ID}/iterations`, (route) => {
    iterationPosts.push(
      route.request().postDataJSON() as Record<string, unknown>,
    );
    started = true;
    return fulfillJson(route, ITERATION_RUN, 201);
  });
  await page.route(`**/venom/build-runs/${RUN_ID}`, (route) =>
    fulfillJson(route, ITERATION_RUN),
  );
  await page.route('**/venom/provisioning/capability', (route) =>
    fulfillJson(route, CAPABILITY),
  );
  await page.route('**/venom/provisioning/runs*', (route) =>
    fulfillJson(route, []),
  );

  await page.goto(`/workspace/apps/${APP_ID}`);

  // The suggestion banner surfaces the new-data summary.
  const banner = page.getByTestId(`banner-improvement-${APP_ID}`);
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('New data since package v1');
  await expect(banner).toContainText(SIGNAL_SUMMARY);

  // Review & iterate opens the dialog with the pinned baseline and the
  // what's-new context.
  await page.getByTestId(`button-review-iterate-${APP_ID}`).click();
  const baseline = page.getByTestId('panel-iteration-baseline');
  await expect(baseline).toContainText('v1');
  await expect(baseline).toContainText('Field Guide package');
  await expect(baseline).toContainText('source v3');
  const changes = page.getByTestId('panel-iteration-changes');
  await expect(changes).toContainText("What's new since v1");
  await expect(changes).toContainText(SIGNAL_SUMMARY);

  // Nothing starts without an instruction.
  const start = page.getByTestId(`button-start-iteration-${APP_ID}`);
  await expect(start).toBeDisabled();
  await page.getByTestId('input-iteration-instruction').fill(INSTRUCTION);
  await page.getByTestId('input-iteration-constraints').fill(CONSTRAINTS);
  await expect(start).toBeEnabled();
  await start.click();

  // Starting the iteration lands on the run page, flagged as an improvement
  // iteration continuing from the baseline.
  await expect(page).toHaveURL(new RegExp(`/workspace/builds/${RUN_ID}`));
  await expect(
    page.getByRole('heading', { name: 'Field Guide', level: 1 }),
  ).toBeVisible();
  await expect(page.getByTestId('badge-improvement-iteration')).toBeVisible();
  await expect(page.getByText('New since baseline:')).toBeVisible();

  expect(iterationPosts).toHaveLength(1);
  expect(iterationPosts[0].instruction).toBe(INSTRUCTION);
  expect(iterationPosts[0].constraints).toBe(CONSTRAINTS);
  expect(typeof iterationPosts[0].idempotencyKey).toBe('string');
  expect(String(iterationPosts[0].idempotencyKey).length).toBeGreaterThan(0);

  // Back on the app page the run appears as the next package version on the
  // evolution timeline, and the consumed suggestion is gone.
  await page.goto(`/workspace/apps/${APP_ID}`);
  const landed = page.getByTestId('timeline-entry-evt-iter-2');
  await expect(landed).toBeVisible();
  await expect(landed).toContainText('Iteration 2');
  await expect(page.getByTestId(`banner-improvement-${APP_ID}`)).toHaveCount(0);
});

test('dismissing the suggestion hides it without starting anything', async ({
  page,
}) => {
  const iterationPosts: Array<Record<string, unknown>> = [];
  let dismissCalls = 0;
  let dismissed = false;

  await page.route(`**/venom/apps/${APP_ID}`, (route) =>
    fulfillJson(
      route,
      dismissed
        ? appDetail({ ...APP, improvementSignal: null }, DETAIL_BEFORE.timeline)
        : DETAIL_BEFORE,
    ),
  );
  await page.route(
    `**/venom/apps/${APP_ID}/improvement-suggestion/dismiss`,
    (route) => {
      dismissCalls += 1;
      dismissed = true;
      return fulfillJson(route, { ...APP, improvementSignal: null });
    },
  );
  await page.route(`**/venom/apps/${APP_ID}/iterations`, (route) => {
    iterationPosts.push(
      route.request().postDataJSON() as Record<string, unknown>,
    );
    return fulfillJson(route, { error: 'must not be called' }, 500);
  });

  await page.goto(`/workspace/apps/${APP_ID}`);
  await expect(page.getByTestId(`banner-improvement-${APP_ID}`)).toBeVisible();

  await page.getByTestId(`button-dismiss-suggestion-${APP_ID}`).click();

  await expect(page.getByTestId(`banner-improvement-${APP_ID}`)).toHaveCount(0);
  expect(dismissCalls).toBe(1);
  expect(iterationPosts).toHaveLength(0);

  // Still on the app page with the manual improve entry point intact.
  await expect(page).toHaveURL(new RegExp(`/workspace/apps/${APP_ID}`));
  await expect(page.getByTestId(`button-improve-app-${APP_ID}`)).toBeVisible();
});
