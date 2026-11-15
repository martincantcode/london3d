"""
Build data/roads.json (faint street grid for the 3D viewer) from Overpass exports.

Put these two files next to this script (made with the queries in the README / chat; `out skel geom;` keeps them small):
    roads_major.json   motorway, trunk, primary, secondary roads over the whole area
    roads_minor.json   tertiary, unclassified, residential, living_street roads around the centre
Run:   python build_roads.py            (needs: pip install pyproj shapely numpy)
Reads  data/terrain.json (for the map extent), writes data/roads.json.
Coordinates are metres east/north of Charing Cross (OSGB 530200, 180400), the same origin as the rest of the viewer.
"""
import json, os, sys
import numpy as np
from pyproj import Transformer
from shapely.geometry import LineString, box

E0, N0 = 530200.0, 180400.0
HERE = os.path.dirname(os.path.abspath(__file__))
tr = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)

meta = json.load(open(os.path.join(HERE, "data", "terrain.json")))
x_lo = meta["xll"] - E0; x_hi = x_lo + meta["w"] * meta["cell"]
n_hi = meta["yll"] + meta["full_rows"] * 50 - N0; n_lo = n_hi - meta["h"] * meta["cell"]
frame = box(x_lo, n_lo, x_hi, n_hi)

def load(name, tol):
    fn = os.path.join(HERE, name)
    if not os.path.exists(fn):
        print("missing", name, "- skipped"); return {"c": [], "o": []}
    coords, offs, nways = [], [0], 0
    for e in json.load(open(fn, encoding="utf-8"))["elements"]:
        g = e.get("geometry")
        if e.get("type") != "way" or not g or len(g) < 2: continue
        lon = np.array([p["lon"] for p in g]); lat = np.array([p["lat"] for p in g])
        x, y = tr.transform(lon, lat); line = LineString(np.c_[x - E0, y - N0])
        if not line.intersects(frame): continue
        line = line.simplify(tol)
        for part in (line.intersection(frame).geoms if hasattr(line.intersection(frame), "geoms") else [line.intersection(frame)]):
            if part.is_empty or part.geom_type != "LineString" or len(part.coords) < 2: continue
            pts = np.round(np.array(part.coords)).astype(int)
            coords.extend(pts.ravel().tolist()); offs.append(offs[-1] + len(pts)); nways += 1
    print(name, nways, "ways,", len(coords) // 2, "points")
    return {"c": coords, "o": offs}

out = {"major": load("roads_major.json", 3.0), "minor": load("roads_minor.json", 4.0)}
fn = os.path.join(HERE, "data", "roads.json")
json.dump(out, open(fn, "w"), separators=(",", ":"))
print("wrote", fn, "%.1f MB" % (os.path.getsize(fn) / 1e6))
