# recon-agent — 2nd lane (visual) — MVP buildplan

Status: **BUILT and verified 2026-08-13**, the same day it was written. Steps 1–7 all pass on two
AutoCount pages, including the login page. Implementation: `scripts/xray.mjs`. Results in §11.
Companion: `docs/STUPID-MISTAKE-LOG.md` (2026-08-13 entry) is the evidence for why this exists.

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

### Still open

- The `Back to login` hop is a **hardcoded constant** pasted from a prior run — the one selector
  in the file lane 2 did not compile for itself. It needs a logout-page map like everything else.
- Correlation is still n=2 pages. Both were sparse. §9's dense-page risk is untested.
- §8's failure detector remains deferred, and it now has one more piece of evidence: run 1 aimed
  at the login page and landed on Select Company, and the *only* reason that was noticed is that
  the script prints `url | title` on arrival. "I asked for X, did I land on X?" is that cheap.
