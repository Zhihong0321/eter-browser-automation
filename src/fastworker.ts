/**
 * Fast worker — a small, cheap model for low-reasoning jobs.
 *
 * Configured entirely from the environment (see .env.example). Nothing about
 * where the key comes from belongs in this repo: it is read from process.env,
 * and .env is gitignored. If it is not configured, every call fails with a
 * clear message rather than the engine crashing or silently degrading.
 *
 * MEASURED BEHAVIOUR of the model this was built against (step-3.7-flash via
 * api.stepfun.ai/step_plan). These are not guesses, they are why the code looks
 * like this:
 *
 *   - It ALWAYS reasons. `reasoning_effort: 'minimal'` and
 *     `enable_thinking: false` are both accepted and both ignored — the
 *     reasoning stream comes back regardless.
 *   - Reasoning length tracks question ambiguity: ~1,200 chars for an obvious
 *     call, ~7,200 for a debatable one.
 *   - So a ONE WORD answer costs 4–14s. It is not a sub-second classifier.
 *   - Below ~1,000 max_tokens the reasoning eats the whole budget and the
 *     content comes back EMPTY with finish_reason 'length'. Silent wrong
 *     answer, so there is a floor here and an explicit error.
 *   - `stop` sequences break it outright — they cut the reasoning stream and
 *     the content is empty. Never pass one.
 */

const MIN_MAX_TOKENS = 1500;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface FastWorkerConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** null when unconfigured — callers decide whether that is fatal. */
export function fastWorkerConfig(): FastWorkerConfig | null {
  const apiKey = process.env.FASTWORKER_API_KEY;
  const baseUrl = process.env.FASTWORKER_BASE_URL;
  const model = process.env.FASTWORKER_MODEL;
  if (!apiKey || !baseUrl || !model) return null;
  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, ''), model };
}

export function isFastWorkerReady(): boolean {
  return fastWorkerConfig() !== null;
}

export interface FastAskOptions {
  /** Keeps the answer to the requested token instead of a paragraph. */
  system?: string;
  /** Raised to the floor if lower — see the note about silent empty content. */
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface FastAnswer {
  text: string;
  ms: number;
  outputTokens: number;
  /** Length of the reasoning the model produced anyway. Useful for cost sanity. */
  reasoningChars: number;
}

const TERSE_SYSTEM = 'You are a fast classifier. Do not explain. Output only what is asked for, nothing else.';

/**
 * Ask the fast worker one question. Throws on anything that would otherwise
 * produce a plausible-looking empty answer.
 */
export async function fastAsk(prompt: string, opts: FastAskOptions = {}): Promise<FastAnswer> {
  const cfg = fastWorkerConfig();
  if (!cfg) {
    throw new Error(
      'Fast worker is not configured. Set FASTWORKER_API_KEY, FASTWORKER_BASE_URL and FASTWORKER_MODEL in .env (see .env.example).',
    );
  }

  const maxTokens = Math.max(opts.maxTokens ?? MIN_MAX_TOKENS, MIN_MAX_TOKENS);
  const timer = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timer]) : timer;

  const t0 = Date.now();
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: opts.system ?? TERSE_SYSTEM },
        { role: 'user', content: prompt },
      ],
      // Deliberately no `stop`: it truncates the reasoning stream and the
      // answer comes back empty.
    }),
  });

  const ms = Date.now() - t0;
  const body = (await res.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string; reasoning_content?: string; reasoning?: string }; finish_reason?: string }[];
    usage?: { completion_tokens?: number };
    error?: { message?: string };
  };

  if (!res.ok) {
    throw new Error(`Fast worker HTTP ${res.status}: ${body.error?.message ?? JSON.stringify(body).slice(0, 200)}`);
  }

  const choice = body.choices?.[0];
  const text = (choice?.message?.content ?? '').trim();
  const reasoningChars = (choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? '').length;

  if (!text) {
    // The failure mode that matters. An empty string here would flow onward as
    // a legitimate answer; it is not one.
    throw new Error(
      choice?.finish_reason === 'length'
        ? `Fast worker returned no answer: the reasoning consumed all ${maxTokens} tokens. Raise maxTokens.`
        : `Fast worker returned an empty answer (finish_reason: ${choice?.finish_reason ?? 'unknown'}).`,
    );
  }

  return { text, ms, outputTokens: body.usage?.completion_tokens ?? 0, reasoningChars };
}

/**
 * Ask for one of a fixed set of answers, and verify it actually came back.
 * A model that replies with something off-list is a failed call, not a result
 * to be pattern-matched into submission.
 */
export async function fastChoose<T extends string>(
  prompt: string,
  allowed: readonly T[],
  opts: FastAskOptions = {},
): Promise<{ choice: T; ms: number }> {
  const answer = await fastAsk(`${prompt}\n\nAnswer with exactly one of: ${allowed.join(', ')}`, opts);
  const first = answer.text.toUpperCase().match(/[A-Z_]+/)?.[0] ?? '';
  const hit = allowed.find((a) => a.toUpperCase() === first);
  if (!hit) {
    throw new Error(`Fast worker answered "${answer.text.slice(0, 60)}", which is not one of: ${allowed.join(', ')}`);
  }
  return { choice: hit, ms: answer.ms };
}
