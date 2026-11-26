// motion_cybertruck.js — stainless wedge EV pickup procedural pose evaluator (VEHICLES_CONTRACT §5).
//
// Conventions: right-handed, +Z up, nose toward −Y, vehicle left = +X, 1 unit = 1 voxel, wheels on z = 0.
//   world = M · deform(voxel − pivot);  M is a column-major 16-array.
// Parts (builders/build_cybertruck.py): body (root), wheelFL/FR/RL/RR, tonneau, tailgate (children of body).
//   * body      = T(bodyPivot + [0, 0, lift + bob]) · Rz · Ry(roll) · Rx(pitch)   (air suspension)
//   * tonneau   = body · T(restOffset + slide·[0, −30, −7])     (vault cover retracts forward, under the roof)
//   * tailgate  = body · T(restOffset) · Rx(−drop)                                (hinged at its bottom rear edge)
//   * wheels    = T(hub) · Rz(steer) · Rx(spin)   in WORLD space, so the tyres stay planted on z = 0 while the body
//                 rides the suspension (Beast Mode lift / crouch). Rolling forward (−Y) = increasing rotX.
// Every periodic term uses whole cycles per clip; keyframed tracks start and end at rest → pose(0) == pose(T).
// No springs and no deforms (rigid hard-surface parts): useSpring / useDeform only select the neutral paths.

export const meta = {
  id: 'cybertruck',
  nameKo: '사이버트럭',
  nameEn: 'CYBERTRUCK',
  tagline: '스테인리스 웨지 · 4륜 조향 · Beast Mode 에어 서스펜션 리프트 & 볼트 커버',
  accent: '#a4dddb',
  clips: [
    { id: 'idle', label: '대기 Idle', duration: 2.4 },
    { id: 'move', label: '주행 Drive', duration: 1.5 },
    { id: 'special', label: '기믹 Action', duration: 2.6 },
  ],
};

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const frac = (v) => v - Math.floor(v);
const ease = (t) => { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };

function m4I() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
function m4Mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b0 + a[4 + r] * b1 + a[8 + r] * b2 + a[12 + r] * b3;
  }
  return o;
}
function m4T(x, y, z) { const m = m4I(); m[12] = x; m[13] = y; m[14] = z; return m; }
function m4RX(a) { const c = Math.cos(a), s = Math.sin(a), m = m4I(); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; }
function m4RY(a) { const c = Math.cos(a), s = Math.sin(a), m = m4I(); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; }
function m4RZ(a) { const c = Math.cos(a), s = Math.sin(a), m = m4I(); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; }

const NEUTRAL = Object.freeze({ shearX: 0, shearY: 0, twistZ: 0, squashZ: 1, waveAmpX: 0, waveAmpY: 0, waveFreq: 0, wavePhase: 0 });

/** Piecewise eased keyframe track over u ∈ [0, 1): keys = [[u, value], ...], first and last value equal (loop-safe). */
function track(keys, u) {
  if (u <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (u <= keys[i][0]) {
      const [u0, v0] = keys[i - 1], [u1, v1] = keys[i];
      return v0 + (v1 - v0) * ease((u - u0) / Math.max(1e-9, u1 - u0));
    }
  }
  return keys[keys.length - 1][1];
}

// special (2.6 s): rest → Beast Mode lift + vault open → hold → close + drop into the aero crouch → rest
const SP_LIFT = [[0, 0], [0.06, 0], [0.30, 4.5], [0.36, 4.75], [0.42, 4.5], [0.56, 4.5], [0.72, -1.0], [0.86, -1.0], [0.97, 0], [1, 0]];
const SP_TON = [[0, 0], [0.10, 0], [0.34, 1], [0.52, 1], [0.68, 0], [1, 0]];
const SP_GATE = [[0, 0], [0.16, 0], [0.36, 1.45], [0.40, 1.38], [0.44, 1.45], [0.50, 1.45], [0.64, 0], [1, 0]];
const SP_PITCH = [[0, 0], [0.06, 0], [0.20, -0.012], [0.32, 0.006], [0.42, 0], [0.60, 0], [0.70, 0.01], [0.78, -0.004], [0.86, 0], [1, 0]];

export function createEvaluator(rig) {
  const parts = rig.parts;
  const by = Object.fromEntries(parts.map((p) => [p.name, p]));
  const body = by.body;
  const bodyPivot = body.restOffset.slice();          // root: restOffset == world pivot
  const wheelHub = {};
  for (const n of ['wheelFL', 'wheelFR', 'wheelRL', 'wheelRR']) {
    const ro = by[n].restOffset;
    wheelHub[n] = [bodyPivot[0] + ro[0], bodyPivot[1] + ro[1], bodyPivot[2] + ro[2]];
  }
  const FRONT = new Set(['wheelFL', 'wheelFR']);

  // ---- clip functions: return { lift, pitch, roll, steerF, steerR, spin, slide, gate }
  function idle(u) {
    // air-suspension self-levelling micro-breath: settle up, then a smaller front/rear re-level
    const lift = 0.16 * (1 - Math.cos(TAU * u)) + 0.04 * Math.sin(2 * TAU * u);
    return { lift, pitch: 0.003 * Math.sin(TAU * u + 0.9), roll: 0, steerF: 0, steerR: 0, spin: 0, slide: 0, gate: 0 };
  }
  function move(u) {
    // 4-wheel steering slalom: rear wheels counter-steer at 1/3 the angle; damped terrain undulation
    const steer = 0.2 * Math.sin(TAU * u);
    const lift = 0.3 * Math.sin(2 * TAU * u) + 0.12 * Math.sin(3 * TAU * u + 1.1);
    return {
      lift, pitch: 0.009 * Math.sin(2 * TAU * u + 0.6), roll: -0.018 * Math.sin(TAU * u - 0.35),
      steerF: steer, steerR: -steer / 3, spin: TAU * 2 * u, slide: 0, gate: 0,
    };
  }
  function special(u) {
    return {
      lift: track(SP_LIFT, u), pitch: track(SP_PITCH, u), roll: 0, steerF: 0, steerR: 0, spin: 0,
      slide: track(SP_TON, u), gate: track(SP_GATE, u),
    };
  }
  const CLIPS = { idle: { fn: idle, duration: 2.4 }, move: { fn: move, duration: 1.5 }, special: { fn: special, duration: 2.6 } };

  function child(parentM, name, extra) {
    const ro = by[name].restOffset;
    return m4Mul(parentM, m4Mul(m4T(ro[0] + extra[0], ro[1] + extra[1], ro[2] + extra[2]), extra[3] || m4I()));
  }

  return {
    meta,
    createSpringState() { return {}; },
    evaluate(clipName, timeSec, dtSec = 0, springState = null, options = {}) {
      const name = CLIPS[clipName] ? clipName : 'idle';
      const clip = CLIPS[name];
      const t = Number.isFinite(timeSec) ? timeSec : 0;
      const u = frac(t / clip.duration);
      const s = clip.fn(u);
      const M = {};
      M.body = m4Mul(m4T(bodyPivot[0], bodyPivot[1], bodyPivot[2] + s.lift), m4Mul(m4RY(s.roll), m4RX(s.pitch)));
      M.tonneau = child(M.body, 'tonneau', [0, -30 * s.slide, -7 * s.slide]);
      M.tailgate = child(M.body, 'tailgate', [0, 0, 0, m4RX(-s.gate)]);
      for (const n in wheelHub) {
        const h = wheelHub[n];
        M[n] = m4Mul(m4T(h[0], h[1], h[2]), m4Mul(m4RZ(FRONT.has(n) ? s.steerF : s.steerR), m4RX(s.spin)));
      }
      const res = { clipName: name, phase: u, time: t, rootOffset: [0, 0, 0], parts: {} };
      for (const p of parts) res.parts[p.name] = { matrix: Float32Array.from(M[p.name]), deform: { ...NEUTRAL } };
      return res;
    },
  };
}

export const createMotion = createEvaluator;
