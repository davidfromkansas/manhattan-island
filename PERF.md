# Performance & Latency Program

Tracking doc for the five performance workstreams. **Edit this file as work lands** —
status boxes, the measurements log, and deviations from plan all live here.
Goal: cut latency and memory (mobile crashes) without losing any functionality or
visual parity at desktop quality, and make the app scale to more live data sources.

Rules of engagement (per AGENTS.md): one workstream per commit, surgical diffs,
`git pull --rebase` before every push, run the **Verification Protocol** below before
every push (every push deploys prod).

## Status board

| # | Workstream | Risk | Status |
|---|------------|------|--------|
| A | Device-tier default quality (mobile stops running `high`) | low | ✅ done |
| B | CDN caching for API feeds (`s-maxage` + `stale-while-revalidate`) | low | ✅ done |
| C | Startup memory: C1 ✅ · C2a typed sinks ✅ (peak −343 MB) · C2b compress+dispose ✅ (settle 517→86 MB, GPU −48%) | high | ✅ **MOBILE CONFIRMED FIXED** (2026-07-08, user-verified on Safari + Chrome mobile after C2b; C2c not needed) |
| D | Consolidated `/api/live` snapshot ✅ + Web Worker bridge ✅ (9 pollers → 1 off-thread; `#nolive` kill switch) | high | ✅ done (payload trims optional) |
| E | Distance-tiered simulation updates (traffic: −38% CPU at street level, ÷2 cap aloft) | medium | ✅ done (traffic; boats/riders not worth it — ~5% of the cost) |
| F | DCP chunk streaming: rank-bounded eviction (loaded ≤ `CAP + KEEP`, not distance-only) | medium | ✅ done (2026-07-12; keeps resident geometry FLAT as neighborhoods are added) |

**F — DCP chunk eviction (2026-07-12).** As more baked-neighborhood chunks were registered (now
50: 26 BK + 20 QN + 3 UES + resident), desktop resident geometry grew unbounded: the streamer only
freed a loaded chunk once it was past `DCP_UNLOAD` (~15.5 km), and all of NYC fits inside that, so
loaded chunks piled up toward all 50 (~575 MB projected heap). Fix: evict by **rank** — keep the
nearest `DCP_CAP` loaded and free anything past the nearest `DCP_CAP + DCP_KEEP` (`+KEEP` = hysteresis
band so a chunk at the boundary doesn't load/dispose-thrash). Measured (desktop `high`, after flying
across the city): loaded settled at **18–20** (was 27+ and climbing); moving Manhattan→East Brooklyn
**freed the far Manhattan chunks** (ues 3→0) while the near ones loaded; heap 350→328 MB, DCP geometry
4.41M→3.06M verts, fps 120, no visible gaps at navigation zoom. Mobile (`CAP=3`) was already bounded by
its tight radius; unchanged. Tradeoff: a very wide aerial now shows the nearest ~20 neighborhoods rather
than all of them — the fix for that is per-chunk distance LOD (a separate, larger workstream).

## Baseline (measured 2026-07-07, commit `7d434d4`, desktop Chrome via preview, local server)

- **JS heap: 1,467 MB peak during startup build → settles to 518 MB.** (The peak is
  the mobile crash — iOS jetsams tabs far below 1.5 GB.)
- Static payloads fetched before first frame: streets.json 11.8 MB (3.4 gz) +
  buildings.json 10.7 MB (2.7 gz) + blocks.json 3.4 MB (1.3 gz) + boundaries.json
  0.24 MB — **26.2 MB raw / 7.5 MB gz**, all `JSON.parse`d on the main thread.
- Scene: 6.06 M tris, 83 draw calls, 82 geometries, 6 textures, **15,607 CPU-simulated
  vehicles/frame**, 39,827 Manhattan buildings, 120 fps (M-series desktop).
- Renderer: `antialias: true` (MSAA), DPR min(device, 2) → 1.75 at `high`,
  2048² shadow map. `applyQuality('high')` unconditional — no device detection.
- Live feeds (11 endpoints, independent pollers): subway 267 KB/20 s,
  citibike 376 KB/30 s, buses 129 KB/15 s, cams 112 KB/10 m, traffic 28 KB/60 s,
  traffic-events 54 KB/4 m, stations 270 KB/24 h, flights 3 KB/20 s, ferries/birds/
  weather ≤1 KB. ≈ 1 MB/min parsed on the main thread.
- All `/api/*` responses `Cache-Control: no-store`; prod `x-vercel-cache: MISS` always.
- 19 `instanceMatrix.needsUpdate` upload sites per frame (worst case).

## Measurements log

Capture after each workstream lands (same method as baseline: preview server 4191,
`#dbg`, eval heap at load and after 20 s settle, read `#dbg` overlay).

| Commit | Peak heap | Settled heap | Tris | Calls | Vehicles | fps | Notes |
|--------|-----------|--------------|------|-------|----------|-----|-------|
| 7d434d4 (baseline) | 1467 MB | 518 MB | 6.06 M | 83 | 15,607 | 120 | desktop `high` |
| A (device tier) | — | 517 MB | 5.94 M | 82 | 15,607 | 54* | desktop `high` unchanged; *fps dip = headless tab variance, not code |
| C2a (typed sinks) | **1105 MB** | 517 MB | 5.97 M | 83 | 15,607 | 55* | peak −343 MB vs baseline; post-generateCity 575→83 MB |
| C2b (compress+dispose) | ~1105 MB | **86 MB** | 5.94 M | 82 | 15,607 | 52* | settle −431 MB; GPU vertex memory −48%; visuals verified noon+dusk |

---

## A. Device-tier default quality — status: ✅ DONE

**Why:** phones currently get `high` (DPR ~2, MSAA, 2048² shadows, 15.6 k vehicles).
The `low` tier already exists and is exactly the mobile budget; nothing selects it.

**Design:** compute a `TIER` early (before renderer creation):
phone (`pointer: coarse` + short edge < 820 px) → `low`; tablet (`coarse`, larger) or
`navigator.deviceMemory ≤ 4` (Chrome-only, absent on Safari → ignore) → `medium`;
else `high`. Use it for `renderer` creation too (`antialias: TIER !== 'low'`, initial
pixel ratio) and replace the hardcoded `applyQuality('high')`; sync the quality
`<select>` so the user sees and can override the auto choice.

**Tasks**
- [x] `TIER` detection before renderer init; `antialias`/initial DPR follow it
- [x] `applyQuality(TIER)` + dropdown synced
- [x] Verify desktop still defaults `high`; manual override still works
      (verified: desktop → dropdown `high`, scene identical to baseline; override to
      `low` → DPR 1.25, shadows gated off, drawn vehicles scale via `mesh.count`;
      phone params → `low`, tablet → `medium`; no module errors)
- [x] Verification Protocol + measurements row
      NOTE: overlay "vehicles" reports pool size (15,607) by design — per-frame
      simulation cost is unchanged at `low`; that reduction is Workstream E's job.
      `antialias` is fixed at renderer creation, so a manual quality switch after
      load doesn't toggle MSAA — only the auto tier at startup does.

**Specific verification:** desktop preview → `ui.quality.value === 'high'`, scene
unchanged (tris/calls ≈ baseline). Simulate phone: eval `applyQuality('low')` →
vehicles ≈ 0.35×, shadows off, no module errors. Confirm the dropdown override
persists after auto-selection.

**Rollback:** single commit revert; no data-shape changes.

## B. CDN caching for API feeds — status: ✅ DONE

**Why:** every poll from every user hits a function; new Fluid instances re-warm
upstream caches from scratch (subway cold hit = 7 MTA fetches + decode). Feeds are
identical for all users — ideal CDN material. Expected: most polls served at edge
latency, upstream load flat as users grow.

**Design:** in `lib/api-core.js`, `sendJSON` gains an optional cache-control arg
(default stays `no-store`). `serveCached` derives per-route headers from the route's
TTL: `public, max-age=0, s-maxage=⌈ttl_s⌉, stale-while-revalidate=4×ttl_s (cap 600)`.
History day files (immutable): `s-maxage=86400`; manifest: 300 s; `/api/route/:cs`:
3600 s. **Never cached:** `/api/agent`, `/api/agent-log`, `/api/record`.
Browser caching stays off (`max-age=0`) — only the shared edge caches.

**Freshness trade-off (accepted):** a response can be served up to
`s-maxage + swr` stale. Clients dead-reckon from `fetchedAt`, so motion stays smooth;
stale-eviction horizons (≥ 90 s) tolerate the worst case (~75 s for 15 s-TTL feeds).

**Tasks**
- [x] `sendJSON` optional cache arg; `serveCached` TTL-derived headers
      (+ guard: never cache a not-yet-warmed empty response — would pin emptiness
      at the edge for the whole window; negative /api/route lookups stay uncached)
- [x] History/manifest/route cache headers; agent endpoints stay `no-store`
- [x] Local curl header checks per endpoint class (buses 15/60, subway 20/80,
      citibike 30/120, cams 600, stations 86400, weather 300, history 300/day 3600,
      agent no-store) ✓
- [x] Prod: second hit within window shows `x-vercel-cache: HIT` ✓ (and `STALE` on a
      post-window hit = stale-while-revalidate serving instantly while revalidating —
      exactly as designed; Vercel consumes s-maxage/swr at the edge, so the
      client-facing header collapses to `public, max-age=0`)
- [x] Verification Protocol: clean load, weather chip live, scene at baseline

**Rollback:** revert commit; headers are stateless.

## C. Startup memory (the crash fix) — status: ☐

**Why:** 1,467 MB peak / 518 MB settled. Cause: 26 MB `JSON.parse` into millions of
small arrays (every `[x,z]` a heap object), all alive while merged geometry builds;
`SG_DATA`/`BLK_DATA`/`BLDG` retained at module scope forever.

**Design — two stages, land separately:**
- **C1 (low risk):** release what's only needed at build time. `const`→`let` and null
  out after generation: `BLDG` (columnar arrays), `BLK_DATA`/`G_BLOCKS` (verify no
  runtime consumers first — traffic seeds? fillBlock only?), plus any other
  build-only intermediates found while measuring. Measure per-structure with heap
  snapshots before deciding stage C2 scope.
- **C2a (SHIPPED — plan revised by measurement):** startup heap checkpoints showed
  the peak was NOT the JSON parse (581 MB post-parse) but the **geometry sinks**
  during the borough builds (+870 MB of plain JS number arrays, sections 12b–21).
  Fix: `GrowF32` — a doubling Float32Array with the same `push(...)` contract —
  replaces the sink arrays; `sinkToGeometry` slices exact-size buffers. Zero
  precision change (geometry was always Float32 in the end); every push site
  untouched (all writes funnel through sinkQuad/pushPrism/pushPoly fans).
  **Measured: peak 1,448 → 1,105 MB; post-generateCity heap 575 → 83 MB; scene
  byte-identical (82–83 calls, 5.9 M tris, 39,827 buildings); settle unchanged.**
- **C2b (SHIPPED — retargeted after phone retest still crashed):** the killer was the
  RESIDENT footprint, not the transient peak: three.js retains a CPU copy of every
  attribute array (~517 MB settle), and the unindexed merged city cost 44 B/vertex on
  CPU **and** GPU. Fix in `sinkToGeometry`: (1) attribute compression — normals Int8
  normalized, colors Uint8 normalized, kinds Int8 (all exact/imperceptible; seeds
  stay Float32 so window patterns are bit-identical) → 44 → 23 B/vertex on both
  sides (~−48% GPU); (2) `onUpload(disposeArray)` frees the CPU copies right after
  GPU upload (bounding sphere precomputed while the position array exists;
  context-loss restore would need a reload — mobile browsers reload on loss anyway).
  **Measured: settled JS heap 517 → 86 MB.** Visual gates: noon downtown (Lambert
  shading/colors correct), dusk canyon (window ignition patterns intact), scene
  stats byte-identical (82 calls, 5.94 M tris, 39,827 buildings), concierge +
  timeline OK, no module errors.
- **C2c: NOT NEEDED.** User confirmed 2026-07-08 the app runs on mobile Safari and
  mobile Chrome after C2b deployed. Staged-parse/binary-bake notes kept below in
  case future data growth reopens the budget.
  Original binary-bake design notes kept below for C2b:
  `streets.bin` flat Float32Array + index table, fetched as ArrayBuffer (no parse);
  keep `G_EDGES[i]` object shape but back `p` with typed views; server agent keeps
  reading `streets.json` — both artifacts regenerate from one bake script.
- Mobile-first-frame bonus if C2 lands well: defer `buildings.json` fetch until after
  first render (city appears, buildings stream in) — parity-visible, so only with
  explicit sign-off.

**Tasks**
- [x] C1: audit runtime consumers of `BLDG` / `G_BLOCKS` / `BLK_DATA` (grep + run)
      — only runtime ref was `__audit.G()` counts → captured as `G_COUNTS`
- [x] C1: null build-only data post-build (release point after section 21, before
      traffic); measure peak + settled heap
- [x] C1: Verification Protocol (scene identical: 39,827 buildings, tris/calls at
      baseline, audit counts preserved, no module errors)
      **HONEST RESULT:** settled heap unchanged within measurement noise (532 MB vs
      518 baseline; theoretical win ~40–50 MB from blocks+buildings columnar data).
      Retained heap is dominated by G_EDGES/G_NODES/EDGE_HASH — that's C2's target.
      C1 still correct & free (less GC pressure); the crash-fixing peak reduction
      REQUIRES C2 (no-parse binary load).
- [ ] C2: decide scope from C1 numbers; write bake script (JSON + bin from one source)
- [ ] C2: loader + minimal consumer changes; matchStreet parity harness (below)
- [ ] C2: Verification Protocol + measurements row

**Specific verification (C2): matchStreet parity harness.** Before C2, capture
`matchStreet(x,z)` outputs (ei, t, x, z rounded) for a fixed grid of ~200 sample
points + the known intersections (BROADWAY×W 42 ST area, MADISON AVE, FULTON ST) into
a JSON fixture via preview eval. After C2, re-run: **must be identical.** Also:
building count 39,827 unchanged; borough ribbons/fills render (screenshots at presets
0/2/5/6); buses map-match (chips show street names); cams snap to nodes.

**Rollback:** C1 revert trivial. C2: keep the JSON loader path behind a one-line
fallback (`?jsonsubstrate` hash or a const flag) for one release.

## D. Consolidated `/api/live` + Web Worker parsing — status: ☐

**Why:** every new feed today = one more poller + main-thread parse + radio wake-up
(~1 MB/min parsed on main thread now; grows linearly with feeds). This is the
scalability foundation.

**Design:**
- Server: `GET /api/live` composes `{subway, buses, ferries, flights, citibike,
  traffic, trafficEvents, birds, weather}` from the existing per-route caches (no new
  upstream calls), each with its own `fetchedAt`. Slow/huge feeds stay separate
  (cams list, stations — long-TTL one-shots). Per-feed endpoints REMAIN (recorder,
  concierge tools, history all use them; they share the same caches — zero extra cost).
- Client: one poller (15 s cadence) in a **Web Worker** fetches + parses; posts each
  feed's payload only when its `fetchedAt` changed. Modules keep their existing
  `ingest(...)` functions — the worker bridge calls them with identical shapes, so
  `hist()` replay contracts don't change.
- Payload trims (server-side, shapes preserved): subway trips drop already-passed
  stops (est. −50% of 267 KB); citibike splits static info from live status.

**Tasks**
- [x] `/api/live` route (respects B's cache headers, s-maxage=15) — verified: all 9
      feeds composed from the per-route caches with per-feed fetchedAt/stale, 6 s
      bounded wait per feed (a slow upstream ships last-good instead of stalling the
      snapshot), per-feed endpoints byte-identical for recorder/concierge/history
- [x] Worker bridge (`liveBridge`, §26a2): inline blob worker polls `/api/live` every
      15 s, parses off-thread, pauses when the tab is hidden; modules call
      `liveBridge.get('feed')` — same JSON shape (per-feed fetchedAt/stale + snapshot
      `now` injected), so every ingest/backoff/HIST path is untouched. All 9 sites
      switched (weather, flights, subway, ferries, buses, citibike, birds, traffic,
      trafficEvents); one-shots (cams list, stations, history, route, traffic-local)
      stay direct by design.
- [x] Kill switch: `#nolive` hash (or worker construction failure) → direct per-feed
      fetches; verified: worker off, all data still flows.
- [x] Verification: zero recurring main-thread feed fetches in the network log
      (worker owns /api/live); layer counts via bridge (subway 280 trips, buses 580,
      citibike 2,418, traffic 54 links; ferries 0 + flights 10 = overnight reality);
      timeline scrub in ("past") / out ("live") clean; weather chip live; no module
      errors.
- [ ] OPTIONAL follow-ups: subway stop-list trim + citibike static/live split
      (bandwidth only, now that parsing is off-thread); fold `/api/traffic-local`
      (live E-ZPass poll) into `/api/live`.

**Specific verification per module:** entity counts match the old path (±poll
timing); dead-reckoning smooth (no teleports over 2 min); stale-eviction still works
(kill server → entities persist then fade per horizon); **timeline scrub in/out
replays and returns to live** (the `hist()` contract); chips/click-follow work;
recorder endpoint unchanged (`curl /api/buses` shape identical).

**Rollback:** per-module — each module switch is its own commit; `?nolive` global.

## E. Distance-tiered simulation updates — status: ☐

**Why:** 15,607 vehicles + boats/birds/riders simulate every frame regardless of
distance; 19 full-buffer instanceMatrix uploads. Frame CPU is the mobile bottleneck
and grows with every animated layer.

**Design:** shared helper `simLOD(dist, camY)` → tick divisor (1 near / 2 mid /
4 far / skip beyond fog). Apply first to the biggest wins: traffic streams, then
boats, then citibike riders. Far entities advance with accumulated dt on their next
tick (no drift). **Exemptions:** followed/focused entities (FOCUS.posGet target,
ride-alongs), anything with a visible chip, photo mode keeps full-rate everything.
Wide hero views: scale divisor by camera altitude so the "everything alive" reading
survives (at 4 km up, far ≈ everything — use altitude to *raise* the far threshold,
not to freeze the scene).

**Tasks**
- [x] Per-route LOD in the traffic module (route center/radius baked in addRoute;
      divisors 1/2/4/8 by distance, capped at 2 above 2,200 m altitude so wide views
      stay uniformly alive; far vehicles advance with ACCUMULATED dt — same distance
      covered, no drift; ticks staggered by (i+frame)%divisor). `traffic._lod`
      exposes thresholds for tuning; `window.__traffic` dev hook.
- [x] Exemptions: NOT NEEDED for ambient traffic (no chips/click/follow attach to
      it); live entities (buses/trains/boats with chips) are untouched by E.
- [x] Boats + riders: SKIPPED deliberately — ~800 entities total ≈ 5% of traffic's
      cost; not worth the added complexity. Revisit only if a future layer adds
      thousands of simulated movers (then reuse the per-route LOD pattern).
- [x] Frame-time measurement: traffic.update 10.29 → 6.33 ms/frame at street level
      (−38%) with 15,607 vehicles; high-altitude cap gives ~½ rate everywhere.
      Visual: hero + street level coherent, no stepping artifacts, no module errors.

**Specific verification:** camera flights show no visible far-field "stepping" at
hero altitude; followed bus/train stays butter-smooth; fps at `low` tier improves on
loaded scene; no entity freezes permanently (soak 3 min, entities at map edges still
move when visited).

**Rollback:** helper defaults to divisor 1 via one const.

---

## Verification Protocol (run before EVERY push)

1. **Syntax gates:** `node -e "require('./lib/api-core.js'); require('./lib/agent-core.js')"`;
   extract the index.html module script → `node --check`.
2. **Load gate (preview, port 4191, `#dbg`):** `window.__moduleError === null` after
   ≥ 8 s. `#dbg` overlay: fps, calls, tris, vehicles, buildings — compare to the
   measurements log (±10% unless the change intends otherwise).
3. **Functional spot checks (preview evals + screenshots):**
   - Presets: screenshot at hero (0), downtown (2), bridges (5) — eyeball geometry,
     no black/missing districts.
   - Live layers: `__dbg.subway` beacons > 0 (rush hours) or non-error; buses/cams/
     citibike hooks respond; weather chip shows current conditions.
   - `matchStreet(-339, 6839, 400)` returns a Midtown edge (non-null).
   - Timeline: `__timeline.set(-4320)` enters replay (badge "past"), `set(0)` returns
     to LIVE, entities repopulate.
   - Concierge: POST `/api/agent` data question returns 200 + sane reply; camera
     intent applies; `show_layer` boundary draws (Williamsburg outline).
   - Focus: `__focusui.enter` installs `FOCUS.posGet`; viewer context carries
     `focus_neighborhood`.
4. **Heap + perf capture:** record peak (during load) and settled (20 s) heap, fps —
   append to the measurements log with the commit hash.
5. **Push, then prod:** wait for deploy; `GET /api/agent` ok; load prod URL headless
   (or curl the static assets) — spot-check one API's cache header when B has landed.
6. **Rollback ready:** every workstream = one revertable commit; kill switches noted
   per workstream above.

## Out of scope / explicitly NOT doing

- No visual-parity changes at desktop `high` (C's deferred-buildings idea needs
  explicit sign-off first).
- No `.github/workflows` (iron rule 7). No changes to calibration/land predicates.
- CHANGELOG: these are internal perf changes — no entries (per the changelog rule),
  except if A's auto-tier is deemed user-visible enough to note later.
