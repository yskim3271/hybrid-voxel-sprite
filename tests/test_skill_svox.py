#!/usr/bin/env python3
# /// script
# requires-python = ">=3.8"
# dependencies = []
# ///
"""Verification suite for the hybrid-voxel-sprite agent skill (skills/hybrid-voxel-sprite).

    python tests/test_skill_svox.py        or        uv run tests/test_skill_svox.py
    SKIP_WEBGL=1 python tests/test_skill_svox.py      (standalone repo: no origin renderer / browser harness)

Standard library only. Covers svox_cli.py (init-demo, from-vox, from-strip, bake-normal-ao, validate, pack-atlas),
byte-exact parity of the Python normal/AO bake with the verified JS core, SKILL.md frontmatter + size, relative-link
integrity across SKILL.md and references/**/*.md, and (only inside the origin repo) the real WebGL2 smoke render.

Standalone adaptation of the origin repo's tests/test_skill_svox.py:
- the skill lives in skills/hybrid-voxel-sprite (origin: .agents/skills/hybrid-voxel-sprite);
- QA reports go to $SVOX_QA_DIR or <repo>/.qa_out (git-ignored), never into the skill folder;
- JS-core bake parity compares against tests/fixtures/js_core_bake_sha256.json, recorded from the origin repo's
  src/core/voxel_builder.js. Set SVOX_JS_CORE=/path/to/voxel_builder.js (and have node) to re-run it live;
- T09_WebGLSmoke needs the origin repo's renderer + CDP harness; it is skipped when they are absent or SKIP_WEBGL=1.
"""
import importlib.util
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILL = ROOT / "skills" / "hybrid-voxel-sprite"
CLI = SKILL / "scripts" / "svox_cli.py"
REF = SKILL / "assets" / "minimal_reference"
QA = Path(os.environ.get("SVOX_QA_DIR") or (ROOT / ".qa_out"))
FIXTURES = ROOT / "tests" / "fixtures"
JS_CORE = Path(os.environ["SVOX_JS_CORE"]) if os.environ.get("SVOX_JS_CORE") else None
CRLF, LF = bytes((13, 10)), bytes((10,))

sys.dont_write_bytecode = True  # keep the skill folder clean (no scripts/__pycache__)
_spec = importlib.util.spec_from_file_location("svox_cli", str(CLI))
svox = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(svox)

EXPECTED_FILES = [
    "SKILL.md", "scripts/svox_cli.py",
    "references/01_contract_and_math.md", "references/02_shader_pipeline_spec.md", "references/03_pitfalls_and_qa_gates.md",
    "references/targets/webgl2_threejs.md", "references/targets/godot4.md", "references/targets/unity_urp.md",
    "references/targets/blender_exporter.md",
    "assets/minimal_reference/rig.json", "assets/minimal_reference/sample_cube.vox",
    "assets/minimal_reference/parts/torso.albedo.png", "assets/minimal_reference/parts/torso.normal_ao.png",
    "assets/minimal_reference/parts/arm_blade.albedo.png", "assets/minimal_reference/parts/arm_blade.normal_ao.png",
    "assets/minimal_reference/parts/cape.albedo.png", "assets/minimal_reference/parts/cape.normal_ao.png",
]
EXPECTED_DESCRIPTION = (
    "Build real-time articulated 3D pixel-art sprite renderers using modular voxel parts, per-part OBB 3D volume "
    "raymarching, analytic per-slice inverse deformation (squash/twist/shear/wave), spring secondary motion, dynamic 3D "
    "cel lighting/AO/self-shadow, pixel-perfect virtual grid snapping, and 1px depth/normal auto-outlines. Includes an "
    "engine-neutral SVOX asset pipeline CLI (.vox and slice-strip import, 3D normal/AO baking, rig validation) plus "
    "target adapters for WebGL2/Three.js (Verified), Godot 4, Unity URP, and Blender export.")


def run_cli(*args, expect=0):
    p = subprocess.run([sys.executable, str(CLI)] + [str(a) for a in args], capture_output=True, text=True)
    out = p.stdout + p.stderr
    if expect is not None and p.returncode != expect:
        raise AssertionError("svox_cli %s exited %d (expected %d):\n%s" % (" ".join(map(str, args)), p.returncode, expect, out))
    assert len(p.stdout.splitlines()) < 30, "stdout must stay < 30 lines, got %d" % len(p.stdout.splitlines())
    return p.returncode, out


def vol_index(sx, sy, x, y, z):
    return ((z * sy + y) * sx + x) * 4


def write_part_strip(path, vol, sx, sy, sz):
    svox.png_write(path, sx * sz, sy, svox.volume_to_strip(vol, sx, sy, sz))


def make_vol(sx, sy, sz, fn):
    v = bytearray(sx * sy * sz * 4)
    for z in range(sz):
        for y in range(sy):
            for x in range(sx):
                c = fn(x, y, z)
                if c:
                    v[vol_index(sx, sy, x, y, z):vol_index(sx, sy, x, y, z) + 4] = bytes((c[0], c[1], c[2], 255))
    return v


def ref_png_encode(w, h, rgba, filters, channels=4):
    """Reference encoder emitting arbitrary filter types per row (to test the decoder on filters 2..4 and RGB)."""
    stride, raw, prev = w * channels, bytearray(), bytearray(w * channels)
    for y in range(h):
        row = bytearray(rgba[y * stride:(y + 1) * stride])
        ft = filters[y % len(filters)]
        out = bytearray(stride)
        for i in range(stride):
            a = row[i - channels] if i >= channels else 0
            b = prev[i]
            c = prev[i - channels] if i >= channels else 0
            pred = [0, a, b, (a + b) >> 1, svox._paeth(a, b, c)][ft]
            out[i] = (row[i] - pred) & 0xFF
        raw.append(ft)
        raw += out
        prev = row

    def chunk(t, b):
        return struct.pack(">I", len(b)) + t + b + struct.pack(">I", zlib.crc32(t + b) & 0xFFFFFFFF)
    ct = 6 if channels == 4 else 2
    return svox.PNG_SIG + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, ct, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(bytes(raw))) + chunk(b"IEND", b"")


class Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="svox_test_"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


# ============================================================================================ files + init-demo
class T01_InitDemo(Tmp):
    def test_inventory(self):
        missing = [f for f in EXPECTED_FILES if not (SKILL / f).is_file()]
        self.assertEqual(missing, [], "missing skill files")

    def test_init_demo_regenerates_committed_reference_identical(self):
        """JSON (modulo CRLF/LF) and .vox must be byte-identical; PNGs pixel-identical (zlib builds differ across Python versions, so
        the compressed IDAT bytes may legitimately differ while the decoded RGBA8 is identical)."""
        out = self.tmp / "demo"
        run_cli("init-demo", "--out", out)
        files = sorted(p.relative_to(REF).as_posix() for p in REF.rglob("*") if p.is_file())
        self.assertIn("rig.json", files)
        self.assertEqual(files, sorted(p.relative_to(out).as_posix() for p in out.rglob("*") if p.is_file()))
        for f in files:
            if f.endswith(".png"):
                self.assertEqual(svox.png_read(REF / f), svox.png_read(out / f), "init-demo pixels differ: " + f)
            elif f.endswith(".json"):  # text: git may check out LF or CRLF (core.autocrlf), so compare normalised EOLs
                self.assertEqual((REF / f).read_bytes().replace(CRLF, LF), (out / f).read_bytes().replace(CRLF, LF),
                                 "init-demo output differs: " + f)
            else:
                self.assertEqual((REF / f).read_bytes(), (out / f).read_bytes(), "init-demo output differs: " + f)

    def test_demo_contents(self):
        rig = json.loads((REF / "rig.json").read_text())
        self.assertEqual(rig["schema"], "svox.rig/v1")
        self.assertEqual(rig["coordinates"], {"handedness": "right-handed", "up": "+Z", "front": "-Y", "unit": "1 voxel", "ground": "z = 0"})
        names = [p["name"] for p in rig["parts"]]
        self.assertEqual(names, ["torso", "arm_blade", "cape"])
        by = {p["name"]: p for p in rig["parts"]}
        self.assertTrue(by["cape"]["flippedCloth"])
        self.assertEqual(by["cape"]["pivot"][2], 0.0, "flipped cloth: uZ = 0 pinned at the mount")
        for p in rig["parts"]:
            sx, sy, sz = p["size"]
            w, h, _ = svox.png_read(REF / p["albedoPath"])
            self.assertEqual((w, h), (sx * sz, sy))
            self.assertEqual(p["normalAoPath"], "parts/%s.normal_ao.png" % p["name"])
        # 2-voxel blade: every blade voxel row (y < 8 in the arm grid) is exactly 2 voxels thick along X
        arm = by["arm_blade"]
        vol = svox.read_part_volume(REF, arm)
        sx, sy, sz = arm["size"]
        widths = set()
        for y in range(1, 9):
            for z in range(sz):
                xs = [x for x in range(sx) if vol[vol_index(sx, sy, x, y, z) + 3]]
                if xs:
                    widths.add(len(xs))
        self.assertEqual(widths, {2})
        self.assertEqual({c["name"] for c in rig["clips"]}, {"idle", "swing"})


# ============================================================================================ PNG codec
class T02_PNG(Tmp):
    def test_roundtrip_filters_0_1(self):
        w, h = 23, 7
        data = bytearray((i * 37 + (i // 4) * 11) & 0xFF for i in range(w * h * 4))
        for ft in (0, 1):
            p = self.tmp / ("f%d.png" % ft)
            svox.png_write(p, w, h, data, ft)
            self.assertEqual(svox.png_read(p), (w, h, data))

    def test_decoder_filters_2_3_4_and_rgb(self):
        w, h = 9, 10
        rgba = bytearray((i * 53 + 7) & 0xFF for i in range(w * h * 4))
        p = self.tmp / "mix.png"
        p.write_bytes(ref_png_encode(w, h, rgba, [0, 1, 2, 3, 4]))
        self.assertEqual(svox.png_read(p)[2], rgba)
        rgb = bytearray((i * 29 + 3) & 0xFF for i in range(w * h * 3))
        p.write_bytes(ref_png_encode(w, h, rgb, [4, 3, 2, 1, 0], channels=3))
        out = svox.png_read(p)[2]
        self.assertEqual(bytes(out[0::4]), bytes(rgb[0::3]))
        self.assertEqual(set(out[3::4]), {255})

    def test_crc_corruption_detected(self):
        p = self.tmp / "c.png"
        svox.png_write(p, 2, 2, bytearray(16))
        b = bytearray(p.read_bytes())
        b[40] ^= 0xFF
        p.write_bytes(bytes(b))
        with self.assertRaises(svox.SvoxError):
            svox.png_read(p)


# ============================================================================================ .vox import
class T03_FromVox(Tmp):
    def test_default_palette_layout(self):
        pal = svox.default_vox_palette()
        self.assertEqual(pal[1], (255, 255, 255, 255))
        self.assertEqual(pal[2], (255, 255, 204, 255))   # 0xffccffff
        self.assertEqual(pal[7], (255, 204, 255, 255))   # 0xffffccff
        self.assertEqual(pal[215], (0, 0, 51, 255))
        self.assertEqual(pal[216], (238, 0, 0, 255))     # 0xff0000ee
        self.assertEqual(pal[226], (0, 238, 0, 255))
        self.assertEqual(pal[236], (0, 0, 238, 255))
        self.assertEqual(pal[255], (17, 17, 17, 255))

    def test_sample_cube_roundtrip(self):
        vx = svox.vox_read(REF / "sample_cube.vox")
        self.assertEqual(len(vx["models"]), 1)
        self.assertEqual(vx["models"][0]["size"], (6, 6, 6))
        out = self.tmp / "cube"
        run_cli("from-vox", "--input", REF / "sample_cube.vox", "--out", out, "--part-name", "cube", "--bake")
        rig = json.loads((out / "rig.json").read_text())
        part = rig["parts"][0]
        self.assertEqual((part["name"], part["size"], part["pivot"]), ("cube", [6, 6, 6], [3.0, 3.0, 0.0]))
        self.assertEqual(part["restOffset"], [0.0, 0.0, 0.0])
        vol = svox.read_part_volume(out, part)
        expect = {0: (220, 70, 60), 1: (220, 70, 60), 2: (70, 170, 90), 3: (70, 170, 90), 4: (60, 110, 220), 5: (60, 110, 220)}
        n = 0
        for (x, y, z, ci) in vx["models"][0]["voxels"]:
            i = vol_index(6, 6, x, y, z)
            self.assertEqual(tuple(vol[i:i + 4]), expect[z] + (255,))
            n += 1
        self.assertEqual(n, 216)
        self.assertEqual(sum(1 for i in range(3, len(vol), 4) if vol[i]), 216)
        run_cli("validate", "--bundle", out, "--output", out / "report.json")

    def test_multi_model_scene_graph_split(self):
        pal = [(0, 0, 0, 0)] + [(i, 255 - i, (i * 7) & 255, 255) for i in range(1, 256)]
        body = [(x, y, z, 10) for z in range(8) for y in range(4) for x in range(6)]
        head = [(x, y, z, 20 + z) for z in range(4) for y in range(4) for x in range(4)]
        tail = [(x, y, 0, 99) for y in range(5) for x in range(2)]
        f = self.tmp / "multi.vox"
        svox.vox_write(f, [((6, 4, 8), body), ((4, 4, 4), head), ((2, 5, 1), tail)], pal,
                       names=["body", "head", "tail"], translations=[(0, 0, 4), (0, -1, 10), (0, 4, 2)])
        out = self.tmp / "multi"
        _, log = run_cli("from-vox", "--input", f, "--out", out)
        rig = json.loads((out / "rig.json").read_text())
        by = {p["name"]: p for p in rig["parts"]}
        self.assertEqual(sorted(by), ["body", "head", "tail"])
        self.assertIsNone(by["body"]["parent"])
        self.assertEqual(by["head"]["parent"], "body")
        for name, vox, size in (("body", body, (6, 4, 8)), ("head", head, (4, 4, 4)), ("tail", tail, (2, 5, 1))):
            p = by[name]
            self.assertEqual(p["size"], list(size))
            vol = svox.read_part_volume(out, p)
            self.assertEqual(sum(1 for i in range(3, len(vol), 4) if vol[i]), len(vox))
            for (x, y, z, ci) in vox:
                i = vol_index(size[0], size[1], x, y, z)
                self.assertEqual(tuple(vol[i:i + 4]), pal[ci][:3] + (255,))
        # world placement: MagicaVoxel model min corner = t - floor(size/2); lowest voxel lands on z = 0
        def world_min(name, t, size):
            return [t[k] - size[k] // 2 for k in range(3)]
        bmin, hmin = world_min("body", (0, 0, 4), (6, 4, 8)), world_min("head", (0, -1, 10), (4, 4, 4))
        self.assertAlmostEqual(by["body"]["restOffset"][2], 0.0)   # body bottom (z 0) is the lowest voxel
        rel = [(hmin[k] + by["head"]["pivot"][k]) - (bmin[k] + by["body"]["pivot"][k]) for k in range(3)]
        self.assertEqual([round(v, 6) for v in by["head"]["restOffset"]], [round(v, 6) for v in rel])
        rest = svox.evaluate_pose(rig, None, 0, rest=True)
        hp = svox.m4_point(rest["parts"]["head"]["matrix"], [-2.0, -2.0, 0.0])  # head voxel (0,0,0) corner
        bp = svox.m4_point(rest["parts"]["body"]["matrix"], [-3.0, -2.0, 0.0])
        self.assertEqual([round(hp[k] - bp[k], 6) for k in range(3)], [float(hmin[k] - bmin[k]) for k in range(3)])

    def test_default_palette_used_without_rgba_chunk(self):
        f = self.tmp / "nopal.vox"
        svox.vox_write(f, [((2, 2, 2), [(0, 0, 0, 216), (1, 1, 1, 7)])])
        out = self.tmp / "np"
        run_cli("from-vox", "--input", f, "--out", out, "--part-name", "p")
        part = json.loads((out / "rig.json").read_text())["parts"][0]
        vol = svox.read_part_volume(out, part)
        self.assertEqual(tuple(vol[0:4]), (238, 0, 0, 255))
        self.assertEqual(tuple(vol[vol_index(2, 2, 1, 1, 1):vol_index(2, 2, 1, 1, 1) + 4]), (255, 204, 255, 255))

    def test_bad_magic_exits_1(self):
        f = self.tmp / "bad.vox"
        f.write_bytes(b"NOPE" + b"\x00" * 20)
        code, out = run_cli("from-vox", "--input", f, "--out", self.tmp / "x", expect=1)
        self.assertIn("magic", out)


# ============================================================================================ strip import
class T04_FromStrip(Tmp):
    def test_strip_roundtrip(self):
        sx, sy, sz = 5, 4, 6
        vol = make_vol(sx, sy, sz, lambda x, y, z: (x * 40 + 10, y * 50 + 5, z * 30 + 1) if (x + y + z) % 3 else None)
        src = self.tmp / "strip.png"
        write_part_strip(src, vol, sx, sy, sz)
        out = self.tmp / "b"
        run_cli("from-strip", "--input", src, "--size-x", sx, "--size-y", sy, "--size-z", sz, "--out", out, "--part-name", "blk",
                "--pivot", "2.5,2,0")
        rig = json.loads((out / "rig.json").read_text())
        self.assertEqual(rig["parts"][0]["pivot"], [2.5, 2.0, 0.0])
        self.assertEqual(svox.read_part_volume(out, rig["parts"][0]), vol)
        # strip_x layout: slice z at columns z*sx.., row = y
        w, h, rgba = svox.png_read(out / "parts/blk.albedo.png")
        self.assertEqual((w, h), (sx * sz, sy))
        for (x, y, z) in ((1, 2, 4), (4, 3, 5), (0, 1, 1)):
            self.assertEqual(rgba[(y * w + z * sx + x) * 4:(y * w + z * sx + x) * 4 + 4], vol[vol_index(sx, sy, x, y, z):vol_index(sx, sy, x, y, z) + 4])
        # second import merges into the same bundle
        run_cli("from-strip", "--input", src, "--size-x", sx, "--size-y", sy, "--size-z", sz, "--out", out, "--part-name", "blk2",
                "--parent", "blk", "--rest-offset", "0,0,6")
        self.assertEqual([p["name"] for p in json.loads((out / "rig.json").read_text())["parts"]], ["blk", "blk2"])

    def test_wrong_dimensions_exit_1(self):
        src = self.tmp / "s.png"
        svox.png_write(src, 10, 4, bytearray(10 * 4 * 4))
        code, out = run_cli("from-strip", "--input", src, "--size-x", 3, "--size-y", 4, "--size-z", 3, "--out", self.tmp / "o",
                            "--part-name", "x", expect=1)
        self.assertIn("strip", out)


# ============================================================================================ normal / AO bake
def bake_volume(test, vol, sx, sy, sz, name="p"):
    src = test.tmp / (name + ".png")
    write_part_strip(src, vol, sx, sy, sz)
    out = test.tmp / ("bundle_" + name)
    run_cli("from-strip", "--input", src, "--size-x", sx, "--size-y", sy, "--size-z", sz, "--out", out, "--part-name", name, "--bake")
    part = json.loads((out / "rig.json").read_text())["parts"][0]
    return svox.read_part_volume(out, part, "normalAoPath"), json.loads((out / "bake_stats.json").read_text())["parts"][name]


def sphere_vol():
    return make_vol(20, 20, 20, lambda x, y, z: (200, 100, 50) if (x + .5 - 10) ** 2 + (y + .5 - 10) ** 2 + (z + .5 - 10) ** 2 <= 36 else None)


def crevice_vol():
    return make_vol(16, 16, 16, lambda x, y, z: (90, 90, 90) if (z <= 3 or y >= 12) else None)


def mushroom_vol():
    return make_vol(20, 20, 16, lambda x, y, z: (90, 90, 90) if ((8 <= x <= 11 and 8 <= y <= 11 and z <= 11) or (2 <= x <= 17 and 2 <= y <= 17 and 12 <= z <= 14)) else None)


class T05_Bake(Tmp):
    def test_sphere_unit_outward_convex_ao_open(self):
        nao, st = bake_volume(self, sphere_vol(), 20, 20, 20, "sphere")
        vol = sphere_vol()
        self.assertEqual(st["unitFrac"], 1.0)
        self.assertGreaterEqual(st["outwardFrac"], 0.99)
        self.assertGreaterEqual(st["aoMin"], 0.99, "convex staircase must not darken (AO = 1.00)")
        radial, n = 0.0, 0
        for z in range(20):
            for y in range(20):
                for x in range(20):
                    i = vol_index(20, 20, x, y, z)
                    r = [x + .5 - 10, y + .5 - 10, z + .5 - 10]
                    L = math.sqrt(sum(v * v for v in r))
                    if not vol[i + 3] or L < 4.8:
                        continue
                    nv = [nao[i + k] / 127.5 - 1 for k in range(3)]
                    radial += sum(nv[k] * r[k] / L for k in range(3))
                    n += 1
        self.assertGreater(radial / n, 0.95)

    def test_concave_crevice_and_overhang_darken(self):
        nao, _ = bake_volume(self, crevice_vol(), 16, 16, 16, "crev")
        ao = lambda x, y, z: nao[vol_index(16, 16, x, y, z) + 3] / 255.0  # noqa: E731
        self.assertLess(ao(8, 11, 3), 0.70, "crevice AO")
        self.assertGreater(ao(8, 4, 3), 0.95, "open floor AO")
        self.assertGreater(nao[vol_index(16, 16, 8, 4, 3) + 2], 250, "flat floor normal = +Z")
        self.assertLess(nao[vol_index(16, 16, 8, 4, 0) + 2], 128, "bottom face at z = 0 keeps a downward normal")
        mush, _ = bake_volume(self, mushroom_vol(), 20, 20, 16, "mush")
        mao = lambda x, y, z: mush[vol_index(20, 20, x, y, z) + 3] / 255.0  # noqa: E731
        self.assertLess(mao(8, 10, 11), mao(8, 10, 4) - 0.2, "overhang darkens")

    def test_one_voxel_shell_dilation(self):
        nao, st = bake_volume(self, sphere_vol(), 20, 20, 20, "sph2")
        vol = sphere_vol()
        self.assertGreater(st["dilatedShellVoxels"], 0)
        shell = 0
        for z in range(20):
            for y in range(20):
                for x in range(20):
                    i = vol_index(20, 20, x, y, z)
                    if vol[i + 3]:
                        continue
                    touching = any(0 <= x + dx < 20 and 0 <= y + dy < 20 and 0 <= z + dz < 20 and vol[vol_index(20, 20, x + dx, y + dy, z + dz) + 3]
                                   for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1))
                    dilated = bytes(nao[i:i + 4]) != b"\x80\x80\xff\xff"
                    if not touching:
                        self.assertFalse(dilated, "only the 26-neighbour shell may be written")
                        continue
                    r = [x + .5 - 10, y + .5 - 10, z + .5 - 10]
                    L = math.sqrt(sum(v * v for v in r))
                    if not dilated:  # a shell texel can legitimately equal the default (+Z normal, AO open): top cap only
                        self.assertGreater(r[2] / L, 0.85, "undilated shell voxel away from the top cap")
                        continue
                    shell += 1
                    self.assertGreater(sum((nao[i + k] / 127.5 - 1) * r[k] for k in range(3)), 0, "shell normal points outward")
        self.assertGreater(shell, 500)
        self.assertEqual(shell, st["dilatedShellVoxels"])

    def _parity_cases(self):
        cases = {"sphere": (sphere_vol(), 20, 20, 20), "crevice": (crevice_vol(), 16, 16, 16), "mushroom": (mushroom_vol(), 20, 20, 16)}
        rig = json.loads((REF / "rig.json").read_text())
        for p in rig["parts"]:
            sx, sy, sz = p["size"]
            cases["ref_" + p["name"]] = (svox.read_part_volume(REF, p), sx, sy, sz)
        return cases, rig

    def test_python_bake_matches_recorded_js_core_sha256(self):
        """Python bake == sha256 of the verified JS core output, recorded from the origin repo (no node needed)."""
        import hashlib
        golden = json.loads((FIXTURES / "js_core_bake_sha256.json").read_text(encoding="utf-8"))["cases"]
        cases, rig = self._parity_cases()
        self.assertEqual(sorted(golden), sorted(cases))
        report = {}
        for k, (vol, sx, sy, sz) in cases.items():
            py = bytes(svox.compute_normal_ao(vol, sx, sy, sz))
            self.assertEqual(golden[k]["size"], [sx, sy, sz], k)
            self.assertEqual(len(py), golden[k]["bytes"], k)
            report[k] = hashlib.sha256(py).hexdigest() == golden[k]["sha256"]
            if k.startswith("ref_"):
                pr = next(q for q in rig["parts"] if "ref_" + q["name"] == k)
                self.assertEqual(svox.read_part_volume(REF, pr, "normalAoPath"), py, "committed normal_ao.png == bake")
        QA.mkdir(parents=True, exist_ok=True)
        (QA / "bake_parity_recorded_js_sha256.json").write_text(json.dumps({"match": report}, indent=2) + "\n")
        self.assertEqual(report, {k: True for k in cases}, "sha256 mismatches vs recorded JS core output")

    @unittest.skipUnless(shutil.which("node") and JS_CORE is not None and JS_CORE.exists(),
                         "live JS parity needs node + SVOX_JS_CORE=<origin>/src/core/voxel_builder.js")
    def test_python_bake_is_byte_identical_to_js_core(self):
        """Ports must match src/core/voxel_builder.js computeNormalAndAO exactly (each case in a fresh vm context)."""
        cases, rig = self._parity_cases()
        payload = {k: {"data": bytes(v[0]).hex(), "size": list(v[1:])} for k, v in cases.items()}
        inp = self.tmp / "cases.json"
        inp.write_text(json.dumps(payload))
        js = (
            "const fs=require('fs'),vm=require('vm');"
            "const src=fs.readFileSync(process.argv[1],'utf8');const cases=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));const out={};"
            "for(const k of Object.keys(cases)){const ctx={};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(src,ctx);"
            "const c=cases[k];const d=Uint8Array.from(Buffer.from(c.data,'hex'));"
            "out[k]=Buffer.from(ctx.SpriteLab.Voxel.computeNormalAndAO(d,c.size[0],c.size[1],c.size[2])).toString('hex');}"
            "process.stdout.write(JSON.stringify(out));")
        p = subprocess.run(["node", "-e", js, str(JS_CORE), str(inp)], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        jsout = json.loads(p.stdout)
        report = {}
        for k, (vol, sx, sy, sz) in cases.items():
            py = bytes(svox.compute_normal_ao(vol, sx, sy, sz))
            jb = bytes.fromhex(jsout[k])
            report[k] = sum(1 for a, b in zip(py, jb) if a != b)
            if k.startswith("ref_"):
                pr = next(q for q in rig["parts"] if "ref_" + q["name"] == k)
                self.assertEqual(svox.read_part_volume(REF, pr, "normalAoPath"), py, "committed normal_ao.png == bake")
        QA.mkdir(parents=True, exist_ok=True)
        (QA / "bake_parity_js_vs_python.json").write_text(json.dumps({"mismatchedBytes": report}, indent=2) + "\n")
        self.assertEqual(report, {k: 0 for k in cases}, "byte mismatches vs JS core")


# ============================================================================================ validate
class T06_Validate(Tmp):
    def test_minimal_reference_passes(self):
        rep = self.tmp / "r.json"
        run_cli("validate", "--bundle", REF, "--output", rep)
        r = json.loads(rep.read_text())
        self.assertTrue(r["ok"])
        self.assertEqual(r["errors"], [])
        self.assertEqual(r["warnings"], [])
        self.assertTrue(r["groundContact"]["pass"])
        self.assertAlmostEqual(r["groundContact"]["restLowestZ"], 0.0, places=6)
        self.assertEqual(r["deformSelfTest"]["samples"], 200)
        self.assertLess(r["deformSelfTest"]["maxError"], 1e-5)
        for c in r["clips"].values():
            self.assertLess(c["loopSeam"], 1e-3)
            self.assertGreaterEqual(c["lowestZ"], -0.5)
        for p in r["parts"].values():
            self.assertEqual(p["normals"]["unitFrac"], 1.0)
            self.assertGreaterEqual(p["normals"]["outwardFrac"], 0.95)
        shutil.copy(rep, QA / "validate_minimal_reference.json")

    def _copy_ref(self, name):
        dst = self.tmp / name
        shutil.copytree(REF, dst)
        return dst, json.loads((dst / "rig.json").read_text())

    def test_thin_and_out_of_bounds_bundle_fails(self):
        b, rig = self._copy_ref("thin")
        sx, sy, sz = 8, 3, 6
        vol = make_vol(sx, sy, sz, lambda x, y, z: (200, 200, 220) if y == 1 and 1 <= x <= 6 and 1 <= z <= 4 else None)  # 1-voxel sheet
        part = svox.make_part("wing", (sx, sy, sz), (20.0, 1.5, 0.0), "torso", (0.0, 0.0, -9.0), "wing")
        write_part_strip(b / part["albedoPath"], vol, sx, sy, sz)
        rig["parts"].append(part)
        svox.save_json(b / "rig.json", rig)
        rep = self.tmp / "thin.json"
        run_cli("validate", "--bundle", b, "--output", rep, expect=1)
        r = json.loads(rep.read_text())
        self.assertFalse(r["ok"])
        self.assertIn("GROUND_PENETRATION", [e["code"] for e in r["errors"]])
        w = {(e["code"], e["part"]) for e in r["warnings"]}
        self.assertIn(("THIN_PART", "wing"), w)
        self.assertIn(("PIVOT_OUTSIDE_VOLUME", "wing"), w)
        self.assertIn(("NORMAL_AO_MISSING", "wing"), w)
        self.assertLess(r["groundContact"]["restLowestZ"], -0.5)
        shutil.copy(rep, QA / "validate_broken_thin_oob.json")

    def test_bad_strip_and_parent_fail(self):
        b, rig = self._copy_ref("dims")
        svox.png_write(b / "parts/cape.albedo.png", 7, 4, bytearray(7 * 4 * 4))
        rig["parts"][1]["parent"] = "ghost"
        svox.save_json(b / "rig.json", rig)
        rep = self.tmp / "dims.json"
        run_cli("validate", "--bundle", b, "--output", rep, expect=1)
        codes = {e["code"] for e in json.loads(rep.read_text())["errors"]}
        self.assertTrue({"STRIP_DIMS", "BAD_PARENT"} <= codes, codes)

    def test_non_invertible_squash_fails(self):
        b, rig = self._copy_ref("squash")
        rig["clips"][0]["channels"].append({"part": "torso", "channel": "squashZ", "fn": "keys", "bias": -1.0, "times": [0, 2], "values": [0, 0]})
        svox.save_json(b / "rig.json", rig)
        rep = self.tmp / "sq.json"
        run_cli("validate", "--bundle", b, "--output", rep, expect=1)
        r = json.loads(rep.read_text())
        self.assertIn("DEFORM_INVERT", [e["code"] for e in r["errors"]])
        self.assertIn("SQUASH_RANGE", [e["code"] for e in r["warnings"]])

    def test_deform_formulas_invert_random(self):
        rng = svox._Rng(7)
        worst = 0.0
        for _ in range(2000):
            d = {"shearX": rng.range(-.4, .4), "shearY": rng.range(-.4, .4), "twistZ": rng.range(-1, 1), "squashZ": rng.range(.6, 1.4),
                 "waveAmpX": rng.range(-1, 1), "waveAmpY": rng.range(-1, 1), "waveFreq": rng.range(0, 8), "wavePhase": rng.range(-10, 10)}
            p = [rng.range(-6, 6), rng.range(-6, 6), rng.range(-3, 14)]
            q = svox.undeform_point(*svox.deform_point(p[0], p[1], p[2], d, 16, 3), d, 16, 3)
            worst = max(worst, math.sqrt(sum((q[k] - p[k]) ** 2 for k in range(3))))
        self.assertLess(worst, 1e-5)


# ============================================================================================ pack-atlas
class T07_PackAtlas(Tmp):
    def test_all_formats(self):
        rig = json.loads((REF / "rig.json").read_text())
        for fmt in ("strip_x", "grid_2d", "raw_3d"):
            out = self.tmp / fmt
            run_cli("pack-atlas", "--bundle", REF, "--format", fmt, "--out", out)
            man = json.loads((out / "manifest.json").read_text())
            self.assertEqual((man["schema"], man["format"], len(man["parts"])), ("svox.atlas/v1", fmt, 3))
            for entry, part in zip(man["parts"], rig["parts"]):
                sx, sy, sz = part["size"]
                for kind, key in (("albedo", "albedoPath"), ("normal_ao", "normalAoPath")):
                    vol = svox.read_part_volume(REF, part, key)
                    f = entry["files"][kind]
                    if fmt == "strip_x":
                        self.assertEqual(svox.png_read(out / f["path"])[2], svox.volume_to_strip(vol, sx, sy, sz))
                    elif fmt == "grid_2d":
                        W, H, img = svox.png_read(out / f["path"])
                        cols, rows = f["columns"], f["rows"]
                        self.assertEqual((W, H), (cols * sx, rows * sy))
                        self.assertGreaterEqual(cols * rows, sz)
                        for z in range(sz):
                            for y in range(sy):
                                for x in range(sx):
                                    g = (((z // cols) * sy + y) * W + (z % cols) * sx + x) * 4
                                    self.assertEqual(img[g:g + 4], vol[vol_index(sx, sy, x, y, z):vol_index(sx, sy, x, y, z) + 4])
                    else:
                        self.assertEqual((out / f["path"]).read_bytes(), bytes(vol))
                        self.assertEqual(f["bytes"], sx * sy * sz * 4)


# ============================================================================================ SKILL.md + links
LINK_RE = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")


def github_slug(h):
    h = re.sub(r"[^\w\- ]", "", h.strip().lower().replace("`", ""), flags=re.UNICODE)
    return h.replace(" ", "-")


def heading_slugs(md):
    slugs, seen = set(), {}
    in_code = False
    for line in md.splitlines():
        if line.startswith("```"):
            in_code = not in_code
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m and not in_code:
            s = github_slug(m.group(2))
            n = seen.get(s, 0)
            slugs.add(s if n == 0 else "%s-%d" % (s, n))
            seen[s] = n + 1
    return slugs


def strip_code(md):
    md = re.sub(r"```.*?```", "", md, flags=re.S)
    return re.sub(r"`[^`\n]*`", "", md)


def parse_frontmatter(text):
    if not text.startswith("---\n"):
        raise AssertionError("SKILL.md must start with YAML frontmatter")
    end = text.index("\n---\n", 4)
    lines, fm, i = text[4:end].splitlines(), {}, 0
    while i < len(lines):
        m = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", lines[i])
        if not m:
            raise AssertionError("unparseable frontmatter line: %r" % lines[i])
        key, val = m.group(1), m.group(2)
        if val in (">-", ">", "|", "|-"):
            block = []
            i += 1
            while i < len(lines) and (lines[i].startswith("  ") or not lines[i].strip()):
                block.append(lines[i].strip())
                i += 1
            fm[key] = " ".join(b for b in block if b) if val.startswith(">") else "\n".join(block)
            continue
        fm[key] = val.strip().strip('"').strip("'")
        i += 1
    return fm, text[end + 5:]


class T08_SkillDocs(unittest.TestCase):
    def test_frontmatter_and_size(self):
        text = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        fm, body = parse_frontmatter(text)
        self.assertEqual(fm["name"], "hybrid-voxel-sprite")
        self.assertLessEqual(len(fm["description"]), 1024)
        self.assertEqual(fm["description"], EXPECTED_DESCRIPTION)
        n = len(text.splitlines())
        self.assertTrue(160 <= n <= 240, "SKILL.md has %d lines (want 160-240)" % n)
        for needle in ("01_contract_and_math.md", "02_shader_pipeline_spec.md", "03_pitfalls_and_qa_gates.md", "webgl2_threejs.md",
                       "godot4.md", "unity_urp.md", "blender_exporter.md", "from-vox", "from-strip", "bake-normal-ao", "validate",
                       "pack-atlas", "init-demo", "uv run", "python scripts/svox_cli.py"):
            self.assertIn(needle, text)

    def test_all_relative_links_resolve(self):
        docs = [SKILL / "SKILL.md"] + sorted((SKILL / "references").rglob("*.md"))
        checked, broken = 0, []
        for doc in docs:
            md = doc.read_text(encoding="utf-8")
            for target in LINK_RE.findall(strip_code(md)):
                if re.match(r"^[a-z][a-z0-9+.-]*:", target):  # http:, https:, mailto:
                    continue
                path, _, anchor = target.partition("#")
                dest = doc if not path else (doc.parent / path).resolve()
                checked += 1
                if not dest.exists():
                    broken.append("%s -> %s" % (doc.relative_to(SKILL), target))
                    continue
                try:
                    dest.relative_to(SKILL.resolve())
                except ValueError:
                    broken.append("%s -> %s (leaves the skill folder)" % (doc.relative_to(SKILL), target))
                if anchor and dest.suffix == ".md" and anchor not in heading_slugs(dest.read_text(encoding="utf-8")):
                    broken.append("%s -> %s (missing anchor)" % (doc.relative_to(SKILL), target))
        self.assertGreater(checked, 15)
        self.assertEqual(broken, [])
        QA.mkdir(parents=True, exist_ok=True)
        (QA / "link_check.json").write_text(json.dumps({"docs": [d.relative_to(SKILL).as_posix() for d in docs],
                                                        "linksChecked": checked, "broken": broken}, indent=2) + "\n")

    def test_target_status_badges(self):
        t = SKILL / "references" / "targets"
        for f in ("webgl2_threejs.md", "godot4.md", "unity_urp.md", "blender_exporter.md"):
            head = (t / f).read_text(encoding="utf-8")[:700]
            self.assertIn("Verified", head, f)


# ============================================================================================ WebGL2 smoke render
def _webgl_available():
    chrome = os.environ.get("CHROME", r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    harness = QA / "harness" / "smoke_render.mjs"
    return (shutil.which("node") and Path(chrome).exists() and harness.exists()
            and (ROOT / "src" / "renderers" / "hybrid" / "hybrid_renderer.js").exists() and os.environ.get("SKIP_WEBGL") != "1")


@unittest.skipUnless(_webgl_available(), "origin-repo WebGL2 harness, node or Chrome not available (or SKIP_WEBGL=1)")
class T09_WebGLSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.proc = subprocess.run(["node", str(QA / "harness" / "smoke_render.mjs")], capture_output=True, text=True, cwd=str(ROOT), timeout=600)
        cls.res = json.loads((QA / "smoke_results.json").read_text(encoding="utf-8"))

    def test_render_ok_no_errors(self):
        self.assertEqual(self.proc.returncode, 0, self.proc.stdout + self.proc.stderr)
        s = self.res["summary"]
        self.assertEqual((s["jsErrors"], s["glErrors"]), (0, 0))
        self.assertTrue(self.res["ok"])
        self.assertTrue((QA / "minimal_reference_t3.png").stat().st_size > 20000)
        self.assertEqual(s["decoderMismatches"], 0)
        self.assertGreater(self.res["decoderCrossCheck"]["checked"], 1000)
        for p in self.res["panels"]:
            self.assertGreater(p["fgTexels"], 1000, p["label"])

    def test_four_gates(self):
        g = self.res["gates"]
        self.assertEqual((g["lowPitchZeroGap"]["cracks"], g["lowPitchZeroGap"]["cracksIso33"]), (0, 0))
        st = g["lowPitchZeroGap"]["detectorSelfTest"]
        self.assertEqual(st["flaggedAsCracks"], st["punched"])
        for c in g["pixelSnapCrawl"]["cases"]:
            self.assertEqual(c["changedPxSnapOn"], 0)
            self.assertGreater(c["changedPxSnapOff"], 0)
        self.assertLess(g["deformInverse"]["maxError"], 1e-5)
        for c in g["occlusion"]["cases"]:
            self.assertEqual(c["reversedOrderDiffPx"], 0)
            self.assertGreater(c["zBufferOffDiffPx"], 0)

    def test_js_and_python_rig_evaluation_agree(self):
        rig = json.loads((REF / "rig.json").read_text())
        worst = 0.0
        for s in self.res["poseSamples"]:
            py = svox.evaluate_pose(rig, s["clip"], s["t"])
            for name, m in s["matrices"].items():
                worst = max(worst, max(abs(a - b) for a, b in zip(m, py["parts"][name]["matrix"])))
        self.assertLess(worst, 1e-4)


if __name__ == "__main__":
    print("python %s | skill %s" % (sys.version.split()[0], SKILL.relative_to(ROOT)))
    res = unittest.main(verbosity=2, exit=False).result
    total, bad = res.testsRun, len(res.failures) + len(res.errors)
    print("\nSUMMARY: %d tests, %d passed, %d failed, %d skipped" % (total, total - bad - len(res.skipped), bad, len(res.skipped)))
    sys.exit(0 if res.wasSuccessful() else 1)
