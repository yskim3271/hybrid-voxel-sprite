# 03 — Pitfalls & QA Gates

Every item here was hit in a real build of the reference implementation (core renderer, asset pipeline, showcase
reels and production showcases). Each entry gives the symptom, the cause and the fix that shipped. Formulas are in [01](01_contract_and_math.md) and shaders in
[02](02_shader_pipeline_spec.md).

## 1. Pitfalls

1. **MRT `drawBuffers` → `INVALID_OPERATION` (Chrome/ANGLE).**
   - *Symptom:* with an FBO that has 2 active draw buffers, every draw fails silently and the G-buffer stays at its
     clear colour.
   - *Cause:* the shader declares only `location 0`.
   - *Fix:* every G-buffer shader declares **both** `layout(location = 0) out` and `layout(location = 1) out`. The
     shared ground grid writes an up-normal to location 1.
   - Passes that only write colour, such as the grid in T3 and the ground shadows, run with
     `drawBuffers([COLOR_ATTACHMENT0, NONE])` so C1 is never written with undefined data.
   - Then restore `drawBuffers([BACK])`, or `[COLOR_ATTACHMENT0]` when the output is an FBO, before the post pass.
2. **`gl.finish()` is a timing trap in Chrome.**
   - *Symptom:* a frame reports about 1 ms but really takes about 180 ms.
   - *Cause:* Chrome's `finish()` does not block on the GPU.
   - *Fix:* close each timed frame with a 1×1 `gl.readPixels`, or use `EXT_disjoint_timer_query_webgl2`.
   - ANGLE then logs "GPU stall due to ReadPixels" performance notes. Treat them as information, not errors.
   - Older numbers measured with `gl.finish` (1–5 ms) are **not** trustworthy. The figures in this skill
     (0.8–0.9 ms at 640×360 @×3 on a GTX 1080) are readPixels-bracketed.
3. **Convex staircase AO false darkening.**
   - *Symptom:* after AO was first strengthened, curved surfaces such as spheres and helmets turned uniformly grey.
   - *Cause:* window cells beside a voxel step were counted as occluders.
   - *Fix:* count only AO cells clearly in front of the true tangent plane (`dot(offset, n) > 0.75`, on top of the
     26-direction window choice). The convex sphere's AO went back to 1.00, while the crevice stays at 0.51 and the
     overhang at 0.42.
4. **`CLAMP_TO_EDGE` edge bleed.**
   - *Symptom:* a part whose voxels touch its grid border grows a smeared skin or a flat wall when LINEAR-sampled.
   - *Cause:* the border voxel is repeated outside the grid.
   - *Fix:* multiply every smooth sample by `edgeMask(v)`, which is zero padding in shader math.
   - Also author parts with a **1-voxel empty margin** on X, Y and the top. The normal/AO shell dilation needs room
     there too. Example: `init-demo` gives the cape 320 shell voxels with a margin, against 16 without.
5. **One-voxel-thin parts break up.**
   - *Symptom:* a sword blade or wing membrane turns into a dotted line or holes when rotated, baked or morphed.
   - *Fix:* thin features must be **at least 2 voxels thick**.
   - `validate` warns `THIN_PART` when more than 25% of a part's voxels have both neighbours empty along some axis.
   - The core sword and wings were thickened to 2. The reference arm's blade is 2 thick.
6. **Uniformly scaled part matrices.**
   - *Symptom:* the rally car's exhaust carried a uniform scale from 0.16 to 1.40, and two separated flame instances
     inside one part drifted off their pipes as the scale changed.
   - *Fix:*
     - Never assume an orthonormal `mat3(invMatrix)`. Renormalise `rd` after `mat3(invM)·rdW`, and transform normals
       with `transpose(mat3(invM))` followed by normalize. T3 does both.
     - Keep instances that share one scaled part close together, or split them into separate parts.
7. **Loop seams.**
   - *Symptom:* a pop at the clip boundary, for example from the resheath, the attack elbow pole target or the mech
     landing.
   - *Fix:* every periodic term uses whole cycles per loop: orbits, waves, spins and wheel revolutions. Phase ramps
     move in multiples of 2π, and IK pole targets must also be periodic.
   - `validate` compares `pose(0)` against `pose(duration)` (`LOOP_SEAM` when the difference exceeds 1e-3 voxel). The
     assets suites measured 0.004–0.019 voxel and 1.4e-5.
8. **Flipped-cloth ground contact.** Capes and robes with local `+Z` down get wave and shear at the hem, so a forward
   lean can push the hem below `z = 0`. Add a hem guard that lifts the body. The tail tip on the drake needed a ground
   clamp for the same reason.
9. **AO bake reads beyond its padding.**
   - AO windows reach 3 voxels, but `PAD = 2`.
   - The JS core's `computeNormalAndAO` keeps a **shared scratch buffer** sized for the largest grid seen so far.
     When a smaller part has voxels in its top layer, the reads past `total` pick up **stale occupancy** from an earlier,
     larger grid.
   - Repro (reference implementation's QA suite): a stale-scratch read repro shows 56 bytes differing,
     with AO off by up to 63 of 255.
   - Fresh contexts are deterministic, and `svox_cli.py` treats out-of-range as empty, so it is byte-identical to a
     fresh JS context.
   - *Fix for ports:* treat out-of-range as empty, or use `PAD = 3`.
10. **AO bake is in part-local space.** "Ground below `z = 0`" and the sky bias assume local `+Z` is up. For flipped
    cloth the mount row (local `z = 0`) receives ground occlusion, which hides under the shoulders. Re-orient before
    baking if a flipped part's mount edge is visible from above.
11. **Ground shadows double-darken where parts overlap.** Every part's shadow fragment writes the depth of the exact
    pixel-ray/ground intersection, and the pass uses `depthFunc(LESS)`. Identical depth means the first part wins.
12. **GL state leaks between renderers sharing a context.** Unbind the samplers (`bindSampler(unit, null)`), the 3D
    and 2D textures, the VAO and the program. Reset scissor, cull, blend and `drawBuffers`. A capture that ran the hybrid
    renderer first, then three other renderers on the same context, verified this.
13. **Brim versus eyes at 33°.** Faces 2–3 voxels under a wide brim vanish at the default pitch. Set the brim back,
    tilt the hat about 0.17 rad, and keep the eyes 1 voxel apart so a head turn does not hide one.
14. **Canvas PNG decode corrupts `normal_ao`.** A 2D canvas stores pixels premultiplied, so `getImageData` loses RGB
    precision wherever alpha is low, and in `normal_ao` the alpha channel is AO. The normal RGB is damaged in occluded
    crevices.
    - Decode PNG bytes yourself (zlib plus filters 0–4), as the QA runtime does with `DecompressionStream('deflate')`.
    - Or upload an `ImageBitmap` created with `premultiplyAlpha: 'none', colorSpaceConversion: 'none'` and
      `UNPACK_PREMULTIPLY_ALPHA_WEBGL = false`.
    - Our decoder matched Chrome's native decode on every opaque albedo texel, with 0 mismatches.

**v1.1 production pitfalls.** These were found while building a four-creature showcase, a 4-vehicle showroom and a
multi-world 60 fps daylight showcase, all on Three.js r187.

15. **Three.js `ColorManagement` gamma washout.**
    - *Symptom:* voxel albedo comes out washed out or shifted in hue, and decoded normals are bent, even though the
      shader is a verbatim port.
    - *Cause:* with `ColorManagement` on (the default), `THREE.Color` hex or CSS input and sRGB-tagged textures or
      targets are converted between sRGB and linear. T3 stores albedo and the `n·0.5+0.5` encoding as **raw bytes** and
      expects none of that, so any conversion on one side only double-converts them.
    - *Fix:* set `THREE.ColorManagement.enabled = false` before anything is created. Set
      `colorSpace: THREE.NoColorSpace` on the MRT `WebGLRenderTarget`, the composite targets and every
      `Data3DTexture`. Pass colours as `Vector3` uniforms
      ([webgl2_threejs.md §4.5](targets/webgl2_threejs.md#45-perspectivecamera--3d-world-mrt-hybrid-recipe-v11)).
16. **Default-argument `undefined` in emissive self-tests.**
    - *Symptom:* a probe of the default `emissiveStrength` reports 0, or NaN, instead of 0.9.
    - *Cause:* a patch spread such as `{ ...rig, emissiveStrength: undefined }` **keeps the key** and overrides the
      bundle's value. Hand-written parsers often treat `undefined`, `null` or `''` as numbers: `Number(null)` and
      `Number('')` are both `0`, which silently turns the glow off, and `Number(undefined)` is NaN.
    - *Fix:* when probing defaults, pass explicit fallback values, and resolve with
      `Number.isFinite(v) && v !== null && v !== '' ? clamp(v, 0, 1) : 0.9`. Assert `defaultStrength === 0.9` in the
      self-test ([02 §9](02_shader_pipeline_spec.md#9-v11-6-slot-emissive--post-glow-halo-contract)).
17. **Lossless 60 fps capture: ffmpeg VP8 `apad` queue overflow.**
    - *Symptom:* the raw RGBA frames are piped into two ffmpeg processes, H.264 MP4 and VP8 WebM. The VP8 pipe dies
      with `EPIPE`, and ffmpeg prints "No space left on device" even though 194 GB were free.
    - *Cause:* an infinite `-af apad` with `-shortest` lets the audio run ahead while the slower VP8 branch lags, which
      overflows ffmpeg's mux sync queue.
    - *Fix:* use a bounded `-af apad=whole_dur=<D>` and `-t <D>`, with `D` equal to frames ÷ 60 (27.25 s for 1,635
      frames). Make the frame sink reject writes to a closed pipe and log the ffmpeg exit codes. Always close the
      browser and server in `finally`. The recipe is in §3.
18. **Embedded browser video playback (Herdr, CEF, Electron).**
    - *Symptom:* the showcase `<video>` is black or will not seek inside an embedded browser pane, but plays in Chrome.
    - *Cause:* proprietary H.264/AAC decoders are often missing from CEF and Electron builds. Seeking also needs HTTP
      `206 Partial Content` Range responses, which naive static servers do not send.
    - *Fix:* ship **VP8 + Opus `.webm` as the first `<source>`**, with an H.264 `.mp4` fallback after it. Serve both
      with `Accept-Ranges: bytes`, `206` and `Content-Range` for `bytes=a-b` requests, and `416` for out-of-range
      requests.
19. **Blind procedural voxel sculpting versus the turnaround visual-diff loop.**
    - *Symptom:* SDF or code-only sculpting with no visual target gives flat, toy-like silhouettes: wrong proportions,
      oversized wheels, missing undercuts.
    - *Fix:*
      1. Anchor every non-trivial character or vehicle on a **3-view turnaround** (FRONT · SIDE · 3/4 HERO,
         MagicaVoxel style, nose-left). Generate it or have it supplied.
      2. Render the same 3-panel strip from the engine (`render_turnaround`, 1440×480).
      3. Run **at least 3 rounds** of `Read` visual diffs. Each round, open both images side by side, list the
         mismatches and fix the builder.
      4. Record every round. The four vehicles took 4–12 rounds each. One example: a 112-voxel F1 read as a toy at a wheel
         Ø of 22–24 until it was matched to the turnaround's ratio of length = 7.0 × wheel Ø.

## 2. The four mandatory QA gates

Run all four for every target and every new subject. Inspect a 33° and a 14° screenshot by eye as well. A gate that
was not run counts as failed.

### G1 — Low-pitch 14° zero-gap

- **Setup.** Render the full subject at pitch `14°` (0.2443 rad), and repeat at 33°. Use 12 yaws (every 30°) ×
  4 phases × every clip.
- **Measurement.**
  1. Read the G-buffer foreground mask (C1.a).
  2. Flood-fill background from the border. Background texels the fill cannot reach are **enclosed**.
  3. Re-trace each enclosed texel on the CPU along the exact pixel ray, with the same snapped camera and the inverse
     deform. Use the renderer's smooth criterion: trilinear alpha × `edgeMask`.
  4. A texel whose ray crosses alpha **≥ 0.75** is a **slice crack**. Otherwise it is a real see-through gap, such as
     the gap between two legs framed by a blade.
- **Negative control.** Punch 1-texel holes into a real silhouette. The classifier must flag every one.
- **Pass:** 0 cracks at 14° and 33°, and the control flags all of its holes.
- **Reference result:** 0 cracks over 192 renders. The 70 enclosed texels were all real gaps, with a maximum ray alpha
  of 0.469. The control flagged 6/6.

### G2 — Sub-texel pixel-snap: 0 px crawl

- **Setup.**
  1. Render a pose.
  2. Shift the root (every part matrix, its inverse and `rootOffset`) by less than half a virtual texel along camera
     right and up. The harness uses 0.3 and 0.25 texel, toward the texel centre.
  3. Render again and diff the output.
- **Pass:** **0 changed pixels** with `usePixelSnap`, and more than 0 with it off (the control). Test at 33° and 14°,
  and with ground shadows on.
- **Reference result:** 0/0/0 px with snap on, against 9,356–13,648 (GTX 1080) and 15,417–21,412 (SwiftShader) with
  it off.

### G3 — `undeform(deform(p))` < 1e-5

- **Setup.** At least 200 samples: random points inside each part's box, with deforms drawn from the bundle's own clips
  at random times. `svox_cli.py validate` does this with a fixed LCG seed. Also test random deforms over
  shear ±0.4, twist ±1, squash 0.6–1.4, wave ±1, frequency 0–8.
- **Pass:** max error < 1e-5, with no `squashZ = 0` anywhere. The GPU inverse must be the same formula.
- **Reference result:** 9.9e-16 (`validate`, 200 samples), 1.8e-15 (browser, 400), and under 1e-5 over 2,000 random
  deforms in Python.

### G4 — Ground / loop / occlusion integrity

- **Ground.** In the rest pose, the lowest solid-voxel corner lies within `|z| ≤ 0.5`. A value below −0.5 is
  `GROUND_PENETRATION`; above 0.5 is `FLOATING`. No clip sample, at 17 per clip, may dip below −0.5.
- **Loop.** `pose(0)` and `pose(duration)` give the same world positions to within 1e-3 voxel.
- **Occlusion.**
  - Rendering with the part draw order **reversed** must change **0 px**, which proves exact per-sample
    `gl_FragDepth`.
  - Turning the z-buffer off must change more than 0 px, which proves the parts actually overlap in the test views.
- **Reference result:** rest lowest z 0.000, seam 2e-15, 0 px reorder difference against 2,538–9,882 px with the
  z-buffer off.

### How the reference harness runs it (WebGL2)

These scripts belong to the reference implementation's QA project:
- `node harness/smoke_render.mjs [--backend d3d11|swiftshader]` serves the workspace and drives
  headless Chrome over CDP. It loads `assets/minimal_reference` into the real `HybridRenderer` and writes
  `minimal_reference_t3.png` plus `smoke_results.json`: the gates, 0 JS/GL errors, timing, and a PNG-decoder
  cross-check against the browser's native decoder.
- `python tests/test_skill_svox.py` runs every CLI test, the JS-parity bake check, the docs and link checks, and that
  smoke render.

## 3. Extended multi-part verification notes (v1.1)

Run these on top of G1–G4 for rigs with more than about 10 parts, for emissive rigs, and for video showcases.

**1,536-pose occlusion sweep.**
- Poses: 4 subjects × {solo, grid} × 3 clips × 8 phases × 4 yaws × {14°, 33°} = 1,536.
- Render each pose in normal and in reversed part order, and diff the two.
- Count a diff as a defect only if it **reproduces on a second render pair**. One-off pixels are reported as noise.
- Compare inside the silhouette. Get the silhouette mask from the `normals` and `slices` debug renders: their differing
  pixels are the subject plus its 1 px outline.
- **Pass:** 0 px.
- The plain epsilon bias failed this sweep in 40 of 1,536 renders, and the D24 bucket tie-break passes it
  ([02 §8](02_shader_pipeline_spec.md#8-v11-d24-depth-bucket-tie-break-udepthslot--udepthslots)).
- Also check that every frame keeps at least 6 px of margin on all four viewport edges. This validates multi-clip
  framing ([01 §9](01_contract_and_math.md#9-multi-clip-framing--hard-surface--mechanical-rigging)).

**6-slot emissive self-test.**
- Per slot k = 0…5, the slot must glow by more than 0 px against the baseline.
- `count == 6` and `strength == 0.9`.
- A 7th colour is ignored, with 0 glow px.
- A malformed entry is dropped.
- A missing strength resolves to 0.9.
- `glError == 0`.
- The procedure is in [02 §9](02_shader_pipeline_spec.md#9-v11-6-slot-emissive--post-glow-halo-contract).

**Loop continuity with motion plugins.** Import each plugin and compare `pose(T·(1 − 1e-6))` with `pose(0)`, springs
off. Also require real motion at half the period, so a trivial seam cannot pass. Compare `wavePhase` modulo 2π.

**Lossless 60 fps capture (CDP → raw RGBA → ffmpeg).**
- No `MediaRecorder` and no wall clock.
- The page renders frame `i` at `t = i / 60` and POSTs the raw RGBA composite to a local endpoint. The endpoint
  streams it into both encoders' stdin.

```
ffmpeg -f rawvideo -pix_fmt rgba -s 1920x1080 -r 60 -i pipe:0 -i bgm.mp3 -map 0:v:0 -map 1:a:0 \
  -c:v libx264 -preset medium -crf 15 -pix_fmt yuv420p -r 60 \
  -af apad=whole_dur=27.25 -c:a aac -b:a 192k -t 27.25 -movflags +faststart out.mp4
ffmpeg -f rawvideo -pix_fmt rgba -s 1920x1080 -r 60 -i pipe:0 -i bgm.mp3 -map 0:v:0 -map 1:a:0 \
  -c:v libvpx -quality good -cpu-used 2 -crf 6 -b:v 22M -qmin 0 -qmax 36 -auto-alt-ref 0 -pix_fmt yuv420p -r 60 \
  -af apad=whole_dur=27.25 -c:a libopus -b:a 160k -t 27.25 out.webm
```

- Verify with `ffprobe -count_frames`: exactly frames ÷ 60 s and 1,635/1,635 frames in both files.
- Build a 4×4 contact sheet with `-vf tile=4x4` and **inspect it by eye**.
- Reference run, a multi-world 60 fps daylight showcase: glError 0, 0 console or page errors, at most 46 draw calls. It encoded in 131.8 s
  at 16:9 and 96.3 s at 9:16.
