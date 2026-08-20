import assert from "node:assert/strict";
import test from "node:test";
import {
  citationIdsInContext,
  createCitationStreamFilter,
} from "./source-citations";

test("extracts only well-formed citation IDs from source context", () => {
  assert.deepEqual(
    [...citationIdsInContext("[source:known_1] [source:bad id] [source:known-2]")],
    ["known_1", "known-2"],
  );
});

test("keeps allowed citations and strips unknown citations across chunks", () => {
  const filter = createCitationStreamFilter(["known"]);
  const output = [
    filter.push("Supported [sou"),
    filter.push("rce:known]. Unsupported [source:un"),
    filter.push("known]."),
    filter.flush(),
  ].join("");

  assert.equal(output, "Supported [source:known]. Unsupported .");
});

test("does not discard ordinary text that resembles an incomplete citation", () => {
  const filter = createCitationStreamFilter([]);
  const output = [filter.push("Use [source"), filter.flush()].join("");

  assert.equal(output, "Use [source");
});