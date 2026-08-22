import { expect, test } from '@playwright/test';
import { stubJsonGet, stubWorkspaceApis } from './support/stubs';

/**
 * Brain move machinery on desktop (Task #281): low-confidence extractions
 * wait in an author-private Unsorted layer instead of being guessed into a
 * store, and every automatic filing into a workspace leaves a notice with a
 * working one-click undo.
 */

const STORAGE_KEY = '@venom_desktop_v1:venom-desktop-ui-test';
const NOW = 1_755_600_000_000;

const WORKSPACE = {
  id: '7d9f3c60-2222-4a4a-9c9c-3c3c3c3c3c3c',
  name: 'Symbiote Ops',
  role: 'member' as const,
  memberCount: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const AUTO_FILE_NOTICE = {
  id: 'mv_1',
  kind: 'auto_file' as const,
  status: 'active' as const,
  direction: 'unsorted_to_workspace' as const,
  workspaceId: WORKSPACE.id,
  workspaceName: WORKSPACE.name,
  labels: ['Vendor Rates'],
  createdAt: new Date(NOW).toISOString(),
};

function cluster(overrides: Record<string, unknown>) {
  return {
    projectId: 'proj_alpha',
    category: 'core',
    strength: 0.7,
    x: 40,
    y: 30,
    links: [],
    mentionCount: 1,
    lastUpdatedAt: NOW,
    sources: [],
    ...overrides,
  };
}

const WORKSPACE_STATE = {
  projects: [
    {
      id: 'proj_alpha',
      name: 'Aurora Systems',
      description: 'Active research workspace',
      accent: '#e5e5e5',
      sourceCount: 0,
      updatedAt: NOW,
    },
  ],
  conversations: [
    {
      id: 'conv_seed',
      title: 'Planning',
      projectId: 'proj_alpha',
      updatedAt: NOW,
      messages: [],
    },
  ],
  clusters: [
    cluster({
      id: 'cl_sorted',
      label: 'Launch Ops',
      description: 'Launch knowledge saved by Venom.',
      summary: 'Launch steps and rollback drills for the field releases.',
    }),
    cluster({
      id: 'cl_unsorted',
      label: 'Vendor Rates',
      x: -60,
      y: -40,
      description: 'Extraction Venom was not confident about.',
      summary: 'Quoted rates that could be personal or company knowledge.',
      unsorted: true,
    }),
  ],
  sources: [],
  archivedCitations: [],
  activeProjectId: 'proj_alpha',
  activeConversationId: 'conv_seed',
};

test.beforeEach(async ({ page }) => {
  await stubWorkspaceApis(page);
  await stubJsonGet(page, '**/venom/workspaces', [WORKSPACE]);
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, value),
    { key: STORAGE_KEY, value: JSON.stringify(WORKSPACE_STATE) },
  );
});

test('unsorted items wait in their own layer and can be kept personal', async ({
  page,
}) => {
  await page.goto('/workspace/brain');

  // The personal map holds only sorted knowledge; the held-back item is
  // neither drawn nor counted there.
  await expect(
    page.getByRole('button', { name: 'Node: Launch Ops', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Node: Vendor Rates', exact: true }),
  ).toHaveCount(0);

  // The filter offers Personal, the workspace, and Unsorted with a count.
  await expect(page.getByTestId('brain-layer-personal')).toBeVisible();
  await expect(
    page.getByTestId(`brain-layer-workspace-${WORKSPACE.id}`),
  ).toBeVisible();
  await expect(page.getByTestId('badge-unsorted-count')).toHaveText('1');

  await page.getByTestId('brain-layer-unsorted').click();
  await expect(
    page.getByRole('button', { name: 'Node: Vendor Rates', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Node: Launch Ops', exact: true }),
  ).toHaveCount(0);

  // Opening the held item explains the state and offers the two exits.
  await page
    .getByRole('button', { name: 'Node: Vendor Rates', exact: true })
    .click();
  const review = page.getByTestId('panel-unsorted-review');
  await expect(review).toBeVisible();
  await expect(review.getByTestId('button-keep-personal')).toBeVisible();
  await expect(
    review.getByTestId(`button-move-unsorted-${WORKSPACE.id}`),
  ).toBeVisible();

  await review.getByTestId('button-keep-personal').click();

  // The holding area empties out…
  await expect(page.getByTestId('badge-unsorted-count')).toHaveCount(0);
  await expect(page.getByTestId('brain-unsorted-empty')).toBeVisible();

  // …and the item now lives on the personal map like any other concept.
  await page.getByTestId('brain-layer-personal').click();
  await expect(
    page.getByRole('button', { name: 'Node: Vendor Rates', exact: true }),
  ).toBeVisible();
});

test('an automatic filing into a workspace surfaces as a notice with undo', async ({
  page,
}) => {
  let undone = false;
  await page.route('**/venom/knowledge/moves', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        notices: undone ? [] : [AUTO_FILE_NOTICE],
        suggestions: [],
      }),
    }),
  );
  await page.route('**/venom/knowledge/moves/mv_1/undo', (route) => {
    undone = true;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ restored: [] }),
    });
  });

  await page.goto('/workspace/brain');

  const notice = page.getByTestId('move-notice-mv_1');
  await expect(page.getByTestId('brain-move-activity')).toBeVisible();
  await expect(notice).toContainText('Vendor Rates');
  await expect(notice).toContainText('Symbiote Ops');

  const undoRequest = page.waitForRequest(
    (request) =>
      request.url().includes('/venom/knowledge/moves/mv_1/undo') &&
      request.method() === 'POST',
  );
  await page.getByTestId('button-undo-move-mv_1').click();
  await undoRequest;

  // The refreshed list no longer carries the notice.
  await expect(notice).toHaveCount(0);
});
