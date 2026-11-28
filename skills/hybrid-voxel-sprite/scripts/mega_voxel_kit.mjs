#!/usr/bin/env node
// mega_voxel_kit.mjs — hybrid-voxel-sprite v2.3 · Megastructure multi-scale voxel kit.
//
// Pure Node ES module, ZERO npm dependencies (node:fs / node:path / node:crypto + ./mega_diff_utils.mjs). Node >= 18.
// Engine-neutral; the output loads straight into WebGL2 / Three.js (or any engine) as typed-array views over one .bin.
//
//   VoxelGrid           Uint8 palette index (0 = air) + Uint8 flags; CSG: box · ellipsoid · capsule · prism · subtract ·
//                       mirrorX · resample (emissive-priority) · projectSilhouettes
//   carveVisualHull     Stage 1A: 3-view (top / side / front) silhouette carving with bbox-normalised registration
//   detail zones        Stage 1B: detail_zones.json schema (validateDetailZones / scaffoldDetailZones /
//                       applyDetailZoneCarves / zoneVoxelStats) + 3 archetype checklists
//   bakeMacroCavityAO   Stage 3: coarse hemisphere ray visibility per exposed face (smoothed-normal start offset → no
//                       convex-staircase greying)
//   greedyMeshPart      Stage 2/3: AO-preserving greedy mesher (micro voxel AO + macro cavity AO + material tag, diagonal
//                       flip, exact vertex de-dup) → MEGA_V2 (12 floats) or legacy FLOAT11 (11 floats)
//   packMegaAsset       deterministic svox.mega/v2 .json + .bin (macro parts, meso prefab geometry, instance streams,
//                       detailZones[], stats, static G6 budget); format 'MEGA_V22' → svox.mega/v2.2 (20 B/vert quantized
//                       packed20: Int16×4 pos+bevelHint · Int8×4 normal+microAo · Uint8×4 rgb+emissive · Uint8×4 matTag,
//                       macroAo, creaseMask, panelId) — 2.4× the geometry inside the same 4 MiB .bin budget
//   packQuantizedMegaV22 / unpackQuantizedMegaV22   the v2.2 20-byte vertex codec (round-trip < 0.03 u on 1000 u bounds)
//   greedyQuad16Part    v2.3: the same AO-preserving greedy merge emitted as `quad16` instanced quads (16 B / quad, NO index
//                       buffer, NO 65 535-vertex cap): Uint16×3 integer voxel origin · Uint8×2 size · Uint8×4 rgb+emissive ·
//                       Uint8×4 meta (dir | bevelQ | creaseQ | diagFlip, 4-corner micro AO, 256-level macro AO, matTag | panelId)
//   packQuad16 / unpackQuad16 / quad16ToMesh   the v2.3 16-byte quad codec + expansion to MEGA_V2 floats (preview / G5)
//   packMegaAsset MEGA_V23   svox.mega/v2.3: quad16 macro parts + packed20 instanced meso prefabs in one .json/.bin,
//                       MEGA_V23_BUDGET (12 MiB · 16 draws · 1.2 M tris · Δ 2.5 ms)
//   renderPreview       engine-free CPU z-buffer preview of a packed asset (ortho top / side / front, hero 3/4, or any
//                       yaw / pitch) with cel key light × micro AO × macro AO + emissive — for G5 sheets and smoke checks
//
// World convention: right-handed, Z-up — +X right (starboard), +Y forward (bow), +Z up (dorsal). Asset-local units "u".
// Grid convention: voxel (x, y, z) covers [x, x+1) × [y, y+1) × [z, z+1); shapes are tested at voxel centres.
//
// CLI:
//   node mega_voxel_kit.mjs demo           [--out DIR] [--format MEGA_V2|FLOAT11|MEGA_V22|MEGA_V23] [--name ID] [--asset-only]
//                                          [--faction-tags | --material-swatches]   synthetic carrier → svox.mega/v2 (v2.2 / v2.3)
//                                          + zones + PNGs; MEGA_V23 adds matTag 6/7/8 material swatches. Short form: --v<major><minor>
//   node mega_voxel_kit.mjs zones-template --archetype hard_surface_carrier|halo_mothership|bio_leviathan|generic_megastructure
//                                          [--hull-size 288,1000,160] [--asset ID | --ship ID] [--out detail_zones.json]
//   node mega_voxel_kit.mjs validate-zones --zones detail_zones.json [--hull-size X,Y,Z]
//   node mega_voxel_kit.mjs hull           --top t.png --side s.png --front f.png --length-y 1000 [--voxel-scale 3.5]
//                                          [--channel auto] [--zones detail_zones.json] [--out build/ship] [--no-ao]
//   node mega_voxel_kit.mjs inspect        --asset build/ship.json
//   node mega_voxel_kit.mjs preview        --asset build/ship.json --out hero.png [--view hero34|top|side|front|bow34|aft34|ventral34]
//                                          [--yaw 35 --pitch 28] [--width 640 --height 400] [--no-instances]
// Exit code 1 on errors / failed validation.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { toMask, maskBBox, createMask, createImage, maskToImage, writePNG, isMainModule, parseArgs } from './mega_diff_utils.mjs';

export const KIT_VERSION = '2.3.0';
export const MEGA_SCHEMA = 'svox.mega/v2';
export const MEGA_V22_SCHEMA = 'svox.mega/v2.2';
export const MEGA_V23_SCHEMA = 'svox.mega/v2.3';
export const ZONES_SCHEMA = 'svox.detail_zones/v1';

// flags byte: low nibble = material tag (0 → use the palette entry's matTag); high bits = authoring state
export const MAT_MASK = 0x0f;
export const F_LOCK = 0x10;     // survives visual-hull carving and subtract() unless { force: true }
export const F_CAVITY = 0x20;   // set on cells carved by subtract() / detail-zone carves (cavity air is traceable)
export const F_ZONE = 0x40;     // free for authoring tools (e.g. "belongs to a hero detail zone")
export const FACE_NAMES = ['+x', '-x', '+y', '-y', '+z', '-z'];   // face index f = axis * 2 + (sign < 0 ? 1 : 0)
/** Recommended material tags (4 bits) driving Tier-3 micro detail in CAPITAL_FRAG (references/04 §5.3). */
export const MAT_TAGS = Object.freeze({
  0: 'none (palette default / no micro detail)', 1: 'hull_plating (panel seams, bevels, rivets, vents, micro-windows)',
  2: 'deck (lane stripes, hazard ticks, tie-down grid)', 3: 'light / emissive (no micro detail, no macro AO darkening)',
  4: 'mechanical greeble (fine plating, no windows)', 5: 'organic chitin (scales, vein cracks)',
  6: 'crystal (facet glints)', 7: 'gold / pearl filigree (engraved bands)', 8: 'glass / viewport',
});

/** Interleaved Float32 vertex layouts. MEGA_V2 floats 0–9 are bit-identical to the legacy 11-float layout (FLOAT11). */
export const MEGA_V2_LAYOUT = Object.freeze({
  name: 'MEGA_V2', floats: 12, stride: 48, index: 'uint32',
  attributes: { position: [0, 3], normal: [3, 3], color: [6, 3], emissive: [9, 1], ao: [10, 1], meta: [11, 1] },
  ao: 'micro voxel AO 0..1 (classic 8-neighbour, 0..3 / 3)',
  meta: 'matTag * 256 + round(macroCavityAo * 255)   → tag = floor(m / 256), macroAo = mod(m, 256) / 255',
});
/**
 * v2.2 quantized 20-byte vertex (little-endian, 4-byte aligned). Positions are part-local quantized into the part /
 * prefab AABB: pos = posCenter + aPosQ.xyz · posHalfExt (per part / prefab JSON). All four attributes are normalized.
 */
export const MEGA_V22_LAYOUT = Object.freeze({
  name: 'MEGA_V22', vertexFormat: 'packed20', vertexStrideBytes: 20, stride: 20, index: 'uint32',
  indexTypes: 'per part / prefab indexType: uint16 when vertexCount <= 65535, else uint32 (blocks 4-byte aligned)',
  attributes: {
    aPosQ: { type: 'int16', count: 4, offset: 0, normalized: true, meaning: 'xyz = (p − posCenter) / posHalfExt · 32767, w = bevelHint · 32767' },
    aNormQ: { type: 'int8', count: 4, offset: 8, normalized: true, meaning: 'xyz = normal · 127, w = microAo · 127' },
    aColEm: { type: 'uint8', count: 4, offset: 12, normalized: true, meaning: 'rgb = albedo · 255, a = emissive · 255' },
    aMeta2Q: { type: 'uint8', count: 4, offset: 16, normalized: true, meaning: 'x = matTag (floor(x·255 + 0.5)), y = macroAo · 255, z = creaseMask · 255, w = panelId' },
  },
  matTags: { 0: 'default', 1: 'armor', 2: 'hazard', 3: 'deck', 4: 'glass', 5: 'hangar_interior', 6: 'engine_frame' },
});
/**
 * Legacy 11-float layout (44 B / vertex, format 'FLOAT11'): floats 0–9 as MEGA_V2, float 10 = microAo · macroCavityAo, so
 * an existing 11-float megastructure shader with no meta attribute still renders the cavity depth with no shader edit.
 */
export const FLOAT11_LAYOUT = Object.freeze({
  name: 'FLOAT11', floats: 11, stride: 44, index: 'uint32',
  attributes: { position: [0, 3], normal: [3, 3], color: [6, 3], emissive: [9, 1], ao: [10, 1] },
  ao: 'microAo * macroCavityAo (folded so an unchanged 11-float megastructure shader gets the cavity depth)',
});
/** Back-compat: the 11-float layout's original format token. Callers and assets that use it keep working unchanged. */
const LEGACY_FLOAT11_FORMAT = 'V12';
export const V12_LAYOUT = Object.freeze({ ...FLOAT11_LAYOUT, name: LEGACY_FLOAT11_FORMAT });
const isFloat11 = (format) => format === 'FLOAT11' || format === LEGACY_FLOAT11_FORMAT;

/** G6 megastructure runtime budget (svox.mega/v2, Stage 5). */
export const MEGA_BUDGET = Object.freeze({
  maxDrawCalls: 12, macroDrawCalls: [1, 3], maxMesoBatches: 9,
  maxTotalTriangles: 120000, maxMesoUniqueTriangles: 60000, maxBinBytes: 4 * 1024 * 1024, maxGpuDeltaMs: 1.0,
});

/** v2.2 budget: same 4 MiB .bin and ≤ 12 draws, 2.4× the triangle density (20 B instead of 48 B per vertex). */
export const MEGA_V22_BUDGET = Object.freeze({
  maxDrawCalls: 12, macroDrawCalls: [1, 3], maxMesoBatches: 11,
  maxTotalTriangles: 288000, maxMesoUniqueTriangles: 144000, maxBinBytes: 4 * 1024 * 1024, maxGpuDeltaMs: 1.5,
});

/**
 * v2.3 `quad16` packed instanced quad (little-endian, 16 B, 4-byte aligned, ZERO index buffer). Every macro part is drawn as
 * ONE instanced draw of a shared unit quad (4 corners [0,0] [1,0] [1,1] [0,1], indices 0 1 2 · 0 2 3); a quad = an instance.
 * Corner (cu, cv) position = gridOrigin + (origin + e_u · cu · du + e_v · cv · dv) · voxelScale, with (d, u, v) cyclic from
 * dir (d = dir >> 1, e_u × e_v = e_d). Corner order for the per-corner AO is k = cu + 2 · cv (greedyMeshPart's order).
 * Negative dirs swap (cu, cv) (reversed winding); diagFlip rotates the unit-quad corner by 90° (c → (1 − c.y, c.x)) so the
 * split diagonal is the AO-preserving anisotropy diagonal of greedyMeshPart — identical triangles, identical interpolation.
 */
export const QUAD16_LAYOUT = Object.freeze({
  name: 'QUAD16', quadFormat: 'quad16', quadStrideBytes: 16, stride: 16, index: 'none — shared unit quad, drawElementsInstanced (1 draw per part)',
  unitQuad: { corners: [[0, 0], [1, 0], [1, 1], [0, 1]], indices: [0, 1, 2, 0, 2, 3] },
  attributes: {
    aQOrigin: { type: 'uint16', count: 3, offset: 0, normalized: false, meaning: 'integer voxel-lattice corner (ix, iy, iz) 0..65535 → p = gridOrigin + origin · voxelScale (exact)' },
    aQSize: { type: 'uint8', count: 2, offset: 6, normalized: false, meaning: '(du, dv) quad size in voxels 1..255 along (e_u, e_v); the mesher splits longer runs' },
    aQColEm: { type: 'uint8', count: 4, offset: 8, normalized: true, meaning: 'rgb = albedo · 255, a = emissive · 255' },
    aQMeta: { type: 'uint8', count: 4, offset: 12, normalized: false, meaning: 'x = dir | bevelQ << 3 | creaseQ << 5 | diagFlip << 7 · y = cornerAo4 (2 bits per corner k = cu + 2cv, micro AO = ao / 3) · z = macroAo 0..255 · w = matTag | panelId << 4' },
  },
  dirs: { 0: '+X', 1: '-X', 2: '+Y', 3: '-Y', 4: '+Z', 5: '-Z' },
  bevel: 'bevelHint(corner) = bevelQ / 3 on corners with micro AO 3 (unoccluded), else 0 — bevelQ = round(3 · convex / unoccluded corners)',
  crease: 'creaseMask(corner) = creaseQ / 3 on corners with micro AO < 3, else 0 — creaseQ = 3 on narrow (≤ 2 vox) quads (exact v2.2 rule)',
  panel: 'panelId (low 4 bits of the grid panel) / 15',
  matTags: { 0: 'default', 1: 'armor', 2: 'hazard', 3: 'deck', 4: 'glass', 5: 'hangar_interior', 6: 'engine_frame (hard_surface profile) | organic chitin (other profiles)', 7: 'ornate gold & ivory temple (any profile)', 8: 'bio-luminescent cavity (any profile)' },
});

/**
 * v2.3 hero-asset budget: 12 MiB .bin, ≤ 16 draws, ≤ 1.2 M triangles, runtime Δ ≤ 2.5 ms. With quad16 (5.75× smaller than
 * v2.2's 92 B / quad) the same bytes carry ~15× the curved voxel detail of the v2.2 4 MiB budget.
 */
export const MEGA_V23_BUDGET = Object.freeze({
  maxBinBytes: 12 * 1024 * 1024, maxDrawCalls: 16, maxTriangles: 1200000, maxRuntimeDeltaMs: 2.5,
  // checkPerfBudget keys (aliases of the four headline limits + the macro / meso split)
  maxTotalTriangles: 1200000, maxGpuDeltaMs: 2.5, macroDrawCalls: [1, 8], maxMesoBatches: 15, maxMesoUniqueTriangles: 600000,
});

/**
 * Material profiles. `matTag` is a 4-bit (0..15) per-voxel material CHANNEL: the kit only stores it (palette entry or
 * `flags & MAT_MASK`) and packs it (MEGA_V2 meta, packed20 aMeta2Q.x, quad16 aQMeta.w low nibble). What a tag looks like
 * is decided by your lookdev shader, so a project maps 0..15 onto its own legend. These presets document the legend the
 * reference megastructure shader implements; `index` is the value its per-asset profile uniform expects (3 = any other profile).
 * Tags 9..15 are unassigned in every preset — use them for your own materials.
 * Pass `materialProfile: '<preset>' | { id, tags { n: name }, index?, uniforms? }` to packMegaAsset.
 */
const SHARED_TAGS = { 0: 'default', 1: 'armor plates (70/30 resting plates)', 2: 'hazard / accent paint', 3: 'deck', 4: 'glass / viewport' };
const SHARED_ACCENTS = { 7: 'ornate gold & ivory trim', 8: 'bio-luminescent cavity (glow scales with cavity depth)' };   // same under every profile
export const MATERIAL_PRESETS = Object.freeze({
  hard_surface: Object.freeze({
    id: 'hard_surface', index: 0, description: 'Hard-surface vessels, stations, mechs, fortresses: armour plates, hazard paint, decks, glass, a warm interior-bay bounce',
    tags: Object.freeze({ ...SHARED_TAGS, 5: 'interior bay (warm bounce + service lines)', 6: 'engine frame plates', ...SHARED_ACCENTS }),
    uniforms: Object.freeze({ uHangarBounce: 1 }),
  }),
  ornate_stone: Object.freeze({
    id: 'ornate_stone', index: 1, description: 'Ornate temples, monuments, ringed halo structures: gold / ivory trim, recessed inlays, plain interiors',
    tags: Object.freeze({ ...SHARED_TAGS, 5: 'interior (plain, no service lines)', 6: 'organic chitin / bio-carapace', ...SHARED_ACCENTS }),
    uniforms: Object.freeze({ uHangarBounce: 0 }),
  }),
  organic_bio: Object.freeze({
    id: 'organic_bio', index: 2, description: 'Organic creatures and bio-structures: chitin carapace, glowing cavities, no mechanical lines',
    tags: Object.freeze({ ...SHARED_TAGS, 5: 'interior (plain, no service lines)', 6: 'organic chitin / bio-carapace', ...SHARED_ACCENTS }),
    uniforms: Object.freeze({ uHangarBounce: 0 }),
  }),
});

/**
 * Resolve a material profile: a MATERIAL_PRESETS name, any other string (custom profile, index 3, no legend), or a custom
 * object { id, tags { 0..15: name }, index = 3, uniforms = {} }. → { id, index, tags | null, uniforms } (plain JSON).
 */
export function resolveMaterialProfile(profile) {
  if (profile === undefined || profile === null || profile === '') return null;
  const plain = (p) => ({ id: p.id, index: p.index, tags: p.tags ? { ...p.tags } : null, uniforms: { ...(p.uniforms || {}) } });
  if (typeof profile === 'string') {
    if (!/^[a-z0-9_-]+$/i.test(profile)) throw new Error(`materialProfile: id must match [a-z0-9_-]+ (got ${profile})`);
    return plain(MATERIAL_PRESETS[profile] || { id: profile, index: 3, tags: null });
  }
  if (typeof profile !== 'object' || typeof profile.id !== 'string' || !/^[a-z0-9_-]+$/i.test(profile.id)) throw new Error('materialProfile: object needs an id matching [a-z0-9_-]+');
  const base = MATERIAL_PRESETS[profile.id];
  const tags = profile.tags || (base && base.tags) || null;
  if (tags) for (const [k, v] of Object.entries(tags)) {
    const n = Number(k);
    if (!Number.isInteger(n) || n < 0 || n > 15) throw new Error(`materialProfile ${profile.id}: matTag ${k} outside 0..15 (4-bit channel)`);
    if (typeof v !== 'string' || !v.trim()) throw new Error(`materialProfile ${profile.id}: matTag ${k} needs a non-empty name`);
  }
  const index = profile.index ?? (base ? base.index : 3);
  if (!Number.isInteger(index) || index < 0 || index > 255) throw new Error(`materialProfile ${profile.id}: index must be an integer 0..255`);
  return plain({ id: profile.id, index, tags, uniforms: profile.uniforms || (base && base.uniforms) || {} });
}

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const hexToRgb = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

// =============================================================================================== palette
export class MegaPalette {
  constructor() { this.list = [null]; this.byName = Object.create(null); }
  /** add(name, '#rrggbb', { emissive 0..1, matTag 0..15 }) → palette index (1..255) */
  add(name, hex, { emissive = 0, matTag = 0 } = {}) {
    if (this.list.length > 255) throw new Error('MegaPalette: more than 255 entries');
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`MegaPalette: bad colour ${hex}`);
    if (this.byName[name] !== undefined) throw new Error(`MegaPalette: duplicate entry ${name}`);
    this.byName[name] = this.list.length;
    this.list.push({ name, hex: hex.toLowerCase(), rgb: hexToRgb(hex), em: clamp(emissive, 0, 1), matTag: matTag & MAT_MASK });
    return this.list.length - 1;
  }
  get(name) { const i = this.byName[name]; if (i === undefined) throw new Error(`MegaPalette: unknown entry ${name}`); return i; }
  entry(i) { const e = this.list[i]; if (!e) throw new Error(`MegaPalette: index ${i} is not defined`); return e; }
  rgb(i) { return this.entry(i).rgb; }
  em(i) { return this.entry(i).em; }
  tag(i) { return this.entry(i).matTag; }
  get size() { return this.list.length - 1; }
  toJSON() { return this.list.slice(1).map((p, i) => ({ index: i + 1, name: p.name, hex: p.hex, emissive: p.em, matTag: p.matTag })); }
}

// =============================================================================================== shapes (voxel-centre predicates)
function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const PRISM_AXES = { z: [0, 1, 2], y: [0, 2, 1], x: [1, 2, 0] };   // [polyU axis, polyV axis, extrude axis]

export const shapes = {
  /** axis-aligned box [min, max) */
  box(min, max) {
    return { kind: 'box', bbox: [min.slice(), max.slice()], inside: (x, y, z) => x >= min[0] && x < max[0] && y >= min[1] && y < max[1] && z >= min[2] && z < max[2] };
  },
  /** ellipsoid centre c, radii r (number or [rx, ry, rz]) */
  ellipsoid(c, r) {
    const R = Array.isArray(r) ? r : [r, r, r];
    return {
      kind: 'ellipsoid', bbox: [[c[0] - R[0], c[1] - R[1], c[2] - R[2]], [c[0] + R[0], c[1] + R[1], c[2] + R[2]]],
      inside: (x, y, z) => { const a = (x - c[0]) / R[0], b = (y - c[1]) / R[1], d = (z - c[2]) / R[2]; return a * a + b * b + d * d <= 1; },
    };
  },
  /** capsule: segment a → b, radius r */
  capsule(a, b, r) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1e-12;
    return {
      kind: 'capsule', bbox: [[Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r, Math.min(a[2], b[2]) - r], [Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r, Math.max(a[2], b[2]) + r]],
      inside: (x, y, z) => {
        const t = clamp(((x - a[0]) * ab[0] + (y - a[1]) * ab[1] + (z - a[2]) * ab[2]) / L2, 0, 1);
        const dx = x - a[0] - ab[0] * t, dy = y - a[1] - ab[1] * t, dz = z - a[2] - ab[2] * t;
        return dx * dx + dy * dy + dz * dz <= r * r;
      },
    };
  },
  /** polygon poly [[u, v], …] (even-odd) extruded along axis over [lo, hi). axis 'z': (u,v) = (x,y); 'y': (x,z); 'x': (y,z) */
  prism(poly, axis = 'z', lo = 0, hi = 1) {
    const ax = PRISM_AXES[axis];
    if (!ax) throw new Error(`prism: axis must be x | y | z (got ${axis})`);
    const [iu, iv, iw] = ax;
    const us = poly.map((p) => p[0]), vs = poly.map((p) => p[1]);
    const mn = [0, 0, 0], mx = [0, 0, 0];
    mn[iu] = Math.min(...us); mx[iu] = Math.max(...us); mn[iv] = Math.min(...vs); mx[iv] = Math.max(...vs); mn[iw] = lo; mx[iw] = hi;
    return { kind: 'prism', bbox: [mn, mx], inside: (x, y, z) => { const p = [x, y, z]; return p[iw] >= lo && p[iw] < hi && pointInPolygon(p[iu], p[iv], poly); } };
  },
  union(...s) { return { kind: 'union', bbox: [[0, 1, 2].map((k) => Math.min(...s.map((q) => q.bbox[0][k]))), [0, 1, 2].map((k) => Math.max(...s.map((q) => q.bbox[1][k])))], inside: (x, y, z) => s.some((q) => q.inside(x, y, z)) }; },
  intersect(...s) { return { kind: 'intersect', bbox: [[0, 1, 2].map((k) => Math.max(...s.map((q) => q.bbox[0][k]))), [0, 1, 2].map((k) => Math.min(...s.map((q) => q.bbox[1][k])))], inside: (x, y, z) => s.every((q) => q.inside(x, y, z)) }; },
  difference(a, b) { return { kind: 'difference', bbox: a.bbox, inside: (x, y, z) => a.inside(x, y, z) && !b.inside(x, y, z) }; },
  /** occupancy of another VoxelGrid placed at offset (voxel units) */
  grid(g, offset = [0, 0, 0]) {
    return { kind: 'grid', bbox: [offset.slice(), [offset[0] + g.nx, offset[1] + g.ny, offset[2] + g.nz]], inside: (x, y, z) => g.get(Math.floor(x - offset[0]), Math.floor(y - offset[1]), Math.floor(z - offset[2])) !== 0 };
  },
};

/** shape spec object (JSON-friendly, used by detail-zone carves) → shape. Coordinates in the spec's own units. */
export function shapeFromSpec(spec, map = (p) => p, mapLen = (v) => v) {
  switch (spec.shape) {
    case 'box': return shapes.box(map(spec.min), map(spec.max));
    case 'ellipsoid': return shapes.ellipsoid(map(spec.center), Array.isArray(spec.radii) ? spec.radii.map(mapLen) : mapLen(spec.radii));
    case 'capsule': return shapes.capsule(map(spec.a), map(spec.b), mapLen(spec.r));
    case 'prism': {
      const ax = PRISM_AXES[spec.axis || 'z'];
      if (!ax) throw new Error(`prism spec: bad axis ${spec.axis}`);
      const [iu, iv, iw] = ax;
      const poly = spec.poly.map(([u, v]) => { const p = [0, 0, 0]; p[iu] = u; p[iv] = v; const q = map(p); return [q[iu], q[iv]]; });
      const lo = [0, 0, 0], hi = [0, 0, 0]; lo[iw] = spec.lo; hi[iw] = spec.hi;
      return shapes.prism(poly, spec.axis || 'z', map(lo)[iw], map(hi)[iw]);
    }
    default: throw new Error(`unknown shape spec ${JSON.stringify(spec.shape)}`);
  }
}

// =============================================================================================== VoxelGrid
export class VoxelGrid {
  constructor(nx, ny, nz, { offset = [0, 0, 0] } = {}) {
    if (![nx, ny, nz].every((v) => Number.isInteger(v) && v > 0)) throw new Error(`VoxelGrid: bad dims ${nx}×${ny}×${nz}`);
    this.nx = nx; this.ny = ny; this.nz = nz; this.offset = offset.slice();
    this.pal = new Uint8Array(nx * ny * nz);
    this.flags = new Uint8Array(nx * ny * nz);
    // v2.2: optional per-voxel panel / sub-assembly id (0..255) → svox.mega/v2.2 panelId + greedy merge boundary.
    // Allocated lazily by the first write that carries a panel (apply opts.panel or grid.activePanel !== null).
    this.panel = null;
    this.activePanel = null;
  }
  /** allocate the panel-id plane (idempotent) */
  ensurePanel() { if (!this.panel) this.panel = new Uint8Array(this.pal.length); return this.panel; }
  getPanel(x, y, z) { return this.panel && this.inb(x, y, z) ? this.panel[x + this.nx * (y + this.ny * z)] : 0; }
  get dims() { return [this.nx, this.ny, this.nz]; }
  index(x, y, z) { return x + this.nx * (y + this.ny * z); }
  inb(x, y, z) { return x >= 0 && y >= 0 && z >= 0 && x < this.nx && y < this.ny && z < this.nz; }
  get(x, y, z) { return this.inb(x, y, z) ? this.pal[x + this.nx * (y + this.ny * z)] : 0; }
  getFlags(x, y, z) { return this.inb(x, y, z) ? this.flags[x + this.nx * (y + this.ny * z)] : 0; }
  solid(x, y, z) { return this.get(x, y, z) !== 0; }
  set(x, y, z, c, flags) { if (!this.inb(x, y, z)) return; const i = this.index(x, y, z); this.pal[i] = c; if (flags !== undefined) this.flags[i] = flags; }

  /**
   * Apply a shape. c: palette index | 0 (carve) | fn(x, y, z, cur) → index | 0 | undefined (keep).
   * opts.mode: 'fill' (default, overwrite) | 'union' (air only) | 'paint' (solid only, recolour) | 'subtract' (→ air)
   * opts.flags: flags byte for written cells (default: keep; subtract ORs F_CAVITY). F_LOCK cells are never
   * carved unless opts.force. Returns the number of changed cells.
   */
  apply(shape, c, { mode = 'fill', flags, force = false, panel } = {}) {
    const [mn, mx] = shape.bbox;
    const x0 = Math.max(0, Math.floor(mn[0])), y0 = Math.max(0, Math.floor(mn[1])), z0 = Math.max(0, Math.floor(mn[2]));
    const x1 = Math.min(this.nx, Math.ceil(mx[0])), y1 = Math.min(this.ny, Math.ceil(mx[1])), z1 = Math.min(this.nz, Math.ceil(mx[2]));
    const fn = typeof c === 'function';
    const pid = panel !== undefined && panel !== null ? panel & 255 : this.activePanel !== null && this.activePanel !== undefined ? this.activePanel & 255 : -1;
    const pan = pid >= 0 ? this.ensurePanel() : null;
    let changed = 0;
    for (let z = z0; z < z1; z++) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (!shape.inside(x + 0.5, y + 0.5, z + 0.5)) continue;
      const i = x + this.nx * (y + this.ny * z), cur = this.pal[i];
      if (mode === 'union' && cur) continue;
      if (mode === 'paint' && !cur) continue;
      let v = mode === 'subtract' ? 0 : fn ? c(x, y, z, cur) : c;
      if (v === undefined || v === null) continue;
      if (v === 0) {
        if (!cur) continue;
        if ((this.flags[i] & F_LOCK) && !force) continue;
        this.pal[i] = 0;
        this.flags[i] = flags !== undefined ? flags : (this.flags[i] & ~(MAT_MASK | F_LOCK)) | (mode === 'subtract' ? F_CAVITY : 0);
        changed++;
        continue;
      }
      if (v < 0 || v > 255) throw new Error(`VoxelGrid.apply: palette index ${v} out of range`);
      if (pan && mode !== 'paint') pan[i] = pid;
      if (v === cur && (flags === undefined || flags === this.flags[i])) continue;
      this.pal[i] = v;
      if (flags !== undefined) this.flags[i] = flags;
      changed++;
    }
    return changed;
  }
  box(min, max, c, opts) { return this.apply(shapes.box(min, max), c, opts); }
  ellipsoid(center, radii, c, opts) { return this.apply(shapes.ellipsoid(center, radii), c, opts); }
  capsule(a, b, r, c, opts) { return this.apply(shapes.capsule(a, b, r), c, opts); }
  prism(poly, axis, lo, hi, c, opts) { return this.apply(shapes.prism(poly, axis, lo, hi), c, opts); }
  /** carve a shape (or another VoxelGrid's occupancy at opts.offset) to air; marks carved cells F_CAVITY */
  subtract(shapeOrGrid, opts = {}) {
    const s = shapeOrGrid instanceof VoxelGrid ? shapes.grid(shapeOrGrid, opts.offset || [0, 0, 0]) : shapeOrGrid;
    return this.apply(s, 0, { ...opts, mode: 'subtract' });
  }
  /** mirror one X half onto the other (keep 'low' copies x < nx/2 → nx-1-x). Bilateral hulls: sculpt one side. */
  mirrorX({ keep = 'low' } = {}) {
    const half = Math.floor(this.nx / 2);
    for (let z = 0; z < this.nz; z++) for (let y = 0; y < this.ny; y++) for (let k = 0; k < half; k++) {
      const src = keep === 'low' ? k : this.nx - 1 - k, dst = this.nx - 1 - src;
      const si = this.index(src, y, z), di = this.index(dst, y, z);
      this.pal[di] = this.pal[si]; this.flags[di] = this.flags[si];
      if (this.panel) this.panel[di] = this.panel[si];
    }
    return this;
  }
  /**
   * Point-resample by factor K (0.8 → 80 % resolution, 2 → double). A coarse cell is solid when its centre's source
   * cell is solid; an emissive source cell overlapping the coarse cell wins (thin glowing conduits survive). Port of the
   * verified reference-implementation resample. Remember to multiply voxelScale by 1/K.
   */
  resample(K, palette = null) {
    const nx = Math.max(1, Math.round(this.nx * K)), ny = Math.max(1, Math.round(this.ny * K)), nz = Math.max(1, Math.round(this.nz * K));
    const g = new VoxelGrid(nx, ny, nz, { offset: this.offset.map((v) => v * K) });
    const isEm = (c) => !!(palette && palette.list[c] && palette.list[c].em > 0);
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const sx = Math.floor((x + 0.5) / K), sy = Math.floor((y + 0.5) / K), sz = Math.floor((z + 0.5) / K);
      const c = this.get(sx, sy, sz);
      if (!c) continue;
      let out = c;
      if (palette && !isEm(c)) {
        search: for (let dz = Math.floor(z / K); dz < Math.ceil((z + 1) / K); dz++) for (let dy = Math.floor(y / K); dy < Math.ceil((y + 1) / K); dy++) for (let dx = Math.floor(x / K); dx < Math.ceil((x + 1) / K); dx++) {
          const e = this.get(dx, dy, dz);
          if (e && isEm(e)) { out = e; break search; }
        }
      }
      g.set(x, y, z, out, this.getFlags(sx, sy, sz));
      if (this.panel) g.ensurePanel()[g.index(x, y, z)] = this.getPanel(sx, sy, sz);
    }
    return g;
  }
  count() { let n = 0; for (let i = 0; i < this.pal.length; i++) if (this.pal[i]) n++; return n; }
  clone() { const g = new VoxelGrid(this.nx, this.ny, this.nz, { offset: this.offset }); g.pal.set(this.pal); g.flags.set(this.flags); if (this.panel) g.ensurePanel().set(this.panel); g.activePanel = this.activePanel; return g; }
  /** tight bbox of solid cells: { min, max (exclusive), empty } */
  bbox() {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let z = 0; z < this.nz; z++) for (let y = 0; y < this.ny; y++) for (let x = 0; x < this.nx; x++) if (this.pal[this.index(x, y, z)]) {
      if (x < mn[0]) mn[0] = x; if (y < mn[1]) mn[1] = y; if (z < mn[2]) mn[2] = z;
      if (x + 1 > mx[0]) mx[0] = x + 1; if (y + 1 > mx[1]) mx[1] = y + 1; if (z + 1 > mx[2]) mx[2] = z + 1;
    }
    return mn[0] === Infinity ? { min: [0, 0, 0], max: [0, 0, 0], empty: true } : { min: mn, max: mx, empty: false };
  }
}

/** 3D IoU of the occupancy of two same-sized grids. */
export function gridIoU(a, b) {
  if (a.nx !== b.nx || a.ny !== b.ny || a.nz !== b.nz) throw new Error('gridIoU: grid dims differ');
  let inter = 0, uni = 0;
  for (let i = 0; i < a.pal.length; i++) { const p = a.pal[i] !== 0, q = b.pal[i] !== 0; if (p && q) inter++; if (p || q) uni++; }
  return uni ? inter / uni : 0;
}

// =============================================================================================== Stage 1A — ortho views & visual hull
/**
 * Orthographic view conventions (right-handed cameras, image row 0 = top):
 *   top   : camera +Z looking −Z, up +Y → image right = +X, image up = +Y (bow up)        lattice (x, y)
 *   side  : camera +X looking −X, up +Z → image right = +Y (bow right), image up = +Z     lattice (y, z)
 *   front : camera +Y looking −Y, up +Z → image right = −X (port), image up = +Z          lattice (x, z)
 * Override per view with opts.flipU / opts.flipV = { top|side|front: true } when a blueprint is drawn mirrored.
 */
export const VIEW_CONVENTIONS = Object.freeze({
  top: { axes: [0, 1], mirrorU: false, camera: '+Z looking -Z, up +Y', right: '+X', up: '+Y' },
  side: { axes: [1, 2], mirrorU: false, camera: '+X looking -X, up +Z', right: '+Y', up: '+Z' },
  front: { axes: [0, 2], mirrorU: true, camera: '+Y looking -Y, up +Z', right: '-X', up: '+Z' },
});

/** Orthographic silhouettes of a grid as 1-channel masks (one pixel per voxel), using VIEW_CONVENTIONS. */
export function projectSilhouettes(grid) {
  const { nx, ny, nz } = grid;
  const top = createMask(nx, ny), side = createMask(ny, nz), front = createMask(nx, nz);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    if (!grid.pal[x + nx * (y + ny * z)]) continue;
    top.data[(ny - 1 - y) * nx + x] = 1;
    side.data[(nz - 1 - z) * ny + y] = 1;
    front.data[(nz - 1 - z) * nx + (nx - 1 - x)] = 1;
  }
  return { top, side, front };
}

/**
 * Derive hull dimensions from three blueprint views (bbox-normalised), and check their mutual consistency.
 * opts: { lengthY (world u, required unless pixelSize), pixelSize (u per top-view pixel), voxelScale (u/vox, default 3.5),
 *         margin (empty voxels per side, default 2), maskOpts }
 * Returns { size [X, Y, Z] u, dims [nx, ny, nz], bounds { min, max } (voxel), consistency { x, y, z } (relative
 *           mismatch between the two views that share each axis), maxMismatch, warnings[] }.
 */
export function hullDimsFromMasks(masks, opts = {}) {
  const { voxelScale = 3.5, margin = 2, maskOpts = {} } = opts;
  const bb = {};
  for (const v of ['top', 'side', 'front']) {
    if (masks[v] == null) throw new Error(`hullDimsFromMasks: ${v} view is required`);
    bb[v] = maskBBox(toMask(masks[v], maskOpts[v] || maskOpts));
    if (bb[v].empty) throw new Error(`hullDimsFromMasks: ${v} view mask is empty`);
  }
  const Y = opts.lengthY ?? (opts.pixelSize ? bb.top.h * opts.pixelSize : null);
  if (!Y) throw new Error('hullDimsFromMasks: give lengthY (world units) or pixelSize');
  const X = (Y * bb.top.w) / bb.top.h;          // top: w = X, h = Y
  const Z = (Y * bb.side.h) / bb.side.w;        // side: w = Y, h = Z
  const Xf = (Z * bb.front.w) / bb.front.h;     // front: w = X, h = Z
  const mis = Math.abs(X - Xf) / Math.max(X, Xf);
  const consistency = { x: r4(mis), y: 0, z: r4(mis) };   // Y is the anchor; the X/Z loop closes through the front view
  const warnings = [];
  if (mis > 0.03) warnings.push(`blueprint views disagree by ${(mis * 100).toFixed(1)} % on X/Z proportions (top+side vs front) — regenerate or re-register views (limit 3 %)`);
  const d = [X, Y, Z].map((v) => Math.max(1, Math.round(v / voxelScale)));
  return {
    size: [X, Y, Z].map(r4), voxelScale, dims: d.map((v) => v + 2 * margin),
    bounds: { min: [margin, margin, margin], max: d.map((v) => v + margin) },
    consistency, maxMismatch: r4(mis), warnings,
  };
}

/**
 * Stage 1A — 3-view visual hull: inside(x,y,z) = top(x,y) ∧ side(y,z) ∧ front(x,z).
 * masks: { top, side, front } — each a PNG path, PNG bytes, RGBA image or mask (missing views are unconstrained).
 * bounds: { min, max } voxel box that each view's silhouette bbox registers onto (default: whole grid).
 * opts: { fill (palette index, default 1), flags, mode: 'auto' | 'fill' | 'carve', registration: 'bbox' | 'full',
 *         samples (per-axis supersamples per voxel, default 2), coverage (0..1, default 0.5), maskOpts, flipU, flipV }
 * 'fill' writes hull cells into air; 'carve' removes solid cells outside the hull (F_LOCK cells survive); 'auto' picks
 * fill for an empty grid and carve otherwise. Returns { mode, filled, carved, kept, voxels, fidelity { top, side,
 * front } (2D IoU of the hull's re-projection vs the registered view on the voxel lattice), minFidelity, ms }.
 */
export function carveVisualHull(grid, masks, bounds = null, opts = {}) {
  const t0 = Date.now();
  const { fill = 1, flags, registration = 'bbox', samples = 2, coverage = 0.5, maskOpts = {}, flipU = {}, flipV = {} } = opts;
  const b = bounds || { min: [0, 0, 0], max: [grid.nx, grid.ny, grid.nz] };
  const dims = [grid.nx, grid.ny, grid.nz];
  const S = Math.max(1, Math.floor(samples)), need = coverage * S * S - 1e-9;
  const lat = {};
  for (const name of ['top', 'side', 'front']) {
    if (masks[name] == null) continue;
    const m = toMask(masks[name], maskOpts[name] || maskOpts);
    const bb = registration === 'bbox' ? maskBBox(m) : { x0: 0, y0: 0, w: m.width, h: m.height, empty: false };
    if (bb.empty) throw new Error(`carveVisualHull: ${name} mask is empty`);
    const [A, B] = VIEW_CONVENTIONS[name].axes;
    const mirrorU = VIEW_CONVENTIONS[name].mirrorU !== !!flipU[name], fv = !!flipV[name];
    const NA = dims[A], NB = dims[B], L = new Uint8Array(NA * NB);
    const a0 = b.min[A], a1 = b.max[A], b0 = b.min[B], b1 = b.max[B];
    for (let ib = Math.max(0, Math.floor(b0)); ib < Math.min(NB, Math.ceil(b1)); ib++) for (let ia = Math.max(0, Math.floor(a0)); ia < Math.min(NA, Math.ceil(a1)); ia++) {
      let hit = 0;
      for (let sb = 0; sb < S; sb++) for (let sa = 0; sa < S; sa++) {
        const ta = (ia + (sa + 0.5) / S - a0) / (a1 - a0), tb = (ib + (sb + 0.5) / S - b0) / (b1 - b0);
        if (ta < 0 || ta >= 1 || tb < 0 || tb >= 1) continue;
        const u = mirrorU ? 1 - ta : ta, v = fv ? tb : 1 - tb;
        const px = bb.x0 + Math.min(bb.w - 1, Math.floor(u * bb.w)), py = bb.y0 + Math.min(bb.h - 1, Math.floor(v * bb.h));
        if (m.data[py * m.width + px]) hit++;
      }
      L[ia + ib * NA] = hit >= need ? 1 : 0;
    }
    lat[name] = { A, B, NA, L };
  }
  if (!Object.keys(lat).length) throw new Error('carveVisualHull: need at least one of top / side / front');
  const { nx, ny, nz } = grid;
  const T = lat.top?.L, Sd = lat.side?.L, F = lat.front?.L;
  const mode = opts.mode && opts.mode !== 'auto' ? opts.mode : grid.count() ? 'carve' : 'fill';
  let filled = 0, carved = 0, kept = 0;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const inside = (!T || T[x + y * nx]) && (!Sd || Sd[y + z * ny]) && (!F || F[x + z * nx]);
    const i = x + nx * (y + ny * z);
    if (mode === 'fill') {
      if (inside && !grid.pal[i]) { grid.pal[i] = fill; if (flags !== undefined) grid.flags[i] = flags; filled++; }
    } else if (mode === 'carve') {
      if (!grid.pal[i]) continue;
      if (!inside && !(grid.flags[i] & F_LOCK)) { grid.pal[i] = 0; carved++; } else kept++;
    } else throw new Error(`carveVisualHull: bad mode ${mode}`);
  }
  // re-projection fidelity per view (on the voxel lattice, inside the registration bounds)
  const fidelity = {};
  for (const [name, { A, B, NA, L }] of Object.entries(lat)) {
    const P = new Uint8Array(L.length);
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      if (!grid.pal[x + nx * (y + ny * z)]) continue;
      const c = [x, y, z];
      if (c[A] < b.min[A] || c[A] >= b.max[A] || c[B] < b.min[B] || c[B] >= b.max[B]) continue;
      P[c[A] + c[B] * NA] = 1;
    }
    let inter = 0, uni = 0;
    for (let i = 0; i < L.length; i++) { if (L[i] && P[i]) inter++; if (L[i] || P[i]) uni++; }
    fidelity[name] = r4(uni ? inter / uni : 0);
  }
  return { mode, filled, carved, kept, voxels: grid.count(), fidelity, minFidelity: Math.min(...Object.values(fidelity)), ms: Date.now() - t0 };
}

// =============================================================================================== Stage 1B — detail zones
export const DETAIL_ZONE_KINDS = Object.freeze(['occluded_cavity', 'hero_superstructure', 'ventral_underhull', 'modular_prefab']);
export const CAMERA_VIEWS = Object.freeze(['interior_front', 'interior_side', 'oblique_closeup', 'ventral_34', 'dorsal_34', 'aft_34', 'bow_34', 'side_closeup', 'top_down_closeup']);

const Z = (zoneId, kind, cameraView, targetVoxelScale, frac, requiredFeatures) => ({ zoneId, kind, cameraView, targetVoxelScale, boundsFrac: frac, requiredFeatures });
/**
 * Reference checklists per megastructure archetype. boundsFrac = [[min], [max]] as fractions of the hull bbox
 * (−0.5 … +0.5 per axis, ship-local, +X starboard, +Y bow, +Z dorsal) — placeholders to be edited per ship.
 */
export const DETAIL_ZONE_ARCHETYPES = Object.freeze({
  hard_surface_carrier: {
    example: 'Hard-surface modular vessel / carrier', macroVoxelScale: 3.5,
    zones: [
      Z('catapult_trench', 'occluded_cavity', 'interior_front', 1.5, [[-0.12, 0.05, 0.10], [0.12, 0.5, 0.5]],
        ['open trench floor with white centreline + amber hazard ticks', 'roof rails / catapult shuttle track along both walls', 'cyan edge light strips on both lips', 'covered launch bay with amber ceiling lights', 'aft plasma hangar gate']),
      Z('flank_hangars', 'occluded_cavity', 'oblique_closeup', 1.5, [[-0.5, -0.25, -0.2], [-0.3, 0.2, 0.2]],
        ['recess depth >= 3 macro voxels on both flanks (mirror)', 'gantry cranes on the hangar ceiling', 'parked craft silhouettes', 'deck marking strips', 'ceiling + wall light rails (amber)']),
      Z('bridge_citadel', 'hero_superstructure', 'oblique_closeup', 1.2, [[-0.2, -0.3, 0.3], [0.2, 0.05, 0.5]],
        ['3 stepped citadel tiers', 'cyan viewport strips per tier (scale-cue micro-windows)', 'sensor mast + antenna', 'fore / aft railgun turrets', 'point-defence turrets on the flanks']),
      Z('aft_engine_cluster', 'hero_superstructure', 'aft_34', 1.5, [[-0.4, -0.5, -0.3], [0.4, -0.35, 0.3]],
        ['4 recessed plasma nozzle bells', 'octagonal engine housings', 'nozzle inner glow rings (emissive)', 'heat-sink fins between nozzles']),
      Z('ventral_keel', 'ventral_underhull', 'ventral_34', 2.0, [[-0.2, -0.45, -0.5], [0.2, 0.45, -0.3]],
        ['keel spine ridge', 'armour block rows', 'ventral hazard stripes / docking lights', 'ventral turrets or sensor blisters']),
      Z('turret_prefabs', 'modular_prefab', 'oblique_closeup', 1.2, [[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
        ['railgun turret prefab (twin barrels, 2+ vox thick)', 'PD turret prefab', 'hangar rib / crane prefab', 'instanced >= 4 times each']),
    ],
  },
  halo_mothership: {
    example: 'Ringed ornate temple structure', macroVoxelScale: 3.5,
    zones: [
      Z('launch_aperture_bore', 'occluded_cavity', 'interior_front', 1.5, [[-0.15, 0.25, -0.15], [0.15, 0.5, 0.15]],
        ['bore cut fully through the prow housing', 'glowing interior ring bands (emissive, evenly spaced)', 'rear glow gate', 'bore lip trim']),
      Z('crystal_core_well', 'occluded_cavity', 'oblique_closeup', 1.5, [[-0.2, -0.2, 0.0], [0.2, 0.2, 0.5]],
        ['central well with glowing cyan floor', 'faceted crystal core bipyramid (separate part)', 'armillary arches over the well', 'well wall terraces']),
      Z('terraced_deck_filigree', 'hero_superstructure', 'dorsal_34', 1.2, [[-0.5, -0.5, 0.1], [0.5, 0.5, 0.4]],
        ['gold / pearl concentric terraces', 'radial + circular light conduits', 'filigree trim on terrace edges', 'perimeter portals (evenly spaced)']),
      Z('ventral_spire', 'ventral_underhull', 'ventral_34', 1.5, [[-0.2, -0.2, -0.5], [0.2, 0.2, -0.1]],
        ['ventral crystal spire', 'gold pylons around the spire (8)', 'under-disc conduit ring']),
      Z('pylon_prefabs', 'modular_prefab', 'oblique_closeup', 1.2, [[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
        ['crystal pylon prefab', 'perimeter portal frame prefab', 'ring arc segment prefab']),
    ],
  },
  bio_leviathan: {
    example: 'Organic tentacled leviathan', macroVoxelScale: 3.5,
    zones: [
      Z('launch_maws', 'occluded_cavity', 'interior_front', 1.5, [[-0.35, 0.2, -0.3], [0.35, 0.5, 0.1]],
        ['twin hollow launch maws (both sides)', 'bone ribs lining each maw interior', 'teeth crown on the maw lip', 'glowing throat at the back (emissive lime)']),
      Z('dorsal_spine', 'hero_superstructure', 'dorsal_34', 1.5, [[-0.15, -0.4, 0.1], [0.15, 0.4, 0.5]],
        ['segmented spine carapace plates', 'translucent brood-pod clusters (emissive magenta)', 'spine ridge spikes']),
      Z('wing_rib_joints', 'hero_superstructure', 'oblique_closeup', 1.5, [[-0.5, -0.3, -0.1], [-0.15, 0.3, 0.2]],
        ['segmented chitin wing ribs', 'bone joint knuckles', 'Voronoi bio-vein membrane (emissive veins)', 'hooked wing-tip claws']),
      Z('ventral_ribcage', 'ventral_underhull', 'ventral_34', 2.0, [[-0.3, -0.4, -0.5], [0.3, 0.3, -0.2]],
        ['ventral ribcage arches', 'rear bio-tendril sockets', 'ventral vents / spore pores']),
      Z('bio_prefabs', 'modular_prefab', 'oblique_closeup', 1.2, [[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
        ['brood-pod prefab', 'chitin rib prefab', 'tooth / spike prefab']),
    ],
  },
  generic_megastructure: {
    example: 'Any large static structure: fortress, landmark, station, mech, building', macroVoxelScale: 3.5,
    zones: [
      Z('exterior_focal', 'hero_superstructure', 'oblique_closeup', 1.2, [[-0.25, -0.25, 0.2], [0.25, 0.25, 0.5]],
        ['primary focal mass (tower / bridge / head / keep) with stepped tiers', 'framed openings or viewports per tier', 'crowning element (mast, spire, antenna, crest)']),
      Z('occluded_cavity', 'occluded_cavity', 'interior_front', 1.5, [[-0.15, 0.2, -0.2], [0.15, 0.5, 0.15]],
        ['recess depth >= 3 macro voxels (gate, bay, courtyard, intake)', 'interior structure (ribs, beams, platforms)', 'interior lighting or emissive accents', 'framed lip / threshold trim']),
      Z('hero_accent', 'hero_superstructure', 'side_closeup', 1.5, [[-0.5, -0.4, -0.1], [-0.3, 0.4, 0.3]],
        ['repeated accent modules along the flank (buttresses, pods, turrets, pylons)', 'accent paint or trim bands', 'secondary silhouette breakers (fins, spikes, antennae)']),
      Z('under_structure', 'ventral_underhull', 'ventral_34', 2.0, [[-0.3, -0.45, -0.5], [0.3, 0.45, -0.3]],
        ['foundation / keel / base plinth', 'under-side panels or block rows', 'landing gear, supports or roots', 'under-side lights or vents']),
      Z('modular_prefabs', 'modular_prefab', 'oblique_closeup', 1.2, [[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
        ['repeated module prefab (window bay, turret, pylon, buttress)', 'secondary trim prefab', 'instanced >= 4 times each']),
    ],
  },
});
/** Archetype presets by name (alias of DETAIL_ZONE_ARCHETYPES). */
export const ARCHETYPES = DETAIL_ZONE_ARCHETYPES;

/**
 * detail_zones.json template for an archetype, with boundsLocal resolved against a hull size [X, Y, Z] (u).
 * opts.assetId names the asset (written as `assetId`); the older `shipId` option is still accepted (written as `shipId`).
 */
export function scaffoldDetailZones(archetype, { hullSize = [300, 1000, 200], assetId = undefined, shipId = undefined } = {}) {
  const a = DETAIL_ZONE_ARCHETYPES[archetype];
  if (!a) throw new Error(`scaffoldDetailZones: unknown archetype ${archetype} (${Object.keys(DETAIL_ZONE_ARCHETYPES).join(' | ')})`);
  const id = assetId ?? shipId ?? 'ship';
  if (typeof id !== 'string' || !id) throw new Error('scaffoldDetailZones: assetId / shipId must be a non-empty string');
  return {
    schema: ZONES_SCHEMA, ...(assetId !== undefined ? { assetId: id } : { shipId: id }), archetype, example: a.example, units: 'u', hullSize: hullSize.slice(), macroVoxelScale: a.macroVoxelScale,
    zones: a.zones.map((z) => ({
      zoneId: z.zoneId, kind: z.kind,
      boundsLocal: { min: z.boundsFrac[0].map((f, k) => r4(f * hullSize[k])), max: z.boundsFrac[1].map((f, k) => r4(f * hullSize[k])) },
      cameraView: z.cameraView, calloutImage: `callouts/${id}_${z.zoneId}.png`, targetVoxelScale: z.targetVoxelScale,
      requiredFeatures: z.requiredFeatures.slice(),
      ...(z.kind === 'occluded_cavity' ? { carve: [{ shape: 'box', min: z.boundsFrac[0].map((f, k) => r4(f * hullSize[k])), max: z.boundsFrac[1].map((f, k) => r4(f * hullSize[k])) }] } : {}),
      status: 'todo',
    })),
  };
}

/**
 * Validate a detail_zones.json document (or a bare zones array).
 * opts.hullBounds { min, max } (u) → warns when a zone lies outside the hull. The asset is named by `assetId` or the older
 * `shipId` alias (both optional). Returns { ok, errors[], warnings[], zones, assetId (assetId ?? shipId ?? null) }.
 */
export function validateDetailZones(doc, { hullBounds = null } = {}) {
  const errors = [], warnings = [];
  const zones = Array.isArray(doc) ? doc : doc && doc.zones;
  let assetId = null;
  if (!Array.isArray(doc) && doc && typeof doc === 'object') {
    if (doc.schema && doc.schema !== ZONES_SCHEMA) errors.push(`schema must be ${ZONES_SCHEMA} (got ${doc.schema})`);
    for (const k of ['assetId', 'shipId']) if (doc[k] !== undefined && (typeof doc[k] !== 'string' || !doc[k])) errors.push(`${k} must be a non-empty string`);
    if (typeof doc.assetId === 'string' && typeof doc.shipId === 'string' && doc.assetId && doc.shipId && doc.assetId !== doc.shipId) warnings.push(`assetId '${doc.assetId}' and its alias shipId '${doc.shipId}' differ — assetId wins`);
    assetId = (typeof doc.assetId === 'string' && doc.assetId) || (typeof doc.shipId === 'string' && doc.shipId) || null;
  }
  if (!Array.isArray(zones) || !zones.length) return { ok: false, errors: [...errors, 'zones[] missing or empty'], warnings, zones: [], assetId };
  const ids = new Set();
  const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
  zones.forEach((z, i) => {
    const tag = `zones[${i}]${z && z.zoneId ? ` (${z.zoneId})` : ''}`;
    if (!z || typeof z !== 'object') { errors.push(`${tag}: not an object`); return; }
    if (typeof z.zoneId !== 'string' || !/^[a-z0-9_]+$/.test(z.zoneId)) errors.push(`${tag}: zoneId must match [a-z0-9_]+`);
    else if (ids.has(z.zoneId)) errors.push(`${tag}: duplicate zoneId`); else ids.add(z.zoneId);
    if (!DETAIL_ZONE_KINDS.includes(z.kind)) errors.push(`${tag}: kind must be one of ${DETAIL_ZONE_KINDS.join(' | ')}`);
    const b = z.boundsLocal;
    if (!b || !vec3(b.min) || !vec3(b.max)) errors.push(`${tag}: boundsLocal { min[3], max[3] } required`);
    else {
      if (!b.min.every((v, k) => v < b.max[k])) errors.push(`${tag}: boundsLocal.min must be < max on every axis`);
      if (hullBounds && b.max.some((v, k) => v < hullBounds.min[k]) || hullBounds && b.min.some((v, k) => v > hullBounds.max[k])) warnings.push(`${tag}: boundsLocal lies outside the hull bounds`);
    }
    if (typeof z.cameraView !== 'string' || !z.cameraView) errors.push(`${tag}: cameraView required`);
    else if (!CAMERA_VIEWS.includes(z.cameraView)) warnings.push(`${tag}: non-standard cameraView '${z.cameraView}'`);
    if (typeof z.calloutImage !== 'string' || !z.calloutImage) errors.push(`${tag}: calloutImage path required`);
    if (typeof z.targetVoxelScale !== 'number' || !(z.targetVoxelScale > 0)) errors.push(`${tag}: targetVoxelScale must be > 0`);
    else if (z.targetVoxelScale < 0.8 || z.targetVoxelScale > 4.0) warnings.push(`${tag}: targetVoxelScale ${z.targetVoxelScale} outside the 0.8–4.0 u/vox megastructure range`);
    if (!Array.isArray(z.requiredFeatures) || !z.requiredFeatures.length || !z.requiredFeatures.every((f) => typeof f === 'string' && f.trim())) errors.push(`${tag}: requiredFeatures[] must be a non-empty string list`);
    if (z.kind === 'occluded_cavity' && !(Array.isArray(z.carve) && z.carve.length)) warnings.push(`${tag}: occluded_cavity without carve[] — the visual hull cannot recover it; add CSG subtractions`);
    if (z.carve !== undefined) {
      if (!Array.isArray(z.carve)) errors.push(`${tag}: carve must be an array`);
      else z.carve.forEach((c, k) => { try { shapeFromSpec(c); } catch (e) { errors.push(`${tag}: carve[${k}]: ${e.message}`); } });
    }
  });
  return { ok: errors.length === 0, errors, warnings, zones, assetId };
}

/** ship-local u → voxel coordinates: v = p / voxelScale + center */
export const localToVoxel = (p, voxelScale, center) => p.map((v, k) => v / voxelScale + center[k]);

/** Stage 2 macro cavity subtraction: apply every zone's carve[] (ship-local u) to a macro grid. → { total, perZone } */
export function applyDetailZoneCarves(grid, doc, { voxelScale = 1, center = [0, 0, 0], force = false } = {}) {
  const zones = Array.isArray(doc) ? doc : doc.zones;
  const perZone = {};
  let total = 0;
  for (const z of zones) {
    if (!Array.isArray(z.carve)) continue;
    let n = 0;
    for (const c of z.carve) n += grid.subtract(shapeFromSpec(c, (p) => localToVoxel(p, voxelScale, center), (v) => v / voxelScale), { force });
    perZone[z.zoneId] = n; total += n;
  }
  return { total, perZone };
}

/** solid / air / cavity-air voxel counts inside a zone's boundsLocal. */
export function zoneVoxelStats(grid, zone, { voxelScale = 1, center = [0, 0, 0] } = {}) {
  const mn = localToVoxel(zone.boundsLocal.min, voxelScale, center), mx = localToVoxel(zone.boundsLocal.max, voxelScale, center);
  let solid = 0, air = 0, cavityAir = 0;
  for (let z = Math.max(0, Math.floor(mn[2])); z < Math.min(grid.nz, Math.ceil(mx[2])); z++)
    for (let y = Math.max(0, Math.floor(mn[1])); y < Math.min(grid.ny, Math.ceil(mx[1])); y++)
      for (let x = Math.max(0, Math.floor(mn[0])); x < Math.min(grid.nx, Math.ceil(mx[0])); x++) {
        const i = grid.index(x, y, z);
        if (grid.pal[i]) solid++; else { air++; if (grid.flags[i] & F_CAVITY) cavityAir++; }
      }
  return { solid, air, cavityAir };
}

// =============================================================================================== Stage 3 — macro cavity AO
function boxBlur3D(src, nx, ny, nz, r) {
  let a = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) a[i] = src[i] ? 1 : 0;
  if (r <= 0) return a;
  const dimsArr = [nx, ny, nz], strides = [1, nx, nx * ny];
  let b = new Float32Array(src.length);
  for (let ax = 0; ax < 3; ax++) {
    const o1 = (ax + 1) % 3, o2 = (ax + 2) % 3;             // the two other axes
    const n = dimsArr[ax], st = strides[ax], n1 = dimsArr[o1], s1 = strides[o1], n2 = dimsArr[o2], s2 = strides[o2];
    for (let j2 = 0; j2 < n2; j2++) for (let j1 = 0; j1 < n1; j1++) {
      const base = j1 * s1 + j2 * s2;
      let sum = 0;
      for (let k = 0; k <= Math.min(r, n - 1); k++) sum += a[base + k * st];
      for (let k = 0; k < n; k++) {
        b[base + k * st] = sum / (2 * r + 1);
        const add = k + r + 1, rem = k - r;
        if (add < n) sum += a[base + add * st];
        if (rem >= 0) sum -= a[base + rem * st];
      }
    }
    const t = a; a = b; b = t;
  }
  return a;
}
/** K cosine-weighted Fibonacci hemisphere directions around +Z (deterministic, no RNG). */
export function hemisphereDirs(K) {
  const out = [];
  for (let i = 0; i < K; i++) {
    const u = (i + 0.5) / K, r = Math.sqrt(u), phi = i * 2.399963229728653;
    out.push([r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(Math.max(0, 1 - u))]);
  }
  return out;
}
function onb(n) {   // Duff et al. 2017 branchless orthonormal basis
  const s = n[2] >= 0 ? 1 : -1, a = -1 / (s + n[2]), b = n[0] * n[1] * a;
  return [[1 + s * n[0] * n[0] * a, s * b, -s * n[0]], [b, s + n[1] * n[1] * a, -n[1]]];
}

/**
 * Stage 3 macro cavity AO: for every exposed face, cast `rays` cosine-weighted hemisphere rays through the fine
 * occupancy (step `step` voxels, up to `maxDist`), weighting a hit at distance t by 1 − (t / maxDist)^falloff.
 * The hemisphere is oriented on a SMOOTHED surface normal (−∇ of a box-blurred occupancy, radius blurRadius) and the
 * ray origin is pushed `startOffset` voxels along it, so voxel staircases on convex slopes do not self-occlude
 * (no convex-staircase greying) while hangars, trenches and under-wing corners darken. Rays leaving the grid escape.
 * opts: { rays 24, maxDist 24, step 1, blurRadius 2, startOffset 1.0, falloff 2, strength 1 }
 * Returns { data: Uint8Array(n*6) (255 = fully visible; index voxel*6 + face), get(x, y, z, face) → 0..1, stats }.
 */
export function bakeMacroCavityAO(grid, opts = {}) {
  const { rays = 24, maxDist = 24, step = 1, blurRadius = 2, startOffset = 1.0, falloff = 2, strength = 1 } = opts;
  const t0 = Date.now();
  const { nx, ny, nz } = grid, nxy = nx * ny, occ = grid.pal;
  const B = boxBlur3D(occ, nx, ny, nz, blurRadius);
  const dirs = hemisphereDirs(rays);
  const data = new Uint8Array(occ.length * 6).fill(255);
  const dens = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz ? 0 : B[x + nx * (y + ny * z)]);
  const solidAt = (x, y, z) => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return -1;
    return occ[ix + nx * (iy + ny * iz)] ? 1 : 0;
  };
  let faces = 0, sum = 0, mn = 1, mx = 0;
  const fn = [0, 0, 0], ns = [0, 0, 0];
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const vi = x + nx * (y + ny * z);
    if (!occ[vi]) continue;
    for (let f = 0; f < 6; f++) {
      const d = f >> 1, s = f & 1 ? -1 : 1;
      const qx = x + (d === 0 ? s : 0), qy = y + (d === 1 ? s : 0), qz = z + (d === 2 ? s : 0);
      if (qx >= 0 && qy >= 0 && qz >= 0 && qx < nx && qy < ny && qz < nz && occ[qx + nx * (qy + ny * qz)]) continue;
      fn[0] = d === 0 ? s : 0; fn[1] = d === 1 ? s : 0; fn[2] = d === 2 ? s : 0;
      // smoothed normal at the outward air cell q
      let gx = dens(qx - 1, qy, qz) - dens(qx + 1, qy, qz), gy = dens(qx, qy - 1, qz) - dens(qx, qy + 1, qz), gz = dens(qx, qy, qz - 1) - dens(qx, qy, qz + 1);
      const gl = Math.hypot(gx, gy, gz);
      if (gl > 1e-6 && (gx * fn[0] + gy * fn[1] + gz * fn[2]) / gl > 0.2) { ns[0] = gx / gl; ns[1] = gy / gl; ns[2] = gz / gl; }
      else { ns[0] = fn[0]; ns[1] = fn[1]; ns[2] = fn[2]; }
      // ray origin: outward air-cell centre pushed along the smoothed normal (fallback: the air-cell centre)
      const cx = x + 0.5 + fn[0], cy = y + 0.5 + fn[1], cz = z + 0.5 + fn[2];
      let px = cx + ns[0] * startOffset, py = cy + ns[1] * startOffset, pz = cz + ns[2] * startOffset;
      if (solidAt(px, py, pz) === 1) { px = cx; py = cy; pz = cz; }
      const [T, Bt] = onb(ns);
      let occSum = 0;
      for (let r = 0; r < rays; r++) {
        const [lx, ly, lz] = dirs[r];
        const Dx = T[0] * lx + Bt[0] * ly + ns[0] * lz, Dy = T[1] * lx + Bt[1] * ly + ns[1] * lz, Dz = T[2] * lx + Bt[2] * ly + ns[2] * lz;
        for (let t = step; t <= maxDist; t += step) {
          const h = solidAt(px + Dx * t, py + Dy * t, pz + Dz * t);
          if (h < 0) break;
          if (h === 1) { occSum += 1 - Math.pow(t / maxDist, falloff); break; }
        }
      }
      const vis = clamp(1 - (strength * occSum) / rays, 0, 1);
      data[vi * 6 + f] = Math.round(vis * 255);
      faces++; sum += vis; if (vis < mn) mn = vis; if (vis > mx) mx = vis;
    }
  }
  return {
    data, nx, ny, nz, rays, maxDist,
    get: (x, y, z, f) => data[(x + nx * (y + ny * z)) * 6 + f] / 255,
    stats: { faces, mean: faces ? sum / faces : 1, min: faces ? mn : 1, max: faces ? mx : 1, ms: Date.now() - t0 },
    opts: { rays, maxDist, step, blurRadius, startOffset, falloff, strength },
  };
}

// =============================================================================================== Stage 2/3 — greedy mesher
const AXES = [[0, 1, 2], [1, 2, 0], [2, 0, 1]];   // d, u, v with e_u × e_v = e_d (cyclic) — as in the verified reference mesher

/**
 * AO-preserving greedy mesher (port of the verified reference WebGL2 / Three.js megastructure mesher, extended for v2.0).
 * Cells merge only when (palette, 4 micro-AO corners, macro-AO level, matTag) are identical AND the micro AO does not
 * vary along the merge direction → merged quads reproduce per-voxel silhouette + interpolated AO exactly. The quad
 * diagonal flips when ao00 + ao11 < ao10 + ao01. Vertices are de-duplicated exactly.
 * opts: { voxelScale 1, center [0,0,0] (voxel coords of the local origin), macroAo (bakeMacroCavityAO result | null),
 *         macroLevels 8 (2..16 quantisation steps — fewer = more merging), format 'MEGA_V2' | 'FLOAT11' | 'MEGA_V22', name }
 * matTag per voxel = flags & MAT_MASK, else the palette entry's matTag.
 * format 'MEGA_V22' (svox.mega/v2.2) returns the same 12-float MEGA_V2 vertices PLUS `extra` (3 floats / vertex):
 *   bevelHint  1 on the convex corners of narrow (≤ 2 vox) quads — stepped 45° chamfer treads, strap crests, rib tops
 *   creaseMask 1 on the concave corners of narrow quads — step risers' feet, grooves, recess floors, panel slots
 *   panelId    grid.panel sub-assembly id (0..255) / 255 — cells only merge inside one panel, so panel boundaries are
 *              real quad edges (crisp tonal breaks between adjacent armour plates, no repeated tiling)
 * MEGA_V2 / FLOAT11 output is byte-identical to v2.0/v2.1 (extras off).
 * opts.region { min [3], max [3] } (voxel coords, max exclusive) meshes only the cells inside the box while exposure, micro
 * AO and the macro AO still see the whole grid — split one hull into 2–3 macro parts (each ≤ 65 535 vertices → Uint16
 * indices in v2.2) without seams in the shading.
 */
export function greedyMeshPart(grid, palette, opts = {}) {
  const { voxelScale = 1, center = [0, 0, 0], macroAo = null, macroLevels = 8, name = 'part' } = opts;
  const format = opts.format || 'MEGA_V2';
  if (format !== 'MEGA_V2' && !isFloat11(format) && format !== 'MEGA_V22') throw new Error(`greedyMeshPart: format must be MEGA_V2 | FLOAT11 | MEGA_V22 (got ${format})`);
  const X = format === 'MEGA_V22';
  if (!(macroLevels >= 2 && macroLevels <= 16)) throw new Error('greedyMeshPart: macroLevels must be 2..16');
  if (macroAo && (macroAo.nx !== grid.nx || macroAo.ny !== grid.ny || macroAo.nz !== grid.nz)) throw new Error('greedyMeshPart: macroAo was baked for a different grid');
  const FL = isFloat11(format) ? 11 : 12;
  const N = [grid.nx, grid.ny, grid.nz], off = grid.offset, nx = grid.nx, nxy = grid.nx * grid.ny;
  const R = Math.max(...N) + 1;
  if (R ** 3 * 6 * 256 * 4 * 16 * 16 > Number.MAX_SAFE_INTEGER) throw new Error('greedyMeshPart: grid too large for the exact vertex key — split it into parts');
  const verts = [], idx = [], vmap = new Map(), extra = [];
  let exposed = 0, quads = 0;
  const pal = grid.pal, flg = grid.flags, pan = X ? grid.panel : null;
  const solid = (p) => p[0] >= 0 && p[1] >= 0 && p[2] >= 0 && p[0] < N[0] && p[1] < N[1] && p[2] < N[2] && pal[p[0] + nx * p[1] + nxy * p[2]] !== 0;
  const rg = opts.region || null;
  const inRegion = rg ? (p) => p[0] >= rg.min[0] && p[1] >= rg.min[1] && p[2] >= rg.min[2] && p[0] < rg.max[0] && p[1] < rg.max[1] && p[2] < rg.max[2] : null;
  const bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
  const vert = (p, f, n, palI, ao, ml, mat, xb = 0, xc = 0, xp = 0) => {
    const nk = ((((((p[0] * R + p[1]) * R + p[2]) * 6 + f) * 256 + palI) * 4 + ao) * 16 + ml) * 16 + mat;
    const key = X ? `${nk}:${xb}${xc}:${xp}` : nk;
    let id = vmap.get(key);
    if (id === undefined) {
      id = verts.length / FL;
      const e = palette.entry(palI), mAo = ml / (macroLevels - 1);
      const px = (p[0] + off[0] - center[0]) * voxelScale, py = (p[1] + off[1] - center[1]) * voxelScale, pz = (p[2] + off[2] - center[2]) * voxelScale;
      verts.push(px, py, pz, n[0], n[1], n[2], e.rgb[0], e.rgb[1], e.rgb[2], e.em);
      if (FL === 12) verts.push(ao / 3, mat * 256 + Math.round(mAo * 255)); else verts.push((ao / 3) * mAo);
      if (X) extra.push(xb, xc, xp / 255);
      if (px < bmin[0]) bmin[0] = px; if (py < bmin[1]) bmin[1] = py; if (pz < bmin[2]) bmin[2] = pz;
      if (px > bmax[0]) bmax[0] = px; if (py > bmax[1]) bmax[1] = py; if (pz > bmax[2]) bmax[2] = pz;
      vmap.set(key, id);
    }
    return id;
  };
  const c = [0, 0, 0], q = [0, 0, 0], a = [0, 0, 0], b = [0, 0, 0], cc = [0, 0, 0], t3 = [0, 0, 0];
  // v2.2: is the lattice corner (layer cell plane at d = i, in-plane corner (U, V)) on a convex boundary of the solid layer
  // (some of the 4 solid-layer cells around it are air) with nothing solid in front of it (all 4 air-layer cells empty)?
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
  for (const [d, u, v] of AXES) {
    const nu = N[u], nv = N[v];
    const mask = new Float64Array(nu * nv);
    for (const s of [1, -1]) {
      const f = d * 2 + (s > 0 ? 0 : 1);
      const nrm = [0, 0, 0]; nrm[d] = s;
      for (let i = 0; i < N[d]; i++) {
        mask.fill(0);
        for (let jv = 0; jv < nv; jv++) for (let ju = 0; ju < nu; ju++) {
          c[d] = i; c[u] = ju; c[v] = jv;
          const vi = c[0] + nx * c[1] + nxy * c[2];
          const pi = pal[vi];
          if (!pi) continue;
          if (inRegion && !inRegion(c)) continue;
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
            aoBits |= (s1 && s2 ? 0 : 3 - (s1 + s2 + s3)) << (8 + 2 * k);
          }
          const ml = macroAo ? Math.round((macroAo.data[vi * 6 + f] / 255) * (macroLevels - 1)) : macroLevels - 1;
          const mat = (flg[vi] & MAT_MASK) || palette.tag(pi);
          mask[ju + jv * nu] = (pi | aoBits | (ml << 16) | (mat << 20) | (1 << 24)) + (pan ? pan[vi] * 33554432 : 0);
        }
        for (let jv = 0; jv < nv; jv++) for (let ju = 0; ju < nu;) {
          const key = mask[ju + jv * nu];
          if (!key) { ju++; continue; }
          const a00 = (key >> 8) & 3, a10 = (key >> 10) & 3, a01 = (key >> 12) & 3, a11 = (key >> 14) & 3;
          const canU = a00 === a10 && a01 === a11, canV = a00 === a01 && a10 === a11;
          let w = 1;
          if (canU) while (ju + w < nu && mask[ju + w + jv * nu] === key) w++;
          let h = 1;
          if (canV) {
            outer: while (jv + h < nv) {
              for (let k = 0; k < w; k++) if (mask[ju + k + (jv + h) * nu] !== key) break outer;
              h++;
            }
          }
          for (let y2 = 0; y2 < h; y2++) for (let x2 = 0; x2 < w; x2++) mask[ju + x2 + (jv + y2) * nu] = 0;
          const lo = key % 33554432, pid = (key - lo) / 33554432;
          const palI = lo & 255, ml = (lo >> 16) & 15, mat = (lo >> 20) & 15;
          const plane = i + (s > 0 ? 1 : 0);
          const corner = (cu, cv) => { const p = [0, 0, 0]; p[d] = plane; p[u] = ju + cu * w; p[v] = jv + cv * h; return p; };
          const narrow = X && Math.min(w, h) <= 2;
          const xb = (cu, cv) => (narrow && convexAt(d, u, v, i, s, ju + cu * w, jv + cv * h) ? 1 : 0);
          const xc = (ao) => (narrow && ao < 3 ? 1 : 0);
          const i00 = vert(corner(0, 0), f, nrm, palI, a00, ml, mat, xb(0, 0), xc(a00), pid), i10 = vert(corner(1, 0), f, nrm, palI, a10, ml, mat, xb(1, 0), xc(a10), pid);
          const i01 = vert(corner(0, 1), f, nrm, palI, a01, ml, mat, xb(0, 1), xc(a01), pid), i11 = vert(corner(1, 1), f, nrm, palI, a11, ml, mat, xb(1, 1), xc(a11), pid);
          const tris = a00 + a11 < a10 + a01 ? [[i10, i11, i01], [i10, i01, i00]] : [[i00, i10, i11], [i00, i11, i01]];
          for (const t of tris) { if (s > 0) idx.push(t[0], t[1], t[2]); else idx.push(t[0], t[2], t[1]); }
          quads++;
          ju += w;
        }
      }
    }
  }
  const vertexCount = verts.length / FL;
  return {
    name, format, floats: FL, verts: new Float32Array(verts), idx: new Uint32Array(idx), ...(X ? { extra: new Float32Array(extra), extraFloats: 3 } : {}),
    vertexCount, indexCount: idx.length, triangles: idx.length / 3, quads, exposedFaces: exposed,
    reduction: exposed ? 1 - quads / exposed : 0, voxels: rg ? countRegion(grid, rg) : grid.count(), dims: N.slice(), voxelScale, center: center.slice(), ...(rg ? { region: { min: rg.min.slice(), max: rg.max.slice() } } : {}),
    bounds: vertexCount ? { min: bmin, max: bmax } : { min: [0, 0, 0], max: [0, 0, 0] },
  };
}

function countRegion(g, rg) {
  let n = 0;
  for (let z = Math.max(0, rg.min[2]); z < Math.min(g.nz, rg.max[2]); z++) for (let y = Math.max(0, rg.min[1]); y < Math.min(g.ny, rg.max[1]); y++)
    for (let x = Math.max(0, rg.min[0]); x < Math.min(g.nx, rg.max[0]); x++) if (g.pal[x + g.nx * (y + g.ny * z)]) n++;
  return n;
}
/** decode MEGA_V2 meta float → { matTag, macroAo } */
export const decodeMeta = (m) => ({ matTag: Math.floor(m / 256), macroAo: (m % 256) / 255 });

// =============================================================================================== v2.2 quantized 20 B/vert codec
const r6 = (v) => Math.round(v * 1e6) / 1e6;
/**
 * Pack a mesh into the svox.mega/v2.2 `packed20` vertex stream (MEGA_V22_LAYOUT, little-endian, 20 B / vertex).
 * meshData: { verts (MEGA_V2 12 floats / vertex), extra? (3 floats / vertex: bevelHint, creaseMask, panelId 0..1),
 *             vertexCount?, bounds? } — or any greedyMeshPart result. opts.center / opts.halfExt override the AABB.
 * Position: q = round(clamp((p − center) / halfExt, −1, 1) · 32767) — center / halfExt are rounded to 1e-6 BEFORE
 * quantising, so the JSON values decode the stream exactly. Returns { bytes (Uint8Array), vertexCount, stride: 20,
 * posCenter [3], posHalfExt [3], maxPosError (u) }.
 */
export function packQuantizedMegaV22(meshData, opts = {}) {
  const V = meshData.verts, E = meshData.extra || null;
  const n = meshData.vertexCount ?? V.length / 12;
  if (V.length !== n * 12) throw new Error(`packQuantizedMegaV22: expected ${n} × 12 floats (MEGA_V2 layout), got ${V.length}`);
  if (E && E.length !== n * 3) throw new Error(`packQuantizedMegaV22: extra must hold 3 floats per vertex (${n * 3}), got ${E.length}`);
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { const v = V[i * 12 + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
  if (!n) { mn = [0, 0, 0]; mx = [0, 0, 0]; }
  const center = (opts.center || mn.map((v, k) => (v + mx[k]) / 2)).map(r6);
  // half extent rounded UP (1e-4) and never 0 → |p − c| ≤ h always, the clamp is a no-op for in-bounds data
  const halfExt = (opts.halfExt || mn.map((v, k) => Math.max(Math.abs(mx[k] - center[k]), Math.abs(v - center[k])))).map((h) => Math.max(1e-3, Math.ceil(h * 1e4 + 1e-6) / 1e4));
  const buf = new ArrayBuffer(n * 20), dv = new DataView(buf);
  const q16 = (x) => Math.round(clamp(x, -1, 1) * 32767), q8s = (x) => Math.round(clamp(x, -1, 1) * 127), q8 = (x) => Math.round(clamp(x, 0, 1) * 255);
  let maxErr = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 12, b = i * 20;
    for (let k = 0; k < 3; k++) {
      const q = q16((V[o + k] - center[k]) / halfExt[k]);
      dv.setInt16(b + k * 2, q, true);
      const err = Math.abs(center[k] + (q / 32767) * halfExt[k] - V[o + k]);
      if (err > maxErr) maxErr = err;
    }
    dv.setInt16(b + 6, q16(E ? E[i * 3] : 0), true);                                   // bevelHint
    for (let k = 0; k < 3; k++) dv.setInt8(b + 8 + k, q8s(V[o + 3 + k]));              // normal
    dv.setInt8(b + 11, Math.round(clamp(V[o + 10], 0, 1) * 127));                     // micro AO (positive half)
    for (let k = 0; k < 3; k++) dv.setUint8(b + 12 + k, q8(V[o + 6 + k]));            // albedo
    dv.setUint8(b + 15, q8(V[o + 9]));                                                 // emissive
    const m = V[o + 11], tag = Math.floor(m / 256);
    dv.setUint8(b + 16, clamp(tag, 0, 255));                                           // matTag (raw byte)
    dv.setUint8(b + 17, Math.round(m - tag * 256));                                    // macroAo (already 0..255)
    dv.setUint8(b + 18, q8(E ? E[i * 3 + 1] : 0));                                     // creaseMask
    dv.setUint8(b + 19, q8(E ? E[i * 3 + 2] : 0));                                     // panelId
  }
  return { bytes: new Uint8Array(buf), vertexCount: n, stride: 20, posCenter: center, posHalfExt: halfExt, maxPosError: maxErr };
}

/**
 * Decode a `packed20` stream (Uint8Array / Buffer / ArrayBuffer view) back to MEGA_V2 12-float vertices + extras.
 * Returns { verts (Float32Array n·12, meta = matTag·256 + macroAo·255 exactly as MEGA_V2), extra (Float32Array n·3:
 * bevelHint, creaseMask, panelId 0..1), vertexCount }.
 */
export function unpackQuantizedMegaV22(bytes, vertexCount, posCenter, posHalfExt) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength);
  const n = vertexCount ?? u8.byteLength / 20;
  if (u8.byteLength < n * 20) throw new Error(`unpackQuantizedMegaV22: ${u8.byteLength} bytes < ${n} × 20`);
  const dv = new DataView(u8.buffer, u8.byteOffset, n * 20);
  const verts = new Float32Array(n * 12), extra = new Float32Array(n * 3);
  const sn16 = (q) => Math.max(q / 32767, -1), sn8 = (q) => Math.max(q / 127, -1);
  for (let i = 0; i < n; i++) {
    const o = i * 12, b = i * 20;
    for (let k = 0; k < 3; k++) verts[o + k] = posCenter[k] + sn16(dv.getInt16(b + k * 2, true)) * posHalfExt[k];
    extra[i * 3] = Math.max(0, sn16(dv.getInt16(b + 6, true)));
    for (let k = 0; k < 3; k++) verts[o + 3 + k] = sn8(dv.getInt8(b + 8 + k));
    for (let k = 0; k < 3; k++) verts[o + 6 + k] = dv.getUint8(b + 12 + k) / 255;
    verts[o + 9] = dv.getUint8(b + 15) / 255;
    verts[o + 10] = Math.max(0, sn8(dv.getInt8(b + 11)));
    verts[o + 11] = dv.getUint8(b + 16) * 256 + dv.getUint8(b + 17);
    extra[i * 3 + 1] = dv.getUint8(b + 18) / 255;
    extra[i * 3 + 2] = dv.getUint8(b + 19) / 255;
  }
  return { verts, extra, vertexCount: n };
}

// =============================================================================================== v2.3 quad16 (16 B / quad)
/**
 * Pack quad records into the svox.mega/v2.3 `quad16` stream (QUAD16_LAYOUT). A record:
 * { origin [ix, iy, iz] (0..65535), du, dv (1..255), dir (0..5), rgb [r, g, b] 0..255, em 0..255, bevelQ 0..3, creaseQ 0..3,
 *   diagFlip 0 | 1, ao [a0, a1, a2, a3] 0..3 (k = cu + 2cv), macroAo 0..255, matTag 0..15, panelId 0..15 }.
 * Out-of-range fields throw (no silent wrap). → Uint8Array(n · 16).
 */
export function packQuad16(records) {
  const n = records.length, buf = new ArrayBuffer(n * 16), dv = new DataView(buf);
  const int = (v, lo, hi, what, i) => { if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`packQuad16: quad ${i} ${what} ${v} outside ${lo}..${hi}`); return v; };
  for (let i = 0; i < n; i++) {
    const q = records[i], b = i * 16;
    for (let k = 0; k < 3; k++) dv.setUint16(b + k * 2, int(q.origin[k], 0, 65535, 'origin', i), true);
    dv.setUint8(b + 6, int(q.du, 1, 255, 'du', i)); dv.setUint8(b + 7, int(q.dv, 1, 255, 'dv', i));
    for (let k = 0; k < 3; k++) dv.setUint8(b + 8 + k, int(q.rgb[k], 0, 255, 'rgb', i));
    dv.setUint8(b + 11, int(q.em || 0, 0, 255, 'em', i));
    dv.setUint8(b + 12, int(q.dir, 0, 5, 'dir', i) | (int(q.bevelQ || 0, 0, 3, 'bevelQ', i) << 3) | (int(q.creaseQ || 0, 0, 3, 'creaseQ', i) << 5) | (int(q.diagFlip ? 1 : 0, 0, 1, 'diagFlip', i) << 7));
    const ao = q.ao || [3, 3, 3, 3];
    dv.setUint8(b + 13, int(ao[0], 0, 3, 'ao', i) | (int(ao[1], 0, 3, 'ao', i) << 2) | (int(ao[2], 0, 3, 'ao', i) << 4) | (int(ao[3], 0, 3, 'ao', i) << 6));
    dv.setUint8(b + 14, int(q.macroAo ?? 255, 0, 255, 'macroAo', i));
    dv.setUint8(b + 15, int(q.matTag || 0, 0, 15, 'matTag', i) | (int(q.panelId || 0, 0, 15, 'panelId', i) << 4));
  }
  return new Uint8Array(buf);
}

/** Decode a `quad16` stream (Uint8Array / Buffer / ArrayBuffer view) back to packQuad16 records (bit-exact inverse). */
export function unpackQuad16(bytes, quadCount) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength);
  const n = quadCount ?? u8.byteLength / 16;
  if (!Number.isInteger(n) || u8.byteLength < n * 16) throw new Error(`unpackQuad16: ${u8.byteLength} bytes < ${n} × 16`);
  const dv = new DataView(u8.buffer, u8.byteOffset, n * 16), out = new Array(n);
  for (let i = 0; i < n; i++) {
    const b = i * 16, mx = dv.getUint8(b + 12), ao = dv.getUint8(b + 13), mw = dv.getUint8(b + 15);
    out[i] = {
      origin: [dv.getUint16(b, true), dv.getUint16(b + 2, true), dv.getUint16(b + 4, true)], du: dv.getUint8(b + 6), dv: dv.getUint8(b + 7),
      rgb: [dv.getUint8(b + 8), dv.getUint8(b + 9), dv.getUint8(b + 10)], em: dv.getUint8(b + 11),
      dir: mx & 7, bevelQ: (mx >> 3) & 3, creaseQ: (mx >> 5) & 3, diagFlip: (mx >> 7) & 1,
      ao: [ao & 3, (ao >> 2) & 3, (ao >> 4) & 3, (ao >> 6) & 3], macroAo: dv.getUint8(b + 14), matTag: mw & 15, panelId: mw >> 4,
    };
  }
  return out;
}

const UNIT_QUAD = [[0, 0], [1, 0], [1, 1], [0, 1]];
/** quad16 unit-quad corner c (0..3) of a record → in-quad lattice corner (cu, cv) — the exact rule CAPITAL_QUAD16_VERT uses. */
export function quad16Corner(rec, c) {
  let [x, y] = UNIT_QUAD[c];
  if (rec.diagFlip) [x, y] = [1 - y, x];            // rotate 90°: diagonal 00–11 → 10–01
  if (rec.dir & 1) [x, y] = [y, x];                 // negative face: mirror → reversed (CCW-outward) winding
  return [x, y];
}

/**
 * Expand a quad16 stream into MEGA_V2 12-float vertices (4 per quad, not de-duplicated) + Uint32 indices + v2.2 extras
 * (bevelHint, creaseMask, panelId 0..1) — the reference decoder behind readMegaAsset / renderPreview / G5 for v2.3 parts.
 * gridOrigin (u) / voxelScale come from the part JSON. → { verts, extra, idx, vertexCount, indexCount, floats: 12, quads }.
 */
export function quad16ToMesh(bytes, quadCount, gridOrigin, voxelScale) {
  const recs = Array.isArray(bytes) ? bytes : unpackQuad16(bytes, quadCount);
  const n = recs.length, verts = new Float32Array(n * 48), extra = new Float32Array(n * 12), idx = new Uint32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const q = recs[i], d = q.dir >> 1, s = q.dir & 1 ? -1 : 1, u = (d + 1) % 3, v = (d + 2) % 3;
    for (let c = 0; c < 4; c++) {
      const [cu, cv] = quad16Corner(q, c), k = cu + 2 * cv, ao = q.ao[k], o = (i * 4 + c) * 12, e = (i * 4 + c) * 3;
      const L = q.origin.slice(); L[u] += cu * q.du; L[v] += cv * q.dv;
      for (let a = 0; a < 3; a++) { verts[o + a] = gridOrigin[a] + L[a] * voxelScale; verts[o + 3 + a] = a === d ? s : 0; verts[o + 6 + a] = q.rgb[a] / 255; }
      verts[o + 9] = q.em / 255; verts[o + 10] = ao / 3; verts[o + 11] = q.matTag * 256 + q.macroAo;
      extra[e] = ao === 3 ? q.bevelQ / 3 : 0; extra[e + 1] = ao < 3 ? q.creaseQ / 3 : 0; extra[e + 2] = q.panelId / 15;
    }
    idx.set([0, 1, 2, 0, 2, 3].map((t) => i * 4 + t), i * 6);
  }
  return { verts, extra, idx, vertexCount: n * 4, indexCount: n * 6, floats: 12, quads: n };
}

/**
 * v2.3 AO-preserving greedy mesher → `quad16` instanced quads. Same merge rule as greedyMeshPart (palette, 4 micro-AO corners,
 * macro-AO level, matTag, panel identical AND micro AO constant along the merge direction; diagonal flip when
 * ao00 + ao11 < ao10 + ao01), so for macroLevels ≤ 16 and runs ≤ 255 it emits exactly greedyMeshPart's quads (and, through
 * quad16ToMesh, exactly its triangles + per-corner attributes). Differences by design: no vertex de-dup / index buffer, no
 * 65 535 cap, macroLevels up to 256 (smooth dual-scale cavity AO), runs split at opts.maxQuadSize (≤ 255).
 * opts: { voxelScale 1, center [0,0,0], macroAo, macroLevels 8 (2..256), name, region { min, max }, maxQuadSize 255 }.
 * → { name, format 'QUAD16', bytes (Uint8Array quads · 16), quadCount, quads, triangles, exposedFaces, reduction, voxels, dims,
 *     voxelScale, center, gridOrigin [3] (u), macroLevels, bounds { min, max } (u), region? }
 */
export function greedyQuad16Part(grid, palette, opts = {}) {
  const { voxelScale = 1, center = [0, 0, 0], macroAo = null, macroLevels = 8, name = 'part' } = opts;
  const MS = Math.max(1, Math.min(255, Math.floor(opts.maxQuadSize ?? 255)));
  if (!(Number.isInteger(macroLevels) && macroLevels >= 2 && macroLevels <= 256)) throw new Error('greedyQuad16Part: macroLevels must be an integer 2..256');
  if (macroAo && (macroAo.nx !== grid.nx || macroAo.ny !== grid.ny || macroAo.nz !== grid.nz)) throw new Error('greedyQuad16Part: macroAo was baked for a different grid');
  const N = [grid.nx, grid.ny, grid.nz], off = grid.offset, nx = grid.nx, nxy = grid.nx * grid.ny;
  if (Math.max(...N) > 65535) throw new Error('greedyQuad16Part: grid axis > 65535 voxels (Uint16 origin) — split it into parts');
  const pal = grid.pal, flg = grid.flags, pan = grid.panel;
  const solid = (p) => p[0] >= 0 && p[1] >= 0 && p[2] >= 0 && p[0] < N[0] && p[1] < N[1] && p[2] < N[2] && pal[p[0] + nx * p[1] + nxy * p[2]] !== 0;
  const rg = opts.region || null;
  const inRegion = rg ? (p) => p[0] >= rg.min[0] && p[1] >= rg.min[1] && p[2] >= rg.min[2] && p[0] < rg.max[0] && p[1] < rg.max[1] && p[2] < rg.max[2] : null;
  const gridOrigin = [0, 1, 2].map((k) => (off[k] - center[k]) * voxelScale);
  // colour bytes exactly as packed20 quantises them (float32 vertex value → byte), so v2.2 and v2.3 share every rgb / em byte
  const q8f = (x) => Math.round(clamp(Math.fround(x), 0, 1) * 255);
  const recs = [];
  let exposed = 0;
  const lmin = [Infinity, Infinity, Infinity], lmax = [-Infinity, -Infinity, -Infinity];
  const c = [0, 0, 0], q = [0, 0, 0], a = [0, 0, 0], b = [0, 0, 0], cc = [0, 0, 0], t3 = [0, 0, 0];
  const convexAt = (d, u, v, i, s, U, V) => {   // identical to greedyMeshPart's v2.2 bevel rule
    let air = 0;
    for (let k = 0; k < 4; k++) {
      t3[d] = i; t3[u] = U - 1 + (k & 1); t3[v] = V - 1 + (k >> 1);
      if (!solid(t3)) air++;
      t3[d] = i + s;
      if (solid(t3)) return false;
    }
    return air > 0;
  };
  // mask key (exact in a double): pal 8 bits · aoBits 8 · macro level 8 · matTag 4 · present 1 · panel 8 (× 2^29)
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
          if (!pi) continue;
          if (inRegion && !inRegion(c)) continue;
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
    name, format: 'QUAD16', bytes: packQuad16(recs), quadCount: n, quads: n, triangles: n * 2, exposedFaces: exposed, reduction: exposed ? 1 - n / exposed : 0,
    voxels: rg ? countRegion(grid, rg) : grid.count(), dims: N.slice(), voxelScale, center: center.slice(), gridOrigin, macroLevels,
    ...(rg ? { region: { min: rg.min.slice(), max: rg.max.slice() } } : {}),
    bounds: n ? { min: lmin.map((l, k) => gridOrigin[k] + l * voxelScale), max: lmax.map((l, k) => gridOrigin[k] + l * voxelScale) } : { min: [0, 0, 0], max: [0, 0, 0] },
  };
}

// =============================================================================================== packing (svox.mega/v2)
/** column-major TRS mat4 (Three.js Matrix4.compose order) */
export function composeTRS(p, q, s) {
  const [x, y, z, w] = q, x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    p[0], p[1], p[2], 1,
  ];
}
/** quaternion [x, y, z, w] for a rotation of `rad` about a unit axis */
export const quatAxisAngle = (axis, rad) => { const s = Math.sin(rad / 2); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(rad / 2)]; };

function normInstance(inst, i) {
  const tag = `instances[${i}]`;
  if (!inst || typeof inst.prefab !== 'string') throw new Error(`${tag}: prefab id required`);
  const pos = inst.pos;
  if (!Array.isArray(pos) || pos.length !== 3 || !pos.every(Number.isFinite)) throw new Error(`${tag}: pos[3] required`);
  let q = inst.rotQuat || [0, 0, 0, 1];
  if (q.length !== 4 || !q.every(Number.isFinite)) throw new Error(`${tag}: rotQuat must be [x, y, z, w]`);
  const ql = Math.hypot(...q);
  if (ql < 1e-6) throw new Error(`${tag}: zero-length rotQuat`);
  q = q.map((v) => v / ql);
  const sc = inst.scale === undefined ? [1, 1, 1] : typeof inst.scale === 'number' ? [inst.scale, inst.scale, inst.scale] : inst.scale;
  if (sc.length !== 3 || !sc.every((v) => Number.isFinite(v) && v !== 0)) throw new Error(`${tag}: scale must be a non-zero number or [3]`);
  const tint = inst.tint || [1, 1, 1];
  if (tint.length !== 3 || !tint.every(Number.isFinite)) throw new Error(`${tag}: tint must be [r, g, b]`);
  return { prefab: inst.prefab, pos: pos.map(r4), rotQuat: q.map(r4), scale: sc.map(r4), tint: tint.map(r4), ...(inst.zone ? { zone: inst.zone } : {}) };
}

/**
 * Static + runtime G6 budget check. stats: packMegaAsset stats. runtime (optional, measured in-engine):
 * { earlyZAlive: bool, gpuDeltaMs: number }. An unmeasured runtime check counts as NOT passed.
 * → { pass, staticPass, runtimeMeasured, checks: [{ name, value, limit, pass }] }
 */
export function checkPerfBudget(stats, budget = {}, runtime = null) {
  const B = { ...MEGA_BUDGET, ...budget };
  const checks = [
    { name: 'drawCalls', value: stats.drawCalls, limit: `<= ${B.maxDrawCalls}`, pass: stats.drawCalls <= B.maxDrawCalls },
    { name: 'macroDrawCalls', value: stats.macroDrawCalls, limit: `${B.macroDrawCalls[0]}..${B.macroDrawCalls[1]}`, pass: stats.macroDrawCalls >= B.macroDrawCalls[0] && stats.macroDrawCalls <= B.macroDrawCalls[1] },
    { name: 'mesoBatches', value: stats.mesoBatches, limit: `<= ${B.maxMesoBatches}`, pass: stats.mesoBatches <= B.maxMesoBatches },
    { name: 'totalTriangles', value: stats.totalTriangles, limit: `<= ${B.maxTotalTriangles}`, pass: stats.totalTriangles <= B.maxTotalTriangles },
    { name: 'mesoUniqueTriangles', value: stats.mesoUniqueTriangles, limit: `<= ${B.maxMesoUniqueTriangles}`, pass: stats.mesoUniqueTriangles <= B.maxMesoUniqueTriangles },
    { name: 'binBytes', value: stats.binBytes, limit: `<= ${B.maxBinBytes}`, pass: stats.binBytes <= B.maxBinBytes },
  ];
  const staticPass = checks.every((c) => c.pass);
  const rz = runtime && typeof runtime.earlyZAlive === 'boolean', rg = runtime && typeof runtime.gpuDeltaMs === 'number';
  checks.push({ name: 'earlyZAlive', value: rz ? runtime.earlyZAlive : 'unmeasured', limit: 'true (no discard / gl_FragDepth in the FINAL program)', pass: rz ? runtime.earlyZAlive === true : false, runtime: true });
  checks.push({ name: 'gpuDeltaMs', value: rg ? runtime.gpuDeltaMs : 'unmeasured', limit: `< ${B.maxGpuDeltaMs} (readPixels-bracketed, ship on − off)`, pass: rg ? runtime.gpuDeltaMs < B.maxGpuDeltaMs : false, runtime: true });
  const runtimeMeasured = !!(rz && rg);
  return { pass: staticPass && runtimeMeasured && checks.every((c) => c.pass), staticPass, runtimeMeasured, checks };
}

/**
 * Pack a megastructure into a deterministic svox.mega/v2 asset.
 * manifest: { id, name, faction? (kept verbatim for existing engines), materialProfile? (MATERIAL_PRESETS name | custom
 *             string | { id, tags }), styleTag? (free string), archetype?, palette (MegaPalette), voxelScale (macro u/vox), center? (macro voxel coords
 *             of the ship origin, default: first macro grid centre), format 'MEGA_V2' | 'FLOAT11' | 'MEGA_V22' | 'MEGA_V23', macroLevels 8, aoOpts,
 *             detailZones (doc | array), budget, meta (free JSON) }
 * macroParts: [{ name, kind?, grid | mesh, bakeAo = true, aoOpts?, voxelScale?, center?, anim? }]  (1–3 recommended)
 * mesoPrefabs: [{ id, grid | mesh, voxelScale = 1.5, pivot? (voxel coords, default [nx/2, ny/2, 0]), bakeAo = false }]
 * instances: [{ prefab, pos [3] (ship-local u), rotQuat [x,y,z,w] = identity, scale = 1 | [3], tint = [1,1,1], zone? }]
 * Binary: per macro part Float32 vertices + Uint32 indices; per prefab vertices + indices + Float32 mat4 instance
 * matrices (column-major, 64 B each, ready for InstancedMesh.instanceMatrix) + Float32 RGB tints (12 B each).
 * MEGA_V23 (svox.mega/v2.3): every macro part is a greedyQuad16Part `quad16` block (16 B / quad, no index block; part JSON
 * vertexFormat 'quad16', quadOffset / quadCount / quadByteLength, gridOrigin, voxelScale, + waveAmp / waveFreq / waveOriginY
 * when given on the part) while the prefabs stay packed20 + Uint16 / Uint32 indices exactly as v2.2; budget MEGA_V23_BUDGET.
 * Returns { json, bin (Buffer), stats }. No timestamps / timings → identical inputs give identical bytes.
 */
export function packMegaAsset(manifest, macroParts = [], mesoPrefabs = [], instances = []) {
  const pal = manifest.palette;
  if (!(pal instanceof MegaPalette)) throw new Error('packMegaAsset: manifest.palette must be a MegaPalette');
  if (!manifest.id || !/^[a-z0-9_-]+$/i.test(manifest.id)) throw new Error('packMegaAsset: manifest.id required ([a-z0-9_-])');
  if (!(manifest.voxelScale > 0)) throw new Error('packMegaAsset: manifest.voxelScale (macro u/vox) required');
  if (!macroParts.length) throw new Error('packMegaAsset: at least one macro part is required');
  const materialProfile = resolveMaterialProfile(manifest.materialProfile);   // optional; validated before any meshing
  const fmtIn = manifest.format || 'MEGA_V2';
  if (fmtIn !== 'MEGA_V2' && !isFloat11(fmtIn) && fmtIn !== 'MEGA_V22' && fmtIn !== 'MEGA_V23') throw new Error(`packMegaAsset: format must be MEGA_V2 | FLOAT11 | MEGA_V22 | MEGA_V23 (got ${fmtIn})`);
  // v2.3: macro parts → quad16 (16 B / quad, greedyQuad16Part); meso prefabs keep packed20 (MEGA_V22 mesher + codec)
  const isQuad16 = fmtIn === 'MEGA_V23';
  const format = isQuad16 ? 'MEGA_V22' : fmtIn;
  const FL = isFloat11(format) ? 11 : 12;
  const Q = format === 'MEGA_V22';
  const chunks = [];
  let byte = 0;
  const push = (typed) => {
    const b = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength); const o = byte; chunks.push(b); byte += b.length;
    if (byte % 4) { const padN = 4 - (byte % 4); chunks.push(Buffer.alloc(padN)); byte += padN; }   // keep every block 4-byte aligned
    return o;
  };
  // v2.2: Uint16 indices for every part / prefab with ≤ 65 535 vertices (manifest.index32 forces Uint32 everywhere)
  const idxFor = (mesh) => (Q && !manifest.index32 && mesh.vertexCount <= 65535 ? Uint16Array.from(mesh.idx) : mesh.idx);
  const defaultCenter = manifest.center || (macroParts[0].grid ? [macroParts[0].grid.nx / 2, macroParts[0].grid.ny / 2, macroParts[0].grid.nz / 2] : [0, 0, 0]);
  const names = new Set();
  const bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
  const st = { macroVoxels: 0, mesoVoxels: 0, exposedFaces: 0, quads: 0, macroTriangles: 0, mesoUniqueTriangles: 0, instancedTriangles: 0, macroQuads: 0 };
  const partsJson = macroParts.map((p) => {
    if (!p.name || names.has(p.name)) throw new Error(`packMegaAsset: macro part name missing or duplicate (${p.name})`);
    names.add(p.name);
    if (isQuad16) return packQuad16Part(p);
    let mesh = p.mesh, ao = null;
    if (!mesh) {
      if (!(p.grid instanceof VoxelGrid)) throw new Error(`packMegaAsset: macro part ${p.name} needs grid or mesh`);
      const macroAo = p.macroAo || (p.bakeAo === false ? null : bakeMacroCavityAO(p.grid, p.aoOpts || manifest.aoOpts || {}));
      mesh = greedyMeshPart(p.grid, pal, { voxelScale: p.voxelScale ?? manifest.voxelScale, center: p.center ?? defaultCenter, macroAo, macroLevels: p.macroLevels ?? manifest.macroLevels ?? 8, format, name: p.name, region: p.region });
      if (macroAo) ao = { rays: macroAo.rays, maxDist: macroAo.maxDist, mean: r4(macroAo.stats.mean), min: r4(macroAo.stats.min) };
    }
    if (mesh.floats !== FL) throw new Error(`packMegaAsset: part ${p.name} mesh has ${mesh.floats} floats, asset format ${format} needs ${FL}`);
    if (Q && !mesh.extra) throw new Error(`packMegaAsset: part ${p.name} mesh was not meshed with format MEGA_V22 (no bevel / crease / panel extras)`);
    const qz = Q ? packQuantizedMegaV22(mesh) : null;
    const pIdx = idxFor(mesh);
    const vertexOffset = push(Q ? qz.bytes : mesh.verts), indexOffset = push(pIdx);
    for (let k = 0; k < 3; k++) { bmin[k] = Math.min(bmin[k], mesh.bounds.min[k]); bmax[k] = Math.max(bmax[k], mesh.bounds.max[k]); }
    st.macroVoxels += mesh.voxels; st.exposedFaces += mesh.exposedFaces; st.quads += mesh.quads; st.macroTriangles += mesh.triangles;
    return {
      name: p.name, kind: p.kind || 'macro', dims: mesh.dims, voxelScale: r4(mesh.voxelScale), center: mesh.center.map(r4),
      vertexOffset, vertexCount: mesh.vertexCount, vertexByteLength: Q ? qz.bytes.byteLength : mesh.verts.byteLength,
      ...(Q ? { posCenter: qz.posCenter, posHalfExt: qz.posHalfExt, maxPosError: r6(qz.maxPosError), indexType: pIdx.BYTES_PER_ELEMENT === 2 ? 'uint16' : 'uint32' } : {}),
      indexOffset, indexCount: mesh.indexCount, indexByteLength: pIdx.byteLength,
      voxels: mesh.voxels, exposedFaces: mesh.exposedFaces, quads: mesh.quads, triangles: mesh.triangles, reduction: r4(mesh.reduction),
      macroAo: ao, ...(p.anim ? { anim: p.anim } : {}),
    };
  });
  function packQuad16Part(p) {
    let qm = p.mesh, ao = null;
    if (!qm) {
      if (!(p.grid instanceof VoxelGrid)) throw new Error(`packMegaAsset: macro part ${p.name} needs grid or mesh`);
      const macroAo = p.macroAo || (p.bakeAo === false ? null : bakeMacroCavityAO(p.grid, p.aoOpts || manifest.aoOpts || {}));
      qm = greedyQuad16Part(p.grid, pal, { voxelScale: p.voxelScale ?? manifest.voxelScale, center: p.center ?? defaultCenter, macroAo, macroLevels: p.macroLevels ?? manifest.macroLevels ?? 8, name: p.name, region: p.region, maxQuadSize: p.maxQuadSize });
      if (macroAo) ao = { rays: macroAo.rays, maxDist: macroAo.maxDist, mean: r4(macroAo.stats.mean), min: r4(macroAo.stats.min) };
    }
    if (qm.format !== 'QUAD16' || !(qm.bytes instanceof Uint8Array) || qm.bytes.byteLength !== qm.quadCount * 16) throw new Error(`packMegaAsset: MEGA_V23 part ${p.name} must be a greedyQuad16Part result (quad16)`);
    const quadOffset = push(qm.bytes);
    for (let k = 0; k < 3; k++) { bmin[k] = Math.min(bmin[k], qm.bounds.min[k]); bmax[k] = Math.max(bmax[k], qm.bounds.max[k]); }
    st.macroVoxels += qm.voxels; st.exposedFaces += qm.exposedFaces; st.quads += qm.quads; st.macroTriangles += qm.triangles; st.macroQuads += qm.quadCount;
    const wave = {};
    for (const k of ['waveAmp', 'waveFreq', 'waveOriginY']) if (typeof p[k] === 'number') wave[k] = r6(p[k]);
    return {
      name: p.name, kind: p.kind || 'macro', dims: qm.dims, voxelScale: r6(qm.voxelScale), center: qm.center.map(r6),
      vertexFormat: 'quad16', quadStrideBytes: 16, quadOffset, quadCount: qm.quadCount, quadByteLength: qm.bytes.byteLength,
      gridOrigin: qm.gridOrigin.map(r6), macroLevels: qm.macroLevels,
      voxels: qm.voxels, exposedFaces: qm.exposedFaces, quads: qm.quads, triangles: qm.triangles, reduction: r4(qm.reduction),
      bounds: { min: qm.bounds.min.map(r4), max: qm.bounds.max.map(r4) },
      macroAo: ao, ...(p.anim ? { anim: p.anim } : {}), ...wave,
    };
  }
  const insts = instances.map(normInstance);
  const prefabIds = new Set();
  const prefabsJson = mesoPrefabs.map((pf) => {
    if (!pf.id || prefabIds.has(pf.id)) throw new Error(`packMegaAsset: prefab id missing or duplicate (${pf.id})`);
    prefabIds.add(pf.id);
    const vs = pf.voxelScale ?? 1.5;
    let mesh = pf.mesh;
    if (!mesh) {
      if (!(pf.grid instanceof VoxelGrid)) throw new Error(`packMegaAsset: prefab ${pf.id} needs grid or mesh`);
      const pivot = pf.pivot || [pf.grid.nx / 2, pf.grid.ny / 2, 0];
      const macroAo = pf.bakeAo ? bakeMacroCavityAO(pf.grid, pf.aoOpts || {}) : null;
      mesh = greedyMeshPart(pf.grid, pal, { voxelScale: vs, center: pivot, macroAo, macroLevels: pf.macroLevels ?? 8, format, name: pf.id });
    }
    if (mesh.floats !== FL) throw new Error(`packMegaAsset: prefab ${pf.id} mesh float count does not match ${format}`);
    if (Q && !mesh.extra) throw new Error(`packMegaAsset: prefab ${pf.id} mesh was not meshed with format MEGA_V22`);
    const pq = Q ? packQuantizedMegaV22(mesh) : null;
    const mine = insts.filter((i) => i.prefab === pf.id);
    const mats = new Float32Array(mine.length * 16), cols = new Float32Array(mine.length * 3);
    mine.forEach((i, k) => { mats.set(composeTRS(i.pos, i.rotQuat, i.scale), k * 16); cols.set(i.tint, k * 3); });
    const fIdx = idxFor(mesh);
    const vertexOffset = push(Q ? pq.bytes : mesh.verts), indexOffset = push(fIdx);
    const instanceMatrixOffset = push(mats), instanceColorOffset = push(cols);
    st.mesoVoxels += mesh.voxels; st.exposedFaces += mesh.exposedFaces; st.quads += mesh.quads;
    st.mesoUniqueTriangles += mesh.triangles; st.instancedTriangles += mesh.triangles * mine.length;
    return {
      id: pf.id, voxelScale: r4(mesh.voxelScale), dims: mesh.dims, pivot: mesh.center.map(r4),
      vertexOffset, vertexCount: mesh.vertexCount, vertexByteLength: Q ? pq.bytes.byteLength : mesh.verts.byteLength,
      ...(Q ? { posCenter: pq.posCenter, posHalfExt: pq.posHalfExt, maxPosError: r6(pq.maxPosError), indexType: fIdx.BYTES_PER_ELEMENT === 2 ? 'uint16' : 'uint32' } : {}),
      indexOffset, indexCount: mesh.indexCount, indexByteLength: fIdx.byteLength,
      voxels: mesh.voxels, exposedFaces: mesh.exposedFaces, quads: mesh.quads, triangles: mesh.triangles, reduction: r4(mesh.reduction),
      bounds: { min: mesh.bounds.min.map(r4), max: mesh.bounds.max.map(r4) },
      instanceCount: mine.length, instanceMatrixOffset, instanceMatrixByteLength: mats.byteLength, instanceColorOffset, instanceColorByteLength: cols.byteLength,
    };
  });
  insts.forEach((i, k) => { if (!prefabIds.has(i.prefab)) throw new Error(`packMegaAsset: instances[${k}] references unknown prefab '${i.prefab}'`); });
  let zones = [];
  if (manifest.detailZones) {
    const v = validateDetailZones(manifest.detailZones);
    if (!v.ok) throw new Error(`packMegaAsset: invalid detailZones — ${v.errors.join('; ')}`);
    zones = v.zones;
  }
  const bin = Buffer.concat(chunks);
  const mesoBatches = prefabsJson.filter((p) => p.instanceCount > 0).length;
  const stats = {
    macroVoxels: st.macroVoxels, mesoVoxels: st.mesoVoxels, voxelCount: st.macroVoxels + st.mesoVoxels,
    exposedFaces: st.exposedFaces, quads: st.quads, greedyReduction: r4(st.exposedFaces ? 1 - st.quads / st.exposedFaces : 0),
    macroTriangles: st.macroTriangles, mesoUniqueTriangles: st.mesoUniqueTriangles, instancedTriangles: st.instancedTriangles,
    uniqueTriangles: st.macroTriangles + st.mesoUniqueTriangles, totalTriangles: st.macroTriangles + st.instancedTriangles,
    macroDrawCalls: partsJson.length, mesoBatches, drawCalls: partsJson.length + mesoBatches,
    instanceCount: insts.length, prefabCount: prefabsJson.length, binBytes: bin.length,
    ...(isQuad16 ? { macroQuads: st.macroQuads, macroQuadBytes: st.macroQuads * 16, quadStrideBytes: 16 } : {}),
  };
  const json = {
    schema: isQuad16 ? MEGA_V23_SCHEMA : Q ? MEGA_V22_SCHEMA : MEGA_SCHEMA, kitVersion: KIT_VERSION, id: manifest.id, name: manifest.name || manifest.id,
    faction: manifest.faction || null, archetype: manifest.archetype || null,
    ...(materialProfile ? { materialProfile } : {}), ...(manifest.styleTag !== undefined && manifest.styleTag !== null ? { styleTag: String(manifest.styleTag) } : {}),
    vertexLayout: format === 'FLOAT11' ? FLOAT11_LAYOUT : isFloat11(format) ? V12_LAYOUT : Q ? MEGA_V22_LAYOUT : MEGA_V2_LAYOUT,
    ...(isQuad16 ? { vertexFormat: 'quad16+packed20', macroFormat: 'quad16', mesoFormat: 'packed20', quadStrideBytes: 16, vertexStrideBytes: 20, quadLayout: QUAD16_LAYOUT }
      : Q ? { vertexFormat: 'packed20', vertexStrideBytes: 20 } : {}),
    instanceLayout: { matrix: 'Float32 mat4 column-major (64 B)', color: 'Float32 rgb (12 B)' },
    units: 'u', axes: '+X starboard, +Y bow, +Z dorsal',
    bounds: { min: bmin.map(r4), max: bmax.map(r4), size: bmax.map((v, k) => r4(v - bmin[k])) },
    macro: { voxelScale: r4(manifest.voxelScale), parts: partsJson },
    meso: { prefabs: prefabsJson },
    instances: insts,
    detailZones: zones,
    palette: pal.toJSON(),
    stats,
    budget: checkPerfBudget(stats, isQuad16 ? { ...MEGA_V23_BUDGET, ...(manifest.budget || {}) } : Q ? { ...MEGA_V22_BUDGET, ...(manifest.budget || {}) } : manifest.budget),
    ...(manifest.meta ? { meta: manifest.meta } : {}),
  };
  return { json, bin, stats };
}

/** write <outBase>.json + <outBase>.bin → { jsonPath, binPath, jsonSha256, binSha256 } */
export function writeMegaAsset(outBase, packed) {
  fs.mkdirSync(path.dirname(path.resolve(outBase)), { recursive: true });
  const jsonText = JSON.stringify(packed.json, null, 1) + '\n';
  const jsonPath = `${outBase}.json`, binPath = `${outBase}.bin`;
  fs.writeFileSync(jsonPath, jsonText);
  fs.writeFileSync(binPath, packed.bin);
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  return { jsonPath, binPath, jsonSha256: sha(jsonText), binSha256: sha(packed.bin) };
}

/**
 * read an svox.mega/v2, v2.2 or v2.3 asset back (reference loader; zero-copy typed-array views over the .bin). v2.3 quad16 macro
 * parts are expanded by quad16ToMesh (verts / extra / idx, raw stream as `quads`); v2.3 prefabs decode exactly like v2.2.
 * v2.2 packed20 vertices are decoded to the MEGA_V2 12-float layout (verts) + extras (bevel, crease, panel) and the raw
 * 20-byte stream is exposed as `packed` — every consumer (renderPreview, G5) works on both schemas unchanged.
 */
export function readMegaAsset(jsonPath) {
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (json.schema !== MEGA_SCHEMA && json.schema !== MEGA_V22_SCHEMA && json.schema !== MEGA_V23_SCHEMA) throw new Error(`readMegaAsset: schema ${json.schema} is not ${MEGA_SCHEMA} | ${MEGA_V22_SCHEMA} | ${MEGA_V23_SCHEMA}`);
  const isQuad16 = json.schema === MEGA_V23_SCHEMA;
  const Q = json.schema === MEGA_V22_SCHEMA || isQuad16;   // v2.3 prefabs are packed20
  const binBuf = fs.readFileSync(jsonPath.replace(/\.json$/i, '.bin'));
  const ab = binBuf.buffer.slice(binBuf.byteOffset, binBuf.byteOffset + binBuf.byteLength);
  const f32 = (o, n) => new Float32Array(ab, o, n);
  const u32 = (o, n, t) => (t === 'uint16' ? new Uint16Array(ab, o, n) : new Uint32Array(ab, o, n));
  const FL = Q ? 12 : json.vertexLayout.floats;
  const vtx = (p) => {
    if (!Q) return { verts: f32(p.vertexOffset, p.vertexCount * FL) };
    const packed = new Uint8Array(ab, p.vertexOffset, p.vertexCount * 20);
    const d = unpackQuantizedMegaV22(packed, p.vertexCount, p.posCenter, p.posHalfExt);
    return { verts: d.verts, extra: d.extra, packed };
  };
  // v2.3 quad16 macro part → MEGA_V2 floats (4 corners / quad) + Uint32 indices; the raw 16 B stream is `quads`
  const quadPart = (p) => {
    if (p.quadOffset % 4 || p.quadOffset + p.quadCount * 16 > binBuf.length) throw new Error(`readMegaAsset: bad quad16 offsets in part ${p.name}`);
    const quads = new Uint8Array(ab, p.quadOffset, p.quadCount * 16);
    const m = quad16ToMesh(quads, p.quadCount, p.gridOrigin, p.voxelScale);
    return { meta: p, verts: m.verts, extra: m.extra, idx: m.idx, quads, vertexCount: m.vertexCount };
  };
  return {
    json, bytes: binBuf.length, floats: FL, quantized: Q, ...(isQuad16 ? { quad16: true } : {}),
    part: (name) => { const p = json.macro.parts.find((q) => q.name === name); if (!p) throw new Error(`no part ${name}`); if (p.vertexFormat === 'quad16') return quadPart(p); return { meta: p, ...vtx(p), idx: u32(p.indexOffset, p.indexCount, p.indexType) }; },
    prefab: (id) => {
      const p = json.meso.prefabs.find((q) => q.id === id); if (!p) throw new Error(`no prefab ${id}`);
      return { meta: p, ...vtx(p), idx: u32(p.indexOffset, p.indexCount, p.indexType), matrices: f32(p.instanceMatrixOffset, p.instanceCount * 16), colors: f32(p.instanceColorOffset, p.instanceCount * 3) };
    },
  };
}

// =============================================================================================== demo carrier (synthetic)
/**
 * Synthetic hard-surface carrier used by the CLI demo and the self-test: 72×250×40 macro voxels at 4.0 u/vox
 * (288 × 1000 × 160 u) with a stepped citadel, a catapult trench + mirrored flank hangars carved from Stage-1B detail
 * zones, emissive light rails, and two instanced meso prefabs (turret ×8, hangar rib ×8) at 1.5 u/vox.
 */
export function buildDemoCarrier(opts = {}) {
  const pal = new MegaPalette();
  const HULL = pal.add('hull_grey', '#7c8594', { matTag: 1 }), DARK = pal.add('hull_dark', '#4a505c', { matTag: 1 });
  const DECK = pal.add('deck', '#98a1ae', { matTag: 2 }), TRENCH = pal.add('trench_floor', '#3a3f4a', { matTag: 2 });
  const CYAN = pal.add('cyan_light', '#5ff0ff', { emissive: 1, matTag: 3 }), AMBER = pal.add('amber_light', '#ffb347', { emissive: 0.9, matTag: 3 });
  const TUR = pal.add('turret', '#8a93a3', { matTag: 4 }), RIB = pal.add('rib', '#5a616e', { matTag: 4 }), GLOW = pal.add('engine_glow', '#7fd8ff', { emissive: 1, matTag: 3 });
  const VS = 4.0, g = new VoxelGrid(72, 250, 40), C = [36, 125, 20];
  // lower hull (keel wedge) + main hull with a hammerhead bow, in voxel coords
  g.prism([[14, 10], [58, 10], [58, 200], [36, 238], [14, 200]], 'z', 4, 10, DARK);
  g.prism([[6, 8], [66, 8], [66, 180], [70, 215], [52, 244], [20, 244], [2, 215], [6, 180]], 'z', 10, 24, HULL);
  g.box([6, 8, 24], [66, 180, 26], DECK);                                          // flight deck plate
  for (let k = 0; k < 4; k++) g.box([24 + k * 3, 40 + k * 6, 26 + k * 3], [48 - k * 3, 110 - k * 6, 29 + k * 3], k % 2 ? DARK : HULL);   // stepped citadel
  for (let k = 0; k < 4; k++) g.box([25 + k * 3, 40 + k * 6, 28 + k * 3], [47 - k * 3, 41 + k * 6, 29 + k * 3], CYAN);                    // viewport strips
  for (const ex of [16, 28, 44, 56]) {                                             // 4 recessed engine nozzles
    g.box([ex - 5, 2, 11], [ex + 5, 10, 21], DARK);
    g.box([ex - 3, 2, 13], [ex + 3, 5, 19], 0);
    g.box([ex - 3, 5, 13], [ex + 3, 6, 19], GLOW, { mode: 'paint' });
  }
  g.mirrorX();
  const zonesDoc = {
    schema: ZONES_SCHEMA, shipId: 'demo_carrier', archetype: 'hard_surface_carrier', units: 'u',
    zones: [
      { zoneId: 'catapult_trench', kind: 'occluded_cavity', cameraView: 'interior_front', calloutImage: 'callouts/demo_carrier_catapult_trench.png', targetVoxelScale: 1.5,
        boundsLocal: { min: [-24, 260, -12], max: [24, 476, 24] }, requiredFeatures: ['trench floor centreline', 'cyan edge light strips', 'aft hangar gate'],
        carve: [{ shape: 'box', min: [-24, 260, -8], max: [24, 476, 24] }] },
      { zoneId: 'flank_hangars', kind: 'occluded_cavity', cameraView: 'oblique_closeup', calloutImage: 'callouts/demo_carrier_flank_hangars.png', targetVoxelScale: 1.5,
        boundsLocal: { min: [-136, -180, -28], max: [136, 60, 12] }, requiredFeatures: ['recess depth >= 3 macro voxels', 'hangar ribs (meso prefab)', 'amber ceiling light rail'],
        carve: [{ shape: 'box', min: [-136, -180, -28], max: [-80, 60, 12] }, { shape: 'box', min: [80, -180, -28], max: [136, 60, 12] }] },
      { zoneId: 'bridge_citadel', kind: 'hero_superstructure', cameraView: 'oblique_closeup', calloutImage: 'callouts/demo_carrier_bridge_citadel.png', targetVoxelScale: 1.2,
        boundsLocal: { min: [-48, -340, 24], max: [48, -60, 80] }, requiredFeatures: ['4 stepped tiers', 'cyan viewport strips', 'deck turrets (meso prefab)'] },
    ],
  };
  applyDetailZoneCarves(g, zonesDoc, { voxelScale: VS, center: C });
  // emissive detail inside the carved zones (paint only solid cells)
  g.box([30, 190, 17], [42, 244, 18], TRENCH, { mode: 'paint' });                // trench floor (8 vox = 32 u deep)
  g.box([35, 190, 17], [37, 244, 18], DECK, { mode: 'paint' });                    // centreline
  g.box([29, 190, 23], [30, 244, 24], CYAN, { mode: 'paint' }); g.box([42, 190, 23], [43, 244, 24], CYAN, { mode: 'paint' });   // lip strips
  g.box([10, 80, 23], [12, 140, 24], AMBER, { mode: 'paint' }); g.box([60, 80, 23], [62, 140, 24], AMBER, { mode: 'paint' });   // hangar ceiling rails
  if (opts.factionTags) {
    // v2.3 faction material swatches (paint only, silhouette unchanged): chitin flank armour (matTag 6), gold / ivory temple
    // citadel crown (matTag 7), glowing bio cavity in the catapult trench floor (matTag 8)
    const CHITIN = pal.add('chitin', '#5a3f7a', { matTag: 6 }), GOLD = pal.add('gold', '#d9a441', { matTag: 7 }), IVORY = pal.add('ivory', '#e8dcc0', { matTag: 7 });
    const BIO = pal.add('bio_lime', '#9cff3a', { emissive: 0.85, matTag: 8 }), BIOM = pal.add('bio_magenta', '#e04cc8', { emissive: 0.7, matTag: 8 });
    g.box([0, 8, 10], [8, 180, 24], CHITIN, { mode: 'paint' }); g.box([64, 8, 10], [72, 180, 24], CHITIN, { mode: 'paint' });
    for (let k = 0; k < 4; k++) g.box([24 + k * 3, 40 + k * 6, 26 + k * 3], [48 - k * 3, 110 - k * 6, 29 + k * 3], k % 2 ? IVORY : GOLD, { mode: 'paint' });
    g.box([31, 196, 17], [41, 240, 18], BIO, { mode: 'paint' }); g.box([33, 214, 17], [39, 224, 18], BIOM, { mode: 'paint' });
  }
  // meso prefabs (1.5 u/vox): twin-barrel turret, hangar rib
  const tur = new VoxelGrid(12, 16, 9);
  tur.ellipsoid([6, 6, 0.5], [5.5, 5.5, 4], TUR); tur.box([2, 2, 0], [10, 10, 2], DARK);
  tur.capsule([4, 6, 4], [4, 15, 4], 1.2, DARK); tur.capsule([8, 6, 4], [8, 15, 4], 1.2, DARK);
  const rib = new VoxelGrid(4, 6, 24);
  rib.box([0, 0, 0], [4, 6, 24], RIB); rib.box([1, 0, 4], [3, 2, 20], DARK, { mode: 'paint' }); rib.box([1, 2, 21], [3, 4, 23], AMBER);
  const instances = [];
  for (const [x, y] of [[-56, 120], [56, 120], [-56, 160], [56, 160], [-40, -20], [40, -20], [-56, -200], [56, -200]])
    instances.push({ prefab: 'turret', pos: [x, y, 24], rotQuat: quatAxisAngle([0, 0, 1], x < 0 ? 0.35 : -0.35), zone: 'bridge_citadel' });
  for (let k = 0; k < 4; k++) for (const s of [-1, 1])
    instances.push({ prefab: 'hangar_rib', pos: [s * 108, -160 + k * 60, -28], rotQuat: [0, 0, 0, 1], scale: 1, tint: [1, 0.96, 0.9], zone: 'flank_hangars' });
  const manifest = { id: 'demo_carrier', name: 'Demo Carrier', faction: 'demo', archetype: 'hard_surface_carrier', palette: pal, voxelScale: VS, center: C, detailZones: zonesDoc, aoOpts: { rays: 24, maxDist: 24 } };
  const macroParts = [{ name: 'hull', grid: g }];
  const mesoPrefabs = [{ id: 'turret', grid: tur, voxelScale: 1.5, pivot: [6, 6, 0] }, { id: 'hangar_rib', grid: rib, voxelScale: 1.5, pivot: [2, 3, 0] }];
  return { manifest, macroParts, mesoPrefabs, instances, zonesDoc, grid: g, palette: pal };
}

// =============================================================================================== CPU preview renderer
/** camera presets: forward vector (looking direction) + up hint, in ship-local axes (+X starboard, +Y bow, +Z dorsal) */
export const PREVIEW_VIEWS = Object.freeze({
  top: { forward: [0, 0, -1], up: [0, 1, 0] },
  side: { forward: [-1, 0, 0], up: [0, 0, 1] },
  front: { forward: [0, -1, 0], up: [0, 0, 1] },
  hero34: { yaw: 35, pitch: 28 },       // studio 3/4 from bow-starboard, above
  bow34: { yaw: 20, pitch: 12 },
  aft34: { yaw: 155, pitch: 22 },
  ventral34: { yaw: 35, pitch: -30 },
});
const v3 = { dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; } };
/** yaw (deg, 0 = camera on the bow axis, +90 = starboard beam) / pitch (deg, + = above) → camera forward vector */
export function forwardFromYawPitch(yawDeg, pitchDeg) {
  const y = (yawDeg * Math.PI) / 180, p = (pitchDeg * Math.PI) / 180;
  return [-Math.sin(y) * Math.cos(p), -Math.cos(y) * Math.cos(p), -Math.sin(p)];
}

/**
 * Orthographic CPU z-buffer preview of an svox.mega/v2 asset (readMegaAsset() result or a .json path).
 * opts: { view 'hero34' | 'top' | 'side' | 'front' | 'bow34' | 'aft34' | 'ventral34', yaw, pitch (override, degrees),
 *         width 640, height 400, margin 12, includeInstances true, light [x, y, z], bands 4, macroAoStrength 1,
 *         excludeParts [names], excludeKinds [kinds] (v2.3 hull-only G5 renders, e.g. ['wave']) }
 * Background is transparent (alpha 0), so computeSilhouetteIoU(ref, image) masks it by alpha directly.
 * Not a substitute for the engine render in G5 — use it for smoke checks and when no engine is available yet.
 * Returns { image, triangles, pixels }.
 */
export function renderPreview(asset, opts = {}) {
  const a = typeof asset === 'string' ? readMegaAsset(asset) : asset;
  const { width = 640, height = 400, margin = 12, includeInstances = true, bands = 4, macroAoStrength = 1 } = opts;
  const preset = PREVIEW_VIEWS[opts.view || 'hero34'];
  if (!preset) throw new Error(`renderPreview: unknown view ${opts.view}`);
  const custom = opts.yaw !== undefined || opts.pitch !== undefined;
  const fwd = v3.norm(custom ? forwardFromYawPitch(opts.yaw ?? preset.yaw ?? 35, opts.pitch ?? preset.pitch ?? 28) : preset.forward || forwardFromYawPitch(preset.yaw, preset.pitch));
  const upHint = preset.up && !custom ? preset.up : Math.abs(fwd[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
  const right = v3.norm(v3.cross(fwd, upHint)), up = v3.cross(right, fwd);
  const L = v3.norm(opts.light || [0.45, 0.35, 0.82]);
  const FL = a.floats ?? a.json.vertexLayout.floats, mega = FL === 12;
  const tris = [];
  const addMesh = (verts, idx, M = null, tint = null) => {
    for (let t = 0; t < idx.length; t += 3) {
      const P = [], A = [];
      for (let k = 0; k < 3; k++) {
        const o = idx[t + k] * FL;
        let p = [verts[o], verts[o + 1], verts[o + 2]];
        if (M) p = [M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12], M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13], M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14]];
        P.push(p);
        const micro = verts[o + 10], macro = mega ? (verts[o + 11] % 256) / 255 : 1;
        A.push(micro * (1 - macroAoStrength * (1 - macro)));
      }
      const o0 = idx[t] * FL;
      let n = [verts[o0 + 3], verts[o0 + 4], verts[o0 + 5]];
      if (M) n = v3.norm([M[0] * n[0] + M[4] * n[1] + M[8] * n[2], M[1] * n[0] + M[5] * n[1] + M[9] * n[2], M[2] * n[0] + M[6] * n[1] + M[10] * n[2]]);
      const c = [verts[o0 + 6], verts[o0 + 7], verts[o0 + 8]];
      tris.push({ P, A, n, c: tint ? c.map((v, k) => v * tint[k]) : c, em: verts[o0 + 9] });
    }
  };
  // v2.3 G5 hull-only: skip macro parts by name / kind (e.g. excludeKinds ['wave'] drops animated tentacles)
  const exN = new Set(opts.excludeParts || []), exK = new Set(opts.excludeKinds || []);
  for (const p of a.json.macro.parts) { if (exN.has(p.name) || exK.has(p.kind)) continue; const m = a.part(p.name); addMesh(m.verts, m.idx); }
  if (includeInstances) for (const p of a.json.meso.prefabs) {
    const m = a.prefab(p.id);
    for (let i = 0; i < p.instanceCount; i++) addMesh(m.verts, m.idx, m.matrices.subarray(i * 16, i * 16 + 16), m.colors.subarray(i * 3, i * 3 + 3));
  }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const t of tris) for (const p of t.P) { const sx = v3.dot(p, right), sy = v3.dot(p, up); x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy); }
  const sc = Math.min((width - 2 * margin) / Math.max(1e-6, x1 - x0), (height - 2 * margin) / Math.max(1e-6, y1 - y0));
  const ox = (width - (x1 - x0) * sc) / 2, oy = (height - (y1 - y0) * sc) / 2;
  const img = createImage(width, height, [0, 0, 0, 0]);
  const zbuf = new Float32Array(width * height).fill(Infinity);
  let pixels = 0;
  for (const t of tris) {
    if (v3.dot(t.n, fwd) >= 0) continue;                                  // back-face cull (outward normals)
    const S = t.P.map((p) => [ox + (v3.dot(p, right) - x0) * sc, height - (oy + (v3.dot(p, up) - y0) * sc), v3.dot(p, fwd)]);
    const area = (S[1][0] - S[0][0]) * (S[2][1] - S[0][1]) - (S[2][0] - S[0][0]) * (S[1][1] - S[0][1]);
    if (Math.abs(area) < 1e-9) continue;
    const bx0 = Math.max(0, Math.floor(Math.min(S[0][0], S[1][0], S[2][0]))), bx1 = Math.min(width - 1, Math.ceil(Math.max(S[0][0], S[1][0], S[2][0])));
    const by0 = Math.max(0, Math.floor(Math.min(S[0][1], S[1][1], S[2][1]))), by1 = Math.min(height - 1, Math.ceil(Math.max(S[0][1], S[1][1], S[2][1])));
    const diff = Math.max(0, v3.dot(t.n, L));
    const q = bands > 1 ? Math.min(1, Math.floor(diff * bands + 0.15) / (bands - 1)) : diff;
    const lit = 0.38 + 0.62 * q;
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((S[1][0] - px) * (S[2][1] - py) - (S[2][0] - px) * (S[1][1] - py)) / area;
      const w1 = ((S[2][0] - px) * (S[0][1] - py) - (S[0][0] - px) * (S[2][1] - py)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
      const z = w0 * S[0][2] + w1 * S[1][2] + w2 * S[2][2], i = y * width + x;
      if (z >= zbuf[i]) continue;
      if (zbuf[i] === Infinity) pixels++;
      zbuf[i] = z;
      const ao = Math.round((w0 * t.A[0] + w1 * t.A[1] + w2 * t.A[2]) * 4) / 4;
      const shade = lit * (0.45 + 0.55 * ao);
      const o = i * 4;
      for (let k = 0; k < 3; k++) img.data[o + k] = Math.round(255 * clamp(t.c[k] * shade * (1 - t.em) + Math.min(1, t.c[k] * 1.2 + 0.03) * t.em, 0, 1));
      img.data[o + 3] = 255;
    }
  }
  return { image: img, triangles: tris.length, pixels };
}

// =============================================================================================== CLI
function printStats(json) {
  const s = json.stats;
  console.log(`${json.schema} ${json.id} · size ${json.bounds.size.map((v) => Math.round(v)).join('×')} u · macro ${json.macro.voxelScale} u/vox · ${json.quadStrideBytes ? `macro ${json.quadStrideBytes} B/quad (quad16) + meso ` : ''}${json.vertexStrideBytes || json.vertexLayout.stride} B/vert`);
  console.log(`  voxels ${s.voxelCount} (macro ${s.macroVoxels}, meso ${s.mesoVoxels}) · faces ${s.exposedFaces} → quads ${s.quads} (greedy ${(s.greedyReduction * 100).toFixed(1)} %)`);
  console.log(`  triangles macro ${s.macroTriangles} + meso unique ${s.mesoUniqueTriangles} (instanced ${s.instancedTriangles}) → total ${s.totalTriangles}`);
  console.log(`  draw calls ${s.drawCalls} (macro ${s.macroDrawCalls} + meso batches ${s.mesoBatches}) · instances ${s.instanceCount} · .bin ${(s.binBytes / 1024).toFixed(1)} KiB · zones ${json.detailZones.length}`);
  for (const c of json.budget.checks) console.log(`  G6 ${c.pass ? 'PASS' : c.runtime ? 'TODO' : 'FAIL'} ${c.name.padEnd(20)} ${String(c.value).padEnd(12)} ${c.limit}`);
}
function cli(argv) {
  const a = parseArgs(argv);
  const cmd = a._[0];
  const vec = (s) => String(s).split(',').map(Number);
  if (cmd === 'demo') {
    const out = path.resolve(typeof a.out === 'string' ? a.out : 'mega_demo');
    // --format MEGA_V2 | FLOAT11 | MEGA_V22 (20 B/vert packed20) | MEGA_V23 (quad16 macro 16 B/quad + packed20 meso).
    // Short form: --v<major><minor> means --format MEGA_V<major><minor> (the highest one given wins).
    const short = Object.keys(a).filter((k) => /^v\d\d$/.test(k) && a[k]).sort().pop();
    const format = typeof a.format === 'string' ? a.format : short ? `MEGA_V${short.slice(1)}` : 'MEGA_V2';
    const d = buildDemoCarrier({ factionTags: format === 'MEGA_V23' || !!a['faction-tags'] || !!a['material-swatches'] });
    if (format !== 'MEGA_V2') d.manifest.format = format;
    if (typeof a.name === 'string') { if (!/^[a-z0-9_-]+$/i.test(a.name)) throw new Error('demo: --name must match [a-z0-9_-]+'); d.manifest.id = a.name; }
    const packed = packMegaAsset(d.manifest, d.macroParts, d.mesoPrefabs, d.instances);
    const w = writeMegaAsset(path.join(out, typeof a.name === 'string' ? a.name : 'demo_carrier'), packed);
    if (!a['asset-only']) {   // --asset-only: just <name>.json + <name>.bin (e.g. straight into an engine asset folder)
      fs.writeFileSync(path.join(out, 'detail_zones.json'), JSON.stringify(d.zonesDoc, null, 1) + '\n');
      const sil = projectSilhouettes(d.grid);
      for (const v of ['top', 'side', 'front']) writePNG(path.join(out, `silhouette_${v}.png`), maskToImage(sil[v], { fg: [255, 255, 255, 255], bg: [0, 0, 0, 0] }));
    }
    printStats(packed.json);
    console.log(`  → ${w.jsonPath} (sha256 ${w.binSha256.slice(0, 12)}… bin)${a['asset-only'] ? '' : ' + detail_zones.json + silhouette_{top,side,front}.png'}`);
    return packed.json.budget.staticPass ? 0 : 1;
  }
  if (cmd === 'zones-template') {
    const doc = scaffoldDetailZones(a.archetype, { hullSize: a['hull-size'] ? vec(a['hull-size']) : undefined,
      ...(typeof a.asset === 'string' ? { assetId: a.asset } : { shipId: typeof a.ship === 'string' ? a.ship : 'ship' }) });
    const text = JSON.stringify(doc, null, 1) + '\n';
    if (typeof a.out === 'string') { fs.mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true }); fs.writeFileSync(a.out, text); console.log(`${doc.zones.length} zones (${a.archetype}) → ${a.out}`); }
    else process.stdout.write(text);
    return 0;
  }
  if (cmd === 'validate-zones') {
    if (!a.zones) throw new Error('validate-zones: --zones required');
    const doc = JSON.parse(fs.readFileSync(a.zones, 'utf8'));
    let hullBounds = null;
    if (a['hull-size']) { const s = vec(a['hull-size']); hullBounds = { min: s.map((v) => -v / 2), max: s.map((v) => v / 2) }; }
    const v = validateDetailZones(doc, { hullBounds });
    for (const e of v.errors) console.log(`ERROR ${e}`);
    for (const w of v.warnings) console.log(`warn  ${w}`);
    console.log(`${v.ok ? 'OK' : 'INVALID'}: ${v.zones.length} zones, ${v.errors.length} errors, ${v.warnings.length} warnings`);
    return v.ok ? 0 : 1;
  }
  if (cmd === 'hull') {
    for (const k of ['top', 'side', 'front']) if (!a[k]) throw new Error(`hull: --${k} required`);
    const vs = a['voxel-scale'] ? Number(a['voxel-scale']) : 3.5;
    const maskOpts = { channel: a.channel || 'auto', threshold: a.threshold ? Number(a.threshold) : 128, invert: !!a.invert };
    const masks = { top: a.top, side: a.side, front: a.front };
    const dims = hullDimsFromMasks(masks, { lengthY: a['length-y'] ? Number(a['length-y']) : undefined, pixelSize: a['pixel-size'] ? Number(a['pixel-size']) : undefined, voxelScale: vs, maskOpts });
    for (const w of dims.warnings) console.log(`warn  ${w}`);
    const pal = new MegaPalette(); pal.add('hull', '#7c8594', { matTag: 1 });
    const g = new VoxelGrid(...dims.dims);
    const res = carveVisualHull(g, masks, dims.bounds, { fill: 1, maskOpts });
    const center = dims.bounds.min.map((m, k) => (m + dims.bounds.max[k]) / 2);
    let zonesDoc = null;
    if (a.zones) {
      zonesDoc = JSON.parse(fs.readFileSync(a.zones, 'utf8'));
      const v = validateDetailZones(zonesDoc);
      if (!v.ok) throw new Error(`zones invalid: ${v.errors.join('; ')}`);
      const c = applyDetailZoneCarves(g, zonesDoc, { voxelScale: vs, center });
      console.log(`detail-zone carves: ${c.total} voxels (${Object.entries(c.perZone).map(([k, n]) => `${k} ${n}`).join(', ')})`);
    }
    console.log(`visual hull ${dims.dims.join('×')} vox @ ${vs} u/vox (${dims.size.map((v) => Math.round(v)).join('×')} u): ${res.voxels} voxels · fidelity top ${res.fidelity.top} side ${res.fidelity.side} front ${res.fidelity.front} · view mismatch ${(dims.maxMismatch * 100).toFixed(1)} %`);
    const packed = packMegaAsset({ id: path.basename(typeof a.out === 'string' ? a.out : 'hull').replace(/[^a-z0-9_-]/gi, '_'), palette: pal, voxelScale: vs, center, detailZones: zonesDoc },
      [{ name: 'hull', grid: g, bakeAo: !a['no-ao'] }]);
    const w = writeMegaAsset(path.resolve(typeof a.out === 'string' ? a.out : 'hull'), packed);
    printStats(packed.json);
    console.log(`  → ${w.jsonPath}`);
    return res.minFidelity >= 0.9 ? 0 : 1;
  }
  if (cmd === 'preview') {
    if (!a.asset || typeof a.out !== 'string') throw new Error('preview: --asset and --out required');
    const num = (k) => (a[k] !== undefined ? Number(a[k]) : undefined);
    const r = renderPreview(a.asset, { view: typeof a.view === 'string' ? a.view : 'hero34', yaw: num('yaw'), pitch: num('pitch'), width: num('width') ?? 640, height: num('height') ?? 400, includeInstances: !a['no-instances'] });
    writePNG(a.out, r.image);
    console.log(`preview ${r.image.width}×${r.image.height} (${r.triangles} tris, ${r.pixels} covered px) → ${a.out}`);
    return r.pixels > 0 ? 0 : 1;
  }
  if (cmd === 'inspect') {
    if (!a.asset) throw new Error('inspect: --asset required');
    const r = readMegaAsset(a.asset);
    printStats(r.json);
    return 0;
  }
  console.log('usage: node mega_voxel_kit.mjs <demo|zones-template|validate-zones|hull|inspect|preview> [options]   (see header comment)');
  return cmd ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  try { process.exitCode = cli(process.argv.slice(2)); } catch (e) { console.error(`error: ${e.message}`); process.exitCode = 1; }
}
