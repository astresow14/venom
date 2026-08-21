import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSlimeFragmentShader,
  SLIME_VERTEX_SHADER,
} from "./shader.ts";
import {
  FULL_SLIME_CAPACITY,
  SOFTWARE_SLIME_CAPACITY,
  slimeCapacityForTierName,
} from "./field.ts";

const TIERS = {
  full: FULL_SLIME_CAPACITY,
  medium: slimeCapacityForTierName("medium"),
  compact: slimeCapacityForTierName("compact"),
  software: SOFTWARE_SLIME_CAPACITY,
};

test("no tier emits a zero-sized uniform array or a zero-trip loop", () => {
  for (const [name, capacity] of Object.entries(TIERS)) {
    const source = buildSlimeFragmentShader(capacity);
    // GLSL ES 1.00 rejects `type name[0]` at compile time; a tier that emits
    // one loses its goo silently because hosts catch the failure and fall
    // back to the plain map.
    assert.doesNotMatch(
      source,
      /\[\s*0\s*\]/,
      `${name} tier declared a zero-sized array`,
    );
    assert.doesNotMatch(
      source,
      /<\s*0\s*;/,
      `${name} tier emitted a zero-trip loop`,
    );
  }
});

test("the software tier omits the droplet pass entirely", () => {
  const source = buildSlimeFragmentShader(SOFTWARE_SLIME_CAPACITY);
  assert.ok(!source.includes("uDrops"), "expected no droplet uniform");
  assert.ok(!source.includes("uDropCount"), "expected no droplet count");
  assert.ok(
    source.includes(`uBlobs[${SOFTWARE_SLIME_CAPACITY.blobs}]`),
    "expected the blob array to survive",
  );
  assert.ok(
    source.includes(`uLinkA[${SOFTWARE_SLIME_CAPACITY.links}]`),
    "expected the link arrays to survive",
  );
});

test("droplet-bearing tiers keep the bead pass sized to their capacity", () => {
  for (const name of ["full", "medium", "compact"]) {
    const capacity = TIERS[name];
    const source = buildSlimeFragmentShader(capacity);
    assert.ok(
      source.includes(`uniform vec4 uDrops[${capacity.drops}];`),
      `${name} tier should declare uDrops[${capacity.drops}]`,
    );
    assert.ok(
      source.includes(`i < ${capacity.drops};`),
      `${name} tier should loop over its droplet capacity`,
    );
  }
});

test("a capacity without blobs or links is rejected loudly", () => {
  assert.throws(() => buildSlimeFragmentShader({ blobs: 0, links: 4, drops: 4 }));
  assert.throws(() => buildSlimeFragmentShader({ blobs: 4, links: 0, drops: 4 }));
});

test("vertex shader stays a plain fullscreen pass", () => {
  assert.ok(SLIME_VERTEX_SHADER.includes("gl_Position"));
});
