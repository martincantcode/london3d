"""
Download London Underground stations and line geometries from OpenStreetMap
via the Overpass API.

Run:   python fetch_osm_tube.py
Needs: Python 3 and `requests` (pip install requests)
Writes: stations.geojson, lines.geojson and ways.geojson in the current
        folder (plus raw_*.json caches of the server answers).
        If geopandas is installed it also writes tube_osm.gpkg (3 layers).
        Files already cached are not downloaded again.

NOT yet tested against the live Overpass server (the sandbox I wrote it in
cannot reach it). The conversion logic was tested on a small fake response.
"""
import json
import os
import time
import requests

# Public Overpass servers, tried in turn (listed on the OSM wiki).
OVERPASS_SERVERS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

# south, west, north, east. Wide enough to cover Chesham/Amersham (NW),
# Epping (NE), Upminster (E), Heathrow (W) and Morden (S).
BBOX = "51.35,-0.70,51.75,0.32"

HEADERS = {"User-Agent": "london-tube-3d-map/0.1 (personal project)"}

# Step 1: station points. "out center" gives a single point even when a
# station is mapped as an area.
STATIONS_QUERY = (
    f'[out:json][timeout:120];'
    f'nwr["railway"="station"]["network"~"London Underground"]({BBOX});'
    f'out center;'
)

# Step 2: line routes. Each route relation is one line/direction/branch.
# "out geom" returns the coordinates of every member way.
LINES_QUERY = (
    f'[out:json][timeout:180];'
    f'relation["route"="subway"]["network"~"London Underground"]({BBOX});'
    f'out geom;'
)


# Step 3: the track ways themselves, WITH their tags. These say whether a
# stretch is in a tunnel, on a bridge, in a cutting, or is a siding/depot.
# way(r) = "all ways that are members of the relations found above".
# Each way comes back once, so there are no duplicates.
WAYS_QUERY = (
    f'[out:json][timeout:180];'
    f'relation["route"="subway"]["network"~"London Underground"]({BBOX});'
    f'way(r);'
    f'out tags geom;'
)


def run_query(query, cache_path=None):
    """POST a query to Overpass, retrying and falling back to a mirror.

    The public servers are often overloaded and answer 502/503/504/429.
    Those are temporary, so we wait and try again, alternating servers.
    If cache_path is given, a successful answer is saved there so you
    never have to download the same thing twice.
    """
    if cache_path and os.path.exists(cache_path):
        print(f"using cached {cache_path}")
        with open(cache_path, encoding="utf-8") as f:
            return json.load(f)

    temporary = {429, 502, 503, 504}
    for attempt in range(1, 5):                 # up to 4 rounds
        for url in OVERPASS_SERVERS:
            try:
                print(f"attempt {attempt}: {url}")
                response = requests.post(url, data={"data": query},
                                         headers=HEADERS, timeout=300)
            except requests.RequestException as err:
                print(f"  network error: {err}")
                continue
            if response.status_code in temporary:
                print(f"  server busy (HTTP {response.status_code})")
                continue
            response.raise_for_status()          # other errors are real
            data = response.json()
            if cache_path:
                with open(cache_path, "w", encoding="utf-8") as f:
                    json.dump(data, f)
            return data
        wait = 15 * attempt
        print(f"all servers busy, waiting {wait} s")
        time.sleep(wait)
    raise SystemExit("Overpass is not answering right now. Try again later.")


def stations_to_geojson(data):
    features = []
    for el in data.get("elements", []):
        # nodes carry lat/lon directly; ways and relations carry a "center"
        if el["type"] == "node":
            lat, lon = el.get("lat"), el.get("lon")
        else:
            center = el.get("center", {})
            lat, lon = center.get("lat"), center.get("lon")
        if lat is None or lon is None:
            continue
        tags = el.get("tags", {})
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {
                "osm_type": el["type"],
                "osm_id": el["id"],
                "name": tags.get("name"),
                "network": tags.get("network"),
                "operator": tags.get("operator"),
                "wikidata": tags.get("wikidata"),
            },
        })
    return {"type": "FeatureCollection", "features": features}


def lines_to_geojson(data):
    features = []
    for rel in data.get("elements", []):
        if rel["type"] != "relation":
            continue
        tags = rel.get("tags", {})
        for member in rel.get("members", []):
            # only the track geometry (ways); skip stop nodes etc.
            if member["type"] != "way" or "geometry" not in member:
                continue
            coords = [[p["lon"], p["lat"]] for p in member["geometry"]]
            if len(coords) < 2:
                continue
            features.append({
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": coords},
                "properties": {
                    "relation_id": rel["id"],
                    "route_name": tags.get("name"),
                    "ref": tags.get("ref"),
                    "colour": tags.get("colour"),
                    "from": tags.get("from"),
                    "to": tags.get("to"),
                    "way_id": member["ref"],
                },
            })
    return {"type": "FeatureCollection", "features": features}


def ways_to_geojson(data):
    """One LineString per track way, keeping the tags that matter for 3D."""
    keep = ["railway", "tunnel", "bridge", "layer", "level", "location",
            "cutting", "embankment", "covered", "service", "name"]
    features = []
    for el in data.get("elements", []):
        if el["type"] != "way" or "geometry" not in el:
            continue
        coords = [[p["lon"], p["lat"]] for p in el["geometry"]]
        if len(coords) < 2:
            continue
        tags = el.get("tags", {})
        props = {"way_id": el["id"]}
        props.update({k: tags.get(k) for k in keep})
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coords},
            "properties": props,
        })
    return {"type": "FeatureCollection", "features": features}


def save(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f)
    print(f"wrote {path}: {len(obj['features'])} features")


def main():
    stations = stations_to_geojson(
        run_query(STATIONS_QUERY, cache_path="raw_stations.json"))
    save("stations.geojson", stations)

    lines = lines_to_geojson(
        run_query(LINES_QUERY, cache_path="raw_lines.json"))
    save("lines.geojson", lines)

    ways = ways_to_geojson(
        run_query(WAYS_QUERY, cache_path="raw_ways.json"))
    save("ways.geojson", ways)

    # Optional: bundle all layers into one GeoPackage
    try:
        import geopandas as gpd
        for layer in ("stations", "lines", "ways"):
            gpd.read_file(f"{layer}.geojson").to_file(
                "tube_osm.gpkg", layer=layer, driver="GPKG")
        print("wrote tube_osm.gpkg")
    except ImportError:
        print("geopandas not installed; skipped GeoPackage (GeoJSON is enough)")


if __name__ == "__main__":
    main()
