# Plan: Lore-accurate Queens CD1–CD4 from the DCP 3D model

Replace the procedural building fabric of Queens Community Districts 1–4 with real
massing from the NYC DCP 3D city model, covering: Astoria, Astoria Heights, Ditmars,
Steinway, Old Astoria, Ravenswood, Queensbridge, Rikers Island, Long Island City,
Hunters Point, Dutch Kills, Blissville, Sunnyside, Sunnyside Gardens, Woodside,
East Elmhurst, Jackson Heights, North Corona, Corona, Corona Heights, Elmhurst,
and Lefrak City.

This follows the pattern already shipped for the Financial District (`fidi.json`,
commit `c6b0e98` + `fa31ab3`), Governors Island (`govisland.json`), and the Statue of
Liberty (`liberty.json`) — read those loaders in `public/index.html` (grep `fidi.json`)
and the changelog entries before starting. The FiDi approach works; the new problem
here is **scale** (18× the surface count), so this plan adds chunking and a two-tier
simplification strategy.

---

## 0. Source data (already inspected — verified numbers)

| Tile | File | Size | Objects | Facade surfaces | Rooftop surfaces | Contours |
|---|---|---|---|---|---|---|
| QN01 (CD1: Astoria/Steinway/Ravenswood/Queensbridge) | `~/Downloads/NYC_3DModel_QN01.3dm` | 1.6 GB | 884,895 | 234,162 (`Buildings::Building Facade Surface`) | 33,727 (`Buildings::Building Rooftop Surface`) | 35,441 |
| QN02 (CD2: LIC/Hunters Point/Sunnyside/Woodside) | `~/Downloads/NYC_3DModel_QN02.3dm` | 834 MB | 362,039 | 123,243 (`Buildings::Surface_Facade`) | 16,706 (`Buildings::Surface_RoofTop`) | 25,267 |
| QN03 (CD3: Jackson Heights/East Elmhurst/N. Corona) | `~/Downloads/NYC_3DModel_QN03.3dm` | 846 MB | 473,309 | 160,917 (`Buildings::Building Facade Surface`) | 25,255 | 21,959 |
| QN04 (CD4: Corona/Corona Hts/Elmhurst/Lefrak City) | `~/Downloads/NYC_3DModel_QN04.3dm` | 689 MB | 383,669 | 130,676 (`Buildings::Facade Surface`) | 20,385 | 20,393 |

Total: ~649k facade surfaces across four tiles (~32× the FiDi bake). CD3 is entirely
low-rise (max building z = 185 ft — Jackson Heights garden blocks), CD4 tops out at
281 ft (Lefrak City towers) — both are overwhelmingly Tier B fabric, which is what
keeps the budget feasible.

Hard-won facts to respect:

- **Layer names differ per tile** — four naming schemes across these four tiles alone
  ("Building Facade Surface" / "Surface_Facade" / "Facade Surface", plus MN01's).
  Match layers by substring (`Facade`, `RoofTop`/`Rooftop`, `FootPrint`/`Footprint`),
  never by exact name.
- **The tile bounding boxes contain garbage** (objects at SP origin, X up to 1,067,371).
  Derive every scan window from real geometry (shoreline linework / neighborhood geo
  polygons converted to SP), never from the file bbox and never eyeballed — a hand-set
  bbox silently dropped Castle Williams on Governors Island.
- Files are 2017–2018 vintage (better than MN01's 2014): One Court Square era LIC is in
  (max building z = 674 ft ✓), but the post-2017 Court Square/Hunters Point boom
  (Skyline Tower etc.) is **not**. Changelog must say so.
- Rikers: the user wants it; **Phase 0 must verify which tile contains it** (Rikers ≈
  SP X 1,020k–1,032k, Y 222k–232k; lat/lon 40.7931,-73.8801). If it's in neither QN01
  nor QN02, note it in the changelog as out of scope rather than faking it.
- `rhino3dm.File3dm.Read` loads the whole file into RAM — 1.6 GB file ≈ several GB
  resident. Read each tile **once**, dump per-neighborhood intermediate `.npz`
  (vertices/faces/object metadata), and iterate on the npz, not the .3dm.

## 1. Calibration — SOLVED: replicate geoRaw exactly, don't fit affines

**Status: done in Phase 0.** The FiDi/Governors bakes fitted a per-area affine because
those areas were small. Queens spans a huge area where the scene's calibration is NOT
globally affine — it applies a z-dependent piecewise `XSHIFT`, so affines blow up
(measured: per-CD affine residuals of 2–17 m in the eastern neighborhoods; a global
affine 8.6 m). Do not use affines for Queens.

Instead replicate `subway.geoRaw` exactly offline and push every DCP vertex through
`SP(EPSG:2263) → WGS84 (pyproj) → geoRaw`. Validated: **0.007 m max error vs 38 live
`geoRaw` samples across all four CDs** — effectively exact, everywhere, zero fitting.

The exact function (mirror of `public/index.html` `geoToWorld` + `geoToSceneRaw`,
~lines 5520 & 6029 — re-read them before trusting this copy; if they ever change,
re-mirror):

```python
GRID_ROT = deg2rad(29)
XSHIFT = [[0,150],[4520,300],[6760,310],[8120,328],[12200,330],[13400,420],
          [14400,520],[15100,700],[16400,950],[17700,1170],[18800,1150],
          [19900,1000],[21000,900]]
def geoToWorld(lat, lon):
    dE = (lon + 74.0146) * 111320 * cos(deg2rad(40.7003))
    dN = (lat - 40.7003) * 110540
    return (dE*cos(GRID_ROT) - dN*sin(GRID_ROT), dN*cos(GRID_ROT) + dE*sin(GRID_ROT))
def geoRaw(lat, lon):                       # scene x,z (meters)
    gx, gz = geoToWorld(lat, lon)
    zs = gz*0.9877 + 354
    shift = interp(clip(zs,0,21000), XSHIFT_z, XSHIFT_val)
    return gx*0.86 + shift, zs
```

Building y (up) = `(dcp_z_ft - grade_ft) * 0.3048` per §3 grade rebase; the affine only
handled x/z, never height. The reusable helper is committed at
`scripts/georaw.py` (`sp_to_scene(X,Y)` — needs `pyproj`, `numpy`).

**Still validate before mass baking:** overlay a tile's shoreline / `Rail Lines`
linework (transformed) on the baked scene truth — `QB.QN.bnd`, `QB.QN.parks`,
`QB.QN.roads` (~line 1888) and Queens edges from `public/streets.json`. Since geoRaw is
exact, any misalignment means a data/units bug in the extractor, not calibration.

## 2. Scale strategy: two tiers + neighborhood chunks

A naive FiDi-style bake of 649k surfaces yields ~2M+ triangles / ~45 MB. Budget
instead: **≤ 12 MB total across all Queens assets, ≤ 550k triangles**, split into
lazy-fetched chunks of ~1–1.5 MB each. Two tiers per chunk, decided per building
(group facade+rooftop objects by footprint cell, as in the FiDi bake):

- **Tier A — full DCP massing.** Buildings that are tall (roof > ~28 m), large
  (footprint > ~1,200 m²), or shape-complex (facade surface count > ~12): every LIC
  tower, Queensbridge Houses' Y-shaped blocks, Ravenswood Generating Station, Steinway
  factory, Sunnyside rail-yard structures, churches, schools, industrial Blissville.
  Bake like FiDi: weld 6 cm, u16 quantize, per-block grade rebase.
- **Tier B — REVISED during implementation: keep the existing real-footprint boxes.**
  The original plan extruded DCP footprints for the low fabric, but `buildings.json`
  already renders every borough building as a real-footprint oriented box (position,
  size, rotation, height from city data) — extrusions would mostly duplicate it for
  ~2M triangles. So the low fabric KEEPS the existing boxes, and each chunk ships a
  compact claims list (`qn-claims.json`: one circle per Tier A building) that
  suppresses only the boxes a baked building replaces. `qn-claims.json` loads in the
  build-time `Promise.all` (top-level await) so claims exist before generation; the
  meshes stay lazy. LIC keeps its ring-wide full-mesh treatment (already shipped).

Chunk boundaries (geo polygons → scene rings via the fitted affines; store each ring
in the JSON like `fidi.json` does):

| Chunk | Contents | Est. share |
|---|---|---|
| `qn-astoria.json` | Astoria, Ditmars, Astoria Heights | large, mostly Tier B |
| `qn-steinway.json` | Steinway, east CD1 | Tier B + factory Tier A |
| `qn-ravenswood.json` | Old Astoria, Ravenswood, Queensbridge | Tier A heavy (projects, power plant) |
| `qn-lic.json` | LIC core, Court Sq, Dutch Kills | Tier A heavy (towers) |
| `qn-hunterspoint.json` | Hunters Point, Blissville | mixed |
| `qn-sunnyside.json` | Sunnyside (+Gardens), Woodside | large, mostly Tier B |
| `qn-jacksonhts.json` | Jackson Heights, East Elmhurst, North Corona | Tier B + garden-block courts |
| `qn-corona.json` | Corona, Corona Heights | mostly Tier B |
| `qn-elmhurst.json` | Elmhurst, Lefrak City | Tier B + Lefrak towers/hospital/mall Tier A |
| `qn-rikers.json` | Rikers complex (if present in a tile) | small, Tier A |

CD3/CD4-specific cautions:

- **LGA carve-out**: East Elmhurst borders the hand-built LaGuardia (section 19e —
  aprons, terminals). The `qn-jacksonhts` ring must exclude the airport grounds
  entirely; DCP objects on airport land get dropped at bake time, same as the WTC
  carve-outs in `fidi.json`.
- **East-of-plate coverage (Phase 0 check)**: the baked `QB.QN.bnd` land polygon ends
  around scene x ≈ 7000; Corona/Elmhurst sit beyond it on the "generic plate east"
  (see the 19d `landB` comment). Before baking CD4, verify `landOK` returns true and
  street ribbons + block faces exist out there (streets.json is citywide CSCL so
  ribbons should; `blocks.json` coverage needs confirming — if block faces thin out,
  Tier B extrusions still work since they come from DCP footprints, not blocks.json).
- **Jackson Heights garden blocks** are the lore centerpiece of CD3: full perimeter
  blocks with interior courtyards. These footprints are large (> 1,200 m²), so the
  Tier A rule captures them automatically — verify in the Phase 4 acceptance shot that
  the courtyards read as courtyards, not solid slabs (if a footprint ring has holes,
  the Tier B extruder must respect interior rings or promote the building to Tier A).
- **Flushing Meadows Corona Park** is the CD4 east boundary — clip the ring at the
  park edge; the park itself is not in these tiles (and Citi Field/USTA are CD7/CD8,
  out of scope — the user has QN07 in `~/Downloads` if that becomes a follow-up).

Style attributes: same `aSeed`/`aKind` u8 vertex attributes as `fidi.json` so the city
window shader lights everything at night. Kind heuristic per hood recipe flavor
(`RECB` table ~line 3013): brick red-browns for Astoria/Sunnyside/Woodside, industrial
grays for Blissville/Ravenswood, glass for LIC Tier A talls. Vertex colors u8 RGB,
palette per building cluster (hash the footprint cell — see `gi_bake`/`fidi_bake`
notes in the changelog entries).

## 2b. Streets — already accurate; validate, don't rebuild

The street layer needs **no new work**: every drivable street in Queens is already a
real CSCL edge from `public/streets.json` (86,471 citywide edges), rendered as ribbons
in 19d through the same frozen calibration the buildings will use. Because DCP
footprints and CSCL streets are both survey data through one transform, baked
buildings automatically meet the real street walls — that alignment IS the §1
validation gate (overlay DCP linework on the street graph; ship nothing until they
agree within ~5 m).

What the plan deliberately does NOT do to streets:

- No re-derivation of ribbon geometry from the DCP `Roadbed`/`Pavement Edge`/
  `Sidewalk` linework (it exists in all four tiles and is richer than CSCL widths —
  curb-true cross-sections are a possible future project, but touching the street
  layer risks the traffic/bus/persona systems that key off `streets.json` edge ids;
  iron rule: preserve join keys).
- Live-layer street semantics (buses on edges, traffic, walkers) continue to work
  unchanged inside the new fabric, since block suppression doesn't touch `SEG`/graph.

## 2c. Western Queens shoreline — DONE (with one recorded debt)

Fixed during the LIC pilot: the stylized QN shore overshot ~350 m west into the East
River (and Brooklyn's `bnd` polygon overshoots north up the river, calling the whole
channel "land"), painting phantom plate from Hunters Point to Hallets Point. Now
`QW_SHX`/`qwShoreX` in index.html carry the REAL bank from the DCP tiles' Shoreline
linework; it feeds `landOK` (with a rendered-Roosevelt-islet exemption) and
`plateEdgeBKQN`, so plate, boxes, personas and traffic all agree. Verified: no
buildings west of the bank, 0 personas placed on water.

**Recorded debt — Roosevelt Island is channel-fitted ~300 m west of its geoRaw
position** while its content (real footprint boxes, Cornell/Coler/tram/lighthouse
landmarks) is placed at REAL coordinates, spilling east of the rendered islet. Two
shelf dips in `QW_SHX` (z 8120–8360, 9740–10160) keep ground under that spill. The
Octagon and Four Freedoms landmarks were ALREADY floating on water before this fix
(same debt). Follow-up task: un-shift the islet to its real position (needs the
Manhattan-side channel visual resolved), then retire the dips and the exemption.

## 3. Terrain / grade

Both tiles carry real contours (Astoria Heights rises ~90 ft) but the scene's borough
ground is flat. **Do not build terrain in this pass** (non-goal — it would fight the
flat street ribbons of 19d). Use FiDi-style per-cell grade rebase: per 18 m cell, base
= min facade z in the 3×3 neighborhood; subtract per building; clamp bases to scene
ground (y≈1.45–1.7, matching the 19d ribbon height — read the actual constants). The
contour data is a future terrain project, not this one.

## 4. Suppression + landmark reconciliation (surgical index.html edits)

Buildings inside the CD1/CD2 chunk rings must stop being generated procedurally.
Two generators write Queens buildings:

1. **19d street-truth block fill** (`SCb` sink, ~line 2967+): gate the per-block
   building placement with `inQnDcp(x, z)` — a module-scope point-in-ring test over
   the union of chunk rings (bbox pre-test first; this runs per candidate building at
   startup, keep it cheap: one bbox + ring test, rings are ~10 points each).
2. **19c hood street-grid buildings** (`SC` sink in the 19c block): same gate wherever
   it places generic buildings inside CD1/CD2 (read the block carefully — it also
   builds ground/parks/piers which must stay).

Hand-built landmark reconciliation (all positions in `QB.lm`, ~line 1888; builders in
19c ~lines 2841–2875):

| Landmark | Decision | Why |
|---|---|---|
| Hell Gate arch (`hellgate_a/b`) | **Keep** | bridge; DCP building layers don't have it |
| Silvercup sign (`silvercup`) | **Keep the sign, retire the box under it** if DCP has the bakery building; carve a small exclusion so sign posts don't clip | the sign is the lore |
| Big Allis / ConEd stacks (`conedA/B`) | **Keep the 4 candy-striped stack prisms, retire the hand turbine-hall box**; DCP provides the real generating-station massing; carve ~15 m circles around each stack | DCP has buildings, not stacks |
| Steinway factory (`steinwayF`) | **Retire both hand pieces** — DCP has the real factory | real > box |
| `psych`, Roosevelt Island, Cornell, tram | **Untouched** (Roosevelt Island is MN08, not in these tiles) |
| 19d `excl` list (~line 2989) | Remove `conedA`/`steinwayF` entries only if their hand boxes are retired; the exclusion circles become redundant inside the chunk rings anyway |

Also check `RECB`/hood recipes are untouched — they still serve everything outside the
rings (Jackson Heights, Bronx, etc.).

## 4b. Elevated rail — SHIPPED (structure); train-height profile is follow-up

**Status: viaducts + stations shipped July 11, 2026.** Remaining from this section:
the shared elevation profile so live 7/N/W trains ride the deck instead of street
level — deferred because the subway renderer is shared with every line and history
replay (iron rule 5); do it as its own careful change.

Roosevelt Avenue without the 7 viaduct isn't Roosevelt Avenue. Build the two els as
**procedural viaducts generated at startup** (zero asset bytes, like `buildBridge` /
the Hell Gate arch — reuse `pushBeam`/`pushBoxG` into a landmark sink):

- **Alignment comes from the street graph, not guesswork.** Both els run directly
  above named CSCL streets already in `streets.json`: the Astoria line above
  **31st Street** (Queensboro Plaza → Ditmars Blvd), the Flushing line above
  **Queens Boulevard** (portal east of Court Sq → 33rd St) then **Roosevelt Avenue**
  (Woodside → Jackson Heights → Corona, clipped at the CD4/Flushing Meadows boundary).
  Extract each named edge chain (`e.nm` filter + walk connectivity), smooth it, and
  extrude the deck over it — guaranteed street alignment for free. Cross-check the
  result against the DCP `Rail Lines` linework (QN02 has 1,398 of them) through the
  same affine; where they disagree by more than a lane width, trust the DCP rail
  linework (the el occasionally offsets from the street centerline).
- **Structure** (match the existing bridge vocabulary, don't invent a new one):
  deck ribbon ~10–12 m wide (the Flushing line is 3-track) at ~+9 m; paired support
  columns + cross girder every ~20 m planted on the street below; simple platform
  slabs + canopies at real station positions (take station coords from the subway
  module's existing station data — do not hand-place); Queensboro Plaza gets a
  special-cased double-deck interchange block where the two lines meet.
- **Portals:** ramp the deck to grade at the tunnel portals (7: east of Court Sq;
  N/W: north of Queensboro Plaza) using the same `sstep` ramp pattern `buildBridge`
  uses for approaches.
- **Train-height integration (the trap):** live 7 and N/W trains currently render at
  the same height as every other train. Give these two routes a shared elevation
  profile (chainage → y along the el alignment) consumed by BOTH the viaduct
  generator and the subway train renderer, so trains ride the deck instead of
  ghosting through the columns at street level. Follow the existing subway module's
  per-trip positioning code; keep the profile as a module-scope helper next to the
  el builder. Gate this carefully — the subway renderer is shared with all live
  lines and with history replay (`hist()` contract, iron rule 5).
- **Explicitly out of scope:** LIRR Main Line embankment, Amtrak's Hell Gate approach
  viaduct (the arch itself is already hand-built), and Sunnyside Yard trackage —
  except an optional cheap win: a flat dark track-fan ground polygon for Sunnyside
  Yard so the el crosses a rail yard instead of generic blocks (single `sinkQuad`
  fan, no structures).

## 5. Loader

There are now three copy-pasted base64→BufferGeometry decoders in index.html (liberty,
govisland, fidi). Add **one** module-scope helper:

```js
function loadBakedMesh(url, tier) { /* fetch → u16 pos + u8 color/aSeed/aKind +
  u16|u32 index (j.i32 flag) → Mesh(patchCityMaterial(Lambert{vertexColors,
  DoubleSide}, tier)), matrixAutoUpdate=false, scene.add. .catch(()=>{}) */ }
```

Call it once per chunk (10 calls, tier 0). Leave the three existing loaders alone
(surgical-diff rule). +10 draw calls is within budget (scene runs ~62 in the heaviest
view). All chunks lazy-fetch after scene build, same as fidi. If the far-east chunks
(corona/elmhurst) measurably hurt frame time from downtown views, switch just those
two to tier 1 (mid-distance dither fade) — decide from renderer.info numbers, not
guesswork.

## 6. Phases + acceptance criteria

- **Phase 0 — recon (no repo edits).** Fit + validate affines (§1 acceptance).
  Locate Rikers. Dump per-neighborhood npz. Report per-chunk raw surface counts and a
  Tier A/B split estimate.
- **Phase 1 — pilot: `qn-lic.json` only.** Highest lore value, hardest content (towers
  + Queensbridge + carve-outs). Ship bake + suppression + loader for this one ring.
  Accept: One Court Square recognizable at its true position; Queensbridge Houses
  Y-blocks visible; no holes at ring boundary (top-down screenshot); no doubled
  buildings at Silvercup; night windows lit; `__moduleError` clean; asset ≤ 1.6 MB.
- **Phase 2 — remaining CD2** (`qn-hunterspoint`, `qn-sunnyside`). Accept: same checks
  + Sunnyside Gardens' distinctive low courts read as low courts (Tier B fidelity).
- **Phase 3 — CD1** (`qn-astoria`, `qn-steinway`, `qn-ravenswood` + landmark
  reconciliation from §4). Accept: Big Allis stacks stand on the real plant; Steinway
  factory real; Astoria rowhouse grain follows real streets; Hell Gate untouched.
- **Phase 4 — CD3 + CD4** (`qn-jacksonhts`, `qn-corona`, `qn-elmhurst`). Requires the
  east-of-plate Phase 0 check to have passed. Accept: LGA hand-build untouched with a
  clean seam; Jackson Heights courtyard blocks read as perimeter blocks with open
  courts; Lefrak City's tower cluster recognizable; hood recipes still serve
  everything east of the CD4 ring.
- **Phase 5 — Elevated rail** (§4b; after the fabric phases so the el threads through
  real buildings, not boxes that are about to be replaced). Accept: continuous deck
  over 31st St and Queens Blvd/Roosevelt Ave with no gaps at chunk boundaries; columns
  land on streets, never inside buildings (spot-check Jackson Heights' tight blocks);
  stations at real positions; live 7 and N/W trains ride the deck in both live and
  history-replay modes; Queensboro Plaza interchange reads as the double-deck knot.
- **Phase 6 — Rikers** (if data exists). Accept: jail complex inside the existing
  `QB.ISL.rk` ring, nothing on water (`landOK` — but note the ring itself is the land
  truth there, same as Governors).
- **Phase 7 — QA + ship.** Full checklist: top-down hole scan of every ring boundary,
  street-level ground-contact spot checks, night shot, renderer.info draw-call/tri
  count before vs after, all presets screenshot pass, CHANGELOG entry (honest caveats:
  2017 snapshot, Tier B is extruded footprints, no terrain).

## 7. What will NOT be accurate (put the relevant ones in the changelog — house rule)

Be explicit about these; the changelog voice for this repo states what a layer does
and doesn't represent.

1. **Streets: accurate in alignment and topology, approximate in cross-section.**
   Real CSCL centerlines and widths, but flat clamped ribbons — no curbs, medians,
   lane paint, or plazas, even though the DCP tiles carry curb-true Pavement Edge
   linework we're choosing not to use (see §2b).
2. **Terrain is flattened.** Astoria Heights' ~90 ft rise and all contour data are
   ignored; buildings are grade-rebased onto the flat scene ground (§3).
3. **2017–18 snapshot.** No Skyline Tower / post-2017 Court Square or Hunters Point
   towers, no Halletts Point buildout; anything demolished since 2018 still stands.
   LGA is the scene's stylized hand-build, not the (post-dating) new terminals.
4. **Tier B buildings lose their roofs' shape.** Footprint-extrusions are plan-true
   and height-true but flat-topped — Astoria/Woodside's pitched-roof rowhouses read
   as flat parapets unless promoted to Tier A. (Mitigation if it visibly hurts:
   promote any building whose DCP rooftop surfaces span > ~2 m vertically.)
5. **Materials and colors are heuristics.** DCP carries pure geometry — brick vs
   vinyl vs stone is a palette hash keyed to hood recipes, and windows are the
   procedural shader pattern, not real fenestration.
6. **Elevated rail is stylized, not girder-true.** The 7 and N/W els are now in scope
   (§4b) but as procedural viaducts in the scene's bridge vocabulary — real alignment,
   real stations, plausible structure; not the actual riveted-steel lattice. LIRR
   embankments and Amtrak's approach viaduct remain absent (Sunnyside Yard gets at
   most a flat track-fan ground polygon).
7. **No street furniture, trees beyond the existing scatter, or lot-level detail**
   (fences, garages get merged into their parent building or dropped by the weld).
8. **Rikers is conditional** on the complex actually being present in QN01/QN02
   (Phase 0 check) — otherwise it stays the bare islet ring.
9. **Chunk-boundary buildings**: a building straddling two chunk rings is assigned to
   exactly one (by footprint centroid) — no duplicates, but a ring drawn through a
   dense block can put a facade 1 m outside its chunk's nominal polygon. Cosmetically
   invisible; noted for anyone diffing rings against assets.

## 8. Shipping rules (violations burned us three times this week)

- **The JSON assets must be in the SAME commit as their loader code.** Loaders
  `.catch(() => {})` silently — prod renders an empty district if the asset lags.
  This happened with liberty.json, govisland.json, AND fidi.json because parallel
  sessions' `git commit -am` swept loader code into their commits early. Therefore:
  `git add` the specific files, never `-am`; check `git status` for other sessions'
  in-flight work (they edit index.html constantly); `git pull --rebase --autostash`
  before push. Every push deploys.
- Test locally per AGENTS.md (`window.__moduleError` FIRST, then network, then
  screenshots) before every push. Use a dedicated PORT (registry pattern in
  `~/.claude/launch.json` — 4193 is in use by another session).
- Keep diffs surgical; don't renumber sections; coordinate index.html scope with the
  user if another agent has uncommitted work in the same regions.
