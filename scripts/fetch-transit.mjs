/* fetch-transit.mjs — regenerate the transit knowledge files:
 *   site/data/cta-stations.min.json   CTA 'L' stations + lines served
 *                                     (City of Chicago open data, keyless)
 *   site/data/metra-lines.min.geojson Metra commuter rail geometry
 *                                     (OpenStreetMap via Overpass, ODbL)
 *   site/data/divvy-stations.min.json Divvy bike-share stations
 *                                     (official GBFS feed, keyless)
 * Run: node scripts/fetch-transit.mjs */
import { writeFileSync } from "fs";

const UA = { "User-Agent": "ChiLocal/1.0 (github.com/Aceospades95/chilocal)" };

// ---- CTA stations ----------------------------------------------------------
const stops = await (await fetch(
  "https://data.cityofchicago.org/resource/8pix-ypme.json?$limit=500", { headers: UA })).json();
const byStation = new Map();
const LINES = { red: "Red", blue: "Blue", g: "Green", brn: "Brown", p: "Purple", y: "Yellow", pnk: "Pink", o: "Orange" };
for (const s of stops) {
  if (!s.location) continue;
  const key = s.map_id;
  const e = byStation.get(key) || { n: s.station_name, lat: +s.location.latitude, lng: +s.location.longitude, l: new Set() };
  for (const [k, name] of Object.entries(LINES)) if (s[k]) e.l.add(name);
  byStation.set(key, e);
}
const stations = [...byStation.entries()].map(([id, s]) => ({
  id: +id, // CTA map_id — the Train Tracker arrivals API keys on this
  n: s.n, lat: +s.lat.toFixed(5), lng: +s.lng.toFixed(5), l: [...s.l],
}));
writeFileSync("site/data/cta-stations.min.json",
  JSON.stringify({ src: "City of Chicago open data (8pix-ypme)", fetched: new Date().toISOString().slice(0, 10), stations }));
console.log("cta-stations:", stations.length, "stations");

// ---- Metra lines (OSM) -----------------------------------------------------
const q = `[out:json][timeout:90];rel["route"="train"]["network"~"Metra",i];way(r);out geom;`;
const osm = await (await fetch("https://overpass-api.de/api/interpreter",
  { method: "POST", headers: { ...UA, "Content-Type": "text/plain" }, body: q })).json();
const B = { s: 41.60, n: 42.10, w: -88.05, e: -87.50 }; // map stage + margin
const lines = [];
for (const el of osm.elements) {
  if (el.type !== "way" || !el.geometry) continue;
  const pts = el.geometry
    .filter((p) => p.lat > B.s && p.lat < B.n && p.lon > B.w && p.lon < B.e)
    .filter((_, i, a) => i % 2 === 0 || i === a.length - 1) // decimate 2:1
    .map((p) => [+p.lon.toFixed(4), +p.lat.toFixed(4)]);
  if (pts.length >= 2) lines.push(pts);
}
const gj = { type: "FeatureCollection",
  note: "Metra rail, © OpenStreetMap contributors, ODbL",
  features: [{ type: "Feature", properties: { name: "Metra" },
               geometry: { type: "MultiLineString", coordinates: lines } }] };
writeFileSync("site/data/metra-lines.min.geojson", JSON.stringify(gj));
console.log("metra segments:", lines.length);

// ---- Divvy stations (GBFS) -------------------------------------------------
const gbfs = await (await fetch(
  "https://gbfs.divvybikes.com/gbfs/en/station_information.json", { headers: UA })).json();
const divvy = gbfs.data.stations
  .filter((s) => s.lat > B.s && s.lat < B.n && s.lon > B.w && s.lon < B.e)
  .map((s) => ({ n: s.name, lat: +s.lat.toFixed(5), lng: +s.lon.toFixed(5), cap: s.capacity || 0 }))
  .sort((a, b) => a.lat - b.lat || a.lng - b.lng);
writeFileSync("site/data/divvy-stations.min.json",
  JSON.stringify({ src: "Divvy GBFS (official feed)", fetched: new Date().toISOString().slice(0, 10), stations: divvy }));
console.log("divvy stations:", divvy.length);
