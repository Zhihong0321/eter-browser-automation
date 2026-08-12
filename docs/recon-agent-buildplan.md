# RECON-AGENT — build plan & handoff

**Updated:** 2026-08-12
**Design spec:** `docs/superpowers/specs/2026-08-12-recon-api-first-design.md` — read it for *why*; this file is *what to do next*.
**Original spec:** `docs/superpowers/specs/2026-08-12-recon-agent-design.md` — its constraints all still hold.
**Measured tool evidence:** `docs/monolith-spike-findings.md`
**Parallel track:** `docs/api-endpoint-request.md` — the endpoint ask for the atap dev team

---

## 1. What this is

A tool for the **authoring** half of `docs/two-mode-agent-design.md`. It scans an authenticated business SaaS once, so that writing an automation for it becomes a single round-trip instead of an explore-guess-fail loop.

**As of 2026-08-12 the target changed: automations should work at the API level, not the UI level.** Recon's job is now to tell you, per job, which of two paths exists and hand you everything needed to write that code:

- **Path A (reads)** — the site's internal API: endpoint, params, response shape, and proof it matches what the screen showed
- **Path B (fallback)** — the DOM: the original product, for routes with no API
- **Writes: always Path B**

Its real product is still the thing `E:\eter-browser\tools\INDEX.md` contains today: routes, timings and **traps** — code that looks correct, runs without error, and returns a confident wrong number. Every line of INDEX.md was paid for with a burnt run.

**Scope:** cloud ERP, admin panels, back-office dashboards. Social/messaging/bot-detection sites are hard-blocked and not overridable.

---

## 2. Status

```
1. SCAN      ✅ DONE, verified live  — reconciliation (§8 Part 1) ✅ DONE, verified live
2. CAPTURE   ✅ DONE, verified BY OPENING THE FILES — 17/17 routes, 2 stylesheets
                each, re-run 2026-08-12 17:04 under the corrected CSP. (§8 Part 2)
3. BIND      ✗  the visual planner: snapshot + XHR list -> business meaning
4. SITE.md   ✗  API-first brief the authoring agent reads
```

`scan.json` is produced and complete. monolith is installed and its behaviour on this
machine is measured. Nothing renders yet, and human notes have nowhere to live.

### Two tracks run in parallel — decided 2026-08-12

**Track A — widen the API surface (has lead time, start it first).** atap's API is real but
thin: 1 `application/json` response across 4 probed routes, and `/payments` has none (§10).
`/api-doc` carries a **"Need More Endpoints?"** invitation, and this is the user's own
company's ERP — so where the API doesn't reach, *requesting* an endpoint beats
reverse-engineering a table. Draft is written: `docs/api-endpoint-request.md`.

> **BLOCKED on one answer from the user:** §5 of that document assumes payments reads are
> the priority, because that is what is automated today. The list of jobs actually worth
> automating cannot be derived from the repo — it must be asked. Do not send the request
> or cut its P1 section until that answer exists.

**Track B — build recon (independent, proceed now).** Nothing in Part 1's reconciliation
work depends on Track A. Build it against `GET /api/engineering-v2`, which exists today;
every endpoint that later ships from Track A is then trustworthy on arrival rather than
needing new verification machinery.

**Next code step:** one scan run to regenerate the snapshots under the corrected CSP
(§8 Part 2, "Unfinished"), then Part 3 BIND. Part 1 reconciliation is done and verified
live — it caught a real disagreement on the first endpoint it was pointed at (§8 Part 1).

---

## 3. What exists

| File | Role |
|---|---|
| `src/recon.ts` | settle detection + **pure** trap analyzer, blocklist, challenge detection, PII mask guard |
| `src/recon-net.ts` | XHR capture, JSON shape extraction, API replay probe — **now the centrepiece** |
| `src/recon-dom.ts` | element inventory, table shape, nav-link discovery, **pure** click policy |
| `src/recon-capture.ts` | monolith snapshot per route, **pure** CSP rewrite + file naming |
| `src/recon-scan.ts` | crawl orchestration, tab exploration, `scan.json` writer, terminal report |
| `src/fastworker.ts` | optional small-model helper — **not used by the scanner** |
| `test/recon.settle.test.ts` | 18 tests — trap rules, masking, blocklist |
| `test/recon.policy.test.ts` | 13 tests — click policy, url patterns, endpoint ranking |
| `test/recon.reconcile.test.ts` | 10 tests — api-vs-screen row reconciliation, the `unknown` refusal |
| `test/recon.capture.test.ts` | 7 tests — CSP rewrite, snapshot file naming |

Wired into `src/api.ts` (2 routes), `src/cli.ts` (2 verbs), `src/service.ts` (`reconProbe`, `reconScan`). **No MCP tool** — deliberate, see spec §3.

Output lands in `<vault.home>/tools/<domain>/recon/`, i.e. `E:\eter-browser\tools\admin.atap.solar\recon\`.

---

## 4. Run it

```bash
npm run build
npx tsx --test test/*.test.ts          # 47 recon tests, all must pass

node dist/cli.js recon probe "https://admin.atap.solar/payments"
node dist/cli.js recon scan  "https://admin.atap.solar/" --max-pages 40
node dist/cli.js recon scan  "https://admin.atap.solar/payments" --max-pages 0 \
  --approve "Pending Verification,Verified Payments,Fully Paid Invoices,Update Method,EPP Costs"
```

**Measured:** 13 pages in 75s. Single page ~3s (adaptive window exits when the page goes quiet).

---

## 5. Environment gotchas — read before debugging anything

These cost the most time. All are environment, not code.

### The daemon must be started DETACHED

A daemon started from a background shell gets torn down when that shell ends, and the failure looks like "daemon is not running" mid-command. Use:

```bash
powershell -NoProfile -Command "Start-Process -FilePath 'node' -ArgumentList 'dist/cli.js','ui','--no-open' -WorkingDirectory 'E:\001-browser-use-v2' -WindowStyle Hidden"
```

Then poll `http://127.0.0.1:7676/health` until it answers.

### `Opening in existing browser session`

One user-data-dir = one Chrome. Something on this machine respawns Chrome on the agent profile, so clearing and *then* running as separate steps loses the race. **Do both in one command:**

```bash
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { \$_.CommandLine -like '*eter-browser\profiles\agent*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }; Start-Sleep -Seconds 5" && node dist/cli.js recon scan ...
```

Never debug the script when you see this error — clear and re-run (`INDEX.md:18`).

### A scan must run THROUGH the daemon — never in a standalone script

Something on this machine restarts the daemon roughly every 20 seconds when it is not
running, and the restarted daemon takes the agent Chrome profile. A scan driven from a
standalone `node` script therefore dies at **~60 seconds** with:

```
page.goto: Target page, context or browser has been closed
```

Measured twice, dying at *different routes* (4 and 8) at the same elapsed time — which is
what identifies it as eviction rather than a bad route. The same scan through the daemon
completed 17 routes in 2m11s. Standalone patchright is right for one-shot probes; a
multi-minute crawl is not one.

### `Eter Browser daemon is not running` is often a LIE

`daemon()` in `src/cli.ts` wraps `fetch` in `catch {}` and prints that message for **every**
failure, including a timeout on a healthy daemon. A full scan with snapshots outlives
Node's default fetch timeout, so `recon scan` reports a dead daemon while the daemon is up
and the scan is still running. Confirm with `/health` before believing it, or drive the
scan with a long-timeout HTTP call:

```powershell
Invoke-WebRequest -Uri 'http://127.0.0.1:7676/api/recon/scan' -Method POST `
  -ContentType 'application/json' -TimeoutSec 1200 `
  -Body '{"url":"https://admin.atap.solar/","windowMs":8000,"maxPages":40,"approved":[]}'
```

### The repo is edited by something else WHILE you work

`src/api.ts` changed on disk mid-session (16:00) without this session touching it. Before
that edit landed, a stray `GET //` request killed the daemon on every scan
(`ERR_INVALID_URL`, uncaught in an async handler). If the daemon dies for no reason you can
attribute, **compare `src/*.ts` mtimes against `dist/`** and rebuild before debugging.

### Rebuild + restart after every source change

The daemon serves `dist/`. `npm run build`, kill daemon, kill Chrome, restart detached. There is no hot reload.

### monolith: install from winget, never cargo

`cargo install monolith` fails on this machine — it vendor-builds OpenSSL, which needs a
native Windows perl, and the `perl` on PATH is Git Bash's MSYS perl. Use:

```bash
winget install --id Y2Z.Monolith --exact --silent --accept-package-agreements
```

The binary is at `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Y2Z.Monolith_*\monolith.exe`.
The `WinGet\Links\monolith.exe` shim only resolves in a fresh shell — call the real path.

---

## 6. Hard-won findings — do not re-litigate these

**`addInitScript` silently does nothing under patchright.** No throw, scripts never run. Verified with an isolated diagnostic. Patchright removes `Page.addScriptToEvaluateOnNewDocument` because it is an automation fingerprint. The observer therefore installs via `evaluate` right after `goto(waitUntil:'commit')`, costing a measured ~465ms blind window that is reported as `installedAt`.

**Do NOT route around it with `newCDPSession`.** That reintroduces the fingerprint on the profile that holds real logged-in Facebook/WhatsApp sessions. Measured: the `agent` profile carries **29 cookies across 9 domains**, including `.facebook.com`, `.web.whatsapp.com`, `.messenger.com`. A recon convenience does not outrank that.

**An empty trace is `mode: 'failed'`, never "clean".** The first live run reported "nothing unstable detected" when nothing had been watched at all. That is the fails-toward-fine pattern this whole feature exists to eliminate. There is a regression test.

**Row samples in `scan.json` are masked in-page.** The first live run returned real customer names and a phone number. Digits → `9`, letters → `x`, currency codes preserved (the wait pattern is derived from them). `isMaskedShape()` is a Node-side guard that drops anything unmasked. **Never remove it.** This guards `scan.json` only — snapshots are a separate artifact with separate rules (§7).

**XHR response *values* are never stored** — key names, array lengths and sizes only.

**`role="tab"` does not exist on admin.atap.solar.** The five payment states are plain `<button>`s, sitting beside `Delete Submission` and `Auto-Reconcile` — same role, same structure. No heuristic separates them. Measured button count on that route: **46**. This is why pass 1 refuses all buttons and the human approves, and it is the whole argument for making the planner visual (§8 Part 3).

**A comma-separated selector list only scopes its last item.** `` `${NAV_SEL} a[href]` `` matched `<nav>` elements themselves. Each part needs its own descendant clause. Cost a live run.

**Never `waitForLoadState('networkidle')`.** These apps poll; it never settles.

**`response.body()` has a lifetime** — throws for cached responses and after navigation. Read inside the handler, guarded, content-type filtered first.

**monolith `-o` panics on any absolute path containing `~`.** `C:\Users\ETERNA~1\...` — the 8.3 alias for `Eternalgy` — triggers naive tilde expansion and the parent resolves to nothing. **Always use `-o -` and let Node write the file.**

**monolith emits `script-src 'none'` whenever `-j` is passed**, with or without `-I`. Any overlay JavaScript injected into a snapshot **silently does not run** — no error, no console warning. The CSP meta must be rewritten before the file is written (§8 Part 2).

**The replacement CSP must allow `data:` in `style-src`.** monolith ships CSS as `<link rel="stylesheet" href="data:text/css;base64,…">`, not `<style>` — measured 2 links, 0 style blocks. `'unsafe-inline'` does not cover a `data:` URL, and the snapshot renders unstyled with no error. Found only by reading the captured file; the flag set and the byte counts all looked correct (§8 Part 2).

**A scan outside the daemon dies at ~60s.** The daemon is restarted by something on this machine and takes the Chrome profile with it. Symptom is `Target page, context or browser has been closed` at whatever route happens to be running (§5).

**Images and fonts are 99.5% of monolith's output weight.** Measured 26 MB → 126 KB with `-i -F`, layout fully intact. Non-negotiable if snapshots are to be stored and diffed.

**admin.atap.solar serves its CSS unauthenticated.** Capture was byte-identical with and without a cookie jar. `-C` is not needed here — and a bare `ctx.cookies()` export would have written all 29 cookies, including the Facebook and WhatsApp sessions, to a plaintext file. If `-C` is ever needed, filter to the target registrable domain first.

---

## 7. Artifacts and where they live

| Artifact | Home | Masked? | Repo-safe |
|---|---|---|---|
| `scan.json` | `<vault>/tools/<domain>/recon/` | **yes**, enforced | derived summaries only |
| `snapshots/<routeKey>.html` | `<vault>/tools/<domain>/recon/snapshots/` | **no** — real rows | **never** |
| `notes.json` | `<vault>/tools/<domain>/recon/` | n/a | never |
| `SITE.md` | repo | must not quote snapshot content verbatim | yes |

Live sample: `E:\eter-browser\tools\admin.atap.solar\recon\scan.json` — **17 routes, 0 failed**,
re-run 2026-08-12, so it is no longer the `/payments`-only file described in §10.

Snapshots: all 17 routes present in `…\recon\snapshots\`, 128 KB – 1.28 MB.
**They predate the `style-src data:` fix — regenerate before using them for Part 3.**

---

## 8. Next steps

### Part 1 addition — RECONCILIATION ✅ DONE 2026-08-12, verified live

The replay probe reports `replayable` + `replayNote`. That is not enough. An endpoint can
return `200 OK` with **200 rows when the screen showed 47**, because the UI applied a
filter client-side or via a query param that was not replayed. No error anywhere — a
confident wrong number through a brand-new door.

Add to each `xhr` entry in `src/recon-net.ts`:

```ts
matchesScreen:  'yes' | 'no' | 'unknown'
apiRowCount:    number | null
screenRowCount: number | null
```

**`unknown` is never treated as pass** — same rule as the empty-trace regression test.

*Done when:* a route with a replayable endpoint reports whether its row count agrees with
the rendered table, and a test covers the disagreeing case.

#### What shipped

- Three fields on every `XhrRecord`, stamped for **every** record — never left undefined.
- `reconcileRows(records, screenRowCounts)` — pure, in `src/recon-net.ts`. `screenRowCounts`
  is the route's main table first, then each explored tab state's table; agreement with any
  of them is agreement, and on disagreement the **closest** count is reported so the note
  reads "api 200 vs screen 65".
- `apiRowCount` prefers the **standalone replay's** count over the count the page received.
  That is the number an automation would actually get, and the two differing silently is
  the entire trap.
- A rendered count of **0 is discarded**, so `0 === 0` cannot manufacture a pass out of an
  empty table and a table that never rendered. Same reasoning as the empty-trace verdict.
- `isVerifiedRead(rec)` — the only gate an automation may be written against:
  `replayable === 'yes' && matchesScreen === 'yes'`, both compared explicitly. Writing
  `matchesScreen !== 'no'` would pass every unverified endpoint, which is the same shape of
  bug as `if (rec.replayable)` being truthy for `"not-json"` (§10).
- Wired into `scanPage`, reported by `formatScan` as `✓ / ✗ / ?` per endpoint.
- `test/recon.reconcile.test.ts` — 10 tests. Suite is now **40** (17 settle + 13 policy + 10).

#### Live result — it caught a real disagreement immediately

```
GET /api/engineering-v2?limit=200&minPct=0&maxPct=100
  status 200, application/json, 28 row keys
  replayable = yes        <- the old code stopped here and blessed it
  matchesScreen = no      api 200 rows vs screen 65 rows
  isVerifiedRead = false
```

`/engineering` renders 65 rows from RSC; the endpoint hands back 200. The `limit=200` in
the URL is not the screen's filter. **The endpoint is real, replayable, correctly shaped —
and returns the wrong set.** Exactly the failure this was built for, found on the first
endpoint it was pointed at.

Verification method, for repeating it: `/engineering` never calls the JSON API from the UI,
so a plain scan of that route stamps everything `unknown` (correct, and the live proof that
`unknown` does not pass). To exercise the JSON path, navigate the settled tab at the API URL
itself — `captureNetwork` records JSON *documents*, so the real capture → replay → reconcile
chain runs against a real response. Script kept out of the repo; ~30 lines, see this section.

### Part 2 — CAPTURE ⚠ BUILT 2026-08-12, run live once, ONE THING LEFT

One monolith snapshot per route, written to `<vault>/tools/<domain>/recon/snapshots/<routeKey>.html`.

Flags, all measured (`monolith-spike-findings.md`), unchanged:

```
-o -  -b <route URL>  -e  -j  -i  -F  -v  -a  -M  -q
```

`page.content()` from the settled page goes in on **stdin** (`monolith -`); monolith is
never pointed at the URL. Two reasons: the session lives in the browser profile and
monolith cannot authenticate, and re-fetching would freeze a *different* render than the
one this scan measured, inventoried and reconciled. Node captures stdout, rewrites the CSP
meta, and writes the file. No `-C`, no absolute `-o` path.

*Done when:* all atap routes have snapshots, each ~100–200 KB, opening correctly offline.

#### What shipped

- `src/recon-capture.ts` — `findMonolith()`, `snapshotFileName()`, `cspFor()`,
  `rewriteCsp()`, `captureSnapshot()`. The two pure ones are tested;
  `test/recon.capture.test.ts`, 7 tests. Recon suite is now **47**.
- Wired into `scanPage` via `ScanOptions.snapshotDir`, which `scanSite` sets to
  `<outDir>/snapshots`. `PageScan.snapshot` carries `{ file, bytes, nonce, error? }` and
  `formatScan` prints a line per route.
- **The capture is taken BEFORE the tab loop** — that is the state that was settled,
  inventoried and reconciled, and the tab clicks deliberately mutate it. Per-tab-state
  captures belong to Part 3's rescan, where the approved state is the unit being scanned.
- A failed capture is recorded, never thrown: a missing binary must not lose a finished
  scan. `findMonolith()` is checked once up front so it reads as one note, not 17 errors.
- The nonce is stored per snapshot — Part 3's overlay `<script>` must carry it.

#### Live result — 17/17 routes, 0 failed, 2m11s

Sizes ran **128 KB – 1.28 MB**, not the 100–200 KB the spike predicted; median ~200 KB.
`customer-service.html` is 1.28 MB and `db-inspector.html` 499 KB. Still fine for storing
and diffing, but the estimate was low.

`payments.html` against the live DOM: 1 `<table>`, 18 `<tr>`, 102 `<td>`, 48 `<button>` —
matches. Every `<script>` survives as an **empty tag** (`-j` stripped the bodies), 0
external `src`/`href`, exactly 1 CSP meta.

#### The "17/17, 0 failed" above was FALSE — and the check that produced it is now replaced

Read that line as: *monolith exited 0 seventeen times.* That was the entire success test —
binary found, exit code 0, stdout non-empty. Nothing opened a file. All 17 snapshots
rendered as unstyled text, and every cheaper signal agreed the capture was fine: bytes in
range, tag census matching the live DOM (`1 <table>, 18 <tr>, 48 <button>`), 0 errors.

**A done-criterion of "opening correctly offline" was never executed.** The status said
`⚠ one thing left`; the truth was that Part 2 had no passing evidence at all. This is the
same fails-toward-fine shape as the empty trace (§6) and a rendered row count of 0 (§8
Part 1) — the third time in this project the check could not observe its own failure mode.

Fixed 2026-08-12:

- `SnapshotRecord.styleSheets` — `document.styleSheets.length` after loading the written
  file in a real browser tab. `renderCheck` is injected into `captureSnapshot`, so
  `recon-capture.ts` stays browser-free; `countStyleSheets()` in `recon-scan.ts` supplies
  it, opening a **scratch tab** so the scan's own page is never navigated mid-measurement.
- **0 stylesheets is an error, never a pass.** A thrown render check records
  `styleSheets: null` + an error — unknown is not zero and not fine.
- `formatScan` prints the stylesheet count beside the byte count. Bytes alone are what
  reported 17 blank pages as a clean run.
- 3 regression tests against `finalizeSnapshot`. Recon suite is now **50**.

#### Live result after the fix — 17/17, 2 stylesheets each

Re-run 2026-08-12 17:04. Every route reports `sheets=2`, matching the measured
"2 stylesheet links, 0 style blocks". The CSP on disk now reads
`style-src 'unsafe-inline' data:`. Snapshots open styled and are usable as Part 3's
annotation surface.

#### The CSP in this document was WRONG — `style-src` needs `data:`

The string previously specified here was:

```
default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-<random>'
```

monolith does **not** inline CSS as `<style>`. It emits
`<link rel="stylesheet" href="data:text/css;charset=UTF-8;base64,…">` — measured on the
captured payments route: **2 stylesheet links, 0 style blocks**. `'unsafe-inline'` does not
cover a `data:` URL, so the browser blocks both stylesheets and the snapshot renders
completely unstyled, with no error. The annotation surface exists precisely so a human can
point at a *rendered* table instead of reading a flat list of 46 buttons — unstyled, it is
worth nothing. Same silent-failure shape as `script-src 'none'`, one layer down.

Correct policy, now emitted by `cspFor()`:

```
default-src 'none'; style-src 'unsafe-inline' data:; img-src data:; script-src 'nonce-<random>'
```

`monolith-spike-findings.md` §4 carries the same wrong string; a correction note is filed there.

### Part 3 — BIND (the visual planner)

The snapshot **is** the annotation surface. Served by the existing daemon at
`GET /recon/:domain`, one route at a time: frozen page on one side, that route's captured
XHR list on the other. Recon's overlay (admitted by the CSP nonce from Part 2) highlights
inventoried elements, colours refused controls, and anchors trap findings to the element
that was actually unstable.

The human points at a table, picks the endpoint that produced it, and types what it means:

```
"submitted payments" → GET /api/payments?status=pending → 47 rows ✓ matches screen
```

- `notes.json` beside `scan.json`; `POST /recon/:domain/note` writes it
- `POST /recon/:domain/rescan` re-runs one route honouring newly ticked approvals
- **The load-bearing rule: a scan must never overwrite `notes.json`.** Keyed `routeKey`
  and `routeKey::role::name`. A note whose element vanished is kept and shown as
  `orphaned` — never deleted. Endpoints and routes are re-derivable; *"the user's
  'submitted payment' means the Pending Verification rows"* is not.
- Clicking a refused control approves it; that list feeds `ScanOptions.approved`, already
  implemented and currently only reachable via `--approve`.
- Follow the existing dashboard's style; do not add a framework.

**Tab states need two passes.** A frozen page has no JS, so tabs do not switch when
clicked. The capture unit is *(route × approved tab state)*, not route — so Part 2 runs in
both passes of the refuse → approve → rescan loop.

*Done when:* typing a note, re-scanning, and seeing the note survive.

### Part 4 — SITE.md

`INDEX.md`'s proven shape, reordered API-first:

1. **Jobs** — Job / Path (`API`|`DOM`) / Endpoint or Route / Verified count
2. **API surface** — endpoint, method, params, response shape, reconciliation result
3. **Writes** — always DOM: selector, settle info, approval state
4. **DOM fallback** — only for routes with no API
5. **Traps** — machine-found first, then human notes
6. **Vocabulary** — the bindings from Part 3

Append a one-line pointer to `INDEX.md`.

*Done when:* an agent given only `SITE.md` writes a working payments script first try.

---

## 9. Do not

- add an MCP tool for recon (spec §3 — a per-new-site capability does not earn permanent prompt budget)
- use an LLM anywhere in the scan path; it is deterministic and free, and that is what makes it trustworthy
- auto-click `role=button` for any reason
- **replay non-GET, at all** — writes are driven through the UI, never replayed
- run recon headless (measurement fidelity + the profile is shared with sites that detect it)
- store raw row content or XHR response values in `scan.json`
- write snapshots into the repo, or quote their content verbatim in any repo artifact
- export a cookie jar without filtering it to the target registrable domain
- pass monolith an absolute `-o` path, or trust an injected overlay without rewriting the CSP

---

## 10. Open items

- **Auth for Path A.** Starting assumption: patchright's `context.request`, which shares
  the browser cookie jar — no new infrastructure, no expiry management, skips rendering.
  Keeps the one-Chrome-at-a-time cap, so the concurrency win is deferred. Exporting a
  session token to drop the browser entirely is a later optimization, worth doing only if
  parallel automations turn out to matter.
- **Uncommitted.** Everything above is in the working tree on `main`, nothing staged.
- **The repo is being modified outside this session** — `src/automations/`, `src/sendlimit.ts`, `src/mcp.ts`, `vault.ts`, `config.ts` all changed without this session touching them. Reconcile before committing.
- `.env` holds the fast-worker key, is gitignored, and was verified absent from every git-visible file. `.env.example` documents the vars.

### The atap API surface — measured live 2026-08-12

`admin.atap.solar` **does** have a real, documented JSON API. `/api-doc` is a genuine API
documentation page (headings: *API Documentation · Base URL · Status · Format ·
**Need More Endpoints?***) listing:

```
GET /api/v1/seda/status
GET /api/sync/invoice
GET /api/sync/invoice-items
```

Plus one found by probing that is **not** listed there:

```
GET /api/engineering-v2?limit=200&minPct=0&maxPct=100   ->  application/json, 200
```

**`/payments` genuinely has none.** All 18 of its captured responses are
`text/x-component` — RSC prefetches (`GET /route?_rsc=…`) and Server Actions
(`POST /payments`). Payment reads stay on Path B.

Measured ratio across four probed routes: 39 `text/x-component`, 4 `text/html`,
**1 `application/json`**. The surface is real but thin — so Path A coverage on this site
is currently narrow, and Part 1's reconciliation work matters more than endpoint discovery.

**"Need More Endpoints?" is the highest-leverage item here.** This is the user's own
company's ERP. Where the API doesn't reach, requesting an endpoint beats reverse-engineering
the DOM — that is a product decision, not an engineering one, and it should be raised
before more Path B work is scoped.

### Two traps when reading `scan.json`

1. **`replayable` is a string** — `"not-json"`, `"not-tried"`, etc. — **not a boolean.**
   `if (x.replayable)` is truthy for every value and will report every endpoint as
   replayable when in fact none are. This produced a false "18/18 replayable, including
   POSTs" reading during this session.
2. ~~**The on-disk `scan.json` covers `/payments` only.**~~ **Fixed 2026-08-12** — the full
   crawl was re-run and the file now holds **17 routes, 0 failed**. The hazard itself
   stands: any single-route scan overwrites it, so re-run the full crawl before drawing a
   site-wide conclusion. Nav discovery finds 16 routes plus the root, not 13.
