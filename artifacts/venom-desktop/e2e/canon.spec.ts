import { expect, test, type Page } from '@playwright/test';
import { mockChatStream } from './support/chat-stream';
import { stubJsonGet, stubWorkspaceApis } from './support/stubs';

const DESKTOP = { width: 1280, height: 860 };

/** Must match UI_TEST_USER_ID in src/context/VenomWorkspaceContext.tsx. */
const SELF_USER_ID = 'venom-desktop-ui-test';

const ADMIN_IDENTITY = {
  displayName: 'Steward',
  email: 'steward@example.com',
  provider: 'google',
  superAdmin: true,
};

const REGULAR_IDENTITY = {
  displayName: 'Visitor',
  email: 'visitor@example.com',
  provider: 'google',
  superAdmin: false,
};

const TEACHING = {
  id: 'canon-t1',
  domain: 'branding',
  title: 'Core branding principles',
  principles: ['Own one word in the mind.', 'Consistency beats reach.'],
  status: 'active',
  taughtByUserId: SELF_USER_ID,
  taughtByName: 'Steward',
  taughtAt: '2026-08-20T10:00:00.000Z',
  conversationId: 'conv-branding',
  conversationTitle: 'Branding notes',
};

const SONGWRITING_TEACHING = {
  ...TEACHING,
  id: 'canon-t2',
  domain: 'songwriting',
  title: 'Hooks come first',
  principles: ['Write the chorus before the verse.'],
  conversationTitle: null,
};

const ADMINS = [
  {
    userId: SELF_USER_ID,
    name: 'Steward',
    grantedByUserId: null,
    grantedAt: '2026-08-01T00:00:00.000Z',
  },
  {
    userId: 'user-second',
    name: 'Second Steward',
    grantedByUserId: SELF_USER_ID,
    grantedAt: '2026-08-10T00:00:00.000Z',
  },
];

const DRAFT = {
  domain: 'branding',
  title: 'Core branding principles',
  principles: ['Own one word in the mind.', 'Consistency beats reach.'],
};

const TEACH_MESSAGE =
  'Store these as core branding principles: own one word in the mind; consistency beats reach.';

/** Counts requests to an API path without interfering with routing. */
function countRequests(page: Page, needle: string) {
  const counter = { count: 0 };
  page.on('request', (request) => {
    if (request.url().includes(needle)) counter.count += 1;
  });
  return counter;
}

async function openChat(page: Page) {
  await page.goto('/workspace/chat');
  await expect(page.getByTestId('form-composer')).toBeVisible();
}

test.use({ viewport: DESKTOP });

test.describe('canon management surface', () => {
  test('a super admin gets the nav entry, the canon by domain, and working retire', async ({
    page,
  }) => {
    await stubWorkspaceApis(page);
    await stubJsonGet(page, '**/venom/identity', ADMIN_IDENTITY);
    await stubJsonGet(page, '**/venom/canon/admins', ADMINS);

    // Teachings live in a mutable fixture so a PATCH is visible on refetch.
    let teachings = [TEACHING, SONGWRITING_TEACHING];
    const patchBodies: unknown[] = [];
    await page.route('**/venom/canon/teachings**', async (route) => {
      const method = route.request().method();
      if (method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(teachings),
        });
        return;
      }
      if (method === 'PATCH') {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        patchBodies.push(body);
        teachings = teachings.map((entry) =>
          route.request().url().includes(entry.id)
            ? { ...entry, ...body }
            : entry,
        );
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            teachings.find((entry) => route.request().url().includes(entry.id)),
          ),
        });
        return;
      }
      await route.fallback();
    });

    await openChat(page);

    // The gated nav entry exists for the admin and leads to the canon.
    const navCanon = page.getByTestId('link-nav-canon');
    await expect(navCanon).toBeVisible();
    await navCanon.click();
    await expect(page).toHaveURL(/\/workspace\/canon$/);
    await expect(page.getByTestId('canon-page')).toBeVisible();

    // Grouped by skill domain, with provenance on each entry.
    await expect(page.getByTestId('canon-domain-branding')).toBeVisible();
    await expect(page.getByTestId('canon-domain-songwriting')).toBeVisible();
    const brandingCard = page.getByTestId('canon-teaching-canon-t1');
    await expect(brandingCard).toContainText('Core branding principles');
    await expect(brandingCard).toContainText('Own one word in the mind.');
    await expect(brandingCard).toContainText('Taught by Steward');
    await expect(brandingCard).toContainText('from "Branding notes"');

    // Stewards: the original one is labeled, self has no revoke button.
    await expect(page.getByTestId(`canon-admin-${SELF_USER_ID}`)).toContainText(
      'Original steward',
    );
    await expect(
      page.getByTestId(`canon-revoke-${SELF_USER_ID}`),
    ).toHaveCount(0);
    await expect(page.getByTestId('canon-revoke-user-second')).toBeVisible();

    // Retire round-trips through PATCH and re-renders as retired.
    await page.getByTestId('canon-toggle-canon-t1').click();
    await expect(brandingCard).toContainText('retired');
    await expect(page.getByTestId('canon-toggle-canon-t1')).toContainText(
      'Restore',
    );
    expect(patchBodies).toEqual([{ status: 'retired' }]);
  });

  test('everyone else sees no entry point and a dead end, and no canon API is ever called', async ({
    page,
  }) => {
    await stubWorkspaceApis(page);
    await stubJsonGet(page, '**/venom/identity', REGULAR_IDENTITY);
    const canonCalls = countRequests(page, '/venom/canon/');

    await openChat(page);
    await expect(page.getByTestId('link-nav-company')).toBeVisible();
    await expect(page.getByTestId('link-nav-canon')).toHaveCount(0);

    // Typing the URL by hand earns a dead end, not a canon shell.
    await page.goto('/workspace/canon');
    await expect(page.getByTestId('canon-denied')).toBeVisible();
    await expect(page.getByTestId('canon-denied')).toContainText(
      "There's nothing here.",
    );
    await expect(page.getByTestId('canon-page')).toHaveCount(0);
    expect(canonCalls.count).toBe(0);
  });
});

test.describe('teaching from chat', () => {
  test('a super admin teach message becomes a confirmation card, and confirming commits with an acknowledgment', async ({
    page,
  }) => {
    await stubWorkspaceApis(page);
    await stubJsonGet(page, '**/venom/identity', ADMIN_IDENTITY);
    await mockChatStream(page, ['This answer should never appear.']);
    const respondCalls = countRequests(page, '/venom/respond');

    await page.route('**/venom/canon/propose', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ teachIntent: true, draft: DRAFT }),
      });
    });
    const commitBodies: Array<Record<string, unknown>> = [];
    await page.route('**/venom/canon/teachings**', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      commitBodies.push(
        route.request().postDataJSON() as Record<string, unknown>,
      );
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          teaching: {
            ...TEACHING,
            id: 'canon-created',
          },
          acknowledgment:
            'Held. Branding lives in our canon now — every answer draws on it.',
        }),
      });
    });

    await openChat(page);
    // The teach gate only arms once the identity flag has loaded.
    await expect(page.getByTestId('link-nav-canon')).toBeVisible();

    const composer = page.getByTestId('input-message');
    await composer.fill(TEACH_MESSAGE);
    await composer.press('Enter');

    // The admin's message files as an ordinary user turn…
    await expect(
      page.getByText('Store these as core branding principles', {
        exact: false,
      }),
    ).toBeVisible();
    // …and the card shows exactly what is about to become canon.
    const card = page.getByTestId('canon-teach-card');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('canon-teach-title')).toHaveText(
      'Core branding principles',
    );
    await expect(card).toContainText('branding');
    await expect(card).toContainText('Own one word in the mind.');
    await expect(card).toContainText('Consistency beats reach.');

    await page.getByTestId('canon-teach-confirm').click();

    // Venom acknowledges in its own voice as a normal assistant turn.
    await expect(
      page.getByText('Held. Branding lives in our canon now', { exact: false }),
    ).toBeVisible();
    await expect(card).toHaveCount(0);
    expect(commitBodies).toHaveLength(1);
    expect(commitBodies[0]).toMatchObject({
      domain: 'branding',
      title: 'Core branding principles',
      principles: DRAFT.principles,
    });
    // The teach turn never streamed a model answer.
    expect(respondCalls.count).toBe(0);
    await expect(
      page.getByText('This answer should never appear.'),
    ).toHaveCount(0);
  });

  test('"Just chat" discards the draft and the same message gets its ordinary answer', async ({
    page,
  }) => {
    await stubWorkspaceApis(page);
    await stubJsonGet(page, '**/venom/identity', ADMIN_IDENTITY);
    await mockChatStream(page, ['Here is a normal answer instead.']);
    await page.route('**/venom/canon/propose', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ teachIntent: true, draft: DRAFT }),
      });
    });

    await openChat(page);
    await expect(page.getByTestId('link-nav-canon')).toBeVisible();

    const composer = page.getByTestId('input-message');
    await composer.fill(TEACH_MESSAGE);
    await composer.press('Enter');

    await expect(page.getByTestId('canon-teach-card')).toBeVisible();
    await page.getByTestId('canon-teach-cancel').click();

    await expect(page.getByTestId('canon-teach-card')).toHaveCount(0);
    await expect(
      page.getByText('Here is a normal answer instead.'),
    ).toBeVisible();
  });

  test('a regular user saying the same words just chats — propose is never called', async ({
    page,
  }) => {
    await stubWorkspaceApis(page);
    await stubJsonGet(page, '**/venom/identity', REGULAR_IDENTITY);
    await mockChatStream(page, ['Filed to your Brain, nothing more.']);
    const proposeCalls = countRequests(page, '/venom/canon/propose');

    await openChat(page);
    // Identity resolves (no canon entry appears for this account).
    await expect(page.getByTestId('link-nav-company')).toBeVisible();

    const composer = page.getByTestId('input-message');
    await composer.fill(TEACH_MESSAGE);
    await composer.press('Enter');

    await expect(
      page.getByText('Filed to your Brain, nothing more.'),
    ).toBeVisible();
    await expect(page.getByTestId('canon-teach-card')).toHaveCount(0);
    expect(proposeCalls.count).toBe(0);
  });
});
