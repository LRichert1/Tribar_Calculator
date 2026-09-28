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
// the reference's measurement (every reading) for the comparison with Python
const t0 = Date.now();
const auto = T.measure(gray, W, H, { reference: true });
const ms = Date.now() - t0;
const forced = pyAngle != null ? T.measure(gray, W, H, { angle: +pyAngle, reference: true }) : null;
// and the app's (only readings that follow a bar), at the same angle
const app = T.measure(gray, W, H, { angle: auto.angle, turned: auto.turned });

process.stdout.write(JSON.stringify({
  grayExact, ms, auto: strip(auto), forced: forced && strip(forced), app: strip(app),
  summary: T.summarize(auto.windows), appSummary: T.summarize(app.windows),
}));
