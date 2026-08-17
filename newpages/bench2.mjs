// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
// The 1KB stub: what is it, and does the /v2/ URL serve the real HTML to a plain GET?
import fs from 'fs';
const out = [];
const say = (s) => { out.push(s); console.log(s); };
const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' };

const stubUrl = 'https://www.newpages.com.my/en/company/731041/index.htm';
let r = await fetch(stubUrl, { headers: UA });
let h = await r.text();
say(`STUB ${r.status} ${h.length}B  final=${r.url}`);
say('--- body ---');
say(h.slice(0, 900));

// the real one, as Chrome ends up at
const real = 'https://www.newpages.com.my/v2/en/company/731041/index.html';
for (const [tag, headers] of [['bare', {}], ['UA', UA], ['UA+ref', { ...UA, referer: 'https://www.newpages.com.my/' }]]) {
  const t = Date.now();
  const rr = await fetch(real, { headers });
  const hh = await rr.text();
  say(`\n${tag}: ${rr.status} ${(hh.length / 1024).toFixed(0)}KB in ${Date.now() - t}ms  MainOffice=${/Main Office/i.test(hh)}  email=${(hh.match(/Email:\s*<?[^<\n]*?([\w.+-]+@[\w.-]+\.\w{2,})/i) || [, '-'])[1]}  wa=${(hh.match(/wa\.me\/(\d{9,})/) || [, '-'])[1]}`);
}
fs.writeFileSync('E:\\001-browser-use-v2\\newpages\\bench2.log', out.join('\n'));
