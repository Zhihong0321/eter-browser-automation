import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { renderFullDossier, renderGroupReadme, renderRagProfile } from '../src/gmapmarkdown.js';
import { groupSlug } from '../src/ragbucket.js';
import type { CompanyDossier } from '../src/enrich/types.js';
import type { BusinessRow } from '../src/leads.js';

const BIZ = {
  placeId: '0x1:0x2',
  name: 'Agriculf Sdn Bhd',
  address: 'Lot 6, Jalan Eco Majestic',
  category: 'Pesticide supplier',
  rating: 4.6,
  reviews: 23,
  website: 'https://agriculfchemical.com/',
} as unknown as BusinessRow;

const FULL = {
  placeId: '0x1:0x2',
  companyName: 'Agriculf Sdn Bhd',
  updatedAt: '2026-08-17T12:57:39.931Z',
  status: 'completed',
  executiveSummary: '### Summary\n\n- Sells agrochemicals',
  legitimacyScore: 61,
  verdict: 'Active Commercial Business',
  domain: {
    domain: 'agriculfchemical.com', source: 'rdap', registered: true,
    createdAt: '2023-08-02T11:40:57.000Z', ageYears: 3, registrar: 'GoDaddy.com, LLC',
  },
  pageInsight: {
    ok: true, source: 'browser', strategy: 'mobile', url: 'x', fetchedAt: '2026-08-17', ms: 1,
    scores: { performance: 34, accessibility: null, bestPractices: null, seo: 80 },
    performanceEstimated: true,
    metrics: { lcpMs: 8400, clsScore: null, tbtMs: null, fcpMs: null, ttfbMs: null, speedIndexMs: null, transferBytes: null, requests: null },
    field: null, opportunities: [{ title: 'Reduce unused JavaScript', detail: '', savingsMs: 2100 }], checks: [],
  },
  chatgpt: {
    ok: true, ms: 1, brief: 'Long brief text',
    facts: {
      ssm: '202301022492 (1516415-A)', incorporatedOn: '2023-06-14',
      msic: '20210 — Manufacture of pesticides', paidUpCapital: null, companyAgeYears: 3,
      headcount: '<20 employees', headcountSource: 'Maukerja',
      primaryRevenueLine: 'Agrochemical manufacturing', customerSegment: 'Plantations and smallholders',
      people: [{ name: 'Tan Wei Ming', role: 'Director', source: 'About page', contact: '012-345 6789' }],
      clients: [{ name: 'Sime Darby', year: '2025', delivered: 'Bulk supply' }],
      buyingSignals: [{ signal: 'Hiring two agronomists', date: '2026-08-10', source: 'Maukerja' }],
      risks: ['Two different addresses published', 'Director also lists a dissolved company'],
      extraPhones: [], extraEmails: [], extraUrls: [],
      unknowns: ['Paid-up capital', 'Export markets'],
      confidence: 'medium',
    },
  },
  contactMatrix: {
    primaryPhone: '03-8724 1234', allPhones: ['03-8724 1234', '012-345 6789'],
    primaryEmail: 'sales@agriculfchemical.com', allEmails: ['sales@agriculfchemical.com'],
    whatsapp: null, website: 'https://agriculfchemical.com/',
    officialAddresses: ['Lot 6, Jalan Eco Majestic'],
    socialLinks: [{ platform: 'Facebook', url: 'https://facebook.com/agriculf' }],
    keyContacts: [{ name: 'Siti Aminah', role: 'Person-in-Charge', contact: '019-888 7777', source: 'Newpages Directory' }],
  },
  stageLog: [{ stage: 'domain-registry', status: 'ok', detail: 'agriculfchemical.com age=3y', ms: 1842 }],
} as unknown as CompanyDossier;

/* ---- the public profile: what must NOT be in it ---------------------------- */

test('the public profile carries none of our assessment of the company', () => {
  // This document is served from a public URL and answers the company's own
  // customers. Every string below is an internal judgement about them.
  const p = renderRagProfile(FULL, BIZ);
  for (const banned of [
    'Active Commercial Business',   // our verdict
    '61',                           // our legitimacy score
    'Two different addresses',       // risks — excluded on instruction
    'dissolved company',
    'Hiring two agronomists',        // our sales timing, not their information
    'Paid-up capital',               // what WE could not verify
    'Export markets',
    'domain-registry',               // our plumbing
    'not established',               // a research artefact; reads as an admission
    'Reduce unused JavaScript',      // their site is slow — a pitch, not a fact for customers
    '34/100',                        // performance score
    'Performance',
  ]) {
    assert.equal(p.includes(banned), false, `public profile must not contain "${banned}"`);
  }
});

test('the public profile keeps the things a customer would ask about', () => {
  const p = renderRagProfile(FULL, BIZ);
  assert.match(p, /^# Agriculf Sdn Bhd/m);
  assert.match(p, /Agrochemical manufacturing/);
  assert.match(p, /Plantations and smallholders/);
  assert.match(p, /202301022492/);
  assert.match(p, /2023-06-14/);
  assert.match(p, /03-8724 1234/);
  assert.match(p, /sales@agriculfchemical\.com/);
  assert.match(p, /Lot 6, Jalan Eco Majestic/);
  assert.match(p, /Sime Darby/);
  assert.match(p, /4\.6 out of 5 across 23 reviews/);
});

test('people appear by name and role, never with a scraped personal number', () => {
  // Names and roles are ordinary "About us" content. A mobile number lifted from a
  // directory is not something to republish on a public URL under their name.
  const p = renderRagProfile(FULL, BIZ);
  assert.match(p, /Tan Wei Ming/);
  assert.match(p, /Director/);
  assert.match(p, /Siti Aminah/);
  assert.equal(p.includes('012-345 6789'), false, 'a personal mobile must not reach the public document');
  assert.equal(p.includes('019-888 7777'), false);
});

test('research sources in socialLinks are never published on the company page', () => {
  // A live run put a CTOS credit report and a Maukerja job listing into socialLinks.
  // On the company's own customer-facing page that hands their customers a credit
  // file on them. Allow-list, so a source added later stays internal by default.
  const withSources = {
    ...FULL,
    contactMatrix: {
      ...FULL.contactMatrix,
      socialLinks: [
        { platform: 'Facebook', url: 'https://facebook.com/agriculf' },
        { platform: 'CTOS Credit Report', url: 'https://businessreport.ctoscredit.com.my/x' },
        { platform: 'Maukerja Profile', url: 'https://maukerja.my/x' },
        { platform: 'WhatsApp', url: 'https://wa.me/60112557139' },
      ],
    },
  } as unknown as CompanyDossier;

  const p = renderRagProfile(withSources, BIZ);
  assert.equal(p.includes('ctoscredit'), false, 'a credit report must never reach the public profile');
  assert.equal(p.includes('CTOS'), false);
  assert.equal(p.includes('maukerja'), false, 'a job-listing profile is a research source, not a company channel');
  assert.match(p, /facebook\.com\/agriculf/, 'genuine social profiles still publish');
  // WhatsApp has its own line; listing it twice is noise.
  assert.equal((p.match(/wa\.me/g) ?? []).length <= 1, true);

  // The internal document keeps them — that is where a credit report belongs.
  assert.match(renderFullDossier(withSources, BIZ), /Agriculf|agriculf/);
});

test('a placeholder role is not published as a job title', () => {
  const p = renderRagProfile({
    ...FULL,
    chatgpt: { ...FULL.chatgpt, facts: { ...FULL.chatgpt!.facts!, people: [{ name: 'Nur Hanani', role: 'Unstated', source: 'x', contact: null }] } },
  } as unknown as CompanyDossier, BIZ);
  assert.match(p, /Nur Hanani/);
  assert.equal(p.includes('Unstated'), false);
});

test('a dead domain is never offered to customers as a way to reach the company', () => {
  const dead = {
    ...FULL,
    domain: { domain: 'amwprotech.my', source: 'mynic-whois', registered: false },
    contactMatrix: { ...FULL.contactMatrix, website: 'https://amwprotech.my/' },
  } as unknown as CompanyDossier;
  const p = renderRagProfile(dead, undefined);
  assert.equal(p.includes('amwprotech.my'), false, 'an unregistered domain must not be published as their website');
  assert.equal(/dead|unregistered/i.test(p), false, 'nor should the finding itself appear in a customer-facing doc');
});

test('an expired registration is not published as "online since"', () => {
  const expired = { ...FULL, domain: { ...FULL.domain, expired: true } } as unknown as CompanyDossier;
  assert.equal(renderRagProfile(expired, BIZ).includes('Website online since'), false);
});

/* ---- the internal dossier: what MUST be in it ------------------------------ */

test('the internal dossier keeps everything the public profile drops', () => {
  const i = renderFullDossier(FULL, BIZ);
  assert.match(i, /Two different addresses/);
  assert.match(i, /Risks and red flags/);
  assert.match(i, /Active Commercial Business \(61\/100\)/);
  assert.match(i, /Hiring two agronomists/);
  assert.match(i, /Paid-up capital/);
  assert.match(i, /domain-registry/);
  assert.match(i, /012-345 6789/);
});

test('the internal dossier states the registrant caveat wherever it names one', () => {
  const withOwner = {
    ...FULL,
    domain: { domain: 'evocom.com.my', source: 'mynic-whois', registered: true, registrantOrganization: 'EVOLUTION COMMERCE SDN. BHD.' },
  } as unknown as CompanyDossier;
  const i = renderFullDossier(withOwner, BIZ);
  assert.match(i, /EVOLUTION COMMERCE SDN\. BHD\./);
  assert.match(i, /not verified against SSM/);
});

test('a redacted gTLD registrant says so rather than going blank', () => {
  assert.match(renderFullDossier(FULL, BIZ), /redacted by the registry/);
});

/* ---- mechanics ------------------------------------------------------------- */

test('markdown control characters in company data cannot break the document', () => {
  const nasty = {
    ...FULL,
    companyName: 'A|B *C* [D](e) `f`',
    contactMatrix: { ...FULL.contactMatrix, primaryPhone: '03|1234' },
  } as unknown as CompanyDossier;
  const p = renderRagProfile(nasty, undefined);
  // A raw pipe inside a bullet is harmless, but inside the people table it would
  // create a phantom column — escaping everywhere is the cheap, uniform fix.
  assert.match(p, /\\\|/);
  assert.equal(/\*C\*/.test(p.split('\n')[0].replace(/\\/g, '')) && !p.includes('\\*C\\*'), false);
});

test('the readme names each document so a retrieving AI knows which to read', () => {
  const r = renderGroupReadme(FULL, [
    { filename: 'company-profile.md', what: 'company profile' },
    { filename: 'internal-research-dossier.md', what: 'internal record' },
  ]);
  assert.match(r, /company-profile\.md/);
  assert.match(r, /Answer only from these documents/);
  assert.match(r, /2026-08-17/);
});

test('the group slug is URL-safe and stable', () => {
  assert.equal(groupSlug('Agriculf Sdn Bhd'), 'agriculf-sdn-bhd');
  assert.equal(groupSlug('KRCB Eco Majestic - Phone & Macbook!'), 'krcb-eco-majestic-phone-macbook');
  assert.equal(groupSlug('   '), 'company');
  assert.equal(/[^a-z0-9-]/.test(groupSlug('A|B *C*')), false);
});

test('a dossier with no research facts still produces a usable profile', () => {
  // ASIX TEAM in the live store is exactly this: a dossier that predates the
  // research stages. An empty document would be published under their name.
  const thin = {
    placeId: '0x1:0x2', companyName: 'ASIX TEAM', updatedAt: '2026-08-17T06:40:24.746Z',
    status: 'completed', executiveSummary: '', legitimacyScore: 30, verdict: 'Unverified Local Business',
    contactMatrix: { primaryPhone: '011-2233 4455', allPhones: ['011-2233 4455'], primaryEmail: null, allEmails: [], whatsapp: null, website: null, officialAddresses: [], socialLinks: [], keyContacts: [] },
  } as unknown as CompanyDossier;
  const p = renderRagProfile(thin, undefined);
  assert.match(p, /^# ASIX TEAM/m);
  assert.match(p, /011-2233 4455/);
  assert.equal(p.includes('Unverified'), false);
  assert.equal(p.includes('30'), false);
});
