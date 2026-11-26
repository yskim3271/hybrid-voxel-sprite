// motion_excavator.js — 굴착기 (crawler excavator) procedural pose evaluator (clean-room, VEHICLES_CONTRACT §5).
//
// Conventions (hybrid-voxel-sprite 01_contract_and_math.md):
//   right-handed, +Z up, nose toward −Y, the vehicle's left is +X, 1 unit = 1 voxel, ground z = 0.
//   world = M · deform(voxel − pivot);  M is column-major (16).
//   M(part) = attach · Rz·Ry·Rx(restRotation + rot) · S(1 + scale),
//   attach  = parent.M · T(deformPoint_parent(restOffset + pos))   (children ride the parent's DEFORMED surface)
//           | T(rootOffset + restOffset + pos)                      (root part = undercarriage).
//
// Rig (builders/build_excavator.py): undercarriage → trackL/R (→ idler/sprocket wheels, X-axis cylinders),
// house (slew = rotZ on the slewing ring) → beacon, boom → stick → bucket (all three pinned on X-axis pins, authored in
// their rest world pose). Six hydraulic parts (boomCyl/boomRod twin cylinders, stickCyl/stickRod, bucketCyl/bucketRod)
// are authored along local +Z from their pin eye; every frame the barrel is re-aimed from its pin A (on the barrel's
// parent) at the rod pin B (on the rod's parent) and the rod is aimed back from B at A, so they telescope exactly.
// Barrel / rod lengths were sized by the builder over `rig.jointRanges`, which every clip stays inside.
// Every periodic term uses whole cycles per loop and wrapped phases, so pose(0) == pose(duration).

export const meta = {
  id: 'excavator',
  nameKo: '굴착기',
  nameEn: 'EXCAVATOR',
  tagline: '360° 선회 상부 · 붐/암/버킷 3관절 굴착 & 덤프 · 황색 경광등',
  accent: '#de9e41',
  clips: [
    { id: 'idle', label: '대기 Idle', duration: 2.4 },
    { id: 'move', label: '주행 Drive', duration: 1.8 },
    { id: 'special', label: '기믹 Action', duration: 2.8 }
  ]
};

// ============================================================================================ local SVOX math
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const frac = (v) => v - Math.floor(v);
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = (a) => Math.sqrt(dot(a, a));
const vnorm = (a) => { const l = vlen(a); return l > 1e-12 ? scl(a, 1 / l) : [0, 0, 0]; };

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
function m4S(s) { const m = m4I(); m[0] = m[5] = m[10] = s; return m; }
function m4Pt(m, p) {
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
}
function m4Dir(m, v) {
  return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]];
}
function m4Basis(x, y, z, t) { return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, t[0], t[1], t[2], 1]; }
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
    (a31 * b01 - a30 * b03 - a32 * b00) * det, (a20 * b03 - a21 * b01 + a22 * b00) * det
  ];
}

const DEFORM_KEYS = ['shearX', 'shearY', 'twistZ', 'squashZ', 'waveAmpX', 'waveAmpY', 'waveFreq', 'wavePhase'];
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

// Periodic key track over u ∈ [0, 1]: smoothstep between keys; first and last values are equal → seamless loop.
function keys(u, times, values) {
  u = frac(u);
  for (let i = 1; i < times.length; i++) {
    if (u <= times[i]) return lerp(values[i - 1], values[i], smooth((u - times[i - 1]) / (times[i] - times[i - 1])));
  }
  return values[values.length - 1];
}
const wave = (u, cycles, phase = 0) => Math.sin(TAU * cycles * u + phase);

function partOrder(parts) {
  const by = Object.fromEntries(parts.map((p) => [p.name, p])), order = [], seen = {};
  const visit = (n) => { if (seen[n]) return; seen[n] = 1; const par = by[n].parent; if (par) visit(par); order.push(n); };
  parts.forEach((p) => visit(p.name));
  return order;
}

// Generic SVOX composition. drive[name] = { pos, rot, scale, deform }.
function compose(by, order, root, drive, useDeform) {
  const out = {};
  for (const name of order) {
    const p = by[name], v = drive[name] || {};
    const ro = p.restOffset || [0, 0, 0], rr = p.restRotation || [0, 0, 0];
    const pos = v.pos || [0, 0, 0], rot = v.rot || [0, 0, 0];
    const a = [ro[0] + pos[0], ro[1] + pos[1], ro[2] + pos[2]];
    const d = identityDeform();
    if (useDeform && v.deform) for (const k of DEFORM_KEYS) if (v.deform[k] !== undefined) d[k] = v.deform[k];
    let attach;
    if (p.parent) {
      const pp = out[p.parent], pv = by[p.parent];
      attach = m4Mul(pp.M, m4T(deformPoint(a, pp.deform, pv.size[2], pv.pivot[2])));
    } else {
      attach = m4T(add(root, a));
    }
    let M = m4Mul(attach, m4Mul(m4RZ(rr[2] + rot[2]), m4Mul(m4RY(rr[1] + rot[1]), m4RX(rr[0] + rot[0]))));
    if (p.flippedCloth) M = m4Mul(M, m4RX(Math.PI));
    const s = 1 + (v.scale || 0);
    if (s !== 1) M = m4Mul(M, m4S(s));
    out[name] = { M, deform: d };
  }
  return out;
}

// ============================================================================================ excavator rig knowledge
const WHEELS = ['idlerL', 'idlerR', 'sprocketL', 'sprocketR'];
const TRACKS = ['trackL', 'trackR'];
const DEFAULT_HYD = [
  { barrel: 'boomCyl', rod: 'boomRod', joint: 'boom' },
  { barrel: 'stickCyl', rod: 'stickRod', joint: 'stick' },
  { barrel: 'bucketCyl', rod: 'bucketRod', joint: 'bucket' }
];
const DEFAULT_RANGES = { boom: [-0.32, 0.8], stick: [-1.0, 0.5], bucket: [-1.8, 0.75] };
// bottom-run half length of the crawler (lever for the pitch-rock ground guard) and undercarriage pivot height
const TRACK_LEVER = 31.0;

// Dig & dump cycle (special): key times + joint values (rotX deltas: boom + = lower, stick − = reach out,
// bucket − = open / + = curl) and house slew (rotZ, spec: −0.55 first, then +0.55).
//            start  slewL  reach  bite   scoop  lift   swingR dump   hold   return
const SP_T = [0, 0.11, 0.22, 0.30, 0.40, 0.50, 0.63, 0.74, 0.82, 0.91, 1.0];
const SP = {
  slew: [0, -0.55, -0.55, -0.55, -0.55, -0.45, 0.55, 0.55, 0.55, 0.15, 0],
  boom: [0, -0.05, 0.30, 0.36, 0.30, -0.22, -0.26, -0.18, -0.16, -0.04, 0],
  stick: [0, -0.15, -0.80, -0.55, 0.10, 0.25, 0.20, -0.65, -0.65, -0.20, 0],
  bucket: [0, -0.30, -1.15, -0.75, 0.55, 0.62, 0.62, -1.55, -1.55, -0.40, 0]
};
// ground guard: these parts' builder contactPoints (pin-plane silhouette extremes) must stay above GUARD_CLEAR
const GUARD_PARTS = ['bucket', 'stick', 'bucketRod'];
const GUARD_CLEAR = 1.2;   // > ~1 vx: closer contact lets the pedestal top hide tooth tips (G1 false crack)

export function createEvaluator(rig, math = {}) { // eslint-disable-line no-unused-vars
  const parts = rig.parts;
  const by = Object.fromEntries(parts.map((p) => [p.name, p]));
  const order = partOrder(parts);
  const hyd = (Array.isArray(rig.hydraulics) && rig.hydraulics.length ? rig.hydraulics : DEFAULT_HYD)
    .filter((h) => by[h.barrel] && by[h.rod]);
  const R = rig.jointRanges || DEFAULT_RANGES;
  const lim = (j, v) => clamp(v, R[j][0], R[j][1]);
  const has = (n) => !!by[n];

  // ---------------------------------------------------------------------------------------- clip drivers
  // Each returns { root, uc: rotX, slew, boom, stick, bucket, house: deform, wheel, track: deform, beacon, houseRot }
  function idle(u) {
    const rumble = wave(u, 12);                                   // ~5 Hz diesel shudder
    return {
      root: [0, 0, 0], uc: 0, slew: 0,
      houseRot: [0.0025 * wave(u, 12, 1.3), 0.003 * wave(u, 12, 0.4), 0],
      house: { squashZ: 1 + 0.009 * rumble },
      boom: 0.014 * wave(u, 1), stick: -0.02 * wave(u, 1, 0.7), bucket: 0.035 * wave(u, 1, 1.4),
      wheel: 0, track: null, beacon: TAU * 2 * frac(u)
    };
  }

  function move(u) {
    const th = 0.011 * wave(u, 2);                               // pitch rock over terrain
    const bump = 0.18 * (1 - Math.cos(TAU * 2 * u));
    const lift = TRACK_LEVER * Math.abs(Math.sin(th)) + 15 * (1 - Math.cos(th)) + bump;
    return {
      root: [0, 0, lift], uc: th, slew: 0.035 * wave(u, 1),
      houseRot: [0, 0.004 * wave(u, 2, 1.1), 0],
      house: { squashZ: 1 - 0.006 * wave(u, 4, 0.5) },
      boom: 0.045 * wave(u, 2, -0.9), stick: -0.06 * wave(u, 2, -1.5), bucket: 0.08 * wave(u, 2, -2.1),
      wheel: TAU * 3 * frac(u),                                   // 3 whole sprocket turns per loop
      track: { waveAmpY: 0.35, waveAmpX: 0.0, waveFreq: 6.0, wavePhase: -TAU * frac(3 * u) },   // tread shimmer
      beacon: TAU * 2 * frac(u)
    };
  }

  function special(u) {
    const k = (vals) => keys(u, SP_T, vals);
    const dig = keys(u, SP_T, [0, 0, 0.3, 1, 0.8, 0.2, 0, 0.3, 0, 0, 0]);   // effort → hydraulic strain shudder
    return {
      root: [0, 0, 0], uc: 0, slew: k(SP.slew),
      houseRot: [0.004 * dig * wave(u, 14), 0, 0],
      house: { squashZ: 1 - 0.012 * dig },
      boom: k(SP.boom), stick: k(SP.stick), bucket: k(SP.bucket),
      wheel: 0, track: null, beacon: TAU * 3 * frac(u)
    };
  }

  const CLIPS = { idle: { fn: idle, duration: 2.4 }, move: { fn: move, duration: 1.8 }, special: { fn: special, duration: 2.8 } };

  // ---------------------------------------------------------------------------------------- pose assembly
  const guard = GUARD_PARTS.filter((n) => by[n] && Array.isArray(by[n].contactPoints) && by[n].contactPoints.length);
  function guardLow(out) {
    let lo = Infinity;
    for (const n of guard) {
      const M = out[n].M;
      for (const q of by[n].contactPoints) lo = Math.min(lo, M[2] * q[0] + M[6] * q[1] + M[10] * q[2] + M[14]);
    }
    return lo;
  }
  // Pose + ground guard: if the arm would dig below z = GUARD_CLEAR, raise the boom (secant on the boom angle).
  // Pure function of the clip inputs → deterministic and loop-safe.
  function build(c, useDeform, lag) {
    let out = buildRaw(c, useDeform, lag, 0);
    if (!guard.length) return out;
    let lo = guardLow(out);
    if (lo >= GUARD_CLEAR) return out;
    let d0 = 0, f0 = lo - GUARD_CLEAR, d1 = -0.05;
    for (let it = 0; it < 8; it++) {
      out = buildRaw(c, useDeform, lag, d1);
      const f1 = guardLow(out) - GUARD_CLEAR;
      if (Math.abs(f1) < 1e-3 || Math.abs(f1 - f0) < 1e-9) break;
      const d2 = d1 - f1 * (d1 - d0) / (f1 - f0);
      d0 = d1; f0 = f1; d1 = clamp(d2, -1.2, 0);
    }
    if (guardLow(out) < GUARD_CLEAR - 1e-3) out = buildRaw(c, useDeform, lag, d1 - 0.002);
    return out;
  }

  function buildRaw(c, useDeform, lag, boomLift) {
    const drive = {};
    drive.undercarriage = { rot: [c.uc, 0, 0] };
    drive.house = { rot: [c.houseRot[0], c.houseRot[1], c.slew + c.houseRot[2]], deform: c.house };
    const boom = lim('boom', c.boom + boomLift), stick = lim('stick', c.stick + (lag ? lag.stick : 0));
    const bucket = lim('bucket', c.bucket + (lag ? lag.bucket : 0));
    drive.boom = { rot: [boom, 0, 0] };
    drive.stick = { rot: [stick, 0, 0] };
    drive.bucket = { rot: [bucket, 0, 0] };
    drive.beacon = { rot: [0, 0, c.beacon] };
    for (const w of WHEELS) if (has(w)) drive[w] = { rot: [c.wheel, 0, 0] };
    if (c.track) for (const t of TRACKS) if (has(t)) drive[t] = { deform: c.track };
    const out = compose(by, order, c.root, drive, useDeform);
    // hydraulics: barrel at pin A aimed at pin B, rod at pin B aimed back at A (pins are the parts' rest offsets)
    const xAxis = vnorm(m4Dir(out.house.M, [1, 0, 0]));
    for (const h of hyd) {
      const pb = by[h.barrel], pr = by[h.rod];
      const P = out[pb.parent], Q = out[pr.parent];
      const PB = by[pb.parent], QB = by[pr.parent];
      const A = m4Pt(P.M, deformPoint(pb.restOffset, P.deform, PB.size[2], PB.pivot[2]));
      const B = m4Pt(Q.M, deformPoint(pr.restOffset, Q.deform, QB.size[2], QB.pivot[2]));
      const z = vnorm(sub(B, A));
      const x = vnorm(sub(xAxis, scl(z, dot(xAxis, z))));
      out[h.barrel].M = m4Basis(x, cross(z, x), z, A);
      const zr = scl(z, -1);
      out[h.rod].M = m4Basis(x, cross(zr, x), zr, B);
      out[h.barrel].deform = identityDeform();
      out[h.rod].deform = identityDeform();
    }
    return out;
  }

  return {
    meta,
    createSpringState() { return { tip: new SpringVec3Local(70, 9) }; },
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
          // secondary motion: the bucket hinge lags behind on a soft spring → stick / bucket swing follow-through
          const pass1 = build(c, useDeform, null);
          const target = m4Pt(pass1.bucket.M, [0, 0, 0]);
          const x = springState.tip.step(target, dtSec);
          const L = sub(x, target);
          lag = { stick: clamp(L[2] * 0.02 - L[1] * 0.01, -0.08, 0.08), bucket: clamp(L[2] * 0.035, -0.12, 0.12) };
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
    }
  };
}

export const createMotion = createEvaluator;
export const _internal = { deformPoint, SpringVec3Local, m4Inv, m4Mul, keys, SP_T, SP };
