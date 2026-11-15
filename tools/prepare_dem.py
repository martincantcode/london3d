"""Merge the OS Terrain 50 tiles that cover the London network into one small file.

Usage (from the folder that holds stations.geojson and ways.geojson):
    pip install pyproj numpy          # once, inside your .venv
    python prepare_dem.py --data terr50_gagg_gb/data

Writes dem_london.npz (a few MB). Upload that file to the chat.
Heights are metres above Ordnance Datum Newlyn (ODN), stored as integer decimetres.
Contains OS data (c) Crown copyright and database right 2026.
"""
import argparse, glob, io, json, math, os, sys, zipfile
import numpy as np
from pyproj import Transformer

LETTERS = "ABCDEFGHJKLMNOPQRSTUVWXYZ"  # no I


def tile_name(e, n):
    """OS grid reference of the 10 km tile containing easting e, northing n, e.g. 'tq27'."""
    e100, n100 = int(e // 100000), int(n // 100000)
    l1 = (19 - n100) - (19 - n100) % 5 + (e100 + 10) // 5
    l2 = (19 - n100) * 5 % 25 + e100 % 5
    sq = LETTERS[l1] + LETTERS[l2]
    return sq.lower() + str(int(e % 100000) // 10000) + str(int(n % 100000) // 10000)


def lonlat_bounds(paths):
    xs, ys = [], []

    def walk(c):
        if isinstance(c[0], (int, float)):
            xs.append(c[0]); ys.append(c[1])
        else:
            for k in c:
                walk(k)

    for p in paths:
        if os.path.exists(p):
            for ft in json.load(open(p, encoding="utf-8"))["features"]:
                walk(ft["geometry"]["coordinates"])
        else:
            print("  (not found, skipped:", p, ")")
    return min(xs), min(ys), max(xs), max(ys)


def read_asc(zpath, xll, yll):
    """Read one tile. Works with or without the 6 ESRI header lines; without them the tile is
    taken to be 200 x 200 cells of 50 m with its lower-left corner at (xll, yll)."""
    with zipfile.ZipFile(zpath) as z:
        asc = [n for n in z.namelist() if n.lower().endswith(".asc")]
        if not asc:
            raise RuntimeError(f"no .asc inside {zpath}; it contains {z.namelist()}")
        text = z.read(asc[0]).decode("ascii", "ignore")
    lines = text.splitlines()
    hdr = {"xllcorner": xll, "yllcorner": yll, "cellsize": 50.0}
    n_hdr = 0                                        # header = leading lines that start with a word
    for l in lines[:10]:
        t = l.split()
        if t and t[0].replace("_", "").isalpha():
            hdr[t[0].lower()] = float(t[1]); n_hdr += 1
        else:
            break
    body = lines[n_hdr:]
    body = [l for l in body if l.strip()]
    grid = np.array([l.split() for l in body], dtype=np.float32)
    if grid.shape != (200, 200) or hdr["cellsize"] != 50.0:
        raise RuntimeError(f"unexpected tile shape {grid.shape} (cell {hdr['cellsize']}) in {zpath}; files: {zipfile.ZipFile(zpath).namelist()}")
    return hdr, grid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="the 'data' folder inside terr50_gagg_gb")
    ap.add_argument("--stations", default="stations.geojson")
    ap.add_argument("--ways", default="ways.geojson")
    ap.add_argument("--margin", type=float, default=3000, help="metres around the network")
    ap.add_argument("--out", default="dem_london.npz")
    a = ap.parse_args()

    x0, y0, x1, y1 = lonlat_bounds([a.stations, a.ways])
    print(f"network extent lon {x0:.3f}..{x1:.3f}, lat {y0:.3f}..{y1:.3f}")
    tr = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
    pts = [tr.transform(x, y) for x in (x0, x1) for y in (y0, y1)]
    emin = min(p[0] for p in pts) - a.margin; emax = max(p[0] for p in pts) + a.margin
    nmin = min(p[1] for p in pts) - a.margin; nmax = max(p[1] for p in pts) + a.margin
    te0, te1 = int(emin // 10000), int(emax // 10000)
    tn0, tn1 = int(nmin // 10000), int(nmax // 10000)
    wanted = [(te, tn) for te in range(te0, te1 + 1) for tn in range(tn0, tn1 + 1)]
    print(f"need {len(wanted)} tiles")

    W = (te1 - te0 + 1) * 200
    H = (tn1 - tn0 + 1) * 200
    mosaic = np.full((H, W), np.nan, dtype=np.float32)
    xll, yll = te0 * 10000.0, tn0 * 10000.0
    found, missing = 0, []
    for te, tn in wanted:
        name = tile_name(te * 10000 + 1, tn * 10000 + 1)
        hits = glob.glob(os.path.join(a.data, name[:2], name + "_OST50GRID_*.zip"))
        if not hits:
            missing.append(name); continue
        hdr, g = read_asc(sorted(hits)[-1], te * 10000.0, tn * 10000.0)
        g[g <= -9998] = np.nan
        c0 = int(round((hdr["xllcorner"] - xll) / 50))
        r0 = H - int(round((hdr["yllcorner"] - yll) / 50)) - g.shape[0]
        mosaic[r0:r0 + g.shape[0], c0:c0 + g.shape[1]] = g
        found += 1
    print(f"tiles read: {found}; tiles with no file: {missing if missing else 'none'}")
    if found == 0:
        sys.exit("No tiles found. Check that --data points at the 'data' folder that contains the 'tq', 'su' ... folders.")
    ok = ~np.isnan(mosaic)
    print(f"cells with data: {ok.sum()} of {mosaic.size}; height range {np.nanmin(mosaic):.1f} to {np.nanmax(mosaic):.1f} m")

    z = np.where(ok, np.round(mosaic * 10), -32768).astype(np.int16)  # decimetres
    np.savez_compressed(a.out, z_dm=z, xll=xll, yll=yll, cell=50.0, nodata=-32768)
    print(f"wrote {a.out} ({os.path.getsize(a.out)/1e6:.1f} MB). Please upload it to the chat.")


if __name__ == "__main__":
    main()
