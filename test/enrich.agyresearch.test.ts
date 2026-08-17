import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildSecondPassPrompt, mergeFacts } from '../src/enrich/agyresearch.js';
import type { ChatGptFacts, ChatGptIntel } from '../src/enrich/types.js';
import type { BusinessRow } from '../src/leads.js';

const BIZ = {
  placeId: '0x31cdcd8c2624ef75:0x32da1de854f181fb',
  name: 'CL Reno Sdn Bhd',
  address: '7-2, 6, Jalan Bandar Rinching Seksyen 5',
  lat: 2.9279574,
  lng: 101.8577104,
  phone: '019-372 7149',
  website: 'https://clreno.com.my/',
  category: 'Interior designer',
  rating: 4.8,
  reviews: 19,
  hours: null,
  mapsUrl: 'https://maps.google.com/?cid=1',
  email: 'clrenosdnbhd@gmail.com',
  emails: null,
  facebook: null,
  instagram: null,
  whatsapp: null,
  linkedin: null,
} as unknown as BusinessRow;

const emptyFacts = (): ChatGptFacts => ({
  ssm: null,
  incorporatedOn: null,
  msic: null,
  paidUpCapital: null,
  companyAgeYears: null,
  headcount: null,
  headcountSource: null,
  primaryRevenueLine: null,
  customerSegment: null,
  people: [],
  clients: [],
  buyingSignals: [],
  risks: [],
  extraPhones: [],
  extraEmails: [],
  extraUrls: [],
  unknowns: [],
  confidence: null,
});

test('mergeFacts never lets the second pass overwrite a scalar the first pass already had', () => {
  const base: ChatGptFacts = { ...emptyFacts(), ssm: '202201046961 (1492658-K)', confidence: 'high' };
  const extra: ChatGptFacts = { ...emptyFacts(), ssm: 'SOMETHING ELSE AGY THINKS IT FOUND', confidence: 'low' };
  const merged = mergeFacts(base, extra);
  assert.equal(merged?.ssm, '202201046961 (1492658-K)');
  assert.equal(merged?.confidence, 'high');
});

test('mergeFacts fills a scalar the first pass left null', () => {
  const base: ChatGptFacts = { ...emptyFacts(), msic: null };
  const extra: ChatGptFacts = { ...emptyFacts(), msic: '43301 Painting activities' };
  const merged = mergeFacts(base, extra);
  assert.equal(merged?.msic, '43301 Painting activities');
});

test('mergeFacts unions people/clients/signals rather than one side replacing the other', () => {
  const base: ChatGptFacts = {
    ...emptyFacts(),
    people: [{ name: 'Brayden Lee', role: 'Founder', source: 'About page', contact: null }],
    clients: [{ name: 'AZ Preschool', year: null, delivered: 'Fit-out' }],
    buyingSignals: [{ signal: 'Hiring a site supervisor', date: '2026-08-01', source: 'Maukerja' }],
  };
  const extra: ChatGptFacts = {
    ...emptyFacts(),
    people: [{ name: 'Siti Rahman', role: 'Ops Manager', source: 'LinkedIn', contact: null }],
    clients: [{ name: 'AZ Preschool', year: '2024', delivered: 'duplicate, should not double up' }],
    buyingSignals: [{ signal: 'New showroom opening', date: '2026-08-10', source: 'News' }],
  };
  const merged = mergeFacts(base, extra);
  assert.equal(merged?.people.length, 2, 'both people must survive');
  assert.ok(merged?.people.some((p) => p.name === 'Brayden Lee'));
  assert.ok(merged?.people.some((p) => p.name === 'Siti Rahman'));
  assert.equal(merged?.clients.length, 1, 'same client name must not duplicate');
  assert.equal(merged?.clients[0].delivered, 'Fit-out', 'the first pass\'s own record for a name it already had is kept, not overwritten');
  assert.equal(merged?.buyingSignals.length, 2);
});

test('mergeFacts unions unknowns instead of trusting the second pass to have re-listed every one', () => {
  // This is the exact failure mode the merge must never allow: if agy's own
  // UNKNOWN records simply forgot to re-state a gap it also could not close,
  // superseding the first pass's list would make a still-real gap vanish.
  const base: ChatGptFacts = { ...emptyFacts(), unknowns: ['Paid-up capital', 'Directors'] };
  const extra: ChatGptFacts = { ...emptyFacts(), unknowns: ['MSIC code'] };
  const merged = mergeFacts(base, extra);
  assert.deepEqual(
    [...merged!.unknowns].sort(),
    ['Directors', 'MSIC code', 'Paid-up capital'].sort(),
  );
});

test('mergeFacts with a null second pass returns the first pass untouched', () => {
  const base: ChatGptFacts = { ...emptyFacts(), ssm: 'X', people: [{ name: 'A', role: 'Founder', source: 's', contact: null }] };
  assert.deepEqual(mergeFacts(base, null), base);
});

test('mergeFacts with no first pass falls back to the second pass wholesale', () => {
  const extra: ChatGptFacts = { ...emptyFacts(), ssm: 'X' };
  assert.deepEqual(mergeFacts(null, extra), extra);
});

test('the second-pass prompt points agy at the baseline file rather than pasting the brief inline', () => {
  const baseline: ChatGptIntel = {
    ok: true,
    ms: 1000,
    brief: 'A'.repeat(20_000),
    facts: { ...emptyFacts(), unknowns: ['Paid-up capital'], risks: ['Two addresses published'] },
  };
  const prompt = buildSecondPassPrompt(BIZ, undefined, baseline, 'C:/vault/research/place/01-chatgpt-baseline.txt');
  assert.ok(prompt.includes('01-chatgpt-baseline.txt'), 'the prompt must reference the file, not embed the brief');
  assert.ok(!prompt.includes('A'.repeat(20_000)), 'the 20KB brief text itself must never be pasted into the prompt argument');
  assert.ok(prompt.includes('Paid-up capital'));
  assert.ok(prompt.includes('Two addresses published'));
});
