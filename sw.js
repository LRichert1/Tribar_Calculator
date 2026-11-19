/* Offline service worker for the Tribar Corrosion app.
   Caches the app shell so it launches with no internet (e.g. inside a barn).
   The page and the measurement scripts are fetched network-first, so a
   re-uploaded version is picked up automatically the next time the phone
   has signal — no version bump needed. (Bump CACHE only to force-clear the
   offline copy.) */
/* tribar-v3: scripts are revalidated with the server on every load, and the
   offline copy is filled from the server rather than the browser's cache. */
const CACHE = "tribar-v3";
const ASSETS = [
  "./",
  "./index.html",
  "./tribar.js",
  "./sync.js",
  "./pdf.js",
  "./worker.js",
  "./manifest.webmanifest",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (e) => {
  // Cache each asset independently so one failed fetch can't block the whole
  // install (the fetch handler below still falls back to the cached shell).
  e.waitUntil(
    caches.open(CACHE)
      // straight from the server, not the browser's cache, which can still hold the previous release's files
      .then((cache) => Promise.all(ASSETS.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      // Only this app's old caches: at johnsonenggrp.github.io the Ventilation app shares this origin and its cache storage
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("tribar-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const isDoc = req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");
  const isScript = /\.js(\?|$)/.test(new URL(req.url).pathname);
  if (isDoc || isScript) {
    // Network-first: pick up a newer version whenever there's signal, fall
    // back to the cached copy when offline. Scripts are checked with the
    // server every time (a quick "not modified" when nothing changed), so a
    // new page never runs with the browser's cached copy of an old script.
    const key = isDoc ? "./index.html" : req;
    e.respondWith(
      fetch(isScript && !isDoc ? new Request(req, { cache: "no-cache" }) : req)
        .then((res) => {
          if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
          return res;
        })
        .catch(() => caches.match(isDoc ? "./index.html" : req, { ignoreSearch: true }))
    );
    return;
  }
  // Cache-first for static assets (icons, manifest).
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) =>
      hit ||
      fetch(req).then((res) => {
        if (res && res.ok && res.type === "basic") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
    )
  );
});
