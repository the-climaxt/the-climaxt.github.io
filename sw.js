/* sw.js — the crew app's service worker: what each phone keeps for offline use, and how it refreshes it.
   (Rewritten Sep 24 2026 for M9–M13 / R15 R16 R19 R20. Plain rules, one per kind of file.)

   THE CACHES
   - CACHE ('powder-v60')  the app's own files (SHELL) + every saved map. NEVER bump this name: activate() deletes every
                           cache with another name, and that would delete every phone's saved maps (~55 MB + 3D).
                           An app change still reaches phones without a bump (the shell refreshes itself, see 3).
   - DATA ('powder-data')  the ONE saved copy of trip-data.json, under its plain address. index.html and gnar.html
                           write it after each good download; this worker only reads it (no signal → serve it).
                           activate() keeps it too.

   THE RULES
   1. trip-data.json   network first. No signal → the saved copy from DATA. This worker never stores it, so there is
                       one copy only (before Sep 24 every ?v=<time> address was kept: 6 opens = 5 copies, 12 MB).
   2. maps/…           one copy per map, stored under its plain path (the ?query is dropped). The app asks for
                       maps/x.pdf?v=<fingerprint> (trip-data's mapsFp; for 3D, the hill's build stamp). The copy
                       remembers its fingerprint in an x-pr-fp header:
                         same fingerprint (or no ?v= asked) → the saved copy, no network;
                         different → download the new one and replace the old — but with no signal, or no answer in
                         MAP_WAIT_MS, serve the old one (an old map beats no map);
                         nothing saved → download and keep it.
                       A request with the header x-pr-save: 1 ("Save all maps" / "Save 3D maps") waits until the copy
                       is really stored and answers from the cache, so the app can count real saves only; when the
                       phone can't store it the answer is empty with an x-pr-save-error header saying why.
   3. everything else  (index.html, 3d.html, gnar.html, fonts …) stale-while-revalidate: the saved copy at once, a
                       fresh copy fetched in the background for next launch. Stored under the plain path, so
                       3d.html?m=red&zone=… is ONE copy of 3d.html, not one per address. A page fetch with
                       cache:'reload' or 'no-store' goes to the network first.
   The app's "Refresh app & data" sends {t:'refresh-shell'}: this worker re-downloads SHELL and replaces each file
   that arrived. It never deletes a map. */
const CACHE = 'powder-v60';
const DATA = 'powder-data';
// Every file here must exist on the site: addAll() is all-or-nothing, so one missing file = the new worker never installs.
// gnar-score.js is needed to draw Home (since Sep 10); gnar.html + gnar-data.js are the game page; 3d.html is the
// terrain drawer's default view (1.3 MB) — without it here a phone that never opened 3D with signal has no 3D offline.
const SHELL = ['./', './index.html', './manifest.json', './icon.svg', './icon-512.png', './icon-180.png', './fonts/space-grotesk-latin-400-normal.woff2', './fonts/space-grotesk-latin-500-normal.woff2', './fonts/space-grotesk-latin-600-normal.woff2', './fonts/space-grotesk-latin-700-normal.woff2', './fonts/righteous-latin-400-normal.woff2',
  './gnar.html', './gnar-score.js', './gnar-data.js', './3d.html'];
const MAP_WAIT_MS = 8000;   // how long a phone waits for a changed map before it shows the old copy instead

const abs = p => new URL(p, self.location.href).href;   // './x' → https://…/x, the way addAll() stores it
const plain = u => u.origin + u.pathname;                // an address without its ?query

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.map(k => (k !== CACHE && k !== DATA) ? caches.delete(k) : null)))
      .then(() => tidy().catch(() => {}))
      .then(() => self.clients.claim())
  );
});

/* tidy() — one clean-up of what older workers left in CACHE under full addresses (with a ?query):
   - trip-data.json?v=… (the pile): the newest becomes the saved copy in DATA if there is none yet, the rest go;
   - maps: older builds of the same map go, the newest stays (savedMap() adopts it with its fingerprint on first use);
   - pages (3d.html?m=…, gnar.html?…): one plain copy is kept, the per-address copies go.
   Nothing is lost that the app still uses. It runs on every activate and does nothing when there's nothing to do. */
async function tidy() {
  const c = await caches.open(CACHE), d = await caches.open(DATA), groups = new Map();
  for (const q of await c.keys()) {
    const u = new URL(q.url); if (!u.search) continue;
    const k = plain(u); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(q);
  }
  for (const [path, list] of groups) {
    const newest = list[list.length - 1];            // Cache Storage lists entries oldest first
    if (path.endsWith('/trip-data.json')) {
      if (!(await d.match(path))) { const r = await c.match(newest); if (r) await d.put(path, r); }
      await Promise.all(list.map(q => c.delete(q)));
    } else if (path.indexOf('/maps/') !== -1) {
      await Promise.all(list.slice(0, -1).map(q => c.delete(q)));
    } else {
      if (!(await c.match(path))) { const r = await c.match(newest); if (r) await c.put(path, r); }
      await Promise.all(list.map(q => c.delete(q)));
    }
  }
}

self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== location.origin) return;   // HEAD (the app's signal check) goes straight out
  if (u.pathname.endsWith('/trip-data.json')) { e.respondWith(tripData(req)); return; }
  if (u.pathname.indexOf('/maps/') !== -1) { e.respondWith(mapFetch(e, u)); return; }
  shell(e, u);
});

/* ---- 1. trip data ---- */
async function tripData(req) {
  try {
    const r = await fetch(req);
    if (r.ok) return r;                               // the page saves it (one fixed copy); this worker never does
    return (await savedTripData()) || r;
  } catch (err) {
    return (await savedTripData()) || Response.error();
  }
}
/* savedTripData() — the phone's saved trip data: DATA's copy, else the newest of an old pile (a phone that has not
   run tidy() yet). */
async function savedTripData() {
  const key = abs('trip-data.json');
  const r = await (await caches.open(DATA)).match(key); if (r) return r;
  const c = await caches.open(CACHE), ks = await c.keys(key, { ignoreSearch: true });
  return ks.length ? c.match(ks[ks.length - 1]) : null;
}

/* ---- 2. maps ---- */
async function mapFetch(e, u) {
  const req = e.request, key = plain(u), want = u.search;
  const cache = await caches.open(CACHE);
  const old = await savedMap(cache, key, want).catch(() => cache.match(key));
  if (old && (!want || old.headers.get('x-pr-fp') === want)) return old;
  if (req.headers.get('x-pr-save') === '1') return saveMap(cache, req, key, want);
  return viewMap(e, cache, req, key, want, old);
}

/* savedMap() — the saved copy of one map, or null. Copies saved before Sep 24 2026 have no fingerprint header, and
   some sit under their full address (…bundle?v=<stamp>, wanted.bundle?t=<hour>). The first time one is asked for it
   is moved to the plain path with its fingerprint: the ?query it was saved under, or — for a plain copy — the
   fingerprint asked for when its bytes prove it (mapsFp is SHA-256), so a saved map is not downloaded again just
   because fingerprints arrived. The extra copies are deleted. */
async function savedMap(cache, key, want) {
  const cur = await cache.match(key);
  if (cur && cur.headers.has('x-pr-fp')) return cur;
  const olds = (await cache.keys(key, { ignoreSearch: true })).filter(q => q.url !== key);
  if (!cur && !olds.length) return null;
  let pick = olds.find(q => new URL(q.url).search === want), fp = want, src;
  if (pick) src = await cache.match(pick);
  else if (cur) { src = cur; fp = (want && await sameBytes(cur.clone(), want)) ? want : ''; }
  else { pick = olds[olds.length - 1]; src = await cache.match(pick); fp = new URL(pick.url).search; }
  await cache.put(key, stamp(src, fp));
  await Promise.all(olds.map(q => cache.delete(q)));
  return cache.match(key);
}
/* sameBytes() — true when a saved copy's bytes match the 8-hex fingerprint in ?v= (first 8 hex digits of SHA-256,
   the way stamp_map_fingerprints.py makes it). */
async function sameBytes(resp, want) {
  const v = new URLSearchParams(want).get('v') || '';
  if (!/^[0-9a-f]{8}$/.test(v)) return false;
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', await resp.arrayBuffer()));
  return Array.from(h.slice(0, 4), b => b.toString(16).padStart(2, '0')).join('') === v;
}
/* stamp() — a copy of a map response to store: its type, plus the fingerprint it was fetched for (x-pr-fp). */
function stamp(resp, fp) {
  const h = new Headers();
  ['content-type', 'last-modified', 'etag'].forEach(n => { const v = resp.headers.get(n); if (v) h.set(n, v); });
  h.set('x-pr-fp', fp);
  return new Response(resp.body, { status: 200, statusText: 'OK', headers: h });
}
const saveError = (status, why) => new Response(null, { status, headers: { 'x-pr-save-error': why } });

/* saveMap() — for "Save all maps" / "Save 3D maps": download, store, and answer only once it is stored, from the cache
   (so the page sees x-pr-fp). No signal → 504 'offline'; phone full → 507 with the browser's reason. The old copy,
   if any, stays until a new one is stored. */
async function saveMap(cache, req, key, want) {
  let resp;
  try { resp = await fetch(req); } catch (err) { return saveError(504, 'offline'); }
  if (resp.status !== 200) return resp;                                   // 404 & co: the page reports it
  try { await cache.put(key, stamp(resp, want)); } catch (err) { return saveError(507, (err && err.name) || 'not-kept'); }
  return (await cache.match(key)) || saveError(507, 'not-kept');
}

/* viewMap() — a map the app is showing right now: stream the download to the page and store a copy on the side.
   When an older copy is saved: a failed download, an error page or no answer in MAP_WAIT_MS → the old copy (a late
   download still replaces it in the background, for next time). */
async function viewMap(e, cache, req, key, want, old) {
  let servedOld = false;
  const got = fetch(req).then(async resp => {
    if (!resp || resp.status !== 200) return { resp: old || resp };
    if (servedOld) { await cache.put(key, stamp(resp, want)).catch(() => {}); return {}; }
    const cp = resp.clone();
    return { resp, put: cache.put(key, stamp(cp, want)).catch(() => {}) };
  });
  e.waitUntil(got.then(x => x.put).catch(() => {}));     // keeps the worker alive until the copy is stored
  if (!old) { try { return (await got).resp; } catch (err) { return Response.error(); } }
  let x;
  try { x = await Promise.race([got, new Promise(r => setTimeout(r, MAP_WAIT_MS, 'late'))]); }
  catch (err) { return old; }
  if (x === 'late') { servedOld = true; return old; }
  return x.resp;
}

/* ---- 3. the app's own files ---- */
function shell(e, u) {
  const req = e.request, key = plain(u);
  const fresh = fetch(req).then(resp => {
    if (resp && resp.status === 200) { const cp = resp.clone(); e.waitUntil(caches.open(CACHE).then(c => c.put(key, cp)).catch(() => {})); }
    return resp;
  });
  if (req.cache === 'reload' || req.cache === 'no-store') {       // the page asked for the newest copy
    e.respondWith(fresh.catch(() => caches.open(CACHE).then(c => c.match(key)).then(r => r || Response.error())));
    return;
  }
  e.waitUntil(fresh.catch(() => {}));                             // keep the worker alive for the refresh, swallow offline errors
  e.respondWith(caches.open(CACHE).then(c => c.match(key)).then(r => r || fresh));   // nothing saved yet → plain network
}

/* ---- "Refresh app & data" ---- */
self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.t === 'refresh-shell') e.waitUntil(refreshShell().then(r => { if (e.ports && e.ports[0]) e.ports[0].postMessage(r); }));
});
/* refreshShell() — re-download every SHELL file, replacing each one only when the new copy arrived. Maps and the
   trip data are not touched. Answers {ok, failed}. */
async function refreshShell() {
  const c = await caches.open(CACHE); let ok = 0, failed = 0;
  await Promise.all(SHELL.map(async p => {
    try { const r = await fetch(p, { cache: 'reload' }); if (r.status === 200) { await c.put(abs(p), r); ok++; } else failed++; }
    catch (err) { failed++; }
  }));
  return { ok, failed };
}
