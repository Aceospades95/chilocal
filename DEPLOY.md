# Deploying chilocal on Unraid

This app builds from a `Dockerfile`. Unraid's **built-in Docker tab can only run
pre-built images**, so we let GitHub build the image and Unraid pull it.

## Path A — GitHub Actions → GHCR → Unraid Docker tab (no plugins)

1. **Push this folder to a GitHub repo** named `chilocal` (a git repo is already
   initialized here):
   ```bash
   git remote add origin https://github.com/<you>/chilocal.git
   git push -u origin main
   ```
2. The included workflow (`.github/workflows/docker-publish.yml`) runs
   automatically and publishes an image to
   `ghcr.io/<you>/chilocal:latest`.
3. **Make the package public** (one-time): GitHub → your profile → Packages →
   `chilocal` → Package settings → Change visibility → Public. (Otherwise Unraid
   needs a registry login.)
4. **Unraid → Docker → Add Container:**
   - Repository: `ghcr.io/<you>/chilocal:latest`
   - Network: `bridge`
   - Add a Port: container `80` → host `8080`
   - Apply. Browse to `http://<server-ip>:8080`.
5. **Updates:** push to GitHub → re-run finishes → on Unraid click *Force update*
   on the container (or Check for Updates).

## Path B — Compose Manager plugin (builds on the server from git)

If you install **Docker Compose Manager** (Community Apps): add a new stack,
point it at the GitHub repo URL, Compose Up. It builds locally — no GHCR step,
and the build-time `fetch-data.sh` pulls full-resolution boundaries.

## Path C — One-off via Unraid terminal

```bash
cd /mnt/user/appdata
git clone https://github.com/<you>/chilocal.git
cd chilocal
docker build -t chilocal .
docker run -d --name chilocal --restart unless-stopped -p 8080:80 chilocal
```

---

# The companion API (optional): live CTA arrivals · events · two-phone mode

`server/server.mjs` is a **zero-dependency Node server** that unlocks three
features the static site can't do alone. **The site works fully without it** —
if the server isn't reachable, those features simply stay hidden.

| feature | needs | where to get it (free) |
|---|---|---|
| Live L arrivals ("Pink → Loop: 4 min") | `CTA_TRAIN_KEY` | https://www.transitchicago.com/developers/traintracker/ |
| Tonight's events ("🎫 tonight here") | `TM_KEY` | https://developer.ticketmaster.com/ (Discovery API) |
| Two-phone decide-together rooms | nothing — works keyless | — |

Keys live in **environment variables on the container only** — never in the
repo, never sent to the browser (the server proxies CTA/Ticketmaster and
keeps the keys server-side; that proxy is also required because the CTA API
sends no CORS headers).

## Deploy (Unraid)

The same GitHub workflow now also publishes
`ghcr.io/<you>/chilocal-api:latest` (make this package public too, one-time).

**Unraid → Docker → Add Container:**
- Repository: `ghcr.io/<you>/chilocal-api:latest`
- Network: `bridge`
- Port: container `8787` → host `8787`
- **Path: container `/data` → host `/mnt/user/appdata/chilocal-api`**
  (the account database `chilocal.db` lives here — this mapping is what
  makes accounts survive container updates; back this folder up)
- Variables (optional): `CTA_TRAIN_KEY`, `TM_KEY`
- Apply. Check: `curl http://<server-ip>:8787/api/health`
  → `{"ok":true,"cta":true,"events":true,"rooms":true,"auth":true}`

## MEMBERS ONLY — the whole site is behind login

The site container now enforces auth at nginx (`auth_request`): every
request for the app, its code, and its data must carry a valid session
cookie, or it 302s to `/gate.html` — a self-contained sign-in / signup
page. Signup stays open, so people can join themselves.

- The site container asks the API container on every request. Set
  `API_UPSTREAM` on the **site** container if your API isn't at the
  default `192.168.1.19:8787`.
- **The API container must be running** — if it's down, everyone
  (including you) sees only the gate. Locked means locked.
- Gated assets are served `Cache-Control: private` so Cloudflare can
  never hand cached content to anonymous visitors. Purge the CF cache
  once after this deploy to evict anything cached under the old public
  headers.
- With the whole site behind its own login, the NPM basic-auth wall is
  now redundant — remove it whenever you're ready to let people join.

## Accounts (signup/login)

The server stores users in SQLite on your box — no third-party auth, no
cloud. Passwords are scrypt-hashed with per-user salts; sessions are
opaque tokens in HttpOnly SameSite cookies (only the token's SHA-256
touches disk); auth endpoints are rate-limited per IP.

Two infrastructure notes, both your call:
1. Accounts REQUIRE the same-origin `/api` proxy route (above) — session
   cookies deliberately don't travel cross-site.
2. For strangers to actually join, the basic-auth wall in front of
   chilocal.omnia-house.com has to come off (Nginx Proxy Manager →
   proxy host → Access List → none). Until then, accounts work for
   anyone who has the basic-auth credentials.

## Wire it to the site

The frontend calls **same-origin `/api/...`** by default. In Nginx Proxy
Manager, on the `chilocal.omnia-house.com` proxy host, add a **Custom
Location**: location `/api` → forward to `http://192.168.1.19:8787`. Done —
no new public hostname, the existing basic auth keeps covering everything.

For LAN testing before the proxy route exists, open the site as
`https://chilocal.omnia-house.com/?api=http://192.168.1.19:8787`
(the override persists on that device; `?api=` clears it).

Rooms are in-memory with a 2-hour TTL — restarting the container simply
forgets live room codes, nothing else is stored.
