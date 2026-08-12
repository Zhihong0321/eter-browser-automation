# RECON-AGENT — the API-first pivot

**Date:** 2026-08-12
**Supersedes the *ordering* of:** `docs/superpowers/specs/2026-08-12-recon-agent-design.md`
(that spec's constraints all still hold; what changes is what recon is *for*)
**Measured evidence:** `docs/monolith-spike-findings.md`
**Build steps:** `docs/recon-agent-buildplan.md`

---

## 1. The change

The stated goal is now explicit: **automations should work at the API level, not the UI
level.** Recon was designed to make DOM automation cheap. That is the wrong target.

Recon's product changes from:

> routes, selectors, timings, traps → so an agent can write DOM code

to:

> **for each job, which of two paths to take, and everything needed to write that code
> in one round-trip.**

- **Path A (reads):** the site's internal API — endpoint, params, response shape, and
  proof it matches what the screen showed
- **Path B (fallback):** the DOM — the existing product, for routes with no API
- **Writes: always Path B**

## 2. Why API-first, in this project's own numbers

**Speed.** Buildplan §4 measures 13 pages in 75s, ~3s per page for the adaptive settle
window alone, plus Chrome launch and daemon lifecycle. A replayable endpoint is one HTTP
round-trip. §10 records `GET /api/engineering-v2` returning 200 rows *with no rendering*.

**Determinism — the real prize.** Buildplan §1 states recon exists to find *"code that
looks correct, runs without error, and returns a confident wrong number."* Every trap in
§6 is a rendering artifact: half-populated tables, `loadingTexts`, unstable elements, a
settle window that exited early. **None of them can occur on a JSON response.** It parses
or it errors.

**Environment tax disappears.** Buildplan §5 — the detached-daemon requirement, the
"Opening in existing browser session" race, the kill-Chrome-and-rerun-in-one-command
incantation — is entirely browser tax. HTTP has none of it.

**Fingerprint risk disappears.** §6 refuses `newCDPSession` because it re-adds an
automation fingerprint to the profile holding real Facebook/WhatsApp sessions. The
`agent` profile was measured to carry **29 cookies across 9 domains** including
`.facebook.com`, `.web.whatsapp.com`, `.messenger.com`. An HTTP client never touches it.

**Drift gets loud.** Selector breakage is silent. A changed endpoint 404s or drops a key.

## 3. Decision: reads via API, writes via UI

**Rationale.** A UI automation clicking *Approve* travels the same path a human does:
client-side validation, confirmation dialogs, and whatever side effects the app fires —
audit entries, notifications, state-machine transitions. A raw `POST` can skip all of
them silently. On a live payments ERP that is the one place where the UI is **safer**,
not merely slower.

This makes buildplan §9's "never replay non-GET" *stronger*: non-GET is never replayed at
all. It is driven.

## 4. Coverage is partial by measurement, not by choice

§10 records that `/payments` exposed **no** replayable API; three of thirteen routes did.
So this is a hybrid design permanently. Recon's job is to say, per job, which path exists.

## 5. The four parts

### Part 1 — SCAN ✅ done, gains reconciliation

The replay probe currently reports `replayable` + `replayNote`. Insufficient. An endpoint
can return `200 OK` with **200 rows when the screen showed 47**, because the UI applied a
filter client-side or via a query param recon did not replay. No error anywhere — a
confident wrong number arriving through a new door.

Add to each `xhr` entry:

```ts
matchesScreen: 'yes' | 'no' | 'unknown'
apiRowCount:   number | null
screenRowCount: number | null
```

**`unknown` is never treated as pass.** Same discipline as §6's rule that an empty trace
is `failed`, never "clean". This is the only change to already-working code.

### Part 2 — CAPTURE (replaces the screenshot bullet)

One monolith snapshot per route, written to
`<vault.home>/tools/<domain>/recon/snapshots/<routeKey>.html`. Vault, never repo.

Flag set, measured (`monolith-spike-findings.md` §5):

```
-o -  -b <route URL>  -e  -j  -i  -F  -v  -a  -M
```

Three measured constraints drive this:

1. **`-o -` is mandatory.** monolith panics on any absolute output path containing `~`,
   and this machine's temp path contains `ETERNA~1`. Node captures stdout and writes the
   file itself.
2. **`-i -F` is mandatory.** Images and fonts are 99.5% of output weight — 26 MB → 126 KB
   on the public control, a 207× reduction with CSS and layout fully intact. Without it,
   storing snapshots for drift-diffing is impractical.
3. **`-C` is not wired in.** Capture was byte-identical with and without a cookie jar on
   admin.atap.solar; its CSS is unauthenticated. Keep `-C` in reserve. **If ever used, the
   jar must be filtered to the target registrable domain first** — a bare `ctx.cookies()`
   exports all 29 cookies including the Facebook and WhatsApp sessions.

Verified fidelity on the live authenticated route: `<tr>` 17→17, `<td>` 96→96, `<th>` 7→7,
`<button>` 46→46, 124 KB stylesheet intact.

**CSP post-process, mandatory.** monolith emits `script-src 'none'` whenever `-j` is
passed — with or without `-I`. Any overlay JavaScript injected into a snapshot **silently
does not run**: no error, no console warning. Before writing the file, Node rewrites the
CSP meta to:

```
default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-<random>'
```

Page JS is already stripped by `-j`; the page still cannot reach the network; only
recon's overlay executes.

### Part 3 — BIND (the old MAP + ANNOTATE, collapsed and repointed)

The snapshot **is** the annotation surface. Frozen route on one side, that route's
captured XHR list on the other. The human points at a table or section, picks the
endpoint that produced it, and says what it means in business language.

Output is the binding:

```
"submitted payments" → GET /api/payments?status=pending → 47 rows ✓ matches screen
```

**Why visual rather than a list.** §6 records that the five payment-state tabs are plain
`<button>`s sitting beside `Delete Submission`, with no heuristic to separate them — so a
human must decide. The measured button count on that route is **46**. Picking five out of
a flat list of 46 role/name pairs is a different and much harder task than pointing at a
tab strip on a rendered page. The layout is the discriminating signal, and only the
snapshot carries it.

Rules carried forward unchanged from the original spec:

- **A scan must never overwrite `notes.json`.** Endpoints and routes are re-derivable
  forever; *"the user's 'submitted payment' means the Pending Verification rows"* is not.
- Notes keyed `routeKey` and `routeKey::role::name`; an orphaned note is kept and shown,
  never deleted.
- Ticked approvals feed `ScanOptions.approved`, already implemented.

Button approval still lives here, now serving Path B and the write path only.

**Tab states need two passes.** A frozen page has no JS, so tabs do not switch when
clicked. The capture unit is *(route × approved tab state)*, not route. Since approval
requires seeing the page first, monolith capture runs in **both** passes of the existing
refuse → approve → rescan loop.

### Part 4 — SITE.md, inverted

Keeps `INDEX.md`'s proven shape, reordered:

1. **Jobs** — Job / Path (`API`|`DOM`) / Endpoint or Route / Verified count
2. **API surface** — endpoint, method, params, response shape, reconciliation result
3. **Writes** — always DOM: selector, settle info, approval state
4. **DOM fallback** — current shape, only for routes with no API
5. **Traps** — machine-found first, then human notes
6. **Vocabulary** — the bindings from Part 3

*Done when:* an agent given only `SITE.md` writes a working payments script first try.

## 6. Constraints unchanged

Everything in buildplan §9 still holds, plus:

- no LLM anywhere in the scan path
- never auto-click `role=button`
- never replay non-GET (now: never replay non-GET *at all*)
- never run recon headless
- never store raw row content or XHR response values in `scan.json`
- masking and `isMaskedShape()` stay exactly as they are — they guard `scan.json`,
  which is a separate artifact from the snapshots

## 7. New constraint

**Snapshots are vault-only and unmasked.** They hold real customer rows. They must never
be written into the repo, and no repo-bound artifact (`SITE.md`, `INDEX.md`) may quote
their content verbatim. This is why the masking rule on `scan.json` is untouched rather
than relaxed: the two artifacts have different homes and different rules.

## 8. Open items

- Auth strategy for Path A. Starting assumption: patchright's `context.request`, which
  shares the browser cookie jar — zero new infrastructure, no expiry management, skips
  all rendering. Retains the one-Chrome-at-a-time cap, so the concurrency win is deferred.
  Exporting a session token to drop the browser entirely is a later optimization, worth
  doing only if parallel automations turn out to matter.
- The repo is still modified outside this work (`src/automations/`, `src/sendlimit.ts`,
  `src/mcp.ts`, `vault.ts`, `config.ts`) and nothing is committed. Reconcile first.
