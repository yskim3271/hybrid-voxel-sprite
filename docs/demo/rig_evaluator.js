// rig_evaluator.js — pose evaluation for the T3 engine.
//
// 1. Generic rig.json evaluator: exact port of hybrid-voxel-sprite 01 §3–§4 (== svox_cli.evaluate_pose):
//      a = restOffset + (posX,posY,posZ)
//      attach = parent ? parent.M · T(deformPoint_parent(a)) : T(rootOffset + a)
//      M = attach · Rz·Ry·Rx(restRotation + rot) · [RotX(π) if flippedCloth] · S(1 + scale)
//    plus an optional spring secondary for cloth parts (01 §5 "typical drive").
// 2. Motion plugins: dynamic import of src/motions/motion_<id>.js (VEHICLES_CONTRACT.md §5) exporting
//    `meta` and `createEvaluator(rig, math)` (also accepted: `createMotion`, default export).
//    Plugin output is normalised and validated; any failure falls back to the generic evaluator with a reason.

import {
  math, TAU, DEFORM_KEYS, identityDeform, normalizeDeform, deformPoint, channelValue, wrapTime, clamp,
  mat4Mul, mat4Trans, mat4RotX, mat4RotY, mat4RotZ, mat4Scale, mat4Inv, mat4Dir, SpringVec3,
} from './math_svox.js';

export const CLIP_IDS = ['idle', 'move', 'special'];
const CLIP_ALIASES = {
  idle: ['idle', 'rest', 'breathe', 'hover', 'stand', 'engine'],
  move: ['move', 'drive', 'roll', 'run', 'walk', 'fly', 'swim', 'glide', 'swing'],
  special: ['special', 'action', 'gimmick', 'dig', 'drs', 'lift', 'attack', 'skill', 'cast', 'swing'],
};

export function partOrder(parts) {
  const by = new Map(parts.map((p) => [p.name, p]));
  const order = [], state = new Map();
  const visit = (n, chain) => {
    if (state.get(n) === 2) return;
    if (state.get(n) === 1) throw new Error(`parent cycle: ${[...chain, n].join(' -> ')}`);
    state.set(n, 1);
    const par = by.get(n).parent;
    if (par) { if (!by.has(par)) throw new Error(`part '${n}' has unknown parent '${par}'`); visit(par, [...chain, n]); }
    state.set(n, 2); order.push(n);
  };
  for (const p of parts) visit(p.name, []);
  return order;
}

/** Map the showcase clip ids (idle/move/special) onto whatever clips a rig.json actually has. */
export function resolveRigClip(rig, id) {
  const clips = rig.clips || [];
  if (!clips.length) return null;
  const exact = clips.find((c) => c.name === id);
  if (exact) return exact;
  for (const alias of CLIP_ALIASES[id] || []) { const c = clips.find((q) => q.name === alias); if (c) return c; }
  const idx = CLIP_IDS.indexOf(id);
  return clips[clamp(idx < 0 ? 0 : idx, 0, clips.length - 1)];
}

/**
 * Generic evaluator for any svox.rig/v1 rig.json. Returns the same interface as a motion plugin.
 */
export function createGenericEvaluator(rig) {
  const parts = rig.parts;
  const by = new Map(parts.map((p) => [p.name, p]));
  const order = partOrder(parts);
  const clothParts = parts.filter((p) => p.flippedCloth || p.deformRole === 'cloth').map((p) => p.name);

  function evaluateRaw(clip, t, useDeform) {
    const dur = clip ? +(clip.duration || 1) : 1;
    const vals = new Map();
    const root = [0, 0, 0];
    if (clip) {
      for (const ch of clip.channels || []) {
        const v = channelValue(ch, t, dur);
        if (ch.part === '@root') root['XYZ'.indexOf(ch.channel.slice(-1))] += v;
        else {
          if (!vals.has(ch.part)) vals.set(ch.part, {});
          const o = vals.get(ch.part); o[ch.channel] = (o[ch.channel] || 0) + v;
        }
      }
    }
    const out = { rootOffset: root, parts: {} };
    for (const name of order) {
      const p = by.get(name), v = vals.get(name) || {};
      const ro = p.restOffset || [0, 0, 0], rr = p.restRotation || [0, 0, 0];
      const local = [ro[0] + (v.posX || 0), ro[1] + (v.posY || 0), ro[2] + (v.posZ || 0)];
      let d = identityDeform();
      for (const k of DEFORM_KEYS) if (k in v) d[k] += v[k];
      if (!useDeform) d = identityDeform();
      let m;
      if (p.parent) {
        const pp = out.parts[p.parent], pv = by.get(p.parent);
        const att = deformPoint(local, pp.deform, pv.size[2], pv.pivot[2]);
        m = mat4Mul(pp.matrix, mat4Trans(att));
      } else {
        m = mat4Trans(root[0] + local[0], root[1] + local[1], root[2] + local[2]);
      }
      const r = mat4Mul(mat4RotZ(rr[2] + (v.rotZ || 0)), mat4Mul(mat4RotY(rr[1] + (v.rotY || 0)), mat4RotX(rr[0] + (v.rotX || 0))));
      m = mat4Mul(m, r);
      if (p.flippedCloth) m = mat4Mul(m, mat4RotX(Math.PI));
      const sc = 1 + (v.scale || 0);
      if (sc !== 1) m = mat4Mul(m, mat4Scale(sc));
      out.parts[name] = { matrix: m, deform: d };
    }
    return out;
  }

  // cloth secondary: spring the cloth mount's world position; the lag (in part-local axes) trails the hem
  function applyClothSprings(pose, dt, springState) {
    for (const name of clothParts) {
      const p = by.get(name), pp = pose.parts[name];
      const anchor = [pp.matrix[12], pp.matrix[13], pp.matrix[14]];
      let s = springState.cloth[name];
      if (!s) s = springState.cloth[name] = new SpringVec3(70, 9);
      const x = s.update(anchor, dt);
      const lagW = [x[0] - anchor[0], x[1] - anchor[1], x[2] - anchor[2]];
      const lagL = mat4Dir(mat4Inv(pp.matrix), lagW);
      const sz = Math.max(1, p.size[2]);
      const d = pp.deform;
      // children ride the deformed surface: recompute attach for children of the cloth part below if any
      d.shearX += clamp((lagL[0] * 2.2) / sz, -0.6, 0.6);
      d.shearY += clamp((lagL[1] * 2.2) / sz, -0.6, 0.6);
      const speed = Math.hypot(...s.v);
      d.waveAmpX += clamp(speed * 0.02, 0, 0.5);
      d.waveAmpY += clamp(speed * 0.02, 0, 0.5);
    }
  }

  const clips = CLIP_IDS.map((id) => {
    const rc = resolveRigClip(rig, id);
    return { id, label: id, duration: rc ? +(rc.duration || 1) : 1, rigClip: rc ? rc.name : null };
  });

  return {
    kind: 'rig',
    clips,
    createSpringState() { return { cloth: {} }; },
    evaluate(clipName, timeSec, dtSec, springState, options = {}) {
      const useDeform = options.useDeform !== false, useSpring = options.useSpring !== false;
      const clip = clipName === '@rest' ? null : resolveRigClip(rig, clipName);
      const t = clip ? (options.noWrap ? timeSec : wrapTime(timeSec, +(clip.duration || 1))) : 0;
      const pose = evaluateRaw(clip, t, useDeform);
      if (useSpring && useDeform && springState && clothParts.length) applyClothSprings(pose, dtSec, springState);
      pose.clipName = clip ? clip.name : '@rest';
      pose.phase = clip ? wrapTime(t, +(clip.duration || 1)) / +(clip.duration || 1) : 0;
      return pose;
    },
    restPose() { const p = evaluateRaw(null, 0, true); p.clipName = '@rest'; p.phase = 0; return p; },
  };
}

// ------------------------------------------------------------------------------------------- plugin wrapper
function toM16(m) {
  if (!m || m.length !== 16) return null;
  const o = new Float64Array(16);
  for (let i = 0; i < 16; i++) { const v = +m[i]; if (!Number.isFinite(v)) return null; o[i] = v; }
  return o;
}

/**
 * Normalise any PoseResult into { clipName, phase, rootOffset:[3], parts:{ name:{ matrix:F64[16], deform } } }.
 * Missing parts are filled from `fallbackPose` (generic evaluator) and reported.
 */
export function normalizePose(raw, rig, fallbackPose) {
  if (!raw || typeof raw !== 'object' || !raw.parts) throw new Error('evaluate() returned no parts');
  const ro = raw.rootOffset ? [+raw.rootOffset[0] || 0, +raw.rootOffset[1] || 0, +raw.rootOffset[2] || 0] : [0, 0, 0];
  const out = { clipName: raw.clipName, phase: raw.phase, rootOffset: ro, parts: {}, missing: [] };
  for (const p of rig.parts) {
    const rp = raw.parts instanceof Map ? raw.parts.get(p.name) : raw.parts[p.name];
    const m = rp ? toM16(rp.matrix) : null;
    if (!m) {
      if (rp) throw new Error(`part '${p.name}': matrix is not 16 finite numbers`);
      out.missing.push(p.name);
      const fp = fallbackPose.parts[p.name];
      out.parts[p.name] = { matrix: toM16(fp.matrix), deform: normalizeDeform(fp.deform) };
      continue;
    }
    const d = normalizeDeform(rp.deform);
    for (const k of DEFORM_KEYS) if (!Number.isFinite(d[k])) throw new Error(`part '${p.name}': deform.${k} not finite`);
    out.parts[p.name] = { matrix: m, deform: d };
  }
  return out;
}

/**
 * Loads the evaluator for a vehicle: motion plugin if present (and it works), else generic rig.json evaluator.
 * Returns { kind:'plugin'|'rig', meta, clips, reason, createSpringState, evaluate, evaluateDeterministic, restPose }.
 */
export async function loadEvaluator({ id, rig, tryPlugin = true }) {
  const generic = createGenericEvaluator(rig);
  let plugin = null, meta = null, reason = tryPlugin ? null : 'motion plugin not built yet';
  if (tryPlugin) {
    try {
      const mod = await import(new URL(`./motions/motion_${id}.js`, import.meta.url).href);
      const factory = mod.createEvaluator || mod.createMotion || (typeof mod.default === 'function' ? mod.default : null);
      if (!factory) throw new Error('module exports neither createEvaluator nor createMotion');
      meta = mod.meta || null;
      plugin = factory(rig, math);
      if (!plugin || typeof plugin.evaluate !== 'function') throw new Error('createEvaluator() returned no evaluate()');
      // smoke-test every clip once so a broken plugin is caught at load time, not mid-render
      const st = plugin.createSpringState ? plugin.createSpringState() : {};
      const clipIds = meta && Array.isArray(meta.clips) ? meta.clips.map((c) => c.id) : CLIP_IDS;
      for (const c of clipIds) normalizePose(plugin.evaluate(c, 0, 1 / 60, st, { useSpring: true, useDeform: true }), rig, generic.restPose());
    } catch (e) {
      reason = `motion plugin error: ${e && e.message ? e.message : e}`;
      plugin = null;
    }
  }

  const rest = generic.restPose();
  let clips;
  if (plugin) {
    const mc = meta && Array.isArray(meta.clips) ? meta.clips : [];
    clips = CLIP_IDS.map((cid, i) => {
      const c = mc.find((q) => q.id === cid) || mc[i] || { id: cid, duration: 2 };
      return { id: cid, pluginId: c.id, label: c.label || cid, duration: +(c.duration || 2) };
    });
  } else {
    clips = generic.clips.map((c) => ({ ...c, label: c.rigClip ? `${c.id} → ${c.rigClip}` : c.id }));
  }
  const clipMap = new Map(clips.map((c) => [c.id, c]));

  const ev = {
    kind: plugin ? 'plugin' : 'rig',
    meta, clips, reason, plugin,
    clip(id) { return clipMap.get(id) || clips[0]; },
    createSpringState() { return plugin ? (plugin.createSpringState ? plugin.createSpringState() : {}) : generic.createSpringState(); },
    /** Live evaluation (incremental springs). t is wrapped into [0, duration). */
    evaluate(clipId, t, dt, springState, options = {}) {
      const c = ev.clip(clipId);
      const tw = wrapTime(t, c.duration);
      const opts = { useSpring: options.useSpring !== false, useDeform: options.useDeform !== false };
      if (!plugin) return normalizePose(generic.evaluate(clipId, tw, dt, springState, opts), rig, rest);
      try {
        const pose = normalizePose(plugin.evaluate(c.pluginId, tw, dt, springState, opts), rig, rest);
        if (pose.phase == null) pose.phase = tw / c.duration;
        if (pose.clipName == null) pose.clipName = c.pluginId;
        return pose;
      } catch (e) {
        ev.runtimeError = `${e && e.message ? e.message : e}`;
        return normalizePose(generic.evaluate(clipId, tw, dt, generic.createSpringState(), opts), rig, rest);
      }
    },
    /**
     * Deterministic evaluation for QA: fresh spring state, 1 s pre-roll at 60 Hz, then the frame at t.
     * Identical inputs → identical pose, independent of playback history.
     */
    evaluateDeterministic(clipId, t, options = {}) {
      const st = ev.createSpringState();
      if (options.useSpring === false) return ev.evaluate(clipId, t, 0, st, options);
      const h = 1 / 60;
      for (let k = 60; k >= 1; k--) ev.evaluate(clipId, t - k * h, h, st, options);
      return ev.evaluate(clipId, t, h, st, options);
    },
    /** Un-wrapped evaluation (springs off) — used for the G4 loop-seam test pose(0) vs pose(duration). */
    evaluateUnwrapped(clipId, t, options = {}) {
      const c = ev.clip(clipId);
      const opts = { useSpring: false, useDeform: options.useDeform !== false, noWrap: true };
      if (!plugin) return normalizePose(generic.evaluate(clipId, t, 0, null, opts), rig, rest);
      return normalizePose(plugin.evaluate(c.pluginId, t, 0, ev.createSpringState(), opts), rig, rest);
    },
    restPose() { return normalizePose(rest, rig, rest); },
  };
  return ev;
}

export { TAU };
