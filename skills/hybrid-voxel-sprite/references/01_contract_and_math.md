# 01 — Contract & Math (coordinates, pivots, SVOX rig, IK, springs, deformation)

Every formula here is copied from verified code:
- `src/core/math.js`, `src/core/voxel_builder.js` and `src/renderers/hybrid/hybrid_renderer.js` in the origin repo.
- [`scripts/svox_cli.py`](../scripts/svox_cli.py), which is byte-exact against the JS normal/AO bake and is also
  tested numerically.

When you port to another engine, keep these exact, then convert axes at the boundary (see the target files).

## 1. Coordinate system & camera

- **Right-handed, Z-up.** `+X` = right, `+Y` = back, `+Z` = up. Characters **face `-Y`**. 1 world unit = 1 voxel.
  The ground plane is `z = 0`.
- **Orthographic orbit camera** around `target = [0, 0, targetHeight]`:
  ```
  eye     = target + [sin(yaw)·cos(pitch), -cos(yaw)·cos(pitch), sin(pitch)] · 100
  forward = -[sin(yaw)·cos(pitch), -cos(yaw)·cos(pitch), sin(pitch)]
  right   = normalize(cross(forward, +Z));   up = cross(right, forward)
  halfH   = orthoHeight / zoom / 2   (orthoHeight = 46);   halfW = halfH · aspect
  proj    = ortho(-halfW, halfW, -halfH, halfH, near = -200, far = 200)      // OpenGL NDC z ∈ [-1, 1]
  ```
  - `yaw = 0` is the front view, with the camera on the `-Y` side. Yaw increases counter-clockwise about `+Z`.
  - `pitch` is clamped to `[0.05, 1.45]` rad. The default is `0.58` (about 33° isometric), and "low pitch" is
    `14° = 0.2443`.
- **Matrices** are column-major `Float32Array(16)`. The point transform is
  `p' = (m[0]x + m[4]y + m[8]z + m[12], …)`.
- **Rotations** match `math.js`. `RotX(a)` gives `y' = c·y − s·z` and `z' = s·y + c·z`. `RotY` and `RotZ` follow the
  same right-handed convention.
- **Euler TRS** is `T · Rz · Ry · Rx · S`: X is applied first, then Y, then Z.

## 2. Voxel storage, strips, normal/AO encoding

- **Index layout.** `idx = ((z·sizeY + y)·sizeX + x)·4`, RGBA8. X varies fastest, then Y, then Z. This is exactly the
  `texImage3D` order.
- **Voxel extent.** Voxel `(ix, iy, iz)` occupies `[ix, ix+1] × [iy, iy+1] × [iz, iz+1]`; its centre is `+0.5`.
- **Solidity.** A voxel is solid when `alpha > 0`; importers binarise alpha to 0 or 255. Renderers test `a > 0.5`
  (crisp) or use the trilinear iso-surface `a ≥ 0.45` (smooth).
- **`strip_x` PNG layout.** Width is `sizeX·sizeZ` and height is `sizeY`. Slice `z` occupies columns
  `z·sizeX … (z+1)·sizeX − 1`.
  - PNG **row r is voxel y = r**: row 0 is the top of the image and holds `y = 0`, the front-most row.
  - This equals `VoxelVolume.stripData`, so strips upload with `UNPACK_FLIP_Y = false`.
- **`normal_ao`.** Same layout. `RGB = round((n·0.5 + 0.5)·255)`, where `n` is the outward unit normal.
  `A = round(AO·255)`, where AO is **visibility**: 255 means fully open. Multiply colour by it.
  - Voxels that are neither solid nor touching a solid keep the default `(128, 128, 255, 255)`: normal `+Z`, AO open.

## 3. SVOX bundle — `rig.json` (`svox.rig/v1`)

```json
{
  "schema": "svox.rig/v1",
  "coordinates": { "handedness": "right-handed", "up": "+Z", "front": "-Y", "unit": "1 voxel", "ground": "z = 0" },
  "targetHeight": 9.0,
  "parts": [{
    "name": "cape", "parent": "torso",
    "pivot": [6.0, 2.0, 0.0],          // voxel coords of the part origin (may be fractional)
    "restOffset": [0.0, 5.0, 12.0],    // pivot position in the PARENT's pivot-relative (undeformed) local space
    "restRotation": [0.0, 0.0, 0.0],   // Euler XYZ radians
    "size": [12, 4, 11], "deformRole": "cloth", "flippedCloth": true,
    "albedoLayout": "strip_x", "albedoPath": "parts/cape.albedo.png", "normalAoPath": "parts/cape.normal_ao.png"
  }],
  "clips": [{ "name": "idle", "duration": 2.0, "loop": true, "channels": [
    { "part": "cape", "channel": "wavePhase", "fn": "ramp", "amp": -6.283185, "cycles": 2 },
    { "part": "torso", "channel": "squashZ", "fn": "sin", "amp": 0.035, "cycles": 2 },
    { "part": "@root", "channel": "posZ", "fn": "keys", "times": [0, 1, 2], "values": [0, 0.5, 0] } ] }]
}
```
The `//` comments above are explanation only. Real `rig.json` is plain JSON.

**Channels are additive offsets on top of the rest value.** The rest value of `squashZ` and `scale` is 1, and every
other channel rests at 0. With `u = t / duration`:
- `sin`: `bias + amp·sin(2π·cycles·u + phase)`
- `ramp`: `bias + amp·cycles·u`
- `keys`: linear interpolation over `times` / `values`, wrapping at `duration`, plus `bias`

Part channels are `posX/Y/Z`, `rotX/Y/Z`, `scale` and the 8 deform keys (§6). `@root` takes `posX/Y/Z`, which form
`rootOffset`. Loops are seamless only with whole `cycles`, and with ramp phases in multiples of 2π.

### 3.1 v1.1 emissive schema (optional)

Verified on the 4-vehicle showroom (excavator, F1, Mini, Cybertruck: 39 parts, 166,290 voxels) and the Four Symbols
set. All keys are optional. `svox_cli validate` ignores unknown top-level keys, so v1 tools still load the bundle.

```json
{ "schema": "svox.rig/v1",
  "emissiveColors": ["#f4f7fb", "#e83b3b", "#f5a15d"],   // ≤ 6 '#rrggbb' strings matched against part ALBEDO
  "emissiveStrength": 0.94,                              // [0, 1], default 0.9
  "parts": [{ "name": "beacon", "emissive": 1.0, "...": "..." }] }   // per-part whole-part glow, [0, 1], default 0
```

| Key | Rule (as the verified loader parses it) |
|---|---|
| `emissiveColors` | Keep only strings that match `^#?[0-9a-fA-F]{6}$` (malformed entries are dropped), then the first **6**. A 7th valid colour is ignored. Colours are compared in 0–1 RGB: a texel glows when `length(albedo − col) < 0.048`, which is about ±7/255 per channel. |
| `emissiveStrength` | `Number.isFinite(v) ? clamp(v, 0, 1) : 0.9`. Treat `undefined`, `null` and `''` as *missing*; see [03 pitfall 16](03_pitfalls_and_qa_gates.md). |
| `parts[].emissive` | Glow for the whole part, whatever the albedo: beacons, lenses, energy cores. Clamped to [0, 1]; default 0. |

Per texel, `em = max(part.emissive, strength if albedo matches any slot)`. The shader contract (shadow bypass, MRT
alpha encoding and the Pass 2 halo) is in [02 §9](02_shader_pipeline_spec.md#9-v11-6-slot-emissive--post-glow-halo-contract).
Paint emissive voxels in a colour that no other surface uses, so the 0.048 match never catches body paint.

## 4. Pivot & matrix convention (the one rule every renderer must obey)

```
local       = voxel - pivot                         // part-local, relative to pivot
world       = M · vec4(deform(local), 1)            // M = pose.parts[name].matrix
deformedLoc = invM · vec4(world, 1)                 // invM = inverse(M)
voxel       = undeform(deformedLoc) + pivot
uvw         = voxel / size                          // == (invM·world + pivot) / size when deform is identity
```

The SVOX pose evaluation is the same in `svox_cli.evaluate_pose` and the JS QA runtime; they agree to < 1e-4. For each
part, in parent-first order:

```
a        = restOffset + (posX, posY, posZ)
attach   = parent ? parent.M · T(deformPoint_parent(a))        // children ride the parent's DEFORMED surface
                  : T(rootOffset + a)
M        = attach · Rz(rz)·Ry(ry)·Rx(rx) · [RotX(π) if flippedCloth] · S(1 + scale)
```
Here `rx = restRotation.x + rotX`, and likewise for `ry` and `rz`. `deformPoint_parent` uses the parent's `size.z` and
`pivot.z`.

Children inherit only the attach **position** from the deformed parent. Orientation does not follow twist or shear,
which is the same as the core knight and drake rigs. If the deform is off, attach to the undeformed point; head and arms
then never detach.

## 5. Analytic 2-bone IK & damped springs (exact `math.js`)

```js
function solveTwoBoneIK(rootPos, targetPos, poleDir, len1, len2) {
  var toT = sub(targetPos, rootPos), dist = len(toT);
  var d = dist > 1e-8 ? scale(toT, 1 / dist) : [0, 0, -1];
  var minR = Math.abs(len1 - len2) + 1e-4, maxR = len1 + len2 - 1e-4;
  var D = clamp(dist, minR, maxR);                       // unreachable targets clamp to full/min reach
  var pole = poleDir || [0, -1, 0];
  var b = sub(pole, scale(d, dot(pole, d)));             // pole projected onto the plane ⟂ d
  if (len(b) < 1e-6) { var alt = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [0, -1, 0]; b = sub(alt, scale(d, dot(alt, d))); }
  b = norm(b);
  var cosA = clamp((len1*len1 + D*D - len2*len2) / (2*len1*D), -1, 1), sinA = Math.sqrt(Math.max(0, 1 - cosA*cosA));
  var midPos = add(rootPos, add(scale(d, len1*cosA), scale(b, len1*sinA)));
  var endPos = add(rootPos, scale(d, D));
  var cosK = clamp((len1*len1 + len2*len2 - D*D) / (2*len1*len2), -1, 1);
  return { midPos, endPos, upperDir: norm(sub(midPos, rootPos)), lowerDir: norm(sub(endPos, midPos)),
           bendAngle: Math.PI - Math.acos(cosK), reach: D, reachable: dist >= minR && dist <= maxR };
}
```

To aim bones, use `mat4AlignBone(start, end, refUp = [0,-1,0], negZ)`. Its local `+Z` points from `start` toward
`end`; with `negZ = true` it is local `−Z` instead, for limbs authored hanging down from their pivot. The basis is
`y = normalize(refUp ⟂ z)` and `x = cross(y, z)`. The tests showed bone lengths preserved and the end effector on target
to within 9.8e-15 over 300 random cases.

**`SpringVec3`** is a damped harmonic spring, `a = k·(target − x) − c·v`. It integrates with **semi-implicit Euler in
fixed sub-steps**:

```
dt = clamp(dt, 0, 0.25);  n = max(1, ceil(dt·240));  h = dt / n
repeat n:  v += (k·(target − x) − c·v)·h;  x += v·h          // defaults k = 120, c = 14 (cape uses k = 70, c = 9)
```
It stays stable for huge `dt`: the tests measured a peak of 1.253 at `dt = 0.25` with `k = 400`. Use **one spring
state per subject per renderer**. With springs disabled, snap to the target and `reset()`.

Typical drive: spring the cloth anchor's virtual velocity, then map the spring value into the cloth's `shearY`,
`waveAmp` and lift rotation.

## 6. Per-slice deformation — forward & exact inverse

There are 8 scalars per part: `shearX, shearY, twistZ, squashZ, waveAmpX, waveAmpY, waveFreq, wavePhase`. Identity is
`squashZ = 1` with everything else 0. All of them work in **part-local (pivot-relative) space, before `M`**.

```
uZ  = clamp((lz + pivot.z) / sizeZ, 0, 1)                       // slice parameter from the UNDEFORMED z
xyS = 1 / sqrt(max(0.35, squashZ))                              // volume-preserving bulge, clamped
FORWARD  (deformPoint):
  1 squash : x *= xyS;  y *= xyS;  z' = lz · squashZ
  2 twist  : (x, y) = rot(twistZ · uZ) · (x, y)
  3 shear  : x += shearX · z';  y += shearY · z'               // uses the DEFORMED z'
  4 wave   : x += sin(uZ·waveFreq + wavePhase) · waveAmpX · uZ
             y += cos(uZ·waveFreq + wavePhase) · waveAmpY · uZ
INVERSE  (undeformPoint), given deformed (dx, dy, dz):
  lz = dz / squashZ   (CPU guard: |squashZ| < 1e-4 → 1e-4;  GPU: s = max(squashZ, 0.05))
  uZ = clamp((lz + pivot.z) / sizeZ, 0, 1)                      // recovered exactly → closed-form inverse
  4' undo wave : x = dx − sin(uZ·f + φ)·ampX·uZ;  y = dy − cos(uZ·f + φ)·ampY·uZ
  3' undo shear: x −= shearX · dz;  y −= shearY · dz
  2' undo twist: (x, y) = rot(−twistZ · uZ) · (x, y)
  1' undo squash: (x, y) /= xyS;  z = lz
```

- **Invertibility.** Because `uZ` depends only on `z` and `z` is recovered first, the inverse is exact.
  - Measured `undeform(deform(p))` max error: 2.7e-15 (core tests), 1.8e-15 in the browser over 400 samples, and
    9.9e-16 from `validate` over 200 samples.
  - The only singularity is `squashZ = 0`. `validate` reports `DEFORM_INVERT` for it, and warns `SQUASH_RANGE` outside
    `[0.35, 2.5]`, because `xyS` stops preserving volume below 0.35.
- **Keep `squashZ` ≥ 0.05.** The GPU shader clamps `s = max(squashZ, 0.05)` while the CPU `deformPoint` does not, so
  the two only agree when `squashZ` ≥ 0.05.
- **Affine special case.** With no twist and no wave (`twistZ = waveAmpX = waveAmpY = 0`), the deform is affine.
  Straight rays stay straight in voxel space, so the crisp renderer can use an exact DDA (see 02 §4).
- **Normal transform** (inverse-transpose of the Jacobian; wave is ignored), as implemented in `deformNormal`:
  ```
  n = (n.x / xyS, n.y / xyS, n.z / s)                 // squash^-T
  n.xy = rot(twistZ · uZ) · n.xy                       // twist (rotation: its own inverse-transpose)
  n.z -= shearX·n.x + shearY·n.y                       // shear^-T
  N_world = normalize(transpose(mat3(invM)) · normalize(n))
  ```
  This is "inverse-transpose of squash and shear, twist in between". The order is
  `squash⁻ᵀ → twist → shear⁻ᵀ → transpose(invM)`, matching forward `shear ∘ twist ∘ squash`.
- **Baking with a lookup table.** `bakePartsToMergedVolume` evaluates the inverse through a 256-bin table over `uZ`
  (max error < 0.03 voxel). Only the merged-volume tracks need it; T3 is analytic per sample.

## 7. Flipped-cloth convention (capes, robes, skirts)

- Build the cloth with **local `+Z` running down** the cloth, with `z = 0` at the mount. Set `pivot.z = 0` and mount it
  with an extra `RotX(π)`; the core wizard robe uses `RotY(π)` instead, with the same effect on Z.
- `uZ = 0` is then **pinned at the mount** and `uZ = 1` is the **free hem**, so wave, shear and twist (all scaled by
  `uZ` or `z'`) grow toward the hem. The slices remain horizontal in world space.
- `RotX(π)` also maps local `+Y` to world `−Y`. A negative local `shearY` therefore trails the hem **backward**
  (world `+Y`).
- A forward lean can swing the hem below ground. Add a **hem ground guard**: lift the body when the hem would cross
  `z ≈ 0.2`.

## 8. Normal + AO bake (exact `computeNormalAndAO`, ported in `svox_cli.compute_normal_ao`)

The input occupancy grid is padded by `PAD = 2` voxels. Cells below `z = 0` count as **ground** (AO only, weight 0.6);
everything else outside the grid is empty.

**1. Normal.** `n = normalize(−Σ w(o)·solid(p+o))` over the 26 neighbours, with Sobel weights
`w = (dx·s(dy)·s(dz), dy·s(dx)·s(dz), dz·s(dx)·s(dy))`, where `s(0) = 2` and `s(±1) = 1`.
- Fallback when `|g| < 1e-3`: the open 6-neighbour difference.
- Final fallback: up, or down when the up neighbour is solid and the down neighbour is open.

**2. AO.** If all 26 neighbours are solid, the voxel is buried and gets `AO = 0.5`. Otherwise:
- Quantise `n` to one of 26 directions `q`, using the component threshold `sin 22.5° = 0.3827`. If the result is 0,
  use `±Z`.
- Take the cells of two 3×3×3 windows centred at `p + q` and `p + 2q`, deduplicated. Their weights are
  `(ring1 ? 1.0 : 0.6) / |o| · (1 + 0.4·o.z/|o|)`, stored as float32: a sky bias.
- **Only cells with `dot(o, n) > 0.75` count.** This front-hemisphere filter is what keeps convex voxel staircases
  at AO = 1.00.
- Then `occFrac = Σ w·occ / Σ w`, where solid counts 1 and ground 0.6.
- `AO = (1 − 2.2·occFrac)^1.3`, clamped to `[0.12, 1]`.

**3. Shell dilation.**
- Normals are computed for every voxel that is solid or touches a solid (26-neighbourhood). For an empty shell voxel
  the Sobel gradient is evaluated *there*, which gives the local outward surface normal.
- Empty shell voxels then take the **mean AO of their solid 26-neighbours**, so `LINEAR` sampling across the
  iso-surface reports the surface's normal and AO instead of fading toward "open".

**Reference values.**
- Sphere r6: surface normals 100% unit, mean radial dot > 0.95, **min AO 1.00**.
- L-crevice: AO 0.51 against 1.00 on the open floor.
- Overhang under a cap: AO 0.42 against 1.00.

**Rounding.** Output bytes use JS `Math.round` (`floor(x + 0.5)`), not banker's rounding.

**Out-of-range reads.** AO cells reach 3 voxels away, beyond `PAD = 2`. JS typed arrays read `undefined` (empty)
there, and Python must treat out-of-range as empty too. See 03 §1, pitfall 9, for the scratch-buffer reuse bug this
exposed in the JS core.

## 9. Multi-clip framing & hard-surface / mechanical rigging

These v1.1 rules come from the Four Symbols set (4 beasts, 119,391 voxels) and the 4 articulated vehicles (39 parts,
166,290 voxels). Both ran on the Three.js port.

**Multi-clip framing.** Never size the camera from the rest pose alone.
- Build the framing box as the union of the rest pose and **12 deterministic samples of every clip**, with springs off
  and deform on. Use each part's deformed box corners.
- Project that box at both supported pitches (14° and 33°): vertical `2R·sin(p) + hz·cos(p)`, horizontal `2R`, where
  `R` is the XY half-diagonal and `hz` the height above `max(0, zMin)`. Take the larger value and add about 8% headroom.
- Aim at the box's XY centre, about 42% of its height up, which leaves room for the ground ring and contact shadow.
- *Why:* with rest-pose framing, 13 of 48 zoomed QA frames clipped at the top edge during the flying specials (+6 to
  +8 voxels of lift). A raised excavator boom, a lifted truck body or an open DRS flap does the same. With the union box,
  every frame kept at least 6 px of margin on all four edges.

**Hard-surface rigs need no deform.** Rigid parts use the identity deform and no springs; motion comes from matrices.

- **Telescoping hydraulic cylinders (6 parts: 3 barrel + rod pairs).** Author each barrel and rod along local `+Z` from
  its pin eye. After FK, every frame:
  ```
  A = parentOf(barrel).M · deformPoint(barrel.restOffset)   // pin A on the barrel's parent (e.g. house)
  B = parentOf(rod).M    · deformPoint(rod.restOffset)      // pin B on the rod's parent (e.g. boom)
  z = normalize(B − A);  x = normalize(hingeX − z·dot(hingeX, z))    // hingeX = house +X axis
  barrel.M = basis(x, cross(z, x), z, origin A)
  rod.M    = basis(x, cross(−z, x), −z, origin B)                    // the rod points back at A
  ```
  The two always point at each other's anchors, so they telescope exactly. Size them from the pin-distance range
  `[dmin, dmax]` of `|B − A|` over the joint limits (`rig.jointRanges`): `barrelLen = floor(dmin − rodEyeR − 0.8)` and
  `rodLen = floor(dmin − barrelR − 0.8)`, so neither pokes past the opposite pin when fully retracted. Fail the build
  when `barrelLen + rodLen < dmax + 3`, because the pair would then separate at full extension.
- **Wheels decoupled from suspension.** Compose each wheel in **world space** from its rest hub, not as a child of the
  body:
  ```
  wheel.M = C · T(hub) · Rz(steer) · Rx(spin)     // C = car frame (root yaw + travel); Rx(spin): rolling −Y = +rotX
  body.M  = C · T(bodyPivot + lift) · Ry(roll) · Rx(pitch)
  ```
  The body rolls, pitches and lifts on its suspension while the tyres stay planted on `z = 0`. Front wheels steer
  (the Cybertruck's 4-wheel steer uses `steerR = −steerF/3`); every spin term uses whole turns per clip, so loops stay seamless.
- Keep the rig's own FK clips valid without the plugin (cylinders rigid but aligned at rest), so `svox_cli validate`
  and engines without a motion plugin still see a sane pose.
