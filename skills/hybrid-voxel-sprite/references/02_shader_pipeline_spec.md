# 02 — T3 Shader Pipeline Spec (engine-neutral, GLSL-style)

This file mirrors the verified `HybridRenderer` (`src/renderers/hybrid/hybrid_renderer.js`). The constants below are
the shipped values; change them only on purpose. Math helpers are in [01](01_contract_and_math.md). For the WebGL2
mapping, see [targets/webgl2_threejs.md](targets/webgl2_threejs.md).

The **v1.1** sections (§8 depth-bucket tie-break, §9 6-slot emissive, §10 view modes and `SPRITE STACK`) are optional.
They mirror the verified Three.js r187 showcase renderers: Four Symbols at 119,391 voxels, and 4 articulated vehicles
at 166,290 voxels in 39 parts.

```
per frame:  pose (FK/IK/springs → matrix, invMatrix, deform per part)
PASS 1  → low-res G-buffer FBO  (fw, fh) = floor(viewport / pixelScale)
          C0 = RGBA8 lit colour · C1 = RGBA8 world normal (a = foreground mask) · DEPTH_COMPONENT24 texture
          a) clear   b) ground grid (C0 only)   c) per-part ground shadows   d) per-part OBB raymarch (MRT)
PASS 2  → output framebuffer, full res: texelFetch blit (NEAREST) + 1px depth/normal outline
```

## 1. Frame setup (CPU)

**Virtual grid.**
- `ps = usePixelSnap ? clamp(round(pixelScale), 1, 8) : 1`
- `fw = max(1, floor(vpW / ps))` and `fh = max(1, floor(vpH / ps))`
- Recreate the FBO only when `(fw, fh)` changes, and delete the old textures when you do.

**Camera snap.** Translate the projection so the world origin lands on a virtual-texel centre:
```
snapToTexel(VP, a): p = VP·a;  sx = (p.x+1)·0.5·fw − 0.5;  sy = (p.y+1)·0.5·fh − 0.5
                    return ((round(sx) − sx)·2/fw, (round(sy) − sy)·2/fh)          // NDC delta
dn = snapToTexel(VP, origin);  VP' = T(dn.x, dn.y, 0) · VP;  invVP' = inverse(VP')
```

**Root snap.** Snap `pose.rootOffset` the same way and push the world delta into every part:
```
dr = snapToTexel(VP', rootOffset);  sx = |VP'.row0.xyz|;  sy = |VP'.row1.xyz|
R = VP'.row0.xyz / sx;  U = VP'.row1.xyz / sy;    rootDelta = R·dr.x/sx + U·dr.y/sy
M' = T(rootDelta)·M;   invM' = invM·T(−rootDelta)
```
Draw the ground grid's contact shadow at the snapped root as well. The result: a sub-texel root shift changes
**0 output pixels**, against 9–21k without the snap.

**Depth helpers for the outline.**
- `zs = |VP'.row2.xyz|` and `depthScale = 2 / zs` (world units per [0..1] depth)
- `depthRef = 0.5·(VP'·target).z + 0.5`

**Proxy box per part** (`deformedBounds`), in deformed part-local space:
- **Identity deform:** `[−pivot − 0.5, size − pivot + 0.5]`.
- **Otherwise:**
  1. Forward-deform the four cross-section corners `(x ∈ {−pivot.x, sizeX − pivot.x}) × (y …)` at
     `lz = −pivot.z + sizeZ·k/12` for `k = 0..12`.
  2. Take their min and max.
  3. Pad XY by `1.25 + 0.5·|twistZ|` and Z by `1`.

**Affine flag.** `|twistZ|, |waveAmpX|, |waveAmpY|` are all below `1e-4`. The ray stays straight in voxel space.

**Step budget (stats only).** `ceil(|boxExtent| / (smooth ? 0.35 : 0.4))`.

## 2. Pass 1a/b — clear & ground grid

```
bindFramebuffer(FBO); viewport(0,0,fw,fh); drawBuffers([C0, C1])
clearBufferfv(COLOR, 0, background = (0.071, 0.078, 0.098, 1))
clearBufferfv(COLOR, 1, (0.5, 0.5, 0.5, 0.0))        // normal buffer: mask a = 0 = background
clearBufferfv(DEPTH, 0, [1.0])
drawBuffers([C0, NONE]); drawGroundGrid(...)        // single-output shader → NEVER leave C1 enabled here
```

## 3. Pass 1c — per-part ground shadow (before parts)

This pass uses one quad per part on the plane `z = 0.02`. The quad covers the part's world AABB (8 proxy corners
through `M'`) projected along the light onto the ground: each corner `(x, y, z ≥ 0)` lands at
`(x − L.x/L'z·z, y − L.y/L'z·z)`, where `L'z = max(L.z, 0.12)`. The rect is padded by 1.

```glsl
// fragment (draw buffers [C0, NONE]; blendFuncSeparate(SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ZERO, ONE); depthFunc LESS)
pixelRay(roW, rdW);                                   // §4
if (abs(rdW.z) < 1e-5) discard;
vec3 g  = roW + rdW * ((0.02 - roW.z) / rdW.z);       // exact ground point — identical for every part
vec3 Lw = normalize(vec3(L.xy, max(L.z, 0.12)));
ro = (invM' * vec4(g,1)).xyz;  rd = normalize(mat3(invM') * Lw);
if (!slab(ro, rd, boxMin, boxMax, t0, t1)) discard;
occ = 0; t = max(t0,0) + 0.2;
for (i < 160 && t <= t1; t += 0.6) { occ = max(occ, smoothstep(0.3, 0.6, sampleSmooth(toVoxel(ro + rd*t)).a)); if (occ > 0.99) break; }
if (occ < 0.5) discard;
gl_FragDepth = 0.5 * clip(g).z / clip(g).w + 0.5;    // same depth for every part at this pixel
oColor = vec4(0.035, 0.03, 0.075, 0.5);
```

Every part writes bit-identical depth for a given ground pixel. With `depthFunc(LESS)`, the **first** part to shadow a
pixel wins, so overlapping parts never darken it twice. The shadow march samples the albedo through the LINEAR sampler on unit 0.

## 4. Pass 1d — per-part OBB raymarch (the core)

**State.**
- `drawBuffers([C0, C1])`
- `enable(CULL_FACE); cullFace(FRONT)`: back faces only, which gives exactly one fragment per covered pixel even when
  the camera is inside the box.
- Depth: `useZBuffer ? (DEPTH_TEST, LEQUAL, depthMask true) : (no test, no write)`.
- Texture units: unit 0 holds the albedo `TEXTURE_3D`, using the LINEAR sampler in smooth mode and NEAREST in crisp
  mode. Unit 1 holds the normal/AO `TEXTURE_3D` with the NEAREST sampler; it is read with `texelFetch`.

**Vertex shader.** Unit cube `aPos ∈ [0,1]³`, with `p = mix(boxMin, boxMax, aPos)` and
`gl_Position = VP' · M' · vec4(p, 1)`.

```glsl
void pixelRay(out vec3 ro, out vec3 rd) {           // orthographic ray from gl_FragCoord (never from varyings)
  vec2 ndc = (gl_FragCoord.xy - uViewport.xy) / uViewport.zw * 2.0 - 1.0;
  vec4 a = uInvViewProj * vec4(ndc, -1, 1), b = uInvViewProj * vec4(ndc, 1, 1);
  ro = a.xyz / a.w;  rd = normalize(b.xyz / b.w - ro);
}
bool slab(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax, out float t0, out float t1) {
  vec3 inv = 1.0 / (|rd.c| < 1e-7 ? 1e-7 : rd.c);   // per component
  vec3 ta = (bmin - ro) * inv, tb = (bmax - ro) * inv;
  t0 = max3(min(ta, tb));  t1 = min3(max(ta, tb));  return t1 > t0 && t1 > 0.0;
}
float edgeMask(vec3 v) {                             // emulates zero padding under CLAMP_TO_EDGE
  vec3 lo = clamp(v + 0.5, 0, 1), hi = clamp(uSize + 0.5 - v, 0, 1);  return lo.x*lo.y*lo.z*hi.x*hi.y*hi.z;
}
vec4  sampleSmooth(vec3 v) { return texture(uVol, v / uSize) * edgeMask(v); }
float occCrisp(vec3 v)     { ivec3 c = ivec3(floor(v)); return inGrid(c) && texelFetch(uVol, c, 0).a > 0.5 ? 1 : 0; }
vec3  toVoxel(vec3 d)      { return invDeform(d) + uPivot; }   // invDeform = 01 §6 inverse, s = max(squashZ, 0.05)
```

**Main.**
```glsl
pixelRay(roW, rdW);
ro = (invM' * vec4(roW,1)).xyz;  rd = mat3(invM') * rdW;  rd /= length(rd);   // renormalise: matrices may be scaled
if (!slab(ro, rd, boxMin, boxMax, t0, t1)) discard;  t0 = max(t0, 0);
if (!smooth && affine) {
  // EXACT 3D DDA (Amanatides–Woo) in undeformed voxel space, ≤ 400 cells, texelFetch, a > 0.5
  oV = toVoxel(ro);  dV = toVoxel(ro + rd) - oV;     // same t parameter as the deformed ray
  clip [a0,a1] = slab(oV, dV, 0, size) ∩ [t0,t1];  start at oV + dV*(a0 + 1e-4)
  hit normal = the face crossed (first cell: faceNormal = closest integer plane, sign −sign(dV))
} else {
  STEP = smooth ? 0.35 : 0.4;  ISO = smooth ? 0.45 : 0.5;
  for (i < 600, t = t0; t <= t1; t += STEP) {
    a = smooth ? sampleSmooth(toVoxel(ro + rd*t)).a : occCrisp(toVoxel(ro + rd*t));
    if (a >= ISO) { 6 bisection steps on [tPrev, t]; th = hi; hit; break; }
  }
}
if (!hit) discard;
hd = ro + rd*th;  hv = toVoxel(hd);  wp = (M' * vec4(hd,1)).xyz;
gl_FragDepth = 0.5 * (VP'*wp).z / (VP'*wp).w + 0.5;           // exact depth → order-independent occlusion
```

**Surface attributes.**
```glsl
rdV = toVoxel(hd + rd*0.05) - hv;
cin = ivec3(floor(toVoxel(hd + rd*0.3)));                      // solid voxel just inside the surface
if (!inGrid(cin) || texelFetch(uVol, cin, 0).a < 0.5) cin = ivec3(floor(hv - faceNormal(hv, rdV)*0.5));
cin = clamp(cin, 0, size-1);  vin = texelFetch(uVol, cin, 0);  nao = texelFetch(uNao, cin, 0);
nTex = nao.rgb*2-1;  texOk = vin.a > 0.5 && dot(nTex,nTex) > 0.25;
smooth: albedo = solid ? vin.rgb : clamp(cs.rgb / max(cs.a,1e-3)), cs = sampleSmooth(hv + normalize(rdV)*0.35)
        nG = −normalize(central-difference gradient of sampleSmooth().a, h = 0.6)   (fallback −normalize(rdV))
        Nv = texOk ? normalize(0.45·nG + 0.55·nTex) : nG
crisp : Nv = face normal (DDA) or faceNormal(hv, rdV);  Nv = texOk ? normalize(mix(Nv, nTex, 0.3)) : Nv
ao   = texOk ? smoothstep(0.1, 0.92, nao.a) : 1.0             // contrast curve on baked visibility
N    = normalize(transpose(mat3(invM')) * deformNormal(Nv, uZ = clamp(hv.z / size.z, 0, 1)))   // 01 §6
```

## 5. Lighting (all terms are live toggles)

These are the defaults from `buildLightState()`:
- `dir = normalize(sin(−0.75)·cos(0.85), −cos(−0.75)·cos(0.85), sin(0.85))`
- colour `(1, .95, .86)`, ambient `0.34`
- sky `(.62, .70, .86)`, ground `(.30, .26, .30)`
- `shadowTint (.42, .40, .66)`, `highlightTint (1, .93, .78)`
- `rimColor (.70, .85, 1)`, `rimStrength 0.45`

```glsl
// self-shadow: 12-step secondary ray toward the light in deformed part-local space (inverse-deformed samples)
Ld = normalize(mat3(invM') * L);  q = hd − rd*0.25 + Ld*0.9;  occ = 0;
for (i < 12) { occ = max(occ, smoothstep(0.35, 0.7, sampleSmooth(toVoxel(q)).a) * (1 − i*0.03)); q += Ld*1.15; }
shadowF = 1 − occ;
heightOcc = mix(0.74, 1.0, smoothstep(0, 7, wp.z));            // rough ground/body occlusion
diff = max(dot(N,L), 0) * shadowF;   aoF = useAO ? ao : 1;
if (!lit)          col = albedo * (0.8 + 0.2*clamp(wp.z/30,0,1)) * mix(0.62, 1, aoF);
else if (bands≥2) {                                            // cel: quantised N·L × shadow, hue-shifted ramp
  qb  = clamp(floor(diff*b*0.999 + 0.0001 + 0.15) / (b − 1), 0, 1);
  shadowCol = albedo*shadowTint*(0.62 + ambient*0.9) + vec3(0.012, 0.008, 0.03);   // cool blue-violet
  litCol    = albedo*mix(1, highlightTint, 0.45)*mix(1, lightColor, 0.6)*1.12;    // warm
  col = mix(shadowCol, litCol, qb) * mix(0.6, 1, floor(aoF*heightOcc*4 + 0.5)/4);  // quantised AO
  if (qb > 0.99 && pow(max(dot(N, normalize(L+V)),0), 40) > 0.7) col += litCol*0.09;   // glint
  if (rim) col += rimColor*rimStrength*0.55 * step(0.45, pow(1−clamp(dot(N,V),0,1), 2.5) *
                  clamp(0.3 + 0.7*dot(N, normalize(L + vec3(0,0,1))), 0, 1));     // stepped rim
} else {                                                        // celBands = 0: smooth
  hemi = mix(groundColor, skyColor, N.z*0.5 + 0.5);
  col  = albedo*(hemi*ambient*1.6*mix(0.45,1,aoF)*heightOcc + lightColor*diff*0.95)
       + lightColor*pow(max(dot(N,normalize(L+V)),0),32)*0.22*shadowF;
  col  = mix(col, col*shadowTint*1.6, (1 − diff)*0.25);
  if (rim) col += rimColor*rimStrength*0.8*pow(1−clamp(dot(N,V),0,1),3)*clamp(0.35+0.65*dot(N,normalize(L+vec3(0,0,1))),0,1);
}
oColor  = vec4(clamp(col,0,1), 1);   oNormal = vec4(N*0.5 + 0.5, 1);   // a = 1 marks foreground
```

`V = −rdW`, and `lightColor` is multiplied by `light.intensity`. `celBands` is rounded; any value of 2 or more is capped
at 8.

**Debug views** (scene shader):
- `normals`: `N*0.5+0.5`
- `ao`: `ao·heightOcc·mix(0.55,1,shadowF)`
- `slices`: an HSV band per `floor(wp.z)`

The post pass handles `depth`, reading the depth texture relative to `depthRef`.

## 6. Pass 2 — full-res blit + 1px outline

**State.**
```
bindFramebuffer(output); drawBuffers(output ? [COLOR_ATTACHMENT0] : [BACK])
viewport + scissor to the viewport; depth test off; blend off
```

**Texel lookup.** `c = clamp(ivec2(floor(uv·(fw,fh))), 0, size−1)`, then `texelFetch` from C0, C1 and depth. This is
NEAREST sampling and never bilinear.

```glsl
const ivec2 OFFS[4] = (1,0), (0,1), (-1,0), (0,-1);
if (!fg) {                       // OUTER silhouette: background texel next to foreground
  pick the 4-neighbour fg texel with the smallest depth;  col = itsColour * (1 − outlineDarkness);   // 0.78
} else {
  dl = d·depthScale;
  for each fg neighbour q: dq = depth(q)·depthScale;
    if (dl − dq > 1.75) edge = true;                                   // INNER depth crease: I am ≥1.75 vox behind
    else if (i < 2 && |dl − dq| < 1.75 && dot(N, Nq) < 0.45)            // NORMAL crease (right/up neighbours only)
      crease = dot(Nq, L) > dot(N, L) ? +1 : −1;
  if (edge)            col = mix(col, col*(1 − darkness), 0.85);
  else if (crease > 0) col *= mix(1, 1 − darkness, 0.32);              // darker side gets a 1px line
  else if (crease < 0) col = min(col*1.12 + 0.02, 1);                  // lit side gets a highlight
}
```

**Restore state afterwards.**
- Unbind the samplers and the 3D and 2D textures, then bind VAO null and program null.
- Disable scissor and cull.
- Set `DEPTH_TEST` on, `depthFunc(LESS)` and `depthMask(true)`.

**Draw calls.** `1 grid + N shadow quads + N part boxes + 1 post`: 28 for the 13-part knight, 8 for the 3-part
reference.

## 7. Numbers to keep consistent across ports

| Constant | Value | Where |
|---|---|---|
| March step / iso (smooth) | 0.35 / 0.45, LINEAR | §4 |
| March step / threshold (crisp, non-affine) | 0.4 / 0.5 | §4 |
| Bisection steps | 6 | §4 |
| DDA max cells / march max steps | 400 / 600 | §4 |
| Gradient h | 0.6 voxel | §4 |
| Baked vs gradient normal | 0.55 / 0.45 (smooth); face → baked mix 0.3 (crisp) | §4 |
| Self-shadow | start `−0.25·rd + 0.9·Ld`, 12 × 1.15, weight `1 − 0.03i`, smoothstep(.35,.7) | §5 |
| Ground shadow | z = 0.02, start +0.2, step 0.6, ≤ 160, smoothstep(.3,.6), discard < 0.5, rgba (.035,.03,.075,.5) | §3 |
| Proxy margin | XY 1.25 + 0.5·abs(twistZ), Z 1, 13 levels | §1 |
| Outline | darkness 0.78, depth edge 1.75 vox, normal dot 0.45 | §6 |
| Pixel scale | 1–8, default 3 | §1 |

## 8. v1.1 D24 depth-bucket tie-break (`uDepthSlot` / `uDepthSlots`)

**When you need it.** Use it for rigs with 10–20+ parts whose surfaces meet coplanar or nearly so: a chassis and its
wheel arch, a hydraulic barrel and its rod, shared spine ball caps, joint spheres. Exact `gl_FragDepth` (§4) can still
**tie** after 24-bit quantisation. `depthFunc(LEQUAL)` then settles the pixel by draw order.

**Why a plain epsilon fails.** The first attempt added a per-part epsilon, `gl_FragDepth += partIndex·4e-6` (the
"~1e-6 · slot / slots" idea). It only makes ties **rarer**. Bisection error (≈ 0.005 voxel) is larger than the bias
(≈ 0.0016 voxel), so quantised depths still collide. In the Four Symbols 1,536-pose sweep, **40 of 1,536 renders
(2.6%) differed from the reversed-order render by 9–27 px each (441 px in total)**.

**Verified fix: quantise into buckets and put the slot in the low bits.**
```glsl
uniform float uDepthSlot;    // part index 0 … uDepthSlots−1 (one per part; instances get distinct slots)
uniform float uDepthSlots;   // power of two ≥ part count, min 16 (39-part vehicle set: 64)
const float D24 = 16777215.0;                                  // 2^24 − 1
float dRaw   = clamp(0.5 * clipP.z / clipP.w + 0.5, 0.0, 1.0);  // the exact §4 depth
float bucket = 4.0 * uDepthSlots;                              // D24 steps per bucket (64 for 16 slots ≈ 4e-6 NDC)
float q      = floor(dRaw * (D24 / bucket));
gl_FragDepth = min((q * bucket + uDepthSlot * 4.0 + 2.0) / D24, 1.0);   // centre of a 4-step slot
```
- Writing the **centre** of a 4-step slot means float→UNORM24 rounding can never move a value into the next slot.
- Two different parts can never produce equal depth. Inside one bucket, the lower slot always wins, whatever the draw
  order.
- The cost is a depth resolution of `bucket` D24 steps, about 4e-6 NDC for 16 slots. That is far below a voxel at
  pixel-art scales.
- Ground-shadow quads keep their own LESS rule (03 pitfall 11). World meshes that share the depth buffer
  ([webgl2_threejs.md §4.5](targets/webgl2_threejs.md#45-perspectivecamera--3d-world-mrt-hybrid-recipe-v11)) write
  plain depth.
- **Result.** Reversed draw order differs by **0 px in all 1,536 sweep poses** on the real Four Symbols bundles,
  against 40 failing renders before the fix. G1/G2 do not change.
  - The vehicle engine's 1,536-render sweep also reports reorder 0. It ran on fallback subjects, before the bundles
    existed.
  - Each real vehicle bundle (up to 18 parts, 39 in total, `uDepthSlots = 64` in the shared 4-vehicle scene) passes
    G4 with reorder 0/0/0.

## 9. v1.1 6-slot emissive & post glow halo contract

The schema is in [01 §3.1](01_contract_and_math.md#31-v11-emissive-schema-optional).

**Pass 1 (part shader, FINAL view only):**
```glsl
uniform int   uEmissiveCount;      // valid rig.emissiveColors (≤ 6)
uniform vec3  uEmissiveCols[6];    // 0–1 RGB
uniform float uEmissiveStrength;   // default 0.9
uniform float uPartEmissive;       // rig part.emissive, default 0
float em = uPartEmissive;
for (int k = 0; k < 6; k++) { if (k >= uEmissiveCount) break;
  if (length(albedo - uEmissiveCols[k]) < 0.048) em = max(em, uEmissiveStrength); }
em = clamp(em, 0.0, 1.0);
if (em > 0.01) col = mix(col, min(albedo * 1.25 + vec3(0.03), vec3(1.0)), em);   // bypasses cel shadow, AO, self-shadow
oColor = vec4(clamp(col, 0.0, 1.0), 1.0 - 0.5 * em);                              // alpha encodes emission
```
- Emission replaces the *shaded* colour with a brightened **unshaded** albedo. Lights in shadow, under a roof or in
  the dark cel band stay lit.
- Alpha 1 means not emissive; alpha 0.5 means fully emissive. Parts without emission must still write alpha 1.
- Debug views (§10) force `em = 0`.

**Pass 2 (post):**
- Decode the emission of every texel as `em = sky ? 0 : clamp((1 − C0.a) · 2, 0, 1)`.
- **Outline:** an emissive texel keeps its own colour (`col = mix(col, C0.rgb, em)`), so headlights are never darkened.
  An outline drawn *from* an emissive neighbour uses `mix(1 − darkness, 0.62, emNeighbour)`.
- **Halo (FINAL only):** scan a 16-tap ring (4 at distance 1 with weight 1.0, 8 at distance 2 or diagonal with 0.62,
  4 at distance 3 with 0.32). Skip sky taps, non-emissive taps and taps more than 6 units **behind** the current depth.
  Keep the strongest `ge = em·w` and its colour `gc`. If `em < 0.5`, apply
  `col = mix(col, gc, 0.22·ge) + gc·0.08·ge`.
- This gives a crisp 1–3-texel screen-space glow with no blur pass. It stays pixel-art and never bleeds through
  occluders.

**Self-test (`emissiveSelfTest`).**
- For each slot k = 0…5, build a scratch rig: 5 saturated decoys at least 0.15 RGB away from every bundle albedo, the
  bundle's most frequent albedo at index k, and a malformed `'bogus'` entry.
- **Pass when:**
  - every slot changes > 0 px against an emissive-free baseline;
  - `count == 6` and `strength == 0.9`;
  - a 7th valid colour is dropped (`count` stays 6, 0 glow px);
  - a missing `emissiveStrength` resolves to 0.9;
  - `glError == 0`.

## 10. v1.1 debug & showcase view modes

One scalar `mode` per fragment: `0 = FINAL`, `1 = NORMALS` (`N·0.5+0.5`), `2 = SPRITE STACK`, `3 = VOLUME AO`
(`ao·heightOcc·mix(0.55, 1, shadowF)`). It comes from `uDebug`, or from up to 4 diagonal live-wipe dividers.
`s = x + K·y` against `uWipePos`, with `uWipeModes` holding the mode of each band. Every pass (sky, world, parts,
post) evaluates the same `wipeMode(gl_FragCoord.xy · uPS)`, so the bands cut cleanly through the whole frame.

**`marchStack()`: live `SPRITE STACK` (`mode == 2`).** The part volume is shown as real horizontal 2D sprite cards
along local `Z` (the stacking axis), with see-through air gaps, still raymarched per part with exact depth.
- **Pitch.** `P = (size.z ≥ 18 ? 2 : 1) · max(uStackMul, 1)`. Use `uStackMul = 2` for wide shots at about 3–4 px per
  voxel, where gaps would otherwise turn to mush.
  - `P = 1`: the card is `[z + 0.24, z + 0.76]`, which is 0.52 card and 0.48 gap.
  - `P ≥ 2`: the card is `[kP + 0.15, kP + 0.15 + 0.4P]`. For `P = 2` that is 0.80 card and 1.20 gap.
- **March.** It is a copy of the affine DDA (§4, up to 520 cells).
  - At an occupied cell, intersect the cell's ray interval `[tCur, tNext]` with the card's z-slab `cardSpan(cell)`.
  - If the intervals overlap, it is a hit at `e0`. Entering through the card plane gives normal `±Z`; otherwise the
    normal is the entered face.
  - If they do not overlap, the ray is in an air gap: **keep marching** to the layer behind or below.
  - Non-affine (wave) parts use the same card occupancy through a 0.22-step point march with 6-step bisection.
- **Thin-detail rescue.** A voxel that lies only in a gap, with nothing in its column inside the block's card, still
  gets a thin card `[z + 0.275, z + 0.725]`. 1-voxel roofs, wings, mirrors, antennas and beacons therefore never vanish.
- **Shading.** This is flat sprite-sheet colour, with no directional shadow crush.
  - Base: albedo × a height ramp `mix(0.68, 1.12, h)`, cooler low. `h` is the world height over the *subject* height
    (`uVehH`), so articulated parts share one ordering.
  - Alternate cards are 0.90×. Near-black albedo lifts toward slate so it reads on the dark backdrop.
  - Card tops are 1.04×, plus a bright 1-voxel border where the same-layer neighbour is empty.
  - Card sides are 0.78×, except the top 38%, which is a bright top-rim highlight (×1.22 + 0.05).
  - Undersides are 0.80×, cool.
- **Backdrop.** In mode 2 the sky becomes a dark blueprint gradient (#0d1624 → #132033, faint cyan horizon). The world
  becomes #132033 with anti-aliased cyan grid lines (16-voxel minor, 64-voxel major) on each surface's dominant plane.
  Smoke and particles `discard`.
- **Post-FX masking.** Pass 2 adds the halo, haze and glare only where `mode == 0`. The cinema pass returns early for
  any `wipeMode > 0.5` pixel and never taps across a band edge. Tech bands stay crisp and unblurred.
