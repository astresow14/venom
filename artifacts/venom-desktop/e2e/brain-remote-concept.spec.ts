import { expect, test, type Page } from '@playwright/test';
import { stubJsonGet, stubWorkspaceApis } from './support/stubs';

/**
 * Brain search covers the whole server-side ontology, which can hold more
 * concepts than a device keeps locally. A hit the device has not cached must
 * still open — summary, evidence, linked concepts — served on demand, and it
 * must degrade to a clear "connect to view evidence" state offline.
 */

const REMOTE_CONCEPT_ID = 'concept_vendor_contracts';
const GAP_CONCEPT_ID = 'concept_local_gap';

const SEARCH_RESULTS = {
  results: [
    {
      id: REMOTE_CONCEPT_ID,
      projectId: 'proj_beyond',
      label: 'Vendor Contracts',
      category: 'external',
      summary: 'Contract terms negotiated with suppliers.',
      strength: 0.8,
      mentionCount: 6,
      lastUpdatedAt: 1700000000000,
      evidenceCount: 2,
    },
    {
      // Belongs to the active project but is absent from local state: the
      // server holds more than the device cached, so it must still surface.
      id: GAP_CONCEPT_ID,
      projectId: 'proj_default',
      label: 'Forgotten Budget Notes',
      category: 'memory',
      summary: 'Budget context the device never cached.',
      strength: 0.5,
      mentionCount: 2,
      lastUpdatedAt: 1700000000000,
      evidenceCount: 1,
    },
  ],
};

const CONCEPT_DETAIL = {
  concept: {
    id: REMOTE_CONCEPT_ID,
    projectId: 'proj_beyond',
    label: 'Vendor Contracts',
    category: 'external',
    strength: 0.8,
    x: 0,
    y: 0,
    links: [],
    description: 'Contract terms negotiated with suppliers.',
    summary: 'Contract terms negotiated with suppliers over the last quarter.',
    mentionCount: 6,
    lastUpdatedAt: 1700000000000,
    sources: [
      {
        conversationId: 'conv_supplier_review',
        projectId: 'proj_beyond',
        conversationTitle: 'Supplier review',
        messageIds: ['m1'],
        excerpt: 'Acme renewal lands in March with a 12% uplift cap.',
        updatedAt: 1700000000000,
      },
      {
        conversationId: 'conv_pricing_sync',
        projectId: 'proj_beyond',
        conversationTitle: 'Pricing sync',
        messageIds: ['m2'],
        excerpt: 'Volume discount only applies beyond 10k seats.',
        updatedAt: 1700000000000,
      },
    ],
  },
  neighbors: [
    {
      id: '1',
      projectId: 'proj_default',
      label: 'Product Context',
      category: 'core',
      summary: 'The main ideas and structure that shape this workspace.',
      strength: 1,
      mentionCount: 1,
      lastUpdatedAt: 0,
      evidenceCount: 0,
    },
    {
      id: 'concept_renewal_risks',
      projectId: 'proj_beyond',
      label: 'Renewal Risks',
      category: 'tactical',
      summary: 'Contracts approaching renewal with open questions.',
      strength: 0.6,
      mentionCount: 3,
      lastUpdatedAt: 1700000000000,
      evidenceCount: 1,
    },
  ],
};

async function searchFor(page: Page, term: string) {
  await page.goto('/workspace/brain');
  await expect(
    page.getByRole('region', { name: /Knowledge map/ }),
  ).toBeVisible();
  await page.getByLabel('Search map').fill(term);
}

test('a hit the device has not cached opens a server-backed evidence panel', async ({
  page,
}) => {
  await stubWorkspaceApis(page);
  await stubJsonGet(page, '**/api/venom/ontology/search**', SEARCH_RESULTS);
  await stubJsonGet(
    page,
    `**/api/venom/ontology/concepts/${REMOTE_CONCEPT_ID}`,
    CONCEPT_DETAIL,
  );

  await searchFor(page, 'vendor');

  // Both the other-project hit and the uncached current-project hit surface
  // in the beyond-this-map panel.
  const results = page.getByTestId('brain-cross-project-results');
  await expect(results).toBeVisible();
  await expect(results).toContainText('Beyond this map');
  await expect(
    page.getByTestId(`brain-search-result-${GAP_CONCEPT_ID}`),
  ).toBeVisible();

  await page.getByTestId(`brain-search-result-${REMOTE_CONCEPT_ID}`).click();

  const panel = page.getByTestId('brain-remote-concept');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(
    'Contract terms negotiated with suppliers over the last quarter.',
  );
  await expect(panel).toContainText('Evidence · 2');
  await expect(
    panel.getByTestId('brain-remote-evidence-conv_supplier_review'),
  ).toContainText('Acme renewal lands in March with a 12% uplift cap.');
  await expect(
    panel.getByTestId('brain-remote-evidence-conv_pricing_sync'),
  ).toContainText('Volume discount only applies beyond 10k seats.');

  // A linked concept that lives on this device jumps back onto the map.
  await panel.getByTestId('brain-remote-neighbor-1').click();
  await expect(page.getByTestId('brain-remote-concept')).toHaveCount(0);
  await expect(page.getByLabel('Close details')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Product Context' })).toBeVisible();
});

test('offline shows a connect-to-view state and retry recovers', async ({
  page,
}) => {
  await stubWorkspaceApis(page);
  await stubJsonGet(page, '**/api/venom/ontology/search**', SEARCH_RESULTS);

  let conceptCalls = 0;
  await page.route('**/api/venom/ontology/concepts/**', async (route) => {
    conceptCalls += 1;
    if (conceptCalls === 1) {
      await route.abort();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(CONCEPT_DETAIL),
    });
  });

  await searchFor(page, 'vendor');
  await page.getByTestId(`brain-search-result-${REMOTE_CONCEPT_ID}`).click();

  const offline = page.getByTestId('brain-remote-offline');
  await expect(offline).toBeVisible();
  await expect(offline).toContainText('Connect to view evidence');

  await page.getByTestId('brain-remote-retry').click();
  await expect(page.getByTestId('brain-remote-concept')).toContainText(
    'Evidence · 2',
  );
});

test('a concept deleted elsewhere reads as gone, not as an error', async ({
  page,
}) => {
  await stubWorkspaceApis(page);
  await stubJsonGet(page, '**/api/venom/ontology/search**', SEARCH_RESULTS);
  await stubJsonGet(
    page,
    '**/api/venom/ontology/concepts/**',
    { message: 'Concept not found' },
    404,
  );

  await searchFor(page, 'budget');
  await page.getByTestId(`brain-search-result-${GAP_CONCEPT_ID}`).click();

  const missing = page.getByTestId('brain-remote-missing');
  await expect(missing).toBeVisible();
  await expect(missing).toContainText('no longer in your knowledge base');
});
