/**
 * Venom chat files: type policy, bounded text extraction, and the owner-scoped
 * database store behind uploads and generated files.
 *
 * Everything the model ever sees from an uploaded file flows through
 * `extractChatFileText`, which caps the text and strips control characters at
 * extraction time — injection framing happens at request time in venom.ts.
 * The API never returns extracted text; it exists solely for model context.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, venomChatFilesTable, type VenomChatFileRow } from "@workspace/db";

/** Characters of extracted text retained per file for model context. */
export const CHAT_FILE_EXTRACT_CHAR_CAP = 60_000;
/**
 * Hard page ceiling for PDF text extraction. A 10 MB PDF can compress into
 * thousands of pages; extraction walks pages one at a time and stops at
 * whichever bound lands first, so a decompression bomb cannot balloon
 * memory past the character cap's worth of text.
 */
const MAX_PDF_EXTRACT_PAGES = 200;
/** Attachments allowed on a single chat message. */
export const MAX_MESSAGE_ATTACHMENTS = 5;

export type ChatFileCategory = "document" | "image";

export type ChatFileTypePolicy = {
  ext: string;
  contentType: string;
  /** Documents carry extracted text; images ride to vision models as pixels. */
  category: ChatFileCategory;
  extractable: boolean;
};

/**
 * The closed set of file types chat accepts. PDF is extracted with unpdf;
 * the text formats are decoded as UTF-8; images skip extraction and are
 * loaded from the sealed store at request time for vision-capable models.
 * Anything else is rejected at the upload handshake, before a byte is stored.
 */
const CHAT_FILE_TYPES: Array<{
  ext: string;
  /** Alternate extensions resolving to the same policy (jpeg → jpg). */
  extAliases?: string[];
  canonical: string;
  aliases: string[];
  category: ChatFileCategory;
}> = [
  { ext: "pdf", canonical: "application/pdf", aliases: [], category: "document" },
  { ext: "txt", canonical: "text/plain", aliases: [], category: "document" },
  {
    ext: "md",
    canonical: "text/markdown",
    aliases: ["text/x-markdown"],
    category: "document",
  },
  {
    ext: "csv",
    canonical: "text/csv",
    aliases: ["application/csv"],
    category: "document",
  },
  { ext: "json", canonical: "application/json", aliases: [], category: "document" },
  { ext: "png", canonical: "image/png", aliases: [], category: "image" },
  {
    ext: "jpg",
    extAliases: ["jpeg"],
    canonical: "image/jpeg",
    aliases: ["image/jpg"],
    category: "image",
  },
  { ext: "webp", canonical: "image/webp", aliases: [], category: "image" },
  { ext: "gif", canonical: "image/gif", aliases: [], category: "image" },
];

const IMAGE_CONTENT_TYPES = new Set(
  CHAT_FILE_TYPES.filter((type) => type.category === "image").map(
    (type) => type.canonical,
  ),
);

/** Whether a stored chat file's content type is an accepted image format. */
export function isImageContentType(contentType: string): boolean {
  return IMAGE_CONTENT_TYPES.has(baseContentType(contentType));
}

/**
 * Byte ceilings for images handed to providers as inline data. A single
 * oversized image, or a set that blows the total, degrades to an honest
 * textual note instead of pixels — the strictest provider inline limit
 * (Anthropic, ~5 MB per image) sets the per-image bound with headroom.
 */
export const CHAT_IMAGE_MODEL_BYTE_CAP = 4_500_000;
export const CHAT_IMAGE_TOTAL_BYTE_BUDGET = 12_000_000;

const GENERIC_CONTENT_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
]);

function baseContentType(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

function extensionOf(name: string): string | null {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * Resolve a claimed {name, contentType} pair to the accepted type policy, or
 * null when the file is not a kind chat accepts. Mobile pickers often claim
 * octet-stream, so a known extension with a generic content type is accepted;
 * a *conflicting* known content type is not.
 */
export function resolveChatFileType(input: {
  name: string;
  contentType: string;
}): ChatFileTypePolicy | null {
  const claimed = baseContentType(input.contentType);
  const ext = extensionOf(input.name);
  const byType = CHAT_FILE_TYPES.find(
    (type) => type.canonical === claimed || type.aliases.includes(claimed),
  );
  const byExt = ext
    ? CHAT_FILE_TYPES.find(
        (type) => type.ext === ext || type.extAliases?.includes(ext),
      )
    : null;

  let winner: (typeof CHAT_FILE_TYPES)[number] | null = null;
  if (byExt && byType) {
    // Both sides are known: they must agree.
    winner = byExt === byType ? byExt : null;
  } else if (byExt) {
    // Known extension with a generic claim (mobile pickers say
    // octet-stream): trust the extension. A concrete foreign content type
    // is a conflict, not a fallback.
    winner = GENERIC_CONTENT_TYPES.has(claimed) ? byExt : null;
  } else if (byType) {
    // Known content type: acceptable only when the name carries no
    // extension at all. A foreign extension (run.exe) never rides in on a
    // trusted content type.
    winner = ext === null ? byType : null;
  }
  if (!winner) return null;
  return {
    ext: winner.ext,
    contentType: winner.canonical,
    category: winner.category,
    extractable: winner.category === "document",
  };
}

/** Display filename, safe for headers and UI: no separators, no controls. */
export function sanitizeChatFileName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  const capped = cleaned.length > 160 ? cleaned.slice(0, 160) : cleaned;
  return capped || "file";
}

export type ChatFileExtraction = {
  text: string | null;
  truncated: boolean;
};

function normalizeExtractedText(raw: string): ChatFileExtraction {
  const cleaned = raw
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!cleaned) return { text: null, truncated: false };
  if (cleaned.length > CHAT_FILE_EXTRACT_CHAR_CAP) {
    return {
      text: cleaned.slice(0, CHAT_FILE_EXTRACT_CHAR_CAP),
      truncated: true,
    };
  }
  return { text: cleaned, truncated: false };
}

/**
 * Extract bounded plain text from an accepted chat file. Never throws: a
 * file whose contents cannot be read stays attachable and downloadable, and
 * the request-time framing tells the model the contents were unreadable.
 */
export async function extractChatFileText(
  policy: ChatFileTypePolicy,
  data: Buffer,
): Promise<ChatFileExtraction> {
  try {
    // Images carry no extractable text; they reach models as pixels instead.
    if (!policy.extractable) return { text: null, truncated: false };
    if (policy.ext === "pdf") {
      const { getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(data));
      try {
        const pageCount = Math.min(pdf.numPages, MAX_PDF_EXTRACT_PAGES);
        let combined = "";
        for (let index = 1; index <= pageCount; index += 1) {
          const page = await pdf.getPage(index);
          const content = await page.getTextContent();
          const pageText = content.items
            .map((item) => ("str" in item ? item.str : ""))
            .join(" ")
            .replace(/[ \t]{2,}/g, " ")
            .trim();
          if (pageText) combined += `${pageText}\n`;
          // Once the character cap is covered there is no reason to keep
          // expanding pages — the slice below is a cap, not a resource bound.
          if (combined.length > CHAT_FILE_EXTRACT_CHAR_CAP + 1_024) break;
        }
        return normalizeExtractedText(combined);
      } finally {
        try {
          // unpdf's proxy type omits destroy, but the pdfjs object under it
          // frees parser memory there when present.
          await (pdf as { destroy?: () => Promise<void> }).destroy?.();
        } catch {
          // Freeing parser resources is best-effort.
        }
      }
    }
    return normalizeExtractedText(data.toString("utf8"));
  } catch {
    return { text: null, truncated: false };
  }
}

// ─── Store ────────────────────────────────────────────────────────────────────

export async function insertPendingChatUpload(input: {
  userId: string;
  name: string;
  contentType: string;
  size: number;
  objectPath: string;
}): Promise<VenomChatFileRow> {
  const [row] = await db
    .insert(venomChatFilesTable)
    .values({
      id: randomUUID(),
      clerkUserId: input.userId,
      kind: "upload",
      status: "pending",
      name: input.name,
      contentType: input.contentType,
      size: input.size,
      objectPath: input.objectPath,
      createdAt: Date.now(),
    })
    .returning();
  return row;
}

export async function insertGeneratedChatFile(input: {
  userId: string;
  name: string;
  contentType: string;
  size: number;
  objectPath: string;
}): Promise<VenomChatFileRow> {
  const [row] = await db
    .insert(venomChatFilesTable)
    .values({
      id: randomUUID(),
      clerkUserId: input.userId,
      kind: "generated",
      status: "ready",
      name: input.name,
      contentType: input.contentType,
      size: input.size,
      objectPath: input.objectPath,
      createdAt: Date.now(),
    })
    .returning();
  return row;
}

export async function findOwnedChatFile(
  userId: string,
  fileId: string,
): Promise<VenomChatFileRow | null> {
  const [row] = await db
    .select()
    .from(venomChatFilesTable)
    .where(
      and(
        eq(venomChatFilesTable.id, fileId),
        eq(venomChatFilesTable.clerkUserId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function markChatUploadReady(
  fileId: string,
  input: {
    size: number;
    extractedText: string | null;
    extractedTruncated: boolean;
    /** Sealed object path the verified bytes were copied to. */
    objectPath: string;
  },
): Promise<VenomChatFileRow | null> {
  const [row] = await db
    .update(venomChatFilesTable)
    .set({
      status: "ready",
      size: input.size,
      extractedText: input.extractedText,
      extractedTruncated: input.extractedTruncated,
      objectPath: input.objectPath,
    })
    .where(eq(venomChatFilesTable.id, fileId))
    .returning();
  return row ?? null;
}

/**
 * Load the caller's own ready files for a set of claimed attachment ids.
 * Unknown and foreign ids simply drop out — the model context and the
 * persisted message only ever carry what the owner really has.
 */
export async function loadOwnedReadyChatFiles(
  userId: string,
  fileIds: string[],
): Promise<VenomChatFileRow[]> {
  const unique = [...new Set(fileIds)].slice(0, MAX_MESSAGE_ATTACHMENTS * 8);
  if (unique.length === 0) return [];
  return db
    .select()
    .from(venomChatFilesTable)
    .where(
      and(
        inArray(venomChatFilesTable.id, unique),
        eq(venomChatFilesTable.clerkUserId, userId),
        eq(venomChatFilesTable.status, "ready"),
      ),
    );
}

/** The API-facing file shape. Extracted text stays server-side, always. */
export function toApiChatFile(row: VenomChatFileRow): {
  id: string;
  name: string;
  contentType: string;
  size: number;
  kind: string;
  status: string;
  textExtracted: boolean;
  createdAt: number;
} {
  return {
    id: row.id,
    name: row.name,
    contentType: row.contentType,
    size: row.size,
    kind: row.kind,
    status: row.status,
    textExtracted: row.extractedText != null,
    createdAt: row.createdAt,
  };
}
