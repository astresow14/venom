/**
 * voiceSpeech.ts — pure text plumbing for the spoken side of voice mode.
 *
 * - createSentenceChunker: turns a streaming reply into speakable segments so
 *   synthesis can start on the first sentence instead of the full reply.
 * - sanitizeForSpeech: strips markup and citation markers that would be read
 *   out loud (the transcript keeps the raw text; only the voice is cleaned).
 * - createSseLineReader: minimal SSE `data:` line framing shared by the voice
 *   fetch paths. No network here — fully unit-testable.
 */

export type SentenceChunkerOptions = {
  /** Prefer segments at least this long (except the very first one). */
  minChars?: number;
  /** Hard cap per segment; long sentences split at the last space. */
  maxChars?: number;
};

const DEFAULT_MIN_CHARS = 24;
const DEFAULT_MAX_CHARS = 280;

/**
 * Make text safe and natural to read aloud: remove citation markers, code
 * fences, markdown emphasis/headers/links, and collapse whitespace.
 */
export function sanitizeForSpeech(text: string): string {
  return (
    text
      // Inline source markers are UI metadata, never speech.
      .replace(/\[source:[^\]\s]{1,64}\]/gi, ' ')
      // Fenced code blocks: name that code was skipped rather than reading it.
      .replace(/```[\s\S]*?```/g, ' Code omitted. ')
      .replace(/```[\s\S]*$/g, ' Code omitted. ')
      .replace(/`([^`]*)`/g, '$1')
      // Markdown links: keep the label.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Emphasis/bold/strikethrough markers.
      .replace(/(\*\*|__|\*|_|~~)/g, '')
      // Headers and list bullets at line starts.
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export type SentenceChunker = {
  /** Feed a streamed delta; returns zero or more completed segments. */
  push(delta: string): string[];
  /** Stream ended; returns the final partial segment, if any. */
  flush(): string | null;
};

export function createSentenceChunker(
  options: SentenceChunkerOptions = {},
): SentenceChunker {
  const minChars = options.minChars ?? DEFAULT_MIN_CHARS;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  let buffer = '';
  let emittedAny = false;

  /**
   * Earliest segment boundary at-or-after `from`: a paragraph break or a
   * sentence ender followed by whitespace (whitespace requirement avoids
   * splitting decimals like 3.5). Returns -1 when none exists yet.
   */
  const findBoundary = (from: number): number => {
    const window = buffer.slice(from);
    const paragraph = window.search(/\n\s*\n/);
    const sentenceMatch = window.match(/[.!?…][)"'”’]*\s/);
    const sentence = sentenceMatch?.index ?? -1;
    if (paragraph !== -1 && (sentence === -1 || paragraph < sentence)) {
      return from + paragraph + 1;
    }
    if (sentence !== -1 && sentenceMatch) {
      return from + sentence + sentenceMatch[0].length;
    }
    return -1;
  };

  const takeSegments = (): string[] => {
    const out: string[] = [];
    // Scan repeatedly: each pass may complete one segment.
    outer: for (;;) {
      // The first segment ships at the first boundary (prompt speech start);
      // later ones extend across boundaries until comfortably long, so a
      // short sentence ("Ok.") never stalls the sentences queued behind it.
      let cut = findBoundary(0);
      while (cut !== -1) {
        const clean = sanitizeForSpeech(buffer.slice(0, cut));
        if (clean.length === 0) {
          // Pure markup/whitespace head — drop it and rescan.
          buffer = buffer.slice(cut);
          cut = findBoundary(0);
          continue;
        }
        if (clean.length >= (emittedAny ? minChars : 1)) {
          buffer = buffer.slice(cut);
          out.push(clean);
          emittedAny = true;
          continue outer;
        }
        cut = findBoundary(cut);
      }
      // No qualifying boundary: split anyway when the buffer is unreasonably
      // long, otherwise wait for more streamed text.
      if (buffer.length >= maxChars) {
        const space = buffer.lastIndexOf(' ', maxChars);
        const split = space > maxChars / 2 ? space : maxChars;
        const head = buffer.slice(0, split);
        buffer = buffer.slice(split);
        const clean = sanitizeForSpeech(head);
        if (clean) {
          out.push(clean);
          emittedAny = true;
        }
        continue;
      }
      break;
    }
    return out;
  };

  return {
    push(delta: string): string[] {
      if (typeof delta === 'string' && delta.length > 0) buffer += delta;
      return takeSegments();
    },
    flush(): string | null {
      const clean = sanitizeForSpeech(buffer);
      buffer = '';
      return clean.length > 0 ? clean : null;
    },
  };
}

export type SseLineReader = {
  /** Feed raw streamed text; fires onData for each `data:` payload. */
  push(chunk: string): void;
  /** Flush a trailing unterminated line at stream end. */
  end(): void;
};

export function createSseLineReader(
  onData: (payload: string) => void,
): SseLineReader {
  let pending = '';

  const handleLine = (line: string) => {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trimStart();
    if (payload.length > 0) onData(payload);
  };

  return {
    push(chunk: string) {
      pending += chunk;
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline === -1) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        handleLine(line);
      }
    },
    end() {
      if (pending.length > 0) {
        handleLine(pending);
        pending = '';
      }
    },
  };
}
