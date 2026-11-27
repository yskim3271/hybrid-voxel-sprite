# Target: WebGL2 / Three.js

**Status: Verified ✅ (raw WebGL2) · Verified ✅ (Three.js r187 / `three@0.187.0`) · v1.1 Verified ✅ (PerspectiveCamera 3D-world MRT hybrid, §4.5).**

- **Raw WebGL2 path.** This is the reference WebGL2 renderer (`HybridRenderer`). The skill's
  `assets/minimal_reference` bundle was loaded into it from SVOX files, in headless Chrome on D3D11 (GTX 1080) and on
  SwiftShader. All four gates passed with 0 JS and 0 WebGL errors (see [03 §2](../03_pitfalls_and_qa_gates.md)).
- **Three.js path (§4).** A standalone pure-Three.js port (the reference Three.js QA project) loaded the same bundle
  through `svox_cli.py pack-atlas --format raw_3d` into `THREE.Data3DTexture`s. All four gates passed in headless Chrome
  on D3D11 (GTX 1080) **and** SwiftShader, with 0 console, 0 page and 0 WebGL errors (measurements in §4.4). It also
  matched the raw-WebGL2 renderer to ≤ 72 differing pixels out of 115,560 per view across 15 views.
- **v1.1 production use (§4.5).** The same Three.js r187 contract drives a 4-vehicle showroom (39 parts, 166,290
  voxels) and a multi-world 60 fps daylight showcase, with one `PerspectiveCamera` and one shared depth buffer.

Pipeline and constants: [02_shader_pipeline_spec.md](../02_shader_pipeline_spec.md). Math:
[01_contract_and_math.md](../01_contract_and_math.md).

## 1. Context & GLSL ES 3.00 rules

- `canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true })`
  - `preserveDrawingBuffer` is needed only for readback QA or screenshots.
  - `antialias: false` keeps the pixel grid crisp.
- Every shader starts `#version 300 es` and declares `precision highp float; precision highp sampler3D;`.
  - Fragment shaders also declare `precision highp int;`.
  - The post shader declares `precision highp sampler2D;`.
  - **Three.js:** `RawShaderMaterial`/`ShaderMaterial` with `glslVersion: THREE.GLSL3` add the `#version` line
    themselves, so leave it out of the source (see §4.1).
- **MRT rule:** a shader drawn while 2 draw buffers are enabled must declare `layout(location = 0) out vec4` **and**
  `layout(location = 1) out vec4`. Single-output passes run with `drawBuffers([COLOR_ATTACHMENT0, NONE])`.

## 2. Resources (exactly as the verified renderer creates them)

```js
// Albedo / normal-AO volumes: TEXTURE_3D RGBA8, idx = ((z*sy + y)*sx + x)*4 (texImage3D order, no reordering needed)
function upload3D(gl, sx, sy, sz, bytes, linear) {
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_3D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, sx, sy, sz, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  const f = linear ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, f); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, f);
  for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_BASE_LEVEL, 0); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAX_LEVEL, 0);
  gl.bindTexture(gl.TEXTURE_3D, null); return t;
}
// One volume, two filters: WebGLSampler objects override the texture's filter per unit.
function makeSampler(gl, filter) {
  const s = gl.createSampler();
  gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, filter); gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, filter);
  for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.samplerParameteri(s, w, gl.CLAMP_TO_EDGE);
  return s;
}
// unit 0: albedo with sampLinear (smooth) or sampNearest (crisp); unit 1: normal/AO with sampNearest (texelFetch)
// after the part loop: for k in 0..1 { activeTexture(TEXTURE0+k); bindTexture(TEXTURE_3D, null); bindSampler(k, null) }

// G-buffer FBO at floor(viewport / pixelScale)
function make2D(gl, w, h, internal, format, type) {
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null); return t;
}
const color  = make2D(gl, fw, fh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
const normal = make2D(gl, fw, fh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);             // rgb = N*0.5+0.5, a = fg mask
const depth  = make2D(gl, fw, fh, gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT);   // readable in post
const fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, normal, 0);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) console.error('G-buffer FBO incomplete');
```

**Geometry.**
- The proxy is a unit cube with 8 vertices and 36 `Uint16` indices, attribute location 0 = `vec3 aPos ∈ [0,1]³`. It is
  drawn with `CULL_FACE` + `cullFace(FRONT)`.
- The post pass and ground shadows use a 4-vertex `TRIANGLE_STRIP` quad with `vec2 aPos ∈ [0,1]²`.

**Per-frame order.**
1. `bindFramebuffer(fbo)` and `viewport(0,0,fw,fh)`.
2. `drawBuffers([C0, C1])`, then `clearBufferfv` for C0, C1 (`0.5,0.5,0.5,0`) and depth (`1`).
3. `drawBuffers([C0, NONE])`, then draw the grid and the shadow quads.
4. `drawBuffers([C0, C1])`, then draw the parts.
5. `bindFramebuffer(null)`, `drawBuffers([BACK])`, then run the post pass with scissor.
6. Restore state (see 02 §6).

## 3. Loading an SVOX bundle in the browser (verified QA runtime, condensed)

```js
async function decodePNG(buf) {               // 8-bit RGB/RGBA, non-interlaced; keeps alpha (= AO) exact
  const b = new Uint8Array(buf), dv = new DataView(buf); let p = 8, w, h, ct, chunks = [];
  while (p < b.length) { const n = dv.getUint32(p), t = String.fromCharCode(...b.subarray(p + 4, p + 8));
    if (t === 'IHDR') { w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); ct = b[p + 17]; }
    else if (t === 'IDAT') chunks.push(b.subarray(p + 8, p + 8 + n)); else if (t === 'IEND') break; p += 12 + n; }
  const raw = new Uint8Array(await new Response(new Blob(chunks).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const ch = ct === 6 ? 4 : 3, st = w * ch, px = new Uint8Array(w * h * ch); let prev = new Uint8Array(st), q = 0;
  for (let y = 0; y < h; y++, q += st + 1) { const f = raw[q], L = raw.slice(q + 1, q + 1 + st);
    for (let x = 0; x < st; x++) { const a = x >= ch ? L[x - ch] : 0, u = prev[x], c = x >= ch ? prev[x - ch] : 0;
      const pa = Math.abs(u - c), pb = Math.abs(a - c), pc = Math.abs(a + u - 2 * c);
      L[x] = (L[x] + [0, a, u, (a + u) >> 1, (pa <= pb && pa <= pc) ? a : (pb <= pc ? u : c)][f]) & 255; }
    px.set(L, y * st); prev = L; }
  if (ch === 4) return { w, h, data: px };
  const out = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) out.set([px[3*i], px[3*i+1], px[3*i+2], 255], 4 * i);
  return { w, h, data: out };
}
const stripToVolume = (s, sx, sy, sz) => { const v = new Uint8Array(sx * sy * sz * 4);
  for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++)
    v.set(s.subarray((y * sx * sz + z * sx) * 4, (y * sx * sz + z * sx + sx) * 4), ((z * sy + y) * sx) * 4); return v; };
```

**Load.** For each `rig.parts[i]`, fetch `albedoPath` and `normalAoPath`, check `w === sx*sz && h === sy`, and convert
both strips to volumes. The result is a `{ name, volume: { sizeX, sizeY, sizeZ, pivot, data, normalAoData } }`
`PartDef`, which is exactly what `HybridRenderer.setSubject()` consumes.

**Pose.** Port `evaluate_pose` from [01 §4](../01_contract_and_math.md). It gives each part
`{ matrix, invMatrix, deform }` plus `rootOffset`.

**Render.**
```js
r.render({ camera: Math.buildCameraState(yaw, pitch, zoom, [0, 0, rig.targetHeight], w/h, 46),
           light: Math.buildLightState(), pose, options: {}, subject }, { x, y, width, height })
```
`options` defaults to the §3.6 contract values: `raymarchSmooth`, `celBands 4`, `pixelScale 3`, outline on and so on.

**PNG decoder caveats.**
- The parser above does not verify CRCs; use `svox_cli.py validate` offline for that.
- `new Blob(chunks)` concatenates the IDAT payloads, which is what the zlib stream requires.
- The QA run compared it with Chrome's native decoder on every opaque texel: 0 mismatches.

## 4. Three.js adaptation (✅ Verified on three r187)

Verified on 2026-11-25 with `three@0.187.0` (`THREE.REVISION` `187`) in Chrome with ANGLE, on D3D11 (GTX 1080) and on
SwiftShader. The reference port (Three.js QA project) is laid out as:
- `src/svox_three.js`: raw_3d loader, pose, camera and light.
- `src/t3_shaders.js`: GLSL.
- `src/t3_three_renderer.js`: the `ThreeT3Renderer` class.
- `qa.html` + `src/qa_gates.js`: the gates.
- `probe.html` + `src/api_probe.js`: the API probes cited below as P1–P6.
- `index.html`: an interactive viewer.

The port keeps every constant and expression order from [02](../02_shader_pipeline_spec.md). Only the API plumbing
below differs.

### 4.1 API mapping (✅ Verified)

| Raw WebGL2 (verified) | Three.js r187 (verified) |
|---|---|
| `texImage3D` RGBA8 volume | `const t = new THREE.Data3DTexture(bytes, sx, sy, sz); t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType; t.minFilter = t.magFilter = filter; t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping; t.needsUpdate = true;` The `raw_3d` bins from `pack-atlas` are already in `texImage3D` order and upload unchanged. `Data3DTexture` **already defaults** to `unpackAlignment = 1`, `flipY = false`, Nearest filters, `wrapR = ClampToEdge` and `generateMipmaps = false` (P6). Setting them again is harmless. |
| NEAREST + LINEAR `WebGLSampler` on one texture | Three has no sampler objects, so make one `Data3DTexture` per filter on the same `bytes`. `texelFetch` ignores filtering, so in smooth mode the LINEAR copy serves both `texture()` and `texelFetch`. The NEAREST copy is needed only for crisp mode, where `sampleSmooth` in the self-shadow must be nearest. Ground shadows always bind the LINEAR copy. |
| MRT FBO + `DEPTH_COMPONENT24` texture | `new THREE.WebGLRenderTarget(fw, fh, { count: 2, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: true, depthTexture: new THREE.DepthTexture(fw, fh, THREE.UnsignedIntType) })`. This yields `rt.textures.length === 2` with `rt.texture === rt.textures[0]`, a complete FBO, and a 24-bit depth **texture** attachment (P1). `DepthTexture` defaults to `DepthFormat`, Nearest, and `compareFunction = null`, so the post pass reads it with a plain `sampler2D` + `texelFetch(...).r`. `setRenderTarget(rt)` enables `drawBuffers([C0, C1])`; `setRenderTarget(null)` restores `[BACK]`. |
| GLSL 3.00 programs | `new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, ... })`. Three **prepends `#version 300 es` itself**, so a source that also starts with `#version` fails to compile ("#version directive must occur before anything else", P4). Write your own precision lines (`float`, `int`, `sampler2D`, `sampler3D`). The vertex attribute is Three's `position`. `projectionMatrix`, `viewMatrix` and `modelMatrix` are filled automatically when declared. |
| Every G-buffer shader declares `location 0` **and** `location 1` | Required. A single-output material drawn into the `count: 2` target is rejected with `GL_INVALID_OPERATION: Active draw buffers with missing fragment shader outputs`, and C0 stays untouched (P3). This is pitfall 1 again, under Three. |
| `clearBufferfv` per attachment | `renderer.clear()` clears **both** attachments to the same clear colour (P2). Use renderOrder 0 for a fullscreen "clear" `RawShaderMaterial` with `depthTest: true, depthFunc: THREE.AlwaysDepth, depthWrite: true, blending: NoBlending`. It writes `C0 = background`, `C1 = (0.5, 0.5, 0.5, 0)` and `gl_FragDepth = 1.0`. Depth writes need the depth test enabled, so the pass uses `AlwaysDepth` rather than `depthTest: false`. Set `renderer.autoClear = false`. |
| Grid and shadows with `drawBuffers([C0, NONE])` | Three cannot mask one attachment per draw. Those shaders output `location 1 = vec4(0.5, 0.5, 0.5, 0.0)`, and the **blend function** then leaves C1 bit-exactly unchanged. The grid uses `CustomBlending` with `SrcAlpha / OneMinusSrcAlpha` for colour and `One / OneMinusSrcAlpha` for alpha. The shadows use `SrcAlpha / OneMinusSrcAlpha` for colour and `Zero / One` for alpha. With source alpha 0, C1's RGB is `dst·1` and its alpha is `dst.a`. Shadows keep `depthFunc: THREE.LessDepth` and `depthWrite: true`, so the first part wins (pitfall 11). |
| Draw order (grid → shadows → parts) | One `Scene` with `renderOrder` values: 0 clear, 1 grid, `100+i` shadows, `1000+i` parts. Every material keeps **`transparent: false`**; `CustomBlending` still blends. A `transparent: true` mesh moves to Three's transparent list and is drawn **after all opaque meshes regardless of `renderOrder`** (P5), which would put the grid over the character. |
| Part proxy box | `new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5)`, one `Mesh` per part: `matrixAutoUpdate = false`, `mesh.matrix.copy(M')`, `frustumCulled = false`, `side: THREE.BackSide` (= `cullFace(FRONT)`). Three flips the winding only when `matrixWorld.determinant() < 0`; `RotX(π)` flipped cloth has det +1, but a mirrored, negative-scale part would invert the culling. |
| Per-part uniforms | Use **one material per part**. Materials with identical sources share one program (5 programs in total here: clear, grid, part, shadow, post). Three re-uploads material uniforms only when the material changes between draws; if you share one material across meshes, set `material.uniformsNeedUpdate = true` in `onBeforeRender`. |
| `uInvViewProj`, pixel snap | Build a real `THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, -200, 200)` with `camera.up.set(0, 0, 1)`, `position = eye` and `lookAt(target)`. Its basis and `makeOrthographic` match [01 §1](../01_contract_and_math.md). Render through an **internal** camera with `matrixAutoUpdate = matrixWorldAutoUpdate = false`, copying `matrixWorld`/`matrixWorldInverse` and `projectionMatrix` from the caller's camera, then snapping with `P.elements[12] += dn.x; P.elements[13] += dn.y` (`T(dn)·P` for an ortho matrix). This keeps `render()` from rebuilding the matrices and keeps snaps from accumulating on the user's camera. Never call `updateProjectionMatrix()` after snapping. Upload `uViewProj = P'·V` and `uInvViewProj = inverse(P'·V)`, inverted in float64 with `Matrix4.invert()`, for rays and `gl_FragDepth`. Rasterization uses the built-ins. |
| Post blit | `THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false, blending: NoBlending })` on `PlaneGeometry(2, 2)` with `gl_Position = vec4(position.xy, 0, 1)`. With GLSL3, Three does **not** declare `pc_fragColor`, so declare `layout(location = 0) out vec4 oColor;`. Use `texelFetch` on `rt.textures[0]`, `rt.textures[1]` and `rt.depthTexture`. `setViewport`, `setScissor` and `setScissorTest(true)` take CSS pixels and multiply by `pixelRatio` (the port uses `setPixelRatio(1)`). The viewport origin is bottom-left, as in GL. |
| Read-backs | `renderer.readRenderTargetPixels(rt, x, y, w, h, buf, undefined, textureIndex)` selects `readBuffer(COLOR_ATTACHMENT0 + textureIndex)` for MRT. Use `textureIndex = 1` for the foreground mask; this is how the G1 gate reads it. For the canvas, call `setRenderTarget(null)`, then `gl.readPixels` with `preserveDrawingBuffer: true`. **Raw GL calls on Three's FBOs desync its state cache.** After `gl.bindFramebuffer(...)` the next `readRenderTargetPixels` raised `readBuffer: invalid read buffer` until `renderer.resetState()` was called. |
| Colour management | All colour uniforms are `Vector3`/`Vector4`, never `THREE.Color`, so no sRGB↔linear conversion occurs. Volume textures and render targets use `NoColorSpace`. `RawShaderMaterial`, and a `ShaderMaterial` without `#include <colorspace_fragment>`, apply no output transform. |

**Three.js units.** SVOX stays Z-up inside every matrix. The pose is evaluated with `THREE.Matrix4` (float64):
`makeRotationX/Y/Z` match `math.js`, and the `Rz·Ry·Rx` chain matches 01 §4. It agreed with the float32 JS runtime's
pose samples to **5.5e-7** (18 matrices). Three's `modelViewMatrix`/`normalMatrix` are not used.

### 4.2 Pitfall found while porting: half-texel origin-snap ties (affects raw WebGL2 too)

`snapToTexel` rounds the origin's virtual-texel coordinate. The orbit target is the screen centre, and the origin lies
directly below it. With an **even** G-buffer width, for example `fw = 106` from 320 px at ×3, its column therefore sits
on an **exact half-texel** (`sx = 52.5`) for every yaw, and `Math.round` is decided by 1e-14 float noise.
- **Effect.** The whole frame, grid included, jumps 1 virtual texel between nearby yaws. A 2 × 720-step yaw sweep flipped
  664 times at `fw = 106`, and 0 times at `fw = 107` or `213`.
- **Between ports.** Float64 (`THREE.Matrix4`) and float32 (`Float32Array`) chains break the tie differently. The first
  320-wide Three-vs-raw diff showed 69,351 changed pixels in one view from this alone.
- **Fix used by the port.** `Math.round(sx + 1e-6)`, the `snapTieBias` option, which defaults to `1e-6`. It gives 0 flips
  and leaves every non-tie case unchanged. Set it to 0 to reproduce the raw renderer's rounding exactly. An odd G-buffer
  size works as well.
- G2 still passes with the bias: the root snap uses the same function.

### 4.3 GPU precision note

G3 is defined on the float64 formula. The port runs it there: 400 samples, 200 from the clips and 200 random deforms.
As extra evidence, the same GLSL `invDeformP` was run on the device in a float32 render target:

| Device | Max round-trip error | Without twist/wave |
|---|---|---|
| GTX 1080 | 3.1e-6 voxel | 1.5e-6 voxel |
| SwiftShader | **2.2e-3 voxel** | 1.1e-6 voxel |

The SwiftShader error comes from its lower-precision float32 `sin`/`cos`, not from argument size: wrapping
`wavePhase` into [−π, π) did not change it. That is well inside the 1.25-voxel proxy margin, and G1/G2/G4 pass on
SwiftShader. Do not expect GPU-side round trips below 1e-5 on software rasterizers.

### 4.4 Gate results (minimal_reference: torso 14×10×17, arm_blade 7×15×14 with a 2-voxel blade, flipped cape 12×4×11)

| Gate | D3D11 · GTX 1080 | SwiftShader |
|---|---|---|
| G1 slice cracks @14° / @33° (192 renders: 12 yaws × 4 phases × `idle`+`swing` × 2 pitches) | **0 / 0**; 70 enclosed texels, all real gaps (max ray α 0.469); control 6/6 | **0 / 0**; 67 real gaps (max α 0.460); control 6/6 |
| G2 sub-texel root shift, snap ON / OFF (3 cases, incl. 14° and ground shadows) | **0/0/0 px** / 12,852 · 9,356 · 13,646 | **0/0/0 px** / 17,729 · 15,416 · 21,412 |
| G3 `undeform(deform(p))`, 400 samples | **2.2e-15** | **2.2e-15** |
| G4 rest lowest z · 17-sample clip minimum · loop seam | 0.000 · 0.000 · 1.8e-15 (idle), 2.7e-15 (swing) | same |
| G4 reversed draw order / z-buffer off | **0/0/0 px** / 9,882 · 2,547 · 8,961 | **0/0/0 px** / 9,882 · 2,538 · 8,961 |
| Console / page / WebGL errors | 0 / 0 / 0 | 0 / 0 / 0 |
| Frame time, readPixels-bracketed median, ×3 (640×360 · 1280×720) | 0.6 ms · 0.8 ms | 20.2 ms · 71.9 ms |

**Draw calls.** Pass 1 issues 8 Three draw calls: clear, grid, 3 shadows and 3 parts. The post pass adds 1. 02 §6
counts 8 because it does not count the clear.

**Cross-checks.**
- `pack-atlas` raw bins against the PNG strips decoded by the QA runtime: 0 byte mismatches.
- Parity with the raw-WebGL2 `HybridRenderer` at 321×360, an odd `fw` chosen to avoid ties, over 15 views. The views
  cover all 8 sheet panels plus crisp DDA/march, `celBands 0`, depth/slices debug, unlit, and ×4 without outline.
  - D3D11: at most 72 of 115,560 pixels differed, and at most 9 by more than 8/255.
  - SwiftShader: at most 45 pixels differed; one `slices` band edge showed Δ 115.

The minimal pure-Three.js frame loop, condensed from the reference port's `src/t3_three_renderer.js`:
```js
renderer.autoClear = false;  renderer.setPixelRatio(1);
// per frame: snap (§4.1) -> per part: mesh.matrix = M', uniforms (uInvModel = invM·T(-rootDelta), box, deform, light)
renderer.setRenderTarget(rt);   renderer.render(gScene, snappedCam);    // clear(0) grid(1) shadows(100+i) parts(1000+i)
renderer.setRenderTarget(null); renderer.setViewport(x, y, w, h); renderer.setScissor(x, y, w, h); renderer.setScissorTest(true);
renderer.render(postScene, postCam); renderer.setScissorTest(false);
```

### 4.5 PerspectiveCamera + 3D world MRT hybrid recipe (v1.1)

**Status: Verified ✅ on three r187.** It is backed by two builds:
- the 4-vehicle showroom: a construction vehicle, an F1 car, a compact car and a pickup, 39 parts and 166,290 voxels, real SVOX bundles plus
  motion plugins;
- a multi-world daylight showcase (three iterations): 1920×1080 and 1080×1920, 1,635 frames at 60 fps each, headless Chrome on
  ANGLE D3D11, **glError 0** and 0 console or page errors.

The same G-buffer contract as §4.1 drives a full perspective 3D world, in which Three.js meshes and T3 voxel actors
occlude each other through **one hardware depth buffer**.

```js
THREE.ColorManagement.enabled = false;                       // BEFORE any material or colour is created (03 pitfall 15)
const camera = new THREE.PerspectiveCamera(40, W / H, 4, 2600);     // one camera for world + actors
const fw = Math.floor(W / 2), fh = Math.floor(H / 2);                  // pixelScale 2
const rt = new THREE.WebGLRenderTarget(fw, fh, {
  count: 2, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
  depthBuffer: true, stencilBuffer: false, type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
  depthTexture: new THREE.DepthTexture(fw, fh, THREE.UnsignedIntType), colorSpace: THREE.NoColorSpace });
// renderOrder 0 sky (gl_FragDepth = 1, C1 = (0.5,0.5,0.5,0)) · 1 world meshes · 2 dynamic layer (smoke, props)
// renderOrder 1000+i  T3 part proxies (BackSide boxes, §4.1)          -> renderer.render(scene, camera) into rt
// pass 2 (FW_POST) -> full-res composite rtComp; cinema pass -> canvas
```

**Shared depth.**
- World meshes rasterise normally, so their depth is the hardware depth of the same `projectionMatrix · viewMatrix`.
- T3 parts build their rays from `uInvViewProj` at the near and far planes (`ndc.z = −1` and `+1`), which is the
  perspective form of `pixelRay`. They write `gl_FragDepth` from the hit's `uViewProj · wp`, with the
  [02 §8](../02_shader_pipeline_spec.md#8-v11-d24-depth-bucket-tie-break-udepthslot--udepthslots) slot tie-break.
- A wheel sinks into a kerb, or an arm passes behind a pillar, per pixel and in either draw order.
- Upload `uViewProj` and `uInvViewProj` from the same `camera` every frame. There is no ortho pixel snap in
  perspective, because the camera moves continuously.

**C1 alpha is a layer mask.**
- `1.0` marks a SVOX actor. World geometry is capped at `≤ 0.85` (`ground 0.25`, `dressing 0.5`). `0` is sky.
- Pass 2 draws 1 px outlines and creases only for texels with mask above 0.75, and only where the actor is in front.
- Pass 2 writes a keep-sharp flag into the composite alpha: 1 for the actor (`mask > 0.9`, its outline and wipe cores),
  0.2 for sky and 0 for the world.

**Actor-masked cinema post-FX** (`WORLD_POST_FRAG`, full resolution).
- A pixel with composite alpha above 0.6 is an actor and **passes through untouched**. SVOX voxels stay 100%
  pixel-crisp under any amount of motion blur.
- Background pixels get:
  1. A radial zoom streak toward the vanishing point, plus a camera-pan smear: 16 jittered taps with a length cap.
  2. A depth-aware softening that starts only past `1.15 ×` the actor depth, plus a gentle desaturation.
  3. A beat-synced radial RGB split.
  4. An anamorphic glare from a quarter-resolution bright pass, then film grain.
- **No background tap ever reads an actor pixel.** Use `texelFetch` (nearest), and skip any tap with alpha above 0.6
  (or fall back to the centre channel), so actors never smear into the world.
- **Tech wipe bands** (NORMALS / SPRITE STACK / VOLUME AO, [02 §10](../02_shader_pipeline_spec.md#10-v11-debug--showcase-view-modes))
  return early, and taps that land inside a band are skipped. Glare never blooms out of a band.

**Seamless treadmill worlds.**
- The vehicles stay near the origin while the world scrolls. Each periodic world mesh gets
  `uShift = (0, P · floor(camY / P), 0)`, where `P` is the world's period, so the geometry is re-centred under the
  camera in whole periods.
- Author the world tiles to be exactly `P`-periodic along the travel axis. The jump is then invisible.
- Analytic shadow casters repeat with the same period: `boxVis` tests the caster boxes at 5 period offsets
  (`k0 − 2 … k0 + 2`).

**Analytic box sun shadows.**
- World caster boxes (up to `MAX_BOXES`) are slab-tested along the sun direction `L`, from both the world shader
  (`boxVis(vW + N·0.6, L)`) and the T3 part shader (`boxVis(wp + N·0.8, L)`). Pillars and gantries therefore shadow the
  vehicles too.
- Vehicles cast onto the world through `vehVis`: oriented footprint rectangles at 3 heights per vehicle, projected along
  `L`.
- No shadow map and no extra pass are needed, and the shadows stay crisp at any resolution.

**Measured.** At most 46 draw calls per frame. The lossless capture renders 12.4 fps at 16:9 and 17.0 fps at 9:16,
reading back the full-resolution RGBA frame every frame. The capture recipe is in
[03 §3](../03_pitfalls_and_qa_gates.md#3-extended-multi-part-verification-notes-v11).

## 5. Headless QA pattern (Chrome + CDP, verified)

1. **Serve the workspace over HTTP.** `fetch` of PNGs and `DecompressionStream` both need http.
2. **Launch Chrome.**
   ```
   chrome --headless=new --use-gl=angle --use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist --remote-debugging-port=0 --user-data-dir=<tmp>
   ```
   Use `--use-angle=swiftshader --enable-unsafe-swiftshader` for CPU-only CI.
3. **Read the port** from `<tmp>/DevToolsActivePort`, then open the page target's `webSocketDebuggerUrl` with Node's
   global `WebSocket`.
4. **Enable domains.** Turn on `Runtime`, `Page` and `Log`. Collect `Runtime.consoleAPICalled`,
   `Runtime.exceptionThrown` and `Log.entryAdded`.
   - Classify `/GL_INVALID|INVALID_OPERATION|webgl/i` as WebGL errors.
   - Treat "GPU stall due to ReadPixels" as an info-level performance note.
   - Add `<link rel="icon" href="data:,">`, or the favicon 404 shows up as a console error.
5. **Run the gates in the page.**
   - Read the mask with `bindFramebuffer(READ_FRAMEBUFFER, fbo); readBuffer(COLOR_ATTACHMENT1); readPixels(…)`, then
     restore `readBuffer(COLOR_ATTACHMENT0)`.
   - Diff the output with `readPixels` right after `render()`.
   - Store the result as `window.__result`.
6. **Capture.** Poll for `window.__result`, then run `Page.captureScreenshot`. **Open the PNG and inspect it**: a gate
   can pass on a black frame.
7. **Three.js port.** The same pattern is used, through the reference implementation's CDP harness
   (`scripts/cdp_harness.mjs` there). Commands below are from the reference Three.js QA project:
   - `node threejs/run_qa.mjs --backend d3d11|swiftshader` runs the gates, timing and parity checks. It
     writes `threejs_minimal_reference_t3.png` and `threejs_gates.json` to its QA output folder.
   - `node threejs/run_extra.mjs` runs the API probes and a viewer smoke test.
   - The mask is read with `renderer.readRenderTargetPixels(rt, …, textureIndex = 1)` instead of raw `readBuffer`.
