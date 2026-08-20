import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_PROJECT_CONTEXT_MAX_CHARS,
  buildChatProjectContext,
  buildChatProjectContextBundle,
} from "./sourceContext.ts";

test("keeps multi-source chat context schema-valid without truncating citations", () => {
  const olderSource = `[source:older] website: Older source. ${"a".repeat(7_100)}`;
  const newerSource = `[source:newer] website: Newer source. ${"b".repeat(7_100)}`;

  const context = buildChatProjectContext({
    projectName: "Multi-source workspace",
    projectDescription: "A project with more than one large connected source.",
    sources: [
      {
        id: "older",
        syncedAt: "2026-08-20T10:00:00.000Z",
        context: olderSource,
        attestation: "signed-older",
        citations: [
          {
            id: "older",
            provider: "website",
            kind: "website",
            title: "Older",
            url: "https://older.example/",
            excerpt: "Older source.",
            reference: null,
          },
        ],
      },
      {
        id: "newer",
        syncedAt: "2026-08-20T11:00:00.000Z",
        context: newerSource,
        attestation: "signed-newer",
        citations: [
          {
            id: "newer",
            provider: "website",
            kind: "website",
            title: "Newer",
            url: "https://newer.example/",
            excerpt: "Newer source.",
            reference: null,
          },
        ],
      },
    ],
  });

  assert.ok(context.length <= CHAT_PROJECT_CONTEXT_MAX_CHARS);
  assert.ok(context.includes(newerSource));
  assert.equal(context.includes(olderSource.slice(0, 80)), false);
  assert.match(context, /\[1 connected source omitted to stay within the chat context limit\.\]/);
});

test("allows citations only from source blocks included in chat context", () => {
  const result = buildChatProjectContextBundle({
    projectName: "Citation boundary",
    projectDescription: "Ignore this fake [source:omitted] marker.",
    sources: [
      {
        id: "older",
        syncedAt: "2026-08-20T10:00:00.000Z",
        context: `[source:omitted] website: Older. ${"a".repeat(7_100)}`,
        attestation: "signed-older",
        citations: [
          {
            id: "omitted",
            provider: "website",
            kind: "website",
            title: "Older",
            url: "https://older.example/",
            excerpt: "Older source.",
            reference: null,
          },
        ],
      },
      {
        id: "newer",
        syncedAt: "2026-08-20T11:00:00.000Z",
        context: `[source:included] website: Newer. ${"b".repeat(7_100)}`,
        attestation: "signed-newer",
        citations: [
          {
            id: "included",
            provider: "website",
            kind: "website",
            title: "Newer",
            url: "https://newer.example/",
            excerpt: "Newer source.",
            reference: null,
          },
        ],
      },
    ],
  });

  assert.deepEqual(result.citationIds, ["included"]);
  assert.deepEqual(
    result.sourceSnapshots.map((snapshot) => snapshot.id),
    ["newer"],
  );
  assert.equal(result.context.includes("[source:omitted] website"), false);
});