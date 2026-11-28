#!/usr/bin/env node
// test_mesh_harness.mjs — self-test for Track B Mode B2 (scripts/mesh_source.mjs + scripts/mesh_to_voxel.mjs).
// Zero external API calls ($0.00): every network path is disabled (MESH_SOURCE_FORBID_NETWORK=1 + a throwing fetch stub),
// TRIPO_API_KEY is removed and the home directory is pointed at a temp folder so no real ~/.env is ever read.
// A valid binary .glb is built in memory (PNG base-colour texture, vertex colours, emissive material, node transforms,
// multi-region geometry). Temp files live only in os.tmpdir() and are removed in `finally`.
//
//   node scripts/test_mesh_harness.mjs            → exit 0 when every check passes

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MS_CLI = path.join(HERE, 'mesh_source.mjs'), MV_CLI = path.join(HERE, 'mesh_to_voxel.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hvs-mesh-test-'));
const FAKE_HOME = path.join(TMP, 'home');
fs.mkdirSync(FAKE_HOME, { recursive: true });
// isolate secrets BEFORE the modules load: no real key, no real ~/.env, no network
delete process.env.TRIPO_API_KEY;
process.env.MESH_SOURCE_FORBID_NETWORK = '1';
process.env.USERPROFILE = FAKE_HOME; process.env.HOME = FAKE_HOME;
let fetchCalls = 0;
globalThis.fetch = async (url) => { fetchCalls++; throw new Error(`test: network call attempted (${String(url).split('?')[0]})`); };

const ms = await import(pathToFileURL(MS_CLI).href);
const mv = await import(pathToFileURL(MV_CLI).href);
const kit = await import(pathToFileURL(path.join(HERE, 'mega_voxel_kit.mjs')).href);
const dif = await import(pathToFileURL(path.join(HERE, 'mega_diff_utils.mjs')).href);

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const childEnv = () => ({ ...process.env, TRIPO_API_KEY: '', USERPROFILE: FAKE_HOME, HOME: FAKE_HOME, MESH_SOURCE_FORBID_NETWORK: '1' });
const run = (script, args) => { const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: childEnv(), timeout: 300000 }); return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' }; };

// =============================================================================================== synthetic GLB builder
/** box with per-face vertices (so every face carries a full 0..1 UV square) */
function box(min, max) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const faces = [
    [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]],
    [[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]],
  ];
  const pos = [], uv = [], idx = [];
  faces.forEach((f, i) => { f.forEach((p) => pos.push(...p)); uv.push(0, 1, 1, 1, 1, 0, 0, 0); idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3); });
  return { pos, uv, idx };
}
/** prims: [{ geom, material, color?: [r,g,b], node }] · nodes: [{ name, translation?, rotation?, children?, meshPrims? }] */
function buildGlb({ prims, materials, images = [], nodes }) {
  const chunks = []; let off = 0;
  const bufferViews = [], accessors = [];
  const pushView = (buf) => { const pad = (4 - (buf.length % 4)) % 4; chunks.push(buf, Buffer.alloc(pad)); bufferViews.push({ buffer: 0, byteOffset: off, byteLength: buf.length }); off += buf.length + pad; return bufferViews.length - 1; };
  const acc = (arr, type, ct, extra = {}) => {
    const T = ct === 5126 ? Float32Array : ct === 5125 ? Uint32Array : ct === 5121 ? Uint8Array : Uint16Array;
    const view = pushView(Buffer.from(new T(arr).buffer));
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type];
    const a = { bufferView: view, componentType: ct, count: arr.length / n, type, ...extra };
    if (type === 'VEC3' && ct === 5126 && !extra.noMinMax) { const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < arr.length; i += 3) for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], arr[i + c]); mx[c] = Math.max(mx[c], arr[i + c]); } a.min = mn; a.max = mx; }
    delete a.noMinMax;
    accessors.push(a); return accessors.length - 1;
  };
  const meshes = prims.map((p) => {
    const attributes = { POSITION: acc(p.geom.pos, 'VEC3', 5126), TEXCOORD_0: acc(p.geom.uv, 'VEC2', 5126) };
    if (p.color) { const c = []; for (let i = 0; i < p.geom.pos.length / 3; i++) c.push(Math.round(p.color[0] * 255), Math.round(p.color[1] * 255), Math.round(p.color[2] * 255), 255); attributes.COLOR_0 = acc(c, 'VEC4', 5121, { normalized: true }); }
    return { name: p.name, primitives: [{ attributes, indices: acc(p.geom.idx, 'SCALAR', 5125), material: p.material }] };
  });
  const imgs = images.map((png, i) => ({ bufferView: pushView(png), mimeType: 'image/png', name: `tex${i}` }));
  const bin = Buffer.concat(chunks);
  const json = { asset: { version: '2.0', generator: 'hvs synthetic test' }, scene: 0, scenes: [{ nodes: nodes.roots }], nodes: nodes.list, meshes, materials,
    ...(imgs.length ? { images: imgs, textures: imgs.map((_, i) => ({ source: i })), samplers: [{}] } : {}), buffers: [{ byteLength: bin.length }], bufferViews, accessors };
  let js = Buffer.from(JSON.stringify(json), 'utf8'); js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(js.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, js, bh, bin]);
}
function syntheticGlb(variant = 0) {
  // 8x8 PNG: top half red, bottom half blue (glTF UV v = 0 is the image top)
  const tex = dif.createImage(8, 8, [0, 0, 0, 255]);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const o = (y * 8 + x) * 4; const red = y < 4; tex.data[o] = red ? 208 : 32; tex.data[o + 1] = red ? 48 : 64; tex.data[o + 2] = red ? 32 : 192; }
  const png = dif.encodePNG(tex);
  const prims = [
    { name: 'hull', geom: box([-20, -30, -10], [20, 30, 10]), material: 0 },                                   // textured, hollow → solidify
    { name: 'arm', geom: box([-4, -15, -4], [4, 15, 4]), material: 1, color: [0.62, 0.66, 0.70] },             // vertex colours, child node
    { name: 'glow', geom: box([-5, -5, 10], [5, 5, 14 + variant]), material: 2 },                              // emissiveFactor
    { name: 'fin', geom: box([20, 0, -3], [27, 9, 3]), material: 1, color: [0.95, 0.80, 0.10] },               // +X only (symmetrize)
  ];
  const materials = [
    { name: 'painted', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, baseColorFactor: [1, 1, 1, 1] } },
    { name: 'vcol', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } },
    { name: 'glow', pbrMetallicRoughness: { baseColorFactor: [0.3, 1, 0.2, 1] }, emissiveFactor: [0.3, 1, 0.2] },
  ];
  const nodes = { roots: [0], list: [
    { name: 'root', children: [1, 2, 3, 4] },
    { name: 'hullNode', mesh: 0 },
    { name: 'armNode', mesh: 1, translation: [0, -45, 0] },                                                  // node transform: arm spans y −60..−30
    { name: 'glowNode', mesh: 2 },
    { name: 'finNode', mesh: 3 },
  ] };
  return buildGlb({ prims, materials, images: [png], nodes });
}

try {
  const glbFile = path.join(TMP, 'synthetic.glb');
  fs.writeFileSync(glbFile, syntheticGlb(0));
  const conceptPng = path.join(TMP, 'concept.png');
  dif.writePNG(conceptPng, dif.createImage(4, 4, [10, 200, 220, 255]));

  // =========================================================================================== 1. mesh_source.mjs
  console.log('\n== mesh_source.mjs ==');
  {
    const r = run(MS_CLI, ['list-providers', '--json']);
    let rows = []; try { rows = JSON.parse(r.stdout); } catch { /* fails below */ }
    const ids = rows.map((x) => x.id), tr = rows.find((x) => x.id === 'tripo');
    check('list-providers: local / command / manual / tripo listed, offline vs online classified, tripo key reported missing (no secret value)',
      r.status === 0 && ['local', 'command', 'manual', 'tripo'].every((i) => ids.includes(i)) && rows.find((x) => x.id === 'local').offline && tr && !tr.offline && !tr.ready && tr.secrets[0].configured === false,
      `${ids.join(',')} · tripo ready=${tr && tr.ready}`);
  }
  {
    const out = path.join(TMP, 'ms_local');
    const r1 = run(MS_CLI, ['acquire', '--provider', 'local', '--glb', glbFile, '--out', out]);
    const m1 = JSON.parse(fs.readFileSync(path.join(out, 'mesh_source.json'), 'utf8'));
    const cached = path.join(out, m1.file);
    const r2 = run(MS_CLI, ['acquire', '--provider', 'local', '--glb', glbFile, '--out', out]);
    const m2 = JSON.parse(fs.readFileSync(path.join(out, 'mesh_source.json'), 'utf8'));
    check('local: validates + copies into cache/<sha256>.glb, manifest sha256 == file, second run is a cache hit',
      r1.status === 0 && m1.status === 'ready' && m1.schema === 'svox.mesh_source/v1' && m1.sha256 === sha(glbFile) && sha(cached) === sha(glbFile) && m1.cached === false && r2.status === 0 && m2.cached === true && m2.file === m1.file,
      `${m1.file} · ${m1.bytes} B · cached ${m2.cached}`);
    const bad = path.join(TMP, 'not_a_model.glb'); fs.writeFileSync(bad, 'hello');
    const r3 = run(MS_CLI, ['acquire', '--provider', 'local', '--glb', bad, '--out', path.join(TMP, 'ms_bad')]);
    const trunc = path.join(TMP, 'truncated.glb'); fs.writeFileSync(trunc, fs.readFileSync(glbFile).subarray(0, 200));
    const r4 = run(MS_CLI, ['check-provider', '--provider', 'local', '--glb', trunc]);
    check('local: rejects a non-glTF file (exit 1) and flags a truncated GLB in check-provider (exit 3)', r3.status === 1 && /neither a GLB|not glTF/i.test(r3.out) && r4.status === 3 && /truncated|length/i.test(r4.out), `exit ${r3.status} / ${r4.status}`);
    // programmatic .gltf (external .bin) → cache keeps its resources
    const gdir = path.join(TMP, 'gltf_model'); fs.mkdirSync(gdir);
    const g = fs.readFileSync(glbFile), jl = g.readUInt32LE(12), json = JSON.parse(g.subarray(20, 20 + jl).toString()), binStart = 20 + jl + 8;
    json.buffers = [{ byteLength: g.length - binStart, uri: 'model.bin' }];
    fs.writeFileSync(path.join(gdir, 'model.bin'), g.subarray(binStart)); fs.writeFileSync(path.join(gdir, 'model.gltf'), JSON.stringify(json));
    const m5 = await ms.acquireMesh({ provider: 'local', glb: path.join(gdir, 'model.gltf'), out: path.join(TMP, 'ms_gltf'), log: false });
    const loaded = mv.loadGlbMesh(path.join(TMP, 'ms_gltf', m5.file));
    check('local: .gltf with an external .bin is validated, cached with its resources, and loads in the voxelizer', m5.format === 'gltf' && m5.model.resources.includes('model.bin') && loaded.triangles === 48, `${m5.file} · ${loaded.triangles} tris`);
  }
  {
    // command provider: a synthetic generator script ({image} → {out})
    const gen = path.join(TMP, 'fake_generator.mjs'), logf = path.join(TMP, 'gen_calls.json');
    fs.writeFileSync(gen, `import fs from 'node:fs';\nconst a = process.argv.slice(2); const get = (k) => a[a.indexOf(k) + 1];\n` +
      `const calls = fs.existsSync(${JSON.stringify(logf)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(logf)}, 'utf8')) : [];\n` +
      `calls.push({ image: get('--in'), prompt: get('--prompt') }); fs.writeFileSync(${JSON.stringify(logf)}, JSON.stringify(calls));\n` +
      `if (get('--fail') === '1') { console.error('synthetic failure'); process.exit(7); }\nfs.copyFileSync(${JSON.stringify(glbFile)}, get('--out'));\n`);
    const out = path.join(TMP, 'ms_cmd');
    const tpl = `"${process.execPath}" "${gen}" --in {image} --prompt {prompt} --out {out}`;
    const prompt = 'ornate ring; rm -rf / && echo pwned';
    const r1 = run(MS_CLI, ['acquire', '--provider', 'command', '--cmd', tpl, '--image', conceptPng, '--prompt', prompt, '--out', out]);
    const calls1 = JSON.parse(fs.readFileSync(logf, 'utf8'));
    const m1 = JSON.parse(fs.readFileSync(path.join(out, 'mesh_source.json'), 'utf8'));
    const r2 = run(MS_CLI, ['acquire', '--provider', 'command', '--cmd', tpl, '--image', conceptPng, '--prompt', prompt, '--out', out]);
    const calls2 = JSON.parse(fs.readFileSync(logf, 'utf8'));
    check('command: {image}/{prompt}/{out} substituted as single argv tokens (no shell), output validated + cached, re-run = cache hit (tool not re-run)',
      r1.status === 0 && m1.status === 'ready' && calls1.length === 1 && calls1[0].image === path.resolve(conceptPng) && calls1[0].prompt === prompt && m1.sha256 === sha(glbFile) && r2.status === 0 && calls2.length === 1 && /"cached":true/.test(r2.out),
      `calls ${calls2.length} · image token ${calls1[0] && calls1[0].image === path.resolve(conceptPng)}`);
    const r3 = run(MS_CLI, ['acquire', '--provider', 'command', '--cmd', `${tpl} --fail 1`, '--image', conceptPng, '--prompt', 'x', '--out', path.join(TMP, 'ms_cmd_fail')]);
    const failCache = path.join(TMP, 'ms_cmd_fail', 'cache');
    check('command: non-zero exit → acquire fails (exit 1) with the tool message and leaves no cache entry', r3.status === 1 && /exited 7/.test(r3.out) && (!fs.existsSync(failCache) || !fs.readdirSync(failCache).some((f) => f.endsWith('.glb'))), r3.out.trim().split('\n').pop());
    const before = JSON.parse(fs.readFileSync(logf, 'utf8')).length;
    const r4 = run(MS_CLI, ['acquire', '--provider', 'command', '--cmd', tpl, '--image', conceptPng, '--prompt', 'other', '--out', path.join(TMP, 'ms_cmd_dry'), '--dry-run']);
    check('command: --dry-run prints the argv plan and runs nothing', r4.status === 0 && /"argv"/.test(r4.out) && JSON.parse(fs.readFileSync(logf, 'utf8')).length === before, 'tool calls unchanged');
    let threw = ''; try { ms.substituteTemplate('tool --out {out} {nope}', { out: 'x' }); } catch (e) { threw = e.message; }
    const argv = ms.substituteTemplate(`tool "a b" --p {prompt} --out {out}`, { prompt: 'x" y; z', out: 'o.glb', image: null, outDir: null });
    check('command: tokenizer keeps quoted args, unknown placeholders rejected', argv.length === 6 && argv[1] === 'a b' && argv[3] === 'x" y; z' && /unknown placeholder/.test(threw), JSON.stringify(argv));
  }
  {
    const out = path.join(TMP, 'ms_manual');
    const r1 = run(MS_CLI, ['acquire', '--provider', 'manual', '--image', conceptPng, '--name', 'ring_vessel', '--out', out]);
    const drop = path.join(out, 'inbox', 'ring_vessel.glb');
    const pendingOk = r1.status === 3 && r1.out.includes(drop) && /checklist/i.test(r1.out);
    fs.copyFileSync(glbFile, drop);
    const r2 = run(MS_CLI, ['acquire', '--provider', 'manual', '--image', conceptPng, '--name', 'ring_vessel', '--out', out]);
    const m2 = JSON.parse(fs.readFileSync(path.join(out, 'mesh_source.json'), 'utf8'));
    check('manual: prints checklist + exact drop path (exit 3 pending), picks up the dropped .glb on re-run (validated + cached)', pendingOk && r2.status === 0 && m2.status === 'ready' && m2.provider === 'manual' && m2.sha256 === sha(glbFile), `drop ${path.relative(TMP, drop)}`);
  }
  {
    const r1 = run(MS_CLI, ['check-provider', '--provider', 'tripo']);
    const r2 = run(MS_CLI, ['acquire', '--provider', 'tripo', '--image', conceptPng, '--out', path.join(TMP, 'ms_tripo')]);
    check('tripo: without a key check-provider is not ready (exit 3) and acquire fails cleanly (exit 1) before any network call', r1.status === 3 && /not configured/.test(r1.out) && r2.status === 1 && /not configured/.test(r2.out) && !/network/i.test(r2.out), `exit ${r1.status} / ${r2.status}`);
    const fakeKey = 'tsk_TESTKEY_0123456789abcdefSECRET';
    const envFile = path.join(TMP, 'test.env');
    fs.writeFileSync(envFile, `﻿# comment\nexport TRIPO_API_KEY="${fakeKey}"\nOTHER=1\n`);
    const r3 = run(MS_CLI, ['check-provider', '--provider', 'tripo', '--env-file', envFile]);
    const r4 = run(MS_CLI, ['acquire', '--provider', 'tripo', '--env-file', envFile, '--image', conceptPng, '--out', path.join(TMP, 'ms_tripo_dry'), '--dry-run']);
    const r5 = run(MS_CLI, ['list-providers', '--env-file', envFile]);
    const manDry = fs.readFileSync(path.join(TMP, 'ms_tripo_dry', 'mesh_source.json'), 'utf8');
    const leaked = [r3.out, r4.out, r5.out, manDry].some((s) => s.includes(fakeKey) || s.includes('TESTKEY_0123'));
    check('tripo: --env-file (BOM, export, quotes) → ready; dry run + listing never print the key; 0 network calls', r3.status === 0 && /env-file/.test(r3.out) && r4.status === 0 && /"keyConfigured":true/.test(r4.out) && /TRIPO_API_KEY:set/.test(r5.out) && !leaked, `leak ${leaked}`);
    ms.registerSecret(fakeKey);
    const red = ms.redact(`Authorization: Bearer ${fakeKey} url?api_key=abcdef123456 msg ${fakeKey} sk-abcdefghijklmnop`);
    check('redact(): registered secret, Bearer token, api_key= and sk- shapes removed', !red.includes(fakeKey) && !red.includes('abcdef123456') && !red.includes('abcdefghijklmnop') && /\[REDACTED\]/.test(red), red);
    const env = ms.parseEnvText('﻿export A="x y"\nB=\'q\'\nC=plain # note\n#D=no');
    check('parseEnvText(): BOM, export prefix, quotes and trailing comments', env.A === 'x y' && env.B === 'q' && env.C === 'plain' && !('D' in env), JSON.stringify(env));
  }
  {
    let dup = '', bad = '';
    try { ms.registerProvider('local', { kind: 'offline', describe: () => '', check: () => ({}), acquire: () => ({}) }); } catch (e) { dup = e.message; }
    try { ms.registerProvider('half', { kind: 'offline', describe: () => '' }); } catch (e) { bad = e.message; }
    ms.registerProvider('studio_export', {
      label: 'Studio export (test)', kind: 'offline',
      describe: () => 'copies a pre-exported model',
      check: () => ({ ready: true, reason: 'test adapter' }),
      cacheParams: (o) => ({ preset: o.preset || 'default' }),
      acquire: async (ctx) => { fs.copyFileSync(glbFile, ctx.target); return { file: ctx.target, meta: { preset: 'default' } }; },
    });
    const rows = await ms.listProviders({ homeEnv: false });
    const m = await ms.acquireMesh({ provider: 'studio_export', image: conceptPng, out: path.join(TMP, 'ms_custom'), log: false });
    const m2 = await ms.acquireMesh({ provider: 'studio_export', image: conceptPng, out: path.join(TMP, 'ms_custom'), log: false });
    check('registerProvider(): custom adapter listed + acquired + cached; duplicate id and incomplete adapter rejected',
      rows.some((r) => r.id === 'studio_export' && r.ready) && m.status === 'ready' && m.providerMeta.preset === 'default' && m2.cached && /already registered/.test(dup) && /must implement/.test(bad), `${m.file}`);
    const m3 = await ms.acquireMesh({ provider: 'tripo', image: conceptPng, out: path.join(TMP, 'ms_custom'), log: false, dryRun: true, envFile: path.join(TMP, 'test.env') });
    check('in-process tripo dry run: plan only, fetch() never called', m3.status === 'dry-run' && m3.plan.keyConfigured === true && fetchCalls === 0, `fetch calls ${fetchCalls}`);
  }

  // =========================================================================================== 2. mesh_to_voxel.mjs
  console.log('\n== mesh_to_voxel.mjs ==');
  {
    const m = mv.loadGlbMesh(glbFile);
    const arm = m.primitives.find((p) => p.mesh === 'arm');
    let ymin = Infinity, ymax = -Infinity; for (let k = 1; k < arm.positions.length; k += 3) { ymin = Math.min(ymin, arm.positions[k]); ymax = Math.max(ymax, arm.positions[k]); }
    const tex = m.materials[0].baseTex;
    check('loadGlbMesh(): 4 primitives / 48 tris, node translation applied (arm y −60..−30), embedded PNG texture decoded natively (8x8, red top / blue bottom)',
      m.primitives.length === 4 && m.triangles === 48 && ymin === -60 && ymax === -30 && tex && tex.w === 8 && tex.data[0] === 208 && tex.data[(7 * 8) * 4 + 2] === 192 && !m.warnings.length,
      `bounds ${m.rawBounds.min} .. ${m.rawBounds.max}`);
  }
  {
    const out = path.join(TMP, 'inspect');
    const r = run(MV_CLI, ['inspect', '--glb', glbFile, '--out', out, '--rot-x', '90', '--length-y', '120', '--ss', '1']);
    const j = fs.existsSync(path.join(out, 'glb_inspect.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'glb_inspect.json'), 'utf8')) : {};
    const sheet = fs.existsSync(path.join(out, 'glb_6view_sheet.png')) ? dif.readPNG(path.join(out, 'glb_6view_sheet.png')) : null;
    const al = fs.existsSync(path.join(out, 'glb_6view_aligned.png')) ? dif.readPNG(path.join(out, 'glb_6view_aligned.png')) : null;
    let lit = 0; if (sheet) for (let i = 0; i < sheet.data.length; i += 4) if (sheet.data[i] > 120 || sheet.data[i + 2] > 120) lit++;
    const sz = j.aligned && j.aligned.bounds.size;
    check('inspect CLI: 6-view PNG sheet (1500x1036) + aligned sheet + JSON bounds (raw 47 x 90 x 24 u; rot-x 90 + length-y 120 → 235 x 120 x 450 u)',
      r.status === 0 && sheet && sheet.width === 1500 && sheet.height === 1036 && al && lit > 20000 && j.rawBounds.size.join() === '47,90,24' && sz && Math.abs(sz[0] - 235) < 1e-6 && Math.abs(sz[1] - 120) < 1e-6 && Math.abs(sz[2] - 450) < 1e-6,
      `raw ${j.rawBounds && j.rawBounds.size} · aligned ${sz} · lit px ${lit}`);
    const png = path.join(TMP, 'render_hero.png');
    const r2 = run(MV_CLI, ['render', '--glb', glbFile, '--out', png, '--width', '320', '--height', '200', '--view', 'az=-40,el=20,fov=24', '--ss', '1']);
    const im = fs.existsSync(png) ? dif.readPNG(png) : null;
    let fg = 0; if (im) for (let i = 0; i < im.data.length; i += 4) if (Math.abs(im.data[i] - 14) + Math.abs(im.data[i + 1] - 21) + Math.abs(im.data[i + 2] - 32) > 30) fg++;
    check('render CLI: single CPU-rasterised perspective frame of the aligned model', r2.status === 0 && im && im.width === 320 && fg > 3000, `${fg} foreground px`);
  }
  {
    const st = mv.selfTestMaskedQuad16();
    check('selfTestMaskedQuad16: masked mesher byte-identical to kit greedyQuad16Part; 2-way split conserves exposed faces', st.identical && st.exposedConserved, JSON.stringify(st));
  }
  const zonesFile = path.join(TMP, 'detail_zones.json');
  fs.writeFileSync(zonesFile, JSON.stringify({ schema: 'svox.detail_zones/v1', assetId: 'synthetic', zones: [{ zoneId: 'z1_bay', kind: 'occluded_cavity', carve: [{ shape: 'box', min: [-6, 4, -6], max: [6, 20, 4] }] }] }));
  const emRules = [{ name: 'accent', hue: [40, 70], sat: [0.5, 1], val: [0.5, 1], matTag: 9, emissive: 0.8, levels: 2 }];
  const matRules = [{ name: 'trim', hue: [340, 25], sat: [0.4, 1], matTag: 7 }, { name: 'armour', hue: [200, 250], sat: [0.4, 1], matTag: 1 }];
  const vopts = (outAsset, extra = {}) => ({ glb: glbFile, outAsset, origin: 'none', voxelScale: 2, solidify: true, symmetrize: 'x:high', colors: 6, emissiveRules: emRules, matRules, zones: zonesFile,
    aoRays: 12, aoDist: 12, macroLevels: 16, splitParts: ['arm:wave:y<-31:wave=4,0.05,0:axis=box:auto:cc=20'], materialProfile: 'hard_surface', archetype: 'generic_megastructure', noPreview: true, log: false, ...extra });
  {
    let hooks = { preAo: 0, meso: 0, meta: 0 };
    const outAsset = path.join(TMP, 'vox_a', 'synthetic');
    const res = await mv.voxelizeGlb(vopts(outAsset, {
      preAoHook: (ctx) => { hooks.preAo++; return { cleared: ctx.grid.count() > 0 }; },
      metaHook: (ctx) => { hooks.meta++; return { fxAnchors: { glow: ctx.toLocal(ctx.center[0], ctx.center[1], ctx.center[2]) } }; },
      mesoHook: (ctx) => {
        hooks.meso++;
        const g = new kit.VoxelGrid(6, 6, 6); g.box([1, 1, 1], [5, 5, 5], 1);
        return { prefabs: [{ id: 'pod', grid: g, voxelScale: 1, pivot: [3, 3, 0] }], instances: [{ prefab: 'pod', pos: [0, 20, 10], rotQuat: [0, 0, 0, 1], scale: 1, tint: [1, 1, 1] }] };
      },
    }));
    const { grid, labels, packed, megaPalette: pal } = res;
    const { nx, ny, nz } = grid, cx = res.voxel.center[0];
    let symOk = true;
    for (let z = 0; z < nz && symOk; z++) for (let y = 0; y < ny && symOk; y++) for (let k = 0; k < cx; k++) if (!!grid.pal[k + nx * (y + ny * z)] !== !!grid.pal[nx - 1 - k + nx * (y + ny * z)]) { symOk = false; break; }
    const P = res.palette;
    const emTex = P.filter((p) => p.group === 'emissive_tex'), accent = P.filter((p) => p.group === 'em:accent');
    check('voxelize: solidify fills the closed hull interior; symmetrize x:high mirrors the +X fin onto −X (occupancy symmetric)', res.voxel.interiorCells > 500 && symOk, `interior ${res.voxel.interiorCells} · grid ${nx}x${ny}x${nz}`);
    check('voxelize: emissive split — emissiveFactor voxels → emissive_tex (em > 0, matTag 8); yellow fin → accent rule (≤ 2 levels, matTag 9, em > 0)',
      emTex.length >= 1 && emTex.every((p) => p.emissive > 0 && p.matTag === 8) && accent.length >= 1 && accent.length <= 2 && accent.every((p) => p.matTag === 9 && p.emissive > 0), `emtex ${emTex.length} · accent ${accent.length}`);
    check('voxelize: PNG texture colours reach the palette — red → trim (matTag 7, hue wrap 340..25), blue → armour (matTag 1)',
      P.some((p) => p.name.startsWith('trim') && p.matTag === 7) && P.some((p) => p.name.startsWith('armour') && p.matTag === 1), P.filter((p) => p.group === 'diffuse').map((p) => `${p.name}${p.hex}`).join(' '));
    check('voxelize: detail-zone carve removed voxels after solidify (before AO)', res.carves.zones.total > 50 && res.carves.zones.perZone.z1_bay > 50, `carved ${res.carves.zones.total}`);
    const sp = res.split;
    const arm = sp.parts.find((p) => p.name === 'arm'), hull = sp.parts.find((p) => p.name === 'hull');
    const pj = packed.json.macro.parts;
    check('voxelize --split-part: hull (static) + arm (wave) parts, arm keeps its connected component, auto box anchor at the root junction (y ≈ −32)',
      sp.parts.length === 2 && arm.voxels > 300 && hull.voxels > 1000 && arm.waveAxis === 'box' && arm.junctionVoxels > 0 && Math.abs(arm.waveCenter[1] - (-32)) < 4 && Math.abs(arm.waveCenter[0]) < 2 && pj.find((p) => p.name === 'arm').waveAxis === 'box',
      `arm ${arm.voxels} vox · anchor ${arm.waveCenter} half ${arm.waveRadii}`);
    check('voxelize: ONE unified macro AO shared by every part (json macroAo.shared) and exposed faces conserved across the split',
      pj.every((p) => p.macroAo && p.macroAo.shared === 'one bake on the unified grid') && (() => {
        const all = new Uint8Array(labels.length);
        const whole = mv.greedyQuad16Masked(grid, pal, all, 0, { voxelScale: 2, center: res.voxel.center, macroAo: res.macroAo, macroLevels: 16 });
        return whole.exposedFaces === hull.exposedFaces + arm.exposedFaces;
      })(), `${pj.map((p) => `${p.name} ${p.quadCount} quads`).join(' · ')}`);
    const ref = kit.greedyQuad16Part(grid, pal, { voxelScale: 2, center: res.voxel.center, macroAo: res.macroAo, macroLevels: 16 });
    const msk = mv.greedyQuad16Masked(grid, pal, new Uint8Array(labels.length), 0, { voxelScale: 2, center: res.voxel.center, macroAo: res.macroAo, macroLevels: 16 });
    check('greedyQuad16Masked == greedyQuad16Part byte-for-byte on the real voxelized grid (single label)', ref.quadCount === msk.quadCount && Buffer.compare(Buffer.from(ref.bytes), Buffer.from(msk.bytes)) === 0, `${ref.quadCount} quads`);
    const back = kit.readMegaAsset(`${outAsset}.json`);
    check('MEGA_V23 pack: svox.mega/v2.3 quad16 parts + packed20 meso prefab from mesoHook, static budget PASS, materialProfile kept; hooks ran once each',
      packed.json.schema === 'svox.mega/v2.3' && pj.every((p) => p.vertexFormat === 'quad16') && packed.json.meso.prefabs.length === 1 && packed.json.meso.prefabs[0].instanceCount === 1 && res.budget.staticPass &&
      packed.json.materialProfile && packed.json.materialProfile.id === 'hard_surface' && back.json.schema === 'svox.mega/v2.3' && hooks.preAo === 1 && hooks.meso === 1 && hooks.meta === 1 && packed.json.meta.fxAnchors,
      `${res.stats.drawCalls} draws · ${res.stats.totalTriangles} tris · ${(res.stats.binBytes / 1024).toFixed(1)} KiB`);
    // determinism: a second independent build gives identical bytes
    const outB = path.join(TMP, 'vox_b', 'synthetic');
    const res2 = await mv.voxelizeGlb(vopts(outB, {
      preAoHook: () => ({ cleared: true }), metaHook: (ctx) => ({ fxAnchors: { glow: ctx.toLocal(ctx.center[0], ctx.center[1], ctx.center[2]) } }),
      mesoHook: () => { const g = new kit.VoxelGrid(6, 6, 6); g.box([1, 1, 1], [5, 5, 5], 1); return { prefabs: [{ id: 'pod', grid: g, voxelScale: 1, pivot: [3, 3, 0] }], instances: [{ prefab: 'pod', pos: [0, 20, 10], rotQuat: [0, 0, 0, 1], scale: 1, tint: [1, 1, 1] }] }; },
    }));
    check('determinism: two independent voxelize runs → identical .json and .bin SHA-256', res.sha256.json === res2.sha256.json && res.sha256.bin === res2.sha256.bin && sha(`${outAsset}.bin`) === sha(`${outB}.bin`), `bin ${res.sha256.bin.slice(0, 12)}…`);
    const rep = JSON.parse(fs.readFileSync(path.join(TMP, 'vox_a', 'voxelize_report.json'), 'utf8'));
    const cache = JSON.parse(fs.readFileSync(path.join(TMP, 'vox_a', 'voxel_cache.json'), 'utf8'));
    check('voxelize writes voxelize_report.json + voxel_cache.{json,bin} (sculpt base) with dims × 2 bytes', rep.ok && cache.schema === 'svox.voxel_cache/v1' && fs.statSync(path.join(TMP, 'vox_a', 'voxel_cache.bin')).size === nx * ny * nz * 2, `${cache.dims}`);
  }
  {
    // CLI end-to-end from a mesh_source manifest, with the split spec and previews
    const out = path.join(TMP, 'vox_cli', 'cli_asset');
    const r = run(MV_CLI, ['voxelize', '--source', path.join(TMP, 'ms_local', 'mesh_source.json'), '--out-asset', out, '--origin', 'none', '--voxel-scale', '2', '--solidify', '--symmetrize', 'x:high',
      '--colors', '6', '--ao-rays', '8', '--ao-dist', '10', '--split-part', 'arm:wave:y<-31:wave=4,0.05,0:axis=ellipsoid:auto:cc=20', '--emissive-rules', JSON.stringify(emRules), '--zones', zonesFile]);
    let j = {}; try { j = JSON.parse(r.stdout.slice(r.stdout.indexOf(String.fromCharCode(10) + '{') + 1)); } catch { /* fail below */ }
    const asset = fs.existsSync(`${out}.json`) ? JSON.parse(fs.readFileSync(`${out}.json`, 'utf8')) : {};
    const armP = asset.macro && asset.macro.parts.find((p) => p.name === 'arm');
    const prev = path.join(TMP, 'vox_cli', 'voxel_preview_hero34.png');
    check('voxelize CLI (--source mesh_source.json, --split-part …axis=ellipsoid:auto): exit 0, ellipsoid radii = √3 · junction half extents, CPU previews written',
      r.status === 0 && j.ok && armP && armP.waveAxis === 'ellipsoid' && armP.waveRadii.every((v) => v > 0) && fs.existsSync(prev), `${j.stats ? `${j.stats.quads} quads` : r.out.slice(-200)}`);
    let e1 = ''; try { mv.parseSplitPart('arm:wave:q<3'); } catch (e) { e1 = e.message; }
    let e2 = ''; try { mv.parseSplitPart('arm:wave:y<3:bogus'); } catch (e) { e2 = e.message; }
    check('parseSplitPart(): bad clause and unknown option rejected', /bad clause/.test(e1) && /unknown option/.test(e2), `${e1} | ${e2}`);
  }
  check('zero external API calls during the whole suite', fetchCalls === 0, `fetch calls ${fetchCalls}`);
} catch (e) {
  check(`unexpected exception: ${e.stack || e.message}`, false);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
}
console.log(`\n${pass}/${pass + fail} PASS${fail ? ` · ${fail} FAIL` : ''} · temp files removed: ${!fs.existsSync(TMP)}`);
process.exitCode = fail ? 1 : 0;
