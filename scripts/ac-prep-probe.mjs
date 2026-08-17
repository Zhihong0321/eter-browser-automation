// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
// 1) full quote text -> file  2) dump the live New-Customer (debtor) form  3) dump quotation line-item grid
import { chromium } from 'patchright';
import fs from 'fs';

const QUOTE = 'https://calculator.atap.solar/view/a358592533bec1e0d9729c7f3eeb8302fa0285636a4fb8d4e4fb5a4948e31410?layout=a4&mono=1';
const AC = 'https://accounting.autocountcloud.com';

const ctx = await chromium.launchPersistentContext('E:\\eter-browser\\profiles\\agent', {
  channel: 'chrome', headless: false, args: ['--no-sandbox'],
  viewport: null, ignoreDefaultArgs: ['--enable-automation'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

const dumpForm = () =>
  page.evaluate(() => {
    const lab = (el) => {
      let n = el.parentElement;
      for (let i = 0; i < 5 && n; i++, n = n.parentElement) {
        const l = n.querySelector('label');
        if (l && l.innerText.trim()) return l.innerText.trim();
      }
      return el.getAttribute('placeholder') || '?';
    };
    const vis = (el) => el.offsetParent !== null || el.type === 'hidden';
    return {
      inputs: [...document.querySelectorAll('input,textarea')].filter(vis).map((el, i) => ({
        i, label: lab(el), tag: el.tagName, type: el.type, ro: el.readOnly,
        dd: !!el.closest('.dx-dropdowneditor,.dx-selectbox,.dx-lookup'),
        val: (el.value || '').slice(0, 24),
      })),
      btns: [...document.querySelectorAll('button')].map((b) => b.innerText.trim()).filter(Boolean),
      tabs: [...document.querySelectorAll('[role=tab],.nav-link')].map((t) => t.innerText.trim()).filter(Boolean),
    };
  });

try {
  console.log('step: quote');
  await page.goto(QUOTE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3500);
  const txt = await page.evaluate(() => document.body.innerText);
  fs.writeFileSync('scripts/quote-INV-1010865.txt', txt);
  console.log('--- QUOTE HEAD (first 70 lines) ---');
  console.log(txt.split('\n').slice(0, 70).join('\n'));

  console.log('\nstep: autocount');
  await page.goto(AC + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  await page.locator('body>div>div>div>div:nth-of-type(2)>div:nth-of-type(4)>div>div>div:nth-of-type(6)>div>div>div>div>table>tbody>tr:nth-of-type(1)>td:nth-of-type(1)>button').click();
  await page.waitForTimeout(9000);

  console.log('step: /debtor -> New');
  await page.goto(AC + '/debtor', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  await page.getByRole('button', { name: /^New$/i }).first().click();
  await page.waitForTimeout(8000);
  await page.screenshot({ path: 'scripts/ac-debtor-newform.png', fullPage: true });
  const d = await dumpForm();
  console.log('\n--- NEW CUSTOMER FORM ---  tabs:', JSON.stringify(d.tabs));
  d.inputs.forEach((i) => console.log(`  [${i.i}] ${i.label} :: ${i.type} ro=${i.ro} dropdown=${i.dd} val="${i.val}"`));
  console.log('  buttons:', JSON.stringify(d.btns.slice(-14)));

  console.log('\nstep: /quotation -> New -> line item grid');
  await page.goto(AC + '/quotation', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  await page.getByRole('button', { name: /^New$/i }).first().click();
  await page.waitForTimeout(9000);
  const grid = await page.evaluate(() => {
    const g = document.querySelector('.dx-datagrid,.dx-treelist');
    if (!g) return 'NO GRID';
    return {
      cols: [...g.querySelectorAll('.dx-header-row td,.dx-header-row th')].map((c) => c.innerText.trim()),
      rows: g.querySelectorAll('tr.dx-data-row').length,
      addBtn: [...g.querySelectorAll('.dx-datagrid-addrow-button,[aria-label*=Add],.dx-icon-add')].map((b) => b.className).slice(0, 4),
      text: g.innerText.replace(/\s+/g, ' ').slice(0, 260),
    };
  });
  console.log(JSON.stringify(grid, null, 1));
} catch (e) {
  console.log('\nTHREW at:', page.url());
  await page.screenshot({ path: 'scripts/ac-prep-crash.png' });
  console.log(String(e).slice(0, 400));
}

await ctx.close();
