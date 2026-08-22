import { expect, test } from '@playwright/test';
import { stubJsonGet, stubWorkspaceApis } from './support/stubs';

/**
 * The Venom network tier on desktop: the anonymous master map as a third
 * Brain layer, "Related in the Venom network" chips on the personal layer,
 * and the consent dialog that gates contribution.
 *
 * All network reads and writes are stubbed; the spec proves the client
 * contract only. Privacy assertions live server-side in the master-ontology
 * integration suite — here we prove the surfaces: read-only network layer,
 * network-marked suggestions, and consent copy that names the boundary.
 */

const STORAGE_KEY = '@venom_desktop_v1:venom-desktop-ui-test';
const NOW = 1_755_600_000_000;

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
  conversations: [],
  clusters: [
    {
      id: 'cl_launch',
      projectId: 'proj_alpha',
      label: 'Launch Ops',
      category: 'core',
      strength: 0.8,
      x: 60,
      y: 40,
      links: [],
      description: 'Launch knowledge saved by Venom.',
      summary: 'Launch steps and rollback drills.',
      mentionCount: 2,
      lastUpdatedAt: NOW,
      sources: [],
    },
  ],
  sources: [],
  archivedCitations: [],
  activeProjectId: 'proj_alpha',
  activeConversationId: null,
};

const EMPTY_DIRECTORY = { orgs: [], invites: [] };

const MASTER_BRAIN = {
  concepts: [
    {
      id: 'master:kubernetes',
      label: 'Kubernetes',
      category: 'technology',
      strength: 0.9,
      x: 40,
      y: 20,
    },
    {
      id: 'master:observability',
      label: 'Observability',
      category: 'practice',
      strength: 0.7,
      x: -60,
      y: -40,
    },
  ],
  links: [{ a: 'master:kubernetes', b: 'master:observability', strength: 0.6 }],
};

const SUGGESTIONS = {
  suggestions: [
    {
      label: 'Incident response',
      category: 'practice',
      strength: 0.8,
      relatedToLabels: ['Launch Ops'],
    },
    {
      label: 'Postmortems',
      category: 'practice',
      strength: 0.5,
      relatedToLabels: [],
    },
  ],
};

test.beforeEach(async ({ page }) => {
  await stubWorkspaceApis(page);
  await stubJsonGet(page, '**/api/venom/orgs', EMPTY_DIRECTORY);
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, value),
    { key: STORAGE_KEY, value: JSON.stringify(WORKSPACE_STATE) },
  );
});

test('network suggestions on the personal layer apply and dismiss', async ({
  page,
}) => {
  let dismissed = 0;
  await stubJsonGet(page, '**/api/venom/master/suggestions', SUGGESTIONS);
  await page.route('**/api/venom/master/suggestions/apply', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        filedScope: { ownerType: 'user' },
        filed: [
          {
            id: 'cl_incident_response',
            projectId: null,
            label: 'Incident response',
            category: 'practice',
            strength: 0.6,
            x: 10,
            y: -10,
            links: [],
            description: 'Suggested by the Venom network.',
            summary: 'Suggested by the Venom network.',
            mentionCount: 1,
            lastUpdatedAt: NOW,
            sources: [],
          },
        ],
      }),
    });
  });
  await page.route(
    '**/api/venom/master/suggestions/dismiss',
    async (route) => {
      dismissed += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    },
  );

  await page.goto('/workspace/brain');

  // Chips are present and clearly marked as coming from the network.
  const strip = page.getByTestId('brain-network-suggestions');
  await expect(strip).toBeVisible();
  await expect(strip).toContainText('Related in the Venom network');

  // Applying files it server-side, drops the chip, and confirms in a toast.
  await page.getByTestId('suggestion-apply-Incident response').click();
  await expect(
    page.getByTestId('suggestion-apply-Incident response'),
  ).toHaveCount(0);
  await expect(
    page.getByText('“Incident response” added', { exact: true }),
  ).toBeVisible();

  // Dismissing is immediate and remembered server-side.
  await page.getByTestId('suggestion-dismiss-Postmortems').click();
  await expect(
    page.getByTestId('suggestion-dismiss-Postmortems'),
  ).toHaveCount(0);
  await expect.poll(() => dismissed).toBe(1);
});

test('the network layer is an anonymous, read-only master map', async ({
  page,
}) => {
  await stubJsonGet(page, '**/api/venom/master/suggestions', {
    suggestions: [],
  });
  await stubJsonGet(page, '**/api/venom/master/brain', MASTER_BRAIN);

  await page.goto('/workspace/brain');

  // The switcher renders even with no company memberships.
  const networkPill = page.getByTestId('brain-layer-network');
  await expect(networkPill).toBeVisible();
  await networkPill.click();
  await expect(networkPill).toHaveAttribute('aria-pressed', 'true');

  // Aggregate concepts arrive on the same map, framed by the privacy note.
  await expect(page.getByTestId('brain-network-note')).toContainText(
    'anonymous',
  );
  const node = page.getByRole('button', {
    name: 'Node: Kubernetes',
    exact: true,
  });
  await expect(node).toBeVisible();

  // No export surface for the master map.
  await expect(page.getByTestId('button-export-brain')).toHaveCount(0);

  // The detail pane is reference material: badged, provenance-noted, and
  // free of evidence and edit affordances.
  await node.dispatchEvent('click');
  await expect(
    page.getByTestId('brain-detail-network-badge'),
  ).toBeVisible();
  await expect(
    page.getByTestId('brain-detail-network-provenance'),
  ).toContainText('No names');
  await expect(page.getByLabel('Edit label')).toHaveCount(0);
  await expect(
    page.getByTestId('button-toggle-concept-sensitivity'),
  ).toHaveCount(0);

  // Personal content stays behind on its own layer: switching back returns
  // the seeded map. Close the pane first — its backdrop covers the switcher.
  await page.getByLabel('Close details').click();
  await page.getByTestId('brain-layer-personal').click();
  await expect(
    page.getByRole('button', { name: 'Node: Launch Ops', exact: true }),
  ).toBeVisible();
});

test('the consent dialog reads and writes the contribution setting', async ({
  page,
}) => {
  let putBody: unknown = null;
  await stubJsonGet(page, '**/api/venom/master/suggestions', {
    suggestions: [],
  });
  await stubJsonGet(page, '**/api/venom/master/contribution', {
    enabled: false,
  });
  await page.route('**/api/venom/master/contribution', async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.fallback();
      return;
    }
    putBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ enabled: true }),
    });
  });

  await page.goto('/workspace/brain');
  await page.getByTestId('button-network-contribution-desktop').click();

  const dialog = page.getByTestId('dialog-network-contribution');
  await expect(dialog).toBeVisible();

  // Off by default, with the boundary and the opt-out consequence in plain
  // language.
  await expect(page.getByTestId('network-contribution-off')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(dialog).toContainText('Never shared:');
  await expect(
    page.getByTestId('network-contribution-optout-note'),
  ).toContainText('removes your influence');

  // Opting in writes the flag and reflects the server's answer.
  await page.getByTestId('network-contribution-on').click();
  await expect(page.getByTestId('network-contribution-on')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  expect(putBody).toEqual({ enabled: true });
});

test('a company admin flips the contribution toggle', async ({ page }) => {
  let putBody: unknown = null;

  // Later routes win, so this directory overrides the empty one from
  // beforeEach; the org machinery only runs with the org UI-test flag.
  await stubJsonGet(page, '**/api/venom/orgs', {
    orgs: [
      {
        id: 'org_acme',
        name: 'Acme Co',
        role: 'admin',
        memberCount: 1,
        createdAt: NOW,
      },
    ],
    invites: [],
  });
  await stubJsonGet(page, '**/api/venom/orgs/org_acme/members', {
    members: [
      {
        userId: 'user_admin',
        name: 'Admin',
        email: 'admin@acme.co',
        role: 'admin',
        isSelf: true,
      },
    ],
    invites: [],
  });
  await stubJsonGet(page, '**/api/venom/orgs/org_acme/projects', {
    projects: [],
  });
  await stubJsonGet(page, '**/api/venom/orgs/org_acme/sources', {
    sources: [],
  });
  await stubJsonGet(page, '**/api/venom/orgs/org_acme/contribution', {
    enabled: false,
  });
  await page.route(
    '**/api/venom/orgs/org_acme/contribution',
    async (route) => {
      if (route.request().method() !== 'PUT') {
        await route.fallback();
        return;
      }
      putBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enabled: true }),
      });
    },
  );
  // Keep the membership event stream quiet.
  await page.addInitScript(() => {
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
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof window.fetch;
  });

  await page.goto('/workspace/company?venomUiTestOrgs=1');

  const card = page.getByTestId('company-network-contribution');
  await card.scrollIntoViewIfNeeded();
  await expect(card).toContainText('Never shared');

  const toggle = page.getByTestId('company-network-toggle');
  await expect(toggle).toHaveText('Off');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  await toggle.click();
  await expect(toggle).toHaveText('Contributing');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(putBody).toEqual({ enabled: true });
});

test('a company member sees the contribution state read-only', async ({
  page,
}) => {
  let putCalls = 0;
  await stubJsonGet(page, '**/api/venom/orgs', {
    orgs: [
      {
        id: 'org_acme',
        name: 'Acme Co',
        role: 'member',
        memberCount: 2,
        createdAt: NOW,
      },
    ],
    invites: [],
  });
  await stubJsonGet(page, '**/api/venom/orgs/org_acme/members', {
    members: [
      {
        userId: 'user_admin',
        name: 'Admin',
        email: 'admin@acme.co',
        role: 'admin',
        isSelf: false,
      },
      {
        userId: 'user_self',
        name: 'Self',
        email: 'self@acme.co',
        role: 'member',
        isSelf: true,
      },
    ],
    invites: [],
  });
  await stubJsonGet(page, '**/api/venom/orgs/org_acme/projects', {
    projects: [],
  });
  await stubJsonGet(page, '**/api/venom/orgs/org_acme/sources', {
    sources: [],
  });
  await stubJsonGet(page, '**/api/venom/orgs/org_acme/contribution', {
    enabled: true,
  });
  await page.route(
    '**/api/venom/orgs/org_acme/contribution',
    async (route) => {
      if (route.request().method() !== 'PUT') {
        await route.fallback();
        return;
      }
      putCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enabled: false }),
      });
    },
  );
  // Keep the membership event stream quiet.
  await page.addInitScript(() => {
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
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof window.fetch;
  });

  await page.goto('/workspace/company?venomUiTestOrgs=1');

  const card = page.getByTestId('company-network-contribution');
  await card.scrollIntoViewIfNeeded();
  await expect(page.getByTestId('company-network-state')).toHaveText(
    'Contributing',
  );
  await expect(page.getByTestId('company-network-toggle')).toHaveCount(0);
  await expect(page.getByTestId('company-network-readonly')).toContainText(
    'Only admins',
  );
  expect(putCalls).toBe(0);
});
