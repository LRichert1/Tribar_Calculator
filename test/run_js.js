// Runs tribar.js on one raw RGBA image for test/parity.py and prints JSON.
//   node test/run_js.js <rgba file> <width> <height> <opencv gray file> [python angle]
const fs = require('fs');
const T = require('../tribar.js');

const [rgbaPath, w, h, grayPath, pyAngle] = process.argv.slice(2);
const W = +w, H = +h;
const rgba = new Uint8Array(fs.readFileSync(rgbaPath));
const gray = T.grayFromRGBA(rgba, W, H);
const grayExact = Buffer.compare(Buffer.from(gray.buffer, gray.byteOffset, gray.length), fs.readFileSync(grayPath)) === 0;

const strip = (res) => ({ ...res, windows: res.windows.map(({ marks, samples, ...rest }) => rest) });
const t0 = Date.now();
const auto = T.measure(gray, W, H);
const ms = Date.now() - t0;
const forced = pyAngle != null ? T.measure(gray, W, H, { angle: +pyAngle }) : null;

process.stdout.write(JSON.stringify({
  grayExact, ms, auto: strip(auto), forced: forced && strip(forced),
  summary: T.summarize(auto.windows),
}));
