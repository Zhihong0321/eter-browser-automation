/**
 * Screenshots of a live page, at the viewports a designer actually checks.
 *
 * Deliberately a PLAIN headless browser, not the session vault's Chrome
 * (src/browser.ts). That one owns one persistent profile per id and carries the
 * user's logins — borrowing it here would fight a running harvest for the
 * profile lock and point real cookies at a page under review. Published pages
 * are public; they need no session at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'patchright';

export interface Viewport {
  name: string;
  width: number;
  height: number;
  mobile: boolean;
}

/** Two viewports, not five: each one costs a model call to review. */
export const VIEWPORTS: Viewport[] = [
  { name: 'mobile', width: 375, height: 812, mobile: true },
  { name: 'desktop', width: 1440, height: 900, mobile: false },
];

export interface Shot {
  viewport: string;
  file: string;
  /** Page width vs viewport width. Anything over 1 means a horizontal scrollbar. */
  overflowRatio: number;
  consoleErrors: string[];
  /**
   * Visible text length. A revision that guts the page shows up here as a
   * collapse, which no screenshot review reliably catches — measured
   * 2026-08-17, a round that emptied three whole sections still scored 53/100.
   */
  textLength: number;
}

/**
 * Render `url` at each viewport into `outDir`.
 *
 * The overflow measurement is taken here rather than left to the vision model:
 * a page 3px too wide is a real defect that a screenshot cannot show, because
 * the screenshot is captured at the page's own width.
 */
export async function shoot(url: string, outDir: string, viewports = VIEWPORTS): Promise<Shot[]> {
  fs.mkdirSync(outDir, { recursive: true });
  // channel:'chrome' uses the Chrome already installed on the machine, the same
  // one src/browser.ts launches. Without it patchright wants its own bundled
  // headless shell, which this repo never downloads — measured: the whole run
  // died at the first screenshot with "Executable doesn't exist".
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const shots: Shot[] = [];

  try {
    for (const vp of viewports) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        isMobile: vp.mobile,
        hasTouch: vp.mobile,
        deviceScaleFactor: 1,
      });
      const page = await ctx.newPage();
      const consoleErrors: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
      });
      page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 200)));

      try {
        // 'load' not 'networkidle': a page with a poll or a live socket never
        // goes idle, and the whole run would hang on the timeout instead.
        await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
        // Fonts and any entry animation settle in well under this.
        await page.waitForTimeout(1200);

        const measured = await page.evaluate(() => {
          const d = document.documentElement;
          return {
            overflowRatio: Math.max(d.scrollWidth, document.body?.scrollWidth ?? 0) / d.clientWidth,
            textLength: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().length,
          };
        });

        const file = path.join(outDir, `${vp.name}.png`);
        await page.screenshot({ path: file, fullPage: true });
        shots.push({ viewport: vp.name, file, consoleErrors, ...measured });
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
  }

  return shots;
}
