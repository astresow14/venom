/**
 * Chat file exchange routes: the upload handshake (sign → PUT → complete)
 * and the owner-checked download.
 *
 * Bytes never pass through this server on upload — clients PUT directly to
 * private object storage with a one-time signed URL. The complete step is
 * where claims become facts: the object is HEAD-verified, downloaded within
 * bounds, text-extracted for model context, and the verified bytes are
 * sealed into a fresh private object before the row is marked ready. The
 * signed PUT URL stays valid for its TTL, so serving from the ticket path
 * would let a ticket holder rewrite content after verification — downloads
 * only ever read the sealed copy.
 * Nothing pending or foreign is ever attachable, downloadable, or injected.
 */
import { Router, type IRouter, type Request } from "express";
import { getAuth } from "@clerk/express";
import { CreateVenomChatFileUploadBody } from "@workspace/api-zod";
import {
  chatFileStorage,
  ChatFileObjectMissingError,
  ChatFileTooLargeError,
  createChatFileObjectPath,
  MAX_CHAT_FILE_BYTES,
} from "../lib/venom-chat-file-storage";
import {
  extractChatFileText,
  findOwnedChatFile,
  insertPendingChatUpload,
  markChatUploadReady,
  resolveChatFileType,
  sanitizeChatFileName,
  toApiChatFile,
} from "../lib/venom-chat-files";

const router: IRouter = Router();

const FILE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

const UPLOAD_RATE_LIMIT_WINDOW_MS = 5 * 60_000;
const UPLOAD_RATE_LIMIT_MAX = 30;
const uploadRateLimits = new Map<string, { count: number; resetAt: number }>();

function takeUploadRateLimitSlot(userId: string): boolean {
  const now = Date.now();
  const current = uploadRateLimits.get(userId);
  if (!current || current.resetAt <= now) {
    uploadRateLimits.set(userId, {
      count: 1,
      resetAt: now + UPLOAD_RATE_LIMIT_WINDOW_MS,
    });
    if (uploadRateLimits.size > 2_000) {
      for (const [key, limit] of uploadRateLimits) {
        if (limit.resetAt <= now) uploadRateLimits.delete(key);
      }
    }
    return true;
  }
  if (current.count >= UPLOAD_RATE_LIMIT_MAX) return false;
  current.count += 1;
  return true;
}

type UserIdResolver = (req: Request) => string | null;
const clerkUserIdResolver: UserIdResolver = (req) => getAuth(req).userId;
let resolveUserId: UserIdResolver = clerkUserIdResolver;

/** Test seam mirroring venom-exports: swap auth resolution in route tests. */
export function overrideVenomChatFileUserIdResolverForTests(
  resolver: UserIdResolver | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("User id resolver overrides are available only in tests");
  }
  resolveUserId = resolver ?? clerkUserIdResolver;
}

/** ASCII-safe Content-Disposition value; quotes and controls stripped. */
function contentDispositionFor(name: string): string {
  const ascii = name
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_")
    .trim();
  const encoded = encodeURIComponent(name).replace(/['()]/g, escape);
  return `attachment; filename="${ascii || "file"}"; filename*=UTF-8''${encoded}`;
}

router.post("/venom/files/uploads", async (req, res): Promise<void> => {
  const userId = resolveUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!takeUploadRateLimitSlot(userId)) {
    res.status(429).json({ error: "Too many uploads. Try again shortly." });
    return;
  }
  const parsed = CreateVenomChatFileUploadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid upload request" });
    return;
  }
  const policy = resolveChatFileType({
    name: parsed.data.name,
    contentType: parsed.data.contentType,
  });
  if (!policy) {
    res.status(400).json({
      error:
        "Unsupported file type. Venom accepts PDF, TXT, MD, CSV, JSON, and PNG, JPEG, WEBP, or GIF images.",
      code: "unsupported_file_type",
    });
    return;
  }
  if (parsed.data.size > MAX_CHAT_FILE_BYTES) {
    res.status(400).json({
      error: "That file is larger than the 10 MB limit.",
      code: "file_too_large",
    });
    return;
  }

  try {
    const objectPath = createChatFileObjectPath(userId, "upload", policy.ext);
    const uploadUrl = await chatFileStorage().createUploadUrl(objectPath);
    const row = await insertPendingChatUpload({
      userId,
      name: sanitizeChatFileName(parsed.data.name),
      contentType: policy.contentType,
      size: parsed.data.size,
      objectPath,
    });
    res.json({
      file: toApiChatFile(row),
      uploadUrl,
      maxBytes: MAX_CHAT_FILE_BYTES,
    });
  } catch (error) {
    req.log.error({ err: error }, "Venom chat file upload handshake failed");
    res.status(500).json({ error: "Could not start the upload" });
  }
});

router.post(
  "/venom/files/uploads/:fileId/complete",
  async (req, res): Promise<void> => {
    const userId = resolveUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const fileId = req.params.fileId;
    if (!FILE_ID_PATTERN.test(fileId)) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    try {
      const row = await findOwnedChatFile(userId, fileId);
      if (!row || row.kind !== "upload") {
        res.status(404).json({ error: "File not found" });
        return;
      }
      if (row.status === "ready") {
        // Idempotent: a retried complete after a dropped response is fine.
        res.json(toApiChatFile(row));
        return;
      }

      let size: number;
      try {
        ({ size } = await chatFileStorage().headSize(row.objectPath));
      } catch (error) {
        if (error instanceof ChatFileObjectMissingError) {
          res.status(400).json({
            error: "The file bytes never arrived. Upload it again.",
            code: "upload_missing",
          });
          return;
        }
        if (error instanceof ChatFileTooLargeError) {
          void chatFileStorage()
            .deleteObject(row.objectPath)
            .catch(() => undefined);
          res.status(400).json({
            error: "That file is larger than the 10 MB limit.",
            code: "file_too_large",
          });
          return;
        }
        throw error;
      }

      const policy = resolveChatFileType({
        name: row.name,
        contentType: row.contentType,
      });
      const data = await chatFileStorage().downloadBounded(row.objectPath);
      let extractedText: string | null = null;
      let extractedTruncated = false;
      if (policy) {
        const extraction = await extractChatFileText(policy, data);
        extractedText = extraction.text;
        extractedTruncated = extraction.truncated;
      }

      // Seal exactly the bytes we verified and extracted into a fresh
      // object the still-valid ticket URL cannot touch, and serve only
      // that copy from here on.
      const sealedPath = createChatFileObjectPath(
        userId,
        row.id,
        policy?.ext ?? "bin",
      );
      await chatFileStorage().uploadBuffer(
        sealedPath,
        row.contentType,
        data,
      );

      const updated = await markChatUploadReady(row.id, {
        size: data.byteLength,
        extractedText,
        extractedTruncated,
        objectPath: sealedPath,
      });
      void chatFileStorage()
        .deleteObject(row.objectPath)
        .catch(() => undefined);
      if (!updated) {
        res.status(404).json({ error: "File not found" });
        return;
      }
      req.log.info(
        {
          fileId: row.id,
          size,
          textExtracted: extractedText != null,
          truncated: extractedTruncated,
        },
        "Venom chat file upload completed",
      );
      res.json(toApiChatFile(updated));
    } catch (error) {
      req.log.error(
        { err: error, fileId },
        "Venom chat file completion failed",
      );
      res.status(500).json({ error: "Could not verify the upload" });
    }
  },
);

router.get("/venom/files/:fileId", async (req, res): Promise<void> => {
  const userId = resolveUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const fileId = req.params.fileId;
  if (!FILE_ID_PATTERN.test(fileId)) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  try {
    const row = await findOwnedChatFile(userId, fileId);
    if (!row || row.status !== "ready") {
      res.status(404).json({ error: "File not found" });
      return;
    }
    const data = await chatFileStorage().downloadBounded(row.objectPath);
    res.setHeader("Content-Type", row.contentType);
    res.setHeader("Content-Disposition", contentDispositionFor(row.name));
    res.setHeader("Cache-Control", "private, max-age=0");
    res.send(data);
  } catch (error) {
    req.log.error({ err: error, fileId }, "Venom chat file download failed");
    res.status(500).json({ error: "Could not read the file" });
  }
});

export default router;
