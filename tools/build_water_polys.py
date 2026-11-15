"""Water polygons from a raw OSM Overpass export + carve a ditch into the terrain grid.

Inputs : export.json (Overpass 'out geom' of natural=water ways/relations), water.json (from build_water.py; Thames centreline
         + level), terrain_orig.bin + terrain.json (viewer terrain grid, never overwritten).
Outputs: water.json (adds "polys"), terrain.bin (carved copy; copy it to the viewer's data/).
Water surface: Thames polygons take the level of the nearest centreline vertex (>= 0 m OD); every other water body takes the lowest
terrain nearby. The ditch depth is a visual choice (DEPTH), not surveyed.
"""
import json, sys, numpy as np, shapely
from shapely.geometry import LineString, Polygon, MultiPolygon, Point
from shapely.ops import polygonize, unary_union
from scipy.spatial import cKDTree
from scipy.ndimage import minimum_filter, binary_dilation
import mapbox_earcut as earcut
from pyproj import Transformer

E0, N0 = 530200.0, 180400.0
DEPTH = 4.0                    # metres the water sits below its own surface level (bed), visual only
tr = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
import glob
exp, _seen = [], set()      # merge every export*.json (Overpass 'out geom'), de-duplicated by OSM type+id
for fn in sorted(glob.glob("export*.json")):
    for e in json.load(open(fn))["elements"]:
        if (e["type"], e["id"]) not in _seen: _seen.add((e["type"], e["id"])); exp.append(e)
print("elements after merge:", len(exp))
wj = json.load(open("water.json")); TP = np.array(wj["thames"]["pts"])      # relative to E0,N0
meta = json.load(open("/home/claude/london-3d/data/terrain.json"))
w, h, xll, yll, cell, nod, sc, fr = (meta[k] for k in ("w", "h", "xll", "yll", "cell", "nodata", "scale", "full_rows"))
T = np.fromfile("terrain_orig.bin", dtype="<i2").reshape(h, w).astype(float)
bad = T == nod; Z = np.where(bad, np.nan, T * sc)

def proj(g):
    a = np.array([(p["lon"], p["lat"]) for p in g]); x, y = tr.transform(a[:, 0], a[:, 1]); return np.c_[x - E0, y - N0]

SKIP = {"wastewater", "fountain", "lock", "salt_pool", "moat"}
polys = []   # (shapely geom, tags)
open_rings = 0
for e in exp:
    t = e.get("tags", {})
    if t.get("water") in SKIP or "geometry" not in e and "members" not in e: continue
    if e["type"] == "way":
        c = proj(e["geometry"])
        if len(c) >= 4 and np.allclose(c[0], c[-1]):
            g = Polygon(c)
            if g.is_valid and g.area > 0: polys.append((g, t))
    elif e["type"] == "relation":
        outer = [LineString(proj(m["geometry"])) for m in e["members"] if m["role"] == "outer" and len(m.get("geometry", [])) > 1]
        inner = [LineString(proj(m["geometry"])) for m in e["members"] if m["role"] == "inner" and len(m.get("geometry", [])) > 1]
        po = list(polygonize(unary_union(outer))) if outer else []
        pi = list(polygonize(unary_union(inner))) if inner else []
        if not po: open_rings += 1; continue
        g = unary_union(po)
        if pi: g = g.difference(unary_union(pi))
        if not g.is_empty: polys.append((g, t))
print("polygons:", len(polys), "relations with no closed outer ring:", open_rings)

# --- Thames-class: tidal river water, or river water touching the centreline
tline = LineString(TP[:, :2]); tree = cKDTree(TP[:, :2])
def is_thames(g, t):
    return (t.get("water") == "river" or t.get("waterway") == "riverbank") and (t.get("tidal") == "yes" or g.distance(tline) < 40)

# stretches of the centreline that no polygon covers (the export ends upstream of ~Kingston): estimated-width channel instead
tz = unary_union([g.buffer(30) for g, t in polys if is_thames(g, t)])
TW = np.array(wj["thames"]["width"]); mid = (TP[:-1, :2] + TP[1:, :2]) / 2
unc = ~shapely.contains_xy(tz, mid[:, 0], mid[:, 1])
fb = unary_union([LineString(TP[i:i + 2, :2]).buffer(float(TW[i:i + 2].mean()) / 2, cap_style="flat") for i in np.nonzero(unc)[0]])
print("centreline segments not covered by polygons:", int(unc.sum()), "of", len(unc), "-> estimated-width channel")
for pg in (fb.geoms if hasattr(fb, "geoms") else [fb]):
    polys.append((pg, {"water": "river", "tidal": "yes", "_estimated": "1"}))
# canal stretches the OSM polygons don't cover (export gaps) get a 10 m ribbon so wide canals don't turn into hairlines between polygon reaches
src = wj.get("canals_src", wj["canals"]); wj["canals_src"] = src
RIB = [c for c in src if not c["u"] and "Canal" in c["name"] and "Feeder" not in c["name"]]
for c in RIB:
    P = np.array(c["pts"])[:, :2]
    if len(P) >= 2: polys.append((LineString(P).buffer(5, cap_style="flat", join_style="round"), {"water": "canal", "_ribbon": "1"}))
wj["canals"] = [c for c in src if c["u"] or c not in RIB]
print("canal stretches turned into ribbons:", len(RIB), "of", len(src))
# coarse terrain minimum (cells 100 m) for the other bodies
Zf = np.where(np.isnan(Z), np.nanmin(Z), Z); Zmin = minimum_filter(Zf, size=5)
def cell_xy():
    c, r = np.meshgrid(np.arange(w), np.arange(h))
    return xll + c * cell + cell / 4 - E0, yll + fr * 50 - r * cell - cell / 4 - N0
CX, CY = cell_xy()
def zmin_at(x, y):
    c = np.clip(np.round((x + E0 - xll - cell / 4) / cell).astype(int), 0, w - 1)
    r = np.clip(np.round((yll + fr * 50 - cell / 4 - (y + N0)) / cell).astype(int), 0, h - 1)
    return Zmin[r, c]

out = {"thames": ([], []), "other": ([], [])}; mask_level = np.full((h, w), np.nan)
nT = nO = 0
pieces = []
for g, t in polys:
    th = is_thames(g, t)
    rib = "_ribbon" in t
    if g.area < (800 if th else 2500) and not rib: continue
    g = g.simplify(2.5)
    for pg in (g.geoms if isinstance(g, MultiPolygon) else [g]):
        if pg.is_empty or (pg.area < 800 and not rib): continue
        pg = Polygon(pg.exterior, [r for r in pg.interiors if Polygon(r).area >= 2500]) if not rib else pg   # bridge piers etc. are tiny holes in the river polygon: fill them
        rings = [np.array(pg.exterior.coords)[:-1]] + [np.array(r.coords)[:-1] for r in pg.interiors]
        V = np.vstack(rings); ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
        tri = earcut.triangulate_float64(V, ends).reshape(-1, 3)
        z0 = None if th else float(zmin_at(V[:, 0], V[:, 1]).min())
        pieces.append([pg, th, V, tri, z0])
# touching non-Thames pieces (canal reaches, basins) share one level so they do not step against each other
from shapely.strtree import STRtree
oth = [k for k, p in enumerate(pieces) if not p[1]]
tr = STRtree([pieces[k][0] for k in oth]); orig = {k: pieces[k][4] for k in oth}; nfix = 0
for a, k in enumerate(oth):
    for b in tr.query(pieces[k][0].buffer(12)):
        j = oth[b]
        if j == k or pieces[k][0].distance(pieces[j][0]) > 12: continue
        if 0 < orig[j] - orig[k] <= 4.5: pieces[j][4] = min(pieces[j][4], orig[k]); nfix += 1
print("water pieces levelled against touching neighbours:", nfix)
for pg, th, V, tri, z0 in pieces:
    if th:
        d, i = tree.query(V); z = np.where(d < 1500, TP[i, 2], np.maximum(zmin_at(V[:, 0], V[:, 1]), 0.0))
    else:
        z = np.full(len(V), float(z0))      # flat lake / basin / reservoir
    if True:
        vs, ix = out["thames" if th else "other"]
        base = len(vs) // 3
        vs.extend(np.c_[V, z].round(1).ravel().tolist()); ix.extend((tri + base).ravel().tolist())
        minx, miny, maxx, maxy = pg.bounds
        sel = (CX >= minx) & (CX <= maxx) & (CY >= miny) & (CY <= maxy)
        rr, cc = np.nonzero(sel)
        if len(rr):
            ins = shapely.contains_xy(pg, CX[rr, cc], CY[rr, cc])
            if ins.any():
                tgt = (zmin_at(CX[rr, cc][ins], CY[rr, cc][ins]) if not th else
                       np.where(tree.query(np.c_[CX[rr, cc][ins], CY[rr, cc][ins]])[0] < 1500, TP[tree.query(np.c_[CX[rr, cc][ins], CY[rr, cc][ins]])[1], 2],
                                np.maximum(zmin_at(CX[rr, cc][ins], CY[rr, cc][ins]), 0.0)))
                lv = float(z.min()) if not th else None
                mask_level[rr[ins], cc[ins]] = tgt if th else lv
        nT += th; nO += (not th)
print("triangulated: thames polys", nT, "other", nO, "| vertices", len(out["thames"][0]) // 3, len(out["other"][0]) // 3)

# --- carve: cells inside water drop to level - DEPTH (never raised); one ring of cells around gets half way down
inside = ~np.isnan(mask_level)
carved = Z.copy()
bed = mask_level - DEPTH
carved[inside] = np.minimum(np.where(np.isnan(carved[inside]), bed[inside], carved[inside]), bed[inside])
ring = binary_dilation(inside, iterations=1) & ~inside & ~bad
nb = np.where(inside, bed, np.inf)
nbmin = minimum_filter(nb, size=3)
half = 0.5 * (Z + nbmin)
carved[ring] = np.minimum(carved[ring], half[ring])
q = np.where(bad, nod, np.round(carved / sc)).astype("<i2"); q.tofile("terrain.bin")
print("carved cells:", int(inside.sum()), "ring:", int(ring.sum()))
wj["polys"] = {k: {"v": v[0], "i": v[1]} for k, v in out.items()}
wj["depth"] = DEPTH
json.dump(wj, open("water.json", "w"), separators=(",", ":"))
import os; print("water.json %.2f MB" % (os.path.getsize("water.json") / 1e6))
