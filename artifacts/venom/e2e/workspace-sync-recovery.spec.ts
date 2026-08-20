import { expect, test, type Page } from "@playwright/test";
import type { WorkspaceSyncTestHarness } from "../context/workspaceSyncTestHarness";

declare global {
  interface Window {
    __venomWorkspaceSyncTest?: WorkspaceSyncTestHarness;
  }
}

const initialUserId = "venom-ui-test";

function syncTestUrl() {
  return "/?venomUiTest=true&venomWorkspaceSyncTest=true";
}

async function addTaskThatChangesWorkspace(page: Page, title: string) {
  const boardTab = page.getByRole("tab", {
    name: "Open To-Do workspace",
  });
  await boardTab.click();
  await expect(page.getByText("Task Board", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add card to To Do" }).click();
  await page.getByLabel("New task title for To Do").fill(title);
  await page.getByRole("button", { name: "Add card", exact: true }).click();
  await expect(
    page.getByRole("button", { name: `Edit task ${title}` }),
  ).toBeVisible();
}

async function openSettings(page: Page) {
  await page.getByTestId("open-settings").click();
  await expect(
    page.getByText("Cloud backup", { exact: true }),
  ).toBeVisible();
  return page.getByTestId("cloud-sync-status");
}

test("recovers a failed workspace save and persists the latest device edit", async ({
  page,
}, testInfo) => {
  const taskTitle = `Recovery snapshot ${testInfo.project.name}`;
  await page.goto(syncTestUrl());
  await expect(page.getByTestId("open-settings")).toBeVisible();

  await page.evaluate(() => {
    window.__venomWorkspaceSyncTest?.failNextSaves(1);
  });
  await addTaskThatChangesWorkspace(page, taskTitle);

  const syncStatus = await openSettings(page);
  await expect(syncStatus).toHaveText("Retry needed");
  await expect(syncStatus).toHaveText("Synced", { timeout: 10_000 });

  const savedTaskTitles = await page.evaluate((userId) => {
    const snapshot = window.__venomWorkspaceSyncTest?.snapshots[userId];
    const state = snapshot?.state as {
      projects?: Array<{ tasks?: Array<{ title?: string }> }>;
    };
    return state.projects?.flatMap(
      (project) => project.tasks?.map((task) => task.title ?? "") ?? [],
    );
  }, initialUserId);
  expect(savedTaskTitles).toContain(taskTitle);
});

test("cancels a pending workspace retry when the signed-in account changes", async ({
  page,
}, testInfo) => {
  const taskTitle = `Cancelled retry ${testInfo.project.name}`;
  await page.goto(syncTestUrl());
  await expect(page.getByTestId("open-settings")).toBeVisible();

  await page.evaluate(() => {
    window.__venomWorkspaceSyncTest?.failNextSaves(1);
  });
  await addTaskThatChangesWorkspace(page, taskTitle);
  await page.waitForFunction(
    (userId) =>
      window.__venomWorkspaceSyncTest?.attempts.filter(
        (attempt) => attempt.userId === userId,
      ).length === 1,
    initialUserId,
  );

  await page.evaluate(() => {
    window.__venomWorkspaceSyncTest?.switchAccount(
      "venom-ui-test-after-account-switch",
    );
  });
  await page.waitForTimeout(1_500);

  const oldAccountActivity = await page.evaluate((userId) => {
    const harness = window.__venomWorkspaceSyncTest;
    return {
      attempts: harness?.attempts.filter((attempt) => attempt.userId === userId)
        .length,
      saved: Boolean(harness?.snapshots[userId]),
    };
  }, initialUserId);
  expect(oldAccountActivity).toEqual({ attempts: 1, saved: false });
});
