# Changelog

User-visible features, newest first. Format per entry: **Title · date shipped · TL;DR ·
What you'll see · How it works** (with source links). See AGENTS.md → "Changelog" for
the rules on adding entries.

---

## ⚡ The twin now runs on phones — and everything got faster

**Shipped:** July 8, 2026

**TL;DR:** A five-part performance program (tracked in `PERF.md`) fixed the mobile
crash and cut latency across the board: the app's resident memory dropped from
517 MB to 86 MB, live-data requests are served from the CDN edge in ~60 ms, and the
heaviest per-frame work shrank by a third — with desktop visuals byte-identical.

**What you'll see:**
- **Mobile Safari and Chrome now load and run the full twin** (previously the tab
  crashed). Phones auto-select the existing "Low" quality preset — fewer effects,
  same city, same live data; the quality dropdown still overrides.
- Snappier live data everywhere: feed updates arrive from Vercel's edge cache in
  ~55–65 ms instead of 80 ms–3 s of function/upstream time, and the page makes 4
  network requests per minute instead of ~18.
- Smoother frames, especially close to the street: distant ambient traffic updates
  its pose less often (same speed, no drift), cutting the biggest per-frame CPU cost
  by ~38%; live vehicles with chips (buses, trains, ferries) are untouched.

**How it works:** measured, not guessed — heap probes traced the crash to two causes
and the plan changed twice accordingly. (1) The merged-city geometry builders held
~870 MB of temporary JS arrays during construction → they now write straight into
typed arrays. (2) three.js keeps a CPU copy of every vertex attribute forever and the
city cost 44 bytes/vertex on CPU and GPU → normals/colors/flags are now 8-bit
(window-light patterns bit-identical; albedo steps of 1/255) and the CPU copies are
freed the moment the GPU has them: 23 bytes/vertex and an 86 MB resident heap.
Latency: every live feed response now carries CDN cache headers tuned to its own
refresh rate (`stale-while-revalidate` keeps serving instantly while refreshing), and
one Web Worker polls a consolidated `/api/live` snapshot and parses it off the main
thread — so adding a future data source is one field in a snapshot, not another
poller. Honest caveats: an edge-served update can be up to ~1 minute stale (motion
stays smooth — positions dead-reckon from the data's own timestamp); phones trade
shadows/antialiasing for stability; total bandwidth is unchanged (the wins are
request count and main-thread time).

---

## 🎯 Focus Mode + agent click-context

**Shipped:** July 7, 2026

**TL;DR:** Click any dialogue in the scene and two things happen: every other dialogue
steps back so you can concentrate on the one you chose, and the City Concierge learns
what you're following so questions like "what am I looking at?" answer themselves.

**What you'll see:**
- Clicking any entity chip — a bus, subway train, ferry, aircraft, bird flock, Citi Bike
  station, traffic reading, or a concierge map pin — hides all other chips, labels, and
  UI chrome. One pinned dialogue remains, tracking its entity as it moves; only the
  weather chip and the concierge stay alongside it.
- Release by clicking anywhere on the scene, scrolling, pressing **Esc**, or clicking
  the pinned chip (it says so on the chip). Everything returns instantly.
- Citi Bike stations and traffic readings are newly clickable (stations get a gentle
  camera dive; readings pin in place). The traffic-camera video viewer keeps its own
  window and is not part of focus mode.
- Ask the concierge "what am I following?" after any click and it answers with the
  exact entity and its live numbers — for up to 15 minutes after the click, even after
  you've released the visual focus.
- The concierge also knows the borough and neighborhood the clicked thing is *in* — and
  keeps it correct as the entity moves. Click a bus in Brooklyn while the camera sits
  over Manhattan and "what neighborhood is this bus in?" answers "Williamsburg, Brooklyn"
  — the entity's real location, not the camera's.

**How it works:** every dialogue click records a focus snapshot (kind, label, and the
entity's current data — e.g. a flock's radar estimate or a bus's route/street/speed),
plus a live handle on the entity's position. The snapshot rides along invisibly with
each concierge request, where the server sanitizes it and appends a "user is following:
… — currently in <neighborhood>, <borough>" line to the model's context; the region is
recomputed from the entity's own position each turn (point-in-polygon against the
boundary set), so it tracks a moving vehicle. The visual side is a single tracked
overlay chip plus a body-level CSS state that hides everything else; releasing the focus
never discards the agent context.

---

## 🗺️ Borough & neighborhood boundaries

**Shipped:** July 7, 2026

**TL;DR:** The whole simulation now knows its 5 boroughs and 262 real NYC
neighborhoods. The City Concierge can outline any of them on the map and tell you
which one you're looking at.

**What you'll see:**
- "Outline the Bronx" or "show me the border of Williamsburg" draws the real region
  boundary — a bright outline with a faint colored wash filling the area and the
  region's name labeled at its center — then frames it (staying under the cloud deck
  so a whole borough is still visible). The "✕ layer" chip clears it.
- "What neighborhood am I looking at?" answers from where the camera is pointed
  ("Midtown-Times Square, Manhattan"); "what neighborhood is the Brooklyn Bridge in?"
  works for any place. Names fuzzy-match, so "Times Square" or "Upper East Side"
  resolve to their full NTA names.
- The concierge now has borough + neighborhood context on every question, so answers
  can be more place-aware.

**How it works:** boundaries come from NYC City Planning's official
[Borough Boundaries](https://data.cityofnewyork.us/City-Government/Borough-Boundaries/gthc-hcne)
and [2020 Neighborhood Tabulation Areas](https://data.cityofnewyork.us/City-Government/2020-Neighborhood-Tabulation-Areas-NTAs-/9nt8-h7nd)
(NTAs — the city's standard neighborhood geography, aggregated from 2020 census
tracts), simplified and baked to `public/boundaries.json` as lon/lat rings. The
client projects them into the scene through the same frozen calibration every live
entity uses, so a boundary lands where the streets and buildings are. The agent
reasons about regions with point-in-polygon tests; NTA neighborhoods include a few
named parks/airports/cemeteries (e.g. Central Park, JFK) alongside residential areas.
Boundaries follow real administrative lines and are simplified for display, so they
trace the neighborhood, not every zigzag of the shoreline.

---

## ✦ City Concierge — a spatial-intelligence agent for the twin

**Shipped:** July 7, 2026

**TL;DR:** A chat agent (✦ button, bottom-right) that answers questions from the twin's
own live data, flies the camera anywhere on request, draws query results directly on the
3D map as pins/rings/highlighted streets, and can rewind the whole city through the
7-day archive.

**What you'll see:**
- A ✦ button bottom-right opens the chat; the ⓘ button lists ~20 tap-to-try examples in
  seven groups (live questions, camera flights, map layers, spatial search, buffers,
  buildings/streets, time travel).
- "Zoom in on Times Square" flies there; "street level at the Brooklyn Bridge, looking
  at Manhattan" lands a low camera aimed the right way.
- Zooming into a specific place draws a glowing gold boundary on the ground around the
  framed area — "highlight the area around Times Square" outlines a ~450 m circle,
  "highlight Central Park" a ~1,600 m one. Broad overviews (the whole island) don't get
  a boundary; the "✕ layer" chip clears it.
- "Map the 5 slowest roads in Manhattan" drops labeled pins ("FDR N 25th–63rd St ·
  15.5 mph") and auto-frames them; "highlight Broadway end to end" draws all ~400 street
  segments; "ring every closure with a 250 m buffer" adds circles. A "✕ layer" chip in
  the panel header clears the drawing; clicking a pin's label dives to it.
- "Tallest building near Wall St & Broad St" answers from the real footprint data
  (325 m) and pins it; "how many bike docks within 300 m of each East River ferry?"
  returns per-stop counts.
- "Show me the city 3 days ago" scrubs the timeline; "back to live" returns.
- After clicking any chip in the scene, "tell me about this bus/train/boat" just works
  (focus context, see the Focus Mode entry).

**How it works:** the browser sends the conversation to `/api/agent`, where a
tool-using LLM (Anthropic Claude via [Vercel AI Gateway](https://vercel.com/docs/ai-gateway))
runs read-only queries against the twin's own cached feeds (the same flights/subway/
ferries/buses/Citi Bike/traffic/weather/BirdCast data the scene renders, each credited
in its own entry), the baked NYC street graph (86k drivable [CSCL](https://data.cityofnewyork.us/City-Government/NYC-Street-Centerline-CSCL-/exjm-f27b)
segments) and [building footprints](https://data.cityofnewyork.us/City-Government/Building-Footprints/5zhs-2jue)
(305k boxes with real heights), plus the recorded daily snapshots. The model never
touches the scene: it returns validated *intents* — camera target, map layers, timeline
scrub — that the browser applies. Honest caveats: answers come only from the data above
(no web knowledge about businesses or events); individual monuments aren't modeled, so
the camera shows the real massing of the area instead; time travel snaps to one
snapshot per day (~1 am ET); street questions use the drivable network, so pedestrian
plazas (e.g. Broadway through Times Square) are genuinely absent; usage is rate-limited
per visitor (8 messages/min, 60/day) to bound costs.

---

## 🐦 Live bird migration (BirdCast radar), citywide

**Shipped:** July 7, 2026

**TL;DR:** Real-time bird migration rendered as 3D flocks over all four built
boroughs — Manhattan, Brooklyn, Queens, and the South Bronx — each flying the
direction, speed, and altitude that weather radar is measuring for that county
right now.

**What you'll see:**
- Flock size tracks the radar count: a quiet July afternoon renders a handful of
  birds; a 25,000-bird migration night hits the 600-bird cap. Each borough's birds
  fly *that county's* measured heading and speed in its measured altitude band
  (typically 400–700 m — above everything but the supertalls). ~40% travel in
  V-formations that bank together; the rest fly solo; wings alternate between
  flapping and gliding.
- Flock chips state exactly what a flock is: *"Migration radar · Queens — ≈96 birds
  aloft (radar est.) · ~431 m · S 15 mph"*, plus *"daytime — low confidence"*
  whenever BirdCast's own quality flag says the reading is noise-tier. A flock is a
  visualization of one radar measurement — not tracked individuals, and not a count
  of the borough's birds (perched and low-flying birds are invisible to radar).
- Click a flock chip to glide in and ride along with the stream. The **Birds**
  preset button (key **7**) flies you to wherever the flock currently is.
- At 500+ birds aloft the weather chip shows the citywide count; past 2,000
  crossings it adds the running nightly total and, once a week of history has
  accumulated, a percentile rank (*"48,200 crossed tonight (94th pctile)"*).
- Nightly 1 am snapshots record it all, so the time slider replays past migration
  nights. The City Concierge reads the same feed — including per-borough numbers,
  the confidence flag, and season context (why a July sky is quiet) that stays out
  of the UI on purpose.

**How it works:** the Cornell Lab of Ornithology's [BirdCast](https://birdcast.org)
project (with Colorado State University and UMass Amherst) measures nocturnal bird
migration using the national NEXRAD weather-radar network and publishes county-level
estimates every 10 minutes — the same numbers behind their public
[Migration Dashboard](https://dashboard.birdcast.org/region/US-NY-061). The backend
reads the four NYC county rows (New York, Kings, Queens, Bronx) from that dataset
and serves them through a cached `/api/birds` endpoint with an aloft-weighted
citywide rollup. The renderer scales the visible flock with √(true count) — one
draw call for all 600 birds — and deals skeins to boroughs by each county's share.
Nightly totals land in the daily snapshot archive, which is what powers both replay
and the percentile ranking.

*Data credit: BirdCast — Cornell Lab of Ornithology / Colorado State University /
UMass Amherst.*
