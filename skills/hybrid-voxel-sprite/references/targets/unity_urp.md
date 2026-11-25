# Target: Unity 6 URP

**Status: ✅ Verified (Unity 6000.5.3f1 URP 17.5.0) — RenderGraph, Direct3D11. Also verified on Direct3D12.**
Vulkan, Metal, GLES and player builds have not been run (§9).

- **What was run.** A standalone Unity 6000.5.3f1 project (origin repo `target_tests/unity_urp/`) loaded the skill's
  `assets/minimal_reference` bundle through `svox_cli.py pack-atlas --format raw_3d` into `Texture3D`s. It ran the full
  two-pass T3 pipeline ([02](../02_shader_pipeline_spec.md)) as a URP `ScriptableRendererFeature` that uses **only**
  `RecordRenderGraph`.
  - Rendering went through a real orthographic `Camera` and `Camera.Render()`.
  - The batchmode runner ran on a GTX 1080 with `-force-d3d11`, and again with `-force-d3d12`.
- **Gates.** All four gates in [03 §2](../03_pitfalls_and_qa_gates.md) passed **inside Unity** on both APIs
  (numbers in §8).
  - 0 C# compiler errors and 0 compiler warnings.
  - 0 HLSL errors and 0 warnings. Every vertex and fragment stage was compiled explicitly for D3D with
    `ShaderData.Pass.CompileVariant`.
  - The C# rig matrices match `svox_cli.evaluate_pose` exactly (max abs diff 0.0 over 18 matrices).
  - The D3D11 and D3D12 sheets are bit-identical.
- **By-eye check.** The 8-panel sheet `unity_urp_minimal_reference_t3.png` matches the WebGL2 reference
  `minimal_reference_t3.png`.
  - **98.8–100 % of the compared panel pixels are byte-identical**, with mean abs diff ≤ 0.004 / 255 per panel.
  - The residue is ±1 rounding plus one 3×3 texel.
  - Label boxes and gate badges were masked out of the comparison (`Tools/compare_reference.py`).

Pipeline and constants: [02](../02_shader_pipeline_spec.md). Math: [01](../01_contract_and_math.md). All code below is
excerpted from the files that ran. Paths are relative to `target_tests/unity_urp/`.

| File | Role |
|---|---|
| `Assets/SVOX/Shaders/SvoxCommon.hlsl` | pixel ray, slab, analytic inverse deform, `DeformNormal`, `EdgeMask`, samplers |
| `Assets/SVOX/Shaders/SvoxPart.shader` | pass 1d: MRT + `SV_Depth` raymarch, DDA, cel/AO/self-shadow/rim lighting, debug views |
| `Assets/SVOX/Shaders/SvoxShadow.shader`, `SvoxGround.shader` | pass 1c ground shadows, pass 1b grid |
| `Assets/SVOX/Shaders/SvoxPost.shader` | pass 2: `Load()` NEAREST blit + 1px depth/normal outline |
| `Assets/SVOX/Runtime/SvoxFeature.cs` | `ScriptableRendererFeature` + RenderGraph passes |
| `Assets/SVOX/Runtime/SvoxFrame.cs` | camera placement, texel snap, root snap, proxy bounds, shadow rects |
| `Assets/SVOX/Runtime/SvoxRig.cs`, `SvoxMath.cs`, `SvoxJson.cs` | bundle loader, `evaluate_pose` port, double math, JSON |
| `Assets/Editor/SvoxQaRunner.cs` | batchmode setup (URP asset, renderer, feature) and all gates |
| `Tools/run_qa.ps1` | launcher |
| `Tools/compose_sheet.py`, `compare_reference.py`, `check_pose_parity.py` | sheet composition and parity checks |

## 1. Axes and the Unity camera

SVOX is right-handed **Z-up** and faces `-Y`. Unity is left-handed **Y-up** and faces `+Z`.

**Keep every raymarch formula in SVOX space.** Unity appears only in a single matrix: the reflection
`svoxToUnity = (x, y, z) → (x, z, y)`. Its columns are `(1,0,0)`, `(0,0,1)`, `(0,1,0)`; it has det −1 and is its own
inverse. A character facing SVOX `-Y` faces Unity `-Z`.

**Place a real Unity camera** from the SVOX orbit camera (01 §1):

```csharp
// SvoxFrame.Prepare — V3.ToUnity(v) = new Vector3(v.x, v.z, v.y)
cam.orthographic = true;  cam.orthographicSize = (float)sc.halfH;  cam.aspect = (float)sc.aspect;
cam.transform.SetPositionAndRotation(V3.ToUnity(sc.eye), Quaternion.LookRotation(V3.ToUnity(sc.forward), V3.ToUnity(sc.up)));
cam.projectionMatrix = M4.ToUnity(T(dn) * sc.proj);   // GL-style ortho, near −200 / far 200, texel-snapped (§3)
```

- With that transform, Unity's own `worldToCameraMatrix · svoxToUnity` equals the SVOX `mat4LookAt` view.
- Measured: `|P'·V_unity·svoxToUnity − VP'_svox| = 2.2e-7`, which is float32 noise. The runner checks this every run.
- A negative near plane in a custom `projectionMatrix` is fine.

**The device matrix that every shader uses** is built in `RecordRenderGraph` from the camera data:

```csharp
var gpuP = GL.GetGPUProjectionMatrix(cameraData.GetProjectionMatrix(), true);   // reversed-Z + RT Y-flip
var vpD  = M4.Mul(M4.Mul(M4.FromUnity(gpuP), M4.FromUnity(cameraData.GetViewMatrix())), M4.SvoxToUnity());
mpb.SetMatrix("_SvoxVP", M4.ToUnity(vpD));  mpb.SetMatrix("_SvoxInvVP", M4.ToUnity(M4.Invert(vpD)));  // inverse in double
```

- `UniversalCameraData.GetGPUProjectionMatrix(bool)` is **internal** in URP 17.5. Call `GL.GetGPUProjectionMatrix` on
  `GetProjectionMatrix()` yourself.
- Pass `renderIntoTexture: true`, because the G-buffer is always a render texture.
- Matrices go from double `float[16]` column-major to Unity with `m[i % 4, i / 4] = a[i]`.

## 2. Texture3D from SVOX `raw_3d`

```csharp
// <part>.albedo.rgba8.bin / .normal_ao.rgba8.bin: x fastest, then y, then z == Texture3D.SetPixelData order
var t = new Texture3D(sx, sy, sz, TextureFormat.RGBA32, false) {
    filterMode = linear ? FilterMode.Bilinear : FilterMode.Point, wrapMode = TextureWrapMode.Clamp, anisoLevel = 0 };
t.SetPixelData(bytes, 0);
t.Apply(false, true);   // no mips, drop the CPU copy
```

- In HLSL, declare `Texture3D<float4> _Vol; SamplerState sampler_linear_clamp;`. The inline sampler is the analogue of
  the WebGL2 LINEAR sampler object.
- Read the crisp DDA path and `_Nao` with `.Load(int4(c, 0))`, which is the analogue of `texelFetch`.
- Use **`SampleLevel(…, 0)` everywhere, never `Sample`.** Every smooth sample sits inside a dynamic `[loop]`, and the
  D3D compile reported 0 warnings with this rule.
- `rig.json` is parsed with a small hand-written JSON reader. `JsonUtility` cannot tell a missing `cycles` (default 1)
  from 0.

## 3. Pixel snap (02 §1), exact

```csharp
f.ps = opt.usePixelSnap ? Math.Max(1, Math.Min(8, (int)Math.Floor(opt.pixelScale + 0.5))) : 1;
f.fw = Math.Max(1, outW / f.ps);  f.fh = Math.Max(1, outH / f.ps);
f.dn = SnapToTexelJs(VP, origin, f.fw, f.fh);           // uses JS Math.round = floor(x + 0.5)
VP = T(dn) * VP;  P = T(dn) * P;  cam.projectionMatrix = M4.ToUnity(P);
dr = SnapToTexelJs(VP, pose.rootOffset, fw, fh);  rootDelta = R·dr.x/sx + U·dr.y/sy;   // then M' = T(rootDelta)·M
```

- C# `Math.Round` defaults to banker's rounding, so use `Math.Floor(x + 0.5)` to match the JS reference on ties.
- Draw the grid and its contact shadow at the snapped root.

## 4. HLSL boundary: pixel ray, depth, row order (reversed-Z, D3D)

```hlsl
void PixelRay(float4 svPos, out float3 ro, out float3 rd) {        // SV_Position, never varyings
  float2 uv = (svPos.xy - _SvoxViewport.xy) / _SvoxViewport.zw;
#if UNITY_UV_STARTS_AT_TOP
  float2 ndc = float2(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);         // D3D: pixel row 0 = NDC y +1
#else
  float2 ndc = uv * 2.0 - 1.0;
#endif
  float4 a = mul(_SvoxInvVP, float4(ndc, UNITY_NEAR_CLIP_VALUE, 1.0));     // 1 on reversed-Z
  float4 b = mul(_SvoxInvVP, float4(ndc, UNITY_RAW_FAR_CLIP_VALUE, 1.0));  // 0 on reversed-Z
  ro = a.xyz / a.w;  rd = normalize(b.xyz / b.w - ro);
}
float DeviceDepth(float3 wp) { float4 c = mul(_SvoxVP, float4(wp, 1.0)); return c.z / c.w; }   // → SV_Depth
```

- **`SV_Depth = clip.z / clip.w` through the GPU matrix is already reversed-Z** (near 1, far 0). Do not write
  `0.5·z + 0.5`.
- **Depth state needs no manual reversal.**
  - ShaderLab `ZTest LEqual` and `ZTest Less`, including `ZTest [_ZTest]` from a property, are flipped by Unity on
    reversed-Z devices.
  - `ClearRenderTarget(…, depth: 1.0f, …)` means "far".
  - G4 proves this works: reordering the parts changes 0 px.
- **Row order.**
  - The G-buffer was rendered with the render-into-texture (Y-flipped) projection, so its memory is "GL-like": row 0 is
    the image bottom.
  - The QA output render texture uses the same layout. So in the post pass, `c = floor(SV_Position.xy / outSize ·
    (fw, fh))` and `Load(int3(c, 0))` need **no flip**, and the outline offsets keep `(0, 1)` as "up".
  - Only a real back buffer needs a flip: `_FlipY = resourceData.isActiveTargetBackBuffer &&
    SystemInfo.graphicsUVStartsAtTop`.
  - `Texture2D.ReadPixels` of these render textures gives row 0 = bottom. The runner checks this every run: 383 of 383
    sampled foreground mask texels lie on solid CPU rays as read, and only 296 of 383 would if flipped.
- **The outline reads reversed depth.** Convert first with `gl = UNITY_REVERSED_Z ? 1 − d : d`. Then the 02 §6 tests
  (`dl − dq > 1.75`, "nearest neighbour") can stay verbatim, with `depthScale = 2 / |VP'.row2|` taken from the GL VP'.
- `discard` before any output works. A missed pixel never writes depth, and no black proxy rectangles appeared.

`SvoxPart.shader` header (state):

```shaderlab
Properties {
  [Enum(UnityEngine.Rendering.CompareFunction)] _ZTest ("ZTest", Float) = 4   // LessEqual; Always for useZBuffer=false
  [Enum(Off, 0, On, 1)] _ZWrite ("ZWrite", Float) = 1
  [Enum(UnityEngine.Rendering.CullMode)] _Cull ("Cull", Float) = 1            // Front
}
... Cull [_Cull]  ZWrite [_ZWrite]  ZTest [_ZTest]  Blend Off
struct GBufferOut { float4 color : SV_Target0; float4 normal : SV_Target1; float depth : SV_Depth; };
// vertex: o.pos = mul(_SvoxVP, mul(_Model, float4(lerp(_BoxMin, _BoxMax, v.pos), 1.0)));   unit cube mesh [0,1]^3
```

- The fragment body is 02 §4–§5 line for line: `vec → float`, `mix → lerp`, `fract → frac`, `mod → fmod`,
  `inversesqrt → rsqrt`, and `transpose(mat3(invM))` becomes `transpose((float3x3)_InvModel)`.
- Integer and boolean uniforms are passed as floats and tested with `> 0.5`. `MaterialPropertyBlock.SetInt` is
  deprecated, and this keeps the C# warning-free.

## 5. ScriptableRendererFeature (RenderGraph only)

```csharp
public class SvoxFeature : ScriptableRendererFeature {
  public Shader partShader, shadowShader, groundShader, postShader;              // assign so player builds include them
  public override void Create() { m_Pass = new SvoxPass(this) { renderPassEvent = RenderPassEvent.AfterRenderingTransparents }; }
  public override void AddRenderPasses(ScriptableRenderer r, ref RenderingData d) { if (SvoxFrame.Current != null && m_Pass.EnsureResources()) r.EnqueuePass(m_Pass); }
}
// SvoxPass : ScriptableRenderPass — overrides RecordRenderGraph(RenderGraph, ContextContainer) only, no Execute().
```

`AddRenderPasses(…, ref RenderingData)` is still the abstract signature in 17.5 and compiles without warnings.
`RecordRenderGraph` skips any camera other than `SvoxFrame.Current.camera`.

**Pass layout.** The low-res G-buffer is a set of persistent `RenderTexture`s: C0 and C1 are `R8G8B8A8_UNorm`, depth
is `D24_UNorm_S8_UInt`, and all use Point/Clamp. They are recreated only when `fw × fh` changes, wrapped once with
`RTHandles.Alloc(rt)`, and brought in each frame with `renderGraph.ImportTexture`. Keeping them persistent lets the QA
read C1.a after `Camera.Render()`.

| RenderGraph raster pass | Attachments | Work |
|---|---|---|
| `SVOX Clear C1` | C1 | `ClearRenderTarget(RTClearFlags.Color, (0.5, 0.5, 0.5, 0))`: mask a = 0 |
| `SVOX Ground+Shadow` | C0 + depth | `ClearRenderTarget(ColorDepth, bg, 1)`, then the grid (`ZWrite Off ZTest Always`, blend `SrcAlpha OneMinusSrcAlpha, One OneMinusSrcAlpha`) and per-part shadow quads (`ZTest Less`, `SV_Depth`, blend `…, Zero One`) |
| `SVOX Parts` | C0 + C1 + depth | `DrawMesh(unitBox, identity, partMat, 0, 0, mpb)` per part, in subject order |
| `SVOX Post (NEAREST + outline)` | output | `UseTexture` on C0, C1 and depth. `DrawProcedural(identity, postMat, 0, Triangles, 3, 1, mpb)` draws a fullscreen triangle from `SV_VertexID` |

- **The WebGL2 `drawBuffers([C0, NONE])` maps to a separate raster pass that binds only C0.** Do not rely on an MRT
  pass leaving an unwritten target alone.
- **The output is `resourceData.activeColorTexture`, or an imported QA render texture.** Both paths were rendered and
  compared: 0 px differ, max channel delta 0. Use a Linear colour space, a `R8G8B8A8_UNorm` camera target, HDR off and
  MSAA 1.
- **Each draw gets its own `MaterialPropertyBlock`.** The block carries `_SvoxVP`, `_SvoxInvVP`, `_SvoxViewport`,
  `_Model = M'`, `_InvModel = invM'`, `_BoxMin/Max`, `_Size`, `_Pivot`, `_DefA = (squashZ, twistZ, shearX, shearY)`,
  `_DefB = (waveAmpX, waveAmpY, waveFreq, wavePhase)`, the textures and the lighting values.
- There are 8 draw calls for the 3-part reference, the same as WebGL2: 1 grid, 3 shadows, 3 parts and 1 post.
- **Batchmode setup** (`SvoxQaRunner.EnsurePipeline`):
  1. `ScriptableObject.CreateInstance<UniversalRendererData>()`, then `AddObjectToAsset(feature, rendererData)`.
  2. Append the feature to `m_RendererFeatures` and its local file id to `m_RendererFeatureMap` through
     `SerializedObject`.
  3. `UniversalRenderPipelineAsset.Create(rendererData)`, then assign it to `GraphicsSettings.defaultRenderPipeline`
     and `QualitySettings.renderPipeline`.

## 6. C# rig driver

- **`SvoxBundle.Evaluate(clip, t)`** ports `evaluate_pose` (01 §4) in double precision. Children attach to the parent's
  forward-deformed point, then `Rz·Ry·Rx`, then `RotX(π)` for flipped cloth, then `S(1 + scale)`.
- **`Deform`** holds the CPU `DeformPoint` / `UndeformPoint` pair from `svox_cli`, plus the GPU-clamped
  `ForwardGpu` / `InverseGpu` (`s = max(squashZ, 0.05)`).
- **`SvoxFrame.Prepare`** handles each frame:
  - places the camera and applies the snap (§1, §3);
  - computes `deformedBounds`: 13 levels, padding XY `1.25 + 0.5·|twistZ|` and Z `1`;
  - computes the shadow rect (`L'z = max(L.z, 0.12)`, padded by 1);
  - sets the affine flag and the step budget.
- IK and springs are not used by the reference bundle and were not ported here. Port `solveTwoBoneIK` and `SpringVec3`
  from [01 §5](../01_contract_and_math.md) into `Update` if you need them; the 240 Hz sub-steps keep them stable at any
  `deltaTime`.

## 7. Pitfalls found in the real run

1. **The licence blocks batchmode silently.**
   - *Symptom:* `-batchmode -quit` exits **198** with `'com.unity.editor.headless' was not found` and `No valid Unity
     Editor license found`.
   - *Cause:* the licensing client logged `Token not found in cache` and `LicenseGroupOfflineValidityPeriodIsExpired`.
     Unity Hub was signed out.
   - *Fix:* sign in to the Hub, then run a smoke check (`-batchmode -quit`, expect exit 0) before anything else.
2. **Launching from scripts.**
   - Git Bash mangles `-projectPath` into a doubled path (`…/unity_urp/C:/…/unity_urp`).
   - PowerShell `&` returns immediately, because Unity.exe is a GUI-subsystem app.
   - `Start-Process -Wait` can **hang forever**: it also waits for the `Unity.Licensing.Client` child that Unity
     spawns and leaves alive. Use `Start-Process -PassThru` followed by `$p.WaitForExit()`.
   - A project folder without `Assets/` gives the same doubled-path "Couldn't set project path" error.
3. **6000.5 defaults the Windows editor to Direct3D12.** Pass `-force-d3d11` when the target is D3D11. Both APIs
   produce bit-identical results with the code above.
4. **On D3D12, the per-target MRT clear writes the wrong targets.**
   - *Symptom:* on a C0 + C1 + depth pass, `ClearRenderTarget(RTClearFlags.All, new[] { bg, (0.5, 0.5, 0.5, 0) }, 1, 0)`
     cleared C0 to `(127, 127, 127, 0)` and **left C1 uncleared**. The foreground mask accumulated across frames (3849
     against 3149 texels in the experiment), which drew ghost outlines of earlier silhouettes.
   - The same call is correct on D3D11.
   - *Fix:* use one clear per attachment set, as in §5. The `mrtClearExperiment` block in `unity_urp_gates*.json`
     reproduces this on every run.
5. **Culling is a no-op for correctness.** `Cull Front`, `Back` and `Off` gave 0 px difference, because the ray is
   rebuilt from `SV_Position`. Keep `Front`: it gives one fragment per pixel, even though Unity's culling convention
   with a det(−1) swap and a flipped projection is easy to get backwards.
6. **Never use `Sample` inside the march loops.** Use `SampleLevel(…, 0)` (§2). The shipped shaders compile with 0
   FXC warnings and 0 errors for every stage.
7. **Read reversed depth in the post pass** as `1 − d` before applying the 02 §6 thresholds (§4). The G-buffer and
   output row order need no flips; only the back buffer does (§4).

## 8. Results (D3D11, GTX 1080, `artifacts/qa/adapters/unity_urp/`)

| Gate | Unity 6000.5.3f1 URP (D3D11 = D3D12) | WebGL2 reference |
|---|---|---|
| G1 slice cracks at 14° / 33° (192 renders) | **0 / 0**. 70 enclosed texels, all real gaps, max ray alpha 0.469. Control flagged 6/6 | 0 / 0, 70, 0.469, 6/6 |
| G2 changed px, snap on (off) | **0 / 0 / 0** (12,848 / 9,457 / 13,486) | 0 / 0 / 0 (12,852 / 9,356 / 13,648) |
| G3 `undeform(deform(p))` | **1.8e-15** (400 clip samples; GPU-formula mirror also 1.8e-15). 3.7e-15 over 2,000 random deforms | 1.8e-15 |
| G4 rest lowest z / loop seam / reorder px / z-off px | **0.000 / 2.2e-15 / 0, 0, 0 / 9,891, 2,547, 8,952** | 0.000 / 2e-15 / 0 / 2,538–9,882 |
| C# and HLSL errors / warnings | **0 / 0** (CS); **0 / 0** (`CompileVariant` D3D, 4 shaders × 2 stages) | — |
| Rig parity vs `svox_cli` | **0.0** max abs diff | < 1e-4 |
| Frame time | 0.63–0.75 ms median at 640×360 @×3, measured as `Camera.Render()` + 1×1 `ReadPixels` CPU wall time (not a GPU timer) | 0.8–0.9 ms |

**Artefacts:**
- `unity_urp_minimal_reference_t3.png`: the sheet. Every panel pixel comes from Unity; `compose_sheet.py` only adds
  the labels.
- `unity_urp_gates.json`, `unity_batchmode.log`, `unity_urp_g1_worst_case.png`, `unity_urp_vs_webgl2_parity.json`,
  `unity_urp_pose_parity.json`.
- `*_direct3d12.*`: the same outputs from the D3D12 run.

**Re-run:**
1. `powershell -File target_tests/unity_urp/Tools/run_qa.ps1` (add `-Api d3d12` for the D3D12 run).
2. `uv run --with pillow python target_tests/unity_urp/Tools/compose_sheet.py <raw> <gates> <out>`.

## 9. Not verified

- Vulkan, Metal, GLES3/WebGL and player builds were not run. Builds need the shader references on the feature, because
  `Shader.Find` is only a fallback.
- The `UNITY_UV_STARTS_AT_TOP == 0` branches and the back-buffer `_FlipY` path never executed. The camera path that
  was tested renders into an intermediate render texture.
- The crisp DDA path (`raymarchSmooth = false`) compiles, but no gate exercises it. The gates use the default smooth
  path, as in WebGL2.
- XR and multi-view, the URP compatibility mode (not used), IK and springs (§6).
