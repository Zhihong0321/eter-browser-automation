import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { passThroughClassifier, parseVerdicts, type ClassifyItem } from '../src/fb-recon/classify.js';

const ITEMS: ClassifyItem[] = [
  { id: 'a', text: 'berapa harga solar untuk rumah?' },
  { id: 'b', text: 'we supply solar, dealer wanted' },
];

test('pass-through labels nothing but keeps everything', async () => {
  const out = await passThroughClassifier.classify('solar', ITEMS);
  assert.equal(out.length, 2, 'no classifier must still return every item');
  assert.ok(out.every((v) => v.intent === 'none'));
});

test('parseVerdicts reads a clean JSON array', () => {
  const raw = '[{"id":"a","type":"buyer","why":"asks price"},{"id":"b","type":"seller","why":"vendor"}]';
  const out = parseVerdicts(raw, ITEMS);
  assert.equal(out.length, 2);
  assert.equal(out[0].intent, 'buyer');
  assert.equal(out[1].intent, 'seller');
});

test('an owner is distinguished from a buyer', () => {
  const raw = '[{"id":"a","type":"owner","why":"complains about their own panels"}]';
  assert.equal(parseVerdicts(raw, ITEMS)[0].intent, 'owner');
});

test('the older "intent" key is still accepted', () => {
  const raw = '[{"id":"a","intent":"buyer","why":"x"}]';
  assert.equal(parseVerdicts(raw, ITEMS)[0].intent, 'buyer');
});

test('parseVerdicts survives a fenced code block wrapper', () => {
  const raw = '```json\n[{"id":"a","type":"buyer","why":"x"}]\n```';
  assert.equal(parseVerdicts(raw, ITEMS)[0].intent, 'buyer');
});

test('parseVerdicts survives prose before and after the array', () => {
  const raw = 'Here you go:\n[{"id":"a","type":"buyer","why":"x"}]\nHope that helps!';
  assert.equal(parseVerdicts(raw, ITEMS).length, 2);
});

test('an unparseable response still returns every item, unlabelled', () => {
  const out = parseVerdicts('the model apologised instead of answering', ITEMS);
  assert.equal(out.length, 2, 'a broken classifier must not silently delete people');
  assert.ok(out.every((v) => v.intent === 'none'));
});

test('an unrecognised type is coerced to none rather than thrown', () => {
  const raw = '[{"id":"a","type":"very-hot","why":"x"}]';
  assert.equal(parseVerdicts(raw, ITEMS)[0].intent, 'none');
});

test('verdicts for ids we never sent are discarded', () => {
  const raw = '[{"id":"zzz","type":"buyer","why":"hallucinated"}]';
  assert.ok(!parseVerdicts(raw, ITEMS).some((v) => v.id === 'zzz'));
});

test('an item the model omitted is kept, not dropped', () => {
  const raw = '[{"id":"a","type":"buyer","why":"x"}]';
  const b = parseVerdicts(raw, ITEMS).find((v) => v.id === 'b');
  assert.ok(b, 'omitted item must still appear');
  assert.equal(b!.intent, 'none');
});
