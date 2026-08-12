import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadContacts, saveContacts, mergeContact, toCsv, type FbContact, type ContactMap } from '../src/fb-recon/store.js';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fbrecon-store-')), 'contacts.json');
}

function contact(over: Partial<FbContact> = {}): FbContact {
  return {
    id: 'ali.bin.abu',
    name: 'Ali Bin Abu',
    profileUrl: 'https://www.facebook.com/ali.bin.abu',
    messenger: 'https://m.me/ali.bin.abu',
    phones: [],
    waLinks: [],
    emails: [],
    evidence: [],
    intent: 'researching',
    score: 3,
    firstSeen: '2026-08-12T00:00:00.000Z',
    lastSeen: '2026-08-12T00:00:00.000Z',
    ...over,
  };
}

test('mergeContact reports true for a new contact and false for a repeat', () => {
  const map: ContactMap = new Map();
  assert.equal(mergeContact(map, contact()), true);
  assert.equal(mergeContact(map, contact()), false);
  assert.equal(map.size, 1);
});

test('evidence from separate sightings accumulates on one contact', () => {
  const map: ContactMap = new Map();
  mergeContact(map, contact({ evidence: [{ permalink: 'p1', quote: 'how much?', sourceKind: 'group', role: 'author', at: 'a' }] }));
  mergeContact(map, contact({ evidence: [{ permalink: 'p2', quote: 'still looking', sourceKind: 'feed', role: 'commenter', at: 'b' }] }));
  assert.equal(map.get('ali.bin.abu')!.evidence.length, 2);
});

test('the same permalink and role is not recorded twice', () => {
  const map: ContactMap = new Map();
  const ev = { permalink: 'p1', quote: 'how much?', sourceKind: 'group' as const, role: 'author' as const, at: 'a' };
  mergeContact(map, contact({ evidence: [ev] }));
  mergeContact(map, contact({ evidence: [{ ...ev, quote: 'reworded but same post' }] }));
  assert.equal(map.get('ali.bin.abu')!.evidence.length, 1);
});

test('sightings with no permalink stay distinct instead of collapsing', () => {
  // Group posts expose no permalink at all (probe finding 4). Keying evidence on
  // permalink alone would make every sighting of one person look like a repeat,
  // quietly destroying the evidence trail this whole feature exists to build.
  const map: ContactMap = new Map();
  mergeContact(map, contact({ evidence: [{ permalink: '', quote: 'berapa harga?', sourceKind: 'group', role: 'author', at: 'a' }] }));
  mergeContact(map, contact({ evidence: [{ permalink: '', quote: 'still waiting for quote', sourceKind: 'group', role: 'author', at: 'b' }] }));
  assert.equal(map.get('ali.bin.abu')!.evidence.length, 2);
});

test('the same permalink-less quote is still deduped', () => {
  const map: ContactMap = new Map();
  const ev = { permalink: '', quote: 'berapa harga?', sourceKind: 'group' as const, role: 'author' as const, at: 'a' };
  mergeContact(map, contact({ evidence: [ev] }));
  mergeContact(map, contact({ evidence: [{ ...ev, at: 'b' }] }));
  assert.equal(map.get('ali.bin.abu')!.evidence.length, 1);
});

test('contact fields union across sightings', () => {
  const map: ContactMap = new Map();
  mergeContact(map, contact({ phones: ['+60123456789'] }));
  mergeContact(map, contact({ phones: ['+60123456789', '+60198888888'], emails: ['a@b.com'] }));
  const c = map.get('ali.bin.abu')!;
  assert.deepEqual(c.phones.sort(), ['+60123456789', '+60198888888']);
  assert.deepEqual(c.emails, ['a@b.com']);
});

test('intent only ever upgrades, never downgrades', () => {
  const map: ContactMap = new Map();
  mergeContact(map, contact({ intent: 'buying' }));
  mergeContact(map, contact({ intent: 'none' }));
  assert.equal(map.get('ali.bin.abu')!.intent, 'buying');
});

test('score keeps the maximum and lastSeen advances', () => {
  const map: ContactMap = new Map();
  mergeContact(map, contact({ score: 3, lastSeen: '2026-08-12T00:00:00.000Z' }));
  mergeContact(map, contact({ score: 9, lastSeen: '2026-08-13T00:00:00.000Z' }));
  const c = map.get('ali.bin.abu')!;
  assert.equal(c.score, 9);
  assert.equal(c.lastSeen, '2026-08-13T00:00:00.000Z');
  assert.equal(c.firstSeen, '2026-08-12T00:00:00.000Z');
});

test('a missing messenger link is filled in by a later sighting', () => {
  const map: ContactMap = new Map();
  mergeContact(map, contact({ messenger: null }));
  mergeContact(map, contact({ messenger: 'https://m.me/ali.bin.abu' }));
  assert.equal(map.get('ali.bin.abu')!.messenger, 'https://m.me/ali.bin.abu');
});

test('save then load round-trips the map', () => {
  const file = tmpFile();
  const map: ContactMap = new Map();
  mergeContact(map, contact({ phones: ['+60123456789'] }));
  saveContacts(file, map);
  const back = loadContacts(file);
  assert.equal(back.size, 1);
  assert.deepEqual(back.get('ali.bin.abu')!.phones, ['+60123456789']);
});

test('loading a missing file yields an empty map instead of throwing', () => {
  assert.equal(loadContacts(tmpFile()).size, 0);
});

test('csv quotes fields containing commas, quotes and newlines', () => {
  const map: ContactMap = new Map();
  mergeContact(map, contact({
    name: 'Ali, "The Boss"',
    evidence: [{ permalink: 'p1', quote: 'line one\nline two', sourceKind: 'group', role: 'author', at: 'a' }],
  }));
  const csv = toCsv(map);
  const [header, row] = csv.split('\n');
  assert.ok(header.startsWith('id,name,'));
  assert.ok(row.includes('"Ali, ""The Boss"""'), `bad quoting: ${row}`);
  assert.equal(csv.split('\n').length, 2, 'an embedded newline must not create a new CSV row');
});
