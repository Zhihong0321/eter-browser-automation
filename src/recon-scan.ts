/**
 * RECON-AGENT — the scan itself.
 *
 * Spec: docs/superpowers/specs/2026-08-12-recon-agent-design.md §4, §5, §9
 *
 * One launch, one tab, every route. Expanding a menu is not a jump: the whole
 * navigation surface counts as depth 1, because on an ERP the data grids live
 * two clicks deep and a literal one-hop crawl would map section headers and
 * miss everything worth automating.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Locator, Page } from 'patchright';
import { analyzeSettle, assertReconAllowed, captureSettle, detectChallenge, type SettleTrace, type SettleVerdict } from './recon.js';
import { collectDom, partitionByPolicy, type PageDom, type SkippedControl, type TableShape, type UiElement } from './recon-dom.js';
import { captureNetwork, probeReplay, usefulEndpoints, type XhrRecord } from './recon-net.js';

const MAX_PAGES = 40;

export interface TabScan {
  name: string;
  selector: string;
  table: TableShape | null;
  /** true when a human ticked this control, false when role=tab made it automatic. */
  approvedByHuman?: boolean;
  error?: string;
}

export interface PageScan {
  routeKey: string;
  navPath: string[];
  url: string;
  title: string;
  settledAt: number | null;
  exitReason: SettleTrace['exitReason'];
  verdict: SettleVerdict;
  table: TableShape | null;
  tabs: TabScan[];
  elements: UiElement[];
  skipped: SkippedControl[];
  xhr: XhrRecord[];
}

export interface SiteScan {
  domain: string;
  root: string;
  startedAt: string;
  finishedAt: string;
  pages: PageScan[];
  failed: { url: string; error: string }[];
  notes: string[];
}

export interface ScanOptions {
  windowMs?: number;
  quietMs?: number;
  maxPages?: number;
  /** Explored in a second pass after the human ticks them. Keyed "role::name". */
  approved?: string[];
}

/** Turn an inventory entry back into something clickable. */
function locate(page: Page, el: UiElement): Locator {
  if (el.strategy === 'role-name') {
    return page.getByRole(el.role as Parameters<Page['getByRole']>[0], { name: el.name, exact: true }).first();
  }
  return page.locator(el.selector).first();
}

/**
 * Wait for the table to stop changing after an in-page action.
 *
 * Not a fixed sleep and not networkidle — it watches the row count and the
 * first row's cell count until they hold still. Same principle as the settle
 * curve: wait on the data's shape, never on an element merely existing.
 */
async function waitForStableTable(page: Page, quietMs = 1200, capMs = 8000): Promise<void> {
  const deadline = Date.now() + capMs;
  let last = '';
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    const sig = await page
      .evaluate(() => {
        const t = document.querySelector('table, [role="grid"], [role="table"]');
        if (!t) return 'none';
        const rows = t.querySelectorAll('tbody tr, [role="row"]').length;
        const first = t.querySelector('tbody tr, [role="row"]');
        const cells = first ? first.querySelectorAll('td, th, [role="cell"], [role="gridcell"]').length : 0;
        return `${rows}:${cells}:${(first?.textContent ?? '').length}`;
      })
      .catch(() => 'err');
    if (sig !== last) {
      last = sig;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= quietMs) {
      return;
    }
    await page.waitForTimeout(150);
  }
}

/** Scan one route: settle, inventory, tabs, network. */
export async function scanPage(
  ctx: BrowserContext,
  page: Page,
  url: string,
  navPath: string[],
  opts: ScanOptions = {},
): Promise<PageScan> {
  const net = captureNetwork(page);
  const trace = await captureSettle(page, url, opts.windowMs ?? 8000, opts.quietMs ?? 2000);

  const body = await page.evaluate(() => (document.body?.textContent ?? '').slice(0, 2000)).catch(() => '');
  const challenge = detectChallenge(trace.url, trace.title, body);
  if (challenge) {
    await net.finish();
    throw new Error(`${challenge} challenge on ${trace.url} — stopping, not retrying`);
  }

  const dom: PageDom = await page.evaluate(collectDom);
  const { clickable, skipped } = partitionByPolicy(dom.elements);

  // Tab-like states are the reason this pass exists. On admin.atap.solar the
  // payment states are not separate URLs, so a link-only crawl records one
  // table and reports the page has one state — missing four of five, including
  // the one the user calls "submitted payments".
  //
  // Those "tabs" are plain <button> elements with no role=tab, sitting beside
  // "Delete Submission" and "Auto-Reconcile" — same role, same look. No
  // heuristic can separate them safely, which is why pass 1 refuses them all
  // and the human ticks the ones that are really tabs. Approval is by name.
  const approved = new Set((opts.approved ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean));
  const explorable = [
    ...clickable.filter((e) => e.role === 'tab'),
    ...dom.elements.filter((e) => e.role !== 'tab' && !e.disabled && approved.has(e.name.toLowerCase())),
  ];

  const tabs: TabScan[] = [];
  for (const tab of explorable) {
    try {
      await locate(page, tab).click({ timeout: 8000 });
      await waitForStableTable(page);
      const after = await page.evaluate(collectDom);
      tabs.push({ name: tab.name, selector: tab.selector, table: after.table, approvedByHuman: tab.role !== 'tab' });
    } catch (err) {
      tabs.push({
        name: tab.name,
        selector: tab.selector,
        table: null,
        error: err instanceof Error ? err.message.slice(0, 140) : 'click failed',
      });
    }
  }

  const xhr = await net.finish();
  await probeReplay(ctx, xhr);

  return {
    routeKey: url,
    navPath,
    url: trace.url,
    title: trace.title,
    settledAt: analyzeSettle(trace).settledAt,
    exitReason: trace.exitReason,
    verdict: analyzeSettle(trace),
    table: dom.table,
    tabs,
    elements: dom.elements,
    skipped,
    xhr,
  };
}

/**
 * Find every destination on the navigation surface, expanding menus as needed.
 * Expanding is an allowlisted click; it reveals children rather than acting.
 */
export async function discoverNav(page: Page, rounds = 3): Promise<{ name: string; href: string }[]> {
  const found = new Map<string, string>();

  for (let i = 0; i < rounds; i++) {
    const dom: PageDom = await page.evaluate(collectDom);
    for (const l of dom.navLinks) if (!found.has(l.href)) found.set(l.href, l.name);

    const { clickable } = partitionByPolicy(dom.elements);
    const toExpand = clickable.filter((e) => e.expanded === false && e.inNav);
    if (!toExpand.length) break;

    for (const el of toExpand.slice(0, 25)) {
      await locate(page, el)
        .click({ timeout: 4000 })
        .catch(() => {});
    }
    await page.waitForTimeout(400);
  }

  return [...found.entries()].map(([href, name]) => ({ name, href }));
}

/** Crawl the site and write scan.json. One launch, one tab. */
export async function scanSite(
  ctx: BrowserContext,
  page: Page,
  rootUrl: string,
  outDir: string,
  opts: ScanOptions = {},
): Promise<SiteScan> {
  const domain = new URL(rootUrl).hostname;
  assertReconAllowed(domain);

  const scan: SiteScan = {
    domain,
    root: rootUrl,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    pages: [],
    failed: [],
    notes: [],
  };

  const root = await scanPage(ctx, page, rootUrl, [], opts);
  scan.pages.push(root);

  const nav = await discoverNav(page);
  const max = opts.maxPages ?? MAX_PAGES;
  const targets = nav.filter((n) => n.href !== root.url);
  if (targets.length > max) {
    scan.notes.push(`Found ${targets.length} routes; scanned the first ${max}. Raise --max-pages to cover the rest.`);
  }

  for (const target of targets.slice(0, max)) {
    try {
      scan.pages.push(await scanPage(ctx, page, target.href, [target.name], opts));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A dead route is data, not a reason to abandon the scan. A dead SESSION
      // is different: every page after it would be a login screen recorded as
      // if it were the app.
      if (/challenge|login|sign in|session/i.test(msg)) {
        scan.notes.push(`ABORTED at ${target.href}: ${msg}`);
        break;
      }
      scan.failed.push({ url: target.href, error: msg.slice(0, 200) });
    }
  }

  scan.finishedAt = new Date().toISOString();
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'scan.json'), JSON.stringify(scan, null, 2), 'utf8');
  return scan;
}

/** Terminal summary. The full detail lives in scan.json. */
export function formatScan(scan: SiteScan): string {
  const L: string[] = [];
  L.push(`\n  ${scan.domain} — ${scan.pages.length} pages, ${scan.failed.length} failed`);
  L.push('');
  for (const p of scan.pages) {
    const t = p.table ? `${p.table.columns} cols × ${p.table.rows} rows` : '—';
    L.push(`  ${(p.navPath[0] ?? '/').padEnd(28).slice(0, 28)} ${String(p.settledAt ?? '?').padStart(5)}ms  ${t}`);
    if (p.verdict.waitOn) L.push(`      WAIT ON  /${p.verdict.waitOn.pattern}/`);
    for (const u of p.verdict.unstable) L.push(`      NOT ON   ${u.probe} (${u.earlyCount}→${u.finalCount})`);
    for (const x of p.verdict.loadingTexts) L.push(`      NOT ON   "${x.text}"`);
    for (const tab of p.tabs) {
      const mark = tab.approvedByHuman ? '✓' : ' ';
      L.push(`    ${mark} tab      ${tab.name} → ${tab.table ? `${tab.table.rows} rows` : (tab.error ?? 'no table')}`);
    }
    for (const e of usefulEndpoints(p.xhr)) {
      L.push(`      API      ${e.method} ${e.urlPattern} ✓ replayable${e.rowCount !== undefined ? ` (${e.rowCount} rows)` : ''}`);
    }
    if (p.skipped.length) L.push(`      skipped  ${p.skipped.length} controls awaiting your approval`);
  }
  for (const f of scan.failed) L.push(`  FAILED ${f.url} — ${f.error}`);
  for (const n of scan.notes) L.push(`  note   ${n}`);
  return L.join('\n');
}
