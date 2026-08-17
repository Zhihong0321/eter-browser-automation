// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
// Is Chrome even needed? plain HTTPS GET vs headless Chrome, same 6 profiles.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const { chromium } = createRequire('E:/001-browser-use-v2/')('patchright');
const DIR = 'E:\\001-browser-use-v2\\newpages';
const db = JSON.parse(fs.readFileSync(path.join(DIR, 'store', 'companies.json'), 'utf8'));
const urls = Object.values(db).filter((r) => r.status === 'pending').slice(0, 6).map((r) => r.url);
const out = [];
const say = (s) => { out.push(s); console.log(s); };

// ---- parse straight out of raw HTML, no DOM ----
function parseHtml(h) {
  const txt = h.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  const L = txt.split('\n').map((s) => s.trim()).filter(Boolean);
  const i = L.findIndex((s) => /^Main Office$/i.test(s));
  const blk = i >= 0 ? L.slice(i + 1, i + 14) : [];
  const body = blk.slice(1).filter((s) => !/^(Tel|Fax|Email|Website|H\/P|Mobile)\s*:/i.test(s));
  const g = (re, src = txt) => (src.match(re) || [, ''])[1].trim();
  return {
    name: blk[0] || '',
    address: body.find((s) => /\b\d{5}\b/.test(s) && (s.match(/,/g) || []).length >= 2) || body[0] || '',
    email: g(/Email:\s*([\w.+-]+@[\w.-]+\.\w{2,})/i),
    mobile: g(/wa\.me\/(\d{9,})/, h),
    tel: g(/Tel:\s*([^\n]+)/i),
  };
}

say('=== A: plain HTTPS GET (no browser) — sequential ===');
let a0 = Date.now();
const seq = [];
for (const u of urls) {
  const t = Date.now();
  const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131' } });
  const h = await r.text();
  const d = parseHtml(h);
  seq.push(d);
  say(`  ${Date.now() - t}ms  http ${r.status}  ${(h.length / 1024).toFixed(0)}KB  ${d.name} | ${d.email || '-'} | ${d.mobile || '-'}`);
}
const A = Date.now() - a0;
say(`  TOTAL ${A}ms  (${(A / urls.length).toFixed(0)}ms/company)`);

say('\n=== B: plain HTTPS GET — 6 at once ===');
let b0 = Date.now();
const par = await Promise.all(urls.map(async (u) => parseHtml(await (await fetch(u)).text())));
const B = Date.now() - b0;
say(`  TOTAL ${B}ms for ${urls.length}  (${(B / urls.length).toFixed(0)}ms/company)  emails: ${par.filter((x) => x.email).length}/${urls.length}`);

say('\n=== C: headless Chrome (current sync path) ===');
let c0 = Date.now();
const ctx = await chromium.launchPersistentContext('E:\\eter-browser\\profiles\\agent', {
  channel: 'chrome', headless: true, viewport: null,
  args: ['--no-sandbox', `--disk-cache-dir=${path.join(DIR, '.chrome-cache')}`],
  ignoreDefaultArgs: ['--enable-automation'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
say(`  boot ${Date.now() - c0}ms`);
const cBoot = Date.now() - c0;
let c1 = Date.now();
for (const u of urls) {
  const t = Date.now();
  await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => /Main Office|Email:/i.test(document.body.innerText), null, { timeout: 25000 });
  const nm = await page.evaluate(() => document.body.innerText.split('\n').map((s) => s.trim()).filter(Boolean)[0]);
  say(`  ${Date.now() - t}ms  ${nm}`);
}
const C = Date.now() - c1;
say(`  TOTAL ${C}ms nav (${(C / urls.length).toFixed(0)}ms/company) + ${cBoot}ms boot`);
await ctx.close();

say('\n=== VERDICT ===');
say(`  seq fetch      ${(A / urls.length).toFixed(0)} ms/company`);
say(`  parallel fetch ${(B / urls.length).toFixed(0)} ms/company`);
say(`  headless chrome${(C / urls.length).toFixed(0)} ms/company`);
say(`  same data? fetch emails ${seq.filter((x) => x.email).length}/${urls.length}, addresses ${seq.filter((x) => x.address).length}/${urls.length}`);
say(`  6890 companies: fetch-par ${(B / urls.length * 6890 / 60000).toFixed(0)} min | chrome ${(C / urls.length * 6890 / 60000).toFixed(0)} min`);
fs.writeFileSync(path.join(DIR, 'bench.log'), out.join('\n'));
