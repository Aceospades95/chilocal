#!/usr/bin/env node
/* build-baseline.mjs — the map book: ≥10 real spots for EVERY neighborhood.
 * ---------------------------------------------------------------------------
 * Sources, in trust order:
 *   1. OpenStreetMap dumps (scripts/cache/osm-merged.json.gz + osm-extra.json.gz)
 *      — coordinates, names, addresses, websites, hours. © OSM contributors, ODbL.
 *   2. scripts/baseline-recs.json — place names surfaced by web research
 *      (Reddit, Block Club, Eater, TimeOut, Choose Chicago …). A rec NEVER
 *      ships on its own: it must match an OSM element (or an active Chicago
 *      business license) to prove the place exists and pin it to the map.
 *   3. scripts/cache/chi-licenses.json — active business licenses, the
 *      fallback existence proof for beloved counters OSM hasn't mapped.
 *
 * Output: site/data/baseline.json — explore-only spots (never Tonight-engine
 * picks): facts + at most a sourced one-liner, no invented opinions.
 *
 *   node scripts/build-baseline.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const readGz = (p) => JSON.parse(gunzipSync(readFileSync(p)));

const hoods = readJson(join(ROOT, "site/data/neighborhoods.min.geojson"));
const curated = readJson(join(ROOT, "site/data/venues.json")).venues;
const recsFile = readJson(join(ROOT, "scripts/baseline-recs.json"));
const recsByHood = recsFile.recs || recsFile;
const licenses = existsSync(join(ROOT, "scripts/cache/chi-licenses.json.gz"))
  ? readGz(join(ROOT, "scripts/cache/chi-licenses.json.gz"))
  : existsSync(join(ROOT, "scripts/cache/chi-licenses.json"))
    ? readJson(join(ROOT, "scripts/cache/chi-licenses.json")) : [];

const dumps = [readGz(join(ROOT, "scripts/cache/osm-merged.json.gz"))];
const extraPath = join(ROOT, "scripts/cache/osm-extra.json.gz");
if (existsSync(extraPath)) dumps.push(readGz(extraPath));

/* ---- geometry (same rules as build-venues) -------------------------------- */
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
function nearestHood(pt, maxMi = 0.31) { // lakefront piers/beaches sit outside every polygon
  let best = null;
  for (const f of hoods.features) {
    const g = f.geometry;
    const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
    for (const poly of polys) for (const ring of poly) {
      for (let i = 0; i < ring.length - 1; i++) {
        const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
        const dx = x1 - x0, dy = y1 - y0;
        const L2 = dx * dx + dy * dy;
        let t = L2 ? ((pt.lng - x0) * dx + (pt.lat - y0) * dy) / L2 : 0;
        t = Math.max(0, Math.min(1, t));
        const mi = haversineMi(pt, { lng: x0 + t * dx, lat: y0 + t * dy });
        if (!best || mi < best.mi) best = { mi, name: f.properties.name };
      }
    }
  }
  return best && best.mi < maxMi ? best.name : null;
}
function geomNameAt(pt) {
  for (const f of hoods.features) if (pointInFeature(pt, f)) return f.properties.name;
  return nearestHood(pt);
}
function centroidOf(f) {
  const g = f.geometry;
  const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
  let sx = 0, sy = 0, n = 0;
  polys.forEach((poly) => poly[0].forEach(([x, y]) => { sx += x; sy += y; n++; }));
  return { lat: sy / n, lng: sx / n };
}
const hoodByName = new Map(hoods.features.map((f) => [f.properties.name, f]));

/* ---- name matching --------------------------------------------------------- */
const decode = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
const norm = (s) => decode(s)
  .toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[’'`]/g, "")
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, " ")
  .replace(/\b(the|a|an)\b/g, " ")
  .trim().replace(/\s+/g, " ");
const squash = (s) => norm(s).replace(/ /g, "");
const tokens = (s) => new Set(norm(s).split(" ").filter(Boolean));
function jaccard(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
function nameScore(en, q) {
  if (!en || !q) return 0;
  if (en === q || squash(en) === squash(q)) return 100;
  const enSub = en.length >= 10 || tokens(en).size >= 2;
  const qSub = q.length >= 10 || tokens(q).size >= 2;
  if (qSub && (en.startsWith(q) || squash(en).startsWith(squash(q)))) return 82;
  if (enSub && (q.startsWith(en) || squash(q).startsWith(squash(en)))) return 80;
  if (qSub && en.includes(q)) return 72;
  if (enSub && q.includes(en)) return 70;
  const j = jaccard(en, q);
  if (j >= 0.55) return 45 + j * 40;
  return 0;
}

/* ---- categories ------------------------------------------------------------ */
const CHAINS = new Set(["mcdonalds", "burger king", "subway", "dunkin", "dunkin donuts", "kfc",
  "wendys", "popeyes", "taco bell", "dominos", "dominos pizza", "little caesars", "papa johns",
  "starbucks", "chipotle", "chipotle mexican grill", "jimmy johns", "potbelly", "panda express",
  "panera bread", "five guys", "culvers", "white castle", "arbys", "sonic", "raising canes",
  "church s chicken", "churchs chicken", "checkers", "rallys", "sbarro", "auntie annes",
  "baskin robbins", "cold stone creamery", "jamba juice", "smoothie king", "wingstop",
  "buffalo wild wings", "chick fil a", "shake shack", "qdoba", "el pollo loco", "long john silvers",
  "pizza hut", "pizza hut delivery", "dairy queen", "dunkin donuts baskin robbins", "seven eleven", "7 eleven"]);
const CUISINE_CAT = {
  mexican: "Mexican", italian: "Italian", chinese: "Chinese", thai: "Thai", japanese: "Japanese",
  sushi: "Sushi", korean: "Korean", indian: "Indian", pizza: "Pizza", seafood: "Seafood",
  barbecue: "BBQ", bbq: "BBQ", greek: "Greek", vietnamese: "Vietnamese", polish: "Polish",
  german: "German", french: "French", caribbean: "Caribbean", jamaican: "Caribbean",
  soul_food: "Soul food", american: "American", burger: "Burgers", breakfast: "Breakfast",
  hot_dog: "Hot dogs", sandwich: "Sandwiches", chicken: "Chicken", ethiopian: "Ethiopian",
  middle_eastern: "Middle Eastern", mediterranean: "Mediterranean", spanish: "Spanish",
  cuban: "Cuban", peruvian: "Peruvian", filipino: "Filipino", ramen: "Ramen", steak_house: "Steakhouse",
};
function catOf(t) {
  const cui = (t.cuisine || "").split(";")[0].trim().toLowerCase();
  const a = t.amenity, l = t.leisure, s = t.shop, m = t.tourism;
  if (a === "bar") return "Bar";
  if (a === "pub") return "Pub";
  if (a === "nightclub") return "Club";
  if (a === "biergarten") return "Beer garden";
  if (a === "cafe") return "Cafe";
  if (a === "ice_cream") return "Ice cream";
  if (a === "theatre") return "Theater";
  if (a === "cinema") return "Cinema";
  if (a === "arts_centre") return "Arts center";
  if (a === "music_venue" || t.club === "music") return "Music venue";
  if (a === "events_venue") return "Events venue";
  if (a === "casino") return "Casino";
  if (a === "planetarium") return "Museum";
  if (a === "restaurant") return CUISINE_CAT[cui] || "Restaurant";
  if (a === "fast_food") return CUISINE_CAT[cui] || "Counter";
  if (a === "food_court") return "Food hall";
  if (a === "community_centre") return "Community center";
  if (a === "library") return "Library";
  if (s === "books") return "Bookstore";
  if (s === "records" || s === "music") return "Record shop";
  if (s === "bakery") return "Bakery";
  if (s === "deli") return "Deli";
  if (s === "coffee") return "Coffee";
  if (l === "bowling_alley") return "Bowling";
  if (l === "amusement_arcade") return "Arcade";
  if (l === "escape_game") return "Escape room";
  if (l === "dance") return "Dance hall";
  if (l === "ice_rink") return "Ice rink";
  if (l === "park") return "Park";
  if (l === "garden") return "Garden";
  if (l === "nature_reserve") return "Nature preserve";
  if (l === "golf_course") return "Golf";
  if (l === "sports_centre") return "Sports center";
  if (l === "marina") return "Marina";
  if (l === "beach_resort" || t.natural === "beach") return "Beach";
  if (m === "museum") return "Museum";
  if (m === "gallery") return "Gallery";
  if (m === "zoo") return "Zoo";
  if (m === "aquarium") return "Aquarium";
  if (m === "viewpoint") return "Viewpoint";
  if (m === "artwork") return "Public art";
  if (m === "attraction") return "Landmark";
  if (t.historic) return "Landmark";
  if (t.man_made === "pier") return "Pier";
  return "Spot";
}
const CAT_WEIGHT = {
  Bar: 10, Pub: 10, Club: 10, "Beer garden": 10, "Music venue": 11, Theater: 9, Cinema: 7,
  "Arts center": 7, "Events venue": 4, Casino: 4, Bowling: 8, Arcade: 8, "Escape room": 6,
  "Dance hall": 7, Cafe: 6, Coffee: 6, Bakery: 6, Deli: 5, "Ice cream": 6, "Food hall": 8,
  Museum: 7, Gallery: 6, Landmark: 5, Beach: 7, Pier: 5, Garden: 5, "Nature preserve": 4,
  Zoo: 7, Aquarium: 7, Viewpoint: 4, "Public art": 3, Park: 3, Bookstore: 6, "Record shop": 7,
  Marina: 3, Golf: 1, "Sports center": 1, "Community center": 1, Library: 2, "Ice rink": 4,
  Counter: 4, Spot: 2,
};

/* ---- flatten dumps ---------------------------------------------------------- */
const seenEl = new Set();
const elements = [];
for (const dump of dumps) {
  for (const e of dump.elements || []) {
    const key = `${e.type}/${e.id}`;
    if (seenEl.has(key) || !e.tags?.name) continue;
    seenEl.add(key);
    const lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon;
    if (lat == null) continue;
    elements.push({ key, lat, lng, tags: e.tags, nname: norm(e.tags.name) });
  }
}
console.log(`OSM pool: ${elements.length} named elements`);

/* ---- assign polygons, drop chains & curated dupes --------------------------- */
const curatedByGeom = new Map();
for (const v of curated) {
  const k = v.geom || v.hood;
  if (!curatedByGeom.has(k)) curatedByGeom.set(k, []);
  curatedByGeom.get(k).push(norm(v.name));
}
const byHood = new Map(hoods.features.map((f) => [f.properties.name, []]));
let chainDropped = 0;
for (const e of elements) {
  if (CHAINS.has(e.nname) || CHAINS.has(norm(e.tags.brand || ""))) { chainDropped++; continue; }
  const g = geomNameAt({ lat: e.lat, lng: e.lng });
  if (!g) continue;
  const cur = curatedByGeom.get(g) || [];
  if (cur.some((cn) => nameScore(e.nname, cn) >= 70)) continue; // already in the curated book
  e.geom = g;
  byHood.get(g).push(e);
}
console.log(`chains dropped: ${chainDropped}`);

/* ---- dedupe per hood by name (keep the richest element) --------------------- */
const richness = (t) => (t.website || t["contact:website"] ? 2 : 0) + (t.opening_hours ? 2 : 0) +
  (t.wikidata ? 2 : 0) + (t.cuisine ? 1 : 0) + (t["addr:street"] ? 1 : 0);
for (const [h, list] of byHood) {
  const best = new Map();
  for (const e of list) {
    const k = squash(e.nname);
    if (!best.has(k) || richness(e.tags) > richness(best.get(k).tags)) best.set(k, e);
  }
  byHood.set(h, [...best.values()]);
}

/* ---- recs: attach to OSM candidates citywide by name ------------------------ */
let recTotal = 0, recMatched = 0;
const unmatchedRecs = [];
for (const [hood, list] of Object.entries(recsByHood)) {
  for (const r of list) {
    recTotal++;
    const rn = norm(r.name);
    // best candidate anywhere (seam-tolerant), preferring the rec's own hood
    let best = null;
    for (const e of [...(byHood.get(hood) || []), ...elements.filter((x) => x.geom && x.geom !== hood)]) {
      const s = nameScore(e.nname, rn);
      if (!s) continue;
      const bonus = e.geom === hood ? 15 : 0;
      if (!best || s + bonus > best.s) best = { e, s: s + bonus };
    }
    if (best && best.s >= 70) {
      recMatched++;
      // keep the FIRST (highest-priority) rec if several hit the same element
      if (!best.e.rec) best.e.rec = { note: decode(r.note || "").slice(0, 110), src: r.src || "web", cat: r.cat };
    } else {
      unmatchedRecs.push({ hood, ...r });
    }
  }
}
console.log(`recs: ${recMatched}/${recTotal} matched to OSM`);

/* ---- license fallback for unmatched recs ------------------------------------ */
const licRescued = [];
for (const r of unmatchedRecs) {
  const rn = norm(r.name);
  const f = hoodByName.get(r.hood);
  if (!f) continue;
  const c = centroidOf(f);
  let best = null;
  for (const lic of licenses) {
    if (!lic.latitude || !lic.longitude) continue;
    const dba = norm(lic.doing_business_as_name);
    if (!(dba === rn || squash(dba) === squash(rn) || nameScore(dba, rn) >= 75 ||
          nameScore(norm(lic.legal_name), rn) >= 82)) continue;
    const pt = { lat: +lic.latitude, lng: +lic.longitude };
    const dist = haversineMi(c, pt);
    if (dist > 2.5) continue;
    if (!best || dist < best.dist) best = { lic, pt, dist };
  }
  if (best) {
    const geom = geomNameAt(best.pt);
    if (!geom) continue;
    licRescued.push({
      name: decode(r.name), geom, cat: r.cat || "Spot",
      lat: +best.pt.lat.toFixed(5), lng: +best.pt.lng.toFixed(5),
      addr: titleCase(best.lic.address), site: null, hours: null,
      rec: { note: decode(r.note || "").slice(0, 110), src: r.src || "web" },
      src: "chi-license",
    });
  }
}
console.log(`license-rescued recs: ${licRescued.length} (of ${unmatchedRecs.length} unmatched)`);

function titleCase(s) {
  return String(s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ---- score + select per hood -------------------------------------------------- */
const slug = (s) => norm(s).replace(/ /g, "-").slice(0, 40) || "spot";
const out = [];
const shortfalls = [];
const usedIds = new Set(curated.map((v) => v.id));
for (const f of hoods.features) {
  const hood = f.properties.name;
  const curatedN = (curatedByGeom.get(hood) || []).length;
  const cands = (byHood.get(hood) || []).map((e) => {
    const t = e.tags;
    let s = CAT_WEIGHT[catOf(t)] ?? 2;
    if (e.rec) s += 50;
    if (t.website || t["contact:website"]) s += 6;
    if (t.opening_hours) s += 6;
    if (t.wikidata) s += 8;
    if (t.wikipedia) s += 8;
    if (t.cuisine) s += 3;
    if (t.outdoor_seating && t.outdoor_seating !== "no") s += 2;
    if (t["addr:housenumber"]) s += 2;
    return { e, s };
  }).sort((a, b) => b.s - a.s);

  // rescued licenses first, deduped by name — the pick loop then counts
  // AROUND them so a same-name OSM/license twin can't pad the total
  const seen = new Set();
  const rescued = [];
  for (const v of licRescued.filter((x) => x.geom === hood)) {
    const k = squash(norm(v.name)), ck = `${v.lat.toFixed(4)},${v.lng.toFixed(4)}`;
    if (seen.has(k) || seen.has(ck)) continue;
    seen.add(k); seen.add(ck);
    rescued.push(v);
  }
  const need = Math.max(0, 10 - curatedN - rescued.length);
  const cap = Math.max(need, Math.min(cands.filter((c) => c.e.rec).length, 16));
  const picks = [];
  for (const c of cands) {
    if (picks.length >= Math.max(cap, need) && !c.e.rec) break;
    if (picks.length >= 16) break;
    const k = squash(c.e.nname), ck = `${c.e.lat.toFixed(4)},${c.e.lng.toFixed(4)}`;
    if (seen.has(k) || seen.has(ck)) continue;
    seen.add(k); seen.add(ck);
    picks.push(c);
  }
  // if picks < need there simply isn't more verifiable material — report it
  for (const { e } of picks) {
    const t = e.tags;
    let id = `bl-${slug(e.nname)}`;
    while (usedIds.has(id)) id += "-x";
    usedIds.add(id);
    const addr = t["addr:housenumber"] && t["addr:street"]
      ? `${t["addr:housenumber"]} ${t["addr:street"]}` : null;
    out.push({
      id, name: decode(t.name), geom: hood, cat: catOf(t),
      lat: +e.lat.toFixed(5), lng: +e.lng.toFixed(5),
      addr, site: t.website || t["contact:website"] || null,
      hours: t.opening_hours || null,
      osm: e.key, src: "osm",
      ...(e.rec ? { rec: { note: e.rec.note, src: e.rec.src } } : {}),
    });
  }
  for (const v of rescued) {
    let id = `bl-${slug(v.name)}`;
    while (usedIds.has(id)) id += "-x";
    usedIds.add(id);
    out.push({ id, ...v });
  }
  const total = curatedN + picks.length + rescued.length;
  if (total < 10) shortfalls.push(`${hood}: ${total} (curated ${curatedN})`);
}

/* final pass: one polygon must never list the same place twice — OSM
 * node/way twins and rec+license double-rescues collapse to the first
 * (OSM entries were pushed before license ones, so facts-richest wins) */
const seenPlace = new Set();
const deduped = [];
for (const v of out) {
  const k1 = `${v.geom}|${squash(v.name)}`;
  const k2 = `${v.geom}|${v.lat.toFixed(4)},${v.lng.toFixed(4)}`;
  if (seenPlace.has(k1) || seenPlace.has(k2)) continue;
  seenPlace.add(k1); seenPlace.add(k2);
  deduped.push(v);
}
console.log(`same-place dedupe: ${out.length} → ${deduped.length}`);
out.length = 0; out.push(...deduped);

out.sort((a, b) => a.geom.localeCompare(b.geom) || a.name.localeCompare(b.name));
const result = {
  generated: new Date().toISOString().slice(0, 10),
  note: "The map book: baseline spots for every neighborhood. Facts (names, coordinates, addresses, websites, hours) from OpenStreetMap via Overpass — © OpenStreetMap contributors, ODbL 1.0 — or active City of Chicago business licenses. One-line notes are sourced from local press/community write-ups (rec.src) — not ChiLocal opinions. These spots are explore-only and marked unvetted in the app.",
  license: "Data: ODbL 1.0 (OpenStreetMap) / City of Chicago open data. Notes: quoted-source summaries.",
  venues: out,
};
writeFileSync(join(ROOT, "site/data/baseline.json"), JSON.stringify(result, null, 1));
console.log(`\n✓ wrote site/data/baseline.json — ${out.length} spots, ${out.filter((v) => v.rec).length} with sourced notes`);
if (shortfalls.length) console.log(`\nSTILL UNDER 10 (${shortfalls.length}):\n  ` + shortfalls.join("\n  "));
else console.log("every neighborhood is at 10+ 🎉");
