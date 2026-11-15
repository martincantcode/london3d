"""
Download the River Thames and the canals around London from OpenStreetMap (Overpass API).

Run:   python fetch_osm_water.py
Needs: Python 3 and `requests`
Writes (in the current folder): raw_canals.json, raw_thames_lines.json, raw_thames_areas.json
        Files already present are not downloaded again. Upload the three files to the chat.

NOT tested against the live Overpass server (the sandbox I wrote it in cannot reach it);
only checked for syntax. Same retry/mirror logic as fetch_osm_tube.py, which worked for you.
"""
import json, os, sys, time
import requests

SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"]
BBOX = "51.35,-0.70,51.75,0.32"
HEADERS = {"User-Agent": "london-tube-3d-map/0.1 (personal project)"}

QUERIES = {
    # every canal segment (Regent's Canal, Grand Union, Limehouse Cut ...), with tags
    "raw_canals.json": f'[out:json][timeout:180];way["waterway"="canal"]({BBOX});out tags geom;',
    # the Thames as a line (and its tidal/side channels named Thames)
    "raw_thames_lines.json": f'[out:json][timeout:180];way["waterway"="river"]["name"~"Thames"]({BBOX});out tags geom;',
    # the Thames as water AREAS (banks to banks): named water bodies and river-bank polygons
    "raw_thames_areas.json": (f'[out:json][timeout:240];('
                              f'way["natural"="water"]["name"~"Thames"]({BBOX});'
                              f'relation["natural"="water"]["name"~"Thames"]({BBOX});'
                              f'way["waterway"="riverbank"]["name"~"Thames"]({BBOX});'
                              f'relation["waterway"="riverbank"]["name"~"Thames"]({BBOX});'
                              f');out tags geom;'),
}


def run(query, cache):
    if os.path.exists(cache):
        print("  using cached", cache); return json.load(open(cache, encoding="utf-8"))
    last = None
    for rnd in range(1, 5):
        for url in SERVERS:
            try:
                print(f"  {url} (round {rnd}) ...", flush=True)
                r = requests.post(url, data={"data": query}, headers=HEADERS, timeout=300)
                if r.status_code in (429, 502, 503, 504):
                    last = f"HTTP {r.status_code}"; continue
                r.raise_for_status()
                data = r.json(); json.dump(data, open(cache, "w", encoding="utf-8")); return data
            except Exception as e:  # network error, bad JSON ...
                last = str(e)
        wait = 15 * rnd; print(f"  busy ({last}); waiting {wait} s", flush=True); time.sleep(wait)
    sys.exit(f"Giving up on {cache}: {last}. Try again in a few minutes.")


if __name__ == "__main__":
    for cache, q in QUERIES.items():
        print(cache)
        d = run(q, cache)
        els = d.get("elements", [])
        names = sorted({e.get("tags", {}).get("name", "(no name)") for e in els})
        print(f"  {len(els)} elements; {os.path.getsize(cache)/1e6:.2f} MB; names: {names[:12]}")
    print("Done. Upload raw_canals.json, raw_thames_lines.json and raw_thames_areas.json.")
