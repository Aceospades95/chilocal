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

## Email — password reset + verification (OFF until you add a provider)

The full flows are built and tested, but they stay **feature-flagged off**
until the API container gets provider credentials — signup and login are
never blocked by this. While off: "Forgot password?" is hidden everywhere,
`/api/auth/forgot` answers a clean 503, and new accounts are created
already-verified (nobody could click a link that can't be sent).

**TODO(jacob) — to flip email on**, add these variables to the
`chilocal-api` container and restart it (no rebuild needed):

| variable | value |
|---|---|
| `EMAIL_API_KEY` | API key from your provider (Resend/Postmark-style) |
| `EMAIL_FROM` | a sender the provider has verified, e.g. `ChiLocal <night@omnia-house.com>` |
| `EMAIL_API_URL` | optional — defaults to Resend's `https://api.resend.com/emails` |
| `PUBLIC_URL` | optional — defaults to `https://chilocal.omnia-house.com` |

The payload shape matches Resend (resend.com — free tier is plenty at this
size; you'd verify the omnia-house.com domain there, then use a
`…@omnia-house.com` sender). For a different provider, adjust `sendEmail()`
in `server/server.mjs`. Once the vars are set, `/api/health` reports
`"email":true` and the gate grows a working "Forgot password?" link;
new signups get a one-week verification link automatically.

## The weekly digest list (CSV export)

Members opt in with an **unchecked-by-default** checkbox at signup (or in
Settings → Your account) — that flag is the consent record, and the delete
button in Settings erases them from it. To pull the current list:

```bash
docker exec chilocal-api node --experimental-sqlite export-digest.mjs > digest.csv
# → email,name,joined — one row per opted-in member
```

## Privacy page

`/privacy.html` is deliberately **public** (it's in nginx's anonymous
allowlist next to the gate) so people can read it before handing over an
email. It's linked from the gate, the signup dialog, and Settings. If what
the app stores ever changes, update that page in the same PR.

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
