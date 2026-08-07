/* app.js — ChiLocal "decide our night" orchestrator.
 * Screens: ask → (vibes | two-player) → deciding → reveal → locked.
 * One plan at a time. Never a list. */

import { prepVenues, decide, scoreVenue, pickSecond, secondPool, buildCrawl, whyLine, mulberry32, hashStr, VIBES, vibeName, haversineMi, travelLabel, openState, fmtClock, DIST_DIALS } from "./engine.js?v=n25";
import { buildContext } from "./context.js?v=n25";
import { loadMemory, memoryView, setHome, toggleSaved, toggleBeen, lockDate, habitNudge, logGenerated,
         starUpNext, unstarUpNext, isUpNext, onMemorySaveError } from "./memory.js?v=n25";
import { NightMap } from "./nightmap.js?v=n25";
import { sharePlan } from "./share.js?v=n25";

// the build tag also lives in the footer — the first question when a deploy
// "didn't take" is always "which build am I actually looking at?"
console.info("ChiLocal · build v=n25");

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/* a toggle that reads right to a screen reader too — every .on flip should
 * carry aria-pressed along with it */
const press = (el, on) => { el.classList.toggle("on", on); el.setAttribute("aria-pressed", String(!!on)); };

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
  ex: { hood: null, venue: null, vibe: "all", q: "", price: null, open: false },
  exIndex: null,
};

/* ?debug=1 → the engine shows its work (scores, reason codes, filter drops) */
const DEBUG = new URLSearchParams(location.search).has("debug");

/* ------------------------ companion API (optional) ------------------------
 * A tiny server (server/server.mjs) unlocks live CTA arrivals, tonight's
 * events, and two-phone mode. Default: same-origin /api (a proxy route on
 * the host). ?api=http://host:8787 overrides for LAN testing (persisted).
 * If the probe fails, every server feature simply stays hidden. */
const API_BASE = (() => {
  try {
    const p = new URLSearchParams(location.search).get("api");
    if (p != null) {
      if (p === "") localStorage.removeItem("chilocal.api");
      else localStorage.setItem("chilocal.api", p);
    }
    return (p || localStorage.getItem("chilocal.api") || "").replace(/\/+$/, "");
  } catch { return ""; }
})();
const api = (path, opts = {}) => fetch(API_BASE + path, { credentials: "include", ...opts });

function probeApi() {
  api("/api/health", { signal: AbortSignal.timeout(2500) })
    .then((r) => (r.ok ? r.json() : null))
    .then((h) => {
      S.api = h;
      if (h?.events) loadEvents();
      if (h?.rooms) { const tp = $("#btn-two .tp"); if (tp) tp.textContent = "one phone or two"; }
      if (h?.auth) authMe();
      renderAcct();
    })
    .catch(() => { S.api = null; renderAcct(); });
}

/* ------------------------------ accounts ---------------------------------
 * The avatar (top right) is the door: sign in / join, settings, log out.
 * Sessions are HttpOnly cookies — the page never sees a token. */
async function authMe() {
  try {
    const r = await api("/api/auth/me", { signal: AbortSignal.timeout(4000) });
    // only a real answer signs anyone out — a proxy hiccup or a dead wifi
    // hop must not log out a known-good session
    if (r.status === 401) S.user = null;
    else if (r.ok) {
      const d = await r.json();
      S.user = d.user || null;
    }
  } catch { /* network blip — keep whoever we already know */ }
  renderAcct();
}

/* the avatar menu open/close, with aria-expanded kept honest */
function setAcctMenu(open) {
  $("#acct-menu").hidden = !open;
  $("#acct-chip").setAttribute("aria-expanded", String(!!open));
}

function renderAcct() {
  const chip = $("#acct-chip");
  if (S.user) {
    // a server-side record can be missing a name (or, corrupted, an email)
    chip.textContent = ((S.user.name || S.user.email || "?")[0] || "?").toUpperCase();
    chip.classList.add("in");
  } else {
    chip.textContent = "👤";
    chip.classList.remove("in");
  }
  const menu = $("#acct-menu");
  menu.setAttribute("role", "menu");
  menu.innerHTML = S.user ? `
      <div class="am-head"><b>${esc(S.user.name || S.user.email || "You")}</b><span>${esc(S.user.email || "")}</span></div>
      <button class="am-item" role="menuitem" data-a="settings">⚙️ Settings</button>
      <button class="am-item" role="menuitem" data-a="logout">Sign out</button>` :
    (S.api?.auth ? `
      <button class="am-item join" role="menuitem" data-a="auth">★ Sign in / join ChiLocal</button>
      <button class="am-item" role="menuitem" data-a="settings">⚙️ Settings</button>` : `
      <button class="am-item" role="menuitem" data-a="settings">⚙️ Settings</button>
      <div class="am-note">accounts aren't switched on here yet</div>`);
  $$(".am-item", menu).forEach((b) => b.onclick = () => {
    setAcctMenu(false);
    if (b.dataset.a === "settings") { renderAcctSettings(); $("#settings").showModal(); }
    if (b.dataset.a === "auth") openAuth("login");
    if (b.dataset.a === "logout") {
      // revoke server-side, then reload: nginx (or the client gate)
      // lands the signed-out visitor back at the door
      api("/api/auth/logout", { method: "POST" })
        .catch(() => {})
        .finally(() => {
          try { localStorage.removeItem("chilocal.member"); } catch { /* fine */ }
          location.reload();
        });
    }
  });
}

/* client-side sanity checks before any auth fetch — the server would say
 * no anyway, but a round trip to learn your email has no @ is rude */
function authClientError(t, email, pass, name) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim())) return "That email doesn't look right.";
  if (String(pass || "").length < 8) return "Passwords need 8+ characters.";
  if (t !== "login" && !String(name || "").trim()) return "Tell us what to call you.";
  return null;
}
/* the server's raw failure strings are dev-speak — translate before showing */
const politeErr = (msg) => /^(upstream failed|bad json|too large)$/i.test(String(msg || "").trim())
  ? "Something broke on our end — try again in a minute." : msg;

function openAuth(tab) {
  const dlg = $("#auth");
  const setTab = (t) => {
    $$("#auth-tabs button").forEach((b) => press(b, b.dataset.t === t));
    $("#au-name").hidden = t === "login";
    $("#au-digest-row").hidden = t === "login";
    $("#au-pass").autocomplete = t === "login" ? "current-password" : "new-password";
    // same words as the gate — one product, one door
    $("#auth-title").textContent = t === "login" ? "Welcome back" : "Create your account";
    $("#auth-sub").textContent = t === "login"
      ? "Your nights, on any device."
      : "Pick a name, and you're in — it takes ten seconds.";
    $("#auth-go .cta-big").textContent = t === "login" ? "Sign in →" : "Create account →";
    $("#au-forgot").hidden = !(t === "login" && S.api?.email);
    $("#auth-err").hidden = true;
    dlg.dataset.tab = t;
  };
  $$("#auth-tabs button").forEach((b) => b.onclick = () => setTab(b.dataset.t));
  setTab(tab || "login");
  $("#auth-form").onsubmit = async (e) => {
    e.preventDefault();
    const t = dlg.dataset.tab;
    const err = $("#auth-err");
    err.hidden = true;
    const bad = authClientError(t, $("#au-email").value, $("#au-pass").value, $("#au-name").value);
    if (bad) { err.textContent = bad; err.hidden = false; return; }
    const go = $("#auth-go");
    go.disabled = true;
    try {
      const body = t === "login"
        ? { email: $("#au-email").value, password: $("#au-pass").value }
        : { email: $("#au-email").value, password: $("#au-pass").value,
            name: $("#au-name").value, wantsDigest: $("#au-digest").checked };
      const r = await api(`/api/auth/${t === "login" ? "login" : "signup"}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify(body),
      }).then((x) => x.json());
      if (r.error) { err.textContent = politeErr(r.error); err.hidden = false; return; }
      S.user = r.user;
      try { localStorage.setItem("chilocal.member", "1"); } catch { /* fine */ }
      dlg.close();
      $("#au-pass").value = "";
      renderAcct();
      toast(t === "login"
        ? (r.user.name ? `Welcome back, ${r.user.name}.` : "Welcome back.")
        : `Welcome to the city${r.user.name ? `, ${r.user.name}` : ""}.`);
    } catch {
      err.textContent = "Couldn't reach the server — try again.";
      err.hidden = false;
    } finally { go.disabled = false; }
  };
  dlg.showModal();
}

/* events → venues: match by venue name (both directions) or ~100m proximity.
 * A matched venue gets v._event and the engine treats it as a real, cited
 * reason ("🎫 tonight here"). Unmatched events are ignored — we never show
 * an event at a place we can't place. */
async function loadEvents() {
  try {
    const evs = await api("/api/events/today", { signal: AbortSignal.timeout(7000) }).then((r) => r.json());
    if (!Array.isArray(evs) || !evs.length) return;
    const nrm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    let hits = 0;
    for (const v of S.baseVenues) {
      const vn = nrm(v.name), vo = nrm(v.nameOsm);
      const ev = evs.find((e) => {
        const en = nrm(e.venue);
        if (en && en.length >= 5 && (en === vn || en === vo || en.includes(vn) || vn.includes(en))) return true;
        return e.lat && e.lng && Math.abs(e.lat - v.lat) < 0.0011 && Math.abs(e.lng - v.lng) < 0.0015;
      });
      if (ev) { v._event = { name: ev.name, time: ev.time, url: ev.url }; hits++; }
    }
    if (hits) refreshVenues();
  } catch { /* events are a bonus, never a blocker */ }
}

/* live CTA arrivals (via the companion proxy — the CTA API has no CORS).
 * Fills a placeholder span after render; on any failure it stays empty. */
async function fillArrivals(sel, v) {
  const st = nearestL(v);
  const el = $(sel);
  if (!el || !st?.id || !S.api?.cta) return;
  try {
    const d = await api(`/api/cta/arrivals?mapid=${st.id}`, { signal: AbortSignal.timeout(6000) }).then((r) => r.json());
    if (!d?.arrivals?.length) return;
    const by = new Map();
    for (const a of d.arrivals) {
      const k = `${a.route} → ${a.dest}`;
      if (!by.has(k)) by.set(k, []);
      if (by.get(k).length < 2) by.get(k).push(a.app ? "due" : `${a.min} min`);
    }
    const line = [...by].slice(0, 3).map(([k, ts]) => `${k}: ${ts.join(", ")}`).join(" · ");
    el.textContent = ` · live at ${d.station || st.n}: ${line}`;
  } catch { /* silence — the static walk-time line still stands */ }
}

/* place my-places into the live pool (engine + explore see them as venues) */
function refreshVenues() {
  const mine = loadMyPlaces().map((m) => ({
    indoor: true, outdoor: false, seasons: ["all"], late: false, inst: false,
    bestFor: [], hours: null, src: "local", mine: true, ...m,
  }));
  S.venues = prepVenues([...S.baseVenues, ...mine]);
  if (S.geo) buildExploreIndex();
  if (S.map && S.exIndex) S.map.setLabelWeights(exLabelWeights());
}

/* curated venues light a hood fully; map-book spots count for a shimmer */
const exLabelWeights = () => new Map([...S.exIndex.groups].map(([k, g]) =>
  [k, g.venues.length + Math.min(g.base.length, 12) * 0.25]));

/* one lookup across both books: curated+yours, then the city map book */
const findSpot = (id) => S.venues.find((x) => x.id === id) || (S.base || []).find((x) => x.id === id);

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
  // in the outer ring AND not in a hole — Wrigleyville lives inside a hole
  // in Lake View; outer-ring-only would hand its points to Lake View
  return polys.some((poly) => poly.length && inRing(poly[0]) && !poly.slice(1).some(inRing));
}
function polygonAt(ll) {
  for (const f of S.geo.features) if (pointInFeature(ll, f)) return f.properties.name;
  return null;
}

/* ------------------------------ boot ------------------------------------- */
const okJson = (r) => { if (!r.ok) throw new Error("fetch " + r.status); return r.json(); };

/* one failed fetch used to mean a permanent black screen (#app never gets
 * .ready) — now it means this card and a retry button */
function bootFail() {
  document.body.classList.remove("booting");
  let el = $("#boot-fail");
  if (!el) {
    el = document.createElement("div");
    el.id = "boot-fail";
    el.style.cssText = "position:fixed;inset:0;z-index:80;display:grid;place-items:center;padding:24px;background:#04070e;";
    document.body.appendChild(el);
  }
  el.innerHTML = `
    <div class="gate-card" style="text-align:center">
      <h2 style="margin:0 0 8px">The city didn't load.</h2>
      <p class="mutep">Your connection hiccuped before we could fetch tonight's map. Nothing's lost.</p>
      <button class="cta slim" id="boot-retry"><span class="cta-big">Try again →</span></button>
    </div>`;
  $("#boot-retry").onclick = () => {
    el.remove();
    document.body.classList.add("booting");
    boot();
  };
}

async function boot() {
 try {
  const prefs = loadPrefs();
  // saved prefs can be stale or hand-edited — never let a bad value crash
  // the dial lookup later
  S.budget = [1, 2, 3, 4].includes(prefs.budget) ? prefs.budget : 2;
  S.dial = DIST_DIALS.some((d) => d.id === prefs.dial) ? prefs.dial : "hop";
  S.party = ["couple", "group", "solo"].includes(prefs.party) ? prefs.party : "couple";
  S.mem = loadMemory();
  onMemorySaveError(() => toast("Heads up — this browser isn't saving your nights."));

  const [venuesRaw, geo, ctx, baseRaw] = await Promise.all([
    fetch("data/venues.json?v=n25").then(okJson),
    fetch("data/neighborhoods.min.geojson?v=n25").then(okJson),
    buildContext(),
    // the map book: every neighborhood's baseline spots (OSM-verified,
    // Reddit/press-ranked) — explore-only, never Tonight-engine picks
    fetch("data/baseline.json?v=n25").then(okJson).catch(() => ({ venues: [] })),
  ]);
  // CTA knowledge: station list is tiny — fetch in the background, degrade silently
  fetch("data/cta-stations.min.json?v=n25").then((r) => r.json())
    .then((d) => { S.stations = d.stations; }).catch(() => { S.stations = null; });
  // micro-neighborhood names (Bronzeville, Ravenswood, Buena Park…) — the
  // names locals use, resolved to the official boundary that contains them
  fetch("data/hood-aliases.json?v=n25").then((r) => r.json())
    .then((d) => { S.hoodAliases = d.aliases; }).catch(() => { S.hoodAliases = null; });
  probeApi(); // companion server (live arrivals, events, two-phone) — optional
  S.visitor = !!prefs.visitor;
  S.baseVenues = venuesRaw.venues;
  // baseline spots go through the same hours parser as curated ones — a
  // closed map-book bar must say "closed", not "hours unverified"
  S.base = prepVenues(baseRaw.venues || []).map((v) => ({ ...v, base: true, hood: v.hood || v.geom }));
  S.showBase = prefs.mapbook !== "curated";
  S.geo = geo;
  refreshVenues();
  S.ctx = ctx;
  S.map = new NightMap($("#nm"), geo);

  buildExploreIndex();
  S.map.onHoodClick = (name) => {
    if (S.view !== "explore") return;
    const now = performance.now();
    const isDbl = S._hoodClickN === name && now - (S._hoodClickT || 0) < 450;
    S._hoodClickN = name; S._hoodClickT = now;
    if (S.ex.hood === name && !S.ex.venue) {
      // click again = step out — but the 2nd click of a double-click is a
      // zoom gesture, not a step-out; the svg dblclick handler owns it
      if (!isDbl) exBackToCity();
      return;
    }
    S.ex.venue = null;
    exSelectHood(name);
  };
  S.map.onBackgroundClick = () => {
    if (S.view !== "explore") return;
    if (S.ex.venue) { S.ex.venue = null; S.map.clearSpot?.(); renderExplore(); }
    else if (S.ex.hood) exBackToCity();
  };
  S.map.onSpotClick = (id) => {
    if (S.view !== "explore") return;
    // a dot that spawned under the cursor an instant ago (hood just
    // selected) shouldn't hijack the second click of a double-click
    if (performance.now() - (S._hoodClickT || 0) < 450) return;
    S.ex.venue = id;
    renderExplore();
  };

  S.map.setLabelWeights(exLabelWeights());

  // restore map prefs
  S.map.setBasemap(prefs.basemap || "night");
  $$("#bm-seg button").forEach((b) => press(b, b.dataset.b === (prefs.basemap || "night")));
  S.map.setTilt(prefs.tilt || "mid");
  $$("#tilt-seg button").forEach((b) => press(b, b.dataset.t === (prefs.tilt || "mid")));
  if (prefs.bearing) {
    S.map.setBearing(prefs.bearing);
    $('#cam-seg button[data-c="north"]').classList.add("on");
  }
  applySettings(prefs);
  if (prefs.exFolded) setPanelFold(true);
  if (prefs.ovTransit) toggleOverlay("transit", true);
  if (prefs.ovMetra) toggleOverlay("metra", true);
  if (prefs.ovDivvy) toggleOverlay("divvy", true);
  if (prefs.ovStreets) toggleOverlay("streets", true);

  renderContextChip();
  renderAsk();
  wireStatic();
  initShell();
  show("ask");
  $("#app").classList.add("ready");
  document.body.classList.remove("booting");
  registerSW();
  // some people live in Explore — let the app open there
  if (prefs.startView === "explore") setView("explore");
 } catch (e) {
  console.error("boot failed", e);
  bootFail();
 }
}

function newSession() {
  S.session = { excluded: new Set(), vetoed: new Set(), roll: 0 };
  S.vetoes = { p1: 1, p2: 1 };
  clearRemote(); // any fresh flow abandons a live two-phone room
}

/* ------------------------------ screens ---------------------------------- */
function show(name) {
  const prev = S.screen;
  S.screen = name;
  for (const sec of $$(".screen")) sec.classList.toggle("active", sec.id === "screen-" + name);
  const mapMode = name === "deciding" || name === "reveal" || name === "explore";
  $("#mapwrap").classList.toggle("on", mapMode);
  $("#mapwrap").classList.toggle("deciding", name === "deciding");
  document.body.dataset.screen = name;
  // land keyboard/screen-reader focus on the new headline, not wherever it
  // was stranded on the old screen
  const head = $("#screen-" + name)?.querySelector("h1, h2");
  if (head) { head.setAttribute("tabindex", "-1"); head.focus({ preventScroll: true }); }
  syncHistory(name, prev);
  shellOnScreen(name);
}

/* ------------------------- back-button integration -------------------------
 * One history entry per screen you can stand on, so the phone's back
 * gesture walks back through the flow instead of leaving the site.
 * "deciding" is transient — it must never become a back target. */
let histNav = false; // true while a popstate is being applied
function syncHistory(name, prev) {
  if (histNav || name === prev || name === "deciding") return;
  try {
    if (name === "ask") history.replaceState({ screen: "ask" }, "");
    else history.pushState({ screen: name }, "");
  } catch { /* history can be sandboxed — back just leaves, like before */ }
}
window.addEventListener("popstate", (e) => {
  if (!S.mem) return; // still at the gate — nothing to walk back through
  const target = e.state?.screen || "ask";
  histNav = true;
  try {
    if (target === S.screen) return;
    if (target === "explore") { if (S.view !== "explore") setView("explore"); }
    else if (target === "reveal" && S.plan && S.view === "tonight") show("reveal");
    else if (target === "locked" && S.plan && S.view === "tonight") show("locked");
    else if (target === "vibes" && S.view === "tonight") { renderVibes(); show("vibes"); }
    else if (target === "two" && S.p1 && S.view === "tonight") {
      if (S.twoStep === "pass") S.twoStep = "p1";
      renderTwoForm(S.twoStep === "p2" && S.p2 ? "p2" : "p1");
      show("two");
    } else if (target === "pass" && S.p1 && S.view === "tonight") show("pass");
    else resetToAsk();
  } finally { histNav = false; }
});

/* ------------------------------ mode switch ------------------------------- */
function setView(view) {
  if (S.view === view) return;
  if (S.screen === "deciding") return; // don't yank the wheel mid-decision
  S.view = view;
  $$("#mode-seg button").forEach((b) => press(b, b.dataset.m === view));
  if (view === "explore") {
    S.map.clearReveal();
    S.map.setExplore(true);
    S.map.loadDetail?.("data/detail.min.geojson?v=n25");
    if (S.ex.hood) S.exCam = S.map.selectHood(S.ex.hood, { inset: exInset() });
    else S.exCam = S.map.cityView(exInset(), tiltZoom());
    applyPassportView(); // the passport tint survives mode round-trips
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
  syncTabbar();
}

function renderContextChip() {
  const c = S.ctx;
  const bits = [c.dateLabel];
  // weather that didn't load (or maps to no known code) is simply not
  // mentioned — a header muttering "offline" all night reads like a bug
  if (c.ok && c.temp != null)
    bits.push(`${Math.round(c.temp)}°${c.desc && c.desc !== "—" ? ` ${c.desc}` : ""}`);
  if (c.sunsetLabel) bits.push(c.sunsetLabel);
  $("#ctx-chip").textContent = bits.join(" · ");
}

/* ----------------------------- ask screen -------------------------------- */
function renderAsk() {
  const homeBtn = $("#home-chip");
  homeBtn.innerHTML = S.mem.home
    ? `from <b>${esc(hoodDisplay(S.mem.home.name))}</b> <span class="edit">change</span>`
    : `<b>Set your home base</b> — where do nights start?`;

  const n = S.mem.dates.length;
  $("#nights-chip").textContent = n ? `📖 night book · ${n}` : "📖 night book";
  $("#nights-chip").style.display = "";

  const nudge = habitNudge(S.mem);
  const el = $("#nudge");
  if (nudge && !S.avoidHood) {
    el.innerHTML = `You always end up in <b>${esc(nudge.hood)}</b> (${nudge.count}×). <button class="linkish" id="nudge-btn">Ban it for tonight</button>`;
    el.hidden = false;
    $("#nudge-btn").onclick = () => {
      S.avoidHood = nudge.hood;
      el.innerHTML = `Fine — <b>${esc(nudge.hood)}</b> is off the table tonight.`;
    };
  } else el.hidden = true;

  press($("#visit-chip"), !!S.visitor);
  $("#visit-chip").innerHTML = S.visitor
    ? `🧳 <b>Visitor mode on</b> <span class="edit">tap to turn off</span>`
    : `🧳 Visiting Chicago? <span class="edit">tourist-friendly picks</span>`;

  // party toggle
  $$("#party-seg button").forEach((b) => press(b, b.dataset.v === S.party));
}

/* --------------------------- dial-it-in screen ---------------------------- */
function renderVibes() {
  const grid = $("#vibe-grid");
  grid.innerHTML = VIBES.map((v) => `
    <button class="vibe-card ${S.vibe === v.id ? "on" : ""}" aria-pressed="${S.vibe === v.id}" data-v="${v.id}">
      <span class="vi">${v.icon}</span><span class="vn">${esc(v.name)}</span>
    </button>`).join("");
  $$(".vibe-card", grid).forEach((b) => b.onclick = () => {
    S.vibe = b.dataset.v;
    $$(".vibe-card", grid).forEach((x) => press(x, x === b));
    $("#go-dial").disabled = false;
  });
  renderDials("#dials-out");
  $("#go-dial").disabled = !S.vibe;
}

function renderDials(sel) {
  const el = $(sel);
  el.innerHTML = `
    <div class="dial"><label>Budget</label><div class="seg" id="seg-budget">
      ${[1, 2, 3, 4].map((n) => `<button data-v="${n}" class="${S.budget === n ? "on" : ""}" aria-pressed="${S.budget === n}">${"$".repeat(n)}</button>`).join("")}
    </div></div>
    <div class="dial"><label>How far</label><div class="seg" id="seg-dist">
      ${DIST_DIALS.map((d) => `<button data-v="${d.id}" class="${S.dial === d.id ? "on" : ""}" aria-pressed="${S.dial === d.id}">${d.label}</button>`).join("")}
    </div></div>`;
  $$("#seg-budget button", el).forEach((b) => b.onclick = () => {
    S.budget = +b.dataset.v; $$("#seg-budget button", el).forEach((x) => press(x, x === b));
    savePrefs({ ...loadPrefs(), budget: S.budget, dial: S.dial, party: S.party });
  });
  $$("#seg-dist button", el).forEach((b) => b.onclick = () => {
    S.dial = b.dataset.v; $$("#seg-dist button", el).forEach((x) => press(x, x === b));
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
  if (S.remote?.role === "guest") {
    $("#two-title").innerHTML = `Your picks — <i>no peeking</i>`;
    $("#two-sub").textContent = "They can't see this. The engine finds the overlap.";
  } else if (S.remote?.role === "host") {
    $("#two-title").innerHTML = `Your picks — <i>code ${esc(S.remote.code)}</i>`;
    $("#two-sub").textContent = "Your partner joins with the code on their phone. No peeking either way.";
  } else {
    $("#two-title").innerHTML = who === "p1"
      ? `Player one — <i>your call</i>`
      : `Player two — <i>no pressure</i>`;
    $("#two-sub").textContent = who === "p1"
      ? "Pick up to two vibes, answer four quick calls. Then hand it over."
      : "Your turn. They can't see this.";
  }

  $("#two-vibes").innerHTML = VIBES.map((v) => `
    <button class="vibe-card sm ${p.vibes.includes(v.id) ? "on" : ""}" aria-pressed="${p.vibes.includes(v.id)}" data-v="${v.id}">
      <span class="vi">${v.icon}</span><span class="vn">${esc(v.name)}</span>
    </button>`).join("");
  $$("#two-vibes .vibe-card").forEach((b) => b.onclick = () => {
    const id = b.dataset.v;
    const i = p.vibes.indexOf(id);
    if (i >= 0) p.vibes.splice(i, 1);
    else { if (p.vibes.length === 2) p.vibes.shift(); p.vibes.push(id); }
    $$("#two-vibes .vibe-card").forEach((x) => press(x, p.vibes.includes(x.dataset.v)));
    validateTwo(who);
  });

  $("#two-binaries").innerHTML = BINARIES.map((q) => `
    <div class="binary" data-q="${q.id}">
      <button data-side="a" class="${p.picks[q.id] === "a" ? "on" : ""}" aria-pressed="${p.picks[q.id] === "a"}">${esc(q.a)}</button>
      <span class="or">or</span>
      <button data-side="b" class="${p.picks[q.id] === "b" ? "on" : ""}" aria-pressed="${p.picks[q.id] === "b"}">${esc(q.b)}</button>
    </div>`).join("");
  $$("#two-binaries .binary").forEach((row) => {
    $$("button", row).forEach((b) => b.onclick = () => {
      p.picks[row.dataset.q] = b.dataset.side;
      $$("button", row).forEach((x) => press(x, x === b));
      validateTwo(who);
    });
  });
  validateTwo(who);
}

function validateTwo(who) {
  // once the guest's picks are sent, the button stays sent — re-enabling
  // it here would quietly offer a second, contradictory submit
  if (S.remote?.sent) {
    $("#two-next").disabled = true;
    $("#two-next").textContent = "Sent ✓ — no peeking";
    return;
  }
  const p = S[who];
  const done = p.vibes.length >= 1 && Object.keys(p.picks).length === BINARIES.length;
  $("#two-next").disabled = !done;
  $("#two-next").textContent =
    S.remote?.role === "guest" ? "Send my picks →" :
    S.remote?.role === "host" ? "Done — waiting on them →" :
    who === "p1" ? "Done — pass the phone →" : "Decide our night →";
}

/* both players' answers are in — fold them into engine inputs and decide.
 * the answers set TONIGHT's dials on the session, never the saved prefs —
 * one game of roulette must not rewrite what you dialed in for yourself */
function finishTwo() {
  const asPrefs = (p) => ({
    vibes: p.vibes,
    quiet: p.picks.quiet === "b" ? 1 : 0,
    classic: p.picks.classic === "a" ? 1 : 0,
  });
  S.p1e = asPrefs(S.p1); S.p2e = asPrefs(S.p2);
  const cheap = [S.p1, S.p2].filter((p) => p.picks.cheap === "a").length;
  const close = [S.p1, S.p2].filter((p) => p.picks.close === "a").length;
  if (!S.session) newSession();
  S.session.budget = cheap >= 1 ? 2 : 4; // anyone says cheap → cheap wins; both go big → go big
  S.session.dial = close === 2 ? "walk" : close === 1 ? "hop" : "any";
  S.mode = "two";
  runDecision();
}

/* tonight's effective dials: session overrides (two-player answers,
 * only-my-list) win over the saved prefs, for this run only */
const effBudget = () => S.session?.budget ?? S.budget;
const effDial = () => (DIST_DIALS.some((d) => d.id === S.session?.dial) ? S.session.dial : S.dial);

function twoNext() {
  if (S.remote?.role === "guest") return guestSend();
  if (S.remote?.role === "host") return hostWaitForGuest();
  if (S.twoStep === "p1") {
    S.twoStep = "pass";
    show("pass");
  } else if (S.twoStep === "p2") {
    finishTwo();
  }
}

/* --------------------- two-phone rooms (companion server) ------------------
 * Same roulette, no phone-passing: host gets a 4-letter code, both pick
 * blind on their own phones, the plan lands on the host's screen and a
 * summary (with the guest's one veto) lands on the guest's. */
function clearRemote() {
  if (S.remote?.timer) clearInterval(S.remote.timer);
  S.remote = null;
  const dlg = $("#tworoom");
  if (dlg?.open) dlg.close();
}

function chooseTwoMode() {
  if (!S.api?.rooms) { startTwo(); return; } // no server → classic pass-the-phone
  const dlg = $("#tworoom");
  $("#tr-body").innerHTML = `
    <h3>Decide together</h3>
    <p class="mutep">One phone or two — either way, no peeking and one veto each.</p>
    <button class="btn ghost tr-opt" id="tr-same">🤝 Same phone — pass it</button>
    <button class="btn ghost tr-opt" id="tr-host">🔗 Two phones — get a code</button>
    <button class="btn ghost tr-opt" id="tr-join">⌨️ Join with their code</button>`;
  $("#tr-same").onclick = () => { dlg.close(); startTwo(); };
  $("#tr-host").onclick = hostRoom;
  $("#tr-join").onclick = joinRoomForm;
  dlg.showModal();
}

async function hostRoom() {
  $("#tr-body").innerHTML = `<h3>Getting a code…</h3>`;
  try {
    const r = await api("/api/room", { method: "POST", signal: AbortSignal.timeout(5000) }).then((x) => x.json());
    if (!r.code) throw new Error();
    // rev counts every plan we publish (rerolls, promoted alts, crawls) —
    // the guest compares rev, so no change ever slips past their screen
    S.remote = { role: "host", code: r.code, timer: null, seenVeto: 0, rev: 0 };
    $("#tr-body").innerHTML = `
      <h3>Room <b class="tr-code">${esc(r.code)}</b></h3>
      <p class="mutep">Your partner: <b>Decide together → Join with their code</b> on their phone. Codes last 2 hours.</p>
      <button class="cta slim" id="tr-start"><span class="cta-big">Make my picks →</span></button>`;
    $("#tr-start").onclick = () => {
      $("#tworoom").close();
      S.p1 = { vibes: [], picks: {} };
      S.p2 = null;
      S.twoStep = "p1";
      renderTwoForm("p1");
      show("two");
    };
  } catch {
    $("#tr-body").innerHTML = `<h3>Couldn't reach the room server.</h3>
      <p class="mutep">Pass the phone instead — same game.</p>
      <button class="cta slim" id="tr-fallback"><span class="cta-big">Same phone →</span></button>`;
    $("#tr-fallback").onclick = () => { $("#tworoom").close(); startTwo(); };
  }
}

function joinRoomForm() {
  $("#tr-body").innerHTML = `
    <h3>Join their room</h3>
    <input id="tr-code-in" maxlength="4" placeholder="CODE" autocomplete="off" autocapitalize="characters"/>
    <p class="mutep" id="tr-join-err"></p>
    <button class="cta slim" id="tr-join-go" disabled><span class="cta-big">Join →</span></button>`;
  const inp = $("#tr-code-in"), go = $("#tr-join-go");
  inp.oninput = () => { inp.value = inp.value.toUpperCase().replace(/[^A-Z]/g, ""); go.disabled = inp.value.length !== 4; };
  inp.focus();
  go.onclick = async () => {
    go.disabled = true;
    try {
      const r = await api(`/api/room/${inp.value}`, { signal: AbortSignal.timeout(5000) }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      S.remote = { role: "guest", code: inp.value, timer: null, shownRev: null };
      $("#tworoom").close();
      S.p1 = { vibes: [], picks: {} }; // the guest's own answers live in p1 locally
      S.twoStep = "p1";
      renderTwoForm("p1");
      show("two");
    } catch (e) {
      $("#tr-join-err").textContent = /no such room/i.test(e.message) ? "No room with that code — check it with them." : "Couldn't reach the room server.";
      go.disabled = false;
    }
  };
}

function hostWaitForGuest() {
  const dlg = $("#tworoom");
  $("#tr-body").innerHTML = `
    <h3>Room <b class="tr-code">${esc(S.remote.code)}</b></h3>
    <p class="mutep">Waiting for their picks… They join with the code, pick blind, hit send.</p>
    <div class="spinner sm"><span></span><span></span><span></span></div>`;
  if (!dlg.open) dlg.showModal();
  if (S.remote.timer) clearInterval(S.remote.timer);
  S.remote.timer = setInterval(async () => {
    if (!S.remote || S.remote.role !== "host") return;
    try {
      const r = await api(`/api/room/${S.remote.code}`, { signal: AbortSignal.timeout(5000) }).then((x) => x.json());
      if (r.error) {
        // the room died server-side (codes last 2 hours) — an honest dead
        // end beats a spinner that polls a ghost forever
        clearInterval(S.remote.timer); S.remote.timer = null;
        $("#tr-body").innerHTML = `<h3>That room expired.</h3>
          <p class="mutep">Codes last two hours. Close this and start a fresh one — same game.</p>`;
        return;
      }
      if (r.guest?.vibes?.length) {
        clearInterval(S.remote.timer); S.remote.timer = null;
        S.p2 = { vibes: r.guest.vibes, picks: r.guest.picks || {} };
        if (dlg.open) dlg.close();
        finishTwo(); // → decide → reveal on this phone; plan posts to the room
      }
    } catch { /* keep polling — transient network is fine */ }
  }, 2500);
}

async function guestSend() {
  const go = $("#two-next");
  if (go.disabled) return; // a double-tap must not submit twice
  go.disabled = true;
  try {
    await api(`/api/room/${S.remote.code}/submit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ role: "guest", prefs: { vibes: S.p1.vibes, picks: S.p1.picks } }),
    });
  } catch { toast("Couldn't send — try again."); go.disabled = false; return; }
  // sent for good — validateTwo keeps the button in this state from here on
  S.remote.sent = true;
  go.textContent = "Sent ✓ — no peeking";
  guestWait();
}

function guestWait() {
  const dlg = $("#tworoom");
  const render = (room) => {
    const p = room?.plan;
    if (!p) {
      $("#tr-body").innerHTML = `
        <h3>Sent. No peeking.</h3>
        <p class="mutep">The reveal lands on their phone — the plan summary shows here too.</p>
        <div class="spinner sm"><span></span><span></span><span></span></div>`;
      return;
    }
    // track the host's publish counter (rev), not the roll — promoted
    // alternates and crawls change the plan without changing the roll
    S.remote.shownRev = p.rev ?? p.roll ?? 0;
    $("#tr-body").innerHTML = `
      <p class="kicker">TONIGHT'S PLAN${p.roll ? ` · TAKE ${p.roll + 1}` : ""} · CHOSEN FOR BOTH OF YOU</p>
      <h3 class="tr-hero">${esc(p.hero)}</h3>
      <p class="mutep">${esc(p.hood)}${p.second ? ` · then ${esc(p.second)}` : ""}${p.third ? ` · then ${esc(p.third)}` : ""}</p>
      ${p.why ? `<p class="tr-why">“${esc(p.why)}”</p>` : ""}
      ${room.vetoUsed
        ? `<p class="mutep">Your veto is spent. It's decided.</p>`
        : `<button class="btn ghost" id="tr-veto">🙅 Use your one veto</button>`}`;
    const vb = $("#tr-veto");
    if (vb) vb.onclick = async () => {
      vb.disabled = true;
      try {
        await api(`/api/room/${S.remote.code}/submit`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(5000),
          body: JSON.stringify({ role: "guest", veto: true }),
        });
        $("#tr-body").insertAdjacentHTML("beforeend", `<p class="mutep">Vetoed. They're rerolling…</p>`);
      } catch { vb.disabled = false; toast("Couldn't send the veto — try again."); }
    };
  };
  render(null);
  if (!dlg.open) dlg.showModal();
  if (S.remote.timer) clearInterval(S.remote.timer);
  S.remote.timer = setInterval(async () => {
    if (!S.remote || S.remote.role !== "guest") return;
    try {
      const r = await api(`/api/room/${S.remote.code}`, { signal: AbortSignal.timeout(5000) }).then((x) => x.json());
      if (r.error) {
        clearInterval(S.remote.timer); S.remote.timer = null;
        $("#tr-body").innerHTML = `<h3>The room's gone.</h3>
          <p class="mutep">It expired or they started over. Check with them and join a fresh code.</p>`;
        return;
      }
      if (r.plan && (r.plan.rev ?? r.plan.roll ?? 0) !== S.remote.shownRev) render(r);
      else if (r.vetoUsed && $("#tr-veto")) render(r);
    } catch { /* keep polling */ }
  }, 2500);
}

/* host: publish each revealed plan to the room + watch for the guest's veto */
function postRoomPlan() {
  if (S.remote?.role !== "host" || !S.plan?.hero) return;
  const p = S.plan;
  S.remote.rev = (S.remote.rev || 0) + 1;
  api(`/api/room/${S.remote.code}/submit`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "host", plan: {
      hero: p.hero.v.name, hood: p.hero.v.hood, why: p.why,
      second: p.second?.venue.name || null, third: p.third?.venue.name || null,
      roll: S.session.roll, rev: S.remote.rev } }),
  }).catch(() => { /* summary is a courtesy; the host screen is the source */ });
  if (S.remote.timer) clearInterval(S.remote.timer);
  S.remote.timer = setInterval(async () => {
    if (!S.remote || S.remote.role !== "host") return;
    try {
      const r = await api(`/api/room/${S.remote.code}`, { signal: AbortSignal.timeout(5000) }).then((x) => x.json());
      if (r.error) {
        // the room expired under us — stop polling a ghost, and be honest
        // that the remote veto channel is gone
        clearInterval(S.remote.timer); S.remote.timer = null;
        toast("The two-phone room expired — their veto can't reach you anymore.");
        return;
      }
      if (r.veto > S.remote.seenVeto) {
        S.remote.seenVeto = r.veto;
        // a veto that limps in after the night is locked changes nothing —
        // Date #N is already in the book
        if (S.remote.locked || S.screen === "locked") return;
        S.vetoes.p2 = 0;
        S.session.vetoed.add(S.plan.hero.v.id);
        S.session.roll++;
        toast("They used the veto. Recalculating…");
        runDecision(); // new reveal reposts the plan
      }
    } catch { /* keep polling */ }
  }, 3000);
}

/* ------------------------------ deciding --------------------------------- */
const THINK_LINES = [
  (c) => c.temp != null ? `Reading the sky — ${Math.round(c.temp)}° and ${c.desc}` : "Reading the sky",
  () => `Cross-referencing ${S.venues.length} places worth your time`,
  () => "Skipping everywhere you've already been",
  (c) => (c.hour >= 21 || c.hour < 4) ? "Filtering for open-late only" : "Checking listed hours",
  () => "Weighing the neighborhoods",
  () => "Arguing with ourselves so you don't have to",
];

function origin() {
  return S.mem.home || { name: "the Loop", lat: 41.8832, lng: -87.6324 };
}

async function runDecision() {
  if (!S.mem.home) { openWhere(() => runDecision()); return; }
  if (!S.session) newSession();
  // a room veto can land while the host is off in Explore — flip back to
  // tonight BEFORE the deciding screen locks the view switcher, or the app
  // strands on a spinner nothing can dismiss
  if (S.view !== "tonight") setView("tonight");
  const wasScreen = S.screen === "deciding" ? "ask" : S.screen;

  show("deciding");
  S.map.resetView(500);
  S.map.startScan();
  // rebuild tonight's context every run — a tab left open since happy hour
  // must not score venues like it's still daylight (weather keeps riding
  // its own 30-minute cache, so this is usually instant)
  S.ctx = await buildContext();
  renderContextChip();
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
    budget: effBudget(),
    maxMi: (DIST_DIALS.find((d) => d.id === effDial()) || DIST_DIALS[1]).mi,
    origin: origin(), party: S.party, visitor: !!S.visitor,
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
  // graceful widening: never come back empty-handed. hood- and list-locked
  // sessions already run at maxMi 20 — "widening" to 15 would shrink them
  if (plan.empty && effDial() !== "any" && !S.session.onlyGeom && !S.session.onlyList) {
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

  // user walked away mid-decision — put back the screen we took, never
  // leave "deciding" stranded on stage
  if (S.view !== "tonight") { show(wasScreen); return; }
  if (plan.empty) {
    show("ask");
    if (S.mode === "two" && !S.session.onlyList) {
      // both players' answers survive — one tap runs the same overlap back
      const el = $("#nudge");
      el.innerHTML = `Tonight beat the overlap of you two. <button class="linkish" id="retry-two">Run it back — same answers</button>`;
      el.hidden = false;
      $("#retry-two").onclick = () => {
        el.hidden = true;
        S.session.excluded.clear();
        S.session.roll++;
        runDecision();
      };
      toast("Nothing fits you both right now — loosen a call, or run it back.");
      return;
    }
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
/* the first listed opening from (day, minutes) forward — fuel for the
 * closed line ("opens Tu 5 PM"), never a claim beyond the parsed rules */
const DAY_ABBR = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
function nextOpening(parsed, day, minutes) {
  if (!parsed || parsed.always) return null;
  const spansFor = (d) => {
    let last = null;
    for (const r of parsed.rules) if (r.days.has(d)) last = r.spans; // later rules override
    return last;
  };
  for (let d = 0; d < 7; d++) {
    const dd = (day + d) % 7;
    const spans = (spansFor(dd) || []).filter((sp) => d > 0 || sp.from > minutes)
      .sort((a, b) => a.from - b.from);
    if (spans.length) return `${DAY_ABBR[dd]} ${fmtClock(spans[0].from % 1440)}`;
  }
  return null;
}

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
    // we KNOW it's closed — say so instead of shrugging "unverified"
    const next = nextOpening(v._hours, S.ctx.day, S.ctx.minutes);
    return `<span class="dot warn"></span> Closed right now${next ? ` — opens ${esc(next)}` : ""} <a href="${esc(checkUrl)}" target="_blank" rel="noopener">check ↗</a>`;
  }
  return `<span class="dot unk"></span> Hours unverified — <a href="${esc(checkUrl)}" target="_blank" rel="noopener">check before you go ↗</a>`;
}

function metaLine(v) {
  const mi = haversineMi(origin(), v);
  const bits = [v.cat, v.hood, "$".repeat(v.price), travelLabel(mi)];
  // non-breaking spaces inside each token: the line may wrap BETWEEN facts,
  // never mid-fact ("🚲 ~21 / min" read like a typo)
  return bits.map((b) => esc(b).replaceAll(" ", " ")).join(" · ");
}

/* CTA knowledge: the nearest L station within a real walk */
function nearestL(v) {
  if (!S.stations) return null;
  let best = null;
  for (const st of S.stations) {
    const mi = haversineMi(v, st);
    if (!best || mi < best.mi) best = { ...st, mi };
  }
  return best && best.mi <= 0.9 ? best : null;
}
function lNote(v) {
  const best = nearestL(v);
  if (!best) return "";
  const min = Math.max(2, Math.round(best.mi * 20));
  return `🚇 ${best.n} (${best.l.join("/")}) · ~${min} min walk`;
}

/* one honest word on how each alternate differs from the hero */
function altTag(a, hero) {
  if (a.v.hood !== hero.v.hood) return "different neighborhood";
  if (a.v.price < hero.v.price) return "cheaper";
  if (haversineMi(origin(), a.v) < haversineMi(origin(), hero.v) - 0.7) return "closer";
  if (a.v.energy <= hero.v.energy - 2) return "calmer";
  if (a.v.energy >= hero.v.energy + 2) return "rowdier";
  if (a.v.inst && !hero.v.inst) return "the classic";
  if (!a.v.inst && hero.v.inst) return "the wildcard";
  return "same lane, different room";
}

/* "what could go wrong" — only risks the data can actually support */
function planRisks(plan) {
  const v = plan.hero.v;
  const risks = [];
  // NOTE: the hero's hours state is already on the line above the section —
  // repeating it here made the section feel like filler. Only genuinely
  // additional risks belong in it.
  if (plan.second && !plan.second.venue._hours)
    risks.push(`${plan.second.venue.name}'s hours are unverified — check the second stop too.`);
  if (plan.third && !plan.third.venue._hours)
    risks.push(`${plan.third.venue.name}'s hours are unverified — check the last stop too.`);
  if (v.tips?.some((tip) => /cash/i.test(tip)))
    risks.push("Cash only — hit an ATM on the way.");
  if (!S.ctx.ok) risks.push("Weather didn't load, so this pick ignores tonight's sky.");
  else if (v.outdoor && !v.indoor && S.ctx.precipProb != null && S.ctx.precipProb >= 40)
    risks.push(`${S.ctx.precipProb}% rain risk tonight and this one lives outdoors.`);
  if (haversineMi(origin(), v) > 8)
    risks.push("It's a real trek from your home base — budget the ride.");
  if (v.approx) risks.push("Location is approximate — it's a stroll, not one door.");
  return risks;
}

function debugPanel(plan) {
  if (!DEBUG || !plan.debug) return "";
  const rows = plan.debug.map((c, i) => `
    <tr class="${c === plan.hero ? "win" : ""}">
      <td>${i + 1}</td><td>${esc(c.v.name)}</td><td>${c.score.toFixed(1)}</td>
      <td>${esc(c.reasons.join(",") || "—")}</td><td>${c.v._hours ? "✓" : "?"}</td>
    </tr>`).join("");
  const dropped = Object.entries(plan.filtered || {})
    .map(([k, n]) => `${k}:${n}`).join(" · ");
  return `<details class="dbg" open><summary>engine debug</summary>
    <table><tr><th>#</th><th>venue</th><th>score</th><th>reason codes</th><th>hrs</th></tr>${rows}</table>
    <p>dropped — ${esc(dropped || "none")}</p></details>`;
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
  $("#rv-why").innerHTML = `<span class="why-k">Why tonight:</span> ${esc(why)}${S.plan.widened ? esc(` (We loosened the ${S.plan.widened === "distance" ? "how-far" : S.plan.widened} dial — the strict version came up empty.)`) : ""}`;
  const rvL = lNote(v);
  $("#rv-hours").innerHTML = hoursLine(v) +
    (v._event ? ` <span class="tips evt">· 🎫 tonight here: ${v._event.url ? `<a href="${esc(v._event.url)}" target="_blank" rel="noopener">${esc(v._event.name)}</a>` : esc(v._event.name)}${v._event.time ? ` (${esc(v._event.time)})` : ""}</span>` : "") +
    (rvL ? ` <span class="tips">· ${esc(rvL)}<span class="tips live" id="rv-cta-live"></span></span>` : "") +
    (v.vibes.includes("dinner") && !v.mine ? ` · <a href="${esc(reserveUrl(v))}" target="_blank" rel="noopener">find a table ↗</a>` : "") +
    (v.tips?.length ? ` <span class="tips">· ${v.tips.map(esc).join(" · ")}</span>` : "") +
    (v.approx ? ` <span class="tips">· location approximate — it's a stroll, not one door</span>` : "");
  if (rvL) fillArrivals("#rv-cta-live", v);

  // honesty section: collapsible, only when there's something real to flag
  const risks = planRisks(S.plan);
  const riskEl = $("#rv-risks");
  if (risks.length) {
    riskEl.hidden = false;
    riskEl.innerHTML = `<summary>What could go wrong</summary>
      <ul>${risks.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`;
    riskEl.open = false;
  } else riskEl.hidden = true;

  // the night as NUMBERED STOPS — the headline pick is explicitly stop 1,
  // and everything after it reads as a route, not a buried footnote
  const sec = $("#rv-second");
  const third = S.plan.third;
  if (second) {
    sec.hidden = false;
    const stop = (n, name, sub, take) => `
      <div class="itin-stop">
        <span class="itin-dot">${n}</span>
        <div class="itin-body">
          <div class="itin-line"><span class="itin-name">${esc(name)}</span><span class="itin-sub">${esc(sub)}</span></div>
          ${take ? `<div class="itin-take">${esc(take)}</div>` : ""}
        </div>
      </div>`;
    sec.innerHTML = `
      <div class="itin-k">YOUR NIGHT, IN ORDER</div>
      ${stop(1, v.name, "start here", null)}
      ${stop(2, second.venue.name, `${travelLabel(second.mi)} from stop 1`, second.venue.take)}
      ${third ? stop(3, third.venue.name, `${travelLabel(third.mi)} from stop 2`, third.venue.take)
              : (crawlOption() ? `<button id="rv-crawl" class="linkish crawl-link">+ Add stop 3 — make it a crawl</button>` : "")}`;
    const cb = $("#rv-crawl");
    if (cb) cb.onclick = makeCrawl;
  } else sec.hidden = true;

  // saved state
  $("#rv-save").classList.toggle("on", S.mem.saved.includes(v.id));
  $("#rv-save").textContent = S.mem.saved.includes(v.id) ? "♥ Saved" : "♡ Save";

  // ☆ Up next — "we're doing this one soon": stars the whole plan into the book
  const entry = planEntry(S.plan);
  const star = $("#rv-next");
  const paintStar = (on) => { star.classList.toggle("on", on); star.textContent = on ? "★ Up next" : "☆ Up next"; };
  paintStar(isUpNext(S.mem, entry));
  star.onclick = () => {
    const on = starUpNext(S.mem, planEntry(S.plan));
    paintStar(on);
    toast(on ? "Starred — find it in the night book under Up next." : "Unstarred.");
  };

  // alternates — each labeled by how it differs, never a clone
  $("#rv-alts").innerHTML = (alts.length ? `
    <div class="alts-k">If you dare say no:</div>
    ${alts.map((a, i) => `
      <button class="alt" data-i="${i}">
        <span class="alt-name">${esc(a.v.name)} <span class="alt-tag">${esc(altTag(a, S.plan.hero))}</span></span>
        <span class="alt-meta">${esc(a.v.cat)} · ${esc(a.v.hood)} · ${"$".repeat(a.v.price)}</span>
      </button>`).join("")}` : "") + debugPanel(S.plan);
  $$("#rv-alts .alt").forEach((b) => b.onclick = () => promoteAlt(+b.dataset.i));

  // two-player vetoes. two-phone rooms: player two vetoes from their own
  // screen — showing their button here would let player one spend it
  const vt = $("#rv-vetoes");
  if (S.mode === "two") {
    vt.hidden = false;
    const twoPhone = S.remote?.role === "host";
    vt.innerHTML = `
      <button id="veto1" ${S.vetoes.p1 ? "" : "disabled"}>Veto — player one${S.vetoes.p1 ? "" : " (used)"}</button>
      ${twoPhone
        ? `<span class="mutep">${S.vetoes.p2 ? "Player two vetoes from their phone." : "Player two's veto is spent."}</span>`
        : `<button id="veto2" ${S.vetoes.p2 ? "" : "disabled"}>Veto — player two${S.vetoes.p2 ? "" : " (used)"}</button>`}`;
    $("#veto1").onclick = () => useVeto("p1");
    const v2 = $("#veto2");
    if (v2) v2.onclick = () => useVeto("p2");
  } else vt.hidden = true;

  show("reveal");
  const desktop = matchMedia("(min-width: 920px)").matches;
  // layout viewport, not innerWidth/Height — the visual viewport lies on
  // mobile (browser chrome, pinch state) and would mis-frame the camera
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const inset = desktop ? { right: 470 / vw } : { bottom: Math.min(0.58, 520 / vh) };
  requestAnimationFrame(() => {
    S.map.reveal(origin(), v, { second: second?.venue || null, third: third?.venue || null,
      fast: S.session.roll > 0 || !!third, inset,
      label: v.hood, originName: origin().name, mi: haversineMi(origin(), v) });
  });
  postRoomPlan(); // two-phone: mirror the plan to the guest's screen
}

/* a plan condensed to what the night book stores */
const planEntry = (p) => ({
  heroId: p.hero.v.id || null, heroName: p.hero.v.name,
  heroHood: p.hero.v.hood || "", heroCat: p.hero.v.cat || "",
  secondName: p.second?.venue.name || null, thirdName: p.third?.venue.name || null,
  why: p.why || null,
});

/* the crawl: chain a walkable third stop onto tonight's plan — candidates
 * come from the open/not-vetoed pool, never the raw book */
function crawlOption() {
  const { hero, second } = S.plan;
  if (!second) return null;
  const pool = secondPool(S.venues, S.ctx, S.session);
  return buildCrawl(hero.v, second, pool, { budget: effBudget() }, S.ctx);
}
function makeCrawl() {
  const crawl = crawlOption();
  if (!crawl) { toast(`No walkable third stop near ${S.plan.second.venue.name}.`); return; }
  S.plan.second = crawl.second;
  S.plan.third = crawl.third;
  renderReveal();
}

function promoteAlt(i) {
  const alt = S.plan.alts[i];
  if (!alt) return;
  const oldHero = S.plan.hero;
  S.plan.alts[i] = oldHero;
  S.plan.hero = alt;
  S.plan.third = null; // the crawl was chained off the old hero's stops
  S.session.excluded.add(alt.v.id);
  const input = { vibe: S.mode === "out" ? S.vibe : null, budget: effBudget() };
  // recompute pairing + why for the new hero — from the open/not-vetoed
  // pool, so a promoted alt can't inherit a closed or vetoed second stop
  S.plan.second = pickSecond(alt.v, secondPool(S.venues, S.ctx, S.session),
    { vibe: input.vibe, budget: input.budget }, S.ctx);
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
  if (S.session.roll === 3) toast(S.party === "solo"
    ? "Third roll. At some point the problem is you."
    : "Third roll. At some point the problem is you two.");
  runDecision();
}

/* ------------------------------- locked ----------------------------------- */
function lockIn() {
  // locked means locked — stop the room poll so a guest veto that limps in
  // later can't reroll a night that's already in the book
  if (S.remote?.timer) { clearInterval(S.remote.timer); S.remote.timer = null; }
  if (S.remote) S.remote.locked = true;
  const n = lockDate(S.mem, S.plan, S.vibe);
  const v = S.plan.hero.v;
  $("#lk-date").textContent = `Date #${n}`;
  $("#lk-title").textContent = "It's decided.";
  const heroBtn = $("#lk-hero");
  heroBtn.textContent = v.name;
  heroBtn.onclick = () => openVenueProfile(v.id);
  // role="button" divs don't fire click for Enter/Space on their own
  heroBtn.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); heroBtn.click(); } };
  $("#lk-meta").innerHTML = metaLine(v);
  const sec = S.plan.second, thr = S.plan.third;
  const secEl = $("#lk-second");
  secEl.textContent = sec ? `stop 2 · ${sec.venue.name} — ${travelLabel(sec.mi)}` +
    (thr ? ` · stop 3 · ${thr.venue.name} — ${travelLabel(thr.mi)}` : "") : "";
  secEl.style.display = sec ? "" : "none";
  secEl.onclick = sec ? () => openVenueProfile(sec.venue.id) : null;
  secEl.onkeydown = sec ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); secEl.click(); } } : null;
  secEl.tabIndex = sec ? 0 : -1;
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
  const HOTEL_ZONES = ["Loop", "River North", "Gold Coast", "Streeterville", "West Loop"];
  const render = (q = "") => {
    const ql = q.toLowerCase();
    const zone = !ql ? `<div class="where-zones"><span class="where-k">STAYING DOWNTOWN?</span>${
      HOTEL_ZONES.map((n) => `<button data-n="${esc(n)}">🏨 ${esc(hoodDisplay(n))}</button>`).join("")}</div>` : "";
    list.innerHTML = zone + feats.filter((n) => n.toLowerCase().includes(ql)).slice(0, 60)
      .map((n) => `<button data-n="${esc(n)}">${esc(hoodDisplay(n))}</button>`).join("");
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

/* the polygon is named "Loop"; every human says "The Loop" */
const hoodDisplay = (n) => (n === "Loop" ? "The Loop" : n);

function chooseHome(name) {
  const c = hoodCenter(name);
  if (!c) return;
  setHome(S.mem, { name, ...c });
  $("#where").close();
  renderAsk();
  toast(`Home base: ${hoodDisplay(name)}.`);
  if (whereCb) { const cb = whereCb; whereCb = null; cb(); }
}

function geoHome() {
  if (!navigator.geolocation) { toast("No location access — pick from the list."); return; }
  $("#where-geo").textContent = "Locating…";
  navigator.geolocation.getCurrentPosition((pos) => {
    // the fix can arrive after they closed the dialog — don't hijack
    // whatever they're doing now with a surprise home base
    if (!$("#where").open) return;
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
    if (!$("#where").open) return;
    $("#where-geo").textContent = "Use my location";
    toast("Couldn't get a location — pick from the list.");
  }, { timeout: 6000 });
}

/* ------------------------------ our nights -------------------------------- */
function myListIds() {
  const mine = S.venues.filter((v) => v.mine).map((v) => v.id);
  return [...new Set([...S.mem.saved, ...mine])].filter((id) => S.venues.some((v) => v.id === id));
}

/* a starred night → an .ics file. Floating local time, the coming Friday
 * at 7pm — a sane default the calendar app lets you drag anywhere. No
 * servers, no email: the reminder lives in YOUR calendar. */
function downloadNightIcs(e) {
  const icsEsc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const d = new Date();
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7)); // the coming Friday (today counts)
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const stops = [e.heroName, e.secondName, e.thirdName].filter(Boolean)
    .map((n, i) => `Stop ${i + 1}: ${n}`).join(" · ");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ChiLocal//night//EN",
    "BEGIN:VEVENT",
    `UID:${stamp}-${Math.random().toString(36).slice(2, 8)}@chilocal`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${ymd}T190000`,
    `DTEND:${ymd}T230000`,
    `SUMMARY:${icsEsc(`ChiLocal night: ${e.heroName}`)}`,
    `DESCRIPTION:${icsEsc(stops + (e.why ? `\n${e.why}` : ""))}`,
    e.heroHood ? `LOCATION:${icsEsc(`${e.heroHood}, Chicago`)}` : "",
    "BEGIN:VALARM", "TRIGGER:-PT3H", "ACTION:DISPLAY",
    `DESCRIPTION:${icsEsc(`Tonight: ${e.heroName}`)}`, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ].filter(Boolean);
  const blob = new Blob([lines.join("\r\n")], { type: "text/calendar" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "chilocal-night.ics";
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Calendar file saved — set for Friday at 7 p.m., drag it anywhere.");
}

/* ---- the night book: log · up next · places · passport, one tab each ---- */
function openNights(tab) {
  const dlg = $("#nights");
  // only a real tab name counts — this used to be wired straight to a
  // click handler, so the EVENT OBJECT landed here as `tab`, no tab
  // matched, and the dialog opened with four tabs over an empty body
  const TABS = ["log", "next", "places", "passport"];
  if (TABS.includes(tab)) S.nbTab = tab;
  if (!TABS.includes(S.nbTab)) S.nbTab = "log";
  const T = S.nbTab;
  const body = $("#nights-body");

  const tabs = `
    <div class="seg nb-tabs" id="nb-tabs">
      <button data-t="log" class="${T === "log" ? "on" : ""}" aria-pressed="${T === "log"}">The log</button>
      <button data-t="next" class="${T === "next" ? "on" : ""}" aria-pressed="${T === "next"}">Up next</button>
      <button data-t="places" class="${T === "places" ? "on" : ""}" aria-pressed="${T === "places"}">Your spots</button>
      <button data-t="passport" class="${T === "passport" ? "on" : ""}" aria-pressed="${T === "passport"}">Passport</button>
    </div>`;

  let html = "";
  if (T === "log") {
    const rows = [...S.mem.dates].reverse().map((d) =>
      `<button class="night-row rowbtn" data-vid="${esc(d.heroId || "")}"><span class="nn">#${d.n}</span><span class="nd">${esc(d.iso)}</span><span class="nv">${esc(d.heroName)}</span><span class="nh">${esc(d.hood)}</span></button>`).join("");
    const gen = (S.mem.generated || []).slice(0, 8).map((g, i) =>
      `<div class="night-row gen">
        <button class="star-btn nb-star" data-i="${i}" title="star it — do this one soon">${isUpNext(S.mem, g) ? "★" : "☆"}</button>
        ${g.heroId ? `<button class="linkish nv-link" data-vid="${esc(g.heroId)}">${esc(g.heroName)}</button>` : `<span class="nv">${esc(g.heroName)}</span>`}
        <span class="nd">${g.secondName ? "→ " + esc(g.secondName) : esc(g.iso)}</span>
        <button class="linkish gen-share" data-i="${i}">share ↗</button>
      </div>`).join("");
    html = (rows ? `<h3>Nights that happened</h3>${rows}`
                 : `<p class="mutep">No nights locked yet — lock a plan and Date #1 starts the count.</p>`) +
      (gen ? `<h3>The engine suggested lately <span class="nb-hint">star ☆ the ones worth doing</span></h3>${gen}` : "");
  }

  if (T === "next") {
    const up = S.mem.upNext || [];
    const pool = myListIds();
    const rows = up.map((e, i) => `
      <div class="upnext-row">
        <div class="un-main">
          <b>${esc(e.heroName)}</b>${e.secondName ? ` <span class="nd">→ ${esc(e.secondName)}</span>` : ""}${e.thirdName ? ` <span class="nd">→ ${esc(e.thirdName)}</span>` : ""}
          <span class="un-when">starred ${esc(e.iso)}</span>
        </div>
        <div class="un-acts">
          <button class="linkish un-go" data-i="${i}">make it tonight →</button>
          <button class="linkish un-ics" data-i="${i}">⏰ remind me</button>
          <button class="linkish un-rm" data-i="${i}">remove</button>
        </div>
      </div>`).join("");
    const savedIds = S.mem.saved.filter((id) => findSpot(id));
    const saved = savedIds.map((id) => {
      const v = findSpot(id);
      return `<button class="chip chipbtn" data-vid="${esc(v.id)}">${v.mine ? "◆ " : "♥ "}${esc(v.name)}</button>`;
    }).join(" ");
    html = (rows ? `<h3>Nights you've starred</h3>${rows}`
                 : `<p class="mutep">Nothing starred yet. When a plan looks right, hit <b>☆ Up next</b> on the reveal — it lands here.</p>`) +
      (pool.length ? `<button class="btn primary wl-surprise" id="wl-surprise">🎲 Surprise us from our list (${pool.length})</button>` : "") +
      (saved ? `<h3>Spots you've saved</h3><div class="chips">${saved}</div>`
             : `<h3>Spots you've saved</h3><p class="mutep">Tap ♡ Save on any spot and it waits here.</p>`);
  }

  if (T === "places") {
    const mine = S.venues.filter((v) => v.mine)
      .map((v) => `<button class="chip chipbtn" data-vid="${esc(v.id)}">◆ ${esc(v.name)}</button>`).join(" ");
    html = (mine ? `<h3>Spots you added</h3><div class="chips">${mine}</div>`
                 : `<p class="mutep">Nothing yet. Your own spots live on your device, show up in Explore with a ◆, and can be suggested to the ChiLocal book.</p>`) +
      `<button class="btn ghost" id="nights-add" style="margin-top:12px">+ Add your own spot</button>`;
  }

  if (T === "passport") {
    const pass = passportStats();
    const stamped = pass.stamped.map((k) =>
      `<button class="chip chipbtn stamp" data-hood="${esc(k)}">★ ${esc(S.exIndex.groups.get(k)?.display || k)}</button>`).join(" ");
    html = `
      <p class="nb-pass-count"><b>${pass.count}</b> of <b>${pass.total}</b> neighborhoods stamped</p>
      <p class="mutep">A stamp = a locked night or a spot marked “been” there. The city is the book — fill it.</p>
      ${stamped ? `<div class="chips">${stamped}</div>` : `<p class="mutep">No stamps yet — lock a night somewhere and it inks itself.</p>`}
      <div class="ex-actions">
        <button class="btn primary" id="nb-passmap">🗺️ See it on the map</button>
        ${pass.unvisited.length ? `<button class="btn ghost" id="nb-stamp">🎲 Stamp somewhere new</button>` : ""}
      </div>`;
  }

  body.innerHTML = tabs + html;

  $$("#nb-tabs button").forEach((b) => b.onclick = () => openNights(b.dataset.t));
  $$("[data-vid]", body).forEach((b) => {
    if (b.dataset.vid) b.onclick = () => openVenueProfile(b.dataset.vid);
  });
  $$(".nb-star", body).forEach((b) => b.onclick = (ev) => {
    ev.stopPropagation();
    const g = S.mem.generated[+b.dataset.i];
    starUpNext(S.mem, { heroId: g.heroId, heroName: g.heroName, heroHood: g.heroHood || "",
                        heroCat: g.heroCat || "", secondName: g.secondName || null,
                        thirdName: null, why: g.why || null });
    openNights(T);
  });
  $$(".un-go", body).forEach((b) => b.onclick = () => {
    const e = S.mem.upNext[+b.dataset.i];
    dlg.close();
    const v = e.heroId ? findSpot(e.heroId) : null;
    // hand the starred entry along so the stops adopt verbatim
    if (v && !v.base) { adoptAsPlan(v, e); return; }
    toast("That spot isn't in the book anymore — reroll one like it.");
  });
  $$(".un-ics", body).forEach((b) => b.onclick = () => downloadNightIcs(S.mem.upNext[+b.dataset.i]));
  $$(".un-rm", body).forEach((b) => b.onclick = () => { unstarUpNext(S.mem, +b.dataset.i); openNights(T); });
  $("#wl-surprise") && ($("#wl-surprise").onclick = () => {
    dlg.close();
    newSession();
    S.session.onlyList = new Set(myListIds());
    S.mode = "out"; S.vibe = null;
    if (S.view !== "tonight") setView("tonight");
    runDecision();
  });
  $("#nights-add") && ($("#nights-add").onclick = () => { dlg.close(); openAddPlace(); });
  $("#nb-passmap") && ($("#nb-passmap").onclick = () => {
    dlg.close();
    S.ex.passport = true;
    if (S.view !== "explore") setView("explore"); else { applyPassportView(); renderExplore(); }
  });
  $("#nb-stamp") && ($("#nb-stamp").onclick = () => {
    dlg.close();
    const pass = passportStats();
    const pool = pass.unvisited.slice(0, 10);
    const [key] = pool[(Math.random() * pool.length) | 0];
    if (S.view !== "explore") setView("explore");
    exSelectHood(key);
  });
  $$(".chip.stamp", body).forEach((b) => b.onclick = () => {
    dlg.close();
    if (S.view !== "explore") setView("explore");
    exSelectHood(b.dataset.hood);
  });
  $$(".gen-share", body).forEach((b) => b.onclick = async (ev) => {
    ev.stopPropagation();
    if (b.disabled) return;
    b.disabled = true;
    try {
      const g = S.mem.generated[+b.dataset.i];
      const plan = {
        hero: { v: { name: g.heroName, cat: g.heroCat || "", hood: g.heroHood || "" } },
        second: g.secondName ? { venue: { name: g.secondName } } : null,
        why: g.why,
      };
      const r = await sharePlan(plan, S.ctx, null);
      if (r === "downloaded") toast("Card saved.");
      else if (r === "failed") toast("The card wouldn't render — try again.");
    } finally { b.disabled = false; }
  });
  // phone shell: NON-modal, so the tab bar underneath stays live — the
  // book is a sibling destination, not an interruption
  if (!dlg.open) { if (isShell()) dlg.show(); else dlg.showModal(); }
  syncTabbar();
}

/* -------------------------------- stay in --------------------------------- */
function openStayIn() {
  $("#stayin").showModal();
  const res = $("#coin-result");
  res.textContent = "";
  $("#coin").onclick = () => {
    if (S._coinSpin) return; // one flip at a time — double-taps stacked spinners
    S._coinSpin = true;
    const opts = ["Cook something 🍳", "Order in 🥡"];
    let i = 0, spins = 8 + ((Math.random() * 4) | 0);
    const t = setInterval(() => {
      res.textContent = opts[i++ % 2];
      if (i > spins) { clearInterval(t); S._coinSpin = false; }
    }, 110);
  };
}

/* -------------------------------- misc ------------------------------------ */
let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  // popover puts the toast in the top layer, above any open <dialog>;
  // browsers without it just keep the class-toggle rendering
  try { el.showPopover?.(); } catch { /* already open or not a popover */ }
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
    try { el.hidePopover?.(); } catch { /* already closed */ }
  }, 2600);
}

function resetToAsk() {
  clearRemote(); // a live two-phone room dies with the flow that made it
  S.view = "tonight";
  $$("#mode-seg button").forEach((b) => press(b, b.dataset.m === "tonight"));
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
  $("#btn-two").onclick = () => { newSession(); chooseTwoMode(); };
  $("#btn-stayin").onclick = openStayIn;
  $("#go-dial").onclick = () => { newSession(); runDecision(); };
  $("#two-next").onclick = twoNext;
  $("#pass-go").onclick = () => { S.twoStep = "p2"; renderTwoForm("p2"); show("two"); };
  $("#home-chip").onclick = () => openWhere();
  // NOT `= openNights` — the click event would arrive as the tab name and
  // the dialog would open on no tab at all, body empty
  $("#nights-chip").onclick = () => openNights();
  $("#wordmark").onclick = resetToAsk;
  // the wordmark is a div playing button — give the keyboard its due
  $("#wordmark").onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); resetToAsk(); }
  };
  // the toast announces itself to screen readers, politely
  $("#toast").setAttribute("role", "status");
  $("#toast").setAttribute("aria-live", "polite");
  // closing the room dialog must stop its polling — a dismissed dialog
  // that keeps hitting the server is how rooms haunt whole sessions
  $("#tworoom").addEventListener("close", () => {
    if (S.remote?.timer) { clearInterval(S.remote.timer); S.remote.timer = null; }
  });
  // pass screen: player one can step back and fix their picks
  if (!$("#pass-back")) {
    const pb = document.createElement("button");
    pb.id = "pass-back";
    pb.className = "linkish";
    pb.textContent = "← back to player one";
    $("#pass-go").after(pb);
    pb.onclick = () => { S.twoStep = "p1"; renderTwoForm("p1"); show("two"); };
  }
  $$("#mode-seg button").forEach((b) => b.onclick = () => setView(b.dataset.m));
  $$("#tilt-seg button").forEach((b) => b.onclick = () => {
    S.map.setTilt(b.dataset.t);
    $$("#tilt-seg button").forEach((x) => press(x, x === b));
    savePrefs({ ...loadPrefs(), tilt: b.dataset.t });
    if (S.view === "explore" && !S.ex.hood) S.exCam = S.map.cityView(exInset(), tiltZoom());
  });
  // camera cluster: zoom steps about the visible window's center; rotation
  // in 30° stops with N snapping the compass home (persisted like tilt)
  const visAnchor = () => {
    const ins = exInset();
    return ins.right ? { fx: (1 - ins.right) / 2, fy: 0.5 } : { fx: 0.5, fy: (1 - (ins.bottom || 0)) / 2 };
  };
  $$("#cam-seg button").forEach((b) => b.onclick = () => {
    const c = b.dataset.c;
    if (c === "zin" || c === "zout") {
      const a = visAnchor();
      S.map.zoomBy(c === "zin" ? 1 / 1.5 : 1.5, a.fx, a.fy);
    } else {
      const next = c === "north" ? 0 : (S.map.bearing || 0) + (c === "rr" ? 30 : -30);
      S.map.setBearing(next);
      savePrefs({ ...loadPrefs(), bearing: S.map.bearing });
      press($('#cam-seg button[data-c="north"]'), S.map.bearing !== 0);
    }
  });
  $("#ex-fold").onclick = () => setPanelFold(!S.ex.folded);
  wireSettings();
  $("#ov-transit").onclick = () => toggleOverlay("transit");
  $("#ov-metra").onclick = () => toggleOverlay("metra");
  $("#ov-divvy").onclick = () => toggleOverlay("divvy");
  $("#ov-streets").onclick = () => toggleOverlay("streets");
  $$("#bm-seg button").forEach((b) => b.onclick = () => {
    S.map.setBasemap(b.dataset.b);
    $$("#bm-seg button").forEach((x) => press(x, x === b));
    savePrefs({ ...loadPrefs(), basemap: b.dataset.b });
  });
  $("#visit-chip").onclick = () => {
    S.visitor = !S.visitor;
    savePrefs({ ...loadPrefs(), visitor: S.visitor });
    renderAsk();
    toast(S.visitor
      ? "Visitor mode on — the engine leans toward the icons and keeps things close."
      : "Visitor mode off — back to local deep cuts.");
  };
  $("#ov-locate").onclick = () => {
    const btn = $("#ov-locate");
    if (btn.classList.contains("on")) { // second tap clears the marker
      btn.classList.remove("on");
      S.map.clearUser();
      return;
    }
    if (!navigator.geolocation) { toast("This device won't share a location."); return; }
    btn.textContent = "📍 Locating…";
    navigator.geolocation.getCurrentPosition((pos) => {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;
      btn.textContent = "📍 Find me";
      btn.classList.add("on");
      const onMap = S.map.showUser({ lat, lng }, accuracy);
      toast(onMap
        ? `That's you — good to about ${Math.round(accuracy * 3.28)} ft (the dashed circle).`
        : "Your device puts you outside the Chicago map.");
    }, () => {
      btn.textContent = "📍 Find me";
      toast("Couldn't get a location — check the browser's permission.");
    }, { enableHighAccuracy: true, timeout: 8000 });
  };
  $$(".back-ask").forEach((b) => b.onclick = () => {
    // player two bailing out throws away BOTH players' answers — check first
    if (S.screen === "two" && S.twoStep === "p2" &&
        !confirm("Leaving now tosses both players' picks. Start over?")) return;
    resetToAsk();
  });

  $$("#party-seg button").forEach((b) => b.onclick = () => {
    S.party = b.dataset.v;
    $$("#party-seg button").forEach((x) => press(x, x === b));
    savePrefs({ ...loadPrefs(), budget: S.budget, dial: S.dial, party: S.party });
  });

  $("#rv-lock").onclick = lockIn;
  $("#rv-reroll").onclick = reroll;
  $("#rv-save").onclick = () => {
    const on = toggleSaved(S.mem, S.plan.hero.v.id);
    $("#rv-save").classList.toggle("on", on);
    $("#rv-save").textContent = on ? "♥ Saved" : "♡ Save";
    toast(on ? "Saved to your spots." : "Removed.");
  };
  $("#lk-share").onclick = async () => {
    const btn = $("#lk-share");
    if (btn.disabled) return; // one card at a time
    btn.disabled = true;
    try {
      const r = await sharePlan(S.plan, S.ctx, S.mem.dates.length);
      if (r === "downloaded") toast("Card saved — post it wherever you gloat.");
      else if (r === "failed") toast("The card wouldn't render — try again.");
    } finally { btn.disabled = false; }
  };
  $("#lk-again").onclick = resetToAsk;
  $$("dialog .x").forEach((b) => b.onclick = () => b.closest("dialog").close());
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || S.view !== "explore" || document.querySelector("dialog[open]")) return;
    if (S.ex.venue) {
      S.ex.venue = null; S.map.clearSpot?.(); renderExplore();
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
  "Wrigleyville": "You know what this is. Go for the marquee venues, steer clear on game days — or don't.",
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
  "Near West Side": "Maxwell Street's last echoes — Polish sausage at 3 a.m. is a birthright.",
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
  const groups = new Map(); // polygon/geom key -> { venues, base, display }
  // every official polygon gets a group — a neighborhood with no curated
  // venues yet is still a real place you can open, search, and stamp
  for (const f of S.geo?.features || [])
    groups.set(f.properties.name, { venues: [], base: [], names: {} });
  for (const v of S.venues) {
    const key = v.geom || v.hood;
    if (!groups.has(key)) groups.set(key, { venues: [], base: [], names: {} });
    const g = groups.get(key);
    g.venues.push(v);
    g.names[v.hood] = (g.names[v.hood] || 0) + 1;
  }
  for (const v of S.base || []) {
    const g = groups.get(v.geom);
    if (g) g.base.push(v);
  }
  for (const [key, g] of groups) {
    g.display = Object.entries(g.names)
      .sort((a, b) => (b[1] - a[1]) || (b[0] === key) - (a[0] === key))[0]?.[0] || key;
    g.venues.sort((a, b) => (b.inst - a.inst) || a.name.localeCompare(b.name));
    // researched picks first, then the rest of the map book alphabetically
    g.base.sort((a, b) => (!!b.rec - !!a.rec) || a.name.localeCompare(b.name));
  }
  // two groups must never wear the same name: the Art Institute's polygon is
  // Grant Park but its editorial hood is "The Loop" — without this, a search
  // for "the loop" can land on a one-venue Grant Park group also titled
  // "The Loop". The bigger group keeps the popular name; the others revert
  // to their official polygon name.
  const byDisplay = new Map();
  for (const [key, g] of groups) {
    if (!byDisplay.has(g.display)) byDisplay.set(g.display, []);
    byDisplay.get(g.display).push([key, g]);
  }
  for (const [, list] of byDisplay) {
    if (list.length < 2) continue;
    list.sort((a, b) => b[1].venues.length - a[1].venues.length);
    for (const [key, g] of list.slice(1)) g.display = key;
  }
  S.exIndex = { groups };
}

const exInset = () => matchMedia("(min-width: 920px)").matches
  ? (S.ex.folded ? {} : { right: 430 / document.documentElement.clientWidth })
  : { bottom: Math.min(0.47, 420 / document.documentElement.clientHeight) };
const tiltZoom = () => (S.map?.tilt === "full" ? 0.78 : S.map?.tilt === "mid" ? 0.85 : 0.97);

/* the one filter gate for explore lists: vibe, price ceiling, verified-open */
function exPasses(v) {
  if (S.ex.vibe !== "all" && !v.vibes.includes(S.ex.vibe)) return false;
  if (S.ex.price && v.price > S.ex.price) return false;
  if (S.ex.open && !openState(v._hours, S.ctx.day, S.ctx.minutes)?.open) return false;
  return true;
}
const exFiltersOn = () => S.ex.vibe !== "all" || S.ex.price || S.ex.open;

/* map-book spots carry facts, not opinions — no vibe tags, no price tier.
 * Any narrowing filter honestly excludes them rather than guessing. */
const basePasses = (v) => S.ex.vibe === "all" && !S.ex.price && !S.ex.open;

/* second chip row: budget ceiling + verified-open-now */
function exFilterChips2() {
  return `
    <div class="fchips" id="ex-fchips2">
      ${[1, 2, 3, 4].map((n) => `<button data-p="${n}" class="${S.ex.price === n ? "on" : ""}" aria-pressed="${S.ex.price === n}">≤ ${"$".repeat(n)}</button>`).join("")}
      <button data-open="1" class="${S.ex.open ? "on" : ""}" aria-pressed="${!!S.ex.open}">● Open now</button>
    </div>
    ${S.ex.open ? `<p class="ex-hint">“Open now” trusts listed hours only — spots without verified hours are hidden.</p>` : ""}`;
}
function wireFilterChips2(el, rerender) {
  $$("#ex-fchips2 [data-p]", el).forEach((b) => b.onclick = () => {
    S.ex.price = S.ex.price === +b.dataset.p ? null : +b.dataset.p;
    rerender();
  });
  const ob = $("#ex-fchips2 [data-open]", el);
  if (ob) ob.onclick = () => { S.ex.open = !S.ex.open; rerender(); };
}

/* passport: how much of the book you've stamped. A stamp = a locked night
 * or a been-there mark inside that polygon. */
function passportStats() {
  const visited = new Set();
  for (const [id, n] of Object.entries(S.mem.been)) {
    if (n > 0) { const v = findSpot(id); if (v) visited.add(v.geom || v.hood); }
  }
  for (const [hood, n] of Object.entries(S.mem.hoodVisits)) {
    if (n > 0) { const v = S.venues.find((x) => x.hood === hood); if (v) visited.add(v.geom || v.hood); }
  }
  const unvisited = [...S.exIndex.groups.entries()]
    .filter(([key, g]) => !visited.has(key) && (g.venues.length + g.base.length) >= 3)
    .sort((a, b) => (b[1].venues.length + b[1].base.length) - (a[1].venues.length + a[1].base.length));
  const stamped = [...visited].filter((k) => S.exIndex.groups.has(k))
    .sort((a, b) => a.localeCompare(b));
  return { count: visited.size, total: S.geo.features.length, unvisited, stamped };
}

/* the passport painted onto the map: stamped hoods keep their light,
 * everywhere you haven't been goes dim — the to-do list at a glance */
function applyPassportView() {
  S.map.setStamps(S.ex.passport ? new Set(passportStats().stamped) : null);
}

function exSelectHood(key) {
  S.ex.hood = key; S.ex.venue = null;
  S.ex.vibe = "all"; S.ex.price = null; S.ex.open = false; // a fresh room, a fresh menu
  S.map.clearSpot?.();
  S.exCam = S.map.selectHood(key, { inset: exInset() });
  renderExplore(); // draws the venue lights synchronously — they ride the camera
}

function exBackToCity() {
  S.ex.hood = null; S.ex.venue = null;
  S.map.clearSpot?.();
  S.map.selectHood(null, { camera: false });
  S.exCam = S.map.cityView(exInset(), tiltZoom());
  renderExplore();
}

/* the browse panel folds away so the map can have the whole stage */
function setPanelFold(folded) {
  S.ex.folded = !!folded;
  $("#screen-explore").classList.toggle("folded", S.ex.folded);
  document.body.classList.toggle("ex-folded", S.ex.folded);
  $("#ex-fold").textContent = S.ex.folded ? "⟨" : "⟩";
  $("#ex-fold").setAttribute("aria-label", S.ex.folded ? "show panel" : "hide panel");
  S.map.panelW = matchMedia("(min-width: 920px)").matches && !S.ex.folded ? 445 : 12;
  savePrefs({ ...loadPrefs(), exFolded: S.ex.folded });
  if (S.view === "explore") { // reframe for the new visible window
    if (S.ex.hood) S.exCam = S.map.selectHood(S.ex.hood, { inset: exInset() });
    else S.exCam = S.map.cityView(exInset(), tiltZoom());
  }
}

/* settings: accents, map palette, name size — applied live, saved locally */
const PALETTES = {
  classic: { hueShift: 0, satMult: 1 },
  neon:    { hueShift: 150, satMult: 1.5 },
  ember:   { hueShift: -28, satMult: 1.2 },
  steel:   { hueShift: 8, satMult: 0.35 },
};
const ACCENT_DEFAULTS = { "--amber": "#ffb45c", "--coral": "#ff4b5c", "--skyblue": "#64d8ff" };
function applySettings(prefs) {
  const acc = prefs.accents || {};
  for (const [k, def] of Object.entries(ACCENT_DEFAULTS))
    document.documentElement.style.setProperty(k, acc[k] || def);
  S.map.setPalette(PALETTES[prefs.palette] || PALETTES.classic);
  S.map.setLabelScale(prefs.labelScale || 1);
  $$("#set-pal button").forEach((b) => press(b, b.dataset.p === (prefs.palette || "classic")));
  $$("#set-lbl button").forEach((b) => press(b, +b.dataset.l === (prefs.labelScale || 1)));
  for (const inp of $$("#settings input[type=color]"))
    inp.value = acc[inp.dataset.var] || ACCENT_DEFAULTS[inp.dataset.var];
  // behavior: start screen, camera motion, curated-vs-everything
  $$("#set-start button").forEach((b) => press(b, b.dataset.s === (prefs.startView || "tonight")));
  const calm = prefs.motion === "calm";
  S.map._reduced = calm || matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.body.classList.toggle("calm-motion", calm);
  $$("#set-motion button").forEach((b) => press(b, b.dataset.m === (prefs.motion || "full")));
  const showBase = prefs.mapbook !== "curated";
  if (showBase !== S.showBase) {
    S.showBase = showBase;
    if (S.map && S.exIndex) S.map.setLabelWeights(exLabelWeights());
    if (S.view === "explore") renderExplore();
  }
  $$("#set-book button").forEach((b) => press(b, b.dataset.b === (prefs.mapbook || "all")));
}
function wireSettings() {
  const chip = $("#acct-chip"), menu = $("#acct-menu");
  chip.setAttribute("aria-haspopup", "menu");
  chip.setAttribute("aria-expanded", "false");
  chip.onclick = (e) => { e.stopPropagation(); setAcctMenu(menu.hidden); };
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.contains(e.target)) setAcctMenu(false);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) setAcctMenu(false); });
  renderAcct();
  for (const inp of $$("#settings input[type=color]")) {
    inp.oninput = () => {
      document.documentElement.style.setProperty(inp.dataset.var, inp.value);
      const prefs = loadPrefs();
      savePrefs({ ...prefs, accents: { ...(prefs.accents || {}), [inp.dataset.var]: inp.value } });
    };
  }
  $$("#set-pal button").forEach((b) => b.onclick = () => {
    savePrefs({ ...loadPrefs(), palette: b.dataset.p });
    applySettings(loadPrefs());
  });
  $$("#set-lbl button").forEach((b) => b.onclick = () => {
    savePrefs({ ...loadPrefs(), labelScale: +b.dataset.l });
    applySettings(loadPrefs());
  });
  $$("#set-start button").forEach((b) => b.onclick = () => {
    savePrefs({ ...loadPrefs(), startView: b.dataset.s });
    applySettings(loadPrefs());
    toast(b.dataset.s === "explore" ? "The app now opens on Explore." : "The app now opens on Tonight.");
  });
  $$("#set-motion button").forEach((b) => b.onclick = () => {
    savePrefs({ ...loadPrefs(), motion: b.dataset.m });
    applySettings(loadPrefs());
  });
  $$("#set-book button").forEach((b) => b.onclick = () => {
    savePrefs({ ...loadPrefs(), mapbook: b.dataset.b });
    applySettings(loadPrefs());
  });
  $("#set-reset").onclick = () => {
    const prefs = loadPrefs();
    delete prefs.accents; delete prefs.palette; delete prefs.labelScale;
    delete prefs.startView; delete prefs.motion; delete prefs.mapbook;
    savePrefs(prefs);
    applySettings(prefs);
    toast("Back to ChiLocal night.");
  };
}

/* the account block inside Settings: digest opt-in + delete-my-account.
 * Refreshed each time the dialog opens, since S.user can change. */
function renderAcctSettings() {
  renderInstallRow(); // shown to everyone, member section below is gated
  const box = $("#set-acct");
  box.hidden = !S.user;
  if (!S.user) return;
  const dig = $("#set-digest");
  dig.checked = !!S.user.wantsDigest;
  dig.onchange = async () => {
    const want = dig.checked;
    try {
      const r = await api("/api/auth/profile", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(6000),
        body: JSON.stringify({ wantsDigest: want }),
      }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      S.user = r.user;
      toast(want ? "You're on the weekly digest list." : "Off the digest list — no more emails.");
    } catch {
      dig.checked = !want; // server didn't take it — don't lie in the UI
      toast("Couldn't save that — try again.");
    }
  };
  const err = $("#del-err");
  err.hidden = true;
  $("#del-pass").value = "";
  $("#del-go").onclick = async () => {
    err.hidden = true;
    const go = $("#del-go");
    go.disabled = true;
    try {
      const r = await api("/api/auth/account", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ password: $("#del-pass").value }),
      }).then((x) => x.json());
      if (r.error) { err.textContent = r.error; err.hidden = false; return; }
      // account gone, cookie cleared — the reload lands at the gate
      try { localStorage.removeItem("chilocal.member"); } catch { /* fine */ }
      location.reload();
    } catch {
      err.textContent = "Couldn't reach the server — try again.";
      err.hidden = false;
    } finally { go.disabled = false; }
  };
}

/* overlays + tilt (persisted) */
function toggleOverlay(kind, force) {
  const btn = $("#ov-" + kind);
  const on = force ?? !btn.classList.contains("on");
  press(btn, on);
  S.map.setOverlay(kind, on);
  if (on) {
    if (kind === "transit") {
      S.map.loadTransit("data/cta-lines.min.geojson?v=n25");
      S.map.loadStations("data/cta-stations.min.json?v=n25");
    } else if (kind === "metra") S.map.loadMetra("data/metra-lines.min.geojson?v=n25");
    else if (kind === "divvy") S.map.loadDivvy("data/divvy-stations.min.json?v=n25");
    else S.map.loadStreets("data/streets.min.geojson?v=n25");
  }
  const prefs = loadPrefs();
  savePrefs({ ...prefs, ovTransit: $("#ov-transit").classList.contains("on"),
              ovMetra: $("#ov-metra").classList.contains("on"),
              ovDivvy: $("#ov-divvy").classList.contains("on"),
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


/* typo-tolerant search: exact substring first, else every query word must
 * prefix- or nearly-match (edit distance ≤1, ≤2 for 5+ letter words) some
 * word of the candidate — "wickr prk" still finds Wicker Park */
const norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
function editWithin(a, b, k) {
  if (Math.abs(a.length - b.length) > k) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > k) return false;
    prev = cur;
  }
  return prev[b.length] <= k;
}
function fuzzyHas(hay, q) {
  const h = norm(hay);
  if (h.includes(q)) return true;
  const hw = h.split(/[^a-z0-9]+/).filter(Boolean);
  const qw = q.split(/[^a-z0-9]+/).filter(Boolean);
  return qw.length > 0 && qw.every((qt) =>
    hw.some((ht) => ht.startsWith(qt) || editWithin(qt, ht, qt.length >= 5 ? 2 : 1)));
}

function renderExplore() {
  const el = $("#ex-sheet");
  const { groups } = S.exIndex;

  /* ---- venue detail ---- */
  if (S.ex.venue) {
    const v = findSpot(S.ex.venue);
    if (!v) { S.ex.venue = null; renderExplore(); return; }
    const saved = S.mem.saved.includes(v.id);

    // a map-book spot: real facts, no editorial — the profile says exactly that
    if (v.base) {
      el.innerHTML = `
        <button class="ex-back" id="ex-back">← ${esc(groups.get(S.ex.hood)?.display || "back")}</button>
        <p class="ex-kicker">${esc(v.cat).toUpperCase()} · FROM THE CITY MAP</p>
        <h2 class="ex-title">${esc(v.name)}</h2>
        <p class="ex-meta">${esc(groups.get(v.geom)?.display || v.geom)}${v.addr ? ` · ${esc(v.addr)}` : ""}</p>
        ${v.rec ? `<p class="ex-venue-take">${esc(v.rec.note)} <span class="tips">· via ${esc(v.rec.src)}</span></p>` : ""}
        <p class="mutep">In the book but not yet vetted by us — facts come from the city's open map data${v.rec ? " and local write-ups" : ""}. Been? Mark it and it counts toward your passport.</p>
        <p class="rv-hours">${hoursLine(v)}</p>
        <div class="energy-row">
          <button class="been-toggle ${(S.mem.been[v.id] || 0) > 0 ? "on" : ""}" id="ex-been">
            ${(S.mem.been[v.id] || 0) > 0 ? "✓ been here" : "mark as been"}</button>
        </div>
        <div class="ex-actions">
          <div style="display:flex;gap:9px">
            <button class="btn ghost heart ${saved ? "on" : ""}" id="ex-save" style="flex:1">${saved ? "♥ Saved" : "♡ Save"}</button>
            <a class="btn ghost" style="flex:1" target="_blank" rel="noopener"
              href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.name + " " + (v.addr || "") + " Chicago")}">Map ↗</a>
            ${v.site ? `<a class="btn ghost" style="flex:1" href="${esc(v.site)}" target="_blank" rel="noopener">Site ↗</a>` : ""}
          </div>
        </div>`;
      $("#ex-back").onclick = () => { S.ex.venue = null; S.map.clearSpot?.(); renderExplore(); };
      $("#ex-save").onclick = () => {
        const on = toggleSaved(S.mem, v.id);
        $("#ex-save").classList.toggle("on", on);
        $("#ex-save").textContent = on ? "♥ Saved" : "♡ Save";
      };
      $("#ex-been").onclick = () => {
        const n = toggleBeen(S.mem, v.id);
        $("#ex-been").classList.toggle("on", n > 0);
        $("#ex-been").textContent = n > 0 ? "✓ been here" : "mark as been";
        toast(n > 0 ? "Stamped — it counts toward your passport." : "Cleared.");
        if (S.ex.passport) applyPassportView();
      };
      exAfterCam(() => { if (S.ex.venue === v.id) S.map.markSpot(v); });
      return;
    }
    el.innerHTML = `
      <button class="ex-back" id="ex-back">← ${esc(groups.get(S.ex.hood)?.display || "back")}</button>
      <p class="ex-kicker">${esc(v.cat).toUpperCase()}${v.mine ? " · ◆ YOURS" : ""}</p>
      <h2 class="ex-title">${esc(v.name)}</h2>
      <p class="ex-meta">${esc(v.hood)} · ${"$".repeat(v.price)} · ${esc(travelLabel(haversineMi(origin(), v)))}${lNote(v) ? `<br/>${esc(lNote(v))}<span class="tips live" id="ex-cta-live"></span>` : ""}</p>
      ${v._event ? `<p class="ex-meta evt">🎫 tonight here: ${v._event.url ? `<a href="${esc(v._event.url)}" target="_blank" rel="noopener">${esc(v._event.name)}</a>` : esc(v._event.name)}${v._event.time ? ` (${esc(v._event.time)})` : ""}</p>` : ""}
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
          <button class="btn ghost" style="flex:1" id="ex-remove">🗑️ Remove</button>
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
    fillArrivals("#ex-cta-live", v);
    exAfterCam(() => { if (S.ex.venue === v.id) S.map.markSpot(v); });
    return;
  }

  /* ---- hood view ---- */
  if (S.ex.hood) {
    const g = groups.get(S.ex.hood);
    const display = g?.display || S.ex.hood;
    const take = HOOD_TAKES[display] || HOOD_TAKES[S.ex.hood] ||
      (g ? Object.keys(g.names).map((n) => HOOD_TAKES[n]).find(Boolean) : null);
    const list = (g?.venues || []).filter(exPasses);
    const baseList = S.showBase ? (g?.base || []).filter(basePasses) : [];
    const any = list.length + baseList.length > 0;
    el.innerHTML = `
      <button class="ex-back" id="ex-back">← the whole city</button>
      <h2 class="ex-title">${esc(display)}</h2>
      ${display !== S.ex.hood ? `<p class="ex-sub">officially “${esc(S.ex.hood)}”</p>` : ""}
      ${take ? `<p class="ex-take">${esc(take)}</p>` : ""}
      ${(S.hoodAliases?.[S.ex.hood] || []).length ? `<p class="ex-aka">In here: ${(S.hoodAliases[S.ex.hood]).map(esc).join(" · ")}</p>` : ""}
      <div class="fchips" id="ex-vchips">
        <button data-v="all" class="${S.ex.vibe === "all" ? "on" : ""}" aria-pressed="${S.ex.vibe === "all"}">All (${(g?.venues.length || 0) + (S.showBase ? (g?.base.length || 0) : 0)})</button>
        ${VIBES.filter((vb) => (g?.venues || []).some((v) => v.vibes.includes(vb.id)))
          .map((vb) => `<button data-v="${vb.id}" class="${S.ex.vibe === vb.id ? "on" : ""}" aria-pressed="${S.ex.vibe === vb.id}">${vb.icon} ${esc(vb.name)}</button>`).join("")}
      </div>
      ${exFilterChips2()}
      ${list.map((v) => `
        <button class="ex-row" data-id="${esc(v.id)}">
          <span class="n">${S.mem.saved.includes(v.id) ? `<span class="rowheart">♥</span> ` : ""}${esc(v.name)}</span>
          <span class="m">${esc(v.cat)} · ${"$".repeat(v.price)}</span>
          <span class="ven-badges">${exBadges(v)}</span>
        </button>`).join("")}
      ${baseList.length ? `
        <p class="ex-basehead">${list.length ? "Also here" : "What's here"} <span class="nb-hint">from the city map — real places, not yet vetted by us</span></p>
        ${baseList.map((v) => `
          <button class="ex-row base" data-id="${esc(v.id)}">
            <span class="n">${S.mem.saved.includes(v.id) ? `<span class="rowheart">♥</span> ` : ""}${esc(v.name)}${v.rec ? ` <span class="rec-dot" title="locals recommend it">●</span>` : ""}</span>
            <span class="m">${esc(v.cat)}${v.rec?.note ? ` · ${esc(v.rec.note)}` : ""}</span>
          </button>`).join("")}` : ""}
      ${!any && exFiltersOn() ? `<p class="ex-empty">Nothing here matches those filters. <button class="linkish" id="ex-clearf">Clear filters</button></p>` : ""}
      ${!any && !exFiltersOn() ? `<p class="ex-empty">No picks here yet — the engine is still eating its way across the city.</p>` : ""}
      <div class="ex-actions">
        ${list.length ? `<button class="btn ghost" id="ex-surprise">🎲 Surprise us — but here</button>` : ""}
        <button class="btn ghost" id="ex-addhere">+ Put a spot here yourself</button>
      </div>`;
    $("#ex-back").onclick = exBackToCity;
    $$("#ex-vchips button", el).forEach((b) => b.onclick = () => { S.ex.vibe = b.dataset.v; renderExplore(); });
    wireFilterChips2(el, renderExplore);
    $("#ex-clearf") && ($("#ex-clearf").onclick = () => {
      S.ex.vibe = "all"; S.ex.price = null; S.ex.open = false; renderExplore();
    });
    // the lights on the tile always mirror the visible list
    S.map.markSpots([...list, ...baseList]);
    $$(".ex-row[data-id]", el).forEach((b) => b.onclick = () => { S.ex.venue = b.dataset.id; renderExplore(); });
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
  const pass = passportStats();
  const baseTotal = S.showBase ? (S.base || []).length : 0;
  el.innerHTML = `
    <p class="ex-kicker">THE BOOK OF THE CITY</p>
    <h2 class="ex-title">Browse <em>Chicago</em></h2>
    <p class="ex-sub">${S.venues.length} places we'd stand behind${baseTotal ? ` · ${baseTotal} more on the city map` : ""} · all ${S.geo.features.length} neighborhoods</p>
    <p class="ex-passport">🗺️ Passport: <b>${pass.count} of ${pass.total}</b> stamped
      · <button class="linkish ${S.ex.passport ? "on" : ""}" id="ex-passview">${S.ex.passport ? "back to colors" : "see where you've been"}</button>${
      pass.unvisited.length ? ` · <button class="linkish" id="ex-stamp">stamp somewhere new →</button>` : ""}</p>
    <input class="ex-search" id="ex-q" placeholder="Search spots, neighborhoods, vibes…" value="${esc(S.ex.q)}" autocomplete="off"/>
    <div class="fchips" id="ex-vchips">
      <button data-v="all" class="${S.ex.vibe === "all" ? "on" : ""}" aria-pressed="${S.ex.vibe === "all"}">All</button>
      ${VIBES.map((vb) => `<button data-v="${vb.id}" class="${S.ex.vibe === vb.id ? "on" : ""}" aria-pressed="${S.ex.vibe === vb.id}">${vb.icon} ${esc(vb.name)}</button>`).join("")}
    </div>
    ${exFilterChips2()}
    <div id="ex-results"></div>
    <button class="linkish" id="ex-addplace" style="margin-top:12px">+ Add your own spot</button>`;
  $("#ex-stamp") && ($("#ex-stamp").onclick = () => {
    const pool = pass.unvisited.slice(0, 10);
    const [key] = pool[(Math.random() * pool.length) | 0];
    exSelectHood(key);
  });
  $("#ex-passview").onclick = () => {
    S.ex.passport = !S.ex.passport;
    applyPassportView();
    renderExplore();
  };

  const renderResults = () => {
    const box = $("#ex-results");
    const q = norm(S.ex.q.trim());
    if (q) {
      // micro-neighborhood names resolve to the official hood that holds
      // them — "bronzeville" finds Grand Boulevard, "pilsen" Lower West Side
      const aliasOf = (key, g) => {
        if (fuzzyHas(g.display, q) || fuzzyHas(key, q)) return null;
        return (S.hoodAliases?.[key] || []).find((a) => fuzzyHas(a, q)) || false;
      };
      const hoodHits = [...groups.entries()]
        .map(([key, g]) => ({ key, g, via: aliasOf(key, g) }))
        .filter((h) => h.via !== false)
        .slice(0, 4);
      // hoods with no venues yet have no group — but Bronzeville must still
      // find Grand Boulevard, and every official polygon deserves a result
      if (hoodHits.length < 4) {
        const inGroups = new Set(groups.keys());
        for (const f of S.geo.features) {
          const key = f.properties.name;
          if (inGroups.has(key)) continue;
          const via = fuzzyHas(key, q) ? null
            : ((S.hoodAliases?.[key] || []).find((a) => fuzzyHas(a, q)) || false);
          if (via === false) continue;
          hoodHits.push({ key, g: null, via });
          if (hoodHits.length >= 4) break;
        }
      }
      const venueHits = S.venues.filter((v) =>
        (fuzzyHas(v.name, q) || fuzzyHas(v.cat, q) ||
         v.vibes.some((vb) => fuzzyHas(vibeName(vb), q))) &&
        (!S.ex.price || v.price <= S.ex.price) &&
        (!S.ex.open || openState(v._hours, S.ctx.day, S.ctx.minutes)?.open)).slice(0, 12);
      const baseHits = S.showBase && !S.ex.price && !S.ex.open
        ? (S.base || []).filter((v) => fuzzyHas(v.name, q) || fuzzyHas(v.cat, q)).slice(0, 8) : [];
      box.innerHTML = hoodHits.map(({ key, g, via }) => `
          <button class="ex-row" data-hood="${esc(key)}">
            <span class="n">${esc(g ? g.display : key)}${via ? ` <span class="aka">incl. ${esc(via)}</span>` : ""}</span><span class="c">${g && g.venues.length + g.base.length ? `${g.venues.length + (S.showBase ? g.base.length : 0)} spots` : "explore"} →</span>
          </button>`).join("") +
        venueHits.map((v) => `
          <button class="ex-row" data-id="${esc(v.id)}">
            <span class="n">${S.mem.saved.includes(v.id) ? `<span class="rowheart">♥</span> ` : ""}${esc(v.name)}</span><span class="m">${esc(v.cat)} · ${esc(v.hood)}</span>
          </button>`).join("") +
        baseHits.map((v) => `
          <button class="ex-row base" data-id="${esc(v.id)}">
            <span class="n">${esc(v.name)}${v.rec ? ` <span class="rec-dot" title="locals recommend it">●</span>` : ""}</span><span class="m">${esc(v.cat)} · ${esc(S.exIndex.groups.get(v.geom)?.display || v.geom)} · map book</span>
          </button>`).join("") ||
        `<p class="ex-empty">Nothing by that name in the book yet.</p>`;
    } else {
      // every one of the 98 official neighborhoods is in the book — a hood
      // with no matches only drops out while filters are narrowing things
      const hoods = [...groups.entries()]
        .map(([key, g]) => ({ key, ...g,
          matching: g.venues.filter(exPasses).length + (S.showBase ? g.base.filter(basePasses).length : 0) }))
        .filter((g) => g.matching > 0 || !exFiltersOn())
        .sort((a, b) => (b.matching - a.matching) || a.display.localeCompare(b.display));
      box.innerHTML = hoods.map((g) => `
        <button class="ex-row" data-hood="${esc(g.key)}">
          <span class="n">${esc(g.display)}</span>
          <span class="c">${g.matching ? `${g.matching} spots` : "explore"} →</span>
        </button>`).join("") ||
        `<p class="ex-empty">No neighborhood matches those filters tonight. <button class="linkish" id="ex-clearf2">Clear filters</button></p>`;
      $("#ex-clearf2") && ($("#ex-clearf2").onclick = () => {
        S.ex.vibe = "all"; S.ex.price = null; S.ex.open = false; renderExplore();
      });
    }
    $$(".ex-row[data-hood]", box).forEach((b) => b.onclick = () => exSelectHood(b.dataset.hood));
    $$(".ex-row[data-id]", box).forEach((b) => b.onclick = () => {
      const v = findSpot(b.dataset.id); // curated OR map book
      if (!v) return;
      S.ex.hood = v.geom || v.hood; S.ex.venue = v.id;
      S.exCam = S.map.selectHood(S.ex.hood, { inset: exInset() });
      renderExplore();
    });
  };

  $("#ex-addplace").onclick = () => openAddPlace();
  // typing only re-renders the results — the input (and its caret) survive
  $("#ex-q").oninput = (e) => { S.ex.q = e.target.value; renderResults(); };
  $$("#ex-vchips button", el).forEach((b) => b.onclick = () => { S.ex.vibe = b.dataset.v; renderResults();
    $$("#ex-vchips button", el).forEach((x) => press(x, x === b)); });
  // price/open chips repaint themselves + results only — a full re-render
  // would rebuild the search input and eat its focus mid-word
  wireFilterChips2(el, () => {
    $$("#ex-fchips2 [data-p]", el).forEach((b) => press(b, S.ex.price === +b.dataset.p));
    const ob = $("#ex-fchips2 [data-open]", el);
    if (ob) press(ob, !!S.ex.open);
    renderResults();
  });
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
    `<button data-v="${n}" class="${d.price === n ? "on" : ""}" aria-pressed="${d.price === n}">${"$".repeat(n)}</button>`).join("");
  $$("#ap-price button").forEach((b) => b.onclick = () => {
    d.price = +b.dataset.v;
    $$("#ap-price button").forEach((x) => press(x, x === b));
  });
  $("#ap-vibes").innerHTML = VIBES.map((v) =>
    `<button data-v="${v.id}" class="${d.vibes.includes(v.id) ? "on" : ""}" aria-pressed="${d.vibes.includes(v.id)}">${v.icon} ${esc(v.name)}</button>`).join("");
  $$("#ap-vibes button").forEach((b) => b.onclick = () => {
    const i = d.vibes.indexOf(b.dataset.v);
    if (i >= 0) d.vibes.splice(i, 1); else d.vibes.push(b.dataset.v);
    press(b, i < 0);
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
      // timestamp+random suffix: remove-then-re-add must never mint the
      // same id twice (saved/been history would bleed between spots)
      id: "my-" + $("#ap-name").value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") +
        "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
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
    toast("Added to your spots — the engine can pick it now.");
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
Suggested from the app.`);
  return `https://github.com/Aceospades95/chilocal/issues/new?title=${encodeURIComponent("Suggest a spot: " + v.name)}&body=${body}&labels=spot-suggestion`;
}

/* Jump anywhere → a venue's profile in Explore. */
function openVenueProfile(id) {
  const v = findSpot(id); // curated, yours, or the map book
  if (!v) { toast("That spot isn't in the book anymore."); return; }
  $$("dialog[open]").forEach((d) => d.close());
  S.ex.hood = v.geom || v.hood;
  S.ex.venue = v.id;
  if (S.view !== "explore") {
    S.view = "explore";
    $$("#mode-seg button").forEach((b) => press(b, b.dataset.m === "explore"));
    S.map.clearReveal();
    S.map.setExplore(true);
    S.map.loadDetail?.("data/detail.min.geojson?v=n25");
    show("explore");
  }
  S.exCam = S.map.selectHood(S.ex.hood, { inset: exInset() });
  renderExplore();
}

/* Browse → tonight: adopt a venue as the plan, honestly justified.
 * A starred night (from Up next) adopts VERBATIM — the stops you starred
 * are the stops you get; we only recompute what no longer resolves. */
function adoptAsPlan(v, starred) {
  newSession();
  const memv = memoryView(S.mem);
  const rand = mulberry32(hashStr(S.ctx.nightKey + "|adopt|" + v.id));
  const budget = Math.max(S.budget, v.price);
  const { reasons } = scoreVenue(v, { vibe: null, budget, party: S.party, visitor: !!S.visitor }, S.ctx, memv, rand);
  const pool = secondPool(S.venues, S.ctx, S.session);
  const byName = (name) => name ? S.venues.find((x) => x.name === name) : null;
  let second = null, third = null;
  if (starred) {
    const sv = byName(starred.secondName);
    if (sv) second = { venue: sv, mi: haversineMi(v, sv) };
    else if (starred.secondName) second = pickSecond(v, pool, { vibe: null, budget }, S.ctx);
    const tv = byName(starred.thirdName);
    if (tv && second) third = { venue: tv, mi: haversineMi(second.venue, tv) };
  } else {
    second = pickSecond(v, pool, { vibe: null, budget }, S.ctx);
  }
  const why = "Your pick — we just did the homework. " +
    whyLine(v, reasons, { vibe: null, budget }, S.ctx, {});
  S.mode = "out"; S.vibe = null;
  S.plan = { hero: { v, score: 0, reasons, extra: {} }, second, third, alts: [], why: starred?.why || why };
  S.session.excluded.add(v.id);
  setView("tonight");
  renderReveal();
}

/* ------------------------------- the gate ---------------------------------
 * Members only: nothing boots until a session is confirmed. nginx enforces
 * this server-side in production (auth_request bounces strangers to
 * /gate.html before this file even loads); this client gate is the same
 * door for local dev and defense in depth. `?dev=1` skips it — but only
 * on localhost, so it cannot open anything in production. */
async function start() {
  // the veil goes up immediately — the CSS keys a spinner on body.booting,
  // so nobody stares at a black page while data loads
  document.body.classList.add("booting");
  // stale-context guard: a phone that slept in a pocket for an hour wakes
  // to a different night (weather still rides its 30-minute cache)
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden) { S._hiddenAt = Date.now(); return; }
    if (S._hiddenAt && Date.now() - S._hiddenAt > 10 * 60 * 1000 && S.mem) {
      S.ctx = await buildContext();
      renderContextChip();
    }
  });
  const params = new URLSearchParams(location.search);
  const devBypass = ["localhost", "127.0.0.1"].includes(location.hostname) && params.has("dev");
  let user = null, reachable = true;
  const me = () => api("/api/auth/me", { signal: AbortSignal.timeout(3500) }).then((r) => r.json());
  try {
    // one retry before deciding the server's unreachable — slow hotel wifi
    // is not the same thing as signed out
    const d = await me().catch(me);
    user = d.user || null;
  } catch { reachable = false; }
  if (user) { try { localStorage.setItem("chilocal.member", "1"); } catch { /* fine */ } }
  if (user || devBypass) {
    S.user = user;
    boot();
    return;
  }
  // offline, but this device has signed in before: the installed app still
  // opens — everything the service worker cached was fetched while signed
  // in, and nginx still guards every byte on the wire
  let wasMember = false;
  try { wasMember = localStorage.getItem("chilocal.member") === "1"; } catch { /* fine */ }
  if (!reachable && wasMember) {
    boot();
    setTimeout(() => toast("Offline — running from this phone's copy."), 1400);
    return;
  }
  showGate(reachable);
}

function showGate(reachable) {
  const gate = $("#gate");
  document.body.classList.remove("booting"); // the gate is the show now
  gate.hidden = false;
  const setTab = (t) => {
    $$("#gate-tabs button").forEach((b) => press(b, b.dataset.t === t));
    // the two modes must LOOK different: sign in is email+password, signup
    // adds a name and the (unchecked) weekly-digest opt-in
    $("#gate-mh").textContent = t === "login" ? "Welcome back" : "Create your account";
    $("#gate-ms").textContent = t === "login"
      ? "Sign in with your email and password."
      : "Pick a name, and you're in — it takes ten seconds.";
    $("#ga-name").hidden = t === "login";
    $("#ga-digest-row").hidden = t === "login";
    $("#ga-forgot").hidden = !(t === "login" && S.api?.email);
    $("#ga-pass").autocomplete = t === "login" ? "current-password" : "new-password";
    $("#gate-go .cta-big").textContent = t === "login" ? "Sign in →" : "Create account →";
    $("#gate-err").hidden = true;
    gate.dataset.tab = t;
  };
  $$("#gate-tabs button").forEach((b) => b.onclick = () => setTab(b.dataset.t));
  setTab("login");
  // "Forgot password?" is real only once an email provider is configured —
  // health says so; until then the link stays hidden. Touch ONLY the link:
  // re-running setTab here would wipe a visible "can't reach" error.
  api("/api/health", { signal: AbortSignal.timeout(2500) })
    .then((r) => (r.ok ? r.json() : null))
    .then((h) => { S.api = h; $("#ga-forgot").hidden = !(gate.dataset.tab === "login" && h?.email); })
    .catch(() => {});
  const err = $("#gate-err");
  if (!reachable) {
    err.textContent = "Can't reach the sign-in server right now — try again shortly.";
    err.hidden = false;
  }
  $("#gate-form").onsubmit = async (e) => {
    e.preventDefault();
    err.hidden = true;
    const t = gate.dataset.tab;
    const bad = authClientError(t, $("#ga-email").value, $("#ga-pass").value, $("#ga-name").value);
    if (bad) { err.textContent = bad; err.hidden = false; return; }
    const go = $("#gate-go");
    go.disabled = true;
    try {
      const body = t === "login"
        ? { email: $("#ga-email").value, password: $("#ga-pass").value }
        : { email: $("#ga-email").value, password: $("#ga-pass").value,
            name: $("#ga-name").value, wantsDigest: $("#ga-digest").checked };
      const r = await api(`/api/auth/${t === "login" ? "login" : "signup"}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify(body),
      }).then((x) => x.json());
      if (r.error) { err.textContent = politeErr(r.error); err.hidden = false; return; }
      S.user = r.user;
      try { localStorage.setItem("chilocal.member", "1"); } catch { /* fine */ }
      $("#ga-pass").value = "";
      // veil BEFORE the gate drops — no black gap while boot fetches data
      document.body.classList.add("booting");
      gate.hidden = true;
      boot(); // through the door — the normal homepage
      toast(t === "login"
        ? (r.user.name ? `Welcome back, ${r.user.name}.` : "Welcome back.")
        : `Welcome to the city${r.user.name ? `, ${r.user.name}` : ""}.`);
    } catch {
      err.textContent = "Can't reach the sign-in server — try again shortly.";
      err.hidden = false;
    } finally { go.disabled = false; }
  };
}

/* ------------------------------ phone shell --------------------------------
 * ≤700px portrait: bottom tab bar (Tonight · Explore · Book), draggable
 * sheets with peek/half/full snap points, and the browser-install path.
 * Desktop and landscape never enter here — the CSS gates the chrome and
 * every handler checks isShell() before touching layout. */
const isShell = () => matchMedia("(max-width: 700px) and (orientation: portrait)").matches;

function syncTabbar() {
  const bar = $("#tabbar");
  if (!bar) return;
  const bookOpen = $("#nights").open;
  $$(".tb", bar).forEach((b) => {
    const t = b.dataset.tab;
    const on = t === "book" ? bookOpen : !bookOpen && S.view === t;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
}

/* one drag behavior for both sheets: an invisible strip over the top edge
 * owns the gesture (touch-action:none there, so the sheet's own scroll
 * never fights it), and release snaps to the nearest point — or flicks
 * one step in the flick's direction */
function makeSheetDraggable(sheet, snapsFn) {
  let drag = null;
  const setH = (px) => sheet.style.setProperty("--sheet-h", Math.round(px) + "px");
  const strip = document.createElement("button");
  strip.className = "drag-strip";
  strip.setAttribute("aria-label", "drag to resize");
  const ensureStrip = () => { if (!strip.isConnected) sheet.prepend(strip); };
  ensureStrip();
  // renderers rebuild the sheet with innerHTML — quietly re-adopt the strip
  new MutationObserver(ensureStrip).observe(sheet, { childList: true });

  const snapTo = (px, snaps) => {
    sheet.classList.add("snapping");
    setH(px);
    sheet.classList.toggle("peek", px === snaps[0]);
    setTimeout(() => sheet.classList.remove("snapping"), 320);
  };
  strip.addEventListener("pointerdown", (e) => {
    if (!isShell()) return;
    drag = { y0: e.clientY, h0: sheet.getBoundingClientRect().height,
             yPrev: e.clientY, tPrev: performance.now(), v: 0, moved: 0 };
    sheet.classList.add("dragging");
    sheet.classList.remove("snapping");
    strip.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  strip.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const now = performance.now();
    drag.v = (e.clientY - drag.yPrev) / Math.max(1, now - drag.tPrev);
    drag.yPrev = e.clientY; drag.tPrev = now;
    drag.moved = Math.max(drag.moved, Math.abs(e.clientY - drag.y0));
    const snaps = snapsFn();
    setH(Math.max(snaps[0], Math.min(snaps[snaps.length - 1], drag.h0 - (e.clientY - drag.y0))));
  });
  const finish = () => {
    if (!drag) return;
    const snaps = snapsFn();
    const h = sheet.getBoundingClientRect().height;
    let target;
    if (drag.moved < 6) {
      // a tap on the handle steps the sheet up (full taps back to half)
      const cur = snaps.reduce((a, b) => (Math.abs(b - h) < Math.abs(a - h) ? b : a));
      const i = snaps.indexOf(cur);
      target = i >= snaps.length - 1 ? snaps[1] : snaps[i + 1];
    } else if (Math.abs(drag.v) > 0.45) {
      // flick: one step in the flick's direction from wherever we are
      const sorted = [...snaps];
      target = drag.v < 0
        ? sorted.find((s) => s > h + 8) ?? sorted[sorted.length - 1]
        : [...sorted].reverse().find((s) => s < h - 8) ?? sorted[0];
    } else {
      target = snaps.reduce((a, b) => (Math.abs(b - h) < Math.abs(a - h) ? b : a));
    }
    sheet.classList.remove("dragging");
    snapTo(target, snaps);
    drag = null;
  };
  strip.addEventListener("pointerup", finish);
  strip.addEventListener("pointercancel", finish);
  return {
    toSnap(i) {
      if (!isShell()) { sheet.style.removeProperty("--sheet-h"); sheet.classList.remove("peek"); return; }
      const snaps = snapsFn();
      snapTo(snaps[Math.max(0, Math.min(i, snaps.length - 1))], snaps);
    },
  };
}

let revealSheetCtl = null, exSheetCtl = null;
function shellOnScreen(name) {
  // fresh plan → the sheet presents at half; explore opens at half too
  if (name === "reveal") revealSheetCtl?.toSnap(1);
  if (name === "explore") exSheetCtl?.toSnap(1);
}

function initShell() {
  $$("#tabbar .tb").forEach((b) => b.onclick = () => {
    const t = b.dataset.tab;
    const nights = $("#nights");
    if (t === "book") { if (!nights.open) openNights(); }
    else {
      if (nights.open) nights.close();
      if (S.view !== t) setView(t);
    }
    syncTabbar();
  });
  $("#nights").addEventListener("close", syncTabbar);

  const vh = () => window.innerHeight;
  const barSpace = () => 62 + 22; // tab bar + breathing room
  revealSheetCtl = makeSheetDraggable($("#screen-reveal .sheet"),
    () => [128 + barSpace(), Math.round(vh() * 0.58), vh() - 84]);
  exSheetCtl = makeSheetDraggable($("#ex-sheet"),
    () => [96 + barSpace(), Math.round(vh() * 0.47), Math.round(vh() * 0.86)]);
  // leaving the shell (rotate, resize to desktop) clears the inline sizing
  window.addEventListener("resize", () => {
    if (!isShell()) for (const s of [$("#screen-reveal .sheet"), $("#ex-sheet")]) {
      s.style.removeProperty("--sheet-h"); s.classList.remove("peek", "snapping", "dragging");
    }
  });
  syncTabbar();
}

/* --------------------------- the installed app -----------------------------
 * The manifest + service worker make ChiLocal installable straight from the
 * browser: home-screen icon, full screen, and an offline copy for the L. */
let deferredInstall = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // no drive-by banner — the offer lives in Settings
  deferredInstall = e;
});
const isStandalone = () =>
  matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
function renderInstallRow() {
  const row = $("#set-install-row");
  if (!row) return;
  if (isStandalone()) { row.hidden = true; return; }
  const iOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (deferredInstall) {
    row.hidden = false;
    $("#set-install").onclick = async () => {
      const p = deferredInstall; deferredInstall = null;
      p.prompt();
      const choice = await p.userChoice.catch(() => null);
      if (choice?.outcome === "accepted") { toast("ChiLocal is on your home screen."); row.hidden = true; }
    };
  } else if (iOS) {
    // Safari never fires the prompt event — hand people the two taps instead
    row.hidden = false;
    $("#set-install-hint").textContent = "in Safari: tap Share, then “Add to Home Screen”";
    $("#set-install").onclick = () => toast("Tap Share, then “Add to Home Screen.”");
  } else row.hidden = true;
}
function registerSW() {
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  if (!("serviceWorker" in navigator) || (location.protocol !== "https:" && !local)) return;
  // registered only once someone is through the door — before that, nginx
  // answers /sw.js with the gate and the registration would just fail
  navigator.serviceWorker.register("/sw.js").catch(() => { /* not fatal, ever */ });
}

start();
