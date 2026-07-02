/* memory.js — the repeat-use engine. Everything lives in localStorage:
 * home base, the date log ("date #14"), been-there counts, wishlist,
 * neighborhood habits. No accounts, no server, exportable later. */

const KEY = "chilocal.tonight.v1";

const DEFAULTS = () => ({
  home: null,                 // { name, lat, lng }
  dates: [],                  // [{ n, iso, heroId, heroName, secondId, hood, vibe }]
  been: {},                   // id -> count
  saved: [],                  // wishlist ids
  hoodVisits: {},             // hood -> count
  generated: [],              // last 20 plans the engine produced (locked or not)
});

export function loadMemory() {
  try {
    const m = JSON.parse(localStorage.getItem(KEY) || "null");
    if (m && typeof m === "object") return { ...DEFAULTS(), ...m };
  } catch { /* corrupted — start fresh */ }
  return DEFAULTS();
}
function save(m) {
  try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* full/blocked */ }
}

export function setHome(m, home) { m.home = home; save(m); }

export function logGenerated(m, plan) {
  m.generated.unshift({
    iso: new Date().toISOString().slice(0, 10),
    heroId: plan.hero.v.id || null,
    heroName: plan.hero.v.name, heroCat: plan.hero.v.cat, heroHood: plan.hero.v.hood,
    secondName: plan.second?.venue.name || null,
    why: plan.why || null,
  });
  m.generated = m.generated.slice(0, 20);
  save(m);
}

export function toggleBeen(m, id) {
  if ((m.been[id] || 0) > 0) delete m.been[id];
  else m.been[id] = 1;
  save(m);
  return m.been[id] || 0;
}

export function toggleSaved(m, id) {
  const i = m.saved.indexOf(id);
  if (i >= 0) m.saved.splice(i, 1); else m.saved.push(id);
  save(m);
  return i < 0;
}

export function lockDate(m, plan, vibe) {
  const n = m.dates.length + 1;
  m.dates.push({
    n, iso: new Date().toISOString().slice(0, 10),
    heroId: plan.hero.v.id, heroName: plan.hero.v.name,
    secondId: plan.second?.venue.id || null, hood: plan.hero.v.hood, vibe: vibe || null,
  });
  m.been[plan.hero.v.id] = (m.been[plan.hero.v.id] || 0) + 1;
  if (plan.second) m.been[plan.second.venue.id] = (m.been[plan.second.venue.id] || 0) + 1;
  m.hoodVisits[plan.hero.v.hood] = (m.hoodVisits[plan.hero.v.hood] || 0) + 1;
  const i = m.saved.indexOf(plan.hero.v.id);
  if (i >= 0) m.saved.splice(i, 1);
  save(m);
  return n;
}

/* recent = last 8 locked heroes; the engine won't repeat them. */
export function memoryView(m) {
  return {
    been: m.been,
    saved: m.saved,
    hoodVisits: m.hoodVisits,
    recentIds: m.dates.slice(-8).map((d) => d.heroId),
  };
}

/* Gentle habit nudge: "you always pick X — try Y". Only when the pattern is real. */
export function habitNudge(m) {
  const entries = Object.entries(m.hoodVisits).sort((a, b) => b[1] - a[1]);
  if (!entries.length || entries[0][1] < 3) return null;
  const [top, count] = entries[0];
  const second = entries[1]?.[1] || 0;
  if (count - second < 3) return null;
  return { hood: top, count };
}
