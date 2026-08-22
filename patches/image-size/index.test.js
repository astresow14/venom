"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const imageSize = require("./index.js");

const onePixelPng = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000049454e44ae426082",
  "hex",
);

test("keeps Metro's buffer and file-path contracts", () => {
  assert.deepEqual(imageSize(onePixelPng), { width: 1, height: 1, type: "png" });

  const file = path.join(os.tmpdir(), `image-size-${process.pid}.png`);
  fs.writeFileSync(file, onePixelPng);
  try {
    assert.deepEqual(imageSize(file), { width: 1, height: 1, type: "png" });
  } finally {
    fs.rmSync(file);
  }
});

test("rejects the zero-length ISO-BMFF shape without parsing it", () => {
  const malformedHeif = Buffer.from("000000006674797068656963", "hex");
  assert.throws(() => imageSize(malformedHeif), /Unsupported image type/);
});