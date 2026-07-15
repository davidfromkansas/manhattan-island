# Append far-east Queens streets (CSCL inkn-q76z) to public/streets.json.
# The original Queens CSCL fetch was clipped ~x>16000; the DCM lore audit (m2vu-mgzw)
# found ~1.8k built DCM segments with no match there (Queens Village, Cambria Heights,
# Laurelton, Rosedale, Bellerose, Little Neck/Douglaston). Same treatment as the SI append.
import json, sys, math
sys.path.insert(0, '/private/tmp/claude-501/-Users-david-lietjauw/774ad873-7b5f-4951-84dd-2365510893f4/scratchpad')
from georaw import geoRaw_ll
from collections import defaultdict

SP = '/Users/david_lietjauw/manhattan-island/public/streets.json'
ST = json.load(open(SP))
CELL = 100.0
grid = defaultdict(list)
for e in ST['edges']:
    p = e['p']
    for i in range(len(p) - 1):
        (x0, z0), (x1, z1) = p[i], p[i + 1]
        for gx in range(int(min(x0, x1) // CELL) - 1, int(max(x0, x1) // CELL) + 2):
            for gz in range(int(min(z0, z1) // CELL) - 1, int(max(z0, z1) // CELL) + 2):
                grid[(gx, gz)].append((x0, z0, x1, z1))

def near(x, z, r=30):
    r2 = r * r
    for (x0, z0, x1, z1) in grid.get((int(x // CELL), int(z // CELL)), ()):
        dx, dz = x1 - x0, z1 - z0
        L2 = dx * dx + dz * dz or 1
        t = max(0, min(1, ((x - x0) * dx + (z - z0) * dz) / L2))
        if (x - (x0 + t * dx)) ** 2 + (z - (z0 + t * dz)) ** 2 < r2: return True
    return False

RW = {'1': 0, '2': 1, '3': 2, '9': 3, '4': 4}          # street/highway/bridge/ramp/tunnel
TD = {'FT': 1, 'TF': 2, 'TW': 3, 'NV': 3}
F = json.load(open('/private/tmp/claude-501/-Users-david-lietjauw/774ad873-7b5f-4951-84dd-2365510893f4/scratchpad/cscl_qn_east.json'))['features']

nodes = ST['nodes']; edges = ST['edges']
nodemap = {}
def node_at(x, z):
    k = (round(x), round(z))
    if k in nodemap: return nodemap[k]
    nodes.append([round(x, 1), round(z, 1), []])
    nodemap[k] = len(nodes) - 1
    return nodemap[k]

added = 0; skipped_dup = 0; skipped_type = 0
for ft in F:
    pr = ft['properties']
    rw = RW.get(pr.get('rw_type'))
    if rw is None: skipped_type += 1; continue
    g = ft.get('geometry')
    if not g: continue
    lines = [g['coordinates']] if g['type'] == 'LineString' else g['coordinates']
    for line in lines:
        if len(line) < 2: continue
        pts = [geoRaw_ll(la, lo) for lo, la in ((c[0], c[1]) for c in line)]
        # existing-coverage test: majority of samples already near an edge -> duplicate
        samples = [pts[0], pts[len(pts) // 2], pts[-1]]
        hits = sum(1 for (x, z) in samples if near(x, z))
        if hits >= 2: skipped_dup += 1; continue
        p = [[round(float(x), 1), round(float(z), 1)] for x, z in pts]
        a = node_at(p[0][0], p[0][1]); b = node_at(p[-1][0], p[-1][1])
        try: w = round(float(pr.get('streetwidth') or 30) * 0.3048, 1)
        except Exception: w = 9.0
        try: ln = int(pr.get('number_travel_lanes') or 2)
        except Exception: ln = 2
        eid = len(edges)
        edges.append({'pid': str(pr.get('physicalid')), 'nm': (pr.get('stname_label') or '').strip(),
                      'bo': 4, 'rw': rw, 'w': w, 'ln': ln, 'td': TD.get(pr.get('trafdir'), 3),
                      'a': a, 'b': b, 'p': p})
        nodes[a][2].append(eid); nodes[b][2].append(eid)
        # register in grid so later duplicates within the fetch are caught
        for i in range(len(p) - 1):
            (x0, z0), (x1, z1) = p[i], p[i + 1]
            for gx in range(int(min(x0, x1) // CELL) - 1, int(max(x0, x1) // CELL) + 2):
                for gz in range(int(min(z0, z1) // CELL) - 1, int(max(z0, z1) // CELL) + 2):
                    grid[(gx, gz)].append((x0, z0, x1, z1))
        added += 1

ST['meta']['note'] += ' +far-east QN (bo=4) appended from CSCL (DCM m2vu-mgzw audit).'
json.dump(ST, open(SP, 'w'), separators=(',', ':'))
print(f'added {added} edges, skipped {skipped_dup} duplicates, {skipped_type} non-vehicular; total edges {len(edges)}, nodes {len(nodes)}')
