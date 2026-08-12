import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectRun, listProjects, newProjectId, reapStaleProjects, type ProjectContact } from '../src/fb-recon/project.js';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fbrecon-proj-'));
}

function contact(over: Partial<ProjectContact> = {}): ProjectContact {
  return {
    id: 'ali.bin.abu',
    name: 'Ali Bin Abu',
    profileUrl: 'https://www.facebook.com/ali.bin.abu',
    messenger: 'https://m.me/ali.bin.abu',
    phones: [],
    waLinks: [],
    emails: [],
    evidence: [{ permalink: 'p1', quote: 'berapa harga?', sourceKind: 'group', role: 'author', at: 'a' }],
    intent: 'buying',
    score: 9,
    firstSeen: '2026-08-12T00:00:00.000Z',
    lastSeen: '2026-08-12T00:00:00.000Z',
    priorProjects: [],
    ...over,
  };
}

test('a project id sorts chronologically and carries the topic', () => {
  const id = newProjectId('e-invoice', new Date('2026-08-12T14:30:00'));
  assert.match(id, /^20260812-1430-e-invoice-[0-9a-f]{4}$/);
});

test('two projects started in the same minute do not collide', () => {
  const at = new Date('2026-08-12T14:30:00');
  const ids = new Set(Array.from({ length: 50 }, () => newProjectId('solar', at)));
  assert.ok(ids.size > 45, `ids collided too often: ${ids.size}/50 unique`);
});

test('a topic that looks like a path cannot escape the projects directory', () => {
  const id = newProjectId('../../etc/passwd');
  assert.ok(!id.includes('..'), `traversal leaked into the id: ${id}`);
  assert.ok(!id.includes('/') && !id.includes('\\'), `separator leaked into the id: ${id}`);
});

test('the project file and report exist as soon as the run starts', () => {
  const root = tmpRoot();
  const p = new ProjectRun(root, { topic: 'solar', sources: ['feed'] });
  assert.ok(fs.existsSync(p.jsonPath), 'project.json must exist before any result');
  assert.ok(fs.existsSync(p.htmlPath), 'report.html must exist before any result');
  assert.equal(p.snapshot.status, 'running');
});

test('progress written mid-run is readable from disk before the run ends', () => {
  const root = tmpRoot();
  const p = new ProjectRun(root, { topic: 'solar', sources: ['feed'] });
  p.progress({ scanned: 12 });
  p.event('sweep', 'group:x — opening');

  const onDisk = JSON.parse(fs.readFileSync(p.jsonPath, 'utf8'));
  assert.equal(onDisk.status, 'running');
  assert.equal(onDisk.counters.scanned, 12);
  assert.ok(onDisk.events.some((e: { detail: string }) => e.detail.includes('opening')));
});

test('setContacts splits new people from people seen in earlier projects', () => {
  const root = tmpRoot();
  const p = new ProjectRun(root, { topic: 'solar', sources: ['feed'] });
  p.setContacts([
    contact({ id: 'a', priorProjects: [] }),
    contact({ id: 'b', priorProjects: ['20260101-0900-solar-aaaa'] }),
    contact({ id: 'c', priorProjects: [] }),
  ]);
  const c = p.snapshot.counters;
  assert.equal(c.totalContacts, 3);
  assert.equal(c.newContacts, 2);
  assert.equal(c.knownContacts, 1);
});

test('a failed run still leaves a readable project that says why', () => {
  const root = tmpRoot();
  const p = new ProjectRun(root, { topic: 'solar', sources: ['feed'] });
  p.fail(new Error('browser vanished'));

  const onDisk = JSON.parse(fs.readFileSync(p.jsonPath, 'utf8'));
  assert.equal(onDisk.status, 'failed');
  assert.equal(onDisk.error, 'browser vanished');
  assert.ok(onDisk.finishedAt, 'a failed run must still be stamped finished');
});

test('a second run of the same topic is a separate project, not a mutation', () => {
  const root = tmpRoot();
  const a = new ProjectRun(root, { topic: 'solar', sources: ['feed'] });
  a.setContacts([contact({ id: 'a' })]);
  a.finish();

  const b = new ProjectRun(root, { topic: 'solar', sources: ['feed'] });
  b.setContacts([contact({ id: 'b' })]);
  b.finish();

  assert.notEqual(a.id, b.id);
  const first = JSON.parse(fs.readFileSync(a.jsonPath, 'utf8'));
  assert.equal(first.contacts.length, 1);
  assert.equal(first.contacts[0].id, 'a', 'the earlier project must be untouched');
  assert.equal(listProjects(root).length, 2);
});

test('listProjects returns newest first and survives a junk directory', () => {
  const root = tmpRoot();
  new ProjectRun(root, { topic: 'aaa', sources: [] }, '20260101-0900-aaa-1111').finish();
  new ProjectRun(root, { topic: 'bbb', sources: [] }, '20260812-1200-bbb-2222').finish();
  fs.mkdirSync(path.join(root, 'not-a-project'));

  const list = listProjects(root);
  assert.equal(list.length, 2, 'a directory with no project.json must be skipped, not fatal');
  assert.equal(list[0].id, '20260812-1200-bbb-2222', 'newest first');
});

test('a project abandoned by a dead daemon is corrected to failed', () => {
  const root = tmpRoot();
  const p = new ProjectRun(root, { topic: 'solar', sources: ['feed'] });
  p.progress({ scanned: 4 });
  assert.equal(p.snapshot.status, 'running');

  // Three hours later, a new run starts.
  const reaped = reapStaleProjects(root, 2 * 3_600_000, Date.now() + 3 * 3_600_000);

  assert.deepEqual(reaped, [p.id]);
  const onDisk = JSON.parse(fs.readFileSync(p.jsonPath, 'utf8'));
  assert.equal(onDisk.status, 'failed');
  assert.match(onDisk.error, /daemon exited/i);
  assert.equal(onDisk.counters.scanned, 4, 'whatever it did manage to read must survive');
});

test('a sweep still in flight is not reaped', () => {
  const root = tmpRoot();
  const p = new ProjectRun(root, { topic: 'solar', sources: ['feed'] });
  assert.deepEqual(reapStaleProjects(root), [], 'a live run must never be marked failed');
  assert.equal(JSON.parse(fs.readFileSync(p.jsonPath, 'utf8')).status, 'running');
});

test('a finished project is never touched by the reaper', () => {
  const root = tmpRoot();
  const p = new ProjectRun(root, { topic: 'solar', sources: ['feed'] });
  p.finish();
  assert.deepEqual(reapStaleProjects(root, 0, Date.now() + 9_999_999), []);
  assert.equal(JSON.parse(fs.readFileSync(p.jsonPath, 'utf8')).status, 'done');
});

test('listProjects on a missing directory is empty, not an exception', () => {
  assert.deepEqual(listProjects(path.join(tmpRoot(), 'nope')), []);
});
