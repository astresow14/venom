/**
 * Debate thread UI: the live block while a round streams — the current
 * speaker's turn forming in place, who is up next, and which voices dropped
 * out — rendered as visible participants in the conversation.
 *
 * Finished turns persist as ordinary attributed assistant messages, so this
 * block only ever shows the round's transient state. Monochrome organic
 * motion per the Venom Desktop design language.
 */

import React from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import type {
  SourceCitation,
  VenomArchivedCitation,
  VenomModelId,
} from "@workspace/api-client-react";
import { CitationText } from "./DeliberationPanel";

export type DebateRosterVoice = {
  voiceId: string;
  name: string;
  modelId?: VenomModelId;
  modelName?: string;
};

/** Transient client-side state for a debate round in flight. */
export type StreamingDebate = {
  roster: DebateRosterVoice[];
  plannedTurns: number;
  /** The turn currently streaming into the thread, if any. */
  currentTurn?: {
    index: number;
    voiceId: string;
    name: string;
    modelId?: VenomModelId;
    modelName?: string;
    content: string;
  };
  completedTurns: number;
  /** Voice names whose turns produced nothing this round. */
  failedVoices: string[];
};

const SETTLE = [0.16, 1, 0.3, 1] as const;

export function DebateStreamBlock({
  debate,
  citationsById,
  archivedById,
}: {
  debate: StreamingDebate;
  citationsById: Map<string, SourceCitation>;
  archivedById: Map<string, VenomArchivedCitation>;
}) {
  const reduceMotion = useReducedMotion();
  const turn = debate.currentTurn;
  const modelSuffix =
    turn?.modelName && turn.modelName !== turn.name ? turn.modelName : undefined;

  return (
    <div className="w-full" data-testid="debate-stream">
      {/* Round status: which turn is forming out of how many. */}
      <div
        className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
        data-testid="debate-status"
      >
        <span className="relative flex h-2 w-2 items-center justify-center">
          <span
            className="absolute h-full w-full rounded-full bg-foreground/30 motion-safe:animate-ping"
            aria-hidden="true"
          />
          <span className="relative h-1.5 w-1.5 rounded-full bg-foreground" />
        </span>
        {turn ? (
          <span>
            Turn {Math.min(turn.index + 1, debate.plannedTurns)} of{" "}
            {debate.plannedTurns} · {turn.name} is speaking
          </span>
        ) : (
          <span>
            {debate.completedTurns === 0
              ? "The voices are gathering"
              : "Waiting for the next voice"}
          </span>
        )}
        {debate.failedVoices.length > 0 && (
          <span
            className="rounded-full border border-border/60 px-2 py-0.5 text-[11px]"
            data-testid="chip-debate-failed"
          >
            {debate.failedVoices.join(", ")} couldn&apos;t respond
          </span>
        )}
      </div>

      {/* The turn currently forming, attributed to its voice. */}
      <AnimatePresence mode="popLayout" initial={false}>
        {turn && (
          <motion.div
            key={turn.index}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35, ease: SETTLE }}
            data-testid={`debate-turn-${turn.index}`}
          >
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-foreground/80">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full bg-foreground"
                aria-hidden="true"
              />
              {turn.name}
              {modelSuffix && (
                <span className="font-normal text-muted-foreground">
                  · {modelSuffix}
                </span>
              )}
            </div>
            <div className="text-[15px] leading-7 text-foreground">
              {turn.content ? (
                <CitationText
                  content={turn.content}
                  citationsById={citationsById}
                  archivedById={archivedById}
                />
              ) : (
                <span className="text-sm text-muted-foreground motion-safe:animate-pulse">
                  Composing…
                </span>
              )}
              {turn.content && (
                <span
                  className="ml-0.5 inline-block h-4 w-[2px] align-middle bg-foreground motion-safe:animate-pulse"
                  aria-hidden="true"
                />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
