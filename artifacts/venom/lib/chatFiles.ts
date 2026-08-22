import { Platform } from "react-native";
import { fetch as expoFetch } from "expo/fetch";
import { File as FsFile, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import {
  completeVenomChatFileUpload,
  createVenomChatFileUpload,
  type VenomChatFile,
  type VenomMessageAttachment,
} from "@workspace/api-client-react";

/**
 * Chat file exchange, mobile side. Uploads run the same three-step
 * handshake as the desktop app (ticket, raw PUT of the bytes, complete);
 * downloads fetch the stored bytes with the caller's token and hand them
 * to the platform: a real download on web, the OS share sheet on native
 * so the user picks where the document goes.
 */

export const MAX_CHAT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENTS = 5;

/** Formats the server accepts, keyed by extension. */
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * Extensions that arrive as photos but upload as JPEG: the pipeline
 * converts them before the PUT, so the preflight lets them through even
 * though the server never sees these types directly.
 */
const CONVERTIBLE_IMAGE_EXTENSIONS = new Set(["heic", "heif"]);

/** Picker filter: the same allowlist expressed as MIME types. */
export const CHAT_FILE_MIME_TYPES = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Whether a picked file will ride as an image attachment. */
export function isImageName(name: string): boolean {
  const extension = fileExtension(name);
  return (
    CONTENT_TYPE_BY_EXTENSION[extension]?.startsWith("image/") === true ||
    CONVERTIBLE_IMAGE_EXTENSIONS.has(extension)
  );
}

/** Whether a message attachment stamp points at an image. */
export function isImageAttachment(attachment: {
  contentType: string;
}): boolean {
  return attachment.contentType.startsWith("image/");
}

/** Preflight check; returns a user-facing problem or null when fine. */
export function chatFileProblem(name: string, size: number): string | null {
  const extension = fileExtension(name);
  if (
    !CONTENT_TYPE_BY_EXTENSION[extension] &&
    !CONVERTIBLE_IMAGE_EXTENSIONS.has(extension)
  ) {
    return "Venom reads PDF, text, Markdown, CSV, JSON, and PNG, JPEG, WEBP, or GIF images.";
  }
  if (size > MAX_CHAT_FILE_BYTES) {
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

/** The compact stamp a message carries for one stored file. */
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

/** Pulls the server's own words out of a failed request, if present. */
export function chatFileErrorMessage(
  error: unknown,
  fallback = "The file couldn't be uploaded. Try again.",
): string {
  const data = (error as { data?: { error?: unknown } } | null)?.data;
  if (data && typeof data.error === "string" && data.error) return data.error;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function apiBaseUrl(): string {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (!domain) throw new Error("API domain is unavailable");
  return `https://${domain}`;
}

/** Signed upload URLs are usually absolute; dev fallbacks may be relative. */
function absoluteUrl(url: string): string {
  return url.startsWith("/") ? `${apiBaseUrl()}${url}` : url;
}

/**
 * What the upload handshake needs from a picked file — both the document
 * picker's and the photo picker's asset shapes satisfy it.
 */
export type ChatUploadSource = {
  uri: string;
  name?: string | null;
  size?: number | null;
  mimeType?: string | null;
  /** Web pickers may carry the real File; uploads prefer it. */
  file?: File;
};

async function assetBytes(
  asset: ChatUploadSource,
): Promise<Blob | Uint8Array> {
  if (Platform.OS === "web") {
    if (asset.file) return asset.file;
    const response = await fetch(asset.uri);
    return await response.blob();
  }
  // Native: the picker copied the document into the app cache; read it
  // straight from disk rather than fetching a file:// URI.
  return await new FsFile(asset.uri).bytes();
}

/**
 * Runs the full upload handshake for one picked file and resolves with
 * the stored, ready-to-attach record. The ticket size comes from the real
 * bytes — picker metadata may be missing or stale (photos especially).
 */
export async function uploadChatFile(
  asset: ChatUploadSource,
  token: string,
): Promise<VenomChatFile> {
  const name = asset.name ?? "file";
  const contentType =
    CONTENT_TYPE_BY_EXTENSION[fileExtension(name)] ??
    asset.mimeType ??
    "application/octet-stream";
  const auth = { headers: { Authorization: `Bearer ${token}` } };

  const bytes = await assetBytes(asset);
  const size = bytes instanceof Uint8Array ? bytes.byteLength : bytes.size;

  const ticket = await createVenomChatFileUpload(
    { name, contentType, size },
    auth,
  );

  const putUrl = absoluteUrl(ticket.uploadUrl);
  const put =
    Platform.OS === "web"
      ? await fetch(putUrl, {
          method: "PUT",
          headers: { "Content-Type": contentType },
          body: bytes as Blob,
        })
      : await expoFetch(putUrl, {
          method: "PUT",
          headers: { "Content-Type": contentType },
          body: bytes as Uint8Array<ArrayBuffer>,
        });
  if (!put.ok) {
    throw new Error("The upload didn't finish. Try again.");
  }

  return await completeVenomChatFileUpload(ticket.file.id, auth);
}

type WebDocument = {
  createElement: (tag: string) => {
    href: string;
    download: string;
    click: () => void;
    remove: () => void;
  };
  body: { appendChild: (node: unknown) => void };
};

type WebUrl = {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (href: string) => void;
};

/**
 * Fetches a stored chat file and delivers it: browser download on web,
 * the share sheet on iOS/Android (Files, mail, another app).
 */
export async function downloadChatFile(
  attachment: VenomMessageAttachment,
  token: string,
): Promise<void> {
  const url = `${apiBaseUrl()}/api/venom/files/${attachment.id}`;
  const headers = { Authorization: `Bearer ${token}` };

  if (Platform.OS === "web") {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw Object.assign(
        new Error("The file couldn't be downloaded. Try again."),
        { status: response.status },
      );
    }
    const blob = await response.blob();
    const doc = (globalThis as { document?: WebDocument }).document;
    const webUrl = (globalThis as { URL?: WebUrl }).URL;
    if (!doc || typeof webUrl?.createObjectURL !== "function") {
      throw new Error("Downloads aren't available here.");
    }
    const href = webUrl.createObjectURL(blob);
    const anchor = doc.createElement("a");
    anchor.href = href;
    anchor.download = attachment.name;
    doc.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    webUrl.revokeObjectURL(href);
    return;
  }

  const response = await expoFetch(url, { headers });
  if (!response.ok) {
    throw Object.assign(
      new Error("The file couldn't be downloaded. Try again."),
      { status: response.status },
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const target = new FsFile(Paths.cache, attachment.name);
  if (target.exists) target.delete();
  target.create();
  target.write(bytes);
  await Sharing.shareAsync(target.uri, {
    mimeType: attachment.contentType,
    dialogTitle: attachment.name,
  });
}
