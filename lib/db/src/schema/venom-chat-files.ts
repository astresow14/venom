import { bigint, boolean, index, pgTable, text } from "drizzle-orm/pg-core";

/**
 * Venom chat files: files exchanged through chat, in both directions.
 *
 * `upload` rows are files the host attached to a message (stored in private
 * object storage, text-extracted once at upload-complete so chat requests can
 * inject their contents as bounded context). `generated` rows are files Venom
 * authored for the host (single-model file production). Rows are owner-scoped
 * by Clerk user id; the object itself never leaves private storage except
 * through the owner-checked download route.
 *
 * `extractedText` is capped at extraction time (see venom-chat-files lib) and
 * never returned by the API — it exists solely for model-context injection.
 */
export const venomChatFilesTable = pgTable(
  "venom_chat_files",
  {
    id: text("id").primaryKey(),
    clerkUserId: text("clerk_user_id").notNull(),
    /** 'upload' (host → Venom) or 'generated' (Venom → host). */
    kind: text("kind").notNull(),
    /** 'pending' until the upload is verified and extracted; then 'ready'. */
    status: text("status").notNull().default("pending"),
    /** Display filename, sanitized (no path separators or control chars). */
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    /** Verified byte size (from storage HEAD, not client claims). */
    size: bigint("size", { mode: "number" }).notNull().default(0),
    objectPath: text("object_path").notNull(),
    /** Bounded plain-text extraction for model context; null if unreadable. */
    extractedText: text("extracted_text"),
    extractedTruncated: boolean("extracted_truncated").notNull().default(false),
    /** ms epoch. */
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("venom_chat_files_owner_idx").on(table.clerkUserId, table.createdAt),
  ],
);

export type VenomChatFileRow = typeof venomChatFilesTable.$inferSelect;
