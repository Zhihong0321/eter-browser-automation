/**
 * The CSP rewrite is the one thing in Part 2 that fails SILENTLY when wrong.
 *
 * monolith emits `script-src 'none'` whenever -j is passed. An overlay injected
 * into an untouched snapshot never runs, with no error and no console warning,
 * and the person building the overlay debugs their own code for an afternoon.
 * Pure functions, tested here without invoking the binary.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cspFor, finalizeSnapshot, NO_STYLESHEETS_ERROR, rewriteCsp, snapshotFileName } from '../src/recon-capture.js';

// The exact meta monolith 2.10.1 emits for `-j -i -F` (spike findings §4).
const MONOLITH_CSP = `<meta http-equiv="Content-Security-Policy" content="font-src 'none'; script-src 'none'; img-src data:;">`;

test("monolith's script-src 'none' is replaced, not appended", () => {
  const out = rewriteCsp(`<html><head>${MONOLITH_CSP}<title>x</title></head><body>hi</body></html>`, 'ABC123');
  assert.equal(out.includes("script-src 'none'"), false, "the dead-overlay CSP must be gone, not merely followed");
  assert.equal(out.includes("script-src 'nonce-ABC123'"), true);
  assert.equal((out.match(/Content-Security-Policy/g) ?? []).length, 1, 'exactly one policy, or the strictest still wins');
});

test('the -I variant is replaced too', () => {
  const withIsolate = `<meta http-equiv="Content-Security-Policy" content="default-src 'unsafe-eval' 'unsafe-inline' data:; font-src 'none'; script-src 'none'; img-src data:;">`;
  const out = rewriteCsp(`<head>${withIsolate}</head>`, 'N1');
  assert.equal(out.includes("'unsafe-eval'"), false);
  assert.equal(out.includes("script-src 'nonce-N1'"), true);
});

test('a snapshot with no CSP gets one — absent is worse than wrong', () => {
  const out = rewriteCsp('<html><head><title>x</title></head><body>hi</body></html>', 'N2');
  assert.equal(out.includes(`content="${cspFor('N2')}"`), true);
  assert.match(out, /<head[^>]*><meta http-equiv="Content-Security-Policy"/, 'inserted at the top of head');
});

test('no head at all still yields a policy', () => {
  const out = rewriteCsp('<div>fragment</div>', 'N3');
  assert.equal(out.startsWith('<meta http-equiv="Content-Security-Policy"'), true);
});

test('the policy keeps the frozen page inert', () => {
  const csp = cspFor('N4');
  assert.equal(csp.includes("default-src 'none'"), true, 'the page must not reach the network');
  assert.equal(csp.includes('img-src data:'), true, 'inlined images only');
  // monolith emits <link rel=stylesheet href="data:text/css;base64,…">, not
  // <style>. 'unsafe-inline' alone does not cover a data: URL, and the snapshot
  // would render unstyled with no error — measured, see cspFor().
  assert.equal(csp.includes("style-src 'unsafe-inline' data:"), true, 'data: stylesheets must be allowed');
  assert.equal(/script-src 'nonce-[^']+'/.test(csp), true);
});

test('route urls become stable, flat file names', () => {
  assert.equal(snapshotFileName('https://admin.atap.solar/payments'), 'payments.html');
  assert.equal(snapshotFileName('https://admin.atap.solar/'), 'index.html');
  assert.equal(snapshotFileName('https://admin.atap.solar'), 'index.html');
  // Nested routes must not become directory traversal, and must not collide.
  assert.equal(snapshotFileName('https://admin.atap.solar/sync/invoice-items'), 'sync-invoice-items.html');
  assert.equal(snapshotFileName('https://admin.atap.solar/a/b'), 'a-b.html');
  // Query strings are not part of the key — the tab state is, and that is Part 3.
  assert.equal(snapshotFileName('https://admin.atap.solar/payments?tab=2'), 'payments.html');
});

test('file names carry no path separators or drive letters', () => {
  for (const u of ['https://x.test/../../etc/passwd', 'https://x.test/C:\\windows', 'https://x.test/a%2Fb']) {
    const name = snapshotFileName(u);
    assert.equal(/[\\/:]/.test(name), false, `${u} → ${name}`);
  }
});

/**
 * The render check — the only assertion in Part 2 that observes whether a
 * snapshot is USABLE rather than merely produced.
 *
 * Every cheaper signal reported success while 17 snapshots rendered blank:
 * monolith exited 0, stdout was large, the tag census matched the live DOM.
 * "Did the process exit 0" cannot see this failure mode. These tests pin the
 * rule that replaced it.
 */
test('0 stylesheets is an ERROR, never a pass', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-cap-'));
  const rec = await finalizeSnapshot('<html><head></head><body>x</body></html>', {
    outDir: dir,
    fileName: 'payments.html',
    renderCheck: async () => 0,
  });
  assert.equal(rec.styleSheets, 0);
  assert.equal(rec.error, NO_STYLESHEETS_ERROR, 'a blank render must not be recorded as a clean capture');
  assert.notEqual(rec.file, null, 'the file is kept for inspection — it failed, it is not absent');
});

test('a real stylesheet count passes and is recorded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-cap-'));
  const rec = await finalizeSnapshot('<html><head></head><body>x</body></html>', {
    outDir: dir,
    fileName: 'payments.html',
    renderCheck: async () => 2,
  });
  assert.equal(rec.styleSheets, 2);
  assert.equal(rec.error, undefined);
});

test('a broken render check is reported, never read as success', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-cap-'));
  const rec = await finalizeSnapshot('<html><head></head><body>x</body></html>', {
    outDir: dir,
    fileName: 'payments.html',
    renderCheck: async () => {
      throw new Error('page closed');
    },
  });
  assert.equal(rec.styleSheets, null, 'unknown is not zero and not fine');
  assert.match(rec.error ?? '', /render check failed/);
});
