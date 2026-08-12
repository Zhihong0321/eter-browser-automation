import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLedger, saveLedger, recordProject, priorProjects } from '../src/fb-recon/ledger.js';
import type { FbContact } from '../src/fb-recon/store.js';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fbrecon-ledger-')), 'ledger.json');
}

function contact(id: string, name = 'Ali Bin Abu'): FbContact {
  return {
    id,
    name,
    profileUrl: `https://www.facebook.com/${id}`,
    messenger: `https://m.me/${id}`,
    phones: [],
    waLinks: [],
    emails: [],
    evidence: [],
    intent: 'buying',
    score: 9,
    firstSeen: '2026-08-12T00:00:00.000Z',
    lastSeen: '2026-08-12T00:00:00.000Z',
  };
}

test('a person harvested by one project has no prior projects in that project', () => {
  const led = loadLedger(tmpFile());
  recordProject(led, 'p1', [contact('a')]);
  assert.deepEqual(priorProjects(led, 'a', 'p1'), [], 'a project must never cite itself');
});

test('a person harvested twice is flagged with the earlier project', () => {
  const led = loadLedger(tmpFile());
  recordProject(led, 'p1', [contact('a')]);
  recordProject(led, 'p2', [contact('a')]);
  assert.deepEqual(priorProjects(led, 'a', 'p2'), ['p1']);
});

test('recording the same project twice does not duplicate it', () => {
  const led = loadLedger(tmpFile());
  recordProject(led, 'p1', [contact('a')]);
  recordProject(led, 'p1', [contact('a')]);
  assert.deepEqual(led.get('a')!.projects, ['p1']);
});

test('an unknown person has no prior projects', () => {
  assert.deepEqual(priorProjects(loadLedger(tmpFile()), 'nobody', 'p1'), []);
});

test('a later run supplies a better name than a user-id placeholder', () => {
  const led = loadLedger(tmpFile());
  recordProject(led, 'p1', [contact('100001', '100001')]);
  recordProject(led, 'p2', [contact('100001', 'Ashley Koek')]);
  assert.equal(led.get('100001')!.name, 'Ashley Koek');
});

test('the ledger round-trips through disk', () => {
  const file = tmpFile();
  const led = loadLedger(file);
  recordProject(led, 'p1', [contact('a'), contact('b')]);
  saveLedger(file, led);

  const back = loadLedger(file);
  assert.equal(back.size, 2);
  assert.deepEqual(back.get('a')!.projects, ['p1']);
});

test('a corrupt ledger starts empty rather than failing the run', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'not json');
  assert.equal(loadLedger(file).size, 0);
});

test('the ledger stores no evidence, quotes or phone numbers', () => {
  const file = tmpFile();
  const led = loadLedger(file);
  const c = contact('a');
  c.phones = ['+60123456789'];
  c.evidence = [{ permalink: 'p', quote: 'berapa harga?', sourceKind: 'group', role: 'author', at: 'a' }];
  recordProject(led, 'p1', [c]);
  saveLedger(file, led);

  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('+60123456789'), 'phone numbers must stay in the project that harvested them');
  assert.ok(!raw.includes('berapa harga'), 'quotes must stay in the project that harvested them');
});
