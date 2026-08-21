import { createHash, randomUUID } from "node:crypto";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const SIGNED_URL_TTL_SECONDS = 15 * 60;
export const MAX_PORTFOLIO_ARCHIVE_BYTES = 50 * 1024 * 1024;

type ObjectMethod = "GET" | "PUT" | "DELETE" | "HEAD";

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
    throw new Error(`Unable to sign private object request (${response.status})`);
  }
  const body = (await response.json()) as { signed_url?: unknown };
  if (typeof body.signed_url !== "string") {
    throw new Error("Object storage returned an invalid signed URL");
  }
  return body.signed_url;
}

export function createUploadObjectPath(
  appId: string,
  importJobId: string,
): string {
  return `/objects/venom-portfolio/uploads/${appId}/${importJobId}-${randomUUID()}.zip`;
}

export function createPackageObjectPath(
  appId: string,
  checksumSha256: string,
): string {
  return `/objects/venom-portfolio/packages/${appId}/${randomUUID()}-${checksumSha256}.zip`;
}

export async function createArchiveUploadUrl(
  objectPath: string,
): Promise<string> {
  return signObjectUrl(objectPath, "PUT");
}

/**
 * Generate a short-lived (≈15 min TTL) signed GET URL for a retained source
 * archive so a trusted external gateway can download and checksum-verify it.
 *
 * The returned URL is transient and must NEVER be persisted, returned to
 * clients, or logged — it grants time-limited read access to a private object.
 * Callers should place it only in the outbound provider handoff call.
 */
export async function createSourceArchiveDownloadUrl(
  objectPath: string,
): Promise<string> {
  return signObjectUrl(objectPath, "GET");
}

export async function objectExistsWithinLimit(
  objectPath: string,
): Promise<{ size: number }> {
  const response = await fetch(await signObjectUrl(objectPath, "HEAD"), {
    method: "HEAD",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) {
    throw new Error("Uploaded archive was not found");
  }
  if (!response.ok) {
    throw new Error(`Unable to inspect uploaded archive (${response.status})`);
  }
  const size = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new Error("Uploaded archive size is unavailable");
  }
  if (size > MAX_PORTFOLIO_ARCHIVE_BYTES) {
    throw new Error("Uploaded archive exceeds the size limit");
  }
  return { size };
}

export async function downloadArchiveBounded(
  objectPath: string,
): Promise<Buffer> {
  await objectExistsWithinLimit(objectPath);
  const response = await fetch(await signObjectUrl(objectPath, "GET"), {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Unable to read uploaded archive (${response.status})`);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PORTFOLIO_ARCHIVE_BYTES) {
      await reader.cancel();
      throw new Error("Uploaded archive exceeds the size limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

export async function retainImmutableArchive(
  objectPath: string,
  appId: string,
  archive: Buffer,
): Promise<{ objectPath: string; checksumSha256: string }> {
  const checksumSha256 = createHash("sha256").update(archive).digest("hex");
  const packageObjectPath = createPackageObjectPath(appId, checksumSha256);
  const response = await fetch(
    await signObjectUrl(packageObjectPath, "PUT"),
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(archive.byteLength),
      },
      body: archive,
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Unable to retain source package (${response.status})`);
  }
  await deletePrivateObject(objectPath);
  return { objectPath: packageObjectPath, checksumSha256 };
}

export async function deletePrivateObject(objectPath: string): Promise<void> {
  try {
    const response = await fetch(await signObjectUrl(objectPath, "DELETE"), {
      method: "DELETE",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Unable to delete private object (${response.status})`);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Uploaded archive was not found"
    ) {
      return;
    }
    throw error;
  }
}