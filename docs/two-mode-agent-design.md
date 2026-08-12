# Two-Mode Agent Design

How the automation engine is driven by the Claude Agent SDK.

Status: design doc. Nothing here is implemented yet. Companion to
[AUTOMATION-PERF.md](../AUTOMATION-PERF.md), which sets the performance targets this
design is built to hit.

---

## 1. The thesis

There are two jobs, and they have opposite economics.

**Authoring an automation** is exploratory. Navigate, dump DOM, screenshot, click,
find the selectors, work out the flow. Many model round-trips, lots of raw bytes —
and that is fine, because it happens once per routine with a human watching.

**Running an automation** is not exploratory at all. "Approve the pending payments"
should be one tool call.

These are not two apps. They are a **compiler and a runtime**. Authoring's product
*is* a runtime tool. Every routine that graduates makes the runtime wider and
cheaper. AUTOMATION-PERF.md's "the primitives stay — they are the escape hatch"
is really saying: *primitives belong to the authoring side.*

---

## 2. Three surfaces

| Surface | Who drives | Tools | Round-trips | Exit condition |
|---|---|---|---|---|
| **Fast mode** | Claude Agent SDK | 3–10 typed automation tools, no primitives | 1 | Job done |
| **General mode** | Claude Agent SDK | Primitives + session tools + 2 generic registry tools | Many | Job done, automation proposed |
| **Design mode** | Claude Desktop | Primitives + filesystem | Many | Automation saved |

Fast and general mode are both *run mode* — a human chats with an Agent SDK app.
The human never invokes an automation directly; the agent picks it.

**General mode and design mode are nearly the same agent.** Same primitives, same
browser, same auth flow, same human in the loop. The only real difference is the
exit condition. This design collapses them: general mode promotes its own work
(§6), so a separate Claude Desktop authoring session becomes the exception rather
than the rule.

---

## 3. Scale: shard per agent, not per platform

AUTOMATION-PERF.md caps the tool catalogue at ~30, past which "selection itself
becomes a cost and the AI starts guessing."

**That cap is per agent, not per platform.** The platform holds unlimited
automations. A *specialized agent* is a named profile of 3–10 of them plus its own
persona. No single agent ever approaches the cap, so the flat verb table is not a
stopgap that gets outgrown — it is correct permanently, because it always renders a
small slice.

This is why no progressive-disclosure machinery is needed for fast mode. No Skills,
no deferred tool loading, no tool search. Discovery cost stays at zero.

---

## 4. Three artifacts

### 4.1 Registry — platform-wide, unlimited

**One automation is one file: a frontmatter card on top, the code below.** The
registry is not a file anyone maintains — it is a scan over those cards. The thing
you edit is the thing you document, so the two cannot drift, and promotion (§6)
writes exactly one file.

```ts
// automations/payments/list_pending.ts

/**---
id:       payments_list_pending
domain:   payments
use_when: the user asks what payments are pending or awaiting approval
effect:   read
needs:    [session:admin.atap.solar]
---*/

export async function run({ limit = 50 }) { ... }
```

#### The card

| Field | Purpose |
|---|---|
| `id` | Becomes the tool name in fast mode |
| `domain` | Groups the catalogue; the prefix that makes routing obvious |
| `use_when` | Written as *"the user asks X"*, not as a restatement of the signature — this is what the model matches against |
| `effect` | `read` \| `write` \| `destructive` |
| `needs` | Which session/login this depends on |

Nothing else. Argument and return shapes live in the code directly below the card.

**Two layers.** The card is what `search_automations` returns and what the
fast-mode verb table renders from — small enough that fifty fit in one search
result. The body (full arg/return schemas, handler) is read only when an
automation is actually invoked. This is what makes "browse the tools" cost a
search instead of a code scan.

#### Why `effect` and `needs`

**`effect`** is what tells the agent whether to act or confirm first, and it is
not a bespoke invention: MCP's `tool()` takes
`annotations: { readOnlyHint, destructiveHint, idempotentHint }`, so `effect`
compiles straight into the standard annotation. The confirm-before-destructive
gate then comes from the harness rather than from having remembered to write
"please confirm before approving payments" into a prompt.

**`needs`** lets the agent check the session *before* attempting rather than
failing halfway. It already has `check_session` and `request_login`; this is what
tells it which to check.

### 4.2 Agent profiles — the shard

One markdown file per agent, e.g. `agents/payments-clerk.md`. Names 3–10 automation
ids plus persona and house rules. Human-readable, git-tracked, hand-editable.

### 4.3 Launcher — the only new runtime code

At `query()` time: read profile → pull those entries from the registry → build the
tool set and the system prompt from the *same* entries.

```
profile = read(agents/payments-clerk.md)
entries = registry.pick(profile.automations)      // 3–10 of N

query({
  prompt: userMessage,
  options: {
    mcpServers:  { auto: createSdkMcpServer({ tools: entries.map(toTool) }) },
    systemPrompt: render(profile, entries),        // persona + verb table
    strictMcpConfig: true,
    disallowedTools: [ ...primitives ],
  }
})
```

`render()` is AUTOMATION-PERF.md's Fix 3, automated. Because the verb table and the
tool set come from one source, they cannot drift.

---

## 5. Two projections of one registry

The registry is projected differently per surface. This is the core design move.

**Fast mode — compile it.** N registry entries become N typed MCP tools, each with
its own name and schema. Zero discovery cost; the agent sees exactly what it can do.
Bounded by the ~30 cap, which per-agent sharding guarantees is never reached.

**General mode — query it.** The automations are *not* tools. Two generic tools stand
in for all of them:

- `search_automations(query)` → matching entries with their invocation signature
- `run_automation(id, args)` → dispatcher that can invoke any entry

Registry size becomes irrelevant to context size. Discovery costs one round-trip
instead of zero — acceptable, because general mode is explicitly the slow path.

### General mode's full surface

| Tool | Status |
|---|---|
| `browser_navigate` / `read` / `click` / `type` / `screenshot` | exists — unscripted work |
| `request_login(siteId)` | exists — opens agent Chrome at the login page and asks the human to sign in |
| `list_sessions` / `check_session` | exists — check before attempting |
| `search_automations` | new |
| `run_automation` | new |

Nine tools, unlimited platform behind them.

Fast mode gets its typed tools plus `request_login` for auth recovery, and **no
primitives**. A fast agent that needs to improvise should hand off to general mode,
not grind through twelve round-trips.

---

## 6. The promotion loop

When general mode completes a job using primitives, **the transcript is the recipe**
— the model just proved the selectors and the flow work, on this site, today.
Promoting there and then avoids re-deriving all of it in a separate session.

```
user asks → no automation matches → general mode does it with primitives
         → proposes an automation → human approves in chat
         → registry entry written → next launch, it is a typed tool
```

Requires write access to the registry and a **human approval gate** — the agent
proposes, the human confirms, and only then does the entry land. It is never
promoted silently.

This is what closes the compiler/runtime loop without a context handoff.

---

## 7. Decisions and their reasons

**In-process SDK MCP server** (`type: "sdk"`, via `createSdkMcpServer`), not stdio,
not HTTP.

- The daemon already exposes every capability over HTTP on `127.0.0.1`, so a tool
  is a `fetch()` wrapper — no new infrastructure.
- `createSdkMcpServer({ tools: [...] })` takes a **runtime array**. The tool set can
  be assembled per session from a profile. A stdio subprocess owns its own fixed
  tool list, so a new automation would mean editing and rebuilding `src/mcp.ts`.
- Tool description, schema, and verb table live in one file and cannot drift.
- Drops a process from the chain: agent → daemon, instead of agent → mcp subprocess
  → daemon.

HTTP transport was rejected because the daemon speaks plain REST, not MCP; using it
would mean building an MCP HTTP endpoint — the thing AUTOMATION-PERF.md explicitly
declines to do.

**Generated `systemPrompt` string, not CLAUDE.md.**

- The SDK does not load CLAUDE.md by default; it is gated behind
  `settingSources: ["project"]`, which also pulls in every other project setting.
- CLAUDE.md is project-scoped — one per directory. Per-agent prompts would mean
  juggling `cwd` per agent.
- `systemPrompt` accepts a plain string, built at `query()` time. No disk write, no
  race between concurrent agents, no cwd dependency.

The per-agent markdown profile stays a file — that part of the instinct is right.
It is *input to the generator*, not something the SDK loads.

**`allowedTools` is not the restriction lever.** It is an auto-approve list;
unlisted tools fall through to `permissionMode` and `canUseTool` rather than being
blocked. The levers that actually shape the menu are `tools` (what exists),
`disallowedTools` (a bare name removes the tool from context), and
`strictMcpConfig: true` (ignore project `.mcp.json`, user settings, plugins, and
claude.ai connectors). This trio is the mode switch.

---

## 8. Order of work

1. **Measure cold start.** Is an automation call 2.5s or 15s? `src/service.ts`
   notes the browser idle-closes between calls and returns on `about:blank`.
   Everything else is guesswork until this is known — and it matters *more* under
   this design, not less: once discovery drops to 0s, execution latency is the
   entire remaining story.
2. **Card parser + scan.** Read frontmatter out of `automations/**`, emit the
   in-memory registry. Small, and everything else reads from it.
3. **One profile, one launcher, existing tools.** Prove fast mode end-to-end with
   automations that already exist (`whatsapp_*`, `facebook_*`) before writing new
   ones. Measure prompt → done.
4. **General mode.** `search_automations` + `run_automation` over the registry.
5. **Promotion.** Write path plus the approval gate.
6. **Route task tools through the warm daemon** (AUTOMATION-PERF.md Fix 4).

---

## 9. Explicitly not doing

- **A separate HTTP API server mirroring the target site.** MCP is already the API
  surface.
- **Deleting `src/mcp.ts`.** It stays as the stdio server for Claude Desktop —
  design mode still uses it, and it costs nothing to keep.
- **Progressive disclosure for fast mode.** Skills, deferred tool loading, and tool
  search all solve a scale problem that per-agent sharding already prevents.
- **Silent promotion.** Every registry write passes a human gate.

---

## 10. Open questions

- **Profile curation is an unclaimed step.** General mode produces automations one
  at a time; someone still decides "these five are the Payments Clerk." Today that
  is a hand-written markdown file. Fine for now, but it is a third human action in
  the loop, not something that falls out of the first two.
- **Routing between fast agents.** If a user has several specialized agents, do they
  pick one before chatting, or does something route the request? One chat box across
  many agents needs a dispatcher; one agent per chat does not.
- **Registry as the site's own API.** Still open from AUTOMATION-PERF.md §7: if the
  target site renders from internal JSON XHR calls, registry entries could hit those
  directly with the logged-in session. Sane split remains reads via internal API,
  writes via UI, DOM as fallback.

---

## Appendix: Agent SDK facts this design relies on

Gathered from `code.claude.com/docs/en/agent-sdk`. **Quote verification on these
fetches came back unconfirmed** — the shapes are consistent across four pages and
match the SDK's known surface, but pin the exact `tool()` argument order against the
installed `@anthropic-ai/claude-agent-sdk` package before writing real code.

- `mcpServers` accepts `stdio`, `sse`, `http`, `sdk` (in-process), and
  `claudeai-proxy` configs.
- `createSdkMcpServer({ name, version?, instructions?, tools?, alwaysLoad? })`
  returns an `McpSdkServerConfigWithInstance`.
- `tool(name, description, zodSchema, handler, extras?)` — exported from
  `@anthropic-ai/claude-agent-sdk`.
- Tools are exposed to the model as `mcp__{server_name}__{tool_name}`, where
  `{server_name}` is the key used in the `mcpServers` object.
- `systemPrompt` is `string | { type: 'preset', preset: 'claude_code', append?,
  excludeDynamicSections? }`. Omitted means a minimal prompt. Run mode uses the
  plain-string form; the `claude_code` preset would drag in the coding-agent prompt.
- `settingSources: []` disables user, project, and local settings; `["project"]`
  loads CLAUDE.md.
- Also available and potentially relevant later: `agents` (programmatically defined
  subagents), `outputFormat` (JSON schema on the agent result), `hooks`,
  `canUseTool`, `maxTurns`, `maxBudgetUsd`.
