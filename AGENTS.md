# Agent Onboarding — manhattan-island (NYC Live Digital Twin)

You are joining an existing codebase as a second agent working in parallel with another
agent. Read this whole file before writing code. Precision matters here: most of this
scene is generated from surveyed city data through a frozen calibration, and casual
edits in the wrong place corrupt geography.

## What this is

A self-contained Three.js digital twin of NYC (Manhattan fully built; Brooklyn, LIC/
Astoria waterfront, South Bronx, Roosevelt + Governors Islands, LGA + JFK) with LIVE
data layers: flights, subway, NYC Ferry, MTA buses, Citi Bike, traffic cameras, weather
— all map-matched onto the real street graph. A nightly recorder snapshots the whole
city state; a timeline slider scrubs the city back through the last 7 days.

- **Repo**: `github.com/davidfromkansas/manhattan-island` (private). Pull `main`.
  `git clone git@github.com:davidfromkansas/manhattan-island.git`
- **Prod**: https://manhattan-island-davidlietjauw-7177s-projects.vercel.app
  (Vercel auto-deploys every push to `main` — a push IS a deploy; don't push broken code)
- **`data` branch**: orphan branch holding recorded daily snapshots
  (`data/daily/YYYY-MM-DD.json` + `manifest.json`). Written by the nightly cron.
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
| `scripts/record.mjs` | Manual/local recorder (same frame format) |
| `public/streets.json` | Real street graph: 86,471 CSCL edges + 57,450 nodes (see schema below) |
| `public/blocks.json` | 27,257 real city-block faces |
| `public/buildings.json` | 304,911 real building footprint boxes (BIN ids) |

## Run + test locally

```bash
node server.js            # http://localhost:4173 — that's it, no install
```
- Secrets live in git-ignored root files (ask the user if you don't have them):
  `opensky-credentials.json` (flights), `mta-bus-key.json` (buses),
  `gh-data-token.json` (history playback reads the private data branch),
  `ai-gateway-key.json` or `.env.local` via `vercel env pull` (concierge agent LLM;
  on Vercel deployments the OIDC token is automatic — enable AI Gateway on the project).
  Missing keys degrade gracefully (empty feeds; agent replies 503), nothing crashes.
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
`td` 1 a→b / 2 b→a / 3 two-way, `a`/`b` node ids, `p` polyline `[x,z]…`.
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

History: `/api/history` (manifest) + `/api/history/:day` proxy the `data` branch.
Timeline module in index.html replays snapshots through each module's `hist()`.

## Working in parallel with another agent

- `public/index.html` is ONE FILE and the other agent edits it too. **Coordinate scope
  with the user before starting**, keep diffs surgical, and `git pull --rebase` before
  every push. Do not reformat, renumber sections, or touch code outside your feature.
- Section numbers (4b graph, 19b–e boroughs/airports, 25c–e cams/buses/citibike,
  26c fly/hash) are load-bearing landmarks in commit messages and docs — keep them.
- Match the existing style: dense, comment-where-nonobvious, no frameworks, no deps.
  Budgets matter (draw calls, one InstancedMesh per fleet). Test before pushing —
  every push deploys to the public URL.
