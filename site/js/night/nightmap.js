/* nightmap.js — the reveal. A dark, custom-drawn SVG of Chicago's 98
 * neighborhoods (official Choose Chicago boundaries) that behaves like a
 * camera: it scans while the engine thinks, then zooms to tonight's pick,
 * draws the route from home base, and drops a glowing pin. No tiles, no
 * Leaflet — the city itself is the art. */

const NS = "http://www.w3.org/2000/svg";
const W = 1000;

export class NightMap {
  constructor(svg, geojson) {
    this.svg = svg;
    this.geo = geojson;
    this._anim = null;
    this._scanTimer = null;
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
    this.hoodPaths = new Map();
    for (const f of feats) {
      const p = document.createElementNS(NS, "path");
      let d = "";
      const polys = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
      polys.forEach((poly) => poly.forEach((ring) => {
        ring.forEach((c, i) => {
          d += (i ? "L" : "M") + this.px(c[0]).toFixed(1) + " " + this.py(c[1]).toFixed(1);
        });
        d += "Z";
      }));
      p.setAttribute("d", d);
      p.setAttribute("class", "nm-hood");
      p.dataset.name = f.properties.name;
      hoodsG.appendChild(p);
      this.hoodPaths.set(f.properties.name, p);
    }
    this.cityBox = { x: -W * 0.06, y: -H * 0.02, w: W * 1.24, h: H * 1.04 };
    this._setBox(this.cityBox);
  }

  _setBox(b) {
    this.box = b;
    this.svg.setAttribute("viewBox", `${b.x} ${b.y} ${b.w} ${b.h}`);
  }

  /* project unit-space point to on-screen px, honoring slice-crop */
  toScreen(ux, uy) {
    const el = this.svg.getBoundingClientRect();
    const scale = Math.max(el.width / this.box.w, el.height / this.box.h);
    const renderW = this.box.w * scale, renderH = this.box.h * scale;
    const offX = (el.width - renderW) / 2, offY = (el.height - renderH) / 2;
    return { x: offX + (ux - this.box.x) * scale, y: offY + (uy - this.box.y) * scale };
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
    const el = this.svg.getBoundingClientRect();
    const aspect = el.width && el.height ? el.width / el.height : 1;
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
    const el = this.svg.getBoundingClientRect();
    const aspect = el.width && el.height ? el.width / el.height : 1;
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
