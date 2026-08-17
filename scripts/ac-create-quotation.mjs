// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
// Quotation INV-1010865 (ah MAO, RM29,990) into AutoCount.
// Learned the hard way:
//   modal is bootstrap .modal.show, NOT .dx-overlay-content
//   three .dx-datagrid on the page; the line grid is the one with "Total (inc)"
//   it opens with one blank row already there — fill it, don't add one
//   Date inputs are readOnly -> must drive the dx calendar popup
import { chromium } from 'patchright';

const AC = 'https://accounting.autocountcloud.com';
const DESC =
  '16X 650W JinkoSolar TIGER NEO 3.0 Panel N-Type TOPCon; 1X [3P] SAJ R6 8KW String Inverter; SEDA ATAP Application; TNB Smart Meter Application; design, survey, roof + electrical installation (ref INV-1010865)';
const PRICE = '29990';

const ctx = await chromium.launchPersistentContext('E:\\eter-browser\\profiles\\agent', {
  channel: 'chrome', headless: false, args: ['--no-sandbox'],
  viewport: null, ignoreDefaultArgs: ['--enable-automation'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

const byLabel = (label) =>
  page.locator(`xpath=//label[normalize-space(.)="${label}"]/following::input[not(@type="hidden")][1]`).first();

try {
  console.log('step: autocount + company');
  await page.goto(AC + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  await page.locator('body>div>div>div>div:nth-of-type(2)>div:nth-of-type(4)>div>div>div:nth-of-type(6)>div>div>div>div>table>tbody>tr:nth-of-type(1)>td:nth-of-type(1)>button').click();
  await page.waitForTimeout(9000);

  console.log('step: /quotation -> New');
  await page.goto(AC + '/quotation', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  await page.getByRole('button', { name: /New/i }).first().click();
  await page.waitForTimeout(9000);
  const modal = page.locator('.modal.show').first();

  console.log('step: Date -> 20/07/2026 via calendar');
  // input[value=...] matches the ATTRIBUTE; dx only sets the property. Tag it instead.
  // 3 date inputs live inside .modal.show; the first two are list filters that sit UNDER
  // another div, so a click can never land. Take the one that is actually on top of itself.
  await page.evaluate(() => {
    const m = document.querySelector('.modal.show');
    const i = [...m.querySelectorAll('input')]
      .filter((x) => /^\d{2}\/\d{2}\/\d{4}$/.test(x.value))
      .find((x) => {
        const r = x.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return top && (top === x || x.contains(top));
      });
    i.id = 'agent-date';
  });
  const dateInp = page.locator('#agent-date');
  await dateInp.click();
  await page.waitForTimeout(2000);
  await page.locator('.dx-calendar-navigator-previous-view').first().click(); // Aug -> Jul
  await page.waitForTimeout(1500);
  await page.locator('.dx-calendar-cell:not(.dx-calendar-other-view)').filter({ hasText: /^20$/ }).first().click();
  await page.waitForTimeout(2000);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);
  console.log('  date now:', await dateInp.inputValue().catch(() => '?'));

  console.log('step: Customer = 300-A001');
  await byLabel('Customer').click();
  await page.waitForTimeout(2000);
  await page.keyboard.type('300-A001');
  await page.waitForTimeout(2500);
  await page.locator('.dx-list-item, .dx-item-content, .dx-dropdowneditor-overlay tr.dx-data-row')
    .filter({ hasText: 'AH MAO' }).first().click();
  await page.waitForTimeout(3000);
  console.log('  customer:', await byLabel('Customer').inputValue());
  console.log('  date still:', await dateInp.inputValue().catch(() => '?'));

  console.log('step: line row');
  const grid = modal.locator('.dx-datagrid').filter({ hasText: 'Total (inc)' }).first();
  const heads = (await grid.locator('.dx-header-row td').allInnerTexts()).map((h) => h.replace(/\s+/g, ' ').trim());
  console.log('  cols:', JSON.stringify(heads));
  const row = grid.locator('tr.dx-data-row').first();

  const editCell = async (colName, value) => {
    const i = heads.findIndex((h) => h.toLowerCase() === colName.toLowerCase());
    const cell = row.locator('td').nth(i);
    await cell.click();
    await page.waitForTimeout(1000);
    let n = await cell.locator('input.dx-texteditor-input, textarea').count();
    if (!n) { await cell.dblclick(); await page.waitForTimeout(1000); n = await cell.locator('input.dx-texteditor-input, textarea').count(); }
    console.log(`  cell "${colName}" col=${i} editor=${n}`);
    await page.keyboard.type(value);
    await page.waitForTimeout(700);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(1800);
  };

  await editCell('Description', DESC);
  await editCell('Unit Price', PRICE);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'scripts/ac-quo-filled.png', fullPage: true });

  const state = await page.evaluate(() => {
    const m = document.querySelector('.modal.show');
    const g = [...m.querySelectorAll('.dx-datagrid')].find((x) => x.innerText.includes('Total (inc)'));
    return {
      header: m.innerText.split('\n').slice(0, 3).join(' | '),
      row0: [...g.querySelectorAll('tr.dx-data-row td')].map((c) => c.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean),
      totals: (m.innerText.match(/Subtotal \(ex\)[\s\S]{0,60}/) || [''])[0].replace(/\s+/g, ' '),
    };
  });
  console.log('\n  BEFORE SAVE:', JSON.stringify(state, null, 1));

  console.log('\nstep: SAVE');
  await modal.getByRole('button', { name: /^\s*Save\s*$/i }).first().click();
  await page.waitForTimeout(11000);
  await page.screenshot({ path: 'scripts/ac-quo-saved.png', fullPage: true });
  console.log('  modal still open:', await page.locator('.modal.show').count());

  console.log('step: verify /quotation grid');
  await page.goto(AC + '/quotation', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  const g = await page.evaluate(() => {
    const headers = [...document.querySelectorAll('.dx-header-row td')].map((c) => c.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const tbl = [...document.querySelectorAll('table')].sort(
      (a, b) => b.querySelectorAll('tr.dx-data-row').length - a.querySelectorAll('tr.dx-data-row').length)[0];
    const rows = [...(tbl?.querySelectorAll('tr.dx-data-row') || [])].map((r) =>
      [...r.querySelectorAll('td')].map((c) => c.innerText.replace(/\u00a0/g, '').trim()).filter(Boolean).join('  ·  '));
    return { headers, rows, pager: (document.body.innerText.match(/Page \d+ of \d+ \([\d,]+ items?\)/) || ['?'])[0] };
  });
  console.log('  ' + g.pager);
  console.log('  cols:', g.headers.join(' | '));
  g.rows.forEach((r) => console.log('    ', r));
} catch (e) {
  console.log('\nTHREW at:', page.url());
  await page.screenshot({ path: 'scripts/ac-quo-crash.png', fullPage: true });
  console.log(String(e).slice(0, 400));
}

await ctx.close();
