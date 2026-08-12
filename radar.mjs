// gmap-review-radar — read the customer reviews for companies gmap-recon already found.
//
//   node radar.mjs list                    gmap-recon projects you can run this on
//   node radar.mjs <project-id>            read reviews for every company in it
//
// This adds ONE capability on top of gmap-recon and reuses everything else it already
// does: its projects, its leads.db, its Chrome profile, its rate ledger. Nothing in
// gmap-recon is modified — the database is opened to read the company list, and the
// output lands beside it.
//
//   <gmap project>/reviews/<placeId>.json   one file per company, written as it is read
//   <gmap project>/reviews.csv              one row per REVIEW, rebuilt from those files
//
// Resume is the file check: a company whose json already exists is skipped, so Ctrl+C
// costs one company and rerunning never re-opens a page that already succeeded.

import fs from 'node:fs';
import path from 'node:path';
import { Vault } from './dist/vault.js';
import { BrowserManager } from './dist/browser.js';
import { resolveVaultHome } from './dist/config.js';
import { LeadStore } from './dist/leads.js';
import { SearchLimiter, DEFAULT_LIMITS } from './dist/gmaprecon.js';
import { readReviews, toCsv } from './dist/radar.js';
import { renderReviewReport } from './dist/radarreport.js';
import { listProjects, projectDir } from './dist/gmapproject.js';

const REVIEW_COLUMNS = [
  'company', 'author', 'rating', 'dateText', 'approxDate', 'text',
  'replyText', 'replyDateText', 'lang', 'localGuide', 'authorReviews', 'photos',
  'authorUrl', 'placeId', 'reviewId', 'harvestedAt',
];

const id = process.argv[2];

if (!id || id === 'help' || id === '--help') {
  console.log(`
  GMAP-REVIEW-RADAR — customer reviews for gmap-recon's companies

    node radar.mjs list           projects you can run this on
    node radar.mjs <project-id>   read every review for every company in it
    node radar.mjs <project-id> 1 stop after 1 company — use this to test

  Slow by nature: one page open per company, plus a lazy load per ten reviews.
  Ctrl+C is safe — rerun the same command to carry on.
`);
  process.exit(id ? 0 : 1);
}

if (id === 'list') {
  const all = listProjects();
  if (!all.length) {
    console.log('\n  No gmap-recon projects yet. Make one with: node gmap.mjs new "..." "..."\n');
    process.exit(0);
  }
  console.log('');
  for (const p of all) console.log(`  ${String(p.stats.companies).padStart(5)} companies   ${p.id}`);
  console.log('');
  process.exit(0);
}

const dir = projectDir(id);
if (!fs.existsSync(path.join(dir, 'leads.db'))) {
  console.log(`\n  No leads.db in ${dir}\n  Run: node radar.mjs list\n`);
  process.exit(1);
}

const outDir = path.join(dir, 'reviews');
fs.mkdirSync(outDir, { recursive: true });

const store = new LeadStore(path.join(dir, 'leads.db'));
const companies = store.rows();
store.close();

const vault = new Vault(resolveVaultHome());
const browser = new BrowserManager(vault, 'gmaprecon');
// The same ledger gmap-recon uses. Google throttles the PROFILE, so a second budget
// for the same profile would just let it be spent twice.
const budget = new SearchLimiter(path.join(vault.home, 'gmap-search-history.json'), DEFAULT_LIMITS);

// Optional second argument caps how many companies this run touches, so a test is
// one company rather than a thousand reviews.
// 0 means read nothing and just rebuild the report from what is already on disk.
// An absent argument means no cap. Anything unparseable is treated as absent.
const arg = process.argv[3];
const cap = arg !== undefined && Number.isFinite(Number(arg)) && Number(arg) >= 0 ? Number(arg) : Infinity;
const todo = companies
  .filter((c) => !fs.existsSync(path.join(outDir, `${encodeURIComponent(c.placeId)}.json`)))
  .slice(0, cap === Infinity ? undefined : cap);
console.log(`\n  ${id}\n  ${companies.length} companies, ${todo.length} still to read\n`);

const short = [];

try {
  if (todo.length) {
    await browser.run(async (ctx, page) => {
      const open = ctx.pages().filter((p) => !p.isClosed());
      const tab = open[0] ?? page;
      browser.pin(tab);

      for (const c of todo) {
        await budget.take();
        try {
          const out = await readReviews(tab, c.placeId, c.mapsUrl);
          fs.writeFileSync(
            path.join(outDir, `${encodeURIComponent(c.placeId)}.json`),
            JSON.stringify({ company: c.name, declared: out.declared, complete: out.complete, reviews: out.reviews }, null, 2),
            'utf8',
          );
          const of = out.declared === null ? '?' : out.declared;
          console.log(`  ${out.complete ? '·' : '!'} ${c.name} — ${out.harvested}/${of}`);
          if (!out.complete) short.push(`${c.name}: ${out.harvested} of ${of}`);
        } catch (e) {
          const msg = String(e?.message ?? e);
          console.log(`  x ${c.name} — ${msg}`);
          // A hard block is terminal: grinding on turns a temporary throttle into a
          // lasting one. Nothing is lost — finished companies are already on disk.
          if (msg.startsWith('blocked:')) {
            console.log('\n  Stopped. Let the profile rest, then run the same command again.\n');
            return;
          }
        }
      }
    });
  }
} finally {
  await browser.close();
}

// ---- rebuild the spreadsheet and the report from every company file ----------
// Both are regenerated from the per-company json on every run, so an interrupted
// campaign still leaves a report covering everything read so far.
const files = fs.readdirSync(outDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')));
const rows = files.flatMap((d) => d.reviews.map((r) => ({ ...r, company: d.company })));

const csv = path.join(dir, 'reviews.csv');
const html = path.join(dir, 'reviews.html');
fs.writeFileSync(csv, toCsv(REVIEW_COLUMNS, rows), 'utf8');
fs.writeFileSync(html, renderReviewReport(id, files), 'utf8');

console.log(`\n  ${rows.length} reviews`);
console.log(`  report ${html}`);
console.log(`  csv    ${csv}\n`);
if (short.length) {
  // A silently truncated corpus is the one failure that makes the whole analysis
  // wrong without ever looking wrong, so the short companies are named.
  console.log('  Fewer reviews than Google declared for:');
  for (const s of short.slice(0, 15)) console.log(`    - ${s}`);
  console.log('  Delete those files from the reviews/ folder and rerun to retry.\n');
}
