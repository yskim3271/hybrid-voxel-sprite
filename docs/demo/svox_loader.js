// svox_loader.js (GitHub Pages demo copy) — loads `svox_cli.py pack-atlas --format raw_3d` bundles (+ rig.json) into CPU volumes.
//
// public_svox/<id>/manifest.json   schema svox.atlas/v1, format raw_3d
// public_svox/<id>/<part>.albedo.rgba8.bin, <part>.normal_ao.rgba8.bin   idx = ((z*sizeY + y)*sizeX + x)*4
// public_svox/<id>/rig.json        schema svox.rig/v1
//
// The raw_3d bins are already in texImage3D order, so they upload to THREE.Data3DTexture unchanged
// (webgl2_threejs.md §4.1). No PNG decode is involved, which sidesteps pitfall 14 (premultiplied canvas decode).

const cache = new Map();

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}
async function fetchBin(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Loads and validates one bundle directory (URL ending without slash, e.g. 'public_svox/excavator'). */
export async function loadBundle(baseUrl) {
  if (cache.has(baseUrl)) return cache.get(baseUrl);
  const p = (async () => {
    const [manifest, rig] = await Promise.all([fetchJSON(`${baseUrl}/manifest.json`), fetchJSON(`${baseUrl}/rig.json`)]);
    if (manifest.schema !== 'svox.atlas/v1' || manifest.format !== 'raw_3d') {
      throw new Error(`${baseUrl}: expected svox.atlas/v1 raw_3d manifest, got ${manifest.schema}/${manifest.format}`);
    }
    if (rig.schema !== 'svox.rig/v1') throw new Error(`${baseUrl}: expected svox.rig/v1 rig.json, got ${rig.schema}`);
    const rigParts = new Map(rig.parts.map((q) => [q.name, q]));
    const parts = await Promise.all(manifest.parts.map(async (e) => {
      const [sx, sy, sz] = e.size;
      const n = sx * sy * sz * 4;
      const albedo = await fetchBin(`${baseUrl}/${e.files.albedo.path}`);
      if (albedo.length !== n) throw new Error(`${baseUrl}/${e.name}: albedo ${albedo.length} B != ${sx}x${sy}x${sz}x4`);
      let normalAo;
      if (e.files.normal_ao) {
        normalAo = await fetchBin(`${baseUrl}/${e.files.normal_ao.path}`);
        if (normalAo.length !== n) throw new Error(`${baseUrl}/${e.name}: normal_ao size mismatch`);
      } else {
        normalAo = new Uint8Array(n);
        for (let i = 0; i < n; i += 4) { normalAo[i] = 128; normalAo[i + 1] = 128; normalAo[i + 2] = 255; normalAo[i + 3] = 255; }
      }
      const rp = rigParts.get(e.name);
      if (!rp) throw new Error(`${baseUrl}: manifest part '${e.name}' missing from rig.json`);
      let solid = 0;
      for (let i = 3; i < n; i += 4) if (albedo[i] > 127) solid++;
      return {
        name: e.name, size: [sx, sy, sz], pivot: (rp.pivot || e.pivot).map(Number), rigPart: rp,
        albedo, normalAo, solidCount: solid,
      };
    }));
    // keep rig.json part order (parent-first order is resolved by the evaluator)
    const order = new Map(rig.parts.map((q, i) => [q.name, i]));
    parts.sort((a, b) => order.get(a.name) - order.get(b.name));
    let voxels = 0; for (const q of parts) voxels += q.solidCount;
    return { baseUrl, rig, manifest, parts, voxels };
  })();
  cache.set(baseUrl, p);
  p.catch(() => cache.delete(baseUrl));
  return p;
}
