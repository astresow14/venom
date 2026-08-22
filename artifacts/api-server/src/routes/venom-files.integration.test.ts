/**
 * Real-database integration tests for the chat file exchange routes: the
 * upload handshake (sign → PUT → complete), verification and text
 * extraction at complete time, ownership boundaries, idempotent completes,
 * and the owner-checked download. Object storage is stubbed at the module
 * seam — these tests own the database rows and the HTTP surface, not GCS.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { db, pool, venomChatFilesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import express from "express";
import router, {
  overrideVenomChatFileUserIdResolverForTests,
} from "./venom-files.js";
import {
  ChatFileObjectMissingError,
  ChatFileTooLargeError,
  MAX_CHAT_FILE_BYTES,
  overrideChatFileStorageForTests,
  type ChatFileStorage,
} from "../lib/venom-chat-file-storage.js";
import {
  CHAT_FILE_EXTRACT_CHAR_CAP,
  extractChatFileText,
  resolveChatFileType,
  sanitizeChatFileName,
} from "../lib/venom-chat-files.js";
import { renderVenomPdf } from "../lib/venom-pdf-render.js";

type TestResponse = {
  status: number;
  body: any;
  text: string;
  headers: Headers;
};

function assertStatus(response: TestResponse, expected: number): void {
  assert.equal(
    response.status,
    expected,
    `Expected HTTP ${expected}; received ${response.status}: ${JSON.stringify(response.body ?? response.text.slice(0, 300))}`,
  );
}

const createdUserIds: string[] = [];

test.after(async () => {
  if (createdUserIds.length) {
    await db
      .delete(venomChatFilesTable)
      .where(inArray(venomChatFilesTable.clerkUserId, createdUserIds));
  }
  await pool.end();
});

// ─── Type policy & extraction primitives (no HTTP needed) ────────────────────

test("resolveChatFileType accepts the closed allowlist and rejects conflicts", () => {
  assert.equal(
    resolveChatFileType({ name: "a.pdf", contentType: "application/pdf" })?.ext,
    "pdf",
  );
  // Mobile pickers claim octet-stream; a known extension carries the day.
  assert.equal(
    resolveChatFileType({
      name: "notes.md",
      contentType: "application/octet-stream",
    })?.contentType,
    "text/markdown",
  );
  assert.equal(
    resolveChatFileType({ name: "data", contentType: "text/csv" })?.ext,
    "csv",
  );
  assert.equal(
    resolveChatFileType({ name: "run.exe", contentType: "application/pdf" }),
    null,
  );
  assert.equal(
    resolveChatFileType({
      name: "archive.zip",
      contentType: "application/zip",
    }),
    null,
  );
  assert.equal(
    resolveChatFileType({
      name: "mystery",
      contentType: "application/octet-stream",
    }),
    null,
  );
});

test("resolveChatFileType admits images and keeps jpg/jpeg in agreement", () => {
  const png = resolveChatFileType({ name: "chart.PNG", contentType: "image/png" });
  assert.equal(png?.ext, "png");
  assert.equal(png?.category, "image");
  assert.equal(png?.extractable, false);

  // Both spellings resolve to the same stored content type, and the sloppy
  // image/jpg alias some pickers claim still lands on image/jpeg.
  assert.equal(
    resolveChatFileType({ name: "photo.jpg", contentType: "image/jpeg" })
      ?.contentType,
    "image/jpeg",
  );
  assert.equal(
    resolveChatFileType({ name: "photo.jpeg", contentType: "image/jpeg" })
      ?.contentType,
    "image/jpeg",
  );
  assert.equal(
    resolveChatFileType({ name: "photo.jpg", contentType: "image/jpg" })
      ?.contentType,
    "image/jpeg",
  );

  // Mobile pickers claim octet-stream for images too; extension decides.
  assert.equal(
    resolveChatFileType({
      name: "shot.webp",
      contentType: "application/octet-stream",
    })?.ext,
    "webp",
  );
  assert.equal(
    resolveChatFileType({ name: "loop.gif", contentType: "image/gif" })
      ?.category,
    "image",
  );

  // A disguised executable stays out no matter what type it claims.
  assert.equal(
    resolveChatFileType({ name: "run.exe", contentType: "image/png" }),
    null,
  );
});

test("extractChatFileText is a no-op for image attachments", async () => {
  const pngPolicy = {
    ext: "png",
    contentType: "image/png",
    category: "image" as const,
    extractable: false,
  };
  const result = await extractChatFileText(
    pngPolicy,
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  );
  assert.equal(result.text, null);
  assert.equal(result.truncated, false);
});

test("sanitizeChatFileName strips separators and controls", () => {
  assert.equal(sanitizeChatFileName("../..\\evil:name?.pdf"), "..-..-evil-name-.pdf");
  assert.equal(sanitizeChatFileName("  \u0000\u001f  "), "file");
  assert.ok(sanitizeChatFileName(`${"n".repeat(400)}.md`).length <= 160);
});

test("extractChatFileText caps text and never throws on garbage", async () => {
  const txtPolicy = {
    ext: "txt",
    contentType: "text/plain",
    category: "document" as const,
    extractable: true,
  };
  const capped = await extractChatFileText(
    txtPolicy,
    Buffer.from("y".repeat(CHAT_FILE_EXTRACT_CHAR_CAP + 500)),
  );
  assert.equal(capped.text?.length, CHAT_FILE_EXTRACT_CHAR_CAP);
  assert.equal(capped.truncated, true);

  const pdfPolicy = {
    ext: "pdf",
    contentType: "application/pdf",
    category: "document" as const,
    extractable: true,
  };
  const garbage = await extractChatFileText(
    pdfPolicy,
    Buffer.from("not a pdf at all"),
  );
  assert.equal(garbage.text, null);
  assert.equal(garbage.truncated, false);
});

// ─── Routes ───────────────────────────────────────────────────────────────────

test("chat file upload handshake, extraction, ownership, and download", async () => {
  const suffix = randomUUID();
  const ownerId = `cf-owner-${suffix}`;
  const strangerId = `cf-stranger-${suffix}`;
  createdUserIds.push(ownerId, strangerId);

  // In-memory object store standing in for private storage.
  const objects = new Map<string, { contentType: string; data: Buffer }>();
  const storageStub: ChatFileStorage = {
    async createUploadUrl(objectPath) {
      return `https://storage.test/put${objectPath}`;
    },
    async headSize(objectPath) {
      const entry = objects.get(objectPath);
      if (!entry) throw new ChatFileObjectMissingError();
      if (entry.data.byteLength > MAX_CHAT_FILE_BYTES) {
        throw new ChatFileTooLargeError();
      }
      return { size: entry.data.byteLength };
    },
    async downloadBounded(objectPath) {
      const entry = objects.get(objectPath);
      if (!entry) throw new ChatFileObjectMissingError();
      return entry.data;
    },
    async uploadBuffer(objectPath, contentType, data) {
      objects.set(objectPath, { contentType, data });
    },
    async deleteObject(objectPath) {
      objects.delete(objectPath);
    },
  };
  overrideChatFileStorageForTests(storageStub);
  let activeUserId: string | null = ownerId;
  overrideVenomChatFileUserIdResolverForTests(() => activeUserId);

  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.log = {
      info: () => {},
      warn: () => {},
      error: () => {},
    } as unknown as typeof request.log;
    next();
  });
  app.use(router);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function request(
    path: string,
    options: RequestInit = {},
  ): Promise<TestResponse> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: { "content-type": "application/json", ...options.headers },
    });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: response.status, body, text, headers: response.headers };
  }

  const objectPathFromTicket = (ticket: TestResponse): string =>
    new URL(ticket.body.uploadUrl).pathname.replace("/put", "");

  try {
    // --- Handshake for a markdown upload ---------------------------------
    const ticket = await request("/venom/files/uploads", {
      method: "POST",
      body: JSON.stringify({
        name: "notes.md",
        contentType: "text/markdown",
        size: 512,
      }),
    });
    assertStatus(ticket, 200);
    assert.equal(ticket.body.file.status, "pending");
    assert.equal(ticket.body.file.kind, "upload");
    assert.equal(ticket.body.maxBytes, MAX_CHAT_FILE_BYTES);
    assert.match(ticket.body.uploadUrl, /^https:\/\/storage\.test\/put\//);
    // The API shape never leaks storage paths or extracted text.
    assert.equal("objectPath" in ticket.body.file, false);
    assert.equal("extractedText" in ticket.body.file, false);

    // --- Completing before the bytes arrive names the problem ------------
    const early = await request(
      `/venom/files/uploads/${ticket.body.file.id}/complete`,
      { method: "POST" },
    );
    assertStatus(early, 400);
    assert.equal(early.body.code, "upload_missing");

    // --- Bytes arrive; complete verifies, extracts, marks ready ----------
    const mdBody = "# Heading\n\nBody text with **bold** substance.";
    objects.set(objectPathFromTicket(ticket), {
      contentType: "text/markdown",
      data: Buffer.from(mdBody),
    });
    const completed = await request(
      `/venom/files/uploads/${ticket.body.file.id}/complete`,
      { method: "POST" },
    );
    assertStatus(completed, 200);
    assert.equal(completed.body.status, "ready");
    assert.equal(completed.body.size, Buffer.byteLength(mdBody));
    assert.equal(completed.body.textExtracted, true);

    // Complete is idempotent for retry safety.
    const again = await request(
      `/venom/files/uploads/${ticket.body.file.id}/complete`,
      { method: "POST" },
    );
    assertStatus(again, 200);
    assert.equal(again.body.status, "ready");

    // Extraction really landed in the store (server-side check).
    const [mdRow] = await db
      .select()
      .from(venomChatFilesTable)
      .where(eq(venomChatFilesTable.id, ticket.body.file.id));
    assert.match(mdRow.extractedText ?? "", /Body text/);

    // --- PDF upload round-trips through the real extractor ---------------
    const pdfBytes = Buffer.from(
      await renderVenomPdf({
        title: "Quarterly Plan",
        markdown: "# Goals\n\nShip the chat file exchange.",
      }),
    );
    const pdfTicket = await request("/venom/files/uploads", {
      method: "POST",
      body: JSON.stringify({
        name: "plan.pdf",
        contentType: "application/pdf",
        size: pdfBytes.byteLength,
      }),
    });
    assertStatus(pdfTicket, 200);
    objects.set(objectPathFromTicket(pdfTicket), {
      contentType: "application/pdf",
      data: pdfBytes,
    });
    const pdfCompleted = await request(
      `/venom/files/uploads/${pdfTicket.body.file.id}/complete`,
      { method: "POST" },
    );
    assertStatus(pdfCompleted, 200);
    assert.equal(pdfCompleted.body.textExtracted, true);
    const [pdfRow] = await db
      .select()
      .from(venomChatFilesTable)
      .where(eq(venomChatFilesTable.id, pdfTicket.body.file.id));
    assert.match(pdfRow.extractedText ?? "", /chat file exchange/);

    // --- Image upload: verified and ready, with no text extraction -------
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const imageTicket = await request("/venom/files/uploads", {
      method: "POST",
      body: JSON.stringify({
        name: "pixel.png",
        contentType: "image/png",
        size: pngBytes.byteLength,
      }),
    });
    assertStatus(imageTicket, 200);
    objects.set(objectPathFromTicket(imageTicket), {
      contentType: "image/png",
      data: pngBytes,
    });
    const imageCompleted = await request(
      `/venom/files/uploads/${imageTicket.body.file.id}/complete`,
      { method: "POST" },
    );
    assertStatus(imageCompleted, 200);
    assert.equal(imageCompleted.body.status, "ready");
    assert.equal(imageCompleted.body.contentType, "image/png");
    assert.equal(imageCompleted.body.textExtracted, false);

    // --- Unsupported types are rejected before a byte is stored ----------
    const exe = await request("/venom/files/uploads", {
      method: "POST",
      body: JSON.stringify({
        name: "evil.exe",
        contentType: "application/octet-stream",
        size: 10,
      }),
    });
    assertStatus(exe, 400);
    assert.equal(exe.body.code, "unsupported_file_type");
    // The rejection copy names the image formats now that they're accepted.
    assert.match(exe.body.error ?? "", /PNG, JPEG, WEBP, or GIF images/);

    const oversized = await request("/venom/files/uploads", {
      method: "POST",
      body: JSON.stringify({
        name: "big.pdf",
        contentType: "application/pdf",
        size: MAX_CHAT_FILE_BYTES + 1,
      }),
    });
    assertStatus(oversized, 400);

    // --- Download own ready file: bytes and headers -----------------------
    const download = await fetch(
      `${baseUrl}/venom/files/${ticket.body.file.id}`,
    );
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-type") ?? "", /text\/markdown/);
    assert.match(
      download.headers.get("content-disposition") ?? "",
      /attachment; filename="notes\.md"/,
    );
    assert.equal(await download.text(), mdBody);

    // --- A reused ticket URL cannot rewrite verified content --------------
    // The signed PUT stays valid for its TTL; writing to the ticket path
    // after completion must not change what downloads serve.
    objects.set(objectPathFromTicket(ticket), {
      contentType: "text/markdown",
      data: Buffer.from("tampered after ready"),
    });
    const sealedDownload = await fetch(
      `${baseUrl}/venom/files/${ticket.body.file.id}`,
    );
    assert.equal(sealedDownload.status, 200);
    assert.equal(await sealedDownload.text(), mdBody);

    // --- Ownership boundary: strangers see 404, never 403 -----------------
    activeUserId = strangerId;
    const foreignDownload = await fetch(
      `${baseUrl}/venom/files/${ticket.body.file.id}`,
    );
    assert.equal(foreignDownload.status, 404);
    const foreignComplete = await request(
      `/venom/files/uploads/${ticket.body.file.id}/complete`,
      { method: "POST" },
    );
    assertStatus(foreignComplete, 404);

    // --- Pending files are not downloadable -------------------------------
    activeUserId = ownerId;
    const pendingTicket = await request("/venom/files/uploads", {
      method: "POST",
      body: JSON.stringify({
        name: "pending.txt",
        contentType: "text/plain",
        size: 5,
      }),
    });
    assertStatus(pendingTicket, 200);
    const pendingDownload = await fetch(
      `${baseUrl}/venom/files/${pendingTicket.body.file.id}`,
    );
    assert.equal(pendingDownload.status, 404);

    // --- Unauthenticated callers get 401 everywhere -----------------------
    activeUserId = null;
    for (const [path, method] of [
      ["/venom/files/uploads", "POST"],
      [`/venom/files/uploads/${ticket.body.file.id}/complete`, "POST"],
      [`/venom/files/${ticket.body.file.id}`, "GET"],
    ] as const) {
      const denied = await request(path, {
        method,
        ...(method === "POST" ? { body: JSON.stringify({}) } : {}),
      });
      assertStatus(denied, 401);
    }
  } finally {
    server.close();
    overrideVenomChatFileUserIdResolverForTests(null);
    overrideChatFileStorageForTests(null);
  }
});
