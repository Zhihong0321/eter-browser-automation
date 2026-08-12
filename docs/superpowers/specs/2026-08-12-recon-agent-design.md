# RECON-AGENT — design

**Date:** 2026-08-12
**Status:** approved design, not implemented
**Related:** `docs/two-mode-agent-design.md` (authoring vs. runtime), `AUTOMATION-PERF.md` (round-trip economics), `E:\eter-browser\tools\INDEX.md` (the artifact this generates)

---

## 1. The problem

Building a new site automation is slow, and the slowness is not where it looks.

`AUTOMATION-PERF.md` establishes that browser code is fast (~2.5s) and model round-trips are not (~5–8s each, 25–40s prompt-to-first-call). Authoring an automation today costs many of those round-trips: navigate, dump DOM, close, guess a selector, run, get a wrong answer, reopen, guess again.

Worse, the wrong answers are *confident*. Every trap in `INDEX.md` was discovered by shipping something that returned a plausible number:

- `table tbody tr` matches skeleton rows → five rows of `undefined` and a real-looking `RM 0.00`
- `Showing 0 results` is the loading state, not an empty table
- the Facebook timeline is virtualized, so one snapshot is never the whole list

Each of those cost a run. They are now written down by hand, one burnt run at a time.

RECON-AGENT does the discovery pass **once, in one launch**, and produces a written brief that the AI reads before writing any code. It is a tool for the *authoring* mode in `two-mode-agent-design.md`. It does not run automations; it makes writing them a single round-trip.

### What it is not

It does not make the AI understand the target application. It removes the fetch-and-guess loop and replaces it with one file read. Judgment about what is worth automating still comes from the human, via annotations. The payoff is proportional to how much the human writes on the map, not to how clever the scanner is.

---

## 2. Scope

**Target shape:** authenticated business SaaS — cloud ERP (AutoCount and the company ERP), admin panels, back-office dashboards. Dense nav trees, data grids, tabs, filters, JSON APIs behind the UI.

**Hard-blocked**, in three layers:

1. **Domain denylist**, refused before Chrome is touched: `whatsapp`, `messenger`, `facebook`, `instagram`, `threads`, `x.com`/`twitter`, `linkedin`, `tiktok`, `youtube`, `reddit`, Google properties.
2. **Vault `singleTab` flag** — any site enrolled as single-client is refused regardless of the list. WhatsApp Web permits one active web client; a crawler is structurally wrong there.
3. **Live abort** — a Cloudflare interstitial, captcha frame, or challenge redirect on first load stops the scan on page one and reports why. No retry, no fingerprint variation, no attempt to look human. Recon is not a tool for getting into places that do not want it.

The blocklist is checked in `recon.ts` before any browser call and is not overridable by flag.

---

## 3. Architecture

One new file, four small edits. Recon runs **through** the daemon's warm Chrome, reusing `BrowserManager` and `VaultService.requireReady()`. This sidesteps the one-user-data-dir-one-Chrome constraint entirely — no "stop the daemon first" step, and auth is already solved.

| File | Change |
|---|---|
| `src/recon.ts` | **new** — crawler, settle analyzer, XHR capture, SITE.md generator |
| `src/api.ts` | + `GET /recon/:domain`, `POST /recon/:domain/note`, `POST /recon/:domain/rescan` |
| `src/ui/` | + the map page |
| `src/cli.ts` | + `recon scan <url>`, `recon build <domain>` |

**No new MCP tools.** The scan is minutes long and stops mid-way for a human approval gate — the opposite of `AUTOMATION-PERF.md`'s one-call-one-finished-job shape, and the approval is a decision the AI structurally cannot make. And every MCP tool costs prompt context in *every* session forever, against a stated ceiling of ~30; a per-new-site capability does not earn that. Discovery rides the proven mechanism instead: `SITE.md` plus one pointer line in `INDEX.md`, which already opens with "READ THIS FIRST". If the AI demonstrably skips the brief in practice, `recon_site` is a ten-minute addition later — cheap to add, hard to un-add.

### Toolkit

`patchright@1.61.1` via the existing `BrowserManager`. Not a choice: one user-data-dir means one Chrome, so any separate driver dies with `Opening in existing browser session` (`INDEX.md:18`), and DPAPI-sealed cookies mean nothing outside that profile can authenticate (`INDEX.md:16`).

| Job | API | Verified in `patchright-core/types/types.d.ts` |
|---|---|---|
| nav + clicking | `getByRole` locators | — |
| element inventory | `ariaSnapshot()` | :2053, :13066 |
| XHR capture | `page.on('response')` | — |
| API replay | `context.request.get()` | `request: APIRequestContext` on `Page` :5268 and `BrowserContext` :9924 |
| escape hatch | `newCDPSession()` | present |

`page.accessibility.snapshot()` **does not exist** in 1.61 — zero hits for `Accessibility` in the type definitions. `ariaSnapshot()` is the replacement and the better fit: it returns a role/name tree, which is both the shape this spec wants and the shape that survives obfuscated classes.

### Three stages

```
recon scan <url>   →  crawl, write scan.json + shots/
(annotate in UI)   →  human writes tips/jobs → notes.json
recon build <dom>  →  merge scan.json + notes.json → SITE.md
```

`recon build` runs automatically after every note save, so `SITE.md` is always current.

---

## 4. Artifacts

`E:\eter-browser\tools\<domain>\recon\`

| File | Owner | Lifecycle |
|---|---|---|
| `scan.json` | machine | regenerated every scan, never hand-edited |
| `notes.json` | human | **never overwritten by a scan** |
| `SITE.md` | generated | rebuilt from the two above |
| `shots/<routeKey>.png` | machine | regenerated every scan |

### notes.json survives rescans

This is the load-bearing rule. The machine can re-derive routes, selectors and timings any time. It can never re-derive *"the user's 'submitted payment' means the Pending Verification rows."* That sentence is the expensive part.

Notes are therefore keyed by **stable identity**, not DOM position:

- page note key: `routeKey`
- element note key: `routeKey::role::accessibleName`

If a rescan cannot find an annotated element, the note is **kept** and surfaced on the map as `orphaned`, with the scan date it disappeared. An orphan is a signal that the app changed under you, which is itself worth seeing. Notes are never deleted by the machine.

```jsonc
{
  "version": 1,
  "pages":    { "<routeKey>": { "note": "...", "job": "...", "updatedAt": "..." } },
  "elements": { "<routeKey>::<role>::<name>": { "note": "...", "updatedAt": "..." } },
  "approvals":{ "<routeKey>::<role>::<name>": true },
  "orphans":  [ { "key": "...", "lastSeenScan": "..." } ]
}
```

---

## 5. Crawl policy

### Reach: the nav tree is one hop

Expanding a menu is not a jump. Every destination reachable from the navigation surface counts as depth 1; a row *inside* a grid is depth 2 and is not scanned.

```
Sales            ▾   expand — not a jump
  └ Invoice      ▾   expand — not a jump
      └ Invoice List    ◀ scanned
      └ Draft Invoices  ◀ scanned
```

Nav discovery uses the accessibility tree: `role=navigation` landmarks, `role=menubar`, `role=tree`, and lists inside `<nav>`/`<aside>`. Nodes with `aria-expanded="false"` are expanded (an allowlisted click) and their children collected, recursively, until no unexpanded nav nodes remain.

Recon reports the discovered page count and **asks before scanning if it exceeds 40**.

### SPA routes with no URL change

Many ERPs navigate without changing the URL. A route is therefore identified by:

```
routeKey = resolved URL if it differs from the parent, else navPath.join(" > ")
navPath  = ["Sales", "Invoice", "Invoice List"]
```

`navPath` is recorded for every page regardless, because it is the only reliable way an automation can *reach* a route on such an app. It goes into `SITE.md` as the "Reach" column.

### Click policy: allowlist by role, not denylist by name

A name-based denylist guesses. An ERP is dense with destructive controls whose names it would not catch — `Post`, `Void`, `Commit`, `Save & New`, `Confirm Journal`. So:

**Pass 1 clicks a control only if it matches the allowlist below.** Anything else — including every `role=button` that is not on this list, whatever it is called — is never clicked in pass 1.

| Allowed | Condition |
|---|---|
| `role=link` | inside a `navigation` / `menubar` / `tree` landmark, same-origin |
| nav disclosure toggle | any role, but carries `aria-expanded` **and** sits inside a nav landmark — this is what expands the menu tree |
| `role=tab` | unconditional |
| pagination control | `aria-label` matching `/next\|prev\|previous\|page \d+\|first\|last/i` |
| `role=combobox` / `role=radio` | filter controls only: **not** inside a `<form>`, and no submit control in the same region |

The combobox/radio row is the one judgement call in the list — a filter dropdown that silently belongs to a form would be a mutation. The `<form>`-ancestor and sibling-submit checks are both required, and anything failing either goes to the tick-to-approve list rather than being clicked.

#### Verified against the live site: the approval loop is not optional

A first full scan of admin.atap.solar found **zero elements with `role="tab"`** on `/payments` — the inventory is `{link: 19, button: 15, textbox: 1}`. The payment states this whole feature exists to reach are plain `<button>` elements.

And in the same refused list, alongside them: `Delete Submission`, `Auto-Reconcile`, `Re-scan Dates`, `Calculate EPP Cost`. **Identical role, identical structure, adjacent in the DOM.** No structural heuristic separates "Pending Verification" from "Delete Submission" — the only difference is meaning, which is exactly what a scanner cannot see.

So on real sites the tick-to-approve loop is not a safety nicety layered on top of an autonomous scanner. It *is* the mechanism by which tab states get reached at all. Pass 1 refuses all 15 buttons and reports them; the human approves the 5 that are really tabs; pass 2 explores those and returns `Pending Verification → 16 rows · Verified Payments → 50 · Fully Paid Invoices → 940 · Update Method → 35 · EPP Costs → 101`.

Had recon used a name denylist and auto-clicked what it didn't recognise as dangerous, it would have fired `Auto-Reconcile` on a live ERP.

Additional fences, all hard:

- never submit a form, never click `type=submit`
- downloads blocked at the context level
- same-origin only; a click that navigates off-origin aborts that page's exploration and is recorded
- any dialog is dismissed, never accepted
- a click that navigates to an unlisted URL aborts that page's exploration

Everything refused is recorded with its reason and rendered on the map with a checkbox. Ticking a control and hitting re-scan explores it on the next pass. Nothing risky fires without an explicit human tick.

---

## 6. Per-page capture

### 6.1 Settle curve

**Mechanism: an injected `MutationObserver`, not fixed-interval sampling.** The page keeps its own change log; one `evaluate()` reads it out at the end. Against fixed-timestamp polling this is 1 round-trip per page instead of 6, gives exact millisecond timing, and — the decisive reason — **catches transient states**. A skeleton that appears at 0.4s and is swapped at 0.55s is invisible to fixed sampling, and that is precisely the trap class this feature exists to find. A sampler can miss the very thing it is for.

The observer aggregates **in-page**. A `MutationObserver` on a busy ERP grid emits tens of thousands of records; storing them would blow up memory and the `evaluate()` payload. It buckets into 100ms windows, storing counts and a masked row sample, never raw records.

#### Installed via `evaluate` after commit, not `addInitScript` — verified

The obvious implementation is `addInitScript`, so the observer runs before any page script. **It does not work here.** Patchright is a stealth fork and silently drops init scripts — verified with an isolated diagnostic: `addInitScript` does not throw, and its scripts never run (`window.__diagPlain` → `MISSING` for plain, arg-passing, and timer-loop variants, while `evaluate` on the same page returns normally). The cause is that `Page.addScriptToEvaluateOnNewDocument` is a well-known automation fingerprint, so the fork removes it.

**Recon does not route around this via `newCDPSession`.** Reintroducing that CDP call would reintroduce the fingerprint on the shared profile that also holds real logged-in sessions. The entire value of this stack is a browser that does not look automated; a recon convenience does not outrank it.

So the observer installs via `evaluate` immediately after `goto(waitUntil: 'commit')`. The cost is a blind window between navigation start and install — **measured at ~465ms against admin.atap.solar, consistent across cold and warm runs**. It is recorded as `installedAt` and disclosed in the verdict, never assumed away. Consequence to keep in mind: a page that fully settles inside that window is invisible to recon, and the brief will say the observer installed late rather than claiming the page was clean.

**An empty trace is a FAILED observer, never a clean page.** This is not a stylistic point — the first live run reported "nothing unstable detected" when in truth nothing had been watched at all, which is exactly the fails-toward-fine pattern this feature exists to eliminate. `mode: 'failed'` is reported loudly and suppresses every other finding.

#### The row sample is masked in-page

The digest's `firstRow` is customer data on an ERP — the first live run against `/payments` returned real customer names and a phone number. `scan.json` lands in a repo, so raw cell content must never cross the browser boundary.

The page masks before emitting: digits become `9`, letters become `x`, and **currency codes are the only alphabetic content preserved** — because the derived wait is built from them, and preserving nothing else is what lets a currency tag be told apart from a masked name. `RM 3,700.00` → `RM 9,999.99`; `YAM YIT FAH` → `xxx xxx xxx`.

A Node-side guard (`isMaskedShape`) re-checks the invariant and drops any sample that fails it, so a later edit to the in-page code cannot silently start leaking. Masking is verified not to cost trap detection: the same `/RM\s?[\d,]/` still derives, and still rejects the skeleton row.

Each bucket is a digest:

```jsonc
{
  "t": 1.2,
  "counts": { "table tbody tr": 5, "[role=row]": 5, "[aria-busy=true]": 1 },
  "tableRowCount": 5,
  "firstRowText": "undefined undefined undefined",
  "bodyTextHash": "…",
  "loadingIndicators": ["Showing 0 results"],
  "pendingXhr": 1
}
```

Probe selector set: `table tbody tr`, `[role=row]`, `[role=grid] [role=row]`, `[role=listitem]`, `[aria-busy=true]`, plus the class heuristic `[class*=skeleton i]`.

Note the distinction, because it looks like a contradiction with §6.2 and is not: **probes may use class heuristics; emitted selectors never may.** A probe only has to notice that *something* changed during this one scan, so a fuzzy class match is a free extra signal. A selector written into `SITE.md` has to still work next month, and `INDEX.md` establishes that classes on these apps are obfuscated per build. If the skeleton probe is the only thing that fires, the emitted `WAIT ON` is still derived from role/text state, never from the class.

**Analyzer rules:**

| Observation | Verdict |
|---|---|
| selector count > 0 at t < 1s **and** changes after t > 1s | `UNSTABLE` — do not wait on it |
| text present early, absent later | `LOADING TEXT` — never read as a final value |
| first-row text goes empty/`undefined` → matching a data pattern | recommend waiting on the **data pattern** |
| digest unchanged across two consecutive samples | settled; record `settledAt` as the measured page time |

Output per page:

```
▶ WAIT ON: row text matching /RM\s?[\d,]/
✗ NOT ON:  table tbody tr  (5 rows at t=0.4s, 27 at t=3.4s)
✗ NOT ON:  "Showing 0 results"  (loading state, gone by t=3.2s)
settled at 3.4s
```

This is the one trap class a machine can discover, and it is the class that has cost the most runs.

### 6.2 Element inventory

From the accessibility snapshot. Per interactive node:

```jsonc
{ "role": "tab", "name": "Pending Verification", "tag": "button",
  "selector": "[role=tab][aria-label='Pending Verification']",
  "selectorStrategy": "aria-label",
  "disabled": false, "bbox": [x,y,w,h] }
```

Selector strategy preference, in order: `data-testid`/`data-test`/`data-cy` → `aria-label` → `getByRole(role, {name})` → visible text. **Never CSS classes.**

Table shape is captured separately: header texts, column count, row count, first row cells.

### 6.3 XHR capture

Via `page.on('response')`, static assets filtered out (js/css/images/fonts). Per request:

```jsonc
{ "method": "GET", "url": "…/api/payments?status=pending",
  "urlPattern": "/api/payments",        // numeric/uuid segments → :id
  "status": 200, "contentType": "application/json",
  "bytes": 48213, "ms": 820,
  "jsonTopKeys": ["data", "total", "page"],
  "rowKeys": ["id", "createdOn", "amount", "method", "status"]  // keys of data[0]
}
```

**Response values are never stored** — only key names, array lengths, and sizes. These are customer records and `scan.json` is a file in a repo.

Two mechanics that silently lose exactly the endpoints we care most about if got wrong:

- **`response.body()` has a lifetime.** It throws for cached responses and after the page navigates. Bodies must be read inside the handler, guarded in `try/catch`, and filtered by `content-type` before the attempt is even made.
- **Never `waitForLoadState('networkidle')`.** ERPs poll on a timer, so it either never fires or fires meaninglessly. The settle curve replaces it entirely; no code in recon may wait on network idle.

### 6.4 API replay probe

`AUTOMATION-PERF.md` ends on the open question: *does the target site render from internal JSON XHR?* On a business SaaS the answer is usually yes, and confirming it is the highest-value output recon produces — a read automation that hits the API skips rendering, settle waits, skeleton rows and screenshots entirely.

After each page's scan, for every captured **GET** returning JSON, recon re-issues that one request and records whether it returns standalone:

```ts
const res = await ctx.request.get(url);   // context.request, NOT curl
```

It must go through `context.request` on the live authenticated context. The profile's cookies are DPAPI machine-sealed — `curl` and fresh contexts cannot authenticate (`INDEX.md:16`). `context.request` still skips all rendering; it just has to originate inside the browser.

**Only GETs are ever replayed.** POST/PUT/PATCH/DELETE are recorded and never re-issued.

Result per endpoint: `replayable: true | false | "auth-failed" | "not-json"`.

---

## 7. The map page

Served at `http://localhost:<port>/recon/<domain>` from the existing daemon UI.

One card per route, in nav order:

- full-page screenshot, route, `navPath` reach path, settled time
- the settle verdict (`WAIT ON` / `NOT ON` lines)
- captured XHR list, each flagged replayable or not
- element inventory, one row each, with an inline note box
- **SKIPPED** list — every refused control with its reason and a tick box
- a page-level note box and a **job** box ("what would you automate here?")

Every note box saves on blur via `POST /recon/:domain/note`, which writes `notes.json` and rebuilds `SITE.md`. A per-page `↻ re-scan` button re-runs that one route through the warm Chrome, honouring any newly ticked approvals.

---

## 8. SITE.md

Generated in `INDEX.md`'s proven shape, because that format is already paid for and drops straight into the existing registry. A one-line pointer is appended to `INDEX.md` so discovery stays at zero tool calls (`AUTOMATION-PERF.md` §3).

```markdown
## <domain> — <app name> (<framework>, <rendering mode>)

Nav: <route list>

| Route | Reach | Data | Wait on | Settled | API |
|---|---|---|---|---|---|
| /payments | Sales > Payments | table, 6 cols, 27 rows | row text /RM\s?[\d,]/ | 3.4s | GET /api/payments ✓ replayable |

### Traps
1. `table tbody tr` matches skeleton rows (5 rows at t=0.4s, cells undefined) — never wait on it.
2. "Showing 0 results" is the loading state; it flips to the true count at t=3.2s.

### Vocabulary          ← from notes.json
### Jobs to automate    ← from notes.json
### API surface
### Confirmed selectors
```

`Traps` merges machine-detected settle traps with human notes, machine ones first and labelled.

### Discovery

`recon build` appends a one-line pointer to `INDEX.md` under the domain's heading. That file already opens with "READ THIS FIRST" and agents on this machine already honour it, so the brief costs zero tool calls and zero prompt budget to discover. See §3 for why this is not an MCP tool.

---

## 9. Error handling

| Condition | Behaviour |
|---|---|
| a route fails to load | record as failed, continue the scan, list failures in `SITE.md` |
| session goes stale mid-scan | **abort** — everything after it is garbage. Report the route it died on. |
| blocked domain | refuse before launching Chrome |
| bot-check detected | abort on page one, report the challenge type |
| page never settles by t=8s | record `settledAt: null`, flag the page as unstable, keep going |
| discovered pages > 40 | report the count and ask before proceeding |

The scan is resumable per route: `scan.json` is written incrementally, and re-running skips routes already captured in this scan id unless `--force`.

The whole scan is **one launch**, one tab, per `INDEX.md`'s "one launch per job" rule. No open/close/reopen churn.

---

## 10. Testing

**Unit**

- settle analyzer against synthetic digest sequences: skeleton case, loading-text case, already-stable case, never-settles case
- click policy: role allowlist admits tabs/nav/pagination, rejects `role=button` regardless of name
- note key stability: element renamed → note becomes an orphan, never lost
- blocklist: `whatsapp.com`, `facebook.com` refused with no browser call made
- XHR sanitizer: no response *values* survive into `scan.json`

**Acceptance — the answer key**

`INDEX.md` documents traps that were each discovered by burning a run. That makes it a labelled test set.

> Scan `admin.atap.solar` cold, and assert the generated `SITE.md` independently rediscovers both settle traps: that `table tbody tr` matches skeleton rows, and that `Showing 0 results` is a loading state.

If it finds both without being told, the settle curve has earned its 10s/page. If it does not, the mechanism is wrong and that must be known before the annotation UI is built on top of it.

**Safety assertion**

> Assert that a full scan issued **zero** mutating HTTP requests (no POST/PUT/PATCH/DELETE originating from a recon click).

This is provable, not argued, and it is the test that makes recon safe to point at a live ERP.

---

## 11. Explicitly not doing

- generating starter `.mjs` scripts (prove the brief makes the AI one-shot it first)
- screenshot hotspot overlays
- multi-site or multi-scan diffing
- scheduled re-scans
- any login handling — recon requires an already-ready session and refuses otherwise
- any bot-detection evasion; the blocklist is not overridable

---

## 12. Open questions

1. **Does AutoCount Cloud change its URL on navigation?** If not, `navPath` becomes the only route identity and the "Reach" column carries all the weight. Answered by the first scan; no design change either way.
2. **Do ERP grids paginate server-side or virtualize client-side?** Virtualized grids capture only what is near the viewport — the Facebook trap in a different suit. If the first real scan hits this, recon should detect and flag it rather than silently under-report row counts.
3. **Multi-company ERPs** may scope every route to a selected company. Recon records whichever company the session had; whether that needs to be an explicit scan parameter is deferred until observed.
