/* app.js — ChiLocal "decide our night" orchestrator.
 * Screens: ask → (vibes | two-player) → deciding → reveal → locked.
 * One plan at a time. Never a list. */

import { prepVenues, decide, scoreVenue, pickSecond, whyLine, mulberry32, hashStr, VIBES, vibeName, haversineMi, travelLabel, openState, fmtClock, DIST_DIALS } from "./engine.js?v=n5";
import { buildContext } from "./context.js?v=n5";
import { loadMemory, memoryView, setHome, toggleSaved, toggleBeen, lockDate, habitNudge, logGenerated } from "./memory.js?v=n5";
import { NightMap } from "./nightmap.js?v=n5";
import { sharePlan } from "./share.js?v=n5";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const PREFS_KEY = "chilocal.prefs.v1";
const MY_KEY = "chilocal.myplaces.v1";
const loadMyPlaces = () => { try { return JSON.parse(localStorage.getItem(MY_KEY) || "[]"); } catch { return []; } };
const saveMyPlaces = (a) => { try { localStorage.setItem(MY_KEY, JSON.stringify(a)); } catch { /* */ } };
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"); } catch { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* */ } };

const S = {
  venues: [], geo: null, map: null, ctx: null, mem: null,
  mode: "out", vibe: null, budget: 2, dial: "hop", party: "couple",
  p1: null, p2: null, twoStep: null,
  plan: null, session: null, vetoes: { p1: 1, p2: 1 },
  screen: "ask", view: "tonight",
  ex: { hood: null, venue: null, vibe: "all", q: "" },
  exIndex: null,
};

/* place my-places into the live pool (engine + explore see them as venues) */
function refreshVenues() {
  const mine = loadMyPlaces().map((m) => ({
    indoor: true, outdoor: false, seasons: ["all"], late: false, inst: false,
    bestFor: [], hours: null, src: "local", mine: true, ...m,
  }));
  S.venues = prepVenues([...S.baseVenues, ...mine]);
  if (S.geo) buildExploreIndex();
  if (S.map && S.exIndex) S.map.setLabelWeights(new Map([...S.exIndex.groups].map(([k, g]) => [k, g.venues.length])));
}

function pointInFeature(pt, feature) {
  const inRing = (ring) => {
    let ins = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > pt.lat !== yj > pt.lat &&
          pt.lng < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi) ins = !ins;
    }
    return ins;
  };
  const g = feature.geometry;
  const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
  return polys.some((poly) => poly.length && inRing(poly[0]));
}
function polygonAt(ll) {
  for (const f of S.geo.features) if (pointInFeature(ll, f)) return f.properties.name;
  return null;
}

/* ------------------------------ boot ------------------------------------- */
async function boot() {
  const prefs = loadPrefs();
  S.budget = prefs.budget ?? 2;
  S.dial = prefs.dial ?? "hop";
  S.party = prefs.party ?? "couple";
  S.mem = loadMemory();

  const [venuesRaw, geo, ctx] = await Promise.all([
    fetch("data/venues.json").then((r) => r.json()),
    fetch("data/neighborhoods.min.geojson").then((r) => r.json()),
    buildContext(),
  ]);
  S.baseVenues = venuesRaw.venues;
  S.geo = geo;
  refreshVenues();
  S.ctx = ctx;
  S.map = new NightMap($("#nm"), geo);

  buildExploreIndex();
  S.map.onHoodClick = (name) => {
    if (S.view !== "explore") return;
    if (S.ex.hood === name && !S.ex.venue) { exBackToCity(); return; } // click again = step out
    S.ex.venue = null;
    exSelectHood(name);
  };
  S.map.onBackgroundClick = () => {
    if (S.view !== "explore") return;
    if (S.ex.venue) { S.ex.venue = null; S.map.clearSpot?.(); renderExplore();
      const g = S.exIndex.groups.get(S.ex.hood);
      if (g) S.map.markSpots(g.venues);
    } else if (S.ex.hood) exBackToCity();
  };
  S.map.onSpotClick = (id) => {
    if (S.view !== "explore") return;
    S.ex.venue = id;
    renderExplore();
  };

  S.map.setLabelWeights(new Map([...S.exIndex.groups].map(([k, g]) => [k, g.venues.length])));

  // restore map prefs
  S.map.setTilt(prefs.tilt || "mid");
  $$("#tilt-seg button").forEach((b) => b.classList.toggle("on", b.dataset.t === (prefs.tilt || "mid")));
  if (prefs.ovTransit) toggleOverlay("transit", true);
  if (prefs.ovStreets) toggleOverlay("streets", true);

  renderContextChip();
  renderAsk();
  wireStatic();
  show("ask");
  $("#app").classList.add("ready");
}

function newSession() {
  S.session = { excluded: new Set(), vetoed: new Set(), roll: 0 };
  S.vetoes = { p1: 1, p2: 1 };
}

/* ------------------------------ screens ---------------------------------- */
function show(name) {
  S.screen = name;
  for (const sec of $$(".screen")) sec.classList.toggle("active", sec.id === "screen-" + name);
  const mapMode = name === "deciding" || name === "reveal" || name === "explore";
  $("#mapwrap").classList.toggle("on", mapMode);
  $("#mapwrap").classList.toggle("deciding", name === "deciding");
  document.body.dataset.screen = name;
}

/* ------------------------------ mode switch ------------------------------- */
function setView(view) {
  if (S.view === view) return;
  if (S.screen === "deciding") return; // don't yank the wheel mid-decision
  S.view = view;
  $$("#mode-seg button").forEach((b) => b.classList.toggle("on", b.dataset.m === view));
  if (view === "explore") {
    S.map.clearReveal();
    S.map.setExplore(true);
    S.map.loadDetail?.("data/detail.min.geojson");
    if (S.ex.hood) S.exCam = S.map.selectHood(S.ex.hood, { inset: exInset() });
    else S.exCam = S.map.cityView(exInset(), tiltZoom());
    renderExplore();
    show("explore");
  } else {
    S.map.disarmPlacePick?.();
    S.map.setExplore(false);
    S.map.clearSpot?.();
    S.map.resetView(700);
    renderAsk();
    show("ask");
  }
}

function renderContextChip() {
  const c = S.ctx;
  const bits = [c.dateLabel];
  if (c.temp != null) bits.push(`${Math.round(c.temp)}° ${c.desc}`);
  if (c.sunsetLabel) bits.push(c.sunsetLabel);
  if (!c.ok) bits.push("weather offline");
  $("#ctx-chip").textContent = bits.join(" · ");
}

/* ----------------------------- ask screen -------------------------------- */
function renderAsk() {
  const homeBtn = $("#home-chip");
  homeBtn.innerHTML = S.mem.home
    ? `from <b>${esc(S.mem.home.name)}</b> <span class="edit">change</span>`
    : `<b>Set your home base</b> — where do nights start?`;

  const n = S.mem.dates.length;
  $("#nights-chip").textContent = n ? `our nights · ${n}` : "our nights";
  $("#nights-chip").style.display = "";

  const nudge = habitNudge(S.mem);
  const el = $("#nudge");
  if (nudge && !S.session?.avoidHood) {
    el.innerHTML = `You always end up in <b>${esc(nudge.hood)}</b> (${nudge.count}×). <button class="linkish" id="nudge-btn">Ban it for tonight</button>`;
    el.hidden = false;
    $("#nudge-btn").onclick = () => {
      S.avoidHood = nudge.hood;
      el.innerHTML = `Fine — <b>${esc(nudge.hood)}</b> is off the table tonight.`;
    };
  } else el.hidden = true;

  // party toggle
  $$("#party-seg button").forEach((b) => b.classList.toggle("on", b.dataset.v === S.party));
}

/* --------------------------- dial-it-in screen ---------------------------- */
function renderVibes() {
  const grid = $("#vibe-grid");
  grid.innerHTML = VIBES.map((v) => `
    <button class="vibe-card ${S.vibe === v.id ? "on" : ""}" data-v="${v.id}">
      <span class="vi">${v.icon}</span><span class="vn">${esc(v.name)}</span>
    </button>`).join("");
  $$(".vibe-card", grid).forEach((b) => b.onclick = () => {
    S.vibe = b.dataset.v;
    $$(".vibe-card", grid).forEach((x) => x.classList.toggle("on", x === b));
    $("#go-dial").disabled = false;
  });
  renderDials("#dials-out");
  $("#go-dial").disabled = !S.vibe;
}

function renderDials(sel) {
  const el = $(sel);
  el.innerHTML = `
    <div class="dial"><label>Budget</label><div class="seg" id="seg-budget">
      ${[1, 2, 3, 4].map((n) => `<button data-v="${n}" class="${S.budget === n ? "on" : ""}">${"$".repeat(n)}</button>`).join("")}
    </div></div>
    <div class="dial"><label>How far</label><div class="seg" id="seg-dist">
      ${DIST_DIALS.map((d) => `<button data-v="${d.id}" class="${S.dial === d.id ? "on" : ""}">${d.label}</button>`).join("")}
    </div></div>`;
  $$("#seg-budget button", el).forEach((b) => b.onclick = () => {
    S.budget = +b.dataset.v; $$("#seg-budget button", el).forEach((x) => x.classList.toggle("on", x === b));
    savePrefs({ ...loadPrefs(), budget: S.budget, dial: S.dial, party: S.party });
  });
  $$("#seg-dist button", el).forEach((b) => b.onclick = () => {
    S.dial = b.dataset.v; $$("#seg-dist button", el).forEach((x) => x.classList.toggle("on", x === b));
    savePrefs({ ...loadPrefs(), budget: S.budget, dial: S.dial, party: S.party });
  });
}

/* ----------------------------- two-player -------------------------------- */
const BINARIES = [
  { id: "quiet", a: "Loud room", b: "Quiet corner" },       // b => quiet=1
  { id: "cheap", a: "Keep it cheap", b: "Go big" },          // a => cheap
  { id: "close", a: "Stay close", b: "Adventure" },          // a => close
  { id: "classic", a: "A classic", b: "Somewhere new" },     // a => classic=1
];

function startTwo() {
  S.p1 = { vibes: [], picks: {} };
  S.p2 = { vibes: [], picks: {} };
  S.twoStep = "p1";
  renderTwoForm("p1");
  show("two");
}

function renderTwoForm(who) {
  const p = S[who];
  $("#two-title").innerHTML = who === "p1"
    ? `Player one — <i>your call</i>`
    : `Player two — <i>no pressure</i>`;
  $("#two-sub").textContent = who === "p1"
    ? "Pick up to two vibes, answer three quick calls. Then hand it over."
    : "Your turn. They can't see this.";

  $("#two-vibes").innerHTML = VIBES.map((v) => `
    <button class="vibe-card sm ${p.vibes.includes(v.id) ? "on" : ""}" data-v="${v.id}">
      <span class="vi">${v.icon}</span><span class="vn">${esc(v.name)}</span>
    </button>`).join("");
  $$("#two-vibes .vibe-card").forEach((b) => b.onclick = () => {
    const id = b.dataset.v;
    const i = p.vibes.indexOf(id);
    if (i >= 0) p.vibes.splice(i, 1);
    else { if (p.vibes.length === 2) p.vibes.shift(); p.vibes.push(id); }
    $$("#two-vibes .vibe-card").forEach((x) => x.classList.toggle("on", p.vibes.includes(x.dataset.v)));
    validateTwo(who);
  });

  $("#two-binaries").innerHTML = BINARIES.map((q) => `
    <div class="binary" data-q="${q.id}">
      <button data-side="a" class="${p.picks[q.id] === "a" ? "on" : ""}">${esc(q.a)}</button>
      <span class="or">or</span>
      <button data-side="b" class="${p.picks[q.id] === "b" ? "on" : ""}">${esc(q.b)}</button>
    </div>`).join("");
  $$("#two-binaries .binary").forEach((row) => {
    $$("button", row).forEach((b) => b.onclick = () => {
      p.picks[row.dataset.q] = b.dataset.side;
      $$("button", row).forEach((x) => x.classList.toggle("on", x === b));
      validateTwo(who);
    });
  });
  validateTwo(who);
}

function validateTwo(who) {
  const p = S[who];
  const done = p.vibes.length >= 1 && Object.keys(p.picks).length === BINARIES.length;
  $("#two-next").disabled = !done;
  $("#two-next").textContent = who === "p1" ? "Done — pass the phone →" : "Decide our night →";
}

function twoNext() {
  if (S.twoStep === "p1") {
    S.twoStep = "pass";
    show("pass");
  } else if (S.twoStep === "p2") {
    // fold answers into engine inputs
    const asPrefs = (p) => ({
      vibes: p.vibes,
      quiet: p.picks.quiet === "b" ? 1 : 0,
      classic: p.picks.classic === "a" ? 1 : 0,
    });
    S.p1e = asPrefs(S.p1); S.p2e = asPrefs(S.p2);
    const cheap = [S.p1, S.p2].filter((p) => p.picks.cheap === "a").length;
    const close = [S.p1, S.p2].filter((p) => p.picks.close === "a").length;
    S.budget = cheap >= 1 ? 2 : 3;                    // anyone says cheap → cheap wins
    S.dial = close === 2 ? "walk" : close === 1 ? "hop" : "any";
    S.mode = "two";
    runDecision();
  }
}

/* ------------------------------ deciding --------------------------------- */
const THINK_LINES = [
  (c) => c.temp != null ? `Reading the sky — ${Math.round(c.temp)}° and ${c.desc}` : "Reading the sky",
  () => "Cross-referencing 179 places worth your time",
  () => "Skipping everywhere you've already been",
  (c) => c.hour >= 21 ? "Filtering for open-late only" : "Checking listed hours",
  () => "Weighing the neighborhoods",
  () => "Arguing with ourselves so you don't have to",
];

function origin() {
  return S.mem.home || { name: "the Loop", lat: 41.8832, lng: -87.6324 };
}

async function runDecision() {
  if (!S.mem.home) { openWhere(() => runDecision()); return; }
  if (!S.session) newSession();

  show("deciding");
  S.map.resetView(500);
  S.map.startScan();
  const lines = S.session.onlyList
    ? [() => "Only your list tonight — as requested", ...THINK_LINES]
    : S.session.onlyGeom
      ? [() => `Staying inside ${S.session.onlyGeom}`, ...THINK_LINES]
      : THINK_LINES;
  const lineEl = $("#think-line");
  let li = 0;
  lineEl.textContent = lines[0](S.ctx);
  const timer = setInterval(() => {
    li = (li + 1) % lines.length;
    lineEl.textContent = lines[li](S.ctx);
  }, 620);

  const input = {
    mode: S.mode, vibe: S.mode === "out" ? S.vibe : null,
    budget: S.budget, maxMi: DIST_DIALS.find((d) => d.id === S.dial).mi,
    origin: origin(), party: S.party,
    p1: S.p1e || null, p2: S.p2e || null,
  };
  const memv = memoryView(S.mem);
  let venues = S.venues;
  if (S.avoidHood && !S.session.onlyGeom) venues = venues.filter((v) => v.hood !== S.avoidHood);
  if (S.session.onlyGeom) {
    venues = venues.filter((v) => (v.geom || v.hood) === S.session.onlyGeom);
    input.maxMi = 20; // the neighborhood was chosen on purpose — distance is moot
  }
  if (S.session.onlyList) {
    venues = venues.filter((v) => S.session.onlyList.has(v.id));
    input.maxMi = 20; input.budget = 4; // their list, their rules
  }

  let plan = decide(venues, input, S.ctx, memv, S.session);
  // graceful widening: never come back empty-handed
  if (plan.empty && S.dial !== "any") {
    input.maxMi = 15;
    plan = decide(venues, input, S.ctx, memv, S.session);
    if (!plan.empty) plan.widened = "distance";
  }
  if (plan.empty) {
    input.budget = Math.min(4, input.budget + 1);
    plan = decide(venues, input, S.ctx, memv, S.session);
    if (!plan.empty) plan.widened = "budget";
  }

  const minWait = new Promise((r) => setTimeout(r, 1900));
  await minWait;
  clearInterval(timer);
  S.map.stopScan();

  if (S.view !== "tonight") return; // user walked away mid-decision
  if (plan.empty) {
    show("ask");
    toast(S.session.onlyList
      ? "Your list came up empty for tonight — save a few more spots first."
      : "Even we couldn't make that work tonight. Loosen a dial?");
    return;
  }
  S.plan = plan;
  S.session.excluded.add(plan.hero.v.id);
  logGenerated(S.mem, plan);
  renderReveal();
}

/* ------------------------------- reveal ----------------------------------- */
function hoursLine(v) {
  const st = openState(v._hours, S.ctx.day, S.ctx.minutes);
  const checkUrl = v.site || ("https://www.google.com/maps/search/?api=1&query=" +
    encodeURIComponent(`${v.name} ${v.addr || ""} Chicago`));
  if (st?.open) {
    const till = st.until != null ? ` till ${fmtClock(st.until)}` : "";
    return `<span class="dot ok"></span> Listed open${till} <a href="${esc(checkUrl)}" target="_blank" rel="noopener">double-check ↗</a>`;
  }
  if (st && !st.open) {
    const later = openState(v._hours, S.ctx.day, S.ctx.planMinutes);
    if (later?.open) return `<span class="dot warn"></span> Opens later tonight <a href="${esc(checkUrl)}" target="_blank" rel="noopener">check ↗</a>`;
  }
  return `<span class="dot unk"></span> Hours unverified — <a href="${esc(checkUrl)}" target="_blank" rel="noopener">check before you go ↗</a>`;
}

function metaLine(v) {
  const mi = haversineMi(origin(), v);
  const bits = [v.cat, v.hood, "$".repeat(v.price), travelLabel(mi)];
  return bits.map(esc).join(" · ");
}

function renderReveal() {
  const { hero, second, alts, why } = S.plan;
  const v = hero.v;
  const n = S.mem.dates.length + 1;

  $("#rv-kicker").innerHTML = `TONIGHT'S PLAN${S.mode === "two" ? " · CHOSEN FOR BOTH OF YOU" : ""}${S.session.roll ? ` · TAKE ${S.session.roll + 1}` : ""}`;
  $("#rv-name").textContent = v.name;
  $("#rv-meta").textContent = "";
  $("#rv-meta").innerHTML = metaLine(v);
  $("#rv-take").textContent = v.take;
  $("#rv-why").innerHTML = `<span class="why-k">Why tonight:</span> ${esc(why)}${S.plan.widened ? esc(` (We loosened the ${S.plan.widened} dial — the strict version came up empty.)`) : ""}`;
  $("#rv-hours").innerHTML = hoursLine(v) +
    (v.vibes.includes("dinner") && !v.mine ? ` · <a href="${esc(reserveUrl(v))}" target="_blank" rel="noopener">find a table ↗</a>` : "") +
    (v.tips?.length ? ` <span class="tips">· ${v.tips.map(esc).join(" · ")}</span>` : "") +
    (v.approx ? ` <span class="tips">· location approximate — it's a stroll, not one door</span>` : "");

  const sec = $("#rv-second");
  if (second) {
    sec.hidden = false;
    sec.innerHTML = `
      <div class="then-line"><span class="then-k">THEN</span> <span class="then-walk">${esc(travelLabel(second.mi))}</span></div>
      <div class="then-name">${esc(second.venue.name)}</div>
      <div class="then-take">${esc(second.venue.take)}</div>`;
  } else sec.hidden = true;

  // saved state
  $("#rv-save").classList.toggle("on", S.mem.saved.includes(v.id));
  $("#rv-save").textContent = S.mem.saved.includes(v.id) ? "♥ Saved" : "♡ Save";

  // alternates
  $("#rv-alts").innerHTML = alts.length ? `
    <div class="alts-k">If you dare say no:</div>
    ${alts.map((a, i) => `
      <button class="alt" data-i="${i}">
        <span class="alt-name">${esc(a.v.name)}</span>
        <span class="alt-meta">${esc(a.v.cat)} · ${esc(a.v.hood)} · ${"$".repeat(a.v.price)}</span>
      </button>`).join("")}` : "";
  $$("#rv-alts .alt").forEach((b) => b.onclick = () => promoteAlt(+b.dataset.i));

  // two-player vetoes
  const vt = $("#rv-vetoes");
  if (S.mode === "two") {
    vt.hidden = false;
    vt.innerHTML = `
      <button id="veto1" ${S.vetoes.p1 ? "" : "disabled"}>Veto — player one${S.vetoes.p1 ? "" : " (used)"}</button>
      <button id="veto2" ${S.vetoes.p2 ? "" : "disabled"}>Veto — player two${S.vetoes.p2 ? "" : " (used)"}</button>`;
    $("#veto1").onclick = () => useVeto("p1");
    $("#veto2").onclick = () => useVeto("p2");
  } else vt.hidden = true;

  show("reveal");
  const desktop = matchMedia("(min-width: 920px)").matches;
  const inset = desktop ? { right: 470 / innerWidth } : { bottom: Math.min(0.58, 520 / innerHeight) };
  requestAnimationFrame(() => {
    S.map.reveal(origin(), v, { second: second?.venue || null, fast: S.session.roll > 0, inset, label: v.hood });
  });
}

function promoteAlt(i) {
  const alt = S.plan.alts[i];
  if (!alt) return;
  const oldHero = S.plan.hero;
  S.plan.alts[i] = oldHero;
  S.plan.hero = alt;
  S.session.excluded.add(alt.v.id);
  const input = { vibe: S.mode === "out" ? S.vibe : null, budget: S.budget };
  // recompute pairing + why for the new hero
  S.plan.second = pickSecond(alt.v, S.venues.filter((x) =>
    haversineMi(origin(), x) <= DIST_DIALS.find((d) => d.id === S.dial).mi + 1), { vibe: input.vibe, budget: S.budget }, S.ctx);
  S.plan.why = whyLine(alt.v, alt.reasons, input, S.ctx, alt.extra);
  renderReveal();
}

function useVeto(who) {
  if (!S.vetoes[who]) return;
  S.vetoes[who] = 0;
  S.session.vetoed.add(S.plan.hero.v.id);
  toast(who === "p1" ? "Player one says no. Recalculating…" : "Player two says no. Recalculating…");
  S.session.roll++;
  runDecision();
}

function reroll() {
  S.session.roll++;
  if (S.session.roll === 3) toast("Third roll. At some point the problem is you two.");
  runDecision();
}

/* ------------------------------- locked ----------------------------------- */
function lockIn() {
  const n = lockDate(S.mem, S.plan, S.vibe);
  const v = S.plan.hero.v;
  $("#lk-date").textContent = `Date #${n}`;
  $("#lk-title").textContent = "It's decided.";
  const heroBtn = $("#lk-hero");
  heroBtn.textContent = v.name;
  heroBtn.onclick = () => openVenueProfile(v.id);
  $("#lk-meta").innerHTML = metaLine(v);
  const sec = S.plan.second;
  const secEl = $("#lk-second");
  secEl.textContent = sec ? `then ${sec.venue.name} — ${travelLabel(sec.mi)}` : "";
  secEl.style.display = sec ? "" : "none";
  secEl.onclick = sec ? () => openVenueProfile(sec.venue.id) : null;
  secEl.classList.toggle("clicky", !!sec);
  $("#lk-profile-hint").hidden = false;

  // no origin param: Google Maps routes from the user's current location
  const dest = encodeURIComponent(`${v.name}, ${v.addr ? v.addr + ", " : ""}Chicago, IL`);
  $("#lk-directions").href =
    `https://www.google.com/maps/dir/?api=1&destination=${dest}`;

  show("locked");
  $("#mapwrap").classList.add("on");
  S.map.focusOn(v, 520);
  burst();
}

function burst() {
  const host = $("#burst");
  host.innerHTML = "";
  for (let i = 0; i < 26; i++) {
    const s = document.createElement("span");
    const a = (Math.PI * 2 * i) / 26 + Math.random() * 0.4;
    const d = 90 + Math.random() * 160;
    s.style.setProperty("--dx", `${Math.cos(a) * d}px`);
    s.style.setProperty("--dy", `${Math.sin(a) * d - 40}px`);
    s.style.setProperty("--del", `${Math.random() * 120}ms`);
    s.className = i % 3 ? "bit" : "bit star";
    host.appendChild(s);
  }
  setTimeout(() => (host.innerHTML = ""), 1800);
}

/* ------------------------------ where picker ------------------------------ */
let whereCb = null;
function openWhere(cb) {
  whereCb = cb || null;
  const dlg = $("#where");
  const list = $("#where-list");
  const feats = S.geo.features.map((f) => f.properties.name).sort();
  const render = (q = "") => {
    const ql = q.toLowerCase();
    list.innerHTML = feats.filter((n) => n.toLowerCase().includes(ql)).slice(0, 60)
      .map((n) => `<button data-n="${esc(n)}">${esc(n)}</button>`).join("");
    $$("button", list).forEach((b) => b.onclick = () => chooseHome(b.dataset.n));
  };
  render();
  $("#where-q").value = "";
  $("#where-q").oninput = (e) => render(e.target.value);
  $("#where-geo").onclick = geoHome;
  dlg.showModal();
  setTimeout(() => $("#where-q").focus(), 60);
}

function hoodCenter(name) {
  const f = S.geo.features.find((x) => x.properties.name === name);
  if (!f) return null;
  let sx = 0, sy = 0, n = 0;
  const polys = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
  polys.forEach((p) => p[0].forEach(([x, y]) => { sx += x; sy += y; n++; }));
  return { lat: sy / n, lng: sx / n };
}

function chooseHome(name) {
  const c = hoodCenter(name);
  if (!c) return;
  setHome(S.mem, { name, ...c });
  $("#where").close();
  renderAsk();
  toast(`Home base: ${name}.`);
  if (whereCb) { const cb = whereCb; whereCb = null; cb(); }
}

function geoHome() {
  if (!navigator.geolocation) { toast("No location access — pick from the list."); return; }
  $("#where-geo").textContent = "Locating…";
  navigator.geolocation.getCurrentPosition((pos) => {
    const { latitude: lat, longitude: lng } = pos.coords;
    let best = null;
    for (const f of S.geo.features) {
      const c = hoodCenter(f.properties.name);
      const d = haversineMi({ lat, lng }, c);
      if (!best || d < best.d) best = { n: f.properties.name, d };
    }
    $("#where-geo").textContent = "Use my location";
    if (best && best.d < 30) chooseHome(best.n);
    else toast("You don't seem to be near Chicago — pick from the list.");
  }, () => {
    $("#where-geo").textContent = "Use my location";
    toast("Couldn't get a location — pick from the list.");
  }, { timeout: 6000 });
}

/* ------------------------------ our nights -------------------------------- */
function myListIds() {
  const mine = S.venues.filter((v) => v.mine).map((v) => v.id);
  return [...new Set([...S.mem.saved, ...mine])].filter((id) => S.venues.some((v) => v.id === id));
}

function openNights() {
  const dlg = $("#nights");
  const rows = [...S.mem.dates].reverse().map((d) =>
    `<button class="night-row rowbtn" data-vid="${esc(d.heroId || "")}"><span class="nn">#${d.n}</span><span class="nd">${esc(d.iso)}</span><span class="nv">${esc(d.heroName)}</span><span class="nh">${esc(d.hood)}</span></button>`).join("");
  const gen = (S.mem.generated || []).slice(0, 10).map((g, i) =>
    `<div class="night-row gen">${g.heroId ? `<button class="linkish nv-link" data-vid="${esc(g.heroId)}">${esc(g.heroName)}</button>` : `<span class="nv">${esc(g.heroName)}</span>`}<span class="nd">${g.secondName ? "→ " + esc(g.secondName) : esc(g.iso)}</span><button class="linkish gen-share" data-i="${i}">share ↗</button></div>`).join("");
  const savedIds = S.mem.saved.filter((id) => S.venues.some((v) => v.id === id));
  const saved = savedIds.map((id) => {
    const v = S.venues.find((x) => x.id === id);
    return `<button class="chip chipbtn" data-vid="${esc(v.id)}">${v.mine ? "◆ " : "♥ "}${esc(v.name)}</button>`;
  }).join(" ");
  const mine = S.venues.filter((v) => v.mine)
    .map((v) => `<button class="chip chipbtn" data-vid="${esc(v.id)}">◆ ${esc(v.name)}</button>`).join(" ");
  const pool = myListIds();
  $("#nights-body").innerHTML =
    (pool.length ? `<button class="btn primary wl-surprise" id="wl-surprise">🎲 Surprise us from our list (${pool.length})</button>` : "") +
    (rows ? `<h3>The log</h3>${rows}` : `<p class="mutep">No nights locked yet — lock a plan and Date #1 starts the count.</p>`) +
    (gen ? `<h3>Generated lately</h3>${gen}` : "") +
    (saved ? `<h3>Wishlist</h3><div class="chips">${saved}</div>` : `<h3>Wishlist</h3><p class="mutep">Tap ♡ Save on any spot to build your list.</p>`) +
    (mine ? `<h3>Your places</h3><div class="chips">${mine}</div>` : "") +
    `<button class="linkish" id="nights-add" style="margin-top:12px">+ add your own spot</button>`;
  $$("[data-vid]", $("#nights-body")).forEach((b) => {
    if (b.dataset.vid) b.onclick = () => openVenueProfile(b.dataset.vid);
  });
  $("#wl-surprise") && ($("#wl-surprise").onclick = () => {
    dlg.close();
    newSession();
    S.session.onlyList = new Set(myListIds());
    S.mode = "out"; S.vibe = null;
    if (S.view !== "tonight") setView("tonight");
    runDecision();
  });
  $("#nights-add").onclick = () => { dlg.close(); openAddPlace(); };
  $$(".gen-share", $("#nights-body")).forEach((b) => b.onclick = async (ev) => {
    ev.stopPropagation();
    const g = S.mem.generated[+b.dataset.i];
    const plan = {
      hero: { v: { name: g.heroName, cat: g.heroCat || "", hood: g.heroHood || "" } },
      second: g.secondName ? { venue: { name: g.secondName } } : null,
      why: g.why,
    };
    const r = await sharePlan(plan, S.ctx, null);
    if (r === "downloaded") toast("Card saved.");
  });
  dlg.showModal();
}

/* -------------------------------- stay in --------------------------------- */
function openStayIn() {
  $("#stayin").showModal();
  const res = $("#coin-result");
  res.textContent = "";
  $("#coin").onclick = () => {
    const opts = ["Cook something 🍳", "Order in 🥡"];
    let i = 0, spins = 8 + ((Math.random() * 4) | 0);
    const t = setInterval(() => {
      res.textContent = opts[i++ % 2];
      if (i > spins) { clearInterval(t); }
    }, 110);
  };
}

/* -------------------------------- misc ------------------------------------ */
let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function resetToAsk() {
  S.view = "tonight";
  $$("#mode-seg button").forEach((b) => b.classList.toggle("on", b.dataset.m === "tonight"));
  S.map.setExplore(false);
  S.map.clearSpot?.();
  $("#mapwrap").classList.remove("on");
  S.plan = null; S.session = null; S.vibe = null; S.mode = "out";
  S.avoidHood = null;
  S.map.resetView(700);
  renderAsk();
  show("ask");
}

/* ------------------------------ static wiring ----------------------------- */
function wireStatic() {
  $("#btn-surprise").onclick = () => { S.mode = "out"; S.vibe = null; newSession(); runDecision(); };
  $("#btn-dial").onclick = () => { S.mode = "out"; renderVibes(); show("vibes"); };
  $("#btn-two").onclick = () => { newSession(); startTwo(); };
  $("#btn-stayin").onclick = openStayIn;
  $("#go-dial").onclick = () => { newSession(); runDecision(); };
  $("#two-next").onclick = twoNext;
  $("#pass-go").onclick = () => { S.twoStep = "p2"; renderTwoForm("p2"); show("two"); };
  $("#home-chip").onclick = () => openWhere();
  $("#nights-chip").onclick = openNights;
  $("#wordmark").onclick = resetToAsk;
  $$("#mode-seg button").forEach((b) => b.onclick = () => setView(b.dataset.m));
  $$("#tilt-seg button").forEach((b) => b.onclick = () => {
    S.map.setTilt(b.dataset.t);
    $$("#tilt-seg button").forEach((x) => x.classList.toggle("on", x === b));
    savePrefs({ ...loadPrefs(), tilt: b.dataset.t });
    if (S.view === "explore" && !S.ex.hood) S.exCam = S.map.cityView(exInset(), tiltZoom());
  });
  $("#ov-transit").onclick = () => toggleOverlay("transit");
  $("#ov-streets").onclick = () => toggleOverlay("streets");
  $$(".back-ask").forEach((b) => b.onclick = resetToAsk);

  $$("#party-seg button").forEach((b) => b.onclick = () => {
    S.party = b.dataset.v;
    $$("#party-seg button").forEach((x) => x.classList.toggle("on", x === b));
    savePrefs({ ...loadPrefs(), budget: S.budget, dial: S.dial, party: S.party });
  });

  $("#rv-lock").onclick = lockIn;
  $("#rv-reroll").onclick = reroll;
  $("#rv-save").onclick = () => {
    const on = toggleSaved(S.mem, S.plan.hero.v.id);
    $("#rv-save").classList.toggle("on", on);
    $("#rv-save").textContent = on ? "♥ Saved" : "♡ Save";
    toast(on ? "Saved to the wishlist." : "Removed.");
  };
  $("#lk-share").onclick = async () => {
    const r = await sharePlan(S.plan, S.ctx, S.mem.dates.length);
    if (r === "downloaded") toast("Card saved — post it wherever you gloat.");
  };
  $("#lk-again").onclick = resetToAsk;
  $$("dialog .x").forEach((b) => b.onclick = () => b.closest("dialog").close());
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || S.view !== "explore" || document.querySelector("dialog[open]")) return;
    if (S.ex.venue) {
      S.ex.venue = null; S.map.clearSpot?.(); renderExplore();
      const g = S.exIndex.groups.get(S.ex.hood);
      if (g) S.map.markSpots(g.venues);
    } else if (S.ex.hood) exBackToCity();
  });
  $("#stayin-out").onclick = () => { $("#stayin").close(); S.mode = "out"; S.vibe = null; newSession(); runDecision(); };
}


/* ================================ EXPLORE ================================= */
/* The catalog half of the product: the 2.5D map is the menu, the panel is
 * the index. Editorial takes stay short and sharp; every venue offers a
 * bridge back to the engine ("make it tonight's plan"). */

const HOOD_TAKES = {
  "Logan Square": "The creative-class homestead: boulevards, natural wine, and the city's best run of bars that don't try too hard.",
  "Wicker Park": "Got famous, got expensive, kept its record stores and its six-corners people-watching.",
  "Bucktown": "Wicker's quieter sibling — old taverns and white-tablecloth rooms hiding on side streets.",
  "West Town": "A catch-all that quietly collects some of the city's most serious kitchens and least serious bars.",
  "Ukrainian Village": "Dive-bar royalty and pierogi heritage, holding the line against the condo tide.",
  "East Village": "Small blocks, big kitchens — the tasting menus snuck in while nobody was looking.",
  "Pilsen": "Murals, carnitas, and galleries that open late — Mexican heritage and art on the same walls.",
  "Bridgeport": "The South Side's unexpected cool: slashies, a revived movie palace, and a quarry with a skyline view.",
  "Chinatown": "Dumplings till late, a riverfront pagoda park, and the best food-per-dollar math in the city.",
  "Uptown": "Faded-marquee glamour: century-old jazz rooms, honky-tonks, and Argyle Street's kitchens.",
  "Andersonville": "Swedish bones, queer heart, magic lounge — a main street that still feels like a main street.",
  "Lincoln Park": "Blues bars and fondue dens between the zoo and the lake — date-night classics live here.",
  "Lakeview": "Rock clubs, a movie palace, and showtunes at full volume — the North Side at play.",
  "Northalsted": "The rainbow-pyloned main drag where every night can end in a singalong.",
  "Wrigleyville": "You know what this is. Go for the marquee venues, stay clear on game days — or don't.",
  "Lincoln Square": "Giddings Plaza charm, steins of pilsner, and a bookstore that pours wine.",
  "North Center": "Hand-set pins, slow-brewed lagers — old hobbies done properly.",
  "Roscoe Village": "A village-sized strip with jazz couches and adventurous little rooms.",
  "Ravenswood": "Brewery corridor by the Metra tracks, pizza worth a pilgrimage.",
  "Avondale": "The next Logan Square, still priced like the last one — venues, beer gardens, metal burgers.",
  "West Loop": "Restaurant row and its splurges — where Chicago goes to celebrate something.",
  "Fulton Market": "Meatpacking sheds turned rooftops and tasting rooms. Dress code: whatever, confidently.",
  "River North": "Steakhouse-and-gallery country with tiki bars and jazz clubs in the cracks.",
  "River West": "Old-man bars and candlelit baths — the in-between zone that rewards knowing one address.",
  "The Loop": "After the offices empty: symphony halls, rooftop glasshouses, and taverns under the L.",
  "Old Town": "Comedy's company town, plus taverns older than your grandparents' marriage.",
  "Gold Coast": "Hotel-bar hour: piano lounges, Manhattans, and a museum of surgical oddities.",
  "Streeterville": "Contemporary art and a secret lakefront park hiding beside the pier.",
  "South Loop": "Blues legends and rock rooms in the shadow of the old printing houses.",
  "Museum Campus": "Planetarium skyline views — the city's best free panorama.",
  "Hyde Park": "University gravity: serious theater, Southern-table dining, and limestone steps into the lake.",
  "Woodlawn": "Bookstore-café roots and neighborhood pride south of the Midway.",
  "South Shore": "Home of the Arts Bank — an archive of Black culture unlike anywhere else in America.",
  "Chatham": "Aquarium-smoker barbecue that defines the South Side canon.",
  "Little Italy": "Taylor Street's old guard: beef stands, lemonade ice, century-old bakeries.",
  "Near West Side": "Maxwell Street's last echoes — polish sausage at 3 a.m. is a birthright.",
  "Little Village": "La Villita: the Mexican Midwest's kitchen, with a speakeasy behind a candy shop.",
  "Archer Heights": "Worth the drive for one perfect thing: goat birria done one way, forever.",
  "Humboldt Park": "Lagoon sunsets, jibaritos, and lounges that look like movie sets.",
  "Noble Square": "A legendary shack between the factories books the strangest, warmest nights out.",
  "Goose Island": "The salt shed became the show — industrial riverfront, neon crown.",
  "West Ridge": "Devon's curry houses and charcoal Korean BBQ at hours nothing else keeps.",
  "Norwood Park": "Neon, carhops, and hot dogs with personalities. The drive-in that outlived the century.",
  "Edgewater": "Lakefront porches and Granville's quiet charms north of the marquees.",
  "East Garfield Park": "Two acres of jungle under glass — the West Side's warmest secret, especially in February.",
};

function buildExploreIndex() {
  const groups = new Map(); // polygon/geom key -> { venues, display }
  for (const v of S.venues) {
    const key = v.geom || v.hood;
    if (!groups.has(key)) groups.set(key, { venues: [], names: {} });
    const g = groups.get(key);
    g.venues.push(v);
    g.names[v.hood] = (g.names[v.hood] || 0) + 1;
  }
  for (const [key, g] of groups) {
    g.display = Object.entries(g.names)
      .sort((a, b) => (b[1] - a[1]) || (b[0] === key) - (a[0] === key))[0][0];
    g.venues.sort((a, b) => (b.inst - a.inst) || a.name.localeCompare(b.name));
  }
  S.exIndex = { groups };
}

const exInset = () => matchMedia("(min-width: 920px)").matches
  ? { right: 430 / innerWidth } : { bottom: Math.min(0.47, 420 / innerHeight) };
const tiltZoom = () => (S.map?.tilt === "full" ? 0.8 : S.map?.tilt === "mid" ? 0.88 : 1);

function exSelectHood(key) {
  S.ex.hood = key; S.ex.venue = null;
  S.ex.vibe = "all"; // a fresh room, a fresh menu
  S.map.clearSpot?.();
  S.exCam = S.map.selectHood(key, { inset: exInset() });
  renderExplore();
  const g = S.exIndex.groups.get(key);
  if (g) exAfterCam(() => { if (S.ex.hood === key && !S.ex.venue) S.map.markSpots(g.venues); });
}

function exBackToCity() {
  S.ex.hood = null; S.ex.venue = null;
  S.map.clearSpot?.();
  S.map.selectHood(null, { camera: false });
  S.exCam = S.map.cityView(exInset(), tiltZoom());
  renderExplore();
}

/* overlays + tilt (persisted) */
function toggleOverlay(kind, force) {
  const btn = kind === "transit" ? $("#ov-transit") : $("#ov-streets");
  const on = force ?? !btn.classList.contains("on");
  btn.classList.toggle("on", on);
  S.map.setOverlay(kind, on);
  if (on) {
    if (kind === "transit") S.map.loadTransit("data/cta-lines.min.geojson");
    else S.map.loadStreets("data/streets.min.geojson");
  }
  const prefs = loadPrefs();
  savePrefs({ ...prefs, ovTransit: $("#ov-transit").classList.contains("on"),
              ovStreets: $("#ov-streets").classList.contains("on") });
}

/* run fn once the last camera move settles (markers size from the final box) */
function exAfterCam(fn) {
  (S.exCam?.then ? S.exCam : Promise.resolve()).then(fn);
}

function exBadges(v) {
  const b = [];
  if (v.mine) b.push("◆ yours");
  if (v.inst) b.push("★ institution");
  if (v.late) b.push("open late");
  if (v.outdoor) b.push("outdoors");
  return b.join(" · ");
}

function renderExplore() {
  const el = $("#ex-sheet");
  const { groups } = S.exIndex;

  /* ---- venue detail ---- */
  if (S.ex.venue) {
    const v = S.venues.find((x) => x.id === S.ex.venue);
    const saved = S.mem.saved.includes(v.id);
    el.innerHTML = `
      <button class="ex-back" id="ex-back">← ${esc(groups.get(S.ex.hood)?.display || "back")}</button>
      <p class="ex-kicker">${esc(v.cat).toUpperCase()}${v.mine ? " · ◆ YOURS" : ""}</p>
      <h2 class="ex-title">${esc(v.name)}</h2>
      <p class="ex-meta">${esc(v.hood)} · ${"$".repeat(v.price)} · ${esc(travelLabel(haversineMi(origin(), v)))}</p>
      <p class="ex-venue-take">${esc(v.take)}</p>
      <div class="prof-chips">
        ${v.vibes.map((vb) => { const V = VIBES.find((x) => x.id === vb); return V ? `<span class="pc hot">${V.icon} ${esc(V.name)}</span>` : ""; }).join("")}
        ${(v.bestFor || []).map((b) => `<span class="pc">${esc(b)}</span>`).join("")}
        ${v.inst ? `<span class="pc cool">★ institution</span>` : ""}
        ${v.late ? `<span class="pc cool">open late</span>` : ""}
        ${v.outdoor ? `<span class="pc cool">outdoors</span>` : ""}
        ${(v.seasons || []).includes("all") ? "" : (v.seasons || []).map((x) => `<span class="pc">${esc(x)} thing</span>`).join("")}
      </div>
      <div class="energy-row"><span>ENERGY</span>
        <span class="dots">${[1,2,3,4,5].map((n) => `<span class="${n <= v.energy ? "on" : ""}"></span>`).join("")}</span>
        <span>${v.energy <= 2 ? "hushed" : v.energy === 3 ? "lively" : "loud"}</span>
        <button class="been-toggle ${(S.mem.been[v.id] || 0) > 0 ? "on" : ""}" id="ex-been" style="margin-left:auto">
          ${(S.mem.been[v.id] || 0) > 0 ? "✓ been here" : "mark as been"}</button>
      </div>
      <p class="rv-hours">${hoursLine(v)}${v.tips?.length ? ` <span class="tips">· ${v.tips.map(esc).join(" · ")}</span>` : ""}${v.approx ? ` <span class="tips">· location approximate</span>` : ""}</p>
      <div class="ex-actions">
        <button class="btn primary" id="ex-adopt">⚡ Make it tonight's plan</button>
        ${v.mine ? `<div style="display:flex;gap:9px">
          <a class="btn ghost" style="flex:1" target="_blank" rel="noopener" href="${suggestUrl(v)}">Suggest to ChiLocal ↗</a>
          <button class="btn ghost" style="flex:1" id="ex-remove">🗑 Remove</button>
        </div>` : ""}
        <div style="display:flex;gap:9px">
          <button class="btn ghost heart ${saved ? "on" : ""}" id="ex-save" style="flex:1">${saved ? "♥ Saved" : "♡ Save"}</button>
          ${v.addr ? `<a class="btn ghost" style="flex:1" target="_blank" rel="noopener"
            href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.name + " " + v.addr + " Chicago")}">Map ↗</a>` : ""}
          ${v.site ? `<a class="btn ghost" style="flex:1" href="${esc(v.site)}" target="_blank" rel="noopener">Site ↗</a>` : ""}
          ${v.vibes.includes("dinner") && !v.mine ? `<a class="btn ghost" style="flex:1" href="${esc(reserveUrl(v))}" target="_blank" rel="noopener">Table ↗</a>` : ""}
        </div>
      </div>`;
    $("#ex-back").onclick = () => { S.ex.venue = null; S.map.clearSpot?.(); renderExplore(); };
    $("#ex-adopt").onclick = () => adoptAsPlan(v);
    $("#ex-save").onclick = () => {
      const on = toggleSaved(S.mem, v.id);
      $("#ex-save").classList.toggle("on", on);
      $("#ex-save").textContent = on ? "♥ Saved" : "♡ Save";
    };
    $("#ex-been").onclick = () => {
      const n = toggleBeen(S.mem, v.id);
      $("#ex-been").classList.toggle("on", n > 0);
      $("#ex-been").textContent = n > 0 ? "✓ been here" : "mark as been";
      toast(n > 0 ? "Logged — the engine won't re-suggest it for a while." : "Cleared.");
    };
    $("#ex-remove") && ($("#ex-remove").onclick = () => {
      saveMyPlaces(loadMyPlaces().filter((m) => m.id !== v.id));
      refreshVenues();
      S.ex.venue = null;
      S.map.clearSpot?.();
      renderExplore();
      toast("Removed.");
    });
    exAfterCam(() => { if (S.ex.venue === v.id) S.map.markSpot(v); });
    return;
  }

  /* ---- hood view ---- */
  if (S.ex.hood) {
    const g = groups.get(S.ex.hood);
    const display = g?.display || S.ex.hood;
    const take = HOOD_TAKES[display] || HOOD_TAKES[S.ex.hood] ||
      (g ? Object.keys(g.names).map((n) => HOOD_TAKES[n]).find(Boolean) : null);
    const list = (g?.venues || []).filter((v) => S.ex.vibe === "all" || v.vibes.includes(S.ex.vibe));
    el.innerHTML = `
      <button class="ex-back" id="ex-back">← the whole city</button>
      <h2 class="ex-title">${esc(display)}</h2>
      ${display !== S.ex.hood ? `<p class="ex-sub">officially “${esc(S.ex.hood)}”</p>` : ""}
      ${take ? `<p class="ex-take">${esc(take)}</p>` : ""}
      ${g ? `
        <div class="fchips" id="ex-vchips">
          <button data-v="all" class="${S.ex.vibe === "all" ? "on" : ""}">All (${g.venues.length})</button>
          ${VIBES.filter((vb) => g.venues.some((v) => v.vibes.includes(vb.id)))
            .map((vb) => `<button data-v="${vb.id}" class="${S.ex.vibe === vb.id ? "on" : ""}">${vb.icon} ${esc(vb.name)}</button>`).join("")}
        </div>
        ${list.map((v) => `
          <button class="ex-row" data-id="${esc(v.id)}">
            <span class="n">${S.mem.saved.includes(v.id) ? `<span class="rowheart">♥</span> ` : ""}${esc(v.name)}</span>
            <span class="m">${esc(v.cat)} · ${"$".repeat(v.price)}</span>
            <span class="ven-badges">${exBadges(v)}</span>
          </button>`).join("")}
        <div class="ex-actions"><button class="btn ghost" id="ex-surprise">🎲 Surprise us — but here</button></div>`
      : `<p class="ex-empty">No picks here yet — the engine is still eating its way across the city.</p>
         <div class="ex-actions"><button class="btn ghost" id="ex-addhere">+ Put a place here yourself</button></div>`}`;
    $("#ex-back").onclick = exBackToCity;
    $$("#ex-vchips button", el).forEach((b) => b.onclick = () => { S.ex.vibe = b.dataset.v; renderExplore(); });
    $$(".ex-row", el).forEach((b) => b.onclick = () => { S.ex.venue = b.dataset.id; renderExplore(); });
    $("#ex-addhere") && ($("#ex-addhere").onclick = () => openAddPlace(S.ex.hood));
    $("#ex-surprise") && ($("#ex-surprise").onclick = () => {
      newSession();
      S.session.onlyGeom = S.ex.hood;
      S.mode = "out"; S.vibe = null;
      setView("tonight");
      runDecision();
    });
    return;
  }

  /* ---- city view ---- */
  el.innerHTML = `
    <p class="ex-kicker">THE BOOK OF THE CITY</p>
    <h2 class="ex-title">Browse <em>Chicago</em></h2>
    <p class="ex-sub">${S.venues.length} places we'd stand behind · tap the map or the list</p>
    <input class="ex-search" id="ex-q" placeholder="Search spots or neighborhoods…" value="${esc(S.ex.q)}" autocomplete="off"/>
    <div class="fchips" id="ex-vchips">
      <button data-v="all" class="${S.ex.vibe === "all" ? "on" : ""}">All</button>
      ${VIBES.map((vb) => `<button data-v="${vb.id}" class="${S.ex.vibe === vb.id ? "on" : ""}">${vb.icon} ${esc(vb.name)}</button>`).join("")}
    </div>
    <div id="ex-results"></div>
    <button class="linkish" id="ex-addplace" style="margin-top:12px">+ Add your own spot</button>`;

  const renderResults = () => {
    const box = $("#ex-results");
    const q = S.ex.q.trim().toLowerCase();
    if (q) {
      const hoodHits = [...groups.entries()]
        .filter(([key, g]) => g.display.toLowerCase().includes(q) || key.toLowerCase().includes(q))
        .slice(0, 4);
      const venueHits = S.venues.filter((v) =>
        v.name.toLowerCase().includes(q) || v.cat.toLowerCase().includes(q)).slice(0, 12);
      box.innerHTML = hoodHits.map(([key, g]) => `
          <button class="ex-row" data-hood="${esc(key)}">
            <span class="n">${esc(g.display)}</span><span class="c">${g.venues.length} spots →</span>
          </button>`).join("") +
        venueHits.map((v) => `
          <button class="ex-row" data-id="${esc(v.id)}">
            <span class="n">${S.mem.saved.includes(v.id) ? `<span class="rowheart">♥</span> ` : ""}${esc(v.name)}</span><span class="m">${esc(v.cat)} · ${esc(v.hood)}</span>
          </button>`).join("") ||
        `<p class="ex-empty">Nothing by that name in the book yet.</p>`;
    } else {
      const hoods = [...groups.entries()]
        .map(([key, g]) => ({ key, ...g }))
        .filter((g) => S.ex.vibe === "all" || g.venues.some((v) => v.vibes.includes(S.ex.vibe)))
        .sort((a, b) => b.venues.length - a.venues.length);
      box.innerHTML = hoods.map((g) => `
        <button class="ex-row" data-hood="${esc(g.key)}">
          <span class="n">${esc(g.display)}</span>
          <span class="c">${(S.ex.vibe === "all" ? g.venues : g.venues.filter((v) => v.vibes.includes(S.ex.vibe))).length} spots →</span>
        </button>`).join("");
    }
    $$(".ex-row[data-hood]", box).forEach((b) => b.onclick = () => exSelectHood(b.dataset.hood));
    $$(".ex-row[data-id]", box).forEach((b) => b.onclick = () => {
      const v = S.venues.find((x) => x.id === b.dataset.id);
      S.ex.hood = v.geom || v.hood; S.ex.venue = v.id;
      S.exCam = S.map.selectHood(S.ex.hood, { inset: exInset() });
      renderExplore();
    });
  };

  $("#ex-addplace").onclick = () => openAddPlace();
  // typing only re-renders the results — the input (and its caret) survive
  $("#ex-q").oninput = (e) => { S.ex.q = e.target.value; renderResults(); };
  $$("#ex-vchips button", el).forEach((b) => b.onclick = () => { S.ex.vibe = b.dataset.v; renderResults();
    $$("#ex-vchips button", el).forEach((x) => x.classList.toggle("on", x === b)); });
  renderResults();
}

/* -------- add your own spot (localStorage; suggest upstream via GitHub) ---- */
const ADD_CATS = ["Restaurant", "Bar", "Cafe", "Venue", "Culture", "Outdoors", "Something else"];
function openAddPlace(presetHood) {
  const d = S.draftPlace || (S.draftPlace = { vibes: [], price: 2, ll: null, hood: presetHood || null });
  const dlg = $("#addplace");
  $("#ap-name").value = d.name || "";
  $("#ap-cat").innerHTML = ADD_CATS.map((c) => `<option ${d.cat === c ? "selected" : ""}>${c}</option>`).join("");
  $("#ap-take").value = d.take || "";
  $("#ap-price").innerHTML = [1, 2, 3, 4].map((n) =>
    `<button data-v="${n}" class="${d.price === n ? "on" : ""}">${"$".repeat(n)}</button>`).join("");
  $$("#ap-price button").forEach((b) => b.onclick = () => {
    d.price = +b.dataset.v;
    $$("#ap-price button").forEach((x) => x.classList.toggle("on", x === b));
  });
  $("#ap-vibes").innerHTML = VIBES.map((v) =>
    `<button data-v="${v.id}" class="${d.vibes.includes(v.id) ? "on" : ""}">${v.icon} ${esc(v.name)}</button>`).join("");
  $$("#ap-vibes button").forEach((b) => b.onclick = () => {
    const i = d.vibes.indexOf(b.dataset.v);
    if (i >= 0) d.vibes.splice(i, 1); else d.vibes.push(b.dataset.v);
    b.classList.toggle("on", i < 0);
    apValidate();
  });
  $("#ap-loc").textContent = d.ll
    ? `📍 pinned — ${d.hood || "Chicago"} (${d.ll.lat.toFixed(4)}, ${d.ll.lng.toFixed(4)})`
    : "no pin yet";
  $("#ap-pick").onclick = () => {
    d.name = $("#ap-name").value; d.take = $("#ap-take").value; d.cat = $("#ap-cat").value;
    dlg.close();
    if (S.view !== "explore") setView("explore");
    const prevTilt = S.map.tilt;
    if (prevTilt !== "flat") S.map.setTilt("flat"); // pin placement needs untilted coords
    toast("Tap the map exactly where it is.");
    S.map.armPlacePick((ll) => {
      d.ll = ll;
      d.geom = polygonAt(ll);
      d.hood = d.geom ? (S.exIndex.groups.get(d.geom)?.display || d.geom) : null;
      if (prevTilt !== "flat") S.map.setTilt(prevTilt);
      openAddPlace();
    });
  };
  const apValidate = () => {
    $("#ap-save").disabled = !($("#ap-name").value.trim() && d.vibes.length && d.ll);
  };
  $("#ap-name").oninput = apValidate;
  apValidate();
  $("#ap-save").onclick = () => {
    const mine = loadMyPlaces();
    mine.push({
      id: "my-" + $("#ap-name").value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" + (mine.length + 1),
      name: $("#ap-name").value.trim(),
      cat: $("#ap-cat").value,
      hood: d.hood || "Chicago", geom: d.geom || null,
      vibes: d.vibes.slice(), price: d.price, energy: 3,
      take: $("#ap-take").value.trim() || "One of ours.",
      lat: +d.ll.lat.toFixed(5), lng: +d.ll.lng.toFixed(5),
    });
    saveMyPlaces(mine);
    S.draftPlace = null;
    refreshVenues();
    dlg.close();
    toast("Added to your places — the engine can pick it now.");
    if (S.view === "explore") renderExplore();
  };
  dlg.showModal();
}

function reserveUrl(v) {
  return "https://www.opentable.com/s?covers=2&term=" + encodeURIComponent(v.name + " Chicago");
}

function suggestUrl(v) {
  const body = encodeURIComponent(
`**Spot:** ${v.name}
**Neighborhood:** ${v.hood}
**Category:** ${v.cat}
**Coordinates:** ${v.lat}, ${v.lng}
**Price (1-4):** ${v.price}
**Vibes:** ${v.vibes.join(", ")}
**Why it belongs:** ${v.take}

---
Suggested from the app. Review: verify it's open (OSM / city license), then add to scripts/seed-venues.json and run the pipeline (see PRODUCT.md).`);
  return `https://github.com/Aceospades95/chilocal/issues/new?title=${encodeURIComponent("Suggest a spot: " + v.name)}&body=${body}&labels=spot-suggestion`;
}

/* Jump anywhere → a venue's profile in Explore. */
function openVenueProfile(id) {
  const v = S.venues.find((x) => x.id === id);
  if (!v) { toast("That spot isn't in the book anymore."); return; }
  $$("dialog[open]").forEach((d) => d.close());
  S.ex.hood = v.geom || v.hood;
  S.ex.venue = v.id;
  if (S.view !== "explore") {
    S.view = "explore";
    $$("#mode-seg button").forEach((b) => b.classList.toggle("on", b.dataset.m === "explore"));
    S.map.clearReveal();
    S.map.setExplore(true);
    S.map.loadDetail?.("data/detail.min.geojson");
    show("explore");
  }
  S.exCam = S.map.selectHood(S.ex.hood, { inset: exInset() });
  renderExplore();
}

/* Browse → tonight: adopt a venue as the plan, honestly justified. */
function adoptAsPlan(v) {
  newSession();
  const memv = memoryView(S.mem);
  const rand = mulberry32(hashStr(S.ctx.nightKey + "|adopt|" + v.id));
  const budget = Math.max(S.budget, v.price);
  const { reasons } = scoreVenue(v, { vibe: null, budget, party: S.party }, S.ctx, memv, rand);
  const second = pickSecond(v, S.venues, { vibe: null, budget }, S.ctx);
  const why = "Your pick — we just did the homework. " +
    whyLine(v, reasons, { vibe: null, budget }, S.ctx, {});
  S.mode = "out"; S.vibe = null;
  S.plan = { hero: { v, score: 0, reasons, extra: {} }, second, alts: [], why };
  S.session.excluded.add(v.id);
  setView("tonight");
  renderReveal();
}

boot();
