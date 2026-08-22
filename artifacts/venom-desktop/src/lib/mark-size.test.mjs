import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { markSizeClasses } from "./mark-size.ts";

const require = createRequire(import.meta.url);
const { twMerge } = require("tailwind-merge");

// The contract: every caller must render exactly what the old
// tailwind-merge-based cn("h-8 w-8", className) produced.
const legacyCn = (className) =>
  twMerge(["h-8 w-8", className].filter(Boolean).join(" "));

const cases = [
  undefined,
  "text-white",
  "hidden",
  // real call sites
  "h-10 w-10 animate-pulse motion-reduce:animate-none", // route fallback
  "h-5 w-5 text-white", // landing nav
  // representative overrides
  "h-6",
  "w-12",
  "size-6",
  "h-[42px] w-[42px]",
  // non-conflicting lookalikes must keep the defaults, as twMerge did
  "max-h-4",
  "md:h-28",
  // whitespace noise
  "  h-5   w-5  ",
];

test("markSizeClasses matches the old tailwind-merge cn() for realistic callers", () => {
  for (const c of cases) {
    assert.equal(markSizeClasses(c), legacyCn(c), `input: ${JSON.stringify(c)}`);
  }
});

test("defaults apply only on the unsized axis", () => {
  assert.equal(markSizeClasses(), "h-8 w-8");
  assert.equal(markSizeClasses("h-6"), "w-8 h-6");
  assert.equal(markSizeClasses("w-12"), "h-8 w-12");
  assert.equal(markSizeClasses("size-6"), "size-6");
});
