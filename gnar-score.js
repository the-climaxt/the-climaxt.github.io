/* gnar-score.js — the G.N.A.R. scoring maths, shared by gnar.html (the game) and index.html (the Home card).
   One copy, so the two boards can never disagree. Plain script, no build step: <script src="gnar-score.js">.

   What lives here:
   - VOTE_PTS, SB_DAY, PROPS — the numbers behind the nightly votes and the Super Bowl props
   - gnarIsMeta(claim)      — votes, prop picks and prop results are claims with no points of their own
   - gnarVoteAwards(claims) — per ski day, each voter's LAST vote counts; most votes wins; a tie pays all
   - gnarPropAwards(claims, players) — picks vs the recorded result; first pick sticks, latest result wins
   - gnarScores(claims, players, today, byCode) — {name: {total, today, lines, extras, pen, votes, props, n}}
   - gnarPlayers(D)         — the crew members whose legs say "Full trip"
   - gnarClaims()           — the phone's copy of the board: the sheet cache + this phone's unsent queue
   - gnarFetch(runsUrl, cb, k) — refresh the cache from the sheet (network), then call back
   - gnarCrewToken(dataKey), gnarWithK(url, k) — the crew token every request to the sheet script carries
   - gnarOneFix(claims)     — keeps one reversal per claim (the first)

   The game page adds the item list (ITEMS) on top of this; index.html only needs totals. */

var VOTE_PTS = { LOTD: 5, COTD: 3 };
var SB_DAY = '2027-02-14';
var PROPS = [
  { c: 'SBCOIN',  n: 'Coin toss',        kind: 'pick',    opts: ['Heads', 'Tails'], p: 1 },
  { c: 'SBFIRST', n: 'First score',      kind: 'pick',    opts: ['Touchdown', 'Field goal', 'Safety or other'], p: 1 },
  { c: 'SBGAT',   n: 'Gatorade colour',  kind: 'pick',    opts: ['Orange', 'Yellow', 'Blue', 'Red', 'Purple', 'Green', 'Clear', 'None'], p: 3 },
  { c: 'SBANTH',  n: 'National anthem',  kind: 'seconds', p: 3, d: 'How long, in seconds. Closest wins.' },
  { c: 'SBHALF',  n: 'Halftime opener',  kind: 'text',    p: 3, d: 'First song. The room judges.' },
  { c: 'SBWIN',   n: 'Winner and margin', kind: 'text',   p: 2, d: 'Team and points. Within 3 gets it.' }
];

function gnarIsMeta(c) { return /^(VOTE-|PICK-|RES-)/.test((c && c.item) || ''); }

function gnarPlayers(D) {
  var p = ((D && D.crew) || []).filter(function (c) { return /full/i.test(c.legs || ''); }).map(function (c) { return c.name; });
  return p.length ? p : ['Tanner', 'Zack', 'Dan', 'John'];
}

/* the phone's view of the board = what the sheet last said + what this phone has not sent yet */
function gnarClaims() {
  var cache = [], queue = [];
  try { cache = JSON.parse(localStorage.getItem('gnar-cache') || '[]'); } catch (e) {}
  try { queue = JSON.parse(localStorage.getItem('gnar-queue') || '[]'); } catch (e) {}
  var seen = {}; cache.forEach(function (c) { seen[c.id] = 1; });
  return cache.concat(queue.filter(function (q) { return !seen[q.id]; }));
}

/* the sheet hands numbers back as strings sometimes — tidy each row */
function gnarNorm(c) {
  return { id: String(c.id || ''), ts: Number(c.ts) || 0, day: String(c.day || ''), who: String(c.who || ''), item: String(c.item || ''),
    pts: Number(c.pts) || 0, by: String(c.by || ''), witness: String(c.witness || ''), note: String(c.note || ''), parts: String(c.parts || ''), target: String(c.target || '') };
}

/* ---- The crew token (audit M18, Sep 24 2026) ----
   The crew's Apps Script only answers phones that send k = the first 32 hex characters of
   SHA-256("powder-run-api-v1:" + dataKey). dataKey is the crew data key inside the encrypted trip data;
   04-app-build/crew-token.js prints the same value for the script's CREW_TOKEN property.
   gnarCrewToken(dataKey) → a Promise of the token. One copy here, used by index.html and gnar.html.
   - No dataKey (old data) → '' → the pages send no k (the script accepts that until Nov 30, 2026).
   - Worked out once per data key and kept in memory only: never written to localStorage, never put
     inside a queued item. Pages add it at the moment they send. */
var GNAR_K = {};
function gnarCrewToken(dataKey) {
  dataKey = (typeof dataKey === 'string') ? dataKey : '';
  if (!dataKey) return Promise.resolve('');
  if (GNAR_K[dataKey]) return GNAR_K[dataKey];
  var p;
  try {
    p = crypto.subtle.digest('SHA-256', new TextEncoder().encode('powder-run-api-v1:' + dataKey)).then(function (buf) {
      var a = new Uint8Array(buf), h = '';
      for (var i = 0; i < a.length; i++) h += ('0' + a[i].toString(16)).slice(-2);
      return h.slice(0, 32);
    }).catch(function () { return ''; });
  } catch (e) { p = Promise.resolve(''); }   // no WebCrypto (plain http): send no token rather than break
  GNAR_K[dataKey] = p;
  return p;
}
/* gnarWithK(url, k) — a GET address with the token added (?k=… or &k=…). No token → the address as it was. */
function gnarWithK(url, k) { return k ? url + (url.indexOf('?') < 0 ? '?' : '&') + 'k=' + encodeURIComponent(k) : url; }

/* One reversal per claim (audit m5). Two phones can each reverse the same claim before they see each
   other's reversal. Only the first one (earliest ts, then lowest id) counts; the extra ones are left out
   of the phone's copy, so a claim can never be reversed twice (+15 → −15). The sheet keeps every row. */
function gnarOneFix(list) {
  var first = {};
  list.forEach(function (c) {
    if (c.item !== 'FIX' || !c.target) return;
    var f = first[c.target];
    if (!f || c.ts < f.ts || (c.ts === f.ts && String(c.id) < String(f.id))) first[c.target] = c;
  });
  var out = list.filter(function (c) { return c.item !== 'FIX' || !c.target || first[c.target] === c; });
  // a reversal OF a dropped reversal goes too (it would undo something that no longer counts)
  for (var gone = true; gone;) {
    var ids = {}; out.forEach(function (c) { ids[c.id] = 1; });
    var dropped = list.filter(function (c) { return c.item === 'FIX' && !ids[c.id]; }).map(function (c) { return c.id; });
    var before = out.length;
    out = out.filter(function (c) { return !(c.item === 'FIX' && c.target && dropped.indexOf(c.target) >= 0); });
    gone = out.length !== before;
  }
  return out;
}

/* refresh the cache from the sheet; cb(ok) either way. Never throws.
   k (optional): the crew token, or a Promise of it. Left out → worked out from the page's own trip data
   (the global D, which index.html and gnar.html both have), so older callers keep working and still
   send the token. A {ok:false, error:'locked'} answer never touches the phone's copy: cb(false, 'locked'). */
function gnarFetch(runsUrl, cb, k) {
  if (!runsUrl) { if (cb) cb(false); return; }
  var tp = (k != null) ? Promise.resolve(k) : gnarCrewToken((typeof D !== 'undefined' && D) ? D.dataKey : '');
  tp.then(function (tok) { return fetch(gnarWithK(runsUrl + '?gnar=1&t=' + Date.now(), tok)); }).then(function (r) { return r.json(); }).then(function (j) {
    if (Array.isArray(j)) { try { localStorage.setItem('gnar-cache', JSON.stringify(gnarOneFix(j.map(gnarNorm)))); } catch (e) {} if (cb) cb(true); }
    else if (cb) cb(false, j && j.error);
  }).catch(function () { if (cb) cb(false); });
}

function gnarVoteAwards(claims) {
  var byDay = {};
  claims.forEach(function (c) {
    if (c.item !== 'VOTE-LOTD' && c.item !== 'VOTE-COTD') return;
    var k = c.day + '|' + c.item; byDay[k] = byDay[k] || {};
    var cur = byDay[k][c.who]; if (!cur || c.ts > cur.ts) byDay[k][c.who] = c;
  });
  var awards = [];
  Object.keys(byDay).forEach(function (k) {
    var day = k.split('|')[0], kind = k.split('|')[1].replace('VOTE-', ''), tally = {};
    Object.keys(byDay[k]).forEach(function (v) { var t = byDay[k][v].target; if (t) tally[t] = (tally[t] || 0) + 1; });
    var max = 0; Object.keys(tally).forEach(function (t) { if (tally[t] > max) max = tally[t]; });
    if (max > 0) Object.keys(tally).forEach(function (t) { if (tally[t] === max) awards.push({ day: day, kind: kind, who: t, pts: VOTE_PTS[kind], votes: max }); });
  });
  return awards;
}

function gnarPropPicks(cl, code) {
  var first = {};
  cl.filter(function (c) { return c.item === 'PICK-' + code; }).sort(function (a, b) { return a.ts - b.ts; })
    .forEach(function (c) { if (!first[c.who]) first[c.who] = c; });
  return first;
}
function gnarPropResult(cl, code) { var r = null; cl.forEach(function (c) { if (c.item === 'RES-' + code && (!r || c.ts > r.ts)) r = c; }); return r; }

function gnarPropAwards(cl, players) {
  var out = [];
  PROPS.forEach(function (p) {
    var res = gnarPropResult(cl, p.c); if (!res || !res.target) return;
    var picks = gnarPropPicks(cl, p.c);
    if (p.kind === 'pick') {
      Object.keys(picks).forEach(function (w) { if (String(picks[w].target).toLowerCase() === String(res.target).toLowerCase()) out.push({ day: SB_DAY, who: w, pts: p.p, prop: p.c }); });
    } else if (p.kind === 'seconds') {
      var best = null;
      Object.keys(picks).forEach(function (w) { var d = Math.abs(parseFloat(picks[w].target) - parseFloat(res.target)); if (isNaN(d)) return; if (best === null || d < best) best = d; });
      if (best !== null) Object.keys(picks).forEach(function (w) { var d = Math.abs(parseFloat(picks[w].target) - parseFloat(res.target)); if (d === best) out.push({ day: SB_DAY, who: w, pts: p.p, prop: p.c }); });
    } else {
      String(res.target).split('+').forEach(function (w) { w = w.trim(); if (w && players.indexOf(w) >= 0 && picks[w]) out.push({ day: SB_DAY, who: w, pts: p.p, prop: p.c }); });
    }
  });
  return out;
}

/* totals per player. byCode(code) → item, optional: only used to split lines from extras in the breakdown. */
function gnarScores(cl, players, today, byCode) {
  var out = {};
  players.forEach(function (p) { out[p] = { total: 0, today: 0, lines: 0, extras: 0, pen: 0, votes: 0, props: 0, n: 0 }; });
  var byId = {}; cl.forEach(function (c) { byId[c.id] = c; });
  function cat(c) {
    if (c.item === 'FIX') { var o = byId[c.target]; return o ? cat(o) : 'pen'; }
    if (c.pts < 0) return 'pen';
    var it = byCode ? byCode(c.item) : null;
    return it && (it.g === 'line' || it.g === 'set') ? 'lines' : 'extras';
  }
  cl.forEach(function (c) {
    var s = out[c.who]; if (!s || gnarIsMeta(c)) return;
    s.total += c.pts; if (c.item !== 'FIX') s.n++; if (c.day === today) s.today += c.pts; s[cat(c)] += c.pts;
  });
  gnarVoteAwards(cl).forEach(function (a) { var s = out[a.who]; if (!s) return; s.total += a.pts; s.votes += a.pts; if (a.day === today) s.today += a.pts; });
  gnarPropAwards(cl, players).forEach(function (a) { var s = out[a.who]; if (!s) return; s.total += a.pts; s.props += a.pts; if (a.day === today) s.today += a.pts; });
  return out;
}
