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
    costTier: "$$$",
  },
  {
    id: "venom-claude",
    provider: "anthropic",
    name: "Venom Claude",
    family: "Claude",
    summary: "Anthropic managed model",
    available: true,
    availabilityText: "Ready",
    costTier: "$$",
  },
  {
    id: "venom-gemini",
    provider: "gemini",
    name: "Venom Gemini",
    family: "Gemini",
    summary: "Google managed model",
    available: false,
    availabilityText: "Not configured",
    costTier: "$",
  },
  {
    id: "venom-grok",
    provider: "openrouter",
    name: "Venom Grok",
    family: "Grok",
    summary: "xAI managed model",
    available: false,
    availabilityText: "Not configured",
    costTier: "$$",
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
test("an auto policy hands the model library to Venom", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The mobile settings journey is covered at the mobile viewport.",
  );

  await page.route("**/api/venom/models", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(catalog),
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

  // Coarse cost badges rank the catalog — tiers only, never prices.
  await expect(page.getByTestId("cost-badge-venom-gpt")).toHaveText("$$$");
  await expect(page.getByTestId("cost-badge-venom-gemini")).toHaveText("$");

  // Manual is the standing default; the library is live. Enable a second
  // model so a default-star is on offer.
  await expect(page.getByTestId("policy-manual")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.getByTestId("toggle-model-venom-claude").click();
  await expect(
    page.getByTestId("set-default-model-venom-claude"),
  ).toBeEnabled();

  // Hand over to Auto — cheapest.
  await page.getByTestId("policy-auto-cheapest").click();
  await expect(page.getByTestId("policy-auto-cheapest")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  // The takeover says who is choosing and why.
  await expect(page.getByTestId("model-policy-takeover")).toContainText(
    /cheapest/i,
  );
  // Library actions rest while Venom drives.
  await expect(page.getByTestId("toggle-model-venom-claude")).toBeDisabled();
  await expect(
    page.getByTestId("set-default-model-venom-claude"),
  ).toBeDisabled();

  // The composer hands over too: no manual chips, one honest note.
  await page.goBack();
  await expect(page.getByTestId("composer-policy-takeover")).toBeVisible();
  await expect(page.getByTestId("select-model-venom-gpt")).toHaveCount(0);

  // Round trip: the choice sticks, and Manual hands control back.
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("policy-auto-cheapest")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.getByTestId("policy-manual").click();
  await expect(page.getByTestId("model-policy-takeover")).toHaveCount(0);
  await expect(page.getByTestId("toggle-model-venom-claude")).toBeEnabled();

  // Back in chat the manual chips return.
  await page.goBack();
  await expect(page.getByTestId("select-model-venom-gpt")).toBeVisible();
  await expect(page.getByTestId("composer-policy-takeover")).toHaveCount(0);
});
