/**
 * community-cursor.ts
 *
 * Stable opaque cursor helpers for community feed pagination.
 * Cursors encode only public ordering fields; never auth IDs or private data.
 * Tampered/invalid cursors are rejected.
 */

export type FeedOrder = "new" | "top";

// Cursor encodes the last seen item's ordering fields
type NewCursorData = {
  order: "new";
  createdAt: string; // ISO
  id: string; // UUID
};

type TopCursorData = {
  order: "top";
  voteScore: number;
  createdAt: string; // ISO
  id: string; // UUID
};

export type CursorData = NewCursorData | TopCursorData;

export function encodeCursor(data: CursorData): string {
  return Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
}

export function decodeCursor(
  raw: string,
  expectedOrder: FeedOrder,
): CursorData | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;

    const obj = parsed as Record<string, unknown>;

    if (obj["order"] !== expectedOrder) return null;

    if (expectedOrder === "new") {
      if (
        typeof obj["createdAt"] !== "string" ||
        typeof obj["id"] !== "string"
      ) {
        return null;
      }
      // Validate ISO date
      const d = new Date(obj["createdAt"] as string);
      if (isNaN(d.getTime())) return null;
      // Validate UUID-ish
      if (!/^[0-9a-fA-F-]{36}$/.test(obj["id"] as string)) return null;
      return {
        order: "new",
        createdAt: obj["createdAt"] as string,
        id: obj["id"] as string,
      };
    }

    if (expectedOrder === "top") {
      if (
        typeof obj["voteScore"] !== "number" ||
        typeof obj["createdAt"] !== "string" ||
        typeof obj["id"] !== "string"
      ) {
        return null;
      }
      if (!Number.isInteger(obj["voteScore"])) return null;
      const d = new Date(obj["createdAt"] as string);
      if (isNaN(d.getTime())) return null;
      if (!/^[0-9a-fA-F-]{36}$/.test(obj["id"] as string)) return null;
      return {
        order: "top",
        voteScore: obj["voteScore"] as number,
        createdAt: obj["createdAt"] as string,
        id: obj["id"] as string,
      };
    }

    return null;
  } catch {
    return null;
  }
}
