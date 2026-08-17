// One company's deep research as one standalone HTML file.
//
// This is the artefact you send to someone. The project report is a table of 117
// companies that happens to open dossiers; this is a single company's research as a
// document — openable from an email attachment, a USB stick, or a phone with no
// signal, and printable to PDF without a print stylesheet fight.
//
// Rendered ENTIRELY server-side. There is no <script> in the output at all, which is
// deliberate: the project report ships its renderer as JavaScript inside a template
// literal, and a single mis-escaped quote there silently disables the whole page
// (see gmapreport.script.test.ts). A document that has no script cannot fail that way,
// cannot fail with JS disabled, and prints correctly from any browser. `<details>`
// gives the one interaction needed — collapsing the 18KB research brief — with no code.
//
// Nothing is fetched at view time: no fonts, no styles, no images, no daemon.

import type { BusinessRow } from './leads.js';
import type {
  ChatGptFacts,
  CompanyDossier,
  DomainIntel,
  PageInsightIntel,
  StageLog,
} from './enrich/types.js';

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A value the research could not establish is shown as a marked gap, never hidden. */
const row = (label: string, value: unknown): string =>
  `<dt>${esc(label)}</dt>` +
  (value === null || value === undefined || value === ''
    ? '<dd class="gap">not established</dd>'
    : `<dd>${esc(value)}</dd>`);

const card = (title: string, body: string, mod = ''): string =>
  body ? `<section class="card${mod ? ` ${mod}` : ''}"><h2>${esc(title)}</h2>${body}</section>` : '';

/** Minimal markdown for the executive brief: the LLM emits bullets, bold and headings. */
function brief(md: string): string {
  const lines = esc(md).split('\n');
  let html = '';
  let inList = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline(bullet[1])}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) { html += `<h3>${inline(head[2])}</h3>`; continue; }
    if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

/** `**bold**` and `\`code\`` only — the brief uses nothing else. */
const inline = (s: string): string =>
  s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

/* ---- sections -------------------------------------------------------------- */

function domainSection(d: DomainIntel | undefined): string {
  if (!d) return '';

  if (d.source === 'platform' || d.source === 'unsupported') {
    return card('Domain registry', `<p class="dim">${esc(d.note ?? 'not checked')}</p>`);
  }

  if (d.registered === false) {
    return card(
      'Dead website — domain is unregistered',
      `<p>The website published on this company&#39;s Google Maps listing points at ` +
        `<b>${esc(d.domain)}</b>, which no registry has a record of. It cannot resolve, so the ` +
        `site was not crawled and nothing was benchmarked against it.</p>`,
      'warn',
    );
  }

  // Named, not blank: on a gTLD the registrant is redacted by ICANN policy and on a
  // plain .my it is not collected for that registration class. Neither is "not looked for".
  const owner = d.registrantOrganization
    ? `<dd>${esc(d.registrantOrganization)}</dd>`
    : `<dd class="gap">${
        d.source === 'rdap'
          ? 'redacted by the registry (ICANN post-GDPR policy)'
          : 'not published for this registration class'
      }</dd>`;

  return card(
    `Domain registry${d.expired ? ' — REGISTRATION EXPIRED' : ''}`,
    '<dl class="facts">' +
      `<dt>Domain</dt><dd>${esc(d.domain)}</dd>` +
      `<dt>Registrant</dt>${owner}` +
      row('Registered', d.createdAt?.slice(0, 10)) +
      row('Domain age', d.ageYears !== undefined ? `${d.ageYears} years` : null) +
      row('Expires', d.expiresAt?.slice(0, 10)) +
      row('Last changed', d.changedAt?.slice(0, 10)) +
      row('Registrar', d.registrar) +
      row('Registrant state', d.registrantState) +
      row('Registrant country', d.registrantCountry) +
      row('Nameservers', d.nameservers?.length ? d.nameservers.join(', ') : null) +
      '</dl>' +
      (d.registrantOrganization
        ? '<p class="foot">The registrant organisation is self-declared at registration and is not ' +
          'verified against SSM. It corroborates the legal entity; it is not a registration number.</p>'
        : ''),
    d.expired ? 'warn' : '',
  );
}

function peopleSection(f: ChatGptFacts | null | undefined, extra: CompanyDossier['contactMatrix']): string {
  const people = [
    ...(f?.people ?? []).map((p) => ({ name: p.name, role: p.role, contact: p.contact, source: p.source })),
    ...extra.keyContacts.map((k) => ({ name: k.name, role: k.role, contact: k.contact ?? null, source: k.source })),
  ];
  const seen = new Set<string>();
  const rows = people.filter((p) => {
    const k = p.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!rows.length) return '';

  return card(
    `Named people (${rows.length})`,
    '<table><thead><tr><th>Name</th><th>Role</th><th>Reach</th><th>Source</th></tr></thead><tbody>' +
      rows
        .map(
          (p) =>
            `<tr><td data-l="Name"><b>${esc(p.name)}</b></td>` +
            `<td data-l="Role">${esc(p.role)}</td>` +
            (p.contact ? `<td data-l="Reach">${esc(p.contact)}</td>` : '<td data-l="Reach" class="gap">—</td>') +
            `<td data-l="Source" class="src">${esc(p.source)}</td></tr>`,
        )
        .join('') +
      '</tbody></table>',
  );
}

function pageInsightSection(p: PageInsightIntel | undefined): string {
  if (!p) return '';
  if (!p.ok) return card('Website performance', `<p class="dim">Benchmark failed: ${esc(p.error ?? 'no result')}</p>`);

  const ms = (v: number | null): string | null => (v === null ? null : `${(v / 1000).toFixed(1)}s`);
  const scores = [
    ['Performance', p.scores.performance],
    ['Accessibility', p.scores.accessibility],
    ['Best practices', p.scores.bestPractices],
    ['SEO', p.scores.seo],
  ] as const;

  return card(
    'Website performance',
    '<dl class="facts">' +
      scores.map(([l, v]) => row(l, v === null ? null : `${v}/100`)).join('') +
      row('LCP', ms(p.metrics.lcpMs)) +
      row('CLS', p.metrics.clsScore) +
      row('Blocking time', p.metrics.tbtMs === null ? null : `${p.metrics.tbtMs}ms`) +
      row('Field verdict', p.field?.verdict) +
      '</dl>' +
      (p.opportunities.length
        ? '<h3>Fixable</h3><ul class="ev">' +
          p.opportunities
            .map(
              (o) =>
                `<li>${esc(o.title)}${o.savingsMs ? ` <span class="when">saves ~${(o.savingsMs / 1000).toFixed(1)}s</span>` : ''}</li>`,
            )
            .join('') +
          '</ul>'
        : '') +
      `<p class="foot">${
        p.source === 'psi'
          ? 'Measured by PageSpeed Insights'
          : 'Measured locally in Chromium — the performance score is an approximation'
      }, ${esc(p.strategy)}, ${esc(p.fetchedAt.slice(0, 10))}.</p>`,
  );
}

function stageSection(log: StageLog[] | undefined): string {
  if (!log?.length) return '';
  // Always present. A stage that ran and found nothing and a stage that never ran
  // produce identical dossiers otherwise, which is what makes a thin result
  // impossible to explain to whoever is reading this document.
  return (
    '<details class="fold"><summary>Stage log — what each source actually returned</summary>' +
    '<table><tbody>' +
    log
      .map(
        (s) =>
          `<tr><td data-l="Stage">${esc(s.stage)}</td>` +
          `<td data-l="Result"><span class="st st-${esc(s.status)}">${esc(s.status)}</span></td>` +
          `<td data-l="Detail">${esc(s.detail)}</td>` +
          `<td data-l="Took" class="num">${Math.round(s.ms / 100) / 10}s</td></tr>`,
      )
      .join('') +
    '</tbody></table></details>'
  );
}

/* ---- page ------------------------------------------------------------------ */

export function renderDossierPage(d: CompanyDossier, biz?: BusinessRow): string {
  const f = d.chatgpt?.facts ?? null;
  const cm = d.contactMatrix ?? {
    primaryPhone: null, allPhones: [], primaryEmail: null, allEmails: [],
    whatsapp: null, website: null, officialAddresses: [], socialLinks: [], keyContacts: [],
  };
  const dead = d.domain?.registered === false;

  const chips = [
    `<span class="chip score">★ ${d.legitimacyScore}/100 · ${esc(d.verdict)}</span>`,
    d.newpages?.ssm ? `<span class="chip key">SSM ${esc(d.newpages.ssm)}</span>` : '',
    d.domain?.registrantOrganization
      ? `<span class="chip key">registrant: ${esc(d.domain.registrantOrganization)}</span>` : '',
    dead ? '<span class="chip warn">website domain unregistered</span>' : '',
    d.domain?.expired ? '<span class="chip warn">domain expired</span>' : '',
    f?.risks.length ? `<span class="chip warn">${f.risks.length} risks</span>` : '',
    f?.unknowns.length ? `<span class="chip">${f.unknowns.length} unverified</span>` : '',
    f?.confidence ? `<span class="chip">confidence: ${esc(f.confidence)}</span>` : '',
    d.chatgpt?.truncated ? '<span class="chip warn">brief truncated</span>' : '',
  ].filter(Boolean).join('');

  const sections = [
    // The reason to call them today outranks the reference data.
    f?.buyingSignals.length
      ? card(
          `Buying signals (${f.buyingSignals.length})`,
          '<ul class="ev">' +
            f.buyingSignals
              .map(
                (s) =>
                  `<li>${esc(s.signal)}${s.date ? ` <span class="when">${esc(s.date)}</span>` : ''} ` +
                  `<span class="src">[${esc(s.source)}]</span></li>`,
              )
              .join('') +
            '</ul>',
          'signal',
        )
      : '',
    peopleSection(f, cm),
    domainSection(d.domain),
    f
      ? card(
          'Company registry',
          '<dl class="facts">' +
            row('SSM', f.ssm ?? d.newpages?.ssm) +
            row('Incorporated', f.incorporatedOn) +
            row('Company age', f.companyAgeYears !== null ? `${f.companyAgeYears} years` : null) +
            row('MSIC', f.msic) +
            row('Paid-up capital', f.paidUpCapital) +
            row('Headcount', f.headcount ? `${f.headcount}${f.headcountSource ? ` (${f.headcountSource})` : ''}` : null) +
            '</dl>',
        )
      : '',
    f
      ? card(
          'Commercial profile',
          '<dl class="facts">' +
            row('Sells', f.primaryRevenueLine) +
            row('Buyers', f.customerSegment) +
            row('Clients found', f.clients.length || null) +
            '</dl>' +
            (f.clients.length
              ? '<ul class="ev">' +
                f.clients
                  .map(
                    (c) =>
                      `<li>${esc(c.name)}${c.year ? ` <span class="when">${esc(c.year)}</span>` : ''}` +
                      `${c.delivered ? ` — ${esc(c.delivered)}` : ''}</li>`,
                  )
                  .join('') +
                '</ul>'
              : ''),
        )
      : '',
    card(
      'Contacts',
      '<dl class="facts">' +
        row('Phone', cm.primaryPhone) +
        (cm.allPhones.length > 1 ? row('All phones', cm.allPhones.join(', ')) : '') +
        row('Email', cm.primaryEmail) +
        (cm.allEmails.length > 1 ? row('All emails', cm.allEmails.join(', ')) : '') +
        row('WhatsApp', cm.whatsapp) +
        row('Website', cm.website ?? biz?.website) +
        row('Address', cm.officialAddresses[0] ?? biz?.address) +
        '</dl>' +
        (cm.socialLinks.length
          ? '<ul class="ev">' +
            cm.socialLinks.map((s) => `<li>${esc(s.platform)}: ${esc(s.url)}</li>`).join('') +
            '</ul>'
          : ''),
    ),
    card(
      'Social footprint',
      '<dl class="facts">' +
        row('Facebook', d.facebook?.followers ? `${d.facebook.followers} followers` : d.facebook?.found ? 'page found' : null) +
        row('FB rating', d.facebook?.rating ? `${d.facebook.rating}${d.facebook.reviewsCount ? ` (${d.facebook.reviewsCount})` : ''}` : null) +
        row('LinkedIn', d.linkedin?.companySize) +
        row('Industry', d.linkedin?.industry) +
        row('Google Maps', biz?.rating ? `${biz.rating}★ across ${biz.reviews ?? 0} reviews` : null) +
        '</dl>',
    ),
    pageInsightSection(d.pageInsight),
    f?.risks.length
      ? card(`Risks & red flags (${f.risks.length})`, `<ul class="ev">${f.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`, 'warn')
      : '',
    f?.unknowns.length
      ? card(`Not established (${f.unknowns.length})`, `<p class="dim">${esc(f.unknowns.join(' · '))}</p>`)
      : '',
    d.notebooklm
      ? card('NotebookLM analysis', `<div class="prose">${brief(d.notebooklm.deepAnalysis)}</div>`)
      : '',
  ].filter(Boolean).join('\n');

  const research = d.chatgpt?.ok && d.chatgpt.brief
    ? `<details class="fold"><summary>Full web research brief — ${d.chatgpt.brief.length.toLocaleString()} characters</summary>` +
      `<div class="prose">${brief(d.chatgpt.brief)}</div></details>`
    : d.chatgpt && !d.chatgpt.ok
      ? `<section class="card warn"><h2>Research stage failed</h2><p>${esc(d.chatgpt.error ?? 'no answer returned')}</p></section>`
      : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>${esc(d.companyName)} — deep research</title>
<style>
  :root{
    --bg:#0b0d0c; --bg-2:#121614; --bg-3:#1a201d;
    --line:#2a332e; --line-2:#3d4a42;
    --dim:#7f8d84; --text:#c9d4cd; --strong:#fff;
    --signal:#ffb000; --signal-2:#8a6108; --signal-soft:rgba(255,176,0,.09);
    --cool:#4fd6c4;
    --warn:#ff6a51; --warn-soft:rgba(255,106,81,.09);
    --mono:"Cascadia Code","Cascadia Mono",Consolas,ui-monospace,"SF Mono",Menlo,"DejaVu Sans Mono",monospace;
    --display:"Bahnschrift","DIN Alternate","Segoe UI Variable Display","Arial Narrow",system-ui,sans-serif;
    --sans:"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,Roboto,"Helvetica Neue",Arial,sans-serif;
  }
  /* Duplicated across two selectors on purpose: one must live inside a media query. */
  @media (prefers-color-scheme: light){
    :root:not([data-theme="dark"]){
      --bg:#f4f6f4; --bg-2:#fff; --bg-3:#e9ede9;
      --line:#d5dcd7; --line-2:#b3bdb6;
      --dim:#5a675f; --text:#18201c; --strong:#000;
      --signal:#9a6000; --signal-2:#c08810; --signal-soft:rgba(154,96,0,.08);
      --cool:#0c7267;
      --warn:#b52f1b; --warn-soft:rgba(181,47,27,.08);
    }
  }
  *{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%}
  html,body{margin:0;background:var(--bg);color:var(--text);
    font-family:var(--sans);font-size:15px;line-height:1.55}
  .wrap{max-width:900px;margin:0 auto;padding:34px 22px 90px}
  p,li,dd,td{overflow-wrap:anywhere}

  header{border-bottom:2px solid var(--signal);padding-bottom:16px}
  .kicker{font-family:var(--mono);font-size:10.5px;letter-spacing:.28em;text-transform:uppercase;
    color:var(--signal-2)}
  h1{font-family:var(--display);font-weight:600;font-size:clamp(26px,6vw,46px);line-height:1.02;
    letter-spacing:-.01em;margin:10px 0 0;color:var(--strong);text-transform:uppercase}
  .sub{margin:14px 0 0;display:flex;flex-wrap:wrap;gap:7px}
  .chip{font-family:var(--mono);font-size:11px;padding:4px 9px;border:1px solid var(--line-2);
    color:var(--dim);white-space:nowrap}
  .chip.score{border-color:var(--signal);color:var(--signal)}
  .chip.key{border-color:var(--cool);color:var(--cool)}
  .chip.warn{border-color:var(--warn);color:var(--warn)}

  .summary{background:var(--bg-3);border-left:3px solid var(--signal);padding:16px 18px;margin:22px 0}
  .summary h2{margin:0 0 8px;font-family:var(--mono);font-size:11px;letter-spacing:.15em;
    text-transform:uppercase;color:var(--signal)}

  .card{background:var(--bg-2);border:1px solid var(--line);padding:15px 17px;margin:14px 0}
  .card.warn{border-color:var(--warn);background:var(--warn-soft)}
  .card.warn h2{color:var(--warn)}
  .card.signal{border-color:var(--signal);background:var(--signal-soft)}
  .card.signal h2{color:var(--signal)}
  .card h2{margin:0 0 11px;font-family:var(--mono);font-size:10.5px;letter-spacing:.15em;
    text-transform:uppercase;color:var(--dim)}
  h3{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;
    color:var(--dim);margin:16px 0 7px}

  dl.facts{margin:0;display:grid;grid-template-columns:minmax(96px,auto) 1fr;gap:5px 14px}
  dl.facts dt{font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;
    color:var(--dim);padding-top:2px}
  dl.facts dd{margin:0;color:var(--strong)}
  .gap{color:var(--dim);font-style:italic}
  .dim{color:var(--dim);margin:0}
  .foot{color:var(--dim);font-size:12.5px;margin:11px 0 0;padding-top:9px;border-top:1px solid var(--line)}

  ul.ev{margin:9px 0 0;padding-left:19px}
  ul.ev li{margin:4px 0}
  .when{font-family:var(--mono);font-size:11px;color:var(--signal)}
  .src{font-family:var(--mono);font-size:11px;color:var(--dim)}

  table{width:100%;border-collapse:collapse;margin:4px 0 0}
  th{text-align:left;font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;
    color:var(--dim);font-weight:400;padding:6px 9px 6px 0;border-bottom:1px solid var(--line-2)}
  td{padding:7px 9px 7px 0;border-bottom:1px solid var(--line);vertical-align:top;font-size:13.5px}
  td.num{font-family:var(--mono);color:var(--dim);text-align:right}
  .st{font-family:var(--mono);font-size:10.5px;text-transform:uppercase}
  .st-ok{color:var(--cool)} .st-empty{color:var(--dim)}
  .st-skipped{color:var(--dim)} .st-failed{color:var(--warn)}

  .fold{border:1px solid var(--line);background:var(--bg-2);margin:14px 0;padding:0 17px}
  .fold summary{cursor:pointer;padding:13px 0;font-family:var(--mono);font-size:11px;
    letter-spacing:.1em;text-transform:uppercase;color:var(--signal)}
  .fold[open] summary{border-bottom:1px solid var(--line);margin-bottom:12px}
  .fold>table,.fold>.prose{margin-bottom:16px}
  .prose h3{margin-top:18px}
  .prose p{margin:8px 0}
  .prose code{font-family:var(--mono);font-size:12.5px;background:var(--bg-3);padding:1px 5px}

  footer{margin-top:34px;padding-top:14px;border-top:1px solid var(--line);
    font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;
    color:var(--dim);display:flex;flex-wrap:wrap;gap:14px}

  /* Below 620px every table becomes a stack of labelled cards: eight columns in a
     horizontal scroller means dragging sideways to reach the value you came for. */
  @media (max-width:620px){
    dl.facts{grid-template-columns:1fr;gap:1px 0}
    dl.facts dd{margin-bottom:9px}
    table,tbody,tr,td{display:block;width:100%}
    thead{display:none}
    tr{border-bottom:1px solid var(--line-2);padding:9px 0}
    td{border:0;padding:2px 0}
    td::before{content:attr(data-l) " ";font-family:var(--mono);font-size:10px;
      letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
    td.num{text-align:left}
  }
  @media print{
    :root{--bg:#fff;--bg-2:#fff;--bg-3:#f4f4f4;--text:#111;--strong:#000;--dim:#555;
      --line:#ccc;--line-2:#999;--signal:#8a6108;--warn:#b52f1b;--cool:#0c7267}
    .wrap{max-width:none;padding:0}
    .card,.fold{break-inside:avoid}
    .fold{border:0;padding:0}
    .fold summary{display:none}
    details{display:block}
  }
</style>
</head><body>
<div class="wrap">

<header>
  <div class="kicker">gmap-recon · company deep research</div>
  <h1>${esc(d.companyName)}</h1>
  <div class="sub">${chips}</div>
</header>

<section class="summary">
  <h2>Executive brief</h2>
  <div class="prose">${brief(d.executiveSummary)}</div>
</section>

${sections}

${research}

${stageSection(d.stageLog)}

<footer>
  <span>Researched ${esc(d.updatedAt.slice(0, 16).replace('T', ' '))}</span>
  <span>Status ${esc(d.status)}</span>
  <span>Self-contained · no network needed</span>
</footer>

</div>
</body></html>`;
}

/** `Agriculf Sdn Bhd` → `agriculf-sdn-bhd`, for a filename that survives every OS. */
export function dossierSlug(name: string, placeId: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  // placeIds are unique, names are not — two "KRCB" rows must not overwrite each other.
  return `${s || 'company'}-${placeId.replace(/[^a-z0-9]/gi, '').slice(-6)}`;
}
