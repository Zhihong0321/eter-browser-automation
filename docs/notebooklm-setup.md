# NotebookLM as an agent tool

[notebooklm-py](https://github.com/teng-lin/notebooklm-py) is an unofficial Python
client for Google's Gemini Notebook (NotebookLM). It ships an MCP server, so the
33 NotebookLM tools (notebooks, sources, chat, studio artifacts, deep research,
sharing) become callable by any agent in this repo.

It is an **unofficial** client riding undocumented Google RPC endpoints — Google
can change them without notice. Treat breakage as expected, not as a repo bug.

## What is installed where

| Thing | Path | Committed? |
|---|---|---|
| Python venv + `notebooklm-py[mcp,browser]` | `.venv-notebooklm/` | no — gitignored, ~200MB |
| MCP server registration | `.mcp.json` (project scope) | yes |
| Google session (cookies) | `~/.notebooklm/profiles/default/` | no — never leaves this machine |
| Playwright Chromium (for login) | `~/AppData/Local/ms-playwright/` | no |

The venv reuses the machine's Python 3.12 (`%LOCALAPPDATA%\Programs\Python\Python312`),
which is not on `PATH` — hence the absolute path in `.mcp.json`. There is no `uv`
or `pipx` on this machine, so the upstream `uvx` recipe does not apply here.

## Rebuild from scratch

```powershell
& "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe" -m venv .venv-notebooklm
.\.venv-notebooklm\Scripts\python.exe -m pip install "notebooklm-py[mcp,browser]"
.\.venv-notebooklm\Scripts\python.exe -m playwright install chromium
```

## Authenticate — from the vault, not a second login

The MCP server refuses to start without a Google session. Do **not** run
`notebooklm login`: it opens its own browser and enrolls a second Google session,
which is the exact duplication this vault exists to prevent. The vault's `google`
profile is already signed in to NotebookLM, so hand it over instead:

```powershell
node scripts/notebooklm-auth.mjs          # defaults to the "google" profile
```

The script opens that profile (launch args replayed verbatim from the manifest),
loads `notebook.google.com` so Google re-issues the rotating `__Secure-1PSIDTS`,
exports the `google.com` cookies to a 0600 temp file, pipes them through
`notebooklm auth import-cookies`, and deletes the temp file. It exits 2 if the
profile turns out to be signed out.

**One Chrome per user-data-dir.** If the daemon (or a stray window) holds the
`google` profile, the launch fails with "already in use by another instance" —
close that Chrome and re-run.

Verify at any time:

```powershell
.\.venv-notebooklm\Scripts\notebooklm.exe auth check --test
```

### Re-auth is `notebooklm-auth.mjs`, not `login`

The import copies a *snapshot*. From then on notebooklm-py refreshes
`__Secure-1PSIDTS` inside `~/.notebooklm/` while the vault profile refreshes its
own copy, and the two stores drift. So when the tools start failing on auth, the
fix is to re-run the script — which re-syncs from the vault, still the single
source of truth for this Google login.

## Using it

Restart Claude Code after the first import and approve the project-scoped
`notebooklm` server when prompted. Tools then appear as `mcp__notebooklm__*` —
e.g. `notebook_list`, `source_add`, `chat_ask`, `studio_generate`,
`research_start`. Destructive ones (`*_delete`, `share_set_user`) require an
explicit confirmation argument.

The same install also works as a plain CLI, which is often faster for one-offs:

```powershell
.\.venv-notebooklm\Scripts\notebooklm.exe create "Solar leads"
.\.venv-notebooklm\Scripts\notebooklm.exe source add "https://example.com"
.\.venv-notebooklm\Scripts\notebooklm.exe ask "What are the key themes?"
```

## Gotcha worth knowing

`notebooklm-mcp` exits non-zero at startup when no session exists, so an
unauthenticated Claude Code shows the server as failed rather than as
"needs login". If `notebooklm` is red in `/mcp`, check `auth check` first.
