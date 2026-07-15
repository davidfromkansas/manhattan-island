"""South-Brooklyn land: cell mask from building coverage (BK10-18 footprints).
Outputs:
 1) public/bk-south-land.json  — {x0,z0,cell,w,h,bits} bitmask (same format as qn-east-land)
    for landOK gating (personas/streets) across the south/Jamaica-Bay region.
 2) public/bk-south-land.bin   — always-resident ground mesh for the OFF-PLATE part only
    (z<-8480 or x>8780): greedy-merged quads at plate height, green land / sand beach strip.
The shore (Coney peninsula, Sheepshead Bay inlet, the basins) EMERGES from the coverage.
Morphological closing (dilate 2, erode 1) fills yards/streets without bridging real water."""
import rhino3dm, struct, json, base64, time, gc
import numpy as np
from georaw import sp_to_scene, geoRaw_ll
CELL=40.0
X0,X1,Z0,Z1=-9000,22600,-28600,27200
W=int((X1-X0)//CELL); H=int((Z1-Z0)//CELL)
mask=np.zeros((W,H),bool)
t0=time.time()
for T in ['BK10','BK11','BK12','BK13','BK14','BK15','BK16','BK17','BK18','QN08','QN09','QN10','QN11','QN12','QN13','QN14','BX01','BX03','BX04','BX05','BX06','BX07','BX08','BX09','BX10','BX11','BX12','SI01','SI02','SI03','SI_Parks']:
    m=rhino3dm.File3dm.Read(f'/Users/david_lietjauw/Downloads/NYC_3DModel_{T}.3dm')
    layers={i:l.FullPath for i,l in enumerate(m.Layers)}
    U=1.0
    for o in m.Objects:
        lp=layers[o.Attributes.LayerIndex]
        if 'acade' in lp:
            try: c=(o.Geometry.GetBoundingBox().Min.X+o.Geometry.GetBoundingBox().Max.X)/2
            except: continue
            if c>1e5: U=304.8 if c>5e6 else 1.0; break
    n=0
    for o in m.Objects:
        lp=layers[o.Attributes.LayerIndex]
        if not (('oot' in lp or 'acade' in lp) and ('urface' in lp or 'Srf' in lp)): continue  # footprints OR facades (park tiles have no footprints)
        g=o.Geometry
        try: bb=g.GetBoundingBox()
        except: continue
        cx=(bb.Min.X+bb.Max.X)/2/U; cy=(bb.Min.Y+bb.Max.Y)/2/U
        if cx<10 or cx>1e7: continue
        sx,sz=sp_to_scene(cx,cy)
        gx=int((sx-X0)//CELL); gz=int((sz-Z0)//CELL)
        if 0<=gx<W and 0<=gz<H: mask[gx,gz]=True; n+=1
    print(f'{T}: {n} cells ({time.time()-t0:.0f}s)',flush=True); m=None; gc.collect()
def dil(a):
    b=a.copy(); b[1:,:]|=a[:-1,:]; b[:-1,:]|=a[1:,:]; b[:,1:]|=a[:,:-1]; b[:,:-1]|=a[:,1:]; return b
def ero(a):
    b=a.copy(); b[1:,:]&=a[:-1,:]; b[:-1,:]&=a[1:,:]; b[:,1:]&=a[:,:-1]; b[:,:-1]&=a[:,1:]; return b
land=ero(dil(dil(mask)))
# carve REAL water inlets that the closing bridged (narrow bays/basins), as capsules
# (lat/lon endpoints -> scene). The mask closing fills anything under ~240 m wide.
WATER=[  # (lat0,lon0, lat1,lon1, width_m)
 (40.5824,-73.9545, 40.5876,-73.9295, 240),   # Sheepshead Bay
 (40.5845,-73.9225, 40.6035,-73.9300, 260),   # Gerritsen Creek / Marine Park inlet
 (40.6200,-73.8870, 40.6375,-73.9090, 260),   # Paerdegat Basin
 (40.6035,-73.8980, 40.6160,-73.9075, 420),   # Mill Basin (main body)
 (40.6160,-73.9075, 40.6205,-73.9215, 260),   # Mill Basin (west arm)
 (40.5795,-74.0015, 40.5862,-73.9835, 150),   # Coney Island Creek
 (40.8060,-73.8420, 40.8410,-73.8460, 170),   # Westchester Creek
 (40.8060,-73.8560, 40.8210,-73.8510, 120),   # Pugsley Creek
 (40.7975,-73.8775, 40.8230,-73.8750, 170),   # Bronx River (lower, east-mask side)
 (40.8250,-73.8110, 40.8720,-73.8260, 220),   # Eastchester Bay / Hutchinson mouth
 (40.8720,-73.8260, 40.8870,-73.8180, 150),   # Hutchinson River (upper)
 (40.5705,-74.1975, 40.5870,-74.1690, 130),   # Fresh Kills / Main Creek
 (40.5640,-74.1890, 40.5800,-74.1550, 100),   # Richmond Creek
 (40.6395,-74.0850, 40.6440,-74.1450, 350),   # Kill Van Kull (east)
 (40.6440,-74.1450, 40.6480,-74.1900, 380),   # Kill Van Kull (west)
 (40.5470,-74.1372, 40.5428,-74.1335, 200),   # Great Kills Harbor (lagoon)
 (40.6230,-74.2025, 40.6450,-74.1935, 330),   # Arthur Kill (north channel)
 # DCM lore audit: named inland lakes + Flushing system (also carved from `deep` below —
 # the qn-east backfill painted ground over Flushing Bay/Creek and the FMCP lakes).
 # Flushing system: refit to Census TIGER AREAWATER (hand capsules sat ~200 m off-axis
 # and flooded lakeshore/bank fabric).
 (40.7805,-73.8618, 40.7800,-73.8608, 950),   # Flushing Bay
 (40.7800,-73.8608, 40.7868,-73.8541, 750),   # Flushing Bay (mouth at East River channel)
 (40.7656,-73.8525, 40.7601,-73.8508, 300),   # Flushing Creek (bay reach)
 (40.7601,-73.8508, 40.7549,-73.8399, 115),   # Flushing Creek (Willets Point bend)
 (40.7549,-73.8399, 40.7412,-73.8381, 80),    # Flushing Creek (through FMCP)
 (40.7412,-73.8381, 40.7356,-73.8409, 110),   # Flushing Creek (to Meadow Lake)
 (40.7329,-73.8403, 40.7298,-73.8373, 240),   # Meadow Lake (north)
 (40.7298,-73.8373, 40.7230,-73.8328, 250),   # Meadow Lake (south)
 (40.7211,-73.8328, 40.7219,-73.8330, 170),   # Willow Lake
 (40.6810,-73.7855, 40.6775,-73.7830, 230),   # Baisley Pond
 (40.7470,-73.8085, 40.7455,-73.8045, 120),   # Kissena Lake
 (40.6265,-74.0910, 40.6230,-74.0955, 210),   # Silver Lake (SI)
 (40.6220,-74.1085, 40.6160,-74.1105, 125),   # Clove Lakes chain
 (40.5215,-74.1855, 40.5195,-74.1890, 135),   # Wolfe's Pond
]
def carve(land):
    for la0,lo0,la1,lo1,wd in WATER:
        x0,z0=geoRaw_ll(la0,lo0); x1,z1=geoRaw_ll(la1,lo1)
        for gx in range(W):
            for gz in range(H):
                if not land[gx,gz]: continue
                px=X0+gx*CELL+CELL/2; pz=Z0+gz*CELL+CELL/2
                dx,dz=x1-x0,z1-z0; L2=dx*dx+dz*dz or 1
                t=max(0,min(1,((px-x0)*dx+(pz-z0)*dz)/L2))
                qx,qz=x0+t*dx,z0+t*dz
                if (px-qx)**2+(pz-qz)**2 < (wd/2)**2: land[gx,gz]=False
    return land
# manual park patches (no buildings but land): Marine Park grass + Floyd Bennett Field
park=np.zeros((W,H),bool)
landpatch=[(40.6215,-74.1835,560,660),(40.6120,-74.1900,420,420)]  # Bloomfield / Chelsea industrial west shore (tan, no trees)
near=mask.copy()
for _ in range(25): near=dil(near)   # within ~1 km of any real building
for (la,lo,rx,rz) in [(40.6015,-73.9155,600,850),(40.5885,-73.8925,750,950),(40.8680,-73.8090,1050,1450),(40.8740,-73.8290,700,950),(40.8950,-73.8670,550,650),(40.5770,-74.1830,1250,1500),(40.5890,-74.1370,850,1000),(40.6030,-74.1580,550,650),(40.6225,-74.1120,380,520),(40.5680,-74.0960,480,420),(40.5390,-74.1302,260,380),(40.5510,-74.1210,420,620),(40.5000,-74.2495,320,380),(40.5390,-74.2330,460,560),(40.5180,-74.1880,380,450),(40.5060,-74.2170,480,380),(40.6250,-74.0910,320,420),(40.6050,-74.1050,520,620)]:  # + Pelham Bay/Co-op/Woodlawn + SI: Fresh Kills, Greenbelt, Willowbrook, Clove Lks, Miller Fld, Great Kills Pk, Wolfe's Pond, Mt Loretto, Silver Lk  # Marine Park (E of Gerritsen Ck), Floyd Bennett Field
    px,pz=geoRaw_ll(la,lo)
    g0=int((px-rx-X0)//CELL); g1=int((px+rx-X0)//CELL); h0=int((pz-rz-Z0)//CELL); h1=int((pz+rz-Z0)//CELL)
    sl=(slice(max(0,g0),min(W,g1)), slice(max(0,h0),min(H,h1)))
    land[sl]|=near[sl]
    park[sl]|=near[sl]
    # inner 60% core is unconditional land (big forests sit >1km from any building)
    cx0=(g0+g1)//2; ch0=(h0+h1)//2; rx2=int((g1-g0)*0.3); rz2=int((h1-h0)*0.3)
    sc=(slice(max(0,cx0-rx2),min(W,cx0+rx2)), slice(max(0,ch0-rz2),min(H,ch0+rz2)))
    land[sc]=True; park[sc]=True
for (la,lo,rx,rz) in landpatch:
    px,pz=geoRaw_ll(la,lo)
    g0=int((px-rx-X0)//CELL); g1=int((px+rx-X0)//CELL); h0=int((pz-rz-Z0)//CELL); h1=int((pz+rz-Z0)//CELL)
    sl=(slice(max(0,g0),min(W,g1)), slice(max(0,h0),min(H,h1)))
    land[sl]|=near[sl]
    cx0=(g0+g1)//2; ch0=(h0+h1)//2; rx2=int((g1-g0)*0.3); rz2=int((h1-h0)*0.3)
    land[max(0,cx0-rx2):min(W,cx0+rx2), max(0,ch0-rz2):min(H,ch0+rz2)]=True
# ---- NYC PARKS PROPERTIES (Open Data enfh-gkve, 2,059 properties): every park citywide.
# Skipped: Manhattan (its ground canvas paints parks), median strips/parkways/malls/undeveloped.
# Land is added only within the near-building clip (Gateway-class properties span open water);
# surveyed wetlands + water capsules run AFTER and re-carve anything wet.
parkraster=np.zeros((W,H),bool)
try:
    PK=json.load(open('/private/tmp/claude-501/-Users-david-lietjauw/774ad873-7b5f-4951-84dd-2365510893f4/scratchpad/nyc_parks.json'))['features']
except Exception as e:
    PK=[]; print('parks load failed:',e)
from matplotlib.path import Path as _MP
SKIPT={'Strip','Parkway','Mall','Undeveloped'}
npk=0
for ft in PK:
    pr=ft['properties']
    if pr.get('borough')=='M' or pr.get('typecategory') in SKIPT: continue
    g=ft.get('geometry')
    if not g: continue
    polys=g['coordinates'] if g['type']=='MultiPolygon' else [g['coordinates']]
    for poly in polys:
        rings=[np.array([geoRaw_ll(la,lo) for lo,la in ring]) for ring in poly if len(ring)>=3]
        if not rings: continue
        xs=np.concatenate([r[:,0] for r in rings]); zs=np.concatenate([r[:,1] for r in rings])
        g0=max(0,int((xs.min()-X0)//CELL)); g1=min(W,int((xs.max()-X0)//CELL)+1)
        h0=max(0,int((zs.min()-Z0)//CELL)); h1=min(H,int((zs.max()-Z0)//CELL)+1)
        if g0>=g1 or h0>=h1: continue
        gxs=np.arange(g0,g1); gzs=np.arange(h0,h1)
        PX,PZ=np.meshgrid(X0+gxs*CELL+CELL/2, Z0+gzs*CELL+CELL/2, indexing='ij')
        pts=np.column_stack([PX.ravel(),PZ.ravel()])
        inside=np.zeros(len(pts),bool)
        for r in rings: inside ^= _MP(r).contains_points(pts)
        parkraster[g0:g1,h0:h1] |= inside.reshape(len(gxs),len(gzs))
    npk+=1
land |= (parkraster & near)   # parks are land, but only near real coverage (no bay-greening)
print('parks rasterized:',npk,'park cells:',int(parkraster.sum()))
land|=(mask & dil(dil(land)))   # building cells re-join land only if adjacent to it (keeps shore strips, drops mid-channel piers/barges)
# ---- SURVEYED WETLANDS (NYC Open Data p48c-iqtu): Water classes -> open water; Estuarine/Emergent
# -> marsh; Forested/Scrub-Shrub -> wooded green (joins the park/tree treatment).
marshm=np.zeros((W,H),bool)
try:
    WET=json.load(open('/private/tmp/claude-501/-Users-david-lietjauw/774ad873-7b5f-4951-84dd-2365510893f4/scratchpad/nyc_wetlands.json'))['features']
except Exception as e:
    WET=[]; print('wetlands load failed:',e)
from matplotlib.path import Path as MPath
nw=0
for ft in WET:
    cl=ft['properties'].get('classname'); g=ft.get('geometry')
    if not g or not cl: continue
    polys=g['coordinates'] if g['type']=='MultiPolygon' else [g['coordinates']]
    for poly in polys:
        rings=[np.array([geoRaw_ll(la,lo) for lo,la in ring]) for ring in poly if len(ring)>=3]
        if not rings: continue
        xs=np.concatenate([r[:,0] for r in rings]); zs=np.concatenate([r[:,1] for r in rings])
        g0=max(0,int((xs.min()-X0)//CELL)); g1=min(W,int((xs.max()-X0)//CELL)+1)
        h0=max(0,int((zs.min()-Z0)//CELL)); h1=min(H,int((zs.max()-Z0)//CELL)+1)
        if g0>=g1 or h0>=h1: continue
        gxs=np.arange(g0,g1); gzs=np.arange(h0,h1)
        PX,PZ=np.meshgrid(X0+gxs*CELL+CELL/2, Z0+gzs*CELL+CELL/2, indexing='ij')
        pts=np.column_stack([PX.ravel(),PZ.ravel()])
        inside=np.zeros(len(pts),bool)
        for r in rings:
            inside ^= MPath(r).contains_points(pts)   # even-odd across rings (holes handled)
        inside=inside.reshape(len(gxs),len(gzs))
        sub=(slice(g0,g1),slice(h0,h1))
        if cl in ('Water','Water-Estuarine'):
            land[sub]&=~inside; park[sub]&=~inside; marshm[sub]&=~inside
        elif cl in ('Estuarine','Emergent'):
            land[sub]|=inside; marshm[sub]|=inside
        else:
            land[sub]|=inside; park[sub]|=inside
        nw+=1
print('wetland polys rasterized:',nw,'marsh cells:',int(marshm.sum()))
land=carve(land)
park |= parkraster & land     # dataset parks color the mask ground (green + trees)
print('land cells:',int(land.sum()),flush=True)
# 1) bitmask json (MSB-first, bit = gx*H+gz)
bits=np.zeros(((W*H+7)//8,),np.uint8)
idx=np.nonzero(land.reshape(-1))[0]
bits[idx>>3]|= (128>>(idx&7)).astype(np.uint8)  # careful: per-bit OR
# the vectorized OR above collides on shared bytes — do it safely:
bits[:]=0
for i in idx: bits[i>>3]|=128>>(i&7)
json.dump({'x0':X0,'z0':Z0,'cell':CELL,'w':W,'h':H,'bits':base64.b64encode(bits.tobytes()).decode()},
          open('/Users/david_lietjauw/manhattan-island/public/bk-south-land.json','w'),separators=(',',':'))
# 2) ground mesh: off-plate cells only, greedy row-merge per gx column over gz runs
gc_col=(0.44,0.38,0.31); sand=(0.72,0.66,0.52); marsh=(0.29,0.35,0.25)
offp=land.copy()
OLDPLATES=[(10632,9030,1080),(10170,12906,1613),(11941,13131,794),(11307,16530,2329),(8460,16065,1854),
           (9081,11723,1010),(10406,6645,886),(8771,6360,1582),(9181,9444,947),(5496,12664,974)]
JFK=(14800,20400,1900,6300)
deep=np.zeros((W,H),bool)   # backfill ground at y=1.02: never vanishes when a chunk is LOD/evicted
for gx in range(W):
    x=X0+gx*CELL
    for gz in range(H):
        z=Z0+gz*CELL
        if not (z< -8480 or x>8780 or (z>15400 and x>4900) or (x<1200 and z<-7000)): offp[gx,gz]=False; continue
        if JFK[0]<x<JFK[1] and JFK[2]<z<JFK[3]: offp[gx,gz]=False; continue
        for cx0,cz0,rr in OLDPLATES:
            if (x-cx0)**2+(z-cz0)**2 < rr*rr: offp[gx,gz]=False; deep[gx,gz]=(cx0!=5496); break  # full backfill (old chunks painted full plates); LGA circle stays land-gated (straddles Flushing Bay)
# east-Queens land bitmask (qn-east-land.json, CD5/6/7 + Glendale + cemetery belt): landOK already
# treats these as land; give them permanent resident ground too (their only ground was inside the
# streamed chunks' baked plates -> water pools whenever a chunk was in LOD state or evicted).
import base64 as _b64
try:
    QE=json.load(open('/Users/david_lietjauw/manhattan-island/public/qn-east-land.json'))
    qb=_b64.b64decode(QE['bits'])
    for gx in range(W):
        x=X0+gx*CELL+CELL/2
        qgx=int((x-QE['x0'])//QE['cell'])
        if not (0<=qgx<QE['w']): continue
        for gz in range(H):
            z=Z0+gz*CELL+CELL/2
            qgz=int((z-QE['z0'])//QE['cell'])
            if not (0<=qgz<QE['h']): continue
            k=qgx*QE['h']+qgz
            if (qb[k>>3]>>(7-(k&7)))&1 and not offp[gx,gz]: deep[gx,gz]=True
except Exception as e:
    print('qn-east-land backfill failed:',e)
deep=carve(deep)   # qn-east bits cover Flushing Bay/Creek + FMCP lakes: never backfill real water
print('deep backfill cells:',int(deep.sum()))
# beach: southernmost land run edge (Coney/Manhattan Beach) → sand for the 2 cells bordering south water, z<-9300
V=[];F=[];C=[]
def bcell(cx,cz,w,h,col):
    b=len(V); hw=w/2
    for (dx,dz,y) in [(-hw,-hw,1.2),(hw,-hw,1.2),(hw,hw,1.2),(-hw,hw,1.2),(-hw,-hw,h),(hw,-hw,h),(hw,hw,h),(-hw,hw,h)]:
        V.append((cx+dx,y,cz+dz)); C.append(col)
    for f in [(0,2,1),(0,3,2),(4,5,6),(4,6,7),(0,1,5),(0,5,4),(1,2,6),(1,6,5),(2,3,7),(2,7,6),(3,0,4),(3,4,7)]:
        F.append((b+f[0],b+f[1],b+f[2]))
def quad(x0,x1,z0,z1,col):
    b=len(V)
    for (x,z) in [(x0,z0),(x1,z0),(x1,z1),(x0,z1)]: V.append((x,1.12,z)); C.append(col)
    F.append((b,b+2,b+1)); F.append((b,b+3,b+2))
def catof(gx,gz,z0):
    if park[gx,gz]: return 'park'
    rockawayOcean = (X0+gx*CELL)>11000 and z0< -2000 and (X0+gx*CELL)<22600
    return 'base'
for gx in range(W):
    x=X0+gx*CELL
    gz=0
    while gz<H:
        if not offp[gx,gz]: gz+=1; continue
        # sub-run: same (park, marsh) category
        cat=(park[gx,gz], marshm[gx,gz])
        g2=gz
        while g2<H and offp[gx,g2] and (park[gx,g2],marshm[gx,g2])==cat: g2+=1
        z0=Z0+gz*CELL; z1=Z0+g2*CELL
        if cat[1] and not cat[0]:
            quad(x,x+CELL,z0,z1,tuple(int(c*255) for c in marsh)); gz=g2; continue
        if cat[0]:
            quad(x,x+CELL,z0,z1,tuple(int(c*255) for c in (0.30,0.40,0.24)))
            for cz in range(gz,g2):   # canopy scatter (parity with the built boroughs' park trees)
                h=(gx*2654435761 ^ cz*40503)&0xffff
                if h%100<38:
                    tx=x+ (h%37)/37*CELL; tz=Z0+cz*CELL+((h>>6)%41)/41*CELL
                    th=4.5+(h%23)/23*5.5; tw=3.2+(h%13)/13*2.8
                    gcol=(int(255*(0.16+(h%17)/17*0.10)),int(255*(0.30+(h%19)/19*0.14)),int(255*(0.12+(h%11)/11*0.08)))
                    bcell(tx,tz,tw,th,gcol)
            gz=g2; continue
        # sand band: bottom 2 cells of a run that starts below -9300 (faces south water)
        if z0< -9300 or (x>11000 and z0< -2000 and x<22600):
            zs=min(z1,z0+2*CELL)
            quad(x,x+CELL,z0,zs,tuple(int(c*255) for c in sand))
            if zs<z1: quad(x,x+CELL,zs,z1,tuple(int(c*255) for c in (marsh if x>9300 and z0>-8000 else gc_col)))
        else:
            isBkBay = 9300<x<12600 and -6000<z0<400
            isBC = 16000<x<17800 and -2600<z0<900
            col=marsh if (isBkBay or isBC) else gc_col
            quad(x,x+CELL,z0,z1,tuple(int(c*255) for c in col))
        gz=g2
def quad_deep(x0,x1,z0,z1,col):
    b=len(V)
    for (x,z) in [(x0,z0),(x1,z0),(x1,z1),(x0,z1)]: V.append((x,1.02,z)); C.append(col)
    F.append((b,b+2,b+1)); F.append((b,b+3,b+2))
for gx in range(W):
    x=X0+gx*CELL
    gz=0
    while gz<H:
        if not deep[gx,gz]: gz+=1; continue
        g2=gz
        while g2<H and deep[gx,g2]: g2+=1
        quad_deep(x,x+CELL,Z0+gz*CELL,Z0+g2*CELL,tuple(int(c*255) for c in gc_col))
        gz=g2
# on-plate park overlay (legacy plates paint tan; these ride just above at y=1.28)
PGC=tuple(int(c*255) for c in (0.30,0.40,0.24))
def quad_over(x0,x1,z0,z1):
    b=len(V)
    for (x,z) in [(x0,z0),(x1,z0),(x1,z1),(x0,z1)]: V.append((x,1.28,z)); C.append(PGC)
    F.append((b,b+2,b+1)); F.append((b,b+3,b+2))
nover=0
for gx in range(W):
    x=X0+gx*CELL
    gz=0
    while gz<H:
        if not (parkraster[gx,gz] and land[gx,gz] and not offp[gx,gz] and not deep[gx,gz]): gz+=1; continue
        g2=gz
        while g2<H and parkraster[gx,g2] and land[gx,g2] and not offp[gx,g2] and not deep[gx,g2]: g2+=1
        quad_over(x,x+CELL,Z0+gz*CELL,Z0+g2*CELL); nover+=1
        for cz in range(gz,g2):
            h=(gx*2654435761 ^ cz*40503)&0xffff
            if h%100<14:
                tx=x+(h%37)/37*CELL; tz=Z0+cz*CELL+((h>>6)%41)/41*CELL
                bcell(tx,tz,3.4+(h%13)/13*2.4,4.5+(h%23)/23*4.5,(int(255*0.20),int(255*0.34),int(255*0.15)))
        gz=g2
print('on-plate park overlay runs:',nover)
V=np.array(V,np.float32);F=np.array(F,np.uint32);C=np.array(C,np.uint8)
lo=V.min(0);span=V.max(0)-lo;span[span==0]=1;Q=np.round((V-lo)/span*65535).astype('<u2')
i32=1 if len(V)>65535 else 0; idxb=F.astype('<u4') if i32 else F.astype('<u2')
hdr=struct.pack('<IHBBII',0x3143594E,1,i32,0,len(V),len(F))+struct.pack('<6f',*[float(v) for v in span],*[float(v) for v in lo])
open('/Users/david_lietjauw/manhattan-island/public/bk-south-land.bin','wb').write(hdr+Q.tobytes()+C.tobytes()+idxb.tobytes())
print(f'ground mesh: {len(V)}v {len(F)}t -> {(len(hdr)+len(Q.tobytes())+len(C.tobytes())+len(idxb.tobytes()))//1024}KB',flush=True)
