// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
import fs from 'fs';
const h = JSON.parse(fs.readFileSync('E:\\001-browser-use-v2\\scripts\\autocount.har', 'utf8'));
const e = h.log.entries.find((x) => x.request.url.includes('/debtor/list'));
console.log('URL:', e.request.url);
console.log('\n--- response body ---');
console.log(e.response.content.text.slice(0, 700));
console.log('\n--- auth headers sent ---');
console.log(e.request.headers.filter((x) => /^authorization$/i.test(x.name)).map((x) => x.name + ': ' + x.value.slice(0, 40) + '…').join('\n') || '(none — cookie auth)');
