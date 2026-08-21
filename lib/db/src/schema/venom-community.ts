import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Community Profiles
// ---------------------------------------------------------------------------

export const communityProfilesTable = pgTable(
  "community_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clerkUserId: text("clerk_user_id").notNull().unique(),
    displayName: text("display_name").notNull(),
    bio: text("bio"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("community_profiles_clerk_user_id_idx").on(table.clerkUserId),
  ],
);

export type CommunityProfile = typeof communityProfilesTable.$inferSelect;
export const insertCommunityProfileSchema = createInsertSchema(
  communityProfilesTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCommunityProfile = z.infer<
  typeof insertCommunityProfileSchema
>;

// ---------------------------------------------------------------------------
// Community Threads
// ---------------------------------------------------------------------------

export const communityThreadsTable = pgTable(
  "community_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authorId: uuid("author_id")
      .notNull()
      .references(() => communityProfilesTable.id),
    body: text("body").notNull(),
    revision: integer("revision").notNull().default(1),
    voteScore: integer("vote_score").notNull().default(0),
    replyCount: integer("reply_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => [
    index("community_threads_created_at_id_idx").on(
      table.createdAt,
      table.id,
    ),
    index("community_threads_vote_score_created_at_id_idx").on(
      table.voteScore,
      table.createdAt,
      table.id,
    ),
    index("community_threads_author_id_idx").on(table.authorId),
  ],
);

export type CommunityThread = typeof communityThreadsTable.$inferSelect;
export const insertCommunityThreadSchema = createInsertSchema(
  communityThreadsTable,
).omit({ id: true, revision: true, voteScore: true, replyCount: true, createdAt: true, updatedAt: true, removedAt: true });
export type InsertCommunityThread = z.infer<typeof insertCommunityThreadSchema>;

// ---------------------------------------------------------------------------
// Community Replies
// ---------------------------------------------------------------------------

export const communityRepliesTable = pgTable(
  "community_replies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => communityThreadsTable.id),
    authorId: uuid("author_id")
      .notNull()
      .references(() => communityProfilesTable.id),
    // Client-generated operation id. Nullable only for replies created before
    // request-level idempotency was introduced.
    clientRequestId: uuid("client_request_id"),
    // Optional parent reply (reply-to-a-reply). Null for top-level thread replies.
    parentReplyId: uuid("parent_reply_id"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => [
    index("community_replies_thread_id_created_at_idx").on(
      table.threadId,
      table.createdAt,
    ),
    index("community_replies_author_id_idx").on(table.authorId),
    index("community_replies_parent_reply_id_idx").on(table.parentReplyId),
    uniqueIndex("community_replies_author_client_request_idx").on(
      table.authorId,
      table.clientRequestId,
    ),
  ],
);

export type CommunityReply = typeof communityRepliesTable.$inferSelect;
export const insertCommunityReplySchema = createInsertSchema(
  communityRepliesTable,
).omit({ id: true, createdAt: true, updatedAt: true, removedAt: true });
export type InsertCommunityReply = z.infer<typeof insertCommunityReplySchema>;

// ---------------------------------------------------------------------------
// Community Votes
// ---------------------------------------------------------------------------

export const communityVotesTable = pgTable(
  "community_votes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => communityThreadsTable.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => communityProfilesTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("community_votes_thread_member_idx").on(
      table.threadId,
      table.memberId,
    ),
    index("community_votes_member_id_idx").on(table.memberId),
  ],
);

export type CommunityVote = typeof communityVotesTable.$inferSelect;

// ---------------------------------------------------------------------------
// Community Reports
// ---------------------------------------------------------------------------

export const communityReportsTable = pgTable(
  "community_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reporterProfileId: uuid("reporter_profile_id")
      .notNull()
      .references(() => communityProfilesTable.id),
    targetType: text("target_type").notNull(), // 'thread' | 'reply'
    targetId: uuid("target_id").notNull(),
    reason: text("reason").notNull(), // 'spam' | 'abuse' | 'harassment' | 'other'
    details: text("details"),
    status: text("status").notNull().default("received"), // 'received' | 'reviewed' | 'dismissed'
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("community_reports_reporter_target_idx").on(
      table.reporterProfileId,
      table.targetType,
      table.targetId,
    ),
    index("community_reports_target_idx").on(table.targetType, table.targetId),
  ],
);

export type CommunityReport = typeof communityReportsTable.$inferSelect;
export const insertCommunityReportSchema = createInsertSchema(
  communityReportsTable,
).omit({ id: true, status: true, createdAt: true, updatedAt: true });
export type InsertCommunityReport = z.infer<typeof insertCommunityReportSchema>;

// ---------------------------------------------------------------------------
// Thread Summaries (provenance-normalized)
// ---------------------------------------------------------------------------

export const threadSummariesTable = pgTable(
  "thread_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .unique()
      .references(() => communityThreadsTable.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    status: text("status").notNull().default("pending"), // 'generated' | 'fallback' | 'pending'
    sourceRevision: integer("source_revision").notNull(),
    modelVersion: text("model_version"),
    promptVersion: text("prompt_version"),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("thread_summaries_thread_id_idx").on(table.threadId),
  ],
);

export type ThreadSummary = typeof threadSummariesTable.$inferSelect;
export const insertThreadSummarySchema = createInsertSchema(
  threadSummariesTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertThreadSummary = z.infer<typeof insertThreadSummarySchema>;

// ---------------------------------------------------------------------------
// Rate Limits (distributed, bounded)
// ---------------------------------------------------------------------------

export const communityRateLimitsTable = pgTable(
  "community_rate_limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull().unique(), // auth+action+window
    count: integer("count").notNull().default(1),
    windowStart: timestamp("window_start", { withTimezone: true })
      .notNull()
      .defaultNow(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("community_rate_limits_key_idx").on(table.key),
    index("community_rate_limits_window_end_idx").on(table.windowEnd),
  ],
);

export type CommunityRateLimit = typeof communityRateLimitsTable.$inferSelect;

// ---------------------------------------------------------------------------
// Community Notifications (minimal, user-owned, bounded retention)
// ---------------------------------------------------------------------------
//
// A community notification is a lightweight pointer record. It intentionally
// stores NO thread/reply body text — only stable references so the read path
// can look up display-safe, availability-checked fields at query time.
//
// Retention is bounded to 90 days and pruned opportunistically (no background
// process): callers prune expired rows as part of ordinary write/read paths.

export const COMMUNITY_NOTIFICATION_RETENTION_DAYS = 90;

export const communityNotificationsTable = pgTable(
  "community_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Bounded type — currently only "reply".
    type: text("type").$type<"reply">().notNull().default("reply"),
    // Recipient community profile (the notified user).
    recipientProfileId: uuid("recipient_profile_id")
      .notNull()
      .references(() => communityProfilesTable.id, { onDelete: "cascade" }),
    // Actor community profile (who caused the notification).
    actorProfileId: uuid("actor_profile_id")
      .notNull()
      .references(() => communityProfilesTable.id, { onDelete: "cascade" }),
    // Thread the interaction happened in.
    threadId: uuid("thread_id")
      .notNull()
      .references(() => communityThreadsTable.id, { onDelete: "cascade" }),
    // The new reply that triggered the notification.
    replyId: uuid("reply_id")
      .notNull()
      .references(() => communityRepliesTable.id, { onDelete: "cascade" }),
    // Parent reply (nullable): set when the notification is about a reply to a
    // reply; null when the notification is about a top-level thread reply.
    parentReplyId: uuid("parent_reply_id").references(
      () => communityRepliesTable.id,
      { onDelete: "cascade" },
    ),
    // Idempotency key derived from the triggering reply; enforced unique so
    // retries never create duplicate notifications.
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "community_notifications_type_check",
      sql`${table.type} = 'reply'`,
    ),
    uniqueIndex("community_notifications_idempotency_key_idx").on(
      table.idempotencyKey,
    ),
    // Stable cursor ordering: recipient scope, newest first (createdAt, id).
    index("community_notifications_recipient_created_at_id_idx").on(
      table.recipientProfileId,
      table.createdAt,
      table.id,
    ),
    // Unread-count / mark-all lookups scoped to a recipient.
    index("community_notifications_recipient_read_at_idx").on(
      table.recipientProfileId,
      table.readAt,
    ),
    index("community_notifications_created_at_idx").on(table.createdAt),
  ],
);

export type CommunityNotification =
  typeof communityNotificationsTable.$inferSelect;
export const insertCommunityNotificationSchema = createInsertSchema(
  communityNotificationsTable,
).omit({ id: true, createdAt: true, readAt: true });
export type InsertCommunityNotification = z.infer<
  typeof insertCommunityNotificationSchema
>;
