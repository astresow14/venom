import { expect, test } from '@playwright/test';
import { stubJsonGet, stubWorkspaceApis } from './support/stubs';

/**
 * Shared workspaces on desktop are management-only (Task #281): the sidebar
 * opens a workspace manager for memberships and members, the Brain page
 * carries the per-workspace knowledge filter, and — the property revocation
 * depends on — a `workspace_access_denied` response evicting every cached
 * workspace read and falling the Brain filter back to Personal.
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

test('the workspace manager lists memberships and opens the member list', async ({
  page,
}) => {
  await page.goto('/workspace/chat');

  // Chats can explicitly name their space; management remains available from
  // the same sidebar.
  await expect(page.getByTestId('select-shared-space-desktop')).toBeVisible();

  await page.getByTestId('button-workspace-manager-desktop').click();
  const manager = page.getByTestId('workspace-manager');
  await expect(manager).toBeVisible();
  await expect(
    page.getByTestId(`workspace-manager-row-${WORKSPACE.id}`),
  ).toContainText(WORKSPACE.name);

  await page.getByTestId(`button-workspace-members-${WORKSPACE.id}`).click();

  // Members are visible to any member; roles are shown.
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

test('an admin changes a member role in place and the list refreshes', async ({
  page,
}) => {
  // Mutable member fixtures: the PATCH stub updates them, so the refetch
  // after the mutation serves the new role — the same row, never removed.
  const members: Array<{
    userId: string;
    name: string;
    role: 'admin' | 'member';
  }> = MEMBERS.map((member) => ({ ...member }));
  await stubJsonGet(
    page,
    `**/venom/workspaces/${WORKSPACE.id}/members`,
    members,
  );

  let patchBody: unknown = null;
  await page.route(
    `**/venom/workspaces/${WORKSPACE.id}/members/user-member-2`,
    async (route) => {
      if (route.request().method() !== 'PATCH') {
        await route.fallback();
        return;
      }
      patchBody = route.request().postDataJSON();
      const target = members.find(
        (member) => member.userId === 'user-member-2',
      );
      if (target) target.role = (patchBody as { role: 'admin' | 'member' }).role;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...target,
          addedAt: '2026-01-02T00:00:00.000Z',
        }),
      });
    },
  );

  await page.goto('/workspace/chat');
  await page.getByTestId('button-workspace-manager-desktop').click();
  await page.getByTestId(`button-workspace-members-${WORKSPACE.id}`).click();

  const roleSelect = page.getByTestId('select-member-role-user-member-2');
  await expect(roleSelect).toContainText(/member/i);

  await roleSelect.click();
  await page.getByRole('option', { name: 'Admin' }).click();

  // The list refreshed in place: same row, new role, nobody kicked out.
  await expect(roleSelect).toContainText(/admin/i);
  await expect(page.getByTestId('row-member-user-member-2')).toContainText(
    'Anne Weying',
  );
  expect(patchBody).toEqual({ role: 'admin' });
});

test('an admin-required refusal does not evict the workspace', async ({
  page,
}) => {
  // What a freshly demoted admin's device sees: an admin-only read (the
  // settings query behind the members dialog) refusing with the
  // admin-required code. Unlike `workspace_access_denied`, this must NOT
  // trigger the eviction routine — demotion is not removal.
  await page.route(
    `**/venom/workspaces/${WORKSPACE.id}/settings`,
    async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Only a workspace admin can do this.',
          code: 'workspace_admin_required',
        }),
      });
    },
  );

  await page.goto('/workspace/chat');
  await page.getByTestId('button-workspace-manager-desktop').click();
  await page.getByTestId(`button-workspace-members-${WORKSPACE.id}`).click();

  // Member-level content still renders and no eviction fires — the demoted
  // admin is not kicked out.
  await expect(page.getByTestId('row-member-user-member-2')).toContainText(
    'Anne Weying',
  );
  await expect(page.getByText('Shared workspace unavailable')).toHaveCount(0);
});

test('a denied workspace read evicts the space and returns Brain to Personal', async ({
  page,
}) => {
  // The workspace knowledge read is the first workspace-scoped request the
  // Brain filter makes; answering it with the revocation contract simulates
  // removal mid-session. After eviction the membership list refetch shows
  // the server's truth: the workspace is gone.
  let denied = false;
  await page.route('**/venom/workspaces', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(denied ? [] : [WORKSPACE]),
    });
  });
  await page.route(
    `**/venom/workspaces/${WORKSPACE.id}/knowledge`,
    async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      denied = true;
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify(ACCESS_DENIED),
      });
    },
  );

  await page.goto('/workspace/brain');

  const workspaceLayer = page.getByTestId(
    `brain-layer-workspace-${WORKSPACE.id}`,
  );
  await expect(workspaceLayer).toBeVisible();
  await workspaceLayer.click();

  // The denial is detected: the user is told, the workspace leaves the
  // filter bar, and the Brain filter falls back to Personal. (`exact` keeps
  // the locator off Radix's transient aria-live announcement copy.)
  await expect(
    page.getByText('Shared workspace unavailable', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByTestId(`brain-layer-workspace-${WORKSPACE.id}`),
  ).toHaveCount(0);
  await expect(page.getByTestId('brain-layer-personal')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByTestId('badge-workspace-brain')).toHaveCount(0);

  // The personal tier keeps working: the layer switcher still renders
  // rather than an error state.
  await expect(page.getByTestId('brain-layer-switcher')).toBeVisible();
});
