# Target: Godot 4.x

**Status: ✅ Verified (Godot 4.7.2) — Forward+ and Mobile on Vulkan.** 🧪 Compatibility (OpenGL 3.3): runs, but not
verified (§9).

- **What was run.** A standalone Godot 4.7.2.stable project (origin repo `target_tests/godot4/`) loaded the skill's
  `assets/minimal_reference` bundle through `svox_cli.py pack-atlas --format raw_3d` into `ImageTexture3D`s. It ran the
  full two-pass T3 pipeline ([02](../02_shader_pipeline_spec.md)) as GDShaders on a real GPU (GTX 1080, Vulkan 1.4).
- **Gates.** All four gates in [03 §2](../03_pitfalls_and_qa_gates.md) passed **inside Godot**, on both Forward+ and
  Mobile (numbers in §10).
  - 0 script errors, 0 shader errors and 0 engine warnings (in-engine `Logger` + console logs).
  - Rig matrices match `svox_cli.evaluate_pose` to 1.1e-16.
  - The Forward+ and Mobile verification sheets are pixel-identical (0 of 921,600 panel pixels differ).
- **By-eye check.** The 8-panel sheet `godot4_minimal_reference_t3.png` matches the WebGL2 reference
  `minimal_reference_t3.png` panel for panel:
  - same cel bands, rim, baked AO, flipped cape, blade, ground shadows and crisp 1-texel outlines;
  - mean absolute difference 1.9–2.8 / 255 per panel. The residue comes from the 0.6 % aspect difference noted in §1.

Pipeline and constants: [02](../02_shader_pipeline_spec.md). Math: [01](../01_contract_and_math.md).

## 1. Axes, camera, pixel snap

SVOX is right-handed **Z-up**, front `-Y`. Godot is right-handed **Y-up**, forward `-Z`; `Vector3.MODEL_FRONT` is `+Z`.

- **Do not convert the math.** Every part node lives under a `Node3D` named `SvoxSpace` whose basis maps SVOX to Godot
  as `(x, y, z) → (x, z, −y)`. With this basis, SVOX front `−Y` becomes Godot `+Z` (= `MODEL_FRONT`). The determinant is
  +1, so handedness and winding survive.
  ```gdscript
  # Basis(...) takes COLUMNS = the images of SVOX x, y, z
  $SvoxSpace.transform = Transform3D(Basis(Vector3(1, 0, 0), Vector3(0, 0, -1), Vector3(0, 1, 0)), Vector3.ZERO)
  ```
- **Shaders use two constant matrices** (column-major GLSL):
  ```glsl
  const mat4 G2S = mat4(vec4(1,0,0,0), vec4(0,0,1,0), vec4(0,-1,0,0), vec4(0,0,0,1));  // Godot world -> SVOX world
  const mat4 S2G = mat4(vec4(1,0,0,0), vec4(0,0,-1,0), vec4(0,1,0,0), vec4(0,0,0,1));  // SVOX world -> Godot world
  ```
  All ray, deform, normal and lighting math stays in SVOX space, exactly as 02 §4–5. Godot appears only at two
  boundaries: the pixel ray coming in (§4) and `DEPTH` going out.
- **Part nodes.** `MeshInstance3D.transform = M'` in SVOX units, as a child of `SvoxSpace`, so `MODEL_MATRIX = S · M'`.
  The shader also gets `inv_model = invM'` and `model_svox = M'` as `mat4` uniforms, built from 64-bit GDScript floats.
- **Camera.**
  - The `Camera3D` is a child of `SvoxSpace`, with local transform `Transform3D(Basis(right, up, −forward), eye)` from
    01 §1.
  - It uses `PROJECTION_ORTHOGONAL`, `keep_aspect = KEEP_HEIGHT` and `size = 46 / zoom` (the full visible height).
  - The eye sits **300** voxels from the target, with `near = 100` and `far = 500`. That gives the same ±200 depth span
    as WebGL's `near = −200 / far = 200` around an eye at 100, while keeping `near` positive.
- **Aspect.** Godot's ortho camera uses the **SubViewport's** aspect, `fw / fh` (106 / 120). Build the CPU `VP` with
  that aspect so the snap and the CPU re-trace match the GPU. WebGL uses the full viewport aspect (320 / 360), which is
  0.6 % wider.
- **Pixel snap (verified, 0 px crawl).**
  1. Compute `dn = snapToTexel(VP, origin)` on the CPU (02 §1).
  2. Apply it as a view-space offset: `cam.h_offset = −dn.x · halfW` and `cam.v_offset = −dn.y · halfH`.
     `Camera3D.get_camera_transform()` moves the eye along its own right/up axes, which equals `VP' = T(dn) · VP`.
  3. Compute `rootDelta` from `VP'` and push it into every part: `M' = T(rootDelta) · M`,
     `invM' = invM · T(−rootDelta)`. Do the same for the grid's contact-shadow centre.

## 2. Volume textures from SVOX

`pack-atlas --format raw_3d` gives exactly the bytes Godot wants: `x` fastest, then `y`, then `z`. Use one `Image`
per Z slice:

```gdscript
static func load_volume(bytes: PackedByteArray, sx: int, sy: int, sz: int) -> ImageTexture3D:
    var slices: Array[Image] = []
    var slice_len := sx * sy * 4
    for z in sz:
        slices.append(Image.create_from_data(sx, sy, false, Image.FORMAT_RGBA8, bytes.slice(z * slice_len, (z + 1) * slice_len)))
    var tex := ImageTexture3D.new()
    var err := tex.create(Image.FORMAT_RGBA8, sx, sy, sz, false, slices)   # no mipmaps
    assert(err == OK)
    return tex
```

- **Filtering.** Godot has no sampler objects, so the filter is a uniform hint. Bind the **same** `ImageTexture3D` to
  two uniforms: `sampler3D vol_l : filter_linear, repeat_disable` and `sampler3D vol_n : filter_nearest,
  repeat_disable`.
  - `repeat_disable` = `CLAMP_TO_EDGE`, so keep `edgeMask` (pitfall 03 §1.4).
  - `texelFetch` ignores the filter.
  - Normal/AO goes into `nao_n : filter_nearest` and is read with `texelFetch` only.
- **Rows.** A raw volume needs no flip. If you build the slices from a `strip_x` PNG instead, slice `z` is
  `img.get_region(Rect2i(z * sx, 0, sx, sy))`. PNG row 0 is voxel `y = 0`, and that is also image row 0 in Godot.

## 3. Viewports & colour management (the part that needed fixing)

```
OutputViewport   SubViewport, LDR RGBA8, out_w × out_h, 2D only
├── ColorViewport    SubViewport, use_hdr_2d = true (RGBAH), fw × fh, own_world_3d
│   └── SvoxSpace ── Camera3D, Grid (QuadMesh), Shadow_<part> (QuadMesh), Part_<part> (BoxMesh, lit material)
├── GBufferViewport  SubViewport, use_hdr_2d = true, transparent_bg = true, fw × fh, own_world_3d
│   └── SvoxSpace ── Camera3D (same transform), Part_<part> (same BoxMesh, out_mode = 1 material)
└── Composite        ColorRect filling OutputViewport + canvas_item svox_composite.gdshader
fw = floor(out_w / pixelScale), fh = floor(out_h / pixelScale)       (106 × 120 for 320 × 360 @ ×3)
```

- **Use HDR SubViewports as raw data buffers.** Measured on Forward+ and Mobile:
  - An **8-bit** SubViewport runs 3D `ALBEDO` through linear→sRGB (0.5 is stored as 0.737).
  - A `use_hdr_2d` SubViewport stores `ALBEDO` **raw and unclamped** in `RGBAH`/`RGBH` (37.5 stays 37.5).
  - So both Pass-1 viewports are HDR. The shaders write WebGL's display-space colours straight into `ALBEDO`, and the
    composite reads them back verbatim with `texelFetch`. No double gamma, and the same bytes as WebGL.
- **G-buffer without MRT.** GDShader has no custom multiple render targets, so a twin viewport renders the same parts
  with `out_mode = 1`:
  - `rg` = octahedral SVOX-world normal · 0.5 + 0.5
  - `b` = (view distance − `depth_ref`) / 64 + 0.5. Half-float precision is about 0.03 voxel, far below the 1.75-voxel
    outline threshold.
  - The **foreground mask** is the alpha channel. `transparent_bg = true` clears to (0, 0, 0, 0), and opaque draws
    write α = 1. An opaque spatial shader cannot write `ALPHA` without becoming transparent.
- **Background colour.** `Environment.background_color` is treated as sRGB and linearised by Forward+/Mobile. To get
  the raw WebGL clear value `(0.071, 0.078, 0.098)` into the buffer, set `BG.linear_to_srgb()`. The QA reads it back
  as 0.0710 / 0.0781 / 0.0981.
- **Order and readback.**
  - Child SubViewports render before their parent viewport in the same frame.
  - Set `render_target_update_mode = UPDATE_ALWAYS`. The default `UPDATE_WHEN_VISIBLE` never renders an off-screen
    target: readback is black.
  - After changing state, await `RenderingServer.frame_post_draw` **twice**, then `get_texture().get_image()`.
    Rendering the same state twice gave a 0 px difference.
- **Culling.** The vertex shaders reshape unit meshes, so set `GeometryInstance3D.custom_aabb` to something large on
  every reshaped instance. Otherwise Godot frustum-culls parts by the unit mesh's AABB.

## 4. Part GDShader (Pass 1d) — `shaders/svox_part.gdshader` + `svox_common.gdshaderinc`

```glsl
shader_type spatial;
render_mode unshaded, cull_front, depth_draw_always, depth_test_default, shadows_disabled, fog_disabled;
#include "res://shaders/svox_common.gdshaderinc"   // uniforms + slab / invDeform / edgeMask / sampleSmooth (02 §4)

void vertex() { VERTEX = mix(box_min, box_max, VERTEX + 0.5); }   // BoxMesh(size 1) is centred; MODEL_MATRIX = S·M'

void svox_pixel_ray(vec2 screen_uv, mat4 inv_proj, mat4 inv_view, out vec3 ro, out vec3 rd) {   // in the include
    vec4 vn = inv_proj * vec4(screen_uv * 2.0 - 1.0, 1.0, 1.0);  vn /= vn.w;
    ro = (G2S * inv_view * vec4(vn.xy, 0.0, 1.0)).xyz;           // ortho: on the camera plane, in front of everything
    rd = normalize((G2S * inv_view * vec4(0.0, 0.0, -1.0, 0.0)).xyz);
}

void fragment() {
    svox_pixel_ray(SCREEN_UV, INV_PROJECTION_MATRIX, INV_VIEW_MATRIX, ro_w, rd_w);   // from the pixel, never varyings
    ro = (inv_model * vec4(ro_w, 1.0)).xyz;  rd = mat3(inv_model) * rd_w;  rd /= length(rd);
    // ... slab -> smooth march (0.35, iso 0.45, 6 bisections) or crisp DDA -> hd; discard on miss (02 §4 verbatim)
    vec3 wp = (model_svox * vec4(hd, 1.0)).xyz;                  // SVOX world hit
    vec4 view_p = VIEW_MATRIX * (S2G * vec4(wp, 1.0));
    vec4 clip = PROJECTION_MATRIX * view_p;
#if CURRENT_RENDERER == RENDERER_COMPATIBILITY
    DEPTH = clip.z / clip.w * 0.5 + 0.5;
#else
    DEPTH = clip.z / clip.w;                                     // Forward+ / Mobile
#endif
    // ... albedo, baked normal/AO, deformNormal, transpose(mat3(inv_model)), self-shadow, cel/rim (02 §4–5 verbatim)
    ALBEDO = out_mode == 1 ? vec3(oct_encode(N) * 0.5 + 0.5, (-view_p.z - depth_ref) / 64.0 + 0.5) : clamp(col, 0.0, 1.0);
}
```

**Depth conventions (measured in 4.7.2, near 1 / far 100, ortho).**

| Renderer | `PROJECTION_MATRIX` NDC z | `FRAGCOORD.z` / window depth | Correct `DEPTH` |
|---|---|---|---|
| Forward+ (Vulkan) | reversed, [0, 1]: 0.808 at dist 20 | **1 = near, 0 = far**, equals NDC z | `clip.z / clip.w` |
| Mobile (Vulkan) | same as Forward+ | same | `clip.z / clip.w` |
| Compatibility (GL 3.3) | reversed, **[−1, 1]** | 1 = near, 0 = far, `= ndc·0.5 + 0.5` (0.808 at dist 20) | `clip.z / clip.w · 0.5 + 0.5` |

- **How these were verified.**
  - A constant-`DEPTH` sweep against plain rasterized geometry: in every renderer the writer wins exactly when
    `DEPTH > (far − d) / (far − near)`.
  - A "claim nearer" / "claim farther" probe: only `clip.z / clip.w` was consistent in both directions on Forward+ and
    Mobile.
  - The T3 runs themselves (§10).
- **Inverted depth is invisible to the reorder test.** A wrong `DEPTH` is still part-order independent, so
  "reversed order = 0 px" alone cannot catch an inverted convention. The QA therefore adds a **depth-convention check**:
  1. Re-trace sampled foreground texels on the CPU, taking the first `α ≥ 0.45` crossing per part.
  2. The G-buffer depth must equal the **nearest** hit.
  3. Over 761 texels where parts overlap by more than 2 voxels, 99.5–100 % matched the nearest hit. An inverted Z
     would keep the farthest.

## 5. Ground shadow (Pass 1c) — `shaders/svox_shadow.gdshader`

- One `QuadMesh` per part sits under `SvoxSpace` with an identity transform. `vertex()` spreads it over the
  light-projected world rect on `z = 0.02`.
- The fragment code is 02 §3 verbatim, with `ALBEDO = (0.035, 0.03, 0.075)` and `ALPHA = 0.5`.
- **Dedup across overlapping parts.** WebGL writes the identical ground-point depth and relies on `depthFunc(LESS)`.
  Godot has no strict-less mode for transparent draws, so use the **stencil buffer** (Godot 4.5+):
  ```glsl
  render_mode unshaded, cull_disabled, depth_draw_never, depth_test_default, blend_mix;
  stencil_mode read, write, compare_not_equal, 1;     // first shadow fragment on a pixel writes 1, later ones fail
  ```
  Probe: two overlapping α = 0.5 quads darken the background once (0.0732 → 0.0366), not twice.
- **Ordering.** Grid `render_priority = −2`, shadows `−1`. Both are transparent and depth-tested but not
  depth-writing, so they draw after the opaque parts and stay hidden behind them. Parts above the ground are always
  nearer than the ground point on the same pixel ray, so the result equals WebGL's "grid → shadows → parts" order.

## 6. Composite (Pass 2) — `shaders/svox_composite.gdshader` (canvas_item)

- A `ColorRect` fills `OutputViewport`.
- `c = clamp(ivec2(floor(UV · textureSize)), 0, size − 1)`, then **`texelFetch` only** from both HDR textures
  (`filter_nearest, repeat_disable`). The result is crisp ×3 blocks and 1-texel outlines.
- **Rows grow downward in Godot.** Godot images and `texelFetch` row 0 are the **top** row (on Forward+/Mobile).
  WebGL's neighbour order `(+x, +y_up, −x, −y_up)` therefore becomes `(1,0), (0,−1), (−1,0), (0,1)`, so the
  normal-crease test (`i < 2`) still looks right and up.
- The rest is 02 §6 verbatim. Depth is in voxels, `(b − 0.5) · 64`. Darkness is 0.78, the edge threshold 1.75 voxels,
  and the normal threshold `dot < 0.45`, against the SVOX-space light.

## 7. GDScript rig driver — `scripts/svox_rig.gd`

- **Precision.** It is a line-by-line port of `svox_cli.py` (`evaluate_pose`, `deform_point`, `undeform_point`,
  `m4_*`). It uses **`Array` / `PackedFloat64Array` of 64-bit `float`**.
  - `Vector3`, `Transform3D` and `Projection` are 32-bit `real_t`. Convert only at the node/uniform boundary.
  - Result: G3 = 1.8e-15 (the same LCG samples as the browser harness), and pose parity with `svox_cli` = 1.1e-16.
- **IK and springs.** Port `solveTwoBoneIK` and `SpringVec3` from 01 §5 the same way. No `Skeleton3D` is needed: every
  part is one rigid transform plus its 8 deform scalars.
- **Per frame.**
  - Node transform `= to_transform(M')`.
  - Uniforms: `inv_model` and `model_svox` (as `Projection`), `box_min` / `box_max` from `deformed_bounds`
    (13 levels + margins), `def_a = (squashZ, twistZ, shearX, shearY)`, `def_b = (ampX, ampY, freq, phase)`,
    `affine_deform`.

## 8. Pitfalls found while running Godot 4.7.2

1. **`--headless` uses the Dummy renderer and produces no pixels.**
   - Run with `--rendering-driver vulkan` (or `opengl3`) in a small real window.
   - Quit with `get_tree().quit(code)` and keep an **external timeout**. A GDScript parse error in the main-scene
     script leaves Godot idling forever: the first run hung until the shell timeout.
2. **`DEPTH` must be written on every non-discarded path.** A shader that writes it in only one branch made the quad
   silently vanish on the other path, because unwritten depth fails the test.
3. **8-bit viewports gamma-encode 3D output, HDR viewports do not.** See §3. Mixing them up shifts every colour, and an
   8-bit G-buffer cannot hold depth.
4. **The `Environment` background is linearised** (Forward+/Mobile). Pre-invert it with `linear_to_srgb()`.
5. **`UPDATE_WHEN_VISIBLE` (the default) never renders a hidden SubViewport.** Use `UPDATE_ALWAYS` and wait 2 frames.
6. **Opaque draw order follows `render_priority`.**
   - G4's "reverse order" sets `render_priority` descending and reorders the children.
   - Proof that the order really changed: with the z-test off, reversing changes 7,407–11,607 px. With the z-test on it
     changes 0 px.
   - The z-off variant is the same shader code with `depth_test_default → depth_test_disabled`, compiled as a second
     `Shader`.
7. **No strict-less depth for transparent draws.** Use stencil for the shadow dedup (§5).
8. **The `texelFetch` row direction is flipped** relative to GL (§6).
9. **GDScript `:=` cannot infer types from `Variant` expressions** (untyped `Array` elements, calls on an untyped
   `Node`). Those are parse errors, so annotate with `: float =` or `: Image =`.
10. **GDScript prints and stringifies floats to about 14 decimals.**
    - A 1.8e-15 error prints as `0.0`.
    - Use `JSON.stringify(data, "  ", false, true)` (full precision).
    - `"%e"` is not a supported format specifier.
11. **Catch errors in-engine.** `OS.add_logger()` with a `Logger` subclass catches script, shader and engine errors at
    runtime (Godot 4.5+). The QA fails if it records any error or warning.
12. **Godot's ortho camera aspect is the SubViewport's** `fw / fh` (§1). A CPU camera built with another aspect breaks
    the G1 re-trace and the G2 snap.

## 9. Compatibility renderer (OpenGL 3.3) — runs, not verified

The same project runs with `--rendering-driver opengl3 --rendering-method gl_compatibility`:
- **Pass:** G1 (0 cracks / 192 renders, control 6 of 6), G2 (0/0/0 px snap on), G3, the G4 ground and loop checks, and
  G4 reorder (0/0/0 px).
- **Fail:** the depth-convention check (92–96 % agreement) and the background sanity check. Causes:
  - HDR SubViewports are **not** raw there. 0.25 is stored as 0.2491, and 37.5 as 61.09. The G-buffer depth is
    therefore distorted, and the outline shows small artefacts.
  - `Environment.background_color` is **not** linearised (raw value 0.295 instead of 0.071).
- **Fix path (not done).** Encode G-buffer depth into two 8-bit channels, or use the real depth texture. Skip the
  `linear_to_srgb()` background pre-inversion under `RENDERER_COMPATIBILITY`.

## 10. QA harness & measured results

```powershell
uv run .agents/skills/hybrid-voxel-sprite/scripts/svox_cli.py pack-atlas --bundle .agents/skills/hybrid-voxel-sprite/assets/minimal_reference --format raw_3d --out target_tests/godot4/svox_raw
powershell -File target_tests/godot4/run_qa.ps1                            # Forward+ / Vulkan (also: -Method mobile -Sub mobile_vulkan)
uv run target_tests/godot4/tools/post_check.py                             # pose parity vs svox_cli, log scan, renderer parity
```

These results are from Godot 4.7.2.stable, Forward+, Vulkan 1.4.312, GTX 1080, 320×360 output at ×3 (106×120). Mobile
gave identical numbers.

| Gate | Result |
|---|---|
| G1 14° / 33° zero-gap | **0 cracks** over 192 renders. The 77 enclosed texels are real gaps (max ray α 0.462). The punched-hole control flagged 6 of 6 |
| G2 snap crawl | **0 / 0 / 0 px** with snap on, against 14,658 / 10,332 / 14,316 px with it off |
| G3 inverse deform | **1.8e-15** (400 clip samples) and 3.7e-15 (2,000 random deforms) |
| G4 ground / loop / occlusion | rest lowest z 0.000, clip minimum 0.000, seam ≤ 2.2e-15. Reversed order **0 / 0 / 0 px**; z-off 8,388 / 1,125 / 7,380 px. Depth convention 99.5–100 % nearest |
| Errors | 0 script, 0 shader, 0 engine errors or warnings. `godot_stderr.log` is empty |
| Extras | Determinism 0 px. Crisp mode (DDA + 0.4 march) smoke: 0 cracks. GPU time about 0.1–0.6 ms for all 3 viewports. 11 draw calls |

**Not covered.** Godot's editor-only shader lint (for example unused-uniform warnings in the shader editor) cannot run
headlessly. The shaders were written so that every declared uniform, varying and function is used.

## 11. Port checklist

- [x] The four gates pass in Godot: 14° cracks (CPU re-trace), sub-texel crawl, deform inverse, and
      ground/loop/occlusion with reversed part order (order change proven by z-off sensitivity).
- [x] The `DEPTH` convention is checked against the CPU nearest hit where parts interpenetrate (761 overlap texels).
- [x] The NEAREST composite is verified: `texelFetch` only, crisp ×3 blocks, 1-texel outlines in the sheet.
