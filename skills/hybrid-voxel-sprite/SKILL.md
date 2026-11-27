---
name: hybrid-voxel-sprite
description: >-
  Build real-time articulated 3D pixel-art sprite renderers using modular voxel
  parts, per-part OBB 3D volume raymarching, analytic per-slice inverse
  deformation (squash/twist/shear/wave), spring secondary motion, dynamic 3D cel
  lighting/AO/self-shadow, pixel-perfect virtual grid snapping, and 1px
  depth/normal auto-outlines. Includes an engine-neutral SVOX asset pipeline CLI
  (.vox and slice-strip import, 3D normal/AO baking, rig validation) plus target
  adapters for WebGL2/Three.js (Verified), Godot 4, Unity URP, and Blender export.
  v2.0-v2.3 add a Megastructure / Capital Ship track for ~1000-unit ships: 3-view
  visual-hull carving, detail-zone callouts, macro/meso/micro multi-scale greedy
  meshes with instanced prefabs, dual-scale AO, the svox.mega/v2.2 packed20 (20
  B/vert) and v2.3 quad16 (16 B/quad instanced, no index buffer) formats, a 12 MiB
  hero budget, faction materials (matTag 6/7/8), multi-cue and hull-only G5
  concept-diff gates and a G6 perf gate, via zero-dependency Node scripts
  (69-check self-test).
---

# Hybrid Voxel Sprite (T3) — v2.3

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

**v2.0** adds a second track for ~1000 u **capital ships and megastructures**
([04](references/04_megastructure_voxel_pipeline.md)), which are rasterised as pre-baked multi-scale greedy meshes
rather than raymarched. Everything below about articulated T3 sprites is unchanged from v1.1.

**v2.2** (capital track only, [04 §12](references/04_megastructure_voxel_pipeline.md#12-v22--20-bvert-quantized-packing-g5-v22-multi-cue-gate-4-pass-sculpt-loop-studio-harness-hard-surface-shader)):
`svox.mega/v2.2` **20 B/vertex** `packed20` (Int16 position + bevelHint, Int8 normal + micro AO, Uint8 colour + emissive,
Uint8 matTag / macro AO / creaseMask / panelId) with Uint16 indices — 2.4× the v2 geometry inside the same 4 MiB;
**G5-v2.2** multi-cue gate (Silhouette IoU + internal Edge F1 / chamfer + amber / cyan Band distribution) so a flat
interior can no longer pass on its outline; a **4-pass sculpt loop** (clay → primary armour → meso kitbash → lookdev)
judged in a real-engine **studio harness**; and the **70/30 visual-rest** hard-surface shader (no uniform brick tiling).

**v2.3** (capital track only, [04 §13](references/04_megastructure_voxel_pipeline.md#13-v23--quad16-16-bquad-instanced-quads-12-mib-hero-budget-faction-materials-hull-only-g5)):
`svox.mega/v2.3` **`quad16`** — every greedy quad of a macro part is ONE 16-byte instance of a shared unit quad (Uint16×3
integer voxel origin, Uint8×2 size, Uint8×4 colour + emissive, Uint8×4 dir / bevelQ / creaseQ / diagFlip · 4-corner micro AO ·
256-level macro AO · matTag | panelId), drawn with one `drawElementsInstanced` per part: **no index buffer, no 65 535-vertex
cap, 5.75× below v2.2's 92 B/quad** (≈ 5× measured on curved organic hulls), exact lattice positions, triangle-for-triangle
identical to the v2.2 mesher. Meso prefabs stay `packed20` in the same .json/.bin. **`MEGA_V23_BUDGET`**: 12 MiB · 16 draws
· 1.2 M tris · Δ 2.5 ms. **Faction-scoped materials**: matTag 6 organic chitin, 7 ornate gold & ivory temple, 8
bio-luminescent cavity (Vanguard keeps 0–6 incl. its hangar bounce). **G5-v2.3 hull-only** silhouette IoU (≥ 0.86) locks a
tentacled hull's dome / jaw independently of curling appendages.

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
| **v2.0 Megastructure / capital ship** (~1000 u: macro 3–4 u/vox hull + instanced 1.2–2 u/vox meso prefabs + shader micro detail) | [04_megastructure_voxel_pipeline.md](references/04_megastructure_voxel_pipeline.md) — **kit ✅ self-tested (69/69); verified on 3 v2.3 hero capitals (Vanguard T2, Aether P2, Swarm Z2)**; G5/G6 must still pass per ship in-engine |

Pick **one** target file. Do not port to an experimental target and claim it works until the four gates below pass
on that engine.

The megastructure track (04) is self-contained. It rasterises pre-baked greedy meshes with hardware depth instead of
raymarching parts, so it needs `01` and `02` only when the same scene also contains T3 actors.

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

**v2.0 Megastructure track (capital ships of about 1000 u).** Do not push a capital ship through steps 2–4, because
per-part raymarching and 40–96-voxel parts do not scale to it. Follow
[04](references/04_megastructure_voxel_pipeline.md) instead:

- **1A** Generate orthographic Top / Side / Front views anchored on the approved 3/4 concept, then carve the 3-view
  visual hull (fidelity ≥ 0.90 per view).
- **1B (mandatory)** List every occluded cavity and hero zone in `detail_zones.json`, with one zoomed callout sheet
  per zone, and carve the cavities. A 3-view hull cannot see hangars, trenches, bores or maws.
- **2** Split the ship into tiers:
  - **Macro** hull at 3–4 u/vox.
  - **Meso** kitbash prefabs at 1.2–2 u/vox, drawn as `InstancedMesh`, one draw per type.
  - **Micro** surface detail (seams, rivets, scale-cue micro-windows) in the fragment shader, with no `discard` and
    no `gl_FragDepth`.
- **3** Pack micro voxel AO together with macro cavity AO into the `MEGA_V2` format (12 floats, V12-compatible) — or,
  v2.2, `format: 'MEGA_V22'` → `svox.mega/v2.2` 20 B/vert `packed20` + Uint16 indices (split big hulls with `region`) —
  or, v2.3 (curved / organic hulls, hero capitals), `format: 'MEGA_V23'` → `svox.mega/v2.3` `quad16` macro parts (16 B/quad,
  one instanced draw per part, `macroLevels` up to 256) + `packed20` meso prefabs.
- **4** Pass the **G5** concept diff — v2.2: the multi-cue **G5-v2.2** (silhouette + internal edge F1 + accent band),
  sculpted in 4 passes (clay → primary armour → meso kitbash → lookdev), each with a sheet. v2.3: tentacled / appendage-heavy
  ships add the **hull-only** IoU (`computeHullSilhouetteIoU`, ≥ 0.86) on the carapace.
- **5** Pass the **G6** performance budget (v2.2: `MEGA_V22_BUDGET`, runtime Δ ≤ 1.5 ms; v2.3: `MEGA_V23_BUDGET`, 12 MiB /
  16 draws / 1.2 M tris / Δ ≤ 2.5 ms).

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

### v2.0 megastructure scripts (Node ≥ 18, zero npm dependencies)

`scripts/mega_voxel_kit.mjs` is the library and CLI for the visual hull, detail zones, macro cavity AO, the greedy
mesher, the `svox.mega/v2` packer and a CPU preview. `scripts/mega_diff_utils.mjs` holds the PNG codec, Silhouette IoU
and comparison sheets. Both are importable ES modules. Each exits 1 on errors or on a failed target.

```bash
node scripts/test_mega_kit.mjs                     # self-test: 69 checks (v2.0 39 + v2.2 16 + v2.3 14), ~13 s, temp files only in os.tmpdir()
# Stage 1B: archetype template → edit bounds → validate (hard_surface_carrier | halo_mothership | bio_leviathan)
node scripts/mega_voxel_kit.mjs zones-template --archetype hard_surface_carrier --hull-size 478,1019,302 --out build/v/detail_zones.json
node scripts/mega_voxel_kit.mjs validate-zones --zones build/v/detail_zones.json --hull-size 478,1019,302
# Stage 1A + 2 + 3: blueprint PNGs → visual hull → zone carves → macro AO → greedy MEGA_V2 → .json + .bin
node scripts/mega_voxel_kit.mjs hull --top bp_top.png --side bp_side.png --front bp_front.png --length-y 1019 \
    --voxel-scale 3.5 --zones build/v/detail_zones.json --out build/v/hull
node scripts/mega_voxel_kit.mjs inspect --asset build/v/hull.json            # stats + static G6 checks
node scripts/mega_voxel_kit.mjs preview --asset build/v/hull.json --view hero34 --out build/v/hero.png
node scripts/mega_voxel_kit.mjs demo --out build/mega_demo                   # synthetic carrier: macro + meso + zones
node scripts/mega_voxel_kit.mjs demo --v22 --out build/mega_demo22           # same carrier as svox.mega/v2.2 (20 B/vert): 473 → 204 KiB
node scripts/mega_voxel_kit.mjs demo --v23 --out build/mega_demo23           # svox.mega/v2.3 quad16 macro + packed20 meso, matTag 6/7/8 swatches: 56 KiB
#   (--name ID --asset-only writes just ID.json + ID.bin, e.g. straight into an engine's asset folder; --faction-tags for v2 / v2.2)
# Stage 4 (G5): concept vs render silhouette IoU and side-by-side sheets
node scripts/mega_diff_utils.mjs iou --ref concept_34.png --render render_34.png --target 0.78 --diff qa/hero_diff.png
node scripts/mega_diff_utils.mjs sheet --pairs qa/g5_pass2.json --out qa/g5_pass2.png --title "VANGUARD T2 PASS 2"
# v2.2 G5 multi-cue: silhouette IoU + internal edge F1 / chamfer (with its chance level) + amber / cyan band check
node scripts/mega_diff_utils.mjs multicue --ref concept_34.png --render render_34.png --kind hero --out qa/g5_multicue.png
# v2.3 G5 hull-only: carapace IoU independent of tentacle curl (explicit hull masks, or automatic opening + largest blob)
node scripts/mega_diff_utils.mjs hull --ref side.png --render side_render.png --ref-hull side_hull.png --render-hull side_render_nowave.png --target 0.86
```

For production ships, write a small builder that imports the kit (`VoxelGrid` CSG → `carveVisualHull` →
`applyDetailZoneCarves` → prefabs and `instances[]` → `packMegaAsset` → `writeMegaAsset`). The API table is in
[04 §9](references/04_megastructure_voxel_pipeline.md#9-kit-api-and-cli-scriptsmega_voxel_kitmjs-scriptsmega_diff_utilsmjs).

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

### v2.0 megastructure gates (capital ships; any T3 actors in the same scene still need G1–G4)

| Gate | Pass threshold | Reference result |
|---|---|---|
| **G5 Concept Diff & Detail-Zone** | Renders from the concept's hero 3/4 camera, the ortho Top / Side / Front views, and every `detail_zones.json` camera. `[concept or callout \| render \| IoU mask]` sheets via `mega_diff_utils.mjs`. Silhouette IoU **≥ 0.78 hero 3/4** and **≥ 0.85 per ortho view**, every zone's `requiredFeatures` visibly present, ≥ 2 measured refinement passes (macro → meso → micro), sheets inspected by eye. **v2.2 multi-cue:** + internal **Edge F1 ≥ 0.52 hero / ≥ 0.55 ortho average** (radius 2 px, report the chance level) + **Band** amber / cyan share ratio 0.5–2.0 and centroid Δ ≤ 0.16. **v2.3 hull-only** (tentacled / organic): carapace **Hull IoU ≥ 0.86** via `computeHullSilhouetteIoU` (explicit hull masks — concept with appendages painted out + render with the `wave` part excluded — or automatic opening + largest blob, re-registered on the hull bbox). | Kit self-test: framing-registered IoU 0.989; a 1.3 : 1 proportion drift is caught (0.767); a flat interior with an identical outline (IoU 1.000) fails Edge (F1 0.47); curled tentacles: full IoU 0.30 → hull 0.993, a flattened dome still fails (0.77). Vanguard T2 v2.2: see 04 §12.4. |
| **G6 Megastructure Perf** | ≤ 12 draw calls (1–3 macro + ≤ 9 instanced meso batches), ≤ 120k total triangles (meso unique ≤ 60k), `.bin` ≤ 4.0 MB, Early-Z 100 % alive (no `discard` / `gl_FragDepth` in the FINAL program), GPU frame delta < 1.0 ms @ 60 fps, readPixels-bracketed with the ship on vs off. **v2.2 (`MEGA_V22_BUDGET`):** ≤ 11 meso batches, ≤ 288k total / 144k unique meso triangles, `.bin` ≤ 4 MiB, Δ ≤ 1.5 ms. **v2.3 (`MEGA_V23_BUDGET`):** `.bin` ≤ **12 MiB**, ≤ **16** draws (1–8 macro), ≤ **1.2 M** triangles, Δ ≤ **2.5 ms**. | Demo carrier, static checks: 3 draws, 8.5k tris, 473 KiB (v2.2: 204 KiB; v2.3: 56 KiB, macro 189 → 41 KiB). Runtime checks are unmeasured until they run in an engine, and unmeasured counts as failed. V12 single-grid capitals: +0.10–0.31 ms. Vanguard T2 v2.2: 10 draws, 177.9k tris, 3.457 MiB, Δ ≈ 0.45–0.55 ms. **v2.3 Ultra-HD (measured):** Vanguard T2 v2.3: 10 draws, 410k tris, 8.93 MiB, Δ 0.79 ms · Aether P2 v2.3: 9 draws, 802k tris, 6.02 MiB, 0.3 ms CPU · Swarm Z2 v2.3: 5 draws, 1.11M tris, 8.03 MiB, 0.7 ms CPU. |

## Files

- [scripts/svox_cli.py](scripts/svox_cli.py): the stdlib-only SVOX pipeline. It contains byte-exact ports of the
  verified normal/AO bake and the deform math.
- [assets/minimal_reference/rig.json](assets/minimal_reference/rig.json): a 3-part reference rig with two clips,
  `idle` and `swing`. Its `parts/*.png` are baked strips, and
  [sample_cube.vox](assets/minimal_reference/sample_cube.vox) is a binary `.vox` test asset.
- `references/`: [01](references/01_contract_and_math.md) contract and math, [02](references/02_shader_pipeline_spec.md)
  shaders, [03](references/03_pitfalls_and_qa_gates.md) pitfalls and gates, and `targets/` holds one adapter per engine.
- **v2.0:** [04_megastructure_voxel_pipeline.md](references/04_megastructure_voxel_pipeline.md) is the 6-stage capital
  ship pipeline. It covers schemas, AO math, the `MEGA_V2` layout, shader snippets, G5/G6 and pitfalls M1–M15 (v2.1 adds M13–M15, the zoomed close-up craft rules).
  **v2.2** adds §12: `svox.mega/v2.2` packed20, mesher bevel / crease / panel tags, G5-v2.2 multi-cue, the 4-pass sculpt
  loop + studio harness, the 70/30 hard-surface shader and pitfalls M16–M19. **v2.3** adds §13: `quad16` (16 B/quad
  instanced quads), `MEGA_V23_BUDGET` (12 MiB), faction matTag 6 / 7 / 8, hull-only G5 and pitfalls M20–M23.
- **v2.0:** [scripts/mega_voxel_kit.mjs](scripts/mega_voxel_kit.mjs) is the megastructure voxel kit and CLI, and
  [scripts/mega_diff_utils.mjs](scripts/mega_diff_utils.mjs) holds the PNG, IoU and sheet tools.
  [scripts/test_mega_kit.mjs](scripts/test_mega_kit.mjs) is their self-test: 69 checks (39 v2.0 + 16 v2.2 + 14 v2.3), exit 0 when
  everything passes.
