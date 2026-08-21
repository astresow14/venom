import assert from "node:assert/strict";
import test from "node:test";

import {
  createSentenceChunker,
  createSseLineReader,
  sanitizeForSpeech,
} from "./voiceSpeech.ts";

// ---- sanitizeForSpeech ----

test("sanitizeForSpeech strips citation markers and markdown", () => {
  assert.equal(
    sanitizeForSpeech("The fix landed [source:src_abc123] yesterday."),
    "The fix landed yesterday.",
  );
  assert.equal(
    sanitizeForSpeech("**Bold** and _italic_ and ~~gone~~."),
    "Bold and italic and gone.",
  );
  assert.equal(
    sanitizeForSpeech("See [the docs](https://example.com) for more."),
    "See the docs for more.",
  );
  assert.equal(
    sanitizeForSpeech("## Heading\n- bullet one\n2. numbered"),
    "Heading bullet one numbered",
  );
  assert.equal(sanitizeForSpeech("Use `pnpm test` here."), "Use pnpm test here.");
});

test("sanitizeForSpeech replaces code blocks instead of reading them", () => {
  const spoken = sanitizeForSpeech(
    "Run this:\n```ts\nconst x = 1;\n```\nThen retry.",
  );
  assert.equal(spoken, "Run this: Code omitted. Then retry.");

  // An unterminated fence (mid-stream flush) is also silenced.
  assert.equal(
    sanitizeForSpeech("Sure:\n```python\nprint('hi')"),
    "Sure: Code omitted.",
  );
});

// ---- createSentenceChunker ----

test("the first sentence ships immediately, even when short", () => {
  const chunker = createSentenceChunker();
  assert.deepEqual(chunker.push("Hi. "), ["Hi."]);
});

test("later short sentences wait for a comfortable minimum", () => {
  const chunker = createSentenceChunker({ minChars: 24 });
  chunker.push("Hello there, good to hear you. ");
  // "Ok. " alone is under minChars — held until more text arrives.
  assert.deepEqual(chunker.push("Ok. "), []);
  const segments = chunker.push("Let me look at the project now. ");
  assert.equal(segments.length, 1);
  assert.match(segments[0], /^Ok\. Let me look/);
});

test("streaming deltas assemble into sentence-sized segments", () => {
  const chunker = createSentenceChunker();
  const out = [];
  for (const delta of ["The bo", "ard has three st", "ages. Each one ", "works."]) {
    out.push(...chunker.push(delta));
  }
  out.push(chunker.flush() ?? "");
  assert.deepEqual(out.filter(Boolean), [
    "The board has three stages.",
    "Each one works.",
  ]);
});

test("decimals do not split sentences", () => {
  const chunker = createSentenceChunker();
  const segments = chunker.push("Version 3.5 shipped today. ");
  assert.deepEqual(segments, ["Version 3.5 shipped today."]);
});

test("very long unpunctuated text splits at a space near maxChars", () => {
  const chunker = createSentenceChunker({ maxChars: 60 });
  const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
  const segments = chunker.push(words);
  assert.ok(segments.length >= 2, "long text produces multiple segments");
  for (const segment of segments) {
    assert.ok(segment.length <= 60, `segment under cap: "${segment}"`);
    assert.ok(!segment.startsWith(" ") && !segment.endsWith(" "));
  }
});

test("flush returns the trailing partial and clears state", () => {
  const chunker = createSentenceChunker();
  chunker.push("This reply just stops mid-thou");
  assert.equal(chunker.flush(), "This reply just stops mid-thou");
  assert.equal(chunker.flush(), null);
});

test("citation markers never reach the spoken segments", () => {
  const chunker = createSentenceChunker();
  const segments = chunker.push(
    "The drawer bug [source:src_9f] is fixed. Next up is sync. ",
  );
  // The trailing sentence is under minChars, so it waits for flush.
  const tail = chunker.flush();
  assert.deepEqual(
    [...segments, tail],
    ["The drawer bug is fixed.", "Next up is sync."],
  );
});

// ---- createSseLineReader ----

test("SSE reader parses data lines across chunk boundaries", () => {
  const seen = [];
  const reader = createSseLineReader((payload) => seen.push(payload));
  reader.push('data: {"a"');
  reader.push(':1}\n\ndata: {"b":2}\n');
  reader.push("\r\ndata: [DONE]\n");
  reader.end();
  assert.deepEqual(seen, ['{"a":1}', '{"b":2}', "[DONE]"]);
});

test("SSE reader ignores comments, events, and blank lines", () => {
  const seen = [];
  const reader = createSseLineReader((payload) => seen.push(payload));
  reader.push(": keep-alive\nevent: message\nid: 4\n\ndata: hello\n");
  reader.end();
  assert.deepEqual(seen, ["hello"]);
});

test("SSE reader flushes an unterminated final line on end", () => {
  const seen = [];
  const reader = createSseLineReader((payload) => seen.push(payload));
  reader.push("data: tail-without-newline");
  assert.deepEqual(seen, []);
  reader.end();
  assert.deepEqual(seen, ["tail-without-newline"]);
});

test("SSE reader handles CRLF framing", () => {
  const seen = [];
  const reader = createSseLineReader((payload) => seen.push(payload));
  reader.push("data: one\r\n\r\ndata: two\r\n");
  assert.deepEqual(seen, ["one", "two"]);
});
