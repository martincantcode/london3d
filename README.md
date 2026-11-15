# London Underground in 3D

An interactive 3D map of the London Underground: both tracks of every line at their real platform heights, running through the real terrain, with trains moving along them (live from TfL, or simulated). Plain Three.js, no build step, no API keys.

**Live site:** `https://martincantcode.github.io/london3d/`

## What you can do
- Left-drag pans, right-drag (or Option/Alt-drag) rotates and tilts, scroll zooms to the cursor. You can tilt below the ground.
- The vertical exaggeration slider (1–10×, default 3×) stretches depth and height.
- Toggles: see-through ground, street grid, tunnel routes on the ground, contour lines, Thames and canals, station drop lines, portals, labels, trains.
- Trains: **Live (TfL)** or **Simulated** (with 1×–100× speed).

## Limitations (please read)
- **Not included:** Elizabeth line (no public station depths found), DLR, Overground, trams.
- **Depths** are platform levels from a TfL Freedom of Information response. Track between stations is interpolated and is schematic, not surveyed.
- **Live trains are estimates.** TfL publishes no train positions, only predicted arrival times per station. Each train is placed between its predicted stops by interpolation, and eased so it does not jump when predictions change. A small number of trains TfL labels oddly (e.g. Metropolitan trains tagged Hammersmith & City) are skipped. Station names from TfL are matched to ours by name; a few may fail to match.
- **If the live feed is unreachable** (offline, blocked, rate limited) the page falls back to the simulation at London time. The simulation is not real timetable data: headways are typical per-line values and running times come from a simple accelerate / cruise / brake model.
- **Water:** OSM polygons, lowered into the terrain; the Thames has no bathymetry. Some canals missing from the OSM export (e.g. the Grand Union west of Little Venice) are missing here too.
- Terrain is OS Terrain 50 on a 100 m grid, so small features are smoothed.

## Files
- `index.html`, `main.js`: the page and the 3D scene.
- `trains.js`: train drawing, simulated timetable.
- `live.js`: live TfL arrivals (`api.tfl.gov.uk/Line/<ids>/Arrivals`, no key, one request every 30 s).
- `data/`: `network.json` (tracks, stations, portals, line relations), `terrain.bin` + `terrain.json` (heights, with water ditches cut in), `water.json`, `roads.json`.
- `vendor/`: Three.js (bundled). `fonts/`: Lato (bundled).
- `tools/`: the Python scripts that produced `data/`, for reference. They need raw inputs (OS Terrain 50, OSM exports, the TfL FOI table) that are not in this repository, and paths inside them are local to the author's machine, so treat them as documentation rather than a one-command build.

## Data and licences
- Contains OS data © Crown copyright and database right 2026 (OS Terrain 50, Open Government Licence).
- Map data © OpenStreetMap contributors, ODbL. `water.json`, `roads.json` and parts of `network.json` are derived from OSM; if you reuse them, the ODbL attribution and share-alike terms apply.
- Platform levels: Transport for London Freedom of Information response FOI-0493-2223. I have not checked the re-use terms for FOI responses; check before reusing the data commercially.
- Live train data: Powered by TfL Open Data (see TfL's open data terms).
- Lato: SIL Open Font License 1.1. Three.js: MIT.
- Code: MIT license.

Debug in the browser console: `__v.trains.live.stats()` shows feed status, trains tracked and any unmatched station names.
