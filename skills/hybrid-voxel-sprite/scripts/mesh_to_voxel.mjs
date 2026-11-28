#!/usr/bin/env node
// mesh_to_voxel.mjs — hybrid-voxel-sprite · Track B Mode B2: 3D mesh (.glb / .gltf) → voxel grid → svox.mega/v2.3 (quad16).
// Node >= 18, zero npm dependencies (imports the sibling ./mega_voxel_kit.mjs and ./mega_diff_utils.mjs). ES module + CLI.
//
//   inspect   --glb <file> --out <dir> [alignment flags]          → glb_inspect.json (bounds, aspect, materials) +
//             glb_6view_sheet.png (raw glTF frame: +Y up, front +Z) and, with any alignment flag, glb_6view_aligned.png
//             (asset frame: +X right, +Y forward, +Z up). Six CPU-rasterised views: 5 orthographic + 1 perspective 3/4.
//   render    --glb <file> --out <png> [alignment flags] [--view az=-40,el=17,fov=24,fit=1.04] [--width W --height H] [--clay]
//   voxelize  --glb <file> | --source <mesh_source.json>  --out-asset <base> [alignment flags] [options]
//             → <base>.json + <base>.bin (svox.mega/v2.3, quad16 macro parts) + <cache-dir>/voxel_cache.{json,bin}
//               + voxelize_report.json + CPU preview PNGs
//   self-test                                                     → greedyQuad16Masked == kit greedyQuad16Part (byte parity)
//
// Alignment (applied in this order): glTF node transforms → rotate X, then Y, then Z (degrees, right-handed) → (--origin
// center) bbox centre to 0 → uniform scale so the Y extent equals --length-y → + --translate x,y,z.
// A typical glTF (Y-up, front +Z) becomes the Track B asset frame (Z-up, forward +Y) with --rot-x 90.
//
// voxelize options:
//   --voxel-scale u/vox (2.2)  --margin vox (3)  --solidify  --symmetrize x[:low|high]  --interior '#hex' --interior-mat n
//   --colors K (20 diffuse k-means clusters)  --emissive-rules <json|file>  --mat-rules <json|file>  --default-mat n
//   --color-smooth N (1)  --sat-boost f  --contrast f  --val-gamma g  --val-gain k   (global texture grade, default 1)
//   --zones <detail_zones.json> [--zone-ids a,b]  --carve-box minX,minY,minZ,maxX,maxY,maxZ   (after solidify, before AO)
//   --ao-rays 24 --ao-dist 36 --macro-levels 16  --id --name --archetype --material-profile --faction --meta <json|file>
//   --cache-dir <dir> (default: dirname(out-asset))  --no-preview  --image-decoder auto|python|none
//   multi-part: --split-part name:kind:clauses[:wave=amp,freq,originY][:axis=ellipsoid|box:auto|cx,cy,cz:rx,ry,rz][:cc=minVox]
//   (repeatable, first match wins, the rest stays in --base-part hull, kind static). ONE bakeMacroCavityAO on the unified
//   grid, then greedyQuad16Masked per part: exposure, micro AO and macro AO see the whole grid → no seams, no junction faces.
//   Programmatic extras: voxelizeGlb({ partSplitter(x, y, z, vox, grid), preAoHook(ctx), mesoHook(ctx), metaHook(ctx), decodeImage }).
//
// Rule JSON (emissive + mat rules): [{ "name": "lime", "hue": [60, 110], "sat": [0.45, 1], "val": [0.55, 1], "matTag": 8,
//   "emissive": 0.95, "levels": 4 }] — hue in degrees (lo > hi wraps through 0), sat / val 0..1. Emissive rules split their
//   voxels out BEFORE the diffuse k-means (each rule → `levels` clusters, emissive scaled by brightness); mat rules tag diffuse
//   clusters by their centroid colour (first match wins, else --default-mat). Voxels lit by an emissiveTexture / emissiveFactor
//   join group "emissive_tex". Any rule may carry "grade": { "gamma", "gain", "sat", "hueShift" } → V' = gain·V^gamma, S' = sat·S
//   on its palette entries (rules always MATCH on the raw texture colour; the grade only changes the stored colour).
//
// Textures: PNG is decoded natively. JPEG / WebP textures need a decoder: pass decodeImage(bytes, mime) → { w, h, data RGBA8 }
// programmatically, or let --image-decoder auto|python use Python + Pillow when it is installed; otherwise the material's
// baseColorFactor is used and the report lists a warning. Draco / meshopt-compressed meshes and sparse accessors are rejected.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as kit from './mega_voxel_kit.mjs';
import * as dif from './mega_diff_utils.mjs';

export const MESH_TO_VOXEL_VERSION = '2.4.0';
const r3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// =============================================================================================== glTF / GLB parsing
const CT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const NORM = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Parse a .glb (binary container) or a .gltf (JSON + relative / data: buffers and images). */
export function parseGltf(file) {
  const buf = fs.readFileSync(file);
  let json = null, bin = null;
  if (buf.length >= 12 && buf.readUInt32LE(0) === 0x46546c67) {
    let off = 12;
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
      const chunk = buf.subarray(off + 8, off + 8 + len);
      if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'));
      else if (type === 0x004e4942) bin = chunk;
      off += 8 + len;
    }
    if (!json) throw new Error(`${path.basename(file)}: GLB without a JSON chunk`);
  } else {
    try { json = JSON.parse(buf.toString('utf8').replace(/^﻿/, '')); } catch { throw new Error(`${path.basename(file)}: not a GLB (magic) and not glTF JSON`); }
  }
  const dir = path.dirname(path.resolve(file));
  const loadUri = (uri) => {
    if (uri.startsWith('data:')) return Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64');
    const rel = decodeURIComponent(uri);
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error(`uri '${uri}' must be relative and stay inside the model folder`);
    return fs.readFileSync(path.join(dir, rel));
  };
  const buffers = (json.buffers || []).map((b, i) => (b.uri === undefined ? (i === 0 && bin ? bin : Buffer.alloc(0)) : loadUri(b.uri)));
  const view = (i) => { const bv = json.bufferViews[i], b = buffers[bv.buffer ?? 0]; return { bytes: b.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength), stride: bv.byteStride || 0 }; };
  function accessor(i, { normalize = true } = {}) {
    const a = json.accessors[i];
    if (a.sparse) throw new Error(`accessor ${i}: sparse accessors are not supported`);
    const n = NC[a.type], T = CT[a.componentType], es = T.BYTES_PER_ELEMENT;
    const out = new Float64Array(a.count * n);
    if (a.bufferView === undefined) return out;
    const { bytes, stride } = view(a.bufferView);
    const dv = new DataView(bytes.buffer, bytes.byteOffset + (a.byteOffset || 0));
    const st = stride || n * es;
    const rd = { 5120: (o) => dv.getInt8(o), 5121: (o) => dv.getUint8(o), 5122: (o) => dv.getInt16(o, true), 5123: (o) => dv.getUint16(o, true), 5125: (o) => dv.getUint32(o, true), 5126: (o) => dv.getFloat32(o, true) }[a.componentType];
    const nm = normalize && a.normalized && NORM[a.componentType];
    for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) { const v = rd(k * st + c * es); out[k * n + c] = nm ? Math.max(v / nm, -1) : v; }
    return out;
  }
  const image = (i) => {
    const im = json.images[i];
    if (im.bufferView !== undefined) return { bytes: Buffer.from(view(im.bufferView).bytes), mime: im.mimeType || 'image/png', name: im.name || `image${i}` };
    if (im.uri) { const bytes = loadUri(im.uri); return { bytes, mime: im.mimeType || (im.uri.startsWith('data:') ? im.uri.slice(5, im.uri.indexOf(';')) : /\.jpe?g$/i.test(im.uri) ? 'image/jpeg' : 'image/png'), name: im.name || `image${i}` }; }
    throw new Error(`image ${i}: no data`);
  };
  return { json, accessor, image, extensionsRequired: json.extensionsRequired || [], extensionsUsed: json.extensionsUsed || [], bytes: buf.length, file };
}
export const parseGLB = parseGltf;

// column-major 4x4 helpers
const I4 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul4(a, b) { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; }
function trs(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = q, x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  return [(1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0, (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0, (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0, t[0], t[1], t[2], 1];
}
const xf = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
function rotAxis(axis, deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), m = I4();
  if (axis === 'x') { m[5] = c; m[6] = s; m[9] = -s; m[10] = c; }
  if (axis === 'y') { m[0] = c; m[2] = -s; m[8] = s; m[10] = c; }
  if (axis === 'z') { m[0] = c; m[1] = s; m[4] = -s; m[5] = c; }
  return m;
}

/** Flatten the default scene: [{ mesh, node, positions (world Float64 xyz), uvs, colors, colorComps, indices Uint32, material }]. */
export function extractPrimitives(G) {
  const { json } = G;
  const out = [];
  const roots = json.scenes ? json.scenes[json.scene ?? 0].nodes : (json.nodes || []).map((_, i) => i);
  const walk = (ni, parent) => {
    const n = json.nodes[ni];
    const world = mul4(parent, n.matrix ? n.matrix.slice() : trs(n.translation, n.rotation, n.scale));
    if (n.mesh !== undefined) {
      const mesh = json.meshes[n.mesh];
      mesh.primitives.forEach((p, pi) => {
        if ((p.mode ?? 4) !== 4) return;
        if (p.extensions && (p.extensions.KHR_draco_mesh_compression || p.extensions.EXT_meshopt_compression)) throw new Error('compressed (Draco / meshopt) primitives are not supported — export an uncompressed .glb');
        const pos = G.accessor(p.attributes.POSITION), vc = pos.length / 3, P = new Float64Array(pos.length);
        for (let k = 0; k < vc; k++) { const w = xf(world, [pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]]); P[k * 3] = w[0]; P[k * 3 + 1] = w[1]; P[k * 3 + 2] = w[2]; }
        const mat = p.material !== undefined ? json.materials[p.material] : null;
        const tcBase = mat && mat.pbrMetallicRoughness && mat.pbrMetallicRoughness.baseColorTexture ? mat.pbrMetallicRoughness.baseColorTexture.texCoord || 0 : 0;
        const uvAcc = p.attributes[`TEXCOORD_${tcBase}`];
        const idx = p.indices !== undefined ? Uint32Array.from(G.accessor(p.indices, { normalize: false })) : Uint32Array.from({ length: vc }, (_, i) => i);
        out.push({ mesh: mesh.name || `mesh${n.mesh}`, prim: pi, node: n.name || `node${ni}`, positions: P, uvs: uvAcc !== undefined ? G.accessor(uvAcc) : null,
          colors: p.attributes.COLOR_0 !== undefined ? G.accessor(p.attributes.COLOR_0) : null, colorComps: p.attributes.COLOR_0 !== undefined ? NC[json.accessors[p.attributes.COLOR_0].type] : 0,
          normals: p.attributes.NORMAL !== undefined, indices: idx, material: p.material ?? null });
      });
    }
    for (const c of n.children || []) walk(c, world);
  };
  for (const r of roots) walk(r, I4());
  return out;
}

// =============================================================================================== textures
const PY_DECODE = "import sys\nfrom PIL import Image\nim=Image.open(sys.argv[1]).convert('RGBA')\nopen(sys.argv[2],'wb').write(im.width.to_bytes(4,'little')+im.height.to_bytes(4,'little')+im.tobytes())\n";
/** PNG natively; anything else via opts.decodeImage(bytes, mime) or (auto / python) Python + Pillow; null when undecodable. */
export function decodeTexture(bytes, mime, opts = {}, warnings = []) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIG)) { const im = dif.decodePNG(bytes); return { w: im.width, h: im.height, data: im.data }; }
  if (typeof opts.decodeImage === 'function') return opts.decodeImage(bytes, mime);
  const mode = opts.imageDecoder || 'auto';
  if (mode === 'none') { warnings.push(`texture ${mime} skipped (--image-decoder none): using baseColorFactor`); return null; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh2vox-img-'));
  try {
    const src = path.join(tmp, 'in.img'), dst = path.join(tmp, 'out.rgba');
    fs.writeFileSync(src, bytes);
    execFileSync(process.env.PYTHON || 'python', ['-I', '-c', PY_DECODE, src, dst], { stdio: ['ignore', 'ignore', 'pipe'] });
    const b = fs.readFileSync(dst);
    return { w: b.readUInt32LE(0), h: b.readUInt32LE(4), data: new Uint8Array(b.buffer, b.byteOffset + 8, b.length - 8) };
  } catch {
    warnings.push(`texture ${mime} could not be decoded (PNG is native; for JPEG / WebP install Python + Pillow or pass decodeImage): using baseColorFactor`);
    return null;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
function materialInfo(G, opts, warnings) {
  const { json } = G;
  const texImage = (ti) => { const t = json.textures[ti]; return t.source ?? (t.extensions && (t.extensions.EXT_texture_webp || t.extensions.KHR_texture_basisu || {}).source); };
  const cache = new Map();
  const tex = (ref) => {
    if (!ref) return null;
    const ii = texImage(ref.index);
    if (ii === undefined) return null;
    if (!cache.has(ii)) { const im = G.image(ii); const d = decodeTexture(im.bytes, im.mime, opts, warnings); cache.set(ii, d ? { ...d, mime: im.mime, image: ii } : null); }
    return cache.get(ii);
  };
  return (json.materials || []).map((m, i) => {
    const pbr = m.pbrMetallicRoughness || {};
    return { index: i, name: m.name || `mat${i}`, baseColorFactor: pbr.baseColorFactor || [1, 1, 1, 1], baseTex: tex(pbr.baseColorTexture),
      emissiveFactor: m.emissiveFactor || [0, 0, 0], emissiveTex: tex(m.emissiveTexture), emissiveStrength: (m.extensions && m.extensions.KHR_materials_emissive_strength && m.extensions.KHR_materials_emissive_strength.emissiveStrength) || 1 };
  });
}
function sampleTex(t, u, v, out) {
  // bilinear, repeat wrap; glTF UV origin = image top-left
  const x = (u - Math.floor(u)) * t.w - 0.5, y = (v - Math.floor(v)) * t.h - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const px = (ix, iy) => (((iy % t.h) + t.h) % t.h) * t.w + (((ix % t.w) + t.w) % t.w);
  const a = px(x0, y0) * 4, b = px(x0 + 1, y0) * 4, c = px(x0, y0 + 1) * 4, d = px(x0 + 1, y0 + 1) * 4, D = t.data;
  for (let k = 0; k < 3; k++) out[k] = ((D[a + k] * (1 - fx) + D[b + k] * fx) * (1 - fy) + (D[c + k] * (1 - fx) + D[d + k] * fx) * fy) / 255;
  return out;
}

/**
 * Load a .glb / .gltf → { file, bytes, json, primitives, materials, triangles, vertices, rawBounds, warnings }.
 * opts: { decodeImage, imageDecoder: 'auto' | 'python' | 'none' }
 */
export function loadGlbMesh(file, opts = {}) {
  const G = parseGltf(file);
  const warnings = [];
  const primitives = extractPrimitives(G), materials = materialInfo(G, opts, warnings);
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  let triangles = 0, vertices = 0;
  for (const p of primitives) { triangles += p.indices.length / 3; vertices += p.positions.length / 3; for (let k = 0; k < p.positions.length; k += 3) for (let c = 0; c < 3; c++) { const v = p.positions[k + c]; if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v; } }
  if (!primitives.length) throw new Error(`${path.basename(file)}: no triangle primitives in the default scene`);
  return { file, bytes: G.bytes, json: G.json, G, primitives, materials, triangles, vertices, rawBounds: { min: mn, max: mx, size: mx.map((v, k) => v - mn[k]) }, warnings };
}

// =============================================================================================== alignment
export function alignmentMatrix(prims, a) {
  let R = I4();
  for (const ax of ['x', 'y', 'z']) if (a[`rot${ax.toUpperCase()}`]) R = mul4(rotAxis(ax, a[`rot${ax.toUpperCase()}`]), R);
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of prims) for (let k = 0; k < p.positions.length; k += 3) {
    const q = xf(R, [p.positions[k], p.positions[k + 1], p.positions[k + 2]]);
    for (let c = 0; c < 3; c++) { if (q[c] < mn[c]) mn[c] = q[c]; if (q[c] > mx[c]) mx[c] = q[c]; }
  }
  const c = a.origin === 'none' ? [0, 0, 0] : mn.map((v, k) => (v + mx[k]) / 2);
  const s = a.lengthY ? a.lengthY / (mx[1] - mn[1]) : 1;
  const T = a.translate || [0, 0, 0];
  const M = mul4([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, T[0] - s * c[0], T[1] - s * c[1], T[2] - s * c[2], 1], R);   // T · S · (−c) · R
  const bmin = mn.map((v, k) => (v - c[k]) * s + T[k]), bmax = mx.map((v, k) => (v - c[k]) * s + T[k]);
  return { M, scale: s, rawRotatedBounds: { min: mn, max: mx }, bounds: { min: bmin, max: bmax, size: bmax.map((v, k) => v - bmin[k]) } };
}
const hasAlign = (o) => !!(o.rotX || o.rotY || o.rotZ || o.lengthY || o.translate);

// =============================================================================================== CPU raster views (no browser)
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vnorm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
/** orbit direction in the asset frame: az 0 = camera on the +Y (forward) axis, −90 on −X, +90 on +X; el + above */
export const orbitDir = (az, el) => { const d = Math.PI / 180; return [Math.sin(az * d) * Math.cos(el * d), Math.cos(az * d) * Math.cos(el * d), Math.sin(el * d)]; };
export const RAW_VIEWS = Object.freeze([
  { label: 'FRONT (+Z GLTF)', dir: [0, 0, 1], ortho: true }, { label: 'BACK (-Z)', dir: [0, 0, -1], ortho: true }, { label: 'LEFT (-X)', dir: [-1, 0, 0], ortho: true },
  { label: 'RIGHT (+X)', dir: [1, 0, 0], ortho: true }, { label: 'TOP (+Y)', dir: [0, 1, 0], up: [0, 0, -1], ortho: true }, { label: 'HERO 3/4', dir: [0.75, 0.45, 1], fov: 30 },
]);
export const ASSET_VIEWS = Object.freeze([
  { label: 'FRONT (+Y)', dir: [0, 1, 0], ortho: true }, { label: 'BACK (-Y)', dir: [0, -1, 0], ortho: true }, { label: 'LEFT (-X)', dir: [-1, 0, 0], ortho: true },
  { label: 'RIGHT (+X)', dir: [1, 0, 0], ortho: true }, { label: 'TOP (+Z)', dir: [0, 0, 1], up: [0, 1, 0], ortho: true }, { label: 'HERO 3/4 (AZ -40 EL 17)', dir: orbitDir(-40, 17), fov: 24 },
]);

/**
 * Rasterise views of a loaded model on the CPU (z-buffer, two-sided Lambert + hemisphere fill, textures / vertex colours /
 * factors, emissive add) into one PNG sheet. cfg: { width, height, cols, rows, views[], up, align (4x4), title, titleH, bg,
 * clay, ss (supersampling, default 2), grid } → { png, width, height, triangles, drawnTriangles }
 */
export function renderModelViews(model, outPng, cfg) {
  const W = cfg.width, H = cfg.height, cols = cfg.cols || 1, rows = cfg.rows || 1, top = cfg.titleH || 0, ss = Math.max(1, cfg.ss ?? 2);
  const cw = Math.floor(W / cols), ch = Math.floor((H - top) / rows);
  const M = cfg.align || I4();
  const bgc = kit.hexToRgb(cfg.bg || '#0e1520');
  const img = dif.createImage(W, H, [Math.round(bgc[0] * 255), Math.round(bgc[1] * 255), Math.round(bgc[2] * 255), 255]);
  // world positions + bounds
  const prims = model.primitives.map((p) => { const P = new Float64Array(p.positions.length); for (let k = 0; k < P.length; k += 3) { const q = xf(M, [p.positions[k], p.positions[k + 1], p.positions[k + 2]]); P[k] = q[0]; P[k + 1] = q[1]; P[k + 2] = q[2]; } return { ...p, W: P }; });
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of prims) for (let k = 0; k < p.W.length; k += 3) for (let c = 0; c < 3; c++) { const v = p.W[k + c]; if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v; }
  const center = mn.map((v, k) => (v + mx[k]) / 2);
  const corners = []; for (let c = 0; c < 8; c++) corners.push([c & 1 ? mx[0] : mn[0], c & 2 ? mx[1] : mn[1], c & 4 ? mx[2] : mn[2]]);
  const keyL = vnorm(cfg.keyDir || [-0.45, 0.35, 0.82]);
  const upW = cfg.up || [0, 1, 0];
  let drawn = 0;
  const col = [0, 0, 0], ecol = [0, 0, 0];
  cfg.views.forEach((v, vi) => {
    const cx0 = (vi % cols) * cw, cy0 = top + Math.floor(vi / cols) * ch;
    const RW = cw * ss, RH = ch * ss;
    const zb = new Float64Array(RW * RH).fill(-Infinity), cb = new Float32Array(RW * RH * 3), hit = new Uint8Array(RW * RH);
    const dir = vnorm(v.dir), up = v.up || upW, target = v.target || center;
    const fwd = [-dir[0], -dir[1], -dir[2]], right = vnorm(vcross(fwd, up)), upv = vcross(right, fwd);
    const asp = cw / ch;
    let project;
    if (v.ortho) {
      let ex = 0, ey = 0;
      for (const p of corners) { const d = vsub(p, target); ex = Math.max(ex, Math.abs(vdot(d, right))); ey = Math.max(ey, Math.abs(vdot(d, upv))); }
      const m = v.fit || 1.08; let hw = ex * m, hh = ey * m; if (hw / hh > asp) hh = hw / asp; else hw = hh * asp;
      project = (p, o) => { const d = [p[0] - target[0], p[1] - target[1], p[2] - target[2]]; o[0] = (vdot(d, right) / hw * 0.5 + 0.5) * RW; o[1] = (0.5 - vdot(d, upv) / hh * 0.5) * RH; o[2] = vdot(d, dir); return true; };
    } else {
      const fov = v.fov || 24, tv = Math.tan((fov * Math.PI) / 360), th = tv * asp, fit = v.fit || 1.04;
      const ok = (dd) => corners.every((p) => { const q = vsub(p, target); const z = dd - vdot(q, dir); return z > 1e-6 && Math.abs(vdot(q, right)) / z <= th * fit && Math.abs(vdot(q, upv)) / z <= tv * fit; });
      let lo = 1e-6, hi = 1e9; for (let k = 0; k < 80; k++) { const m = (lo + hi) / 2; if (ok(m)) hi = m; else lo = m; }
      const dist = v.dist || hi, near = dist / 200;
      project = (p, o) => { const d = [p[0] - target[0], p[1] - target[1], p[2] - target[2]]; const z = dist - vdot(d, dir); if (z < near) return false; o[0] = (vdot(d, right) / (z * th) * 0.5 + 0.5) * RW; o[1] = (0.5 - vdot(d, upv) / (z * tv) * 0.5) * RH; o[2] = 1 / z; return true; };
    }
    const lightL = v.keyDir ? vnorm(v.keyDir) : keyL;
    const A = [0, 0, 0], B = [0, 0, 0], C = [0, 0, 0];
    for (const p of prims) {
      const mat = p.material !== null ? model.materials[p.material] : null;
      const bf = mat ? mat.baseColorFactor : [1, 1, 1, 1], ef = mat ? mat.emissiveFactor : [0, 0, 0], es = mat ? mat.emissiveStrength : 1;
      const P = p.W, idx = p.indices, UV = p.uvs;
      for (let t = 0; t < idx.length; t += 3) {
        const ia = idx[t], ib = idx[t + 1], ic = idx[t + 2];
        const pa = [P[ia * 3], P[ia * 3 + 1], P[ia * 3 + 2]], pb = [P[ib * 3], P[ib * 3 + 1], P[ib * 3 + 2]], pc = [P[ic * 3], P[ic * 3 + 1], P[ic * 3 + 2]];
        if (!project(pa, A) || !project(pb, B) || !project(pc, C)) continue;
        const area = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
        if (Math.abs(area) < 1e-12) continue;
        let n = vnorm(vcross(vsub(pb, pa), vsub(pc, pa)));
        if (vdot(n, dir) < 0) n = [-n[0], -n[1], -n[2]];   // two-sided: face the camera
        const lam = Math.max(0, vdot(n, lightL)), hemi = 0.5 + 0.5 * vdot(n, upW);
        const shade = 0.30 + 0.62 * lam + 0.16 * hemi;
        const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]))), x1 = Math.min(RW - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
        const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]))), y1 = Math.min(RH - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
        if (x0 > x1 || y0 > y1) continue;
        drawn++;
        const inv = 1 / area;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const px = x + 0.5, py = y + 0.5;
          const w0 = ((B[0] - px) * (C[1] - py) - (B[1] - py) * (C[0] - px)) * inv, w1 = ((C[0] - px) * (A[1] - py) - (C[1] - py) * (A[0] - px)) * inv, w2 = 1 - w0 - w1;
          if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
          const z = w0 * A[2] + w1 * B[2] + w2 * C[2], k = y * RW + x;
          if (z <= zb[k]) continue;
          zb[k] = z; hit[k] = 1;
          if (cfg.clay) { col[0] = 0.72; col[1] = 0.69; col[2] = 0.64; ecol[0] = ecol[1] = ecol[2] = 0; }
          else {
            if (mat && mat.baseTex && UV) sampleTex(mat.baseTex, UV[ia * 2] * w0 + UV[ib * 2] * w1 + UV[ic * 2] * w2, UV[ia * 2 + 1] * w0 + UV[ib * 2 + 1] * w1 + UV[ic * 2 + 1] * w2, col);
            else if (p.colors) { const nc = p.colorComps; for (let q = 0; q < 3; q++) col[q] = p.colors[ia * nc + q] * w0 + p.colors[ib * nc + q] * w1 + p.colors[ic * nc + q] * w2; }
            else col[0] = col[1] = col[2] = 1;
            for (let q = 0; q < 3; q++) col[q] *= bf[q];
            if (mat && mat.emissiveTex && UV) { sampleTex(mat.emissiveTex, UV[ia * 2] * w0 + UV[ib * 2] * w1 + UV[ic * 2] * w2, UV[ia * 2 + 1] * w0 + UV[ib * 2 + 1] * w1 + UV[ic * 2 + 1] * w2, ecol); for (let q = 0; q < 3; q++) ecol[q] *= ef[q] * es; }
            else for (let q = 0; q < 3; q++) ecol[q] = ef[q] * es;
          }
          cb[k * 3] = col[0] * shade + ecol[0]; cb[k * 3 + 1] = col[1] * shade + ecol[1]; cb[k * 3 + 2] = col[2] * shade + ecol[2];
        }
      }
    }
    // resolve the supersampled cell into the sheet
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const k = (y * ss + sy) * RW + x * ss + sx;
        if (hit[k]) { r += cb[k * 3]; g += cb[k * 3 + 1]; b += cb[k * 3 + 2]; } else { r += bgc[0]; g += bgc[1]; b += bgc[2]; }
      }
      const o = ((cy0 + y) * W + cx0 + x) * 4, n2 = ss * ss;
      img.data[o] = Math.round(clamp(r / n2, 0, 1) * 255); img.data[o + 1] = Math.round(clamp(g / n2, 0, 1) * 255); img.data[o + 2] = Math.round(clamp(b / n2, 0, 1) * 255); img.data[o + 3] = 255;
    }
    if (cfg.grid) dif.strokeRect(img, cx0, cy0, cw, ch, [58, 69, 88, 255], 2);
    if (v.label) { dif.fillRect(img, cx0 + 6, cy0 + 6, dif.textWidth(v.label, 2) + 12, 22, [8, 12, 20, 255]); dif.drawText(img, cx0 + 12, cy0 + 12, v.label, [255, 214, 107, 255], 2); }
  });
  if (cfg.title && top) { dif.fillRect(img, 0, 0, W, top, [10, 15, 24, 255]); dif.drawText(img, 10, Math.max(4, Math.floor((top - 10) / 2)), cfg.title, [232, 236, 244, 255], 2); }
  fs.mkdirSync(path.dirname(path.resolve(outPng)), { recursive: true });
  dif.writePNG(outPng, img);
  return { png: outPng, width: W, height: H, triangles: model.triangles, drawnTriangles: drawn, bounds: { min: mn, max: mx } };
}

// =============================================================================================== voxelization core
function triBoxOverlap(bc, h, a, b, c) {
  // Akenine-Möller SAT, box centre bc, half size h (scalar), triangle a b c
  const v0 = [a[0] - bc[0], a[1] - bc[1], a[2] - bc[2]], v1 = [b[0] - bc[0], b[1] - bc[1], b[2] - bc[2]], v2 = [c[0] - bc[0], c[1] - bc[1], c[2] - bc[2]];
  const r0 = h + 1e-9;
  for (let k = 0; k < 3; k++) { const mn = Math.min(v0[k], v1[k], v2[k]), mx = Math.max(v0[k], v1[k], v2[k]); if (mn > r0 || mx < -r0) return false; }
  const E = [[v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]], [v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2]], [v0[0] - v2[0], v0[1] - v2[1], v0[2] - v2[2]]];
  for (const e of E) {
    for (const ax of [[0, -e[2], e[1]], [e[2], 0, -e[0]], [-e[1], e[0], 0]]) {
      const p0 = ax[0] * v0[0] + ax[1] * v0[1] + ax[2] * v0[2], p1 = ax[0] * v1[0] + ax[1] * v1[1] + ax[2] * v1[2], p2 = ax[0] * v2[0] + ax[1] * v2[1] + ax[2] * v2[2];
      const r = h * (Math.abs(ax[0]) + Math.abs(ax[1]) + Math.abs(ax[2])) + 1e-9;
      if (Math.min(p0, p1, p2) > r || Math.max(p0, p1, p2) < -r) return false;
    }
  }
  const n = [E[0][1] * E[1][2] - E[0][2] * E[1][1], E[0][2] * E[1][0] - E[0][0] * E[1][2], E[0][0] * E[1][1] - E[0][1] * E[1][0]];
  const d = -(n[0] * v0[0] + n[1] * v0[1] + n[2] * v0[2]);
  return Math.abs(d) <= h * (Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2])) + 1e-9;
}
function closestBary(p, a, b, c) {
  // Ericson, Real-Time Collision Detection 5.1.5 → barycentric (u, v, w) of the closest point on triangle abc to p
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const d1 = vdot(ab, ap), d2 = vdot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return [1, 0, 0];
  const bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]], d3 = vdot(ab, bp), d4 = vdot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return [0, 1, 0];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [1 - v, v, 0]; }
  const cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]], d5 = vdot(ab, cp), d6 = vdot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return [0, 0, 1];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [1 - w, 0, w]; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return [0, 1 - w, w]; }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return [1 - v - w, v, w];
}

/**
 * Conservative (SAT) surface voxelization with barycentric-lattice colour sampling.
 * → { nx, ny, nz, gridMin (u), center (voxel coords of the asset origin), occ Uint8Array, slotOf Map(cell → slot),
 *     acc Float64Array(slot*8: r g b er eg eb w samples), stats }
 */
export function voxelizeSurface(prims, mats, M, bounds, { voxelScale, margin = 3, symmetricX = true } = {}) {
  const vs = voxelScale;
  const lo = bounds.min.map((v) => Math.floor(v / vs) - margin), hi = bounds.max.map((v) => Math.ceil(v / vs) + margin);
  if (symmetricX) { const m = Math.max(-lo[0], hi[0]); lo[0] = -m; hi[0] = m; }
  const nx = hi[0] - lo[0], ny = hi[1] - lo[1], nz = hi[2] - lo[2];
  const gridMin = lo.map((v) => v * vs), center = lo.map((v) => -v);
  const occ = new Uint8Array(nx * ny * nz);
  const slotOf = new Map();
  let acc = new Float64Array(1 << 16), slots = 0;
  const slot = (cell) => {
    let s = slotOf.get(cell);
    if (s === undefined) { s = slots++; slotOf.set(cell, s); if (s * 8 + 8 > acc.length) { const b = new Float64Array(acc.length * 2); b.set(acc); acc = b; } }
    return s;
  };
  const col = [0, 0, 0], ecol = [0, 0, 0];
  let tris = 0, samples = 0, fallbacks = 0;
  for (const p of prims) {
    const mat = p.material !== null ? mats[p.material] : null;
    const bf = mat ? mat.baseColorFactor : [1, 1, 1, 1], ef = mat ? mat.emissiveFactor : [0, 0, 0], es = mat ? mat.emissiveStrength : 1;
    const P = p.positions, UV = p.uvs, idx = p.indices;
    const vc = P.length / 3, V = new Float64Array(vc * 3);
    for (let k = 0; k < vc; k++) { const q = xf(M, [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]]); V[k * 3] = (q[0] - gridMin[0]) / vs; V[k * 3 + 1] = (q[1] - gridMin[1]) / vs; V[k * 3 + 2] = (q[2] - gridMin[2]) / vs; }
    const shade = (ia, ib, ic, u, v, w, out, eout) => {
      if (mat && mat.baseTex && UV) sampleTex(mat.baseTex, UV[ia * 2] * u + UV[ib * 2] * v + UV[ic * 2] * w, UV[ia * 2 + 1] * u + UV[ib * 2 + 1] * v + UV[ic * 2 + 1] * w, out);
      else if (p.colors) { const n = p.colorComps; for (let k = 0; k < 3; k++) out[k] = p.colors[ia * n + k] * u + p.colors[ib * n + k] * v + p.colors[ic * n + k] * w; }
      else out[0] = out[1] = out[2] = 1;
      for (let k = 0; k < 3; k++) out[k] *= bf[k];
      if (mat && mat.emissiveTex && UV) { sampleTex(mat.emissiveTex, UV[ia * 2] * u + UV[ib * 2] * v + UV[ic * 2] * w, UV[ia * 2 + 1] * u + UV[ib * 2 + 1] * v + UV[ic * 2 + 1] * w, eout); for (let k = 0; k < 3; k++) eout[k] *= ef[k] * es; }
      else for (let k = 0; k < 3; k++) eout[k] = ef[k] * es;
    };
    const add = (cell, wgt) => { const s = slot(cell) * 8; acc[s] += col[0] * wgt; acc[s + 1] += col[1] * wgt; acc[s + 2] += col[2] * wgt; acc[s + 3] += ecol[0] * wgt; acc[s + 4] += ecol[1] * wgt; acc[s + 5] += ecol[2] * wgt; acc[s + 6] += wgt; acc[s + 7]++; };
    for (let t = 0; t < idx.length; t += 3) {
      const ia = idx[t], ib = idx[t + 1], ic = idx[t + 2];
      const a = [V[ia * 3], V[ia * 3 + 1], V[ia * 3 + 2]], b = [V[ib * 3], V[ib * 3 + 1], V[ib * 3 + 2]], c = [V[ic * 3], V[ic * 3 + 1], V[ic * 3 + 2]];
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const area = 0.5 * Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]);
      tris++;
      const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(nx - 1, Math.floor(Math.max(a[0], b[0], c[0])));
      const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(ny - 1, Math.floor(Math.max(a[1], b[1], c[1])));
      const z0 = Math.max(0, Math.floor(Math.min(a[2], b[2], c[2]))), z1 = Math.min(nz - 1, Math.floor(Math.max(a[2], b[2], c[2])));
      const cells = [];
      if (x0 === x1 && y0 === y1 && z0 === z1) cells.push(x0 + nx * (y0 + ny * z0));
      else for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (triBoxOverlap([x + 0.5, y + 0.5, z + 0.5], 0.5, a, b, c)) cells.push(x + nx * (y + ny * z));
      if (!cells.length) continue;
      const hit = new Set();
      // colour samples: barycentric lattice with spacing ≤ 0.5 voxel (two sub-triangle centroids per lattice cell)
      const L = Math.max(Math.hypot(...ab), Math.hypot(...ac), Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]));
      const n = Math.max(1, Math.ceil(L / 0.5));
      const wgt = Math.max(area, 1e-6) / (n * n);
      for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) {
        for (const up of (i + j < n - 1 ? [0, 1] : [0])) {
          const u1 = up ? (i + 2 / 3) / n : (i + 1 / 3) / n, v1 = up ? (j + 2 / 3) / n : (j + 1 / 3) / n, w0 = 1 - u1 - v1;
          const px = a[0] * w0 + b[0] * u1 + c[0] * v1, py = a[1] * w0 + b[1] * u1 + c[1] * v1, pz = a[2] * w0 + b[2] * u1 + c[2] * v1;
          const cell = clamp(Math.floor(px), 0, nx - 1) + nx * (clamp(Math.floor(py), 0, ny - 1) + ny * clamp(Math.floor(pz), 0, nz - 1));
          shade(ia, ib, ic, w0, u1, v1, col, ecol);
          add(cell, wgt); hit.add(cell); samples++;
        }
      }
      for (const cell of cells) {
        occ[cell] = 1;
        if (hit.has(cell)) continue;
        // SAT cell with no lattice sample: colour from the closest point on the triangle (light weight)
        const z = Math.floor(cell / (nx * ny)), y = Math.floor((cell - z * nx * ny) / nx), x = cell - nx * (y + ny * z);
        const [u, v, w] = closestBary([x + 0.5, y + 0.5, z + 0.5], a, b, c);
        shade(ia, ib, ic, u, v, w, col, ecol);
        add(cell, wgt * 0.25); fallbacks++;
      }
      for (const cell of hit) occ[cell] = 1;
    }
  }
  return { nx, ny, nz, gridMin, center, occ, slotOf, acc, slots, stats: { tris, samples, fallbacks, surfaceCells: slotOf.size } };
}

/** 6-connected BFS from the grid border through air → exterior; every other air cell is enclosed interior. */
export function floodExterior(occ, nx, ny, nz) {
  const N = nx * ny * nz, ext = new Uint8Array(N), q = new Int32Array(N);
  let h = 0, t = 0;
  const push = (i) => { if (!occ[i] && !ext[i]) { ext[i] = 1; q[t++] = i; } };
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) { push(nx * (y + ny * z)); push(nx - 1 + nx * (y + ny * z)); }
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) { push(x + nx * ny * z); push(x + nx * (ny - 1 + ny * z)); }
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { push(x + nx * y); push(x + nx * (y + ny * (nz - 1))); }
  const nxy = nx * ny;
  while (h < t) {
    const i = q[h++], z = Math.floor(i / nxy), r = i - z * nxy, y = Math.floor(r / nx), x = r - y * nx;
    if (x > 0) push(i - 1); if (x < nx - 1) push(i + 1); if (y > 0) push(i - nx); if (y < ny - 1) push(i + nx); if (z > 0) push(i - nxy); if (z < nz - 1) push(i + nxy);
  }
  return ext;
}

// =============================================================================================== colour science
const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function rgb2lab(r, g, b) {
  const R = s2l(r), G = s2l(g), B = s2l(b);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
export function rgb2hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-9) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, mx > 0 ? d / mx : 0, mx];
}
export function hsv2rgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}
const inRange = (v, r) => !r || (v >= r[0] && v <= r[1]);
const hueIn = (h, r) => !r || (r[0] <= r[1] ? h >= r[0] && h <= r[1] : h >= r[0] || h <= r[1]);
export const ruleMatch = (rule, hsv) => hueIn(hsv[0], rule.hue) && inRange(hsv[1], rule.sat) && inRange(hsv[2], rule.val);
const hex = (rgb) => '#' + rgb.map((c) => Math.round(clamp(c, 0, 1) * 255).toString(16).padStart(2, '0')).join('');
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Weighted k-means in Lab over 5-bit RGB bins (deterministic k-means++ seed). binW: Map(bin → w) → { centers, assign } */
function kmeansBins(binW, K, seed = 23) {
  const bins = [...binW.keys()].sort((a, b) => a - b);
  if (!bins.length) return { centers: [], assign: new Map() };
  const rgbOf = (bin) => [((bin >> 10) & 31) / 31, ((bin >> 5) & 31) / 31, (bin & 31) / 31];
  const labs = bins.map((b) => rgb2lab(...rgbOf(b))), ws = bins.map((b) => binW.get(b));
  K = Math.min(K, bins.length);
  const rnd = mulberry32(seed), d2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
  let heaviest = 0; for (let i = 1; i < bins.length; i++) if (ws[i] > ws[heaviest]) heaviest = i;
  const C = [labs[heaviest].slice()];
  const dist = labs.map((l) => d2(l, C[0]));
  while (C.length < K) {
    let tot = 0; for (let i = 0; i < bins.length; i++) tot += dist[i] * ws[i];
    let r = rnd() * tot, pick = bins.length - 1;
    for (let i = 0; i < bins.length; i++) { r -= dist[i] * ws[i]; if (r <= 0) { pick = i; break; } }
    C.push(labs[pick].slice());
    for (let i = 0; i < bins.length; i++) dist[i] = Math.min(dist[i], d2(labs[i], C[C.length - 1]));
  }
  const as = new Int32Array(bins.length);
  for (let it = 0; it < 24; it++) {
    let moved = 0;
    for (let i = 0; i < bins.length; i++) { let best = 0, bd = Infinity; for (let k = 0; k < C.length; k++) { const d = d2(labs[i], C[k]); if (d < bd) { bd = d; best = k; } } if (as[i] !== best) { as[i] = best; moved++; } }
    const S = C.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < bins.length; i++) { const s = S[as[i]]; s[0] += labs[i][0] * ws[i]; s[1] += labs[i][1] * ws[i]; s[2] += labs[i][2] * ws[i]; s[3] += ws[i]; }
    S.forEach((s, k) => { if (s[3] > 0) C[k] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
    if (!moved && it > 0) break;
  }
  const centers = C.map(() => ({ rgbSum: [0, 0, 0], w: 0 }));
  for (let i = 0; i < bins.length; i++) { const c = centers[as[i]], rgb = rgbOf(bins[i]); c.rgbSum[0] += rgb[0] * ws[i]; c.rgbSum[1] += rgb[1] * ws[i]; c.rgbSum[2] += rgb[2] * ws[i]; c.w += ws[i]; }
  return { centers: centers.map((c, k) => ({ rgb: c.w ? c.rgbSum.map((v) => v / c.w) : [0, 0, 0], lab: C[k], w: c.w })), assign: new Map(bins.map((b, i) => [b, as[i]])) };
}

// =============================================================================================== multi-part splitting
/**
 * Label-masked twin of the kit's greedyQuad16Part: identical merge rules, record layout and corner micro AO, but the cell
 * filter is a per-voxel part label (labels[vi] === part) instead of a box region. Exposure, micro AO, convex / crease tests
 * and the macro AO still see the WHOLE unified grid, so a face between two parts is never emitted (the parts stay welded) and
 * the shading has no seam. With every label equal to `part` the output is byte-identical to greedyQuad16Part
 * (selfTestMaskedQuad16). Signature: greedyQuad16Masked(grid, palette, labels, part, opts).
 */
export function greedyQuad16Masked(grid, palette, labels, part, opts = {}) {
  if (grid && typeof grid.greedyQuad16Part === 'function') return greedyQuad16Masked(palette, labels, part, opts, arguments[5]);   // legacy (kit, …) call form
  const { voxelScale = 1, center = [0, 0, 0], macroAo = null, macroLevels = 8, name = 'part' } = opts;
  const MS = Math.max(1, Math.min(255, Math.floor(opts.maxQuadSize ?? 255)));
  if (!(Number.isInteger(macroLevels) && macroLevels >= 2 && macroLevels <= 256)) throw new Error('greedyQuad16Masked: macroLevels must be an integer 2..256');
  if (macroAo && (macroAo.nx !== grid.nx || macroAo.ny !== grid.ny || macroAo.nz !== grid.nz)) throw new Error('greedyQuad16Masked: macroAo was baked for a different grid');
  if (!labels || labels.length !== grid.pal.length) throw new Error('greedyQuad16Masked: labels must have one entry per voxel');
  const N = [grid.nx, grid.ny, grid.nz], off = grid.offset || [0, 0, 0], nx = grid.nx, nxy = grid.nx * grid.ny;
  if (Math.max(...N) > 65535) throw new Error('greedyQuad16Masked: grid axis > 65535 voxels (Uint16 origin)');
  const pal = grid.pal, flg = grid.flags, pan = grid.panel, MAT_MASK = kit.MAT_MASK;
  const solid = (p) => p[0] >= 0 && p[1] >= 0 && p[2] >= 0 && p[0] < N[0] && p[1] < N[1] && p[2] < N[2] && pal[p[0] + nx * p[1] + nxy * p[2]] !== 0;
  const gridOrigin = [0, 1, 2].map((k) => (off[k] - center[k]) * voxelScale);
  const q8f = (x) => Math.round(clamp(Math.fround(x), 0, 1) * 255);
  const AXES = [[0, 1, 2], [1, 2, 0], [2, 0, 1]];
  const recs = [];
  let exposed = 0, voxels = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] === part && pal[i]) voxels++;
  const lmin = [Infinity, Infinity, Infinity], lmax = [-Infinity, -Infinity, -Infinity];
  const c = [0, 0, 0], q = [0, 0, 0], a = [0, 0, 0], b = [0, 0, 0], cc = [0, 0, 0], t3 = [0, 0, 0];
  const convexAt = (d, u, v, i, s, U, V) => {
    let air = 0;
    for (let k = 0; k < 4; k++) {
      t3[d] = i; t3[u] = U - 1 + (k & 1); t3[v] = V - 1 + (k >> 1);
      if (!solid(t3)) air++;
      t3[d] = i + s;
      if (solid(t3)) return false;
    }
    return air > 0;
  };
  const P8 = 256, P16 = 65536, P24 = 16777216, P28 = 268435456, P29 = 536870912;
  for (const [d, u, v] of AXES) {
    const nu = N[u], nv = N[v];
    const mask = new Float64Array(nu * nv);
    for (const s of [1, -1]) {
      const f = d * 2 + (s > 0 ? 0 : 1);
      for (let i = 0; i < N[d]; i++) {
        mask.fill(0);
        for (let jv = 0; jv < nv; jv++) for (let ju = 0; ju < nu; ju++) {
          c[d] = i; c[u] = ju; c[v] = jv;
          const vi = c[0] + nx * c[1] + nxy * c[2];
          const pi = pal[vi];
          if (!pi || labels[vi] !== part) continue;
          q[0] = c[0]; q[1] = c[1]; q[2] = c[2]; q[d] += s;
          if (solid(q)) continue;
          exposed++;
          let aoBits = 0;
          for (let k = 0; k < 4; k++) {
            const du = k & 1 ? 1 : -1, dv = k & 2 ? 1 : -1;
            a[0] = q[0]; a[1] = q[1]; a[2] = q[2]; a[u] += du;
            b[0] = q[0]; b[1] = q[1]; b[2] = q[2]; b[v] += dv;
            cc[0] = q[0]; cc[1] = q[1]; cc[2] = q[2]; cc[u] += du; cc[v] += dv;
            const s1 = solid(a) ? 1 : 0, s2 = solid(b) ? 1 : 0, s3 = solid(cc) ? 1 : 0;
            aoBits |= (s1 && s2 ? 0 : 3 - (s1 + s2 + s3)) << (2 * k);
          }
          const ml = macroAo ? Math.round((macroAo.data[vi * 6 + f] / 255) * (macroLevels - 1)) : macroLevels - 1;
          const mat = (flg[vi] & MAT_MASK) || palette.tag(pi);
          mask[ju + jv * nu] = pi + aoBits * P8 + ml * P16 + mat * P24 + P28 + (pan ? pan[vi] * P29 : 0);
        }
        for (let jv = 0; jv < nv; jv++) for (let ju = 0; ju < nu;) {
          const key = mask[ju + jv * nu];
          if (!key) { ju++; continue; }
          const aoBits = Math.floor(key / P8) % 256;
          const a00 = aoBits & 3, a10 = (aoBits >> 2) & 3, a01 = (aoBits >> 4) & 3, a11 = (aoBits >> 6) & 3;
          const canU = a00 === a10 && a01 === a11, canV = a00 === a01 && a10 === a11;
          let w = 1;
          if (canU) while (ju + w < nu && w < MS && mask[ju + w + jv * nu] === key) w++;
          let h = 1;
          if (canV) {
            outer: while (jv + h < nv && h < MS) {
              for (let k = 0; k < w; k++) if (mask[ju + k + (jv + h) * nu] !== key) break outer;
              h++;
            }
          }
          for (let y2 = 0; y2 < h; y2++) for (let x2 = 0; x2 < w; x2++) mask[ju + x2 + (jv + y2) * nu] = 0;
          const palI = key % 256, ml = Math.floor(key / P16) % 256, mat = Math.floor(key / P24) % 16, pid = Math.floor(key / P29);
          const plane = i + (s > 0 ? 1 : 0);
          const origin = [0, 0, 0]; origin[d] = plane; origin[u] = ju; origin[v] = jv;
          const narrow = Math.min(w, h) <= 2, ao = [a00, a10, a01, a11];
          let nA = 0, nB = 0;
          for (let k = 0; k < 4; k++) if (ao[k] === 3) { nA++; if (narrow && convexAt(d, u, v, i, s, ju + (k & 1) * w, jv + (k >> 1) * h)) nB++; }
          const e = palette.entry(palI);
          recs.push({
            origin, du: w, dv: h, dir: f, rgb: e.rgb.map(q8f), em: q8f(e.em),
            bevelQ: nA ? Math.round((3 * nB) / nA) : 0, creaseQ: narrow && ao.some((x) => x < 3) ? 3 : 0, diagFlip: a00 + a11 < a10 + a01 ? 1 : 0,
            ao, macroAo: Math.round((ml / (macroLevels - 1)) * 255), matTag: mat & 15, panelId: pid & 15,
          });
          for (let k = 0; k < 3; k++) { const hi = origin[k] + (k === u ? w : k === v ? h : 0); if (origin[k] < lmin[k]) lmin[k] = origin[k]; if (hi > lmax[k]) lmax[k] = hi; }
          ju += w;
        }
      }
    }
  }
  const n = recs.length;
  return {
    name, format: 'QUAD16', bytes: kit.packQuad16(recs), quadCount: n, quads: n, triangles: n * 2, exposedFaces: exposed, reduction: exposed ? 1 - n / exposed : 0,
    voxels, dims: N.slice(), voxelScale, center: center.slice(), gridOrigin, macroLevels,
    bounds: n ? { min: lmin.map((l, k) => gridOrigin[k] + l * voxelScale), max: lmax.map((l, k) => gridOrigin[k] + l * voxelScale) } : { min: [0, 0, 0], max: [0, 0, 0] },
  };
}

/** greedyQuad16Masked with one all-covering label must equal the kit's greedyQuad16Part byte for byte; a 2-way split must
 *  conserve the exposed-face count (faces between the halves are never emitted). */
export function selfTestMaskedQuad16() {
  const { VoxelGrid, MegaPalette, bakeMacroCavityAO, greedyQuad16Part } = kit;
  const g = new VoxelGrid(24, 20, 16), pal = new MegaPalette();
  const A = pal.add('a', '#c09060', { matTag: 0 }), B = pal.add('b', '#403070', { matTag: 6 }), E = pal.add('e', '#b0f020', { emissive: 0.8, matTag: 8 });
  for (let z = 2; z < 14; z++) for (let y = 2; y < 18; y++) for (let x = 2; x < 22; x++) {
    const r = Math.hypot((x - 12) / 9, (y - 10) / 7, (z - 7) / 5);
    if (r < 1) g.pal[x + 24 * (y + 20 * z)] = r < 0.55 ? E : (x + y + z) % 5 ? B : A;
  }
  const ao = bakeMacroCavityAO(g, { rays: 12, maxDist: 8 });
  const opts = { voxelScale: 2, center: [12, 10, 7], macroAo: ao, macroLevels: 16 };
  const ref = greedyQuad16Part(g, pal, opts);
  const lab = new Uint8Array(g.pal.length);
  const got = greedyQuad16Masked(g, pal, lab, 0, opts);
  const same = ref.quadCount === got.quadCount && Buffer.compare(Buffer.from(ref.bytes), Buffer.from(got.bytes)) === 0;
  for (let i = 0; i < lab.length; i++) lab[i] = (i % 24) >= 12 ? 1 : 0;
  const h0 = greedyQuad16Masked(g, pal, lab, 0, opts), h1 = greedyQuad16Masked(g, pal, lab, 1, opts);
  return { identical: same, quads: ref.quadCount, split: [h0.quadCount, h1.quadCount], exposed: [ref.exposedFaces, h0.exposedFaces + h1.exposedFaces], exposedConserved: ref.exposedFaces === h0.exposedFaces + h1.exposedFaces };
}

/**
 * Parse a part spec  name:kind:clauses[:wave=amp,freq,originY][:axis=ellipsoid|box:cx,cy,cz:rx,ry,rz | :axis=box:auto][:cc=minVoxels]
 * clauses (all must hold; asset-local u of the voxel centre): x|y|z|ax|ay|az (ax = |x|) with < <= > >= and a number, joined by ','
 * — e.g. "tentacles:wave:z<-60,ax>95:wave=16,0.012,0:axis=box:auto:cc=400".
 */
export function parseSplitPart(spec) {
  const [name, kind, clauses, ...rest] = String(spec).split(':');
  if (!name || !kind || !clauses) throw new Error(`--split-part ${spec}: expected name:kind:clauses`);
  const conds = clauses.split(',').map((c) => {
    const m = /^(ax|ay|az|x|y|z)(<=|>=|<|>)(-?\d+(?:\.\d+)?)$/.exec(c.trim());
    if (!m) throw new Error(`--split-part ${spec}: bad clause '${c}'`);
    const k = { x: 0, y: 1, z: 2, ax: 0, ay: 1, az: 2 }[m[1]], abs = m[1].length === 2, v = +m[3];
    const get = abs ? (p) => Math.abs(p[k]) : (p) => p[k];
    return { '<': (p) => get(p) < v, '<=': (p) => get(p) <= v, '>': (p) => get(p) > v, '>=': (p) => get(p) >= v }[m[2]];
  });
  const part = { name, kind, test: (x, y, z) => { const p = [x, y, z]; return conds.every((f) => f(p)); } };
  for (let i = 0; i < rest.length; i++) {
    const r = rest[i];
    if (r.startsWith('wave=')) { const [a, f, o] = r.slice(5).split(',').map(Number); Object.assign(part, { waveAmp: a, waveFreq: f, waveOriginY: o || 0 }); }
    else if (r.startsWith('cc=')) part.minComponent = +r.slice(3);
    else if (r === 'axis=ellipsoid' || r === 'axis=box') {
      part.waveAxis = r.slice(5);
      if (rest[i + 1] === 'auto') { part.waveCenter = 'auto'; i++; } else { part.waveCenter = rest[++i].split(',').map(Number); part.waveRadii = rest[++i].split(',').map(Number); }
    } else throw new Error(`--split-part ${spec}: unknown option '${r}'`);
  }
  return part;
}

/**
 * Root-junction anchor of split part k: bounding box (asset-local u, voxel cubes + `margin` voxels) of its voxels that touch a
 * solid voxel of another part (6-neighbourhood) → { center, halfExtents, voxels } | null. A wave part anchored on this box
 * (uWaveMode 'box' → shader distance outside the box; 'ellipsoid' → radii = half · √3 so the box corners are inside) is
 * exactly static where it is welded to the rest of the structure.
 */
export function computeJunctionBox(grid, labels, k, { voxelScale: vs, center: C, margin = 2 }) {
  const { nx, ny, nz } = grid, nxy = nx * ny;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  let n = 0;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = x + nx * (y + ny * z);
    if (labels[i] !== k || !grid.pal[i]) continue;
    const nb = [x > 0 ? i - 1 : -1, x < nx - 1 ? i + 1 : -1, y > 0 ? i - nx : -1, y < ny - 1 ? i + nx : -1, z > 0 ? i - nxy : -1, z < nz - 1 ? i + nxy : -1];
    if (!nb.some((q) => q >= 0 && grid.pal[q] && labels[q] !== k)) continue;
    n++;
    const c = [x, y, z];
    for (let a = 0; a < 3; a++) { if (c[a] < mn[a]) mn[a] = c[a]; if (c[a] + 1 > mx[a]) mx[a] = c[a] + 1; }
  }
  if (!n) return null;
  const lo = mn.map((v, a) => (v - margin - C[a]) * vs), hi = mx.map((v, a) => (v + margin - C[a]) * vs);
  return { center: lo.map((v, a) => r3((v + hi[a]) / 2)), halfExtents: lo.map((v, a) => r3((hi[a] - v) / 2)), voxels: n };
}
export const junctionBox = computeJunctionBox;

/**
 * Label every solid voxel with a part index (0 = the base part, k = splitParts[k−1]).
 * splitParts: [{ name, kind, test(x, y, z, vox, grid) → bool, minComponent? }] and/or partSplitter(x, y, z, vox, grid) → name | null
 * (x y z = asset-local u of the voxel centre, vox = { ix, iy, iz, index, pal }). First match wins. Selected voxels are grouped
 * into 6-connected components per part; components smaller than minComponent fall back to the base part.
 */
export function labelParts(grid, { voxelScale: vs, center: C, splitParts = [], partSplitter = null }) {
  const { nx, ny, nz } = grid, nxy = nx * ny, N = nx * ny * nz, lab = new Uint8Array(N);
  if (splitParts.length > 254) throw new Error('labelParts: at most 254 split parts');
  const names = splitParts.map((p) => p.name);
  const vox = { ix: 0, iy: 0, iz: 0, index: 0, pal: 0 };
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = x + nx * (y + ny * z);
    if (!grid.pal[i]) continue;
    const px = (x + 0.5 - C[0]) * vs, py = (y + 0.5 - C[1]) * vs, pz = (z + 0.5 - C[2]) * vs;
    vox.ix = x; vox.iy = y; vox.iz = z; vox.index = i; vox.pal = grid.pal[i];
    let k = 0;
    if (partSplitter) { const nm = partSplitter(px, py, pz, vox, grid); if (nm) { k = names.indexOf(nm) + 1; if (!k) throw new Error(`partSplitter returned unknown part '${nm}'`); } }
    if (!k) for (let j = 0; j < splitParts.length; j++) if (splitParts[j].test && splitParts[j].test(px, py, pz, vox, grid)) { k = j + 1; break; }
    lab[i] = k;
  }
  const comps = [], seen = new Uint8Array(N), stack = [];
  for (let i = 0; i < N; i++) {
    if (!lab[i] || seen[i]) continue;
    const k = lab[i], minN = splitParts[k - 1].minComponent || 0;
    let n = 0; const cells = [];
    stack.push(i); seen[i] = 1;
    while (stack.length) {
      const j = stack.pop(); n++; cells.push(j);
      const z = Math.floor(j / nxy), r = j - z * nxy, y = Math.floor(r / nx), x = r - y * nx;
      const nb = [x > 0 ? j - 1 : -1, x < nx - 1 ? j + 1 : -1, y > 0 ? j - nx : -1, y < ny - 1 ? j + nx : -1, z > 0 ? j - nxy : -1, z < nz - 1 ? j + nxy : -1];
      for (const q of nb) if (q >= 0 && !seen[q] && lab[q] === k) { seen[q] = 1; stack.push(q); }
    }
    const keep = n >= minN;
    if (!keep) for (const j of cells) lab[j] = 0;
    comps.push({ part: names[k - 1], voxels: n, kept: keep });
  }
  const counts = [0, ...splitParts.map(() => 0)];
  for (let i = 0; i < N; i++) if (grid.pal[i]) counts[lab[i]]++;
  return { labels: lab, counts, components: comps.filter((c) => c.kept).map((c) => ({ part: c.part, voxels: c.voxels })).sort((a, b) => b.voxels - a.voxels), dropped: comps.filter((c) => !c.kept).reduce((s, c) => s + c.voxels, 0) };
}

// =============================================================================================== voxelize pipeline
function readJsonArg(v) { if (!v) return null; if (typeof v === 'object') return v; return fs.existsSync(v) ? JSON.parse(fs.readFileSync(v, 'utf8')) : JSON.parse(v); }
async function resolveModelPath(o) {
  if (o.glb) return o.glb;
  if (o.source) { const ms = await import('./mesh_source.mjs'); return ms.resolveManifestModel(o.source); }
  throw new Error('--glb <file.glb|file.gltf> or --source <mesh_source.json> required');
}

/**
 * GLB / glTF → svox.mega/v2.3 asset. See the header for options. Hooks (all optional, programmatic):
 *   preAoHook(ctx)  edit the final grid AFTER colours / solidify / zone carves and BEFORE the single macro AO bake
 *   mesoHook(ctx) → { prefabs: [...], instances: [...] }   compose packed20 meso prefabs (packMegaAsset's 3rd / 4th arguments)
 *   metaHook(ctx) → object merged into json.meta (derived from the final grid)
 *   partSplitter(x, y, z, vox, grid) → part name | null
 * ctx = { grid, palette, voxelScale, center, interiorIndex, carves, toLocal(ix, iy, iz) → [x, y, z] u }
 * → report + { grid, megaPalette, packed, labels? }
 */
export async function voxelizeGlb(o) {
  const t0 = Date.now();
  const say = (...a) => { if (o.log !== false) (typeof o.log === 'function' ? o.log : console.log)(a.join(' ')); };
  const { MegaPalette, VoxelGrid, bakeMacroCavityAO, packMegaAsset, writeMegaAsset, readMegaAsset, renderPreview, applyDetailZoneCarves, checkPerfBudget, MEGA_V23_BUDGET, KIT_VERSION } = kit;
  if (!o.outAsset) throw new Error('outAsset (--out-asset <base>) required');
  const file = await resolveModelPath(o);
  const model = loadGlbMesh(file, o);
  for (const w of model.warnings) say(`[warn] ${w}`);
  const prims = model.primitives, mats = model.materials;
  const al = alignmentMatrix(prims, o);
  say(`[align] rot ${[o.rotX || 0, o.rotY || 0, o.rotZ || 0].join('/')}° scale ${r3(al.scale)} → bounds ${al.bounds.min.map(Math.round)} .. ${al.bounds.max.map(Math.round)} (size ${al.bounds.size.map(Math.round)})`);
  const vs = o.voxelScale ?? 2.2;
  const S = voxelizeSurface(prims, mats, al.M, al.bounds, { voxelScale: vs, margin: o.margin ?? 3 });
  const { nx, ny, nz, occ, slotOf, acc } = S, nxy = nx * ny, N = nx * ny * nz;
  say(`[voxelize] grid ${nx}x${ny}x${nz} @ ${vs} u/vox · ${S.stats.tris} tris · ${S.stats.surfaceCells} surface cells · ${S.stats.samples} samples (${S.stats.fallbacks} closest-point fallbacks)`);

  // ---- solidify (outside-air flood fill)
  let interiorCells = 0;
  if (o.solidify) {
    const ext = floodExterior(occ, nx, ny, nz);
    for (let i = 0; i < N; i++) if (!occ[i] && !ext[i]) { occ[i] = 2; interiorCells++; }
    say(`[solidify] exterior flood → ${interiorCells} enclosed interior cells filled`);
  }
  // ---- symmetrize (bilateral mirror about x = 0; the grid is X-symmetric around the asset origin)
  const symmetrize = o.symmetrize ? String(o.symmetrize) : null;
  if (symmetrize) {
    const keep = symmetrize.includes(':high') ? 'high' : 'low';
    const cx = S.center[0];
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let k = 0; k < cx; k++) {
      const src = keep === 'low' ? k : nx - 1 - k, dst = nx - 1 - src;
      const si = src + nx * (y + ny * z), di = dst + nx * (y + ny * z);
      occ[di] = occ[si];
      const s = slotOf.get(si);
      if (s !== undefined) slotOf.set(di, s); else slotOf.delete(di);
    }
    say(`[symmetrize] mirrored the ${keep} X half`);
  }

  // ---- per-voxel colours (surface cells), emissive split, palette quantization
  const isSurface = (i) => {
    if (!occ[i]) return false;
    const z = Math.floor(i / nxy), r = i - z * nxy, y = Math.floor(r / nx), x = r - y * nx;
    return x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1 || !occ[i - 1] || !occ[i + 1] || !occ[i - nx] || !occ[i + nx] || !occ[i - nxy] || !occ[i + nxy];
  };
  const emRules = (readJsonArg(o.emissiveRules) || []).map((r) => ({ levels: 3, emissive: 1, matTag: 8, ...r }));
  const matRules = readJsonArg(o.matRules) || [];
  const sat = o.satBoost ?? 1, con = o.contrast ?? 1, vg = o.valGamma ?? 1, vk = o.valGain ?? 1;
  const grade = (rgb) => {   // generated PBR albedo is usually darker / greyer than the 2D concept: V' = gain · V^gamma, contrast, S · sat
    if (sat === 1 && con === 1 && vg === 1 && vk === 1) return rgb;
    let [h, s, v] = rgb2hsv(...rgb);
    s = clamp(s * sat, 0, 1); v = clamp(vk * Math.pow(v, vg), 0, 1); v = clamp(0.5 + (v - 0.5) * con, 0, 1);
    return hsv2rgb(h, s, v);
  };
  const cellColor = new Map(), groupBins = new Map();
  const bin5 = (rgb) => (Math.round(clamp(rgb[0], 0, 1) * 31) << 10) | (Math.round(clamp(rgb[1], 0, 1) * 31) << 5) | Math.round(clamp(rgb[2], 0, 1) * 31);
  let surfaceN = 0;
  for (const [cell, s] of [...slotOf].sort((a, b) => a[0] - b[0])) {
    if (!occ[cell] || !isSurface(cell)) continue;
    surfaceN++;
    const k = s * 8, w = acc[k + 6] || 1;
    const rgb = grade([acc[k] / w, acc[k + 1] / w, acc[k + 2] / w]);
    const erg = [acc[k + 3] / w, acc[k + 4] / w, acc[k + 5] / w], eLum = Math.max(...erg);
    const hsv = rgb2hsv(...rgb);
    let group = 'diffuse';
    if (eLum > 0.12) group = 'emissive_tex';
    else { const r = emRules.find((rr) => ruleMatch(rr, hsv)); if (r) group = `em:${r.name}`; }
    const useRgb = group === 'emissive_tex' ? erg.map((v, i) => Math.max(v, rgb[i])) : rgb;
    cellColor.set(cell, { rgb: useRgb, group, eLum });
    if (!groupBins.has(group)) groupBins.set(group, new Map());
    const gb = groupBins.get(group), b = bin5(useRgb);
    gb.set(b, (gb.get(b) || 0) + 1);
  }
  const pal = new MegaPalette();
  const groupMap = new Map(), palReport = [];
  const groups = [...groupBins.keys()].sort((a, b) => (a === 'diffuse' ? -1 : b === 'diffuse' ? 1 : a < b ? -1 : 1));
  for (const g of groups) {
    const rule = g.startsWith('em:') ? emRules.find((r) => `em:${r.name}` === g) : null;
    const K = g === 'diffuse' ? (o.colors ?? 20) : rule ? rule.levels : 3;
    const km = kmeansBins(groupBins.get(g), K, 23);
    const order = km.centers.map((c, k) => k).sort((a, b) => km.centers[b].lab[0] - km.centers[a].lab[0]);   // bright → dark names
    const idx = new Array(km.centers.length);
    const vMax = Math.max(...km.centers.map((c) => rgb2hsv(...c.rgb)[2]), 1e-6);
    order.forEach((k, rank) => {
      const c = km.centers[k], hsv = rgb2hsv(...c.rgb);
      const gradeEntry = (rule0) => {
        const gr = rule0 && rule0.grade;
        if (!gr) return c.rgb;
        return hsv2rgb((hsv[0] + (gr.hueShift || 0) + 360) % 360, clamp(hsv[1] * (gr.sat ?? 1), 0, 1), clamp((gr.gain ?? 1) * Math.pow(hsv[2], gr.gamma ?? 1), 0, 1));
      };
      let matTag, emissive = 0, name;
      if (g === 'diffuse') {
        const mr = matRules.find((r) => ruleMatch(r, hsv));
        matTag = mr ? mr.matTag : (o.defaultMat ?? 0);
        name = `${mr ? mr.name : 'diffuse'}_${String(rank).padStart(2, '0')}`;
        if (mr && mr.emissive) emissive = mr.emissive;
      } else if (rule) {
        matTag = rule.matTag; name = `${rule.name}_${rank}`;
        emissive = r3(rule.emissive * clamp(0.25 + 0.75 * (hsv[2] / vMax) ** 2, 0, 1));
      } else { matTag = o.emissiveTexMat ?? 8; name = `emtex_${rank}`; emissive = r3(clamp(0.3 + 0.7 * hsv[2], 0, 1)); }
      const outRgb = gradeEntry(g === 'diffuse' ? matRules.find((r) => ruleMatch(r, hsv)) : rule);
      idx[k] = pal.add(name, hex(outRgb), { emissive, matTag });
      palReport.push({ index: idx[k], name, hex: hex(outRgb), rawHex: hex(c.rgb), emissive, matTag, voxels: c.w, group: g });
    });
    groupMap.set(g, { km, idx });
  }
  const interiorHex = o.interior || '#24142e';
  const interiorIdx = pal.add('interior', interiorHex, { emissive: o.interiorEmissive ?? 0, matTag: o.interiorMat ?? 6 });
  say(`[palette] ${pal.size} entries: ${groups.map((g) => `${g} ${groupMap.get(g).idx.length}`).join(' · ')} + interior ${interiorHex} (surface voxels ${surfaceN})`);

  // ---- grid fill + colour smoothing (mode filter over surface neighbours; emissive accents only flip to another emissive)
  const grid = new VoxelGrid(nx, ny, nz);
  for (let i = 0; i < N; i++) if (occ[i]) grid.pal[i] = interiorIdx;
  for (const [cell, c] of cellColor) { const gm = groupMap.get(c.group); grid.pal[cell] = gm.idx[gm.km.assign.get(bin5(c.rgb))]; }
  const isEm = (pi) => pi && pal.list[pi] && pal.list[pi].em > 0;
  for (let pass = 0; pass < (o.colorSmooth ?? 1); pass++) {
    const next = new Map();
    for (const cell of cellColor.keys()) {
      const z = Math.floor(cell / nxy), r = cell - z * nxy, y = Math.floor(r / nx), x = r - y * nx;
      if (x < 1 || y < 1 || z < 1 || x >= nx - 1 || y >= ny - 1 || z >= nz - 1) continue;
      const cnt = new Map(), self = grid.pal[cell];
      cnt.set(self, 2);
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy && !dz) continue;
        const j = cell + dx + nx * dy + nxy * dz, pj = grid.pal[j];
        if (!pj || pj === interiorIdx || !cellColor.has(j)) continue;
        cnt.set(pj, (cnt.get(pj) || 0) + 1);
      }
      let best = self, bc = cnt.get(self);
      for (const [k, v] of cnt) if (v > bc) { best = k; bc = v; }
      if (best !== self && isEm(self) === isEm(best)) next.set(cell, best);
    }
    for (const [c, v] of next) grid.pal[c] = v;
    say(`[smooth] pass ${pass + 1}: ${next.size} surface voxels recoloured`);
  }

  // ---- carves (after solidify, before AO)
  const carveReport = {};
  if (o.zones) {
    const doc = readJsonArg(o.zones);
    const ids = o.zoneIds ? String(o.zoneIds).split(',') : null;
    carveReport.zones = applyDetailZoneCarves(grid, { ...doc, zones: doc.zones.filter((z) => !ids || ids.some((id) => z.zoneId.startsWith(id))) }, { voxelScale: vs, center: S.center });
    say(`[carve] detail zones ${JSON.stringify(carveReport.zones)}`);
  }
  for (const cb of [].concat(o.carveBox || [])) {
    const b = String(cb).split(':')[0].split(',').map(Number);
    const mn = b.slice(0, 3).map((v, k) => v / vs + S.center[k]), mx = b.slice(3, 6).map((v, k) => v / vs + S.center[k]);
    const removed = grid.box(mn, mx, 0, { mode: 'subtract' });
    carveReport.boxes = [...(carveReport.boxes || []), { box: b, removed }];
    say(`[carve] box ${b.join(',')} → ${removed} voxels removed`);
  }
  const toLocal = (ix, iy, iz) => [(ix + 0.5 - S.center[0]) * vs, (iy + 0.5 - S.center[1]) * vs, (iz + 0.5 - S.center[2]) * vs];
  const hookCtx = () => ({ grid, palette: pal, voxelScale: vs, center: S.center, interiorIndex: interiorIdx, carves: carveReport, toLocal });
  if (typeof o.preAoHook === 'function') { const r = await o.preAoHook(hookCtx()); if (r) carveReport.preAo = r; }

  // ---- ONE macro AO bake on the unified grid
  const aoOpts = { rays: o.aoRays ?? 24, maxDist: o.aoDist ?? 36, blurRadius: 2, startOffset: 1.0, falloff: 2, strength: 1 };
  const tAo = Date.now();
  const macroAo = bakeMacroCavityAO(grid, aoOpts);
  say(`[AO] ${macroAo.stats.faces} faces · mean ${macroAo.stats.mean.toFixed(3)} · ${aoOpts.rays} rays / ${aoOpts.maxDist} vox · ${Date.now() - tAo} ms`);
  const levels = o.macroLevels ?? 16;
  const srcBuf = fs.readFileSync(file);
  const meta = {
    ...(readJsonArg(o.meta) || {}),
    meshToVoxel: {
      tool: `mesh_to_voxel.mjs ${MESH_TO_VOXEL_VERSION}`, source: path.basename(file), sourceSha256: crypto.createHash('sha256').update(srcBuf).digest('hex'),
      align: { rotX: o.rotX || 0, rotY: o.rotY || 0, rotZ: o.rotZ || 0, lengthY: o.lengthY || null, translate: o.translate || [0, 0, 0], origin: o.origin || 'center', scale: r3(al.scale) },
      voxelScale: vs, grid: [nx, ny, nz], solidify: !!o.solidify, interiorCells, symmetrize, colors: o.colors ?? 20, colorSmooth: o.colorSmooth ?? 1, grade: { satBoost: sat, contrast: con, valGamma: vg, valGain: vk },
      emissiveRules: emRules, matRules, carves: carveReport, macroAo: { levels, ...aoOpts },
    },
  };
  if (typeof o.metaHook === 'function') Object.assign(meta, (await o.metaHook(hookCtx())) || {});
  const manifest = { id: o.id || path.basename(o.outAsset), name: o.name || o.id || path.basename(o.outAsset), faction: o.faction || null, archetype: o.archetype || null,
    ...(o.materialProfile ? { materialProfile: o.materialProfile } : {}), ...(o.styleTag ? { styleTag: o.styleTag } : {}),
    palette: pal, voxelScale: vs, center: S.center, format: 'MEGA_V23', macroLevels: levels, aoOpts, meta };

  // ---- multi-part split: every part meshed against the whole grid (greedyQuad16Masked) with the shared AO
  const splitParts = [].concat(o.splitParts || []).map((p) => (typeof p === 'string' ? parseSplitPart(p) : { ...p }));
  let partsIn, split = null, labels = null;
  if (splitParts.length || typeof o.partSplitter === 'function') {
    const tSp = Date.now();
    const L = labelParts(grid, { voxelScale: vs, center: S.center, splitParts, partSplitter: o.partSplitter || null });
    labels = L.labels;
    const base = { name: o.basePartName || 'hull', kind: o.basePartKind || 'static' };
    const defs = [base, ...splitParts];
    splitParts.forEach((p, j) => {
      if (!p.waveAxis || (p.waveCenter && p.waveCenter !== 'auto')) return;
      const jb = computeJunctionBox(grid, L.labels, j + 1, { voxelScale: vs, center: S.center, margin: p.junctionMargin ?? 2 });
      if (!jb) throw new Error(`split part ${p.name}: no junction with the rest of the structure (cannot auto-anchor its wave)`);
      p.waveCenter = jb.center;
      p.waveRadii = p.waveAxis === 'ellipsoid' ? jb.halfExtents.map((h) => r3(h * Math.sqrt(3))) : jb.halfExtents;   // ellipsoid ⊇ box corners
      p.junction = jb;
      say(`[split] ${p.name} root junction ${jb.voxels} vox → ${p.waveAxis} anchor centre ${jb.center} · half ${jb.halfExtents}`);
    });
    partsIn = defs.map((p, k) => {
      const mesh = greedyQuad16Masked(grid, pal, L.labels, k, { voxelScale: vs, center: S.center, macroAo, macroLevels: levels, name: p.name });
      const wave = {};
      for (const key of ['waveAmp', 'waveFreq', 'waveOriginY']) if (typeof p[key] === 'number') wave[key] = p[key];
      return { name: p.name, kind: p.kind, mesh, ...wave, ...(p.anim ? { anim: p.anim } : {}) };
    });
    split = { ms: Date.now() - tSp, voxels: Object.fromEntries(defs.map((p, k) => [p.name, L.counts[k]])), components: L.components.slice(0, 24), droppedToBase: L.dropped,
      parts: defs.map((p, k) => ({ name: p.name, kind: p.kind, quads: partsIn[k].mesh.quadCount, triangles: partsIn[k].mesh.triangles, voxels: L.counts[k], exposedFaces: partsIn[k].mesh.exposedFaces,
        ...(p.waveAmp !== undefined ? { waveAmp: p.waveAmp, waveFreq: p.waveFreq, waveOriginY: p.waveOriginY ?? 0, waveAxis: p.waveAxis || 'y', ...(p.waveAxis && p.waveAxis !== 'y' ? { waveCenter: p.waveCenter, waveRadii: p.waveRadii, junctionVoxels: p.junction ? p.junction.voxels : null } : {}) } : {}) })) };
    say(`[split] ${split.parts.map((p) => `${p.name}(${p.kind}) ${p.voxels} vox · ${p.quads} quads`).join(' · ')} · ${L.components.length} kept components, ${L.dropped} vox back to ${base.name}`);
  } else partsIn = [{ name: o.basePartName || 'hull', kind: o.basePartKind || 'static', grid, macroAo, bakeAo: false, macroLevels: levels }];

  // ---- optional meso prefab composition (packed20 prefabs + instances)
  let meso = { prefabs: [], instances: [] };
  if (typeof o.mesoHook === 'function') meso = { prefabs: [], instances: [], ...((await o.mesoHook(hookCtx())) || {}) };
  const packed = packMegaAsset(manifest, partsIn, meso.prefabs, meso.instances);
  // packMegaAsset keeps waveAmp / waveFreq / waveOriginY for pre-meshed parts: add the shared AO stats + wave anchor fields
  const aoJson = { rays: macroAo.rays, maxDist: macroAo.maxDist, mean: r3(macroAo.stats.mean), min: r3(macroAo.stats.min), shared: 'one bake on the unified grid' };
  packed.json.macro.parts.forEach((pj) => {
    pj.macroAo = aoJson;
    const sp = split && split.parts.find((q) => q.name === pj.name);
    if (sp && sp.waveAxis) { pj.waveAxis = sp.waveAxis; if (sp.waveCenter) { pj.waveCenter = sp.waveCenter; pj.waveRadii = sp.waveRadii; } }
    const pin = partsIn.find((q) => q.name === pj.name);
    if (pin && pin.anim && !pj.anim) pj.anim = pin.anim;
  });
  if (split) packed.json.meta.meshToVoxel.split = { parts: split.parts, droppedToBase: split.droppedToBase };
  const wsr = writeMegaAsset(o.outAsset, packed);
  const st = packed.stats;
  const budget = checkPerfBudget(st, MEGA_V23_BUDGET, null);
  say(`[pack] ${packed.json.schema} quads ${st.macroQuads} · tris ${st.totalTriangles} · draws ${st.drawCalls} · bin ${(st.binBytes / 1048576).toFixed(3)} MiB · static budget ${budget.staticPass ? 'PASS' : 'FAIL'}`);

  // ---- voxel cache (sculpt base for later passes)
  const cacheDir = o.cacheDir || path.dirname(path.resolve(o.outAsset));
  fs.mkdirSync(cacheDir, { recursive: true });
  const cacheBin = Buffer.concat([Buffer.from(grid.pal.buffer, grid.pal.byteOffset, grid.pal.byteLength), Buffer.from(grid.flags.buffer, grid.flags.byteOffset, grid.flags.byteLength)]);
  fs.writeFileSync(path.join(cacheDir, 'voxel_cache.bin'), cacheBin);
  fs.writeFileSync(path.join(cacheDir, 'voxel_cache.json'), JSON.stringify({ schema: 'svox.voxel_cache/v1', dims: [nx, ny, nz], voxelScale: vs, center: S.center, gridMinU: S.gridMin,
    layout: { pal: [0, N], flags: [N, N] }, interiorIndex: interiorIdx, palette: pal.toJSON(), source: meta.meshToVoxel, sha256: crypto.createHash('sha256').update(cacheBin).digest('hex') }, null, 1) + '\n');

  // ---- CPU previews
  const previews = [];
  if (!o.noPreview) {
    const asset = readMegaAsset(`${o.outAsset}.json`);
    for (const [name, yaw, pitch] of [['hero34', -40, 17], ['aft34', -150, 24], ['side', 90, 0], ['top', 0, 89]]) {
      const r = renderPreview(asset, { view: 'hero34', yaw, pitch, width: o.previewWidth || 1376, height: o.previewHeight || 768, light: [-0.45, 0.35, 0.82] });
      const f = path.join(cacheDir, `voxel_preview_${name}.png`);
      dif.writePNG(f, r.image); previews.push(f);
    }
  }
  const report = { ok: budget.staticPass, kitVersion: KIT_VERSION, tool: MESH_TO_VOXEL_VERSION, schema: packed.json.schema, out: o.outAsset, sha256: { json: wsr.jsonSha256, bin: wsr.binSha256 },
    align: { ...meta.meshToVoxel.align, bounds: al.bounds },
    model: { bytes: model.bytes, primitives: prims.length, triangles: S.stats.tris, materials: mats.map((m) => ({ name: m.name, baseTex: m.baseTex && [m.baseTex.w, m.baseTex.h], emissiveTex: m.emissiveTex && [m.emissiveTex.w, m.emissiveTex.h], emissiveFactor: m.emissiveFactor })), warnings: model.warnings },
    voxel: { grid: [nx, ny, nz], voxelScale: vs, center: S.center, surfaceCells: S.stats.surfaceCells, surfaceVoxels: surfaceN, interiorCells, solidVoxels: grid.count(), samples: S.stats.samples, fallbacks: S.stats.fallbacks },
    palette: palReport, interior: { index: interiorIdx, hex: interiorHex }, carves: carveReport, macroAo: { ...macroAo.stats, levels },
    split, meso: { prefabs: meso.prefabs.length, instances: meso.instances.length }, stats: st, budget, previews, ms: Date.now() - t0 };
  fs.writeFileSync(path.join(cacheDir, 'voxelize_report.json'), JSON.stringify(report, null, 1) + '\n');
  return { ...report, grid, megaPalette: pal, packed, macroAo, labels };
}
export const voxelize = voxelizeGlb;

// =============================================================================================== inspect / render
/** Telemetry JSON + 6-view sheet(s) of a model. o: { glb | source, out, rotX, rotY, rotZ, lengthY, translate, origin, ss } */
export async function inspectGlb(o) {
  const file = await resolveModelPath(o);
  const model = loadGlbMesh(file, o);
  const { rawBounds: rb } = model, size = rb.size;
  const tele = {
    file: path.basename(file), bytes: model.bytes, generator: model.json.asset && model.json.asset.generator, extensionsUsed: model.json.extensionsUsed || [], extensionsRequired: model.json.extensionsRequired || [],
    nodes: (model.json.nodes || []).length, meshes: (model.json.meshes || []).length,
    primitives: model.primitives.map((p) => ({ mesh: p.mesh, node: p.node, vertices: p.positions.length / 3, triangles: p.indices.length / 3, uv: !!p.uvs, normals: p.normals, colors: !!p.colors, material: p.material })),
    triangles: model.triangles, vertices: model.vertices, rawBounds: { min: rb.min.map(r3), max: rb.max.map(r3), size: size.map(r3) },
    aspect: { 'x/y': r3(size[0] / size[1]), 'z/y': r3(size[2] / size[1]), 'x/z': r3(size[0] / size[2]), longestAxis: ['x', 'y', 'z'][size.indexOf(Math.max(...size))] },
    materials: model.materials.map((m) => ({ name: m.name, baseColorFactor: m.baseColorFactor, baseColorTexture: m.baseTex && { w: m.baseTex.w, h: m.baseTex.h, mime: m.baseTex.mime }, emissiveFactor: m.emissiveFactor, emissiveTexture: m.emissiveTex && { w: m.emissiveTex.w, h: m.emissiveTex.h, mime: m.emissiveTex.mime } })),
    textures: (model.json.images || []).map((im, i) => ({ image: i, mime: im.mimeType || null, name: im.name || null })), warnings: model.warnings,
  };
  const out = o.out || path.dirname(file);
  fs.mkdirSync(out, { recursive: true });
  const W = o.width || 1500, H = o.height || 1036;
  const sheet = path.join(out, 'glb_6view_sheet.png');
  const r = renderModelViews(model, sheet, { width: W, height: H, cols: 3, rows: 2, titleH: 36, grid: true, up: [0, 1, 0], views: RAW_VIEWS, ss: o.ss,
    title: `RAW ${tele.file} - ${tele.triangles} TRIS - SIZE ${size.map((v) => v.toFixed(2)).join(' X ')} (X Y Z) - GLTF +Y UP, FRONT +Z` });
  tele.sheet = sheet; tele.render = { drawnTriangles: r.drawnTriangles };
  if (hasAlign(o)) {
    const al = alignmentMatrix(model.primitives, o);
    const aligned = path.join(out, 'glb_6view_aligned.png');
    renderModelViews(model, aligned, { width: W, height: H, cols: 3, rows: 2, titleH: 36, grid: true, up: [0, 0, 1], views: ASSET_VIEWS, align: al.M, ss: o.ss,
      title: `ALIGNED (ASSET FRAME +X RIGHT, +Y FORWARD, +Z UP) ROT ${[o.rotX || 0, o.rotY || 0, o.rotZ || 0].join('/')} - SIZE ${al.bounds.size.map((v) => v.toFixed(0)).join(' X ')} U` });
    tele.aligned = { sheet: aligned, bounds: { min: al.bounds.min.map(r3), max: al.bounds.max.map(r3), size: al.bounds.size.map(r3) }, scale: r3(al.scale) };
  }
  fs.writeFileSync(path.join(out, 'glb_inspect.json'), JSON.stringify(tele, null, 1) + '\n');
  return tele;
}
export const inspect = inspectGlb;

/** One perspective frame of the aligned model (asset-frame orbit camera). o: { glb | source, out, view 'az=,el=,fov=,fit=', width, height, clay, label } */
export async function renderGlbView(o) {
  const file = await resolveModelPath(o);
  const model = loadGlbMesh(file, o);
  const al = alignmentMatrix(model.primitives, o);
  const v = Object.fromEntries(String(o.view || 'az=-40,el=17,fov=24,fit=1.04').split(',').map((kv) => { const [k, x] = kv.split('='); return [k.trim(), +x]; }));
  const view = { dir: orbitDir(v.az ?? -40, v.el ?? 17), fov: v.fov ?? 24, fit: v.fit ?? 1.04, target: [0, 0, 0], label: o.label || null, ...(v.dist ? { dist: v.dist } : {}) };
  if (!o.out) throw new Error('--out <file.png> required');
  return renderModelViews(model, o.out, { width: o.width || 1376, height: o.height || 768, cols: 1, rows: 1, up: [0, 0, 1], views: [view], align: al.M, bg: o.bg || '#0e1520', clay: !!o.clay, ss: o.ss });
}

// =============================================================================================== CLI
const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 && rest[i + 1] !== undefined && !/^--[a-z]/.test(rest[i + 1]) ? rest[i + 1] : d; };
  const all = (n) => rest.flatMap((a, i) => (a === `--${n}` && rest[i + 1] !== undefined ? [rest[i + 1]] : []));
  const has = (n) => rest.includes(`--${n}`);
  const num = (n, d) => (opt(n) !== undefined ? +opt(n) : d);
  const common = {
    glb: opt('glb'), source: opt('source'), rotX: num('rot-x', 0), rotY: num('rot-y', 0), rotZ: num('rot-z', 0), lengthY: num('length-y', null), origin: opt('origin', 'center'),
    translate: opt('translate') ? opt('translate').split(',').map(Number) : null, imageDecoder: opt('image-decoder', 'auto'), ss: num('ss', 2),
  };
  try {
    let res;
    if (cmd === 'inspect') {
      res = await inspectGlb({ ...common, out: opt('out') });
      console.log(JSON.stringify({ file: res.file, triangles: res.triangles, rawBounds: res.rawBounds, aspect: res.aspect, sheet: res.sheet, aligned: res.aligned || null, warnings: res.warnings }, null, 1));
    } else if (cmd === 'render') {
      res = await renderGlbView({ ...common, out: opt('out'), view: opt('view'), width: num('width', 1376), height: num('height', 768), label: opt('label'), clay: has('clay') });
      console.log(JSON.stringify({ png: res.png, width: res.width, height: res.height, drawnTriangles: res.drawnTriangles }));
    } else if (cmd === 'voxelize') {
      if (!opt('out-asset')) throw new Error('--out-asset <base> required');
      res = await voxelizeGlb({
        ...common, outAsset: opt('out-asset'), voxelScale: num('voxel-scale', 2.2), margin: num('margin', 3), solidify: has('solidify'), symmetrize: opt('symmetrize'),
        interior: opt('interior'), interiorMat: num('interior-mat', 6), interiorEmissive: num('interior-emissive', 0), colors: num('colors', 20),
        emissiveRules: opt('emissive-rules'), matRules: opt('mat-rules'), defaultMat: num('default-mat', 0), colorSmooth: num('color-smooth', 1), satBoost: num('sat-boost', 1), contrast: num('contrast', 1), valGamma: num('val-gamma', 1), valGain: num('val-gain', 1),
        zones: opt('zones'), zoneIds: opt('zone-ids'), carveBox: all('carve-box'), aoRays: num('ao-rays', 24), aoDist: num('ao-dist', 36), macroLevels: num('macro-levels', 16),
        id: opt('id', path.basename(opt('out-asset'))), name: opt('name'), faction: opt('faction'), archetype: opt('archetype'), materialProfile: opt('material-profile'), meta: opt('meta'),
        cacheDir: opt('cache-dir'), noPreview: has('no-preview'), splitParts: all('split-part'), basePartName: opt('base-part', 'hull'),
      });
      const { grid, megaPalette, packed, macroAo, labels, ...rep } = res;
      console.log(JSON.stringify({ ok: rep.ok, out: rep.out, sha256: rep.sha256, voxel: rep.voxel, split: rep.split && rep.split.parts, stats: { tris: rep.stats.totalTriangles, quads: rep.stats.macroQuads, binMiB: r3(rep.stats.binBytes / 1048576), draws: rep.stats.drawCalls }, palette: rep.palette.length, warnings: rep.model.warnings }, null, 1));
      process.exitCode = rep.ok ? 0 : 1;
    } else if (cmd === 'self-test') {
      res = selfTestMaskedQuad16();
      console.log(JSON.stringify(res));
      process.exitCode = res.identical && res.exposedConserved ? 0 : 1;
    } else {
      console.log('usage: mesh_to_voxel.mjs inspect|render|voxelize|self-test --glb <file> | --source <mesh_source.json> [options] (see the file header)');
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(`[mesh_to_voxel] ERROR ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}
