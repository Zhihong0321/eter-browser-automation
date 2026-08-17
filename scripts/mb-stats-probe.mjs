// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
import { chromium } from 'patchright';
import fs from 'fs';
const OUT = 'E:\\001-browser-use-v2\\scripts\\mb-stats2.log';
const say = (s) => fs.appendFileSync(OUT, s + '\n');
fs.writeFileSync(OUT, '');
const ctx = await chromium.launchPersistentContext('E:\\eter-browser\\profiles\\agent', {
  channel: 'chrome', headless: false, args: ['--no-sandbox'], viewport: null,
  ignoreDefaultArgs: ['--enable-automation'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
const U = 'https://www.newpages.com.my/v2/en/company/731041/statistic/A-C-S-CONTRACTOR-SDN-BHD.html';
try {
  say('goto ' + U);
  const r = await page.goto(U, { waitUntil: 'domcontentloaded', timeout: 45000 });
  say('http ' + r.status() + ' -> ' + page.url());
  await page.waitForTimeout(4000);
  const t = await page.evaluate(() => document.body.innerText);
  say('bodylen ' + t.length);
  say(t.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 50).join('\n'));
  await page.screenshot({ path: 'E:\\001-browser-use-v2\\scripts\\mb-stats.png', fullPage: true });
  say('shot ok');
} catch (e) { say('DIED: ' + e.message + ' | ' + page.url()); }
await ctx.close();
say('closed');
