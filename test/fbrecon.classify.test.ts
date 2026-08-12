import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { passThroughClassifier, parseVerdicts, type ClassifyItem } from '../src/fb-recon/classify.js';

const ITEMS: ClassifyItem[] = [
  { id: 'a', text: 'berapa harga solar untuk rumah?' },
  { id: 'b', text: 'we supply solar, dealer wanted' },
];

test('pass-through marks every item interested with unknown intent', async () => {
  const out = await passThroughClassifier.classify('solar', ITEMS);
  assert.equal(out.length, 2);
  assert.ok(out.every((v) => v.interested));
  assert.ok(out.every((v) => v.intent === 'researching'));
});

test('parseVerdicts reads a clean JSON array', () => {
  const raw = '[{"id":"a","interested":true,"intent":"buying","why":"asks price"},{"id":"b","interested":false,"intent":"seller","why":"vendor"}]';
  const out = parseVerdicts(raw, ITEMS);
  assert.equal(out.length, 2);
  assert.equal(out[0].intent, 'buying');
  assert.equal(out[1].interested, false);
});

test('parseVerdicts survives a fenced code block wrapper', () => {
  const raw = '```json\n[{"id":"a","interested":true,"intent":"buying","why":"x"}]\n```';
  assert.equal(parseVerdicts(raw, ITEMS)[0].intent, 'buying');
});

test('parseVerdicts survives prose before and after the array', () => {
  const raw = 'Here you go:\n[{"id":"a","interested":true,"intent":"buying","why":"x"}]\nHope that helps!';
  assert.equal(parseVerdicts(raw, ITEMS).length, 2);
});

test('an unparseable response falls back to keeping every item', () => {
  const out = parseVerdicts('the model apologised instead of answering', ITEMS);
  assert.equal(out.length, 2);
  assert.ok(out.every((v) => v.interested), 'a broken classifier must not silently delete leads');
});

test('an unrecognised intent value is coerced rather than thrown', () => {
  const raw = '[{"id":"a","interested":true,"intent":"very-hot","why":"x"}]';
  assert.equal(parseVerdicts(raw, ITEMS)[0].intent, 'researching');
});

test('verdicts for ids we never sent are discarded', () => {
  const raw = '[{"id":"zzz","interested":true,"intent":"buying","why":"hallucinated"}]';
  assert.ok(!parseVerdicts(raw, ITEMS).some((v) => v.id === 'zzz'));
});

test('an item the model omitted is kept, not dropped', () => {
  const raw = '[{"id":"a","interested":true,"intent":"buying","why":"x"}]';
  const out = parseVerdicts(raw, ITEMS);
  const b = out.find((v) => v.id === 'b');
  assert.ok(b, 'omitted item must still appear');
  assert.equal(b!.interested, true);
});
