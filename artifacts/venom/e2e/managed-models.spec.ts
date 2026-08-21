import { expect, test } from "@playwright/test";

const catalog = [
  {
    id: "venom-gpt",
    provider: "openai",
    name: "Venom GPT",
    family: "GPT",
    summary: "OpenAI managed model",
    available: true,
    availabilityText: "Ready",
  },
  {
    id: "venom-claude",
    provider: "anthropic",
    name: "Venom Claude",
    family: "Claude",
    summary: "Anthropic managed model",
    available: true,
    availabilityText: "Ready",
  },
  {
    id: "venom-gemini",
    provider: "gemini",
    name: "Venom Gemini",
    family: "Gemini",
    summary: "Google managed model",
    available: false,
    availabilityText: "Not configured",
  },
  {
    id: "venom-grok",
    provider: "openrouter",
    name: "Venom Grok",
    family: "Grok",
    summary: "xAI managed model",
    available: false,
    availabilityText: "Not configured",
  },
];

test("enables, selects, uses, attributes, and removes a managed model", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The mobile-first journey is covered at the mobile viewport.",
  );

  let requestedModelId: string | undefined;

  await page.route("**/api/venom/models", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(catalog),
    });
  });
  await page.route("**/api/venom/respond", async (route) => {
    const body = route.request().postDataJSON() as { modelId?: string };
    requestedModelId = body.modelId;
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
      body: [
        'data: {"modelId":"venom-claude","modelName":"Venom Claude"}',
        "",
        'data: {"content":"Managed response"}',
        "",
        'data: {"done":true}',
        "",
        "",
      ].join("\n"),
    });
  });
  await page.route("**/api/venom/knowledge/extract", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ clusters: [] }),
    });
  });

  await page.goto("/");
  await page.getByTestId("open-settings").click();
  await expect(page.getByText("AI Models")).toBeVisible();

  await page.getByTestId("toggle-model-venom-claude").click();
  await page.getByTestId("set-default-model-venom-claude").click();
  await expect(
    page.getByTestId("toggle-model-venom-gemini"),
  ).toBeDisabled();

  await page.goBack();
  await page.getByTestId("select-model-venom-claude").click();
  await page.getByTestId("chat-input").fill("Use the selected model");
  await page.getByTestId("send-message-button").click();

  const chatWorkspace = page.getByTestId("workspace-chat");
  await expect(chatWorkspace.getByText("Managed response")).toBeVisible();
  await expect(chatWorkspace.getByText("Venom Claude").last()).toBeVisible();
  await expect.poll(() => requestedModelId).toBe("venom-claude");

  await page.getByTestId("open-settings").click();
  await page.getByTestId("toggle-model-venom-claude").click();
  await page.goBack();
  await expect(page.getByTestId("select-model-venom-claude")).toHaveCount(0);
});

test("does not save a truncated stream as a completed answer", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The mobile streaming parser is covered at the mobile viewport.",
  );

  await page.route("**/api/venom/models", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(catalog),
    });
  });
  await page.route("**/api/venom/respond", async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
      body: [
        'data: {"modelId":"venom-gpt","modelName":"Venom GPT"}',
        "",
        'data: {"content":"Partial response"}',
        "",
      ].join("\n"),
    });
  });

  await page.goto("/");
  await page.getByTestId("chat-input").fill("Interrupt this response");
  await page.getByTestId("send-message-button").click();

  const chatWorkspace = page.getByTestId("workspace-chat");
  await expect(
    chatWorkspace.getByText("The response was interrupted. Please try again."),
  ).toBeVisible();
  await expect(chatWorkspace.getByText("Tap send to retry")).toBeVisible();
  await expect(chatWorkspace.getByText("Partial response")).toHaveCount(0);
  await expect(chatWorkspace.getByText("Venom GPT")).toHaveCount(0);
});