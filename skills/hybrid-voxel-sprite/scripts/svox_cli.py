#!/usr/bin/env python3
# /// script
# requires-python = ">=3.8"
# dependencies = []
# ///
"""svox_cli.py - engine-neutral SVOX asset pipeline for T3 hybrid voxel sprites.

Python 3 standard library only (no pip install):
    uv run scripts/svox_cli.py <command> ...      or      python scripts/svox_cli.py <command> ...

Commands
    init-demo      --out DIR                         minimal 3-part reference bundle (+ sample_cube.vox), baked
    from-vox       --input F.vox --out DIR [--part-name N] [--rotate-z180] [--bake]
    from-strip     --input S.png --size-x X --size-y Y --size-z Z --out DIR --part-name N [--pivot X,Y,Z] [--bake]
    bake-normal-ao --bundle DIR                      parts/<name>.normal_ao.png + bake_stats.json
    validate       --bundle DIR --output report.json exit 0 = pass, 1 = errors
    pack-atlas     --bundle DIR --format strip_x|grid_2d|raw_3d --out DIR

SVOX bundle = rig.json (schema "svox.rig/v1") + parts/<name>.albedo.png (+ parts/<name>.normal_ao.png).
Coordinates: right-handed, +Z up, characters face -Y, 1 unit = 1 voxel, ground plane z = 0.
Strip layout "strip_x": PNG width = sizeX*sizeZ, height = sizeY; slice z occupies columns z*sizeX..(z+1)*sizeX-1,
PNG row r is voxel y = r (row 0 = top of the image = y 0). Voxel (x, y, z) <-> volume index ((z*sizeY + y)*sizeX + x)*4.
All formulas (normal/AO bake, per-slice deform and its inverse) are byte-for-byte ports of the verified
SpriteLab implementation (src/core/voxel_builder.js); see references/01_contract_and_math.md.
"""
import argparse
import json
import math
import os
import struct
import sys
import zlib
from pathlib import Path

SCHEMA_RIG = "svox.rig/v1"
SCHEMA_VALIDATE = "svox.validate/v1"
TOOL_VERSION = "1.0.0"


class SvoxError(Exception):
    pass


# =============================================================================================== PNG (RGBA8)
PNG_SIG = b"\x89PNG\r\n\x1a\n"


def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def png_read(path):
    """Decode an 8-bit non-interlaced PNG (gray, RGB, palette, gray+alpha, RGBA) -> (w, h, bytearray RGBA8)."""
    data = Path(path).read_bytes()
    if data[:8] != PNG_SIG:
        raise SvoxError("%s: not a PNG file" % path)
    pos, ihdr, idat, plte, trns = 8, None, [], None, None
    while pos + 8 <= len(data):
        ln, ctype = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + ln]
        crc = struct.unpack(">I", data[pos + 8 + ln:pos + 12 + ln])[0]
        if zlib.crc32(ctype + body) & 0xFFFFFFFF != crc:
            raise SvoxError("%s: CRC mismatch in %s chunk" % (path, ctype.decode("latin1")))
        pos += 12 + ln
        if ctype == b"IHDR":
            ihdr = struct.unpack(">IIBBBBB", body)
        elif ctype == b"IDAT":
            idat.append(body)
        elif ctype == b"PLTE":
            plte = body
        elif ctype == b"tRNS":
            trns = body
        elif ctype == b"IEND":
            break
    if ihdr is None:
        raise SvoxError("%s: missing IHDR" % path)
    w, h, depth, color, comp, filt, interlace = ihdr
    if depth != 8 or interlace != 0 or comp != 0 or filt != 0:
        raise SvoxError("%s: only 8-bit non-interlaced PNGs are supported (depth=%d interlace=%d)" % (path, depth, interlace))
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color)
    if channels is None:
        raise SvoxError("%s: unsupported PNG color type %d" % (path, color))
    raw = zlib.decompress(b"".join(idat))
    stride = w * channels
    if len(raw) < h * (stride + 1):
        raise SvoxError("%s: truncated image data" % path)
    bpp = channels
    prev = bytearray(stride)
    pix = bytearray(w * h * channels)
    p = 0
    for y in range(h):
        ft = raw[p]
        line = bytearray(raw[p + 1:p + 1 + stride])
        p += stride + 1
        if ft == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ft == 4:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                ul = prev[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + _paeth(left, prev[i], ul)) & 0xFF
        elif ft != 0:
            raise SvoxError("%s: bad PNG filter type %d on row %d" % (path, ft, y))
        pix[y * stride:(y + 1) * stride] = line
        prev = line
    if color == 6:
        return w, h, pix
    out = bytearray(w * h * 4)
    n = w * h
    if color == 2:
        tr = struct.unpack(">HHH", trns) if trns and len(trns) == 6 else None
        for i in range(n):
            r, g, b = pix[i * 3], pix[i * 3 + 1], pix[i * 3 + 2]
            out[i * 4:i * 4 + 4] = bytes((r, g, b, 0 if tr == (r, g, b) else 255))
    elif color == 0:
        for i in range(n):
            v = pix[i]
            out[i * 4:i * 4 + 4] = bytes((v, v, v, 255))
    elif color == 4:
        for i in range(n):
            v = pix[i * 2]
            out[i * 4:i * 4 + 4] = bytes((v, v, v, pix[i * 2 + 1]))
    else:  # palette
        if plte is None:
            raise SvoxError("%s: palette PNG without PLTE" % path)
        for i in range(n):
            k = pix[i]
            a = trns[k] if trns and k < len(trns) else 255
            out[i * 4:i * 4 + 4] = bytes((plte[k * 3], plte[k * 3 + 1], plte[k * 3 + 2], a))
    return w, h, out


def png_write(path, w, h, rgba, filter_type=1):
    """Encode RGBA8 (len w*h*4) as a PNG; every row uses filter 0 (None) or 1 (Sub). Deterministic output."""
    if len(rgba) != w * h * 4:
        raise SvoxError("png_write: expected %d bytes, got %d" % (w * h * 4, len(rgba)))
    if filter_type not in (0, 1):
        raise SvoxError("png_write: filter_type must be 0 or 1")
    stride = w * 4
    raw = bytearray()
    src = bytes(rgba)
    for y in range(h):
        row = src[y * stride:(y + 1) * stride]
        raw.append(filter_type)
        if filter_type == 0:
            raw += row
        else:
            line = bytearray(row)
            for i in range(stride - 1, 3, -1):
                line[i] = (row[i] - row[i - 4]) & 0xFF
            raw += line

    def chunk(t, b):
        return struct.pack(">I", len(b)) + t + b + struct.pack(">I", zlib.crc32(t + b) & 0xFFFFFFFF)

    png = PNG_SIG + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_bytes(png)


# =============================================================================================== layouts
def strip_to_volume(strip, sx, sy, sz):
    """strip_x RGBA (w = sx*sz, h = sy) -> volume RGBA with idx ((z*sy + y)*sx + x)*4."""
    vol = bytearray(sx * sy * sz * 4)
    sw = sx * sz
    row = sx * 4
    for z in range(sz):
        for y in range(sy):
            s = (y * sw + z * sx) * 4
            d = ((z * sy + y) * sx) * 4
            vol[d:d + row] = strip[s:s + row]
    return vol


def volume_to_strip(vol, sx, sy, sz):
    strip = bytearray(sx * sy * sz * 4)
    sw = sx * sz
    row = sx * 4
    for z in range(sz):
        for y in range(sy):
            s = ((z * sy + y) * sx) * 4
            d = (y * sw + z * sx) * 4
            strip[d:d + row] = vol[s:s + row]
    return strip


def grid_layout(sz):
    cols = int(math.ceil(math.sqrt(sz)))
    rows = int(math.ceil(sz / float(cols)))
    return cols, rows


def volume_to_grid(vol, sx, sy, sz):
    """grid_2d flipbook: slice z in tile (z % cols, z // cols), tiles left->right then top->bottom, y = row in tile."""
    cols, rows = grid_layout(sz)
    W, H = cols * sx, rows * sy
    img = bytearray(W * H * 4)
    row = sx * 4
    for z in range(sz):
        tx, ty = (z % cols) * sx, (z // cols) * sy
        for y in range(sy):
            s = ((z * sy + y) * sx) * 4
            d = ((ty + y) * W + tx) * 4
            img[d:d + row] = vol[s:s + row]
    return W, H, cols, rows, img


# =============================================================================================== MagicaVoxel .vox
def default_vox_palette():
    """MagicaVoxel default palette as 256 RGBA tuples indexed by colour index (index 0 = empty)."""
    pal = [(0, 0, 0, 0)]
    lv = [255, 204, 153, 102, 51, 0]
    for r in lv:
        for g in lv:
            for b in lv:
                pal.append((r, g, b, 255))
    pal = pal[:216]  # drops the final black (0,0,0) of the 6x6x6 cube -> indices 1..215
    ramp = [0xEE, 0xDD, 0xBB, 0xAA, 0x88, 0x77, 0x55, 0x44, 0x22, 0x11]
    for v in ramp:
        pal.append((v, 0, 0, 255))
    for v in ramp:
        pal.append((0, v, 0, 255))
    for v in ramp:
        pal.append((0, 0, v, 255))
    for v in ramp:
        pal.append((v, v, v, 255))
    assert len(pal) == 256
    return pal


def _vox_dict(buf, p):
    n = struct.unpack_from("<i", buf, p)[0]
    p += 4
    d = {}
    for _ in range(n):
        kl = struct.unpack_from("<i", buf, p)[0]
        k = buf[p + 4:p + 4 + kl].decode("utf-8", "replace")
        p += 4 + kl
        vl = struct.unpack_from("<i", buf, p)[0]
        v = buf[p + 4:p + 4 + vl].decode("utf-8", "replace")
        p += 4 + vl
        d[k] = v
    return d, p


def vox_read(path):
    """Parse a MagicaVoxel .vox file.
    Returns {"version", "models": [{"size": (x,y,z), "voxels": [(x,y,z,ci)]}], "palette": 256 RGBA (by colour index),
             "instances": [{"model", "name", "translation": (x,y,z), "rotation": str|None}], "warnings": []}."""
    buf = Path(path).read_bytes()
    if buf[:4] != b"VOX ":
        raise SvoxError("%s: missing 'VOX ' magic" % path)
    version = struct.unpack_from("<i", buf, 4)[0]
    if buf[8:12] != b"MAIN":
        raise SvoxError("%s: missing MAIN chunk" % path)
    models, sizes, palette, nodes, warnings = [], [], None, {}, []
    main_content, main_children = struct.unpack_from("<ii", buf, 12)
    p = 20 + main_content
    end = min(len(buf), p + main_children)
    while p + 12 <= end:
        cid = buf[p:p + 4]
        csz, chs = struct.unpack_from("<ii", buf, p + 4)
        c = p + 12
        if cid == b"SIZE":
            sizes.append(struct.unpack_from("<iii", buf, c))
        elif cid == b"XYZI":
            n = struct.unpack_from("<i", buf, c)[0]
            vox = [tuple(buf[c + 4 + i * 4:c + 8 + i * 4]) for i in range(n)]
            if not sizes:
                raise SvoxError("%s: XYZI before SIZE" % path)
            models.append({"size": tuple(sizes[len(models)]), "voxels": vox})
        elif cid == b"RGBA":
            raw = buf[c:c + 1024]
            palette = [(0, 0, 0, 0)] + [tuple(raw[i * 4:i * 4 + 4]) for i in range(255)]
        elif cid == b"nTRN":
            nid = struct.unpack_from("<i", buf, c)[0]
            attrs, q = _vox_dict(buf, c + 4)
            child, _res, layer, nframes = struct.unpack_from("<iiii", buf, q)
            q += 16
            frames = []
            for _ in range(max(0, nframes)):
                fd, q = _vox_dict(buf, q)
                frames.append(fd)
            nodes[nid] = {"type": "TRN", "attrs": attrs, "child": child, "frame": frames[0] if frames else {}}
        elif cid == b"nGRP":
            nid = struct.unpack_from("<i", buf, c)[0]
            attrs, q = _vox_dict(buf, c + 4)
            nch = struct.unpack_from("<i", buf, q)[0]
            kids = list(struct.unpack_from("<%di" % nch, buf, q + 4)) if nch > 0 else []
            nodes[nid] = {"type": "GRP", "attrs": attrs, "children": kids}
        elif cid == b"nSHP":
            nid = struct.unpack_from("<i", buf, c)[0]
            attrs, q = _vox_dict(buf, c + 4)
            nm = struct.unpack_from("<i", buf, q)[0]
            q += 4
            mids = []
            for _ in range(nm):
                mids.append(struct.unpack_from("<i", buf, q)[0])
                _md, q = _vox_dict(buf, q + 4)
            nodes[nid] = {"type": "SHP", "attrs": attrs, "models": mids}
        p = c + csz + chs
    if not models:
        raise SvoxError("%s: no models (XYZI chunks) found" % path)
    if palette is None:
        palette = default_vox_palette()
    instances = []
    if nodes and 0 in nodes:
        def walk(nid, t, name, depth):
            if depth > 64 or nid not in nodes:
                return
            nd = nodes[nid]
            if nd["type"] == "TRN":
                tr = nd["frame"].get("_t")
                rot = nd["frame"].get("_r")
                if rot not in (None, "4"):
                    warnings.append("node %d: rotation _r=%s is not applied (translation only)" % (nid, rot))
                d = [int(v) for v in tr.split()] if tr else [0, 0, 0]
                walk(nd["child"], (t[0] + d[0], t[1] + d[1], t[2] + d[2]), nd["attrs"].get("_name") or name, depth + 1)
            elif nd["type"] == "GRP":
                for k in nd["children"]:
                    walk(k, t, name, depth + 1)
            elif nd["type"] == "SHP":
                for m in nd["models"]:
                    instances.append({"model": m, "name": name, "translation": t, "rotation": None})
        walk(0, (0, 0, 0), None, 0)
    if not instances:
        instances = [{"model": i, "name": None, "translation": (0, 0, 0), "rotation": None} for i in range(len(models))]
    return {"version": version, "models": models, "palette": palette, "instances": instances, "warnings": warnings}


def vox_write(path, models, palette=None, names=None, translations=None):
    """Write a .vox (version 150). models = [((sx,sy,sz), [(x,y,z,ci), ...])]; palette = 256 RGBA by colour index.
    Multi-model files (or any names/translations) get an nTRN/nGRP/nSHP scene graph."""
    def chunk(cid, content, children=b""):
        return cid + struct.pack("<ii", len(content), len(children)) + content + children

    def sdict(d):
        out = struct.pack("<i", len(d))
        for k, v in d.items():
            kb, vb = k.encode(), str(v).encode()
            out += struct.pack("<i", len(kb)) + kb + struct.pack("<i", len(vb)) + vb
        return out

    body = b""
    for size, vox in models:
        body += chunk(b"SIZE", struct.pack("<iii", *size))
        body += chunk(b"XYZI", struct.pack("<i", len(vox)) + b"".join(struct.pack("<BBBB", *v) for v in vox))
    if len(models) > 1 or names or translations:
        names = names or [None] * len(models)
        translations = translations or [(0, 0, 0)] * len(models)
        body += chunk(b"nTRN", struct.pack("<i", 0) + sdict({}) + struct.pack("<iiii", 1, -1, -1, 1) + sdict({}))
        kids = [2 + 2 * i for i in range(len(models))]
        body += chunk(b"nGRP", struct.pack("<i", 1) + sdict({}) + struct.pack("<i", len(kids)) + struct.pack("<%di" % len(kids), *kids))
        for i in range(len(models)):
            attrs = {"_name": names[i]} if names[i] else {}
            t = translations[i]
            body += chunk(b"nTRN", struct.pack("<i", 2 + 2 * i) + sdict(attrs) + struct.pack("<iiii", 3 + 2 * i, -1, 0, 1) +
                          sdict({"_t": "%d %d %d" % tuple(t)}))
            body += chunk(b"nSHP", struct.pack("<i", 3 + 2 * i) + sdict({}) + struct.pack("<ii", 1, i) + sdict({}))
    if palette is not None:
        body += chunk(b"RGBA", b"".join(bytes(palette[i]) for i in range(1, 256)) + b"\x00\x00\x00\x00")
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_bytes(b"VOX " + struct.pack("<i", 150) + chunk(b"MAIN", b"", body))


# =============================================================================================== normals + AO
# Exact port of SpriteLab.Voxel.computeNormalAndAO (src/core/voxel_builder.js). Float32 weight tables are
# reproduced with _f32 so the output is byte-identical to the JS implementation.
PAD = 2


def _f32(v):
    return struct.unpack("<f", struct.pack("<f", v))[0]


def _jsround(v):
    return int(math.floor(v + 0.5))


NORMAL_OFFSETS = []
for _dz in (-1, 0, 1):
    for _dy in (-1, 0, 1):
        for _dx in (-1, 0, 1):
            if _dx == 0 and _dy == 0 and _dz == 0:
                continue
            _sw = lambda v: 2 if v == 0 else 1  # noqa: E731
            NORMAL_OFFSETS.append((_dx, _dy, _dz, _dx * _sw(_dy) * _sw(_dz), _dy * _sw(_dx) * _sw(_dz), _dz * _sw(_dx) * _sw(_dy)))

_TABLES = {}


def _tables(stride_y, stride_z):
    key = (stride_y, stride_z)
    if key in _TABLES:
        return _TABLES[key]
    n_delta = [o[0] + o[1] * stride_y + o[2] * stride_z for o in NORMAL_OFFSETS]
    n_w = [(o[3], o[4], o[5]) for o in NORMAL_OFFSETS]
    ao = []
    for q in range(27):
        qx, qy, qz = q // 9 - 1, (q // 3) % 3 - 1, q % 3 - 1
        seen, cells = set(), []
        for ring in (1, 2):
            for oz in (-1, 0, 1):
                for oy in (-1, 0, 1):
                    for ox in (-1, 0, 1):
                        dx, dy, dz = qx * ring + ox, qy * ring + oy, qz * ring + oz
                        if dx == 0 and dy == 0 and dz == 0:
                            continue
                        if (dx, dy, dz) in seen:
                            continue
                        seen.add((dx, dy, dz))
                        dl = math.sqrt(dx * dx + dy * dy + dz * dz)
                        w = _f32((1.0 if ring == 1 else 0.6) / dl * (1.0 + 0.4 * dz / dl))
                        cells.append((dx + dy * stride_y + dz * stride_z, w, float(dx), float(dy), float(dz)))
        ao.append(cells)
    _TABLES[key] = (n_delta, n_w, ao)
    return _TABLES[key]


def compute_normal_ao(data, sx, sy, sz):
    """RGBA8 volume -> RGBA8 normal/AO volume: RGB = (n*0.5+0.5)*255 (outward, -grad(alpha), 3x3x3 Sobel),
    A = AO visibility*255 (front-hemisphere filtered); empty voxels touching a solid voxel are dilated."""
    n = sx * sy * sz
    out = bytearray(b"\x80\x80\xff\xff" * n)
    PX, PY, PZ = sx + PAD * 2, sy + PAD * 2, sz + PAD * 2
    stride_y, stride_z = PX, PX * PY
    total = PX * PY * PZ
    occ = bytearray(total)  # 0 empty, 1 ground (z < 0), 2 solid
    near = bytearray(total)
    for i in range(PAD * stride_z):
        occ[i] = 1
    min_x, min_y, min_z, max_x, max_y, max_z = sx, sy, sz, -1, -1, -1
    for z in range(sz):
        for y in range(sy):
            src = (z * sy + y) * sx * 4 + 3
            dst = (z + PAD) * stride_z + (y + PAD) * stride_y + PAD
            for x in range(sx):
                if data[src + x * 4] > 0:
                    occ[dst + x] = 2
                    if x < min_x: min_x = x
                    if x > max_x: max_x = x
                    if y < min_y: min_y = y
                    if y > max_y: max_y = y
                    if z < min_z: min_z = z
                    if z > max_z: max_z = z
    if max_x < 0:
        return out
    n_delta, n_w, ao_tab = _tables(stride_y, stride_z)
    Q = 0.3827
    for z in range(min_z, max_z + 1):
        for y in range(min_y, max_y + 1):
            for x in range(min_x, max_x + 1):
                pi = (z + PAD) * stride_z + (y + PAD) * stride_y + x + PAD
                if occ[pi] != 2:
                    continue
                near[pi] = 1
                for d in n_delta:
                    near[pi + d] = 1
    x0, x1 = max(0, min_x - 1), min(sx - 1, max_x + 1)
    y0, y1 = max(0, min_y - 1), min(sy - 1, max_y + 1)
    z0, z1 = max(0, min_z - 1), min(sz - 1, max_z + 1)
    for z in range(z0, z1 + 1):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                pi = (z + PAD) * stride_z + (y + PAD) * stride_y + x + PAD
                if not near[pi]:
                    continue
                gx = gy = gz = 0
                solid_n = 0
                for k in range(26):
                    if occ[pi + n_delta[k]] == 2:
                        w = n_w[k]
                        gx += w[0]; gy += w[1]; gz += w[2]
                        solid_n += 1
                nx, ny, nz = float(-gx), float(-gy), float(-gz)
                ln = math.sqrt(nx * nx + ny * ny + nz * nz)
                if ln < 1e-3:
                    nx = float((0 if occ[pi + 1] == 2 else 1) - (0 if occ[pi - 1] == 2 else 1))
                    ny = float((0 if occ[pi + stride_y] == 2 else 1) - (0 if occ[pi - stride_y] == 2 else 1))
                    nz = float((0 if occ[pi + stride_z] == 2 else 1) - (0 if occ[pi - stride_z] == 2 else 1))
                    ln = math.sqrt(nx * nx + ny * ny + nz * nz)
                    if ln < 1e-3:
                        up_open, down_open = occ[pi + stride_z] != 2, occ[pi - stride_z] != 2
                        nx, ny, nz, ln = 0.0, 0.0, (1.0 if (up_open or not down_open) else -1.0), 1.0
                nx /= ln; ny /= ln; nz /= ln
                if solid_n == 26:
                    ao = 0.5
                else:
                    q = ((2 if nx > Q else (0 if nx < -Q else 1)) * 9) + ((2 if ny > Q else (0 if ny < -Q else 1)) * 3) + \
                        (2 if nz > Q else (0 if nz < -Q else 1))
                    if q == 13:
                        q = 14 if nz >= 0 else 12
                    occ_sum = w_tot = 0.0
                    for (dd, wi, ox, oy, oz) in ao_tab[q]:
                        if ox * nx + oy * ny + oz * nz <= 0.75:
                            continue
                        w_tot += wi
                        j = pi + dd  # |offset| can reach 3 > PAD: JS typed arrays read undefined (= empty) there
                        ov = occ[j] if 0 <= j < total else 0
                        if ov == 2:
                            occ_sum += wi
                        elif ov == 1:
                            occ_sum += wi * 0.6
                    occ_frac = occ_sum / w_tot if w_tot > 0 else 0.0
                    ao = 1.0 - 2.2 * occ_frac
                    ao = math.pow(ao, 1.3) if ao > 0 else 0.0
                ao = 0.12 if ao < 0.12 else (1.0 if ao > 1 else ao)
                oi = ((z * sy + y) * sx + x) * 4
                out[oi] = _jsround((nx * 0.5 + 0.5) * 255)
                out[oi + 1] = _jsround((ny * 0.5 + 0.5) * 255)
                out[oi + 2] = _jsround((nz * 0.5 + 0.5) * 255)
                out[oi + 3] = _jsround(ao * 255)
    for z in range(z0, z1 + 1):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                pi = (z + PAD) * stride_z + (y + PAD) * stride_y + x + PAD
                if not near[pi] or occ[pi] == 2:
                    continue
                s = c = 0
                for k in range(26):
                    if occ[pi + n_delta[k]] != 2:
                        continue
                    o = NORMAL_OFFSETS[k]
                    s += out[(((z + o[2]) * sy + (y + o[1])) * sx + (x + o[0])) * 4 + 3]
                    c += 1
                if c:
                    out[((z * sy + y) * sx + x) * 4 + 3] = _jsround(s / c)
    return out


SIX = ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))


def normal_stats(vol, nao, sx, sy, sz):
    """Surface-voxel normal/AO statistics (same definition as tests/test_core.mjs normalStats)."""
    def solid(x, y, z):
        return 0 <= x < sx and 0 <= y < sy and 0 <= z < sz and vol[((z * sy + y) * sx + x) * 4 + 3] > 0
    surf = unit = outward = 0
    ao_min, ao_sum, solid_n, shell = 1.0, 0.0, 0, 0
    for z in range(sz):
        for y in range(sy):
            for x in range(sx):
                i = ((z * sy + y) * sx + x) * 4
                if not solid(x, y, z):
                    if bytes(nao[i:i + 4]) != b"\x80\x80\xff\xff":
                        shell += 1
                    continue
                solid_n += 1
                opn = [o for o in SIX if not solid(x + o[0], y + o[1], z + o[2])]
                if not opn:
                    continue
                surf += 1
                nv = (nao[i] / 127.5 - 1, nao[i + 1] / 127.5 - 1, nao[i + 2] / 127.5 - 1)
                if abs(math.sqrt(nv[0] ** 2 + nv[1] ** 2 + nv[2] ** 2) - 1) < 0.03:
                    unit += 1
                od = [sum(o[k] for o in opn) for k in range(3)]
                if od == [0, 0, 0] or nv[0] * od[0] + nv[1] * od[1] + nv[2] * od[2] > 0:
                    outward += 1
                a = nao[i + 3] / 255.0
                ao_min = min(ao_min, a)
                ao_sum += a
    return {"solidVoxels": solid_n, "surfaceVoxels": surf, "unitFrac": round(unit / surf, 4) if surf else 1.0,
            "outwardFrac": round(outward / surf, 4) if surf else 1.0, "aoMin": round(ao_min, 4),
            "aoMean": round(ao_sum / surf, 4) if surf else 1.0, "dilatedShellVoxels": shell}


# =============================================================================================== deform + mat4
# Per-slice deformation (identical to SpriteLab.Voxel.deformPoint / undeformPoint):
#   uZ = clamp((lz + pivot.z) / sizeZ, 0, 1)
#   forward: squash (lz' = lz*s; x,y *= 1/sqrt(max(.35, s))) -> twist (rotate xy by twistZ*uZ)
#            -> shear (x += shearX*lz', y += shearY*lz') -> wave (x += sin(uZ*f+ph)*ampX*uZ, y += cos(..)*ampY*uZ)
#   inverse: undo wave -> undo shear -> undo twist -> undo squash
DEFORM_KEYS = ("shearX", "shearY", "twistZ", "squashZ", "waveAmpX", "waveAmpY", "waveFreq", "wavePhase")


def identity_deform():
    return {"shearX": 0.0, "shearY": 0.0, "twistZ": 0.0, "squashZ": 1.0, "waveAmpX": 0.0, "waveAmpY": 0.0,
            "waveFreq": 0.0, "wavePhase": 0.0}


def is_identity_deform(d):
    return (not d) or (not d.get("shearX") and not d.get("shearY") and not d.get("twistZ") and
                       d.get("squashZ", 1) == 1 and not d.get("waveAmpX") and not d.get("waveAmpY"))


def deform_point(lx, ly, lz, d, size_z, pivot_z):
    if is_identity_deform(d):
        return [lx, ly, lz]
    sq = d.get("squashZ", 1.0)
    xys = 1.0 / math.sqrt(max(0.35, sq))
    uz = min(1.0, max(0.0, (lz + pivot_z) / size_z))
    x, y, z = lx * xys, ly * xys, lz * sq
    t = d.get("twistZ", 0.0) * uz
    c, s = math.cos(t), math.sin(t)
    rx, ry = c * x - s * y, s * x + c * y
    rx += d.get("shearX", 0.0) * z
    ry += d.get("shearY", 0.0) * z
    ang = uz * d.get("waveFreq", 0.0) + d.get("wavePhase", 0.0)
    rx += math.sin(ang) * d.get("waveAmpX", 0.0) * uz
    ry += math.cos(ang) * d.get("waveAmpY", 0.0) * uz
    return [rx, ry, z]


def undeform_point(dx, dy, dz, d, size_z, pivot_z):
    if is_identity_deform(d):
        return [dx, dy, dz]
    sq = d.get("squashZ", 1.0)
    xys = 1.0 / math.sqrt(max(0.35, sq))
    lz = dz / (1e-4 if abs(sq) < 1e-4 else sq)
    uz = min(1.0, max(0.0, (lz + pivot_z) / size_z))
    ang = uz * d.get("waveFreq", 0.0) + d.get("wavePhase", 0.0)
    x = dx - math.sin(ang) * d.get("waveAmpX", 0.0) * uz
    y = dy - math.cos(ang) * d.get("waveAmpY", 0.0) * uz
    x -= d.get("shearX", 0.0) * dz
    y -= d.get("shearY", 0.0) * dz
    t = d.get("twistZ", 0.0) * uz
    c, s = math.cos(t), math.sin(t)
    ux, uy = c * x + s * y, -s * x + c * y
    return [ux / xys, uy / xys, lz]


def m4_identity():
    return [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]


def m4_mul(a, b):  # column-major, out = a * b
    o = [0.0] * 16
    for c in range(4):
        b0, b1, b2, b3 = b[c * 4], b[c * 4 + 1], b[c * 4 + 2], b[c * 4 + 3]
        for r in range(4):
            o[c * 4 + r] = a[r] * b0 + a[4 + r] * b1 + a[8 + r] * b2 + a[12 + r] * b3
    return o


def m4_translate(x, y, z):
    m = m4_identity()
    m[12], m[13], m[14] = x, y, z
    return m


def m4_rot(axis, a):
    c, s, m = math.cos(a), math.sin(a), m4_identity()
    if axis == 0:
        m[5], m[6], m[9], m[10] = c, s, -s, c
    elif axis == 1:
        m[0], m[2], m[8], m[10] = c, -s, s, c
    else:
        m[0], m[1], m[4], m[5] = c, s, -s, c
    return m


def m4_scale(s):
    m = m4_identity()
    m[0] = m[5] = m[10] = s
    return m


def m4_point(m, p):
    return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
            m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]


def m4_invert(m):
    a = [[m[c * 4 + r] for c in range(4)] + [1.0 if r == k else 0.0 for k in range(4)] for r in range(4)]
    for col in range(4):
        piv = max(range(col, 4), key=lambda r: abs(a[r][col]))
        if abs(a[piv][col]) < 1e-12:
            raise SvoxError("singular part matrix")
        a[col], a[piv] = a[piv], a[col]
        pv = a[col][col]
        a[col] = [v / pv for v in a[col]]
        for r in range(4):
            if r != col and a[r][col] != 0:
                f = a[r][col]
                a[r] = [a[r][k] - f * a[col][k] for k in range(8)]
    return [a[r][4 + c] for c in range(4) for r in range(4)]


# =============================================================================================== rig evaluation
PART_CHANNELS = ("posX", "posY", "posZ", "rotX", "rotY", "rotZ", "scale") + DEFORM_KEYS
ROOT_CHANNELS = ("posX", "posY", "posZ")


def channel_value(ch, t, duration):
    """sin: bias + amp*sin(2*pi*cycles*u + phase); ramp: bias + amp*cycles*u; keys: linear, looping. u = t/duration."""
    fn = ch.get("fn", "sin")
    u = t / duration if duration > 0 else 0.0
    bias, amp, cyc = float(ch.get("bias", 0.0)), float(ch.get("amp", 0.0)), float(ch.get("cycles", 1.0))
    if fn == "sin":
        return bias + amp * math.sin(2.0 * math.pi * cyc * u + float(ch.get("phase", 0.0)))
    if fn == "ramp":
        return bias + amp * cyc * u
    if fn == "keys":
        ts, vs = ch["times"], ch["values"]
        tt = t % duration if duration > 0 else 0.0
        if tt <= ts[0]:
            return bias + vs[0]
        for i in range(1, len(ts)):
            if tt <= ts[i]:
                f = (tt - ts[i - 1]) / max(1e-9, ts[i] - ts[i - 1])
                return bias + vs[i - 1] + (vs[i] - vs[i - 1]) * f
        return bias + vs[-1]
    raise SvoxError("unknown channel fn '%s'" % fn)


def part_order(parts):
    by = {p["name"]: p for p in parts}
    order, state = [], {}

    def visit(n, chain):
        if state.get(n) == 2:
            return
        if state.get(n) == 1:
            raise SvoxError("parent cycle: %s" % " -> ".join(chain + [n]))
        state[n] = 1
        par = by[n].get("parent")
        if par:
            if par not in by:
                raise SvoxError("part '%s' has unknown parent '%s'" % (n, par))
            visit(par, chain + [n])
        state[n] = 2
        order.append(n)
    for p in parts:
        visit(p["name"], [])
    return order


def evaluate_pose(rig, clip_name, t, use_deform=True, rest=False):
    """PoseResult-like dict: {"rootOffset", "parts": {name: {"matrix", "invMatrix", "deform"}}}.
    M(part) = attach * T(restOffset + pos) * Rz*Ry*Rx(restRotation + rot) * [RotX(pi) if flippedCloth] * S(scale)
    with T(restOffset + pos) replaced by parent.matrix * T(deformPoint_parent(restOffset + pos)) for children and by
    T(rootOffset + restOffset + pos) for roots: children ride the parent's DEFORMED surface (position only).
    world = M * deform(local), local = voxel - pivot; invMatrix = inverse(M)."""
    parts = rig["parts"]
    by = {p["name"]: p for p in parts}
    clip = None
    if not rest and clip_name:
        clip = next((c for c in rig.get("clips", []) if c["name"] == clip_name), None)
        if clip is None:
            raise SvoxError("unknown clip '%s'" % clip_name)
    dur = float(clip.get("duration", 1.0)) if clip else 1.0
    vals = {}
    root = [0.0, 0.0, 0.0]
    if clip:
        for ch in clip.get("channels", []):
            v = channel_value(ch, t, dur)
            if ch["part"] == "@root":
                root["XYZ".index(ch["channel"][-1])] += v
            else:
                vals.setdefault(ch["part"], {})
                vals[ch["part"]][ch["channel"]] = vals[ch["part"]].get(ch["channel"], 0.0) + v
    out = {"rootOffset": root, "parts": {}}
    for name in part_order(parts):
        p = by[name]
        v = vals.get(name, {})
        ro = p.get("restOffset", [0, 0, 0])
        rr = p.get("restRotation", [0, 0, 0])
        local = [ro[0] + v.get("posX", 0.0), ro[1] + v.get("posY", 0.0), ro[2] + v.get("posZ", 0.0)]
        d = identity_deform()
        for k in DEFORM_KEYS:
            if k in v:
                d[k] += v[k]
        if not use_deform:
            d = identity_deform()
        par = p.get("parent")
        if par:
            pp, pdef = out["parts"][par], out["parts"][par]["deform"]
            pv = by[par]
            att = deform_point(local[0], local[1], local[2], pdef, pv["size"][2], pv["pivot"][2])
            m = m4_mul(pp["matrix"], m4_translate(*att))
        else:
            m = m4_translate(root[0] + local[0], root[1] + local[1], root[2] + local[2])
        r = m4_mul(m4_rot(2, rr[2] + v.get("rotZ", 0.0)), m4_mul(m4_rot(1, rr[1] + v.get("rotY", 0.0)), m4_rot(0, rr[0] + v.get("rotX", 0.0))))
        m = m4_mul(m, r)
        if p.get("flippedCloth"):
            m = m4_mul(m, m4_rot(0, math.pi))
        sc = 1.0 + v.get("scale", 0.0)
        if sc != 1.0:
            m = m4_mul(m, m4_scale(sc))
        out["parts"][name] = {"matrix": m, "invMatrix": m4_invert(m), "deform": d}
    return out


# =============================================================================================== bundle io
def load_rig(bundle):
    path = Path(bundle) / "rig.json"
    if not path.exists():
        raise SvoxError("%s not found" % path)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except ValueError as e:
        raise SvoxError("rig.json is not valid JSON: %s" % e)


def save_json(path, obj):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(obj, indent=2) + "\n", encoding="utf-8")


def new_rig(target_height=12.0):
    return {"schema": SCHEMA_RIG, "generator": "svox_cli.py " + TOOL_VERSION,
            "coordinates": {"handedness": "right-handed", "up": "+Z", "front": "-Y", "unit": "1 voxel", "ground": "z = 0"},
            "targetHeight": target_height, "parts": [], "clips": []}


def make_part(name, size, pivot, parent=None, rest_offset=(0, 0, 0), deform_role="rigid", flipped=False):
    return {"name": name, "parent": parent, "pivot": [float(v) for v in pivot], "restOffset": [float(v) for v in rest_offset],
            "restRotation": [0.0, 0.0, 0.0], "size": [int(v) for v in size], "deformRole": deform_role,
            "flippedCloth": bool(flipped), "albedoLayout": "strip_x", "albedoPath": "parts/%s.albedo.png" % name,
            "normalAoPath": None}


def read_part_volume(bundle, part, key="albedoPath"):
    sx, sy, sz = part["size"]
    w, h, rgba = png_read(Path(bundle) / part[key])
    if w != sx * sz or h != sy:
        raise SvoxError("%s: strip is %dx%d, expected %dx%d (sizeX*sizeZ x sizeY)" % (part[key], w, h, sx * sz, sy))
    return strip_to_volume(rgba, sx, sy, sz)


def write_part_albedo(bundle, part, vol):
    sx, sy, sz = part["size"]
    png_write(Path(bundle) / part["albedoPath"], sx * sz, sy, volume_to_strip(vol, sx, sy, sz))


def safe_name(s, fallback):
    s = "".join(ch if (ch.isalnum() or ch in "_-") else "_" for ch in (s or "")).strip("_")
    return s or fallback


# =============================================================================================== commands
def cmd_bake(args):
    bundle = Path(args.bundle)
    rig = load_rig(bundle)
    stats = {"schema": "svox.bake/v1", "tool": "svox_cli.py bake-normal-ao", "parts": {}}
    for part in rig["parts"]:
        sx, sy, sz = part["size"]
        vol = read_part_volume(bundle, part)
        nao = compute_normal_ao(vol, sx, sy, sz)
        part["normalAoPath"] = "parts/%s.normal_ao.png" % part["name"]
        png_write(bundle / part["normalAoPath"], sx * sz, sy, volume_to_strip(nao, sx, sy, sz))
        st = normal_stats(vol, nao, sx, sy, sz)
        stats["parts"][part["name"]] = st
        print("  baked %-14s %2dx%2dx%2d  solid %5d  surface unit %.3f outward %.3f  AO min %.2f  shell %d" % (
            part["name"], sx, sy, sz, st["solidVoxels"], st["unitFrac"], st["outwardFrac"], st["aoMin"], st["dilatedShellVoxels"]))
    rig["normalAo"] = {"tool": "svox_cli.py bake-normal-ao", "layout": "strip_x",
                       "encoding": "RGB = (n*0.5+0.5)*255 outward unit normal, A = AO visibility*255 (255 = open)",
                       "algorithm": "3x3x3 Sobel -grad(alpha); 26-dir front-hemisphere AO (offset.n > 0.75); 1-voxel shell dilation",
                       "stats": "bake_stats.json"}
    save_json(bundle / "rig.json", rig)
    save_json(bundle / "bake_stats.json", stats)
    print("bake-normal-ao: %d part(s) -> %s" % (len(rig["parts"]), bundle / "bake_stats.json"))
    return 0


def _merge_part(rig, part):
    rig["parts"] = [p for p in rig["parts"] if p["name"] != part["name"]] + [part]


def cmd_from_strip(args):
    out = Path(args.out)
    sx, sy, sz = args.size_x, args.size_y, args.size_z
    w, h, rgba = png_read(args.input)
    if w != sx * sz or h != sy:
        raise SvoxError("strip %s is %dx%d but --size-x*--size-z x --size-y = %dx%d" % (args.input, w, h, sx * sz, sy))
    pivot = [float(v) for v in args.pivot.split(",")] if args.pivot else [sx / 2.0, sy / 2.0, 0.0]
    if len(pivot) != 3:
        raise SvoxError("--pivot needs X,Y,Z")
    rest = [float(v) for v in args.rest_offset.split(",")] if args.rest_offset else [0.0, 0.0, 0.0]
    rig = load_rig(out) if (out / "rig.json").exists() else new_rig(float(sz) * 0.5)
    part = make_part(safe_name(args.part_name, "part"), (sx, sy, sz), pivot, args.parent, rest, args.deform_role, args.flipped_cloth)
    vol = strip_to_volume(rgba, sx, sy, sz)
    for i in range(3, len(vol), 4):  # binary alpha: any alpha > 0 is solid (renderers test alpha > 0.5 / iso 0.45)
        if vol[i]:
            vol[i] = 255
    write_part_albedo(out, part, vol)
    _merge_part(rig, part)
    save_json(out / "rig.json", rig)
    solid = sum(1 for i in range(3, len(vol), 4) if vol[i])
    print("from-strip: %s -> part '%s' %dx%dx%d, %d voxels -> %s" % (args.input, part["name"], sx, sy, sz, solid, out))
    if args.bake:
        return cmd_bake(argparse.Namespace(bundle=str(out)))
    return 0


def cmd_from_vox(args):
    out = Path(args.out)
    vx = vox_read(args.input)
    for wmsg in vx["warnings"]:
        print("  warning: " + wmsg)
    pal = vx["palette"]
    built = []
    used = set()
    for k, inst in enumerate(vx["instances"]):
        model = vx["models"][inst["model"]]
        sx, sy, sz = model["size"]
        vol = bytearray(sx * sy * sz * 4)
        for (x, y, z, ci) in model["voxels"]:
            if args.rotate_z180:
                x, y = sx - 1 - x, sy - 1 - y
            if 0 <= x < sx and 0 <= y < sy and 0 <= z < sz and ci:
                r, g, b, _a = pal[ci]
                vol[((z * sy + y) * sx + x) * 4:((z * sy + y) * sx + x) * 4 + 4] = bytes((r, g, b, 255))
        t = inst["translation"]
        if args.rotate_z180:
            t = (-t[0], -t[1], t[2])
        lo = [t[0] - sx // 2, t[1] - sy // 2, t[2] - sz // 2]  # MagicaVoxel: model centre = floor(size / 2)
        base = args.part_name if (args.part_name and len(vx["instances"]) == 1) else (inst["name"] or ("%s_%d" % (args.part_name or "model", k)))
        name = safe_name(base, "model_%d" % k)
        while name in used:
            name += "_"
        used.add(name)
        built.append({"name": name, "size": (sx, sy, sz), "vol": vol, "lo": lo, "count": len(model["voxels"])})
    zmin = min(b["lo"][2] for b in built)
    xs = [b["lo"][0] for b in built] + [b["lo"][0] + b["size"][0] for b in built]
    ys = [b["lo"][1] for b in built] + [b["lo"][1] + b["size"][1] for b in built]
    cx, cy = (min(xs) + max(xs)) / 2.0, (min(ys) + max(ys)) / 2.0
    if (out / "rig.json").exists():
        print("  note: replacing existing %s" % (out / "rig.json"))
    rig = new_rig(round((max(b["lo"][2] + b["size"][2] for b in built) - zmin) * 0.5, 3))
    root_world = None
    for i, b in enumerate(built):
        sx, sy, sz = b["size"]
        pivot = [sx / 2.0, sy / 2.0, 0.0]
        world = [b["lo"][0] + pivot[0] - cx, b["lo"][1] + pivot[1] - cy, b["lo"][2] + pivot[2] - zmin]
        if i == 0:
            root_world = world
            part = make_part(b["name"], b["size"], pivot, None, world, "rigid")
        else:
            rel = [world[k] - root_world[k] for k in range(3)]
            part = make_part(b["name"], b["size"], pivot, built[0]["name"], rel, "rigid")
        write_part_albedo(out, part, b["vol"])
        rig["parts"].append(part)
        print("  part %-14s %3dx%3dx%3d  %6d voxels  restOffset %s" % (part["name"], sx, sy, sz, b["count"],
                                                                     [round(v, 2) for v in part["restOffset"]]))
    save_json(out / "rig.json", rig)
    print("from-vox: %s (v%d, %d model(s), %d instance(s)) -> %s" % (args.input, vx["version"], len(vx["models"]),
                                                                     len(built), out))
    if args.bake:
        return cmd_bake(argparse.Namespace(bundle=str(out)))
    return 0


def cmd_pack(args):
    bundle, out = Path(args.bundle), Path(args.out)
    rig = load_rig(bundle)
    fmt = args.format
    man = {"schema": "svox.atlas/v1", "format": fmt, "source": "rig.json", "parts": []}
    for part in rig["parts"]:
        sx, sy, sz = part["size"]
        maps = {"albedo": read_part_volume(bundle, part)}
        if part.get("normalAoPath") and (bundle / part["normalAoPath"]).exists():
            maps["normal_ao"] = read_part_volume(bundle, part, "normalAoPath")
        entry = {"name": part["name"], "size": [sx, sy, sz], "pivot": part["pivot"], "files": {}}
        for kind, vol in maps.items():
            if fmt == "strip_x":
                fn = "%s.%s.strip.png" % (part["name"], kind)
                png_write(out / fn, sx * sz, sy, volume_to_strip(vol, sx, sy, sz))
                entry["files"][kind] = {"path": fn, "width": sx * sz, "height": sy}
            elif fmt == "grid_2d":
                W, H, cols, rows, img = volume_to_grid(vol, sx, sy, sz)
                fn = "%s.%s.grid.png" % (part["name"], kind)
                png_write(out / fn, W, H, img)
                entry["files"][kind] = {"path": fn, "width": W, "height": H, "columns": cols, "rows": rows,
                                        "tileOrder": "slice z at tile (z % columns, z // columns), row 0 at top"}
            else:
                fn = "%s.%s.rgba8.bin" % (part["name"], kind)
                (out / fn).parent.mkdir(parents=True, exist_ok=True)
                (out / fn).write_bytes(bytes(vol))
                entry["files"][kind] = {"path": fn, "bytes": len(vol), "format": "RGBA8",
                                        "order": "x fastest, then y, then z: idx = ((z*sizeY + y)*sizeX + x)*4",
                                        "upload": "texImage3D(TEXTURE_3D, 0, RGBA8, sizeX, sizeY, sizeZ, 0, RGBA, UNSIGNED_BYTE, bytes)"}
        man["parts"].append(entry)
    save_json(out / "manifest.json", man)
    print("pack-atlas: %s, %d part(s) -> %s" % (fmt, len(man["parts"]), out / "manifest.json"))
    return 0


# ----------------------------------------------------------------------------------------------- validate
class _Rng:  # deterministic LCG so reports are reproducible across machines
    def __init__(self, seed):
        self.s = seed & 0xFFFFFFFF

    def next(self):
        self.s = (self.s * 1664525 + 1013904223) & 0xFFFFFFFF
        return self.s / 4294967296.0

    def range(self, a, b):
        return a + (b - a) * self.next()


def _solid_voxels(vol, sx, sy, sz):
    return [(x, y, z) for z in range(sz) for y in range(sy) for x in range(sx) if vol[((z * sy + y) * sx + x) * 4 + 3] > 0]


def _thin_fraction(vol, sx, sy, sz, solids):
    def s(x, y, z):
        return 0 <= x < sx and 0 <= y < sy and 0 <= z < sz and vol[((z * sy + y) * sx + x) * 4 + 3] > 0
    thin = 0
    for (x, y, z) in solids:
        if (not s(x - 1, y, z) and not s(x + 1, y, z)) or (not s(x, y - 1, z) and not s(x, y + 1, z)) or \
                (not s(x, y, z - 1) and not s(x, y, z + 1)):
            thin += 1
    return thin / float(len(solids)) if solids else 0.0


def _part_world_minz(pose_part, part, corners):
    d, sz, pz = pose_part["deform"], part["size"][2], part["pivot"][2]
    m = pose_part["matrix"]
    lo = float("inf")
    for (lx, ly, lz) in corners:
        w = m4_point(m, deform_point(lx, ly, lz, d, sz, pz))
        if w[2] < lo:
            lo = w[2]
    return lo


def cmd_validate(args):
    bundle = Path(args.bundle)
    errors, warnings, info = [], [], {}

    def err(code, msg, part=None):
        errors.append({"code": code, "part": part, "message": msg})

    def warn(code, msg, part=None):
        warnings.append({"code": code, "part": part, "message": msg})
    report = {"schema": SCHEMA_VALIDATE, "bundle": str(bundle), "tool": "svox_cli.py " + TOOL_VERSION}
    rig = None
    try:
        rig = load_rig(bundle)
    except SvoxError as e:
        err("SCHEMA", str(e))
    vols, corners = {}, {}
    if rig is not None:
        if rig.get("schema") != SCHEMA_RIG:
            err("SCHEMA", "schema must be '%s' (got %r)" % (SCHEMA_RIG, rig.get("schema")))
        co = rig.get("coordinates", {})
        if co.get("up") != "+Z" or co.get("front") != "-Y" or co.get("handedness") != "right-handed":
            err("SCHEMA", "coordinates must be right-handed, up +Z, front -Y")
        if not isinstance(rig.get("parts"), list) or not rig["parts"]:
            err("SCHEMA", "parts[] missing or empty")
            rig["parts"] = []
        names = [p.get("name") for p in rig["parts"]]
        if len(set(names)) != len(names):
            err("SCHEMA", "duplicate part names")
        for p in rig["parts"]:
            nm = p.get("name", "?")
            miss = [k for k in ("name", "pivot", "restOffset", "size", "albedoPath", "albedoLayout") if k not in p]
            if miss:
                err("SCHEMA", "missing fields: %s" % ", ".join(miss), nm)
                continue
            if p.get("albedoLayout") != "strip_x":
                err("SCHEMA", "albedoLayout must be 'strip_x'", nm)
            if p.get("parent") and p["parent"] not in names:
                err("BAD_PARENT", "unknown parent '%s'" % p["parent"], nm)
            sx, sy, sz = p["size"]
            pv = p["pivot"]
            if any(pv[k] < -0.5 or pv[k] > p["size"][k] + 0.5 for k in range(3)):
                warn("PIVOT_OUTSIDE_VOLUME", "pivot %s lies outside the %dx%dx%d volume" % (pv, sx, sy, sz), nm)
            ap = bundle / p["albedoPath"]
            if not ap.exists():
                err("MISSING_FILE", "albedo %s not found" % p["albedoPath"], nm)
                continue
            try:
                w, h, rgba = png_read(ap)
            except SvoxError as e:
                err("BAD_PNG", str(e), nm)
                continue
            if w != sx * sz or h != sy:
                err("STRIP_DIMS", "albedo strip is %dx%d, expected %dx%d (sizeX*sizeZ x sizeY)" % (w, h, sx * sz, sy), nm)
                continue
            vol = strip_to_volume(rgba, sx, sy, sz)
            solids = _solid_voxels(vol, sx, sy, sz)
            if not solids:
                err("EMPTY_PART", "part has no solid voxels", nm)
                continue
            vols[nm] = vol
            cs = set()
            for (x, y, z) in solids:
                for c in range(8):
                    cs.add((x + (c & 1) - pv[0], y + ((c >> 1) & 1) - pv[1], z + ((c >> 2) & 1) - pv[2]))
            corners[nm] = list(cs)
            thin = _thin_fraction(vol, sx, sy, sz, solids)
            pinfo = {"solidVoxels": len(solids), "thinFraction": round(thin, 4)}
            if thin > 0.25:
                warn("THIN_PART", "%.0f%% of voxels are 1 voxel thick along some axis - thin blades/wings break up "
                     "under rotation; make them >= 2 voxels thick" % (thin * 100), nm)
            if p.get("normalAoPath"):
                npth = bundle / p["normalAoPath"]
                if not npth.exists():
                    err("MISSING_FILE", "normal_ao %s not found" % p["normalAoPath"], nm)
                else:
                    nw, nh, nrgba = png_read(npth)
                    if nw != w or nh != h:
                        err("STRIP_DIMS", "normal_ao strip is %dx%d, expected %dx%d" % (nw, nh, w, h), nm)
                    else:
                        st = normal_stats(vol, strip_to_volume(nrgba, sx, sy, sz), sx, sy, sz)
                        pinfo["normals"] = st
                        if st["unitFrac"] < 0.99:
                            err("NORMAL_INVALID", "only %.1f%% of surface normals are unit length" % (st["unitFrac"] * 100), nm)
                        if st["outwardFrac"] < 0.95:
                            err("NORMAL_INWARD", "only %.1f%% of surface normals point outward" % (st["outwardFrac"] * 100), nm)
                        if st["dilatedShellVoxels"] == 0:
                            warn("NO_DILATION", "normal_ao has no dilated empty shell voxels (LINEAR sampling will fade)", nm)
            else:
                warn("NORMAL_AO_MISSING", "no normalAoPath - run bake-normal-ao", nm)
            info[nm] = pinfo
        try:
            part_order(rig["parts"])
        except SvoxError as e:
            err("BAD_PARENT", str(e))
        for c in rig.get("clips", []):
            if c.get("duration", 0) <= 0:
                err("SCHEMA", "clip '%s' needs duration > 0" % c.get("name"))
            for ch in c.get("channels", []):
                ok = ch.get("channel") in (ROOT_CHANNELS if ch.get("part") == "@root" else PART_CHANNELS)
                if not ok or (ch.get("part") != "@root" and ch.get("part") not in names):
                    err("SCHEMA", "clip '%s': bad channel %s/%s" % (c.get("name"), ch.get("part"), ch.get("channel")))
                if ch.get("fn", "sin") not in ("sin", "ramp", "keys"):
                    err("SCHEMA", "clip '%s': unknown fn %s" % (c.get("name"), ch.get("fn")))
    report["parts"] = info
    can_pose = rig is not None and not any(e["code"] in ("SCHEMA", "BAD_PARENT") for e in errors) and len(corners) == len(rig["parts"])
    if can_pose:
        by = {p["name"]: p for p in rig["parts"]}
        # ---- ground contact at rest pose
        rest = evaluate_pose(rig, None, 0.0, rest=True)
        mins = {n: _part_world_minz(rest["parts"][n], by[n], corners[n]) for n in corners}
        lowest = min(mins.values())
        report["groundContact"] = {"restLowestZ": round(lowest, 4), "lowestPart": min(mins, key=mins.get),
                                   "tolerance": 0.5, "pass": abs(lowest) <= 0.5}
        if lowest < -0.5:
            err("GROUND_PENETRATION", "rest pose sinks %.2f voxels below z = 0" % -lowest, min(mins, key=mins.get))
        elif lowest > 0.5:
            warn("FLOATING", "rest pose floats %.2f voxels above z = 0" % lowest)
        # ---- clips: ground, squash range, loop seam
        clips_info = {}
        for c in rig.get("clips", []):
            dur = float(c["duration"])
            lo, sq_lo, sq_hi = float("inf"), 1.0, 1.0
            for k in range(17):
                ps = evaluate_pose(rig, c["name"], dur * k / 16.0)
                for n in corners:
                    lo = min(lo, _part_world_minz(ps["parts"][n], by[n], corners[n]))
                    s = ps["parts"][n]["deform"]["squashZ"]
                    sq_lo, sq_hi = min(sq_lo, s), max(sq_hi, s)
            a, b = evaluate_pose(rig, c["name"], 0.0), evaluate_pose(rig, c["name"], dur)
            seam = 0.0
            for n in corners:
                for q in corners[n][::max(1, len(corners[n]) // 64)]:
                    pa = m4_point(a["parts"][n]["matrix"], deform_point(q[0], q[1], q[2], a["parts"][n]["deform"], by[n]["size"][2], by[n]["pivot"][2]))
                    pb = m4_point(b["parts"][n]["matrix"], deform_point(q[0], q[1], q[2], b["parts"][n]["deform"], by[n]["size"][2], by[n]["pivot"][2]))
                    seam = max(seam, max(abs(pa[k] - pb[k]) for k in range(3)))
            clips_info[c["name"]] = {"lowestZ": round(lo, 4), "squashRange": [round(sq_lo, 4), round(sq_hi, 4)],
                                     "loopSeam": float("%.3g" % seam)}
            if lo < -0.5:
                warn("CLIP_GROUND_PENETRATION", "clip '%s' dips %.2f voxels below z = 0" % (c["name"], -lo))
            if sq_lo < 0.35 or sq_hi > 2.5:
                warn("SQUASH_RANGE", "clip '%s' squashZ range [%.2f, %.2f] leaves [0.35, 2.5]; xyScale clamps at 0.35" % (c["name"], sq_lo, sq_hi))
            if seam > 1e-3:
                warn("LOOP_SEAM", "clip '%s' pose(0) != pose(duration): %.3g voxels" % (c["name"], seam))
        report["clips"] = clips_info
        # ---- deform invertibility self-test (200 samples drawn from the bundle's own clips)
        rng = _Rng(20261125)
        max_err, samples = 0.0, 200
        clips = rig.get("clips", [])
        plist = list(corners)
        for i in range(samples):
            n = plist[int(rng.next() * len(plist)) % len(plist)]
            p = by[n]
            if clips:
                c = clips[int(rng.next() * len(clips)) % len(clips)]
                d = evaluate_pose(rig, c["name"], rng.range(0, float(c["duration"])))["parts"][n]["deform"]
            else:
                d = identity_deform()
            q = [rng.range(-p["pivot"][k], p["size"][k] - p["pivot"][k]) for k in range(3)]
            fwd = deform_point(q[0], q[1], q[2], d, p["size"][2], p["pivot"][2])
            back = undeform_point(fwd[0], fwd[1], fwd[2], d, p["size"][2], p["pivot"][2])
            max_err = max(max_err, math.sqrt(sum((back[k] - q[k]) ** 2 for k in range(3))))
        report["deformSelfTest"] = {"samples": samples, "maxError": float("%.3g" % max_err), "threshold": 1e-5,
                                    "pass": max_err < 1e-5}
        if not max_err < 1e-5:
            err("DEFORM_INVERT", "undeform(deform(p)) max error %.3g >= 1e-5" % max_err)
    report["errors"], report["warnings"] = errors, warnings
    report["ok"] = not errors
    save_json(args.output, report)
    print("validate: %s - %d error(s), %d warning(s)" % ("PASS" if report["ok"] else "FAIL", len(errors), len(warnings)))
    for e in (errors + warnings)[:20]:
        print("  %-7s %-22s %-12s %s" % ("ERROR" if e in errors else "warn", e["code"], e["part"] or "-", e["message"][:90]))
    if "groundContact" in report:
        print("  rest lowest z %.3f | deform self-test max err %.2e over %d samples" % (
            report["groundContact"]["restLowestZ"], report["deformSelfTest"]["maxError"], report["deformSelfTest"]["samples"]))
    print("  report -> %s" % args.output)
    return 0 if report["ok"] else 1


# ----------------------------------------------------------------------------------------------- init-demo
def _hash3(x, y, z, seed):
    h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 1442695041) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    h ^= h >> 16
    return (h % 10007) / 10007.0


def _shade(c, f):
    return tuple(max(0, min(255, int(round(v * f)))) for v in c)


class _Grid:
    """Authoring grid; (ox, oy, oz) shifts every write so parts keep a 1-voxel empty margin (room for the normal/AO
    shell dilation and for LINEAR sampling under CLAMP_TO_EDGE)."""
    def __init__(self, sx, sy, sz, origin=(0, 0, 0)):
        self.sx, self.sy, self.sz = sx, sy, sz
        self.ox, self.oy, self.oz = origin
        self.d = bytearray(sx * sy * sz * 4)

    def set(self, x, y, z, c):
        x, y, z = x + self.ox, y + self.oy, z + self.oz
        if 0 <= x < self.sx and 0 <= y < self.sy and 0 <= z < self.sz:
            i = ((z * self.sy + y) * self.sx + x) * 4
            self.d[i:i + 4] = bytes((c[0], c[1], c[2], 255))

    def clear(self, x, y, z):
        if 0 <= x < self.sx and 0 <= y < self.sy and 0 <= z < self.sz:
            i = ((z * self.sy + y) * self.sx + x) * 4
            self.d[i:i + 4] = b"\x00\x00\x00\x00"

    def solid(self, x, y, z):
        return 0 <= x < self.sx and 0 <= y < self.sy and 0 <= z < self.sz and self.d[((z * self.sy + y) * self.sx + x) * 4 + 3] > 0

    def box(self, x0, y0, z0, x1, y1, z1, fn):
        for z in range(z0, z1 + 1):
            for y in range(y0, y1 + 1):
                for x in range(x0, x1 + 1):
                    c = fn(x, y, z)
                    if c:
                        self.set(x, y, z, c)


def _demo_torso():
    g = _Grid(14, 10, 17, (1, 1, 0))
    teal, dark, gold, visor = (52, 150, 150), (44, 52, 70), (230, 178, 60), (255, 226, 120)

    def var(c, x, y, z, s):
        return _shade(c, 0.9 + 0.18 * _hash3(x, y, z, s))
    # legs (z 0..4)
    for lx in (1, 7):
        g.box(lx, 2, 0, lx + 3, 5, 4, lambda x, y, z: var(dark if z > 0 else (30, 34, 46), x, y, z, 3))
    # body (z 5..12) with chamfered vertical edges
    g.box(0, 0, 5, 11, 7, 12, lambda x, y, z: None if ((x in (0, 11)) and (y in (0, 7))) else
          var(gold if z == 6 else teal, x, y, z, 1))
    # chest plate highlight on the front (y = 0)
    g.box(3, 0, 8, 8, 0, 11, lambda x, y, z: var((80, 190, 182), x, y, z, 2))
    # head (z 13..15) with a glowing visor on the front
    g.box(2, 1, 13, 9, 6, 15, lambda x, y, z: var(visor if (y == 1 and z == 14 and 3 <= x <= 8) else (60, 132, 140), x, y, z, 4))
    g.box(4, 3, 15, 7, 4, 15, lambda x, y, z: var(gold, x, y, z, 5))
    return g


def _demo_arm():
    g = _Grid(7, 15, 14, (1, 1, 0))
    metal, edge, grip, pad = (196, 206, 220), (240, 244, 250), (92, 62, 40), (230, 178, 60)
    g.box(0, 8, 9, 4, 13, 12, lambda x, y, z: _shade(pad, 0.9 + 0.15 * _hash3(x, y, z, 7)))          # shoulder pad
    g.box(1, 9, 3, 3, 12, 8, lambda x, y, z: _shade((52, 150, 150), 0.88 + 0.15 * _hash3(x, y, z, 8)))  # arm
    g.box(1, 8, 1, 3, 12, 3, lambda x, y, z: _shade(grip, 0.9 + 0.2 * _hash3(x, y, z, 9)))           # fist
    # 2-voxel-thick blade pointing forward (-Y): x 1..2, z 1..3, tapering to a tip at y 0
    for y in range(0, 8):
        top = 3 if y >= 2 else (2 if y == 1 else 2)
        bot = 1 if y >= 1 else 2
        for z in range(bot, top + 1):
            for x in (1, 2):
                g.set(x, y, z, edge if z == top else metal)
    return g


def _demo_cape():
    g = _Grid(12, 4, 11, (1, 1, 0))
    red, trim = (178, 44, 60), (230, 178, 60)
    for z in range(10):
        half = 4 + (1 if z >= 4 else 0)
        for y in range(2):
            for x in range(5 - half, 5 + half):
                c = trim if z == 9 else _shade(red, (0.86 + 0.08 * (x % 2)) * (0.92 + 0.12 * _hash3(x, y, z, 11)))
                g.set(x, y, z, c)
    return g


def _demo_cube_vox():
    pal = [(0, 0, 0, 0)] * 256
    pal[1], pal[2], pal[3] = (220, 70, 60, 255), (70, 170, 90, 255), (60, 110, 220, 255)
    vox = []
    for z in range(6):
        for y in range(6):
            for x in range(6):
                vox.append((x, y, z, 1 if z < 2 else (2 if z < 4 else 3)))
    return [((6, 6, 6), vox)], pal


def cmd_init_demo(args):
    out = Path(args.out)
    rig = new_rig(9.0)
    torso, arm, cape = _demo_torso(), _demo_arm(), _demo_cape()
    p_torso = make_part("torso", (14, 10, 17), (7, 5, 0), None, (0, 0, 0), "torso")
    p_arm = make_part("arm_blade", (7, 15, 14), (3.5, 12, 12), "torso", (7.5, 0, 12.5), "rigid")
    p_cape = make_part("cape", (12, 4, 11), (6, 2, 0), "torso", (0, 5, 12), "cloth", flipped=True)
    for part, g in ((p_torso, torso), (p_arm, arm), (p_cape, cape)):
        write_part_albedo(out, part, g.d)
        rig["parts"].append(part)
    tau = 2.0 * math.pi
    rig["clips"] = [
        {"name": "idle", "duration": 2.0, "loop": True, "channels": [
            {"part": "torso", "channel": "squashZ", "fn": "sin", "amp": 0.035, "cycles": 2},
            {"part": "torso", "channel": "rotZ", "fn": "sin", "amp": 0.06, "cycles": 1},
            {"part": "arm_blade", "channel": "rotX", "fn": "sin", "bias": -0.12, "amp": 0.10, "cycles": 2, "phase": 0.6},
            {"part": "cape", "channel": "shearY", "fn": "sin", "bias": -0.22, "amp": 0.05, "cycles": 2},
            {"part": "cape", "channel": "waveAmpX", "fn": "sin", "bias": 0.45, "amp": 0.15, "cycles": 1},
            {"part": "cape", "channel": "waveAmpY", "fn": "sin", "bias": 0.55, "amp": 0.2, "cycles": 2},
            {"part": "cape", "channel": "waveFreq", "fn": "sin", "bias": 5.0, "amp": 0.0, "cycles": 1},
            {"part": "cape", "channel": "wavePhase", "fn": "ramp", "amp": -tau, "cycles": 2}]},
        {"name": "swing", "duration": 1.2, "loop": True, "channels": [
            {"part": "@root", "channel": "posZ", "fn": "sin", "bias": 0.25, "amp": 0.25, "cycles": 1, "phase": -1.5707963},
            {"part": "torso", "channel": "rotZ", "fn": "sin", "amp": 0.35, "cycles": 1},
            {"part": "torso", "channel": "squashZ", "fn": "sin", "amp": 0.06, "cycles": 2, "phase": 1.5707963},
            {"part": "torso", "channel": "twistZ", "fn": "sin", "amp": 0.12, "cycles": 1},
            {"part": "arm_blade", "channel": "rotX", "fn": "sin", "bias": -0.45, "amp": 0.45, "cycles": 1, "phase": 1.5707963},
            {"part": "arm_blade", "channel": "rotZ", "fn": "sin", "amp": 0.25, "cycles": 1},
            {"part": "cape", "channel": "shearY", "fn": "sin", "bias": -0.35, "amp": 0.12, "cycles": 1},
            {"part": "cape", "channel": "shearX", "fn": "sin", "amp": 0.18, "cycles": 1, "phase": 3.14159265},
            {"part": "cape", "channel": "waveAmpY", "fn": "sin", "bias": 0.8, "amp": 0.3, "cycles": 2},
            {"part": "cape", "channel": "waveFreq", "fn": "sin", "bias": 6.0, "amp": 0.0, "cycles": 1},
            {"part": "cape", "channel": "wavePhase", "fn": "ramp", "amp": -tau, "cycles": 3}]}]
    save_json(out / "rig.json", rig)
    models, pal = _demo_cube_vox()
    vox_write(out / "sample_cube.vox", models, pal)
    print("init-demo: torso 14x10x17 + arm_blade 7x15x14 (2-voxel blade) + flipped cape 12x4x11, 2 clips, sample_cube.vox -> %s" % out)
    return cmd_bake(argparse.Namespace(bundle=str(out)))


# =============================================================================================== main
def build_parser():
    ap = argparse.ArgumentParser(prog="svox_cli.py", description="Engine-neutral SVOX asset pipeline (stdlib only).")
    sub = ap.add_subparsers(dest="cmd")
    s = sub.add_parser("init-demo", help="write the minimal 3-part reference bundle (baked)")
    s.add_argument("--out", required=True)
    s.set_defaults(func=cmd_init_demo)
    s = sub.add_parser("from-vox", help="MagicaVoxel .vox (single or multi-model) -> SVOX bundle")
    s.add_argument("--input", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--part-name", default=None)
    s.add_argument("--rotate-z180", action="store_true", help="model faces +Y in MagicaVoxel: rotate 180 deg about Z")
    s.add_argument("--bake", action="store_true")
    s.set_defaults(func=cmd_from_vox)
    s = sub.add_parser("from-strip", help="horizontal slice-strip PNG (w = X*Z, h = Y) -> SVOX part")
    s.add_argument("--input", required=True)
    s.add_argument("--size-x", type=int, required=True)
    s.add_argument("--size-y", type=int, required=True)
    s.add_argument("--size-z", type=int, required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--part-name", required=True)
    s.add_argument("--pivot", default=None, help="X,Y,Z voxel coords (default bottom centre)")
    s.add_argument("--parent", default=None)
    s.add_argument("--rest-offset", default=None, help="X,Y,Z in the parent's pivot-relative space")
    s.add_argument("--deform-role", default="rigid")
    s.add_argument("--flipped-cloth", action="store_true")
    s.add_argument("--bake", action="store_true")
    s.set_defaults(func=cmd_from_strip)
    s = sub.add_parser("bake-normal-ao", help="bake parts/<name>.normal_ao.png for every part")
    s.add_argument("--bundle", required=True)
    s.set_defaults(func=cmd_bake)
    s = sub.add_parser("validate", help="schema / strips / normals / thin parts / ground / deform self-test")
    s.add_argument("--bundle", required=True)
    s.add_argument("--output", required=True)
    s.set_defaults(func=cmd_validate)
    s = sub.add_parser("pack-atlas", help="export strip_x / grid_2d / raw_3d engine assets")
    s.add_argument("--bundle", required=True)
    s.add_argument("--format", required=True, choices=["strip_x", "grid_2d", "raw_3d"])
    s.add_argument("--out", required=True)
    s.set_defaults(func=cmd_pack)
    return ap


def main(argv=None):
    ap = build_parser()
    args = ap.parse_args(argv)
    if not getattr(args, "func", None):
        ap.print_help()
        return 1
    try:
        return args.func(args)
    except SvoxError as e:
        print("error: %s" % e, file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, struct.error, zlib.error) as e:
        print("error: %s: %s" % (type(e).__name__, e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
