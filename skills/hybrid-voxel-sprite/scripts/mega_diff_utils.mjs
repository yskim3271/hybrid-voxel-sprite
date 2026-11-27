#!/usr/bin/env node
// mega_diff_utils.mjs — hybrid-voxel-sprite v2.3 · Stage 4 (G5-v2.2 multi-cue + G5-v2.3 hull-only) concept-vs-render diff utilities.
//
// Pure Node ES module, ZERO npm dependencies (node:zlib / node:fs only). Node >= 18.
//
//   * Minimal PNG codec: decodePNG / encodePNG (colour types 0, 2, 3, 4, 6; bit depths 1–16 on decode; all five
//     scanline filters; Adam7 interlace on decode AND encode; CRC-checked chunks; tRNS transparency).
//   * Silhouette masks: toMask (alpha | luma | background-key | auto), maskBBox, registerMask (bbox-normalised,
//     aspect-preserving registration so framing differences do not count but proportion drift does).
//   * computeSilhouetteIoU(ref, render, opts) → { iou, precision, recall, diff image, … }
//   * composeComparisonSheet(pairs, outPng, opts) → [Concept / Callout | 3D Voxel Render | Silhouette IoU] rows with a
//     built-in 3×5 bitmap font for labels and PASS / FAIL borders.
//   * v2.2 multi-cue G5: computeEdgeG5 (internal Sobel/NMS edges → dilated edge F1 + chamfer distance), computeBandG5
//     (accent-colour share + centroid per configurable HSV band; DEFAULT_ACCENT_BANDS = amber + cyan),
//     computeMultiCueG5 / multiCueSummary / composeMultiCueSheet.
//   * v2.3 G5 hull-only: computeHullSilhouetteIoU — core-hull silhouette IoU (target 0.86) for organic / tentacled ships,
//     from explicit hull-only masks (concept with appendages painted out + render with the `wave` part excluded) or by
//     automatic morphological opening + largest-component isolation; re-registered on the HULL bbox so curling appendages
//     can neither help nor hurt the core hull's dome / jaw proportions.
//
// CLI:
//   node mega_diff_utils.mjs iou   --ref concept.png --render render.png [--target 0.78] [--register bbox|bbox-stretch|none]
//                                  [--size 256] [--channel auto|alpha|luma|key] [--threshold 128] [--invert] [--diff out.png]
//   node mega_diff_utils.mjs sheet --pairs pairs.json --out sheet.png [--title "CARRIER PASS 2"]
//          pairs.json = [{ "label": "HERO 3/4", "ref": "a.png", "render": "b.png", "target": 0.78 }, …]
//          (relative paths resolve against the pairs.json directory)
//   node mega_diff_utils.mjs mask  --input concept.png --out mask.png [--channel key] [--register bbox --size 256]
//   node mega_diff_utils.mjs multicue --ref concept.png --render render.png [--kind hero|ortho] [--out sheet.png]
//                                  [--bands name:minH-maxH[:minS[:minV[:#rrggbb]]],…]   (e.g. crimson:340-20:0.45:0.30,gold:35-58)
//   node mega_diff_utils.mjs hull  --ref concept.png --render render.png [--ref-hull hull_mask.png] [--render-hull hull_render.png]
//                                  [--open 3] [--target 0.86] [--diff out.png]
// Exit code 1 on errors or when an IoU is below its --target / pair target.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const DIFF_UTILS_VERSION = '2.3.0';

// =============================================================================================== shared CLI helpers
/** true when the module at metaUrl is the process entry point (robust to Windows drive-letter casing). */
export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  const a = path.resolve(fileURLToPath(metaUrl)), b = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** tiny argv parser: `cmd --key value --flag` → { _: [cmd, …], key: 'value', flag: true } */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const eq = k.indexOf('=');
      if (eq >= 0) { out[k.slice(0, eq)] = k.slice(eq + 1); continue; }
      const nxt = argv[i + 1];
      if (nxt !== undefined && !nxt.startsWith('--')) { out[k] = nxt; i++; } else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

// =============================================================================================== PNG codec
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const VALID_DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];   // x0 y0 dx dy

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
function unfilterRow(ft, cur, prev, bpp) {
  const n = cur.length;
  switch (ft) {
    case 0: return;
    case 1: for (let i = bpp; i < n; i++) cur[i] = (cur[i] + cur[i - bpp]) & 255; return;
    case 2: for (let i = 0; i < n; i++) cur[i] = (cur[i] + prev[i]) & 255; return;
    case 3: for (let i = 0; i < n; i++) cur[i] = (cur[i] + (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1)) & 255; return;
    case 4: for (let i = 0; i < n; i++) cur[i] = (cur[i] + paeth(i >= bpp ? cur[i - bpp] : 0, prev[i], i >= bpp ? prev[i - bpp] : 0)) & 255; return;
    default: throw new Error(`decodePNG: bad filter type ${ft}`);
  }
}

/** Decode a PNG Buffer → { width, height, channels: 4, data: Uint8Array RGBA8 }. */
export function decodePNG(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('decodePNG: not a PNG (bad signature)');
  let pos = 8, ihdr = null, plte = null, trns = null;
  const idat = [];
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (pos + 12 + len > buf.length) throw new Error(`decodePNG: truncated ${type} chunk`);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (crc32(buf.subarray(pos + 4, pos + 8 + len)) !== buf.readUInt32BE(pos + 8 + len)) throw new Error(`decodePNG: CRC mismatch in ${type}`);
    pos += 12 + len;
    if (type === 'IHDR') ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9], interlace: data[12] };
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (!ihdr) throw new Error('decodePNG: missing IHDR');
  const { width: w, height: h, bitDepth: bd, colorType: ct, interlace } = ihdr;
  if (!CHANNELS[ct] || !VALID_DEPTHS[ct].includes(bd)) throw new Error(`decodePNG: unsupported colour type ${ct} / bit depth ${bd}`);
  if (ct === 3 && !plte) throw new Error('decodePNG: palette image without PLTE');
  if (!idat.length) throw new Error('decodePNG: no IDAT');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = CHANNELS[ct], bitsPP = ch * bd, bpp = Math.max(1, bitsPP >> 3);
  const maxV = (1 << bd) - 1;
  const out = new Uint8Array(w * h * 4);
  const sample = (row, i) => {
    if (bd === 8) return row[i];
    if (bd === 16) return (row[i * 2] << 8) | row[i * 2 + 1];
    const bit = i * bd;
    return (row[bit >> 3] >> (8 - bd - (bit & 7))) & maxV;
  };
  const to8 = (v) => (bd === 16 ? v >> 8 : bd === 8 ? v : Math.round((v * 255) / maxV));
  const trnsKey = trns && (ct === 0 || ct === 2) ? (ct === 0 ? [trns.readUInt16BE(0)] : [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)]) : null;
  const passes = interlace ? ADAM7 : [[0, 0, 1, 1]];
  let off = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil((pw * bitsPP) / 8);
    let prev = new Uint8Array(rowBytes), cur = new Uint8Array(rowBytes);
    for (let y = 0; y < ph; y++) {
      if (off + 1 + rowBytes > raw.length) throw new Error('decodePNG: image data too short');
      const ft = raw[off++];
      cur.set(raw.subarray(off, off + rowBytes)); off += rowBytes;
      unfilterRow(ft, cur, prev, bpp);
      const yy = y0 + y * dy;
      for (let x = 0; x < pw; x++) {
        const o = (yy * w + x0 + x * dx) * 4;
        if (ct === 0) {
          const v = sample(cur, x), g = to8(v);
          out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = trnsKey && v === trnsKey[0] ? 0 : 255;
        } else if (ct === 2) {
          const r = sample(cur, x * 3), g = sample(cur, x * 3 + 1), b = sample(cur, x * 3 + 2);
          out[o] = to8(r); out[o + 1] = to8(g); out[o + 2] = to8(b);
          out[o + 3] = trnsKey && r === trnsKey[0] && g === trnsKey[1] && b === trnsKey[2] ? 0 : 255;
        } else if (ct === 3) {
          const p = sample(cur, x);
          if (p * 3 + 2 >= plte.length) throw new Error('decodePNG: palette index out of range');
          out[o] = plte[p * 3]; out[o + 1] = plte[p * 3 + 1]; out[o + 2] = plte[p * 3 + 2];
          out[o + 3] = trns && p < trns.length ? trns[p] : 255;
        } else if (ct === 4) {
          const g = to8(sample(cur, x * 2));
          out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = to8(sample(cur, x * 2 + 1));
        } else {
          out[o] = to8(sample(cur, x * 4)); out[o + 1] = to8(sample(cur, x * 4 + 1));
          out[o + 2] = to8(sample(cur, x * 4 + 2)); out[o + 3] = to8(sample(cur, x * 4 + 3));
        }
      }
      const t = prev; prev = cur; cur = t;
    }
  }
  return { width: w, height: h, channels: 4, data: out };
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
const FILTER_IDS = { none: 0, sub: 1, up: 2, avg: 3, average: 3, paeth: 4 };
function filterRow(ft, row, prev, bpp, out) {
  const n = row.length;
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
    const pred = ft === 0 ? 0 : ft === 1 ? a : ft === 2 ? b : ft === 3 ? (a + b) >> 1 : paeth(a, b, c);
    out[i] = (row[i] - pred) & 255;
  }
}

/**
 * Encode an RGBA8 image → PNG Buffer (8-bit). opts.colorType: 6 RGBA (default) | 2 RGB | 0 gray (R channel) |
 * 4 gray+alpha | 3 palette (≤ 256 unique RGBA colours, tRNS when needed). opts.filter: none | sub | up | avg | paeth |
 * adaptive (min sum of |signed residual|) | 0–4. opts.interlace: true → Adam7. opts.level: zlib level (default 9).
 */
export function encodePNG(img, opts = {}) {
  const { colorType = 6, filter = 'none', interlace = false, level = 9 } = opts;
  const { width: w, height: h } = img;
  const src = img.channels === 1 ? maskToImage(img).data : img.data;
  if (src.length !== w * h * 4) throw new Error('encodePNG: expected RGBA8 data (width*height*4)');
  if (!CHANNELS[colorType]) throw new Error(`encodePNG: bad colour type ${colorType}`);
  const ch = CHANNELS[colorType];
  let plte = null, trns = null, palIndex = null;
  if (colorType === 3) {
    const map = new Map(); palIndex = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const k = ((src[i * 4] << 24) | (src[i * 4 + 1] << 16) | (src[i * 4 + 2] << 8) | src[i * 4 + 3]) >>> 0;
      let p = map.get(k);
      if (p === undefined) { p = map.size; if (p > 255) throw new Error('encodePNG: > 256 colours for palette PNG'); map.set(k, p); }
      palIndex[i] = p;
    }
    plte = Buffer.alloc(map.size * 3); const alpha = Buffer.alloc(map.size);
    let anyAlpha = false;
    for (const [k, p] of map) { plte[p * 3] = k >>> 24; plte[p * 3 + 1] = (k >>> 16) & 255; plte[p * 3 + 2] = (k >>> 8) & 255; alpha[p] = k & 255; if ((k & 255) !== 255) anyAlpha = true; }
    if (anyAlpha) trns = alpha;
  }
  const pixel = (x, y, out, o) => {
    const i = y * w + x, s = i * 4;
    if (colorType === 6) { out[o] = src[s]; out[o + 1] = src[s + 1]; out[o + 2] = src[s + 2]; out[o + 3] = src[s + 3]; }
    else if (colorType === 2) { out[o] = src[s]; out[o + 1] = src[s + 1]; out[o + 2] = src[s + 2]; }
    else if (colorType === 0) out[o] = src[s];
    else if (colorType === 4) { out[o] = src[s]; out[o + 1] = src[s + 3]; }
    else out[o] = palIndex[i];
  };
  const fixed = typeof filter === 'number' ? filter : FILTER_IDS[filter];
  if (filter !== 'adaptive' && fixed === undefined) throw new Error(`encodePNG: bad filter ${filter}`);
  const parts = [];
  const passes = interlace ? ADAM7 : [[0, 0, 1, 1]];
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = pw * ch;
    let prev = new Uint8Array(rowBytes);
    const tmp = new Uint8Array(rowBytes), best = new Uint8Array(rowBytes);
    for (let y = 0; y < ph; y++) {
      const row = new Uint8Array(rowBytes);
      for (let x = 0; x < pw; x++) pixel(x0 + x * dx, y0 + y * dy, row, x * ch);
      let ft = fixed;
      if (filter === 'adaptive') {
        let bestCost = Infinity;
        for (let f = 0; f < 5; f++) {
          filterRow(f, row, prev, ch, tmp);
          let cost = 0; for (let i = 0; i < rowBytes; i++) cost += tmp[i] < 128 ? tmp[i] : 256 - tmp[i];
          if (cost < bestCost) { bestCost = cost; ft = f; best.set(tmp); }
        }
      } else filterRow(ft, row, prev, ch, best);
      parts.push(Buffer.from([ft]), Buffer.from(best));
      prev = row;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = interlace ? 1 : 0;
  const out = [PNG_SIG, chunk('IHDR', ihdr)];
  if (plte) out.push(chunk('PLTE', plte));
  if (trns) out.push(chunk('tRNS', trns));
  out.push(chunk('IDAT', zlib.deflateSync(Buffer.concat(parts), { level })), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(out);
}

export const readPNG = (file) => decodePNG(fs.readFileSync(file));
export function writePNG(file, img, opts) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, encodePNG(img, opts));
  return file;
}

// =============================================================================================== images & masks
export const createImage = (w, h, rgba = [0, 0, 0, 0]) => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { width: w, height: h, channels: 4, data };
};
export const createMask = (w, h) => ({ width: w, height: h, channels: 1, data: new Uint8Array(w * h) });
const isPngBytes = (x) => (Buffer.isBuffer(x) || x instanceof Uint8Array) && x.length >= 8 && PNG_SIG.equals(Buffer.from(x.subarray(0, 8)));

/** Accept a path, PNG bytes, an RGBA image or a 1-channel mask → RGBA image. */
export function loadImage(src) {
  if (typeof src === 'string') return readPNG(src);
  if (isPngBytes(src)) return decodePNG(src);
  if (src && src.width && src.height && src.data) {
    if (src.channels === 1 || src.data.length === src.width * src.height) return maskToImage(src);
    return src;
  }
  throw new Error('loadImage: expected a PNG path, PNG bytes, an image {width,height,data} or a mask');
}

/** 1-channel 0/1 mask → RGBA image (fg colour on transparent or bg). */
export function maskToImage(mask, { fg = [255, 255, 255, 255], bg = [0, 0, 0, 0] } = {}) {
  const img = createImage(mask.width, mask.height, bg);
  for (let i = 0; i < mask.data.length; i++) if (mask.data[i]) img.data.set(fg, i * 4);
  return img;
}

const luma = (d, o) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];

/**
 * Silhouette mask from any image source.
 *   channel 'alpha' : a >= threshold            (renders on a transparent clear colour)
 *   channel 'luma'  : luma >= threshold (invert → luma < threshold, for dark-on-white blueprints)
 *   channel 'key'   : colour distance to the background > keyTolerance (studio concept art on a flat backdrop;
 *                     background = opts.keyColor or the median of the four corner pixels)
 *   channel 'auto'  : 'alpha' when any pixel is not fully opaque, otherwise 'key'
 */
export function toMask(src, opts = {}) {
  const { channel = 'auto', threshold = 128, invert = false, keyTolerance = 48, keyColor = null } = opts;
  if (src && src.channels === 1 && src.data && src.data.length === src.width * src.height) {
    const m = createMask(src.width, src.height);
    for (let i = 0; i < m.data.length; i++) m.data[i] = src.data[i] ? 1 : 0;
    if (invert) for (let i = 0; i < m.data.length; i++) m.data[i] ^= 1;
    return m;
  }
  const img = loadImage(src);
  const { width: w, height: h, data: d } = img;
  let mode = channel;
  if (mode === 'auto') { mode = 'key'; for (let i = 3; i < d.length; i += 4) if (d[i] < 255) { mode = 'alpha'; break; } }
  const m = createMask(w, h);
  if (mode === 'alpha') for (let i = 0; i < w * h; i++) m.data[i] = d[i * 4 + 3] >= threshold ? 1 : 0;
  else if (mode === 'luma') for (let i = 0; i < w * h; i++) m.data[i] = luma(d, i * 4) >= threshold ? 1 : 0;
  else if (mode === 'key') {
    let bg = keyColor;
    if (!bg) {
      const cs = [0, w - 1, (h - 1) * w, h * w - 1].map((i) => [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]);
      bg = [0, 1, 2].map((k) => cs.map((c) => c[k]).sort((a, b) => a - b)[1]);   // lower median of 4 corners
    }
    const t2 = keyTolerance * keyTolerance;
    for (let i = 0; i < w * h; i++) {
      const o = i * 4, dr = d[o] - bg[0], dg = d[o + 1] - bg[1], db = d[o + 2] - bg[2];
      m.data[i] = d[o + 3] >= threshold && dr * dr + dg * dg + db * db > t2 ? 1 : 0;
    }
  } else throw new Error(`toMask: unknown channel ${channel}`);
  if (invert && mode !== 'key') for (let i = 0; i < m.data.length; i++) m.data[i] ^= 1;
  return m;
}

/** tight bbox of a mask: { x0, y0, x1 (excl), y1 (excl), w, h, empty } */
export function maskBBox(mask) {
  const { width: w, height: h, data } = mask;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[y * w + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return { x0: 0, y0: 0, x1: 0, y1: 0, w: 0, h: 0, empty: true };
  return { x0, y0, x1: x1 + 1, y1: y1 + 1, w: x1 + 1 - x0, h: y1 + 1 - y0, empty: false };
}
export const maskCount = (m) => { let n = 0; for (const v of m.data) if (v) n++; return n; };

/**
 * Register a mask onto a size×size canvas.
 *   'bbox'         : crop to the silhouette bbox, scale uniformly (aspect preserved) to fit size − 2·pad, centre.
 *                    → framing / zoom / offset differences vanish, proportion drift remains visible. (default)
 *   'bbox-stretch' : crop and scale X and Y independently (hides aspect drift — use only for callout crops).
 *   'none'         : scale the whole canvas to size×size (no crop).
 * Uses 3×3 supersampling with a majority vote (≥ 5/9).
 */
export function registerMask(mask, { size = 256, pad = 4, register = 'bbox' } = {}) {
  const out = createMask(size, size);
  let bb = register === 'none' ? { x0: 0, y0: 0, w: mask.width, h: mask.height, empty: false } : maskBBox(mask);
  if (bb.empty) return out;
  const inner = Math.max(1, size - 2 * pad);
  let sx, sy;
  if (register === 'bbox') sx = sy = inner / Math.max(bb.w, bb.h);
  else if (register === 'bbox-stretch' || register === 'none') { sx = (register === 'none' ? size : inner) / bb.w; sy = (register === 'none' ? size : inner) / bb.h; }
  else throw new Error(`registerMask: unknown register mode ${register}`);
  const ox = register === 'none' ? 0 : (size - bb.w * sx) / 2, oy = register === 'none' ? 0 : (size - bb.h * sy) / 2;
  const { width: mw, data: md } = mask;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let hit = 0;
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
      const u = (x + (i + 0.5) / 3 - ox) / sx, v = (y + (j + 0.5) / 3 - oy) / sy;
      if (u < 0 || v < 0 || u >= bb.w || v >= bb.h) continue;
      if (md[(bb.y0 + Math.floor(v)) * mw + bb.x0 + Math.floor(u)]) hit++;
    }
    out.data[y * size + x] = hit >= 5 ? 1 : 0;
  }
  return out;
}

export const DIFF_COLORS = { both: [70, 205, 110, 255], missing: [235, 70, 70, 255], excess: [80, 130, 245, 255], none: [16, 18, 24, 255] };

/**
 * Silhouette IoU between a reference (concept / callout / blueprint view) and a render.
 * ref / render: PNG path | PNG bytes | RGBA image | mask. opts: { register: 'bbox', size: 256, pad: 4, channel,
 * threshold, invert, keyTolerance, refOpts: {...mask opts for ref only}, renderOpts, diff: true }.
 * Returns { iou, precision, recall, intersection, union, refPixels, renderPixels, size, register, diff (RGBA:
 * green = both, red = missing in render, blue = excess in render) }.
 */
export function computeSilhouetteIoU(ref, render, opts = {}) {
  const { register = 'bbox', size = 256, pad = 4, diff = true } = opts;
  const base = { channel: opts.channel, threshold: opts.threshold, invert: opts.invert, keyTolerance: opts.keyTolerance, keyColor: opts.keyColor };
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  let a = toMask(ref, { ...base, ...(opts.refOpts || {}) });
  let b = toMask(render, { ...base, ...(opts.renderOpts || {}) });
  if (!(register === 'none' && opts.size === undefined && a.width === b.width && a.height === b.height)) {
    a = registerMask(a, { size, pad, register }); b = registerMask(b, { size, pad, register });
  }
  let inter = 0, uni = 0, na = 0, nb = 0;
  const img = diff ? createImage(a.width, a.height, DIFF_COLORS.none) : null;
  for (let i = 0; i < a.data.length; i++) {
    const x = a.data[i], y = b.data[i];
    if (x) na++; if (y) nb++;
    if (x && y) inter++;
    if (x || y) uni++;
    if (img) img.data.set(x && y ? DIFF_COLORS.both : x ? DIFF_COLORS.missing : y ? DIFF_COLORS.excess : DIFF_COLORS.none, i * 4);
  }
  return {
    iou: uni ? inter / uni : 0, precision: nb ? inter / nb : 0, recall: na ? inter / na : 0,
    intersection: inter, union: uni, refPixels: na, renderPixels: nb, empty: uni === 0,
    width: a.width, height: a.height, register, diff: img,
  };
}

// =============================================================================================== 3×5 bitmap font
const GLYPHS = {
  '0': '###|#.#|#.#|#.#|###', '1': '.#.|##.|.#.|.#.|###', '2': '###|..#|###|#..|###', '3': '###|..#|.##|..#|###',
  '4': '#.#|#.#|###|..#|..#', '5': '###|#..|###|..#|###', '6': '###|#..|###|#.#|###', '7': '###|..#|..#|.#.|.#.',
  '8': '###|#.#|###|#.#|###', '9': '###|#.#|###|..#|###',
  A: '.#.|#.#|###|#.#|#.#', B: '##.|#.#|##.|#.#|##.', C: '.##|#..|#..|#..|.##', D: '##.|#.#|#.#|#.#|##.',
  E: '###|#..|##.|#..|###', F: '###|#..|##.|#..|#..', G: '.##|#..|#.#|#.#|.##', H: '#.#|#.#|###|#.#|#.#',
  I: '###|.#.|.#.|.#.|###', J: '..#|..#|..#|#.#|.#.', K: '#.#|#.#|##.|#.#|#.#', L: '#..|#..|#..|#..|###',
  M: '#.#|###|###|#.#|#.#', N: '##.|#.#|#.#|#.#|#.#', O: '.#.|#.#|#.#|#.#|.#.', P: '##.|#.#|##.|#..|#..',
  Q: '.#.|#.#|#.#|##.|.##', R: '##.|#.#|##.|#.#|#.#', S: '.##|#..|.#.|..#|##.', T: '###|.#.|.#.|.#.|.#.',
  U: '#.#|#.#|#.#|#.#|###', V: '#.#|#.#|#.#|#.#|.#.', W: '#.#|#.#|###|###|#.#', X: '#.#|#.#|.#.|#.#|#.#',
  Y: '#.#|#.#|.#.|.#.|.#.', Z: '###|..#|.#.|#..|###',
  '.': '...|...|...|...|.#.', ':': '...|.#.|...|.#.|...', '-': '...|...|###|...|...', '/': '..#|..#|.#.|#..|#..',
  '%': '#.#|..#|.#.|#..|#.#', '_': '...|...|...|...|###', '=': '...|###|...|###|...', '+': '...|.#.|###|.#.|...',
  '>': '#..|.#.|..#|.#.|#..', '<': '..#|.#.|#..|.#.|..#', '(': '.#.|#..|#..|#..|.#.', ')': '.#.|..#|..#|..#|.#.',
  '[': '##.|#..|#..|#..|##.', ']': '.##|..#|..#|..#|.##', '#': '#.#|###|#.#|###|#.#', ',': '...|...|...|.#.|#..',
  '?': '###|..#|.#.|...|.#.', '!': '.#.|.#.|.#.|...|.#.', '*': '#.#|.#.|###|.#.|#.#', "'": '.#.|.#.|...|...|...',
  ' ': '...|...|...|...|...',
};
export function textWidth(str, scale = 2) { return str.length * 4 * scale - scale; }
export function drawText(img, x, y, str, color = [235, 238, 245, 255], scale = 2) {
  let cx = x;
  for (const chRaw of String(str)) {
    const g = GLYPHS[chRaw.toUpperCase()] ?? GLYPHS['?'];
    const rows = g.split('|');
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (rows[r][c] === '#') fillRect(img, cx + c * scale, y + r * scale, scale, scale, color);
    cx += 4 * scale;
  }
  return cx;
}

// =============================================================================================== compositing
export function fillRect(img, x, y, w, h, rgba) {
  const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(img.width, Math.floor(x + w)), y1 = Math.min(img.height, Math.floor(y + h));
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) img.data.set(rgba, (yy * img.width + xx) * 4);
}
export function strokeRect(img, x, y, w, h, rgba, t = 2) {
  fillRect(img, x, y, w, t, rgba); fillRect(img, x, y + h - t, w, t, rgba);
  fillRect(img, x, y, t, h, rgba); fillRect(img, x + w - t, y, t, h, rgba);
}
/** Fit src into the dst rect (aspect preserved, centred), box-filtered when shrinking, alpha-blended over dst. */
export function blitFit(dst, src, x, y, w, h) {
  const s = Math.min(w / src.width, h / src.height);
  const dw = Math.max(1, Math.round(src.width * s)), dh = Math.max(1, Math.round(src.height * s));
  const ox = x + Math.floor((w - dw) / 2), oy = y + Math.floor((h - dh) / 2);
  const n = Math.max(1, Math.min(4, Math.ceil(1 / s)));
  const sd = src.data;
  for (let j = 0; j < dh; j++) for (let i = 0; i < dw; i++) {
    const tx = ox + i, ty = oy + j;
    if (tx < 0 || ty < 0 || tx >= dst.width || ty >= dst.height) continue;
    let r = 0, g = 0, b = 0, a = 0;
    for (let sj = 0; sj < n; sj++) for (let si = 0; si < n; si++) {
      const sx = Math.min(src.width - 1, Math.floor((i + (si + 0.5) / n) / s)), sy = Math.min(src.height - 1, Math.floor((j + (sj + 0.5) / n) / s));
      const o = (sy * src.width + sx) * 4, al = sd[o + 3];
      r += sd[o] * al; g += sd[o + 1] * al; b += sd[o + 2] * al; a += al;
    }
    const o = (ty * dst.width + tx) * 4, A = a / (n * n * 255);
    if (a > 0) { r /= a; g /= a; b /= a; }
    dst.data[o] = Math.round(r * A + dst.data[o] * (1 - A));
    dst.data[o + 1] = Math.round(g * A + dst.data[o + 1] * (1 - A));
    dst.data[o + 2] = Math.round(b * A + dst.data[o + 2] * (1 - A));
    dst.data[o + 3] = 255;
  }
}

/**
 * Side-by-side comparison sheet. pairs: [{ label, ref, render, target?, iouOpts? }] (ref / render as for
 * computeSilhouetteIoU). Each row: [Concept / Detail Callout | 3D Voxel Render | Silhouette IoU diff] with a label line
 * "LABEL  IOU 0.874  TARGET 0.78  PASS"; the row border is green (pass), red (fail) or grey (no target).
 * outPng: path to write (or omit / pass opts as 2nd argument). Returns { width, height, image, rows[], path }.
 */
export function composeComparisonSheet(pairs, outPng = null, opts = {}) {
  if (outPng && typeof outPng === 'object' && !Buffer.isBuffer(outPng)) { opts = outPng; outPng = opts.out || null; }
  if (!Array.isArray(pairs) || !pairs.length) throw new Error('composeComparisonSheet: pairs[] is empty');
  const { cellW = 256, cellH = 192, pad = 10, scale = 2, title = null, iouOpts = {},
    columns = ['CONCEPT / DETAIL CALLOUT', '3D VOXEL RENDER', 'IOU MASK G=BOTH R=MISS B=EXCESS'] } = opts;
  const lineH = 5 * scale + 4;
  const W = pad + 3 * (cellW + pad);
  const headH = pad + (title ? lineH + 4 : 0) + lineH + 2;
  const rowH = lineH + 4 + cellH + pad;
  const H = headH + pairs.length * rowH + pad;
  const img = createImage(W, H, [12, 14, 20, 255]);
  let y = pad;
  if (title) { drawText(img, pad, y, title, [255, 214, 102, 255], scale); y += lineH + 4; }
  columns.forEach((c, k) => drawText(img, pad + k * (cellW + pad), y, c.slice(0, Math.floor((cellW + pad) / (4 * scale))), [150, 160, 180, 255], scale));
  const rows = [];
  pairs.forEach((p, r) => {
    const y0 = headH + r * rowH;
    const res = computeSilhouetteIoU(p.ref, p.render, { ...iouOpts, ...(p.iouOpts || {}), diff: true });
    const target = typeof p.target === 'number' ? p.target : null;
    const pass = target === null ? null : res.iou >= target;
    const border = pass === null ? [120, 126, 140, 255] : pass ? [70, 205, 110, 255] : [235, 70, 70, 255];
    const label = `${p.label || `PAIR ${r + 1}`}  IOU ${res.iou.toFixed(3)}${target !== null ? `  TARGET ${target.toFixed(2)}  ${pass ? 'PASS' : 'FAIL'}` : ''}`;
    drawText(img, pad, y0, label, border, scale);
    const cy = y0 + lineH + 4;
    const cells = [loadImage(p.ref), loadImage(p.render), res.diff];
    const rects = [];
    cells.forEach((c, k) => {
      const cx = pad + k * (cellW + pad);
      fillRect(img, cx, cy, cellW, cellH, [28, 31, 40, 255]);
      blitFit(img, c, cx + 3, cy + 3, cellW - 6, cellH - 6);
      strokeRect(img, cx, cy, cellW, cellH, border, 2);
      rects.push({ x: cx, y: cy, w: cellW, h: cellH });
    });
    rows.push({ label: p.label || `PAIR ${r + 1}`, iou: res.iou, precision: res.precision, recall: res.recall, target, pass, rects });
  });
  if (outPng) writePNG(outPng, img);
  return { width: W, height: H, image: img, rows, path: outPng || null };
}

// =============================================================================================== G5-v2.2 multi-cue gate
// Silhouette IoU alone lets a flat "wedding-cake" interior pass (the outline matches, the inside is blank). v2.2 adds two
// cues measured INSIDE the foreground mask on bbox-registered frames (same registration as computeSilhouetteIoU):
//   G5-Edge  internal structural edges: blurred-luma Sobel → non-maximum suppression → adaptive top-k threshold, the
//            silhouette rim (mask eroded by `inset` px) excluded. Symmetric dilated-edge F1 (radius 2–3 px) + mean
//            chamfer distance (3-4 chamfer DT, px at the registered size). Missing bevel steps, flat bulkheads or a
//            wrong bridge slope drop recall / raise the chamfer distance immediately.
//   G5-Band  accent palette distribution: screen-area share + centroid of each accent colour band (HSV hue range +
//            minimum saturation / value; default amber paint + cyan emissive) inside the mask, concept vs render
//            (over-painted or missing accent stripes fail).
export const G5_V22_TARGETS = Object.freeze({
  hero: { iou: 0.78, edgeF1: 0.52 }, ortho: { iou: 0.85, edgeF1: 0.55 },
  band: { ratioMin: 0.5, ratioMax: 2.0, centroidMax: 0.16, minShare: 0.004 },
});

/** RGBA image + its silhouette mask → both registered (bbox crop, aspect-preserving fit, centred) onto size×size. */
export function registerImage(src, opts = {}) {
  const { size = 256, pad = 4, maskOpts = {} } = opts;
  const img = loadImage(src);
  const m = toMask(img, maskOpts);
  const bb = maskBBox(m);
  const out = createImage(size, size, [0, 0, 0, 0]), mask = createMask(size, size);
  if (bb.empty) return { image: out, mask, bbox: bb };
  const s = (size - 2 * pad) / Math.max(bb.w, bb.h);
  const ox = (size - bb.w * s) / 2, oy = (size - bb.h * s) / 2;
  const d = img.data, W = img.width;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, n = 0, hit = 0;
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
      const u = (x + (i + 0.5) / 3 - ox) / s, v = (y + (j + 0.5) / 3 - oy) / s;
      if (u < 0 || v < 0 || u >= bb.w || v >= bb.h) continue;
      const px = bb.x0 + Math.floor(u), py = bb.y0 + Math.floor(v);
      if (!m.data[py * W + px]) continue;
      const o = (py * W + px) * 4;
      r += d[o]; g += d[o + 1]; b += d[o + 2]; n++; hit++;
    }
    if (hit >= 5) {
      mask.data[y * size + x] = 1;
      const o = (y * size + x) * 4;
      out.data[o] = Math.round(r / n); out.data[o + 1] = Math.round(g / n); out.data[o + 2] = Math.round(b / n); out.data[o + 3] = 255;
    }
  }
  return { image: out, mask, bbox: bb };
}

// =============================================================================================== v2.3 G5 hull-only
export const G5_V23_TARGETS = Object.freeze({ hull: { iou: 0.86, openRadius: 3 } });

/** morphological opening (erode then dilate, (2r+1)² square): strips structures thinner than ~2r px (tentacles, antennae). */
export function openMask(mask, r) { return r > 0 ? morphMask(morphMask(mask, r, 'erode'), r, 'dilate') : { ...mask, data: Uint8Array.from(mask.data) }; }

/** keep only the largest 4-connected foreground component (drops detached appendage fragments after an opening). */
export function largestComponent(mask) {
  const { width: w, height: h, data } = mask;
  const lab = new Int32Array(w * h), stack = new Int32Array(w * h);
  let best = 0, bestN = 0, next = 0;
  for (let i = 0; i < w * h; i++) {
    if (!data[i] || lab[i]) continue;
    const id = ++next; let sp = 0, n = 0; stack[sp++] = i; lab[i] = id;
    while (sp) {
      const j = stack[--sp]; n++;
      const x = j % w, y = (j - x) / w;
      if (x > 0 && data[j - 1] && !lab[j - 1]) { lab[j - 1] = id; stack[sp++] = j - 1; }
      if (x < w - 1 && data[j + 1] && !lab[j + 1]) { lab[j + 1] = id; stack[sp++] = j + 1; }
      if (y > 0 && data[j - w] && !lab[j - w]) { lab[j - w] = id; stack[sp++] = j - w; }
      if (y < h - 1 && data[j + w] && !lab[j + w]) { lab[j + w] = id; stack[sp++] = j + w; }
    }
    if (n > bestN) { bestN = n; best = id; }
  }
  const out = createMask(w, h);
  for (let i = 0; i < w * h; i++) out.data[i] = lab[i] === best && best ? 1 : 0;
  return out;
}

/**
 * G5-v2.3 hull-only silhouette IoU — locks the core hull (carapace dome + jaw proportions) of organic / tentacled ships
 * independently of curling appendages.
 * ref / render: concept + render (PNG path | bytes | RGBA | mask). Hull isolation (opts):
 *   refHull / renderHull (or hullOnly: { ref, render })  explicit hull-only inputs — e.g. the concept with tentacles painted
 *                    out and renderPreview(…, { excludeKinds: ['wave'] }) / the studio with the wave part hidden. When BOTH
 *                    are given no opening is applied (openRadius 0) unless opts.open says otherwise.
 *   open (px at 2× the registered size, default G5_V23_TARGETS.hull.openRadius = 3)   automatic: morphological opening
 *                    strips thin appendages, then the largest component is kept (opts.keepLargest, default true).
 * Both hull masks are then re-registered on their OWN bbox (aspect-preserving) → tentacle reach changes neither framing nor
 * scale. opts: { size 256, pad 4, target 0.86, maskOpts / refOpts / renderOpts (toMask), diff true }.
 * → { iou, precision, recall, target, pass, method 'explicit' | 'open' | 'mixed', openRadius, full (whole-silhouette IoU),
 *     refPixels, renderPixels, diff }
 */
export function computeHullSilhouetteIoU(ref, render, opts = {}) {
  const { size = 256, pad = 4, target = G5_V23_TARGETS.hull.iou, keepLargest = true, diff = true } = opts;
  const refHull = opts.refHull ?? (opts.hullOnly && opts.hullOnly.ref) ?? null, renderHull = opts.renderHull ?? (opts.hullOnly && opts.hullOnly.render) ?? null;
  const base = { ...(opts.maskOpts || {}) };
  const method = refHull && renderHull ? 'explicit' : refHull || renderHull ? 'mixed' : 'open';
  const r = opts.open ?? (method === 'explicit' ? 0 : G5_V23_TARGETS.hull.openRadius);
  const prep = (src, o) => {
    let m = registerMask(toMask(src, { ...base, ...o }), { size: size * 2, pad: pad * 2, register: 'bbox' });
    if (r > 0) m = openMask(m, r);
    if (keepLargest) m = largestComponent(m);
    return registerMask(m, { size, pad, register: 'bbox' });
  };
  const a = prep(refHull ?? ref, opts.refOpts || {}), b = prep(renderHull ?? render, opts.renderOpts || {});
  let inter = 0, uni = 0, na = 0, nb = 0;
  const img = diff ? createImage(size, size, DIFF_COLORS.none) : null;
  for (let i = 0; i < a.data.length; i++) {
    const x = a.data[i], y = b.data[i];
    if (x) na++; if (y) nb++; if (x && y) inter++; if (x || y) uni++;
    if (img) img.data.set(x && y ? DIFF_COLORS.both : x ? DIFF_COLORS.missing : y ? DIFF_COLORS.excess : DIFF_COLORS.none, i * 4);
  }
  const iou = uni ? inter / uni : 0;
  const full = computeSilhouetteIoU(ref, render, { size, pad, diff: false, refOpts: { ...base, ...(opts.refOpts || {}) }, renderOpts: { ...base, ...(opts.renderOpts || {}) } }).iou;
  return { iou, precision: nb ? inter / nb : 0, recall: na ? inter / na : 0, target, pass: iou >= target, method, openRadius: r, full, refPixels: na, renderPixels: nb, diff: img };
}

/** binary erosion / dilation with a (2r+1)² square (separable). */
export function morphMask(mask, r, op = 'dilate') {
  const { width: w, height: h } = mask;
  let a = Uint8Array.from(mask.data);
  if (r <= 0) return { width: w, height: h, channels: 1, data: a };
  const er = op === 'erode';
  const pass = (src, horiz) => {
    const dst = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = er ? 1 : 0;
      for (let k = -r; k <= r; k++) {
        const xx = horiz ? x + k : x, yy = horiz ? y : y + k;
        const s = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : src[yy * w + xx];
        if (er ? !s : s) { v = er ? 0 : 1; break; }
      }
      dst[y * w + x] = v;
    }
    return dst;
  };
  a = pass(pass(a, true), false);
  return { width: w, height: h, channels: 1, data: a };
}

/** two-pass 3-4 chamfer distance transform (px) to the nearest set pixel of `mask` (Infinity-free: capped at w + h). */
export function distanceTransform(mask) {
  const { width: w, height: h, data } = mask;
  const INF = 3 * (w + h);
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = data[i] ? 0 : INF;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 3);
    if (y > 0) { v = Math.min(v, d[i - w] + 3); if (x > 0) v = Math.min(v, d[i - w - 1] + 4); if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4); }
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; let v = d[i];
    if (x < w - 1) v = Math.min(v, d[i + 1] + 3);
    if (y < h - 1) { v = Math.min(v, d[i + w] + 3); if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4); if (x > 0) v = Math.min(v, d[i + w - 1] + 4); }
    d[i] = v;
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3;
  return d;
}

/**
 * Internal structural edges of a registered image: luma → 3×3 [1 2 1] blur → Sobel → non-maximum suppression → keep the
 * strongest `keep` fraction of NMS ridge pixels (and ≥ minMag) inside the foreground mask eroded by `inset` px.
 * Returns { edges (mask), interior (mask), count, threshold }.
 */
export function internalEdges(image, mask, opts = {}) {
  const { inset = 3, keep = 0.42, minMag = 24 } = opts;
  const { width: w, height: h, data } = image;
  const L = new Float32Array(w * h), B = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = mask.data[i] ? 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2] : 0;
  const at = (a, x, y) => a[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += at(L, x + i, y + j) * (i ? 1 : 2) * (j ? 1 : 2);
    B[y * w + x] = s / 16;
  }
  const M = new Float32Array(w * h), D = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const gx = at(B, x + 1, y - 1) + 2 * at(B, x + 1, y) + at(B, x + 1, y + 1) - at(B, x - 1, y - 1) - 2 * at(B, x - 1, y) - at(B, x - 1, y + 1);
    const gy = at(B, x - 1, y + 1) + 2 * at(B, x, y + 1) + at(B, x + 1, y + 1) - at(B, x - 1, y - 1) - 2 * at(B, x, y - 1) - at(B, x + 1, y - 1);
    M[y * w + x] = Math.hypot(gx, gy);
    const ang = ((Math.atan2(gy, gx) * 180) / Math.PI + 180) % 180;
    D[y * w + x] = ang < 22.5 || ang >= 157.5 ? 0 : ang < 67.5 ? 1 : ang < 112.5 ? 2 : 3;
  }
  const interior = morphMask(mask, inset, 'erode');
  const cand = [];
  const NB = [[1, 0], [1, 1], [0, 1], [-1, 1]];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!interior.data[i] || M[i] < minMag) continue;
    const [dx, dy] = NB[D[i]];
    if (M[i] < M[i + dy * w + dx] || M[i] < M[i - dy * w - dx]) continue;
    cand.push(M[i]);
  }
  const sorted = Float32Array.from(cand).sort();
  const thr = sorted.length ? Math.max(minMag, sorted[Math.floor((1 - keep) * (sorted.length - 1))]) : Infinity;
  const edges = createMask(w, h);
  let count = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!interior.data[i] || M[i] < thr) continue;
    const [dx, dy] = NB[D[i]];
    if (M[i] < M[i + dy * w + dx] || M[i] < M[i - dy * w - dx]) continue;
    edges.data[i] = 1; count++;
  }
  return { edges, interior, count, threshold: thr };
}

/**
 * G5-Edge: internal structural edge agreement between a reference (concept / ortho blueprint) and a render.
 * opts: { size 256, radius 2 (dilation, px), inset 3, keep 0.42, minMag 24, refOpts / renderOpts (toMask options),
 *         diff true }. Returns { f1, precision, recall, chamfer (symmetric mean px), chamferRenderToRef,
 * chamferRefToRender, refEdges, renderEdges, baselineF1 (render flipped top↔bottom — the chance level of this pair; L↔R would be symmetric), diff
 * (RGBA: white = matched render edge, cyan = unmatched render edge, red = missed reference edge) }.
 */
export function computeEdgeG5(ref, render, opts = {}) {
  const { size = 256, radius = 2, diff = true } = opts;
  const eo = { inset: opts.inset ?? 3, keep: opts.keep ?? 0.42, minMag: opts.minMag ?? 24 };
  const A = registerImage(ref, { size, maskOpts: opts.refOpts || {} }), Bm = registerImage(render, { size, maskOpts: opts.renderOpts || {} });
  const ea = internalEdges(A.image, A.mask, eo).edges, eb = internalEdges(Bm.image, Bm.mask, eo).edges;
  const score = (ra, rb) => {
    const da = morphMask(ra, radius, 'dilate'), db = morphMask(rb, radius, 'dilate');
    let na = 0, nb = 0, hb = 0, ha = 0;
    for (let i = 0; i < ra.data.length; i++) {
      if (ra.data[i]) { na++; if (db.data[i]) ha++; }
      if (rb.data[i]) { nb++; if (da.data[i]) hb++; }
    }
    const precision = nb ? hb / nb : 0, recall = na ? ha / na : 0;
    return { precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0, na, nb, da };
  };
  const s = score(ea, eb);
  const mirrored = { width: eb.width, height: eb.height, channels: 1, data: new Uint8Array(eb.data.length) };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) mirrored.data[y * size + x] = eb.data[(size - 1 - y) * size + x];
  const base = score(ea, mirrored);
  const dta = distanceTransform(ea), dtb = distanceTransform(eb);
  let sab = 0, sba = 0;
  for (let i = 0; i < ea.data.length; i++) { if (eb.data[i]) sab += dta[i]; if (ea.data[i]) sba += dtb[i]; }
  const c1 = s.nb ? sab / s.nb : size, c2 = s.na ? sba / s.na : size;
  let img = null;
  if (diff) {
    img = createImage(size, size, [16, 18, 24, 255]);
    const db = morphMask(eb, radius, 'dilate');
    for (let i = 0; i < size * size; i++) {
      if (A.mask.data[i] || Bm.mask.data[i]) img.data.set([30, 34, 44, 255], i * 4);
      if (ea.data[i] && !db.data[i]) img.data.set([235, 70, 70, 255], i * 4);
      if (eb.data[i]) img.data.set(s.da.data[i] ? [240, 244, 250, 255] : [60, 220, 255, 255], i * 4);
    }
  }
  return { f1: s.f1, precision: s.precision, recall: s.recall, chamfer: (c1 + c2) / 2, chamferRenderToRef: c1, chamferRefToRender: c2,
    refEdges: s.na, renderEdges: s.nb, baselineF1: base.f1, radius, size, diff: img };
}

/**
 * Accent colour bands for G5-Band: { name, hue [minDeg, maxDeg] (inclusive; minDeg > maxDeg wraps through 0°, e.g. crimson
 * [340, 20]), minS 0..1, minV 0..1, rgb? [r, g, b] (diff / sheet colour) }. A pixel belongs to the FIRST band it matches.
 * The defaults are the original amber (paint / hazard bands) + cyan (emissive) pair.
 */
export const DEFAULT_ACCENT_BANDS = Object.freeze([
  Object.freeze({ name: 'amber', hue: Object.freeze([20, 54]), minS: 0.45, minV: 0.3, rgb: Object.freeze([255, 176, 40]) }),
  Object.freeze({ name: 'cyan', hue: Object.freeze([165, 205]), minS: 0.4, minV: 0.42, rgb: Object.freeze([60, 235, 255]) }),
]);
const BAND_RESERVED = new Set(['pass', 'bands', 'diff']);
const hsvToRgb = (h, s, v) => {
  const f = (n) => { const k = (n + h / 60) % 6; return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))); };
  return [f(5), f(3), f(1)];
};
/** Validate + complete band descriptors (default rgb = the band's mid hue at s 0.85, v 1). → frozen plain objects. */
export function normalizeAccentBands(bands = DEFAULT_ACCENT_BANDS) {
  if (bands === DEFAULT_ACCENT_BANDS) return DEFAULT_ACCENT_BANDS;
  if (!Array.isArray(bands) || !bands.length) throw new Error('bands: a non-empty array of { name, hue [min, max], minS, minV } is required');
  const seen = new Set();
  return Object.freeze(bands.map((b, i) => {
    if (!b || typeof b.name !== 'string' || !/^[a-z][a-z0-9_-]*$/i.test(b.name)) throw new Error(`bands[${i}]: name must match [a-z][a-z0-9_-]*`);
    if (BAND_RESERVED.has(b.name) || seen.has(b.name)) throw new Error(`bands[${i}]: name '${b.name}' is reserved or duplicated`);
    seen.add(b.name);
    if (!Array.isArray(b.hue) || b.hue.length !== 2 || !b.hue.every((h) => Number.isFinite(h))) throw new Error(`bands[${i}] (${b.name}): hue must be [minDeg, maxDeg]`);
    const hue = b.hue.map((h) => ((h % 360) + 360) % 360);
    const minS = b.minS ?? 0.4, minV = b.minV ?? 0.3;
    if (!(minS >= 0 && minS <= 1 && minV >= 0 && minV <= 1)) throw new Error(`bands[${i}] (${b.name}): minS / minV must be in 0..1`);
    const mid = hue[0] <= hue[1] ? (hue[0] + hue[1]) / 2 : ((hue[0] + hue[1] + 360) / 2) % 360;
    const rgb = Array.isArray(b.rgb) && b.rgb.length === 3 ? b.rgb.map((c) => Math.max(0, Math.min(255, Math.round(c)))) : hsvToRgb(mid, 0.85, 1);
    return Object.freeze({ name: b.name, hue: Object.freeze(hue), minS, minV, rgb: Object.freeze(rgb) });
  }));
}
/** CLI / config form 'name:minH-maxH[:minS[:minV[:#rrggbb]]],…' → band descriptors (e.g. 'crimson:340-20:0.45:0.30,gold:35-58'). */
export function parseAccentBands(spec) {
  if (typeof spec !== 'string' || !spec.trim()) throw new Error('bands: empty spec');
  return normalizeAccentBands(spec.split(',').map((t) => t.trim()).filter(Boolean).map((t) => {
    const [name, hue, minS, minV, hex] = t.split(':');
    const m = /^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/.exec(hue || '');
    if (!m) throw new Error(`bands: '${t}' needs name:minH-maxH`);
    const rgb = hex && /^#?[0-9a-f]{6}$/i.test(hex) ? [0, 2, 4].map((k) => parseInt(hex.replace('#', '').slice(k, k + 2), 16)) : undefined;
    return { name, hue: [Number(m[1]), Number(m[2])], minS: minS !== undefined && minS !== '' ? Number(minS) : undefined, minV: minV !== undefined && minV !== '' ? Number(minV) : undefined, rgb };
  }));
}
const inHue = (h, [lo, hi]) => (lo <= hi ? h >= lo && h <= hi : h >= lo || h <= hi);

/** HSV accent classifier → the name of the first matching band (default: 'amber' paint / 'cyan' emissive), or null. */
export function accentClass(r, g, b, bands = DEFAULT_ACCENT_BANDS) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = mx / 255, s = mx ? (mx - mn) / mx : 0;
  if (mx === mn) return null;
  let hdeg;
  if (mx === r) hdeg = 60 * (((g - b) / (mx - mn)) % 6); else if (mx === g) hdeg = 60 * ((b - r) / (mx - mn) + 2); else hdeg = 60 * ((r - g) / (mx - mn) + 4);
  if (hdeg < 0) hdeg += 360;
  for (const band of bands) if (inHue(hdeg, band.hue) && s >= band.minS && v >= band.minV) return band.name;
  return null;
}

/**
 * G5-Band: accent-colour distribution inside the registered foreground masks, one entry per band of `opts.bands`
 * (default DEFAULT_ACCENT_BANDS = amber + cyan). Returns { pass, <band name>: { ref, render, ratio, centroidDist,
 * refCentroid, renderCentroid, pass }, … , bands [descriptors], diff (RGBA: band-coloured accent pixels of the reference on
 * the left half, the render on the right half) } with share = accent px / foreground px, centroid in 0..1. With the default
 * bands the result therefore keeps its `amber` / `cyan` keys exactly as before.
 */
export function computeBandG5(ref, render, opts = {}) {
  const { size = 256 } = opts;
  const T = { ...G5_V22_TARGETS.band, ...(opts.targets || {}) };
  const bands = normalizeAccentBands(opts.bands || DEFAULT_ACCENT_BANDS), names = bands.map((b) => b.name);
  const A = registerImage(ref, { size, maskOpts: opts.refOpts || {} }), Bm = registerImage(render, { size, maskOpts: opts.renderOpts || {} });
  const stat = (R) => {
    const o = Object.fromEntries(names.map((k) => [k, { n: 0, x: 0, y: 0 }])); let fg = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (!R.mask.data[i]) continue;
      fg++;
      const c = accentClass(R.image.data[i * 4], R.image.data[i * 4 + 1], R.image.data[i * 4 + 2], bands);
      if (c) { o[c].n++; o[c].x += x; o[c].y += y; }
    }
    for (const k of names) { const q = o[k]; q.share = fg ? q.n / fg : 0; q.cx = q.n ? q.x / q.n / size : null; q.cy = q.n ? q.y / q.n / size : null; }
    return o;
  };
  const sa = stat(A), sb = stat(Bm);
  const out = { pass: true };
  for (const k of names) {
    const a = sa[k], b = sb[k];
    const present = a.share >= T.minShare;
    const ratio = present ? b.share / a.share : b.share < T.minShare ? 1 : Infinity;
    const cd = present && b.n ? Math.hypot(a.cx - b.cx, a.cy - b.cy) : present ? 1 : 0;
    const pass = ratio >= T.ratioMin && ratio <= T.ratioMax && cd <= T.centroidMax;
    out[k] = { ref: +a.share.toFixed(4), render: +b.share.toFixed(4), ratio: Number.isFinite(ratio) ? +ratio.toFixed(3) : ratio, centroidDist: +cd.toFixed(4),
      refCentroid: a.cx === null ? null : [+a.cx.toFixed(3), +a.cy.toFixed(3)], renderCentroid: b.cx === null ? null : [+b.cx.toFixed(3), +b.cy.toFixed(3)], pass };
    if (!pass) out.pass = false;
  }
  out.bands = bands.map((b) => ({ name: b.name, hue: b.hue.slice(), minS: b.minS, minV: b.minV, rgb: b.rgb.slice() }));
  if (opts.diff !== false) {
    const img = createImage(size * 2 + 4, size, [16, 18, 24, 255]);
    const col = Object.fromEntries(bands.map((b) => [b.name, [...b.rgb, 255]]));
    for (const [R, ox] of [[A, 0], [Bm, size + 4]]) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (!R.mask.data[i]) continue;
      const c = accentClass(R.image.data[i * 4], R.image.data[i * 4 + 1], R.image.data[i * 4 + 2], bands);
      img.data.set(c ? col[c] : [44, 48, 60, 255], (y * img.width + x + ox) * 4);
    }
    out.diff = img;
  }
  return out;
}

/**
 * Full G5-v2.2 multi-cue gate for one reference / render pair. kind 'hero' | 'ortho' selects the default targets.
 * Returns { silhouette { iou, precision, recall, pass }, edge { f1, chamfer, …, pass }, band { <band name>…, bands, pass }, pass }
 * (opts.bands → computeBandG5; default amber + cyan).
 * (The ortho F1 target applies to the AVERAGE over top / side / front — see multiCueSummary.)
 */
export function computeMultiCueG5(ref, render, opts = {}) {
  const kind = opts.kind || 'hero';
  const T = { ...G5_V22_TARGETS[kind], ...(opts.targets || {}) };
  const sil = computeSilhouetteIoU(ref, render, { size: opts.size || 256, refOpts: opts.refOpts, renderOpts: opts.renderOpts, diff: opts.diff !== false });
  const edge = computeEdgeG5(ref, render, opts);
  const band = computeBandG5(ref, render, opts);
  const silhouette = { iou: sil.iou, precision: sil.precision, recall: sil.recall, target: T.iou, pass: sil.iou >= T.iou, diff: sil.diff };
  const e = { ...edge, target: T.edgeF1, pass: edge.f1 >= T.edgeF1 };
  return { kind, silhouette, edge: e, band, pass: silhouette.pass && e.pass && band.pass };
}

/** { hero, top, side, front } computeMultiCueG5 results → gate summary (hero F1 ≥ 0.52, ortho AVERAGE F1 ≥ 0.55). */
export function multiCueSummary(res) {
  const ortho = ['top', 'side', 'front'].filter((k) => res[k]);
  const orthoF1 = ortho.length ? ortho.reduce((s, k) => s + res[k].edge.f1, 0) / ortho.length : null;
  const silPass = Object.values(res).every((r) => r.silhouette.pass);
  const heroEdge = res.hero ? res.hero.edge.f1 >= G5_V22_TARGETS.hero.edgeF1 : true;
  const orthoEdge = orthoF1 === null || orthoF1 >= G5_V22_TARGETS.ortho.edgeF1;
  const bandPass = Object.values(res).every((r) => r.band.pass);
  return { silhouette: silPass, heroEdgeF1: res.hero ? res.hero.edge.f1 : null, orthoAvgEdgeF1: orthoF1, edge: heroEdge && orthoEdge, band: bandPass, pass: silPass && heroEdge && orthoEdge && bandPass };
}

/** Short per-band labels for sheet text: the first letter when unique among the bands, else the first 3 letters. */
function bandShortNames(names) {
  const first = names.map((n) => n[0].toUpperCase());
  return names.map((n, i) => (first.filter((f) => f === first[i]).length > 1 ? n.slice(0, 3).toUpperCase() : first[i]));
}

/**
 * Multi-cue comparison sheet: one row per pair → [Concept | Render | Silhouette IoU diff | Edge overlay | Band split],
 * label "LABEL IOU 0.874 EDGE F1 0.61 CH 2.3PX BAND A OK C OK PASS" (one short name per band). pairs: [{ label, ref,
 * render, kind, opts? }]; opts.bands applies to every pair (default amber + cyan). The band column header names each band
 * in its own diff colour.
 */
export function composeMultiCueSheet(pairs, outPng = null, opts = {}) {
  const { cellW = 260, cellH = 190, pad = 10, scale = 2, title = null } = opts;
  const bands = normalizeAccentBands(opts.bands || DEFAULT_ACCENT_BANDS), names = bands.map((b) => b.name), shortNames = bandShortNames(names);
  const lineH = 5 * scale + 4, cols = 5;
  const W = pad + cols * (cellW + pad);
  const headH = pad + (title ? lineH + 4 : 0) + lineH + 2;
  const rowH = lineH + 4 + cellH + pad;
  const img = createImage(W, headH + pairs.length * rowH + pad, [12, 14, 20, 255]);
  let y = pad;
  if (title) { drawText(img, pad, y, title, [255, 214, 102, 255], scale); y += lineH + 4; }
  ['CONCEPT / BLUEPRINT', '3D RENDER', 'SILHOUETTE IOU', 'EDGES W=HIT C=EXTRA R=MISS'].forEach((c, k) => drawText(img, pad + k * (cellW + pad), y, c.slice(0, Math.floor((cellW + pad) / (4 * scale))), [150, 160, 180, 255], scale));
  {   // band column header: "BAND" + each band name in its diff colour (clipped to the column width)
    const x0 = pad + 4 * (cellW + pad), xMax = x0 + cellW;
    let x = drawText(img, x0, y, 'BAND', [150, 160, 180, 255], scale) + 4 * scale;
    for (const b of bands) { const t = b.name.toUpperCase(); if (x + t.length * 4 * scale > xMax) break; x = drawText(img, x, y, t, [...b.rgb, 255], scale) + 4 * scale; }
  }
  const rows = [];
  pairs.forEach((p, r) => {
    const y0 = headH + r * rowH;
    const res = p.result || computeMultiCueG5(p.ref, p.render, { kind: p.kind || 'hero', bands, ...(p.opts || {}) });
    const ok = res.pass, border = ok ? [70, 205, 110, 255] : [235, 70, 70, 255];
    const rowNames = res.band.bands ? res.band.bands.map((b) => b.name) : names.filter((n) => res.band[n]);
    const rowShort = bandShortNames(rowNames);
    const bandText = rowNames.map((n, i) => `${rowShort[i]} ${res.band[n] && res.band[n].pass ? 'OK' : 'X'}`).join(' ');
    const label = `${p.label}  IOU ${res.silhouette.iou.toFixed(3)}  EDGE F1 ${res.edge.f1.toFixed(3)} (/${res.edge.target}) CH ${res.edge.chamfer.toFixed(1)}PX  BAND ${bandText}  ${ok ? 'PASS' : 'FAIL'}`;
    drawText(img, pad, y0, label, border, scale);
    const cy = y0 + lineH + 4;
    [loadImage(p.ref), loadImage(p.render), res.silhouette.diff, res.edge.diff, res.band.diff].forEach((c, k) => {
      const cx = pad + k * (cellW + pad);
      fillRect(img, cx, cy, cellW, cellH, [28, 31, 40, 255]);
      if (c) blitFit(img, c, cx + 3, cy + 3, cellW - 6, cellH - 6);
      strokeRect(img, cx, cy, cellW, cellH, border, 2);
    });
    rows.push({ label: p.label, kind: p.kind || 'hero', iou: res.silhouette.iou, edgeF1: res.edge.f1, chamfer: res.edge.chamfer, baselineF1: res.edge.baselineF1, band: Object.fromEntries(rowNames.map((n) => [n, res.band[n]])), pass: ok, result: res });
  });
  if (outPng) writePNG(outPng, img);
  return { width: img.width, height: img.height, image: img, rows, path: outPng || null };
}

// =============================================================================================== CLI
function cli(argv) {
  const a = parseArgs(argv);
  const cmd = a._[0];
  const num = (v, d) => (v === undefined || v === true ? d : Number(v));
  const iouOpts = { register: a.register || 'bbox', size: num(a.size, 256), channel: a.channel || 'auto', threshold: num(a.threshold, 128), invert: !!a.invert, keyTolerance: num(a['key-tolerance'], 48) };
  if (cmd === 'iou') {
    if (!a.ref || !a.render) throw new Error('iou: --ref and --render are required');
    const r = computeSilhouetteIoU(a.ref, a.render, iouOpts);
    if (a.diff) writePNG(a.diff, r.diff);
    const target = a.target !== undefined ? Number(a.target) : null;
    const pass = target === null ? true : r.iou >= target;
    console.log(`IoU ${r.iou.toFixed(4)}  precision ${r.precision.toFixed(4)}  recall ${r.recall.toFixed(4)}  (${r.width}x${r.height}, register ${r.register})${target !== null ? `  target ${target} → ${pass ? 'PASS' : 'FAIL'}` : ''}${a.diff ? `  diff → ${a.diff}` : ''}`);
    return pass ? 0 : 1;
  }
  if (cmd === 'sheet') {
    if (!a.pairs || !a.out) throw new Error('sheet: --pairs and --out are required');
    const dir = path.dirname(path.resolve(a.pairs));
    const pairs = JSON.parse(fs.readFileSync(a.pairs, 'utf8')).map((p) => ({ ...p, ref: path.resolve(dir, p.ref), render: path.resolve(dir, p.render) }));
    const s = composeComparisonSheet(pairs, a.out, { title: typeof a.title === 'string' ? a.title : null, iouOpts });
    let ok = true;
    for (const r of s.rows) { console.log(`${(r.pass === null ? '----' : r.pass ? 'PASS' : 'FAIL')} ${r.label.padEnd(28)} IoU ${r.iou.toFixed(4)}${r.target !== null ? ` / ${r.target}` : ''}`); if (r.pass === false) ok = false; }
    console.log(`sheet ${s.width}x${s.height} → ${a.out}`);
    return ok ? 0 : 1;
  }
  if (cmd === 'mask') {
    if (!a.input || !a.out) throw new Error('mask: --input and --out are required');
    let m = toMask(a.input, iouOpts);
    if (a.register) m = registerMask(m, { size: iouOpts.size, register: a.register });
    writePNG(a.out, maskToImage(m, { fg: [255, 255, 255, 255], bg: [0, 0, 0, 255] }));
    const bb = maskBBox(m);
    console.log(`mask ${m.width}x${m.height}  fg ${maskCount(m)} px  bbox ${bb.w}x${bb.h}@${bb.x0},${bb.y0} → ${a.out}`);
    return 0;
  }
  if (cmd === 'multicue') {
    if (!a.ref || !a.render) throw new Error('multicue: --ref and --render are required');
    const kind = a.kind === 'ortho' ? 'ortho' : 'hero';
    const bands = typeof a.bands === 'string' ? parseAccentBands(a.bands) : DEFAULT_ACCENT_BANDS;
    const s = composeMultiCueSheet([{ label: kind.toUpperCase(), ref: a.ref, render: a.render, kind }], typeof a.out === 'string' ? a.out : null, { title: 'G5 MULTI-CUE', bands });
    const r = s.rows[0];
    const bandText = Object.entries(r.band).map(([n, b]) => `${n} ${b.pass ? 'ok' : 'FAIL'}`).join(' ');
    console.log(`${r.pass ? 'PASS' : 'FAIL'} ${kind}: IoU ${r.iou.toFixed(4)}  edge F1 ${r.edgeF1.toFixed(4)} (chance ${r.baselineF1.toFixed(3)})  chamfer ${r.chamfer.toFixed(2)} px  ${bandText}${s.path ? `  → ${s.path}` : ''}`);
    return r.pass ? 0 : 1;
  }
  if (cmd === 'hull') {
    if (!a.ref || !a.render) throw new Error('hull: --ref and --render are required');
    const r = computeHullSilhouetteIoU(a.ref, a.render, { refHull: typeof a['ref-hull'] === 'string' ? a['ref-hull'] : null, renderHull: typeof a['render-hull'] === 'string' ? a['render-hull'] : null,
      open: a.open !== undefined ? Number(a.open) : undefined, target: a.target !== undefined ? Number(a.target) : undefined, size: num(a.size, 256) });
    if (typeof a.diff === 'string') writePNG(a.diff, r.diff);
    console.log(`${r.pass ? 'PASS' : 'FAIL'} hull IoU ${r.iou.toFixed(4)} / ${r.target} (${r.method}, open ${r.openRadius} px) · full silhouette ${r.full.toFixed(4)}${typeof a.diff === 'string' ? `  diff → ${a.diff}` : ''}`);
    return r.pass ? 0 : 1;
  }
  console.log('usage: node mega_diff_utils.mjs <iou|sheet|mask|multicue|hull> [options]   (see header comment)');
  return cmd ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  try { process.exitCode = cli(process.argv.slice(2)); } catch (e) { console.error(`error: ${e.message}`); process.exitCode = 1; }
}
