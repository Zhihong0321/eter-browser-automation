# Stupid Methods To Avoid

**Browser-automation anti-patterns. Read before writing any script that drives a browser.**

All 27 rules are one error wearing different costumes: *a cheap signal adjacent to the question was accepted in place of the question itself, and every such signal fails toward "fine."* The section below states the pattern; the numbered rules are its instances. Each one is a thing that actually went wrong on this machine — none are hypothetical.

Companion documents: `E:\eter-browser\tools\INDEX.md` (the registry of already-built scripts — read it before writing a new one).

## The pattern behind all 27 rules

Read this first; the numbered rules are just its instances. **Every rule below is the same mistake: a cheap signal adjacent to the question was accepted in place of the question itself — and every one of those signals fails toward "fine."**

| What actually needed to be known | The proxy accepted instead | Rule |
|---|---|---|
| What the data says | a screenshot of it | 1 |
| Which dataset was requested | the tab that seemed likely | 2 |
| Whether the page finished loading | seconds elapsed / an element existing | 13, 14 |
| Whether the table is empty | the string `Showing 0 results` | 15 |
| Whether the dialog is gone | `!querySelector(…)` — on a blank page | 7 |
| Whether the message sent | that Enter was pressed | 12 |
| Which page is being driven | `pages()[0]` | 6 |
| Which process is the agent's | the image name `chrome.exe` | 9 |
| Whether the reported number is right | a caveat saying it might not be | 16 |
| Where a control actually is | a selector that names it | 19, 20 |
| Which of three identical fields is the real one | the first match | 21 |
| Whether the popup is ready to click | that its text exists somewhere | 22 |
| What the user wants built | the narrowest reading of one sentence | 25 |
| Whether the tool covers this | that it covered the last one | 26 |
| Whether the prerequisite is met | a separate look, then a decision | 27 |

Four consequences, all confirmed by the runs above:

1. **The failures are silent and directionally biased.** None of these threw. `dismissed:true`, `RM 0.00`, `Showing 0 results`, five skeleton rows — every one returned *success*. The error never once pointed at a false alarm; it always pointed at premature *done / empty / fine*. A crash would have been a better outcome than any of them.
2. **The correct method was cheaper every time.** 13 s versus writing a disclaimer. One DOM query versus two screenshots. One `tbody tr` count versus hunting pagination that did not exist. No speed-versus-correctness tradeoff was ever actually being made — the stupid method was slower *and* wrong.
3. **It is one recurring error, not twenty-seven.** `RM 30,809,399.76` appears twice in this file: as the **wrong** answer in rule 2 and the **right** answer in rule 16. Same dataset, same day — overshot by guessing, undershot by not checking.
4. **Only ~4 of 27 are skill problems** (4, 9, 18, 23); the remaining 23 are belief problems. More Playwright knowledge would have prevented almost none of this.

**The generative rule — apply before reporting any result or ending any wait:** name the signal about to be trusted, then ask *what would this signal report if the thing were false?* **If the answer is "the same thing," it is not a check.** `waitForSelector('tbody tr')` reads identically whether data loaded or not; a screenshot looks equally convincing either way; a caveat reads the same whether the number is right or wrong.

---

**1. Never screenshot to READ data.** Screenshots are for judging layout, rendering, or a visual bug — nothing else. Text, tables, prices, counts, labels and button names all come from the DOM (`innerText`, `tbody tr` cells). An image costs ~1,500-2,500 tokens and cannot be summed, filtered, or diffed; the same table as text costs ~200 and is directly computable. On this job two screenshots were taken to answer "is there a Submit button" and "what rows are in this tab" — both were one-line DOM queries. The user's exact words: *"why you are not fetching DOM, html, to do this job, but instead , screenshot????"*

**2. Pin the ambiguous term BEFORE extracting, not after.** The request said "submitted payment". The UI had tabs `Pending Verification / Verified Payments / Fully Paid Invoices` and no "Submitted" tab. Extraction ran against Verified — 3,930 rows and a RM 30.8M total — all of it wrong; the answer was the 4 PENDING rows. One question, or one cheap `tbody tr` count per tab, costs seconds. Guessing costs the whole run plus the user's patience. When a requested label does not literally exist in the UI, resolve it first.

**3. Count rows before believing in pagination.** Time was spent hunting prev/next buttons and a page-number nav that did not exist — the table renders all rows at once. Always read `document.querySelectorAll("tbody tr").length` and the "Showing N results" footer FIRST; if the count already equals N, there is no pagination to drive.

**4. Never inline complex JS through JSON → curl → shell.** Two calls died on escaping before executing anything (`Cannot read properties of undefined`, `missing required string field`) because the snippet passed through a shell string, a JSON body, and an `eval` wrapper. Write the script to a `.js` file and run it with `node`. This also makes the logic re-runnable and editable instead of retyped each attempt.

**5. Probe the claim, do not assert it.** The one thing done right: rather than arguing whether the page's HTML could be fetched directly, one request settled it — `GET /payments` returns 35,901 bytes containing the tab shell and an empty `<tbody>`, with `/RM\s?[0-9]/` matching **false**. That single measurement replaced a whole disagreement. Apply the same to "is it paginated", "is it server-rendered", "does an API exist" — one probe, printed evidence, then act.

**6. Do not trust `pages()[0]` to still be your page.** Mid-run the working tab drifted to `facebook.com` and later `example.com`, so a click landed on the wrong site entirely. Hold an explicit `page` reference for the whole script and assert `page.url()` before any action that mutates state.

Corollary for all six: a wrong result delivered fast is worse than no result. Verify which dataset was pulled before reporting a total.

---

Added 2026-08-11 from the `web.whatsapp.com` job on the same day, where the browser was relaunched about eight times to learn what one launch could have answered. User's verdict: *"you dont think, but just rush to open browser, close browser, restart browser"*.

**7. An assertion that passes on a blank page is not an assertion.** `return { dismissed: !document.querySelector('[role="dialog"]') }` reported `dismissed: true` — from `about:blank`, where nothing exists because nothing exists. A false success was reported to the user. Every probe returns `location.href` alongside its verdict, and every "X is gone" check is paired with proof the expected page is still loaded. Absence only means something when presence was possible.

**8. `about:blank` after a pause is documented behaviour, not breakage.** The eter-browser daemon idle-closes Chrome after `settings.idleTimeoutMs` (default 5 min) and relaunches it on a blank tab — visible in `browser.ts`. Ports and processes were checked before that was realised. Re-read the config before diagnosing the environment; on a blank tab, just re-navigate. Never restart the daemon for it.

**9. Never kill processes by image name.** `Get-Process chrome` returned 33 processes — killing "chrome" takes the user's personal browser down with the agent's. Always filter by the profile that identifies the target: `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*eter-browser\profiles\agent*' }`. Prefer not killing at all: a hard kill can lose unflushed IndexedDB writes, which on WhatsApp destroys the linked-device credentials a human created by hand.

**10. Ask whether the site tolerates a second tab before opening one.** An enrollment call was about to `openTab` on web.whatsapp.com while a WhatsApp tab was already open; WhatsApp allows one active web client per linked device and the second tab seizes it. Default to reusing the tab that exists. Messaging apps are single-client by design.

**11. Findings that live only in the conversation are not deliverables.** Selectors, storage layout, boot timings and traps were confirmed, explained at length in chat, and written nowhere until the user objected: *"ALLLLLL progress only live in current chat session, NOT IN THIS PROJECT"*. The moment a selector or timing is confirmed it goes into the script header and `E:\eter-browser\tools\INDEX.md`, in the same turn. Test: if the session ended right now, could the next agent run the job from the repo alone?

**12. A write action is done only when the application echoes it back.** Pressing Enter proves nothing. A message is sent when an outgoing row with a delivery status appears; a comment is posted when it is visible on the page. Every write path returns `ok:false` when the confirmation never arrives.

---

Added 2026-08-11 from the second `admin.atap.solar` payments run — the session that built `tools/admin.atap.solar/payments.mjs`. These are about **how the automation gets tested**, not how it gets written. A 4-second question took minutes, and then shipped a number that was wrong by RM 30.8 million. User's verdict: *"1 step workflow but take years to complete???"*

**13. Never `waitForTimeout` as the page-ready wait.** Three scripts used blind `waitForTimeout(4000/5000/6000/2500)` and spent ~25 s asleep for nothing. Measured afterwards: `launch → goto /payments → waitForFunction(rows have amounts)` completes in **3.2 s**. A sleep is a guess about someone else's machine on someone else's network; it is simultaneously too slow when things are fast and too short when they are slow. `waitForSelector` / `waitForFunction` only. A short `waitForTimeout` is allowed *after* a confirmed selector as a settle, never as the primary wait.

**14. Wait on the DATA'S SHAPE, not the element's presence.** `waitForSelector('table tbody tr')` returned true against **skeleton loading rows** — 5 rows, every cell `undefined`, total computed to `RM 0.00`. That is worse than a crash: it is a plausible-looking answer. The wait condition must assert the thing being measured actually exists — here, a row whose text matches `/RM\s?[\d,]/`. Rule 7 said an assertion that passes on a blank page is not an assertion; this is its nastier sibling, where the page is *not* blank and the structure is *fully* correct, and the content is still absent.

**15. Never put an "empty" sentinel inside a readiness condition.** The wait was written as `hasMoney || /Showing 0 results/` — reasoning that zero results should not hang. But on this page `Showing 0 results` **is the loading state**; it flips to the true count a second later. The escape hatch fired instantly, every time, and returned a confident false zero. The bug was built into the very mechanism meant to prevent it. Before any "nothing here" string can end a wait, prove it means *settled-empty* and not *not-yet-loaded* — otherwise wait for the positive signal and let a timeout mean empty.

**16. A caveat is not a substitute for a check you are capable of running.** "Verified Payments" came back empty, and it was reported to the user with a hedge: *"its footer still read Showing 4 results, so that tab may not have finished re-rendering; I did not verify its contents."* Re-running it cost **13 seconds**. The true answer was 3,930 payments totalling RM 30,809,399.76. Writing a disclaimer took longer than getting it right. **When the verification is itself automatable, hedging is not caution — it is choosing to ship a wrong number with paperwork attached.** Run the check. If it genuinely cannot be run, say what would settle it, not what might be true.

**17. Porting working code into a tool requires diffing against the known-good answer.** The manual run had already established Pending = 4 rows / RM 19,429.25. The first run of the extracted `payments.mjs` printed 5 rows / RM 0.00 and was not immediately recognised as broken — it was only caught because `--rows` happened to print `undefined` cells. A refactor that reproduces a result must be compared to that result on its first run, deliberately, before it is trusted or documented. Keep the old number in hand precisely so the new one can be contradicted.

**18. Change one variable at a time, starting from the known-good config.** The proven-working launch was `headless: false, viewport: null, args:['--start-maximized']`. The tool was written with `headless: true` **and** `viewport: {1600×1000}` changed together, then debugged blind against a page returning skeleton rows — with no way to tell which change mattered, or whether either did. When something works, that config is the baseline; move away from it one step at a time and re-measure.

Corollary for 13-18, and the theme of the whole session: **the browser automation must be tested by the automation, not by eye.** Every one of these failures was invisible from the printed output alone and would have been caught in seconds by a script that asserted its own result against something known. Speed came from removing sleeps and launches; correctness came from asserting the shape of the data. Neither came from looking harder at the screen.

---

Added 2026-08-13 from the AutoCount quotation session — 15 browser launches and 5 selectors at a single date box, to produce one record, when the deliverable was a reusable engine. Final engine: **21 seconds, one launch**. Evidence in `STUPID-MISTAKE-LOG.md`. User's verdict: *"You either kill both of us with your stupid method that never can be stop."*

**19. Click by geometry, never by selector — and use the TEXT's rectangle, not the element's.** Selector clicking bets that the site's author named their controls. Element rectangles include whatever sits next to the text: "Save" was a split button, so the element box spanned the caret and every click opened *Save and Print*. A DOM `Range` around the text node returns the rectangle of the **glyphs**, and the word "Save" cannot contain a caret. `range.selectNodeContents(textNode); range.getBoundingClientRect()` → `page.mouse.click(cx, cy)`. This is the strongest generic click primitive available and it does not care how badly the page was built.

**20. Two failed selectors on one control means STOP — and the number two is not about selectors.** A failed selector suggests another selector; the loop's own output fuels its next iteration, so it has no internal stopping condition, and from the inside each attempt feels like refinement rather than flailing. Five were written at one date box while a probe had already printed its exact rectangle. The two-failure rule is a termination condition imposed from *outside* the loop, because the loop cannot supply one. Before writing a third: press a key, or click the pixels.

**21. "First match" is not "the one the human sees."** `.modal.show` held three date inputs; two were list filters sitting *under* another div, so a click on them could never land — the element resolved, then the click silently timed out. Disambiguate by a property, not an index: **is this element on top of itself at its own centre?** `document.elementFromPoint(cx, cy)` must return the element or a descendant. Same test finds the right field behind a label.

**22. Poll until the affordance is real; never assert that text exists.** `body.innerText.includes('AH MAO')` passed in **7ms** — the string was already on the page before the popup rendered. Rule 15 in a new costume. For a click, the only honest wait is *can I click it yet*: poll the geometry lookup itself until it returns a box. The signal and the question must be the same thing.

**23. Match on properties, not attributes, for anything a framework updates.** `input[value="13/08/2026"]` matches the **attribute**; DevExtreme (and React, and Vue) only set the **property**. The element was visible, correct, and unmatchable. When a CSS match fails on an element you can see, suspect the attribute/property split before suspecting the page.

**24. Ask for the one blocking fact. A questionnaire is planning handed back to the user.** After failing, seven questions were sent, then a menu, then seven more. *"why not i just give up ai and do my self??"* Identify the single fact that genuinely blocks progress, ask only that, state assumptions for the rest, and proceed. In a test account whose data the user had already called unimportant, the number of blocking facts was zero.

**25. When the deliverable is a tool, a one-off is not a smaller version of it — it is a different thing.** Four hours went into bespoke scripts for one record on one site; the actual ask was an engine that works on anything, so every hand-written selector was off-mission by definition. Ask what is being built before optimising how. **The tell: measuring progress by whether the record appeared, rather than by whether anything reusable exists.**

Corollary for 19-25: rules 19-23 are the mechanics of driving a page that was not built for you, and they collapse into one sentence — **find things by what the human sees (labels, text, geometry), not by what the developer named.** Rules 24 and 25 are about the job, not the page, and they are the expensive ones: a perfect selector on the wrong deliverable is worth nothing.

---

Added 2026-08-13 from the session *after* the engine was built — where the engine existed, the skill said to use it, and three probe scripts were hand-written anyway. Evidence in `STUPID-MISTAKE-LOG.md`. Same work through the finished engine: **4 launches and ~5.5 min → 1 launch and 45.2s.**

**26. A tool with a missing verb does not degrade gracefully — it gets abandoned at the hole. Fill the hole, in the tool, in that turn.** The engine could WRITE records but could not READ a grid, so the first "does this customer already exist?" sent the work back to hand-written probes, and the whole tool went unused for that run. Building the read path afterwards took ~20 lines and it was the same DOM query the probes contained. **The tell is reaching for a new file while a tool for this exact site is sitting there:** that reach is never a small exception, it is the tool being abandoned. Never route around your own tool — every route-around is permanent, because the hole is still there next time.

**27. "Does X already exist?" is not a question to answer — it is a flag on the write.** Checking, reading the answer, deciding, then running is four round-trips through the slowest component in the system (the model). Declaring `ensureAbsent` on the create and letting the tool skip itself costs 1.2s and no decision at all. **Any prerequisite that can be expressed as a condition on the action should never be lifted out into a separate step**, and a dependency chain (customer → quotation) belongs inside one job, not across two commands. Corollary: an idempotent job is re-runnable, so a failed run is retried rather than diagnosed.
