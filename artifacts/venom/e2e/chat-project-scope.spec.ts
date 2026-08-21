import { expect, test, type Page } from "@playwright/test";
import type { WorkspaceSyncTestHarness } from "../context/workspaceSyncTestHarness";

declare global {
  interface Window {
    __venomWorkspaceSyncTest?: WorkspaceSyncTestHarness;
  }
}

const initialUserId = "venom-ui-test";
const DEFAULT_PROJECT = "Global Workspace";

function syncTestUrl() {
  return "/?venomUiTest=true&venomWorkspaceSyncTest=true";
}

/**
 * Enough of the chat backend to send a message without a live model: the
 * answer's content does not matter here, only which project the exchange is
 * filed under.
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

async function createProject(page: Page, name: string) {
  await page.getByTestId("open-projects").click();
  await page.getByTestId("create-project").click();
  await page.getByTestId("new-project-name").fill(name);
  await page.getByTestId("save-project").click();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await expect(page.getByTestId("open-projects")).toContainText(name);
}

async function switchToProject(page: Page, name: string) {
  await page.getByTestId("open-projects").click();
  await page.getByRole("button", { name: `Switch to ${name}` }).click();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await expect(page.getByTestId("open-projects")).toContainText(name);
}

/**
 * The messages the fake cloud holds for one project, read through the project's
 * name so the check speaks in the terms the person on screen used. Returns null
 * when the cloud has no project by that name yet.
 */
function savedMessagesForProject(page: Page, userId: string, name: string) {
  return page.evaluate(
    ({ id, projectName }) => {
      const snapshot = window.__venomWorkspaceSyncTest?.snapshots[id];
      const state = snapshot?.state as
        | {
            projects?: { id?: string; name?: string }[];
            conversations?: {
              projectId?: string | null;
              messages?: { content?: string }[];
            }[];
          }
        | undefined;
      const project = (state?.projects ?? []).find(
        (candidate) => candidate.name === projectName,
      );
      if (!project) return null;
      return (state?.conversations ?? [])
        .filter((conversation) => conversation.projectId === project.id)
        .flatMap((conversation) =>
          (conversation.messages ?? []).map((entry) => entry.content ?? ""),
        );
    },
    { id: userId, projectName: name },
  );
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "The chat composer journey is covered at the mobile viewport.",
  );
});

test("files a message under the project that was on screen when it was sent", async ({
  page,
}, testInfo) => {
  const defaultProjectMessage = `Default project question ${testInfo.project.name}`;
  const switchedProject = `Switched project ${testInfo.project.name}`;
  const switchedProjectMessage = `Switched project question ${testInfo.project.name}`;
  await stubChat(page);

  await page.goto(syncTestUrl());
  await expect(page.getByTestId("chat-input")).toBeVisible();

  // A message written before any switch belongs to the project it was typed in.
  await sendChatMessage(page, defaultProjectMessage);
  await expect
    .poll(async () => savedMessagesForProject(page, initialUserId, DEFAULT_PROJECT))
    .toContain(defaultProjectMessage);

  // Creating and selecting a project leaves the chat ready for that project:
  // the previous project's session is no longer the one being written into.
  await createProject(page, switchedProject);
  await expect(
    page.getByTestId("workspace-chat").getByText(defaultProjectMessage, {
      exact: true,
    }),
  ).toHaveCount(0);

  await sendChatMessage(page, switchedProjectMessage);
  await expect
    .poll(async () =>
      savedMessagesForProject(page, initialUserId, switchedProject),
    )
    .toContain(switchedProjectMessage);

  // The message must not also be sitting in the project that was selected
  // before the switch.
  expect(
    await savedMessagesForProject(page, initialUserId, DEFAULT_PROJECT),
  ).not.toContain(switchedProjectMessage);

  // Existing conversations are unaffected: switching back shows the chat that
  // was written in that project, and only that chat.
  await switchToProject(page, DEFAULT_PROJECT);
  const chat = page.getByTestId("workspace-chat");
  await expect(chat.getByText(defaultProjectMessage, { exact: true })).toBeVisible();
  await expect(
    chat.getByText(switchedProjectMessage, { exact: true }),
  ).toHaveCount(0);

  await switchToProject(page, switchedProject);
  await expect(
    chat.getByText(switchedProjectMessage, { exact: true }),
  ).toBeVisible();
  await expect(
    chat.getByText(defaultProjectMessage, { exact: true }),
  ).toHaveCount(0);
});
