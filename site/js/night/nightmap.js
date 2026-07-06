/* nightmap.js — the city as the stage, now in two temperaments.
 *
 * TONIGHT (flat): the reveal camera — radar scan, zoom, route draw, pin drop.
 * EXPLORE (2.5D): the whole map tilts into a night diorama; each of the 98
 * neighborhoods is extruded (face + wall) and lifts toward you on hover,
 * name floating on the plane. Painter's algorithm (north drawn first) makes
 * lifted hoods overlap their northern neighbors correctly.
 *
 * Architecture rules that keep it glitch-free:
 *  - ALL zoom lives in the viewBox; the CSS 3D tilt is rotation-only.
 *  - Interaction is a separate invisible hit layer that NEVER moves, so a
 *    lifting tile can't slide out from under the cursor (hover flicker) and
 *    a click target can't shift mid-press.
 *  - Screen↔map math goes through the computed CSS transform matrix, so
 *    cursor-anchored zoom and pan are exact under any tilt.
 *  - Continuous camera motion is rAF-driven and suppresses CSS transitions
 *    (class "moving") so walls/lifts can't lag the geometry and smear.
 *
 * No tiles, no libraries — the city itself is the art. */

const NS = "http://www.w3.org/2000/svg";
const W = 1000;
const DEPTH = 8;   // extrusion, in map units (screen-constant via --wd)

export class NightMap {
  constructor(svg, geojson) {
    this.svg = svg;
    this.geo = geojson;
    this._anim = null;
    this._scanTimer = null;
    this.onHoodClick = null;   // (polygonName) => void — wired by the app
    this.selected = null;
    this._hovName = null;
    this._tiles = new Map(); // "z/x/y" -> <image> (real-map detail tier)
    this._reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this._build();
  }

  _build() {
    const feats = this.geo.features;
    let mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9;
    const walk = (g, fn) => {
      const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
      polys.forEach((p) => p.forEach((ring) => ring.forEach(fn)));
    };
    feats.forEach((f) => walk(f.geometry, ([x, y]) => {
      mnx = Math.min(mnx, x); mxx = Math.max(mxx, x);
      mny = Math.min(mny, y); mxy = Math.max(mxy, y);
    }));
    const k = Math.cos(((mny + mxy) / 2) * Math.PI / 180);
    const H = Math.round(((mxy - mny) / ((mxx - mnx) * k)) * W);
    this.H = H;
    this._pxPerLng = W / (mxx - mnx);          // map units per degree longitude
    this.unitsPerMeter = H / ((mxy - mny) * 111320); // for accuracy circles
    this.px = (lng) => ((lng - mnx) * k / ((mxx - mnx) * k)) * W;
    this.py = (lat) => H - ((lat - mny) / (mxy - mny)) * H;
    this.unproject = (ux, uy) => ({
      lng: (ux / W) * (mxx - mnx) + mnx,
      lat: mny + ((H - uy) / H) * (mxy - mny),
    });

    this.svg.setAttribute("preserveAspectRatio", "xMidYMid slice");
    this.svg.innerHTML = `
      <defs>
        <radialGradient id="nm-water" cx="85%" cy="30%" r="120%">
          <stop offset="0%" stop-color="#0b1a30"/>
          <stop offset="55%" stop-color="#071120"/>
          <stop offset="100%" stop-color="#050b16"/>
        </radialGradient>
        <linearGradient id="nm-wallgrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#0c1728"/>
          <stop offset="100%" stop-color="#02050c"/>
        </linearGradient>
        <filter id="nm-glow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="6" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="nm-glow-soft" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="10" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <rect id="nm-water-rect" x="${-W}" y="${-H}" width="${W * 3}" height="${H * 3}" fill="url(#nm-water)"/>
      <g id="nm-tiles"></g>
      <g id="nm-hoods"></g>
      <g id="nm-detail"></g>
      <g id="nm-streets"></g>
      <g id="nm-metra"></g>
      <g id="nm-divvy"></g>
      <g id="nm-transit"></g>
      <g id="nm-fx"></g>
      <g id="nm-route"></g>
      <g id="nm-hit"></g>
      <g id="nm-pins"></g>
      <g id="nm-labels"></g>`;

    const hoodsG = this.svg.querySelector("#nm-hoods");
    const hitG = this.svg.querySelector("#nm-hit");
    const labelsG = this.svg.querySelector("#nm-labels");
    this.hoodPaths = new Map();   // name -> face path (scan flicker, glow clone)
    this.hoodGroups = new Map();  // name -> <g> (visual layer only)
    this.hoodBBoxes = new Map();  // name -> {x,y,w,h}
    this.hoodLabels = new Map();  // name -> <text> (top layer, never occluded)

    // paint north → south so a lifted hood overlaps its northern neighbor,
    // and every wall hides behind the hood south of it
    const ordered = feats.slice().sort((a, b) => {
      const cy = (f) => {
        let sy = 0, n = 0;
        walk(f.geometry, ([, y]) => { sy += y; n++; });
        return sy / n;
      };
      return cy(b) - cy(a); // higher latitude (smaller screen-y) first
    });

    for (const f of ordered) {
      const name = f.properties.name;
      let d = "";
      let bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9;
      let bigRing = null, bigArea = -1;
      const polys = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
      polys.forEach((poly) => poly.forEach((ring, ri) => {
        const pts = ring.map((c) => [this.px(c[0]), this.py(c[1])]);
        pts.forEach(([x, y], i) => {
          bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x);
          by0 = Math.min(by0, y); by1 = Math.max(by1, y);
          d += (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
        });
        d += "Z";
        if (ri === 0) { // outer ring: track the biggest for label placement
          let a = 0;
          for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
            a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
          if (Math.abs(a) > bigArea) { bigArea = Math.abs(a); bigRing = pts; }
        }
      }));
      // area centroid of the dominant ring (bbox centers miss on crescents)
      let cx = (bx0 + bx1) / 2, cy2 = (by0 + by1) / 2;
      if (bigRing && bigRing.length > 2) {
        let a = 0, sx = 0, sy = 0;
        for (let i = 0, j = bigRing.length - 1; i < bigRing.length; j = i++) {
          const cr = bigRing[j][0] * bigRing[i][1] - bigRing[i][0] * bigRing[j][1];
          a += cr; sx += (bigRing[j][0] + bigRing[i][0]) * cr; sy += (bigRing[j][1] + bigRing[i][1]) * cr;
        }
        if (Math.abs(a) > 1e-6) { cx = sx / (3 * a); cy2 = sy / (3 * a); }
      }

      const g = document.createElementNS(NS, "g");
      g.setAttribute("class", "nm-hoodg");
      g.dataset.name = name;

      const wall = document.createElementNS(NS, "path");
      wall.setAttribute("d", d);
      wall.setAttribute("class", "nm-wall");
      wall.setAttribute("transform", `translate(0 ${DEPTH})`);

      const face = document.createElementNS(NS, "path");
      face.setAttribute("d", d);
      face.setAttribute("class", "nm-hood");

      const label = document.createElementNS(NS, "text");
      label.setAttribute("class", "nm-hoodlabel");
      label.setAttribute("x", cx.toFixed(1));
      label.setAttribute("y", cy2.toFixed(1));
      label.setAttribute("text-anchor", "middle");
      label.textContent = name.replace(/,/, " · ").toUpperCase();
      label.dataset.area = bigArea.toFixed(0);
      labelsG.appendChild(label);

      g.append(wall, face);
      hoodsG.appendChild(g);

      // the hit twin: invisible, immobile, owns ALL pointer interaction.
      // Visual tiles can lift, reorder, and glow without ever moving the
      // thing the cursor is actually touching.
      const hit = document.createElementNS(NS, "path");
      hit.setAttribute("d", d);
      hit.setAttribute("class", "nm-hit");
      hit.dataset.name = name;
      hitG.appendChild(hit);

      this.hoodPaths.set(name, face);
      this.hoodGroups.set(name, g);
      this.hoodLabels.set(name, label);
      this.hoodBBoxes.set(name, { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 });

      hit.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (this._dragMoved || this._justPicked) return; // pan or place-pick, not a pick
        if (this.onHoodClick) this.onHoodClick(name);
      });
      hit.addEventListener("pointerenter", (ev) => {
        if (ev.pointerType === "mouse") this._setHover(name);
      });
      hit.addEventListener("pointerleave", (ev) => {
        if (ev.pointerType === "mouse" && this._hovName === name) this._setHover(null);
      });
    }
    this._orderedGroups = [...hoodsG.children];

    this.cityBox = { x: -W * 0.06, y: -H * 0.02, w: W * 1.24, h: H * 1.04 };
    this._setBox(this.cityBox);
    this._wireInteractions();
  }

  /* -------- screen ↔ layout ↔ map-unit projection (tilt-aware) ------------ */
  /* The svg's layout box equals its untransformed parent (#mapwrap), so the
   * computed CSS transform (perspective·rotateX, possibly mid-transition) is
   * the only thing between layout space and the screen. We invert it
   * analytically — a ray→plane solve — instead of measuring transformed
   * rects, which lie. */
  _plane() {
    const cs = getComputedStyle(this.svg);
    const tr = cs.transform;
    if (!tr || tr === "none") return null;
    const m = new DOMMatrixReadOnly(tr);
    if (m.isIdentity) return null;
    const parts = cs.transformOrigin.split(" ").map(parseFloat);
    return { m, ox: parts[0] || 0, oy: parts[1] || 0 };
  }
  /* layout px (relative to the svg box) -> screen px relative to the box */
  _projLayout(lx, ly, plane) {
    if (!plane) return { x: lx, y: ly };
    const { m, ox, oy } = plane;
    const x = lx - ox, y = ly - oy;
    const X = m.m11 * x + m.m21 * y + m.m41;
    const Y = m.m12 * x + m.m22 * y + m.m42;
    const Wc = m.m14 * x + m.m24 * y + m.m44 || 1;
    return { x: ox + X / Wc, y: oy + Y / Wc };
  }
  /* screen px relative to the box -> layout px (inverse of the above) */
  _unprojLayout(sx, sy, plane) {
    if (!plane) return { x: sx, y: sy };
    const { m, ox, oy } = plane;
    const U = sx - ox, V = sy - oy;
    const a1 = m.m11 - U * m.m14, b1 = m.m21 - U * m.m24, c1 = U * m.m44 - m.m41;
    const a2 = m.m12 - V * m.m14, b2 = m.m22 - V * m.m24, c2 = V * m.m44 - m.m42;
    const det = a1 * b2 - b1 * a2;
    if (!det) return { x: sx, y: sy };
    return { x: ox + (c1 * b2 - b1 * c2) / det, y: oy + (a1 * c2 - c1 * a2) / det };
  }
  /* viewBox mapping under preserveAspectRatio="slice" */
  _frame(box = this.box) {
    const elW = this.svg.clientWidth || 1, elH = this.svg.clientHeight || 1;
    const scale = Math.max(elW / box.w, elH / box.h);
    return { elW, elH, scale,
             offX: (elW - box.w * scale) / 2, offY: (elH - box.h * scale) / 2 };
  }
  /* client (viewport) px -> map units. Exact under any tilt. */
  screenToUnits(pxX, pxY) {
    const host = this.svg.parentElement.getBoundingClientRect();
    const l = this._unprojLayout(pxX - host.left, pxY - host.top, this._plane());
    const f = this._frame();
    return { x: this.box.x + (l.x - f.offX) / f.scale,
             y: this.box.y + (l.y - f.offY) / f.scale };
  }
  /* map units -> px relative to #mapwrap. Exact under any tilt. */
  toScreen(ux, uy) {
    const f = this._frame();
    return this._projLayout(f.offX + (ux - this.box.x) * f.scale,
                            f.offY + (uy - this.box.y) * f.scale, this._plane());
  }
  /* which fraction of the viewBox sits under this client point (zoom anchor) */
  _anchorFractions(pxX, pxY) {
    const u = this.screenToUnits(pxX, pxY);
    return { fx: (u.x - this.box.x) / this.box.w, fy: (u.y - this.box.y) / this.box.h };
  }

  _setBox(b) {
    this.box = b;
    this.svg.setAttribute("viewBox", `${b.x} ${b.y} ${b.w} ${b.h}`);
    // labels, extrusion depth, and hover lift keep constant SCREEN size
    if (this.cityBox) {
      const z = b.w / this.cityBox.w;
      const st = this.svg.style;
      // labels keep a FIXED font-size and counter-scale via transform:
      // sub-2px font-size destroys Chrome's glyph geometry (blurry blobs)
      st.setProperty("--zf", z.toFixed(4));
      st.setProperty("--wd", (DEPTH * z).toFixed(2) + "px");
      st.setProperty("--lift", (12 * z).toFixed(2) + "px");
      st.setProperty("--uz", z.toFixed(4) + "px"); // 1 screen-ish px in map units
      const host = this.svg.parentElement;
      host.classList.toggle("zoomed", z < 0.74);
      host.classList.toggle("zoomed2", z < 0.32);
      // past hood-level zoom the schematic map hands over to the real one:
      // OSM/CARTO raster tiles with actual streets and buildings
      const tilesOn = z < 0.34 && NightMap.BASEMAPS[this._basemap || "night"] != null;
      host.classList.toggle("tiles-on", tilesOn);
      if (tilesOn) this._queueTiles();
      if (z < 0.85) { // close enough that detail matters — fetch it once
        this.loadStreets("data/streets.min.geojson?v=n14");
        this.loadDetail("data/detail.min.geojson?v=n14");
      }
      this._queueCull();
    }
  }

  /* ------- motion state: transitions off while the camera is live -------- */
  _beginMove() {
    clearTimeout(this._moveT);
    this._moveT = null;
    const host = this.svg.parentElement;
    if (!host.classList.contains("moving")) {
      host.classList.add("moving");
      const el = host.querySelector(".nm-label");
      if (el) el.classList.remove("show"); // reposition when the dust settles
    }
  }
  _endMoveSoon(ms = 150) {
    clearTimeout(this._moveT);
    this._moveT = setTimeout(() => {
      this.svg.parentElement.classList.remove("moving");
      if (this._labelPt) this.setLabel(this._labelPt, this._labelText);
      this._syncHover();
    }, ms);
  }

  /* ------------- real-map detail tier: OSM/CARTO dark raster tiles --------
   * Past neighborhood zoom the hand-drawn schematic can't carry the detail
   * ("zooming into a picture"), so actual map tiles — streets, buildings,
   * names — fade in underneath the neighborhood layer. Web-mercator tiles
   * are placed by projecting each tile's corner coordinates through the
   * map's own projection; over Chicago's latitude span the per-tile error
   * is sub-pixel. Keyless, © OpenStreetMap contributors © CARTO. */
  /* basemap styles for the detail tier — user-pickable, all keyless */
  static BASEMAPS = {
    night: { attrib: "detail © OpenStreetMap contributors © CARTO", native: 512, maxZ: 19,
             url: (z, x, y) => `https://${"abcd"[(x + y) % 4]}.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}@2x.png` },
    sat:   { attrib: "imagery © Esri, Maxar, Earthstar Geographics", native: 256, maxZ: 19,
             url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}` },
    none:  null,
  };
  setBasemap(key) {
    this._basemap = NightMap.BASEMAPS[key] === undefined ? "night" : key;
    const host = this.svg.parentElement;
    host.classList.toggle("bm-sat", this._basemap === "sat");
    for (const [, el] of this._tiles) el.remove();
    this._tiles.clear();
    const at = host.querySelector(".nm-attrib");
    if (at) at.textContent = NightMap.BASEMAPS[this._basemap]?.attrib || "";
    this._setBox(this.box); // re-derive tiles-on + refetch for the new style
  }
  _queueTiles(box) {
    if (box) this._tileBox = box;
    clearTimeout(this._tileT);
    this._tileT = setTimeout(() => {
      const b = this._tileBox || this.box;
      this._tileBox = null;
      this._updateTiles(b);
    }, 60);
  }
  _updateTiles(bArg) {
    const bm = NightMap.BASEMAPS[this._basemap || "night"];
    if (!bm) return;
    const b = bArg || this.box;
    if (b.w / this.cityBox.w >= 0.34) return;
    const g = this.svg.querySelector("#nm-tiles");
    const f = this._frame();
    // rotation exposes map beyond the box's corners — widen the fetch pad
    const rot = ((this.bearing || 0) * Math.PI) / 180;
    const pad = 0.15 + (Math.abs(Math.cos(rot)) + Math.abs(Math.sin(rot)) - 1) / 2;
    const tl = this.unproject(b.x - b.w * pad, b.y - b.h * pad);
    const br = this.unproject(b.x + b.w * (1 + pad), b.y + b.h * (1 + pad));
    // choose z from what the tile bitmap ACTUALLY lands on: DEVICE pixels.
    // A tile shown above ~1.08x its native resolution reads as fuzz — the
    // names baked into the raster (streets, neighborhoods) blur first
    const fScale = Math.max((this.svg.clientWidth || 1) / b.w, (this.svg.clientHeight || 1) / b.h);
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const target = ((bm.native || 512) * 1.08) / dpr;
    const need = (360 * this._pxPerLng * fScale) / target;
    const capZ = bm.maxZ || 18;
    const zt = Math.max(12, Math.min(capZ, Math.ceil(Math.log2(need))));
    const n = 2 ** zt;
    const xOf = (lng) => Math.floor(((lng + 180) / 360) * n);
    const yOf = (lat) => Math.floor(((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2) * n);
    const latOf = (y) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180 / Math.PI;
    const x0 = xOf(tl.lng), x1 = xOf(br.lng);
    const y0 = yOf(tl.lat), y1 = yOf(br.lat);
    const want = new Set();
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const key = `${zt}/${x}/${y}`;
      want.add(key);
      if (this._tiles.has(key)) continue;
      const lng0 = (x / n) * 360 - 180, lng1 = ((x + 1) / n) * 360 - 180;
      const la0 = latOf(y), la1 = latOf(y + 1);
      const img = document.createElementNS(NS, "image");
      const X = this.px(lng0), Y = this.py(la0);
      img.setAttribute("x", X.toFixed(2));
      img.setAttribute("y", Y.toFixed(2));
      img.setAttribute("width", (this.px(lng1) - X).toFixed(2));
      img.setAttribute("height", (this.py(la1) - Y).toFixed(2));
      img.setAttribute("preserveAspectRatio", "none");
      img.setAttribute("class", "nm-tile");
      img.dataset.z = zt;
      img.setAttribute("href", bm.url(zt, x, y));
      img.addEventListener("error", () => { img.remove(); this._tiles.delete(key); });
      // once loaded, a cheap re-pass can retire the stale parent tiles
      img.addEventListener("load", () => { img.dataset.ok = "1"; this._queueTiles(); });
      // keep the group ordered by z so sharper tiles always paint on top
      let before = null;
      for (const c of g.children) if (+c.dataset.z > zt) { before = c; break; }
      g.insertBefore(img, before);
      this._tiles.set(key, img);
    }
    // same-z offscreen tiles go immediately; OTHER-z tiles (the previous
    // zoom level) stay as an instant backdrop until every wanted tile has
    // actually loaded — no blank flash while the new level streams in
    let allLoaded = true;
    for (const key of want) {
      const el = this._tiles.get(key);
      if (!el || !el.dataset.ok) { allLoaded = false; break; }
    }
    for (const [key, el] of this._tiles) {
      const z = +el.dataset.z;
      if (z === zt) { if (!want.has(key)) { el.remove(); this._tiles.delete(key); } }
      else if (allLoaded) { el.remove(); this._tiles.delete(key); }
    }

    // approaching the next level's switch point: warm those tiles into the
    // HTTP cache now, so the stop-and-sharpen moment is instant instead of
    // a fuzzy beat while the deeper level streams in
    if (need / 2 ** zt > 0.8 && zt < capZ) {
      const z2 = zt + 1, n2 = 2 ** z2;
      const xo = (lng) => Math.floor(((lng + 180) / 360) * n2);
      const yo = (lat) => Math.floor(((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2) * n2);
      const tl2 = this.unproject(b.x, b.y), br2 = this.unproject(b.x + b.w, b.y + b.h);
      this._warm = this._warm || new Set();
      for (let x = xo(tl2.lng); x <= xo(br2.lng); x++)
        for (let y = yo(tl2.lat); y <= yo(br2.lat); y++) {
          const key = `${this._basemap}|${z2}/${x}/${y}`;
          if (this._warm.has(key)) continue;
          this._warm.add(key);
          new Image().src = bm.url(z2, x, y);
        }
      if (this._warm.size > 600) this._warm.clear(); // bounded; a miss just refetches
    }
  }

  /* ---------------- "find me": device location + honest accuracy ---------- */
  /* Draws the position and, crucially, the ACCURACY circle the device
   * reports — so you can see exactly how much to trust the blue dot.
   * Returns true when the point is on the map. */
  showUser(ll, accuracyM = 0) {
    this.clearUser();
    const g = document.createElementNS(NS, "g");
    g.setAttribute("id", "nm-user");
    const x = this.px(ll.lng), y = this.py(ll.lat);
    const rAcc = Math.max(accuracyM * this.unitsPerMeter, 0.5);
    g.innerHTML = `
      <circle class="nm-user-acc" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rAcc.toFixed(2)}"/>
      <circle class="nm-user-ring" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}"/>
      <circle class="nm-user-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}"/>`;
    this.svg.querySelector("#nm-labels").before(g);
    const inMap = x > -W * 0.1 && x < W * 1.1 && y > -this.H * 0.1 && y < this.H * 1.1;
    if (inMap) this.focusOn(ll, Math.max(rAcc * 7, 110));
    return inMap;
  }
  clearUser() {
    this.svg.querySelector("#nm-user")?.remove();
  }

  setLabelWeights(weights) {
    this._labelWeights = weights; // polygonName -> venue count
    this._paintFaces();
    this._queueCull();
  }

  /* Colors v2 — the city as eight named districts, every neighbor distinct.
   * Each hood belongs to a curated color FAMILY by where it sits (compass
   * sector from the Loop, lakefront split by longitude, far-south by
   * distance, downtown gold). Within a family, a greedy coloring over the
   * true adjacency graph hands neighbors different shade steps — so two
   * touching neighborhoods NEVER read as one blob. Venue density still
   * adds brightness; hover/select brighten in the hood's own hue. */
  _paintFaces() {
    const weights = this._labelWeights || new Map();
    const Lx = this.px(-87.628), Ly = this.py(41.8785); // the Loop
    const FAMILIES = {
      teal:    { h: 187, s: 40 },  // North Side lakefront
      indigo:  { h: 232, s: 36 },  // Northwest
      violet:  { h: 270, s: 32 },  // West Side
      wine:    { h: 336, s: 34 },  // near south / Bridgeport band
      sienna:  { h: 18,  s: 42 },  // Southwest (Pilsen's terracotta)
      emerald: { h: 158, s: 30 },  // South lakefront
      slate:   { h: 207, s: 26 },  // Far South
      gold:    { h: 42,  s: 44 },  // downtown
    };
    const famOf = (cx, cy, lng) => {
      const dist = Math.hypot(cx - Lx, cy - Ly);
      if (dist < 62) return "gold";
      const a = Math.atan2(cy - Ly, cx - Lx) * 180 / Math.PI;
      if (a >= -115 && a < -60) return "teal";
      if (a >= -160 && a < -115) return "indigo";
      if (a < -160 || a >= 160) return "violet";
      if (a >= 115 && a < 160) return "sienna";
      if (a >= 60 && a < 115) {
        if (dist > 380) return "slate";
        return lng > -87.606 ? "emerald" : "wine";
      }
      if (a >= 0 && a < 60) return "emerald";
      return "teal"; // NE lakefront sliver
    };
    // adjacency ≈ inflated-bbox overlap (superset of shared borders — safe)
    const names = [...this.hoodGroups.keys()];
    const bb = (n) => this.hoodBBoxes.get(n);
    const touches = (a, b) => {
      const A = bb(a), B = bb(b), e = 3;
      return A.x < B.x + B.w + e && B.x < A.x + A.w + e &&
             A.y < B.y + B.h + e && B.y < A.y + A.h + e;
    };
    const STEPS = [{ dl: 0, dh: 0 }, { dl: 5, dh: 9 }, { dl: -3.5, dh: -8 },
                   { dl: 8.5, dh: -13 }, { dl: 3, dh: 16 }];
    const stepOf = new Map();
    for (const n of names) {
      const used = new Set();
      for (const m of names) {
        if (m === n || !stepOf.has(m)) continue;
        if (touches(n, m)) used.add(stepOf.get(m));
      }
      let pick = STEPS.findIndex((_, i) => !used.has(i));
      if (pick < 0) pick = 0;
      stepOf.set(n, pick);
    }
    for (const [name, g] of this.hoodGroups) {
      const l = this.hoodLabels.get(name);
      const cx = +l.getAttribute("x"), cy = +l.getAttribute("y");
      const lng = this.unproject(cx, cy).lng;
      const fam = FAMILIES[famOf(cx, cy, lng)];
      const st = STEPS[stepOf.get(name) || 0];
      const t = Math.sqrt(Math.min(1, (weights.get(name) || 0) / 12));
      const h = Math.round((fam.h + st.dh + 360) % 360);
      const S = fam.s + t * 8;
      const L = 17 + st.dl + t * 6;
      g.style.setProperty("--face", `hsl(${h} ${S.toFixed(0)}% ${L.toFixed(1)}%)`);
      g.style.setProperty("--edge", `hsl(${h} ${(S + 10).toFixed(0)}% ${(L + 16).toFixed(1)}%)`);
      g.style.setProperty("--face-hov", `hsl(${h} ${(S + 8).toFixed(0)}% ${(L + 10).toFixed(1)}%)`);
      g.style.setProperty("--face-sel", `hsl(${h} ${(S + 10).toFixed(0)}% ${(L + 14).toFixed(1)}%)`);
    }
  }

  _cullLabels() {
    const host = this.svg.parentElement;
    const f = this._frame();
    const plane = this._plane();
    const zc = this.box.w / this.cityBox.w;
    const toLayout = (ux, uy) => ({ x: f.offX + (ux - this.box.x) * f.scale,
                                    y: f.offY + (uy - this.box.y) * f.scale });
    // project + measure the local screen scale (perspective shrinks the far
    // edge) — hypot, not Δx, so a rotated map doesn't read as scale 0
    const projU = (ux, uy) => {
      const l = toLayout(ux, uy);
      const p = this._projLayout(l.x, l.y, plane);
      const q = this._projLayout(l.x + 8, l.y, plane);
      return { x: p.x, y: p.y, s: Math.hypot(q.x - p.x, q.y - p.y) / 8 };
    };
    // street names cull among THEMSELVES in every mode — the Tonight reveal
    // shows them too, and "N Clark St""Lake Shore Dr" must not read as one
    const streetRects = [];
    for (const t of this.svg.querySelectorAll(".nm-streetlabel")) {
      const p = projU(+t.getAttribute("x"), +t.getAttribute("y"));
      const F = 9.4 * zc * f.scale * p.s;
      const w = t.textContent.length * F * 0.6;
      const r = { x0: p.x - w / 2 - 6, x1: p.x + w / 2 + 6, y0: p.y - F - 4, y1: p.y + 4 };
      const hit = streetRects.some((k) => r.x0 < k.x1 && r.x1 > k.x0 && r.y0 < k.y1 && r.y1 > k.y0);
      t.classList.toggle("vis", !hit);
      if (!hit) streetRects.push(r);
    }
    if (!host.classList.contains("explore")) {
      for (const l of this.hoodLabels.values()) l.classList.remove("vis");
      return;
    }
    // labels must live in the VISIBLE window — not under the panel, not clipped
    const desktop = matchMedia("(min-width: 920px)").matches;
    const winX1 = desktop ? f.elW - 445 : f.elW - 6;
    const winY1 = desktop ? f.elH - 8 : f.elH * 0.52;
    const kept = [];
    // the tilt/overlay/camera controls own the top-left corner — no labels beneath
    kept.push(desktop ? { x0: 0, x1: 200, y0: 0, y1: 205 }
                      : { x0: 0, x1: 190, y0: 0, y1: 245 });
    // the street names that SURVIVED their own cull are furniture the hood
    // labels must not sit on (they only paint when zoomed)
    if (host.classList.contains("zoomed")) kept.push(...streetRects);
    const wts = this._labelWeights || new Map();
    // venue-rich neighborhoods name themselves first; empty giants fill in after
    const ordered = [...this.hoodLabels.entries()]
      .sort((a, b) => ((wts.get(b[0]) || 0) - (wts.get(a[0]) || 0)) ||
                      ((+b[1].dataset.area) - (+a[1].dataset.area)));
    // zoomed out, names need BREATHING ROOM — the whole city's labels compete
    // for one screen, so the collision pad widens with the zoom level
    const padX = zc > 0.55 ? 26 : 8, padY = zc > 0.55 ? 16 : 6;
    for (const [name, l] of ordered) {
      const bb = this.hoodBBoxes.get(name);
      const p = projU(+l.getAttribute("x"), +l.getAttribute("y"));
      const F = 11.5 * zc * f.scale * p.s; // label px on screen at this point
      const w = l.textContent.length * F * 0.62;
      const weight = wts.get(name) || 0;
      // skip hoods too small on screen to own their name (unless venue-rich)
      if (bb.w * f.scale * p.s < w * (weight >= 3 ? 0.45 : 0.8)) { l.classList.remove("vis"); continue; }
      const r = { x0: p.x - w / 2 - padX, x1: p.x + w / 2 + padX, y0: p.y - F - padY, y1: p.y + padY };
      if (r.x0 < 6 || r.x1 > winX1 || r.y0 < 60 || r.y1 > winY1) { l.classList.remove("vis"); continue; }
      const hit = kept.some((k) => r.x0 < k.x1 && r.x1 > k.x0 && r.y0 < k.y1 && r.y1 > k.y0);
      l.classList.toggle("vis", !hit);
      if (!hit) kept.push(r);
    }
    // spot name tags: same treatment among themselves (priority = list order)
    const tags = [...this.svg.querySelectorAll(".nm-spotlabel")];
    const keptT = [];
    for (const t of tags) {
      const p = projU(+t.getAttribute("x"), +t.getAttribute("y"));
      const F = 13 * zc * f.scale * p.s * 0.68;
      const w = t.textContent.length * F * 0.68;
      const r = { x0: p.x - w / 2 - 5, x1: p.x + w / 2 + 5, y0: p.y - F - 4, y1: p.y + 4 };
      const hit = keptT.some((k) => r.x0 < k.x1 && r.x1 > k.x0 && r.y0 < k.y1 && r.y1 > k.y0);
      t.classList.toggle("vis", !hit);
      if (!hit) keptT.push(r);
    }
  }
  _queueCull() {
    clearTimeout(this._cullTimer);
    this._cullTimer = setTimeout(() => this._cullLabels(), 110);
  }

  /* ----------------- hover + painter order (visual layer) ----------------- */
  /* Lifted tiles are promoted to the end of #nm-hoods so they paint above
   * every neighbor. Demotion is a SINGLE insertBefore back into the painter
   * order, delayed until the descent transition finishes — a DOM move
   * cancels running transitions, and re-appending all 98 groups per hover
   * crossing (the old approach) both snapped tiles down and churned. */
  _promote(g) {
    const t = this._reslots?.get(g);
    if (t) { clearTimeout(t); this._reslots.delete(g); }
    // already on top → no move → an in-flight lift transition survives
    if (g.parentElement.lastElementChild !== g) g.parentElement.appendChild(g);
  }
  _scheduleReslot(g) {
    (this._reslots ||= new Map());
    clearTimeout(this._reslots.get(g));
    this._reslots.set(g, setTimeout(() => {
      this._reslots.delete(g);
      this._reslot(g);
    }, 300));
  }
  _reslot(g) {
    const parent = this.svg.querySelector("#nm-hoods");
    const i = this._orderedGroups.indexOf(g);
    let next = null;
    for (let j = i + 1; j < this._orderedGroups.length; j++) {
      const c = this._orderedGroups[j];
      const displaced = this._reslots?.has(c) || c.classList.contains("sel") ||
        (this._hovName && this.hoodGroups.get(this._hovName) === c);
      if (!displaced) { next = c; break; }
    }
    parent.insertBefore(g, next); // null → last (only when all successors are lifted)
  }

  _setHover(name) {
    if (name && (this._panning || this._anim ||
        !this.svg.parentElement.classList.contains("explore"))) return;
    if (this._hovName === name) return;
    const prev = this._hovName ? this.hoodGroups.get(this._hovName) : null;
    if (prev) {
      prev.classList.remove("hov");
      if (this._hovName !== this.selected)
        this.hoodLabels.get(this._hovName)?.classList.remove("show");
      if (prev !== (this.selected && this.hoodGroups.get(this.selected)))
        this._scheduleReslot(prev); // descend on top, re-slot afterwards
    }
    this._hovName = name || null;
    if (name) {
      const g = this.hoodGroups.get(name);
      if (!g) { this._hovName = null; return; }
      this._promote(g);       // move BEFORE the class flip — a move after it
      g.classList.add("hov"); // would cancel the lift transition
      this.hoodLabels.get(name)?.classList.add("show");
    }
  }
  /* after pans/zooms/animations, re-derive hover from wherever the mouse is */
  _syncHover() {
    if (!this._lastMouse || this._panning) return;
    const el = document.elementFromPoint(this._lastMouse.x, this._lastMouse.y);
    this._setHover(el?.classList?.contains("nm-hit") ? el.dataset.name : null);
  }

  /* ---------------- pan / zoom / pinch — the user takes the camera -------- */
  _wireInteractions() {
    const svg = this.svg;
    const ptrs = new Map();
    let start = null, pinch = null;
    this._dragMoved = false;
    this._panning = false;

    const active = () => svg.parentElement.classList.contains("explore");
    const clampBox = (b) => {
      const minW = this.cityBox.w / 90, maxW = this.cityBox.w * 1.7;
      if (b.w < minW) { const f = minW / b.w; b = this._scaleBox(b, f, .5, .5); }
      if (b.w > maxW) { const f = maxW / b.w; b = this._scaleBox(b, f, .5, .5); }
      // keep the city loosely on stage
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const lim = { x0: this.cityBox.x - b.w * .45, x1: this.cityBox.x + this.cityBox.w + b.w * .45,
                    y0: this.cityBox.y - b.h * .45, y1: this.cityBox.y + this.cityBox.h + b.h * .45 };
      b.x += Math.min(0, lim.x1 - cx) + Math.max(0, lim.x0 - cx);
      b.y += Math.min(0, lim.y1 - cy) + Math.max(0, lim.y0 - cy);
      return b;
    };
    this._clampBox = clampBox;
    // clamp the ZOOM FACTOR before scaling — letting clampBox rescale an
    // over-limit box re-centers it, which reads as the map sliding sideways
    // while the user is pinned at min/max zoom
    const clampFactor = (b, f) => {
      const minW = this.cityBox.w / 90, maxW = this.cityBox.w * 1.7;
      return Math.max(minW / b.w, Math.min(maxW / b.w, f));
    };
    this._clampFactor = clampFactor;

    const endPan = () => {
      this._panning = false;
      document.body.classList.remove("map-dragging");
      this._endMoveSoon();
    };

    svg.addEventListener("click", (e) => {
      if (this._placePick && !this._dragMoved) {
        const u = this.screenToUnits(e.clientX, e.clientY);
        const ll = this.unproject(u.x, u.y);
        const cb = this._placePick;
        this.disarmPlacePick();
        this._justPicked = true;                     // eat the same click's
        setTimeout(() => { this._justPicked = false; }, 0); // hood handler
        cb(ll);
      }
    }, true);

    svg.addEventListener("pointerdown", (e) => {
      if (!active()) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // NO setPointerCapture: capturing retargets the eventual click to the
      // svg, which silently killed every neighborhood tap for real pointers.
      // Window-level move/up listeners keep the pan alive outside the svg.
      this._stopGlide();
      this._cancelAnim();
      if (ptrs.size === 1) {
        start = { x: e.clientX, y: e.clientY, box: { ...this.box } };
        this._dragMoved = false;
      } else if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), box: { ...this.box },
                  mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
        const u = this.screenToUnits(pinch.mid.x, pinch.mid.y);
        pinch.fx = (u.x - this.box.x) / this.box.w;
        pinch.fy = (u.y - this.box.y) / this.box.h;
        start = null;
      }
    });
    // track the mouse for post-move hover re-sync
    svg.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse") this._lastMouse = { x: e.clientX, y: e.clientY };
    });
    svg.addEventListener("pointerleave", (e) => {
      if (e.pointerType === "mouse") this._lastMouse = null;
    });

    window.addEventListener("pointermove", (e) => {
      if (!active() || !ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 1 && start) {
        const dxPx = e.clientX - start.x, dyPx = e.clientY - start.y;
        if (!this._dragMoved && Math.hypot(dxPx, dyPx) > 9) {
          this._dragMoved = true;
          this._panning = true;
          this._setHover(null);
          document.body.classList.add("map-dragging");
        }
        if (!this._dragMoved) return;
        this._beginMove();
        // exact grab: the map point under the cursor at pointerdown stays
        // under the cursor, even through the perspective tilt
        const plane = this._plane();
        const host = svg.parentElement.getBoundingClientRect();
        const l0 = this._unprojLayout(start.x - host.left, start.y - host.top, plane);
        const l1 = this._unprojLayout(e.clientX - host.left, e.clientY - host.top, plane);
        const f = this._frame(start.box);
        const dx = (l1.x - l0.x) / f.scale, dy = (l1.y - l0.y) / f.scale;
        this._setBox(clampBox({ ...start.box, x: start.box.x - dx, y: start.box.y - dy }));
        this._endMoveSoon();
      } else if (ptrs.size === 2 && pinch) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const f = this._clampFactor(pinch.box, pinch.d / d);
        this._dragMoved = true;
        this._panning = true;
        this._beginMove();
        let nb = this._scaleBox(pinch.box, f, pinch.fx, pinch.fy);
        // two-finger pan: follow the midpoint too
        const plane = this._plane();
        const host = svg.parentElement.getBoundingClientRect();
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const l0 = this._unprojLayout(pinch.mid.x - host.left, pinch.mid.y - host.top, plane);
        const l1 = this._unprojLayout(mid.x - host.left, mid.y - host.top, plane);
        const fr = this._frame(nb);
        nb.x -= (l1.x - l0.x) / fr.scale;
        nb.y -= (l1.y - l0.y) / fr.scale;
        this._setBox(clampBox(nb));
        this._endMoveSoon();
      }
    });
    const up = (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch = null;
      if (ptrs.size === 1) { // pinch → single-finger: re-anchor the pan
        const [p] = [...ptrs.values()];
        start = { x: p.x, y: p.y, box: { ...this.box } };
      }
      if (ptrs.size === 0) {
        start = null;
        if (this._panning) endPan();
        setTimeout(() => { this._dragMoved = false; }, 0); // let click handlers read it
      }
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);

    svg.addEventListener("wheel", (e) => {
      if (!active()) return;
      e.preventDefault();
      this._cancelAnim();
      // trackpad pinch arrives as ctrl+wheel — give it a stronger gear
      const k = e.ctrlKey ? 0.0042 : 0.0013;
      const f = clampFactor(this.box, Math.exp(e.deltaY * k));
      const { fx, fy } = this._anchorFractions(e.clientX, e.clientY);
      const target = clampBox(this._scaleBox(this.box, f, fx, fy));
      // trackpads emit fine-grained deltas that are already smooth — easing
      // them adds pure latency ("floaty" zoom). Only chunky mouse notches
      // get the glide.
      if (e.ctrlKey || Math.abs(e.deltaY) < 50) {
        this._stopGlide();
        this._beginMove();
        this._setBox(target);
        this._endMoveSoon();
      } else {
        this._glide(target);
      }
    }, { passive: false });

    svg.addEventListener("dblclick", (e) => {
      if (!active()) return;
      e.preventDefault();
      const { fx, fy } = this._anchorFractions(e.clientX, e.clientY);
      this.animateTo(clampBox(this._scaleBox(this.box, clampFactor(this.box, 1 / 1.7), fx, fy)), 500);
    });

    // click the water to step back out
    this.svg.querySelector("#nm-water-rect").addEventListener("click", () => {
      if (!active() || this._dragMoved || this._justPicked) return;
      if (this.onBackgroundClick) this.onBackgroundClick();
    });
  }

  /* rAF-glided zoom: wheel events only move the target; one loop eases the
   * camera toward it, so chunky wheel steps render as one smooth motion. */
  _glide(target) {
    this._glideTarget = target;
    if (target.w / this.cityBox.w < 0.34) this._queueTiles(target); // prefetch
    if (this._reduced) { this._stopGlide(); this._setBox(target); this._endMoveSoon(); return; }
    if (this._glideRaf) return;
    this._beginMove();
    const step = () => {
      const t = this._glideTarget, b = this.box;
      const nx = b.x + (t.x - b.x) * 0.5, ny = b.y + (t.y - b.y) * 0.5;
      const nw = b.w + (t.w - b.w) * 0.5, nh = b.h + (t.h - b.h) * 0.5;
      if (Math.abs(t.w - nw) / t.w < 0.001 && Math.hypot(t.x - nx, t.y - ny) < t.w * 0.001) {
        this._setBox({ ...t });
        this._glideRaf = null;
        this._endMoveSoon();
        return;
      }
      this._setBox({ x: nx, y: ny, w: nw, h: nh });
      this._glideRaf = requestAnimationFrame(step);
    };
    this._glideRaf = requestAnimationFrame(step);
  }
  _stopGlide() {
    if (this._glideRaf) {
      cancelAnimationFrame(this._glideRaf);
      this._glideRaf = null;
      this._endMoveSoon(); // interrupted glide must not leave 'moving' stuck
    }
    this._glideTarget = null;
  }

  _scaleBox(b, f, rx, ry) {
    const w = b.w * f, h = b.h * f;
    return { x: b.x + (b.w - w) * rx, y: b.y + (b.h - h) * ry, w, h };
  }

  /* arm a one-shot "tap the map to place" interaction */
  armPlacePick(cb) {
    this._placePick = cb;
    this.svg.parentElement.classList.add("placing");
  }
  disarmPlacePick() {
    this._placePick = null;
    this.svg.parentElement.classList.remove("placing");
  }

  /* view presets: flat (top-down) / mid (2.5D) / full (deep 3D) */
  setTilt(mode) {
    const host = this.svg.parentElement;
    host.classList.remove("tilt-flat", "tilt-mid", "tilt-full");
    host.classList.add("tilt-" + mode);
    this.tilt = mode;
    // labels re-cull once the tilt transition lands (projection changed)
    clearTimeout(this._tiltT);
    this._tiltT = setTimeout(() => this._queueCull(), 950);
  }

  /* orientation: rotate the whole diorama; labels counter-rotate in CSS so
   * every name stays readable. The screen↔map math needs no special case —
   * it inverts whatever matrix the CSS lands on. */
  setBearing(deg) {
    this.bearing = ((deg % 360) + 360) % 360;
    const host = this.svg.parentElement;
    host.style.setProperty("--bearing", this.bearing + "deg");
    // labels ride the .9s rotation (same curve) — but only while rotating,
    // so zoom's --zf changes stay instant
    host.classList.add("rotating");
    clearTimeout(this._rotT);
    this._rotT = setTimeout(() => {
      host.classList.remove("rotating");
      this._queueCull();
      this._queueTiles(); // corners now show map that wasn't fetched
    }, 950);
  }

  /* zoom buttons: one clamped step about the visible window's center */
  zoomBy(f, fx = 0.5, fy = 0.5) {
    this._stopGlide();
    this._cancelAnim();
    const fac = this._clampFactor(this.box, f);
    const b = this._clampBox(this._scaleBox(this.box, fac, fx, fy));
    return this.animateTo(b, 320);
  }

  setLabel(pt, text) {
    let el = this.svg.parentElement.querySelector(".nm-label");
    if (!el) {
      el = document.createElement("div");
      el.className = "nm-label";
      this.svg.parentElement.appendChild(el);
    }
    if (!pt) { this._labelPt = null; this._labelText = null; el.classList.remove("show"); return; }
    this._labelPt = pt; this._labelText = text;
    el.textContent = text;
    // when a hood is selected its venue dots ride the raised tile
    // (translateY of -1.5 lifts) — anchor the tooltip to the LIFTED spot
    const liftU = this.svg.parentElement.classList.contains("hood-sel")
      ? 18 * (this.box.w / this.cityBox.w) : 0;
    const s = this.toScreen(this.px(pt.lng), this.py(pt.lat) - liftU);
    el.style.left = s.x + "px";
    el.style.top = s.y + "px";
    el.classList.add("show");
  }

  /* a canceled animation resolves its promise anyway — callers chaining
   * "after the camera settles" (venue dots, markers) must still run even
   * when the user grabs the camera mid-flight */
  _cancelAnim() {
    if (this._anim) {
      cancelAnimationFrame(this._anim);
      this._anim = null;
      this._endMoveSoon(); // interrupted flight must not leave 'moving' stuck
    }
    const r = this._animDone; this._animDone = null;
    if (r) r();
  }

  animateTo(target, ms = 1400) {
    // start fetching the destination's tiles WHILE the camera flies
    if (target.w / this.cityBox.w < 0.34) this._queueTiles(target);
    return new Promise((res) => {
      this._cancelAnim();
      this._stopGlide();
      if (this._reduced) ms = 0;
      if (!ms) { this._setBox({ ...target }); this._endMoveSoon(); res(); return; }
      this._beginMove();
      this._animDone = res;
      const from = { ...this.box }, t0 = performance.now();
      const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
      const step = (now) => {
        const t = Math.min(1, (now - t0) / ms), e = ease(t);
        this._setBox({
          x: from.x + (target.x - from.x) * e,
          y: from.y + (target.y - from.y) * e,
          w: from.w + (target.w - from.w) * e,
          h: from.h + (target.h - from.h) * e,
        });
        if (t < 1) this._anim = requestAnimationFrame(step);
        else { this._anim = null; this._animDone = null; this._endMoveSoon(); res(); }
      };
      this._anim = requestAnimationFrame(step);
    });
  }

  /* ------------------------------ explore -------------------------------- */
  setExplore(on) {
    this.svg.parentElement.classList.toggle("explore", on);
    if (!on) { this._setHover(null); this.selectHood(null, { camera: false }); this.disarmPlacePick(); }
    this._queueCull();
  }

  /* layout-box aspect — getBoundingClientRect lies under the 3D tilt */
  _aspect() {
    const w = this.svg.clientWidth, h = this.svg.clientHeight;
    return w && h ? w / h : 1;
  }

  /* frame the whole city with UI insets (explore home view) */
  cityView(inset = {}, zoomF = 1) {
    let box = { ...this.cityBox };
    const aspect = this._aspect();
    if (inset.right) {
      // fit the city into the visible sub-viewport LEFT of the panel, then
      // extend the box rightward under the panel keeping the element aspect
      // (a widened box without matching height gets center-cropped by
      // preserveAspectRatio=slice — the city would drift off-center)
      const visAspect = aspect * (1 - inset.right);
      if (box.w / box.h < visAspect) { const nw = box.h * visAspect; box.x -= (nw - box.w) / 2; box.w = nw; }
      else { const nh = box.w / visAspect; box.y -= (nh - box.h) / 2; box.h = nh; }
      const cy = box.y + box.h / 2;
      box.w = box.w / (1 - inset.right);
      box.h = box.w / aspect;
      box.y = cy - box.h / 2;
    } else if (box.w / box.h < aspect) {
      const nw = box.h * aspect; box.x -= (nw - box.w) / 2; box.w = nw;
    }
    if (inset.bottom) {
      const cx = box.x + box.w / 2;
      box.h = box.h / (1 - inset.bottom);
      box.w = box.h * aspect;
      box.x = cx - box.w / 2;
    }
    // anchor the zoom on the center of the VISIBLE window, not the box
    if (zoomF !== 1) box = this._scaleBox(box, zoomF, (1 - (inset.right || 0)) / 2, 0.42);
    return this.animateTo(box, 750);
  }

  /* Raise + outline a hood; ease the camera onto it. name=null clears. */
  selectHood(name, opts = {}) {
    if (this.selected && this.hoodGroups.has(this.selected) && this.selected !== name) {
      const prev = this.hoodGroups.get(this.selected);
      prev.classList.remove("sel");
      prev.querySelectorAll(".nm-rim, .nm-rim-soft").forEach((r) => r.remove());
      if (this.selected !== this._hovName) this._scheduleReslot(prev);
    }
    for (const [n, l] of this.hoodLabels) if (n !== name) l.classList.remove("show");
    if (name && this.hoodLabels.has(name)) this.hoodLabels.get(name).classList.add("show");
    this.selected = name || null;
    this.svg.parentElement.classList.toggle("hood-sel", !!this.selected);
    if (!name) {
      if (opts.camera !== false) return this.animateTo(this.cityBox, 900);
      return;
    }
    const g = this.hoodGroups.get(name);
    if (!g) return;
    this._promote(g); // before the class flip so the lift transition survives
    g.classList.add("sel");
    // amber rim as layered VECTOR strokes — CSS drop-shadow filters
    // rasterize at a capped resolution and turn to mush at deep zoom
    this.svg.querySelectorAll(".nm-rim, .nm-rim-soft").forEach((r) => r.remove());
    const face = this.hoodPaths.get(name);
    for (const cls of ["nm-rim-soft", "nm-rim"]) {
      const rim = document.createElementNS(NS, "path");
      rim.setAttribute("d", face.getAttribute("d"));
      rim.setAttribute("class", cls);
      g.appendChild(rim);
    }
    if (opts.camera === false) return;
    const bb = this.hoodBBoxes.get(name);
    const aspect = this._aspect();
    // FULL-SCREEN framing: the selected neighborhood fills the visible
    // window (insets below push it out of the panel's shadow); small
    // hoods clamp so the tile detail stays within its sharpest levels
    let w = Math.max(bb.w * 1.18, 60), h = Math.max(bb.h * 1.22, 60 / aspect);
    if (w / h < aspect) w = h * aspect; else h = w / aspect;
    let box = { x: bb.x + bb.w / 2 - w / 2, y: bb.y + bb.h / 2 - h / 2, w, h };
    const ins = opts.inset || {};
    if (ins.bottom) {
      const cx = box.x + box.w / 2;
      box.h = box.h / (1 - ins.bottom);
      box.w = box.h * aspect;
      box.x = cx - box.w / 2;
    }
    if (ins.right) {
      const cy = box.y + box.h / 2;
      box.w = box.w / (1 - ins.right);
      box.h = box.w / aspect;
      box.y = cy - box.h / 2;
    }
    return this.animateTo(box, 750);
  }

  /* markers for browsed venues (explore mode). One highlighted, or a field
   * of small dots across the selected neighborhood. */
  markSpot(pt) {
    this.clearSpot();
    const g = document.createElementNS(NS, "g");
    g.setAttribute("id", "nm-spot");
    const x = this.px(pt.lng), y = this.py(pt.lat);
    const u = this.box.w / 150;
    g.innerHTML = `
      <circle class="nm-spot-halo" cx="${x}" cy="${y}" r="${(u * 2.4).toFixed(2)}" filter="url(#nm-glow-soft)"/>
      <circle class="nm-spot-core" cx="${x}" cy="${y}" r="${(u * 0.9).toFixed(2)}"/>`;
    this.svg.querySelector("#nm-pins").appendChild(g);
  }
  markSpots(pts) {
    this.clearSpot();
    const g = document.createElementNS(NS, "g");
    g.setAttribute("id", "nm-spot");
    for (const p of pts) {
      const x = this.px(p.lng), y = this.py(p.lat);
      // radii live in CSS (calc on --uz) so dots hold a constant SCREEN size
      const hit = document.createElementNS(NS, "circle");
      hit.setAttribute("cx", x.toFixed(1)); hit.setAttribute("cy", y.toFixed(1));
      hit.setAttribute("class", "nm-spot-hit");
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("cx", x.toFixed(1)); dot.setAttribute("cy", y.toFixed(1));
      dot.setAttribute("class", "nm-spot-dot");
      dot.style.pointerEvents = "none";
      const tag = document.createElementNS(NS, "text");
      tag.setAttribute("class", "nm-spotlabel");
      tag.setAttribute("x", x.toFixed(1));
      // anchor AT the dot — the screen-constant gap lives in the CSS
      // transform (--uz); a user-unit offset here would grow with zoom
      // until the name floats far above its dot
      tag.setAttribute("y", y.toFixed(1));
      tag.setAttribute("text-anchor", "middle");
      tag.textContent = p.name;
      hit.addEventListener("mouseenter", () => this.setLabel({ lat: p.lat, lng: p.lng }, p.name));
      hit.addEventListener("mouseleave", () => this.setLabel(null));
      hit.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (this._dragMoved || this._justPicked) return;
        this.setLabel(null);
        if (this.onSpotClick) this.onSpotClick(p.id);
      });
      g.append(hit, dot, tag);
    }
    this.svg.querySelector("#nm-pins").appendChild(g);
    this._queueCull();
  }

  /* parks + water, revealed as you zoom (fetched once, lazily) */
  async loadDetail(url) {
    if (this._detailLoaded) return;
    this._detailLoaded = true;
    const gj = await fetch(url).then((r) => r.json()).catch(() => null);
    if (!gj) { this._detailLoaded = false; return; }
    const host = this.svg.querySelector("#nm-detail");
    const draw = (coordsList, cls) => {
      let d = "";
      for (const ring of coordsList) {
        ring.forEach((c, i) => { d += (i ? "L" : "M") + this.px(c[0]).toFixed(1) + " " + this.py(c[1]).toFixed(1); });
        d += "Z";
      }
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", d);
      path.setAttribute("class", cls);
      path.setAttribute("fill-rule", "evenodd");
      host.appendChild(path);
    };
    draw(gj.water || [], "nm-waterbody");
    draw(gj.parks || [], "nm-park");
  }

  /* ------------------------- overlays: transit + streets ------------------ */
  async loadTransit(url) {
    if (this._transitLoaded) return;
    this._transitLoaded = true;
    const gj = await fetch(url).then((r) => r.json());
    const COLORS = { Red: "#c60c30", Blue: "#00a1de", Brown: "#62361b", Green: "#009b3a",
      Orange: "#f9461c", Purple: "#522398", Pink: "#e27ea6", Yellow: "#f9e300" };
    const host = this.svg.querySelector("#nm-transit");
    for (const f of gj.features) {
      const lines = String(f.properties.lines || "");
      const names = Object.keys(COLORS).filter((c) => lines.includes(c));
      const color = names.length === 1 ? COLORS[names[0]] : "#aab6c8"; // shared track = steel
      let d = "";
      for (const seg of f.geometry.coordinates)
        seg.forEach((c, i) => { d += (i ? "L" : "M") + this.px(c[0]).toFixed(1) + " " + this.py(c[1]).toFixed(1); });
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", d);
      path.setAttribute("class", "nm-rail");
      path.setAttribute("stroke", color);
      host.appendChild(path);
    }
  }

  /* Metra commuter rail — one steel dashed system (OSM, ODbL) */
  async loadMetra(url) {
    if (this._metraLoaded) return;
    this._metraLoaded = true;
    const gj = await fetch(url).then((r) => r.json()).catch(() => null);
    if (!gj) { this._metraLoaded = false; return; }
    const host = this.svg.querySelector("#nm-metra");
    let d = "";
    for (const seg of gj.features[0].geometry.coordinates)
      seg.forEach((c, i) => { d += (i ? "L" : "M") + this.px(c[0]).toFixed(1) + " " + this.py(c[1]).toFixed(1); });
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("class", "nm-metra");
    host.appendChild(path);
  }

  /* CTA stations ride along with the L-lines overlay */
  async loadStations(url) {
    if (this._stationsLoaded) return;
    this._stationsLoaded = true;
    const data = await fetch(url).then((r) => r.json()).catch(() => null);
    if (!data) { this._stationsLoaded = false; return; }
    const host = this.svg.querySelector("#nm-transit");
    for (const st of data.stations) {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", this.px(st.lng).toFixed(1));
      c.setAttribute("cy", this.py(st.lat).toFixed(1));
      c.setAttribute("class", "nm-station");
      const t = document.createElementNS(NS, "title");
      t.textContent = `${st.n} (${st.l.join(", ")})`;
      c.appendChild(t);
      host.appendChild(c);
    }
  }

  /* Divvy bike-share stations — a dusting of dock lights (GBFS, keyless) */
  async loadDivvy(url) {
    if (this._divvyLoaded) return;
    this._divvyLoaded = true;
    const data = await fetch(url).then((r) => r.json()).catch(() => null);
    if (!data) { this._divvyLoaded = false; return; }
    const host = this.svg.querySelector("#nm-divvy");
    const frag = document.createDocumentFragment();
    for (const st of data.stations) {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", this.px(st.lng).toFixed(1));
      c.setAttribute("cy", this.py(st.lat).toFixed(1));
      c.setAttribute("class", "nm-dock");
      const t = document.createElementNS(NS, "title");
      t.textContent = `🚲 ${st.n}${st.cap ? ` · ${st.cap} docks` : ""}`;
      c.appendChild(t);
      frag.appendChild(c);
    }
    host.appendChild(frag);
  }

  async loadStreets(url) {
    if (this._streetsLoaded) return;
    this._streetsLoaded = true;
    const gj = await fetch(url).then((r) => r.json());
    const host = this.svg.querySelector("#nm-streets");
    let d = "";
    for (const seg of gj.features[0].geometry.coordinates)
      seg.forEach((c, i) => { d += (i ? "L" : "M") + this.px(c[0]).toFixed(1) + " " + this.py(c[1]).toFixed(1); });
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("class", "nm-street");
    host.appendChild(path);
    for (const l of gj.labels || []) {
      const t = document.createElementNS(NS, "text");
      t.setAttribute("class", "nm-streetlabel");
      t.setAttribute("x", this.px(l.x).toFixed(1));
      t.setAttribute("y", this.py(l.y).toFixed(1));
      t.setAttribute("text-anchor", "middle");
      t.textContent = l.n;
      host.appendChild(t);
    }
    this._queueCull(); // labels arrived after the last cull pass
  }

  setOverlay(kind, on) {
    this.svg.parentElement.classList.toggle("show-" + kind, on);
    this._queueCull();
  }
  clearSpot() {
    this.svg.querySelector("#nm-spot")?.remove();
  }

  /* ------------------------- deciding: radar scan ------------------------- */
  startScan() {
    this.stopScan();
    const names = [...this.hoodPaths.keys()];
    this._scanTimer = setInterval(() => {
      const on = [];
      for (let i = 0; i < 5; i++) on.push(names[(Math.random() * names.length) | 0]);
      for (const [name, p] of this.hoodPaths)
        p.classList.toggle("nm-scan", on.includes(name));
    }, 130);
  }
  stopScan() {
    if (this._scanTimer) clearInterval(this._scanTimer);
    this._scanTimer = null;
    for (const p of this.hoodPaths.values()) p.classList.remove("nm-scan");
  }

  clearReveal() {
    this._revealGen = (this._revealGen || 0) + 1; // kill any in-flight reveal
    this.setLabel(null);
    this.svg.querySelector("#nm-route").innerHTML = "";
    this.svg.querySelector("#nm-pins").innerHTML = "";
    this.svg.querySelector("#nm-fx").innerHTML = "";
  }

  /* gentle re-frame centered on a point (locked-screen backdrop) */
  focusOn(pt, span = 420) {
    const cx = this.px(pt.lng), cy = this.py(pt.lat);
    const aspect = this._aspect();
    const w = span, h = span / aspect;
    return this.animateTo({ x: cx - w / 2, y: cy - h * 0.42, w, h }, 1200);
  }

  resetView(ms = 900) {
    this.clearReveal();
    return this.animateTo(this.cityBox, ms);
  }

  /* ----------------------------- the reveal ------------------------------ */
  async reveal(origin, dest, opts = {}) {
    this.clearReveal();
    // if the user walks away mid-reveal (mode switch, reroll), a later
    // clearReveal bumps the generation and this run dies at its next await
    const gen = this._revealGen;
    const o = { x: this.px(origin.lng), y: this.py(origin.lat) };
    const d = { x: this.px(dest.lng), y: this.py(dest.lat) };
    const second = opts.second ? { x: this.px(opts.second.lng), y: this.py(opts.second.lat) } : null;
    const third = opts.third ? { x: this.px(opts.third.lng), y: this.py(opts.third.lat) } : null;

    // frame origin + dest (+ crawl stops) with generous padding
    const xs = [o.x, d.x, ...(second ? [second.x] : []), ...(third ? [third.x] : [])];
    const ys = [o.y, d.y, ...(second ? [second.y] : []), ...(third ? [third.y] : [])];
    let mnx = Math.min(...xs), mxx = Math.max(...xs);
    let mny = Math.min(...ys), mxy = Math.max(...ys);
    let w = mxx - mnx, h = mxy - mny;
    // never zoom past a neighborhood-scale window — context is the point
    const MIN = 185;
    if (w < MIN) { mnx -= (MIN - w) / 2; mxx += (MIN - w) / 2; w = MIN; }
    if (h < MIN) { mny -= (MIN - h) / 2; mxy += (MIN - h) / 2; h = MIN; }
    const padX = w * 0.32, padY = h * 0.36;
    let box = { x: mnx - padX, y: mny - padY, w: w + padX * 2, h: h + padY * 2 };

    // fit to the panel's aspect so the pair stays centered under slice-crop
    const aspect = this._aspect();
    if (box.w / box.h < aspect) { const nw = box.h * aspect; box.x -= (nw - box.w) / 2; box.w = nw; }
    else { const nh = box.w / aspect; box.y -= (nh - box.h) / 2; box.h = nh; }

    // account for UI covering part of the viewport: expand the box on the
    // covered side so the subject lands centered in the VISIBLE window
    const ins = opts.inset || {};
    if (ins.bottom) {
      const cx = box.x + box.w / 2;
      box.h = box.h / (1 - ins.bottom);
      box.w = box.h * aspect;
      box.x = cx - box.w / 2;
    }
    if (ins.right) {
      const cy = box.y + box.h / 2;
      box.w = box.w / (1 - ins.right);
      box.h = box.w / aspect;
      box.y = cy - box.h / 2;
    }

    if (dest.geom && this.hoodPaths.has(dest.geom)) {
      const src = this.hoodPaths.get(dest.geom);
      const fx = this.svg.querySelector("#nm-fx");
      for (const cls of ["nm-hood-glow-soft", "nm-hood-glow"]) {
        const glow = src.cloneNode();
        glow.setAttribute("class", cls);
        fx.appendChild(glow);
      }
    }

    await this.animateTo(box, opts.fast ? 800 : 1500);
    if (gen !== this._revealGen) return;

    const u = box.w / 150; // sizing unit relative to zoom level
    const routeG = this.svg.querySelector("#nm-route");
    const pinsG = this.svg.querySelector("#nm-pins");

    // origin marker
    const home = document.createElementNS(NS, "circle");
    home.setAttribute("cx", o.x); home.setAttribute("cy", o.y);
    home.setAttribute("r", (u * 0.8).toFixed(2));
    home.setAttribute("class", "nm-home");
    pinsG.appendChild(home);

    // gently-bowed route from HOME BASE to the pick — labeled at both ends
    // so the line means something: where you start, how far it really is
    const dx = d.x - o.x, dy = d.y - o.y;
    const dist = Math.hypot(dx, dy) || 1;
    const bow = Math.min(dist * 0.12, u * 8);
    const mx = (o.x + d.x) / 2 - (dy / dist) * bow;
    const my = (o.y + d.y) / 2 + (dx / dist) * bow;
    if (opts.originName) {
      const hl = document.createElementNS(NS, "text");
      hl.setAttribute("class", "nm-homelabel");
      hl.setAttribute("x", o.x.toFixed(1));
      hl.setAttribute("y", (o.y + u * 2.6).toFixed(1));
      hl.setAttribute("text-anchor", "middle");
      hl.textContent = `⌂ ${opts.originName}`;
      routeG.appendChild(hl);
    }
    if (opts.mi != null) {
      const ml = document.createElementNS(NS, "text");
      ml.setAttribute("class", "nm-routelabel");
      ml.setAttribute("x", mx.toFixed(1));
      ml.setAttribute("y", (my - u * 1.2).toFixed(1));
      ml.setAttribute("text-anchor", "middle");
      ml.textContent = `~${opts.mi.toFixed(1)} mi as the crow flies`;
      routeG.appendChild(ml);
    }
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", `M ${o.x} ${o.y} Q ${mx} ${my} ${d.x} ${d.y}`);
    path.setAttribute("class", "nm-routeline");
    path.setAttribute("stroke-width", (u * 0.42).toFixed(2));
    routeG.appendChild(path);
    const len = path.getTotalLength();
    path.style.strokeDasharray = `${len}`;
    path.style.strokeDashoffset = `${len}`;
    path.getBoundingClientRect(); // flush
    path.style.transition = `stroke-dashoffset ${opts.fast ? 500 : 850}ms cubic-bezier(.6,.05,.3,1) 60ms`;
    path.style.strokeDashoffset = "0";

    await new Promise((r) => setTimeout(r, opts.fast ? 380 : 700));
    if (gen !== this._revealGen) return;

    // destination pin: glow halo + star pulse + dot
    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", "nm-pin");
    g.setAttribute("transform", `translate(${d.x} ${d.y})`);
    g.innerHTML = `
      <circle class="nm-pin-halo" r="${(u * 3.1).toFixed(2)}" filter="url(#nm-glow-soft)"/>
      <circle class="nm-pin-ring" r="${(u * 1.8).toFixed(2)}"/>
      <circle class="nm-pin-core" r="${(u * 1.0).toFixed(2)}" filter="url(#nm-glow)"/>`;
    pinsG.appendChild(g);
    if (opts.label) this.setLabel(dest, opts.label);

    // walk hops: hero → second (→ third, when it's a crawl)
    const chain = [d, second, third].filter(Boolean);
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1], b = chain[i];
      const hop = document.createElementNS(NS, "path");
      const hdx = b.x - a.x, hdy = b.y - a.y;
      const hd = Math.hypot(hdx, hdy) || 1;
      const hmx = (a.x + b.x) / 2 - (hdy / hd) * Math.min(hd * 0.3, u * 5);
      const hmy = (a.y + b.y) / 2 + (hdx / hd) * Math.min(hd * 0.3, u * 5);
      hop.setAttribute("d", `M ${a.x} ${a.y} Q ${hmx} ${hmy} ${b.x} ${b.y}`);
      hop.setAttribute("class", "nm-hopline");
      hop.setAttribute("stroke-width", (u * 0.32).toFixed(2));
      routeG.appendChild(hop);
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("cx", b.x); dot.setAttribute("cy", b.y);
      dot.setAttribute("r", (u * 0.8).toFixed(2));
      dot.setAttribute("class", "nm-second");
      pinsG.appendChild(dot);
    }
  }
}
