# Changelog

User-visible features, newest first. Format per entry: **Title · date shipped · TL;DR ·
What you'll see · How it works** (with source links). See AGENTS.md → "Changelog" for
the rules on adding entries.

---

## 🏝️ Governors Island, for real

**Shipped:** July 10, 2026

**TL;DR:** Governors Island's five placeholder prisms are now the island's real building
fabric from the city's 3D model, plus a sculpted terrain with The Hills park and Fort
Jay's star rampart on its glacis.

**What you'll see:** From the harbor or the Island preset: ~90 real buildings — Castle
Williams' circular drum on the northwest shore, the Brooklyn-Battery Tunnel vent drum
on the north tip, Liggett Hall's quarter-mile bar crossing the island, Nolan Park and
hospital rows, Colonels Row — with a 4-pointed star fort rising on a mounded glacis at
Fort Jay, and the four Hills (Outlook, Discovery, Slide, Grassy) lifting the southern
parkland up to ~21 m, trees riding the slopes.

**How it works:** Building geometry comes from the
[NYC DCP 3D city model](https://www.nyc.gov/site/planning/data-maps/open-data/dwn-nyc-3d-model-download.page)
(tile `nyc_3dmodel_mn01` — Governors Island is Manhattan CD1): 774 facade/rooftop
surfaces baked offline into scene coordinates through an affine fitted against the
scene's own `geoRaw` calibration (validated by the DCP shoreline matching the baked
island ring to within meters), u16-quantized with per-building vertex colors into
`public/govisland.json` (~205 KB), lazy-fetched into one Lambert mesh. The terrain is a
14 m grid clipped to the island ring, displaced by five analytic bumps (`GI_HILLS`):
four for The Hills — which opened in 2016 and so aren't in the 2014-vintage DCP capture;
positions/heights from the park's published design — and one for Fort Jay's glacis.
The star rampart and glacis are sculpted, not surveyed (DCP models the fort's interior
barracks but not its earthworks); the island tree scatter now samples the same hill
function so trees sit on the slopes instead of inside them. Honest caveat: the DCP
snapshot predates the park, so a few since-demolished Coast Guard-era barracks still
stand between the Hills — a 2014 time capsule rather than today's lawn.

## 💓 City Vitals — a live pulse panel for the whole city

**Shipped:** July 10, 2026

**TL;DR:** A frosted-glass "City Vitals" panel with a scrolling heart-monitor trace,
showing live counts from every layer at a glance — residents, road events, transit in
motion, aircraft, bikes, cameras, road speed, and bird migration.

**What you'll see:** Top-right corner, a translucent panel headed by a green ECG
heartbeat line that scrolls like a hospital monitor. Rows update every 2 seconds:
- **Residents** — placed personas and the population they stand in for ("9,499 personas
  / 6.2M NYC residents").
- **Road closures** — active closures, with incidents noted separately.
- **Trains rolling / Buses moving / Ferries underway** — vehicles in motion over the
  total tracked (e.g. "106 / 189 trains").
- **Aircraft tracked** (helicopters flagged with 🚁), **Bikes available** (docked bikes /
  dock capacity), **Traffic cams** online, **Avg road speed**, and **Birds aloft** during
  migration.

**How it works:** a pure DOM overlay that reads the in-scene state of each live module
once every 2 seconds — no new data sources, so it also reflects history when you scrub
the timeline. Because the transit feeds carry **no schedule-adherence data**, the panel
never claims "on time"; it reports honest motion proxies instead — trains between
stations vs. stopped (GTFS-RT vehicle status), buses above walking speed, ferries not
docked. Bike totals come from the [Citi Bike GBFS feed](https://gbfs.citibikenyc.com/gbfs/gbfs.json)
(available = every docked classic + e-bike; the "total" is dock capacity, since GBFS
never publishes how many bikes are out riding). Bird counts are the
[BirdCast](https://birdcast.info) radar estimate, shown with a ≈.

## 🎥 On-screen camera controls

**Shipped:** July 10, 2026

**TL;DR:** Two click-or-hold control clusters above the concierge drive the camera — a
rotation dial and a movement pad — so you can fly the city without a mouse drag or
keyboard.

**What you'll see:** Above the "Ask David!" concierge, a round dial and a cross-shaped
pad. The dial's curved side arrows orbit left/right, its top/bottom wedges tilt the view
over toward a bird's-eye or under toward street level, and its center **+/−** raises or
lowers the camera. The pad's **▲/▼** zoom in and out; **◀/▶** slide the view laterally.
Every button gives one nudge per click and glides continuously while held, at speeds
that scale with how far out you are.

**How it works:** a pure SVG/DOM overlay driving the existing orbit camera — zoom stays
inside the scene's 25 m–28 km limits, tilt respects the polar clamp, elevation floors out
above the ground. Pressing any button cancels an in-flight camera fly-to. Hidden in photo
mode and while the concierge is open. No external data.

## 🕐 Status panel, docked timeline + city radio

**Shipped:** July 10, 2026

**TL;DR:** The top-left weather strip is now a segmented status panel with icons, the
7-day timeline docks directly beneath it at matching width, and a looping city-radio
ambience plays with a speaker toggle on the panel.

**What you'll see:** A glossy panel in the top-left: a clock with big local time and the
date, a thermometer with °F, a weather glyph that tracks conditions and time of day
(🌙 on clear nights, ⛈️ in storms), a compass with wind direction and speed, and a speaker
button. Occasional statuses — bird-migration counts, "replaying YYYY-MM-DD", the
sun-scrub offset, "weather offline" — appear as a footnote row only when they apply. The
LIVE/scrub timeline sits right below at exactly the panel's width; scrubbing, the day
ticks, and the "now" button behave exactly as before. The radio starts on at gentle
volume; the speaker mutes it (red slash) and un-mutes it.

**How it works:** the panel re-renders feeds already in the scene — the same weather/wind
readout and [BirdCast](https://birdcast.info) migration numbers as the old strip, no new
data. The audio is a bundled 60-second ambient loop (trimmed from an hour-long "good
morning New Yorkers" mix down to ~1 MB) played through a looping `<audio>` element;
browsers gate autoplay with sound, so if blocked it starts on the first click or keypress.
Timeline logic is untouched — only its position and skin moved.

## ⛴️ Only real ferries sail the rivers now

**Shipped:** July 10, 2026

**TL;DR:** The scripted decorative boats (fake Staten Island Ferry, tour boats, barges,
police launches) are gone — the rivers now show only live NYC Ferry vessels.

**What you'll see:** No more looping generic boats with wake trails crossing the harbor
and rivers. The only vessels on the water are the real-time NYC Ferry boats from the live
feed, so at off-hours the rivers can be genuinely quiet — an honest reflection of what's
actually sailing.

**How it works:** removed the entire decorative fleet and its wake system, plus the
"river traffic density" slider that drove them. The live NYC Ferry layer (real vessel
GPS, dead-reckoned between snapshots) is unchanged.

## 🌊 No more buildings in Upper Bay

**Shipped:** July 10, 2026

**TL;DR:** The decorative New Jersey building fill no longer spills boxes onto the
water — the floating buildings visible in Upper Bay near Liberty Island are gone, and
so are the ones that overshot Jersey's far western edge into open sea.

**What you'll see:** From a top-down or harbor camera near Liberty Island, the water
between the Jersey waterfront and the Statue of Liberty is clean open bay — previously
a scatter of isolated building boxes floated there. The Jersey shoreline reads as a
crisp land/water edge along the whole Hudson, and the fill now also stops flush at the
land slab's western limit instead of running past it onto the sea.

**How it works:** The Jersey fill generator seeded its rows from a shoreline formula
that diverged from the ground slab's own edge south of the Battery (where the slab
pulls back an extra 300 m as the Hudson opens into Upper Bay), so box columns landed
east of the land they were meant to sit on. The fill now derives its east edge from
the slab's exact formula with a 60 m inset, and a skip gate drops any box west of the
slab's x = −4800 far edge. Verified numerically (worst-case box jitter and rotation
stay ≥35 m inside the slab) and visually with top-down screenshots at Liberty Island,
the south and mid-Hudson waterfront, and the western sea edge. Purely procedural —
no external data.

## 🎛️ On-screen camera controls

**Shipped:** July 10, 2026

**TL;DR:** Two click-or-hold control clusters above the concierge now drive the camera —
a rotation dial and a movement pad — so you can fly the city without a mouse drag or
keyboard.

**What you'll see:** Above the "Ask David!" concierge, a circular dial and a cross-shaped
pad, glossy navy buttons on metallic plates. The dial's curved side arrows orbit the city
left/right, its top/bottom wedges tilt the view over toward a bird's-eye or under toward
street level, and its center **+/−** raises or lowers the camera straight up and down.
The pad's **▲/▼** zoom in and out; **◀/▶** slide the view laterally. Every button gives
one nudge per click and glides continuously while held, with speeds that scale to how
far out you are.

**How it works:** A pure SVG/DOM overlay driving the existing orbit camera — zoom stays
inside the scene's 25 m–28 km distance limits, tilt respects the polar clamp, and
vertical moves floor out above the ground. Pressing any button cancels an in-flight
camera fly-to, the same as grabbing the view; the controls hide in photo mode and while
the concierge panel is open. No external data.

## 🕐 Status panel, docked timeline + city radio

**Shipped:** July 10, 2026

**TL;DR:** The top-right weather strip is now a segmented status panel with icons, the
7-day timeline docks directly beneath it at matching width, and a looping city-radio
ambience plays with a speaker toggle on the panel.

**What you'll see:** A glossy white panel in the top-right: a clock with big local time
and the date, a thermometer with °F, a weather glyph that tracks both conditions and
time of day (🌙 on clear nights, ⛈️ in storms), a compass with wind direction and speed,
and a speaker button. Occasional statuses — bird-migration counts, "replaying
YYYY-MM-DD", the sun-scrub offset, "weather offline" — appear as a small footnote row
only when they apply. The LIVE/scrub timeline sits right below at exactly the panel's
width, restyled to match; scrubbing, the day ticks, and the "now" button behave exactly
as before. The radio starts on at gentle volume; the speaker mutes it (red slash) and
un-mutes it again.

**How it works:** The panel is a re-render of feeds already in the scene — the same
weather/wind readout and [BirdCast](https://birdcast.info) migration numbers as the old
strip, no new data sources. The audio is a bundled 60-second ambient loop (trimmed from
an hour-long "good morning New Yorkers" mix down to ~1 MB) played through a looping
`<audio>` element; browsers gate autoplay with sound, so if blocked it starts on the
first click or keypress. Timeline logic is untouched — only its position and skin moved.

## 🗽 The real Statue of Liberty

**Shipped:** July 10, 2026

**TL;DR:** The Liberty Island placeholder (two green prisms and a beam) is now the
actual Statue of Liberty, rebuilt from the city's own survey model.

**What you'll see:** On the Liberty islet southwest of the Battery, a ~47 m copper-patina
statue standing on the existing stylized pedestal — raised torch with a gilded flame,
tablet arm, crown, robe folds — facing southeast toward the Verrazzano-Narrows, the way
the real one greets ships entering the harbor.

**How it works:** Geometry comes from the [NYC DCP 3D city model](https://www.nyc.gov/site/planning/data-maps/open-data/dwn-nyc-3d-model-download.page)
(tile `nyc_3dmodel_mn01`, Rhino layer `Buildings::Statue_of_Liberty` — 2,457 objects;
Liberty Island is officially part of Manhattan CD1, so she ships with the Lower
Manhattan tile). The DCP model is a CAD curve network without a closed skin, so the
statue was reconstructed offline: curves densified to a point cloud, voxelized at
0.45 ft, morphologically closed (with a deep-closed inner core so curve-sparse robe
panels read as fold shadows instead of holes), marching-cubes surfaced, smoothed, and
decimated to ~62k triangles — then the model's exact NURBS detail surfaces (crown
spikes, tablet, torch) are composited on top. Positions are u16-quantized into
`public/liberty.json` (~760 KB), lazy-fetched after scene load into a single Lambert
mesh (one extra draw call; the material joins the cloud-shadow system). The
reconstruction is honest about its limits: the face is still a voxel suggestion —
she reads great from the harbor, less so from a helicopter selfie distance.

## 🧑‍🤝‍🧑 Ask the Concierge who lives where (Census demographics)

**Shipped:** July 9, 2026

**TL;DR:** The City Concierge now knows the demographics of every NYC neighborhood
from Census microdata — income, age, race/ethnicity, origins, languages, education,
work, and housing — and can shade the whole city by any of them as a thematic map.

**What you'll see:**
- "Who lives in Astoria?" → "~207,000 residents, 48% White / 24% Hispanic / 16%
  Asian, 38% foreign-born (top origins Mexico, Greece, Bangladesh); typical resident
  is 37, rents (81% renters, ~$2,080/mo), ~$81,600 household income, commutes by
  transit" — attributed to the Census, at community-district resolution.
- "Map median household income across NYC" shades all 55 areas on the ground with a
  color legend (blue → amber, ~$31k to ~$186k), Manhattan glowing brightest. Works
  for rent, median age, % foreign-born, % renters, diversity, and more.
- "Which neighborhood is the most diverse?" / "highest rent?" ranks them; "compare
  the Upper East Side and the South Bronx" puts two areas side by side.

**How it works:** a one-time offline bake turns the U.S. Census Bureau's
[ACS 2023 1-Year PUMS](https://www.census.gov/programs-surveys/acs/microdata.html)
microdata (weighted individual + household records) into per-area distributions,
joined to NYC City Planning's
[2020 PUMA boundaries](https://data.cityofnewyork.us/City-Government/2020-Public-Use-Microdata-Areas-PUMAs-/pikk-p9nv);
the running app just reads the baked file (no API key). New concierge tools —
`demographics`, `compare_areas`, `rank_areas`, and a `choropleth` map layer — answer
from it. **Honest caveats:** PUMS is a *sample*, so every number is an estimate with
margin of error; and it is only published at **PUMA** (~community-district)
resolution, so a neighborhood question actually describes the community district
around it — the agent says so. The figures validate against known totals (8.26 M
people, ~$75k citywide median income, 38% foreign-born, Manhattan highest / Bronx
lowest income).

---

## 🚶 Residents walk the streets

**Shipped:** July 9, 2026 (updated)

**TL;DR:** The 9,499 Census personas now continuously walk along their
neighborhood streets — arms and legs swing, heads face the direction of travel,
all driven by the scene clock via shader. Zero per-frame CPU cost.

**What you'll see:**
- From street level, residents pace back and forth along real sidewalk-offset
  stretches of ground streets (no bridges, tunnels, or highways). Legs split
  mid-stride, arms swing in opposition, subtle stride bob while they walk. From
  altitude they're small; at street level they're sized to read clearly.
- On Manhattan, the crowd grew from ~224 to 2,454 after a placement bug fix (the
  predicate was checking only borough land, rejecting the entire island). Now
  crowds are visible everywhere: Midtown, Upper West Side, Harlem, Lower East Side.

**How it works:** shader-side walk cycle — position, yaw (facing), limb swing, and
stride bob all derive from `uTime` (scene clock) + two per-instance attributes
per person (walk segment endpoints + phase/speed). The placement loop now snaps
each person to their nearest ground street, offset from the edge by a sidewalk
margin, and samples 9 interior points to ensure the entire path stays on land
(no water crossings). **The fix:** placement predicate changed from `landOK()`
alone (borough-side only) to `onLand() || landOK()` (island OR boroughs), which
is the same combo the traffic sim uses. All 9,499 people placed; 8,649 walk
(the rest failed street-snapping and stand still). No performance cost beyond the
module load — geometry, draw calls, and fps unchanged.

---

## 🧍 Meet the residents — 9,499 clickable Census personas on the streets

**Shipped:** July 9, 2026

**TL;DR:** Little cartoon New Yorkers now walk throughout the city — each one a
real, anonymous Census respondent placed in their own community district. Click one
to read who they are; the crowd's makeup matches the city's actual demographics.

**What you'll see:**
- Small voxel New Yorkers — big-headed low-poly figures with eyes, varied hair
  styles and bright outfits — dot the sidewalks and blocks, visible from browsing
  altitude and sharper as you descend (buildings hide and reveal them as you move).
  Most are walking; some stand still on streets with no good route. Click one → a card:
  "Medical Assistants, 49 — she lives in the Pelham Parkway / Morris Park (Bronx)
  area — Hispanic/Latino, born in the Dominican Republic. Speaks Spanish at home.
  High school graduate. Personal income ≈ $65k/yr. Commutes by bus or rail." Every
  card ends with "represents ~650 New Yorkers · ACS 2023 PUMS."
- The crowd is distributionally honest: ~1 character per 650 residents of each
  community district, weighted-sampled so the citywide mix matches reality (sample
  median age 38 vs 38 actual; 52% female; race/ethnicity within 1 point).
- After clicking someone, ask the Concierge "who am I looking at?" — it narrates
  that exact resident, and "what do the little cartoon people represent?" explains
  the layer.

**How it works:** an offline bake weighted-samples 12,703 person records from the
[ACS 2023 1-Year PUMS](https://www.census.gov/programs-surveys/acs/microdata.html)
(A-Res reservoir sampling by person weight) with occupations, origins, languages,
education, income and commute decoded from the official Census data dictionary.
The client seeds each persona inside its PUMA polygon on built land and renders
the crowd as instanced 3D voxel figures (eight draw calls total — body parts plus
three hair styles), scaled up gently with distance so people stay findable from
altitude. **Honest caveats:** these are real anonymized microdata records, not
named individuals — no names are invented; the characters' looks (skin, hair,
clothes) are RANDOM by design and never encode demographics — the data lives only
in the card; 9,499 of 12,703 sampled records appear because personas only stand
where the twin has built land (Queens' far east and Staten Island are
under-represented visually — the Concierge's polling numbers remain complete and
unaffected).

## 🚗 The ambient cars drive at measured speeds

**Shipped:** July 9, 2026

**TL;DR:** The simulated cars now pace themselves against real speed data — and on
the highways and bus corridors that data is LIVE. A jam forming on the FDR right
now slows the cars on it within about a minute; a replayed past day drives the
cars at that day's measured speeds, hour by hour.

**What you'll see:**
- **Live, right now:** cars on the FDR, West Side Highway, BQE, Bruckner and the
  bridges follow the real-time DOT sensor readings (refreshed every minute), and
  cars on any street where buses are currently moving follow the live bus-probe
  estimate — real congestion appears in the simulation as it happens.
- **Typical for the hour** on the E-ZPass local links: fly low over Midtown at
  3 PM and the cars on 6th Ave inch along under the red speed ribbon while a green
  avenue nearby moves freely. At night, jammed blocks read as walls of red brake
  lights.
- Scrub the timeline into a past day and drag through its hours: the same street's
  cars crawl at the measured 4 mph afternoon and open up at the measured 16 mph
  overnight. Return to live and live speeds resume.
- Side streets with no sensor coverage behave exactly as before — the synthetic
  flow character is unchanged where there's no data to obey.

**How it works:** the traffic module fuses its three speed sources into a 150 m
grid — live bus-probe estimates take priority over live DOT highway sensors, which
take priority over the E-ZPass typical-for-this-hour profiles — and the ambient-
traffic simulation looks up that field as cars cross street segments, scaling each
car's speed against what's typical for its road class (and feeding the same factor
into its brake lights). The lookup is one map read per car every ~32 simulation
ticks, measured at +0.006 ms/frame — the mobile-performance budget is untouched.
Honest caveats: only instrumented streets (roughly 60 highway links, ~290 E-ZPass
locals, and whatever streets buses recently traversed) are data-driven; a grid
cell straddling an avenue can bleed its speed onto the ends of adjacent cross
streets; car speeds are clamped to 15–130% of road-class typical so the scene
never looks broken by an outlier reading.

---

## 🗣️ Ask the Concierge about street speeds — by street, hour, day, or neighborhood

**Shipped:** July 9, 2026

**TL;DR:** The City Concierge now reads the local street-speed data. "What's the
slowest street in the West Village right now?", "when is 6th Avenue worst?", "how
was traffic last Friday at 5 PM?", and "is traffic worse than usual?" all get
real, attributed answers — and any feed can now be filtered by neighborhood.

**What you'll see:**
- "Slowest local street in the West Village right now" → "14th Street eastbound
  (11th Ave to 7th Ave), about 5 mph — typical for 3 PM based on E-ZPass reader
  data published yesterday, not a live reading," with the streets pinned on the
  map.
- "When is 6th Ave worst?" reads the street's 24-hour curve: worst at 11 AM at
  2.7 mph, easing to 16–17 mph overnight.
- "How was 6th Avenue last Friday at 5 PM?" pulls that actual day from the archive
  (which reaches back years, unlike the 7-day city snapshots).
- "Is traffic worse than usual right now?" compares the live highway sensors and
  nearby buses against the typical-for-this-hour numbers and quantifies the gap.
- Neighborhood filtering works on every feed: "Citi Bike stations in Williamsburg"
  scopes to the real NTA boundary, not a radius guess.
- Street names are forgiving: "Avenue of the Americas", "sixth avenue", and
  "6 Ave" all resolve to the same 6th Avenue readings.

**How it works:** a new `traffic_local` feed exposes the E-ZPass dataset (see its
own entry below) to the agent as per-link speeds evaluated at any wall-clock hour
of any published day, with the full 24-hour profile attached when a question
narrows to a few streets; a generic `area` parameter filters any feed's rows
point-in-polygon against the official borough/NTA boundaries. The agent's
instructions require it to attribute every number to its provenance — live
sensor, live bus average, or "typical for this hour (published <day>)" — and its
clock is now injected per-request, so "yesterday" and "last Friday" resolve to
real dates instead of the model's guess. Honest caveats: the E-ZPass numbers lag
~2 days (the agent says so); the only truly live local-street signal is the
average speed of nearby buses, which excludes their stopped time and so reads a
little high.

---

## ☁️ Puffy Ghibli clouds

**Shipped:** July 9, 2026

**TL;DR:** Clouds went from flat voxel plates to big, rounded, billowing cumulus —
distinct puffy cauliflower masses with blue sky between them.

**What you'll see:**
- Fair-weather skies now hold well-separated cumulus clouds, each a mound of soft
  rounded lobes (~500–800 m across) doming upward from a flatter base, with real
  blue gaps around them instead of a solid ceiling. Fly up near the cloud level
  (~5,200 m) to see them billow in profile.
- Lobe bases sit a touch cooler/shadowed and tops read sunlit-white, so each mass
  looks lit and three-dimensional rather than like a cut-out.
- Overcast still fills the sky, now as a dense field of rounded puffs; the city
  stays clear below.

**How it works:** still one instanced draw call and fully opaque (translucent
clouds caused alpha-sorting streaks long ago), and live cloud cover still maps
directly to how many clouds are drawn. The primitive changed from a box to a
low-poly icosphere (smooth normals → soft shading), and cloud centers now sit on a
coarse ~640 m jittered grid so each is a separate mass; every center grows a
cluster of flattened, overlapping ellipsoid lobes arranged as a cauliflower dome
(wide at the base, smaller and tighter toward the top). Cheaper than the old sheet,
too — at most ~450 k triangles at full overcast; phones use a lower-detail puff and
fewer lobes. Honest caveat: these are stylized rounded volumes built from
overlapping lobes, not raymarched vapor, so up close you can see where lobes meet.

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

## 🛣️ Local street speeds — E-ZPass readers + live bus probes

**Shipped:** July 7, 2026

**TL;DR:** Measured speeds arrive on NORMAL streets, not just highways: ~290
E-ZPass reader links (137 in Manhattan) paint hourly median speeds onto the
street grid, and the live bus fleet doubles as a real-time speed probe for
whatever street it's moving down.

**What you'll see:**
- Narrow speed ribbons on local streets — 6th Ave, 57th St, Roosevelt Ave —
  colored on a local scale (green ≥ 18 mph, red ≤ 4; Manhattan locals live in a
  slower world than the highway scale). Chips declare exactly what you're seeing:
  "57th St west · 4 mph · E-ZPass 07-08 · 15:00".
- The ribbons recolor with the clock: drag the time slider through a replayed day
  and watch the Midtown grid fill through the morning rush at that day's actual
  measured speeds. In Live mode the colors show what's typical for the current
  hour from the latest published day (the chip names it).
- A second, thinner set of ribbons appears wherever ≥2 buses moved down a street
  in the last 10 minutes — a genuinely live estimate, labeled "~7 mph moving ·
  3 live buses". These are live-only and clear during time-travel.
- Streets with no reading for the viewed hour simply have no ribbon — nothing is
  interpolated or invented.

**How it works:** NYC DOT operates E-ZPass readers on local streets (the
Midtown-in-Motion program) and publishes rolling median link speeds to the open
data portal ([current dataset](https://data.cityofnewyork.us/Transportation/EZ-Pass-Readers-July-2024-current/6a2s-2t65),
[2021–2024 archive](https://data.cityofnewyork.us/Transportation/EZ-Pass-Readers-2021-July-2024/erdf-2akx));
the backend aggregates each published day into per-link 24-hour profiles with one
query, and the client colors each link by the profile hour matching the viewed
wall clock. The catch, stated everywhere it appears: the dataset lands in daily
batches ~2 days behind, so in Live mode this layer is a *recent-typical* baseline,
not a live reading — which is exactly why the bus-probe layer exists. Bus probes
reuse the live MTA fleet the scene already renders: every moving bus is
map-matched to its street edge, and edges with two or more distinct buses in a
rolling 10-minute window get an averaged speed. Honest caveats: bus speeds
exclude stopped/dwell time, so probes read a bit above door-to-door reality;
timeline replays of published days show that day's real measurements, but a day
inside the publication lag falls back to the latest available (the chip names the
day shown); tunnel segments are never painted.

*Data: NYC DOT E-ZPass traffic speed readers via NYC Open Data; MTA Bus Time
vehicle positions.*

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

---

## 🚦 Live traffic — highway speeds + incidents on the streets they belong to

**Shipped:** July 7, 2026

**TL;DR:** Real-time NYC DOT sensor speeds painted as colored ribbons on the
highways they measure — FDR, West Side Highway, BQE, Bruckner, the bridges — plus
live 511NY incidents and closures as clickable markers.

**What you'll see:**
- Wide ribbons riding the arterial highways, green → amber → red by measured mph,
  refreshed every minute. The FDR ribbon rides the elevated viaduct; bridge
  ribbons climb the actual decks; tunnel segments are gapped — nothing is ever
  painted on the river.
- Warning triangles for live traffic events: red = accidents/incidents, amber =
  closures. Chips carry the road name, live mph and travel time ("FDR N 25th–63rd
  · 12 mph · 3 min") or the event description.
- Scrub the timeline into a recorded day and the ribbons recolor to that day's
  recorded speeds; sensors that weren't reporting that day disappear rather than
  showing today's colors.

**How it works:** speeds come from the NYC DOT/TRANSCOM real-time feed
([DOT Traffic Speeds on NYC Open Data](https://data.cityofnewyork.us/Transportation/DOT-Traffic-Speeds/i4gi-tjb9),
with the direct `linkdata.nyctmc.org` export as the primary source), decoded and
filtered server-side — dead sensors report telltale 1978 timestamps and are
dropped, and each link's geometry is snapped onto the baked street graph with
heading agreement. Events come from [511 New York](https://511ny.org/)'s public
events API, trimmed to genuine incidents and closures (511NY files standing
truck-restriction notices as "incidents"; Midtown alone has dozens, and they're
filtered out so real events surface). Daily snapshots record both, which is what
powers the timeline recolor. Honest caveats: DOT only instruments arterial
highways — about 60 usable links citywide, so local streets have no live sensor
coverage (see the E-ZPass entry for what fills that gap); each reading is a
median over a whole link, not a point measurement.

*Data: NYC DOT real-time traffic speeds; 511NY (NYSDOT) traffic events.*
