import { expect, test, type Route } from '@playwright/test';
import { stubWorkspaceApis, stubJsonGet } from './support/stubs';

/**
 * Global template gallery: browsing shows the curated set, the detail dialog
 * shows what a template produces, and "Use this template" creates a portfolio
 * app plus a pre-filled build request whose submission carries template
 * lineage. Apps born from a template surface their origin on the detail page.
 * Every endpoint is stubbed so the flow stays hermetic.
 */

const TEMPLATE_ID = 'a0000000-0000-4000-8000-000000000051';
const OTHER_TEMPLATE_ID = 'a0000000-0000-4000-8000-000000000052';
const APP_ID = 'b0000000-0000-4000-8000-000000000053';
const RUN_ID = 'c0000000-0000-4000-8000-000000000054';
const NOW = '2026-08-20T12:00:00.000Z';

const TEMPLATE_SUMMARY = {
  id: TEMPLATE_ID,
  slug: 'client-booking-app',
  name: 'Client Booking App',
  category: 'app',
  description: 'Let clients book time with you without the back-and-forth.',
  hasExamplePackage: true,
  updatedAt: NOW,
};

const OTHER_SUMMARY = {
  id: OTHER_TEMPLATE_ID,
  slug: 'testimonial-wall-widget',
  name: 'Testimonial Wall Widget',
  category: 'widget',
  description: 'A wall of customer praise for any existing site.',
  hasExamplePackage: false,
  updatedAt: NOW,
};

const TEMPLATE_DETAIL = {
  ...TEMPLATE_SUMMARY,
  previewSummary:
    'A booking flow for clients plus an owner dashboard of upcoming sessions.',
  targetType: 'website',
  targetName: 'Client Booking Site',
  requirements: 'Build a booking site with real availability windows.',
  constraints: 'No payment collection in the first version.',
  brandDirection: 'Calm, professional, generous whitespace.',
  acceptanceChecks: [
    'A booked slot disappears from availability',
    'The owner sees new bookings immediately',
  ],
  examplePackage: { title: 'Booking starter package' },
  status: 'active',
};

const CREATED_APP = {
  id: APP_ID,
  name: 'My Booking Studio',
  purpose: 'Let clients book time with you without the back-and-forth.',
  brand: 'Client Booking App',
  status: 'draft',
  detectedStack: [],
  sourceType: null,
  sourceVersion: 0,
  deploymentUrl: null,
  importStatus: null,
  sourceUpdatedAt: null,
  linkedProjectId: null,
  linkedProjectName: null,
  latestIterationNumber: null,
  improvementSignal: null,
  liveReleaseId: null,
  templateId: TEMPLATE_ID,
  templateName: 'Client Booking App',
  createdAt: NOW,
  updatedAt: NOW,
};

const USE_RESULT = {
  app: CREATED_APP,
  templateId: TEMPLATE_ID,
  templateName: 'Client Booking App',
  prefill: {
    targetType: 'website',
    targetName: 'Client Booking Site',
    requirements: 'Build a booking site with real availability windows.',
    constraints: 'No payment collection in the first version.',
    brandDirection: 'Calm, professional, generous whitespace.',
  },
};

const APP_DETAIL = {
  app: CREATED_APP,
  versions: [],
  importJobs: [],
  deploymentLinks: [],
  provisioningReleases: [],
  iterations: [],
  timeline: [],
  timelineTotal: 0,
  timelineTruncated: false,
};

const CREATED_RUN = {
  id: RUN_ID,
  correlationId: 'd0000000-0000-4000-8000-000000000055',
  appId: APP_ID,
  runKind: 'standard',
  targetType: 'website',
  targetName: 'Client Booking Site',
  status: 'queued',
  progress: 0,
  currentRevisionNumber: 0,
  approvedRevisionId: null,
  templateId: TEMPLATE_ID,
  failureMessage: null,
  cancelledReason: null,
  createdAt: NOW,
  updatedAt: NOW,
  request: {
    targetType: 'website',
    targetName: 'Client Booking Site',
    requirements: 'Build a booking site with real availability windows.',
    constraints: 'No payment collection in the first version.',
    brandDirection: 'Calm, professional, generous whitespace.',
    appId: APP_ID,
    sourceVersionId: null,
    projectId: null,
    sopRevisionIds: [],
    baselineIterationId: null,
    baselineRevisionId: null,
    changesSummary: null,
    templateId: TEMPLATE_ID,
  },
  revisions: [],
  events: [
    {
      id: 'e0000000-0000-4000-8000-000000000056',
      eventType: 'queued',
      message: 'Build request queued.',
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

function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

test.beforeEach(async ({ page }) => {
  await stubWorkspaceApis(page);
  await stubJsonGet(page, '**/venom/sops', []);
  await stubJsonGet(page, '**/venom/build-templates', [
    TEMPLATE_SUMMARY,
    OTHER_SUMMARY,
  ]);
  await stubJsonGet(
    page,
    `**/venom/build-templates/${TEMPLATE_ID}`,
    TEMPLATE_DETAIL,
  );
});

test('browses the gallery and turns a template into a pre-filled build request', async ({
  page,
}) => {
  const usePosts: Array<Record<string, unknown> | null> = [];
  const runPosts: Array<Record<string, unknown>> = [];

  await page.route(
    `**/venom/build-templates/${TEMPLATE_ID}/use`,
    (route) => {
      usePosts.push(route.request().postDataJSON() as Record<
        string,
        unknown
      > | null);
      return fulfillJson(route, USE_RESULT, 201);
    },
  );
  await page.route(`**/venom/apps/${APP_ID}`, (route) =>
    fulfillJson(route, APP_DETAIL),
  );
  await page.route('**/venom/build-runs', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    runPosts.push(route.request().postDataJSON() as Record<string, unknown>);
    return fulfillJson(route, CREATED_RUN, 201);
  });
  await page.route(`**/venom/build-runs/${RUN_ID}`, (route) =>
    fulfillJson(route, CREATED_RUN),
  );
  await page.route('**/venom/provisioning/capability', (route) =>
    fulfillJson(route, CAPABILITY),
  );
  await page.route('**/venom/provisioning/runs*', (route) =>
    fulfillJson(route, []),
  );

  await page.goto('/workspace/templates');

  // Gallery: both templates visible with their categories.
  const bookingCard = page.getByTestId('card-template-client-booking-app');
  await expect(bookingCard).toBeVisible();
  await expect(bookingCard).toContainText('App');
  await expect(bookingCard).toContainText('Example included');
  await expect(
    page.getByTestId('card-template-testimonial-wall-widget'),
  ).toBeVisible();

  // Category filter narrows the set.
  await page.getByTestId('button-filter-widget').click();
  await expect(bookingCard).toBeHidden();
  await expect(
    page.getByTestId('card-template-testimonial-wall-widget'),
  ).toBeVisible();
  await page.getByTestId('button-filter-all').click();

  // Detail dialog shows what the template produces.
  await bookingCard.click();
  await expect(page.getByTestId('text-template-detail-name')).toHaveText(
    'Client Booking App',
  );
  await expect(page.getByRole('dialog')).toContainText(
    'A booking flow for clients plus an owner dashboard',
  );
  await expect(page.getByRole('dialog')).toContainText(
    'A booked slot disappears from availability',
  );
  await expect(page.getByRole('dialog')).toContainText(
    'Booking starter package',
  );

  // Use it under a custom app name.
  await page
    .getByTestId('input-template-app-name')
    .fill('My Booking Studio');
  await page.getByTestId('button-use-template').click();

  // The use call carried the chosen name.
  await expect
    .poll(() => usePosts.length, { message: 'use endpoint was called' })
    .toBe(1);
  expect(usePosts[0]).toEqual({ name: 'My Booking Studio' });

  // Landed on the build form, pre-filled from the template and editable.
  await expect(page).toHaveURL(
    new RegExp(`/workspace/builds/new\\?appId=${APP_ID}&templateId=${TEMPLATE_ID}`),
  );
  await expect(page.getByTestId('banner-template-origin')).toContainText(
    'Client Booking App',
  );
  await expect(page.locator('#targetName')).toHaveValue(
    'Client Booking Site',
  );
  await expect(page.locator('#requirements')).toHaveValue(
    'Build a booking site with real availability windows.',
  );
  await expect(page.locator('#constraints')).toHaveValue(
    'No payment collection in the first version.',
  );
  await expect(page.locator('#brandDirection')).toHaveValue(
    'Calm, professional, generous whitespace.',
  );
  // Target type followed the template, not the default.
  await expect(page.locator('#type-website')).toBeChecked();

  // Every field stays editable before generation.
  await page
    .locator('#requirements')
    .fill('Build a booking site with real availability windows. Add SMS reminders.');

  await page.getByRole('button', { name: /draft package/i }).click();

  // The submitted run carries template lineage alongside the edits.
  await expect
    .poll(() => runPosts.length, { message: 'build run was submitted' })
    .toBe(1);
  expect(runPosts[0]).toMatchObject({
    appId: APP_ID,
    templateId: TEMPLATE_ID,
    targetType: 'website',
    requirements:
      'Build a booking site with real availability windows. Add SMS reminders.',
  });
  await expect(page).toHaveURL(new RegExp(`/workspace/builds/${RUN_ID}`));
});

test('an app born from a template shows its origin', async ({ page }) => {
  await page.route(`**/venom/apps/${APP_ID}`, (route) =>
    fulfillJson(route, APP_DETAIL),
  );
  await page.route('**/venom/provisioning/capability', (route) =>
    fulfillJson(route, CAPABILITY),
  );
  await page.route('**/venom/provisioning/runs*', (route) =>
    fulfillJson(route, []),
  );

  await page.goto(`/workspace/apps/${APP_ID}`);

  const origin = page.getByTestId('text-template-origin');
  await expect(origin).toBeVisible();
  await expect(origin).toHaveText('Client Booking App');
});
