import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isAllowedClick } from '../src/fb-recon/browser.js';

test('expansion controls are allowed', () => {
  for (const name of ['See more', 'see more', 'View more comments', 'View 12 more comments',
                      'View previous comments', 'Next', 'Previous', 'See More']) {
    assert.equal(isAllowedClick(name), true, `should allow: ${name}`);
  }
});

test('every interaction control is refused', () => {
  for (const name of ['Like', 'Comment', 'Share', 'Send', 'Post', 'Reply', 'Follow',
                      'Add friend', 'Join group', 'Message', 'Write a comment',
                      'Leave a comment', 'Send message', 'Submit']) {
    assert.equal(isAllowedClick(name), false, `MUST refuse: ${name}`);
  }
});

test('an interaction control is refused even when it contains an allowed word', () => {
  // "Comment" contains no allowed token, but "See more comments to reply" would
  // sneak past a naive substring rule. The allowlist must be anchored.
  assert.equal(isAllowedClick('Reply to see more'), false);
  assert.equal(isAllowedClick('Comment to view more comments'), false);
});

test('empty and whitespace names are refused', () => {
  assert.equal(isAllowedClick(''), false);
  assert.equal(isAllowedClick('   '), false);
});
