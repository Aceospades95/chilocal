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
      <rect x="${-W}" y="${-H}" width="${W * 3}" height="${H * 3}" fill="url(#nm-water)"/>
      <g id="nm-hoods"></g>
      <g id="nm-fx"></g>
      <g id="nm-route"></g>
      <g id="nm-pins"></g>`;

    const hoodsG = this.svg.querySelector("#nm-hoods");
    this.hoodPaths = new Map();   // name -> face path (scan flicker, glow clone)
    this.hoodGroups = new Map();  // name -> <g>
    this.hoodBBoxes = new Map();  // name -> {x,y,w,h}

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
      const polys = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
      polys.forEach((poly) => poly.forEach((ring) => {
        ring.forEach((c, i) => {
          const x = this.px(c[0]), y = this.py(c[1]);
          bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x);
          by0 = Math.min(by0, y); by1 = Math.max(by1, y);
          d += (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
        });
        d += "Z";
      }));

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
      label.setAttribute("x", ((bx0 + bx1) / 2).toFixed(1));
      label.setAttribute("y", ((by0 + by1) / 2).toFixed(1));
      label.setAttribute("text-anchor", "middle");
      label.textContent = name.replace(/,/, " · ").toUpperCase();

      g.append(wall, face, label);
      hoodsG.appendChild(g);
      this.hoodPaths.set(name, face);
      this.hoodGroups.set(name, g);
      this.hoodBBoxes.set(name, { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 });

      face.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (this.onHoodClick) this.onHoodClick(name);
      });
      // raise toward the viewer: hovered hood paints above its neighbors
      face.addEventListener("mouseenter", () => hoodsG.appendChild(g));
      face.addEventListener("mouseleave", () => {
        if (!g.classList.contains("sel")) this._restoreOrder();
      });
    }
    this._orderedGroups = [...hoodsG.children];

    this.cityBox = { x: -W * 0.06, y: -H * 0.02, w: W * 1.24, h: H * 1.04 };
    this._setBox(this.cityBox);
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
    }
  }

  _restoreOrder() {
    const parent = this.svg.querySelector("#nm-hoods");
    for (const g of this._orderedGroups) parent.appendChild(g);
    // keep the selected hood on top after re-sorting
    if (this.selected && this.hoodGroups.has(this.selected))
      parent.appendChild(this.hoodGroups.get(this.selected));
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

  cityView(inset = {}) {
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
    const u = this.box.w / 150;
    g.innerHTML = pts.map((p) => `
      <circle class="nm-spot-dot" cx="${this.px(p.lng).toFixed(1)}" cy="${this.py(p.lat).toFixed(1)}" r="${(u * 0.55).toFixed(2)}"/>`).join("");
    this.svg.querySelector("#nm-pins").appendChild(g);
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
