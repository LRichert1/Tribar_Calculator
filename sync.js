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

   Dropbox app: "JEG Tribar Calculator" (its own app, not Ventilation's):
   Scoped access, Full Dropbox (an App-folder app can't reach the team
   folder), the four scopes below, public clients (PKCE) allowed, and both
   addresses the app is served from as redirect URIs.

   The sign-in and Dropbox code is the Ventilation app's
   (johnsonenggrp/ventilation, index.html): createDropboxAuth below is a copy
   of it, and createDropboxFiles is the request/error/base-folder core of its
   createDropboxClient. Fix a bug in one, port the fix to the other. The team
   folder is reached with the Dropbox-API-Path-Root header set to the
   account's root namespace plus an ordinary path; an "ns:" path does not
   reach JEG's team folder. The base folder must already exist and be shared
   with the person signing in; the app never creates it. */
(function (root) {
"use strict";

const CONFIG = {
  appKey: "7foui8a0tu6za74",           // JEG Tribar Calculator
  folder: "Johnson Engineering Group/Technical/0000 JEG/Tribar Readings",
  scopes: ["account_info.read", "files.metadata.read", "files.content.read", "files.content.write"],
  // Tribar and Ventilation share one origin (johnsonenggrp.github.io), so they share localStorage: keep the keys apart
  keys: {tokens: "tribar.dbx.tokens", account: "tribar.dbx.account", pkce: "tribar.dbx.pkce"},
};
const CSV_PENDING = "tribar.dbx.csvPending";

class SyncError extends Error { constructor(code, msg, status) { super(msg); this.code = code; this.status = status || 0; } }
const TeamError = SyncError;   // the name the Ventilation code uses

/* ---------------- photos on the device (IndexedDB) ----------------
   Stored as {type, data: ArrayBuffer} rather than as Blobs: Safari has had
   bugs reading back Blobs (especially ones from a file picker) out of
   IndexedDB after a reload. */
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
  async put(key, blob) {
    const data = await blob.arrayBuffer();        // read it before the transaction opens; an await inside one would end it
    return this.run("readwrite", st => st.put({type: blob.type || "application/octet-stream", data}, key));
  },
  async get(key) {
    const v = await this.run("readonly", st => st.get(key));
    if (!v) return null;
    return v instanceof Blob ? v : new Blob([v.data], {type: v.type});
  },
  del(key) { return this.run("readwrite", st => st.delete(key)); },
  clear() { return this.run("readwrite", st => st.clear()); },
  // plain objects (the cached index of the team folder)
  putObj(key, obj) { return this.run("readwrite", st => st.put(obj, key)); },
  getObj(key) { return this.run("readonly", st => st.get(key)); },
};

/* ---------------- Dropbox sign-in: OAuth 2 code flow with PKCE (no secret anywhere in the page) ----------------
   Copied from johnsonenggrp/ventilation index.html. Changes: the storage keys come from o.keys, and refresh is
   exposed so a request that gets a 401 can renew the token once before giving up. */
function createDropboxAuth(o) {
  const f = o.fetch || ((...a) => fetch(...a)), store = o.storage, sess = o.session, loc = o.location, hist = o.history, cr = o.crypto || (typeof crypto !== 'undefined' ? crypto : null), now = o.now || (() => Date.now());
  const authBase = (o.authBase || 'https://www.dropbox.com').replace(/\/+$/, ''), apiBase = (o.apiBase || 'https://api.dropboxapi.com').replace(/\/+$/, '');
  const SCOPE = o.scopes || ['account_info.read', 'files.metadata.read', 'files.content.read', 'files.content.write', 'sharing.read'];
  const TOK = o.keys.tokens, ACC = o.keys.account, PK = o.keys.pkce;
  const get = (s, k) => { try { return JSON.parse(s.getItem(k) || 'null'); } catch (e) { return null; } };
  const put = (s, k, v) => { try { s.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full / blocked */ } };
  const b64url = bytes => btoa(String.fromCharCode.apply(null, Array.from(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const rand = n => { const a = new Uint8Array(n); cr.getRandomValues(a); return b64url(a); };
  let tok = get(store, TOK), acct = get(store, ACC), lastError = null, refreshing = null;
  const clean = () => { try { hist.replaceState(null, '', loc.pathname); } catch (e) { /* ignore */ } };
  async function post(path, params) { const r = await f(apiBase + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() }); let j = null; try { j = await r.json(); } catch (e) { /* empty */ } return { ok: r.ok, status: r.status, j: j || {} }; }
  async function exchange(code, verifier) {
    const r = await post('/oauth2/token', { code, grant_type: 'authorization_code', client_id: o.appKey, redirect_uri: o.redirectUri, code_verifier: verifier });
    if (!r.ok || !r.j.access_token) throw new Error('Dropbox didn’t accept the sign-in (' + (r.j.error_description || r.j.error || r.status) + ').');
    tok = { access: r.j.access_token, refresh: r.j.refresh_token || null, expiresAt: now() + (r.j.expires_in || 14400) * 1000, accountId: r.j.account_id || '' }; put(store, TOK, tok);
  }
  function refresh() {
    if (!tok || !tok.refresh) { const e = new Error('Your Dropbox sign-in has expired — sign in again.'); e.expired = true; throw e; }
    return refreshing || (refreshing = (async () => {
      try {
        const r = await post('/oauth2/token', { grant_type: 'refresh_token', refresh_token: tok.refresh, client_id: o.appKey });
        if (!r.ok || !r.j.access_token) { if (r.status === 400 || r.status === 401) { tok = null; acct = null; store.removeItem(TOK); store.removeItem(ACC); const e = new Error('Your Dropbox sign-in has expired — sign in again.'); e.expired = true; throw e; } throw new Error('Dropbox is not reachable right now.'); }
        tok = Object.assign({}, tok, { access: r.j.access_token, expiresAt: now() + (r.j.expires_in || 14400) * 1000 }); put(store, TOK, tok); return tok.access;
      } finally { refreshing = null; }
    })());
  }
  async function getToken() { if (!tok) throw new Error('not signed in'); return tok.expiresAt - now() > 60000 ? tok.access : refresh(); }
  async function fetchAccount() {
    const r = await f(apiBase + '/2/users/get_current_account', { method: 'POST', headers: { Authorization: 'Bearer ' + await getToken() } }); if (!r.ok) throw new Error('Couldn’t read your Dropbox account (' + r.status + ').');
    const j = await r.json(); return { id: j.account_id, name: (j.name && j.name.display_name) || '', email: j.email || '', rootNamespaceId: j.root_info && j.root_info.root_namespace_id };
  }
  return {
    lastError: () => lastError,
    async init() {
      const q = new URLSearchParams(loc.search || '');
      if (q.get('error')) { lastError = new Error(q.get('error_description') || q.get('error')); clean(); sess.removeItem(PK); }
      else if (q.get('code')) {
        const pk = get(sess, PK); clean(); sess.removeItem(PK);
        if (!pk || pk.state !== q.get('state')) lastError = new Error('The sign-in answer didn’t match this browser session — please try again.');
        else { try { await exchange(q.get('code'), pk.verifier); acct = null; store.removeItem(ACC); } catch (e) { lastError = e; } }
      }
      if (!tok) return null;
      if (!acct) { try { acct = await fetchAccount(); put(store, ACC, acct); } catch (e) { lastError = lastError || e; return null; } }
      return acct;
    },
    async signIn() {
      const verifier = rand(48), state = rand(18), digest = await cr.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      put(sess, PK, { verifier, state });
      loc.assign(authBase + '/oauth2/authorize?' + new URLSearchParams({ client_id: o.appKey, response_type: 'code', code_challenge: b64url(new Uint8Array(digest)), code_challenge_method: 'S256', token_access_type: 'offline', redirect_uri: o.redirectUri, state, scope: SCOPE.join(' ') }).toString());
    },
    getToken,
    refresh: () => refresh(),
    signedIn: () => !!tok,
    async signOut() { try { if (tok) await f(apiBase + '/2/auth/token/revoke', { method: 'POST', headers: { Authorization: 'Bearer ' + tok.access } }); } catch (e) { /* best effort */ } tok = null; acct = null; store.removeItem(TOK); store.removeItem(ACC); }
  };
}

/* ---------------- Dropbox files: the core of Ventilation's createDropboxClient ----------------
   call / dbxError / ensureFolder as they are there (Path-Root header on files/* requests, retry on 429/503 honouring
   Retry-After, a hidden or missing base folder reported as "not shared with you"), plus the four calls this app needs.
   Changes: a 401 renews the token once and retries; a token that can't be renewed for lack of signal is reported as
   offline, not as "sign in again". */
function createDropboxFiles(o) {
  const f = o.fetch || ((...a) => fetch(...a));
  const api = (o.apiBase || 'https://api.dropboxapi.com').replace(/\/+$/, ''), cdn = (o.contentBase || 'https://content.dropboxapi.com').replace(/\/+$/, '');
  const folderName = String(o.folder || '').replace(/^\/+|\/+$/g, '');
  const base = '/' + folderName, shortName = folderName.split('/').pop();
  const pathRoot = o.rootNamespaceId ? JSON.stringify({ '.tag': 'root', root: String(o.rootNamespaceId) }) : '';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const hdrJson = x => JSON.stringify(x).replace(/[\u007f-￿]/g, c => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));   // header-safe JSON
  let verifiedAt = 0;   // the base folder is re-checked every ten minutes

  function dbxError(status, sum, what) {
    const t = (code, msg) => { const e = new TeamError(code, msg, status); e.summary = sum; return e; };
    if (status === 401) return t('auth', 'Sign in to Dropbox again.');
    if (status === 422 && /invalid_root/.test(sum)) return t('server', 'Dropbox didn’t accept the team space for this account (invalid root). Tell the person who set up the app.');
    if (status === 403 || /no_write_permission|no_permission|team_access|restricted_content|access_denied/.test(sum)) return t('denied', 'Dropbox says you don’t have access to the “' + shortName + '” folder. Ask the admin to share it with you.');
    if (status === 409 && /not_found/.test(sum)) return t('missing', (what || 'That') + ' isn’t in Dropbox.');
    return t('server', 'Dropbox returned an error (' + status + (sum ? ': ' + String(sum).slice(0, 80) : '') + ').');
  }
  async function token(renew) {
    try { return renew ? await o.refresh() : await o.getToken(); }
    catch (e) { throw e && e.expired || /not signed in/.test(e && e.message) ? new TeamError('auth', 'Sign in to Dropbox again.') : new TeamError('offline', 'Can’t reach Dropbox. Check the connection.'); }
  }
  async function call(kind, endpoint, arg, body, what) {
    let attempt = 0, renewed = false;
    for (;;) {
      const tok = await token(false);
      const headers = { Authorization: 'Bearer ' + tok }, opt = { method: 'POST', headers }; let url;
      if (pathRoot && /^files\//.test(endpoint)) headers['Dropbox-API-Path-Root'] = pathRoot;
      if (kind === 'rpc') { url = api + '/2/' + endpoint; if (arg !== undefined) { headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(arg); } }
      else { url = cdn + '/2/' + endpoint; headers['Dropbox-API-Arg'] = hdrJson(arg); if (kind === 'up') { headers['Content-Type'] = 'application/octet-stream'; opt.body = body; } }
      let res; try { res = await f(url, opt); } catch (e) { throw new TeamError('offline', 'Can’t reach Dropbox. Check the connection.'); }
      if (res.ok) return res;
      const text = await res.text().catch(() => ''); let j = null; try { j = JSON.parse(text); } catch (e) { /* plain text error */ }
      const sum = (j && j.error_summary) || text || '';
      if ((res.status === 429 || res.status === 503 || /too_many_write_operations|too_many_requests/.test(sum)) && attempt < 2) { attempt++; await sleep(Math.min(8, +res.headers.get('Retry-After') || (j && j.error && j.error.retry_after) || attempt * 2) * (o.retryScale == null ? 1000 : o.retryScale)); continue; }
      if (res.status === 401 && !renewed && o.refresh) { renewed = true; await token(true); continue; }
      throw dbxError(res.status, sum, what);
    }
  }
  async function ensureFolder() {
    if (Date.now() - verifiedAt < (o.verifyMs == null ? 600000 : o.verifyMs)) return;
    try { await call('rpc', 'files/get_metadata', { path: base }); verifiedAt = Date.now(); }
    catch (e) { if (e.code === 'missing') throw new TeamError('nofolder', 'The Dropbox folder “' + shortName + '” isn’t shared with you. Ask the admin to share it.', 409); throw e; }
  }
  return {
    base,
    ensureFolder,
    upload: (path, body) => call('up', 'files/upload', { path, mode: { '.tag': 'overwrite' }, autorename: false, mute: true }, body),
    async list(path, recursive) {
      let r; try { r = await call('rpc', 'files/list_folder', { path, recursive: !!recursive, limit: 2000 }); } catch (e) { if (e.code === 'missing') return []; throw e; }
      let j = await r.json(), entries = j.entries || [];
      while (j.has_more) { r = await call('rpc', 'files/list_folder/continue', { cursor: j.cursor }); j = await r.json(); entries = entries.concat(j.entries || []); }
      return entries;
    },
    async download(path) { return (await call('down', 'files/download', { path })).text(); },
    async downloadBlob(path) { return (await call('down', 'files/download', { path })).blob(); },
  };
}

/* ---------------- this app's sign-in ---------------- */
// The address the app is open at, so the same build works at lrichert1.github.io and johnsonenggrp.github.io.
// Both must be listed as redirect URIs on the Dropbox app.
const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, "");
const jget = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || "null") || d; } catch (e) { return d; } };
const jput = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full or blocked */ } };

let auth = null, acct = null, client = null;
function getAuth() {
  // The PKCE verifier is kept in localStorage, not sessionStorage: if an iPad home-screen app finishes the Dropbox
  // sign-in in a different window of the same app, sessionStorage would be empty and the sign-in would be refused.
  return auth || (auth = createDropboxAuth({appKey: CONFIG.appKey, redirectUri: redirectUri(), scopes: CONFIG.scopes, keys: CONFIG.keys,
    storage: localStorage, session: localStorage, location, history, crypto}));
}
const mkClient = () => createDropboxFiles({folder: CONFIG.folder, rootNamespaceId: acct.rootNamespaceId,
  getToken: () => getAuth().getToken(), refresh: () => getAuth().refresh()});

// Call once on start-up (finishes a sign-in that just came back from Dropbox), and again whenever the account is
// still unknown: without it there's no root namespace, and without that the team folder can't be reached.
async function init() {
  const a = getAuth();
  acct = await a.init();
  client = acct && acct.rootNamespaceId ? mkClient() : null;
  const e = a.lastError();
  return {account: acct, error: e ? (e instanceof TypeError ? null : e.message) : null};   // TypeError = no signal; try again later
}
async function signIn() { await getAuth().signIn(); }
async function signOut() { await getAuth().signOut(); acct = null; client = null; }

/* ---------------- what goes where ---------------- */
const safe = s => String(s || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
const BASE = "/" + CONFIG.folder;
const siteFolder = r => BASE + "/" + (safe(r.site) || "No site");
const stem = (r, label) => safe((r.savedAt || "").slice(0, 10) + " " + label + " " + r.id);
const idOfJson = name => (/ ([a-z0-9]+)\.json$/i.exec(name) || [])[1];
// What goes up as the reading's JSON: the reading without the device's own bookkeeping
const record = r => {
  const x = Object.assign({}, r); delete x.synced;
  x.files = (r.files || []).map(f => { const g = Object.assign({}, f); delete g.key; return g; });
  if (!x.by && acct && acct.name) x.by = acct.name;      // who saved it, for the dashboard (readings saved signed out)
  return x;
};
const STATUS_FILE = "Site status.json";
const siteKey = site => (safe(site) || "No site").toLowerCase();

// Site folders whose CSV still has to be rebuilt; kept on the device so a rebuild that fails is retried next time.
const pending = () => jget(CSV_PENDING, []);
function markCsv(dir, site, on) {
  const list = pending().filter(p => p.dir !== dir);
  if (on) list.push({dir, site});
  jput(CSV_PENDING, list);
}

// Upload every reading not yet backed up, oldest first, then rebuild the CSV of every site that changed.
// `readings` are the app's saved readings (changed in place: r.synced, r.files[i].uploaded);
// `hooks` = {label, csv, persist, progress}. Returns {done, left, error}.
let running = null;
function syncAll(readings, hooks) { return running || (running = doSync(readings, hooks).finally(() => { running = null; })); }
async function doSync(readings, hooks) {
  const todo = readings.filter(r => !r.synced).reverse();
  if (!todo.length && !pending().length) return {done: 0, left: 0};
  if (!getAuth().signedIn()) return {done: 0, left: todo.length, error: null};
  if (typeof navigator !== "undefined" && navigator.onLine === false) return {done: 0, left: todo.length, error: null};
  let done = 0;
  try {
    if (!client) {
      await init();
      if (!getAuth().signedIn()) throw new SyncError("auth", "Sign in to Dropbox again.");
      if (!client) throw new SyncError("offline", "Can’t read your Dropbox account yet. Will try again.");
    }
    await client.ensureFolder();
    for (const r of todo) {
      const dir = siteFolder(r), name = stem(r, hooks.label(r));
      for (const f of r.files || []) {
        if (f.uploaded || f.lost) continue;
        hooks.progress && hooks.progress("Uploading reading " + (done + 1) + " of " + todo.length);
        const blob = await IDB.get(f.key).catch(() => null);
        if (!blob) { f.lost = true; hooks.persist(); continue; }   // gone from the device (storage cleared); the JSON says so
        await client.upload(dir + "/" + name + " " + f.suffix, blob);
        f.uploaded = true; f.dropboxName = name + " " + f.suffix;
        if (f.kind === "original") await IDB.del(f.key).catch(() => {});   // keep the marked-up photo on the device for sharing, not the original
        hooks.persist();
      }
      markCsv(dir, r.site, true);
      if (!r.by && acct && acct.name) r.by = acct.name;     // saved signed out: say who backed it up
      await client.upload(dir + "/" + name + ".json", new Blob([JSON.stringify(record(r), null, 1)], {type: "application/json"}));
      r.synced = new Date().toISOString(); hooks.persist(); done++;
    }
    for (const p of pending()) {
      hooks.progress && hooks.progress("Updating the " + (p.site || "No site") + " summary");
      await rebuildCsv(p.dir, p.site, readings, hooks);
      markCsv(p.dir, p.site, false);
    }
  } catch (e) {
    return {done, left: todo.length - done, error: e};
  }
  return {done, left: 0};
}

// The site's CSV from every reading in its folder, whichever device saved it. Readings this device uploaded are
// read from the device rather than downloaded again.
async function rebuildCsv(dir, site, local, hooks) {
  const mine = new Map(local.filter(r => r.synced).map(r => [r.id, r]));
  const rows = [];
  for (const e of (await client.list(dir)).filter(x => x[".tag"] === "file" && /\.json$/i.test(x.name) && x.name !== STATUS_FILE)) {
    const own = mine.get(idOfJson(e.name));
    if (own) { rows.push(record(own)); continue; }
    let j = null; try { j = JSON.parse(await client.download(e.path_lower)); } catch (err) { if (err instanceof SyncError) throw err; /* unreadable JSON: skip it */ }
    if (j && j.id) rows.push(j);
  }
  rows.sort((a, b) => String(a.savedAt).localeCompare(String(b.savedAt)));
  await client.upload(dir + "/Tribar readings - " + (safe(site) || "No site") + ".csv", new Blob([hooks.csv(rows)], {type: "text/csv"}));
}

/* ---------------- the team folder, for the dashboard ----------------
   One recursive listing of the base folder, then only the reading JSONs that are new or changed since the last
   look are downloaded (a reading this iPad uploaded is taken from the device). Kept on the device, so the dashboard
   still shows the team's readings with no signal, as of the last refresh.
   index = {at, sites: {key: {name, dir, status, statusAt, statusBy}}, readings: {path_lower: {rev, key, dir, r}}} */
const INDEX_KEY = "team-index";
// A reading without its per-window detail: enough for the dashboard, the site page, the CSV and the photos
function compact(r) {
  const x = Object.assign({}, r);
  x.photos = (r.photos || []).map(p => ({name: p.name, tilt: p.tilt || null, pitchPx: p.pitchPx || null, size: p.size || null,
                                         source: p.source || null, pick: p.pick ? {loss: p.pick.loss} : null}));
  x.files = (r.files || []).map(f => ({kind: f.kind, suffix: f.suffix, dropboxName: f.dropboxName || null, uploaded: !!f.uploaded, lost: !!f.lost}));
  delete x.synced;
  return x;
}
const cachedIndex = () => IDB.getObj(INDEX_KEY).catch(() => null);
let indexing = null;
function teamIndex(local) { return indexing || (indexing = buildIndex(local).finally(() => { indexing = null; })); }
async function buildIndex(local) {
  if (!getAuth().signedIn()) throw new SyncError("auth", "Sign in to Dropbox to see the team’s readings.");
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw new SyncError("offline", "No signal.");
  if (!client) { await init(); if (!client) throw new SyncError(getAuth().signedIn() ? "offline" : "auth", "Can’t read your Dropbox account yet."); }
  await client.ensureFolder();
  const prev = (await cachedIndex()) || {readings: {}};
  const mine = new Map((local || []).map(r => [r.id, r]));     // this iPad's: same reading, no need to download it (even mid-upload)
  const baseLower = BASE.toLowerCase() + "/", next = {at: Date.now(), sites: {}, readings: {}};
  const statusFiles = [], toFetch = [];
  for (const e of await client.list(BASE, true)) {
    if (!e.path_lower || !e.path_lower.startsWith(baseLower)) continue;
    const rel = e.path_display.slice(BASE.length + 1).split("/");
    const key = rel[0].toLowerCase(), dir = BASE + "/" + rel[0];
    if (!next.sites[key]) next.sites[key] = {name: rel[0], dir, status: "current"};
    if (e[".tag"] !== "file" || rel.length !== 2 || !/\.json$/i.test(e.name)) continue;
    if (e.name === STATUS_FILE) { statusFiles.push({key, e}); continue; }
    const was = prev.readings[e.path_lower], own = mine.get(idOfJson(e.name));
    if (own) next.readings[e.path_lower] = {rev: e.rev, key, dir, r: compact(record(own))};
    else if (was && was.rev === e.rev) next.readings[e.path_lower] = Object.assign({}, was, {key, dir});
    else toFetch.push({e, key, dir});
  }
  // download what's new, four at a time
  let i = 0;
  const worker = async () => {
    while (i < toFetch.length) {
      const {e, key, dir} = toFetch[i++];
      let j = null; try { j = JSON.parse(await client.download(e.path_lower)); } catch (err) { if (err instanceof SyncError && err.code !== "missing") throw err; }
      if (j && j.id) next.readings[e.path_lower] = {rev: e.rev, key, dir, r: compact(j)};
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  for (const {key, e} of statusFiles) {
    const was = prev.sites && prev.sites[key];
    let st = was && was.statusRev === e.rev ? was : null;
    if (!st) { try { const j = JSON.parse(await client.download(e.path_lower)); st = {status: j.status, statusAt: j.at, statusBy: j.by, statusRev: e.rev}; } catch (err) { if (err instanceof SyncError && err.code !== "missing") throw err; } }
    if (st) Object.assign(next.sites[key], {status: st.status === "past" ? "past" : "current", statusAt: st.statusAt || null, statusBy: st.statusBy || null, statusRev: e.rev});
  }
  await IDB.putObj(INDEX_KEY, next).catch(() => {});
  return next;
}
// Mark a site complete ("past") or back in progress ("current"), for everyone: a small file in its folder
async function setSiteStatus(site, status) {
  if (!client) { await init(); if (!client) throw new SyncError("auth", "Sign in to Dropbox first."); }
  await client.ensureFolder();
  const dir = BASE + "/" + (safe(site) || "No site");
  await client.upload(dir + "/" + STATUS_FILE, new Blob([JSON.stringify({status, at: new Date().toISOString(), by: acct && acct.name || ""}, null, 1)], {type: "application/json"}));
}
// A file from the team folder (e.g. a marked-up photo another iPad uploaded)
async function teamFile(dir, name) {
  if (!client) { await init(); if (!client) throw new SyncError("auth", "Sign in to Dropbox first."); }
  return client.downloadBlob(dir + "/" + name);
}

// Bump with any change index.html depends on: the page checks it, and fetches both files fresh if they don't match
// (a browser can pair a new page with a cached copy of the old sync.js for a few minutes after an update).
const VERSION = 2;
root.TribarSync = {VERSION, CONFIG, IDB, init, signIn, signOut, syncAll, redirectUri, SyncError, createDropboxAuth, createDropboxFiles,
  teamIndex, cachedIndex, setSiteStatus, teamFile, compact, siteKey, folderName: site => safe(site) || "No site",
  dropboxUrl: site => "https://www.dropbox.com/home/" + (CONFIG.folder + "/" + (safe(site) || "No site")).split("/").map(encodeURIComponent).join("/"),
  signedIn: () => getAuth().signedIn(), account: () => acct, pendingCsv: () => pending().length};
})(typeof self !== "undefined" ? self : globalThis);
