import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scoreText, loadPack, savePack, starterPack, DEFAULT_MIN_SCORE, type TopicPack } from '../src/fb-recon/topic.js';

const PACK: TopicPack = {
  topic: 'solar',
  include: ['solar', 'solar panel', 'nem', 'tnb'],
  intent: ['berapa harga', 'nak pasang', 'how much', 'recommend', 'quotation'],
  negative: ['we supply', 'dealer wanted', 'jawatan kosong', 'hiring'],
  generatedAt: '2026-08-12T00:00:00.000Z',
};

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fbrecon-topic-'));
}

test('a buying question in Malay scores above the gate', () => {
  const s = scoreText(PACK, 'Berapa harga solar untuk rumah teres? Nak pasang tahun ni.');
  assert.ok(s.score >= DEFAULT_MIN_SCORE, `expected pass, got ${s.score}`);
  assert.deepEqual(s.hits.intent.sort(), ['berapa harga', 'nak pasang']);
});

test('a buying question in English scores above the gate', () => {
  const s = scoreText(PACK, 'Anyone can recommend a solar installer? How much for 6kW?');
  assert.ok(s.score >= DEFAULT_MIN_SCORE, `expected pass, got ${s.score}`);
});

test('a seller post is pushed below the gate by negative terms', () => {
  const s = scoreText(PACK, 'We supply solar panel and full NEM package, dealer wanted nationwide!');
  assert.ok(s.score < DEFAULT_MIN_SCORE, `expected reject, got ${s.score}`);
  assert.ok(s.hits.negative.length > 0);
});

test('an off-topic post scores zero', () => {
  assert.equal(scoreText(PACK, 'Selling my old Myvi, still good condition').score, 0);
});

test('matching is case-insensitive and ignores repeated hits of the same term', () => {
  const once = scoreText(PACK, 'solar');
  const thrice = scoreText(PACK, 'SOLAR solar Solar');
  assert.equal(once.score, thrice.score, 'repeating a keyword must not inflate the score');
});

test('substring collisions do not count as hits', () => {
  // "nem" must not match inside "phenomenal".
  assert.equal(scoreText(PACK, 'a phenomenal day').score, 0);
});

test('savePack then loadPack round-trips', () => {
  const dir = tmpDir();
  savePack(dir, PACK);
  assert.deepEqual(loadPack(dir, 'solar'), PACK);
});

test('loadPack returns null for a topic with no pack', () => {
  assert.equal(loadPack(tmpDir(), 'nonexistent'), null);
});

test('topic names are slugged so they cannot escape the pack directory', () => {
  const dir = tmpDir();
  const evil = { ...starterPack('../../etc/passwd'), topic: '../../etc/passwd' };
  savePack(dir, evil);
  const written = fs.readdirSync(dir);
  assert.equal(written.length, 1);
  assert.ok(!written[0].includes('..'), `slug leaked traversal: ${written[0]}`);
});

test('starterPack always includes the topic itself as a keyword', () => {
  assert.ok(starterPack('solar').include.includes('solar'));
});
