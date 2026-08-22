"use strict";

const fs = require("node:fs");

const supportedTypes = [
  "bmp",
  "gif",
  "jpg",
  "jpeg",
  "ktx",
  "png",
  "psd",
  "svg",
  "tiff",
  "webp",
];

function requireBytes(input, offset, length) {
  if (offset < 0 || length < 0 || offset + length > input.length) {
    throw new TypeError("Invalid or truncated image data");
  }
}

function readUInt16BE(input, offset) {
  requireBytes(input, offset, 2);
  return input.readUInt16BE(offset);
}

function readUInt16LE(input, offset) {
  requireBytes(input, offset, 2);
  return input.readUInt16LE(offset);
}

function readUInt32BE(input, offset) {
  requireBytes(input, offset, 4);
  return input.readUInt32BE(offset);
}

function readUInt32LE(input, offset) {
  requireBytes(input, offset, 4);
  return input.readUInt32LE(offset);
}

function readUInt24LE(input, offset) {
  requireBytes(input, offset, 3);
  return input[offset] | (input[offset + 1] << 8) | (input[offset + 2] << 16);
}

function dimensions(width, height, type) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new TypeError("Invalid image dimensions");
  }
  return { width, height, type };
}

function readPng(input) {
  requireBytes(input, 0, 24);
  return dimensions(readUInt32BE(input, 16), readUInt32BE(input, 20), "png");
}

function readGif(input) {
  requireBytes(input, 0, 10);
  return dimensions(readUInt16LE(input, 6), readUInt16LE(input, 8), "gif");
}

function readBmp(input) {
  requireBytes(input, 0, 26);
  return dimensions(readUInt32LE(input, 18), Math.abs(input.readInt32LE(22)), "bmp");
}

function readPsd(input) {
  requireBytes(input, 0, 22);
  return dimensions(readUInt32BE(input, 18), readUInt32BE(input, 14), "psd");
}

function readKtx(input) {
  requireBytes(input, 0, 44);
  return dimensions(readUInt32LE(input, 36), readUInt32LE(input, 40), "ktx");
}

function readJpeg(input) {
  let offset = 2;
  while (offset + 1 < input.length) {
    if (input[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < input.length && input[offset] === 0xff) offset += 1;
    if (offset >= input.length) break;

    const marker = input[offset++];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    const segmentLength = readUInt16BE(input, offset);
    if (segmentLength < 2 || offset + segmentLength > input.length) {
      throw new TypeError("Invalid JPEG segment");
    }

    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isStartOfFrame) {
      requireBytes(input, offset, 7);
      return dimensions(readUInt16BE(input, offset + 5), readUInt16BE(input, offset + 3), "jpg");
    }
    offset += segmentLength;
  }
  throw new TypeError("Invalid JPEG image");
}

function readWebp(input) {
  requireBytes(input, 0, 20);
  const chunk = input.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    requireBytes(input, 0, 30);
    return dimensions(readUInt24LE(input, 24) + 1, readUInt24LE(input, 27) + 1, "webp");
  }
  if (chunk === "VP8 ") {
    requireBytes(input, 20, 10);
    if (input.toString("hex", 23, 26) !== "9d012a") throw new TypeError("Invalid WebP image");
    return dimensions(readUInt16LE(input, 26) & 0x3fff, readUInt16LE(input, 28) & 0x3fff, "webp");
  }
  if (chunk === "VP8L") {
    requireBytes(input, 20, 5);
    if (input[20] !== 0x2f) throw new TypeError("Invalid WebP image");
    const width = 1 + (((input[22] & 0x3f) << 8) | input[21]);
    const height = 1 + (((input[24] & 0x0f) << 10) | (input[23] << 2) | ((input[22] & 0xc0) >> 6));
    return dimensions(width, height, "webp");
  }
  throw new TypeError("Unsupported WebP encoding");
}

function readSvg(input) {
  const openingTag = input.toString("utf8", 0, Math.min(input.length, 128 * 1024)).match(/<svg\b[^>]*>/i);
  if (!openingTag) throw new TypeError("Invalid SVG image");
  const tag = openingTag[0];
  const value = (name) => {
    const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']\\s*([0-9]+(?:\\.[0-9]+)?)`, "i"));
    return match ? Number(match[1]) : undefined;
  };
  const width = value("width");
  const height = value("height");
  if (width && height) return dimensions(width, height, "svg");

  const viewBox = tag.match(/\bviewBox\s*=\s*["']\s*[-+0-9.eE]+\s+[-+0-9.eE]+\s+([0-9.]+)\s+([0-9.]+)/i);
  if (!viewBox) throw new TypeError("SVG must define dimensions or a viewBox");
  return dimensions(Number(viewBox[1]), Number(viewBox[2]), "svg");
}

function readTiff(input) {
  requireBytes(input, 0, 8);
  const littleEndian = input.toString("ascii", 0, 2) === "II";
  if (!littleEndian && input.toString("ascii", 0, 2) !== "MM") throw new TypeError("Invalid TIFF image");
  const read16 = littleEndian ? readUInt16LE : readUInt16BE;
  const read32 = littleEndian ? readUInt32LE : readUInt32BE;
  if (read16(input, 2) !== 42) throw new TypeError("Invalid TIFF image");

  const ifdOffset = read32(input, 4);
  const entries = read16(input, ifdOffset);
  requireBytes(input, ifdOffset + 2, entries * 12);
  let width;
  let height;
  for (let index = 0; index < entries; index += 1) {
    const offset = ifdOffset + 2 + index * 12;
    const tag = read16(input, offset);
    if (tag !== 256 && tag !== 257) continue;
    const valueType = read16(input, offset + 2);
    const count = read32(input, offset + 4);
    if (count !== 1 || (valueType !== 3 && valueType !== 4)) continue;
    const value = valueType === 3 ? read16(input, offset + 8) : read32(input, offset + 8);
    if (tag === 256) width = value;
    if (tag === 257) height = value;
  }
  return dimensions(width, height, "tiff");
}

function imageSize(source) {
  const input = typeof source === "string" ? fs.readFileSync(source) : Buffer.from(source);
  if (!input.length) throw new TypeError("Empty image data");
  if (input.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return readPng(input);
  if (input.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return readJpeg(input);
  if (input.subarray(0, 3).toString("ascii") === "GIF") return readGif(input);
  if (input.subarray(0, 2).toString("ascii") === "BM") return readBmp(input);
  if (input.subarray(0, 4).toString("ascii") === "8BPS") return readPsd(input);
  if (input.subarray(0, 4).toString("ascii") === "RIFF" && input.subarray(8, 12).toString("ascii") === "WEBP") return readWebp(input);
  if (input.subarray(0, 12).equals(Buffer.from("ab4b5458203131bb0d0a1a0a", "hex"))) return readKtx(input);
  if (input.subarray(0, 2).toString("ascii") === "II" || input.subarray(0, 2).toString("ascii") === "MM") return readTiff(input);
  if (input.subarray(0, 512).toString("utf8").includes("<svg")) return readSvg(input);
  throw new TypeError("Unsupported image type");
}

module.exports = imageSize;
module.exports.default = imageSize;
module.exports.imageSize = imageSize;
module.exports.types = supportedTypes;