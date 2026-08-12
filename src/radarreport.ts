// gmap-review-radar report — one self-contained HTML file.
//
// Same visual language as gmap-recon's project dossier (src/gmapreport.ts): same
// tokens, same masthead, same offline rule — Windows-local fonts, rows embedded as
// JSON, no network at render or at view time.
//
// What differs is the unit. gmap-recon reports one row per COMPANY; this reports one
// row per REVIEW, with a per-company roll-up above it, because the question being
// answered is "what do this company's customers actually say".

import type { ReviewInput } from './radar.js';

export interface CompanyReviews {
  company: string;
  /** What the company's page said it has. Null when the header could not be read. */
  declared: number | null;
  complete: boolean;
  reviews: ReviewInput[];
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** `</script>` inside embedded JSON would close the tag early. */
const json = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c');

const pct = (n: number, of: number): number => (of ? Math.round((n / of) * 100) : 0);

export function renderReviewReport(projectId: string, files: CompanyReviews[]): string {
  const all = files.flatMap((f) => f.reviews.map((r) => ({ ...r, company: f.company })));

  const rated = all.filter((r) => typeof r.rating === 'number');
  const avg = rated.length ? rated.reduce((a, r) => a + (r.rating as number), 0) / rated.length : 0;
  const negative = rated.filter((r) => (r.rating as number) <= 2).length;
  const replied = all.filter((r) => r.replyText).length;
  const dist = [5, 4, 3, 2, 1].map((star) => ({
    star,
    n: rated.filter((r) => Math.round(r.rating as number) === star).length,
  }));
  const peak = Math.max(1, ...dist.map((d) => d.n));

  // Per-company roll-up. Sorted by review count: the companies with the most customer
  // feedback are the ones worth reading first.
  const perCompany = files
    .map((f) => {
      const rs = f.reviews.filter((r) => typeof r.rating === 'number');
      return {
        c: f.company,
        n: f.reviews.length,
        d: f.declared,
        ok: f.complete,
        a: rs.length ? Number((rs.reduce((s, r) => s + (r.rating as number), 0) / rs.length).toFixed(2)) : null,
        neg: rs.filter((r) => (r.rating as number) <= 2).length,
        rep: f.reviews.filter((r) => r.replyText).length,
      };
    })
    .sort((x, y) => y.n - x.n);

  const short = perCompany.filter((c) => !c.ok);

  const data = all.map((r) => ({
    c: r.company,
    a: r.author ?? '',
    s: r.rating ?? null,
    d: r.dateText ?? '',
    ad: r.approxDate ?? '',
    t: r.text ?? '',
    y: r.replyText ?? '',
    g: r.localGuide ? 1 : 0,
    l: r.lang ?? '',
  }));

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(projectId)} — review radar</title>
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
  body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:99;opacity:.35;
    background:repeating-linear-gradient(0deg,rgba(255,255,255,.025) 0 1px,transparent 1px 3px)}
  a{color:var(--cool);text-decoration:none}
  a:hover{text-decoration:underline}

  .wrap{max-width:1500px;margin:0 auto;padding:34px 26px 80px}

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

  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:1px;
    background:var(--line);border:1px solid var(--line);margin:26px 0}
  .tile{background:var(--ink-2);padding:20px 18px;animation:rise .5s cubic-bezier(.2,.8,.2,1) both}
  .tile:nth-child(2){animation-delay:.06s} .tile:nth-child(3){animation-delay:.12s}
  .tile:nth-child(4){animation-delay:.18s} .tile:nth-child(5){animation-delay:.24s}
  .tile b{display:block;font-family:var(--display);font-size:44px;line-height:1;color:#fff;font-weight:600}
  .tile.hot b{color:var(--signal)} .tile.bad b{color:var(--warn)}
  .tile span{display:block;margin-top:9px;font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim)}

  h2{font-family:var(--display);font-size:15px;letter-spacing:.2em;text-transform:uppercase;
    color:var(--dim);font-weight:600;margin:34px 0 12px}

  /* ---- star distribution ------------------------------------------------- */
  .dist{display:grid;gap:7px;margin:16px 0 4px}
  .drow{display:grid;grid-template-columns:38px 1fr 66px;gap:12px;align-items:center}
  .drow i{font-style:normal;color:var(--dim);font-size:11px;letter-spacing:.1em}
  .dtrack{height:9px;background:var(--ink-3);overflow:hidden}
  .dfill{height:100%;background:linear-gradient(90deg,var(--signal-dim),var(--signal));
    animation:grow 1s cubic-bezier(.2,.8,.2,1) both}
  .drow.low .dfill{background:linear-gradient(90deg,#7a2a1d,var(--warn))}
  .dnum{text-align:right;color:var(--text);font-size:11px}

  .note{border-left:3px solid var(--warn);background:rgba(255,95,69,.07);padding:14px 18px;margin:22px 0}
  .note h3{margin:0 0 6px;font-family:var(--display);font-size:15px;letter-spacing:.1em;
    text-transform:uppercase;color:var(--warn);font-weight:600}
  .note p{margin:0;color:var(--text);line-height:1.55}
  .note ul{margin:9px 0 0;padding-left:18px;color:var(--dim)}

  .toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:16px 0 12px}
  input[type=search]{flex:1;min-width:220px;background:var(--ink-2);border:1px solid var(--line-hot);
    color:var(--text);font-family:var(--mono);font-size:13px;padding:9px 12px}
  input[type=search]:focus{outline:none;border-color:var(--signal)}
  .tog{border:1px solid var(--line-hot);background:var(--ink-2);color:var(--dim);font-family:var(--mono);
    font-size:11px;letter-spacing:.12em;text-transform:uppercase;padding:9px 14px;cursor:pointer}
  .tog[aria-pressed=true]{border-color:var(--signal);color:var(--signal);background:rgba(255,176,0,.08)}
  .count{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);margin-left:auto}

  .scroll{overflow-x:auto;border:1px solid var(--line)}
  table{border-collapse:collapse;width:100%}
  th{position:sticky;top:0;z-index:2;background:var(--ink-3);text-align:left;padding:11px 13px;
    font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim);font-weight:400;
    border-bottom:1px solid var(--line-hot);cursor:pointer;white-space:nowrap;user-select:none}
  th:hover{color:var(--signal)}
  th[data-dir]::after{content:" ▲";color:var(--signal)}
  th[data-dir="desc"]::after{content:" ▼"}
  td{padding:10px 13px;border-bottom:1px solid var(--ink-3);vertical-align:top}
  tbody tr:nth-child(even){background:rgba(255,255,255,.014)}
  tbody tr:hover{background:rgba(255,176,0,.055)}
  .nm{color:#fff;max-width:230px}
  .st{white-space:nowrap;font-family:var(--display);font-size:15px}
  .st.hi{color:var(--cool)} .st.mid{color:var(--signal)} .st.lo{color:var(--warn)}
  .dt{color:var(--dim);white-space:nowrap;font-size:12px}
  .tx{max-width:640px;line-height:1.55;white-space:pre-wrap}
  .rp{max-width:340px;color:var(--dim);font-size:12px;line-height:1.5;white-space:pre-wrap}
  .none{color:#3d4a42}
  .tag{border:1px solid var(--line-hot);padding:0 5px;font-size:10px;color:var(--dim);margin-left:6px}
  .empty{padding:44px;text-align:center;color:var(--dim);letter-spacing:.16em;text-transform:uppercase}

  footer{margin-top:34px;padding-top:16px;border-top:1px solid var(--line);color:var(--dim);
    font-size:11px;display:flex;flex-wrap:wrap;gap:18px}

  @keyframes rise{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}
  @keyframes grow{from{width:0}}
  @media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
</head><body><div class="wrap">

<header>
  <div class="kicker">gmap-review-radar · customer voice</div>
  <h1>${esc(projectId)}</h1>
  <div class="sub">
    <span class="chip k">${all.length} reviews</span>
    <span class="chip">${files.length} companies</span>
    ${short.length ? `<span class="chip" style="border-color:var(--warn);color:var(--warn)">${short.length} incomplete</span>` : ''}
  </div>
</header>

<div class="tiles">
  <div class="tile hot"><b>${all.length}</b><span>reviews</span></div>
  <div class="tile"><b>${avg ? avg.toFixed(2) : '—'}</b><span>average star</span></div>
  <div class="tile bad"><b>${negative}</b><span>1–2 star</span></div>
  <div class="tile"><b>${pct(replied, all.length)}<small style="font-size:20px;color:var(--dim)">%</small></b><span>owner replied</span></div>
  <div class="tile"><b>${files.length}</b><span>companies read</span></div>
</div>

<h2>Rating spread</h2>
<div class="dist">
  ${dist
    .map(
      (d) => `<div class="drow${d.star <= 2 ? ' low' : ''}"><i>${d.star} ★</i>
    <div class="dtrack"><div class="dfill" style="width:${pct(d.n, peak)}%"></div></div>
    <div class="dnum">${d.n} · ${pct(d.n, rated.length)}%</div></div>`,
    )
    .join('')}
</div>

${
  short.length
    ? `<div class="note"><h3>Incomplete</h3>
  <p>These companies gave fewer reviews than their own page declared, so their numbers
  below are understated. Delete their files from the project's <code>reviews\\</code>
  folder and re-run radar to retry them.</p>
  <ul>${short.map((c) => `<li>${esc(c.c)} — ${c.n} of ${c.d ?? '?'}</li>`).join('')}</ul>
</div>`
    : ''
}

<h2>By company</h2>
<div class="scroll">
  <table>
    <thead><tr>
      <th data-c="c">Company</th><th data-c="n">Reviews</th><th data-c="a">Average</th>
      <th data-c="neg">1–2 star</th><th data-c="rep">Replied</th>
    </tr></thead>
    <tbody id="cb"></tbody>
  </table>
</div>

<h2>Every review</h2>
<div class="toolbar">
  <input type="search" id="q" placeholder="Filter by company, author or review text…" autocomplete="off">
  <button class="tog" id="fl" aria-pressed="false">1–2 star only</button>
  <button class="tog" id="ft" aria-pressed="false">Has text</button>
  <button class="tog" id="fr" aria-pressed="false">Has reply</button>
  <span class="count" id="ct"></span>
</div>

<div class="scroll">
  <table>
    <thead><tr>
      <th data-k="c">Company</th><th data-k="s">Star</th><th data-k="ad">When</th>
      <th data-k="a">Author</th><th data-k="t">Review</th><th>Owner reply</th>
    </tr></thead>
    <tbody id="tb"></tbody>
  </table>
  <div class="empty" id="mt" hidden>No reviews match that filter</div>
</div>

<footer>
  <span>Generated ${esc(new Date().toLocaleString())}</span>
  <span>${all.length} reviews embedded · offline-ready</span>
  <span>Dates are Google's relative ages — "when" is approximate</span>
</footer>

<script>
const DATA = ${json(data)};
const COMPANIES = ${json(perCompany)};
const tb = document.getElementById('tb'), cb = document.getElementById('cb');
const ct = document.getElementById('ct'), mt = document.getElementById('mt');
const q = document.getElementById('q');
const fl = document.getElementById('fl'), ft = document.getElementById('ft'), fr = document.getElementById('fr');
let sortKey = null, sortDir = 1, cKey = null, cDir = 1;

function esc(s){ return String(s).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';'); }
const cell = (v, cls) => '<td class="' + cls + '">' + (v ? esc(v) : '<span class="none">—</span>') + '</td>';
const tone = (s) => s >= 4 ? 'hi' : s == 3 ? 'mid' : 'lo';

function sortRows(rows, key, dir){
  if (!key) return rows;
  return rows.slice().sort((a, b) => {
    const x = a[key], y = b[key];
    if (x === y) return 0;
    if (x === null || x === '') return 1;   // blanks always sink
    if (y === null || y === '') return -1;
    return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
  });
}

function renderCompanies(){
  cb.innerHTML = sortRows(COMPANIES, cKey, cDir).map(c =>
    '<tr>' +
    '<td class="nm">' + esc(c.c) + (c.ok ? '' : '<span class="tag">' + c.n + ' of ' + (c.d ?? '?') + '</span>') + '</td>' +
    '<td>' + c.n + '</td>' +
    '<td class="st ' + (c.a ? tone(c.a) : '') + '">' + (c.a ?? '—') + '</td>' +
    '<td>' + c.neg + '</td>' +
    '<td>' + (c.n ? Math.round(c.rep / c.n * 100) : 0) + '%</td>' +
    '</tr>').join('');
}

function render(){
  const term = q.value.trim().toLowerCase();
  const lowOnly = fl.getAttribute('aria-pressed') === 'true';
  const textOnly = ft.getAttribute('aria-pressed') === 'true';
  const replyOnly = fr.getAttribute('aria-pressed') === 'true';

  let rows = DATA.filter(r => {
    if (lowOnly && !(r.s !== null && r.s <= 2)) return false;
    if (textOnly && !r.t) return false;
    if (replyOnly && !r.y) return false;
    if (!term) return true;
    return (r.c + ' ' + r.a + ' ' + r.t).toLowerCase().includes(term);
  });

  rows = sortRows(rows, sortKey, sortDir);

  tb.innerHTML = rows.map(r =>
    '<tr>' +
    cell(r.c, 'nm') +
    '<td class="st ' + (r.s ? tone(r.s) : '') + '">' + (r.s ? r.s + ' ★' : '<span class="none">—</span>') + '</td>' +
    '<td class="dt">' + esc(r.d) + (r.ad ? '<br><span class="none">' + esc(r.ad) + '</span>' : '') + '</td>' +
    '<td class="dt">' + esc(r.a) + (r.g ? '<span class="tag">guide</span>' : '') + '</td>' +
    cell(r.t, 'tx') +
    cell(r.y, 'rp') +
    '</tr>').join('');

  mt.hidden = rows.length > 0;
  ct.textContent = rows.length === DATA.length
    ? DATA.length + ' reviews'
    : rows.length + ' of ' + DATA.length;
}

document.querySelectorAll('th[data-k]').forEach(th => th.addEventListener('click', () => {
  const k = th.dataset.k;
  sortDir = sortKey === k ? -sortDir : 1;
  sortKey = k;
  document.querySelectorAll('th[data-k]').forEach(o => o.removeAttribute('data-dir'));
  th.dataset.dir = sortDir === 1 ? 'asc' : 'desc';
  render();
}));
document.querySelectorAll('th[data-c]').forEach(th => th.addEventListener('click', () => {
  const k = th.dataset.c;
  cDir = cKey === k ? -cDir : 1;
  cKey = k;
  document.querySelectorAll('th[data-c]').forEach(o => o.removeAttribute('data-dir'));
  th.dataset.dir = cDir === 1 ? 'asc' : 'desc';
  renderCompanies();
}));
[fl, ft, fr].forEach(b => b.addEventListener('click', () => {
  b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
  render();
}));
q.addEventListener('input', render);
renderCompanies();
render();
</script>
</div></body></html>`;
}
