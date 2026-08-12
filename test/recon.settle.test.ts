/**
 * The analyzer is pure, so the trap rules are testable without a browser.
 *
 * These cases are not invented — they are the two traps INDEX.md documents for
 * admin.atap.solar, each of which was originally discovered by shipping
 * something that returned a confident wrong number. If the analyzer cannot
 * catch them from a synthetic trace, it will not catch them live either.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { analyzeSettle, isBlocked, isMaskedShape, PROBES, type SettleBucket, type SettleTrace } from '../src/recon.js';

const ZERO = Object.fromEntries(Object.keys(PROBES).map((k) => [k, 0])) as Record<string, number>;

function bucket(t: number, over: Partial<SettleBucket> = {}): SettleBucket {
  return { t, counts: { ...ZERO }, firstRow: '', texts: [], mutations: 1, ...over };
}

function trace(buckets: SettleBucket[]): SettleTrace {
  return {
    url: 'https://admin.atap.solar/payments',
    title: 'Payments',
    mode: 'observer',
    installedAt: 40,
    windowMs: 8000,
    exitReason: 'quiet',
    buckets,
  };
}

// Rows arrive already masked — the page never emits real cell content. Digits
// are 9, letters are x, and currency codes survive because the derived wait is
// built from them. These are the exact shapes the analyzer sees in production.
const SKELETON_ROW = ' |  |  |  |  | ';
const REAL_ROW = 'xxx 99, 9999 99:99 xx | xxxxxx xxx | RM 9,999.99 | xxxx xxxxxxxx | xxxxxxx | xxxx';

/** The trace admin.atap.solar/payments actually produces, per INDEX.md. */
const ATAP = trace([
  bucket(400, { counts: { ...ZERO, 'table tbody tr': 5, '[role=row]': 5 }, firstRow: SKELETON_ROW }),
  bucket(900, {
    counts: { ...ZERO, 'table tbody tr': 5, '[role=row]': 5 },
    firstRow: SKELETON_ROW,
    texts: ['showing 0 results'],
  }),
  bucket(3400, { counts: { ...ZERO, 'table tbody tr': 27, '[role=row]': 28 }, firstRow: REAL_ROW }),
]);

test('trap 1: flags `table tbody tr` as unstable — 5 rows early, 27 settled', () => {
  const v = analyzeSettle(ATAP);
  const hit = v.unstable.find((u) => u.probe === 'table tbody tr');
  assert.ok(hit, 'should flag table tbody tr as unstable');
  assert.equal(hit.earlyCount, 5);
  assert.equal(hit.finalCount, 27);
  assert.equal(hit.earlyAt, 400);
});

test('trap 2: flags "Showing 0 results" as a loading state, not an empty table', () => {
  const v = analyzeSettle(ATAP);
  const hit = v.loadingTexts.find((l) => l.text === 'showing 0 results');
  assert.ok(hit, 'should flag showing 0 results as a loading text');
  assert.equal(hit.seenAt, 900);
  assert.equal(hit.goneAt, 3400);
});

test('derives the documented wait: /RM\\s?[\\d,]/', () => {
  const v = analyzeSettle(ATAP);
  assert.ok(v.waitOn, 'should derive a wait');
  assert.equal(v.waitOn.pattern, 'RM\\s?[\\d,]');
});

test('the derived wait DISCRIMINATES — matches settled, rejects skeleton', () => {
  // The property that actually matters. A wait matching both is worse than no
  // wait: it looks correct and returns garbage.
  const v = analyzeSettle(ATAP);
  const re = new RegExp(v.waitOn!.pattern);
  assert.ok(re.test(REAL_ROW), 'must match the settled row');
  assert.ok(!re.test(SKELETON_ROW), 'must NOT match the skeleton row');
});

test('settledAt is the last change, not the window end', () => {
  assert.equal(analyzeSettle(ATAP).settledAt, 3400);
});

test('a page that loads clean reports nothing unstable', () => {
  const v = analyzeSettle(
    trace([bucket(250, { counts: { ...ZERO, 'table tbody tr': 12 }, firstRow: REAL_ROW })]),
  );
  assert.equal(v.unstable.length, 0);
  assert.equal(v.loadingTexts.length, 0);
});

test('a probe that only appears late is not called unstable', () => {
  // Absent early then present later is normal rendering, not a lie.
  const v = analyzeSettle(
    trace([bucket(300), bucket(2000, { counts: { ...ZERO, 'table tbody tr': 9 }, firstRow: REAL_ROW })]),
  );
  assert.equal(v.unstable.length, 0);
});

test('no settle data yields no recommendation rather than a wrong one', () => {
  const v = analyzeSettle(trace([]));
  assert.equal(v.waitOn, null);
  assert.equal(v.settledAt, null);
  assert.ok(v.notes.length > 0);
});

test('a failed observer says so loudly — never "nothing unstable detected"', () => {
  // The regression that motivated this test: the first live run reported a
  // clean page when in truth nothing had been watched at all. Silence must
  // never be reported as evidence of stability.
  const v = analyzeSettle({ ...ATAP, mode: 'failed' });
  assert.equal(v.waitOn, null);
  assert.equal(v.unstable.length, 0);
  assert.ok(v.notes.some((n) => /OBSERVER FAILED/.test(n)), 'must announce the failure');
  assert.ok(v.notes.some((n) => /no evidence/.test(n)), 'must not imply the page is clean');
});

test('a late observer install is disclosed as a blind window', () => {
  const v = analyzeSettle({ ...ATAP, installedAt: 900 });
  assert.ok(v.notes.some((n) => /900ms after navigation start/.test(n)));
});

test('a prompt install adds no noise', () => {
  assert.equal(analyzeSettle({ ...ATAP, installedAt: 40 }).notes.length, 0);
});

test('hitting the window cap is disclosed — the page may not have finished', () => {
  // A page still changing when the window expires has NOT been fully observed.
  // Reporting its last-seen state as "settled" would be the same class of lie
  // the whole feature exists to catch.
  const v = analyzeSettle({ ...ATAP, exitReason: 'cap' });
  assert.ok(v.notes.some((n) => /still changing/.test(n)));
});

test('the mask guard rejects real customer data', () => {
  // Verbatim from the first live run against admin.atap.solar/payments, which
  // is how this defect was found: real names and a phone number in the sample.
  assert.equal(isMaskedShape('Wilson Tan Wei Sheng | YAM YIT FAH (ATAP) | RM 3,700.00'), false);
  assert.equal(isMaskedShape('Bank Transfer'), false);
  assert.equal(isMaskedShape('60 18-777 0073'), true, 'bare digits carry no names, but see the digit mask');
});

test('the mask guard accepts masked shapes, currency codes included', () => {
  assert.equal(isMaskedShape(REAL_ROW), true);
  assert.equal(isMaskedShape(SKELETON_ROW), true);
  assert.equal(isMaskedShape('xxx 99, 9999 | RM 9,999.99 | USD 99.99'), true);
});

test('a masked row still yields the currency wait', () => {
  // The mask has to destroy content while preserving everything the analyzer
  // needs. If this breaks, masking has cost us the trap detection.
  const v = analyzeSettle(ATAP);
  assert.equal(v.waitOn?.pattern, 'RM\\s?[\\d,]');
  assert.ok(!new RegExp(v.waitOn!.pattern).test(SKELETON_ROW));
});

test('blocklist refuses social and messaging, allows business SaaS', () => {
  assert.equal(isBlocked('web.whatsapp.com'), 'whatsapp.com');
  assert.equal(isBlocked('www.facebook.com'), 'facebook.com');
  assert.equal(isBlocked('x.com'), 'x.com');
  assert.equal(isBlocked('admin.atap.solar'), null);
  assert.equal(isBlocked('autocount.com.my'), null);
});

test('blocklist is not fooled by a lookalike suffix', () => {
  assert.equal(isBlocked('notfacebook.com'), null);
  assert.equal(isBlocked('facebook.com.evil.test'), null);
});
