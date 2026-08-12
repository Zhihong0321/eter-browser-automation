/**
 * The project report: one self-contained HTML file, no external anything.
 *
 * Constraints that shaped this, in order of how much trouble ignoring them
 * causes:
 *
 * 1. EVERY value here is untrusted. Post bodies and display names come from
 *    strangers on Facebook and routinely contain `<`, `&`, quotes and emoji. One
 *    unescaped field turns the report into broken markup at best. `esc()` is
 *    applied at every interpolation without exception — there is no "this field
 *    is safe" case, because the day someone's display name is `<script>` is the
 *    day you find out.
 * 2. No CDN, no webfont, no image host. The file has to open by double-click on
 *    a machine that has never run this tool, and it has to survive being copied
 *    onto a stick or attached to an email.
 * 3. A running project re-renders on every flush, so this must be cheap and it
 *    must look correct at 0 contacts and at 500.
 */
import type { ProjectFile, ProjectStatus } from './project.js';

/** The only defence this file has. Applied at every single interpolation. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shortTime(iso: string | null): string {
  if (!iso) return '—';
  return iso.slice(11, 19);
}

function duration(from: string, to: string | null): string {
  const ms = new Date(to ?? Date.now()).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const STYLE = `
:root{
  --bg:#f7f7f5; --panel:#fff; --ink:#1b1b18; --muted:#6b6b63; --line:#e3e3dd;
  --accent:#2f5d50; --accent-ink:#fff; --warn:#8a5a12; --warn-bg:#fdf3e0;
  --bad:#8c2f24; --bad-bg:#fbeae8; --ok:#2f5d50; --ok-bg:#e7f0ec; --new:#1f4b6e; --new-bg:#e6eff7;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#14140f; --panel:#1c1c17; --ink:#ececdf; --muted:#9a9a8c; --line:#2e2e26;
  --accent:#7fb8a4; --accent-ink:#14140f; --warn:#e0b061; --warn-bg:#332a17;
  --bad:#e08c80; --bad-bg:#331f1c; --ok:#7fb8a4; --ok-bg:#1b2b25; --new:#8fbcdf; --new-bg:#182531;
}}
:root[data-theme="dark"]{
  --bg:#14140f; --panel:#1c1c17; --ink:#ececdf; --muted:#9a9a8c; --line:#2e2e26;
  --accent:#7fb8a4; --accent-ink:#14140f; --warn:#e0b061; --warn-bg:#332a17;
  --bad:#e08c80; --bad-bg:#331f1c; --ok:#7fb8a4; --ok-bg:#1b2b25; --new:#8fbcdf; --new-bg:#182531;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans CJK SC","Microsoft YaHei",sans-serif;}
.wrap{max-width:1180px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:24px;margin:0 0 4px;letter-spacing:-.01em}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);margin:34px 0 12px;font-weight:600}
a{color:var(--accent)}
.sub{color:var(--muted);font-size:13px;margin:0}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;vertical-align:middle}
.b-running{background:var(--warn-bg);color:var(--warn)}
.b-done{background:var(--ok-bg);color:var(--ok)}
.b-failed{background:var(--bad-bg);color:var(--bad)}
.b-new{background:var(--new-bg);color:var(--new)}
.b-known{background:var(--bg);color:var(--muted);border:1px solid var(--line)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px;margin-top:20px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:13px 15px}
.tile .n{font-size:25px;font-weight:650;letter-spacing:-.02em}
.tile .k{font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-top:2px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th{text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
   padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap;font-weight:600}
td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
.quote{color:var(--muted);max-width:520px}
.nowrap{white-space:nowrap}
ul.plain{list-style:none;margin:0;padding:0}
ul.plain li{padding:9px 14px;border-bottom:1px solid var(--line);font-size:13.5px}
ul.plain li:last-child{border-bottom:0}
.ev{display:grid;grid-template-columns:74px 84px 1fr;gap:12px;align-items:baseline}
.ev .p{color:var(--accent);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
.warnbox{background:var(--warn-bg);color:var(--warn);border:1px solid var(--line);border-radius:10px;padding:12px 15px;font-size:13.5px}
.badbox{background:var(--bad-bg);color:var(--bad);border:1px solid var(--line);border-radius:10px;padding:12px 15px;font-size:13.5px}
.empty{padding:26px 15px;text-align:center;color:var(--muted);font-size:13.5px}
.foot{margin-top:44px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:14px}
`;

function shell(title: string, body: string, autoRefresh: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${autoRefresh ? '<meta http-equiv="refresh" content="5">' : ''}
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body><div class="wrap">
${body}
<p class="foot">fb-recon — read-only prospecting. This file lists identified people and is subject to PDPA:
keep it local, do not commit it, do not forward it outside the business that collected it.</p>
</div></body>
</html>`;
}

function statusBadge(status: ProjectStatus): string {
  const label = status === 'running' ? 'RUNNING' : status === 'done' ? 'DONE' : 'FAILED';
  return `<span class="badge b-${esc(status)}">${label}</span>`;
}

function tiles(p: ProjectFile): string {
  const c = p.counters;
  const cells: [number, string][] = [
    [c.scanned, 'posts scanned'],
    [c.gated, 'passed gate'],
    [c.opened, 'threads opened'],
    [c.commentsRead, 'comments read'],
    [c.totalContacts, 'contacts'],
    [c.newContacts, 'new people'],
    [c.knownContacts, 'seen before'],
  ];
  return `<div class="tiles">${cells
    .map(([n, k]) => `<div class="tile"><div class="n">${esc(n)}</div><div class="k">${esc(k)}</div></div>`)
    .join('')}</div>`;
}

function contactRows(p: ProjectFile): string {
  if (!p.contacts.length) {
    return `<div class="panel"><div class="empty">${
      p.status === 'running' ? 'No contacts yet — the sweep is still running.' : 'No contacts harvested.'
    }</div></div>`;
  }

  const rows = p.contacts
    .map((c) => {
      const last = c.evidence[c.evidence.length - 1];
      const known = c.priorProjects.length
        ? `<span class="badge b-known" title="${esc(c.priorProjects.join(', '))}">seen in ${esc(
            c.priorProjects.length,
          )}</span>`
        : '<span class="badge b-new">new</span>';
      const reach = c.messenger
        ? `<a href="${esc(c.messenger)}" rel="noreferrer noopener">Messenger</a>`
        : '<span class="mono">—</span>';
      const phone = [...c.phones, ...c.waLinks].join(' ');
      return `<tr>
<td>${known}</td>
<td><a href="${esc(c.profileUrl)}" rel="noreferrer noopener">${esc(c.name)}</a></td>
<td class="nowrap">${reach}</td>
<td class="mono">${esc(phone)}</td>
<td class="nowrap">${esc(c.intent)}</td>
<td class="nowrap">${esc(c.score)}</td>
<td class="nowrap">${esc(c.evidence.length)}</td>
<td class="quote">${esc(last?.quote ?? '')}</td>
</tr>`;
    })
    .join('');

  return `<div class="panel scroll"><table>
<thead><tr><th></th><th>Name</th><th>Reach</th><th>Phone / WA</th><th>Intent</th><th>Score</th><th>Sightings</th><th>What they said</th></tr></thead>
<tbody>${rows}</tbody></table></div>`;
}

function timeline(p: ProjectFile): string {
  if (!p.events.length) return '';
  const items = p.events
    .map(
      (e) =>
        `<li class="ev"><span class="mono">${esc(shortTime(e.at))}</span><span class="p">${esc(
          e.phase,
        )}</span><span>${esc(e.detail)}</span></li>`,
    )
    .join('');
  return `<h2>Progress</h2><div class="panel"><ul class="plain">${items}</ul></div>`;
}

function problems(p: ProjectFile): string {
  if (!p.problems.length) return '';
  const items = p.problems.map((x) => `<li>${esc(x)}</li>`).join('');
  return `<h2>Notes and problems</h2><div class="panel"><ul class="plain">${items}</ul></div>`;
}

function sources(p: ProjectFile): string {
  const rows = p.sources
    .map((s) => `<li><span class="mono">${esc(s)}</span> — ${esc(p.bySource[s] ?? 0)} gated</li>`)
    .join('');
  return `<h2>Sources</h2><div class="panel"><ul class="plain">${rows || '<li>none</li>'}</ul></div>`;
}

export function renderProject(p: ProjectFile): string {
  const failed = p.status === 'failed' && p.error
    ? `<div class="badbox" style="margin-top:20px"><strong>Run failed:</strong> ${esc(p.error)}</div>`
    : '';

  const body = `
<h1>${esc(p.topic)} ${statusBadge(p.status)}</h1>
<p class="sub mono">${esc(p.id)}</p>
<p class="sub">started ${esc(p.startedAt.replace('T', ' ').slice(0, 19))} ·
 ${esc(duration(p.startedAt, p.finishedAt))} ·
 gate min-score ${esc(p.minScore ?? 'default')}${p.status === 'running' ? ' · this page refreshes every 5s' : ''}</p>
${failed}
${tiles(p)}
<h2>Contacts</h2>
${contactRows(p)}
${sources(p)}
${timeline(p)}
${problems(p)}`;

  return shell(`${p.topic} — ${p.id}`, body, p.status === 'running');
}

export function renderIndex(projects: ProjectFile[]): string {
  const rows = projects
    .map(
      (p) => `<tr>
<td class="nowrap">${statusBadge(p.status)}</td>
<td><a href="${esc(p.id)}/report.html">${esc(p.topic)}</a></td>
<td class="mono">${esc(p.id)}</td>
<td class="nowrap">${esc(p.startedAt.replace('T', ' ').slice(0, 16))}</td>
<td class="nowrap">${esc(duration(p.startedAt, p.finishedAt))}</td>
<td class="nowrap">${esc(p.counters.scanned)}</td>
<td class="nowrap">${esc(p.counters.totalContacts)}</td>
<td class="nowrap">${esc(p.counters.newContacts)}</td>
</tr>`,
    )
    .join('');

  const table = projects.length
    ? `<div class="panel scroll"><table>
<thead><tr><th></th><th>Topic</th><th>Project</th><th>Started</th><th>Took</th><th>Scanned</th><th>Contacts</th><th>New</th></tr></thead>
<tbody>${rows}</tbody></table></div>`
    : '<div class="panel"><div class="empty">No projects yet.</div></div>';

  const running = projects.some((p) => p.status === 'running');
  return shell(
    'fb-recon projects',
    `<h1>fb-recon projects</h1>
<p class="sub">${esc(projects.length)} project(s), newest first. One run is one project — nothing here is ever overwritten.</p>
<h2>All runs</h2>
${table}`,
    running,
  );
}
