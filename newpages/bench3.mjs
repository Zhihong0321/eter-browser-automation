// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
// Why did those 6 pending URLs return 1KB when 731041 returns 144KB?
import fs from 'fs';
import path from 'path';
const DIR = 'E:\\001-browser-use-v2\\newpages';
const db = JSON.parse(fs.readFileSync(path.join(DIR, 'store', 'companies.json'), 'utf8'));
const urls = Object.values(db).filter((r) => r.status === 'pending').slice(0, 6).map((r) => r.url);
const out = [];
const say = (s) => { out.push(s); console.log(s); };
for (const u of urls) {
  const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131' } });
  const h = await r.text();
  say(`${u}\n  ${r.status} ${h.length}B final=${r.url}`);
  say('  ' + h.replace(/\s+/g, ' ').slice(0, 300));
}
fs.writeFileSync(path.join(DIR, 'bench3.log'), out.join('\n'));
