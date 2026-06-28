# chilocal

An interactive map of Chicago's boundaries — built to be the foundation of a
self-hosted local website. Starts with two layers and grows from there.

- **Community Areas** — the City of Chicago's **official 77** community areas (authoritative).
- **Neighborhoods** — the **98** colloquial neighborhoods from Choose Chicago (approximate; no official set exists).

Features: layer toggle, hover-to-highlight, click for details, search, four
keyless basemaps (light / streets / dark / satellite), and a choropleth engine
that's ready for your own data.

It's a static site (Leaflet, no build step, no API keys), packaged as a tiny
nginx container for your Unraid server.

---

## Quick start (Docker / Unraid)

```bash
docker compose up -d --build
```

Then open `http://<your-server-ip>:8080`.

The build downloads the **full-resolution official boundaries** from the Chicago
Data Portal and bakes them into the image. If the build host is offline, it
falls back to the committed simplified samples — the build never fails.

### On Unraid specifically

Two easy paths:

1. **Compose Manager plugin** (recommended): create a new stack named `chilocal`,
   paste this repo's files (or point it at the folder), and hit *Compose Up*.
2. **Plain Docker**: build once and run —
   ```bash
   docker build -t chilocal:latest .
   docker run -d --name chilocal --restart unless-stopped -p 8080:80 chilocal:latest
   ```
   In the Unraid Docker tab the container will appear; the WebUI is port `8080`.

Change the host port by editing the `ports:` line in `docker-compose.yml`
(e.g. `"8088:80"`).

## Run locally (no Docker)

It's just static files. From the `site/` folder:

```bash
cd site
python3 -m http.server 8000      # then open http://localhost:8000
```

Opening `index.html` directly works too — it'll use the bundled samples or the
live portal.

## Get full-resolution boundaries (outside Docker)

```bash
./scripts/fetch-data.sh
```

This writes `site/data/community-areas.geojson` and `neighborhoods.geojson` at
full resolution, straight from the official portal. Re-run anytime to refresh.

---

## How the data loads

Each layer tries three sources in order (configured in `site/js/config.js`):

1. `data/<layer>.geojson` — full-resolution, from `fetch-data.sh` / Docker build.
2. `data/<layer>.min.geojson` — committed simplified sample (works offline).
3. The **live** Chicago Data Portal endpoint (CORS-enabled) — last resort.

So the map always renders, and you control how accurate/heavy the bundled data is.

## Add your own data (choropleth)

Every feature has a stable `id` (community area number, or a neighborhood slug)
and a `name`. Join a `{id|name: value}` map and the layer recolors with a legend:

```js
// In the browser console, or your own script after the map loads:
ChiLocal.setData("community-areas",
  { "8": 105000, "32": 42000, "28": 67000 },   // keys = area numbers (or names)
  { label: "Population", unit: "people" }
);
```

Other handy calls: `ChiLocal.select(layerId, id)`, `ChiLocal.clear()`,
`ChiLocal.setBasemap("dark")`, `ChiLocal.listFeatures("neighborhoods")`.

## Add a new boundary layer

1. Drop a GeoJSON in `site/data/` (or add a `fetch-data.sh` line for it).
2. Add an entry to `layers` in `site/js/config.js` (set `nameField` / `idField`
   to the property keys in your file, pick a `color`).

The sidebar, search, and choropleth pick it up automatically — no other code.

Good Chicago candidates on the same portal: wards, police districts, ZIP codes,
parks, census tracts.

---

## Project structure

```
chilocal/
├─ site/                     # the web app (everything served)
│  ├─ index.html
│  ├─ css/style.css
│  ├─ js/config.js           # ← layers, basemaps, branding live here
│  ├─ js/app.js              # map + interaction logic (ChiLocal API)
│  ├─ vendor/leaflet/        # Leaflet, vendored (no CDN at runtime)
│  └─ data/                  # boundary GeoJSON (+ samples)
├─ scripts/fetch-data.sh     # pull full-resolution official data
├─ Dockerfile               # build-time fetch → nginx
├─ docker-compose.yml
└─ nginx.conf
```

## Data source & accuracy

All boundaries come from the [Chicago Data Portal](https://data.cityofchicago.org):
Community Areas (`igwz-8jzy`, official) and Neighborhoods (`y6yq-dbs2`,
approximate, names not official). Basemap tiles © OpenStreetMap, CARTO, and Esri.

Basemap tiles require internet at view time; the boundary data is local once
fetched/bundled.
