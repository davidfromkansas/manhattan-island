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
X0,X1,Z0,Z1=1200,12600,-11900,400
W=int((X1-X0)//CELL); H=int((Z1-Z0)//CELL)
mask=np.zeros((W,H),bool)
t0=time.time()
for T in ['BK10','BK11','BK12','BK13','BK14','BK15','BK16','BK17','BK18']:
    m=rhino3dm.File3dm.Read(f'/Users/david_lietjauw/Downloads/NYC_3DModel_{T}.3dm')
    layers={i:l.FullPath for i,l in enumerate(m.Layers)}
    n=0
    for o in m.Objects:
        lp=layers[o.Attributes.LayerIndex]
        if 'oot' not in lp or 'urface' not in lp: continue
        g=o.Geometry
        try: bb=g.GetBoundingBox()
        except: continue
        cx=(bb.Min.X+bb.Max.X)/2; cy=(bb.Min.Y+bb.Max.Y)/2
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
for (la,lo,rx,rz) in [(40.6015,-73.9155,600,850),(40.5885,-73.8925,750,950)]:  # Marine Park (E of Gerritsen Ck), Floyd Bennett Field
    px,pz=geoRaw_ll(la,lo)
    g0=int((px-rx-X0)//CELL); g1=int((px+rx-X0)//CELL); h0=int((pz-rz-Z0)//CELL); h1=int((pz+rz-Z0)//CELL)
    land[max(0,g0):min(W,g1), max(0,h0):min(H,h1)]=True
    park[max(0,g0):min(W,g1), max(0,h0):min(H,h1)]=True
land=carve(land)
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
for gx in range(W):
    x=X0+gx*CELL
    for gz in range(H):
        z=Z0+gz*CELL
        if not (z< -8480 or x>8780): offp[gx,gz]=False
# beach: southernmost land run edge (Coney/Manhattan Beach) → sand for the 2 cells bordering south water, z<-9300
V=[];F=[];C=[]
def quad(x0,x1,z0,z1,col):
    b=len(V)
    for (x,z) in [(x0,z0),(x1,z0),(x1,z1),(x0,z1)]: V.append((x,1.12,z)); C.append(col)
    F.append((b,b+2,b+1)); F.append((b,b+3,b+2))
for gx in range(W):
    x=X0+gx*CELL
    gz=0
    while gz<H:
        if not offp[gx,gz]: gz+=1; continue
        g2=gz
        while g2<H and offp[gx,g2]: g2+=1
        z0=Z0+gz*CELL; z1=Z0+g2*CELL
        # sand band: bottom 2 cells of a run that starts below -9300 (faces south water)
        pk=park[gx,(gz)] if gz<H else False
        if pk:
            quad(x,x+CELL,z0,z1,tuple(int(c*255) for c in (0.30,0.40,0.24)))
        elif z0< -9300:
            zs=min(z1,z0+2*CELL)
            quad(x,x+CELL,z0,zs,tuple(int(c*255) for c in sand))
            if zs<z1: quad(x,x+CELL,zs,z1,tuple(int(c*255) for c in (marsh if x>9300 and z0>-8000 else gc_col)))
        else:
            col=marsh if (x>9300 and z0>-6000) else gc_col
            quad(x,x+CELL,z0,z1,tuple(int(c*255) for c in col))
        gz=g2
V=np.array(V,np.float32);F=np.array(F,np.uint32);C=np.array(C,np.uint8)
lo=V.min(0);span=V.max(0)-lo;span[span==0]=1;Q=np.round((V-lo)/span*65535).astype('<u2')
i32=1 if len(V)>65535 else 0; idxb=F.astype('<u4') if i32 else F.astype('<u2')
hdr=struct.pack('<IHBBII',0x3143594E,1,i32,0,len(V),len(F))+struct.pack('<6f',*[float(v) for v in span],*[float(v) for v in lo])
open('/Users/david_lietjauw/manhattan-island/public/bk-south-land.bin','wb').write(hdr+Q.tobytes()+C.tobytes()+idxb.tobytes())
print(f'ground mesh: {len(V)}v {len(F)}t -> {(len(hdr)+len(Q.tobytes())+len(C.tobytes())+len(idxb.tobytes()))//1024}KB',flush=True)
