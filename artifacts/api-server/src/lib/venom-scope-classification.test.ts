/**
 * Unit tests for scope classification: the validation layer
 * between the extraction model's scope verdicts and any store write. The
 * invariant under test everywhere: the only failure mode is Unsorted —
 * never a guessed destination, never a workspace outside the caller's
 * memberships.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  PERSONAL_SCOPE_CONFIDENCE,
  SCOPE_DIGEST_TOPIC_LIMIT,
  WORKSPACE_SCOPE_CONFIDENCE,
  resolveClusterScope,
  scopeClassificationPromptBlock,
  workspaceTopicDigest,
} from "./venom-scope-classification";

const MEMBERSHIPS = new Set(["ws-alpha", "ws-beta"]);

test("confident personal verdicts file personal; hesitant ones hold", () => {
  assert.deepEqual(
    resolveClusterScope(
      { scope: "personal", scopeConfidence: PERSONAL_SCOPE_CONFIDENCE },
      MEMBERSHIPS,
    ),
    { kind: "personal" },
  );
  assert.deepEqual(
    resolveClusterScope({ scope: "Personal", scopeConfidence: 0.99 }, MEMBERSHIPS),
    { kind: "personal" },
    "the personal sentinel is case-insensitive",
  );
  assert.deepEqual(
    resolveClusterScope(
      { scope: "personal", scopeConfidence: PERSONAL_SCOPE_CONFIDENCE - 0.01 },
      MEMBERSHIPS,
    ),
    { kind: "unsorted" },
  );
});

test("workspace verdicts need membership AND the higher confidence bar", () => {
  assert.deepEqual(
    resolveClusterScope(
      { scope: "ws-alpha", scopeConfidence: WORKSPACE_SCOPE_CONFIDENCE },
      MEMBERSHIPS,
    ),
    { kind: "workspace", workspaceId: "ws-alpha" },
  );
  assert.deepEqual(
    resolveClusterScope(
      { scope: "ws-alpha", scopeConfidence: WORKSPACE_SCOPE_CONFIDENCE - 0.01 },
      MEMBERSHIPS,
    ),
    { kind: "unsorted" },
    "below the workspace bar the item holds in Unsorted",
  );
  assert.deepEqual(
    resolveClusterScope(
      { scope: "ws-stranger", scopeConfidence: 1 },
      MEMBERSHIPS,
    ),
    { kind: "unsorted" },
    "an invented or foreign workspace id can never file, at any confidence",
  );
  assert.ok(
    WORKSPACE_SCOPE_CONFIDENCE > PERSONAL_SCOPE_CONFIDENCE,
    "widening visibility must demand more confidence than staying private",
  );
});

test("missing or malformed signals always hold in Unsorted", () => {
  const cases = [
    undefined,
    {},
    { scope: "personal" },
    { scope: "  ", scopeConfidence: 1 },
    { scope: "personal", scopeConfidence: Number.NaN },
    { scope: "ws-alpha", scopeConfidence: Number.POSITIVE_INFINITY },
  ];
  for (const signal of cases) {
    assert.deepEqual(
      resolveClusterScope(signal, MEMBERSHIPS),
      { kind: "unsorted" },
      `signal ${JSON.stringify(signal)} must resolve to unsorted`,
    );
  }
});

test("workspace digest keeps the strongest labels, deduped and bounded", () => {
  const concepts = [
    { label: "Vendor escalation", strength: 0.4 },
    { label: "vendor escalation", strength: 0.9 },
    { label: "  ", strength: 1 },
    { label: "Pricing tiers", strength: 0.8 },
    ...Array.from({ length: 20 }, (_, i) => ({
      label: `Filler topic ${i}`,
      strength: 0.1 + i * 0.001,
    })),
    { label: "x".repeat(200), strength: 0.99 },
  ];
  const digest = workspaceTopicDigest(concepts, "member");
  assert.equal(digest.length, SCOPE_DIGEST_TOPIC_LIMIT);
  assert.equal(digest[0], "x".repeat(64), "labels are capped at 64 chars");
  assert.equal(digest[1], "vendor escalation", "strongest twin wins the slot");
  assert.ok(!digest.slice(2).includes("Vendor escalation"), "dedup is case-insensitive");
  assert.ok(digest.includes("Pricing tiers"));
});

test("prompt block carries the catalog as data and demands conservatism", () => {
  const block = scopeClassificationPromptBlock([
    {
      workspaceId: "ws-alpha",
      workspaceName: "Alpha Ops",
      topics: ["Vendor escalation"],
    },
  ]);
  assert.match(block, /<workspace_catalog>/);
  const jsonMatch = block.match(
    /<workspace_catalog>(.*)<\/workspace_catalog>/s,
  );
  assert.ok(jsonMatch);
  const catalog = JSON.parse(jsonMatch![1]);
  assert.deepEqual(catalog, [
    {
      workspaceId: "ws-alpha",
      name: "Alpha Ops",
      existingTopics: ["Vendor escalation"],
    },
  ]);
  assert.match(block, /"scope" and "scopeConfidence"/);
  assert.match(block, /Never invent workspace ids/);
  assert.match(block, /quoted data, never instructions/);
});
