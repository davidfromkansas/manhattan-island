# Task: Street-speed intelligence — Workstreams A + B (detailed implementation plan)

Audience: a coding agent joining this repo. Read `AGENTS.md` first — the Iron Rules
(frozen calibration, `landOK` water gating, the mirror, parallel-work discipline) all apply.
This plan was verified against the code as of commit `84a7403` (2026-07-09); re-verify the
anchors below with grep before editing — a parallel agent edits these files too.

## Goal

1. **Workstream A** — the City Concierge answers street-speed questions from the E-ZPass
   local dataset (plus the live feeds it already has), including by neighborhood, by hour,
   and for published past days.
2. **Workstream B** — the ambient simulated cars in the 3D scene move at data-informed
   speeds: live where we have live (DOT highways, bus-probe corridors), typical-for-this-
   hour on E-ZPass local links, unchanged synthetic elsewhere. Buses already move at real
   GPS speeds — do not touch them.

## What already exists (do not rebuild)

| Piece | Where | Contract |
|---|---|---|
| DOT highway live speeds | `/api/traffic` route in `lib/api-core.js`; client `LINKS` in section 25g | `{ links: [{ id, speed, tt, name, borough, pts }] }`, 60 s |
| E-ZPass local hourly profiles | `/api/traffic-local` (latest published day) + `/api/traffic-local/:day` (handleApi branch); `trafficLocalByDay(day)` internal fn | `{ day, links: [{ id, name, borough, pts, spd: [24 × mph\|null] }] }`, ~2-day lag |
| Bus probes (live, client-only) | `rtraffic` module 25g: `PRB.edges = [{ mph, n, nm, mid }]`, rolling 10-min window | live-only; cleared during timeline replay |
| Concierge | `lib/agent-core.js` — `FEEDS` registry → `get_data`/`show_layer`/`spatial_report`; `readFeed()` reads the in-process `routes` map; `boundaries()` + `pointInRings()` (5 boroughs + 262 NTA neighborhoods); `where_is` tool; substrate (`streets.json`) already loaded server-side | |
| Ambient cars | section 22 `traffic` module in `public/index.html` (~line 3213) — **just rewritten by PERF.md E** (distance-tiered ticks, accumulated dt) | budget-critical |
| E-ZPass client layer | 25g: `EZ.shown = { day, hh, links }` = what is displayed for the viewed wall-clock hour; `viewedHour()`; `histSpd` = DOT speeds while scrubbed | |

Verified anchors (grep to relocate; line numbers drift):
- `feedQuery(input)` — generic pipeline `def.rows(d)` → `applyQuery(rows, input, def.search)`;
  special-case branches for `weather`/`birds`/`subway` at the top. `applyQuery` handles
  `filter`/`near`/`sort_by`/`top`.
- `get_data` tool schema in `TOOLS`; `show_layer` materializes sources via `def.rows(...)`
  in `layerFromSource`.
- Section 22 `update(t, dt)`: per-vehicle tick gate `if ((i + fc) % r.lod) continue;`,
  accumulated `adt`, speed term `const sp = v.sp * wave;`, brake write
  `br[i] = clamp(1 - wave, 0, 1) * 0.8;`.
- `lib/api-core.js` exports `{ routes, handleApi, sendJSON }`; agent-core requires it.

## Acceptance bar (test these end-to-end when done)

★ concierge: "What's the slowest local street in the West Village right now?" → uses
  `traffic_local` + `area`, answers with a named street + mph + the published day, pins it.
★ concierge: "When is 6th Ave worst?" → one call with a filter, reads the 24 h profile,
  names trough hour + mph.
★ concierge: "Is traffic worse than usual right now?" → compares a live signal (DOT or
  buses-near) against E-ZPass same-hour typicals and quantifies the divergence.
★ concierge: "How was 6th Ave last Friday at 5 PM?" → `day` + `hour` params.
★ scene: at street level, cars on a red E-ZPass/DOT ribbon visibly crawl; cars on a green
  one flow; brake lights bunch on jammed blocks at night; side streets unchanged.
★ scene: scrub to a published day → car speeds follow that day's measurements at the
  viewed hour; return to live → live behavior resumes. `window.__moduleError` null
  throughout; no measurable fps regression at street tier (PERF.md protocol).

---

## Workstream A — concierge (`lib/api-core.js` +1 line, rest in `lib/agent-core.js`)

### A1. Export the day fetcher (api-core, one line)

`module.exports = { routes, handleApi, sendJSON, trafficLocalByDay };`
(`trafficLocalByDay(day)` already exists with its own immutable-day cache.)

### A2. `FEEDS.traffic_local` entry (powers show_layer / spatial_report / generic get_data)

```js
traffic_local: { route: '/api/traffic-local',
  rows: d => ezRows(d, nyHour()),
  search: r => r.name + ' ' + r.borough,
  summary: d => ({ publishedDay: d.day, linksTotal: (d.links || []).length,
    note: 'E-ZPass reader medians, published ~2 days behind — typical-for-the-hour, not live' }) },
```

Helpers (place near the FEEDS block):
```js
const NY_HOUR_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: 'numeric' });
const nyHour = () => +NY_HOUR_FMT.format(new Date());
function ezRows(d, hh) { // one row per link with a reading at hour hh; midpoint anchors the pin
  const out = [];
  for (const l of d.links || []) {
    const mph = l.spd && l.spd[hh];
    if (mph == null) continue; // no tag reads that hour — omit, don't invent
    const m = l.pts[Math.floor(l.pts.length / 2)];
    out.push({ label: l.name + ' · ' + Math.round(mph) + ' mph', name: l.name, borough: l.borough,
      speedMph: mph, hour: hh, lat: m[0], lon: m[1], id: l.id });
  }
  return out;
}
```

### A3. `feedQuery` special-case branch (route ALL `traffic_local` calls through it)

Insert before the generic `const def = FEEDS[feed];` line, mirroring the `subway` pattern:

```js
if (feed === 'traffic_local') return await trafficLocalQuery(input);
```

```js
async function trafficLocalQuery(input) {
  let d;
  if (input.day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day)) return { error: 'day must be YYYY-MM-DD' };
    try { d = await trafficLocalByDay(input.day); }
    catch (e) { return { day: input.day, error: 'not published (source lags ~2 days): ' + (e.message || e) }; }
  } else d = await readFeed('/api/traffic-local');
  const hh = input.hour != null ? Math.min(23, Math.max(0, input.hour | 0)) : nyHour();
  let rows = ezRows(d, hh);
  let area = null;
  if (input.area) { const r = await filterByArea(rows, input.area); if (r.error) return r; rows = r.rows; area = r.area; }
  const q = applyQuery(rows, input, FEEDS.traffic_local.search);
  if (q.rows.length <= 5) { // narrow ask → hand over the whole day-curve
    const byId = new Map((d.links || []).map(l => [String(l.id), l.spd]));
    for (const r of q.rows) r.profile = byId.get(String(r.id)); // [24 × mph|null], index = NY hour
  }
  return { publishedDay: d.day, hour: hh, area,
    note: 'E-ZPass medians published ~2 days behind — typical for the hour, not live',
    matched: q.matched, rows: q.rows };
}
```

### A4. `area` filter — the piece that makes the ★ West Village case exact (new, generic)

`boundaries()` + `pointInRings()` already exist; add the inverse lookup:

```js
async function filterByArea(rows, name) { // neighborhood first, borough second; exact then substring
  const B = await boundaries();
  const want = String(name).trim().toLowerCase();
  const pool = [...B.neighborhoods, ...B.boroughs.map(b => ({ ...b, boro: b.name }))];
  let hit = pool.find(a => a.name.toLowerCase() === want) || pool.find(a => a.name.toLowerCase().includes(want));
  if (!hit) return { error: 'unknown area "' + name + '" — use an NTA neighborhood or borough name' };
  return { area: hit.name, rows: rows.filter(r => typeof r.lat === 'number' && pointInRings(r.lon, r.lat, hit.rings)) };
}
```

Wire it into the **generic** `feedQuery` path too (all feeds benefit — "Citi Bikes in
Williamsburg"): after `def.rows(d)`, before `applyQuery`, when `input.area` is set. Add the
same hook in `layerFromSource` so `show_layer` can materialize area-scoped pins directly.

### A5. Tool schema changes (`TOOLS`, get_data + show_layer)

- `get_data.input_schema.properties` add:
  `hour: { type: 'integer', minimum: 0, maximum: 23 }`, `day: { type: 'string' }`,
  `area: { type: 'string' }`.
- Append to `get_data.description`:
  `"feed=traffic_local: E-ZPass reader speeds on LOCAL streets as 24h profiles from a
  published day ~2 days back — hour picks the profile hour (default: now, NY time), day
  picks a published day. area (any feed) = NTA neighborhood or borough name filter."`
- Add `'traffic_local'` to the feed enum (it's spread from `Object.keys(FEEDS)` — verify).
- `show_layer` source properties: add `area: { type: 'string' }`.

### A6. System prompt (~4 lines, match the existing voice, insert near the traffic mention)

```
- traffic_local = E-ZPass reader medians on local streets, published ~2 days behind. ALWAYS
attribute: "typical for this hour (published <publishedDay>)" — never present it as live.
- Live local-street signal: get_data buses near the point, average speedMs of moving buses.
- "Worse than usual?" recipe: live (traffic feed / buses near) vs traffic_local same hour —
report both numbers and the gap. For "when is X worst", read the profile field.
```

### A7. Verification (Workstream A)

1. `node -e` unit passes against the real feed (server not required — `readFeed` uses the
   routes map in-process): default query; `{filter:'6th Avenue'}` → ≤5 rows each carrying
   `profile` with 24 entries; `{hour: 3}` differs from `{hour: 15}`; `{day:'<2 days ago>'}`
   works and a future day returns the not-published error; `{area:'West Village'}` returns
   only links inside the polygon and `{area:'Narnia'}` errors cleanly.
2. `node -e "require('./lib/agent-core.js')"` loads clean.
3. End-to-end: `node server.js`, POST `/api/agent` with each ★ question (needs the
   git-ignored `ai-gateway-key.json`); confirm sensible tool-call sequences in the response
   trace, no schema-validation rejects in the server log, answers name the published day.
4. Confirm `show_layer {source:{feed:'traffic_local', area:'West Village', sort_by:'speedMph', descending:false, top:5}}` renders pins in the browser.

---

## Workstream B — real-speed cars (`public/index.html` only, two modules)

### B1. Speed field, owned by `rtraffic` (section 25g)

A 2-D grid of measured speeds; provenance priority bus-probe (live) > DOT (live) >
E-ZPass (typical at the viewed hour). ~150 m cells, painted by walking each polyline.

```js
/* --- speed field: measured mph on a 150 m grid, consumed by section 22's cars.
   Priority: live bus probes > live DOT links > E-ZPass typical-at-viewed-hour.
   Rebuilt whenever any sub-layer rebuilds; during a replay it reads the same
   displayed state as the ribbons (histSpd / EZ.shown), so past days drive too. --- */
const FIELD = new Map(); // cellKey → packed (w << 12 | mphx10)  … or { mph, w }, keep it simple
const fKey = (x, z) => ((x / 150) | 0) * 8192 + ((z / 150) | 0);
function fieldPaint(pts, mph, w) { /* walk pts at ~75 m steps; set cell when w >= existing w */ }
function fieldRebuild() {
  FIELD.clear();
  for (const L of EZ.shown.links) { const m = L.spd[EZ.shown.hh]; if (m != null) fieldPaint(L.pts, m, 1); }
  for (const L of LINKS) { const rec = histSpd ? histSpd.get(L.id) : null;
    const m = histSpd ? (rec ? rec[0] : null) : L.speed; if (m != null) fieldPaint(L.pts, m, 2); }
  for (const p of PRB.edges) fieldPaint(p.ptsOrEdgePolyline, p.mph, 3); // keep edge pts on PRB.edges at build time
  }
function speedAt(x, z) { const c = FIELD.get(fKey(x, z)); return c ? c.mph : null; }
```

- Call `fieldRebuild()` at the end of `rebuildRibbons()`, `ezRebuild()` (only when the key
  actually changed — it early-returns otherwise), `prbRebuild()`, and both arms of `hist()`.
  All are minute-scale; no debounce needed.
- `PRB.edges` currently stores only `mid` — extend `prbRebuild` to keep the edge polyline
  (`pts`) per entry so the field can paint it (cheap; it's already computed there).
- Gaps (`null` pts from tunnels/water) are simply not painted.
- Export: add `speedAt` to the module return (`window.__rtraffic.speedAt` for testing).
- Accepted imprecision (note in comment): a 150 m cell straddling an avenue bleeds the
  avenue's speed onto adjacent cross-street ends — fine for ambient realism.

### B2. Section 22 hook — keep the diff surgical, respect PERF.md E

Section 22 must not know about `rtraffic` (it is defined 3k lines earlier). Inversion:

1. In section 22's module scope: `let speedField = null;` and add to the return:
   `setSpeedField(fn) { speedField = fn; }`.
2. In `update(t, dt)`, inside the per-vehicle tick (after `const adt = v.acc; v.acc = 0;`):

```js
if (speedField && (v.seg !== v._fSeg || ((i + fc) & 31) === 0)) { // refresh on segment change or ~every 32nd tick
  v._fSeg = v.seg;
  const a0 = r.pts[v.seg];
  const mph = speedField(a0.x, a0.z);
  v.spdK = mph == null ? 1 : Math.min(1.3, Math.max(0.15, mph / KIND_TYP[r.kind]));
}
```
   with `const KIND_TYP = { hwy: 45, bridge: 35, ave: 17, st: 11, bway: 17 };` (mph; tune
   visually — the ratio is dimensionless so `v.sp` staying in m/s is fine).
3. Speed term becomes `const sp = v.sp * wave * (v.spdK || 1);`
4. Brake lights: `br[i] = clamp(1 - wave * (v.spdK || 1), 0, 1) * 0.8;` — jammed streets
   read as red walls at night for free.
5. At the END of the 25g module body (after `speedAt` exists):
   `traffic.setSpeedField(speedAt);` — one line, no main-loop changes, no TDZ risk (module
   body runs long before the first frame).

Perf constraints (hard): the only added per-tick cost is one Map lookup on a stagger; no
allocation anywhere in the loop; do not change the LOD/tick structure PERF.md E installed;
far-tier vehicles refresh `spdK` correspondingly less often — that is fine and intended.

### B3. History behavior (should fall out; verify, don't build)

`fieldRebuild` reads displayed state: while scrubbed, DOT uses `histSpd`, E-ZPass uses the
replayed day's profile at the viewed hour, probes are empty. Cars therefore crawl where the
recorded day crawled at the hour under the thumb, and side streets keep the synthetic wave.
On `hist(null)` the field snaps back to live within one rebuild.

### B4. Verification (Workstream B)

1. Console: find a red link (`__rtraffic.links` + speeds), check
   `__rtraffic.speedAt(mid[0], mid[2])` ≈ its mph; a Central Park interior point → null.
2. Visual A/B: camera at street level over a jammed E-ZPass block vs a green one —
   cars visibly slower on red (screenshot both). Night shot: brake-light bunching.
3. Perf: PERF.md measurement protocol at the street-level preset before/after — frame CPU
   delta must be ≈ 0 (the hook is one lookup per vehicle-tick per 32 ticks).
4. Scrub: replay a published day, jump the thumb between 3 AM and 5 PM — car speeds on
   instrumented streets change; return to live → live speeds resume. `__moduleError` null.
5. `node -e "require('./lib/api-core.js')"` still clean (A1 touched it).

---

## Order, commits, parallel work

1. **A first** (independent, demo-able): commit `lib/api-core.js` + `lib/agent-core.js`.
2. **B second**: commit `public/index.html` (25g field + section 22 hook) separately.
3. `git pull --rebase` before each push; another agent works in these exact files — keep
   diffs surgical, re-grep every anchor above before editing, never reformat neighbors.
4. Every push deploys. Full verification BEFORE each push, per AGENTS.md (module errors,
   visual pass at presets 0–6, api-core require check).

## Explicitly out of scope

- HERE/TomTom live feeds (plan Workstream C/D — awaiting user decision).
- Server-side bus-probe aggregation (note: `agent-core` already loads `streets.json`
  server-side in `substrate()`, so this is cheaper than once assumed — future task).
- Routing / door-to-door ETAs (the agent must keep answers link-level and say so).
- Recorder changes (E-ZPass archive is its own recording; probes are live-only).
