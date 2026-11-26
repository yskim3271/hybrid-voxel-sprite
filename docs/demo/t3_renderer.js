// t3_renderer.js — pure Three.js (r187) T3 hybrid articulated voxel renderer (GitHub Pages live demo copy).
// Demo additions: debugView 'stack' (SPRITE STACK via the ported marchStack) and per-mode studio backdrops (uMode).
// Adapted from sasin_threejs Style D v2: identical pipeline, D24 depth-bucket tie-break and obsidian pedestal;
// emissive palette widened to 6 slots (rig.emissiveColors ≤ 6, default strength 0.90).
//
// Follows hybrid-voxel-sprite references/02_shader_pipeline_spec.md and targets/webgl2_threejs.md §4:
//   PASS 1  low-res MRT G-buffer  WebGLRenderTarget(fw, fh, { count: 2, depthTexture: DepthTexture(UnsignedIntType) })
//           renderOrder 0 clear · 1 ground grid · 100+i ground shadows · 1000+i part OBB raymarch
//   PASS 2  full-res NEAREST texelFetch blit + 1px depth/normal outline, viewport + scissor per subject.
// Each Subject owns its scene, materials and render target, so any number of viewports (2×2 grid or solo)
// render back-to-back on one WebGLRenderer without sharing mutable GL state.

import * as THREE from 'three';
import * as SH from './t3_shaders.js';
import { deformPoint, undeformPointGPU, isIdentityDeform, isAffineDeform, clamp, cameraBasis, ORTHO_HEIGHT } from './math_svox.js';

THREE.ColorManagement.enabled = false; // all colours are raw Vector3 uniforms; no sRGB conversion anywhere

export const DEFAULT_OPTIONS = Object.freeze({
  raymarchSmooth: false,  // Crisp DDA (Style D stepped micro-voxels) by default; Smooth iso (LINEAR) is one toggle away
  useDeform: true,
  useSpring: true,
  celBands: 4,            // 0 = smooth shading, 2..8 = cel bands
  lit: true,
  useAO: true,
  selfShadow: true,
  rim: true,
  groundShadow: true,
  contactShadow: true,
  usePixelSnap: true,     // off → ps = 1 and no camera/root snap (02 §1)
  pixelScale: 2,          // ×2: 64–110 vx hard-surface vehicles keep their panel lines even in the 2×2 grid
  outline: true,
  floor: true,            // obsidian pedestal + contact shadow (turnaround renders switch it off)
  debugView: 'final',     // final | normals | depth | ao | slices
  useZBuffer: true,
  reverseOrder: false,
  snapTieBias: 1e-6,      // webgl2_threejs.md §4.2 half-texel tie fix
});
const DEBUG_CODES = { final: 0, normals: 1, depth: 2, ao: 3, slices: 4, stack: 5 }; // demo: 'stack' = SPRITE STACK
// Apollo matte-obsidian studio backdrop (refs/turnarounds/*.jpg)
export const BG_HEX = '#0f131a';
const BG = new THREE.Vector3(0.059, 0.075, 0.102);       // #0f131a
const BG_TOP = new THREE.Vector3(0.078, 0.102, 0.141);   // #141a24

/** Parse '#rrggbb' → [r,g,b] in 0..1 (null when malformed). */
export function hexToRgb01(h) {
  if (typeof h !== 'string' || !/^#?[0-9a-fA-F]{6}$/.test(h.trim())) return null;
  const n = parseInt(h.trim().replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
export const EMISSIVE_SLOTS = 6;
export const EMISSIVE_DEFAULT_STRENGTH = 0.9;
/** Optional rig.json emissive fields → { cols: Vector3[6], count, strength, hex } (zero-change defaults when absent). */
function emissiveSpec(rig) {
  const raw = Array.isArray(rig && rig.emissiveColors) ? rig.emissiveColors : [];
  const valid = raw.filter((h) => hexToRgb01(h)).slice(0, EMISSIVE_SLOTS);       // malformed entries are ignored
  const rgb = valid.map(hexToRgb01);
  const cols = Array.from({ length: EMISSIVE_SLOTS }, (_, i) => (rgb[i] ? new THREE.Vector3(...rgb[i]) : new THREE.Vector3(-10, -10, -10)));
  const st = Number(rig && rig.emissiveStrength);
  return { cols, count: rgb.length, hex: valid.map((h) => `#${h.trim().replace('#', '').toLowerCase()}`), strength: Number.isFinite(st) && rig.emissiveStrength !== null && rig.emissiveStrength !== '' ? clamp(st, 0, 1) : EMISSIVE_DEFAULT_STRENGTH };
}

const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

/** snapToTexel(VP, a) → NDC delta that puts world point a on a virtual-texel centre (02 §1). */
export function snapToTexel(VP, a, fw, fh, bias = 1e-6) {
  const e = VP.elements;
  const px = e[0] * a[0] + e[4] * a[1] + e[8] * a[2] + e[12];
  const py = e[1] * a[0] + e[5] * a[1] + e[9] * a[2] + e[13];
  const pw = e[3] * a[0] + e[7] * a[1] + e[11] * a[2] + e[15];
  const sx = ((px / pw) + 1) * 0.5 * fw - 0.5, sy = ((py / pw) + 1) * 0.5 * fh - 0.5;
  return [(Math.round(sx + bias) - sx) * 2 / fw, (Math.round(sy + bias) - sy) * 2 / fh, sx, sy];
}

/** Proxy box in deformed part-local space (02 §1). */
export function deformedBounds(size, pivot, d) {
  if (isIdentityDeform(d)) {
    return { min: [-pivot[0] - 0.5, -pivot[1] - 0.5, -pivot[2] - 0.5], max: [size[0] - pivot[0] + 0.5, size[1] - pivot[1] + 0.5, size[2] - pivot[2] + 0.5] };
  }
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  const xs = [-pivot[0], size[0] - pivot[0]], ys = [-pivot[1], size[1] - pivot[1]];
  for (let k = 0; k <= 12; k++) {
    const lz = -pivot[2] + size[2] * k / 12;
    for (const x of xs) for (const y of ys) {
      const p = deformPoint([x, y, lz], d, size[2], pivot[2]);
      for (let i = 0; i < 3; i++) { if (p[i] < mn[i]) mn[i] = p[i]; if (p[i] > mx[i]) mx[i] = p[i]; }
    }
  }
  const pxy = 1.25 + 0.5 * Math.abs(d.twistZ || 0);
  return { min: [mn[0] - pxy, mn[1] - pxy, mn[2] - 1], max: [mx[0] + pxy, mx[1] + pxy, mx[2] + 1] };
}

function makeVolumeTexture(bytes, size, filter) {
  const t = new THREE.Data3DTexture(bytes, size[0], size[1], size[2]);
  t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = filter;
  t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
  t.unpackAlignment = 1; t.flipY = false; t.generateMipmaps = false; t.premultiplyAlpha = false;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

// bundle.parts → per-part textures (shared by every subject using the bundle, incl. shallow { ...bundle, rig } copies
// such as the emissive self-test, so a scratch subject never re-uploads the volumes)
const texCache = new WeakMap();
function bundleTextures(bundle) {
  if (texCache.has(bundle.parts)) return texCache.get(bundle.parts);
  const tex = bundle.parts.map((p) => ({
    lin: makeVolumeTexture(p.albedo, p.size, THREE.LinearFilter),
    near: makeVolumeTexture(p.albedo, p.size, THREE.NearestFilter),
    nao: makeVolumeTexture(p.normalAo, p.size, THREE.NearestFilter),
  }));
  texCache.set(bundle.parts, tex);
  return tex;
}

function rawMat(vert, frag, uniforms, extra = {}) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: vert, fragmentShader: frag, uniforms,
    transparent: false, // P5: transparent meshes ignore renderOrder against opaque ones
    ...extra,
  });
}

// =============================================================================================== Subject
export class Subject {
  constructor(t3, bundle, { accent = [0.5, 0.8, 0.8], name = 'subject', footprint = null } = {}) {
    this.t3 = t3; this.bundle = bundle; this.name = name;
    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = true;
    this.rt = null; this.fw = 0; this.fh = 0;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -200, 200);
    this.cam.matrixAutoUpdate = false; this.cam.matrixWorldAutoUpdate = false;
    this.accent = new THREE.Vector3(...accent);
    this.last = null;

    const quad = t3.geo.quad2, unitQuad = t3.geo.unitQuad, box = t3.geo.box;
    this.clearUniforms = { uBg: { value: BG.clone() }, uBgTop: { value: BG_TOP.clone() }, uViewport: { value: new THREE.Vector4() }, uMode: { value: 0 } };
    const clearMat = rawMat(SH.FULLSCREEN_VERT, SH.CLEAR_FRAG, this.clearUniforms, {
      depthTest: true, depthFunc: THREE.AlwaysDepth, depthWrite: true, blending: THREE.NoBlending,
    });
    this.clearMesh = new THREE.Mesh(quad, clearMat);
    this.clearMesh.renderOrder = 0; this.clearMesh.frustumCulled = false;
    this.scene.add(this.clearMesh);

    this.gridUniforms = {
      uInvViewProj: { value: new THREE.Matrix4() }, uViewport: { value: new THREE.Vector4() },
      uAccent: { value: this.accent }, uRoot: { value: new THREE.Vector3() }, uContactR: { value: new THREE.Vector2(4, 4) },
      uContactA: { value: 0.32 }, uRadius: { value: 34 }, uPedH: { value: 3 }, uMode: { value: 0 },
    };
    const gridMat = rawMat(SH.FULLSCREEN_VERT, SH.GRID_FRAG, this.gridUniforms, {
      depthTest: false, depthWrite: false, blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.gridMesh = new THREE.Mesh(quad, gridMat);
    this.gridMesh.renderOrder = 1; this.gridMesh.frustumCulled = false;
    this.scene.add(this.gridMesh);

    const tex = bundleTextures(bundle);
    let depthSlots = 16; while (depthSlots < bundle.parts.length) depthSlots *= 2; // exact depth tie-break slots (PART_FRAG)
    this.emissive = emissiveSpec(bundle.rig);
    this.parts = bundle.parts.map((p, i) => {
      const pe = Number(p.rigPart && p.rigPart.emissive);
      const u = {
        uInvViewProj: { value: new THREE.Matrix4() }, uViewProj: { value: new THREE.Matrix4() }, uViewport: { value: new THREE.Vector4() },
        uModel: { value: new THREE.Matrix4() }, uInvModel: { value: new THREE.Matrix4() },
        uVol: { value: tex[i].lin }, uNao: { value: tex[i].nao },
        uSize: { value: v3(p.size) }, uPivot: { value: v3(p.pivot) },
        uBoxMin: { value: new THREE.Vector3() }, uBoxMax: { value: new THREE.Vector3() },
        uDefA: { value: new THREE.Vector4(0, 0, 0, 1) }, uDefB: { value: new THREE.Vector4() },
        uSmooth: { value: 1 }, uAffine: { value: 1 },
        uL: { value: new THREE.Vector3(0, 0, 1) }, uLightColor: { value: new THREE.Vector3(1, 0.95, 0.86) }, uAmbient: { value: 0.34 },
        uSky: { value: new THREE.Vector3() }, uGround: { value: new THREE.Vector3() }, uShadowTint: { value: new THREE.Vector3() },
        uHiTint: { value: new THREE.Vector3() }, uRimColor: { value: new THREE.Vector3() }, uRimStrength: { value: 0.45 },
        uHeightOccSpan: { value: 7 }, uPartEmissive: { value: Number.isFinite(pe) ? clamp(pe, 0, 1) : 0 },
        uEmissiveCount: { value: this.emissive.count }, uEmissiveCols: { value: this.emissive.cols }, uEmissiveStrength: { value: this.emissive.strength },
        uDepthSlot: { value: i }, uDepthSlots: { value: depthSlots }, uVehH: { value: 24 }, uLit: { value: 1 }, uBands: { value: 4 }, uUseAO: { value: 1 }, uSelfShadow: { value: 1 }, uRim: { value: 1 }, uDebug: { value: 0 },
      };
      const partMat = rawMat(SH.PART_VERT, SH.PART_FRAG, u, {
        side: THREE.BackSide, depthTest: true, depthWrite: true, depthFunc: THREE.LessEqualDepth, blending: THREE.NoBlending,
      });
      const mesh = new THREE.Mesh(box, partMat);
      mesh.matrixAutoUpdate = false; mesh.frustumCulled = false; mesh.renderOrder = 1000 + i;
      // shadow shares every uniform object by reference, but always samples the LINEAR copy (02 §3)
      const su = { ...u, uVol: { value: tex[i].lin }, uRectMin: { value: new THREE.Vector2() }, uRectMax: { value: new THREE.Vector2() } };
      const shadowMat = rawMat(SH.SHADOW_VERT, SH.SHADOW_FRAG, su, {
        side: THREE.DoubleSide, depthTest: true, depthWrite: true, depthFunc: THREE.LessDepth,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
        blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      });
      const smesh = new THREE.Mesh(unitQuad, shadowMat);
      smesh.frustumCulled = false; smesh.renderOrder = 100 + i;
      this.scene.add(smesh); this.scene.add(mesh);
      return { def: p, index: i, u, su, mesh, smesh, partMat, shadowMat, tex: tex[i] };
    });
    this.partByName = new Map(this.parts.map((q) => [q.def.name, q]));
    // floor + contact-shadow scale from the rest footprint
    let ext = 0; for (const p of bundle.parts) ext = Math.max(ext, p.size[0], p.size[1], p.size[2]);
    this.extent = ext;
    this.setFootprint(footprint);
  }

  /**
   * Vehicle footprint → pedestal radius, contact-shadow ellipse, heightOcc span and crease threshold.
   * R = xy radius of the clip-union framing box, hz = its height (world voxels). Falls back to the largest part size.
   */
  setFootprint(fp) {
    const R = fp && fp.R > 0 ? fp.R : this.extent * 0.6;
    const hz = fp && fp.hz > 0 ? fp.hz : this.extent;
    const span = Math.max(hz, 2 * R);
    this.footprint = {
      R, hz, span,
      radius: Math.max(12, R * 0.98),                     // pedestal disc radius (≈ framing footprint → stays in frame)
      pedH: clamp(R * 0.07, 1.5, 5),                      // pedestal side height
      contactR: Math.max(3, R * 0.42),                    // contact-shadow ellipse (x; y = 0.8x)
      heightOccSpan: Math.max(7.0, hz * 0.22),
      creaseThresh: span <= 48 ? 1.75 : span > 56 ? 2.25 : 1.75 + 0.5 * (span - 48) / 8,
    };
    for (const sp of this.parts || []) { sp.u.uHeightOccSpan.value = this.footprint.heightOccSpan; sp.u.uVehH.value = hz; }
    return this.footprint;
  }

  ensureTarget(fw, fh) {
    if (this.rt && this.fw === fw && this.fh === fh) return;
    if (this.rt) { this.rt.depthTexture && this.rt.depthTexture.dispose(); this.rt.dispose(); }
    this.rt = new THREE.WebGLRenderTarget(fw, fh, {
      count: 2, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
      depthBuffer: true, stencilBuffer: false, depthTexture: new THREE.DepthTexture(fw, fh, THREE.UnsignedIntType),
      colorSpace: THREE.NoColorSpace, type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
    });
    this.fw = fw; this.fh = fh;
  }

  dispose() {
    if (this.rt) { this.rt.depthTexture && this.rt.depthTexture.dispose(); this.rt.dispose(); this.rt = null; }
    this.clearMesh.material.dispose(); this.gridMesh.material.dispose();
    for (const p of this.parts) { p.partMat.dispose(); p.shadowMat.dispose(); }
  }
}

// =============================================================================================== renderer
export class T3Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance',
      depth: true, stencil: false,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.autoClear = false;
    this.renderer.sortObjects = true;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.gl = this.renderer.getContext();
    this.geo = {
      quad2: new THREE.PlaneGeometry(2, 2),
      unitQuad: new THREE.PlaneGeometry(1, 1).translate(0.5, 0.5, 0),
      box: new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5),
    };
    this.postUniforms = {
      tColor: { value: null }, tNormal: { value: null }, tDepth: { value: null },
      uRT: { value: new THREE.Vector2(1, 1) }, uOrigin: { value: new THREE.Vector2() }, uPS: { value: 3 },
      uOutline: { value: 1 }, uDarkness: { value: 0.62 }, uCreaseThresh: { value: 1.75 }, uDepthScale: { value: 1 }, uDepthRef: { value: 0.5 },
      uL: { value: new THREE.Vector3(0, 0, 1) }, uDebug: { value: 0 },
    };
    const postMat = rawMat(SH.FULLSCREEN_VERT, SH.POST_FRAG, this.postUniforms, { depthTest: false, depthWrite: false, blending: THREE.NoBlending });
    this.postScene = new THREE.Scene();
    this.postMesh = new THREE.Mesh(this.geo.quad2, postMat);
    this.postMesh.frustumCulled = false;
    this.postScene.add(this.postMesh);
    this.postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.stats = { drawCalls: 0, frames: 0 };
  }

  get revision() { return THREE.REVISION; }

  setSize(w, h) { this.renderer.setSize(w, h, false); }

  /** Clears the whole canvas (gaps between viewports). */
  clearCanvas(rgb = [0.047, 0.059, 0.082]) {   // a shade below BG #0f131a: gaps between grid cells
    const r = this.renderer;
    r.setRenderTarget(null);
    r.setScissorTest(false);
    r.setClearColor(new THREE.Color(rgb[0], rgb[1], rgb[2]), 1);
    r.clear(true, true, false);
  }

  createSubject(bundle, opts) { return new Subject(this, bundle, opts); }

  /**
   * Render one subject into rect (canvas pixels, origin bottom-left).
   * frame = { yaw, pitch, zoom, target:[3], light, pose, options, rootShift? }
   */
  render(subject, frame, rect) {
    const r = this.renderer;
    const o = { ...DEFAULT_OPTIONS, ...(frame.options || {}) };
    const snap = !!o.usePixelSnap;
    const ps = snap ? clamp(Math.round(o.pixelScale), 1, 8) : 1;
    const fw = Math.max(1, Math.floor(rect.w / ps)), fh = Math.max(1, Math.floor(rect.h / ps));
    subject.ensureTarget(fw, fh);
    const bias = o.snapTieBias ?? 1e-6;

    // ---- camera (01 §1) through an internal camera whose matrices we own
    const target = frame.target || [0, 0, 9];
    const { dir, forward, right, up } = cameraBasis(frame.yaw ?? 0, frame.pitch ?? 0.58);
    const eye = [target[0] + dir[0] * 100, target[1] + dir[1] * 100, target[2] + dir[2] * 100];
    const cam = subject.cam;
    cam.matrixWorld.makeBasis(v3(right), v3(up), v3([-forward[0], -forward[1], -forward[2]])).setPosition(eye[0], eye[1], eye[2]);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const halfH = ORTHO_HEIGHT / (frame.zoom || 1) / 2, halfW = halfH * (rect.w / rect.h);
    cam.projectionMatrix.makeOrthographic(-halfW, halfW, halfH, -halfH, -200, 200);
    const VP0 = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    if (snap) {
      const dn = snapToTexel(VP0, [0, 0, 0], fw, fh, bias);
      cam.projectionMatrix.elements[12] += dn[0];
      cam.projectionMatrix.elements[13] += dn[1];
    }
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    const VP = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const invVP = VP.clone().invert();
    const e = VP.elements;

    // ---- pose + optional QA root shift (every matrix and rootOffset)
    const pose = frame.pose;
    const shift = frame.rootShift || [0, 0, 0];
    const rootOffset = [pose.rootOffset[0] + shift[0], pose.rootOffset[1] + shift[1], pose.rootOffset[2] + shift[2]];
    let rootDelta = [0, 0, 0];
    if (snap) {
      const dr = snapToTexel(VP, rootOffset, fw, fh, bias);
      const sx = Math.hypot(e[0], e[4], e[8]), sy = Math.hypot(e[1], e[5], e[9]);
      const R = [e[0] / sx, e[4] / sx, e[8] / sx], U = [e[1] / sy, e[5] / sy, e[9] / sy];
      for (let k = 0; k < 3; k++) rootDelta[k] = R[k] * dr[0] / sx + U[k] * dr[1] / sy;
    }
    const totalShift = [shift[0] + rootDelta[0], shift[1] + rootDelta[1], shift[2] + rootDelta[2]];
    const Tshift = new THREE.Matrix4().makeTranslation(totalShift[0], totalShift[1], totalShift[2]);

    // ---- light
    const light = frame.light;
    const L = light.dir;
    const lc = light.color.map((c) => c * (light.intensity ?? 1));
    const debug = DEBUG_CODES[o.debugView] ?? 0;
    const viewport = new THREE.Vector4(0, 0, fw, fh);
    const n = subject.parts.length;
    const lastParts = [];

    for (const sp of subject.parts) {
      const pp = pose.parts[sp.def.name];
      const M = new THREE.Matrix4().fromArray(pp.matrix);
      const Mp = new THREE.Matrix4().multiplyMatrices(Tshift, M);
      const invMp = Mp.clone().invert();
      const d = pp.deform;
      const box = deformedBounds(sp.def.size, sp.def.pivot, d);
      const affine = isAffineDeform(d);
      const u = sp.u;
      u.uInvViewProj.value.copy(invVP); u.uViewProj.value.copy(VP); u.uViewport.value.copy(viewport);
      u.uModel.value.copy(Mp); u.uInvModel.value.copy(invMp);
      u.uBoxMin.value.set(...box.min); u.uBoxMax.value.set(...box.max);
      u.uDefA.value.set(d.shearX, d.shearY, d.twistZ, d.squashZ);
      u.uDefB.value.set(d.waveAmpX, d.waveAmpY, d.waveFreq, d.wavePhase);
      u.uSmooth.value = o.raymarchSmooth ? 1 : 0;
      u.uAffine.value = affine ? 1 : 0;
      u.uVol.value = o.raymarchSmooth ? sp.tex.lin : sp.tex.near;
      u.uL.value.set(L[0], L[1], L[2]); u.uLightColor.value.set(lc[0], lc[1], lc[2]); u.uAmbient.value = light.ambient;
      u.uSky.value.set(...light.sky); u.uGround.value.set(...light.ground); u.uShadowTint.value.set(...light.shadowTint);
      u.uHiTint.value.set(...light.highlightTint); u.uRimColor.value.set(...light.rimColor); u.uRimStrength.value = light.rimStrength;
      u.uLit.value = o.lit ? 1 : 0; u.uBands.value = o.celBands; u.uUseAO.value = o.useAO ? 1 : 0;
      u.uSelfShadow.value = o.selfShadow ? 1 : 0; u.uRim.value = o.rim ? 1 : 0; u.uDebug.value = debug;
      u.uHeightOccSpan.value = subject.footprint.heightOccSpan;
      sp.partMat.depthTest = !!o.useZBuffer; sp.partMat.depthWrite = !!o.useZBuffer;
      sp.mesh.matrix.copy(Mp); sp.mesh.matrixWorldNeedsUpdate = true;
      sp.mesh.renderOrder = 1000 + (o.reverseOrder ? n - 1 - sp.index : sp.index);
      sp.partMat.uniformsNeedUpdate = true;

      // ground shadow rect: 8 proxy corners through M', projected along the light onto z = 0 (02 §3)
      sp.smesh.visible = !!o.groundShadow;
      if (o.groundShadow) {
        const Lz = Math.max(L[2], 0.12);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        const c = new THREE.Vector3();
        for (let k = 0; k < 8; k++) {
          c.set(k & 1 ? box.max[0] : box.min[0], k & 2 ? box.max[1] : box.min[1], k & 4 ? box.max[2] : box.min[2]).applyMatrix4(Mp);
          const z = Math.max(c.z, 0);
          const gx = c.x - L[0] / Lz * z, gy = c.y - L[1] / Lz * z;
          x0 = Math.min(x0, gx, c.x); y0 = Math.min(y0, gy, c.y); x1 = Math.max(x1, gx, c.x); y1 = Math.max(y1, gy, c.y);
        }
        sp.su.uRectMin.value.set(x0 - 1, y0 - 1); sp.su.uRectMax.value.set(x1 + 1, y1 + 1);
        sp.shadowMat.uniformsNeedUpdate = true;
      }
      lastParts.push({ name: sp.def.name, size: sp.def.size, pivot: sp.def.pivot, albedo: sp.def.albedo, M: Mp.clone(), invM: invMp, deform: { ...d }, box });
    }

    // ---- clear + grid uniforms
    this.clearUnis(subject, viewport);
    subject.clearUniforms.uMode.value = debug;
    const g = subject.gridUniforms;
    g.uInvViewProj.value.copy(invVP); g.uViewport.value.copy(viewport);
    g.uRoot.value.set(rootOffset[0] + rootDelta[0], rootOffset[1] + rootDelta[1], 0);
    const fp = subject.footprint;
    g.uContactR.value.set(fp.contactR, fp.contactR * 0.8);
    g.uContactA.value = o.contactShadow ? 0.34 : 0;
    g.uRadius.value = fp.radius; g.uPedH.value = fp.pedH; g.uMode.value = debug;
    subject.gridMesh.visible = o.floor !== false;

    // ---- PASS 1
    r.setRenderTarget(subject.rt);
    r.setScissorTest(false);
    r.setViewport(0, 0, fw, fh);
    r.render(subject.scene, cam);
    let calls = r.info.render.calls;

    // ---- PASS 2: blit into an integer-scaled, centred viewport inside rect
    const bw = fw * ps, bh = fh * ps;
    const bx = rect.x + Math.floor((rect.w - bw) / 2), by = rect.y + Math.floor((rect.h - bh) / 2);
    const zs = Math.hypot(e[2], e[6], e[10]);
    const tv = new THREE.Vector4(target[0], target[1], target[2], 1).applyMatrix4(VP);
    const pu = this.postUniforms;
    pu.tColor.value = subject.rt.textures[0]; pu.tNormal.value = subject.rt.textures[1]; pu.tDepth.value = subject.rt.depthTexture;
    pu.uRT.value.set(fw, fh); pu.uOrigin.value.set(bx, by); pu.uPS.value = ps;
    pu.uOutline.value = o.outline ? 1 : 0; pu.uDepthScale.value = 2 / zs; pu.uDepthRef.value = 0.5 * (tv.z / tv.w) + 0.5;
    pu.uL.value.set(L[0], L[1], L[2]); pu.uDebug.value = debug; pu.uCreaseThresh.value = subject.footprint.creaseThresh;
    this.postMesh.material.uniformsNeedUpdate = true;
    r.setRenderTarget(null);
    r.setViewport(bx, by, bw, bh);
    r.setScissor(bx, by, bw, bh);
    r.setScissorTest(true);
    r.render(this.postScene, this.postCam);
    r.setScissorTest(false);
    calls += r.info.render.calls;
    this.stats.drawCalls = calls;

    subject.last = {
      fw, fh, ps, VP: VP.clone(), invVP, rect: { ...rect }, blit: { x: bx, y: by, w: bw, h: bh },
      rootOffset, rootDelta, parts: lastParts, options: o, drawCalls: calls,
      camera: { right, up, forward },
    };
    return subject.last;
  }

  clearUnis(subject, viewport) { subject.clearUniforms.uViewport.value.copy(viewport); }

  // ------------------------------------------------------------------------------------------- QA read-backs
  /** G-buffer foreground mask (C1, textureIndex 1) → Uint8Array fw*fh (1 = fg). */
  readMask(subject) {
    const { fw, fh } = subject;
    const buf = new Uint8Array(fw * fh * 4);
    this.renderer.readRenderTargetPixels(subject.rt, 0, 0, fw, fh, buf, undefined, 1);
    const m = new Uint8Array(fw * fh);
    for (let i = 0; i < fw * fh; i++) m[i] = buf[i * 4 + 3] > 127 ? 1 : 0;
    return m;
  }
  /** Canvas pixels of a rect (bottom-left origin) right after render(). */
  readCanvas(rect) {
    const gl = this.gl;
    const out = new Uint8Array(rect.w * rect.h * 4);
    this.renderer.setRenderTarget(null);
    gl.readPixels(rect.x, rect.y, rect.w, rect.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }
  /** 1×1 readPixels to close a timed frame (pitfall 2: gl.finish() does not block in Chrome). */
  syncPoint() { const px = new Uint8Array(4); this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, px); return px[0]; }
  glError() { return this.gl.getError(); }
}

// =============================================================================================== CPU re-trace (G1)
function sampleAlphaLinear(albedo, size, v) {
  const lo0 = clamp(v[0] + 0.5, 0, 1), lo1 = clamp(v[1] + 0.5, 0, 1), lo2 = clamp(v[2] + 0.5, 0, 1);
  const hi0 = clamp(size[0] + 0.5 - v[0], 0, 1), hi1 = clamp(size[1] + 0.5 - v[1], 0, 1), hi2 = clamp(size[2] + 0.5 - v[2], 0, 1);
  const em = lo0 * lo1 * lo2 * hi0 * hi1 * hi2;
  if (em <= 0) return 0;
  const [sx, sy, sz] = size;
  const fx = v[0] - 0.5, fy = v[1] - 0.5, fz = v[2] - 0.5;
  const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
  const tx = fx - ix, ty = fy - iy, tz = fz - iz;
  const X = [clamp(ix, 0, sx - 1), clamp(ix + 1, 0, sx - 1)], Y = [clamp(iy, 0, sy - 1), clamp(iy + 1, 0, sy - 1)], Z = [clamp(iz, 0, sz - 1), clamp(iz + 1, 0, sz - 1)];
  let a = 0;
  for (let k = 0; k < 8; k++) {
    const bx = k & 1, by = (k >> 1) & 1, bz = (k >> 2) & 1;
    const w = (bx ? tx : 1 - tx) * (by ? ty : 1 - ty) * (bz ? tz : 1 - tz);
    if (w === 0) continue;
    a += w * albedo[((Z[bz] * sy + Y[by]) * sx + X[bx]) * 4 + 3];
  }
  return (a / 255) * em;
}
function slabCPU(ro, rd, mn, mx) {
  let t0 = -Infinity, t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    const d = Math.abs(rd[k]) < 1e-7 ? 1e-7 : rd[k];
    const ta = (mn[k] - ro[k]) / d, tb = (mx[k] - ro[k]) / d;
    t0 = Math.max(t0, Math.min(ta, tb)); t1 = Math.min(t1, Math.max(ta, tb));
  }
  return t1 > t0 && t1 > 0 ? [Math.max(t0, 0), t1] : null;
}
/** Max smooth alpha (trilinear × edgeMask) along the exact pixel ray of G-buffer texel (ix, iy) of the last render. */
export function retraceMaxAlpha(last, ix, iy, step = 0.05) {
  const ndcX = (ix + 0.5) / last.fw * 2 - 1, ndcY = (iy + 0.5) / last.fh * 2 - 1;
  const a = new THREE.Vector4(ndcX, ndcY, -1, 1).applyMatrix4(last.invVP), b = new THREE.Vector4(ndcX, ndcY, 1, 1).applyMatrix4(last.invVP);
  const roW = new THREE.Vector3(a.x / a.w, a.y / a.w, a.z / a.w);
  const rdW = new THREE.Vector3(b.x / b.w, b.y / b.w, b.z / b.w).sub(roW).normalize();
  let best = 0;
  for (const p of last.parts) {
    const ro = roW.clone().applyMatrix4(p.invM);
    const rd = rdW.clone().transformDirection(p.invM); // transformDirection normalises
    const hit = slabCPU([ro.x, ro.y, ro.z], [rd.x, rd.y, rd.z], p.box.min, p.box.max);
    if (!hit) continue;
    for (let t = hit[0]; t <= hit[1]; t += step) {
      const q = [ro.x + rd.x * t, ro.y + rd.y * t, ro.z + rd.z * t];
      const u = undeformPointGPU(q, p.deform, p.size[2], p.pivot[2]);
      const al = sampleAlphaLinear(p.albedo, p.size, [u[0] + p.pivot[0], u[1] + p.pivot[1], u[2] + p.pivot[2]]);
      if (al > best) { best = al; if (best >= 0.999) return best; }
    }
  }
  return best;
}
/** Background texels not 4-connected to the border. */
export function enclosedTexels(mask, fw, fh) {
  const seen = new Uint8Array(fw * fh), stack = [];
  const push = (x, y) => { const i = y * fw + x; if (!mask[i] && !seen[i]) { seen[i] = 1; stack.push(i); } };
  for (let x = 0; x < fw; x++) { push(x, 0); push(x, fh - 1); }
  for (let y = 0; y < fh; y++) { push(0, y); push(fw - 1, y); }
  while (stack.length) {
    const i = stack.pop(), x = i % fw, y = (i / fw) | 0;
    if (x > 0) push(x - 1, y); if (x < fw - 1) push(x + 1, y); if (y > 0) push(x, y - 1); if (y < fh - 1) push(x, y + 1);
  }
  const out = [];
  for (let i = 0; i < fw * fh; i++) if (!mask[i] && !seen[i]) out.push(i);
  return out;
}
