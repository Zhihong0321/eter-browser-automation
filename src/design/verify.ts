/**
 * The Bedrock-style quality gate: verification, not construction.
 *
 * Ports Project Bedrock's (github.com/Zhihong0321/project-bedrock) three-tier
 * model onto this repo's own tools instead of vendoring its pipeline: Google
 * PageSpeed Insights for the real Lighthouse scoring engine — already wired in
 * src/enrich/pageinsight.ts to benchmark prospects' sites, so a generated site is
 * measured on the exact same instrument a client would re-run — axe-core for
 * WCAG, and a plain structural pass for what Lighthouse only partially covers
 * (h1 count, canonical, JSON-LD syntax).
 *
 *   Hard gates — binary. 0 axe violations; one <h1> + landmarks; unique
 *                title/description/canonical; reflows to 320px; valid JSON-LD
 *                if present.
 *   Floors     — good, not perfect. Performance >=90, A11y/BP/SEO >=95 (mobile),
 *                LCP<2.5s, CLS<0.1, TBT<200ms.
 *   Reported   — advisory, blocks nothing. Exact scores, transfer weight, requests.
 *
 * One Bedrock hard gate is deliberately absent: security headers. That check
 * assumes you own the server; sites here publish to a third-party host
 * (host.ts) with no header control, so it is left out rather than faked as a
 * pass — see optimize.ts's own note on the same boundary.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'patchright';
import { runPageInsight } from '../enrich/pageinsight.js';
import type { PageInsightIntel } from '../enrich/types.js';
import type { Violation } from './blueprint.js';

const require = createRequire(import.meta.url);

const PERF_FLOOR = 90;
const A11Y_FLOOR = 95;
const LCP_FLOOR_MS = 2_500;
const CLS_FLOOR = 0.1;
const TBT_FLOOR_MS = 200;

export interface StructuralFacts {
  h1Count: number;
  hasMain: boolean;
  hasHeader: boolean;
  hasFooter: boolean;
  title: string;
  description: string;
  canonical: string;
  jsonLdCount: number;
  jsonLdValid: boolean;
  jsonLdError: string;
  axeViolations: { id: string; impact: string | null; help: string; nodes: number }[];
}

export interface VerifyResult {
  pass: boolean;
  hardGateViolations: Violation[];
  floorViolations: Violation[];
  psi: PageInsightIntel;
  structural: StructuralFacts;
  reflowRatio320: number;
  reported: {
    performance: number | null;
    accessibility: number | null;
    bestPractices: number | null;
    seo: number | null;
    lcpMs: number | null;
    clsScore: number | null;
    tbtMs: number | null;
    transferBytes: number | null;
    requests: number | null;
    axeViolations: number;
  };
}

/**
 * IIFE source as a STRING, not a function reference. tsx compiles this file via
 * esbuild with keepNames, which rewrites function expressions to call a
 * `__name` helper that exists only in the compiled module — Playwright
 * serialises a function reference with `.toString()`, so that helper call
 * would ship into the browser and die with `__name is not defined`. A string
 * passed to `page.evaluate` runs as-is and never passes through esbuild. Same
 * defect and same fix as src/enrich/pageinsight.ts:314 and
 * src/design/intake.ts:76.
 */
const STRUCTURAL_SCRIPT = `(async () => {
  const h1Count = document.querySelectorAll('h1').length;
  const hasMain = !!document.querySelector('main');
  const hasHeader = !!document.querySelector('header');
  const hasFooter = !!document.querySelector('footer');
  const title = (document.title || '').trim();
  const descMeta = document.querySelector('meta[name="description"]');
  const description = descMeta ? (descMeta.getAttribute('content') || '').trim() : '';
  const canonicalLink = document.querySelector('link[rel="canonical"]');
  const canonical = canonicalLink ? (canonicalLink.getAttribute('href') || '') : '';
  const jsonLdBlocks = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
    .map((s) => s.textContent || '');
  let jsonLdValid = true;
  let jsonLdError = '';
  for (const block of jsonLdBlocks) {
    if (!block.trim()) continue;
    try { JSON.parse(block); } catch (e) { jsonLdValid = false; jsonLdError = String(e); break; }
  }
  let axeViolations = [];
  if (window.axe) {
    const result = await window.axe.run();
    axeViolations = result.violations.map((v) => ({
      id: v.id,
      impact: v.impact || null,
      help: v.help,
      nodes: v.nodes.length,
    }));
  }
  return {
    h1Count, hasMain, hasHeader, hasFooter, title, description, canonical,
    jsonLdCount: jsonLdBlocks.length, jsonLdValid, jsonLdError, axeViolations,
  };
})()`;

let axeSourceCache: string | null = null;

/** axe-core's own minified bundle, read once and injected as a plain <script>. */
function axeSource(): string {
  if (axeSourceCache) return axeSourceCache;
  axeSourceCache = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  return axeSourceCache;
}

async function measureStructural(url: string): Promise<StructuralFacts> {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
    await page.addScriptTag({ content: axeSource() });
    return (await page.evaluate(STRUCTURAL_SCRIPT)) as StructuralFacts;
  } finally {
    await browser.close();
  }
}

/** Reflows to 320px, the narrowest width Bedrock's floor names, with no horizontal scroll. */
async function measureReflow320(url: string): Promise<number> {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const ctx = await browser.newContext({ viewport: { width: 320, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
    await page.waitForTimeout(400);
    const ratio = await page.evaluate(
      `Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0) / document.documentElement.clientWidth`,
    );
    return ratio as number;
  } finally {
    await browser.close();
  }
}

/**
 * The hard-gate and floor violations, computed from already-measured facts.
 * Pure — no I/O — so it is the cheap, testable half of the gate; `verify()`
 * below is the half that goes and gets the facts.
 */
export function gateFrom(
  psi: PageInsightIntel,
  structural: StructuralFacts,
  reflowRatio320: number,
): { hardGateViolations: Violation[]; floorViolations: Violation[] } {
  const hard: Violation[] = [];
  const floor: Violation[] = [];

  if (structural.axeViolations.length > 0) {
    hard.push({
      field: 'axe',
      problem: `${structural.axeViolations.length} axe violation(s): ${structural.axeViolations
        .map((v) => `${v.id} (${v.nodes} node${v.nodes === 1 ? '' : 's'})`)
        .join(', ')}.`,
      fix: `Fix each named rule. Highest first: ${structural.axeViolations[0]?.help ?? ''}`,
    });
  }
  if (structural.h1Count !== 1) {
    hard.push({
      field: 'structure.h1',
      problem: `Page has ${structural.h1Count} <h1> elements; must be exactly 1.`,
      fix: structural.h1Count === 0 ? 'Add one <h1> naming the page.' : 'Demote every extra <h1> to <h2> or lower.',
    });
  }
  const missingLandmarks = [
    !structural.hasHeader && 'header',
    !structural.hasMain && 'main',
    !structural.hasFooter && 'footer',
  ].filter((x): x is string => !!x);
  if (missingLandmarks.length) {
    hard.push({
      field: 'structure.landmarks',
      problem: `Missing semantic landmark(s): ${missingLandmarks.join(', ')}.`,
      fix: `Wrap the corresponding region in <${missingLandmarks[0]}>.`,
    });
  }
  if (!structural.title || structural.title.length < 10) {
    hard.push({
      field: 'structure.title',
      problem: `<title> is missing or too short ("${structural.title}").`,
      fix: 'Write a unique, descriptive <title>, 10-65 characters.',
    });
  }
  if (!structural.description || structural.description.length < 50) {
    hard.push({
      field: 'structure.description',
      problem: `Meta description is missing or too short (${structural.description.length} chars).`,
      fix: 'Add <meta name="description" content="..."> with 50-165 characters.',
    });
  }
  if (!structural.canonical) {
    hard.push({
      field: 'structure.canonical',
      problem: 'No <link rel="canonical"> on the page.',
      fix: 'Add <link rel="canonical" href="https://<domain>/..."> pointing at the page\'s own published URL.',
    });
  }
  if (structural.jsonLdCount > 0 && !structural.jsonLdValid) {
    hard.push({
      field: 'structure.jsonld',
      problem: `A <script type="application/ld+json"> block does not parse: ${structural.jsonLdError}`,
      fix: 'Fix the JSON syntax, or remove the block if no structured data is intended.',
    });
  }
  if (reflowRatio320 > 1.02) {
    hard.push({
      field: 'structure.reflow320',
      problem: `The page is ${Math.round((reflowRatio320 - 1) * 100)}% wider than a 320px viewport, so it scrolls sideways.`,
      fix: 'Find the element exceeding 320px width; apply max-width:100% or let it wrap.',
    });
  }

  const perf = psi.scores.performance;
  if (perf != null && perf < PERF_FLOOR) {
    floor.push({
      field: 'lighthouse.performance',
      problem: `Lighthouse Performance (mobile) is ${perf}, below the floor of ${PERF_FLOOR}.`,
      fix:
        psi.opportunities[0]
          ? `Biggest opportunity: ${psi.opportunities[0].title} — ${psi.opportunities[0].detail}`
          : 'Reduce transfer weight and blocking scripts; see the reported metrics.',
    });
  }
  for (const [key, label] of [
    ['accessibility', 'Accessibility'],
    ['bestPractices', 'Best Practices'],
    ['seo', 'SEO'],
  ] as const) {
    const score = psi.scores[key];
    if (score != null && score < A11Y_FLOOR) {
      floor.push({
        field: `lighthouse.${key}`,
        problem: `Lighthouse ${label} is ${score}, below the floor of ${A11Y_FLOOR}.`,
        fix: `Open the ${label} audit in PageSpeed Insights for the specific failing checks.`,
      });
    }
  }
  if (psi.metrics.lcpMs != null && psi.metrics.lcpMs >= LCP_FLOOR_MS) {
    floor.push({
      field: 'vitals.lcp',
      problem: `LCP is ${(psi.metrics.lcpMs / 1000).toFixed(1)}s, at or above the 2.5s floor.`,
      fix: 'Preload and set fetchpriority="high" on the largest above-the-fold image; compress it to WebP/AVIF.',
    });
  }
  if (psi.metrics.clsScore != null && psi.metrics.clsScore >= CLS_FLOOR) {
    floor.push({
      field: 'vitals.cls',
      problem: `CLS is ${psi.metrics.clsScore}, at or above the 0.1 floor.`,
      fix: 'Set explicit width/height (or aspect-ratio) on every image and embed; reserve space for web fonts.',
    });
  }
  if (psi.metrics.tbtMs != null && psi.metrics.tbtMs >= TBT_FLOOR_MS) {
    floor.push({
      field: 'vitals.tbt',
      problem: `Total Blocking Time is ${psi.metrics.tbtMs}ms, at or above the 200ms floor.`,
      fix: 'Defer or remove blocking JavaScript; split long tasks.',
    });
  }

  return { hardGateViolations: hard, floorViolations: floor };
}

/** Serve, measure, gate. Writes scores.json into outDir and returns the full result. */
export async function verify(url: string, outDir: string): Promise<VerifyResult> {
  fs.mkdirSync(outDir, { recursive: true });

  const [psi, structural, reflowRatio320] = await Promise.all([
    runPageInsight(url, { strategy: 'mobile' }),
    measureStructural(url),
    measureReflow320(url),
  ]);

  const { hardGateViolations, floorViolations } = gateFrom(psi, structural, reflowRatio320);

  const result: VerifyResult = {
    pass: hardGateViolations.length === 0 && floorViolations.length === 0,
    hardGateViolations,
    floorViolations,
    psi,
    structural,
    reflowRatio320,
    reported: {
      performance: psi.scores.performance,
      accessibility: psi.scores.accessibility,
      bestPractices: psi.scores.bestPractices,
      seo: psi.scores.seo,
      lcpMs: psi.metrics.lcpMs,
      clsScore: psi.metrics.clsScore,
      tbtMs: psi.metrics.tbtMs,
      transferBytes: psi.metrics.transferBytes,
      requests: psi.metrics.requests,
      axeViolations: structural.axeViolations.length,
    },
  };

  fs.writeFileSync(path.join(outDir, 'scores.json'), JSON.stringify(result, null, 2));
  return result;
}

/** The violations as the instruction set the building model gets back — Bedrock's own framing. */
export function asVerifyFixBrief(result: VerifyResult): string {
  const lines = [
    `A Bedrock-style quality gate measured the live page against real PageSpeed Insights ` +
      `and axe-core scores. These are measured facts, not opinions.`,
  ];
  if (result.hardGateViolations.length) {
    lines.push('', 'HARD GATES (ship-blockers — fix every one):');
    result.hardGateViolations.forEach((v, i) => lines.push(`${i + 1}. [${v.field}] ${v.problem}\n   Fix: ${v.fix}`));
  }
  if (result.floorViolations.length) {
    lines.push('', 'FLOORS (below the "good, not perfect" bar):');
    result.floorViolations.forEach((v, i) => lines.push(`${i + 1}. [${v.field}] ${v.problem}\n   Fix: ${v.fix}`));
  }
  lines.push(
    '',
    `Reported for context: Performance ${result.reported.performance}, Accessibility ${result.reported.accessibility}, ` +
      `Best Practices ${result.reported.bestPractices}, SEO ${result.reported.seo} ` +
      `(Lighthouse mobile, via PageSpeed Insights).`,
    '',
    'Edit the existing files in place. Do not start over, and do not restate the brief back to me.',
  );
  return lines.join('\n');
}
