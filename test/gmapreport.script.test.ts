import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { renderReport } from '../src/gmapreport.js';
import type { ProjectMeta } from '../src/gmapproject.js';
import type { BusinessRow } from '../src/leads.js';

// Everything the report ships — markup AND the client-side script — is emitted from
// one TypeScript template literal. That makes a whole class of edit silently fatal:
// a backslash-escaped quote collapses to a bare quote in the generated file, ending
// a JS string early, and the resulting SyntaxError kills the ENTIRE script block.
// The report still opens, still renders its server-side markup, and every
// interactive thing in it — search, filters, the dossier modal — is simply dead.
// Nothing in the build catches it, because the TypeScript is valid; only the
// generated JavaScript is broken.
//
// So: render a report and actually parse what came out.

const META = {
  id: '2026-08-17-test',
  keywords: ['solar installer'],
  places: ['Klang'],
  createdAt: '2026-08-17T00:00:00.000Z',
  updatedAt: '2026-08-17T00:00:00.000Z',
  status: 'complete',
  pausedReason: null,
  stats: { searchesTotal: 1, searchesDone: 1, companies: 1, withPhone: 1, withEmail: 1 },
  saturated: [],
} as ProjectMeta;

const ROWS = [
  {
    placeId: '0x31cdcf4b8f617d25:0xd0504d3b0425496c',
    name: "Ah Meng's Hardware & Co",
    address: 'LOT 6, Jalan Eco Majestic',
    phone: '014-968 4591',
    email: null,
    emails: null,
    website: 'https://amwprotech.my/',
    category: 'Sunroom contractor',
    rating: 4,
    reviews: 17,
    lat: 2.91,
    lng: 101.83,
    hours: null,
    mapsUrl: 'https://maps.google.com/?cid=1',
    facebook: null,
    instagram: null,
    whatsapp: null,
    linkedin: null,
    enrichStatus: 'done',
  } as unknown as BusinessRow,
];

/** Pull every <script> body out of the rendered report. */
function scripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

test('the generated report script is syntactically valid JavaScript', () => {
  const html = renderReport(META, ROWS);
  const blocks = scripts(html);
  assert.ok(blocks.length, 'the report must ship at least one script block');

  blocks.forEach((js, i) => {
    // new Function parses without executing — no DOM needed to prove it compiles.
    assert.doesNotThrow(
      () => new Function(js),
      `script block ${i} does not parse; a broken quote here silently disables the entire report UI`,
    );
  });
});

test('a row whose name contains a quote does not break the script', () => {
  // The embedded DATA blob carries real company names, and Malaysian business names
  // routinely carry apostrophes and ampersands.
  const html = renderReport(META, ROWS);
  assert.ok(html.includes('Ah Meng'), 'the row must actually be embedded for this to prove anything');
  scripts(html).forEach((js) => assert.doesNotThrow(() => new Function(js)));
});

test('the report is genuinely self-contained — no asset is fetched at view time', () => {
  // The footer claims "offline-ready". This is what makes that claim true or false.
  const html = renderReport(META, ROWS);
  const external = [...html.matchAll(/(?:src|href)\s*=\s*"(https?:)?\/\/[^"]*"/g)].map((m) => m[0]);
  assert.deepEqual(external, [], 'the report must not load scripts, styles, fonts or images over the network');
  assert.equal(/@import|url\(\s*['"]?https?:/.test(html), false, 'CSS must not import anything remote');
});

test('dossiers are embedded, so the research survives being mailed as one file', () => {
  const dossier = {
    placeId: ROWS[0].placeId,
    companyName: ROWS[0].name,
    updatedAt: '2026-08-17T13:18:31.292Z',
    status: 'completed',
    executiveSummary: 'Test brief',
    legitimacyScore: 61,
    verdict: 'Active Commercial Business',
    contactMatrix: { primaryPhone: null, allPhones: [], primaryEmail: null, allEmails: [], whatsapp: null, website: null, officialAddresses: [], socialLinks: [], keyContacts: [] },
    domain: { domain: 'amwprotech.my', source: 'mynic-whois', registered: false },
  } as never;

  const html = renderReport(META, ROWS, [dossier]);
  assert.match(html, /const DOSSIERS = \{/, 'the dossier map must be embedded');
  assert.ok(html.includes('amwprotech.my'), 'the domain finding must be inside the file');
  assert.match(html, /DOSSIERS\[placeId\]/, 'the modal must read the embedded copy before any fetch');
  assert.match(html, /1 deep-research dossier embedded/, 'the footer must count what it actually carries');
  scripts(html).forEach((js) => assert.doesNotThrow(() => new Function(js)));
});

test('a dossier for a company not in this report is left out', () => {
  // A project store outlives the row set it was built from; orphans only inflate the file.
  const orphan = { placeId: 'not-in-this-report', companyName: 'Ghost', contactMatrix: {} } as never;
  const html = renderReport(META, ROWS, [orphan]);
  assert.equal(html.includes('not-in-this-report'), false);
});

test('the dossier renderer covers the domain stage', () => {
  // Cheap guard against the other half of the failure: the pipeline collecting
  // domain intel that no renderer ever reads, which is invisible in a passing build.
  const html = renderReport(META, ROWS);
  assert.match(html, /function renderDomain\(/, 'the report must define the domain card renderer');
  assert.match(html, /renderDomain\(d\.domain\)/, 'the domain card must be wired into the dossier grid');
});

test('the dossier renderer covers the archive stage', () => {
  const html = renderReport(META, ROWS);
  assert.match(html, /function renderArchive\(/, 'the report must define the web archive card renderer');
  assert.match(html, /renderArchive\(d\.archive, d\.domain\)/, 'the archive card must be wired into the dossier grid');
});
