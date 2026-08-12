import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildContact } from '../src/fb-recon/index.js';

const AT = '2026-08-12T00:00:00.000Z';

test('builds a contact from a post with a vanity profile URL', () => {
  const c = buildContact({
    name: 'Ali Bin Abu',
    profileUrl: 'https://www.facebook.com/ali.bin.abu',
    text: 'Berapa harga solar? call me 012-345 6789',
    permalink: 'https://www.facebook.com/groups/x/posts/1',
    sourceKind: 'group',
    role: 'author',
    intent: 'buying',
    score: 9,
    at: AT,
  });
  assert.ok(c);
  assert.equal(c!.id, 'ali.bin.abu');
  assert.equal(c!.messenger, 'https://m.me/ali.bin.abu');
  assert.deepEqual(c!.phones, ['+60123456789']);
  assert.equal(c!.evidence.length, 1);
  assert.equal(c!.evidence[0].role, 'author');
});

test('returns null when the profile URL is not a person', () => {
  assert.equal(buildContact({
    name: 'Solar Malaysia', profileUrl: 'https://www.facebook.com/groups/123',
    text: 'hi', permalink: 'p', sourceKind: 'group', role: 'author',
    intent: 'buying', score: 9, at: AT,
  }), null);
});

test('returns null when there is no profile URL at all', () => {
  assert.equal(buildContact({
    name: 'Anon', profileUrl: null, text: 'hi', permalink: 'p',
    sourceKind: 'feed', role: 'author', intent: 'buying', score: 9, at: AT,
  }), null);
});

test('the evidence quote is trimmed but preserves the words that prove intent', () => {
  const long = 'x'.repeat(400) + ' berapa harga';
  const c = buildContact({
    name: 'A', profileUrl: 'https://www.facebook.com/aaa.bbb', text: long,
    permalink: 'p', sourceKind: 'group', role: 'commenter', intent: 'buying', score: 9, at: AT,
  });
  assert.ok(c!.evidence[0].quote.length <= 300, 'quote must be bounded');
});

test('firstSeen and lastSeen both start at the sighting time', () => {
  const c = buildContact({
    name: 'A', profileUrl: 'https://www.facebook.com/aaa.bbb', text: 'hi',
    permalink: 'p', sourceKind: 'feed', role: 'author', intent: 'none', score: 0, at: AT,
  });
  assert.equal(c!.firstSeen, AT);
  assert.equal(c!.lastSeen, AT);
});
