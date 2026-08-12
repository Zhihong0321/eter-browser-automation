/**
 * Reconciliation is the check that stops a brand-new door from delivering a
 * confident wrong number. An endpoint answering 200 OK with 200 rows when the
 * screen showed 47 raises no error anywhere — only a row-count comparison
 * catches it, and only if 'unknown' is refused as firmly as 'no'.
 *
 * Pure function, no browser: the disagreeing case is the one that matters and
 * it must be testable without a live site.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isVerifiedRead, reconcileRows, type XhrRecord } from '../src/recon-net.js';

function rec(over: Partial<XhrRecord> = {}): XhrRecord {
  return {
    method: 'GET',
    url: 'https://admin.atap.solar/api/engineering-v2?limit=200&minPct=0&maxPct=100',
    urlPattern: '/api/engineering-v2',
    status: 200,
    contentType: 'application/json',
    bytes: 1234,
    replayable: 'yes',
    matchesScreen: 'unknown',
    apiRowCount: null,
    screenRowCount: null,
    ...over,
  };
}

test('agreement is recorded as yes', () => {
  const r = rec({ apiRowCount: 47 });
  reconcileRows([r], [47]);
  assert.equal(r.matchesScreen, 'yes');
  assert.equal(r.screenRowCount, 47);
  assert.equal(isVerifiedRead(r), true);
});

test('THE trap: 200 rows from the API, 47 on the screen', () => {
  // The UI filtered client-side or via a param the replay dropped. Status 200,
  // valid JSON, right shape, wrong answer.
  const r = rec({ apiRowCount: 200 });
  reconcileRows([r], [47]);
  assert.equal(r.matchesScreen, 'no');
  assert.equal(r.apiRowCount, 200);
  assert.equal(r.screenRowCount, 47);
  assert.equal(isVerifiedRead(r), false, 'a disagreeing endpoint is never a verified read');
});

test('unknown is never a pass — no screen table to compare against', () => {
  const r = rec({ apiRowCount: 200 });
  reconcileRows([r], []);
  assert.equal(r.matchesScreen, 'unknown');
  assert.equal(r.screenRowCount, null);
  assert.equal(isVerifiedRead(r), false);
});

test('unknown is never a pass — replayable endpoint with no countable rows', () => {
  // /api/v1/seda/status returns an object with no array: nothing to reconcile.
  const r = rec({ apiRowCount: null, rowCount: undefined });
  reconcileRows([r], [47]);
  assert.equal(r.matchesScreen, 'unknown');
  assert.equal(r.apiRowCount, null);
  assert.equal(isVerifiedRead(r), false);
});

test('a rendered count of 0 does not manufacture a pass', () => {
  // An empty table and a table that never rendered are indistinguishable here.
  // 0 === 0 agreeing would be the empty-trace bug wearing a different hat.
  const r = rec({ apiRowCount: 0 });
  reconcileRows([r], [0]);
  assert.equal(r.matchesScreen, 'unknown');
  assert.equal(isVerifiedRead(r), false);
});

test('any tab state may satisfy the match; the closest is reported when none do', () => {
  const hit = rec({ apiRowCount: 12 });
  const miss = rec({ apiRowCount: 200 });
  // main table 47, then the five payment tab states.
  reconcileRows([hit, miss], [47, 12, 3, 88]);
  assert.equal(hit.matchesScreen, 'yes');
  assert.equal(hit.screenRowCount, 12);
  assert.equal(miss.matchesScreen, 'no');
  assert.equal(miss.screenRowCount, 88, 'closest rendered count — "200 vs 88" is the useful sentence');
});

test('the page-received count is the fallback when no replay happened', () => {
  const r = rec({ replayable: 'not-tried', apiRowCount: null, rowCount: 47 });
  reconcileRows([r], [47]);
  assert.equal(r.apiRowCount, 47);
  assert.equal(r.matchesScreen, 'yes');
  assert.equal(isVerifiedRead(r), false, 'reconciled but not replayable — still not a verified read');
});

test('a successful replay count wins over the page-received count', () => {
  // This is the whole trap in one record: the page got 47, the standalone call
  // gets 200. Reconciliation must judge the number the automation would see.
  const r = rec({ apiRowCount: 200, rowCount: 47 });
  reconcileRows([r], [47]);
  assert.equal(r.apiRowCount, 200);
  assert.equal(r.matchesScreen, 'no');
});

test('non-replayable records are still stamped, never left undefined', () => {
  const r = rec({ replayable: 'not-json', contentType: 'text/x-component', apiRowCount: null });
  reconcileRows([r], [47]);
  assert.equal(r.matchesScreen, 'unknown');
  assert.equal(r.apiRowCount, null);
  assert.notEqual(r.screenRowCount, undefined);
});

test('the string trap: replayable is not a boolean', () => {
  // `if (rec.replayable)` is truthy for "not-json" and reported 18/18 endpoints
  // as replayable when none were. isVerifiedRead compares explicitly.
  for (const v of ['no', 'auth-failed', 'not-json', 'not-tried'] as const) {
    assert.equal(isVerifiedRead(rec({ replayable: v, matchesScreen: 'yes', apiRowCount: 47, screenRowCount: 47 })), false, v);
  }
});
