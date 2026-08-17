import assert from 'node:assert/strict';
import test from 'node:test';
import { composerAccepted, composerSource, composerText } from '../src/chatgpt.js';

test('reads a textarea composer from value rather than empty innerText', () => {
  assert.equal(composerText({ value: 'MCP_OK', innerText: '', textContent: '' }), 'MCP_OK');
});

test('reads the contenteditable composer from innerText', () => {
  assert.equal(composerText({ innerText: 'MCP_OK', textContent: 'fallback' }), 'MCP_OK');
});

test('falls back to textContent for another editable DOM shape', () => {
  assert.equal(composerText({ textContent: 'MCP_OK' }), 'MCP_OK');
});

test('names the field the echo was read from', () => {
  assert.equal(composerSource({ value: '', innerText: 'x' }), 'value');
  assert.equal(composerSource({ innerText: 'x', textContent: 'x' }), 'innerText');
  assert.equal(composerSource({ textContent: 'x' }), 'textContent');
  assert.equal(composerSource({}), 'none');
});

test('accepts a multi-line question the composer echoed back as paragraphs', () => {
  // ProseMirror splits each line into its own <p>, and innerText puts a blank
  // line between them. Exact-string equality read that successful fill as a
  // rejection and reported "the composer never accepted the question".
  const wanted = 'Line one\nLine two\nLine three';
  assert.ok(composerAccepted('Line one\n\nLine two\n\nLine three', wanted));
});

test('accepts an echo padded with the whitespace the editor adds', () => {
  assert.ok(composerAccepted(' Ask me this\n', 'Ask me this'));
});

test('rejects an empty composer', () => {
  assert.equal(composerAccepted('', 'Ask me this'), false);
  assert.equal(composerAccepted('   \n  ', 'Ask me this'), false);
});

test('rejects a truncated insert, which is what the check exists to catch', () => {
  const wanted = 'Summarise the attached quarterly report in three bullets';
  assert.equal(composerAccepted('Summarise the attached quarterly', wanted), false);
});

test('rejects a stale echo left over from a previous question', () => {
  assert.equal(composerAccepted('What is the capital of France?', 'Ask me this'), false);
});
