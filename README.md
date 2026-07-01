# ChiLocal — the night decides itself

**Tell us the vibe, we'll decide your night.** One concrete plan for tonight
in Chicago — where to go, why it fits, how to get there — in under a minute.
Built for two: pass-the-phone date-night roulette with vetoes. Never a list.

Live: **https://chilocal.omnia-house.com** · the original neighborhood
boundary atlas is preserved at **`/explore.html`**.

→ Product thinking, matching-engine design, data provenance, and roadmap:
**[PRODUCT.md](PRODUCT.md)** · Live-API migration path: **[API.md](API.md)**

## What's in the box

- `site/` — the app. Static, no build step, vanilla ES modules:
  - `index.html` + `css/night.css` — the funnel, reveal sheet, two-player flow
  - `js/night/engine.js` — the matching engine (filters, scoring, OSM-hours
    parser, two-player joint scoring, second-stop pairing, honest why-lines)
  - `js/night/nightmap.js` — custom dark SVG map of the 98 neighborhoods:
    radar scan, camera zoom, route draw, pin drop, hood glow
  - `js/night/context.js` — Chicago clock + Open-Meteo weather (keyless)
  - `js/night/memory.js` — date log, been-there, wishlist, habit nudges
    (localStorage)
  - `js/night/share.js` — canvas share card ("Date #14 · Green Mill → …")
  - `data/venues.json` — 179 verified venues with per-field provenance
  - `explore.html` — the previous editorial map, kept whole
- `scripts/` — the data pipeline:
  - `seed-venues.json` — the editorial layer (takes, vibes, tiers) — ours
  - `build-venues.mjs` — verifies every seed against OpenStreetMap
    (Overpass) and active City of Chicago business licenses; drops anything
    it can't verify; emits `site/data/venues.json`
  - `overpass-query.txt`, `cache/` — reproducible source pulls

## Quick start

```bash
cd site && python3 -m http.server 8811     # → http://localhost:8811
```

Refresh the venue data:

```bash
curl -X POST -H "User-Agent: ChiLocal/1.0 (github.com/Aceospades95/chilocal)" \
  --data-binary @scripts/overpass-query.txt \
  https://overpass-api.de/api/interpreter -o /tmp/osm-chicago.json
node scripts/build-venues.mjs /tmp/osm-chicago.json scripts/cache/chi-licenses.json
```

## Deploy (unchanged pipeline)

Push to `main` → GitHub Actions builds `ghcr.io/aceospades95/chilocal:latest`
→ Unraid → Docker → `chilocal-map` → *force update*. The image is the same
tiny nginx static server as before (`Dockerfile`, `nginx.conf` untouched);
`scripts/fetch-data.sh` still bakes full-resolution boundary data at build
time when the network allows.

```bash
docker compose up -d --build   # local: http://localhost:8080
```

## Data & licenses

Venue facts (coordinates, names, addresses, websites, opening hours, tips
like cash-only) come from **OpenStreetMap** — © OpenStreetMap contributors,
**ODbL 1.0** — and from **City of Chicago open data** (business licenses,
boundary files). Weather by **Open-Meteo**. Editorial takes, vibe tags, and
price-tier estimates are ChiLocal's own opinion (`scripts/seed-venues.json`).
Hours are surfaced only when sourced, always with a "double-check" link out.
No scraped reviews, no lifted copy.
