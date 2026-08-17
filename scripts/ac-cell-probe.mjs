// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
// Question: /account says 69 items but td.innerText is empty. Where does the cell text live?
import { chromium } from 'patchright';

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

  console.log('step: goto /account');
  await page.goto('https://accounting.autocountcloud.com/account', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);
  await page.screenshot({ path: 'scripts/ac-cell-probe.png' });

  const d = await page.evaluate(() => {
    const tables = [...document.querySelectorAll('table')].map((t, i) => ({
      i,
      cls: t.className,
      ths: [...t.querySelectorAll('th')].length,
      thText: [...t.querySelectorAll('th')].map((h) => h.innerText.trim()).slice(0, 12),
      trs: t.querySelectorAll('tbody tr').length,
    }));
    const big = [...document.querySelectorAll('table')].sort(
      (a, b) => b.querySelectorAll('tbody tr').length - a.querySelectorAll('tbody tr').length,
    )[0];
    const r0 = big?.querySelector('tbody tr');
    return {
      tables,
      row0html: r0 ? r0.outerHTML.slice(0, 1200) : 'NO ROW',
      row0text: r0 ? JSON.stringify(r0.innerText) : '',
      tdCount: r0 ? r0.querySelectorAll('td').length : 0,
    };
  });
  console.log('\n--- TABLES ---');
  for (const t of d.tables) console.log(' ', JSON.stringify(t));
  console.log('\n--- BIGGEST TABLE, ROW 0 --- tds:', d.tdCount, 'innerText:', d.row0text);
  console.log(d.row0html);
} catch (e) {
  console.log('\nTHREW at:', page.url());
  await page.screenshot({ path: 'scripts/ac-cell-probe-crash.png' });
  console.log(String(e).slice(0, 400));
}

await ctx.close();
