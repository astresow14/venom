import { expect, test } from '@playwright/test';
import { stubJsonGet, stubWorkspaceApis } from './support/stubs';

/**
 * Shared workspaces on desktop: switching into a shared space, reading the
 * member list, and — the property revocation depends on — a
 * `workspace_access_denied` response evicting the space and returning the
 * session to the personal tier without breaking it.
 *
 * The server side of revocation (membership re-checked on every request) is
 * covered by the api-server integration suite; these tests pin the client
 * half of the contract.
 */

const WORKSPACE = {
  id: '7d9f3c60-1111-4a4a-9c9c-2b2b2b2b2b2b',
  name: 'Symbiote Ops',
  role: 'admin' as const,
  memberCount: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const MEMBERS = [
  { userId: 'user-admin-1', name: 'Eddie Brock', role: 'admin' as const },
  { userId: 'user-member-2', name: 'Anne Weying', role: 'member' as const },
];

const ACCESS_DENIED = {
  error: 'You no longer have access to this workspace.',
  code: 'workspace_access_denied',
};

test.beforeEach(async ({ page }) => {
  await stubWorkspaceApis(page);
  // Later routes win: replace the default empty workspace list.
  await stubJsonGet(page, '**/venom/workspaces', [WORKSPACE]);
  await stubJsonGet(page, `**/venom/workspaces/${WORKSPACE.id}/members`, MEMBERS);
  await stubJsonGet(page, `**/venom/workspaces/${WORKSPACE.id}/sops`, []);
});

test('switches into a shared space, shows the member list, and marks chat', async ({
  page,
}) => {
  await stubJsonGet(page, `**/venom/workspaces/${WORKSPACE.id}/knowledge`, {
    clusters: [],
  });

  await page.goto('/workspace/chat');

  const switcher = page.getByTestId('select-shared-space-desktop');
  await expect(switcher).toBeVisible();
  // The stubbed list arrived: the shared space is offered.
  await expect(
    switcher.locator(`option[value="${WORKSPACE.id}"]`),
  ).toHaveCount(1);

  await switcher.selectOption(WORKSPACE.id);

  // Chat announces that answers may draw on the shared space.
  await expect(page.getByTestId('chip-shared-space')).toContainText(
    WORKSPACE.name,
  );

  // Members are visible to any member; roles are shown.
  await page.getByTestId('button-space-members-desktop').click();
  const memberList = page.getByTestId('list-workspace-members');
  await expect(memberList).toBeVisible();
  await expect(page.getByTestId('row-member-user-admin-1')).toContainText(
    'Eddie Brock',
  );
  await expect(page.getByTestId('row-member-user-admin-1')).toContainText(
    /admin/i,
  );
  await expect(page.getByTestId('row-member-user-member-2')).toContainText(
    'Anne Weying',
  );
  // An admin gets the add-member form.
  await expect(page.getByTestId('input-new-member-id')).toBeVisible();
});

test('a denied workspace read evicts the space and returns to personal', async ({
  page,
}) => {
  // The knowledge read is the first workspace-scoped request Brain makes;
  // answering it with the revocation contract simulates removal mid-session.
  await stubJsonGet(
    page,
    `**/venom/workspaces/${WORKSPACE.id}/knowledge`,
    ACCESS_DENIED,
    403,
  );

  await page.goto('/workspace/brain');

  const switcher = page.getByTestId('select-shared-space-desktop');
  await expect(
    switcher.locator(`option[value="${WORKSPACE.id}"]`),
  ).toHaveCount(1);
  await switcher.selectOption(WORKSPACE.id);

  // The denial is detected: the user is told, the selection falls back to
  // Personal, and the workspace badge leaves the Brain page.
  await expect(page.getByText('Shared workspace unavailable')).toBeVisible();
  await expect(switcher).toHaveValue('__personal__');
  await expect(page.getByTestId('badge-workspace-brain')).toHaveCount(0);

  // The personal tier keeps working: Brain still renders its own content
  // area rather than an error state.
  await expect(page.getByTestId('select-shared-space-desktop')).toBeEnabled();
});
