// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
// Question: is this AutoCount account empty, or is the lane blind to grid text?
// Sidenav links exist in the DOM but are hidden until the top menu is expanded.
import { chromium } from 'patchright';

const ctx = await chromium.launchPersistentContext('E:\\eter-browser\\profiles\\agent', {
  channel: 'chrome', headless: false, args: ['--no-sandbox'],
  viewport: null, ignoreDefaultArgs: ['--enable-automation'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

try {
  console.log('step: goto');
  await page.goto('https://accounting.autocountcloud.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);

  console.log('step: pick company');
  await page.locator('body>div>div>div>div:nth-of-type(2)>div:nth-of-type(4)>div>div>div:nth-of-type(6)>div>div>div>div>table>tbody>tr:nth-of-type(1)>td:nth-of-type(1)>button').click();
  await page.waitForTimeout(9000);
  console.log('IN:', page.url());

  console.log('step: expand Sales menu');
  await page.getByText('Sales', { exact: true }).first().click();
  await page.waitForTimeout(2000);

  console.log('step: click Invoice');
  await page.click('a[href="/invoice"]');
  await page.waitForTimeout(9000);
  console.log('IN:', page.url(), '|', await page.title());
  await page.screenshot({ path: 'scripts/ac-grid-probe-invoice.png' });

  const grid = await page.evaluate(() => {
    const tables = [...document.querySelectorAll('table')].map((t) => ({
      headers: [...t.querySelectorAll('th')].map((h) => h.innerText.trim()).filter(Boolean),
      rows: t.querySelectorAll('tbody tr').length,
      rowText: [...t.querySelectorAll('tbody tr')].slice(0, 3).map((r) => r.innerText.trim().replace(/\s+/g, ' ').slice(0, 90)),
    }));
    const btns = [...document.querySelectorAll('button')]
      .map((b) => (b.innerText || b.getAttribute('title') || b.getAttribute('aria-label') || '').trim())
      .filter(Boolean);
    return { tables, btns, body: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 500) };
  });
  console.log('\n--- INVOICE TABLES', grid.tables.length, '---');
  for (const t of grid.tables) console.log('  headers:', JSON.stringify(t.headers), '\n  rows:', t.rows, t.rowText);
  console.log('\n--- NAMED BUTTONS', grid.btns.length, '---\n ', JSON.stringify(grid.btns.slice(0, 25)));
  console.log('\n--- BODY ---\n', grid.body);
} catch (e) {
  console.log('\nTHREW at:', page.url());
  await page.screenshot({ path: 'scripts/ac-grid-probe-crash.png' });
  console.log(String(e).slice(0, 300));
}

await ctx.close();
