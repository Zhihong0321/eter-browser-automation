# fb-recon — Standard Operating Procedure

**Status:** binding. Code enforces most of this; where it does not, the rule still applies.
**Last verified against a live run:** 2026-08-12.

fb-recon finds people on Facebook who look like they want to buy something, and hands back a
contactable list with the quote that proves why. It is **read-only**: it cannot like, comment,
follow, join, or message, and that is a structural property of the code, not a promise
(`src/fb-recon/browser.ts` is the only file permitted to click, and it clicks against an allowlist).

---

## 1. The one rule

> **One run is one project. Nothing is ever appended to an earlier harvest.**

Running the same topic twice produces two projects. A result you showed someone last week still says
what it said. There is no "current" contacts file to be quietly mutated, and no way for a later run
to make an earlier one wrong.

Everything below follows from that rule.

---

## 2. Layout

Everything lives under the vault home (`E:\eter-browser` on this machine), never in the repo.

```
<vault home>/fb-recon/
  projects/
    index.html                       ← catalogue of every run, newest first
    20260812-1430-e-invoice-9f3a/    ← ONE PROJECT
      project.json                   ← the project file: inputs + progress + results
      report.html                    ← self-contained, opens by double-click
      contacts.csv                   ← the same contacts, for a spreadsheet
    20260812-1612-solar-4b7c/
      …
  topics/<topic>.json                ← keyword packs — THE ONLY HAND-EDITED FILES
  ledger.json                        ← who this account has ever found, and in which projects
  read-history.json                  ← rolling hourly page-open budget
```

**Project id:** `YYYYMMDD-HHMM-<topic-slug>-<4 hex>`. It sorts chronologically as plain text, says
what it was about without being opened, and cannot collide with another run in the same minute.

---

## 3. Starting a run

Three surfaces, one behaviour. The daemon must be running (`npm run ui`) and the `facebook.com`
session must be `ready` — fb-recon never handles login.

```bash
# CLI (add --open to launch the report when it finishes)
node dist/cli.js fb-recon --topic "e-invoice" --source group:https://www.facebook.com/groups/<id> --min-score 3
node dist/cli.js fb-recon-projects            # list every project

# HTTP
POST /api/fb/recon           { "topic": "...", "sources": ["group:<url>"], "minScore": 3 }
GET  /api/fb/recon/projects

# MCP / registry
facebook_recon(topic, sources, minScore)   ·   facebook_recon_projects()
```

**Sources**, best first: `group:<url>` → `thread:<url>` → `search[:<query>]` → `feed`.
Passing none sweeps the feed and the project says so in its own problems list, because a feed-only
run looks like a working run and returns almost nothing.

**The ceiling, state it to whoever asked:** fb-recon only reaches groups the human has **already
joined**. Joining is a write. A topic with no matching joined group returns an empty harvest, and
that is the tool working correctly.

---

## 4. Lifecycle

| Status | Means |
|---|---|
| `running` | The sweep is live. `project.json` and `report.html` are rewritten at every phase; the report auto-refreshes every 5s so it can be watched. |
| `done` | Finished. Counters and contacts are final. |
| `failed` | It died. `error` says how, and the events up to that point are still there. |

A project directory is created **before the browser is touched**, so a run that dies on its first
navigation still leaves a readable record. There is no state in which a run happened and no project
exists.

---

## 5. Reading a result

Counters are in `project.json` → `counters`, and across the top of the report.

| Counter | Question it answers |
|---|---|
| `scanned` | How many distinct posts were read |
| `gated` | How many cleared the keyword gate |
| `opened` / `commentsRead` | How many threads were opened, and comments mined |
| `skippedNoPermalink` | Gated posts with no permalink to open — **normal for group text posts** |
| `totalContacts` / `newContacts` / `knownContacts` | People found; how many are first contact vs already in the ledger |

**Diagnosing a zero** — a zero is a claim and must be traced to a cause:

| Symptom | Cause to check first |
|---|---|
| `scanned` 0 | `MESSAGE_SEL` / `ACTION_SEL` in `src/facebook.ts` no longer match the live DOM |
| `scanned` healthy, `gated` 0 | The topic pack does not speak the group's language. **Edit `topics/<topic>.json`.** This is the most common cause by far and it is not a code bug |
| `gated` healthy, `totalContacts` 0 | `profileIdentity()` is rejecting the author URLs — print a few `authorUrl` values |
| `opened` 0, `skippedNoPermalink` high | Expected for text-only group posts. Only photo posts expose a permalink |
| `opened` healthy, `commentsRead` 0 | `COMMENT_SEL` in `src/fb-recon/extract.ts` has drifted |
| Contacts named after their own numeric id | The author-name pick in `extract.ts` is landing on the avatar anchor, not the name anchor |

---

## 6. The ledger — never pitch the same person twice

`ledger.json` is the only state that spans projects. It holds an identity, a name, and which
projects found that person. **No quotes, no phones, no evidence** — those stay in the project that
harvested them.

A person already found by an earlier project is **flagged, never removed**: they appear in the new
project with `priorProjects: ["<earlier id>"]`, and the report marks them `seen in N`. A repeat
sighting is real evidence — someone asking again is a warmer lead, not a duplicate row.

**Before any outreach: check `priorProjects`.** If it is non-empty, someone may already have been
approached. That check is the whole reason the ledger exists.

---

## 7. What may be edited

| File | Rule |
|---|---|
| `topics/<topic>.json` | **Edit freely.** It is generated once and hand-tuned forever; no run ever overwrites it. Tuning this is the highest-value work you can do on a bad harvest. |
| `project.json`, `report.html`, `contacts.csv` | **Never edit.** They are the record of what a run saw. To get a different answer, do another run. |
| `ledger.json` | Machine-owned. Delete it only if you accept losing every "already contacted" flag. |
| `read-history.json` | Machine-owned budget state. |

---

## 8. Handling — PDPA

`contacts.csv`, `project.json` and `report.html` are **lists of identified people collected for
outreach**. They are personal data.

- Keep them under the vault home. `/fb-recon/`, `contacts.csv` and `contacts.json` are gitignored.
- Do not commit them, do not paste them into a shared doc, do not forward them outside the business
  that collected them.
- The report carries this notice in its own footer so a file that escapes still says what it is.

---

## 9. Prohibited

1. **No writes on Facebook.** No like, comment, follow, join, message, or friend request. Enforced
   by `test/fbrecon.readonly.test.ts` — if it fails, fix the source, never the test.
2. **No joining groups to widen reach.** The membership ceiling is a fact to be reported, not routed
   around.
3. **No editing a finished project** to make a result look better. Run again.
4. **No credentials, absolute personal paths, or API keys** in `src/fb-recon/**`. The classifier
   endpoint comes from environment variables via `src/config.ts` and nowhere else.
5. **No raising the read budget** (`src/readlimit.ts`) to push a big sweep through. The caps exist
   because a 200-post sweep with 40 post-opens is exactly the pattern that gets an account flagged.

---

## 10. Definition of done

A run is done when **all** of these hold:

1. `project.json` exists with `status: "done"`.
2. `report.html` opens and shows counters, contacts, the progress timeline and any problems.
3. The counters have been read against §5 — a zero has either a cause or an explanation.
4. `priorProjects` has been checked before anyone is contacted.
5. If the harvest was poor, the topic pack was tuned and a **new** project was run — the old one was
   not edited.

Reporting "the sweep worked" without step 3 is the failure this document exists to prevent. See
`docs/stupid-method-to-avoid.md`: the dangerous outcome is not an error, it is a plausible empty
result that nobody questioned.
