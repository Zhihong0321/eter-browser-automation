import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  buildQuickTestPlanV3,
  mapWithConcurrency,
  resolveReconV3Options,
  screenshotFileNameV3,
  selectV3Targets,
  shapeOfV3,
} from '../src/recon-v3.js';

test('V3 defaults select the fast bounded posture', () => {
  assert.deepEqual(resolveReconV3Options(), {
    maxPages: 40,
    concurrency: 3,
    settleQuietMs: 650,
    settleCapMs: 3500,
    replay: true,
    replayConcurrency: 4,
    replayLimit: 12,
    screenshots: true,
    fullPage: false,
    exploreTabs: false,
  });
});

test('V3 options clamp unsafe or nonsensical values', () => {
  const out = resolveReconV3Options({
    maxPages: 999,
    concurrency: 0,
    settleQuietMs: 100,
    settleCapMs: 50,
    replayConcurrency: 99,
    replayLimit: -1,
  });
  assert.equal(out.maxPages, 200);
  assert.equal(out.concurrency, 1);
  assert.equal(out.settleQuietMs, 200);
  assert.equal(out.settleCapMs, 200, 'cap cannot be shorter than the quiet window');
  assert.equal(out.replayConcurrency, 8);
  assert.equal(out.replayLimit, 0);
});

test('PNG names are flat, stable, and distinguish query variants', () => {
  const first = screenshotFileNameV3('https://app.test/payments?tab=pending');
  const again = screenshotFileNameV3('https://app.test/payments?tab=pending');
  const other = screenshotFileNameV3('https://app.test/payments?tab=paid');
  assert.equal(first, again);
  assert.notEqual(first, other);
  assert.equal(/[\\/:]/.test(first), false);
  assert.match(first, /^payments-[a-f0-9]{8}\.png$/);
});

test('target selection is same-origin, stable, deduplicated, and bounded', () => {
  const out = selectV3Targets('https://app.test/', [
    { name: 'root', href: 'https://app.test/#top' },
    { name: 'payments', href: '/payments#rows' },
    { name: 'payments duplicate', href: 'https://app.test/payments' },
    { name: 'external', href: 'https://other.test/export' },
    { name: 'invoices', href: '/invoices' },
  ], 1);
  assert.deepEqual(out, [{ name: 'payments', href: 'https://app.test/payments' }]);
});

test('shape extraction stores keys and counts but no response values', () => {
  const out = shapeOfV3({
    ok: true,
    customers: [
      { name: 'Sensitive Name', phone: '0123456789' },
      { name: 'Another Name', phone: '99887766' },
    ],
  });
  assert.deepEqual(out.jsonTopKeys, ['ok', 'customers']);
  assert.deepEqual(out.rowKeys, ['name', 'phone']);
  assert.equal(out.rowCount, 2);
  assert.equal(JSON.stringify(out).includes('Sensitive Name'), false);
  assert.equal(JSON.stringify(out).includes('0123456789'), false);
});

test('bounded mapper preserves order and never exceeds concurrency', async () => {
  let active = 0;
  let peak = 0;
  const out = await mapWithConcurrency([30, 5, 20, 1], 2, async (delay, index) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active--;
    return `item-${index}`;
  });
  assert.deepEqual(out, ['item-0', 'item-1', 'item-2', 'item-3']);
  assert.equal(peak, 2);
});

test('quick-test handoff gates writes behind a successful read and exposes selectors', () => {
  const base = {
    tag: 'button', strategy: 'role-name' as const, href: null, disabled: false,
    inNav: false, inForm: false, hasSubmitNear: false, expanded: null,
  };
  const plan = buildQuickTestPlanV3(
    'https://app.test/customers',
    { headers: ['Customer Code', 'Company Name'], columns: 2, rows: 3 },
    [
      { ...base, role: 'button', name: 'New', selector: "getByRole('button', { name: 'New' })" },
      { ...base, role: 'button', name: 'Edit', selector: "getByRole('button', { name: 'Edit' })" },
      { ...base, role: 'button', name: 'Delete', selector: "getByRole('button', { name: 'Delete' })" },
    ],
    [{
      method: 'GET', url: 'https://app.test/api/customers', urlPattern: '/api/customers',
      status: 200, contentType: 'application/json', bytes: 10, replayable: 'not-tested',
      matchesScreen: 'unknown', apiRowCount: null, screenRowCount: null,
    }],
  );
  assert.equal(plan.readGate.status, 'passed');
  assert.deepEqual(plan.order, ['read', 'write']);
  assert.equal(plan.operations.create.available, true);
  assert.equal(plan.operations.update.available, true);
  assert.equal(plan.operations.delete.available, true);
  assert.match(plan.operations.create.steps[1].selector ?? '', /New/);
  assert.match(plan.marker, /^RECON-V3-CUSTOMERS-/);
});
