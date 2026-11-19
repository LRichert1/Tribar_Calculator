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
    if (status === 409 && /conflict/.test(sum)) return t('conflict', 'Someone else changed that file at the same moment.');
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
    // rev undefined: replace whatever is there. rev null: only if nothing is there yet. rev "abc": only if it is still that version
    // (the other two end in a 'conflict' error, so two iPads editing the same list never overwrite each other).
    upload: (path, body, rev) => call('up', 'files/upload', { path, mode: rev === undefined ? { '.tag': 'overwrite' } : rev === null ? { '.tag': 'add' } : { '.tag': 'update', update: rev }, autorename: false, mute: true }, body),
    async metadata(path) { return (await call('rpc', 'files/get_metadata', { path })).json(); },
    // to Dropbox's deleted files (restorable there); a path that is already gone counts as deleted
    async remove(path) { try { await call('rpc', 'files/delete_v2', { path }); return true; } catch (e) { if (e.code === 'missing') return false; throw e; } },
    // the folder's entries, or null when the folder doesn't exist
    async listOrNull(path) {
      let r; try { r = await call('rpc', 'files/list_folder', { path, recursive: false, limit: 2000 }); } catch (e) { if (e.code === 'missing') return null; throw e; }
      let j = await r.json(), entries = j.entries || [];
      while (j.has_more) { r = await call('rpc', 'files/list_folder/continue', { cursor: j.cursor }); j = await r.json(); entries = entries.concat(j.entries || []); }
      return entries;
    },
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
// One key for a site however it's typed: "C-44", "C44", "C044", "c 44" and "C 044" are all "C44". Case is ignored,
// spaces, hyphens, underscores and periods are dropped, and so are leading zeros in each group of digits. Letters
// stay as they are, so "Peddler Creek Pork" is still its own site. Used wherever sites are grouped or matched.
const siteKey = site => String(site || "").toUpperCase().replace(/[\s\-_.]+/g, "").replace(/\d+/g, d => d.replace(/^0+(?=\d)/, "")) || "NOSITE";
// The site folders already in the team folder, by key. A reading goes to the existing folder for its site
// ("c 44" into "C044"), so a new spelling never starts a second folder. Read once per sync.
let folderMap = null;
async function siteFolders() {
  const m = new Map();
  const dirs = (await client.list(BASE)).filter(e => e[".tag"] === "folder").map(e => e.name).sort();
  for (const name of dirs) if (!m.has(siteKey(name))) m.set(siteKey(name), name);
  return (folderMap = m);
}
function folderFor(map, site) {
  const key = siteKey(site);
  if (!map.has(key)) map.set(key, safe(site) || "No site");      // a new site: the name as typed
  return map.get(key);
}

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
// Readings already backed up without who saved them (saved before "by" existed, or while the account wasn't
// loaded): their JSON goes up again with the signed-in name, once.
const missingBy = readings => readings.filter(r => r.synced && !r.by);
async function ensureClient() {
  if (client) return;
  await init();
  if (!getAuth().signedIn()) throw new SyncError("auth", "Sign in to Dropbox again.");
  if (!client) throw new SyncError("offline", "Can’t read your Dropbox account yet. Will try again.");
}
async function doSync(readings, hooks) {
  const idle = () => !readings.some(r => !r.synced) && !pending().length && !missingBy(readings).length && !queue().length;
  const signedIn = getAuth().signedIn(), offline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (!signedIn || offline) return {done: 0, left: readings.filter(r => !r.synced).length, error: null, removed: []};
  let done = 0, removed = [];
  try {
    await ensureClient();
    await client.ensureFolder();
    // Before anything goes up: what the team has deleted. Readings of a deleted site (saved before it was deleted) and
    // deleted readings are removed from this iPad, never uploaded: otherwise this iPad would bring them back.
    await readDeleted();
    removed = purge(readings);
    if (removed.length) hooks.persist();
    if (queue().length) await processQueue(hooks);
    if (idle()) return {done: 0, left: 0, removed};
    const todo = readings.filter(r => !r.synced).reverse();
    const folders = await siteFolders();
    for (const r of todo) {
      const site = folderFor(folders, r.site), dir = BASE + "/" + site, name = stem(r, hooks.label(r));
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
      markCsv(dir, site, true);
      if (!r.by && acct && acct.name) r.by = acct.name;     // saved signed out, or before the account loaded
      await client.upload(dir + "/" + name + ".json", new Blob([JSON.stringify(record(r), null, 1)], {type: "application/json"}));
      r.synced = new Date().toISOString(); hooks.persist(); done++;
    }
    if (acct && acct.name) for (const r of missingBy(readings)) {
      const site = folderFor(folders, r.site), dir = BASE + "/" + site;
      r.by = acct.name;
      await client.upload(dir + "/" + stem(r, hooks.label(r)) + ".json", new Blob([JSON.stringify(record(r), null, 1)], {type: "application/json"}));
      markCsv(dir, site, true); hooks.persist();
    }
    for (const p of pending()) {
      hooks.progress && hooks.progress("Updating the " + (p.site || "No site") + " summary");
      await rebuildCsv(p.dir, p.site, readings, hooks);
      markCsv(p.dir, p.site, false);
    }
  } catch (e) {
    return {done, left: readings.filter(r => !r.synced).length, error: e, removed};
  }
  return {done, left: 0, removed};
}

// The site's CSV from every reading in its folder, whichever device saved it. Readings this device uploaded are
// read from the device rather than downloaded again.
async function rebuildCsv(dir, site, local, hooks) {
  const mine = new Map(local.filter(r => r.synced).map(r => [r.id, r]));
  const csvPath = dir + "/Tribar readings - " + (safe(site) || "No site") + ".csv";
  const entries = await client.listOrNull(dir);
  if (entries === null) return;                       // the folder is gone (deleted): a summary must not bring it back
  const rows = [];
  for (const e of entries.filter(x => x[".tag"] === "file" && /\.json$/i.test(x.name) && x.name !== STATUS_FILE)) {
    const own = mine.get(idOfJson(e.name));
    if (own) { rows.push(record(own)); continue; }
    let j = null; try { j = JSON.parse(await client.download(e.path_lower)); } catch (err) { if (err instanceof SyncError) throw err; /* unreadable JSON: skip it */ }
    if (j && j.id) rows.push(j);
  }
  if (!rows.length) { await client.remove(csvPath); return; }    // the last reading was deleted: no summary of nothing
  rows.sort((a, b) => String(a.savedAt).localeCompare(String(b.savedAt)));
  await client.upload(csvPath, new Blob([hooks.csv(rows)], {type: "text/csv"}));
}

/* ---------------- deleting a site ----------------
   A site's whole Dropbox folder is deleted with files/delete_v2: it lands in Dropbox's deleted files and can be
   restored there. Other iPads still hold their own copies of readings they had backed up, and a sync would upload them
   again, so the delete is also written to
       <folder>/Deleted sites.json
   {sites: {<siteKey>: {key, name, at, by}}}. Every sync reads it before uploading anything: a local reading that was
   already backed up (r.synced) before the site was deleted is removed from the device (purge). A reading that was never
   uploaded is the only copy: it is never removed, it uploads as usual, even if that recreates the site. Readings backed
   up after the deletion are new work too. The file is merged on every write (read, add, write back only if nobody else
   changed it in between), never overwritten.
   The delete is first put in a queue kept on the device (tribar.dbx.deleteQueue). If the folder is deleted but the list
   can't be written (the signal went), the entry stays there and a later sync finishes it. */
const DELETED_FILE = "Deleted sites.json", DEL_KEY = "deleted-sites", DQ = "tribar.dbx.deleteQueue";
let del = {sites: {}, rev: null};          // the last copy of the list that this device saw
const noDeleted = () => ({sites: {}, rev: null});
const queue = () => jget(DQ, []);
const saveEntry = e => jput(DQ, queue().filter(x => x.key !== e.key).concat([e]));
const dropEntry = e => jput(DQ, queue().filter(x => x.key !== e.key));
const who = () => (acct && acct.name) || (jget(CONFIG.keys.account, {}) || {}).name || "";
const parseDeleted = text => ({sites: JSON.parse(text).sites || {}});
async function loadDeleted() {
  const c = await IDB.getObj(DEL_KEY).catch(() => null);
  if (c) del = {sites: c.sites || {}, rev: c.rev || null};
  overlayQueue();
  return del;
}
const keepDeleted = () => IDB.putObj(DEL_KEY, del).catch(() => {});
// a delete whose folder is gone but whose list entry is still queued counts as deleted too
function overlayQueue() { for (const e of queue()) if (e.filesDone) del.sites[e.key] = {key: e.key, name: e.name, at: e.at, by: e.by}; }
// Is this reading of the team's index (an index entry: {r, dir, modified}) from a folder that was deleted since? The time is
// when it reached Dropbox, so a reading uploaded after the deletion is new work and shows.
function isDeleted(e) {
  const s = del.sites[siteKey(e.r.site || e.dir.split("/").pop())];
  return !!s && Date.parse(e.modified || e.r.savedAt) < Date.parse(s.at);
}
// The list from Dropbox (downloaded only when its version changed). A list that can't be read stops the sync: carrying
// on would upload what the team deleted.
async function readDeleted() {
  let meta;
  try { meta = await client.metadata(BASE + "/" + DELETED_FILE); }
  catch (e) { if (e.code !== "missing") throw e; del = noDeleted(); overlayQueue(); await keepDeleted(); return del; }
  if (del.rev === meta.rev) { overlayQueue(); return del; }
  let j; try { j = parseDeleted(await client.download(BASE + "/" + DELETED_FILE)); }
  catch (e) { if (e instanceof SyncError) throw e; throw new SyncError("server", "“" + DELETED_FILE + "” in the team folder can’t be read, so nothing was uploaded. Ask the person who set up the app."); }
  del = Object.assign(j, {rev: meta.rev}); overlayQueue(); await keepDeleted();
  return del;
}
// Add a site to the list in Dropbox: {key, name, at, by}
async function addDeleted(site) {
  const path = BASE + "/" + DELETED_FILE;
  for (let attempt = 0; attempt < 4; attempt++) {
    let meta = null, cur = {sites: {}};
    try { meta = await client.metadata(path); cur = parseDeleted(await client.download(path)); }
    catch (e) {
      if (e.code === "missing") meta = null;
      else if (e instanceof SyncError) throw e;
      else throw new SyncError("server", "“" + DELETED_FILE + "” can’t be read, so it wasn’t changed.");
    }
    const was = cur.sites[site.key];
    if (!was || Date.parse(site.at) >= Date.parse(was.at)) cur.sites[site.key] = site;
    try { await client.upload(path, new Blob([JSON.stringify({sites: cur.sites}, null, 1)], {type: "application/json"}), meta ? meta.rev : null); }
    catch (e) { if (e.code === "conflict") continue; throw e; }
    del = {sites: cur.sites, rev: null};      // our own write: read it back (and its version) next time
    await keepDeleted(); return;
  }
  throw new SyncError("server", "Couldn’t update “" + DELETED_FILE + "”: another iPad kept changing it. Try again.");
}
// Take readings off this device with their photos; returns them
function removeLocal(readings, pred) {
  const gone = [];
  for (let i = readings.length - 1; i >= 0; i--) if (pred(readings[i])) { gone.unshift(readings[i]); readings.splice(i, 1); }
  for (const r of gone) for (const f of r.files || []) IDB.del(f.key).catch(() => {});
  return gone;
}
// Readings of a deleted site that were backed up before it was deleted come off this device. Never one that wasn't
// backed up (the only copy), and never one backed up after the deletion. Returns [{r, name, by, at}] for the message.
function purge(readings) {
  const why = new Map();
  const gone = removeLocal(readings, r => {
    const s = del.sites[siteKey(r.site)];
    if (!s || !r.synced || !(Date.parse(r.synced) < Date.parse(s.at))) return false;
    why.set(r.id, {name: s.name, by: s.by, at: s.at}); return true;
  });
  // a summary still to rebuild for a site that was deleted would only bring its folder back (rebuildCsv checks, but drop them anyway)
  if (gone.length) for (const p of pending()) if (del.sites[siteKey(p.site)] && !readings.some(r => siteKey(r.site) === siteKey(p.site))) markCsv(p.dir, p.site, false);
  return gone.map(r => Object.assign({r}, why.get(r.id)));
}
// Work one queued delete off: the folder(s), then the list; progress is written back to the queue
async function runEntry(e) {
  if (!e.filesDone) {
    const folders = (await client.listOrNull(BASE) || []).filter(x => x[".tag"] === "folder" && siteKey(x.name) === e.key).map(x => x.name);
    for (const n of folders) await client.remove(BASE + "/" + n);
    e.filesDone = true; saveEntry(e);
  }
  await addDeleted({key: e.key, name: e.name, at: e.at, by: e.by});
  for (const p of pending()) if (siteKey(p.site) === e.key) markCsv(p.dir, p.site, false);
  dropEntry(e);
}
async function processQueue(hooks) {
  for (const e of queue()) {
    hooks && hooks.progress && hooks.progress("Deleting " + e.name + " from the team folder");
    await runEntry(e);
  }
}
// Delete a site now (needs signal). Returns {queued: true} when only the list entry is left for a later sync; throws,
// leaving nothing queued, when the folder couldn't be deleted.
function deleteSite(name) {
  const prev = running, entry = {key: siteKey(name), name: safe(name) || "No site"};
  const op = (async () => {
    if (prev) await prev.catch(() => {});
    entry.at = new Date().toISOString(); entry.by = who(); entry.filesDone = false;
    saveEntry(entry);
    try { await ensureClient(); await client.ensureFolder(); await runEntry(entry); return {queued: false}; }
    catch (e) {
      const q = queue().find(x => x.key === entry.key);
      if (q && q.filesDone) return {queued: true, error: e};                      // gone from Dropbox; only the list is left
      dropEntry(entry); throw e;
    }
  })();
  // a sync that starts while this runs waits for it (and gets this); the slot is freed before the caller continues
  const result = () => ({done: 0, left: 0}), wrapped = op.then(result, result), free = () => { if (running === wrapped) running = null; };
  op.then(free, free);
  running = wrapped;
  return op;
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
// What the dashboard shows of an index: without the readings and sites the team deleted (as far as this device knows)
function visible(idx) {
  if (!idx) return idx;
  const out = Object.assign({}, idx, {readings: {}, sites: {}});
  for (const [p, e] of Object.entries(idx.readings || {})) if (!isDeleted(e)) out.readings[p] = e;
  for (const [k, s] of Object.entries(idx.sites || {})) {
    const dead = del.sites[k] && !Object.values(out.readings).some(e => e.key === k);
    if (!dead) out.sites[k] = s;
  }
  return out;
}
const cachedIndex = async () => { await loadDeleted(); return visible(await IDB.getObj(INDEX_KEY).catch(() => null)); };
let indexing = null;
function teamIndex(local) { return indexing || (indexing = buildIndex(local).finally(() => { indexing = null; })); }
async function buildIndex(local) {
  if (!getAuth().signedIn()) throw new SyncError("auth", "Sign in to Dropbox to see the team’s readings.");
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw new SyncError("offline", "No signal.");
  if (!client) { await init(); if (!client) throw new SyncError(getAuth().signedIn() ? "offline" : "auth", "Can’t read your Dropbox account yet."); }
  await client.ensureFolder();
  await readDeleted();
  const prev = (await IDB.getObj(INDEX_KEY).catch(() => null)) || {readings: {}};
  const mine = new Map((local || []).map(r => [r.id, r]));     // this iPad's: same reading, no need to download it (even mid-upload)
  const baseLower = BASE.toLowerCase() + "/", next = {at: Date.now(), sites: {}, readings: {}};
  const statusFiles = [], toFetch = [];
  for (const e of await client.list(BASE, true)) {
    if (!e.path_lower || !e.path_lower.startsWith(baseLower)) continue;
    const rel = e.path_display.slice(BASE.length + 1).split("/");
    if (e[".tag"] === "file" && rel.length === 1) continue;       // a file in the base folder (Deleted sites.json) isn't a site
    const key = siteKey(rel[0]), dir = BASE + "/" + rel[0];
    if (!next.sites[key]) next.sites[key] = {name: rel[0], dir, status: "current"};
    if (e[".tag"] !== "file" || rel.length !== 2 || !/\.json$/i.test(e.name)) continue;
    if (e.name === STATUS_FILE) { statusFiles.push({key, e}); continue; }
    const was = prev.readings[e.path_lower], own = mine.get(idOfJson(e.name));
    const modified = e.server_modified || (own && own.synced) || null;
    if (own) next.readings[e.path_lower] = {rev: e.rev, key, dir, modified, r: compact(record(own))};
    else if (was && was.rev === e.rev) next.readings[e.path_lower] = Object.assign({}, was, {key, dir, modified});
    else toFetch.push({e, key, dir, modified});
  }
  // download what's new, four at a time
  let i = 0;
  const worker = async () => {
    while (i < toFetch.length) {
      const {e, key, dir, modified} = toFetch[i++];
      let j = null; try { j = JSON.parse(await client.download(e.path_lower)); } catch (err) { if (err instanceof SyncError && err.code !== "missing") throw err; }
      if (j && j.id) next.readings[e.path_lower] = {rev: e.rev, key, dir, modified, r: compact(j)};
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
  return visible(next);
}
// Mark a site complete ("past") or back in progress ("current"), for everyone: a small file in its folder
async function setSiteStatus(site, status) {
  if (!client) { await init(); if (!client) throw new SyncError("auth", "Sign in to Dropbox first."); }
  await client.ensureFolder();
  const dir = BASE + "/" + folderFor(await siteFolders(), site);
  await client.upload(dir + "/" + STATUS_FILE, new Blob([JSON.stringify({status, at: new Date().toISOString(), by: acct && acct.name || ""}, null, 1)], {type: "application/json"}));
}
// A file from the team folder (e.g. a marked-up photo another iPad uploaded)
async function teamFile(dir, name) {
  if (!client) { await init(); if (!client) throw new SyncError("auth", "Sign in to Dropbox first."); }
  return client.downloadBlob(dir + "/" + name);
}

// Bump with any change index.html depends on: the page checks it, and fetches both files fresh if they don't match
// (a browser can pair a new page with a cached copy of the old sync.js for a few minutes after an update).
const VERSION = 4;
root.TribarSync = {VERSION, CONFIG, IDB, init, signIn, signOut, syncAll, redirectUri, SyncError, createDropboxAuth, createDropboxFiles,
  teamIndex, cachedIndex, setSiteStatus, teamFile, compact, siteKey, deleteSite, loadDeleted, purge, isDeleted, siteDeleted: key => !!del.sites[key], removeLocal, folderName: site => safe(site) || "No site",
  dropboxUrl: site => "https://www.dropbox.com/home/" + (CONFIG.folder + "/" + (safe(site) || "No site")).split("/").map(encodeURIComponent).join("/"),
  signedIn: () => getAuth().signedIn(), account: () => acct, pendingCsv: () => pending().length, pendingDeletes: () => queue().length};
})(typeof self !== "undefined" ? self : globalThis);
