"""
Classify London Underground track as underground / elevated / surface and
find tunnel portals, with clean-up rules so tiny flickers are ignored.

Run (in the folder with ways.geojson):
    python build_portals.py
    python build_portals.py --short-tunnel 150 --short-gap 80 --cluster 60

Needs only Python 3 (no extra packages).
Writes: ways_classified.geojson, portals.geojson

THE RULES
1. A way is UNDERGROUND if tunnel is yes / covered / building_passage,
   or location=underground, or layer is below 0 -- unless tunnel=no
   (a cutting below street level that is still open).
   A way is ELEVATED if it has a bridge/viaduct tag. Everything else is SURFACE.
   Platforms and sidings/crossovers (service tag) are ignored.
2. Short open gap: a stretch of non-tunnel track shorter than --short-gap
   metres that touches tunnel at BOTH ends is treated as tunnel
   (covered, open for a few metres, covered again).
3. Short tunnel: a tunnel shorter than --short-tunnel metres that is cut off
   from all other tunnel (e.g. passing under one structure) is treated as
   not a tunnel.
4. Portal endpoints closer than --cluster metres are merged into one
   portal site (each portal has two tracks, plus junction pieces).
"""
import argparse
import json
import math
from collections import defaultdict

TUNNEL_VALUES = {"yes", "covered", "building_passage"}


# ---------- small helpers ----------
def haversine_m(lon1, lat1, lon2, lat2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 6371000 * 2 * math.asin(math.sqrt(a))


def length_m(coords):
    return sum(haversine_m(a[0], a[1], b[0], b[1]) for a, b in zip(coords, coords[1:]))


def key(pt):
    """Round a coordinate so two ways that share an OSM node get the same key."""
    return (round(pt[0], 6), round(pt[1], 6))


class DSU:
    def __init__(self):
        self.parent = {}

    def find(self, x):
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        self.parent[self.find(a)] = self.find(b)


def components(way_ids, ends_of):
    """Group ways into connected pieces (ways that share an endpoint)."""
    dsu = DSU()
    for i in way_ids:
        a, b = ends_of[i]
        dsu.union(("w", i), ("n", a))
        dsu.union(("w", i), ("n", b))
    groups = defaultdict(list)
    for i in way_ids:
        groups[dsu.find(("w", i))].append(i)
    return list(groups.values())


# ---------- step 1: classify ----------
def classify(props):
    try:
        layer = int(props.get("layer"))
    except (TypeError, ValueError):
        layer = None
    if props.get("tunnel") in TUNNEL_VALUES or props.get("location") == "underground":
        return "U"
    if layer is not None and layer < 0 and props.get("tunnel") != "no":
        return "U"
    if props.get("bridge") not in (None, "", "no"):
        return "E"
    return "S"


def load_track(path):
    with open(path, encoding="utf-8") as f:
        feats = json.load(f)["features"]
    keep = []
    for f in feats:
        p = f["properties"]
        if p.get("railway") not in ("subway", "rail") or p.get("service"):
            continue                      # drop platforms, sidings, crossovers
        c = f["geometry"]["coordinates"]
        keep.append({
            "props": p,
            "coords": c,
            "cls_raw": classify(p),
            "len": length_m(c),
            "ends": (key(c[0]), key(c[-1])),
        })
    return keep


# ---------- steps 2-3: clean-up ----------
def clean(ways, short_gap, short_tunnel):
    under = [w["cls_raw"] == "U" for w in ways]
    ends_of = [w["ends"] for w in ways]
    length = [w["len"] for w in ways]

    # rule 2: fill short open gaps that touch tunnel at two or more points
    if short_gap > 0:
        tunnel_nodes = {k for i, u in enumerate(under) if u for k in ends_of[i]}
        open_ids = [i for i, u in enumerate(under) if not u]
        for comp in components(open_ids, ends_of):
            if sum(length[i] for i in comp) < short_gap:
                nodes = {k for i in comp for k in ends_of[i]}
                if len(nodes & tunnel_nodes) >= 2:
                    for i in comp:
                        under[i] = True

    # rule 3: drop isolated short tunnels
    if short_tunnel > 0:
        tun_ids = [i for i, u in enumerate(under) if u]
        for comp in components(tun_ids, ends_of):
            if sum(length[i] for i in comp) < short_tunnel:
                for i in comp:
                    under[i] = False
    return under


# ---------- step 4: portals ----------
def find_portals(ways, under, cluster_m):
    count = defaultdict(lambda: [0, 0])          # node -> [tunnel ways, other ways]
    for w, u in zip(ways, under):
        for k in w["ends"]:
            count[k][0 if u else 1] += 1
    endpoints = [k for k, (t, o) in count.items() if t and o]

    dsu = DSU()
    for i, a in enumerate(endpoints):
        dsu.find(i)
        for j in range(i):
            if haversine_m(a[0], a[1], endpoints[j][0], endpoints[j][1]) < cluster_m:
                dsu.union(i, j)
    groups = defaultdict(list)
    for i, a in enumerate(endpoints):
        groups[dsu.find(i)].append(a)
    sites = []
    for pts in groups.values():
        sites.append((sum(p[0] for p in pts) / len(pts),
                      sum(p[1] for p in pts) / len(pts), len(pts)))
    return endpoints, sites


def write_geojson(path, features):
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="ways.geojson")
    ap.add_argument("--short-tunnel", type=float, default=100, help="metres")
    ap.add_argument("--short-gap", type=float, default=100, help="metres")
    ap.add_argument("--cluster", type=float, default=50, help="metres")
    a = ap.parse_args()

    ways = load_track(a.input)
    print(f"main-track ways used: {len(ways)} (platforms and sidings dropped)")

    print("\nHow the portal count changes with the clean-up distance")
    print("(same value used for short-gap and short-tunnel):")
    print("  metres | portal endpoints | portal sites")
    for t in (0, 50, 100, 200, 300, 500):
        under = clean(ways, t, t)
        ends, sites = find_portals(ways, under, a.cluster)
        print(f"  {t:6d} | {len(ends):16d} | {len(sites):12d}")

    under = clean(ways, a.short_gap, a.short_tunnel)
    ends, sites = find_portals(ways, under, a.cluster)
    print(f"\nUsing short-gap={a.short_gap:g} m, short-tunnel={a.short_tunnel:g} m, "
          f"cluster={a.cluster:g} m  ->  {len(sites)} portal sites")

    out_ways = []
    for w, u in zip(ways, under):
        cls = "U" if u else ("E" if w["cls_raw"] == "E" else "S")
        p = dict(w["props"], cls=cls, cls_raw=w["cls_raw"], length_m=round(w["len"], 1))
        out_ways.append({"type": "Feature", "properties": p,
                         "geometry": {"type": "LineString", "coordinates": w["coords"]}})
    write_geojson("ways_classified.geojson", out_ways)
    write_geojson("portals.geojson", [
        {"type": "Feature", "properties": {"endpoints": n},
         "geometry": {"type": "Point", "coordinates": [lon, lat]}}
        for lon, lat, n in sites])
    print("wrote ways_classified.geojson and portals.geojson")


if __name__ == "__main__":
    main()
