# AUTOMATION-PERF.md

How to make this automation engine *fast for an AI caller*.

Status: design doc. Nothing here is implemented yet.

---

## 1. The real problem

Measured today:

| | time |
|---|---|
| The automation itself (script runs, job completes) | ~2.5s |
| Prompt → AI actually calls the script | 25–40s |

The engine is not slow. **The AI's approach to the engine is slow.**

The cost unit that matters is the **model round-trip**: every time the AI must
call a tool, read the result, and think again before it can act, that costs
~5–8 seconds of wall clock. Four round-trips before real work starts is 30
seconds, and no amount of optimising the browser layer touches it.

So the optimisation target is not milliseconds of Playwright. It is:

> **Minimise the number of model round-trips between the user's prompt and the
> job being done.**

Ideal is one.

---

## 2. Where the round-trips are going

Two separate leaks. They need different fixes.

### Leak A — the tools are primitives, not jobs

`src/mcp.ts` currently exposes 14 tools. Five of them are generic browser
primitives:

```
browser_navigate
browser_read
browser_click
browser_type
browser_screenshot
```

These are a *driver*, not an API. Any real job built out of them looks like:

```
browser_navigate  →  browser_read (dump DOM)  →  think
browser_click     →  browser_read (dump DOM)  →  think
browser_type      →  browser_screenshot       →  think
browser_click     →  browser_read             →  think
```

That is 8–12 round-trips. At 5–8s each: 40–90 seconds, plus a large amount of
raw DOM and screenshot bytes pushed through context. This is exactly the "no
more screenshot, and read DOM again and again" complaint.

The other tools are already the right shape:

```
whatsapp_send_message
whatsapp_list_chats
whatsapp_read_chat
facebook_read_my_posts
facebook_read_feed
facebook_comment
```

One call = one finished job = one round-trip. **These are the model to copy.**

### Leak B — the AI doesn't know the tool exists until it goes looking

Even with a good tool, the AI spends round-trips discovering it: reading
`INDEX.md`, opening a script to work out its arguments, guessing at output
shape. In long sessions MCP tools are *deferred* — the model sees only a name
and must run a search call before it can invoke anything.

Discovery is a tax paid before every job. It has to be paid once, up front, or
not at all.

---

## 3. The fixes

### Fix 1 — Promote every routine into a task-level tool

**Rule: the unit of an MCP tool is a whole job, not a browser action.**

If a routine is already scripted, it must not be reachable only by composing
primitives. It gets its own tool with a domain verb:

```
payments_list_pending()          -> { rows: [...] }
payments_approve({ id })         -> { ok, id }
whatsapp_send_message({ to, text })
```

Test for whether a tool is coarse enough: *can the AI call it correctly with
zero prior reads, and is one call enough to finish the job?* If no, it is still
a primitive.

The primitives stay — they are the escape hatch for unscripted work — but they
stop being the normal path. Every routine that gets performed twice should
graduate into a task tool.

### Fix 2 — Return structured data, never pixels or DOM

Task tools return JSON the model can act on directly:

```json
{ "ok": true, "data": [...], "error": null }
```

Never a screenshot, never an HTML dump, unless the user explicitly asked to
*see* something. Screenshots and DOM dumps are for debugging the automation,
not for feeding the model. A uniform envelope also means the AI does not need
to read anything to know how to parse a result.

### Fix 3 — Make the menu free

The tool list must be in context before the first prompt, at zero tool calls.

- Keep a short verb table (≈25 lines, hard cap ~30) in the project `CLAUDE.md`
  or repo `README.md` — whichever is auto-loaded.
- One line per tool: name, args, what it returns. No prose.
- `docs/` and `INDEX.md` stay as deep reference, off the critical path.

Names carry the routing. `payments_*`, `whatsapp_*`, `facebook_*` — the domain
prefix should make selection obvious without reading a description.

Tool descriptions matter too: they are what the AI matches against when tools
are deferred. Write them as "use this when the user asks X", not as a
restatement of the function signature.

### Fix 4 — Keep the browser warm

None of the above matters if each call cold-starts a browser: 2.5s becomes 15s.

There is already a daemon/service layer (`src/service.ts`, `src/api.ts`). Every
task tool should route through a persistent, already-authenticated browser
context. **Measure this before building anything else** — if cold start is the
dominant cost, it outranks every other item in this document.

---

## 4. Target

| stage | now | target |
|---|---|---|
| discovery (find + understand the tool) | 15–30s | 0s |
| invocation | 1 round-trip | 1 round-trip |
| execution | 2.5s (or 15s cold) | 2.5s warm |
| **prompt → done** | **25–40s** | **6–9s** |

---

## 5. Order of work

1. **Measure cold start.** Is a call 2.5s or 15s? Everything else is guesswork
   until this is known.
2. **Verb table into the auto-loaded file.** Cheapest possible change, kills
   Leak B outright.
3. **Promote the top 3–5 most-used routines** into task-level MCP tools with
   the `{ok, data, error}` envelope.
4. **Route task tools through the warm daemon.**
5. Only then consider anything new.

---

## 6. Explicitly not doing

- **A separate HTTP API server mirroring the target site.** MCP already is the
  API surface. A second one is a second thing to keep alive and a second place
  for bugs.
- **Deleting the browser primitives.** They are the fallback for unscripted
  work. They just stop being the default path.
- **A large tool catalogue.** Past ~30 tools, selection itself becomes a cost
  and the AI starts guessing. Prefer few, coarse, well-named tools.

---

## 7. Open question worth one afternoon

Does the target site render its pages from internal JSON XHR calls?

If yes, task tools can hit those directly with the logged-in session instead of
driving the DOM: far faster, and no selectors to rot. Worth one DevTools
network pass on the most-automated pages before writing more DOM code.

Caveat: internal endpoints are unversioned and can break without notice. Sane
split is **reads via internal API, writes via UI**, keeping the DOM path as
fallback for anything depended on.
