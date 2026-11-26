// motion_f1.js — F1 open-wheel racer procedural pose evaluator (clean-room, VEHICLES_CONTRACT §5).
//
// Conventions (hybrid-voxel-sprite 01_contract_and_math.md / VEHICLES_CONTRACT §3):
//   right-handed, +Z up, nose toward −Y, the car's left side is +X, 1 unit = 1 voxel, wheel bottoms on z = 0.
//   world = M · deform(voxel − pivot);  M is column-major (16 numbers).
//
// Rig (assets/f1/rig.json, builders/build_f1.py): chassis (root) + wheelFL/FR/RL/RR + helmet + drs_flap.
//   car frame C      = T(root) · Rz(yaw)                              (the whole car weaves / yaws on the treadmill)
//   wheel            = C · T(hub rest) · Rz(steer) · Rx(spin)          (wheels stay on the ground: the chassis rides on
//                                                                       its stiff suspension above them, so roll / pitch /
//                                                                       heave never push a tyre through z = 0)
//   chassis          = C · T(chassis rest + heave) · Ry(roll) · Rx(pitch)
//   helmet / flap    = chassis · T(rest offset) · R(local)              (children of the chassis)
// Rolling forward (−Y) is increasing rotX. Steering left (toward +X) is positive rotZ; the chassis rolls to the
// outside of the corner (negative rotY when turning left) and the driver leans his helmet into the apex.
// Every periodic term uses whole cycles per loop and wheels turn a whole number of revolutions per clip, so
// pose(0) == pose(duration). All deforms are neutral (rigid hard-surface car).

export const meta = {
  id: 'f1',
  nameKo: 'F1 포뮬러',
  nameEn: 'FORMULA 1',
  tagline: '니들 노즈 · 헤일로 · 슬릭 타이어 · 액티브 DRS 플랩 · 레드 레인 라이트',
  accent: '#cf573c',
  clips: [
    { id: 'idle', label: '대기 Idle', duration: 2.0 },
    { id: 'move', label: '주행 Drive', duration: 1.4 },
    { id: 'special', label: '기믹 Action', duration: 2.2 },
  ],
};

// ============================================================================================ local math
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const frac = (v) => v - Math.floor(v);
const wave = (u, cycles, phase = 0) => Math.sin(TAU * cycles * u + phase);

function m4I() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
function m4Mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b0 + a[4 + r] * b1 + a[8 + r] * b2 + a[12 + r] * b3;
  }
  return o;
}
const m4MulN = (...ms) => ms.reduce((acc, m) => m4Mul(acc, m));
function m4T(p) { const m = m4I(); m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; }
function m4RX(a) { const c = Math.cos(a), s = Math.sin(a), m = m4I(); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; }
function m4RY(a) { const c = Math.cos(a), s = Math.sin(a), m = m4I(); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; }
function m4RZ(a) { const c = Math.cos(a), s = Math.sin(a), m = m4I(); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; }
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
const neutralDeform = () => ({ shearX: 0, shearY: 0, twistZ: 0, squashZ: 1, waveAmpX: 0, waveAmpY: 0, waveFreq: 0, wavePhase: 0 });

// Periodic key track over u ∈ [0, 1]: smoothstep between keys; first and last values are equal → seamless loop.
function keys(u, times, values) {
  u = frac(u);
  for (let i = 1; i < times.length; i++) {
    if (u <= times[i]) return lerp(values[i - 1], values[i], smooth((u - times[i - 1]) / (times[i] - times[i - 1])));
  }
  return values[values.length - 1];
}

// Spring1 (01 §5 style): a = k·(target − x) − c·v, semi-implicit Euler, ceil(dt·240) fixed sub-steps, dt ≤ 0.25.
class Spring1Local {
  constructor(k = 140, c = 13) { this.k = k; this.c = c; this.x = null; this.v = 0; }
  reset(x = null) { this.x = x; this.v = 0; }
  step(target, dt) {
    if (this.x === null) { this.x = target; this.v = 0; return this.x; }
    dt = clamp(dt || 0, 0, 0.25);
    const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n;
    for (let i = 0; i < n; i++) { this.v += (this.k * (target - this.x) - this.c * this.v) * h; this.x += this.v * h; }
    return this.x;
  }
}

// ============================================================================================ F1 rig knowledge
const WHEELS = ['wheelFL', 'wheelFR', 'wheelRL', 'wheelRR'];
const FRONT = { wheelFL: true, wheelFR: true };
const DEFAULT_DRS_OPEN = -0.62;

// --- clip drivers: return { root:[3], yaw, heave, roll, pitch, steer, spin, helmet:[rx,ry,rz], drs (0..1), flutter }
function idle(u) {
  // high-revving V6 hybrid in the pit lane: tight crisp vibration + a front-wheel steering test (left ↔ right)
  const steer = 0.2 * wave(u, 1);
  return {
    root: [0, 0, 0], yaw: 0,
    heave: 0.1 + 0.07 * wave(u, 24) + 0.03 * wave(u, 38, 1.1),
    roll: 0.0035 * wave(u, 30, 0.4),
    pitch: 0.0025 * wave(u, 22, 1.7) - 0.003 * Math.pow(Math.max(0, wave(u, 2, -0.4)), 4),   // throttle blips
    steer, spin: 0,
    helmet: [0.03 * wave(u, 2, 0.9), 0.02 * wave(u, 1, 0.2), 0.16 * wave(u, 1, 0.6)],          // looks where he steers
    drs: 0, flutter: 0.004 * wave(u, 30),
  };
}

function move(u) {
  // 고속 시케인: wheels spin 3 whole turns per loop, steer left ↔ right, chassis rolls / pitches on stiff springs
  const steer = 0.2 * wave(u, 1);
  const lat = wave(u, 1, -0.5);                       // lateral load lags the steering input
  return {
    root: [0.7 * wave(u, 1, -0.9), 0, 0], yaw: 0.035 * wave(u, 1, -0.3),
    heave: 0.16 + 0.1 * wave(u, 4, 1.0),
    roll: -0.026 * lat,
    pitch: 0.005 * wave(u, 2, 0.8),
    steer, spin: TAU * 3 * u,
    helmet: [0.03 * wave(u, 2, 0.8), 0.1 * lat + 0.026 * lat, 0.08 * wave(u, 1, 0.3)],        // leans into the apex
    drs: 0, flutter: 0.006 * wave(u, 14),
  };
}

// DRS 추월 부스트: hard braking nose-dive → apex turn-in → exit squat + DRS snaps open at top speed → brake, close.
const SK = [0, 0.12, 0.25, 0.40, 0.55, 0.60, 0.72, 0.86, 0.93, 1.0];
function special(u) {
  const k = (vals) => keys(u, SK, vals);
  const N = 4, B = 2.6, PH = 0.8;                     // 4 whole turns; slowest at the apex, fastest on the DRS straight
  return {
    root: [k([0, 0, 0, 0.9, 0.5, 0.2, 0, 0, 0, 0]), 0, 0],
    yaw: k([0, 0, 0.008, 0.05, 0.018, 0.006, 0, 0, 0, 0]),
    heave: k([0.15, 0.15, -0.05, 0.05, 0.0, 0.02, 0.1, 0.15, 0.05, 0.15]),
    roll: k([0, 0, -0.004, -0.03, -0.012, -0.004, 0, 0, 0, 0]),
    pitch: k([0, 0.006, 0.02, 0.008, -0.012, -0.016, -0.015, -0.012, 0.012, 0]),
    steer: k([0, 0, 0.06, 0.3, 0.08, 0.02, 0, 0, 0, 0]),
    spin: TAU * N * u + B * Math.sin(TAU * (u - PH)),
    helmet: [k([0, 0.04, 0.16, 0.06, -0.04, -0.07, -0.06, -0.05, 0.1, 0]),
      k([0, 0, 0.03, 0.2, 0.06, 0.02, 0, 0, 0, 0]),
      k([0, 0, 0.05, 0.14, 0.02, 0, 0, 0, 0, 0])],
    drs: k([0, 0, 0, 0, 0, 1, 1, 1, 0, 0]),
    flutter: 0.02 * wave(u, 10),
  };
}

const CLIPS = {
  idle: { fn: idle, duration: 2.0 },
  move: { fn: move, duration: 1.4 },
  special: { fn: special, duration: 2.2 },
};

export function createEvaluator(rig, math = {}) { // eslint-disable-line no-unused-vars
  const parts = rig.parts;
  const by = Object.fromEntries(parts.map((p) => [p.name, p]));
  const ro = (n) => (by[n] && by[n].restOffset) || [0, 0, 0];
  const rr = (n) => (by[n] && by[n].restRotation) || [0, 0, 0];
  const chassisRest = ro('chassis');
  const drsOpen = (rig.drs && Number.isFinite(rig.drs.openRotX)) ? rig.drs.openRotX : DEFAULT_DRS_OPEN;
  const hub = {};
  for (const w of WHEELS) {
    const o = ro(w);
    hub[w] = [chassisRest[0] + o[0], chassisRest[1] + o[1], chassisRest[2] + o[2]];   // wheels are rigid children at rest
  }
  const restR = (n) => { const r = rr(n); return m4MulN(m4RZ(r[2]), m4RY(r[1]), m4RX(r[0])); };

  function build(s, lean) {
    const C = m4Mul(m4T(s.root), m4RZ(s.yaw));
    const out = {};
    const chassis = m4MulN(C, m4T([chassisRest[0], chassisRest[1], chassisRest[2] + s.heave]), restR('chassis'),
      m4RY(s.roll), m4RX(s.pitch));
    out.chassis = chassis;
    for (const w of WHEELS) {
      const steer = FRONT[w] ? s.steer : 0;
      out[w] = m4MulN(C, m4T(hub[w]), m4RZ(steer), m4RX(s.spin), restR(w));
    }
    if (by.helmet) {
      const h = s.helmet;
      out.helmet = m4MulN(chassis, m4T(ro('helmet')), restR('helmet'), m4RZ(h[2]), m4RY(h[1] + lean - s.roll), m4RX(h[0]));
    }
    if (by.drs_flap) {
      out.drs_flap = m4MulN(chassis, m4T(ro('drs_flap')), restR('drs_flap'), m4RX(drsOpen * s.drs + s.flutter * s.drs));
    }
    // any other part (future-proof): rigid child of the chassis at its rest offset
    for (const p of parts) {
      if (out[p.name]) continue;
      const parentM = p.parent && out[p.parent] ? out[p.parent] : C;
      out[p.name] = m4MulN(parentM, m4T(ro(p.name)), restR(p.name));
    }
    return out;
  }

  return {
    meta,
    createSpringState() { return { lean: new Spring1Local(120, 11), prevTarget: null }; },
    evaluate(clipName, timeSec, dtSec = 0, springState = null, options = {}) {
      const useSpring = options.useSpring !== false;
      const name = CLIPS[clipName] ? clipName : 'idle';
      const clip = CLIPS[name];
      const t = Number.isFinite(timeSec) ? timeSec : 0;
      const u = frac(t / clip.duration);
      const s = clip.fn(u);
      // secondary: the driver's head lags the chassis roll a touch (spring on the roll, dt-driven only)
      let lean = 0;
      if (springState && springState.lean) {
        if (useSpring) {
          const x = springState.lean.step(s.roll, dtSec);
          lean = clamp(0.8 * (s.roll - x), -0.08, 0.08);
        } else {
          springState.lean.reset(null);
        }
      }
      const M = build(s, lean);
      const res = { clipName: name, phase: u, time: t, rootOffset: s.root.slice(), parts: {} };
      for (const p of parts) {
        res.parts[p.name] = { matrix: M[p.name].slice(), invMatrix: m4Inv(M[p.name]), deform: neutralDeform() };
      }
      return res;
    },
  };
}

export const createMotion = createEvaluator;
export const _internal = { keys, m4Mul, m4Inv, CLIPS };
