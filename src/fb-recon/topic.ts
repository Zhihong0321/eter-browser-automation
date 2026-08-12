/**
 * The topic pack: what "interested in X" means, as data rather than code.
 *
 * The gate has to answer two different questions and they are not the same
 * one. "Is this post about solar?" is easy and nearly useless on its own — a
 * competitor posting their install portfolio matches every topic keyword and is
 * worth nothing. "Does this person want to buy?" is the signal that pays, and
 * in this market it is often not in English: "berapa harga", "nak pasang",
 * "worth it tak". So intent phrases are weighted far above topic keywords, and
 * negative terms exist purely to push sellers and recruiters back under the
 * gate.
 *
 * This scorer is a PREFILTER, tuned for recall. Letting a seller through costs
 * one classifier call. Dropping a real buyer costs a lead, and nothing
 * downstream can recover them. When in doubt it lets the post through.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface TopicPack {
  topic: string;
  /** Subject-matter terms. Cheap, weak signal. */
  include: string[];
  /** Buying-intent phrases. The signal that actually matters. */
  intent: string[];
  /** Seller / recruiter / promo language. Disqualifying. */
  negative: string[];
  generatedAt: string;
}

export interface TopicScore {
  score: number;
  hits: { include: string[]; intent: string[]; negative: string[] };
}

/** One intent phrase, or three topic keywords, clears the gate. */
export const DEFAULT_MIN_SCORE = 3;

const W_INCLUDE = 1;
const W_INTENT = 3;
const W_NEGATIVE = -5;

/** Cap per bucket so one keyword-stuffed post cannot outrank a real question. */
const CAP_INCLUDE = 3;
const CAP_INTENT = 9;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Boundary-aware, case-insensitive containment.
 *
 * A bare `includes()` matches "nem" inside "phenomenal" and quietly poisons
 * every score. \b does not work for multi-word phrases with punctuation, so the
 * boundary is asserted with lookarounds against the word characters themselves.
 */
function contains(haystack: string, needle: string): boolean {
  if (!needle.trim()) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(needle)}(?![\\p{L}\\p{N}])`, 'iu').test(haystack);
}

/** Deduplicated by construction: each term is tested once, so repeats cannot inflate. */
export function scoreText(pack: TopicPack, text: string): TopicScore {
  const body = (text ?? '').replace(/\s+/g, ' ');
  const hits = {
    include: pack.include.filter((t) => contains(body, t)),
    intent: pack.intent.filter((t) => contains(body, t)),
    negative: pack.negative.filter((t) => contains(body, t)),
  };

  const score =
    Math.min(hits.include.length * W_INCLUDE, CAP_INCLUDE) +
    Math.min(hits.intent.length * W_INTENT, CAP_INTENT) +
    hits.negative.length * W_NEGATIVE;

  return { score: Math.max(0, score), hits };
}

/** Topic names reach us from a CLI flag, so they are untrusted path input. */
export function slug(topic: string): string {
  const s = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'topic';
}

export function packPath(dir: string, topic: string): string {
  return path.join(dir, `${slug(topic)}.json`);
}

export function loadPack(dir: string, topic: string): TopicPack | null {
  try {
    return JSON.parse(fs.readFileSync(packPath(dir, topic), 'utf8')) as TopicPack;
  } catch {
    return null;
  }
}

export function savePack(dir: string, pack: TopicPack): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(packPath(dir, pack.topic), JSON.stringify(pack, null, 2));
}

/**
 * The pack you get before anyone has tuned it. Intent phrases are
 * topic-independent on purpose — "how much", "berapa harga" and "recommend"
 * signal buying regardless of what is being bought — so a fresh topic is
 * usable immediately and gets better the moment a human edits the file.
 */
export function starterPack(topic: string): TopicPack {
  return {
    topic,
    include: [topic],
    intent: [
      'how much',
      'berapa harga',
      'berapa kos',
      'nak pasang',
      'nak beli',
      'looking for',
      'recommend',
      'any recommendation',
      'quotation',
      'quote',
      'worth it',
      'berbaloi',
      'anyone know',
      'sesiapa tahu',
      'best price',
      'pm me price',
      'dm me',
    ],
    negative: [
      'we supply',
      'we provide',
      'dealer wanted',
      'agent wanted',
      'jawatan kosong',
      'hiring',
      'now hiring',
      'promo',
      'promotion',
      'whatsapp us',
      'contact us today',
      'free consultation',
    ],
    generatedAt: new Date().toISOString(),
  };
}
