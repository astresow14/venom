import { expect, test, type Page } from "@playwright/test";
import {
  mockStagedChatStream,
  respondCallCount,
  type StreamScriptEvent,
} from "./support/chat-stream";

/**
 * A plain Talk reply that arrives in stages on the phone, and one that
 * stalls halfway. The mobile client consumes the same /api/venom/respond
 * SSE contract as desktop but defines its own mid-answer states:
 *
 * - pre-token: a typing spinner in the list header (no text yet);
 * - in-progress: the assistant bubble grows in place while the composer's
 *   send/attach buttons are disabled — the text input itself deliberately
 *   stays editable so the next message can be drafted mid-answer;
 * - a stream that closes without a done event persists an error bubble with
 *   the "Tap send to retry" affordance instead of keeping the partial text;
 * - retry is a fresh send, which must recover normally.
 *
 * The reply is streamed from inside the page (no live model calls) with the
 * shared staged stub, the same approach as the desktop suite's
 * e2e/support/chat-stream.ts.
 */

const META = { modelId: "venom-gpt", modelName: "Venom GPT" };

const catalog = [
  {
    id: "venom-gpt",
    name: "Venom GPT",
    provider: "openai",
    description: "Managed default",
    available: true,
    managed: true,
    isDefault: true,
  },
];

const STAGE_ONE = "Splitting the answer into stages ";
const STAGE_TWO = "keeps every mid-answer state on screen.";
const STALL_FRAGMENT = "Half of an answer that never";
const RECOVERY = "Recovered after the stall with the full answer.";

/** Staged Talk reply that completes: pre-token pause, two stages, tail. */
const stagedTurn: StreamScriptEvent[] = [
  [400, META],
  // Pre-token pause: long enough to assert the spinner and the locks.
  [3500, { content: STAGE_ONE }],
  [2000, { content: STAGE_TWO }],
  // Metadata tail before completion keeps the mid-stream window open.
  [2400, META],
  [300, { done: true }],
];

/** A reply that dies mid-answer: content arrives, then the stream closes
 * without a done event (the metadata tail only holds the fragment on screen
 * before the drop). */
const stalledTurn: StreamScriptEvent[] = [
  [300, META],
  [600, { content: STALL_FRAGMENT }],
  [2200, META],
];

/** The retry turn, which completes normally. */
const recoveryTurn: StreamScriptEvent[] = [
  [250, META],
  [400, { content: RECOVERY }],
  [250, { done: true }],
];

async function mockModels(page: Page) {
  await page.route("**/api/venom/models", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(catalog),
    });
  });
}

/** Talk-only surface: without the endpoint the mode switch stays hidden. */
async function mockDeliberationUnavailable(page: Page) {
  await page.route("**/api/venom/deliberation", async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "Not found" }),
    });
  });
}

async function mockKnowledgeExtraction(page: Page) {
  await page.route("**/api/venom/knowledge/extract", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ clusters: [] }),
    });
  });
}

test("holds the phone's mid-answer states while a reply arrives in stages", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The mobile chat journey is covered at the mobile viewport.",
  );

  await mockModels(page);
  await mockDeliberationUnavailable(page);
  await mockKnowledgeExtraction(page);
  await mockStagedChatStream(page, [stagedTurn]);

  await page.goto("/");
  const input = page.getByTestId("chat-input");
  await expect(input).toBeVisible();

  await input.fill("Walk me through it slowly.");
  await page.getByTestId("send-message-button").click();

  // Before the first token: the typing spinner is the placeholder.
  const chat = page.getByTestId("workspace-chat");
  const spinner = chat.getByRole("progressbar");
  await expect(spinner).toBeVisible();

  // The composer locks as the mobile chat defines it: the text input stays
  // editable for drafting, but send and attach refuse until the reply lands.
  const send = page.getByTestId("send-message-button");
  await input.fill("Drafted while the reply is still arriving");
  await expect(send).toBeDisabled();
  await expect(page.getByTestId("attach-file-button")).toBeDisabled();

  // A tap on the locked send button must not fire a second request.
  await send.click({ force: true });
  expect(await respondCallCount(page)).toBe(1);

  // First tokens: the spinner yields to a bubble that grows in stages.
  const reply = page.getByTestId("chat-message-assistant");
  await expect(reply).toContainText(STAGE_ONE);
  await expect(reply).not.toContainText(STAGE_TWO);
  await expect(spinner).toHaveCount(0);

  // Mid-stream, the composer is still locked.
  await expect(reply).toContainText(STAGE_TWO);
  await expect(send).toBeDisabled();
  expect(await respondCallCount(page)).toBe(1);

  // Completion: the composer re-arms (the drafted text is still there), and
  // the reply persists as a normal answer with its model attribution.
  await expect(send).toBeEnabled();
  await expect(page.getByTestId("attach-file-button")).toBeEnabled();
  await expect(reply).toContainText(STAGE_ONE + STAGE_TWO);
  await expect(chat.getByText("Venom GPT")).toBeVisible();
  await expect(chat.getByText("Walk me through it slowly.")).toBeVisible();
  await expect(chat.getByText("Tap send to retry")).toHaveCount(0);
  expect(await respondCallCount(page)).toBe(1);
});

test("a stream that dies without a done event surfaces the retry path, and retrying recovers", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The mobile chat journey is covered at the mobile viewport.",
  );

  await mockModels(page);
  await mockDeliberationUnavailable(page);
  await mockKnowledgeExtraction(page);
  await mockStagedChatStream(page, [stalledTurn, recoveryTurn]);

  await page.goto("/");
  const input = page.getByTestId("chat-input");
  await expect(input).toBeVisible();

  await input.fill("Will this stall?");
  await page.getByTestId("send-message-button").click();

  // Tokens really arrive before the connection dies.
  const chat = page.getByTestId("workspace-chat");
  await expect(chat.getByText(STALL_FRAGMENT)).toBeVisible();

  // The stream closes without done: the partial reply is not kept — the
  // turn lands as an error bubble carrying the retry affordance.
  await expect(
    chat.getByText("The response was interrupted. Please try again."),
  ).toBeVisible();
  await expect(chat.getByText("Tap send to retry")).toBeVisible();
  await expect(chat.getByText(STALL_FRAGMENT)).toHaveCount(0);
  await expect(chat.getByRole("progressbar")).toHaveCount(0);
  await expect(page.getByTestId("chat-message-assistant")).toHaveCount(1);

  // "Tap send to retry" means a fresh send: the composer re-armed.
  await input.fill("Try again, slower.");
  const send = page.getByTestId("send-message-button");
  await expect(send).toBeEnabled();
  await send.click();

  // The retry is one new request and recovers into a normal answer.
  await expect(chat.getByText(RECOVERY)).toBeVisible();
  await expect(chat.getByText("Venom GPT")).toBeVisible();
  expect(await respondCallCount(page)).toBe(2);

  // The fragment never returns; the failed turn stays in history as an
  // error bubble (by design) rather than posing as an answer.
  await expect(chat.getByText(STALL_FRAGMENT)).toHaveCount(0);
  await expect(
    chat.getByText("The response was interrupted. Please try again."),
  ).toBeVisible();

  // The stream ended cleanly this time: the composer is unlocked again.
  await expect(page.getByTestId("attach-file-button")).toBeEnabled();
});
