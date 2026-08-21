import { expect, test } from '@playwright/test';
import { stubWorkspaceApis } from './support/stubs';

/**
 * Inline citation markers in the desktop workspace.
 *
 * Assistant answers, Brain note summaries, and feed entries store machine
 * markers like `[source:cite_xyz]`. A reader must never see one: a live
 * citation reads as its source title (and links to the document), a citation
 * retired by a refresh reads as its archived reference, and a marker nothing
 * knows about falls back to the generic archived label.
 *
 * Mirrors the mobile suite (artifacts/venom/e2e/brain-citations.spec.ts); the
 * workspace is seeded through the local mirror UI-test mode reads at startup.
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
      id: 'conv_alpha',
      title: 'Launch prep',
      projectId: 'proj_alpha',
      updatedAt: NOW,
      messages: [
        {
          id: 'msg_question',
          role: 'user',
          content: 'Where do the launch steps live?',
          createdAt: NOW - 60_000,
          status: 'sent',
        },
        {
          id: 'msg_answer',
          role: 'assistant',
          content:
            'The launch steps live in [source:cite_readme]. The retired checklist was [source:cite_retired], and one aside cites [source:cite_unknown].',
          createdAt: NOW - 30_000,
          status: 'sent',
          modelId: 'venom-gpt',
          modelName: 'Venom GPT',
        },
      ],
    },
  ],
  clusters: [
    {
      id: 'cl_launch',
      projectId: 'proj_alpha',
      label: 'Launch Ops',
      category: 'core',
      strength: 0.8,
      x: 40,
      y: 30,
      links: [],
      description: 'Launch knowledge saved by Venom.',
      summary:
        'Deploy guidance comes from [source:cite_readme]; the retired checklist [source:cite_retired] still informs [source:cite_unknown].',
      mentionCount: 2,
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
  archivedCitations: [
    {
      id: 'cite_retired',
      title: 'Rollout checklist',
      url: 'https://github.com/acme/venom/blob/main/CHECKLIST.md',
      retiredAt: NOW - 120_000,
    },
  ],
  activeProjectId: 'proj_alpha',
  activeConversationId: 'conv_alpha',
};

test.beforeEach(async ({ page }) => {
  await stubWorkspaceApis(page);
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, value),
    { key: STORAGE_KEY, value: JSON.stringify(WORKSPACE_STATE) },
  );
});

test('a cited chat answer reads as source references, never raw markers', async ({
  page,
}) => {
  await page.goto('/workspace/chat');

  const answer = page.getByTestId('message-assistant');
  await expect(answer).toBeVisible();

  // Live citation: the source title, linking to the cited document.
  const liveLink = answer.getByTestId('citation-link-cite_readme');
  await expect(liveLink).toHaveText('README.md');
  await expect(liveLink).toHaveAttribute(
    'href',
    'https://github.com/acme/venom/blob/main/README.md',
  );

  // A citation retired by a refresh keeps its title as an archived reference;
  // one nothing knows about falls back to the generic archived label.
  await expect(answer).toContainText('Rollout checklist (archived)');
  await expect(answer).toContainText('(archived source)');

  // The machine marker itself never reaches the reader.
  await expect(page.locator('body')).not.toContainText('[source:');
});

test('a Brain note summary resolves markers to source names', async ({
  page,
}) => {
  await page.goto('/workspace/brain');

  await page
    .getByRole('button', { name: 'Node: Launch Ops', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Launch Ops' })).toBeVisible();

  // The Data Profile paragraph is the stored summary with every marker
  // resolved: live title, archived title, then the generic archived label.
  await expect(page.getByText(/^Deploy guidance comes from/)).toHaveText(
    'Deploy guidance comes from README.md; the retired checklist Rollout checklist (archived) still informs (archived source).',
  );
  await expect(page.locator('body')).not.toContainText('[source:');
});

test('a feed entry never shows a raw marker even when the server text carries one', async ({
  page,
}) => {
  const appId = 'a0000000-0000-4000-8000-000000000002';
  await page.route('**/venom/apps', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: appId,
          name: 'Field Guide',
          brand: 'Venom Labs',
          status: 'active',
          description: 'Companion site fed by the Aurora project.',
          linkedProjectId: 'proj_alpha',
          linkedProjectName: 'Aurora Systems',
          latestIterationNumber: 1,
          improvementSignal: {
            summary:
              'Aurora Systems absorbed 2 new concepts (topics: Launch Ops, [source:cite_unknown]) since package v1.',
            baselineIterationNumber: 1,
            knowledgeChanges: 2,
            sourceChanges: 0,
            computedAt: new Date(NOW).toISOString(),
          },
        },
      ]),
    }),
  );

  await page.goto('/workspace/feed');

  const card = page.getByTestId(`card-suggestion-${appId}`);
  await expect(card).toBeVisible();
  await expect(card).toContainText('2 new concepts');
  // The stray marker resolves to the archived reference, not the raw tag.
  await expect(card).toContainText('(archived source)');
  await expect(page.locator('body')).not.toContainText('[source:');
});
