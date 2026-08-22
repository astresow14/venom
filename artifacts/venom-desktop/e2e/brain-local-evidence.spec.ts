import { expect, test } from '@playwright/test';
import { stubWorkspaceApis } from './support/stubs';

/**
 * Evidence behind a concept opened from the desktop map.
 *
 * A concept already on the device must show the same proof a server-backed
 * concept shows: which conversations produced it, with the excerpt that backs
 * it. Excerpts are distilled from conversation text, so inline
 * `[source:...]` markers must resolve to their source title — a reader never
 * sees a raw marker. Concepts with no captured conversations state that
 * plainly instead of hiding the section.
 *
 * The workspace is seeded through the local mirror UI-test mode reads at
 * startup; UI-test mode skips the server concept lookup, so the panel renders
 * from the device copy alone.
 */

const STORAGE_KEY = '@venom_desktop_v1:venom-desktop-ui-test';
const NOW = 1_755_600_000_000; // fixed timestamp keeps the seed deterministic

const LIVE_CITATION = {
  id: 'cite_readme',
  provider: 'github',
  kind: 'repository',
  title: 'README.md',
  url: 'https://github.com/acme/venom/blob/main/README.md',
  excerpt: 'Launch steps live in the deploy section.',
  reference: null,
};

const WORKSPACE_STATE = {
  projects: [
    {
      id: 'proj_alpha',
      name: 'Aurora Systems',
      description: 'Active research workspace',
      accent: '#e5e5e5',
      sourceCount: 1,
      updatedAt: NOW,
    },
  ],
  conversations: [
    {
      id: 'conv_launch',
      title: 'Launch prep',
      projectId: 'proj_alpha',
      updatedAt: NOW,
      messages: [],
    },
  ],
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
      summary: 'Launch steps and rollback drills for the field releases.',
      mentionCount: 2,
      lastUpdatedAt: NOW,
      sources: [
        {
          conversationId: 'conv_launch',
          projectId: 'proj_alpha',
          conversationTitle: 'Launch prep',
          messageIds: ['m1'],
          excerpt:
            'Launch steps confirmed in [source:cite_readme] before the dry run.',
          updatedAt: NOW,
        },
        {
          conversationId: 'conv_retro',
          projectId: 'proj_alpha',
          conversationTitle: 'Retro notes',
          messageIds: ['m2'],
          excerpt: 'The staging retro flagged the rollback drill as the gap.',
          updatedAt: NOW - 86_400_000,
        },
      ],
    },
    {
      id: 'cl_hunch',
      projectId: 'proj_alpha',
      label: 'Unsourced Hunch',
      category: 'memory',
      strength: 0.4,
      x: -80,
      y: -60,
      links: [],
      description: 'A concept Venom holds without captured conversations.',
      summary: 'A standing hunch no conversation has backed yet.',
      mentionCount: 1,
      lastUpdatedAt: NOW,
      sources: [],
    },
  ],
  sources: [
    {
      id: 'source_acme_venom',
      projectId: 'proj_alpha',
      provider: 'github',
      name: 'acme/venom',
      url: 'https://github.com/acme/venom',
      status: 'connected',
      syncedAt: new Date(NOW - 86_400_000).toISOString(),
      summary: 'Repository docs connected for launch planning.',
      context: 'Connected by the browser-test fixture.',
      citations: [LIVE_CITATION],
      clusters: [],
    },
  ],
  archivedCitations: [],
  activeProjectId: 'proj_alpha',
  activeConversationId: 'conv_launch',
};

test.beforeEach(async ({ page }) => {
  await stubWorkspaceApis(page);
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, value),
    { key: STORAGE_KEY, value: JSON.stringify(WORKSPACE_STATE) },
  );
  await page.goto('/workspace/brain');
  await expect(
    page.getByRole('region', { name: /Knowledge map with 2 nodes/ }),
  ).toBeVisible();
});

test('a concept opened from the map lists its conversation evidence', async ({
  page,
}) => {
  await page
    .getByRole('button', { name: 'Node: Launch Ops', exact: true })
    .click();

  // The panel matches the server-backed view: a counted Evidence section.
  await expect(page.getByText('Evidence · 2', { exact: true })).toBeVisible();
  const list = page.getByTestId('list-evidence');
  await expect(list).toBeVisible();

  // Each row carries the conversation title and the excerpt behind it.
  const first = page.getByTestId('evidence-row-0');
  await expect(first).toContainText('Launch prep');
  await expect(page.getByTestId('evidence-person-0')).toBeVisible();
  const firstExcerpt = page.getByTestId('evidence-excerpt-0');
  // The stored marker resolves to its source title; the raw tag never shows.
  await expect(firstExcerpt).toContainText(
    'Launch steps confirmed in README.md before the dry run.',
  );
  await expect(firstExcerpt).not.toContainText('[source:');

  const second = page.getByTestId('evidence-row-1');
  await expect(second).toContainText('Retro notes');
  await expect(page.getByTestId('evidence-excerpt-1')).toContainText(
    'The staging retro flagged the rollback drill as the gap.',
  );
});

test('a concept without captured conversations states it plainly', async ({
  page,
}) => {
  await page
    .getByRole('button', { name: 'Node: Unsourced Hunch', exact: true })
    .click();

  await expect(page.getByText('Evidence · 0', { exact: true })).toBeVisible();
  await expect(page.getByTestId('text-evidence-empty')).toContainText(
    'No conversation evidence is attached to this concept yet.',
  );
  await expect(page.getByTestId('list-evidence')).toHaveCount(0);
});
