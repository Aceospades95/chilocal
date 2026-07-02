/* nightmap.js — the city as the stage, now in two temperaments.
 *
 * TONIGHT (flat): the reveal camera — radar scan, zoom, route draw, pin drop.
 * EXPLORE (2.5D): the whole map tilts into a night diorama; each of the 98
 * neighborhoods is extruded (face + wall) and lifts toward you on hover,
 * name floating on the plane. Painter's algorithm (north drawn first) makes
 * lifted hoods overlap their northern neighbors correctly.
 *
 * No tiles, no libraries — the city itself is the art. */

const NS = "http://www.w3.org/2000/svg";
const W = 1000;
const DEPTH = 6;   // extrusion, in map units

export class NightMap {
  constructor(svg, geojson) {
    this.svg = svg;
    this.geo = geojson;
    this._anim = null;
    this._scanTimer = null;
    this.onHoodClick = null;   // (polygonName) => void — wired by the app
    this.selected = null;
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
    this.px = (lng) => ((lng - mnx) * k / ((mxx - mnx) * k)) * W;
    this.py = (lat) => H - ((lat - mny) / (mxy - mny)) * H;
    this.unproject = (ux, uy) => ({
      lng: (ux / W) * (mxx - mnx) + mnx,
      lat: mny + ((H - uy) / H) * (mxy - mny),
    });
    /* screen px -> map units. Only exact when the map is untilted (flat). */
    this.screenToUnits = (pxX, pxY) => {
      const r = this.svg.getBoundingClientRect();
      const scale = Math.max(r.width / this.box.w, r.height / this.box.h);
      const offX = (r.width - this.box.w * scale) / 2;
      const offY = (r.height - this.box.h * scale) / 2;
      return { x: this.box.x + (pxX - r.left - offX) / scale,
               y: this.box.y + (pxY - r.top - offY) / scale };
    };

    this.svg.setAttribute("preserveAspectRatio", "xMidYMid slice");
    this.svg.innerHTML = `
      <defs>
        <radialGradient id="nm-water" cx="85%" cy="30%" r="120%">
          <stop offset="0%" stop-color="#0b1a30"/>
          <stop offset="55%" stop-color="#071120"/>
          <stop offset="100%" stop-color="#050b16"/>
        </radialGradient>
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
      <g id="nm-hoods"></g>
      <g id="nm-detail"></g>
      <g id="nm-streets"></g>
      <g id="nm-transit"></g>
      <g id="nm-fx"></g>
      <g id="nm-route"></g>
      <g id="nm-pins"></g>
      <g id="nm-labels"></g>`;

    const hoodsG = this.svg.querySelector("#nm-hoods");
    const labelsG = this.svg.querySelector("#nm-labels");
    this.hoodPaths = new Map();   // name -> face path (scan flicker, glow clone)
    this.hoodGroups = new Map();  // name -> <g>
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
      labelsG.appendChild(label);

      g.append(wall, face);
      hoodsG.appendChild(g);
      this.hoodPaths.set(name, face);
      this.hoodGroups.set(name, g);
      this.hoodLabels.set(name, label);
      this.hoodBBoxes.set(name, { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 });

      face.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (this._dragMoved) return; // that was a pan, not a pick
        if (this.onHoodClick) this.onHoodClick(name);
      });
      // hover = pure CSS lift + a label on the top layer. No DOM reshuffling:
      // moving nodes under the cursor is what caused stuck tiles + dead clicks.
      face.addEventListener("mouseenter", () => {
        if (this.svg.parentElement.classList.contains("explore"))
          label.classList.add("show");
      });
      face.addEventListener("mouseleave", () => label.classList.remove("show"));
    }
    this._orderedGroups = [...hoodsG.children];

    this.cityBox = { x: -W * 0.06, y: -H * 0.02, w: W * 1.24, h: H * 1.04 };
    this._setBox(this.cityBox);
    this._wireInteractions();
  }

  _setBox(b) {
    this.box = b;
    this.svg.setAttribute("viewBox", `${b.x} ${b.y} ${b.w} ${b.h}`);
    // labels, extrusion depth, and hover lift keep constant SCREEN size
    if (this.cityBox) {
      const z = b.w / this.cityBox.w;
      const st = this.svg.style;
      st.setProperty("--lbl", (13 * z).toFixed(2) + "px");
      st.setProperty("--wd", (6 * z).toFixed(2) + "px");
      st.setProperty("--lift", (9 * z).toFixed(2) + "px");
      st.setProperty("--uz", z.toFixed(4) + "px"); // 1 screen-ish px in map units
      const host = this.svg.parentElement;
      host.classList.toggle("zoomed", z < 0.78);
      host.classList.toggle("zoomed2", z < 0.3);
      if (z < 0.85) { // close enough that detail matters — fetch it once
        this.loadStreets("data/streets.min.geojson");
        this.loadDetail("data/detail.min.geojson");
      }
    }
  }

  _restoreOrder() {
    const parent = this.svg.querySelector("#nm-hoods");
    for (const g of this._orderedGroups) parent.appendChild(g);
    if (this.selected && this.hoodGroups.has(this.selected))
      parent.appendChild(this.hoodGroups.get(this.selected));
  }

  /* ---------------- pan / zoom / pinch — the user takes the camera -------- */
  _wireInteractions() {
    const svg = this.svg;
    const ptrs = new Map();
    let start = null, pinch = null;
    this._dragMoved = false;

    const active = () => svg.parentElement.classList.contains("explore");
    const toUnits = (dxPx, dyPx) => {
      const r = { w: svg.clientWidth || 1, h: svg.clientHeight || 1 };
      const scale = Math.max(r.w / this.box.w, r.h / this.box.h);
      return { dx: dxPx / scale, dy: dyPx / scale };
    };
    const clampBox = (b) => {
      const minW = this.cityBox.w / 16, maxW = this.cityBox.w * 1.7;
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

    svg.addEventListener("click", (e) => {
      if (this._placePick && !this._dragMoved) {
        const u = this.screenToUnits(e.clientX, e.clientY);
        const ll = this.unproject(u.x, u.y);
        const cb = this._placePick;
        this.disarmPlacePick();
        cb(ll);
      }
    }, true);
    svg.addEventListener("pointerdown", (e) => {
      if (!active()) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // NO setPointerCapture: capturing retargets the eventual click to the
      // svg, which silently killed every neighborhood tap for real pointers.
      if (this._anim) { cancelAnimationFrame(this._anim); this._anim = null; }
      if (ptrs.size === 1) {
        start = { x: e.clientX, y: e.clientY, box: { ...this.box } };
        this._dragMoved = false;
      } else if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), box: { ...this.box },
                  mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        start = null;
      }
    });
    svg.addEventListener("pointermove", (e) => {
      if (!active() || !ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 1 && start) {
        const dxPx = e.clientX - start.x, dyPx = e.clientY - start.y;
        if (Math.hypot(dxPx, dyPx) > 9) this._dragMoved = true;
        if (!this._dragMoved) return;
        const { dx, dy } = toUnits(dxPx, dyPx);
        this._setBox(clampBox({ ...start.box, x: start.box.x - dx, y: start.box.y - dy }));
      } else if (ptrs.size === 2 && pinch) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const f = pinch.d / d;
        this._dragMoved = true;
        const rect = svg.getBoundingClientRect();
        const rx = (pinch.mx - rect.left) / (rect.width || 1);
        const ry = (pinch.my - rect.top) / (rect.height || 1);
        this._setBox(clampBox(this._scaleBox(pinch.box, f, rx, ry)));
      }
    });
    const up = (e) => {
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch = null;
      if (ptrs.size === 0) {
        start = null;
        setTimeout(() => { this._dragMoved = false; }, 0); // let click handlers read it
      }
    };
    svg.addEventListener("pointerup", up);
    svg.addEventListener("pointercancel", up);

    svg.addEventListener("wheel", (e) => {
      if (!active()) return;
      e.preventDefault();
      if (this._anim) { cancelAnimationFrame(this._anim); this._anim = null; }
      const f = Math.exp(e.deltaY * 0.0016);
      const rect = svg.getBoundingClientRect();
      const rx = (e.clientX - rect.left) / (rect.width || 1);
      const ry = (e.clientY - rect.top) / (rect.height || 1);
      this._setBox(clampBox(this._scaleBox(this.box, f, rx, ry)));
    }, { passive: false });

    svg.addEventListener("dblclick", (e) => {
      if (!active()) return;
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const rx = (e.clientX - rect.left) / (rect.width || 1);
      const ry = (e.clientY - rect.top) / (rect.height || 1);
      this.animateTo(clampBox(this._scaleBox(this.box, 1 / 1.7, rx, ry)), 500);
    });

    // click the water to step back out
    this.svg.querySelector("#nm-water-rect").addEventListener("click", () => {
      if (!active() || this._dragMoved) return;
      if (this.onBackgroundClick) this.onBackgroundClick();
    });
  }

  _scaleBox(b, f, rx, ry) {
    const w = b.w * f, h = b.h * f;
    return { x: b.x + (b.w - w) * rx, y: b.y + (b.h - h) * ry, w, h };
  }

  /* arm a one-shot "tap the map to place" interaction (flat coords only) */
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
  }

  /* project unit-space point to on-screen px. Uses a live probe element so
   * the result stays correct under CSS 3D transforms (the explore tilt). */
  toScreen(ux, uy) {
    const probe = document.createElementNS(NS, "circle");
    probe.setAttribute("cx", ux); probe.setAttribute("cy", uy);
    probe.setAttribute("r", 0.01); probe.setAttribute("fill", "none");
    this.svg.appendChild(probe);
    const r = probe.getBoundingClientRect();
    const host = this.svg.parentElement.getBoundingClientRect();
    probe.remove();
    return { x: r.left + r.width / 2 - host.left, y: r.top + r.height / 2 - host.top };
  }

  setLabel(pt, text) {
    let el = this.svg.parentElement.querySelector(".nm-label");
    if (!el) {
      el = document.createElement("div");
      el.className = "nm-label";
      this.svg.parentElement.appendChild(el);
    }
    if (!pt) { el.classList.remove("show"); return; }
    el.textContent = text;
    const s = this.toScreen(this.px(pt.lng), this.py(pt.lat));
    el.style.left = s.x + "px";
    el.style.top = s.y + "px";
    el.classList.add("show");
  }

  animateTo(target, ms = 1400) {
    return new Promise((res) => {
      if (this._anim) cancelAnimationFrame(this._anim);
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
        else { this._anim = null; res(); }
      };
      this._anim = requestAnimationFrame(step);
    });
  }

  /* ------------------------------ explore -------------------------------- */
  setExplore(on) {
    this.svg.parentElement.classList.toggle("explore", on);
    if (!on) this.selectHood(null, { camera: false });
  }

  /* frame the whole city with UI insets (explore home view) */
  /* layout-box aspect — getBoundingClientRect lies under the 3D tilt */
  _aspect() {
    const w = this.svg.clientWidth, h = this.svg.clientHeight;
    return w && h ? w / h : 1;
  }

  cityView(inset = {}, zoomF = 1) {
    let box = { ...this.cityBox };
    const aspect = this._aspect();
    if (box.w / box.h < aspect) { const nw = box.h * aspect; box.x -= (nw - box.w) / 2; box.w = nw; }
    if (inset.bottom) {
      const cx = box.x + box.w / 2;
      box.h = box.h / (1 - inset.bottom);
      box.w = box.h * aspect;
      box.x = cx - box.w / 2;
    }
    if (inset.right) {
      box.w = box.w / (1 - inset.right);
    }
    if (zoomF !== 1) box = this._scaleBox(box, zoomF, 0.5, 0.42);
    return this.animateTo(box, 950);
  }

  /* Raise + outline a hood; ease the camera onto it. name=null clears. */
  selectHood(name, opts = {}) {
    if (this.selected && this.hoodGroups.has(this.selected))
      this.hoodGroups.get(this.selected).classList.remove("sel");
    this.selected = name || null;
    this._restoreOrder();
    if (!name) {
      if (opts.camera !== false) this.animateTo(this.cityBox, 900);
      return;
    }
    const g = this.hoodGroups.get(name);
    if (!g) return;
    g.classList.add("sel");
    if (opts.camera === false) return;
    const bb = this.hoodBBoxes.get(name);
    const aspect = this._aspect();
    // wide framing: the tilt's CSS scale magnifies, and neighbors are context
    let w = Math.max(bb.w * 3.4, 330), h = Math.max(bb.h * 3.6, 330 / aspect);
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
    return this.animateTo(box, 1000);
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
      tag.setAttribute("y", (y - 2).toFixed(1));
      tag.setAttribute("text-anchor", "middle");
      tag.textContent = p.name;
      hit.addEventListener("mouseenter", () => this.setLabel({ lat: p.lat, lng: p.lng }, p.name));
      hit.addEventListener("mouseleave", () => this.setLabel(null));
      hit.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (this._dragMoved) return;
        this.setLabel(null);
        if (this.onSpotClick) this.onSpotClick(p.id);
      });
      g.append(hit, dot, tag);
    }
    this.svg.querySelector("#nm-pins").appendChild(g);
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
  }

  setOverlay(kind, on) {
    this.svg.parentElement.classList.toggle("show-" + kind, on);
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
    const o = { x: this.px(origin.lng), y: this.py(origin.lat) };
    const d = { x: this.px(dest.lng), y: this.py(dest.lat) };
    const second = opts.second ? { x: this.px(opts.second.lng), y: this.py(opts.second.lat) } : null;

    // frame origin + dest (+ second) with generous padding
    const xs = [o.x, d.x, ...(second ? [second.x] : [])];
    const ys = [o.y, d.y, ...(second ? [second.y] : [])];
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
      const glow = src.cloneNode();
      glow.setAttribute("class", "nm-hood-glow");
      this.svg.querySelector("#nm-fx").appendChild(glow);
    }

    await this.animateTo(box, opts.fast ? 800 : 1500);

    const u = box.w / 150; // sizing unit relative to zoom level
    const routeG = this.svg.querySelector("#nm-route");
    const pinsG = this.svg.querySelector("#nm-pins");

    // origin marker
    const home = document.createElementNS(NS, "circle");
    home.setAttribute("cx", o.x); home.setAttribute("cy", o.y);
    home.setAttribute("r", (u * 0.8).toFixed(2));
    home.setAttribute("class", "nm-home");
    pinsG.appendChild(home);

    // curved route
    const dx = d.x - o.x, dy = d.y - o.y;
    const dist = Math.hypot(dx, dy) || 1;
    const bow = Math.min(dist * 0.22, u * 16);
    const mx = (o.x + d.x) / 2 - (dy / dist) * bow;
    const my = (o.y + d.y) / 2 + (dx / dist) * bow;
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

    if (second) {
      const hop = document.createElementNS(NS, "path");
      const hdx = second.x - d.x, hdy = second.y - d.y;
      const hd = Math.hypot(hdx, hdy) || 1;
      const hmx = (d.x + second.x) / 2 - (hdy / hd) * Math.min(hd * 0.3, u * 5);
      const hmy = (d.y + second.y) / 2 + (hdx / hd) * Math.min(hd * 0.3, u * 5);
      hop.setAttribute("d", `M ${d.x} ${d.y} Q ${hmx} ${hmy} ${second.x} ${second.y}`);
      hop.setAttribute("class", "nm-hopline");
      hop.setAttribute("stroke-width", (u * 0.32).toFixed(2));
      routeG.appendChild(hop);
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("cx", second.x); dot.setAttribute("cy", second.y);
      dot.setAttribute("r", (u * 0.8).toFixed(2));
      dot.setAttribute("class", "nm-second");
      pinsG.appendChild(dot);
    }
  }
}
