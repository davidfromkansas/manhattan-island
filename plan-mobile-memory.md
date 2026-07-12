# Task: Mobile memory diet — fit the full-city build back inside iOS Safari's budget

Audience: a coding agent joining this repo. Read `AGENTS.md` first — the Iron Rules
(frozen calibration, `landOK`, THE MIRROR, parallel-work discipline) all apply.
Anchors below were verified against the working tree on 2026-07-12; line numbers drift —
re-verify with grep before editing. **Coordination warning:** the DCP chunk-streaming
system (workstreams M1/M3/M4 here) is the active territory of a parallel agent
(box-LOD blanket, south Brooklyn build, `plan-shoreline.md`). Coordinate scope with the
user before starting M1/M3/M4; M0 and M2 are cleanly separable and safe to start alone.

---

## For the non-technical reader: what is this and why now?

The city recently got much bigger on phones — real building massing for all of
Manhattan and Brooklyn, plus a "box city" blanket so distant neighborhoods are never
flat. On 2026-07-12 the user's iPhone showed the cost: the 3D scene went **black** after
loading (iOS quietly kills the graphics context when a tab uses too much memory) and
buttons lost their paint. We shipped a band-aid the same day — the page now notices the
blackout and reloads itself — but the real fix is using less memory in the first place.

**The good news:** none of the memory is buying features. It's *representation waste* —
the same geometry stored twice (once for the GPU, once forgotten in JavaScript), numbers
stored at double the precision the eye can see, and a street map kept as millions of tiny
JavaScript objects instead of a few dense arrays. Every fix in this plan keeps every
feature and every pixel: same city, same live layers, same concierge, same picking —
just packed properly. This repo has done exactly this before and measured it
(PERF.md C2a/C2b took the app from crashing phones to running on them); the city has
since outgrown that fix, so this is round two.

## Goal (technical)

Cut mobile resident memory enough that iOS Safari stops shedding the WebGL context with
the full LOD blanket + full-Manhattan build resident — target **≥100 MB reduction**
(measured, not estimated) with byte-identical scene stats and zero feature changes.

## Acceptance bar (test end-to-end when done)

- `#dbg` overlay reports the new memory line; a **measured phone baseline row exists in
  PERF.md before any optimization lands** (the repo's rule: no unmeasured wins).
- Scene stats byte-identical after each workstream (draw calls, tris, buildings count —
  same gates C2b used), visual checks at noon downtown + dusk canyon (window ignition).
- Concierge spatial queries, bus/street snapping, timeline replay, resident picking all
  behave identically (M2 touches the street graph's representation, not its API).
- On-device: the user's iPhone loads to the live scene and **survives 10 minutes of
  flying without a context-loss reload** (the `glLost` sessionStorage flag from e0b96f8
  stays unset).

## What already exists (do not rebuild)

| Anchor (grep, don't trust line #s) | What it is |
|---|---|
| PERF.md C2a/C2b (measurements table) | The playbook: typed sinks (peak −343 MB), attribute compression 44→23 B/vertex + `onUpload(disposeArray)` (settle 517→86 MB). The procedural city is DONE — don't touch it. |
| `sinkToGeometry` — `.onUpload(disposeArray)` on every attribute (~2394–2404) | The exact pattern M1 copies to the chunk path |
| `decodeBakedMesh` (~1401) + `dcp-worker.js` | Chunk decode: u16 positions dequantized to Float32, **Float32 normals computed in the worker**, transferred to main thread |
| DCP worker `onmessage` geometry build (~1444–1459) | Builds `BufferAttribute`s from the transferred arrays — **no `onUpload`, CPU copies retained forever** (the M1 target) |
| `DCP_CAP = 16, DCP_KEEP = 4, DCP_LOD_CAP = 44` (mobile: LOD cap opened to 64, "blanket") (~1466) | The chunk budget knobs M3 makes pressure-adaptive |
| PERF.md C2c design notes ("kept below in case future data growth reopens the budget") | The `streets.bin` typed-array bake M2 implements — the budget HAS reopened |
| `E[i] = {pid, nm, bo, rw, w, ln, td, a, b, p}` + `N[j]` + `EDGE_HASH` (AGENTS.md schema; built from `streets.json`, 12.3 MB) | The street graph M2 re-backs with typed views — its ACCESSOR API must not change (join keys are agent-facing) |
| `webglcontextlost` auto-reload + `glLost` sessionStorage guard (commit e0b96f8) | The pressure SIGNAL M3 consumes |
| `#dbg` overlay block in `frame()` (`fps`, `calls`, `tris`, `geom`) | Where M0 adds the memory line |
| `fetchJP` single-file streaming (commit e0b96f8) | Startup transient already reduced — leave |
| Data on disk: `*.bin` 310 MB total (full chunks, 3 resident on mobile), `*.lod.bin` 32 MB total (blanket streams up to 64), streets.json 12.3 MB, buildings.json 11.2 MB (released post-gen), blocks.json 3.6 MB | The inputs |

## Where the memory goes (ESTIMATES — M0 replaces these with measurements)

1. **Chunk meshes, CPU side (~50–100 MB):** every loaded chunk retains its Float32
   position + Float32 normal + color + index arrays in JS heap after GPU upload,
   because the worker path never got C2b's `onUpload(disposeArray)`.
2. **Chunk meshes, GPU side (~60–100 MB):** Float32 normals are 12 B/vertex (the
   procedural city uses Int8 = 3 B); positions are Float32 though the source data is
   u16.
3. **Street graph (~60–120 MB JS heap):** 86,471 edge objects × nested `[[x,z],…]`
   polylines + 57,450 node arrays — per-object/per-array overhead dominates the data.
4. Everything else (blocks graph, personas, live layers) is second-order; the
   procedural city itself settles at ~86 MB (C2b, measured).

## Key metrics — the before/after scorecard

Every workstream is judged against these. Capture the FULL set at baseline (M0) and
after each landing; add rows to PERF.md's measurements table. All of them come from one
new console call, `window.__perfReport()` (built in M0), so a capture is copy-paste.

**Comparability rules:** same scripted 60 s fly route (a `__cam` waypoint sequence
scripted in M0 — hero → Midtown street level → Brooklyn pan → Queens, exercising chunk
streaming), same `#faketime` hash (fixed sun/weather), `#q=low` for the mobile-sim rows,
live layers left ON (they're part of real load). Three environments per capture:
desktop `high`, desktop `low`-sim, the user's iPhone.

### Memory (primary — the budget that's breaking)

| Metric | How measured | Baseline | Target |
|---|---|---|---|
| Settled JS heap after 60 s route | `performance.memory.usedJSHeapSize` (Chrome; iOS lacks it — use the proxies below) | M0 | **−100 MB+** (M1+M2 combined) |
| Peak JS heap during load | same, sampled every 500 ms from the inline boot script until first frame | M0 | no regression; M2 should cut it |
| Chunk CPU-resident bytes | Σ `attribute.array.byteLength` over `DCP_CHUNKS` meshes (in `__perfReport`) | M0 (est. 50–100 MB) | **≈ 0** after M1a |
| Chunk GPU bytes (est.) | Σ uploaded attribute+index byteLength at upload time (counter in the worker-geometry build) | M0 (est. 60–100 MB) | **−60%+** after M1b/c |
| Street-graph heap | heap delta around graph build (sample before/after in the module) | M0 (est. 60–120 MB) | **−80%+** after M2 |
| Context losses per session (iPhone) | `glLost` flag occurrences, counted into `localStorage.glLossCount` | M0 | **0** over a 10-min session |

### Performance (must not regress — parity gates)

| Metric | How measured | Target |
|---|---|---|
| Steady fps on the route | existing `#dbg` fps (min/avg over the route, recorded by `__perfReport`) | ≥ baseline |
| Frame-time p95 / max (pan hitch) | rAF delta histogram during the route's Brooklyn pan (chunk-streaming stress) | ≤ baseline (M1 moves less data → should improve) |
| Draw calls / tris / buildings | existing `#dbg` (`renderer.info`) | **byte-identical** (C2b-style gate) |
| Chunk decode latency | per-chunk `postMessage → onmessage` ms, avg + p95 (timestamp in `DCP_PEND`) | ≤ baseline (M1b shrinks the transfer) |
| Street-query latency | 1,000-call `matchStreet`/`nearestNode` microbench, ms total (the M2 sanity harness doubles as this) | within ±10% of JSON-backed baseline |

### Latency (load — what the user waits for)

| Metric | How measured | Target |
|---|---|---|
| Time to first frame | `performance.now()` at the one-shot `done()` in `frame()` (hook exists from the boot bar) | **−3 s+ on phone** after M2 (no 12 MB JSON parse) |
| Download-complete milestone | timestamp when the boot bar passes 0.45 (already instrumented via `__gbaBoot.p`) | ≤ baseline (M2 swaps JSON for a smaller .bin) |
| Generation-complete milestone | timestamp at the 0.93 `bootStep` | ≤ baseline |
| Time to full LOD blanket | first moment all rank-eligible `.lod.bin` chunks are `state:'loaded'` | ≤ baseline |

### Scalability (the numbers that decide how much more city fits)

| Metric | How measured | Why it matters |
|---|---|---|
| Marginal bytes per LOD chunk (CPU + GPU) | chunk-bytes counters ÷ resident LOD count | THE scaling number: adding a borough costs N chunks × this. M1 shrinks it ~4–8× |
| Marginal bytes per FULL chunk | same, full-detail chunks | bounds `DCP_CAP` headroom |
| Street-graph bytes per edge | graph heap ÷ 86,471 | M2 turns per-edge cost from ~1 KB of object graph into ~50 B of typed array — future borough street data scales at the new rate |
| iPhone chunk headroom | on-device: raise `DCP_LOD_CAP` stepwise (`#dbg` + console) until memory pressure symptoms; record the ceiling | before/after headroom is the plan's bottom-line proof — target ≥ 2× baseline ceiling |
| Load-time growth per registered chunk | time-to-first-frame vs `DCP_CHUNKS.length` (compare against a build with south Brooklyn registered) | must stay O(1) — registration is metadata; streaming is rank-capped |

## Workstreams

### M0. Measure first (small; do this before ANY optimization)

- Add to the `#dbg` overlay: `mem <JS heap MB (performance.memory, Chrome-only)> ·
  gpuGeo <renderer.info.memory.geometries> · chunks <full>/<lod>` — cheap strings,
  only while `#dbg` is open.
- Build `window.__perfReport()`: returns one JSON blob with every metric above that's
  cheaply readable (heap, chunk CPU/GPU byte counters, fps stats since last call,
  frame-time histogram, boot milestone timestamps, decode-latency stats, loss count).
  Add the two counters it needs: uploaded-bytes tally in the worker-geometry build,
  decode timestamps in `DCP_PEND`.
- Script the 60 s capture route as a dev-only helper (`window.__perfRoute()` — a
  `__cam` waypoint sequence + `__perfReport()` dump at the end), so any agent or the
  user can produce a comparable row in one console call.
- Capture the baseline in all three environments (desktop `high`, desktop `low`-sim,
  the user's iPhone — ask them to run `__perfRoute()` and paste the blob). Add the
  rows to PERF.md's measurements table.

### M1. Chunk attribute diet (biggest win, smallest diff — COORDINATE with the parallel agent)

All in the worker `onmessage` geometry build + `dcp-worker.js`; the bake format and
`.bin` files are untouched. Apply equally to `decodeBakedMesh` (the 3 always-resident
landmark meshes).

- **M1a — free CPU mirrors:** add `.onUpload(disposeArray)` to every chunk
  `BufferAttribute` (position, normal, color, seed, kind, index), after computing the
  bounding box for `proc` chunks while positions still exist (same ordering trick
  `sinkToGeometry` documents). There is no raycaster in this app (picking is
  projection-based) and chunk disposal drops the whole geometry, so the CPU copies are
  pure waste. Expected: chunk-resident JS heap → ~0.
- **M1b — Int8 normals:** the worker already computes Float32 normals; normalize and
  emit `Int8Array` (×127) instead, wire as `new THREE.BufferAttribute(nor8, 3, true)`.
  12 → 3 B/vertex on the GPU (and on the transfer). C2b proved this imperceptible on
  the same Lambert material family.
- **M1c (optional, LOD blanket only) — drop the normal attribute entirely:** LOD boxes
  are axis-aligned massing; flat normals can be derived in-shader via
  `dFdx/dFdy` (WebGL2) in a `DCP_MAT_LOD`-only patch. Saves the whole normal attribute
  for up to 64 chunks. Gate behind a program-cache-key variant exactly like the
  `maskOn` pattern so other materials compile byte-identically. Skip if M1a+M1b
  already clear the budget.
- **M1d (optional, deeper) — u16 positions on the GPU:** upload the baked `Uint16Array`
  raw and dequantize in the vertex shader. CAVEAT: needs per-chunk `scale/offset`
  uniforms on a SHARED material → per-mesh `onBeforeRender` uniform writes or material
  clones (breaks the one-material batching discipline). Only attempt if M0 shows
  position bytes still matter after M1a–c.

**Verify:** scene stats byte-identical; noon/dusk visual gates; fly Manhattan → Brooklyn
→ Queens with `#dbg` open — chunk CPU bytes ~0, gpuGeo stable; `window.__moduleError`
clean; phone retest.

### M2. `streets.bin` — the C2c binary bake (separable; safe to start now)

Implement PERF.md's shelved C2c design, updated for today's consumers:

- **Bake script** (`scripts/bake_streets.py` or extend the existing offline bake
  pipeline): emit `streets.bin` = header + flat `Float32Array` of all polyline points +
  per-edge `Int32` table (point offset/count, node a/b, packed `bo/rw/td`, width,
  length, name-index) + node table (x, z, edge-list offsets) + deduped name string
  table. Keep `streets.json` regenerating from the same source (the server-side agent
  substrate in `lib/agent-core.js` still reads JSON — zero server changes).
- **Client:** fetch as `ArrayBuffer` (no JSON parse, no boot-bar change needed — it
  rides `fetchJP`'s plain path). Build `E`/`N` as **accessor objects over typed views**:
  `E[i].p` returns a subarray view (or a tiny cursor API for the two hot consumers,
  `matchStreet`/`nearestNode`). **The public shape must not change** — buses carry
  `edgeId/edgeT/street`, cameras `nodeId`, bikes `node` (AGENTS.md join keys), and the
  concierge queries by them.
- Sanity harness: with `#dbg` hash, compare 1,000 random `matchStreet`/`nearestNode`
  results old-vs-new (run once against a JSON build, once against the bin build) —
  identical ids/params required.

**Verify:** bus map-matching visually identical (buses glued to streets), camera nodes
land, concierge `near`/street queries answer identically, heap delta recorded in
PERF.md. Expected: −60–100 MB heap + several seconds off mobile load.

### M3. Pressure-adaptive chunk budget (small; builds on e0b96f8 — COORDINATE)

- On boot, read the `glLost` sessionStorage flag (set only when a context loss forced a
  reload): if present, start `DCP_LOD_CAP` and `DCP_CAP` at half, and persist a
  `memPressure` localStorage tier so the *next* cold start also begins conservative.
- If a session runs 5 minutes clean, step the caps back up one notch (and clear the
  tier when back at full). Features identical on healthy devices; struggling devices
  converge to a budget they can hold instead of reload-looping at full.
- Keep the logic beside `streamDcpChunks` where `_dcpTierSet` already does lazy tier
  reads.

**Verify:** simulate via `WEBGL_lose_context` (the e0b96f8 test recipe): forced loss →
reload → caps halved → 5-min clean run → caps restored.

### M4. Instanced LOD massing (only if M0 after M1–M3 says it's still needed)

Replace per-chunk LOD triangle meshes with one `InstancedMesh` of unit cubes
(~28 B/box: xz, y-scale, footprint, yaw) fed from a tiny per-chunk footprint list.
Cuts memory AND up to 64 draw calls, but it's a bake-format + streaming rework in the
parallel agent's most active code — treat as their call, listed here for completeness.

## Order, commits, parallel work

1. **M0** first, one commit ("Add memory readout + mobile baseline row") — no behavior
   change, safe anytime.
2. **M2** next if the DCP area is still contended (it's independent); otherwise **M1a**
   (one small commit, huge win) → M1b → measure → decide on M1c/d.
3. **M3** after M1 lands (its caps interact with M1's savings).
4. Re-measure after each landing; add PERF.md rows. Every push deploys — visual gates
   before each push, `git pull --rebase` always (the shared-tree collisions this
   session hit are documented in the git history: keep commits surgical).

## Iron-rule compliance

1. **Frozen calibration** — untouched; M2 re-encodes already-calibrated coordinates
   verbatim (Float32 in, Float32 out).
2. **`landOK`** — consumes the street graph via the same accessors; M2 must keep it
   bit-identical (covered by the sanity harness).
3. **THE MIRROR** — no pointer/projection changes anywhere.
4. **No `pushPoly`** — n/a.
5. **History gating** — untouched; replay reads live-layer modules, not geometry.
6. **`.fybl`** — n/a.
7. **No `.github/workflows/`** — bake runs offline like the existing DCP pipeline.
8. **CHANGELOG** — internal perf work: NO changelog entry (per AGENTS.md, refactors
   and fixes don't get entries) unless a user-visible behavior ships (M3's adaptive
   quality arguably qualifies — decide with the user).

## Explicitly out of scope

- Reducing feature or visual fidelity (fewer chunks, lower DPR, fewer personas, shorter
  draw distance) — the point is parity.
- Server/API changes, data-source changes, the recorder.
- The procedural city sinks (C2a/C2b territory — already optimal).
- Texture compression (KTX2) — few textures here; revisit only if M0 fingers them.
