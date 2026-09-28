/* Tribar corrosion measurement from a photo.
 *
 * JavaScript port of reference/tb.py, reference/measure3.py and
 * reference/tribar_measure.py. Functions carry the name of the Python
 * function they mirror. The OpenCV and NumPy calls those depend on are
 * reproduced exactly where practical (grayscale conversion, affine rotation,
 * percentiles, the float32 arithmetic in _halfmax) and to float precision
 * otherwise (Gaussian blur, FFT). test/parity.py checks this file against the
 * Python reference.
 *
 * Deliberate differences from the reference:
 *  - BASELINE_RATIO is 0.4686, the median of the 60 C44 calibration windows
 *    (notes/tribar-corrosion-tool.md). tribar_measure.py hard-codes the mean,
 *    0.4744. The losses quoted in the notes were computed against the median.
 *  - bar_angle scores the same 0.25 deg grid on a downsampled copy first,
 *    then re-scores the 7 nearest angles at full resolution. Scoring all 241
 *    angles at full resolution takes minutes on a phone.
 *  - If the bars run across the photo instead of up and down, the image is
 *    turned 90 deg before measuring. The reference only searches +/-30 deg
 *    and would reject such a photo.
 *  - Only width readings that follow a bar from one scan row to the next are
 *    used (followBars), before the reference's shadow rejection. Where the
 *    pit floor is brighter than the bars (gravel, debris, glare on water) the
 *    reference measures bright bits between the bars as if they were bars;
 *    in the gravel band of a C10 photo most readings sat on stones. On the
 *    five C44 photos this keeps 96-98% of readings, leaves the median window
 *    ratio unchanged (0.4665 vs 0.4666) and moves one window 3 points (it
 *    drops a glint running down one bar's edge); the rest move under 1.
 *    measure(..., {reference: true}) turns it off.
 *
 * Loads as a browser/worker script (self.Tribar) or a Node module.
 */
(function (root) {
'use strict';

const BASELINE_RATIO = 0.4686;

// confidence gates (tribar_measure.py)
const MIN_MODULATION = 0.30;   // bars must be optically resolved
const MIN_SAMPLES    = 120;    // enough edge measurements in the window
const MIN_RATIO      = 0.15;   // below this, almost certainly a detection failure
const MAX_RATIO      = 0.62;   // above this, likely locked onto gap not bar

const NX = 4, NY = 3;          // measurement windows across x down
const f32 = Math.fround;

/* ================================================================== *
 *  NumPy / OpenCV building blocks
 * ================================================================== */

// saturate_cast<int>(double): round half to even
function cvRound(v) {
  const r = Math.round(v);
  return (r - v === 0.5 && (r & 1)) ? r - 1 : r;
}

// Python `int(v) | 1` for non-negative v (safe past 2^31, unlike `| 1`)
function oddUp(v) { v = Math.trunc(v); return v % 2 === 0 ? v + 1 : v; }

// numpy.percentile(a, q) with the default 'linear' method, on a sorted copy.
// For float32 input NumPy 2 interpolates in float32; `is32` reproduces that.
function percentileSorted(s, q, is32) {
  const n = s.length, v = (n - 1) * (q / 100);
  if (v >= n - 1) return s[n - 1];
  const p = Math.floor(v), t = v - p, a = s[p], b = s[p + 1];
  if (is32) {
    const d = f32(b - a);
    return t >= 0.5 ? f32(b - f32(d * f32(1 - t))) : f32(a + f32(d * f32(t)));
  }
  const d = b - a;
  return t >= 0.5 ? b - d * (1 - t) : a + d * t;
}

// numpy.median of float64 values
function median(values) {
  const s = Float64Array.from(values).sort(), n = s.length, h = n >> 1;
  return n % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

// cv2.cvtColor(..., COLOR_BGR2GRAY) on 8-bit pixels, from canvas RGBA data
function grayFromRGBA(rgba, w, h) {
  const n = w * h, g = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4)
    g[i] = (rgba[j] * 9798 + rgba[j + 1] * 19235 + rgba[j + 2] * 3735 + 16384) >> 15;
  return g;
}

// cv2.getGaussianKernel(n, 0) as float32 coefficients
const SMALL_GAUSS = [[1], [0.25, 0.5, 0.25], [0.0625, 0.25, 0.375, 0.25, 0.0625],
                     [0.03125, 0.109375, 0.21875, 0.28125, 0.21875, 0.109375, 0.03125]];
const kernels = new Map();
function gaussianKernel(n) {
  let k = kernels.get(n);
  if (k) return k;
  k = new Float64Array(n);
  if (n % 2 === 1 && n <= 7) k.set(SMALL_GAUSS[n >> 1]);
  else {
    const sigma = ((n - 1) * 0.5 - 1) * 0.3 + 0.8, scale2X = -0.5 / (sigma * sigma);
    let sum = 0;
    for (let i = 0; i < n; i++) { const x = i - (n - 1) * 0.5; k[i] = Math.exp(scale2X * x * x); sum += k[i]; }
    sum = 1 / sum;
    for (let i = 0; i < n; i++) k[i] = f32(k[i] * sum);
  }
  kernels.set(n, k);
  return k;
}

// OpenCV borderInterpolate(p, len, BORDER_REFLECT_101)
function reflect101(p, len) {
  if (len === 1) return 0;
  while (p < 0 || p >= len) p = p < 0 ? -p : 2 * len - 2 - p;
  return p;
}

// cv2.GaussianBlur(v.reshape(-1,1), (1,k), 0).ravel(): a blur along v.
// Interior outputs are computed four at a time (each keeps its own
// summation order, so the result is the same as one at a time, just faster).
function blur1d(v, k) {
  const n = v.length, ker = gaussianKernel(k), r = k >> 1, out = new Float64Array(n), k0 = ker[r];
  const edge = (i) => {
    let s = k0 * v[i];
    for (let j = 1; j <= r; j++) s += ker[r + j] * (v[reflect101(i - j, n)] + v[reflect101(i + j, n)]);
    out[i] = s;
  };
  let i = 0;
  for (; i < Math.min(r, n); i++) edge(i);
  for (; i + 3 < n - r; i += 4) {
    let s0 = k0 * v[i], s1 = k0 * v[i + 1], s2 = k0 * v[i + 2], s3 = k0 * v[i + 3];
    for (let j = 1; j <= r; j++) {
      const kj = ker[r + j];
      s0 += kj * (v[i - j] + v[i + j]);
      s1 += kj * (v[i + 1 - j] + v[i + 1 + j]);
      s2 += kj * (v[i + 2 - j] + v[i + 2 + j]);
      s3 += kj * (v[i + 3 - j] + v[i + 3 + j]);
    }
    out[i] = s0; out[i + 1] = s1; out[i + 2] = s2; out[i + 3] = s3;
  }
  for (; i < n; i++) edge(i);
  return out;
}

// cv2.getRotationMatrix2D(center, ang, 1.0), as [m00 m01 m02 m10 m11 m12]
function rotationMatrix(cx, cy, ang) {
  const a = ang * (Math.PI / 180), al = Math.cos(a), be = Math.sin(a);
  return [al, be, (1 - al) * cx - be * cy, -be, al, be * cx + (1 - al) * cy];
}

// The inverse map and per-column offsets cv2.warpAffine uses. Source
// positions are fixed point with 1/32 px steps, which matters for matching
// OpenCV's output exactly.
function warpSetup(ang, cx, cy, dw) {
  const M = rotationMatrix(cx, cy, ang);
  let D = M[0] * M[4] - M[1] * M[3];
  D = D !== 0 ? 1 / D : 0;
  const a11 = M[4] * D, a22 = M[0] * D, a12 = M[1] * -D, a21 = M[3] * -D;
  const Mi = [a11, a12, -a11 * M[2] - a12 * M[5], a21, a22, -a21 * M[2] - a22 * M[5]];
  const ad = new Int32Array(dw), bd = new Int32Array(dw);
  for (let x = 0; x < dw; x++) { ad[x] = cvRound(Mi[0] * x * 1024); bd[x] = cvRound(Mi[3] * x * 1024); }
  return { Mi, ad, bd };
}

// Bilinear sample at fixed-point position (X, Y) in 1/32 px, BORDER_REPLICATE.
// Returns the weighted sum scaled by 1024 (weights are integers summing to 1024).
function sample1024(src, w, h, X, Y) {
  const sx = X >> 5, sy = Y >> 5, ax = X & 31, ay = Y & 31;
  let v00, v01, v10, v11;
  if (sx >= 0 && sx < w - 1 && sy >= 0 && sy < h - 1) {
    const i = sy * w + sx;
    v00 = src[i]; v01 = src[i + 1]; v10 = src[i + w]; v11 = src[i + w + 1];
  } else {
    const xa = sx < 0 ? 0 : sx > w - 1 ? w - 1 : sx, xb = sx + 1 < 0 ? 0 : sx + 1 > w - 1 ? w - 1 : sx + 1;
    const ya = sy < 0 ? 0 : sy > h - 1 ? h - 1 : sy, yb = sy + 1 < 0 ? 0 : sy + 1 > h - 1 ? h - 1 : sy + 1;
    v00 = src[ya * w + xa]; v01 = src[ya * w + xb]; v10 = src[yb * w + xa]; v11 = src[yb * w + xb];
  }
  return (v00 * (32 - ax) + v01 * ax) * (32 - ay) + (v10 * (32 - ax) + v11 * ax) * ay;
}

/* ================================================================== *
 *  tb.py
 * ================================================================== */

// tb.rotate on an 8-bit grayscale image (cv2.warpAffine, INTER_LINEAR,
// BORDER_REPLICATE), bit-exact with OpenCV 4.x
function rotate(src, w, h, ang) {
  const { Mi, ad, bd } = warpSetup(ang, w / 2, h / 2, w), dst = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const X0 = cvRound((Mi[1] * y + Mi[2]) * 1024) + 16, Y0 = cvRound((Mi[4] * y + Mi[5]) * 1024) + 16;
    for (let x = 0, o = y * w; x < w; x++)
      dst[o + x] = (sample1024(src, w, h, (X0 + ad[x]) >> 5, (Y0 + bd[x]) >> 5) * 32 + 16384) >> 15;
  }
  return dst;
}

// One candidate angle, scored as tb.bar_angle does: rotate the square
// sub-image, average the middle 60% of rows (float32, row by row, like
// NumPy), detrend with a k-tap Gaussian, return the variance.
function angleScore(sub, S, ang, k) {
  const { Mi, ad, bd } = warpSetup(ang, S / 2, S / 2, S);
  const m = Math.trunc(S * 0.2), acc = new Float32Array(S);
  for (let y = m; y < S - m; y++) {
    const X0 = cvRound((Mi[1] * y + Mi[2]) * 1024) + 16, Y0 = cvRound((Mi[4] * y + Mi[5]) * 1024) + 16;
    for (let x = 0; x < S; x++) acc[x] += sample1024(sub, S, S, (X0 + ad[x]) >> 5, (Y0 + bd[x]) >> 5) / 1024;
  }
  for (let x = 0; x < S; x++) acc[x] /= S - 2 * m;
  const bg = blur1d(acc, k), d = new Float64Array(S);
  let mean = 0, v = 0;
  for (let x = 0; x < S; x++) { d[x] = f32(acc[x] - f32(bg[x])); mean += d[x]; }
  mean /= S;
  for (let x = 0; x < S; x++) v += (d[x] - mean) * (d[x] - mean);
  return v / S;
}

const ANGLES = Array.from({ length: 241 }, (_, i) => -30 + i * 0.25);

function bestAngle(sub, S, k, angles) {
  let best = angles[0], score = -1;
  for (const a of angles) { const v = angleScore(sub, S, a, k); if (v > score) { score = v; best = a; } }
  return { angle: best, score };
}

// The centre square tb.bar_angle works on
function centralSquare(gray, w, h) {
  const cy = h >> 1, cx = w >> 1, half = Math.floor(Math.min(h, w) / 3), S = 2 * half;
  const sub = new Uint8Array(S * S);
  for (let y = 0; y < S; y++) {
    const o = (cy - half + y) * w + cx - half;
    sub.set(gray.subarray(o, o + S), y * S);
  }
  return { sub, S };
}

// Box-average a square image by an integer factor
function shrink(sub, S, f) {
  const n = Math.floor(S / f), out = new Float32Array(n * n), inv = 1 / (f * f);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let s = 0;
      for (let dy = 0; dy < f; dy++) {
        const o = (y * f + dy) * S + x * f;
        for (let dx = 0; dx < f; dx++) s += sub[o + dx];
      }
      out[y * n + x] = s * inv;
    }
  return out;
}

// Turn an image 90 deg clockwise: output is h wide and w tall
function turn90(src, w, h) {
  const out = new src.constructor(w * h);
  for (let y = 0; y < w; y++)
    for (let x = 0; x < h; x++) out[y * h + x] = src[(h - 1 - x) * w + y];
  return out;
}

// tb.detrend: subtract a Gaussian-blurred background (float32 result)
function detrend(prof, k = 151) {
  const n = prof.length;
  k = Math.trunc(Math.max(3, Math.min(k, Math.floor(n / 2) * 2 - 1))) | 1;
  const bg = blur1d(prof, k), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = prof[i] - f32(bg[i]);
  return x;
}

const hannings = new Map();
function hanning(M) {  // np.hanning
  let w = hannings.get(M);
  if (!w) {
    w = new Float64Array(M);
    if (M === 1) w[0] = 1;
    else for (let i = 0; i < M; i++) w[i] = 0.5 + 0.5 * Math.cos(Math.PI * (1 - M + 2 * i) / (M - 1));
    hannings.set(M, w);
  }
  return w;
}

// |DFT| of x zero-padded to length L, at the given bins, by the Goertzel
// recurrence (matches the FFT bin to ~1e-12). Four bins run side by side
// because independent recurrences execute much faster than one at a time.
const goertzelMag = (s1, s2, c) => Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2));
function dftMagnitudes(x, L, bins) {
  const N = x.length, out = new Float64Array(bins.length), w = 2 * Math.PI / L;
  let i = 0;
  for (; i + 3 < bins.length; i += 4) {
    const ca = 2 * Math.cos(w * bins[i]), cb = 2 * Math.cos(w * bins[i + 1]);
    const cc = 2 * Math.cos(w * bins[i + 2]), cd = 2 * Math.cos(w * bins[i + 3]);
    let a1 = 0, a2 = 0, b1 = 0, b2 = 0, c1 = 0, c2 = 0, d1 = 0, d2 = 0;
    for (let n = 0; n < N; n++) {
      const v = x[n];
      const a0 = v + ca * a1 - a2; a2 = a1; a1 = a0;
      const b0 = v + cb * b1 - b2; b2 = b1; b1 = b0;
      const c0 = v + cc * c1 - c2; c2 = c1; c1 = c0;
      const d0 = v + cd * d1 - d2; d2 = d1; d1 = d0;
    }
    out[i] = goertzelMag(a1, a2, ca); out[i + 1] = goertzelMag(b1, b2, cb);
    out[i + 2] = goertzelMag(c1, c2, cc); out[i + 3] = goertzelMag(d1, d2, cd);
  }
  for (; i < bins.length; i++) {
    const c = 2 * Math.cos(w * bins[i]);
    let s1 = 0, s2 = 0;
    for (let n = 0; n < N; n++) { const s0 = x[n] + c * s1 - s2; s2 = s1; s1 = s0; }
    out[i] = goertzelMag(s1, s2, c);
  }
  return out;
}

// tb.pitch_fft: dominant spatial period of a profile, from a 4x zero-padded
// FFT with parabolic peak interpolation. Only the bins with a period inside
// [pmin, pmax] (plus the peak's two neighbours) are evaluated.
function pitchFFT(prof, pmin = 8, pmax = 200) {
  const d = detrend(prof), N = d.length, L = N * 4, nF = (L >> 1) + 1, val = 1.0 / L;
  const win = hanning(N), x = new Float64Array(N);
  for (let i = 0; i < N; i++) x[i] = d[i] * win[i];
  const per = (k) => 1.0 / Math.max(k * val, 1e-12);
  const bins = [];
  for (let k = 1; k < nF; k++) { const p = per(k); if (p >= pmin && p <= pmax) bins.push(k); }
  const F = dftMagnitudes(x, L, bins);
  let at = -1, peak = 0;
  for (let i = 0; i < bins.length; i++) if (F[i] > peak) { peak = F[i]; at = i; }
  const idx = at < 0 ? 0 : bins[at];
  if (idx <= 0 || idx >= nF - 1) return per(idx);
  // the masked bins are contiguous, so the neighbours are adjacent entries
  const y0 = at > 0 ? F[at - 1] : dftMagnitudes(x, L, [idx - 1])[0];
  const y2 = at < bins.length - 1 ? F[at + 1] : dftMagnitudes(x, L, [idx + 1])[0];
  const dd = 0.5 * (y0 - y2) / (y0 - 2 * peak + y2 + 1e-12);
  return 1.0 / (idx * val + dd * val);
}

/* ================================================================== *
 *  measure3.py
 * ================================================================== */

const EPS9 = f32(1e-9);

// measure3._halfmax: full width at half maximum of the bar nearest `center`.
// Float32 arithmetic throughout, as NumPy 2 does it for these float32 values.
function halfmax(prof, center, pitch) {
  const lo = Math.trunc(Math.max(0, center - 0.6 * pitch));
  const hi = Math.trunc(Math.min(prof.length, center + 0.6 * pitch + 1));
  if (hi - lo < 6) return null;
  const seg = prof.subarray(lo, hi), m = seg.length;
  let pk = 0;
  for (let i = 1; i < m; i++) if (seg[i] > seg[pk]) pk = i;
  const top = seg[pk], base = percentileSorted(Float32Array.from(seg).sort(), 12, true);
  const con = f32(top - base);
  if (con < 12) return null;
  const half = f32(0.5 * f32(top + base));
  let i = pk;
  while (i > 0 && seg[i] > half) i--;
  if (seg[i] > half) return null;
  const xl = f32(i + f32(f32(half - seg[i]) / f32(f32(seg[i + 1] - seg[i]) + EPS9)));
  let j = pk;
  while (j < m - 1 && seg[j] > half) j++;
  if (seg[j] > half) return null;
  const xr = f32(j - f32(f32(half - seg[j]) / f32(f32(seg[j - 1] - seg[j]) + EPS9)));
  const w = f32(xr - xl);
  if (!(0.03 * pitch < w && w < 0.9 * pitch)) return null;
  return [f32(lo + f32(f32(xl + xr) / 2)), w, con, top];
}

// measure3.row_measure: one scan row -> pitch, modulation, bar widths
function rowMeasure(prof, pmin = 12, pmax = 400, minMod = 0.25, minAmp = 12) {
  const n = prof.length;
  const pitch = pitchFFT(prof, pmin, Math.min(pmax, n / 3));
  const x = detrend(prof, oddUp(pitch * 4));
  let c = 0, s = 0;
  for (let t = 0; t < n; t++) {
    const a = 2 * Math.PI * t / pitch;
    c += x[t] * Math.cos(a); s += x[t] * Math.sin(a);
  }
  c /= n; s /= n;
  const amp = 2 * Math.hypot(c, s), xs = Float32Array.from(x).sort();
  const rng = f32(percentileSorted(xs, 97, true) - percentileSorted(xs, 3, true));
  const mod = rng > 1e-6 ? amp / rng : 0;
  if (mod < minMod || amp < minAmp) return { pitch, mod, amp, dets: [] };
  const k0 = Math.atan2(s, c) * pitch / (2 * Math.PI), dets = [];
  for (let i = 0, count = Math.ceil(n / pitch + 2 + 2); i < count; i++) {
    const cc = k0 + (i - 2) * pitch;
    if (cc < pitch * 0.6 || cc > n - pitch * 0.6) continue;
    const r = halfmax(prof, cc, pitch);
    if (r) dets.push(r);
  }
  return { pitch, mod, amp, dets };
}

// Least-squares line through readings [y, x, ...]: x at a given y
function lineFit(pts) {
  let ym = 0, a = 0, syy = 0, syx = 0;
  for (const q of pts) { ym += q[0]; a += q[1]; }
  ym /= pts.length; a /= pts.length;
  for (const q of pts) { syy += (q[0] - ym) ** 2; syx += (q[0] - ym) * (q[1] - a); }
  const b = syy > 0 ? syx / syy : 0;
  return { at: (y) => a + b * (y - ym) };
}

// Which readings follow a bar. Not in the reference; see the header. Where
// the floor of the pit is brighter than the bars (gravel, debris, glare on
// standing water) the half-max readings land on bright bits between the bars,
// and cross-rods and glints give readings too. A bar is a long straight
// stripe, so:
//  1. its readings line up from one scan row to the next at nearly the same
//     centre. Chained readings spanning at least half a bar spacing, with a
//     median width a bar could have, make a track.
//  2. bars sit whole bar spacings apart. A track half-way between the lines
//     of longer tracks (extended straight up and down the photo) is on the
//     floor, e.g. a line of stones down the middle of a gap.
//  3. a reading off the tracks still counts if a track runs within 15% of a
//     bar spacing of its centre (a pit in one edge moves the centre sideways)
//     and it is no brighter than the bar there (not a glint).
// S: one window's samples [y, x, width, pitch, ratio, contrast, top], scan
// rows `stride` px apart. Returns a keep flag per sample.
function followBars(S, stride) {
  const n = S.length, keep = new Uint8Array(n), onTrack = new Uint8Array(n);
  const rows = new Map();
  S.forEach((s, i) => { if (!rows.has(s[0])) rows.set(s[0], []); rows.get(s[0]).push(i); });
  // how far the bars lean: the typical sideways step from one scan row to the next
  const steps = [];
  for (const [y, list] of rows) {
    const next = rows.get(y + stride);
    if (next) for (const i of list) {
      let step = null;
      for (const j of next) {
        const d = S[j][1] - S[i][1];
        if (Math.abs(d) < 0.25 * S[i][3] && (step === null || Math.abs(d) < Math.abs(step))) step = d;
      }
      if (step !== null) steps.push(step);
    }
  }
  const lean = steps.length >= 10 ? median(steps) : 0;
  // 1. chain each reading to its nearest in the next scan row (or the one
  // after, over a missed row) when each is the other's nearest within tolerance
  const parent = Array.from(S, (_, i) => i), up = new Uint8Array(n), down = new Uint8Array(n);
  const root = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  for (const y of [...rows.keys()].sort((a, b) => a - b))
    for (const k of [1, 2]) {
      const A = rows.get(y), B = rows.get(y + k * stride);
      if (!B) continue;
      const shift = lean * k;
      for (const i of A) {
        if (down[i]) continue;
        const tol = Math.max(1.5, 0.05 * S[i][3]) * (k === 1 ? 1 : 1.5);
        let j = -1, dj = tol, back = -1, db = tol;
        for (const c of B) { const d = Math.abs(S[c][1] - S[i][1] - shift); if (!up[c] && d <= dj) { dj = d; j = c; } }
        if (j < 0) continue;
        for (const c of A) { const d = Math.abs(S[j][1] - S[c][1] - shift); if (!down[c] && d <= db) { db = d; back = c; } }
        if (back !== i) continue;
        parent[root(j)] = root(i); down[i] = up[j] = 1;
      }
    }
  const chains = new Map(), tracks = [];
  S.forEach((_, i) => { const r = root(i); if (!chains.has(r)) chains.set(r, []); chains.get(r).push(i); });
  for (const list of chains.values()) {
    if (list.length < 4) continue;
    let first = Infinity, last = -Infinity;
    for (const i of list) { first = Math.min(first, S[i][0]); last = Math.max(last, S[i][0]); }
    const p = median(list.map((i) => S[i][3])), ratio = median(list.map((i) => S[i][4]));
    if (last - first >= 0.5 * p && ratio >= MIN_RATIO && ratio <= MAX_RATIO)
      tracks.push({ list, first, last, p, long: last - first >= 1.5 * p, line: lineFit(list.map((i) => S[i])) });
  }
  // 2. each track's offset from the line of every longer-than-1.5-spacing
  // track, extended up to 6 spacings past its ends; a track goes when the
  // tracks it sits half-way between outweigh itself and those it agrees with
  for (const t of tracks) {
    let agree = 0, against = 0;
    for (const L of tracks) {
      if (L === t || !L.long) continue;
      const off = [];
      for (const i of t.list) {
        const y = S[i][0];
        if (y < L.first - 6 * L.p || y > L.last + 6 * L.p) continue;
        const d = (L.line.at(y) - S[i][1]) / S[i][3];
        if (Math.abs(d) <= 1.6) off.push(Math.abs(d - Math.round(d)));
      }
      if (!off.length) continue;
      const f = median(off);
      if (f < 0.2) agree += L.list.length; else if (f > 0.3) against += L.list.length;
    }
    if (against <= agree + t.list.length) for (const i of t.list) onTrack[i] = keep[i] = 1;
  }
  // 3. readings off the tracks
  for (let i = 0; i < n; i++) {
    if (keep[i]) continue;
    const [y, x, , p] = S[i], near = [];
    for (let yy = y - Math.floor(1.2 * p / stride) * stride; yy <= y + 1.2 * p; yy += stride)
      for (const j of rows.get(yy) || []) if (onTrack[j] && Math.abs(S[j][1] - x) <= 0.3 * p) near.push(S[j]);
    if (near.length >= 4 && Math.abs(x - lineFit(near).at(y)) <= 0.15 * p &&
        S[i][6] <= 1.3 * median(near.map((q) => q[6]))) keep[i] = 1;
  }
  return keep;
}

// measure3.analyze: measure every `stride`-th 8-row band in one window.
// With `onBars`, only the readings that follow a bar are used (followBars).
function analyzeWindow(gr, w, x0, x1, y0, y1, band = 4, stride = 6, onBars = false) {
  const n = x1 - x0, rows = [];
  for (let y = y0 + band; y < y1 - band; y += stride) {
    const prof = new Float32Array(n);
    for (let yy = y - band; yy < y + band; yy++)
      for (let x = 0, o = yy * w + x0; x < n; x++) prof[x] += gr[o + x];
    for (let x = 0; x < n; x++) prof[x] /= 2 * band;
    const r = rowMeasure(prof);
    if (r.dets.length) rows.push({ y, pitch: r.pitch, mod: r.mod, dets: r.dets });
  }
  if (!rows.length) return { ok: false, reason: 'no rows passed the resolution gate' };
  // samples: [y, x, width, pitch, ratio, contrast, top]
  let S = [];
  for (const r of rows)
    for (const [c, bw, con, top] of r.dets) S.push([r.y, x0 + c, bw, r.pitch, bw / r.pitch, con, top]);
  const nraw = S.length;
  if (onBars) {
    const on = followBars(S, stride);
    S = S.filter((_, i) => on[i]);
    if (!S.length) return { ok: false, reason: 'no readings follow a bar', nraw, nbar: 0, mod_med: median(rows.map((r) => r.mod)) };
  }
  const nbar = S.length;
  // shadow rejection: drop samples whose bar peak is much darker than typical
  const tref = percentileSorted(Float64Array.from(S, (r) => r[6]).sort(), 75, false);
  const keep = S.filter((r) => r[6] > 0.72 * tref && r[5] > 25);
  if (keep.length >= 40) S = keep;
  const ratios = Float64Array.from(S, (r) => r[4]).sort();
  return {
    ok: true, kept: S.length, nraw, nbar, nrows: rows.length, nsamp: ratios.length,
    pitch_med: median(rows.map((r) => r.pitch)),
    mod_med: median(rows.map((r) => r.mod)),
    r_p50: percentileSorted(ratios, 50, false),
    r_p25: percentileSorted(ratios, 25, false),
    r_p10: percentileSorted(ratios, 10, false),
    r_p05: percentileSorted(ratios, 5, false),
    samples: S,
  };
}

/* ================================================================== *
 *  tribar_measure.py
 * ================================================================== */

function grade(loss) {
  if (loss == null) return '-';
  if (loss < 0.10) return '0-10%';
  if (loss < 0.20) return '10-20%';
  if (loss < 0.30) return '20-30%';
  if (loss < 0.40) return '30-40%';
  if (loss < 0.50) return '40-50%';
  return '50%+';
}

// np.linspace(start, stop, num).astype(int)
function linspaceInt(start, stop, num) {
  const step = (stop - start) / (num - 1), out = [];
  for (let i = 0; i < num; i++) out.push(Math.trunc(i === num - 1 ? stop : i * step + start));
  return out;
}

// Find which way the bars run and how far they are tilted. Returns the
// (possibly turned) image and the deskew angle.
function findBars(gray, w, h) {
  let { sub, S } = centralSquare(gray, w, h);
  const f = Math.max(1, Math.round(S / 500)), k = oddUp(Math.round(151 / f)), n = Math.floor(S / f);
  const low = shrink(sub, S, f), lowTurned = turn90(low, n, n);
  const up = bestAngle(low, n, k, ANGLES);
  // a 1 deg look is enough to tell whether the bars run across instead
  let turned = false, coarse = up.angle;
  if (bestAngle(lowTurned, n, k, ANGLES.filter((_, q) => q % 4 === 0)).score > up.score) {
    gray = turn90(gray, w, h); [w, h] = [h, w]; turned = true;
    coarse = bestAngle(lowTurned, n, k, ANGLES).angle;
    ({ sub, S } = centralSquare(gray, w, h));
  }
  const i = ANGLES.indexOf(coarse);
  const { angle } = bestAngle(sub, S, 151, ANGLES.slice(Math.max(0, i - 3), i + 4));
  return { gray, w, h, turned, angle };
}

// tribar_measure.analyse_image, from an 8-bit grayscale image. `opts.angle`
// (with `opts.turned`) skips the search, for tests and re-runs;
// `opts.reference` uses every reading, as the reference does, instead of
// only those that follow a bar.
function measure(gray, w, h, opts = {}) {
  const progress = opts.onProgress || (() => {});
  let turned, angle;
  if (opts.angle != null) {
    turned = !!opts.turned; angle = opts.angle;
    if (turned) { gray = turn90(gray, w, h); [w, h] = [h, w]; }
  } else {
    progress(0.02, 'Finding the bars');
    ({ gray, w, h, turned, angle } = findBars(gray, w, h));
  }
  progress(0.25, 'Straightening');
  const gr = rotate(gray, w, h, angle);
  const mx = Math.trunc(w * 0.06), my = Math.trunc(h * 0.06);
  const xs = linspaceInt(mx, w - mx, NX + 1), ys = linspaceInt(my, h - my, NY + 1);
  const windows = [];
  for (let i = 0; i < NX; i++)
    for (let j = 0; j < NY; j++) {
      progress(0.3 + 0.7 * (i * NY + j) / (NX * NY), 'Measuring window ' + (i * NY + j + 1) + ' of ' + NX * NY);
      const [x0, x1, y0, y1] = [xs[i], xs[i + 1], ys[j], ys[j + 1]];
      const r = analyzeWindow(gr, w, x0, x1, y0, y1, 4, 6, !opts.reference);
      const rec = { cell: i + ',' + j, box: [x0, x1, y0, y1] };
      if (!r.ok && !r.nraw) { rec.ok = false; rec.why = 'bars not resolved'; windows.push(rec); continue; }
      const n = r.ok ? r.kept : 0, mod = r.mod_med, med = r.r_p50, low = r.r_p25;
      const few = mod >= MIN_MODULATION && n < MIN_SAMPLES;
      let why = null;
      if (mod < MIN_MODULATION)  why = 'low contrast (mod ' + mod.toFixed(2) + ')';
      else if (few) {
        why = 'too few samples (' + n + ')';
        if (r.nraw >= MIN_SAMPLES && r.nbar < 0.75 * r.nraw)
          why += ' - only ' + r.nbar + ' of ' + r.nraw + ' readings follow a bar, the rest are off the bars (bright floor, debris or glare?)';
      }
      else if (med < MIN_RATIO)  why = 'ratio ' + med.toFixed(2) + ' implausible - locked onto highlight/gap';
      else if (med > MAX_RATIO)  why = 'ratio ' + med.toFixed(2) + ' implausible - locked onto gap';
      if (why) Object.assign(rec, { ok: false, why, ratio: med, mod, n });
      else Object.assign(rec, { ok: true, ratio: med, ratio_worst: Math.max(low, 0), mod, n, pitch: r.pitch_med });
      if (!r.ok) { windows.push(rec); continue; }
      // the widths measured on every 3rd scan row, for drawing (measure3.draw
      // takes every 3rd sample, which can land on the same bar in every row):
      // [y, bar centre x, measured width, local pitch]
      rec.marks = r.samples.filter((sm) => (sm[0] - y0 - 4) % 18 === 0).map((sm) => [sm[0], sm[1], sm[2], sm[3]]);
      // every width reading, for measuring a tapped spot. A window with too few
      // readings for its own figure still has good ones to tap.
      if (!why || few) rec.samples = r.samples.map((sm) => [sm[0], sm[1], sm[2], sm[3]]);
      windows.push(rec);
    }
  progress(1, 'Done');
  return { width: w, height: h, turned, angle, windows };
}

// The bar under the point (x, y): follow it up and down the straightened
// photo through `marks` ([y, centre x, width, pitch] from usable windows) and
// return its width loss as the median along its length, so a glare spot or a
// missed edge on part of the bar doesn't set the answer. Not in the
// reference; this is the "single worst bar" the inspector picks.
function traceBar(marks, x, y, baseline = BASELINE_RATIO) {
  let seed = null, best = Infinity;
  for (const m of marks) {
    const dx = Math.abs(m[1] - x), dy = Math.abs(m[0] - y);
    if (dx > m[3] / 2 || dy > 40) continue;
    if (dx + 0.25 * dy < best) { best = dx + 0.25 * dy; seed = m; }
  }
  if (!seed) return null;
  const byRow = new Map();
  for (const m of marks) { if (!byRow.has(m[0])) byRow.set(m[0], []); byRow.get(m[0]).push(m); }
  const rows = [...byRow.keys()].sort((a, b) => a - b), bar = [seed];
  for (const dir of [-1, 1]) {
    let cur = seed;
    for (let i = rows.indexOf(seed[0]) + dir; i >= 0 && i < rows.length; i += dir) {
      if (Math.abs(rows[i] - cur[0]) > 60) break;   // lost the bar for more than ~3 scan rows
      let next = null, nd = 0.35 * cur[3];
      for (const m of byRow.get(rows[i])) { const d = Math.abs(m[1] - cur[1]); if (d < nd) { nd = d; next = m; } }
      if (next) { bar.push(next); cur = next; }
    }
  }
  bar.sort((a, b) => a[0] - b[0]);
  const ratio = median(bar.map((m) => m[2] / m[3]));
  return { n: bar.length, ratio, loss: 1 - ratio / baseline, marks: bar };
}

// The inspector's "worst spot on the worst bar": trace the bar under (x, y)
// through `samples` and measure its width over one bar-spacing of length
// centred on the tap (median of the readings there). The whole bar's median
// comes back too, for comparison. On new C44 bars a tapped spot reads within
// about +/-9 points; the whole-bar median within about +/-5.
function measureSpot(samples, x, y, baseline = BASELINE_RATIO) {
  const bar = traceBar(samples, x, y, baseline);
  if (!bar) return null;
  const pitch = median(bar.marks.map((m) => m[3]));
  const spot = bar.marks.filter((m) => Math.abs(m[0] - y) <= pitch / 2);
  if (!spot.length) return null;
  const ratio = median(spot.map((m) => m[2] / m[3]));
  return { n: spot.length, ratio, loss: 1 - ratio / baseline, spot, bar };
}

// tribar_measure.report over a set of windows (possibly from several
// photos): typical and worst-area width loss, and the band to report,
// taken from the worst-area figure as the reference does. Width loss is
// reported 1:1 as cross-section loss (notes/tribar-corrosion-tool.md).
function summarize(windows, baseline = BASELINE_RATIO) {
  const ok = windows.filter((r) => r.ok);
  if (!ok.length) return null;
  const typical = median(ok.map((r) => 1 - r.ratio / baseline));
  const worst = median(ok.map((r) => 1 - r.ratio_worst / baseline));
  return { n: ok.length, ratio: median(ok.map((r) => r.ratio)), typical, worst, band: grade(worst) };
}

const api = {
  BASELINE_RATIO, grade, grayFromRGBA, measure, summarize, traceBar, measureSpot,
  // internals, for test/parity.py
  cvRound, percentileSorted, blur1d, detrend, pitchFFT, rowMeasure, halfmax, analyzeWindow, followBars,
  rotate, angleScore, findBars, turn90, ANGLES,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.Tribar = api;
})(typeof self !== 'undefined' ? self : globalThis);
