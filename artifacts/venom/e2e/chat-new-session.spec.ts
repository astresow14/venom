import { expect, test, type Page } from "@playwright/test";
import type { WorkspaceSyncTestHarness } from "../context/workspaceSyncTestHarness";

declare global {
  interface Window {
    __venomWorkspaceSyncTest?: WorkspaceSyncTestHarness;
  }
}

const initialUserId = "venom-ui-test";
const DEFAULT_PROJECT = "General";
/** The workspace's starting session, fixed by the default UI-test state. */
const FIRST_SESSION_ID = "conv_default";

function syncTestUrl() {
  return "/?venomUiTest=true&venomWorkspaceSyncTest=true";
}

/**
 * Enough of the chat backend to send messages without a live model. The
 * knowledge extractor deliberately never yields an insight: reopening an
 * earlier session must work from workspace state alone, with no Brain note
 * standing in for a session list.
 */
async function stubChat(page: Page, extractCalls: { count: number }) {
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
  await page.route("**/api/venom/knowledge/extract", (route) => {
    extractCalls.count += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ clusters: [] }),
    });
  });
}

async function sendChatMessage(page: Page, text: string) {
  await page.getByTestId("chat-input").fill(text);
  await page.getByTestId("send-message-button").click();
  await expect(
    page.getByTestId("workspace-chat").getByText(text, { exact: true }),
  ).toBeVisible();
}

/**
 * The message lists of every session the fake cloud holds for one project,
 * so the check can prove the old session survived the new one, each with only
 * its own thread. Returns null when the cloud has no snapshot yet.
 */
function savedSessionsForProject(page: Page, userId: string, name: string) {
  return page.evaluate(
    ({ id, projectName }) => {
      const snapshot = window.__venomWorkspaceSyncTest?.snapshots[id];
      const state = snapshot?.state as
        | {
            projects?: { id?: string; name?: string }[];
            conversations?: {
              id?: string;
              projectId?: string | null;
              messages?: { content?: string }[];
            }[];
          }
        | undefined;
      const project = (state?.projects ?? []).find(
        (candidate) => candidate.name === projectName,
      );
      if (!project) return null;
      // Sessions abandoned while still empty stay as records (matching the
      // desktop's new-conversation behavior) but hold no thread; the check
      // cares about the sessions that carry messages.
      return (state?.conversations ?? [])
        .filter(
          (conversation) =>
            conversation.projectId === project.id &&
            (conversation.messages ?? []).length > 0,
        )
        .map((conversation) =>
          (conversation.messages ?? []).map((entry) => entry.content ?? ""),
        );
    },
    { id: userId, projectName: name },
  );
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "Starting a fresh chat session is a phone-app journey.",
  );
});

test("starts a fresh session without losing the old one, and reopens it", async ({
  page,
}) => {
  const firstMessage = "Plan the launch checklist";
  const secondMessage = "Unrelated question about invoices";
  const extractCalls = { count: 0 };
  await stubChat(page, extractCalls);

  await page.goto(syncTestUrl());
  await expect(page.getByTestId("chat-input")).toBeVisible();

  // A brand-new workspace opens on an empty session: nothing to close, no
  // earlier session to return to, so neither pill is on screen.
  await expect(page.getByTestId("start-new-session")).toHaveCount(0);
  await expect(page.getByTestId("open-session-history")).toHaveCount(0);

  const chat = page.getByTestId("workspace-chat");
  await sendChatMessage(page, firstMessage);
  await expect(chat.getByText("Recorded.", { exact: true })).toBeVisible();

  // The only session is the one on screen, so there is still nothing to
  // reopen — only the new-session action shows.
  await expect(page.getByTestId("start-new-session")).toBeVisible();
  await expect(page.getByTestId("open-session-history")).toHaveCount(0);

  // Starting a fresh session empties the composer view without deleting
  // anything: the earlier thread simply stops being the one on screen.
  await page.getByTestId("start-new-session").click();
  await expect(chat.getByText(firstMessage, { exact: true })).toHaveCount(0);
  await expect(chat.getByText("Recorded.", { exact: true })).toHaveCount(0);
  await expect(chat.getByText("How can I help?")).toBeVisible();

  // The empty fresh session has nothing to close, but the way back to the
  // earlier session is right there — even though knowledge extraction
  // produced no Brain note for it.
  expect(extractCalls.count).toBeGreaterThan(0);
  await expect(page.getByTestId("start-new-session")).toHaveCount(0);
  const sessionsPill = page.getByTestId("open-session-history");
  await expect(sessionsPill).toBeVisible();

  // Reopen the earlier session from the sheet while the new one is empty.
  await sessionsPill.click();
  const sheet = page.getByTestId("session-history-sheet");
  await expect(sheet).toBeVisible();
  await sheet.getByTestId(`session-history-item-${FIRST_SESSION_ID}`).click();
  await expect(sheet).toHaveCount(0);
  await expect(chat.getByText(firstMessage, { exact: true })).toBeVisible();
  await expect(chat.getByText("Recorded.", { exact: true })).toBeVisible();

  // Close it again for a truly fresh thread; the next message files under
  // the same project, in a session of its own.
  await page.getByTestId("start-new-session").click();
  await expect(chat.getByText(firstMessage, { exact: true })).toHaveCount(0);
  await sendChatMessage(page, secondMessage);
  await expect(chat.getByText(firstMessage, { exact: true })).toHaveCount(0);
  await expect
    .poll(async () => {
      const sessions = await savedSessionsForProject(
        page,
        initialUserId,
        DEFAULT_PROJECT,
      );
      if (!sessions) return null;
      return {
        total: sessions.length,
        oldSessionKept: sessions.some(
          (messages) =>
            messages.includes(firstMessage) &&
            !messages.includes(secondMessage),
        ),
        newSessionSeparate: sessions.some(
          (messages) =>
            messages.includes(secondMessage) &&
            !messages.includes(firstMessage),
        ),
      };
    })
    .toEqual({ total: 2, oldSessionKept: true, newSessionSeparate: true });

  // Both sessions are listed; the earlier one reopens with only its own
  // thread, and the newer one is reachable again the same way.
  await page.getByTestId("open-session-history").click();
  await expect(sheet).toBeVisible();
  const sessionRows = sheet.locator('[data-testid^="session-history-item-"]');
  await expect(sessionRows).toHaveCount(2);
  await sheet.getByTestId(`session-history-item-${FIRST_SESSION_ID}`).click();
  await expect(chat.getByText(firstMessage, { exact: true })).toBeVisible();
  await expect(chat.getByText(secondMessage, { exact: true })).toHaveCount(0);

  await page.getByTestId("open-session-history").click();
  await sheet
    .locator(
      `[data-testid^="session-history-item-"]:not([data-testid="session-history-item-${FIRST_SESSION_ID}"])`,
    )
    .click();
  await expect(chat.getByText(secondMessage, { exact: true })).toBeVisible();
  await expect(chat.getByText(firstMessage, { exact: true })).toHaveCount(0);
});
