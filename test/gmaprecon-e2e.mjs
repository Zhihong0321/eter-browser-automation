// gmap-recon end-to-end: plan → harvest → status → export, against live Maps.
//
// Runs the BUILT artifact in dist/, not the TypeScript source. That is deliberate:
// tsx compiles via esbuild with keepNames, which injects a `__name` helper into any
// function it touches — and a function passed to page.evaluate() is serialised into
// the browser, where that helper does not exist. tsc emits no such helper, so the
// only honest test is of the thing that actually ships.
//
// Uses a THROWAWAY vault home; never touches the real profile or lead store.
// One Google search.
//
//   npm run build && node test/gmaprecon-e2e.mjs

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { VaultService } from '../dist/service.js';

const HOME = path.join(os.tmpdir(), 'gmaprecon-e2e');
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });

const show = (label, v) => console.log(`\n── ${label}\n${JSON.stringify(v, null, 2)}`);

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const svc = new VaultService(HOME);

try {
  show('plan', svc.gmapPlan(['solar panel installer'], ['Petaling Jaya']));

  const harvest = await svc.gmapHarvest(1);
  show('harvest', { ran: harvest.ran, found: harvest.found, halted: harvest.halted });

  // Stage 2 on a small slice — plain fetch against third-party sites, no browser.
  const enrich = await svc.gmapEnrich(6);
  show('enrich', { attempted: enrich.attempted, done: enrich.done, failed: enrich.failed });

  const status = svc.gmapStatus();
  show('status', status);

  const csv = path.join(HOME, 'leads.csv');
  show('export', svc.gmapExport(csv, {}));

  const lines = fs.readFileSync(csv, 'utf8').trim().split('\r\n');
  console.log(`\n── csv head\n${lines.slice(0, 3).join('\n')}`);

  console.log('\n── assertions');
  check('harvest did not halt', !harvest.halted, String(harvest.halted ?? ''));
  check('search marked done', status.searches.done === 1, JSON.stringify(status.searches));
  check('found businesses', status.businesses > 20, `${status.businesses} rows`);
  check('phones extracted', status.withPhone > 0, `${status.withPhone}/${status.businesses}`);
  check('csv rows match store', lines.length - 1 === status.businesses, `${lines.length - 1} csv rows`);
  check('enrich attempted', enrich.attempted > 0, `${enrich.attempted} sites`);
  check('enrich resolved every site', enrich.done + enrich.failed === enrich.attempted, `${enrich.done} ok / ${enrich.failed} failed`);
  check('enrich found some contact', status.withEmail > 0, `${status.withEmail} emails`);

  // Field-level. The whole design rests on these coming off the FEED with no detail
  // click; if they are missing, the campaign costs 60x the requests and is not viable.
  const body = lines.slice(1);
  const withSite = body.filter((l) => /https?:\/\//.test(l)).length;
  const withCoords = body.filter((l) => /,-?\d+\.\d{5,},-?\d+\.\d{5,},/.test(l)).length;
  check('websites off the feed', withSite > 0, `${withSite}/${body.length}`);
  check('coordinates off the feed', withCoords > body.length * 0.9, `${withCoords}/${body.length}`);
} catch (e) {
  console.error('\n✖ threw:', e.message);
  failed++;
} finally {
  await svc.shutdown();
  console.log(failed ? `\n${failed} CHECK(S) FAILED\n` : '\nALL CHECKS PASSED\n');
  process.exit(failed ? 1 : 0);
}
