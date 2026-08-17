// PROTOTYPE — throwaway. Hardcoded defaults, no error handling. Do not ship.
//
// GENERIC API SNIFFER. Records a HAR while you drive any site, then reverse-engineers
// the API out of it — into a spec an AI can write a WORKING request from.
// Nothing in here knows what any particular site is.
//
//   node scripts/sniff.mjs <url> [--profile=<dir>] [--wait=90] [--out=<name>]
//   node scripts/sniff.mjs --har=<file.har>          # analyze only, no browser
//
// Recording stops when you CLOSE THE BROWSER, or after --wait seconds, whichever first.
// Click around the app while it records — every XHR is captured with request and
// response bodies. Writes <out>.har (raw) and <out>.api.json (the distilled spec).
//
// The spec MERGES every hit of an endpoint (not just the biggest one) and carries real
// example values, so the AI reading it never has to open the multi-MB HAR.
// Secrets are REDACTED three ways: by header name, by key name, and by JWT shape.
import fs from 'fs';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a === undefined ? d : a.slice(k.length + 3); };
const HAR_IN = arg('har', null);
const URL_ARG = (process.argv[2] || '').startsWith('--') ? null : process.argv[2];

const t0 = Date.now();
const log = (s) => console.log(`[${String(((Date.now() - t0) / 1000).toFixed(0)).padStart(4)}s] ${s}`);

let HAR = HAR_IN;
let SITE = HAR_IN ? '(from har)' : new URL(URL_ARG).origin;
let OUT = HAR_IN ? HAR_IN.replace(/\.har$/i, '') : 'E:\\001-browser-use-v2\\scripts\\sniff-' + arg('out', new URL(URL_ARG).hostname.replace(/\W/g, '-'));

// ================= capture (skipped entirely with --har) =================
if (!HAR_IN) {
  const { chromium } = await import('patchright');
  HAR = OUT + '.har';
  const ctx = await chromium.launchPersistentContext(arg('profile', 'E:\\eter-browser\\profiles\\agent'), {
    channel: 'chrome', headless: false, args: ['--no-sandbox'],
    viewport: null, ignoreDefaultArgs: ['--enable-automation'],
    recordHar: { path: HAR, content: 'embed', mode: 'full' },
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  // live feed so you can see what your clicks trigger, as you click
  ctx.on('request', (r) => {
    if (['xhr', 'fetch'].includes(r.resourceType())) log(`${r.method()} ${r.url().slice(0, 130)}`);
  });

  const WAIT = +arg('wait', 90);
  log(`goto ${URL_ARG}`);
  await page.goto(URL_ARG, { waitUntil: 'domcontentloaded' }).catch((e) => log('nav: ' + e.message));
  log(`RECORDING — click around. stops on browser close or ${WAIT}s`);
  await Promise.race([
    new Promise((r) => ctx.on('close', r)),
    new Promise((r) => setTimeout(r, WAIT * 1000)),
  ]);
  log('stopping, flushing HAR');
  await ctx.close().catch(() => {});
}

// ================= analysis =================
const entries = JSON.parse(fs.readFileSync(HAR, 'utf8')).log.entries;

// Assets and app-shell files are not API. They just burn the reader's attention.
const NOISE = /\/(manifest\.json|favicon|service-worker|sockjs|hot-update)|\.(js|mjs|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)(\?|$)/i;
const isApi = (e) =>
  !NOISE.test(e.request.url) &&
  (['xhr', 'fetch'].includes(e._resourceType) || (e.response.content.mimeType || '').includes('json'));

const SECRET_HDR = /^(authorization|cookie|set-cookie|x-api-key|x-csrf-token|x-xsrf-token|api-key|x-auth-token)$/i;
const SECRET_KEY = /token|password|passwd|secret|apikey|api_key|jwt|session|signature|credential|code_verifier|code_challenge|\bcode\b/i;
const looksSecret = (v) => typeof v === 'string' && (/^ey[A-Za-z0-9_-]{8,}\./.test(v) || v.length > 180);
// A secret-sounding key is not enough: token_type="Bearer" is the thing the AI most
// needs and the least secret. Only long values get burned.
const isSecret = (k, v) => looksSecret(v) || (SECRET_KEY.test(k) && String(v).length > 16);
const REDACT = '«redacted»';

const json = (s) => { try { return JSON.parse(s); } catch { return null; } };
const body = (pd) => {
  if (!pd?.text) return null;
  const j = json(pd.text);
  if (j) return j;
  // form-encoded posts are where OAuth token exchanges live — the single most
  // valuable thing to reverse-engineer, and JSON.parse throws all of them away.
  if ((pd.mimeType || '').includes('urlencoded')) return Object.fromEntries(new URLSearchParams(pd.text));
  return null;
};

// numeric / uuid / long-hex path segments are IDs, not route names
const tmpl = (p) => p.split('/').map((s) =>
  /^\d+$/.test(s) ? '{id}' : /^[0-9a-f]{8}-?[0-9a-f-]{8,}$/i.test(s) ? '{uuid}' : s).join('/');

// ---- shape merging: fold EVERY sample into one tree, keeping counts + examples ----
const merge = (n, v, key = '', d = 0) => {
  n = n || { t: new Set(), n: 0, ex: [], props: null, item: null, len: 0 };
  n.n++;
  if (v === null || v === undefined) { n.t.add('null'); return n; }
  if (Array.isArray(v)) {
    n.t.add('array');
    n.len = Math.max(n.len, v.length);
    if (d < 5) for (const x of v.slice(0, 25)) n.item = merge(n.item, x, key, d + 1);
    return n;
  }
  if (typeof v === 'object') {
    n.t.add('object');
    n.props = n.props || new Map();
    if (d < 5) for (const [k, x] of Object.entries(v)) n.props.set(k, merge(n.props.get(k), x, k, d + 1));
    return n;
  }
  n.t.add(typeof v);
  if (isSecret(key, v)) { n.ex = [REDACT]; return n; }
  if (n.ex[0] !== REDACT && n.ex.length < 3 && v !== '' && !n.ex.includes(v)) n.ex.push(v);
  return n;
};

const ex1 = (v) => typeof v === 'string' ? JSON.stringify(v.length > 60 ? v.slice(0, 57) + '…' : v) : String(v);
const render = (n, pad = '') => {
  if (!n) return '?';
  if (n.props) {
    const rows = [...n.props.entries()].map(([k, c]) =>
      `${pad}  ${k}: ${render(c, pad + '  ')}${c.n < n.n ? `   (present ${c.n}/${n.n})` : ''}`);
    return `{\n${rows.join('\n')}\n${pad}}`;
  }
  if (n.item) return `[ ${n.len}× ${render(n.item, pad)} ]`;
  if (n.t.has('array')) return '[]';
  if (n.t.has('object')) return '{…}';
  const types = [...n.t].join('|');
  return n.ex.length ? `${types}   e.g. ${n.ex.map(ex1).join(', ')}` : types;
};

const redactDeep = (v, k = '') => {
  if (v === null || typeof v !== 'object') return isSecret(k, v) ? REDACT : v;
  if (Array.isArray(v)) return v.slice(0, 2).map((x) => redactDeep(x, k));
  return Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, redactDeep(vv, kk)]));
};

const groups = new Map();
let apiCalls = 0;
for (const e of entries.filter(isApi)) {
  apiCalls++;
  const u = new URL(e.request.url);
  const key = `${e.request.method} ${u.origin}${tmpl(u.pathname)}`;
  if (!groups.has(key)) groups.set(key, {
    key, hits: 0, bytes: 0, status: new Set(), auth: new Set(),
    query: new Map(), pathVars: new Map(), recv: null, send: null, url: '', sendRaw: null,
  });
  const g = groups.get(key);
  g.hits++;
  g.status.add(e.response.status);
  g.bytes = Math.max(g.bytes, e.response.content.size);

  // observed query values — "sort99" is unguessable, "sort99=rowId" is not
  u.searchParams.forEach((v, k) => {
    if (!g.query.has(k)) g.query.set(k, new Set());
    const s = g.query.get(k);
    if (s.size < 4) s.add(isSecret(k, v) ? REDACT : v);
  });
  tmpl(u.pathname).split('/').forEach((seg, i) => {
    if (!seg.startsWith('{')) return;
    if (!g.pathVars.has(seg)) g.pathVars.set(seg, new Set());
    const s = g.pathVars.get(seg);
    if (s.size < 3) s.add(u.pathname.split('/')[i]);
  });

  for (const h of e.request.headers) if (SECRET_HDR.test(h.name)) g.auth.add(h.name.toLowerCase());

  const recv = json(e.response.content.text || '');
  if (recv) { g.recv = merge(g.recv, recv); if (e.response.content.size >= g.bytes) g.url = e.request.url; }
  const send = body(e.request.postData);
  if (send) { g.send = merge(g.send, send); g.sendRaw = send; }
}

const list = [...groups.values()].sort((a, b) => b.bytes - a.bytes);
const fmtQuery = (g) => [...g.query.entries()].map(([k, v]) => `${k}=${[...v].join('|')}`).join('  ');

console.log(`\n${entries.length} requests in HAR → ${apiCalls} API calls → ${list.length} distinct endpoints\n`);
console.log('bytes    hits  status  endpoint');
for (const g of list) console.log(`${String(g.bytes).padStart(8)}  ${String(g.hits).padStart(3)}   ${[...g.status].join(',').padEnd(6)}  ${g.key.replace(/^(\w+) https?:\/\/[^/]+/, '$1 ')}`);

console.log('\n=== endpoint specs (biggest payload first) ===');
for (const g of list.slice(0, 12)) {
  console.log(`\n${'─'.repeat(70)}\n${g.key}   ×${g.hits} → ${[...g.status].join(',')}`);
  if (g.pathVars.size) console.log(`  path  : ${[...g.pathVars.entries()].map(([k, v]) => `${k}=${[...v].join('|')}`).join('  ')}`);
  if (g.query.size) console.log(`  query : ${fmtQuery(g)}`);
  if (g.auth.size) console.log(`  auth  : ${[...g.auth].join(', ')}`);
  if (g.send) console.log(`  SEND  : ${render(g.send, '  ')}`);
  if (g.recv) console.log(`  RECV  : ${render(g.recv, '  ')}`);
}

const auth = [...new Set(list.flatMap((g) => [...g.auth]))];
console.log(`\n=== auth ===\n${auth.length ? auth.map((a) => `  ${a}: on ${list.filter((g) => g.auth.has(a)).length}/${list.length} endpoints`).join('\n') : '  none — open API'}`);

const spec = {
  site: SITE,
  from: HAR,
  recorded: `${entries.length} requests, ${apiCalls} of them API`,
  auth: auth.length ? { headers: auth, note: 'values REDACTED — replay with a live session' } : 'none',
  endpoints: list.map((g) => ({
    endpoint: g.key,
    hits: g.hits,
    status: [...g.status],
    pathVars: Object.fromEntries([...g.pathVars].map(([k, v]) => [k, [...v]])),
    query: Object.fromEntries([...g.query].map(([k, v]) => [k, [...v]])),
    auth: [...g.auth],
    sends: g.send ? render(g.send) : null,
    returns: g.recv ? render(g.recv) : null,
    curl: `curl -X ${g.key.split(' ')[0]} '${(g.url || g.key.split(' ')[1]).replace(/'/g, "'\\''")}'`
      + [...g.auth].map((a) => ` -H '${a}: $TOKEN'`).join('')
      + (g.sendRaw ? ` -H 'content-type: application/json' -d '${JSON.stringify(redactDeep(g.sendRaw))}'` : ''),
  })),
};
fs.writeFileSync(OUT + '.api.json', JSON.stringify(spec, null, 2));
const kb = (p) => (fs.statSync(p).size / 1024).toFixed(0);
console.log(`\nwrote ${OUT}.api.json  —  ${kb(OUT + '.api.json')} KB spec distilled from a ${(fs.statSync(HAR).size / 1e6).toFixed(1)} MB HAR`);
console.log(`re-analyze anytime without re-recording:  node scripts/sniff.mjs --har=${HAR}`);
