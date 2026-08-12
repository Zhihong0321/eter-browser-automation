// gmap-recon project report — a single self-contained HTML file.
//
// No network at render OR at view time: fonts are Windows-local (Bahnschrift is a
// condensed industrial face that ships with Win10/11; Cascadia Code with the
// terminal), and the lead rows are embedded as JSON. The file can be copied to a
// USB stick and still work.
//
// Rows render client-side so filtering and sorting stay instant at 1,000+ leads.

import type { BusinessRow } from './leads.js';
import type { ProjectMeta } from './gmapproject.js';

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** `</script>` inside embedded JSON would close the tag early. */
const json = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c');

const STATUS_TONE: Record<ProjectMeta['status'], string> = {
  planned: 'idle',
  harvesting: 'live',
  enriching: 'live',
  complete: 'done',
  paused: 'warn',
};

export function renderReport(meta: ProjectMeta, rows: BusinessRow[]): string {
  const s = meta.stats;
  const searchPct = s.searchesTotal ? Math.round((s.searchesDone / s.searchesTotal) * 100) : 0;
  const enriched = rows.filter((r) => r.enrichStatus !== 'pending').length;
  const enrichPct = rows.length ? Math.round((enriched / rows.length) * 100) : 0;

  const data = rows.map((r) => ({
    n: r.name,
    p: r.phone ?? '',
    e: r.email ?? '',
    w: r.website ?? '',
    c: r.category ?? '',
    a: r.address ?? '',
    r: r.rating ?? null,
    v: r.reviews ?? null,
    fb: r.facebook ?? '',
    ig: r.instagram ?? '',
    wa: r.whatsapp ?? '',
    m: r.mapsUrl ?? '',
  }));

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(meta.id)} — gmap-recon</title>
<style>
  :root{
    --ink:#0b0d0c; --ink-2:#121614; --ink-3:#1a201d;
    --line:#2a332e; --line-hot:#3d4a42;
    --dim:#6f7d74; --text:#c9d4cd;
    --signal:#ffb000; --signal-dim:#8a6108;
    --cool:#4fd6c4; --warn:#ff5f45;
    --mono:"Cascadia Code","Cascadia Mono",Consolas,"DejaVu Sans Mono",monospace;
    --display:"Bahnschrift","DIN Alternate","Segoe UI Variable Display","Arial Narrow",sans-serif;
  }
  *{box-sizing:border-box}
  html,body{margin:0;background:var(--ink);color:var(--text);font-family:var(--mono);font-size:13px}
  /* Grain + scanline: gives the ground depth without an image request. */
  body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:99;opacity:.35;
    background:repeating-linear-gradient(0deg,rgba(255,255,255,.025) 0 1px,transparent 1px 3px)}
  a{color:var(--cool);text-decoration:none}
  a:hover{text-decoration:underline}

  .wrap{max-width:1500px;margin:0 auto;padding:34px 26px 80px}

  /* ---- masthead ---------------------------------------------------------- */
  header{border-bottom:2px solid var(--signal);padding-bottom:18px;margin-bottom:6px;
    animation:rise .5s cubic-bezier(.2,.8,.2,1) both}
  .kicker{font-family:var(--mono);font-size:10.5px;letter-spacing:.32em;text-transform:uppercase;
    color:var(--signal-dim);display:flex;gap:14px;align-items:center}
  .kicker::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--line-hot),transparent)}
  h1{font-family:var(--display);font-weight:600;font-size:clamp(30px,5.5vw,58px);line-height:.95;
    letter-spacing:-.01em;margin:12px 0 0;color:#fff;text-transform:uppercase}
  .sub{margin-top:14px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  .chip{border:1px solid var(--line-hot);padding:3px 10px;font-size:11px;letter-spacing:.06em;
    color:var(--text);background:var(--ink-2)}
  .chip.k{border-color:var(--signal-dim);color:var(--signal)}
  .badge{margin-left:auto;font-family:var(--display);font-size:13px;letter-spacing:.22em;
    text-transform:uppercase;padding:5px 14px;border:1px solid currentColor}
  .badge.done{color:var(--cool)} .badge.live{color:var(--signal)}
  .badge.warn{color:var(--warn)} .badge.idle{color:var(--dim)}

  /* ---- stats ------------------------------------------------------------- */
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:1px;
    background:var(--line);border:1px solid var(--line);margin:26px 0}
  .tile{background:var(--ink-2);padding:20px 18px;animation:rise .5s cubic-bezier(.2,.8,.2,1) both}
  .tile:nth-child(2){animation-delay:.06s} .tile:nth-child(3){animation-delay:.12s}
  .tile:nth-child(4){animation-delay:.18s} .tile:nth-child(5){animation-delay:.24s}
  .tile b{display:block;font-family:var(--display);font-size:44px;line-height:1;color:#fff;font-weight:600}
  .tile.hot b{color:var(--signal)}
  .tile span{display:block;margin-top:9px;font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim)}

  /* ---- progress ---------------------------------------------------------- */
  .bars{display:grid;gap:16px;margin:26px 0}
  .bar b{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--dim);font-weight:400}
  .bar b i{font-style:normal;float:right;color:var(--text)}
  .track{height:7px;background:var(--ink-3);margin-top:8px;overflow:hidden}
  .fill{height:100%;background:linear-gradient(90deg,var(--signal-dim),var(--signal));
    animation:grow 1s cubic-bezier(.2,.8,.2,1) both}
  .fill.cool{background:linear-gradient(90deg,#1d6b62,var(--cool))}

  /* ---- notices ----------------------------------------------------------- */
  .note{border-left:3px solid var(--warn);background:rgba(255,95,69,.07);padding:14px 18px;margin:22px 0}
  .note h3{margin:0 0 6px;font-family:var(--display);font-size:15px;letter-spacing:.1em;
    text-transform:uppercase;color:var(--warn);font-weight:600}
  .note p{margin:0;color:var(--text);line-height:1.55}
  .note ul{margin:9px 0 0;padding-left:18px;color:var(--dim)}

  /* ---- table ------------------------------------------------------------- */
  .toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:30px 0 12px}
  input[type=search]{flex:1;min-width:220px;background:var(--ink-2);border:1px solid var(--line-hot);
    color:var(--text);font-family:var(--mono);font-size:13px;padding:9px 12px}
  input[type=search]:focus{outline:none;border-color:var(--signal)}
  .tog{border:1px solid var(--line-hot);background:var(--ink-2);color:var(--dim);font-family:var(--mono);
    font-size:11px;letter-spacing:.12em;text-transform:uppercase;padding:9px 14px;cursor:pointer}
  .tog[aria-pressed=true]{border-color:var(--signal);color:var(--signal);background:rgba(255,176,0,.08)}
  .count{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);margin-left:auto}

  .scroll{overflow-x:auto;border:1px solid var(--line)}
  table{border-collapse:collapse;width:100%;min-width:1080px}
  th{position:sticky;top:0;z-index:2;background:var(--ink-3);text-align:left;padding:11px 13px;
    font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim);font-weight:400;
    border-bottom:1px solid var(--line-hot);cursor:pointer;white-space:nowrap;user-select:none}
  th:hover{color:var(--signal)}
  th[data-dir]::after{content:" ▲";color:var(--signal)}
  th[data-dir="desc"]::after{content:" ▼"}
  td{padding:10px 13px;border-bottom:1px solid var(--ink-3);vertical-align:top}
  tbody tr:nth-child(even){background:rgba(255,255,255,.014)}
  tbody tr:hover{background:rgba(255,176,0,.055)}
  .nm{color:#fff;max-width:280px}
  .ph{color:var(--signal);white-space:nowrap}
  .ad{color:var(--dim);max-width:260px;font-size:12px}
  .rt{white-space:nowrap;color:var(--dim)}
  .rt b{color:var(--text);font-weight:400}
  .soc a{display:inline-block;border:1px solid var(--line-hot);padding:1px 5px;margin-right:3px;
    font-size:10px;color:var(--dim)}
  .soc a:hover{border-color:var(--cool);color:var(--cool);text-decoration:none}
  .none{color:#3d4a42}
  .empty{padding:44px;text-align:center;color:var(--dim);letter-spacing:.16em;text-transform:uppercase}

  footer{margin-top:34px;padding-top:16px;border-top:1px solid var(--line);color:var(--dim);
    font-size:11px;display:flex;flex-wrap:wrap;gap:18px}

  @keyframes rise{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}
  @keyframes grow{from{width:0}}
  @media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
</head><body><div class="wrap">

<header>
  <div class="kicker">gmap-recon · project dossier</div>
  <h1>${esc(meta.id)}</h1>
  <div class="sub">
    ${meta.keywords.map((k) => `<span class="chip k">${esc(k)}</span>`).join('')}
    ${meta.places.map((p) => `<span class="chip">${esc(p)}</span>`).join('')}
    <span class="badge ${STATUS_TONE[meta.status]}">${esc(meta.status)}</span>
  </div>
</header>

<div class="tiles">
  <div class="tile hot"><b>${s.companies}</b><span>companies</span></div>
  <div class="tile"><b>${s.withPhone}</b><span>with phone</span></div>
  <div class="tile"><b>${s.withEmail}</b><span>with email</span></div>
  <div class="tile"><b>${s.searchesDone}<small style="font-size:20px;color:var(--dim)">/${s.searchesTotal}</small></b><span>searches run</span></div>
</div>

<div class="bars">
  <div class="bar"><b>Stage 1 — Google Maps <i>${searchPct}%</i></b>
    <div class="track"><div class="fill" style="width:${searchPct}%"></div></div></div>
  <div class="bar"><b>Stage 2 — company websites <i>${enrichPct}%</i></b>
    <div class="track"><div class="fill cool" style="width:${enrichPct}%"></div></div></div>
</div>

${meta.pausedReason ? `<div class="note"><h3>Paused</h3><p>${esc(meta.pausedReason)}</p>
  <p style="margin-top:8px;color:var(--dim)">Everything above is saved. Re-run
  <code>node gmap.mjs resume ${esc(meta.id)}</code> to continue.</p></div>` : ''}

${meta.saturated.length ? `<div class="note"><h3>Incomplete coverage</h3>
  <p>Google stopped showing more results in these areas, so companies there were missed.
  Re-run with smaller areas — districts instead of the whole town — to reach them.</p>
  <ul>${meta.saturated.map((x) => `<li>${esc(x.place)} — ${esc(x.keyword)} (stopped at ${x.found})</li>`).join('')}</ul>
</div>` : ''}

<div class="toolbar">
  <input type="search" id="q" placeholder="Filter by name, phone, category, address…" autocomplete="off">
  <button class="tog" id="fp" aria-pressed="false">Has phone</button>
  <button class="tog" id="fe" aria-pressed="false">Has email</button>
  <span class="count" id="ct"></span>
</div>

<div class="scroll">
  <table>
    <thead><tr>
      <th data-k="n">Company</th><th data-k="p">Phone</th><th data-k="e">Email</th>
      <th data-k="c">Category</th><th data-k="r">Rating</th><th data-k="a">Address</th>
      <th>Links</th>
    </tr></thead>
    <tbody id="tb"></tbody>
  </table>
  <div class="empty" id="mt" hidden>No companies match that filter</div>
</div>

<footer>
  <span>Generated ${esc(new Date().toLocaleString())}</span>
  <span>Created ${esc(meta.createdAt.slice(0, 16).replace('T', ' '))}</span>
  <span>${rows.length} rows embedded · offline-ready</span>
</footer>

<script>
const DATA = ${json(data)};
const tb = document.getElementById('tb'), ct = document.getElementById('ct'), mt = document.getElementById('mt');
const q = document.getElementById('q'), fp = document.getElementById('fp'), fe = document.getElementById('fe');
let sortKey = null, sortDir = 1;

const cell = (v, cls) => '<td class="' + cls + '">' + (v ? esc(v) : '<span class="none">—</span>') + '</td>';
function esc(s){ return String(s).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';'); }

function link(url, label){
  return url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + label + '</a>' : '';
}

function render(){
  const term = q.value.trim().toLowerCase();
  const needP = fp.getAttribute('aria-pressed') === 'true';
  const needE = fe.getAttribute('aria-pressed') === 'true';

  let rows = DATA.filter(r => {
    if (needP && !r.p) return false;
    if (needE && !r.e) return false;
    if (!term) return true;
    return (r.n + ' ' + r.p + ' ' + r.e + ' ' + r.c + ' ' + r.a).toLowerCase().includes(term);
  });

  if (sortKey){
    rows = rows.slice().sort((a, b) => {
      const x = a[sortKey], y = b[sortKey];
      if (x === y) return 0;
      if (x === null || x === '') return 1;      // blanks always sink
      if (y === null || y === '') return -1;
      return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * sortDir;
    });
  }

  tb.innerHTML = rows.map(r =>
    '<tr>' +
    cell(r.n, 'nm') +
    cell(r.p, 'ph') +
    (r.e ? '<td>' + link('mailto:' + r.e, esc(r.e)) + '</td>' : cell('', '')) +
    cell(r.c, '') +
    '<td class="rt">' + (r.r ? '<b>' + r.r + '</b> (' + (r.v ?? 0) + ')' : '<span class="none">—</span>') + '</td>' +
    cell(r.a, 'ad') +
    '<td class="soc">' + link(r.w, 'web') + link(r.m, 'map') + link(r.fb, 'fb') +
      link(r.ig, 'ig') + link(r.wa, 'wa') + '</td>' +
    '</tr>').join('');

  mt.hidden = rows.length > 0;
  ct.textContent = rows.length === DATA.length
    ? DATA.length + ' companies'
    : rows.length + ' of ' + DATA.length;
}

document.querySelectorAll('th[data-k]').forEach(th => th.addEventListener('click', () => {
  const k = th.dataset.k;
  sortDir = sortKey === k ? -sortDir : 1;
  sortKey = k;
  document.querySelectorAll('th').forEach(o => o.removeAttribute('data-dir'));
  th.dataset.dir = sortDir === 1 ? 'asc' : 'desc';
  render();
}));
[fp, fe].forEach(b => b.addEventListener('click', () => {
  b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
  render();
}));
q.addEventListener('input', render);
render();
</script>
</div></body></html>`;
}
