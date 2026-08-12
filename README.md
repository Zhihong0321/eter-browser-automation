# Eter Browser

A local TypeScript/Node.js vault for browser sessions, exposed as a dashboard, daemon, and stdio MCP server.

## Value proposition

Eter Browser lets agents and tools drive a real browser session through a persistent Chrome profile managed by Patchright. Passwords stay human-only; cookies and session state remain local on your machine.

## Architecture

```
Human → Dashboard (127.0.0.1:7676) → Daemon → Chrome profile → Websites
                                               ↑
MCP client → stdio MCP server → local HTTP API ─┘
```

The daemon owns one Chrome process and serializes browser work so concurrent callers cannot corrupt the profile. The MCP server is a thin client; it does not launch Chrome itself.

## Quick start

```bash
git clone <repository-url>
cd eter-browser
npm install
npm run build
npm start
```

Open <http://127.0.0.1:7676> and add a session, or use the built CLI from another terminal:

```bash
node dist/cli.js login facebook
node dist/cli.js check facebook
node dist/cli.js status
```

Keep the daemon running before connecting any MCP client.

## MCP client configuration

If `eter-browser` is available as an installed package or linked binary:

```json
{
  "mcpServers": {
    "eter-browser": {
      "command": "npx",
      "args": ["-y", "eter-browser", "mcp"]
    }
  }
}
```

Local-clone alternative:

```json
{
  "mcpServers": {
    "eter-browser": {
      "command": "node",
      "args": ["/absolute/path/to/eter-browser/dist/cli.js", "mcp"]
    }
  }
}
```

## CLI commands

| Command | Description |
|---|---|
| `eter-browser ui [--port 7676] [--home DIR] [--no-open]` | Start the daemon and dashboard. |
| `eter-browser profiles` | List profiles, sessions, and browser state. |
| `eter-browser profiles create <id> [label]` | Create a persistent Chrome profile. |
| `eter-browser login <site-or-url> [--profile ID]` | Open Chrome for a human login. |
| `eter-browser check [site] [--profile ID]` | Re-verify one or all sessions. |
| `eter-browser status [--profile ID]` | Show current session readiness. |
| `eter-browser recon probe <url> [--window 8000] [--json]` | Inspect one page. |
| `eter-browser recon scan <url> [--max-pages 40] [--approve "A,B"] [--json]` | Run a bounded site scan. |
| `eter-browser fb-recon --topic <topic> [--source group:<url>] [--min-score 3] [--open] [--json]` | Start read-only Facebook prospecting. |
| `eter-browser fb-recon-projects [--json]` | List prior Facebook recon runs. |
| `eter-browser fastworker [question]` | Exercise the optional Fast Worker integration. |
| `node gmap.mjs new "<keywords>" "<towns>"` | Create and run a Google Maps recon project. |
| `node gmap.mjs list` | List Maps projects. |
| `node gmap.mjs resume <project-id>` | Resume an interrupted Maps project. |
| `node gmap.mjs report <project-id>` | Rebuild/open a Maps report. |
| `node radar.mjs list` | List Maps projects available to review radar. |
| `node radar.mjs <project-id> [cap]` | Harvest reviews; `cap` limits companies, and `0` rebuilds existing data. |

## MCP tools

Agents should call `list_sessions` first. Tools that need authentication fail with an actionable login error rather than silently continuing.

| Tool | Inputs | What it does |
|---|---|---|
| `list_sessions` | None | List sessions and current readiness. |
| `check_session` | `siteId` | Re-verify one session against its live site; do not poll it. |
| `request_login` | `siteId` | Open Chrome so the human can sign in. |
| `browser_navigate` | `url` | Navigate and return the final URL/title. |
| `browser_read` | `maxChars` (default `8000`) | Return visible page text, URL, and title. |
| `browser_click` | `name`, optional `role` | Click by accessible name/visible text; read the page first. |
| `browser_type` | `label`, `text`, optional `submit=false` | Type into a labelled field. Never use it to enter the human's credentials. |
| `browser_screenshot` | None | Save a PNG and return its local path. |
| `whatsapp_list_chats` | `limit` (default `20`) | List recent chats and exact chat names. |
| `whatsapp_read_chat` | `target`, `limit` (default `20`) | Read recent messages. **Opening a chat marks it read.** |
| `whatsapp_send_message` | `target`, `text` | **Sends a real message. Use only for the exact recipient/message the user requested.** |
| `facebook_read_my_posts` | `limit` (default `5`) | Read the signed-in user's recent posts. |
| `facebook_read_feed` | `limit` (default `5`) | Read recent home-feed posts. |
| `facebook_comment` | `postUrl`, `text` | **Publishes publicly under the user's name; requires an explicit request.** |
| `facebook_recon` | `topic`, optional `sources`, `minScore=3` | Start a new read-only background prospecting project; poll the projects tool rather than starting duplicates. |
| `facebook_recon_projects` | None | List past/current recon projects, contacts, counters, and status. |
| `search_automations` | `query`, `limit` (default `10`) | Find purpose-built automations by intent; an empty query lists all. |
| `run_automation` | `id`, optional `args` | Run a catalogue automation. Inspect its declared effect before executing destructive work. |

## Configuration

| Setting | Default | Description |
|---|---|---|
| `--home DIR` | — | Per-command vault root override. |
| `ETER_BROWSER_HOME` | — | Environment-level vault root override. |
| `vault.config.json` `home` | — | File-based vault root. |
| `ETER_BROWSER_PORT` | `7676` | Dashboard and daemon port. |
| `ETER_BROWSER_DEBUG=1` | off | Enables the internal `browser_eval` endpoint. |
| `STEPFUN_API_KEY` | — | Required for Agent features; also the Fast Worker fallback key. |
| `FASTWORKER_API_KEY` | falls back to `STEPFUN_API_KEY` | Optional dedicated Fast Worker key. |
| `FBRECON_LLM_URL`, `FBRECON_LLM_KEY`, `FBRECON_LLM_MODEL` | empty | Optional Facebook recon classifier; empty uses regex-only classification. |
| `MONOLITH_PATH` | auto-discovered when possible | Optional `monolith` executable path for recon snapshots. |

Precedence: `--home` > `ETER_BROWSER_HOME` > `vault.config.json` > `~/.eter-browser`.

## Supported login targets

Presets: `facebook`, `whatsapp`, `instagram`, `x`, `linkedin`, `gmail`, `youtube`, or any arbitrary URL.

## Development

```bash
npm run build
npm test
npm run ui
npm run mcp
```

Live built-artifact integration test: `test/gmaprecon-e2e.mjs`.

## Security and operations

- Binds loopback only (`127.0.0.1`) with no API authentication. Do not expose the port.
- The shared browser profile means all actions use the human account.
- One daemon instance owns and serializes Chrome.
- Sessions expire; re-authenticate when they do.
- Respect Facebook and WhatsApp rate limits and authorization requirements.
