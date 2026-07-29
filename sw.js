const CACHE = 'powder-v59';
const SHELL = ['./', './index.html', './manifest.json', './icon.svg', './icon-512.png', './icon-180.png', './fonts/space-grotesk-latin-400-normal.woff2', './fonts/space-grotesk-latin-500-normal.woff2', './fonts/space-grotesk-latin-600-normal.woff2', './fonts/space-grotesk-latin-700-normal.woff2', './fonts/righteous-latin-400-normal.woff2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.map(k => k !== CACHE ? caches.delete(k) : null)))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;

  // trip data: network-first so edits show up, fall back to cache offline
  if (u.pathname.endsWith('trip-data.json')) {
    e.respondWith(
      fetch(e.request).then(r => {
        const cp = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, cp));
        return r;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // maps: cache-first, cached on first fetch — so "Save all maps offline" makes them work with no signal
  if (u.pathname.indexOf('/maps/') !== -1) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
      if (resp && resp.ok) { const cp = resp.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); }
      return resp;
    })));
    return;
  }
  // app shell: stale-while-revalidate. Serve the cached copy instantly (so the
  // app still opens fast, and offline), but always refresh it in the background.
  // A code change then lands on the next launch WITHOUT bumping CACHE — which
  // matters because bumping CACHE makes activate() delete every old cache,
  // including ~55 MB of trail maps the crew saved for offline.
  const fresh = fetch(e.request).then(resp => {
    if (resp && resp.ok) { const cp = resp.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); }
    return resp;
  });
  e.waitUntil(fresh.catch(() => {}));           // keep the SW alive for the refresh, swallow offline errors
  e.respondWith(caches.match(e.request).then(r => r || fresh));   // no cache yet -> plain network, as before
});
