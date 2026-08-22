/**
 * File production for Venom chat: intent detection, the single-author
 * stream protocol, and rendering of the finished document.
 *
 * Design rule (host's requirement): a file-producing request never runs the
 * multi-voice debate. Exactly one model authors the file. Detection is a
 * cheap regex gate followed by a tiny JSON-only classifier call on the
 * request's resolved model; every failure in that pipeline fails open to an
 * ordinary chat turn — a missed file is recoverable, a hijacked chat is not.
 */
import { renderVenomPdf } from "./venom-pdf-render";

export type VenomFileFormat = "pdf" | "md" | "txt" | "csv";

export type VenomFilePlan = {
  format: VenomFileFormat;
  title: string;
};

// ─── Intent gate ──────────────────────────────────────────────────────────────

const FILE_NOUNS =
  "(?:pdf|document|docs?|file|report|memo|write-?up|one-?pagers?|whitepaper|proposal|brief|handout|worksheet|checklist|cheat\\s?sheet|cover letter|invoice|spreadsheet|csv|markdown|\\.md|md file|txt|text file|attachment|printable|download(?:able)?)";
const FILE_VERBS =
  "(?:make|create|generate|produce|write|draft|prepare|compose|build|give|get|send|turn|convert|export|save|put|render|compile|assemble)";

const GATE_PATTERNS: RegExp[] = [
  new RegExp(`\\b${FILE_VERBS}\\b[\\s\\S]{0,80}?\\b${FILE_NOUNS}\\b`, "i"),
  new RegExp(`\\b(?:as|into|to)\\s+an?\\s+${FILE_NOUNS}\\b`, "i"),
  /\bpdf\b/i,
  new RegExp(`\\b${FILE_NOUNS}\\s+(?:of|about|for|from|with)\\b`, "i"),
  /\b(?:i can|i could|so i can)\s+(?:download|print|share|attach)\b/i,
];

/**
 * Cheap recall-oriented gate on the latest user message. Only when this
 * fires does the classifier spend a model call deciding for real.
 */
export function fileIntentGate(text: string): boolean {
  if (!text || text.length > 20_000) return false;
  return GATE_PATTERNS.some((pattern) => pattern.test(text));
}

// ─── Classifier ───────────────────────────────────────────────────────────────

const CLASSIFIER_TIMEOUT_MS = 8_000;
const FORMATS: ReadonlySet<string> = new Set(["pdf", "md", "txt", "csv"]);

const CLASSIFIER_SYSTEM = [
  "You decide whether the user is asking for a downloadable file to be produced, and if so which kind.",
  'Respond with ONLY a JSON object, no prose, no code fences: {"produce": boolean, "format": "pdf"|"md"|"txt"|"csv", "title": string}.',
  "produce is true only when the user wants an actual file/document artifact they can download or share — not when they merely want an answer, a summary in chat, or are discussing documents.",
  "format: pdf when they say pdf/document/report/letter/one-pager or anything print-like; md when they ask for markdown; csv only for tabular/spreadsheet data; txt for explicitly plain text.",
  "title: a short descriptive document title, at most 8 words, no quotes or trailing punctuation.",
].join("\n");

/** Provider stream: same shape venom.ts uses for chat turns. */
export type AuthorStream = (
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  signal: AbortSignal,
) => AsyncIterable<string>;

function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object");
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * One tiny JSON-only model call. Returns a validated plan, or null when the
 * model says "no file" — or when anything at all goes wrong (timeout, junk
 * output, provider error). Callers treat null as "ordinary chat turn".
 */
export async function classifyFileIntent(input: {
  stream: AuthorStream;
  userMessage: string;
  signal: AbortSignal;
}): Promise<VenomFilePlan | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  input.signal.addEventListener("abort", onOuterAbort, { once: true });
  try {
    let raw = "";
    for await (const chunk of input.stream(
      [
        { role: "system", content: CLASSIFIER_SYSTEM },
        { role: "user", content: input.userMessage.slice(0, 4_000) },
      ],
      controller.signal,
    )) {
      raw += chunk;
      if (raw.length > 2_000) break;
    }
    const parsed = extractJsonObject(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (record.produce !== true) return null;
    const format =
      typeof record.format === "string" && FORMATS.has(record.format)
        ? (record.format as VenomFileFormat)
        : "pdf";
    const title =
      typeof record.title === "string" && record.title.trim()
        ? record.title.trim().slice(0, 120)
        : "Venom document";
    return { format, title };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", onOuterAbort);
  }
}

// ─── Authoring protocol ───────────────────────────────────────────────────────

export const DOCUMENT_MARKER = "---DOCUMENT---";
const SUMMARY_PREFIX = "SUMMARY:";

export function buildAuthoringInstruction(plan: VenomFilePlan): string {
  const bodyRules =
    plan.format === "pdf" || plan.format === "md"
      ? "Write the document body in clean markdown: # headings, paragraphs, - lists, **bold** where it earns it. No YAML front matter."
      : plan.format === "csv"
        ? "Write the document body as raw CSV only: a header row, then data rows. No markdown, no commentary, no code fences."
        : "Write the document body as plain text. No markdown syntax.";
  return [
    `The user asked for a downloadable ${plan.format.toUpperCase()} file titled "${plan.title}". You are its sole author this turn.`,
    "Reply in EXACTLY this shape:",
    `${SUMMARY_PREFIX} <one to three short sentences telling the user what the document contains — conversational, no headings>`,
    DOCUMENT_MARKER,
    "<the complete document body>",
    bodyRules,
    `Do not repeat the marker line, do not wrap the document in code fences, and do not mention this format protocol.`,
  ].join("\n");
}

export type SplitterOutput = { chat: string; doc: string };

/**
 * Stateful splitter for the SUMMARY/---DOCUMENT--- stream protocol. The
 * marker can arrive split across chunks, so a marker-length tail is always
 * withheld until the next push. A stream that never produces the marker
 * fails open: everything is chat, no file, nothing lost.
 */
export function createAuthoringStreamSplitter(): {
  push(chunk: string): SplitterOutput;
  flush(): SplitterOutput;
  sawMarker(): boolean;
} {
  let phase: "start" | "chat" | "doc" = "start";
  let pending = "";
  let marked = false;

  const strip = (text: string): string => {
    // Drop a leading "SUMMARY:" label once, tolerating whitespace before it.
    const trimmed = text.replace(/^\s+/, "");
    if (trimmed.toUpperCase().startsWith(SUMMARY_PREFIX)) {
      return trimmed.slice(SUMMARY_PREFIX.length).replace(/^\s+/, "");
    }
    return text;
  };

  const drain = (final: boolean): SplitterOutput => {
    const out: SplitterOutput = { chat: "", doc: "" };
    if (phase === "doc") {
      out.doc = pending;
      pending = "";
      return out;
    }
    if (phase === "start") {
      // Hold until we can tell whether the stream opens with the label.
      if (!final && pending.replace(/^\s+/, "").length < SUMMARY_PREFIX.length)
        return out;
      pending = strip(pending);
      phase = "chat";
    }
    const markerAt = pending.indexOf(DOCUMENT_MARKER);
    if (markerAt !== -1) {
      marked = true;
      out.chat = pending.slice(0, markerAt).replace(/\s+$/, "");
      pending = pending
        .slice(markerAt + DOCUMENT_MARKER.length)
        .replace(/^[ \t]*\r?\n/, "");
      phase = "doc";
      out.doc = pending;
      pending = "";
      return out;
    }
    if (final) {
      out.chat = pending;
      pending = "";
      return out;
    }
    // Withhold enough tail that a split marker can still be recognized.
    const hold = DOCUMENT_MARKER.length - 1;
    if (pending.length > hold) {
      out.chat = pending.slice(0, pending.length - hold);
      pending = pending.slice(pending.length - hold);
    }
    return out;
  };

  return {
    push(chunk: string) {
      pending += chunk;
      return drain(false);
    },
    flush() {
      return drain(true);
    },
    sawMarker() {
      return marked;
    },
  };
}

// ─── Rendering & naming ───────────────────────────────────────────────────────

const FORMAT_META: Record<
  VenomFileFormat,
  { contentType: string; ext: string; fallbackSlug: string }
> = {
  pdf: { contentType: "application/pdf", ext: "pdf", fallbackSlug: "document" },
  md: { contentType: "text/markdown", ext: "md", fallbackSlug: "notes" },
  txt: { contentType: "text/plain", ext: "txt", fallbackSlug: "notes" },
  csv: { contentType: "text/csv", ext: "csv", fallbackSlug: "data" },
};

/** `venom-<slug>-<YYYY-MM-DD>.<ext>` — mirrors the markdown-export convention. */
export function chatFileName(title: string, format: VenomFileFormat): string {
  const meta = FORMAT_META[format];
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || meta.fallbackSlug;
  const date = new Date().toISOString().slice(0, 10);
  return `venom-${slug}-${date}.${meta.ext}`;
}

export type RenderedChatFile = {
  data: Buffer;
  contentType: string;
  name: string;
};

/** Render the authored document body into final file bytes. */
export async function renderChatFile(input: {
  plan: VenomFilePlan;
  body: string;
}): Promise<RenderedChatFile> {
  const meta = FORMAT_META[input.plan.format];
  const name = chatFileName(input.plan.title, input.plan.format);
  if (input.plan.format === "pdf") {
    const bytes = await renderVenomPdf({
      title: input.plan.title,
      markdown: input.body,
    });
    return { data: Buffer.from(bytes), contentType: meta.contentType, name };
  }
  const normalized = input.body.replace(/^\s+/, "").replace(/\s+$/, "\n");
  return {
    data: Buffer.from(normalized, "utf8"),
    contentType: meta.contentType,
    name,
  };
}
