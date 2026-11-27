---
name: hybrid-voxel-sprite
description: >-
  Build real-time voxel renderers for 3D pixel-art games, on two tracks. Track A,
  articulated voxel sprites (characters, creatures, vehicles): modular voxel parts
  raymarched per part inside oriented boxes, analytic squash/twist/shear/wave
  deformation, spring secondary motion, cel lighting with AO and self-shadow,
  pixel-perfect virtual-grid snapping and 1px outlines, plus an engine-neutral
  SVOX asset CLI (.vox and slice-strip import, normal/AO baking, rig validation)
  and adapters for WebGL2/Three.js, Godot 4, Unity URP and Blender. Track B,
  megastructures and large vessels (~500-1500 units): 3-view visual-hull carving,
  detail-zone callouts, multi-scale greedy meshes (16-byte quad16 macro quads,
  instanced packed20 meso prefabs, procedural micro shader), dual-scale AO, a
  12 MiB budget, and concept-diff and performance gates, via zero-dependency Node
  scripts.
---

# Hybrid Voxel Sprite

Render voxel art in real time so that it reads as crisp 3D pixel art. The skill has two tracks that share the same
look (cel lighting, baked AO, 1 px ink outlines) but use different rendering techniques, because a 60-voxel character
and a 1000-unit capital ship have opposite problems.

## 1. Which track should you use?

| | **Track A — Articulated voxel sprites** | **Track B — Megastructures and large vessels** |
|---|---|---|
| **Build this** | Characters, creatures, vehicles, small craft: anything that moves like a body. 10–15 parts of 40–96 voxels each | Static or slowly animated structures of ~500–1500 u: carriers, temple vessels, leviathans, fortresses, stations, landmarks |
| **How it renders** | Per-part OBB raymarching of 3D voxel textures + analytic inverse deformation + damped springs, into a low-res "virtual pixel" G-buffer with a 1 px outline | Multi-scale greedy meshes with hardware depth: `quad16` macro hull (16 B/quad, 1 instanced draw per part) + instanced `packed20` meso prefabs + a procedural micro-detail shader |
| **Asset workflow** | 3-view turnaround → MagicaVoxel / slice strips / Blender → `scripts/svox_cli.py` | Concept + 3-view blueprints → visual hull + `detail_zones.json` → 4-pass sculpt → `scripts/mega_voxel_kit.mjs` |
| **Read** | [01](references/01_contract_and_math.md), [02](references/02_shader_pipeline_spec.md), [03](references/03_pitfalls_and_qa_gates.md) + one engine adapter | [04](references/04_megastructure_voxel_pipeline.md) (self-contained) |
| **Quality gates** | G1–G4 | G5–G6 (plus G1–G4 for any Track A actors in the same scene) |

Rule of thumb: if it has joints, use Track A. If it is bigger than the camera's framing of a character and mostly
rigid, use Track B. Never push a megastructure through Track A: per-part raymarching and 40–96-voxel parts do not scale
to it.

## 2. Why this architecture works (and when not to use it)

**Track A.**
- **What it saves:** 3D asset and animation production cost. Artists paint voxels (MagicaVoxel, slice strips or
  Blender) and rig *rigid parts* with pivots. There is no UV unwrapping, no retopology and no skin weights. Squash,
  stretch, cloth wave and twist come from 8 deform scalars per part; secondary motion comes from damped springs.
- **No slice cracks.** Stacked 2D slices open gaps between layers as the camera drops toward side-on (14° and below),
  and a one-voxel blade turns into a dotted line when it rotates. Track A raymarches a real 3D volume: G1 measured 0
  cracks at 14° and 33°, and an earlier QA sweep covered pitch 5°–83°.
- **Crisp under rotation.** Re-voxelising a posed rig, or baking keyframes, resamples parts with nearest-neighbour and
  stair-steps rotated swords and shield rims. Track A samples the *original* part volumes in each part's own space.
- **Exact occlusion, cheap rigging.** Every hit writes `gl_FragDepth` from the exact world hit point, so reversing the
  part draw order changes 0 pixels; the deformation inverse is closed-form, so nothing is re-voxelised.
- **What it costs:** raymarching costs more per pixel than rasterising a low-poly mesh (a 0.35-voxel march with 6-step
  bisection, a 12-step self-shadow ray and 4–6 extra texture reads per covered virtual pixel). It still hits 60 fps
  because pass 1 runs at `floor(viewport / pixelScale)`: 640×360 at ×3 is 213×120 = 25.6k virtual pixels, measured at
  **0.8 ms** (3-part reference) and **0.9 ms** (13-part knight) on a GTX 1080 (D3D11) with a 1×1 `readPixels` closing
  each frame; 18–21 ms on SwiftShader (CPU). Never time with `gl.finish()`.
- **Where it does not fit:** full-screen close-ups on low-end mobile. Cost scales with *covered virtual pixels × march
  length*, so a sprite filling a 1080p screen at `pixelScale = 1` is the worst case; raise `pixelScale` or cap the
  sprite's on-screen size.

**Track B.**
- **Scale without blockiness.** One voxel grid for a 1000 u ship is either huge or blocky. Track B splits detail into
  tiers: a 1.6–2.5 u/vox macro hull, 0.8–1.5 u/vox instanced kitbash prefabs (geometry stored once, 76 B per copy) and
  shader micro-detail at 0 triangles.
- **Cheap to draw.** `quad16` stores each greedy quad in 16 bytes with no index buffer (5.75× smaller than a 20 B/vertex
  indexed mesh) and draws a whole part in one instanced call. Measured hero assets: 5–10 draws, 0.4–1.1 M triangles,
  6–9 MiB, ≤ 0.8 ms.
- **Faithful to the concept.** Three orthographic views pin the proportions, `detail_zones.json` recovers the cavities a
  silhouette cannot see, and G5 measures silhouette, internal edges and accent colours against the concept.
- **Where it does not fit:** deforming, articulated bodies (use Track A), or terrain-scale worlds that need streaming
  and LOD beyond one asset's 12 MiB budget.

## 3. Reference routing table

Load only what the task needs.

| Task | Load |
|---|---|
| Track A: coordinates, pivots, `rig.json`, IK, springs, deform formulas | [references/01_contract_and_math.md](references/01_contract_and_math.md) |
| Track A: writing or porting the 2-pass shaders | [references/02_shader_pipeline_spec.md](references/02_shader_pipeline_spec.md) |
| Track A: debugging artifacts, or running G1–G4 | [references/03_pitfalls_and_qa_gates.md](references/03_pitfalls_and_qa_gates.md) |
| Track A engine: raw WebGL2 or Three.js (r187) | [webgl2_threejs.md](references/targets/webgl2_threejs.md) — **✅ Verified** |
| Track A engine: Godot 4.7.2 (Forward+ & Mobile Vulkan) | [godot4.md](references/targets/godot4.md) — **✅ Verified** |
| Track A engine: Unity 6 URP (6000.5.3f1, D3D11 & D3D12) | [unity_urp.md](references/targets/unity_urp.md) — **✅ Verified** |
| Track A asset source: Blender 5.3.0 | [blender_exporter.md](references/targets/blender_exporter.md) — **✅ Verified** (extraction bridge) |
| Track B: the whole megastructure pipeline, formats, shaders, G5/G6, pitfalls M1–M23 | [04_megastructure_voxel_pipeline.md](references/04_megastructure_voxel_pipeline.md) — **kit ✅ self-tested (78/78)**; loader + shaders verified in the reference WebGL2 / Three.js implementation; G5/G6 must still pass per asset in your engine |

The four Track A target files assume `01` and `02`. Pick **one** target and do not claim a port works until G1–G4 pass
on that engine. Track B needs `01`–`03` only when the same scene also contains Track A actors.

## 4. Step-by-step workflows

### Track A — articulated voxel sprites (5 steps)

1. **Scope the sprite and pick the target.**
   - Camera band: iso 33° (0.58 rad, the default) or low 14°. `pixelScale` 3 is the default.
   - Budget roughly 10–15 parts per character. Parts must be **at least 2 voxels thick** and need a 1-voxel empty
     margin on their X, Y and top faces.
   - Pick the engine adapter (§3).
2. **Prepare the assets** with `scripts/svox_cli.py`.
   - Anchor every non-trivial character or vehicle on a **3-view turnaround** (`front / 3-4 / side`, MagicaVoxel
     style), generated or supplied, and iterate a render-and-compare visual-diff loop. Blind procedural sculpting comes
     out flat and toy-like ([03 pitfall 19](references/03_pitfalls_and_qa_gates.md)).
   - Import `.vox` files (`from-vox`) or slice strips (`from-strip`), run `bake-normal-ao`, then `validate`, then pack
     for the engine (`pack-atlas`). Start from [assets/minimal_reference/](assets/minimal_reference/rig.json): a torso,
     an arm with a 2-voxel blade, and a flipped cape.
   - Optional glow: up to 6 `emissiveColors[]` slots plus per-part `emissive` for lights, beacons and cores
     ([01 §3.1](references/01_contract_and_math.md#31-v11-emissive-schema-optional)).
3. **Rig and deform.**
   - Evaluate `rig.json` clips into a pose: per part a `matrix`, an `invMatrix` and 8 deform scalars. Layer IK
     (`solveTwoBoneIK`) and `SpringVec3` secondary motion on top; drive cloth shear and wave from spring velocity.
   - Children attach to the parent's **deformed** surface. Use flipped cloth for capes and robes ([01 §4–§8](references/01_contract_and_math.md)).
   - Size cameras by **multi-clip framing**: the union of the rest pose and every clip, so booms, jumps and drifts never
     clip ([01 §9](references/01_contract_and_math.md#9-multi-clip-framing--hard-surface--mechanical-rigging)).
4. **Implement the two-pass renderer** ([02](references/02_shader_pipeline_spec.md)).
   - Pass 1 is a low-resolution MRT G-buffer: colour, world normal with a foreground mask, and a `DEPTH_COMPONENT24`
     depth texture. It contains the per-part deformed-AABB proxy with front faces culled, the exact slab test, the
     inverse-deformed march, `gl_FragDepth`, cel lighting, the self-shadow ray and per-part ground shadows.
   - Pass 2 is a full-resolution `texelFetch` blit plus the 1px outline.
   - For 10–20+ part rigs add the D24 depth-bucket tie-break (`uDepthSlot` / `uDepthSlots`) so coplanar joints never
     resolve by draw order ([02 §8](references/02_shader_pipeline_spec.md#8-v11-d24-depth-bucket-tie-break-udepthslot--udepthslots)),
     and the 6-slot emissive and glow-halo contract ([02 §9](references/02_shader_pipeline_spec.md)).
   - For 3D worlds and showcases: the Perspective MRT hybrid mode (Three.js world meshes and parts share one depth
     buffer), actor-masked cinema post-FX, and the live `SPRITE STACK` debug view (`mode == 2`)
     ([02 §10](references/02_shader_pipeline_spec.md#10-v11-debug--showcase-view-modes),
     [webgl2_threejs.md §4.5](references/targets/webgl2_threejs.md#45-perspectivecamera--3d-world-mrt-hybrid-recipe-v11)).
5. **Pass G1–G4** (§7) with an iso 33° and a low 14° screenshot inspected by eye. A gate that is not measured counts as
   failed.

### Track B — megastructures and large vessels (5 stages)

1. **Stage 1A · Blueprints and visual hull** ([04 §2](references/04_megastructure_voxel_pipeline.md#2-stage-1a--orthographic-3-view-blueprints-and-visual-hull-carving)).
   From the approved 3/4 concept, generate flat orthographic Top / Side / Front views, check the dimension mismatch
   (≤ 3 %) and carve the 3-view visual hull (fidelity ≥ 0.90 per view). Blueprints govern silhouette and proportion
   only — never project their colours onto voxels.
2. **Stage 1B · Detail zones** ([04 §3](references/04_megastructure_voxel_pipeline.md#3-stage-1b--occluded-and-hero-detail-zones-detail_zonesjson)).
   Scaffold `detail_zones.json` from an archetype (`generic_megastructure`, `hard_surface_carrier`, `halo_mothership`,
   `bio_leviathan`), list every occluded cavity and hero zone with one zoomed callout sheet each, and carve the
   cavities. A 3-view hull cannot see hangars, trenches, bores or maws.
3. **Stage 2 · 4-pass sculpt** ([04 §4](references/04_megastructure_voxel_pipeline.md#4-stage-2--4-pass-sculpt-loop-and-real-engine-studio-inspection)).
   A clay massing → B primary armour / form → C meso kitbash prefabs (instanced, 0.8–1.5 u/vox) → D lookdev and
   `matTag` material channels. Rebuild the macro hull (1.6–2.5 u/vox) from clean sub-assemblies fitted to the 3-view
   envelope, and judge every pass in a real-engine studio page (clay, AO, wire, macro/meso split views).
4. **Stage 3–4 · Pack and shade** ([04 §5](references/04_megastructure_voxel_pipeline.md#5-stage-3--dual-scale-ao-and-binary-packing-svoxmegav23),
   [§6](references/04_megastructure_voxel_pipeline.md#6-stage-4--lookdev-shaders-and-the-early-z-contract)).
   Bake micro voxel AO × macro cavity AO, pack `format: 'MEGA_V23'` (`svox.mega/v2.3`: `quad16` macro parts +
   `packed20` meso prefabs in one `.json` + `.bin`), load them zero-copy, and shade with the 70/30 resting-plate
   lookdev, a material profile (`MATERIAL_PRESETS`: `hard_surface`, `ornate_stone`, `organic_bio`, or your own) and
   1 px ink creases — with no `discard` and no `gl_FragDepth` in the final program.
5. **Stage 5 · Gates** ([04 §7](references/04_megastructure_voxel_pipeline.md#7-stage-5--quality-and-performance-gates-g5-and-g6)).
   G5 multi-cue concept diff (silhouette IoU + internal edge F1 + accent colour bands you configure for your palette;
   hull-only IoU for tentacled or appendage-heavy forms) and G6 `MEGA_V23_BUDGET` (12 MiB · 16 draws · 1.2 M tris ·
   Δ 2.5 ms), measured in the engine.

## 5. CLI quick reference

**Track A — `scripts/svox_cli.py`.** Python 3 standard library only. Both `uv run scripts/svox_cli.py …` and
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

The **SVOX bundle** is `rig.json` (schema `svox.rig/v1`: coordinates, `targetHeight`, `parts[]`, `clips[]`) plus
`parts/<name>.albedo.png` and `parts/<name>.normal_ao.png` in the `strip_x` layout; in `normal_ao.png`, RGB is
`n*0.5+0.5` and alpha is AO visibility. Full schema: [01 §3](references/01_contract_and_math.md).

**Track B — `scripts/mega_voxel_kit.mjs` + `scripts/mega_diff_utils.mjs`.** Node ≥ 18, zero npm dependencies, both
importable ES modules and CLIs; each exits 1 on errors or on a failed target.

```bash
node scripts/test_mega_kit.mjs                     # self-test: 78 checks, ~15 s, temp files only in os.tmpdir()
# Stage 1B: archetype template → edit bounds → validate (generic_megastructure | hard_surface_carrier | halo_mothership | bio_leviathan)
node scripts/mega_voxel_kit.mjs zones-template --archetype hard_surface_carrier --hull-size 478,1019,302 --asset carrier_01 --out build/carrier/detail_zones.json
node scripts/mega_voxel_kit.mjs validate-zones --zones build/carrier/detail_zones.json --hull-size 478,1019,302
# Stage 1A + 3 quick check: blueprint PNGs → visual hull → zone carves → macro AO → greedy mesh → .json + .bin
node scripts/mega_voxel_kit.mjs hull --top bp_top.png --side bp_side.png --front bp_front.png --length-y 1019 \
    --voxel-scale 3.5 --zones build/carrier/detail_zones.json --out build/carrier/hull
node scripts/mega_voxel_kit.mjs inspect --asset build/carrier/hull.json          # stats + static G6 checks
node scripts/mega_voxel_kit.mjs preview --asset build/carrier/hull.json --view hero34 --out build/carrier/hero.png
node scripts/mega_voxel_kit.mjs demo --format MEGA_V23 --out build/mega_demo23  # svox.mega/v2.3 quad16 + packed20 demo carrier: 56 KiB
#   (--name ID --asset-only writes just ID.json + ID.bin, e.g. straight into an engine's asset folder)
# Stage 5 (G5): silhouette IoU, comparison sheets, multi-cue (silhouette + edge F1 + accent bands), hull-only IoU
node scripts/mega_diff_utils.mjs iou --ref concept_34.png --render render_34.png --target 0.78 --diff qa/hero_diff.png
node scripts/mega_diff_utils.mjs sheet --pairs qa/g5_pass2.json --out qa/g5_pass2.png --title "CARRIER PASS 2"
node scripts/mega_diff_utils.mjs multicue --ref concept_34.png --render render_34.png --kind hero --out qa/g5_multicue.png \
    [--bands crimson:340-20:0.45:0.30,gold:35-58:0.45:0.35]   # default bands: amber + cyan
node scripts/mega_diff_utils.mjs hull --ref side.png --render side_render.png --ref-hull side_hull.png --render-hull side_render_nowave.png --target 0.86
```

For production assets, write a small builder that imports the kit (`VoxelGrid` CSG → `carveVisualHull` →
`applyDetailZoneCarves` → prefabs and `instances[]` → `packMegaAsset({ format: 'MEGA_V23', materialProfile })` →
`writeMegaAsset`). API table: [04 §8](references/04_megastructure_voxel_pipeline.md#8-kit-api-and-cli-reference-scriptsmega_voxel_kitmjs-scriptsmega_diff_utilsmjs).

## 6. Top critical pitfalls

Each one was found the hard way. Track A details are in [03](references/03_pitfalls_and_qa_gates.md); Track B's
M1–M23 are in [04 §9](references/04_megastructure_voxel_pipeline.md#9-pitfalls-m1m23).

1. **MRT `INVALID_OPERATION` (Chrome/ANGLE).** With 2 draw buffers bound, every fragment shader must declare
   `layout(location = 1) out`, or every draw fails. Draw single-output passes with `drawBuffers([C0, NONE])`.
2. **`gl.finish()` does not block in Chrome.** Timings come out at about 1 ms that are really about 180 ms. Close each
   frame with a 1×1 `readPixels` or use timer queries. (Applies to G6 as well.)
3. **Convex staircase AO false darkening.** Count only AO cells clearly in front of the true normal
   (`dot(offset, n) > 0.75`), or every voxel staircase turns grey. Track B's macro AO uses a smoothed normal plus a
   1-voxel origin push for the same reason (M7).
4. **`CLAMP_TO_EDGE` edge bleed.** LINEAR sampling at the grid border repeats the edge voxel. Multiply by `edgeMask()`
   to emulate zero padding, and leave a 1-voxel empty margin.
5. **One-voxel-thin parts break up.** Blades and wing membranes dissolve into dots when rotated or baked. Make them
   2 voxels thick; `validate` warns at more than 25% thin voxels. Track B prefabs follow the same rule (M4).
6. **Uniformly scaled part matrices.** Never assume an orthonormal `mat3(invMatrix)`: renormalise the ray direction,
   transform normals with `transpose(mat3(invMatrix))`, and keep instances that share a scaled part close together.
7. **Loop seams.** Clips must be exactly periodic: whole cycles per loop, and phase ramps in multiples of 2π.
   `validate` measures `pose(0)` against `pose(duration)`.
8. **Track B: cavities are invisible to silhouettes, and silhouettes are not enough.** Every hangar, trench, bore and
   maw needs a `detail_zones.json` carve (M3), and a perfect outline can hide a flat interior, smeared projected colour
   or floating ghost slabs — run the multi-cue G5 and zoomed real-engine close-ups (M13–M15).
9. **Track B: lookdev legends are per-asset data.** A light box or `matTag` legend tuned for one hull silently lands
   on every other asset; drive it from the asset's material profile (M23).

## 7. Mandatory quality gates

**Track A — G1–G4.** Full definitions and harness: [03 §2](references/03_pitfalls_and_qa_gates.md#2-the-four-mandatory-qa-gates).

| Gate | Pass threshold | Reference result (minimal_reference, GTX 1080 and SwiftShader) |
|---|---|---|
| **G1 Low-pitch 14° zero-gap** | 0 slice-crack texels. Every enclosed background texel is re-traced on the CPU, and it counts as a crack if the exact ray crosses solid (alpha ≥ 0.75). | 0 cracks / 192 renders (14° and 33°); detector self-test 6/6 |
| **G2 Sub-texel pixel-snap: 0 px crawl** | A root shift under half a virtual texel changes **0** output pixels with snap on, and more than 0 with snap off. | 0/0/0 px on; 9–21k px off |
| **G3 `undeform(deform(p))`** | max error **< 1e-5** over ≥ 200 samples (CPU, and the GPU formula is identical) | 1.8e-15 (JS), 9.9e-16 (`validate`) |
| **G4 Ground / loop / occlusion** | The rest pose's lowest voxel lies within ±0.5 of z = 0, and no clip dips below −0.5. The loop seam is < 1e-3. Reversing the part draw order changes 0 px, and turning the z-buffer off changes more than 0 px. | lowest z 0.000; seam 2e-15; 0 px reorder diff |

Do not ship a Track A target without all four gates **and** a by-eye inspection of an iso 33° and a low 14° screenshot.

**Track B — G5–G6.** Full definitions: [04 §7](references/04_megastructure_voxel_pipeline.md#7-stage-5--quality-and-performance-gates-g5-and-g6).

| Gate | Pass threshold | Reference result |
|---|---|---|
| **G5 Multi-cue concept diff & detail zones** | Renders from the concept's hero 3/4 camera, the ortho Top / Side / Front views and every `detail_zones.json` camera, as `[concept \| render \| diff]` sheets. **Silhouette IoU ≥ 0.78 hero, ≥ 0.85 per ortho view**; internal **Edge F1 ≥ 0.52 hero / ≥ 0.55 ortho average** (radius 2 px, read against the chance level); **accent Band** share ratio 0.5–2.0 and centroid Δ ≤ 0.16 per band (default amber + cyan, configurable); appendage-heavy forms add **hull-only IoU ≥ 0.86**. Every zone's `requiredFeatures` visibly present, 4 measured sculpt passes, zoomed close-ups and sheets inspected by eye. | Kit self-test: framing-registered IoU 0.989; a 1.3 : 1 proportion drift is caught (0.767); a flat interior with an identical outline (IoU 1.000) fails Edge (F1 0.47); curled tentacles: full IoU 0.30 → hull 0.993, a flattened dome still fails (0.77); a render missing a custom crimson band fails. Hard-surface carrier, pass D: hero IoU 0.870, hero F1 0.622, ortho-average F1 0.541 (reported miss). |
| **G6 Performance (`MEGA_V23_BUDGET`)** | `.bin` ≤ **12 MiB**, ≤ **16** draws (1–8 macro, ≤ 15 meso batches), ≤ **1.2 M** triangles (meso unique ≤ 600k), Early-Z 100 % alive (no `discard` / `gl_FragDepth` in the FINAL program), runtime Δ ≤ **2.5 ms**, readPixels-bracketed with the asset on vs off. | Demo carrier, static checks: 3 draws, 8.4k tris, 56 KiB. Runtime checks are unmeasured until they run in an engine, and unmeasured counts as failed. Measured hero assets: hard-surface carrier 10 draws, 410k tris, 8.93 MiB, Δ 0.79 ms · ornate temple vessel 9 draws, 802k tris, 6.02 MiB, 0.3 ms CPU · organic tentacled leviathan 5 draws, 1.11 M tris, 8.03 MiB, 0.7 ms CPU. |

## 8. Files

- Track A: [scripts/svox_cli.py](scripts/svox_cli.py) (stdlib-only SVOX pipeline with byte-exact ports of the verified
  normal/AO bake and deform math); [assets/minimal_reference/](assets/minimal_reference/rig.json) (3-part rig with
  `idle` / `swing` clips, baked `parts/*.png` strips, binary [sample_cube.vox](assets/minimal_reference/sample_cube.vox));
  references [01](references/01_contract_and_math.md)–[03](references/03_pitfalls_and_qa_gates.md) and `references/targets/`.
- Track B: [scripts/mega_voxel_kit.mjs](scripts/mega_voxel_kit.mjs) (voxel kit + CLI: hull, zones, AO, `quad16` /
  `packed20` meshers, packer, material profiles, preview); [scripts/mega_diff_utils.mjs](scripts/mega_diff_utils.mjs)
  (PNG codec + G5 metrics and sheets); [scripts/test_mega_kit.mjs](scripts/test_mega_kit.mjs) (self-test, 78/78);
  [references/04](references/04_megastructure_voxel_pipeline.md) (pipeline, with legacy formats in Appendix A).
