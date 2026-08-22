/**
 * Private object storage for Venom chat files (host uploads and files Venom
 * generates in chat).
 *
 * Mirrors the sidecar signed-URL integration in portfolio-storage.ts but is
 * deliberately self-contained: chat files have their own path namespace, a
 * smaller size ceiling, and a test override seam so route integration tests
 * stub this boundary instead of talking to real object storage.
 *
 * Signed URLs are transient credentials: the PUT URL is returned to the
 * owning client exactly once for the upload handshake; GET/HEAD/DELETE URLs
 * never leave this module.
 */
import { randomUUID } from "node:crypto";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const SIGNED_URL_TTL_SECONDS = 15 * 60;

/** Hard byte ceiling for any chat file, uploaded or generated. */
export const MAX_CHAT_FILE_BYTES = 10 * 1024 * 1024;

export class ChatFileObjectMissingError extends Error {
  constructor() {
    super("The uploaded file was not found in storage");
  }
}

export class ChatFileTooLargeError extends Error {
  constructor() {
    super("The file exceeds the size limit");
  }
}

type ObjectMethod = "GET" | "PUT" | "DELETE" | "HEAD";

export type ChatFileStorage = {
  createUploadUrl(objectPath: string): Promise<string>;
  /** HEAD the object; throws ChatFileObjectMissingError / ChatFileTooLargeError. */
  headSize(objectPath: string): Promise<{ size: number }>;
  downloadBounded(objectPath: string, maxBytes?: number): Promise<Buffer>;
  uploadBuffer(
    objectPath: string,
    contentType: string,
    data: Buffer,
  ): Promise<void>;
  deleteObject(objectPath: string): Promise<void>;
};

function getPrivateObjectDir(): string {
  const value = process.env.PRIVATE_OBJECT_DIR?.replace(/\/+$/, "");
  if (!value) {
    throw new Error("Private object storage is not configured");
  }
  return value.startsWith("/") ? value : `/${value}`;
}

function parseFullObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  const parts = path.replace(/^\/+/, "").split("/");
  const bucketName = parts.shift();
  if (!bucketName || parts.length === 0) {
    throw new Error("Invalid private object path");
  }
  return { bucketName, objectName: parts.join("/") };
}

function toFullObjectPath(objectPath: string): string {
  if (!objectPath.startsWith("/objects/")) {
    throw new Error("Invalid stored object path");
  }
  return `${getPrivateObjectDir()}/${objectPath.slice("/objects/".length)}`;
}

async function signObjectUrl(
  objectPath: string,
  method: ObjectMethod,
): Promise<string> {
  const { bucketName, objectName } = parseFullObjectPath(
    toFullObjectPath(objectPath),
  );
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket_name: bucketName,
        object_name: objectName,
        method,
        expires_at: new Date(
          Date.now() + SIGNED_URL_TTL_SECONDS * 1000,
        ).toISOString(),
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Unable to sign private object request (${response.status})`,
    );
  }
  const body = (await response.json()) as { signed_url?: unknown };
  if (typeof body.signed_url !== "string") {
    throw new Error("Object storage returned an invalid signed URL");
  }
  return body.signed_url;
}

const realChatFileStorage: ChatFileStorage = {
  async createUploadUrl(objectPath) {
    return signObjectUrl(objectPath, "PUT");
  },

  async headSize(objectPath) {
    const response = await fetch(await signObjectUrl(objectPath, "HEAD"), {
      method: "HEAD",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) {
      throw new ChatFileObjectMissingError();
    }
    if (!response.ok) {
      throw new Error(`Unable to inspect uploaded file (${response.status})`);
    }
    const size = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new Error("Uploaded file size is unavailable");
    }
    if (size > MAX_CHAT_FILE_BYTES) {
      throw new ChatFileTooLargeError();
    }
    return { size };
  },

  async downloadBounded(objectPath, maxBytes = MAX_CHAT_FILE_BYTES) {
    const response = await fetch(await signObjectUrl(objectPath, "GET"), {
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 404) {
      throw new ChatFileObjectMissingError();
    }
    if (!response.ok || !response.body) {
      throw new Error(`Unable to read chat file (${response.status})`);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ChatFileTooLargeError();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  },

  async uploadBuffer(objectPath, contentType, data) {
    if (data.byteLength > MAX_CHAT_FILE_BYTES) {
      throw new ChatFileTooLargeError();
    }
    const response = await fetch(await signObjectUrl(objectPath, "PUT"), {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(data.byteLength),
      },
      body: data,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`Unable to store generated file (${response.status})`);
    }
  },

  async deleteObject(objectPath) {
    const response = await fetch(await signObjectUrl(objectPath, "DELETE"), {
      method: "DELETE",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Unable to delete chat file (${response.status})`);
    }
  },
};

let activeStorage: ChatFileStorage = realChatFileStorage;

export function chatFileStorage(): ChatFileStorage {
  return activeStorage;
}

export function overrideChatFileStorageForTests(
  stub: ChatFileStorage | null,
): () => void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Chat file storage overrides are available only in tests");
  }
  const previous = activeStorage;
  activeStorage = stub ?? realChatFileStorage;
  return () => {
    activeStorage = previous;
  };
}

/** Stable private-storage path for one chat file object. */
export function createChatFileObjectPath(
  userId: string,
  fileId: string,
  ext: string,
): string {
  // The user id segment is hashed into the id-bearing filename rather than
  // trusted raw: Clerk ids are path-safe today, but the path must never
  // depend on that staying true.
  const safeUser = userId.replace(/[^A-Za-z0-9_-]/g, "");
  return `/objects/venom-chat-files/${safeUser || "user"}/${fileId}-${randomUUID()}.${ext}`;
}
