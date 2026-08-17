import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { dossierSlug, renderDossierPage } from '../src/gmapdossier.js';
import type { CompanyDossier } from '../src/enrich/types.js';

const BASE = {
  placeId: '0x31cdcf4b8f617d25:0xd0504d3b0425496c',
  companyName: 'Agriculf Sdn Bhd',
  updatedAt: '2026-08-17T12:57:39.931Z',
  status: 'completed',
  executiveSummary: '### Summary\n\n- **Sells:** agrochemicals\n- Uses `MSIC 20210`',
  legitimacyScore: 78,
  verdict: 'Verified Corporate / Established SME',
  contactMatrix: {
    primaryPhone: '03-1234 5678', allPhones: ['03-1234 5678'],
    primaryEmail: null, allEmails: [], whatsapp: null,
    website: 'https://agriculfchemical.com/', officialAddresses: [], socialLinks: [], keyContacts: [],
  },
} as unknown as CompanyDossier;

const withDomain = (domain: unknown): CompanyDossier =>
  ({ ...BASE, domain } as unknown as CompanyDossier);

test('the page is standalone — no script, no network, nothing to fetch at view time', () => {
  // The whole point of this artefact: it is mailed, opened from a USB stick, or
  // printed. Anything fetched at view time breaks all three.
  const html = renderDossierPage(BASE);
  assert.equal(/<script/i.test(html), false, 'a standalone dossier must ship no JavaScript');
  assert.deepEqual([...html.matchAll(/(?:src|href)\s*=\s*"(?:https?:)?\/\//g)].map((m) => m[0]), []);
  assert.equal(/@import|url\(\s*['"]?https?:/.test(html), false);
  assert.match(html, /^<!doctype html>/);
});

test('a .com.my registrant is rendered as the finding it is', () => {
  const html = renderDossierPage(withDomain({
    domain: 'evocom.com.my', source: 'mynic-whois', registered: true,
    registrantOrganization: 'EVOLUTION COMMERCE SDN. BHD.', registrantState: 'Selangor',
    createdAt: '2019-01-09T16:00:00.000Z', ageYears: 7.6, registrar: 'Exabytes Network Sdn Bhd',
  }));
  assert.match(html, /EVOLUTION COMMERCE SDN\. BHD\./);
  assert.match(html, /7\.6 years/);
  // It must never be presented as a verified registration number.
  assert.match(html, /not verified against SSM/i);
});

test('a redacted gTLD owner says why it is absent instead of showing a blank', () => {
  const html = renderDossierPage(withDomain({
    domain: 'agriculfchemical.com', source: 'rdap', registered: true,
    createdAt: '2023-08-02T11:40:57.000Z', ageYears: 3, registrar: 'GoDaddy.com, LLC',
  }));
  assert.match(html, /redacted by the registry/i);
  // "not established" would claim nobody looked; the registry answered and refused.
  assert.equal(/Registrant<\/dt><dd class="gap">not established/.test(html), false);
});

test('a plain .my distinguishes "not collected" from "redacted"', () => {
  const html = renderDossierPage(withDomain({
    domain: 'collectco.my', source: 'mynic-whois', registered: true, createdAt: '2016-03-28T00:00:00.000Z',
  }));
  assert.match(html, /not published for this registration class/i);
  assert.equal(/redacted by the registry/i.test(html), false);
});

test('a dead domain is a warn card, not a quiet missing field', () => {
  const html = renderDossierPage(withDomain({
    domain: 'amwprotech.my', source: 'mynic-whois', registered: false,
  }));
  assert.match(html, /class="card warn"/);
  assert.match(html, /Dead website/i);
  assert.match(html, /amwprotech\.my/);
});

test('a platform page reports having no own domain rather than nothing', () => {
  const html = renderDossierPage(withDomain({
    domain: 'facebook.com', source: 'platform', note: 'The listed website is a facebook.com page.',
  }));
  assert.match(html, /facebook\.com page/);
  assert.equal(/Dead website/i.test(html), false, 'a platform page is not a dead domain');
});

test('a dossier with no domain stage omits the section instead of rendering an empty one', () => {
  const html = renderDossierPage(BASE);
  assert.equal(/<h2>Domain registry/.test(html), false);
});

test('the company name is escaped', () => {
  const html = renderDossierPage({ ...BASE, companyName: '<img src=x onerror=alert(1)>' } as CompanyDossier);
  assert.equal(html.includes('<img src=x'), false);
  assert.match(html, /&#60;img/);
});

test('the executive brief renders bullets and bold rather than raw markdown', () => {
  const html = renderDossierPage(BASE);
  assert.match(html, /<li><strong>Sells:<\/strong> agrochemicals<\/li>/);
  assert.match(html, /<code>MSIC 20210<\/code>/);
  assert.equal(html.includes('**Sells:**'), false);
});

test('two companies with the same name get different filenames', () => {
  // placeIds are unique, names are not — one must not overwrite the other.
  const a = dossierSlug('KRCB Eco Majestic', '0x31cdcf4b8f617d25:0xaaaaaa');
  const b = dossierSlug('KRCB Eco Majestic', '0x31cdcf4b8f617d25:0xbbbbbb');
  assert.notEqual(a, b);
  assert.match(a, /^krcb-eco-majestic-/);
  assert.equal(/[^a-z0-9-]/.test(a), false, 'the slug must be safe as a filename on any OS');
});

test('the stage log ships with the document', () => {
  // A stage that ran and found nothing versus one that never ran is the difference
  // between a thin dossier and a broken pipeline, and the reader cannot ask us.
  const html = renderDossierPage({
    ...BASE,
    stageLog: [{ stage: 'domain-registry', status: 'ok', detail: 'evocom.com.my age=7.6y', ms: 1842 }],
  } as CompanyDossier);
  assert.match(html, /domain-registry/);
  assert.match(html, /st-ok/);
  assert.match(html, /1\.8s/);
});
