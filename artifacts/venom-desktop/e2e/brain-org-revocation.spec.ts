import { expect, test, type Page } from '@playwright/test';
import { stubJsonGet, stubWorkspaceApis } from './support/stubs';

/**
 * Revocation must land on an already-open device immediately. The Brain page
 * renders company concepts from memory, so if an admin removes a member the
 * 25s directory poll is a real disclosure window — the membership event
 * stream closes it. This spec proves the push path end to end in the UI:
 * the company layer is open, the event arrives, and the company content is
 * gone without any poll interval elapsing.
 *
 * `page.route` fulfills atomically, so the event stream is produced inside
 * the page by wrapping `window.fetch` from an init script; pushing an event
 * is exposed to the test as `window.__pushOrgEvent`.
 */

const ORG_ID = 'org_acme';
const COMPANY_CONCEPT_LABEL = 'Pricing Playbook';

const DIRECTORY = {
  orgs: [
    {
      id: ORG_ID,
      name: 'Acme Co',
      role: 'member',
      memberCount: 3,
      createdAt: 1700000000000,
    },
  ],
  invites: [],
};

const EMPTY_DIRECTORY = { orgs: [], invites: [] };

const ORG_BRAIN = {
  orgId: ORG_ID,
  orgName: 'Acme Co',
  concepts: [
    {
      id: 'org_concept_pricing',
      projectId: 'org_shared',
      label: COMPANY_CONCEPT_LABEL,
      category: 'topic',
      strength: 1,
      x: 0,
      y: 0,
      links: [],
      sources: [
        {
          conversationId: 'org_conv_pricing',
          projectId: 'org_shared',
          conversationTitle: 'Enterprise pricing sync',
          messageIds: ['m1'],
          excerpt: 'Enterprise deals anchor at $50k with a 20% services attach.',
          updatedAt: 1700000000000,
          capturedByUserId: null,
          capturedAt: null,
        },
      ],
      summary: 'How Acme prices enterprise deals.',
      mentionCount: 4,
      lastUpdatedAt: 1700000000000,
    },
  ],
  audit: [],
};

const SEARCH_RESULTS = {
  results: [
    {
      id: 'org_concept_pricing',
      label: COMPANY_CONCEPT_LABEL,
      category: 'topic',
      projectId: 'org_shared',
      evidenceCount: 1,
    },
  ],
};

async function stubOrgEventsStream(page: Page) {
  await page.addInitScript(() => {
    const sinks: Array<(chunk: string) => void> = [];
    (window as unknown as Record<string, unknown>).__pushOrgEvent = (
      payload: unknown,
    ) => {
      for (const sink of sinks) {
        sink(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };
    const originalFetch = window.fetch.bind(window);
    window.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (!url.includes('/api/venom/orgs/events')) {
        return originalFetch(input as RequestInfo, init);
      }
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"connected"}\n\n'));
          sinks.push((chunk) => controller.enqueue(encoder.encode(chunk)));
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof window.fetch;
  });
}

test('removal event clears the open company layer before any poll', async ({
  page,
}) => {
  let removed = false;
  await stubWorkspaceApis(page);
  await page.route('**/api/venom/orgs', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(removed ? EMPTY_DIRECTORY : DIRECTORY),
    });
  });
  await stubJsonGet(page, `**/api/venom/orgs/${ORG_ID}/projects`, {
    projects: [],
  });
  await stubJsonGet(page, `**/api/venom/orgs/${ORG_ID}/brain`, ORG_BRAIN);
  await stubJsonGet(page, '**/api/venom/ontology/search*', SEARCH_RESULTS);
  await stubOrgEventsStream(page);

  await page.goto('/workspace/brain?venomUiTestOrgs=1');

  // The member opens the company layer and sees shared knowledge.
  const switcher = page.getByTestId('brain-layer-switcher');
  await expect(switcher).toBeVisible();
  await page.getByTestId(`brain-layer-org-${ORG_ID}`).click();
  await expect(page.getByTestId(`brain-layer-org-${ORG_ID}`)).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const companyNode = page.getByRole('button', {
    name: `Node: ${COMPANY_CONCEPT_LABEL}`,
  });
  await expect(companyNode).toBeVisible();

  // Open the concept's detail pane: label, summary, and the evidence row
  // render from the org snapshot held in memory — exactly the state that
  // must not survive removal. The single stubbed node projects under the
  // header note, so fire the click on the node itself; pointer mechanics
  // are covered by the map interaction suites.
  await companyNode.dispatchEvent('click');
  const evidenceExcerpt = page.getByTestId('evidence-excerpt-0');
  await expect(evidenceExcerpt).toContainText('Enterprise deals anchor');

  // Search is also answering from the company scope: on the company layer
  // the query narrows the map itself, and the company node survives its
  // own label as the filter.
  const searchInput = page.getByPlaceholder('Search concepts');
  await searchInput.fill('Pricing');
  await expect(companyNode).toBeVisible();

  // An admin removes the member; the server pushes membership-changed to
  // the open stream. From here on the directory says "no companies".
  removed = true;
  await page.evaluate(() => {
    (
      window as unknown as {
        __pushOrgEvent: (payload: unknown) => void;
      }
    ).__pushOrgEvent({ type: 'membership-changed', orgId: 'org_acme' });
  });

  // Immediately — no 25s poll, no clock games — every trace of company
  // content is gone in one commit: the map node, the open detail pane with
  // its label and evidence, and the search results. Short timeouts keep
  // this well inside any poll interval. The switcher itself stays: the
  // Venom network layer is available to every account, so only the org
  // pill may vanish.
  await expect(companyNode).toHaveCount(0, { timeout: 4000 });
  await expect(page.getByTestId(`brain-layer-org-${ORG_ID}`)).toHaveCount(0, {
    timeout: 4000,
  });
  await expect(switcher).toBeVisible();
  await expect(page.getByTestId('brain-layer-network')).toBeVisible();
  await expect(evidenceExcerpt).toHaveCount(0);
  await expect(searchInput).toHaveValue('');
  await expect(page.getByText(COMPANY_CONCEPT_LABEL)).toHaveCount(0);
});
