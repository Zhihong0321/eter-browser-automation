// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
// Drive Chrome with patchright, record every request to a HAR, then parse the HAR here.
import { chromium } from 'patchright';
import fs from 'fs';

const HAR = 'E:\\001-browser-use-v2\\scripts\\autocount.har';

const ctx = await chromium.launchPersistentContext('E:\\eter-browser\\profiles\\agent', {
  channel: 'chrome', headless: false, args: ['--no-sandbox'],
  viewport: null, ignoreDefaultArgs: ['--enable-automation'],
  recordHar: { path: HAR, content: 'embed', mode: 'full' },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

try {
  console.log('step: goto root');
  await page.goto('https://accounting.autocountcloud.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  console.log('step: pick company');
  await page.locator('body>div>div>div>div:nth-of-type(2)>div:nth-of-type(4)>div>div>div:nth-of-type(6)>div>div>div>div>table>tbody>tr:nth-of-type(1)>td:nth-of-type(1)>button').click();
  await page.waitForTimeout(9000);
  console.log('step: goto /debtor');
  await page.goto('https://accounting.autocountcloud.com/debtor', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);
} catch (e) {
  console.log('CRASH:', e.message);
  await page.screenshot({ path: 'E:\\001-browser-use-v2\\scripts\\har-crash.png' });
}

console.log('step: close (flushes HAR)');
await ctx.close();

// ---- analysis ----
const har = JSON.parse(fs.readFileSync(HAR, 'utf8'));
const all = har.log.entries;
console.log(`\nHAR: ${all.length} requests, ${(fs.statSync(HAR).size / 1e6).toFixed(1)} MB\n`);

const api = all.filter((e) => {
  const u = e.request.url;
  const ct = (e.response.content.mimeType || '');
  return ct.includes('json') && !u.includes('.js') && !u.startsWith('data:');
});

console.log(`--- ${api.length} JSON calls ---`);
for (const e of api) {
  const u = new URL(e.request.url);
  const bytes = e.response.content.size;
  console.log(`${e.request.method.padEnd(5)} ${String(e.response.status).padEnd(4)} ${String(bytes).padStart(8)}b  ${u.pathname}${u.search.slice(0, 80)}`);
}

const biggest = api.sort((a, b) => b.response.content.size - a.response.content.size)[0];
if (biggest) {
  console.log(`\n--- biggest JSON payload: ${biggest.request.url.slice(0, 120)} ---`);
  console.log((biggest.response.content.text || '').slice(0, 900));
}
