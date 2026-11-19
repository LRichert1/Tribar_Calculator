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
   offline cache, the phone-width layout, and deleting a site with two iPads
   (the deleted list that stops the other iPad bringing back what it had backed up). */
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
  const D = {files: new Map(), folders: new Set(), log: [], authorize: [], tokenCalls: [], expired: new Set(), issued: 0, deleted: []};
  const low = p => p.toLowerCase();
  const addFolder = p => { const parts = p.split("/").filter(Boolean); for (let i = 1; i <= parts.length; i++) D.folders.add(low("/" + parts.slice(0, i).join("/"))); };
  if (baseExists) addFolder(BASE);
  let revs = 0;
  D.put = (p, body) => { addFolder(p.slice(0, p.lastIndexOf("/"))); D.files.set(low(p), {path: p, body: Buffer.from(body), rev: "r" + (++revs), modified: new Date().toISOString()}); };
  const CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type, Dropbox-API-Arg, Dropbox-API-Path-Root",
                "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Expose-Headers": "Dropbox-API-Result"};
  const json = (route, status, obj) => route.fulfill({status, headers: Object.assign({"Content-Type": "application/json"}, CORS), body: JSON.stringify(obj)});
  const displayOf = lowPath => { const f = [...D.files.values()].find(x => low(x.path).startsWith(lowPath + "/")); return f ? f.path.slice(0, lowPath.length) : lowPath; };
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
          if (!a || a.code_challenge !== challenge || a.redirect_uri !== p.redirect_uri || p.client_id !== "7foui8a0tu6za74")
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
      if (endpoint === "files/get_metadata") {
        if (team && D.files.has(low(p))) { const f = D.files.get(low(p)); return json(route, 200, {".tag": "file", name: f.path.split("/").pop(), path_lower: low(p), path_display: f.path, rev: f.rev}); }
        return team && D.folders.has(low(p)) ? json(route, 200, {".tag": "folder", name: p.split("/").pop(), path_lower: low(p)}) : notFound(route);
      }
      if (endpoint === "files/delete_v2") {
        if (!team || D.denyDelete) return json(route, 403, {error_summary: "path_lookup/no_permission/.."});
        const isFolder = D.folders.has(low(p)), isFile = D.files.has(low(p));
        if (!isFolder && !isFile) return notFound(route);
        D.deleted.push(p);
        if (isFile) D.files.delete(low(p));
        else { for (const k of [...D.files.keys()]) if (k.startsWith(low(p) + "/")) D.files.delete(k); for (const f of [...D.folders]) if (f === low(p) || f.startsWith(low(p) + "/")) D.folders.delete(f); }
        return json(route, 200, {metadata: {name: p.split("/").pop(), path_lower: low(p)}});
      }
      if (endpoint === "files/upload") {
        if (!team) return json(route, 403, {error_summary: "path/no_write_permission/.."});
        if (D.onUpload) { const hook = D.onUpload; D.onUpload = null; hook(p); }          // another iPad writing just before this one lands
        const was = D.files.get(low(p)), mode = arg.mode && arg.mode[".tag"];
        if ((mode === "add" && was) || (mode === "update" && (!was || was.rev !== arg.mode.update))) return json(route, 409, {error_summary: "path/conflict/file/.."});
        D.put(p, req.postDataBuffer() || Buffer.alloc(0));
        return json(route, 200, {name: p.split("/").pop(), path_lower: low(p), path_display: p, rev: D.files.get(low(p)).rev});
      }
      if (endpoint === "files/list_folder") {
        if (!team || !D.folders.has(low(p))) return notFound(route);
        const under = x => arg.recursive ? low(x).startsWith(low(p) + "/") : low(x.slice(0, x.lastIndexOf("/"))) === low(p);
        const folderOf = x => [...D.folders].find(f => f === low(x));
        const entries = [...D.files.values()].filter(f => under(f.path))
          .map(f => ({".tag": "file", name: f.path.split("/").pop(), path_lower: low(f.path), path_display: f.path, rev: f.rev, server_modified: f.modified}));
        for (const f of D.folders) if (arg.recursive ? f.startsWith(low(p) + "/") : f.slice(0, f.lastIndexOf("/")) === low(p))   // subfolders, like Dropbox
          entries.push({".tag": "folder", name: displayOf(f).split("/").pop(), path_lower: f, path_display: displayOf(f)});
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
  await page.evaluate(() => { document.querySelector("#pickInput").value = ""; });       // choosing the same file again must still add it
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
// CSV text -> rows of cells (quoted cells may hold commas)
const parseCsv = text => text.replace(/^\ufeff/, "").trim().split("\r\n").map(line => {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++){ const ch = line[i];
    if (q){ if (ch === '"' && line[i + 1] === '"'){ cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ","){ out.push(cur); cur = ""; } else cur += ch; }
  out.push(cur); return out; });

async function main() {
  await new Promise(r => server.listen(0, r));
  const port = server.address().port, APP = "http://localhost:" + port + "/Tribar_Calculator/";
  const browser = await chromium.launch({args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]});
  const D = fakeDropbox();
  // another iPad's reading, already in the site folder
  const other = {id: "zzzz9999", savedAt: "2026-11-01T15:00:00.000Z", site: SITE, barn: "Barn B", room: "1", row: "2", crate: "3",
                 band: "30-40%", worstSpot: 0.35, spotsAveraged: 3, spotLosses: [0.33, 0.35, 0.37], spotSpread: 0.04,
                 worstSpotN: 60, worstBar: 0.3, worstSpotPhoto: "x.jpg", typical: 0.3, used: 12, total: 12, baseline: 0.4686, by: "Other Inspector",
                 photos: [{name: "x.jpg", pick: {loss: 0.35}}], files: [{kind: "marked", suffix: "marked 1.jpg", uploaded: true, dropboxName: "2026-11-01 Barn B Room 1 Row 2 Crate 3 zzzz9999 marked 1.jpg"}]};
  D.put(BASE + "/" + SITE + "/2026-11-01 Barn B Room 1 Row 2 Crate 3 zzzz9999.json", JSON.stringify(other));
  D.put(BASE + "/" + SITE + "/2026-11-01 Barn B Room 1 Row 2 Crate 3 zzzz9999 marked 1.jpg", fs.readFileSync(path.join(PHOTOS, "far-off.jpg")));

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
  ok(await page.isVisible("#dashView") && !(await page.isVisible("#measureView")), "opens on the dashboard");
  ok(/Old Site/.test(await page.textContent("#dashTable")) && /1 not backed up/.test(await page.textContent("#dashTable")), "signed out, the dashboard lists this iPad's readings by site");
  await page.click("#newReadingBtn");
  await page.waitForFunction(() => VIEW.name === "measure");
  ok(await page.isVisible("#measureView") && page.url().endsWith("#/measure"), "+ New reading opens the measuring page");

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
  const guides = await page.$$eval(".photo", cards => cards.map(c => { const g = c.querySelector(".guide"); if (!g || g.hidden) return null;
    const cv = g.querySelector("canvas"), d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
    let yellow = 0, photo = 0; for (let i = 0; i < d.length; i += 4){ if (d[i] > 200 && d[i + 1] > 180 && d[i + 2] < 80) yellow++; else if (d[i] + d[i + 1] + d[i + 2] > 120) photo++; }
    return {text: g.innerText, w: cv.width, h: cv.height, yellow, photo}; }));
  ok(guides[0] === null && guides[1] && /^Tap this same spot/.test(guides[1].text) && guides[1].yellow > 100 && guides[1].photo > 2000,
     "photo 2 shows a close-up of the spot tapped in photo 1, outlined, labeled Tap this same spot (" + (guides[1] ? guides[1].w + "×" + guides[1].h : "none") + "); photo 1 doesn't");
  const pitch1 = await page.evaluate(() => { const p = STATE.photos[0].pick, m = p.spot[p.spot.length >> 1]; return m[3]; });
  ok(guides[1] && Math.abs(guides[1].w / 200 - 1) < 1e-9, "close-up spans two bar spacings (" + Math.round(2 * pitch1) + " px of photo 1)");
  if (SHOTS) await page.$eval(".photo:nth-child(2)", e => e.scrollIntoView()), await page.screenshot({path: path.join(SHOTS, "guide.png")});
  const l2 = await tap(page, 1);
  await addPhotos(page, "spot-3.jpg");
  ok(await page.$eval(".photo:nth-child(3) .guide", g => !g.hidden), "a third photo gets the close-up too");
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

  /* ---- sign in (from the dashboard) ---- */
  await page.click("#measureCrumbs >> text=‹ Dashboard");
  await page.waitForFunction(() => VIEW.name === "dash");
  await Promise.all([page.waitForURL(u => /code=/.test(u)), page.click("#signInBtn")]);
  await page.waitForFunction(() => /all readings backed up/.test(document.querySelector("#syncMsg").textContent), null, {timeout: 30000});
  const auth = D.authorize[0];
  ok(auth.redirect_uri === APP && auth.code_challenge_method === "S256" && auth.token_access_type === "offline" &&
     auth.scope === "account_info.read files.metadata.read files.content.read files.content.write" && auth.client_id === "7foui8a0tu6za74",
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
  { const rows = parseCsv(csvText), col = rows[0].indexOf("Saved by");
    ok(col > 0 && rows.slice(1).map(r => r[col]).sort().join("|") === "Other Inspector|Test Inspector", "site CSV in Dropbox has a Saved by column: " + rows.slice(1).map(r => r[col]).join(", ")); }
  ok(JSON.parse(D.files.get((BASE + "/Old Site/2026-10-20 Gestation Room 4 Row 1 old00001.json").toLowerCase()).body).by === "Test Inspector",
     "a reading saved signed out gets who saved it when it uploads");
  const gets = D.log.filter(l => l.endpoint === "files/download").map(l => l.headers["dropbox-api-arg"]);
  ok(gets.length && gets.every(a => a.includes("zzzz9999")), "only the other iPad's JSON is downloaded (CSV rebuild and dashboard), never this iPad's own" + (gets.every(a => a.includes("zzzz9999")) ? "" : ": " + gets.join(" | ")));
  ok(D.files.has((BASE + "/Old Site/Tribar readings - Old Site.csv").toLowerCase()), "old site's CSV built too");
  const j1 = JSON.parse(D.files.get(mine.find(n => n.endsWith(".json")).toLowerCase()).body);
  ok(j1.spotsAveraged === 3 && j1.files.every(f => f.uploaded && f.dropboxName && !f.key) && !("synced" in j1), "uploaded JSON lists its photos' Dropbox names");
  ok(await page.evaluate(async () => !(await TribarSync.IDB.get(STATE.readings[0].files.find(f => f.kind === "original").key))), "originals cleared from the device once uploaded");
  ok(await page.evaluate(async () => !!(await TribarSync.IDB.get(STATE.readings[0].files.find(f => f.kind === "marked").key))), "marked-up photos stay on the device for sharing");
  ok(/Backed up/.test(await page.textContent(".reading .cloud")), "reading shows Backed up");
  const v2 = await page.evaluate(() => ["#signInBtn", "#signOutBtn", "#syncBtn"].map(s => getComputedStyle(document.querySelector(s)).display));
  ok(v2[0] === "none" && v2[1] !== "none" && v2[2] !== "none", "signed in: Sign out and Sync now shown, Sign in hidden");
  ok(page.url().endsWith("#/") && await page.isVisible("#dashView"), "back from sign-in on the page it was started from (dashboard)");

  /* ---- dashboard: every site in the team folder ---- */
  await page.waitForFunction(() => TEAM.index && !TEAM.busy && Object.keys(TEAM.index.readings).length >= 3, null, {timeout: 20000});
  const dashRows = await page.$$eval("#dashTable tbody tr", trs => trs.map(tr => [...tr.cells].map(c => c.innerText.trim())));
  const tsf = dashRows.find(r => r[0] === SITE), old = dashRows.find(r => r[0] === "Old Site");
  ok(tsf && tsf[1] === "2" && tsf[2] === "30 to 40%" && tsf[4] === "2" && /Backed up/.test(tsf[6]), "dashboard: " + SITE + " with the other iPad's reading: " + (tsf || []).join(" | "));
  ok(old && old[1] === "1", "dashboard: Old Site with its 1 reading");
  const kp = await page.$$eval("#dashKpis .kpi", ks => ks.map(k => k.innerText.replace(/\s+/g, " ").trim()));
  ok(kp[0] === "2 SITES" && kp[1] === "3 READINGS" && /^30 to 40% WORST READING$/i.test(kp[2]) && /^0 NOT BACKED UP/i.test(kp[3]), "KPIs: " + kp.join(" · "));
  const downloads = () => D.log.filter(l => l.endpoint === "files/download").length;
  const dl0 = downloads();
  await page.click("#syncBtn");
  await page.waitForFunction(() => !TEAM.busy && !SYNC.busy && Date.now() - TEAM.index.at < 3000);
  ok(downloads() === dl0, "Sync now re-reads the team folder without downloading readings it already has");
  ok(/Team folder checked/.test(await page.textContent("#syncMsg")), "sync bar says when the team folder was checked");
  await page.fill("#dashSearch", "old");
  ok((await page.$$("#dashTable tbody tr")).length === 1, "search narrows the list");
  await page.fill("#dashSearch", "");

  /* ---- a site's page ---- */
  await page.click("#dashTable tbody tr >> text=" + SITE);
  await page.waitForFunction(() => VIEW.name === "site");
  ok(await page.isVisible("#siteView") && decodeURIComponent(page.url()).endsWith("#/site/" + SITE), "a row opens the site's page");
  const siteRows = await page.$$eval("#siteView tbody tr", trs => trs.map(tr => [...tr.cells].map(c => c.innerText.replace(/\s+/g, " ").trim())));
  ok(siteRows.length === 2 && /^Barn B/.test(siteRows[0][0]) && /^Farrowing 2/.test(siteRows[1][0]), "readings in barn order: " + siteRows.map(r => r[0]).join(" / "));
  ok(/Other Inspector/.test(siteRows[0][4]) && /Test Inspector/.test(siteRows[1][4]), "each reading says who saved it");
  ok(/avg of 3, spread/.test(siteRows[1][2]), "the averaged reading shows its photo count and spread");
  // a photo another iPad uploaded comes from Dropbox
  await page.click("#siteView tbody tr:nth-child(1) >> text=🖼 Photo");
  await page.waitForFunction(() => !document.querySelector("#lightbox").hidden && document.querySelector("#lbImg").naturalWidth > 0, null, {timeout: 15000});
  ok(D.log.some(l => l.endpoint === "files/download" && /zzzz9999 marked 1\.jpg/.test(l.headers["dropbox-api-arg"])), "the other iPad's marked-up photo opens from Dropbox");
  await page.click("#lbClose");
  // this iPad's comes from the device: 3 photos
  const dlBefore = downloads();
  await page.click("#siteView tbody tr:nth-child(2) >> text=🖼 Photos");
  await page.waitForFunction(() => !document.querySelector("#lightbox").hidden && document.querySelector("#lbImg").naturalWidth > 0);
  ok((await page.textContent("#lbN")) === "1 of 3" && downloads() === dlBefore, "this iPad's 3 marked-up photos open from the device");
  await page.click("#lbNext");
  await page.waitForFunction(() => document.querySelector("#lbImg").complete && document.querySelector("#lbImg").naturalWidth > 0);
  const second = await page.evaluate(() => ({n: document.querySelector("#lbN").textContent, file: LB.files[LB.i].name, src: document.querySelector("#lbImg").src === LB.urls[1]}));
  ok(second.n === "2 of 3" && / marked 2\.jpg$/.test(second.file) && second.src, "› goes to the next photo (" + second.file + ")");
  if (SHOTS) await page.screenshot({path: path.join(SHOTS, "lightbox.png")});
  await page.click("#lbClose");
  // CSV of the site
  await page.evaluate(() => { window.__names = []; const orig = downloadBlob; downloadBlob = (n, b) => { __names.push(n); window.__csv = b; orig(n, b); }; });
  await Promise.all([page.waitForEvent("download"), page.click("#siteView >> text=⬇ CSV")]);
  const csvRows = await page.evaluate(async () => (await window.__csv.text()).trim().split("\r\n").length);
  ok(/,Saved by,/.test(await page.evaluate(async () => (await window.__csv.text()).split("\r\n")[0])), "site CSV download has Saved by");
  ok(csvRows === 3 && /^Tribar readings - Test Site’s Farm - \d{4}-\d\d-\d\d\.csv$/.test(await page.evaluate(() => __names[0])), "site CSV download: 2 readings + header");
  ok(/Tribar%20Readings\/Test%20Site%E2%80%99s%20Farm$/.test(await page.getAttribute("#siteView a.btn", "href")), "Open in Dropbox links to the site folder");
  // mark complete, for everyone
  page.once("dialog", d => d.accept());
  await page.click("#siteView >> text=✓ Mark complete");
  await page.waitForFunction(() => /marked complete/.test(document.querySelector("#siteView .vsub").textContent), null, {timeout: 15000});
  const st = D.files.get((site + "Site status.json").toLowerCase());
  ok(st && JSON.parse(st.body).status === "past" && JSON.parse(st.body).by === "Test Inspector", "Mark complete writes the site's status to its folder");
  await page.click("#siteView >> text=‹ Dashboard");
  await page.waitForFunction(() => VIEW.name === "dash");
  const tabsTxt = await page.textContent("#dashTabs");
  ok(/Current\s*1/.test(tabsTxt) && /Past\s*1/.test(tabsTxt), "dashboard tabs: 1 current, 1 past (" + tabsTxt.replace(/\s+/g, " ") + ")");
  ok(await page.evaluate(() => (D => !D.includes("Site status"))(JSON.stringify(Object.keys(TEAM.index.readings)))), "the status file isn't counted as a reading");
  if (SHOTS) { await page.screenshot({path: path.join(SHOTS, "dashboard.png")}); }
  await page.click("#dashTable tbody tr >> text=" + SITE);
  await page.waitForFunction(() => VIEW.name === "site");
  page.once("dialog", d => d.accept());
  await page.click("#siteView >> text=Reopen");
  await page.waitForFunction(() => !/marked complete/.test(document.querySelector("#siteView .vsub").textContent), null, {timeout: 15000});
  ok(JSON.parse(D.files.get((site + "Site status.json").toLowerCase()).body).status === "current", "Reopen puts it back");
  if (SHOTS) { await page.screenshot({path: path.join(SHOTS, "site.png"), fullPage: true}); }
  await page.click("#siteView >> text=+ New reading here");
  await page.waitForFunction(() => VIEW.name === "measure");
  ok(await page.isVisible("#measureView") && (await page.inputValue("#fSite")) === SITE && (await page.inputValue("#fBarn")) === "Farrowing 2", "+ New reading here opens measuring at that site");
  { // + New reading on the dashboard is a new site: blank location. On a site's page it continues that site.
    const loc = await page.evaluate(() => Object.assign({}, STATE.loc)), toDash = async () => { await page.evaluate(() => { location.hash = "#/"; }); await page.waitForFunction(() => VIEW.name === "dash"); };
    await page.evaluate(() => STATE.photos.push({id: "pending", status: "done"}));        // a reading under way (photos taken) is left alone
    await toDash(); await page.click("#newReadingBtn"); await page.waitForFunction(() => VIEW.name === "measure");
    ok(await page.inputValue("#fSite") === loc.site && await page.inputValue("#fBarn") === loc.barn, "+ New reading with photos already taken keeps the reading under way");
    await page.evaluate(() => STATE.photos.pop());
    await toDash(); await page.click("#newReadingBtn"); await page.waitForFunction(() => VIEW.name === "measure");
    const vals = await page.evaluate(() => ["#fSite", "#fBarn", "#fRoom", "#fRow", "#fCrate", "#fNote"].map(s => document.querySelector(s).value));
    ok(vals.every(v => v === "") && await page.evaluate(() => Object.values(STATE.loc).every(v => !v)), "+ New reading on the dashboard starts a new site: every location field is blank (" + vals.join("|") + ")");
    ok((await page.$$eval("#measureCrumbs a", a => a.map(x => x.textContent))).join() === "‹ Dashboard", "and the page doesn't link back to the last site");
    ok(await page.evaluate(() => JSON.parse(localStorage.getItem("tribar.v1")).loc.site) === "", "and the blank location is what's saved on the iPad");
    for (const [id, k] of [["#fSite", "site"], ["#fBarn", "barn"], ["#fRoom", "room"], ["#fRow", "row"], ["#fCrate", "crate"], ["#fNote", "note"]]) await page.fill(id, loc[k] || "");     // back to where the next checks expect
  }

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
  ok([...D.files.keys()].filter(k => k.endsWith(".json") && !k.endsWith("site status.json") && k.startsWith(site.toLowerCase())).length === 4 &&
     D.files.get((site + "Tribar readings - " + SITE + ".csv").toLowerCase()).body.toString().trim().split("\r\n").length === 5, "site CSV now has all 4 readings");
  const [dl2] = await Promise.all([page.waitForEvent("download"), page.click(".reading button[title='Share the marked-up photo']")]);
  ok(!!dl2, "Share still works after backup (marked-up photo kept)");
  await page.evaluate(() => { window.__exp = null; const orig = downloadBlob; downloadBlob = (n, b) => { window.__exp = b; orig(n, b); }; });
  await Promise.all([page.waitForEvent("download"), page.click("#csvBtn")]);
  { const rows = parseCsv(await page.evaluate(async () => window.__exp.text()));
    const col = rows[0].indexOf("Saved by");
    ok(col > 0 && rows.length === 5 && rows.slice(1).every(r => r[col] === "Test Inspector"), "Export CSV has a Saved by column, filled for every reading"); }
  ok(await page.evaluate(async () => Object.keys((await TribarSync.cachedIndex()).readings).length) >= 3, "the team folder's index is kept on the device for when there's no signal");

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
  for (const [h, what] of [["#/", "dashboard"], ["#/site/" + encodeURIComponent(SITE), "site page"]]) {
    await page.evaluate(h => { location.hash = h; }, h); await page.waitForTimeout(300);
    const o = await page.evaluate(() => ({doc: document.documentElement.scrollWidth, wide: [...document.querySelectorAll("body *")].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(e).position !== "fixed" && e.offsetParent).map(e => e.tagName + "." + e.className).slice(0, 8)}));
    ok(o.doc <= 390 && !o.wide.length, "390 px wide " + what + ": no sideways scroll" + (o.wide.length ? " (too wide: " + o.wide.join(", ") + ")" : ""));
    if (SHOTS) await page.screenshot({path: path.join(SHOTS, "phone-" + what.split(" ")[0] + ".png"), fullPage: true});
  }
  await page.evaluate(() => { location.hash = "#/measure"; }); await page.waitForTimeout(300);
  if (SHOTS) {          // and an iPad in portrait, for a look
    await page.setViewportSize({width: 820, height: 1180});
    await page.$eval("#resultCard", e => e.scrollIntoView());
    await page.screenshot({path: path.join(SHOTS, "ipad-result.png")});
    await page.$eval("#saved", e => e.scrollIntoView({block: "end"}));
    await page.screenshot({path: path.join(SHOTS, "ipad-saved.png")});
    await page.evaluate(() => { location.hash = "#/"; }); await page.waitForTimeout(300);
    await page.screenshot({path: path.join(SHOTS, "ipad-dashboard.png")});
    await page.evaluate(h => { location.hash = h; }, "#/site/" + encodeURIComponent(SITE)); await page.waitForTimeout(300);
    await page.screenshot({path: path.join(SHOTS, "ipad-site.png")});
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
    await c3.addInitScript(() => { if (!localStorage.getItem("tribar.v1")) localStorage.setItem("tribar.v1", JSON.stringify({readings: [
      {id: "nobyby01", savedAt: "2026-11-16T17:04:12Z", site: "c44", barn: "farrowing", room: "15", row: "2", crate: "1", band: "0-10%", worstSpot: -0.03,
       photos: [], files: [], synced: "2026-11-16T17:04:16Z"}]})); });
    const p3 = await c3.newPage(), other = "http://127.0.0.1:" + port + "/Tribar_Calculator/";
    await p3.goto(other + "index.html");
    await Promise.all([p3.waitForURL(/code=|Tribar_Calculator\/$/), p3.click("#signInBtn")]);
    await p3.waitForFunction(() => TribarSync.account(), null, {timeout: 15000}).catch(() => {});
    ok(D3.authorize[0].redirect_uri === other && D3.tokenCalls[0].redirect_uri === other && await p3.evaluate(() => !!TribarSync.account()),
       "opened at " + other + "index.html: redirect URI " + D3.authorize[0].redirect_uri + ", signed in");
    await p3.waitForFunction(() => STATE.readings[0].by, null, {timeout: 15000}).catch(() => {});
    const nb = D3.files.get((BASE + "/c44/2026-11-16 farrowing Room 15 Row 2 Crate 1 nobyby01.json").toLowerCase());
    ok(nb && JSON.parse(nb.body).by === "Test Inspector", "a reading backed up without who saved it is re-uploaded with the signed-in name, once" + (nb ? "" : " — files: " + [...D3.files.values()].map(f => f.path.slice(BASE.length)).join(" | ") +
       " — page: " + await p3.evaluate(() => JSON.stringify({err: SYNC.error, busy: SYNC.busy, by: STATE.readings[0].by, signedIn: TribarSync.signedIn(), acct: !!TribarSync.account(), msg: document.querySelector("#syncMsg").textContent})) +
       " — calls: " + D3.log.map(l => l.endpoint).join(",")));
    await c3.close();
  }

  /* ---- in-app camera: shows the photo size ---- */
  {
    const c4 = await browser.newContext({serviceWorkers: "block", permissions: ["camera"]});
    const p4 = await c4.newPage(); await p4.goto(APP + "#/measure");
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
    const CACHE = /const CACHE = "([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, "sw.js"), "utf8"))[1];
    const cached = await p5.evaluate(async c => { const cc = await caches.open(c); return (await cc.keys()).map(r => new URL(r.url).pathname.split("/").pop()); }, CACHE);
    ok(cached.includes("sync.js") && cached.includes("tribar.js"), "offline cache " + CACHE + " holds sync.js: " + cached.join(", "));
    const names = await p5.evaluate(() => caches.keys());
    ok(names.includes("ventsizing-v2") && !names.includes("tribar-v1") && names.includes(CACHE), "update clears the old tribar-v1 cache and keeps Ventilation's (" + names.join(", ") + ")");
    await c5.setOffline(true);
    await p5.reload();
    ok(await p5.evaluate(() => typeof TribarSync === "object" && typeof Tribar === "object"), "reloads offline with both scripts");
    await c5.close();
  }

  /* ---- one site, however its name is typed ---- */
  {
    const keys = await (async () => { const c = await browser.newContext({serviceWorkers: "block"}), q = await c.newPage(); await q.goto(APP);
      const k = await q.evaluate(() => ["C-44", "C44", "C044", "c 44", "C 044", "c_44", "C.44", "Peddler Creek Pork", "peddler-creek pork"].map(TribarSync.siteKey)); await c.close(); return k; })();
    ok(keys.slice(0, 7).every(k => k === "C44") && keys[7] === keys[8] && keys[7] !== "C44", "site keys: " + keys.join(", "));
    const D7 = fakeDropbox();
    const mk = (id, site, folder, day) => { const r = {id, savedAt: "2026-11-" + day + "T15:00:00.000Z", site, barn: "B", room: "1", row: "1", crate: "1", band: "10-20%",
      worstSpot: 0.15, by: "Other Inspector", photos: [], files: []}; D7.put(BASE + "/" + folder + "/2026-11-" + day + " B Room 1 Row 1 Crate 1 " + id + ".json", JSON.stringify(r)); };
    mk("old44aaa", "C044", "C044", "01"); mk("site9aaa", "C9", "C9", "02"); mk("sit100aa", "C100", "C100", "03"); mk("site10aa", "C10", "C10", "04");
    const c7 = await browser.newContext({serviceWorkers: "block"}); await D7.install(c7);
    await c7.addInitScript(() => {
      localStorage.setItem("tribar.dbx.tokens", JSON.stringify({access: "AT1", refresh: "RT", expiresAt: Date.now() + 3600e3}));
      localStorage.setItem("tribar.dbx.account", JSON.stringify({name: "Test Inspector", rootNamespaceId: "7777"}));
      if (!localStorage.getItem("tribar.v1")) localStorage.setItem("tribar.v1", JSON.stringify({readings: ["c 44", "C-44"].map((site, i) => (
        {id: "mine44a" + i, savedAt: "2026-11-16T1" + i + ":00:00.000Z", site, barn: "Farrowing", room: "2", row: "3", crate: String(4 + i), band: "20-30%", worstSpot: 0.25,
         photos: [], files: [], synced: false}))}));
    });
    const p7 = await c7.newPage(); const errs7 = []; p7.on("pageerror", e => errs7.push(e.message));
    await p7.goto(APP);
    await p7.waitForFunction(() => STATE.readings.every(r => r.synced) && !SYNC.busy && !TribarSync.pendingCsv(), null, {timeout: 20000});
    await p7.click("#syncBtn"); await p7.waitForFunction(() => TEAM.index && !TEAM.busy && Object.keys(TEAM.index.readings).length === 6, null, {timeout: 15000});
    const paths = [...D7.files.values()].map(f => f.path.slice(BASE.length + 1));
    ok(paths.filter(n => /mine44a/.test(n)).length === 2 && paths.filter(n => /mine44a/.test(n)).every(n => n.startsWith("C044/")) && !paths.some(n => /^(c 44|C-44)\//.test(n)),
       "readings typed “c 44” and “C-44” upload into the existing C044 folder, no new folder: " + paths.join(" | "));
    const csv7 = D7.files.get((BASE + "/C044/Tribar readings - C044.csv").toLowerCase());
    ok(csv7 && csv7.body.toString().trim().split("\r\n").length === 4, "C044's CSV has all 3 readings");
    const rows7 = await p7.$$eval("#dashTable tbody tr", t => t.map(r => [r.cells[0].innerText.trim(), r.cells[1].innerText.trim()]));
    ok(rows7.map(r => r[0]).join(",") === "C9,C10,C044,C100", "sites in natural order, one row per site: " + rows7.map(r => r.join(" ")).join(" | "));
    ok((rows7.find(r => r[0] === "C044") || [])[1] === "3", "C044 shows its own reading and both of this iPad's");
    await p7.evaluate(() => { location.hash = "#/site/c-44"; }); await p7.waitForFunction(() => VIEW.name === "site");
    ok((await p7.textContent("#siteView .vtitle")) === "C044" && (await p7.$$("#siteView tbody tr")).length === 3, "the site page for “c-44” is C044 with 3 readings");
    p7.once("dialog", d => d.accept());
    await p7.click("#siteView >> text=✓ Mark complete");
    await p7.waitForFunction(() => /marked complete/.test(document.querySelector("#siteView .vsub").textContent), null, {timeout: 15000});
    ok(D7.files.has((BASE + "/C044/Site status.json").toLowerCase()) && ![...D7.files.keys()].some(k => /\/c-44\//.test(k)), "Mark complete writes to the C044 folder");
    await p7.click("#siteView >> text=+ New reading here");
    await p7.waitForFunction(() => VIEW.name === "measure");
    const opts = await p7.$$eval("#siteList option", o => o.map(x => x.value));
    ok(opts.join(",") === "C9,C10,C044,C100" && (await p7.getAttribute("#fSite", "list")) === "siteList", "the Site field suggests each site once: " + opts.join(", "));
    ok(!errs7.length, "no page errors" + (errs7.length ? ": " + errs7.join("; ") : ""));
    await c7.close();
  }

  /* ---- deleting a site, with two iPads ---- */
  {
    const D8 = fakeDropbox(), LISTF = BASE + "/Deleted sites.json";
    const rd = (id, site, day, extra = {}) => Object.assign({id, savedAt: "2026-11-" + day + "T15:00:00.000Z", site, barn: "B", room: "1", row: "1", crate: "1", band: "10-20%",
      worstSpot: 0.15, by: "Other Inspector", photos: [{name: id + ".jpg", pick: {loss: 0.15}}], files: []}, extra);
    // put a reading in Dropbox: its JSON, a marked-up and an original photo
    const putReading = (dir, r) => { const n = BASE + "/" + dir + "/" + r.savedAt.slice(0, 10) + " B Room 1 Row 1 Crate 1 " + r.id;
      r.files = [{kind: "marked", suffix: "marked 1.jpg", uploaded: true, dropboxName: n.split("/").pop() + " marked 1.jpg"}, {kind: "original", suffix: "photo 1.jpg", uploaded: true, dropboxName: n.split("/").pop() + " photo 1.jpg"}];
      D8.put(n + ".json", JSON.stringify(r)); D8.put(n + " marked 1.jpg", "m"); D8.put(n + " photo 1.jpg", "o"); return n; };
    const paths = () => [...D8.files.values()].map(f => f.path.slice(BASE.length + 1));
    const tomb = () => { const f = D8.files.get(LISTF.toLowerCase()); return f ? JSON.parse(f.body) : null; };
    const pad = async readings => {
      const c = await browser.newContext({serviceWorkers: "block", viewport: {width: 1100, height: 900}}); await D8.install(c);
      await c.addInitScript(rs => {
        localStorage.setItem("tribar.dbx.tokens", JSON.stringify({access: "AT1", refresh: "RT", expiresAt: Date.now() + 3600e3}));
        localStorage.setItem("tribar.dbx.account", JSON.stringify({name: "Test Inspector", rootNamespaceId: "7777"}));
        if (!localStorage.getItem("tribar.v1")) localStorage.setItem("tribar.v1", JSON.stringify({readings: rs}));
      }, readings);
      const pg = await c.newPage(); pg.errs = []; pg.on("pageerror", e => pg.errs.push(e.message)); return {c, pg};
    };
    const idle = pg => pg.waitForFunction(() => !SYNC.busy && !SYNC.again && !TEAM.busy && TEAM.loaded && !TribarSync.pendingCsv() && !TribarSync.pendingDeletes(), null, {timeout: 20000})
      .catch(async e => { console.log("not idle:", JSON.stringify(await pg.evaluate(() => ({busy: SYNC.busy, err: SYNC.error, team: TEAM.error, tbusy: TEAM.busy, csv: localStorage.getItem("tribar.dbx.csvPending"), q: localStorage.getItem("tribar.dbx.deleteQueue")})))); throw e; });
    const dashRows = pg => pg.$$eval("#dashTable tbody tr", t => t.map(r => [r.cells[0].innerText.trim(), r.cells[1].innerText.trim()]));
    const dashSites = async pg => (await dashRows(pg)).map(r => r[0]);
    const inject = (pg, rs) => pg.evaluate(async rs => { for (const r of rs) for (const f of r.files || []) if (f.key) await TribarSync.IDB.put(f.key, new Blob(["x"], {type: "image/jpeg"}));
      STATE.readings = rs.concat(STATE.readings); persist(); renderSaved(); }, rs);

    // the team folder: C044 (3 readings, 4 photos, one of them iPad A's), Keep Farm (2 readings), and a file in the base folder
    const oth1 = rd("oth00001", "C044", "01", {photos: [{name: "a.jpg"}, {name: "b.jpg"}]}), oth2 = rd("oth00002", "C044", "02"), mineA = rd("mineA001", "C-44", "03", {by: "Test Inspector"});
    putReading("C044", oth1); putReading("C044", oth2); putReading("C044", mineA);
    D8.put(BASE + "/C044/Tribar readings - C044.csv", "old csv");
    putReading("Keep Farm", rd("keep0001", "Keep Farm", "04")); putReading("Keep Farm", rd("keep0002", "Keep Farm", "05"));
    D8.put(BASE + "/Tribar readings - old notes.txt", "a file in the base folder is not a site");

    /* iPad B: no signal, holding its own copies: C044 readings (one never uploaded, one backed up before without a name) and a Keep Farm one */
    const B = await pad([]);
    await B.pg.goto(APP); await idle(B.pg);
    ok((await dashSites(B.pg)).join(",") === "C044,Keep Farm", "B sees C044 and Keep Farm, and the file in the base folder isn't a site: " + (await dashSites(B.pg)).join(", "));
    await inject(B.pg, [rd("mineB001", "c 44", "10", {by: "Test Inspector", synced: false, files: [{key: "mineB001/m1", kind: "marked", suffix: "marked 1.jpg"}]}),
                        rd("mineB002", "C 044", "11", {by: undefined, synced: "2026-11-11T16:00:00Z"}),
                        rd("mineB003", "Keep Farm", "12", {by: "Test Inspector", synced: false})]);
    await B.c.setOffline(true);

    /* iPad A deletes the site; it also holds one reading that was never uploaded */
    const A = await pad([Object.assign({}, mineA, {site: "C-44", synced: "2026-11-03T16:00:00Z", files: mineA.files})]);
    await A.pg.goto(APP + "#/site/c-44"); await idle(A.pg);
    await inject(A.pg, [rd("unsentA1", "C-44", "08", {by: "Test Inspector", synced: false})]);
    await A.pg.evaluate(() => redrawTeamViews());
    ok(await A.pg.$$eval("#siteView tbody tr", r => r.length) === 4, "A: the site page for C044 has the 3 readings in Dropbox and A's unsent one");
    ok(await A.pg.$$eval("#siteView button[title='Delete reading']", b => b.length) === 0, "the site page has no Delete reading buttons");
    let seen = null; A.pg.on("dialog", d => { seen = {type: d.type(), msg: d.message()}; d.accept(A.answer); });
    A.answer = "not the name"; await A.pg.click("#siteView >> text=Delete site");
    await A.pg.waitForFunction(() => /isn’t the site name/.test(document.querySelector("#toast").textContent), null, {timeout: 15000});
    ok(seen && seen.type === "prompt" && /C044/.test(seen.msg) && /3 readings and 4 photos/.test(seen.msg) && /deleted files, where it can be restored/.test(seen.msg) && /Type the site name/.test(seen.msg),
       "Delete site asks for the name and says what goes (" + (seen && seen.msg.replace(/\n+/g, " ").slice(0, 150)) + ")");
    ok(/1 reading on this iPad hasn’t been backed up, so it is kept and will upload again/.test(seen.msg), "and says the reading that was never backed up is kept");
    ok(paths().some(n => n.startsWith("C044/")) && !tomb() && D8.deleted.length === 0, "a name that doesn't match deletes nothing");
    D8.denyDelete = true; A.answer = "C044"; await A.pg.click("#siteView >> text=Delete site");
    await A.pg.waitForFunction(() => /Couldn’t delete C044/.test(document.querySelector("#toast").textContent), null, {timeout: 15000});
    ok(paths().some(n => n.startsWith("C044/")) && !tomb() && await A.pg.evaluate(() => STATE.readings.length) === 2, "Dropbox refuses: nothing deleted, nothing written to the list, A keeps its readings");
    D8.denyDelete = false;
    D8.onUpload = p => { if (p === LISTF) D8.put(LISTF, JSON.stringify({sites: {ELSEWHERE: {key: "ELSEWHERE", name: "Elsewhere", at: "2026-11-15T10:00:00Z", by: "Third Inspector"}}})); };   // another iPad writes the list first
    const t0 = new Date().toISOString();
    A.answer = "C044"; await A.pg.click("#siteView >> text=Delete site");
    await A.pg.waitForFunction(() => VIEW.name === "dash" && /^Deleted C044/.test(document.querySelector("#toast").textContent), null, {timeout: 15000});
    await idle(A.pg);
    ok(!paths().some(n => n.startsWith("C044/")) && D8.deleted.filter(x => x.endsWith("/C044")).length === 1 && D8.deleted.length === 1, "the whole C044 folder is deleted with files/delete_v2 (" + D8.deleted.join(", ") + ")");
    { const t = tomb(), s44 = t && t.sites.C44;
      ok(s44 && s44.key === "C44" && s44.name === "C044" && s44.by === "Test Inspector" && s44.at >= t0 && Math.abs(Date.parse(s44.at) - Date.now()) < 60000, "Deleted sites.json lists the site: key, name, when, who " + JSON.stringify(s44));
      ok(t && t.sites.ELSEWHERE && t.sites.ELSEWHERE.by === "Third Inspector" && !("readings" in t), "the list was merged with what another iPad wrote at the same moment, not overwritten; it holds sites only"); }
    ok(await A.pg.evaluate(() => STATE.readings.map(r => r.id).join()) === "unsentA1", "A: its backed-up copy is gone from the iPad, the reading that was never uploaded is kept");
    await A.pg.waitForFunction(() => STATE.readings[0].synced, null, {timeout: 20000}); await idle(A.pg);
    ok(paths().some(n => /^C-44\/.*unsentA1\.json$/.test(n)) && !paths().some(n => n.startsWith("C044/")), "it uploads as usual, which brings the site back (as C-44): " + paths().filter(n => /unsentA1/.test(n)).join(" | "));
    ok((await dashRows(A.pg)).map(r => r.join(" ")).join(",") === "C-44 1,Keep Farm 2", "A's dashboard: " + (await dashRows(A.pg)).map(r => r.join(" ")).join(", "));
    ok(!paths().some(n => /^Tribar readings - C044/.test(n)) && paths().filter(n => n.startsWith("Keep Farm/")).length === 6, "Keep Farm untouched (and no summary came back for C044)");

    /* iPad B gets signal again */
    ok(!paths().some(n => /mineB/.test(n)), "(nothing of B's is in Dropbox yet)");
    await B.c.setOffline(false); await B.pg.evaluate(() => window.dispatchEvent(new Event("online")));
    await B.pg.waitForFunction(() => STATE.readings.length === 2 && STATE.readings.every(r => r.synced), null, {timeout: 20000}); await idle(B.pg);
    ok(!paths().some(n => /mineB002/.test(n)) && !paths().some(n => /^(c 44|C 044|C044)\//.test(n)), "B did not upload its backed-up copy of the deleted site, nor bring C044 back");
    ok(paths().some(n => /^C-44\/.*mineB001\.json$/.test(n)) && paths().some(n => /^C-44\/.*mineB001 marked 1\.jpg$/.test(n)) && paths().some(n => /^Keep Farm\/.*mineB003\.json$/.test(n)),
       "B's readings that were never uploaded do upload, the C044 one into the site's new folder: " + paths().filter(n => /mineB/.test(n)).join(" | "));
    ok(await B.pg.evaluate(() => STATE.readings.map(r => r.id).sort().join()) === "mineB001,mineB003", "B: the backed-up copy is gone from the iPad, the others stay");
    { const m = await B.pg.textContent("#syncMsg"); ok(/Removed from this iPad because the team deleted the site: 1 backed-up reading at C044 \(deleted by Test Inspector/.test(m), "B says what was removed and why: " + (m.match(/Removed[^)]*\)/) || [""])[0]); }
    ok((await dashRows(B.pg)).map(r => r.join(" ")).join(",") === "C-44 2,Keep Farm 3", "B's dashboard has no C044: " + (await dashRows(B.pg)).map(r => r.join(" ")).join(", "));
    await B.c.setOffline(true); await B.pg.evaluate(() => { TEAM.index = null; TEAM.loaded = false; return refreshTeam(false); });
    ok((await dashSites(B.pg)).join(",") === "C-44,Keep Farm" && await B.pg.evaluate(async () => !Object.values((await TribarSync.cachedIndex()).readings).some(e => /C044/.test(e.dir))),
       "offline, from the copy of the team folder kept on the iPad: still no C044");
    await B.c.setOffline(false);

    /* what B uploaded after the deletion is new work: a later sync doesn't take it off B, and it shows for everyone */
    await B.pg.evaluate(() => { STATE.readings.unshift({id: "newB0001", savedAt: new Date(Date.now() + 5000).toISOString(), site: "c 44", barn: "B", room: "9", row: "1", crate: "1", band: "0-10%", worstSpot: 0.02, by: "Test Inspector", photos: [], files: [], synced: false}); persist(); });
    await B.pg.evaluate(() => sync()); await idle(B.pg);
    ok(await B.pg.evaluate(() => STATE.readings.map(r => r.id).sort().join()) === "mineB001,mineB003,newB0001" && paths().some(n => /^C-44\/.*newB0001\.json$/.test(n)), "a later sync keeps B's readings that went up after the deletion, and uploads the newest");
    await A.pg.evaluate(() => refreshTeam(true)); await idle(A.pg);
    ok((await dashRows(A.pg)).map(r => r.join(" ")).join(",") === "C-44 3,Keep Farm 3", "A's dashboard shows them too: " + (await dashRows(A.pg)).map(r => r.join(" ")).join(", "));
    await B.c.close();

    /* the trash button on a reading is as it was: it only removes the reading from this iPad */
    const E = await pad([]);
    await E.pg.goto(APP + "#/measure"); await idle(E.pg);
    await inject(E.pg, [rd("off00002", "Keep Farm", "07", {by: "Test Inspector", synced: false}), Object.assign(rd("off00001", "Keep Farm", "06", {by: "Test Inspector"}), {synced: "2026-11-06T16:00:00Z"})]);
    const msgs = []; E.pg.on("dialog", d => { msgs.push(d.message()); d.accept(); });
    const calls = D8.log.length, delBefore = D8.deleted.length, tombBefore = D8.files.get(LISTF.toLowerCase()).rev;
    await E.pg.locator("#saved .reading", {hasText: "Room 1"}).first().locator("button[title='Delete reading']").click();   // off00002: not backed up (newest first)
    ok(msgs[0] === "Delete the reading for B · Room 1 · Row 1 · Crate 1 from front? It hasn’t been backed up to Dropbox." && await E.pg.evaluate(() => STATE.readings.map(r => r.id).join()) === "off00001", "a reading not backed up: the old warning, removed from the iPad");
    await E.pg.locator("#saved .reading button[title='Delete reading']").click();
    await E.pg.waitForFunction(() => STATE.readings.length === 0);
    ok(msgs[1] === "Delete the reading for B · Room 1 · Row 1 · Crate 1 from front?", "a backed-up reading: just the question: " + msgs[1]);
    await E.pg.waitForTimeout(500);
    ok(D8.deleted.length === delBefore && D8.log.slice(calls).every(l => l.endpoint !== "files/delete_v2") && D8.files.get(LISTF.toLowerCase()).rev === tombBefore && await E.pg.evaluate(() => TribarSync.pendingDeletes()) === 0,
       "neither touches Dropbox, the list or a queue");
    /* Delete site is not offered with no signal */
    await E.pg.evaluate(() => { location.hash = "#/site/keep%20farm"; }); await E.pg.waitForFunction(() => VIEW.name === "site");
    await E.c.setOffline(true); const nd = msgs.length;
    await E.pg.click("#siteView >> text=Delete site"); await E.pg.waitForTimeout(400);
    ok(msgs.length === nd && /No signal/.test(await E.pg.textContent("#toast")) && paths().some(n => n.startsWith("Keep Farm/")), "Delete site with no signal: refused, nothing asked, nothing deleted");
    ok(![A, B, E].some(x => x.pg.errs.length), "no page errors" + [A, B, E].map(x => x.pg.errs.join("; ")).join(""));
    await E.c.close(); await A.c.close();
  }

  /* ---- the highest-reading hint, and Edit spots on a saved reading ---- */
  {
    const D9 = fakeDropbox(), ESITE = "Edit Farm", EDIR = BASE + "/" + ESITE + "/";
    const legacy = {id: "leg00001", savedAt: "2026-10-02T15:00:00.000Z", site: "Legacy Farm", barn: "B", room: "1", row: "1", crate: "1", band: "10-20%", worstSpot: 0.15, by: "Other Inspector",
                    photos: [{name: "a.jpg", pick: {loss: 0.15}}], files: [{kind: "marked", suffix: "marked 1.jpg", uploaded: true, dropboxName: "2026-10-02 B Room 1 Row 1 Crate 1 leg00001 marked 1.jpg"}]};
    D9.put(BASE + "/Legacy Farm/2026-10-02 B Room 1 Row 1 Crate 1 leg00001.json", JSON.stringify(legacy));
    const oldLocal = Object.assign({}, legacy, {id: "old00001", site: "Old Farm", synced: "2026-10-02T16:00:00Z"});     // saved before originals were kept
    const mkPad = async readings => {
      const c = await browser.newContext({serviceWorkers: "block", viewport: {width: 1100, height: 900}}); await D9.install(c);
      await c.addInitScript(rs => {
        localStorage.setItem("tribar.dbx.tokens", JSON.stringify({access: "AT1", refresh: "RT", expiresAt: Date.now() + 3600e3}));
        localStorage.setItem("tribar.dbx.account", JSON.stringify({name: "Test Inspector", rootNamespaceId: "7777"}));
        if (!localStorage.getItem("tribar.v1")) localStorage.setItem("tribar.v1", JSON.stringify({readings: rs}));
      }, readings);
      const pg = await c.newPage(); pg.errs = []; pg.on("pageerror", e => pg.errs.push(e.message)); return {c, pg};
    };
    const settled = pg => pg.waitForFunction(() => !SYNC.busy && !SYNC.again && !TEAM.busy && TEAM.loaded && !TribarSync.pendingCsv() && !STATE.readings.some(r => r.files && !r.synced), null, {timeout: 30000});
    const toastText = pg => pg.textContent("#toast");
    const jsonsOf = id => [...D9.files.values()].filter(f => f.path.startsWith(EDIR) && f.path.endsWith(id + ".json"));
    const filesOf = id => [...D9.files.values()].filter(f => f.path.startsWith(EDIR) && f.path.includes(" " + id)).map(f => { const rest = f.path.slice(f.path.indexOf(id) + id.length).trim(); return rest === ".json" ? "json" : rest; }).sort();
    const spots = pg => pg.evaluate(() => STATE.photos.map(p => { const k = p.pick; return k && {loss: k.loss, bar: k.bar.loss, n: k.n, x: Math.round(k.spot[k.spot.length >> 1][1]), y0: Math.round(k.spot[0][0]), y1: Math.round(k.spot[k.spot.length - 1][0])}; }));
    const sameSpot = (a, b) => a && b && near(a.loss, b.loss) && near(a.bar, b.bar) && a.n === b.n && a.x === b.x && a.y0 === b.y0 && a.y1 === b.y1;

    const X = await mkPad([oldLocal]);
    await X.pg.goto(APP + "#/measure"); await settled(X.pg);
    for (const [id, v] of [["#fSite", ESITE], ["#fBarn", "Barn 7"], ["#fRoom", "4"], ["#fRow", "2"], ["#fCrate", "6"]]) await X.pg.fill(id, v);
    await addPhotos(X.pg, "spot-1.jpg");
    if (SHOTS) await X.pg.locator(".photo").first().screenshot({path: path.join(SHOTS, "hot.png")});

    /* the highest-reading hint */
    { const h = await X.pg.evaluate(() => { const ph = STATE.photos[0], r = ph.result, hot = hotWindow(r);
        const losses = r.windows.filter(w => w.ok).map(w => 1 - w.ratio / Tribar.BASELINE_RATIO);
        return {hot, max: Math.max(...losses), n: ph.stage.querySelectorAll(".win.hot").length, shown: [...ph.stage.querySelectorAll(".hotLbl")].filter(l => !l.hidden).map(l => l.textContent),
                outline: getComputedStyle(ph.stage.querySelector(".win.hot")).outlineColor, bands: Object.values(BAND_COLORS), pick: ph.pick, result: document.querySelector("#resultCard").innerText}; });
      ok(h.hot && near(h.hot.loss, h.max) && h.n === 1 && h.shown.length === 1 && h.shown[0] === "Highest reading here: " + (100 * h.max).toFixed(1) + "%", "one window is outlined and labeled: " + h.shown.join());
      ok(h.outline === "rgb(192, 38, 211)" && h.bands.every(c => c.toLowerCase() !== "#c026d3"), "in a colour no loss band uses (" + h.outline + ")");
      ok(h.pick === null && /Tap the worst spot/.test(h.result), "it's a hint only: no spot is picked for you, the result waits for the tap"); }
    const e1 = await tap(X.pg, 0);
    ok(e1 != null && await X.pg.evaluate(() => currentSummary().avg.loss) === e1, "the result is the tapped spot, " + (100 * e1).toFixed(1) + "%, whatever the hint says");
    { // a tapped spot reading more than 10 points below the highlighted window gets a note
      const t = await X.pg.evaluate(() => { const ph = STATE.photos[0], hot = hotWindow(ph.result), real = ph.pick.loss, out = {};
        for (const [k, gap] of [["under", 0.09], ["over", 0.11]]){ ph.pick.loss = hot.loss - gap; photoLine(ph); out[k] = {hidden: ph.hintEl.hidden, text: ph.hintEl.textContent}; }
        ph.pick.loss = real; photoLine(ph); out.back = ph.hintEl.hidden === (hot.loss - real <= 0.10); out.hotLoss = hot.loss; return out; });
      ok(t.under.hidden && !t.over.hidden && t.over.text === "There's an area reading " + (100 * t.hotLoss).toFixed(1) + "% in this photo. Check you tapped the worst bar." && t.back,
         "10 points or less below it: no note; more: \"" + t.over.text + "\""); }
    await addPhotos(X.pg, "spot-2.jpg"); const e2 = await tap(X.pg, 1);
    await X.pg.click("#saveBtn");
    await X.pg.waitForFunction(() => STATE.readings.length === 2 && !STATE.photos.length); await settled(X.pg);
    const r0 = await X.pg.evaluate(() => STATE.readings.find(r => r.id !== "old00001")), id = r0.id;
    ok(r0.photos.length === 2 && r0.photos.every(p => p.pick && p.pick.x != null && p.originalSuffix) && r0.files.filter(f => f.kind === "original").length === 2, "saved: 2 photos with their spot positions and originals");
    ok(await X.pg.evaluate(async () => !(await TribarSync.IDB.get(STATE.readings.find(r => r.id !== "old00001").files.find(f => f.kind === "original").key))), "the originals are gone from the iPad once uploaded");
    ok(filesOf(id).join() === "json,marked 1.jpg,marked 2.jpg,photo 1.jpg,photo 2.jpg" && jsonsOf(id).length === 1, "and are in Dropbox: " + filesOf(id).join(", "));

    /* a reading saved before originals were kept can't be edited; the button says why */
    { const b = X.pg.locator("#saved .reading", {hasText: "Old Farm"}).locator("button", {hasText: "Edit spots"});
      ok(await b.isDisabled() && /original photos/.test(await b.getAttribute("title")) && /No original photos kept/.test(await X.pg.locator("#saved .reading", {hasText: "Old Farm"}).innerText()), "no originals kept: Edit spots is greyed out, and says why"); }
    ok(await X.pg.locator("#saved .reading", {hasText: ESITE}).locator("button", {hasText: "Edit spots"}).isEnabled(), "a reading with originals can be edited");

    /* no signal and the originals aren't on the iPad: say so */
    await X.c.setOffline(true);
    await X.pg.locator("#saved .reading", {hasText: "Crate 6"}).locator("button", {hasText: "Edit spots"}).click();
    await X.pg.waitForFunction(() => /once there’s signal/.test(document.querySelector("#toast").textContent), null, {timeout: 10000});
    ok(/The original photos aren’t on this iPad\. They’ll be available once there’s signal\./.test(await toastText(X.pg)) && await X.pg.evaluate(() => !STATE.editing && !STATE.photos.length), "no signal, originals not on the iPad: \"" + await toastText(X.pg) + "\"");
    /* a reading not backed up yet still has its originals on the iPad: it can be edited with no signal */
    await X.pg.fill("#fCrate", "7"); await addPhotos(X.pg, "spot-3.jpg"); const e3 = await tap(X.pg, 0); await X.pg.click("#saveBtn");
    await X.pg.waitForFunction(() => STATE.readings.length === 3 && !STATE.photos.length);
    const r7 = await X.pg.evaluate(() => STATE.readings.find(r => r.crate === "7"));
    await X.pg.locator("#saved .reading", {hasText: "Crate 7"}).locator("button", {hasText: "Edit spots"}).click();
    await X.pg.waitForFunction(() => STATE.editing && STATE.photos.length === 1 && STATE.photos.every(p => p.status === "done"), null, {timeout: 60000});
    ok(sameSpot((await spots(X.pg))[0], r7.photos[0].pick), "no signal, original on the iPad: the photo is measured again and the old spot is back, " + (100 * e3).toFixed(1) + "%");
    X.pg.once("dialog", d => d.accept()); await X.pg.click("#editBar >> text=Cancel edit");
    ok(await X.pg.evaluate(() => !STATE.editing && !STATE.photos.length && !document.querySelector("#fSite").disabled) && await X.pg.evaluate(() => STATE.readings.length) === 3, "Cancel edit leaves the reading as it was");
    await X.c.setOffline(false); await X.pg.evaluate(() => window.dispatchEvent(new Event("online"))); await settled(X.pg);

    /* edit spots on a backed-up reading: originals from Dropbox, old spots shown, same reading when saved */
    const before = Object.fromEntries([...D9.files.values()].filter(f => f.path.startsWith(EDIR) && f.path.includes(" " + id)).map(f => [f.path, f.rev]));
    const dl0 = D9.log.filter(l => l.endpoint === "files/download").length;
    await X.pg.locator("#saved .reading", {hasText: "Crate 6"}).locator("button", {hasText: "Edit spots"}).click();
    await X.pg.waitForFunction(() => STATE.editing && STATE.photos.length === 2 && STATE.photos.every(p => p.status === "done"), null, {timeout: 90000});
    const dls = D9.log.slice(dl0).filter(l => l.endpoint === "files/download").map(l => JSON.parse(l.headers["dropbox-api-arg"]).path);
    ok(dls.filter(x => / photo [12]\.jpg$/.test(x)).length === 2, "the originals were downloaded from Dropbox: " + dls.map(x => x.slice(-12)).join(", "));
    { const sp = await spots(X.pg);
      ok(sameSpot(sp[0], r0.photos[0].pick) && sameSpot(sp[1], r0.photos[1].pick), "re-measured: both old tapped spots are back where they were (" + sp.map(k => k && (100 * k.loss).toFixed(1) + "%").join(", ") + ")"); }
    if (SHOTS) await X.pg.evaluate(() => window.scrollTo(0, 0)), await X.pg.screenshot({path: path.join(SHOTS, "edit.png")});
    ok(await X.pg.evaluate(() => document.querySelector("#editBar").innerText.includes("Editing spots") && document.querySelector("#fSite").disabled && /Save changes/.test(document.querySelector("#saveBtn").textContent)) &&
       await X.pg.evaluate(() => [...document.querySelectorAll(".pickLbl")].filter(l => !l.hidden).length) === 2, "the edit banner is up, the location is locked, both old spots are shown");
    // clear photo 2's spot (tap it again), tap it somewhere else, and add a third photo
    await X.pg.evaluate(() => { window.__p = STATE.photos[1].pick.spot[STATE.photos[1].pick.spot.length >> 1]; });
    { const f = await X.pg.evaluate(() => [__p[1] / STATE.photos[1].result.width, __p[0] / STATE.photos[1].result.height]); await tap(X.pg, 1, f[0], f[1]); }
    ok(await X.pg.evaluate(() => STATE.photos[1].pick === null), "tapping the old spot again clears it");
    const nl = await tap(X.pg, 1, 0.25, 0.3);
    await addPhotos(X.pg, "spot-3.jpg"); await tap(X.pg, 2);
    await X.pg.click("#saveBtn");
    await X.pg.waitForFunction(() => !STATE.editing && !STATE.photos.length); await settled(X.pg);
    ok(await X.pg.evaluate(id => STATE.readings.filter(r => r.id === id).length, id) === 1 && await X.pg.evaluate(() => STATE.readings.length) === 3, "saved: the same reading, still 3 readings on the iPad");
    const j = JSON.parse(jsonsOf(id)[0].body), edits = j.edits || [];
    ok(jsonsOf(id).length === 1 && j.id === id && j.savedAt === r0.savedAt && j.photos.length === 3, "Dropbox has one JSON for it (same id, same saved date), now with 3 photos");
    ok(edits.length === 1 && edits[0].by === "Test Inspector" && Math.abs(Date.parse(edits[0].at) - Date.now()) < 120000 && near(edits[0].was.worstSpot, r0.worstSpot) && edits[0].was.band === r0.band &&
       edits[0].was.photos.length === 2 && near(edits[0].was.photos[0].loss, r0.photos[0].pick.loss) && near(edits[0].was.photos[1].loss, r0.photos[1].pick.loss) && edits[0].was.photos[0].name === r0.photos[0].name,
       "edit history: when, who, and the old worst spot " + (100 * r0.worstSpot).toFixed(1) + "%, band " + r0.band + ", and each photo's old value");
    ok(near(j.photos[0].pick.loss, r0.photos[0].pick.loss) && near(j.photos[1].pick.loss, nl) && j.spotsAveraged === 3, "the new spots are what's measured: photo 2 now " + (100 * nl).toFixed(1) + "%, average of 3");
    { const after = Object.fromEntries([...D9.files.values()].filter(f => f.path.startsWith(EDIR) && f.path.includes(" " + id)).map(f => [f.path, f.rev]));
      const changed = k => before[k] !== after[k], keys = Object.keys(after);
      ok(keys.filter(k => / marked [12]\.jpg$/.test(k)).every(changed) && keys.filter(k => k.endsWith(".json")).every(changed) && keys.filter(k => / photo [12]\.jpg$/.test(k)).every(k => !changed(k)) && keys.length === 3 + 3 + 1,
         "the JSON and marked-up photos are overwritten, the originals already in Dropbox aren't uploaded again, the third photo's are new: " + filesOf(id).join(", ")); }
    { const csv = parseCsv(D9.files.get((EDIR + "Tribar readings - " + ESITE + ".csv").toLowerCase()).body.toString()), col = csv[0].indexOf("Edited");
      const row = csv.find(r => r[0] === ESITE && r[csv[0].indexOf("Crates from front of room")] === "6"), other = csv.find(r => r[csv[0].indexOf("Crates from front of room")] === "7");
      ok(col > 0 && csv.length === 3 && row && /by Test Inspector \(was \d+\.\d%\)$/.test(row[col]) && other && other[col] === "", "the site CSV was rebuilt: one row per reading, an Edited column filled for the edited one: " + (row && row[col])); }
    const edited = await X.pg.evaluate(id => ({text: editText(STATE.readings.find(r => r.id === id)), shown: document.querySelector("#saved .reading .edited") && document.querySelector("#saved .reading .edited").innerText}), id);
    ok(edited.text === "edited " + await X.pg.evaluate(() => stamp(lastEdit(STATE.readings.find(r => r.crate === "6")).at)) + " by Test Inspector, was " + (100 * r0.worstSpot).toFixed(1) + "%" && /^✎ Edited .* by Test Inspector$/.test(edited.shown || ""), "the reading shows Edited with the date: \"" + edited.shown + "\"");
    { const cap = await X.pg.evaluate(id => { const r = STATE.readings.find(x => x.id === id); return captionSpec({name: "x.jpg", tilt: null, pick: {loss: 0.1, bar: {loss: 0.1}, spot: [[0, 0, 1, 60]]}, result: {windows: []}}, r, 1, 1, 14).map(x => x[0]).join("\n"); }, id);
      ok(cap.includes(edited.text), "and the marked-up photo's caption says it: …" + cap.split("\n").pop().slice(-70)); }
    ok(!/edited/.test(await X.pg.evaluate(() => captionSpec({name: "x.jpg", tilt: null, pick: {loss: 0.1, bar: {loss: 0.1}, spot: [[0, 0, 1, 60]]}, result: {windows: []}}, STATE.readings.find(r => r.crate === "7"), 1, 1, 14).map(x => x[0]).join("\n"))), "a reading that wasn't edited has no such line");

    /* the second iPad: a reading it never saw, edited from the site page */
    const Y = await mkPad([]);
    await Y.pg.goto(APP + "#/site/" + encodeURIComponent("Legacy Farm")); await settled(Y.pg);
    { const b = Y.pg.locator("#siteView tbody tr").first().locator("button", {hasText: "Edit spots"});
      ok(await b.isDisabled() && /No original photos kept/.test(await Y.pg.locator("#siteView tbody tr").first().innerText()), "site page, a reading with no originals kept: greyed out, with the reason"); }
    await Y.pg.evaluate(site => { location.hash = "#/site/" + encodeURIComponent(site); }, ESITE);
    await Y.pg.waitForFunction(() => VIEW.name === "site" && document.querySelectorAll("#siteView tbody tr").length === 2);
    ok(/✎ Edited .* by Test Inspector/.test(await Y.pg.locator("#siteView tbody tr", {hasText: "Crate 6"}).innerText()), "the site page shows Edited on the reading");
    await Y.pg.locator("#siteView tbody tr", {hasText: "Crate 6"}).locator("button", {hasText: "Edit spots"}).click();
    await Y.pg.waitForFunction(() => STATE.editing && STATE.photos.length === 3 && STATE.photos.every(p => p.status === "done"), null, {timeout: 120000});
    { const sp = await spots(Y.pg);
      ok(sp.every((k, i) => sameSpot(k, j.photos[i].pick)), "another iPad's reading (as edited since): its 3 originals downloaded, the current spots shown (" + sp.map(k => k && (100 * k.loss).toFixed(1) + "%").join(", ") + ")"); }
    await Y.pg.click(".photo:nth-child(2) button[title='Remove photo']");
    ok(await Y.pg.evaluate(() => STATE.photos.length) === 2, "a photo can be removed");
    await Y.pg.click("#saveBtn");
    await Y.pg.waitForFunction(() => !STATE.editing && VIEW.name === "site" && !SYNC.busy && STATE.readings.length === 1 && STATE.readings[0].synced, null, {timeout: 30000}); await settled(Y.pg);
    const j2 = JSON.parse(jsonsOf(id)[0].body);
    ok(jsonsOf(id).length === 1 && await Y.pg.$$eval("#siteView tbody tr", r => r.length) === 2, "still one reading in Dropbox and on the site page");
    ok(j2.edits.length === 2 && j2.edits[0].by === "Test Inspector" && j2.edits[1].was.photos.length === 3 && near(j2.edits[1].was.worstSpot, j.worstSpot) && j2.photos.length === 2, "the history keeps the first edit and adds this one, with what it was just before (" + j2.edits.length + " edits)");
    ok(j2.photos.map(p => p.originalSuffix).join() === "photo 1.jpg,photo 3.jpg" && filesOf(id).join() === "json,marked 1.jpg,marked 2.jpg,photo 1.jpg,photo 2.jpg,photo 3.jpg",
       "marked-up photos match the 2 photos left (the third one's is gone from Dropbox); the originals stay: " + filesOf(id).join(", "));
    ok(![X, Y].some(x => x.pg.errs.length), "no page errors" + [X, Y].map(x => x.pg.errs.join("; ")).join(""));
    await X.c.close(); await Y.c.close();
  }

  /* ---- a new page with the browser's cached copy of the previous sync.js ---- */
  {
    const OLD = fs.readFileSync(path.join(ROOT, "sync.js"), "utf8").replace("{VERSION, CONFIG", "{CONFIG").replace("siteKey, ", "");
    for (const [what, oldTimes] of [["once", 1], ["every time (no way to get the new one)", 99]]) {
      const c6 = await browser.newContext({serviceWorkers: "block"});
      let served = 0, loads = 0;
      await c6.route("**/Tribar_Calculator/sync.js*", route => (++served <= oldTimes)
        ? route.fulfill({status: 200, contentType: "text/javascript", body: OLD}) : route.continue());
      await c6.addInitScript(() => { if (!localStorage.getItem("tribar.v1")) localStorage.setItem("tribar.v1", JSON.stringify({readings: [
        {id: "cccc3333", savedAt: "2026-11-16T17:25:00Z", site: "c44", barn: "farrowing", band: "0-10%", worstSpot: 0.02, photos: [], files: [], synced: "2026-11-16T17:26:00Z"}]})); });
      const p6 = await c6.newPage(); p6.on("load", () => loads++);
      await p6.goto(APP); await p6.waitForTimeout(2500);
      const kpis = await p6.$$eval("#dashKpis .kpi", k => k.length), msg = (await p6.textContent("#dashTable")).trim();
      if (oldTimes === 1) ok(kpis === 4 && /c44/.test(msg) && loads === 2 && await p6.evaluate(() => !sessionStorage.getItem("tribar.refetched")),
                             "old sync.js " + what + ": fetched fresh, reloaded once, dashboard shows c44 (" + loads + " loads)");
      else ok(loads === 2 && /Couldn’t show this page/.test(msg), "old sync.js " + what + ": one reload, then a message instead of a blank page (" + loads + " loads): " + msg.slice(0, 70));
      await c6.close();
    }
  }

  await browser.close(); server.close();
  console.log(failures ? "\n" + failures + " FAILED" : "\nall passed");
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
