# recon-agent — 2nd lane (visual) — buildplan

Status **2026-08-13, end of day 2**: the lane's purpose changed. It is no longer "compile a click
script"; it is **reveal a site's database schema** (§12). The REVEAL MAP stage works — 52/52 routes
on AutoCount, 43 tables, 290 columns, 68 foreign keys, 8 create contracts, and an auto-generated
skill. **Nothing has ever been written to any site.** Implementation: `scripts/xray.mjs` (browser)
and `scripts/schema.mjs` (offline compiler). Companion: `docs/STUPID-MISTAKE-LOG.md`.

**This is not a production tool and is not close to one.** §13 says exactly how far off it is and why.

---

## 0. READ FIRST — what is NOT built

Do not assume anything below exists.

| Not built | What that means in practice |
|---|---|
| **Nothing has ever been written** | 8 create contracts are traced; **0 have been executed.** Every op in the emitted skill is stamped `traced, never executed`. Until one save succeeds the whole write half is theory. |
| **How to fill a dropdown is unknown** | Customer, Sales Agent, Credit Term, Currency are custom comboboxes, not `<select>`. `.fill()` will not work. **Every document contract depends on solving this** and it is the single biggest unknown. |
| **Line items are not captured** | A document is a header **plus a child line table** (Product Code, Description, Qty, Unit Price, Discount). Contracts describe the header only. An invoice without lines is not an invoice. Detector is fixed in code; needs one `--forms` pass. |
| **`required` is unknown everywhere** | The forms declare nothing required. Constraints are late-bound — they only appear when a save is rejected. That is what test-write mode (§14) is for. |
| **Update and Delete were never traced** | Both need an existing record to act on, and row-level action icons are 12×12 px, which is below the correlation floor. In accounting, D is probably **Void**, not delete, and may be irreversible. |
| **Master-data forms are not traced** | 13 of 27 died on the hub hop. `/debtor` (Customer) is unmapped, so **no customer exists and none can be created** — which blocks `create.invoice` entirely. |
| **There is no runner** | Nothing executes a contract. An AI holding the skill still has to write browser code, which defeats the purpose. Deliberately unbuilt until one save has succeeded. |
| **Unsafe against production sites** | REVEAL clicks *every* discovered same-origin `<a href>`. On an admin panel a GET link can approve, sync or export. Killed a run against `admin.atap.solar` for this reason. Needs a route allowlist, no queue expansion from row links, and a dry-run that prints the plan before navigating. |
| **Virtualized grids are invisible** | Column extraction assumes `<table>`. ag-Grid / react-window render `div[role=row]` with ~20 rows in the DOM. Likely the most common real-world failure. |
| **Controls under ~20 px do not correlate** | Unchanged and unresolved: ~16 px of error against a 12×12 px box. Fails closed, correctly. |
| **Names are model-authored and can be wrong** | `Re-scan Dates` → "Re-schedule". FK inference inherits it: `Invoice No.` was matched to table `purchaseinvoice`. Geometry is reliable; names are best-guess by design. |
| **Nothing dispatches to lane 2** | Unchanged. `recon-agent` does not know this lane exists. Wiring it up edits lane 1's files, which §5 forbids without a cold decision. |
| **Nothing in `src/`** | Both scripts are marked prototypes. They import `dist/fastworker.js` read-only and touch no lane-1 file. |

**Order for the next session** — 1 and 2 unblock everything else:

1. **Solve dropdown fill.** Probe one combobox for real. Every write path is behind it.
2. **Trace `/debtor`** so a customer can exist. `create.invoice` cannot run until one does.
3. One `--forms --limit=9` pass to populate line items (detector already fixed).
4. Build test-write mode (§14) — the only way `required` and Void-vs-Delete become knowable.
5. Read-only safety mode before this touches any production site again.

Committed on `main`: `116fbd7` (the lane), `3ab96d7` (the generalisation probe). Day 2 uncommitted.

---

## 1. Why

Lane 1 (the existing crawler) reads the DOM and clicks by selector. That is a **bet that the
site's author labelled their HTML**. On `accounting.autocountcloud.com` that bet loses:

- `document.querySelectorAll('button')` → **0 results** on the login page
- all three `input[type=submit]` → **`value` empty**
- so the visible blue "Log in" control has **no accessible name**, and every
  `getByRole`/`getByText`/`input[type=submit]` click matches nothing — **silently**

The site is Malaysia's most-used cloud accounting system. It works perfectly for humans.
It has near-zero bot detection. Lane 1 still could not get past its login page.

**This is not a bot-detection problem. It is a sloppy-HTML problem, and it is worse**, because
bot detection tells you it beat you and sloppy HTML fails silently — it looks like your own bug.

## 2. The axiom this lane rests on

> If a human asks to automate a site, the human can operate that site.

So the human UI is guaranteed to work. A lane that operates the human UI can never be blocked
by bad HTML. Lane 1 bets on the author; **lane 2 bets on the site working for humans, and that
bet is pre-won.**

## 3. The insight that makes it cheap

Unlabelled ≠ unanchorable.

AutoCount's HTML has no *semantics*. It still has perfectly stable *handles*
(`img[src="button-img.png"]`, DOM position, form index). It just never says what they do.

The screen says what they do. The DOM says where they are. **Both live in the same coordinate
space**, so they correlate by geometry — never by name. The author's incompetence is routed
around entirely.

Therefore lane 2 is **not a permanent slow lane. It is a compiler.** Run visually once, capture
what you touched, emit a lane-1 script. Slow once, fast forever.

## 4. What is already proven (do not re-litigate)

| Fact | Evidence |
|---|---|
| `step-3.7-flash` is multimodal | HTTP 200 on OpenAI-style `content:[{text},{image_url}]` |
| It reads unlabelled UI correctly | named every input, checkbox, link and the submit button on the AutoCount login page |
| Its coordinates are **normalised 0–1000**, and accurate | `603,660` on a 2403×1401 shot → (1449, 925); true centre (1448, 924) — **1 px off** |
| Cost | ~27 s and ~1850 tokens with an image; 4.7 s text-only |
| `fastAsk({images})` works | `src/fastworker.ts`, built and verified 2026-08-13 |
| AutoCount login | `page.locator('input[type=password]').first().press('Enter')` |
| **AutoCount's submit control is a `<div>`** | compiled selector `…>form>div:nth-of-type(4)>div`. Not a button, not an `input[type=submit]` — the reason `querySelectorAll('button')` returned 0. Vision saw a button because it *looks* like one |
| Vision cost, measured per page | 9.9 s / 616 tok (Select Company, 7 controls); 16.8 s / 1274 tok (login, 5 controls) |
| Structural `nth-of-type` paths survive a reload | 12/12 compiled selectors resolved to exactly 1 element on a fresh load, across two pages |
| Log Out does not land on the login form | it lands on a confirmation page; the form needs a second hop ("Back to login") |
| **Correlation accuracy is a function of control SIZE, not page** | 22/22 on controls ≥40 px tall; 1/7 on 12×12 px row icons, where the model's point was ~16 px off — more than the box tolerates |
| Vision token budget scales with page density | 3000 tok was fine for 7 controls, came back **silently empty** at 28 (reasoning ate the budget). Now 8000 |
| Model-authored names can be wrong while geometry is right | it called `Re-scan Dates` "Re-schedule" — correct box, correct selector, wrong key |

Cost is why the flow below is **script-navigate first, vision only on arrival** — never per click.

## 5. Hard boundary — what this plan may NOT do

Violating any of these means the plan failed, regardless of whether AutoCount works:

- **No edits to `src/recon.ts`, `src/recon-scan.ts`, `src/recon-capture.ts`, `src/recon-dom.ts`.**
- **No AutoCount-shaped logic anywhere in `src/`.** No "if hostname includes autocount".
- Lane 2 is a **separate program**. recon-agent will one day *dispatch* to it; it must never
  *contain* it. Neither lane imports the other.
- The MVP is invoked **by hand**. No automatic lane switching yet (see §8).
- If lane 2's needs start requiring edits to lane 1's files — **stop and escalate.** That is the
  "fix one thing, deal 300% damage" pattern, and it has scrapped 5 of the last 6 projects.

## 6. MVP scope

One target page. One control. End to end. Nothing else.

**Definition of done — the only acceptance test that counts:**

> A second run, with **vision disabled**, uses the selector emitted by the first run and
> successfully performs the same action.

If that passes, the compiler works and the lane is real. If it fails, the lane produced a
one-off click and is worthless.

**It passed, on both pages.** See §11.

## 7. Build order — each step ends in something visible

Everything lives in **`scripts/xray.mjs`** (throwaway, untracked, `// PROTOTYPE` header).
Imports `dist/fastworker.js` read-only.

### Step 1 — arrival capture
Navigate (by clicking, not by typing URLs — see §8) and on arrival capture **at the same instant**:
- `page.screenshot()` → PNG
- one `page.evaluate()` → the **visible element table**

Table = every element that survives hit-testing, each row:
`{ tag, type, box:{x,y,w,h}, ownText, nearestLabelText, selector }`

Hit-testing is the point: keep an element only if
`document.elementFromPoint(centreX, centreY)` returns it or a descendant. That proves it is
actually on top and actually visible — no `getComputedStyle` guessing.

**Visible result:** the PNG, and a printed table. Compare by eye: screen shows N controls, table
has N rows.

### Step 2 — vision pass
One `fastAsk(prompt, { images: [imageDataUrl(shot)] })`. Ask for a list:
`NAME | ROLE | x,y` with coordinates normalised 0–1000.

**Visible result:** the model's list printed next to the step-1 table.

### Step 3 — correlate (this is the whole lane)
For each control the model named:
`px = x/1000 * width`, `py = y/1000 * height` → find the step-1 row whose box contains (px, py).

That row's `selector` is now **permanently known** to mean the model's `NAME`.

**Visible result:** printed mapping, e.g.
`"Log in"  ->  form > input:nth-of-type(3)   (box 1380,900 88x48)`

### Step 4 — emit
Write `<host>.map.json`: `{ name, role, selector, box, capturedAt, url }` per control.

**Visible result:** the JSON file, opened and read.

### Step 5 — prove the compile (the acceptance test)
Re-run with `--no-vision`. Load the map, click by the emitted **selector** only, and confirm the
same outcome (URL/title changes as expected).

**Visible result:** the second run's terminal output, with zero model calls.

### Step 6 — survive a reload
Re-run step 5 after a hard reload. Anchors must be structural (`src` filename, tag + position,
form index) — **never obfuscated class names**, which `INDEX.md` already documents as per-build
garbage. If a selector breaks on reload, it was the wrong anchor.

## 8. Deliberately deferred (with reasons)

- **Automatic lane switching.** It requires a failure detector, and *recon-agent currently cannot
  tell that it failed* — it reported `11 pages, 0 failed` while 9 snapshots were the login page.
  A fallback that triggers on a false green never triggers. The detector must be written
  site-agnostically ("I navigated to route X — did I land on X?"; "N snapshots have identical
  byte size"), never as "is this the AutoCount login page." **Not in MVP, and it touches
  lane 1 — so it is your call, made cold, with AutoCount not in the room.**
- **Navigation by clicking rather than URL.** Observed but not proven: lane 1 typed
  `/companyprofile` and got bounced to login 9 times, while `/dashboard` and `/masterdata`
  (reached by clicking) worked. A human never types those URLs. MVP navigates by clicking;
  confirming the cause is a separate probe.
- **Lane 3 — bot detection / captcha.** Out of scope. If a site blocks us, **skip it for now.**
  There is no guaranteed win there and that is accepted.
- **Multi-page crawl, retries, caching, concurrency.** MVP is one page, one control.

## 9. Known risks

- **27 s per vision call.** Acceptable once per page; fatal per click. If the design ever needs
  a call per interaction, the design is wrong.
- **Coordinate accuracy was measured on one screenshot.** 1 px is excellent but it is n=1. A
  dense grid or a small control may be worse. Step 3 correlates against real DOM boxes, which
  tolerates error up to the size of the control — but verify on a busy page before trusting it.
- **The model may hallucinate a control that is not there.** Step 3 fails closed: if no element
  box contains the point, drop the entry and log it. Never invent a selector.
- **Icon fonts did not inline** in the monolith snapshots (glyphs render as empty boxes). Not a
  blocker for this lane; noted because it degrades screenshots taken *from snapshots*. Take
  screenshots from the live page.

## 10. What this plan does not promise

That AutoCount ends up fully automated. Today, two things work: login, and two pages.
The lane is a method with one unknown resolved (vision + coordinates). It is not a result.

---

## 11. What actually happened (2026-08-13)

All of it lives in `scripts/xray.mjs`. Commands:

```
node scripts/xray.mjs                      # capture + vision + correlate + emit  (Select Company)
node scripts/xray.mjs --no-vision          # replay by selector, zero model calls
node scripts/xray.mjs --login              # log out, hop to the form, map it
node scripts/xray.mjs --login --no-vision  # replay the login, zero model calls
node scripts/xray.mjs --logout             # log out and stop
node scripts/xray.mjs --emit               # step 7: compile both maps into a runnable script
node scripts/xray.mjs --url=<any page>     # point the lane at a different site entirely
```

**Page A — Select Company.** 28 hit-tested visible elements. One vision call named 7 controls;
**7/7 correlated, 0 dropped.** Two of them — the row's View and Settings icon buttons — have
*empty* `innerText`, no `title`, no `alt`. Nothing for lane 1 to match on, ever. Replay clicked
`Macam Yes` by selector → `/dashboard`.

**Page B — the login form.** 10 visible elements. Vision named 5; **5/5 correlated, 0 dropped.**
Replay filled Email and clicked the `<div>` submit → logged in → Select Company.

**Navigation used the lane's own output.** Getting to the login page meant clicking the `Log Out`
selector *compiled from page A*, then the `Back to login` selector compiled from the logout page.
Never a typed URL. §8's "navigate by clicking" held.

### Step 7 — emit a program, not a map (added after the MVP)

`--emit` reads both maps and writes `scripts/autocount-login.gen.mjs`: 32 lines, no vision, no map
lookup at runtime, just selectors. Run cold from logged-out:

```
step: goto
step: log in
step: pick company
IN: https://accounting.autocountcloud.com/dashboard | Dashboard - AutoCount Accounting
```

That is §3's claim discharged: **slow once, fast forever.** ~27 s of vision, once, produced a
script that logs into AutoCount in ~30 s of pure wall-clock with zero model calls.

### Page C — a different app entirely (`admin.atap.solar/payments`)

The only question the AutoCount runs could not answer: is this a method, or an AutoCount trick?
Run with `--url=`, no site-specific anything, an app the lane had never seen.

44 controls on screen, 28 in the element table, **23 correlated and 21 dropped** — and the split
is not random:

| | result |
|---|---|
| Sidebar nav, header buttons, tab bar, search box (13 links + 8 buttons + 1 input) | **22/22 correlated** |
| 12×12 px WhatsApp icons inside table rows | **1/7** — and the 1 was luck |
| Row text ("CHAN JIA WEI"), `Call` links | 0 — they were never in the element table to match against |

All 23 emitted selectors resolved to exactly 1 element on a fresh load.

**So §9's second risk is now measured, not feared.** The model put "Message" at `711,490`; the real
box is at `701,506`. ~16 px of error against a control that tolerates ±6. Everything ≥40 px tall
correlated perfectly on the first look at an unfamiliar app. **The lane's accuracy is a function of
control size, not of page or site.**

**Fail-closed held: 21 misses, zero invented selectors.** §9's third bullet did its job.

### Still open (the detail behind §0)

- **Small-control correlation.** Strict containment drops anything under ~20 px. A
  nearest-box-within-tolerance rule would recover most of them, but it deliberately weakens the
  fail-closed guarantee, so it is a decision, not a patch.
- **The element table misses non-interactive text and `tel:` links** — half of page C's drops were
  this, not the model. Widening the query is cheap and safe.
- **Names are model-authored and can be wrong** (`Re-scan Dates` → "Re-schedule"). Anything that
  looks a control up *by name* inherits that. Geometry was right in every such case.
- The `Back to login` hop is a **hardcoded constant** pasted from a prior run — the one selector
  in the file lane 2 did not compile for itself. It needs a logout-page map like everything else.
- §8's failure detector remains deferred, and it now has one more piece of evidence: run 1 aimed
  at the login page and landed on Select Company, and the *only* reason that was noticed is that
  the script prints `url | title` on arrival. "I asked for X, did I land on X?" is that cheap.

---

## 12. The methodology change (2026-08-13, day 2)

**Every SaaS is eventually a wrapper over a database.** So the job is not "automate a workflow", it
is: reveal the schema, then every workflow is a lookup.

1. **Shared auth = the connection string.** Already solved — the `agent` Chrome profile.
2. **Reveal the schema.** Which pages exist (tables), what each grid shows (read schema), what each
   form takes (write schema), what each dropdown offers (foreign keys).
3. **Record where to READ / LIST / CREATE / UPDATE / DELETE**, per table.

This replaced the previous plan, which was a vertical slice — create a customer, then an invoice,
then connect a source. That plan was wrong, and specifically wrong: **it wrote records into a
database whose access paths had not been mapped.** A vertical slice is correct when the *mechanism*
is unproven; the mechanism was already proven by §11, so the slice re-solved a solved problem and
left surface coverage untouched.

Two things fall out of the DB model for free:

- **Dropdowns are foreign keys.** A Customer dropdown on the invoice form *is*
  `invoice.customer -> debtor`. Enumerating them recovers the relational graph without database
  access — and on an empty account, an **empty dropdown names an unpopulated master table**, so the
  seeding order reads straight off the map.
- **LIST and CREATE are two projections of one table.** Grid columns are the read schema, the New
  form is the write schema. Their diff identifies server-computed fields (doc no., balances, aging).

Where the analogy breaks, and it matters: **no transactions** (a form that dies halfway leaves a
partial record, no ROLLBACK); **constraints are late-bound** (validation is only legible after a
rejected save); **no `SELECT … WHERE`** (the query planner is whatever filters the UI offers, so
exports are a first-class bulk-read path); **one profile = one serial connection**, no pool.

### Stages, and what each produced

```
node scripts/xray.mjs --reveal            # read nav tree, walk every route, screenshot each
node scripts/xray.mjs --forms --limit=9   # open each New form, vision-label its fields
node scripts/schema.mjs                   # offline: compile tables/columns/CRUD/FKs
node scripts/schema.mjs --emit-skill      # offline: generate .claude/skills/<site>/
```

**REVEAL MAP — 52/52 routes reached.** Nav discovery is **23 ms**, not a click-through: the whole
tree is already in the DOM (`ul.sidenav-inner` holds every collapsed `<a href>`). The first attempt
clicked menus open to "discover" links that were already there, fought the toggle behaviour, took
six minutes and reached 16/52. **Collapsed ≠ absent.** Discovery found 17 routes the sidenav never
shows — the master-data tables behind `/masterdata`, where `/debtor` is Customer and `/creditor` is
Supplier.

**Every route is reached by clicking, never by typing a URL,** and every arrival is gated on
`asked === landed`. A schema recorded from the wrong page is a corrupt catalog — worse than a
failure, because it looks fine.

**Forms — 8 of 9 opened**, 23–28 inputs each. The form is a **modal on the same route**, so URL
change cannot detect it; raw input-count delta can (invoice: 3 → 28).

**Vision labelled what the DOM would not.** The modal has almost no `<label for>`, so `labelOf`
resolved 4 of 28. One vision call per form (~53 s) named the fields and geometry matched each to a
real selector: Customer, Name, Email, Invoice No., Address, Sales Agent, Credit Term, Date,
Currency, Rate, Deposit Payment Amount — 11/11. **This is the lane's entire purpose applied to
forms instead of pages, and it runs once, ever.**

**Compiled: 43 tables, 290 columns, 68 FKs, 27 creatable, 8 write paths.** FK inference is
name-based and best-guess: `invoice.customer_code -> debtor` was correct and derived before anyone
looked at the form; `Invoice No. -> purchaseinvoice` was wrong.

**Emitted a skill** at `.claude/skills/<site>/` — `SKILL.md` (index + status flags), `tables.md`,
and one JSON contract per op, loaded on demand. The skill is a **build artifact, never
hand-written**; the emitter contains no site knowledge.

### Generality

Only **one block** in the whole pipeline is site-specific: the AutoCount company picker, skipped
entirely when `--url=` is given. `schema.mjs` has zero site knowledge.

`admin.atap.solar` reached 12 pages through the *fallback* path with no sidenav classes present,
before the run was killed for being production. So the generic path works — but the sample is two
apps, and the run that would have proven it was aborted on purpose.

The map stage should work on most conventional apps (anything navigating by real `<a href>`). It
breaks on: nav built from `div onclick` / programmatic routers, hash routing (one-line fix),
virtualized grids, and create actions that are icons rather than the word "New".

**The property that matters more than the hit rate: it degrades to "route list plus screenshots",
not to garbage.** 21 misses and zero invented selectors on the atap probe. A half-working site
yields an honest partial map with a MISS column, never a schema that lies.

---

## 13. Distance to production — read this before promising anything

Two days in. What exists is a **working prototype of a mapping method**, not a tool. The gap is not
polish; four things are unknown, and unknowns are not schedulable:

| Gap | Why it is not "nearly done" |
|---|---|
| Dropdown fill | Never attempted once. Could be type-and-pick (an afternoon) or event-driven and hostile (a week). Everything is behind it. |
| First successful write | Zero records created. Until one save lands, every contract is a hypothesis. |
| Validation rules | Structurally undiscoverable by reading. Requires attempting saves. |
| Update / Delete | Never traced, and blocked by the 12 px control problem that has been open since day 1. |

Production would additionally require: a runner that executes contracts, read-only safety for prod
sites, virtualized-grid support, staleness detection when a vendor ships a UI change, and error
handling — of which **none exists**.

Honest framing: the read half is close to useful and the write half has not started. Calling this
"almost done" because a schema exists would repeat the exact failure this repo keeps recording —
trusting a proxy signal that fails toward "fine".

---

## 14. Test-write mode (designed, not built)

Writing is the only way to learn the late-bound half of the schema, and an empty trial account is
the correct place to do it — writing **manufactures its own test data**, which also unblocks the
read path that has nothing to read.

- **Log before the save, never after.** A save that succeeds but times out on the response leaves an
  untracked record in the books. Write intent → save → confirm.
- **Marker in the record itself**, not only the log: `XRAY-TEST-<runid>` in a free-text field (the
  invoice line `Description` is the natural home). If the log is lost, the records are still
  identifiable — by a human and by cleanup.
- **Delete in reverse dependency order.** `refs` in `schema.json` already gives the ordering.
- **Accounting systems usually VOID, not delete.** AutoCount has an Audit Trail. A voided invoice
  may persist permanently. Assume test data is **not fully removable** until proven otherwise.
- **Document numbers do not roll back.** The invoice modal shows `I-000001` before anything is
  saved. Test writes consume the live sequence whether or not the record survives.

Those last two are why the **empty trial account is the right sandbox and should be kept** — not a
limitation to escape.
