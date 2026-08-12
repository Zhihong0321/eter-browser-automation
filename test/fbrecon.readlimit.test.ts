import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReadLimiter, DEFAULT_READ_LIMITS } from '../src/readlimit.js';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fbrecon-')), 'read-history.json');
}

test('takePost returns false once the per-run post cap is reached', () => {
  const lim = new ReadLimiter(tmpFile(), { postsPerRun: 3 });
  assert.equal(lim.takePost(), true);
  assert.equal(lim.takePost(), true);
  assert.equal(lim.takePost(), true);
  assert.equal(lim.takePost(), false, 'fourth post must be refused');
});

test('resetRun clears per-run counters but not the hourly history', async () => {
  const file = tmpFile();
  const lim = new ReadLimiter(file, { postsPerRun: 1, pageOpensPerRun: 1, pageOpensPerHour: 10 });
  assert.equal(lim.takePost(), true);
  await lim.takePageOpen();
  lim.resetRun();
  assert.equal(lim.takePost(), true, 'run counter must reset');
  assert.equal(lim.snapshot().opensLastHour, 1, 'hourly history must survive resetRun');
});

test('takePageOpen throws once the per-run open cap is reached', async () => {
  const lim = new ReadLimiter(tmpFile(), { pageOpensPerRun: 1 });
  await lim.takePageOpen();
  await assert.rejects(() => lim.takePageOpen(), /per-run/i);
});

test('takePageOpen refuses rather than waiting past maxWaitMs', async () => {
  const lim = new ReadLimiter(tmpFile(), { pageOpensPerHour: 1, pageOpensPerRun: 99, maxWaitMs: 50 });
  await lim.takePageOpen();
  await assert.rejects(() => lim.takePageOpen(), /would need to wait/i);
});

test('hourly history round-trips through the state file', async () => {
  const file = tmpFile();
  const a = new ReadLimiter(file, DEFAULT_READ_LIMITS);
  await a.takePageOpen();
  const b = new ReadLimiter(file, DEFAULT_READ_LIMITS);
  assert.equal(b.snapshot().opensLastHour, 1);
});

test('a malformed state file starts from an empty budget instead of throwing', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'not json at all');
  const lim = new ReadLimiter(file, DEFAULT_READ_LIMITS);
  assert.equal(lim.snapshot().opensLastHour, 0);
});
