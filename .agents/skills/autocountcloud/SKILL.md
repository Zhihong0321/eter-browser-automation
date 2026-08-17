---
name: autocountcloud
description: Drive accounting.autocountcloud.com as a database — list, read and create records without exploring the UI. Use whenever the user asks to look up, extract, or create anything in autocountcloud (invoices, quotations, customers, suppliers, products, ledgers, statements). Do NOT open the site manually, take screenshots, or write a probe script; every path is already mapped here.
---

# autocountcloud

**The site is static. Every fact below was measured, not guessed. Do not re-measure them.**

There is exactly ONE thing to run:

```
node E:\001-browser-use-v2\scripts\engine.mjs E:\001-browser-use-v2\scripts\jobs\<job>.json
```

One launch. Reading and writing are both tasks inside the same job. **Measured 2026-08-13:
list + create customer + create quotation + verify both = 45.2s. Re-run with nothing left
to do = 12.3s. Read-only (list customers + list quotations) = 9.9s.**

Ready-made jobs in `scripts/jobs/`:

| job | what it does |
|---|---|
| `list-all.json` | prints customers + quotations. **Use this instead of writing any probe.** |
| `quotation-INV-1010744.json` | the reference: customer-if-missing → quotation, idempotent. Copy this one. |
| `selftest-engine-v2.json` | exercises list + auto-code + tab + `$var` + lookup + date + lines |

The one-off scripts `ac-create-customer.mjs`, `ac-create-quotation.mjs`, `ac-read-demo.mjs`,
`ac-*-probe.mjs` are **superseded and must not be copied.** They carry ~50s of blind
`waitForTimeout` each and relaunch Chrome per step. Everything they did is a task above.

---

## Hard rules — every one of these cost a full session before

1. **Never write a new `.mjs`.** Not a probe, not a lister, not "just a quick check".
   If you are about to, the answer is a `list` task in a job JSON. There are no exceptions
   on this site.
2. **Never take a screenshot to read data.** `op:"list"` prints the grid as text.
3. **Never edit `engine.mjs` to make a record.** A record is a job JSON. Editing the engine
   is only for a missing *capability*, and then it must stay site-agnostic.
4. **Never split work across runs.** Customer missing? Put it in the same job, before the
   quotation. Two `node` commands where one job would do is the mistake this file exists for.
5. **Never look up "does X exist" first.** Put `ensureAbsent` on the create task and let the
   engine skip it. Checking, then deciding, then running is three round-trips of your context
   for something the engine settles in 1.2s.

---

## Static facts — already known, do not rediscover

**Login** — Chrome profile `E:\eter-browser\profiles\agent`, already authenticated. Nothing to configure.

**Company book** — there is exactly **one**: `Macam Yes` (a TEST book). The entry screen is
"Please select a company"; the engine clicks the book name as text. Always `"entry": "Macam Yes"`.

**`/debtor`** (customers)
- Grid columns: `Customer Code | Company Name | Currency | Phone | Area | Agent | Active`
- Form is a **modal**, **tabbed**: `Account / General / Others / Note`.
  `Customer Code` and `Company Name` are on **Account** (the tab it opens on).
  `Phone` is on **General** — use `"tab": "General"`. It is in the DOM before the tab is
  clicked but cannot be filled.
- Codes run `300-A%03d`. **Never hand-pick one** — use
  `"auto": { "column": "Customer Code", "format": "300-A%03d" }` and `"saveAs"` it.
- Currency defaults to MYR. Do not set it.

**`/quotation`**
- Grid columns: `Action | 2 Doc. No. | 1 Date | Customer Code | Customer Name | Agent | Curr. Code | Curr. Rate | Subtotal (ex) | Total | Status | Action`
- Doc No. is **server-assigned** `QT-%06d`. Never supply it.
- Form is a **modal**. Line grid marker is `"Total (inc)"`.
- Line columns that matter: `Description`, `Unit Price`. **Qty defaults to 1** — do not set it.
- The line grid **auto-appends a blank row**, so N lines fill rows `0..N-1`. The engine
  indexes them; just list them in order.
- **Negative `Unit Price` is accepted** (confirmed: `-3200` for a referrer discount).
- New rows land at the **top** of the grid, not the bottom.
- Status is always `Pending` on create.

**Controls (the engine already handles all of these — listed so you don't re-debug them)**
- `Date` is readonly → `Alt+ArrowDown` opens the calendar, then month-nav by geometry.
- `Save` is a **split button** → clicked by the text's glyph rectangle, so it never opens
  *Save and Print*.
- `Customer` is a **grid popup**, not a `<select>` → type the code, click the matching row.
- `.modal.show` holds **three** date inputs; two are list filters underneath another div.
  The engine picks the one that is on top of itself.

---

## Job JSON

```json
{
  "name": "...",
  "profile": "E:\\eter-browser\\profiles\\agent",
  "site": "https://accounting.autocountcloud.com",
  "entry": "Macam Yes",
  "tasks": [ ... ]
}
```

| task | shape |
|---|---|
| read a grid | `{ "op":"list", "route":"/debtor", "label":"..." }` |
| write a record | `{ "op":"create", "route":..., "action":"New", "ensureAbsent":..., "fields":[...], "lines":[...], "save":"Save", "verify":{"contains":...} }` |

Field forms:

| field | shape |
|---|---|
| plain input | `{ "label":"Company Name", "value":"ALICIA" }` |
| on another tab | `{ "label":"Phone", "tab":"General", "value":"0162091125" }` |
| dropdown / lookup | `{ "label":"Customer", "type":"lookup", "value":"300-A002", "match":"ALICIA" }` |
| date | `{ "label":"Date", "type":"date", "value":"2026-07-09" }` (ISO in, engine drives the calendar) |
| next code from the grid | `{ "label":"Customer Code", "auto":{"column":"Customer Code","format":"300-A%03d"}, "saveAs":"cust" }` |

`saveAs` publishes a value; any later task uses it as `$cust` — in a `value`, a `match`, an
`ensureAbsent`, a `verify.contains`, or a line cell. This is how a generated customer code
reaches the quotation without you knowing it in advance.

`ensureAbsent` is checked against the grid before the form opens: if the string is already
there the whole task is skipped. **This is what makes a job safe to re-run**, and what
removes the "does the customer exist?" question entirely.

---

## Recipe: an atap calculator quote → an AutoCount quotation

The complete job is `scripts/jobs/quotation-INV-1010744.json`. Copy it, change the values.
One command, whether or not the customer already exists.

Mapping from `calculator.atap.solar/view/<hash>`:

| atap page | AutoCount |
|---|---|
| `Bill To` name | `Company Name` on the debtor + `match` on the quotation lookup |
| phone under Bill To | `Phone`, tab `General` |
| `Issued` date | `Date` (convert to ISO) |
| package + spec bullets | line 1 `Description`, joined with `; ` |
| package price | line 1 `Unit Price` |
| each discount row | its own line, **negative** `Unit Price` |
| bank/processing fee row | its own line, positive `Unit Price` |
| `Total Due` | do not enter — AutoCount sums the lines. Expect ±0.01 vs the atap page, which rounds up. |
| sales rep, payment schedule, bank block, savings figures | **no field** — do not try |

---

## Other tables

43 tables · 290 columns. Routes and columns: `tables.md`.
Field contracts for the 7 create paths not yet executed: `ops/create.<thing>.json` — read them
for *which fields exist*, never for their selectors (those are 12-level `nth-of-type` paths
that do not survive a modal opening and have never created anything).

**Proven executed:** `create.quotation` (QT-000001..4), customer creation, grid listing.
**Never executed:** invoice, creditnote, purchaseorder, purchaseinvoice, purchasereturn,
journalentry, knockoffentry. They share the same modal machinery, so the engine should carry
them — express one as a job JSON and run it; do not hand-write a script to find out.

**Unknown:** `required` is undeclared everywhere; constraints only surface when a save is
rejected. Row counts in `sitemap.json` are all `1` and all wrong — that walk scraped a
DevExtreme overlay clone. Routes and columns from it are fine.

---

Measured 2026-08-13 against the live site. If a selector stops resolving, the app changed —
re-run the reveal and re-measure. Do not patch these facts by hand.
