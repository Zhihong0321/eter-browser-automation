import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseSource, sourceUrl, isSweepable } from '../src/fb-recon/sources.js';

test('parses a group source', () => {
  assert.deepEqual(parseSource('group:https://www.facebook.com/groups/solarmy'),
    { kind: 'group', ref: 'https://www.facebook.com/groups/solarmy' });
});

test('parses the bare feed and search shorthands', () => {
  assert.deepEqual(parseSource('feed'), { kind: 'feed', ref: '' });
  assert.deepEqual(parseSource('search'), { kind: 'search', ref: '' });
});

test('parses a thread source', () => {
  assert.deepEqual(parseSource('thread:https://www.facebook.com/permalink.php?story_fbid=1&id=2'),
    { kind: 'thread', ref: 'https://www.facebook.com/permalink.php?story_fbid=1&id=2' });
});

test('rejects an unknown source kind', () => {
  assert.throws(() => parseSource('twitter:foo'), /unknown source/i);
});

test('rejects a group source with no URL', () => {
  assert.throws(() => parseSource('group:'), /requires a url/i);
});

test('rejects a non-facebook URL', () => {
  assert.throws(() => parseSource('group:https://evil.example.com/groups/x'), /facebook\.com/i);
});

test('search URL encodes the topic', () => {
  assert.equal(sourceUrl({ kind: 'search', ref: '' }, 'solar panel'),
    'https://www.facebook.com/search/posts?q=solar%20panel');
});

test('an explicit search ref overrides the topic as the query', () => {
  assert.equal(sourceUrl({ kind: 'search', ref: 'nem tnb' }, 'solar'),
    'https://www.facebook.com/search/posts?q=nem%20tnb');
});

test('group URL is used as given', () => {
  assert.equal(sourceUrl({ kind: 'group', ref: 'https://www.facebook.com/groups/solarmy' }, 'solar'),
    'https://www.facebook.com/groups/solarmy');
});

test('feed URL is the site root', () => {
  assert.equal(sourceUrl({ kind: 'feed', ref: '' }, 'solar'), 'https://www.facebook.com/');
});

test('threads are not sweepable; every other kind is', () => {
  assert.equal(isSweepable({ kind: 'thread', ref: 'https://www.facebook.com/x' }), false);
  assert.equal(isSweepable({ kind: 'group', ref: 'https://www.facebook.com/groups/x' }), true);
  assert.equal(isSweepable({ kind: 'search', ref: '' }), true);
  assert.equal(isSweepable({ kind: 'feed', ref: '' }), true);
});
