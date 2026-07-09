# ChiLocal — the night decides itself

**The one job: kill indecision.** A couple three years into Chicago opens this
on a Friday at 6pm and in under a minute has *one concrete plan for tonight*:
where to go, why it fits, how to get there. Not a list. Never a list — a list
is the problem we're solving.

Live at **https://chilocal.omnia-house.com**.

---

## The loop

```
Surprise us ──────────────┐
Dial it in (vibe+dials) ──┤──▶ deciding (radar scan) ──▶ THE REVEAL ──▶ lock / reroll / veto
Decide together (2P) ─────┘        1.9s, on the map        one hero pick        └▶ Date #N logged
                                                           + 2 alternates            share card
```

- **Surprise us** — the hero interaction. One tap, one plan, dare you to say no.
- **Dial it in** — 6 vibes (dinner & drinks · dancing & late · something new ·
  a show · keep it chill · out in the air) + two dials (budget, distance).
  Weather, time, day, season are auto — never asked.
- **Decide together** — the differentiator. Pass-the-phone: each partner picks
  vibes + answers three this-or-thats (loud/quiet, cheap/big, close/adventure,
  classic/new) without seeing the other's answers. The engine maximizes the
  *minimum* happiness (a plan only wins if it works for both), then each
  partner holds one veto. Date-night roulette.
- **The reveal** — the map is the payoff, not the menu. The city scans while
  the engine thinks, then the camera dives to the pick: route draws from home
  base, pin drops, the neighborhood breathes in amber, its name floats in
  serif. The plan card gives the *why* in one honest sentence.
- **Lock it in** — "Date #14. It's decided." Directions deep-link, canvas
  share card (built-in distribution), and the night is logged.

## Explore — the book of the city (v3)

The second half of the product (header toggle: **Tonight / Explore**). The map
tilts into a 2.5D night diorama — every one of the 98 official neighborhoods
is extruded, lifts toward you on hover with its name on the plane, and glows
amber when selected, its verified venues appearing as lights on the raised
tile. The panel is the catalog: browse neighborhoods by venue count, filter by
vibe, search everything, read the editorial take per neighborhood, then per
venue. Explore always bridges back to the engine: **"⚡ Make it tonight's
plan"** adopts any browsed venue as the hero (with honest why-line + paired
second stop), and **"🎲 Surprise us — but here"** runs the full decision loop
confined to that neighborhood. Browse feeds decide; decide stays the product.

The map is a real instrument now: drag/scroll/pinch camera with Flat · 2.5D ·
3D presets; venue-weighted neighborhood labels rest on the map
(collision-culled per zoom, never clipped or under the panel); constant-size
venue dots grow name tags at deep zoom; and past hood-level zoom the detail
tier fades in automatically — major streets with arterial names, parks, water
(OSM, simplified, ~500 KB total gzipped ~120 KB) — under the Tonight route
too. CTA L lines in official colors stay a toggle.

**How the map stays glitch-free (v4 interaction core):** all zoom lives in
the SVG viewBox and the CSS 3D tilt is rotation-only; screen↔map math goes
through the computed transform matrix (inverted analytically), so
cursor-anchored zoom, pan-under-the-finger, and tap-to-place are exact under
any tilt. Interaction lives on an invisible, immobile **hit layer** — one
twin path per neighborhood — so a lifting tile can never slide out from
under the cursor (the old hover-flicker class of bug is structurally
impossible). Continuous camera motion is rAF-driven and suspends tile
transitions (`moving` class) so walls can't smear; hover is suppressed while
panning and re-derived when the camera rests; text selection is disabled on
map surfaces and globally while a pan is live (panel copy stays selectable).
The city is eight named color districts — North lakefront teal,
Northwest indigo, West violet, Bridgeport-band wine, Southwest sienna,
South-lakefront emerald, Far-South slate, downtown gold — and within a
district a greedy coloring over the adjacency graph hands every touching
pair of neighborhoods different shade steps, so no two neighbors ever
read as one blob. Venue density still adds brightness (the city's light
map), and hover/select brighten a hood in its own hue. Walls carry a
vertical gradient for the diorama read. Reduced-motion users get camera
jumps instead of flights.

**The view is yours (v4.2):** three basemap styles for the detail tier —
**Night** (CARTO dark), **Satellite** (Esri imagery, dimmed into the night
theme), or pure **Diorama** (no tiles) — plus overlays: CTA L lines with
all 144 stations, **Metra** commuter rail (OSM), and major streets.
Selecting a neighborhood now SPOTLIGHTS it: tight camera framing straight
into real-street zoom, everything else recedes. Tiles prefetch for the
camera's destination while it flies and the previous zoom level stays up
as a backdrop until the new one has loaded — no blank flash, no arrival
delay. **CTA knowledge:** every venue shows its nearest L station and
walk time ("🚇 California (Blue) · ~5 min walk"), from City of Chicago
open data. **Visitor mode** (🧳 chip) leans the engine toward the icons
and classics, with hotel-zone quick picks (Loop, River North, Gold Coast,
Streeterville, West Loop) for setting a downtown home base.

**The real-map tier (v4.1):** past neighborhood zoom the schematic hands
over to actual OSM cartography — CARTO dark raster tiles (streets,
buildings, names) fade in under the neighborhood layer, which thins to a
tinted overlay; zoom now goes deep enough to read a single block. Keyless,
attributed on-map ("© OpenStreetMap contributors © CARTO"). Every glow at
depth is layered vector strokes, never a CSS filter — filters rasterize in
user units and turn into blurry, glitching bands when magnified (same for
label drop-shadows and fixed-size text: labels keep a fixed font and
counter-scale via transform so glyphs never degrade). **📍 Find me** drops
the device position with its reported accuracy circle — the honest answer
to "how much should I trust this dot." A 4-second timeout on the weather
fetch means a hung API can never hold boot hostage.

**Round 4 — the night gets longer and the map gets honest (v4.3):**
Selecting a neighborhood now frames it **essentially full-screen** — the
camera commits to the place instead of hovering politely above it. The
Tonight **swoop line means something now**: it starts at a labeled home-base
dot ("⌂ Logan Square"), carries "~2.3 mi as the crow flies" at its midpoint,
and bows only gently — it's a distance diagram, not decoration. **Divvy**
joins the overlays (🚲 chip: all 2,000+ dock stations from the official GBFS
feed, a dusting at city scale, real markers when zoomed) and every
1–4-mile trip now shows a bike estimate next to the ride time. And the
**crawl builder**: any plan with a second stop offers "🍸 Make it a crawl" —
a third walkable stop (nightcap rules: ≤0.72 mi legs, late-open favored)
chained onto the night, drawn as a second hop on the map, logged whole,
and shared as one three-line card.

**Round 5 — the camera is fully yours (v4.4):** a new control cluster joins
Flat/2.5D/3D and the basemap picker: **zoom** steps (+/−, anchored on the
visible window) and **orientation** — rotate the whole diorama in 30° stops
with **N** snapping the compass home (persisted like tilt). Every label
counter-rotates in CSS so names stay upright at any bearing, and the
screen↔map math never special-cases it — it inverts whatever matrix the
CSS lands on, so hit-testing and exact-grab panning stay pixel-true
rotated. Three legibility fixes ride along: raster tiles are now chosen
**per device pixel** (a tile never paints above ~1.08× its native
resolution, so the street/neighborhood names baked into CARTO/Esri
bitmaps stay sharp on retina screens and at in-between zoom stops, where
they used to fuzz); venue name tags now sit ON their dots at every zoom
(the counter-scale used to pivot on the text's bbox center, an error that
grew with zoom until names floated ambiguously high); and city-view
neighborhood names dropped to 11.5px with wider collision padding — fewer,
calmer names when zoomed all the way out.

**Round 6 — boundaries a native can vouch for (v4.5):** the 98 neighborhood
polygons are rebuilt from the official City of Chicago export (y6yq-dbs2)
with topology-preserving simplification — shared borders are decomposed
into arcs, each arc is simplified ONCE, and every neighborhood is
reassembled from the same arcs, so neighbors stay stitched vertex-for-
vertex with zero slivers. Audited worst-case deviation from the official
line: **2 meters** on every one of the 98 (the old file was off by up to
126 m — 4.2 sq mi of the city sat in the wrong neighborhood; now 0.19).
Twelve landmark spot-checks (Willis Tower→Loop, Wrigley Field→Wrigleyville,
the Bean→Millenium Park, Midway→Garfield Ridge…) agree with the official
polygons exactly — including Wrigleyville, which lives inside a HOLE in
Lake View and now hit-tests correctly everywhere in the app. Beach venues
on lakefront parkland outside every official polygon snap to the nearest
boundary instead of orphaning. All of it at 36 KB gzipped and measurably
zero cost to pan/zoom frame times.

**Round 7 — deploys you can trust, zoom that goes to the block, and the
flag (v4.6):** every data file is now fetched with the same `?v=` cache-
buster as the code and `index.html` is served `no-cache` — a redeploy can
no longer be half-invisible behind a browser or CDN cache (the footer
carries a **build stamp** so "which build am I on?" has a two-second
answer). Max zoom deepened 2.5× — a ~500 m viewport that reads individual
buildings — with tile levels chosen per device pixel up to z19, the next
level pre-warmed into the HTTP cache just before each switch, and a levels
lift on CARTO's near-black deep tiles so block-level zoom reads like a lit
street instead of a void. Explore groups can no longer share a display
name (searching "the loop" lands on the real nine-spot Loop, not the
one-venue Grant Park group that borrowed the name). And the city's own
colors: the flag of Chicago (night edition) sits beside the wordmark, the
six-pointed star is the favicon and the PWA icon, four stars crown every
locked date, and the footer says where this thing was made.

**Round 8 — the fuzz-free zoom (v4.7):** continuous zoom must resample tile
bitmaps at fractional scales, which is why "certain zoom levels" looked
soft no matter how well the level was chosen. Two rules end it: tiles are
now never upscaled even mid-motion (level switches happen at exactly 1:1),
and when a zoom gesture settles over the real-map tier the camera eases
the last few percent so the tile level lands at **exactly one device pixel
per bitmap pixel** — free zoom while moving, pixel-perfect wherever you
stop (wheel, pinch, buttons, double-click all snap; deliberate camera
flights are left alone). The wordmark also slimmed down to Chi·Local.

**Round 9 — billboard labels (v5): the last blur, gone for good.** The
neighborhood and venue names were text INSIDE the scaled, tilted SVG —
and some engines rasterize that text once and stretch the bitmap, so
names were crisp at exactly one zoom and fuzzy at every other. Now every
name is an **HTML billboard in a layer above the map**: positioned each
frame through the same exact projection math (so they're glued to their
map anchors through pan, zoom, tilt, and rotation) but rendered at their
TRUE screen size — pixel-crisp in every browser at every zoom, by
construction. And because size is now just a number set per frame, names
**scale dynamically with the camera**: ~10 px at the full-city view,
growing along a soft power curve to ~26 px as you commit to a place,
with far-edge labels sized down by the perspective. Labels stay upright
at any map rotation for free — billboards don't rotate.

**Round 10 — make it yours (v5.1):** a ⚙ **settings** dialog (header) opens
the night for play: recolor the three accents (route light, star, sky blue)
with live pickers, repaint the whole map under four district palettes
(Classic · Neon · Ember · Steel — the eight families hue-shift together,
neighbor-contrast guarantees intact), and pick a name size (A− / A / A+).
Everything applies live and persists on-device; one button resets to
ChiLocal night. The **browse panel folds away** (⟩ tab on its edge) so the
map gets the whole stage — the camera reframes for the full window and
remembers your choice. The **camera cluster moved to the bottom-right**
like every map you've ever used, riding the panel fold. And camera flights
now **arrive pixel-true**: select/reveal targets nudge up to ±16% (never
enough to crop the framing) so the tiles land at exactly one device pixel
per bitmap pixel instead of a slightly-soft in-between scale.

**Round 13 — people can join (v6):** real accounts, done the boring-secure
way: email + password signup and login (scrypt-hashed, per-user salts,
never stored readable), server-side sessions in HttpOnly SameSite cookies
(only a hash of the token touches disk), per-IP rate limiting, and generic
error copy that doesn't leak which emails exist. Storage is SQLite **on
Jacob's own box** via Node's built-in driver — the companion server stays
zero-dependency and nobody's identity leaves the building. The UI: an
**avatar in the top right** (your initial once you're in), with a dropdown
for Sign in / join, **Settings**, and Log out; the join dialog is one name,
one email, one password. Sessions persist for 30 days, rolling. Next step
when wanted: sync the personal layer (nights, wishlist, home base) to the
account so it follows you across devices.

**Round 14 — members only (v6.1):** the entire site now lives behind the
login. Enforcement is real, not cosmetic: nginx checks every request for
the app, its code, and its data against the session (`auth_request` to
the companion API) and bounces strangers to a self-contained gate page —
night-styled, flag up top, sign-in and open signup side by side. Gated
responses are `private` so no CDN can leak them. In the app, the same
gate renders client-side (dev + defense in depth); logging out lands you
back at the door, signing in lands you on the normal homepage. Signup
stays open — the door has a bell, not a bouncer.

**The companion server (optional, `server/`):** a zero-dependency Node
container that the static site quietly probes at boot — unreachable means
every feature below simply stays hidden. With it: **live CTA arrivals** on
any venue near an L stop ("live at California: Blue → O'Hare: 4 min, 12
min" — proxied CTA Train Tracker, key server-side only), an **events
layer** (Ticketmaster Discovery matched to our venues by name+coords; a
match becomes "🎫 tonight here", a scoring boost, and a citable why-line —
never shown for venues we can't place), and **two-phone mode**: "Decide
together" now offers one phone or two — the host gets a 4-letter room
code, both partners pick blind on their own phones, the reveal lands on
the host's screen while the guest gets the plan summary and holds the
veto for real. Rooms are in-memory, 2-hour TTL, no accounts.

**The personal layer:** ♡ wishlist anywhere; "✓ been here" from any profile
(feeds the engine's novelty memory); **add your own places** (pin-on-map
picker, on-device, `◆ yours`, instantly pickable) with **"Suggest to
ChiLocal"** opening a prefilled GitHub issue — the review gate into the
curated book (verify via OSM/city license → seed → pipeline). "🎲 Surprise us
from our list" runs the engine over saved + your own places only. History
("our nights") keeps the locked date log, the last 20 generated plans (each
shareable), and every entry links back to its venue profile.

## Where the effort went: pick quality

A generic pick kills the product, so the picks are defended three ways:

1. **Verified existence.** All 179 venues passed through
   `scripts/build-venues.mjs`: fuzzy-matched against OpenStreetMap (Overpass)
   with neighborhood-proximity disambiguation, falling back to *active* City
   of Chicago business licenses. Anything unverifiable was dropped — the
   pipeline caught six places my own curation "knew" were open that are
   actually closed or replaced (The Violet Hour, Hüttenbar → now Lincoln
   Square Taproom, Lost Lake, the Signature Room, Seven Ten Lanes, Tack Room).
2. **Structured opinion.** Every venue carries an original one-line take,
   vibe tags, an energy rating (1 hushed – 5 rowdy), a price tier (shown as
   `$$` — an estimate), seasonal fit (rooftops in July, glasshouses in
   February), best-for tags, and an institution flag. The opinion layer is
   ours; no scraped reviews, no lifted copy.
3. **Context-aware scoring.** Hard filters first (season, budget cap,
   distance from home base, *parsed OSM hours* including overnight spans,
   been-there-recently, tonight's vetoes), then weighted scoring: vibe match,
   weather fit (94° → A/C or after-dark patios; 12° and snowing → warm, close,
   open late), time-of-night, novelty + neighborhood habits, institution
   prior, party fit, plus seeded per-night jitter so a reroll feels
   intentional. Dinner anchors get a second stop paired within a short walk.

**Honesty rails:** hours display only when OSM has them ("Listed open till
2 AM — double-check ↗"), otherwise "Hours unverified — check before you go ↗".
Prices are marked as estimates. The murals walk is labeled
"location approximate". The why-line only cites factors that actually scored.
Every reveal also carries a collapsible **"What could go wrong"** section
built only from claims the data supports: unverified hours (hero or second
stop), rain probability vs outdoor-only picks, weather-fetch failure
disclosure, long hauls from home base. Alternates are labeled by how they
differ (different neighborhood / cheaper / closer / calmer / the classic /
the wildcard) — never presented as interchangeable clones. And the whole
engine can be interrogated: **`?debug=1`** shows the top-10 leaderboard with
scores, reason codes, hours-verified flags, and per-filter drop counts under
the alternates.

**Explore filters + passport:** beyond vibes, the catalog filters by budget
ceiling and a verified-hours-only "Open now" toggle (with honest microcopy
about what it can't know); the venue lights on a selected tile always mirror
the filtered list. A **neighborhood passport** ("7 of 98 neighborhoods
lived") tracks the date log + been-theres and offers "stamp somewhere new" —
a jump to a venue-rich neighborhood you haven't touched.

## Memory (the repeat-use engine)

localStorage, no accounts: home base, the date log ("Date #14"), been-there
counts (the engine won't repeat your last 8 locked picks), a wishlist (saved
spots get boosted), and habit nudges — "You always end up in Logan Square
(6×). **Ban it for tonight?**"

## Design language

Night navy city, warm light: Chicago-flag palette shifted after dark (amber
route light, coral star pin, cooled sky blue), Georgia italic as the editorial
voice, a custom no-tile SVG map of the official 98 neighborhoods, starfield
atmosphere. Crisp at every zoom by construction — vector-stroke glows,
fixed-font counter-scaled labels, and real map tiles at depth (see the
interaction-core notes above); no raster scaling anywhere. Installable as
a PWA. No frameworks, no webfonts, no build step — vanilla ES modules
served by the same nginx image as before.

## Data & attribution

- **Facts** (coordinates, names, addresses, websites, opening hours,
  cash-only/patio tips): © OpenStreetMap contributors, ODbL — via Overpass
  API; plus City of Chicago open data (business licenses, boundaries).
- **Weather**: Open-Meteo (keyless, client-side, 30-min cache, graceful
  degradation to season defaults).
- **Opinions** (takes, vibes, tiers): ChiLocal's own, in
  `scripts/seed-venues.json`.
- Refresh cycle: `scripts/overpass-query.txt` → Overpass →
  `node scripts/build-venues.mjs <dump> [licenses]` → commit `venues.json`.
  Cached source dumps live in `scripts/cache/`.

## Roadmap (in order)

1. ~~Two-phone mode~~ · ~~events layer~~ · ~~live CTA arrivals~~ — **built**
   (v4.3, companion server). Activation needs: deploy `chilocal-api` on
   Unraid, add the `/api` proxy route, and set the free `CTA_TRAIN_KEY` +
   `TM_KEY` env vars (see `DEPLOY.md`).
2. **Hours coverage** — 61/179 venues have OSM-verified hours; the pipeline
   now emits `scripts/hours-wanted.md` (114 venues, direct OSM edit links).
   Growing this means contributing hours upstream — never guessing.
3. **Get-in-tonight actions** — dinner picks carry a keyless "find a table ↗"
   OpenTable deep link (search, not availability — honest). The real
   version — live availability (Resy/OpenTable/Tock APIs) — needs partner
   API access → Jacob's call.
4. **Stay in, done right** — the funnel's "In" branch is a teaser by design
   (scope discipline). v2: cook-something tied to what's fresh (Green City
   Market calendar), movie roulette, board-game picks, order-in cuisine wheel.
5. **Live data layer** — swap `venues.json` for the `/api` contract in
   `API.md` backed by the existing Next.js + PostGIS stack; nightly
   license-liveness re-checks; venue photos (owner-provided or licensed only).
6. **CTA trip hints** — "3 stops on the Blue Line" via CTA open GTFS (the
   arrivals proxy is live; routing is the next step).

## Dev

```bash
cd site && python3 -m http.server 8811     # http://localhost:8811
node scripts/build-venues.mjs scripts/cache/osm-merged.json scripts/cache/chi-licenses.json
```
Deploy: push to `main` → GitHub Actions → ghcr.io image → Unraid pulls
`chilocal-map` (force update). The Docker/nginx pipeline is untouched.
