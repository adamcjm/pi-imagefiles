/**
 * Lightweight image dimension parsing for the formats DeepSeek accepts
 * (PNG, JPEG, WebP, GIF). Returns undefined when the header cannot be read;
 * callers then omit dimensions from the image handle text.
 */

export interface ImageSize {
  width: number;
  height: number;
}

export function parseImageSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 8) return undefined;
  // PNG: 8-byte signature, IHDR at offset 16
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    if (bytes.length < 24) return undefined;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  // GIF: "GIF87a"/"GIF89a"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  }
  // JPEG: scan for SOF markers
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return parseJpegSize(bytes);
  }
  // WebP: RIFF....WEBP
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return parseWebpSize(bytes);
  }
  return undefined;
}

function parseJpegSize(bytes: Uint8Array): ImageSize | undefined {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    // SOF0..SOF15 excluding DHT(0xC4), JPG(0xC8), DAC(0xCC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = dv.getUint16(offset + 5);
      const width = dv.getUint16(offset + 7);
      if (width > 0 && height > 0) return { width, height };
      return undefined;
    }
    const segmentLength = dv.getUint16(offset + 2);
    if (segmentLength < 2) return undefined;
    offset += 2 + segmentLength;
  }
  return undefined;
}

function parseWebpSize(bytes: Uint8Array): ImageSize | undefined {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (chunk === "VP8X") {
    // 24-bit little-endian dims, minus one
    return {
      width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
      height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
    };
  }
  if (chunk === "VP8 ") {
    // lossy: 14-bit dims in frame header
    if (bytes.length < 30) return undefined;
    const width = dv.getUint16(26, true) & 0x3fff;
    const height = dv.getUint16(28, true) & 0x3fff;
    return { width, height };
  }
  if (chunk === "VP8L") {
    // lossless: 14-bit packed after signature byte
    if (bytes.length < 25) return undefined;
    const b = bytes.subarray(21, 25);
    const bits = b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return undefined;
}
