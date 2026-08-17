// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
//
// Turns a revealed site map into a DATABASE SCHEMA.
//   node scripts/schema.mjs <host>
//
// Input : scripts/reveal-<host>/sitemap.json  (+ forms.json if the form pass ran)
// Output: schema.json + schema.html
//
// Separate file on purpose: this stage never opens a browser and contains ZERO
// site knowledge. It only knows "a grid is a table, a New form is a write path".
import fs from 'node:fs';

const HOST = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'accounting.autocountcloud.com';
const DIR = `scripts/reveal-${HOST}`;
const site = JSON.parse(fs.readFileSync(`${DIR}/sitemap.json`, 'utf8'));
const forms = fs.existsSync(`${DIR}/forms.json`) ? JSON.parse(fs.readFileSync(`${DIR}/forms.json`, 'utf8')) : {};

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 34);
const clean = (t) => String(t || '').split(/ [-|] /)[0].trim();

// A column's datatype, guessed from what it is called. Names are unreliable
// (the vision lane already proved that), so this is a hint, never a contract.
const typeOf = (l) => {
  const s = l.toLowerCase();
  if (/date|period|month|year|aging/.test(s)) return 'date';
  if (/amount|total|balance|subtotal|price|qty|quantity|rate|value|debit|credit|outstanding|%/.test(s)) return 'number';
  if (/\bcode\b|no\.|number|\bid\b/.test(s)) return 'key';
  if (/status|type|method|term|state/.test(s)) return 'enum';
  return 'text';
};

const KINDS = { Sales: 'document', Purchase: 'document', Accounting: 'document', Reports: 'report' };
const kindOf = (p) => KINDS[p.menu] ?? (p.menu === '(discovered)' ? 'master' : 'system');

// ---- pass 1: every reached page becomes a candidate table
const entities = site.filter((p) => p.ok).map((p) => {
  const label = clean(p.text) || clean(p.title) || p.href.replace('/', '');
  const f = forms[p.href];
  const btns = p.buttons ?? [];
  return {
    id: slug(p.href.replace(/^\//, '')),
    label,
    kind: kindOf(p),
    route: p.href,
    rows: p.dataRows ?? 0,
    columns: (p.columns ?? []).map((c) => ({ id: `${slug(p.href.replace(/^\//, ''))}.${slug(c)}`, label: c, type: typeOf(c) })),
    crud: {
      create: btns.some((b) => /^(new|add|create)\b/i.test(b)),
      read: (p.columns ?? []).length > 0,
      update: btns.some((b) => /\b(edit|update|save)\b/i.test(b)),
      delete: btns.some((b) => /\b(delete|void|remove)\b/i.test(b)),
    },
    // Vision named these and geometry matched each to a real selector. Best-guess
    // names on purpose -- the caller is an LLM, not a compiler.
    write: f?.ok && f.labelled?.length ? {
      openBy: 'click New',
      save: f.saves.find((s) => /^save/i.test(s)) ?? f.saves[0] ?? 'Save',
      lines: f.lines ?? [],
      fields: f.labelled.map((x) => ({
        id: `${slug(p.href.replace(/^\//, ''))}.f.${slug(x.name)}`,
        label: x.name, kind: x.role, selector: x.selector,
      })),
    } : null,
  };
}).filter((e) => e.columns.length || e.crud.create || e.write);

// ---- pass 2: foreign keys. A column named after another table references it.
const index = entities.filter((e) => e.kind === 'master' || e.rows >= 0).map((e) => {
  const words = e.label.split(/\s+/);
  const last = words[words.length - 1];
  return { id: e.id, label: e.label.toLowerCase(), alias: last.length >= 5 ? last.toLowerCase() : null };
});
const refOf = (label, selfId) => {
  const s = label.toLowerCase();
  for (const t of index) {
    if (t.id === selfId) continue;
    if (s.includes(t.label) || (t.alias && s.includes(t.alias))) return t.id;
  }
  return null;
};
for (const e of entities) {
  const refs = new Set();
  for (const c of e.columns) { const r = refOf(c.label, e.id); if (r) { c.ref = r; refs.add(r); } }
  for (const f of e.write?.fields ?? []) { const r = refOf(f.label, e.id); if (r) { f.ref = r; refs.add(r); } }
  e.refs = [...refs];
}

// ---- pass 3: the operation contract. This is what an LLM reads INSTEAD of
// looking at the app. No screenshots, no exploration, no DOM.
const operations = entities.filter((e) => e.write).map((e) => ({
  op: `create.${e.id}`,
  table: e.id,
  needs: e.write.fields.map((f) => ({
    field: f.id, ask_user_for: f.label, control: f.kind,
    ...(f.ref ? { pick_from_table: f.ref } : {}),
    ...(/no\.$|number$/i.test(f.label) ? { note: 'server-assigned, do not supply' } : {}),
  })),
  ...(e.write.lines.length ? { line_items: { columns: e.write.lines, note: 'one or more rows; add a row before filling it' } } : {}),
  steps: [
    `navigate to ${e.route}`,
    `click "New"`,
    ...e.write.fields.map((f) => `fill "${f.label}" -> ${f.selector}`),
    ...(e.write.lines.length ? [`add ${e.write.lines.length}-column line row(s)`] : []),
    `click "${e.write.save}"`,
    `verify: the new row appears in the ${e.id} grid`,
  ],
}));

const out = { site: HOST, capturedAt: new Date().toISOString(), entities, operations };
fs.writeFileSync(`${DIR}/schema.json`, JSON.stringify(out, null, 2));

// ---------------------------------------------------------------- emit a SKILL
// The skill is a BUILD ARTIFACT, never hand-written. Any site that has been
// revealed gets one for free; nothing here knows which site it is.
if (process.argv.includes('--emit-skill')) {
  const NAME = HOST.split('.').slice(-2, -1)[0] ?? HOST;
  const SK = `.claude/skills/${NAME}`;
  fs.mkdirSync(`${SK}/ops`, { recursive: true });
  for (const o of operations) fs.writeFileSync(`${SK}/ops/${o.op}.json`, JSON.stringify(o, null, 2));

  const listable = entities.filter((e) => e.crud.read);
  fs.writeFileSync(`${SK}/tables.md`, ['# Tables', '', '| table | route | columns | C R U D | references |', '|---|---|---|---|---|',
    ...entities.map((e) => `| \`${e.id}\` | ${e.route} | ${e.columns.length} | ${['create', 'read', 'update', 'delete'].map((v) => e.crud[v] ? v[0].toUpperCase() : '-').join('')} | ${e.refs.join(', ') || '-'} |`)].join('\n'));

  fs.writeFileSync(`${SK}/SKILL.md`, `---
name: ${NAME}
description: Drive ${HOST} as a database — list, read and create records without exploring the UI. Use whenever the user asks to look up, extract, or create anything in ${NAME} (invoices, quotations, customers, suppliers, products, ledgers, statements). Do NOT open the site manually or take screenshots; every path is already mapped here.
---

# ${NAME} — ${HOST}

This site is mapped as a database. **Never explore it, never screenshot it, never write
Playwright by hand.** Everything below was compiled from a real walk of the app.

Auth: a logged-in Chrome profile. Nothing to configure; if login has expired the runner says so.

## What exists

${entities.length} tables · ${entities.reduce((n, e) => n + e.columns.length, 0)} columns · ${listable.length} listable · ${operations.length} create paths traced.
Full table list with routes, columns and CRUD flags: \`tables.md\` — read it before answering
"can we…" questions.

## Operations

| op | needs from user | status |
|---|---|---|
${operations.map((o) => `| \`${o.op}\` | ${o.needs.filter((n) => !n.note).map((n) => n.ask_user_for).join(', ')} | traced, **never executed** |`).join('\n')}

Load \`ops/<op>.json\` for the full contract — every field, its control type, its
selector, and the exact step order. Load only the one you need.

## How to choose a path

1. Match the request to a table in \`tables.md\`. If there is no table, say so — do not improvise.
2. Check the CRUD flags. \`-\` means that verb was never found; it is not permission to try.
3. Read the op's \`needs\`. Anything with \`pick_from_table\` is a **foreign key**: that value
   must already exist in the other table. List it first; if the value is missing, the
   dependency has to be created before this op can run.
4. Ask the user only for what \`needs\` lists and \`pick_from_table\` cannot resolve. Never ask
   for a field marked \`server-assigned\`.

## Status — read before promising anything

- All ${operations.length} create paths are **traced but never executed.** No record has ever been written
  by this skill. Treat every create as unproven until one succeeds.
- \`required\` is unknown everywhere — the forms declare nothing. Constraints appear only
  when a save is rejected.
- Dropdowns are custom comboboxes, not \`<select>\`. How to fill one is **not yet established**.
- Line-item tables on documents are not captured yet, so document contracts describe the
  header only.
- Some foreign keys are best-guess from column names and can be wrong. Geometry and routes
  are reliable; names are not.

Captured ${out.capturedAt.slice(0, 10)} from ${HOST}. If selectors stop resolving, the app changed —
re-run the reveal, do not patch the contracts by hand.
`);
  console.log(`\nemitted skill: ${SK}/SKILL.md + tables.md + ${operations.length} op contracts`);
}

// ---------------------------------------------------------------- report
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const byKind = (k) => entities.filter((e) => e.kind === k);
const card = (e) => `
<div class="ent" id="${e.id}">
  <div class="hd"><span class="eid">${esc(e.id)}</span><span class="lbl">${esc(e.label)}</span>
    <code>${esc(e.route)}</code>
    <span class="crud">${['create', 'read', 'update', 'delete'].map((v) => `<span class="v ${e.crud[v] ? 'on' : ''}">${v[0].toUpperCase()}</span>`).join('')}</span></div>
  ${e.columns.length ? `<div class="row"><b>columns ${e.columns.length}</b>${e.columns.map((c) => `<span class="chip ${c.type}">${esc(c.label)}<i>${c.type}</i>${c.ref ? `<u>&rarr;${esc(c.ref)}</u>` : ''}</span>`).join('')}</div>` : ''}
  ${e.write ? `<div class="row wr"><b>write ${e.write.fields.length}</b>${e.write.fields.map((f) => `<span class="chip f ${f.required ? 'req' : ''}">${esc(f.label)}<i>${f.kind}</i>${f.ref ? `<u>&rarr;${esc(f.ref)}</u>` : ''}</span>`).join('')}</div>
    <div class="path">CREATE &rarr; open <code>${esc(e.route)}</code> &rarr; click <b>New</b> &rarr; form at <code>${esc(e.write.formUrl)}</code> &rarr; ${e.write.save.length ? `click <b>${esc(e.write.save[0])}</b>` : 'save control not identified'}</div>`
    : e.crud.create ? '<div class="path miss">CREATE path not traced — run <code>--forms</code></div>' : ''}
</div>`;
const section = (k, t, d) => byKind(k).length ? `<h2>${t} <em>${d}</em></h2>${byKind(k).map(card).join('')}` : '';

fs.writeFileSync(`${DIR}/schema.html`, `<title>Schema — ${esc(HOST)}</title>
<style>
 body{background:#12141a;color:#e6e6e6;font:14px/1.55 ui-sans-serif,system-ui,sans-serif;margin:0;padding:26px 30px}
 h1{font-size:20px;margin:0 0 2px} h2{font-size:14px;margin:24px 0 6px;color:#7fd1ff;text-transform:uppercase;letter-spacing:.5px}
 h2 em{color:#6b7482;font-style:normal;text-transform:none;letter-spacing:0;font-size:12px;margin-left:8px}
 .sum{color:#939db0;margin-bottom:6px} .sum b{color:#fff}
 .ent{background:#1a1e26;border:1px solid #272d38;border-radius:8px;padding:11px 13px;margin:7px 0}
 .hd{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
 .eid{font-family:ui-monospace,monospace;color:#8ee6a8;font-size:13px}
 .lbl{color:#fff;font-weight:600} code{color:#ffd479;font-size:12px}
 .crud{margin-left:auto} .crud .v{display:inline-block;width:18px;text-align:center;border:1px solid #333a45;border-radius:3px;margin-left:2px;color:#454c58;font-size:11px}
 .crud .v.on{background:#2b6ea8;color:#fff;border-color:#2b6ea8}
 .row{margin-top:7px;display:flex;gap:4px;flex-wrap:wrap;align-items:baseline}
 .row b{color:#6f7a8a;font-size:10px;text-transform:uppercase;min-width:74px;letter-spacing:.4px}
 .chip{background:#232935;border-radius:4px;padding:1px 6px;font-size:12px;display:inline-flex;gap:5px;align-items:baseline}
 .chip i{font-style:normal;font-size:9px;color:#6f7a8a;text-transform:uppercase}
 .chip u{text-decoration:none;font-size:10px;color:#e8cd8a}
 .chip.key{background:#2a2740} .chip.number{background:#1f3040} .chip.date{background:#203026} .chip.enum{background:#33291f}
 .chip.f{background:#24303a} .chip.f.req{background:#3d2733;box-shadow:inset 0 0 0 1px #6d3b4d}
 .path{margin-top:8px;font-size:12px;color:#9fd0f5;background:#151b23;border-left:2px solid #2b6ea8;padding:5px 9px;border-radius:0 4px 4px 0}
 .path.miss{color:#ffb37a;border-color:#7a5330}
</style>
<h1>Schema — ${esc(HOST)}</h1>
<div class="sum"><b>${entities.length}</b> tables ·
 <b>${entities.reduce((n, e) => n + e.columns.length, 0)}</b> columns ·
 <b>${entities.filter((e) => e.crud.create).length}</b> creatable ·
 <b>${entities.filter((e) => e.write).length}</b> with a traced write path ·
 <b>${entities.reduce((n, e) => n + e.refs.length, 0)}</b> foreign keys</div>
<div class="sum">Required write fields are outlined in red — that is what a caller must supply.
 <b>&rarr;name</b> on a field means it points at another table.</div>
${section('document', 'Documents', 'transactional tables — full CRUD')}
${section('master', 'Master data', 'the tables documents point at')}
${section('report', 'Reports', 'read-only projections')}
${section('system', 'System', 'configuration')}`);

console.log(`${entities.length} tables | ${entities.reduce((n, e) => n + e.columns.length, 0)} columns | ${entities.filter((e) => e.crud.create).length} creatable | ${entities.reduce((n, e) => n + e.refs.length, 0)} FKs`);
for (const e of entities.filter((x) => x.kind === 'document')) {
  const c = e.crud;
  console.log(`  ${e.id.padEnd(22)} ${(c.create ? 'C' : '-')}${c.read ? 'R' : '-'}${c.update ? 'U' : '-'}${c.delete ? 'D' : '-'}  cols:${String(e.columns.length).padEnd(3)} write:${e.write ? e.write.fields.length + ' fields (' + e.write.fields.filter((f) => f.required).length + ' required)' : 'NOT TRACED'}  refs:${e.refs.join(',') || '-'}`);
}
console.log(`\nwrote ${DIR}/schema.json and ${DIR}/schema.html`);
