# Target: Blender (asset extraction bridge)

**Status: Verified ✅ (Blender 5.3.0)** — runtime-verified on 2026-11-25 inside real Blender 5.3.0
(`--background --factory-startup`, bundled Python 3.13.13, Windows 11). The script in this file is a copy of the
exporter (`export_svox_from_blender.py`) that produced the verified bundle, identical except that its usage comment
names the script by file name. It needs Blender
**4.4 or newer**, because it uses slotted Actions. Only 5.3.0 has actually been run.

The round trip that was verified:
1. `build_demo_blend.py` builds a 3-part articulated `.blend`.
2. This exporter turns it into an SVOX bundle.
3. `svox_cli.py bake-normal-ao`, then `svox_cli.py validate`: **0 errors, 0 warnings**.
4. The real WebGL2 T3 `HybridRenderer` renders it, and gates **G1–G4 pass** with **0 JS / WebGL errors**.

The QA driver is `uv run blender/run_blender_qa.py` in the reference Blender QA project, and all evidence is in its
QA output folder.

## Why Blender is a bridge, not a renderer

Blender's real-time engines (EEVEE, Workbench) do not run custom per-part OBB raymarch shaders with exact depth and a
low-resolution G-buffer, so T3 cannot run in the viewport. What Blender *is* good at is authoring:
- modelling separate rigid meshes, one per part
- putting their origins at the joints
- keyframing them
- painting materials and colour attributes

The bridge **voxelises** each part mesh around its pivot and writes a standard SVOX bundle. `svox_cli.py` then bakes,
validates and packs it, and a real target ([webgl2_threejs.md](webgl2_threejs.md)) renders it.

**Coordinates match exactly.** Blender is right-handed **Z-up**, and a character facing `−Y` is the SVOX convention. Only
a scale factor is needed: `voxel_size` metres per voxel.

## Runtime evidence (Blender 5.3.0, reference QA output folder)

| Check | Result |
|---|---|
| Demo scene (`demo_hero.blend`) | torso (11 closed islands, 8 Principled materials), arm_blade (8 islands, 2-voxel-thick blade + wedge tip), cape (Solidify modifier, BYTE_COLOR corner colour attribute, `svox_flipped_cloth`). Clips are `idle` (2.0 s) and `swing` (1.25 s). |
| Export | torso 16×13×21 (1320 voxels), arm_blade 8×20×14 (386), cape 16×7×13 (300, pivot.z = 0). Voxelising all 3 parts takes about 0.1 s. |
| `svox_cli.py validate` | PASS, **0 errors, 0 warnings**. Thin fraction 0 / 1.0 % / 4.3 %; rest lowest z = 0.000; loop seams ≤ 1.8e-15; deform self-test 2e-15. |
| Pose round trip: Blender `matrix_world` vs `svox_cli.evaluate_pose` (deform off) | rest 4.8e-7 voxel; at every clip frame ≤ **4.7e-5 voxel**. |
| T3 render (`blender_exported_t3.png`, SwiftShader) | G1 0 slice cracks / 192 renders (detector self-test 6/6); G2 0/0/0 px; G3 3.7e-15; G4 reorder diff 0 px. 0 JS, 0 WebGL errors, 0 PNG decoder mismatches. |
| Voxeliser stress test (`voxelizer_stress.json`): 240 random watertight thin slabs (0.6–2.5 voxels) and blade wedges, 213,551 voxel centres, compared with analytic ground truth | **ray parity: 0 wrong**; nearest-normal sign: 1,727 wrong |
| Negative control: cape without Solidify | The exporter refuses it ("not watertight", exit 1). Forced through anyway, parity gives 186 voxels and nearest gives 300, and 114 of them differ: both are garbage. |
| Determinism | Two exports give identical `rig.json` and identical decoded albedo / normal_ao RGBA. |
| Visual source check | `blender_source_*.png` (Cycles renders of the `.blend` at the QA camera angles) match the T3 panels in colours, proportions and part placement. |

## Authoring rules

- **Parts.** Use one mesh object per part, all in one collection: `scene["svox_collection"]`, default `SVOX_Parts`.
  - The **object origin is the part pivot**, at the joint: ground point for the root, shoulder, or the mount line for
    cloth.
  - Set the hierarchy with plain **object parenting** (`obj.parent`). Use an identity `matrix_parent_inverse` or not;
    the exporter reads world matrices.
  - Keep `rotation_mode = 'XYZ'`. The exporter refuses other rotation modes, because SVOX clips are Euler XYZ deltas.
- **Watertight islands.** Every loose island must be closed (each edge shared by exactly 2 faces).
  - The exporter reads the **evaluated** mesh, so a Bevel or **Solidify** modifier counts. Give cloth and thin blades a
    Solidify modifier.
  - Islands may **overlap**: belts, visors and plates can be modelled as boxes overlapping the body. Solidity is their
    union, and the **smallest island (by bbox volume) wins the colour**.
- **Thickness and grid.**
  - Every feature should be at least 2 voxels thick (pitfall 5).
  - Put flat faces on **integer voxel planes** relative to the origin. Voxel centres sit at `n + 0.5`, so a face lying
    exactly through centres is ambiguous.
  - The exporter adds the 1-voxel empty margin on X, Y and top itself.
- **Flipped cloth.** Model the cape hanging down (local −Z) from its origin on the mount line.
  - Set `svox_role = "cloth"` and `svox_flipped_cloth = True` (the older `svox_flipped` is also accepted).
  - The exporter mirrors `(x, y, z) → (x, −y, −z)` (RotX(π)), and SVOX re-applies RotX(π).
  - Folds must leave the mount **horizontally**, for example with an offset that grows with u², so that Solidify does not
    push the rim above the mount. Anything above the mount is clipped so that `pivot.z = 0` holds.
- **Colour.** Each face's colour comes from the first of these that applies:
  1. the active **colour attribute** (CORNER or POINT, `color_srgb`, averaged per face; paint each face's corners the
     same colour for crisp regions)
  2. the face's material: **Principled BSDF Base Color**, when the socket is unlinked
  3. the material's `diffuse_color`

  Both material colours are scene-linear and are converted to sRGB. Set `svox_color_source = "material"` on an object to
  ignore its attribute. `scene["svox_color_jitter"]` (for example 0.10) adds per-voxel value noise.
- **Clips.** Use one Action per clip with the custom property `svox_clip = True` (and optionally `svox_loop`).
  - Give the Action `use_frame_range` and `frame_start` / `frame_end`, and **one slot per animated part**. Use the fake
    user, and save the `.blend` with **no action assigned**: the rest pose is the objects' unanimated transforms.
  - Key `location` and `rotation_euler`. The exporter samples every frame into SVOX `keys` channels; make the first and
    last keys equal.
  - Deform channels (squash / shear / twist / wave) come from the object's JSON custom property `svox_channels`, for
    example `{"idle": [{"channel": "squashZ", "fn": "sin", "amp": 0.035, "cycles": 2}]}`.
- **Scene settings.** These custom properties are optional: `svox_voxel_size` (default 0.0625 m = 16 voxels/m),
  `svox_target_height` (voxels, camera target) and `svox_color_jitter`.

## Blender 5.3.0 API changes and pitfalls found at runtime

1. **`Action.fcurves` no longer exists. Actions are layered and slotted (4.4+, legacy API removed in 5.x).**
   - To author keys: `slot = act.slots.new(id_type='OBJECT', name=ob.name)`, then
     `bpy_extras.anim_utils.action_ensure_channelbag_for_slot(act, slot).fcurves.new(path, index=i)`.
   - To play an action, assign **both** `ad.action` and `ad.action_slot`; an action without a slot animates nothing.
   - `ActionSlot` has `identifier` (`"OBtorso"`), `name_display` and `target_id_type`. It has **no** `id_root`; using it
     raised an AttributeError in the first run.
2. **`Material.use_nodes` is deprecated.** Reading it emits "expected to be removed in Blender 6.0". New materials already
   contain a Principled BSDF, so set `inputs["Base Color"]` and do not touch `use_nodes`.
3. **Colours are scene-linear.** The previous draft wrote `diffuse_color × 255` directly, which comes out too dark.
   `diffuse_color` (subtype `COLOR`) and Base Color both need linear→sRGB conversion before PNG bytes.
4. **`bmesh.ops.bevel` gives the new chamfer faces `material_index = 0`.** A beveled gold belt therefore exported mostly
   in the body's teal, because its chamfers are the nearest faces to most of its voxels. Re-assign
   `res["faces"]` to the box's material.
5. **Use ray parity, not the nearest-normal sign.**
   - The previous draft used `find_nearest` and tested the sign of `(hit − c)·n`. Near acute edges (blade tips, thin
     slabs) the nearest point lies on an edge, and the normal of one adjacent face misclassifies outside centres.
   - The stress test measured **1,727 wrong of 213,551 for nearest and 0 for parity**: 3 slightly skewed axis rays
     through `BVHTree.ray_cast`, re-cast from `hit + 1e-4·d`, majority of the odd/even counts.
   - On the demo's axis-aligned parts the two agreed exactly, so the failure only appears at sharp edges.
6. **Open meshes cannot be voxelised by an inside test.** Without Solidify, the cape sheet gave 186 voxels (parity) and
   300 (nearest), with 114 differing. Both are meaningless, so the exporter checks per-island watertightness and refuses
   open islands. `--allow-open` exists for debugging only.
7. **Overlapping closed islands break a single parity test.** A point inside both the body and the belt sees an even
   number of crossings and reads as outside. Test each island separately (union-find over polygon vertices, one BVH per
   island) and take the union.
8. **The pivot can fall outside the volume.** The previous draft built the grid bbox from vertices only, so a joint
   origin outside the mesh triggered `PIVOT_OUTSIDE_VOLUME`. The bbox now always includes the origin.
9. **Flipped cloth with Solidify.** Folds that left the mount at an angle let Solidify push the top rim above the mount
   line, which gave `pivot.z = 2` instead of 0, so `uZ` was no longer pinned at the mount. The exporter now forces
   `pivot.z = 0` for flipped cloth and clips anything above the mount, and the demo's folds grow with u².
10. **Unassigning an action keeps the last evaluated values** in `location` / `rotation_euler`. The exporter snapshots
    the rest transforms before sampling and restores them, together with the user's original action and slot, afterwards.
11. **`blender --background --python x.py` exits with code 0 even when the script raises.** Always pass
    `--python-exit-code 1` (verified: 0 without it, 1 with it). `sys.exit(1)` inside the script does propagate.
12. **Per-frame `keys` are linear.** They match Blender exactly at frames (≤ 4.7e-5 voxel). Between frames, Bezier
    easing in the fast swing deviates by up to 0.35 voxel at half frames. Raise the fps if sub-frame fidelity matters.
13. **Scale.** Rest and clip matrices are made scale-free (`Matrix.LocRotScale(loc, rot, None)`), and the object's world
    scale is applied to the vertices instead.
14. **`import svox_cli` inside Blender writes `__pycache__` into the skill folder.** Set `sys.dont_write_bytecode = True`
    before the import. Blender's subprocess inherits `PATH`, so `uv` is found; the script falls back to `python`.

## Run it

```bash
# run from the reference Blender QA project
BL="D:/SteamLibrary/steamapps/common/Blender/blender.exe"          # any Blender >= 4.4; verified 5.3.0
"$BL" --background --factory-startup --python-exit-code 1 --python blender/build_demo_blend.py
"$BL" --background --factory-startup blender/demo_hero.blend --python-exit-code 1 \
      --python blender/export_svox_from_blender.py -- --compare
#  -> blender/exported_svox/{rig.json, parts/*.albedo.png, parts/*.normal_ao.png, bake_stats.json}
#  -> <qa out>/{export_report.json, validate_report.json}   (bake + strict validate run automatically)
node blender/render_t3.mjs --backend swiftshader      # real T3 render + G1-G4 of the exported bundle
uv run blender/run_blender_qa.py                      # everything above + determinism, negative control,
                                                                   # voxeliser stress test, Cycles reference renders
```

For your own project, set `SVOX_SCRIPTS=<folder containing svox_cli.py>` and pass `--out <bundle dir>` (also `--report`
and `--validate-output`). The exporter is otherwise self-contained.

## The verified exporter (`export_svox_from_blender.py`)

```python
# export_svox_from_blender.py - Blender (verified on 5.3.0) -> SVOX bundle (svox.rig/v1) exporter bridge.
#
#   blender.exe --background --factory-startup <scene.blend> --python-exit-code 1 \
#       --python export_svox_from_blender.py -- \
#       [--out DIR] [--method parity|nearest] [--compare] [--report export_report.json]
#       [--validate-output validate_report.json] [--no-bake] [--allow-warnings] [--allow-open (debug only)]
#   env SVOX_SCRIPTS = folder holding svox_cli.py   (default <repo>/.agents/skills/hybrid-voxel-sprite/scripts)
#   env SVOX_ROOT    = folder for default outputs    (default: two levels above this file)
#
# What it does (one mesh object per part inside the collection scene["svox_collection"] (default "SVOX_Parts")):
#   1. takes each part's EVALUATED mesh (modifiers such as Bevel / Solidify applied) in object-local space, scaled by
#      the object's world scale and divided by the voxel size (scene["svox_voxel_size"], default 1/16 m)
#   2. flipped cloth (custom prop svox_flipped_cloth / svox_flipped): mirrors local (x, y, z) -> (x, -y, -z) = RotX(pi)
#      so local +Z runs DOWN the cloth; SVOX re-applies RotX(pi) at render time
#   3. splits the mesh into loose islands, REQUIRES every island to be watertight (each edge shared by exactly 2 faces)
#      and voxelises each island with an inside test sampled at voxel centres:
#        parity  (default) majority vote of 3 skewed-axis ray-parity counts through BVHTree.ray_cast
#        nearest            sign of (nearest surface point - centre) . face normal via BVHTree.find_nearest
#      Overlapping islands are a union; where several islands contain a voxel the SMALLEST island (bbox volume) wins
#      the colour, so belts / visors / plates modelled as boxes overlapping the body keep their colour.
#   4. colour = the winning island's nearest face: active colour attribute (CORNER or POINT, color_srgb, face-averaged)
#      if present, else the face's material: Principled BSDF "Base Color" (scene-linear -> sRGB), else diffuse_color.
#      Optional per-voxel value jitter scene["svox_color_jitter"] (0 = off).
#   5. grid = pivot-aligned (object origin on an integer voxel corner), bbox always includes the origin (pivot inside
#      the volume), 1 empty voxel margin on X / Y / top (and bottom unless the part starts at local z >= 0)
#   6. rig.json: parent hierarchy from obj.parent, restOffset / restRotation from the scale-free parent-relative
#      matrix, clips from Actions flagged act["svox_clip"] (layered/slotted actions, Blender 4.4+ / 5.x), sampled per
#      frame into `keys` channels (pos* in voxels, rot* Euler XYZ deltas), plus per-object JSON custom property
#      "svox_channels" = {"<clip>": [{channel, fn, ...}]} for the deform channels; rest-pose ground contact snapped to
#      z = 0 by shifting the root part(s)
#   7. pose round-trip: Blender matrix_world of mesh vertices vs svox_cli.evaluate_pose (deform off) at rest and at
#      every clip frame must agree to < 1e-3 voxel
#   8. runs `uv run svox_cli.py bake-normal-ao` and `svox_cli.py validate` (strict: 0 errors AND 0 warnings)
import bpy
import json
import math
import os
import shutil
import subprocess
import sys
import time
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.environ.get("SVOX_ROOT") or os.path.join(HERE, "..", ".."))
SVOX_SCRIPTS = os.path.abspath(os.environ.get("SVOX_SCRIPTS") or os.path.join(ROOT, ".agents", "skills", "hybrid-voxel-sprite", "scripts"))
SVOX_CLI = os.path.join(SVOX_SCRIPTS, "svox_cli.py")
sys.path.insert(0, SVOX_SCRIPTS)
sys.dont_write_bytecode = True                  # do not drop __pycache__ into the (read-only) skill folder
import svox_cli as svox  # noqa: E402  (stdlib-only; png_write / save_json / evaluate_pose / deform_point)


class ExportError(Exception):
    pass


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []

    def val(k, d):
        return argv[argv.index(k) + 1] if k in argv else d
    return {
        "out": os.path.abspath(val("--out", os.path.join(HERE, "exported_svox"))),
        "method": val("--method", "parity"),
        "compare": "--compare" in argv,
        "report": os.path.abspath(val("--report", os.path.join(ROOT, "artifacts", "qa", "adapters", "blender", "export_report.json"))),
        "validate_output": os.path.abspath(val("--validate-output", os.path.join(ROOT, "artifacts", "qa", "adapters", "blender", "validate_report.json"))),
        "bake": "--no-bake" not in argv,
        "allow_warnings": "--allow-warnings" in argv,
        "allow_open": "--allow-open" in argv,          # debug only: voxelise non-watertight islands anyway
    }


# ------------------------------------------------------------------------------------------------ colour helpers
def lin_to_srgb(c):
    c = max(0.0, min(1.0, c))
    return c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1.0 / 2.4) - 0.055


def material_srgb(mat):
    """Principled BSDF Base Color (unlinked socket) -> sRGB bytes; fallback Viewport Display diffuse_color."""
    if mat is None:
        return (204, 204, 204), "default"
    src, lin = "diffuse_color", tuple(mat.diffuse_color[:3])
    nt = getattr(mat, "node_tree", None)
    if nt is not None:
        for n in nt.nodes:
            if n.type == "BSDF_PRINCIPLED":
                sock = n.inputs.get("Base Color")
                if sock is not None and not sock.is_linked:
                    lin, src = tuple(sock.default_value[:3]), "principled_base_color"
                break
    return tuple(int(math.floor(lin_to_srgb(c) * 255 + 0.5)) for c in lin), src


def face_colors(obj, me):
    """One sRGB colour per polygon of the evaluated mesh + a description of where it came from."""
    mode = str(obj.get("svox_color_source", "auto"))
    attr = None
    if mode in ("auto", "attribute"):
        attr = me.color_attributes.active_color
        if attr is None and len(me.color_attributes):
            attr = me.color_attributes[0]
    if attr is not None and attr.domain in ("CORNER", "POINT"):
        out = []
        for p in me.polygons:
            idx = p.loop_indices if attr.domain == "CORNER" else p.vertices
            acc = [0.0, 0.0, 0.0]
            for i in idx:
                c = attr.data[i].color_srgb
                acc[0] += c[0]
                acc[1] += c[1]
                acc[2] += c[2]
            n = float(len(idx))
            out.append(tuple(int(math.floor(max(0.0, min(1.0, a / n)) * 255 + 0.5)) for a in acc))
        return out, "color_attribute:%s(%s,%s)" % (attr.name, attr.data_type, attr.domain)
    slots = [s.material for s in obj.material_slots] or [None]
    cols = [material_srgb(m) for m in slots]
    out = [cols[min(p.material_index, len(cols) - 1)][0] for p in me.polygons]
    return out, "material:" + ",".join(sorted({c[1] for c in cols}))


# ------------------------------------------------------------------------------------------------ voxeliser
RAY_DIRS = [Vector(d).normalized() for d in ((1.0, 0.01234, 0.00711), (0.00913, 1.0, 0.01372), (0.01131, 0.00677, 1.0))]


def _crossings(bvh, origin, d):
    n, o = 0, origin
    for _ in range(256):
        hit = bvh.ray_cast(o, d)
        if hit[0] is None:
            break
        n += 1
        o = hit[0] + d * 1e-4
    return n


def inside_parity(isl, c):
    votes = sum(_crossings(isl["bvh"], c, d) & 1 for d in RAY_DIRS)
    return votes >= 2


def inside_nearest(isl, c):
    co, nrm, _idx, _dist = isl["bvh"].find_nearest(c)
    return co is not None and (co - c).dot(nrm) > 0.0


def build_islands(pts, polys):
    parent = list(range(len(pts)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for p in polys:
        for v in p[1:]:
            ra, rb = find(p[0]), find(v)
            if ra != rb:
                parent[ra] = rb
    groups = {}
    for pi, p in enumerate(polys):
        groups.setdefault(find(p[0]), []).append(pi)
    islands = []
    for gi, pidx in enumerate(groups.values()):
        vmap, iv, ip = {}, [], []
        edges = {}
        for pi in pidx:
            p = polys[pi]
            for k in range(len(p)):
                a, b = p[k], p[(k + 1) % len(p)]
                key = (a, b) if a < b else (b, a)
                edges[key] = edges.get(key, 0) + 1
            loc = []
            for v in p:
                if v not in vmap:
                    vmap[v] = len(iv)
                    iv.append(pts[v])
                loc.append(vmap[v])
            ip.append(tuple(loc))
        lo = Vector((min(p.x for p in iv), min(p.y for p in iv), min(p.z for p in iv)))
        hi = Vector((max(p.x for p in iv), max(p.y for p in iv), max(p.z for p in iv)))
        boundary = sum(1 for c in edges.values() if c == 1)
        nonmanifold = sum(1 for c in edges.values() if c > 2)
        islands.append({"index": gi, "bvh": BVHTree.FromPolygons(iv, ip), "polys": pidx, "lo": lo, "hi": hi,
                        "volume": max(1e-9, (hi.x - lo.x) * (hi.y - lo.y) * (hi.z - lo.z)),
                        "faces": len(pidx), "boundaryEdges": boundary, "nonManifoldEdges": nonmanifold,
                        "closed": boundary == 0 and nonmanifold == 0})
    return islands


def voxelise(obj, dg, voxel, method, jitter, seed, allow_open=False):
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    try:
        _loc, _rot, sca = obj.matrix_world.decompose()
        S = Matrix.Diagonal(sca)
        flip = bool(obj.get("svox_flipped_cloth", obj.get("svox_flipped", False)))
        pts = []
        for v in me.vertices:
            p = (S @ v.co) / voxel                                     # pivot-relative, voxel units, scale applied
            pts.append(Vector((p.x, -p.y, -p.z)) if flip else p)       # flipped cloth: RotX(pi) -> +Z runs down
        polys = [tuple(p.vertices) for p in me.polygons]
        if not polys:
            raise ExportError("part '%s' has no faces" % obj.name)
        fcols, csrc = face_colors(obj, me)
        islands = build_islands(pts, polys)
    finally:
        ev.to_mesh_clear()
    open_isl = [i for i in islands if not i["closed"]]
    if open_isl and not allow_open:
        raise ExportError("part '%s': %d of %d mesh islands are not watertight (%s). The inside test needs closed meshes: "
                          "add a Solidify modifier (cloth / blades) or close the holes." % (
                              obj.name, len(open_isl), len(islands),
                              ", ".join("island %d: %d boundary / %d non-manifold edges" % (i["index"], i["boundaryEdges"], i["nonManifoldEdges"]) for i in open_isl[:4])))
    lo = Vector((min(min(p.x for p in pts), 0.0), min(min(p.y for p in pts), 0.0), min(min(p.z for p in pts), 0.0)))
    hi = Vector((max(max(p.x for p in pts), 0.0), max(max(p.y for p in pts), 0.0), max(max(p.z for p in pts), 0.0)))
    eps = 1e-6
    o = [math.floor(lo.x + eps) - 1, math.floor(lo.y + eps) - 1, math.floor(lo.z + eps) - (0 if lo.z >= -eps else 1)]
    above_mount = 0
    if flip:
        # flipped cloth MUST have pivot.z = 0 (uZ = 0 pinned at the mount): anything above the mount line (local z < 0
        # after the flip, e.g. Solidify pushing the top rim up) is clipped and counted.
        above_mount = sum(1 for p in pts if p.z < -eps)
        o[2] = 0
    size = [int(math.ceil(hi[k] - eps)) + 1 - o[k] for k in range(3)]
    sx, sy, sz = size
    inside = inside_parity if method == "parity" else inside_nearest
    vol = bytearray(sx * sy * sz * 4)
    occ = bytearray(sx * sy * sz)
    per_island = [0] * len(islands)
    for z in range(sz):
        for y in range(sy):
            for x in range(sx):
                c = Vector((x + o[0] + 0.5, y + o[1] + 0.5, z + o[2] + 0.5))
                best = None
                for isl in islands:
                    l, h = isl["lo"], isl["hi"]
                    if c.x < l.x or c.y < l.y or c.z < l.z or c.x > h.x or c.y > h.y or c.z > h.z:
                        continue
                    if inside(isl, c) and (best is None or isl["volume"] < best["volume"]):
                        best = isl
                if best is None:
                    continue
                co, _n, idx, _d = best["bvh"].find_nearest(c)
                col = fcols[best["polys"][idx if co is not None else 0]]
                if jitter > 0:
                    f = 1.0 - jitter * 0.5 + jitter * svox._hash3(x, y, z, seed)
                    col = tuple(max(0, min(255, int(math.floor(v * f + 0.5)))) for v in col)
                i = (z * sy + y) * sx + x
                vol[i * 4:i * 4 + 4] = bytes((col[0], col[1], col[2], 255))
                occ[i] = 1
                per_island[best["index"]] += 1
    pivot = [float(-o[0]), float(-o[1]), float(-o[2])]
    stats = {"size": size, "pivot": pivot, "solidVoxels": int(sum(occ)), "islands": len(islands),
             "islandFaces": [i["faces"] for i in islands], "islandVoxels": per_island, "colorSource": csrc,
             "flipped": flip, "vertsAboveMountClipped": above_mount, "openIslands": len(open_isl), "localBoundsVox": [[round(lo.x, 3), round(lo.y, 3), round(lo.z, 3)], [round(hi.x, 3), round(hi.y, 3), round(hi.z, 3)]]}
    return vol, occ, size, pivot, flip, stats


# ------------------------------------------------------------------------------------------------ rig helpers
def noscale(m):
    loc, rot, _s = m.decompose()
    return Matrix.LocRotScale(loc, rot, None)


def rel_matrix(obj, parts_by_name):
    par = obj.parent if (obj.parent is not None and obj.parent.name in parts_by_name) else None
    if par is None:
        return noscale(obj.matrix_world)
    return noscale(par.matrix_world).inverted() @ noscale(obj.matrix_world)


def find_slot(action, obj):
    for s in action.slots:
        # Blender 5.x ActionSlot: identifier = 2-letter ID code + name ("OBtorso"); the ID type is target_id_type
        if s.identifier == "OB" + obj.name or (getattr(s, "target_id_type", "OBJECT") == "OBJECT" and s.name_display == obj.name):
            return s
    return None


def assign_clip(act, objs):
    assigned = []
    for o in objs:
        slot = find_slot(act, o)
        if slot is None:
            if o.animation_data:
                o.animation_data.action = None
            continue
        ad = o.animation_data or o.animation_data_create()
        ad.action = act
        ad.action_slot = slot                      # 5.x: an Action alone animates nothing; the slot must be set too
        assigned.append(o.name)
    return assigned


def restore(objs, saved):
    """Re-assign what the user had and put the rest transforms back (unassigning an action leaves the last evaluated
    values in location / rotation_euler / scale)."""
    for o in objs:
        act, slot, loc, rot, sca, _rm = saved[o.name]
        if o.animation_data:
            o.animation_data.action = act
            if act is not None and slot is not None:
                o.animation_data.action_slot = slot
        if act is None:
            o.location, o.rotation_euler, o.scale = loc, rot, sca
    bpy.context.view_layer.update()


def verify_roundtrip(rig, objs, voxel, shift_z, actions, fps, saved):
    """Blender world positions of evaluated-mesh vertices vs svox_cli.evaluate_pose(use_deform=False) applied to the
    same vertices in SVOX part-local space, at rest and at every frame of every clip (+ half frames, informative)."""
    scene = bpy.context.scene
    by = {p["name"]: p for p in rig["parts"]}
    dg = bpy.context.evaluated_depsgraph_get()
    verts = {}
    for o in objs:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        vs = [v.co.copy() for v in me.vertices]
        ev.to_mesh_clear()
        verts[o.name] = vs[::max(1, len(vs) // 200)]

    def err_now(clip, t):
        pose = svox.evaluate_pose(rig, clip, t, use_deform=False, rest=clip is None)
        worst = 0.0
        for o in objs:
            mw = o.matrix_world
            sca = mw.decompose()[2]
            m = pose["parts"][o.name]["matrix"]
            flip = by[o.name]["flippedCloth"]
            for v in verts[o.name]:
                wb = (mw @ v) / voxel
                q = Vector((v.x * sca.x, v.y * sca.y, v.z * sca.z)) / voxel
                ws = svox.m4_point(m, (q.x, -q.y, -q.z) if flip else (q.x, q.y, q.z))
                worst = max(worst, abs(ws[0] - wb.x), abs(ws[1] - wb.y), abs(ws[2] - (wb.z + shift_z)))
        return worst
    restore(objs, saved)
    for o in objs:
        if o.animation_data:
            o.animation_data.action = None
    out = {"rest": err_now(None, 0.0), "clips": {}}
    for act in actions:
        assign_clip(act, objs)
        fs, fe = int(round(act.frame_range[0])), int(round(act.frame_range[1]))
        e_frames, e_half = 0.0, 0.0
        for f in range(fs, fe + 1):
            scene.frame_set(f)
            e_frames = max(e_frames, err_now(act.name, (f - fs) / fps))
            if f < fe:
                scene.frame_set(f, subframe=0.5)
                e_half = max(e_half, err_now(act.name, (f + 0.5 - fs) / fps))
        out["clips"][act.name] = {"maxErrorAtFrames": float("%.3g" % e_frames), "maxErrorAtHalfFrames": float("%.3g" % e_half)}
    out["rest"] = float("%.3g" % out["rest"])
    out["maxErrorAtFrames"] = max([out["rest"]] + [c["maxErrorAtFrames"] for c in out["clips"].values()])
    out["pass"] = out["maxErrorAtFrames"] < 1e-3
    restore(objs, saved)
    scene.frame_set(scene.frame_start)
    return out


def run_cli(args, log):
    uv = shutil.which("uv")
    cmd = ([uv, "run", SVOX_CLI] if uv else [shutil.which("python") or "python", SVOX_CLI]) + args
    t0 = time.time()
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    out = (p.stdout or "") + (p.stderr or "")
    log.append({"cmd": " ".join(os.path.relpath(c, ROOT) if os.path.isabs(c) and c.startswith(ROOT) else c for c in cmd),
                "exitCode": p.returncode, "seconds": round(time.time() - t0, 2), "output": out.strip().splitlines()})
    print("$ " + log[-1]["cmd"])
    print(out.rstrip())
    return p.returncode


def export(cfg):
    t_start = time.time()
    scene = bpy.context.scene
    voxel = float(scene.get("svox_voxel_size", 0.0625))
    coll_name = str(scene.get("svox_collection", "SVOX_Parts"))
    coll = bpy.data.collections.get(coll_name)
    if coll is None:
        raise ExportError("collection '%s' not found" % coll_name)
    objs = [o for o in coll.objects if o.type == "MESH"]
    if not objs:
        raise ExportError("collection '%s' has no mesh objects" % coll_name)
    by_name = {o.name: o for o in objs}
    jitter = float(scene.get("svox_color_jitter", 0.0))

    # ---- rest pose: no action assigned (remember & restore what the user had)
    saved = {}
    for o in objs:
        ad = o.animation_data
        saved[o.name] = (ad.action if ad else None, ad.action_slot if ad else None,
                         o.location.copy(), o.rotation_euler.copy(), o.scale.copy(), o.rotation_mode)
        if ad and ad.action:
            print("note: '%s' had action '%s' assigned; rest pose = its current transform properties" % (o.name, ad.action.name))
            ad.action = None
        if o.rotation_mode != "XYZ":
            raise ExportError("part '%s' uses rotation_mode %s; SVOX clips need Euler XYZ" % (o.name, o.rotation_mode))
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    rest_rel = {o.name: rel_matrix(o, by_name) for o in objs}

    # ---- voxelise
    if os.path.isdir(os.path.join(cfg["out"], "parts")):
        shutil.rmtree(os.path.join(cfg["out"], "parts"))
    os.makedirs(os.path.join(cfg["out"], "parts"), exist_ok=True)
    rig = svox.new_rig(float(scene.get("svox_target_height", 9.0)))
    rig["generator"] = "export_svox_from_blender.py (Blender %s) + svox_cli.py %s" % (bpy.app.version_string, svox.TOOL_VERSION)
    rig["source"] = {"blend": os.path.basename(bpy.data.filepath), "collection": coll_name, "voxelSize": voxel,
                     "voxeliser": cfg["method"], "colorJitter": jitter}
    report = {"schema": "svox.blender_export/v1", "blender": bpy.app.version_string, "blend": bpy.data.filepath,
              "voxelSize": voxel, "method": cfg["method"], "parts": {}, "clips": {}, "cli": []}
    vols = {}
    for pi, o in enumerate(objs):
        t0 = time.time()
        vol, occ, size, pivot, flip, st = voxelise(o, dg, voxel, cfg["method"], jitter, 31 + pi, cfg["allow_open"])
        st["seconds"] = round(time.time() - t0, 3)
        if cfg["compare"]:
            other = "nearest" if cfg["method"] == "parity" else "parity"
            t1 = time.time()
            _v2, occ2, size2, _p2, _f2, _st2 = voxelise(o, dg, voxel, other, 0.0, 0, cfg["allow_open"])
            diff = sum(1 for a, b in zip(occ, occ2) if a != b) if size2 == size else -1
            st["compare"] = {"other": other, "otherSolid": int(sum(occ2)), "voxelsDiffer": diff, "seconds": round(time.time() - t1, 3)}
        if st["solidVoxels"] == 0:
            raise ExportError("part '%s' voxelised to 0 voxels (voxel size %.4f m too large?)" % (o.name, voxel))
        par = o.parent.name if (o.parent is not None and o.parent.name in by_name) else None
        if par and bool(by_name[par].get("svox_flipped_cloth", by_name[par].get("svox_flipped", False))):
            raise ExportError("part '%s' is parented to flipped cloth '%s' (unsupported)" % (o.name, par))
        rel = rest_rel[o.name]
        t = rel.to_translation() / voxel
        e = rel.to_euler("XYZ")                                         # SVOX restRotation: Euler XYZ = Rz*Ry*Rx
        part = svox.make_part(o.name, size, pivot, par, (t.x, t.y, t.z), str(o.get("svox_role", "rigid")), flip)
        part["restOffset"] = [round(v, 6) for v in part["restOffset"]]
        part["restRotation"] = [round(e.x, 6), round(e.y, 6), round(e.z, 6)]
        rig["parts"].append(part)
        vols[o.name] = vol
        report["parts"][o.name] = st
        print("voxelised %-10s %2dx%2dx%2d  solid %5d  islands %d  pivot %s  parent %s  %s  (%.2fs)%s" % (
            o.name, size[0], size[1], size[2], st["solidVoxels"], st["islands"], pivot, par, st["colorSource"], st["seconds"],
            ("  [%s: %d solid, %d voxels differ]" % (st["compare"]["other"], st["compare"]["otherSolid"], st["compare"]["voxelsDiffer"])) if cfg["compare"] else ""))

    # ---- clips: slotted actions flagged svox_clip, sampled per frame
    fps = scene.render.fps / scene.render.fps_base
    actions = [a for a in bpy.data.actions if a.get("svox_clip")]
    deform_by_obj = {o.name: json.loads(o["svox_channels"]) if "svox_channels" in o else {} for o in objs}
    clip_names = [a.name for a in actions]
    for o in objs:
        for cname in deform_by_obj[o.name]:
            if cname not in clip_names:
                raise ExportError("'%s'.svox_channels references clip '%s' but no Action with svox_clip has that name" % (o.name, cname))
    for act in actions:
        fs, fe = int(round(act.frame_range[0])), int(round(act.frame_range[1]))
        dur = (fe - fs) / fps
        assigned = assign_clip(act, objs)
        samples = {o.name: {c: [] for c in ("posX", "posY", "posZ", "rotX", "rotY", "rotZ")} for o in objs}
        times = []
        for f in range(fs, fe + 1):
            scene.frame_set(f)
            times.append(round((f - fs) / fps, 6))
            for o in objs:
                r0 = rest_rel[o.name]
                r = rel_matrix(o, by_name)
                dt = (r.to_translation() - r0.to_translation()) / voxel
                e0 = r0.to_euler("XYZ")
                e = r.to_euler("XYZ", e0)                              # compatible with rest -> no 2*pi jumps
                for k, ax in enumerate("XYZ"):
                    samples[o.name]["pos" + ax].append(round(dt[k], 6))
                    samples[o.name]["rot" + ax].append(round(e[k] - e0[k], 6))
        channels = []
        for o in objs:
            for ch, vals in samples[o.name].items():
                if max(abs(v) for v in vals) > 1e-6:
                    channels.append({"part": o.name, "channel": ch, "fn": "keys", "times": times, "values": vals})
            for dch in deform_by_obj[o.name].get(act.name, []):
                channels.append(dict(dch, part=o.name))
        rig["clips"].append({"name": act.name, "duration": round(dur, 6), "loop": bool(act.get("svox_loop", act.use_cyclic)),
                             "fps": fps, "channels": channels})
        report["clips"][act.name] = {"frames": [fs, fe], "duration": round(dur, 6), "slotsAssigned": assigned,
                                     "keyChannels": sum(1 for c in channels if c["fn"] == "keys"),
                                     "deformChannels": sum(1 for c in channels if c["fn"] != "keys")}
        print("clip %-6s frames %d..%d (%.3fs @ %g fps)  slots %s  -> %d keys channels + %d deform channels" % (
            act.name, fs, fe, dur, fps, assigned, report["clips"][act.name]["keyChannels"], report["clips"][act.name]["deformChannels"]))
    restore(objs, saved)
    scene.frame_set(scene.frame_start)

    # ---- ground snap: lowest solid voxel corner of the rest pose -> z = 0 (shift the root part(s))
    rest = svox.evaluate_pose(rig, None, 0.0, rest=True)
    lowest = float("inf")
    for p in rig["parts"]:
        sx, sy, sz = p["size"]
        v, pv, m = vols[p["name"]], p["pivot"], rest["parts"][p["name"]]["matrix"]
        for z in range(sz):
            for y in range(sy):
                for x in range(sx):
                    if v[((z * sy + y) * sx + x) * 4 + 3]:
                        for cz in (0, 1):
                            for cy in (0, 1):
                                for cx in (0, 1):
                                    w = svox.m4_point(m, (x + cx - pv[0], y + cy - pv[1], z + cz - pv[2]))
                                    lowest = min(lowest, w[2])
    report["groundSnap"] = {"restLowestZBefore": round(lowest, 6), "shift": round(-lowest, 6)}
    if abs(lowest) > 1e-6:
        for p in rig["parts"]:
            if not p["parent"]:
                p["restOffset"][2] = round(p["restOffset"][2] - lowest, 6)
    print("ground snap: rest lowest z %.4f -> shift roots by %.4f" % (lowest, -lowest))
    shift = -lowest if abs(lowest) > 1e-6 else 0.0
    rt = verify_roundtrip(rig, objs, voxel, shift, actions, fps, saved)
    report["poseRoundTrip"] = rt
    print("pose round-trip (Blender matrix_world vs svox evaluate_pose, deform off): rest %.2e, frames max %.2e voxels %s; "
          "half-frames (linear keys vs Bezier) %s" % (rt["rest"], rt["maxErrorAtFrames"], "PASS" if rt["pass"] else "FAIL",
                                                     {k: v["maxErrorAtHalfFrames"] for k, v in rt["clips"].items()}))
    if not rt["pass"]:
        raise ExportError("pose round-trip error %.3g voxels >= 1e-3" % rt["maxErrorAtFrames"])

    for p in rig["parts"]:
        svox.write_part_albedo(cfg["out"], p, vols[p["name"]])
    svox.save_json(os.path.join(cfg["out"], "rig.json"), rig)
    report["exportSeconds"] = round(time.time() - t_start, 2)
    print("exported %d parts + %d clips -> %s (%.2fs)" % (len(rig["parts"]), len(rig["clips"]), cfg["out"], report["exportSeconds"]))

    # ---- bake + validate with the skill CLI (outside Blender's Python, exactly as a user would)
    ok = True
    if cfg["bake"]:
        ok = run_cli(["bake-normal-ao", "--bundle", cfg["out"]], report["cli"]) == 0
        os.makedirs(os.path.dirname(cfg["validate_output"]), exist_ok=True)
        vcode = run_cli(["validate", "--bundle", cfg["out"], "--output", cfg["validate_output"]], report["cli"])
        with open(cfg["validate_output"], encoding="utf-8") as fh:
            vr = json.load(fh)
        report["validate"] = {"exitCode": vcode, "ok": vr.get("ok"), "errors": len(vr.get("errors", [])), "warnings": len(vr.get("warnings", []))}
        ok = ok and vcode == 0 and vr.get("ok") and (cfg["allow_warnings"] or not vr.get("warnings"))
    report["ok"] = bool(ok)
    os.makedirs(os.path.dirname(cfg["report"]), exist_ok=True)
    with open(cfg["report"], "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    print("export report -> %s  (%s)" % (cfg["report"], "OK" if ok else "FAILED"))
    return ok


if __name__ == "__main__":
    cfg = parse_args()
    try:
        good = export(cfg)
    except ExportError as e:
        print("EXPORT ERROR: %s" % e)
        good = False
    if not good:
        sys.exit(1)
```

## Caveats (what is *not* covered by the verification)

- **Armatures.** Only object parenting was exercised. A bone-parented object has the armature object as its
  `obj.parent`, which is not a part, so it is exported as a root. Re-parent rigid parts to each other (or bake) first.
- **UV image textures are not sampled.** Colour comes only from colour attributes and material base colours. Bake
  textures into a colour attribute if you need them.
- **Deform channels are not derived from Blender animation.** Squash, shear and wave cannot be expressed by rigid
  object animation, so they are authored in `svox_channels` JSON (or edited in `rig.json`).
- **Emission is not in SVOX.** The emissive visor and blade edge only show their base colour, and T3 lighting applies
  as usual.
- **Performance.** Voxelisation is pure Python per voxel centre with C-side BVH queries. The demo's 3 parts (about
  6.6k cells) take about 0.1 s, and a 32³ part takes a few seconds.
