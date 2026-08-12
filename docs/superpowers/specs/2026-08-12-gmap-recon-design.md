# GMAP-RECON — Google Maps company reconnaissance

**Status:** implemented and verified end-to-end against live Maps
**Date:** 2026-08-12

Harvest companies — name, address, phone, website, email, socials — from Google Maps
by keyword × place, into a resumable local store.

---

## 0. What this is NOT

`gmap-recon` is **not** eter-browser RECON (`src/recon.ts`). They share a word and
nothing else.

| | eter-browser RECON | gmap-recon |
|---|---|---|
| Target | authenticated business SaaS (ERP, admin panels) | public Google Maps search |
| Purpose | map an app's DOM so automations can be written against it | gather intel *on companies* |
| Output | `SITE.md` brief for an author | rows of leads in a database |

**`google.com` stays hard-blocked in `src/recon.ts` `BLOCKED_DOMAINS`, permanently.**
That file is not modified, not imported, and not exempted. Its own comment reads
*"Not overridable by flag, by design."* gmap-recon does its own discovery inside its
own boundary, via throwaway scratchpad scripts during authoring.

---

## 1. Proven measurements

A discovery probe ran on 2026-08-12 — one search (`solar panel installer Petaling
Jaya`) plus one detail click, logged out, throwaway profile. Everything below is
measured, not assumed.

| Measurement | Result |
|---|---|
| Bot challenge (captcha / `/sorry/` / consent) | **none** |
| Feed ready | **1,200 ms** |
| Results before plateau | **102** (curve: 10→20→30→40→42→52→62→72→82→92→102, flat) |
| `end_of_list_sentinel` present | **false** — plateau, not a confirmed end |
| Cards exposing a phone number | **3 / 3** |
| Cards exposing a website URL | **3 / 3** |
| Detail-panel fields | `address`, `authority`, `phone:tel:…`, `oloc` |

**The decisive finding:** phone and website are readable from the search feed. A
100-search campaign therefore costs **~100 Google requests, not ~6,000**. Detail
clicks are a 60× traffic multiplier and are not used.

### 1.1 The silent throttle

Chasing the unconfirmed 102 turned up the most important finding in this document.
Three runs of the *same query*, minutes apart, same IP:

| Run | Profile | Results |
|---|---|---|
| 1 | fresh | 102 |
| 2 | the profile from run 1 | **64** |
| 3 | a brand-new fresh profile | 101 |

A profile that has already searched gets ~37% fewer results. A fresh one does not, on
the same network at the same moment — so this is **per-profile cookie state, not an
IP rate limit**.

There is no captcha, no error, and no empty feed. Just fewer businesses. A scraper
would record `found: 64`, mark the town done, and silently lose a third of the leads —
the exact "proxy signal that fails toward *fine*" the rules catalogue is built around.

Two consequences, both implemented:

1. **`hit_cap` cannot stand alone.** A throttled profile plateaus early and is
   indistinguishable from a saturated town. A **canary** re-search of a known query
   with a recorded baseline is what separates them; below 75% of baseline the harvest
   halts and banks nothing.
2. **gmap-recon runs in its own disposable Chrome** (`gmaprecon` profile), never the
   agent profile — so the degradation lands on an identity nothing else depends on.

Profile rotation to *defeat* the throttle is deliberately not built. Detecting it and
backing off is the honest response; rotating identities to evade a rate control is a
different thing and would need to be asked for explicitly.

### 1.2 End-to-end result

`npm run build && node test/gmaprecon-e2e.mjs`, one search, fresh profile:

```
114 businesses stored (82-114 found per run, deduped by place_id)
111/114 phone     114/114 website     112/114 coordinates
enrich 6/6 resolved, 4 emails — all on the business's own domain
ALL CHECKS PASSED
```

---

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Data source | Scrape the Maps UI with patchright | Free, uncapped, reuses `BrowserManager` |
| Contact depth | Phone + email + socials | Phone feed-side; email/socials from the business website |
| Region coverage | Named sub-places the user supplies | Debuggable; `hit_cap` flags gaps |
| Storage | `node:sqlite` + CSV export | Zero new dependencies (repo runs on 3) |
| Address | Truncated fragment + exact lat/lng | Feed truncates before city/postcode; coords are free and exact. Geocoding stays possible later — the data is stored |
| Auth | **Logged out** | Probe confirms full data anonymously. A flagged account is a worse loss than a throttled IP |

---

## 3. Architecture

```
src/gmaprecon.ts            page functions — all Maps DOM lives here
src/leads.ts                node:sqlite store — queue + dedup
src/service.ts              +5 thin methods (same 3-line shape as waListChats)
src/automations/gmaprecon/  plan.ts harvest.ts enrich.ts status.ts export.ts

src/recon.ts                UNTOUCHED
```

Borrows the repo's *patterns* — `page.evaluate(FN, args)` as in `READ_CHATS`,
`waitForFunction` readiness as in `waitForApp`, the frontmatter card, the
`BrowserManager.run()` handoff — and none of RECON's code.

### 3.1 The store is the queue

The daemon is one-shot request→response with no job model (`src/cli.ts`), and a full
campaign runs for hours. Rather than add a job runner, every automation does a
**bounded chunk** and all state lives on disk:

| id | effect | does |
|---|---|---|
| `gmaprecon_plan` | write | Expands keywords × places into `searches` as pending. Instant. |
| `gmaprecon_harvest` | write | Runs up to N pending searches. Returns progress. |
| `gmaprecon_enrich` | write | Visits up to N un-enriched websites for email + socials. |
| `gmaprecon_status` | read | Counts by state; lists places that hit the ceiling. |
| `gmaprecon_export` | read | CSV. |

Resume is free — a crash costs one chunk. The agent calls `harvest` until `status`
reports zero pending.

---

## 4. Schema

```sql
CREATE TABLE searches (
  id         TEXT PRIMARY KEY,   -- hash(keyword|place)
  keyword    TEXT NOT NULL,
  place      TEXT NOT NULL,
  status     TEXT NOT NULL,      -- pending | done | failed | blocked
  found      INTEGER,
  hit_cap    INTEGER,            -- 1 = result count plateaued; this place needs splitting
  ran_at     TEXT,
  error      TEXT
);

CREATE TABLE businesses (
  place_id      TEXT PRIMARY KEY,  -- from the /maps/place/ href, stable across searches
  name          TEXT NOT NULL,
  address       TEXT,              -- truncated feed fragment, no city/postcode
  lat           REAL,
  lng           REAL,              -- exact, from the href
  phone         TEXT,
  website       TEXT,
  category      TEXT,
  rating        REAL,
  reviews       INTEGER,
  hours         TEXT,
  maps_url      TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  -- stage 2
  enrich_status TEXT NOT NULL DEFAULT 'pending',  -- pending | done | no_website | failed
  enrich_at     TEXT,
  enrich_error  TEXT,
  email         TEXT,
  emails        TEXT,              -- JSON array of all found
  facebook      TEXT,
  instagram     TEXT,
  whatsapp      TEXT,
  linkedin      TEXT
);

CREATE TABLE hits (                -- provenance
  search_id TEXT NOT NULL,
  place_id  TEXT NOT NULL,
  rank      INTEGER,
  PRIMARY KEY (search_id, place_id)
);
```

`hits` survives the merge: once two keywords surface the same company you still know
which keyword and which town found it — the signal that tells you which keywords earn
their runtime.

`hit_cap` is the coverage check on the named-places approach. A search that plateaus
means that town is saturated and businesses are being missed; `gmaprecon_status`
lists them, you split the town and re-plan. Quadtree coverage without a quadtree.

---

## 5. Extraction map

Derived from real probe output, not guessed.

```
feed        div[role="feed"]
cards       div[role="feed"] > div   filtered to those containing a[href*="/maps/place/"]

name        the place link's aria-label            → "buySolar | Solar Panel Malaysia Marketplace"
lat/lng     href match /!3d(-?[\d.]+)!4d(-?[\d.]+)/ → 3.1035568, 101.6400886
place_id    href match /!1s(0x[0-9a-f]+:0x[0-9a-f]+)/, fallback /!16s(%2F[gm]%2F\w+)/
website     card a[href] excluding /maps/ and #    → "https://www.buysolar.my/"

card innerText lines:
  rating    line matching /^\d\.\d$/                → 4.8
  cat+addr  line containing ' · '                   → "Solar energy company · Level 26, Pinnacle PJ Tower A…"
            split on first ' · ' → category, address fragment
  phone     line matching /(?:\+?6?0)\d[\d\s-]{6,}\d/ → from "Open · Closes 5:30 pm · 019-207 4988"
  hours     same line, the "Open · Closes …" portion
```

**Rating and reviews — resolved, after two wrong guesses.** They share ONE aria-label
and the visible line concatenates them with no separator:

```
aria-label:  "4.7 stars 14 Reviews"
card line:   "4.7(14)"
```

Reading a bare number off either puts the *rating* in the reviews column — the first
build shipped 26 businesses claiming "5 reviews" when they meant 5.0 stars, and only
20 of 77 rows had a rating at all. Parse the pair together, never separately:

```
/([\d.]+)\s*stars?\s+([\d,]+)\s*review/i     on the aria-label
/^(\d(?:\.\d)?)\(([\d,]+)\)$/                fallback on the line
```

After the fix: 74/77 rows carry both, no rating above 5.

**Email false positives.** Site HTML carries platform addresses from widgets and
embeds — a live run pulled `press@google.com` off a solar installer. Emails are
filtered against a platform denylist, and addresses on the business's *own* domain
sort first and win the primary `email` field.

### Readiness

Wait on the **data's shape**, never a timeout (rules #13/#14):

```js
page.waitForFunction(
  ([f, l]) => (document.querySelector(f)?.querySelectorAll(l).length ?? 0) > 0,
  ['div[role="feed"]', 'a[href*="/maps/place/"]'],
  { timeout: 45_000, polling: 250 },
)
```

Measured at 1,200 ms. An empty feed is **never** a readiness condition (rule #15) —
during a soft-block it is indistinguishable from a town with no matches, and writing
`found: 0` would silently corrupt the dataset.

---

## 6. Bot-detection posture

### Fingerprint — inherited, not modified

`src/browser.ts` already lands this correctly and gmap-recon adds **zero** stealth
tricks (rule #18 — start from the known-good config):

- `channel: 'chrome'` — real Chrome, not bundled Chromium
- `headless: false` — README: *"Headless is the single biggest tell"*
- `viewport: null`, `ignoreDefaultArgs: ['--enable-automation']`
- patchright removes the `Runtime.enable` CDP leak
- persistent profile — a returning profile beats a fresh one every run
- `PERF_ARGS` audited clean: no `--no-sandbox`, no `--disable-blink-features`,
  no `--disable-web-security`, no `--disable-gpu`

### Rate — the actual control

Google does not captcha a weird `navigator` property; it captchas 200 searches an
hour from one IP. A `SearchLimiter` in `src/gmaprecon.ts` mirrors the persisted
sliding-window shape of `src/sendlimit.ts` (which survives daemon restarts precisely
because an in-memory counter hands back a fresh budget on every boot):

```
searchesPerMinute  2
searchesPerHour    60
searchesPerDay     400
gap                15–40 s, jittered   -- a fixed interval is itself a bot signal
```

Stage 2 hits third-party servers, not Google — separate, more permissive budget: one
load per business, 10 s timeout, at most homepage + `/contact`, never concurrent
within a domain.

### Circuit breaker — detect and stop, never solve

Checked after every navigation, **before** extraction:

| Signal | Action |
|---|---|
| redirect to `/sorry/` or `/recaptcha/` | stop run, mark `blocked`, set cooldown, report |
| `consent.google.com` | stop, ask the human — never auto-accept |
| "unusual traffic" / "not a robot" in body | stop run |
| feed empty **and** no "no results" text | back off; do not record `found: 0` |

CAPTCHAs are never solved or bypassed. Beyond being out of scope, grinding a
soft-block is how a temporary throttle becomes a persistent one.

### Throughput

At 60 searches/hour: 5 keywords × 20 towns = 100 searches ≈ **1.7 h** for stage 1.
Enrichment of ~2,000 businesses ≈ 3 h, off Google entirely, unattended. This is an
overnight job. The rate limiter is the bottleneck by design.

---

## 7. What shipped

| File | Status |
|---|---|
| `src/leads.ts` | new — store, queue, dedup, canary baseline, CSV |
| `src/gmaprecon.ts` | new — page functions, `SearchLimiter`, challenge gates, enrichment |
| `src/vault.ts` | edited — `ensureProfile()` so gmap-recon owns its own Chrome |
| `src/service.ts` | edited — 5 lazy methods, shutdown cleanup |
| `src/automations/gmaprecon/*.ts` | new — 5 cards |
| `test/gmaprecon-e2e.mjs` | new — live end-to-end, 9 assertions |
| `src/recon.ts` | **untouched** — verified |

The e2e runs the **built** artifact in `dist/`, not the source. tsx compiles via
esbuild with `keepNames`, which injects a `__name` helper into any function it
touches — and a function handed to `page.evaluate()` is serialised into the browser
where that helper does not exist. tsc emits no such helper. Testing the source
therefore fails on a defect that does not exist in what ships.

### Usage

```
gmaprecon_plan    { keywords: [...], places: [...] }   → expand into pending work
gmaprecon_harvest { limit: 5 }                         → repeat until nothing pending
gmaprecon_enrich  { limit: 25 }                        → repeat until nothing pending
gmaprecon_status  {}                                   → counts, budget, saturated places
gmaprecon_export  { file, withPhoneOnly?, withEmailOnly? }
```

---

## 8. Open items

- **True result ceiling is unknowable per-run.** Yield depends on profile state
  (§1.1), so no single number is "the cap". `hit_cap` + canary is the practical
  answer; treat a plateau as *possibly* saturated, never as certainly complete.
- **Canary cost.** One extra search per `gmaprecon_harvest` call. At `limit=5` that
  is 20% overhead; raise the limit to amortise it.
- **Sponsored results are included.** Maps injects ads into the feed and they are
  kept — they are real businesses, but may sit outside the searched town.
- **Consent wall** never appeared across five live runs. If it shows up at volume the
  run stops and asks; it is not auto-accepted.
- **Enrichment hit rate** measured at 4/6 on one small sample — too small to trust.
  Expect lower at scale; many Malaysian SMBs run a Facebook page instead of a site.
- **Throttle recovery time is unmeasured.** Nobody has tested how long a degraded
  profile takes to return to full yield. That number sets the real sustainable pace
  and is the most valuable thing to measure next.
