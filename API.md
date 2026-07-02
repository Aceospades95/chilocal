# ChiLocal map — data contract

The map is data-driven. Geography (neighborhood polygons) is served statically
because it rarely changes; **curated content** (neighborhoods + venues) comes from
either a static JSON file or a live API.

Switch in `site/index.html` → `CONFIG`:

```js
const CONFIG = {
  boundaries: "data/neighborhoods.min.geojson", // static polygons (backdrop)
  contentSource: "static",   // ← change to "api"
  contentStatic: "data/content.json",
  apiBase: "/api"            // used when contentSource === "api"
};
```

## Static shape (`data/content.json`)

```jsonc
{
  "brand": { "name": "ChiLocal", "tagline": "…" },
  "categories": [ { "slug": "restaurant", "name": "Restaurants" }, … ],
  "neighborhoods": [
    { "slug": "logan-square", "name": "Logan Square",
      "geomKey": "Logan Square",          // matches pri_neigh in the boundary file
      "chilocal_take": "…" }
  ],
  "venues": [
    { "id": "lula-cafe", "neighborhood": "logan-square", "category": "restaurant",
      "name": "Lula Cafe", "price": "$$$", "chilocal_take": "…",
      "best_for": "…", "skip_if": "…", "is_hidden_gem": false,
      "address": "2537 N Kedzie Blvd", "lat": 41.9286, "lng": -87.7079 }
  ]
}
```

## Live API (`contentSource: "api"`)

The app calls two endpoints and assembles the same shape:

- `GET /api/neighborhoods` → array of `{ slug, name, geomKey, chilocal_take }`
  (a GeoJSON `FeatureCollection` with those as `properties` also works).
- `GET /api/venues` → array of venue objects (same fields as above; a
  `FeatureCollection` with venue fields in `properties` also works).

### PostGIS reference queries (match the seed schema)

```sql
-- /api/neighborhoods
SELECT slug, name, name AS "geomKey", chilocal_take
FROM neighborhoods ORDER BY name;

-- /api/venues  (assumes a geometry(Point,4326) column `geom`; otherwise select lat/lng)
SELECT id, name,
       neighborhood_slug AS neighborhood,
       category_slug     AS category,
       price_range       AS price,
       chilocal_take, best_for, skip_if, is_hidden_gem, address,
       ST_Y(geom) AS lat, ST_X(geom) AS lng
FROM venues ORDER BY name;
```

> Note: `geomKey` maps a ChiLocal neighborhood to the official boundary polygon
> name (`pri_neigh`). Pilsen → `"Lower West Side"`. If you later store your own
> neighborhood polygons, serve them as the boundaries file via
> `ST_AsGeoJSON(geom)` and drop `geomKey`.

## Wiring into ChiLocal-App (Next.js)

Add two route handlers (e.g. `app/api/neighborhoods/route.ts`,
`app/api/venues/route.ts`) running the queries above against your PostGIS pool,
return JSON, set `contentSource:"api"` and `apiBase` to your app origin. The map
component can be dropped in as-is (it's framework-agnostic vanilla JS/SVG).

---

# Night engine data contract (v2, 2026-07)

The decide-our-night app (`site/index.html`) reads two static files; both can
later be served by the Next.js + PostGIS stack without touching the front end.

## `data/venues.json`

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

Serving the same shape from `GET /api/venues` (PostGIS: one row per venue,
`hours` as raw opening_hours text, provenance columns) lets the app go live
by changing one fetch URL in `js/night/app.js` → `boot()`.

## Rebuild pipeline

`scripts/seed-venues.json` (opinion) × Overpass dump × active Chicago business
licenses → `node scripts/build-venues.mjs <dump> [licenses]` →
`site/data/venues.json`. Unverifiable seeds are dropped and reported. See
PRODUCT.md → "Where the effort went".
