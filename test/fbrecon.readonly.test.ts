/**
 * fb-recon is read-only. This test is what makes that a property of the code
 * rather than a claim in a comment.
 *
 * It is deliberately a source-text assertion. A behavioural test would need a
 * live Facebook session, and the thing most likely to break this guarantee is
 * not a bug — it is a future edit that adds one convenient click.
 *
 * Note on what is NOT asserted: "zero POST requests to facebook.com" is not
 * achievable. Facebook's own client fires POST /api/graphql/ continuously in
 * response to plain scrolling, so that assertion would fail on a purely passive
 * run. What is asserted instead is stronger where it counts — the module
 * contains no code capable of composing or submitting anything.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(import.meta.dirname, '..', 'src', 'fb-recon');

function sources(): { file: string; text: string }[] {
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(DIR, f), 'utf8') }));
}

test('the module directory is non-empty (guards against a silently passing suite)', () => {
  assert.ok(sources().length >= 6, 'expected the fb-recon modules to exist');
});

test('no text input or form submission API appears anywhere in fb-recon', () => {
  const forbidden = ['.fill(', '.type(', '.press(', 'pressSequentially', 'humanType', 'humanClick', 'commentOnPost', '.setInputFiles(', '.selectOption(', '.check('];
  for (const { file, text } of sources()) {
    for (const f of forbidden) {
      assert.ok(!text.includes(f), `${file} contains forbidden write API: ${f}`);
    }
  }
});

test('browser.ts is the only file that clicks', () => {
  for (const { file, text } of sources()) {
    if (file === 'browser.ts') continue;
    assert.ok(!text.includes('.click('), `${file} clicks directly; all clicks must go through safeClick() in browser.ts`);
  }
});

test('the extractors never mutate the page', () => {
  const text = fs.readFileSync(path.join(DIR, 'extract.ts'), 'utf8');
  for (const f of ['innerHTML =', '.remove()', '.submit(', 'document.write']) {
    assert.ok(!text.includes(f), `extract.ts mutates the page: ${f}`);
  }
});

test('the automation card declares effect: read', () => {
  const card = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'automations', 'facebook', 'recon.ts'),
    'utf8',
  );
  assert.match(card, /effect:\s*read/, 'the registry card must declare effect: read');
});

test('no absolute personal path or API key is baked into the module', () => {
  for (const { file, text } of sources()) {
    assert.ok(!/[A-Z]:\\Users\\/i.test(text), `${file} hardcodes an absolute Windows user path`);
    assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(text), `${file} appears to contain an API key`);
  }
});
