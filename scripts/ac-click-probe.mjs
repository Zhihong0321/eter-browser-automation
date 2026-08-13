// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
//
// Fill the email (Chrome already autofilled the password), tick Remember me so
// the cookie survives Chrome closing, click Log in — then click "Macam Yes" and
// log everything, because a human click lands on the dashboard and a scripted
// click lands on a blank page.

import { chromium } from 'patchright';

const EMAIL = 'zhihong@eternalgy.me';
const COMPANY = 'Macam Yes';
const SHOTS = 'E:\\eter-browser\\tools\\';

const ctx = await chromium.launchPersistentContext('E:\\eter-browser\\profiles\\agent', {
  channel: 'chrome', headless: false, args: ['--no-sandbox'],
  viewport: null, ignoreDefaultArgs: ['--enable-automation'],
});

ctx.on('page', (p) => console.log('  !! NEW PAGE:', p.url().slice(0, 90)));
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.log('  nav ->', f.url().slice(0, 95)); });
page.on('popup', (p) => console.log('  !! POPUP:', p.url().slice(0, 90)));
page.on('pageerror', (e) => console.log('  pageerror:', e.message.slice(0, 150)));

const shot = async (t) => { await page.screenshot({ path: SHOTS + 'ac-' + t + '.png' }).catch(() => {}); };

console.log('step: goto');
await page.goto('https://accounting.autocountcloud.com/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
console.log('title:', await page.title());

if (page.url().includes('auth.autocountcloud.com')) {
  console.log('step: fill email');
  const email = page.locator('input[type=email], input[type=text]').first();
  await email.fill(EMAIL);

  const remember = page.locator('input[type=checkbox]').first();
  if (await remember.count()) { await remember.check().catch(() => {}); console.log('  remember-me ticked'); }
  await shot('1-login');

  console.log('step: click Log in');
  await page.getByRole('button', { name: /log ?in|sign ?in/i }).first().click();
  await page.waitForTimeout(10000);
  console.log('after login:', page.url().slice(0, 80), '|', await page.title());
  await shot('2-afterlogin');
}

const hits = await page.getByText(COMPANY, { exact: false }).count();
console.log('matches for "' + COMPANY + '":', hits);
await shot('3-companies');

if (hits) {
  const el = page.getByText(COMPANY, { exact: false }).first();
  console.log('element:', JSON.stringify(await el.evaluate((e) => {
    const c = e.closest('a,button,[role=button],[onclick]') || e;
    const r = c.getBoundingClientRect();
    return { tag: e.tagName, clickable: c.tagName, href: c.getAttribute('href'), target: c.getAttribute('target'),
             cls: (c.className || '').toString().slice(0, 80), box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
  })));

  console.log('step: click company');
  await el.click();
  await page.waitForTimeout(12000);
}

console.log('--- final state ---');
for (const p of ctx.pages()) {
  const m = await p.evaluate(() => ({
    text: (document.body?.innerText || '').trim().length,
    html: document.documentElement.outerHTML.length,
    ls: Object.keys(localStorage).length,
    ss: Object.keys(sessionStorage).length,
  })).catch(() => ({ text: -1, html: -1, ls: -1, ss: -1 }));
  console.log(`  ${p.url().slice(0, 95)}\n    title="${await p.title().catch(() => '?')}" text=${m.text} html=${m.html} localStorage=${m.ls} sessionStorage=${m.ss}`);
}
await shot('4-final');
await ctx.close();
