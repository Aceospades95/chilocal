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

## Memory (the repeat-use engine)

localStorage, no accounts: home base, the date log ("Date #14"), been-there
counts (the engine won't repeat your last 8 locked picks), a wishlist (saved
spots get boosted), and habit nudges — "You always end up in Logan Square
(6×). **Ban it for tonight?**"

## Design language

Night navy city, warm light: Chicago-flag palette shifted after dark (amber
route light, coral star pin, cooled sky blue), Georgia italic as the editorial
voice, a custom no-tile SVG map of the official 98 neighborhoods, starfield
atmosphere. The map renders **supersampled** (the layer is rasterized at 2×
and always minified, never stretched) so streets, boundaries, and label type
stay sharp mid-zoom, mid-tilt, on every screen. Installable as a PWA. No
frameworks, no webfonts, no build step — vanilla ES modules served by the
same nginx image as before.

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

1. **Get-in-tonight actions** — dinner picks now carry a keyless
   "find a table ↗" OpenTable deep link (search, not availability — honest).
   The real version — live availability (Resy/OpenTable/Tock APIs) and events
   (Do312 / Ticketmaster / Songkick) so "a show" can name the actual show —
   needs API keys → Jacob's call.
2. **Stay in, done right** — the funnel's "In" branch is a teaser by design
   (scope discipline). v2: cook-something tied to what's fresh (Green City
   Market calendar), movie roulette, board-game picks, order-in cuisine wheel.
3. **Live data layer** — swap `venues.json` for the `/api` contract in
   `API.md` backed by the existing Next.js + PostGIS stack; nightly
   license-liveness re-checks; venue photos (owner-provided or licensed only).
4. **Two-phone mode** — same roulette over a shared session code instead of
   pass-the-phone.
5. **CTA transit hints** — "3 stops on the Blue Line" via CTA open GTFS.

## Dev

```bash
cd site && python3 -m http.server 8811     # http://localhost:8811
node scripts/build-venues.mjs scripts/cache/osm-merged.json scripts/cache/chi-licenses.json
```
Deploy: push to `main` → GitHub Actions → ghcr.io image → Unraid pulls
`chilocal-map` (force update). The Docker/nginx pipeline is untouched.
