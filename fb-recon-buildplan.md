# fb-recon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only Facebook prospecting worker that, given a topic, sweeps groups / search / comment threads / feed, gates posts for genuine buying intent, and harvests a deduplicated contact list of interested people with a Messenger link and the quote that proves why.

**Architecture:** A new `src/fb-recon/` module tree behind one service method `svc.fbRecon(opts)`, surfaced through the existing automation-registry pattern (`effect: read`). Two passes: pass 1 sweeps each source inline and scores every post against a per-topic keyword pack (cheap, no navigation); pass 2 opens only the posts that clear the gate and mines their commenters. Contacts merge by normalized profile identity into a single JSON store, so one person seen in five posts is one contact with five pieces of evidence.

**Tech Stack:** TypeScript (NodeNext ESM, `strict: true`), patchright (stealth Chromium fork), `node:test` + `node:assert` via `tsx`, zod (already a dependency, used for MCP tool schemas only).

---

## AMENDED 2026-08-12 after live calibration — read this before Task 0

This plan was probed against the live site **before** any code was written. Four read-only patchright
runs on the real `facebook-com` session. Full evidence: **`docs/fb-recon-feasibility-probe.md`**.

The architecture survived. The extraction and identity layer did not. Five things below are now
corrections, not suggestions — each one was measured, and three of them silently return *nothing*
rather than failing loudly, which is the worst possible failure mode for this feature.

| # | What the plan assumed | What the live site does | Fixed in |
|---|---|---|---|
| 1 | Post root found by `innerText` matching `/\b(Comment\|Like\|Share)\b/` | **Never matches.** Real labels are `"Like"` / `"React"` / `"Leave a comment"`, and they are `aria-label`s on icon buttons, not text. Measured: **0 posts** extracted. With an ARIA rule: **16**. | **Task 0**, Task 6 |
| 2 | A person is `facebook.com/<handle>` or `profile.php?id=` | Group members are `/groups/<gid>/user/<uid>/`. `profileIdentity()` returns `null` for every one. Measured: **0/14** identities resolved; with the fix, **14/14**. | Task 3 |
| 3 | The author is `root.querySelector('a[aria-label]')` | That is sometimes a **control** — one harvested author was the *"Hide post by Stephenie"* button with `href="#"`. Author must be chosen by href shape, not DOM order. | Task 6 |
| 4 | Every gated post has a permalink to open in pass 2 | **0 of 14 group posts exposed one.** Pass 2 cannot run in groups, and empty permalinks collapse `mergeContact`'s evidence dedupe key. | Task 4, Task 9 |
| 5 | `feed` is a sensible default source | On a real account the feed is advertising soup — 16 posts, zero buying questions, and business Pages that pass as "people". Groups are where the leads are. | Task 9 |

**Finding 1 is a live bug in shipped code**, not just a future fb-recon problem: `readFeed()` and
`readMyPosts()` in `src/facebook.ts` return zero posts today. That is why Task 0 exists and why it
comes first.

**Two things remain unproven and must not be assumed:**
- **Comment extraction was never exercised.** No group post exposed a permalink, so `COMMENT_SEL` —
  which this plan already calls its most fragile line — still has *zero* evidence behind it.
- **Group-post permalinks may be unobtainable.** Task 9 Step 12 now has to answer this.

One structural point worth stating plainly: fb-recon never joins groups (joining is a write), so
**the feature's ceiling is whichever groups a human has already joined** — not the topic passed in.
The probe account had 3, none topical. Say this to anyone expecting "topic in, leads out".

---

## Global Constraints

These apply to **every** task. They are not repeated per-task.

- **Node >= 20.** `package.json` `engines.node` is `">=20"`.
- **ESM with NodeNext resolution.** Every relative import MUST carry a `.js` extension even though the source is `.ts` (e.g. `import { x } from './topic.js'`). This is non-negotiable — `moduleResolution: NodeNext` will not resolve extensionless imports.
- **`strict: true`.** Untyped parameters are a build error. Every argument and return type must be explicit.
- **`rootDir` is `src`, `outDir` is `dist`.** `tsconfig.json` has `"include": ["src/**/*.ts"]`, so `src/fb-recon/*.ts` compiles with no config change. Files under `test/` are NOT compiled by `tsc` — they run through `tsx`.
- **No new runtime dependencies.** Current deps are exactly `@modelcontextprotocol/sdk`, `patchright`, `zod`. Everything in this plan uses those plus the Node stdlib.
- **READ-ONLY IS THE PRODUCT.** No file under `src/fb-recon/` may contain `.fill(`, `.type(`, `.press(`, `pressSequentially`, `humanType`, `humanClick`, or any import of `commentOnPost`. All clicking goes through the single `safeClick()` chokepoint defined in Task 7. Task 10 enforces this with a test.
- **Never hardcode a credential, an API key, or an absolute personal path** into any file in this repo. The classifier's model endpoint comes from environment variables read through `src/config.ts` (Task 5) and nothing else.
- **Wait on the data's shape, never on a timeout.** `docs/stupid-method-to-avoid.md` rules #13 and #14. A readiness wait is "post count rose above N", never `waitForTimeout`.
- **Extract per scroll round, never once at the end.** The Facebook timeline is virtualized: scrolling destroys the DOM nodes of earlier posts. Scroll-then-extract silently under-reports and is the single most likely source of a confidently wrong number.

### A note on the "zero writes" guarantee

An earlier framing of this feature promised "a full run issues zero POST requests to facebook.com". **That assertion is not achievable and must not be written as a test.** Facebook's own client fires `POST /api/graphql/` continuously in response to plain scrolling; a purely passive session produces dozens of them. The guarantee this plan actually enforces is narrower and genuinely verifiable:

1. `src/fb-recon/**` contains no text-input or form-submit API call whatsoever (statically asserted, Task 10).
2. Every click in the module routes through `safeClick()`, which matches the target's accessible name against an **allowlist** and throws on anything else (Task 7).
3. Dialogs are dismissed and downloads cancelled at the page level (Task 7).

That is a structural guarantee rather than a network-traffic one, and it is stronger where it counts: the code physically cannot compose a comment.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/facebook.ts` | **Modified.** Repair the dead post-root rule that returns zero posts today. | 0 |
| `src/readlimit.ts` | Read-side budget: scroll pacing, page-open caps per run and per hour. Sibling of `sendlimit.ts`. | 1 |
| `src/fb-recon/topic.ts` | Topic pack load/save/generate-stub + pure text scoring. No I/O beyond the pack file. | 2 |
| `src/fb-recon/contact.ts` | Pure parsing: MY phone numbers, wa.me links, emails, profile identity, m.me derivation. | 3 |
| `src/fb-recon/store.ts` | Contact persistence and merge-by-identity. | 4 |
| `src/fb-recon/classify.ts` | `Classifier` interface, pass-through default, OpenAI-compatible batch implementation. | 5 |
| `src/fb-recon/extract.ts` | Browser-side extractor sources (posts with author URL, comments). Strings evaluated in-page. | 6 |
| `src/fb-recon/browser.ts` | `safeClick`, `expandSeeMore`, `expandComments`, dialog/download guards. The write-fence. | 7 |
| `src/fb-recon/sources.ts` | Source specs → URLs, and per-source sweep behaviour. | 8 |
| `src/fb-recon/index.ts` | The two-pass engine. Public entry: `runReconSweep()`. | 9 |
| `src/automations/facebook/recon.ts` | Registry card, `effect: read`. | 9 |
| `test/fbrecon.*.test.ts` | Unit tests per module. | 1–10 |

Modified: `package.json` (test script), `src/config.ts` (classifier env), `src/service.ts` (`fbRecon`), `src/api.ts` (route), `src/mcp.ts` (tool), `src/cli.ts` (command), `src/facebook.ts` (export `MESSAGE_SEL` is already exported — no change needed unless Task 6 says otherwise).

---

## Task 0: Repair the post extractor (do this first — nothing works without it)

`src/facebook.ts` locates a post root by requiring `/\b(Comment|Like|Share)\b/` to match an ancestor's
`innerText`. Against the live DOM that regex **never matches at any of the 14 ancestor levels**, so
`readFeed()` and `readMyPosts()` return zero posts right now. fb-recon's extractor is a copy of this
one, so the bug would be inherited on day one.

The action bar renders as icon buttons whose accessible names are `"Like"`, `"React"` and
`"Leave a comment"` — there is no `"Comment"` and no `"Share"`, the words live in `aria-label` rather
than text, and the regex is case-sensitive so `"Leave a comment"` would miss anyway. Three independent
reasons the same line cannot fire.

**Files:**
- Modify: `src/facebook.ts`
- Create: `test/facebook.extract.test.ts`

- [ ] **Step 1: Write the failing test**

The in-page body cannot be unit-tested without a browser, but the *rule* can be asserted in the source.

```ts
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'facebook.ts'), 'utf8');

test('the post root is not detected by matching innerText against action words', () => {
  assert.ok(
    !/actionRe\s*=\s*\/\\b\(Comment\|Like\|Share\)\\b\//.test(SRC),
    'the innerText action regex never matches the live DOM and yields zero posts',
  );
});

test('the post root is detected by an ARIA action selector instead', () => {
  assert.match(SRC, /ACTION_SEL/, 'expected an aria-label based action selector');
  assert.match(SRC, /aria-label\*?=\\?"?omment/i, 'expected the comment control to be matched by aria-label');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test test/facebook.extract.test.ts`
Expected: FAIL — the current source still contains the dead regex.

- [ ] **Step 3: Apply the fix**

In `src/facebook.ts`, delete the `actionRe` constant and add, next to `MESSAGE_SEL`:

```ts
/**
 * The post action bar, matched by ARIA.
 *
 * Facebook renders Like / Comment / Share as icon buttons: the words live in
 * `aria-label`, and the rendered text contains neither "Comment" nor "Share".
 * The previous rule tested `innerText` against /\b(Comment|Like|Share)\b/ and so
 * never fired — measured 2026-08-12, it found the author link at ancestor level
 * 3 and still rejected every one of the 14 levels, returning zero posts.
 *
 * Measured on the home feed, same session, same scroll pattern:
 *   innerText rule -> 0 posts.   this rule -> 16 posts.
 *
 * See docs/fb-recon-feasibility-probe.md finding 1.
 */
export const ACTION_SEL =
  '[aria-label="Like"],[aria-label="React"],[aria-label*="omment"],[aria-label*="Share"]';

/** Substituted with ACTION_SEL when EXTRACT is stringified for the page. */
declare const ACTION_SEL_PLACEHOLDER: string;
```

Inside `EXTRACT`, replace the root test:

```ts
      const authored = node.querySelector('a[aria-label]');
      const acted = node.querySelector(ACTION_SEL_PLACEHOLDER);
      const msgCount = node.querySelectorAll(MESSAGE_SEL_PLACEHOLDER).length;
      if (authored && acted && msgCount === 1) {
```

and extend the substitution chain:

```ts
const EXTRACT_SRC = EXTRACT.toString()
  .replaceAll('MESSAGE_SEL_PLACEHOLDER', JSON.stringify(MESSAGE_SEL))
  .replaceAll('ACTION_SEL_PLACEHOLDER', JSON.stringify(ACTION_SEL));
```

- [ ] **Step 4: Prove it against the live site**

This is a real bug fix, so it needs a real result — not a passing unit test. With the daemon running
and the `facebook.com` session ready:

```bash
node dist/cli.js fb feed --limit 10
```

Expected: a non-zero number of posts with author names. **Zero posts means the fix did not work** —
do not proceed to Task 1 on the strength of the source looking right.

> If the browser will not attach, a Chrome holding `E:\eter-browser\profiles\agent` without a debug
> port is the usual cause. `tools/INDEX.md` documents the one-liner that clears it. Do not debug the
> script for this.

- [ ] **Step 5: Commit**

```bash
git add src/facebook.ts test/facebook.extract.test.ts
git commit -m "fix(facebook): detect the post action bar by ARIA, not innerText

The innerText rule never matched the live DOM, so readFeed() and
readMyPosts() returned zero posts. Measured: 0 -> 16 on the home feed."
```

---

## Task 1: Read budget

The existing `sendlimit.ts` deliberately does not throttle reads. A 200-post sweep with 40 post-opens is exactly the traffic pattern that gets an account flagged, so reads need their own budget. This mirrors `SendLimiter`'s shape (constructor takes a file path and a limits object; state persists as JSON) so the two read the same way.

**Files:**
- Create: `src/readlimit.ts`
- Create: `test/fbrecon.readlimit.test.ts`
- Modify: `package.json` (add a `test` script — the repo currently has none)

**Interfaces:**
- Consumes: nothing.
- Produces: `export interface ReadLimits`, `export const DEFAULT_READ_LIMITS: ReadLimits`, `export class ReadLimiter` with `constructor(file: string, limits?: Partial<ReadLimits>)`, `async takeScroll(): Promise<void>`, `async takePageOpen(): Promise<void>`, `takePost(): boolean`, `resetRun(): void`, `snapshot(): ReadSnapshot`.

- [ ] **Step 1: Add the test script**

The repo has `test/recon.settle.test.ts` using `node:test`, but no way to run it. `test/` is outside `rootDir`, so it must run through `tsx`.

In `package.json`, add to `"scripts"`:

```json
"test": "tsx --test test/*.test.ts"
```

- [ ] **Step 2: Verify the existing test suite runs**

Run: `npm test`
Expected: `test/recon.settle.test.ts` executes. It may pass or fail — you only need to confirm the runner works and reports results. If `tsx` cannot resolve `../src/recon.js`, stop and fix the script before continuing.

- [ ] **Step 3: Write the failing test**

Create `test/fbrecon.readlimit.test.ts`:

```ts
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReadLimiter, DEFAULT_READ_LIMITS } from '../src/readlimit.js';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fbrecon-')), 'read-history.json');
}

test('takePost returns false once the per-run post cap is reached', () => {
  const lim = new ReadLimiter(tmpFile(), { postsPerRun: 3 });
  assert.equal(lim.takePost(), true);
  assert.equal(lim.takePost(), true);
  assert.equal(lim.takePost(), true);
  assert.equal(lim.takePost(), false, 'fourth post must be refused');
});

test('resetRun clears per-run counters but not the hourly history', async () => {
  const file = tmpFile();
  const lim = new ReadLimiter(file, { postsPerRun: 1, pageOpensPerRun: 1, pageOpensPerHour: 10 });
  assert.equal(lim.takePost(), true);
  await lim.takePageOpen();
  lim.resetRun();
  assert.equal(lim.takePost(), true, 'run counter must reset');
  assert.equal(lim.snapshot().opensLastHour, 1, 'hourly history must survive resetRun');
});

test('takePageOpen throws once the per-run open cap is reached', async () => {
  const lim = new ReadLimiter(tmpFile(), { pageOpensPerRun: 1 });
  await lim.takePageOpen();
  await assert.rejects(() => lim.takePageOpen(), /per-run/i);
});

test('takePageOpen refuses rather than waiting past maxWaitMs', async () => {
  const lim = new ReadLimiter(tmpFile(), { pageOpensPerHour: 1, pageOpensPerRun: 99, maxWaitMs: 50 });
  await lim.takePageOpen();
  await assert.rejects(() => lim.takePageOpen(), /would need to wait/i);
});

test('hourly history round-trips through the state file', async () => {
  const file = tmpFile();
  const a = new ReadLimiter(file, DEFAULT_READ_LIMITS);
  await a.takePageOpen();
  const b = new ReadLimiter(file, DEFAULT_READ_LIMITS);
  assert.equal(b.snapshot().opensLastHour, 1);
});

test('a malformed state file starts from an empty budget instead of throwing', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'not json at all');
  const lim = new ReadLimiter(file, DEFAULT_READ_LIMITS);
  assert.equal(lim.snapshot().opensLastHour, 0);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx tsx --test test/fbrecon.readlimit.test.ts`
Expected: FAIL — `Cannot find module '../src/readlimit.js'`.

- [ ] **Step 5: Implement `src/readlimit.ts`**

```ts
/**
 * Read-side budget for fb-recon.
 *
 * sendlimit.ts deliberately does not throttle reads — for WhatsApp that is
 * correct, because reading a chat you already opened costs nothing. A recon
 * sweep is different: it is hundreds of scroll events and dozens of post
 * navigations against a platform that measures exactly that. So reads get
 * their own budget, shaped the same way as the send budget so the two read
 * alike.
 *
 * Two different clocks are in play. Per-RUN caps bound the blast radius of a
 * single invocation and live in memory. The per-HOUR cap has to survive
 * process restarts — the daemon restarts often, and an in-memory counter would
 * hand back a fresh hourly budget every time it came up — so it persists to
 * disk next to the vault manifest, exactly like send-history.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from './human.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;

export interface ReadLimits {
  /** Posts extracted in one run, across every source. A ceiling on the sweep. */
  postsPerRun: number;
  /** Pass-2 navigations in one run. The genuinely risky number, so it is the smallest. */
  pageOpensPerRun: number;
  /** Pass-2 navigations per rolling hour, across runs. Survives restarts. */
  pageOpensPerHour: number;
  /** Light pacing on the scroll loop, nothing more. */
  scrollsPerMinute: number;
  /** Refuse rather than block longer than this. 0 = wait however long it takes. */
  maxWaitMs: number;
}

export const DEFAULT_READ_LIMITS: ReadLimits = {
  postsPerRun: 200,
  pageOpensPerRun: 40,
  pageOpensPerHour: 60,
  scrollsPerMinute: 20,
  maxWaitMs: 120_000,
};

export interface ReadSnapshot {
  postsThisRun: number;
  opensThisRun: number;
  opensLastHour: number;
  limits: ReadLimits;
}

export class ReadLimiter {
  readonly #limits: ReadLimits;
  #opens: number[] = [];
  #scrolls: number[] = [];
  #postsThisRun = 0;
  #opensThisRun = 0;

  constructor(
    private readonly file: string,
    limits: Partial<ReadLimits> = {},
  ) {
    this.#limits = { ...DEFAULT_READ_LIMITS, ...limits };
    this.#load();
  }

  /** Per-run post ceiling. Returns false instead of throwing: the sweep should
   *  stop cleanly and report what it got, not lose the harvest to an exception. */
  takePost(): boolean {
    if (this.#postsThisRun >= this.#limits.postsPerRun) return false;
    this.#postsThisRun++;
    return true;
  }

  /** Light token bucket on scrolling. Always waits; never refuses. */
  async takeScroll(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.#scrolls = this.#scrolls.filter((t) => now - t < MINUTE);
      if (this.#scrolls.length < this.#limits.scrollsPerMinute) {
        this.#scrolls.push(now);
        return;
      }
      await sleep(MINUTE - (now - this.#scrolls[0]) + 250);
    }
  }

  /**
   * Pass-2 navigation. Throws on the run cap (the caller should stop opening
   * and finish with what it has) and throws rather than blocking forever on the
   * hourly cap.
   */
  async takePageOpen(): Promise<void> {
    if (this.#opensThisRun >= this.#limits.pageOpensPerRun) {
      throw new Error(
        `fb-recon per-run page-open cap reached (${this.#limits.pageOpensPerRun}). ` +
          'Finish this run and start another, or raise pageOpensPerRun.',
      );
    }

    const now = Date.now();
    this.#prune(now);
    if (this.#opens.length >= this.#limits.pageOpensPerHour) {
      const waitMs = HOUR - (now - this.#opens[0]) + 250;
      if (this.#limits.maxWaitMs > 0 && waitMs > this.#limits.maxWaitMs) {
        throw new Error(
          `fb-recon hourly page-open cap reached; would need to wait ${Math.round(waitMs / 1000)}s. ` +
            'Refusing rather than holding the browser hostage.',
        );
      }
      await sleep(waitMs);
      this.#prune(Date.now());
    }

    this.#opens.push(Date.now());
    this.#opensThisRun++;
    this.#save();
  }

  /** Clear per-run counters. The hourly history deliberately survives. */
  resetRun(): void {
    this.#postsThisRun = 0;
    this.#opensThisRun = 0;
  }

  snapshot(): ReadSnapshot {
    this.#prune(Date.now());
    return {
      postsThisRun: this.#postsThisRun,
      opensThisRun: this.#opensThisRun,
      opensLastHour: this.#opens.length,
      limits: this.#limits,
    };
  }

  #prune(now: number): void {
    this.#opens = this.#opens.filter((t) => now - t < HOUR);
  }

  #load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { opens?: number[] };
      this.#opens = (raw.opens ?? []).filter((t) => typeof t === 'number');
      this.#prune(Date.now());
    } catch {
      // No file yet, or unreadable. Starting from an empty budget is the
      // permissive failure; refusing every read because a JSON file is
      // malformed breaks the tool over bookkeeping.
    }
  }

  #save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ opens: this.#opens }, null, 1));
    } catch {
      // Losing the log costs accuracy on the hourly cap; failing the sweep
      // costs the user their harvest. Prefer the former.
    }
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsx --test test/fbrecon.readlimit.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors from `src/readlimit.ts`.

- [ ] **Step 8: Commit**

```bash
git add package.json src/readlimit.ts test/fbrecon.readlimit.test.ts
git commit -m "feat(fb-recon): add read-side budget with per-run and hourly page-open caps"
```

---

## Task 2: Topic pack and scoring

The topic is a runtime parameter, so the gate cannot be a hardcoded solar keyword list. A **topic pack** is a small JSON file per topic holding the keywords, the buying-intent phrases (including Malay and Manglish, which an English-only list scores at zero), and the negative terms that keep competitors and recruiters out of a lead list. The pack is generated once and then hand-edited forever — a scan never overwrites it, on the same principle that `notes.json` survives a rescan in the recon design.

The scorer is deliberately loose. It is a **prefilter optimised for recall**, not a decision: its job is to cut a 300-post sweep down to ~30 candidates cheaply, and the classifier in Task 5 supplies precision.

**Files:**
- Create: `src/fb-recon/topic.ts`
- Create: `test/fbrecon.topic.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export interface TopicPack`, `export interface TopicScore`, `export const DEFAULT_MIN_SCORE: number`, `export function scoreText(pack: TopicPack, text: string): TopicScore`, `export function loadPack(dir: string, topic: string): TopicPack | null`, `export function savePack(dir: string, pack: TopicPack): void`, `export function starterPack(topic: string): TopicPack`, `export function packPath(dir: string, topic: string): string`.

- [ ] **Step 1: Write the failing test**

Create `test/fbrecon.topic.test.ts`:

```ts
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scoreText, loadPack, savePack, starterPack, DEFAULT_MIN_SCORE, type TopicPack } from '../src/fb-recon/topic.js';

const PACK: TopicPack = {
  topic: 'solar',
  include: ['solar', 'solar panel', 'nem', 'tnb'],
  intent: ['berapa harga', 'nak pasang', 'how much', 'recommend', 'quotation'],
  negative: ['we supply', 'dealer wanted', 'jawatan kosong', 'hiring'],
  generatedAt: '2026-08-12T00:00:00.000Z',
};

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fbrecon-topic-'));
}

test('a buying question in Malay scores above the gate', () => {
  const s = scoreText(PACK, 'Berapa harga solar untuk rumah teres? Nak pasang tahun ni.');
  assert.ok(s.score >= DEFAULT_MIN_SCORE, `expected pass, got ${s.score}`);
  assert.deepEqual(s.hits.intent.sort(), ['berapa harga', 'nak pasang']);
});

test('a buying question in English scores above the gate', () => {
  const s = scoreText(PACK, 'Anyone can recommend a solar installer? How much for 6kW?');
  assert.ok(s.score >= DEFAULT_MIN_SCORE, `expected pass, got ${s.score}`);
});

test('a seller post is pushed below the gate by negative terms', () => {
  const s = scoreText(PACK, 'We supply solar panel and full NEM package, dealer wanted nationwide!');
  assert.ok(s.score < DEFAULT_MIN_SCORE, `expected reject, got ${s.score}`);
  assert.ok(s.hits.negative.length > 0);
});

test('an off-topic post scores zero', () => {
  assert.equal(scoreText(PACK, 'Selling my old Myvi, still good condition').score, 0);
});

test('matching is case-insensitive and ignores repeated hits of the same term', () => {
  const once = scoreText(PACK, 'solar');
  const thrice = scoreText(PACK, 'SOLAR solar Solar');
  assert.equal(once.score, thrice.score, 'repeating a keyword must not inflate the score');
});

test('substring collisions do not count as hits', () => {
  // "nem" must not match inside "phenomenal".
  assert.equal(scoreText(PACK, 'a phenomenal day').score, 0);
});

test('savePack then loadPack round-trips', () => {
  const dir = tmpDir();
  savePack(dir, PACK);
  assert.deepEqual(loadPack(dir, 'solar'), PACK);
});

test('loadPack returns null for a topic with no pack', () => {
  assert.equal(loadPack(tmpDir(), 'nonexistent'), null);
});

test('topic names are slugged so they cannot escape the pack directory', () => {
  const dir = tmpDir();
  const evil = { ...starterPack('../../etc/passwd'), topic: '../../etc/passwd' };
  savePack(dir, evil);
  const written = fs.readdirSync(dir);
  assert.equal(written.length, 1);
  assert.ok(!written[0].includes('..'), `slug leaked traversal: ${written[0]}`);
});

test('starterPack always includes the topic itself as a keyword', () => {
  assert.ok(starterPack('solar').include.includes('solar'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/fbrecon.topic.test.ts`
Expected: FAIL — `Cannot find module '../src/fb-recon/topic.js'`.

- [ ] **Step 3: Implement `src/fb-recon/topic.ts`**

```ts
/**
 * The topic pack: what "interested in X" means, as data rather than code.
 *
 * The gate has to answer two different questions and they are not the same
 * one. "Is this post about solar?" is easy and nearly useless on its own — a
 * competitor posting their install portfolio matches every topic keyword and is
 * worth nothing. "Does this person want to buy?" is the signal that pays, and
 * in this market it is often not in English: "berapa harga", "nak pasang",
 * "worth it tak". So intent phrases are weighted far above topic keywords, and
 * negative terms exist purely to push sellers and recruiters back under the
 * gate.
 *
 * This scorer is a PREFILTER, tuned for recall. Letting a seller through costs
 * one classifier call. Dropping a real buyer costs a lead, and nothing
 * downstream can recover them. When in doubt it lets the post through.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface TopicPack {
  topic: string;
  /** Subject-matter terms. Cheap, weak signal. */
  include: string[];
  /** Buying-intent phrases. The signal that actually matters. */
  intent: string[];
  /** Seller / recruiter / promo language. Disqualifying. */
  negative: string[];
  generatedAt: string;
}

export interface TopicScore {
  score: number;
  hits: { include: string[]; intent: string[]; negative: string[] };
}

/** One intent phrase, or three topic keywords, clears the gate. */
export const DEFAULT_MIN_SCORE = 3;

const W_INCLUDE = 1;
const W_INTENT = 3;
const W_NEGATIVE = -5;

/** Cap per bucket so one keyword-stuffed post cannot outrank a real question. */
const CAP_INCLUDE = 3;
const CAP_INTENT = 9;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Boundary-aware, case-insensitive containment.
 *
 * A bare `includes()` matches "nem" inside "phenomenal" and quietly poisons
 * every score. \b does not work for multi-word phrases with punctuation, so the
 * boundary is asserted with lookarounds against the word characters themselves.
 */
function contains(haystack: string, needle: string): boolean {
  if (!needle.trim()) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(needle)}(?![\\p{L}\\p{N}])`, 'iu').test(haystack);
}

/** Deduplicated by construction: each term is tested once, so repeats cannot inflate. */
export function scoreText(pack: TopicPack, text: string): TopicScore {
  const body = (text ?? '').replace(/\s+/g, ' ');
  const hits = {
    include: pack.include.filter((t) => contains(body, t)),
    intent: pack.intent.filter((t) => contains(body, t)),
    negative: pack.negative.filter((t) => contains(body, t)),
  };

  const score =
    Math.min(hits.include.length * W_INCLUDE, CAP_INCLUDE) +
    Math.min(hits.intent.length * W_INTENT, CAP_INTENT) +
    hits.negative.length * W_NEGATIVE;

  return { score: Math.max(0, score), hits };
}

/** Topic names reach us from a CLI flag, so they are untrusted path input. */
function slug(topic: string): string {
  const s = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'topic';
}

export function packPath(dir: string, topic: string): string {
  return path.join(dir, `${slug(topic)}.json`);
}

export function loadPack(dir: string, topic: string): TopicPack | null {
  try {
    return JSON.parse(fs.readFileSync(packPath(dir, topic), 'utf8')) as TopicPack;
  } catch {
    return null;
  }
}

export function savePack(dir: string, pack: TopicPack): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(packPath(dir, pack.topic), JSON.stringify(pack, null, 2));
}

/**
 * The pack you get before anyone has tuned it. Intent phrases are
 * topic-independent on purpose — "how much", "berapa harga" and "recommend"
 * signal buying regardless of what is being bought — so a fresh topic is
 * usable immediately and gets better the moment a human edits the file.
 */
export function starterPack(topic: string): TopicPack {
  return {
    topic,
    include: [topic],
    intent: [
      'how much',
      'berapa harga',
      'berapa kos',
      'nak pasang',
      'nak beli',
      'looking for',
      'recommend',
      'any recommendation',
      'quotation',
      'quote',
      'worth it',
      'berbaloi',
      'anyone know',
      'sesiapa tahu',
      'best price',
      'pm me price',
      'dm me',
    ],
    negative: [
      'we supply',
      'we provide',
      'dealer wanted',
      'agent wanted',
      'jawatan kosong',
      'hiring',
      'now hiring',
      'promo',
      'promotion',
      'whatsapp us',
      'contact us today',
      'free consultation',
    ],
    generatedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test test/fbrecon.topic.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/fb-recon/topic.ts test/fbrecon.topic.test.ts
git commit -m "feat(fb-recon): add topic pack with recall-tuned intent scoring"
```

---

## Task 3: Contact field parsing

Facebook exposes no phone or email on a post. What is actually harvestable read-only is: the display name, the profile URL, a derived `m.me` Messenger link, and whatever the person typed into their own post or comment — which in Malaysian buy/sell groups very often includes a mobile number or a `wa.me` link. This task is all pure string work and is the most heavily tested module in the plan, because every downstream contact record depends on it.

**Files:**
- Create: `src/fb-recon/contact.ts`
- Create: `test/fbrecon.contact.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export interface ContactFields`, `export interface ProfileIdentity`, `export function extractContactFields(text: string): ContactFields`, `export function profileIdentity(url: string | null): ProfileIdentity | null`, `export function messengerLink(id: ProfileIdentity): string`.

- [ ] **Step 1: Write the failing test**

Create `test/fbrecon.contact.test.ts`:

```ts
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { extractContactFields, profileIdentity, messengerLink } from '../src/fb-recon/contact.js';

test('extracts a Malaysian mobile in local format and normalises to +60', () => {
  const f = extractContactFields('Interested! My number 012-345 6789 thanks');
  assert.deepEqual(f.phones, ['+60123456789']);
});

test('extracts an international-format Malaysian mobile', () => {
  assert.deepEqual(extractContactFields('call +60 19 8765432').phones, ['+60198765432']);
});

test('the same number written two ways yields one entry', () => {
  const f = extractContactFields('0123456789 or +60123456789 or 012-345-6789');
  assert.deepEqual(f.phones, ['+60123456789']);
});

test('does not mistake a long digit run for a phone number', () => {
  assert.deepEqual(extractContactFields('order id 900123456789012345').phones, []);
});

test('extracts a wa.me link and normalises the number', () => {
  const f = extractContactFields('whatsapp me https://wa.me/60123456789 anytime');
  assert.deepEqual(f.waLinks, ['+60123456789']);
});

test('extracts an api.whatsapp.com send link', () => {
  const f = extractContactFields('https://api.whatsapp.com/send?phone=60129998888&text=hi');
  assert.deepEqual(f.waLinks, ['+60129998888']);
});

test('extracts an email and lowercases it', () => {
  assert.deepEqual(extractContactFields('mail me at Ali.Bin@Example.COM').emails, ['ali.bin@example.com']);
});

test('empty text yields empty arrays, never undefined', () => {
  const f = extractContactFields('');
  assert.deepEqual(f, { phones: [], waLinks: [], emails: [] });
});

test('identifies a vanity profile URL', () => {
  const id = profileIdentity('https://www.facebook.com/ali.bin.abu');
  assert.deepEqual(id, { id: 'ali.bin.abu', handle: 'ali.bin.abu', kind: 'handle' });
});

test('identifies a numeric profile URL', () => {
  const id = profileIdentity('https://www.facebook.com/profile.php?id=100001234567890');
  assert.deepEqual(id, { id: '100001234567890', handle: null, kind: 'numeric' });
});

test('identifies a group-scoped member URL', () => {
  // The ONLY form group posts expose. Measured 2026-08-12: 14 of 14 real leads
  // used this shape and every one was discarded before this clause existed.
  const id = profileIdentity('https://www.facebook.com/groups/704069361620565/user/100001517402536/');
  assert.deepEqual(id, { id: '100001517402536', handle: null, kind: 'group-scoped' });
});

test('two sightings of one person in different groups are the same contact', () => {
  const a = profileIdentity('https://www.facebook.com/groups/111/user/100001517402536/');
  const b = profileIdentity('https://www.facebook.com/groups/222/user/100001517402536/');
  assert.equal(a?.id, b?.id, 'identity must be the person, not the group they were seen in');
});

test('a group landing page is still not a person', () => {
  assert.equal(profileIdentity('https://www.facebook.com/groups/704069361620565'), null);
  assert.equal(profileIdentity('https://www.facebook.com/groups/704069361620565/user/'), null);
});

test('a control anchor is not a person', () => {
  // "Hide post by <name>" renders as a[aria-label] with href="#".
  assert.equal(profileIdentity('https://www.facebook.com/#'), null);
});

test('a story URL is not a person', () => {
  assert.equal(profileIdentity('https://www.facebook.com/stories/122096234379287376/UzpfSVND'), null);
});

test('strips Facebook click-tracking params before identifying', () => {
  const id = profileIdentity('https://www.facebook.com/ali.bin.abu/?__cft__[0]=abc&__tn__=R');
  assert.equal(id?.id, 'ali.bin.abu');
});

test('rejects non-profile facebook paths', () => {
  for (const url of [
    'https://www.facebook.com/groups/123456',
    'https://www.facebook.com/permalink.php?story_fbid=1&id=2',
    'https://www.facebook.com/watch/?v=99',
    'https://www.facebook.com/marketplace/item/55',
    'https://www.facebook.com/hashtag/solar',
    'https://www.facebook.com/photo/?fbid=1',
  ]) {
    assert.equal(profileIdentity(url), null, `should reject ${url}`);
  }
});

test('rejects a non-facebook host and null input', () => {
  assert.equal(profileIdentity('https://example.com/ali'), null);
  assert.equal(profileIdentity(null), null);
});

test('builds an m.me link from either identity kind', () => {
  assert.equal(messengerLink({ id: 'ali.bin.abu', handle: 'ali.bin.abu', kind: 'handle' }), 'https://m.me/ali.bin.abu');
  assert.equal(messengerLink({ id: '100001234567890', handle: null, kind: 'numeric' }), 'https://m.me/100001234567890');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/fbrecon.contact.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/fb-recon/contact.ts`**

```ts
/**
 * Turning what a person typed into something you can actually contact.
 *
 * Facebook publishes no phone and no email on a post, so the reliable contact
 * channel is Messenger, derived from the profile URL. Everything else in here
 * is opportunistic: in Malaysian buy/sell and interest groups people routinely
 * type their own mobile into a comment ("012-345 6789 pm me"), and that
 * self-published number is the highest-value field we can get. We take it when
 * it is offered and never go looking for it anywhere else.
 */

/** Malaysian mobile: 01x followed by 7 or 8 digits, local or +60 form. */
const PHONE_RE = /(?<![\d])(?:\+?60[\s.-]?|0)1\d[\s.-]?\d{3,4}[\s.-]?\d{4}(?![\d])/g;
const WA_RE = /(?:wa\.me\/|api\.whatsapp\.com\/send\/?\?phone=)(\+?\d{8,15})/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]{2,}/g;

/**
 * Path segments that are Facebook features, not people. Without this every
 * group link and photo permalink becomes a phantom "contact".
 */
const NON_PROFILE = new Set([
  'groups', 'photo', 'photos', 'watch', 'reel', 'reels', 'video', 'videos',
  'marketplace', 'events', 'pages', 'hashtag', 'story.php', 'permalink.php',
  'share', 'posts', 'media', 'search', 'notes', 'help', 'privacy', 'policies',
  'settings', 'bookmarks', 'friends', 'gaming', 'live', 'business', 'ads',
]);

export interface ContactFields {
  /** E.164, +60 normalised. */
  phones: string[];
  /** Numbers behind wa.me / api.whatsapp.com links, E.164 normalised. */
  waLinks: string[];
  emails: string[];
}

export interface ProfileIdentity {
  /** Stable dedupe key: the vanity handle, or the numeric id. */
  id: string;
  handle: string | null;
  /**
   * `group-scoped` is a person seen through a group's member link. The id is
   * still the user id, so the same person found in two different groups merges
   * into one contact — the group is context, not identity.
   */
  kind: 'handle' | 'numeric' | 'group-scoped';
}

/** 0123456789 / +60 12-345 6789 / 60123456789 all collapse to +60123456789. */
function normaliseMy(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, '');
  const local = digits.startsWith('60') ? digits.slice(2) : digits.replace(/^0/, '');
  if (!/^1\d{8,9}$/.test(local)) return null;
  return `+60${local}`;
}

export function extractContactFields(text: string): ContactFields {
  const body = text ?? '';

  const phones = new Set<string>();
  for (const m of body.matchAll(PHONE_RE)) {
    const n = normaliseMy(m[0]);
    if (n) phones.add(n);
  }

  const waLinks = new Set<string>();
  for (const m of body.matchAll(WA_RE)) {
    const n = normaliseMy(m[1]);
    if (n) waLinks.add(n);
  }

  const emails = new Set<string>();
  for (const m of body.matchAll(EMAIL_RE)) emails.add(m[0].toLowerCase());

  return { phones: [...phones], waLinks: [...waLinks], emails: [...emails] };
}

export function profileIdentity(url: string | null): ProfileIdentity | null {
  if (!url) return null;

  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return null;

  const segments = u.pathname.split('/').filter(Boolean);

  /**
   * Group-scoped member link: /groups/<gid>/user/<uid>/.
   *
   * This is the ONLY identity form a group post exposes, and groups are where
   * the leads actually are. Measured 2026-08-12 against a live 46.5K-member
   * group: 14 of 14 harvestable people used this shape, and the segment-length
   * rule below rejected every one of them — a silent total loss that looks
   * exactly like "quiet day on Facebook". See the probe doc, finding 2.
   *
   * The id is the USER id, not the group, so one person seen across several
   * groups merges into a single contact.
   */
  if (segments[0] === 'groups' && segments[2] === 'user' && /^\d+$/.test(segments[3] ?? '')) {
    return { id: segments[3], handle: null, kind: 'group-scoped' };
  }

  const numeric = u.pathname.replace(/\/+$/, '').endsWith('/profile.php')
    ? u.searchParams.get('id')
    : null;
  if (numeric && /^\d+$/.test(numeric)) return { id: numeric, handle: null, kind: 'numeric' };

  if (segments.length !== 1) return null;

  const handle = decodeURIComponent(segments[0]);
  if (NON_PROFILE.has(handle.toLowerCase())) return null;
  // pfbid tokens are post identifiers that happen to sit at path root.
  if (/^pfbid/i.test(handle)) return null;
  if (!/^[\w.-]{3,}$/.test(handle)) return null;

  return { id: handle, handle, kind: 'handle' };
}

export function messengerLink(id: ProfileIdentity): string {
  return `https://m.me/${id.handle ?? id.id}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test test/fbrecon.contact.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Commit**

```bash
git add src/fb-recon/contact.ts test/fbrecon.contact.test.ts
git commit -m "feat(fb-recon): parse phones, wa.me links, emails and profile identity"
```

---

## Task 4: Contact store

One person appearing in five posts must be one contact carrying five pieces of evidence, not five rows. The evidence array is the actual deliverable — it is what lets whoever messages them later open with something specific instead of a cold pitch.

The store loads the whole file into a Map, merges in memory, and rewrites once at the end. At the scale this operates on (thousands of contacts, one run per invocation) that is simpler and safer than append-plus-compaction, and it makes merge semantics trivially testable.

**Files:**
- Create: `src/fb-recon/store.ts`
- Create: `test/fbrecon.store.test.ts`

**Interfaces:**
- Consumes: `ContactFields`, `ProfileIdentity` from `./contact.js` (Task 3).
- Produces: `export type Intent`, `export interface Evidence`, `export interface FbContact`, `export type ContactMap`, `export function loadContacts(file: string): ContactMap`, `export function saveContacts(file: string, map: ContactMap): void`, `export function mergeContact(map: ContactMap, incoming: FbContact): boolean`, `export function toCsv(map: ContactMap): string`.

- [ ] **Step 1: Write the failing test**

Create `test/fbrecon.store.test.ts`:

```ts
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadContacts, saveContacts, mergeContact, toCsv, type FbContact, type ContactMap } from '../src/fb-recon/store.js';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fbrecon-store-')), 'contacts.json');
}

function contact(over: Partial<FbContact> = {}): FbContact {
  return {
    id: 'ali.bin.abu',
    name: 'Ali Bin Abu',
    profileUrl: 'https://www.facebook.com/ali.bin.abu',
    messenger: 'https://m.me/ali.bin.abu',
    phones: [],
    waLinks: [],
    emails: [],
    evidence: [],
    intent: 'researching',
    score: 3,
    firstSeen: '2026-08-12T00:00:00.000Z',
    lastSeen: '2026-08-12T00:00:00.000Z',
    ...over,
  };
}

test('mergeContact reports true for a new contact and false for a repeat', () => {
  const map: ContactMap = new Map();
  assert.equal(mergeContact(map, contact()), true);
  assert.equal(mergeContact(map, contact()), false);
  assert.equal(map.size, 1);
});

test('evidence from separate sightings accumulates on one contact', () => {
  const map: ContactMap = new Map();
  mergeContact(map, contact({ evidence: [{ permalink: 'p1', quote: 'how much?', sourceKind: 'group', role: 'author', at: 'a' }] }));
  mergeContact(map, contact({ evidence: [{ permalink: 'p2', quote: 'still looking', sourceKind: 'feed', role: 'commenter', at: 'b' }] }));
  assert.equal(map.get('ali.bin.abu')!.evidence.length, 2);
});

test('the same permalink and role is not recorded twice', () => {
  const map: ContactMap = new Map();
  const ev = { permalink: 'p1', quote: 'how much?', sourceKind: 'group' as const, role: 'author' as const, at: 'a' };
  mergeContact(map, contact({ evidence: [ev] }));
  mergeContact(map, contact({ evidence: [{ ...ev, quote: 'reworded but same post' }] }));
  assert.equal(map.get('ali.bin.abu')!.evidence.length, 1);
});

test('sightings with no permalink stay distinct instead of collapsing', () => {
  // Group posts expose no permalink at all (probe finding 4). Keying evidence on
  // permalink alone would make every sighting of one person look like a repeat,
  // quietly destroying the evidence trail this whole feature exists to build.
  const map: ContactMap = new Map();
  mergeContact(map, contact({ evidence: [{ permalink: '', quote: 'berapa harga?', sourceKind: 'group', role: 'author', at: 'a' }] }));
  mergeContact(map, contact({ evidence: [{ permalink: '', quote: 'still waiting for quote', sourceKind: 'group', role: 'author', at: 'b' }] }));
  assert.equal(map.get('ali.bin.abu')!.evidence.length, 2);
});

test('the same permalink-less quote is still deduped', () => {
  const map: ContactMap = new Map();
  const ev = { permalink: '', quote: 'berapa harga?', sourceKind: 'group' as const, role: 'author' as const, at: 'a' };
  mergeContact(map, contact({ evidence: [ev] }));
  mergeContact(map, contact({ evidence: [{ ...ev, at: 'b' }] }));
  assert.equal(map.get('ali.bin.abu')!.evidence.length, 1);
});

test('contact fields union across sightings', () => {
  const map: ContactMap = new Map();
  mergeContact(map, contact({ phones: ['+60123456789'] }));
  mergeContact(map, contact({ phones: ['+60123456789', '+60198888888'], emails: ['a@b.com'] }));
  const c = map.get('ali.bin.abu')!;
  assert.deepEqual(c.phones.sort(), ['+60123456789', '+60198888888']);
  assert.deepEqual(c.emails, ['a@b.com']);
});

test('intent only ever upgrades, never downgrades', () => {
  const map: ContactMap = new Map();
  mergeContact(map, contact({ intent: 'buying' }));
  mergeContact(map, contact({ intent: 'none' }));
  assert.equal(map.get('ali.bin.abu')!.intent, 'buying');
});

test('score keeps the maximum and lastSeen advances', () => {
  const map: ContactMap = new Map();
  mergeContact(map, contact({ score: 3, lastSeen: '2026-08-12T00:00:00.000Z' }));
  mergeContact(map, contact({ score: 9, lastSeen: '2026-08-13T00:00:00.000Z' }));
  const c = map.get('ali.bin.abu')!;
  assert.equal(c.score, 9);
  assert.equal(c.lastSeen, '2026-08-13T00:00:00.000Z');
  assert.equal(c.firstSeen, '2026-08-12T00:00:00.000Z');
});

test('a missing messenger link is filled in by a later sighting', () => {
  const map: ContactMap = new Map();
  mergeContact(map, contact({ messenger: null }));
  mergeContact(map, contact({ messenger: 'https://m.me/ali.bin.abu' }));
  assert.equal(map.get('ali.bin.abu')!.messenger, 'https://m.me/ali.bin.abu');
});

test('save then load round-trips the map', () => {
  const file = tmpFile();
  const map: ContactMap = new Map();
  mergeContact(map, contact({ phones: ['+60123456789'] }));
  saveContacts(file, map);
  const back = loadContacts(file);
  assert.equal(back.size, 1);
  assert.deepEqual(back.get('ali.bin.abu')!.phones, ['+60123456789']);
});

test('loading a missing file yields an empty map instead of throwing', () => {
  assert.equal(loadContacts(tmpFile()).size, 0);
});

test('csv quotes fields containing commas, quotes and newlines', () => {
  const map: ContactMap = new Map();
  mergeContact(map, contact({
    name: 'Ali, "The Boss"',
    evidence: [{ permalink: 'p1', quote: 'line one\nline two', sourceKind: 'group', role: 'author', at: 'a' }],
  }));
  const csv = toCsv(map);
  const [header, row] = csv.split('\n');
  assert.ok(header.startsWith('id,name,'));
  assert.ok(row.includes('"Ali, ""The Boss"""'), `bad quoting: ${row}`);
  assert.equal(csv.split('\n').length, 2, 'an embedded newline must not create a new CSV row');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/fbrecon.store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/fb-recon/store.ts`**

```ts
/**
 * The contact store. One person is one record, however many times we see them.
 *
 * The evidence array is the point of this whole feature. A name and a Messenger
 * link is a cold lead; a name, a Messenger link, and "asked for a 6kW quote in
 * Solar Malaysia on Tuesday" is a warm one. Sightings therefore accumulate
 * rather than overwrite, and nothing here ever deletes.
 *
 * Whole-file load, merge in memory, single rewrite. At a few thousand contacts
 * that is faster than it sounds and it makes the merge rules testable without a
 * filesystem in the loop.
 */
import fs from 'node:fs';
import path from 'node:path';

export type Intent = 'buying' | 'researching' | 'seller' | 'none';
export type SourceKind = 'group' | 'search' | 'thread' | 'feed';
export type Role = 'author' | 'commenter';

export interface Evidence {
  permalink: string;
  /** What they actually said. Kept verbatim — it is the opener. */
  quote: string;
  sourceKind: SourceKind;
  role: Role;
  at: string;
}

export interface FbContact {
  /** Normalised profile identity. The dedupe key. */
  id: string;
  name: string;
  profileUrl: string;
  messenger: string | null;
  phones: string[];
  waLinks: string[];
  emails: string[];
  evidence: Evidence[];
  intent: Intent;
  score: number;
  firstSeen: string;
  lastSeen: string;
}

export type ContactMap = Map<string, FbContact>;

/** Higher wins on merge. A person who once asked to buy stays a buyer. */
const INTENT_RANK: Record<Intent, number> = { none: 0, seller: 1, researching: 2, buying: 3 };

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

/**
 * How two sightings are judged to be the same sighting.
 *
 * A permalink is the right key when there is one. Group posts frequently expose
 * none at all — measured 2026-08-12, 0 of 14 did — and keying on an empty string
 * would make every later sighting of the same person look like a duplicate, so
 * one contact would end up with exactly one piece of evidence no matter how many
 * times they spoke. That is a silent loss of the thing the feature is for, so
 * the fallback keys on what they actually said instead.
 */
function evidenceKey(e: Evidence): string {
  return e.permalink
    ? `${e.permalink}::${e.role}`
    : `${e.sourceKind}::${e.role}::${e.quote.slice(0, 120)}`;
}

export function loadContacts(file: string): ContactMap {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { contacts?: FbContact[] };
    return new Map((raw.contacts ?? []).map((c) => [c.id, c]));
  } catch {
    return new Map();
  }
}

export function saveContacts(file: string, map: ContactMap): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const contacts = [...map.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  fs.writeFileSync(file, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), contacts }, null, 1));
}

/** Returns true if this was a person we had never seen before. */
export function mergeContact(map: ContactMap, incoming: FbContact): boolean {
  const existing = map.get(incoming.id);
  if (!existing) {
    map.set(incoming.id, { ...incoming, evidence: [...incoming.evidence] });
    return true;
  }

  const seen = new Set(existing.evidence.map(evidenceKey));
  for (const e of incoming.evidence) {
    const k = evidenceKey(e);
    if (!seen.has(k)) {
      existing.evidence.push(e);
      seen.add(k);
    }
  }

  existing.name = existing.name || incoming.name;
  existing.messenger = existing.messenger ?? incoming.messenger;
  existing.phones = union(existing.phones, incoming.phones);
  existing.waLinks = union(existing.waLinks, incoming.waLinks);
  existing.emails = union(existing.emails, incoming.emails);
  existing.score = Math.max(existing.score, incoming.score);
  if (INTENT_RANK[incoming.intent] > INTENT_RANK[existing.intent]) existing.intent = incoming.intent;
  if (incoming.firstSeen < existing.firstSeen) existing.firstSeen = incoming.firstSeen;
  if (incoming.lastSeen > existing.lastSeen) existing.lastSeen = incoming.lastSeen;

  return false;
}

const CSV_COLUMNS = ['id', 'name', 'profileUrl', 'messenger', 'phones', 'waLinks', 'emails', 'intent', 'score', 'sightings', 'lastQuote', 'lastPermalink'] as const;

/** RFC4180 quoting: an unescaped quote or newline in a name silently corrupts
 *  every row after it when the file lands in Excel. */
function cell(value: string | number): string {
  const s = String(value).replace(/\r?\n/g, ' ');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(map: ContactMap): string {
  const rows = [...map.values()].sort((a, b) => b.score - a.score);
  const lines = [CSV_COLUMNS.join(',')];
  for (const c of rows) {
    const last = c.evidence[c.evidence.length - 1];
    lines.push([
      cell(c.id), cell(c.name), cell(c.profileUrl), cell(c.messenger ?? ''),
      cell(c.phones.join(' ')), cell(c.waLinks.join(' ')), cell(c.emails.join(' ')),
      cell(c.intent), cell(c.score), cell(c.evidence.length),
      cell(last?.quote ?? ''), cell(last?.permalink ?? ''),
    ].join(','));
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test test/fbrecon.store.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/fb-recon/store.ts test/fbrecon.store.test.ts
git commit -m "feat(fb-recon): add contact store with merge-by-identity and CSV export"
```

---

## Task 5: Classifier

The regex gate has recall but not precision. The classifier supplies precision on the survivors only — batched, never one call per post, because a 300-post sweep at one call each is the dominant cost of the entire feature.

The endpoint is **configured, never hardcoded**. If no endpoint is configured the module degrades to a pass-through that trusts the regex score, so the feature works out of the box with no AI at all and gets better when you point it at a model.

**Files:**
- Create: `src/fb-recon/classify.ts`
- Create: `test/fbrecon.classify.test.ts`
- Modify: `src/config.ts`

**Interfaces:**
- Consumes: `Intent` from `./store.js` (Task 4).
- Produces: `export interface ClassifyItem`, `export interface Verdict`, `export interface Classifier`, `export const passThroughClassifier: Classifier`, `export function llmClassifier(cfg: LlmConfig): Classifier`, `export function defaultClassifier(): Classifier`, `export function parseVerdicts(raw: string, items: ClassifyItem[]): Verdict[]`.

- [ ] **Step 1: Add config keys**

In `src/config.ts`, add alongside the existing exports (follow the file's established style for reading `process.env`):

```ts
/**
 * Optional intent classifier. Unset means fb-recon runs on its regex gate
 * alone, which is a supported configuration — the pack is tuned for recall, so
 * the cost of no classifier is noise in the contact list, not missed leads.
 * Any OpenAI-compatible /chat/completions endpoint works.
 */
export const FBRECON_LLM_URL = process.env.FBRECON_LLM_URL ?? '';
export const FBRECON_LLM_KEY = process.env.FBRECON_LLM_KEY ?? '';
export const FBRECON_LLM_MODEL = process.env.FBRECON_LLM_MODEL ?? '';
```

- [ ] **Step 2: Write the failing test**

Create `test/fbrecon.classify.test.ts`:

```ts
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { passThroughClassifier, parseVerdicts, type ClassifyItem } from '../src/fb-recon/classify.js';

const ITEMS: ClassifyItem[] = [
  { id: 'a', text: 'berapa harga solar untuk rumah?' },
  { id: 'b', text: 'we supply solar, dealer wanted' },
];

test('pass-through marks every item interested with unknown intent', async () => {
  const out = await passThroughClassifier.classify('solar', ITEMS);
  assert.equal(out.length, 2);
  assert.ok(out.every((v) => v.interested));
  assert.ok(out.every((v) => v.intent === 'researching'));
});

test('parseVerdicts reads a clean JSON array', () => {
  const raw = '[{"id":"a","interested":true,"intent":"buying","why":"asks price"},{"id":"b","interested":false,"intent":"seller","why":"vendor"}]';
  const out = parseVerdicts(raw, ITEMS);
  assert.equal(out.length, 2);
  assert.equal(out[0].intent, 'buying');
  assert.equal(out[1].interested, false);
});

test('parseVerdicts survives a fenced code block wrapper', () => {
  const raw = '```json\n[{"id":"a","interested":true,"intent":"buying","why":"x"}]\n```';
  assert.equal(parseVerdicts(raw, ITEMS)[0].intent, 'buying');
});

test('parseVerdicts survives prose before and after the array', () => {
  const raw = 'Here you go:\n[{"id":"a","interested":true,"intent":"buying","why":"x"}]\nHope that helps!';
  assert.equal(parseVerdicts(raw, ITEMS).length, 1);
});

test('an unparseable response falls back to keeping every item', () => {
  const out = parseVerdicts('the model apologised instead of answering', ITEMS);
  assert.equal(out.length, 2);
  assert.ok(out.every((v) => v.interested), 'a broken classifier must not silently delete leads');
});

test('an unrecognised intent value is coerced rather than thrown', () => {
  const raw = '[{"id":"a","interested":true,"intent":"very-hot","why":"x"}]';
  assert.equal(parseVerdicts(raw, ITEMS)[0].intent, 'researching');
});

test('verdicts for ids we never sent are discarded', () => {
  const raw = '[{"id":"zzz","interested":true,"intent":"buying","why":"hallucinated"}]';
  assert.ok(!parseVerdicts(raw, ITEMS).some((v) => v.id === 'zzz'));
});

test('an item the model omitted is kept, not dropped', () => {
  const raw = '[{"id":"a","interested":true,"intent":"buying","why":"x"}]';
  const out = parseVerdicts(raw, ITEMS);
  const b = out.find((v) => v.id === 'b');
  assert.ok(b, 'omitted item must still appear');
  assert.equal(b!.interested, true);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx tsx --test test/fbrecon.classify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/fb-recon/classify.ts`**

```ts
/**
 * Intent classification for gate survivors.
 *
 * Two rules shape everything here.
 *
 * BATCH. One model call per post turns a 300-post sweep into the most expensive
 * part of the feature by an order of magnitude. Twenty posts per call costs
 * almost the same as one.
 *
 * FAIL OPEN. Every failure path — no endpoint configured, HTTP error, garbage
 * response, an item the model forgot — keeps the item. A classifier that drops
 * leads when it breaks is worse than no classifier, because the failure is
 * invisible: you get a shorter list and no reason to distrust it.
 */
import { FBRECON_LLM_KEY, FBRECON_LLM_MODEL, FBRECON_LLM_URL } from '../config.js';
import type { Intent } from './store.js';

export interface ClassifyItem {
  id: string;
  text: string;
}

export interface Verdict {
  id: string;
  interested: boolean;
  intent: Intent;
  why: string;
}

export interface Classifier {
  classify(topic: string, items: ClassifyItem[]): Promise<Verdict[]>;
}

export interface LlmConfig {
  url: string;
  key: string;
  model: string;
  batchSize?: number;
}

const VALID_INTENTS: readonly Intent[] = ['buying', 'researching', 'seller', 'none'];
const DEFAULT_BATCH = 20;
/** Long enough to carry intent, short enough that 20 fit comfortably in one call. */
const MAX_TEXT = 600;

function keep(item: ClassifyItem, why: string): Verdict {
  return { id: item.id, interested: true, intent: 'researching', why };
}

export const passThroughClassifier: Classifier = {
  async classify(_topic: string, items: ClassifyItem[]): Promise<Verdict[]> {
    return items.map((i) => keep(i, 'no classifier configured; kept on regex score'));
  },
};

/**
 * Tolerant parse. Models wrap JSON in fences, prepend prose, and occasionally
 * invent an enum value. None of that is worth losing a batch over.
 */
export function parseVerdicts(raw: string, items: ClassifyItem[]): Verdict[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const found = new Map<string, Verdict>();

  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
      if (Array.isArray(parsed)) {
        for (const row of parsed) {
          const r = row as { id?: unknown; interested?: unknown; intent?: unknown; why?: unknown };
          const id = typeof r.id === 'string' ? r.id : '';
          if (!byId.has(id)) continue; // ignore ids we never sent
          const intent = VALID_INTENTS.includes(r.intent as Intent) ? (r.intent as Intent) : 'researching';
          found.set(id, {
            id,
            interested: r.interested !== false,
            intent,
            why: typeof r.why === 'string' ? r.why.slice(0, 200) : '',
          });
        }
      }
    } catch {
      // Fall through to the keep-everything path below.
    }
  }

  return items.map((i) => found.get(i.id) ?? keep(i, 'classifier gave no verdict for this item'));
}

function prompt(topic: string, items: ClassifyItem[]): string {
  return [
    `You are screening Facebook posts and comments to find people who might BUY ${topic}.`,
    '',
    'For each item decide:',
    `- interested: true if this person could plausibly become a customer for ${topic}.`,
    '- intent: "buying" (asking price, quotes, ready to install), "researching" (curious,',
    '  comparing, asking opinions), "seller" (a vendor, installer, agent or recruiter —',
    '  NOT a customer), or "none" (unrelated).',
    '- why: at most 12 words.',
    '',
    'Posts may mix English and Malay. "berapa harga", "nak pasang", "berbaloi tak" are',
    'buying signals. A company advertising its own service is a seller, not a lead.',
    '',
    'Reply with ONLY a JSON array, one object per item, using the ids given:',
    '[{"id":"...","interested":true,"intent":"buying","why":"..."}]',
    '',
    ...items.map((i) => `--- id: ${i.id}\n${i.text.slice(0, MAX_TEXT)}`),
  ].join('\n');
}

export function llmClassifier(cfg: LlmConfig): Classifier {
  const batchSize = cfg.batchSize ?? DEFAULT_BATCH;

  return {
    async classify(topic: string, items: ClassifyItem[]): Promise<Verdict[]> {
      const out: Verdict[] = [];

      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        try {
          const res = await fetch(cfg.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}),
            },
            body: JSON.stringify({
              model: cfg.model,
              temperature: 0,
              messages: [{ role: 'user', content: prompt(topic, batch) }],
            }),
          });

          if (!res.ok) {
            out.push(...batch.map((it) => keep(it, `classifier HTTP ${res.status}`)));
            continue;
          }

          const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
          const raw = data.choices?.[0]?.message?.content ?? '';
          out.push(...parseVerdicts(raw, batch));
        } catch (err) {
          out.push(...batch.map((it) => keep(it, `classifier unreachable: ${(err as Error).message}`)));
        }
      }

      return out;
    },
  };
}

/** Configured endpoint if there is one, otherwise the honest no-op. */
export function defaultClassifier(): Classifier {
  if (!FBRECON_LLM_URL || !FBRECON_LLM_MODEL) return passThroughClassifier;
  return llmClassifier({ url: FBRECON_LLM_URL, key: FBRECON_LLM_KEY, model: FBRECON_LLM_MODEL });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx --test test/fbrecon.classify.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/fb-recon/classify.ts test/fbrecon.classify.test.ts
git commit -m "feat(fb-recon): add batched intent classifier that fails open"
```

---

## Task 6: Browser-side extractors

`facebook.ts` already has a working post extractor. It captures the author's **name** (from `a[aria-label]`) but throws away that same anchor's **href**, which is the profile URL — and the profile URL is the entire contact. This task builds an fb-recon-specific extractor that keeps it, plus a comment extractor.

The extractor is a function stringified and evaluated in-page, exactly the pattern `facebook.ts` uses (`EXTRACT.toString().replaceAll('MESSAGE_SEL_PLACEHOLDER', ...)`). Follow it precisely — the placeholder dance exists because the in-page function cannot close over Node-side constants.

**Selectors here will need calibration against the live site.** They are collected into named constants at the top of the file so that fixing them is a one-line edit rather than an archaeology expedition. Task 9 includes an explicit calibration step.

**Files:**
- Create: `src/fb-recon/extract.ts`
- Create: `test/fbrecon.extract.test.ts`

**Interfaces:**
- Consumes: `MESSAGE_SEL` from `../facebook.js`.
- Produces: `export interface RawPost`, `export interface RawComment`, `export const POST_EXTRACT_SRC: string`, `export const COMMENT_EXTRACT_SRC: string`.

- [ ] **Step 1: Write the failing test**

The extractor bodies run in a browser and cannot be unit-tested here; what *can* and must be tested is that the placeholder substitution actually happened. A `MESSAGE_SEL_PLACEHOLDER` that survives into the evaluated source is a silent runtime failure that returns zero posts and looks like "no results today".

Create `test/fbrecon.extract.test.ts`:

```ts
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { POST_EXTRACT_SRC, COMMENT_EXTRACT_SRC } from '../src/fb-recon/extract.js';

test('post extractor source has no unsubstituted placeholders', () => {
  assert.ok(!POST_EXTRACT_SRC.includes('PLACEHOLDER'), 'placeholder leaked into evaluated source');
});

test('post extractor source embeds the real message selector', () => {
  assert.ok(POST_EXTRACT_SRC.includes('data-ad-preview'), 'MESSAGE_SEL was not injected');
});

test('post extractor is a self-contained function expression', () => {
  assert.ok(/^\s*\(?\s*(function|\()/.test(POST_EXTRACT_SRC) || POST_EXTRACT_SRC.trimStart().startsWith('()'),
    `not an evaluable function expression: ${POST_EXTRACT_SRC.slice(0, 40)}`);
});

test('comment extractor source has no unsubstituted placeholders', () => {
  assert.ok(!COMMENT_EXTRACT_SRC.includes('PLACEHOLDER'));
});

test('neither extractor contains a mutating DOM call', () => {
  for (const src of [POST_EXTRACT_SRC, COMMENT_EXTRACT_SRC]) {
    for (const forbidden of ['.click(', '.submit(', 'innerHTML =', '.remove(']) {
      assert.ok(!src.includes(forbidden), `extractor must not mutate the page: found ${forbidden}`);
    }
  }
});

test('the post root is found by ARIA, never by innerText action words', () => {
  // The innerText rule matched nothing on the live DOM and returned zero posts.
  assert.ok(!/\\b\(Comment\|Like\|Share\)\\b/.test(POST_EXTRACT_SRC),
    'the dead innerText action regex must not come back');
  assert.ok(POST_EXTRACT_SRC.includes('omment'),
    'expected the action bar to be matched by aria-label');
});

test('the author anchor is chosen by href shape, not document order', () => {
  // The first a[aria-label] in a post is sometimes the "Hide post by X" control.
  assert.ok(!/querySelector\('a\[aria-label\]'\)[^;]*authorLink/.test(POST_EXTRACT_SRC),
    'author must not be the first aria-labelled anchor');
  assert.ok(POST_EXTRACT_SRC.includes('/user/'),
    'expected the group-scoped member link to be preferred when present');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/fbrecon.extract.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/fb-recon/extract.ts`**

```ts
/**
 * In-page extractors.
 *
 * These functions are stringified and evaluated inside the page, so they can
 * close over nothing from Node — every constant is injected by string
 * substitution, the same pattern facebook.ts uses. If a PLACEHOLDER ever
 * survives into the evaluated source the extractor silently returns zero rows,
 * which reads as "quiet day on Facebook" rather than as the bug it is. That is
 * what the unit test guards.
 *
 * The difference from facebook.ts's extractor is small and load-bearing: that
 * one reads the author's NAME off `a[aria-label]` and discards the anchor. We
 * keep its href, because the profile URL is the whole contact.
 *
 * SELECTORS BELOW WILL DRIFT. Facebook reshapes this DOM constantly. They are
 * named constants for exactly that reason — when a sweep starts returning zero
 * comments, this is the file to fix, and it should be a one-line edit.
 */
import { ACTION_SEL, MESSAGE_SEL } from '../facebook.js';

/** Facebook renders each comment as an article labelled "Comment by <name>". */
const COMMENT_SEL = '[role="article"][aria-label*="omment" i]';

declare const MESSAGE_SEL_PLACEHOLDER: string;
declare const COMMENT_SEL_PLACEHOLDER: string;
declare const ACTION_SEL_PLACEHOLDER: string;

export interface RawPost {
  index: number;
  author: string | null;
  authorUrl: string | null;
  text: string;
  permalink: string | null;
  timestamp: string | null;
  truncated: boolean;
}

export interface RawComment {
  index: number;
  author: string | null;
  authorUrl: string | null;
  text: string;
}

const POST_EXTRACT = () => {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const permaRe = /\/(posts|permalink|videos|photo|reel|share)\/|story_fbid=|pfbid|multi_permalinks=/;

  const tidyUrl = (href: string | null): string | null => {
    if (!href) return null;
    try {
      const u = new URL(href, location.origin);
      for (const k of [...u.searchParams.keys()]) if (k.startsWith('__')) u.searchParams.delete(k);
      return u.toString();
    } catch {
      return null;
    }
  };

  /**
   * The author anchor, chosen by HREF SHAPE rather than document order.
   *
   * `root.querySelector('a[aria-label]')` returns whichever aria-labelled anchor
   * comes first, and in a real post that is sometimes a CONTROL: one measured
   * sighting harvested `aria-label="Hide post by Stephenie"` with `href="#"` as
   * the author. Preference order is most-identifying first.
   */
  const findAuthor = (root: HTMLElement): HTMLAnchorElement | null => {
    const anchors = Array.from(root.querySelectorAll('a[href]')) as HTMLAnchorElement[];
    const href = (a: HTMLAnchorElement) => a.getAttribute('href') ?? '';
    return (
      // 1. group-scoped member link — the only form group posts expose
      anchors.find((a) => /\/groups\/\d+\/user\/\d+/.test(href(a))) ??
      // 2. numeric profile
      anchors.find((a) => /profile\.php\?id=\d+/.test(href(a))) ??
      // 3. bare vanity handle at path root, nothing else in the path
      anchors.find((a) => /^(https?:\/\/(www\.)?facebook\.com)?\/[\w.-]{3,}\/?(\?|$)/.test(href(a))
        && !permaRe.test(href(a))
        && !/^\/?(groups|photo|watch|reel|stories|marketplace|events|hashtag|search)\b/.test(href(a).replace(/^https?:\/\/(www\.)?facebook\.com/, ''))) ??
      null
    );
  };

  const roots = new Map<Element, HTMLElement>();

  for (const msg of Array.from(document.querySelectorAll(MESSAGE_SEL_PLACEHOLDER))) {
    let node: HTMLElement | null = msg as HTMLElement;
    for (let i = 0; node && i < 16; i++) {
      const authored = node.querySelector('a[aria-label]');
      // ARIA, not innerText. The words "Comment" and "Share" do not appear as
      // rendered text anywhere in a post — see facebook.ts ACTION_SEL.
      const acted = node.querySelector(ACTION_SEL_PLACEHOLDER);
      const msgCount = node.querySelectorAll(MESSAGE_SEL_PLACEHOLDER).length;
      if (authored && acted && msgCount === 1) {
        if (!roots.has(msg)) roots.set(msg, node);
        break;
      }
      node = node.parentElement;
    }
  }

  return [...roots.entries()].map(([msg, root], index) => {
    const rawText = clean((msg as HTMLElement).innerText);
    const anchors = Array.from(root.querySelectorAll('a[href]')) as HTMLAnchorElement[];
    const perma = anchors.find((a) => permaRe.test(a.getAttribute('href') ?? ''));
    const authorLink = findAuthor(root);

    const dateRe = /\b(\d{1,2}\s+\w+|\w+\s+\d{1,2}|\d+\s*(m|h|d|w|hr|min)\b|yesterday|today)/i;
    const timeLabel = anchors
      .map((a) => a.getAttribute('aria-label'))
      .find((l) => l && dateRe.test(l) && !/^\s*$/.test(l));

    return {
      index,
      // Group member links carry no aria-label, so fall back to the link text —
      // without this every group contact is named after its own user id.
      author:
        clean(authorLink?.getAttribute('aria-label')) ||
        clean(authorLink?.textContent) ||
        null,
      authorUrl: tidyUrl(authorLink?.getAttribute('href') ?? null),
      text: rawText.slice(0, 4000),
      permalink: perma ? tidyUrl(perma.getAttribute('href')) : null,
      timestamp: clean(timeLabel) || null,
      truncated: rawText.length > 4000 || /\bSee more\b/i.test(rawText),
    };
  });
};

const COMMENT_EXTRACT = () => {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

  const tidyUrl = (href: string | null): string | null => {
    if (!href) return null;
    try {
      const u = new URL(href, location.origin);
      for (const k of [...u.searchParams.keys()]) if (k.startsWith('__')) u.searchParams.delete(k);
      return u.toString();
    } catch {
      return null;
    }
  };

  const nodes = Array.from(document.querySelectorAll(COMMENT_SEL_PLACEHOLDER));

  return nodes.map((node, index) => {
    const el = node as HTMLElement;
    const label = clean(el.getAttribute('aria-label'));
    // "Comment by Ali Bin Abu 2 hours ago" — the name sits between the two.
    const named = /^Comment by (.+?)(?:\s+\d|\s*$)/i.exec(label);
    const authorLink = el.querySelector('a[href*="facebook.com/"], a[href^="/"]') as HTMLAnchorElement | null;

    const body = clean(el.innerText)
      .replace(/^Comment by [^]*?ago\s*/i, '')
      .replace(/\b(Like|Reply|Share|Edited|Top fan|Author)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return {
      index,
      author: named?.[1]?.trim() || clean(authorLink?.textContent) || null,
      authorUrl: tidyUrl(authorLink?.getAttribute('href') ?? null),
      text: body.slice(0, 2000),
    };
  });
};

export const POST_EXTRACT_SRC = POST_EXTRACT.toString()
  .replaceAll('MESSAGE_SEL_PLACEHOLDER', JSON.stringify(MESSAGE_SEL))
  .replaceAll('ACTION_SEL_PLACEHOLDER', JSON.stringify(ACTION_SEL));

export const COMMENT_EXTRACT_SRC = COMMENT_EXTRACT.toString().replaceAll(
  'COMMENT_SEL_PLACEHOLDER',
  JSON.stringify(COMMENT_SEL),
);
```

> **Implementer note — resolved.** `facebook.ts` uses `declare const MESSAGE_SEL_PLACEHOLDER: string;`
> (line 17). The `declare const` block is already included above; it is erased at compile time and the
> string substitution replaces the identifiers before the source reaches the browser. No `@ts-expect-error`
> needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test test/fbrecon.extract.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/fb-recon/extract.ts test/fbrecon.extract.test.ts
git commit -m "feat(fb-recon): add post and comment extractors that keep author profile URLs"
```

---

## Task 7: The write fence

This is the module that makes "read only" structural rather than aspirational. Every click fb-recon performs goes through `safeClick()`, which matches the target's accessible name against an allowlist and throws on anything else. There is no other click path, and Task 10 asserts there is no other click path.

**Files:**
- Create: `src/fb-recon/browser.ts`
- Create: `test/fbrecon.fence.test.ts`

**Interfaces:**
- Consumes: `humanScroll`, `pause` from `../human.js`; `ReadLimiter` from `../readlimit.js` (Task 1).
- Produces: `export const CLICK_ALLOWLIST: RegExp[]`, `export function isAllowedClick(name: string): boolean`, `export async function safeClick(page: Page, name: string | RegExp, opts?): Promise<boolean>`, `export function guardPage(page: Page): void`, `export async function expandSeeMore(page: Page, rounds?: number): Promise<void>`, `export async function expandComments(page: Page, rounds?: number): Promise<void>`, `export async function scrollAndSettle(page: Page, limiter: ReadLimiter, countSelector: string): Promise<number>`.

- [ ] **Step 1: Write the failing test**

Create `test/fbrecon.fence.test.ts`:

```ts
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isAllowedClick } from '../src/fb-recon/browser.js';

test('expansion controls are allowed', () => {
  for (const name of ['See more', 'see more', 'View more comments', 'View 12 more comments',
                      'View previous comments', 'Next', 'Previous', 'See More']) {
    assert.equal(isAllowedClick(name), true, `should allow: ${name}`);
  }
});

test('every interaction control is refused', () => {
  for (const name of ['Like', 'Comment', 'Share', 'Send', 'Post', 'Reply', 'Follow',
                      'Add friend', 'Join group', 'Message', 'Write a comment',
                      'Leave a comment', 'Send message', 'Submit']) {
    assert.equal(isAllowedClick(name), false, `MUST refuse: ${name}`);
  }
});

test('an interaction control is refused even when it contains an allowed word', () => {
  // "Comment" contains no allowed token, but "See more comments to reply" would
  // sneak past a naive substring rule. The allowlist must be anchored.
  assert.equal(isAllowedClick('Reply to see more'), false);
  assert.equal(isAllowedClick('Comment to view more comments'), false);
});

test('empty and whitespace names are refused', () => {
  assert.equal(isAllowedClick(''), false);
  assert.equal(isAllowedClick('   '), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/fbrecon.fence.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/fb-recon/browser.ts`**

```ts
/**
 * The write fence.
 *
 * fb-recon is read-only, and "read-only" enforced by careful coding is a
 * promise, not a property. This module makes it a property: it is the ONLY
 * place in fb-recon that may click, and it refuses anything not on an
 * allowlist. An allowlist rather than a denylist, for the same reason the recon
 * design uses one — a denylist is a list of the ways you have already been
 * surprised.
 *
 * The practical consequence: fb-recon physically cannot Like, Follow, Join,
 * Reply, or open a comment composer, because none of those words are on the
 * list and there is no second code path.
 */
import type { Page } from 'patchright';
import { humanScroll, pause } from '../human.js';
import type { ReadLimiter } from '../readlimit.js';

/**
 * Anchored on purpose. A substring rule would let "Reply to see more" through
 * on the strength of the words "see more" sitting inside it.
 */
export const CLICK_ALLOWLIST: RegExp[] = [
  /^see more$/i,
  /^see more comments$/i,
  /^view \d* ?more comments?$/i,
  /^view previous comments?$/i,
  /^view all \d+ comments?$/i,
  /^load more comments?$/i,
  /^next$/i,
  /^previous$/i,
  /^page \d+$/i,
];

export function isAllowedClick(name: string): boolean {
  const n = (name ?? '').trim();
  if (!n) return false;
  return CLICK_ALLOWLIST.some((re) => re.test(n));
}

/**
 * The single click chokepoint. Returns false when the control is simply not on
 * the page (a normal, expected outcome) and THROWS when the control exists but
 * is not allowed — that is a programming error and must be loud.
 */
export async function safeClick(
  page: Page,
  name: string,
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  if (!isAllowedClick(name)) {
    throw new Error(
      `fb-recon refused to click ${JSON.stringify(name)}: not on the read-only click allowlist. ` +
        'fb-recon may only expand content, never interact with it.',
    );
  }

  const target = page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).first();
  try {
    if (!(await target.isVisible({ timeout: opts.timeoutMs ?? 1500 }))) return false;
    await target.scrollIntoViewIfNeeded();
    await pause(250, 700);
    await target.click({ delay: 60 });
    await pause(300, 900);
    return true;
  } catch {
    return false;
  }
}

/**
 * Page-level guards. Dialogs are dismissed rather than accepted, and downloads
 * are cancelled — a "Save your data" prompt accepted by accident is exactly the
 * kind of side effect a read-only tool must not have.
 */
export function guardPage(page: Page): void {
  page.on('dialog', (d) => void d.dismiss().catch(() => {}));
  page.on('download', (d) => void d.cancel().catch(() => {}));
}

export async function expandSeeMore(page: Page, rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (!(await safeClick(page, 'See more'))) return;
  }
}

export async function expandComments(page: Page, rounds = 8): Promise<void> {
  const labels = ['View more comments', 'View previous comments', 'Load more comments'];
  for (let i = 0; i < rounds; i++) {
    let clicked = false;
    for (const label of labels) {
      if (await safeClick(page, label)) {
        clicked = true;
        break;
      }
    }
    if (!clicked) return;
  }
}

/**
 * Scroll one round and report how many matching nodes exist afterwards.
 *
 * The caller compares this against the previous round's count: growth means
 * keep going, no growth twice running means the list is exhausted. This is
 * waiting on the DATA'S SHAPE (rule #14) — there is deliberately no
 * waitForTimeout used as a readiness signal anywhere in this file.
 */
export async function scrollAndSettle(page: Page, limiter: ReadLimiter, countSelector: string): Promise<number> {
  await limiter.takeScroll();
  await humanScroll(page, 2);
  return page.evaluate((sel: string) => document.querySelectorAll(sel).length, countSelector);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test test/fbrecon.fence.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/fb-recon/browser.ts test/fbrecon.fence.test.ts
git commit -m "feat(fb-recon): add read-only click allowlist and page guards"
```

---

## Task 8: Source adapters

Four sources, one shape. Only "where do I start and how do I get the next screenful" differs; extraction, gating and contact-building are shared downstream.

**Files:**
- Create: `src/fb-recon/sources.ts`
- Create: `test/fbrecon.sources.test.ts`

**Interfaces:**
- Consumes: `SourceKind` from `./store.js` (Task 4).
- Produces: `export interface SourceSpec`, `export function parseSource(raw: string): SourceSpec`, `export function sourceUrl(spec: SourceSpec, topic: string): string`, `export function sourceLabel(spec: SourceSpec): string`, `export function isSweepable(spec: SourceSpec): boolean`.

- [ ] **Step 1: Write the failing test**

Create `test/fbrecon.sources.test.ts`:

```ts
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseSource, sourceUrl, isSweepable } from '../src/fb-recon/sources.js';

test('parses a group source', () => {
  assert.deepEqual(parseSource('group:https://www.facebook.com/groups/solarmy'),
    { kind: 'group', ref: 'https://www.facebook.com/groups/solarmy' });
});

test('parses the bare feed and search shorthands', () => {
  assert.deepEqual(parseSource('feed'), { kind: 'feed', ref: '' });
  assert.deepEqual(parseSource('search'), { kind: 'search', ref: '' });
});

test('parses a thread source', () => {
  assert.deepEqual(parseSource('thread:https://www.facebook.com/permalink.php?story_fbid=1&id=2'),
    { kind: 'thread', ref: 'https://www.facebook.com/permalink.php?story_fbid=1&id=2' });
});

test('rejects an unknown source kind', () => {
  assert.throws(() => parseSource('twitter:foo'), /unknown source/i);
});

test('rejects a group source with no URL', () => {
  assert.throws(() => parseSource('group:'), /requires a url/i);
});

test('rejects a non-facebook URL', () => {
  assert.throws(() => parseSource('group:https://evil.example.com/groups/x'), /facebook\.com/i);
});

test('search URL encodes the topic', () => {
  assert.equal(sourceUrl({ kind: 'search', ref: '' }, 'solar panel'),
    'https://www.facebook.com/search/posts?q=solar%20panel');
});

test('an explicit search ref overrides the topic as the query', () => {
  assert.equal(sourceUrl({ kind: 'search', ref: 'nem tnb' }, 'solar'),
    'https://www.facebook.com/search/posts?q=nem%20tnb');
});

test('group URL is used as given', () => {
  assert.equal(sourceUrl({ kind: 'group', ref: 'https://www.facebook.com/groups/solarmy' }, 'solar'),
    'https://www.facebook.com/groups/solarmy');
});

test('feed URL is the site root', () => {
  assert.equal(sourceUrl({ kind: 'feed', ref: '' }, 'solar'), 'https://www.facebook.com/');
});

test('threads are not sweepable; every other kind is', () => {
  assert.equal(isSweepable({ kind: 'thread', ref: 'https://www.facebook.com/x' }), false);
  assert.equal(isSweepable({ kind: 'group', ref: 'https://www.facebook.com/groups/x' }), true);
  assert.equal(isSweepable({ kind: 'search', ref: '' }), true);
  assert.equal(isSweepable({ kind: 'feed', ref: '' }), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/fbrecon.sources.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/fb-recon/sources.ts`**

```ts
/**
 * Where to look. Four sources, one shape.
 *
 * They differ only in how you arrive and how the next screenful appears;
 * everything after extraction is shared. Ordered by intent quality:
 *
 *   thread — commenters under a known competitor or viral post. Highest intent,
 *            narrowest reach, and pass-2 only: there is no list to sweep.
 *   group  — where buying questions actually get asked. Requires membership.
 *   search — broadest reach, noisiest, and the most heavily gated by Facebook.
 *            Expect this one to break first.
 *   feed   — whatever Facebook decided to show you. Topic coverage is
 *            accidental; useful as a passive trickle, weak as a primary source.
 */
import type { SourceKind } from './store.js';

export interface SourceSpec {
  kind: SourceKind;
  /** Group URL, search query, or post permalink. Empty for feed. */
  ref: string;
}

const NEEDS_URL: SourceKind[] = ['group', 'thread'];

function assertFacebookUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`fb-recon source is not a valid URL: ${raw}`);
  }
  if (!/(^|\.)facebook\.com$/i.test(u.hostname)) {
    throw new Error(`fb-recon sources must be on facebook.com, got: ${u.hostname}`);
  }
}

/** CLI form: "group:<url>", "thread:<url>", "search[:<query>]", "feed". */
export function parseSource(raw: string): SourceSpec {
  const trimmed = (raw ?? '').trim();
  const idx = trimmed.indexOf(':');
  const kind = (idx === -1 ? trimmed : trimmed.slice(0, idx)).toLowerCase() as SourceKind;
  const ref = idx === -1 ? '' : trimmed.slice(idx + 1).trim();

  if (!['group', 'search', 'thread', 'feed'].includes(kind)) {
    throw new Error(`fb-recon: unknown source kind ${JSON.stringify(kind)}. Use group:<url>, search[:<query>], thread:<url>, or feed.`);
  }
  if (NEEDS_URL.includes(kind)) {
    if (!ref) throw new Error(`fb-recon: source "${kind}" requires a url, e.g. ${kind}:https://www.facebook.com/...`);
    assertFacebookUrl(ref);
  }

  return { kind, ref };
}

export function sourceUrl(spec: SourceSpec, topic: string): string {
  switch (spec.kind) {
    case 'group':
    case 'thread':
      return spec.ref;
    case 'search':
      return `https://www.facebook.com/search/posts?q=${encodeURIComponent(spec.ref || topic)}`;
    case 'feed':
      return 'https://www.facebook.com/';
  }
}

export function sourceLabel(spec: SourceSpec): string {
  return spec.ref ? `${spec.kind}:${spec.ref}` : spec.kind;
}

/** A thread has no list to scroll — it goes straight to pass 2. */
export function isSweepable(spec: SourceSpec): boolean {
  return spec.kind !== 'thread';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test test/fbrecon.sources.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/fb-recon/sources.ts test/fbrecon.sources.test.ts
git commit -m "feat(fb-recon): add source specs for group, search, thread and feed"
```

---

## Task 9: The engine, and wiring it up

Pass 1 sweeps each sweepable source, extracting **per scroll round** because the timeline is virtualized. Pass 2 opens gate survivors and mines their commenters. Both passes feed one contact map.

This task also wires the four surfaces. It is one task rather than five because none of the wiring is independently useful — a service method with no route is not a reviewable deliverable.

**Files:**
- Create: `src/fb-recon/index.ts`
- Create: `src/automations/facebook/recon.ts`
- Modify: `src/service.ts`
- Modify: `src/api.ts`
- Modify: `src/mcp.ts`
- Modify: `src/cli.ts`
- Create: `test/fbrecon.engine.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: `export interface ReconOptions`, `export interface ReconSummary`, `export async function runReconSweep(page: Page, opts: ReconOptions): Promise<ReconSummary>`, `export function buildContact(...)`, and `VaultService.fbRecon(opts): Promise<ReconSummary>`.

- [ ] **Step 1: Write the failing test for the pure part of the engine**

The sweep needs a browser, but the post → contact transformation does not, and that is where the bugs live.

Create `test/fbrecon.engine.test.ts`:

```ts
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildContact } from '../src/fb-recon/index.js';

const AT = '2026-08-12T00:00:00.000Z';

test('builds a contact from a post with a vanity profile URL', () => {
  const c = buildContact({
    name: 'Ali Bin Abu',
    profileUrl: 'https://www.facebook.com/ali.bin.abu',
    text: 'Berapa harga solar? call me 012-345 6789',
    permalink: 'https://www.facebook.com/groups/x/posts/1',
    sourceKind: 'group',
    role: 'author',
    intent: 'buying',
    score: 9,
    at: AT,
  });
  assert.ok(c);
  assert.equal(c!.id, 'ali.bin.abu');
  assert.equal(c!.messenger, 'https://m.me/ali.bin.abu');
  assert.deepEqual(c!.phones, ['+60123456789']);
  assert.equal(c!.evidence.length, 1);
  assert.equal(c!.evidence[0].role, 'author');
});

test('returns null when the profile URL is not a person', () => {
  assert.equal(buildContact({
    name: 'Solar Malaysia', profileUrl: 'https://www.facebook.com/groups/123',
    text: 'hi', permalink: 'p', sourceKind: 'group', role: 'author',
    intent: 'buying', score: 9, at: AT,
  }), null);
});

test('returns null when there is no profile URL at all', () => {
  assert.equal(buildContact({
    name: 'Anon', profileUrl: null, text: 'hi', permalink: 'p',
    sourceKind: 'feed', role: 'author', intent: 'buying', score: 9, at: AT,
  }), null);
});

test('the evidence quote is trimmed but preserves the words that prove intent', () => {
  const long = 'x'.repeat(400) + ' berapa harga';
  const c = buildContact({
    name: 'A', profileUrl: 'https://www.facebook.com/aaa.bbb', text: long,
    permalink: 'p', sourceKind: 'group', role: 'commenter', intent: 'buying', score: 9, at: AT,
  });
  assert.ok(c!.evidence[0].quote.length <= 300, 'quote must be bounded');
});

test('firstSeen and lastSeen both start at the sighting time', () => {
  const c = buildContact({
    name: 'A', profileUrl: 'https://www.facebook.com/aaa.bbb', text: 'hi',
    permalink: 'p', sourceKind: 'feed', role: 'author', intent: 'none', score: 0, at: AT,
  });
  assert.equal(c!.firstSeen, AT);
  assert.equal(c!.lastSeen, AT);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/fbrecon.engine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/fb-recon/index.ts`**

```ts
/**
 * The two-pass sweep.
 *
 * Pass 1 reads each source's list inline and scores every post. No navigation,
 * so it is cheap and safe. Pass 2 opens only what cleared the gate and mines
 * the comment thread, where the highest-intent people actually are — someone
 * asking "how much for 6kW?" under a competitor's post is worth more than
 * whoever wrote the post.
 *
 * The non-obvious constraint is virtualization: Facebook destroys the DOM nodes
 * of posts you have scrolled past. Extraction therefore happens INSIDE the
 * scroll loop, once per round. Scroll-then-extract returns a confident, wrong,
 * much smaller number.
 */
import type { Page } from 'patchright';
import { expandComments, expandSeeMore, guardPage, scrollAndSettle } from './browser.js';
import { defaultClassifier, type Classifier, type ClassifyItem } from './classify.js';
import { extractContactFields, messengerLink, profileIdentity } from './contact.js';
import { COMMENT_EXTRACT_SRC, POST_EXTRACT_SRC, type RawComment, type RawPost } from './extract.js';
import { isSweepable, sourceLabel, sourceUrl, type SourceSpec } from './sources.js';
import { DEFAULT_MIN_SCORE, scoreText, type TopicPack } from './topic.js';
import { mergeContact, type ContactMap, type FbContact, type Intent, type Role, type SourceKind } from './store.js';
import type { ReadLimiter } from '../readlimit.js';
import { MESSAGE_SEL } from '../facebook.js';

export interface ReconOptions {
  topic: string;
  pack: TopicPack;
  sources: SourceSpec[];
  limiter: ReadLimiter;
  contacts: ContactMap;
  classifier?: Classifier;
  minScore?: number;
  /** Permalinks harvested by an earlier run. Makes a re-run resumable. */
  seen?: Set<string>;
}

export interface ReconSummary {
  topic: string;
  scanned: number;
  gated: number;
  opened: number;
  /**
   * Gated posts that could not be opened because they exposed no permalink.
   * Measured 2026-08-12: this was 100% of group posts. Reported rather than
   * swallowed, because "opened: 0" otherwise reads as "nothing was worth
   * opening" when the truth is "nothing COULD be opened".
   */
  skippedNoPermalink: number;
  commentsRead: number;
  newContacts: number;
  totalContacts: number;
  bySource: Record<string, number>;
  problems: string[];
  startedAt: string;
  finishedAt: string;
}

interface Candidate {
  post: RawPost;
  spec: SourceSpec;
  score: number;
}

/** Bounded so a 4,000-character post does not become a 4,000-character CSV cell. */
const QUOTE_MAX = 300;
/** Two consecutive rounds with no new posts means the list is exhausted. */
const DRY_ROUNDS = 2;

export interface ContactInput {
  name: string;
  profileUrl: string | null;
  text: string;
  permalink: string;
  sourceKind: SourceKind;
  role: Role;
  intent: Intent;
  score: number;
  at: string;
}

/** Null when the "author" is not a person — a group, a page, a photo permalink. */
export function buildContact(input: ContactInput): FbContact | null {
  const identity = profileIdentity(input.profileUrl);
  if (!identity) return null;

  const fields = extractContactFields(input.text);

  return {
    id: identity.id,
    name: input.name || identity.id,
    profileUrl: input.profileUrl!,
    messenger: messengerLink(identity),
    phones: fields.phones,
    waLinks: fields.waLinks,
    emails: fields.emails,
    evidence: [{
      permalink: input.permalink,
      quote: input.text.slice(0, QUOTE_MAX),
      sourceKind: input.sourceKind,
      role: input.role,
      at: input.at,
    }],
    intent: input.intent,
    score: input.score,
    firstSeen: input.at,
    lastSeen: input.at,
  };
}

async function sweepSource(
  page: Page,
  spec: SourceSpec,
  opts: ReconOptions,
  seen: Set<string>,
  problems: string[],
): Promise<Candidate[]> {
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const url = sourceUrl(spec, opts.topic);
  const found: Candidate[] = [];

  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 45_000 });
    await page.waitForSelector(MESSAGE_SEL, { timeout: 30_000 });
  } catch (err) {
    problems.push(`${sourceLabel(spec)}: could not load — ${(err as Error).message}`);
    return found;
  }

  let dry = 0;
  while (dry < DRY_ROUNDS) {
    // Extract INSIDE the loop: the timeline is virtualized and scrolling past a
    // post destroys its DOM node.
    await expandSeeMore(page);
    let batch: RawPost[] = [];
    try {
      batch = (await page.evaluate(`(${POST_EXTRACT_SRC})()`)) as RawPost[];
    } catch (err) {
      problems.push(`${sourceLabel(spec)}: extractor failed — ${(err as Error).message}`);
      break;
    }

    let fresh = 0;
    let budgetExhausted = false;
    for (const post of batch) {
      const key = post.permalink ?? `${post.author}::${post.text.slice(0, 120)}`;
      if (!key.trim() || seen.has(key)) continue;
      seen.add(key);
      fresh++;

      if (!opts.limiter.takePost()) {
        problems.push(`${sourceLabel(spec)}: stopped at the per-run post cap`);
        budgetExhausted = true;
        break;
      }

      const { score } = scoreText(opts.pack, post.text);
      if (score >= minScore) found.push({ post, spec, score });
    }

    if (budgetExhausted) break;
    dry = fresh === 0 ? dry + 1 : 0;

    try {
      await scrollAndSettle(page, opts.limiter, MESSAGE_SEL);
    } catch (err) {
      problems.push(`${sourceLabel(spec)}: scroll failed — ${(err as Error).message}`);
      break;
    }
  }

  return found;
}

export async function runReconSweep(page: Page, opts: ReconOptions): Promise<ReconSummary> {
  const startedAt = new Date().toISOString();
  const classifier = opts.classifier ?? defaultClassifier();
  const seen = opts.seen ?? new Set<string>();
  const problems: string[] = [];
  const bySource: Record<string, number> = {};

  guardPage(page);

  // ---- Pass 1: sweep every sweepable source, gate inline.
  let scanned = 0;
  const candidates: Candidate[] = [];
  for (const spec of opts.sources.filter(isSweepable)) {
    const before = seen.size;
    const hits = await sweepSource(page, spec, opts, seen, problems);
    scanned += seen.size - before;
    bySource[sourceLabel(spec)] = hits.length;
    candidates.push(...hits);
  }

  // ---- Classify the survivors in one batched pass.
  const items: ClassifyItem[] = candidates.map((c, i) => ({ id: String(i), text: c.post.text }));
  const verdicts = await classifier.classify(opts.topic, items);
  const verdictById = new Map(verdicts.map((v) => [v.id, v]));

  const interested = candidates
    .map((c, i) => ({ c, v: verdictById.get(String(i)) }))
    .filter((x) => x.v?.interested && x.v.intent !== 'seller');

  // ---- Build contacts for the post authors themselves.
  let newContacts = 0;
  const at = new Date().toISOString();
  for (const { c, v } of interested) {
    const contact = buildContact({
      name: c.post.author ?? '',
      profileUrl: c.post.authorUrl,
      text: c.post.text,
      permalink: c.post.permalink ?? sourceUrl(c.spec, opts.topic),
      sourceKind: c.spec.kind,
      role: 'author',
      intent: v!.intent,
      score: c.score,
      at,
    });
    if (contact && mergeContact(opts.contacts, contact)) newContacts++;
  }

  // ---- Pass 2: open gate survivors plus any explicit threads, mine commenters.
  //
  // Group posts routinely expose NO permalink — measured 2026-08-12, zero of 14
  // did — so for a group-only run this pass legitimately has nothing to open.
  // That is reported, not hidden: a silent `opened: 0` is indistinguishable from
  // "nothing cleared the gate", and the two call for opposite fixes.
  const skippedNoPermalink = interested.filter((x) => !x.c.post.permalink).length;
  if (skippedNoPermalink > 0) {
    problems.push(
      `${skippedNoPermalink} gated post(s) exposed no permalink, so their comment threads could not ` +
        'be opened. This is normal for group sources — see docs/fb-recon-feasibility-probe.md finding 4.',
    );
  }

  const threads = opts.sources.filter((s) => !isSweepable(s)).map((s) => s.ref);
  const openTargets = [
    ...threads.map((ref) => ({ url: ref, kind: 'thread' as SourceKind })),
    ...interested
      .filter((x) => x.c.post.permalink)
      .sort((a, b) => b.c.score - a.c.score)
      .map((x) => ({ url: x.c.post.permalink!, kind: x.c.spec.kind })),
  ];

  let opened = 0;
  let commentsRead = 0;
  for (const target of openTargets) {
    try {
      await opts.limiter.takePageOpen();
    } catch (err) {
      problems.push((err as Error).message);
      break;
    }

    let comments: RawComment[] = [];
    try {
      await page.goto(target.url, { waitUntil: 'commit', timeout: 45_000 });
      await expandComments(page);
      comments = (await page.evaluate(`(${COMMENT_EXTRACT_SRC})()`)) as RawComment[];
    } catch (err) {
      problems.push(`${target.url}: comment pass failed — ${(err as Error).message}`);
      continue;
    }
    opened++;
    commentsRead += comments.length;

    const gated = comments.filter((cm) => scoreText(opts.pack, cm.text).score >= (opts.minScore ?? DEFAULT_MIN_SCORE));
    const cItems: ClassifyItem[] = gated.map((cm, i) => ({ id: String(i), text: cm.text }));
    const cVerdicts = await classifier.classify(opts.topic, cItems);
    const cById = new Map(cVerdicts.map((v) => [v.id, v]));

    for (let i = 0; i < gated.length; i++) {
      const v = cById.get(String(i));
      if (!v?.interested || v.intent === 'seller') continue;
      const contact = buildContact({
        name: gated[i].author ?? '',
        profileUrl: gated[i].authorUrl,
        text: gated[i].text,
        permalink: target.url,
        sourceKind: target.kind,
        role: 'commenter',
        intent: v.intent,
        score: scoreText(opts.pack, gated[i].text).score,
        at,
      });
      if (contact && mergeContact(opts.contacts, contact)) newContacts++;
    }
  }

  return {
    topic: opts.topic,
    scanned,
    gated: candidates.length,
    opened,
    skippedNoPermalink,
    commentsRead,
    newContacts,
    totalContacts: opts.contacts.size,
    bySource,
    problems,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test test/fbrecon.engine.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add the service method**

Open `src/service.ts` and read `fbReadFeed` first. It establishes the exact pattern for acquiring a ready session and running against the shared browser — **mirror its body precisely**, changing only the work done with the page. Add alongside it:

```ts
  /**
   * fb-recon: topic-driven, read-only prospecting.
   *
   * State lives under <home>/fb-recon/ so a re-run resumes rather than
   * re-harvesting: seen.json holds permalinks already scored, read-history.json
   * holds the hourly page-open budget, contacts.json holds the harvest.
   */
  async fbRecon(opts: {
    topic: string;
    sources?: string[];
    minScore?: number;
    limits?: Partial<ReadLimits>;
  }): Promise<ReconSummary> {
    const dir = path.join(this.vault.home, 'fb-recon');
    const packDir = path.join(dir, 'topics');
    const contactsFile = path.join(dir, 'contacts.json');
    const seenFile = path.join(dir, 'seen.json');

    // The pack is generated once and hand-edited forever. A scan never
    // overwrites it — the human's tuning is the most valuable thing in it.
    let pack = loadPack(packDir, opts.topic);
    if (!pack) {
      pack = starterPack(opts.topic);
      savePack(packDir, pack);
    }

    // `feed` is the fallback, NOT a recommendation. Measured on a real account:
    // 16 posts, zero buying questions, and several business Pages that pass as
    // "people". Groups are where the leads are, so a source-less run says so in
    // its own output rather than returning an honest-looking empty harvest.
    const usedDefault = !opts.sources?.length;
    const specs = (usedDefault ? ['feed'] : opts.sources!).map(parseSource);
    const contacts = loadContacts(contactsFile);
    const limiter = new ReadLimiter(path.join(dir, 'read-history.json'), opts.limits ?? {});

    let seen = new Set<string>();
    try {
      seen = new Set(JSON.parse(fs.readFileSync(seenFile, 'utf8')) as string[]);
    } catch {
      // First run, or an unreadable file. Re-scoring a post is cheap; refusing
      // to run because a cache is corrupt is not.
    }

    await this.requireReady('www.facebook.com');

    const summary = await this.browser.run(async (page) =>
      runReconSweep(page, { topic: opts.topic, pack: pack!, sources: specs, limiter, contacts, seen, minScore: opts.minScore }),
    );

    if (usedDefault) {
      summary.problems.unshift(
        'No sources given, so this run swept the home feed only. On a real account the feed carries ' +
          'almost no buying questions — pass group:<url> for the groups you have joined.',
      );
    }

    saveContacts(contactsFile, contacts);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(seenFile, JSON.stringify([...seen].slice(-20_000)));
    fs.writeFileSync(path.join(dir, 'contacts.csv'), toCsv(contacts));

    return summary;
  }
```

Add the imports this needs at the top of `src/service.ts`:

```ts
import { ReadLimiter, type ReadLimits } from './readlimit.js';
import { runReconSweep, type ReconSummary } from './fb-recon/index.js';
import { loadPack, savePack, starterPack } from './fb-recon/topic.js';
import { parseSource } from './fb-recon/sources.js';
import { loadContacts, saveContacts, toCsv } from './fb-recon/store.js';
```

> **Implementer note:** `this.browser.run(...)` is the assumed accessor for the serialized browser queue and `this.requireReady('www.facebook.com')` for the session gate. Both are inferred from how `fbReadFeed` is described. **Read `fbReadFeed`'s actual body and copy its exact calls** — if it uses a different method name or a different host string, use that instead. Do not guess.

- [ ] **Step 6: Add the HTTP route**

In `src/api.ts`, alongside the other `/api/fb/` entries:

```ts
    ['POST', /^\/api\/fb\/recon$/, async (b) => svc.fbRecon({
      topic: str(b.topic),
      sources: Array.isArray(b.sources) ? (b.sources as string[]) : undefined,
      minScore: typeof b.minScore === 'number' ? b.minScore : undefined,
    })],
```

- [ ] **Step 7: Add the registry card**

Create `src/automations/facebook/recon.ts`:

```ts
// src/automations/facebook/recon.ts

/**---
id:       facebook_recon
domain:   facebook
use_when: the user wants to find people on Facebook who are interested in a topic, and collect their contact details for later outreach
effect:   read
needs:    [session:facebook.com]
---*/

import type { VaultService } from '../../service.js';
import type { ReconSummary } from '../../fb-recon/index.js';

export const run = (
  svc: VaultService,
  { topic, sources, minScore }: { topic: string; sources?: string[]; minScore?: number },
): Promise<ReconSummary> => svc.fbRecon({ topic, sources, minScore });
```

- [ ] **Step 8: Add the MCP tool**

In `src/mcp.ts`, following the exact shape of the existing `facebook_read_feed` registration:

```ts
  server.registerTool(
    'facebook_recon',
    {
      title: 'Find people interested in a topic on Facebook',
      description:
        'READ ONLY. Sweeps Facebook for people who appear interested in a topic and returns a summary of ' +
        'the harvest. Scores every post against a per-topic keyword pack, then opens only the promising ' +
        'ones to collect commenters. Collects name, profile URL, Messenger link, and any phone or email ' +
        'the person published themselves, with the quote that shows their interest. Never replies, ' +
        'comments, likes or messages anyone. Sources: "feed", "search" or "search:<query>", ' +
        '"group:<url>", "thread:<url>". Contacts persist across runs at <home>/fb-recon/contacts.json ' +
        'and contacts.csv.',
      inputSchema: {
        topic: z.string().describe('The subject to prospect for, e.g. "solar".'),
        sources: z
          .array(z.string())
          .optional()
          .describe('Where to look. Defaults to ["feed"]. e.g. ["group:https://www.facebook.com/groups/xyz", "search"].'),
        minScore: z.number().int().optional().describe('Gate threshold. Lower finds more and noisier. Defaults to 3.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ topic, sources, minScore }) => call('POST', '/api/fb/recon', { topic, sources, minScore })),
  );
```

- [ ] **Step 9: Add the CLI command**

In `src/cli.ts`, add a case to the command switch, following the style of the neighbouring cases:

```ts
      case 'fb-recon': return cmdFbRecon();
```

And the command implementation, following the style of `cmdRecon`:

```ts
/** eter-browser fb-recon --topic solar [--source group:<url>] [--source search] [--min-score 3] [--json] */
async function cmdFbRecon(): Promise<void> {
  const argv = process.argv.slice(3);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const sources = argv.reduce<string[]>((acc, a, i) => (a === '--source' && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);

  const topic = flag('topic');
  if (!topic) {
    console.error('  Usage: eter-browser fb-recon --topic <topic> [--source group:<url>] [--source search] [--min-score 3] [--json]');
    process.exit(1);
  }

  const minScoreRaw = flag('min-score');
  const res = await fetch(`${DAEMON_URL}/api/fb/recon`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic, sources, minScore: minScoreRaw ? Number(minScoreRaw) : undefined }),
  });
  const data = await res.json();

  if (argv.includes('--json')) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const s = data as ReconSummary;
  console.log(`  topic:      ${s.topic}`);
  console.log(`  scanned:    ${s.scanned} posts`);
  console.log(`  gated:      ${s.gated} passed the keyword gate`);
  console.log(`  opened:     ${s.opened} posts, ${s.commentsRead} comments read`);
  console.log(`  contacts:   ${s.newContacts} new, ${s.totalContacts} total`);
  for (const [src, n] of Object.entries(s.bySource)) console.log(`    ${src}: ${n}`);
  for (const p of s.problems) console.log(`  ! ${p}`);
}
```

- [ ] **Step 10: Build and typecheck**

Run: `npm run build`
Expected: compiles clean. Fix any type errors before continuing — in particular, confirm the `service.ts` additions match the real `fbReadFeed` pattern.

- [ ] **Step 11: Run the whole suite**

Run: `npm test`
Expected: all fb-recon tests pass; `recon.settle.test.ts` unchanged from its Task 1 baseline.

- [ ] **Step 12: Calibrate against the live site**

This is the step that cannot be skipped and cannot be faked. The selectors in `extract.ts` are a starting guess at a DOM that changes often.

1. Start the daemon: `npm run ui`. Confirm the `facebook.com` session shows `ready` on the dashboard. If not, sign in through the dashboard first — fb-recon never handles login.
2. Run against **a group you have actually joined**, not the feed. The feed is calibration-useless: it
   produced zero leads in the probe.

```bash
node dist/cli.js fb-recon --topic "e-invoice" --source group:https://www.facebook.com/groups/<slug> --min-score 1 --json
```

3. Read the output against reality:
   - `scanned` is 0 → Task 0's fix did not land, or `MESSAGE_SEL` no longer matches. Check `ACTION_SEL` first.
   - `scanned` is healthy but `gated` is 0 → nothing cleared the gate. Lower `--min-score`, or edit the topic pack.
   - `gated` is healthy but `newContacts` is 0 → `profileIdentity()` is rejecting the author URLs.
     Print a few `authorUrl` values; if they look like `/groups/<gid>/user/<uid>/`, the group-scoped
     clause from Task 3 is missing.
   - `opened` is 0 and `skippedNoPermalink` is high → **expected for groups.** This is finding 4, not a
     bug in your code. See step 4.
   - `opened` is healthy but `commentsRead` is 0 → `COMMENT_SEL` is wrong. This selector has **never been
     validated against a live comment thread** — assume it is wrong until you see a non-zero count.
   - Contacts named after their own numeric id → the author-name fallback in `extract.ts` is not reaching
     the anchor text.

4. **Answer the open question this plan cannot:** can a group post's permalink be obtained at all?
   Open a group post in a normal browser and inspect the timestamp anchor. If a permalink is reachable,
   add it to `permaRe` and pass 2 works everywhere. If it is not, say so in writing and accept that
   **pass 2 is feed- and thread-only** — then the plan's "commenters are the highest-intent source"
   claim needs downgrading to "where permalinks exist".

5. Open `<home>/fb-recon/contacts.csv` and read ten rows. Every row should be a real person you could
   plausibly message. Watch specifically for **business Pages** (`facebook.com/<brand-handle>`) — they
   satisfy `profileIdentity()` but are not leads. If they appear, the fix is a Page filter, not a topic-pack edit.
6. Record what you changed and why in a short `## Calibration` section appended to this plan file.

Per `docs/stupid-method-to-avoid.md` #5 — probe the claim, do not assert it. Do not tick this step on the strength of the code looking correct.

- [ ] **Step 13: Commit**

```bash
git add src/fb-recon/index.ts src/automations/facebook/recon.ts src/service.ts src/api.ts src/mcp.ts src/cli.ts test/fbrecon.engine.test.ts fb-recon-buildplan.md
git commit -m "feat(fb-recon): add two-pass sweep engine and wire CLI, HTTP, MCP and registry"
```

---

## Task 10: Enforce the read-only guarantee

A guarantee nobody tests is a comment. This asserts structurally that fb-recon cannot write, in a way that fails the moment someone adds a convenient `.click()` six months from now.

**Files:**
- Create: `test/fbrecon.readonly.test.ts`

**Interfaces:**
- Consumes: the source tree at `src/fb-recon/`.
- Produces: nothing.

- [ ] **Step 1: Write the test**

Create `test/fbrecon.readonly.test.ts`:

```ts
/**
 * fb-recon is read-only. This test is what makes that a property of the code
 * rather than a claim in a comment.
 *
 * It is deliberately a source-text assertion. A behavioural test would need a
 * live Facebook session, and the thing most likely to break this guarantee is
 * not a bug — it is a future edit that adds one convenient click.
 *
 * Note on what is NOT asserted: "zero POST requests to facebook.com" is not
 * achievable. Facebook's own client fires POST /api/graphql/ continuously in
 * response to plain scrolling, so that assertion would fail on a purely passive
 * run. What is asserted instead is stronger where it counts — the module
 * contains no code capable of composing or submitting anything.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(import.meta.dirname, '..', 'src', 'fb-recon');

function sources(): { file: string; text: string }[] {
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(DIR, f), 'utf8') }));
}

test('the module directory is non-empty (guards against a silently passing suite)', () => {
  assert.ok(sources().length >= 6, 'expected the fb-recon modules to exist');
});

test('no text input or form submission API appears anywhere in fb-recon', () => {
  const forbidden = ['.fill(', '.type(', '.press(', 'pressSequentially', 'humanType', 'humanClick', 'commentOnPost', '.setInputFiles(', '.selectOption(', '.check('];
  for (const { file, text } of sources()) {
    for (const f of forbidden) {
      assert.ok(!text.includes(f), `${file} contains forbidden write API: ${f}`);
    }
  }
});

test('browser.ts is the only file that clicks', () => {
  for (const { file, text } of sources()) {
    if (file === 'browser.ts') continue;
    assert.ok(!text.includes('.click('), `${file} clicks directly; all clicks must go through safeClick() in browser.ts`);
  }
});

test('the extractors never mutate the page', () => {
  const text = fs.readFileSync(path.join(DIR, 'extract.ts'), 'utf8');
  for (const f of ['innerHTML =', '.remove()', '.submit(', 'document.write']) {
    assert.ok(!text.includes(f), `extract.ts mutates the page: ${f}`);
  }
});

test('the automation card declares effect: read', () => {
  const card = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'automations', 'facebook', 'recon.ts'),
    'utf8',
  );
  assert.match(card, /effect:\s*read/, 'the registry card must declare effect: read');
});

test('no absolute personal path or API key is baked into the module', () => {
  for (const { file, text } of sources()) {
    assert.ok(!/[A-Z]:\\Users\\/i.test(text), `${file} hardcodes an absolute Windows user path`);
    assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(text), `${file} appears to contain an API key`);
  }
});
```

- [ ] **Step 2: Run the test**

Run: `npx tsx --test test/fbrecon.readonly.test.ts`
Expected: PASS, 6 tests. **If any fail, fix the source, never the test.**

- [ ] **Step 3: Run the whole suite one final time**

Run: `npm test`
Expected: everything green.

- [ ] **Step 4: Commit**

```bash
git add test/fbrecon.readonly.test.ts
git commit -m "test(fb-recon): assert the read-only guarantee structurally"
```

---

## Known risks

These are real and cannot be designed away. They are listed so nobody mistakes them for implementation mistakes.

1. ~~**Facebook's post-search tab is heavily gated.**~~ **Measured: it is not.** `/search/posts?q=solar`
   loaded normally, no redirect, no block. It is simply *thin* — 1 post over 3 scroll rounds, and that
   post's author anchor pointed at the group it lived in rather than a person. Low value, not zero. Keep
   the drop-rather-than-escalate rule anyway.
2. **Group sources need existing membership, and that is the feature's ceiling.** fb-recon never joins
   anything; joining is a write. The probe account had joined **3** groups, none matching a plausible
   sales topic. A user expecting "topic in, leads out" will get an empty harvest and blame the code.
   Set this expectation in the MCP tool description.
3. **`COMMENT_SEL` is the most fragile line in the codebase, and it is still completely unvalidated.**
   The probe never reached a comment thread, because no group post exposed a permalink to open. Treat a
   non-zero `commentsRead` as the first evidence it works at all.
4. **Group posts may have no permalink, which disables pass 2 for them entirely.** Measured 0 of 14.
   Unresolved — Task 9 Step 12.4 is where it gets answered. Until then, assume commenter mining works
   only on feed and explicit `thread:` sources.
5. **Business Pages pass as people.** `facebook.com/AIemployeeblueprint` satisfies `profileIdentity()`
   perfectly, and it is an advertiser, not a lead. There is no cheap structural test that separates a
   Page handle from a person handle; the classifier's `seller` intent is the intended defence, so a run
   with no classifier configured will carry Page noise.
6. **The virtualized timeline is the classic trap.** Confirmed live: DOM held 1–5 post nodes while the
   cumulative unique count climbed to 16. If a sweep reports suspiciously round or small numbers, suspect
   scroll-then-extract before anything else.
7. **PDPA applies to `contacts.csv`.** The file is a list of identified people harvested for outreach.
   `.gitignore` it, and keep it out of anywhere that syncs publicly.
   → Add `fb-recon/` and `contacts.csv` to `.gitignore` as part of Task 9 Step 13. This was a stated risk
   with no step attached to it.

## Self-review notes

- Spec coverage: multi-source (Task 8) · two-pass gate-then-open (Task 9) · topic pack with BM/Manglish intent phrases (Task 2) · batched classifier (Task 5) · Messenger link + self-published contact fields (Task 3) · dedupe with evidence accumulation (Task 4) · read budget (Task 1) · read-only enforcement (Tasks 7, 10) · resumable one-shot run (Task 9). All covered.
- The "zero POSTs" acceptance test from the design discussion was deliberately replaced with the structural assertions in Task 10, for the reason documented under Global Constraints.
- Types are consistent across tasks: `Intent`, `SourceKind`, `Role`, `Evidence` and `FbContact` are defined once in `store.ts` (Task 4) and imported everywhere else.
- Two places require the implementer to read existing code rather than trust this plan: the `service.ts` browser/session accessors (Task 9 Step 5) and the placeholder-identifier compiler workaround in `facebook.ts` (Task 6 Step 3). The second is now **resolved** — `facebook.ts:17` uses `declare const`.

### Post-calibration notes (2026-08-12)

- Tasks 0, 3, 4, 6 and 9 were amended against measured live-site behaviour before any code was written.
  Every amendment carries the number it moved: 0→16 posts, 0/14→14/14 identities.
- Three of the five defects failed **toward a plausible empty result** rather than toward an error. That
  is the failure mode `docs/stupid-method-to-avoid.md` is entirely about, and it is why calibration was
  moved ahead of implementation instead of sitting at the end as Task 9 Step 12.
- What survived untouched: the two-pass shape, the read budget, the write fence, the recall-tuned gate,
  the batched fail-open classifier, and extract-per-scroll-round. The damage was confined to the
  extraction and identity layer.
- What is still unknown: comment extraction (no evidence at all) and group-post permalinks. Neither
  should be written up as working until a number says so.
