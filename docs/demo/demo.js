// demo.js — live hero viewport for the hybrid-voxel-sprite GitHub Pages site.
//
// The real Three.js r187 T3 hybrid renderer (t3_renderer.js + t3_shaders.js), loading the 4 verified articulated SVOX
// vehicles (39 parts, 166,290 voxels) and their motion plugins. Live view modes: FINAL · SPRITE STACK · 3D NORMALS ·
// VOLUME AO. Drag = 360° yaw + pitch 8°–68°, wheel (after clicking the viewport) = zoom. No CDN: three.js is vendored.
// Renderer options panel (always visible): the real T3Renderer options (Crisp DDA / Smooth Iso, cel bands,
// pixel scale and 7 shader-pass toggles), all applied live.
// QA hook: window.__HVS_DEMO__ = { ready, set(patch), status(), renderOnce(), defaults }.

import { T3Renderer, DEFAULT_OPTIONS } from './t3_renderer.js';
import { loadBundle } from './svox_loader.js';
import { loadEvaluator } from './rig_evaluator.js';
import { buildLightState, clamp, deformPoint, ORTHO_HEIGHT } from './math_svox.js';

const DEG = Math.PI / 180;
const PITCH_MIN = 8 * DEG, PITCH_MAX = 68 * DEG;
export const VEHICLES = ['excavator', 'mini', 'cybertruck', 'f1'];
const ACCENT = { excavator: '#de9e41', mini: '#e8c170', cybertruck: '#a4dddb', f1: '#cf573c' };
const MODES = { final: 'final', stack: 'stack', normals: 'normals', ao: 'ao' };
const CLEAR_RGB = { final: [0.047, 0.059, 0.082], stack: [0.051, 0.086, 0.141], normals: [0.071, 0.078, 0.149], ao: [0.80, 0.82, 0.85] };
const PITCH_PRESETS = { iso: 33.2 * DEG, low: 14 * DEG, side: 8 * DEG };
// Renderer panel defaults (= T3Renderer DEFAULT_OPTIONS)
const R_DEFAULTS = Object.freeze({
  surface: 'crisp', bands: 4, px: 1,
  outline: true, selfShadow: true, useAO: true, rim: true, groundShadow: true, emissive: true, usePixelSnap: true,
});
const PASSES = ['outline', 'selfShadow', 'useAO', 'rim', 'groundShadow', 'emissive', 'usePixelSnap'];
const BANDS = [2, 3, 4, 0];

const $ = (id) => document.getElementById(id);
const hex2rgb = (h) => { const n = parseInt(h.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
const tr = (k, fb) => (window.HVS_I18N && window.HVS_I18N.t(k)) || fb || k;

const state = {
  vehicle: 'excavator', mode: 'final', clip: 'special',
  yaw: 0.55, pitch: PITCH_PRESETS.iso, zoom: 1, autoOrbit: true, paused: false,
  r: { ...R_DEFAULTS },
};
const rt = {
  t3: null, ready: false, visible: true, cache: new Map(), loading: new Map(), cur: null,
  fps: 60, last: 0, frames: 0, idleUntil: 0, drag: null, engaged: false, fit: null, errors: [], canvasW: 0, canvasH: 0, dpr: 1,
};
let readyResolve; const ready = new Promise((r) => { readyResolve = r; });

window.addEventListener('error', (e) => rt.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => rt.errors.push(String(e.reason && e.reason.message ? e.reason.message : e.reason)));

// ------------------------------------------------------------------------------------------- loading
function poseBounds(bundle, pose) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of bundle.parts) {
    const pp = pose.parts[p.name]; const m = pp.matrix;
    for (let k = 0; k < 8; k++) {
      const l = [k & 1 ? p.size[0] - p.pivot[0] : -p.pivot[0], k & 2 ? p.size[1] - p.pivot[1] : -p.pivot[1], k & 4 ? p.size[2] - p.pivot[2] : -p.pivot[2]];
      const d = deformPoint(l, pp.deform, p.size[2], p.pivot[2]);
      const w = [m[0] * d[0] + m[4] * d[1] + m[8] * d[2] + m[12], m[1] * d[0] + m[5] * d[1] + m[9] * d[2] + m[13], m[2] * d[0] + m[6] * d[1] + m[10] * d[2] + m[14]];
      for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], w[i]); mx[i] = Math.max(mx[i], w[i]); }
    }
  }
  return { min: mn, max: mx };
}

async function loadVehicle(id) {
  if (rt.cache.has(id)) return rt.cache.get(id);
  if (rt.loading.has(id)) return rt.loading.get(id);
  const p = (async () => {
    const bundle = await loadBundle(new URL(`./svox/${id}`, import.meta.url).href);
    const ev = await loadEvaluator({ id, rig: bundle.rig, tryPlugin: true });
    const subject = rt.t3.createSubject(bundle, { accent: hex2rgb(ACCENT[id]), name: id });
    // framing box = rest pose ∪ 12 samples of every clip (a raised boom / lifted body never leaves the frame)
    const bb = poseBounds(bundle, ev.restPose());
    for (const c of ev.clips) {
      for (let k = 0; k < 12; k++) {
        const q = poseBounds(bundle, ev.evaluateDeterministic(c.id, (k / 12) * c.duration, { useSpring: false, useDeform: true }));
        for (let i = 0; i < 3; i++) { bb.min[i] = Math.min(bb.min[i], q.min[i]); bb.max[i] = Math.max(bb.max[i], q.max[i]); }
      }
    }
    const zLo = Math.max(0, bb.min[2]), hz = Math.max(bb.max[2] - zLo, 1);
    const R = Math.max(1, Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]) / 2);
    subject.setFootprint({ R, hz });
    const v = {
      id, bundle, ev, subject, R, hz, t: 0, spring: ev.createSpringState(),
      target: [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, zLo + 0.36 * hz],
      parts: bundle.parts.length, voxels: bundle.voxels,
    };
    rt.cache.set(id, v);
    return v;
  })();
  rt.loading.set(id, p);
  p.finally(() => rt.loading.delete(id));
  return p;
}

// ------------------------------------------------------------------------------------------- sizing + framing
function resize() {
  const stage = $('demoStage');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(64, Math.round(stage.clientWidth * dpr)), h = Math.max(64, Math.round(stage.clientHeight * dpr));
  if (w !== rt.canvasW || h !== rt.canvasH) { rt.canvasW = w; rt.canvasH = h; rt.dpr = dpr; rt.t3.setSize(w, h); }
}

/** Zoom that fits the vehicle's clip-union box at the current pitch (part-box corners over-estimate by ~25–40%). */
function fitZoom(v, pitch) {
  const aspect = rt.canvasW / rt.canvasH;
  const needV = 2 * v.R * Math.sin(pitch) + v.hz * Math.cos(pitch);
  return Math.min((ORTHO_HEIGHT * 1.12) / needV, (ORTHO_HEIGHT * aspect * 1.0) / (2 * v.R));
}

// ------------------------------------------------------------------------------------------- render
function renderOptions() {
  const r = state.r;
  return {
    ...DEFAULT_OPTIONS, debugView: MODES[state.mode],
    raymarchSmooth: r.surface === 'smooth', celBands: r.bands,
    pixelScale: Math.max(1, Math.round(r.px * rt.dpr)),
    outline: r.outline, selfShadow: r.selfShadow, useAO: r.useAO, rim: r.rim,
    groundShadow: r.groundShadow, emissive: r.emissive, usePixelSnap: r.usePixelSnap,
  };
}
const isDefault = () => Object.keys(R_DEFAULTS).every((k) => state.r[k] === R_DEFAULTS[k]);

function render(dt) {
  const v = rt.cur;
  if (!v) return;
  resize();
  const goal = fitZoom(v, state.pitch);
  rt.fit = rt.fit == null || dt == null ? goal : rt.fit + (goal - rt.fit) * Math.min(1, dt * 6);
  const pose = dt == null || state.paused
    ? v.ev.evaluateDeterministic(state.clip, v.t, { useSpring: true, useDeform: true })
    : v.ev.evaluate(state.clip, v.t, dt, v.spring, { useSpring: true, useDeform: true });
  rt.t3.clearCanvas(CLEAR_RGB[state.mode]);
  rt.t3.render(v.subject, {
    yaw: state.yaw, pitch: state.pitch, zoom: rt.fit * state.zoom, target: v.target,
    light: buildLightState(state.yaw - 1.3, 0.85, 1), pose, options: renderOptions(),
  }, { x: 0, y: 0, w: rt.canvasW, h: rt.canvasH });
  rt.frames++;
}

function loop(now) {
  requestAnimationFrame(loop);
  if (!rt.ready || !rt.visible || document.hidden) { rt.last = now; return; }
  const dt = rt.last ? Math.min(0.1, (now - rt.last) / 1000) : 1 / 60;
  rt.last = now;
  if (!state.paused && rt.cur) rt.cur.t += dt;
  if (state.autoOrbit && !rt.drag && now > rt.idleUntil) state.yaw += dt * 0.22;
  try { render(state.paused ? null : dt); } catch (e) { fail(e); return; }
  rt.fps = rt.fps * 0.93 + (1 / Math.max(dt, 1e-3)) * 0.07;
  if (rt.frames % 10 === 0) telemetry();
}

// ------------------------------------------------------------------------------------------- UI
function telemetry() {
  const v = rt.cur;
  $('tFps').textContent = Math.round(rt.fps);
  $('tParts').textContent = v ? v.parts : '—';
  $('tVoxels').textContent = v ? v.voxels.toLocaleString('en-US') : '—';
  let p = state.pitch / DEG; $('tPitch').textContent = `${p.toFixed(0)}°`;
}

function syncUI() {
  const on = (sel, attr, val) => document.querySelectorAll(sel).forEach((b) => {
    const a = b.getAttribute(attr) === String(val); b.classList.toggle('on', a); b.setAttribute('aria-pressed', a ? 'true' : 'false');
  });
  on('[data-veh]', 'data-veh', state.vehicle);
  on('[data-mode]', 'data-mode', state.mode);
  on('[data-clip]', 'data-clip', state.clip);
  on('[data-px]', 'data-px', state.r.px);
  document.querySelectorAll('[data-ropt]').forEach((b) => {
    const a = String(state.r[b.dataset.ropt]) === b.dataset.val;
    b.classList.toggle('on', a); b.setAttribute('aria-pressed', a ? 'true' : 'false');
  });
  document.querySelectorAll('[data-rpass]').forEach((b) => {
    const a = !!state.r[b.dataset.rpass]; b.classList.toggle('on', a); b.setAttribute('aria-pressed', a ? 'true' : 'false');
  });
  $('pxGroup').classList.toggle('off', !state.r.usePixelSnap);   // Pixel Snap off → the renderer forces ps = 1
  $('rendererReset').disabled = isDefault();
  const preset = Object.entries(PITCH_PRESETS).find(([, p]) => Math.abs(p - state.pitch) < 0.5 * DEG);
  on('[data-pitch]', 'data-pitch', preset ? preset[0] : '');
  $('demoModeChip').innerHTML = `<b>${tr(`mode.${state.mode}`)}</b><span>${tr(`mode.${state.mode}.sub`)}</span>`;
  $('demoModeChip').dataset.mode = state.mode;
  $('clipCaption').textContent = tr(`clip.${state.vehicle}.${state.clip}`);
  telemetry();
}

async function selectVehicle(id) {
  if (!VEHICLES.includes(id)) return;
  state.vehicle = id; syncUI();
  if (!rt.cache.has(id)) $('demoLoading').classList.remove('done');
  const v = await loadVehicle(id);
  if (state.vehicle !== id) return;
  v.t = 0; v.spring = v.ev.createSpringState();
  rt.cur = v; rt.fit = null;
  $('demoLoading').classList.add('done');
  syncUI();
}

function apply(p = {}) {
  if (p.mode && MODES[p.mode]) state.mode = p.mode;
  if (p.clip && ['idle', 'move', 'special'].includes(p.clip)) {
    state.clip = p.clip;
    if (rt.cur) { rt.cur.t = 0; rt.cur.spring = rt.cur.ev.createSpringState(); }
  }
  if (p.reset) state.r = { ...R_DEFAULTS };
  const r = state.r;
  const px = p.px ?? p.pixelScale;
  if (px != null) r.px = clamp(Math.round(+px), 1, 3);
  if (p.surface === 'crisp' || p.surface === 'smooth') r.surface = p.surface;
  if (p.raymarchSmooth != null) r.surface = p.raymarchSmooth ? 'smooth' : 'crisp';
  const bands = p.bands ?? p.celBands;
  if (bands != null && BANDS.includes(+bands)) r.bands = +bands;
  if (p.ao != null) r.useAO = !!p.ao;
  if (p.snap != null) r.usePixelSnap = !!p.snap;
  for (const k of PASSES) if (p[k] != null) r[k] = !!p[k];
  if (p.yaw != null) state.yaw = +p.yaw;
  if (p.pitch != null) state.pitch = clamp(+p.pitch, PITCH_MIN, PITCH_MAX);
  if (p.zoom != null) state.zoom = clamp(+p.zoom, 0.6, 2.6);
  if (p.autoOrbit != null) state.autoOrbit = !!p.autoOrbit;
  if (p.paused != null) state.paused = !!p.paused;
  if (p.t != null && rt.cur) rt.cur.t = +p.t;
  syncUI();
}

function wire() {
  document.querySelectorAll('[data-veh]').forEach((b) => b.addEventListener('click', () => selectVehicle(b.dataset.veh)));
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => apply({ mode: b.dataset.mode })));
  document.querySelectorAll('[data-clip]').forEach((b) => b.addEventListener('click', () => apply({ clip: b.dataset.clip })));
  document.querySelectorAll('[data-px]').forEach((b) => b.addEventListener('click', () => apply({ px: +b.dataset.px })));
  document.querySelectorAll('[data-pitch]').forEach((b) => b.addEventListener('click', () => apply({ pitch: PITCH_PRESETS[b.dataset.pitch] })));
  // Renderer options panel (always visible)
  document.querySelectorAll('[data-ropt]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.ropt, v = b.dataset.val;
    apply({ [k]: k === 'bands' ? +v : v });
  }));
  document.querySelectorAll('[data-rpass]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.rpass; apply({ [k]: !state.r[k] });
  }));
  $('rendererReset').addEventListener('click', () => apply({ reset: true }));

  const stage = $('demoStage');
  stage.addEventListener('pointerdown', (e) => {
    rt.drag = { x: e.clientX, y: e.clientY, id: e.pointerId }; rt.engaged = true;
    try { stage.setPointerCapture(e.pointerId); } catch { /* */ }
    stage.classList.add('dragging');
  });
  stage.addEventListener('pointermove', (e) => {
    if (!rt.drag || rt.drag.id !== e.pointerId) return;
    const dx = e.clientX - rt.drag.x, dy = e.clientY - rt.drag.y;
    rt.drag.x = e.clientX; rt.drag.y = e.clientY;
    state.yaw -= dx * 0.009;
    state.pitch = clamp(state.pitch + dy * 0.006, PITCH_MIN, PITCH_MAX);
    if (rt.frames % 3 === 0) syncUI();
  });
  const end = () => { if (!rt.drag) return; rt.drag = null; rt.idleUntil = performance.now() + 4000; stage.classList.remove('dragging'); syncUI(); };
  stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
  stage.addEventListener('pointerleave', () => { if (!rt.drag) rt.engaged = false; });
  stage.addEventListener('wheel', (e) => {
    if (!rt.engaged) return;                                   // page scroll is never hijacked before a click/drag
    e.preventDefault();
    state.zoom = clamp(state.zoom * Math.exp(-e.deltaY * 0.0012), 0.6, 2.6);
  }, { passive: false });
  window.addEventListener('hvs:lang', syncUI);
  new ResizeObserver(() => { if (rt.ready && state.paused) render(null); }).observe(stage);   // live loop handles the rest
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((es) => { for (const e of es) rt.visible = e.isIntersecting; }, { rootMargin: '120px' }).observe(stage);
  }
}

function fail(e) {
  rt.errors.push(String(e && e.message ? e.message : e));
  rt.ready = false;
  $('demoLoading').classList.add('done');
  $('demoFallback').hidden = false;
  console.warn('[hybrid-voxel-sprite demo] falling back to poster:', e);
}

function hasWebGL2() {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
}

async function boot() {
  const q = new URLSearchParams(location.search);
  if (q.get('vehicle') && VEHICLES.includes(q.get('vehicle'))) state.vehicle = q.get('vehicle');
  if (q.get('mode') && MODES[q.get('mode')]) state.mode = q.get('mode');
  wire(); syncUI();
  if (!hasWebGL2()) { fail(new Error('WebGL2 unavailable')); readyResolve(false); return; }
  try {
    rt.t3 = new T3Renderer($('demoCanvas'));
    resize();
    await selectVehicle(state.vehicle);
    render(null);
    rt.ready = true;
    $('demoStage').classList.add('live');
    readyResolve(true);
    requestAnimationFrame(loop);
    // warm the other three vehicles in the background so switching is instant
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 600));
    idle(async () => { for (const id of VEHICLES) { try { await loadVehicle(id); } catch (e) { rt.errors.push(`${id}: ${e.message}`); } } });
  } catch (e) { fail(e); readyResolve(false); }
}

window.__HVS_DEMO__ = {
  ready,
  async set(p = {}) { if (p.vehicle) await selectVehicle(p.vehicle); apply(p); return this.status(); },
  defaults: R_DEFAULTS,
  renderOnce() { render(null); return true; },
  status() {
    const sp = rt.cur && rt.cur.subject.parts[0];
    const u = sp && sp.u;
    const vec = (x) => [x.x, x.y, x.z].map((n) => +n.toFixed(4));
    return {
      ready: rt.ready, vehicle: state.vehicle, mode: state.mode, clip: state.clip, px: state.r.px, outline: state.r.outline,
      renderer: { ...state.r }, modified: !isDefault(),
      uniforms: u ? {
        uSmooth: u.uSmooth.value, uBands: u.uBands.value, uUseAO: u.uUseAO.value, uSelfShadow: u.uSelfShadow.value, uRim: u.uRim.value,
        uEmissiveStrength: u.uEmissiveStrength.value, uAmbient: +u.uAmbient.value.toFixed(4), uL: vec(u.uL.value),
        uLightColor: vec(u.uLightColor.value), uShadowTint: vec(u.uShadowTint.value), uHiTint: vec(u.uHiTint.value), uRimColor: vec(u.uRimColor.value),
        groundShadowVisible: sp.smesh.visible, uOutline: rt.t3.postUniforms.uOutline.value, uPS: rt.t3.postUniforms.uPS.value,
      } : null,
      yaw: state.yaw, pitchDeg: state.pitch / DEG, fps: rt.fps, frames: rt.frames, loaded: [...rt.cache.keys()],
      parts: rt.cur ? rt.cur.parts : 0, voxels: rt.cur ? rt.cur.voxels : 0, three: rt.t3 ? rt.t3.revision : null,
      glError: rt.t3 ? rt.t3.glError() : null, errors: rt.errors.slice(), canvas: [rt.canvasW, rt.canvasH],
    };
  },
};
boot();
