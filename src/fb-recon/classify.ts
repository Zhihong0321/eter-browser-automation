/**
 * Who is this person? Group Recon's only question.
 *
 * This LABELS, it does not select. Every message collected in the sweep is
 * recorded with its sender no matter what comes back from here — the type is a
 * column, not a gate. That is the whole difference from the old design, where a
 * classifier verdict could delete someone before you ever saw them.
 *
 * Two rules shape the rest.
 *
 * BATCH. One model call per post turns a 300-post sweep into the most expensive
 * part of the feature by an order of magnitude. Twenty posts per call costs
 * almost the same as one.
 *
 * FAIL SOFT. Every failure path — no endpoint configured, HTTP error, garbage
 * response, an item the model forgot — yields `none`, which means "could not
 * tell", and the person is still recorded. An unlabelled row you can read is
 * worth infinitely more than a row that was quietly removed.
 */
import { fbReconLlm } from '../config.js';
import type { Intent } from './store.js';

export interface ClassifyItem {
  id: string;
  text: string;
}

export interface Verdict {
  id: string;
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
  /** Per-batch ceiling. Measured 2026-08-13: a 20-item batch took ~4 minutes. */
  timeoutMs?: number;
}

const VALID_INTENTS: readonly Intent[] = ['seller', 'owner', 'buyer', 'none'];
const DEFAULT_BATCH = 20;
/**
 * Generous, because being slow is normal and losing labels is not — but finite,
 * because the sweep cannot finish until this returns.
 */
const DEFAULT_TIMEOUT_MS = 300_000;
/** Long enough to carry intent, short enough that 20 fit comfortably in one call. */
const MAX_TEXT = 600;

/** Recorded, but honestly unlabelled. Never silently invents a type. */
function unknown(item: ClassifyItem, why: string): Verdict {
  return { id: item.id, intent: 'none', why };
}

export const passThroughClassifier: Classifier = {
  async classify(_topic: string, items: ClassifyItem[]): Promise<Verdict[]> {
    return items.map((i) => unknown(i, 'no classifier configured — set FBRECON_LLM_URL/MODEL to get types'));
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
          const r = row as { id?: unknown; type?: unknown; intent?: unknown; why?: unknown };
          const id = typeof r.id === 'string' ? r.id : '';
          if (!byId.has(id)) continue; // ignore ids we never sent
          const raw = (r.type ?? r.intent) as Intent;
          found.set(id, {
            id,
            intent: VALID_INTENTS.includes(raw) ? raw : 'none',
            why: typeof r.why === 'string' ? r.why.slice(0, 200) : '',
          });
        }
      }
    } catch {
      // Fall through to the keep-everything path below.
    }
  }

  return items.map((i) => found.get(i.id) ?? unknown(i, 'classifier gave no verdict for this item'));
}

/**
 * The three types, defined by what the message DOES rather than what it is
 * about. "Is this about solar?" is the wrong question in a solar group — every
 * message is. "Is this person selling, using, or shopping?" is the one that
 * decides whether you open Messenger.
 */
function prompt(topic: string, items: ClassifyItem[]): string {
  return [
    `These are messages from a Facebook group about ${topic}.`,
    'Everyone in the group is one of exactly three types. Label each message by',
    'what its SENDER is doing:',
    '',
    '- "seller"  — trying to sell. Pitching, displaying a product or price list,',
    '              showing off a job they installed for a customer, posting',
    '              promotions, or asking people to PM/WhatsApp/contact them.',
    '- "owner"   — already bought it. Asking how to use or maintain theirs,',
    '              complaining about performance, a bill, or an installer, or',
    '              showing off what they own.',
    '- "buyer"   — has not bought yet. Mostly asking questions: prices, whether it',
    '              is worth it, which brand, who to hire, is my situation suitable.',
    '- "none"    — genuinely cannot tell, or the message is off-topic chatter.',
    '',
    'The hard one is seller vs owner: both post photos of an installation. If the',
    'sender did the work FOR someone, they are a seller. If it is on their own',
    'roof and they are living with it, they are an owner.',
    'The other hard one is owner vs buyer: an owner asking about a SECOND system',
    'is a buyer. Complaining about the one they have is an owner.',
    '',
    'Messages mix English, Malay and Chinese. "berapa harga", "nak pasang",',
    '"berbaloi tak", "多少钱", "值得吗" are buyer questions. "PM for quote",',
    '"WhatsApp us", "dealer wanted" are sellers.',
    '',
    'Reply with ONLY a JSON array, one object per item, using the ids given.',
    'why: at most 12 words.',
    '[{"id":"...","type":"buyer","why":"..."}]',
    '',
    ...items.map((i) => `--- id: ${i.id}\n${i.text.slice(0, MAX_TEXT)}`),
  ].join('\n');
}

export function llmClassifier(cfg: LlmConfig): Classifier {
  const batchSize = cfg.batchSize ?? DEFAULT_BATCH;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async classify(topic: string, items: ClassifyItem[]): Promise<Verdict[]> {
      const out: Verdict[] = [];

      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const started = Date.now();
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
            // Without this a stuck endpoint hangs the ENTIRE sweep — measured
            // 2026-08-13, a batch sat in fetch for 7+ minutes while the same
            // request from another process answered in 3 seconds, and the
            // project stayed "running" with no way to tell what it was doing.
            // Labels are optional; hanging the harvest to wait for them is not.
            signal: AbortSignal.timeout(timeoutMs),
          });

          if (!res.ok) {
            out.push(...batch.map((it) => unknown(it, `classifier HTTP ${res.status}`)));
            console.error(`[fb-recon] classify batch ${i / batchSize + 1}: HTTP ${res.status} in ${Date.now() - started}ms`);
            continue;
          }

          const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
          const raw = data.choices?.[0]?.message?.content ?? '';
          out.push(...parseVerdicts(raw, batch));
          console.error(`[fb-recon] classify batch ${i / batchSize + 1}: ${batch.length} item(s) in ${Date.now() - started}ms`);
        } catch (err) {
          out.push(...batch.map((it) => unknown(it, `classifier unreachable: ${(err as Error).message}`)));
          console.error(`[fb-recon] classify batch ${i / batchSize + 1}: FAILED after ${Date.now() - started}ms — ${(err as Error).message}`);
        }
      }

      return out;
    },
  };
}

/** Configured endpoint if there is one, otherwise the honest no-op. */
export function defaultClassifier(): Classifier {
  const cfg = fbReconLlm();
  if (!cfg.url || !cfg.model) return passThroughClassifier;
  return llmClassifier(cfg);
}
