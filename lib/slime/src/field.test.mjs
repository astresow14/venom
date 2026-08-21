import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_BLOBS,
  MAX_DROPS,
  MAX_LINKS,
  SLIME_CAPACITY_TIERS,
  SOFTWARE_SLIME_CAPACITY,
  capacityForBudget,
  isSoftwareGlRenderer,
  createEmptyField,
  packSlimeField,
  slimeUniformVectorsFor,
} from "./field.ts";

function node(id, overrides = {}) {
  return { id, x: 100, y: 100, depth: 0, radius: 20, ...overrides };
}

test("packs nodes into blob slots and scales them into device pixels", () => {
  const field = packSlimeField(
    [node("a", { x: 10, y: 20, depth: 30, radius: 40 })],
    [],
    2,
  );

  assert.equal(field.blobCount, 1);
  assert.deepEqual([...field.blobs.slice(0, 4)], [20, 40, 60, 80]);
  assert.equal(field.linkCount, 0);
});

test("keeps the largest nodes when a map exceeds the shader's blob slots", () => {
  const nodes = Array.from({ length: MAX_BLOBS + 6 }, (_, index) =>
    node(`n${index}`, { radius: index + 1 }),
  );

  const field = packSlimeField(nodes, []);

  assert.equal(field.blobCount, MAX_BLOBS);
  // Sorted by radius descending, so the smallest six are the ones dropped.
  assert.equal(field.blobs[3], nodes.length);
});

test("drops edges whose endpoints did not survive the blob budget", () => {
  const nodes = Array.from({ length: MAX_BLOBS + 1 }, (_, index) =>
    node(`n${index}`, { radius: index + 1 }),
  );
  const evicted = "n0";

  const field = packSlimeField(nodes, [
    { sourceId: evicted, targetId: "n5" },
    { sourceId: "n5", targetId: "n6" },
  ]);

  assert.equal(field.linkCount, 1);
});

test("ignores self-links and caps the number of strands", () => {
  const nodes = Array.from({ length: MAX_BLOBS }, (_, index) =>
    node(`n${index}`, { radius: index + 1 }),
  );

  const edges = [{ sourceId: "n1", targetId: "n1" }];
  for (let from = 0; from < MAX_BLOBS; from += 1) {
    for (let to = from + 1; to < MAX_BLOBS; to += 1) {
      edges.push({ sourceId: `n${from}`, targetId: `n${to}` });
    }
  }

  const field = packSlimeField(nodes, edges);

  assert.equal(field.linkCount, MAX_LINKS);
});

test("skips nodes with non-finite geometry instead of poisoning the field", () => {
  const field = packSlimeField(
    [
      node("good"),
      node("bad", { x: Number.NaN }),
      node("zero", { radius: 0 }),
    ],
    [{ sourceId: "good", targetId: "bad" }],
  );

  assert.equal(field.blobCount, 1);
  assert.equal(field.linkCount, 0);
  assert.ok(field.blobs.every((value) => Number.isFinite(value)));
});

test("reuses the caller's buffers so animation frames do not allocate", () => {
  const target = createEmptyField();
  const first = packSlimeField([node("a")], [], 1, target);
  const second = packSlimeField([node("b"), node("c")], [], 1, target);

  assert.equal(first, target);
  assert.equal(second, target);
  assert.equal(target.blobs.length, MAX_BLOBS * 4);
});

test("strand endpoints match the blob positions they connect", () => {
  const field = packSlimeField(
    [
      node("a", { x: 10, y: 10, depth: 0, radius: 30 }),
      node("b", { x: 90, y: 40, depth: 5, radius: 20 }),
    ],
    [{ sourceId: "a", targetId: "b" }],
  );

  assert.equal(field.linkCount, 1);
  assert.deepEqual([...field.linkA.slice(0, 4)], [10, 10, 0, 30]);
  assert.deepEqual([...field.linkB.slice(0, 4)], [90, 40, 5, 20]);
});

test("drops nodes whose radius is not a finite number", () => {
  const field = packSlimeField(
    [
      node("infinite", { radius: Number.POSITIVE_INFINITY }),
      node("nan", { radius: Number.NaN }),
      node("real", { radius: 12 }),
    ],
    [],
  );

  assert.equal(field.blobCount, 1);
  assert.equal(field.blobs[3], 12);
});

test("treats a broken scale as an empty frame instead of writing infinities", () => {
  for (const scale of [Number.POSITIVE_INFINITY, Number.NaN, 0, -2]) {
    const field = packSlimeField(
      [node("a"), node("b")],
      [{ sourceId: "a", targetId: "b" }],
      scale,
    );

    assert.equal(field.blobCount, 0, `scale ${scale} should pack no blobs`);
    assert.equal(field.linkCount, 0, `scale ${scale} should pack no links`);
  }
});

test("packs droplets with the same scaling as blobs", () => {
  const field = packSlimeField(
    [node("a")],
    [],
    2,
    createEmptyField(),
    [{ x: 5, y: 6, depth: 7, radius: 8 }],
  );

  assert.equal(field.dropCount, 1);
  assert.deepEqual([...field.drops.slice(0, 4)], [10, 12, 14, 16]);
});

test("caps droplets at the field capacity and skips broken ones", () => {
  const droplets = Array.from({ length: MAX_DROPS + 10 }, (_, index) => ({
    x: index,
    y: index,
    depth: 0,
    radius: 3,
  }));
  droplets[0] = { x: Number.NaN, y: 0, depth: 0, radius: 3 };
  droplets[1] = { x: 0, y: 0, depth: 0, radius: 0 };

  const field = packSlimeField([node("a")], [], 1, createEmptyField(), droplets);

  assert.equal(field.dropCount, MAX_DROPS);
  // The two broken droplets were skipped, so packing starts at index 2.
  assert.equal(field.drops[0], 2);
});

test("a broken scale clears droplets too", () => {
  const field = createEmptyField();
  packSlimeField([node("a")], [], 1, field, [
    { x: 1, y: 1, depth: 0, radius: 2 },
  ]);
  assert.equal(field.dropCount, 1);

  packSlimeField([node("a")], [], Number.NaN, field, [
    { x: 1, y: 1, depth: 0, radius: 2 },
  ]);
  assert.equal(field.dropCount, 0);
});

test("smaller capacity tiers allocate and cap smaller fields", () => {
  const tier = SLIME_CAPACITY_TIERS[SLIME_CAPACITY_TIERS.length - 1];
  const field = createEmptyField(tier);

  assert.equal(field.blobs.length, tier.blobs * 4);
  assert.equal(field.drops.length, tier.drops * 4);

  const nodes = Array.from({ length: tier.blobs + 5 }, (_, index) =>
    node(`n${index}`, { radius: index + 1 }),
  );
  const packed = packSlimeField(nodes, [], 1, field);
  assert.equal(packed.blobCount, tier.blobs);
});

test("capacityForBudget picks the richest tier that fits", () => {
  const [full, medium, compact] = SLIME_CAPACITY_TIERS;

  assert.equal(capacityForBudget(1024), full);
  assert.equal(capacityForBudget(slimeUniformVectorsFor(full)), full);
  assert.equal(capacityForBudget(slimeUniformVectorsFor(full) - 1), medium);
  assert.equal(capacityForBudget(slimeUniformVectorsFor(medium)), medium);
  assert.equal(capacityForBudget(slimeUniformVectorsFor(compact)), compact);
  // Below the smallest tier the caller must fall back to the plain map.
  assert.equal(capacityForBudget(slimeUniformVectorsFor(compact) - 1), null);
  // An unreadable budget gets the full tier; the compile itself decides.
  assert.equal(capacityForBudget(Number.NaN), full);
});

test("software rasterizers are recognised by their renderer labels", () => {
  const software = [
    "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
    "Google SwiftShader",
    "llvmpipe (LLVM 15.0.7, 256 bits)",
    "softpipe",
    "Software Rasterizer",
    "Microsoft Basic Render Driver",
  ];
  for (const label of software) {
    assert.equal(isSoftwareGlRenderer(label), true, label);
  }

  const hardware = [
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)",
    "Adreno (TM) 650",
    "Mali-G78",
    "Apple GPU",
    "",
  ];
  for (const label of hardware) {
    assert.equal(isSoftwareGlRenderer(label), false, label);
  }
});

test("the software tier fits any budget that clears the compact tier", () => {
  const vectors = slimeUniformVectorsFor(SOFTWARE_SLIME_CAPACITY);
  const compact = SLIME_CAPACITY_TIERS[SLIME_CAPACITY_TIERS.length - 1];
  assert.ok(vectors <= slimeUniformVectorsFor(compact));
  assert.equal(SOFTWARE_SLIME_CAPACITY.drops, 0);
  // Room for every core of a healthy small map, satellites shed first.
  assert.ok(SOFTWARE_SLIME_CAPACITY.blobs >= 8);
});

test("every capacity tier respects the descending order contract", () => {
  for (let i = 1; i < SLIME_CAPACITY_TIERS.length; i += 1) {
    assert.ok(
      slimeUniformVectorsFor(SLIME_CAPACITY_TIERS[i]) <
        slimeUniformVectorsFor(SLIME_CAPACITY_TIERS[i - 1]),
    );
  }
});

test("a broken scale clears a field that previously held geometry", () => {
  const field = createEmptyField();
  packSlimeField([node("a"), node("b")], [{ sourceId: "a", targetId: "b" }], 1, field);
  assert.equal(field.blobCount, 2);
  assert.equal(field.linkCount, 1);

  packSlimeField([node("a")], [], Number.NaN, field);
  assert.equal(field.blobCount, 0);
  assert.equal(field.linkCount, 0);
});
