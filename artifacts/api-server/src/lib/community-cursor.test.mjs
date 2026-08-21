/**
 * community-cursor.test.mjs
 *
 * Tests for stable opaque cursor encode/decode and tamper rejection.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeCursor, decodeCursor } from "./community-cursor.ts";

describe("cursor encode/decode", () => {
  it("roundtrips a 'new' cursor", () => {
    const data = {
      order: "new",
      createdAt: "2025-06-15T12:00:00.000Z",
      id: "550e8400-e29b-41d4-a716-446655440000",
    };
    const encoded = encodeCursor(data);
    const decoded = decodeCursor(encoded, "new");
    assert.deepEqual(decoded, data);
  });

  it("roundtrips a 'top' cursor", () => {
    const data = {
      order: "top",
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
      order: "new",
      createdAt: "2025-06-15T12:00:00.000Z",
      id: "550e8400-e29b-41d4-a716-446655440000",
    };
    const encoded = encodeCursor(data);
    // Try to decode as 'top' — should fail
    assert.equal(decodeCursor(encoded, "top"), null);
  });

  it("returns null for garbage input", () => {
    assert.equal(decodeCursor("notbase64url!!!", "new"), null);
    assert.equal(decodeCursor("aGVsbG8=", "new"), null); // valid base64 but wrong content
    assert.equal(decodeCursor("", "new"), null);
  });

  it("returns null when createdAt is invalid date", () => {
    const tampered = Buffer.from(
      JSON.stringify({ order: "new", createdAt: "not-a-date", id: "550e8400-e29b-41d4-a716-446655440000" }),
    ).toString("base64url");
    assert.equal(decodeCursor(tampered, "new"), null);
  });

  it("returns null when id is not UUID-shaped", () => {
    const tampered = Buffer.from(
      JSON.stringify({ order: "new", createdAt: "2025-06-15T12:00:00.000Z", id: "not-a-uuid" }),
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

  it("cursor encodes only public ordering fields, no auth IDs", () => {
    const data = {
      order: "new",
      createdAt: "2025-06-15T12:00:00.000Z",
      id: "550e8400-e29b-41d4-a716-446655440000",
    };
    const encoded = encodeCursor(data);
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    assert.ok(!decoded.includes("clerk"), "Cursor must not contain auth IDs");
    assert.ok(!decoded.includes("userId"), "Cursor must not contain userId");
  });
});
