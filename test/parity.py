#!/usr/bin/env python3
"""Check tribar.js against the Python reference on synthetic tribar photos.

Draws tribar-like photos with a known bar width / pitch ratio, runs
reference/tribar_measure.py on them unmodified, runs tribar.js (through
Node) on the same pixels, and compares the deskew angle and every window.

    python3 test/parity.py            # needs numpy, scipy, opencv-python 4.x, node

Checks, per photo:
  gray     tribar.js grayscale == cv2.cvtColor, bit for bit
  forced   with the reference's angle, every window's pass/fail and reason
           match and ratios agree to 1e-6
  auto     tribar.js's own angle search picks the reference's angle
  app      with only the readings that follow a bar (what the app shows),
           typical and worst-area loss stay within 1.5 points of the
           reference's on the clean photos; on the gravel photo, where the
           reference reads the stones between the bars, every window the app
           measures is within 5 points of the drawn bars
Exits non-zero if any check fails.
"""
import json, os, subprocess, sys, tempfile
import numpy as np, cv2

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'reference'))
import tribar_measure as tm  # noqa: E402

BASELINE = 0.4686  # compare losses against the same baseline tribar.js uses


def smooth_noise(rng, h, w, scale):
    """Low-frequency noise in [-1, 1] with features about `scale` px across."""
    small = rng.standard_normal((max(2, int(h / scale)) + 2, max(2, int(w / scale)) + 2)).astype(np.float32)
    big = cv2.resize(small, (w, h), interpolation=cv2.INTER_CUBIC)
    return big / (np.abs(big).max() + 1e-6)


def synth(W, H, pitch, ratio, angle, seed, rust=True, blur=1.2, noise=3.0, jitter=0.02,
          highlights=0, galv_ratio=None, gravel=None, jpeg=90):
    """Bright bars of width ratio*pitch over a dark pit, tilted `angle` deg.
    With galv_ratio, bars left of centre are rusty at `ratio` and bars right of
    centre are galvanized at `galv_ratio`. With gravel=(top, bottom), that band
    of the photo (fractions of its height) has pale stones on the pit floor,
    brighter than the bars, as in the C10 photos."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    th = np.deg2rad(angle)
    u = (xx - W / 2) * np.cos(th) + (yy - H / 2) * np.sin(th)      # across the bars
    v = -(xx - W / 2) * np.sin(th) + (yy - H / 2) * np.cos(th)     # along the bars
    phase = rng.uniform(0, pitch)
    k = np.round((u - phase) / pitch)
    d = np.abs(u - phase - k * pitch)
    kk = (k - k.min()).astype(np.int32)
    nb = int(kk.max()) + 1
    centre = phase + (np.arange(nb) + k.min()) * pitch
    galv = (centre > 0) if galv_ratio is not None else np.zeros(nb, bool)
    r = np.where(galv, galv_ratio if galv_ratio is not None else ratio, ratio)
    bw = pitch * np.clip(r + rng.normal(0, jitter, nb), 0.08, 0.85)
    amp, lam, ph = rng.uniform(0, 0.05, nb), rng.uniform(80, 300, nb), rng.uniform(0, 2 * np.pi, nb)
    hw = 0.5 * bw[kk] * (1 + amp[kk] * np.sin(2 * np.pi * v / lam[kk] + ph[kk]))
    bar = np.clip(hw - d + 0.5, 0, 1)

    light = 1 + 0.35 * (xx / W - 0.5) + 0.15 * (yy / H - 0.5)
    top = rng.uniform(150, 210, nb)[kk] * light * (1 + 0.12 * smooth_noise(rng, H, W, 25))
    pit = 24 + 10 * smooth_noise(rng, H, W, 60)
    if gravel:
        stones = np.zeros((H, W), np.float32)
        for _ in range(int(W * H * (gravel[1] - gravel[0]) / (gravel_n := 60))):
            cx, cy, s = rng.uniform(0, W), rng.uniform(H * gravel[0], H * gravel[1]), rng.uniform(1.5, 0.12 * pitch)
            x0, x1, y0, y1 = int(max(0, cx - 3 * s)), int(min(W, cx + 3 * s + 1)), int(max(0, cy - 3 * s)), int(min(H, cy + 3 * s + 1))
            g = np.exp(-((xx[y0:y1, x0:x1] - cx) ** 2 + (yy[y0:y1, x0:x1] - cy) ** 2) / (2 * s * s))
            stones[y0:y1, x0:x1] = np.maximum(stones[y0:y1, x0:x1], rng.uniform(0.5, 1.0) * g)
        band = np.clip(np.minimum(yy - H * gravel[0], H * gravel[1] - yy) / 10, 0, 1)
        pit = pit + band * (60 + 170 * stones)
    if highlights:
        spots = np.zeros((H, W), np.float32)
        for _ in range(highlights):
            cx, cy, s = rng.uniform(0, W), rng.uniform(0, H), rng.uniform(4, 14)
            spots += np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * s * s))
        top = top + 140 * spots
    rust_rgb, galv_rgb = np.array([1.0, 0.72, 0.52]), np.array([0.95, 0.97, 1.0])
    tint = np.where(galv[kk][..., None], galv_rgb, rust_rgb if rust else galv_rgb)
    rgb = pit[..., None] * (1 - bar[..., None]) + (top[..., None] * tint) * bar[..., None]
    rgb = cv2.GaussianBlur(rgb.astype(np.float32), (0, 0), blur)
    rgb = rgb + rng.normal(0, noise, rgb.shape)
    bgr = np.clip(rgb[..., ::-1], 0, 255).astype(np.uint8)
    ok, enc = cv2.imencode('.jpg', bgr, [cv2.IMWRITE_JPEG_QUALITY, jpeg])
    return cv2.imdecode(enc, cv2.IMREAD_COLOR)


# name, width, height, pitch px, bar width / pitch, tilt deg, options
CASES = [
    ('new, 4 deg',           1600, 1200, 48, 0.47,   4.0, {}),
    ('corroded, -12 deg',    1600, 1200, 70, 0.39, -12.0, {'noise': 5}),
    ('galvanized, 22 deg',   2000, 1500, 36, 0.43,  22.0, {'rust': False}),
    ('thin + highlights',    1600, 1200, 90, 0.30,  -3.3, {'highlights': 8}),
    ('portrait',             1200, 1600, 55, 0.45,   7.8, {}),
    ('rust | galvanized',    1600, 1200, 60, 0.38,   1.5, {'galv_ratio': 0.47}),
    ('soft, low contrast',   1600, 1200, 40, 0.45,  -6.0, {'blur': 3.5, 'noise': 9}),
    ('phone size, 12 MP',    4032, 3024, 110, 0.44,  2.0, {}),
    ('bars across the photo', 1600, 1200, 60, 0.42, 96.0, {}),  # reference can't do this one
    ('gravel under the bars', 1600, 1200, 50, 0.40,   2.5, {'gravel': (0.12, 0.30)}),  # reference reads the stones
]
# cases where the reference is known to be wrong: the app is checked against the drawn bars instead
BRIGHT_FLOOR = {'gravel under the bars'}


def py_windows(res):
    out = []
    for r in res:
        o = {'cell': r['cell'], 'ok': bool(r['ok']), 'why': r.get('why')}
        for key in ('ratio', 'ratio_worst', 'mod', 'n'):
            if key in r: o[key] = float(r[key])
        out.append(o)
    return out


def compare(py, js, tol):
    """Return a list of human-readable mismatches between window lists."""
    bad = []
    for p, j in zip(py, js):
        if p['ok'] != j['ok']:
            bad.append('%s: python %s, js %s' % (p['cell'], p['why'] or 'ok', j.get('why') or 'ok'))
            continue
        if not p['ok'] and (p['why'] or '').split(' (')[0] != (j.get('why') or '').split(' (')[0]:
            bad.append('%s: python "%s", js "%s"' % (p['cell'], p['why'], j.get('why')))
        for key in ('ratio', 'ratio_worst'):
            if key in p and abs(p[key] - j[key]) > tol:
                bad.append('%s: %s python %.5f js %.5f' % (p['cell'], key, p[key], j[key]))
    return bad


def summary(windows):
    ok = [w for w in windows if w['ok']]
    if not ok: return None
    return (float(np.median([1 - w['ratio'] / BASELINE for w in ok])),
            float(np.median([1 - w['ratio_worst'] / BASELINE for w in ok])),
            float(np.median([w['ratio'] for w in ok])), len(ok))


def main():
    failures = 0
    with tempfile.TemporaryDirectory() as tmp:
        for ci, (name, W, H, pitch, ratio, angle, opt) in enumerate(CASES):
            img = synth(W, H, pitch, ratio, angle, seed=100 + ci, **opt)
            png = os.path.join(tmp, 'img%d.png' % ci)
            cv2.imwrite(png, img)
            rgba = cv2.cvtColor(img, cv2.COLOR_BGR2RGBA)
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            rgba.tofile(png + '.rgba'); gray.tofile(png + '.gray')

            across = abs(angle) > 45
            py_ang, py_res = None, None
            if not across:
                _, _, py_ang, res = tm.analyse_image(png)
                py_res = py_windows(res)
            args = ['node', os.path.join(HERE, 'run_js.js'), png + '.rgba', str(W), str(H), png + '.gray']
            if py_ang is not None: args.append(repr(float(py_ang)))
            js = json.loads(subprocess.run(args, check=True, capture_output=True, text=True).stdout)

            problems = []
            if not js['grayExact']: problems.append('grayscale differs from cv2.cvtColor')
            auto = js['auto']
            if across:
                if not auto['turned']: problems.append('did not turn the photo')
                js_sum = summary(auto['windows'])
                line = 'turned=%s angle %+.2f' % (auto['turned'], auto['angle'])
            else:
                problems += ['forced ' + b for b in compare(py_res, js['forced']['windows'], 1e-6)]
                if auto['turned']: problems.append('turned a photo whose bars run up and down')
                if auto['angle'] != py_ang:
                    problems.append('angle: python %+.2f, js %+.2f' % (py_ang, auto['angle']))
                    problems += ['auto ' + b for b in compare(py_res, auto['windows'], 2e-3)]
                js_sum, py_sum = summary(auto['windows']), summary(py_res)
                line = 'angle py %+.2f js %+.2f' % (py_ang, auto['angle'])
                if py_sum:
                    line += ' | py typical %5.1f%% worst %5.1f%%' % (100 * py_sum[0], 100 * py_sum[1])
            if js_sum:
                line += ' | js typical %5.1f%% worst %5.1f%% band %s | median ratio %.4f (drawn %.2f) %d/12 windows' % (
                    100 * js_sum[0], 100 * js_sum[1], js['summary']['band'], js_sum[2], ratio, js_sum[3])
            else:
                line += ' | js: no usable windows'
            app_sum = summary(js['app']['windows'])
            if not app_sum:
                problems.append('app: no usable windows')
            elif name in BRIGHT_FLOOR:
                truth = 1 - ratio / BASELINE
                loss = lambda ws: [1 - w['ratio'] / BASELINE for w in ws if w['ok']]
                ref_worst, app_worst = max(loss(js['auto']['windows'])), max(loss(js['app']['windows']))
                line += ' | drawn %.1f%%: worst window reference %.1f%%, app %.1f%% (%d/12)' % (
                    100 * truth, 100 * ref_worst, 100 * app_worst, app_sum[3])
                if ref_worst < truth + 0.10:
                    problems.append('test photo no longer fools the reference (worst window %.1f%%)' % (100 * ref_worst))
                for w in js['app']['windows']:
                    if w['ok'] and abs(1 - w['ratio'] / BASELINE - truth) > 0.05:
                        problems.append('app window %s reads %.1f%%, drawn bars %.1f%%' % (w['cell'], 100 * (1 - w['ratio'] / BASELINE), 100 * truth))
            elif js_sum:
                line += ' | app typical %5.1f%% worst %5.1f%% %d/12' % (100 * app_sum[0], 100 * app_sum[1], app_sum[3])
                for k, label in ((0, 'typical'), (1, 'worst-area')):
                    if abs(app_sum[k] - js_sum[k]) > 0.015:
                        problems.append('app %s loss %.1f%%, reference %.1f%%' % (label, 100 * app_sum[k], 100 * js_sum[k]))
            status = 'FAIL' if problems else 'ok  '
            print('%s %-22s %5.1fs  %s' % (status, name, js['ms'] / 1000, line))
            for p in problems: print('       - ' + p)
            failures += bool(problems)
    print('\n%d of %d photos failed' % (failures, len(CASES)) if failures else '\nall %d photos match' % len(CASES))
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
