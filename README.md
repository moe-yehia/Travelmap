# Travelmap

A lightweight route-planning web app inspired by [lenamaps.com](https://lenamaps.com).
Plan multi-stop trips, pick a transport mode per segment, save/share routes, and
play back the route as an animated marker.

No build step, no API keys.

## Run it

Pick whichever you prefer — both work.

### Option 1: Just open the file

```bash
open /Users/mohamadyehiamokhtar/Desktop/Travelmap/index.html
```

That's it. Geocoding and routing use public CORS-enabled endpoints, so it works
straight from `file://`.

### Option 2: Local server (recommended for clean URLs / sharing)

```bash
cd ~/Desktop/Travelmap
python3 -m http.server 8080
```

Then open <http://localhost:8080>.

(Or `npx serve .` if you prefer Node.)

## What it does

- **Draw your route** – pick origin, destination, and any stops in between
- **Transport mode per segment** – walk / bike / car / bus / train / boat / plane
  - Walk, bike, car, bus route along real streets (OSRM)
  - Train, boat, plane render as a dashed straight line
- **Click the map** to place the next waypoint
- **Drag any pin** to move a waypoint — the route recomputes
- **Search** any place name in the waypoint inputs (Nominatim autocomplete)
- **Jump to location** in the top right to recenter the map
- **Distance** display, toggle KM ↔ MI
- **Show route information** for per-segment distance + time
- **Save** routes to local storage, **Load** them later
- **Share** copies a URL containing the entire route (no backend needed)
- **Play** animates a marker along the full path
- **Theme toggle** (top right) — dark / light tiles

## Services used

All free, no signup:
- **Map tiles**: CARTO Dark/Light Matter
- **Routing**: [OSRM](https://project-osrm.org) public demo server (`router.project-osrm.org`)
- **Geocoding**: [Nominatim](https://nominatim.openstreetmap.org)

These are shared community services — fine for personal use, please don't pummel
them. If you want production reliability, swap the URLs in `app.js` for your own
instances or commercial providers (Mapbox, OpenRouteService, etc.).

## File layout

- `index.html` – page shell
- `style.css` – all styles
- `app.js` – state, map, geocoding, routing, save/load/share/play

That's the whole app.
