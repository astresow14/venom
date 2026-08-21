import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Venom voice restraint decisions: one row per finished spoken turn that the
 * decide endpoint classified (respond / acknowledge / silent).
 *
 * This is the training-data trail for conversational restraint: each row
 * captures the context signals the decision was made from, which layer made
 * it (heuristic / model / fallback), and — once the client observes what
 * happened next — the outcome (reply interrupted, user re-asked after
 * silence, clean wind-down, ...). Bounded retention: a scheduled sweep
 * deletes rows past the age cap for every user (active or not), and inserts
 * opportunistically enforce a per-user row cap. Never stores audio; the
 * transcript is kept only as a bounded preview.
 */
export const venomVoiceDecisionsTable = pgTable(
  "venom_voice_decisions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** respond | acknowledge | silent */
    decision: text("decision").notNull(),
    /** The exchange read as a goodbye; the session may ease closed. */
    windDown: boolean("wind_down").notNull().default(false),
    /** Which layer decided: heuristic | model | fallback */
    source: text("source").notNull(),
    /** Talkativeness preference in force at decision time. */
    talkativeness: text("talkativeness").notNull(),
    /** Bounded transcript snippet (first ~280 chars) — never raw audio. */
    transcriptPreview: text("transcript_preview").notNull(),
    /** Full transcript length in characters (the preview may be shorter). */
    transcriptChars: integer("transcript_chars").notNull(),
    /** Heuristic/model context signals the decision was derived from. */
    signals: jsonb("signals").notNull(),
    /**
     * What happened next: reply_completed | reply_interrupted |
     * user_followed_up | stayed_quiet | wound_down | session_closed.
     * Null until the client reports it; first report wins.
     */
    outcome: text("outcome"),
    outcomeAt: timestamp("outcome_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("venom_voice_decisions_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
  ],
);

export type VenomVoiceDecisionRow = typeof venomVoiceDecisionsTable.$inferSelect;
