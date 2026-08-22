import { expect, test, type Page } from '@playwright/test';
import { stubWorkspaceApis } from './support/stubs';

const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const REPLY_ID = '22222222-2222-4222-8222-222222222222';
const PARENT_REPLY_ID = '33333333-3333-4333-8333-333333333333';
const AVAILABLE_NOTIFICATION_ID = '44444444-4444-4444-8444-444444444444';
const UNAVAILABLE_NOTIFICATION_ID = '55555555-5555-4555-8555-555555555555';
const OLDER_NOTIFICATION_ID = '66666666-6666-4666-8666-666666666666';

function threadDetail() {
  return {
    thread: {
      id: THREAD_ID,
      author: {
        id: '77777777-7777-4777-8777-777777777777',
        displayName: 'Morgan',
      },
      body: 'A community thread',
      summary: {
        text: '',
        status: 'pending',
        sourceRevision: 1,
        generatedAt: null,
        label: 'AI summary',
      },
      score: 0,
      replyCount: 2,
      viewerHasUpvoted: false,
      viewerIsAuthor: true,
      revision: 1,
      createdAt: '2026-08-20T10:00:00.000Z',
      updatedAt: '2026-08-20T10:00:00.000Z',
    },
    replies: [
      {
        id: PARENT_REPLY_ID,
        threadId: THREAD_ID,
        author: {
          id: '88888888-8888-4888-8888-888888888888',
          displayName: 'Morgan',
        },
        body: 'The parent reply',
        parentReplyId: null,
        viewerIsAuthor: true,
        createdAt: '2026-08-20T10:10:00.000Z',
        updatedAt: '2026-08-20T10:10:00.000Z',
      },
      {
        id: REPLY_ID,
        threadId: THREAD_ID,
        author: {
          id: '99999999-9999-4999-8999-999999999999',
          displayName: 'Alex',
        },
        body: 'The reply opened from notifications',
        parentReplyId: PARENT_REPLY_ID,
        viewerIsAuthor: false,
        createdAt: '2026-08-20T10:15:00.000Z',
        updatedAt: '2026-08-20T10:15:00.000Z',
      },
    ],
  };
}

async function stubThread(page: Page) {
  await page.route(`**/api/venom/community/threads/${THREAD_ID}**`, (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has('replyId')) {
      expect(url.searchParams.get('replyId')).toBe(REPLY_ID);
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(threadDetail()),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await stubWorkspaceApis(page);
  await stubThread(page);
});

test('reads, paginates, and opens the triggering reply', async ({ page }) => {
  const readAt = new Map<string, string | null>([
    [AVAILABLE_NOTIFICATION_ID, null],
    [UNAVAILABLE_NOTIFICATION_ID, null],
    [OLDER_NOTIFICATION_ID, '2026-08-19T12:00:00.000Z'],
  ]);

  const notification = (
    id: string,
    name: string,
    available: boolean,
    parentReplyId: string | null,
    replyId = REPLY_ID,
  ) => ({
    id,
    type: 'reply',
    actor: { displayName: name, avatarUrl: null },
    threadId: THREAD_ID,
    replyId,
    parentReplyId,
    available,
    createdAt:
      id === OLDER_NOTIFICATION_ID
        ? '2026-08-18T10:00:00.000Z'
        : '2026-08-20T10:30:00.000Z',
    readAt: readAt.get(id) ?? null,
  });

  await page.route('**/api/venom/community/notifications**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (request.method() === 'GET' && url.pathname.endsWith('/unread-count')) {
      const count = [...readAt.values()].filter((value) => value == null).length;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count }),
      });
      return;
    }

    if (
      request.method() === 'GET' &&
      url.pathname.endsWith('/community/notifications')
    ) {
      const cursor = url.searchParams.get('cursor');
      const payload = cursor
        ? {
            items: [
              notification(
                OLDER_NOTIFICATION_ID,
                'Riley',
                true,
                null,
                'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              ),
            ],
            nextCursor: null,
          }
        : {
            items: [
              notification(
                AVAILABLE_NOTIFICATION_ID,
                'Alex',
                true,
                PARENT_REPLY_ID,
              ),
              notification(
                UNAVAILABLE_NOTIFICATION_ID,
                'Taylor',
                false,
                null,
                'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              ),
            ],
            nextCursor: 'next-page',
          };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
      return;
    }

    if (request.method() === 'POST' && url.pathname.endsWith('/read-all')) {
      const now = new Date().toISOString();
      for (const id of readAt.keys()) readAt.set(id, now);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ marked: 1 }),
      });
      return;
    }

    const match = url.pathname.match(/notifications\/([^/]+)\/read$/);
    if (request.method() === 'POST' && match) {
      readAt.set(match[1], new Date().toISOString());
      const item =
        match[1] === AVAILABLE_NOTIFICATION_ID
          ? notification(
              AVAILABLE_NOTIFICATION_ID,
              'Alex',
              true,
              PARENT_REPLY_ID,
            )
          : notification(
              UNAVAILABLE_NOTIFICATION_ID,
              'Taylor',
              false,
              null,
              'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            );
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(item),
      });
      return;
    }

    await route.fallback();
  });

  await page.goto('/workspace/notifications');

  await expect(
    page.getByRole('link', { name: 'Notifications (2 unread)' }),
  ).toBeVisible();
  await expect(page.getByText('Alex replied to your reply.')).toBeVisible();
  await expect(
    page.getByText(
      'Taylor replied, but that reply is no longer available.',
    ),
  ).toBeVisible();

  await page
    .getByTestId(`button-unavailable-notification-${UNAVAILABLE_NOTIFICATION_ID}`)
    .click();
  await expect(
    page.getByRole('link', { name: 'Notifications (1 unread)' }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/workspace\/notifications$/);

  await page.getByTestId('button-load-more-notifications').click();
  await expect(page.getByText('Riley replied to your thread.')).toBeVisible();

  await page.getByTestId('button-mark-all-read').click();
  await expect(page.getByText('No unread notifications')).toBeVisible();
  await expect(page.getByTestId('button-mark-all-read')).toHaveCount(0);

  await page
    .getByTestId(`link-notification-${AVAILABLE_NOTIFICATION_ID}`)
    .click();
  await expect(page).toHaveURL(
    new RegExp(
      `/workspace/feed/thread/${THREAD_ID}\\?replyId=${REPLY_ID}#reply-${REPLY_ID}$`,
    ),
  );
  const openedReply = page.getByTestId(`card-reply-${REPLY_ID}`);
  await expect(openedReply).toBeVisible();
  await expect(openedReply).toBeFocused();
  await expect(openedReply).toHaveAccessibleName('Opened reply from Alex');
});

test('surfaces failing scheduled sources and clears their badge', async ({
  page,
}) => {
  const ALERT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  let alertReadAt: string | null = null;
  let alertReadAllCalls = 0;
  let communityReadAllCalls = 0;

  const alertPayload = () => ({
    alerts: [
      {
        id: ALERT_ID,
        sourceId: 'proj1-github-octocat-hello',
        projectId: 'proj1',
        provider: 'github',
        sourceName: 'octocat/hello',
        consecutiveFailures: 3,
        lastError:
          "Your GitHub connection isn't working, so this source can't update.",
        firstFailedAt: '2026-08-21T05:00:00.000Z',
        lastFailedAt: '2026-08-21T07:00:00.000Z',
        readAt: alertReadAt,
      },
    ],
  });

  await page.route('**/api/venom/sources/sync-alerts**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname.endsWith('/read-all')) {
      alertReadAllCalls += 1;
      alertReadAt = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ marked: 1 }),
      });
      return;
    }
    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(alertPayload()),
      });
      return;
    }
    await route.fallback();
  });

  await page.route('**/api/venom/community/notifications**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname.endsWith('/unread-count')) {
      // The server folds unread alerts into the same badge count.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: alertReadAt == null ? 1 : 0 }),
      });
      return;
    }
    if (
      request.method() === 'GET' &&
      url.pathname.endsWith('/community/notifications')
    ) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], nextCursor: null }),
      });
      return;
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/read-all')) {
      communityReadAllCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ marked: 0 }),
      });
      return;
    }
    await route.fallback();
  });

  await page.goto('/workspace/notifications');

  await expect(
    page.getByRole('link', { name: 'Notifications (1 unread)' }),
  ).toBeVisible();

  const alertCard = page.getByTestId(`alert-source-sync-${ALERT_ID}`);
  await expect(alertCard).toBeVisible();
  await expect(alertCard).toContainText(
    'Scheduled updates for octocat/hello keep failing',
  );
  await expect(alertCard).toContainText(
    'Reconnect GitHub or ask the workspace owner to restore access.',
  );
  await expect(alertCard).toContainText('3 failed attempts');
  await expect(alertCard).toContainText(
    "Your GitHub connection isn't working, so this source can't update.",
  );
  await expect(alertCard).toContainText('Unread');
  // An active alert suppresses the celebratory empty-state heading.
  await expect(
    page.getByRole('heading', { name: 'All caught up' }),
  ).toHaveCount(0);

  await page.getByTestId('button-mark-all-read').click();
  await expect(page.getByText('No unread notifications')).toBeVisible();
  await expect(page.getByTestId('button-mark-all-read')).toHaveCount(0);
  // Reading silences the badge; the alert itself stays until a sync succeeds.
  await expect(alertCard).toBeVisible();
  await expect(alertCard.getByText('Unread')).toHaveCount(0);
  expect(alertReadAllCalls).toBe(1);
  expect(communityReadAllCalls).toBe(1);
});

test('recovers from a failed inbox request into the empty state', async ({
  page,
}) => {
  let failing = true;
  await page.route('**/api/venom/community/notifications**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') {
      await route.fallback();
      return;
    }
    if (url.pathname.endsWith('/unread-count')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0 }),
      });
      return;
    }
    await route.fulfill({
      status: failing ? 503 : 200,
      contentType: 'application/json',
      body: JSON.stringify(
        failing
          ? { error: 'temporarily unavailable' }
          : { items: [], nextCursor: null },
      ),
    });
  });

  await page.goto('/workspace/notifications');
  await expect(
    page.getByText('Notifications could not be loaded.'),
  ).toBeVisible();

  failing = false;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('heading', { name: 'All caught up' })).toBeVisible();
});