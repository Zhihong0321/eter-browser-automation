import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildResearchPrompt, looksTruncated, parseFacts, parseFactsLines, parseFactsTail } from '../src/enrich/chatgptresearch.js';
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
  facebook: 'https://www.facebook.com/profile.php?id=100090883596928',
  instagram: 'https://www.instagram.com/clrenosdnbhd',
  whatsapp: null,
  linkedin: null,
} as unknown as BusinessRow;

const FACTS_BLOCK = `{
  "ssm": "202201046961 (1492658-K)",
  "incorporatedOn": "2022-12-23",
  "msic": null,
  "paidUpCapital": "UNKNOWN",
  "companyAgeYears": 3.65,
  "headcount": "<20 employees",
  "headcountSource": "Maukerja",
  "primaryRevenueLine": "Commercial renovation and fit-out",
  "customerSegment": "Shophouse owners, F&B, education",
  "people": [{"name": "Brayden Lee", "role": "Founder", "source": "About page", "contact": null}],
  "clients": [{"name": "AZ Preschool", "year": null, "delivered": "Three-month fit-out"}],
  "buyingSignals": [{"signal": "Interior Designer, up to RM4,000", "date": "2026-08-15", "source": "Maukerja"}],
  "risks": ["Two different addresses published"],
  "extraPhones": ["+60 11-3932 2861"],
  "extraEmails": [],
  "extraUrls": ["https://clreno.com.my/about/"],
  "unknowns": ["Paid-up capital", "Directors"],
  "confidence": "medium"
}`;

test('the schema block is found without any code fence', () => {
  // The answer is read from the rendered DOM's innerText, which strips ``` markers
  // and leaves the language label as a bare word. A fence-based parser scores zero
  // on the exact shape the live session actually returns.
  const brief = `### 8. WHAT I COULD NOT FIND\nDirectors, capital.\n\n### 9. JSON\nJSON\n${FACTS_BLOCK}`;
  const facts = parseFactsTail(brief);
  assert.ok(facts, 'an unfenced block must still parse');
  assert.equal(facts.ssm, '202201046961 (1492658-K)');
  assert.equal(facts.people[0].name, 'Brayden Lee');
});

test('a properly fenced block parses too', () => {
  const brief = `### 9. JSON\n\`\`\`json\n${FACTS_BLOCK}\n\`\`\`\n`;
  assert.equal(parseFactsTail(brief)?.confidence, 'medium');
});

test('UNKNOWN is a finding, not a value', () => {
  const facts = parseFactsTail(FACTS_BLOCK);
  assert.equal(facts?.paidUpCapital, null, '"UNKNOWN" must never reach the report as text');
  assert.equal(facts?.msic, null);
});

test('a brace inside a quoted value cannot unbalance the scan', () => {
  // Addresses and quoted job titles routinely carry braces and brackets. A naive
  // depth counter stops at the first inner brace and swallows the rest of the answer.
  const tricky = FACTS_BLOCK.replace(
    '"Two different addresses published"',
    '"Address reads {Lot 7-2} on one source and }6-2{ on another"',
  );
  const facts = parseFactsTail(`prose\n${tricky}`);
  assert.ok(facts, 'a braced string value must not break the scan');
  assert.equal(facts.risks.length, 1);
  assert.match(facts.risks[0], /Lot 7-2/);
});

test('the last schema-shaped object wins over an earlier example', () => {
  // The prompt itself contains a schema template, and the model sometimes echoes it
  // back before answering. Taking the first match returns the empty template.
  const echoed = '{"ssm": null, "people": [], "unknowns": []}';
  const facts = parseFactsTail(`Here is the shape I will use:\n${echoed}\n\nAnswer:\n${FACTS_BLOCK}`);
  assert.equal(facts?.ssm, '202201046961 (1492658-K)', 'the real answer must win over the echoed template');
});

test('prose with stray braces yields null rather than a bogus object', () => {
  assert.equal(parseFactsTail('No JSON here. Just a } stray brace and a { another one.'), null);
  assert.equal(parseFactsTail(''), null);
});

test('a coincidental object in prose is not mistaken for the schema', () => {
  assert.equal(parseFactsTail('The config was {"retries": 3, "timeout": 30}.'), null);
});

test('an odd number of quotes in the prose does not hide the schema block', () => {
  // The regression that matters most. These briefs quote source text constantly, so
  // the running quote count above the block is effectively arbitrary. A scanner that
  // tracks strings from the top of the document is INSIDE a string when the block
  // starts, skips every brace in it, and reports no JSON — on a block that is
  // complete and perfectly balanced. Measured on a live run, 2026-08-17.
  const oddQuotes = 'Nature of business is "OTHER SPECIALIZED CONSTRUCTION ACTIVITIES, N.E.C. and the registry lists "no. syarikat" too.\n\n';
  assert.equal((oddQuotes.match(/"/g) ?? []).length % 2, 1, 'fixture must actually have an odd quote count');
  const facts = parseFactsTail(oddQuotes + FACTS_BLOCK);
  assert.ok(facts, 'prose quotes must not desynchronize the scan');
  assert.equal(facts.ssm, '202201046961 (1492658-K)');
});

test('truncation detection also survives odd prose quotes', () => {
  const oddQuotes = 'The filing says "OTHER SPECIALIZED CONSTRUCTION, N.E.C. and nothing closes that quote.\n';
  assert.equal(looksTruncated(oddQuotes + FACTS_BLOCK), false, 'a complete block must not read as truncated');
  assert.equal(looksTruncated(`${oddQuotes}{"people": [{"name": "A"`), true);
});

test('missing arrays normalize to empty, never undefined', () => {
  // Downstream code maps over every array unguarded; an undefined here throws
  // inside the pipeline and loses a dossier that was otherwise complete.
  const facts = parseFactsTail('{"ssm":"123","unknowns":["x"]}');
  assert.ok(facts);
  assert.deepEqual(facts.people, []);
  assert.deepEqual(facts.buyingSignals, []);
  assert.deepEqual(facts.extraPhones, []);
  assert.equal(facts.confidence, null, 'an absent confidence must not default to high');
});

test('a person without a name is dropped, not kept as a blank row', () => {
  const facts = parseFactsTail('{"ssm":null,"people":[{"role":"Director","source":"x"},{"name":"Ana Lim","role":"PIC","source":"y"}],"unknowns":[]}');
  assert.equal(facts?.people.length, 1);
  assert.equal(facts?.people[0].name, 'Ana Lim');
});

test('an out-of-range confidence is rejected rather than trusted', () => {
  assert.equal(parseFactsTail('{"ssm":null,"unknowns":[],"confidence":"very high"}')?.confidence, null);
});

// Reproduces the shape of a real truncated run: measured 2026-08-17, the same
// prompt that returned a complete 19,761-char answer returned 15,981 chars on the
// next attempt, stopping inside the `people` array. The prose was fully usable both
// times; only the closing schema block was lost.
const TRUNCATED_TAIL = `### 9. JSON
JSON
{
  "ssm": "1492658K / 202201046961",
  "incorporatedOn": null,
  "headcount": "<20 employees",
  "people": [
    {
      "name": "Brayden Lee",
      "role": "Founder (self-reported)",
      "source": "CL Reno About page",
      "contact": "019-372 7149"
    },
    {
      "name": "Melissa Pang",
      "role": "Principal, AZ Nursery & Preschool`;

test('a run that stopped mid-structure is detected as truncated', () => {
  assert.equal(looksTruncated(TRUNCATED_TAIL), true);
  assert.equal(parseFactsTail(TRUNCATED_TAIL), null, 'an unbalanced tail must not yield half an object');
});

test('a complete answer is not flagged as truncated', () => {
  assert.equal(looksTruncated(`prose\n${FACTS_BLOCK}`), false);
  assert.equal(looksTruncated('prose with no braces at all'), false);
});

test('a brace inside a quoted value does not fake a truncation', () => {
  // Otherwise every brief mentioning a "{Lot 7-2}" address triggers a needless
  // second ask, doubling the slowest stage in the pipeline for nothing.
  assert.equal(looksTruncated('{"risks": ["address reads {Lot 7-2} here"]}'), false);
});

test('a stray closing brace in prose does not mask a real truncation', () => {
  assert.equal(looksTruncated('closing } brace in prose\n{"people": [{"name": "A"'), true);
});

const FACTS_LINES = `### 9. FACTS
SSM: 202201046961 (1492658-K)
INCORPORATED: 2022-12-23
MSIC: UNKNOWN
PAIDUP: UNKNOWN
AGEYEARS: 3.65
HEADCOUNT: <20 employees | Maukerja and Ricebowl
SELLS: Commercial renovation and fit-out
BUYERS: Shophouse owners, F&B, retail, education
PERSON: Brayden Lee | Founder | CL Reno About page | 019-372 7149
PERSON: Melissa Pang | Client, AZ Preschool | testimonial | -
CLIENT: AZ Preschool | 2024 | three-month child-safe fit-out
CLIENT: Your Physio, Sri Petaling | - | renovation
SIGNAL: Interior Designer hiring up to RM4,000 | 2026-08-17 | Maukerja
SIGNAL: Project Engineer RM2,800-3,300 | - | Ricebowl
RISK: Two different addresses published
RISK: Portfolio is self-reported
UNKNOWN: Paid-up capital
UNKNOWN: Directors
PHONE: +60 11-3932 2861
URL: https://clreno.com.my/about/
CONFIDENCE: medium`;

test('the line format parses every record type', () => {
  const f = parseFactsLines(FACTS_LINES);
  assert.ok(f);
  assert.equal(f.ssm, '202201046961 (1492658-K)');
  assert.equal(f.incorporatedOn, '2022-12-23');
  assert.equal(f.companyAgeYears, 3.65);
  assert.equal(f.headcount, '<20 employees');
  assert.equal(f.headcountSource, 'Maukerja and Ricebowl');
  assert.equal(f.people.length, 2);
  assert.equal(f.people[0].contact, '019-372 7149');
  assert.equal(f.people[1].contact, null, 'a "-" field must become null, not the literal hyphen');
  assert.equal(f.clients.length, 2);
  assert.equal(f.buyingSignals.length, 2);
  assert.equal(f.buyingSignals[0].date, '2026-08-17');
  assert.equal(f.risks.length, 2);
  assert.equal(f.unknowns.length, 2);
  assert.deepEqual(f.extraPhones, ['+60 11-3932 2861']);
  assert.equal(f.confidence, 'medium');
  assert.equal(f.msic, null, 'UNKNOWN must not reach the report as text');
});

test('a partial line read keeps every record that arrived', () => {
  // The whole reason for the line format. A mid-answer read loss costs only the
  // records it dropped, where a single JSON object would have yielded nothing at all.
  // Cut after the first PERSON record (line 0 is the heading).
  const clipped = FACTS_LINES.split('\n').slice(0, 10).join('\n');
  const f = parseFactsLines(clipped);
  assert.ok(f, 'a clipped tail must still yield facts');
  assert.equal(f.ssm, '202201046961 (1492658-K)');
  assert.equal(f.people.length, 1);
  assert.equal(f.people[0].name, 'Brayden Lee');
  assert.equal(f.clients.length, 0, 'records past the clip are simply absent');
  assert.equal(f.confidence, null);
});

test('a source volunteered on a single-value record is dropped, not kept in the value', () => {
  // Measured on a live run: the model appends a citation after a pipe on keys the spec
  // defines as single-value. Keeping it puts an unusable phone number in the contact
  // matrix and a citation trail inside a display field.
  const f = parseFactsLines(
    [
      'PHONE: +60 11-3932 2861 | CL Reno website',
      'EMAIL: hi@clreno.com.my | contact page',
      'URL: https://clreno.com.my/about/ | About',
      'SELLS: Interior design and shop-lot renovation | CL Reno website / Hiredly',
      'BUYERS: Commercial operators and residential clients | Hiredly / Ricebowl',
      'SSM: 202201046961 | CreditScan',
      'AGEYEARS: 3.65 | derived',
      'CONFIDENCE: medium | based on registry corroboration',
    ].join('\n'),
  );
  assert.ok(f);
  assert.deepEqual(f.extraPhones, ['+60 11-3932 2861']);
  assert.deepEqual(f.extraEmails, ['hi@clreno.com.my']);
  assert.deepEqual(f.extraUrls, ['https://clreno.com.my/about/']);
  assert.equal(f.primaryRevenueLine, 'Interior design and shop-lot renovation');
  assert.equal(f.customerSegment, 'Commercial operators and residential clients');
  assert.equal(f.ssm, '202201046961');
  assert.equal(f.companyAgeYears, 3.65);
  assert.equal(f.confidence, 'medium');
});

test('markdown decoration around a record does not lose it', () => {
  // The renderer bolds keys and adds bullets on its own schedule.
  const decorated = '- **PERSON:** Ana Lim | Director | SSM filing | 012-345 6789\n* **RISK:** Dormant socials\n**CONFIDENCE:** high';
  const f = parseFactsLines(decorated);
  assert.equal(f?.people.length, 1);
  assert.equal(f?.people[0].name, 'Ana Lim');
  assert.equal(f?.risks.length, 1);
  assert.equal(f?.confidence, 'high');
});

test('prose that merely contains a colon is not read as a record', () => {
  assert.equal(parseFactsLines('The company sells things: mostly renovation work.\nNote: nothing here.'), null);
});

test('parseFacts takes whichever reading recovered more', () => {
  // Both formats can arrive partially. Trusting the one we asked for loses data when
  // the model answered in the other and the asked-for one came back thin.
  // A thin line reading alongside a full JSON block: the JSON must win.
  const thinLines = 'SSM: 111\nPERSON: Placeholder Person | R | S | -';
  const merged = parseFacts(`${thinLines}\n\n${FACTS_BLOCK}`);
  assert.ok(merged);
  assert.equal(merged.people[0].name, 'Brayden Lee', 'the richer JSON reading must win here');
  assert.equal(merged.unknowns.length, 2);

  // And the reverse: a full line reading alongside a stub JSON block.
  const stubJson = '{"ssm": null, "people": [], "unknowns": []}';
  const other = parseFacts(`${stubJson}\n\n${FACTS_LINES}`);
  assert.equal(other?.people.length, 2, 'the richer line reading must win here');
  assert.equal(other?.buyingSignals.length, 2);

  const linesOnly = parseFacts(FACTS_LINES);
  assert.equal(linesOnly?.people.length, 2, 'with no JSON present the lines must be used');
});

test('the prompt asks for lines and explicitly forbids a fenced block', () => {
  const prompt = buildResearchPrompt(BIZ);
  assert.match(prompt, /PERSON: name \| role \| source \| contact/);
  assert.match(prompt, /SIGNAL: what they are spending on/);
  assert.match(prompt, /No JSON, no code fence/, 'a fenced block is what does not survive the read');
});

test('the prompt seeds every known identifier so the model cannot research the wrong company', () => {
  const prompt = buildResearchPrompt(BIZ);
  for (const needle of [
    'CL Reno Sdn Bhd',
    '7-2, 6, Jalan Bandar Rinching Seksyen 5',
    '2.9279574, 101.8577104',
    '019-372 7149',
    'https://clreno.com.my/',
    '4.8 from 19 reviews',
  ]) {
    assert.ok(prompt.includes(needle), `prompt must seed ${needle}`);
  }
});

test('the prompt keeps the three rules that produced the depth', () => {
  const prompt = buildResearchPrompt(BIZ);
  assert.match(prompt, /literal token UNKNOWN/, 'without this the gaps get filled with plausible filler');
  assert.match(prompt, /Every factual claim gets an inline source name/);
  assert.match(prompt, /CIDB/, 'the source checklist is what turns one search into a sweep');
  assert.match(prompt, /self-reported/, 'company claims must be separable from verified facts');
});

test('an empty field is omitted from the seed rather than sent as a blank label', () => {
  const sparse = { ...BIZ, phone: null, website: null, rating: null } as unknown as BusinessRow;
  const prompt = buildResearchPrompt(sparse);
  assert.ok(!/^Phone:/m.test(prompt), 'a blank "Phone:" line invites the model to invent one');
  assert.ok(!/^Website:/m.test(prompt));
  assert.ok(prompt.includes('CL Reno Sdn Bhd'), 'what is known must still be seeded');
});
