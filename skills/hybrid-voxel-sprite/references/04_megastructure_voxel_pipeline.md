# 04 — Megastructure Multi-Scale Voxel Pipeline

This file is **Track B** of the skill: large static or slowly animated voxel structures of roughly 500–1500 world
units (**u**) — carriers, dreadnoughts, ringed temple vessels, organic leviathans, and also fortresses, landmarks,
stations, mechs and buildings. Track A (the per-part OBB raymarcher in [01](01_contract_and_math.md)–[03](03_pitfalls_and_qa_gates.md))
is built for articulated characters and vehicles of 40–96 voxels per part and stays the right tool for anything that
moves like a body. A megastructure is an architectural mass, so it is **rasterised as pre-baked multi-scale greedy
meshes with hardware depth** instead.

The recommended stack, in one line: **`svox.mega/v2.3`** = `quad16` macro hull (16 B per greedy quad, one instanced
draw per part) + instanced `packed20` meso prefabs (20 B per vertex) + a procedural micro-detail fragment shader, inside
the 12 MiB `MEGA_V23_BUDGET`. Older formats are only needed for existing assets; see
[Appendix A](#appendix-a--legacy-formats-mega_v22-and-mega_v2).

## Track B mode decision table

Track B has **two ways to get from a concept to a voxel envelope**. Both end in the same sculpt loop, packer, shaders
and gates (§3–§7). **Never assume 3D mesh input: ask the user which mode they want** (or read it from the project's
notes), and default to Mode B1.

| | **Mode B1 · Procedural & 3-view visual hull** (default) | **Mode B2 · 3D mesh-to-voxel** (opt-in) |
|---|---|---|
| Switch | `--mesh-input off` | `--mesh-input on` |
| Input | approved 3/4 concept + orthographic Top / Side / Front views | approved 3/4 concept → a `.glb` / `.gltf` model of it |
| External tools | **none** — 100 % offline, no 3D tool, account or API key | a model source the user picks (below); online sources only on explicit request |
| Envelope from | `carveVisualHull` (§2) | `mesh_to_voxel.mjs voxelize` (§2B) |
| Best for | hard-surface, architectural, mostly convex forms; strict offline or licensing constraints | organic, ornate-curved or deeply sculpted forms (domes, gimbal rings, tentacles, ribs), where three silhouettes lose volume and curvature |
| Weak at | deep curvature, overhangs and undercuts the three views cannot see | hidden cavities and thin parts the generator invents or fuses (carve and trim them, §3, M24, M27) |
| Detail zones (§3) | required for every occluded cavity | still required: a generated mesh rarely models a usable hangar, bore or maw |

**Mode B2 provider choice (ask when the user has no model yet).** `node scripts/mesh_source.mjs list-providers` prints
what is available and whether each source is offline or online.

| Provider | What it does | Cost / network |
|---|---|---|
| `local` (**default**) | an existing `.glb` / `.gltf` exported from Blender, MagicaVoxel, a kitbash library or a marketplace download (`--glb`) | offline, $0 |
| `command` | runs **any** command-line tool the user trusts — a local open-source image-to-3D model, a Blender headless script, an in-house API wrapper — from a template (`--cmd "tool --in {image} --out {out}"`) | whatever that tool costs |
| `manual` | prints a checklist and the exact drop path; the user generates or exports the model in any web UI or DCC tool and drops it there | the user's choice |
| `tripo` | optional reference adapter for one image-to-3D API; runs only with `--provider tripo` **and** `TRIPO_API_KEY` configured | online, spends credits (SHA-256 cached) |
| yours | `registerProvider(id, adapter)` adds any other service in ~30 lines (§2B.3) | — |

**Concept pre-clean rule (Mode B2).** Before any model is generated, remove everything that is not the structure from
the concept image: detached props, escort craft, floating debris, background objects, labels and text. Image-to-3D
generators fuse whatever is in frame into the mesh (M24). Repair the background behind each removed object, keep the
structure's own pixels untouched, and inspect the before / after pair by eye.

## 0. Conventions and verification status

- **Axes.** Right-handed, Z-up: `+X` right (starboard), `+Y` forward (bow), `+Z` up (dorsal). Positions are
  asset-local world units **u**, relative to the asset origin, which is `manifest.center` in macro voxel coordinates.
  The Track A character contract in [01 §1](01_contract_and_math.md) is different: there, `+Y` is back and characters
  face `−Y`. Convert at the boundary and never mix the two.
- **Grids.** Voxel `(x, y, z)` covers `[x, x+1) × [y, y+1) × [z, z+1)`. CSG shapes are tested at voxel centres
  `(x + 0.5, …)`, so integer-aligned boxes are exact. Local u maps to voxels as `v = p / voxelScale + center`.
- **Scale.** A fighter-scale Track A voxel is about 0.55–0.65 u; an older single-grid megastructure build used 5.2–6.9 u
  voxels (9–11× larger) and looked blocky up close. Track B splits the structure into tiers instead (§1): macro hull
  1.6–2.5 u/vox, meso prefabs 0.8–1.5 u/vox, and everything finer in the fragment shader.
- **Orthographic views.** These are right-handed cameras, with image row 0 at the top. They are the same in
  `projectSilhouettes`, `carveVisualHull` and `renderPreview`.

  | View | Camera | Image right | Image up | Lattice |
  |---|---|---|---|---|
  | `top` | +Z looking −Z | +X | +Y (bow up) | (x, y) |
  | `side` | +X (starboard) looking −X | +Y (bow right) | +Z | (y, z) |
  | `front` | +Y (bow) looking −Y | **−X** (port is on the right) | +Z | (x, z) |

  A blueprint drawn mirrored is fine. Pass `flipU: { front: true }` (or `flipV`) instead of editing the image.

**Verification status (be honest about which parts are proven):**

| Piece | Status |
|---|---|
| `scripts/mega_voxel_kit.mjs` + `scripts/mega_diff_utils.mjs`: visual hull, detail zones, macro cavity AO, greedy mesher, `quad16` / `packed20` / `MEGA_V2` packers, CPU preview, G5 Silhouette / Edge / Band / hull-only metrics, material profiles | **✅ Self-tested.** `node scripts/test_mega_kit.mjs`: **78/78 PASS** (Node 26.5, Windows 11) |
| Mode B2: `scripts/mesh_source.mjs` (provider registry, validation, SHA-256 cache, secret redaction) + `scripts/mesh_to_voxel.mjs` (glTF / GLB loader, CPU 6-view sheets, SAT voxelizer, palette rules, multi-part split, unified AO) | **✅ Self-tested.** `node scripts/test_mesh_harness.mjs`: **32/32 PASS** on a synthetic `.glb`, 0 network calls. The same pipeline produced the three mesh-built hero assets in §7.3 |
| `quad16` macro loader (`InstancedBufferGeometry`, §5.5) + `CAPITAL_QUAD16_VERT` (§6.1), `packed20` meso loader + `CAPITAL_INST_VERT_Q`, `CAPITAL_FRAG` lookdev (§6), structure-aware ink, non-clipping emissives and anchored waves (§6.6–§6.9) | **✅ Engine-verified** in the reference WebGL2 / Three.js (r187) implementation: `packed20` ↔ `quad16` pixel parity, Early-Z intact, hard-surface structures 0 px changed by the curved-form shading, hero assets (a hard-surface carrier, an ornate ringed vessel and an organic tentacled leviathan) inside `MEGA_V23_BUDGET` (§7.3) |
| The greedy mesher core (face culling, 4-corner voxel AO, AO-safe merge, diagonal flip, de-dup) | **✅ Port of verified reference code** (62–87 % triangle reduction, +0.10–0.31 ms on a GTX 1080 for single-grid megastructures) |
| Any other engine (Godot, Unity, …) | **Reference snippets only.** Port §5.5 and §6, then pass G5 and G6 there |
| G5 and G6 on your own structure | **Must be run per asset.** A gate that is not measured counts as failed, exactly as in Track A |

## 1. Pipeline overview (recommended stack)

```
concept 3/4 ─┬► B1  ortho Top/Side/Front ──► visual hull (≥ 0.90 fidelity per view)            [default, offline]
             └► B2  pre-clean concept ──► .glb / .gltf (provider) ──► inspect + align ──► voxelize  [opt-in]
                 1B  detail_zones.json + zoomed callout sheets (occluded cavities, hero zones, under-side, prefabs)
                 2   4-pass sculpt: A clay → B primary armour/form → C meso kitbash prefabs → D lookdev + matTags
                     macro hull 1.6–2.5 u/vox − cavity CSG │ meso prefabs 0.8–1.5 u/vox × instances[] │ micro = shader
                 3   micro voxel AO (0..3) × macro cavity AO (up to 256 levels) → quad16 macro + packed20 meso (.json + .bin)
                 4   lookdev shader: 70/30 resting plates, matTag material legend, 1 px ink creases, Early-Z clean
                 5   G5 multi-cue concept diff (silhouette IoU + edge F1 + accent bands; hull-only IoU for appendages)
                     G6 MEGA_V23_BUDGET: ≤ 12 MiB .bin, ≤ 16 draws, ≤ 1.2 M tris, Δ ≤ 2.5 ms, Early-Z alive
```

| Tier | Resolution | Built from | Rendered as | Budget (`MEGA_V23_BUDGET`) |
|---|---|---|---|---|
| **1 · Macro hull** | **1.6–2.5 u/vox** (hero builds measured at 1.7–2.5) | Stage 1A visual hull − Stage 1B cavity carves, rebuilt from clean sub-assemblies (M14), plus macro paint (stripes, light rails) | `quad16`: each greedy quad is one 16 B instance of a shared unit quad, **one `drawElementsInstanced` per part**, no index buffer, no 65 535-vertex cap (static hull plus animated parts such as rings, cores or tendrils) | 1–8 macro draws |
| **2 · Meso kitbash** | **0.8–1.5 u/vox** (hero builds measured at 0.875–1.35) | Reusable voxel prefabs: turrets, bridge modules, hangar ribs, cranes, engine bells, crystal pylons, brood pods, chitin ribs, window bays | `packed20` geometry stored once + `InstancedMesh`: **1 draw per prefab type**; every instance is a 64 B mat4 plus a 12 B tint | ≤ 15 batches, ≤ 600k unique tris |
| **3 · Micro surface** | `uMicroPitch` ≈ 0.8–1.5 u | Fragment shader from the local position / `uMicroPitch`, the local normal and `matTag` | 0 triangles; colour and emissive only (§6). **No `discard`, no `gl_FragDepth`**, so Early-Z stays alive | part of the G6 Δ |

Whole asset: ≤ 16 draw calls, ≤ 1.2 M triangles, `.bin` ≤ 12 MiB, runtime Δ ≤ 2.5 ms. With 5.75× fewer bytes per quad
than a `packed20` hull and 3× the byte budget, a hero asset carries ~15× the curved voxel detail of a 4 MiB
`packed20`-only build — voxel scale, AO levels and dome curvature no longer have to be traded away.

## 2. Stage 1A — Orthographic 3-view blueprints and visual-hull carving

**Why.** If you sculpt blind with CSG from one 3/4 image, the proportions drift, because length, beam and height can
each be off by 10–30 % without looking wrong in perspective. Three orthographic silhouettes pin the macro shape down
before any detail goes in.

**Authoring the views.**
1. Start from the *approved* 3/4 hero concept. Generate, or draw, **Top / Side / Front orthographic elevations of
   the same structure**, anchored on that concept as the image reference. A prompt that works: *"orthographic top view
   (then side elevation, then front elevation) of the exact same ship as the reference image, flat elevation
   drawing, no perspective, no vanishing lines, no cast shadows, the whole ship in frame, centred, plain flat
   background"*. Ask for one view per image.
2. Reject a view that shows perspective, with converging edges or one end fatter than the concept shows (pitfall M1).
3. The views can differ in zoom, margins and resolution. **Normalised bounding-box registration** removes that: each
   mask is cropped to its silhouette bbox, and that bbox is mapped onto the hull's voxel bounds.

**Masks.** `toMask` takes the alpha of a transparent render. For an opaque studio backdrop it uses `key`, a colour
distance from the median corner colour, and `auto` picks between the two. For dark lines on a white blueprint use
`luma` with `invert`. Concept JPGs are fine once converted to PNG; the kit has its own zero-dependency PNG codec.

**Dimensions and a consistency check.** Fix one world length, normally the length `lengthY` (for example 1000 u).
Then:

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

**Silhouette-only rule.** Blueprints govern **silhouette and proportion only** (dimensions, envelope profiles, the G5
IoU check). Never project their pixels onto voxels as colour (M13), and use the measured envelope to fit clean
sub-assemblies rather than shipping the raw `top ∧ side ∧ front` intersection (M14).

## 2B. Mode B2 — 3D mesh-to-voxel (opt-in)

Use this instead of §2 when the user chose Mode B2. It replaces the 3-view envelope with a voxelized 3D model; every
later stage is unchanged.

### 2B.1 Steps

1. **Pre-clean the concept** (see the decision table and M24).
2. **Acquire the model** with `scripts/mesh_source.mjs` (§2B.2). The result is validated (GLB header and length, glTF 2.x,
   at least one mesh, relative resources present) and cached under `cache/<sha256>.glb`, and `mesh_source.json` records
   the provider, input hashes and model hash — never a secret.
3. **Inspect and align** with `mesh_to_voxel.mjs inspect` (§2B.4): read the 6-view sheet by eye, then choose the
   rotation and length that put the model in the asset frame (+X right, +Y forward, +Z up).
4. **Voxelize** with `mesh_to_voxel.mjs voxelize` (§2B.5): solidify, optional bilateral symmetry, palette and emissive
   rules, detail-zone carves, optional multi-part split (§2B.6), one macro AO bake, `MEGA_V23` pack.
5. Continue with §3 (detail zones), §4 (sculpt passes on the voxel cache), §6 and §7.

```bash
node scripts/mesh_source.mjs list-providers
node scripts/mesh_source.mjs acquire --provider local --glb exports/vessel.glb --out build/vessel/mesh
node scripts/mesh_to_voxel.mjs inspect --source build/vessel/mesh/mesh_source.json --out build/vessel/inspect \
     --rot-x 90 --length-y 950                      # glb_inspect.json + glb_6view_sheet.png + glb_6view_aligned.png
node scripts/mesh_to_voxel.mjs render --source build/vessel/mesh/mesh_source.json --out build/vessel/hero.png \
     --rot-x 90 --length-y 950 --view az=-40,el=17,fov=24
node scripts/mesh_to_voxel.mjs voxelize --source build/vessel/mesh/mesh_source.json --out-asset build/vessel/vessel \
     --rot-x 90 --length-y 950 --voxel-scale 2.0 --solidify --symmetrize x:high --colors 20 \
     --emissive-rules cfg/emissive.json --mat-rules cfg/mat.json --zones build/vessel/detail_zones.json \
     --material-profile ornate_stone --split-part "ring:rotate:az>-40,az<40,ax>300:cc=400"
```

### 2B.2 Acquiring a model: `scripts/mesh_source.mjs`

| Command | Purpose |
|---|---|
| `list-providers [--json] [--env-file f]` | every registered provider, its offline / online / interactive kind, readiness and whether each secret it needs is configured (names only, never values) |
| `check-provider --provider <id> [--glb f] [--cmd t] [--online]` | readiness before any work or spend: the file validates, the command's executable is on `PATH`, the key is configured (`--online` also queries an API balance) |
| `acquire --provider <id> [--glb f] [--image f] [--prompt t] [--cmd t] [--out dir] [--name n] [--wait s] [--timeout s] [--force] [--dry-run]` | acquire → validate → cache → `mesh_source.json`. A repeat request (same provider, input bytes and parameters) is a cache hit: the tool is not run again and no credits are spent |

- **Exit codes:** 0 ok · 1 error · 2 usage · 3 pending (the manual drop is not there yet, or `check-provider` says not
  ready).
- **`command` templates** are tokenised like a shell would quote them, then every token is substituted on its own and
  the program is spawned **without a shell**: `{image}`, `{prompt}`, `{out}` (the `.glb` path to write) and `{outDir}`
  (a work folder; the first `.glb` / `.gltf` written there is taken). A prompt such as `"x; rm -rf /"` stays one
  argument. Wrap `.cmd` / `.bat` scripts as `cmd /c script.cmd …` yourself.
- **`manual`** prints a checklist (feed the cleaned concept to the tool of your choice, export one uncompressed `.glb`
  with embedded textures, save it at the printed `inbox/<name>.glb` path) and exits 3; re-run, or pass `--wait 600`,
  to pick the file up.
- **Secrets** (online adapters): read from the process environment, then `--env-file`, then `~/.env` (UTF-8 BOM,
  `export` prefixes, quotes and trailing comments handled). Every log line, error and manifest passes through
  `redact()`, which removes registered secret values, bearer tokens and common key shapes.
- **`--dry-run`** prints the plan (the exact argv for `command`, the endpoint and steps for an API adapter) and runs
  nothing.

### 2B.3 Adding a provider: `registerProvider(id, adapter)`

An adapter has a `kind` (`offline` | `online` | `interactive`), optional `secrets` (environment variable names),
`describe()`, a cheap `check(opts)` and `acquire(ctx)`, which writes the model to `ctx.target` (or returns another
existing `.glb` / `.gltf` path). Caching, validation, manifests and redaction are handled for it. A sketch for any
asynchronous image-to-3D HTTP API (a hosted generator, a self-hosted open-source model server, …):

```js
import fs from 'node:fs';
import { registerProvider, acquireMesh } from '<skill>/scripts/mesh_source.mjs';
registerProvider('my_cloud', {
  label: 'My image-to-3D service', kind: 'online', secrets: ['MY_CLOUD_API_KEY'],
  describe: () => 'Image-to-3D through my service (spends credits)',
  check: (o) => ({ ready: !!(o.env || process.env).MY_CLOUD_API_KEY, reason: 'needs MY_CLOUD_API_KEY' }),
  cacheParams: (o) => ({ quality: o.quality || 'high' }),          // part of the SHA-256 cache key
  plan: (ctx) => ({ endpoint: 'https://api.example.com/v1/jobs', image: ctx.opts.image }),   // shown by --dry-run
  async acquire(ctx) {
    const key = ctx.secret('MY_CLOUD_API_KEY');                    // registered for redaction automatically
    if (!key) throw new Error('MY_CLOUD_API_KEY not configured');
    const auth = { Authorization: `Bearer ${key}` };
    const form = new FormData();
    form.append('image', new Blob([fs.readFileSync(ctx.opts.image)]), 'concept.png');
    const job = await (await ctx.fetch('https://api.example.com/v1/jobs', { method: 'POST', headers: auth, body: form })).json();
    for (;;) {                                                     // poll until the job finishes
      const st = await (await ctx.fetch(`https://api.example.com/v1/jobs/${job.id}`, { headers: auth })).json();
      if (st.status === 'failed') throw new Error(`job ${job.id} failed`);
      if (st.status === 'done') {
        fs.writeFileSync(ctx.target, Buffer.from(await (await ctx.fetch(st.glbUrl)).arrayBuffer()));
        return { file: ctx.target, meta: { jobId: job.id } };
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  },
});
await acquireMesh({ provider: 'my_cloud', image: 'concept_clean.png', out: 'build/vessel/mesh' });
```

Use `ctx.fetch` rather than the global `fetch`: it redacts network errors and honours
`MESH_SOURCE_FORBID_NETWORK=1`, which self-tests use to guarantee zero API calls.

### 2B.4 Inspecting and aligning: `mesh_to_voxel.mjs inspect` / `render`

- `inspect` writes `glb_inspect.json` (file, triangles, raw bounds, aspect ratios, longest axis, per-primitive and
  per-material summary, texture sizes, decoder warnings) and `glb_6view_sheet.png`: five orthographic views and one
  perspective 3/4 view in the raw glTF frame (+Y up, front +Z), CPU-rasterised with a z-buffer (no browser, no GPU).
- With any alignment flag it also writes `glb_6view_aligned.png` in the asset frame (FRONT +Y, BACK −Y, LEFT −X,
  RIGHT +X, TOP +Z, HERO 3/4). Alignment is applied in this order: glTF node transforms → `--rot-x`, then `--rot-y`,
  then `--rot-z` (degrees, right-handed) → bounding-box centre to the origin (`--origin center`, or `none`) → uniform
  scale so the Y extent equals `--length-y` → `--translate x,y,z`. A typical glTF (Y-up, front +Z) needs `--rot-x 90`.
- Read both sheets by eye before voxelizing: the forward axis, any fused props or missing parts, symmetric features,
  and which parts float free (candidates for a split, §2B.6).
- `render` draws one perspective frame of the aligned model (`--view az=,el=,fov=,fit=`, `--clay`) for concept-matched
  comparisons.

### 2B.5 Voxelizing: `mesh_to_voxel.mjs voxelize`

| Step | What happens | Options |
|---|---|---|
| Surface | conservative SAT triangle–box overlap per voxel; colour from a barycentric lattice of samples (≤ 0.5 voxel spacing) of the base-colour texture, vertex colours or factor, plus emissive texture / factor | `--voxel-scale` (u/vox), `--margin` |
| Solidify | 6-connected flood fill of outside air from the grid border; every enclosed air cell becomes interior | `--solidify`, `--interior '#hex'`, `--interior-mat` |
| Symmetry | mirror one X half onto the other about the asset origin | `--symmetrize x:high` / `x:low` |
| Palette | emissive voxels split out first (emissive texture / factor → `emissive_tex`; HSV emissive rules → `levels` clusters each); then a deterministic weighted Lab k-means of the diffuse colours; material rules tag clusters by centroid hue / saturation / value; optional per-rule `grade` | `--colors`, `--emissive-rules`, `--mat-rules`, `--default-mat`, `--sat-boost` / `--contrast` / `--val-gamma` / `--val-gain`, `--color-smooth` |
| Carves | `detail_zones.json` carves and raw boxes, after solidify and before AO | `--zones`, `--zone-ids`, `--carve-box` |
| AO | **one** `bakeMacroCavityAO` over the whole grid | `--ao-rays`, `--ao-dist`, `--macro-levels` (16) |
| Split | optional multi-part labelling (§2B.6) | `--split-part`, `--base-part` |
| Pack | `packMegaAsset({ format: 'MEGA_V23' })` → `<base>.json` + `<base>.bin`; `voxel_cache.{json,bin}` (the sculpt base for §4); `voxelize_report.json`; CPU previews | `--id`, `--name`, `--archetype`, `--material-profile`, `--meta`, `--cache-dir`, `--no-preview` |

Rule JSON (emissive and material rules):

```json
[{ "name": "lime", "hue": [60, 110], "sat": [0.45, 1], "val": [0.55, 1], "matTag": 8, "emissive": 0.95, "levels": 4 },
 { "name": "gold", "hue": [25, 55], "sat": [0.35, 1], "matTag": 7, "grade": { "gamma": 0.75, "gain": 1.12, "sat": 1.18, "hueShift": 4 } }]
```

- Hue is in degrees (`[340, 20]` wraps through 0); saturation and value are 0..1. Rules always **match** on the raw
  sampled colour; `grade` (`V' = gain · V^gamma`, `S' = sat · S`, hue shift) only changes the stored palette colour.
  Generated PBR albedo is usually darker and greyer than the 2D concept, so a grade per material family is normal.
- Textures: PNG is decoded natively. JPEG / WebP need a decoder: `decodeImage(bytes, mime)` programmatically, or
  Python + Pillow when installed (`--image-decoder auto|python|none`); otherwise the material's base colour is used and
  the report lists a warning. Draco / meshopt-compressed primitives and sparse accessors are rejected with a clear
  message — export uncompressed.
- The output is deterministic: two independent runs give identical `.json` and `.bin` SHA-256 (self-tested).

### 2B.6 Multi-part splitting with one unified AO

Animated appendages (rotating rings, a bobbing core, swaying tentacles) need their own macro parts, but splitting the
grid **before** the AO bake leaves dark seams where the parts meet and emits faces inside the junction. The voxelizer
therefore labels parts **after** the single AO bake and meshes every part against the whole grid:

1. `labelParts`: each solid voxel gets a part index from `--split-part` clauses (first match wins) and / or a
   programmatic `partSplitter(x, y, z, vox, grid)`; 6-connected components smaller than `cc=` fall back to the base
   part.
2. `greedyQuad16Masked(grid, palette, labels, part, opts)`: the `quad16` mesher with a per-voxel label filter.
   Exposure, corner micro AO, convex / crease tests and the macro AO still see the whole grid, so a face between two
   parts is never emitted and the shading has no seam. With one label it is byte-identical to `greedyQuad16Part`, and
   a split conserves the exposed-face count (both self-tested).
3. `computeJunctionBox`: for a wave part with `axis=box:auto` or `axis=ellipsoid:auto`, the box around its voxels that
   touch another part (+2 voxels) becomes the wave anchor (`waveCenter`, `waveRadii`; the ellipsoid uses √3 × the half
   extents so it contains the box corners). The anchored root never moves (§6.9).

Part spec: `name:kind:clauses[:wave=amp,freq,originY][:axis=box|ellipsoid:auto | :axis=box:cx,cy,cz:rx,ry,rz][:cc=N]`,
clauses `x|y|z|ax|ay|az` (`ax` = |x|) with `< <= > >=`, joined by `,`, in asset-local u. Example:
`--split-part "tentacles:wave:z<-60,ax>95:wave=16,0.012,0:axis=box:auto:cc=400"`. Each part JSON gains
`waveAxis` / `waveCenter` / `waveRadii` and the shared `macroAo` statistics (`shared: 'one bake on the unified grid'`).

### 2B.7 Programmatic API

`import { … } from '<skill>/scripts/mesh_to_voxel.mjs'` — `loadGlbMesh(file, { decodeImage })`, `parseGltf`,
`extractPrimitives`, `alignmentMatrix`, `inspectGlb(opts)`, `renderGlbView(opts)`, `renderModelViews`,
`voxelizeSurface`, `floodExterior`, `voxelizeGlb(opts)`, `labelParts`, `greedyQuad16Masked`, `computeJunctionBox`,
`parseSplitPart`, `selfTestMaskedQuad16`, `ruleMatch`, `rgb2hsv`, `hsv2rgb`. `voxelizeGlb` hooks:

| Hook | Called | Use |
|---|---|---|
| `preAoHook(ctx)` | after colours, solidify and carves, **before** the single AO bake | custom CSG: bores, collars, trims, swept-volume clearance between moving parts — so every edit is in the AO |
| `partSplitter(x, y, z, vox, grid)` | per solid voxel | splits that clauses cannot express (radius from an axis, colour-guided growth) |
| `metaHook(ctx)` | before packing | derive JSON metadata (effect anchors, launch volumes) from the final grid |
| `mesoHook(ctx)` | before packing | return `{ prefabs, instances }` to compose `packed20` meso prefabs into the same asset |

`ctx = { grid, palette, voxelScale, center, interiorIndex, carves, toLocal(ix, iy, iz) }`. `mesh_source.mjs` exports
`registerProvider`, `listProviders`, `checkProvider`, `acquireMesh`, `validateGltfFile`, `resolveManifestModel`,
`substituteTemplate`, `tokenizeTemplate`, `redact`, `registerSecret`, `parseEnvText`, `loadEnvFile`, `resolveSecret`.

## 3. Stage 1B — Occluded and hero detail zones (`detail_zones.json`)

**Mandatory for any megastructure with cavities, hangars, or focal zones that the 3-view exterior hides.** Measured
in the self-test: two flank hangars and a roof trench left all three silhouettes byte-identical. The 3-view hull scored
IoU **0.837** against the real shape, and **0.997** after the detail-zone carves.

### 3.1 Schema `svox.detail_zones/v1`

```json
{
  "schema": "svox.detail_zones/v1", "assetId": "carrier_01", "archetype": "hard_surface_carrier", "units": "u",
  "zones": [
    {
      "zoneId": "catapult_trench",
      "kind": "occluded_cavity",
      "boundsLocal": { "min": [-109, 120, 40], "max": [109, 509, 151] },
      "cameraView": "interior_front",
      "calloutImage": "callouts/carrier_01_catapult_trench.png",
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
| `assetId` | optional name of the asset; the older key `shipId` is accepted as an alias (both validate with 0 warnings; if both are present and differ, `assetId` wins with a warning) |
| `zoneId` | `[a-z0-9_]+`, unique |
| `kind` | `occluded_cavity`, `hero_superstructure`, `ventral_underhull` or `modular_prefab` |
| `boundsLocal` | `{min[3], max[3]}` in asset-local u, with `min < max` on every axis. It should overlap the hull bounds |
| `cameraView` | `interior_front`, `interior_side`, `oblique_closeup`, `ventral_34`, `dorsal_34`, `aft_34`, `bow_34`, `side_closeup` or `top_down_closeup` (other names only raise a warning) |
| `calloutImage` | the path of the zoomed callout sheet for this zone |
| `targetVoxelScale` | u/vox for this zone's detail: 0.8–1.5 for meso modules, ≤ 4.0 for macro (outside 0.8–4.0 raises a warning) |
| `requiredFeatures[]` | a non-empty list of features that G5 must find in the render |
| `carve[]` | *(required in practice for `occluded_cavity`)* CSG specs in u: `box {min,max}`, `ellipsoid {center,radii}`, `capsule {a,b,r}`, `prism {poly,axis,lo,hi}` |
| `featureMap`, `camera`, `iouTarget`, `status`, `notes` | optional; validation passes them through unchanged |

- `validateDetailZones(doc, { hullBounds })` returns `{ ok, errors[], warnings[], zones, assetId }`. An
  `occluded_cavity` without `carve[]` raises a warning, because the visual hull can never recover it.
- `scaffoldDetailZones(archetype, { hullSize, assetId })` emits a template whose bounds are given as fractions of the
  hull; edit them per asset. CLI: `zones-template --archetype <name> --hull-size X,Y,Z --asset <id>`, then
  `validate-zones`.
- `applyDetailZoneCarves(grid, zones, { voxelScale, center })` subtracts every zone's `carve[]` from a macro grid
  (Stage 2).

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

### 3.3 Archetype checklists (built into `DETAIL_ZONE_ARCHETYPES`, alias `ARCHETYPES`)

Four ready-to-use presets. Pick the closest one and edit it; every template covers all four zone kinds.

**Generic megastructure (`generic_megastructure`)** — fortresses, landmarks, stations, mechs, buildings

| Zone | Kind | View | Required features |
|---|---|---|---|
| `exterior_focal` | hero_superstructure | oblique_closeup | primary focal mass (tower / bridge / head / keep) with stepped tiers, framed openings or viewports per tier, crowning element (mast, spire, antenna, crest) |
| `occluded_cavity` | occluded_cavity | interior_front | recess ≥ 3 macro vox (gate, bay, courtyard, intake), interior structure (ribs, beams, platforms), interior lighting or emissive accents, framed lip / threshold trim |
| `hero_accent` | hero_superstructure | side_closeup | repeated accent modules along the flank (buttresses, pods, turrets, pylons), accent paint or trim bands, secondary silhouette breakers (fins, spikes, antennae) |
| `under_structure` | ventral_underhull | ventral_34 | foundation / keel / base plinth, under-side panels or block rows, landing gear / supports / roots, under-side lights or vents |
| `modular_prefabs` | modular_prefab | oblique_closeup | repeated module prefab (window bay, turret, pylon, buttress), secondary trim prefab, each instanced ≥ 4× |

**Hard-surface carrier / dreadnought (`hard_surface_carrier`)**

| Zone | Kind | View | Required features |
|---|---|---|---|
| `catapult_trench` | occluded_cavity | interior_front | trench floor centreline + hazard ticks, roof rails / shuttle track, cyan lip strips, covered launch bay with ceiling lights, aft hangar gate |
| `flank_hangars` | occluded_cavity | oblique_closeup | recess ≥ 3 macro vox on both flanks, gantry cranes, parked craft silhouettes, deck strips, ceiling and wall light rails |
| `bridge_citadel` | hero_superstructure | oblique_closeup | 3 stepped tiers, viewport strips per tier, sensor mast, fore / aft railgun turrets, PD turrets |
| `aft_engine_cluster` | hero_superstructure | aft_34 | 4 recessed nozzle bells, octagonal housings, inner glow rings, heat-sink fins |
| `ventral_keel` | ventral_underhull | ventral_34 | keel spine, armour block rows, ventral hazard stripes / docking lights, ventral turrets or blisters |
| `turret_prefabs` | modular_prefab | oblique_closeup | railgun turret, PD turret, hangar rib / crane, each instanced ≥ 4× |

**Ringed ornate temple vessel / halo mothership (`halo_mothership`)**

| Zone | Kind | View | Required features |
|---|---|---|---|
| `launch_aperture_bore` | occluded_cavity | interior_front | bore cut fully through the prow housing, glowing interior ring bands, rear glow gate, bore lip trim |
| `crystal_core_well` | occluded_cavity | oblique_closeup | glowing well floor, faceted crystal core (separate part), armillary arches, well wall terraces |
| `terraced_deck_filigree` | hero_superstructure | dorsal_34 | gold / pearl concentric terraces, radial + circular conduits, filigree terrace trim, evenly spaced perimeter portals |
| `ventral_spire` | ventral_underhull | ventral_34 | ventral crystal spire, 8 gold pylons, under-disc conduit ring |
| `pylon_prefabs` | modular_prefab | oblique_closeup | crystal pylon, portal frame, ring arc segment |

**Organic tentacled leviathan (`bio_leviathan`)**

| Zone | Kind | View | Required features |
|---|---|---|---|
| `launch_maws` | occluded_cavity | interior_front | twin hollow maws, bone ribs lining each interior, teeth crown on the lip, glowing throat |
| `dorsal_spine` | hero_superstructure | dorsal_34 | segmented spine carapace plates, translucent brood-pod clusters, spine ridge spikes |
| `wing_rib_joints` | hero_superstructure | oblique_closeup | segmented chitin wing ribs, bone joint knuckles, Voronoi bio-vein membrane, hooked wing-tip claws |
| `ventral_ribcage` | ventral_underhull | ventral_34 | ventral ribcage arches, rear bio-tendril sockets, vents / spore pores |
| `bio_prefabs` | modular_prefab | oblique_closeup | brood pod, chitin rib, tooth / spike |

## 4. Stage 2 — 4-pass sculpt loop and real-engine studio inspection

Sculpt in four passes, each at the final resolution, and keep each pass's G5 multi-cue sheet (§7.1):

1. **Pass A · Clay massing** — macro hull only, uniform clay. Judge proportion, glacis steps, bow jaws, collar ribs and
   keel in the studio **Clay + Ink Crease** view.
2. **Pass B · Primary armour / form layering** — straps, frames, recesses, grooves, transom, louvers (still macro).
3. **Pass C · Meso kitbash prefabs** — 0.8–1.5 u/vox prefabs, instanced (bridge, pods, turrets, hangar, runway,
   aprons, small craft).
4. **Pass D · 3D lookdev and material tagging** — accent paint on exposed faces only, `matTag`s (§6.3), `panelId`s,
   bevel / crease from the mesher; pack `format: 'MEGA_V23'` (§5.4).

Measured record (hard-surface carrier, hero IoU / hero edge F1 / ortho-average edge F1): A 0.745 / 0.33 / 0.24 →
B 0.739 / 0.41 / 0.31 → C 0.870 / 0.62 / 0.49 → D 0.870 / 0.62 / 0.54. The macro-only passes A/B do **not** lock the
silhouette on that hull (the bridge citadel and the 2×3 engine pods are prefabs and land in C); D's lookdev paint moved
the front-view edge F1 0.41 → 0.53 and fixed the band cue. Final D: silhouette ✅ (0.870 / 0.916 / 0.862 / 0.857), band ✅
(all 4 views), hero edge ✅ 0.622, **ortho-average edge F1 0.541 < 0.55 ❌** (top 0.517 with a chance level of 0.43,
side 0.576, front 0.529) — reported, not hidden.

### 4.1 Macro hull rules

- Sculpt with `VoxelGrid` CSG: `box`, `ellipsoid`, `capsule`, `prism` (polygon extrusion), `subtract`, and `mirrorX`
  for bilateral hulls. Prefer **prisms of blueprint outlines** over ellipsoids. A hull built from extrusions is
  exactly what a 3-view hull recovers.
- Build the final hull from **clean architectural sub-assemblies fitted to the measured 3-view envelope** (M14), not
  from the raw visual hull.
- Apply `applyDetailZoneCarves(grid, zones, { voxelScale, center })` **after** the visual hull, then paint emissive
  rails *into* the carved walls with `mode: 'paint'`.
- Keep a ≥ 2-voxel empty margin around the hull (pitfall M6).
- `panelId`: set `grid.activePanel = id` (or `apply(…, { panel })`) per sub-assembly. Cells merge **only inside one
  panel**, so sub-assembly boundaries are real quad edges (+0.1 % triangles measured).
- A resample by K (for example 0.8× for round hulls) scales `voxelScale` by 1/K. Zone coordinates are in u and survive
  it. Emissive cells win the resample, so thin light conduits survive too.
- A big hull can be split into 2–3 seamless regions of one grid with `greedyMeshPart(…, { region })` (one shared
  `bakeMacroCavityAO`; exposed faces and voxels of the regions sum exactly to the whole part).

### 4.2 Meso prefabs and instances

- A prefab is an ordinary `VoxelGrid` at its own `voxelScale`. Its `pivot` is in prefab voxel coordinates and
  defaults to bottom-centre `[nx/2, ny/2, 0]`, so `pos` places it on a deck.
- Features must be **≥ 2 meso voxels thick**; this is Track A pitfall 5 again.
- Instances are `{ prefab, pos[3] (u), rotQuat [x,y,z,w], scale (number | [3]), tint [r,g,b], zone? }`. Use uniform
  scale (pitfall M8).
- Why prefabs beat painting detail into the hull: a 1.5 u/vox turret is **2.3–2.7× sharper** than 3.5–4 u macro
  voxels and costs nothing extra per copy in the `.bin`. Eight turrets ship one geometry plus 8 × 76 B.
- Promote every focal hero assembly (turrets, engine cowlings, bridge, hangar interiors, runways) to a meso prefab
  (M15), and sculpt port / starboard interiors Y-symmetric so one prefab serves both flanks (M17).

### 4.3 Studio harness (judge in the real engine)

CPU previews (`renderPreview`) show neither the 1 px ink nor the micro shader, so judge every pass in a minimal
**studio page** that reuses the exact engine pipeline without gameplay, audio or HUD:

- [ ] Shading modes: Final (space / atmosphere), Clay + Ink, AO, Macro-Meso split, Voxel Wire (all discard-free, §6.5).
- [ ] Locked cameras: hero (= concept framing), top, side, front, and one camera per detail zone.
- [ ] Concept overlay with onion-skin opacity and a vertical wipe.
- [ ] A telemetry badge (draws, triangles, `.bin` size, frame Δ).
- [ ] URL parameters (asset / mode / camera) plus a scriptable `setView()` hook, so a headless capture script can grab
      every view in one run (the reference studio captures 9 views in ~5–7 s).

## 5. Stage 3 — Dual-scale AO and binary packing (`svox.mega/v2.3`)

### 5.1 Two AO terms

- **Micro voxel AO** is the classic per-vertex 8-neighbour AO from the outward layer: `(side1, side2, corner) → 0..3`,
  with `side1 && side2 → 0`. Greedy merging keeps it exact, because cells merge only when the 4 corners match *and* AO
  does not vary along the merge direction, and the diagonal flips when `ao00 + ao11 < ao10 + ao01`.
- **Macro cavity AO** (`bakeMacroCavityAO`) works per exposed face:
  ```
  n_s  = normalize(−∇ boxBlur(occupancy, r = 2))      at the face's outward air cell   (fallback: face normal)
  o    = airCellCentre + n_s · startOffset(1.0)        (fallback: airCellCentre if o is solid)
  vis  = 1 − strength · mean_k [ hit_k ? 1 − (t_k / maxDist)^falloff : 0 ]
         over K = 24 cosine-weighted Fibonacci directions around n_s, marched at step 1 voxel up to maxDist = 24
  ```
  - Rays that leave the grid escape, so the sky is open.
  - The value is quantised to `macroLevels` **before** the merge (default 8; `quad16` stores up to **256** levels for
    smooth dual-scale AO), so flat open decks still collapse into huge quads.
  - Measured in the self-test:
    - Hangar interior **0.330** against an open roof deck **1.000**.
    - Convex rim and wall-top faces **1.000**.
    - On a rise-1 / run-3 convex staircase, **1.000** with the smoothed normal against **0.918** for a naive
      face-normal hemisphere. That gap is the convex-staircase greying, the macro version of
      [03 pitfall 3](03_pitfalls_and_qa_gates.md).
    - Demo carrier: the catapult trench floor at **0.708** against the open deck at **1.000**.
    - Curved sphere + torus hull at `macroLevels: 256`: 246 distinct cavity levels (8 at the default) for +6.5 % quads.

### 5.2 `quad16` — macro parts (16 B per quad, no index buffer)

Every greedy quad of a macro part is ONE instance of a shared unit quad (4 corners `[0,0] [1,0] [1,1] [0,1]`, indices
`0 1 2 · 0 2 3`); a part is ONE `drawElementsInstanced` (`THREE.InstancedBufferGeometry`, `instanceCount = quadCount`).

| Bytes | Attribute | Type | Meaning |
|---|---|---|---|
| 0–5 | `aQOrigin` | Uint16 × 3, raw | integer voxel-lattice corner `(ix, iy, iz)` 0..65535 → `p = gridOrigin + origin · voxelScale` (exact) |
| 6–7 | `aQSize` | Uint8 × 2, raw | `(du, dv)` voxels 1..255 along `(e_u, e_v)`; the mesher splits longer runs |
| 8–11 | `aQColEm` | Uint8 × 4, normalized | rgb albedo + emissive (same bytes as `packed20`, M21) |
| 12 | `aQMeta.x` | Uint8, raw | `dir + (bevelQ << 3) + (creaseQ << 5) + (diagFlip << 7)`, dir 0 +X · 1 −X · 2 +Y · 3 −Y · 4 +Z · 5 −Z |
| 13 | `aQMeta.y` | Uint8, raw | `cornerAo4`: 2 bits per corner, corner k = cu + 2·cv (greedyMeshPart's order), micro AO = ao / 3 |
| 14 | `aQMeta.z` | Uint8, raw | macro cavity AO 0..255 (`macroLevels` up to **256** — smooth dual-scale AO) |
| 15 | `aQMeta.w` | Uint8, raw | `matTag + (panelId << 4)`, both 0..15 |

- `bevelHint(corner) = bevelQ / 3` on corners with micro AO 3 (unoccluded), else 0, where
  `bevelQ = round(3 · convex / unoccluded corners)` (M20). `creaseMask(corner) = creaseQ / 3` on corners with micro
  AO < 3, else 0; `creaseQ = 3` on narrow (≤ 2 vox) quads. `panel = panelId / 15`.
- `greedyQuad16Part(grid, palette, opts)` uses the exact merge rule of `greedyMeshPart` (palette, 4 corner AOs, macro
  level, matTag, panel; AO constant along the merge direction). For `macroLevels ≤ 16` and runs ≤ 255 it emits **the
  same quads, and through `quad16ToMesh` the same triangles** as the `packed20` mesher (position, normal, winding, split
  diagonal, rgb/em bytes, corner AO, macro AO, matTag, crease). Demo carrier: 2 609 quads / 5 218 triangles, 0
  unmatched, max |Δp| 0.0 u.
- `packQuad16` / `unpackQuad16` are bit-exact inverses and refuse out-of-range fields; `quad16ToMesh` expands a stream
  to 12-float vertices (4 corners per quad) so `readMegaAsset`, `renderPreview` and G5 read `quad16` assets unchanged
  (preview IoU 1.000 against the `packed20` twin).
- Size: demo carrier macro 189 → 41 KiB (4.64×; this hard-surface hull de-dups well as `packed20`). Curved sphere +
  torus test hull, 36 318 quads (greedy merges only 29 %): **`packed20` 2 870 KiB (103 k verts → Uint32 indices) vs
  `quad16` 567 KiB = 5.06×** — one part, one draw. Against `packed20`'s **92 B per quad** (4 × 20 B vertices + 6 × 2 B
  indices; 104 B once a part passes 65 535 vertices and needs Uint32) `quad16` is **5.75×** smaller.

### 5.3 `packed20` — meso prefabs (20 B per vertex)

Meso prefabs stay indexed meshes, quantized into each prefab's AABB. All four attributes are normalized.

| Bytes | Type (normalized) | Attribute | Content |
|---|---|---|---|
| 0–7 | Int16 × 4 | `aPosQ` | xyz = `round(clamp((p − posCenter) / posHalfExt, −1, 1) · 32767)` · w = `bevelHint · 32767` |
| 8–11 | Int8 × 4 | `aNormQ` | xyz = normal · 127 · w = micro AO · 127 (positive half, 7 bit) |
| 12–15 | Uint8 × 4 | `aColEm` | rgb albedo · a emissive |
| 16–19 | Uint8 × 4 | `aMeta2Q` | x matTag (decode `floor(x·255 + 0.5)`) · y macro AO (8 bit) · z `creaseMask` · w `panelId` |

- Every prefab carries its own `posCenter` / `posHalfExt` (rounded to 1e-6 **before** quantising, so the JSON decodes
  the stream exactly). Round trip on 1000 u bounds: **≤ 0.0076 u** (self-test < 0.03 u).
- Indices are **Uint16** for every prefab with ≤ 65 535 vertices, else Uint32 (every block stays 4-byte aligned, M11).
  At 20 B/vertex a greedy mesh costs ~1.6 vertices per triangle, so Uint32 indices would be a third of the file (M16).
- Mesher tags (`greedyMeshPart(…, { format: 'MEGA_V22' })`, which is how prefabs are meshed for `packed20`):
  - `bevelHint` = 1 on the **convex** corners of **narrow** quads (min(w, h) ≤ 2 voxels): stepped 45° chamfer treads,
    strap crests, rib tops.
  - `creaseMask` = 1 on the **concave** corners of narrow quads (corner micro AO < 3): step-riser feet, grooves, recess
    floors. Wide quads get 0 — a corner flag on a 40-voxel quad would smear a gradient across it.
  - `panelId` = `grid.panel` (optional Uint8 plane, §4.1).
- Instances: `Float32 mat4 × instanceCount` (column-major, 64 B each, ready for `InstancedMesh.instanceMatrix`) +
  `Float32 rgb × instanceCount` (12 B each).

### 5.4 Packing an asset: `packMegaAsset({ format: 'MEGA_V23' })`

```js
import { MegaPalette, VoxelGrid, packMegaAsset, writeMegaAsset } from '<skill>/scripts/mega_voxel_kit.mjs';
const packed = packMegaAsset(
  { id: 'carrier_01', name: 'Carrier 01', format: 'MEGA_V23', palette, voxelScale: 2.0, center, macroLevels: 16,
    archetype: 'hard_surface_carrier', materialProfile: 'hard_surface', detailZones, aoOpts: { rays: 24, maxDist: 24 } },
  [{ name: 'hull', grid: hull }, { name: 'ring', kind: 'ring', grid: ring, anim: { … } }],   // macro parts (1–8)
  [{ id: 'turret', grid: turret, voxelScale: 1.2, pivot: [6, 6, 0] }],                       // meso prefabs
  instances);                                                                                   // [{ prefab, pos, rotQuat, scale, tint, zone? }]
writeMegaAsset('build/carrier_01', packed);   // → carrier_01.json + carrier_01.bin; packed.json.budget = static G6
```

`<id>.json` (top level `schema: 'svox.mega/v2.3'`, `vertexFormat: 'quad16+packed20'`, `quadStrideBytes: 16`,
`vertexStrideBytes: 20`, `quadLayout`):

```
{ schema, kitVersion, id, name, faction, archetype, materialProfile?, styleTag?, vertexLayout, vertexFormat,
  quadStrideBytes, vertexStrideBytes, quadLayout, instanceLayout, units: "u", axes, bounds { min, max, size },
  macro { voxelScale, parts[ { name, kind, vertexFormat: 'quad16', quadOffset, quadCount, quadByteLength, gridOrigin,
          voxelScale, macroLevels, bounds, dims, voxels, exposedFaces, quads, triangles, reduction, macroAo, anim?,
          waveAmp? / waveFreq? / waveOriginY? / waveAxis? / waveCenter? / waveRadii? } ] },
  meso { prefabs[ { id, voxelScale, dims, pivot, posCenter, posHalfExt, vertexOffset, vertexCount, indexType,
          indexOffset, indexCount, bounds, instanceCount, instanceMatrixOffset, instanceMatrixByteLength,
          instanceColorOffset, instanceColorByteLength } ] },
  instances[ { prefab, pos, rotQuat, scale, tint, zone? } ], detailZones[],
  palette[ { index, name, hex, emissive, matTag } ],
  stats { voxelCount, exposedFaces, quads, greedyReduction, macroTriangles, mesoUniqueTriangles, instancedTriangles,
          uniqueTriangles, totalTriangles, macroDrawCalls, mesoBatches, drawCalls, instanceCount, prefabCount, binBytes,
          macroQuads, macroQuadBytes, quadStrideBytes },
  budget { staticPass, runtimeMeasured, pass, checks[] } }
<id>.bin   per macro part: quad16 stream │ per prefab: packed20 vertices, Uint16/Uint32 indices,
           Float32 mat4 × instanceCount (column-major), Float32 rgb × instanceCount
```

- `faction` is a free string kept verbatim for engines that key their lookdev on it. `materialProfile` (optional) is
  the resolved `{ id, index, tags, uniforms }` of a `MATERIAL_PRESETS` name or a custom profile (§6.3); `styleTag` is a
  free string. Neither is required, and neither changes a byte of the `.bin`.
- The output is deterministic: there are no timestamps or timings, float fields are rounded to 1e-4, and two
  independent builds give the same sha256 (self-tested).
- `readMegaAsset` decodes every schema (v2.3, v2.2, v2) to 12-float vertices (+ `extra`, + the raw packed stream), so
  `renderPreview` and G5 work on all of them.

### 5.5 Zero-copy WebGL2 / Three.js loader

Condensed from the verified reference loader (Three.js r187, `RawShaderMaterial`, `glslVersion: THREE.GLSL3`). Every
`.bin` block is 4-byte aligned, so the typed-array views never throw.

```js
const UNIT = { corners: [0, 0, 1, 0, 1, 1, 0, 1], indices: [0, 1, 2, 0, 2, 3] };
function quad16Geometry(p, bin) {                     // p = json.macro.parts[i] (vertexFormat 'quad16')
  const n = p.quadCount;
  const b16 = new THREE.InstancedInterleavedBuffer(new Uint16Array(bin, p.quadOffset, n * 8), 8, 1);   // stride 8 elements
  const bu8 = new THREE.InstancedInterleavedBuffer(new Uint8Array(bin, p.quadOffset, n * 16), 16, 1);  // stride 16 elements
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('aCorner', new THREE.BufferAttribute(new Float32Array(UNIT.corners), 2));
  g.setIndex(UNIT.indices.slice());
  g.setAttribute('aQOrigin', new THREE.InterleavedBufferAttribute(b16, 3, 0, false));   // raw integers
  g.setAttribute('aQSize', new THREE.InterleavedBufferAttribute(bu8, 2, 6, false));
  g.setAttribute('aQColEm', new THREE.InterleavedBufferAttribute(bu8, 4, 8, true));     // normalized
  g.setAttribute('aQMeta', new THREE.InterleavedBufferAttribute(bu8, 4, 12, false));
  g.instanceCount = n;                                 // ONE drawElementsInstanced per part
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;                                            // + uniforms uGridOrigin = p.gridOrigin, uVoxelScale = p.voxelScale
}
function packed20Geometry(p, bin) {                   // p = json.meso.prefabs[i]
  const n = p.vertexCount;
  const b16 = new THREE.InterleavedBuffer(new Int16Array(bin, p.vertexOffset, n * 10), 10);
  const b8 = new THREE.InterleavedBuffer(new Int8Array(bin, p.vertexOffset, n * 20), 20);
  const bu8 = new THREE.InterleavedBuffer(new Uint8Array(bin, p.vertexOffset, n * 20), 20);
  const g = new THREE.BufferGeometry();
  g.setAttribute('aPosQ', new THREE.InterleavedBufferAttribute(b16, 4, 0, true));
  g.setAttribute('aNormQ', new THREE.InterleavedBufferAttribute(b8, 4, 8, true));
  g.setAttribute('aColEm', new THREE.InterleavedBufferAttribute(bu8, 4, 12, true));
  g.setAttribute('aMeta2Q', new THREE.InterleavedBufferAttribute(bu8, 4, 16, true));
  const I = p.indexType === 'uint16' ? Uint16Array : Uint32Array;
  g.setIndex(new THREE.BufferAttribute(new I(bin, p.indexOffset, p.indexCount), 1));
  return g;                                            // + uniforms uPosCenter = p.posCenter, uPosHalfExt = p.posHalfExt
}
for (const p of json.meso.prefabs) if (p.instanceCount) {
  const im = new THREE.InstancedMesh(packed20Geometry(p, bin), capitalInstancedMat, p.instanceCount);   // 1 draw call
  im.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(bin, p.instanceMatrixOffset, p.instanceCount * 16), 16);
  im.geometry.setAttribute('aInstTint', new THREE.InstancedBufferAttribute(new Float32Array(bin, p.instanceColorOffset, p.instanceCount * 3), 3));
  im.frustumCulled = false;                           // a floating origin moves the asset every frame
  group.add(im);
}
```

- Three.js uploads one GL buffer per `InterleavedBuffer`, so the Uint16 + Uint8 views of a `quad16` slice become 2 GPU
  copies (32 B / quad on the GPU; the `.bin` and the CPU stay at 16 B, M22), and a `packed20` block is resident 3× on the
  GPU — still far below a Float32 path's cost. A raw-GL single-buffer variant is possible but not needed.
- Measured (Three.js r187, ANGLE D3D11): the `quad16` demo carrier and its `packed20` twin differ on 0.4 % of pixels by
  > 24/765 and on ~60 px by > 60 (bevel hints, M20); frame cost 1.30 vs 1.25 ms (hero framing, readPixels-synced, whole
  frame).

## 6. Stage 4 — Lookdev shaders and the Early-Z contract

The reference programs are `CAPITAL_QUAD16_VERT` (macro `quad16` parts), `CAPITAL_VERT_Q` / `CAPITAL_INST_VERT_Q`
(`packed20`, plain and instanced) and one `CAPITAL_FRAG`. **Early-Z contract:** the FINAL program contains **0
`discard` and 0 `gl_FragDepth`**, with depthTest / depthWrite on. Every lookdev effect below changes colour or emissive
only. Keep any debug `discard` (such as the sprite-stack air gaps) in a **separate program variant**
(`CAPITAL_FRAG_STACK`) that is swapped in only for that debug view.

### 6.1 Vertex stages

- **`CAPITAL_QUAD16_VERT`:** `d = dir >> 1`, `(d, u, v)` cyclic so `e_u × e_v = e_d`. The unit corner `c` is rotated 90°
  when `diagFlip` (`c → (1 − c.y, c.x)`: split diagonal 00–11 → 10–01, the AO-anisotropy diagonal) and mirrored
  (`c → c.yx`) for negative dirs (reversed, still CCW-outward winding). Then
  `p = gridOrigin + (origin + e_u·c.x·du + e_v·c.y·dv) · voxelScale`, normal `±e_d`, the corner's own micro AO,
  `bevelHint = bevelQ/3` on corners with AO 3, `creaseMask = creaseQ/3` on corners with AO < 3, `panel = panelId / 15`.
  Declare `aQOrigin` / `aQSize` / `aQMeta` non-normalized and decode bit fields with `int(x + 0.5)` + `& >>` (M22). It
  writes the **same varyings** as `CAPITAL_VERT_Q`, so `CAPITAL_FRAG`, `CAPITAL_FRAG_STACK` and every debug mode run
  unchanged.
- **`CAPITAL_VERT_Q` / `CAPITAL_INST_VERT_Q`:** decode `pos = uPosCenter + aPosQ.xyz · uPosHalfExt`, normal `aNormQ.xyz`,
  micro AO `aNormQ.w`, matTag `floor(aMeta2Q.x·255 + 0.5)`. The instanced variant multiplies by `instanceMatrix`
  (`vec4 w = uModel * instanceMatrix * vec4(p, 1.0); vN = mat3(uModel) * mat3(instanceMatrix) * n;`) and tints by the
  per-instance colour.

### 6.2 Hard-surface 70/30 visual-rest plates, ink and AO

- **No uniform brick tiling.** A 14.4 u seam grid on every armour face reads as bricks. Use 32 × 18 u staggered plates,
  draw only ~55 % of the butt joints along a course (plates of 32–96 u), lighter course seams, ±4 % value per plate
  seeded by `panelId`, recessed fasteners only near the corners of ~28 % of plates, all `fwidth`-faded before they can
  alias. Most of the surface is resting plate — the detail clusters at seams, straps and recesses (M18).
- **Ink:** a `creaseMask` foot line (1 px where the interpolated mask reaches 1 within one pixel, via `fwidth`), grazing
  risers inked, a `dFdx/dFdy` geometric-normal break; a G-buffer actor mask of 0.90 makes the post pass draw the crease /
  cavity outlines ink-black with a cool convex lift (curved forms use 0.82 instead, §6.6). Per-fragment derivatives
  alone **cannot** see edges between flat triangles — the crisp 1 px ink has to come from the G-buffer pass.
- `bevelHint` crests +8–12 % toward cool blue-white when sunlit; `pow(macroAo, 1.32)`; a stepped cool Fresnel rim in
  space; a warm-amber bounce inside the interior bay box (matTag 5 + an asset-local volume, `uHangarBounce`, §6.3).
- Dual-scale AO: `aoMicro × mix(1, macroAo, uMacroAoStrength · (1 − em))` — emissive cells are never darkened (M9).
- The G-buffer outputs are the Track A ones (`oColor.a = 1 − 0.5·em`, `oNormal = n·0.5 + 0.5`), so the post pass's 1 px
  ink and glow halo work unchanged. Micro-windows are emissive, so they bloom through the existing halo — the cue that
  sells 1000 u of scale.
- In the reference shader this lookdev is switched on per asset by the `uLookV22` uniform (1 for `packed20` / `quad16`
  assets).

### 6.3 Material channels: `matTag` and `MATERIAL_PRESETS`

`matTag` is a **4-bit material channel (0..15)** per voxel (palette entry, or `flags & MAT_MASK`). The kit only stores
and packs it; what each value looks like is decided by your shader. `MATERIAL_PRESETS` documents the legend the
reference `CAPITAL_FRAG` implements, and `index` is the value its per-asset profile uniform (`uFactionId`) expects
(3 = any other profile). The profiles differ only in tags 5 and 6 and in the interior bounce; tags 7 and 8 render the
same everywhere. Tags 9–15 are free in every preset.

| matTag | `hard_surface` (index 0) | `ornate_stone` (index 1) | `organic_bio` (index 2) |
|---|---|---|---|
| 0 | default | default | default |
| 1 | armour plates (70/30 resting plates, §6.2) | same | same |
| 2 | hazard / accent paint | same | same |
| 3 | deck | same | same |
| 4 | glass / viewport | same | same |
| 5 | interior bay: warm bounce + service lines | plain interior (no service lines, no bounce) | plain interior |
| 6 | engine-frame plates | **organic chitin / bio-carapace** — warped directional ridge grain (~10 u, never a straight seam), soft mottling, stepped violet sheen along curved crests, deep dark-purple crevices from `1 − macroAo` + crease, violet-black ink | same as `ornate_stone` |
| 7 | **ornate gold & ivory trim** — warm-gold metallic lift + glint on convex bevels (gold = saturated warm albedo), ivory bevels a clean soft lift, recessed double-line trim inlays on ~38 % of the 48 u bays (70/30 rest) | same | same |
| 8 | **bio-luminescent cavity** — glow + emissive scaled by cavity depth `1 − macroAo` (hotter core deeper in), faint vein network, NO mechanical lines | same | same |
| `uHangarBounce` | 1: warm-amber bounce box inside the interior bays (reference carrier: abs x 40..185, abs y < 165, z −122..2) | 0 | 0 (the bounce tinted violet flank flesh orange) |

- Select a profile per asset with `packMegaAsset({ materialProfile: 'organic_bio' })` (or a custom
  `{ id, tags: { 9: 'stained glass' } }`, validated to 0..15) and drive the uniforms from `json.materialProfile`
  instead of hard-coding one asset's legend (M23). All of this is colour-only in FINAL; CLAY / MACRO_MESO / WIRE / AO
  are unaffected and Early-Z is untouched.
- The kit's older `MAT_TAGS` export lists the original baseline legend used by the micro-detail snippet in §6.4
  (1 hull plating, 2 deck, 3 light, 4 greeble, 5 organic chitin, 6 crystal, 7 gold filigree, 8 glass). When you adopt a
  preset legend, remap that snippet's `tag ==` branches to it.

### 6.4 Tier-3 micro-detail snippet (reference — port, then verify with G5/G6)

The vertex stage passes the local (object) position `vLP` in u and the local axis-aligned normal `vLN`. The function
runs inside `CAPITAL_FRAG` before lighting and touches colour and emissive only.

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
// in main(), replacing the base albedo / ao lines:
vec4 md = microDetail(vLP, normalize(vLN), vTag);
vec3 albedo = vCol * md.rgb;
float aoMicro = smoothstep(0.1, 0.92, vAo);
float aoMacro = mix(1.0, vMacroAo, uMacroAoStrength * (1.0 - vEm));   // emissive cells are never darkened
float ao = aoMicro * aoMacro;                                          // then the base 4-step quantisation
// … base cel lighting unchanged …
em = clamp(max(vEm, md.a) * uEmissiveMul, 0.0, 1.0);
```

### 6.5 Debug modes

`uCapDebugMode`: 0 FINAL · 1 AO · 2 STACK · 3 WIRE (voxel lattice) · 4 CLAY (warm-grey clay + dual AO + ink) ·
5 MACRO_MESO (cool slate macro vs. tinted meso prefabs). All except STACK live in the discard-free FINAL program; STACK
uses the separate `CAPITAL_FRAG_STACK` variant.

### 6.6 Structure-aware ink (`capSoftInk`)

**Problem.** On curved or organic voxel forms (domes, rings, ribbed carapace) every 1-voxel stair step is a real normal
break, so hard-surface ink paints a black line on each step: the dome reads as a dark staircase instead of a curve.
**Fix:** keep the crisp 1 px silhouette and real structural creases, and soften only the shallow stair steps on exposed
crests. Hard-surface assets keep the old path exactly.

| G-buffer mask (`oNormal.a`) | Asset kind | Post pass |
|---|---|---|
| **0.90** (`capInk`) | hard-surface (`hard_surface` profile) | ink-black silhouette + every normal crease (unchanged, **0 px** difference) |
| **0.82** (`capSoftInk`) | curved / organic / ornate (any other profile) | ink-black silhouette; strong crease ink only on a real depth step, gentle 0.22 mix on 1-voxel stairs |
| 1.0 | Track A actors | Track A outline rules |

Every mask stays above the 0.75 actor threshold, so silhouettes, glow halos and occlusion work unchanged.

```glsl
// CAPITAL_FRAG (FINAL, colour only): soften per-step ink on exposed crests of curved assets
vec3 fww = fwidth(vLocalPos);
float pxU = max(max(fww.x, fww.y), fww.z);                                   // u per screen pixel
float stairK = uCurvedForm > 0.5 ? smoothstep(0.25, 0.45, pxU / max(uVoxelScale, 1e-3)) : 0.0;   // dense sub-2 px steps
float crestK = smoothstep(0.50, 0.62, vMacroAo);                              // exposed crest (1) vs real cavity (0)
float softInk = stairK * crestK;
float creaseK = smoothstep(0.2, 1.0, vCrease) * (1.0 - 0.85 * softInk);
float inkLine = step(0.015, cw) * smoothstep(1.0 - 1.6 * cw, 1.0 - 0.4 * cw, vCrease) * (1.0 - 0.9 * softInk);
float graze   = smoothstep(0.93, 0.992, 1.0 - abs(dot(N, V))) * (1.0 - 0.6 * softInk);
col = mix(col, inkCol, ink * mix(0.88, 0.62, softInk));
oNormal = vec4(N * 0.5 + 0.5, uCurvedForm > 0.5 ? 0.82 : 0.90);

// POST_FRAG
bool capInk     = mask > 0.85 && mask < 0.95;                                 // hard-surface megastructure
bool capSoftInk = mask > 0.78 && mask < 0.86;                                 // curved / organic megastructure
if (found) col = (capInk || capSoftInk) ? mix(col, INK, 0.9) : …;            // crisp 1 px silhouette for both
// inner normal crease: remember whether the neighbour is a real depth step
if (abs(ld - ldq) < thr && dot(N, Nq) < uCreaseDot) { crease = …; deep = deep || abs(ld - ldq) > 0.008 * ld; }
if (crease > 0.0) col = capInk ? mix(col, INK, 0.62 + 0.5 * uCreaseStrength)
                      : capSoftInk ? mix(col, INK, deep ? 0.62 + 0.5 * uCreaseStrength : 0.22) : …;
```

- `uCurvedForm` is any per-asset switch derived from the material profile (the reference shader uses its profile
  index: `hard_surface` = 0 keeps the 0.90 path).
- Tint organic ink instead of pitch black: deep violet-plum `(0.075, 0.028, 0.095)` on carapace and flesh, warm umber
  `(0.17, 0.10, 0.05)` on ivory, bone and gold (`mix` by a warm-albedo weight).
- Measured: on hard-surface structures 0 pixels of the structure changed; on a ringed ornate vessel the black stair ink on the
  curved gold rings disappeared while the silhouette and the cavity creases stayed crisp.

### 6.7 Non-clipping, form-preserving emissives

**Problem.** Bright emissive voxels clip to a flat neon sticker: a faceted crystal or a glowing organic orb loses all of
its planes. **Fix:** keep a directional and view-angle form term inside the glow, roll the highlight off with a soft
shoulder, and normalise by the largest channel so the hue never washes to white.

```glsl
if (uCurvedForm > 0.5 && em > 0.01) {
  float nv = clamp(dot(N, V), 0.0, 1.0);
  float form = mix(0.70, 1.08, 0.45 * diff + 0.55 * pow(nv, 0.65));          // lit / grazing planes stay readable
  vec3 e = albedo * 1.22 + vec3(0.02);
  // optional per-material looks: recessed rims (mix toward a darker shade by pow(1 - nv, 1.4)),
  // faceted crystals (form = mix(0.62, 1.10, floor((0.6 * diff + 0.4 * nv) * 3.0 + 0.5) / 3.0))
  e *= form;
  e = e / (1.0 + max(vec3(0.0), e - 0.88) * 0.45);                            // soft highlight shoulder
  emCol = e / max(1.0, max(max(e.r, e.g), e.b));                               // hue-preserving normalise
}
if (em > 0.01) col = mix(col, emCol, em);
```

Colour only: the G-buffer alpha (`1 − 0.5·em`) still feeds the glow halo, and Early-Z is untouched. Measured: glowing
pustules read as shaded spheres instead of flat blobs, and crystals show distinct lit and dark facets.

### 6.8 Material-profile shadow and rim protection

- **Organic carapace (velvet lift).** Dark sculpted carapace crushes to black in space. On the carapace tag add a warm
  floor on the shadow side — `col = max(col, albedo * vec3(0.66, 0.50, 0.80) * (0.30 + 0.16 * diff) * aoMacro)` — plus
  a small shadow-side lift, and darken crevices from cavity depth (`1 − macroAo`) rather than from every crest step.
- **Warm bone / ivory.** Pale warm albedo under a cool space shadow tint turns grey. Detect it
  (`warm = smoothstep(0.05, 0.16, r − b) · smoothstep(0.42, 0.62, mean(rgb))`), blend the shadow tint toward a warm umber
  ramp (`avg(shadowTint) · vec3(1.22, 0.98, 0.74)`) by `0.8 · warm`, and attenuate the cool Fresnel rim by `1 − 0.7 · warm`.
- Scope both by material profile and tag (M23): hard-surface assets never take these branches.

### 6.9 Anchored wave deformation (`uWaveMode`)

A legacy `'y'` wave sways everything behind a Y plane, which also moves the root of a split appendage and opens a seam
against the static hull. Anchor the sway on the distance **outside** a root volume instead; voxelize with
`axis=box:auto` / `axis=ellipsoid:auto` (§2B.6) so the volume is the measured junction box.

```glsl
uniform float uWaveMode;     // 0 = 'y' (legacy) · 1 = 'ellipsoid' · 2 = 'box'
uniform vec3  uWaveCenter;   // part-local u (json waveCenter)
uniform vec3  uWaveRadii;    // radii / box half extents (json waveRadii)
if (uWaveAmp > 0.0) {
  float d = max(uWaveOriginY - p.y, 0.0);  vec3 g = vec3(0.0, -1.0, 0.0);
  if (uWaveMode > 1.5) { vec3 r = p - uWaveCenter, o = max(abs(r) - uWaveRadii, vec3(0.0)); d = length(o); g = d > 1e-3 ? o * sign(r) / d : g; }
  else if (uWaveMode > 0.5) { vec3 r = p - uWaveCenter; float lr = length(r), s = max(length(r / max(uWaveRadii, vec3(1.0))), 1e-4);
                              d = max(lr - lr / s, 0.0); g = lr > 1e-3 ? r / lr : g; }
  float k = d / max(uWaveLen, 1.0), il = 1.0 / max(uWaveLen, 1.0);
  float ph = d * uWaveFreq - uWavePhase * 2.4 + p.x * 0.021, ph2 = ph * 0.83 + 1.3 + p.x * 0.013;
  float fx = sin(ph) * uWaveAmp * k, fz = cos(ph2) * uWaveAmp * 0.55 * k;
  float dfx = cos(ph) * uWaveFreq * uWaveAmp * k + sin(ph) * uWaveAmp * il;
  float dfz = -sin(ph2) * 0.83 * uWaveFreq * uWaveAmp * 0.55 * k + cos(ph2) * uWaveAmp * 0.55 * il;
  if (d > 0.0) { p.x += fx; p.z += fz; n = normalize(n - g * (dfx * n.x + dfz * n.z)); }   // n' = J^-T n
}
```

- Inside the anchor volume `d = 0`, so the root is exactly static: measured **0 px** seam drift between a static hull
  and its split wave tentacles over an animation, while the tentacles moved ~70k px.
- `'y'` mode is mathematically identical to the legacy wave, so existing assets need no change.
- Vertex-only: the fragment program, and therefore Early-Z, is untouched.

**Early-Z invariant.** §6.6–§6.9 change colour, the G-buffer mask value and vertex positions only. The FINAL fragment
program still contains **0 `discard` and 0 `gl_FragDepth`**; check it with a source grep in CI.

## 7. Stage 5 — Quality and performance gates (G5 and G6)

### 7.1 G5 — Multi-cue concept diff

**Renders.** The engine must produce all of these. `renderPreview` only gives a CPU stand-in for smoke tests.

| Shot | Camera | Mask | Target |
|---|---|---|---|
| Hero 3/4 | match the concept's studio camera: yaw, pitch and FOV (orthographic if the concept reads as orthographic) | concept: `key`; render: transparent clear → `alpha` | **IoU ≥ 0.78** |
| Ortho top / side / front | `VIEW_CONVENTIONS` | the Stage 1A blueprint views vs. ortho renders | **IoU ≥ 0.85 each** |
| Every detail zone | the zone's `camera` / `cameraView` | callout vs. render (optional `iouTarget`) | **every `requiredFeature` ticked by eye** |

Silhouette IoU alone passes a "wedding-cake" hull with a flat, empty interior, so G5 measures three cues **inside**
the foreground mask on bbox-registered 256² frames:

| Cue | Measure | Target |
|---|---|---|
| G5-Silhouette | `computeSilhouetteIoU` | hero ≥ 0.78 · each ortho ≥ 0.85 |
| **G5-Edge** | `computeEdgeG5`: luma → [1 2 1] blur → Sobel → non-max suppression → strongest 42 % of ridge pixels, rim excluded (mask eroded 3 px) → symmetric dilated-edge **F1 (radius 2 px)** + mean **chamfer distance** (3-4 DT) | hero F1 ≥ 0.52 · **ortho average** F1 ≥ 0.55 |
| **G5-Band** | `computeBandG5`: share of the foreground + centroid of each **accent colour band** (default `DEFAULT_ACCENT_BANDS`: amber h 20–54°, s ≥ 0.45, v ≥ 0.3 · cyan h 165–205°, s ≥ 0.4, v ≥ 0.42) | per band: share ratio 0.5–2.0 and centroid Δ ≤ 0.16 |

- **Configurable bands.** Pass `opts.bands = [{ name, hue: [minDeg, maxDeg], minS, minV, rgb? }]` (a hue range with
  `minDeg > maxDeg` wraps through 0°, e.g. crimson `[340, 20]`), or on the CLI
  `multicue … --bands crimson:340-20:0.45:0.30,gold:35-58:0.45:0.35`. Results are keyed by band name; with the default
  bands they keep their `amber` / `cyan` keys. Pick the bands that carry your palette's accents — an amber / cyan gate
  is blind to a lime / magenta organic palette.
- Always read F1 next to `baselineF1` (render flipped top↔bottom = the chance level of that pair). L↔R flips are useless
  on bilaterally symmetric assets. **Do not widen the radius to 3 px to pass:** on the reference carrier's top view the
  chance level at r = 3 is 0.60 — above the 0.55 target (M19).
- `computeMultiCueG5` / `multiCueSummary` / `composeMultiCueSheet` (5 columns: concept · render · IoU · edge overlay
  white = hit / cyan = extra / red = missed · band split coloured per band) and CLI `mega_diff_utils.mjs multicue`.
- Self-test: identical → F1 1.0; flat interior with the same outline → IoU 1.000 but F1 0.47 / chamfer 9.6 px → FAIL;
  missing or displaced amber band → FAIL; a render missing its crimson accents fails on crimson while emerald passes.

**Hull-only silhouette for appendage-heavy forms.** Tentacles, antennae and other curling appendages change the full
silhouette (and its bbox → framing) far more than the hull. `computeHullSilhouetteIoU` (CLI `hull`) isolates the core
hull: explicit hull masks (concept with appendages painted out + render without the `wave` part —
`renderPreview(…, { excludeKinds: ['wave'] })`) or automatic morphological opening (3 px at 2× size) + largest blob; both
are **re-registered on the hull's own bbox**. Target **≥ 0.86**, reported next to the full silhouette IoU. Self-test:
curled vs. hanging tentacles full 0.30 → hull 0.993; a flattened dome still fails (0.77). Measured baseline: a
`packed20` build of the organic leviathan at 5 u/vox (flattened dome) against its hull masks scored top 0.68 / side
0.59 / front 0.69 — the dome / proportion gap that the `quad16` budget exists to close.

**Procedure.** Run the 4 sculpt passes (§4) and keep each pass's sheet as `qa/g5_<asset>_pass<N>.png` with its IoU
table. Micro detail must not change a silhouette; if an IoU drops in pass D, something is wrong.

```bash
node scripts/mega_diff_utils.mjs sheet --pairs qa/g5_carrier_pass2.json --out qa/g5_carrier_pass2.png --title "CARRIER PASS 2"
#   pairs.json = [{ "label": "HERO 3/4", "ref": "concept_34.png", "render": "render_34.png", "target": 0.78 },
#                 { "label": "TOP", "ref": "bp_top.png", "render": "ortho_top.png", "target": 0.85 }, …]
#   exit 1 if any pair is below its target; every row shows [concept | render | IoU mask], green = both,
#   red = missing in the render, blue = excess
node scripts/mega_diff_utils.mjs iou --ref concept_34.png --render render_34.png --target 0.78 --diff qa/hero_diff.png
node scripts/mega_diff_utils.mjs multicue --ref concept_34.png --render render_34.png --kind hero --out qa/g5_multicue.png
node scripts/mega_diff_utils.mjs hull --ref side.png --render side_render.png --ref-hull side_hull.png \
     --render-hull side_render_nowave.png --target 0.86
```

**Registration.** The default `register: 'bbox'` crops both masks to their silhouette bbox and scales them
**uniformly** into 256². Framing, zoom and offset differences vanish, but a proportion error stays visible. In the
self-test, a 1.3 : 1 stretch scored 0.767, while `bbox-stretch` hid it at 0.993. Use `bbox-stretch` only for loose
callout crops.

The gate **fails** if any IoU is below target, if any `requiredFeature` is not visibly present, if a zoomed hero-zone
close-up shows a craft defect (M13–M15), or if the sheet was not opened and inspected by eye. Report every number,
including the ones that miss.

### 7.2 G6 — Performance budget (`MEGA_V23_BUDGET`)

| Check | Limit | How to measure |
|---|---|---|
| Draw calls | ≤ 16 (1–8 macro + ≤ 15 meso batches) | `stats.drawCalls` (static), then `renderer.info.render.calls` with the asset on minus off |
| Triangles | total ≤ 1.2 M; meso unique ≤ 600k | `stats.totalTriangles` / `stats.mesoUniqueTriangles` |
| `.bin` | ≤ 12 MiB | `stats.binBytes` |
| Early-Z | 100 % alive | the FINAL-mode megastructure programs contain no `discard` and no `gl_FragDepth` (grep the compiled source), with depthTest / depthWrite on |
| GPU frame delta | ≤ 2.5 ms @ 60 fps | readPixels-bracketed median of ≥ 40 frames at the framed hero camera, asset on minus off ([03 pitfall 2](03_pitfalls_and_qa_gates.md): never `gl.finish()`) |

- `checkPerfBudget(stats, MEGA_V23_BUDGET, runtime)` returns `staticPass`. A run with **no runtime numbers is never a
  pass**: `earlyZAlive` and `gpuDeltaMs` show as `unmeasured`. `inspect` prints the static checks.
- Estimate, not a measurement: going from 5.2 to 3.5 u/vox multiplies exposed faces by about (5.2/3.5)² ≈ 2.2×, so a
  1000 u hard-surface hull at 3.5 u/vox should land near 40k macro triangles. Measure it.

### 7.3 Measured reference results

| Asset | Draws | Triangles | `.bin` | Runtime |
|---|---|---|---|---|
| Demo carrier (`demo --format MEGA_V23`), static checks | 3 | 8.4k (5.2k macro + 3.2k instanced meso) | 56 KiB (macro 189 → 41 KiB) | — (unmeasured = failed) |
| Hard-surface carrier, `quad16` hero build | 10 | 410k | 8.93 MiB | Δ 0.79 ms (GPU) |
| Ornate temple vessel, `quad16` hero build | 9 | 802k | 6.02 MiB | 0.3 ms (CPU) |
| Organic tentacled leviathan, `quad16` hero build | 5 | 1.11 M | 8.03 MiB | 0.7 ms (CPU) |
| Hard-surface carrier, Mode B2 (mesh → 1.4 u/vox `quad16` hull + 7 `packed20` prefab types, 31 instances) | 8 | 662k | 8.74 MiB | Δ 1.275 ms (engine), 0.6 ms (CPU) |
| Ornate ringed vessel, Mode B2 (hull static + ring rotate + core rotate-and-bob, one shared AO, 2.0 u/vox) | 3 | 908k | 6.93 MiB | 3.0 ms whole-frame CPU median |
| Organic tentacled leviathan, Mode B2 (hull static + wave tentacles, box-anchored, 2.2 u/vox) | 2 | 1.13 M | 8.61 MiB | 3.8 ms whole-frame CPU median; 0 px root seam drift |
| Older single-grid megastructures (11-float layout) | 1–3 | 19–33k | — | +0.10–0.31 ms (GTX 1080, D3D11) |

## 8. Kit API and CLI reference (`scripts/mega_voxel_kit.mjs`, `scripts/mega_diff_utils.mjs`)

Node ≥ 18 with zero npm dependencies. Import from another script with
`import { … } from '<skill>/scripts/mega_voxel_kit.mjs'`. Both files are also CLIs; each exits 1 on errors or on a
failed target.

| Function / constant | Purpose |
|---|---|
| `new MegaPalette().add(name, '#hex', { emissive, matTag })` | palette (≤ 255 entries, matTag 0..15) |
| `MATERIAL_PRESETS`, `resolveMaterialProfile(profile)` | material-channel legends (`hard_surface`, `ornate_stone`, `organic_bio`) and custom profiles (§6.3) |
| `new VoxelGrid(nx, ny, nz)` | `.box / .ellipsoid / .capsule / .prism / .subtract / .apply(shape, c, { mode, panel })`, `.mirrorX()`, `.resample(K, pal)`, `.bbox()`, `.count()`, `.activePanel`; flags `F_LOCK`, `F_CAVITY`, `F_ZONE`, `MAT_MASK` |
| `projectSilhouettes(grid)` / `gridIoU(a, b)` | ortho masks per `VIEW_CONVENTIONS` / 3D occupancy IoU |
| `hullDimsFromMasks(masks, { lengthY, voxelScale })` | dims, bounds and view-consistency mismatch from 3 blueprint PNGs |
| `carveVisualHull(grid, { top, side, front }, bounds, opts)` | Stage 1A fill / carve + per-view fidelity |
| `DETAIL_ZONE_ARCHETYPES` (alias `ARCHETYPES`), `scaffoldDetailZones` / `validateDetailZones` / `applyDetailZoneCarves` / `zoneVoxelStats` | Stage 1B |
| `bakeMacroCavityAO(grid, { rays, maxDist, blurRadius, startOffset, falloff })` | Stage 3 macro AO table |
| `greedyQuad16Part(grid, pal, opts)`, `packQuad16` / `unpackQuad16` / `quad16ToMesh` / `quad16Corner`, `QUAD16_LAYOUT` | `quad16` mesher and codec |
| `greedyMeshPart(grid, pal, { voxelScale, center, macroAo, macroLevels, format, region })` | AO-preserving indexed greedy mesh (`'MEGA_V22'` = `packed20` tags, `'MEGA_V2'`, `'FLOAT11'`) |
| `packQuantizedMegaV22` / `unpackQuantizedMegaV22` | the `packed20` vertex codec |
| `packMegaAsset(manifest, macroParts, mesoPrefabs, instances)` → `writeMegaAsset(base, packed)` → `readMegaAsset(json)` | `svox.mega/v2.3` (`format: 'MEGA_V23'`); legacy formats in Appendix A |
| `checkPerfBudget(stats, budget, runtime)`, `MEGA_V23_BUDGET` | G6 |
| `renderPreview(asset, { view, yaw, pitch, excludeKinds, excludeParts })` | CPU z-buffer preview (transparent background) |
| `computeSilhouetteIoU` / `composeComparisonSheet` | G5-Silhouette and comparison sheets |
| `computeEdgeG5` / `computeBandG5` / `computeMultiCueG5` / `multiCueSummary` / `composeMultiCueSheet` | G5 multi-cue |
| `DEFAULT_ACCENT_BANDS`, `normalizeAccentBands`, `parseAccentBands`, `accentClass(r, g, b, bands)` | configurable accent bands |
| `computeHullSilhouetteIoU`, `G5_V23_TARGETS` | hull-only G5 |
| `decodePNG / encodePNG / readPNG / writePNG / toMask / registerMask` | zero-dependency PNG and mask tools |
| `scripts/mesh_source.mjs`, `scripts/mesh_to_voxel.mjs` | Mode B2 model acquisition and mesh-to-voxel (§2B.2–§2B.7); self-test `node scripts/test_mesh_harness.mjs` (32/32) |

```bash
node scripts/test_mega_kit.mjs                                                               # self-test: 78 checks, temp files only
node scripts/mega_voxel_kit.mjs zones-template --archetype generic_megastructure --hull-size 400,600,300 \
     --asset fortress_01 --out build/fortress_01/detail_zones.json
node scripts/mega_voxel_kit.mjs validate-zones --zones build/fortress_01/detail_zones.json --hull-size 400,600,300
node scripts/mega_voxel_kit.mjs hull --top bp_top.png --side bp_side.png --front bp_front.png --length-y 1019 \
     --voxel-scale 3.5 --zones build/carrier_01/detail_zones.json --out build/carrier_01/hull     # exit 1 if fidelity < 0.90
node scripts/mega_voxel_kit.mjs preview --asset build/carrier_01/hull.json --view hero34 --out build/carrier_01/hero.png
node scripts/mega_voxel_kit.mjs inspect --asset build/carrier_01/hull.json                   # stats + G6 static checks
node scripts/mega_voxel_kit.mjs demo --format MEGA_V23 --out build/mega_demo23               # synthetic carrier, all tiers, matTag 6/7/8 swatches
#   --name ID --asset-only writes just ID.json + ID.bin (e.g. straight into an engine's asset folder);
#   --material-swatches adds the matTag 6/7/8 swatches to other formats; --v<major><minor> is a short form of --format
```

- The `hull` CLI puts the asset origin at the centre of the hull bounds, so author `boundsLocal` and `carve[]` against
  that origin. It writes a fast single-format check asset; production assets come from a builder (below).
- For a production asset, write a small builder script that imports the kit: `VoxelGrid` CSG → `carveVisualHull` →
  `applyDetailZoneCarves` → paint → prefabs and `instances[]` → `packMegaAsset({ format: 'MEGA_V23' })` →
  `writeMegaAsset`, with a `--pass A|B|C|D` switch for the sculpt loop.

## 9. Pitfalls (M1–M27)

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
   - Macro AO is quantised (`macroLevels`), and the light comes from fixed Fibonacci rays (no RNG), so open decks stay
     one quad.
   - Random rays or per-voxel colour noise multiply the triangle count. Put noise in the micro shader instead. With
     `quad16` many more AO levels are affordable (256 levels cost +6.5 % quads on a curved test hull).
   - Measured: demo carrier 94 % reduction, stepped test hull 99 %.
6. **M6 · Geometry touching the grid boundary.**
   - The blur and the rays treat the outside as empty air at the boundary, so a ring that touches the grid edge baked
     to 0.92 instead of 1.00 in testing.
   - Keep ≥ 2 empty voxels around the hull.
7. **M7 · Convex-staircase greying in macro AO.**
   - A naive face-normal hemisphere greyed a 1:3 staircase to 0.918.
   - The smoothed normal plus a 1-voxel origin push gives 1.000. Keep both defaults.
8. **M8 · Non-uniform instance scale** breaks normals under `mat3(instanceMatrix)`.
   - Use uniform scale, or pass the inverse-transpose. This is the instanced form of Track A pitfall 6.
9. **M9 · Macro AO darkening emissive cells.**
   - Interior light rails turn muddy.
   - Use `mix(1, macroAo, k · (1 − em))`.
10. **M10 · Micro detail shimmer.**
    - At pixel scale the procedural seams alias into moiré.
    - Fade the detail with `fwidth(g)` (§6.4), and never use `discard` for detail, because that kills Early-Z.
11. **M11 · `.bin` alignment.**
    - Every chunk must stay a multiple of 4 bytes so that typed-array views at `quadOffset` / `vertexOffset` work.
    - Never insert odd-sized blobs.
12. **M12 · Draw-call creep.**
    - One prefab type per *shape*, not per tint or placement: tints go in the per-instance colour.
    - More prefab types than the meso batch limit (15 under `MEGA_V23_BUDGET`) means it is time to merge modules into
      atlas-style prefabs.

**Zoomed close-up craft rules (M13–M15).** A hard-surface pilot build passed G5 IoU (hero 0.865, ortho ≥ 0.927) and G6,
but zoomed close-ups still showed six craft defects: smeared colour blotches, floating slabs, neon-cube engines,
hockey-puck turrets, a cardboard-flat hangar and a chunky runway LED. **Silhouette IoU cannot detect any of these**, so
treat M13–M15 as gates on the same level as G5 and G6.

13. **M13 · Ban 2D colour projection smear.**
    - Never project raw 2D blueprint pixels onto voxels as albedo.
      - Concept and blueprint colours are drawn lighting and perspective.
      - An axis projection drags them across stairs, glacis steps and recessed bulkheads as stray amber or cyan blotches.
    - Blueprints govern **silhouette and proportion only**: dimensions, envelope profiles and the G5 IoU check.
    - Author every colour in 3D asset coordinates: armour tones, hazard bands, diagonal stripes and viewports.
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
      - Measured on the carrier rebuild: hero 0.870, top 0.922, side 0.874, front 0.886. The visual hull scored
        0.865 / 0.940 / 0.927 / 0.935.
      - Clean bevels cost a little ortho IoU. Report the loss honestly and keep ortho ≥ 0.82 and hero ≥ 0.78.
    - Bonus: with no per-voxel projected paint, the macro hull greedy-merges far better. Measured at 3.6 u/vox: 23.1k
      triangles with 92 % reduction, against 40.7k triangles with 83 % for the projected visual hull.
15. **M15 · High-res meso promotion and a real-engine 1 px crease close-up gate.**
    - Promote every focal hero assembly to a **high-res meso prefab** (0.8–1.6 u/vox): turrets, engine cowlings, the
      bridge citadel, hangar interiors and the cantilevered runway. At 3.4–3.6 u/vox a turret turns into a hockey puck
      and an engine turns into a solid neon cube.
    - Model emitters as **recessed cores inside dark beveled housings**. Only the deep rear nozzle core and narrow
      recessed slits may glow, never whole faces.
    - Model interiors with real depth: 2-tier alcoves, I-beam ribs, a catwalk, a gantry, lamps and a framed lattice
      forcefield. A flat emissive wall does not count.
    - Watch the budget when a prefab bakes its own cavity AO.
      - At the default 8 levels, an interior prefab's triangles doubled (8.9k → 18.9k) and broke a 4 MiB `.bin` budget.
      - Fix: mesh it yourself with `greedyMeshPart(grid, pal, { macroAo, macroLevels: 3, format, … })` (`format:
        'MEGA_V22'` for `packed20` prefabs) and pass the result as `mesh` to `packMegaAsset`. That brought it to 11.5k.
    - Verify close-ups **through the target engine shader**: 1 px depth and crease outlines, the Tier-3 micro-panel
      shader and dual-scale AO. CPU `renderPreview` shows neither the outlines nor the micro detail.
    - *Gate:* one real-engine render per hero zone plus a hero shot, each inspected by eye, plus an on/off pixel diff
      that proves the micro shader is live.
16. **M16 · Indices dominate a quantized mesh.** 20 B vertices + Uint32 indices ≈ 44 B/tri. On the carrier, Uint16 +
    region split took the `.bin` 5.30 → 4.60 MiB with no geometry removed; the Y-symmetric hangar (M17) then 4.6 → 3.5.
    `quad16` removes the index buffer from macro parts altogether.
17. **M17 · Port/starboard interiors under Rz(180) flip their ends.** A mirror scale breaks FrontSide winding (M8); a
    Y-mirrored variant doubles a 25 k-triangle prefab (the `.bin` went over 4 MiB). Sculpt the interior **Y-symmetric**
    (aft half → mirrored) so one prefab serves both flanks with the hero feature (airlock portal) aft on both.
18. **M18 · "Detail everywhere" reads as tiling.** A seam on every plate at hero distance is a brick wall. Keep ~70 %
    resting surface, vary plate length, and let geometry (straps, frames, recesses) carry the structure.
19. **M19 · The chance level of an edge metric.** Symmetric ortho views (top) score high F1 against themselves flipped
    L↔R; compare against a top↔bottom flip, keep the radius at 2 px, and report F1 with its chance level.
20. **M20 · 2 bits cannot hold four corner bevels.** `bevelQ` is a quad-level strength on the unoccluded corners
    (`round(3 · convex / unoccluded)`); it reproduces the per-corner `packed20` `bevelHint` exactly on 79 % of corners
    (crease is exact: it follows the corner AO). Keep crease / ink as the crisp cue; treat bevel as a soft hint.
21. **M21 · Quantise the float32 value, not the float64 one.** `Math.round(0.9 · 255) = 230` but the `packed20` path
    sees Float32 `0.89999998 · 255 → 229`. Quantise `Math.fround(x)` so `packed20` and `quad16` share every colour byte
    (parity tests).
22. **M22 · Raw integer attributes.** Declare `aQOrigin` / `aQSize` / `aQMeta` non-normalized (floats 0..65535 / 0..255
    arrive exactly) and decode bit fields with `int(x + 0.5)` + `& >>`. Three.js uploads one GL buffer per
    `InstancedInterleavedBuffer` array, so the Uint16 + Uint8 views are 2 GPU copies of the 16 B stream (32 B / quad on the
    GPU; the .bin and the CPU stay at 16 B, zero-copy views over one slice).
23. **M23 · Lookdev boxes and legends are per-asset data.** A local light box tuned for one hull (the carrier's interior
    bounce) or a mechanical tag legend silently lands on every other asset; scope them per material profile (uniforms
    from the asset's `materialProfile` / `faction`) and give the studio per-asset zone cameras instead of re-aiming one
    asset's.
24. **M24 · Generators fuse everything in frame (Mode B2).** Escort craft, floating debris or a background planet in
    the concept come back welded to the mesh, and cost credits to regenerate. Pre-clean the concept (decision table),
    inspect the 6-view sheet before voxelizing, and trim leftovers with `preAoHook` or a carve.
25. **M25 · Hard ink on curved voxel stairs.** One crease line per 1-voxel step turns a dome into a black staircase.
    Use structure-aware ink (§6.6): mask 0.82 for curved assets, full ink only on silhouettes and depth steps
    (`|ld − ldq| > 0.008 · ld`), and keep 0.90 so hard-surface assets do not change by a pixel.
26. **M26 · Emissive clipping.** `mix(col, albedo · 1.25, em)` saturates bright cells to one flat colour. Keep a form
    term and a hue-preserving shoulder (§6.7) so crystals and glowing orbs keep their planes.
27. **M27 · Split parts that move need clearance and an anchor.** Generated meshes weld rings to cores and tentacles to
    hulls. Split after the AO bake (§2B.6), trim the swept volume of every moving part against its neighbours in
    `preAoHook` (rotate a ring through its full range and remove whatever it would pass through), and anchor waves on
    the junction box (§6.9). A plane-based `'y'` wave on a split appendage opens a root seam.

## 10. End-to-end checklist

- [ ] Hero 3/4 concept approved. Archetype chosen (`generic_megastructure`, `hard_surface_carrier`, `halo_mothership`
      or `bio_leviathan`).
- [ ] Mode agreed with the user: **B1** (default, offline) or **B2** (opt-in 3D mesh); for B2 without a model, the
      provider agreed too (`local`, `command`, `manual`, an optional API adapter, or a registered one).
- [ ] B1: top, side and front orthographic views anchored on the concept, with mismatch ≤ 3 %; visual hull, fidelity
      ≥ 0.90 on every view; final macro hull rebuilt from clean sub-assemblies at 1.6–2.5 u/vox.
- [ ] B2: concept pre-cleaned; model acquired, validated and cached (`mesh_source.json`); 6-view sheets inspected;
      aligned and voxelized (solidify, symmetry, palette rules); moving parts split after the single AO bake, with
      swept-volume clearance and junction-anchored waves.
- [ ] `detail_zones.json` scaffolded (`--asset <id>`), bounds edited, `validate-zones` OK, one callout sheet per zone,
      every feature mapped to a tier.
- [ ] Cavity carves applied, emissive rails painted, ≥ 2-voxel margin kept.
- [ ] Meso prefabs at 0.8–1.5 u/vox (≥ 2 vox thick), instanced, within the batch limit.
- [ ] 4 sculpt passes (clay → primary → kitbash → lookdev), each with a G5 multi-cue sheet; massing judged in a clay
      view and close-ups in the real engine (studio harness).
- [ ] Macro AO baked (cavities visibly darker, convex edges clean); packed `format: 'MEGA_V23'` — `quad16` macro parts
      (one instanced draw each, `macroLevels` up to 256) + `packed20` prefabs; `inspect` shows the static G6 checks
      passing.
- [ ] Material profile chosen (`MATERIAL_PRESETS` or custom) and the matching shader legend / uniforms set per asset.
- [ ] Engine port of the loader and shaders, with no `discard` / `gl_FragDepth` in FINAL; curved assets use
      structure-aware ink (mask 0.82) and form-preserving emissives, hard-surface assets keep 0.90.
- [ ] G5: silhouette (hero ≥ 0.78, ortho ≥ 0.85) + edge (hero F1 ≥ 0.52, ortho average ≥ 0.55, radius 2 px, read against
      the chance level) + bands chosen for your palette; appendage-heavy forms also pass hull-only IoU ≥ 0.86; every zone
      feature ticked; sheets inspected by eye; every number reported, including the ones that miss.
- [ ] G6: runtime numbers measured (draws ≤ 16, tris ≤ 1.2 M, `.bin` ≤ 12 MiB, Early-Z, Δ ≤ 2.5 ms), so
      `checkPerfBudget(…, runtime).pass` is true.
- [ ] Any Track A actors in the same scene, such as small craft launching from a hangar, still pass G1–G4.

## Appendix A — Legacy formats (MEGA_V22 and MEGA_V2)

Use these only to read or extend existing assets. `readMegaAsset`, `renderPreview` and the G5 tools accept every
schema; new assets should use `format: 'MEGA_V23'`.

### A.1 `svox.mega/v2.2` — `packed20` everywhere (`format: 'MEGA_V22'`)

- Macro parts **and** prefabs are `packed20` indexed meshes (§5.3): `schema: "svox.mega/v2.2"`,
  `vertexFormat: "packed20"`, `vertexStrideBytes: 20`, `vertexLayout: MEGA_V22_LAYOUT` (matTag legend 0 default ·
  1 armor · 2 hazard · 3 deck · 4 glass · 5 hangar_interior · 6 engine_frame). Indices are Uint16 per part with ≤ 65 535
  vertices; split big hulls with `region`. The demo carrier: `.bin` 473 → 204 KiB against `svox.mega/v2`.
- **Budget `MEGA_V22_BUDGET`:** ≤ 12 draws (1–3 macro), ≤ 11 meso batches, ≤ 288k total / 144k unique meso triangles
  (2.4 × v2), `.bin` ≤ 4 MiB, runtime Δ ≤ 1.5 ms.
- Measured (hard-surface carrier, pass D): macro 2.5 u/vox in 2 regions (`hull_aft` / `hull_fore`, Uint16), 8 meso
  prefabs at 1.0–1.35 u/vox, **10 draw calls, 34 instances, 177 938 triangles (97 824 unique), `.bin` 3.457 MiB**,
  deterministic SHA-256 over 2 builds; in-engine Δ 0.45–0.55 ms (headless D3D11, asset on − off, median of 3), Early-Z
  intact.
- Why it was superseded: curved, doubly-curved organic surfaces greedy-merge only ~30–40 %, so 92 B per quad and the
  4 MiB cap forced 5 u/vox hulls, 2–4 macro-AO levels and flattened domes on organic and ornate builds.

### A.2 `svox.mega/v2` — 48 B Float32 vertices (`format: 'MEGA_V2'`) and the 11-float layout (`format: 'FLOAT11'`)

| Float | MEGA_V2 | FLOAT11 (11 floats, 44 B) |
|---|---|---|
| 0–2 | position (u, asset-local) | same |
| 3–5 | normal (axis-aligned) | same |
| 6–8 | albedo rgb | same |
| 9 | emissive 0..1 | same |
| 10 | micro AO 0..1 (`ao/3`) | `microAo × macroAo` (folded) |
| 11 | `meta = matTag·256 + round(macroAo·255)` | — |

- Floats 0–9 are bit-identical between the two layouts; the self-test checks this. With `format: 'FLOAT11'`, an
  **unchanged 11-float megastructure shader** renders the cavity depth with no shader edit. (The kit still accepts the
  layout's original format token, so existing callers keep working.)
- Decode in GLSL with `tag = floor(m / 256.0)`; `macroAo = mod(m, 256.0) / 255.0`. The value is an integer below
  2²⁴, so it is exact in float32.
- Asset: `<id>.json` as in §5.4 but `schema: "svox.mega/v2"`, `vertexLayout` (MEGA_V2 | FLOAT11), and per macro part
  `vertexOffset, vertexCount, vertexByteLength, indexOffset, indexCount, indexByteLength`; `<id>.bin` per macro part:
  Float32 vertices, Uint32 indices │ per prefab: vertices, indices, Float32 mat4 × instanceCount (column-major),
  Float32 rgb × instanceCount.
- Assets in this format were built at macro **3.0–4.0 u/vox** with meso prefabs at **1.2–2.0 u/vox**.
- **Budget `MEGA_BUDGET`:** ≤ 12 draw calls (1–3 macro + ≤ 9 meso batches), ≤ 120k total triangles (meso unique ≤ 60k),
  `.bin` ≤ 4.0 MB, Early-Z 100 % alive, GPU frame delta < 1.0 ms @ 60 fps. Demo carrier, static checks: 3 draws, 8.5k
  tris, 473 KiB.

**Three.js (r187) loader sketch** (RawShaderMaterial with `glslVersion: THREE.GLSL3`):

```js
const FL = json.vertexLayout.floats;                       // 12 (MEGA_V2) or 11 (FLOAT11)
function geometryFor(p, bin) {                             // p = json.macro.parts[i] or json.meso.prefabs[i]
  const ib = new THREE.InterleavedBuffer(new Float32Array(bin, p.vertexOffset, p.vertexCount * FL), FL);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.InterleavedBufferAttribute(ib, 3, 0));
  g.setAttribute('aNormal', new THREE.InterleavedBufferAttribute(ib, 3, 3));
  g.setAttribute('aColor', new THREE.InterleavedBufferAttribute(ib, 3, 6));
  g.setAttribute('aMeta', new THREE.InterleavedBufferAttribute(ib, 2, 9));       // (emissive, microAo)
  if (FL === 12) g.setAttribute('aMeta2', new THREE.InterleavedBufferAttribute(ib, 1, 11));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(bin, p.indexOffset, p.indexCount), 1));
  return g;
}
for (const p of json.meso.prefabs) if (p.instanceCount) {
  const im = new THREE.InstancedMesh(geometryFor(p, bin), capitalInstancedMat, p.instanceCount);  // 1 draw call
  im.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(bin, p.instanceMatrixOffset, p.instanceCount * 16), 16);
  im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(bin, p.instanceColorOffset, p.instanceCount * 3), 3);
  im.frustumCulled = false;                               // a floating origin moves the asset every frame
  group.add(im);
}
```

- For an 11-float asset under a MEGA_V2 shader, set the uniform `uHasMeta2 = 0` and treat `macroAo` as 1. Three supplies
  zero for a missing attribute, which would black out the hull.

**MEGA_V2 vertex-shader additions** (the instanced variant adds `in mat4 instanceMatrix; in vec3 instanceColor;`, which
Three binds for a RawShaderMaterial on an InstancedMesh):

```glsl
in float aMeta2;                 // MEGA_V2 float 11
uniform float uHasMeta2;         // 0 for 11-float assets
out float vMacroAo;
flat out int vTag;
out vec3 vLN;                    // local (object) normal: axis-aligned for voxel faces
out vec3 vLP;                    // local position in u (instancing: prefab-local, before instanceMatrix)
// in main():
vMacroAo = uHasMeta2 > 0.5 ? mod(aMeta2, 256.0) / 255.0 : 1.0;
vTag = uHasMeta2 > 0.5 ? int(floor(aMeta2 / 256.0 + 0.5 / 256.0)) : 1;
vLN = aNormal; vLP = position;
#ifdef INSTANCED   // replaces the base lines  w = uModel * vec4(p, 1.0);  vN = mat3(uModel) * n;  vCol = aColor;
  vec4 w = uModel * instanceMatrix * vec4(p, 1.0);  vN = mat3(uModel) * mat3(instanceMatrix) * n;  vCol = aColor * instanceColor;
#endif
```
