// math_svox.js — SVOX math helpers for the T3 hybrid engine and motion plugins.
//
// Ported from hybrid-voxel-sprite references/01_contract_and_math.md (§1, §4, §5, §6).
// Conventions: right-handed, Z-up, characters face -Y, 1 unit = 1 voxel, ground z = 0.
// Matrices are column-major 16-element arrays (Float32Array returned, float64 used internally):
//   p' = (m[0]x + m[4]y + m[8]z + m[12], m[1]x + m[5]y + m[9]z + m[13], m[2]x + m[6]y + m[10]z + m[14]).
// Euler TRS = T · Rz · Ry · Rx · S  (X applied first).
//
// The exported `math` object is the one handed to `createEvaluator(rig, math)` in every
// src/motions/motion_<id>.js (VEHICLES_CONTRACT.md §5). Signatures are documented inline and in DONE_ENGINE.md.
// Every helper is tolerant: vectors may be arrays or {x,y,z}; matrices may be any 16-element array-like.

export const TAU = Math.PI * 2;
export const DEFORM_KEYS = ['shearX', 'shearY', 'twistZ', 'squashZ', 'waveAmpX', 'waveAmpY', 'waveFreq', 'wavePhase'];

// ------------------------------------------------------------------------------------------- scalars
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0 || 1e-12), 0, 1);
  return t * t * (3 - 2 * t);
}
/** Wrap t into [0, d). */
export const wrapTime = (t, d) => (d > 0 ? ((t % d) + d) % d : 0);

// ------------------------------------------------------------------------------------------- vec3
const V = (a) => (a == null ? [0, 0, 0] : Array.isArray(a) || ArrayBuffer.isView(a) ? a : [a.x || 0, a.y || 0, a.z || 0]);
export const vec3 = (x = 0, y = 0, z = 0) => (Array.isArray(x) ? [x[0], x[1], x[2]] : [x, y, z]);
export const v3Add = (a, b) => { a = V(a); b = V(b); return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; };
export const v3Sub = (a, b) => { a = V(a); b = V(b); return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; };
export const v3Scale = (a, s) => { a = V(a); return [a[0] * s, a[1] * s, a[2] * s]; };
export const v3Dot = (a, b) => { a = V(a); b = V(b); return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; };
export const v3Cross = (a, b) => {
  a = V(a); b = V(b);
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
};
export const v3Len = (a) => { a = V(a); return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); };
export const v3Norm = (a) => { a = V(a); const l = v3Len(a); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };
export const v3Lerp = (a, b, t) => { a = V(a); b = V(b); return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; };

// ------------------------------------------------------------------------------------------- mat4 (column-major)
const F = (arr) => { const o = new Float32Array(16); for (let i = 0; i < 16; i++) o[i] = arr[i]; return o; };
const I16 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export const mat4Identity = () => F(I16());

/** out = a · b */
export function mat4Mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b0 + a[4 + r] * b1 + a[8 + r] * b2 + a[12 + r] * b3;
  }
  return F(o);
}
/** Multiply any number of matrices left-to-right: mat4MulN(A, B, C) = A·B·C. */
export function mat4MulN(...ms) { let o = ms[0]; for (let i = 1; i < ms.length; i++) o = mat4Mul(o, ms[i]); return F(o); }

/** General 4x4 inverse (float64 Gauss-Jordan with partial pivoting). */
export function mat4Inv(m) {
  const a = [];
  for (let r = 0; r < 4; r++) {
    const row = [];
    for (let c = 0; c < 4; c++) row.push(+m[c * 4 + r]);
    for (let k = 0; k < 4; k++) row.push(r === k ? 1 : 0);
    a.push(row);
  }
  for (let col = 0; col < 4; col++) {
    let piv = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < 1e-14) return mat4Identity(); // singular: caller should avoid
    [a[col], a[piv]] = [a[piv], a[col]];
    const pv = a[col][col];
    for (let k = 0; k < 8; k++) a[col][k] /= pv;
    for (let r = 0; r < 4; r++) {
      if (r === col || a[r][col] === 0) continue;
      const f = a[r][col];
      for (let k = 0; k < 8; k++) a[r][k] -= f * a[col][k];
    }
  }
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r][4 + c];
  return F(o);
}

/** mat4Trans(x, y, z) or mat4Trans([x, y, z]) */
export function mat4Trans(x, y, z) {
  if (x != null && typeof x === 'object') { const v = V(x); x = v[0]; y = v[1]; z = v[2]; }
  const m = I16(); m[12] = x || 0; m[13] = y || 0; m[14] = z || 0; return F(m);
}
/** RotX(a): y' = c·y − s·z, z' = s·y + c·z */
export function mat4RotX(a) { const c = Math.cos(a), s = Math.sin(a), m = I16(); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return F(m); }
export function mat4RotY(a) { const c = Math.cos(a), s = Math.sin(a), m = I16(); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return F(m); }
export function mat4RotZ(a) { const c = Math.cos(a), s = Math.sin(a), m = I16(); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return F(m); }
/** mat4Scale(s) or mat4Scale([sx, sy, sz]) */
export function mat4Scale(s) {
  const v = typeof s === 'number' ? [s, s, s] : V(s); const m = I16(); m[0] = v[0]; m[5] = v[1]; m[10] = v[2]; return F(m);
}
/** T(t) · Rz(r.z) · Ry(r.y) · Rx(r.x) · S(s).  r = Euler XYZ radians, s = scalar or vec3 (default 1). */
export function mat4FromTRS(t = [0, 0, 0], r = [0, 0, 0], s = 1) {
  const rr = V(r);
  return mat4MulN(mat4Trans(t), mat4RotZ(rr[2]), mat4RotY(rr[1]), mat4RotX(rr[0]), mat4Scale(s == null ? 1 : s));
}
/** Columns = basis vectors x, y, z; translation = origin. */
export function mat4FromBasis(x, y, z, origin = [0, 0, 0]) {
  x = V(x); y = V(y); z = V(z); const o = V(origin);
  return F([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, o[0], o[1], o[2], 1]);
}
/** Local +Z (or −Z when negZ) points from start to end; y = normalize(refUp ⟂ z); x = cross(y, z); origin = start. */
export function mat4AlignBone(start, end, refUp = [0, -1, 0], negZ = false) {
  let z = v3Norm(v3Sub(end, start));
  if (v3Len(z) < 1e-9) z = [0, 0, 1];
  if (negZ) z = v3Scale(z, -1);
  let up = V(refUp);
  let y = v3Sub(up, v3Scale(z, v3Dot(up, z)));
  if (v3Len(y) < 1e-6) { up = Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [0, -1, 0]; y = v3Sub(up, v3Scale(z, v3Dot(up, z))); }
  y = v3Norm(y);
  const x = v3Cross(y, z);
  return mat4FromBasis(x, y, z, start);
}
export function mat4Point(m, p) {
  p = V(p);
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
}
export function mat4Dir(m, d) {
  d = V(d);
  return [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]];
}
export const mat4GetTranslation = (m) => [m[12], m[13], m[14]];

// ------------------------------------------------------------------------------------------- IK (exact 01 §5)
export function solveTwoBoneIK(rootPos, targetPos, poleDir, len1, len2) {
  rootPos = V(rootPos); targetPos = V(targetPos);
  const toT = v3Sub(targetPos, rootPos), dist = v3Len(toT);
  const d = dist > 1e-8 ? v3Scale(toT, 1 / dist) : [0, 0, -1];
  const minR = Math.abs(len1 - len2) + 1e-4, maxR = len1 + len2 - 1e-4;
  const D = clamp(dist, minR, maxR);
  const pole = poleDir ? V(poleDir) : [0, -1, 0];
  let b = v3Sub(pole, v3Scale(d, v3Dot(pole, d)));
  if (v3Len(b) < 1e-6) { const alt = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [0, -1, 0]; b = v3Sub(alt, v3Scale(d, v3Dot(alt, d))); }
  b = v3Norm(b);
  const cosA = clamp((len1 * len1 + D * D - len2 * len2) / (2 * len1 * D), -1, 1), sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const midPos = v3Add(rootPos, v3Add(v3Scale(d, len1 * cosA), v3Scale(b, len1 * sinA)));
  const endPos = v3Add(rootPos, v3Scale(d, D));
  const cosK = clamp((len1 * len1 + len2 * len2 - D * D) / (2 * len1 * len2), -1, 1);
  return {
    midPos, endPos, upperDir: v3Norm(v3Sub(midPos, rootPos)), lowerDir: v3Norm(v3Sub(endPos, midPos)),
    bendAngle: Math.PI - Math.acos(cosK), reach: D, reachable: dist >= minR && dist <= maxR,
  };
}

// ------------------------------------------------------------------------------------------- SpringVec3 (01 §5)
/**
 * Damped spring a = k·(target − x) − c·v, semi-implicit Euler in fixed sub-steps (240 Hz), dt clamped to 0.25.
 * new SpringVec3(k = 120, c = 14, initial = [0,0,0])  or  new SpringVec3({ k, c, x | initial | value })
 * spring.update(target, dt) → current position (copy). Aliases: step(), tick(). spring.reset(v?)
 */
export class SpringVec3 {
  constructor(k = 120, c = 14, initial = null) {
    if (k && typeof k === 'object' && !Array.isArray(k)) {
      const o = k;
      k = o.k ?? o.stiffness ?? 120; c = o.c ?? o.damping ?? 14; initial = o.x ?? o.initial ?? o.value ?? null;
    }
    this.k = k; this.c = c;
    this.x = initial ? [...V(initial)] : [0, 0, 0];
    this.v = [0, 0, 0];
    this.initialized = !!initial;
  }
  get value() { return this.x; }
  get position() { return this.x; }
  get velocity() { return this.v; }
  reset(v = null) { if (v) { this.x = [...V(v)]; this.initialized = true; } else this.initialized = false; this.v = [0, 0, 0]; return this; }
  update(target, dt) {
    const t = V(target);
    if (!this.initialized) { this.x = [t[0], t[1], t[2]]; this.v = [0, 0, 0]; this.initialized = true; }
    dt = clamp(+dt || 0, 0, 0.25);
    const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        this.v[k] += (this.k * (t[k] - this.x[k]) - this.c * this.v[k]) * h;
        this.x[k] += this.v[k] * h;
      }
    }
    return [this.x[0], this.x[1], this.x[2]];
  }
  step(target, dt) { return this.update(target, dt); }
  tick(target, dt) { return this.update(target, dt); }
}
/** Scalar convenience spring with the same integrator. */
export class Spring1 {
  constructor(k = 120, c = 14, x = 0) { this.k = k; this.c = c; this.x = x; this.v = 0; this.initialized = false; }
  reset(x = null) { if (x != null) { this.x = x; this.initialized = true; } else this.initialized = false; this.v = 0; return this; }
  update(target, dt) {
    if (!this.initialized) { this.x = target; this.v = 0; this.initialized = true; }
    dt = clamp(+dt || 0, 0, 0.25);
    const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n;
    for (let i = 0; i < n; i++) { this.v += (this.k * (target - this.x) - this.c * this.v) * h; this.x += this.v * h; }
    return this.x;
  }
}

// ------------------------------------------------------------------------------------------- per-slice deform (01 §6)
export const identityDeform = () => ({ shearX: 0, shearY: 0, twistZ: 0, squashZ: 1, waveAmpX: 0, waveAmpY: 0, waveFreq: 0, wavePhase: 0 });
export const neutralDeform = identityDeform;
/** Fill missing keys of a (possibly partial) deform object. */
export function normalizeDeform(d) {
  const o = identityDeform();
  if (d) for (const k of DEFORM_KEYS) if (Number.isFinite(d[k])) o[k] = d[k];
  return o;
}
export function isIdentityDeform(d) {
  return !d || (!d.shearX && !d.shearY && !d.twistZ && (d.squashZ ?? 1) === 1 && !d.waveAmpX && !d.waveAmpY);
}
export function isAffineDeform(d) {
  return !d || (Math.abs(d.twistZ || 0) < 1e-4 && Math.abs(d.waveAmpX || 0) < 1e-4 && Math.abs(d.waveAmpY || 0) < 1e-4);
}
// Argument forms accepted by deformPoint / undeformPoint:
//   (p:[x,y,z], d, sizeZ, pivotZ)             — p is pivot-relative part-local
//   (p, d, part)                              — part/volume object with size[2]|sizeZ and pivot[2]
//   (x, y, z, d, sizeZ, pivotZ)               — svox_cli.py order
function deformArgs(args) {
  let p, d, sz, pz;
  if (typeof args[0] === 'number') { p = [args[0], args[1], args[2]]; d = args[3]; sz = args[4]; pz = args[5]; }
  else { p = V(args[0]); d = args[1]; sz = args[2]; pz = args[3]; }
  if (sz && typeof sz === 'object') {
    const part = sz;
    sz = part.sizeZ ?? (part.size ? part.size[2] : 1);
    pz = part.pivotZ ?? (Array.isArray(part.pivot) ? part.pivot[2] : part.pivot ? part.pivot.z : 0);
  }
  return [p, d, sz || 1, pz || 0];
}
/** Forward deform of a pivot-relative local point → deformed local point. */
export function deformPoint(...args) {
  const [p, d, sizeZ, pivotZ] = deformArgs(args);
  const lx = p[0], ly = p[1], lz = p[2];
  if (isIdentityDeform(d)) return [lx, ly, lz];
  const sq = d.squashZ ?? 1;
  const xyS = 1 / Math.sqrt(Math.max(0.35, sq));
  const uZ = clamp((lz + pivotZ) / sizeZ, 0, 1);
  const x = lx * xyS, y = ly * xyS, z = lz * sq;
  const t = (d.twistZ || 0) * uZ, c = Math.cos(t), s = Math.sin(t);
  let rx = c * x - s * y, ry = s * x + c * y;
  rx += (d.shearX || 0) * z;
  ry += (d.shearY || 0) * z;
  const ang = uZ * (d.waveFreq || 0) + (d.wavePhase || 0);
  rx += Math.sin(ang) * (d.waveAmpX || 0) * uZ;
  ry += Math.cos(ang) * (d.waveAmpY || 0) * uZ;
  return [rx, ry, z];
}
/** Exact closed-form inverse. CPU guard |squashZ| < 1e-4 → 1e-4 (GPU clamps max(squashZ, 0.05)). */
export function undeformPoint(...args) {
  const [p, d, sizeZ, pivotZ] = deformArgs(args);
  const dx = p[0], dy = p[1], dz = p[2];
  if (isIdentityDeform(d)) return [dx, dy, dz];
  const sq = d.squashZ ?? 1;
  const xyS = 1 / Math.sqrt(Math.max(0.35, sq));
  const lz = dz / (Math.abs(sq) < 1e-4 ? 1e-4 : sq);
  const uZ = clamp((lz + pivotZ) / sizeZ, 0, 1);
  const ang = uZ * (d.waveFreq || 0) + (d.wavePhase || 0);
  let x = dx - Math.sin(ang) * (d.waveAmpX || 0) * uZ;
  let y = dy - Math.cos(ang) * (d.waveAmpY || 0) * uZ;
  x -= (d.shearX || 0) * dz;
  y -= (d.shearY || 0) * dz;
  const t = (d.twistZ || 0) * uZ, c = Math.cos(t), s = Math.sin(t);
  const ux = c * x + s * y, uy = -s * x + c * y;
  return [ux / xyS, uy / xyS, lz];
}
/** GPU-identical undeform (s = max(squashZ, 0.05)) — used by the CPU re-trace in the G1 gate. */
export function undeformPointGPU(p, d, sizeZ, pivotZ) {
  const s = Math.max(d.squashZ ?? 1, 0.05), xyS = 1 / Math.sqrt(Math.max(0.35, s));
  const lz = p[2] / s, uZ = clamp((lz + pivotZ) / sizeZ, 0, 1);
  const ang = uZ * d.waveFreq + d.wavePhase;
  let x = p[0] - Math.sin(ang) * d.waveAmpX * uZ, y = p[1] - Math.cos(ang) * d.waveAmpY * uZ;
  x -= d.shearX * p[2]; y -= d.shearY * p[2];
  const t = d.twistZ * uZ, c = Math.cos(t), sn = Math.sin(t);
  return [(c * x + sn * y) / xyS, (-sn * x + c * y) / xyS, lz];
}
/** Normal transform (inverse-transpose of the Jacobian, wave ignored): squash⁻ᵀ → twist → shear⁻ᵀ. */
export function deformNormal(n, d, uZ) {
  n = V(n);
  if (isIdentityDeform(d)) return v3Norm(n);
  const s = Math.max(d.squashZ ?? 1, 0.05), xyS = 1 / Math.sqrt(Math.max(0.35, s));
  let x = n[0] / xyS, y = n[1] / xyS, z = n[2] / s;
  const t = (d.twistZ || 0) * uZ, c = Math.cos(t), sn = Math.sin(t);
  const rx = c * x - sn * y, ry = sn * x + c * y;
  z -= (d.shearX || 0) * rx + (d.shearY || 0) * ry;
  return v3Norm([rx, ry, z]);
}

// ------------------------------------------------------------------------------------------- rig.json channels (01 §3)
/** sin: bias + amp·sin(2π·cycles·u + phase); ramp: bias + amp·cycles·u; keys: linear, wrapping at duration. */
export function channelValue(ch, t, duration) {
  const fn = ch.fn || 'sin';
  const u = duration > 0 ? t / duration : 0;
  const bias = +(ch.bias || 0), amp = +(ch.amp || 0), cyc = ch.cycles == null ? 1 : +ch.cycles;
  if (fn === 'sin') return bias + amp * Math.sin(TAU * cyc * u + +(ch.phase || 0));
  if (fn === 'ramp') return bias + amp * cyc * u;
  if (fn === 'keys') {
    const ts = ch.times, vs = ch.values;
    const tt = duration > 0 ? wrapTime(t, duration) : 0;
    if (tt <= ts[0]) return bias + vs[0];
    for (let i = 1; i < ts.length; i++) {
      if (tt <= ts[i]) { const f = (tt - ts[i - 1]) / Math.max(1e-9, ts[i] - ts[i - 1]); return bias + vs[i - 1] + (vs[i] - vs[i - 1]) * f; }
    }
    return bias + vs[vs.length - 1];
  }
  return bias;
}

// ------------------------------------------------------------------------------------------- camera / light (01 §1, 02 §5)
export const ORTHO_HEIGHT = 46;
export const PITCH_ISO = 0.58, PITCH_LOW = 0.2443;
export function cameraBasis(yaw, pitch) {
  const p = clamp(pitch, 0.05, 1.45);
  const dir = [Math.sin(yaw) * Math.cos(p), -Math.cos(yaw) * Math.cos(p), Math.sin(p)];
  const forward = v3Scale(dir, -1);
  const right = v3Norm(v3Cross(forward, [0, 0, 1]));
  const up = v3Cross(right, forward);
  return { dir, forward, right, up, pitch: p };
}
/** Light direction from azimuth/elevation (default buildLightState: az −0.75, el 0.85). */
export function lightDir(az = -0.75, el = 0.85) {
  return v3Norm([Math.sin(az) * Math.cos(el), -Math.cos(az) * Math.cos(el), Math.sin(el)]);
}
export function buildLightState(az = -0.75, el = 0.85, intensity = 1) {
  return {
    dir: lightDir(az, el), color: [1, 0.95, 0.86], intensity, ambient: 0.34,
    sky: [0.62, 0.70, 0.86], ground: [0.30, 0.26, 0.30],
    shadowTint: [0.42, 0.40, 0.66], highlightTint: [1, 0.93, 0.78],
    rimColor: [0.70, 0.85, 1.0], rimStrength: 0.45,
  };
}

/** The object passed to motion plugins: createEvaluator(rig, math). */
export const math = {
  TAU, DEFORM_KEYS,
  vec3, v3Add, v3Sub, v3Scale, v3Dot, v3Cross, v3Len, v3Norm, v3Lerp,
  mat4Identity, mat4Mul, mat4MulN, mat4Inv, mat4FromTRS, mat4FromBasis, mat4AlignBone,
  mat4RotX, mat4RotY, mat4RotZ, mat4Trans, mat4Scale, mat4Point, mat4Dir, mat4GetTranslation,
  solveTwoBoneIK, SpringVec3, Spring1,
  deformPoint, undeformPoint, deformNormal, identityDeform, neutralDeform, normalizeDeform, isIdentityDeform, isAffineDeform,
  channelValue, wrapTime, clamp, lerp, smoothstep,
};
export default math;
