#!/usr/bin/env node
/* build-venues.mjs — ChiLocal data pipeline
 * ---------------------------------------------------------------------------
 * Merges the editorial seed (scripts/seed-venues.json) with real facts from
 * OpenStreetMap (via an Overpass dump) and emits site/data/venues.json.
 *
 *   node scripts/build-venues.mjs <osm-dump.json>
 *
 * Facts (coords, canonical name, address, website, phone, opening hours,
 * cash-only, patio, wheelchair) come from OSM — © OpenStreetMap contributors,
 * ODbL. Editorial fields (take, vibes, price tier, energy) are ChiLocal's own
 * point of view. Seed venues with no confident OSM match are DROPPED and
 * reported, so we never ship a place we couldn't verify exists.
 *
 * Refresh the dump with:
 *   curl -X POST -H "User-Agent: ChiLocal/1.0" \
 *     --data-binary @scripts/overpass-query.txt \
 *     https://overpass-api.de/api/interpreter -o /tmp/osm-chicago.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dumpPath = process.argv[2];
const licPath = process.argv[3]; // optional: active Chicago business licenses (SODA export)
if (!dumpPath) { console.error("usage: node scripts/build-venues.mjs <osm-dump.json> [chi-licenses.json]"); process.exit(1); }

const seed = JSON.parse(readFileSync(join(ROOT, "scripts/seed-venues.json"), "utf8"));
const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
const licenses = licPath ? JSON.parse(readFileSync(licPath, "utf8")) : [];
const hoods = JSON.parse(readFileSync(join(ROOT, "site/data/neighborhoods.min.geojson"), "utf8"));

/* ---- geometry helpers ---------------------------------------------------- */
const R_MI = 3958.8;
const rad = (d) => (d * Math.PI) / 180;
function haversineMi(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_MI * Math.asin(Math.sqrt(s));
}
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > pt.lat !== yj > pt.lat &&
        pt.lng < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pointInFeature(pt, feature) {
  const g = feature.geometry;
  const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
  return polys.some((poly) =>
    poly.length && pointInRing(pt, poly[0]) && !poly.slice(1).some((h) => pointInRing(pt, h)));
}
function centroidOf(feature) {
  const g = feature.geometry;
  const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
  let sx = 0, sy = 0, n = 0;
  polys.forEach((poly) => poly[0].forEach(([x, y]) => { sx += x; sy += y; n++; }));
  return { lat: sy / n, lng: sx / n };
}

const hoodByName = new Map(hoods.features.map((f) => [f.properties.name, f]));
/* Editorial hood names → geojson polygon names (for centroid disambiguation). */
const HOOD_ALIAS = {
  "Lakeview": "Lake View", "Pilsen": "Lower West Side", "The Loop": "Loop",
  "Northalsted": "Boystown", "Roscoe Village": "North Center",
  "Fulton Market": "West Loop", "South Loop": "Near South Side",
  "Noble Square": "West Town", "Goose Island": "West Town",
  "Little Italy": "Little Italy, UIC", "Near West Side": "Little Italy, UIC",
  "Ravenswood": "Lincoln Square", "East Garfield Park": "Garfield Park",
  "River West": "West Town", "Archer Heights": "Archer Heights",
};
function hoodCentroid(name) {
  const f = hoodByName.get(HOOD_ALIAS[name] || name);
  return f ? centroidOf(f) : null;
}
function geomNameAt(pt) {
  for (const f of hoods.features) if (pointInFeature(pt, f)) return f.properties.name;
  return null;
}

/* ---- name matching -------------------------------------------------------- */
const norm = (s) => String(s || "")
  .toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[’'`]/g, "")
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, " ")
  .replace(/\b(the|a)\b/g, " ")
  .trim().replace(/\s+/g, " ");
const tokens = (s) => new Set(norm(s).split(" ").filter(Boolean));
function jaccard(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

const NOT_VENUES = new Set(["bicycle_rental", "clinic", "dentist", "pharmacy", "bank", "fuel", "car_rental", "parking"]);
const elements = (dump.elements || [])
  .filter((e) => e.tags && e.tags.name && !NOT_VENUES.has(e.tags.amenity))
  .map((e) => ({
  ...e,
  lat: e.lat ?? e.center?.lat,
  lng: e.lon ?? e.center?.lon,
  nname: norm(e.tags.name),
}));
console.log(`OSM dump: ${elements.length} named elements`);

const squash = (s) => norm(s).replace(/ /g, "");
function nameScore(en, q) {
  if (en === q || squash(en) === squash(q)) return 100;
  // Asymmetric containment: our seed queries are curated and distinctive, so
  // seed-inside-OSM is safe ("hopleaf" ⊂ "hopleaf bar"). OSM-inside-seed only
  // counts when the OSM name is substantial on its own — otherwise a generic
  // stub like "Chicken" would swallow "Honey Butter Fried Chicken".
  const enSubstantial = en.length >= 10 || tokens(en).size >= 2;
  if (en.startsWith(q) || squash(en).startsWith(squash(q))) return 82;
  if (enSubstantial && (q.startsWith(en) || squash(q).startsWith(squash(en)))) return 80;
  if (en.includes(q)) return 72;
  if (enSubstantial && q.includes(en)) return 70;
  const j = jaccard(en, q);
  if (j >= 0.6) return 45 + j * 40;
  return 0;
}
function matchSeed(v) {
  const queries = [v.q, ...(v.alt || [])].map(norm);
  const excluded = new Set((v.exclude || []).map(norm));
  const origin = hoodCentroid(v.hood);
  let best = null;
  for (const e of elements) {
    if (e.lat == null) continue;
    if (excluded.has(e.nname)) continue;
    let score = Math.max(...queries.map((q) => nameScore(e.nname, q)));
    if (!score) continue;
    let dist = 0;
    if (origin) { dist = haversineMi(origin, e); score -= dist * 6; }
    // richer elements (website/hours present) are likelier the real venue page
    if (e.tags.website || e.tags["contact:website"]) score += 3;
    if (e.tags.opening_hours) score += 3;
    if (!best || score > best.score) best = { e, score, dist };
  }
  if (!best || best.score < 52) return null;
  if (best.dist > 4.5) return null; // matched something implausibly far away
  return best;
}

/* Fallback source: active City of Chicago business licenses (exact-ish DBA
 * match + proximity). An active license is strong evidence a place exists. */
function matchLicense(v) {
  const queries = [v.q, ...(v.alt || [])].map(norm);
  const origin = hoodCentroid(v.hood);
  let best = null;
  const legal = v.legal ? norm(v.legal) : null;
  for (const r of licenses) {
    if (!r.latitude || !r.longitude) continue;
    const dba = norm(r.doing_business_as_name);
    const rLegal = norm(r.legal_name);
    const strong = queries.some((q) =>
      dba === q || squash(dba) === squash(q) || dba === "the " + q || squash(dba) === squash("the " + q)) ||
      (legal && (rLegal === legal || rLegal.startsWith(legal)));
    if (!strong) continue;
    const pt = { lat: +r.latitude, lng: +r.longitude };
    const dist = origin ? haversineMi(origin, pt) : 0;
    if (dist > 3) continue;
    if (!best || dist < best.dist) best = { r, pt, dist };
  }
  return best;
}

/* ---- assemble ------------------------------------------------------------- */
const out = [], dropped = [], review = [];
for (const v of seed.venues) {
  const m = matchSeed(v);
  if (m) {
    if (m.score < 62) review.push(`LOW-CONF ${m.score.toFixed(0)}: ${v.q} → ${m.e.tags.name} (${m.dist.toFixed(1)} mi from ${v.hood})`);
    out.push(assemble(v, m.e));
    continue;
  }
  const lic = matchLicense(v);
  if (lic) {
    review.push(`LICENSE-VERIFIED: ${v.q} → ${lic.r.doing_business_as_name} @ ${lic.r.address}`);
    out.push(assembleFromLicense(v, lic.r));
    continue;
  }
  if (v.approx && v.ll) {
    out.push(assemble(v, null));
    review.push(`APPROX (hand-placed, no OSM): ${v.q}`);
  } else dropped.push(`${v.id} (“${v.q}” @ ${v.hood})`);
}

function titleCase(s) {
  return String(s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\b(Ave|St|Blvd|Rd|Dr|Pl)\b/g, (m) => m);
}
function assembleFromLicense(v, r) {
  const lat = +(+r.latitude).toFixed(5), lng = +(+r.longitude).toFixed(5);
  return {
    id: v.id, name: v.q, hood: v.hood, geom: geomNameAt({ lat, lng }),
    cat: v.cat, vibes: v.vibes, energy: v.energy, price: v.price,
    bestFor: v.bestFor, indoor: !!v.in, outdoor: !!v.out,
    seasons: v.seasons, late: !!v.late, inst: !!v.inst,
    take: v.take, lat, lng,
    addr: titleCase(r.address), site: null, hours: null, hoursChecked: null,
    src: "chi-license",
  };
}

function assemble(v, e) {
  const t = e?.tags || {};
  const lat = e ? +e.lat.toFixed(5) : v.ll[0];
  const lng = e ? +e.lng.toFixed(5) : v.ll[1];
  const addr = t["addr:housenumber"] && t["addr:street"]
    ? `${t["addr:housenumber"]} ${t["addr:street"]}` : null;
  const site = t.website || t["contact:website"] || null;
  const tips = [];
  if (t["payment:cards"] === "no" || (t["payment:cash"] === "yes" && t["payment:cards"] === "no")) tips.push("Cash only");
  if (t.outdoor_seating && t.outdoor_seating !== "no") tips.push("Patio");
  if (t.live_music === "yes") tips.push("Live music");
  if (t.reservation === "required") tips.push("Reservation required");
  if (t.wheelchair === "yes") tips.push("Wheelchair accessible");
  return {
    id: v.id, name: v.q, nameOsm: e && t.name !== v.q ? t.name : undefined, hood: v.hood,
    geom: geomNameAt({ lat, lng }),
    cat: v.cat, vibes: v.vibes, energy: v.energy, price: v.price,
    bestFor: v.bestFor, indoor: !!v.in, outdoor: !!v.out,
    seasons: v.seasons, late: !!v.late, inst: !!v.inst,
    take: v.take, lat, lng,
    addr, site,
    hours: t.opening_hours || null,
    hoursChecked: t.check_date || t["opening_hours:check_date"] || null,
    tips: tips.length ? tips : undefined,
    osm: e ? `${e.type}/${e.id}` : undefined,
    src: e ? "osm" : "editorial-approx",
    approx: v.approx || undefined,
  };
}

out.sort((a, b) => a.id.localeCompare(b.id));
const result = {
  generated: new Date().toISOString().slice(0, 10),
  note: "Venue facts (coordinates, names, addresses, websites, opening hours, tips) from OpenStreetMap via Overpass API — © OpenStreetMap contributors, ODbL 1.0. Editorial takes, vibe tags, energy and price tiers (≈ estimates) are ChiLocal's own opinion. Opening hours reflect OSM data and may be out of date — always linked out for confirmation.",
  license: "Data: ODbL 1.0 (OpenStreetMap). Editorial content: © ChiLocal.",
  venues: out,
};
writeFileSync(join(ROOT, "site/data/venues.json"), JSON.stringify(result, null, 1));

console.log(`\n✓ wrote site/data/venues.json — ${out.length} venues (${seed.venues.length} seeded)`);
const withHours = out.filter((v) => v.hours).length;
const withSite = out.filter((v) => v.site).length;
console.log(`  hours: ${withHours}/${out.length} · websites: ${withSite}/${out.length}`);
if (review.length) console.log(`\nREVIEW (${review.length}):\n  ` + review.join("\n  "));
if (dropped.length) console.log(`\nDROPPED — no confident OSM match (${dropped.length}):\n  ` + dropped.join("\n  "));
