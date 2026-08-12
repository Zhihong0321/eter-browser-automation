# Messenger automation — design

**Date:** 2026-08-12
**Deliverable:** `E:\eter-browser\tools\messenger.com\messages.mjs`
**Status:** approved design, not yet implemented

## Purpose

Read and send Facebook Messenger conversations from a script, across two inboxes:

- **Personal** — DMs to Zhi Hong Gan (uid 61552499405887) at `messenger.com`.
- **Page** — customer messages to the Eternalgy business Page, in Meta Business Suite.

One script, one file. `--page` selects the second inbox.

## Non-goals

- No auto-responder. The script has no message loop, no reply rules, no templates, and
  no state that persists between runs. Every send is one explicit command.
- No repo changes. No `src/messenger.ts`, no MCP tools, no rebuild, no daemon dependency.
  The eter-browser daemon is not required and not started.
- No new browser infrastructure. It attaches to the Chrome that `_lib/chrome.mjs` owns.

## Architecture

A single Node ESM script, run directly. It imports `attach()` from
`E:\eter-browser\tools\_lib\chrome.mjs`, which connects over CDP to the shared Chrome
holding the enrolled profile `E:\eter-browser\profiles\agent`. The script closes its own
tab on exit and leaves Chrome running.

Inbox differences are isolated in one surface descriptor:

```js
const SURFACE = {
  personal: { url, threadRow, name, preview, unread,
              msgRow, outgoing, composer, guard },
  page:     { /* same keys, different values */ },
};
```

The keys are fixed by this design; the selector values are filled in from the recon pass
(step 1 below) and are not guessed ahead of it.

Everything downstream — thread listing, message reading, the wrong-thread guard, the
send-and-verify path — reads from the descriptor. No other branch on inbox type exists.
Adding a third inbox later means adding a descriptor, not editing logic.

## CLI

```
node messages.mjs                          list threads: name, preview, unread count
node messages.mjs read "Name" --limit 8    last N messages of one thread, with direction
node messages.mjs send "Name" "text"       send, then verify it left
node messages.mjs reply "Name" "text" --limit 8
                                           read last N, then send — one launch
```

Flags valid on every verb:

- `--page` — drive the Eternalgy Page inbox instead of personal.
- `--limit N` — message count for `read` / `reply`. Default 8.
- `--stay` — leave the tab open (debugging).

A thread is addressed by display name or by thread id; both resolve through the same
lookup, mirroring how the WhatsApp script accepts a name or a phone number.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Unhandled failure |
| `2` | Logged out — login form or `/login` redirect. A human must sign in. |
| `3` | Refused: the open thread is not the requested one. Nothing was sent. |
| `4` | Pressed Enter but no sent message appeared. **Treat as NOT sent.** |

`3` and `4` both mean no message reached anyone. They are distinct so the caller can tell
"I aimed at the wrong thread" from "I aimed correctly and delivery is unconfirmed".

## Rules carried over

Each of these is a rule the machine already paid for; they are requirements, not style.

1. **Paste, never type.** Clipboard write + `Ctrl+V`. No `pressSequentially`, no
   `keyboard.type`. Then wait for the composer to actually contain the text before Enter.
   Typing at ~80ms/char blows the 30s action timeout past a few hundred characters and
   leaves a half-typed draft in a real person's chat.
2. **Wrong-thread guard before every send.** Confirm the open thread matches the request
   from the DOM — not from the fact that a click was issued. Mismatch exits `3`.
3. **Wait on the data's shape, never a fixed sleep.** No `waitForTimeout` as a page-ready
   wait. Wait for a thread row that actually contains text, not for a container to exist —
   skeleton rows satisfy a presence check and yield `undefined` cells that look real.
4. **An empty state is not a settled state.** "No messages" style text is the loading
   state on these apps. Never let it end a wait.
5. **One launch per job.** Every question answered in a single browser session. Cold boot
   is 20-30s; open → look → close → reopen costs minutes.
6. **Close the tab, never the browser.** Via `done()` from `_lib/chrome.mjs`.
7. **A write is not done until the app echoes it back.** `send` is only successful when
   the sent message is visible in the thread.

## Implementation order

1. **Recon pass.** One launch, both inboxes, dumping real structure: thread row / name /
   preview / unread badge, message row / direction / author / text, and the composer with
   whatever attribute identifies the open thread. Output is a selector table, not a
   screenshot. This precedes writing any of the script.
2. **Read path.** `list` and `read`, both inboxes. Verified against the live inbox.
3. **Write path.** `send`, then `reply`. Verified by sending — see Testing.
4. **INDEX.md row.** Add `messenger.com` to `E:\eter-browser\tools\INDEX.md` with exact
   commands, measured runtimes, and every trap hit during recon.

Step 1 is not optional. Every site in `INDEX.md` broke a generic DOM assumption:
`role="article"` renders empty on FB profiles, `.message-in` no longer exists in the
current WhatsApp build, `table tbody tr` matches skeletons on admin.atap.solar. Messenger
is Comet — randomised classes, virtualized lists — so selectors ported by analogy from the
WhatsApp script will not transfer.

## Testing

Read verbs are verified against the live inbox: run them and confirm the output matches
what the same inbox shows on screen.

The write path can only be verified by sending. The first `send` goes to a thread chosen
by the user for that purpose — not to a customer. Exit `0` requires the message to be
visible in the thread afterwards; anything less is `4`.

**Outbound sends are confirmed with the user before each one.** The script having a `send`
verb does not change this — the confirmation is at the point of use, not in the code.

## Known risks — resolved by recon, 2026-08-12

Both predictions in the original draft were wrong, in opposite directions. Recorded here
because the reasoning that produced them will recur.

**"The Page inbox may be inaccessible" — wrong, it works.** Meta Business Suite loads
authenticated against the Eternalgy Page (`asset_id=151613461367324`) with 8 live customer
conversations. No extra access was needed.

**"Timestamps may be obfuscated" — wrong, they are exact.** Personal messages carry
`aria-label="At <date>, <time>, <author>: <text>"` and Page messages show
`18/09/2024, 17:47`. The obfuscation that afflicts FB *post* timestamps does not apply to
Messenger. The script reports real dates.

**The real blocker was neither: `messenger.com` is logged out.** It is a separate cookie
domain from `facebook.com`, and the enrolled session does not cover it — the personal
inbox is reachable only at `facebook.com/messages/t/`. The original design named the wrong
URL for the inbox it considered lowest-risk.

**Still open — Messenger's multi-client behaviour is unconfirmed.** WhatsApp Web allows
exactly one active client and a second tab kills the first. Messenger is a cookie session
and is expected to tolerate multiple tabs, but this is not verified. The script reuses an
existing tab on the same origin, which `_lib/chrome.mjs` already does by default.

**Still open — the write path is unverified.** `send` and `reply` are implemented but have
never been run; verifying them means sending a real message. See Testing.

## Status

| Verb | Personal | Page |
|---|---|---|
| `list` | verified, 14s | verified, 8 conversations |
| `read` | verified against ground truth | verified against ground truth |
| `send` | **not run** | **not run** |
| `reply` | **not run** | **not run** |

Direction detection was validated by picking threads whose last message was known-outgoing
from the `You:` prefix in the list preview, then confirming `read` reported `→ you`.
