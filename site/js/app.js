/* chilocal — interactive Chicago boundary map
 * ----------------------------------------------------------------------------
 * Vanilla JS + Leaflet. No build step. Public API exposed as window.ChiLocal.
 */
(function () {
  "use strict";

  const CFG = window.CHILOCAL_CONFIG;
  const $ = (sel, el = document) => el.querySelector(sel);

  const state = {
    map: null,
    basemapLayer: null,
    layers: {},          // id -> { cfg, gj, leaflet, byId:Map, features:[], on, metric, breaks }
    activeId: null,
    selected: null,      // { layerId, leaflet }
    metricId: "none",
    customMetrics: {},    // id -> metric def (added via setData)
  };

  /* ----------------------------- geo helpers ----------------------------- */
  function geodesicAreaSqMi(geometry) {
    const R = 6378137.0;
    const ringArea = (ring) => {
      let s = 0;
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        s += (x2 - x1) * Math.PI / 180 *
             (2 + Math.sin(y1 * Math.PI / 180) + Math.sin(y2 * Math.PI / 180));
      }
      return s * R * R / 2;
    };
    const polys = geometry.type === "MultiPolygon"
      ? geometry.coordinates : [geometry.coordinates];
    let tot = 0;
    polys.forEach((poly) => poly.forEach((ring, k) => {
      const a = Math.abs(ringArea(ring));
      tot += k === 0 ? a : -a;
    }));
    return Math.abs(tot) / 2.589988e6;
  }

  const prettify = (s) =>
    (s && s === s.toUpperCase())
      ? s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bMc(\w)/g, (m, c) => "Mc" + c.toUpperCase())
      : s;

  function normalizeFeature(f, cfg) {
    const p = f.properties || (f.properties = {});
    if (!p.name) p.name = prettify(p[cfg.nameField]) || "Unknown";
    if (p.id === undefined || p.id === null || p.id === "")
      p.id = (p[cfg.idField] != null ? String(p[cfg.idField]) : p.name);
    p.id = String(p.id);
    if (typeof p.area_sqmi !== "number" && f.geometry)
      p.area_sqmi = Math.round(geodesicAreaSqMi(f.geometry) * 1000) / 1000;
    p._layerId = cfg.id;
    return f;
  }

  /* --------------------------- data loading ------------------------------ */
  async function fetchFirst(urls) {
    for (const url of urls) {
      if (!url) continue;
      try {
        const r = await fetch(url, { cache: "force-cache" });
        if (r.ok) return { data: await r.json(), url };
      } catch (e) { /* try next */ }
    }
    return null;
  }

  function toFeatureCollection(json) {
    // Accept a FeatureCollection or a raw SODA array of {the_geom, ...props}
    if (json && json.type === "FeatureCollection") return json;
    if (Array.isArray(json)) {
      return {
        type: "FeatureCollection",
        features: json.filter((r) => r.the_geom).map((r) => {
          const { the_geom, ...props } = r;
          return { type: "Feature", geometry: the_geom, properties: props };
        }),
      };
    }
    return { type: "FeatureCollection", features: [] };
  }

  async function loadLayer(cfg) {
    const got = await fetchFirst([cfg.file, cfg.sample, cfg.live]);
    if (!got) throw new Error("Could not load data for " + cfg.id);
    const gj = toFeatureCollection(got.data);
    gj.features.forEach((f) => normalizeFeature(f, cfg));

    const ls = {
      cfg, gj, byId: new Map(),
      features: gj.features.slice().sort((a, b) =>
        a.properties.name.localeCompare(b.properties.name)),
      on: false, metric: "none", breaks: null, source: got.url,
    };

    ls.leaflet = L.geoJSON(gj, {
      style: () => baseStyle(cfg),
      onEachFeature: (feature, lyr) => {
        lyr._chi = { cfg, feature };
        ls.byId.set(feature.properties.id, lyr);
        lyr.on({
          mouseover: () => hoverOn(ls, lyr),
          mouseout: () => hoverOff(ls, lyr),
          click: () => selectFeature(cfg.id, feature.properties.id, { pan: false }),
        });
        lyr.bindTooltip(feature.properties.name, {
          sticky: true, direction: "top", className: "chilocal-tip", opacity: 1,
        });
      },
    });
    state.layers[cfg.id] = ls;
    return ls;
  }

  /* ------------------------------ styling -------------------------------- */
  function baseStyle(cfg) {
    return { color: cfg.color, weight: 1.2, opacity: 0.9, fillColor: cfg.color, fillOpacity: 0.12 };
  }
  const HIGHLIGHT = { weight: 3, opacity: 1, fillOpacity: 0.35 };
  const SELECTED  = { weight: 3.5, color: "#ffffff", opacity: 1, fillOpacity: 0.45 };

  function computedStyle(ls, lyr) {
    const cfg = ls.cfg;
    if (ls.metric !== "none" && ls.breaks) {
      const v = metricValue(ls, lyr._chi.feature);
      const fill = v == null ? "#444b58" : colorForValue(v, ls.breaks);
      return { color: "#0b0d11", weight: 0.8, opacity: 0.8, fillColor: fill, fillOpacity: 0.78 };
    }
    return baseStyle(cfg);
  }

  function restyle(ls) {
    ls.leaflet.eachLayer((lyr) => {
      if (state.selected && state.selected.leaflet === lyr)
        lyr.setStyle(Object.assign({}, computedStyle(ls, lyr), SELECTED));
      else lyr.setStyle(computedStyle(ls, lyr));
    });
  }

  /* ------------------------------ hover ---------------------------------- */
  let infoCtl;
  function hoverOn(ls, lyr) {
    if (!(state.selected && state.selected.leaflet === lyr)) {
      lyr.setStyle(Object.assign({}, computedStyle(ls, lyr), HIGHLIGHT));
      lyr.bringToFront();
    }
    const p = lyr._chi.feature.properties;
    infoCtl.update({ name: p.name, layer: ls.cfg.title, value: metricLabel(ls, lyr._chi.feature) });
  }
  function hoverOff(ls, lyr) {
    if (!(state.selected && state.selected.leaflet === lyr)) lyr.setStyle(computedStyle(ls, lyr));
    infoCtl.update(null);
  }

  /* ---------------------------- selection -------------------------------- */
  function selectFeature(layerId, featureId, opts = {}) {
    const ls = state.layers[layerId];
    if (!ls) return;
    if (!ls.on) toggleLayer(layerId, true);
    const lyr = ls.byId.get(String(featureId));
    if (!lyr) return;

    if (state.selected) {
      const prev = state.layers[state.selected.layerId];
      if (prev && state.selected.leaflet) state.selected.leaflet.setStyle(computedStyle(prev, state.selected.leaflet));
    }
    state.selected = { layerId, leaflet: lyr };
    lyr.setStyle(Object.assign({}, computedStyle(ls, lyr), SELECTED));
    lyr.bringToFront();
    setActiveLayer(layerId);
    renderInfo(ls, lyr._chi.feature);
    if (opts.pan !== false) state.map.fitBounds(lyr.getBounds(), { padding: [40, 40], maxZoom: 14 });
  }

  function clearSelection() {
    if (state.selected) {
      const ls = state.layers[state.selected.layerId];
      if (ls && state.selected.leaflet) state.selected.leaflet.setStyle(computedStyle(ls, state.selected.leaflet));
    }
    state.selected = null;
    $("#info-panel").hidden = true;
  }

  function renderInfo(ls, feature) {
    const p = feature.properties;
    const rows = [["Layer", ls.cfg.title]];
    if (ls.cfg.id === "community-areas") rows.push(["Area #", p.area_number ?? p.id]);
    if (p.secondary) rows.push(["Also called", prettify(p.secondary)]);
    rows.push(["Area", (p.area_sqmi != null ? p.area_sqmi.toFixed(2) + " sq mi" : "—")]);
    rows.push(["Accuracy", ls.cfg.accuracy]);
    $("#info-body").innerHTML =
      `<div class="big">${esc(p.name)}</div>` +
      rows.map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(String(v))}</span></div>`).join("");
    const panel = $("#info-panel");
    panel.hidden = false;
    panel._feature = { layerId: ls.cfg.id, id: p.id };
  }

  /* ---------------------------- choropleth ------------------------------- */
  function metricDef(id) {
    return (CFG.metrics.find((m) => m.id === id)) || state.customMetrics[id] || { id: "none" };
  }
  function metricValue(ls, feature) {
    const m = metricDef(ls.metric);
    if (!m || m.id === "none") return null;
    if (m.data) { const v = m.data[feature.properties.id] ?? m.data[feature.properties.name]; return v == null ? null : +v; }
    if (m.prop) { const v = feature.properties[m.prop]; return v == null ? null : +v; }
    return null;
  }
  function metricLabel(ls, feature) {
    if (ls.metric === "none") return null;
    const v = metricValue(ls, feature);
    if (v == null) return "no data";
    const m = metricDef(ls.metric);
    return (Math.round(v * 100) / 100).toLocaleString() + (m.unit ? " " + m.unit : "");
  }
  const RAMP = ["#d7f0fb", "#a5dcf2", "#6cc4e8", "#41b6e6", "#2b8fc0", "#1c6792", "#0d3f5e"];
  function quantileBreaks(values, n) {
    const v = values.filter((x) => x != null).sort((a, b) => a - b);
    if (!v.length) return null;
    const breaks = [];
    for (let i = 1; i < n; i++) breaks.push(v[Math.floor(i / n * v.length)]);
    return { breaks, min: v[0], max: v[v.length - 1] };
  }
  function colorForValue(v, b) {
    let i = 0;
    while (i < b.breaks.length && v >= b.breaks[i]) i++;
    return RAMP[Math.min(i, RAMP.length - 1)];
  }
  function applyMetric(metricId) {
    state.metricId = metricId;
    const ls = state.layers[state.activeId];
    Object.values(state.layers).forEach((l) => { l.metric = "none"; l.breaks = null; });
    if (ls && metricId !== "none") {
      ls.metric = metricId;
      const vals = ls.features.map((f) => metricValue(ls, f));
      ls.breaks = quantileBreaks(vals, RAMP.length);
    }
    Object.values(state.layers).forEach(restyle);
    renderLegend(ls, metricId);
  }
  function renderLegend(ls, metricId) {
    const el = $("#legend");
    if (!ls || metricId === "none" || !ls.breaks) { el.hidden = true; return; }
    const m = metricDef(metricId);
    const edges = [ls.breaks.min, ...ls.breaks.breaks, ls.breaks.max];
    let html = `<div class="title">${esc(m.label || metricId)}${m.unit ? " (" + esc(m.unit) + ")" : ""}</div>`;
    for (let i = 0; i < RAMP.length; i++) {
      const lo = edges[i], hi = edges[i + 1];
      if (lo == null) continue;
      html += `<div class="row"><span class="chip" style="background:${RAMP[i]}"></span>` +
              `<span>${fmt(lo)}${hi != null && hi !== lo ? " – " + fmt(hi) : "+"}</span></div>`;
    }
    el.innerHTML = html; el.hidden = false;
  }
  const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString();

  /* ------------------------------- UI ------------------------------------ */
  function buildLayerList() {
    const wrap = $("#layer-list");
    wrap.innerHTML = "";
    CFG.layers.forEach((cfg) => {
      const ls = state.layers[cfg.id];
      const row = document.createElement("div");
      row.className = "layer-row";
      row.innerHTML =
        `<span class="layer-swatch" style="background:${cfg.color}"></span>` +
        `<span class="layer-meta"><span class="name">${esc(cfg.title)}</span>` +
        `<span class="sub">${esc(cfg.subtitle)} · ${esc(cfg.accuracy)}</span></span>` +
        `<label class="switch"><input type="checkbox" ${ls && ls.on ? "checked" : ""}><span class="track"></span></label>`;
      row.querySelector("input").addEventListener("change", (e) => {
        e.stopPropagation(); toggleLayer(cfg.id, e.target.checked);
      });
      row.addEventListener("click", () => { toggleLayer(cfg.id, true); setActiveLayer(cfg.id); });
      wrap.appendChild(row);
    });
    markActiveRow();
  }
  function markActiveRow() {
    $("#layer-list").querySelectorAll(".layer-row").forEach((r, i) =>
      r.classList.toggle("active", CFG.layers[i].id === state.activeId));
  }

  function toggleLayer(id, on) {
    const ls = state.layers[id];
    if (!ls) return;
    ls.on = on;
    if (on) ls.leaflet.addTo(state.map); else state.map.removeLayer(ls.leaflet);
    const input = $("#layer-list").querySelectorAll(".layer-row")[CFG.layers.findIndex((c) => c.id === id)]?.querySelector("input");
    if (input) input.checked = on;
    if (on && !state.activeId) setActiveLayer(id);
    if (!on && state.selected && state.selected.layerId === id) clearSelection();
  }

  function setActiveLayer(id) {
    state.activeId = id;
    markActiveRow();
    const ls = state.layers[id];
    $("#search-scope").textContent = ls ? "· " + ls.cfg.title.toLowerCase() : "";
    $("#search").placeholder = ls ? `Find in ${ls.cfg.title}…` : "Find an area…";
    buildMetricSelect();
    applyMetric($("#metric-select").value || "none");
  }

  function buildBasemapSwitch() {
    const wrap = $("#basemap-switch");
    wrap.innerHTML = "";
    CFG.basemaps.forEach((b) => {
      const btn = document.createElement("button");
      btn.textContent = b.label;
      btn.dataset.id = b.id;
      btn.addEventListener("click", () => setBasemap(b.id));
      wrap.appendChild(btn);
    });
  }
  function setBasemap(id) {
    const b = CFG.basemaps.find((x) => x.id === id) || CFG.basemaps[0];
    if (state.basemapLayer) state.map.removeLayer(state.basemapLayer);
    state.basemapLayer = L.tileLayer(b.url, {
      attribution: b.attribution, subdomains: b.subdomains || "abc",
      maxZoom: b.maxZoom || 19,
    }).addTo(state.map);
    state.basemapLayer.bringToBack();
    $("#basemap-switch").querySelectorAll("button").forEach((btn) =>
      btn.classList.toggle("active", btn.dataset.id === b.id));
  }

  function buildMetricSelect() {
    const sel = $("#metric-select");
    const prev = sel.value;
    const all = [...CFG.metrics, ...Object.values(state.customMetrics)];
    sel.innerHTML = all.map((m) => `<option value="${esc(m.id)}">${esc(m.label || m.id)}</option>`).join("");
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }

  /* ------------------------------ search --------------------------------- */
  let searchIdx = -1;
  function runSearch(q) {
    const ls = state.layers[state.activeId];
    const box = $("#search-results");
    if (!ls || !q.trim()) { box.hidden = true; box.innerHTML = ""; return; }
    const ql = q.toLowerCase();
    const hits = ls.features.filter((f) =>
      f.properties.name.toLowerCase().includes(ql) ||
      (f.properties.secondary || "").toLowerCase().includes(ql)).slice(0, 12);
    box.innerHTML = hits.map((f, i) =>
      `<li role="option" data-id="${esc(f.properties.id)}" class="${i === searchIdx ? "active" : ""}">` +
      `<span>${esc(f.properties.name)}</span>` +
      `<span class="sub">${f.properties.area_sqmi != null ? f.properties.area_sqmi.toFixed(1) + " mi²" : ""}</span></li>`).join("");
    box.hidden = hits.length === 0;
    box.querySelectorAll("li").forEach((li) =>
      li.addEventListener("click", () => {
        selectFeature(state.activeId, li.dataset.id, { pan: true });
        $("#search").value = ""; box.hidden = true; $("#search-clear").hidden = true;
        closeSidebarIfMobile();
      }));
  }

  /* ------------------------------ misc ----------------------------------- */
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let statusTimer;
  function showStatus(msg, ms = 2200) {
    const el = $("#status"); el.textContent = msg; el.classList.add("show");
    clearTimeout(statusTimer); if (ms) statusTimer = setTimeout(() => el.classList.remove("show"), ms);
  }
  const closeSidebarIfMobile = () => { if (window.innerWidth <= 760) $("#sidebar").classList.remove("open"); };

  /* ------------------------------ init ----------------------------------- */
  async function init() {
    $("#app-name").textContent = CFG.app.name;
    $("#app-tagline").textContent = CFG.app.tagline;
    document.title = CFG.app.name + " — " + CFG.app.tagline;

    state.map = L.map("map", {
      center: CFG.app.center, zoom: CFG.app.zoom,
      minZoom: CFG.app.minZoom, maxZoom: CFG.app.maxZoom, zoomControl: false,
    });
    L.control.zoom({ position: "topright" }).addTo(state.map);

    infoCtl = L.control({ position: "topright" });
    infoCtl.onAdd = function () {
      this._div = L.DomUtil.create("div", "map-info");
      this.update(null); return this._div;
    };
    infoCtl.update = function (d) {
      this._div.style.display = d ? "block" : "none";
      if (d) this._div.innerHTML =
        `<div class="mi-title">${esc(d.layer)}</div><div class="mi-name">${esc(d.name)}</div>` +
        (d.value ? `<div class="mi-sub">${esc(d.value)}</div>` : "");
    };
    infoCtl.addTo(state.map);

    buildBasemapSwitch();
    setBasemap(CFG.app.defaultBasemap);
    buildMetricSelect();

    // Load layers
    showStatus("Loading boundaries…", 0);
    let firstBounds = null, loadedVia = "";
    for (const cfg of CFG.layers) {
      try {
        const ls = await loadLayer(cfg);
        if (!firstBounds) { firstBounds = ls.leaflet.getBounds(); loadedVia = ls.source; }
      } catch (e) { console.error(e); showStatus("Failed to load " + cfg.title); }
    }
    buildLayerList();
    CFG.layers.forEach((cfg) => { if (cfg.defaultOn) toggleLayer(cfg.id, true); });
    const firstOn = CFG.layers.find((c) => c.defaultOn) || CFG.layers[0];
    if (firstOn) setActiveLayer(firstOn.id);
    if (firstBounds) state.map.fitBounds(firstBounds, { padding: [20, 20] });

    const via = /\.min\.geojson/.test(loadedVia) ? "bundled sample"
      : /cityofchicago/.test(loadedVia) ? "live City of Chicago portal" : "local full-resolution data";
    showStatus("Loaded · " + via);

    // Footer note
    $("#data-note").innerHTML =
      "Boundaries from the " +
      '<a href="https://data.cityofchicago.org" target="_blank" rel="noopener">Chicago Data Portal</a>. ' +
      "Community Areas are official; neighborhood names/boundaries are approximate.";

    wireEvents();
    window.ChiLocal = PUBLIC_API;
  }

  function wireEvents() {
    const search = $("#search"), clear = $("#search-clear"), box = $("#search-results");
    search.addEventListener("input", () => {
      searchIdx = -1; clear.hidden = !search.value; runSearch(search.value);
    });
    search.addEventListener("keydown", (e) => {
      const items = [...box.querySelectorAll("li")];
      if (e.key === "ArrowDown") { searchIdx = Math.min(searchIdx + 1, items.length - 1); }
      else if (e.key === "ArrowUp") { searchIdx = Math.max(searchIdx - 1, 0); }
      else if (e.key === "Enter" && items[searchIdx < 0 ? 0 : searchIdx]) { items[searchIdx < 0 ? 0 : searchIdx].click(); return; }
      else if (e.key === "Escape") { search.value = ""; box.hidden = true; clear.hidden = true; return; }
      else return;
      e.preventDefault();
      items.forEach((li, i) => li.classList.toggle("active", i === searchIdx));
      if (items[searchIdx]) items[searchIdx].scrollIntoView({ block: "nearest" });
    });
    clear.addEventListener("click", () => { search.value = ""; clear.hidden = true; box.hidden = true; search.focus(); });
    document.addEventListener("click", (e) => { if (!e.target.closest(".search-wrap")) box.hidden = true; });

    $("#metric-select").addEventListener("change", (e) => applyMetric(e.target.value));
    $("#info-clear").addEventListener("click", clearSelection);
    $("#info-zoom").addEventListener("click", () => {
      const f = $("#info-panel")._feature; if (f) selectFeature(f.layerId, f.id, { pan: true });
    });
    $("#sidebar-toggle").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
    state.map.on("click", (e) => { if (!e.originalEvent.target.closest(".leaflet-interactive")) clearSelection(); });
  }

  /* --------------------------- public API -------------------------------- */
  const PUBLIC_API = {
    /* Join your own data to a layer and color by it.
     * ChiLocal.setData("community-areas", {"8": 12000, "32": 45000}, {label:"Population", unit:"people"})
     * Keys match feature id (area number for CAs, slug for neighborhoods) or name. */
    setData(layerId, dataObj, opts = {}) {
      const id = opts.id || ("custom_" + (opts.label || "data").toLowerCase().replace(/\W+/g, "_"));
      state.customMetrics[id] = { id, label: opts.label || "Custom data", unit: opts.unit || "", data: dataObj, layerId };
      buildMetricSelect();
      setActiveLayer(layerId);
      $("#metric-select").value = id;
      applyMetric(id);
      showStatus("Applied " + (opts.label || "custom data"));
      return id;
    },
    select: selectFeature,
    clear: clearSelection,
    setBasemap,
    getState: () => state,
    listFeatures: (layerId) => (state.layers[layerId] ? state.layers[layerId].features.map((f) => f.properties) : []),
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
