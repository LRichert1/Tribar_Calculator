#!/usr/bin/env node
/* End-to-end test of the app in headless Chromium against a fake Dropbox.

     python3 test/make_photos.py /tmp/tribar-photos
     node test/e2e.js /tmp/tribar-photos [screenshot-dir]

   Serves the repo at http://localhost:<port>/Tribar_Calculator/ (the Pages
   path) and fakes Dropbox's OAuth and API endpoints in memory. The fake
   only finds the team folder when a files/* request carries
   Dropbox-API-Path-Root {".tag":"root","root":"7777"} (the account's root
   namespace), like JEG's team space. Checks: averaging and its prompts, the
   spread warning, the resolution warnings, saving, sign-in (PKCE, redirect
   URI at either address), upload paths and headers, the CSV rebuilt from
   every JSON in the site folder (including another iPad's), token refresh
   after a 401, offline then online, a missing base folder, the marked-up
   photo, Share, the in-app camera's size label, the [hidden] fix, the
   offline cache, and the phone-width layout. */
"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, ".."), PHOTOS = path.resolve(process.argv[2] || "."), SHOTS = process.argv[3] || null;
const BASE = "/Johnson Engineering Group/Technical/0000 JEG/Tribar Readings";
const SITE = "Test Site’s Farm";       // a curly apostrophe: non-ASCII in the Dropbox-API-Arg header
let failures = 0;
const ok = (cond, what) => { console.log((cond ? "ok   " : "FAIL ") + what); if (!cond) failures++; };

/* ---------------- static server for the app ---------------- */
const TYPES = {".html": "text/html", ".js": "text/javascript", ".webmanifest": "application/manifest+json", ".png": "image/png", ".json": "application/json"};
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (!u.pathname.startsWith("/Tribar_Calculator/")) { res.writeHead(404); return res.end(); }
  let rel = decodeURIComponent(u.pathname.slice("/Tribar_Calculator/".length)) || "index.html";
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, {"Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store"});
  fs.createReadStream(file).pipe(res);
});

/* ---------------- fake Dropbox ---------------- */
function fakeDropbox({baseExists = true} = {}) {
  const D = {files: new Map(), folders: new Set(), log: [], authorize: [], tokenCalls: [], expired: new Set(), issued: 0};
  const low = p => p.toLowerCase();
  const addFolder = p => { const parts = p.split("/").filter(Boolean); for (let i = 1; i <= parts.length; i++) D.folders.add(low("/" + parts.slice(0, i).join("/"))); };
  if (baseExists) addFolder(BASE);
  D.put = (p, body) => { addFolder(p.slice(0, p.lastIndexOf("/"))); D.files.set(low(p), {path: p, body: Buffer.from(body)}); };
  const CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type, Dropbox-API-Arg, Dropbox-API-Path-Root",
                "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Expose-Headers": "Dropbox-API-Result"};
  const json = (route, status, obj) => route.fulfill({status, headers: Object.assign({"Content-Type": "application/json"}, CORS), body: JSON.stringify(obj)});
  const notFound = route => json(route, 409, {error_summary: "path/not_found/..", error: {".tag": "path", path: {".tag": "not_found"}}});

  D.install = async ctx => {
    await ctx.route("https://www.dropbox.com/oauth2/authorize*", route => {
      const q = new URL(route.request().url()).searchParams; D.authorize.push(Object.fromEntries(q));
      const back = q.get("redirect_uri") + "?code=CODE" + D.authorize.length + "&state=" + encodeURIComponent(q.get("state"));
      route.fulfill({status: 200, headers: {"Content-Type": "text/html"}, body: "<script>location.replace(" + JSON.stringify(back) + ")</script>"});
    });
    await ctx.route(/https:\/\/(api|content)\.dropboxapi\.com\/.*/, async route => {
      const req = route.request(), u = new URL(req.url()), h = req.headers();
      if (req.method() === "OPTIONS") return route.fulfill({status: 204, headers: CORS});
      const endpoint = u.pathname.replace(/^\/2\//, "");
      D.log.push({endpoint, host: u.host, headers: h});
      if (u.pathname === "/oauth2/token") {
        const p = Object.fromEntries(new URLSearchParams(req.postData() || "")); D.tokenCalls.push(p);
        if (p.grant_type === "authorization_code") {
          const a = D.authorize.find(x => "CODE" + (D.authorize.indexOf(x) + 1) === p.code);
          const challenge = crypto.createHash("sha256").update(p.code_verifier || "").digest("base64url");
          if (!a || a.code_challenge !== challenge || a.redirect_uri !== p.redirect_uri || p.client_id !== "5n2wm6eobl2dvg8")
            return json(route, 400, {error: "invalid_grant", error_description: "bad code, verifier or redirect_uri"});
        } else if (p.grant_type !== "refresh_token" || p.refresh_token !== "RT") return json(route, 400, {error: "invalid_grant"});
        return json(route, 200, {access_token: "AT" + (++D.issued), refresh_token: p.grant_type === "authorization_code" ? "RT" : undefined, expires_in: 14400, account_id: "dbid:test"});
      }
      const tok = (h.authorization || "").replace(/^Bearer /, "");
      if (!/^AT\d+$/.test(tok) || D.expired.has(tok)) return json(route, 401, {error_summary: "expired_access_token/..", error: {".tag": "expired_access_token"}});
      if (endpoint === "users/get_current_account")
        return json(route, 200, {account_id: "dbid:test", name: {display_name: "Test Inspector"}, email: "inspector@example.com",
                                 root_info: {".tag": "team", root_namespace_id: "7777", home_namespace_id: "8888"}});
      if (endpoint === "auth/token/revoke") return json(route, 200, null);
      // files/*: only the team space (root namespace 7777) has the folder
      const team = h["dropbox-api-path-root"] === JSON.stringify({".tag": "root", root: "7777"});
      const arg = u.host.startsWith("content") ? JSON.parse(h["dropbox-api-arg"]) : JSON.parse(req.postData() || "null");
      const p = arg && arg.path;
      if (endpoint === "files/get_metadata") return team && (D.folders.has(low(p)) || D.files.has(low(p))) ? json(route, 200, {".tag": "folder", name: p.split("/").pop(), path_lower: low(p)}) : notFound(route);
      if (endpoint === "files/upload") {
        if (!team) return json(route, 403, {error_summary: "path/no_write_permission/.."});
        D.put(p, req.postDataBuffer() || Buffer.alloc(0));
        return json(route, 200, {name: p.split("/").pop(), path_lower: low(p), path_display: p, rev: "r1"});
      }
      if (endpoint === "files/list_folder") {
        if (!team || !D.folders.has(low(p))) return notFound(route);
        const entries = [...D.files.values()].filter(f => low(f.path.slice(0, f.path.lastIndexOf("/"))) === low(p))
          .map(f => ({".tag": "file", name: f.path.split("/").pop(), path_lower: low(f.path), path_display: f.path}));
        return json(route, 200, {entries, has_more: false, cursor: "c"});
      }
      if (endpoint === "files/download") {
        const f = team && D.files.get(low(p));
        if (!f) return notFound(route);
        return route.fulfill({status: 200, headers: Object.assign({"Content-Type": "application/octet-stream", "Dropbox-API-Result": JSON.stringify({name: f.path.split("/").pop()})}, CORS), body: f.body});
      }
      return json(route, 400, {error_summary: "unknown endpoint " + endpoint});
    });
  };
  return D;
}

/* ---------------- helpers ---------------- */
const waitIdle = page => page.waitForFunction(() => STATE.photos.length && STATE.photos.every(p => p.status === "done" || p.status === "error"), null, {timeout: 120000});
async function addPhotos(page, ...names) {
  await page.setInputFiles("#pickInput", names.map(n => path.join(PHOTOS, n)));
  await waitIdle(page);
}
// Tap photo i at a bar reading near (fx, fy) of the straightened photo
async function tap(page, i, fx = 0.5, fy = 0.5) {
  const pt = await page.evaluate(([i, fx, fy]) => {
    const ph = STATE.photos[i], r = ph.result, S = barSamples(ph);
    let best = null, bd = 1e18;
    for (const m of S) { const d = (m[1] - fx * r.width) ** 2 + (m[0] - fy * r.height) ** 2; if (d < bd) { bd = d; best = m; } }
    const rect = ph.stage.getBoundingClientRect();
    ph.stage.scrollIntoView({block: "center"});
    const rr = ph.stage.getBoundingClientRect();
    return {x: rr.left + best[1] / r.width * rr.width, y: rr.top + best[0] / r.height * rr.height};
  }, [i, fx, fy]);
  await page.mouse.click(pt.x, pt.y);
  return page.evaluate(i => STATE.photos[i].pick && STATE.photos[i].pick.loss, i);
}
const resultText = page => page.$eval("#resultCard", e => e.innerText);
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

async function main() {
  await new Promise(r => server.listen(0, r));
  const port = server.address().port, APP = "http://localhost:" + port + "/Tribar_Calculator/";
  const browser = await chromium.launch({args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]});
  const D = fakeDropbox();
  // another iPad's reading, already in the site folder
  const other = {id: "zzzz9999", savedAt: "2026-11-01T15:00:00.000Z", site: SITE, barn: "Barn B", room: "1", row: "2", crate: "3",
                 band: "30-40%", worstSpot: 0.35, spotsAveraged: 3, spotLosses: [0.33, 0.35, 0.37], spotSpread: 0.04,
                 worstSpotN: 60, worstBar: 0.3, worstSpotPhoto: "x.jpg", typical: 0.3, used: 12, total: 12, baseline: 0.4686, photos: [], files: []};
  D.put(BASE + "/" + SITE + "/2026-11-01 Barn B Room 1 Row 2 Crate 3 zzzz9999.json", JSON.stringify(other));

  const ctx = await browser.newContext({viewport: {width: 1100, height: 900}, serviceWorkers: "block", acceptDownloads: true});
  await D.install(ctx);
  // a reading saved before the Dropbox backup existed (no files, no photos), seeded once
  await ctx.addInitScript(() => {
    if (localStorage.getItem("seeded")) return;
    localStorage.setItem("seeded", "1");
    localStorage.setItem("tribar.v1", JSON.stringify({loc: {}, readings: [{id: "old00001", savedAt: "2026-10-20T14:00:00.000Z", site: "Old Site",
      barn: "Gestation", room: "4", row: "1", side: "Front", band: "10-20%", worstSpot: 0.14, worstSpotN: 20, worstBar: 0.1, worstSpotPhoto: "a.jpg",
      typical: 0.1, used: 10, total: 12, baseline: 0.4686, photos: [{name: "a.jpg"}]}]}));
  });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(APP);
  await page.waitForFunction(() => window.TribarSync && document.querySelector("#syncMsg").textContent.length > 0);

  // [hidden] beats .btn's display:inline-flex
  const vis = await page.evaluate(() => ["#signInBtn", "#signOutBtn", "#syncBtn"].map(s => getComputedStyle(document.querySelector(s)).display));
  ok(vis[0] !== "none" && vis[1] === "none" && vis[2] === "none", "signed out: Sign in shown, Sign out and Sync now hidden (" + vis.join(", ") + ")");
  ok(/Not backed up/.test(await page.textContent("#syncMsg")), "sync bar says readings are only on this device");

  /* ---- averaging ---- */
  for (const [id, v] of [["#fSite", SITE], ["#fBarn", "Farrowing 2"], ["#fRoom", "3"], ["#fRow", "2"], ["#fCrate", "5"]]) await page.fill(id, v);
  await addPhotos(page, "spot-1.jpg");
  const l1 = await tap(page, 0);
  ok(l1 != null, "tapped spot in photo 1: " + (100 * l1).toFixed(1) + "%");
  let t = await resultText(page);
  ok(/Take 2 more photos of this same spot/.test(t) && /One photo is about ±9 points/.test(t), "one tapped: asks for 2 more photos");
  await addPhotos(page, "spot-2.jpg");
  t = await resultText(page);
  ok(/1 photo has no spot tapped/.test(t) && /Take 1 more photo of/.test(t), "second photo untapped: asks to tap it, then 1 more photo");
  const l2 = await tap(page, 1);
  await addPhotos(page, "spot-3.jpg");
  const l3 = await tap(page, 2);
  t = await resultText(page);
  const mean = (l1 + l2 + l3) / 3, spread = Math.max(l1, l2, l3) - Math.min(l1, l2, l3);
  const shown = await page.evaluate(() => currentSummary().avg);
  ok(near(shown.loss, mean) && near(shown.spread, spread) && shown.count === 3, "average of 3 = " + (100 * mean).toFixed(1) + "%, spread " + (100 * spread).toFixed(1) + " pts");
  ok(t.includes("averaged over 3 photos") && t.includes([l1, l2, l3].map(v => (100 * v).toFixed(1) + "%").join(", ")), "result shows the average and each photo's figure");
  ok(!/more photo|no spot tapped/.test(t), "3 tapped: no prompt for more");
  ok(!/apart at the tapped spot/.test(t), "spread under 10 points: no warning");
  await addPhotos(page, "far-off.jpg");
  const l4 = await tap(page, 3);
  t = await resultText(page);
  ok(/apart at the tapped spot/.test(t), "a photo of a different spot (" + (100 * l4).toFixed(1) + "%): spread warning");
  await page.click(".photo:nth-child(4) button[title='Remove photo']");
  ok(!/apart at the tapped spot/.test(await resultText(page)), "removing it clears the warning");

  /* ---- resolution line on a good photo ---- */
  const line = await page.$eval(".photo .ph-line", e => e.textContent);
  ok(/1600×1200 \(1\.9 MP\), bars 6\d px apart/.test(line), "photo line shows size and bar spacing: …" + line.slice(line.indexOf("1600")));

  /* ---- save, before signing in ---- */
  await page.click("#saveBtn");
  await page.waitForFunction(() => STATE.readings.length === 2 && !STATE.photos.length);
  const r1 = await page.evaluate(() => STATE.readings[0]);
  ok(r1.spotsAveraged === 3 && near(r1.worstSpot, mean) && r1.spotLosses.length === 3 && near(r1.spotSpread, spread), "saved reading keeps the average, each photo and the spread");
  ok(r1.files.filter(f => f.kind === "marked").length === 3 && r1.files.filter(f => f.kind === "original").length === 3, "3 marked-up photos and 3 originals kept on the device");
  ok(!r1.synced && /Not backed up/.test(await page.textContent(".reading .cloud")), "saved reading shows Not backed up");
  const stored = await page.evaluate(() => localStorage.getItem("tribar.v1"));
  ok(!/data:image|base64/.test(stored) && stored.length < 40000, "no photos in localStorage (" + stored.length + " bytes for 2 readings)");
  ok(await page.evaluate(async () => { const b = await TribarSync.IDB.get(STATE.readings[0].files[0].key); return b && b.size > 50000 && b.type === "image/jpeg"; }), "marked-up photo readable back from IndexedDB");
  // the marked-up photo, for a look
  const marked = await page.evaluate(async () => { const b = await TribarSync.IDB.get(STATE.readings[0].files.find(f => f.kind === "marked").key);
    const a = new Uint8Array(await b.arrayBuffer()); let s = ""; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); });
  if (SHOTS) fs.writeFileSync(path.join(SHOTS, "marked.jpg"), Buffer.from(marked, "base64"));

  /* ---- share falls back to a download where the share sheet isn't available ---- */
  // (headless Chromium reports any non-ASCII download name as "download", so check the name the app gives it)
  await page.evaluate(() => { window.__names = []; const orig = downloadBlob; downloadBlob = (n, b) => { __names.push(n); orig(n, b); }; });
  await Promise.all([page.waitForEvent("download"), page.click(".reading button[title='Share the marked-up photo']")]);
  const shared = await page.evaluate(() => __names);
  ok(shared.length === 3 && shared.every((n, i) => n === "Test Site’s Farm - Farrowing 2 Room 3 Row 2 Crate 5 - marked " + (i + 1) + ".jpg"), "Share (download here, share sheet on the iPad): " + shared.join(" | "));

  /* ---- sign in ---- */
  await Promise.all([page.waitForURL(u => /code=/.test(u) || /Tribar_Calculator\/$/.test(u)), page.click("#signInBtn")]);
  await page.waitForFunction(() => /all readings backed up/.test(document.querySelector("#syncMsg").textContent), null, {timeout: 30000});
  const auth = D.authorize[0];
  ok(auth.redirect_uri === APP && auth.code_challenge_method === "S256" && auth.token_access_type === "offline" &&
     auth.scope === "account_info.read files.metadata.read files.content.read files.content.write" && auth.client_id === "5n2wm6eobl2dvg8",
     "authorize: PKCE S256, offline, the four scopes, redirect " + auth.redirect_uri);
  ok(D.tokenCalls[0] && D.tokenCalls[0].grant_type === "authorization_code", "code exchanged with the PKCE verifier");
  ok(!/code=/.test(page.url()), "code removed from the address bar");
  const filesCalls = D.log.filter(l => /^files\//.test(l.endpoint));
  ok(filesCalls.length > 0 && filesCalls.every(l => l.headers["dropbox-api-path-root"] === '{".tag":"root","root":"7777"}'), "every files/* call carries Dropbox-API-Path-Root root 7777 (" + filesCalls.length + " calls)");
  ok(D.log.filter(l => l.endpoint === "users/get_current_account").every(l => !l.headers["dropbox-api-path-root"]), "account call has no Path-Root header");
  const up = D.log.filter(l => l.endpoint === "files/upload").map(l => l.headers["dropbox-api-arg"]);
  ok(up.some(a => a.includes("Test Site\\u2019s Farm")) && up.every(a => /^[\x20-\x7e]*$/.test(a)), "Dropbox-API-Arg is ASCII with the apostrophe escaped");
  ok(up.every(a => { const j = JSON.parse(a); return j.mode[".tag"] === "overwrite" && j.autorename === false; }), "uploads overwrite (same name = same reading)");
  const names = [...D.files.values()].map(f => f.path).sort();
  const site = BASE + "/" + SITE + "/", stem = "2026-";
  const mine = names.filter(n => n.startsWith(site) && n.includes(r1.id));
  ok(mine.length === 7 && mine.filter(n => / marked \d\.jpg$/.test(n)).length === 3 && mine.filter(n => / photo \d\.jpg$/.test(n)).length === 3 && mine.some(n => n.endsWith(r1.id + ".json")),
     "reading uploaded: JSON + 3 marked + 3 originals, e.g. " + mine.find(n => n.endsWith(".json")).slice(BASE.length));
  ok(names.includes(BASE + "/Old Site/2026-10-20 Gestation Room 4 Row 1 old00001.json"), "old reading without photos uploaded as JSON");
  ok(!names.some(n => !n.startsWith(BASE + "/")), "nothing written outside Tribar Readings");
  const csv = D.files.get((site + "Tribar readings - " + SITE + ".csv").toLowerCase());
  const csvText = csv && csv.body.toString("utf8");
  ok(csv && /Barn B/.test(csvText) && /Farrowing 2/.test(csvText) && csvText.trim().split("\r\n").length === 3, "site CSV rebuilt from both iPads' readings (2 rows + header)");
  ok(D.log.filter(l => l.endpoint === "files/download").length === 1, "CSV rebuild downloads only the other iPad's JSON");
  ok(D.files.has((BASE + "/Old Site/Tribar readings - Old Site.csv").toLowerCase()), "old site's CSV built too");
  const j1 = JSON.parse(D.files.get(mine.find(n => n.endsWith(".json")).toLowerCase()).body);
  ok(j1.spotsAveraged === 3 && j1.files.every(f => f.uploaded && f.dropboxName && !f.key) && !("synced" in j1), "uploaded JSON lists its photos' Dropbox names");
  ok(await page.evaluate(async () => !(await TribarSync.IDB.get(STATE.readings[0].files.find(f => f.kind === "original").key))), "originals cleared from the device once uploaded");
  ok(await page.evaluate(async () => !!(await TribarSync.IDB.get(STATE.readings[0].files.find(f => f.kind === "marked").key))), "marked-up photos stay on the device for sharing");
  ok(/Backed up/.test(await page.textContent(".reading .cloud")), "reading shows Backed up");
  const v2 = await page.evaluate(() => ["#signInBtn", "#signOutBtn", "#syncBtn"].map(s => getComputedStyle(document.querySelector(s)).display));
  ok(v2[0] === "none" && v2[1] !== "none" && v2[2] !== "none", "signed in: Sign out and Sync now shown, Sign in hidden");

  /* ---- a 401 renews the token once ---- */
  D.expired.add("AT1");
  await addPhotos(page, "spot-1.jpg"); await tap(page, 0);
  await page.click("#saveBtn");
  await page.waitForFunction(() => STATE.readings.length === 3 && STATE.readings[0].synced, null, {timeout: 30000});
  ok(D.tokenCalls.some(c => c.grant_type === "refresh_token"), "expired token: refreshed with the refresh token and the upload went through");

  /* ---- offline, then back online ---- */
  await ctx.setOffline(true);
  await addPhotos(page, "spot-2.jpg"); await tap(page, 0);
  await page.click("#saveBtn");
  await page.waitForFunction(() => STATE.readings.length === 4);
  await page.waitForTimeout(500);
  ok(/1 reading waiting to upload; will upload when there's signal/.test(await page.textContent("#syncMsg")), "offline: saved on the device, waiting for signal");
  await ctx.setOffline(false);
  await page.waitForFunction(() => STATE.readings.every(r => r.synced) && !TribarSync.pendingCsv() && !SYNC.busy, null, {timeout: 30000});
  ok(true, "back online: uploaded without a tap");
  ok([...D.files.keys()].filter(k => k.endsWith(".json") && k.startsWith(site.toLowerCase())).length === 4 &&
     D.files.get((site + "Tribar readings - " + SITE + ".csv").toLowerCase()).body.toString().trim().split("\r\n").length === 5, "site CSV now has all 4 readings");
  const [dl2] = await Promise.all([page.waitForEvent("download"), page.click(".reading button[title='Share the marked-up photo']")]);
  ok(!!dl2, "Share still works after backup (marked-up photo kept)");
  await page.click("#syncBtn");
  ok(/Everything on this device is backed up/.test(await page.textContent("#toast")), "Sync now with nothing to do says so");

  /* ---- low resolution ---- */
  await page.click("text=Discard").catch(() => {});
  await addPhotos(page, "low-amber.jpg", "low-red.jpg");
  const res = await page.$$eval(".photo", cards => cards.map(c => [...c.querySelectorAll(".ph-line")].filter(e => !e.hidden).map(e => e.className + " | " + e.textContent).join(" || ")));
  ok(/warnline \| The bars are only 3\d px apart in this photo; readings may be a point or two off/.test(res[0]), "bars ~34 px apart: amber warning");
  ok(/badline \| The bars are only 2\d px apart in this photo, too few to measure reliably/.test(res[1]), "bars ~24 px apart: red warning");
  await tap(page, 1);
  ok(/too few to measure reliably/.test(await resultText(page)), "red resolution warning repeated under Result when that photo is tapped");

  /* ---- phone width ---- */
  await page.setViewportSize({width: 390, height: 844});
  await page.waitForTimeout(300);
  const over = await page.evaluate(() => ({doc: document.documentElement.scrollWidth, wide: [...document.querySelectorAll("body *")].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(e).position !== "fixed").map(e => e.tagName + "." + e.className).slice(0, 8)}));
  ok(over.doc <= 390 && !over.wide.length, "390 px wide: no sideways scroll" + (over.wide.length ? " (too wide: " + over.wide.join(", ") + ")" : ""));
  const cols = await page.evaluate(() => [...document.querySelectorAll(".reading .what, #resultCard .tip")].map(e => Math.round(e.getBoundingClientRect().width)));
  ok(cols.length && Math.min(...cols) >= 200, "390 px wide: saved readings and the Saves-under line keep a readable width (" + cols.join(", ") + " px)");
  if (SHOTS) {
    await page.screenshot({path: path.join(SHOTS, "phone-result.png"), fullPage: false, clip: await page.$eval("#resultCard", e => { e.scrollIntoView(); const r = e.getBoundingClientRect(); return {x: 0, y: Math.max(0, r.top), width: 390, height: Math.min(844, r.height + 20)}; })});
    await page.$eval("#saved", e => e.scrollIntoView({block: "end"}));
    await page.screenshot({path: path.join(SHOTS, "phone-saved.png")});
  }
  if (SHOTS) {          // and an iPad in portrait, for a look
    await page.setViewportSize({width: 820, height: 1180});
    await page.$eval("#resultCard", e => e.scrollIntoView());
    await page.screenshot({path: path.join(SHOTS, "ipad-result.png")});
    await page.$eval("#saved", e => e.scrollIntoView({block: "end"}));
    await page.screenshot({path: path.join(SHOTS, "ipad-saved.png")});
  }
  ok(!errors.length, "no page errors" + (errors.length ? ": " + errors.join("; ") : ""));
  await ctx.close();

  /* ---- base folder missing / not shared ---- */
  {
    const D2 = fakeDropbox({baseExists: false});
    const c2 = await browser.newContext({serviceWorkers: "block"}); await D2.install(c2);
    await c2.addInitScript(() => {
      localStorage.setItem("tribar.dbx.tokens", JSON.stringify({access: "AT1", refresh: "RT", expiresAt: Date.now() + 3600e3}));
      localStorage.setItem("tribar.dbx.account", JSON.stringify({name: "Test Inspector", rootNamespaceId: "7777"}));
      if (!localStorage.getItem("tribar.v1")) localStorage.setItem("tribar.v1", JSON.stringify({readings: [{id: "abc12345", savedAt: "2026-11-02T10:00:00Z", site: "S", band: "0-10%", photos: [], files: [], synced: false}]}));
    });
    const p2 = await c2.newPage(); await p2.goto(APP);
    await p2.waitForFunction(() => /isn’t shared with you/.test(document.querySelector("#syncMsg").textContent), null, {timeout: 15000}).catch(() => {});
    ok(/Tribar Readings” isn’t shared with you/.test(await p2.textContent("#syncMsg")), "base folder missing: " + (await p2.textContent("#syncMsg")));
    ok(D2.log.filter(l => l.endpoint === "files/upload").length === 0 && D2.folders.size === 0, "and nothing uploaded or created");
    await c2.close();
  }

  /* ---- the other address: redirect URI comes from where the app is open ---- */
  {
    const D3 = fakeDropbox();
    const c3 = await browser.newContext({serviceWorkers: "block"}); await D3.install(c3);
    const p3 = await c3.newPage(), other = "http://127.0.0.1:" + port + "/Tribar_Calculator/";
    await p3.goto(other + "index.html");
    await Promise.all([p3.waitForURL(/code=|Tribar_Calculator\/$/), p3.click("#signInBtn")]);
    await p3.waitForFunction(() => TribarSync.account(), null, {timeout: 15000}).catch(() => {});
    ok(D3.authorize[0].redirect_uri === other && D3.tokenCalls[0].redirect_uri === other && await p3.evaluate(() => !!TribarSync.account()),
       "opened at " + other + "index.html: redirect URI " + D3.authorize[0].redirect_uri + ", signed in");
    await c3.close();
  }

  /* ---- in-app camera: shows the photo size ---- */
  {
    const c4 = await browser.newContext({serviceWorkers: "block", permissions: ["camera"]});
    const p4 = await c4.newPage(); await p4.goto(APP);
    await p4.click("#shootBtn");
    await p4.waitForFunction(() => !document.querySelector("#camRes").hidden, null, {timeout: 15000}).catch(() => {});
    const label = await p4.textContent("#camRes");
    ok(/^(Preview \d+×\d+ · photos are full-resolution stills|Photo \d+×\d+ \(\d+\.\d MP, a frame of the preview\))/.test(label), "camera label: " + label);
    await p4.click("#camShutter");
    await p4.waitForFunction(() => STATE.photos.length === 1 && STATE.photos[0].status !== "queued" && STATE.photos[0].status !== "measuring", null, {timeout: 60000});
    ok(await p4.evaluate(() => STATE.photos[0].source === "camera"), "in-app camera photo taken (" + (await p4.evaluate(() => STATE.photos[0].status + " " + (STATE.photos[0].srcSize || []).join("×"))) + ")");
    await c4.close();
  }

  /* ---- offline cache: the service worker caches sync.js, leaves Ventilation's cache alone, and the app opens with no signal ---- */
  {
    const c5 = await browser.newContext();
    const p5 = await c5.newPage();
    await p5.goto("http://localhost:" + port + "/elsewhere");      // same origin, outside the app, before its service worker exists
    await p5.evaluate(async () => { await (await caches.open("ventsizing-v2")).put("/ventilation/", new Response("vent"));
                                    await (await caches.open("tribar-v1")).put("/Tribar_Calculator/", new Response("old")); });
    await p5.goto(APP);
    await p5.evaluate(() => navigator.serviceWorker.ready);
    await p5.waitForTimeout(800);
    const cached = await p5.evaluate(async () => { const c = await caches.open("tribar-v2"); return (await c.keys()).map(r => new URL(r.url).pathname.split("/").pop()); });
    ok(cached.includes("sync.js") && cached.includes("tribar.js"), "offline cache tribar-v2 holds sync.js: " + cached.join(", "));
    const names = await p5.evaluate(() => caches.keys());
    ok(names.includes("ventsizing-v2") && !names.includes("tribar-v1"), "update clears the old tribar-v1 cache and keeps Ventilation's (" + names.join(", ") + ")");
    await c5.setOffline(true);
    await p5.reload();
    ok(await p5.evaluate(() => typeof TribarSync === "object" && typeof Tribar === "object"), "reloads offline with both scripts");
    await c5.close();
  }

  await browser.close(); server.close();
  console.log(failures ? "\n" + failures + " FAILED" : "\nall passed");
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
