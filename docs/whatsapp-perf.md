# WhatsApp automation — where the time actually goes

Scope: `src/whatsapp.ts`, `src/human.ts`, `src/browser.ts`, `src/vault.ts`.
Companion to `AUTOMATION-PERF.md`, which covers a **different axis** (AI round-trips and
tool granularity). This one is about engine latency — the seconds burned *inside* a call.

**Headline: almost none of the elapsed time is work.** It is deliberate `sleep()`,
character-by-character typing, and re-paying a 20–30s app boot that a warm tab would have
made free. Going headless addresses none of that.

---

## 0. Status — implemented and MEASURED 2026-08-12

Measured on a live linked account, same machine, same chats, old code vs new, via the running
daemon's HTTP API. Read path only — no message was sent.

| call | before | after | |
|---|---|---|---|
| `listChats` first call (WhatsApp booting) | 7,990ms | 8,799ms | unchanged — it is WhatsApp's own boot |
| `listChats` warm | 963ms / 991ms | **331ms / 392ms** | ~2.7x |
| `readChat` by name | **failed, 30,960ms** | **3,185ms** | was broken, now works |
| `readChat` same chat again | failed, 64ms | 1,901ms | was broken |
| `readChat` different chat | failed, 56ms | 2,713ms, correct chat | was broken |
| switch back to the first chat | — | 1,620ms, correct chat | race fixed |
| `readChat` by phone number | 9,967ms | **5,203ms** | ~1.9x |
| `sendMessage` warm, 36 chars | — | **2,051ms** | verified delivered |
| `sendMessage` cold, 334 chars w/ emoji | — | 45,542ms | 35.7s of it was the app booting |

Send phases warm: `open=1073ms compose=310ms confirm=668ms`. A 669-char multi-line message
with emoji pasted and delivered intact as ONE message — the old code would have spent ~67s
typing it and hit the 30s action timeout partway through.

**The by-name path was not slow, it was dead.** `SEARCH_SEL` matched on
`[aria-label*="Search"]`, and the search box in this WhatsApp build has no aria-label at all
(measured: `""`). Every by-name `readChat`/`sendMessage` sat in `pressSequentially` until the
30s action timeout and then reported "search box not found — the app may still be loading",
which reads like a timing problem. Only the phone path worked. Fixed by anchoring on
`[role="textbox"]:not([contenteditable="true"])` — the same structural distinction
`COMPOSER_SEL` already relied on.

Per-phase timings now come from the `[wa]` lines the code writes to stderr, e.g.

```
[wa] listChats app=20ms overlays=321ms read=32ms total=373ms
[wa] openChat(IT Eternalgy) app=64ms find=509ms open=696ms total=1269ms
[wa] readChat(IT Eternalgy) open=1269ms settle=339ms read=6ms total=1614ms
```

Note `overlays` is now the largest slice of a warm `listChats` (~300 of ~370ms) — two
`locator.count()` round-trips that run even when no dialog exists. That is the next thing to
cut if warm list latency matters.

### The emoji false negative — found by actually sending

The first live send **delivered correctly and was reported as a failure**:

```
{"ok":false,"detail":"Put the message into \"+60 11-2100 0099\" and pressed Enter, but it
 never came back as a sent outgoing message. Treat as NOT sent and check the browser."}
```

The message was in the chat, one piece, status `Read`. The delivery check builds a "needle"
from the first 60 characters of the text and looks for it in the row's `innerText` — but
**WhatsApp renders emoji as images, so they contribute nothing to `innerText`**. A message
starting `🤖 Automation test` reads back as `Automation test`, the needle never matched, and
the check burned its full 20s timeout before declaring failure.

This is the dangerous direction of wrong. A caller told a delivered message failed will send it
again, and the whole point of this function is that it never lies about delivery. Fixed by
stripping emoji from both sides before comparing, with a row-count fallback for an all-emoji
message (which strips to nothing, and `includes('')` matches anything). Re-tested with emoji at
both ends: `ok:true`, `Delivered (Read)`, confirm time 20,117ms → 3,010ms.

The bug predates this work — the old code used the same raw-text needle — but it mattered less
when messages were typed, because typing mangled emoji anyway.

### Also verified

| check | result |
|---|---|
| `tsc --noEmit` + `npm run build` | pass |
| The five `PERF_ARGS` reached the real Chrome command line | pass |
| `pin()` holds the browser open past the idle timeout | pass |
| A closed pinned page releases the pin | pass |
| No `sleep`/`pause`/`humanType`/`humanClick` left in `whatsapp.ts` | pass |

**Found while debugging, NOT fixed** — `requireReady` runs `deepProbe`, which does
`page.goto(rec.url)` on a throwaway tab ([probe.ts:113](../src/probe.ts:113)). For WhatsApp
that opens a **second WhatsApp Web client** just to check readiness, then throws it away: it
violates the one-tab rule this codebase is otherwise careful about, and costs a full app boot
before the real work starts. Pre-existing, and it touches Facebook and admin.atap.solar too, so
it was left alone rather than changed unilaterally.

---

## 0c. Send budget — added after the speedup, because of it

Making sending 14x faster removes the accidental brake that used to exist. Twenty seconds of
typing per message was, by accident, a rate limit. At 2s per send it is gone, so the limit has
to be deliberate.

The existing `RateLimiter` (12 actions/min, shared with Facebook and the generic click/type
primitives) is the wrong instrument. It counts actions against the clock; WhatsApp does not
ban numbers for acting quickly, it bans them for contacting people who then block and report.
12/min is 720/hour — a script messaging 200 strangers passes through it at full speed.

`src/sendlimit.ts` adds a budget shaped like the risk instead:

| limit | default | why |
|---|---|---|
| messages/minute | 6 | light pacing, nothing more |
| **distinct recipients/hour** | 15 | the real exposure. Ten messages to one chat cost one slot — replying in a live conversation is not the risky pattern |
| **new recipients/hour** | 5 | people we have never messaged. The ban-risk number, deliberately smallest |
| messages/day | 100 | WhatsApp reasons in days, not minutes |
| max wait | 15 min | see below |

Design notes that are load-bearing:

- **Reads stay unmetered**, deliberately. Nothing is at stake in reading your own chat list.
- **The slot is booked before the send, not after a success.** A failed send still reached
  WhatsApp; counting only successes is how a retry loop turns one refused message into fifty.
- **State persists to `<vaultHome>/send-history.json`.** The daemon restarted six times during
  one afternoon of this work; an in-memory counter hands back a fresh daily budget every time
  it comes up, which makes a daily cap worth nothing.
- **A distinct-recipient slot frees when that recipient's LAST message ages out**, not the
  oldest record overall — otherwise the count would appear to drop while messages to that
  person were still inside the window.
- **`maxWaitMs` exists despite the stated preference for "wait, then continue".** Waiting is
  right for minute-scale pacing. Waiting six hours inside an HTTP request is not waiting, it is
  a hang the caller cannot survive. Past 15 minutes it refuses with a message naming which
  limit is binding and stating that nothing was sent. Set it to `0` for the literal
  wait-forever behaviour.

Budget is visible at `GET /api/status` under `sendBudget`. Limits live in the manifest's
`settings.whatsappSend` and merge one level deep, so overriding one of them keeps the defaults
for the rest.

Verified by unit test (`SendLimiter` arithmetic, no browser): repeated messages to one person
cost one distinct slot; the 4th distinct recipient is refused while an existing one still goes
through; the new-recipient cap binds independently and tighter; the daily ceiling holds;
per-minute pressure waits rather than refusing; the budget survives a restart; and a person
addressed by name and by number collapses to one key.

**These limits reduce the chance of losing the number. They do not make automating WhatsApp
Web permitted — it is against WhatsApp's terms at any pace.** For customer messaging at
volume, the official WhatsApp Business API is the route that cannot be banned for automation.

---

## 0b. Original pre-implementation status (superseded by §0)

Fixes 1-5 below are implemented (`src/whatsapp.ts`, `src/browser.ts`, `src/service.ts`) plus
the launch args from §6. Headless and resource blocking were deliberately NOT done.

Verified live:

| check | result |
|---|---|
| `tsc --noEmit` + `npm run build` | pass |
| `waitForApp` against the live app | returned `logged_out` in 4.8s |
| The five `PERF_ARGS` reached the real Chrome command line | pass, alongside the manifest's own args |
| `pin()` holds the browser open past the idle timeout | pass (still `running` 5s after a 3s timeout) |
| A closed pinned page releases the pin | pass (browser idle-closed afterwards) |
| No `sleep`/`pause`/`humanType`/`humanClick` left in `whatsapp.ts` | pass |

**NOT verified: the data path — `listChats`, `readChat`, `sendMessage`.** WhatsApp Web on
this profile is currently showing the **QR code**: the device is not linked, so every call
correctly reports `logged_out` and no chat data can be read. Re-linking needs a human with the
phone. The projected numbers in §1 and §7 therefore remain projections. Both the old and the
new code fail identically against the QR screen, so this is not a regression — but the speedup
is unmeasured until someone re-scans.

**Also found while debugging, NOT fixed** — `requireReady` runs `deepProbe`, which does
`page.goto(rec.url)` on a throwaway tab ([probe.ts:113](../src/probe.ts:113)). For WhatsApp
that opens a **second WhatsApp Web client** just to check readiness, then throws it away: it
violates the one-tab rule this codebase is otherwise careful about, and costs a full ~25s app
boot before the real work starts. It is pre-existing and it touches Facebook and
admin.atap.solar too, so it was left alone rather than changed unilaterally. It is probably now
the largest remaining cost on a cold call.

---

## 1. The latency budget

Estimates derived from the constants in the code, not stopwatch measurements — the
instrumentation in §7 exists to replace them with real numbers. "Sleep" = time the process
spends deliberately idle.

### Warm (`listChats`)

| step | cost | sleep? |
|---|---|---|
| `resolvePage` | ~30ms | |
| `waitForApp` → one `evaluate` | ~10ms | |
| `dismissOverlays` → 2× `locator.count()` even when no dialog | ~20ms | |
| `pause(400, 900)` — [whatsapp.ts:224](src/whatsapp.ts:224) | **~650ms** | ● |
| `evaluate(READ_CHATS)` | ~30ms | |
| **total** | **~740ms** | **88% sleep** |

### Warm (`readChat "Leon Eternalgy"`)

| step | cost | sleep? |
|---|---|---|
| `humanType(search, target)` — 14 chars @ 55–145ms | **~1,400ms** | ● |
| `pause(1200, 2200)` — [whatsapp.ts:270](src/whatsapp.ts:270) | **~1,700ms** | ● |
| `humanClick(row)` — scroll + `pause(250,700)` + click delay | **~500ms** | ● |
| `pause(1200, 2400)` — [whatsapp.ts:282](src/whatsapp.ts:282) | **~1,800ms** | ● |
| composer poll, `sleep(750)` — [whatsapp.ts:291](src/whatsapp.ts:291) | 0–750ms | ● |
| `waitForMessages`, `sleep(500)` × ≥2 — [whatsapp.ts:372](src/whatsapp.ts:372) | **~1,000ms** | ● |
| `evaluate(READ_MESSAGES)` | ~30ms | |
| **total** | **~6.5s** | **~99% sleep** |

### Warm (`sendMessage`, 200-char body)

| step | cost | sleep? |
|---|---|---|
| `openChat` (above) | ~5.4s | ● |
| `humanType(box, text)` — 200 chars @ ~100ms + word gaps — [whatsapp.ts:415](src/whatsapp.ts:415) | **~22s** | ● |
| `pause(500, 1200)` | ~850ms | ● |
| delivery poll — `sleep(1000)` runs *before* the first check — [whatsapp.ts:421](src/whatsapp.ts:421) | ~1–2s | ● |
| **total** | **~29s** | |

### Cold (idle timer fired)

`settings.idleTimeoutMs` is 5 minutes ([config.ts:37](src/config.ts:37)) and closes the whole
context ([browser.ts:183](src/browser.ts:183)). The next call pays:

| step | cost |
|---|---|
| Chrome launch + persistent profile load | 3–5s |
| `goto` → domcontentloaded | ~2s |
| WhatsApp SPA boot: bundle, IndexedDB, Noise handshake, chat sync → `#pane-side` | **15–25s** |
| **cold surcharge** | **~20–30s on top of the warm cost** |

Any gap longer than five minutes between jobs — i.e. essentially every interactive use —
pays this. It is the single largest line item in the whole system.

---

## 2. Fix 1 — Stop re-paying the app boot *(biggest win, ~20–30s)*

Two separate things throw the warm SPA away.

**(a) The idle timer closes the context.** `BrowserManager` has no concept of a page that is
expensive to recreate. For WhatsApp the tab *is* the asset — a linked-device client that took
25s to hand-shake and sync. Add a pin: a page marked pinned suppresses
`#armIdle()`, so the context stays up as long as WhatsApp is loaded.

Leaving WhatsApp Web open indefinitely is its normal usage mode, and the daemon already
enforces one-tab-only. Cost is ~300–500MB resident for the renderer.

**(b) `openChat` hard-navigates on the phone path.**
[whatsapp.ts:260](src/whatsapp.ts:260) does `page.goto(APP_URL + 'send?phone=…')`. Same origin
or not, `goto` is a full document load — it tears down the SPA and re-boots it. A read-by-phone
therefore costs a **full cold boot every time even when the browser is warm**, which is exactly
why the measured phone path is ~13s.

Fix: type the number into the in-app search box like the name path does, and click the
result. Keep `send?phone=` strictly as the fallback for a number with no existing chat, where
a hard navigation is genuinely unavoidable.

---

## 3. Fix 2 — Paste, never type *(~20s on any real message)*

[whatsapp.ts:415](src/whatsapp.ts:415) calls `humanType(box, text)`, which is
`pressSequentially` at 55–145ms/char plus word gaps. A 200-char message is ~22 seconds of pure
keystroke delay, and past ~370 chars it blows Playwright's 30s action timeout and leaves a
half-typed draft in the composer.

The standalone `E:\eter-browser\tools\web.whatsapp.com\messages.mjs` was already fixed to use
clipboard write + `Ctrl+V`. **The daemon was not.** Port it:

1. write `text` to the clipboard, 2. focus composer, 3. `Ctrl+V`,
4. `waitForFunction` that the composer's text contains the payload, 5. `Enter`.

Step 4 is not optional — it is what turns paste from "fire and hope" into a verified write.
Same for the search box: `fill()` instead of `humanType`.

---

## 4. Fix 3 — Retire the human-pacing on the WhatsApp path *(~4–6s/call)*

`human.ts` justifies itself as defence against "impossible timing and burst rate". That
reasoning holds for **Facebook** — a cookie session on a site with active anti-automation
heuristics. It does not transfer to WhatsApp Web:

- Auth is the Noise-protocol linked-device keypair in IndexedDB, not a scraped cookie.
- The server sees protocol frames, not DOM events. Keystroke cadence inside a
  `contenteditable` never leaves the browser; only the final send frame does.
- The one real risk — a bulk-messaging ban — is a **volume/rate** signal, not a cadence one.

So: **keep `RateLimiter`** ([browser.ts:28](src/browser.ts:28)) — that is the control that
actually maps to the actual risk — and drop `pause()` / `humanType` / `humanClick` from
`whatsapp.ts`. Leave `human.ts` untouched for `facebook.ts` and the generic
`browser_click`/`browser_type` primitives in `service.ts`, where the threat model is real.

This is a judgement call with a small residual risk, so it is worth making it deliberately
rather than by omission, and worth keeping behind a setting.

---

## 5. Fix 4 — Event-driven waits instead of sleep-polling *(~1–3s/call, plus a latent bug)*

Every hot-path wait is `while (…) { await page.evaluate(…); await sleep(N) }`. That pattern
pays two costs: it wastes ~N/2 on average, and each poll is a CDP round-trip. `page.waitForFunction`
runs the predicate **inside the page** and resolves within a frame of the condition flipping.

| site | now | replace with |
|---|---|---|
| `waitForApp` [:150](src/whatsapp.ts:150) | `sleep(1000)` loop | `waitForFunction` on ready/logged-out, `polling: 250` |
| `openChat` composer [:291](src/whatsapp.ts:291) | `sleep(750)` loop | `waitForFunction` on the composer label **matching the target** |
| `waitForMessages` [:372](src/whatsapp.ts:372) | `sleep(500)` × 16 | in-page `MutationObserver`: resolve when `#main` is quiet 300ms and rows > 0 |
| send delivery [:421](src/whatsapp.ts:421) | `sleep(1000)` × 15, sleep *first* | `waitForFunction` on last outgoing row's status ≠ `pending` |

**The latent bug.** `openChat` polls `composerLabel(page)` and breaks on the first non-null
label — *any* label, including the composer of the chat left open by the previous call. It can
return the wrong chat name instantly; `sendMessage`'s guard then rejects the send
([whatsapp.ts:400](src/whatsapp.ts:400)). The only thing suppressing this today is the
`pause(1200, 2400)` on line 282 — i.e. a sleep is being used as a correctness mechanism.
Waiting for the label to *match the target* fixes the race and deletes the sleep in one move.

Also worth setting a context-wide `setDefaultTimeout` — there is none anywhere in `src/`.

---

## 6. Headless — the honest answer

Headless is close to **orthogonal** to this problem. Flip it today and you save maybe 10–20%
of a cost that is ~95% sleep. Fixes 1–4 first; headless after.

When you do get there:

- **`headless: false` today** ([vault.ts:56](src/vault.ts:56)). The point of patchright is a
  stealth-patched fingerprint, and headless changes it. Low risk for WhatsApp (protocol-auth,
  not heuristic-auth), real risk for Facebook on the same profile. If the box has a display,
  **headed-but-offscreen** (`--window-position=-32000,-32000`) gives the headed fingerprint
  with no visible window — usually the better trade than true headless.

- **Trap: `viewport: null` + `--start-maximized`** ([browser.ts:62](src/browser.ts:62),
  [vault.ts:57](src/vault.ts:57)). `--start-maximized` is meaningless headless, so the window
  falls back to 800×600. The WhatsApp sidebar is **virtualized** — a short viewport means
  fewer `[role="row"]` nodes exist, and `listChats(limit: 50)` will silently return ~12. If you
  go headless you must pass an explicit `--window-size` tall enough for the requested limit,
  or teach the extractor to scroll. This is the classic failure-toward-plausible: no error,
  just a short list.

- **Resource blocking is completely absent** — no `page.route()` anywhere in `src/`. This is
  the one genuinely large headless-adjacent win. WhatsApp pulls an avatar for every sidebar
  chat plus media thumbnails and emoji sprite sheets, none of which any extractor reads.
  Blocking `image` / `media` / `font` on the WhatsApp page cuts a lot of network and decode.
  **Never block `script` / `xhr` / `fetch` / `websocket`** — the app is nothing but those.
  Gate it behind a flag and verify the chat list still populates; encrypted media fetches may
  retry noisily.

- **Missing launch args that matter specifically because we now keep the tab warm.** A
  background or occluded Chrome window gets its timers throttled, which throttles the SPA we
  are deliberately keeping hot:

  ```
  --disable-background-timer-throttling
  --disable-backgrounding-occluded-windows
  --disable-renderer-backgrounding
  --disable-features=CalculateNativeWinOcclusion   # Windows-specific, and this box is Windows
  --mute-audio
  ```

  These are worth adding **whether or not** you go headless.

---

## 7. Order of work

1. **Instrument first.** Log per-phase ms (`boot`, `open`, `type`, `confirm`) on every
   WhatsApp entry point. Every number in §1 is derived from constants, not measured; the whole
   plan should be re-ranked against real output. `AUTOMATION-PERF.md` reaches the same
   conclusion from the other direction.
2. Paste instead of type (§3) — smallest diff, largest single-call win, also fixes a real
   timeout bug.
3. Pin the WhatsApp page against idle-close, and drop the `send?phone=` hard navigation (§2).
4. Delete the `pause()` calls from `whatsapp.ts` (§4).
5. Swap the four sleep-loops for `waitForFunction`, fixing the composer race (§5).
6. Add the throttling args; only then evaluate headless + resource blocking (§6).

Projected, warm: `listChats` ~740ms → ~90ms · `readChat` ~6.5s → ~1s ·
`sendMessage`(200ch) ~29s → ~2s. Cold surcharge ~25s → amortized to zero.

---

## 8. Not doing

- **Driving WhatsApp's internal store** (`window.require('WAWebChatCollection')` /
  `Store.Chat`, the whatsapp-web.js approach). It is the real ceiling — structured data in one
  `evaluate`, no DOM, no virtualization, immune to the obfuscated-class churn the INDEX warns
  about. It is also the highest-maintenance option on the board: the internal module IDs move
  every WhatsApp build. Revisit only if selector rot becomes the recurring failure, not for speed.
- **Chasing an internal JSON API** (the open question in `AUTOMATION-PERF.md`). There isn't
  one — WhatsApp Web is a WebSocket + Noise binary protocol over a local WASM/IndexedDB store,
  not an XHR-rendered app. That option is off the table here even though it applies to
  `admin.atap.solar`.
- **Removing `human.ts`.** Facebook and the generic primitives still need it.
