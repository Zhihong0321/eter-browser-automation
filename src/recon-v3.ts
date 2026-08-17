/**
 * RECON V3 — fast, additive site discovery.
 *
 * V1 remains the conservative offline-snapshot scanner. V3 favors a short,
 * measured discovery pass: real PNGs, adaptive settling, bounded parallel
 * route tabs, and concurrent read-only API replay. Its artifacts live in a
 * separate directory so V1 and V3 can be benchmarked side by side.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { BrowserContext, Locator, Page } from 'patchright';
import { assertReconAllowed, detectChallenge } from './recon.js';
import {
  collectDom,
  partitionByPolicy,
  type PageDom,
  type SkippedControl,
  type TableShape,
  type UiElement,
} from './recon-dom.js';
import {
  captureNetwork,
  isVerifiedRead,
  reconcileRows,
  type XhrRecord,
} from './recon-net.js';

export interface ReconV3Options {
  maxPages?: number;
  concurrency?: number;
  settleQuietMs?: number;
  settleCapMs?: number;
  replay?: boolean;
  replayConcurrency?: number;
  replayLimit?: number;
  screenshots?: boolean;
  fullPage?: boolean;
  exploreTabs?: boolean;
}

export interface ResolvedReconV3Options {
  maxPages: number;
  concurrency: number;
  settleQuietMs: number;
  settleCapMs: number;
  replay: boolean;
  replayConcurrency: number;
  replayLimit: number;
  screenshots: boolean;
  fullPage: boolean;
  exploreTabs: boolean;
}

export interface V3Screenshot {
  file: string | null;
  bytes: number;
  fullPage: boolean;
  error?: string;
}

export interface V3Settle {
  exitReason: 'quiet' | 'cap' | 'failed';
  elapsedMs: number;
  mutations: number;
  quietMs: number;
  capMs: number;
}

export interface V3Timings {
  navigateMs: number;
  settleMs: number;
  domMs: number;
  screenshotMs: number;
  tabsMs: number;
  networkMs: number;
  replayMs: number;
  totalMs: number;
}

export interface V3TabScan {
  name: string;
  selector: string;
  table: TableShape | null;
  settle: V3Settle;
  error?: string;
}

export type V3CrudOperation = 'create' | 'read' | 'update' | 'delete';

export interface V3QuickTestStep {
  action: string;
  selector?: string;
  expect: string;
}

export interface V3QuickTestOperation {
  operation: V3CrudOperation;
  available: boolean;
  evidence: string[];
  steps: V3QuickTestStep[];
}

/** Machine-readable handoff for an AI that will test the page after discovery. */
export interface V3QuickTestPlan {
  order: ['read', 'write'];
  rule: string;
  marker: string;
  readGate: {
    status: 'passed' | 'blocked';
    safe: true;
    evidence: string[];
  };
  operations: Record<V3CrudOperation, V3QuickTestOperation>;
}

export interface V3PageScan {
  routeKey: string;
  navPath: string[];
  url: string;
  title: string;
  table: TableShape | null;
  tabs: V3TabScan[];
  elements: UiElement[];
  skipped: SkippedControl[];
  navLinks: { name: string; href: string }[];
  xhr: XhrRecord[];
  quickTest: V3QuickTestPlan;
  screenshot?: V3Screenshot;
  settle: V3Settle;
  timings: V3Timings;
}

function matchingControls(elements: UiElement[], pattern: RegExp): UiElement[] {
  return elements.filter((el) => !el.disabled && pattern.test(el.name.trim()));
}

function controlEvidence(controls: UiElement[]): string[] {
  return controls.map((el) => `${el.role} "${el.name}" via ${el.selector}`);
}

export function buildQuickTestPlanV3(
  url: string,
  table: TableShape | null,
  elements: UiElement[],
  xhr: XhrRecord[],
): V3QuickTestPlan {
  const create = matchingControls(elements, /^(?:new|add|create)\b/i);
  const update = matchingControls(elements, /\b(?:edit|update|save)\b/i);
  const remove = matchingControls(elements, /\b(?:delete|remove|void|cancel document)\b/i);
  const jsonGets = xhr.filter((rec) => rec.method === 'GET' && rec.status >= 200 && rec.status < 300);
  const readEvidence = [
    ...(table ? [`grid ${table.columns} columns x ${table.rows} rendered rows: ${table.headers.join(' | ')}`] : []),
    ...jsonGets.slice(0, 12).map((rec) => `GET ${rec.urlPattern} -> ${rec.status}`),
  ];
  const marker = `RECON-V3-${slug(new URL(url).pathname).toUpperCase()}-<UTC_TIMESTAMP>`;
  const navigate: V3QuickTestStep = {
    action: `navigate through an existing same-origin SPA link to ${url}`,
    expect: `the authenticated application remains on ${new URL(url).pathname}`,
  };
  const writeSteps = (controls: UiElement[], verb: string): V3QuickTestStep[] => controls.length ? [
    navigate,
    { action: `click the ${verb} control`, selector: controls[0].selector, expect: `${verb} UI opens` },
    { action: `use marker ${marker}; capture required fields and the mutation request before confirming`, expect: 'validation and request shape are recorded' },
    { action: 'confirm once, verify the resulting row/state, then clean up when Delete is available', expect: 'UI and network response agree' },
  ] : [];

  return {
    order: ['read', 'write'],
    rule: 'Run READ first. Do not execute Create/Update/Delete unless readGate.status is passed. Use only marked trial data.',
    marker,
    readGate: {
      status: readEvidence.length ? 'passed' : 'blocked',
      safe: true,
      evidence: readEvidence.length ? readEvidence : ['No rendered table or successful GET was observed.'],
    },
    operations: {
      read: {
        operation: 'read',
        available: readEvidence.length > 0,
        evidence: readEvidence,
        steps: [navigate, { action: 'observe the rendered grid and captured GET responses without changing controls', expect: 'screen shape and response shape are recorded' }],
      },
      create: { operation: 'create', available: create.length > 0, evidence: controlEvidence(create), steps: writeSteps(create, 'Create/New') },
      update: { operation: 'update', available: update.length > 0, evidence: controlEvidence(update), steps: writeSteps(update, 'Edit/Update') },
      delete: { operation: 'delete', available: remove.length > 0, evidence: controlEvidence(remove), steps: writeSteps(remove, 'Delete/Void') },
    },
  };
}

export interface V3SiteScan {
  version: 3;
  mode: 'fast';
  status: 'running' | 'complete' | 'aborted';
  domain: string;
  root: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  options: ResolvedReconV3Options;
  pages: V3PageScan[];
  failed: { url: string; error: string }[];
  notes: string[];
}

function intBetween(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = Number.isFinite(value) ? Math.trunc(value as number) : fallback;
  return Math.min(max, Math.max(min, n));
}

export function resolveReconV3Options(opts: ReconV3Options = {}): ResolvedReconV3Options {
  const settleQuietMs = intBetween(opts.settleQuietMs, 650, 200, 5_000);
  return {
    maxPages: intBetween(opts.maxPages, 40, 1, 200),
    concurrency: intBetween(opts.concurrency, 3, 1, 6),
    settleQuietMs,
    settleCapMs: intBetween(opts.settleCapMs, 3_500, settleQuietMs, 30_000),
    replay: opts.replay !== false,
    replayConcurrency: intBetween(opts.replayConcurrency, 4, 1, 8),
    replayLimit: intBetween(opts.replayLimit, 12, 0, 100),
    screenshots: opts.screenshots !== false,
    fullPage: opts.fullPage === true,
    exploreTabs: opts.exploreTabs === true,
  };
}

function slug(text: string): string {
  return text
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80) || 'index';
}

export function screenshotFileNameV3(raw: string): string {
  const url = new URL(raw);
  const identity = `${url.pathname}${url.search}`;
  const hash = createHash('sha1').update(identity).digest('hex').slice(0, 8);
  return `${slug(url.pathname)}-${hash}.png`;
}

function cleanUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = '';
  return url.href;
}

export function selectV3Targets(
  rootUrl: string,
  links: { name: string; href: string }[],
  maxPages: number,
): { name: string; href: string }[] {
  const root = new URL(rootUrl);
  const rootClean = cleanUrl(root.href);
  const seen = new Set<string>([rootClean]);
  const out: { name: string; href: string }[] = [];

  for (const link of links) {
    let url: URL;
    try {
      url = new URL(link.href, root);
    } catch {
      continue;
    }
    if (url.origin !== root.origin || !/^https?:$/.test(url.protocol)) continue;
    const href = cleanUrl(url.href);
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ name: link.name || url.pathname, href });
    if (out.length >= maxPages) break;
  }
  return out;
}

export function shapeOfV3(body: unknown): { jsonTopKeys?: string[]; rowKeys?: string[]; rowCount?: number } {
  if (Array.isArray(body)) {
    const first = body[0];
    return {
      jsonTopKeys: ['(array)'],
      rowKeys: first && typeof first === 'object' && !Array.isArray(first)
        ? Object.keys(first as Record<string, unknown>).slice(0, 40)
        : undefined,
      rowCount: body.length,
    };
  }
  if (!body || typeof body !== 'object') return {};
  const obj = body as Record<string, unknown>;
  const arrays = Object.values(obj).filter(Array.isArray) as unknown[][];
  const rows = arrays.sort((a, b) => b.length - a.length)[0];
  const first = rows?.[0];
  return {
    jsonTopKeys: Object.keys(obj).slice(0, 40),
    rowKeys: first && typeof first === 'object' && !Array.isArray(first)
      ? Object.keys(first as Record<string, unknown>).slice(0, 40)
      : undefined,
    rowCount: rows?.length,
  };
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;
  const count = Math.min(items.length, Math.max(1, Math.trunc(limit) || 1));
  await Promise.all(Array.from({ length: count }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }));
  return results;
}

export async function waitForAdaptiveQuiet(page: Page, quietMs: number, capMs: number): Promise<V3Settle> {
  const started = performance.now();
  try {
    const result = await page.evaluate(
      ({ quiet, cap }) => new Promise<{ exitReason: 'quiet' | 'cap'; elapsedMs: number; mutations: number }>((resolve) => {
        const beganAt = performance.now();
        let lastChangeAt = beganAt;
        let mutations = 0;
        let done = false;
        const observer = new MutationObserver((records) => {
          mutations += records.length;
          lastChangeAt = performance.now();
        });
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
        const timer = setInterval(() => {
          const now = performance.now();
          const quietEnough = now - lastChangeAt >= quiet;
          const capped = now - beganAt >= cap;
          if (!quietEnough && !capped) return;
          if (done) return;
          done = true;
          clearInterval(timer);
          observer.disconnect();
          resolve({
            exitReason: quietEnough ? 'quiet' : 'cap',
            elapsedMs: Math.round(now - beganAt),
            mutations,
          });
        }, 100);
      }),
      { quiet: quietMs, cap: capMs },
    );
    return { ...result, quietMs, capMs };
  } catch {
    return {
      exitReason: 'failed',
      elapsedMs: Math.round(performance.now() - started),
      mutations: 0,
      quietMs,
      capMs,
    };
  }
}

async function settleThroughRedirects(
  page: Page,
  quietMs: number,
  capMs: number,
  attempts = 4,
): Promise<V3Settle> {
  let last: V3Settle = { exitReason: 'failed', elapsedMs: 0, mutations: 0, quietMs, capMs };
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = await waitForAdaptiveQuiet(page, quietMs, capMs);
    if (last.exitReason !== 'failed') return last;
    // OIDC callbacks often replace the document immediately after
    // DOMContentLoaded. A destroyed observer means "navigation continued", not
    // "the page settled". Wait for the replacement document and try again.
    await page.waitForLoadState('domcontentloaded', { timeout: capMs }).catch(() => {});
    await page.waitForTimeout(150);
  }
  return last;
}

async function probeReplayV3(
  ctx: BrowserContext,
  records: XhrRecord[],
  limit: number,
  concurrency: number,
): Promise<void> {
  const seen = new Set<string>();
  const candidates: XhrRecord[] = [];
  for (const rec of records) {
    if (rec.method !== 'GET') continue;
    if (rec.status < 200 || rec.status >= 300) continue;
    if (!rec.contentType.includes('json')) {
      rec.replayable = 'not-json';
      continue;
    }
    if (seen.has(rec.urlPattern) || candidates.length >= limit) continue;
    seen.add(rec.urlPattern);
    candidates.push(rec);
  }

  await mapWithConcurrency(candidates, concurrency, async (rec) => {
    try {
      const res = await ctx.request.get(rec.url, { timeout: 15_000 });
      if (res.status() === 401 || res.status() === 403) {
        rec.replayable = 'auth-failed';
        rec.replayNote = `standalone request returned ${res.status()} — the UI adds something the bare call lacks`;
        return;
      }
      if (!res.ok()) {
        rec.replayable = 'no';
        rec.replayNote = `standalone request returned ${res.status()}`;
        return;
      }
      const shape = shapeOfV3(JSON.parse(await res.text()) as unknown);
      const before = (rec.jsonTopKeys ?? []).join(',');
      const after = (shape.jsonTopKeys ?? []).join(',');
      if (before && after && before !== after) {
        rec.replayable = 'no';
        rec.replayNote = 'standalone response has a different shape than the one the page received';
        return;
      }
      rec.replayable = 'yes';
      if (shape.rowCount !== undefined) {
        rec.apiRowCount = shape.rowCount;
        rec.replayNote = `${shape.rowCount} rows without rendering`;
      }
    } catch (err) {
      rec.replayable = 'no';
      rec.replayNote = err instanceof Error ? err.message.slice(0, 120) : 'replay failed';
    }
  });
}

function locate(page: Page, el: UiElement): Locator {
  if (el.strategy === 'role-name') {
    return page.getByRole(el.role as Parameters<Page['getByRole']>[0], { name: el.name, exact: true }).first();
  }
  return page.locator(el.selector).first();
}

function emptyTimings(): V3Timings {
  return {
    navigateMs: 0,
    settleMs: 0,
    domMs: 0,
    screenshotMs: 0,
    tabsMs: 0,
    networkMs: 0,
    replayMs: 0,
    totalMs: 0,
  };
}

async function takeScreenshotV3(page: Page, url: string, outDir: string, fullPage: boolean): Promise<V3Screenshot> {
  const dir = path.join(outDir, 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, screenshotFileNameV3(url));
  try {
    const bytes = await page.screenshot({ path: file, fullPage });
    return { file, bytes: bytes.length, fullPage };
  } catch (err) {
    return {
      file: null,
      bytes: 0,
      fullPage,
      error: err instanceof Error ? err.message.slice(0, 200) : 'screenshot failed',
    };
  }
}

async function exploreTabsV3(
  page: Page,
  dom: PageDom,
  opts: ResolvedReconV3Options,
): Promise<V3TabScan[]> {
  if (!opts.exploreTabs) return [];
  const { clickable } = partitionByPolicy(dom.elements);
  const tabs: V3TabScan[] = [];
  for (const tab of clickable.filter((el) => el.role === 'tab')) {
    try {
      await locate(page, tab).click({ timeout: 2_000 });
      const settle = await waitForAdaptiveQuiet(
        page,
        Math.min(500, opts.settleQuietMs),
        Math.min(2_000, opts.settleCapMs),
      );
      const after: PageDom = await page.evaluate(collectDom);
      tabs.push({ name: tab.name, selector: tab.selector, table: after.table, settle });
    } catch (err) {
      tabs.push({
        name: tab.name,
        selector: tab.selector,
        table: null,
        settle: { exitReason: 'failed', elapsedMs: 0, mutations: 0, quietMs: 0, capMs: 0 },
        error: err instanceof Error ? err.message.slice(0, 120) : 'tab failed',
      });
    }
  }
  return tabs;
}

export async function scanPageV3(
  ctx: BrowserContext,
  page: Page,
  url: string,
  navPath: string[],
  outDir: string,
  opts: ResolvedReconV3Options,
  navigate?: () => Promise<void>,
): Promise<V3PageScan> {
  const totalStarted = performance.now();
  const timings = emptyTimings();
  const net = captureNetwork(page);
  let networkFinished = false;
  let xhr: XhrRecord[] = [];
  const finishNetwork = async (): Promise<XhrRecord[]> => {
    if (networkFinished) return xhr;
    const started = performance.now();
    networkFinished = true;
    xhr = await net.finish();
    timings.networkMs = Math.round(performance.now() - started);
    return xhr;
  };

  try {
    let started = performance.now();
    if (navigate) await navigate();
    else await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    timings.navigateMs = Math.round(performance.now() - started);

    started = performance.now();
    const settle = await settleThroughRedirects(page, opts.settleQuietMs, opts.settleCapMs);
    timings.settleMs = Math.round(performance.now() - started);
    if (settle.exitReason === 'failed') {
      throw new Error(`settle observer failed across redirect chain on ${page.url()}`);
    }

    const body = await page.evaluate(() => (document.body?.textContent ?? '').slice(0, 2_000)).catch(() => '');
    const title = await page.title().catch(() => '');
    const currentUrl = page.url();
    const challenge = detectChallenge(currentUrl, title, body);
    if (challenge) throw new Error(`${challenge} challenge on ${page.url()} — stopping, not retrying`);
    if (
      /\/login(?:[/?#]|$)|\/signin(?:[/?#]|$)|\/account\/login(?:[/?#]|$)/i.test(currentUrl) ||
      /\b(?:log|sign)\s*in\b/i.test(title)
    ) {
      throw new Error(`login required on ${currentUrl} — saved session is not authenticated`);
    }
    if (/you are now logged out|cannot read properties of null \(reading ['"]access_token['"]\)/i.test(body)) {
      throw new Error(`session unavailable on ${currentUrl} — application rendered its logged-out state`);
    }

    started = performance.now();
    const dom: PageDom = await page.evaluate(collectDom);
    const { skipped } = partitionByPolicy(dom.elements);
    timings.domMs = Math.round(performance.now() - started);

    let screenshot: V3Screenshot | undefined;
    if (opts.screenshots) {
      started = performance.now();
      screenshot = await takeScreenshotV3(page, page.url(), outDir, opts.fullPage);
      timings.screenshotMs = Math.round(performance.now() - started);
    }

    started = performance.now();
    const tabs = await exploreTabsV3(page, dom, opts);
    timings.tabsMs = Math.round(performance.now() - started);

    await finishNetwork();
    if (opts.replay && opts.replayLimit > 0) {
      started = performance.now();
      await probeReplayV3(ctx, xhr, opts.replayLimit, opts.replayConcurrency);
      timings.replayMs = Math.round(performance.now() - started);
    }
    reconcileRows(xhr, [dom.table?.rows, ...tabs.map((tab) => tab.table?.rows)]);
    timings.totalMs = Math.round(performance.now() - totalStarted);

    return {
      routeKey: url,
      navPath,
      url: page.url(),
      title: await page.title().catch(() => ''),
      table: dom.table,
      tabs,
      elements: dom.elements,
      skipped,
      navLinks: dom.navLinks,
      xhr,
      quickTest: buildQuickTestPlanV3(page.url(), dom.table, dom.elements, xhr),
      screenshot,
      settle,
      timings,
    };
  } catch (err) {
    await finishNetwork().catch(() => {});
    throw err;
  }
}

async function clickRouteLink(page: Page, rawUrl: string): Promise<void> {
  const target = cleanUrl(rawUrl);
  if (cleanUrl(page.url()) === target) return;
  const current = page.url();
  if (current === 'about:blank' || !current.startsWith(new URL(target).origin)) {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return;
  }
  const clicked = await page.evaluate((href) => {
    const clean = (value: string): string => {
      const url = new URL(value, location.href);
      url.hash = '';
      return url.href;
    };
    const anchor = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
      .find((candidate) => clean(candidate.href) === href);
    if (!anchor) return false;
    anchor.click();
    return true;
  }, target);
  if (!clicked) throw new Error(`no in-app link for ${target} on ${page.url()}`);
  await page.waitForURL((url) => cleanUrl(url.href) === target, { timeout: 10_000 });
}

async function discoverNavFast(
  page: Page,
  root: V3PageScan,
): Promise<{ name: string; href: string }[]> {
  const found = new Map<string, string>();
  for (const link of root.navLinks) found.set(link.href, link.name);
  const { clickable } = partitionByPolicy(root.elements);
  const disclosures = clickable.filter((el) => el.expanded === false && el.inNav).slice(0, 12);
  if (!disclosures.length) return [...found].map(([href, name]) => ({ name, href }));

  for (const disclosure of disclosures) {
    await locate(page, disclosure).click({ timeout: 800 }).catch(() => {});
  }
  await waitForAdaptiveQuiet(page, 250, 1_200);
  const expanded: PageDom | null = await page.evaluate(collectDom).catch(() => null);
  for (const link of expanded?.navLinks ?? []) found.set(link.href, link.name);
  return [...found].map(([href, name]) => ({ name, href }));
}

function persistV3(outDir: string, scan: V3SiteScan): void {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'scan-v3.json'), JSON.stringify(scan, null, 2), 'utf8');
}

async function openWorkerFromAnchor(anchor: Page): Promise<Page> {
  // sessionStorage is copied by the browser when a same-origin browsing
  // context is created with an opener. BrowserContext.newPage() has no opener,
  // which makes OIDC-heavy SPAs look logged out. Let the platform clone the
  // storage area without ever reading token values into Node or scan output.
  const popup = anchor.waitForEvent('popup', { timeout: 5_000 });
  await anchor.evaluate(() => {
    if (!window.open('about:blank', '_blank')) throw new Error('worker popup was blocked');
  });
  return popup;
}

export async function scanSiteV3(
  ctx: BrowserContext,
  primaryPage: Page,
  rootUrl: string,
  outDir: string,
  options: ReconV3Options = {},
): Promise<V3SiteScan> {
  const domain = new URL(rootUrl).hostname;
  assertReconAllowed(domain);
  const opts = resolveReconV3Options(options);
  const scanStarted = performance.now();
  const scan: V3SiteScan = {
    version: 3,
    mode: 'fast',
    status: 'running',
    domain,
    root: rootUrl,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    durationMs: 0,
    options: opts,
    pages: [],
    failed: [],
    notes: [
      'V3 fast mode uses PNG screenshots and does not run Monolith.',
      opts.exploreTabs ? 'Tab exploration enabled.' : 'Tab exploration skipped; use --tabs for a deeper pass.',
    ],
  };
  fs.mkdirSync(path.join(outDir, 'screenshots'), { recursive: true });

  const root = await scanPageV3(
    ctx,
    primaryPage,
    rootUrl,
    [],
    outDir,
    opts,
    () => clickRouteLink(primaryPage, rootUrl),
  );
  scan.pages = [root];
  persistV3(outDir, scan);

  const discovered = [
    ...root.elements
      .filter((element) => element.role === 'link' && element.href)
      .map((element) => ({ name: element.name, href: element.href as string })),
    ...root.navLinks,
  ];
  const safeDiscovered = discovered.filter((link) => !/^switch company$/i.test(link.name.trim()));
  const allTargets = selectV3Targets(rootUrl, safeDiscovered, 200);
  const targetLimit = Math.max(0, opts.maxPages - 1);
  const targets = allTargets.slice(0, targetLimit);
  if (allTargets.length > targets.length) {
    scan.notes.push(`Found ${allTargets.length} routes; scanned ${targets.length} plus the root (maxPages=${opts.maxPages}).`);
  }

  const ordered = new Array<V3PageScan | undefined>(targets.length);
  const extraPages: Page[] = [];
  let cursor = 0;
  let aborted = false;
  const workerCount = Math.min(opts.concurrency, targets.length);
  // Concurrency 1 is the compatibility baseline: reuse the authenticated tab
  // exactly as V1 does. Parallel mode keeps that tab as an untouched anchor.
  const workers: Page[] = workerCount === 1 ? [primaryPage] : [];
  for (let i = workers.length; i < workerCount; i++) {
    const worker = await openWorkerFromAnchor(primaryPage);
    workers.push(worker);
    extraPages.push(worker);
  }

  const updatePages = (): void => {
    scan.pages = [root, ...ordered.filter((page): page is V3PageScan => page !== undefined)];
    scan.durationMs = Math.round(performance.now() - scanStarted);
    persistV3(outDir, scan);
  };

  try {
    await Promise.all(workers.map(async (workerPage) => {
      while (!aborted) {
        const index = cursor++;
        if (index >= targets.length) return;
        const target = targets[index];
        try {
          ordered[index] = await scanPageV3(
            ctx,
            workerPage,
            target.href,
            [target.name],
            outDir,
            opts,
            () => clickRouteLink(workerPage, target.href),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          scan.failed.push({ url: target.href, error: message.slice(0, 200) });
          if (/challenge|captcha|cloudflare/i.test(message)) {
            aborted = true;
            scan.notes.push(`ABORTED at ${target.href}: ${message}`);
          } else if (/login|sign in|session/i.test(message)) {
            scan.notes.push(`AUTH REFUSED ${target.href}: route redirected to login; remaining routes continued from the authenticated anchor.`);
          }
        }
        updatePages();
      }
    }));
  } finally {
    await Promise.all(extraPages.map((page) => page.close().catch(() => {})));
  }

  scan.status = aborted ? 'aborted' : 'complete';
  scan.finishedAt = new Date().toISOString();
  scan.durationMs = Math.round(performance.now() - scanStarted);
  updatePages();
  return scan;
}

export function formatScanV3(scan: V3SiteScan): string {
  const lines = [
    '',
    `  ${scan.domain} — V3 ${scan.status}, ${scan.pages.length} pages in ${(scan.durationMs / 1_000).toFixed(1)}s (concurrency ${scan.options.concurrency})`,
    '',
  ];
  for (const page of scan.pages) {
    const t = page.timings;
    const table = page.table ? `${page.table.columns} cols × ${page.table.rows} rows` : '—';
    const verified = page.xhr.filter(isVerifiedRead).length;
    lines.push(
      `  ${(page.navPath[0] ?? '/').padEnd(24).slice(0, 24)} ${String(t.totalMs).padStart(5)}ms  ` +
      `nav ${t.navigateMs} settle ${t.settleMs} dom ${t.domMs} png ${t.screenshotMs} ` +
      `tabs ${t.tabsMs} replay ${t.replayMs}  ${table}  ${verified} verified`,
    );
  }
  for (const failure of scan.failed) lines.push(`  FAILED ${failure.url} — ${failure.error}`);
  for (const note of scan.notes) lines.push(`  note   ${note}`);
  return lines.join('\n');
}
