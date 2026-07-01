/* app.js — ChiLocal "decide our night" orchestrator.
 * Screens: ask → (vibes | two-player) → deciding → reveal → locked.
 * One plan at a time. Never a list. */

import { prepVenues, decide, VIBES, vibeName, haversineMi, travelLabel, openState, fmtClock, DIST_DIALS } from "./engine.js?v=n1";
import { buildContext } from "./context.js?v=n1";
import { loadMemory, memoryView, setHome, toggleSaved, lockDate, habitNudge } from "./memory.js?v=n1";
import { NightMap } from "./nightmap.js?v=n1";
import { sharePlan } from "./share.js?v=n1";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const PREFS_KEY = "chilocal.prefs.v1";
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"); } catch { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* */ } };

const S = {
  venues: [], geo: null, map: null, ctx: null, mem: null,
  mode: "out", vibe: null, budget: 2, dial: "hop", party: "couple",
  p1: null, p2: null, twoStep: null,
  plan: null, session: null, vetoes: { p1: 1, p2: 1 },
  screen: "ask",
};

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
  S.venues = prepVenues(venuesRaw.venues);
  S.geo = geo;
  S.ctx = ctx;
  S.map = new NightMap($("#nm"), geo);

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
  const mapMode = name === "deciding" || name === "reveal";
  $("#mapwrap").classList.toggle("on", mapMode);
  $("#mapwrap").classList.toggle("deciding", name === "deciding");
  document.body.dataset.screen = name;
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
  $("#nights-chip").textContent = n ? `${n} night${n > 1 ? "s" : ""} logged` : "";
  $("#nights-chip").style.display = n ? "" : "none";

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
    savePrefs({ budget: S.budget, dial: S.dial, party: S.party });
  });
  $$("#seg-dist button", el).forEach((b) => b.onclick = () => {
    S.dial = b.dataset.v; $$("#seg-dist button", el).forEach((x) => x.classList.toggle("on", x === b));
    savePrefs({ budget: S.budget, dial: S.dial, party: S.party });
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
  const lineEl = $("#think-line");
  let li = 0;
  lineEl.textContent = THINK_LINES[0](S.ctx);
  const timer = setInterval(() => {
    li = (li + 1) % THINK_LINES.length;
    lineEl.textContent = THINK_LINES[li](S.ctx);
  }, 620);

  const input = {
    mode: S.mode, vibe: S.mode === "out" ? S.vibe : null,
    budget: S.budget, maxMi: DIST_DIALS.find((d) => d.id === S.dial).mi,
    origin: origin(), party: S.party,
    p1: S.p1e || null, p2: S.p2e || null,
  };
  const memv = memoryView(S.mem);
  let venues = S.venues;
  if (S.avoidHood) venues = venues.filter((v) => v.hood !== S.avoidHood);

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

  if (plan.empty) {
    show("ask");
    toast("Even we couldn't make that work tonight. Loosen a dial?");
    return;
  }
  S.plan = plan;
  S.session.excluded.add(plan.hero.v.id);
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
  const memv = memoryView(S.mem);
  const input = { vibe: S.mode === "out" ? S.vibe : null, budget: S.budget };
  // recompute pairing + why for the new hero
  import("./engine.js?v=n1").then(({ pickSecond, whyLine }) => {
    S.plan.second = pickSecond(alt.v, S.venues.filter((x) =>
      haversineMi(origin(), x) <= DIST_DIALS.find((d) => d.id === S.dial).mi + 1), { vibe: input.vibe, budget: S.budget }, S.ctx);
    S.plan.why = whyLine(alt.v, alt.reasons, input, S.ctx, alt.extra);
    renderReveal();
  });
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
  $("#lk-hero").textContent = v.name;
  $("#lk-meta").innerHTML = metaLine(v);
  const sec = S.plan.second;
  $("#lk-second").textContent = sec ? `then ${sec.venue.name} — ${travelLabel(sec.mi)}` : "";
  $("#lk-second").style.display = sec ? "" : "none";

  const o = origin();
  const dest = encodeURIComponent(`${v.name}, ${v.addr ? v.addr + ", " : ""}Chicago, IL`);
  $("#lk-directions").href =
    `https://www.google.com/maps/dir/?api=1&origin=${o.lat},${o.lng}&destination=${dest}`;

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
function openNights() {
  const dlg = $("#nights");
  const rows = [...S.mem.dates].reverse().map((d) =>
    `<div class="night-row"><span class="nn">#${d.n}</span><span class="nd">${esc(d.iso)}</span><span class="nv">${esc(d.heroName)}</span><span class="nh">${esc(d.hood)}</span></div>`).join("");
  const saved = S.mem.saved.map((id) => S.venues.find((v) => v.id === id)).filter(Boolean)
    .map((v) => `<span class="chip">${esc(v.name)}</span>`).join(" ");
  $("#nights-body").innerHTML =
    (rows ? `<h3>The log</h3>${rows}` : `<p class="mutep">No nights logged yet. Lock a plan and it starts counting.</p>`) +
    (saved ? `<h3>Wishlist</h3><div class="chips">${saved}</div>` : "");
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
  $$(".back-ask").forEach((b) => b.onclick = resetToAsk);

  $$("#party-seg button").forEach((b) => b.onclick = () => {
    S.party = b.dataset.v;
    $$("#party-seg button").forEach((x) => x.classList.toggle("on", x === b));
    savePrefs({ budget: S.budget, dial: S.dial, party: S.party });
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
  $("#stayin-out").onclick = () => { $("#stayin").close(); S.mode = "out"; S.vibe = null; newSession(); runDecision(); };
}

boot();
