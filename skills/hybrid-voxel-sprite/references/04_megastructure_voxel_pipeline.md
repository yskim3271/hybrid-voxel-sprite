# 04 — Megastructure / Capital Ship Multi-Scale Voxel Pipeline (v2.0 + v2.1 close-up rules + v2.2 quantized / multi-cue + v2.3 quad16)

This file covers ~1000 u **Base Capital Ships and megastructures** (carriers, dreadnoughts, halo motherships,
bio-leviathans). The v1.1 T3 per-part OBB raymarcher in [01](01_contract_and_math.md)–[03](03_pitfalls_and_qa_gates.md)
is built for articulated characters and starfighters of 40–96 voxels. It stays the right tool for anything that moves
like a body. A capital ship is a static or slowly animated architectural mass. It is rasterised as pre-baked greedy
meshes with hardware depth, as the V12 testbed capitals already are, and this file is the pipeline for doing that well.

**Verification status (be honest about which parts are proven):**

| Piece | Status |
|---|---|
| `scripts/mega_voxel_kit.mjs`: visual hull, detail-zone carves, macro cavity AO, greedy mesher, `svox.mega/v2` packer, CPU preview | **✅ Self-tested.** `node scripts/test_mega_kit.mjs`: 69/69 PASS (v2.0's 39 + 16 v2.2 + 14 v2.3; Node 26.5, Windows 11) |
| v2.3: `greedyQuad16Part`, `packQuad16` / `unpackQuad16` / `quad16ToMesh`, `format: 'MEGA_V23'` (`svox.mega/v2.3` quad16 macro + packed20 meso), `MEGA_V23_BUDGET`, `computeHullSilhouetteIoU` | **✅ Self-tested** (§13) and **engine-verified** in the starfighter testbed (`loadCapitalShip` quad16 slices + `CAPITAL_QUAD16_VERT` InstancedBufferGeometry, v2.2 ↔ v2.3 pixel parity, `verify_engine --scope capital` v20 checks) |
| v2.2: `packQuantizedMegaV22` / `unpackQuantizedMegaV22`, `format: 'MEGA_V22'` (`svox.mega/v2.2` packed20, Uint16 indices, region split, bevel / crease / panel tags) | **✅ Self-tested** (§12.1–12.2) and **engine-verified** in the starfighter testbed (loader + `CAPITAL_VERT_Q`, `verify_engine --scope capital`) |
| `scripts/mega_diff_utils.mjs`: PNG codec, Silhouette IoU, comparison sheet, v2.2 G5-Edge / G5-Band multi-cue gate | **✅ Self-tested** (in the same run) |
| The greedy mesher core (face culling, 4-corner voxel AO, AO-safe merge, diagonal flip, de-dup) | **✅ Port of verified V12 code.** `builders/build_capitals.mjs` in the starfighter testbed: 3 ships, 62–87 % reduction, +0.10–0.31 ms on a GTX 1080 |
| `MEGA_V2` vertex format, `CAPITAL_FRAG` micro-detail and macro-AO GLSL (§5.3, §6.3), InstancedMesh loader (§5.2) | **v2.1: ported and engine-verified in the starfighter testbed** (Three.js r187 WebGL2, Vanguard T2: 1 macro + 8 instanced draws, Early-Z intact, `qa/verify_engine.mjs` v16 checks). On any other engine they are still reference snippets: port them, then pass G5 and G6 there |
| G5 and G6 on real capital ships | **Must be run per ship.** A gate that is not measured counts as failed, exactly as in v1.1 |

## 0. Conventions

- **Axes.** This track uses the starfighter contract that V12 capitals use: `+X` starboard, `+Y` forward (bow),
  `+Z` dorsal. Positions are ship-local world units **u**, relative to the ship origin, which is
  `manifest.center` in macro voxel coordinates. The T3 character contract in [01 §1](01_contract_and_math.md) is
  different: there, `+Y` is back and characters face `−Y`. Convert at the boundary and never mix the two.
- **Grids.** Voxel `(x, y, z)` covers `[x, x+1) × [y, y+1) × [z, z+1)`. CSG shapes are tested at voxel centres
  `(x + 0.5, …)`, so integer-aligned boxes are exact. Local u maps to voxels as `v = p / voxelScale + center`.
- **Scale.** A starfighter voxel is about 0.55–0.65 u, and a V12 capital voxel is 5.2–6.9 u, 9–11× larger. v2.0 puts
  the macro hull at **3.0–4.0 u/vox**, kitbash modules at **1.2–2.0 u/vox**, and everything finer into the fragment
  shader.
- **Orthographic views.** These are right-handed cameras, with image row 0 at the top. They are the same in
  `projectSilhouettes`, `carveVisualHull` and `renderPreview`.

  | View | Camera | Image right | Image up | Lattice |
  |---|---|---|---|---|
  | `top` | +Z looking −Z | +X | +Y (bow up) | (x, y) |
  | `side` | +X (starboard) looking −X | +Y (bow right) | +Z | (y, z) |
  | `front` | +Y (bow) looking −Y | **−X** (port is on the right) | +Z | (x, z) |

  A blueprint drawn mirrored is fine. Pass `flipU: { front: true }` (or `flipV`) instead of editing the image.

## 1. The 6-stage pipeline at a glance

```
concept 3/4 ──► 1A  ortho Top/Side/Front ──► visual hull (≥ 0.90 fidelity per view)
                 1B  detail_zones.json + zoomed callout sheets (occluded cavities, hero zones, ventral, prefabs)
                 2   Macro hull 3–4 u/vox  − cavity CSG   │ Meso prefabs 1.2–2 u/vox × instances[] │ Micro = shader
                 3   micro voxel AO (0..3) × macro cavity AO  → MEGA_V2 12-float vertices
                 4   G5 concept diff: hero 3/4 IoU ≥ 0.78, ortho IoU ≥ 0.85, every zone's features ticked, ≥ 2 passes
                 5   G6 perf: ≤ 12 draws, ≤ 120k tris (meso unique ≤ 60k), .bin ≤ 4 MB, Early-Z alive, < 1.0 ms
```

## 2. Stage 1A — Orthographic 3-view blueprint and visual hull carving

**Why.** If you sculpt blind with CSG from one 3/4 image, the proportions drift, because length, beam and height can
each be off by 10–30 % without looking wrong in perspective. Three orthographic silhouettes pin the macro shape down
before any detail goes in.

**Authoring the views.**
1. Start from the *approved* 3/4 hero concept. Generate, or draw, **Top / Side / Front orthographic elevations of
   the same ship**, anchored on that concept as the image reference. A prompt that works: *"orthographic top view
   (then side elevation, then front elevation) of the exact same ship as the reference image, flat elevation
   drawing, no perspective, no vanishing lines, no cast shadows, the whole ship in frame, centred, plain flat
   background"*. Ask for one view per image.
2. Reject a view that shows perspective, with converging edges or one end fatter than the concept shows (pitfall M1).
3. The views can differ in zoom, margins and resolution. **Normalised bounding-box registration** removes that: each
   mask is cropped to its silhouette bbox, and that bbox is mapped onto the hull's voxel bounds.

**Masks.** `toMask` takes the alpha of a transparent render. For an opaque studio backdrop it uses `key`, a colour
distance from the median corner colour, and `auto` picks between the two. For dark lines on a white blueprint use
`luma` with `invert`. Concept JPGs are fine once converted to PNG; the kit has its own zero-dependency PNG codec.

**Dimensions and a consistency check.** Fix one world length, normally the ship length `lengthY` (for example
1000 u). Then:

```
X = Y · top.w / top.h        Z = Y · side.h / side.w        X' = Z · front.w / front.h
mismatch = |X − X'| / max(X, X')        → regenerate the views when > 3 %      (hullDimsFromMasks)
```

**Carving.** On the voxel lattice, each view becomes a 2D occupancy table: `n × n` supersamples per voxel column,
kept when coverage ≥ 0.5. The hull is then

```
inside(x, y, z) = top[x, y] ∧ side[y, z] ∧ front[x, z]
```

- **Fill mode** writes this into an empty grid.
- **Carve mode** removes solid cells that fall outside it. Cells flagged `F_LOCK` survive.
- **Fidelity.** After carving, the hull is re-projected and compared with each view's table (a 2D IoU). Gate:
  **≥ 0.90 per view**. A lower score means the three views contradict each other: for example the side view shows
  height at a Y where the top view shows no beam.
- The self-test hull scores 1.0 / 1.0 / 1.0 on fidelity, and **3D IoU 0.997** against the ground truth.

**What a visual hull cannot do.** It reconstructs the convex-from-three-axes envelope only. Trenches, hangar
recesses, bores and maws leave every silhouette unchanged, so they are invisible to Stage 1A. Thin features under
2 macro voxels (masts, barrels, rails) vanish or dot out. That is what Stage 1B and the meso tier are for.

## 3. Stage 1B — Occluded and hero-zone detail callout sheets (`detail_zones.json`)

**Mandatory for any megastructure with cavities, hangars, or focal zones that the 3-view exterior hides.** Measured
in the self-test: two flank hangars and a roof trench left all three silhouettes byte-identical. The 3-view hull scored
IoU **0.837** against the real ship, and **0.997** after the detail-zone carves.

### 3.1 Schema `svox.detail_zones/v1`

```json
{
  "schema": "svox.detail_zones/v1", "shipId": "vanguard_t2", "archetype": "hard_surface_carrier", "units": "u",
  "zones": [
    {
      "zoneId": "catapult_trench",
      "kind": "occluded_cavity",
      "boundsLocal": { "min": [-109, 120, 40], "max": [109, 509, 151] },
      "cameraView": "interior_front",
      "calloutImage": "callouts/vanguard_t2_catapult_trench.png",
      "targetVoxelScale": 1.5,
      "requiredFeatures": ["white centreline + amber hazard ticks", "roof rails / shuttle track", "cyan lip strips",
                           "covered launch bay with amber ceiling lights", "aft plasma hangar gate"],
      "carve": [{ "shape": "box", "min": [-109, 120, 80], "max": [109, 509, 151] }],
      "featureMap": { "roof rails / shuttle track": "meso:catapult_rail", "cyan lip strips": "emissive palette" },
      "camera": { "pos": [0, 640, 120], "target": [0, 300, 90], "fovDeg": 30 },
      "status": "todo"
    }
  ]
}
```

| Field | Rule |
|---|---|
| `zoneId` | `[a-z0-9_]+`, unique |
| `kind` | `occluded_cavity`, `hero_superstructure`, `ventral_underhull` or `modular_prefab` |
| `boundsLocal` | `{min[3], max[3]}` in ship-local u, with `min < max` on every axis. It should overlap the hull bounds |
| `cameraView` | `interior_front`, `interior_side`, `oblique_closeup`, `ventral_34`, `dorsal_34`, `aft_34`, `bow_34`, `side_closeup` or `top_down_closeup` (other names only raise a warning) |
| `calloutImage` | the path of the zoomed callout sheet for this zone |
| `targetVoxelScale` | u/vox for this zone's detail: 1.2–2.0 for meso modules, ≤ 4.0 for macro (outside 0.8–4.0 raises a warning) |
| `requiredFeatures[]` | a non-empty list of features that G5 must find in the render |
| `carve[]` | *(required in practice for `occluded_cavity`)* CSG specs in u: `box {min,max}`, `ellipsoid {center,radii}`, `capsule {a,b,r}`, `prism {poly,axis,lo,hi}` |
| `featureMap`, `camera`, `iouTarget`, `status`, `notes` | optional; validation passes them through unchanged |

`validateDetailZones(doc, { hullBounds })` returns `{ ok, errors[], warnings[] }`. An `occluded_cavity` without
`carve[]` raises a warning, because the visual hull can never recover it. `scaffoldDetailZones(archetype, { hullSize })`
emits a template whose bounds are given as fractions of the hull; edit them per ship.

### 3.2 Callout sheets

For every zone, produce one **zoomed callout image**, anchored on the hero concept with the same palette and design
language. It shows the zone from its `cameraView`: a cutaway or interior-front view for cavities, an oblique close-up
for superstructures, and a ventral 3/4 view for the underside. Annotate each `requiredFeature` on the sheet.

Then map every feature to exactly one implementation tier:

- `macro` (a carve, or a macro voxel paint),
- `meso:<prefabId>`,
- `micro:<matTag>` (shader),
- `emissive palette`.

A feature that maps to nothing will not appear in the build.

### 3.3 Archetype checklists (built into `DETAIL_ZONE_ARCHETYPES`)

**Hard-surface carrier / dreadnought (e.g. Vanguard T2)**

| Zone | Kind | View | Required features |
|---|---|---|---|
| `catapult_trench` | occluded_cavity | interior_front | trench floor centreline + hazard ticks, roof rails / shuttle track, cyan lip strips, covered launch bay with ceiling lights, aft hangar gate |
| `flank_hangars` | occluded_cavity | oblique_closeup | recess ≥ 3 macro vox on both flanks, gantry cranes, parked craft silhouettes, deck strips, ceiling and wall light rails |
| `bridge_citadel` | hero_superstructure | oblique_closeup | 3 stepped tiers, viewport strips per tier, sensor mast, fore / aft railgun turrets, PD turrets |
| `aft_engine_cluster` | hero_superstructure | aft_34 | 4 recessed nozzle bells, octagonal housings, inner glow rings, heat-sink fins |
| `ventral_keel` | ventral_underhull | ventral_34 | keel spine, armour block rows, ventral hazard stripes / docking lights, ventral turrets or blisters |
| `turret_prefabs` | modular_prefab | oblique_closeup | railgun turret, PD turret, hangar rib / crane, each instanced ≥ 4× |

**Geometric halo mothership (e.g. Aether P2)**

| Zone | Kind | View | Required features |
|---|---|---|---|
| `launch_aperture_bore` | occluded_cavity | interior_front | bore cut fully through the prow housing, glowing interior ring bands, rear glow gate, bore lip trim |
| `crystal_core_well` | occluded_cavity | oblique_closeup | glowing well floor, faceted crystal core (separate part), armillary arches, well wall terraces |
| `terraced_deck_filigree` | hero_superstructure | dorsal_34 | gold / pearl concentric terraces, radial + circular conduits, filigree terrace trim, evenly spaced perimeter portals |
| `ventral_spire` | ventral_underhull | ventral_34 | ventral crystal spire, 8 gold pylons, under-disc conduit ring |
| `pylon_prefabs` | modular_prefab | oblique_closeup | crystal pylon, portal frame, ring arc segment |

**Organic bio-leviathan (e.g. Swarm Z2)**

| Zone | Kind | View | Required features |
|---|---|---|---|
| `launch_maws` | occluded_cavity | interior_front | twin hollow maws, bone ribs lining each interior, teeth crown on the lip, glowing throat |
| `dorsal_spine` | hero_superstructure | dorsal_34 | segmented spine carapace plates, translucent brood-pod clusters, spine ridge spikes |
| `wing_rib_joints` | hero_superstructure | oblique_closeup | segmented chitin wing ribs, bone joint knuckles, Voronoi bio-vein membrane, hooked wing-tip claws |
| `ventral_ribcage` | ventral_underhull | ventral_34 | ventral ribcage arches, rear bio-tendril sockets, vents / spore pores |
| `bio_prefabs` | modular_prefab | oblique_closeup | brood pod, chitin rib, tooth / spike |

## 4. Stage 2 — 3-tier multi-scale decomposition

| Tier | Resolution | Built from | Rendered as | Budget |
|---|---|---|---|---|
| **1 · Macro hull** | 3.0–4.0 u/vox | Stage 1A visual hull − Stage 1B cavity carves, plus macro paint (stripes, light rails) | 1–3 meshes (static hull plus animated parts such as rings, cores or tendrils), AO-preserving greedy mesh | ≤ 3 draws |
| **2 · Meso kitbash** | 1.2–2.0 u/vox | Reusable voxel prefabs: turrets, bridge modules, hangar ribs, cranes, engine bells, crystal pylons, brood pods, chitin ribs | `InstancedMesh`: **1 draw per prefab type**. The geometry is stored once; every instance is a 64 B mat4 plus a 12 B tint | ≤ 9 batches, ≤ 60k unique tris |
| **3 · Micro surface** | `uMicroPitch` ≈ 0.8–1.5 u | Fragment shader from `vLocalPos / uMicroPitch`, the local normal and `matTag` | 0 triangles; colour and emissive only (shader in §5.3). **No `discard`, no `gl_FragDepth`**, so Early-Z stays alive | ≤ ~0.3 ms (part of the G6 delta) |

### 4.1 Macro hull rules

- Sculpt with `VoxelGrid` CSG: `box`, `ellipsoid`, `capsule`, `prism` (polygon extrusion), `subtract`, and `mirrorX`
  for bilateral hulls. Prefer **prisms of blueprint outlines** over ellipsoids. A hull built from extrusions is
  exactly what a 3-view hull recovers.
- Apply `applyDetailZoneCarves(grid, zones, { voxelScale, center })` **after** the visual hull, then paint emissive
  rails *into* the carved walls with `mode: 'paint'`.
- Keep a ≥ 2-voxel empty margin around the hull (pitfall M6).
- A resample by K, as V12 did with 0.8× for round hulls, scales `voxelScale` by 1/K. Zone coordinates are in u and
  survive it. Emissive cells win the resample, so thin light conduits survive too.

### 4.2 Meso prefabs and instances

- A prefab is an ordinary `VoxelGrid` at its own `voxelScale`. Its `pivot` is in prefab voxel coordinates and
  defaults to bottom-centre `[nx/2, ny/2, 0]`, so `pos` places it on a deck.
- Features must be **≥ 2 meso voxels thick**; this is v1.1 pitfall 5 again.
- Instances are `{ prefab, pos[3] (u), rotQuat [x,y,z,w], scale (number | [3]), tint [r,g,b], zone? }`. Use uniform
  scale (pitfall M8).
- Why prefabs beat painting detail into the hull: a 1.5 u/vox turret is **2.3–2.7× sharper** than 3.5–4 u macro
  voxels and costs nothing extra per copy in the `.bin`. Eight turrets ship one geometry plus 8 × 76 B.

## 5. Stage 3 — Dual-scale AO and the `MEGA_V2` vertex format

### 5.1 Two AO terms

- **Micro voxel AO** is the classic per-vertex 8-neighbour AO from the outward layer: `(side1, side2, corner) → 0..3`,
  with `side1 && side2 → 0`. It is identical to V12. Greedy merging keeps it exact, because cells merge only when the
  4 corners match *and* AO does not vary along the merge direction, and the diagonal flips when
  `ao00 + ao11 < ao10 + ao01`.
- **Macro cavity AO** (`bakeMacroCavityAO`) works per exposed face:
  ```
  n_s  = normalize(−∇ boxBlur(occupancy, r = 2))      at the face's outward air cell   (fallback: face normal)
  o    = airCellCentre + n_s · startOffset(1.0)        (fallback: airCellCentre if o is solid)
  vis  = 1 − strength · mean_k [ hit_k ? 1 − (t_k / maxDist)^falloff : 0 ]
         over K = 24 cosine-weighted Fibonacci directions around n_s, marched at step 1 voxel up to maxDist = 24
  ```
  - Rays that leave the grid escape, so the sky is open.
  - The value is quantised to `macroLevels` (default 8) **before** the merge, so flat open decks still collapse into
    huge quads.
  - Measured in the self-test:
    - Hangar interior **0.330** against an open roof deck **1.000**.
    - Convex rim and wall-top faces **1.000**.
    - On a rise-1 / run-3 convex staircase, **1.000** with the smoothed normal against **0.918** for a naive
      face-normal hemisphere. That gap is the convex-staircase greying, the macro version of
      [03 pitfall 3](03_pitfalls_and_qa_gates.md).
    - Demo carrier: the catapult trench floor at **0.708** against the open deck at **1.000**.

### 5.2 `MEGA_V2` interleaved layout (48 B) and V12 compatibility (44 B)

| Float | MEGA_V2 | V12 (11 floats) |
|---|---|---|
| 0–2 | position (u, ship-local) | same |
| 3–5 | normal (axis-aligned) | same |
| 6–8 | albedo rgb | same |
| 9 | emissive 0..1 | same |
| 10 | micro AO 0..1 (`ao/3`) | `microAo × macroAo` (folded) |
| 11 | `meta = matTag·256 + round(macroAo·255)` | — |

- Floats 0–9 are bit-identical between the two formats; the self-test checks this. With `format: 'V12'`, an
  **unchanged V12 `CAPITAL_VERT` / `CAPITAL_FRAG`** renders the cavity depth with no shader edit.
- Decode in GLSL with `tag = floor(m / 256.0)`; `macroAo = mod(m, 256.0) / 255.0`. The value is an integer below
  2²⁴, so it is exact in float32.

**Three.js (r187) loader sketch.** RawShaderMaterial with `glslVersion: THREE.GLSL3`, as V12 `setCapitalShip` uses:

```js
const FL = json.vertexLayout.floats;                       // 12 (MEGA_V2) or 11 (V12)
function geometryFor(p, bin) {                             // p = json.macro.parts[i] or json.meso.prefabs[i]
  const ib = new THREE.InterleavedBuffer(new Float32Array(bin, p.vertexOffset, p.vertexCount * FL), FL);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.InterleavedBufferAttribute(ib, 3, 0));
  g.setAttribute('aNormal', new THREE.InterleavedBufferAttribute(ib, 3, 3));
  g.setAttribute('aColor', new THREE.InterleavedBufferAttribute(ib, 3, 6));
  g.setAttribute('aMeta', new THREE.InterleavedBufferAttribute(ib, 2, 9));       // (emissive, microAo) — V12 name
  if (FL === 12) g.setAttribute('aMeta2', new THREE.InterleavedBufferAttribute(ib, 1, 11));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(bin, p.indexOffset, p.indexCount), 1));
  return g;
}
for (const p of json.meso.prefabs) if (p.instanceCount) {
  const im = new THREE.InstancedMesh(geometryFor(p, bin), capitalInstancedMat, p.instanceCount);  // 1 draw call
  im.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(bin, p.instanceMatrixOffset, p.instanceCount * 16), 16);
  im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(bin, p.instanceColorOffset, p.instanceCount * 3), 3);
  im.frustumCulled = false;                               // as V12: the floating origin moves the ship every frame
  shipGroup.add(im);
}
```

- For a V12 asset under a MEGA_V2 shader, set the uniform `uHasMeta2 = 0` and treat `macroAo` as 1. Three supplies
  zero for a missing attribute, which would black out the hull.
- Every `.bin` chunk is a multiple of 4 bytes, so these `Float32Array` / `Uint32Array` views never throw on alignment.

### 5.3 Shader snippets (reference — port, then verify with G5/G6)

The **vertex** additions go into V12 `CAPITAL_VERT`. The instanced variant adds `in mat4 instanceMatrix;
in vec3 instanceColor;`, which Three binds for a RawShaderMaterial on an InstancedMesh.

```glsl
in float aMeta2;                 // MEGA_V2 float 11
uniform float uHasMeta2;         // 0 for V12 assets
out float vMacroAo;
flat out int vTag;
out vec3 vLN;                    // local (object) normal: axis-aligned for voxel faces
out vec3 vLP;                    // local position in u (instancing: prefab-local, before instanceMatrix)
// in main():
vMacroAo = uHasMeta2 > 0.5 ? mod(aMeta2, 256.0) / 255.0 : 1.0;
vTag = uHasMeta2 > 0.5 ? int(floor(aMeta2 / 256.0 + 0.5 / 256.0)) : 1;
vLN = aNormal; vLP = position;
#ifdef INSTANCED   // replaces the V12 lines  w = uModel * vec4(p, 1.0);  vN = mat3(uModel) * n;  vCol = aColor;
  vec4 w = uModel * instanceMatrix * vec4(p, 1.0);  vN = mat3(uModel) * mat3(instanceMatrix) * n;  vCol = aColor * instanceColor;
#endif
```

**Fragment, Tier 3 micro surface.** It runs inside `CAPITAL_FRAG` before lighting. It touches colour and emissive
only, so Early-Z stays 100 % alive.

```glsl
uniform float uMicroPitch;      // u per micro cell (0.8–1.5; scale-cue windows want ~1.0)
uniform float uMicroStrength;   // 0..1 look-dev (start 0.6)
uniform float uWindowDensity;   // fraction of lit window slots (start 0.35)
uniform float uMacroAoStrength; // 0..1 (start 0.85)
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
// returns (albedo multiplier rgb, emissive add)
vec4 microDetail(vec3 lp, vec3 ln, int tag) {
  vec3 an = abs(ln);
  vec2 g = (an.x > 0.5 ? lp.yz : an.y > 0.5 ? lp.xz : lp.xy) / uMicroPitch;
  float fw = max(fwidth(g.x), fwidth(g.y));
  float vis = (1.0 - smoothstep(0.35, 0.9, fw)) * uMicroStrength;   // fade when a micro cell < ~1–2 virtual px (no shimmer)
  if (vis <= 0.0 || tag == 3 || tag == 8) return vec4(1.0, 1.0, 1.0, 0.0);
  float mul = 1.0, em = 0.0;
  if (tag == 1 || tag == 4) {                                     // hull plating / greeble: staggered 6×3 panels
    vec2 ps = vec2(6.0, 3.0), q = g / ps;
    q.x += 0.5 * mod(floor(q.y), 2.0);
    vec2 c = floor(q), f = fract(q) * ps;
    vec2 e2 = min(f, ps - f);
    float edge = min(e2.x, e2.y);
    mul *= mix(0.70, 1.0, step(0.16, edge));                      // panel seam groove
    mul *= 1.0 + 0.07 * step(0.16, edge) * (1.0 - step(0.5, edge)); // bevelled lip
    mul *= 0.94 + 0.08 * h21(c);                                  // per-panel tone
    mul *= 1.0 + 0.12 * (1.0 - step(0.22, length(e2 - 0.55)));    // corner rivets
    if (h21(c + 7.1) > 0.93) mul *= 0.75 + 0.25 * step(0.5, fract(f.y * 1.5));   // vent slats
    if (tag == 1 && an.z < 0.5) {                                 // scale-cue micro-windows on vertical walls
      float row = floor(g.y / 4.0), col = floor(g.x / 1.6);
      float inRow = 1.0 - step(0.45, abs(fract(g.y / 4.0) - 0.5) * 4.0);
      float inCol = 1.0 - step(0.55, abs(fract(g.x / 1.6) - 0.5) * 2.0);
      em += inRow * inCol * step(1.0 - uWindowDensity, h21(vec2(col, row) + 3.7));
    }
  } else if (tag == 2) {                                          // deck: lane stripes + hazard ticks
    float lane = 1.0 - step(0.25, abs(fract(g.x / 12.0) - 0.5) * 12.0);
    float tick = lane * step(0.5, fract(g.y / 3.0));
    mul *= mix(1.0, 1.18, tick) * (0.96 + 0.06 * h21(floor(g / 4.0)));
  } else if (tag == 5) {                                          // organic chitin scales + vein cracks
    vec2 c = floor(g / 2.0), f = fract(g / 2.0) - 0.5;
    float d = length(f + (vec2(h21(c), h21(c + 1.3)) - 0.5) * 0.5);
    mul *= mix(0.78, 1.05, smoothstep(0.15, 0.45, d));
  } else if (tag == 6 || tag == 7) {                              // crystal glints / gold filigree bands
    mul *= 1.0 + 0.10 * step(0.85, fract((g.x + g.y) / 5.0));
  }
  return vec4(mix(vec3(1.0), vec3(mul), vis), em * vis);
}
// in main(), replacing the V12 albedo / ao lines:
vec4 md = microDetail(vLP, normalize(vLN), vTag);
vec3 albedo = vCol * md.rgb;
float aoMicro = smoothstep(0.1, 0.92, vAo);
float aoMacro = mix(1.0, vMacroAo, uMacroAoStrength * (1.0 - vEm));   // emissive cells are never darkened
float ao = aoMicro * aoMacro;                                          // then the V12 4-step quantisation
// … V12 cel lighting unchanged …
em = clamp(max(vEm, md.a) * uEmissiveMul, 0.0, 1.0);
```

- The G-buffer outputs stay identical to V12 (`oColor.a = 1 − 0.5·em`, `oNormal = n·0.5 + 0.5`), so POST's 1 px ink
  and glow halo work unchanged.
- Micro-windows are emissive, so they bloom through the existing halo. That is the cue that sells 1000 u of scale.
- Keep any debug `discard` (such as sprite-stack gaps) in a **separate program variant** that is swapped in only for
  that debug view, exactly as V12 `CAPITAL_FRAG_STACK` does.

## 6. Stage 4 — G5 Concept Diff and Detail-Zone visual verification gate

**Renders.** The engine must produce all of these. `renderPreview` only gives a CPU stand-in for smoke tests.

| Shot | Camera | Mask | Target |
|---|---|---|---|
| Hero 3/4 | match the concept's studio camera: yaw, pitch and FOV (orthographic if the concept reads as orthographic) | concept: `key`; render: transparent clear → `alpha` | **IoU ≥ 0.78** |
| Ortho top / side / front | `VIEW_CONVENTIONS` | the Stage 1A blueprint views vs. ortho renders | **IoU ≥ 0.85 each** |
| Every detail zone | the zone's `camera` / `cameraView` | callout vs. render (optional `iouTarget`) | **every `requiredFeature` ticked by eye** |

**Procedure.**

1. Pass 1, **Macro**: render the hull plus cavities, then compose and measure the sheet.
2. Pass 2, **Meso**: add the prefabs, then measure again.
3. Pass 3, **Micro**: add shader detail, then check by eye. Micro detail must not change a silhouette; if an IoU
   drops, something is wrong.
4. **At least 2 measured refinement passes**, kept as `qa/g5_<ship>_pass<N>.png` with an IoU table.

```bash
node scripts/mega_diff_utils.mjs sheet --pairs qa/g5_vanguard_pass2.json --out qa/g5_vanguard_pass2.png --title "VANGUARD T2 PASS 2"
#   pairs.json = [{ "label": "HERO 3/4", "ref": "concept_34.png", "render": "render_34.png", "target": 0.78 },
#                 { "label": "TOP", "ref": "bp_top.png", "render": "ortho_top.png", "target": 0.85 }, …]
#   exit 1 if any pair is below its target; every row shows [concept | render | IoU mask], green = both,
#   red = missing in the render, blue = excess
node scripts/mega_diff_utils.mjs iou --ref concept_34.png --render render_34.png --target 0.78 --diff qa/hero_diff.png
```

**Registration.** The default `register: 'bbox'` crops both masks to their silhouette bbox and scales them
**uniformly** into 256². Framing, zoom and offset differences vanish, but a proportion error stays visible. In the
self-test, a 1.3 : 1 stretch scored 0.767, while `bbox-stretch` hid it at 0.993. Use `bbox-stretch` only for loose
callout crops.

The gate **fails** if any IoU is below target, if any `requiredFeature` is not visibly present, or if the sheet was
not opened and inspected by eye. These are the same rules as the v1.1 four gates.

## 7. Stage 5 — G6 Megastructure performance budget gate

| Check | Limit | How to measure |
|---|---|---|
| Draw calls | ≤ 12 (1–3 macro + ≤ 9 meso batches) | `stats.drawCalls` (static), then `renderer.info.render.calls` with the ship on minus off |
| Triangles | total ≤ 120k; meso unique ≤ 60k | `stats.totalTriangles` / `stats.mesoUniqueTriangles` |
| `.bin` | ≤ 4.0 MB | `stats.binBytes` |
| Early-Z | 100 % alive | the FINAL-mode capital programs contain no `discard` and no `gl_FragDepth` (grep the compiled source), with depthTest / depthWrite on |
| GPU frame delta | < 1.0 ms @ 60 fps | readPixels-bracketed median of ≥ 40 frames at the framed hero camera, ship on minus off ([03 pitfall 2](03_pitfalls_and_qa_gates.md): never `gl.finish()`) |

- `checkPerfBudget(stats, budget, runtime)` returns `staticPass`. A run with **no runtime numbers is never a pass**:
  `earlyZAlive` and `gpuDeltaMs` show as `unmeasured`.
- Context: V12 single-grid capitals cost +0.10 to +0.31 ms with 1–3 draws and 19–33k tris (GTX 1080, D3D11).
- Estimate, not a measurement: going from 5.2 to 3.5 u/vox multiplies exposed faces by about (5.2/3.5)² ≈ 2.2×. A
  Vanguard-class hull should land near 40k tris, inside budget. Measure it.

## 8. `svox.mega/v2` asset

```
<id>.json  { schema: "svox.mega/v2", kitVersion, id, name, faction, archetype, vertexLayout (MEGA_V2 | V12),
             instanceLayout, units: "u", axes, bounds { min, max, size },
             macro { voxelScale, parts[ { name, kind, dims, voxelScale, center, vertexOffset, vertexCount,
                     vertexByteLength, indexOffset, indexCount, indexByteLength, voxels, exposedFaces, quads,
                     triangles, reduction, macroAo { rays, maxDist, mean, min }, anim? } ] },
             meso { prefabs[ { id, voxelScale, dims, pivot, …offsets…, bounds, instanceCount,
                     instanceMatrixOffset, instanceMatrixByteLength, instanceColorOffset, instanceColorByteLength } ] },
             instances[ { prefab, pos, rotQuat, scale, tint, zone? } ], detailZones[], palette[ {index, name, hex,
             emissive, matTag} ], stats { voxelCount, exposedFaces, quads, greedyReduction, macroTriangles,
             mesoUniqueTriangles, instancedTriangles, uniqueTriangles, totalTriangles, macroDrawCalls, mesoBatches,
             drawCalls, instanceCount, prefabCount, binBytes }, budget { staticPass, runtimeMeasured, pass, checks[] } }
<id>.bin   per macro part: Float32 vertices, Uint32 indices │ per prefab: vertices, indices,
           Float32 mat4 × instanceCount (column-major), Float32 rgb × instanceCount
```

The output is deterministic. There are no timestamps or timings (V12's json carried `buildMs`; v2 drops it), the
float fields are rounded to 1e-4, and two independent builds give the same sha256 (self-tested).

## 9. Kit API and CLI (`scripts/mega_voxel_kit.mjs`, `scripts/mega_diff_utils.mjs`)

Node ≥ 18 with zero npm dependencies. Import from another script with
`import { … } from '<skill>/scripts/mega_voxel_kit.mjs'`.

| Function | Purpose |
|---|---|
| `new MegaPalette().add(name, '#hex', { emissive, matTag })` | palette (≤ 255 entries); `MAT_TAGS` lists the recommended tags |
| `new VoxelGrid(nx, ny, nz)` | `.box / .ellipsoid / .capsule / .prism / .subtract / .apply(shape, c, { mode })`, `.mirrorX()`, `.resample(K, pal)`, `.bbox()`, `.count()`; flags `F_LOCK`, `F_CAVITY`, `F_ZONE`, `MAT_MASK` |
| `projectSilhouettes(grid)` / `gridIoU(a, b)` | ortho masks per `VIEW_CONVENTIONS` / 3D occupancy IoU |
| `hullDimsFromMasks(masks, { lengthY, voxelScale })` | dims, bounds and view-consistency mismatch from 3 blueprint PNGs |
| `carveVisualHull(grid, { top, side, front }, bounds, opts)` | Stage 1A fill / carve + per-view fidelity |
| `scaffoldDetailZones` / `validateDetailZones` / `applyDetailZoneCarves` / `zoneVoxelStats` | Stage 1B |
| `bakeMacroCavityAO(grid, { rays, maxDist, blurRadius, startOffset, falloff })` | Stage 3 macro AO table |
| `greedyMeshPart(grid, pal, { voxelScale, center, macroAo, macroLevels, format })` | AO-preserving greedy mesh (MEGA_V2 / V12) |
| `packMegaAsset(manifest, macroParts, mesoPrefabs, instances)` → `writeMegaAsset(base, packed)` → `readMegaAsset(json)` | `svox.mega/v2` |
| `checkPerfBudget(stats, budget, runtime)` | G6 |
| `renderPreview(asset, { view, yaw, pitch })` | CPU z-buffer preview (transparent background) |
| `computeSilhouetteIoU(ref, render, opts)` / `composeComparisonSheet(pairs, out, opts)` | G5 |
| `decodePNG / encodePNG / readPNG / writePNG / toMask / registerMask` | zero-dependency PNG and mask tools |

```bash
node scripts/mega_voxel_kit.mjs zones-template --archetype hard_surface_carrier --hull-size 478,1019,302 --out build/vanguard/detail_zones.json
node scripts/mega_voxel_kit.mjs validate-zones --zones build/vanguard/detail_zones.json --hull-size 478,1019,302
node scripts/mega_voxel_kit.mjs hull --top bp_top.png --side bp_side.png --front bp_front.png --length-y 1019 \
     --voxel-scale 3.5 --zones build/vanguard/detail_zones.json --out build/vanguard/hull     # exit 1 if fidelity < 0.90
node scripts/mega_voxel_kit.mjs preview --asset build/vanguard/hull.json --view hero34 --out build/vanguard/hero.png
node scripts/mega_voxel_kit.mjs inspect --asset build/vanguard/hull.json                     # stats + G6 static checks
node scripts/mega_voxel_kit.mjs demo --out build/mega_demo                                   # synthetic carrier, all tiers
node scripts/test_mega_kit.mjs                                                               # self-test (39 checks)
```

- The `hull` CLI puts the ship origin at the centre of the hull bounds, so author `boundsLocal` and `carve[]`
  against that origin.
- For a production ship, write a small builder script that imports the kit: hull, carves, paint, prefabs,
  instances, then `packMegaAsset`. This is the same shape as `builders/build_capitals.mjs`.

## 10. Megastructure pitfalls (M1–M15)

1. **M1 · Perspective sneaks into "orthographic" views.**
   - *Symptom:* the hull comes out fat at one end, and `hullDimsFromMasks` reports more than 3 % mismatch.
   - *Fix:* regenerate the views with explicit "flat elevation, no perspective" wording, and reject converging edges.
2. **M2 · Front-view mirroring.**
   - A true front view puts the starboard side on the *left* of the image.
   - When the design is asymmetric, check it against the hero concept and use `flipU.front` rather than editing the
     image.
3. **M3 · Cavities are invisible to silhouettes.**
   - Every hangar, trench, bore and maw needs a Stage 1B `carve[]`.
   - Measured: the 3-view hull scored 0.837 IoU, and 0.997 after the carves.
4. **M4 · Thin features under 2 macro voxels** (masts, barrels, rails, rib spars) vanish or dot out.
   - *Fix:* move them to meso prefabs that are ≥ 2 meso voxels thick, or to micro shader detail.
5. **M5 · Noisy per-face values kill greedy merging.**
   - Macro AO is quantised to 8 levels (`macroLevels`), and the light comes from fixed Fibonacci rays (no RNG), so
     open decks stay one quad.
   - More levels, random rays or per-voxel colour noise multiply the triangle count. Put noise in the micro shader
     instead.
   - Measured: demo carrier 94 % reduction, stepped test hull 99 %.
6. **M6 · Geometry touching the grid boundary.**
   - The blur and the rays treat the outside as empty air at the boundary, so a ring that touches the grid edge baked
     to 0.92 instead of 1.00 in testing.
   - Keep ≥ 2 empty voxels around the hull.
7. **M7 · Convex-staircase greying in macro AO.**
   - A naive face-normal hemisphere greyed a 1:3 staircase to 0.918.
   - The smoothed normal plus a 1-voxel origin push gives 1.000. Keep both defaults.
8. **M8 · Non-uniform instance scale** breaks normals under `mat3(instanceMatrix)`.
   - Use uniform scale, or pass the inverse-transpose. This is the instanced form of v1.1 pitfall 6.
9. **M9 · Macro AO darkening emissive cells.**
   - Hangar light rails turn muddy.
   - Use `mix(1, macroAo, k · (1 − em))`.
10. **M10 · Micro detail shimmer.**
    - At pixel scale the procedural seams alias into moiré.
    - Fade the detail with `fwidth(g)` (§5.3), and never use `discard` for detail, because that kills Early-Z.
11. **M11 · `.bin` alignment.**
    - Every chunk must stay a multiple of 4 bytes so that typed-array views at `vertexOffset` work.
    - Never insert odd-sized blobs.
12. **M12 · Draw-call creep.**
    - One prefab type per *shape*, not per tint or placement: tints go in `instanceColor`.
    - More than 9 prefab types means it is time to merge modules into atlas-style prefabs.

### 10.1 v2.1 zoomed close-up craft rules (M13–M15)

These rules come from the Vanguard T2 pilot. It passed G5 IoU (hero 0.865, ortho ≥ 0.927) and G6, but zoomed close-ups
still showed six craft defects: smeared colour blotches, floating slabs, neon-cube engines, hockey-puck turrets, a
cardboard-flat hangar and a chunky runway LED. **Silhouette IoU cannot detect any of these**, so treat M13–M15 as gates
on the same level as G5 and G6.

13. **M13 · Ban 2D colour projection smear.**
    - Never project raw 2D blueprint pixels onto voxels as albedo.
      - Concept and blueprint colours are drawn lighting and perspective.
      - An axis projection drags them across stairs, glacis steps and recessed bulkheads as stray amber or cyan blotches.
    - Blueprints govern **silhouette and proportion only**: dimensions, envelope profiles and the G5 IoU check.
    - Author every colour in 3D ship coordinates: armour tones, hazard bands, diagonal stripes and viewports.
      - Paint only **exposed faces that face a named direction**, inside a 3D box.
      - Drive stripes with a function of 3D coordinates.
      - Put each window in a 1-voxel recess and paint only the recess floor, so the glow gets a frame.
    - *Gate:* zoom in ≥ 4× on every hero zone. Any colour that crosses a step edge it should not cross fails.
14. **M14 · Clean parametric sub-assemblies, not raw visual-hull ghosts.**
    - `top ∧ side ∧ front` is not a shape. Where the three views disagree (dorsal transitions, bow steps, hangar roofs),
      the intersection leaves thin floating "ghost fin" slabs that no single view shows.
    - Measure the 3-view envelope from the masks: half-width, z-min and z-max per station.
    - Build the macro hull from **clean architectural sub-assemblies fitted to that envelope**: chamfered boxes
      (45° staircase bevels), stepped glacis, raised 1-voxel armour straps, ribs, recessed grooves and `carve[]` cavities.
    - Re-run G5 after the rebuild.
      - Measured on the Vanguard rebuild: hero 0.870, top 0.922, side 0.874, front 0.886. The visual hull scored
        0.865 / 0.940 / 0.927 / 0.935.
      - Clean bevels cost a little ortho IoU. Report the loss honestly and keep ortho ≥ 0.82 and hero ≥ 0.78.
    - Bonus: with no per-voxel projected paint, the macro hull greedy-merges far better. Measured at 3.6 u/vox: 23.1k
      triangles with 92 % reduction, against 40.7k triangles with 83 % for the projected visual hull.
15. **M15 · High-res meso promotion and a real-engine 1 px crease close-up gate.**
    - Promote every focal hero assembly to a **1.2–1.6 u/vox meso prefab**: turrets, engine cowlings, the bridge
      citadel, hangar interiors and the cantilevered runway. At 3.4–3.6 u/vox a turret turns into a hockey puck and an
      engine turns into a solid neon cube.
    - Model emitters as **recessed cores inside dark beveled housings**. Only the deep rear nozzle core and narrow
      recessed slits may glow, never whole faces.
    - Model interiors with real depth: 2-tier alcoves, I-beam ribs, a catwalk, a gantry, lamps and a framed lattice
      forcefield. A flat emissive wall does not count.
    - Watch the budget when a prefab bakes its own cavity AO.
      - At the default 8 levels, the interior prefab's triangles doubled (8.9k → 18.9k) and the `.bin` broke 4 MiB.
      - Fix: mesh it yourself with `greedyMeshPart(grid, pal, { macroAo, macroLevels: 3, … })` and pass the result as
        `mesh` to `packMegaAsset`. That brought it to 11.5k.
    - Verify close-ups **through the target engine shader**: 1 px depth and crease outlines, the Tier-3 micro-panel
      shader and dual-scale AO. CPU `renderPreview` shows neither the outlines nor the micro detail.
    - *Gate:* one real-engine render per hero zone plus a hero shot, each inspected by eye, plus an on/off pixel diff
      that proves the micro shader is live.

## 11. End-to-end checklist (v2.2 additions at the end)

- [ ] Hero 3/4 concept approved. Archetype chosen (`hard_surface_carrier`, `halo_mothership` or `bio_leviathan`).
- [ ] Top, side and front orthographic views anchored on the concept, with mismatch ≤ 3 %.
- [ ] Visual hull at 3.0–4.0 u/vox, fidelity ≥ 0.90 on every view.
- [ ] `detail_zones.json` scaffolded, bounds edited, `validate-zones` OK, one callout sheet per zone, every feature
      mapped to a tier.
- [ ] Cavity carves applied, emissive rails painted, ≥ 2-voxel margin kept.
- [ ] Meso prefabs at 1.2–2.0 u/vox (≥ 2 vox thick), instanced, ≤ 9 types.
- [ ] Macro AO baked: cavities visibly darker, convex edges clean. Packed as `svox.mega/v2`, with `inspect` showing
      the static G6 checks passing.
- [ ] Engine port of `MEGA_V2` + micro detail, with no `discard` / `gl_FragDepth` in FINAL.
- [ ] G5: ≥ 2 measured passes, hero ≥ 0.78, ortho ≥ 0.85, every zone feature ticked, sheets inspected by eye.
- [ ] G6: runtime numbers measured (draws, tris, Early-Z, GPU delta < 1.0 ms), so `checkPerfBudget(…, runtime).pass`
      is true.
- [ ] Any T3 actors in the same scene, such as starfighters launching from the hangar, still pass G1–G4.
- [ ] v2.2: pack `format: 'MEGA_V22'` (20 B/vert), Uint16 indices on every part ≤ 65 535 vertices (split big hulls with
      `region`), `.bin` ≤ 4 MiB, runtime Δ ≤ 1.5 ms, Early-Z clean.
- [ ] v2.2: 4 sculpt passes (clay → primary → kitbash → lookdev), each with a G5-v2.2 multi-cue sheet; judge massing in
      a clay view and close-ups in the real engine (studio harness).
- [ ] v2.2: G5-Silhouette + G5-Edge (hero F1 ≥ 0.52, ortho average ≥ 0.55, radius 2 px, read against the chance level) +
      G5-Band (amber / cyan share and centroid) — report the numbers, including the ones that miss.
- [ ] v2.3 (curved / organic or hero capitals): pack `format: 'MEGA_V23'` — quad16 macro parts (one instanced draw each, no
      65 535 cap, `macroLevels` up to 256), packed20 prefabs; `.bin` ≤ 12 MiB, ≤ 16 draws, ≤ 1.2 M tris, Δ ≤ 2.5 ms.
- [ ] v2.3: faction materials tagged in the palette (6 chitin / 7 gold-ivory temple / 8 bio cavity; Vanguard keeps 0–6),
      hangar bounce only on the Vanguard; tentacled hulls pass the hull-only IoU ≥ 0.86 next to the full silhouette.

## 12. v2.2 — 20 B/vert quantized packing, G5-v2.2 multi-cue gate, 4-pass sculpt loop, studio harness, hard-surface shader

v2.2 keeps every v2.0/v2.1 rule above. It changes four things, all measured on the Vanguard T2 rebuild in the
starfighter testbed (`builders/build_vanguard_v2.mjs`, `SPEC_V18_MEGA_HARNESS_V22`).

### 12.1 `svox.mega/v2.2` — `packed20` (20 B / vertex)

`packMegaAsset(manifest = { …, format: 'MEGA_V22' })` meshes with `greedyMeshPart(…, { format: 'MEGA_V22' })` and writes
`schema: "svox.mega/v2.2"`, `vertexFormat: "packed20"`, `vertexStrideBytes: 20`, `vertexLayout: MEGA_V22_LAYOUT`.

| Bytes | Type (normalized) | Attribute | Content |
|---|---|---|---|
| 0–7 | Int16 × 4 | `aPosQ` | xyz = `round(clamp((p − posCenter) / posHalfExt, −1, 1) · 32767)` · w = `bevelHint · 32767` |
| 8–11 | Int8 × 4 | `aNormQ` | xyz = normal · 127 · w = micro AO · 127 (positive half, 7 bit) |
| 12–15 | Uint8 × 4 | `aColEm` | rgb albedo · a emissive |
| 16–19 | Uint8 × 4 | `aMeta2Q` | x matTag (decode `floor(x·255 + 0.5)`) · y macro AO (8 bit) · z `creaseMask` · w `panelId` |

- Every macro part and meso prefab carries its own `posCenter` / `posHalfExt` (rounded to 1e-6 **before** quantising, so
  the JSON decodes the stream exactly). Round trip on 1000 u bounds: **≤ 0.0076 u** (self-test < 0.03 u).
- **Indices are the new bottleneck.** At 20 B/vertex a greedy capital mesh costs ~1.6 vertices per triangle, so
  `Uint32` indices (12 B/tri) are a third of the file. v2.2 writes **`indexType: 'uint16'`** for every part / prefab
  with ≤ 65 535 vertices (every block stays 4-byte aligned, M11) and adds `greedyMeshPart(…, { region })`: one grid, one
  shared `bakeMacroCavityAO`, meshed as 2–3 seamless regions so a big hull also gets Uint16 (self-test: exposed faces
  and voxels of the 2 regions sum exactly to the whole part).
- `readMegaAsset` decodes v2.2 to MEGA_V2 floats (+ `extra`, + the raw `packed` stream), so `renderPreview` and G5 work on
  both schemas. The demo carrier: `.bin` 473 → 204 KiB.
- **Engine side (Three.js r187, verified):** `svox_loader.loadCapitalShip` keeps the slice as three typed views
  (`Int16Array` stride 10, `Int8Array` / `Uint8Array` stride 20) over the same `ArrayBuffer` — zero float expansion — and
  `capitalAttributesV22(THREE, part)` wraps them in `THREE.InterleavedBuffer`s (normalized `InterleavedBufferAttribute`s
  at offsets 0 / 8 / 12 / 16). Three.js uploads one GL buffer per `InterleavedBuffer`, so the vertex block is resident
  3× on the GPU (~4 MB here) — still far below the v2 Float32 path's CPU+GPU cost; a raw-GL single-buffer variant is
  possible but not needed. `CAPITAL_VERT_Q` / `CAPITAL_INST_VERT_Q` decode `pos = uPosCenter + aPosQ.xyz · uPosHalfExt`.
- **Budget:** `MEGA_V22_BUDGET` = ≤ 12 draws, ≤ 11 meso batches, ≤ 288 k total / 144 k unique meso triangles (2.4 × v2),
  `.bin` ≤ 4 MiB, runtime Δ ≤ 1.5 ms.

**Measured (Vanguard T2, pass D):** macro 2.5 u/vox (was 3.6) in 2 regions (`hull_aft` / `hull_fore`, Uint16), 8 meso
prefabs at 1.0–1.35 u/vox, **10 draw calls, 34 instances, 177 938 triangles (97 824 unique), `.bin` 3.457 MiB**,
deterministic SHA-256 over 2 builds; in-engine Δ 0.45–0.55 ms (headless D3D11, ship on − off, median of 3), Early-Z intact.

### 12.2 Lookdev tags written by the mesher (`format: 'MEGA_V22'`)

- `bevelHint` = 1 on the **convex** corners of **narrow** quads (min(w, h) ≤ 2 voxels): stepped 45° chamfer treads,
  strap crests, rib tops. `creaseMask` = 1 on the **concave** corners of narrow quads (corner micro AO < 3): step-riser
  feet, grooves, recess floors. Wide quads get 0 — a corner flag on a 40-voxel quad would smear a gradient across it.
- `panelId` = `grid.panel` (new optional Uint8 plane; `grid.activePanel = id` tags every following solid write, or
  `apply(…, { panel })`). Cells merge **only inside one panel**, so sub-assembly boundaries are real quad edges; the cost
  on the Vanguard was +0.1 % triangles.
- MEGA_V2 / V12 output stays byte-identical (the 39 v2.0 self-tests are unchanged).

### 12.3 G5-v2.2 — multi-cue concept gate (`mega_diff_utils.mjs`)

Silhouette IoU passes a "wedding-cake" hull with a flat, empty interior. v2.2 adds two cues measured **inside** the
foreground mask on bbox-registered 256² frames:

| Cue | Measure | Target |
|---|---|---|
| G5-Silhouette | `computeSilhouetteIoU` | hero ≥ 0.78 · each ortho ≥ 0.85 |
| **G5-Edge** | `computeEdgeG5`: luma → [1 2 1] blur → Sobel → non-max suppression → strongest 42 % of ridge pixels, rim excluded (mask eroded 3 px) → symmetric dilated-edge **F1 (radius 2 px)** + mean **chamfer distance** (3-4 DT) | hero F1 ≥ 0.52 · **ortho average** F1 ≥ 0.55 |
| **G5-Band** | `computeBandG5`: HSV amber (h 20–54°, s ≥ 0.45) / cyan (h 165–205°, s ≥ 0.4) share of the foreground + centroid | share ratio 0.5–2.0 and centroid Δ ≤ 0.16 per accent |

- Always read F1 next to `baselineF1` (render flipped top↔bottom = the chance level of that pair). L↔R flips are useless
  on bilaterally symmetric ships. **Do not widen the radius to 3 px to pass:** on the Vanguard top view the chance level
  at r = 3 is 0.60 — above the 0.55 target.
- `computeMultiCueG5` / `multiCueSummary` / `composeMultiCueSheet` (5 columns: concept · render · IoU · edge overlay
  white = hit / cyan = extra / red = missed · amber-cyan band split) and CLI `mega_diff_utils.mjs multicue`.
- Self-test: identical → F1 1.0; flat interior with the same outline → IoU 1.000 but F1 0.47 / chamfer 9.6 px → FAIL;
  missing or displaced amber band → FAIL.

### 12.4 4-pass sculpt loop + `capital_studio.html`

1. **A · Clay massing** — macro hull only, uniform clay, at the final macro resolution. Judge proportion, glacis steps,
   bow jaws, collar ribs, keel in the studio **Clay + Ink Crease** view.
2. **B · Primary armour layering** — straps, frames, recesses, grooves, transom, louvers (still macro).
3. **C · Meso kitbash** — 1.0–1.35 u/vox prefabs, instanced (bridge, pods, turrets, hangar, runway, aprons, fighters).
4. **D · Lookdev** — accent paint on exposed faces only, matTags, panelIds, bevel / crease from the mesher, pack v2.2.

Run `--pass A|B|C|D` and keep each pass's multi-cue sheet. Vanguard record (hero IoU / hero F1 / ortho-avg F1):
A 0.745 / 0.33 / 0.24 → B 0.739 / 0.41 / 0.31 → C 0.870 / 0.62 / 0.49 → D 0.870 / 0.62 / 0.54. The macro-only passes A/B do
**not** lock the silhouette on this ship (the bridge citadel and the 2×3 engine pods are prefabs and land in C); D's
lookdev paint moved the front-view edge F1 0.41 → 0.53 and fixed the band cue. Final D: silhouette ✅ (0.870 / 0.916 /
0.862 / 0.857), band ✅ (all 4 views), hero edge ✅ 0.622, **ortho-average edge F1 0.541 < 0.55 ❌** (top 0.517 with a chance
level of 0.43, side 0.576, front 0.529) — reported, not hidden.

`capital_studio.html` (testbed) reuses the exact engine pipeline without the sim / audio / HUD: shading modes Final
Space / Final Atmo / Clay + Ink / AO / Macro-Meso split / Voxel Wire, locked cameras (hero = concept framing, top, side,
front, Zone A–E), concept overlay with onion-skin opacity + vertical wipe, a telemetry badge, `?ship=&mode=&cam=` and
`window.__STUDIO__.setView()` → `qa/capture_studio.mjs` captures 9 views in ~5–7 s.

### 12.5 Hard-surface 70/30 visual-rest shader (`CAPITAL_FRAG`, `uLookV22`)

- **No uniform brick tiling.** v2.1's 14.4 u seam grid on every armour face read as bricks. v2.2: 32 × 18 u staggered
  plates, only ~55 % of the butt joints along a course are drawn (plates of 32–96 u), lighter course seams, ±4 % value per
  plate seeded by `panelId`, recessed fasteners only near the corners of ~28 % of plates, all fwidth-faded before they
  can alias. Most of the surface is resting plate — the detail clusters at seams, straps and recesses.
- **Ink:** `creaseMask` foot line (1 px where the interpolated mask reaches 1 within one pixel, via `fwidth`), grazing
  risers inked, `dFdx/dFdy` geometric-normal break; the G-buffer actor mask 0.9 makes POST draw this capital's crease /
  cavity outlines ink-black with a cool convex lift. Per-fragment derivatives alone **cannot** see edges between flat
  triangles — the crisp 1 px ink has to come from the G-buffer pass.
- `bevelHint` crests +8–12 % toward cool blue-white when sunlit; `pow(macroAo, 1.32)`; stepped cool Fresnel rim in space;
  warm-amber bounce inside the hangar box (matTag 5 + ship-local volume).
- `uCapDebugMode` 4 CLAY / 5 MACRO_MESO / 3 WIRE / 1 AO — all in the discard-free FINAL program.

### 12.6 Pitfalls M16–M19 (v2.2)

16. **M16 · Indices dominate a quantized mesh.** 20 B vertices + Uint32 indices ≈ 44 B/tri. On the Vanguard, Uint16 +
    region split took the `.bin` 5.30 → 4.60 MiB with no geometry removed; the Y-symmetric hangar (M17) then 4.6 → 3.5.
17. **M17 · Port/starboard interiors under Rz(180) flip their ends.** A mirror scale breaks FrontSide winding (M8); a
    Y-mirrored variant doubles a 25 k-triangle prefab (the `.bin` went over 4 MiB). Sculpt the interior **Y-symmetric**
    (aft half → mirrored) so one prefab serves both flanks with the hero feature (airlock portal) aft on both.
18. **M18 · "Detail everywhere" reads as tiling.** A seam on every plate at hero distance is a brick wall. Keep ~70 %
    resting surface, vary plate length, and let geometry (straps, frames, recesses) carry the structure.
19. **M19 · The chance level of an edge metric.** Symmetric ortho views (top) score high F1 against themselves flipped
    L↔R; compare against a top↔bottom flip, keep the radius at 2 px, and report F1 with its chance level.

## 13. v2.3 — `quad16` (16 B/quad) instanced quads, 12 MiB hero budget, faction materials, hull-only G5

v2.3 keeps every v2.0–v2.2 rule. It removes the ceiling that made the V19 Swarm / Aether workers downgrade: curved,
doubly-curved organic surfaces only greedy-merge ~30–40 % (M-notes in §12), so v2.2's **92 B per quad** (4 × 20 B
vertices + 6 × 2 B indices; 104 B once a part passes 65 535 vertices and needs Uint32) + the 4 MiB cap forced 5 u/vox
hulls, 2–4 macro-AO levels and flattened domes. Measured in the starfighter testbed (`SPEC_V20_MEGA_V23_QUAD16`).

### 13.1 `svox.mega/v2.3` — `quad16` (16 B / quad, no index buffer)

Every greedy quad of a macro part is ONE instance of a shared unit quad (4 corners `[0,0] [1,0] [1,1] [0,1]`, indices
`0 1 2 · 0 2 3`); a part is ONE `drawElementsInstanced` (`THREE.InstancedBufferGeometry`, `instanceCount = quadCount`).

| Bytes | Attribute | Type | Meaning |
|---|---|---|---|
| 0–5 | `aQOrigin` | Uint16 × 3, raw | integer voxel-lattice corner `(ix, iy, iz)` 0..65535 → `p = gridOrigin + origin · voxelScale` (exact) |
| 6–7 | `aQSize` | Uint8 × 2, raw | `(du, dv)` voxels 1..255 along `(e_u, e_v)`; the mesher splits longer runs |
| 8–11 | `aQColEm` | Uint8 × 4, normalized | rgb albedo + emissive (same bytes as packed20, M21) |
| 12 | `aQMeta.x` | Uint8, raw | `dir + (bevelQ << 3) + (creaseQ << 5) + (diagFlip << 7)`, dir 0 +X · 1 −X · 2 +Y · 3 −Y · 4 +Z · 5 −Z |
| 13 | `aQMeta.y` | Uint8, raw | `cornerAo4`: 2 bits per corner, corner k = cu + 2·cv (greedyMeshPart's order), micro AO = ao / 3 |
| 14 | `aQMeta.z` | Uint8, raw | macro cavity AO 0..255 (`macroLevels` up to **256** — smooth dual-scale AO) |
| 15 | `aQMeta.w` | Uint8, raw | `matTag + (panelId << 4)`, both 0..15 |

Vertex stage (`CAPITAL_QUAD16_VERT`): `d = dir >> 1`, `(d, u, v)` cyclic so `e_u × e_v = e_d`; the unit corner `c` is rotated
90° when `diagFlip` (`c → (1 − c.y, c.x)`: split diagonal 00–11 → 10–01, the AO-anisotropy diagonal) and mirrored
(`c → c.yx`) for negative dirs (reversed, still CCW-outward winding); `p = gridOrigin + (origin + e_u·c.x·du + e_v·c.y·dv)
· voxelScale`, normal `±e_d`, the corner's own micro AO, `bevelHint = bevelQ/3` on corners with AO 3, `creaseMask = creaseQ/3`
on corners with AO < 3, `panel = panelId / 15`. It writes the **same varyings** as `CAPITAL_VERT_Q`, so `CAPITAL_FRAG`,
`CAPITAL_FRAG_STACK` and every `uCapDebugMode` run unchanged (Early-Z: still no `discard` / `gl_FragDepth` in FINAL).

Asset: macro parts carry `vertexFormat: 'quad16'`, `quadOffset / quadCount / quadByteLength`, `gridOrigin`, `voxelScale`,
`macroLevels`, `bounds` (+ `kind`, `anim`, `waveAmp / waveFreq / waveOriginY` when given); **meso prefabs stay packed20**
(`posCenter / posHalfExt`, Uint16 / Uint32 indices, instance mat4 + tint blocks) in the same .json/.bin. Top level:
`schema 'svox.mega/v2.3'`, `vertexFormat 'quad16+packed20'`, `quadStrideBytes 16`, `vertexStrideBytes 20`, `quadLayout`.

### 13.2 Mesher, codec and measured numbers

- `greedyQuad16Part(grid, palette, opts)` uses greedyMeshPart's exact merge rule (palette, 4 corner AOs, macro level,
  matTag, panel; AO constant along the merge direction) → for `macroLevels ≤ 16` and runs ≤ 255 it emits **the same quads,
  and through `quad16ToMesh` the same triangles** (position, normal, winding, split diagonal, rgb/em bytes, corner AO,
  macro AO, matTag, crease). Demo carrier: 2 609 quads / 5 218 triangles, 0 unmatched, max |Δp| 0.0 u.
- `packQuad16 / unpackQuad16` are bit-exact inverses and refuse out-of-range fields; `quad16ToMesh` expands a stream to
  MEGA_V2 floats (4 corners / quad) so `readMegaAsset`, `renderPreview` and G5 read v2.3 unchanged (preview IoU 1.000 vs v2.2).
- Size: demo carrier macro 189 → 41 KiB (4.64×, this hard-surface hull de-dups well in v2.2); curved sphere + torus
  test hull 36 318 quads (greedy only 29 %): **v2.2 2 870 KiB (103 k verts → Uint32) vs quad16 567 KiB = 5.06×** — one
  part, one draw. `macroLevels: 256` → 246 distinct cavity levels on that hull (8 at the default) for +6.5 % quads.
- Engine (Three.js r187, ANGLE D3D11): the quad16 carrier and its packed20 twin differ on 0.4 % of pixels by > 24/765 and
  on ~60 px by > 60 (bevel hints, M20); frame cost 1.30 vs 1.25 ms (hero framing, readPixels-synced, whole frame).

### 13.3 `MEGA_V23_BUDGET` (hero capitals)

`maxBinBytes 12 MiB · maxDrawCalls 16 (macro 1..8, meso ≤ 15 batches) · maxTriangles 1.2 M (meso unique ≤ 600 k) ·
maxRuntimeDeltaMs 2.5`. With 5.75× fewer bytes per quad than v2.2 and 3× the bytes, a hero capital can carry ~15× the
curved voxel detail of a v2.2 4 MiB ship — the voxel scale, AO levels and dome curvature no longer have to be traded away.

### 13.4 Faction-scoped materials (`CAPITAL_FRAG`, v2.2 + v2.3 assets)

| Uniform / tag | Behaviour |
|---|---|
| `uHangarBounce` | the Vanguard flank-hangar warm-amber bounce box (abs x 40..185, abs y < 165, z −122..2) — **1 only for faction `vanguard`**, 0 for Aether / Swarm / anything else (it tinted the Swarm's violet flank flesh orange) |
| `uFactionId` | 0 vanguard · 1 aether · 2 swarm · 3 other (from the asset JSON `faction`) |
| matTag 0–5 | unchanged Vanguard hard-surface legend (0 base, 1 armour 70/30 plates, 2 hazard, 3 deck, 4 glass, 5 hangar interior); the 5 service lines are Vanguard-only |
| matTag 6 | Vanguard: `engine_frame` plates (unchanged). Every other faction: **organic chitin / bio-carapace** — warped directional ridge grain (~10 u, never a straight seam), soft mottling, stepped violet sheen along curved crests, deep dark-purple crevices from `1 − macroAo` + crease, violet-black ink |
| matTag 7 | **ornate gold & ivory temple** — warm-gold metallic lift + glint on convex bevels (gold = saturated warm albedo), ivory bevels a clean soft lift, recessed double-line trim inlays on ~38 % of the 48 u bays (70/30 rest) |
| matTag 8 | **bio-luminescent cavity** — glow + emissive scaled by cavity depth `1 − macroAo` (hotter core deeper in), faint vein network, NO mechanical lines |

All colour-only in the FINAL program (CLAY / MACRO_MESO / WIRE / AO unaffected), Early-Z untouched.

### 13.5 G5-v2.3 hull-only silhouette (`computeHullSilhouetteIoU`, CLI `hull`)

Tentacles, antennae and other curling appendages change a tentacled ship's full silhouette (and its bbox → framing) far
more than the hull. The hull-only IoU isolates the carapace: explicit hull masks (concept with appendages painted out +
render without the `wave` part — `renderPreview(…, { excludeKinds: ['wave'] })`) or automatic morphological opening
(3 px at 2× size) + largest blob; both are **re-registered on the hull's own bbox**. Target **≥ 0.86**, reported next to
the full silhouette IoU. Self-test: curled vs hanging tentacles full 0.30 → hull 0.993; a flattened dome still fails (0.77).
Measured baseline: the shipped v2.2 Swarm (5 u/vox, flattened) vs `masks/*_hull.png` = top 0.68 / side 0.59 / front 0.69 —
the dome / proportion gap v2.3 exists to close.

### 13.6 Pitfalls M20–M23 (v2.3)

20. **M20 · 2 bits cannot hold four corner bevels.** `bevelQ` is a quad-level strength on the unoccluded corners
    (`round(3 · convex / unoccluded)`); it reproduces v2.2's per-corner `bevelHint` exactly on 79 % of corners (crease is
    exact: it follows the corner AO). Keep crease / ink as the crisp cue; treat bevel as a soft hint.
21. **M21 · Quantise the float32 value, not the float64 one.** `Math.round(0.9 · 255) = 230` but the packed20 path sees
    Float32 `0.89999998 · 255 → 229`. Quantise `Math.fround(x)` so v2.2 and v2.3 share every colour byte (parity tests).
22. **M22 · Raw integer attributes.** Declare `aQOrigin` / `aQSize` / `aQMeta` non-normalized (floats 0..65535 / 0..255
    arrive exactly) and decode bit fields with `int(x + 0.5)` + `& >>`. Three.js uploads one GL buffer per
    `InstancedInterleavedBuffer` array, so the Uint16 + Uint8 views are 2 GPU copies of the 16 B stream (32 B / quad on the
    GPU; the .bin and the CPU stay at 16 B, zero-copy views over one slice).
23. **M23 · Lookdev boxes and legends are faction data.** A ship-local light box tuned for one hull (the Vanguard hangar
    bounce) or a mechanical tag legend silently lands on every other faction; scope them per faction (uniforms from the
    asset's `faction`) and give the studio per-faction zone cameras instead of re-aiming one ship's.
