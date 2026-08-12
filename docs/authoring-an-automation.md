# Authoring an Automation

Instructions for writing or retrofitting an automation. Written to be handed to the
model doing the work. Architecture: [two-mode-agent-design.md](two-mode-agent-design.md).

**Authoring is local.** One automation is one file. You should never need to read or
edit another automation to finish this one.

---

## The file

A five-line card, then the code.

```ts
// src/automations/payments/list_pending.ts

/**---
id:       payments_list_pending
domain:   payments
use_when: the user asks what payments are pending or awaiting approval
effect:   read
needs:    [session:admin.atap.solar]
---*/

export async function run({ limit = 50 }) { ... }
```

- `id` — `domain_verb`. This becomes the tool name the agent calls.
- `domain` — the group, and the `id` prefix.
- `use_when` — the condition a user's request satisfies. Write intent, not
  implementation: *"the user asks what payments are pending"*, not *"lists rows from
  the payments table"*.
- `effect` — `read` | `write` | `destructive`.
- `needs` — the session this depends on, e.g. `[session:web.whatsapp.com]`.

Nothing else goes in the card. Argument and return shapes are in the code directly
below it.

---

## `effect` is the one to get right

It compiles into the MCP tool annotation (`readOnlyHint` / `destructiveHint`), which
is what makes the harness confirm before an irreversible action. Wrong value, wrong
gate.

- `read` — observes only. Re-running changes nothing.
- `write` — creates or modifies something recoverable.
- `destructive` — irreversible, or visible to someone else the moment it runs.
  Sending a message is destructive; you cannot unsend it. So is approving a payment.

When torn between two, pick the more severe.

---

## Retrofitting the six existing automations

They are currently **methods on `VaultService`** ([src/service.ts](../src/service.ts)),
with logic in `src/whatsapp.ts` and `src/facebook.ts`. That code is proven. Do not
move, refactor, or reimplement it — write a wrapper that carries the card and
delegates.

Files go under `src/automations/<domain>/` — inside `rootDir`, so they type-check
with no `tsconfig.json` change.

```ts
// src/automations/whatsapp/send_message.ts

/**---
id:       whatsapp_send_message
domain:   whatsapp
use_when: the user wants to send a WhatsApp message to a person or chat
effect:   destructive
needs:    [session:web.whatsapp.com]
---*/

import type { VaultService } from '../../service.js';

export const run = (svc: VaultService, { target, text }: { target: string; text: string }) =>
  svc.waSend(target, text);
```

`run(svc, args)` is the launcher's calling convention, and the annotations are not
optional decoration — `strict: true` is on, so an untyped parameter is a build
error. The types are also where the argument and return shapes live now that the
card no longer carries them.

| id | delegates to | domain |
|---|---|---|
| `whatsapp_list_chats` | `svc.waListChats(limit)` | whatsapp |
| `whatsapp_read_chat` | `svc.waReadChat(target, limit)` | whatsapp |
| `whatsapp_send_message` | `svc.waSend(target, text)` | whatsapp |
| `facebook_read_my_posts` | `svc.fbReadMyPosts(limit)` | facebook |
| `facebook_read_feed` | `svc.fbReadFeed(limit)` | facebook |
| `facebook_comment` | `svc.fbComment(postUrl, text)` | facebook |

---

## Not in scope

- **Do not restructure `src/mcp.ts`.** It stays as the stdio server for Claude
  Desktop; these files are additive. Its `annotations` do have to agree with the
  cards, though — `effect` and `destructiveHint` are the same decision written
  twice, so a card that contradicts its annotation is worse than no card.
- **Do not card the primitives** (`browser_navigate`, `browser_read`,
  `browser_click`, `browser_type`, `browser_screenshot`) or the session tools
  (`list_sessions`, `check_session`, `request_login`). They are not automations —
  the launcher declares them directly.
