// motion_mini.js — Classic Retro Mini (레트로 미니) procedural pose evaluator (clean-room, VEHICLES_CONTRACT §5).
//
// Conventions (hybrid-voxel-sprite 01_contract_and_math.md):
//   right-handed, +Z up, nose toward −Y, left side = +X, 1 unit = 1 voxel, tyres on z = 0.
//   world = M · deform(voxel − pivot);  M is column-major (16).
//
// Rig (assets/mini/rig.json): body (root, sprung shell) · wheelFL/FR/RL/RR (hub pivots, axle along X) ·
// rallyLamps (twin fog lamps on the grille) · antenna (2×2 whip, cloth role, pivot.z = 0 at its base).
//
// The wheels are NOT carried by the body: they are placed at their hubs under a shared car frame
// G = T(root) · Rz(yaw), so the sprung body can bounce, pitch and roll over planted tyres like a real
// suspension. Rolling forward (−Y) is increasing rotX; wheels turn a whole number of revolutions per clip,
// front wheels steer with rotZ (positive = nose to the left / +X). The body rolls outward on turns
// (left turn → roll toward −X). The whip antenna rides a SpringVec3 on its tip (springs only via dtSec /
// springState; useSpring=false → deterministic, no lag). Every periodic term uses whole cycles, so
// pose(0) == pose(duration).

export const meta = {
  id: 'mini',
  nameKo: '레트로 미니',
  nameEn: 'RETRO MINI',
  tagline: '클래식 해치백 · 경쾌한 서스펜션 · 랠리 보조등',
  accent: '#e8c170',
  clips: [
    { id: 'idle', label: '대기 Idle', duration: 2.2 },
    { id: 'move', label: '주행 Drive', duration: 1.4 },
    { id: 'special', label: '기믹 Action', duration: 2.2 },
  ],
};

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const frac = (v) => v - Math.floor(v);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

function m4I() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
function m4Mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b0 + a[4 + r] * b1 + a[8 + r] * b2 + a[12 + r] * b3;
  }
  return o;
}
function m4T(p) { const m = m4I(); m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; }
function m4RX(a) { const c = Math.cos(a), s = Math.sin(a), m = m4I(); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; }
function m4RY(a) { const c = Math.cos(a), s = Math.sin(a), m = m4I(); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; }
function m4RZ(a) { const c = Math.cos(a), s = Math.sin(a), m = m4I(); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; }
function m4Pt(m, p) {
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
}
function m4Inv(m) {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3], a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11], a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return m4I();
  det = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * det, (a02 * b10 - a01 * b11 - a03 * b09) * det,
    (a31 * b05 - a32 * b04 + a33 * b03) * det, (a22 * b04 - a21 * b05 - a23 * b03) * det,
    (a12 * b08 - a10 * b11 - a13 * b07) * det, (a00 * b11 - a02 * b08 + a03 * b07) * det,
    (a32 * b02 - a30 * b05 - a33 * b01) * det, (a20 * b05 - a22 * b02 + a23 * b01) * det,
    (a10 * b10 - a11 * b08 + a13 * b06) * det, (a01 * b08 - a00 * b10 - a03 * b06) * det,
    (a30 * b04 - a31 * b02 + a33 * b00) * det, (a21 * b02 - a20 * b04 - a23 * b00) * det,
    (a11 * b07 - a10 * b09 - a12 * b06) * det, (a00 * b09 - a01 * b07 + a02 * b06) * det,
    (a31 * b01 - a30 * b03 - a32 * b00) * det, (a20 * b03 - a21 * b01 + a22 * b00) * det,
  ];
}

const identityDeform = () => ({ shearX: 0, shearY: 0, twistZ: 0, squashZ: 1, waveAmpX: 0, waveAmpY: 0, waveFreq: 0, wavePhase: 0 });
const isIdentity = (d) => !d || (!d.shearX && !d.shearY && !d.twistZ && d.squashZ === 1 && !d.waveAmpX && !d.waveAmpY);
function deformPoint(p, d, sizeZ, pivotZ) {
  if (isIdentity(d)) return [p[0], p[1], p[2]];
  const sq = d.squashZ, xys = 1 / Math.sqrt(Math.max(0.35, sq)), uz = clamp((p[2] + pivotZ) / sizeZ, 0, 1);
  const x = p[0] * xys, y = p[1] * xys, z = p[2] * sq, t = d.twistZ * uz, c = Math.cos(t), s = Math.sin(t);
  let rx = c * x - s * y, ry = s * x + c * y;
  rx += d.shearX * z; ry += d.shearY * z;
  const ang = uz * d.waveFreq + d.wavePhase;
  rx += Math.sin(ang) * d.waveAmpX * uz; ry += Math.cos(ang) * d.waveAmpY * uz;
  return [rx, ry, z];
}

// SpringVec3 (01 §5): a = k·(target − x) − c·v, semi-implicit Euler, ceil(dt·240) fixed sub-steps, dt ≤ 0.25.
class SpringVec3Local {
  constructor(k = 120, c = 14) { this.k = k; this.c = c; this.x = null; this.v = [0, 0, 0]; }
  reset(target) { this.x = target ? target.slice() : null; this.v = [0, 0, 0]; }
  step(target, dt) {
    if (!this.x) { this.reset(target); return this.x; }
    dt = clamp(dt || 0, 0, 0.25);
    const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        this.v[k] += (this.k * (target[k] - this.x[k]) - this.c * this.v[k]) * h;
        this.x[k] += this.v[k] * h;
      }
    }
    return this.x;
  }
}

// Periodic key track over u ∈ [0, 1]: smoothstep between keys; first and last values equal → seamless loop.
function keys(u, times, values) {
  u = frac(u);
  for (let i = 1; i < times.length; i++) {
    if (u <= times[i]) return lerp(values[i - 1], values[i], smooth((u - times[i - 1]) / (times[i] - times[i - 1])));
  }
  return values[values.length - 1];
}
const wave = (u, cycles, phase = 0) => Math.sin(TAU * cycles * u + phase);
const cwave = (u, cycles, phase = 0) => Math.cos(TAU * cycles * u + phase);

const WHEELS = [
  { name: 'wheelFL', front: true }, { name: 'wheelFR', front: true },
  { name: 'wheelRL', front: false }, { name: 'wheelRR', front: false },
];

export function createEvaluator(rig, math = {}) { // eslint-disable-line no-unused-vars
  const parts = rig.parts;
  const by = Object.fromEntries(parts.map((p) => [p.name, p]));
  const body = by.body;
  const bodyPiv = body.restOffset.slice();                 // world pivot of the body (root)
  const hub = {};
  for (const w of WHEELS) hub[w.name] = add(bodyPiv, by[w.name].restOffset);
  const antTip = [0, 0, by.antenna.size[2] - by.antenna.pivot[2]];

  // ---------------------------------------------------------------------------------- clip drivers
  // Each returns the car-level pose: root [x,y,z], yaw, body {lift, roll, pitch, squash}, steer, spin,
  // lamp flick, antenna {lean, wave amp, wave phase}.
  function idle(u) {
    const chug = 0.16 * cwave(u, 3) + 0.06 * wave(u, 11);     // 3-cylinder-ish lumpy idle (odd cycles → moves at T/2)
    return {
      root: [0, 0, 0], yaw: 0,
      lift: 0.22 + chug, roll: 0.012 * wave(u, 1) + 0.006 * wave(u, 11, 0.7), pitch: 0.006 * cwave(u, 3, 0.6),
      squash: 1 + 0.014 * cwave(u, 3, 0.9),
      steer: 0, spin: 0, lamp: 0.03 * wave(u, 11),
      antLean: [0.03 * cwave(u, 1), 0.02 * wave(u, 1)], antAmp: 0.45 + 0.15 * cwave(u, 1), antPhase: -TAU * 2 * u,
    };
  }

  function move(u) {
    const steer = 0.22 * wave(u, 1);
    return {
      root: [-0.9 * wave(u, 1, -0.5), 0, 0], yaw: 0.07 * wave(u, 1, -0.35),
      lift: 0.3 + 0.28 * wave(u, 4) + 0.1 * wave(u, 7, 0.4),
      roll: -0.06 * wave(u, 1, -0.6),                          // outward roll lags the steering
      pitch: 0.012 * wave(u, 4, 1.1) + 0.008 * wave(u, 2),
      squash: 1 - 0.04 * wave(u, 4, 0.8),
      steer, spin: TAU * 3 * u, lamp: 0.06 * wave(u, 4, 0.5),
      antLean: [-0.14 + 0.03 * wave(u, 4), 0.05 * wave(u, 1, -1.0)], antAmp: 0.9 + 0.25 * wave(u, 2), antPhase: -TAU * 3 * u,
    };
  }

  // Rally hop & handbrake drift: rev crouch (nose lifts) → spring hop → land in a counter-steered slide with deep
  // outward roll (wheels locked) → snappy brake nose-dive → rebound → rest.
  const ST = [0, 0.12, 0.24, 0.34, 0.46, 0.6, 0.74, 0.86, 1.0];
  function special(u) {
    const k = (vals) => keys(u, ST, vals);
    return {
      root: [k([0, 0, 0, -0.4, -1.6, -2.6, -1.4, -0.3, 0]), 0, k([0, 0, 3.0, 4.6, 0, 0, 0, 0, 0])],
      yaw: k([0, -0.04, 0.16, 0.36, 0.52, 0.6, 0.26, 0.04, 0]),
      lift: k([0, -0.75, 0.7, 0.9, -0.7, -0.25, -0.45, 0.4, 0]),
      roll: k([0, 0.01, 0.0, -0.035, -0.095, -0.1, -0.04, 0.02, 0]),
      pitch: k([0, -0.05, -0.08, -0.03, 0.025, 0.0, 0.07, -0.025, 0]),
      squash: k([1, 0.92, 1.08, 1.04, 0.91, 0.96, 0.94, 1.03, 1]),
      steer: k([0, 0, 0.26, 0.16, -0.3, -0.38, -0.1, 0.02, 0]),
      spin: TAU * 2 * k([0, 0.12, 0.3, 0.42, 0.5, 0.5, 0.62, 0.84, 1.0]),   // handbrake: locked through the slide
      wheelDrop: k([0, 0, 0.6, 0.9, 0, 0, 0, 0, 0]),                     // tyres droop off the ground at the apex
      lamp: k([0, 0.06, -0.45, -0.3, 0.28, -0.1, 0.3, -0.12, 0]),
      antLean: [k([0, 0.12, -0.3, -0.2, 0.3, 0.1, 0.36, -0.1, 0]), k([0, 0, -0.06, -0.12, 0.22, 0.2, 0.05, -0.04, 0])],
      antAmp: k([0.4, 0.6, 1.2, 1.0, 1.5, 1.1, 1.3, 0.8, 0.4]), antPhase: -TAU * 3 * u,
    };
  }

  const CLIPS = { idle: { fn: idle, duration: 2.2 }, move: { fn: move, duration: 1.4 }, special: { fn: special, duration: 2.2 } };

  // ---------------------------------------------------------------------------------- pose assembly
  function build(c, useDeform, lag) {
    const G = m4Mul(m4T(c.root), m4RZ(c.yaw));
    const out = {};
    // sprung body: rotate about its pivot (centre of the wheelbase at hub height) — a low roll centre
    const Mb = m4Mul(G, m4Mul(m4T([bodyPiv[0], bodyPiv[1], bodyPiv[2] + c.lift]),
      m4Mul(m4RY(c.roll), m4RX(c.pitch))));
    const bodyDef = identityDeform();
    if (useDeform) bodyDef.squashZ = c.squash;
    out.body = { M: Mb, deform: bodyDef };
    const drop = c.wheelDrop || 0;
    for (const w of WHEELS) {
      const h = hub[w.name];
      const M = m4Mul(G, m4Mul(m4T([h[0], h[1], h[2] - drop]), m4Mul(m4RZ(w.front ? c.steer : 0), m4RX(c.spin))));
      out[w.name] = { M, deform: identityDeform() };
    }
    // children ride the (deformed, or undeformed when useDeform=false) body surface
    const attach = (name) => m4Mul(Mb, m4T(deformPoint(by[name].restOffset, bodyDef, body.size[2], body.pivot[2])));
    out.rallyLamps = { M: m4Mul(attach('rallyLamps'), m4RX(c.lamp)), deform: identityDeform() };
    const lean = c.antLean;
    const lx = lean[0] + (lag ? lag.rx : 0), ly = lean[1] + (lag ? lag.ry : 0);
    const antDef = identityDeform();
    if (useDeform) {
      antDef.waveAmpX = c.antAmp + (lag ? lag.wave : 0);
      antDef.waveAmpY = 0.4 * c.antAmp;
      antDef.waveFreq = 3.2;
      antDef.wavePhase = c.antPhase;
    }
    out.antenna = { M: m4Mul(attach('antenna'), m4Mul(m4RY(ly), m4RX(lx))), deform: antDef };
    return out;
  }

  return {
    meta,
    createSpringState() { return { tip: new SpringVec3Local(70, 7) }; },
    evaluate(clipName, timeSec, dtSec = 0, springState = null, options = {}) {
      const useSpring = options.useSpring !== false, useDeform = options.useDeform !== false;
      const name = CLIPS[clipName] ? clipName : 'idle';
      const clip = CLIPS[name];
      const t = Number.isFinite(timeSec) ? timeSec : 0;
      const u = frac(t / clip.duration);
      const c = clip.fn(u);
      let lag = null;
      if (springState && springState.tip) {
        if (useSpring) {
          const pass1 = build(c, useDeform, null);
          const target = m4Pt(pass1.antenna.M, antTip);
          const x = springState.tip.step(target, dtSec);
          const L = sub(x, target), v = springState.tip.v;
          // the tip trails behind its target: lean the whip toward the lagging tip
          lag = { rx: clamp(-L[1] * 0.05, -0.35, 0.35), ry: clamp(L[0] * 0.05, -0.35, 0.35),
            wave: clamp(Math.hypot(v[0], v[1], v[2]) * 0.01, 0, 0.6) };
        } else {
          springState.tip.reset(null);
        }
      }
      const out = build(c, useDeform, lag);
      const res = { clipName: name, phase: u, time: t, rootOffset: c.root.slice(), parts: {} };
      for (const p of parts) {
        const e = out[p.name];
        res.parts[p.name] = { matrix: Float32Array.from(e.M), invMatrix: Float32Array.from(m4Inv(e.M)), deform: { ...e.deform } };
      }
      return res;
    },
  };
}

export const createMotion = createEvaluator;
export const _internal = { deformPoint, SpringVec3Local, m4Inv, m4Mul };
