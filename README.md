# Eter Browser

Share your real browser login sessions with any AI agent — without handing over passwords, without pasting cookies, and without getting flagged as a bot.

You sign in once, in a dedicated Chrome. The agent drives that same Chrome later. The session is never copied, injected, or transplanted anywhere.

---

## Why not just export cookies?

Because it doesn't work on platforms that actually check.

Facebook's `datr` and `sb` cookies bind a session to the browser instance Meta first saw. Drop `c_user`/`xs` into a fresh automation browser and you get a mismatched canvas/WebGL/TLS fingerprint, empty storage entropy, and no history — Meta's Deep Entity Classification flags it and you land on a checkpoint.

So this tool inverts it: **the session is born inside the browser the agent will use.**

| Approach | Survives Meta |
|---|---|
| Cookie-Editor export → inject into automation browser | No |
| Playwright `storageState` | No |
| Attach to your default Chrome | Blocked since Chrome 136 (`--remote-debugging-port` is refused on the default profile) |
| **Dedicated Chrome profile you log into once** | **Yes** — this tool |

---

## How it works

```
  You ──sign in once──►  Agent Chrome  ◄──drives──  AI agent (via MCP)
                              │
                              ▼
                    E:\eter-browser\profiles\agent\
                    (a real Chrome user-data-dir:
                     Cookies, Local Storage, IndexedDB,
                     Service Workers, History, Local State)
```

- A **separate Chrome user-data-dir**, not a Chrome "Add profile". Chrome's single-instance lock is per-directory, so this runs side by side with your daily browser and never touches it.
- **Real Google Chrome** (`channel: 'chrome'`), driven by [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs) — a drop-in Playwright fork that removes the `Runtime.enable` CDP leak stock Playwright emits.
- The launch config is captured at enrollment and **replayed verbatim** on every run, so the fingerprint the site enrolled against is the fingerprint it always sees.
- One Chrome process, owned by the daemon, behind a serialized queue. Two agents can't corrupt the profile.

Verified on `bot.sannysoft.com`: `WebDriver Advanced: passed`, `HEADCHR_PERMISSIONS: ok`, `HEADCHR_PLUGINS: ok`, real GPU vendor.

---

## Quick start

```bash
npm install
npm run build

# 1. Start the daemon + dashboard (keep this running)
npx eter-browser ui           # → http://127.0.0.1:7676

# 2. In the dashboard, click "Facebook" under Add a session.
#    Chrome opens. Sign in normally — 2FA, captcha, "trust this device", all of it.
#    Click "I've signed in".

# 3. The session shows READY. That's it.
```

CLI equivalents:

```bash
eter-browser login facebook   # open Chrome at the login page
eter-browser check facebook   # verify against the live site
eter-browser status           # what's ready right now
```

---

## Connect an AI agent

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

The MCP server is a thin client — the `ui` daemon must be running, because it owns the browser.

### Tools

| Tool | What it does |
|---|---|
| `list_sessions` | Which logins are ready **right now**. Agents should call this first. |
| `check_session` | Re-verify one session against the live site. |
| `request_login` | Opens Chrome at the login page for the human. The agent cannot log in itself. |
| `browser_navigate` / `browser_read` / `browser_click` / `browser_type` / `browser_screenshot` | Generic driving, on the authenticated browser. |
| `facebook_read_my_posts` | Your own recent posts, with permalinks. |
| `facebook_read_feed` | Home timeline. |
| `facebook_comment` | Comment on a post, then verify it actually rendered. |

Every action that needs a login calls `requireReady()` first. If the session is dead or checkpointed, the tool fails with an actionable message instead of silently doing nothing.

---

## Staying under the radar

- Headful real Chrome. Headless is the single biggest tell.
- Real CDP input (`isTrusted === true`), never synthetic DOM `.click()`.
- Per-character typing with jitter and occasional pauses.
- Incremental wheel scrolling, never a jump to page bottom.
- Hard rate limit — `maxActionsPerMinute`, default 12.
- Role/aria selectors only. Facebook randomises class names; the accessibility tree is stable.
- Health checks piggyback on an already-open browser and never pop a window on a timer.

---

## Layout

```
src/
  config.ts     vault home resolution, ports
  vault.ts      manifest, profile dirs, session records
  browser.ts    the single Chrome process + serialized queue + idle close
  human.ts      pacing, rate limiter, human-like input
  sites.ts      site registry, cookie + live-page probes
  facebook.ts   read posts / feed, post a comment (with verification)
  service.ts    the one object everything else calls
  api.ts        local HTTP API (127.0.0.1 only)
  mcp.ts        MCP server → HTTP client
  cli.ts        entry point
  ui/index.html dashboard
```

Vault location resolution: `--home` → `ETER_BROWSER_HOME` → `vault.config.json` → `~/.eter-browser`.

---

## Limits, stated plainly

- **The profile is bound to this machine.** Chrome 127+ App-Bound Encryption plus Windows DPAPI seal the cookie key to this install and user account. Copy the folder to a server and the cookies decrypt to garbage — silently. This is local-first by construction.
- **One agent at a time per profile.** One user-data-dir means one Chrome. Concurrent calls serialize.
- **Everything in the profile shares a blast radius.** Only log in to what you want automated. Do not add your bank.
- **Sessions expire.** The dashboard shows cookie expiry and marks a session `stale` after 30 minutes; agents re-verify before acting.
- The daemon binds to `127.0.0.1` with no auth. Anything already running on your machine can reach it.
