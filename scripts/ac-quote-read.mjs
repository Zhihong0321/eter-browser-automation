// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
// 1) read the atap calculator quote  2) dump the live AutoCount New-Quotation form
import { chromium } from 'patchright';

const QUOTE = 'https://calculator.atap.solar/view/a358592533bec1e0d9729c7f3eeb8302fa0285636a4fb8d4e4fb5a4948e31410?layout=a4&mono=1';

const ctx = await chromium.launchPersistentContext('E:\\eter-browser\\profiles\\agent', {
  channel: 'chrome', headless: false, args: ['--no-sandbox'],
  viewport: null, ignoreDefaultArgs: ['--enable-automation'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

try {
  console.log('step: goto quote');
  await page.goto(QUOTE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(4000);
  console.log('IN:', page.url(), '|', await page.title());
  await page.screenshot({ path: 'scripts/ac-quote-read.png', fullPage: true });

  const txt = await page.evaluate(() => document.body.innerText);
  console.log('\n=========== QUOTE TEXT ===========');
  console.log(txt);
  console.log('=========== END QUOTE ===========\n');

  const tbls = await page.evaluate(() =>
    [...document.querySelectorAll('table')].map((t) =>
      [...t.querySelectorAll('tr')].map((r) => [...r.querySelectorAll('td,th')].map((c) => c.innerText.trim().replace(/\s+/g, ' ')).join(' | ')),
    ),
  );
  console.log('--- TABLES ---');
  tbls.forEach((t, i) => { console.log(` table ${i}:`); t.forEach((r) => console.log('   ', r)); });

  console.log('\nstep: autocount root');
  await page.goto('https://accounting.autocountcloud.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  await page.locator('body>div>div>div>div:nth-of-type(2)>div:nth-of-type(4)>div>div>div:nth-of-type(6)>div>div>div>div>table>tbody>tr:nth-of-type(1)>td:nth-of-type(1)>button').click();
  await page.waitForTimeout(9000);

  console.log('step: /quotation -> New');
  await page.goto('https://accounting.autocountcloud.com/quotation', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  await page.getByRole('button', { name: /New/i }).first().click();
  await page.waitForTimeout(9000);
  console.log('IN:', page.url());
  await page.screenshot({ path: 'scripts/ac-quote-newform.png', fullPage: true });

  const form = await page.evaluate(() => {
    const lab = (el) => {
      let n = el.closest('div');
      for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
        const l = n.querySelector('label');
        if (l && l.innerText.trim()) return l.innerText.trim();
      }
      return el.getAttribute('placeholder') || el.getAttribute('name') || '?';
    };
    const inputs = [...document.querySelectorAll('input,textarea,select')].map((el) => ({
      label: lab(el), tag: el.tagName, type: el.type || '', ro: el.readOnly || false,
      cls: (el.className || '').slice(0, 60), val: (el.value || '').slice(0, 30),
    }));
    const btns = [...document.querySelectorAll('button')].map((b) => b.innerText.trim()).filter(Boolean);
    return { inputs, btns, hasGrid: !!document.querySelector('.dx-datagrid,.dx-treelist') };
  });
  console.log('\n--- NEW QUOTATION FORM: inputs', form.inputs.length, '---');
  form.inputs.forEach((i, n) => console.log(`  [${n}] ${i.label} :: ${i.tag}/${i.type} ro=${i.ro} val="${i.val}" cls=${i.cls}`));
  console.log('\n--- BUTTONS ---\n ', JSON.stringify(form.btns.slice(0, 30)));
  console.log('  line-item grid present:', form.hasGrid);
} catch (e) {
  console.log('\nTHREW at:', page.url());
  await page.screenshot({ path: 'scripts/ac-quote-crash.png' });
  console.log(String(e).slice(0, 400));
}

await ctx.close();
