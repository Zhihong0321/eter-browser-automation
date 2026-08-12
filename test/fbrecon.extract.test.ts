import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { POST_EXTRACT_SRC, COMMENT_EXTRACT_SRC } from '../src/fb-recon/extract.js';

test('post extractor source has no unsubstituted placeholders', () => {
  assert.ok(!POST_EXTRACT_SRC.includes('PLACEHOLDER'), 'placeholder leaked into evaluated source');
});

test('post extractor source embeds the real message selector', () => {
  assert.ok(POST_EXTRACT_SRC.includes('data-ad-preview'), 'MESSAGE_SEL was not injected');
});

test('post extractor is a self-contained function expression', () => {
  assert.ok(/^\s*\(?\s*(function|\()/.test(POST_EXTRACT_SRC) || POST_EXTRACT_SRC.trimStart().startsWith('()'),
    `not an evaluable function expression: ${POST_EXTRACT_SRC.slice(0, 40)}`);
});

test('comment extractor source has no unsubstituted placeholders', () => {
  assert.ok(!COMMENT_EXTRACT_SRC.includes('PLACEHOLDER'));
});

test('neither extractor contains a mutating DOM call', () => {
  for (const src of [POST_EXTRACT_SRC, COMMENT_EXTRACT_SRC]) {
    for (const forbidden of ['.click(', '.submit(', 'innerHTML =', '.remove(']) {
      assert.ok(!src.includes(forbidden), `extractor must not mutate the page: found ${forbidden}`);
    }
  }
});

test('the post root is found by ARIA, never by innerText action words', () => {
  // The innerText rule matched nothing on the live DOM and returned zero posts.
  assert.ok(!/\\b\(Comment\|Like\|Share\)\\b/.test(POST_EXTRACT_SRC),
    'the dead innerText action regex must not come back');
  assert.ok(POST_EXTRACT_SRC.includes('omment'),
    'expected the action bar to be matched by aria-label');
});

test('the author anchor is chosen by href shape, not document order', () => {
  // The first a[aria-label] in a post is sometimes the "Hide post by X" control.
  assert.ok(!/querySelector\('a\[aria-label\]'\)[^;]*authorLink/.test(POST_EXTRACT_SRC),
    'author must not be the first aria-labelled anchor');
  // The member-link rule is a regex literal, so it stringifies with escaped slashes.
  assert.ok(POST_EXTRACT_SRC.includes('\\/user\\/'),
    'expected the group-scoped member link to be preferred when present');
});
