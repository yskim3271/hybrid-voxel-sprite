#!/usr/bin/env node
// test_mega_kit.mjs — hybrid-voxel-sprite v2.3 self-test for mega_voxel_kit.mjs + mega_diff_utils.mjs
// (v2.0 sections 1–6 unchanged; v2.2: section 7 packed20 20 B/vert codec + MEGA_V22 assets, section 8 G5-Edge / G5-Band;
//  v2.3: section 9 quad16 16 B/quad instanced quads + MEGA_V23 assets + MEGA_V23_BUDGET, section 10 G5-v2.3 hull-only IoU;
//  section 11 project-neutral abstractions: configurable accent bands, generic archetype + assetId, material profiles).
// Zero dependencies. Writes temporary files only under os.tmpdir() and removes them. Exit 0 = all checks PASS.
//
//   node scripts/test_mega_kit.mjs [--keep]   (--keep leaves the temp dir for inspection)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  VoxelGrid, MegaPalette, shapes, gridIoU, projectSilhouettes, carveVisualHull, hullDimsFromMasks, bakeMacroCavityAO,
  greedyMeshPart, decodeMeta, packMegaAsset, writeMegaAsset, readMegaAsset, checkPerfBudget, validateDetailZones,
  scaffoldDetailZones, applyDetailZoneCarves, zoneVoxelStats, buildDemoCarrier, DETAIL_ZONE_ARCHETYPES, DETAIL_ZONE_KINDS,
  MEGA_SCHEMA, F_CAVITY, F_LOCK, renderPreview,
  MEGA_V22_SCHEMA, MEGA_V22_BUDGET, packQuantizedMegaV22, unpackQuantizedMegaV22,
  MEGA_V23_SCHEMA, MEGA_V23_BUDGET, QUAD16_LAYOUT, greedyQuad16Part, packQuad16, unpackQuad16, quad16ToMesh, quad16Corner,
  ARCHETYPES, MATERIAL_PRESETS, resolveMaterialProfile, V12_LAYOUT,
} from './mega_voxel_kit.mjs';
import {
  decodePNG, encodePNG, readPNG, writePNG, createImage, maskToImage, toMask, computeSilhouetteIoU, composeComparisonSheet,
  computeEdgeG5, computeBandG5, computeMultiCueG5, multiCueSummary, composeMultiCueSheet, G5_V22_TARGETS,
  computeHullSilhouetteIoU, G5_V23_TARGETS, DEFAULT_ACCENT_BANDS, normalizeAccentBands, parseAccentBands, accentClass,
} from './mega_diff_utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEEP = process.argv.includes('--keep');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mega_kit_test_'));
let pass = 0, fail = 0;
const t0 = Date.now();
function check(name, ok, detail = '') {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
function section(title, fn) {
  console.log(`\n## ${title}`);
  try { fn(); } catch (e) { check(`${title}: no exception`, false, e.stack.split('\n').slice(0, 3).join(' | ')); }
}
const f3 = (v) => v.toFixed(3);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** mask → RGBA PNG scaled ×k with a transparent margin (simulates a blueprint view framed differently). */
function framedMaskPNG(mask, k, padX, padY, file) {
  const img = createImage(mask.width * k + 2 * padX, mask.height * k + padY * 2 + 7, [0, 0, 0, 0]);
  for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
    if (!mask.data[y * mask.width + x]) continue;
    for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) img.data.set([200, 210, 225, 255], ((padY + y * k + j) * img.width + padX + x * k + i) * 4);
  }
  writePNG(file, img);
  return file;
}

// ================================================================================================ 1 visual hull
section('1 · Stage 1A 3-view visual hull + Stage 1B occluded-cavity carve', () => {
  const truth = new VoxelGrid(64, 128, 40);
  truth.prism([[8, 8], [56, 8], [56, 90], [44, 120], [20, 120], [8, 90]], 'z', 6, 22, 1);   // hull, tapered bow
  truth.prism([[10, 6], [110, 6], [100, 2], [20, 2]], 'x', 20, 44, 1);                         // keel wedge (side-profile prism)
  truth.box([16, 20, 22], [48, 70, 30], 2);                                                     // superstructure
  truth.box([24, 30, 30], [40, 55, 36], 2);                                                     // bridge tier
  truth.capsule([20, 3, 14], [20, 20, 14], 5, 3); truth.capsule([44, 3, 14], [44, 20, 14], 5, 3);   // engines
  const sil = projectSilhouettes(truth);
  // blueprint PNGs at different zoom + framing → exercises PNG decode + bbox registration
  const files = {
    top: framedMaskPNG(sil.top, 3, 17, 9, path.join(TMP, 'bp_top.png')),
    side: framedMaskPNG(sil.side, 4, 5, 30, path.join(TMP, 'bp_side.png')),
    front: framedMaskPNG(sil.front, 2, 40, 3, path.join(TMP, 'bp_front.png')),
  };
  const bb = truth.bbox();
  const hull = new VoxelGrid(64, 128, 40);
  const res = carveVisualHull(hull, files, bb, { fill: 1 });
  const iou = gridIoU(hull, truth);
  check('carveVisualHull 3D IoU vs synthetic hull >= 0.92', iou >= 0.92, `IoU ${f3(iou)} (${res.voxels} vs ${truth.count()} voxels, mode ${res.mode})`);
  check('re-projection fidelity >= 0.90 on every view', res.minFidelity >= 0.9, `top ${res.fidelity.top} side ${res.fidelity.side} front ${res.fidelity.front}`);
  // carve mode: start from a solid block, carve down to the hull
  const block = new VoxelGrid(64, 128, 40);
  block.box(bb.min, bb.max, 1);
  block.set(1, 1, 1, 1, F_LOCK);                                                                  // locked cell survives
  const res2 = carveVisualHull(block, files, bb);
  check('carve mode (solid block → hull) matches fill mode; F_LOCK survives', res2.mode === 'carve' && block.get(1, 1, 1) === 1 && Math.abs(res2.voxels - 1 - res.voxels) === 0, `carved ${res2.carved}`);
  // blueprint proportion check
  const dims = hullDimsFromMasks(files, { lengthY: (bb.max[1] - bb.min[1]) * 4, voxelScale: 4, margin: 0 });
  check('hullDimsFromMasks recovers dims from framed views (±1 vox, mismatch < 3 %)',
    dims.dims.every((v, k) => Math.abs(v - (bb.max[k] - bb.min[k])) <= 1) && dims.maxMismatch < 0.03, `dims ${dims.dims.join('×')} vs ${[0, 1, 2].map((k) => bb.max[k] - bb.min[k]).join('×')}, mismatch ${(dims.maxMismatch * 100).toFixed(2)} %`);
  // occluded cavities (flank hangars + roof trench) are invisible to a 3-view hull …
  const cavTruth = truth.clone();
  const zonesDoc = {
    schema: 'svox.detail_zones/v1', zones: [
      { zoneId: 'flank_hangar_port', kind: 'occluded_cavity', boundsLocal: { min: [8, 30, 9], max: [20, 85, 19] }, cameraView: 'oblique_closeup', calloutImage: 'callouts/port.png', targetVoxelScale: 1.5, requiredFeatures: ['recess depth 12 vox'], carve: [{ shape: 'box', min: [8, 30, 9], max: [20, 85, 19] }] },
      { zoneId: 'flank_hangar_stbd', kind: 'occluded_cavity', boundsLocal: { min: [44, 30, 9], max: [56, 85, 19] }, cameraView: 'oblique_closeup', calloutImage: 'callouts/stbd.png', targetVoxelScale: 1.5, requiredFeatures: ['recess depth 12 vox'], carve: [{ shape: 'box', min: [44, 30, 9], max: [56, 85, 19] }] },
      { zoneId: 'roof_trench', kind: 'occluded_cavity', boundsLocal: { min: [27, 72, 14], max: [37, 118, 22] }, cameraView: 'interior_front', calloutImage: 'callouts/trench.png', targetVoxelScale: 1.5, requiredFeatures: ['trench floor', 'edge lights'], carve: [{ shape: 'box', min: [27, 72, 14], max: [37, 118, 22] }] },
    ],
  };
  applyDetailZoneCarves(cavTruth, zonesDoc);   // the "real" ship has cavities
  const silC = projectSilhouettes(cavTruth);
  const same = ['top', 'side', 'front'].every((v) => silC[v].data.every((x, i) => x === sil[v].data[i]));
  const before = gridIoU(hull, cavTruth);
  const zv = validateDetailZones(zonesDoc, { hullBounds: { min: bb.min, max: bb.max } });
  const carved = applyDetailZoneCarves(hull, zonesDoc);
  const after = gridIoU(hull, cavTruth);
  const zs = zoneVoxelStats(hull, zonesDoc.zones[2]);
  check('cavities leave all 3 silhouettes unchanged (why Stage 1B is mandatory)', same);
  check('3-view hull alone misses the cavities (IoU < 0.92)', before < 0.92, `IoU ${f3(before)}`);
  check('detail-zone carve restores IoU >= 0.92 and marks cavity air F_CAVITY', zv.ok && after >= 0.92 && after > before + 0.05 && zs.cavityAir > 0 && (hull.getFlags(30, 100, 18) & F_CAVITY) !== 0,
    `IoU ${f3(before)} → ${f3(after)}, carved ${carved.total}, trench cavity air ${zs.cavityAir}`);
});

// ================================================================================================ 2 macro cavity AO
section('2 · Stage 3 cavity subtraction + bakeMacroCavityAO', () => {
  const g = new VoxelGrid(48, 96, 32);
  g.box([4, 4, 4], [44, 92, 20], 1);
  const removed = g.subtract(shapes.box([4, 30, 8], [16, 60, 16]));            // flank hangar, open to −X, 12 deep
  const ao = bakeMacroCavityAO(g);
  const roof = [], interior = [], rim = [], wallTop = [];
  for (let y = 10; y < 86; y++) for (let x = 10; x < 38; x++) roof.push(ao.get(x, y, 19, 4));
  for (let y = 32; y < 58; y++) {
    for (let z = 8; z < 16; z++) interior.push(ao.get(16, y, z, 1));             // back wall (faces −X)
    for (let x = 10; x < 16; x++) { interior.push(ao.get(x, y, 7, 4)); interior.push(ao.get(x, y, 16, 5)); }   // floor + ceiling, deep half
  }
  for (let y = 4; y < 92; y++) { rim.push(ao.get(43, y, 19, 4), ao.get(4, y, 19, 4)); wallTop.push(ao.get(43, y, 19, 0), ao.get(4, y, 19, 1)); }
  check('subtract() carved the hangar (12×30×8 = 2880 voxels)', removed === 2880, `${removed}`);
  check('hangar interior measurably darker than the exposed roof deck', mean(interior) <= 0.6 && mean(roof) >= 0.95 && mean(roof) - mean(interior) >= 0.35,
    `roof ${f3(mean(roof))} vs interior ${f3(mean(interior))} (${ao.stats.faces} faces, ${ao.stats.ms} ms)`);
  check('convex hull edges stay clean (rim top + wall-top faces >= 0.95)', Math.min(...rim) >= 0.95 && Math.min(...wallTop) >= 0.95, `min rim ${f3(Math.min(...rim))}, min wall ${f3(Math.min(...wallTop))}`);
  // convex staircase (rise 1 / run 3): smoothed-normal origin offset vs naive face-normal bake (negative control)
  const st = new VoxelGrid(24, 80, 48);
  for (let y = 4; y < 76; y++) st.box([4, y, 4], [20, y + 1, 5 + Math.floor((y - 4) / 3)], 1);
  const treads = (a) => { const v = []; for (let y = 10; y < 70; y++) { const top = 4 + Math.floor((y - 4) / 3); for (let x = 8; x < 16; x++) v.push(a.get(x, y, top, 4)); } return v; };
  const fixed = treads(bakeMacroCavityAO(st)), naive = treads(bakeMacroCavityAO(st, { blurRadius: 0, startOffset: 0 }));
  check('no convex-staircase greying (min tread >= 0.99; naive face-normal bake < 0.95)', Math.min(...fixed) >= 0.99 && Math.min(...naive) < 0.95,
    `smoothed min ${f3(Math.min(...fixed))} · naive min ${f3(Math.min(...naive))}`);
  const again = bakeMacroCavityAO(g);
  check('bake is deterministic', sha(again.data) === sha(ao.data));
});

// ================================================================================================ 3 greedy mesher
section('3 · greedyMeshPart (AO-preserving greedy, MEGA_V2 / FLOAT11)', () => {
  const pal = new MegaPalette();
  const H = pal.add('hull', '#7c8594', { matTag: 1 }), D = pal.add('dark', '#4a505c', { matTag: 2 }), E = pal.add('light', '#5ff0ff', { emissive: 1, matTag: 3 });
  // isolated box → exactly 6 quads, all micro AO = 1
  const box = new VoxelGrid(12, 12, 12); box.box([1, 1, 1], [11, 11, 11], H);
  const mb = greedyMeshPart(box, pal);
  let aoOne = true; for (let i = 0; i < mb.vertexCount; i++) if (mb.verts[i * 12 + 10] !== 1) aoOne = false;
  check('isolated 10³ box → 6 quads / 12 tris, all micro AO = 1', mb.quads === 6 && mb.triangles === 12 && mb.exposedFaces === 600 && aoOne, `quads ${mb.quads}, faces ${mb.exposedFaces}`);
  // stepped hull: 6 terraced tiers + emissive strips
  const g = new VoxelGrid(100, 164, 30);
  for (let k = 0; k < 6; k++) g.box([2 + k * 4, 2 + k * 6, 2 + k * 4], [98 - k * 4, 162 - k * 6, 6 + k * 4], k % 2 ? D : H);
  for (let k = 0; k < 6; k++) g.box([3 + k * 4, 2 + k * 6, 4 + k * 4], [97 - k * 4, 3 + k * 6, 5 + k * 4], E, { mode: 'paint' });
  const vs = 3.5, center = [50, 82, 0];
  const ao = bakeMacroCavityAO(g, { rays: 16 });
  const m = greedyMeshPart(g, pal, { voxelScale: vs, center, macroAo: ao });
  check('stepped hull greedy quad reduction > 75 %', m.reduction > 0.75, `${m.exposedFaces} faces → ${m.quads} quads (${(m.reduction * 100).toFixed(1)} %), ${m.triangles} tris, ${m.vertexCount} verts`);
  // area preservation + winding
  let area = 0, windOK = true;
  for (let t = 0; t < m.indexCount; t += 3) {
    const p = [0, 1, 2].map((k) => [0, 1, 2].map((c) => m.verts[m.idx[t + k] * 12 + c]));
    const e1 = p[1].map((v, c) => v - p[0][c]), e2 = p[2].map((v, c) => v - p[0][c]);
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    area += Math.hypot(...cr) / 2;
    const n = [3, 4, 5].map((c) => m.verts[m.idx[t] * 12 + c]);
    if (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] <= 0) windOK = false;
  }
  check('merged quads cover exactly the exposed faces (area invariant)', Math.abs(area / (vs * vs) - m.exposedFaces) < 1e-3 * m.exposedFaces, `area ${(area / (vs * vs)).toFixed(1)} vs ${m.exposedFaces}`);
  check('every triangle winds CCW around its outward normal', windOK);
  let idxOK = true; for (const i of m.idx) if (i >= m.vertexCount) idxOK = false;
  const metas = new Set(); let tagOK = true;
  for (let i = 0; i < m.vertexCount; i++) { const d = decodeMeta(m.verts[i * 12 + 11]); metas.add(d.matTag); if (d.macroAo < 0 || d.macroAo > 1) tagOK = false; }
  check('indices in range; meta decodes matTag 1..3 + macroAo 0..1', idxOK && tagOK && [1, 2, 3].every((t) => metas.has(t)), `tags {${[...metas].join(',')}}`);
  // legacy 11-float layout: identical topology, floats 0–9 identical, ao(FLOAT11) = microAo · macroAo
  const m12 = greedyMeshPart(g, pal, { voxelScale: vs, center, macroAo: ao, format: 'FLOAT11' });
  let same = m12.vertexCount === m.vertexCount && m12.indexCount === m.indexCount && m12.idx.every((v, i) => v === m.idx[i]);
  let maxErr = 0;
  for (let i = 0; same && i < m.vertexCount; i++) {
    for (let c = 0; c < 10; c++) if (m12.verts[i * 11 + c] !== m.verts[i * 12 + c]) same = false;
    maxErr = Math.max(maxErr, Math.abs(m12.verts[i * 11 + 10] - m.verts[i * 12 + 10] * decodeMeta(m.verts[i * 12 + 11]).macroAo));
  }
  check('FLOAT11 11-float export: same topology, floats 0–9 identical, ao = micro × macro', same && maxErr < 2.5e-3, `max |Δao| ${maxErr.toExponential(2)}`);
});

// ================================================================================================ 4 pack svox.mega/v2
section('4 · packMegaAsset svox.mega/v2 (macro + instanced meso + detail zones)', () => {
  const builds = [0, 1].map(() => { const d = buildDemoCarrier(); return { d, packed: packMegaAsset(d.manifest, d.macroParts, d.mesoPrefabs, d.instances) }; });
  const w = builds.map((b, i) => writeMegaAsset(path.join(TMP, `pack${i}`, 'demo_carrier'), b.packed));
  check('deterministic binary + json across two independent builds', w[0].binSha256 === w[1].binSha256 && w[0].jsonSha256 === w[1].jsonSha256, `bin ${w[0].binSha256.slice(0, 16)}…`);
  const { d, packed } = builds[0];
  const { json, stats } = packed;
  const r = readMegaAsset(w[0].jsonPath);
  check('schema svox.mega/v2, MEGA_V2 48-byte layout, detailZones[] embedded', json.schema === MEGA_SCHEMA && r.json.vertexLayout.stride === 48 && r.json.detailZones.length === 3 && r.bytes === stats.binBytes);
  const hull = r.part('hull');
  let ok = hull.idx.every((i) => i < hull.meta.vertexCount);
  for (const p of json.meso.prefabs) { const pf = r.prefab(p.id); ok = ok && pf.idx.every((i) => i < p.vertexCount) && pf.matrices.length === p.instanceCount * 16; }
  check('every part / prefab slice decodes from the .bin with valid indices', ok);
  // instance matrix = T · R(q) · S with tint
  const tur = r.prefab('turret'), inst = d.instances.find((i) => i.prefab === 'turret');
  const M = tur.matrices, q = inst.rotQuat;
  const ex = [1 - 2 * (q[1] * q[1] + q[2] * q[2]), 2 * (q[0] * q[1] + q[3] * q[2]), 2 * (q[0] * q[2] - q[3] * q[1])];   // R·(1,0,0)
  const mErr = Math.max(Math.abs(M[12] - inst.pos[0]), Math.abs(M[13] - inst.pos[1]), Math.abs(M[14] - inst.pos[2]), ...ex.map((v, k) => Math.abs(M[k] - v)));
  const rib = r.prefab('hangar_rib');
  check('instance stream: column-major TRS mat4 + RGB tint per instance', mErr < 1e-3 && Math.abs(rib.colors[1] - 0.96) < 1e-6 && tur.meta.instanceCount === 8 && rib.meta.instanceCount === 8, `max err ${mErr.toExponential(2)}`);
  const expInst = json.meso.prefabs.reduce((s, p) => s + p.triangles * p.instanceCount, 0);
  check('stats: drawCalls = macro parts + used prefab batches; instanced tri sum; reduction > 75 %',
    stats.drawCalls === json.macro.parts.length + 2 && stats.instancedTriangles === expInst && stats.totalTriangles === stats.macroTriangles + expInst && stats.greedyReduction > 0.75,
    `draw ${stats.drawCalls}, tris ${stats.totalTriangles} (macro ${stats.macroTriangles} + inst ${stats.instancedTriangles}), greedy ${(stats.greedyReduction * 100).toFixed(1)} %, bin ${(stats.binBytes / 1024).toFixed(0)} KiB`);
  const bud = json.budget, bud2 = checkPerfBudget(stats, {}, { earlyZAlive: true, gpuDeltaMs: 0.3 }), bud3 = checkPerfBudget({ ...stats, drawCalls: 13, mesoBatches: 10 });
  check('G6: static budget PASS, unmeasured runtime → not passed; over-budget → FAIL', bud.staticPass && !bud.pass && bud2.pass && !bud3.staticPass);
  // the macro AO made the catapult trench darker than the open deck
  const trench = [], deck = [];
  const C = d.manifest.center;
  for (let y = 192; y < 240; y++) { for (let x = 31; x < 41; x++) trench.push(decodeAt(hull, x, y, 18)); }
  for (let y = 20; y < 30; y++) for (let x = 10; x < 20; x++) deck.push(decodeAt(hull, x, y, 26));
  function decodeAt(h, x, y, zTop) {   // macroAo of the +Z face vertex nearest (x, y, zTop) in voxel coords
    const vs = 4, FL = 12; let best = Infinity, v = 1;
    for (let i = 0; i < h.meta.vertexCount; i++) {
      if (h.verts[i * FL + 5] !== 1) continue;
      const dz = h.verts[i * FL + 2] / vs + C[2] - zTop; if (Math.abs(dz) > 1e-4) continue;
      const dd = Math.hypot(h.verts[i * FL] / vs + C[0] - x, h.verts[i * FL + 1] / vs + C[1] - y);
      if (dd < best) { best = dd; v = decodeMeta(h.verts[i * FL + 11]).macroAo; }
    }
    return v;
  }
  check('demo carrier: catapult trench floor darker than open flight deck (macro AO in .bin)', mean(trench) < mean(deck) - 0.1, `trench ${f3(mean(trench))} vs deck ${f3(mean(deck))}`);
  // CPU preview of the packed asset re-projects onto the voxel silhouettes (G5 plumbing without an engine)
  const sil = projectSilhouettes(d.grid);
  const ious = ['top', 'side', 'front'].map((v) => computeSilhouetteIoU(sil[v], renderPreview(r, { view: v, includeInstances: false, width: 480, height: 480 }).image).iou);
  const hero = renderPreview(r, { view: 'hero34', width: 320, height: 200 });
  let emissive = 0; for (let i = 0; i < hero.image.data.length; i += 4) if (hero.image.data[i + 2] > 230 && hero.image.data[i] < 140) emissive++;
  check('renderPreview: ortho previews match voxel silhouettes (IoU >= 0.95); hero 3/4 shows emissive pixels', ious.every((v) => v >= 0.95) && hero.pixels > 5000 && emissive > 0,
    `top ${f3(ious[0])} side ${f3(ious[1])} front ${f3(ious[2])} · hero ${hero.pixels} px, ${emissive} cyan px`);
  // negative paths
  let threw = false;
  try { packMegaAsset(d.manifest, d.macroParts, d.mesoPrefabs, [{ prefab: 'nope', pos: [0, 0, 0] }]); } catch { threw = true; }
  const bad = validateDetailZones({ schema: 'svox.detail_zones/v1', zones: [
    { zoneId: 'a', kind: 'bogus', boundsLocal: { min: [0, 0, 0], max: [1, 1, 1] }, cameraView: 'oblique_closeup', calloutImage: 'x.png', targetVoxelScale: 1.5, requiredFeatures: ['x'] },
    { zoneId: 'a', kind: 'occluded_cavity', boundsLocal: { min: [2, 0, 0], max: [1, 1, 1] }, cameraView: 'interior_front', calloutImage: 'y.png', targetVoxelScale: 0, requiredFeatures: [] },
  ] });
  check('unknown prefab instance throws; invalid zones are rejected (kind, dup id, bounds, scale, features)', threw && !bad.ok && bad.errors.length >= 5, `${bad.errors.length} errors`);
  const arch = Object.keys(DETAIL_ZONE_ARCHETYPES).map((k) => scaffoldDetailZones(k, { hullSize: [300, 1000, 200], shipId: k }));
  check('all archetype templates validate and cover all 4 zone kinds', arch.every((a) => validateDetailZones(a).ok && DETAIL_ZONE_KINDS.every((kd) => a.zones.some((z) => z.kind === kd))), arch.map((a) => `${a.archetype}:${a.zones.length}`).join(' '));
});

// ================================================================================================ 5 diff utils
section('5 · mega_diff_utils PNG codec + Silhouette IoU + comparison sheet', () => {
  const W = 37, H = 23, src = createImage(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) src.data.set([(x * 7) & 255, (y * 11) & 255, (x * y) & 255, x % 5 === 0 ? 0 : 255 - y], (y * W + x) * 4);
  let codecOK = true; const fails = [];
  for (const ct of [6, 2, 0, 4, 3]) for (const filter of ['none', 'sub', 'up', 'avg', 'paeth', 'adaptive']) for (const interlace of [false, true]) {
    let img = src;
    if (ct === 3) { img = createImage(W, H); for (let i = 0; i < W * H; i++) img.data.set([(i % 7) * 30, (i % 5) * 40, 99, i % 3 ? 255 : 0], i * 4); }
    const dec = decodePNG(encodePNG(img, { colorType: ct, filter, interlace }));
    for (let i = 0; i < W * H; i++) {
      const s = img.data.subarray(i * 4, i * 4 + 4), d2 = dec.data.subarray(i * 4, i * 4 + 4);
      const exp = ct === 6 || ct === 3 ? [...s] : ct === 2 ? [s[0], s[1], s[2], 255] : ct === 0 ? [s[0], s[0], s[0], 255] : [s[0], s[0], s[0], s[3]];
      if (exp.some((v, k) => v !== d2[k])) { codecOK = false; fails.push(`${ct}/${filter}/${interlace}`); break; }
    }
  }
  check('PNG round-trip: colour types 6/2/0/4/3 × 6 filters × Adam7 on/off', codecOK, fails.slice(0, 4).join(' '));
  let crcCaught = false;
  const good = encodePNG(src); const corrupt = Buffer.from(good); corrupt[40] ^= 0xff;
  try { decodePNG(corrupt); } catch (e) { crcCaught = /CRC|inflate|incorrect|invalid/i.test(e.message); }
  check('corrupted PNG is rejected (CRC check)', crcCaught);
  const disc = (w, h, cx, cy, rx, ry, rgba = [230, 230, 240, 255], bg = [0, 0, 0, 0]) => {
    const img = createImage(w, h, bg);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1) img.data.set(rgba, (y * w + x) * 4);
    return img;
  };
  const refPath = writePNG(path.join(TMP, 'ref_disc.png'), disc(128, 128, 64, 64, 40, 40));
  const shifted = writePNG(path.join(TMP, 'render_shift.png'), disc(256, 200, 150, 90, 60, 60));
  const stretched = disc(200, 200, 100, 100, 52, 40);
  const same = computeSilhouetteIoU(refPath, refPath);
  const reg = computeSilhouetteIoU(refPath, shifted);
  const drift = computeSilhouetteIoU(refPath, stretched);
  const driftStretch = computeSilhouetteIoU(refPath, stretched, { register: 'bbox-stretch' });
  const empty = computeSilhouetteIoU(refPath, createImage(64, 64));
  check('IoU: identical = 1, framing/zoom/offset registered away (>= 0.97)', same.iou === 1 && reg.iou >= 0.97, `same ${f3(same.iou)} · shifted+scaled ${f3(reg.iou)}`);
  check('IoU: 1.3:1 proportion drift is caught by aspect-preserving bbox (< 0.85), hidden by bbox-stretch', drift.iou < 0.85 && driftStretch.iou >= 0.95 && empty.iou === 0, `bbox ${f3(drift.iou)} · stretch ${f3(driftStretch.iou)} · empty ${f3(empty.iou)}`);
  const opaque = disc(128, 128, 64, 64, 40, 40, [200, 120, 60, 255], [24, 26, 34, 255]);   // studio backdrop (JPG-like)
  const keyed = computeSilhouetteIoU(opaque, refPath);
  check('auto mask: opaque studio backdrop keyed against corner colour', toMask(opaque).data.some((v) => v) && keyed.iou >= 0.99, `IoU ${f3(keyed.iou)}`);
  const sheetPath = path.join(TMP, 'sheet.png');
  const sheet = composeComparisonSheet([
    { label: 'HERO 3/4', ref: refPath, render: shifted, target: 0.78 },
    { label: 'TOP ORTHO', ref: refPath, render: stretched, target: 0.85 },
  ], sheetPath, { title: 'SELF TEST' });
  const back = readPNG(sheetPath);
  const px = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
  const r0 = sheet.rows[0].rects[0], r1 = sheet.rows[1].rects[0];
  const g0 = px(back, r0.x, r0.y + 20), red1 = px(back, r1.x, r1.y + 20);
  const dr = sheet.rows[0].rects[2]; let greenDiff = 0;
  for (let y = dr.y; y < dr.y + dr.h; y++) for (let x = dr.x; x < dr.x + dr.w; x++) { const c = px(back, x, y); if (c[1] > 180 && c[0] < 120) greenDiff++; }
  check('comparison sheet written, PASS row green / FAIL row red, IoU mask panel populated',
    back.width === sheet.width && back.height === sheet.height && sheet.rows[0].pass === true && sheet.rows[1].pass === false && g0[1] > g0[0] && red1[0] > red1[1] && greenDiff > 1000,
    `${sheet.width}×${sheet.height}, rows ${sheet.rows.map((r) => `${r.label}=${f3(r.iou)}`).join(', ')}`);
});

// ================================================================================================ 6 CLI smoke
section('6 · CLI smoke (demo / hull / preview / zones-template / validate-zones / inspect / iou)', () => {
  const kit = path.join(HERE, 'mega_voxel_kit.mjs'), du = path.join(HERE, 'mega_diff_utils.mjs');
  const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  const out = path.join(TMP, 'cli');
  const demo = run(kit, ['demo', '--out', out]);
  check('mega_voxel_kit demo exits 0 and writes asset + zones + silhouettes', demo.status === 0 && ['demo_carrier.json', 'demo_carrier.bin', 'detail_zones.json', 'silhouette_top.png'].every((f) => fs.existsSync(path.join(out, f))), demo.status ? demo.stderr.trim() : demo.stdout.split('\n')[0]);
  const sp = (v) => path.join(out, `silhouette_${v}.png`);
  const hull = run(kit, ['hull', '--top', sp('top'), '--side', sp('side'), '--front', sp('front'), '--length-y', '968', '--voxel-scale', '4', '--zones', path.join(out, 'detail_zones.json'), '--out', path.join(out, 'hull_rebuild')]);
  const prev = run(kit, ['preview', '--asset', path.join(out, 'hull_rebuild.json'), '--view', 'hero34', '--out', path.join(out, 'hull_rebuild.png'), '--width', '320', '--height', '200']);
  check('hull CLI: blueprint PNGs + detail_zones.json → svox.mega/v2 (fidelity >= 0.90), preview CLI renders it',
    hull.status === 0 && prev.status === 0 && fs.existsSync(path.join(out, 'hull_rebuild.bin')) && fs.existsSync(path.join(out, 'hull_rebuild.png')),
    hull.status ? hull.stderr.trim() : (hull.stdout.split('\n').find((l) => l.startsWith('visual hull')) || '').slice(0, 110));
  const zf = path.join(out, 'bio.json');
  const zt = run(kit, ['zones-template', '--archetype', 'bio_leviathan', '--hull-size', '1059,1277,206', '--out', zf]);
  const zvOk = run(kit, ['validate-zones', '--zones', zf, '--hull-size', '1059,1277,206']);
  fs.writeFileSync(path.join(out, 'bad.json'), JSON.stringify({ schema: 'svox.detail_zones/v1', zones: [{ zoneId: 'X Y', kind: 'nope' }] }));
  const zvBad = run(kit, ['validate-zones', '--zones', path.join(out, 'bad.json')]);
  const insp = run(kit, ['inspect', '--asset', path.join(out, 'demo_carrier.json')]);
  check('zones-template + validate-zones (0 on valid, 1 on invalid) + inspect', zt.status === 0 && zvOk.status === 0 && zvBad.status === 1 && insp.status === 0, `${zvOk.stdout.trim().split('\n').pop()} | ${zvBad.stdout.trim().split('\n').pop()}`);
  const top = path.join(out, 'silhouette_top.png');
  const i1 = run(du, ['iou', '--ref', top, '--render', top, '--target', '0.99']);
  const i2 = run(du, ['iou', '--ref', top, '--render', path.join(out, 'silhouette_front.png'), '--target', '0.85', '--diff', path.join(out, 'diff.png')]);
  check('mega_diff_utils iou: exit 0 when >= target, 1 when below; diff PNG written', i1.status === 0 && i2.status === 1 && fs.existsSync(path.join(out, 'diff.png')), `${i1.stdout.trim()} | ${i2.stdout.trim().slice(0, 40)}…`);
});

// ================================================================================================ 7 v2.2 20 B/vert quantized format
section('7 · svox.mega/v2.2 packed20 (20 B/vert quantized) codec + packMegaAsset MEGA_V22', () => {
  // 7a — synthetic 1000 u hull bounds: worst-case round trip
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const n = 5000, V = new Float32Array(n * 12), Ex = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const o = i * 12;
    V[o] = (rnd() - 0.5) * 380; V[o + 1] = (rnd() - 0.5) * 1000; V[o + 2] = (rnd() - 0.5) * 360;
    const ax = Math.floor(rnd() * 3), sg = rnd() < 0.5 ? -1 : 1; V[o + 3 + ax] = sg;
    V[o + 6] = rnd(); V[o + 7] = rnd(); V[o + 8] = rnd(); V[o + 9] = rnd() < 0.8 ? 0 : rnd();
    V[o + 10] = Math.floor(rnd() * 4) / 3; V[o + 11] = Math.floor(rnd() * 7) * 256 + Math.floor(rnd() * 256);
    Ex[i * 3] = rnd() < 0.5 ? 1 : 0; Ex[i * 3 + 1] = rnd() < 0.5 ? 1 : 0; Ex[i * 3 + 2] = Math.floor(rnd() * 256) / 255;
  }
  V[1] = -500; V[13] = 500;   // force the full 1000 u Y extent
  const q = packQuantizedMegaV22({ verts: V, extra: Ex, vertexCount: n });
  const back = unpackQuantizedMegaV22(q.bytes, n, q.posCenter, q.posHalfExt);
  let ep = 0, en = 0, ec = 0, ea = 0, meta = true, ex = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 12;
    for (let k = 0; k < 3; k++) ep = Math.max(ep, Math.abs(back.verts[o + k] - V[o + k]));
    for (let k = 3; k < 6; k++) en = Math.max(en, Math.abs(back.verts[o + k] - V[o + k]));
    for (let k = 6; k < 10; k++) ec = Math.max(ec, Math.abs(back.verts[o + k] - V[o + k]));
    ea = Math.max(ea, Math.abs(back.verts[o + 10] - V[o + 10]));
    if (back.verts[o + 11] !== V[o + 11]) meta = false;
    for (let k = 0; k < 3; k++) ex = Math.max(ex, Math.abs(back.extra[i * 3 + k] - Ex[i * 3 + k]));
  }
  check('packed20: exactly 20 B/vert, 1000 u bounds position round trip < 0.03 u', q.bytes.byteLength === n * 20 && q.stride === 20 && ep < 0.03 && q.maxPosError < 0.03,
    `${q.bytes.byteLength} B for ${n} verts · max |Δp| ${ep.toFixed(4)} u (halfExt ${q.posHalfExt.map((v) => v.toFixed(1)).join('/')})`);
  check('packed20: normals exact (axis), rgb/em < 1/255, microAo < 1/127, matTag+macroAo byte-exact, extras < 1/255',
    en < 1e-6 && ec <= 0.5 / 255 + 1e-6 && ea <= 0.5 / 127 + 1e-6 && meta && ex <= 0.5 / 255 + 1e-6, `|Δn| ${en.toExponential(1)} |Δc| ${ec.toExponential(2)} |Δao| ${ea.toExponential(2)} |Δx| ${ex.toExponential(2)}`);
  const sha2 = sha(packQuantizedMegaV22({ verts: V, extra: Ex, vertexCount: n }).bytes);
  check('packed20: deterministic SHA-256 (same input → same bytes)', sha(q.bytes) === sha2, sha2.slice(0, 16));

  // 7b — MEGA_V22 mesher: topology of MEGA_V2 without panels, extras populated, panels become merge boundaries
  const pal = new MegaPalette();
  const H = pal.add('hull', '#7c8594', { matTag: 1 }), D = pal.add('dark', '#4a505c', { matTag: 1 });
  const g = new VoxelGrid(80, 120, 30);
  for (let k = 0; k < 5; k++) g.box([2 + k * 3, 2 + k * 4, 2 + k * 3], [78 - k * 3, 118 - k * 4, 5 + k * 3], k % 2 ? D : H);   // stepped glacis
  const a2 = greedyMeshPart(g, pal, { voxelScale: 2.5, center: [40, 60, 0] });
  const a22 = greedyMeshPart(g, pal, { voxelScale: 2.5, center: [40, 60, 0], format: 'MEGA_V22' });
  let bev = 0, cre = 0; for (let i = 0; i < a22.vertexCount; i++) { if (a22.extra[i * 3] > 0.5) bev++; if (a22.extra[i * 3 + 1] > 0.5) cre++; }
  check('MEGA_V22 mesher: identical quads/triangles to MEGA_V2 (no panels), bevelHint + creaseMask populated on the stepped treads / risers',
    a22.quads === a2.quads && a22.triangles === a2.triangles && a22.extra.length === a22.vertexCount * 3 && bev > 20 && cre > 20, `quads ${a22.quads}, verts ${a2.vertexCount} → ${a22.vertexCount}, bevel ${bev}, crease ${cre}`);
  const gp = g.clone();
  gp.activePanel = 7; gp.box([2, 2, 2], [40, 118, 5], H);
  const a22p = greedyMeshPart(gp, pal, { voxelScale: 2.5, center: [40, 60, 0], format: 'MEGA_V22' });
  const panels = new Set(); for (let i = 0; i < a22p.vertexCount; i++) panels.add(Math.round(a22p.extra[i * 3 + 2] * 255));
  check('panelId: sub-assembly ids reach the vertices and split greedy merges at plate boundaries', a22p.quads > a22.quads && panels.has(7) && panels.has(0), `quads ${a22.quads} → ${a22p.quads}, panel ids {${[...panels].join(',')}}`);

  // 7c — packMegaAsset MEGA_V22 on the demo carrier vs the MEGA_V2 build of the same carrier
  const mk = () => { const d = buildDemoCarrier(); d.manifest.format = 'MEGA_V22'; return packMegaAsset(d.manifest, d.macroParts, d.mesoPrefabs, d.instances); };
  const p22 = [mk(), mk()];
  const w22 = p22.map((p, i) => writeMegaAsset(path.join(TMP, `v22_${i}`, 'demo_carrier'), p));
  const d2 = buildDemoCarrier(), p2 = packMegaAsset(d2.manifest, d2.macroParts, d2.mesoPrefabs, d2.instances);
  const w2 = writeMegaAsset(path.join(TMP, 'v2ref', 'demo_carrier'), p2);
  const j = p22[0].json;
  check('packMegaAsset MEGA_V22 → schema svox.mega/v2.2, vertexStrideBytes 20, deterministic SHA-256 across 2 builds',
    j.schema === MEGA_V22_SCHEMA && j.vertexStrideBytes === 20 && j.vertexLayout.stride === 20 && j.vertexLayout.vertexFormat === 'packed20' && w22[0].binSha256 === w22[1].binSha256 && w22[0].jsonSha256 === w22[1].jsonSha256,
    `bin ${w22[0].binSha256.slice(0, 16)}…`);
  const vb2 = p2.json.macro.parts.reduce((s, p) => s + p.vertexByteLength, 0) + p2.json.meso.prefabs.reduce((s, p) => s + p.vertexByteLength, 0);
  const vb22 = j.macro.parts.reduce((s, p) => s + p.vertexByteLength, 0) + j.meso.prefabs.reduce((s, p) => s + p.vertexByteLength, 0);
  const nv22 = j.macro.parts.reduce((s, p) => s + p.vertexCount, 0) + j.meso.prefabs.reduce((s, p) => s + p.vertexCount, 0);
  check('v2.2 vertex bytes = 20 × vertices (vs 48 B in v2): 2.4× the geometry per byte', vb22 === nv22 * 20 && vb2 / p2.json.stats.binBytes > 0 && (vb2 / (p2.json.macro.parts.reduce((s, p) => s + p.vertexCount, 0) + p2.json.meso.prefabs.reduce((s, p) => s + p.vertexCount, 0))) === 48,
    `vertex bytes ${(vb2 / 1024).toFixed(0)} KiB → ${(vb22 / 1024).toFixed(0)} KiB · bin ${(p2.json.stats.binBytes / 1024).toFixed(0)} → ${(j.stats.binBytes / 1024).toFixed(0)} KiB`);
  const r22 = readMegaAsset(w22[0].jsonPath), r2 = readMegaAsset(w2.jsonPath);
  const h22 = r22.part('hull'), h2 = r2.part('hull');
  // same quads; compare the quantized positions against the float build through a position-sorted multiset
  const keyset = (verts, cnt) => { const a = []; for (let i = 0; i < cnt; i++) a.push([verts[i * 12], verts[i * 12 + 1], verts[i * 12 + 2]]); a.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]); return a; };
  const A = keyset(h22.verts, h22.meta.vertexCount);
  let pe = 0; const B2 = keyset(h2.verts, h2.meta.vertexCount);
  const near = (p) => { let lo = 0, hi = B2.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (B2[m][0] < p[0] - 0.05) lo = m + 1; else hi = m; } let best = Infinity; for (let k = lo; k < B2.length && B2[k][0] <= p[0] + 0.05; k++) best = Math.min(best, Math.hypot(B2[k][0] - p[0], B2[k][1] - p[1], B2[k][2] - p[2])); return best; };
  for (let i = 0; i < A.length; i += 7) pe = Math.max(pe, near(A[i]));
  check('readMegaAsset decodes v2.2 → MEGA_V2 floats; same triangles as v2, every decoded vertex within 0.03 u of a v2 vertex',
    r22.quantized && r22.floats === 12 && h22.meta.indexCount === h2.meta.indexCount && pe < 0.03 && h22.packed.byteLength === h22.meta.vertexCount * 20 && h22.meta.posHalfExt.length === 3, `max Δ ${pe.toFixed(4)} u`);
  const sv2 = renderPreview(r2, { view: 'hero34', width: 320, height: 200 }).image, sv22 = renderPreview(r22, { view: 'hero34', width: 320, height: 200 }).image;
  const iou = computeSilhouetteIoU(sv2, sv22, { diff: false }).iou;
  check('renderPreview on v2.2 matches the v2 preview (silhouette IoU >= 0.99); static G6 v2.2 budget PASS', iou >= 0.99 && j.budget.staticPass && j.budget.checks.find((c) => c.name === 'binBytes').limit === `<= ${MEGA_V22_BUDGET.maxBinBytes}`, `IoU ${f3(iou)}`);
  let threw = false;
  try { const d = buildDemoCarrier(); const mesh = greedyMeshPart(d.grid, d.palette, {}); packMegaAsset({ ...d.manifest, format: 'MEGA_V22' }, [{ name: 'hull', mesh }]); } catch { threw = true; }
  check('MEGA_V22 pack refuses a pre-meshed MEGA_V2 part (no extras)', threw);
  // 7d — Uint16 indices (≤ 65 535 verts) + seamless region split of one grid into 2 macro parts sharing one AO bake
  const dd = buildDemoCarrier(); dd.manifest.format = 'MEGA_V22';
  const ao = bakeMacroCavityAO(dd.grid, dd.manifest.aoOpts);
  const half = Math.round(dd.grid.ny / 2);
  const split = packMegaAsset(dd.manifest, [
    { name: 'aft', grid: dd.grid, macroAo: ao, region: { min: [0, 0, 0], max: [dd.grid.nx, half, dd.grid.nz] } },
    { name: 'fore', grid: dd.grid, macroAo: ao, region: { min: [0, half, 0], max: [dd.grid.nx, dd.grid.ny, dd.grid.nz] } }], dd.mesoPrefabs, dd.instances);
  const whole = packMegaAsset(dd.manifest, [{ name: 'hull', grid: dd.grid, macroAo: ao }], dd.mesoPrefabs, dd.instances);
  const sp = split.json.macro.parts, wp = whole.json.macro.parts[0];
  const aligned = [...sp, ...split.json.meso.prefabs].every((p) => p.vertexOffset % 4 === 0 && p.indexOffset % 4 === 0 && (p.indexType === 'uint16' ? p.indexByteLength === p.indexCount * 2 : p.indexByteLength === p.indexCount * 4));
  check('v2.2 region split: 2 macro parts = 1 whole part (exposed faces / voxels), Uint16 indices, every block 4-byte aligned',
    sp[0].exposedFaces + sp[1].exposedFaces === wp.exposedFaces && sp[0].voxels + sp[1].voxels === wp.voxels && sp.every((p) => p.indexType === 'uint16') && aligned && split.json.stats.macroDrawCalls === 2,
    `faces ${sp[0].exposedFaces} + ${sp[1].exposedFaces} = ${wp.exposedFaces} · tris ${sp[0].triangles} + ${sp[1].triangles} vs ${wp.triangles} · idx ${sp.map((p) => p.indexType).join('/')}`);
});

// ================================================================================================ 8 G5-v2.2 multi-cue gate
section('8 · G5-v2.2 multi-cue gate (G5-Edge chamfer / F1 + G5-Band accent distribution)', () => {
  // synthetic "concept": dark hull plate with stepped bevel lines, an amber band and a cyan strip, on transparent bg
  const W = 240, H = 120;
  const paint = (opts) => {
    const img = createImage(W, H, [0, 0, 0, 0]);
    const set = (x, y, c) => img.data.set([...c, 255], (y * W + x) * 4);
    for (let y = 20; y < 100; y++) for (let x = 10; x < 230; x++) set(x, y, [70, 76, 88]);
    if (opts.detail) {
      for (const x of [50, 90, 130, 170, 200]) for (let y = 24; y < 96; y++) { set(x, y, [24, 26, 32]); set(x + 1, y, [140, 150, 165]); }   // bulkhead seams
      for (let k = 0; k < 6; k++) for (let x = 20 + k * 6; x < 220 - k * 6; x++) set(x, 34 + k * 5, [k % 2 ? 40 : 150, k % 2 ? 44 : 158, k % 2 ? 52 : 170]);   // stepped glacis lines
    }
    if (opts.amber !== false) for (let y = 60; y < 72; y++) for (let x = 30 + (opts.amberShift || 0); x < 110 + (opts.amberShift || 0); x++) set(x, y, [226, 160, 44]);
    for (let y = 80; y < 86; y++) for (let x = 140; x < 220; x++) set(x, y, [60, 236, 255]);
    return img;
  };
  const ref = paint({ detail: true }), same = paint({ detail: true }), flat = paint({ detail: false });
  const e0 = computeEdgeG5(ref, same), e1 = computeEdgeG5(ref, flat);
  const s1 = computeSilhouetteIoU(ref, flat, { diff: false });
  check('G5-Edge: identical images → F1 1.0 / chamfer 0; deterministic', Math.abs(e0.f1 - 1) < 1e-9 && e0.chamfer < 1e-9 && computeEdgeG5(ref, same).f1 === e0.f1, `F1 ${f3(e0.f1)}, edges ${e0.refEdges}`);
  check('G5-Edge catches a flat "wedding-cake" interior that G5-Silhouette passes (IoU 1.0, F1 < 0.52, chamfer up)',
    s1.iou > 0.999 && e1.f1 < G5_V22_TARGETS.hero.edgeF1 && e1.chamfer > e0.chamfer + 2, `IoU ${f3(s1.iou)} · F1 ${f3(e1.f1)} · chamfer ${e1.chamfer.toFixed(2)} px (recall ${f3(e1.recall)})`);
  const b0 = computeBandG5(ref, same), b1 = computeBandG5(ref, paint({ detail: true, amber: false })), b2 = computeBandG5(ref, paint({ detail: true, amberShift: 80 }));
  check('G5-Band: identical → PASS; missing amber band → FAIL (ratio 0); displaced amber band → centroid FAIL',
    b0.pass && b0.amber.ratio === 1 && b0.cyan.pass && !b1.pass && b1.amber.ratio === 0 && b1.cyan.pass && !b2.amber.pass && b2.amber.centroidDist > G5_V22_TARGETS.band.centroidMax,
    `amber share ${b0.amber.ref} · missing ratio ${b1.amber.ratio} · shifted Δc ${b2.amber.centroidDist}`);
  const mc = computeMultiCueG5(ref, same, { kind: 'hero' }), mf = computeMultiCueG5(ref, flat, { kind: 'hero' });
  const sum = multiCueSummary({ hero: mc, top: computeMultiCueG5(ref, same, { kind: 'ortho' }) });
  const sheetPath = path.join(TMP, 'multicue.png');
  const sheet = composeMultiCueSheet([{ label: 'SAME', ref, render: same, kind: 'hero' }, { label: 'FLAT', ref, render: flat, kind: 'hero' }], sheetPath, { title: 'SELF TEST G5 V2.2' });
  check('computeMultiCueG5 / multiCueSummary / composeMultiCueSheet: detailed PASS, flat FAIL, sheet PNG written',
    mc.pass && !mf.pass && mf.silhouette.pass && !mf.edge.pass && sum.pass && sheet.rows[0].pass && !sheet.rows[1].pass && fs.existsSync(sheetPath) && readPNG(sheetPath).width === sheet.width,
    `${sheet.width}×${sheet.height}`);
  const du = path.join(HERE, 'mega_diff_utils.mjs');
  const rp = path.join(TMP, 'mc_ref.png'), fp = path.join(TMP, 'mc_flat.png');
  writePNG(rp, ref); writePNG(fp, flat);
  const c1 = spawnSync(process.execPath, [du, 'multicue', '--ref', rp, '--render', rp], { encoding: 'utf8' });
  const c2 = spawnSync(process.execPath, [du, 'multicue', '--ref', rp, '--render', fp], { encoding: 'utf8' });
  check('mega_diff_utils multicue CLI: exit 0 on PASS, 1 on a flat interior', c1.status === 0 && c2.status === 1, `${c1.stdout.trim().slice(0, 60)} | ${c2.stdout.trim().slice(0, 60)}`);
});

// ================================================================================================ 9 v2.3 quad16 16 B/quad
section('9 · svox.mega/v2.3 quad16 (16 B/quad instanced quads) + packMegaAsset MEGA_V23 + MEGA_V23_BUDGET', () => {
  // 9a — codec: every field bit-exact at a 16-byte stride, out-of-range fields refused
  let seed = 23; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const ri = (n) => Math.floor(rnd() * n);
  const recs = [];
  for (let i = 0; i < 4096; i++) recs.push({ origin: [ri(65536), ri(65536), ri(65536)], du: 1 + ri(255), dv: 1 + ri(255), dir: i % 6, rgb: [ri(256), ri(256), ri(256)], em: ri(256),
    bevelQ: ri(4), creaseQ: ri(4), diagFlip: ri(2), ao: [ri(4), ri(4), ri(4), ri(4)], macroAo: i % 256, matTag: i % 16, panelId: (i >> 4) % 16 });
  recs[0].origin = [65535, 65535, 65535]; recs[1].du = 255; recs[1].dv = 255; recs[2].origin = [0, 0, 0]; recs[2].du = 1; recs[2].dv = 1;
  const bytes = packQuad16(recs), back = unpackQuad16(bytes);
  const FK = ['du', 'dv', 'em', 'dir', 'bevelQ', 'creaseQ', 'diagFlip', 'macroAo', 'matTag', 'panelId'];
  const eqRec = (a, b) => FK.every((k) => a[k] === b[k]) && [0, 1, 2].every((k) => a.origin[k] === b.origin[k] && a.rgb[k] === b.rgb[k]) && [0, 1, 2, 3].every((k) => a.ao[k] === b.ao[k]);
  const spread = new Set(back.map((q) => q.matTag)).size === 16 && new Set(back.map((q) => q.panelId)).size === 16 && new Set(back.map((q) => q.macroAo)).size === 256 && new Set(back.map((q) => q.dir)).size === 6;
  let refused = 0;
  for (const bad of [{ ...recs[3], du: 0 }, { ...recs[3], origin: [65536, 0, 0] }, { ...recs[3], matTag: 16 }, { ...recs[3], dir: 6 }, { ...recs[3], ao: [4, 0, 0, 0] }]) { try { packQuad16([bad]); } catch { refused++; } }
  check('quad16 codec: exactly 16 B/quad; origin 0..65535, size 1..255, 6 dirs, 4-corner micro AO, 256 macro AO levels, matTag 0..15, panelId 0..15, bevelQ / creaseQ / diagFlip bit-exact; out-of-range refused',
    bytes.byteLength === recs.length * 16 && QUAD16_LAYOUT.quadStrideBytes === 16 && back.length === recs.length && back.every((q, i) => eqRec(q, recs[i])) && spread && refused === 5, `${bytes.byteLength} B / ${recs.length} quads, ${refused}/5 refused`);

  // 9b — decode: exact outward normals for all 6 dirs, CCW-outward winding, split diagonal follows diagFlip
  let normOK = true, windOK = true, diagOK = true, areaOK = true;
  for (let dir = 0; dir < 6; dir++) for (const flip of [0, 1]) {
    const r = { origin: [10, 20, 30], du: 3, dv: 5, dir, rgb: [1, 2, 3], em: 0, bevelQ: 0, creaseQ: 0, diagFlip: flip, ao: [3, 3, 3, 3], macroAo: 255, matTag: 0, panelId: 0 };
    const m = quad16ToMesh([r], 1, [0.5, -1, 2], 2);
    const ax = dir >> 1, sg = dir & 1 ? -1 : 1;
    let area = 0;
    for (let t = 0; t < 6; t += 3) {
      const P = [0, 1, 2].map((k) => [0, 1, 2].map((c) => m.verts[m.idx[t + k] * 12 + c]));
      const e1 = P[1].map((v, c) => v - P[0][c]), e2 = P[2].map((v, c) => v - P[0][c]);
      const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      if (cr[ax] * sg <= 0) windOK = false;
      area += Math.hypot(...cr) / 2;
    }
    for (let k = 0; k < 4; k++) for (let c = 0; c < 3; c++) if (m.verts[k * 12 + 3 + c] !== (c === ax ? sg : 0)) normOK = false;
    if (Math.abs(area - 3 * 5 * 4) > 1e-9) areaOK = false;
    const t1 = new Set([0, 1, 2].map((k) => m.idx[k])), shared = [3, 4, 5].map((k) => m.idx[k]).filter((x) => t1.has(x));
    const cs = shared.map((vi) => quad16Corner(r, vi % 4).join(''));
    if (!(cs.length === 2 && (flip ? ['10', '01'] : ['00', '11']).every((w) => cs.includes(w)))) diagOK = false;
  }
  check('quad16 decode: exact outward normal for all 6 dirs, CCW-outward winding with and without diagFlip, area du·dv·s², diagFlip moves the split diagonal 00–11 → 10–01',
    normOK && windOK && diagOK && areaOK);

  // 9c — mesher parity: greedyQuad16Part ≡ greedyMeshPart(MEGA_V22) triangle for triangle on the demo carrier
  const triMap = (V, E, I) => {
    const m = new Map();
    for (let t = 0; t < I.length; t += 3) {
      const vs = [0, 1, 2].map((k) => {
        const o = I[t + k] * 12, e = I[t + k] * 3;
        return { key: `${[V[o], V[o + 1], V[o + 2]].map((x) => x.toFixed(3)).join(',')}|${V[o + 3]},${V[o + 4]},${V[o + 5]}|${[6, 7, 8, 9].map((c) => Math.round(V[o + c] * 255)).join(',')}|${V[o + 10].toFixed(4)}|${V[o + 11]}|${E[e + 1].toFixed(3)}`,
          p: [V[o], V[o + 1], V[o + 2]], bev: E[e] };
      });
      let r0 = 0; for (let r = 1; r < 3; r++) if (vs[r].key < vs[r0].key) r0 = r;
      const o = [vs[r0], vs[(r0 + 1) % 3], vs[(r0 + 2) % 3]];
      m.set(o.map((x) => x.key).join(';'), o);
    }
    return m;
  };
  const d = buildDemoCarrier(), ao = bakeMacroCavityAO(d.grid, d.manifest.aoOpts);
  const mo = { voxelScale: 4, center: d.manifest.center, macroAo: ao };
  const g22 = greedyMeshPart(d.grid, d.palette, { ...mo, format: 'MEGA_V22' }), q16 = greedyQuad16Part(d.grid, d.palette, mo);
  const qm = quad16ToMesh(q16.bytes, q16.quadCount, q16.gridOrigin, q16.voxelScale);
  const A = triMap(g22.verts, g22.extra, g22.idx), B = triMap(qm.verts, qm.extra, qm.idx);
  let missing = 0, pe = 0, corners = 0, bevSame = 0;
  for (const [k, ta] of A) {
    const tb = B.get(k);
    if (!tb) { missing++; continue; }
    for (let c = 0; c < 3; c++) { corners++; if (Math.abs(ta[c].bev - tb[c].bev) < 1e-6) bevSame++; for (let a = 0; a < 3; a++) pe = Math.max(pe, Math.abs(ta[c].p[a] - tb[c].p[a])); }
  }
  const flips = unpackQuad16(q16.bytes).filter((q) => q.diagFlip).length;
  check('greedyQuad16Part ≡ greedyMeshPart(MEGA_V22) on the demo carrier: same quads, every triangle identical (position 0.0 u, normal, winding, split diagonal, rgb/em bytes, 4-corner micro AO, macro AO, matTag, crease)',
    q16.quadCount === g22.quads && qm.idx.length === g22.indexCount && A.size === B.size && A.size === g22.triangles && missing === 0 && pe === 0 && flips > 0,
    `${q16.quadCount} quads / ${A.size} tris, ${missing} unmatched, max |Δp| ${pe} u, ${flips} diagFlip quads`);
  check('quad16 bevelQ (2-bit quad hint on unoccluded corners) reproduces the v2.2 per-corner bevelHint on >= 75 % of corners (crease exact)',
    bevSame / corners >= 0.75, `${((100 * bevSame) / corners).toFixed(1)} % of ${corners} corners`);

  // 9d — curved organic sphere + torus: 16 B/quad vs the real v2.2 cost, no 65 535 cap, 256-level macro AO, > 255 runs split
  const opal = new MegaPalette();
  const CH = opal.add('chitin', '#6a4a8c', { matTag: 6 }), CD = opal.add('chitin_dark', '#3a2850', { matTag: 6 }), BIO = opal.add('bio', '#a8ff40', { emissive: 0.8, matTag: 8 });
  const og = new VoxelGrid(112, 112, 88);
  og.ellipsoid([56, 56, 44], [40, 48, 34], CH);
  for (let z = 0; z < 88; z++) for (let y = 0; y < 112; y++) for (let x = 0; x < 112; x++) { const rr = Math.hypot(x + 0.5 - 56, y + 0.5 - 56); if (Math.hypot(rr - 44, z + 0.5 - 18) < 8.5) og.set(x, y, z, CD); }
  og.subtract(shapes.ellipsoid([56, 100, 44], [13, 10, 11]));
  og.ellipsoid([56, 92, 44], [15, 6, 13], BIO, { mode: 'paint' });
  const oao = bakeMacroCavityAO(og, { rays: 12, maxDist: 12 });
  const oo = { voxelScale: 2, center: [56, 56, 44], macroAo: oao };
  const o22 = greedyMeshPart(og, opal, { ...oo, format: 'MEGA_V22' }), o16 = greedyQuad16Part(og, opal, oo);
  const i32 = o22.vertexCount > 65535, v22B = o22.vertexCount * 20 + o22.indexCount * (i32 ? 4 : 2), ratio = v22B / o16.bytes.byteLength;
  check('curved organic sphere + torus: quad16 = 16 B × quads exactly (5.75× below the 92 B/quad v2.2 nominal), >= 4.5× below the measured v2.2 vertex + index bytes, ONE part past the 65 535-vertex Uint16 cap',
    o16.bytes.byteLength === o16.quadCount * 16 && o16.quadCount === o22.quads && 92 / 16 === 5.75 && ratio >= 4.5 && i32,
    `${o16.quadCount} quads (greedy ${(o16.reduction * 100).toFixed(1)} %) · quad16 ${(o16.bytes.byteLength / 1024).toFixed(0)} KiB vs v2.2 ${(v22B / 1024).toFixed(0)} KiB (${o22.vertexCount} verts → ${i32 ? 'Uint32' : 'Uint16'}) = ${ratio.toFixed(2)}×`);
  const o256 = greedyQuad16Part(og, opal, { ...oo, macroLevels: 256 });
  const lv8 = new Set(unpackQuad16(o16.bytes).map((q) => q.macroAo)).size, lv256 = new Set(unpackQuad16(o256.bytes).map((q) => q.macroAo)).size;
  const big = new VoxelGrid(600, 4, 4); big.box([0, 0, 0], [600, 4, 4], CH);
  const bq = greedyQuad16Part(big, opal, {}), br = unpackQuad16(bq.bytes);
  const covered = br.reduce((s, q) => s + q.du * q.dv, 0);
  check('256-level smooth macro AO (macroLevels 256 → > 16 cavity levels vs <= 8 at the default); runs > 255 vox split automatically (du, dv <= 255, face area preserved)',
    lv8 <= 8 && lv256 > 16 && o256.quadCount >= o16.quadCount && br.every((q) => q.du <= 255 && q.dv <= 255) && covered === bq.exposedFaces && br.some((q) => q.du === 255 || q.dv === 255),
    `${lv8} → ${lv256} levels (quads ${o16.quadCount} → ${o256.quadCount}) · 600-vox bar: ${bq.quadCount} quads cover ${covered}/${bq.exposedFaces} faces`);

  // 9e — packMegaAsset MEGA_V23 (quad16 macro + packed20 meso) vs the MEGA_V22 build of the same carrier
  const mk23 = () => { const dd = buildDemoCarrier(); dd.manifest.format = 'MEGA_V23'; return packMegaAsset(dd.manifest, dd.macroParts, dd.mesoPrefabs, dd.instances); };
  const p23 = [mk23(), mk23()];
  const w23 = p23.map((p, i) => writeMegaAsset(path.join(TMP, `v23_${i}`, 'demo_carrier'), p));
  const dd2 = buildDemoCarrier(); dd2.manifest.format = 'MEGA_V22';
  const p22 = packMegaAsset(dd2.manifest, dd2.macroParts, dd2.mesoPrefabs, dd2.instances), w22 = writeMegaAsset(path.join(TMP, 'v23_ref22', 'demo_carrier'), p22);
  const j = p23[0].json, hp = j.macro.parts[0], h22 = p22.json.macro.parts[0];
  const offs = [hp.quadOffset, ...j.meso.prefabs.flatMap((p) => [p.vertexOffset, p.indexOffset, p.instanceMatrixOffset, p.instanceColorOffset])];
  check('packMegaAsset MEGA_V23 → svox.mega/v2.3: quad16 macro part (quadStrideBytes 16, no index block) + packed20 prefabs, every block 4-byte aligned, deterministic SHA-256 across 2 builds',
    j.schema === MEGA_V23_SCHEMA && j.quadStrideBytes === 16 && j.vertexStrideBytes === 20 && j.macroFormat === 'quad16' && hp.vertexFormat === 'quad16' && hp.quadByteLength === hp.quadCount * 16 && hp.indexOffset === undefined
      && j.meso.prefabs.every((p) => p.posCenter && p.vertexByteLength === p.vertexCount * 20) && offs.every((o) => o % 4 === 0) && w23[0].binSha256 === w23[1].binSha256 && w23[0].jsonSha256 === w23[1].jsonSha256,
    `bin ${w23[0].binSha256.slice(0, 16)}… · ${(j.stats.binBytes / 1024).toFixed(1)} KiB`);
  const r23 = readMegaAsset(w23[0].jsonPath), r22 = readMegaAsset(w22.jsonPath);
  const pv = ['hero34', 'top', 'side', 'front'].map((v) => computeSilhouetteIoU(renderPreview(r22, { view: v, width: 320, height: 200 }).image, renderPreview(r23, { view: v, width: 320, height: 200 }).image, { diff: false }).iou);
  const m22 = h22.vertexByteLength + h22.indexByteLength;
  check('readMegaAsset + renderPreview on v2.3 match the v2.2 build (IoU >= 0.99 hero / top / side / front); same quads, macro bytes ÷ >= 4',
    r23.quad16 && r23.part('hull').quads.byteLength === hp.quadCount * 16 && hp.quads === h22.quads && pv.every((v) => v >= 0.99) && m22 / hp.quadByteLength >= 4,
    `IoU ${pv.map(f3).join(' / ')} · macro ${(m22 / 1024).toFixed(1)} KiB → ${(hp.quadByteLength / 1024).toFixed(1)} KiB (${(m22 / hp.quadByteLength).toFixed(2)}×)`);
  const B23 = MEGA_V23_BUDGET;
  const over = checkPerfBudget({ ...j.stats, binBytes: 13 * 1048576 }, B23), overD = checkPerfBudget({ ...j.stats, drawCalls: 17 }, B23), run = checkPerfBudget(j.stats, B23, { earlyZAlive: true, gpuDeltaMs: 2.4 });
  check('MEGA_V23_BUDGET 12 MiB / 16 draws / 1.2 M tris / Δ 2.5 ms: demo static PASS, 13 MiB or 17 draws FAIL, runtime Δ 2.4 ms PASS',
    B23.maxBinBytes === 12 * 1048576 && B23.maxDrawCalls === 16 && B23.maxTriangles === 1200000 && B23.maxRuntimeDeltaMs === 2.5 && j.budget.staticPass && j.budget.checks.find((c) => c.name === 'binBytes').limit === `<= ${12 * 1048576}`
      && !over.staticPass && !overD.staticPass && run.pass);
  // region split + wave / rotate kinds carried into the v2.3 part JSON
  const dd3 = buildDemoCarrier(); dd3.manifest.format = 'MEGA_V23';
  const ao3 = bakeMacroCavityAO(dd3.grid, dd3.manifest.aoOpts), half = Math.round(dd3.grid.ny / 2);
  const sp23 = packMegaAsset(dd3.manifest, [
    { name: 'aft', grid: dd3.grid, macroAo: ao3, region: { min: [0, 0, 0], max: [dd3.grid.nx, half, dd3.grid.nz] } },
    { name: 'fore', kind: 'wave', grid: dd3.grid, macroAo: ao3, region: { min: [0, half, 0], max: [dd3.grid.nx, dd3.grid.ny, dd3.grid.nz] }, waveAmp: 12, waveFreq: 0.0209, waveOriginY: 160, anim: { axis: 'z' } }], dd3.mesoPrefabs, dd3.instances);
  const sq = sp23.json.macro.parts;
  check('v2.3 region split: 2 quad16 parts = 1 whole part (faces / voxels / quads); wave part keeps kind + waveAmp / waveFreq / waveOriginY + anim; macroDrawCalls 2',
    sq[0].exposedFaces + sq[1].exposedFaces === hp.exposedFaces && sq[0].voxels + sq[1].voxels === hp.voxels && sq[0].quads + sq[1].quads >= hp.quads && sq[1].kind === 'wave' && sq[1].waveAmp === 12 && sq[1].waveOriginY === 160 && sq[1].anim && sp23.json.stats.macroDrawCalls === 2,
    `faces ${sq[0].exposedFaces} + ${sq[1].exposedFaces} = ${hp.exposedFaces} · quads ${sq[0].quads} + ${sq[1].quads} vs ${hp.quads}`);
  // CLI demo --v23 (faction material swatches 6 / 7 / 8)
  const kit = path.join(HERE, 'mega_voxel_kit.mjs'), out = path.join(TMP, 'cli23');
  const cl = spawnSync(process.execPath, [kit, 'demo', '--v23', '--out', out, '--name', 'qa_quad16'], { encoding: 'utf8' });
  const cj = cl.status === 0 ? JSON.parse(fs.readFileSync(path.join(out, 'qa_quad16.json'), 'utf8')) : null;
  const tags = cj ? new Set(cj.palette.map((p) => p.matTag)) : new Set();
  const ins = spawnSync(process.execPath, [kit, 'inspect', '--asset', path.join(out, 'qa_quad16.json')], { encoding: 'utf8' });
  check('CLI demo --v23 --name: svox.mega/v2.3 asset with matTag 6 / 7 / 8 swatches, static budget PASS; inspect reads it', cl.status === 0 && cj.schema === MEGA_V23_SCHEMA && cj.id === 'qa_quad16' && [6, 7, 8].every((t) => tags.has(t)) && cj.budget.staticPass && ins.status === 0 && /16 B\/quad/.test(ins.stdout),
    cl.status ? cl.stderr.trim() : cl.stdout.split('\n')[0]);
});

// ================================================================================================ 10 G5-v2.3 hull-only silhouette
section('10 · G5-v2.3 hull-only silhouette IoU (organic / tentacled megastructures)', () => {
  const W = 400, H = 300;
  const fillEll = (img, cx, cy, rx, ry, c) => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1) img.data.set(c, (y * W + x) * 4); };
  const stroke = (img, pts, r, c) => {
    for (let i = 0; i + 1 < pts.length; i++) for (let t = 0; t <= 1; t += 0.02) {
      const px = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, py = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
      for (let y = Math.floor(py - r); y <= Math.ceil(py + r); y++) for (let x = Math.floor(px - r); x <= Math.ceil(px + r); x++) if (x >= 0 && y >= 0 && x < W && y < H && (x + 0.5 - px) ** 2 + (y + 0.5 - py) ** 2 <= r * r) img.data.set(c, (y * W + x) * 4);
    }
  };
  // carapace dome (ellipse) + jaw (notched lower ellipse) + 4 thin tentacles whose curl differs between concept and render
  const ship = ({ domeRy = 62, tent = 'hang', tentacles = true } = {}) => {
    const img = createImage(W, H, [0, 0, 0, 0]), C = [120, 80, 160, 255];
    fillEll(img, 200, 120, 110, domeRy, C); fillEll(img, 200, 160, 70, 28, C);
    if (tentacles) for (const x0 of [150, 180, 220, 250]) {
      const pts = [];
      for (let k = 0; k <= 12; k++) { const t = k / 12; pts.push(tent === 'hang' ? [x0 + 10 * Math.sin(t * 5), 175 + t * 115] : [x0 + (x0 < 200 ? -1 : 1) * 130 * t, 175 + 50 * Math.sin(t * 3.1)]); }
      stroke(img, pts, 1.6, C);
    }
    return img;
  };
  const ref = ship({ tent: 'hang' }), curled = ship({ tent: 'curl' }), flat = ship({ tent: 'curl', domeRy: 40 });
  const full = computeSilhouetteIoU(ref, curled, { diff: false }).iou;
  const h1 = computeHullSilhouetteIoU(ref, curled), h2 = computeHullSilhouetteIoU(ref, flat);
  const ex = computeHullSilhouetteIoU(ref, curled, { refHull: ship({ tentacles: false }), renderHull: ship({ tent: 'curl', tentacles: false }) });
  check('hull-only IoU locks the carapace dome + jaw regardless of tentacle curl (auto opening: hull >= 0.86 while the full silhouette IoU < 0.86)',
    h1.pass && h1.iou >= G5_V23_TARGETS.hull.iou && full < G5_V23_TARGETS.hull.iou && h1.method === 'open' && Math.abs(h1.full - full) < 1e-9, `full ${f3(full)} → hull ${f3(h1.iou)} (open ${h1.openRadius} px)`);
  check('hull-only IoU still catches a flattened dome (< 0.86); explicit hull-only masks (wave part excluded) give ~1.0',
    !h2.pass && h2.iou < G5_V23_TARGETS.hull.iou && ex.method === 'explicit' && ex.iou >= 0.98, `flattened ${f3(h2.iou)} · explicit ${f3(ex.iou)}`);
  const du = path.join(HERE, 'mega_diff_utils.mjs'), rp = path.join(TMP, 'hull_ref.png'), cp = path.join(TMP, 'hull_curl.png'), fp = path.join(TMP, 'hull_flat.png');
  writePNG(rp, ref); writePNG(cp, curled); writePNG(fp, flat);
  const c1 = spawnSync(process.execPath, [du, 'hull', '--ref', rp, '--render', cp], { encoding: 'utf8' }), c2 = spawnSync(process.execPath, [du, 'hull', '--ref', rp, '--render', fp, '--diff', path.join(TMP, 'hull_diff.png')], { encoding: 'utf8' });
  check('mega_diff_utils hull CLI: exit 0 on a curled-tentacle render, 1 on a flattened dome; diff PNG written', c1.status === 0 && c2.status === 1 && fs.existsSync(path.join(TMP, 'hull_diff.png')), `${c1.stdout.trim()} | ${c2.stdout.trim().slice(0, 50)}`);
});

// ================================================================================================ 11 project-neutral abstractions
section('11 · Project-neutral abstractions (accent bands, generic archetype + assetId, material profiles, legacy aliases)', () => {
  const du = path.join(HERE, 'mega_diff_utils.mjs'), kit = path.join(HERE, 'mega_voxel_kit.mjs');
  const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  // --- 11.1 default bands unchanged: explicit DEFAULT_ACCENT_BANDS === omitted opts.bands, amber / cyan keys intact
  const W = 240, H = 120;
  const plate = (stripes) => {
    const img = createImage(W, H, [0, 0, 0, 0]);
    const set = (x, y, c) => img.data.set([...c, 255], (y * W + x) * 4);
    for (let y = 20; y < 100; y++) for (let x = 10; x < 230; x++) set(x, y, [70, 76, 88]);
    for (const st of stripes) for (let y = st.y; y < st.y + st.h; y++) for (let x = st.x; x < st.x + st.w; x++) set(x, y, st.c);
    return img;
  };
  const amberCyan = plate([{ x: 30, y: 60, w: 80, h: 12, c: [226, 160, 44] }, { x: 140, y: 80, w: 80, h: 6, c: [60, 236, 255] }]);
  const d0 = computeBandG5(amberCyan, amberCyan), d1 = computeBandG5(amberCyan, amberCyan, { bands: DEFAULT_ACCENT_BANDS });
  const strip = (b) => JSON.stringify({ amber: b.amber, cyan: b.cyan, pass: b.pass });
  const classOK = accentClass(226, 160, 44) === 'amber' && accentClass(60, 236, 255) === 'cyan' && accentClass(70, 76, 88) === null && accentClass(200, 30, 40) === null;
  check('DEFAULT_ACCENT_BANDS = the original amber [20, 54] + cyan [165, 205] gate: omitted and explicit default bands give identical amber / cyan results',
    classOK && strip(d0) === strip(d1) && d0.pass && d0.bands.map((b) => b.name).join() === 'amber,cyan' && DEFAULT_ACCENT_BANDS[0].hue.join() === '20,54' && DEFAULT_ACCENT_BANDS[1].minV === 0.42,
    `amber share ${d0.amber.ref} · cyan share ${d0.cyan.ref}`);
  // --- 11.2 custom bands: crimson wraps through 0° ([340, 20]), emerald [100, 150]
  const bands = [{ name: 'crimson', hue: [340, 20], minS: 0.45, minV: 0.3 }, { name: 'emerald', hue: [100, 150], minS: 0.4, minV: 0.3, rgb: [40, 220, 120] }];
  const nb = normalizeAccentBands(bands);
  const wrapOK = accentClass(220, 30, 70, nb) === 'crimson' && accentClass(220, 60, 30, nb) === 'crimson' && accentClass(220, 150, 30, nb) === null && accentClass(40, 200, 90, nb) === 'emerald';
  const cRef = plate([{ x: 30, y: 30, w: 50, h: 10, c: [220, 30, 70] }, { x: 90, y: 30, w: 40, h: 10, c: [220, 60, 30] }, { x: 140, y: 70, w: 70, h: 10, c: [40, 200, 90] }]);
  const cNoCrimson = plate([{ x: 140, y: 70, w: 70, h: 10, c: [40, 200, 90] }]);
  const c0 = computeBandG5(cRef, cRef, { bands }), c1 = computeBandG5(cRef, cNoCrimson, { bands });
  check('custom bands: wrap-around crimson [340, 20] matches hue 345° and 9° but not 38°; emerald [100, 150]; per-band stats keyed by name (no amber / cyan keys)',
    wrapOK && c0.pass && c0.crimson.ratio === 1 && c0.emerald.ratio === 1 && c0.crimson.ref > 0.04 && !('amber' in c0) && !('cyan' in c0) && c0.bands[0].hue.join() === '340,20',
    `crimson share ${c0.crimson.ref} · emerald share ${c0.emerald.ref}`);
  check('custom bands: a render missing the crimson accents FAILS on crimson (ratio 0) while emerald still passes',
    !c1.pass && !c1.crimson.pass && c1.crimson.ratio === 0 && c1.emerald.pass, `crimson ratio ${c1.crimson.ratio} · emerald ratio ${c1.emerald.ratio}`);
  let badBand = 0;
  for (const b of [[{ name: 'pass', hue: [0, 10] }], [{ name: 'x', hue: [0] }], [{ name: 'a', hue: [0, 10] }, { name: 'a', hue: [20, 30] }], [{ name: 'y', hue: [0, 10], minS: 2 }]]) { try { normalizeAccentBands(b); } catch { badBand++; } }
  const parsed = parseAccentBands('crimson:340-20:0.45:0.30,gold:35-58:0.45:0.35:#ffcc33,emerald:100-150');
  check('parseAccentBands CLI spec (name:minH-maxH[:minS[:minV[:#rgb]]]) + invalid descriptors rejected (reserved / duplicate name, bad hue, minS > 1)',
    badBand === 4 && parsed.length === 3 && parsed[0].hue.join() === '340,20' && parsed[0].minV === 0.3 && parsed[1].rgb.join() === '255,204,51' && parsed[2].minS === 0.4,
    parsed.map((b) => `${b.name}[${b.hue.join('-')}]`).join(' '));
  const sheetPath = path.join(TMP, 'multicue_custom_bands.png');
  const sheet = composeMultiCueSheet([{ label: 'SAME', ref: cRef, render: cRef }, { label: 'NO CRIMSON', ref: cRef, render: cNoCrimson }], sheetPath, { title: 'CUSTOM BANDS', bands });
  const rp = path.join(TMP, 'band_ref.png'), np = path.join(TMP, 'band_nocrimson.png');
  writePNG(rp, cRef); writePNG(np, cNoCrimson);
  const spec = 'crimson:340-20:0.45:0.30,emerald:100-150:0.4:0.3';
  const k1 = run(du, ['multicue', '--ref', rp, '--render', rp, '--bands', spec, '--out', path.join(TMP, 'mc_cli_bands.png')]);
  const k2 = run(du, ['multicue', '--ref', rp, '--render', np, '--bands', spec]);
  check('composeMultiCueSheet + multicue CLI --bands: rows keyed by band name, crimson-less render FAILs (exit 1), sheet PNGs written',
    Object.keys(sheet.rows[0].band).join() === 'crimson,emerald' && sheet.rows[1].band.crimson.pass === false && fs.existsSync(sheetPath)
      && k1.status === 0 && k2.status === 1 && /crimson ok emerald ok/.test(k1.stdout) && /crimson FAIL/.test(k2.stdout) && fs.existsSync(path.join(TMP, 'mc_cli_bands.png')),
    `${k1.stdout.trim().slice(-60)} | exit ${k2.status}`);
  // --- 11.3 generic archetype + assetId (shipId stays a valid alias)
  const gen = scaffoldDetailZones('generic_megastructure', { hullSize: [400, 600, 300], assetId: 'fortress_01' });
  const vg = validateDetailZones(gen, { hullBounds: { min: [-200, -300, -150], max: [200, 300, 150] } });
  const legacy = validateDetailZones(scaffoldDetailZones('hard_surface_carrier', { hullSize: [300, 1000, 200], shipId: 'carrier_01' }));
  const both = validateDetailZones({ ...gen, shipId: 'other_id' });
  const ids = gen.zones.map((z) => z.zoneId);
  check('generic_megastructure archetype (exterior_focal / occluded_cavity / hero_accent / under_structure) scaffolds with assetId and validates with 0 errors / 0 warnings',
    ARCHETYPES.generic_megastructure === DETAIL_ZONE_ARCHETYPES.generic_megastructure && ['exterior_focal', 'occluded_cavity', 'hero_accent', 'under_structure'].every((z) => ids.includes(z))
      && gen.assetId === 'fortress_01' && !('shipId' in gen) && gen.zones[0].calloutImage.startsWith('callouts/fortress_01_') && vg.ok && vg.errors.length === 0 && vg.warnings.length === 0 && vg.assetId === 'fortress_01',
    `${ids.join(', ')} · ${vg.warnings.length} warnings`);
  const zf = path.join(TMP, 'generic_zones.json');
  const zt = run(kit, ['zones-template', '--archetype', 'generic_megastructure', '--asset', 'tower_a', '--hull-size', '200,200,600', '--out', zf]);
  const zv = run(kit, ['validate-zones', '--zones', zf, '--hull-size', '200,200,600']);
  check('shipId alias: an old shipId-only doc validates with 0 errors / 0 warnings (assetId resolves to it); a differing assetId + shipId only warns; CLI --asset round-trips',
    legacy.ok && legacy.errors.length === 0 && legacy.warnings.length === 0 && legacy.assetId === 'carrier_01' && both.ok && both.warnings.length === 1 && both.assetId === 'fortress_01'
      && zt.status === 0 && zv.status === 0 && JSON.parse(fs.readFileSync(zf, 'utf8')).assetId === 'tower_a' && /0 errors, 0 warnings/.test(zv.stdout),
    zv.stdout.trim().split('\n').pop());
  // --- 11.4 material profiles: matTag 0..15 is a channel; presets document legends; no faction needed
  const presetsOK = ['hard_surface', 'ornate_stone', 'organic_bio'].every((k) => MATERIAL_PRESETS[k] && Object.isFrozen(MATERIAL_PRESETS[k])
    && Object.keys(MATERIAL_PRESETS[k].tags).every((t) => Number(t) >= 0 && Number(t) <= 15)) && MATERIAL_PRESETS.hard_surface.uniforms.uHangarBounce === 1
    && MATERIAL_PRESETS.organic_bio.uniforms.uHangarBounce === 0 && MATERIAL_PRESETS.ornate_stone.tags[7] && MATERIAL_PRESETS.organic_bio.tags[8];
  const dd = buildDemoCarrier();
  const base = packMegaAsset(dd.manifest, dd.macroParts, dd.mesoPrefabs, dd.instances);
  const { faction, ...noFaction } = dd.manifest;
  const withProf = packMegaAsset({ ...noFaction, materialProfile: 'organic_bio', styleTag: 'bio' }, dd.macroParts, dd.mesoPrefabs, dd.instances);
  const custom = packMegaAsset({ ...noFaction, materialProfile: { id: 'castle', tags: { 1: 'granite blocks', 9: 'stained glass' } } }, dd.macroParts, dd.mesoPrefabs, dd.instances);
  let badTag = false; try { resolveMaterialProfile({ id: 'x', tags: { 16: 'out of range' } }); } catch { badTag = true; }
  check('MATERIAL_PRESETS (hard_surface / ornate_stone / organic_bio, tags within 0..15) + packMegaAsset materialProfile with NO faction: same .bin, profile in JSON, faction null',
    presetsOK && faction === 'demo' && withProf.json.faction === null && withProf.json.materialProfile.id === 'organic_bio' && withProf.json.materialProfile.index === 2 && withProf.json.styleTag === 'bio'
      && sha(withProf.bin) === sha(base.bin) && !('materialProfile' in base.json) && base.json.faction === 'demo'
      && custom.json.materialProfile.index === 3 && custom.json.materialProfile.tags[9] === 'stained glass' && badTag,
    `profile ${withProf.json.materialProfile.id}#${withProf.json.materialProfile.index} · custom ${custom.json.materialProfile.id}#${custom.json.materialProfile.index}`);
  // --- 11.5 backwards-compatible aliases: legacy 11-float token, CLI short forms
  const f11 = packMegaAsset({ ...dd.manifest, format: 'FLOAT11' }, dd.macroParts, dd.mesoPrefabs, dd.instances);
  const old11 = packMegaAsset({ ...dd.manifest, format: V12_LAYOUT.name }, dd.macroParts, dd.mesoPrefabs, dd.instances);
  const o1 = path.join(TMP, 'alias_a'), o2 = path.join(TMP, 'alias_b');
  const s1 = run(kit, ['demo', '--format', 'MEGA_V23', '--asset-only', '--out', o1]), s2 = run(kit, ['demo', '--v23', '--asset-only', '--out', o2]);
  const binSame = s1.status === 0 && s2.status === 0 && sha(fs.readFileSync(path.join(o1, 'demo_carrier.bin'))) === sha(fs.readFileSync(path.join(o2, 'demo_carrier.bin')));
  check('aliases: FLOAT11 == the legacy 11-float format token (identical .bin, layout name differs only); demo --format MEGA_V23 == the --v23 short form',
    sha(f11.bin) === sha(old11.bin) && f11.json.vertexLayout.name === 'FLOAT11' && f11.json.vertexLayout.floats === 11 && old11.json.vertexLayout.name === V12_LAYOUT.name && binSame,
    `FLOAT11 ${(f11.bin.length / 1024).toFixed(1)} KiB · v2.3 demo ${binSame ? 'identical' : 'DIFFERENT'}`);
});

// ================================================================================================ cleanup + summary
if (!KEEP) fs.rmSync(TMP, { recursive: true, force: true });
check(KEEP ? `temp dir kept: ${TMP}` : 'temp dir removed', KEEP || !fs.existsSync(TMP));
console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}: ${pass}/${pass + fail} checks · ${((Date.now() - t0) / 1000).toFixed(1)} s · node ${process.version}`);
process.exitCode = fail ? 1 : 0;
