/**
 * Chat file exchange, browser side: the signed-URL upload handshake, the
 * authenticated download, and the small shared vocabulary (accept list,
 * size cap, display formatting) the composer and message cards use.
 *
 * The storage PUT is a raw fetch against the signed URL — it must not ride
 * the generated client, whose base URL and credentials are for the API only.
 * The download is also a raw fetch: it needs the bytes as a Blob, while the
 * generated client's sniffing would hand text formats back as strings.
 */
import {
  completeVenomChatFileUpload,
  createVenomChatFileUpload,
  type VenomChatFile,
  type VenomMessageAttachment,
} from "@workspace/api-client-react";

/** Server-enforced cap, mirrored for the pre-flight check. */
export const MAX_CHAT_FILE_BYTES = 10 * 1024 * 1024;
/** Attachments allowed on a single chat message (server drops extras). */
export const MAX_MESSAGE_ATTACHMENTS = 5;
/** The closed set of types chat accepts, as an input[accept] string. */
export const CHAT_FILE_ACCEPT =
  ".pdf,.txt,.md,.csv,.json,.png,.jpg,.jpeg,.webp,.gif";

const ACCEPTED_EXTENSIONS = new Set(["pdf", "txt", "md", "csv", "json"]);
const ACCEPTED_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

function fileExtension(name: string): string | null {
  return (
    /\.([A-Za-z0-9]{1,8})$/.exec(name.trim())?.[1]?.toLowerCase() ?? null
  );
}

/** Whether a picked/dropped/pasted file is one of the accepted image types. */
export function isImageFile(file: File): boolean {
  const extension = fileExtension(file.name);
  return extension != null && ACCEPTED_IMAGE_EXTENSIONS.has(extension);
}

/** Whether a message attachment stamp points at an image. */
export function isImageAttachment(attachment: {
  contentType: string;
}): boolean {
  return attachment.contentType.startsWith("image/");
}

/** A file the composer is holding: uploading, ready to send, or failed. */
export type PendingChatFile = {
  localId: string;
  name: string;
  size: number;
  status: "uploading" | "ready" | "error";
  /** Present once the upload completed; this is what rides the message. */
  stamp?: VenomMessageAttachment;
  error?: string;
  /** Tiny data-URL preview, present for image files once generated. */
  thumbnail?: string;
};

/**
 * Pre-flight check mirroring the server's allowlist so obvious rejects
 * never leave the browser. Returns a human-readable problem, or null.
 */
export function chatFileProblem(file: File): string | null {
  const extension = fileExtension(file.name);
  if (
    !extension ||
    (!ACCEPTED_EXTENSIONS.has(extension) &&
      !ACCEPTED_IMAGE_EXTENSIONS.has(extension))
  ) {
    return "Venom reads PDF, text, Markdown, CSV, JSON, and PNG, JPEG, WEBP, or GIF images.";
  }
  if (file.size === 0) {
    return "That file is empty.";
  }
  if (file.size > MAX_CHAT_FILE_BYTES) {
    return `Files can be up to ${formatFileSize(MAX_CHAT_FILE_BYTES)}.`;
  }
  return null;
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Friendliest available message from a failed upload or download. */
export function chatFileErrorMessage(error: unknown): string {
  const data = (error as { data?: { error?: unknown } | null } | null)?.data;
  if (data && typeof data.error === "string" && data.error) return data.error;
  if (error instanceof Error && error.message) return error.message;
  return "The upload failed.";
}

/** The compact stamp a message carries; resolves back to the stored file. */
export function attachmentStamp(
  file: VenomChatFile,
  thumbnail?: string,
): VenomMessageAttachment {
  return {
    id: file.id,
    name: file.name,
    contentType: file.contentType,
    size: file.size,
    kind: file.kind,
    ...(thumbnail ? { thumbnail } : {}),
  };
}

/**
 * Full upload handshake: reserve a ticket, PUT the bytes to the signed URL,
 * then ask the server to verify and extract. Resolves to the ready file.
 */
export async function uploadChatFile(
  file: File,
  signal?: AbortSignal,
): Promise<VenomChatFile> {
  const ticket = await createVenomChatFileUpload(
    {
      name: file.name,
      contentType: file.type || "application/octet-stream",
      size: file.size,
    },
    { signal },
  );
  const put = await fetch(ticket.uploadUrl, {
    method: "PUT",
    body: file,
    headers: { "content-type": ticket.file.contentType },
    signal,
  });
  if (!put.ok) {
    throw new Error(`The storage upload failed (HTTP ${put.status}).`);
  }
  return completeVenomChatFileUpload(ticket.file.id, { signal });
}

/** Authenticated download of an owned chat file, saved via a Blob anchor. */
export async function downloadChatFile(attachment: {
  id: string;
  name: string;
}): Promise<void> {
  const response = await fetch(
    `/api/venom/files/${encodeURIComponent(attachment.id)}`,
    { credentials: "include" },
  );
  if (!response.ok) {
    throw new Error(`The download failed (HTTP ${response.status}).`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = attachment.name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
