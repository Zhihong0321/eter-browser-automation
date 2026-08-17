import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  describeDomain,
  isDeadDomain,
  isPlatformDomain,
  parseMynicWhois,
  parseRdap,
  registrableDomain,
  tldOf,
} from '../src/enrich/domain.js';

/** Frozen so the age assertions do not drift with the calendar. */
const NOW = Date.parse('2026-08-17T12:00:00Z');

/* ---- name parsing --------------------------------------------------------- */

test('a URL is reduced to the name a registry can be asked about', () => {
  assert.equal(registrableDomain('https://clreno.com.my/about?x=1'), 'clreno.com.my');
  assert.equal(registrableDomain('http://www.fuzhingdesign.com/'), 'fuzhingdesign.com');
  assert.equal(registrableDomain('bakingguru.my'), 'bakingguru.my');
});

test('a three-label Malaysian suffix keeps three labels, a two-label one keeps two', () => {
  // The whole point: com.my is a registry suffix, so healthlane.com.my is the name.
  // Treating it as a plain eTLD+1 would query "com.my" and return the registry itself.
  assert.equal(registrableDomain('https://estore.healthlane.com.my/shop'), 'healthlane.com.my');
  assert.equal(registrableDomain('https://shop.collectco.my'), 'collectco.my');
});

test('things that are not lookup-able names are rejected rather than guessed at', () => {
  assert.equal(registrableDomain('http://127.0.0.1:8080/'), null);
  assert.equal(registrableDomain('localhost'), null);
  assert.equal(registrableDomain(''), null);
  assert.equal(registrableDomain('not a url at all'), null);
});

test('platform pages are recognised so Meta is never reported as the registrant', () => {
  // A Malaysian SME routinely lists its Facebook page as its website. Looking that
  // up would put "Meta Platforms" in the dossier under the company's own name.
  assert.ok(isPlatformDomain(registrableDomain('https://www.facebook.com/someshop')!));
  assert.ok(isPlatformDomain(registrableDomain('https://linktr.ee/someshop')!));
  assert.ok(!isPlatformDomain('clreno.com.my'));
});

test('the TLD drives which registry path is taken', () => {
  assert.equal(tldOf('healthlane.com.my'), 'my');
  assert.equal(tldOf('asixteam.com'), 'com');
});

/* ---- MYNIC WHOIS ---------------------------------------------------------- */

// Trimmed from the real whois.mynic.my response for evocom.com.my.
const MYNIC_COM_MY = `Domain Name: evocom.com.my
Registry Domain ID: D1A012345-MYNIC
Registrar WHOIS Server: whois.mynic.my
Updated Date: 2026-01-04T02:11:09.000Z
Creation Date: 2019-01-09T16:00:00.000Z
Registry Expiry Date: 2027-01-09T16:00:00.000Z
Registrar: Exabytes Network Sdn Bhd
Registry Registrant ID: REDACTED FOR PRIVACY
Registrant Name: REDACTED FOR PRIVACY
Registrant Organization: EVOLUTION COMMERCE SDN. BHD.
Registrant Street: REDACTED FOR PRIVACY
Registrant State/Province: Selangor
Registrant Postal Code: REDACTED FOR PRIVACY
Registrant Country: MY
Registrant Phone: REDACTED FOR PRIVACY
Registrant Email: Please query the RDDS service of the Registrar of Record identified in this output.
Domain Status: clientTransferProhibited https://icann.org/epp#clientTransferProhibited
Name Server: NS1.EXABYTES.COM
Name Server: NS2.EXABYTES.COM
`;

test('a .com.my yields the registrant organisation — the field this stage exists for', () => {
  const d = parseMynicWhois('evocom.com.my', MYNIC_COM_MY, NOW);
  assert.equal(d.registered, true);
  assert.equal(d.registrantOrganization, 'EVOLUTION COMMERCE SDN. BHD.');
  assert.equal(d.registrantState, 'Selangor');
  assert.equal(d.registrar, 'Exabytes Network Sdn Bhd');
  assert.equal(d.createdAt?.slice(0, 10), '2019-01-09');
  assert.deepEqual(d.nameservers, ['ns1.exabytes.com', 'ns2.exabytes.com']);
  assert.deepEqual(d.statuses, ['clientTransferProhibited']);
});

test('every REDACTED FOR PRIVACY field is dropped rather than carried as a value', () => {
  const d = parseMynicWhois('evocom.com.my', MYNIC_COM_MY, NOW);
  // "REDACTED FOR PRIVACY" landing in a dossier field reads as a real finding.
  assert.equal(JSON.stringify(d).includes('REDACTED'), false);
  assert.equal(JSON.stringify(d).includes('Please query'), false);
});

test('domain age is computed from the creation date', () => {
  const d = parseMynicWhois('evocom.com.my', MYNIC_COM_MY, NOW);
  assert.equal(d.ageYears, 7.6);
  assert.equal(d.expired, false);
});

test('a plain .my leaves the organisation empty, and that is a finding not a gap', () => {
  // MYNIC emits a bare "Registrant Organization:" for a .my held by an individual.
  // The parser must not fall through to the next line's value.
  const text = MYNIC_COM_MY.replace(
    'Registrant Organization: EVOLUTION COMMERCE SDN. BHD.',
    'Registrant Organization:',
  );
  const d = parseMynicWhois('bakingguru.my', text, NOW);
  assert.equal(d.registered, true);
  assert.equal(d.registrantOrganization, undefined);
  assert.equal(d.registrantState, 'Selangor', 'later fields must still parse');
});

test('an unregistered name is reported as dead, not as an empty record', () => {
  const text = '>>> Domain amwprotech.my is available for registration\n\n>>> Last update of WHOIS database: 2026-08-17T11:02:33.847Z <<<';
  const d = parseMynicWhois('amwprotech.my', text, NOW);
  assert.equal(d.registered, false);
  assert.ok(isDeadDomain(d));
  assert.equal(describeDomain(d).detail.includes('NOT REGISTERED'), true);
});

test('an expired registration is flagged even though the name is still registered', () => {
  const text = MYNIC_COM_MY.replace('Registry Expiry Date: 2027-01-09', 'Registry Expiry Date: 2025-01-09');
  const d = parseMynicWhois('evocom.com.my', text, NOW);
  assert.equal(d.registered, true);
  assert.equal(d.expired, true);
});

/* ---- RDAP ----------------------------------------------------------------- */

// Trimmed from the real rdap.verisign.com response for a .com.
const RDAP_COM = {
  status: ['client transfer prohibited'],
  entities: [
    {
      roles: ['registrar'],
      vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'NameCheap, Inc.']]],
    },
  ],
  events: [
    { eventAction: 'registration', eventDate: '2023-07-17T14:47:33Z' },
    { eventAction: 'expiration', eventDate: '2027-07-17T14:47:33Z' },
    { eventAction: 'last changed', eventDate: '2026-07-19T12:29:42Z' },
  ],
  nameservers: [{ ldhName: 'DNS1.REGISTRAR-SERVERS.COM' }, { ldhName: 'DNS2.REGISTRAR-SERVERS.COM' }],
};

test('a gTLD yields dates and registrar, and says outright that the owner is redacted', () => {
  const d = parseRdap('eternalgy.com', RDAP_COM as never, NOW);
  assert.equal(d.registered, true);
  assert.equal(d.registrar, 'NameCheap, Inc.');
  assert.equal(d.createdAt?.slice(0, 10), '2023-07-17');
  assert.equal(d.ageYears, 3.1);
  // The distinction the whole dossier rests on: absent because policy forbids it,
  // not absent because nobody looked.
  assert.equal(d.registrantOrganization, undefined);
  assert.match(d.note ?? '', /redacted/i);
});

test('a registry that does publish a registrant has it read out of the jCard', () => {
  const withOwner = {
    ...RDAP_COM,
    entities: [
      ...RDAP_COM.entities,
      {
        roles: ['registrant'],
        vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Acme Holdings Sdn Bhd']]],
      },
    ],
  };
  const d = parseRdap('acme.com', withOwner as never, NOW);
  assert.equal(d.registrantOrganization, 'Acme Holdings Sdn Bhd');
  assert.equal(d.note, undefined);
});

/* ---- the not-checked / not-there distinction ------------------------------ */

test('a platform page and an unsupported TLD are never mistaken for a dead domain', () => {
  // `!registered` would call both of these dead and invent a red flag out of a
  // stage that never ran, which is the exact failure the stage log exists to stop.
  assert.equal(isDeadDomain({ domain: 'facebook.com', source: 'platform' }), false);
  assert.equal(isDeadDomain({ domain: 'shp.ee', source: 'unsupported' }), false);
  assert.equal(isDeadDomain(undefined), false);
  assert.equal(isDeadDomain({ domain: 'x.com', source: 'rdap', registered: false }), true);
});

test('the stage log distinguishes skipped from looked-and-found-nothing', () => {
  assert.equal(describeDomain({ domain: 'facebook.com', source: 'platform', note: 'fb page' }).status, 'skipped');
  assert.equal(describeDomain({ domain: 'shp.ee', source: 'unsupported', note: 'no RDAP' }).status, 'skipped');
  assert.equal(describeDomain(parseMynicWhois('evocom.com.my', MYNIC_COM_MY, NOW)).status, 'ok');
});

test('the stage log names the redaction rather than printing an empty owner', () => {
  const line = describeDomain(parseRdap('eternalgy.com', RDAP_COM as never, NOW)).detail;
  assert.match(line, /owner=REDACTED \(gTLD\)/);
  assert.match(describeDomain(parseMynicWhois('evocom.com.my', MYNIC_COM_MY, NOW)).detail,
    /owner=EVOLUTION COMMERCE SDN\. BHD\./);
});
