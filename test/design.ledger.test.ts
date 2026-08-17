import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger, formatTotals } from '../src/design/ledger.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
}

function entry(over: Partial<Parameters<Ledger['record']>[0]> = {}) {
  return {
    phase: 'build' as const,
    model: 'kimi-k3',
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUSD: 0,
    images: 0,
    ms: 500,
    ...over,
  };
}

test('totals split in and out tokens per model and overall', () => {
  const l = new Ledger(tmpDir());
  l.record(entry({ model: 'kimi-k3', inputTokens: 42_601, outputTokens: 227 }));
  l.record(entry({ model: 'kimi-k3', inputTokens: 1_000, outputTokens: 100 }));
  l.record(entry({ phase: 'review', model: 'step-3.7-flash', inputTokens: 8_000, outputTokens: 1_500 }));

  const t = l.totals();
  assert.equal(t.inputTokens, 51_601);
  assert.equal(t.outputTokens, 1_827);
  assert.equal(t.totalTokens, 53_428);

  const kimi = t.byModel.find((m) => m.model === 'kimi-k3')!;
  assert.equal(kimi.calls, 2);
  assert.equal(kimi.inputTokens, 43_601);
  // Ordered by total tokens, so the heaviest model reads first.
  assert.equal(t.byModel[0]!.model, 'kimi-k3');
});

test('phase totals let a run be attributed to build vs review', () => {
  const l = new Ledger(tmpDir());
  l.record(entry({ phase: 'build', inputTokens: 100, outputTokens: 10 }));
  l.record(entry({ phase: 'review', inputTokens: 900, outputTokens: 90 }));
  l.record(entry({ phase: 'review', inputTokens: 900, outputTokens: 90 }));

  const t = l.totals();
  assert.equal(t.byPhase.find((p) => p.phase === 'review')!.calls, 2);
  assert.equal(t.byPhase.find((p) => p.phase === 'review')!.inputTokens, 1_800);
  assert.equal(t.byPhase.find((p) => p.phase === 'build')!.calls, 1);
});

test('cost from a non-Anthropic model is never counted as real money', () => {
  // The SDK prices by model id against Anthropic's table. kimi-k3 is not in it,
  // so any figure it returns is noise — reporting it would be worse than silence.
  const l = new Ledger(tmpDir());
  l.record(entry({ model: 'kimi-k3', costUSD: 9.99 }));
  const t = l.totals();
  assert.equal(t.costUSD, 0);
  assert.equal(t.hasUntrustedCost, true);
  assert.equal(t.byModel[0]!.costTrusted, false);
  assert.match(formatTotals(t), /not priced/);
});

test('a first-party Claude model keeps its cost', () => {
  const l = new Ledger(tmpDir());
  l.record(entry({ model: 'claude-opus-5', provider: 'firstParty', costUSD: 0.25 }));
  const t = l.totals();
  assert.equal(t.costUSD, 0.25);
  assert.equal(t.hasUntrustedCost, false);
  assert.match(formatTotals(t), /\$0\.2500/);
});

test('one untrusted call taints that model total rather than averaging away', () => {
  const l = new Ledger(tmpDir());
  l.record(entry({ model: 'mixed', provider: 'firstParty', costUSD: 1 }));
  l.record(entry({ model: 'mixed', provider: 'gateway', costUSD: 1 }));
  assert.equal(l.totals().byModel[0]!.costTrusted, false);
});

test('recordSdkResult reads modelUsage, not the main-loop-only usage field', () => {
  const l = new Ledger(tmpDir());
  const written = l.recordSdkResult('build', {
    duration_ms: 4321,
    // `usage` deliberately disagrees: the SDK documents it as main-agent-loop
    // only, so a run that spawned a subagent would under-report from it.
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {
      'kimi-k3': { inputTokens: 5_000, outputTokens: 400, costUSD: 7, provider: 'gateway' },
      'step-3.7-flash': { inputTokens: 900, outputTokens: 80 },
    },
  });

  assert.equal(written.length, 2);
  const t = l.totals();
  assert.equal(t.inputTokens, 5_900);
  assert.equal(t.outputTokens, 480);
  assert.equal(t.costUSD, 0, 'gateway-provided cost must not be trusted');
  assert.equal(written[0]!.ms, 4321);
});

test('a result carrying no usage records nothing rather than zeroes', () => {
  // Crash and startup-error results zero their usage; inventing rows for them
  // would make a failed run look like a free one.
  const l = new Ledger(tmpDir());
  assert.deepEqual(l.recordSdkResult('build', { duration_ms: 10 }), []);
  assert.equal(l.totals().totalTokens, 0);
});

test('the ledger survives the process — every entry is flushed on write', () => {
  const dir = tmpDir();
  const first = new Ledger(dir);
  first.record(entry({ inputTokens: 1_234 }));

  // A killed run must still leave an accurate bill behind.
  const reopened = new Ledger(dir);
  assert.equal(reopened.entries.length, 1);
  assert.equal(reopened.totals().inputTokens, 1_234);

  reopened.record(entry({ inputTokens: 1 }));
  assert.equal(new Ledger(dir).totals().inputTokens, 1_235);
});

test('a corrupt ledger does not abort a paid run', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'ledger.json'), '{ this is not json');
  const l = new Ledger(dir);
  assert.deepEqual(l.entries, []);
  l.record(entry());
  assert.equal(l.totals().calls ?? l.entries.length, 1);
});

test('images are tracked separately from tokens', () => {
  const l = new Ledger(tmpDir());
  l.record(entry({ phase: 'image', model: 'step-image-edit-2', inputTokens: 0, outputTokens: 0, images: 3 }));
  const t = l.totals();
  assert.equal(t.images, 3);
  assert.equal(t.totalTokens, 0);
  assert.match(formatTotals(t), /3 images/);
});
