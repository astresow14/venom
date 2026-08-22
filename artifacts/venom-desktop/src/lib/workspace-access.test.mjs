import assert from 'node:assert/strict';
import test from 'node:test';

import { isWorkspaceAccessDeniedError } from './workspace-access.ts';

/**
 * The eviction predicate is the single decision point between "you were
 * removed — drop everything" and an ordinary failed request. The literals
 * below pin the wire contract with the api-server routes.
 */

test('membership loss matches: 403 with the access-denied code evicts', () => {
  assert.equal(
    isWorkspaceAccessDeniedError({
      status: 403,
      data: { code: 'workspace_access_denied' },
    }),
    true,
  );
});

test('an admin-required refusal never evicts — demotion is not removal', () => {
  assert.equal(
    isWorkspaceAccessDeniedError({
      status: 403,
      data: { code: 'workspace_admin_required' },
    }),
    false,
  );
});

test('other failures are ordinary errors, not access loss', () => {
  assert.equal(
    isWorkspaceAccessDeniedError({ status: 403, data: {} }),
    false,
  );
  assert.equal(isWorkspaceAccessDeniedError({ status: 403, data: null }), false);
  assert.equal(
    isWorkspaceAccessDeniedError({
      status: 500,
      data: { code: 'workspace_access_denied' },
    }),
    false,
  );
  assert.equal(isWorkspaceAccessDeniedError(new Error('network down')), false);
  assert.equal(isWorkspaceAccessDeniedError(null), false);
  assert.equal(isWorkspaceAccessDeniedError(undefined), false);
});
