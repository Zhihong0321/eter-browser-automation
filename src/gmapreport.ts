// gmap-recon project report — a single self-contained HTML file.
//
// No network at render OR at view time: every font is resolved from the device, and
// the lead rows are embedded as JSON. The file can be copied to a USB stick, mailed
// as an attachment, or opened on a phone with no signal and still work.
//
// Rows render client-side so filtering and sorting stay instant at 1,000+ leads.
// Includes the interactive Deep Research dossier.
//
// ---------------------------------------------------------------------------------
// Responsive contract
//
// This report is read on a laptop at a desk AND on a phone in a car park, so the
// layout is not one design scaled down. Under 1060px the lead table stops being a
// table: `thead` is hidden and every row becomes a card whose cells carry their own
// label via `data-label`. The alternative — eight columns needing 1000px inside a
// horizontal scroller — means dragging sideways to reach the phone number, which is
// the one thing the reader came for. From 620px up the cards sit two abreast, so a
// tablet gets neither a cramped grid nor a column of stretched rows. Cells with no
// value are dropped entirely in card mode rather than rendered as an em dash, so a
// card states what the company HAS.
//
// No viewport drags sideways, and three numbers enforce that together: the table's
// 1000px minimum, the 1060px card breakpoint, and the 26px wrap padding. At 1061px
// the content box is 1009px, which clears the minimum. Change one and a band of
// widths starts scrolling again.
//
// Sorting has to survive that change. The column headers ARE the sort control on
// desktop, and hiding them would silently remove sorting, so a <select> carrying the
// same state renders in the toolbar below the breakpoint, and clicking a header keeps
// it in step.
//
// Theme follows the device: dark is the house look and stays the default, but a
// phone in daylight is unreadable in it, so `prefers-color-scheme` is honoured and
// an explicit toggle overrides it. Every colour is a token — nothing is hardcoded
// past `:root` — which is what makes one palette swap cover the whole document.
//
// Type is split by job rather than being mono everywhere: mono for values you read
// as data (phones, ratings, registration numbers, the micro-labels) and the system
// sans for prose (names, addresses, summaries, risk text). 13px mono for a
// four-line address is what made the old report hard going on a small screen.
// ---------------------------------------------------------------------------------

import type { BusinessRow } from './leads.js';
import type { CompanyDossier } from './enrich/types.js';
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

export function renderReport(
  meta: ProjectMeta,
  rows: BusinessRow[],
  dossiers: CompanyDossier[] = [],
): string {
  const s = meta.stats;
  const searchPct = s.searchesTotal ? Math.round((s.searchesDone / s.searchesTotal) * 100) : 0;
  const enriched = rows.filter((r) => r.enrichStatus !== 'pending').length;
  const enrichPct = rows.length ? Math.round((enriched / rows.length) * 100) : 0;

  // Only dossiers whose company is actually in this report — a project store can
  // outlive the row set it was built from, and shipping orphans just inflates the file.
  const known = new Set(rows.map((r) => r.placeId));
  const dossierMap: Record<string, CompanyDossier> = {};
  for (const d of dossiers) {
    if (known.has(d.placeId)) dossierMap[d.placeId] = d;
  }
  const dossierCount = Object.keys(dossierMap).length;

  const data = rows.map((r) => ({
    id: r.placeId,
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
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>${esc(meta.id)} — gmap-recon</title>
<style>
  /* ---- tokens: dark is the default identity ------------------------------- */
  :root{
    --bg:#0b0d0c; --bg-2:#121614; --bg-3:#1a201d; --bg-card:#121614;
    --line:#2a332e; --line-2:#3d4a42;
    --dim:#7f8d84; --text:#c9d4cd; --strong:#ffffff;
    --signal:#ffb000; --signal-2:#8a6108; --signal-soft:rgba(255,176,0,.09);
    --cool:#4fd6c4; --cool-soft:rgba(79,214,196,.09);
    --warn:#ff6a51; --warn-soft:rgba(255,106,81,.09);
    --grain:rgba(255,255,255,.022);
    --shadow:0 24px 60px rgba(0,0,0,.75);
    --mono:"Cascadia Code","Cascadia Mono",Consolas,ui-monospace,"SF Mono",Menlo,"Roboto Mono","DejaVu Sans Mono",monospace;
    --display:"Bahnschrift","DIN Alternate","Segoe UI Variable Display","Roboto Condensed","Arial Narrow",system-ui,sans-serif;
    --sans:"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,Roboto,"Helvetica Neue",Arial,sans-serif;
    --pad:26px;
  }
  /* Light palette. Duplicated across the two selectors below on purpose: one has to
     live inside a media query, so they cannot be merged into a single rule. */
  @media (prefers-color-scheme: light){
    :root:not([data-theme="dark"]){
      --bg:#f4f6f4; --bg-2:#ffffff; --bg-3:#e9ede9; --bg-card:#ffffff;
      --line:#d5dcd7; --line-2:#b3bdb6;
      --dim:#5a675f; --text:#18201c; --strong:#000000;
      --signal:#9a6000; --signal-2:#c08810; --signal-soft:rgba(154,96,0,.08);
      --cool:#0c7267; --cool-soft:rgba(12,114,103,.08);
      --warn:#b52f1b; --warn-soft:rgba(181,47,27,.08);
      --grain:rgba(0,0,0,.016);
      --shadow:0 20px 50px rgba(20,30,25,.18);
    }
  }
  :root[data-theme="light"]{
    --bg:#f4f6f4; --bg-2:#ffffff; --bg-3:#e9ede9; --bg-card:#ffffff;
    --line:#d5dcd7; --line-2:#b3bdb6;
    --dim:#5a675f; --text:#18201c; --strong:#000000;
    --signal:#9a6000; --signal-2:#c08810; --signal-soft:rgba(154,96,0,.08);
    --cool:#0c7267; --cool-soft:rgba(12,114,103,.08);
    --warn:#b52f1b; --warn-soft:rgba(181,47,27,.08);
    --grain:rgba(0,0,0,.016);
    --shadow:0 20px 50px rgba(20,30,25,.18);
  }

  *{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%}
  html,body{margin:0;background:var(--bg);color:var(--text);
    font-family:var(--sans);font-size:15px;line-height:1.5}
  /* Grain + scanline: gives the ground depth without an image request. */
  body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:99;
    background:repeating-linear-gradient(0deg,var(--grain) 0 1px,transparent 1px 3px)}
  a{color:var(--cool);text-decoration:none}
  a:hover{text-decoration:underline}
  /* Long URLs and emails are the usual cause of a sideways-scrolling phone page. */
  a,td,p,pre,li,dd{overflow-wrap:anywhere}
  :focus-visible{outline:2px solid var(--signal);outline-offset:2px}

  .wrap{max-width:1500px;margin:0 auto;padding:30px var(--pad) 90px}
  .mono{font-family:var(--mono)}

  /* ---- masthead ---------------------------------------------------------- */
  header{border-bottom:2px solid var(--signal);padding-bottom:18px;margin-bottom:6px;
    animation:rise .5s cubic-bezier(.2,.8,.2,1) both}
  .kicker{font-family:var(--mono);font-size:10.5px;letter-spacing:.3em;text-transform:uppercase;
    color:var(--signal-2);display:flex;gap:14px;align-items:center}
  .kicker::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--line-2),transparent)}
  .kicker button{flex:none}
  h1{font-family:var(--display);font-weight:600;font-size:clamp(28px,7vw,58px);line-height:.98;
    letter-spacing:-.01em;margin:12px 0 0;color:var(--strong);text-transform:uppercase;overflow-wrap:anywhere}
  .sub{margin-top:14px;display:flex;flex-wrap:wrap;gap:7px;align-items:center}
  .chip{font-family:var(--mono);border:1px solid var(--line-2);padding:3px 9px;font-size:11px;
    letter-spacing:.05em;color:var(--text);background:var(--bg-2)}
  .chip.k{border-color:var(--signal-2);color:var(--signal)}
  .chip.warn{border-color:var(--warn);color:var(--warn)}
  .badge{font-family:var(--display);font-size:13px;letter-spacing:.2em;
    text-transform:uppercase;padding:5px 14px;border:1px solid currentColor}
  .badge.done{color:var(--cool)} .badge.live{color:var(--signal)}
  .badge.warn{color:var(--warn)} .badge.idle{color:var(--dim)}
  /* Theme toggle: a real control, so it gets a real tap target. */
  .theme{background:var(--bg-2);border:1px solid var(--line-2);color:var(--dim);
    font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;
    padding:7px 11px;cursor:pointer;min-height:34px}
  .theme:hover{color:var(--signal);border-color:var(--signal-2)}

  /* ---- stats ------------------------------------------------------------- */
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(146px,1fr));gap:1px;
    background:var(--line);border:1px solid var(--line);margin:24px 0}
  .tile{background:var(--bg-2);padding:18px 16px;animation:rise .5s cubic-bezier(.2,.8,.2,1) both}
  .tile:nth-child(2){animation-delay:.06s} .tile:nth-child(3){animation-delay:.12s}
  .tile:nth-child(4){animation-delay:.18s}
  .tile b{display:block;font-family:var(--display);font-size:clamp(30px,8vw,44px);line-height:1;
    color:var(--strong);font-weight:600}
  .tile b small{font-size:.45em;color:var(--dim)}
  .tile.hot b{color:var(--signal)}
  .tile span{display:block;margin-top:8px;font-family:var(--mono);font-size:10px;letter-spacing:.18em;
    text-transform:uppercase;color:var(--dim)}

  /* ---- progress ---------------------------------------------------------- */
  .bars{display:grid;gap:15px;margin:24px 0}
  .bar b{font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;
    color:var(--dim);font-weight:400;display:flex;gap:10px}
  .bar b i{font-style:normal;margin-left:auto;color:var(--text)}
  .track{height:7px;background:var(--bg-3);margin-top:8px;overflow:hidden}
  .fill{height:100%;background:linear-gradient(90deg,var(--signal-2),var(--signal));
    animation:grow 1s cubic-bezier(.2,.8,.2,1) both}
  .fill.cool{background:linear-gradient(90deg,var(--cool),var(--cool))}

  /* ---- notices ----------------------------------------------------------- */
  .note{border-left:3px solid var(--warn);background:var(--warn-soft);padding:14px 16px;margin:20px 0}
  .note h3{margin:0 0 6px;font-family:var(--display);font-size:15px;letter-spacing:.09em;
    text-transform:uppercase;color:var(--warn);font-weight:600}
  .note p{margin:0;line-height:1.55}
  .note ul{margin:9px 0 0;padding-left:18px;color:var(--dim)}
  code{font-family:var(--mono);font-size:.9em;background:var(--bg-3);padding:1px 5px}

  /* ---- toolbar ----------------------------------------------------------- */
  .toolbar{display:flex;gap:9px;flex-wrap:wrap;align-items:center;margin:28px 0 12px}
  input[type=search],select{background:var(--bg-2);border:1px solid var(--line-2);
    color:var(--text);font-family:var(--sans);font-size:15px;padding:10px 12px;min-height:44px}
  input[type=search]{flex:1 1 220px;min-width:0}
  select{flex:1 1 180px}
  input[type=search]:focus,select:focus{outline:none;border-color:var(--signal)}
  .tog{border:1px solid var(--line-2);background:var(--bg-2);color:var(--dim);font-family:var(--mono);
    font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:10px 14px;cursor:pointer;min-height:44px}
  .tog[aria-pressed=true]{border-color:var(--signal);color:var(--signal);background:var(--signal-soft)}
  .count{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;
    color:var(--dim);margin-left:auto}
  #sortwrap{display:none}

  /* ---- lead table (desktop) ---------------------------------------------- */
  .scroll{overflow-x:auto;border:1px solid var(--line)}
  /* No min-width: the grid is fluid down to its own intrinsic minimum (~993px with
     the links column allowed to wrap), which clears the narrowest viewport that ever
     sees it — 1061px, one past the card breakpoint, where the content box is 993px
     after 2×26px of padding AND ~17px of vertical scrollbar. Declaring a 1000px floor
     is what put a 7px scroll back in: the scrollbar is easy to forget and it is
     exactly the width that a hardcoded minimum fails by. .scroll keeps overflow-x
     as a guard for a narrow zoom, but nothing routine should reach it. */
  table.leads{border-collapse:collapse;width:100%}
  .leads th{position:sticky;top:0;z-index:2;background:var(--bg-3);text-align:left;padding:12px 13px;
    font-family:var(--mono);font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--dim);
    font-weight:400;border-bottom:1px solid var(--line-2);cursor:pointer;white-space:nowrap;user-select:none}
  .leads th:hover{color:var(--signal)}
  .leads th[data-dir]{color:var(--signal)}
  .leads th[data-dir]::after{content:" ▲"}
  .leads th[data-dir="desc"]::after{content:" ▼"}
  .leads td{padding:11px 13px;border-bottom:1px solid var(--line);vertical-align:top}
  .leads tbody tr:nth-child(even){background:var(--grain)}
  .leads tbody tr:hover{background:var(--signal-soft)}
  .nm{color:var(--strong);font-weight:500;max-width:280px}
  .ph{font-family:var(--mono);white-space:nowrap}
  .ph a{color:var(--signal)}
  .ad{color:var(--dim);max-width:260px;font-size:13.5px}
  .rt{font-family:var(--mono);white-space:nowrap;color:var(--dim)}
  .rt b{color:var(--text);font-weight:500}
  /* Wraps rather than nowrap: five link chips held on one line were 178px of the
     table's intrinsic width, and that alone decided whether the grid fitted. */
  .soc a{display:inline-block;border:1px solid var(--line-2);padding:2px 6px;margin:0 3px 3px 0;
    font-family:var(--mono);font-size:10px;color:var(--dim)}
  .soc a:hover{border-color:var(--cool);color:var(--cool);text-decoration:none}
  .dr-btn{background:var(--signal-soft);border:1px solid var(--signal);color:var(--signal);
    font-family:var(--mono);font-size:11px;letter-spacing:.06em;padding:7px 10px;cursor:pointer;
    white-space:nowrap;transition:background .15s ease,color .15s ease}
  .dr-btn:hover{background:var(--signal);color:var(--bg)}
  /* A company already researched is a different action — "read what we found" rather
     than "go find something" — so it gets the report's own colour, not the amber
     that means "this will take two minutes and hit the network". */
  .dr-btn.done{background:var(--cool-soft);border-color:var(--cool);color:var(--cool)}
  .dr-btn.done:hover{background:var(--cool);color:var(--bg)}
  .none{color:var(--line-2)}
  .empty{padding:44px 20px;text-align:center;color:var(--dim);font-family:var(--mono);
    letter-spacing:.14em;text-transform:uppercase}

  /* ---- dossier ----------------------------------------------------------- */
  .modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.72);
    z-index:999;display:none;align-items:center;justify-content:center;padding:20px}
  .modal-backdrop.open{display:flex}
  .modal{background:var(--bg-2);border:1px solid var(--line-2);border-top:3px solid var(--signal);
    max-width:900px;width:100%;max-height:90vh;display:flex;flex-direction:column;
    box-shadow:var(--shadow)}
  /* Sticky bar, not an absolutely positioned ✕: the dossier is long, and a close
     control that scrolls off the top strands a phone reader mid-document. */
  .modal-bar{position:sticky;top:0;z-index:3;display:flex;gap:12px;align-items:center;
    padding:14px 18px;border-bottom:1px solid var(--line);background:var(--bg-3)}
  .modal-bar strong{font-family:var(--display);font-size:clamp(17px,4.4vw,24px);line-height:1.15;
    color:var(--strong);text-transform:uppercase;font-weight:600;overflow-wrap:anywhere}
  .modal-close{margin-left:auto;flex:none;background:var(--bg-2);border:1px solid var(--line-2);
    color:var(--dim);font-size:17px;width:44px;height:44px;cursor:pointer;line-height:1}
  .modal-close:hover{color:var(--strong);border-color:var(--warn)}
  .modal-body{overflow-y:auto;padding:20px 18px 26px;-webkit-overflow-scrolling:touch}
  .score-badge{display:inline-block;font-family:var(--mono);padding:4px 10px;font-size:11px;
    letter-spacing:.08em;background:var(--cool-soft);border:1px solid var(--cool);color:var(--cool)}
  .dossier-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(238px,1fr));gap:14px;margin:18px 0}
  .dossier-card{background:var(--bg-3);border:1px solid var(--line);padding:14px 16px}
  .dossier-card.wide{grid-column:1/-1}
  .dossier-card h4{margin:0 0 10px;font-family:var(--mono);font-size:10.5px;letter-spacing:.15em;
    text-transform:uppercase;color:var(--signal)}
  .dossier-card p{margin:5px 0;font-size:13.5px;line-height:1.45}
  .dossier-summary{background:var(--bg-3);border-left:3px solid var(--signal);padding:16px;margin:18px 0}
  .dossier-summary h3{margin:0 0 10px;font-family:var(--mono);font-size:11px;letter-spacing:.15em;
    color:var(--signal);text-transform:uppercase}
  .dossier-summary pre{margin:0;white-space:pre-wrap;font-family:var(--sans);font-size:14px;line-height:1.6}
  .facts{display:grid;grid-template-columns:auto 1fr;gap:5px 12px;font-size:13.5px;margin:0}
  .facts dt{font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;
    color:var(--dim);white-space:nowrap;padding-top:2px}
  .facts dd{margin:0}
  .facts dd.gap{color:var(--warn);font-style:italic}
  .ev{margin:0;padding-left:17px;font-size:13.5px;line-height:1.55}
  .ev li{margin-bottom:7px}
  .ev .src{color:var(--dim);font-family:var(--mono);font-size:11.5px}
  .ev .when{color:var(--cool);font-family:var(--mono);font-size:11.5px}

  /* ---- tables inside the dossier ----------------------------------------- */
  table.resp{width:100%;border-collapse:collapse;font-size:13px}
  table.resp th{text-align:left;padding:6px 10px 6px 0;border-bottom:1px solid var(--line-2);
    font-family:var(--mono);font-size:10px;letter-spacing:.13em;text-transform:uppercase;
    color:var(--dim);font-weight:400}
  table.resp td{padding:7px 10px 7px 0;border-bottom:1px solid var(--line);vertical-align:top}
  table.resp td b{color:var(--strong);font-weight:500}
  table.resp .src{color:var(--dim);font-family:var(--mono);font-size:11.5px}
  .stages td.st{font-family:var(--mono);white-space:nowrap;letter-spacing:.08em;text-transform:uppercase;font-size:11px}
  .st-ok{color:var(--cool)} .st-empty{color:var(--dim)}
  .st-skipped{color:var(--signal-2)} .st-failed{color:var(--warn)}
  .stages td.ms{font-family:var(--mono);color:var(--dim);white-space:nowrap;font-size:11.5px}

  /* The brief is ~18KB — available, but it must not own the dossier. */
  details.brief{margin:16px 0;border:1px solid var(--line);background:var(--bg-3)}
  details.brief>summary{padding:13px 14px;cursor:pointer;font-family:var(--mono);font-size:11px;
    letter-spacing:.13em;text-transform:uppercase;color:var(--signal);user-select:none;min-height:44px;
    display:flex;align-items:center}
  details.brief>summary:hover{background:var(--signal-soft)}
  details.brief .inner{padding:0 14px 14px}
  details.brief pre{margin:0;white-space:pre-wrap;font-family:var(--sans);font-size:13.5px;line-height:1.6;
    max-height:60vh;overflow-y:auto}
  .nlm-ask{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
  .nlm-ask input{flex:1 1 200px;min-width:0;background:var(--bg-2);border:1px solid var(--line-2);
    color:var(--text);font-family:var(--sans);font-size:14px;padding:9px 11px;min-height:44px}

  footer{margin-top:34px;padding-top:16px;border-top:1px solid var(--line);color:var(--dim);
    font-family:var(--mono);font-size:11px;display:flex;flex-wrap:wrap;gap:8px 18px}

  @keyframes rise{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}
  @keyframes grow{from{width:0}}
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}

  /* ---- CARD MODE: below 1000px the lead table stops being a table --------- */
  /*
     The breakpoint is 1060px, not a phone width, because the grid needs 1000px plus page
     avoid crushing eight columns. Between those two figures a real table can only be
     served by a horizontal scroller, and dragging sideways to reach a phone number is
     the single worst thing this report can ask of a reader. Cards reflow instead, and
     from 620px up they sit two abreast so a tablet is not a column of stretched rows.
  */
  @media (max-width:1060px){
    #sortwrap{display:flex}
    .scroll{overflow-x:visible;border:0}
    table.leads{min-width:0}
    .leads thead{display:none}
    .leads,.leads tbody,.leads tr,.leads td{display:block;width:100%}
    .leads tr{border:1px solid var(--line);border-left:3px solid var(--signal-2);
      background:var(--bg-card);margin-bottom:11px;padding:14px 15px}
    .leads tbody tr:nth-child(even){background:var(--bg-card)}
    .leads tbody tr:hover{background:var(--bg-card);border-left-color:var(--signal)}
    .leads td{border:0;padding:4px 0;max-width:none;
      display:grid;grid-template-columns:76px 1fr;gap:12px;align-items:start}
    .leads td::before{content:attr(data-label);font-family:var(--mono);font-size:9.5px;
      letter-spacing:.13em;text-transform:uppercase;color:var(--dim);padding-top:4px}
    /* A card leads with the name, so it drops the label and takes the headline size. */
    .leads td.nm{display:block;font-family:var(--display);font-size:19px;line-height:1.2;
      text-transform:uppercase;padding:0 0 8px}
    .leads td.nm::before{display:none}
    .leads td.ph{white-space:normal}
    .leads td.ad{font-size:14px}
    .leads td.soc{white-space:normal}
    /* An absent field is omitted rather than shown as an em dash — a card should
       state what the company HAS, not enumerate what it lacks. */
    .leads td.dashed{display:none}
    .leads td.act{display:block;margin-top:11px}
    .leads td.act::before{display:none}
    .leads td.act .dr-btn{width:100%;padding:12px;font-size:12px;min-height:46px}
    .soc a{padding:6px 9px;font-size:11px}
  }

  /* Two cards abreast once there is room for them. tbody becomes the grid; the rows
     are already display:block, so they drop in as grid items. */
  @media (min-width:620px) and (max-width:1060px){
    .leads tbody{display:grid;grid-template-columns:repeat(auto-fit,minmax(288px,1fr));
      gap:12px;align-items:start}
    .leads tr{margin-bottom:0;height:100%}
  }

  /* ---- PHONE ------------------------------------------------------------- */
  @media (max-width:760px){
    :root{--pad:15px}
    body{font-size:15.5px}
    .count{margin-left:0;flex:1 1 100%}

    /* The dossier becomes a full-height sheet rather than a floating dialog. */
    .modal-backdrop{padding:0;align-items:stretch}
    .modal{max-width:none;max-height:none;height:100%;border:0;border-top:3px solid var(--signal)}
    .modal-body{padding:16px 15px calc(30px + env(safe-area-inset-bottom))}
    .dossier-grid{grid-template-columns:1fr;gap:11px;margin:15px 0}
    .facts{grid-template-columns:1fr;gap:1px 0}
    .facts dt{padding-top:8px}
    .facts dd{padding-bottom:4px}

    /* Dossier tables stack too, same data-label mechanism as the lead cards. */
    table.resp thead{display:none}
    table.resp,table.resp tbody,table.resp tr,table.resp td{display:block;width:100%}
    table.resp tr{border:1px solid var(--line);background:var(--bg-2);padding:11px 12px;margin-bottom:9px}
    table.resp td{border:0;padding:3px 0;display:grid;grid-template-columns:72px 1fr;gap:10px}
    table.resp td::before{content:attr(data-label);font-family:var(--mono);font-size:9.5px;
      letter-spacing:.13em;text-transform:uppercase;color:var(--dim);padding-top:3px}
    table.resp td.dashed{display:none}
    details.brief pre{max-height:none}
  }

  @media print{
    body::before,.toolbar,.modal-backdrop,.theme{display:none!important}
    html,body{background:#fff;color:#000}
    .scroll{overflow:visible}
  }
</style>
</head><body><div class="wrap">

<header>
  <div class="kicker">
    <span>gmap-recon · project dossier</span>
    <button class="theme" id="themebtn" type="button" aria-live="polite">Theme</button>
  </div>
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
  <div class="tile"><b>${s.searchesDone}<small>/${s.searchesTotal}</small></b><span>searches run</span></div>
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
  <input type="search" id="q" placeholder="Filter by name, phone, category, address…" autocomplete="off"
    aria-label="Filter companies">
  <button class="tog" id="fp" type="button" aria-pressed="false">Has phone</button>
  <button class="tog" id="fe" type="button" aria-pressed="false">Has email</button>
  <label id="sortwrap"><span class="none" style="position:absolute;left:-9999px">Sort by</span>
    <select id="sortsel" aria-label="Sort by">
      <option value="">Sort — original order</option>
      <option value="n:1">Company A→Z</option>
      <option value="n:-1">Company Z→A</option>
      <option value="r:-1">Rating, high→low</option>
      <option value="v:-1">Reviews, most first</option>
      <option value="c:1">Category A→Z</option>
      <option value="a:1">Address A→Z</option>
    </select>
  </label>
  <span class="count" id="ct"></span>
</div>

<div class="scroll">
  <table class="leads">
    <thead><tr>
      <th data-k="n">Company</th><th data-k="p">Phone</th><th data-k="e">Email</th>
      <th data-k="c">Category</th><th data-k="r">Rating</th><th data-k="a">Address</th>
      <th>Links</th>
      <th>Deep Research</th>
    </tr></thead>
    <tbody id="tb"></tbody>
  </table>
  <div class="empty" id="mt" hidden>No companies match that filter</div>
</div>

<div class="modal-backdrop" id="modal">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div class="modal-bar">
      <strong id="modal-title"></strong>
      <button class="modal-close" id="modal-close" type="button" aria-label="Close dossier">✕</button>
    </div>
    <div class="modal-body" id="modal-content"></div>
  </div>
</div>

<footer>
  <span>Generated ${esc(new Date().toLocaleString())}</span>
  <span>Created ${esc(meta.createdAt.slice(0, 16).replace('T', ' '))}</span>
  <span>${rows.length} rows${dossierCount ? ` · ${dossierCount} deep-research dossier${dossierCount === 1 ? '' : 's'}` : ''} embedded · offline-ready</span>
</footer>

<script>
const DATA = ${json(data)};
// Dossiers travel INSIDE the file, keyed by placeId.
//
// They used to be fetched from the daemon at view time, which meant the report was
// only self-contained for the lead table: mail it, or open it from a USB stick, and
// every company opened to an empty modal while the footer claimed "offline-ready".
// The deep research is the expensive half of this pipeline and the half worth
// sending to someone, so it is embedded like the rows are.
const DOSSIERS = ${json(dossierMap)};
const tb = document.getElementById('tb'), ct = document.getElementById('ct'), mt = document.getElementById('mt');
const q = document.getElementById('q'), fp = document.getElementById('fp'), fe = document.getElementById('fe');
const sortsel = document.getElementById('sortsel');
const modal = document.getElementById('modal');
const modalContent = document.getElementById('modal-content');
const modalTitle = document.getElementById('modal-title');
let sortKey = null, sortDir = 1;

function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';'); }

/* A missing value is marked so mobile can drop the whole cell. */
function cell(v, cls, label){
  const has = v !== null && v !== undefined && v !== '';
  return '<td class="' + cls + (has ? '' : ' dashed') + '" data-label="' + esc(label) + '">' +
    (has ? esc(v) : '<span class="none">—</span>') + '</td>';
}
function link(url, label){
  return url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(label) + '</a>' : '';
}
/* tel: makes the number tappable, which is the point of reading this on a phone. */
function telCell(v){
  if (!v) return '<td class="ph dashed" data-label="Phone"><span class="none">—</span></td>';
  return '<td class="ph" data-label="Phone"><a href="tel:' + esc(String(v).replace(/[^\\d+]/g, '')) +
    '">' + esc(v) + '</a></td>';
}

// ---- theme -----------------------------------------------------------------
// Three states: unset follows the device, "dark"/"light" override it. The choice is
// remembered so it survives a reload of a file opened from disk.
const themebtn = document.getElementById('themebtn');
function systemDark(){ return !window.matchMedia || !window.matchMedia('(prefers-color-scheme: light)').matches; }
function applyTheme(t){
  if (t) document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
  const dark = t ? t === 'dark' : systemDark();
  themebtn.textContent = dark ? '☀ Light' : '☾ Dark';
}
let stored = null;
try { stored = localStorage.getItem('gmap-report-theme'); } catch (e) {}
applyTheme(stored);
themebtn.addEventListener('click', () => {
  const dark = document.documentElement.getAttribute('data-theme')
    ? document.documentElement.getAttribute('data-theme') === 'dark'
    : systemDark();
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('gmap-report-theme', next); } catch (e) {}
});

// ---- lead list -------------------------------------------------------------
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
      if (x === null || x === '') return 1;
      if (y === null || y === '') return -1;
      return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * sortDir;
    });
  }

  tb.innerHTML = rows.map(r =>
    '<tr>' +
    cell(r.n, 'nm', 'Company') +
    telCell(r.p) +
    (r.e
      ? '<td data-label="Email">' + link('mailto:' + r.e, r.e) + '</td>'
      : '<td class="dashed" data-label="Email"><span class="none">—</span></td>') +
    cell(r.c, '', 'Category') +
    (r.r
      ? '<td class="rt" data-label="Rating"><b>' + r.r + '</b> (' + (r.v ?? 0) + ')</td>'
      : '<td class="rt dashed" data-label="Rating"><span class="none">—</span></td>') +
    cell(r.a, 'ad', 'Address') +
    '<td class="soc' + (r.w || r.m || r.fb || r.ig || r.wa ? '' : ' dashed') + '" data-label="Links">' +
      link(r.w, 'web') + link(r.m, 'map') + link(r.fb, 'fb') + link(r.ig, 'ig') + link(r.wa, 'wa') +
      (r.w || r.m || r.fb || r.ig || r.wa ? '' : '<span class="none">—</span>') + '</td>' +
    researchCell(r) +
    '</tr>').join('');

  mt.hidden = rows.length > 0;
  ct.textContent = rows.length === DATA.length
    ? DATA.length + ' companies'
    : rows.length + ' of ' + DATA.length;
}

function setSort(k, dir){
  sortKey = k; sortDir = dir;
  document.querySelectorAll('.leads th').forEach(o => o.removeAttribute('data-dir'));
  if (k){
    const th = document.querySelector('.leads th[data-k="' + k + '"]');
    if (th) th.dataset.dir = dir === 1 ? 'asc' : 'desc';
  }
  render();
}

document.querySelectorAll('.leads th[data-k]').forEach(th => th.addEventListener('click', () => {
  const k = th.dataset.k;
  const dir = sortKey === k ? -sortDir : 1;
  setSort(k, dir);
  // Keep the mobile control in step, so switching orientation is not confusing.
  sortsel.value = k + ':' + dir;
}));
sortsel.addEventListener('change', () => {
  if (!sortsel.value) return setSort(null, 1);
  const parts = sortsel.value.split(':');
  setSort(parts[0], Number(parts[1]));
});
[fp, fe].forEach(b => b.addEventListener('click', () => {
  b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
  render();
}));
q.addEventListener('input', render);

// Event delegation rather than inline onclick: a company name carrying an apostrophe
// used to have to survive three levels of quote escaping to produce a working button.
tb.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-act="research"]');
  if (btn) openDossier(btn.dataset.id, btn.dataset.name);
});

// ---- dossier ---------------------------------------------------------------
const API_BASE = window.location.protocol.startsWith('http') ? '' : 'http://127.0.0.1:7676';
let lastFocus = null;

function openModal(name){
  lastFocus = document.activeElement;
  modalTitle.textContent = name;
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
  document.getElementById('modal-close').focus();
}
function closeModal(){
  modal.classList.remove('open');
  document.body.style.overflow = '';
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}
document.getElementById('modal-close').addEventListener('click', closeModal);
modal.addEventListener('click', (ev) => { if (ev.target === modal) closeModal(); });
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && modal.classList.contains('open')) closeModal();
});

async function openDossier(placeId, companyName){
  openModal(companyName);

  // Embedded copy first, and with no await: it renders instantly, it renders with
  // no daemon, and it is the only path that works once this file has been mailed
  // somewhere. The daemon is consulted only for companies the snapshot lacks.
  if (DOSSIERS[placeId]) return renderDossierModal(DOSSIERS[placeId], true);

  modalContent.innerHTML = '<p style="color:var(--signal)">Checking dossier cache…</p>';
  try {
    const res = await fetch(API_BASE + '/api/gmap/businesses/' + encodeURIComponent(placeId) + '/dossier');
    const data = await res.json();
    if (data.found && data.dossier) return renderDossierModal(data.dossier);
  } catch (e) {}

  modalContent.innerHTML =
    '<p style="color:var(--dim)">No deep research has been run for this company yet.</p>' +
    '<div style="margin:20px 0"><button class="dr-btn" type="button" data-act="run" ' +
      'style="padding:13px 18px;font-size:13px" data-id="' + esc(placeId) + '" data-name="' + esc(companyName) + '">' +
      '⚡ Start Deep Research</button></div>';
}

async function triggerDeepResearch(placeId, companyName){
  modalContent.innerHTML =
    '<div style="background:var(--bg-3);padding:18px;margin-bottom:16px">' +
      '<p style="color:var(--signal);margin:0 0 10px">⚡ Running the deep research pipeline…</p>' +
      '<ul style="color:var(--dim);line-height:1.75;padding-left:20px;margin:0">' +
        '<li>Google discovery + registry pass (SSM, CTOS, Maukerja)</li>' +
        '<li>Crawling the company website for contacts</li>' +
        '<li>Facebook page · LinkedIn company</li>' +
        '<li>Web research brief — registry, people, clients, buying signals</li>' +
      '</ul>' +
      '<p style="color:var(--dim);margin:12px 0 0;font-size:13px">The research stage reads a dozen ' +
      'pages, so this usually takes two to four minutes. Leaving this open is fine.</p>' +
    '</div>';

  try {
    const res = await fetch(API_BASE + '/api/gmap/businesses/' + encodeURIComponent(placeId) + '/deep-research', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enableBrowserScrape: true }),
    });
    const result = await res.json();
    if (result.dossier) renderDossierModal(result.dossier);
    else modalContent.innerHTML = '<div class="note"><h3>Deep research failed</h3><p>' +
      esc(result.error || 'Unknown error') + '</p></div>';
  } catch (err) {
    modalContent.innerHTML = '<div class="note"><h3>Cannot reach the daemon</h3><p>' + esc(err.message) +
      '</p><p style="margin-top:8px;color:var(--dim)">Start it with <code>npm start</code>, then try again.</p></div>';
  }
}

// A field the research explicitly could not establish is a finding, so it is shown as
// a marked gap rather than hidden — an absent row reads as "never looked for".
function factRow(label, value){
  return '<dt>' + esc(label) + '</dt><dd' + (value ? '>' + esc(value) : ' class="gap">not established') + '</dd>';
}

function renderRegistry(f){
  if (!f) return '';
  return '<div class="dossier-card"><h4>Registry</h4><dl class="facts">' +
    factRow('SSM', f.ssm) +
    factRow('Incorporated', f.incorporatedOn) +
    factRow('Age', f.companyAgeYears ? f.companyAgeYears + ' yrs' : '') +
    factRow('MSIC', f.msic) +
    factRow('Paid-up', f.paidUpCapital) +
    factRow('Headcount', f.headcount) +
    '</dl></div>';
}

// The domain registry is the only source in this dossier the company cannot
// self-publish into, so it gets its own card. A dead domain is promoted to a wide
// warn card rather than a "not established" row: the URL is live on their Maps
// listing, and whoever works this lead will try it and find nothing.
function renderDomain(dom){
  if (!dom) return '';

  if (dom.source === 'platform' || dom.source === 'unsupported'){
    return '<div class="dossier-card"><h4>Domain registry</h4>' +
      '<p style="margin:0;color:var(--dim)">' + esc(dom.note || 'not checked') + '</p></div>';
  }

  if (dom.registered === false){
    // No apostrophe anywhere in this block, and none anywhere else in this script.
    // Everything below <script> is emitted from a TypeScript template literal, so a
    // backslash-escaped quote collapses to a bare quote in the generated file and
    // ends the JS string early — which is a SyntaxError that kills the WHOLE report
    // script, not just this card. gmapreport.script.test.ts parses the output to
    // keep that from shipping again.
    return '<div class="dossier-card wide" style="border-color:var(--warn)">' +
      '<h4 style="color:var(--warn)">Dead website — domain is unregistered</h4>' +
      '<p style="margin:0">The website published on the Google Maps listing for this company ' +
      'points at <b>' + esc(dom.domain) + '</b>, which no registry has a record of. It cannot ' +
      'resolve, so the site was not crawled and nothing was benchmarked against it.</p></div>';
  }

  // Named rather than blank: on a gTLD the owner is redacted by policy and on a
  // plain .my it is simply not collected, and neither is the same as "not looked for".
  const owner = dom.registrantOrganization ? esc(dom.registrantOrganization)
    : '<span class="gap">' + (dom.source === 'rdap'
        ? 'redacted by the registry (ICANN post-GDPR)'
        : 'not published for this registration class') + '</span>';

  return '<div class="dossier-card"><h4>Domain registry' + (dom.expired ? ' — EXPIRED' : '') + '</h4>' +
    '<dl class="facts">' +
      '<dt>Domain</dt><dd>' + esc(dom.domain) + '</dd>' +
      '<dt>Registrant</dt><dd>' + owner + '</dd>' +
      factRow('Registered', dom.createdAt ? dom.createdAt.slice(0,10) : '') +
      factRow('Domain age', dom.ageYears !== undefined && dom.ageYears !== null ? dom.ageYears + ' yrs' : '') +
      factRow('Expires', dom.expiresAt ? dom.expiresAt.slice(0,10) : '') +
      factRow('Registrar', dom.registrar) +
      factRow('State', dom.registrantState) +
    '</dl></div>';
}

// Wayback is the one source here that still has something to say about a domain
// nobody owns any more (see the dead-website card above). This card is the
// unabridged internal view — every field the pipeline captured, including which
// contacts came from an archived snapshot rather than the live page — unlike the
// single curated line the public RAG profile gets.
function renderArchive(archive, dom){
  if (!archive || !archive.checked) return '';

  if (!archive.hasSnapshots){
    return '<div class="dossier-card"><h4>Web archive</h4>' +
      '<p style="margin:0;color:var(--dim)">' + esc(archive.note || 'no Wayback captures on record') + '</p></div>';
  }

  const first = archive.firstCaptureAt ? archive.firstCaptureAt.slice(0,10) : null;
  const last = archive.lastCaptureAt ? archive.lastCaptureAt.slice(0,10) : null;
  const spanYears = (archive.firstCaptureAt && archive.lastCaptureAt)
    ? Math.round(((Date.parse(archive.lastCaptureAt) - Date.parse(archive.firstCaptureAt)) / 31557600000) * 10) / 10
    : null;
  const dead = !!(dom && dom.registered === false);

  const banner = dead
    ? '<p style="margin:0 0 10px"><b>The dead domain WAS a real, live site</b> — archived ' +
      esc(first || '—') + ' through ' + esc(last || '—') + ', before the registration lapsed.</p>'
    : '';

  const rc = archive.recoveredContacts;
  const recovered = !rc ? '' :
    '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line-2)">' +
      '<p style="margin:0 0 6px;font-size:12.5px;color:var(--cool)"><b>Contacts recovered from this snapshot</b> ' +
        '— the live site could not be read, so these came from the archive instead:</p>' +
      '<dl class="facts">' +
        factRow('Email', rc.email || (rc.emails && rc.emails[0])) +
        (rc.emails && rc.emails.length > 1 ? factRow('Other emails', rc.emails.slice(1).join(', ')) : '') +
        factRow('Facebook', rc.facebook) +
        factRow('Instagram', rc.instagram) +
        factRow('WhatsApp', rc.whatsapp) +
        factRow('LinkedIn', rc.linkedin) +
      '</dl></div>';

  return '<div class="dossier-card' + (dead ? ' wide' : '') + '"' +
      (dead ? ' style="border-color:var(--warn)"' : '') + '>' +
    '<h4' + (dead ? ' style="color:var(--warn)"' : '') + '>Web archive (Wayback Machine)</h4>' +
    banner +
    '<dl class="facts">' +
      '<dt>Domain</dt><dd>' + esc(archive.domain) + '</dd>' +
      factRow('First captured', first) +
      factRow('Last captured', last) +
      factRow('Capture span', spanYears !== null ? spanYears + ' yrs' : '') +
      factRow('Last capture status', archive.lastCaptureStatus) +
      (archive.cached ? factRow('Source', 'cached lookup') : '') +
    '</dl>' +
    (archive.lastCaptureUrl
      ? '<p style="margin:10px 0 0;font-size:12.5px"><a href="' + esc(archive.lastCaptureUrl) +
        '" target="_blank" rel="noopener">View last snapshot on web.archive.org →</a></p>'
      : '') +
    recovered +
    '</div>';
}

function renderCommercial(f){
  if (!f) return '';
  return '<div class="dossier-card"><h4>Commercial profile</h4><dl class="facts">' +
    factRow('Sells', f.primaryRevenueLine) +
    factRow('Buyers', f.customerSegment) +
    factRow('Clients found', f.clients && f.clients.length ? String(f.clients.length) : '') +
    factRow('Confidence', f.confidence) +
    '</dl></div>';
}

function renderPeople(f){
  if (!f || !f.people || !f.people.length) return '';
  return '<div class="dossier-card wide"><h4>Named people (' + f.people.length + ')</h4>' +
    '<table class="resp"><thead><tr><th>Name</th><th>Role</th><th>Reach</th><th>Source</th></tr></thead><tbody>' +
    f.people.map(function(p){
      return '<tr>' +
        '<td data-label="Name"><b>' + esc(p.name) + '</b></td>' +
        '<td data-label="Role">' + esc(p.role) + '</td>' +
        '<td data-label="Reach"' + (p.contact ? '>' + esc(p.contact) : ' class="dashed"><span class="none">—</span>') + '</td>' +
        '<td class="src" data-label="Source">' + esc(p.source) + '</td>' +
        '</tr>';
    }).join('') +
    '</tbody></table></div>';
}

function renderSignals(f){
  if (!f || !f.buyingSignals || !f.buyingSignals.length) return '';
  return '<div class="dossier-card wide" style="border-color:var(--signal)">' +
    '<h4>Buying signals (' + f.buyingSignals.length + ')</h4><ul class="ev">' +
    f.buyingSignals.map(function(s){
      return '<li>' + esc(s.signal) +
        (s.date ? ' <span class="when">' + esc(s.date) + '</span>' : '') +
        ' <span class="src">[' + esc(s.source) + ']</span></li>';
    }).join('') + '</ul></div>';
}

// Their own website, benchmarked. The one card that measures something we can sell a
// fix for, so it carries the number at pitch size and names its source underneath —
// an estimate quoted as Google's grade falls apart the moment the prospect checks.
function renderPageInsight(p){
  if (!p || !p.ok) return '';
  const s = p.scores || {}, m = p.metrics || {};
  const band = function(v){ return v == null ? 'var(--dim)' : v >= 90 ? 'var(--cool)' : v >= 50 ? 'var(--signal)' : 'var(--warn)'; };
  const secs = function(v){ return v == null ? '' : (v / 1000).toFixed(1) + 's'; };
  const sub = p.source === 'psi'
    ? 'Google PageSpeed Insights · ' + p.strategy
    : 'local Chromium under the Lighthouse ' + p.strategy + ' throttle · estimated, 4 of 5 metrics';

  const cats = [['Performance', s.performance], ['SEO', s.seo], ['Accessibility', s.accessibility], ['Best practices', s.bestPractices]]
    .filter(function(c){ return c[1] != null; })
    .map(function(c){
      return '<div style="text-align:center"><div style="font-family:var(--display);font-size:30px;line-height:1;' +
        'color:' + band(c[1]) + '">' + c[1] + '</div>' +
        '<div style="font-family:var(--mono);font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;' +
        'color:var(--dim);margin-top:5px">' + c[0] + '</div></div>';
    }).join('');

  // Field data is what real visitors got. Its absence is a finding of its own — the
  // site is too quiet to appear in Chrome's dataset — so it is stated, not hidden.
  const field = p.field
    ? '<p style="margin:10px 0 0;font-size:12.5px;color:var(--cool)">Real visitors (CrUX): ' +
        esc(String(p.field.verdict || 'recorded')) +
        (p.field.lcpMs ? ' · LCP ' + secs(p.field.lcpMs) : '') +
        (p.field.inpMs ? ' · INP ' + p.field.inpMs + 'ms' : '') + '</p>'
    : '<p style="margin:10px 0 0;font-size:12.5px;color:var(--dim)">No Chrome UX Report data — too little real traffic to be measured.</p>';

  const fails = (p.checks || []).filter(function(c){ return !c.pass; });
  const checks = !(p.checks || []).length ? '' :
    '<p style="margin:12px 0 0;font-size:12.5px">' +
      (fails.length
        ? '<b style="color:var(--warn)">' + fails.length + ' of ' + p.checks.length + ' on-page checks fail:</b> ' +
          esc(fails.map(function(c){ return c.label; }).join(' · '))
        : '<b style="color:var(--cool)">All ' + p.checks.length + ' on-page checks pass.</b>') +
    '</p>';

  const opps = !(p.opportunities || []).length ? '' :
    '<ul class="ev" style="margin-top:12px">' +
      p.opportunities.map(function(o){
        return '<li>' + esc(o.title) +
          (o.savingsMs ? ' <span class="when">−' + secs(o.savingsMs) + '</span>' : '') +
          (o.detail ? ' <span class="src">' + esc(o.detail) + '</span>' : '') + '</li>';
      }).join('') + '</ul>';

  return '<div class="dossier-card wide"><h4>Website benchmark — ' + esc(p.url) + '</h4>' +
    '<div style="display:flex;gap:26px;flex-wrap:wrap;align-items:flex-start;margin-bottom:4px">' + cats + '</div>' +
    '<p style="margin:10px 0 0;font-family:var(--mono);font-size:10.5px;letter-spacing:.06em;color:var(--dim)">' +
      esc(sub) + '</p>' +
    '<dl class="facts" style="margin-top:12px">' +
      factRow('LCP', secs(m.lcpMs)) +
      factRow('CLS', m.clsScore == null ? '' : String(m.clsScore)) +
      factRow('Blocking', m.tbtMs == null ? '' : m.tbtMs + 'ms') +
      factRow('TTFB', m.ttfbMs == null ? '' : m.ttfbMs + 'ms') +
      factRow('Weight', m.transferBytes ? (m.transferBytes / 1048576).toFixed(1) + ' MB' +
        (m.requests ? ' over ' + m.requests + ' requests' : '') : '') +
    '</dl>' + field + checks + opps + '</div>';
}

function renderRisks(f){
  if (!f || !f.risks || !f.risks.length) return '';
  return '<div class="dossier-card wide" style="border-color:var(--warn)">' +
    '<h4 style="color:var(--warn)">Risks &amp; red flags (' + f.risks.length + ')</h4><ul class="ev">' +
    f.risks.map(function(r){ return '<li>' + esc(r) + '</li>'; }).join('') + '</ul></div>';
}

function renderUnknowns(f){
  if (!f || !f.unknowns || !f.unknowns.length) return '';
  return '<div class="dossier-card wide"><h4>Not established (' + f.unknowns.length + ')</h4>' +
    '<p style="color:var(--dim);margin:0">' + esc(f.unknowns.join(' · ')) + '</p></div>';
}

// Always rendered when present. A stage that ran and found nothing and a stage that
// never ran produce identical dossiers otherwise, which is what makes a thin result
// impossible to explain.
//
// Stages overlap, so the per-stage times no longer sum to the wall clock. The summary
// states both figures: when the sum far exceeds the elapsed time, the fan-out is
// working, and when the two converge the pipeline has quietly gone serial again.
function renderStages(log){
  if (!log || !log.length) return '';
  const ran = log.filter(function(s){ return s.status !== 'skipped'; });
  const work = ran.reduce(function(t, s){ return t + (s.ms || 0); }, 0);
  const wall = ran.reduce(function(t, s){ return Math.max(t, (s.startedAt || 0) + (s.ms || 0)); }, 0);
  const secs = function(ms){ return (Math.round(ms / 100) / 10) + 's'; };
  const head = 'Stage log — ' + ran.length + ' stages, ' + secs(wall) + ' elapsed' +
    (work > wall * 1.15 ? ' (' + secs(work) + ' of work, overlapped)' : '');

  return '<details class="brief"><summary>' + esc(head) + '</summary>' +
    '<div class="inner"><table class="resp stages"><tbody>' +
    log.map(function(s){
      return '<tr>' +
        '<td data-label="Stage">' + esc(s.stage) + '</td>' +
        '<td class="st st-' + esc(s.status) + '" data-label="Result">' + esc(s.status) + '</td>' +
        '<td data-label="Detail">' + esc(s.detail) + '</td>' +
        // Where the row sits on the run's timeline. Two rows sharing a start are the
        // fan-out; a staircase of starts means they ran one after another.
        '<td class="ms" data-label="Started">' +
          (s.status === 'skipped' || s.startedAt == null ? '—' : '+' + secs(s.startedAt)) + '</td>' +
        '<td class="ms" data-label="Took">' + secs(s.ms || 0) + '</td>' +
        '</tr>';
    }).join('') +
    '</tbody></table></div></details>';
}

function renderDossierModal(d, embedded){
  const cm = d.contactMatrix || {};
  const nlm = d.notebooklm;
  const cg = d.chatgpt;
  const ag = d.agy;
  const pi = d.pageInsight;
  // The fact cards read the MERGED view (first pass + second pass, additive
  // only — see mergeFacts in enrich/agyresearch.ts), not chatgpt's facts alone.
  // d.chatgpt.facts and d.agy.facts stay exactly what each pass produced on
  // their own; this is only where the two get shown combined.
  const f = d.combinedFacts !== undefined ? d.combinedFacts : (cg && cg.facts);
  const allPhones = (cm.allPhones || []).join(', ');
  const allEmails = (cm.allEmails || []).join(', ');

  const nlmSection = !nlm ? '' :
    '<div class="dossier-card wide" style="border-color:var(--cool);background:var(--cool-soft)">' +
      '<h4 style="color:var(--cool)">NotebookLM forensic intelligence</h4>' +
      '<p style="margin:0 0 12px"><a href="' + esc(nlm.notebookUrl) + '" target="_blank" rel="noopener">' +
        'Open in Google NotebookLM →</a></p>' +
      '<pre style="white-space:pre-wrap;margin:0 0 12px;font-family:var(--sans);font-size:13.5px;line-height:1.6">' +
        esc(nlm.deepAnalysis) + '</pre>' +
      '<div style="border-top:1px solid var(--line-2);padding-top:12px">' +
        '<div class="nlm-ask">' +
          '<input type="text" id="nlm-query" placeholder="Ask NotebookLM about this company…">' +
          '<button class="dr-btn" type="button" data-act="nlm" data-nb="' + esc(nlm.notebookId) + '" ' +
            'style="border-color:var(--cool);color:var(--cool)">Ask</button>' +
        '</div>' +
        '<div id="nlm-answer" style="margin-top:10px;font-size:13.5px"></div>' +
      '</div>' +
    '</div>';

  // The brief is the richest artefact the pipeline produces and far too long for a
  // dossier pane, so it collapses. A failed ask states why instead of rendering nothing.
  const briefSection = !cg ? '' :
    cg.ok && cg.brief
      ? '<details class="brief"><summary>Web research brief (pass 1, ChatGPT) — ' + cg.brief.length.toLocaleString() +
          ' chars, ' + Math.round(cg.ms / 1000) + 's</summary><div class="inner"><pre>' +
          esc(cg.brief) + '</pre></div></details>'
      : '<div class="note"><h3>Research stage failed</h3><p>' + esc(cg.error || 'no answer returned') + '</p></div>';

  // Second pass — kept as its own collapsible section, never blended into the
  // pass-1 text above, so what agy actually wrote is always visible on its own
  // rather than trusted through a merge.
  const agySection = !ag ? '' :
    ag.ok && ag.brief
      ? '<details class="brief"><summary>Second-pass research (agy) — gaps &amp; news, ' + ag.brief.length.toLocaleString() +
          ' chars, ' + Math.round(ag.ms / 1000) + 's</summary><div class="inner"><pre>' +
          esc(ag.brief) + '</pre></div></details>'
      : '<div class="note"><h3>Second-pass research (agy) failed</h3><p>' + esc(ag.error || 'no answer returned') + '</p></div>';

  modalContent.innerHTML =
    '<div class="sub" style="margin:0 0 4px">' +
      '<span class="score-badge">★ Legitimacy ' + d.legitimacyScore + '/100 · ' + esc(d.verdict) + '</span>' +
      (d.newpages && d.newpages.ssm ? '<span class="chip k">SSM ' + esc(d.newpages.ssm) + '</span>' : '') +
      // Registry-held holder name and a dead website both belong beside the score:
      // one corroborates the identity, the other undercuts the whole listing.
      (d.domain && d.domain.registrantOrganization
        ? '<span class="chip k">registrant: ' + esc(d.domain.registrantOrganization) + '</span>' : '') +
      (d.domain && d.domain.registered === false
        ? '<span class="chip warn">website domain unregistered</span>' : '') +
      (d.domain && d.domain.expired
        ? '<span class="chip warn">domain expired</span>' : '') +
      // Turns a flat "domain unregistered" negative into a nuanced one: the site
      // was real, it just went dark. Only shown when the archive can prove it.
      (d.archive && d.archive.hasSnapshots && d.domain && d.domain.registered === false
        ? '<span class="chip warn">was live until ' + esc((d.archive.lastCaptureAt || '').slice(0, 10)) + '</span>' : '') +
      (d.archive && d.archive.recoveredContacts
        ? '<span class="chip k">contacts from archive.org</span>' : '') +
      // The legitimacy score measures whether the business is real, not whether it is
      // safe to transact with — it reaches 100 on presence alone. Carrying the risk and
      // gap counts beside it stops a maxed badge from reading as a clean bill of health.
      (f && f.risks.length ? '<span class="chip warn">' + f.risks.length + ' risks</span>' : '') +
      (f && f.unknowns.length ? '<span class="chip">' + f.unknowns.length + ' unverified</span>' : '') +
      (f && f.confidence ? '<span class="chip">confidence: ' + esc(f.confidence) + '</span>' : '') +
      (cg && cg.truncated ? '<span class="chip warn">brief truncated</span>' : '') +
      // An embedded dossier is a point-in-time copy. Saying when it was taken stops
      // a months-old snapshot from being read as the current state of the company.
      (embedded && d.updatedAt
        ? '<span class="chip">snapshot ' + esc(String(d.updatedAt).slice(0, 10)) + '</span>' : '') +
      (pi && pi.ok && pi.scores.performance != null
        ? '<span class="chip' + (pi.scores.performance < 50 ? ' warn' : '') + '">site speed ' +
            pi.scores.performance + '/100' + (pi.performanceEstimated ? ' est.' : '') + '</span>'
        : '') +
    '</div>' +
    '<div class="dossier-summary"><h3>Executive brief</h3><pre>' + esc(d.executiveSummary) + '</pre></div>' +
    // Signals first: the reason to call them today outranks the reference data.
    '<div class="dossier-grid">' +
      renderSignals(f) +
      renderPeople(f) +
      renderPageInsight(pi) +
      renderDomain(d.domain) +
      renderArchive(d.archive, d.domain) +
      renderRegistry(f) +
      renderCommercial(f) +
      '<div class="dossier-card">' +
        '<h4>Verified contacts</h4>' +
        '<dl class="facts">' +
          factRow('Phone', cm.primaryPhone) +
          (allPhones ? factRow('All phones', allPhones) : '') +
          factRow('Email', cm.primaryEmail) +
          (allEmails ? factRow('All emails', allEmails) : '') +
          factRow('WhatsApp', cm.whatsapp) +
          factRow('Website', cm.website) +
        '</dl>' +
      '</div>' +
      '<div class="dossier-card">' +
        '<h4>Social footprint</h4>' +
        '<dl class="facts">' +
          factRow('Facebook', d.facebook && (d.facebook.followers ? d.facebook.followers + ' followers' : (d.facebook.found ? 'page found' : ''))) +
          factRow('FB rating', d.facebook && d.facebook.rating ? d.facebook.rating + (d.facebook.reviewsCount ? ' (' + d.facebook.reviewsCount + ')' : '') : '') +
          factRow('LinkedIn', d.linkedin && d.linkedin.companySize) +
          factRow('Key PIC', cm.keyContacts && cm.keyContacts.length ? cm.keyContacts[0].name : '') +
        '</dl>' +
      '</div>' +
      renderRisks(f) +
      renderUnknowns(f) +
    '</div>' +
    nlmSection +
    briefSection +
    agySection +
    renderStages(d.stageLog);
}

async function askNotebookLm(notebookId){
  const qInput = document.getElementById('nlm-query');
  const aDiv = document.getElementById('nlm-answer');
  const question = qInput.value.trim();
  if (!question) return;
  aDiv.innerHTML = '<span style="color:var(--cool)">Querying NotebookLM across grounded sources…</span>';
  try {
    const res = await fetch(API_BASE + '/api/nlm/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notebookId, question }),
    });
    const data = await res.json();
    aDiv.innerHTML = '<div style="background:var(--bg-3);padding:11px;border-left:2px solid var(--cool);' +
      'white-space:pre-wrap">' + esc(data.answer) + '</div>';
  } catch (err) {
    aDiv.innerHTML = '<span style="color:var(--warn)">Query failed: ' + esc(err.message) + '</span>';
  }
}

modalContent.addEventListener('click', (ev) => {
  const run = ev.target.closest('[data-act="run"]');
  if (run) return triggerDeepResearch(run.dataset.id, run.dataset.name);
  const ask = ev.target.closest('[data-act="nlm"]');
  if (ask) return askNotebookLm(ask.dataset.nb);
});

render();
</script>
</div></body></html>`;
}
