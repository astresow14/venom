/**
 * Multi-voice deliberation UI: the animated in-progress chamber where voice
 * takes surface as they stream, and the finished rendering that flags where
 * the voices disagreed with the individual takes one tap away.
 *
 * Motion follows the Venom Desktop design language: monochrome, organic
 * settling (opacity/transform only), hairline borders, sentence case.
 */

import React, { useMemo, useState } from "react";
import {
  motion,
  AnimatePresence,
  useReducedMotion,
} from "framer-motion";
import { ChevronDown, Split } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  SourceCitation,
  VenomArchivedCitation,
  VenomMessageDeliberation,
  VenomModelId,
} from "@workspace/api-client-react";
import { messageCitationSegments } from "@/lib/messageCitations";
import {
  type FamilyForModel,
  SpeakerAvatar,
  speakerGlyph,
} from "./SpeakerAvatar";

// ─── Shared shapes ───────────────────────────────────────────────────────────

/** Roster voice announced by the stream's metadata event. */
export type DeliberationRosterVoice = {
  voiceId: string;
  name: string;
  tagline?: string;
  modelId?: VenomModelId;
  modelName?: string;
};

export type StreamingTake = {
  content: string;
  status: "streaming" | "ok" | "failed";
};

/** Transient client-side state for a deliberation in flight. */
export type StreamingDeliberation = {
  roster: DeliberationRosterVoice[];
  takes: Record<string, StreamingTake>;
  stage: "voices" | "synthesis";
};

type CitationMaps = {
  citationsById: Map<string, SourceCitation>;
  archivedById: Map<string, VenomArchivedCitation>;
};

const SETTLE = [0.16, 1, 0.3, 1] as const;

// ─── Citation-aware text ─────────────────────────────────────────────────────

/**
 * Resolves `[source:id]` markers to source references inside the deliberation
 * view: live citations link out, retired ones read as archived references.
 */
export function CitationText({
  content,
  citationsById,
  archivedById,
}: { content: string } & CitationMaps) {
  const segments = useMemo(
    () => messageCitationSegments(content, citationsById, archivedById),
    [content, citationsById, archivedById],
  );

  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === "text") {
          return <React.Fragment key={index}>{segment.text}</React.Fragment>;
        }
        if (segment.kind === "citation") {
          return (
            <a
              key={`${segment.citation.id}-${index}`}
              href={segment.citation.url}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-foreground underline decoration-foreground/30 underline-offset-2 transition-colors hover:decoration-foreground"
              data-testid={`citation-link-${segment.citation.id}`}
            >
              {segment.citation.title}
            </a>
          );
        }
        if (segment.archived?.url) {
          return (
            <a
              key={`${segment.citationId}-${index}`}
              href={segment.archived.url}
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2"
              aria-label={`Open archived source, no longer connected: ${segment.archived.title}`}
            >
              {segment.label}
            </a>
          );
        }
        return (
          <span
            key={`${segment.citationId}-${index}`}
            className="text-muted-foreground"
            aria-label="Archived source, no longer connected"
          >
            {segment.label}
          </span>
        );
      })}
    </>
  );
}

// ─── In-progress chamber ─────────────────────────────────────────────────────

/** Three orbs that breathe apart while voices work, then merge into one. */
function VoiceOrbs({ converged }: { converged: boolean }) {
  const reduceMotion = useReducedMotion();
  return (
    <span className="flex w-6 items-center justify-center" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <motion.span
          key={index}
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground"
          style={{ marginLeft: index === 0 ? 0 : 2 }}
          animate={
            reduceMotion
              ? { opacity: 1 }
              : converged
                ? {
                    x: (1 - index) * 3.5,
                    opacity: 1,
                    scale: [1, 0.82, 1],
                  }
                : {
                    opacity: [0.3, 1, 0.3],
                    scale: [0.75, 1, 0.75],
                  }
          }
          transition={
            reduceMotion
              ? { duration: 0.2 }
              : converged
                ? {
                    x: { duration: 0.5, ease: SETTLE },
                    scale: {
                      repeat: Infinity,
                      duration: 1.8,
                      ease: "easeInOut",
                    },
                  }
                : {
                    repeat: Infinity,
                    duration: 2.4,
                    ease: "easeInOut",
                    delay: index * 0.4,
                  }
          }
        />
      ))}
    </span>
  );
}

/** One voice's live card: name, model when models differ, streaming take. */
function VoiceStreamCard({
  voice,
  take,
  dimmed,
  showModel,
  citationsById,
  archivedById,
  familyForModel,
}: {
  voice: DeliberationRosterVoice;
  take: StreamingTake;
  dimmed: boolean;
  showModel: boolean;
  familyForModel: FamilyForModel;
} & CitationMaps) {
  const reduceMotion = useReducedMotion();
  const streamingDot =
    take.status === "streaming" ? (
      <motion.span
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground"
        animate={
          reduceMotion
            ? { opacity: 0.8 }
            : { opacity: [0.3, 1, 0.3], scale: [0.8, 1, 0.8] }
        }
        transition={
          reduceMotion
            ? undefined
            : { repeat: Infinity, duration: 2, ease: "easeInOut" }
        }
        aria-hidden="true"
      />
    ) : (
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          take.status === "ok"
            ? "bg-foreground"
            : "border border-muted-foreground/60 bg-transparent",
        )}
        aria-hidden="true"
      />
    );

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: dimmed ? 0.6 : 1, y: 0 }}
      transition={{ duration: 0.3, ease: SETTLE }}
      className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-border/60 bg-background/50 p-3"
      data-testid={`deliberation-voice-${voice.voiceId}`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {streamingDot}
        <SpeakerAvatar
          size="sm"
          glyph={speakerGlyph({
            speakerId: voice.voiceId,
            modelId: voice.modelId,
            name: voice.name,
            familyForModel,
          })}
        />
        <span className="truncate text-xs font-medium text-foreground">
          {voice.name}
        </span>
        {showModel && voice.modelName && (
          <span className="ml-auto truncate text-[11px] text-muted-foreground">
            {voice.modelName}
          </span>
        )}
      </div>
      {take.status === "failed" ? (
        <p className="text-xs leading-5 text-muted-foreground/80">
          Didn't finish — the others carry on.
        </p>
      ) : take.content ? (
        <p className="line-clamp-6 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
          <CitationText
            content={take.content}
            citationsById={citationsById}
            archivedById={archivedById}
          />
        </p>
      ) : (
        <p className="text-xs leading-5 text-muted-foreground/70">
          Forming a take…
        </p>
      )}
    </motion.div>
  );
}

/** The animated chamber shown while a deliberated answer is generating. */
export function DeliberationStreamPanel({
  deliberation,
  citationsById,
  archivedById,
  familyForModel,
}: {
  deliberation: StreamingDeliberation;
  familyForModel: FamilyForModel;
} & CitationMaps) {
  const { roster, takes, stage } = deliberation;
  const converging = stage === "synthesis";
  const showModels =
    new Set(roster.map((voice) => voice.modelId).filter(Boolean)).size > 1;

  return (
    <div
      className="mb-3 w-full rounded-2xl border border-border/60 surface p-2 shadow-soft"
      data-testid="deliberation-panel"
    >
      <div className="flex items-center gap-2 px-1.5 pb-2 pt-1">
        <VoiceOrbs converged={converging} />
        <span className="text-xs font-medium text-foreground">
          {converging ? "Converging" : "Verifying"}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {converging
            ? "the voices are merging into one answer"
            : `${roster.length} voices are checking the question`}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {roster.map((voice) => (
          <VoiceStreamCard
            key={voice.voiceId}
            voice={voice}
            take={takes[voice.voiceId] ?? { content: "", status: "streaming" }}
            dimmed={converging}
            showModel={showModels}
            citationsById={citationsById}
            archivedById={archivedById}
            familyForModel={familyForModel}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Finished rendering ──────────────────────────────────────────────────────

/**
 * The persisted deliberation below a collective answer: disagreements are
 * flagged in the open, the attributed takes stay one tap away.
 */
export function DeliberationResult({
  deliberation,
  citationsById,
  archivedById,
  familyForModel,
}: {
  deliberation: VenomMessageDeliberation;
  familyForModel: FamilyForModel;
} & CitationMaps) {
  const [expanded, setExpanded] = useState(false);
  const reduceMotion = useReducedMotion();
  const okTakes = deliberation.voices.filter((take) => take.status === "ok");
  const failedCount = deliberation.voices.length - okTakes.length;
  const showModels =
    new Set(okTakes.map((take) => take.modelId).filter(Boolean)).size > 1;

  return (
    <div className="mt-3 w-full" data-testid="deliberation-result">
      {deliberation.disagreements.length > 0 ? (
        <div
          className="rounded-xl border border-border/60 bg-muted/40 p-3.5"
          data-testid="deliberation-disagreements"
        >
          <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Split className="h-3.5 w-3.5" aria-hidden="true" />
            Where the voices split
          </div>
          <ul className="mt-2 flex flex-col gap-1.5">
            {deliberation.disagreements.map((note, index) => (
              <li
                key={index}
                className="flex gap-2 text-sm leading-6 text-muted-foreground"
              >
                <span
                  aria-hidden="true"
                  className="mt-[11px] h-[3px] w-[3px] shrink-0 rounded-full bg-foreground/60"
                />
                <span className="min-w-0">
                  <CitationText
                    content={note}
                    citationsById={citationsById}
                    archivedById={archivedById}
                  />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p
          className="text-xs text-muted-foreground"
          data-testid="deliberation-agreement"
        >
          The voices converged without real disagreement.
        </p>
      )}

      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        data-testid="button-toggle-takes"
        className="mt-2 flex items-center gap-1.5 rounded-md px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown
          className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")}
          aria-hidden="true"
        />
        {expanded ? "Hide the takes" : `Read the takes (${okTakes.length})`}
        {failedCount > 0 && !expanded && (
          <span className="text-muted-foreground/70">
            · {failedCount} {failedCount === 1 ? "voice" : "voices"} didn't
            finish
          </span>
        )}
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25, ease: SETTLE }}
            className="mt-2 grid gap-2"
            data-testid="deliberation-takes"
          >
            {deliberation.voices.map((take) => (
              <div
                key={take.voiceId}
                className="rounded-xl border border-border/60 p-3"
                data-testid={`deliberation-take-${take.voiceId}`}
              >
                <div className="flex items-center gap-2">
                  <SpeakerAvatar
                    size="sm"
                    glyph={speakerGlyph({
                      speakerId: take.voiceId,
                      modelId: take.modelId,
                      name: take.name,
                      familyForModel,
                    })}
                  />
                  <span className="text-xs font-medium text-foreground">
                    {take.name}
                  </span>
                  {showModels && take.modelName && (
                    <span className="text-[11px] text-muted-foreground">
                      {take.modelName}
                    </span>
                  )}
                </div>
                {take.status === "failed" ? (
                  <p className="mt-1 text-sm leading-6 text-muted-foreground/80">
                    This voice didn't finish its take.
                  </p>
                ) : (
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                    <CitationText
                      content={take.content}
                      citationsById={citationsById}
                      archivedById={archivedById}
                    />
                  </p>
                )}
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
