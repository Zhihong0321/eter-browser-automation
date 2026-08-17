// The website benchmark's scoring maths. No network, no browser: this pins the one
// part of the stage that produces a number we quote at a prospect, and the curve it
// uses is Lighthouse's, so it has exact anchors that must not drift.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { estimatePerformance, PSI_SCOPE } from '../src/enrich/pageinsight.js';

// Pinned, because the failure is silent and the correct value is counter-intuitive.
// PSI's discovery document declares exactly one OAuth scope. Anyone reaching for the
// usual Google Cloud scope gets 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT and the stage
// quietly degrades to the local estimate instead of reporting a credential problem.
test('the PSI OAuth scope stays openid — cloud-platform is rejected 403', () => {
  assert.equal(PSI_SCOPE, 'openid');
});

// Lighthouse v10 mobile p10 / median points, by construction of the log-normal curve.
const P10 = { fcpMs: 1_800, lcpMs: 2_500, tbtMs: 200, clsScore: 0.1 };
const MEDIAN = { fcpMs: 3_000, lcpMs: 4_000, tbtMs: 600, clsScore: 0.25 };

test('the p10 of every metric scores 90, by definition of the curve', () => {
  assert.equal(estimatePerformance(P10), 90);
});

test('the median of every metric scores 50, by definition of the curve', () => {
  assert.equal(estimatePerformance(MEDIAN), 50);
});

test('a fast page reaches 100 and a slow one lands near the floor', () => {
  assert.equal(estimatePerformance({ fcpMs: 400, lcpMs: 700, tbtMs: 0, clsScore: 0 }), 100);
  const slow = estimatePerformance({ fcpMs: 9_000, lcpMs: 14_000, tbtMs: 12_000, clsScore: 0.9 });
  assert.ok(slow !== null && slow < 10, `expected a single-digit score, got ${slow}`);
});

// A measured 0 is a real result — a page CAN have no layout shift and no long tasks.
// Clamping it away as "unmeasured" would quietly cost the page its two best metrics.
test('zero CLS and zero TBT score as perfect, not as missing', () => {
  const zeroed = estimatePerformance({ fcpMs: 3_000, lcpMs: 4_000, tbtMs: 0, clsScore: 0 });
  assert.ok(zeroed !== null && zeroed > 50, `zeroes must lift the score, got ${zeroed}`);
});

// Null means unmeasured, and an unmeasured metric must drop out of the weighting
// rather than be scored as zero — scoring it as zero would report a fast site as slow.
test('an unmeasured metric is dropped from the weighting, not counted as zero', () => {
  const withoutTbt = estimatePerformance({ ...P10, tbtMs: null });
  assert.equal(withoutTbt, 90, 'the remaining p10 metrics still average to 90');
});

test('no measurable metric at all yields null rather than a fabricated score', () => {
  assert.equal(estimatePerformance({ fcpMs: null, lcpMs: null, tbtMs: null, clsScore: null }), null);
});
