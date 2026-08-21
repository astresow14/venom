/**
 * community-cursor.test.ts
 *
 * Tests cursor encode/decode/tamper-rejection and the 400 behavior contract.
 * Bundled via esbuild + node --test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeCursor, decodeCursor, type FeedOrder } from "./community-cursor";

describe("cursor encode/decode", () => {
  it("roundtrips a 'new' cursor", () => {
    const data = {
      order: "new" as const,
      createdAt: "2025-06-15T12:00:00.000Z",
      id: "550e8400-e29b-41d4-a716-446655440000",
    };
    const encoded = encodeCursor(data);
    const decoded = decodeCursor(encoded, "new");
    assert.deepEqual(decoded, data);
  });

  it("roundtrips a 'top' cursor", () => {
    const data = {
      order: "top" as const,
      voteScore: 42,
      createdAt: "2025-06-15T12:00:00.000Z",
      id: "550e8400-e29b-41d4-a716-446655440000",
    };
    const encoded = encodeCursor(data);
    const decoded = decodeCursor(encoded, "top");
    assert.deepEqual(decoded, data);
  });

  it("returns null when order mismatches", () => {
    const data = {
      order: "new" as const,
      createdAt: "2025-06-15T12:00:00.000Z",
      id: "550e8400-e29b-41d4-a716-446655440000",
    };
    const encoded = encodeCursor(data);
    assert.equal(decodeCursor(encoded, "top"), null);
  });

  it("returns null for garbage input", () => {
    assert.equal(decodeCursor("notbase64url!!!", "new"), null);
    assert.equal(decodeCursor("aGVsbG8", "new"), null); // "hello" — valid base64url, wrong content
    assert.equal(decodeCursor("", "new"), null);
  });

  it("returns null when createdAt is invalid date", () => {
    const tampered = Buffer.from(
      JSON.stringify({
        order: "new",
        createdAt: "not-a-date",
        id: "550e8400-e29b-41d4-a716-446655440000",
      }),
    ).toString("base64url");
    assert.equal(decodeCursor(tampered, "new"), null);
  });

  it("returns null when id is not UUID-shaped", () => {
    const tampered = Buffer.from(
      JSON.stringify({
        order: "new",
        createdAt: "2025-06-15T12:00:00.000Z",
        id: "not-a-uuid",
      }),
    ).toString("base64url");
    assert.equal(decodeCursor(tampered, "new"), null);
  });

  it("returns null when voteScore is not integer for 'top' cursor", () => {
    const tampered = Buffer.from(
      JSON.stringify({
        order: "top",
        voteScore: 3.14,
        createdAt: "2025-06-15T12:00:00.000Z",
        id: "550e8400-e29b-41d4-a716-446655440000",
      }),
    ).toString("base64url");
    assert.equal(decodeCursor(tampered, "top"), null);
  });

  it("cursor encodes only public ordering fields — no auth IDs", () => {
    const data = {
      order: "new" as const,
      createdAt: "2025-06-15T12:00:00.000Z",
      id: "550e8400-e29b-41d4-a716-446655440000",
    };
    const encoded = encodeCursor(data);
    const raw = Buffer.from(encoded, "base64url").toString("utf8");
    assert.ok(!raw.includes("clerk"), "Cursor must not contain auth IDs");
    assert.ok(!raw.includes("userId"), "Cursor must not contain userId");
  });

  it("tampered cursor (appended garbage) returns null", () => {
    const valid = encodeCursor({
      order: "new" as const,
      createdAt: "2025-06-15T12:00:00.000Z",
      id: "550e8400-e29b-41d4-a716-446655440000",
    });
    assert.equal(decodeCursor(valid + "AAAA", "new"), null);
  });
});

// ---------------------------------------------------------------------------
// 400 contract: invalid cursor must be rejected, not silently ignored
// ---------------------------------------------------------------------------

describe("invalid cursor rejection contract", () => {
  it("decodeCursor returns null for invalid cursor (caller must return 400)", () => {
    // This test proves the contract: when decodeCursor returns null for a
    // provided cursor string, the route MUST return 400, not restart at page 1.
    const invalidCursors = [
      "garbage",
      "aaaa",
      Buffer.from('{"order":"new","createdAt":"bad-date","id":"not-uuid"}').toString("base64url"),
      Buffer.from('{"order":"top","voteScore":"not-a-number","createdAt":"2025-01-01T00:00:00Z","id":"550e8400-e29b-41d4-a716-446655440000"}').toString("base64url"),
      Buffer.from('{"order":"new","createdAt":"2025-01-01T00:00:00Z"}').toString("base64url"), // missing id
    ];

    for (const cursor of invalidCursors) {
      const result = decodeCursor(cursor, "new");
      assert.equal(
        result,
        null,
        `Cursor "${cursor.slice(0, 20)}..." must be rejected (null), not silently treated as no cursor`,
      );
    }
  });

  it("decodeCursor returns non-null only for genuinely valid cursors", () => {
    const validNew = encodeCursor({
      order: "new" as const,
      createdAt: "2025-06-15T12:00:00.000Z",
      id: "550e8400-e29b-41d4-a716-446655440000",
    });
    assert.ok(decodeCursor(validNew, "new") !== null, "Valid cursor must be accepted");

    const validTop = encodeCursor({
      order: "top" as const,
      voteScore: 0,
      createdAt: "2025-06-15T12:00:00.000Z",
      id: "550e8400-e29b-41d4-a716-446655440000",
    });
    assert.ok(decodeCursor(validTop, "top") !== null, "Valid top cursor must be accepted");
  });

  it("voteScore=0 (no votes) is a valid top cursor value", () => {
    const cursor = encodeCursor({
      order: "top" as const,
      voteScore: 0,
      createdAt: "2025-01-01T00:00:00.000Z",
      id: "550e8400-e29b-41d4-a716-446655440000",
    });
    const decoded = decodeCursor(cursor, "top");
    assert.ok(decoded !== null);
    assert.ok(decoded!.order === "top" && decoded.voteScore === 0);
  });
});
