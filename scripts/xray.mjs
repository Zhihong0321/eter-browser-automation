// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
//
// Lane 2 MVP (docs/recon-agent-2nd-lane-buildplan.md).
//   node scripts/xray.mjs              -> capture + vision + correlate + emit map
//   node scripts/xray.mjs --no-vision  -> load map, act by selector only, ZERO model calls
//
// Uses the `agent` profile: it is the only one with AutoCount's saved
// email+password, and filling the email makes Chrome autofill the password.

import fs from 'node:fs';
import { chromium } from 'patchright';

for (const l of fs.readFileSync('.env', 'utf8').split('\n')) {
  if (l.includes('=') && !l.startsWith('#')) process.env[l.slice(0, l.indexOf('=')).trim()] = l.slice(l.indexOf('=') + 1).trim();
}

const NO_VISION = process.argv.includes('--no-vision');
const LOGIN = process.argv.includes('--login'); // target the auth page, not Select Company
const PROFILE = 'E:\\eter-browser\\profiles\\agent';
// --url=<any page> points the lane at a different site. Without it, everything
// below behaves exactly as it did for AutoCount.
const ARG_URL = process.argv.find((a) => a.startsWith('--url='))?.slice(6);
const TARGET = ARG_URL ?? 'https://accounting.autocountcloud.com/';
const HOST = new URL(TARGET).hostname;
const MAP = ARG_URL ? `scripts/${HOST}.map.json`
  : LOGIN ? 'scripts/autocount-login.map.json' : 'scripts/autocount.map.json';
const SHOT = ARG_URL ? `scripts/xray-${HOST}.png`
  : LOGIN ? 'scripts/xray-shot-login.png' : 'scripts/xray-shot.png';
const EMAIL = 'zhihong@eternalgy.me'; // Chrome autofills the password once this is filled
// The control the replay clicks, matched on the name VISION gave it.
const ACT = LOGIN ? /log ?in|sign ?in|submit/i : /^macam yes$/i;
const LOGOUT = process.argv.includes('--logout'); // just log out and stop
const GEN = 'scripts/autocount-login.gen.mjs';

// ---------------------------------------------------------------- STAGE: REVEAL MAP
// Every SaaS is a wrapper over a database. Before any automation is written, the
// schema has to be revealed: which pages exist (tables), what each grid shows
// (read schema), what each form takes (write schema), what each dropdown offers
// (foreign keys), and which verbs each page exposes (CRUD).
const REVEAL = process.argv.includes('--reveal');
// The grid is the READ schema. The New form is the WRITE schema -- the fields a
// caller must supply. They are different projections of the same table.
const FORMS = process.argv.includes('--forms');
const REVEAL_DIR = `scripts/reveal-${HOST}`;
// Hardcoded: AutoCount's top bar. Its sidenav links exist in the DOM but are NOT
// clickable until their parent is expanded, which is why typed URLs bounced.
const MENUS = ['Sales', 'Purchase', 'Accounting', 'Reports', 'Tools'];
const MAX_ROUTES = 60; // runaway guard, not a coverage decision

// Every fact this stage records about one page, gathered in a single evaluate().
const PAGE_FACTS = () => {
  const t = (e) => (e.innerText || '').trim().replace(/\s+/g, ' ');
  // AutoCount's grid header is a tbody row, not <th>. Fall back to the first row.
  const cols = (tb) => {
    const th = [...tb.querySelectorAll('th')].map(t).filter(Boolean);
    if (th.length) return th;
    const first = tb.querySelector('tbody tr');
    return first ? [...first.children].map(t).filter(Boolean) : [];
  };
  const grid = [...document.querySelectorAll('table')]
    .map((tb) => ({ cols: cols(tb), rows: tb.querySelectorAll('tbody tr').length }))
    .sort((a, b) => b.cols.length - a.cols.length)[0] ?? { cols: [], rows: 0 };
  const buttons = [...new Set([...document.querySelectorAll('button,[role=button]')]
    .map((b) => (t(b) || b.getAttribute('title') || b.getAttribute('aria-label') || '').trim())
    .filter((s) => s && s.length < 40))];
  const inputs = [...document.querySelectorAll('input,textarea')]
    .filter((i) => i.type !== 'hidden' && i.type !== 'password')
    .map((i) => ({ type: i.type || 'text', name: (i.getAttribute('placeholder') || i.getAttribute('name') || i.getAttribute('aria-label') || '').slice(0, 40) }));
  // A dropdown IS a foreign key: its options are rows of the table it references.
  const selects = [...document.querySelectorAll('select')].map((s) => ({
    name: (s.getAttribute('name') || s.getAttribute('aria-label') || '').slice(0, 40),
    n: s.options.length,
    options: [...s.options].slice(0, 6).map((o) => o.text.trim()),
  }));
  const links = [...new Set([...document.querySelectorAll('a[href]')]
    .map((a) => a.getAttribute('href')).filter((h) => h && h.startsWith('/')))];
  return { columns: grid.cols, dataRows: grid.rows, buttons, inputs, selects, links };
};

// The whole nav is a TREE ALREADY IN THE DOM. A collapsed <ul class="sidenav-menu">
// still contains its <a class="sidenav-link" href="/quotation">. Read it; never
// click menus open to "discover" what is already sitting there.
const NAV_TREE = () => [...document.querySelectorAll('a.sidenav-link[href], a[href]')]
  .map((a) => {
    const li = a.closest('li.sidenav-item');
    const parent = li?.parentElement?.closest('li.sidenav-item');
    const btn = parent?.querySelector(':scope > button, :scope > .sidenav-toggle');
    return {
      href: a.getAttribute('href'),
      text: (a.innerText || a.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 40),
      menu: (btn?.innerText || '').trim().replace(/\s+/g, ' ') || '(top bar)',
    };
  })
  .filter((x) => x.href && x.href.startsWith('/'));

// Every field a create-form asks for, with the label a human sees next to it.
const FORM_FACTS = () => {
  const t = (e) => (e?.innerText || '').trim().replace(/\s+/g, ' ');
  const labelOf = (el) => {
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return t(l); }
    const wrap = el.closest('label'); if (wrap) return t(wrap);
    const lab = el.closest('.form-group,.form-row,.field,.mb-3,.col,div')?.querySelector('label');
    if (lab) return t(lab);
    return el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('name') || '';
  };
  const fields = [...document.querySelectorAll('input,select,textarea')]
    .filter((el) => el.type !== 'hidden' && el.type !== 'password' && el.offsetParent !== null)
    .map((el) => {
      const label = labelOf(el).slice(0, 50);
      const isSel = el.tagName.toLowerCase() === 'select';
      return {
        label,
        kind: isSel ? 'select' : (el.type || 'text'),
        required: !!el.required || /\*/.test(label),
        // A dropdown's options ARE rows of the table it points at.
        options: isSel ? [...el.options].slice(0, 8).map((o) => o.text.trim()).filter(Boolean) : undefined,
      };
    });
  return {
    formUrl: location.pathname,
    fields,
    saves: [...new Set([...document.querySelectorAll('button')].map(t)
      .filter((s) => s && /save|submit|post|confirm/i.test(s)).slice(0, 6))],
  };
};

// The CRUD list, derived from the verbs a page actually shows.
const crudOf = (p) => ({
  C: (p.buttons || []).some((b) => /^(new|add|create)\b/i.test(b)),
  R: (p.columns || []).length > 0 || (p.inputs || []).length > 0,
  U: (p.buttons || []).some((b) => /\b(edit|update|save)\b/i.test(b)),
  D: (p.buttons || []).some((b) => /\b(delete|void|remove|cancel doc)\b/i.test(b)),
});

const writeReport = (pages, host) => {
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const chip = (s, cls = '') => `<span class="chip ${cls}">${esc(s)}</span>`;
  const ok = pages.filter((p) => p.ok).length;
  const miss = pages.filter((p) => !p.ok).length;
  const groups = [...new Set(pages.map((p) => p.menu))];
  const body = groups.map((g) => `
    <h2>${esc(g)}</h2>
    ${pages.filter((p) => p.menu === g).map((p) => {
    const c = crudOf(p);
    const verbs = ['C', 'R', 'U', 'D'].map((k) => `<span class="v ${c[k] ? 'on' : ''}">${k}</span>`).join('');
    return `<div class="card ${p.ok ? '' : 'bad'}">
      <div class="hd">
        <code>${esc(p.href)}</code>
        <span class="ttl">${esc(p.title || p.error || '')}</span>
        <span class="crud">${verbs}</span>
        <span class="st">${p.ok ? 'reached' : 'MISS'}</span>
      </div>
      ${p.ok !== true && p.landed ? `<div class="warn">asked ${esc(p.href)} &rarr; landed ${esc(p.landed)}</div>` : ''}
      ${p.error ? `<div class="warn">${esc(p.error)}</div>` : ''}
      ${p.columns?.length ? `<div class="row"><b>grid (${p.dataRows} rows)</b>${p.columns.map((x) => chip(x, 'col')).join('')}</div>` : ''}
      ${p.buttons?.length ? `<div class="row"><b>actions</b>${p.buttons.filter((b) => !MENUS.includes(b)).map((x) => chip(x, 'act')).join('')}</div>` : ''}
      ${p.inputs?.length ? `<div class="row"><b>inputs (${p.inputs.length})</b>${p.inputs.slice(0, 14).map((i) => chip(`${i.name || i.type}:${i.type}`, 'inp')).join('')}</div>` : ''}
      ${p.selects?.length ? `<div class="row"><b>FK dropdowns</b>${p.selects.map((s) => chip(`${s.name || '?'} (${s.n})`, 'fk')).join('')}</div>` : ''}
      ${p.shot ? `<a href="${p.shot}"><img src="${p.shot}"></a>` : ''}
    </div>`;
  }).join('')}`).join('');
  return `<title>Site map — ${esc(host)}</title>
<style>
 body{background:#14161a;color:#e6e6e6;font:14px/1.5 ui-sans-serif,system-ui,sans-serif;margin:0;padding:28px 32px}
 h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:26px 0 8px;color:#7fd1ff;border-bottom:1px solid #2a2f38;padding-bottom:4px}
 .sum{color:#9aa4b2;margin-bottom:8px} .sum b{color:#e6e6e6}
 .card{background:#1b1f26;border:1px solid #2a2f38;border-radius:8px;padding:12px 14px;margin:8px 0}
 .card.bad{border-color:#7a3030;background:#241a1a}
 .hd{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
 code{color:#ffd479;font-size:13px} .ttl{color:#9aa4b2;flex:1} .st{font-size:11px;color:#5fbf70} .bad .st{color:#ff7a7a}
 .crud .v{display:inline-block;width:17px;text-align:center;border:1px solid #333a44;border-radius:3px;margin-left:2px;color:#4a515c;font-size:11px}
 .crud .v.on{background:#2b5d8a;color:#fff;border-color:#2b5d8a}
 .row{margin-top:7px;display:flex;gap:5px;flex-wrap:wrap;align-items:baseline}
 .row b{font-weight:600;color:#7c8797;font-size:11px;text-transform:uppercase;min-width:96px}
 .chip{background:#252b34;border-radius:4px;padding:1px 7px;font-size:12px}
 .col{background:#1f3347;color:#9fd0f5} .act{background:#2c2440;color:#d3b6f5}
 .inp{background:#243329;color:#a9dfb8} .fk{background:#3a3320;color:#e8cd8a}
 .warn{margin-top:6px;color:#ffb37a;font-size:12px}
 img{max-width:260px;border:1px solid #2a2f38;border-radius:5px;margin-top:9px;display:block}
</style>
<h1>Site map — ${esc(host)}</h1>
<div class="sum"><b>${pages.length}</b> routes walked · <b>${ok}</b> reached · <b>${miss}</b> missed ·
 <b>${pages.filter((p) => p.columns?.length).length}</b> with a grid ·
 <b>${pages.filter((p) => crudOf(p).C).length}</b> can create</div>
<div class="sum">Every route was reached by clicking, never by typing a URL. "MISS" means the page we
 landed on was not the page we asked for — a schema recorded there would be a corrupt catalog.</div>
${body}`;
};

// ---------------------------------------------------------------- step 7: emit a PROGRAM
// The maps are data someone still has to interpret. This turns them into a
// lane-1 script that runs on selectors alone. No browser needed to do it.
if (process.argv.includes('--emit')) {
  const login = JSON.parse(fs.readFileSync('scripts/autocount-login.map.json', 'utf8'));
  const select = JSON.parse(fs.readFileSync('scripts/autocount.map.json', 'utf8'));
  const S = (map, re) => {
    const c = map.filter((e) => re.test(e.name.trim()));
    return (c.find((e) => /button|submit/i.test(e.role)) ?? c[0]).selector;
  };
  fs.writeFileSync(GEN, [
    '// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.',
    '// GENERATED by `node scripts/xray.mjs --emit`. Do not edit — re-emit instead.',
    '// Every selector below was compiled from a screenshot: vision named the control,',
    '// geometry matched that name to a real DOM box. Zero model calls at runtime.',
    "import { chromium } from 'patchright';",
    '',
    "const ctx = await chromium.launchPersistentContext('" + PROFILE.replace(/\\/g, '\\\\') + "', {",
    "  channel: 'chrome', headless: false, args: ['--no-sandbox'],",
    "  viewport: null, ignoreDefaultArgs: ['--enable-automation'],",
    '});',
    'const page = ctx.pages()[0] ?? (await ctx.newPage());',
    '',
    "console.log('step: goto');",
    "await page.goto('" + TARGET + "', { waitUntil: 'domcontentloaded' });",
    'await page.waitForTimeout(7000);',
    '',
    "if (page.url().includes('auth.')) {",
    "  console.log('step: log in');",
    "  await page.locator('" + S(login, /e-?mail|user/i) + "').fill('" + EMAIL + "');",
    '  await page.waitForTimeout(3000);',
    "  await page.locator('" + S(login, /log ?in|sign ?in|submit/i) + "').click();",
    '  await page.waitForTimeout(9000);',
    '}',
    '',
    "console.log('step: pick company');",
    "await page.locator('" + S(select, /^macam yes$/i) + "').click();",
    'await page.waitForTimeout(9000);',
    '',
    "console.log('IN:', page.url(), '|', await page.title());",
    'await ctx.close();',
    '',
  ].join('\n'));
  console.log('emitted', GEN);
  process.exit(0);
}

// ---------------------------------------------------------------- element table
// Runs in the page. Keeps an element only if hit-testing says it is really on
// top at its own centre -- no getComputedStyle guessing.
const TABLE_FN = () => {
  const path = (el) => {
    const parts = [];
    while (el && el.nodeType === 1 && el.tagName !== 'HTML') {
      const tag = el.tagName.toLowerCase();
      const sibs = [...el.parentNode.children].filter((s) => s.tagName === el.tagName);
      parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${sibs.indexOf(el) + 1})` : tag);
      el = el.parentElement;
    }
    return parts.join('>');
  };
  const out = [];
  const all = document.querySelectorAll('input,button,a,select,textarea,img,label,[role],[onclick]');
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) continue;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || !(hit === el || el.contains(hit))) continue;
    const near = el.closest('label')?.innerText || el.parentElement?.innerText || '';
    out.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      // never echo a password field's value to the terminal
      ownText: el.getAttribute('type') === 'password' ? '(hidden)'
        : (el.value || el.innerText || el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('title') || '').trim().slice(0, 40),
      nearestLabelText: near.trim().slice(0, 40).replace(/\s+/g, ' '),
      selector: path(el),
    });
  }
  return { w: innerWidth, h: innerHeight, rows: out };
};

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: false, args: ['--no-sandbox'],
  viewport: null, ignoreDefaultArgs: ['--enable-automation'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

try {
  console.log('step: goto', TARGET);
  await page.goto(TARGET, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(ARG_URL ? 12000 : 7000); // client-rendered pages need longer
  console.log('  landed:', page.url(), '|', await page.title());

  // The login page only exists while logged out. Get there by clicking the Log Out
  // control the FIRST map compiled -- lane 2 driving itself with its own output.
  if ((LOGIN || LOGOUT) && !page.url().includes('auth.')) {
    const prev = JSON.parse(fs.readFileSync('scripts/autocount.map.json', 'utf8'));
    const out = prev.find((e) => /log ?out|sign ?out/i.test(e.name));
    console.log(`step: log out via compiled selector "${out.name}" -> ${out.selector}`);
    await page.locator(out.selector).click();
    await page.waitForTimeout(9000);
    console.log('  landed:', page.url(), '|', await page.title());
  }
  // Log Out drops onto a confirmation page. Hop to the form the way a human does --
  // by clicking, not by typing a URL (buildplan section 8). Selector compiled by the run before.
  if ((LOGIN || LOGOUT) && page.url().includes('logout')) {
    const HOP = 'body>div>div>div>div>div:nth-of-type(3)>a'; // "Back to login"
    console.log('step: hop "Back to login" via compiled selector', HOP);
    await page.locator(HOP).click();
    await page.waitForTimeout(9000);
    console.log('  landed:', page.url(), '|', await page.title());
  }

  if (FORMS) {
    // ============================================ STAGE: REVEAL MAP / write schema
    // Opens each creatable entity's New form and writes down what it asks for.
    // NEVER saves. Reading a form is not creating a record.
    page.on('dialog', (d) => d.accept().catch(() => {}));
    fs.mkdirSync(`${REVEAL_DIR}/forms`, { recursive: true });
    const site = JSON.parse(fs.readFileSync(`${REVEAL_DIR}/sitemap.json`, 'utf8'));
    const LIMIT = +(process.argv.find((a) => a.startsWith('--limit='))?.slice(8) ?? 99);
    const targets = site.filter((p) => p.ok && (p.buttons || []).some((b) => /^(new|add|create)\b/i.test(b))).slice(0, LIMIT);

    if (!page.url().includes('/dashboard')) {
      const prev = JSON.parse(fs.readFileSync('scripts/autocount.map.json', 'utf8'));
      await page.locator(prev.find((e) => /^macam yes$/i.test(e.name.trim())).selector).click();
      await page.waitForTimeout(9000);
    }

    console.log(`\nREVEAL MAP / forms: ${targets.length} creatable entities`);
    const nInputs = () => page.evaluate(() => document.querySelectorAll('input:not([type=hidden]),select,textarea').length);
    // Pages with no grid are hubs -- master-data links live in their body, so a
    // target that is not in the DOM is reachable by hopping through one of them.
    const hubs = site.filter((q) => q.ok && !(q.columns ?? []).length).map((q) => q.href);
    let hub = null;
    const out = {};
    for (const p of targets) {
      const rec = { href: p.href };
      const link = () => page.locator(`a[href="${p.href}"]`).first();
      try {
        if (!(await link().count())) {
          for (const h of hub ? [hub, ...hubs] : hubs) {
            await page.locator(`a[href="${h}"]`).first().evaluate((el) => el.click()).catch(() => {});
            await page.waitForTimeout(3000);
            if (await link().count()) { hub = h; break; }
          }
        }
        await link().evaluate((el) => el.click()); // anchors: native click works
        await page.waitForTimeout(4000);
        const before = await nInputs();
        // A framework <button> ignores HTMLElement.click(). It needs real pointer
        // events, which only a locator click sends.
        await page.locator('button, a').filter({ hasText: /^\s*(New|Add|Create)\s*$/i }).first().click({ timeout: 8000 });
        await page.waitForTimeout(5000);
        // The form is a MODAL -- the route never changes. RAW input count, measured
        // the same way on both sides, is the only honest signal that it opened.
        const after = await nInputs();
        Object.assign(rec, await page.evaluate(FORM_FACTS));
        rec.inputsBefore = before;
        rec.inputsAfter = after;
        rec.ok = after > before + 3;
        const shot = `${REVEAL_DIR}/forms/${p.href.replace(/\W+/g, '_')}.png`;
        await page.screenshot({ path: shot });

        // A document is a HEADER plus a child LINE table. Flat columns are wrong
        // for anything transactional.
        rec.lines = await page.evaluate(() => {
          const t = (e) => (e.innerText || '').trim().replace(/\s+/g, ' ');
          // Same trap as the list grids: the header row is not always <th>.
          const cols = (x) => {
            const th = [...x.querySelectorAll('th')].map(t).filter(Boolean);
            if (th.length) return th;
            const r = x.querySelector('tr');
            return r ? [...r.children].map(t).filter(Boolean) : [];
          };
          return [...document.querySelectorAll('table')].map(cols)
            .sort((a, b) => b.length - a.length)[0] ?? [];
        });

        // The DOM will not say what these inputs are. The SCREEN will. This is the
        // whole point of lane 2 -- run it once here, never at automation time.
        if (rec.ok && !NO_VISION) {
          const { w, h, rows } = await page.evaluate(TABLE_FN);
          const { fastAsk, imageDataUrl } = await import('../dist/fastworker.js');
          const ans = await fastAsk(
            `Screenshot of a data-entry form. List EVERY input, dropdown, date picker and text area.\n` +
            `One per line, exactly this format and nothing else:\nNAME | ROLE | x,y\n` +
            `NAME is the visible label next to the control. x,y is the control's centre, normalised 0-1000.`,
            { images: [imageDataUrl(shot)], maxTokens: 8000, timeoutMs: 120_000 },
          );
          rec.labelled = [];
          for (const line of ans.text.split('\n')) {
            const m = line.match(/^\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(\d+)\s*,\s*(\d+)/);
            if (!m) continue;
            const [, name, role, xs, ys] = m;
            const px = (+xs / 1000) * w, py = (+ys / 1000) * h;
            const hits = rows.filter((r) => /input|select|textarea/.test(r.tag)
              && px >= r.box.x && px <= r.box.x + r.box.w && py >= r.box.y && py <= r.box.y + r.box.h);
            if (!hits.length) continue; // fail closed: never invent a selector
            hits.sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h);
            rec.labelled.push({ name, role, tag: hits[0].tag, selector: hits[0].selector });
          }
          rec.visionMs = ans.ms;
        }
        // Close the modal. Not doing this is what killed the run at entity 15.
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(1500);
      } catch (e) {
        rec.ok = false;
        rec.error = String(e.message).split('\n')[0].slice(0, 100);
        await page.keyboard.press('Escape').catch(() => {});
      }
      out[p.href] = rec;
      console.log(`  ${rec.ok ? 'OK  ' : 'MISS'} ${p.href.padEnd(22)} ${rec.error ?? `inputs ${rec.inputsBefore}->${rec.inputsAfter}${rec.ok ? `  vision named ${rec.labelled?.length ?? 0}  lines[${(rec.lines ?? []).join('|')}]` : '  (no form opened)'}`}`);
      fs.writeFileSync(`${REVEAL_DIR}/forms.json`, JSON.stringify(out, null, 2));
    }
    console.log(`\nwrote ${REVEAL_DIR}/forms.json`);
  } else if (REVEAL) {
    // ================================================== STAGE: REVEAL MAP
    fs.mkdirSync(`${REVEAL_DIR}/shots`, { recursive: true });

    // AutoCount lands on Select Company. Get inside with the selector the FIRST
    // lane-2 run compiled -- the lane driving itself with its own output.
    // THE ONLY site-specific step in this stage. --url= skips it entirely.
    if (!ARG_URL && !page.url().includes('/dashboard')) {
      const prev = JSON.parse(fs.readFileSync('scripts/autocount.map.json', 'utf8'));
      const co = prev.find((e) => /^macam yes$/i.test(e.name.trim()));
      console.log(`step: enter company via compiled selector "${co.name}"`);
      await page.locator(co.selector).click();
      await page.waitForTimeout(9000);
    }
    console.log('  inside:', page.url());

    // ---- phase 1: READ the nav tree. One DOM call, no clicking.
    console.log('\nREVEAL MAP / phase 1: read nav tree');
    const t0 = Date.now();
    const routes = new Map();
    for (const l of await page.evaluate(NAV_TREE)) if (!routes.has(l.href)) routes.set(l.href, l);
    console.log(`  ${routes.size} routes in ${Date.now() - t0} ms`);
    for (const [, r] of routes) console.log(`   ${r.menu.padEnd(14)} ${r.href.padEnd(26)} ${r.text}`);

    // ---- phase 2: reach every route BY CLICKING, and verify we arrived
    console.log(`\nREVEAL MAP / phase 2: reach ${routes.size} routes`);
    const pages = [], seen = new Set(), queue = [...routes.values()];
    while (queue.length && pages.length < MAX_ROUTES) {
      const r = queue.shift();
      // "/" is Switch Company -- it drops out of the company context and breaks
      // every route after it.
      if (seen.has(r.href) || /^\/(logout|signout)?$/.test(r.href)) continue;
      seen.add(r.href);
      const rec = { href: r.href, text: r.text, menu: r.menu };
      const link = () => page.locator(`a[href="${r.href}"]`).first();
      try {
        // Master-data links live in the /masterdata page body, not the sidenav, so
        // they only exist in the DOM while that page is open. Go back to it first.
        if (r.from && !(await link().count())) {
          await page.locator(`a[href="${r.from}"]`).first().evaluate((el) => el.click());
          await page.waitForTimeout(4000);
        }
        // A DOM click fires the router whether or not the anchor is on screen.
        // Expanding menus was never necessary -- the <a> was always there.
        await link().evaluate((el) => el.click());
        await page.waitForTimeout(4500);
        rec.landed = new URL(page.url()).pathname;
        rec.title = await page.title();
        // THE GATE. Asked for X, landed on X? A schema recorded from the wrong
        // page is a corrupt catalog -- worse than a failure, because it looks fine.
        rec.ok = rec.landed === r.href;
        rec.shot = `shots/${r.href.replace(/\W+/g, '_')}.png`;
        await page.screenshot({ path: `${REVEAL_DIR}/${rec.shot}` });
        Object.assign(rec, await page.evaluate(PAGE_FACTS));
        for (const h of rec.links ?? []) {
          if (!seen.has(h) && !routes.has(h)) { routes.set(h, { href: h, text: '', menu: '(discovered)', from: rec.href }); queue.push(routes.get(h)); }
        }
        delete rec.links;
      } catch (e) {
        rec.ok = false;
        rec.error = String(e.message).split('\n')[0].slice(0, 110);
      }
      pages.push(rec);
      console.log(`  ${rec.ok ? 'OK  ' : 'MISS'} ${String(r.href).padEnd(26)} ${rec.error ?? `${(rec.title || '').slice(0, 34)}  cols:${rec.columns?.length ?? 0} btn:${rec.buttons?.length ?? 0} in:${rec.inputs?.length ?? 0}`}`);
      fs.writeFileSync(`${REVEAL_DIR}/sitemap.json`, JSON.stringify(pages, null, 2)); // crash insurance
    }

    // ---- phase 3: report
    fs.writeFileSync(`${REVEAL_DIR}/index.html`, writeReport(pages, HOST));
    console.log(`\nREVEAL MAP done — ${pages.filter((p) => p.ok).length}/${pages.length} reached`);
    console.log(`  ${REVEAL_DIR}/sitemap.json`);
    console.log(`  ${REVEAL_DIR}/index.html`);
  } else if (LOGOUT) {
    console.log('\nlogged out. stopping.');
  } else if (!NO_VISION) {
    // ---- step 1: arrival capture (screenshot + table at the same instant)
    console.log('\nstep 1: capture');
    await page.screenshot({ path: SHOT });
    const { w, h, rows } = await page.evaluate(TABLE_FN);
    console.log(`  viewport ${w}x${h} | ${rows.length} hit-tested visible elements`);
    for (const r of rows) console.log(`   ${String(r.tag + (r.type ? '[' + r.type + ']' : '')).padEnd(16)} ${String(r.box.x + ',' + r.box.y).padEnd(12)} ${String(r.box.w + 'x' + r.box.h).padEnd(10)} "${r.ownText}"  <- ${r.selector}`);

    // ---- step 2: vision pass (one call, on arrival, never per click)
    console.log('\nstep 2: vision');
    const { fastAsk, imageDataUrl } = await import('../dist/fastworker.js');
    const ans = await fastAsk(
      `Screenshot of a web page. List EVERY interactive control you can see: text fields, checkboxes, links, buttons.\n` +
      `One per line, exactly this format and nothing else:\nNAME | ROLE | x,y\n` +
      `x,y is the control's centre, normalised 0-1000. NAME is what a human would call it.`,
      // 3000 was not enough on a 28-control page: the reasoning consumed the whole
      // budget and the answer came back empty. Budget scales with page density.
      { images: [imageDataUrl(SHOT)], maxTokens: 8000, timeoutMs: 120_000 },
    );
    console.log(`  ${ans.ms} ms | ${ans.outputTokens} tok | reasoning ${ans.reasoningChars} chars`);
    console.log(ans.text.split('\n').map((l) => '   ' + l).join('\n'));

    // ---- step 3: correlate by geometry (the whole lane)
    console.log('\nstep 3: correlate');
    const map = [];
    for (const line of ans.text.split('\n')) {
      const m = line.match(/^\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(\d+)\s*,\s*(\d+)/);
      if (!m) continue;
      const [, name, role, xs, ys] = m;
      const px = (+xs / 1000) * w, py = (+ys / 1000) * h;
      const hits = rows.filter((r) => px >= r.box.x && px <= r.box.x + r.box.w && py >= r.box.y && py <= r.box.y + r.box.h);
      if (!hits.length) { console.log(`   DROPPED  "${name}" at ${Math.round(px)},${Math.round(py)} — no element box contains that point`); continue; }
      hits.sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h);
      const hit = hits[0];
      console.log(`   "${name}" -> ${hit.selector}   (box ${hit.box.x},${hit.box.y} ${hit.box.w}x${hit.box.h})`);
      map.push({ name, role, selector: hit.selector, box: hit.box, capturedAt: new Date().toISOString(), url: page.url() });
    }

    // ---- step 4: emit
    fs.writeFileSync(MAP, JSON.stringify(map, null, 2));
    console.log(`\nstep 4: wrote ${MAP} — ${map.length} controls`);
  } else {
    // ---- step 5: prove the compile. Selectors only. No model, no screenshot, no names.
    console.log('\nstep 5: replay from map, ZERO model calls');
    const map = JSON.parse(fs.readFileSync(MAP, 'utf8'));

    // step 6: do the emitted selectors still resolve after a fresh page load?
    const resolved = await page.evaluate((m) => m.map((e) => ({
      name: e.name,
      n: document.querySelectorAll(e.selector).length,
      text: (document.querySelector(e.selector)?.innerText || '').trim().slice(0, 20),
    })), map);
    for (const r of resolved) console.log(`  ${r.n === 1 ? 'OK  ' : 'FAIL'} "${r.name}" -> ${r.n} match, DOM text "${r.text}"`);

    const cands = map.filter((e) => ACT.test(e.name.trim()));
    const target = cands.find((e) => /button|submit/i.test(e.role)) ?? cands[0];
    if (!target) { console.log('\n  no ACT match on this map — survival check only, nothing clicked'); await ctx.close(); process.exit(0); }
    const before = { url: page.url(), title: await page.title() };
    if (LOGIN) {
      const email = map.find((e) => /e-?mail|user/i.test(e.name));
      console.log(`\n  fill "${email.name}" via ${email.selector}`);
      await page.locator(email.selector).fill(EMAIL);
      await page.waitForTimeout(3000); // give Chrome a moment to autofill the password
    }
    console.log(`  click "${target.name}" via ${target.selector}`);
    await page.locator(target.selector).click();
    await page.waitForTimeout(9000);
    await page.screenshot({ path: 'scripts/xray-after.png' });

    console.log(`\n  before: ${before.url}  |  ${before.title}`);
    console.log(`  after : ${page.url()}  |  ${await page.title()}`);
  }
} catch (err) {
  console.error('\nDIED at', page.url(), '\n', err.message);
  await page.screenshot({ path: 'scripts/xray-crash.png' }).catch(() => {});
} finally {
  await ctx.close();
}
