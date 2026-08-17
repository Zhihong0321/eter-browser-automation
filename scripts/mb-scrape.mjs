// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
// malaysiabrand.com.my -> newpages profile -> name / address / email / mobile
import { chromium } from 'patchright';

const PROFILE_DIR = 'E:\\eter-browser\\profiles\\agent';
const LIST = 'https://www.malaysiabrand.com.my/index.php?char=A';
const LIMIT = 5;

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome', headless: false, args: ['--no-sandbox'],
  viewport: null, ignoreDefaultArgs: ['--enable-automation'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

console.log('STEP 1 listing', LIST);
await page.goto(LIST, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => document.querySelectorAll('a[href*="newpages.com.my/en/company/"]').length > 10, null, { timeout: 30000 });
const entries = await page.evaluate(() =>
  [...document.querySelectorAll('a[href*="newpages.com.my/en/company/"]')]
    .map(a => ({ listName: a.innerText.trim().replace(/\s+/g, ' '), url: a.href })));
console.log('  companies on this page:', entries.length);

const rows = [];
for (const e of entries.slice(0, LIMIT)) {
  console.log('STEP 2 profile', e.url);
  try {
    await page.goto(e.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => /Main Office|Email:/i.test(document.body.innerText), null, { timeout: 25000 });
    const d = await page.evaluate(() => {
      const t = document.body.innerText;
      const html = document.documentElement.innerHTML;
      const L = t.split('\n').map(s => s.trim()).filter(Boolean);
      const i = L.findIndex(s => /^Main Office$/i.test(s));
      const blk = i >= 0 ? L.slice(i + 1, i + 12) : L;
      const grab = (re, src = t) => (src.match(re) || [, ''])[1].trim();
      return {
        name: i >= 0 ? blk[0] : (document.title.split(' in ')[0] || ''),
        address: blk.slice(1).find(s => /\b\d{5}\b/.test(s) && (s.match(/,/g) || []).length >= 2) || '',
        tel: grab(/Tel:\s*([^\n]+)/i),
        fax: grab(/Fax:\s*([^\n]+)/i),
        email: grab(/Email:\s*([\w.+-]+@[\w.-]+\.\w{2,})/i),
        mobile: grab(/wa\.me\/(\d{9,})/, html) || (L.find(s => /^\+?6?0?1\d[-\s]?\d{6,}$/.test(s)) || ''),
        website: grab(/Website:\s*(\S+)/i),
      };
    });
    rows.push({ ...d, url: page.url() });
    console.log('   ', d.name, '|', d.email, '|', d.mobile);
  } catch (err) {
    console.log('    FAILED:', err.message, '| url:', page.url());
    await page.screenshot({ path: 'E:\\001-browser-use-v2\\scripts\\mb-scrape-fail.png' }).catch(() => {});
  }
}

console.log('\n================ RESULT ================');
for (const r of rows) {
  console.log(`NAME    : ${r.name}`);
  console.log(`ADDRESS : ${r.address}`);
  console.log(`EMAIL   : ${r.email}`);
  console.log(`MOBILE  : ${r.mobile}`);
  console.log(`TEL/FAX : ${r.tel}  /  ${r.fax}`);
  console.log(`WEB     : ${r.website}`);
  console.log(`SRC     : ${r.url}`);
  console.log('----------------------------------------');
}
await ctx.close();
