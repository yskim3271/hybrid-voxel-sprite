---
name: hybrid-voxel-sprite
description: >-
  Build real-time articulated 3D pixel-art sprite renderers using modular voxel
  parts, per-part OBB 3D volume raymarching, analytic per-slice inverse
  deformation (squash/twist/shear/wave), spring secondary motion, dynamic 3D
  cel lighting/AO/self-shadow, pixel-perfect virtual grid snapping, and 1px
  depth/normal auto-outlines. Includes an engine-neutral SVOX asset pipeline CLI
  (.vox and slice-strip import, 3D normal/AO baking, rig validation) plus target
  adapters for WebGL2/Three.js (Verified), Godot 4, Unity URP, and Blender export.
---

# Hybrid Voxel Sprite (T3) — v1.1

This skill describes how to build **T3 Hybrid Articulated 3D Voxel Sprite-Stacking**. It is distilled from a working
WebGL2 renderer (`src/renderers/hybrid/hybrid_renderer.js` in the origin repo) and its QA record. A character is a
set of small voxel **parts** (torso, arm, cape and so on). Each part is a `TEXTURE_3D`. At runtime:

1. FK, IK and springs pose the part matrices.
2. Each part is raymarched inside its own oriented box (OBB).
3. A per-slice deformation (squash, twist, shear, wave) is undone analytically at every sample.
4. The result is lit with cel bands and baked AO, written into a low-resolution "virtual pixel" G-buffer, then blitted
   with NEAREST filtering and a 1px outline.

Every formula in `references/` is a port of verified code. Where the verified code differs from earlier spec text,
the code wins and the difference is called out.

## 1. Overview and honest performance positioning

- **What it saves:** 3D asset and animation production cost. Artists paint voxels (MagicaVoxel, slice strips or
  Blender) and rig *rigid parts* with pivots. There is no UV unwrapping, no retopology and no skin weights.
  - Squash, stretch, cloth wave and twist come from 8 deform scalars per part.
  - Secondary motion comes from damped springs.
- **What it costs:** GPU raymarching costs more per pixel than rasterizing a low-poly mesh. Each covered virtual pixel
  runs a 0.35-voxel march with 6-step bisection, a 12-step self-shadow ray and 4–6 extra texture reads for the normal.
- **Why it still hits 60 fps:** pass 1 renders at `floor(viewport / pixelScale)`, so a 640×360 view at ×3 is only
  213×120 = 25.6k virtual pixels.
  - Measured with a 1×1 `readPixels` closing each frame, on a GTX 1080 (D3D11), 640×360 @×3: **0.8 ms** median for
    the 3-part reference and **0.9 ms** for the 13-part knight.
  - The same frames take 18–21 ms on SwiftShader (CPU).
  - Do not time with `gl.finish()`; see the pitfalls file.
- **Where it shines:** isometric, top-down and side-view games where sprites are pixel-scale and many characters share
  the screen.
- **Where it does not:** full-screen close-ups on low-end mobile. Cost scales with *covered virtual pixels × march
  length*, so a sprite filling a 1080p screen at `pixelScale = 1` is the worst case. Raise `pixelScale` or cap the
  sprite's on-screen size.

## 2. Why T3 hybrid (not naive stacking or baked volumes)

- **Card or slice stacking breaks at low pitch and on thin edges.** Stacked 2D slices open visible gaps between layers
  as the camera drops toward side-on (14° and below). A one-voxel-thick blade turns into a dotted line when it rotates.
  T3 raymarches a real 3D volume, so there are no slice cracks: G1 measured 0 at 14° and 33°, and the original
  track 2/3 QA swept pitch from 5° to 83°.
- **Baked merged volumes blur rotated thin details.** Re-voxelising a posed rig every frame, or baking keyframes,
  resamples the parts with nearest-neighbour sampling. Rotated swords and shield rims come out stair-stepped or lumpy,
  and morphing between keyframes punches holes in thin sheets. T3 samples the *original* part volumes in each part's
  own space, so detail stays crisp under any rotation.
- **Per-part OBB plus analytic inverse deform keeps rigging cheap and occlusion exact.** Parts can interpenetrate. Every
  hit writes `gl_FragDepth` from the exact world hit point, so draw order is irrelevant: reversing the part order
  changes 0 pixels. Deformation never needs re-voxelising, because its inverse is closed-form.

## 3. Target routing table (progressive disclosure)

Load only what the task needs. All four target files assume `01` and `02`.

| Task | Load |
|---|---|
| Coordinates, pivots, rig.json, IK, springs, deform formulas | [references/01_contract_and_math.md](references/01_contract_and_math.md) |
| Writing or porting the 2-pass shaders | [references/02_shader_pipeline_spec.md](references/02_shader_pipeline_spec.md) |
| Debugging artifacts, or running the QA gates | [references/03_pitfalls_and_qa_gates.md](references/03_pitfalls_and_qa_gates.md) |
| Browser: raw WebGL2 or Three.js (r187) | [webgl2_threejs.md](references/targets/webgl2_threejs.md) — **✅ Verified** |
| Godot 4.7.2 (Forward+ & Mobile Vulkan) | [godot4.md](references/targets/godot4.md) — **✅ Verified** |
| Unity 6 URP (6000.5.3f1, D3D11 & D3D12) | [unity_urp.md](references/targets/unity_urp.md) — **✅ Verified** |
| Blender 5.3.0 as asset source | [blender_exporter.md](references/targets/blender_exporter.md) — **✅ Verified** (extraction bridge) |

Pick **one** target file. Do not port to an experimental target and claim it works until the four gates below pass
on that engine.

## 4. Five-step end-to-end workflow

1. **Scope and target selection.**
   - Pick the camera band: iso 33° (0.58 rad, the default) or low 14°.
   - Pick the `pixelScale` (3 is the default) and the target engine (§3).
   - Budget roughly 10–15 parts per character.
   - Parts must be **at least 2 voxels thick**, and need a 1-voxel empty margin on their X, Y and top faces.
2. **Asset preparation** (`scripts/svox_cli.py`).
   - Import `.vox` files (`from-vox`) or slice strips (`from-strip`).
   - Run `bake-normal-ao`, then `validate`.
   - Pack for the engine (`pack-atlas`).
   - Start from the reference bundle in [assets/minimal_reference/](assets/minimal_reference/rig.json): a torso, an
     arm with a 2-voxel blade, and a flipped cape.
   - **v1.1: anchor non-trivial characters and vehicles on a 3-view turnaround** (`front / 3-4 / side`, MagicaVoxel
     style), generated or supplied, and iterate a multi-round render-and-compare visual-diff loop. Blind procedural
     sculpting comes out flat and toy-like ([03 pitfall 19](references/03_pitfalls_and_qa_gates.md)).
   - **v1.1: size cameras by multi-clip framing**: the union of the rest pose and every clip, so booms, jumps and drifts
     never clip ([01 §9](references/01_contract_and_math.md#9-multi-clip-framing--hard-surface--mechanical-rigging)).
   - **v1.1 optional:** up to 6 `emissiveColors[]` slots plus per-part `emissive` for lights, beacons and cores
     ([01 §3.1](references/01_contract_and_math.md#31-v11-emissive-schema-optional)).
3. **Rig and deform integration.**
   - Evaluate `rig.json` clips into a pose: for each part, a `matrix`, an `invMatrix` and 8 deform scalars.
   - Layer IK (`solveTwoBoneIK`) and `SpringVec3` secondary motion on top. Drive cloth shear and wave from spring
     velocity.
   - Children attach to the parent's **deformed** surface. Use flipped cloth for capes and robes.
   - See [01 §4–§8](references/01_contract_and_math.md).
4. **Two-pass T3 renderer implementation.**
   - Pass 1 is a low-resolution MRT G-buffer: colour, world normal with a foreground mask, and a `DEPTH_COMPONENT24`
     depth texture. It contains the per-part deformed-AABB proxy with front faces culled, the exact slab test, the
     inverse-deformed march, `gl_FragDepth`, cel lighting, the self-shadow ray and per-part ground shadows.
   - Pass 2 is a full-resolution `texelFetch` blit plus the 1px outline.
   - See [02](references/02_shader_pipeline_spec.md).
   - **v1.1, multi-part rigs (10–20+ parts):** add the D24 depth-bucket tie-break (`uDepthSlot` / `uDepthSlots`) so
     coplanar joints never resolve by draw order
     ([02 §8](references/02_shader_pipeline_spec.md#8-v11-d24-depth-bucket-tie-break-udepthslot--udepthslots)), and
     the 6-slot emissive and glow-halo contract ([02 §9](references/02_shader_pipeline_spec.md)).
   - **v1.1, 3D worlds and showcases:** the Perspective MRT hybrid mode (Three.js world meshes and T3 parts share one
     depth buffer), actor-masked cinema post-FX, and the live `SPRITE STACK` view (`mode == 2`). See
     [02 §10](references/02_shader_pipeline_spec.md#10-v11-debug--showcase-view-modes) and
     [webgl2_threejs.md §4.5](references/targets/webgl2_threejs.md#45-perspectivecamera--3d-world-mrt-hybrid-recipe-v11).
5. **Mandatory four-gate verification** (§7), with screenshots inspected by eye. A gate that is not measured counts as
   failed.

## 5. CLI quick reference (`scripts/svox_cli.py`)

The CLI is Python 3 standard library only, so nothing needs installing. Both `uv run scripts/svox_cli.py …` and
`python scripts/svox_cli.py …` work. Outputs go to files, stdout carries a short summary (fewer than 30 lines), and the
exit code is 1 on errors.

```bash
# minimal 3-part reference bundle (+ sample_cube.vox), already baked
uv run scripts/svox_cli.py init-demo --out assets/minimal_reference
# MagicaVoxel: single model, or multi-model scene graph (nTRN/nGRP/nSHP) split into one part per shape node
python scripts/svox_cli.py from-vox --input hero.vox --out build/hero [--part-name body] [--rotate-z180] [--bake]
# classic horizontal slice strip: width = X*Z, height = Y (slice z at columns z*X..)
python scripts/svox_cli.py from-strip --input sword.png --size-x 7 --size-y 4 --size-z 20 --out build/hero \
    --part-name sword --pivot 3.5,2,3.5 [--parent armR_lower --rest-offset 0,0,-6] [--flipped-cloth] [--bake]
# 3x3x3 Sobel normals + front-hemisphere AO + 1-voxel shell dilation -> parts/<name>.normal_ao.png, bake_stats.json
python scripts/svox_cli.py bake-normal-ao --bundle build/hero
# schema, strip dims, unit/outward normals, thin parts, ground contact, loop seams, undeform(deform(p)) < 1e-5
python scripts/svox_cli.py validate --bundle build/hero --output build/hero_report.json
# engine packing: strip_x PNG | grid_2d flipbook PNG | raw_3d RGBA8 .bin (+ manifest.json)
python scripts/svox_cli.py pack-atlas --bundle build/hero --format raw_3d --out build/hero_raw3d
```

The **SVOX bundle** is `rig.json` (schema `svox.rig/v1`) plus `parts/<name>.albedo.png` and
`parts/<name>.normal_ao.png`, both in the `strip_x` layout.
- `rig.json` holds the coordinates, `targetHeight`, `parts[]` and `clips[]`.
- In `normal_ao.png`, RGB is `n*0.5+0.5` and alpha is AO visibility.
- The full schema is in [01 §3](references/01_contract_and_math.md).

## 6. Top 7 critical pitfalls

Each one was found the hard way. Details and fixes are in
[03_pitfalls_and_qa_gates.md](references/03_pitfalls_and_qa_gates.md).

1. **MRT `INVALID_OPERATION` (Chrome/ANGLE).** With 2 draw buffers bound, every fragment shader must declare
   `layout(location = 1) out`, or every draw fails. Draw single-output passes with `drawBuffers([C0, NONE])`.
2. **`gl.finish()` does not block in Chrome.** Timings come out at about 1 ms that are really about 180 ms. Close each
   frame with a 1×1 `readPixels` or use timer queries.
3. **Convex staircase AO false darkening.** Count only AO cells clearly in front of the true normal
   (`dot(offset, n) > 0.75`), or every voxel staircase turns grey.
4. **`CLAMP_TO_EDGE` edge bleed.** LINEAR sampling at the grid border repeats the edge voxel. Multiply by `edgeMask()`
   to emulate zero padding, and leave a 1-voxel empty margin.
5. **One-voxel-thin parts break up.** Blades and wing membranes dissolve into dots when rotated or baked. Make them
   2 voxels thick; `validate` warns at more than 25% thin voxels.
6. **Uniformly scaled part matrices.** Never assume an orthonormal `mat3(invMatrix)`: renormalise the ray direction,
   transform normals with `transpose(mat3(invMatrix))`, and keep instances that share a scaled part close together.
7. **Loop seams.** Clips must be exactly periodic: whole cycles per loop, and phase ramps in multiples of 2π.
   `validate` measures `pose(0)` against `pose(duration)`.

## 7. Four mandatory quality gates

The full definitions and harness are in
[03 §2](references/03_pitfalls_and_qa_gates.md#2-the-four-mandatory-qa-gates).

| Gate | Pass threshold | Reference result (minimal_reference, GTX 1080 and SwiftShader) |
|---|---|---|
| **G1 Low-pitch 14° zero-gap** | 0 slice-crack texels. Every enclosed background texel is re-traced on the CPU, and it counts as a crack if the exact ray crosses solid (alpha ≥ 0.75). | 0 cracks / 192 renders (14° and 33°); detector self-test 6/6 |
| **G2 Sub-texel pixel-snap: 0 px crawl** | A root shift under half a virtual texel changes **0** output pixels with snap on, and more than 0 with snap off. | 0/0/0 px on; 9–21k px off |
| **G3 `undeform(deform(p))`** | max error **< 1e-5** over ≥ 200 samples (CPU, and the GPU formula is identical) | 1.8e-15 (JS), 9.9e-16 (`validate`) |
| **G4 Ground / loop / occlusion** | The rest pose's lowest voxel lies within ±0.5 of z = 0, and no clip dips below −0.5. The loop seam is < 1e-3. Reversing the part draw order changes 0 px, and turning the z-buffer off changes more than 0 px. | lowest z 0.000; seam 2e-15; 0 px reorder diff |

Do not ship a target without all four gates **and** a by-eye inspection of an iso 33° and a low 14° screenshot.

## Files

- [scripts/svox_cli.py](scripts/svox_cli.py): the stdlib-only SVOX pipeline. It contains byte-exact ports of the
  verified normal/AO bake and the deform math.
- [assets/minimal_reference/rig.json](assets/minimal_reference/rig.json): a 3-part reference rig with two clips,
  `idle` and `swing`. Its `parts/*.png` are baked strips, and
  [sample_cube.vox](assets/minimal_reference/sample_cube.vox) is a binary `.vox` test asset.
- `references/`: [01](references/01_contract_and_math.md) contract and math, [02](references/02_shader_pipeline_spec.md)
  shaders, [03](references/03_pitfalls_and_qa_gates.md) pitfalls and gates, and `targets/` holds one adapter per engine.
