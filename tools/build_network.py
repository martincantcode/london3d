"""Step 1b: build the 3D network (both tracks) from OSM route relations + platform levels + terrain.

Inputs (same folder): raw_lines.json, stations.geojson, ways_classified.geojson, ways.geojson,
                      station_levels.csv, dem_london.npz
Outputs: network.json  (+ diagnostics printed)

Method
  * every route relation is rebuilt as one path by following how its ways connect
  * platform levels (station_levels.csv) are anchors along each path; portals (surface <-> underground
    changes, from ways_classified.geojson) are anchors that sit exactly on the terrain
  * underground stretches: absolute height, eased between anchors (flat for PLATFORM_M around a station)
  * surface stretches: terrain height + a smoothly blended offset
"""
import csv, collections, json, math, sys
import numpy as np
from pyproj import Transformer

SMOOTH_M = 300.0           # surface terrain is averaged over +-SMOOTH_M along the track (real railways are graded, not bumpy)
PLATFORM_M = 60.0          # flat stretch each side of a station anchor (metres of track)
MAX_STOP_TO_STATION = 300  # m
MAX_STOP_TO_PATH = 60      # m
G_MAX = 0.05               # max gradient allowed between a station and a portal near it (m per m)

tr = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
E0, N0 = 530200.0, 180400.0          # Charing Cross: local origin of the output coordinates

# ---------- the viewer's own terrain (carved grid): every height in the network is referenced to this, so track and ground always agree ----------
_tm = json.load(open("/home/claude/london-3d/data/terrain.json"))
_tz = np.fromfile("/home/claude/london-3d/data/terrain.bin", dtype=np.int16).reshape(_tm["h"], _tm["w"]).astype(float)
_tz = np.where(_tz == _tm["nodata"], 0.0, _tz * _tm["scale"])
def gsample(E, N):
    c = (np.asarray(E) - _tm["xll"] - _tm["cell"] / 4) / _tm["cell"]
    r = (_tm["yll"] + _tm["full_rows"] * 50 - _tm["cell"] / 4 - np.asarray(N)) / _tm["cell"]
    c0 = np.clip(np.floor(c), 0, _tm["w"] - 2).astype(int); r0 = np.clip(np.floor(r), 0, _tm["h"] - 2).astype(int)
    fx = np.clip(c - c0, 0, 1); fy = np.clip(r - r0, 0, 1)
    return (_tz[r0, c0] * (1 - fx) + _tz[r0, c0 + 1] * fx) * (1 - fy) + (_tz[r0 + 1, c0] * (1 - fx) + _tz[r0 + 1, c0 + 1] * fx) * fy

# ---------- terrain (raw) ----------
D = np.load("dem_london.npz")
Z = D["z_dm"].astype(float) / 10.0
Z[D["z_dm"] == -32768] = np.nan
XLL, YLL = float(D["xll"]), float(D["yll"])
H, W = Z.shape


def dem(E, N):
    E = np.asarray(E, float); N = np.asarray(N, float)
    fc = (E - XLL) / 50 - 0.5; fr = H - (N - YLL) / 50 - 0.5
    c0 = np.clip(np.floor(fc).astype(int), 0, W - 2); r0 = np.clip(np.floor(fr).astype(int), 0, H - 2)
    tc = np.clip(fc - c0, 0, 1); trr = np.clip(fr - r0, 0, 1)
    return (Z[r0, c0] * (1 - tc) * (1 - trr) + Z[r0, c0 + 1] * tc * (1 - trr)
            + Z[r0 + 1, c0] * (1 - tc) * trr + Z[r0 + 1, c0 + 1] * tc * trr)


# ---------- inputs ----------
rels = [r for r in json.load(open("raw_lines.json"))["elements"] if "sidings" not in r["tags"].get("name", "")]
stations = [(f["properties"]["name"], f["geometry"]["coordinates"]) for f in json.load(open("stations.geojson"))["features"]]
cls_by_way = {f["properties"]["way_id"]: f["properties"]["cls"] for f in json.load(open("ways_classified.geojson"))["features"]}
import os
COVER_PASS = os.environ.get("COVER_PASS") == "1"          # pass 1: measure how far below ground the platform levels put each 'surface' way
if os.path.exists("cls_override.json") and not COVER_PASS:  # pass 2: ways OSM calls surface but that run between platforms below ground are covered (cut-and-cover)
    for k, v in json.load(open("cls_override.json")).items(): cls_by_way[int(k)] = v
off_by_way = collections.defaultdict(list)
levels = {}
for r in csv.DictReader(open("station_levels.csv")):
    levels[(r["line"], r["osm_station"], r["branch"])] = float(r["platform_m_OD"])
line_stations = collections.defaultdict(set)
for (ln, n, br) in levels: line_stations[ln].add(n)
st_xy = {n: tr.transform(*c) for n, c in stations}


def dist(a, b): return math.hypot(a[0] - b[0], a[1] - b[1])


# ---------- rebuild each relation as ordered ways ----------
def key(p): return (round(p[0], 6), round(p[1], 6))


def order_ways(members):
    ws, seen = [], set()
    for i, m in enumerate(members):
        if m["type"] == "way" and m.get("role", "") == "" and m["ref"] not in seen:
            seen.add(m["ref"]); ws.append((i, m["ref"], [(p["lon"], p["lat"]) for p in m["geometry"]]))
    ends = collections.defaultdict(list)
    for j, (i, wid, c) in enumerate(ws):
        ends[key(c[0])].append((j, 0)); ends[key(c[-1])].append((j, 1))
    used, comps = set(), []

    def walk(j, e):
        path = []
        while True:
            used.add(j); wid, c = ws[j][1], ws[j][2]
            rev = (e == 1); c = c[::-1] if rev else c
            path.append((wid, rev, c))
            cand = [(jj, ee) for jj, ee in ends[key(c[-1])] if jj not in used]
            if not cand: return path
            cand.sort(key=lambda t: ws[t[0]][0]); j, e = cand[0]
    dead = [(j, e) for node, l in ends.items() if len(l) == 1 for (j, e) in l]
    for j, e in sorted(dead, key=lambda t: ws[t[0]][0]):
        if j not in used: comps.append(walk(j, e))
    for j in range(len(ws)):
        if j not in used: comps.append(walk(j, 0))
    return comps


def smooth(t, a_station, b_station):
    t = min(max(t, 0.0), 1.0)
    if a_station and b_station: return t * t * (3 - 2 * t)
    if a_station: return t * t
    if b_station: return 1 - (1 - t) ** 2
    return t


ways_gnd = collections.defaultdict(list)     # way_id -> smoothed terrain per vertex (same ground the surface track uses)
ways_xyz = collections.defaultdict(list)     # way_id -> list of arrays (z per vertex, in OSM way direction)
way_geo = {}                                  # way_id -> (lonlat coords in OSM direction)
way_line = collections.defaultdict(set)
rel_out = []
st_rec = []; portal_rec = []
diag = collections.Counter(); problems = []

for r in rels:
    ref, name = r["tags"]["ref"], r["tags"].get("name", "")
    for comp in order_ways(r["members"]):
        coords, wid_v, cls_v, rev_v = [], [], [], []
        for wid, rev, c in comp:
            cl = cls_by_way.get(wid, None)
            if cl is None: diag["way without cleaned class"] += 1; cl = "S"
            coords += c; wid_v += [wid] * len(c); cls_v += [cl] * len(c); rev_v += [rev] * len(c)
            if wid not in way_geo: way_geo[wid] = c if not rev else c[::-1]
            way_line[wid].add(ref)
        P = np.array([tr.transform(*p) for p in coords])
        seg = np.hypot(*np.diff(P, axis=0).T); s = np.concatenate([[0], np.cumsum(seg)])
        ground = gsample(P[:, 0], P[:, 1])             # the ground exactly as the viewer draws it (same grid, same interpolation)
        isU = np.array([c == "U" for c in cls_v])
        # ----- anchors -----
        anchors = []   # (s, z_abs, offset, is_station)
        stops = [m for m in r["members"] if m["type"] == "node" and m.get("role", "").startswith("stop")]
        branch = "Bank" if "Bank" in name else ("Charing Cross" if "Charing Cross" in name else "")
        used_st = set()
        for m in stops:
            xy = tr.transform(m["lon"], m["lat"])
            cand = [(dist(xy, st_xy[n]), n) for n in line_stations[ref]]
            dd, n = min(cand)
            if dd > MAX_STOP_TO_STATION: problems.append((name, "stop far from any station", round(dd))); continue
            lv = levels.get((ref, n, branch)) if (ref, n, branch) in levels else levels.get((ref, n, ""))
            if lv is None:
                alts = [v for (l2, n2, b2), v in levels.items() if l2 == ref and n2 == n]
                lv = alts[0] if alts else None
            if lv is None: problems.append((name, "no level", n)); continue
            dpt = np.hypot(P[:, 0] - xy[0], P[:, 1] - xy[1]); i = int(dpt.argmin())
            if dpt[i] > MAX_STOP_TO_PATH: problems.append((name, "stop not on path", n, round(float(dpt[i])))); continue
            if n in used_st: continue
            used_st.add(n)
            if not COVER_PASS and not isU[i] and lv < ground[i]: lv = float(ground[i]); diag["surface stations lifted to ground"] += 1
            anchors.append((float(s[i]), lv, lv - float(ground[i]), True, n, i, branch))
        # portals: boundaries where U / non-U changes
        for i in range(1, len(P)):
            if isU[i] != isU[i - 1] and wid_v[i] != wid_v[i - 1]:
                anchors.append((float(s[i]), float(ground[i]), 0.0, False, "portal", i, ""))
        anchors.sort(key=lambda a: a[0])
        # a tunnel runs from its mouth (at the ground) to the platform at a real railway gradient: a platform that would lie deeper than
        # G_MAX allows (stations right next to a portal) is raised to the steepest permitted depth, so the line never drops off a cliff
        for i, a in enumerate(anchors):
            if not (a[3] and isU[a[5]]): continue
            zmin = max([b_[1] - G_MAX * abs(b_[0] - a[0]) for b_ in anchors if not b_[3]] + [-1e9])
            if a[1] < zmin and not COVER_PASS:
                anchors[i] = (a[0], zmin, zmin - float(ground[a[5]]), a[3], a[4], a[5], a[6]); diag["platforms raised to gradient"] += 1; diag["raised by m"] += int(round(zmin - a[1]))
        # drop stations that sit at (almost) the same s as an earlier one
        z = np.empty(len(P))
        if not anchors:
            z[:] = ground; diag["path without anchors"] += 1
        else:
            A = anchors
            for k in range(len(P)):
                sk = s[k]
                if sk <= A[0][0]: seg_ = (None, A[0])
                elif sk >= A[-1][0]: seg_ = (A[-1], None)
                else:
                    j = max(i for i in range(len(A)) if A[i][0] <= sk)
                    j = min(j, len(A) - 2); seg_ = (A[j], A[j + 1])
                a, b = seg_
                under = isU[k]
                if a is None or b is None:
                    an = b if a is None else a
                    z[k] = an[1] if under else ground[k] + an[2]
                    continue
                pa = PLATFORM_M if a[3] else 0.0; pb = PLATFORM_M if b[3] else 0.0
                lo, hi = a[0] + pa, b[0] - pb
                if hi - lo < 0.2 * (b[0] - a[0]): lo, hi = a[0] + 0.4 * (b[0] - a[0]), b[0] - 0.4 * (b[0] - a[0])
                t = (sk - lo) / (hi - lo) if hi > lo else 0.5
                f = smooth(t, a[3], b[3])
                z[k] = (a[1] + (b[1] - a[1]) * f) if under else ground[k] + a[2] + (b[2] - a[2]) * f   # tunnels: graded between anchors; surface: terrain + blended offset
        # bridges / viaducts (class E) with no station on them: straight between the two ends, not down into the valley
        isE = np.array([c == "E" for c in cls_v]); k = 0; n_br = 0
        st_s = [a[0] for a in anchors if a[3]]
        while k < len(P):
            if isE[k]:
                j = k
                while j + 1 < len(P) and isE[j + 1]: j += 1
                if k > 0 and j < len(P) - 1 and not any(s[k] <= x <= s[j] for x in st_s):
                    za, zb, sa, sb = z[k - 1], z[j + 1], s[k - 1], s[j + 1]
                    if sb > sa:
                        z[k:j + 1] = za + (zb - za) * (s[k:j + 1] - sa) / (sb - sa); n_br += 1
                k = j + 1
            else: k += 1
        diag["bridge runs flattened"] += n_br
        # hard rule: tunnels never above the ground, surface track never below it
        if COVER_PASS:
            for k in range(len(P)):
                if not isU[k] and not isE[k]: off_by_way[wid_v[k]].append(float(z[k] - ground[k]))
        z2 = z if COVER_PASS else np.where(isU, np.minimum(z, ground), np.maximum(z, ground)); diag["vertices snapped to ground side"] += int((np.abs(z2 - z) > 0.05).sum()); z = z2
        for a in anchors:
            rec = (ref, a[4], a[6], float(P[a[5], 0]), float(P[a[5], 1]), float(z[a[5]]), float(ground[a[5]]))
            if a[3]: st_rec.append(rec)
            else:   # portals also carry the direction of the track through them (so the viewer can stand the tunnel mouth across it)
                i0, i1 = max(a[5] - 1, 0), min(a[5] + 1, len(P) - 1); hv = P[i1] - P[i0]; hv = hv / (np.hypot(*hv) or 1.0)
                portal_rec.append(rec + (float(hv[0]), float(hv[1])))
        # store per way (back in OSM way direction)
        for wid in set(wid_v):
            idx = [k for k in range(len(P)) if wid_v[k] == wid]
            zz = z[idx]
            if rev_v[idx[0]]: zz = zz[::-1]
            ways_xyz[wid].append(zz)
            gz = ground[idx]
            ways_gnd[wid].append(gz[::-1] if rev_v[idx[0]] else gz)
        rel_out.append({"name": name, "line": ref, "ways": [[wid, 1 if rev else 0] for wid, rev, _ in comp],
                        "stations": [[a[4], round(a[0])] for a in anchors if a[3]]})
        diag["paths"] += 1

# ---------- merge relation results per way ----------
spread = []
out_ways = []
all_lonlat = []
for wid, arrs in ways_xyz.items():
    zs = np.vstack(arrs); zm = zs.mean(0); gm = np.vstack(ways_gnd[wid]).mean(0)
    spread.append(float((zs.max(0) - zs.min(0)).max()))
    c = way_geo[wid]; Pm = np.array([tr.transform(*p) for p in c])
    ow = {"id": wid, "cls": cls_by_way.get(wid, "S"), "lines": sorted(way_line[wid]),
          "pts": [[round(x - E0, 1), round(y - N0, 1), round(zz, 1)] for (x, y), zz in zip(Pm, zm)]}
    if ow["cls"] == "U": ow["g"] = [round(float(v), 1) for v in gm]      # ground height under each tunnel vertex (for the on-ground route)
    out_ways.append(ow)
spread = np.array(spread)
print("ways:", len(out_ways), "relation paths:", diag["paths"], dict(diag))
print("height disagreement between relations sharing a way (max over vertices): median %.2f m, p90 %.1f, p99 %.1f, max %.1f; ways with >3 m: %d" % (
    np.median(spread), np.percentile(spread, 90), np.percentile(spread, 99), spread.max(), (spread > 3).sum()))
print("problems:", len(problems))
for p in problems[:40]: print("  ", p)
colours = {r["tags"]["ref"]: r["tags"].get("colour", "#888") for r in rels}
net = {"origin_osgb": [E0, N0], "units": "metres, x=east y=north z=height above OD (Newlyn)",
       "line_colours": colours, "ways": out_ways, "relations": rel_out}
json.dump(net, open("network.json", "w"), separators=(",", ":"))
import os
print("network.json %.2f MB" % (os.path.getsize("network.json") / 1e6))

# ---------- stations & portals ----------
import re
def clean(n):
    n = re.sub(r"\s*\(.*?\)", "", n).strip()
    return {"London Liverpool Street": "Liverpool Street", "Totteridge & Whetstone": "Totteridge & Whetstone"}.get(n, n)
per = collections.defaultdict(list)
for ref, n, br, x, y, zz, gg in st_rec: per[(ref, n, br)].append((x, y, zz, gg))
members = []
for (ref, n, br), v in per.items():
    a = np.array(v).mean(0); members.append({"line": ref, "name": clean(n), "x": a[0], "y": a[1], "z": a[2], "g": a[3]})
groups = []
for m in sorted(members, key=lambda m: m["name"]):
    for g in groups:
        if g["name"] == m["name"] and math.hypot(g["x"] - m["x"], g["y"] - m["y"]) < 300:
            g["members"].append(m); g["x"] = np.mean([k["x"] for k in g["members"]]); g["y"] = np.mean([k["y"] for k in g["members"]]); break
    else: groups.append({"name": m["name"], "x": m["x"], "y": m["y"], "members": [m]})
st_out = []
for g in groups:
    gz = float(np.mean([m["g"] for m in g["members"]]))   # smoothed terrain at the platform anchors: the same ground the tunnel route and surface track use
    st_out.append({"name": g["name"], "x": round(g["x"] - E0, 1), "y": round(g["y"] - N0, 1), "ground": round(gz, 1),
                   "platforms": [[m["line"], round(m["x"] - E0, 1), round(m["y"] - N0, 1), round(m["z"], 1)] for m in g["members"]]})
cells = {}
for ref, n, br, x, y, zz, gg, hx, hy in portal_rec:
    cells.setdefault((round(x / 40), round(y / 40)), (x, y, zz, hx, hy))
por_out = [[round(x - E0, 1), round(y - N0, 1), round(zz, 1), round(hx, 3), round(hy, 3)] for x, y, zz, hx, hy in cells.values()]
net["stations"] = st_out; net["portals"] = por_out
json.dump(net, open("network.json", "w"), separators=(",", ":"))
print("stations:", len(st_out), "platform markers:", len(members), "portals:", len(por_out), "network.json %.2f MB" % (os.path.getsize("network.json") / 1e6))

if COVER_PASS:
    json.dump({str(k): v for k, v in off_by_way.items()}, open("cover_offsets.json", "w"))
    print("pass 1 written")
