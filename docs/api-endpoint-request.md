# EE Admin — API endpoint request

**For:** the admin.atap.solar development team
**From:** automation / integration side
**Date:** 2026-08-12
**Status:** draft — job list needs confirming (§5)

---

## 1. Why

We automate reads against EE Admin. Today most of that is done by driving the admin UI in
a browser and reading the rendered table, because the JSON API does not yet cover those
pages.

That approach is slow (~3s per page of settle time, plus browser startup, and only one run
at a time) but the real problem is **silent wrongness**. Reading a rendered table can
return a confident wrong number with no error anywhere:

- `Showing 0 results` is the *loading* state on `/payments`, not an empty table. Code that
  waits for it gets a false zero and reports success.
- Skeleton placeholder rows match `table tbody tr`, yielding rows of `undefined` cells and
  an `RM 0.00` total that looks real.

Both of these have fired in production runs. On 2026-08-11, "Verified Payments" was first
reported as **1 row / RM 0.00**; the true figure was **3,930 payments / RM 30,809,399.76**.

A JSON endpoint removes this entire class of failure: the response parses or it errors.
There is no half-rendered state to misread.

## 2. What already exists (and works well)

Observed live on 2026-08-12:

```
GET /api/engineering-v2?limit=200&minPct=0&maxPct=100   -> application/json 200
GET /api/v1/seda/status
GET /api/sync/invoice
GET /api/sync/invoice-items
```

`/api-doc` documents the last three. **The requests below deliberately follow the same
shape as `/api/engineering-v2`** — a filtered `GET` with `limit`, returning JSON — so they
should slot into existing patterns rather than requiring anything new.

Pages that currently have **no** JSON API and are therefore automated via the DOM:
`/payments` (all responses are RSC / Server Actions, `text/x-component`).

## 3. Requested endpoints

### P0 — `GET /api/payments`

The highest-value gap. `/payments` is the most-automated page and currently the least
reliable to read.

| param | type | notes |
|---|---|---|
| `status` | enum | `pending` \| `verified` \| `fully-paid` — mirrors the existing tab names. Omitted = all. |
| `limit` | int | same semantics as `/api/engineering-v2` |
| `offset` | int | for paging; the UI currently renders all 3,930 rows in one table |
| `from`, `to` | ISO date | optional created-on range |

**Note on vocabulary:** in day-to-day use, *"submitted payments"* means the rows shown
under **Pending Verification**. If `status=pending` maps to those rows, that is correct.

Suggested response:

```json
{
  "total": 3930,
  "limit": 200,
  "offset": 0,
  "rows": [
    {
      "id": "…",
      "createdAt": "2026-08-11T04:12:00Z",
      "customer":  { "id": "…", "name": "…" },
      "amount":    30809399.76,
      "currency":  "MYR",
      "method":    "…",
      "status":    "pending",
      "remark":    "…"
    }
  ]
}
```

### P1 — read endpoints for the remaining automated pages

Same shape, listed in the order they'd be useful: `/invoices`, `/customers`, `/seda`.
Only worth building if §5 confirms we actually automate against them.

## 4. Four cross-cutting asks

These matter more than any individual endpoint:

1. **Return `total` alongside `rows`.** This lets the caller *prove* it received the whole
   set instead of assuming it. Without it, a filtered or truncated response is
   indistinguishable from a complete one — the same silent-wrongness problem, moved from
   the DOM to the API.
2. **Amounts as numbers, not formatted strings.** The UI renders `RM 1,234.56`; parsing
   that back out is error-prone. Send `1234.56` plus a separate `currency` field.
3. **A stable `id` per row.** The rendered table exposes none, which makes idempotent
   automation (don't process the same payment twice) impossible to do safely.
4. **ISO 8601 timestamps in UTC**, rather than the display format.

## 5. Open — job list to confirm

This draft assumes **payments reads** are the priority, since that is what is automated
today. Before sending, confirm:

- Which reports/exports are actually run, and how often
- Whether anything beyond `/payments` needs an endpoint
- Whether any *write* action should stay in the UI (recommended — a raw write can skip
  client-side validation, confirmations, audit entries and state transitions; reads are the
  safe thing to move to an API)

## 6. What we are not asking for

- No write endpoints. Mutations continue through the admin UI on purpose.
- No changes to existing endpoints.
- No auth changes — session cookie as today is fine.
