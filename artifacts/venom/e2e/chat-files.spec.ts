import { expect, test, type Page } from "@playwright/test";
import { Buffer } from "node:buffer";

/**
 * Chat file exchange on the mobile app: a picked document uploads through
 * the ticket handshake and rides the next message as an attachment id; a
 * file-producing turn shows the single-voice writing card and ends in a
 * tappable delivery card; and a render failure keeps the streamed answer
 * instead of erasing the turn.
 *
 * `page.route` fulfills atomically, so the one test that asserts the
 * in-progress writing card streams the body from inside the page by
 * wrapping `window.fetch` in an init script — `expo/fetch` on web is
 * `globalThis.fetch`, captured after init scripts run.
 */

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

const UPLOADED_FILE = {
  id: "chat-file-1",
  name: "notes.txt",
  contentType: "text/plain",
  size: 11,
  kind: "upload",
  status: "ready",
  createdAt: "2026-08-21T12:00:00.000Z",
};

const GENERATED_FILE = {
  id: "gen-file-1",
  name: "venom-board-brief-2026-08-21.pdf",
  contentType: "application/pdf",
  size: 9042,
  kind: "generated",
};

function sseBody(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

async function mockModels(page: Page) {
  await page.route("**/api/venom/models", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(catalog),
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

/** Stubs the three-step upload handshake for one text file. */
async function mockUploadHandshake(page: Page) {
  await page.route("**/api/venom/files/uploads", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        uploadUrl: "/upload-target/chat-file-1",
        file: { ...UPLOADED_FILE, status: "pending" },
      }),
    });
  });
  await page.route("**/upload-target/chat-file-1", async (route) => {
    await route.fulfill({ status: 200, body: "" });
  });
  await page.route(
    "**/api/venom/files/uploads/chat-file-1/complete",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(UPLOADED_FILE),
      });
    },
  );
}

/** Streams respond events with real delays from inside the page. */
async function mockStreamingRespond(
  page: Page,
  events: Array<[number, unknown]>,
) {
  await page.addInitScript((scripted: Array<[number, unknown]>) => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (!url.includes("/api/venom/respond")) {
        return originalFetch(input as RequestInfo, init);
      }
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const [delay, payload] of scripted) {
            await new Promise((resolve) => setTimeout(resolve, delay));
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
            );
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof window.fetch;
  }, events);
}

async function attachTextFile(page: Page) {
  // The paperclip opens a small menu: photos or documents.
  await page.getByTestId("attach-file-button").click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByTestId("attach-pick-file").click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello venom"),
  });
}

/** A real, decodable 1×1 PNG so the thumbnail pipeline actually runs. */
const PNG_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const UPLOADED_IMAGE = {
  id: "chat-img-1",
  name: "pixel.png",
  contentType: "image/png",
  size: 68,
  kind: "upload",
  status: "ready",
  createdAt: "2026-08-21T12:00:00.000Z",
};

/** Stubs the three-step upload handshake for one image file. */
async function mockImageUploadHandshake(page: Page) {
  await page.route("**/api/venom/files/uploads", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        uploadUrl: "/upload-target/chat-img-1",
        file: { ...UPLOADED_IMAGE, status: "pending" },
      }),
    });
  });
  await page.route("**/upload-target/chat-img-1", async (route) => {
    await route.fulfill({ status: 200, body: "" });
  });
  await page.route(
    "**/api/venom/files/uploads/chat-img-1/complete",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(UPLOADED_IMAGE),
      });
    },
  );
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The chat file journey is covered at the mobile viewport.",
  );
});

test("uploads a picked file and sends it as an attachment on the message", async ({
  page,
}) => {
  await mockModels(page);
  await mockKnowledgeExtraction(page);
  await mockUploadHandshake(page);

  const respondBodies: Array<{
    messages?: Array<{ role: string; attachmentIds?: string[] }>;
  }> = [];
  await page.route("**/api/venom/respond", async (route) => {
    respondBodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sseBody([
        { modelId: "venom-gpt", modelName: "Venom GPT" },
        { content: "Read it — eleven bytes of hello." },
        { done: true },
      ]),
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  await attachTextFile(page);

  // The chip rides the composer once the handshake finishes.
  await expect(page.getByTestId("pending-file-ready")).toBeVisible();
  await expect(page.getByTestId("pending-attachments-row")).toContainText(
    "notes.txt",
  );

  await page.getByTestId("chat-input").fill("What does this file say?");
  await page.getByTestId("send-message-button").click();

  // The reply lands and the queue clears.
  await expect(page.getByText("eleven bytes of hello")).toBeVisible();
  await expect(page.getByTestId("pending-attachments-row")).toHaveCount(0);

  // The stored file id rode the sent message.
  await expect.poll(() => respondBodies.length).toBe(1);
  const sent = respondBodies[0].messages?.at(-1);
  expect(sent?.role).toBe("user");
  expect(sent?.attachmentIds).toEqual(["chat-file-1"]);

  // The user bubble carries a tappable attachment row.
  await expect(page.getByTestId("message-attachment")).toBeVisible();
  await expect(page.getByTestId("message-attachment")).toContainText(
    "notes.txt",
  );

  // A follow-up keeps the prior turn's file on the wire so the server can
  // keep injecting its context — file conversations must not go amnesiac
  // after one turn, and a file attached on another device rides the same
  // path.
  await page.getByTestId("chat-input").fill("And what should we do next?");
  await page.getByTestId("send-message-button").click();
  await expect.poll(() => respondBodies.length).toBe(2);
  const followUp = respondBodies[1].messages ?? [];
  expect(followUp.at(-1)?.attachmentIds).toBeUndefined();
  const prior = followUp.find(
    (message) => message.role === "user" && message.attachmentIds,
  );
  expect(prior?.attachmentIds).toEqual(["chat-file-1"]);
});

test("attaches a photo with a thumbnail that rides the sent message", async ({
  page,
}) => {
  await mockModels(page);
  await mockKnowledgeExtraction(page);
  await mockImageUploadHandshake(page);

  const respondBodies: Array<{
    messages?: Array<{ role: string; attachmentIds?: string[] }>;
  }> = [];
  await page.route("**/api/venom/respond", async (route) => {
    respondBodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sseBody([
        { modelId: "venom-gpt", modelName: "Venom GPT" },
        { content: "A single red pixel." },
        { done: true },
      ]),
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  // Photo library option in the attach menu opens the image picker.
  await page.getByTestId("attach-file-button").click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByTestId("attach-pick-photo").click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: PNG_PIXEL,
  });

  // The chip settles ready and carries a real rendered thumbnail.
  await expect(page.getByTestId("pending-file-ready")).toBeVisible();
  await expect(page.getByTestId("pending-thumbnail")).toBeVisible();

  await page.getByTestId("chat-input").fill("What is this?");
  await page.getByTestId("send-message-button").click();

  await expect(page.getByText("A single red pixel.")).toBeVisible();

  // The bubble shows the image preview, and the id rode the wire.
  await expect(page.getByTestId("message-attachment")).toBeVisible();
  await expect(page.getByTestId("attachment-thumbnail")).toBeVisible();
  await expect.poll(() => respondBodies.length).toBe(1);
  expect(respondBodies[0].messages?.at(-1)?.attachmentIds).toEqual([
    "chat-img-1",
  ]);
});

test("shows the single-voice writing card and delivers a downloadable file", async ({
  page,
}) => {
  await mockModels(page);
  await mockKnowledgeExtraction(page);
  await mockStreamingRespond(page, [
    [
      0,
      {
        modelId: "venom-gpt",
        modelName: "Venom GPT",
        filePlan: {
          format: "pdf",
          title: "Board Brief",
          switchedFrom: "verify",
        },
      },
    ],
    [400, { fileProgress: { chars: 1400 } }],
    [4200, { content: "Here's the brief, distilled." }],
    [300, { file: GENERATED_FILE }],
    [200, { done: true }],
  ]);

  let downloadRequested = false;
  await page.route("**/api/venom/files/gen-file-1", async (route) => {
    downloadRequested = true;
    await route.fulfill({
      status: 200,
      contentType: "application/pdf",
      body: Buffer.from("%PDF-1.4 stub"),
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  await page.getByTestId("chat-input").fill("Turn this into a board brief");
  await page.getByTestId("send-message-button").click();

  // The writing card holds while the document forms: title, format, and
  // the promise that the overridden mode stepped aside.
  const writingCard = page.getByTestId("file-writing-card");
  await expect(writingCard).toBeVisible();
  await expect(writingCard).toContainText("Writing Board Brief");
  await expect(writingCard).toContainText("PDF");
  await expect(page.getByTestId("file-mode-note")).toContainText(
    "Verify stepped aside",
  );
  await expect(writingCard).toContainText("characters so far");

  // The turn ends with the answer and a delivery card in its place.
  await expect(page.getByText("Here's the brief, distilled.")).toBeVisible();
  const delivery = page.getByTestId("file-delivery-card");
  await expect(delivery).toBeVisible();
  await expect(delivery).toContainText("venom-board-brief-2026-08-21.pdf");
  await expect(page.getByTestId("file-writing-card")).toHaveCount(0);

  // Tapping it fetches the stored bytes with the caller's token.
  await delivery.click();
  await expect.poll(() => downloadRequested).toBe(true);
});

test("keeps the streamed answer when only the document render fails", async ({
  page,
}) => {
  await mockModels(page);
  await mockKnowledgeExtraction(page);
  await page.route("**/api/venom/respond", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sseBody([
        {
          modelId: "venom-gpt",
          modelName: "Venom GPT",
          filePlan: { format: "pdf", title: "Board Brief" },
        },
        { content: "The plan, in prose, survives." },
        {
          error: "The document could not be rendered.",
          code: "file_render_failed",
        },
        { done: true },
      ]),
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  await page.getByTestId("chat-input").fill("Write the plan as a PDF");
  await page.getByTestId("send-message-button").click();

  // The answer persists as a normal turn: no delivery card, no writing
  // card left behind, and no error state on the message.
  await expect(
    page.getByText("The plan, in prose, survives."),
  ).toBeVisible();
  await expect(page.getByTestId("file-delivery-card")).toHaveCount(0);
  await expect(page.getByTestId("file-writing-card")).toHaveCount(0);

  // A fresh send still works — the stream closed cleanly and the
  // composer re-arms once there is text again.
  await page.getByTestId("chat-input").fill("Try again");
  await expect(page.getByTestId("send-message-button")).toBeEnabled();
});
