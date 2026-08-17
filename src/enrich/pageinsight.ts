// src/enrich/pageinsight.ts — How fast and how well-built the prospect's website is.
//
// Two sources, one shape. Google PageSpeed Insights is the authoritative one and the
// number a prospect will recognise, but it needs a free API key: the unkeyed shared
// quota is a single Google-owned project everyone on the internet shares, and it was
// already exhausted when this was measured (2026-08-17 — HTTP 429 in 560ms, before
// a single real run). So the module falls back to benchmarking the site in our own
// Chromium under the same throttle Lighthouse uses, and records WHICH source ran, so
// an estimated score is never quoted as if Google produced it.

import { createSign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserManager } from '../browser.js';
import { PKG_ROOT } from '../config.js';
import type { PageInsightCheck, PageInsightIntel, PageInsightOpportunity } from './types.js';

const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

/**
 * The ONLY OAuth scope PSI accepts. Not a guess and not a placeholder.
 *
 * The API's discovery document declares exactly one scope, `openid`, and nothing
 * else works: measured 2026-08-17, a service-account token minted for
 * `cloud-platform` — the scope everyone reaches for on a Google Cloud API — is
 * rejected with 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT, while the same account with
 * `openid` returns a full Lighthouse result. Widening this constant breaks the stage.
 */
export const PSI_SCOPE = 'openid';

/**
 * Read as FUNCTIONS, never as module-level consts — cli.ts loads .env inside its
 * body, and ESM evaluates every import first, so a const here captures an empty
 * environment. Same trap that silently disabled the fb-recon classifier.
 */
export function pageInsightApiKey(): string {
  return (process.env.PAGESPEED_API_KEY ?? process.env.GOOGLE_PSI_API_KEY ?? '').trim();
}

/** Where the Google service-account JSON key lives. Gitignored — see .gitignore. */
export function pageInsightKeyFile(): string | null {
  const explicit = (process.env.PAGESPEED_SA_KEY_FILE ?? process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '').trim();
  const candidate = explicit || path.join(PKG_ROOT, '.secrets', 'pagespeed-sa.json');
  return fs.existsSync(candidate) ? candidate : null;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
  project_id?: string;
}

/**
 * Access tokens last an hour and a deep-research campaign benchmarks many sites, so
 * one mint is reused across them. Sixty seconds of slack because the token has to
 * still be valid when PSI validates it, not merely when we send it.
 */
let tokenCache: { token: string; expiresAt: number } | null = null;

async function serviceAccountToken(): Promise<string | null> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;

  const file = pageInsightKeyFile();
  if (!file) return null;
  const sa = JSON.parse(fs.readFileSync(file, 'utf8')) as ServiceAccount;
  if (!sa.private_key || !sa.client_email) throw new Error(`${file} is not a Google service-account key`);

  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email,
    scope: PSI_SCOPE,
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  })}`;
  const assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).end().sign(sa.private_key, 'base64url')}`;

  const res = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`token mint failed (${res.status}): ${body.error_description ?? body.error ?? 'no access_token'}`);
  }
  tokenCache = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return tokenCache.token;
}

// ------------------------------------------------------------- lighthouse maths

/**
 * Lighthouse's log-normal scoring curve, so a locally measured metric maps to the
 * same 0-1 Google would give it. Verbatim from lighthouse/core/lib/statistics.js:
 * the median scores 0.5 and the p10 value scores 0.9 by construction.
 */
function logNormalScore(value: number, p10: number, median: number): number {
  if (value <= 0) return 1;
  const INVERSE_ERFC_ONE_FIFTH = 0.9061938024368232;
  const location = Math.log(median);
  const shape = Math.abs(Math.log(p10) - location) / (Math.SQRT2 * INVERSE_ERFC_ONE_FIFTH);
  const standardizedX = (Math.log(value) - location) / (Math.SQRT2 * shape);
  return Math.min(1, Math.max(0, 0.5 * erfc(standardizedX)));
}

/** Numerical Recipes 7.1.26 complementary error function, as Lighthouse ships it. */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + z / 2);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

/**
 * Lighthouse v10 mobile curves and weights. Speed Index is deliberately absent: it
 * needs a filmstrip we do not capture, so its 10% is dropped and the remaining
 * weights are renormalised. That is why the local score is reported as an estimate.
 */
const CURVES = {
  fcp: { p10: 1_800, median: 3_000, weight: 10 },
  lcp: { p10: 2_500, median: 4_000, weight: 25 },
  tbt: { p10: 200, median: 600, weight: 30 },
  cls: { p10: 0.1, median: 0.25, weight: 25 },
};

export function estimatePerformance(m: {
  fcpMs: number | null;
  lcpMs: number | null;
  tbtMs: number | null;
  clsScore: number | null;
}): number | null {
  const parts: { score: number; weight: number }[] = [];
  if (m.fcpMs != null) parts.push({ score: logNormalScore(m.fcpMs, CURVES.fcp.p10, CURVES.fcp.median), weight: CURVES.fcp.weight });
  if (m.lcpMs != null) parts.push({ score: logNormalScore(m.lcpMs, CURVES.lcp.p10, CURVES.lcp.median), weight: CURVES.lcp.weight });
  if (m.tbtMs != null) parts.push({ score: logNormalScore(Math.max(m.tbtMs, 1), CURVES.tbt.p10, CURVES.tbt.median), weight: CURVES.tbt.weight });
  if (m.clsScore != null) parts.push({ score: logNormalScore(Math.max(m.clsScore, 0.001), CURVES.cls.p10, CURVES.cls.median), weight: CURVES.cls.weight });
  if (!parts.length) return null;
  const total = parts.reduce((s, p) => s + p.weight, 0);
  return Math.round((parts.reduce((s, p) => s + p.score * p.weight, 0) / total) * 100);
}

// ------------------------------------------------------------------- PSI source

interface PsiAudit {
  title?: string;
  description?: string;
  displayValue?: string;
  numericValue?: number;
  score?: number | null;
  details?: { type?: string; overallSavingsMs?: number; items?: unknown[] };
}

/** CrUX reports CLS as an integer scaled by 100 — 8 means 0.08, not 8. */
function cruxCls(v: number | undefined): number | null {
  return typeof v === 'number' ? v / 100 : null;
}

async function runPsi(url: string, strategy: 'mobile' | 'desktop', timeoutMs: number): Promise<PageInsightIntel> {
  const at = Date.now();
  const q = new URLSearchParams({ url, strategy });
  for (const c of ['performance', 'accessibility', 'best-practices', 'seo']) q.append('category', c);

  // An API key is preferred when one exists: it costs no token round-trip. The
  // service account is the fallback, and anonymous is the last resort that mostly
  // 429s. Whichever ran is recorded, because "the quota is exhausted" and "we were
  // billing the wrong project" look identical in the result otherwise.
  const headers: Record<string, string> = {};
  let auth: PageInsightIntel['auth'] = 'anonymous';
  const key = pageInsightApiKey();
  if (key) {
    q.set('key', key);
    auth = 'api-key';
  } else {
    const token = await serviceAccountToken();
    if (token) {
      headers.authorization = `Bearer ${token}`;
      auth = 'service-account';
    }
  }

  const res = await fetch(`${PSI_ENDPOINT}?${q}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const body = (await res.json()) as {
    error?: { code?: number; message?: string };
    lighthouseResult?: {
      categories?: Record<string, { score?: number | null }>;
      audits?: Record<string, PsiAudit>;
    };
    loadingExperience?: {
      overall_category?: string;
      metrics?: Record<string, { percentile?: number }>;
    };
  };

  if (!res.ok || body.error) {
    const hint =
      res.status === 429 && auth === 'anonymous'
        ? ' — no PAGESPEED_API_KEY and no service-account key file, so this used the' +
          ' anonymous shared quota, which is exhausted'
        : '';
    throw new Error(`PSI ${res.status} [${auth}]: ${body.error?.message ?? res.statusText}${hint}`);
  }

  const cats = body.lighthouseResult?.categories ?? {};
  const audits = body.lighthouseResult?.audits ?? {};
  const pct = (c?: { score?: number | null }): number | null =>
    typeof c?.score === 'number' ? Math.round(c.score * 100) : null;
  const num = (id: string): number | null => {
    const v = audits[id]?.numericValue;
    return typeof v === 'number' ? Math.round(v) : null;
  };

  const opportunities: PageInsightOpportunity[] = Object.values(audits)
    .filter((a) => a.details?.type === 'opportunity' && (a.details.overallSavingsMs ?? 0) >= 100)
    .sort((a, b) => (b.details?.overallSavingsMs ?? 0) - (a.details?.overallSavingsMs ?? 0))
    .slice(0, 6)
    .map((a) => ({
      title: a.title ?? 'unnamed opportunity',
      detail: a.displayValue ?? (a.description ?? '').split('. ')[0],
      savingsMs: Math.round(a.details?.overallSavingsMs ?? 0),
    }));

  const le = body.loadingExperience;
  const fieldMetrics = le?.metrics ?? {};
  const hasField = Object.keys(fieldMetrics).length > 0;

  return {
    url,
    source: 'psi',
    auth,
    strategy,
    fetchedAt: new Date().toISOString(),
    ok: true,
    ms: Date.now() - at,
    scores: {
      performance: pct(cats.performance),
      accessibility: pct(cats.accessibility),
      bestPractices: pct(cats['best-practices']),
      seo: pct(cats.seo),
    },
    metrics: {
      lcpMs: num('largest-contentful-paint'),
      clsScore: (() => {
        const v = audits['cumulative-layout-shift']?.numericValue;
        return typeof v === 'number' ? Math.round(v * 1000) / 1000 : null;
      })(),
      tbtMs: num('total-blocking-time'),
      fcpMs: num('first-contentful-paint'),
      ttfbMs: num('server-response-time'),
      speedIndexMs: num('speed-index'),
      transferBytes: num('total-byte-weight'),
      // PSI has no numeric request-count metric; the count is the length of the
      // network-requests audit's own table.
      requests: audits['network-requests']?.details?.items?.length ?? null,
    },
    field: hasField
      ? {
          lcpMs: fieldMetrics.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? null,
          clsScore: cruxCls(fieldMetrics.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile),
          inpMs: fieldMetrics.INTERACTION_TO_NEXT_PAINT?.percentile ?? null,
          verdict: le?.overall_category ?? null,
        }
      : null,
    opportunities,
    checks: [],
  };
}

// --------------------------------------------------------------- browser source

/**
 * Lighthouse's mobileSlow4G preset, applied through CDP exactly as Lighthouse does.
 * Without it we would be measuring this machine's fibre line, which flatters every
 * site and produces a benchmark no prospect's customer would ever experience.
 */
const THROTTLE = {
  latency: 150 * 3.75,
  downloadThroughput: Math.floor((1.6 * 1024 * 0.9 * 1024) / 8),
  uploadThroughput: Math.floor((750 * 0.9 * 1024) / 8),
  cpuSlowdown: 4,
};

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

/**
 * Everything is read AFTER load from the browser's own buffered timeline, never from
 * a hook installed before navigation.
 *
 * The obvious design — `page.addInitScript` writing vitals onto `window` — cannot work
 * here. Patchright runs init scripts in an isolated world specifically so a site cannot
 * see them, which means `page.evaluate` cannot see them either: measured 2026-08-17, a
 * probe global set that way read back MISSING while the same evaluate saw all 83 real
 * resource entries. A buffered PerformanceObserver registered late gets the entries the
 * browser retained from the start, so nothing is lost by asking afterwards.
 *
 * It is SOURCE TEXT, not a function reference, and it has to stay that way.
 * `page.evaluate(fn)` serialises the compiled body, and tsx/esbuild rewrites arrow
 * functions to call its own `__name` helper — which does not exist in the page, so the
 * call dies with `ReferenceError: __name is not defined` (measured 2026-08-17). A
 * string reaches the page verbatim and cannot pick up a build-time helper.
 */
const COLLECT = `(async () => {
  const nav = performance.getEntriesByType('navigation')[0];
  // Both lookups, because getEntriesByName came back empty on a real run where the
  // paint had demonstrably happened (LCP was 8.9s). The buffered observer is the
  // reliable path; the two synchronous reads are kept as cheap fallbacks.
  const paintNow = performance.getEntriesByType('paint').filter((p) => p.name === 'first-contentful-paint')[0]
    || performance.getEntriesByName('first-contentful-paint')[0];
  const res = performance.getEntriesByType('resource');

  // A buffered observer delivers its backlog on a queued task, NOT synchronously, so
  // the callback is given a tick to fire before the records are taken.
  const gather = (type) => new Promise((resolve) => {
    let acc = [];
    let po;
    try {
      po = new PerformanceObserver((list) => { acc = acc.concat(list.getEntries()); });
      po.observe({ type, buffered: true });
    } catch (e) { resolve([]); return; }
    setTimeout(() => {
      try { acc = acc.concat(po.takeRecords()); po.disconnect(); } catch (e) {}
      resolve(acc);
    }, 150);
  });

  const [lcpEntries, shiftEntries, longTasks, paintEntries] = await Promise.all([
    gather('largest-contentful-paint'),
    gather('layout-shift'),
    gather('longtask'),
    gather('paint'),
  ]);

  const lcp = lcpEntries.length ? lcpEntries[lcpEntries.length - 1].startTime : null;
  const fcpEntry = paintEntries.filter((p) => p.name === 'first-contentful-paint')[0] || paintNow;
  const tbt = longTasks.reduce((s, e) => s + Math.max(0, e.duration - 50), 0);

  // Session-window CLS, the definition the Core Web Vital actually uses: a window
  // closes after a 1s gap or a 5s run, and the WORST window is the score. A naive
  // running total punishes a long page for shifts no visitor ever saw together.
  let cls = 0, val = 0, first = 0, last = 0;
  for (const e of shiftEntries) {
    if (e.hadRecentInput) continue;
    if (val && e.startTime - last < 1000 && e.startTime - first < 5000) { val += e.value; last = e.startTime; }
    else { val = e.value; first = last = e.startTime; }
    if (val > cls) cls = val;
  }

  const d = document;
  const imgs = Array.from(d.images);
  const meta = (n) => { const m = d.querySelector('meta[name="' + n + '"]'); return m ? (m.content || '').trim() : ''; };
  return {
    lcp,
    cls: Math.round(cls * 1000) / 1000,
    tbt: Math.round(tbt),
    fcp: fcpEntry ? Math.round(fcpEntry.startTime) : null,
    ttfb: nav ? Math.round(nav.responseStart) : null,
    // Kept only as a floor. transferSize is 0 for any cross-origin response without
    // Timing-Allow-Origin, which on a typical WordPress site means the fonts, the
    // CDN images and the tag manager all count as free. The real total comes from
    // CDP in the caller; this is the fallback if that produced nothing.
    bytes: res.reduce((s, r) => s + (r.transferSize || 0), 0) + (nav ? nav.transferSize || 0 : 0),
    requests: res.length + (nav ? 1 : 0),
    finalUrl: location.href,
    checks: {
      https: location.protocol === 'https:',
      viewport: meta('viewport'),
      title: (d.title || '').trim(),
      desc: meta('description'),
      h1: d.querySelectorAll('h1').length,
      images: imgs.length,
      missingAlt: imgs.filter((i) => !i.getAttribute('alt')).length,
    },
  };
})()`;

/** What COLLECT returns. Declared here because a string cannot be type-checked. */
interface Collected {
  lcp: number | null;
  cls: number;
  tbt: number;
  fcp: number | null;
  ttfb: number | null;
  bytes: number;
  requests: number;
  finalUrl: string;
  checks: { https: boolean; viewport: string; title: string; desc: string; h1: number; images: number; missingAlt: number };
}

async function runBrowserBenchmark(
  browser: BrowserManager,
  url: string,
  timeoutMs: number,
): Promise<PageInsightIntel> {
  const at = Date.now();

  const raw = await browser.run(async (ctx, page) => {
    const cdp = await ctx.newCDPSession(page);
    // Bytes on the wire, counted by the network stack rather than by the page.
    // `PerformanceResourceTiming.transferSize` reports 0 for every cross-origin
    // response that omits Timing-Allow-Origin, which on a typical WordPress site is
    // the fonts, the CDN images and the tag manager — measured on solarpanels.my it
    // put a page with 61 requests at 0.1 MB. CDP sees the real figure.
    let wireBytes = 0;
    let wireRequests = 0;
    cdp.on('Network.loadingFinished', (e) => {
      wireRequests++;
      wireBytes += e.encodedDataLength || 0;
    });
    try {
      await cdp.send('Network.enable');
      await cdp.send('Network.clearBrowserCache');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: THROTTLE.latency,
        downloadThroughput: THROTTLE.downloadThroughput,
        uploadThroughput: THROTTLE.uploadThroughput,
      });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE.cpuSlowdown });
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 412,
        height: 823,
        deviceScaleFactor: 1.75,
        mobile: true,
      });
      await cdp.send('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA });

      // Budgeted, not `waitUntil: 'load'`.
      //
      // Waiting for `load` under a real mobile throttle turns the slowest sites — the
      // ones most worth reporting on — into failures rather than findings: measured
      // 2026-08-17, solarpanels.my (83 requests) blew a 90s goto timeout outright and
      // the stage returned nothing at all. Lighthouse does not wait for load either.
      // So: navigate, give the page a fixed budget to finish, and measure whatever it
      // managed. A page still loading when the budget runs out is the headline, and it
      // is recorded rather than thrown away.
      await page.goto(url, { waitUntil: 'commit', timeout: Math.min(30_000, timeoutMs) });
      const loadBudget = Math.max(15_000, Math.min(35_000, timeoutMs - 35_000));
      const loadCompleted = await page
        .waitForLoadState('load', { timeout: loadBudget })
        .then(() => true)
        .catch(() => false);
      // LCP and late layout shifts land after load, so the page gets a settling window
      // before it is read. Four seconds because the CPU is throttled 4x while this runs.
      await page.waitForTimeout(4_000);

      const collected = (await page.evaluate(COLLECT)) as Collected;
      return {
        ...collected,
        bytes: wireBytes || collected.bytes,
        requests: Math.max(wireRequests, collected.requests),
        loadCompleted,
        loadBudget,
      };
    } finally {
      // Restoring the browser matters more than the measurement. This is the shared
      // agent context: a 4x CPU throttle or a 412px mobile viewport left behind would
      // silently corrupt every stage that runs after this one.
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
      await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
      await cdp.send('Emulation.setUserAgentOverride', { userAgent: '' }).catch(() => {});
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => {});
      await cdp
        .send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
        .catch(() => {});
      await cdp.detach().catch(() => {});
    }
  });

  const lcpMs = raw.lcp == null ? null : Math.round(raw.lcp);
  const metrics = { fcpMs: raw.fcp, lcpMs, tbtMs: raw.tbt, clsScore: raw.cls };
  const c = raw.checks;

  const checks: PageInsightCheck[] = [
    { label: 'HTTPS', pass: c.https, detail: c.https ? 'served over TLS' : 'no certificate — browsers mark it "Not secure"' },
    {
      label: 'Mobile viewport',
      pass: /width\s*=\s*device-width/i.test(c.viewport),
      detail: c.viewport ? c.viewport : 'no viewport meta — the page renders desktop-wide on a phone',
    },
    {
      label: 'Title tag',
      pass: c.title.length >= 10 && c.title.length <= 65,
      detail: c.title ? `${c.title.length} chars: "${c.title.slice(0, 70)}"` : 'missing',
    },
    {
      label: 'Meta description',
      pass: c.desc.length >= 50 && c.desc.length <= 165,
      detail: c.desc ? `${c.desc.length} chars` : 'missing — Google writes its own snippet instead',
    },
    { label: 'Single H1', pass: c.h1 === 1, detail: `${c.h1} H1 heading${c.h1 === 1 ? '' : 's'}` },
    {
      label: 'Image alt text',
      pass: c.images === 0 || c.missingAlt === 0,
      detail: c.images === 0 ? 'no images' : `${c.missingAlt} of ${c.images} images missing alt`,
    },
  ];

  // No opportunity list from a source that does not diagnose causes — so the worst
  // metrics become the opportunities, which is the honest version of the same thing.
  const opportunities: PageInsightOpportunity[] = [];
  if (!raw.loadCompleted)
    opportunities.push({
      title: 'Page never finished loading',
      detail: `still fetching after ${Math.round(raw.loadBudget / 1000)}s on throttled 4G — ${raw.requests} requests, ` +
        `${(raw.bytes / 1_048_576).toFixed(1)} MB so far`,
      savingsMs: null,
    });
  if (lcpMs != null && lcpMs > 2_500)
    opportunities.push({
      title: 'Largest Contentful Paint is slow',
      detail: `${(lcpMs / 1000).toFixed(1)}s on throttled 4G — the Core Web Vitals threshold is 2.5s`,
      savingsMs: lcpMs - 2_500,
    });
  if (raw.tbt > 200)
    opportunities.push({
      title: 'Main thread is blocked',
      detail: `${raw.tbt}ms of blocking script — taps do not respond while this runs`,
      savingsMs: raw.tbt - 200,
    });
  if (raw.cls > 0.1)
    opportunities.push({ title: 'Layout shifts while loading', detail: `CLS ${raw.cls} against a 0.1 threshold`, savingsMs: null });
  if (raw.bytes > 2_000_000)
    opportunities.push({
      title: 'Page weight',
      detail: `${(raw.bytes / 1_048_576).toFixed(1)} MB over ${raw.requests} requests`,
      savingsMs: null,
    });
  checks
    .filter((k) => !k.pass)
    .forEach((k) => opportunities.push({ title: k.label, detail: k.detail, savingsMs: null }));

  return {
    url: raw.finalUrl || url,
    source: 'browser',
    strategy: 'mobile',
    fetchedAt: new Date().toISOString(),
    ok: true,
    ms: Date.now() - at,
    scores: {
      performance: estimatePerformance(metrics),
      accessibility: null,
      bestPractices: null,
      // A local SEO score would be an invented number; the checks list carries the
      // same information without dressing it up as Google's grade.
      seo: null,
    },
    performanceEstimated: true,
    metrics: {
      ...metrics,
      ttfbMs: raw.ttfb,
      speedIndexMs: null,
      transferBytes: raw.bytes,
      requests: raw.requests,
    },
    field: null,
    opportunities: opportunities.slice(0, 6),
    checks,
  };
}

// ------------------------------------------------------------------ entry point

/**
 * Benchmark a prospect's website. PSI first when it can run, our own Chromium when
 * it cannot. Throws only when BOTH sources fail — the caller gets a real result or
 * a message naming both failures, never a silent empty.
 */
export async function runPageInsight(
  url: string,
  opts: { browser?: BrowserManager; strategy?: 'mobile' | 'desktop'; timeoutMs?: number } = {},
): Promise<PageInsightIntel> {
  const strategy = opts.strategy ?? 'mobile';
  const timeoutMs = opts.timeoutMs ?? 90_000;

  let target: URL;
  try {
    target = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    throw new Error(`unparseable website url: ${url}`);
  }

  let psiError = 'not attempted';
  try {
    return await runPsi(target.toString(), strategy, timeoutMs);
  } catch (err) {
    psiError = err instanceof Error ? err.message : String(err);
  }

  if (!opts.browser) throw new Error(`${psiError}; no browser given for the local fallback`);
  try {
    return await runBrowserBenchmark(opts.browser, target.toString(), timeoutMs);
  } catch (err) {
    const local = err instanceof Error ? err.message : String(err);
    throw new Error(`PSI failed (${psiError}) and the local benchmark failed (${local})`);
  }
}
