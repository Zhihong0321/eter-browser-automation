// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
//
// newpages — malaysiabrand.com.my index -> newpages.com.my profile -> contact + stats
//
//   node newpages.mjs seed                crawl all A-Z index buckets, add every company as PENDING
//   node newpages.mjs sync [--limit=N]    scrape the next N pending profiles, mark SYNCED
//   node newpages.mjs report [--csv]      counts + compiled table (name / stats / contact)
//
// The store IS the persistent list: store/companies.json, keyed by newpages company id.
// Saved after EVERY company, so a kill mid-run loses nothing and `sync` just carries on.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const { chromium } = createRequire('E:/001-browser-use-v2/')('patchright'); // patchright lives in the repo, not here

// EVERYTHING THIS TOOL WRITES STAYS UNDER THE PROJECT FOLDER. Nothing touches C:.
const DIR = path.dirname(new URL(import.meta.url).pathname.slice(1));
const STORE = path.join(DIR, 'store', 'companies.json');
const CSV = path.join(DIR, 'store', 'contacts.csv');
const CACHE = path.join(DIR, '.chrome-cache'); // keep Chrome's cache off C: too
const PROFILE_DIR = 'E:\\eter-browser\\profiles\\agent';
const LETTERS = ['', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''), 'Others'];
const IDX = (c) => `https://www.malaysiabrand.com.my/index.php${c ? '?char=' + c : ''}`;

const VERB = process.argv[2] ?? 'report';
const LIMIT = +(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 10);
const t0 = Date.now();
const log = (s) => console.log(`[${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(6)}s] ${s}`);

fs.mkdirSync(path.dirname(STORE), { recursive: true });
const db = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, 'utf8')) : {};
const save = () => fs.writeFileSync(STORE, JSON.stringify(db, null, 1));
const counts = () => {
  const c = { total: 0, pending: 0, synced: 0, failed: 0 };
  for (const r of Object.values(db)) { c.total++; c[r.status] = (c[r.status] ?? 0) + 1; }
  return c;
};

async function browser() {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome', headless: process.argv.includes('--headless'), viewport: null,
    args: ['--no-sandbox', `--disk-cache-dir=${CACHE}`],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  return [ctx, ctx.pages()[0] ?? (await ctx.newPage())];
}

// ---------------- seed ----------------
if (VERB === 'seed') {
  const [ctx, page] = await browser();
  for (const c of LETTERS) {
    log(`index ${c || 'All'}`);
    await page.goto(IDX(c), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => document.querySelectorAll('a[href*="newpages.com.my/en/company/"]').length > 0,
      null, { timeout: 30000 },
    ).catch(() => log('  (no company links)'));
    const found = await page.evaluate(() =>
      [...document.querySelectorAll('a[href*="newpages.com.my/en/company/"]')].map((a) => ({
        listName: a.innerText.trim().replace(/\s+/g, ' '),
        url: a.href,
        id: (a.href.match(/company\/(\d+)/) || [])[1],
      })));
    let added = 0;
    for (const f of found) {
      if (!f.id || db[f.id]) continue;
      db[f.id] = { id: f.id, listName: f.listName, url: f.url, bucket: c || 'All', status: 'pending' };
      added++;
    }
    save();
    log(`  ${found.length} links, +${added} new, store=${counts().total}`);
  }
  await ctx.close();
  console.log('\nSEEDED:', JSON.stringify(counts()));
}

// ---------------- sync --fast : no browser at all ----------------
// The profile is plain server-rendered HTML. Chrome renders 200KB of JS to show text that is
// already in the first response. A GET + regex gets the identical fields ~60x faster.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// Some requests get a 900B "Checking…" page instead of the profile: a JS challenge that sets
// np_js_c=1 and reloads. Send the cookie up front and the real HTML comes back first time.
const HDRS = { 'user-agent': UA, cookie: 'np_js_c=1' };
function parseProfile(html) {
  const txt = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|td|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d));
  const L = txt.split('\n').map((s) => s.trim()).filter(Boolean);
  const after = (label) => { const i = L.findIndex((s) => s.toLowerCase() === label); return i >= 0 ? L[i + 1] : ''; };
  const g = (re, src = txt) => (src.match(re) || [, ''])[1].trim();
  const i = L.findIndex((s) => /^Main Office$/i.test(s));
  const blk = i >= 0 ? L.slice(i + 1, i + 14) : [];
  const body = blk.slice(1).filter((s) => !/^(Tel|Fax|Email|Website|H\/P|Mobile)\s*:/i.test(s));
  return {
    name: blk[0] || g(/<title>([^<]+?)\s+in\s+/i, html),
    address: body.find((s) => /\b\d{5}\b/.test(s) && (s.match(/,/g) || []).length >= 2) || body[0] || '',
    email: g(/Email:\s*([\w.+-]+@[\w.-]+\.\w{2,})/i),
    mobile: g(/wa\.me\/(\d{9,})/, html),
    tel: g(/Tel:\s*([^\n]+)/i),
    fax: g(/Fax:\s*([^\n]+)/i),
    website: g(/Website:\s*(\S+)/i),
    location: after('location:'),
    nature: after('business nature:'),
    classifieds: after('related classifieds:'),
    tags: after('tags:'),
  };
}

if (VERB === 'sync' && process.argv.includes('--fast')) {
  const CONC = +(process.argv.find((a) => a.startsWith('--conc='))?.split('=')[1] ?? 6);
  const want = process.argv.includes('--retry') ? ['pending', 'failed'] : ['pending'];
  const queue = Object.values(db).filter((r) => want.includes(r.status)).slice(0, LIMIT);
  log(`FAST mode (no browser) · queue ${want.join('+')} ${queue.length} of ${counts().pending + (counts().failed || 0)} · ${CONC} at a time`);
  for (let i = 0; i < queue.length; i += CONC) {
    await Promise.all(queue.slice(i, i + CONC).map(async (r) => {
      try {
        const res = await fetch(r.url, { headers: HDRS });
        const html = new TextDecoder('utf-8').decode(await res.arrayBuffer());
        if (!/Main Office|Email:/i.test(html)) throw new Error(`no contact block (${res.status}, ${html.length}B)`);
        Object.assign(r, parseProfile(html));
        r.status = 'synced';
        r.syncedAt = new Date().toISOString();
      } catch (e) {
        r.status = 'failed';
        r.error = e.message.split('\n')[0];
      }
    }));
    save();
    const done = i + CONC;
    log(`  ${Math.min(done, queue.length)}/${queue.length}  ${((Date.now() - t0) / Math.min(done, queue.length)).toFixed(0)}ms/company`);
  }
  for (const r of queue.slice(0, 8)) log(`   ${r.status} ${r.name} | ${r.email || '-'} | ${r.mobile || '-'} | ${r.location || '-'}`);
  console.log('\nAFTER FAST SYNC:', JSON.stringify(counts()), `in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ---------------- sync (browser) ----------------
if (VERB === 'sync' && !process.argv.includes('--fast')) {
  const queue = Object.values(db).filter((r) => r.status === 'pending').slice(0, LIMIT);
  log(`pending ${counts().pending}, taking ${queue.length}`);
  const [ctx, page] = await browser();
  for (const r of queue) {
    log(`sync ${r.id} ${r.listName}`);
    try {
      await page.goto(r.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(() => /Main Office|Email:/i.test(document.body.innerText), null, { timeout: 25000 });
      Object.assign(r, await page.evaluate(() => {
        const t = document.body.innerText;
        const html = document.documentElement.innerHTML;
        const L = t.split('\n').map((s) => s.trim()).filter(Boolean);
        const after = (label) => { const i = L.findIndex((s) => s.toLowerCase() === label); return i >= 0 ? L[i + 1] : ''; };
        const grab = (re, src = t) => (src.match(re) || [, ''])[1].trim();
        const i = L.findIndex((s) => /^Main Office$/i.test(s));
        const blk = i >= 0 ? L.slice(i + 1, i + 14) : [];
        const body = blk.slice(1).filter((s) => !/^(Tel|Fax|Email|Website|H\/P|Mobile)\s*:/i.test(s));
        return {
          name: blk[0] || document.title.split(' in ')[0],
          address: body.find((s) => /\b\d{5}\b/.test(s) && (s.match(/,/g) || []).length >= 2) || body[0] || '',
          email: grab(/Email:\s*([\w.+-]+@[\w.-]+\.\w{2,})/i),
          mobile: grab(/wa\.me\/(\d{9,})/, html),
          tel: grab(/Tel:\s*([^\n]+)/i),
          fax: grab(/Fax:\s*([^\n]+)/i),
          website: grab(/Website:\s*(\S+)/i),
          location: after('location:'),
          nature: after('business nature:'),
          classifieds: after('related classifieds:'),
          tags: after('tags:'),
        };
      }));
      r.status = 'synced';
      r.syncedAt = new Date().toISOString();
      delete r.products; // products are not part of this harvest
      log(`   ok ${r.name} | ${r.email || '-'} | ${r.mobile || '-'} | ${r.location || '-'}`);
    } catch (e) {
      r.status = 'failed';
      r.error = e.message.split('\n')[0];
      log(`   FAILED ${r.error} @ ${page.url()}`);
      await page.screenshot({ path: path.join(DIR, `fail-${r.id}.png`) }).catch(() => {});
    }
    save();
    await page.waitForTimeout(400);
  }
  await ctx.close();
  console.log('\nAFTER SYNC:', JSON.stringify(counts()));
}

// ---------------- page ----------------
if (VERB === 'page') {
  const c = counts();
  const rows = Object.values(db).map((r) => ({
    i: r.id, n: r.name || r.listName || '(unnamed)', s: r.status,
    e: r.email || '', m: r.mobile || '', t: r.tel || '', a: r.address || '',
    l: r.location || '', b: r.nature || '', g: r.tags || '',
    w: r.website || '', u: r.url,
  })).sort((a, b) => (a.s === b.s ? 0 : a.s === 'synced' ? -1 : 1));
  const html = `<!doctype html><meta charset="utf-8"><title>newpages</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#0d1117;color:#e6edf3;font:14px/1.5 ui-sans-serif,Segoe UI,system-ui}
header{padding:22px 28px;border-bottom:1px solid #21262d;position:sticky;top:0;background:#0d1117;z-index:2}
h1{margin:0 0 4px;font-size:20px;letter-spacing:-.02em}h1 span{color:#7d8590;font-weight:400;font-size:13px;margin-left:8px}
.k{display:flex;gap:26px;margin:14px 0 10px}.k div{font-size:12px;color:#7d8590;text-transform:uppercase;letter-spacing:.06em}
.k b{display:block;font-size:26px;color:#e6edf3;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.k .ok b{color:#3fb950}.k .pend b{color:#d29922}.k .bad b{color:#f85149}
.bar{height:6px;background:#21262d;border-radius:3px;overflow:hidden}.bar i{display:block;height:100%;background:#3fb950}
.ctl{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
input{flex:1;min-width:240px;background:#010409;border:1px solid #30363d;color:#e6edf3;padding:8px 12px;border-radius:6px;font:inherit}
button{background:#21262d;border:1px solid #30363d;color:#e6edf3;padding:8px 14px;border-radius:6px;cursor:pointer;font:inherit}
button.on{background:#1f6feb;border-color:#1f6feb}
table{width:100%;border-collapse:collapse}th{position:sticky;top:0;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#7d8590;padding:10px 14px;background:#161b22;border-bottom:1px solid #30363d}
td{padding:10px 14px;border-bottom:1px solid #21262d;vertical-align:top}tr:hover td{background:#161b22}
.nm{font-weight:600}.sub{color:#7d8590;font-size:12px}
.pill{font-size:11px;padding:2px 8px;border-radius:20px;border:1px solid}
.synced{color:#3fb950;border-color:#238636;background:#0f2f1a}.pending{color:#d29922;border-color:#9e6a03;background:#2b2306}.failed{color:#f85149;border-color:#8b2c26;background:#2d1210}
a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}
.wa{display:inline-flex;align-items:center;gap:6px;margin:4px 0;padding:5px 11px;border-radius:6px;background:#128c7e;color:#fff;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;border:1px solid #0f7a6c}
.wa:hover{background:#25d366;color:#07130f;text-decoration:none}
.wa::before{content:"";width:13px;height:13px;flex:none;background:currentColor;-webkit-mask:var(--wa) center/contain no-repeat;mask:var(--wa) center/contain no-repeat}
:root{--wa:url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 004.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91C21.96 6.45 17.5 2 12.04 2zm5.8 14.16c-.24.68-1.42 1.31-1.95 1.36-.5.05-1.13.07-1.83-.11-.42-.13-.96-.31-1.66-.61-2.92-1.26-4.83-4.2-4.98-4.4-.14-.2-1.18-1.57-1.18-2.99s.75-2.12 1.01-2.41c.27-.29.58-.36.78-.36.19 0 .39 0 .56.01.18.01.42-.07.66.5.24.58.83 2 .9 2.15.07.14.12.31.02.5-.09.2-.14.32-.28.49-.14.17-.29.37-.42.5-.14.14-.28.29-.12.57.16.29.71 1.17 1.53 1.9 1.05.94 1.94 1.23 2.22 1.37.27.14.43.12.59-.07.16-.2.68-.79.86-1.07.18-.28.36-.23.61-.14.24.09 1.56.73 1.83.87.27.14.44.2.51.32.06.11.06.68-.18 1.36z"/></svg>')}
.n{font-variant-numeric:tabular-nums}#foot{padding:16px 28px;color:#7d8590}
</style>
<header>
<h1>newpages<span>malaysiabrand.com.my → newpages.com.my · generated ${new Date().toLocaleString()}</span></h1>
<div class="k">
 <div>total<b class="n">${c.total}</b></div>
 <div class="ok">synced<b class="n">${c.synced || 0}</b></div>
 <div class="pend">pending<b class="n">${c.pending || 0}</b></div>
 <div class="bad">failed<b class="n">${c.failed || 0}</b></div>
 <div>with email<b class="n">${rows.filter((r) => r.e).length}</b></div>
 <div>with mobile<b class="n">${rows.filter((r) => r.m).length}</b></div>
</div>
<div class="bar"><i style="width:${((c.synced || 0) / c.total * 100).toFixed(2)}%"></i></div>
<div class="ctl">
 <input id="q" placeholder="search name, email, phone, location, tags…">
 <button data-f="all" class="on">All</button><button data-f="synced">Synced</button>
 <button data-f="pending">Not synced</button><button data-f="email">Has email</button>
 <button data-f="mobile">Has mobile</button>
</div>
</header>
<table><thead><tr><th>Company</th><th>Status</th><th>Contact</th><th>Stats</th><th>Address</th></tr></thead><tbody id="tb"></tbody></table>
<div id="foot"></div>
<script>
const D=${JSON.stringify(rows)};let F='all',Q='';
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function draw(){
 const q=Q.toLowerCase();
 let r=D.filter(x=>{
  if(F==='synced'&&x.s!=='synced')return false;
  if(F==='pending'&&x.s==='synced')return false;
  if(F==='email'&&!x.e)return false;
  if(F==='mobile'&&!x.m)return false;
  return !q||[x.n,x.e,x.m,x.t,x.l,x.g,x.a].join(' ').toLowerCase().includes(q);
 });
 const shown=r.slice(0,400);
 document.getElementById('tb').innerHTML=shown.map(x=>\`<tr>
  <td><div class="nm">\${esc(x.n)}</div><div class="sub">\${x.w?'<a href="'+esc(x.w)+'" target="_blank">'+esc(x.w.replace(/^https?:\\/\\//,''))+'</a>':''}</div></td>
  <td><span class="pill \${x.s}">\${x.s}</span></td>
  <td>\${x.e?'<a href="mailto:'+esc(x.e)+'">'+esc(x.e)+'</a><br>':''}\${x.m?'<a class="wa" href="https://wa.me/'+esc(x.m)+'" target="_blank" rel="noopener">WhatsApp '+esc(x.m)+'</a><br>':''}<span class="sub n">\${esc(x.t)}</span></td>
  <td class="sub">\${x.b?esc(x.b)+'<br>':''}\${x.l?esc(x.l)+'<br>':''}\${x.g?esc(x.g):''}</td>
  <td class="sub">\${esc(x.a)}</td></tr>\`).join('');
 document.getElementById('foot').textContent='showing '+shown.length+' of '+r.length+' matching · '+D.length+' total';
}
document.getElementById('q').oninput=e=>{Q=e.target.value;draw()};
document.querySelectorAll('button[data-f]').forEach(b=>b.onclick=()=>{
 F=b.dataset.f;document.querySelectorAll('button[data-f]').forEach(x=>x.classList.toggle('on',x===b));draw();});
draw();
</script>`;
  const OUT = path.join(DIR, 'newpages.html');
  fs.writeFileSync(OUT, html);
  console.log('PAGE', OUT, (html.length / 1024).toFixed(0) + ' KB');
  const [ctx, page] = await browser();
  await page.goto('file:///' + OUT.replace(/\\/g, '/'), { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('#tb tr').length > 0, null, { timeout: 15000 });
  console.log('RENDERED rows:', await page.evaluate(() => document.querySelectorAll('#tb tr').length));
  console.log('FOOT:', await page.evaluate(() => document.getElementById('foot').textContent));
  console.log('KPIs:', await page.evaluate(() => [...document.querySelectorAll('.k div')].map((d) => d.textContent.trim()).join(' | ')));
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.screenshot({ path: path.join(DIR, 'newpages-page.png') });
  await page.click('button[data-f="mobile"]');                 // prove the WhatsApp buttons render
  await page.waitForFunction(() => document.querySelectorAll('a.wa').length > 0, null, { timeout: 5000 });
  console.log('WA buttons:', await page.evaluate(() => document.querySelectorAll('a.wa').length),
    '| first href:', await page.evaluate(() => document.querySelector('a.wa').href));
  await page.screenshot({ path: path.join(DIR, 'newpages-wa.png') });
  await ctx.close();
}

// ---------------- report ----------------
if (VERB === 'report') {
  const c = counts();
  console.log('STORE', STORE);
  console.log(`total ${c.total} | synced ${c.synced || 0} | pending ${c.pending || 0} | failed ${c.failed || 0}`);
  const done = Object.values(db).filter((r) => r.status === 'synced');
  console.log('\n--- COMPILED (name | stats | contact) ---');
  for (const r of done.slice(0, 40)) {
    console.log(`${r.name}`);
    console.log(`   stats   : ${r.nature || '-'} | ${r.location || '-'} | tags: ${r.tags || '-'}`);
    console.log(`   contact : ${r.email || '-'} | mob ${r.mobile || '-'} | tel ${r.tel || '-'}`);
    console.log(`   address : ${r.address || '-'}`);
  }
  if (process.argv.includes('--csv')) {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const cols = ['id', 'name', 'address', 'email', 'mobile', 'wa', 'tel', 'fax', 'website', 'location', 'nature', 'classifieds', 'tags', 'url'];
    const cell = (r, k) => (k === 'wa' ? (r.mobile ? 'https://wa.me/' + r.mobile : '') : r[k]);
    fs.writeFileSync(CSV, [cols.join(','), ...done.map((r) => cols.map((k) => q(cell(r, k))).join(','))].join('\n'));
    console.log('\nCSV', CSV, done.length, 'rows');
  }
}
