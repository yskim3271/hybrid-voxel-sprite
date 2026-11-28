#!/usr/bin/env node
// mesh_source.mjs — hybrid-voxel-sprite · Track B Mode B2: pluggable 3D model (.glb / .gltf) acquisition.
// Node >= 18, zero npm dependencies. Importable ES module + CLI.
//
// Providers (pick one with --provider; nothing online ever runs unless you select it explicitly):
//   local    (default, offline, $0)  ingest an existing .glb / .gltf exported from Blender, MagicaVoxel, a kitbash library,
//                                     a marketplace download, … (--glb <path>)
//   command  (offline or online, your choice)  run ANY CLI you trust — a local open-source image-to-3D model, a Blender
//                                     headless script, your own API wrapper — from a template:
//                                     --cmd "my-tool --in {image} --out {out}"   placeholders {image} {prompt} {out} {outDir}
//                                     (the template is tokenised first and every token substituted on its own, then spawned
//                                     WITHOUT a shell, so a prompt or path can never inject extra arguments or commands)
//   manual   (interactive)            print a checklist + the exact drop path; generate / export the model in any web UI or
//                                     DCC tool, save it there, re-run (or --wait N seconds) → validated and cached
//   tripo    (optional online reference adapter)  only when --provider tripo is given AND TRIPO_API_KEY is configured
//                                     (process env, --env-file, or ~/.env). The key is never printed, logged or written.
//   + your own: registerProvider(id, adapter) — see references/04 §2B.3 for a ~30-line example.
//
// CLI
//   node scripts/mesh_source.mjs list-providers [--json] [--env-file f]
//   node scripts/mesh_source.mjs check-provider --provider <id> [--glb f] [--cmd t] [--env-file f] [--online]
//   node scripts/mesh_source.mjs acquire --provider <id> [--glb f] [--image f] [--prompt text] [--cmd t] [--out dir]
//        [--name stem] [--timeout s] [--wait s] [--env-file f] [--force] [--dry-run]
//   exit codes: 0 ok · 1 error · 2 usage · 3 pending (manual drop not there yet / provider not ready)
//
// Output (--out, default ./mesh_source): cache/<sha256-key>.glb (or cache/<key>/model.gltf + resources) and
// mesh_source.json { schema: 'svox.mesh_source/v1', provider, cacheKey, file, sha256, bytes, format, cached, inputs, … }.
// The cache key is SHA-256 over the provider id, the input bytes and the request parameters: a repeat request is served from
// the cache without running the tool or spending credits again. Feed the manifest straight to the voxelizer:
//   node scripts/mesh_to_voxel.mjs voxelize --source mesh_source/mesh_source.json --out-asset build/asset …

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MESH_SOURCE_VERSION = '2.4.0';
export const MESH_SOURCE_SCHEMA = 'svox.mesh_source/v1';
export const EXIT = Object.freeze({ OK: 0, ERROR: 1, USAGE: 2, PENDING: 3 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// =============================================================================================== secrets & redaction
const SECRETS = new Set();
/** Register a secret value so that redact() removes it from every string this module emits. */
export function registerSecret(value) { if (value && String(value).length >= 4) SECRETS.add(String(value)); }
/** Strip registered secrets, bearer tokens and common API-key shapes from a string (logs, errors, manifests). */
export function redact(s, extra = []) {
  let t = String(s);
  for (const k of [...SECRETS, ...extra]) if (k && String(k).length >= 4) t = t.split(String(k)).join('[REDACTED]');
  return t
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\b(tsk|sk|msy|key)[-_][A-Za-z0-9._-]{8,}/g, '$1_[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|authorization)["']?\s*[:=]\s*["']?)[^\s"',&]{6,}/gi, '$1[REDACTED]');
}

/** Parse a dotenv file: UTF-8 BOM stripped, `export ` prefix, # comments, matching single / double quotes removed. */
export function parseEnvText(text) {
  const out = {};
  for (const line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}
export function loadEnvFile(file) { return fs.existsSync(file) ? parseEnvText(fs.readFileSync(file, 'utf8')) : {}; }

/** Resolve a secret by name: process env → --env-file → ~/.env (unless homeEnv: false). Returns { value, source } or null. */
export function resolveSecret(name, { envFile = null, env = process.env, homeEnv = true } = {}) {
  if (env[name] && String(env[name]).trim()) { const v = String(env[name]).trim(); registerSecret(v); return { value: v, source: 'env' }; }
  const files = [envFile, homeEnv ? path.join(os.homedir(), '.env') : null].filter(Boolean);
  for (const f of files) {
    const v = loadEnvFile(f)[name];
    if (v && v.trim()) { registerSecret(v.trim()); return { value: v.trim(), source: f === envFile ? 'env-file' : '~/.env' }; }
  }
  return null;
}

// =============================================================================================== glTF / GLB validation
const GLB_MAGIC = 0x46546c67, CHUNK_JSON = 0x4e4f534a, CHUNK_BIN = 0x004e4942;
/**
 * Validate a .glb (binary header, version 2, JSON chunk, declared length) or a .gltf (JSON, asset.version 2.x, external
 * resources present). → { format, version, bytes, meshes, nodes, materials, images, generator, resources[] }. Throws on error.
 */
export function validateGltfFile(file) {
  if (!file || !fs.existsSync(file)) throw new Error(`model file not found: ${file}`);
  const buf = fs.readFileSync(file);
  if (buf.length >= 12 && buf.readUInt32LE(0) === GLB_MAGIC) {
    const version = buf.readUInt32LE(4), total = buf.readUInt32LE(8);
    if (version !== 2) throw new Error(`${path.basename(file)}: GLB container version ${version} (need 2)`);
    if (total !== buf.length) throw new Error(`${path.basename(file)}: GLB header length ${total} != file size ${buf.length} (truncated download?)`);
    if (buf.length < 20 || buf.readUInt32LE(16) !== CHUNK_JSON) throw new Error(`${path.basename(file)}: GLB first chunk is not JSON`);
    const jl = buf.readUInt32LE(12);
    if (20 + jl > buf.length) throw new Error(`${path.basename(file)}: GLB JSON chunk overruns the file`);
    const json = JSON.parse(buf.subarray(20, 20 + jl).toString('utf8'));
    let off = 20 + jl, hasBin = false;
    while (off + 8 <= buf.length) { const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4); if (type === CHUNK_BIN) hasBin = true; off += 8 + len; }
    return summarize(json, { format: 'glb', bytes: buf.length, hasBin, resources: [] });
  }
  let json;
  try { json = JSON.parse(buf.toString('utf8').replace(/^﻿/, '')); } catch { throw new Error(`${path.basename(file)}: neither a GLB (bad magic) nor glTF JSON`); }
  const resources = [];
  for (const kind of ['buffers', 'images']) for (const r of json[kind] || []) {
    if (!r.uri || r.uri.startsWith('data:')) continue;
    const rel = decodeURIComponent(r.uri), abs = path.resolve(path.dirname(file), rel);
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error(`${path.basename(file)}: resource uri '${r.uri}' must be relative and stay inside the model folder`);
    if (!fs.existsSync(abs)) throw new Error(`${path.basename(file)}: missing ${kind.slice(0, -1)} '${r.uri}'`);
    resources.push(rel);
  }
  return summarize(json, { format: 'gltf', bytes: buf.length, hasBin: (json.buffers || []).length > 0, resources });
}
function summarize(json, extra) {
  const v = json.asset && String(json.asset.version || '');
  if (!/^2\./.test(v)) throw new Error(`glTF asset.version '${v}' is not 2.x`);
  if (!(json.meshes || []).length) throw new Error('glTF has no meshes');
  return { ...extra, version: v, generator: (json.asset && json.asset.generator) || null, meshes: json.meshes.length, nodes: (json.nodes || []).length,
    materials: (json.materials || []).length, images: (json.images || []).length, extensionsRequired: json.extensionsRequired || [] };
}

// =============================================================================================== cache
function cacheKeyOf(provider, inputs, params) {
  const h = crypto.createHash('sha256');
  h.update(`provider:${provider}\n`);
  for (const [k, f] of Object.entries(inputs).sort()) h.update(`${k}:`).update(f && fs.existsSync(f) ? fs.readFileSync(f) : Buffer.from(String(f ?? ''))).update('\n');
  h.update(JSON.stringify(params, Object.keys(params).sort()));
  return h.digest('hex');
}
function cachedFile(outDir, key) {
  const glb = path.join(outDir, 'cache', `${key}.glb`), gltf = path.join(outDir, 'cache', key, 'model.gltf');
  return fs.existsSync(glb) ? glb : fs.existsSync(gltf) ? gltf : null;
}
/** Copy a validated model into the cache (a .gltf keeps its relative buffers / images next to it). */
function storeInCache(src, outDir, key, info) {
  fs.mkdirSync(path.join(outDir, 'cache'), { recursive: true });
  if (info.format === 'glb') {
    const dst = path.join(outDir, 'cache', `${key}.glb`);
    if (path.resolve(src) !== path.resolve(dst)) fs.copyFileSync(src, dst);
    return dst;
  }
  const dir = path.join(outDir, 'cache', key);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, path.join(dir, 'model.gltf'));
  for (const rel of info.resources) { const d = path.join(dir, rel); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(path.resolve(path.dirname(src), rel), d); }
  return path.join(dir, 'model.gltf');
}
function writeManifest(outDir, m) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'mesh_source.json');
  fs.writeFileSync(file, redact(JSON.stringify(m, null, 1)) + '\n');
  return file;
}
/** Read a mesh_source.json manifest → absolute model path (used by mesh_to_voxel.mjs --source). */
export function resolveManifestModel(manifestFile) {
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (m.schema !== MESH_SOURCE_SCHEMA) throw new Error(`${manifestFile}: not a ${MESH_SOURCE_SCHEMA} manifest`);
  if (!m.file) throw new Error(`${manifestFile}: status '${m.status}' — no model file yet`);
  return path.resolve(path.dirname(manifestFile), m.file);
}

// =============================================================================================== command templates
/** Split a command template like a POSIX shell would for quoting only ("…", '…', \"), never expanding anything. */
export function tokenizeTemplate(template) {
  const out = []; let cur = '', q = null, any = false;
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"' && template[i + 1] === '"') { cur += '"'; i++; } else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; any = true; continue; }
    if (/\s/.test(c)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += c;
  }
  if (q) throw new Error('command template: unterminated quote');
  if (cur || any) out.push(cur);
  return out;
}
/** Tokenise first, then substitute {image} {prompt} {out} {outDir} inside each token → argv (no shell, no injection). */
export function substituteTemplate(template, vars) {
  const argv = tokenizeTemplate(template).map((tok) => tok.replace(/\{(\w+)\}/g, (m, k) => {
    if (!(k in vars)) throw new Error(`command template: unknown placeholder {${k}} (use {image} {prompt} {out} {outDir})`);
    if (vars[k] === null || vars[k] === undefined) throw new Error(`command template uses {${k}} but no value was given (--${k === 'out' || k === 'outDir' ? 'out' : k})`);
    return String(vars[k]);
  }));
  if (!argv.length) throw new Error('command template is empty');
  return argv;
}
function onPath(exe) {
  if (path.isAbsolute(exe) || exe.includes('/') || exe.includes('\\')) return fs.existsSync(exe) ? path.resolve(exe) : null;
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').concat(['']) : [''];
  for (const d of (process.env.PATH || '').split(path.delimiter)) for (const e of exts) { const p = path.join(d, exe + e); try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ } }
  return null;
}
function runArgv(argv, { timeoutMs = 30 * 60 * 1000, cwd, log }) {
  return new Promise((resolve, reject) => {
    const p = spawn(argv[0], argv.slice(1), { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let tail = '';
    const keep = (d) => { tail = (tail + d.toString()).slice(-4000); };
    p.stdout.on('data', keep); p.stderr.on('data', keep);
    const timer = setTimeout(() => { p.kill(); reject(new Error(`command timed out after ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(new Error(`command could not start: ${e.message}`)); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) { if (log && tail.trim()) log(tail.trim().split(/\r?\n/).slice(-5).map((l) => `  | ${l}`).join('\n')); resolve(); }
      else reject(new Error(`command exited ${code}${tail.trim() ? `: ${tail.trim().split(/\r?\n/).slice(-3).join(' / ')}` : ''}`));
    });
  });
}

// =============================================================================================== provider registry
const REGISTRY = new Map();
const REQUIRED = ['describe', 'check', 'acquire'];
/**
 * Register a provider. adapter = {
 *   label, kind: 'offline' | 'online' | 'interactive', secrets?: ['ENV_NAME'],
 *   describe() → string,
 *   check(opts) → { ready: bool, reason, … }        (cheap, no credits spent; may be async),
 *   acquire(ctx) → { file, meta? }                   (ctx: { opts, outDir, key, target, workDir, log, secret(name), fetch })
 * }   `target` is the .glb path the adapter should write; returning another existing .glb / .gltf path also works.
 */
export function registerProvider(id, adapter, { replace = false } = {}) {
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(String(id))) throw new Error(`registerProvider: bad id '${id}' (lowercase, 2–32 chars)`);
  if (REGISTRY.has(id) && !replace) throw new Error(`registerProvider: '${id}' is already registered (pass { replace: true })`);
  for (const k of REQUIRED) if (typeof (adapter && adapter[k]) !== 'function') throw new Error(`registerProvider: adapter '${id}' must implement ${REQUIRED.join(', ')}()`);
  if (!['offline', 'online', 'interactive'].includes(adapter.kind)) throw new Error(`registerProvider: adapter '${id}' kind must be offline | online | interactive`);
  REGISTRY.set(id, { id, label: adapter.label || id, secrets: [], ...adapter });
  return REGISTRY.get(id);
}
export function unregisterProvider(id) { return REGISTRY.delete(id); }
export function getProvider(id) {
  const p = REGISTRY.get(id);
  if (!p) throw new Error(`unknown provider '${id}' (available: ${[...REGISTRY.keys()].join(', ')})`);
  return p;
}
/** → [{ id, label, kind, offline, ready, reason, secrets: [{ name, configured, source }] }] — never contains a secret value. */
export async function listProviders(opts = {}) {
  const rows = [];
  for (const p of REGISTRY.values()) {
    let st;
    try { st = await p.check({ ...opts, listing: true }); } catch (e) { st = { ready: false, reason: redact(e.message) }; }
    rows.push({ id: p.id, label: p.label, kind: p.kind, offline: p.kind !== 'online', ready: !!st.ready, reason: redact(st.reason || ''),
      secrets: (p.secrets || []).map((n) => { const s = resolveSecret(n, secretOpts(opts)); return { name: n, configured: !!s, source: s ? s.source : null }; }),
      description: p.describe() });
  }
  return rows;
}
export async function checkProvider(id, opts = {}) {
  const p = getProvider(id);
  const st = await p.check(opts);
  return { id, kind: p.kind, ready: !!st.ready, ...st, reason: redact(st.reason || '') };
}
const secretOpts = (o) => ({ envFile: o.envFile || null, env: o.env || process.env, homeEnv: o.homeEnv !== false });

/**
 * Acquire a model through a provider, validate it, cache it under SHA-256 and write <out>/mesh_source.json.
 * opts: { provider = 'local', glb, image, prompt, cmd, out = './mesh_source', name, timeout (s), wait (s), envFile, force, dryRun, log }
 * → manifest { schema, provider, status: 'ready' | 'pending' | 'dry-run', file?, sha256?, cached, … , manifestPath }
 */
export async function acquireMesh(opts = {}) {
  const id = opts.provider || 'local';
  const p = getProvider(id);
  const log = opts.log === false ? () => {} : (opts.log || ((...a) => console.log(redact(a.join(' ')))));
  const outDir = path.resolve(opts.out || 'mesh_source');
  const inputs = {};
  if (opts.glb) inputs.glb = path.resolve(opts.glb);
  if (opts.image) inputs.image = path.resolve(opts.image);
  for (const [k, f] of Object.entries(inputs)) if (!fs.existsSync(f)) throw new Error(`--${k} ${f} not found`);
  const params = { ...(p.cacheParams ? p.cacheParams(opts) : {}), prompt: opts.prompt || null };
  const key = cacheKeyOf(id, inputs, params);
  const base = { schema: MESH_SOURCE_SCHEMA, tool: `mesh_source.mjs ${MESH_SOURCE_VERSION}`, provider: id, providerKind: p.kind, cacheKey: key,
    inputs: Object.fromEntries(Object.entries(inputs).map(([k, f]) => [k, { name: path.basename(f), sha256: sha256(fs.readFileSync(f)) }])),
    prompt: opts.prompt || null, ...(opts.name ? { name: opts.name } : {}) };
  const finish = (file, extra) => {
    const info = validateGltfFile(file);
    const m = { ...base, status: 'ready', file: path.relative(outDir, file).split(path.sep).join('/'), format: info.format, sha256: sha256(fs.readFileSync(file)),
      bytes: info.bytes, model: { version: info.version, generator: info.generator, meshes: info.meshes, nodes: info.nodes, materials: info.materials, images: info.images,
        extensionsRequired: info.extensionsRequired, resources: info.resources }, ...extra };
    return { ...m, manifestPath: writeManifest(outDir, m) };
  };
  // ---- cache hit (no tool run, no credits)
  const hit = !opts.force && cachedFile(outDir, key);
  if (hit && !opts.dryRun) {
    log(`[mesh_source] cache hit ${key.slice(0, 12)}… → ${path.relative(process.cwd(), hit)} (provider ${id}, nothing re-run)`);
    return finish(hit, { cached: true });
  }
  const target = path.join(outDir, 'cache', `${key}.partial.glb`);
  const ctx = { opts, outDir, key, target, log, workDir: path.join(outDir, 'work'), secret: (n) => { const s = resolveSecret(n, secretOpts(opts)); return s && s.value; },
    fetch: (...a) => guardedFetch(...a) };
  if (opts.dryRun) {
    const plan = p.plan ? await p.plan(ctx) : { note: 'no plan available' };
    const m = { ...base, status: 'dry-run', plan, cached: false };
    log(redact(`[mesh_source] dry run (${id}): ${JSON.stringify(plan)}`));
    return { ...m, manifestPath: writeManifest(outDir, m) };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let res;
  try { res = await p.acquire(ctx); } catch (e) { try { fs.rmSync(target, { force: true }); } catch { /* none */ } throw new Error(redact(e.message)); }
  if (res && res.pending) { const m = { ...base, status: 'pending', ...res.pending, cached: false }; return { ...m, manifestPath: writeManifest(outDir, m) }; }
  const produced = res && res.file ? res.file : target;
  let info;
  try { info = validateGltfFile(produced); } catch (e) { try { fs.rmSync(target, { force: true }); } catch { /* none */ } throw new Error(`provider ${id} produced an invalid model: ${e.message}`); }
  const stored = storeInCache(produced, outDir, key, info);
  if (fs.existsSync(target) && path.resolve(target) !== path.resolve(stored)) fs.rmSync(target, { force: true });
  log(`[mesh_source] ${id} → ${path.relative(process.cwd(), stored)} (${info.format}, ${info.bytes} B, ${info.meshes} mesh${info.meshes > 1 ? 'es' : ''})`);
  return finish(stored, { cached: false, ...(res && res.meta ? { providerMeta: JSON.parse(redact(JSON.stringify(res.meta))) } : {}) });
}

/** fetch() wrapper: honours MESH_SOURCE_FORBID_NETWORK=1 (used by the self-test) and redacts errors. */
async function guardedFetch(url, init) {
  if (process.env.MESH_SOURCE_FORBID_NETWORK === '1') throw new Error(`network access is disabled (MESH_SOURCE_FORBID_NETWORK=1): ${String(url).split('?')[0]}`);
  try { return await fetch(url, init); } catch (e) { throw new Error(redact(`network error ${String(url).split('?')[0]}: ${e.message}`)); }
}

// =============================================================================================== built-in providers
registerProvider('local', {
  label: 'Local file (.glb / .gltf)', kind: 'offline',
  describe: () => 'Ingest a model you already have (Blender / MagicaVoxel / kitbash / downloaded): --glb <path>. Offline, $0.',
  check: (o) => {
    if (!o.glb) return { ready: true, reason: 'offline; pass --glb <file.glb|file.gltf> to acquire' };
    try { const i = validateGltfFile(o.glb); return { ready: true, reason: `${i.format} OK (${i.meshes} meshes, ${i.bytes} B)` }; } catch (e) { return { ready: false, reason: e.message }; }
  },
  cacheParams: () => ({}),
  plan: (ctx) => ({ copy: ctx.opts.glb, into: path.join(ctx.outDir, 'cache', `${ctx.key}.<glb|gltf>`) }),
  acquire: (ctx) => {
    if (!ctx.opts.glb) throw new Error('local provider needs --glb <file.glb|file.gltf>');
    validateGltfFile(ctx.opts.glb);
    return { file: path.resolve(ctx.opts.glb) };
  },
});

registerProvider('command', {
  label: 'Custom command (any CLI / local model / API wrapper)', kind: 'offline',
  describe: () => 'Run your own tool: --cmd "tool --in {image} --out {out}" (placeholders {image} {prompt} {out} {outDir}; no shell).',
  check: (o) => {
    if (!o.cmd) return { ready: !!o.listing, reason: 'pass --cmd "<tool> … {out}" (the tool must write a .glb to {out})' };
    let argv;
    try { argv = tokenizeTemplate(o.cmd); } catch (e) { return { ready: false, reason: e.message }; }
    if (!o.cmd.includes('{out}') && !o.cmd.includes('{outDir}')) return { ready: false, reason: 'template has no {out} / {outDir} placeholder' };
    const exe = onPath(argv[0]);
    return exe ? { ready: true, reason: `executable ${exe}` } : { ready: false, reason: `executable '${argv[0]}' not found on PATH` };
  },
  cacheParams: (o) => ({ cmd: o.cmd || null }),
  plan: (ctx) => ({ argv: substituteTemplate(ctx.opts.cmd || '', templateVars(ctx)), shell: false }),
  acquire: async (ctx) => {
    if (!ctx.opts.cmd) throw new Error('command provider needs --cmd "<tool> … {out}"');
    const argv = substituteTemplate(ctx.opts.cmd, templateVars(ctx));
    fs.mkdirSync(ctx.workDir, { recursive: true });
    ctx.log(`[mesh_source] command: ${argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    await runArgv(argv, { timeoutMs: (Number(ctx.opts.timeout) || 1800) * 1000, cwd: process.cwd(), log: ctx.log });
    if (!fs.existsSync(ctx.target)) {
      const alt = fs.existsSync(ctx.workDir) ? fs.readdirSync(ctx.workDir).filter((f) => /\.(glb|gltf)$/i.test(f)).sort() : [];
      if (ctx.opts.cmd.includes('{outDir}') && alt.length) return { file: path.join(ctx.workDir, alt[0]) };
      throw new Error(`command finished but wrote no model to {out} (${ctx.target})`);
    }
    return { file: ctx.target };
  },
});
const templateVars = (ctx) => ({ image: ctx.opts.image ? path.resolve(ctx.opts.image) : null, prompt: ctx.opts.prompt ?? null, out: ctx.target, outDir: ctx.workDir });

registerProvider('manual', {
  label: 'Manual hand-off (web UI / DCC tool)', kind: 'interactive',
  describe: () => 'Print a checklist + drop path; generate or export a .glb in any web UI or DCC tool, drop it there, re-run (or --wait N).',
  check: () => ({ ready: true, reason: 'always available (you supply the file)' }),
  cacheParams: (o) => ({ name: o.name || null }),
  plan: (ctx) => ({ dropPath: manualDrop(ctx) }),
  acquire: async (ctx) => {
    const drop = manualDrop(ctx);
    fs.mkdirSync(path.dirname(drop), { recursive: true });
    const found = () => [drop, drop.replace(/\.glb$/, '.gltf')].find((f) => fs.existsSync(f));
    const deadline = Date.now() + (Number(ctx.opts.wait) || 0) * 1000;
    let f = found();
    if (!f) {
      ctx.log([
        '[mesh_source] manual hand-off — no external tool is run. Checklist:',
        `  1. Open the generator or DCC tool you prefer (an image-to-3D web UI, Blender, MagicaVoxel, …).`,
        ctx.opts.image ? `  2. Feed it the cleaned concept image: ${path.resolve(ctx.opts.image)}` : '  2. Feed it your cleaned concept image (remove detached props / escorts / background first).',
        ctx.opts.prompt ? `     Prompt / notes: ${ctx.opts.prompt}` : '     (optional) note the prompt you used in --prompt for the record.',
        '  3. Export ONE uncompressed binary glTF (.glb), textures embedded, Y-up, no Draco / meshopt compression.',
        `  4. Save it exactly here:  ${drop}`,
        '  5. Re-run this same command (or add --wait <seconds> to keep polling). It is then validated, hashed and cached.',
      ].join('\n'));
      while (!f && Date.now() < deadline) { await sleep(1000); f = found(); }
    }
    if (!f) return { pending: { dropPath: drop, message: 'waiting for the manual model drop' } };
    return { file: f };
  },
});
const manualDrop = (ctx) => path.join(ctx.outDir, 'inbox', `${ctx.opts.name || `manual_${ctx.key.slice(0, 12)}`}.glb`);

// ---- optional online reference adapter (opt-in only) -------------------------------------------------------------
const TRIPO_API = 'https://api.tripo3d.ai/v2/openapi';
const TRIPO_LADDER = ['v3.1-20260211', 'v3.0-20250812', 'v2.5-20250123', null];
registerProvider('tripo', {
  label: 'Tripo API (optional reference adapter)', kind: 'online', secrets: ['TRIPO_API_KEY'],
  describe: () => 'Image-to-3D via the Tripo v2 OpenAPI. Runs only with --provider tripo and TRIPO_API_KEY set; spends credits; cached by SHA-256.',
  check: async (o) => {
    const s = resolveSecret('TRIPO_API_KEY', secretOpts(o));
    if (!s) return { ready: false, reason: 'TRIPO_API_KEY not configured (env, --env-file or ~/.env)' };
    if (!o.online) return { ready: true, reason: `key configured (${s.source}); add --online to query the credit balance` };
    const bal = await tripoApi(s.value, 'GET', '/user/balance');
    return { ready: true, reason: `key configured (${s.source}); balance ${bal.balance}`, balance: bal.balance };
  },
  cacheParams: (o) => ({ model: o.model || TRIPO_LADDER[0], texture: true, pbr: !!o.pbr, quality: 'detailed' }),
  plan: (ctx) => {
    const s = resolveSecret('TRIPO_API_KEY', secretOpts(ctx.opts));
    return { endpoint: TRIPO_API, keyConfigured: !!s, steps: ['POST /upload (image)', 'POST /task image_to_model', 'GET /task/{id} (poll)', 'download .glb'], image: ctx.opts.image || null };
  },
  acquire: async (ctx) => {
    const key = ctx.secret('TRIPO_API_KEY');
    if (!key) throw new Error('tripo provider: TRIPO_API_KEY not configured (env, --env-file or ~/.env)');
    if (!ctx.opts.image) throw new Error('tripo provider needs --image <png|jpg|webp>');
    const pending = path.join(ctx.outDir, 'cache', `${ctx.key}.task.json`);
    let task = fs.existsSync(pending) ? JSON.parse(fs.readFileSync(pending, 'utf8')) : null;   // resume a polled task (no new credits)
    if (!task) {
      const ext = path.extname(ctx.opts.image).toLowerCase(), mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext];
      if (!mime) throw new Error(`tripo provider: unsupported image type ${ext}`);
      const form = new FormData();
      form.append('file', new Blob([fs.readFileSync(ctx.opts.image)], { type: mime }), path.basename(ctx.opts.image));
      const up = await tripoApi(key, 'POST', '/upload', { form });
      const file = { type: ext === '.jpeg' ? 'jpg' : ext.slice(1), file_token: up.image_token || up.file_token };
      const want = ctx.opts.model || TRIPO_LADDER[0];
      const ladder = TRIPO_LADDER.includes(want) ? TRIPO_LADDER.slice(TRIPO_LADDER.indexOf(want)) : [want, ...TRIPO_LADDER.slice(1)];
      for (const mv of ladder) {
        const body = { type: 'image_to_model', file, texture: true, pbr: !!ctx.opts.pbr, texture_quality: 'detailed', geometry_quality: 'detailed', ...(mv ? { model_version: mv } : {}) };
        try { const d = await tripoApi(key, 'POST', '/task', { json: body }); task = { taskId: d.task_id, modelVersion: mv }; break; }
        catch (e) { ctx.log(`[mesh_source] tripo rejected ${mv || 'default'}: ${e.message}`); if (e.status === 401 || e.status === 403) throw e; }
      }
      if (!task) throw new Error('tripo provider: every model version was rejected');
      fs.writeFileSync(pending, JSON.stringify(task) + '\n');
    }
    let t;
    for (const t0 = Date.now(); ;) {
      t = await tripoApi(key, 'GET', `/task/${task.taskId}`);
      if (t.status === 'success') break;
      if (['failed', 'cancelled', 'banned', 'expired', 'unknown'].includes(t.status)) { fs.rmSync(pending, { force: true }); throw new Error(`tripo task ended ${t.status}`); }
      if (Date.now() - t0 > (Number(ctx.opts.timeout) || 1800) * 1000) throw new Error('tripo task polling timed out — re-run to resume (no new credits)');
      await sleep(3000);
    }
    const o = t.output || {}, u = (k) => (typeof o[k] === 'string' ? o[k] : o[k] && o[k].url);
    const url = u('pbr_model') || u('model') || u('base_model');
    if (!url) throw new Error('tripo task: no model URL in output');
    const res = await guardedFetch(url);   // signed CDN URL: no Authorization header
    if (!res.ok) throw new Error(`tripo download HTTP ${res.status}`);
    fs.writeFileSync(ctx.target, Buffer.from(await res.arrayBuffer()));
    fs.rmSync(pending, { force: true });
    return { file: ctx.target, meta: { taskId: task.taskId, modelVersion: task.modelVersion } };
  },
});
async function tripoApi(key, method, route, { json, form } = {}) {
  registerSecret(key);
  const headers = { Authorization: `Bearer ${key}` };
  let body;
  if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  for (let attempt = 0; ; attempt++) {
    const res = await guardedFetch(`${TRIPO_API}${route}`, { method, headers, body });
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { /* not JSON */ }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await sleep(2000 * (attempt + 1)); continue; }
    if (!res.ok || !data || data.code !== 0) {
      const e = new Error(redact(`${method} ${route}: HTTP ${res.status} ${data ? `code ${data.code} ${data.message || ''}` : text.slice(0, 200)}`));
      e.status = res.status; throw e;
    }
    return data.data;
  }
}

// =============================================================================================== CLI
function parseCli(argv) {
  const [cmd, ...rest] = argv;
  const o = {};
  const flags = new Set(['json', 'force', 'dry-run', 'online', 'pbr', 'no-home-env']);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument '${a}'`);
    const k = a.slice(2);
    if (flags.has(k)) { o[k] = true; continue; }
    if (rest[i + 1] === undefined) throw new Error(`--${k} needs a value`);
    o[k] = rest[++i];
  }
  const camel = Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/-([a-z])/g, (m, c) => c.toUpperCase()), v]));
  if (camel.noHomeEnv) camel.homeEnv = false;
  return { cmd, o: camel };
}
const USAGE = `usage: mesh_source.mjs list-providers [--json] [--env-file f]
       mesh_source.mjs check-provider --provider <id> [--glb f] [--cmd "tool … {out}"] [--env-file f] [--online]
       mesh_source.mjs acquire --provider <local|command|manual|tripo|…> [--glb f] [--image f] [--prompt t] [--cmd t]
                               [--out dir] [--name stem] [--timeout s] [--wait s] [--env-file f] [--force] [--dry-run]`;

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (isMain) {
  let cmd, o;
  try { ({ cmd, o } = parseCli(process.argv.slice(2))); } catch (e) { console.error(`[mesh_source] ${e.message}\n${USAGE}`); process.exit(EXIT.USAGE); }
  try {
    if (cmd === 'list-providers') {
      const rows = await listProviders(o);
      if (o.json) console.log(JSON.stringify(rows, null, 1));
      else {
        console.log('provider  kind         ready  secrets                     notes');
        for (const r of rows) console.log(`${r.id.padEnd(9)} ${r.kind.padEnd(12)} ${(r.ready ? 'yes' : 'no').padEnd(6)} ${(r.secrets.map((s) => `${s.name}:${s.configured ? 'set' : 'missing'}`).join(',') || '-').padEnd(27)} ${r.reason}`);
      }
    } else if (cmd === 'check-provider') {
      if (!o.provider) throw Object.assign(new Error('--provider <id> required'), { usage: true });
      const r = await checkProvider(o.provider, o);
      console.log(redact(JSON.stringify(r)));
      process.exitCode = r.ready ? EXIT.OK : EXIT.PENDING;
    } else if (cmd === 'acquire') {
      const m = await acquireMesh(o);
      const { manifestPath, ...rest } = m;
      console.log(redact(JSON.stringify({ status: rest.status, provider: rest.provider, cached: rest.cached, file: rest.file || null, sha256: rest.sha256 || null, manifest: manifestPath,
        ...(rest.dropPath ? { dropPath: rest.dropPath } : {}), ...(rest.plan ? { plan: rest.plan } : {}) })));
      process.exitCode = m.status === 'pending' ? EXIT.PENDING : EXIT.OK;
    } else { console.log(USAGE); process.exitCode = EXIT.USAGE; }
  } catch (e) {
    console.error(redact(`[mesh_source] ERROR ${e.message}`));
    process.exitCode = e.usage ? EXIT.USAGE : EXIT.ERROR;
  }
}
