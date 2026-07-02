# ChiLocal — data contracts

The night app (`site/index.html`) is data-driven off static files today, with
a clean migration path to the existing Next.js + PostGIS stack. (The original
boundary-atlas contract this file used to describe lives in git history.)

## `data/venues.json` (the book of the city)

```jsonc
{
  "generated": "2026-07-01",
  "note": "…provenance + license…",
  "venues": [{
    "id": "green-mill",
    "name": "Green Mill",              // editorial display name
    "nameOsm": "Green Mill Cocktail Lounge", // OSM canonical, when different
    "hood": "Uptown",                  // editorial neighborhood label
    "geom": "Uptown",                  // polygon name in neighborhoods.min.geojson (map highlight)
    "cat": "Jazz club",
    "vibes": ["show", "chill"],        // dinner|dance|new|show|chill|active
    "energy": 3,                        // 1 hushed … 5 rowdy
    "price": 2,                         // 1..4, editorial estimate (display with ~)
    "bestFor": ["date", "classic", "late"],
    "indoor": true, "outdoor": false,
    "seasons": ["all"],                // all|warm|summer|winter
    "late": true,                       // soft signal; open/closed claims come from hours only
    "inst": true,                       // institution quality prior
    "take": "…one-line editorial opinion…",
    "lat": 41.96918, "lng": -87.65989,
    "addr": "4802 North Broadway",
    "site": "https://www.greenmilljazz.com/",
    "hours": "Mo-Fr 12:00-04:00; …",   // raw OSM opening_hours or null (UNKNOWN, never guess)
    "hoursChecked": "2025-01-17",       // OSM check_date when present
    "tips": ["Cash only"],              // derived from OSM tags (payment, outdoor_seating…)
    "osm": "node/1370035488",
    "src": "osm"                        // osm | chi-license | editorial-approx
  }]
}
```

## Map files (static, ODbL-attributed)

- `data/neighborhoods.min.geojson` — the 98 official neighborhoods
  (properties: `name`, `id`); the entire map is drawn from this.
- `data/cta-lines.min.geojson` — CTA rail (City of Chicago open data).
- `data/streets.min.geojson` — major streets, one MultiLineString +
  `labels: [{x, y, n}]` arterial name anchors (OSM, simplified).
- `data/detail.min.geojson` — `{ parks: [], water: [] }` polygons (OSM).

## Going live (`GET /api/venues`)

Serve the same venue shape from the PostGIS stack — one row per venue, `hours`
as raw `opening_hours` text, provenance columns (`src`, `osm`,
`hoursChecked`) — and the app goes live by changing one fetch URL in
`js/night/app.js` → `boot()`. Keep the contract honest: `hours: null` means
unknown (the UI says so), never a guess.

```sql
SELECT id, name, name_osm AS "nameOsm", hood, geom_name AS geom,
       cat, vibes, energy, price, best_for AS "bestFor",
       indoor, outdoor, seasons, late, inst, take,
       ST_Y(pt) AS lat, ST_X(pt) AS lng, addr, site,
       hours, hours_checked AS "hoursChecked", tips, osm, src
FROM night_venues ORDER BY name;
```

Nightly job worth adding at that point: re-check City of Chicago business
licenses (`license_status = 'AAI'`, unexpired) and flag venues that lapse.

## Rebuild pipeline

`scripts/seed-venues.json` (opinion) × Overpass dump × active Chicago business
licenses → `node scripts/build-venues.mjs <dump> [licenses]` →
`site/data/venues.json`. Unverifiable seeds are dropped and reported. See
PRODUCT.md → "Where the effort went".
