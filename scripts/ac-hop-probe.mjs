// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
// Walk 4 routes by hand. Print what we land on and the token state each hop.

import { chromium } from 'patchright';

const ctx = await chromium.launchPersistentContext('E:\\eter-browser\\profiles\\agent', {
  channel: 'chrome', headless: false, args: ['--no-sandbox'],
  viewport: null, ignoreDefaultArgs: ['--enable-automation'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

await page.goto('https://accounting.autocountcloud.com/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
if ((await page.title()).includes('Log In')) {
  await page.locator('input[type=password]').first().press('Enter');
  await page.waitForTimeout(9000);
}
if ((await page.title()).includes('Select Company')) {
  await page.getByText('Macam Yes', { exact: false }).first().click();
  await page.waitForTimeout(9000);
}
console.log('LOGGED IN:', page.url(), '|', await page.title());

for (const route of ['/dashboard', '/masterdata', '/companyprofile', '/fiscalyear']) {
  console.log('\n--- goto', route);
  await page.goto('https://accounting.autocountcloud.com' + route, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  const t = await page.title();
  console.log('   landed:', page.url().slice(0, 80));
  console.log('   title :', t);
  const store = await page.evaluate(() => {
    const keys = { local: Object.keys(localStorage), session: Object.keys(sessionStorage) };
    const oidc = keys.local.filter((k) => /oidc|user|token/i.test(k));
    return { nLocal: keys.local.length, nSession: keys.session.length, oidc, sessionKeys: keys.session.slice(0, 8) };
  }).catch((e) => ({ err: e.message.split('\n')[0] }));
  console.log('   storage:', JSON.stringify(store));
  const ck = (await ctx.cookies()).filter((c) => c.domain.includes('autocount')).map((c) => c.name);
  console.log('   cookies:', ck.join(', '));
}
process.exit(0);
