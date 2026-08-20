import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKSPACE_SYNC_RETRY_MAX_DELAY_MS,
  workspaceSyncRetryDelay,
} from "./workspaceSyncRetry.ts";

test("workspace save retries use exponential backoff with a capped delay", () => {
  assert.deepEqual(
    [0, 1, 2, 3].map(workspaceSyncRetryDelay),
    [1_000, 2_000, 4_000, 8_000],
  );
  assert.equal(workspaceSyncRetryDelay(100), WORKSPACE_SYNC_RETRY_MAX_DELAY_MS);
  assert.equal(workspaceSyncRetryDelay(-1), 1_000);
});