// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
// What is actually on the AutoCount login form? Every input and every button.
// Values are never printed, only lengths.

import { chromium } from 'patchright';

const ctx = await chromium.launchPersistentContext('E:\\eter-browser\\profiles\\agent', {
  channel: 'chrome', headless: false, args: ['--no-sandbox'],
  viewport: null, ignoreDefaultArgs: ['--enable-automation'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

await page.goto('https://accounting.autocountcloud.com/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
console.log('url  :', page.url().slice(0, 80));
console.log('title:', await page.title());

const dump = await page.evaluate(() => ({
  inputs: Array.from(document.querySelectorAll('input')).map((i) => ({
    type: i.type, name: i.name, id: i.id, ph: i.placeholder,
    valueLen: (i.value || '').length, visible: i.getBoundingClientRect().width > 0,
  })),
  buttons: Array.from(document.querySelectorAll('button, input[type=submit], a[role=button]')).map((b) => ({
    tag: b.tagName, type: b.getAttribute('type'), id: b.id,
    text: (b.innerText || b.value || '').trim().slice(0, 40),
    cls: (b.className || '').toString().slice(0, 60),
  })),
  forms: Array.from(document.querySelectorAll('form')).map((f) => ({ action: f.getAttribute('action'), method: f.method })),
}));

console.log('inputs :', JSON.stringify(dump.inputs, null, 1));
console.log('buttons:', JSON.stringify(dump.buttons, null, 1));
console.log('forms  :', JSON.stringify(dump.forms));
await page.screenshot({ path: 'E:\\eter-browser\\tools\\ac-form.png' }).catch(() => {});
await ctx.close();
