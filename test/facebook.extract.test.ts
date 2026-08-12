import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'facebook.ts'), 'utf8');

test('the post root is not detected by matching innerText against action words', () => {
  assert.ok(
    !/actionRe\s*=\s*\/\\b\(Comment\|Like\|Share\)\\b\//.test(SRC),
    'the innerText action regex never matches the live DOM and yields zero posts',
  );
});

test('the post root is detected by an ARIA action selector instead', () => {
  assert.match(SRC, /ACTION_SEL/, 'expected an aria-label based action selector');
  assert.match(SRC, /aria-label\*?=\\?"?omment/i, 'expected the comment control to be matched by aria-label');
});
