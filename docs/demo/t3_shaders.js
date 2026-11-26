// t3_shaders.js — GLSL ES 3.00 sources for the Three.js T3 hybrid pipeline (GitHub Pages live demo copy).
// Demo additions: live view modes share one code (uDebug / uMode): 0 FINAL · 1 3D NORMALS · 3 VOLUME AO ·
// 5 SPRITE STACK. SPRITE STACK is the verified `marchStack()` (fw_renderer.js mode 2) ported into PART_FRAG: the
// part volume is decomposed into thin horizontal 2D sprite cards along local Z with real see-through air gaps.
// Adapted from sasin_threejs (Style D v2). Vehicle change: 6 emissive colour slots (uEmissiveCols[6]) so one vehicle can
// glow white headlights, amber beacons, red tail LEDs and cyan accents at once.
//
// Mirrors hybrid-voxel-sprite references/02_shader_pipeline_spec.md constant-for-constant.
// Used with THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3 }): Three prepends `#version 300 es` itself,
// so no source here starts with #version (webgl2_threejs.md §4.1, probe P4).
// MRT rule (pitfall 1 / P3): every shader drawn into the count:2 G-buffer declares location 0 AND location 1.

const PRECISION = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
`;

// ------------------------------------------------------------------------------------------- shared chunks
const RAY = /* glsl */ `
uniform mat4 uInvViewProj;
uniform vec4 uViewport;            // (x, y, w, h) of the G-buffer viewport in its own pixels
void pixelRay(out vec3 ro, out vec3 rd) {   // orthographic ray from gl_FragCoord (never from varyings)
  vec2 ndc = (gl_FragCoord.xy - uViewport.xy) / uViewport.zw * 2.0 - 1.0;
  vec4 a = uInvViewProj * vec4(ndc, -1.0, 1.0);
  vec4 b = uInvViewProj * vec4(ndc, 1.0, 1.0);
  ro = a.xyz / a.w;
  rd = normalize(b.xyz / b.w - ro);
}
`;

const VOLUME = /* glsl */ `
uniform sampler3D uVol;            // albedo: LINEAR copy (smooth) or NEAREST copy (crisp)
uniform vec3 uSize;
uniform vec3 uPivot;
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
uniform mat4 uModel;               // M'  = T(rootDelta) · M
uniform mat4 uInvModel;            // invM' = invM · T(-rootDelta)
uniform vec4 uDefA;                // shearX, shearY, twistZ, squashZ
uniform vec4 uDefB;                // waveAmpX, waveAmpY, waveFreq, wavePhase

bool slab(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax, out float t0, out float t1) {
  vec3 r = vec3(abs(rd.x) < 1e-7 ? 1e-7 : rd.x, abs(rd.y) < 1e-7 ? 1e-7 : rd.y, abs(rd.z) < 1e-7 ? 1e-7 : rd.z);
  vec3 inv = 1.0 / r;
  vec3 ta = (bmin - ro) * inv, tb = (bmax - ro) * inv;
  vec3 tmin = min(ta, tb), tmax = max(ta, tb);
  t0 = max(max(tmin.x, tmin.y), tmin.z);
  t1 = min(min(tmax.x, tmax.y), tmax.z);
  return t1 > t0 && t1 > 0.0;
}
// 01 §6 exact inverse, GPU guard s = max(squashZ, 0.05)
vec3 invDeform(vec3 d) {
  float s = max(uDefA.w, 0.05);
  float xyS = 1.0 / sqrt(max(0.35, s));
  float lz = d.z / s;
  float uZ = clamp((lz + uPivot.z) / uSize.z, 0.0, 1.0);
  float ang = uZ * uDefB.z + uDefB.w;
  float x = d.x - sin(ang) * uDefB.x * uZ;
  float y = d.y - cos(ang) * uDefB.y * uZ;
  x -= uDefA.x * d.z;
  y -= uDefA.y * d.z;
  float t = uDefA.z * uZ;
  float c = cos(t), sn = sin(t);
  vec2 u = vec2(c * x + sn * y, -sn * x + c * y);
  return vec3(u / xyS, lz);
}
vec3 toVoxel(vec3 d) { return invDeform(d) + uPivot; }
float edgeMask(vec3 v) {           // emulates zero padding under CLAMP_TO_EDGE (pitfall 4)
  vec3 lo = clamp(v + 0.5, 0.0, 1.0), hi = clamp(uSize + 0.5 - v, 0.0, 1.0);
  return lo.x * lo.y * lo.z * hi.x * hi.y * hi.z;
}
vec4 sampleSmooth(vec3 v) { return texture(uVol, v / uSize) * edgeMask(v); }
bool inGrid(ivec3 c) { return all(greaterThanEqual(c, ivec3(0))) && all(lessThan(c, ivec3(uSize))); }
float occCrisp(vec3 v) { ivec3 c = ivec3(floor(v)); return (inGrid(c) && texelFetch(uVol, c, 0).a > 0.5) ? 1.0 : 0.0; }
`;

const MODES = /* glsl */ `
uniform float uMode;               // 0 final · 1 normals · 2 depth · 3 ao · 5 sprite stack
bool isStackMode() { return uMode > 4.5 && uMode < 5.5; }
bool isAOMode() { return uMode > 2.5 && uMode < 3.5; }
bool isNormalMode() { return uMode > 0.5 && uMode < 1.5; }
float gridLine(vec2 p, float s) {  // anti-aliased 1 px drafting line (fades where it would alias)
  vec2 q = p / s, w = max(fwidth(q), vec2(1e-5));
  vec2 g = abs(fract(q - 0.5) - 0.5) / w;
  float l = 1.0 - clamp(min(g.x, g.y), 0.0, 1.0);
  return l * (1.0 - smoothstep(0.18, 0.45, max(w.x, w.y)));
}
`;

// ------------------------------------------------------------------------------------------- fullscreen vertex
export const FULLSCREEN_VERT = PRECISION + /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// ------------------------------------------------------------------------------------------- 1a clear (MRT)
// renderer.clear() would clear both attachments to one colour (P2), so a fullscreen pass writes
// C0 = background, C1 = (0.5, 0.5, 0.5, 0) and depth = 1 (AlwaysDepth + depthWrite).
export const CLEAR_FRAG = PRECISION + MODES + /* glsl */ `
uniform vec3 uBg;
uniform vec3 uBgTop;
uniform vec4 uViewport;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oNormal;
void main() {
  vec2 uv = (gl_FragCoord.xy - uViewport.xy) / uViewport.zw;
  // subtle ink-wash vertical gradient, quantised to 6 steps so it reads as pixel art
  float g = floor(smoothstep(0.15, 1.0, uv.y) * 6.0) / 6.0;
  oColor = vec4(mix(uBg, uBgTop, g), 1.0);
  if (isStackMode()) oColor.rgb = mix(vec3(0.051, 0.086, 0.141), vec3(0.075, 0.125, 0.20), g);       // blueprint
  else if (isAOMode()) oColor.rgb = mix(vec3(0.80, 0.82, 0.85), vec3(0.90, 0.91, 0.93), g);         // clay studio
  else if (isNormalMode()) oColor.rgb = mix(vec3(0.071, 0.078, 0.149), vec3(0.094, 0.102, 0.196), g); // indigo
  oNormal = vec4(0.5, 0.5, 0.5, 0.0);
  gl_FragDepth = 1.0;
}
`;

// ------------------------------------------------------------------------------------------- 1b obsidian pedestal (C0 only)
// Style D diorama base: a matte obsidian/slate disc (Apollo #1a212e top, #263042 bevel) of radius uRadius centred on the
// world origin, with a ridged cylinder side of height uPedH below z = 0, a subtle accent ring with four cardinal ticks
// (N/E/S/W) and a 2-band contact shadow at the snapped root. Everything is analytic in the exact pixel
// ray, so the base is pixel-snapped with the camera. Location 1 = (0.5,0.5,0.5,0) and the blend (SrcAlpha/OneMinusSrcAlpha,
// One/OneMinusSrcAlpha) leaves C1 (the G1 foreground mask) untouched.
export const GRID_FRAG = PRECISION + RAY + MODES + /* glsl */ `
uniform vec3 uAccent;
uniform vec3 uRoot;                // snapped root offset (world)
uniform vec2 uContactR;            // contact-shadow ellipse radii (world)
uniform float uContactA;           // contact-shadow strength (0 = off)
uniform float uRadius;             // pedestal radius (world)
uniform float uPedH;               // pedestal side height below z = 0 (world)
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oNormal;
const vec3 SLATE_TOP = vec3(0.102, 0.129, 0.180);   // #1a212e
const vec3 SLATE_HI  = vec3(0.149, 0.188, 0.259);   // #263042
const vec3 SLATE_SIDE = vec3(0.071, 0.090, 0.125);  // #12171f
const vec3 SHADOW_INK = vec3(0.039, 0.047, 0.071);  // #0a0c12
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float line1px(float v) { float w = max(fwidth(v), 1e-5); return step(abs(v) / w, 0.5); }
void main() {
  oNormal = vec4(0.5, 0.5, 0.5, 0.0);
  vec3 ro, rd; pixelRay(ro, rd);
  float Rp = uRadius;
  vec3 col;
  bool top = false;
  vec3 g = vec3(0.0);
  if (rd.z < -1e-5) { g = ro + rd * ((0.0 - ro.z) / rd.z); top = length(g.xy) <= Rp; }
  if (!top) {
    // ridged cylinder side: front-facing root of |ro.xy + t rd.xy| = Rp with z in [-uPedH, 0]
    float A = dot(rd.xy, rd.xy), B = dot(ro.xy, rd.xy), C = dot(ro.xy, ro.xy) - Rp * Rp;
    float disc = B * B - A * C;
    if (A < 1e-8 || disc < 0.0) discard;
    float t = (-B - sqrt(disc)) / A;
    vec3 s = ro + rd * t;
    if (s.z > 0.0 || s.z < -uPedH) discard;
    float ang = atan(s.y, s.x) * Rp;              // arc length (world voxels)
    float ridge = mod(floor(ang / 2.0), 2.0);
    float depth = clamp(-s.z / uPedH, 0.0, 1.0);
    col = SLATE_SIDE * mix(1.0, 0.86, ridge) * mix(1.12, 0.72, floor(depth * 3.0) / 2.0);
    col = mix(col, SLATE_HI * 0.9, step(-0.7, s.z) * 0.6);   // top lip catches the light
    if (isStackMode()) col = vec3(0.094, 0.152, 0.235) * mix(1.0, 0.86, ridge) * mix(1.05, 0.8, depth);
    else if (isAOMode()) col = vec3(0.70, 0.72, 0.75) * mix(1.0, 0.9, depth);
    else if (isNormalMode()) col = normalize(vec3(s.xy, 0.0)) * 0.5 + 0.5;
    oColor = vec4(col, 1.0);
    return;
  }
  float r = length(g.xy);
  vec2 tile = floor(g.xy / 4.0);
  col = SLATE_TOP * (0.965 + 0.07 * hash(tile));
  // bevelled lip + inner groove (1px lines in world radius)
  col = mix(col, SLATE_HI, step(Rp - 1.25, r));
  col = mix(col, SLATE_TOP * 0.72, line1px(r - (Rp - 2.6)));
  // subtle accent ring + four cardinal ticks
  float Ra = Rp * 0.80;
  float ring = line1px(r - Ra);
  float diam = 0.0;
  diam = max(diam, step(abs(g.x) + abs(g.y - Ra), 1.2));
  diam = max(diam, step(abs(g.x) + abs(g.y + Ra), 1.2));
  diam = max(diam, step(abs(g.x - Ra) + abs(g.y), 1.2));
  diam = max(diam, step(abs(g.x + Ra) + abs(g.y), 1.2));
  vec3 acc = mix(SLATE_HI, uAccent, 0.38);
  col = mix(col, acc, max(ring * 0.45, diam * 0.7));
  // contact shadow: two quantised bands around the snapped root
  if (uContactA > 0.0) {
    float dd = length((g.xy - uRoot.xy) / max(uContactR, vec2(0.5)));
    float cs = dd < 0.62 ? 1.0 : (dd < 1.0 ? 0.55 : 0.0);
    col = mix(col, SHADOW_INK, uContactA * cs);
  }
  if (isStackMode()) {
    // blueprint drafting ground: crisp cyan world grid (8 vx minor, 32 vx major) + accent ring
    vec3 bp = mix(vec3(0.075, 0.125, 0.20), vec3(0.11, 0.18, 0.28), step(Rp - 1.25, r));
    bp = mix(bp, vec3(0.165, 0.36, 0.54), gridLine(g.xy, 8.0) * 0.55);
    bp = mix(bp, vec3(0.27, 0.55, 0.78), max(gridLine(g.xy, 32.0) * 0.8, ring * 0.7));
    if (uContactA > 0.0 && length((g.xy - uRoot.xy) / max(uContactR, vec2(0.5))) < 1.0) bp *= 1.0 - 0.35 * uContactA;
    col = bp;
  } else if (isAOMode()) {
    float dd = length((g.xy - uRoot.xy) / max(uContactR * 1.25, vec2(0.5)));
    col = vec3(0.86, 0.87, 0.89) * mix(0.62, 1.0, smoothstep(0.35, 1.25, dd)) * mix(1.0, 0.93, ring);
  } else if (isNormalMode()) {
    col = vec3(0.5, 0.5, 1.0) * mix(1.0, 0.82, ring);
  }
  oColor = vec4(col, 1.0);
}
`;

// ------------------------------------------------------------------------------------------- 1c ground shadow (C0 only)
export const SHADOW_VERT = PRECISION + /* glsl */ `
in vec3 position;                  // unit quad [0,1]^2
uniform mat4 uViewProj;
uniform vec2 uRectMin;
uniform vec2 uRectMax;
void main() {
  vec3 p = vec3(mix(uRectMin, uRectMax, position.xy), 0.02);
  gl_Position = uViewProj * vec4(p, 1.0);
}
`;

export const SHADOW_FRAG = PRECISION + RAY + VOLUME + /* glsl */ `
uniform mat4 uViewProj;
uniform vec3 uL;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oNormal;
void main() {
  oNormal = vec4(0.5, 0.5, 0.5, 0.0);
  vec3 roW, rdW; pixelRay(roW, rdW);
  if (abs(rdW.z) < 1e-5) discard;
  vec3 g = roW + rdW * ((0.02 - roW.z) / rdW.z);   // exact ground point: identical for every part
  vec3 Lw = normalize(vec3(uL.xy, max(uL.z, 0.12)));
  vec3 ro = (uInvModel * vec4(g, 1.0)).xyz;
  vec3 rd = normalize(mat3(uInvModel) * Lw);
  float t0, t1;
  if (!slab(ro, rd, uBoxMin, uBoxMax, t0, t1)) discard;
  float occ = 0.0;
  float t = max(t0, 0.0) + 0.2;
  for (int i = 0; i < 240; i++) {        // 240 x 0.6 vx: long low-angle rays of 84-96 vx vehicles / booms
    if (t > t1) break;
    occ = max(occ, smoothstep(0.3, 0.6, sampleSmooth(toVoxel(ro + rd * t)).a));
    if (occ > 0.99) break;
    t += 0.6;
  }
  if (occ < 0.5) discard;
  vec4 c = uViewProj * vec4(g, 1.0);
  gl_FragDepth = 0.5 * c.z / c.w + 0.5;             // same depth for every part → first part wins (LESS)
  oColor = vec4(0.035, 0.03, 0.075, 0.5);
}
`;

// ------------------------------------------------------------------------------------------- 1d part OBB raymarch (MRT)
export const PART_VERT = PRECISION + /* glsl */ `
in vec3 position;                  // unit cube [0,1]^3
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
void main() {
  vec3 p = mix(uBoxMin, uBoxMax, position);
  gl_Position = uViewProj * uModel * vec4(p, 1.0);
}
`;

export const PART_FRAG = PRECISION + RAY + VOLUME + /* glsl */ `
uniform mat4 uViewProj;
uniform sampler3D uNao;            // normal/AO volume (texelFetch only)
uniform float uSmooth;             // 1 = smooth iso march (LINEAR), 0 = crisp
uniform float uAffine;             // 1 = no twist/wave → exact DDA allowed in crisp mode
// light (02 §5 buildLightState)
uniform vec3 uL;
uniform vec3 uLightColor;
uniform float uAmbient;
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uShadowTint;
uniform vec3 uHiTint;
uniform vec3 uRimColor;
uniform float uRimStrength;
// toggles
uniform float uLit;
uniform float uBands;              // 0 = smooth shading, 2..8 = cel
uniform float uUseAO;
uniform float uSelfShadow;
uniform float uRim;
uniform float uDebug;              // 0 final, 1 normals, 3 ao, 4 slices (2 = depth is done in post)
uniform float uDepthSlot;          // part index (0 … uDepthSlots-1): exact, draw-order-independent depth tie-break
uniform float uDepthSlots;         // power of two ≥ part count (min 16); bucket = 4·uDepthSlots D24 steps
uniform float uHeightOccSpan;      // world z over which ground-contact darkening fades (max(7, hz·0.22))
// emissive accents (optional rig.json fields; colour only, never mask/depth → G1–G4 invariant)
uniform float uPartEmissive;       // part.emissive 0..1
uniform int uEmissiveCount;        // number of valid rig.emissiveColors (≤ 6)
uniform vec3 uEmissiveCols[6];     // e.g. #f4f7fb headlights · #f5a15d beacons · #e83b3b tail LEDs · #a4dddb accents
uniform float uEmissiveStrength;   // rig.emissiveStrength (default 0.90)
uniform float uVehH;               // vehicle height (world voxels): SPRITE STACK layer ramp
layout(location = 0) out vec4 oColor;    // a = 1 - 0.5·emissive (POST keeps glowing texels out of the ink)
layout(location = 1) out vec4 oNormal;

vec3 faceNormal(vec3 v, vec3 dir) {               // closest integer plane, facing against the ray
  vec3 f = abs(v - floor(v + 0.5));
  if (f.x <= f.y && f.x <= f.z) return vec3(dir.x > 0.0 ? -1.0 : 1.0, 0.0, 0.0);
  if (f.y <= f.z) return vec3(0.0, dir.y > 0.0 ? -1.0 : 1.0, 0.0);
  return vec3(0.0, 0.0, dir.z > 0.0 ? -1.0 : 1.0);
}
float density(vec3 pd) { vec3 v = toVoxel(pd); return uSmooth > 0.5 ? sampleSmooth(v).a : occCrisp(v); }
vec3 deformNormal(vec3 n, float uZ) {             // squash^-T → twist → shear^-T (01 §6)
  float s = max(uDefA.w, 0.05);
  float xyS = 1.0 / sqrt(max(0.35, s));
  n = vec3(n.x / xyS, n.y / xyS, n.z / s);
  float t = uDefA.z * uZ;
  float c = cos(t), sn = sin(t);
  n.xy = vec2(c * n.x - sn * n.y, sn * n.x + c * n.y);
  n.z -= uDefA.x * n.x + uDefA.y * n.y;
  return normalize(n);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

// exact 3D DDA (Amanatides–Woo) in undeformed voxel space; valid only for affine deforms
bool marchDDA(vec3 ro, vec3 rd, float t0, float t1, out float th, out vec3 nV) {
  nV = vec3(0.0, 0.0, 1.0); th = 0.0;
  vec3 oV = toVoxel(ro);
  vec3 dV = toVoxel(ro + rd) - oV;                // same t parameter as the deformed ray
  float a0, a1;
  if (!slab(oV, dV, vec3(0.0), uSize, a0, a1)) return false;
  a0 = max(a0, t0); a1 = min(a1, t1);
  if (a1 <= a0) return false;
  vec3 p = oV + dV * (a0 + 1e-4);
  ivec3 isz = ivec3(uSize);
  ivec3 cell = clamp(ivec3(floor(p)), ivec3(0), isz - 1);
  ivec3 st = ivec3(dV.x > 0.0 ? 1 : (dV.x < 0.0 ? -1 : 0), dV.y > 0.0 ? 1 : (dV.y < 0.0 ? -1 : 0), dV.z > 0.0 ? 1 : (dV.z < 0.0 ? -1 : 0));
  vec3 tMax, tDelta;
  for (int k = 0; k < 3; k++) {
    float d = dV[k];
    if (abs(d) < 1e-9) { tMax[k] = 1e30; tDelta[k] = 1e30; }
    else {
      float bound = d > 0.0 ? float(cell[k] + 1) : float(cell[k]);
      tMax[k] = (bound - oV[k]) / d;
      tDelta[k] = abs(1.0 / d);
    }
  }
  nV = faceNormal(p, dV);
  float tCur = a0;
  for (int i = 0; i < 400; i++) {
    if (tCur > a1 + 1e-4) break;
    if (!inGrid(cell)) break;
    if (texelFetch(uVol, cell, 0).a > 0.5) { th = tCur; return true; }
    if (tMax.x < tMax.y && tMax.x < tMax.z) { cell.x += st.x; tCur = tMax.x; tMax.x += tDelta.x; nV = vec3(-float(st.x), 0.0, 0.0); }
    else if (tMax.y < tMax.z) { cell.y += st.y; tCur = tMax.y; tMax.y += tDelta.y; nV = vec3(0.0, -float(st.y), 0.0); }
    else { cell.z += st.z; tCur = tMax.z; tMax.z += tDelta.z; nV = vec3(0.0, 0.0, -float(st.z)); }
  }
  return false;
}

// ---- SPRITE STACK (uDebug 5, ported from fw_renderer.js marchStack mode 2). Pitch P = 2 (uSize.z >= 18) or 1:
//   P = 1: card [z + 0.24, z + 0.76]          (0.52 card / 0.48 gap)
//   P >= 2: card [kP + 0.15, kP + 0.15 + 0.4P] (P = 2: 0.80 card / 1.20 gap)
// A voxel that lies only in a gap still gets a thin 0.45 card, so 1-voxel roofs, wings and antennas never vanish.
float stackP() { return uSize.z >= 18.0 ? 2.0 : 1.0; }
void stackCardOf(float P, out float c0, out float T) { if (P < 1.5) { c0 = 0.24; T = 0.52; } else { c0 = 0.15; T = 0.4 * P; } }
bool occAt(ivec3 c) { return inGrid(c) && texelFetch(uVol, c, 0).a > 0.5; }
vec2 cardSpan(ivec3 c, float P, float c0, float T) {
  float z0 = float(c.z), lo = floor(z0 / P) * P + c0, hi = lo + T;
  float clo = max(lo, z0), chi = min(hi, z0 + 1.0);
  if (chi > clo) return vec2(clo, chi);
  for (int j = 0; j < 4; j++) {                      // thin-detail rescue: anything of this column inside the card?
    float zz = floor(lo) + float(j);
    if (zz >= hi) break;
    if (occAt(ivec3(c.xy, int(zz)))) return vec2(1.0, 0.0);
  }
  return vec2(z0 + 0.275, z0 + 0.725);
}
bool marchStack(vec3 ro, vec3 rd, float t0, float t1, out float th, out vec3 nV, out ivec3 hc) {
  nV = vec3(0.0, 0.0, 1.0); th = 0.0; hc = ivec3(0);
  vec3 oV = toVoxel(ro);
  vec3 dV = toVoxel(ro + rd) - oV;
  float a0, a1;
  if (!slab(oV, dV, vec3(0.0), uSize, a0, a1)) return false;
  a0 = max(a0, t0); a1 = min(a1, t1);
  if (a1 <= a0) return false;
  float P = stackP(), c0, T; stackCardOf(P, c0, T);
  vec3 p = oV + dV * (a0 + 1e-4);
  ivec3 isz = ivec3(uSize);
  ivec3 cell = clamp(ivec3(floor(p)), ivec3(0), isz - 1);
  ivec3 st = ivec3(dV.x > 0.0 ? 1 : (dV.x < 0.0 ? -1 : 0), dV.y > 0.0 ? 1 : (dV.y < 0.0 ? -1 : 0), dV.z > 0.0 ? 1 : (dV.z < 0.0 ? -1 : 0));
  vec3 tMax, tDelta;
  for (int k = 0; k < 3; k++) {
    float d = dV[k];
    if (abs(d) < 1e-9) { tMax[k] = 1e30; tDelta[k] = 1e30; }
    else { float bound = d > 0.0 ? float(cell[k] + 1) : float(cell[k]); tMax[k] = (bound - oV[k]) / d; tDelta[k] = abs(1.0 / d); }
  }
  nV = faceNormal(p, dV);
  float tCur = a0;
  for (int i = 0; i < 520; i++) {
    if (tCur > a1 + 1e-4) break;
    if (!inGrid(cell)) break;
    float tNext = min(min(tMax.x, tMax.y), tMax.z);
    if (texelFetch(uVol, cell, 0).a > 0.5) {
      vec2 cs = cardSpan(cell, P, c0, T);
      if (cs.y > cs.x) {
        float e0 = tCur, e1 = tNext;
        if (abs(dV.z) < 1e-7) { float z = oV.z + dV.z * tCur; if (z < cs.x || z > cs.y) e1 = e0 - 1.0; }
        else { float u0 = (cs.x - oV.z) / dV.z, u1 = (cs.y - oV.z) / dV.z; e0 = max(e0, min(u0, u1)); e1 = min(e1, max(u0, u1)); }
        if (e0 <= e1) {
          th = e0; hc = cell;
          if (e0 > tCur + 1e-5) nV = vec3(0.0, 0.0, dV.z > 0.0 ? -1.0 : 1.0);      // through the card's top / bottom face
          return true;
        }
      }
    }
    if (tMax.x < tMax.y && tMax.x < tMax.z) { cell.x += st.x; tCur = tMax.x; tMax.x += tDelta.x; nV = vec3(-float(st.x), 0.0, 0.0); }
    else if (tMax.y < tMax.z) { cell.y += st.y; tCur = tMax.y; tMax.y += tDelta.y; nV = vec3(0.0, -float(st.y), 0.0); }
    else { cell.z += st.z; tCur = tMax.z; tMax.z += tDelta.z; nV = vec3(0.0, 0.0, -float(st.z)); }
  }
  return false;
}
float occStack(vec3 v) {                             // non-affine (wave / twist) parts: point occupancy of the cards
  ivec3 c = ivec3(floor(v));
  if (!occAt(c)) return 0.0;
  float P = stackP(), c0, T; stackCardOf(P, c0, T);
  vec2 cs = cardSpan(c, P, c0, T);
  return v.z >= cs.x && v.z <= cs.y ? 1.0 : 0.0;
}

void main() {
  vec3 roW, rdW; pixelRay(roW, rdW);
  vec3 ro = (uInvModel * vec4(roW, 1.0)).xyz;
  vec3 rd = mat3(uInvModel) * rdW;
  rd /= length(rd);                               // renormalise: matrices may be scaled (pitfall 6)
  float t0, t1;
  if (!slab(ro, rd, uBoxMin, uBoxMax, t0, t1)) discard;
  t0 = max(t0, 0.0);
  bool stack = uDebug > 4.5 && uDebug < 5.5;
  bool smoothMode = uSmooth > 0.5 && !stack;
  bool hit = false;
  bool ddaHit = false;
  float th = 0.0;
  vec3 ddaN = vec3(0.0, 0.0, 1.0);
  ivec3 hc = ivec3(0);
  if (stack && uAffine > 0.5) {
    hit = marchStack(ro, rd, t0, t1, th, ddaN, hc);
    ddaHit = hit;
  } else if (stack) {
    float tPrev = t0;
    for (int i = 0; i < 1100; i++) {
      float t = t0 + float(i) * 0.22;
      if (t > t1) break;
      if (occStack(toVoxel(ro + rd * t)) >= 0.5) {
        float lo = tPrev, hi = t;
        for (int k = 0; k < 6; k++) { float m = 0.5 * (lo + hi); if (occStack(toVoxel(ro + rd * m)) >= 0.5) hi = m; else lo = m; }
        th = hi; hit = true; break;
      }
      tPrev = t;
    }
  } else if (!smoothMode && uAffine > 0.5) {
    hit = marchDDA(ro, rd, t0, t1, th, ddaN);
    ddaHit = hit;
  } else {
    float STEP = smoothMode ? 0.35 : 0.4;
    float ISO = smoothMode ? 0.45 : 0.5;
    float tPrev = t0;
    for (int i = 0; i < 600; i++) {
      float t = t0 + float(i) * STEP;
      if (t > t1) break;
      if (density(ro + rd * t) >= ISO) {
        float lo = tPrev, hi = t;
        for (int k = 0; k < 6; k++) {
          float m = 0.5 * (lo + hi);
          if (density(ro + rd * m) >= ISO) hi = m; else lo = m;
        }
        th = hi; hit = true;
        break;
      }
      tPrev = t;
    }
  }
  if (!hit) discard;

  vec3 hd = ro + rd * th;
  vec3 hv = toVoxel(hd);
  vec3 wp = (uModel * vec4(hd, 1.0)).xyz;
  vec4 clipP = uViewProj * vec4(wp, 1.0);
  // exact depth → order-independent occlusion. Coplanar / coincident joint surfaces shared by two parts would tie
  // in the 24-bit depth buffer, and a tie resolves by draw order (LEQUAL: later wins). A constant per-part bias
  // only makes ties rarer (QA sweep: ~4% of renders still differed by 9–27 px). Instead the depth is quantised
  // into buckets of 4·uDepthSlots D24 steps and the part index is written into the low bits (centre of a 4-step
  // slot, so float→UNORM24 rounding can never cross slots). Two parts can then never produce equal depths:
  // within one bucket the lower part index always wins, independent of draw order. Bucket = 64 steps ≈ 4e-6 NDC.
  const float D24 = 16777215.0;
  float dRaw = clamp(0.5 * clipP.z / clipP.w + 0.5, 0.0, 1.0);
  float bucket = 4.0 * uDepthSlots;
  float q = floor(dRaw * (D24 / bucket));
  gl_FragDepth = min((q * bucket + uDepthSlot * 4.0 + 2.0) / D24, 1.0);

  // ---- surface attributes (02 §4)
  vec3 rdV = toVoxel(hd + rd * 0.05) - hv;
  ivec3 cin = ivec3(floor(toVoxel(hd + rd * 0.3)));
  if (!inGrid(cin) || texelFetch(uVol, cin, 0).a < 0.5) cin = ivec3(floor(hv - faceNormal(hv, rdV) * 0.5));
  if (stack) cin = ddaHit ? hc : ivec3(floor(hv + vec3(0.0, 0.0, rdV.z > 0.0 ? 1e-3 : -1e-3)));
  cin = clamp(cin, ivec3(0), ivec3(uSize) - 1);
  vec4 vin = texelFetch(uVol, cin, 0);
  vec4 nao = texelFetch(uNao, cin, 0);
  vec3 nTex = nao.rgb * 2.0 - 1.0;
  bool texOk = vin.a > 0.5 && dot(nTex, nTex) > 0.25;
  vec3 albedo;
  vec3 Nv;
  if (smoothMode) {
    vec4 cs = sampleSmooth(hv + normalize(rdV) * 0.35);
    albedo = vin.a > 0.5 ? vin.rgb : clamp(cs.rgb / max(cs.a, 1e-3), 0.0, 1.0);
    float h = 0.6;
    vec3 grad = vec3(
      sampleSmooth(hv + vec3(h, 0.0, 0.0)).a - sampleSmooth(hv - vec3(h, 0.0, 0.0)).a,
      sampleSmooth(hv + vec3(0.0, h, 0.0)).a - sampleSmooth(hv - vec3(0.0, h, 0.0)).a,
      sampleSmooth(hv + vec3(0.0, 0.0, h)).a - sampleSmooth(hv - vec3(0.0, 0.0, h)).a);
    vec3 nG = dot(grad, grad) > 1e-10 ? -normalize(grad) : -normalize(rdV);
    Nv = texOk ? normalize(0.45 * nG + 0.55 * nTex) : nG;
  } else {
    albedo = vin.rgb;
    Nv = ddaHit ? ddaN : faceNormal(hv, rdV);
    if (stack && !ddaHit) {                       // wave-deformed part: card top / bottom plane vs card side
      float P = stackP(), c0, T; stackCardOf(P, c0, T);
      vec2 cs = cardSpan(cin, P, c0, T);
      if (abs(hv.z - cs.y) < 0.08) Nv = vec3(0.0, 0.0, 1.0);
      else if (abs(hv.z - cs.x) < 0.08) Nv = vec3(0.0, 0.0, -1.0);
      else { vec3 fn = faceNormal(vec3(hv.xy, floor(hv.z) + 0.5), rdV); Nv = abs(fn.z) > 0.5 ? vec3(0.0, 0.0, 1.0) : fn; }
    }
    if (!stack) Nv = texOk ? normalize(mix(Nv, nTex, 0.3)) : Nv;
  }
  float ao = texOk ? smoothstep(0.1, 0.92, nao.a) : 1.0;
  float uZ = clamp(hv.z / uSize.z, 0.0, 1.0);
  vec3 N = normalize(transpose(mat3(uInvModel)) * deformNormal(Nv, uZ));

  // ---- lighting (02 §5)
  vec3 L = normalize(uL);
  vec3 V = -rdW;
  float shadowF = 1.0;
  if (uSelfShadow > 0.5) {
    vec3 Ld = normalize(mat3(uInvModel) * L);
    vec3 q = hd - rd * 0.25 + Ld * 0.9;
    float occ = 0.0;
    for (int i = 0; i < 12; i++) {
      occ = max(occ, smoothstep(0.35, 0.7, sampleSmooth(toVoxel(q)).a) * (1.0 - float(i) * 0.03));
      q += Ld * 1.15;
    }
    shadowF = 1.0 - occ;
  }
  float heightOcc = mix(0.74, 1.0, smoothstep(0.0, max(uHeightOccSpan, 1.0), wp.z));
  float diff = max(dot(N, L), 0.0) * shadowF;
  float aoF = uUseAO > 0.5 ? ao : 1.0;
  vec3 col;
  float b = uBands >= 2.0 ? min(floor(uBands + 0.5), 8.0) : 0.0;
  if (uLit < 0.5) {
    col = albedo * (0.8 + 0.2 * clamp(wp.z / 30.0, 0.0, 1.0)) * mix(0.62, 1.0, aoF);
  } else if (b >= 2.0) {
    float qb = clamp(floor(diff * b * 0.999 + 0.0001 + 0.15) / (b - 1.0), 0.0, 1.0);
    vec3 shadowCol = albedo * uShadowTint * (0.62 + uAmbient * 0.9) + vec3(0.012, 0.008, 0.03);
    vec3 litCol = albedo * mix(vec3(1.0), uHiTint, 0.45) * mix(vec3(1.0), uLightColor, 0.6) * 1.12;
    col = mix(shadowCol, litCol, qb) * mix(0.6, 1.0, floor(aoF * heightOcc * 4.0 + 0.5) / 4.0);
    if (qb > 0.99 && pow(max(dot(N, normalize(L + V)), 0.0), 40.0) > 0.7) col += litCol * 0.09;
    if (uRim > 0.5) col += uRimColor * uRimStrength * 0.55 * step(0.45, pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.5) *
                      clamp(0.3 + 0.7 * dot(N, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0, 1.0));
  } else {
    vec3 hemi = mix(uGround, uSky, N.z * 0.5 + 0.5);
    col = albedo * (hemi * uAmbient * 1.6 * mix(0.45, 1.0, aoF) * heightOcc + uLightColor * diff * 0.95)
        + uLightColor * pow(max(dot(N, normalize(L + V)), 0.0), 32.0) * 0.22 * shadowF;
    col = mix(col, col * uShadowTint * 1.6, (1.0 - diff) * 0.25);
    if (uRim > 0.5) col += uRimColor * uRimStrength * 0.8 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0) *
                      clamp(0.35 + 0.65 * dot(N, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0, 1.0);
  }
  // ---- emissive accents: glowing texels are lifted out of AO / cel shadow (deterministic, colour only)
  float em = 0.0;
  if (uDebug < 0.5) {
    em = uPartEmissive;
    for (int k = 0; k < 6; k++) {
      if (k >= uEmissiveCount) break;
      if (length(albedo - uEmissiveCols[k]) < 0.048) em = max(em, uEmissiveStrength);
    }
    em = clamp(em, 0.0, 1.0);
    if (em > 0.01) col = mix(col, min(albedo * 1.25 + vec3(0.03), vec3(1.0)), em);
  }
  if (uDebug > 0.5 && uDebug < 1.5) col = N * 0.5 + 0.5;
  else if (uDebug > 2.5 && uDebug < 3.5) col = vec3(ao * heightOcc * mix(0.55, 1.0, shadowF));
  else if (stack) {
    // authentic sprite-sheet shading: flat vivid voxel albedo x height-ordered layer ramp (lower cards cooler / deeper,
    // upper cards brighter), bright card tops, 0.78x card sides, alternate-card tone and a 1-voxel silhouette border
    float P = stackP();
    float hN = clamp(wp.z / max(uVehH, 1.0), 0.0, 1.0);
    float layer = floor(float(cin.z) / P);
    float lum = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
    vec3 alb = mix(albedo, vec3(0.20, 0.25, 0.32), (1.0 - smoothstep(0.04, 0.22, lum)) * 0.55);
    vec3 base = alb * mix(0.68, 1.12, hN) * mix(vec3(0.84, 0.92, 1.08), vec3(1.0), smoothstep(0.0, 0.75, hN));
    base *= mod(layer, 2.0) < 0.5 ? 1.0 : 0.90;
    float c0, T; stackCardOf(P, c0, T);
    vec2 cs = cardSpan(cin, P, c0, T);
    float fz = clamp((hv.z - cs.x) / max(cs.y - cs.x, 1e-3), 0.0, 1.0);
    if (Nv.z > 0.5) {
      vec2 f = hv.xy - vec2(cin.xy);
      float edge = 0.0;
      if (f.x < 0.24 && !occAt(cin + ivec3(-1, 0, 0))) edge = 1.0;
      if (f.x > 0.76 && !occAt(cin + ivec3(1, 0, 0))) edge = 1.0;
      if (f.y < 0.24 && !occAt(cin + ivec3(0, -1, 0))) edge = 1.0;
      if (f.y > 0.76 && !occAt(cin + ivec3(0, 1, 0))) edge = 1.0;
      col = mix(base * 1.04, min(base * 1.45 + vec3(0.10, 0.13, 0.16), vec3(1.0)), edge);
    } else if (Nv.z < -0.5) col = base * 0.80 * vec3(0.92, 0.96, 1.06);
    else col = fz > 0.62 ? min(base * 1.22 + vec3(0.05, 0.07, 0.09), vec3(1.0)) : base * 0.78;
  }
  else if (uDebug > 3.5) col = hsv2rgb(vec3(fract(floor(wp.z) * 0.137), 0.65, 0.95));
  oColor = vec4(clamp(col, 0.0, 1.0), 1.0 - 0.5 * em);
  oNormal = vec4(N * 0.5 + 0.5, 1.0);            // a = 1 marks foreground
}
`;

// ------------------------------------------------------------------------------------------- pass 2 blit + outline
export const POST_FRAG = PRECISION + /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform vec2 uRT;                  // (fw, fh)
uniform vec2 uOrigin;              // canvas pixel origin of the blit viewport
uniform float uPS;                 // integer virtual pixel size
uniform float uOutline;
uniform float uDarkness;           // 0.62 (refined dark-coloured outline)
uniform float uCreaseThresh;       // inner depth-crease threshold, world voxels (1.75 ≤ 48 vx … 2.25 > 56 vx)
uniform float uDepthScale;         // world units per [0..1] depth
uniform float uDepthRef;
uniform vec3 uL;
uniform float uDebug;              // 2 = depth view
layout(location = 0) out vec4 oColor;

float depthAt(ivec2 c) { return texelFetch(tDepth, c, 0).r; }
void main() {
  ivec2 sz = ivec2(uRT);
  ivec2 c = clamp(ivec2(floor((gl_FragCoord.xy - uOrigin) / uPS)), ivec2(0), sz - 1);
  vec4 c0 = texelFetch(tColor, c, 0);
  vec3 col = c0.rgb;
  vec4 nm = texelFetch(tNormal, c, 0);
  bool fg = nm.a > 0.5;
  float d = depthAt(c);
  if (uDebug > 1.5 && uDebug < 2.5) {
    float v = fg ? clamp(0.55 - (d - uDepthRef) * uDepthScale / 24.0, 0.04, 1.0) : 0.0;
    col = fg ? vec3(v, v * 0.96, v * 0.9) : vec3(0.02, 0.025, 0.035);
    oColor = vec4(col, 1.0);
    return;
  }
  float em = fg ? clamp((1.0 - c0.a) * 2.0, 0.0, 1.0) : 0.0;   // PART_FRAG writes a = 1 - 0.5·emissive
  if (!fg) {                                       // subtle 2-texel glow halo around emissive texels (background only)
    ivec2 RING[8] = ivec2[8](ivec2(2, 0), ivec2(-2, 0), ivec2(0, 2), ivec2(0, -2), ivec2(1, 1), ivec2(-1, 1), ivec2(1, -1), ivec2(-1, -1));
    float ge = 0.0; vec3 gc = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      ivec2 q = clamp(c + RING[i], ivec2(0), sz - 1);
      if (texelFetch(tNormal, q, 0).a < 0.5) continue;
      vec4 cq = texelFetch(tColor, q, 0);
      float eq = clamp((1.0 - cq.a) * 2.0, 0.0, 1.0);
      if (eq > ge) { ge = eq; gc = cq.rgb; }
    }
    if (ge > 0.01) col = mix(col, gc, 0.16 * ge);
  }
  if (uOutline > 0.5) {
    ivec2 OFFS[4] = ivec2[4](ivec2(1, 0), ivec2(0, 1), ivec2(-1, 0), ivec2(0, -1));
    vec3 L = normalize(uL);
    if (!fg) {                                     // outer silhouette
      float best = 2.0; vec3 bc = vec3(0.0); bool found = false; float be = 0.0;
      for (int i = 0; i < 4; i++) {
        ivec2 q = c + OFFS[i];
        if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, sz))) continue;
        if (texelFetch(tNormal, q, 0).a > 0.5) {
          float dq = depthAt(q);
          if (dq < best) { vec4 cq = texelFetch(tColor, q, 0); best = dq; bc = cq.rgb; be = clamp((1.0 - cq.a) * 2.0, 0.0, 1.0); found = true; }
        }
      }
      if (found) col = bc * mix(1.0 - uDarkness, 0.6, be);   // a glowing neighbour gets a soft lit rim, not ink
    } else {
      vec3 N = nm.rgb * 2.0 - 1.0;
      float dl = d * uDepthScale;
      bool edge = false; float crease = 0.0;
      for (int i = 0; i < 4; i++) {
        ivec2 q = c + OFFS[i];
        if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, sz))) continue;
        vec4 nq4 = texelFetch(tNormal, q, 0);
        if (nq4.a < 0.5) continue;
        float dq = depthAt(q) * uDepthScale;
        vec3 Nq = nq4.rgb * 2.0 - 1.0;
        if (dl - dq > uCreaseThresh) edge = true;                               // inner depth crease
        else if (i < 2 && abs(dl - dq) < uCreaseThresh && dot(N, Nq) < 0.45)    // normal crease (right/up only)
          crease = dot(Nq, L) > dot(N, L) ? 1.0 : -1.0;
      }
      vec3 base = col;
      if (edge) col = mix(col, col * (1.0 - uDarkness), 0.85);
      else if (crease > 0.0) col *= mix(1.0, 1.0 - uDarkness, 0.32);
      else if (crease < 0.0) col = min(col * 1.12 + 0.02, vec3(1.0));
      col = mix(col, base, em);                    // recessed glowing seams are never inked out
    }
  }
  oColor = vec4(col, 1.0);
}
`;
