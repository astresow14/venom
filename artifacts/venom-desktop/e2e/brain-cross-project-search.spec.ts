import { expect, test } from '@playwright/test';

/**
 * Cross-project ontology search from the Brain page.
 *
 * In UI-test mode the page skips the server lookup entirely and answers from
 * the on-device workspace copy, so the whole flow runs without network stubs.
 * The workspace is seeded through the same local mirror a signed-in account
 * keeps (`readLocalState`), which UI-test mode reads at startup.
 */

const STORAGE_KEY = '@venom_desktop_v1:venom-desktop-ui-test';
const NOW = 1_755_600_000_000; // fixed timestamp keeps the seed deterministic

type SeedCluster = {
  id: string;
  projectId: string;
  label: string;
  summary: string;
  category: string;
  links?: string[];
  x: number;
  y: number;
};

function cluster({ links = [], ...rest }: SeedCluster) {
  return {
    ...rest,
    links,
    description: rest.summary,
    strength: 0.8,
    mentionCount: 1,
    lastUpdatedAt: NOW,
    sources: [],
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
    {
      id: 'proj_beta',
      name: 'Beacon Ops',
      description: 'Field operations workspace',
      accent: '#e5e5e5',
      sourceCount: 0,
      updatedAt: NOW,
    },
  ],
  conversations: [
    {
      id: 'conv_alpha',
      title: 'Alpha planning',
      projectId: 'proj_alpha',
      updatedAt: NOW,
      messages: [],
    },
  ],
  clusters: [
    cluster({
      id: 'cl_alpha_tower',
      projectId: 'proj_alpha',
      label: 'Signal Tower',
      summary: 'Radio relay coverage for the northern research sites.',
      category: 'core',
      links: ['cl_alpha_launch'],
      x: 50,
      y: 50,
    }),
    cluster({
      id: 'cl_alpha_launch',
      projectId: 'proj_alpha',
      label: 'Launch Notes',
      summary: 'Checklist and observations from the field launches.',
      category: 'tactical',
      links: ['cl_alpha_tower'],
      x: 140,
      y: -40,
    }),
    cluster({
      id: 'cl_alpha_field',
      projectId: 'proj_alpha',
      label: 'Field Reports',
      summary: 'Weekly reports gathered by the survey teams.',
      category: 'memory',
      x: -90,
      y: 70,
    }),
    cluster({
      id: 'cl_beta_signal',
      projectId: 'proj_beta',
      label: 'Signal Protocol',
      summary: 'How beacon crews encode and rotate their transmissions.',
      category: 'core',
      links: ['cl_beta_handbook'],
      x: 60,
      y: 40,
    }),
    cluster({
      id: 'cl_beta_handbook',
      projectId: 'proj_beta',
      label: 'Beacon Handbook',
      summary: 'Operating guide for beacon field crews.',
      category: 'memory',
      links: ['cl_beta_signal'],
      x: -70,
      y: -60,
    }),
  ],
  sources: [],
  activeProjectId: 'proj_alpha',
  activeConversationId: 'conv_alpha',
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, value),
    { key: STORAGE_KEY, value: JSON.stringify(WORKSPACE_STATE) },
  );
});

test('surfaces another project\'s concept and jumps to it', async ({
  page,
}) => {
  await page.goto('/workspace/brain');

  // The map shows the active project only; the other project's concept is
  // neither a node nor reachable any other way yet.
  await expect(
    page.getByRole('region', { name: /Knowledge map with 3 nodes/ }),
  ).toBeVisible();
  await expect(page.getByTestId('select-project-desktop')).toHaveValue(
    'proj_alpha',
  );
  await expect(
    page.getByRole('button', { name: 'Node: Signal Protocol', exact: true }),
  ).toHaveCount(0);

  const searchInput = page.getByLabel('Search map');
  const panel = page.getByTestId('brain-cross-project-results');

  // Below two characters the search does not run at all.
  await searchInput.fill('s');
  await expect(panel).toHaveCount(0);

  // A term that only matches the active project stays on the map: the panel
  // exists solely for concepts the map cannot show.
  await searchInput.fill('launch');
  await expect(panel).toHaveCount(0);

  // A term that matches both projects lists only the other project's concept.
  await searchInput.fill('signal');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Beyond this map');
  const betaRow = page.getByTestId('brain-search-result-cl_beta_signal');
  await expect(betaRow).toContainText('Signal Protocol');
  await expect(betaRow).toContainText('Beacon Ops');
  await expect(panel).not.toContainText('Signal Tower');
  await expect(
    panel.locator('[data-testid^="brain-search-result-"]'),
  ).toHaveCount(1);

  await betaRow.click();

  // Selection switches the workspace to the concept's project and opens its
  // detail pane on the now-active map.
  await expect(page.getByTestId('select-project-desktop')).toHaveValue(
    'proj_beta',
  );
  await expect(
    page.getByRole('region', { name: /Knowledge map with 2 nodes/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Signal Protocol' }),
  ).toBeVisible();
  await expect(page.getByLabel('Close details')).toBeVisible();

  // The jump consumed the query: the field clears and the panel closes.
  await expect(searchInput).toHaveValue('');
  await expect(panel).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Node: Signal Protocol', exact: true }),
  ).toBeVisible();
});
