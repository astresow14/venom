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

/**
 * Enough of the chat backend to send a message without a live model: the
 * answer's content does not matter here, only that the device writes the
 * exchange into its own workspace.
 */
async function stubChat(page: Page) {
  await page.route("**/api/venom/models", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "venom-gpt",
          provider: "openai",
          name: "Venom GPT",
          family: "GPT",
          summary: "OpenAI managed model",
          available: true,
          availabilityText: "Ready",
        },
      ]),
    }),
  );
  await page.route("**/api/venom/respond", (route) =>
    route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
      body: [
        'data: {"modelId":"venom-gpt","modelName":"Venom GPT"}',
        "",
        'data: {"content":"Recorded."}',
        "",
        "data: [DONE]",
        "",
        "",
      ].join("\n"),
    }),
  );
  await page.route("**/api/venom/knowledge/extract", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ clusters: [] }),
    }),
  );
}

async function sendChatMessage(page: Page, text: string) {
  await page.getByTestId("chat-input").fill(text);
  await page.getByTestId("send-message-button").click();
  await expect(
    page.getByTestId("workspace-chat").getByText(text, { exact: true }),
  ).toBeVisible();
}

function savedMessageContents(page: Page, userId: string) {
  return page.evaluate((id) => {
    const snapshot = window.__venomWorkspaceSyncTest?.snapshots[id];
    const state = snapshot?.state as
      | { conversations?: { messages?: { content?: string }[] }[] }
      | undefined;
    return (state?.conversations ?? []).flatMap((conversation) =>
      (conversation.messages ?? []).map((entry) => entry.content ?? ""),
    );
  }, userId);
}

async function createProject(page: Page, name: string) {
  await page.getByTestId("open-projects").click();
  await page.getByTestId("create-project").click();
  await page.getByTestId("new-project-name").fill(name);
  await page.getByTestId("save-project").click();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await expect(page.getByTestId("open-projects")).toContainText(name);
}

function savedProjectNames(page: Page, userId: string) {
  return page.evaluate((id) => {
    const snapshot = window.__venomWorkspaceSyncTest?.snapshots[id];
    const state = snapshot?.state as { projects?: { name?: string }[] };
    return (state?.projects ?? []).map((project) => project.name ?? "");
  }, userId);
}

/**
 * The board cards the fake cloud holds for one project, or null when the
 * project never reached it. The project name alone would not prove the upload
 * carried the work filed inside the project up with it.
 */
function savedProjectCards(page: Page, userId: string, name: string) {
  return page.evaluate(
    ({ id, projectName }) => {
      const snapshot = window.__venomWorkspaceSyncTest?.snapshots[id];
      const state = snapshot?.state as
        | {
            projects?: { name?: string; tasks?: { title?: string }[] }[];
          }
        | undefined;
      const saved = (state?.projects ?? []).find(
        (project) => project.name === projectName,
      );
      if (!saved) return null;
      return (saved.tasks ?? []).map((task) => task.title ?? "");
    },
    { id: userId, projectName: name },
  );
}

/**
 * Stands in for another device deleting a project: the cloud snapshot loses
 * the project and everything filed under it, exactly as it would after the
 * other device saved. The device keeps its own stale copy, which is what the
 * restore has to refuse to bring back.
 */
function deleteProjectInCloud(page: Page, userId: string, name: string) {
  return page.evaluate(
    ({ id, projectName }) => {
      const harness = window.__venomWorkspaceSyncTest;
      const snapshot = harness?.snapshots[id];
      if (!harness || !snapshot) throw new Error("No cloud snapshot to edit.");
      const state = snapshot.state as {
        projects: { id: string; name?: string }[];
        conversations: { projectId: string | null }[];
        clusters: { projectId: string | null }[];
        activeProjectId: string | null;
        activeConversationId: string | null;
      };
      const removed = state.projects.find(
        (project) => project.name === projectName,
      );
      if (!removed) throw new Error(`No cloud project named ${projectName}.`);
      const projects = state.projects.filter(
        (project) => project.id !== removed.id,
      );
      harness.seedSnapshot(id, {
        ...state,
        projects,
        conversations: state.conversations.filter(
          (conversation) => conversation.projectId !== removed.id,
        ),
        clusters: state.clusters.filter(
          (cluster) => cluster.projectId !== removed.id,
        ),
        activeProjectId: projects[0]?.id ?? null,
        activeConversationId: null,
      } as never);
    },
    { id: userId, projectName: name },
  );
}

/**
 * Deletes a project the way a person does, from the projects screen. The
 * caller names a project to switch to first so the deletion never changes
 * which workspace is active mid-scenario.
 */
async function deleteProjectOnDevice(
  page: Page,
  name: string,
  switchToName: string,
) {
  await page.getByTestId("open-projects").click();
  await page
    .getByRole("button", { name: `Switch to ${switchToName}` })
    .click();
  await expect(page.getByTestId("chat-input")).toBeVisible();

  await page.getByTestId("open-projects").click();
  await page.getByRole("button", { name: `Delete ${name}` }).click();
  await expect(
    page.getByRole("button", { name: `Switch to ${name}` }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Go back" }).click();
  await expect(page.getByTestId("chat-input")).toBeVisible();
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

test("keeps a message written while cloud saves fail across a reload", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The chat composer journey is covered at the mobile viewport.",
  );

  const syncedMessage = `Synced question ${testInfo.project.name}`;
  const offlineMessage = `Offline question ${testInfo.project.name}`;
  await stubChat(page);

  await page.goto(syncTestUrl());
  await expect(page.getByTestId("chat-input")).toBeVisible();

  // The restore path only runs for an account the cloud has a snapshot for, so
  // land one save before taking the cloud away.
  await sendChatMessage(page, syncedMessage);
  await expect
    .poll(() => savedMessageContents(page, initialUserId))
    .toContain(syncedMessage);

  // From here every save fails, so this message only ever reaches the device.
  await page.evaluate(() => {
    window.__venomWorkspaceSyncTest?.failNextSaves(50);
  });
  const attemptsBefore = await page.evaluate(
    () => window.__venomWorkspaceSyncTest?.attempts.length ?? 0,
  );
  await sendChatMessage(page, offlineMessage);
  await page.waitForFunction(
    (previous) =>
      (window.__venomWorkspaceSyncTest?.attempts.length ?? 0) > previous,
    attemptsBefore,
  );
  await expect
    .poll(() => savedMessageContents(page, initialUserId))
    .not.toContain(offlineMessage);

  // Reload with the cloud still refusing saves, so the message can only be on
  // screen because the restore kept what the device had written.
  await page.goto(`${syncTestUrl()}&venomWorkspaceSaveFailures=50`);
  await expect(page.getByTestId("chat-input")).toBeVisible();
  const chat = page.getByTestId("workspace-chat");
  await expect(chat.getByText(syncedMessage, { exact: true })).toBeVisible();
  await expect(chat.getByText(offlineMessage, { exact: true })).toBeVisible();
  await expect
    .poll(() => savedMessageContents(page, initialUserId))
    .not.toContain(offlineMessage);
});

test("keeps a project created while cloud saves fail, without reviving one deleted elsewhere", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The chat composer journey is covered at the mobile viewport.",
  );

  const syncedProject = `Synced beta ${testInfo.project.name}`;
  const offlineProject = `Offline alpha ${testInfo.project.name}`;
  const offlineMessage = `Offline project question ${testInfo.project.name}`;
  await stubChat(page);

  await page.goto(syncTestUrl());
  await expect(page.getByTestId("chat-input")).toBeVisible();

  // The restore path only runs for an account the cloud has a snapshot for, and
  // this project has to reach the cloud so the device records it as synced.
  await sendChatMessage(page, `Synced question ${testInfo.project.name}`);
  await createProject(page, syncedProject);
  await expect
    .poll(() => savedProjectNames(page, initialUserId))
    .toContain(syncedProject);

  // From here every save fails, so nothing below can reach the cloud.
  await page.evaluate(() => {
    window.__venomWorkspaceSyncTest?.failNextSaves(50);
  });
  await deleteProjectInCloud(page, initialUserId, syncedProject);

  const attemptsBefore = await page.evaluate(
    () => window.__venomWorkspaceSyncTest?.attempts.length ?? 0,
  );
  await createProject(page, offlineProject);
  await sendChatMessage(page, offlineMessage);
  await page.waitForFunction(
    (previous) =>
      (window.__venomWorkspaceSyncTest?.attempts.length ?? 0) > previous,
    attemptsBefore,
  );
  await expect
    .poll(() => savedProjectNames(page, initialUserId))
    .not.toContain(offlineProject);

  // Reload with the cloud still refusing saves, so anything on screen is there
  // because the restore kept it, not because a fresh upload put it back.
  await page.goto(`${syncTestUrl()}&venomWorkspaceSaveFailures=50`);
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await expect(page.getByTestId("open-projects")).toContainText(offlineProject);
  await expect(
    page.getByTestId("workspace-chat").getByText(offlineMessage, {
      exact: true,
    }),
  ).toBeVisible();

  await page.getByTestId("open-projects").click();
  await expect(
    page.getByRole("button", { name: `Switch to ${offlineProject}` }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Switch to ${syncedProject}` }),
  ).toHaveCount(0);
});

test("backs up a project created while cloud saves fail once saves recover", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The chat composer journey is covered at the mobile viewport.",
  );

  const syncedMessage = `Synced question ${testInfo.project.name}`;
  const offlineProject = `Recovered alpha ${testInfo.project.name}`;
  const offlineMessage = `Recovered project question ${testInfo.project.name}`;
  const offlineCard = `Recovered card ${testInfo.project.name}`;
  await stubChat(page);

  await page.goto(syncTestUrl());
  await expect(page.getByTestId("chat-input")).toBeVisible();

  // The restore path only runs for an account the cloud has a snapshot for, so
  // land one save before taking the cloud away.
  await sendChatMessage(page, syncedMessage);
  await expect
    .poll(() => savedMessageContents(page, initialUserId))
    .toContain(syncedMessage);

  // From here every save fails, so the project and everything filed inside it
  // exists only on the device.
  await page.evaluate(() => {
    window.__venomWorkspaceSyncTest?.failNextSaves(50);
  });
  const attemptsBefore = await page.evaluate(
    () => window.__venomWorkspaceSyncTest?.attempts.length ?? 0,
  );
  await createProject(page, offlineProject);
  await sendChatMessage(page, offlineMessage);
  await addTaskThatChangesWorkspace(page, offlineCard);
  await page.waitForFunction(
    (previous) =>
      (window.__venomWorkspaceSyncTest?.attempts.length ?? 0) > previous,
    attemptsBefore,
  );
  expect(await savedProjectCards(page, initialUserId, offlineProject)).toBe(
    null,
  );
  await expect
    .poll(() => savedMessageContents(page, initialUserId))
    .not.toContain(offlineMessage);

  // Saves work again. Nothing else touches the workspace from here, so only the
  // retry can get the offline project into the cloud. The card was written last,
  // so a snapshot holding it holds everything written before it too.
  await page.evaluate(() => {
    window.__venomWorkspaceSyncTest?.failNextSaves(0);
  });
  await expect
    .poll(
      async () =>
        (await savedProjectCards(page, initialUserId, offlineProject)) ?? [],
      { timeout: 60_000 },
    )
    .toContain(offlineCard);
  expect(await savedMessageContents(page, initialUserId)).toContain(
    offlineMessage,
  );

  // The project counts as backed up now, so another device deleting it has to
  // stick: the restore must stop treating it as work this device never uploaded.
  await deleteProjectInCloud(page, initialUserId, offlineProject);
  await page.goto(`${syncTestUrl()}&venomWorkspaceSaveFailures=50`);
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await expect(page.getByTestId("open-projects")).not.toContainText(
    offlineProject,
  );

  await page.getByTestId("open-projects").click();
  await expect(
    page.getByRole("button", { name: `Switch to ${offlineProject}` }),
  ).toHaveCount(0);
});

test("keeps a project deleted while cloud saves fail deleted once saves recover", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The chat composer journey is covered at the mobile viewport.",
  );

  const syncedMessage = `Synced question ${testInfo.project.name}`;
  const doomedProject = `Doomed alpha ${testInfo.project.name}`;
  await stubChat(page);

  await page.goto(syncTestUrl());
  await expect(page.getByTestId("chat-input")).toBeVisible();

  // The project has to reach the cloud first, so the device records it as
  // synced and the deletion below is a deletion of backed-up work.
  await sendChatMessage(page, syncedMessage);
  await createProject(page, doomedProject);
  await expect
    .poll(() => savedProjectNames(page, initialUserId))
    .toContain(doomedProject);

  // From here every save fails, so the deletion exists only on the device.
  await page.evaluate(() => {
    window.__venomWorkspaceSyncTest?.failNextSaves(50);
  });
  const attemptsBefore = await page.evaluate(
    () => window.__venomWorkspaceSyncTest?.attempts.length ?? 0,
  );
  await deleteProjectOnDevice(page, doomedProject, "Global Workspace");
  await page.waitForFunction(
    (previous) =>
      (window.__venomWorkspaceSyncTest?.attempts.length ?? 0) > previous,
    attemptsBefore,
  );
  expect(await savedProjectNames(page, initialUserId)).toContain(doomedProject);

  // Saves work again. Nothing else touches the workspace from here, so only the
  // recovery upload can carry the deletion to the cloud.
  await page.evaluate(() => {
    window.__venomWorkspaceSyncTest?.failNextSaves(0);
  });
  await expect
    .poll(() => savedProjectNames(page, initialUserId), { timeout: 60_000 })
    .not.toContain(doomedProject);

  // Reload with the cloud refusing saves again, so nothing on screen can be a
  // fresh upload's doing: the restore has to leave the deleted project gone
  // rather than read it as work this device never managed to back up.
  await page.goto(`${syncTestUrl()}&venomWorkspaceSaveFailures=50`);
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await expect(page.getByTestId("open-projects")).not.toContainText(
    doomedProject,
  );

  await page.getByTestId("open-projects").click();
  await expect(
    page.getByRole("button", { name: `Switch to Global Workspace` }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Switch to ${doomedProject}` }),
  ).toHaveCount(0);
  expect(await savedProjectNames(page, initialUserId)).not.toContain(
    doomedProject,
  );
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
