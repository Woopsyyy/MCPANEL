'use strict';

/**
 * Builds the MCPANEL tray mascot — a Minecraft grass block — into the icon
 * files the tray loads:
 *
 *   assets/logo.png   real 256x256 PNG  (Linux / macOS tray)
 *   assets/logo.ico   valid multi-frame ICO at 16/32/48  (Windows / WSL tray)
 *
 * Zero external dependencies: the artwork is drawn procedurally on a 16x16
 * base grid and nearest-neighbour scaled to each target size (16/32/48/256 are
 * all integer multiples of 16, so the pixels stay crisp and "blocky"). PNG is
 * encoded with Node's built-in zlib; the ICO stores each frame as an
 * uncompressed 32-bit BGRA BMP (DIB) + AND mask, which every Windows version
 * can decode — avoiding the previous bug where a JPEG was mislabelled as a
 * 256x256 ICO frame and rendered as a blank tray slot.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const assetsDir = path.join(__dirname, '..', 'assets');
const pngPath = path.join(assetsDir, 'logo.png');
const icoPath = path.join(assetsDir, 'logo.ico');

// --- Artwork ---------------------------------------------------------------
// 16x16 grass block. Top band = grass (green), body = dirt (brown), bottom
// row = a darker shadow base. A few columns of grass "drip" into the dirt to
// give the iconic overhang. Single-character codes index the palette below.
const PALETTE = {
  L: [108, 174, 70],  // grass, lit
  D: [86, 142, 52],   // grass, shaded speckle
  b: [150, 108, 74],  // dirt, base
  d: [124, 88, 60],   // dirt, dark speckle
  k: [104, 74, 50],   // dirt, darkest
};

const GRID = [
  'LLLLLLLLLLLLLLLL',
  'LLDLLLLDLLLDLLLL',
  'LDLLLLDLLLLLDLLL',
  'LLLDLLLLLDLLLLDL',
  'DLLLLDLLLLLDLLLD',
  'bLbbbLbbbbLbbbLb',
  'bbbbbbbLbbbbbbbb',
  'bdbbkbbbbbdbbkbb',
  'bbbbbbdbbbbbbbbk',
  'kbbdbbbbbkbbdbbb',
  'bbbbbbkbbbbbbbbb',
  'bbdbbbbbbbdbbkbb',
  'bbbbkbbdbbbbbbbb',
  'dbbbbbbbbbbkbbbd',
  'bbbkbbbbdbbbbbbb',
  'kkkkkkkkkkkkkkkk',
];

const BASE = GRID.length; // 16

/**
 * Renders the artwork at `size` (must be a multiple of BASE) into a flat RGBA
 * pixel buffer (4 bytes per pixel, row-major, top-down).
 */
function renderRGBA(size) {
  if (size % BASE !== 0) throw new Error(`size ${size} is not a multiple of ${BASE}`);
  const scale = size / BASE;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const row = GRID[Math.floor(y / scale)];
    for (let x = 0; x < size; x++) {
      const [r, g, b] = PALETTE[row[Math.floor(x / scale)]];
      const i = (y * size + x) * 4;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = 255; // fully opaque block
    }
  }
  return out;
}

// --- PNG encoding ----------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(rgba, size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  // 10,11,12 = compression/filter/interlace = 0

  // Prepend a 0 (filter: none) byte to each scanline.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- ICO encoding ----------------------------------------------------------
/** Builds one ICO frame: BITMAPINFOHEADER + bottom-up BGRA + (zeroed) AND mask. */
function icoFrame(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);          // biSize
  header.writeInt32LE(size, 4);         // biWidth
  header.writeInt32LE(size * 2, 8);     // biHeight = XOR + AND mask
  header.writeUInt16LE(1, 12);          // biPlanes
  header.writeUInt16LE(32, 14);         // biBitCount
  // biCompression (BI_RGB=0) and the rest stay zero.

  // XOR data: bottom-up rows, BGRA per pixel.
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4;
    const dstRow = y * size * 4;
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      xor[d] = rgba[s + 2];     // B
      xor[d + 1] = rgba[s + 1]; // G
      xor[d + 2] = rgba[s];     // R
      xor[d + 3] = rgba[s + 3]; // A
    }
  }

  // AND mask: 1 bpp, rows padded to 4 bytes. All zero = use the alpha channel.
  const maskStride = (((size + 31) >> 5) << 2);
  const mask = Buffer.alloc(maskStride * size); // already zero-filled

  return Buffer.concat([header, xor, mask]);
}

function encodeICO(frames) {
  const count = frames.length;
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(count, 4);

  const entries = [];
  const images = [];
  let offset = 6 + 16 * count;

  for (const { size, data } of frames) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // width  (0 means 256)
    e[1] = size >= 256 ? 0 : size; // height
    e[2] = 0;                      // colour count
    e[3] = 0;                      // reserved
    e.writeUInt16LE(1, 4);         // planes
    e.writeUInt16LE(32, 6);        // bit count
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    images.push(data);
    offset += data.length;
  }

  return Buffer.concat([dir, ...entries, ...images]);
}

// --- Build -----------------------------------------------------------------
fs.mkdirSync(assetsDir, { recursive: true });

// PNG: single 256x256 for the Linux/macOS tray.
fs.writeFileSync(pngPath, encodePNG(renderRGBA(256), 256));
console.log(`Wrote ${path.relative(process.cwd(), pngPath)} (256x256 PNG)`);

// ICO: the sizes the Windows tray actually requests.
const icoSizes = [16, 32, 48];
const icoFrames = icoSizes.map((size) => ({ size, data: icoFrame(renderRGBA(size), size) }));
fs.writeFileSync(icoPath, encodeICO(icoFrames));
console.log(`Wrote ${path.relative(process.cwd(), icoPath)} (ICO ${icoSizes.join('/')})`);
