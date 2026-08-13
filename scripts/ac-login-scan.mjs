// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
//
// Proven flow: fill email (Chrome autofills the password), click Log in, click
// the company, land on /dashboard — then run the recon scan on THAT SAME page,
// so the token the app just issued is the token the crawl uses.

import { chromium } from 'patchright';
import { scanSite, formatScan } from '../dist/recon-scan.js';

const EMAIL = 'zhihong@eternalgy.me';
const COMPANY = 'Macam Yes';
const ROOT = 'https://accounting.autocountcloud.com/dashboard';
const OUT = 'E:\\eter-browser\\tools\\accounting.autocountcloud.com\\recon';

const ctx = await chromium.launchPersistentContext('E:\\eter-browser\\profiles\\agent', {
  channel: 'chrome', headless: false, args: ['--no-sandbox'],
  viewport: null, ignoreDefaultArgs: ['--enable-automation'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.log('  nav ->', f.url().slice(0, 95)); });

try {
  console.log('step: goto');
  await page.goto('https://accounting.autocountcloud.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);

  if (page.url().includes('auth.autocountcloud.com')) {
    // The blue "Log in" bar has NO accessible name — zero <button> elements on the
    // page and every input[type=submit] has an empty value. Enter submits the form.
    // See docs/STUPID-MISTAKE-LOG.md, 2026-08-13.
    console.log('step: login (Enter in password field)');
    await page.locator('input[type=text]').first().fill(EMAIL);
    await page.locator('input[type=password]').first().press('Enter');
    await page.waitForTimeout(10000);
  }

  if ((await page.title()).includes('Select Company')) {
    console.log('step: pick', COMPANY);
    await page.getByText(COMPANY, { exact: false }).first().click();
    await page.waitForTimeout(10000);
  }

  console.log('IN:', page.url(), '|', await page.title());

  console.log('step: scan');
  const scan = await scanSite(ctx, page, ROOT, OUT, { maxPages: 25, windowMs: 8000, quietMs: 2000, approved: [] });
  console.log(formatScan(scan));
} catch (err) {
  console.error('DIED at', page.url(), '\n', err.message);
  await page.screenshot({ path: 'E:\\eter-browser\\tools\\ac-crash.png' }).catch(() => {});
} finally {
  await ctx.close();
}
