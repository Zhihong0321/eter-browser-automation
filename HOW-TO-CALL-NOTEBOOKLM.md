# How to call NotebookLM

## What is NOT built

There is no `src/notebooklm.ts`, no `/api/nlm/*` route, no tool in `src/mcp.ts`, and
nothing in the dashboard. No automation in this repo calls NotebookLM today.

What exists is the raw capability: an authenticated CLI at
`.venv-notebooklm/Scripts/notebooklm.exe` and an MCP server registered in
`.mcp.json`. Everything below is how to drive that *directly* from a script. Wiring
it into the daemon spine is a separate job — see "If you wire it in" at the bottom.

Setup and auth live in [docs/notebooklm-setup.md](docs/notebooklm-setup.md). The
short version: auth comes from the vault's `google` profile via
`node scripts/notebooklm-auth.mjs`, never from `notebooklm login`.

## The property that makes it different

Every other capability in this repo goes through `BrowserManager.run()`
(`src/browser.ts:211`) because it needs the one Chrome holding a login. **NotebookLM
does not.** After the cookie import it is plain HTTPS with cookies — no Playwright,
no user-data-dir lock, no serialized queue.

So a NotebookLM call can run *concurrently* with an fb-recon sweep or a gmap run.
It is the only capability here that never contends for the browser. The single
exception is `scripts/notebooklm-auth.mjs`, which does open the profile and
therefore does need Chrome to be free.

## Route A — shell out to the CLI (works today)

Every command takes `--json`, so this is a real machine interface, not scraping.

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

const NLM = '.venv-notebooklm/Scripts/notebooklm.exe';

/** One CLI call, parsed. Throws with the CLI's own stderr on failure. */
async function nlm(...args) {
  const { stdout } = await run(NLM, [...args, '--json'], { maxBuffer: 32 << 20 });
  return JSON.parse(stdout);
}

const { notebooks } = await nlm('list');
const answer = await nlm('ask', 'What financing schemes appear?', '-n', notebooks[0].id);
```

Costs ~1-2s of Python start-up per call, so batch work into one command where you
can rather than looping the process.

`list --json` returns:

```json
{ "notebooks": [ { "index": 1, "id": "aece4bf2-…", "title": "Legion Optimizer · Stack Fingerprint",
                   "is_owner": true, "role": "owner", "created_at": "…", "modified_at": "…" } ] }
```

Notebook IDs accept partial prefixes (`-n aece4`). `notebooklm use <id>` sets a
current notebook in `~/.notebooklm`, but **pass `-n` explicitly in automation** —
current-notebook state is global to the machine and any other job can move it under
you. `NOTEBOOKLM_NOTEBOOK` in the environment does the same thing per-process.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Completed and produced its intended effect |
| 1 | Validation, auth, rate limit, network, config — any `NotebookLMError` |
| 2 | Unhandled exception (a bug), and `source wait` timeout |
| 130 | SIGINT |

Code 1 is the one to branch on: it is where "cookies drifted, re-run
`notebooklm-auth.mjs`" and "you hit the quota" both land.

## Route B — MCP

**stdio (wired, verified).** `.mcp.json` registers the server project-scoped, so
Claude Code in this repo gets 33 `mcp__notebooklm__*` tools: `notebook_*`,
`source_*`, `chat_ask`, `note_save`, `studio_*`, `research_*`, `share_*`,
`server_info`. Destructive ones (`*_delete`, `share_set_user`) demand an explicit
confirmation argument.

**HTTP (untested here).** For a long-lived consumer like the daemon, one process
beats one-per-call:

```bash
.venv-notebooklm/Scripts/notebooklm-mcp.exe --transport http --port 9420
```

Loopback only unless `NOTEBOOKLM_MCP_ALLOW_EXTERNAL_BIND=1`. The bearer token is
env-only (`NOTEBOOKLM_MCP_TOKEN`) so it never shows up in a process listing. This
repo already depends on `@modelcontextprotocol/sdk`, so a client is a few lines —
but nobody has run this yet.

**REST (not available).** `notebooklm-server` is installed but crashes on import:
fastapi is not in the venv, and upstream calls it experimental. Ignore it.

## Deep research

There is no `research start`. Research is *started* by `source add-research`; the
`research` group only monitors what is already running.

```bash
notebooklm source add-research "solar financing schemes Malaysia 2026" \
  -n <notebook-id> --mode deep --no-wait --timeout 3600 --json
notebooklm research status -n <notebook-id> --json     # your loop, your interval
notebooklm research import -n <notebook-id> --json     # or --max-sources N
```

`--mode deep` (not `fast`) is the real deep research. `--from drive` searches your
Drive instead of the web.

Two things that will bite:

- **`--timeout` is per phase and defaults to 1800s.** A deep run outlives the legacy
  5-minute cap; if the CLI gives up before `IMPORT_RESEARCH` fires, the NotebookLM web
  UI is left sitting on an "Add sources?" modal that your automation cannot see. Pass a
  real budget.
- **This takes minutes.** Do not put it behind a request/response route. Use
  `--no-wait` plus your own polling, and model it on the fb-recon job pattern —
  one run at a time, a stop flag, progress readable from disk
  (`src/service.ts:76-77`, `src/service.ts:529`).

`research wait --import-all` exists and blocks. It is fine at a terminal and wrong
inside the daemon.

## Rules

- **One Google account.** Every automation shares it, so treat NotebookLM as a serial
  resource. Two jobs starting deep research on the same notebook will fight.
- **Unofficial API.** Undocumented Google RPC endpoints that can change without
  notice. Anything that depends on this needs the degrade-don't-crash handling
  fb-recon already has; do not let a NotebookLM failure kill a recon sweep.
- **Auth drifts.** The import is a snapshot; notebooklm-py then refreshes its own
  `__Secure-1PSIDTS` separately from the vault's. On auth failure re-run
  `node scripts/notebooklm-auth.mjs` — not `notebooklm login`.
- **Quota is real** for deep research and studio generation. Failures show as exit 1.
- **Writes are real.** `create`, `source add`, `add-research` and `studio generate`
  all mutate the user's actual Google account. There is no dry-run.

## Where it earns its place

`chatgpt.ts` gives free-form reasoning with no grounding. NotebookLM gives answers
**cited against a corpus you control** — the existing notebooks here already carry
50-100 sources each. That is the difference worth exploiting:

- A finished fb-recon or gmap-recon sweep → push findings in as sources → one
  `ask` across all of them, with citations back to the source that said it.
- Before outreach: notebook → deep research the company → import → ask → fold the
  answer into the project report.
- `radar.mjs` / `newpages/` as a standing corpus that accumulates instead of being
  re-scraped every run.

## If you wire it in

Mirror the `chatgpt.ts` spine — it is the precedent for "external reasoning engine as
a repo capability":

```
src/notebooklm.ts   module: execFile the CLI, parse --json
  → service.ts      nlmAsk / nlmResearch, shaped like chatgptAsk (src/service.ts:324)
    → api.ts        POST /api/nlm/*        (chatgpt sits at src/api.ts:130)
      → src/mcp.ts  thin HTTP tools, so external agents get it too
```

One implementation then serves `gmap.mjs`, the fb-recon engine, the dashboard, the
StepFun agent (`src/agent.ts:91` — pass `mcpServers` in `overrides`), and Claude Code.
Note that `src/mcp.ts` is a thin client by contract: it must stay one HTTP call to the
daemon and must never spawn the Python CLI itself.
