'use strict';
/**
 * Pixel size of an uploaded PNG / JPEG / WebP / GIF from its header bytes (no image library needed).
 * Used to give every managed <img> explicit width/height, so the page does not jump while images load.
 */
const fs = require('node:fs');

function sizeFromBuffer(b) {
  if (!Buffer.isBuffer(b) || b.length < 24) return null;
  // PNG: IHDR right after the 8-byte signature.
  if (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return ok(b.readUInt32BE(16), b.readUInt32BE(20));
  // GIF: logical screen size, little endian.
  if (b.toString('ascii', 0, 3) === 'GIF') return ok(b.readUInt16LE(6), b.readUInt16LE(8));
  // WebP: VP8 (lossy), VP8L (lossless) or VP8X (extended).
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8 ' && b.length >= 30) return ok(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
    if (chunk === 'VP8L' && b.length >= 25) {
      const bits = b.readUInt32LE(21);
      return ok((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    }
    if (chunk === 'VP8X' && b.length >= 30) return ok(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
    return null;
  }
  // JPEG: walk the markers until a start-of-frame.
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return ok(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5));
      i += 2 + len;
    }
  }
  return null;
}

function ok(width, height) {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width < 50000 && height < 50000 ? { width, height } : null;
}

/** Reads at most the first 256 KB (JPEG headers with large EXIF blocks come before the frame). */
async function imageSize(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(256 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return sizeFromBuffer(buf.subarray(0, bytesRead));
  } finally { await fh.close(); }
}

module.exports = { imageSize, sizeFromBuffer };
