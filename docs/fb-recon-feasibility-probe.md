# fb-recon feasibility probe — live-site findings

**Date:** 2026-08-12 · **Account:** Zhi Hong Gan (`facebook-com` session, logged in, no checkpoint)
**Method:** 4 read-only patchright probes against the live site via `tools/_lib/chrome.mjs`.
No fills, no types, no submits. Only allowlisted expansion clicks.

This document exists because `fb-recon-buildplan.md` Task 9 Step 12 says the selectors are "a starting
guess" and must be calibrated before anyone trusts them. That calibration was run **before** building,
not after. The result changes the plan materially.

---

## Verdict

**The concept is validated. The plan's extraction layer is not.**

Group sweeps genuinely surface identifiable people asking answerable questions — that half of the
premise is real and measurable. But three of the plan's load-bearing assumptions are false against
today's DOM, and one of them (`profileIdentity`) silently discards **100% of the real contacts the
sweep finds**.

None of the failures are conceptual. All are small, specific, and fixable. The plan should be amended
before Task 1, not discovered during Task 9.

---

## What was measured

| Probe | Question | Result |
|---|---|---|
| 1 | Feed sweep, plan's extractor as written | **0 posts** over 5 scroll rounds |
| 2 | Why zero? | Root-walk fails: `everHadAuthorLink: true`, `everMatchedActionRe: false` at all 14 levels |
| 3 | Does an ARIA-based root rule fix it? | **Yes — 16 posts** over 8 rounds, 100% of DOM nodes converted |
| 4 | Scrolled group sweep + commenter mining | **14 posts, 14/14 real person IDs**, but 0 permalinks → comment pass never ran |

---

## Finding 1 — the post extractor is broken today (blocks everything)

`src/facebook.ts` finds a post root by requiring `/\b(Comment|Like|Share)\b/` to match the ancestor's
`innerText`. Against the live DOM that regex **never matches at any of the 14 ancestor levels**.

The real accessible names on a post's action bar are:

```
"Like"   "React"   "Leave a comment"
```

There is no `"Comment"` and no `"Share"`. And these are **`aria-label`s on icon buttons**, not
`innerText` — so testing `innerText` finds nothing regardless. (`"Leave a comment"` would fail anyway:
the regex is case-sensitive and the word is lowercase.)

Consequence: `readFeed()` and `readMyPosts()` in the existing production code return **0 posts**. This
is a live bug in shipped code, not just a future fb-recon problem — fb-recon merely inherits it.

**Fix (verified, probe 3):** detect the action bar by ARIA instead of text.

```ts
const ACTION_SEL =
  '[aria-label="Like"],[aria-label="Leave a comment"],[aria-label*="omment"],[aria-label*="Share"],[aria-label="React"]';
// root = nearest ancestor with: a[aria-label]  AND  ACTION_SEL  AND  exactly one message node
```

Measured before/after on the home feed, identical session, same scroll pattern:

| | posts extracted |
|---|---|
| `innerText` rule (as planned) | **0** |
| ARIA rule | **16** |

Virtualization is also confirmed exactly as the plan predicted: DOM node count stayed at 1–5 while the
cumulative unique count climbed to 16. **Extract-per-scroll-round is mandatory** — the plan is right
about this and it must not be relaxed.

---

## Finding 2 — `profileIdentity()` rejects every real contact (blocks the product)

This is the most important finding.

In groups, the member link is **not** `facebook.com/<handle>`. It is group-scoped:

```
https://www.facebook.com/groups/704069361620565/user/100001517402536/
```

The plan's `profileIdentity()` requires `segments.length === 1` and lists `groups` in `NON_PROFILE`,
so this URL returns `null`. Every one of the 14 real people found in the group sweep would be
**silently dropped**.

Worse, this fails in the direction the plan explicitly warns about: it produces a shorter list with no
reason to distrust it.

**Fix:** accept the group-scoped form as a third identity kind.

```ts
if (seg[0] === 'groups' && seg[2] === 'user' && /^\d+$/.test(seg[3] ?? '')) {
  return { id: seg[3], handle: null, kind: 'group-scoped' };
}
```

With that one clause added: **14/14 identities resolved.** Without it: **0/14**.

---

## Finding 3 — where the leads actually are

The group sweep (LHDN E-INVOICE 中文群组, 46.5K members, 10 scroll rounds) returned exactly the shape
of person the feature is for — real humans asking real questions:

- *"May I know need to self bill who. Electric bill under name A and tenancy agreement under name B…"*
- *"想请问我们公司是landlord, tenant是trading, search不到他的公司TIN number…"*
- *"请问一下这里有用platform做airbnb吗？可以请教一下你们怎样做E invoice和 kastam SST。"*

All 14 resolved to a distinct numeric user id. **The core premise holds.**

By contrast the **home feed is advertising soup**. Of 16 posts: stories, AI-course ads, an ACCA ad,
lifestyle pages. Not one person asking a buying question. Author URLs broke down as:

| author URL kind | usable as a contact? |
|---|---|
| `/stories/<id>/…` | no — rejected |
| `facebook.com/<page-handle>` | **accepted, but wrong** — these are business pages, not leads |
| `facebook.com/#` | no — this was the *"Hide post by Stephenie"* button, not the author |

That third row is its own defect: `root.querySelector('a[aria-label]')` grabs whichever aria-labelled
anchor comes first in DOM order, and that is sometimes a **control**, not the author. The author anchor
needs to be selected by href shape, not by document position.

**Recommendation: demote `feed` from the default source.** The plan defaults `sources` to `['feed']`
(Task 9, `svc.fbRecon`). On this account that default yields zero leads and a handful of false-positive
business pages. `group:` should be the default and the documented primary.

---

## Finding 4 — pass 2 cannot run in groups

`withPostHref: 0` — **not one of the 14 group posts exposed a permalink** (`/posts/`, `permalink`,
`multi_permalinks`, `story_fbid`).

This has two consequences the plan does not anticipate:

1. **Commenter mining — which the plan calls the highest-intent source — cannot run on group posts at
   all.** There is no URL to open. Task 9's pass 2 would simply find nothing to do.
2. `Evidence.permalink` would be empty, and `mergeContact` dedupes evidence on
   `` `${e.permalink}::${e.role}` ``. With an empty permalink, **every sighting of the same person
   collapses to one evidence entry** — quietly destroying the accumulating-evidence behaviour that
   Task 4 exists to provide.

On the home feed, 5 of 16 posts had a permalink, and those were `photo/?fbid=…` URLs rather than post
permalinks. So pass 2 has some inventory there, but it is thin and it is the source with no leads in it.

**This is the plan's biggest open risk and it is unresolved.** Getting a group post's permalink needs
its own investigation — likely the timestamp anchor, which may require hovering or reading a
non-obvious attribute.

---

## Finding 5 — smaller items

**Names are missing.** All 14 group contacts came back `author: null`. The display name is not on the
member anchor's `aria-label`. `buildContact` falls back to `name: input.name || identity.id`, so every
contact would be named `"100001517402536"`. Fixable — the name is in the anchor's text content — but
the current selector does not reach it.

**Search is not blocked, but it is thin.** Known risk #1 predicted `search:` might be gated. It is not
— `/search/posts?q=solar` loaded normally, no redirect. But it yielded **1 post in 3 rounds**, and that
post's author anchor pointed at *the group the post lived in*, not a person. Low value, not zero.

**Group inventory is the real constraint.** This account has joined **3 groups**: two accounting, one
e-invoice. There is no solar group, and no topical group for most plausible topics. fb-recon never
joins anything (correctly — joining is a write), so **the feature's ceiling is set by which groups a
human has already joined.** Worth stating plainly to whoever expects "topic in, leads out".

**`m.me` links are unverified.** For numeric ids `messengerLink` produces `https://m.me/100001517402536`.
Whether that resolves for these users was not tested.

**Timestamp scrambling confirmed** — raw sample: `s͏p͏r͏e͏S͏n͏o͏d͏t͏o͏8͏1͏3͏f͏0͏a͏4͏r͏g͏h͏1͏a͏M͏7͏4͏`.
Matches the trap already documented in `tools/INDEX.md`. The plan's decision to report `null` rather
than a parsed date is correct.

---

## Not tested

Stated explicitly so nobody reads absence as success:

- **Comment extraction is entirely untested.** `COMMENT_SEL` (`[role="article"][aria-label*="omment" i]`)
  never got exercised, because no group post exposed a permalink to open. The plan already calls this
  "the most fragile line in the codebase" — it remains completely unvalidated.
- The expand-comments allowlist labels were never confirmed against a real comment thread.
- The classifier path (Task 5) was not exercised; it is pure Node and testable without a browser.

---

## Recommended amendments before Task 1

1. **Fix the action-bar rule** (Finding 1) — in `src/facebook.ts` *and* the new `extract.ts`. This is a
   one-line selector change and it unblocks everything. It also repairs a live production bug.
2. **Add the group-scoped identity clause** to `profileIdentity()` (Finding 2), and add a test asserting
   `/groups/<gid>/user/<uid>/` resolves. Without this the feature harvests nothing from its best source.
3. **Select the author anchor by href shape, not DOM order** (Finding 3), and pull the name from the
   anchor's text (Finding 5).
4. **Resolve group-post permalinks, or redesign pass 2** (Finding 4). If permalinks prove unobtainable,
   pass 2 is feed/thread-only and the plan should say so rather than silently doing nothing. Either way,
   `mergeContact`'s evidence key needs a fallback so empty permalinks don't collapse distinct sightings.
5. **Default `sources` to `group:` rather than `feed`**, and document that coverage is bounded by
   existing group memberships.
6. Keep Task 9 Step 12 (live calibration) anyway — comment extraction still has no evidence behind it.

The two-pass architecture, the read budget, the write fence, the recall-tuned gate, and the
extract-per-scroll-round rule all survive contact with the live site unchanged. The damage is confined
to the extraction and identity layer.
