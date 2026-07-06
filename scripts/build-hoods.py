#!/usr/bin/env python3
"""build-hoods.py — bake site/data/neighborhoods.min.geojson from the
official City of Chicago "Boundaries - Neighborhoods" export (y6yq-dbs2).

    curl -fsSL "https://data.cityofchicago.org/api/geospatial/y6yq-dbs2?method=export&format=GeoJSON" -o /tmp/hoods-official.json
    python3 scripts/build-hoods.py /tmp/hoods-official.json [tolerance_m]

Why not plain per-polygon simplification: neighborhoods share borders
vertex-for-vertex in the official data. Simplifying each polygon on its own
makes shared borders diverge — slivers of the city fall into gaps or get
claimed by both sides. So this does it the TopoJSON way: decompose all rings
into shared ARCS, Douglas-Peucker each arc ONCE, and rebuild every ring from
the same simplified arcs. Neighbors stay stitched exactly; nobody's block
changes neighborhood because of a rendering optimization.

Default tolerance: 8 m worst-case deviation from the official line.
"""
import json, math, sys, re

src = sys.argv[1] if len(sys.argv) > 1 else "/tmp/hoods-official.json"
TOL_M = float(sys.argv[2]) if len(sys.argv) > 2 else 8.0
TOL_DEG = TOL_M / 111_132.0          # meters -> degrees latitude
COSLAT = math.cos(math.radians(41.85))  # isotropy: scale lng before measuring

off = json.load(open(src))
Q = 7  # quantization for topology keys (~1 cm — matches source precision)
qp = lambda c: (round(c[0], Q), round(c[1], Q))

# ---- collect all rings ------------------------------------------------------
rings = []   # (feature_idx, poly_idx, ring_idx, [pts])
for fi, f in enumerate(off["features"]):
    g = f["geometry"]
    polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    for pi, poly in enumerate(polys):
        for ri, ring in enumerate(poly):
            pts = [qp(c) for c in ring]
            if pts[0] != pts[-1]: pts.append(pts[0])
            # drop consecutive duplicates
            ded = [pts[0]]
            for p in pts[1:]:
                if p != ded[-1]: ded.append(p)
            rings.append((fi, pi, ri, ded))

# ---- find nodes: points whose neighbor-set isn't exactly two ---------------
neigh = {}
for _, _, _, pts in rings:
    n = len(pts) - 1  # closed
    for i in range(n):
        p = pts[i]
        s = neigh.setdefault(p, set())
        s.add(pts[i - 1] if i > 0 else pts[n - 1])
        s.add(pts[i + 1])
is_node = {p for p, s in neigh.items() if len(s) != 2}

# ---- Douglas-Peucker on scaled coords ---------------------------------------
def dp(pts, tol):
    if len(pts) <= 2: return pts
    sx = lambda p: (p[0] * COSLAT, p[1])
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i0, i1 = stack.pop()
        if i1 <= i0 + 1: continue
        ax, ay = sx(pts[i0]); bx, by = sx(pts[i1])
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        worst, wi = -1.0, -1
        for i in range(i0 + 1, i1):
            px, py = sx(pts[i])
            if L2 == 0: d2 = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = ((px - ax) * dx + (py - ay) * dy) / L2
                t = max(0.0, min(1.0, t))
                d2 = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2
            if d2 > worst: worst, wi = d2, i
        if worst > tol * tol:
            keep[wi] = True
            stack.append((i0, wi)); stack.append((wi, i1))
    return [p for p, k in zip(pts, keep) if k]

# ---- split rings into arcs at nodes, simplify each unique arc once ---------
arcs = {}  # canonical key -> simplified pts
def arc_key(pts):
    r = pts[::-1]
    return (tuple(pts), False) if tuple(pts) <= tuple(r) else (tuple(r), True)

def simplify_arc(pts):
    key, rev = arc_key(pts)
    if key not in arcs:
        arcs[key] = dp(list(key), TOL_DEG)
    out = arcs[key]
    return out[::-1] if rev else out

new_rings = {}
for fi, pi, ri, pts in rings:
    n = len(pts) - 1
    node_idx = [i for i in range(n) if pts[i] in is_node]
    if not node_idx:
        # closed loop touching nothing: pin two extremes so DP can't collapse it
        far = max(range(n), key=lambda i: (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2)
        a = simplify_arc(pts[0:far + 1])
        b = simplify_arc(pts[far:])
        out = a[:-1] + b
    else:
        out = []
        k = len(node_idx)
        for j in range(k):
            i0, i1 = node_idx[j], node_idx[(j + 1) % k]
            seg = pts[i0:i1 + 1] if i1 > i0 else pts[i0:n] + pts[0:i1 + 1]
            s = simplify_arc(seg)
            out.extend(s[:-1])
        out.append(out[0])
    if len(out) < 4:  # degenerate after simplification: keep the original ring
        out = pts
    new_rings[(fi, pi, ri)] = out

# ---- reassemble features, keep the app's property schema -------------------
slug = lambda s: re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
R5 = lambda p: [round(p[0], 5), round(p[1], 5)]
M2_SQMI = 2_589_988.11

def ring_area_m2(pts):
    a = 0.0
    for i in range(len(pts) - 1):
        x0, y0 = pts[i][0] * COSLAT * 111_320, pts[i][1] * 111_132
        x1, y1 = pts[i + 1][0] * COSLAT * 111_320, pts[i + 1][1] * 111_132
        a += x0 * y1 - x1 * y0
    return a / 2

feats = []
total_pts = 0
for fi, f in enumerate(off["features"]):
    g = f["geometry"]
    npolys = len(g["coordinates"]) if g["type"] == "MultiPolygon" else 1
    coords = []
    area = 0.0
    for pi in range(npolys):
        rcount = len((g["coordinates"][pi] if g["type"] == "MultiPolygon" else g["coordinates"]))
        poly = []
        for ri in range(rcount):
            pts = new_rings[(fi, pi, ri)]
            rounded = [R5(p) for p in pts]
            ded = [rounded[0]]
            for p in rounded[1:]:
                if p != ded[-1]: ded.append(p)
            if ded[0] != ded[-1]: ded.append(ded[0])
            total_pts += len(ded)
            poly.append(ded)
            area += ring_area_m2(pts) * (1 if ri == 0 else 1)  # holes carry opposite winding
        coords.append(poly)
    name = f["properties"]["pri_neigh"]
    feats.append({
        "type": "Feature",
        "properties": {
            "id": slug(name), "name": name,
            "secondary": f["properties"].get("sec_neigh", ""),
            "layer": "neighborhoods",
            "area_sqmi": round(abs(area) / M2_SQMI, 3),
        },
        "geometry": {"type": "MultiPolygon", "coordinates": coords},
    })

feats.sort(key=lambda f: f["properties"]["id"])
out = {"type": "FeatureCollection",
       "note": "Boundaries - Neighborhoods, City of Chicago data portal (y6yq-dbs2); "
               f"topology-preserving simplification, worst-case deviation ~{TOL_M:g} m",
       "features": feats}
with open("site/data/neighborhoods.min.geojson", "w") as fh:
    json.dump(out, fh, separators=(",", ":"))
print(f"wrote site/data/neighborhoods.min.geojson — {len(feats)} hoods, "
      f"{total_pts} vertices, tol {TOL_M:g} m, {len(arcs)} unique arcs")
