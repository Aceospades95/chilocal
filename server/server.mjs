/* server.mjs — ChiLocal companion API. Zero dependencies, Node 22+.
 * ---------------------------------------------------------------------------
 * Three jobs, all optional — the static site works fully without this:
 *
 *   /api/cta/arrivals   live CTA Train Tracker arrivals (needs CTA_TRAIN_KEY;
 *                       free signup: https://www.transitchicago.com/developers/traintracker/)
 *                       — proxied because the CTA API sends no CORS headers,
 *                       and the key must never reach the browser.
 *   /api/events/today   tonight's events via Ticketmaster Discovery (needs
 *                       TM_KEY; free: https://developer.ticketmaster.com/)
 *   /api/room/*         two-phone decide-together rooms (in-memory, 2h TTL,
 *                       no accounts, no persistence — a lobby, not a database)
 *
 * Keys live in environment variables ONLY. They are never logged, never
 * echoed in responses, never written to disk.
 *
 *   docker run -e CTA_TRAIN_KEY=... -e TM_KEY=... -p 8787:8787 chilocal-api
 */
import { createServer } from "node:http";
import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";

const PORT = +(process.env.PORT || 8787);
const CTA_KEY = process.env.CTA_TRAIN_KEY || "";
const TM_KEY = process.env.TM_KEY || "";
const DATA_DIR = process.env.DATA_DIR || ".";

/* ------------------------------- accounts --------------------------------
 * Email + password, done the boring-secure way and nothing more:
 *   - scrypt password hashes (memory-hard, node:crypto, per-user salt)
 *   - opaque session tokens in HttpOnly SameSite=Lax cookies; only the
 *     token's SHA-256 touches disk, so a leaked DB can't replay sessions
 *   - SQLite on YOUR box (node:sqlite, zero dependencies) — no third party
 *   - rate-limited auth endpoints, generic error copy, no hash ever leaves
 * Accounts require the same-origin /api proxy route (SameSite cookies do
 * not travel cross-site — that's a feature). */
mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(`${DATA_DIR}/chilocal.db`);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    pass_salt TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL
  );
`);
const SESS_TTL = 30 * 24 * 3600_000;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const scryptHash = (pw, salt) => new Promise((res, rej) =>
  scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k))));
async function hashPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  return { salt, hash: (await scryptHash(pw, salt)).toString("hex") };
}
async function verifyPassword(pw, salt, hash) {
  const k = await scryptHash(pw, salt);
  const h = Buffer.from(hash, "hex");
  return k.length === h.length && timingSafeEqual(k, h);
}
const pubUser = (u) => ({ id: u.id, email: u.email, name: u.name, created: u.created });
function createSession(res, req, userId) {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  db.prepare("INSERT INTO sessions (token_hash, user_id, created, expires) VALUES (?,?,?,?)")
    .run(sha256(token), userId, now, now + SESS_TTL);
  const secure = (req.headers["x-forwarded-proto"] || "").includes("https") ? "; Secure" : "";
  res.setHeader("Set-Cookie",
    `chilocal_sess=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESS_TTL / 1000}${secure}`);
}
function readSession(req) {
  const m = /(?:^|;\s*)chilocal_sess=([a-f0-9]{64})/.exec(req.headers.cookie || "");
  if (!m) return null;
  const row = db.prepare(
    `SELECT u.id, u.email, u.name, u.created, s.token_hash, s.expires FROM sessions s
     JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha256(m[1]));
  if (!row || row.expires < Date.now()) return null;
  if (row.expires - Date.now() < SESS_TTL / 2) // rolling renewal
    db.prepare("UPDATE sessions SET expires = ? WHERE token_hash = ?")
      .run(Date.now() + SESS_TTL, row.token_hash);
  return row;
}
function clearSession(req, res) {
  const m = /(?:^|;\s*)chilocal_sess=([a-f0-9]{64})/.exec(req.headers.cookie || "");
  if (m) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(m[1]));
  res.setHeader("Set-Cookie", "chilocal_sess=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}
setInterval(() => db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now()), 6 * 3600_000).unref();

/* auth endpoints get a per-IP budget so passwords can't be guessed in bulk */
const authHits = new Map();
function rateLimited(req) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
             req.socket.remoteAddress || "?";
  const now = Date.now();
  const e = authHits.get(ip) || { n: 0, reset: now + 10 * 60_000 };
  if (now > e.reset) { e.n = 0; e.reset = now + 10 * 60_000; }
  e.n++;
  authHits.set(ip, e);
  if (authHits.size > 5000) authHits.clear();
  return e.n > 25;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* ------------------------------ tiny helpers ------------------------------ */
const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
};

function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); }
      catch { reject(new Error("bad json")); }
    });
    req.on("error", reject);
  });
}

const fetchJson = (url, ms = 8000) =>
  fetch(url, { signal: AbortSignal.timeout(ms), headers: { "User-Agent": "ChiLocal/1.0" } })
    .then((r) => { if (!r.ok) throw new Error(`upstream ${r.status}`); return r.json(); });

/* ------------------------- CTA Train Tracker proxy ------------------------ */
const ctaCache = new Map(); // mapid -> { t, data }
async function ctaArrivals(mapid) {
  const hit = ctaCache.get(mapid);
  if (hit && Date.now() - hit.t < 30_000) return hit.data;
  const raw = await fetchJson(
    `https://lapi.transitchicago.com/api/1.0/ttarrivals.aspx?key=${CTA_KEY}&mapid=${mapid}&max=10&outputType=JSON`);
  const eta = raw?.ctatt?.eta || [];
  const data = {
    station: eta[0]?.staNm || null,
    fetched: raw?.ctatt?.tmst || null,
    arrivals: eta.map((e) => ({
      route: e.rt, dest: e.destNm,
      // minutes until arrival = predicted arrival − prediction timestamp;
      // both come in the same local format, so the zone cancels out
      min: Math.max(0, Math.round((Date.parse(e.arrT) - Date.parse(e.prdt)) / 60_000)),
      app: e.isApp === "1", sch: e.isSch === "1", dly: e.isDly === "1",
    })),
  };
  ctaCache.set(mapid, { t: Date.now(), data });
  return data;
}

/* --------------------------- events (Ticketmaster) ------------------------ */
let evCache = null; // { t, data }
function chiOffsetHours(d = new Date()) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", timeZoneName: "shortOffset" })
    .formatToParts(d).find((p) => p.type === "timeZoneName")?.value || "GMT-6";
  return parseInt(part.replace("GMT", ""), 10) || -6;
}
async function eventsToday() {
  if (evCache && Date.now() - evCache.t < 30 * 60_000) return evCache.data;
  // "tonight" = Chicago-local noon today → 6am tomorrow, expressed in UTC
  const off = chiOffsetHours();
  const now = new Date();
  const chiNow = new Date(now.getTime() + off * 3600_000);
  const y = chiNow.getUTCFullYear(), m = chiNow.getUTCMonth(), day = chiNow.getUTCDate();
  const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
  const start = iso(Date.UTC(y, m, day, 12 - off));
  const end = iso(Date.UTC(y, m, day + 1, 6 - off));
  const raw = await fetchJson(
    "https://app.ticketmaster.com/discovery/v2/events.json" +
    `?apikey=${TM_KEY}&latlong=41.8781,-87.6298&radius=15&unit=miles&size=120&sort=date,asc` +
    `&startDateTime=${start}&endDateTime=${end}`);
  const seen = new Set();
  const data = (raw?._embedded?.events || []).flatMap((e) => {
    const ven = e._embedded?.venues?.[0];
    const key = `${e.name}|${ven?.name || ""}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const lt = e.dates?.start?.localTime || null; // "19:30:00"
    let time = null;
    if (lt) {
      let [h, min] = lt.split(":").map(Number);
      const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
      time = min ? `${h}:${String(min).padStart(2, "0")} ${ap}` : `${h} ${ap}`;
    }
    return [{
      name: e.name, url: e.url || null, time,
      venue: ven?.name || null,
      lat: ven?.location ? +ven.location.latitude : null,
      lng: ven?.location ? +ven.location.longitude : null,
      seg: e.classifications?.[0]?.segment?.name || null,
      source: "ticketmaster",
    }];
  });
  evCache = { t: Date.now(), data };
  return data;
}

/* ------------------------- two-phone rooms (in-memory) --------------------- */
const rooms = new Map(); // code -> room
const ROOM_TTL = 2 * 3600_000;
const CODE_ABC = "ABCDEFGHJKMNPQRSTUVWXYZ"; // no I/L/O — read over a bar's noise
function newCode() {
  for (let tries = 0; tries < 40; tries++) {
    let c = "";
    for (let i = 0; i < 4; i++) c += CODE_ABC[Math.floor(Math.random() * CODE_ABC.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
setInterval(() => {
  const cut = Date.now() - ROOM_TTL;
  for (const [c, r] of rooms) if (r.touched < cut) rooms.delete(c);
}, 10 * 60_000).unref();

const cleanPrefs = (p) => {
  if (!p || typeof p !== "object") return null;
  const vibes = Array.isArray(p.vibes) ? p.vibes.slice(0, 6).map((v) => String(v).slice(0, 24)) : [];
  const picks = {};
  if (p.picks && typeof p.picks === "object")
    for (const [k, v] of Object.entries(p.picks).slice(0, 8)) picks[String(k).slice(0, 24)] = String(v).slice(0, 8);
  return { vibes, picks };
};
const cleanPlan = (p) => {
  if (!p || typeof p !== "object") return null;
  const s = (x, n = 160) => (x == null ? null : String(x).slice(0, n));
  return { hero: s(p.hero), hood: s(p.hood, 60), why: s(p.why, 300),
           second: s(p.second), third: s(p.third), roll: Math.min(99, +p.roll || 0) };
};

/* --------------------------------- router --------------------------------- */
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  // credentialed CORS: reflect the origin (cookies never ride on "*")
  if (req.headers.origin) {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    });
    return res.end();
  }
  try {
    if (path === "/api/health" && req.method === "GET")
      return json(res, 200, { ok: true, cta: !!CTA_KEY, events: !!TM_KEY, rooms: true, auth: true });

    /* ------------------------------ accounts ------------------------------ */
    if (path.startsWith("/api/auth/")) {
      if (req.method !== "GET" && rateLimited(req))
        return json(res, 429, { error: "Too many tries — take a breather and try again in a few minutes." });

      if (path === "/api/auth/signup" && req.method === "POST") {
        const b = await readBody(req);
        const email = String(b.email || "").trim().toLowerCase();
        const password = String(b.password || "");
        const name = String(b.name || "").trim().slice(0, 40) || email.split("@")[0];
        if (!EMAIL_RE.test(email) || email.length > 254)
          return json(res, 400, { error: "That doesn't look like an email address." });
        if (password.length < 8 || password.length > 200)
          return json(res, 400, { error: "Passwords need at least 8 characters." });
        const { salt, hash } = await hashPassword(password);
        try {
          const r = db.prepare("INSERT INTO users (email, name, pass_salt, pass_hash, created) VALUES (?,?,?,?,?)")
            .run(email, name, salt, hash, Date.now());
          createSession(res, req, Number(r.lastInsertRowid));
          const u = db.prepare("SELECT id, email, name, created FROM users WHERE id = ?").get(Number(r.lastInsertRowid));
          return json(res, 200, { user: pubUser(u) });
        } catch (e) {
          if (String(e.message).includes("UNIQUE"))
            return json(res, 409, { error: "That email already has an account — sign in instead." });
          throw e;
        }
      }

      if (path === "/api/auth/login" && req.method === "POST") {
        const b = await readBody(req);
        const email = String(b.email || "").trim().toLowerCase();
        const u = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
        // same message either way — no fishing for which emails exist
        if (!u || !(await verifyPassword(String(b.password || ""), u.pass_salt, u.pass_hash)))
          return json(res, 401, { error: "Email or password is wrong." });
        createSession(res, req, u.id);
        return json(res, 200, { user: pubUser(u) });
      }

      if (path === "/api/auth/logout" && req.method === "POST") {
        clearSession(req, res);
        return json(res, 200, { ok: true });
      }

      if (path === "/api/auth/me" && req.method === "GET") {
        const s = readSession(req);
        return json(res, 200, { user: s ? pubUser(s) : null });
      }

      if (path === "/api/auth/profile" && req.method === "PATCH") {
        const s = readSession(req);
        if (!s) return json(res, 401, { error: "Sign in first." });
        const b = await readBody(req);
        const name = String(b.name || "").trim().slice(0, 40);
        if (!name) return json(res, 400, { error: "A name can't be empty." });
        db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, s.id);
        return json(res, 200, { user: { ...pubUser(s), name } });
      }
      return json(res, 404, { error: "not found" });
    }

    if (path === "/api/cta/arrivals" && req.method === "GET") {
      if (!CTA_KEY) return json(res, 503, { error: "CTA_TRAIN_KEY not configured" });
      const mapid = url.searchParams.get("mapid") || "";
      if (!/^4\d{4}$/.test(mapid)) return json(res, 400, { error: "mapid must be a 5-digit CTA station id" });
      return json(res, 200, await ctaArrivals(mapid));
    }

    if (path === "/api/events/today" && req.method === "GET") {
      if (!TM_KEY) return json(res, 503, { error: "TM_KEY not configured" });
      return json(res, 200, await eventsToday());
    }

    if (path === "/api/room" && req.method === "POST") {
      if (rooms.size >= 500) return json(res, 429, { error: "room limit reached — try later" });
      const code = newCode();
      if (!code) return json(res, 500, { error: "could not allocate a code" });
      rooms.set(code, { created: Date.now(), touched: Date.now(),
                        host: null, guest: null, plan: null, veto: 0, vetoUsed: false });
      return json(res, 200, { code });
    }

    const m = path.match(/^\/api\/room\/([A-Z]{4})(\/submit)?$/);
    if (m) {
      const room = rooms.get(m[1]);
      if (!room) return json(res, 404, { error: "no such room (codes expire after 2 hours)" });
      room.touched = Date.now();
      if (!m[2] && req.method === "GET")
        return json(res, 200, { code: m[1], hasHost: !!room.host, hasGuest: !!room.guest,
                                guest: room.guest, plan: room.plan, veto: room.veto, vetoUsed: room.vetoUsed });
      if (m[2] && req.method === "POST") {
        const b = await readBody(req);
        if (b.role === "guest") {
          if (b.prefs) room.guest = cleanPrefs(b.prefs);
          if (b.veto && !room.vetoUsed) { room.veto++; room.vetoUsed = true; }
        } else if (b.role === "host") {
          if (b.prefs) room.host = cleanPrefs(b.prefs);
          if (b.plan) room.plan = cleanPlan(b.plan);
        } else return json(res, 400, { error: "role must be host or guest" });
        return json(res, 200, { ok: true });
      }
    }

    return json(res, 404, { error: "not found" });
  } catch (e) {
    const msg = /too large|bad json/.test(String(e?.message)) ? e.message : "upstream failed";
    return json(res, msg === "upstream failed" ? 502 : 400, { error: msg });
  }
});

server.listen(PORT, () => {
  console.log(`chilocal-api on :${PORT} — cta:${CTA_KEY ? "on" : "off"} events:${TM_KEY ? "on" : "off"} rooms:on auth:on (db: ${DATA_DIR}/chilocal.db)`);
});
