/* Backup of saved readings to the JEG Dropbox team folder.

   Readings are saved on the device first (localStorage for the numbers,
   IndexedDB for the photos), so the app works in a barn with no signal.
   Whenever the device is online and signed in, each reading not yet backed
   up is uploaded to
       <folder>/<Site>/<date> <location> <id>.json        the reading
       <folder>/<Site>/<date> <location> <id> marked N.jpg the marked-up photo(s)
       <folder>/<Site>/<date> <location> <id> photo N.jpg  the original photo(s)
   and the site's summary, <folder>/<Site>/Tribar readings - <Site>.csv, is
   rebuilt from every reading JSON in that folder (so two iPads never
   overwrite each other's rows).

   Sign-in is Dropbox OAuth 2 with PKCE (no secret in the page), the same
   app and pattern as the Ventilation app. The team folder is reached with
   the Dropbox-API-Path-Root header set to the account's root namespace plus
   an ordinary path; an "ns:" path does not reach JEG's team folder. The base
   folder must already exist and be shared with the person signing in; the
   app never creates it. */
(function (root) {
"use strict";

const CONFIG = {
  appKey: "5n2wm6eobl2dvg8",
  folder: "Johnson Engineering Group/Technical/0000 JEG/Tribar Readings",
  scopes: ["account_info.read", "files.metadata.read", "files.content.read", "files.content.write"],
};
const API = "https://api.dropboxapi.com", CONTENT = "https://content.dropboxapi.com", AUTH = "https://www.dropbox.com";
const TOK = "tribar.dbx.tokens", ACC = "tribar.dbx.account", PK = "tribar.dbx.pkce";

class SyncError extends Error { constructor(code, msg, status) { super(msg); this.code = code; this.status = status || 0; } }

/* ---------------- photos on the device (IndexedDB) ---------------- */
const IDB = {
  _db: null,
  open() {
    if (this._db) return this._db;
    this._db = new Promise((resolve, reject) => {
      const rq = indexedDB.open("tribar", 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore("files");
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
    this._db.catch(() => { this._db = null; });
    return this._db;
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("files", mode), st = tx.objectStore("files"), rq = fn(st);
      tx.oncomplete = () => resolve(rq && rq.result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error("storage error"));
    });
  },
  put(key, blob) { return this.run("readwrite", st => st.put(blob, key)); },
  get(key) { return this.run("readonly", st => st.get(key)); },
  del(key) { return this.run("readwrite", st => st.delete(key)); },
  clear() { return this.run("readwrite", st => st.clear()); },
};

/* ---------------- sign-in: OAuth 2 code flow with PKCE ---------------- */
const jget = (s, k) => { try { return JSON.parse(s.getItem(k) || "null"); } catch (e) { return null; } };
const jput = (s, k, v) => { try { s.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } };
const b64url = bytes => btoa(String.fromCharCode.apply(null, Array.from(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rand = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); };
const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, "");

let tok = jget(localStorage, TOK), acct = jget(localStorage, ACC), refreshing = null;

async function form(path, params) {
  const r = await fetch(API + path, {method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded"},
                                      body: new URLSearchParams(params).toString()});
  let j = null; try { j = await r.json(); } catch (e) { /* empty */ }
  return {ok: r.ok, status: r.status, j: j || {}};
}
function forget() { tok = null; acct = null; localStorage.removeItem(TOK); localStorage.removeItem(ACC); }
function refresh() {
  if (!tok || !tok.refresh) { forget(); throw new SyncError("auth", "Your Dropbox sign-in has expired. Sign in again."); }
  return refreshing || (refreshing = (async () => {
    try {
      const r = await form("/oauth2/token", {grant_type: "refresh_token", refresh_token: tok.refresh, client_id: CONFIG.appKey});
      if (!r.ok || !r.j.access_token) {
        if (r.status === 400 || r.status === 401) { forget(); throw new SyncError("auth", "Your Dropbox sign-in has expired. Sign in again."); }
        throw new SyncError("offline", "Dropbox isn’t reachable right now.");
      }
      tok = Object.assign({}, tok, {access: r.j.access_token, expiresAt: Date.now() + (r.j.expires_in || 14400) * 1000});
      jput(localStorage, TOK, tok);
      return tok.access;
    } finally { refreshing = null; }
  })());
}
async function getToken() {
  if (!tok) throw new SyncError("auth", "Not signed in to Dropbox.");
  return tok.expiresAt - Date.now() > 60000 ? tok.access : refresh();
}

// Call once on start-up: finishes a sign-in that just came back from Dropbox.
async function init() {
  const q = new URLSearchParams(location.search || ""), clean = () => { try { history.replaceState(null, "", location.pathname); } catch (e) {} };
  let error = null;
  if (q.get("error")) { error = q.get("error_description") || q.get("error"); clean(); sessionStorage.removeItem(PK); }
  else if (q.get("code")) {
    const pk = jget(sessionStorage, PK); clean(); sessionStorage.removeItem(PK);
    if (!pk || pk.state !== q.get("state")) error = "The sign-in answer didn’t match this browser session. Try again.";
    else {
      try {
        const r = await form("/oauth2/token", {code: q.get("code"), grant_type: "authorization_code", client_id: CONFIG.appKey,
                                               redirect_uri: redirectUri(), code_verifier: pk.verifier});
        if (!r.ok || !r.j.access_token) throw new Error("Dropbox didn’t accept the sign-in (" + (r.j.error_description || r.j.error || r.status) + ").");
        tok = {access: r.j.access_token, refresh: r.j.refresh_token || null, expiresAt: Date.now() + (r.j.expires_in || 14400) * 1000};
        jput(localStorage, TOK, tok); acct = null; localStorage.removeItem(ACC);
      } catch (e) { error = e.message; }
    }
  }
  if (tok && !acct) {
    try {
      const r = await fetch(API + "/2/users/get_current_account", {method: "POST", headers: {Authorization: "Bearer " + await getToken()}});
      if (!r.ok) throw new Error("Couldn’t read your Dropbox account (" + r.status + ").");
      const j = await r.json();
      acct = {name: (j.name && j.name.display_name) || "", email: j.email || "", rootNamespaceId: j.root_info && j.root_info.root_namespace_id};
      jput(localStorage, ACC, acct);
    } catch (e) { if (!error && !(e instanceof TypeError)) error = e.message; }   // TypeError = offline; try again later
  }
  return {account: acct, error};
}
async function signIn() {
  const verifier = rand(48), state = rand(18);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  jput(sessionStorage, PK, {verifier, state});
  location.assign(AUTH + "/oauth2/authorize?" + new URLSearchParams({client_id: CONFIG.appKey, response_type: "code",
    code_challenge: b64url(new Uint8Array(digest)), code_challenge_method: "S256", token_access_type: "offline",
    redirect_uri: redirectUri(), state, scope: CONFIG.scopes.join(" ")}).toString());
}
async function signOut() {
  try { if (tok) await fetch(API + "/2/auth/token/revoke", {method: "POST", headers: {Authorization: "Bearer " + tok.access}}); } catch (e) {}
  forget();
}

/* ---------------- Dropbox files API ---------------- */
const hdrJson = x => JSON.stringify(x).replace(/[\u007f-￿]/g, c => "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = "/" + CONFIG.folder;

async function call(kind, endpoint, arg, body) {
  for (let attempt = 0; ; attempt++) {
    const headers = {Authorization: "Bearer " + await getToken()}, opt = {method: "POST", headers};
    if (acct && acct.rootNamespaceId) headers["Dropbox-API-Path-Root"] = JSON.stringify({".tag": "root", root: String(acct.rootNamespaceId)});
    let url;
    if (kind === "rpc"){ url = API + "/2/" + endpoint; headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(arg); }
    else {
      url = CONTENT + "/2/" + endpoint; headers["Dropbox-API-Arg"] = hdrJson(arg);
      if (kind === "up"){ headers["Content-Type"] = "application/octet-stream"; opt.body = body; }
    }
    let res; try { res = await fetch(url, opt); } catch (e) { throw new SyncError("offline", "Can’t reach Dropbox. Check the connection."); }
    if (res.ok) return res;
    const text = await res.text().catch(() => ""); let j = null; try { j = JSON.parse(text); } catch (e) {}
    const sum = (j && j.error_summary) || text || "";
    if ((res.status === 429 || res.status === 503 || /too_many/.test(sum)) && attempt < 3){ await sleep(1000 * (attempt + 1) * 2); continue; }
    if (res.status === 401){ if (attempt < 1 && tok){ tok.expiresAt = 0; continue; } forget(); throw new SyncError("auth", "Sign in to Dropbox again."); }
    if (res.status === 403 || /no_write_permission|no_permission|access_denied/.test(sum))
      throw new SyncError("denied", "Dropbox says you don’t have access to the Tribar Readings folder.", res.status);
    if (res.status === 409 && /not_found/.test(sum)) throw new SyncError("missing", "Not found in Dropbox.", 409);
    throw new SyncError("server", "Dropbox returned an error (" + res.status + (sum ? ": " + String(sum).slice(0, 80) : "") + ").", res.status);
  }
}
let verifiedAt = 0;
async function ensureBase() {
  if (Date.now() - verifiedAt < 600000) return;
  try { await call("rpc", "files/get_metadata", {path: BASE}); verifiedAt = Date.now(); }
  catch (e) {
    if (e.code === "missing") throw new SyncError("nofolder", "The Dropbox folder “" + CONFIG.folder.split("/").pop() + "” isn’t shared with you. Ask the admin.");
    throw e;
  }
}
const upload = (path, body) => call("up", "files/upload", {path, mode: {".tag": "overwrite"}, autorename: false, mute: true}, body);

/* ---------------- what goes where ---------------- */
const safe = s => String(s || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
const siteFolder = r => BASE + "/" + (safe(r.site) || "No site");
const stem = (r, label) => safe((r.savedAt || "").slice(0, 10) + " " + label + " " + r.id);

// Upload every reading not yet backed up, oldest first, then rebuild each
// touched site's CSV. `readings` are the app's saved readings (changed in
// place: r.synced, r.files[i].uploaded); `hooks` = {label, csv, persist,
// progress}. Returns {done, left, error}.
let running = null;
function syncAll(readings, hooks) { return running || (running = doSync(readings, hooks).finally(() => { running = null; })); }
async function doSync(readings, hooks) {
  const todo = readings.filter(r => !r.synced).reverse();
  if (!todo.length) return {done: 0, left: 0};
  if (!tok) return {done: 0, left: todo.length, error: null};
  if (typeof navigator !== "undefined" && navigator.onLine === false) return {done: 0, left: todo.length, error: null};
  let done = 0; const sites = new Map();
  try {
    await ensureBase();
    for (const r of todo) {
      const dir = siteFolder(r), name = stem(r, hooks.label(r));
      for (const f of r.files || []) {
        if (f.uploaded) continue;
        hooks.progress && hooks.progress("Uploading " + (done + 1) + " of " + todo.length);
        const blob = await IDB.get(f.key);
        if (blob) await upload(dir + "/" + name + " " + f.suffix, blob);
        f.uploaded = true; f.dropboxName = name + " " + f.suffix;
        if (f.kind === "original") await IDB.del(f.key).catch(() => {});   // keep the marked-up photo on the device, not the original
        hooks.persist();
      }
      const record = Object.assign({}, r); delete record.synced;
      await upload(dir + "/" + name + ".json", new Blob([JSON.stringify(record, null, 1)], {type: "application/json"}));
      r.synced = new Date().toISOString(); hooks.persist(); done++;
      sites.set(dir, r.site);
    }
  } catch (e) {
    for (const [dir, site] of sites) await rebuildCsv(dir, site, hooks).catch(() => {});
    return {done, left: todo.length - done, error: e};
  }
  for (const [dir, site] of sites) await rebuildCsv(dir, site, hooks).catch(() => {});
  return {done, left: 0};
}

// The site's CSV from every reading in its folder, whichever device saved it
async function rebuildCsv(dir, site, hooks) {
  let r = await call("rpc", "files/list_folder", {path: dir, recursive: false, limit: 2000});
  let j = await r.json(), entries = j.entries || [];
  while (j.has_more) { r = await call("rpc", "files/list_folder/continue", {cursor: j.cursor}); j = await r.json(); entries = entries.concat(j.entries || []); }
  const readings = [];
  for (const e of entries.filter(x => x[".tag"] === "file" && /\.json$/i.test(x.name))) {
    try { readings.push(JSON.parse(await (await call("down", "files/download", {path: e.path_lower})).text())); } catch (err) { /* skip unreadable */ }
  }
  readings.sort((a, b) => String(a.savedAt).localeCompare(String(b.savedAt)));
  await upload(dir + "/Tribar readings - " + (safe(site) || "No site") + ".csv", new Blob([hooks.csv(readings)], {type: "text/csv"}));
}

root.TribarSync = {CONFIG, IDB, init, signIn, signOut, syncAll, signedIn: () => !!tok, account: () => acct, redirectUri, SyncError};
})(typeof self !== "undefined" ? self : globalThis);
