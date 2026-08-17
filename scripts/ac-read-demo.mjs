// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
// AutoCount grids are DevExtreme TreeList: 4 stacked <table>s, only one holds data,
// the others are pointer-events-none overlay clones. Take the one with the most rows.
import { chromium } from 'patchright';

const TABLES = ['/account', '/currency', '/paymentmethod', '/journaltype', '/creditterm'];

const ctx = await chromium.launchPersistentContext('E:\\eter-browser\\profiles\\agent', {
  channel: 'chrome', headless: false, args: ['--no-sandbox'],
  viewport: null, ignoreDefaultArgs: ['--enable-automation'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

try {
  console.log('step: goto root');
  await page.goto('https://accounting.autocountcloud.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  console.log('step: pick company');
  await page.locator('body>div>div>div>div:nth-of-type(2)>div:nth-of-type(4)>div>div>div:nth-of-type(6)>div>div>div>div>table>tbody>tr:nth-of-type(1)>td:nth-of-type(1)>button').click();
  await page.waitForTimeout(9000);

  for (const t of TABLES) {
    console.log(`\nstep: goto ${t}`);
    await page.goto('https://accounting.autocountcloud.com' + t, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(8000);

    const g = await page.evaluate(() => {
      const headers = [...document.querySelectorAll('.dx-header-row td, .dx-header-row th')]
        .map((h) => h.innerText.trim()).filter(Boolean);
      const tbl = [...document.querySelectorAll('table')]
        .sort((a, b) => b.querySelectorAll('tr.dx-data-row').length - a.querySelectorAll('tr.dx-data-row').length)[0];
      const rows = [...(tbl?.querySelectorAll('tr.dx-data-row') || [])].map((r) => ({
        lvl: +(r.getAttribute('aria-level') || 1),
        cells: [...r.querySelectorAll('td')]
          .map((c) => c.innerText.replace(/\u00a0/g, '').replace(/\s+/g, ' ').trim())
          .filter((s) => s && s !== 'Edit' && !s.startsWith('Edit Toggle')),
      })).filter((r) => r.cells.length);
      const pager = (document.body.innerText.match(/Page \d+ of \d+ \([\d,]+ items?\)/) || ['no pager'])[0];
      return { headers, rows, pager };
    });

    console.log(`  ${t}  ${g.pager}`);
    console.log('  cols:', g.headers.join(' | ') || '(none)');
    for (const r of g.rows.slice(0, 12)) console.log('    ' + '  '.repeat(r.lvl - 1) + r.cells.join('  ·  ').slice(0, 120));
    if (g.rows.length > 12) console.log(`     ... +${g.rows.length - 12} more`);
  }
} catch (e) {
  console.log('\nTHREW at:', page.url());
  await page.screenshot({ path: 'scripts/ac-read-demo-crash.png' });
  console.log(String(e).slice(0, 400));
}

await ctx.close();
