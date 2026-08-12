import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { extractContactFields, profileIdentity, messengerLink } from '../src/fb-recon/contact.js';

test('extracts a Malaysian mobile in local format and normalises to +60', () => {
  const f = extractContactFields('Interested! My number 012-345 6789 thanks');
  assert.deepEqual(f.phones, ['+60123456789']);
});

test('extracts an international-format Malaysian mobile', () => {
  assert.deepEqual(extractContactFields('call +60 19 8765432').phones, ['+60198765432']);
});

test('the same number written two ways yields one entry', () => {
  const f = extractContactFields('0123456789 or +60123456789 or 012-345-6789');
  assert.deepEqual(f.phones, ['+60123456789']);
});

test('does not mistake a long digit run for a phone number', () => {
  assert.deepEqual(extractContactFields('order id 900123456789012345').phones, []);
});

test('extracts a wa.me link and normalises the number', () => {
  const f = extractContactFields('whatsapp me https://wa.me/60123456789 anytime');
  assert.deepEqual(f.waLinks, ['+60123456789']);
});

test('extracts an api.whatsapp.com send link', () => {
  const f = extractContactFields('https://api.whatsapp.com/send?phone=60129998888&text=hi');
  assert.deepEqual(f.waLinks, ['+60129998888']);
});

test('extracts an email and lowercases it', () => {
  assert.deepEqual(extractContactFields('mail me at Ali.Bin@Example.COM').emails, ['ali.bin@example.com']);
});

test('empty text yields empty arrays, never undefined', () => {
  const f = extractContactFields('');
  assert.deepEqual(f, { phones: [], waLinks: [], emails: [] });
});

test('identifies a vanity profile URL', () => {
  const id = profileIdentity('https://www.facebook.com/ali.bin.abu');
  assert.deepEqual(id, { id: 'ali.bin.abu', handle: 'ali.bin.abu', kind: 'handle' });
});

test('identifies a numeric profile URL', () => {
  const id = profileIdentity('https://www.facebook.com/profile.php?id=100001234567890');
  assert.deepEqual(id, { id: '100001234567890', handle: null, kind: 'numeric' });
});

test('identifies a group-scoped member URL', () => {
  // The ONLY form group posts expose. Measured 2026-08-12: 14 of 14 real leads
  // used this shape and every one was discarded before this clause existed.
  const id = profileIdentity('https://www.facebook.com/groups/704069361620565/user/100001517402536/');
  assert.deepEqual(id, { id: '100001517402536', handle: null, kind: 'group-scoped' });
});

test('two sightings of one person in different groups are the same contact', () => {
  const a = profileIdentity('https://www.facebook.com/groups/111/user/100001517402536/');
  const b = profileIdentity('https://www.facebook.com/groups/222/user/100001517402536/');
  assert.equal(a?.id, b?.id, 'identity must be the person, not the group they were seen in');
});

test('a group landing page is still not a person', () => {
  assert.equal(profileIdentity('https://www.facebook.com/groups/704069361620565'), null);
  assert.equal(profileIdentity('https://www.facebook.com/groups/704069361620565/user/'), null);
});

test('a control anchor is not a person', () => {
  // "Hide post by <name>" renders as a[aria-label] with href="#".
  assert.equal(profileIdentity('https://www.facebook.com/#'), null);
});

test('a story URL is not a person', () => {
  assert.equal(profileIdentity('https://www.facebook.com/stories/122096234379287376/UzpfSVND'), null);
});

test('strips Facebook click-tracking params before identifying', () => {
  const id = profileIdentity('https://www.facebook.com/ali.bin.abu/?__cft__[0]=abc&__tn__=R');
  assert.equal(id?.id, 'ali.bin.abu');
});

test('rejects non-profile facebook paths', () => {
  for (const url of [
    'https://www.facebook.com/groups/123456',
    'https://www.facebook.com/permalink.php?story_fbid=1&id=2',
    'https://www.facebook.com/watch/?v=99',
    'https://www.facebook.com/marketplace/item/55',
    'https://www.facebook.com/hashtag/solar',
    'https://www.facebook.com/photo/?fbid=1',
  ]) {
    assert.equal(profileIdentity(url), null, `should reject ${url}`);
  }
});

test('rejects a non-facebook host and null input', () => {
  assert.equal(profileIdentity('https://example.com/ali'), null);
  assert.equal(profileIdentity(null), null);
});

test('builds an m.me link from either identity kind', () => {
  assert.equal(messengerLink({ id: 'ali.bin.abu', handle: 'ali.bin.abu', kind: 'handle' }), 'https://m.me/ali.bin.abu');
  assert.equal(messengerLink({ id: '100001234567890', handle: null, kind: 'numeric' }), 'https://m.me/100001234567890');
});
