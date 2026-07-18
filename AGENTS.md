# Agent Onboarding — manhattan-island (NYC Live Digital Twin)

You are joining an existing codebase as a second agent working in parallel with another
agent. Read this whole file before writing code. Precision matters here: most of this
scene is generated from surveyed city data through a frozen calibration, and casual
edits in the wrong place corrupt geography.

## What this is

A self-contained Three.js digital twin of NYC — **all five boroughs complete**
(2026-07-13): real DCP 3D-model building massing streamed as ~127 binary chunks,
the real CSCL street graph, surveyed wetlands, airports, bridges, and the Staten
Island Railway — with LIVE data layers: flights, subway, NYC Ferry, MTA buses,
Citi Bike, traffic cameras, birds (radar), 311, traffic speeds, weather — all
map-matched onto the street graph. 12,703 clickable census-sampled voxel residents
(PUMS personas) with thought bubbles; a City Concierge LLM agent with spatial tools;
a nightly recorder + timeline slider that replays seven daily city snapshots and 30 days of packed hourly Air Quality intervals. Public site:
**nycsim.com** branding, GBA-style controls on phones.

## Current state & where to start (updated 2026-07-14)

- Latest prod = `main` HEAD. The city build is DONE; work now is features/polish.
- **Open, speced, ready to build: `plan-home.md`** (Google sign-in + saved home
  address + boot-to-home + resident dashboard). A complete verified reference
  implementation exists at reverted commit `03bb8d3` — the spec tells you exactly
  what was proven and what wasn't. If you're a new agent looking for the task,
  this is it.
- `PERF.md` = the performance program (device tiers, CDN caching, memory diet,
  streaming) — all five workstreams complete; read it before touching perf.
- Other `plan-*.md` files: see the Plans index below — most are shipped history,
  and UNTRACKED plan files belong to other in-flight sessions (leave them alone).

- **Repo**: `github.com/davidfromkansas/nycsim` (private). Pull `main`.
  `git clone git@github.com:davidfromkansas/nycsim.git`
- **Prod**: https://manhattan-island-davidlietjauw-7177s-projects.vercel.app
  (Vercel auto-deploys every push to `main` — a push IS a deploy; don't push broken code)
- **`data` branch**: orphan branch holding recorded daily city snapshots and packed Air Quality days
  (`data/daily/YYYY-MM-DD.json`, `data/air-quality/YYYY-MM-DD.json`, and `manifest.json`). Written by the nightly cron.
  Never merge it into main; never commit data to main (each main commit = a deploy).

## Layout (zero build step, zero npm deps)

| Path | What |
|---|---|
| `public/index.html` | THE ENTIRE SCENE — one ~6k-line ES module (Three.js 0.166 via import map). All rendering, all live-layer clients, UI. |
| `lib/api-core.js` | All server fetchers + caching (`makeCachedRoute` pattern) + `handleApi` dispatcher. Shared by local server and Vercel. |
| `server.js` | Local dev server: static `public/` + `/api/*`. `node server.js` → http://localhost:4173 |
| `api/index.js` | Vercel catch-all → `handleApi` (vercel.json rewrites `/api/(.*)` → it; real files in `api/` win over the rewrite) |
| `api/record.js` | Nightly snapshot cron (05:05 UTC): fetches own APIs, commits to `data` branch via GitHub API |
| `lib/agent-core.js` | "City Concierge" LLM agent: read-only tools (live feeds w/ near/sort filters, buildings + street-graph queries in scene meters, history, buffer reports) + validated intents (camera, map layers, timeline scrub). Raw-fetch to Vercel AI Gateway (Anthropic-compat), per-IP rate limits. Chat UI + layer renderer = index.html §26d. Substrate JSONs lazy-load from disk locally / self-fetch of the deployed static files on Vercel. |
| `api/agent.js` | Vercel function for POST `/api/agent` → `handleAgent` (server.js mirrors it locally) |
| `lib/agent-log.js` | First-party Concierge usage logging → one immutable JSON blob per turn in the private `agent-logs` Vercel Blob store (raw Blob REST via fetch, zero-dep). Best-effort/time-boxed: never blocks or breaks a reply. |
| `lib/agent-log-view.js` + `api/agent-log.js` | GET `/api/agent-log` — private usage viewer/aggregator, gated by `AGENT_LOG_KEY` (inert 404 until set). `?stats=1`, `?day=`, `?full=1`. |
| `scripts/record.mjs` | Manual/local recorder (same frame format) |
| `public/streets.json` | Real street graph: 86,471 CSCL edges + 57,450 nodes (see schema below) |
| `public/blocks.json` | 27,257 real city-block faces |
| `public/buildings.json` | 304,911 real building footprint boxes (BIN ids) |
| `public/boundaries.json` | 5 borough + 262 real 2020-NTA neighborhood polygons (lon/lat rings; client converts via `subway.geoRaw`). Powers agent region context + boundary layers. |
| `public/pums.json` | 55 NYC 2020-PUMA demographic profiles (weighted ACS 2023 1-Year PUMS) + borough/city rollups + NTA→PUMA crosswalk + PUMA polygons. Powers the concierge `demographics`/`compare_areas`/`rank_areas` tools + income/etc. choropleths. Baked offline (keyless Census bulk), no runtime key. |
| `public/personas.json` | 12,703 real anonymous PUMS person records (weighted sample ~1 per 650 residents/PUMA) → the clickable voxel residents (index.html §25h: 8 InstancedMesh draw calls sharing one distance-grow Lambert, seeded in-PUMA placement via landOK, #personaCard + focus context; looks are random by design, never demographic-mapped). |
| `public/*.bin` (~127 chunks) | DCP 3D-model building massing: `mn-/ues-/bk-/qn-/bx-/si-` + `roosevelt` chunk meshes + `.lod.bin` box-LOD variants, decoded off-thread by `public/dcp-worker.js`, streamed with rank-bounded eviction. Baked by the (scratchpad) `mn_bake.py` pipeline — see PERF.md F/G/H. |
| `public/bk-south-land.json` + `.bin` | Building-coverage land mask (THE `landOK` bitmask authority off the legacy plates: south BK, SE Queens/Rockaways, E/N Bronx, all SI) + its resident ground mesh. Generated by `scripts/bk_south_land.py`; surveyed wetlands (Open Data `p48c-iqtu`) are rasterized into it. |
| `public/si-rail.bin` | Staten Island Railway resident mesh (ballast + rails + 21 stations) from MTA subway GTFS `SI` shapes. |
| `PERF.md` | Performance program tracking doc + verification protocol (tiers, CDN cache, memory, streaming, traffic LOD). |
| `CHANGELOG.md` | User-facing feature log — required entry per shipped feature (rules below). |

## Plans index (docs at repo root)

| File | Status |
|---|---|
| `plan-home.md` | **OPEN — the next feature.** Full spec; reference impl at reverted `03bb8d3`. |
| `plan-find-place.md` | shipped (concierge `find_place` Google Places tool) |
| `plan-gba-mobile.md` | shipped (GBA phone controls) |
| `plan-mobile-memory.md` | shipped (M1 chunk attribute diet, M2 flat street polylines) |
| `plan-queens-dcp.md` | shipped (Queens QN08-14 completion) |
| `plan-thought-bubbles.md` | shipped (§25t resident thoughts + ticker) |
| `plan.md` | shipped (PUMS demographics/personas program) |
| any UNTRACKED `plan-*.md` | another session's work-in-progress — do not edit, commit, or delete |

## Run + test locally

```bash
node server.js            # http://localhost:4173 — that's it, no install
```
- Secrets live in git-ignored root files (ask the user if you don't have them):
  `opensky-credentials.json` (flights), `mta-bus-key.json` (buses),
  `google-maps-key.json` or `GOOGLE_MAPS_API_KEY` (enable Places API (New) + Weather API),
  `airnow-api-key.json` or `AIRNOW_API_KEY` (official historical reporting-area AQI),
  `gh-data-token.json` or `GH_DATA_TOKEN` (history playback and recording use the private data branch),
  `ai-gateway-key.json` or `.env.local` via `vercel env pull` (concierge agent LLM;
  on Vercel deployments the OIDC token is automatic — enable AI Gateway on the project).
  `BLOB_READ_WRITE_TOKEN` (Concierge usage logging → private `agent-logs` Blob store;
  auto-provisioned on the project, in `.env.local` after a pull) and `AGENT_LOG_KEY`
  (gate for `/api/agent-log`).
  Missing keys degrade gracefully (empty feeds; agent replies 503; logging no-ops), nothing crashes.
  **NEVER log, commit, or echo these values.**
- Syntax-check server code before pushing: `node -e "require('./lib/api-core.js')"`.
- Client testing hooks (browser console):
  - `window.__moduleError` — module-level errors are UNHANDLED REJECTIONS under
    top-level await; this hook catches them. Check it FIRST after any change.
    (Ignore OrbitControls `setPointerCapture` noise.)
  - `window.__cam(px,py,pz,tx,ty,tz)` jump camera · `window.__fly` · `window.__dbg` (needs `#dbg` hash)
  - `window.__buses / __cams / __citibike / __timeline / __audit` (audit = land/coast/graph predicates)
  - URL hash driver: `#cam=…&tgt=…&mode=live&q=high&scrub=-1440&faketime=<ms>&fakeweather=<json>&snap`
- Verify visually before pushing (screenshot at a few presets; keys 0–6 are camera presets).
- **Headless/preview-pane browser gotchas** (agent harnesses): (1) the page sees
  `document.visibilityState === 'hidden'` → liveBridge pauses ALL live polling, so
  feeds/City-Vitals stay 0/0 and `subway.trips` stays empty no matter how long you
  wait — screenshots pump a frame or two but never enough to poll; test live-data UI
  in a real visible tab, or drive state through the modules' exported `hist()`/dev
  hooks. (2) reloads happily serve a cached `index.html` — cache-bust with `/?v=<n>`
  after every edit before trusting what you see. (3) camera tweens/mode blends don't
  advance without frames — use `window.__cam(...)` jumps or the `#cam=…&snap` hash
  driver for screenshots.
- **Smoke counts before pushing** — after ANY change to shared data shapes (street graph,
  blocks, persona tables) or the load path, check in the console after a full load:
  `__personas.list.length` ≈ 12,700 (≈ half that on `low` tier), `__traffic.total` > 10,000,
  `matchStreet(300, 6800, 200)` returns an object, `__perfReport()` runs clean. A 2026-07-13
  regression shipped a ONE-resident city because a data-shape refactor left stale variable
  references in a consumer further down the file: `node --check` can't catch undeclared
  identifiers (runtime ReferenceError, not a parse error), and the error died inside a
  promise `.catch` — only the counts betrayed it.
- **When you change a shared data structure's shape**, grep EVERY consumer of it and read
  each use site to its end — including code BELOW the lines you edited in the same block.
  Verify each consumer's feature actually runs afterward, not just the ones easy to see.

## THE IRON RULES (violating these has burned days of work)

1. **Frozen calibration.** All geo→scene goes through one pipeline: `geoToWorld`
   (Battery anchor, 29° rotation) then `zs = z*0.9877 + 354`, `xs = x*0.86 + XSHIFT`
   (piecewise). Client-side, use `subway.geoRaw(lat, lon)` — NOT `geoToWorld` directly
   (it drifts 2.6 km at JFK). Never re-derive, never "fix" the constants. All baked
   assets (streets/blocks/buildings/coast) already went through it.
2. **Nothing renders on water.** Gate any new ground-level placement with
   `landOK(x, z)` (module-scope helper; also `onLand`). Water incidents are regressions
   the user notices immediately.
3. **The mirror.** The canvas renders `scaleX(-1)` (so the map reads like a real map).
   Pointer events are re-mirrored by a shim, so event `clientX` is already camera-space;
   visual screen x = `innerWidth − cameraSpaceX`. Any new picking/labels must follow the
   existing patterns (see cams/ferry chip code).
4. **`pushPoly` ground polys render BLACK** (unresolved). Large flat ground = stacked
   `pushBoxG` slabs (see the 19e airport aprons).
5. **History gating.** Global `HIST = {active, day, epochS, liveWx}`. Every live module
   gates BOTH poll scheduling AND stale-eviction on `!HIST.active`, and exposes
   `hist(rows|null)` (replay through its own ingest; null = purge + resume). If you add
   a live layer, follow this contract AND add the field to `api/record.js` +
   `scripts/record.mjs` so it gets recorded.
6. **`.fybl` chips** are `display:none` in base CSS — set `style.display='block'`.
7. **Never push `.github/workflows/`** from this machine (git token lacks `workflow`
   scope; pushes get rejected). Scheduling belongs in Vercel cron (`vercel.json`).

## Street graph schema (`public/streets.json`) — the spatial substrate

Edges `E[i] = {pid, nm, bo, rw, w, ln, td, a, b, p}`: `nm` name, `bo` borough,
`rw` 0 street / 1 highway / 2 bridge / 3 ramp / 4 tunnel (tunnels not drawn),
`td` 1 a→b / 2 b→a / 3 two-way, `a`/`b` node ids. **`p` is a flat stride-2
Float32Array** (repacked at load from the JSON's `[x,z]…` pairs — plan-mobile-memory.md
M2): read `x = p[2i]`, `z = p[2i+1]`, point count `p.length >> 1`; `matchStreet`'s `seg`
is a POINT index (segment i spans `p[2i..2i+3]`). The JSON on disk keeps the nested-pair
shape (the server agent reads it directly).
Nodes `N[j] = [x, z, edgeIds…]`. Runtime helpers (module scope):
`matchStreet(x, z, maxD, wantAng)` snap to best edge · `nearestNode(x, z, maxD)` ·
`EDGE_HASH` 200 m cells. **Join keys** every live entity carries (agent-ready):
buses `edgeId/edgeT/street`, cameras `nodeId`, bike stations `node`. Preserve these
in anything you build — a future spatial-intelligence agent queries by them.

## Live data flow

Client polls same-origin `/api/*`; `lib/api-core.js` owns upstream cadence + caching
(flights 20s w/ 4-source fallback chain, subway 20s, ferries/buses 15s, citibike 30s,
weather 5m NWS, cams list 10m). To add an endpoint: write `fetchThing()` returning the
payload, register `makeCachedRoute('/api/thing', ttl, fetchThing, emptyShape)` — both
local server and Vercel pick it up automatically.

History: `/api/history` (manifest), `/api/history/:day` (daily city), and `/api/history/air-quality/:day` (packed hourly NYCCAS + official daily AirNow) proxy the `data` branch. City snapshots retain seven days; Air Quality retains 30.
Timeline module in index.html replays snapshots through each module's `hist()`; while Air Quality is selected, AQ snaps to exact hourly frames and all other layers use the labeled nearest daily city snapshot.

## Changelog (CHANGELOG.md)

Every USER-VISIBLE feature you ship gets an entry at the TOP of `CHANGELOG.md`, in the
same commit or push as the feature. Internal refactors, data bakes, and fixes don't.

Required per entry, in this order:
1. `## <emoji> Title` — short, user-facing name
2. `**Shipped:** <Month D, YYYY>` — the date the feature reached production
3. `**TL;DR:**` — one or two sentences on what it does
4. `**What you'll see:**` — concrete, observable behavior (numbers, examples of real
   chip/UI text, keys/buttons). No marketing fluff; if a follow-up commit changes the
   behavior materially, update the entry rather than appending a correction.
5. `**How it works:**` — the mechanism in a paragraph, with **links to every external
   data source** used, and honest caveats (data cadence, confidence flags, what the
   visualization does and doesn't represent). Credit data providers by name.

Style: match the existing entries — plain prose, concrete examples over adjectives,
state what a visualization *represents* (see the Birds entry's "radar measurement,
not tracked individuals" framing — that standard applies to every layer).

## Working in parallel with another agent

- `public/index.html` is ONE FILE and the other agent edits it too. **Coordinate scope
  with the user before starting**, keep diffs surgical, and `git pull --rebase` before
  every push. Do not reformat, renumber sections, or touch code outside your feature.
- `git pull --rebase` refuses on a dirty tree — `git stash push -u` your files first,
  rebase, pop. **Stage files EXPLICITLY, never `git add -A` / `git add .`**: the tree
  routinely holds other sessions' untracked plan docs and git-ignored-but-present
  secret files, and one careless add has swept up foreign WIP before.
- Section numbers (4b graph, 19b–e boroughs/airports, 25c–e cams/buses/citibike,
  26c fly/hash) are load-bearing landmarks in commit messages and docs — keep them.
- Match the existing style: dense, comment-where-nonobvious, no frameworks, no deps.
  Budgets matter (draw calls, one InstancedMesh per fleet). Test before pushing —
  every push deploys to the public URL.
