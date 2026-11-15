"""
Download London's rivers and streams from OpenStreetMap, including the culverted / underground ("lost") ones.

Run:   python fetch_osm_rivers.py
Needs: Python 3 and `requests`
Writes raw_rivers.json (all waterway=river/stream/drain with tags and geometry) and
       raw_thames_banks.json (water/riverbank polygons within 1.5 km of the Thames, for real banks-to-banks width).
Upload both files to the chat.

NOT tested against the live Overpass server (sandbox cannot reach it); syntax-checked only.
Underground sections are identified by OSM tags tunnel=culvert|yes, or layer<0 - completeness depends on OSM mappers
(Fleet, Tyburn, Westbourne, Walbrook are partly mapped). OS Open Rivers may be better; check its attribute table for a flag.
"""
import json, os, sys, time
import requests
SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"]
BBOX = "51.35,-0.70,51.75,0.32"
H = {"User-Agent": "london-tube-3d-map/0.1 (personal project)"}
Q = {
 "raw_rivers.json": f'[out:json][timeout:180];way["waterway"~"^(river|stream|drain|ditch)$"]({BBOX});out tags geom;',
 "raw_thames_banks.json": (f'[out:json][timeout:240];way["waterway"="river"]["name"="River Thames"]({BBOX})->.t;'
    '(way["natural"="water"](around.t:1500);relation["natural"="water"](around.t:1500);'
    'way["waterway"="riverbank"](around.t:1500);relation["waterway"="riverbank"](around.t:1500););out tags geom;'),
}
def run(q, cache):
    if os.path.exists(cache): return json.load(open(cache, encoding="utf-8"))
    last = None
    for rnd in range(1, 5):
        for u in SERVERS:
            try:
                r = requests.post(u, data={"data": q}, headers=H, timeout=300)
                if r.status_code in (429, 502, 503, 504): last = r.status_code; continue
                r.raise_for_status(); d = r.json(); json.dump(d, open(cache, "w", encoding="utf-8")); return d
            except Exception as e: last = str(e)
        time.sleep(15 * rnd)
    sys.exit(f"Giving up on {cache}: {last}")
for c, q in Q.items():
    d = run(q, c); print(c, len(d.get("elements", [])), "elements")
