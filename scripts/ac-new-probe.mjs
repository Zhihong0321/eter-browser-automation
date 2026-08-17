// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
// Why does clicking "New" on /invoice not open a form? Look, don't theorise.
import fs from 'node:fs';
import { chromium } from 'patchright';

const ctx = await chromium.launchPersistentContext('E:\\eter-browser\\profiles\\agent', {
  channel: 'chrome', headless: false, args: ['--no-sandbox'],
  viewport: null, ignoreDefaultArgs: ['--enable-automation'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

console.log('step: goto');
await page.goto('https://accounting.autocountcloud.com/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
if (!page.url().includes('/dashboard')) {
  const prev = JSON.parse(fs.readFileSync('scripts/autocount.map.json', 'utf8'));
  await page.locator(prev.find((e) => /^macam yes$/i.test(e.name.trim())).selector).click();
  await page.waitForTimeout(9000);
}
console.log('step: to /invoice');
await page.locator('a[href="/invoice"]').first().evaluate((el) => el.click());
await page.waitForTimeout(5000);
console.log('  at', page.url());

const NEWISH = () => [...document.querySelectorAll('button,a,[role=button]')]
  .map((el) => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 24),
      cls: (el.className.baseVal ?? el.className ?? '').toString().slice(0, 46),
      href: el.getAttribute('href') || '',
      box: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
      vis: r.width > 2 && r.height > 2,
    };
  })
  .filter((b) => /new|add|create/i.test(b.text) || /new|add|create/i.test(b.cls) || /new|add|create/i.test(b.href));

console.log('\n--- anything New-ish on /invoice ---');
for (const b of await page.evaluate(NEWISH)) console.log(' ', JSON.stringify(b));

const count = () => page.evaluate(() => document.querySelectorAll('input:not([type=hidden]),select,textarea').length);
console.log('\nbefore: url', page.url(), '| inputs', await count());

// Try each way of clicking it and report which one actually changes the page.
for (const [how, fn] of [
  ['locator .click()', async () => page.locator('button', { hasText: /^\s*New\s*$/ }).first().click({ timeout: 5000 })],
  ['DOM el.click()', async () => page.locator('button', { hasText: /^\s*New\s*$/ }).first().evaluate((el) => el.click())],
  ['getByRole button', async () => page.getByRole('button', { name: 'New', exact: true }).first().click({ timeout: 5000 })],
]) {
  const before = { url: page.url(), n: await count() };
  try { await fn(); } catch (e) { console.log(`  ${how.padEnd(18)} THREW ${String(e.message).split('\n')[0].slice(0, 60)}`); continue; }
  await page.waitForTimeout(5000);
  const after = { url: page.url(), n: await count() };
  console.log(`  ${how.padEnd(18)} url ${before.url.split('.com')[1]} -> ${after.url.split('.com')[1]} | inputs ${before.n} -> ${after.n}`);
  if (after.url !== before.url || after.n > before.n + 3) {
    await page.screenshot({ path: 'scripts/ac-new-probe.png' });
    console.log('  ^^ THIS ONE OPENED SOMETHING. screenshot: scripts/ac-new-probe.png');
    const f = await page.evaluate(() => [...document.querySelectorAll('input:not([type=hidden]),select,textarea')]
      .filter((el) => el.offsetParent).slice(0, 30)
      .map((el) => `${el.tagName.toLowerCase()}[${el.type || ''}] ${(el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('aria-label') || '').slice(0, 30)}`));
    console.log('  fields:', JSON.stringify(f, null, 1));
    break;
  }
}
await ctx.close();
