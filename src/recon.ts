/**
 * RECON-AGENT — settle detection.
 *
 * Spec: docs/superpowers/specs/2026-08-12-recon-agent-design.md §6.1
 *
 * The problem this solves: on these apps a page passes through states that LOOK
 * like data and are not. `table tbody tr` matches skeleton rows and yields a
 * confident RM 0.00; "Showing 0 results" is the loading state, not an empty
 * table. Both are invisible in a single snapshot.
 *
 * So we watch the page change. A MutationObserver installed the moment
 * navigation commits drives a 100ms digest loop; the page keeps its own log and
 * we read it out once. The analyzer below is a PURE function over that log — it
 * needs no browser, which is what makes the trap rules testable.
 */
import type { Page } from 'patchright';

// ---------------------------------------------------------------- blocklist

/**
 * Spec §2. Recon is for authenticated business SaaS — cloud ERP, admin panels,
 * back-office dashboards. It is not a tool for getting into places that do not
 * want it, and it is structurally wrong on single-client sites (WhatsApp Web
 * permits one active web client, so a crawler seizes the session).
 *
 * Not overridable by flag, by design.
 */
const BLOCKED_DOMAINS = [
  'whatsapp.com',
  'messenger.com',
  'facebook.com',
  'instagram.com',
  'threads.net',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'tiktok.com',
  'youtube.com',
  'reddit.com',
  'google.com',
];

export function isBlocked(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  return BLOCKED_DOMAINS.find((d) => host === d || host.endsWith(`.${d}`)) ?? null;
}

export function assertReconAllowed(hostname: string): void {
  const hit = isBlocked(hostname);
  if (hit) {
    throw new Error(
      `recon is blocked on ${hit}. Social, messaging and bot-detection-heavy sites are out of scope — ` +
        `recon targets authenticated business SaaS (ERP, admin panels). This is not overridable.`,
    );
  }
}

/** Page-one abort: a challenge page means stop, not retry. */
export function detectChallenge(url: string, title: string, bodyText: string): string | null {
  const t = `${title} ${bodyText}`.toLowerCase();
  if (/just a moment|checking your browser|cf-browser-verification|attention required/.test(t)) return 'cloudflare';
  if (/\bcaptcha\b|recaptcha|hcaptcha|are you a robot/.test(t)) return 'captcha';
  if (/\/challenge|\/checkpoint|\/_sec\//.test(url.toLowerCase())) return 'challenge-redirect';
  return null;
}

// ---------------------------------------------------------------- probe set

/**
 * Role- and structure-based, never CSS classes: classes on every site here are
 * obfuscated per build (INDEX.md). The one class heuristic is the skeleton
 * probe, which is allowed because a probe only has to notice that something
 * changed during THIS scan — it never becomes an emitted selector.
 */
export const PROBES: Record<string, string> = {
  'table tbody tr': 'table tbody tr',
  '[role=row]': '[role="row"]',
  '[role=grid] [role=row]': '[role="grid"] [role="row"]',
  '[role=listitem]': '[role="listitem"]',
  '[aria-busy=true]': '[aria-busy="true"]',
  'skeleton-class': '[class*="skeleton" i]',
};

/** A count observed before this is "early" — a candidate lie. */
const EARLY_MS = 1000;
const BUCKET_MS = 100;
const DEFAULT_WINDOW_MS = 8000;
/** Stop watching after this long with no change. Generous on purpose — see captureSettle. */
const DEFAULT_QUIET_MS = 2000;

// ---------------------------------------------------------------- shapes

export interface SettleBucket {
  /** ms since navigation start. */
  t: number;
  counts: Record<string, number>;
  /**
   * Cells of the first data row, joined with ' | ' and MASKED — digits are 9,
   * letters are x, currency codes survive. Never real content: these are
   * customer records and the scan file lands in a repo. Empty when there is no
   * table, or when the mask guard rejected the sample.
   */
  firstRow: string;
  /** Loading-ish phrases present in the document right now, lowercased. */
  texts: string[];
  /** MutationObserver records since the previous bucket. */
  mutations: number;
}

export interface SettleTrace {
  url: string;
  title: string;
  /** 'failed' means the observer never installed — the trace is empty, not clean. */
  mode: 'observer' | 'failed';
  /**
   * ms after navigation start that the observer was installed. Anything the
   * page did before this is invisible, so the verdict says so rather than
   * implying full coverage.
   */
  installedAt: number | null;
  windowMs: number;
  /**
   * 'quiet' — the page stopped changing and we stopped watching early.
   * 'cap'   — it was still changing when the window ran out, so the settled
   *           state may be later than recorded. Materially different, so the
   *           brief must be able to tell them apart.
   */
  exitReason: 'quiet' | 'cap';
  buckets: SettleBucket[];
}

export interface UnstableProbe {
  probe: string;
  earlyCount: number;
  earlyAt: number;
  finalCount: number;
  finalAt: number;
}

export interface LoadingTextFinding {
  text: string;
  seenAt: number;
  goneAt: number;
}

export interface WaitRecommendation {
  kind: 'row-text';
  /** A JS regex source string, e.g. "RM\\s?[\\d,]". */
  pattern: string;
  /** The settled row this was derived from. */
  sample: string;
}

export interface SettleVerdict {
  settledAt: number | null;
  waitOn: WaitRecommendation | null;
  unstable: UnstableProbe[];
  loadingTexts: LoadingTextFinding[];
  notes: string[];
}

// ---------------------------------------------------------------- in-page

/**
 * Installed via evaluate() immediately after navigation commits.
 *
 * NOT via addInitScript: patchright is a stealth fork and silently drops init
 * scripts (verified — they never run and nothing throws), because
 * Page.addScriptToEvaluateOnNewDocument is a known automation fingerprint. We
 * will not reach for the CDP call to get around that; the whole value of this
 * stack is a browser that does not look automated.
 *
 * The cost is a small blind window between navigation start and install, which
 * is measured and reported rather than assumed away.
 *
 * Everything is aggregated IN PAGE: a MutationObserver on a busy ERP grid emits
 * tens of thousands of records, so we keep counts and 100ms buckets, never raw
 * records. Uses textContent, not innerText, throughout — innerText forces
 * layout, and reflowing 80 times would perturb the timing we are measuring.
 *
 * All timestamps are ms since navigation start (performance.now()'s origin).
 */
function inPageProbe(cfg: { probes: Record<string, string>; bucketMs: number; windowMs: number }): number {
  const { probes, bucketMs, windowMs } = cfg;
  const KEY = '__reconSettle';
  const w = window as unknown as Record<string, unknown>;
  if (w[KEY]) return -1;
  const installedAt = Math.round(performance.now());

  const LOADING_RE =
    /showing\s+0\s+(?:results?|records?|rows?|entries)|no\s+(?:data|records?|results?|rows?)(?:\s+(?:found|available))?|loading|please\s+wait|fetching/gi;

  /**
   * The row sample never leaves the page as real content. On an ERP these
   * cells are customer names, phone numbers and amounts, and the scan file
   * lands in a repo. The analyzer only needs SHAPE — is there money here, how
   * many cells hold real values — so digits become 9 and letters become x.
   *
   * Currency codes survive the mask because the derived wait is built from
   * them (/RM\s?[\d,]/). They are the only alphabetic content preserved, which
   * is also what lets a currency tag be told apart from a masked name.
   */
  const CURRENCY = /^(?:RM|MYR|USD|SGD|EUR|GBP|JPY|CNY|AUD|HKD|IDR|THB|INR|PHP|VND|KRW|NZD|CAD|CHF)$/;
  const maskShape = (s: string): string =>
    s.replace(/[A-Za-z]+/g, (word) => (CURRENCY.test(word.toUpperCase()) ? word.toUpperCase() : 'x'.repeat(word.length)))
      .replace(/[0-9]/g, '9');

  const buckets: SettleBucket[] = [];
  let pending = 0;
  let dirty = true;

  const digest = (): SettleBucket => {
    const counts: Record<string, number> = {};
    for (const k of Object.keys(probes)) {
      try {
        counts[k] = document.querySelectorAll(probes[k]).length;
      } catch {
        counts[k] = -1;
      }
    }

    let firstRow = '';
    try {
      const rows = Array.from(document.querySelectorAll('table tbody tr, [role="row"]'));
      // Skip a header row so the sample is real data, not column titles.
      const row = rows.find((r) => !r.querySelector('th') && !r.querySelector('[role="columnheader"]')) ?? rows[0];
      if (row) {
        const cells = Array.from(row.querySelectorAll('td, th, [role="cell"], [role="gridcell"]'));
        firstRow = maskShape(
          (cells.length
            ? cells.map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim()).join(' | ')
            : (row.textContent ?? '').replace(/\s+/g, ' ').trim()
          ).slice(0, 300),
        );
      }
    } catch {
      /* a torn-down virtualized row; leave the sample empty */
    }

    let texts: string[] = [];
    try {
      const blob = (document.body?.textContent ?? '').slice(0, 20000);
      texts = Array.from(new Set((blob.match(LOADING_RE) ?? []).map((s) => s.replace(/\s+/g, ' ').trim().toLowerCase()))).slice(0, 10);
    } catch {
      /* body not parsed yet */
    }

    const b: SettleBucket = {
      t: Math.round(performance.now()),
      counts,
      firstRow,
      texts,
      mutations: pending,
    };
    pending = 0;
    return b;
  };

  const same = (a: SettleBucket, b: SettleBucket): boolean =>
    a.firstRow === b.firstRow &&
    a.texts.length === b.texts.length &&
    a.texts.every((t, i) => t === b.texts[i]) &&
    Object.keys(probes).every((k) => a.counts[k] === b.counts[k]);

  const record = (): void => {
    const d = digest();
    const prev = buckets[buckets.length - 1];
    // Only store changes. A settled page adds nothing, so the payload stays tiny.
    if (!prev || !same(prev, d)) buckets.push(d);
    else prev.mutations += d.mutations;
  };

  try {
    const mo = new MutationObserver((recs) => {
      pending += recs.length;
      dirty = true;
    });
    mo.observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-busy', 'aria-label', 'class', 'hidden'],
    });
  } catch {
    /* fall through — the tick loop alone still gives coarse coverage */
  }

  const tick = (): void => {
    if (dirty) {
      record();
      dirty = false;
    }
    if (performance.now() - installedAt < windowMs) setTimeout(tick, bucketMs);
  };
  record();
  setTimeout(tick, bucketMs);

  w[KEY] = {
    // Lets the driver stop early once the page goes quiet, instead of sitting
    // on a settled page for the rest of the window.
    peek: (): { lastChangeAt: number; now: number } => ({
      lastChangeAt: buckets.length ? buckets[buckets.length - 1].t : installedAt,
      now: Math.round(performance.now()),
    }),
    // Forces a final digest, so the settled state is always represented.
    finish: (): { buckets: SettleBucket[]; installedAt: number } => {
      dirty = true;
      record();
      return { buckets, installedAt };
    },
  };
  return installedAt;
}

// ---------------------------------------------------------------- capture

/**
 * Navigate and watch the page settle.
 *
 * The fixed wait here is a MEASUREMENT WINDOW, not a readiness wait — the
 * banned `waitForTimeout`-as-page-ready pattern (INDEX.md) is about waiting a
 * guessed interval and then assuming the page is done. We are deliberately
 * observing for a fixed duration and reading what happened. Nothing downstream
 * assumes the page is ready when it elapses.
 */
export async function captureSettle(
  page: Page,
  url: string,
  windowMs = DEFAULT_WINDOW_MS,
  quietMs = DEFAULT_QUIET_MS,
): Promise<SettleTrace> {
  // 'commit' returns the moment navigation commits — the document exists but
  // has barely started rendering, so installing here costs only a few ms of
  // blind window. Never networkidle: these apps poll, so it never settles.
  await page.goto(url, { waitUntil: 'commit', timeout: 45_000 });

  const installedAt = await page
    .evaluate(inPageProbe, { probes: PROBES, bucketMs: BUCKET_MS, windowMs })
    .catch(() => null);

  // A MEASUREMENT WINDOW, not a readiness wait. The banned
  // waitForTimeout-as-page-ready pattern (INDEX.md) is about guessing an
  // interval and then assuming the page is done; nothing here assumes that.
  //
  // We stop early once the page has been quiet for quietMs. The threshold is
  // deliberately generous: an app that settles at 900ms and then lands a second
  // XHR at 4s would, with a short threshold, get cut off mid-load and reported
  // as a trap we had not finished seeing.
  const deadline = Date.now() + windowMs;
  let exitReason: SettleTrace['exitReason'] = 'cap';
  while (Date.now() < deadline) {
    await page.waitForTimeout(200);
    const p = await page
      .evaluate(() => {
        const w = window as unknown as { __reconSettle?: { peek(): { lastChangeAt: number; now: number } } };
        return w.__reconSettle ? w.__reconSettle.peek() : null;
      })
      .catch(() => null);
    if (p && p.now - p.lastChangeAt >= quietMs) {
      exitReason = 'quiet';
      break;
    }
  }

  const out = await page
    .evaluate(() => {
      const w = window as unknown as {
        __reconSettle?: { finish(): { buckets: unknown[]; installedAt: number } };
      };
      return w.__reconSettle ? w.__reconSettle.finish() : null;
    })
    .catch(() => null);

  const buckets = (out?.buckets ?? []) as SettleBucket[];

  // Never persist an unmasked row sample. These are customer records on an ERP
  // and the scan file lands in a repo; drop the sample rather than trust it.
  for (const b of buckets) {
    if (b.firstRow && !isMaskedShape(b.firstRow)) b.firstRow = '';
  }

  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    // An empty trace is a FAILED observer, never a clean page. Saying
    // "nothing unstable detected" when we simply were not watching is the
    // failure mode this whole feature exists to prevent.
    mode: out && buckets.length ? 'observer' : 'failed',
    installedAt: out?.installedAt ?? installedAt ?? null,
    windowMs,
    exitReason,
    buckets,
  };
}

// ---------------------------------------------------------------- analyzer

/** Currency codes the in-page mask preserves; everything else alphabetic becomes x. */
const CURRENCY_CODE =
  /^(?:RM|MYR|USD|SGD|EUR|GBP|JPY|CNY|AUD|HKD|IDR|THB|INR|PHP|VND|KRW|NZD|CAD|CHF)$/;

/**
 * Defense in depth. The page masks row samples before they cross the boundary;
 * this is the check that they actually did. A masked row may contain only runs
 * of x, digits (already normalised to 9), punctuation, and currency codes — so
 * a real name or phone number cannot pass.
 */
export function isMaskedShape(row: string): boolean {
  return (row.match(/[A-Za-z]+/g) ?? []).every((w) => /^x+$/.test(w) || CURRENCY_CODE.test(w));
}

/** Currency-tagged money, e.g. "RM 1,200.00" or "USD 43.10". */
const MONEY_TAGGED = /\b([A-Z]{2,4})\s?\d[\d,]*\.\d{2}\b/;
/** Bare money, e.g. "1,200.00". */
const MONEY_BARE = /\d[\d,]*\.\d{2}/;
/** A cell that is a placeholder rather than data. */
const PLACEHOLDER = /^(?:|-|—|–|\.\.\.|…|undefined|null|nan|n\/a|loading)$/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Derive a wait predicate from the settled row, but only accept it if it
 * DISCRIMINATES — the early row must fail the pattern the settled row passes.
 * A wait that also matches the skeleton is worse than no wait at all, because
 * it looks correct and returns garbage.
 */
function deriveWait(early: string, settled: string): WaitRecommendation | null {
  if (!settled) return null;

  const candidates: string[] = [];
  const tagged = MONEY_TAGGED.exec(settled);
  if (tagged) candidates.push(`${escapeRe(tagged[1])}\\s?[\\d,]`);
  if (MONEY_BARE.test(settled)) candidates.push(`[\\d,]+\\.\\d{2}`);
  candidates.push(`\\d{4}`);

  for (const pattern of candidates) {
    const re = new RegExp(pattern);
    if (re.test(settled) && !re.test(early)) return { kind: 'row-text', pattern, sample: settled };
  }

  // No pattern discriminates on content — fall back to cell shape, which still
  // separates "3 cells of undefined" from "6 cells of data".
  const realCells = (s: string) => s.split(' | ').filter((c) => !PLACEHOLDER.test(c.trim())).length;
  const n = realCells(settled);
  if (n > realCells(early) && n > 0) {
    return { kind: 'row-text', pattern: `(?:\\S+\\s*\\|\\s*){${Math.max(1, n - 1)},}\\S`, sample: settled };
  }
  return null;
}

/** Pure. Given what the page did, say what to wait on and what lies. */
export function analyzeSettle(trace: SettleTrace): SettleVerdict {
  const b = trace.buckets;
  const notes: string[] = [];
  if (trace.mode === 'failed' || !b.length) {
    return {
      settledAt: null,
      waitOn: null,
      unstable: [],
      loadingTexts: [],
      notes: [
        'OBSERVER FAILED — this page was not watched. This is not evidence the page is stable; it is no evidence at all.',
      ],
    };
  }
  if (trace.exitReason === 'cap') {
    notes.push(
      `Page was still changing when the ${trace.windowMs}ms window ran out — it may settle later than reported. Re-scan with a longer --window.`,
    );
  }
  if (trace.installedAt !== null && trace.installedAt > 250) {
    notes.push(
      `Observer installed ${trace.installedAt}ms after navigation start — anything the page did before that is invisible.`,
    );
  }

  const final = b[b.length - 1];
  const early = b.filter((x) => x.t < EARLY_MS);

  // 1. Probes that showed a count early and then changed: they lie at first glance.
  const unstable: UnstableProbe[] = [];
  for (const probe of Object.keys(PROBES)) {
    const firstNonZero = early.find((x) => x.counts[probe] > 0);
    if (!firstNonZero) continue;
    if (firstNonZero.counts[probe] === final.counts[probe]) continue;
    unstable.push({
      probe,
      earlyCount: firstNonZero.counts[probe],
      earlyAt: firstNonZero.t,
      finalCount: final.counts[probe],
      finalAt: final.t,
    });
  }

  // 2. Text present at some point and gone by the end: a loading state, never a value.
  const loadingTexts: LoadingTextFinding[] = [];
  for (const bucket of b) {
    for (const text of bucket.texts) {
      if (final.texts.includes(text)) continue;
      if (loadingTexts.some((f) => f.text === text)) continue;
      const goneIdx = b.findIndex((x) => x.t > bucket.t && !x.texts.includes(text));
      loadingTexts.push({ text, seenAt: bucket.t, goneAt: goneIdx === -1 ? final.t : b[goneIdx].t });
    }
  }

  // 3. What to actually wait on.
  const earliestRow = b.find((x) => x.firstRow)?.firstRow ?? '';
  const waitOn = deriveWait(earliestRow === final.firstRow ? '' : earliestRow, final.firstRow);
  if (final.firstRow && !waitOn) {
    notes.push('Could not derive a discriminating wait from the row sample — annotate this page by hand.');
  }

  return { settledAt: final.t, waitOn, unstable, loadingTexts, notes };
}

// ---------------------------------------------------------------- report

export function formatVerdict(trace: SettleTrace, v: SettleVerdict): string {
  const L: string[] = [];
  L.push(`${trace.url}`);
  L.push(`  ${trace.title}`);
  if (trace.mode === 'failed') {
    L.push('  !! OBSERVER FAILED — page not watched. Nothing below is evidence of anything.');
    for (const n of v.notes) L.push(`  note      ${n}`);
    return L.join('\n');
  }
  L.push(
    `  ${trace.buckets.length} change points · installed at ${trace.installedAt ?? '?'}ms · settled at ${v.settledAt ?? '—'}ms`,
  );
  L.push('');
  if (v.waitOn) {
    L.push(`  WAIT ON   row text matching /${v.waitOn.pattern}/`);
    L.push(`            sample: ${v.waitOn.sample.slice(0, 90)}`);
  } else {
    L.push('  WAIT ON   (none derived)');
  }
  for (const u of v.unstable) {
    L.push(`  NOT ON    ${u.probe} — ${u.earlyCount} at ${u.earlyAt}ms, ${u.finalCount} at ${u.finalAt}ms`);
  }
  for (const t of v.loadingTexts) {
    L.push(`  NOT ON    "${t.text}" — loading state, gone by ${t.goneAt}ms`);
  }
  if (!v.unstable.length && !v.loadingTexts.length) L.push('  NOT ON    (nothing unstable detected)');
  for (const n of v.notes) L.push(`  note      ${n}`);
  return L.join('\n');
}
