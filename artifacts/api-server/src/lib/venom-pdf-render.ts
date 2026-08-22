/**
 * Monochrome PDF renderer for Venom-authored documents.
 *
 * pdf-lib was chosen over pdfkit because it is pure JS and embeds the
 * standard fonts without reading .afm files from disk at runtime — the
 * api-server ships as one esbuild bundle where runtime file reads break.
 *
 * The layout engine is deliberately small: a line-based markdown parser
 * (headings, paragraphs, lists, code, quotes, rules, inline bold/italic/
 * code) feeding a word-wrapping paginator. Standard fonts only encode
 * WinAnsi, so all text passes through `sanitizeWinAnsiText` first.
 */
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";

// ─── Inline spans ─────────────────────────────────────────────────────────────

export type InlineSpan = {
  text: string;
  bold: boolean;
  italic: boolean;
  code: boolean;
};

/**
 * Parse `**bold**`, `*italic*` (and `_..._`), `***both***`, and `` `code` ``
 * into flat spans. Unmatched markers stay literal text — model output is
 * unreliable and a stray asterisk must never eat the rest of a paragraph.
 */
export function parseInlineSpans(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let plain = "";
  const push = (t: string, bold: boolean, italic: boolean, code: boolean) => {
    if (t) spans.push({ text: t, bold, italic, code });
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let matched: RegExpExecArray | null = null;
    let bold = false;
    let italic = false;
    let code = false;
    if ((matched = /^`([^`]+)`/.exec(rest))) {
      code = true;
    } else if ((matched = /^\*\*\*([^*]+)\*\*\*/.exec(rest))) {
      bold = italic = true;
    } else if ((matched = /^\*\*([^*]+)\*\*/.exec(rest))) {
      bold = true;
    } else if ((matched = /^__([^_]+)__/.exec(rest))) {
      bold = true;
    } else if ((matched = /^\*([^*\s][^*]*)\*/.exec(rest))) {
      italic = true;
    } else if ((matched = /^_([^_\s][^_]*)_/.exec(rest))) {
      italic = true;
    }
    if (matched) {
      push(plain, false, false, false);
      plain = "";
      push(matched[1], bold, italic, code);
      i += matched[0].length;
    } else {
      plain += text[i];
      i += 1;
    }
  }
  push(plain, false, false, false);
  return spans;
}

// ─── Block parsing ────────────────────────────────────────────────────────────

export type MarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3; spans: InlineSpan[] }
  | { kind: "paragraph"; spans: InlineSpan[] }
  | { kind: "bullet"; items: InlineSpan[][] }
  | { kind: "numbered"; items: InlineSpan[][] }
  | { kind: "code"; lines: string[] }
  | { kind: "quote"; spans: InlineSpan[] }
  | { kind: "hr" };

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");

  let paragraph: string[] = [];
  let bullets: string[] | null = null;
  let numbered: string[] | null = null;
  let quote: string[] = [];
  let code: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({
        kind: "paragraph",
        spans: parseInlineSpans(paragraph.join(" ")),
      });
      paragraph = [];
    }
  };
  const flushLists = () => {
    if (bullets?.length) {
      blocks.push({ kind: "bullet", items: bullets.map(parseInlineSpans) });
    }
    bullets = null;
    if (numbered?.length) {
      blocks.push({ kind: "numbered", items: numbered.map(parseInlineSpans) });
    }
    numbered = null;
  };
  const flushQuote = () => {
    if (quote.length) {
      blocks.push({ kind: "quote", spans: parseInlineSpans(quote.join(" ")) });
      quote = [];
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushLists();
    flushQuote();
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");

    if (code !== null) {
      if (/^\s*```/.test(line)) {
        blocks.push({ kind: "code", lines: code });
        code = null;
      } else {
        code.push(rawLine.replace(/\t/g, "  "));
      }
      continue;
    }
    if (/^\s*```/.test(line)) {
      flushAll();
      code = [];
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = Math.min(heading[1].length, 3) as 1 | 2 | 3;
      blocks.push({
        kind: "heading",
        level,
        spans: parseInlineSpans(heading[2].trim()),
      });
      continue;
    }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushAll();
      blocks.push({ kind: "hr" });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      flushQuote();
      if (numbered) flushLists();
      (bullets ??= []).push(bullet[1]);
      continue;
    }
    const ordered = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      flushParagraph();
      flushQuote();
      if (bullets) flushLists();
      (numbered ??= []).push(ordered[1]);
      continue;
    }
    const quoted = /^\s*>\s?(.*)$/.exec(line);
    if (quoted) {
      flushParagraph();
      flushLists();
      quote.push(quoted[1]);
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    flushLists();
    flushQuote();
    paragraph.push(line.trim());
  }
  if (code !== null && code.length) blocks.push({ kind: "code", lines: code });
  flushAll();
  return blocks;
}

// ─── WinAnsi sanitation ───────────────────────────────────────────────────────

const WIN_ANSI_EXTRAS =
  "\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178";
const WIN_ANSI_OK = new RegExp(`^[\\x20-\\x7E\\u00A0-\\u00FF${WIN_ANSI_EXTRAS}]$`);

const CHAR_FALLBACKS: Record<string, string> = {
  "\u2192": "->",
  "\u2190": "<-",
  "\u2194": "<->",
  "\u21D2": "=>",
  "\u2212": "-",
  "\u2713": "v",
  "\u2714": "v",
  "\u2717": "x",
  "\u2718": "x",
  "\u00A0": " ",
  "\t": "  ",
};

/**
 * Standard fonts encode only WinAnsi; pdf-lib throws on anything else.
 * Known symbols get readable ASCII fallbacks, every other unencodable run
 * collapses to a single '?', which is honest about lost content.
 */
export function sanitizeWinAnsiText(text: string): string {
  let out = "";
  let lostRun = false;
  for (const ch of text.normalize("NFC")) {
    const mapped = CHAR_FALLBACKS[ch];
    if (mapped !== undefined) {
      out += mapped;
      lostRun = false;
      continue;
    }
    if (WIN_ANSI_OK.test(ch)) {
      out += ch;
      lostRun = false;
    } else if (!lostRun) {
      out += "?";
      lostRun = true;
    }
  }
  return out;
}

// ─── Layout ───────────────────────────────────────────────────────────────────

const PAGE_WIDTH = 612; // US Letter
const PAGE_HEIGHT = 792;
const MARGIN = 64;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const FOOTER_ZONE = 40;

const INK = rgb(0.08, 0.08, 0.08);
const MUTED = rgb(0.45, 0.45, 0.45);
const RULE = rgb(0.8, 0.8, 0.8);
const CODE_BG = rgb(0.955, 0.955, 0.955);

type Fonts = {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
  code: PDFFont;
};

type Segment = { text: string; font: PDFFont; size: number };

function fontFor(fonts: Fonts, span: InlineSpan): PDFFont {
  if (span.code) return fonts.code;
  if (span.bold && span.italic) return fonts.boldItalic;
  if (span.bold) return fonts.bold;
  if (span.italic) return fonts.italic;
  return fonts.regular;
}

/** Greedy word wrap over styled spans; long words hard-break by characters. */
function wrapSpans(
  fonts: Fonts,
  spans: InlineSpan[],
  size: number,
  maxWidth: number,
): Segment[][] {
  const lines: Segment[][] = [];
  let line: Segment[] = [];
  let lineWidth = 0;

  const pushLine = () => {
    if (line.length) lines.push(line);
    line = [];
    lineWidth = 0;
  };
  const append = (text: string, font: PDFFont, fontSize: number) => {
    if (!text) return;
    const last = line[line.length - 1];
    if (last && last.font === font && last.size === fontSize) {
      last.text += text;
    } else {
      line.push({ text, font, size: fontSize });
    }
  };

  for (const span of spans) {
    const font = fontFor(fonts, span);
    const fontSize = span.code ? size - 1 : size;
    const words = sanitizeWinAnsiText(span.text).split(/(\s+)/);
    for (const word of words) {
      if (!word) continue;
      const width = font.widthOfTextAtSize(word, fontSize);
      if (lineWidth + width <= maxWidth || line.length === 0) {
        if (line.length === 0 && /^\s+$/.test(word)) continue;
        if (lineWidth + width > maxWidth && line.length === 0) {
          // Single word wider than the column: hard-break by characters.
          let piece = "";
          for (const ch of word) {
            const w = font.widthOfTextAtSize(piece + ch, fontSize);
            if (w > maxWidth && piece) {
              append(piece, font, fontSize);
              pushLine();
              piece = ch;
            } else {
              piece += ch;
            }
          }
          append(piece, font, fontSize);
          lineWidth = font.widthOfTextAtSize(piece, fontSize);
          continue;
        }
        append(word, font, fontSize);
        lineWidth += width;
      } else {
        pushLine();
        if (!/^\s+$/.test(word)) {
          append(word, font, fontSize);
          lineWidth = width;
        }
      }
    }
  }
  pushLine();
  return lines;
}

function hardWrapMono(
  font: PDFFont,
  text: string,
  size: number,
  maxWidth: number,
): string[] {
  const sanitized = sanitizeWinAnsiText(text);
  if (!sanitized) return [""];
  const out: string[] = [];
  let piece = "";
  for (const ch of sanitized) {
    if (font.widthOfTextAtSize(piece + ch, size) > maxWidth && piece) {
      out.push(piece);
      piece = ch;
    } else {
      piece += ch;
    }
  }
  out.push(piece);
  return out;
}

export type RenderVenomPdfInput = {
  title: string;
  markdown: string;
  /** Shown under the title; defaults to today's date. */
  generatedAtLabel?: string;
};

/** Render markdown to a monochrome, paginated PDF. Returns the file bytes. */
export async function renderVenomPdf(
  input: RenderVenomPdfInput,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(input.title);
  doc.setProducer("Venom");
  doc.setCreator("Venom");

  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    code: await doc.embedFont(StandardFonts.Courier),
  };

  let page: PDFPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  const ensureRoom = (needed: number) => {
    if (y - needed < MARGIN + FOOTER_ZONE) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
  };

  const drawSegments = (segments: Segment[], x: number, baseline: number) => {
    let cursor = x;
    for (const segment of segments) {
      page.drawText(segment.text, {
        x: cursor,
        y: baseline,
        size: segment.size,
        font: segment.font,
        color: INK,
      });
      cursor += segment.font.widthOfTextAtSize(segment.text, segment.size);
    }
  };

  const drawWrapped = (
    spans: InlineSpan[],
    size: number,
    x: number,
    width: number,
    lineHeight: number,
  ) => {
    const lines = wrapSpans(fonts, spans, size, width);
    for (const line of lines) {
      ensureRoom(lineHeight);
      y -= lineHeight;
      drawSegments(line, x, y);
    }
    return lines.length;
  };

  // Title block.
  const title = sanitizeWinAnsiText(input.title.trim()) || "Document";
  for (const line of wrapSpans(
    fonts,
    [{ text: title, bold: true, italic: false, code: false }],
    24,
    CONTENT_WIDTH,
  )) {
    ensureRoom(30);
    y -= 30;
    drawSegments(line, MARGIN, y);
  }
  y -= 10;
  const dateLabel =
    input.generatedAtLabel ??
    new Date().toISOString().slice(0, 10);
  page.drawText(sanitizeWinAnsiText(dateLabel), {
    x: MARGIN,
    y: y - 9,
    size: 9,
    font: fonts.regular,
    color: MUTED,
  });
  y -= 16;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_WIDTH - MARGIN, y },
    thickness: 1,
    color: INK,
  });
  y -= 18;

  const blocks = parseMarkdownBlocks(input.markdown);
  for (const block of blocks) {
    switch (block.kind) {
      case "heading": {
        const size = block.level === 1 ? 17 : block.level === 2 ? 14 : 11.5;
        ensureRoom(size * 2.4);
        y -= size * 0.9;
        drawWrapped(
          block.spans.map((s) => ({ ...s, bold: true })),
          size,
          MARGIN,
          CONTENT_WIDTH,
          size * 1.3,
        );
        y -= 4;
        break;
      }
      case "paragraph": {
        drawWrapped(block.spans, 10.5, MARGIN, CONTENT_WIDTH, 15.5);
        y -= 7;
        break;
      }
      case "bullet":
      case "numbered": {
        const indent = 22;
        block.items.forEach((item, index) => {
          const lines = wrapSpans(fonts, item, 10.5, CONTENT_WIDTH - indent);
          lines.forEach((line, lineIndex) => {
            ensureRoom(15.5);
            y -= 15.5;
            if (lineIndex === 0) {
              const marker =
                block.kind === "bullet" ? "\u2022" : `${index + 1}.`;
              page.drawText(marker, {
                x: MARGIN + (block.kind === "bullet" ? 6 : 2),
                y,
                size: 10.5,
                font: fonts.regular,
                color: INK,
              });
            }
            drawSegments(line, MARGIN + indent, y);
          });
          y -= 3;
        });
        y -= 4;
        break;
      }
      case "code": {
        const lineHeight = 12.5;
        const pad = 8;
        let remaining = block.lines.flatMap((line) =>
          hardWrapMono(fonts.code, line, 8.5, CONTENT_WIDTH - pad * 2),
        );
        if (remaining.length === 0) remaining = [""];
        while (remaining.length) {
          ensureRoom(lineHeight + pad * 2);
          const available = Math.floor(
            (y - (MARGIN + FOOTER_ZONE) - pad * 2) / lineHeight,
          );
          const take = Math.max(1, Math.min(available, remaining.length));
          const slice = remaining.slice(0, take);
          remaining = remaining.slice(take);
          const boxHeight = slice.length * lineHeight + pad * 2;
          page.drawRectangle({
            x: MARGIN,
            y: y - boxHeight,
            width: CONTENT_WIDTH,
            height: boxHeight,
            color: CODE_BG,
          });
          let lineY = y - pad;
          for (const codeLine of slice) {
            lineY -= lineHeight;
            page.drawText(codeLine, {
              x: MARGIN + pad,
              y: lineY + 3,
              size: 8.5,
              font: fonts.code,
              color: INK,
            });
          }
          y -= boxHeight;
          if (remaining.length) {
            page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
            y = PAGE_HEIGHT - MARGIN;
          }
        }
        y -= 8;
        break;
      }
      case "quote": {
        const indent = 16;
        const before = y;
        drawWrapped(
          block.spans.map((s) => ({ ...s, italic: true })),
          10.5,
          MARGIN + indent,
          CONTENT_WIDTH - indent,
          15.5,
        );
        page.drawRectangle({
          x: MARGIN + 2,
          y: y - 2,
          width: 2,
          height: Math.max(before - y, 12),
          color: INK,
        });
        y -= 8;
        break;
      }
      case "hr": {
        ensureRoom(20);
        y -= 12;
        page.drawLine({
          start: { x: MARGIN, y },
          end: { x: PAGE_WIDTH - MARGIN, y },
          thickness: 0.75,
          color: RULE,
        });
        y -= 8;
        break;
      }
    }
  }

  // Footer on every page: thin rule, wordmark left, page number right.
  const pages = doc.getPages();
  pages.forEach((p, index) => {
    p.drawLine({
      start: { x: MARGIN, y: MARGIN - 14 },
      end: { x: PAGE_WIDTH - MARGIN, y: MARGIN - 14 },
      thickness: 0.5,
      color: RULE,
    });
    p.drawText("VENOM", {
      x: MARGIN,
      y: MARGIN - 26,
      size: 7,
      font: fonts.bold,
      color: MUTED,
    });
    const label = `${index + 1} / ${pages.length}`;
    p.drawText(label, {
      x:
        PAGE_WIDTH -
        MARGIN -
        fonts.regular.widthOfTextAtSize(label, 7),
      y: MARGIN - 26,
      size: 7,
      font: fonts.regular,
      color: MUTED,
    });
  });

  return doc.save();
}
