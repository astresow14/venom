/**
 * venom-voice-restraint.ts — the conversational-restraint decision core.
 *
 * Real conversation partners know when a remark doesn't need an answer.
 * This module classifies one finished spoken turn as:
 *   - "respond"      → run the full assistant reply (the default)
 *   - "acknowledge"  → speak one short acknowledgment, nothing more
 *   - "silent"       → say nothing and keep listening
 * plus a windDown flag: the exchange reads as a goodbye / dying momentum,
 * so the session may ease itself closed after a natural quiet period.
 *
 * Design stance (hard requirements, not preferences):
 *   - Questions, direct address ("venom"), imperative requests, and answers
 *     to a question the bot just asked ALWAYS get a full reply. Restraint
 *     must never swallow a real request.
 *   - When heuristics are unsure (`confident: false`), a lightweight model
 *     judgment may refine the call — and if that judge is unavailable, slow,
 *     or broken, the answer is "respond". Failure is never silence.
 *   - Pure and deterministic: no I/O here. The model judge and persistence
 *     live in the route; this module is trivially unit-testable.
 *
 * Voice mode only. Typed chat never consults this module.
 */

export type VoiceTalkativeness = "chatty" | "balanced" | "reserved";

export type VoiceTurnDecisionKind = "respond" | "acknowledge" | "silent";

export type VoiceRecentTurn = { role: "user" | "assistant"; content: string };

export const VOICE_TALKATIVENESS_LEVELS: readonly VoiceTalkativeness[] = [
  "chatty",
  "balanced",
  "reserved",
];

export function normalizeTalkativeness(value: unknown): VoiceTalkativeness {
  return value === "chatty" || value === "reserved" ? value : "balanced";
}

/** Context signals one decision is derived from — also the logged payload. */
export type VoiceTurnSignals = {
  wordCount: number;
  endsWithQuestionMark: boolean;
  interrogative: boolean;
  directAddress: boolean;
  imperative: boolean;
  answeringBotQuestion: boolean;
  backchannel: boolean;
  gratitude: boolean;
  farewell: boolean;
  thinkingAloud: boolean;
  /** Trailing user turns (most recent first) that were ≤4 words — dying momentum. */
  trailingShortUserTurns: number;
};

export type HeuristicVerdict = {
  decision: VoiceTurnDecisionKind;
  windDown: boolean;
  /** true → the call is clear-cut; skip the model judge entirely. */
  confident: boolean;
};

// ── Lexicons ─────────────────────────────────────────────────────────────────

const INTERROGATIVE_STARTS = new Set([
  "who", "what", "when", "where", "why", "how", "which", "whose", "whats",
  "whos", "wheres", "hows", "can", "could", "would", "will", "should",
  "shall", "do", "does", "did", "is", "are", "was", "were", "am", "have",
  "has", "had", "may", "might", "must", "any", "anyone", "anything",
]);

const INTERROGATIVE_PHRASES = [
  "can you", "could you", "would you", "will you", "do you", "did you",
  "are you", "is there", "are there", "is it", "was it", "what about",
  "how about", "should i", "should we", "can i", "can we", "what if",
  "any idea", "any thoughts", "any chance", "you know", "tell me",
  "remind me", "walk me through", "or not",
];

const IMPERATIVE_STARTS = new Set([
  "add", "create", "make", "show", "list", "open", "find", "search",
  "write", "draft", "update", "delete", "remove", "rename", "move", "set",
  "change", "summarize", "summarise", "read", "play", "pause", "stop",
  "continue", "keep", "give", "tell", "explain", "describe", "help",
  "check", "look", "pull", "push", "start", "run", "build", "plan",
  "schedule", "remember", "note", "save", "send", "compare", "fix",
  "redo", "retry", "undo", "repeat", "clarify", "expand", "elaborate",
  "go", "lets", "please", "try", "answer", "translate", "count",
]);

const BACKCHANNEL_TOKENS = new Set([
  "ok", "okay", "kay", "k", "yeah", "yea", "yep", "yup", "ya", "uh",
  "uhhuh", "huh", "mm", "mmm", "hmm", "hm", "mhm", "right", "sure",
  "cool", "nice", "great", "awesome", "sweet", "perfect", "neat",
  "gotcha", "got", "it", "makes", "sense", "i", "see", "fair", "enough",
  "true", "word", "alright", "fine", "wow", "oh", "damn", "crazy",
  "wild", "interesting", "good", "sounds", "understood", "noted",
  "roger", "indeed", "totally", "exactly", "definitely", "absolutely",
  "love", "that",
]);

const FILLER_TOKENS = new Set([
  "like", "just", "so", "well", "anyway", "man", "dude", "gosh", "geez",
  "really", "quite", "very", "pretty", "thats", "its", "this", "is",
  "was", "then", "now", "though", "haha", "lol",
]);

const GRATITUDE_PATTERN =
  /\b(thanks|thank you|thank u|thx|ty|appreciate (it|that|you)|cheers)\b/;

// Matched against normalized text, where apostrophes are already gone
// ("that's" → "thats") — so every phrase here is apostrophe-free.
const FAREWELL_PHRASES = [
  "goodbye", "good bye", "good night", "goodnight", "night night",
  "nighty night", "see you", "see ya", "catch you later",
  "talk to you later", "talk later", "talk tomorrow", "talk soon",
  "gotta go", "got to go", "gotta run", "have to go", "im off",
  "heading out", "heading to bed", "going to bed", "going to sleep",
  "time for bed", "signing off", "logging off", "peace out", "take care",
  "thats all for now", "thats it for now", "thats all i needed",
  "all i needed", "were done", "done for today",
  "done for tonight", "done for the day", "done for the night",
  "call it a day", "call it a night", "until next time", "wrap it up",
  "wrap up for", "im out", "later venom", "laters",
];

/** "bye" needs word-boundary care so "maybe" and "bye-laws" don't match. */
const BYE_WORD_PATTERN = /(^|\s)bye(\s|$)/;

const THINKING_ALOUD_STARTS = [
  "let me think", "let me see", "let me mull", "i wonder", "i guess",
  "i suppose", "hmm let me", "maybe i", "maybe we", "i might",
  "ill think", "thinking out loud", "just thinking",
  "i was just thinking", "i need to think", "i keep thinking",
];

const NIGHT_PATTERN = /\b(night|bed|sleep|sleepy|tired)\b/;

// ── Signal extraction ────────────────────────────────────────────────────────

function normalizeForMatching(text: string): string {
  return text
    .toLowerCase()
    // Apostrophes join ("that's" → "thats") so contractions stay one token …
    .replace(/['’]/g, "")
    // … while other punctuation splits.
    .replace(/[.,!?;:…"“”()\-–—]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokensOf(normalized: string): string[] {
  return normalized.length === 0 ? [] : normalized.split(" ");
}

function countWords(text: string): number {
  return tokensOf(normalizeForMatching(text)).length;
}

export function extractVoiceTurnSignals(
  transcript: string,
  recentTurns: readonly VoiceRecentTurn[] = [],
): VoiceTurnSignals {
  const raw = transcript.trim();
  const normalized = normalizeForMatching(raw);
  const tokens = tokensOf(normalized);
  const wordCount = tokens.length;
  const padded = ` ${normalized} `;

  const endsWithQuestionMark = /\?\s*$/.test(raw) || raw.includes("?");
  const startsInterrogative =
    tokens.length > 0 && INTERROGATIVE_STARTS.has(tokens[0]!);
  const containsInterrogativePhrase = INTERROGATIVE_PHRASES.some((phrase) =>
    padded.includes(` ${phrase} `),
  );
  const interrogative =
    endsWithQuestionMark || startsInterrogative || containsInterrogativePhrase;

  const directAddress = /\bvenom\b/.test(normalized);
  const imperative = tokens.length > 0 && IMPERATIVE_STARTS.has(tokens[0]!);

  const lastAssistantTurn = [...recentTurns]
    .reverse()
    .find((turn) => turn.role === "assistant");
  const answeringBotQuestion =
    wordCount <= 8 &&
    typeof lastAssistantTurn?.content === "string" &&
    /\?\s*$/.test(lastAssistantTurn.content.trim());

  const backchannel =
    wordCount > 0 &&
    wordCount <= 6 &&
    tokens.every(
      (token) => BACKCHANNEL_TOKENS.has(token) || FILLER_TOKENS.has(token),
    );

  const gratitude = GRATITUDE_PATTERN.test(normalized);

  const farewell =
    FAREWELL_PHRASES.some((phrase) => padded.includes(` ${phrase} `)) ||
    BYE_WORD_PATTERN.test(normalized);

  const thinkingAloud = THINKING_ALOUD_STARTS.some((start) =>
    normalized.startsWith(start),
  );

  let trailingShortUserTurns = 0;
  for (let index = recentTurns.length - 1; index >= 0; index -= 1) {
    const turn = recentTurns[index]!;
    if (turn.role !== "user") continue;
    if (countWords(turn.content) <= 4) {
      trailingShortUserTurns += 1;
    } else {
      break;
    }
  }

  return {
    wordCount,
    endsWithQuestionMark,
    interrogative,
    directAddress,
    imperative,
    answeringBotQuestion,
    backchannel,
    gratitude,
    farewell,
    thinkingAloud,
    trailingShortUserTurns,
  };
}

// ── Heuristic decision ───────────────────────────────────────────────────────

/** Utterances at or above this many words always get a full reply. */
export const LONG_UTTERANCE_WORDS = 12;

export function decideFromHeuristics(
  signals: VoiceTurnSignals,
  talkativeness: VoiceTalkativeness,
): HeuristicVerdict {
  // 1. Anything question-shaped, or an answer to the bot's own question,
  //    is a real exchange. Full reply, no model consulted.
  if (
    signals.endsWithQuestionMark ||
    signals.interrogative ||
    signals.answeringBotQuestion
  ) {
    return { decision: "respond", windDown: false, confident: true };
  }

  // 2. Goodbyes end the conversation with at most a short closer — even
  //    "later, venom" (direct address inside a farewell stays a farewell).
  if (signals.farewell) {
    return { decision: "acknowledge", windDown: true, confident: true };
  }

  // 3. Calling the bot by name or issuing a command always earns a reply.
  if (signals.directAddress || signals.imperative) {
    return { decision: "respond", windDown: false, confident: true };
  }

  // 4. Substantial content deserves engagement regardless of mood.
  if (signals.wordCount >= LONG_UTTERANCE_WORDS) {
    return { decision: "respond", windDown: false, confident: true };
  }

  // 5. Short thanks gets a warm one-liner, not a paragraph.
  if (signals.gratitude && signals.wordCount <= 5) {
    return { decision: "acknowledge", windDown: false, confident: true };
  }

  // 6. Pure backchannel ("okay yeah", "hm, makes sense"): silence or a nod.
  //    Consecutive minimal remarks mean the conversation is winding down.
  if (signals.backchannel) {
    const windDown = signals.trailingShortUserTurns >= 1;
    if (talkativeness === "chatty") {
      return { decision: "acknowledge", windDown, confident: true };
    }
    return { decision: "silent", windDown, confident: true };
  }

  // 7. Thinking out loud isn't addressed to anyone.
  if (signals.thinkingAloud) {
    if (talkativeness === "reserved") {
      return { decision: "silent", windDown: false, confident: true };
    }
    // Ambiguous for balanced/chatty — let the judge weigh in.
    return {
      decision: talkativeness === "chatty" ? "respond" : "silent",
      windDown: false,
      confident: false,
    };
  }

  // 8. Everything else: unclear short/medium statements.
  if (talkativeness === "chatty") {
    return { decision: "respond", windDown: false, confident: true };
  }
  return {
    decision: talkativeness === "reserved" ? "acknowledge" : "respond",
    windDown: false,
    confident: false,
  };
}

// ── Acknowledgment lines ─────────────────────────────────────────────────────

const GENERIC_ACKS = ["Mm-hm.", "Got it.", "Right.", "Okay.", "Cool."];
const GRATITUDE_ACKS = ["Anytime.", "Of course.", "Happy to help."];
const CLOSERS = ["Catch you later.", "Talk soon.", "Later.", "Take care."];
const NIGHT_CLOSERS = ["Good night.", "Sleep well.", "Rest up."];

function hashSeed(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return hash;
}

/**
 * Picks the short spoken line for an "acknowledge" decision. Deterministic in
 * the seed so tests are stable while real usage still varies.
 */
export function pickAcknowledgment(
  signals: VoiceTurnSignals,
  windDown: boolean,
  transcript: string,
  seed: string,
): string {
  const pool = windDown
    ? NIGHT_PATTERN.test(normalizeForMatching(transcript))
      ? NIGHT_CLOSERS
      : CLOSERS
    : signals.gratitude
      ? GRATITUDE_ACKS
      : GENERIC_ACKS;
  return pool[hashSeed(seed) % pool.length]!;
}

// ── Model judge contract ─────────────────────────────────────────────────────

export type VoiceJudgeInput = {
  transcript: string;
  recentTurns: readonly VoiceRecentTurn[];
  talkativeness: VoiceTalkativeness;
  /** What the heuristics would do — the judge refines, never bootstraps. */
  heuristicDecision: VoiceTurnDecisionKind;
};

export type VoiceJudgeVerdict = {
  decision: VoiceTurnDecisionKind;
  windDown: boolean;
};

/** Parses/validates a judge's raw JSON reply; null means "unusable". */
export function parseJudgeVerdict(raw: string): VoiceJudgeVerdict | null {
  try {
    const parsed = JSON.parse(raw) as {
      decision?: unknown;
      windDown?: unknown;
    };
    if (
      parsed.decision !== "respond" &&
      parsed.decision !== "acknowledge" &&
      parsed.decision !== "silent"
    ) {
      return null;
    }
    return {
      decision: parsed.decision,
      windDown: parsed.windDown === true,
    };
  } catch {
    return null;
  }
}

/** The system prompt for the lightweight judge model. */
export const VOICE_JUDGE_SYSTEM_PROMPT = [
  "You judge whether a spoken remark in a hands-free voice chat needs a reply.",
  "The user just said something after the assistant's last turn. Classify it:",
  '- "respond": the remark invites a real answer (question, request, new topic, disagreement, anything substantive).',
  '- "acknowledge": a brief nod is enough (short thanks, mild reaction that expects warmth but no content).',
  '- "silent": no reply is wanted (trailing filler, thinking out loud, remarks not addressed to the assistant).',
  "Also set windDown=true only when the user is clearly ending the conversation.",
  "When in doubt, ALWAYS choose respond. Never let a real question go unanswered.",
  'Answer with strict JSON only: {"decision":"respond|acknowledge|silent","windDown":false}',
].join("\n");
