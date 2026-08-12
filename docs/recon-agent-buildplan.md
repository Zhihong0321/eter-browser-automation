# RECON-AGENT — build plan & handoff

**Updated:** 2026-08-12
**Design spec:** `docs/superpowers/specs/2026-08-12-recon-agent-design.md` — read it for *why*; this file is *what to do next*.

---

## 1. What this is

A tool for the **authoring** half of `docs/two-mode-agent-design.md`. It scans an authenticated business SaaS once, so that writing an automation for it becomes a single round-trip instead of an explore-guess-fail loop.

Its real product is the thing `E:\eter-browser\tools\INDEX.md` contains today: routes, selectors, timings, and **traps** — code that looks correct, runs without error, and returns a confident wrong number. Every line of INDEX.md was paid for with a burnt run. Recon finds them automatically.

**Scope:** cloud ERP, admin panels, back-office dashboards. Social/messaging/bot-detection sites are hard-blocked and not overridable.

---

## 2. Status — 1 of 4 parts done

```
1. SCAN      ✅ DONE, verified against the live site
2. MAP       ✗  generate the HTML page the human writes on
3. ANNOTATE  ✗  notes.json + the save loop
4. BRIEF     ✗  SITE.md the AI reads before writing code
```

`scan.json` is produced and complete. Nothing renders it yet, and human notes have nowhere to live.

---

## 3. What exists

| File | Role |
|---|---|
| `src/recon.ts` | settle detection + **pure** trap analyzer, blocklist, challenge detection, PII mask guard |
| `src/recon-net.ts` | XHR capture, JSON shape extraction, API replay probe |
| `src/recon-dom.ts` | element inventory, table shape, nav-link discovery, **pure** click policy |
| `src/recon-scan.ts` | crawl orchestration, tab exploration, `scan.json` writer, terminal report |
| `src/fastworker.ts` | optional small-model helper — **not used by the scanner** |
| `test/recon.settle.test.ts` | 18 tests — trap rules, masking, blocklist |
| `test/recon.policy.test.ts` | 12 tests — click policy, url patterns, endpoint ranking |

Wired into `src/api.ts` (2 routes), `src/cli.ts` (2 verbs), `src/service.ts` (`reconProbe`, `reconScan`). **No MCP tool** — deliberate, see spec §3.

Output lands in `<vault.home>/tools/<domain>/recon/scan.json`, i.e. `E:\eter-browser\tools\admin.atap.solar\recon\`.

---

## 4. Run it

```bash
npm run build
npx tsx --test test/*.test.ts          # 30 tests, all must pass

node dist/cli.js recon probe "https://admin.atap.solar/payments"
node dist/cli.js recon scan  "https://admin.atap.solar/" --max-pages 40
node dist/cli.js recon scan  "https://admin.atap.solar/payments" --max-pages 0 \
  --approve "Pending Verification,Verified Payments,Fully Paid Invoices,Update Method,EPP Costs"
```

**Measured:** 13 pages in 75s. Single page ~3s (adaptive window exits when the page goes quiet).

---

## 5. Environment gotchas — read before debugging anything

These cost the most time in the last session. All are environment, not code.

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

### Rebuild + restart after every source change

The daemon serves `dist/`. `npm run build`, kill daemon, kill Chrome, restart detached. There is no hot reload.

---

## 6. Hard-won findings — do not re-litigate these

**`addInitScript` silently does nothing under patchright.** No throw, scripts never run. Verified with an isolated diagnostic. Patchright removes `Page.addScriptToEvaluateOnNewDocument` because it is an automation fingerprint. The observer therefore installs via `evaluate` right after `goto(waitUntil:'commit')`, costing a measured ~465ms blind window that is reported as `installedAt`.

**Do NOT route around it with `newCDPSession`.** That reintroduces the fingerprint on the profile that holds real logged-in Facebook/WhatsApp sessions. A recon convenience does not outrank that.

**An empty trace is `mode: 'failed'`, never "clean".** The first live run reported "nothing unstable detected" when nothing had been watched at all. That is the fails-toward-fine pattern this whole feature exists to eliminate. There is a regression test.

**Row samples are masked in-page.** The first live run returned real customer names and a phone number, and `scan.json` goes in a repo. Digits → `9`, letters → `x`, currency codes preserved (the wait pattern is derived from them). `isMaskedShape()` is a Node-side guard that drops anything unmasked. **Never remove it.**

**XHR response *values* are never stored** — key names, array lengths and sizes only.

**`role="tab"` does not exist on admin.atap.solar.** The five payment states are plain `<button>`s, sitting beside `Delete Submission` and `Auto-Reconcile` — same role, same structure. No heuristic separates them. This is why pass 1 refuses all buttons and the human approves. Not optional; it is how tab states get reached at all.

**A comma-separated selector list only scopes its last item.** `` `${NAV_SEL} a[href]` `` matched `<nav>` elements themselves. Each part needs its own descendant clause. Cost a live run.

**Never `waitForLoadState('networkidle')`.** These apps poll; it never settles.

**`response.body()` has a lifetime** — throws for cached responses and after navigation. Read inside the handler, guarded, content-type filtered first.

---

## 7. `scan.json` shape — what part 2 renders

```ts
SiteScan { domain, root, startedAt, finishedAt, pages[], failed[], notes[] }

PageScan {
  routeKey, navPath[], url, title,
  settledAt, exitReason: 'quiet'|'cap',
  verdict: { waitOn: {pattern, sample}|null, unstable[], loadingTexts[], notes[] },
  table: { headers[], columns, rows }|null,
  tabs: [{ name, selector, table, approvedByHuman }],
  elements: [{ role, name, tag, selector, strategy, disabled, inNav, inForm, ... }],
  skipped: [{ role, name, selector, reason }],
  xhr:     [{ method, urlPattern, status, jsonTopKeys, rowKeys, rowCount, replayable, replayNote }]
}
```

Live sample lives at `E:\eter-browser\tools\admin.atap.solar\recon\scan.json`.

---

## 8. Next steps

### Part 2 — the MAP (do this next)

Render `scan.json` as one self-contained HTML page, served by the existing daemon at `GET /recon/:domain`.

One card per route: screenshot placeholder, route + `navPath`, settle verdict (`WAIT ON` / `NOT ON` lines), XHR list with replay verdicts, element inventory rows, tab states, and the **skipped list with a checkbox each**.

- Add `GET /recon/:domain` to `src/api.ts`, page in `src/ui/`.
- Follow the existing dashboard's style; do not add a framework.
- **Screenshots are not captured yet** — add `page.screenshot({fullPage:true})` per route in `scanPage`, writing to `recon/shots/<routeKey>.png`.

*Done when:* opening the page shows all 13 atap routes with their traps and refused controls.

### Part 3 — ANNOTATE

`notes.json` beside `scan.json`. `POST /recon/:domain/note` writes it; `POST /recon/:domain/rescan` re-runs one route honouring newly ticked approvals.

**The load-bearing rule: a scan must never overwrite `notes.json`.** Notes are keyed `routeKey` and `routeKey::role::name`. A note whose element vanished is kept and shown as `orphaned` — never deleted. The machine can re-derive routes and selectors any time; it can never re-derive *"the user's 'submitted payment' means the Pending Verification rows."*

Ticked approvals feed straight into `ScanOptions.approved` (already implemented, currently only reachable via `--approve`).

*Done when:* typing a note, re-scanning, and seeing the note survive.

### Part 4 — SITE.md

Generate in `INDEX.md`'s proven shape: routes table (Route / Reach / Data / Wait on / Settled / API), Traps (machine-found first, then human notes), Vocabulary, Jobs to automate, API surface, Confirmed selectors. Append a one-line pointer to `INDEX.md`.

*Done when:* an agent given only `SITE.md` writes a working payments script first try.

---

## 9. Do not

- add an MCP tool for recon (spec §3 — a per-new-site capability does not earn permanent prompt budget)
- use an LLM anywhere in the scan path; it is deterministic and free, and that is what makes it trustworthy
- auto-click `role=button` for any reason
- replay non-GET requests
- run recon headless (measurement fidelity + the profile is shared with sites that detect it)
- store raw row content or XHR response values

---

## 10. Open items

- **Uncommitted.** Everything above is in the working tree on `main`, nothing staged.
- **The repo is being modified outside this session** — `src/automations/`, `src/sendlimit.ts`, `src/mcp.ts`, `vault.ts`, `config.ts` all changed without this session touching them. Reconcile before committing.
- `.env` holds the fast-worker key, is gitignored, and was verified absent from every git-visible file. `.env.example` documents the vars.
- `/payments` exposed **no** replayable API, so payment reads still need the DOM path. Three other routes did, best being `GET /api/engineering-v2` at 200 rows with no rendering.
