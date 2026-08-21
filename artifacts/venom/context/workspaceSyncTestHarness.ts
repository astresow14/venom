import type { VenomWorkspaceState } from "@workspace/api-client-react";
import { Platform } from "react-native";

type WorkspaceSyncTestSnapshot = {
  state: VenomWorkspaceState;
  revision: number;
  updatedAt: string;
};

type WorkspaceSyncTestAttempt = {
  userId: string;
  state: VenomWorkspaceState;
  baseRevision: number;
};

export type WorkspaceSyncTestHarness = {
  attempts: WorkspaceSyncTestAttempt[];
  snapshots: Record<string, WorkspaceSyncTestSnapshot>;
  failNextSaves: (count: number) => void;
  switchAccount: (userId: string) => void;
  /**
   * Replaces the cloud snapshot an account restores from, so a test can stand
   * in for what another device left behind. Saved snapshots survive a reload,
   * which is what lets a test exercise the signed-in restore path.
   */
  seedSnapshot: (userId: string, state: VenomWorkspaceState) => void;
};

type WorkspaceSyncTestGlobal = typeof globalThis & {
  __venomWorkspaceSyncTest?: WorkspaceSyncTestHarness;
};

function queryParam(name: string) {
  if (typeof globalThis.location?.search !== "string") return null;
  return new URLSearchParams(globalThis.location.search).get(name);
}

export const IS_WORKSPACE_SYNC_UI_TEST =
  __DEV__ &&
  Platform.OS === "web" &&
  typeof globalThis.location?.search === "string" &&
  queryParam("venomWorkspaceSyncTest") === "true";

export const WORKSPACE_SYNC_UI_TEST_USER_ID =
  queryParam("venomWorkspaceTestUser") ?? "venom-ui-test";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Where the fake cloud lives between page loads. The real cloud outlives a
 * reload, so a harness that only kept snapshots in memory could never stand in
 * for the signed-in restore path.
 */
const SNAPSHOT_STORAGE_KEY = "@venom_workspace_sync_test_cloud";

function readPersistedSnapshots(): Record<string, WorkspaceSyncTestSnapshot> {
  try {
    const raw = globalThis.localStorage?.getItem(SNAPSHOT_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, WorkspaceSyncTestSnapshot>;
  } catch {
    return {};
  }
}

function persistSnapshots(
  snapshots: Record<string, WorkspaceSyncTestSnapshot>,
) {
  try {
    globalThis.localStorage?.setItem(
      SNAPSHOT_STORAGE_KEY,
      JSON.stringify(snapshots),
    );
  } catch {
    // The fake cloud is best-effort; a storage failure must not break the app.
  }
}

function createHarness(): WorkspaceSyncTestHarness {
  let failuresRemaining = Math.max(
    0,
    Number.parseInt(queryParam("venomWorkspaceSaveFailures") ?? "0", 10) || 0,
  );
  const harness: WorkspaceSyncTestHarness = {
    attempts: [],
    snapshots: readPersistedSnapshots(),
    failNextSaves(count) {
      failuresRemaining = Math.max(0, Math.floor(count));
    },
    switchAccount(userId) {
      globalThis.dispatchEvent(
        new CustomEvent("venom-workspace-sync-test-account-change", {
          detail: { userId },
        }),
      );
    },
    seedSnapshot(userId, state) {
      harness.snapshots[userId] = {
        state: clone(state),
        revision: (harness.snapshots[userId]?.revision ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      persistSnapshots(harness.snapshots);
    },
  };

  Object.defineProperty(harness, "consumeFailure", {
    enumerable: false,
    value: () => {
      if (failuresRemaining <= 0) return false;
      failuresRemaining -= 1;
      return true;
    },
  });

  return harness;
}

function harness() {
  const testGlobal = globalThis as WorkspaceSyncTestGlobal;
  if (!testGlobal.__venomWorkspaceSyncTest) {
    testGlobal.__venomWorkspaceSyncTest = createHarness();
  }
  return testGlobal.__venomWorkspaceSyncTest;
}

export function initializeWorkspaceSyncTestHarness() {
  if (!IS_WORKSPACE_SYNC_UI_TEST) return;
  harness();
}

export async function saveWorkspaceForSyncTest(
  userId: string,
  state: VenomWorkspaceState,
  baseRevision: number,
) {
  const testHarness = harness();
  testHarness.attempts.push({
    userId,
    state: clone(state),
    baseRevision,
  });

  const consumeFailure = (
    testHarness as WorkspaceSyncTestHarness & {
      consumeFailure: () => boolean;
    }
  ).consumeFailure;
  if (consumeFailure()) {
    throw new Error(
      "Workspace sync test harness intentionally rejected this save.",
    );
  }

  const previous = testHarness.snapshots[userId];
  const saved = {
    state: clone(state),
    revision: Math.max(baseRevision, previous?.revision ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  testHarness.snapshots[userId] = saved;
  persistSnapshots(testHarness.snapshots);
  return saved;
}

/**
 * The cloud snapshot a signed-in restore reads, or null when this account has
 * never saved. Mirrors the shape the workspace endpoint returns so the test
 * mode can run the same hydration the real sign-in runs.
 */
export function loadWorkspaceForSyncTest(
  userId: string,
): WorkspaceSyncTestSnapshot | null {
  return harness().snapshots[userId] ?? null;
}
