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

function createHarness(): WorkspaceSyncTestHarness {
  let failuresRemaining = Math.max(
    0,
    Number.parseInt(queryParam("venomWorkspaceSaveFailures") ?? "0", 10) || 0,
  );
  const harness: WorkspaceSyncTestHarness = {
    attempts: [],
    snapshots: {},
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
  return saved;
}
