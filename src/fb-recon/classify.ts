/**
 * Intent classification for gate survivors.
 *
 * Two rules shape everything here.
 *
 * BATCH. One model call per post turns a 300-post sweep into the most expensive
 * part of the feature by an order of magnitude. Twenty posts per call costs
 * almost the same as one.
 *
 * FAIL OPEN. Every failure path — no endpoint configured, HTTP error, garbage
 * response, an item the model forgot — keeps the item. A classifier that drops
 * leads when it breaks is worse than no classifier, because the failure is
 * invisible: you get a shorter list and no reason to distrust it.
 */
import { FBRECON_LLM_KEY, FBRECON_LLM_MODEL, FBRECON_LLM_URL } from '../config.js';
import type { Intent } from './store.js';

export interface ClassifyItem {
  id: string;
  text: string;
}

export interface Verdict {
  id: string;
  interested: boolean;
  intent: Intent;
  why: string;
}

export interface Classifier {
  classify(topic: string, items: ClassifyItem[]): Promise<Verdict[]>;
}

export interface LlmConfig {
  url: string;
  key: string;
  model: string;
  batchSize?: number;
}

const VALID_INTENTS: readonly Intent[] = ['buying', 'researching', 'seller', 'none'];
const DEFAULT_BATCH = 20;
/** Long enough to carry intent, short enough that 20 fit comfortably in one call. */
const MAX_TEXT = 600;

function keep(item: ClassifyItem, why: string): Verdict {
  return { id: item.id, interested: true, intent: 'researching', why };
}

export const passThroughClassifier: Classifier = {
  async classify(_topic: string, items: ClassifyItem[]): Promise<Verdict[]> {
    return items.map((i) => keep(i, 'no classifier configured; kept on regex score'));
  },
};

/**
 * Tolerant parse. Models wrap JSON in fences, prepend prose, and occasionally
 * invent an enum value. None of that is worth losing a batch over.
 */
export function parseVerdicts(raw: string, items: ClassifyItem[]): Verdict[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const found = new Map<string, Verdict>();

  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
      if (Array.isArray(parsed)) {
        for (const row of parsed) {
          const r = row as { id?: unknown; interested?: unknown; intent?: unknown; why?: unknown };
          const id = typeof r.id === 'string' ? r.id : '';
          if (!byId.has(id)) continue; // ignore ids we never sent
          const intent = VALID_INTENTS.includes(r.intent as Intent) ? (r.intent as Intent) : 'researching';
          found.set(id, {
            id,
            interested: r.interested !== false,
            intent,
            why: typeof r.why === 'string' ? r.why.slice(0, 200) : '',
          });
        }
      }
    } catch {
      // Fall through to the keep-everything path below.
    }
  }

  return items.map((i) => found.get(i.id) ?? keep(i, 'classifier gave no verdict for this item'));
}

function prompt(topic: string, items: ClassifyItem[]): string {
  return [
    `You are screening Facebook posts and comments to find people who might BUY ${topic}.`,
    '',
    'For each item decide:',
    `- interested: true if this person could plausibly become a customer for ${topic}.`,
    '- intent: "buying" (asking price, quotes, ready to install), "researching" (curious,',
    '  comparing, asking opinions), "seller" (a vendor, installer, agent or recruiter —',
    '  NOT a customer), or "none" (unrelated).',
    '- why: at most 12 words.',
    '',
    'Posts may mix English and Malay. "berapa harga", "nak pasang", "berbaloi tak" are',
    'buying signals. A company advertising its own service is a seller, not a lead.',
    '',
    'Reply with ONLY a JSON array, one object per item, using the ids given:',
    '[{"id":"...","interested":true,"intent":"buying","why":"..."}]',
    '',
    ...items.map((i) => `--- id: ${i.id}\n${i.text.slice(0, MAX_TEXT)}`),
  ].join('\n');
}

export function llmClassifier(cfg: LlmConfig): Classifier {
  const batchSize = cfg.batchSize ?? DEFAULT_BATCH;

  return {
    async classify(topic: string, items: ClassifyItem[]): Promise<Verdict[]> {
      const out: Verdict[] = [];

      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        try {
          const res = await fetch(cfg.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}),
            },
            body: JSON.stringify({
              model: cfg.model,
              temperature: 0,
              messages: [{ role: 'user', content: prompt(topic, batch) }],
            }),
          });

          if (!res.ok) {
            out.push(...batch.map((it) => keep(it, `classifier HTTP ${res.status}`)));
            continue;
          }

          const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
          const raw = data.choices?.[0]?.message?.content ?? '';
          out.push(...parseVerdicts(raw, batch));
        } catch (err) {
          out.push(...batch.map((it) => keep(it, `classifier unreachable: ${(err as Error).message}`)));
        }
      }

      return out;
    },
  };
}

/** Configured endpoint if there is one, otherwise the honest no-op. */
export function defaultClassifier(): Classifier {
  if (!FBRECON_LLM_URL || !FBRECON_LLM_MODEL) return passThroughClassifier;
  return llmClassifier({ url: FBRECON_LLM_URL, key: FBRECON_LLM_KEY, model: FBRECON_LLM_MODEL });
}
