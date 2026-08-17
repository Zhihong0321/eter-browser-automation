// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
//
// GENERIC FORM ENGINE. Takes a job JSON, drives any web app, verifies the result.
// Nothing in here knows what AutoCount is.
//
// Design rules, all bought with failures logged in docs/STUPID-MISTAKE-LOG.md:
//   1. NEVER click by selector. Find the element, take the TEXT's rectangle, click the pixels.
//   2. NEVER waitForTimeout as a page wait. Wait on the SHAPE OF THE DATA.
//   3. ONE LAUNCH PER JOB. A job is a LIST of tasks sharing one browser and one login.
//      Relaunching to do the next step is the single most expensive habit in this repo.
//   4. READING is a task, not a hand-written probe. `op: "list"` dumps any grid.
//   5. A task that is already done is SKIPPED, not re-decided. `ensureAbsent`.
//
// Fields are found by their visible LABEL, then by "is this element actually on top of
// itself" — which is what disambiguates 3 identical date boxes on one page.
//
// JOB SHAPE
//   { name, profile, site, entry, tasks: [ task, ... ] }
//   task = { op:"list",  route, label? }
//   task = { op:"create", route, action, gridMarker, ensureAbsent?, fields[], lines[], save, verify }
//   field = { label, value }                        plain input
//         | { label, value, type:"lookup", match }  grid-popup dropdown
//         | { label, value, type:"date" }           ISO yyyy-mm-dd, drives the calendar
//         | { label, tab:"General", value }         click that tab first
//         | { label, auto:{ column, format } }      next code from the grid, e.g. "300-A%03d"
//   A legacy flat job (route/fields at top level, no `tasks`) still runs, as one create task.
import { chromium } from 'patchright';
import fs from 'fs';

const JOB = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const TASKS = JOB.tasks ?? [{ op: 'create', ...JOB }];
const t0 = Date.now();
const log = (s) => console.log(`[${String((Date.now() - t0) / 1000).padStart(6)}s] ${s}`);

const ctx = await chromium.launchPersistentContext(JOB.profile, {
  channel: 'chrome', headless: false, args: ['--no-sandbox'],
  viewport: null, ignoreDefaultArgs: ['--enable-automation'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

// ---------- primitives ----------

async function until(desc, expr, timeout = 45000) {
  const t = Date.now();
  await page.waitForFunction(expr, null, { timeout, polling: 300 });
  log(`  ok ${desc} (${Date.now() - t}ms)`);
}

const settle = (ms) => page.waitForTimeout(ms); // only ever AFTER a confirmed condition

// soft check: did this become true within ms? returns bool instead of throwing
const seen = (expr, ms = 3000) =>
  page.waitForFunction(expr, null, { timeout: ms, polling: 200 }).then(() => true).catch(() => false);

async function clickBox(b, what) {
  log(`  click ${what} @ ${Math.round(b.x)},${Math.round(b.y)}`);
  await page.mouse.click(b.x, b.y);
}

// the element that owns a visible label: first real editor after it that is on top of itself
const fieldBox = (label, scope) =>
  page.evaluate(({ label, scope }) => {
    const root = scope ? document.querySelector(scope) : document;
    if (!root) return null;
    const onTop = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return null;
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const t = document.elementFromPoint(x, y);
      if (!(t && (t === el || el.contains(t)))) return null;
      let n = el.parentElement, wrap = r;
      for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
        const rr = n.getBoundingClientRect();
        if (rr.width > r.width + 12) { wrap = rr; break; }
      }
      return { x, y, value: el.value, w: r.width, right: r.right, btnX: wrap.right - 14 };
    };
    const all = [...root.querySelectorAll('input,textarea')].filter((e) => e.type !== 'hidden');
    for (const l of [...root.querySelectorAll('label')].filter((l) => l.innerText.trim() === label)) {
      const after = all.filter((e) => l.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING);
      for (const el of after.slice(0, 6)) { const b = onTop(el); if (b) return b; }
    }
    return null;
  }, { label, scope });

// Click the TEXT ITSELF. A DOM Range around the text node gives the exact glyph rectangle,
// so "Save" lands on the word "Save" and never on the split-button caret beside it.
// Element rectangles include adjacent controls; text rectangles cannot.
const textBox = (text, scope) =>
  page.evaluate(({ text, scope }) => {
    const root = scope ? document.querySelector(scope) : document.body;
    if (!root) return null;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const cands = [];
    while (w.nextNode()) {
      const n = w.currentNode;
      const t = (n.textContent || '').trim();
      if (!t || !t.includes(text)) continue;
      const rg = document.createRange();
      rg.selectNodeContents(n);
      const r = rg.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      cands.push({ n, exact: t === text ? 0 : 1, len: t.length, r });
    }
    cands.sort((a, b) => a.exact - b.exact || a.len - b.len);
    for (const c of cands.slice(0, 12)) {
      const x = c.r.left + c.r.width / 2, y = c.r.top + c.r.height / 2;
      const hit = document.elementFromPoint(x, y);
      const owner = c.n.parentElement;
      if (hit && (hit === owner || owner.contains(hit) || hit.contains(owner)))
        return { x, y, txt: c.n.textContent.trim().slice(0, 40) };
    }
    return null;
  }, { text, scope });

// the only honest wait for a click: poll until the thing is ACTUALLY clickable.
// "text exists in body" fires instantly on text that was already there (log rule 15).
async function clickText(text, what, timeout = 30000) {
  const t = Date.now();
  for (;;) {
    const b = await textBox(text);
    if (b) { await clickBox(b, what ?? `"${text}"`); return b; }
    if (Date.now() - t > timeout) throw new Error(`"${text}" never became clickable`);
    await page.waitForTimeout(300);
  }
}

async function typeInto(label, value, scope) {
  const b = await fieldBox(label, scope);
  if (!b) throw new Error(`no field for label "${label}"`);
  await clickBox(b, `field "${label}"`);
  await page.keyboard.press('Control+a');
  await page.keyboard.type(String(value));
  await settle(300);
}

// dropdown / lookup: click it, type the key, click the row that matches
async function pickLookup(label, value, match, scope) {
  const b = await fieldBox(label, scope);
  if (!b) throw new Error(`no lookup for "${label}"`);
  await clickBox(b, `lookup "${label}"`);
  await settle(700);
  await page.keyboard.type(String(value));
  await clickText(match, `lookup row "${match}"`);
  await settle(1200);
}

// readonly date box -> drive the calendar popup by geometry
async function pickDate(label, iso, scope) {
  const [y, m, d] = iso.split('-').map(Number);
  const want = new Date(y, m - 1, d).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const b = await fieldBox(label, scope);
  if (!b) throw new Error(`no date field "${label}"`);
  await clickBox(b, `date "${label}"`);
  const open = `!!document.querySelector('.dx-calendar')`;
  // the field is focused now. Alt+Down is THE standard "open this dropdown" keystroke and
  // needs no DOM knowledge at all. Only if that fails, click the WIDGET's right edge --
  // the trailing button sits outside the input's own rect, beside it.
  if (!(await seen(open, 1200))) {
    log('  no calendar from click -> Alt+ArrowDown');
    await page.keyboard.press('Alt+ArrowDown');
    if (!(await seen(open, 2500))) {
      log(`  still none -> clicking widget edge @ ${Math.round(b.btnX)}`);
      await clickBox({ x: b.btnX, y: b.y }, 'date dropdown button');
      if (!(await seen(open, 4000))) throw new Error('calendar never opened');
    }
  }
  log('  calendar open');
  for (let i = 0; i < 18; i++) {
    const cap = await page.evaluate(() => document.querySelector('.dx-calendar-caption-button')?.innerText.trim());
    if (cap && cap.replace(/\s+/g, ' ') === want) break;
    const dir = new Date(cap + ' 1') > new Date(y, m - 1, 1) ? 'previous' : 'next';
    const nav = await page.evaluate((dir) => {
      const el = document.querySelector(`.dx-calendar-navigator-${dir}-view`);
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, dir);
    await clickBox(nav, `calendar ${dir} (at "${cap}", want "${want}")`);
    await settle(500);
  }
  const day = await page.evaluate((d) => {
    const c = [...document.querySelectorAll('.dx-calendar-cell')]
      .find((e) => e.innerText.trim() === String(d) && !e.classList.contains('dx-calendar-other-view'));
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, d);
  await clickBox(day, `day ${d}`);
  await settle(900);
}

// fill the blank row that data grids leave sitting there, by COLUMN HEADER NAME
async function fillGridRow(cells, gridMarker, rowIdx = 0) {
  for (const [col, val] of Object.entries(cells)) {
    const b = await page.evaluate(({ col, gridMarker, rowIdx }) => {
      const g = [...document.querySelectorAll('.dx-datagrid')].find((x) => x.innerText.includes(gridMarker));
      const heads = [...g.querySelectorAll('.dx-header-row td')].map((c) => c.innerText.replace(/\s+/g, ' ').trim());
      const i = heads.findIndex((h) => h.toLowerCase() === col.toLowerCase());
      const rows = g.querySelectorAll('tr.dx-data-row');
      if (!rows[rowIdx]) return { err: `no grid row ${rowIdx} (grid has ${rows.length})` };
      const cell = rows[rowIdx].querySelectorAll('td')[i];
      const r = cell.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, i, heads };
    }, { col, gridMarker, rowIdx });
    if (b.err) throw new Error(b.err);
    await clickBox(b, `grid row ${rowIdx} cell "${col}" (col ${b.i})`);
    await settle(700);
    await page.keyboard.type(String(val));
    await settle(400);
    await page.keyboard.press('Tab');
    await settle(900);
  }
}

// ---------- list grids (the READ path — replaces every hand-written probe) ----------

// DevExtreme stacks 4 <table>s per grid and only one holds data; the rest are
// pointer-events-none overlay clones. Take the one with the most data rows.
const readGrid = () =>
  page.evaluate(() => {
    const heads = [...document.querySelectorAll('.dx-header-row td, .dx-header-row th')]
      .map((c) => c.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const t = [...document.querySelectorAll('table')]
      .sort((a, b) => b.querySelectorAll('tr.dx-data-row').length - a.querySelectorAll('tr.dx-data-row').length)[0];
    const rows = [...(t?.querySelectorAll('tr.dx-data-row') || [])].map((r) =>
      [...r.querySelectorAll('td')].map((c) => c.innerText.replace(/\u00a0/g, '').replace(/\s+/g, ' ').trim())
        .filter((s) => s && s !== 'Edit' && !s.startsWith('Edit Toggle')));
    return { heads, rows, pager: (document.body.innerText.match(/Page \d+ of \d+ \([\d,]+ items?\)/) || ['?'])[0] };
  });

function printGrid(title, g) {
  console.log(`\n=========== ${title} ===========`);
  console.log(' ', g.pager);
  console.log('  ' + g.heads.join(' | '));
  g.rows.forEach((r) => console.log('    ' + r.join('  ·  ')));
  console.log('='.repeat(title.length + 24));
}

async function gotoGrid(route) {
  log(`route ${route}`);
  await page.goto(JOB.site + route, { waitUntil: 'domcontentloaded' });
  await until('grid shell', `!!document.querySelector('.dx-header-row') && /Page \\d+ of \\d+/.test(document.body.innerText)`);
  // RULE 14. The header row is NOT the data. Waiting on it returned an EMPTY grid on a cold
  // navigation, ensureAbsent saw nothing, and the engine tried to create a duplicate.
  // So: the pager's item count must AGREE with the rendered rows, and must hold still --
  // "(0 items)" is also what this grid shows while loading, so one reading of it proves nothing.
  let stable = 0, last = -1;
  for (let i = 0; i < 80; i++) {
    const s = await page.evaluate(() => {
      const m = document.body.innerText.match(/\(([\d,]+) items?\)/);
      return { n: m ? +m[1].replace(/,/g, '') : -1, rows: document.querySelectorAll('tr.dx-data-row').length };
    });
    if (s.n >= 0 && s.rows >= Math.min(s.n, 1) && s.n === last) {
      if (++stable >= 2) { log(`  ok grid data (${s.n} items, ${s.rows} rows rendered)`); return; }
    } else stable = 0;
    last = s.n;
    await settle(250);
  }
  throw new Error(`grid at ${route} never settled`);
}

// job-scoped variables: a field with `saveAs:"code"` publishes its value, and any later
// task writes `$code` to use it. Kills hand-carrying a generated code between tasks.
const VARS = {};
const subst = (s) => (typeof s === 'string' ? s.replace(/\$(\w+)/g, (m, k) => VARS[k] ?? m) : s);

// next code from what is already in the grid: "300-A002" + format "300-A%03d" -> "300-A003"
function nextCode(grid, column, format) {
  const i = grid.heads.findIndex((h) => h.toLowerCase() === column.toLowerCase());
  const nums = grid.rows.map((r) => (String(r[i] ?? '').match(/(\d+)\s*$/) || [])[1]).filter(Boolean).map(Number);
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  return format.replace(/%0(\d)d/, (_, w) => String(n).padStart(+w, '0'));
}

// ---------- tasks ----------

async function runList(task) {
  await gotoGrid(task.route);
  printGrid(task.label ?? `LIST ${task.route}`, await readGrid());
}

async function runCreate(task) {
  await gotoGrid(task.route);
  const grid = await readGrid();

  const absent = subst(task.ensureAbsent);
  if (absent) {
    const hit = grid.rows.find((r) => r.join(' ').includes(absent));
    if (hit) {
      // the record is already there -> publish ITS code, so later tasks still resolve $vars.
      for (const f of task.fields ?? []) {
        if (!f.saveAs || !f.auto) continue;
        const i = grid.heads.findIndex((h) => h.toLowerCase() === f.auto.column.toLowerCase());
        VARS[f.saveAs] = hit[i];
        log(`  $${f.saveAs} = ${hit[i]} (from the row that already exists)`);
      }
      log(`SKIP — "${absent}" already in ${task.route}`);
      return;
    }
    log(`"${absent}" not in ${task.route} -> creating`);
  }

  const fields = (task.fields ?? []).map((f) => {
    const v = f.auto ? nextCode(grid, f.auto.column, f.auto.format) : subst(f.value);
    if (f.saveAs) { VARS[f.saveAs] = v; log(`  $${f.saveAs} = ${v}`); }
    return { ...f, value: v, match: subst(f.match) };
  });

  await clickText(task.action ?? 'New');
  // poll until the form is REAL: Save must be clickable AND the first label must resolve.
  const firstLabel = fields.find((f) => !f.tab)?.label;
  for (const t = Date.now(); ;) {
    const okSave = await textBox(task.save ?? 'Save');
    const okField = firstLabel ? await fieldBox(firstLabel, null) : true;
    if (okSave && okField) { log('  ok form open'); break; }
    if (Date.now() - t > 45000) throw new Error('form never opened');
    await settle(300);
  }
  // fields live inside the modal when there is one; the debtor form is a plain page.
  const scope = (await page.evaluate(() => !!document.querySelector('.modal.show'))) ? '.modal.show' : null;
  log(`  scope: ${scope ?? 'document'}`);

  let tab = null;
  for (const f of fields) {
    if (f.tab && f.tab !== tab) { log(`tab: ${f.tab}`); await clickText(f.tab, `tab "${f.tab}"`); await settle(1200); tab = f.tab; }
    log(`field: ${f.label} = ${String(f.value).slice(0, 50)}`);
    if (f.type === 'lookup') await pickLookup(f.label, f.value, f.match, scope);
    else if (f.type === 'date') await pickDate(f.label, f.value, scope);
    else await typeInto(f.label, f.value, scope);
  }

  for (const [i, line] of (task.lines ?? []).entries()) {
    log(`line item ${i}`);
    await fillGridRow(Object.fromEntries(Object.entries(line).map(([k, v]) => [k, subst(v)])), task.gridMarker, i);
  }

  if (task.lines?.length) {
    await settle(1200);
    const before = await page.evaluate((gm) => {
      const m = document.querySelector('.modal.show') ?? document.body;
      const g = [...m.querySelectorAll('.dx-datagrid')].find((x) => x.innerText.includes(gm));
      return {
        rows: [...g.querySelectorAll('tr.dx-data-row')].map((r) =>
          [...r.querySelectorAll('td')].map((c) => c.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · ')),
        total: (m.innerText.match(/Total[\s\S]{0,30}/) || [''])[0].replace(/\s+/g, ' '),
      };
    }, task.gridMarker);
    console.log('  BEFORE SAVE:');
    before.rows.forEach((r) => console.log('    ' + r));
    console.log('    ' + before.total);
  }

  await clickText(task.save ?? 'Save', 'Save');
  await until('form closed', `!document.querySelector('.modal.show')`, 60000).catch(() => log('  (no modal to close)'));
  await settle(2500);

  await gotoGrid(task.verify?.route ?? task.route);
  await until('record present', `document.body.innerText.includes(${JSON.stringify(subst(task.verify.contains))})`);
  printGrid(`VERIFIED ${task.route}`, await readGrid());
}

// ---------- run the job ----------

try {
  log(`JOB: ${JOB.name}  (${TASKS.length} task${TASKS.length > 1 ? 's' : ''}, ONE launch)`);
  await page.goto(JOB.site, { waitUntil: 'domcontentloaded' });
  await until('app shell', `document.body.innerText.includes(${JSON.stringify(JOB.entry)})`);
  await settle(800);
  await clickText(JOB.entry, `entry "${JOB.entry}"`);
  await until('logged in', `location.pathname !== '/' && document.querySelectorAll('a[href]').length > 10`);
  await settle(1500);

  for (const [i, task] of TASKS.entries()) {
    log(`--- task ${i + 1}/${TASKS.length}: ${task.op} ${task.route} ---`);
    if (task.op === 'list') await runList(task);
    else await runCreate(task);
  }
  log(`DONE in ${(Date.now() - t0) / 1000}s`);
} catch (e) {
  log(`FAILED at ${page.url()}`);
  await page.screenshot({ path: 'scripts/engine-fail.png', fullPage: true });
  console.log(String(e).slice(0, 500));
}

await ctx.close();
