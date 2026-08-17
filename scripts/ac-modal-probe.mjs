// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
// Question: what element IS the quotation modal? Not .dx-overlay-content.
import { chromium } from 'patchright';

const AC = 'https://accounting.autocountcloud.com';
const ctx = await chromium.launchPersistentContext('E:\\eter-browser\\profiles\\agent', {
  channel: 'chrome', headless: false, args: ['--no-sandbox'],
  viewport: null, ignoreDefaultArgs: ['--enable-automation'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

try {
  await page.goto(AC + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  await page.locator('body>div>div>div>div:nth-of-type(2)>div:nth-of-type(4)>div>div>div:nth-of-type(6)>div>div>div>div>table>tbody>tr:nth-of-type(1)>td:nth-of-type(1)>button').click();
  await page.waitForTimeout(9000);
  await page.goto(AC + '/quotation', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  await page.getByRole('button', { name: /New/i }).first().click();
  await page.waitForTimeout(9000);

  const d = await page.evaluate(() => {
    // smallest elements that contain the line-grid header text
    const hits = [...document.querySelectorAll('div')]
      .filter((el) => el.innerText && el.innerText.includes('Product Code') && el.innerText.includes('Proceed New Quotation'))
      .slice(-6)
      .map((el) => ({ cls: el.className.slice(0, 90), id: el.id, kids: el.children.length }));

    const grids = [...document.querySelectorAll('.dx-datagrid')].map((g, i) => ({
      i,
      cls: g.className.slice(0, 70),
      headers: [...g.querySelectorAll('.dx-header-row td')].map((c) => c.innerText.replace(/\s+/g, ' ').trim()),
      dataRows: g.querySelectorAll('tr.dx-data-row').length,
      visible: g.offsetParent !== null,
    }));

    const dates = [...document.querySelectorAll('input')]
      .filter((i) => /^\d{2}\/\d{2}\/\d{4}$/.test(i.value))
      .map((i) => ({ val: i.value, ro: i.readOnly, vis: i.offsetParent !== null, cls: i.className.slice(0, 50) }));

    return { hits, grids, dates };
  });
  console.log('--- CONTAINERS holding the modal text (innermost 6) ---');
  d.hits.forEach((h) => console.log(' ', JSON.stringify(h)));
  console.log('\n--- ALL .dx-datagrid ---');
  d.grids.forEach((g) => console.log(' ', JSON.stringify(g)));
  console.log('\n--- date-looking inputs ---');
  d.dates.forEach((x) => console.log(' ', JSON.stringify(x)));
} catch (e) {
  console.log('THREW:', String(e).slice(0, 300));
}
await ctx.close();
