/**
 * The click policy is the safety fence between a scan and the user's live ERP.
 * It is a pure function precisely so it can be tested exhaustively here, with
 * no browser and no live site involved.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { clickPolicy, partitionByPolicy, type UiElement } from '../src/recon-dom.js';
import { urlPattern, usefulEndpoints, type XhrRecord } from '../src/recon-net.js';

function el(over: Partial<UiElement> = {}): UiElement {
  return {
    role: 'button',
    name: 'Something',
    tag: 'button',
    selector: 'x',
    strategy: 'css',
    href: null,
    disabled: false,
    inNav: false,
    inForm: false,
    hasSubmitNear: false,
    expanded: null,
    ...over,
  };
}

// ------------------------------------------------------------------ allowed

test('tabs are clickable — they are where the data lives', () => {
  // On admin.atap.solar the payment states are tabs, not URLs. Refusing to
  // click them would mean recording 1 of 5 states and calling the page done.
  assert.equal(clickPolicy(el({ role: 'tab', name: 'Pending Verification' })).allowed, true);
  assert.equal(clickPolicy(el({ role: 'tab', name: 'Delete' })).allowed, true, 'role wins over name for tabs');
});

test('nav links and menu disclosures are clickable', () => {
  assert.equal(clickPolicy(el({ role: 'link', inNav: true, href: '/invoices' })).allowed, true);
  assert.equal(clickPolicy(el({ role: 'button', inNav: true, expanded: false, name: 'Sales' })).allowed, true);
});

test('pagination is clickable', () => {
  assert.equal(clickPolicy(el({ role: 'button', name: 'Next page' })).allowed, true);
  assert.equal(clickPolicy(el({ role: 'link', name: 'Previous' })).allowed, true);
});

// ------------------------------------------------------------------ refused

test('buttons are NEVER clicked in pass 1, whatever they are called', () => {
  // The whole reason for an allowlist. A name denylist would have to guess at
  // Post, Void, Commit, Save & New, Confirm Journal — and would miss one.
  for (const name of ['Delete', 'Verify', 'Post', 'Void', 'Commit', 'Save & New', 'Confirm Journal', 'Refresh', 'OK']) {
    const v = clickPolicy(el({ role: 'button', name }));
    assert.equal(v.allowed, false, `button "${name}" must not be auto-clicked`);
  }
});

test('a harmless-sounding button is still refused', () => {
  assert.equal(clickPolicy(el({ role: 'button', name: 'Process' })).allowed, false);
  assert.equal(clickPolicy(el({ role: 'button', name: '' })).allowed, false, 'icon-only buttons too');
});

test('recon never types into fields', () => {
  assert.equal(clickPolicy(el({ role: 'textbox', tag: 'input', name: 'Search' })).allowed, false);
  assert.equal(clickPolicy(el({ role: 'textbox', tag: 'textarea', name: 'Notes' })).allowed, false);
});

test('a link outside the nav is not followed by the click policy', () => {
  assert.equal(clickPolicy(el({ role: 'link', inNav: false, name: 'Export CSV' })).allowed, false);
});

test('javascript: and mailto: nav links are refused', () => {
  assert.equal(clickPolicy(el({ role: 'link', inNav: true, href: 'javascript:void(0)' })).allowed, false);
  assert.equal(clickPolicy(el({ role: 'link', inNav: true, href: 'mailto:a@b.c' })).allowed, false);
});

test('disabled controls are refused before anything else is considered', () => {
  assert.equal(clickPolicy(el({ role: 'tab', name: 'Archived', disabled: true })).allowed, false);
});

// --------------------------------------------------- the one judgement call

test('a standalone filter is clickable, a form-bound one is not', () => {
  assert.equal(clickPolicy(el({ role: 'combobox', name: 'Status' })).allowed, true);
  assert.equal(clickPolicy(el({ role: 'combobox', name: 'Status', inForm: true })).allowed, false);
  assert.equal(clickPolicy(el({ role: 'combobox', name: 'Status', hasSubmitNear: true })).allowed, false);
  assert.equal(clickPolicy(el({ role: 'radio', name: 'Paid', inForm: true })).allowed, false);
});

test('every refusal carries a reason for the approval list', () => {
  const { skipped } = partitionByPolicy([
    el({ role: 'button', name: 'Delete' }),
    el({ role: 'combobox', name: 'Status', inForm: true }),
    el({ role: 'tab', name: 'Pending Verification' }),
  ]);
  assert.equal(skipped.length, 2);
  for (const s of skipped) assert.ok(s.reason.length > 0, 'a skipped control with no reason is not actionable');
});

// ------------------------------------------------------------------ network

test('url patterns collapse ids so endpoints group', () => {
  assert.equal(urlPattern('https://x.test/api/invoices/8821/lines?page=2'), '/api/invoices/:id/lines');
  assert.equal(urlPattern('https://x.test/api/payments?status=pending'), '/api/payments');
  assert.equal(urlPattern('https://x.test/api/u/3fa85f64-5717-4562-b3fc-2c963f66afa6'), '/api/u/:id');
});

test('only replayable endpoints reach the brief, biggest first', () => {
  const base = { status: 200, contentType: 'application/json', bytes: 1, matchesScreen: 'unknown', apiRowCount: null, screenRowCount: null } as const;
  const recs: XhrRecord[] = [
    { ...base, method: 'GET', url: 'u1', urlPattern: '/api/small', rowCount: 3, replayable: 'yes' },
    { ...base, method: 'GET', url: 'u2', urlPattern: '/api/big', rowCount: 27, replayable: 'yes' },
    { ...base, method: 'GET', url: 'u3', urlPattern: '/api/nope', replayable: 'auth-failed' },
    { ...base, method: 'POST', url: 'u4', urlPattern: '/api/write', replayable: 'not-tried' },
  ];
  const out = usefulEndpoints(recs);
  assert.deepEqual(out.map((r) => r.urlPattern), ['/api/big', '/api/small']);
});
