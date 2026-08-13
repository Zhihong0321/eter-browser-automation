// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
// Open a saved monolith snapshot offline and screenshot it.

import { chromium } from 'patchright';

const FILE = process.argv[2];
const OUT = process.argv[3];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const failed = [];
page.on('requestfailed', (r) => failed.push(r.url().slice(0, 60)));
console.log('step: open', FILE);
await page.goto('file:///' + FILE.replace(/\\/g, '/'), { waitUntil: 'load' });
await page.waitForTimeout(4000);
console.log('   title =', await page.title());
console.log('   text  =', (await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 500))));
console.log('   failed requests =', failed.length, failed.slice(0, 4));
await page.screenshot({ path: OUT });
console.log('   shot ->', OUT);
process.exit(0);
