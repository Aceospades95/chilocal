/* engine.js — the ChiLocal night engine
 * ---------------------------------------------------------------------------
 * Pure decision logic, no DOM. Given the venue dataset, tonight's context
 * (weather, clock, season), the party's answers, and memory (been-there,
 * vetoes), it returns ONE plan: a hero pick, an optional second stop, two
 * alternates, and an honest "why" built only from factors that actually
 * scored. Deterministic per (night, reroll) so a reroll feels intentional,
 * not random-shuffle.
 */

/* ----------------------------- tiny utilities ----------------------------- */
const R_MI = 3958.8;
const rad = (d) => (d * Math.PI) / 180;
export function haversineMi(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_MI * Math.asin(Math.sqrt(s));
}

/* Deterministic PRNG so "surprise" is stable within a roll but fresh nightly */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* --------------------------- opening-hours parser -------------------------- */
/* Parses the common shapes of OSM opening_hours. Anything it can't parse is
 * treated as UNKNOWN — we never claim a place is open on a guess. */
const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
export function parseHours(str) {
  if (!str) return null;
  const s = str.trim();
  if (/^24\s*\/\s*7$/.test(s)) return { always: true, rules: [] };
  const rules = [];
  for (const partRaw of s.split(";")) {
    const part = partRaw.trim();
    if (!part || /^PH\b/i.test(part) || /^SH\b/i.test(part)) continue; // public holidays: ignore
    const m = part.match(/^([A-Za-z ,\-]+?)\s+((?:\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2},?\s*)+|off|closed)$/);
    if (!m) return null; // unparseable → unknown
    const daysSpec = m[1].trim(), timeSpec = m[2].trim();
    const days = new Set();
    for (const tok of daysSpec.split(",")) {
      const t = tok.trim();
      const range = t.match(/^([A-Za-z]{2})\s*-\s*([A-Za-z]{2})$/);
      if (range) {
        const a = DAYS.indexOf(range[1]), b = DAYS.indexOf(range[2]);
        if (a < 0 || b < 0) return null;
        for (let i = a; ; i = (i + 1) % 7) { days.add(i); if (i === b) break; }
      } else {
        const d = DAYS.indexOf(t);
        if (d < 0) return null;
        days.add(d);
      }
    }
    if (/^(off|closed)$/i.test(timeSpec)) { rules.push({ days, spans: [] }); continue; }
    const spans = [];
    for (const span of timeSpec.split(",")) {
      const t = span.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
      if (!t) return null;
      const from = +t[1] * 60 + +t[2];
      let to = +t[3] * 60 + +t[4];
      if (to <= from) to += 1440; // overnight (17:00-02:00)
      spans.push({ from, to });
    }
    rules.push({ days, spans });
  }
  return rules.length ? { always: false, rules } : null;
}

/* Is the venue open at (day, minutes)? Checks today's rules plus yesterday's
 * overnight spill. Returns { open, until } or null when hours are unknown. */
export function openState(parsed, day, minutes) {
  if (!parsed) return null;
  if (parsed.always) return { open: true, until: null };
  const spansFor = (d) => {
    let last = null;
    for (const r of parsed.rules) if (r.days.has(d)) last = r.spans; // later rules override
    return last;
  };
  const today = spansFor(day);
  if (today) for (const sp of today) {
    if (minutes >= sp.from && minutes < sp.to)
      return { open: true, until: sp.to % 1440 };
  }
  const yday = spansFor((day + 6) % 7);
  if (yday) for (const sp of yday) {
    if (sp.to > 1440 && minutes + 1440 >= sp.from && minutes + 1440 < sp.to)
      return { open: true, until: sp.to % 1440 };
  }
  // hours known for other days but not defined for today → treat as unknown
  if (!today && !yday) return null;
  return { open: false, until: null };
}
export const fmtClock = (mins) => {
  if (mins == null) return null;
  let h = Math.floor(mins / 60) % 24, m = mins % 60;
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, "0")} ${ap}` : `${h} ${ap}`;
};

/* ------------------------------- distances -------------------------------- */
export const DIST_DIALS = [
  { id: "walk", label: "Walkable", mi: 1.3 },
  { id: "hop", label: "Short hop", mi: 3.6 },
  { id: "any", label: "Anywhere", mi: 15 },
];
export function travelLabel(mi) {
  const walkMin = Math.round(mi * 20);
  if (mi <= 1.05) return `~${Math.max(4, walkMin)} min walk`;
  const ride = Math.round(mi * 3.2 + 8);
  return `~${ride} min ride`;
}

/* --------------------------------- season --------------------------------- */
export function seasonOk(v, ctx) {
  const ss = v.seasons || ["all"];
  if (ss.includes("all")) return true;
  const m = ctx.month; // 0-11
  const warmMonth = m >= 4 && m <= 8; // May–Sep
  const summer = m >= 5 && m <= 7;    // Jun–Aug
  const winter = m <= 1 || m === 11 || m === 2; // Dec–Mar
  const warmEnough = ctx.temp != null ? ctx.temp >= 62 : warmMonth;
  if (ss.includes("summer") && summer) return true;
  if (ss.includes("warm") && (warmMonth || warmEnough)) return true;
  if (ss.includes("winter") && winter) return true;
  return false;
}

/* ------------------------------ scoring core ------------------------------ */
export function scoreVenue(v, input, ctx, mem, rand) {
  const reasons = [];
  let s = 0;

  // --- vibe fit
  if (input.vibe) {
    const idx = v.vibes.indexOf(input.vibe);
    if (idx === 0) s += 30;
    else if (idx > 0) s += 18;
  } else {
    s += 12; // surprise mode: everything eligible, variety comes from jitter
  }

  // --- weather fit (only claim what the data supports)
  const t = ctx.temp, hot = t != null && t >= 90, cold = t != null && t <= 38;
  const wet = ctx.precipProb != null && ctx.precipProb >= 45;
  const balmy = t != null && t >= 66 && t < 90 && !wet;
  if (balmy && v.outdoor) { s += 14; reasons.push("patio"); }
  if (hot) {
    if (v.indoor && !v.outdoor) { s += 7; reasons.push("heat-ac"); }
    else if (v.outdoor && ctx.hour >= 19) { s += 9; reasons.push("heat-dusk"); }
  }
  if ((cold || wet) && v.indoor) {
    s += 8;
    if (v.energy <= 2) { s += 5; reasons.push(wet ? "rain-cozy" : "cold-cozy"); }
    else reasons.push(wet ? "rain-dry" : "cold-warm");
  }
  if ((cold || wet) && !v.indoor && v.outdoor && !(v.seasons || []).includes("winter")) s -= 25;

  // --- time fit
  if (ctx.hour >= 22) {
    if (v.late) { s += 12; reasons.push("late"); }
    else s -= 14;
  } else if (ctx.hour < 18 && (v.vibes.includes("new") || v.vibes.includes("active"))) {
    s += 6; reasons.push("daylight");
  }
  // unknown hours get increasingly risky as the night deepens — don't send
  // people to a probably-dark museum at 10pm
  if (!v._hours && ctx.hour >= 21 && !v.late) s -= 16;

  // --- novelty & memory
  const beenCount = mem.been[v.id] || 0;
  if (!beenCount) { s += 8; reasons.push("never-been"); }
  else s -= Math.min(14, beenCount * 5);
  if (mem.saved.includes(v.id)) { s += 10; reasons.push("wishlist"); }
  const hoodVisits = mem.hoodVisits[v.hood] || 0;
  const maxVisits = Math.max(0, ...Object.values(mem.hoodVisits));
  if (maxVisits >= 3 && hoodVisits === 0) { s += 6; reasons.push("new-hood"); }

  // --- quality prior & party fit
  if (v.inst) { s += 6; reasons.push("institution"); }
  if (input.party === "couple" && v.bestFor.includes("date")) { s += 9; reasons.push("date"); }
  if (input.party === "group" && v.bestFor.includes("group")) s += 8;
  if (input.party === "solo" && v.bestFor.includes("solo")) s += 8;

  // --- budget affinity (hard cap applied in filter)
  if (v.price === input.budget) s += 4;
  if (input.budget >= 3 && v.price >= 3 && v.bestFor.includes("splurge")) { s += 5; reasons.push("splurge"); }
  if (input.budget <= 2 && v.price === 1 && v.bestFor.includes("cheap")) s += 3;

  // --- deterministic spice
  s += rand() * 9;

  return { score: s, reasons };
}

/* Hard filters. Returns a reason string when excluded (for debugging). */
export function filterVenue(v, input, ctx, mem, session) {
  if (input.vibe && !v.vibes.includes(input.vibe)) return "vibe";
  if (v.price > input.budget) return "budget";
  if (!seasonOk(v, ctx)) return "season";
  const dist = haversineMi(input.origin, v);
  if (dist > input.maxMi) return "distance";
  if (session.excluded.has(v.id)) return "shown";
  if (session.vetoed.has(v.id)) return "vetoed";
  if ((mem.been[v.id] || 0) > 0 && mem.recentIds.includes(v.id)) return "recent";
  const st = openState(v._hours, ctx.day, ctx.minutes);
  if (st && !st.open) {
    // planning for later tonight: open-at-8pm counts even if closed now
    const at = ctx.planMinutes != null ? openState(v._hours, ctx.day, ctx.planMinutes) : null;
    if (!at || !at.open) return "closed";
  }
  return null;
}

/* ------------------------------- two-player -------------------------------- */
/* Each partner answered: vibes (up to 2), plus sliders. The joint score
 * maximizes the *minimum* happiness — a plan only wins if it works for both. */
export function jointScore(v, p1, p2, base) {
  const per = (p) => {
    let s = 0;
    const hits = p.vibes.filter((vb) => v.vibes.includes(vb)).length;
    s += hits ? (v.vibes.indexOf(p.vibes[0]) === 0 ? 26 : 18) + (hits - 1) * 8 : -20;
    if (p.quiet != null) {
      // quiet=1 wants energy 1-2, quiet=0 wants 4-5
      const want = p.quiet ? 2 : 4;
      s += 10 - Math.abs(v.energy - want) * 5;
    }
    if (p.classic != null) {
      if (p.classic && v.inst) s += 8;
      if (!p.classic && !v.inst) s += 4;
    }
    return s;
  };
  const a = per(p1), b = per(p2);
  const overlap = p1.vibes.some((vb) => p2.vibes.includes(vb) && v.vibes.includes(vb));
  return base + Math.min(a, b) * 0.7 + ((a + b) / 2) * 0.3 + (overlap ? 12 : 0);
}

/* ------------------------------ second stops ------------------------------- */
const drinkish = (v) => v.vibes.includes("chill") || v.vibes.includes("dance");
const foodish = (v) => v.vibes.includes("dinner");
export function pickSecond(hero, pool, input, ctx) {
  const eff = input.vibe || hero.vibes[0]; // surprise/two-player: pair off the hero itself
  let want;
  if (eff === "dinner") want = drinkish;
  else if (eff === "show") want = ctx.hour < 19 ? foodish : drinkish;
  else if (eff === "active" || eff === "new") want = (v) => foodish(v) || drinkish(v);
  else return null;

  let best = null;
  for (const v of pool) {
    if (v.id === hero.id || !want(v) || v.price > input.budget) continue;
    const mi = haversineMi(hero, v);
    if (mi > 0.72) continue;
    if (Math.abs(v.energy - hero.energy) > 2) continue;
    const late = ctx.hour >= 20 && v.late ? 6 : 0;
    const sc = (0.72 - mi) * 40 + late + (v.inst ? 3 : 0) + (drinkish(v) && v.energy <= 3 ? 2 : 0);
    if (!best || sc > best.sc) best = { v, mi, sc };
  }
  return best ? { venue: best.v, mi: best.mi } : null;
}

/* ------------------------------- why lines --------------------------------- */
const HOODS_PREP = { "The Loop": "in the Loop", "Museum Campus": "on the Museum Campus" };
const inHood = (h) => HOODS_PREP[h] || `in ${h}`;
export function whyLine(v, reasons, input, ctx, extra = {}) {
  const bits = [];
  if (reasons.includes("patio") && ctx.temp != null)
    bits.push(`${Math.round(ctx.temp)}° and dry — real patio weather`);
  if (reasons.includes("heat-ac") && ctx.temp != null)
    bits.push(`${Math.round(ctx.temp)}° out there — this one's built for A/C and cold drinks`);
  if (reasons.includes("heat-dusk"))
    bits.push(`hot day, but it cools after sunset — outside seats earn it`);
  if (reasons.includes("rain-cozy") || reasons.includes("rain-dry"))
    bits.push(ctx.temp != null && ctx.temp <= 34
      ? `snow on the radar — this keeps the night warm and dry`
      : `radar says rain — this keeps the night dry`);
  if (reasons.includes("cold-cozy") || reasons.includes("cold-warm"))
    bits.push(`${Math.round(ctx.temp)}° tonight — warm, close, and glowing inside`);
  if (reasons.includes("late")) bits.push(`open properly late, so nobody's rushing you`);
  if (reasons.includes("never-been")) bits.push(`you've never logged a night here`);
  if (reasons.includes("new-hood")) bits.push(`you two always end up in the same spots — ${v.hood} is unclaimed territory`);
  if (reasons.includes("wishlist")) bits.push(`it's been sitting on your wishlist`);
  if (extra.overlap && extra.overlapVibes?.length)
    bits.unshift(`you both tapped “${extra.overlapVibes.map(vibeName).join(" + ")}”`);
  if (reasons.includes("institution") && bits.length < 2)
    bits.push(`a certified Chicago institution`);
  if (reasons.includes("date") && bits.length < 2) bits.push(`built for a two-person table`);
  if (!bits.length) bits.push(`the strongest match ${inHood(v.hood)} for what you asked`);
  const line = bits.slice(0, 2).join(", and ");
  return line.charAt(0).toUpperCase() + line.slice(1) + ".";
}
export const VIBES = [
  { id: "dinner", name: "Dinner & drinks", icon: "🍸" },
  { id: "dance", name: "Dancing & late", icon: "🪩" },
  { id: "new", name: "Something new", icon: "✨" },
  { id: "show", name: "A show", icon: "🎷" },
  { id: "chill", name: "Keep it chill", icon: "🕯️" },
  { id: "active", name: "Out in the air", icon: "🌊" },
];
export const vibeName = (id) => (VIBES.find((v) => v.id === id) || {}).name?.toLowerCase() || id;

/* --------------------------------- decide ---------------------------------- */
/* The main entry. input: { mode, vibe|null, budget 1-4, maxMi, origin{lat,lng},
 * party, p1, p2 (two-player) }.  session: { excluded:Set, vetoed:Set, roll }.
 * Returns { hero, second, alts, why, reasons, debug } or null. */
export function decide(venues, input, ctx, mem, session) {
  const seed = hashStr(`${ctx.nightKey}|roll${session.roll}|${input.vibe || "surprise"}`);
  const scored = [];
  const filtered = {};
  for (const v of venues) {
    const why = filterVenue(v, input, ctx, mem, session);
    if (why) { filtered[why] = (filtered[why] || 0) + 1; continue; }
    const rand = mulberry32(seed ^ hashStr(v.id));
    let { score, reasons } = scoreVenue(v, input, ctx, mem, rand);
    let extra = {};
    if (input.mode === "two" && input.p1 && input.p2) {
      score = jointScore(v, input.p1, input.p2, score);
      const overlapVibes = input.p1.vibes.filter((x) => input.p2.vibes.includes(x) && v.vibes.includes(x));
      if (overlapVibes.length) extra = { overlap: true, overlapVibes };
    }
    scored.push({ v, score, reasons, extra });
  }
  if (!scored.length) return { empty: true, filtered };

  scored.sort((a, b) => b.score - a.score);
  const hero = scored[0];

  // alternates: prefer different hoods (and different vibes when surprising)
  const alts = [];
  for (const c of scored.slice(1)) {
    if (alts.length === 2) break;
    if (c.v.hood === hero.v.hood && alts.length === 0 && scored.length > 4) continue;
    if (alts.some((a) => a.v.hood === c.v.hood)) continue;
    alts.push(c);
  }
  while (alts.length < 2 && scored.length > alts.length + 1) {
    const c = scored[alts.length + 1];
    if (!alts.includes(c) && c !== hero) alts.push(c);
    else break;
  }

  const pool = scored.map((s) => s.v);
  const second = pickSecond(hero.v, pool, input, ctx);
  const why = whyLine(hero.v, hero.reasons, input, ctx, hero.extra);
  return { hero, second, alts, why, filtered };
}

/* Pre-parse hours once at load. */
export function prepVenues(raw) {
  return raw.map((v) => ({ ...v, _hours: parseHours(v.hours) }));
}
