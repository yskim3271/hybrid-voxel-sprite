<div align="center">

<a href="https://yskim3271.github.io/hybrid-voxel-sprite/"><img src="docs/assets/banner.png" width="100%" alt="hybrid-voxel-sprite: real-time articulated 3D voxel sprite-stacking"></a>

<h3>2D sprite charm. Real-time 3D volumes. Zero cracks.</h3>
<p>An open-source agent skill for articulated 3D pixel-art sprites across 4 engines.</p>

<a href="https://yskim3271.github.io/hybrid-voxel-sprite/"><img src="docs/assets/btn-demo-en.svg" height="44" alt="Try Live 3D Demo"></a>&nbsp;
<a href="#quick-start"><img src="docs/assets/btn-start-en.svg" height="44" alt="Get Started"></a>

<p>
<b>English</b> · <a href="README.ko.md">한국어</a>
<br>
<a href="https://yskim3271.github.io/hybrid-voxel-sprite/">Live Demo</a> ·
<a href="#see-it-in-action">See it in action</a> ·
<a href="#v23-capital-ships">v2.3 Capital Ships</a> ·
<a href="#verified-across-4-engines">Engines</a> ·
<a href="#quick-start">Quick Start</a> ·
<a href="#cli">CLI</a> ·
<a href="#qa-gates">QA Gates</a> ·
<a href="https://yskim3271.github.io/hybrid-voxel-sprite/changelog.html">Version History</a>
</p>

</div>

**hybrid-voxel-sprite gives your coding agent a complete recipe for sprite-stacked characters and vehicles that never crack.**
Each model is a set of small voxel parts. Every part is raymarched inside its own oriented box (**T3 OBB raymarching**),
squash / twist / shear / wave deformations are undone analytically per sample, and the result is cel-lit with baked AO and
self-shadow, snapped to a virtual pixel grid and outlined at 1 px. The skill ships a standard-library-only **SVOX asset CLI**
and adapters for **WebGL2 / Three.js, Godot 4, Unity 6 URP and Blender 5**, all checked against the same 4 QA gates.
Since v2.0 it also covers **~1000 u capital ships and megastructures**: pre-baked multi-scale greedy meshes, packed as
`quad16` (16 B per quad) in v2.3 and judged by concept-diff (G5) and performance (G6) gates.

## See it in action

<div align="center">

<a href="https://yskim3271.github.io/hybrid-voxel-sprite/"><img src="docs/assets/showcase_loop.gif" width="100%" alt="Four articulated voxel vehicles with live SPRITE STACK, 3D NORMALS and VOLUME AO wipes"></a>

<sub>4 articulated vehicles · 39 parts · 166,290 voxels · real-time Three.js r187 + T3. Each diagonal band is a different live view of the same frame.</sub>

<img src="docs/assets/modes_compare.png" width="100%" alt="The same excavator pose in FINAL, SPRITE STACK, 3D NORMALS and VOLUME AO">

<sub>Same pose, four live modes: <b>FINAL</b> (cel + 1px outline) · <b>SPRITE STACK</b> (2D slice cards) · <b>3D NORMALS</b> · <b>VOLUME AO</b></sub>

**[▶ Open the live WebGL2 demo](https://yskim3271.github.io/hybrid-voxel-sprite/)**: orbit 360°, pitch 8°–68°, switch vehicles, clips and render modes.

</div>

<a id="v23-capital-ships"></a>
## v2.3 Megastructure / Capital Ship Checkpoint

Three ~1000 u hero capitals, each taken from 2D concept art to a real-time WebGL2 engine. In every sheet, panel 01 is the
original concept and panels 02–04 are live WebGL2 frames.

<div align="center">

<a href="docs/assets/v23/vanguard_t2_showcase_2x2.jpg"><img src="docs/assets/v23/vanguard_t2_showcase_2x2.jpg" width="100%" alt="Vanguard T2 Dreadnought: concept art next to three real-time WebGL2 renders"></a>

<sub><b>Vanguard T2 Dreadnought</b> · 410,002 tris · 8.93 MiB · 10 draws · Δ 0.79 ms</sub>

<a href="docs/assets/v23/aether_p2_showcase_2x2.jpg"><img src="docs/assets/v23/aether_p2_showcase_2x2.jpg" width="49%" alt="Aether P2 Halo Core Mothership: concept art next to three real-time WebGL2 renders"></a>
<a href="docs/assets/v23/swarm_z2_showcase_2x2.jpg"><img src="docs/assets/v23/swarm_z2_showcase_2x2.jpg" width="49%" alt="Swarm Z2 Brood-Leviathan: concept art next to three real-time WebGL2 renders"></a>

<sub><b>Aether P2 Halo Core Mothership</b> · 801,960 tris · 6.02 MiB · 9 draws &nbsp;|&nbsp; <b>Swarm Z2 Brood-Leviathan</b> · 1,114,594 tris · 8.03 MiB · 5 draws</sub>

</div>

| Ship | Before (v2.2-era build) | v2.3 | G5 · G6 |
|---|---|---|---|
| **Vanguard T2 Dreadnought** | 178k tris · 2.5 u/vox · 6-level AO · Y-symmetric hangar compromise | **410,002 tris** · 1.7 u/vox · 16-level AO · true asymmetric 1.0 u/vox port / starboard hangars · 0.95 u/vox 2×3 thruster pods | Ortho Edge F1 0.541 FAIL → **0.560 PASS** · 8.93 MiB · 10 draws · Δ 0.79 ms |
| **Aether P2 Halo Core Mothership** | 284k tris · 2-level AO · sector seams | **801,960 tris** · 16-level AO · unified 2.2 u/vox `quad16` hull · circular warp portal · diamond core · 3 gyro rings · `matTag 7` gold-ivory shader | Hero IoU 0.880 · Edge F1 0.674 **PASS** · 6.02 MiB · 9 draws · 0.3 ms CPU |
| **Swarm Z2 Brood-Leviathan** | 188k tris · 5.0 u/vox · 4-level AO | **1,114,594 tris** · 2.4 u/vox · 16-level AO · curved dome carapace · 46 fangs · 82 bio-sacs · sucker-lined wave tentacles · `matTag 6/8` shaders | Hull-Only IoU 0.68 / 0.59 / 0.69 → **0.880 / 0.925 / 0.934 ALL PASS** · 8.03 MiB · 5 draws · 0.7 ms CPU |

**What made it possible:** `svox.mega/v2.3` `quad16` stores each greedy quad as one 16-byte instance (no index buffer, no
65,535-vertex cap, 5.06×–5.75× smaller than v2.2 on curved hulls), inside a 12 MiB / 16-draw / 1.2M-triangle hero budget,
with faction-scoped shaders and a Hull-Only G5 gate for tentacled ships.

> **Checkpoint note.** This is an honest checkpoint, not a finish line. Aether P2's ortho IoU (0.799 / 0.688 / 0.730) is
> still held back by its fixed `r = 78` launch bore. Swarm Z2's perspective tentacle pose differs from its ortho pose, and
> the Clay view is dense on fine curved steps. Vanguard T2's Side view alone scores Edge F1 0.538 (the ortho average 0.560
> passes), and its Zone C railgun framing needs another pass. Mobile LOD and progressive streaming come after the visual passes.

**[Full Version History →](https://yskim3271.github.io/hybrid-voxel-sprite/changelog.html)** (geometry breakdown sheet, v2.0 → v2.2 → v2.3 table, per-ship details)

## Quick Start

**Any agent** (Claude Code, Antigravity, Codex, Cursor, …)

```bash
npx skills add yskim3271/hybrid-voxel-sprite
```

**Claude Code plugin marketplace**

```text
/plugin marketplace add yskim3271/hybrid-voxel-sprite
/plugin install hybrid-voxel-sprite
```

<details>
<summary><b>Manual install</b></summary>

Copy `skills/hybrid-voxel-sprite/` into your agent's skills folder.

| Agent | Path |
|---|---|
| Claude Code | `~/.claude/skills/hybrid-voxel-sprite` |
| Antigravity (`agy`) | `~/.gemini/config/skills/hybrid-voxel-sprite` |
| Codex / Open Agents | `~/.agents/skills/hybrid-voxel-sprite` |
| Cursor and others | the tool's skills folder (standard `SKILL.md` front matter) |

```bash
git clone https://github.com/yskim3271/hybrid-voxel-sprite
cp -r hybrid-voxel-sprite/skills/hybrid-voxel-sprite ~/.claude/skills/
```

</details>

Then just ask: *"Use hybrid-voxel-sprite to build a Three.js voxel cat with spring ears and pass the 4 QA gates."*

## Verified across 4 engines

<table align="center">
  <tr>
    <td align="center" width="200"><a href="skills/hybrid-voxel-sprite/references/targets/webgl2_threejs.md"><img src="docs/assets/icon-webgl.svg" width="48" height="48" alt=""><br><b>WebGL2 / Three.js</b></a><br><sub>r187 · + v1.1 3D-world MRT</sub></td>
    <td align="center" width="200"><a href="skills/hybrid-voxel-sprite/references/targets/godot4.md"><img src="docs/assets/icon-godot.svg" width="48" height="48" alt=""><br><b>Godot 4.7.2</b></a><br><sub>Forward+ · Mobile (Vulkan)</sub></td>
    <td align="center" width="200"><a href="skills/hybrid-voxel-sprite/references/targets/unity_urp.md"><img src="docs/assets/icon-unity.svg" width="48" height="48" alt=""><br><b>Unity 6 URP</b></a><br><sub>RenderGraph · D3D11 / D3D12</sub></td>
    <td align="center" width="200"><a href="skills/hybrid-voxel-sprite/references/targets/blender_exporter.md"><img src="docs/assets/icon-blender.svg" width="48" height="48" alt=""><br><b>Blender 5.3.0</b></a><br><sub>SVOX asset-extraction bridge</sub></td>
  </tr>
  <tr>
    <td align="center">✅ G1–G4 pass</td><td align="center">✅ G1–G4 pass</td><td align="center">✅ G1–G4 pass</td><td align="center">✅ G1–G4 pass</td>
  </tr>
</table>

<p align="center"><b>Works with</b> Claude Code · Antigravity · Codex · Cursor</p>

## What you can do

| Your goal | What hybrid-voxel-sprite provides |
|---|---|
| Sprite stacking without gaps at low camera angles | Per-part OBB DDA raymarching of real 3D volumes: 0 crack texels at 14° (G1) |
| Crisp pixel art that never shimmers | Camera and root snapped to a virtual FBO texel grid: 0 px crawl (G2) |
| Squash, twist, wobble and jiggle without skinning | Analytic inverse deform per sample plus spring secondary motion, error 1.8e-15 (G3) |
| Assets from MagicaVoxel or slice strips | `svox_cli.py`: `.vox` / strip import, normal + AO bake, rig validation, atlas packing |
| The same look in your engine | Step-by-step adapters for WebGL2 / Three.js, Godot 4, Unity 6 URP and a Blender export bridge |
| Headlights, beacons and tail lights that glow | 6-slot emissive palette with a screen-space glow halo |
| 10–40-part rigs that never z-fight | D24 depth-bucket tie-break: reversing draw order changes 0 px |
| Voxel actors inside a full 3D world | PerspectiveCamera MRT hybrid with one shared depth buffer and actor-masked post FX |
| Showing how it works | Live `SPRITE STACK` mode that splits the volume into 2D slice cards in real time |
| ~1000 u capital ships and megastructures from concept art | v2.0+ track: 3-view visual hull, `detail_zones.json` callouts, macro / meso / micro greedy meshes with instanced prefabs, dual-scale AO |
| Curved, organic hero ships inside a byte budget | v2.3 `quad16`: 16 B per quad, no index buffer, 12 MiB hero budget; v2.2 `packed20` (20 B/vert) for meso prefabs |
| Proof that the ship matches the concept | G5 Multi-Cue (silhouette IoU + Edge F1 + accent band) and Hull-Only IoU for tentacled hulls; G6 draw / triangle / byte / ms budget |

<a id="cli"></a>
<details>
<summary><b>SVOX CLI</b> (Python 3.8+, standard library only)</summary>

```bash
cd skills/hybrid-voxel-sprite
# 3-part reference bundle (+ sample_cube.vox), already baked
python scripts/svox_cli.py init-demo --out build/demo
# MagicaVoxel .vox (a multi-model scene graph becomes one part per shape node)
python scripts/svox_cli.py from-vox --input hero.vox --out build/hero --bake
# horizontal slice-strip PNG (w = X*Z, h = Y) -> one part
python scripts/svox_cli.py from-strip --input cape.png --size-x 12 --size-y 4 --size-z 16 --part-name cape --out build/hero
# 3x3x3 Sobel normals + front-hemisphere AO + 1-voxel shell dilation
python scripts/svox_cli.py bake-normal-ao --bundle build/hero
# schema, thin parts, ground contact, loop seams, undeform(deform(p)) < 1e-5
python scripts/svox_cli.py validate --bundle build/hero --output build/hero_report.json
# engine packing: strip_x PNG | grid_2d flipbook PNG | raw_3d RGBA8 .bin (+ manifest.json)
python scripts/svox_cli.py pack-atlas --bundle build/hero --format raw_3d --out build/hero_raw3d
```

</details>

<details>
<summary><b>Megastructure kit</b> (Node ≥ 18, zero npm dependencies)</summary>

`mega_voxel_kit.mjs` is the library and CLI for the visual hull, detail zones, macro cavity AO, greedy meshing, the
`svox.mega` packers and a CPU preview. `mega_diff_utils.mjs` holds the PNG codec, Silhouette IoU, Multi-Cue / Hull-Only
G5 and comparison sheets. Both are importable ES modules and exit 1 on errors or a failed target.

```bash
cd skills/hybrid-voxel-sprite
node scripts/test_mega_kit.mjs                                      # self-test: 69 checks (v2.0 39 + v2.2 16 + v2.3 14)
# detail zones: archetype template (hard_surface_carrier | halo_mothership | bio_leviathan)
node scripts/mega_voxel_kit.mjs zones-template --archetype hard_surface_carrier --hull-size 478,1019,302 --out build/v/detail_zones.json
# blueprint PNGs -> visual hull -> zone carves -> macro AO -> greedy mesh -> .json + .bin
node scripts/mega_voxel_kit.mjs hull --top bp_top.png --side bp_side.png --front bp_front.png --length-y 1019 \
    --voxel-scale 3.5 --zones build/v/detail_zones.json --out build/v/hull
node scripts/mega_voxel_kit.mjs inspect --asset build/v/hull.json   # stats + static G6 checks
node scripts/mega_voxel_kit.mjs demo --v23 --out build/mega_demo23  # svox.mega/v2.3 quad16 macro + packed20 meso: 56 KiB
# G5: silhouette IoU · v2.2 multi-cue · v2.3 hull-only
node scripts/mega_diff_utils.mjs iou --ref concept_34.png --render render_34.png --target 0.78 --diff qa/hero_diff.png
node scripts/mega_diff_utils.mjs multicue --ref concept_34.png --render render_34.png --kind hero --out qa/g5_multicue.png
node scripts/mega_diff_utils.mjs hull --ref side.png --render side_render.png --ref-hull side_hull.png --render-hull side_render_nowave.png --target 0.86
```

The full 6-stage pipeline is in [04_megastructure_voxel_pipeline.md](skills/hybrid-voxel-sprite/references/04_megastructure_voxel_pipeline.md).

</details>

<a id="qa-gates"></a>
<details>
<summary><b>4 mandatory QA gates</b> (minimal_reference benchmark)</summary>

| Gate | Pass condition | Measured (GTX 1080 · SwiftShader) |
|---|---|---|
| **G1** 14° low pitch, no cracks | 0 slice-crack texels (CPU re-trace, α ≥ 0.75) | 0 cracks in 192 renders, detector self-test 6/6 |
| **G2** sub-texel snap, 0 px crawl | snap on: 0 px for sub-half-texel moves; off: > 0 px | 0 / 0 / 0 px (off: 9–21k px) |
| **G3** `undeform(deform(p))` | max error < 1e-5 | 1.8e-15 (JS) · 9.9e-16 (`validate`) |
| **G4** ground · loop · occlusion | lowest point ±0.5, loop seam < 1e-3, reversed order 0 px | z 0.000 · seam 2e-15 · 0 px |

Frame time at 640×360 ×3: **0.8 ms** (3-part reference) and **0.9 ms** (13-part knight) on a GTX 1080, each frame closed with a 1×1 `readPixels`.

**Honest positioning.** Built for isometric, top-down and side-view games with many pixel-scale sprites on screen.
Full-screen close-ups on low-end mobile are not its strength: cost scales with covered virtual pixels × march length,
so raise `pixelScale` or cap on-screen size.

**Capital-ship gates (v2.0+, per ship, in-engine).**

| Gate | v2.3 pass condition | Measured on the v2.3 hero capitals |
|---|---|---|
| **G5** Concept Diff | Silhouette IoU ≥ 0.78 hero / ≥ 0.85 ortho · Edge F1 ≥ 0.52 hero / ≥ 0.55 ortho avg · amber / cyan band 0.5–2.0 · **Hull-Only IoU ≥ 0.86** for tentacled hulls | Vanguard ortho Edge F1 0.560 · Aether hero IoU 0.880 / Edge F1 0.674 · Swarm hull 0.880 / 0.925 / 0.934 |
| **G6** Megastructure Perf | `MEGA_V23_BUDGET`: `.bin` ≤ 12 MiB · ≤ 16 draws · ≤ 1.2M tris · Δ ≤ 2.5 ms · Early-Z intact | 8.93 / 6.02 / 8.03 MiB · 10 / 9 / 5 draws · 410k / 802k / 1.11M tris · Δ 0.79 ms (Vanguard) |

</details>

<details>
<summary><b>Version History highlights</b> (v2.3 · v2.2 · v2.0 · v1.1)</summary>

**v2.3.0 · 2026-11-28 · Checkpoint.** `svox.mega/v2.3` `quad16` instanced quads (16 B/quad, no index buffer, no 65,535-vertex
cap), `MEGA_V23_BUDGET` (12 MiB · 16 draws · 1.2M tris · Δ 2.5 ms), faction-scoped shaders (`matTag 6/7/8`), Hull-Only G5,
78/78 kit self-test, verified on Vanguard T2, Aether P2 and Swarm Z2.

**v2.2.0 · 2026-11-27.** `svox.mega/v2.2` `packed20` (20 B/vert, Uint16 indices, 2.4× denser), Multi-Cue G5 (silhouette IoU +
internal Edge F1 / chamfer + amber / cyan band), 4-pass clay-to-lookdev loop in the real-engine `capital_studio.html`, 70/30
visual-rest hard-surface shader.

**v2.0.0 · 2026-11-26.** Megastructure / Capital Ship track (~1000 u): 3-view visual hull + occluded `detail_zones.json`
callouts, macro / meso / micro greedy meshes with instanced prefabs, dual-scale AO, zero-dependency Node kit, G5 and G6 gates.

**v1.1.0 · 2026-11-26.** Proven on four mythic guardians (119,391 voxels), four articulated vehicles (39 parts, 166,290 voxels) and a real-time 3D-world showcase.

1. **3-view turnaround + multi-round visual diff loop**: render ↔ compare against FRONT · 3/4 · SIDE references 4–12 times. Blind procedural sculpting looks flat and toy-like.
2. **Multi-clip framing**: frame the union of the rest pose and 12 samples of every clip, so booms, jumps and drifts never leave the shot.
3. **6-slot emissive** (`emissiveColors[]`, `emissiveStrength`, per-part `emissive`): shadow-bypassing glow, MRT alpha encoding, screen-space halo.
4. **D24 depth-bucket tie-break** (`uDepthSlot / uDepthSlots`): a plain epsilon bias failed 40 times in a 1,536-pose sweep; buckets give 0 px.
5. **Hard-surface rigging**: 6-part telescopic hydraulic cylinders that aim at each other's pins every frame, `T(hub)·Rz(steer)·Rx(spin)` wheels decoupled from suspension.
6. **PerspectiveCamera 3D-world MRT hybrid**: Three.js world meshes and T3 parts share one depth buffer; an actor mask (`C1.a ≥ 0.9`) keeps cinema post FX on the background only.
7. **Live `SPRITE STACK` mode**: `marchStack()` intersects DDA cells with horizontal sprite-card slabs, so real air gaps show, with thin-detail rescue and a blueprint backdrop.

Five new pitfalls and the extended verification recipe are in [03_pitfalls_and_qa_gates.md](skills/hybrid-voxel-sprite/references/03_pitfalls_and_qa_gates.md).

Every release with illustrated notes: **[Version History](https://yskim3271.github.io/hybrid-voxel-sprite/changelog.html)**.

</details>

<details>
<summary><b>Repository layout</b></summary>

```text
hybrid-voxel-sprite/
├── .claude-plugin/               # Claude Code plugin + marketplace manifests
├── docs/                         # GitHub Pages site: live WebGL2 demo, README assets
│   ├── index.html · changelog.html · styles.css · site.js
│   ├── demo/                     # T3 renderer, SPRITE STACK shaders, motion plugins, 4 SVOX bundles, vendored three.js
│   └── assets/                   # banner · showcase_loop.gif · modes_compare · CTA buttons · engine icons
│       └── v23/                  # v2.3 concept → real-time WebGL2 2×2 sheets (1600×900 JPEG)
├── skills/hybrid-voxel-sprite/   # ← the skill (install only this folder)
│   ├── SKILL.md                  # overview · routing · workflow · CLI · top pitfalls · QA gates G1–G6
│   ├── scripts/svox_cli.py       # stdlib SVOX pipeline CLI
│   ├── scripts/mega_*.mjs        # zero-dependency megastructure kit (mega_voxel_kit · mega_diff_utils · test_mega_kit)
│   ├── references/               # 01 contract & math · 02 shader pipeline · 03 pitfalls & gates · 04 megastructures · targets/
│   └── assets/minimal_reference/ # 3-part reference rig + sample_cube.vox
├── tests/                        # CLI · bake parity · validate · pack-atlas · doc/link checks
├── LICENSE · README.md · README.ko.md
```

```bash
SKIP_WEBGL=1 python tests/test_skill_svox.py               # standalone repo: 26 passed · 0 failed · 4 skipped (dev-repo-only harness)
node skills/hybrid-voxel-sprite/scripts/test_mega_kit.mjs    # megastructure kit: 78/78 PASS (temp files only in os.tmpdir())
```

- The normal/AO bake is byte-identical to the original JS core (`computeNormalAndAO`); tests compare against recorded sha256 values, or live through Node with `SVOX_JS_CORE=<voxel_builder.js>`.
- `src/…`, `target_tests/…` and `artifacts/…` paths in the references point into the unpublished development repo. Every formula and constant is in the documents themselves.

</details>

## License

[MIT](LICENSE) © 2026 Yunsik Kim (yskim3271)
