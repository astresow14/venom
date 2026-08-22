/**
 * Unit tests for the file-production pipeline: the intent gate, the
 * JSON-only classifier (with a stubbed model stream), the SUMMARY/DOCUMENT
 * stream splitter across hostile chunk boundaries, filename convention,
 * and the markdown→PDF renderer (round-tripped through a PDF text
 * extractor to prove real content lands on the page).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAuthoringInstruction,
  chatFileName,
  classifyFileIntent,
  createAuthoringStreamSplitter,
  DOCUMENT_MARKER,
  fileIntentGate,
  renderChatFile,
} from "./venom-file-authoring";
import {
  parseInlineSpans,
  parseMarkdownBlocks,
  renderVenomPdf,
  sanitizeWinAnsiText,
} from "./venom-pdf-render";

// ─── Intent gate ──────────────────────────────────────────────────────────────

test("fileIntentGate fires on file-production phrasings", () => {
  for (const message of [
    "Can you make me a PDF about sea turtles?",
    "create a report on our Q3 numbers",
    "Export this as markdown please",
    "turn our conversation into a document",
    "I need a checklist of onboarding steps as a file",
    "write up a proposal for the client and give it to me as a pdf",
    "generate a csv of the model list",
  ]) {
    assert.equal(fileIntentGate(message), true, message);
  }
});

test("fileIntentGate stays quiet on ordinary chat", () => {
  for (const message of [
    "how are you today",
    "tell me about docker containers",
    "summarize our discussion so far",
    "what did we decide about the roadmap yesterday?",
    "why is the sky blue",
  ]) {
    assert.equal(fileIntentGate(message), false, message);
  }
});

// ─── Classifier ───────────────────────────────────────────────────────────────

function streamOf(...chunks: string[]) {
  return async function* () {
    for (const chunk of chunks) yield chunk;
  };
}

test("classifyFileIntent parses a clean JSON verdict split across chunks", async () => {
  const plan = await classifyFileIntent({
    stream: () =>
      streamOf('{"produce":true,"for', 'mat":"md","title":"Turtle Report"}')(),
    userMessage: "make me a markdown file about turtles",
    signal: new AbortController().signal,
  });
  assert.deepEqual(plan, { format: "md", title: "Turtle Report" });
});

test("classifyFileIntent tolerates prose around the JSON object", async () => {
  const plan = await classifyFileIntent({
    stream: () =>
      streamOf(
        'Sure! {"produce": true, "format": "pdf", "title": "Q3 Plan"} hope that helps',
      )(),
    userMessage: "pdf please",
    signal: new AbortController().signal,
  });
  assert.deepEqual(plan, { format: "pdf", title: "Q3 Plan" });
});

test("classifyFileIntent returns null on produce:false, junk, and errors", async () => {
  const cases: Array<() => AsyncIterable<string>> = [
    streamOf('{"produce":false,"format":"pdf","title":"No"}'),
    streamOf("I am not JSON at all"),
    streamOf(""),
    async function* () {
      throw new Error("provider exploded");
    },
  ];
  for (const stream of cases) {
    const plan = await classifyFileIntent({
      stream: () => stream(),
      userMessage: "irrelevant",
      signal: new AbortController().signal,
    });
    assert.equal(plan, null);
  }
});

test("classifyFileIntent falls back to pdf for unknown formats and clamps titles", async () => {
  const plan = await classifyFileIntent({
    stream: () =>
      streamOf(
        `{"produce":true,"format":"docx","title":"${"x".repeat(300)}"}`,
      )(),
    userMessage: "file please",
    signal: new AbortController().signal,
  });
  assert.equal(plan?.format, "pdf");
  assert.equal(plan?.title.length, 120);
});

// ─── Stream splitter ──────────────────────────────────────────────────────────

function runSplitter(chunks: string[]): {
  chat: string;
  doc: string;
  sawMarker: boolean;
} {
  const splitter = createAuthoringStreamSplitter();
  let chat = "";
  let doc = "";
  for (const chunk of chunks) {
    const out = splitter.push(chunk);
    chat += out.chat;
    doc += out.doc;
  }
  const tail = splitter.flush();
  chat += tail.chat;
  doc += tail.doc;
  return { chat, doc, sawMarker: splitter.sawMarker() };
}

test("splitter separates summary from document with marker in one chunk", () => {
  const result = runSplitter([
    `SUMMARY: Here is your report.\n${DOCUMENT_MARKER}\n# Report\n\nBody.`,
  ]);
  assert.equal(result.chat, "Here is your report.");
  assert.equal(result.doc, "# Report\n\nBody.");
  assert.equal(result.sawMarker, true);
});

test("splitter recognizes the marker split across many chunks", () => {
  const result = runSplitter([
    "SUMM",
    "ARY: The doc",
    " is coming.\n--",
    "-DOCU",
    "MENT-",
    "--\nLine one\n",
    "Line two",
  ]);
  assert.equal(result.chat, "The doc is coming.");
  assert.equal(result.doc, "Line one\nLine two");
  assert.equal(result.sawMarker, true);
});

test("splitter fails open when no marker ever arrives", () => {
  const result = runSplitter(["Just a normal answer, ", "no file here."]);
  assert.equal(result.chat, "Just a normal answer, no file here.");
  assert.equal(result.doc, "");
  assert.equal(result.sawMarker, false);
});

test("splitter works without the SUMMARY label and preserves doc text verbatim", () => {
  const body = "alpha\n\nbeta `code` **bold**\n";
  const result = runSplitter([`quick note ${DOCUMENT_MARKER}\n${body}`]);
  assert.equal(result.chat, "quick note");
  assert.equal(result.doc, body);
});

test("splitter streams chat incrementally while withholding only a marker-sized tail", () => {
  const splitter = createAuthoringStreamSplitter();
  splitter.push("SUMMARY: ");
  const early = splitter.push(
    "This is a long summary sentence that should stream out well before the marker arrives.",
  );
  assert.ok(
    early.chat.length > 40,
    `expected streamed chat, got ${JSON.stringify(early.chat)}`,
  );
});

// ─── Naming & rendering ───────────────────────────────────────────────────────

test("chatFileName follows the venom-<slug>-<date>.<ext> convention", () => {
  assert.match(
    chatFileName("Q3 Revenue Report!", "pdf"),
    /^venom-q3-revenue-report-\d{4}-\d{2}-\d{2}\.pdf$/,
  );
  assert.match(chatFileName("///", "csv"), /^venom-data-\d{4}-\d{2}-\d{2}\.csv$/);
  const long = chatFileName(`${"very ".repeat(30)}long`, "md");
  const slug = long.replace(/^venom-/, "").replace(/-\d{4}-\d{2}-\d{2}\.md$/, "");
  assert.ok(slug.length <= 40, slug);
  assert.ok(!slug.endsWith("-"));
});

test("buildAuthoringInstruction pins the exact stream protocol", () => {
  const instruction = buildAuthoringInstruction({
    format: "pdf",
    title: "Test Doc",
  });
  assert.ok(instruction.includes(DOCUMENT_MARKER));
  assert.ok(instruction.includes("SUMMARY:"));
  assert.ok(instruction.includes("Test Doc"));
});

test("renderChatFile passes text formats through and renders pdf bytes", async () => {
  const md = await renderChatFile({
    plan: { format: "md", title: "Notes" },
    body: "\n# Hi\n\ntext\n\n",
  });
  assert.equal(md.contentType, "text/markdown");
  assert.equal(md.data.toString("utf8"), "# Hi\n\ntext\n");
  assert.match(md.name, /\.md$/);

  const csv = await renderChatFile({
    plan: { format: "csv", title: "Data" },
    body: "a,b\n1,2\n",
  });
  assert.equal(csv.contentType, "text/csv");
  assert.equal(csv.data.toString("utf8"), "a,b\n1,2\n");

  const pdf = await renderChatFile({
    plan: { format: "pdf", title: "Doc" },
    body: "# Heading\n\nParagraph.",
  });
  assert.equal(pdf.contentType, "application/pdf");
  assert.equal(pdf.data.subarray(0, 5).toString("latin1"), "%PDF-");
});

// ─── Markdown parsing ─────────────────────────────────────────────────────────

test("parseInlineSpans handles bold, italic, code, and unmatched markers", () => {
  const spans = parseInlineSpans("a **b** `c` *d* **unclosed");
  assert.deepEqual(
    spans.map((s) => [s.text, s.bold, s.italic, s.code]),
    [
      ["a ", false, false, false],
      ["b", true, false, false],
      [" ", false, false, false],
      ["c", false, false, true],
      [" ", false, false, false],
      ["d", false, true, false],
      [" **unclosed", false, false, false],
    ],
  );
});

test("parseMarkdownBlocks recognizes the supported block kinds", () => {
  const blocks = parseMarkdownBlocks(
    [
      "# Title",
      "",
      "First paragraph",
      "continues here.",
      "",
      "- one",
      "- two",
      "",
      "1. first",
      "2. second",
      "",
      "> a quote",
      "",
      "```",
      "code line",
      "```",
      "",
      "---",
      "",
      "Tail paragraph.",
    ].join("\n"),
  );
  assert.deepEqual(
    blocks.map((block) => block.kind),
    [
      "heading",
      "paragraph",
      "bullet",
      "numbered",
      "quote",
      "code",
      "hr",
      "paragraph",
    ],
  );
  const bullet = blocks[2];
  assert.ok(bullet.kind === "bullet" && bullet.items.length === 2);
});

// ─── WinAnsi sanitation ───────────────────────────────────────────────────────

test("sanitizeWinAnsiText keeps Latin-1, maps arrows, collapses the unencodable", () => {
  assert.equal(sanitizeWinAnsiText("café — “quotes”"), "café — “quotes”");
  assert.equal(sanitizeWinAnsiText("a → b"), "a -> b");
  assert.equal(sanitizeWinAnsiText("rocket 🚀🚀 launch"), "rocket ? launch");
  assert.equal(sanitizeWinAnsiText("日本 words"), "? words");
});

// ─── PDF round trip ───────────────────────────────────────────────────────────

test("renderVenomPdf produces a real multi-block PDF whose text survives extraction", async () => {
  const bytes = await renderVenomPdf({
    title: "Symbiote Notes",
    markdown: [
      "# Living Material",
      "",
      "The suit is **living black material** with stark white contrast.",
      "",
      "- organic motion",
      "- quiet interfaces",
      "",
      "> restraint is a feature",
      "",
      "```",
      "const bond = deepen();",
      "```",
      "",
      "Unicode survives: café → progress 🚀 done.",
    ].join("\n"),
  });
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString("latin1"), "%PDF-");

  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  assert.match(text, /Symbiote Notes/);
  assert.match(text, /living black material/);
  assert.match(text, /organic motion/);
  assert.match(text, /restraint is a feature/);
  assert.match(text, /const bond = deepen\(\);/);
  assert.match(text, /café -> progress \? done\./);
  assert.match(text, /VENOM/); // footer wordmark
});

test("renderVenomPdf paginates long documents instead of overflowing", async () => {
  const paragraphs = Array.from(
    { length: 120 },
    (_, i) => `Paragraph ${i} with enough words to take a full line or two of space in the column.`,
  ).join("\n\n");
  const bytes = await renderVenomPdf({ title: "Long Doc", markdown: paragraphs });
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  assert.ok(pdf.numPages >= 3, `expected pagination, got ${pdf.numPages} pages`);
});
