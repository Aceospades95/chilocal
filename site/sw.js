/* sw.js — ChiLocal's offline keeper.
 * Runtime caching only, same-origin only, and NEVER /api:
 *   - navigations: network first, cached shell when the network's gone
 *   - static assets (all ?v=-versioned): cache first, refresh in the
 *     background — instant opens, quietly current
 * Anything that arrives via a redirect is the gate bouncing an expired
 * session; caching that would poison the shell, so it's skipped. */
const CACHE = "chilocal-n25";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const cacheable = (r) => r && r.ok && !r.redirected && r.type === "basic";

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // live or nothing — never cached

  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          if (cacheable(r)) {
            const copy = r.clone();
            caches.open(CACHE).then((c) => c.put("/", copy));
          }
          return r;
        })
        .catch(() => caches.match("/").then((hit) => hit || Response.error())),
    );
    return;
  }

  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const hit = await c.match(e.request);
      const net = fetch(e.request)
        .then((r) => { if (cacheable(r)) c.put(e.request, r.clone()); return r; })
        .catch(() => null);
      if (hit) { e.waitUntil(net); return hit; } // stale-while-revalidate
      return net.then((r) => r || Response.error());
    }),
  );
});
