// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
// FIRST EVER WRITE to AutoCount. Customer "AH MAO" from quote INV-1010865.
// Quotation needs a debtor to point at and /debtor has 0 rows, so this comes first.
import { chromium } from 'patchright';

const AC = 'https://accounting.autocountcloud.com';
// modal is tabbed: Account / General / Others / Note. Hidden-tab inputs exist in the
// DOM but can't be clicked, so the tab has to be opened first.
const WANT = [
  ['Account', 'Customer Code', '300-A001'],
  ['Account', 'Company Name', 'AH MAO'],
  ['General', 'Phone', '60123334442'],
];

const ctx = await chromium.launchPersistentContext('E:\\eter-browser\\profiles\\agent', {
  channel: 'chrome', headless: false, args: ['--no-sandbox'],
  viewport: null, ignoreDefaultArgs: ['--enable-automation'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

try {
  console.log('step: autocount + company');
  await page.goto(AC + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  await page.locator('body>div>div>div>div:nth-of-type(2)>div:nth-of-type(4)>div>div>div:nth-of-type(6)>div>div>div>div>table>tbody>tr:nth-of-type(1)>td:nth-of-type(1)>button').click();
  await page.waitForTimeout(9000);

  console.log('step: /debtor -> New');
  await page.goto(AC + '/debtor', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  await page.getByRole('button', { name: /New/i }).first().click();
  await page.waitForTimeout(8000);
  await page.screenshot({ path: 'scripts/ac-cust-form.png', fullPage: true });

  const dump = await page.evaluate(() =>
    [...document.querySelectorAll('label')]
      .map((l) => l.innerText.trim())
      .filter(Boolean),
  );
  console.log('--- FORM LABELS ---\n ', JSON.stringify(dump));

  let tab = 'Account'; // Account is the tab the modal opens on
  for (const [wantTab, label, val] of WANT) {
    if (wantTab !== tab) {
      console.log(`tab: ${wantTab}`);
      await page
        .locator(`xpath=//*[self::a or self::li or self::button or self::span][normalize-space(text())="${wantTab}"]`)
        .first()
        .click();
      await page.waitForTimeout(1800);
      tab = wantTab;
    }
    const inp = page
      .locator(`xpath=//label[normalize-space(.)="${label}"]/following::input[not(@type="hidden")][1]`)
      .first();
    const n = await inp.count();
    console.log(`fill "${label}" = "${val}"  (found=${n})`);
    if (!n) continue;
    await inp.click();
    await inp.fill(val);
    await page.waitForTimeout(400);
  }

  await page.screenshot({ path: 'scripts/ac-cust-filled.png', fullPage: true });
  console.log('\nstep: SAVE');
  await page.getByRole('button', { name: /^\s*Save\s*$/i }).first().click();
  await page.waitForTimeout(9000);
  await page.screenshot({ path: 'scripts/ac-cust-saved.png', fullPage: true });
  console.log('after save, url:', page.url());

  const err = await page.evaluate(() => {
    const e = [...document.querySelectorAll('.dx-invalid-message,.invalid-feedback,.text-danger,.toast,.dx-toast-message')]
      .map((x) => x.innerText.trim()).filter(Boolean);
    return e.length ? e : null;
  });
  console.log('validation/toast:', JSON.stringify(err));

  console.log('\nstep: verify /debtor grid');
  await page.goto(AC + '/debtor', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  const g = await page.evaluate(() => {
    const headers = [...document.querySelectorAll('.dx-header-row td')].map((c) => c.innerText.trim()).filter(Boolean);
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
  await page.screenshot({ path: 'scripts/ac-cust-crash.png', fullPage: true });
  console.log(String(e).slice(0, 400));
}

await ctx.close();
