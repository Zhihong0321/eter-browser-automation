// src/chatgpt.ts
//
// A free text-in / text-out reasoning engine, driven through the signed-in
// ChatGPT web UI rather than an API key.
//
// This is deliberately NOT an API shim. The web UI gives you a chat box: no
// system prompt, no temperature, no roles, no token counts. Exposing it as
// /v1/chat/completions would mean faking all of those, so callers would ask for
// guarantees that do not exist. One question in, one answer out, and nothing
// else is promised.
//
// Every call runs in a TEMPORARY chat, which buys three things at once:
//   - ChatGPT memory is neither read nor written, so call N cannot contaminate
//     call N+1 (verified: a follow-up asking about the previous message answers
//     "NO MEMORY").
//   - Nothing lands in the sidebar, so there is no thread cleanup to run and no
//     history to leak between unrelated jobs.
//   - Each call is a fresh mind. That makes this stateless by construction:
//     there are no follow-ups. A caller that needs context must put the context
//     in the question.

import type { Page } from 'patchright';

/** The enrolled Chrome profile holding the ChatGPT login. Its own Chrome, its own failure domain. */
export const CHATGPT_PROFILE = 'openai';

/**
 * Deep link straight into a temporary chat. Cheaper and far more reliable than
 * clicking "New chat": that control renders TWICE (collapsed + expanded
 * sidebar), so a click is ambiguous and gets intercepted by whatever overlay is
 * up.
 */
const TEMP_CHAT_URL = 'https://chatgpt.com/?temporary-chat=true';

const COMPOSER = '#prompt-textarea';
const STOP_BUTTON = 'button[data-testid="stop-button"], button[aria-label*="Stop answering" i]';
const UPSELL_MODAL = '#modal-account-payment, [data-testid="modal-account-payment"]';

export interface ChatGptAnswer {
  ok: boolean;
  /** The model's reply. Empty when ok is false. */
  text: string;
  /** Wall time from pressing Enter to a settled answer. */
  ms: number;
  /** Present only when ok is false. Never returned alongside a partial answer. */
  error?: string;
}

interface ComposerShape {
  value?: string;
  innerText?: string;
  textContent?: string;
}

/**
 * ChatGPT has shipped both a contenteditable composer and a textarea. Reading
 * only innerText makes a perfectly successful textarea fill look empty.
 */
export function composerText(shape: ComposerShape): string {
  return shape.value ?? shape.innerText ?? shape.textContent ?? '';
}

/** Which DOM field the echo came from \u2014 the first thing to know when an echo looks empty. */
export function composerSource(shape: ComposerShape): string {
  if (shape.value !== undefined) return 'value';
  if (shape.innerText !== undefined) return 'innerText';
  if (shape.textContent !== undefined) return 'textContent';
  return 'none';
}

/**
 * Did the composer take the question? The box is a rich-text editor, so its echo
 * is not required to be byte-identical to the input: ProseMirror may split a
 * multi-line question into separate paragraphs, and reading those back through
 * innerText yields a blank line where a single newline went in. Comparing exact
 * strings calls that successful fill a failure \u2014 which is how a multi-line
 * question ends up reported as "the composer never accepted the question" while
 * sitting in the box. Collapsing whitespace stays strong enough to catch what
 * actually matters, a dropped or truncated insert, because losing any WORD
 * changes the collapsed form.
 */
export function composerAccepted(observed: string, wanted: string): boolean {
  // \s covers the nbsp the composer substitutes for a leading space, so one pass does both jobs.
  const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();
  const echo = collapse(observed);
  return echo.length > 0 && echo === collapse(wanted);
}

/** Enough of the echo to diagnose a rejection, without pasting the payload into an error string. */
function preview(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}\u2026` : flat;
}

/**
 * The free-account upgrade modal covers the page and swallows every click,
 * including ones aimed at elements that are plainly visible underneath it.
 * It appears on its own schedule, so this runs before every send.
 */
async function dismissUpsell(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await page.$(UPSELL_MODAL))) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    if (!(await page.$(UPSELL_MODAL))) return;
    await page.evaluate((sel) => {
      const modal = document.querySelector(sel);
      if (!modal) return;
      const close = [...modal.querySelectorAll('button')].find((b) =>
        /close|dismiss|not now|maybe later/i.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`),
      );
      close?.click();
    }, UPSELL_MODAL);
    await page.waitForTimeout(500);
  }
}

/** The reply text, without the surrounding UI affordances. */
function readAnswer(page: Page): Promise<string> {
  return page.evaluate(() => {
    const node = [...document.querySelectorAll('[data-message-author-role="assistant"]')].pop();
    if (!node) return '';
    // Read the markdown body, not the message wrapper: the wrapper's innerText
    // picks up control labels ("Edit", "Copy") and prepends them to the answer.
    const body = node.querySelector('.markdown') ?? node;
    return (body as HTMLElement).innerText.trim();
  });
}

/**
 * Run `work` against a hard ceiling. Playwright's per-action timeouts do not
 * cover the keyboard fallback, and pushing a very large question into the
 * rich-text composer is slow enough to matter: measured, 12KB lands in about 10
 * seconds, 50KB takes a minute, and 150KB does not finish inside ten. Something
 * has to bound that phase or the whole call is unbounded.
 */
async function withBudget<T>(start: () => Promise<T>, ms: number, what: string): Promise<T> {
  const work = start();
  // Whichever side loses the race must not surface as an unhandled rejection.
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} ran past the remaining budget`)), Math.max(1, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask one question, get one answer.
 *
 * Runs on the working tab of the `openai` profile's Chrome, so it must be
 * called through BrowserManager.run() — that queue is what stops two questions
 * from driving the same tab at once.
 *
 * `timeoutMs` budgets the WHOLE call — page load, getting the question into the
 * composer, and waiting for the answer. It used to cover only the answer wait,
 * which left the input phase unbounded: a large enough question made this hang
 * for as long as the composer took, and an MCP caller waits on that forever
 * instead of getting an actionable ok:false.
 */
export async function askChatGpt(page: Page, question: string, timeoutMs = 180_000): Promise<ChatGptAnswer> {
  const callStarted = Date.now();
  const remaining = () => timeoutMs - (Date.now() - callStarted);
  const fail = (error: string, ms = 0): ChatGptAnswer => ({ ok: false, text: '', ms, error });
  const budgetSpent = () => `${Math.round((Date.now() - callStarted) / 1000)}s of the ${Math.round(timeoutMs / 1000)}s budget`;

  if (!question.trim()) return fail('The question is empty — nothing was sent.');

  await page.goto(TEMP_CHAT_URL, {
    waitUntil: 'domcontentloaded',
    timeout: Math.max(1, Math.min(60_000, remaining())),
  });
  try {
    await page.waitForSelector(COMPOSER, { state: 'visible', timeout: Math.max(1, Math.min(60_000, remaining())) });
  } catch {
    return fail('ChatGPT is not signed in on the "openai" profile — a human must log in.');
  }
  await dismissUpsell(page);

  // The temporary-chat splash overlays the composer, so a real click is refused
  // even though the element is visible and enabled. Focus it directly instead.
  // Then make the composer echo the text back: without this check a silently
  // dropped insert leads to pressing Enter on an empty box and waiting out the
  // full timeout on an answer that was never requested.
  const composer = page.locator(COMPOSER);
  let typed = false;
  let observed = '';
  let source = 'none';
  let attempts = 0;
  let stalled = false;
  let previousEcho: string | null = null;

  const writeStarted = Date.now();
  while (attempts < 4 && !typed && remaining() > 0) {
    attempts++;
    // fill() supports both textarea/input and contenteditable and dispatches the
    // input event React/ProseMirror needs. `force` bypasses the temporary-chat
    // splash which may visually cover an otherwise usable composer.
    try {
      await composer.fill(question, { force: true, timeout: 5_000 });
    } catch {
      // Keep a keyboard fallback for UI variants that reject fill(). Clear first
      // so a partial failed attempt can never be prefixed to the next one. This
      // is the slow path for a large question, so it runs on the call's budget.
      await withBudget(async () => {
        await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement | null)?.focus(), COMPOSER);
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        await page.keyboard.insertText(question);
      }, remaining(), 'the keyboard insert').catch(() => {
        // Fall through to the echo check: it reports what the box actually holds,
        // which is more use than "the insert timed out".
      });
    }
    await page.waitForTimeout(400);
    const shape = await composer.evaluate((el) => ({
      value: 'value' in el ? String((el as HTMLInputElement | HTMLTextAreaElement).value ?? '') : undefined,
      innerText: (el as HTMLElement).innerText,
      textContent: el.textContent ?? undefined,
    }));
    observed = composerText(shape);
    source = composerSource(shape);
    typed = composerAccepted(observed, question);
    if (typed) break;

    // The retry only pays off against a transient overlay or a dropped insert. A
    // second identical echo means the box is doing the same thing every time, so
    // the remaining attempts buy nothing but wall clock — which is how a
    // guaranteed failure used to take the better part of a minute to report.
    if (previousEcho === observed) {
      stalled = true;
      break;
    }
    previousEcho = observed;

    await composer.fill('', { force: true, timeout: 5_000 }).catch(async () => {
      await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement | null)?.focus(), COMPOSER);
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
    });
    await page.waitForTimeout(800);
  }
  if (!typed) {
    // Say what was seen. "The composer never accepted the question" alone cannot
    // distinguish a box that stayed empty from one that took the text in a shape
    // the check refused, and those need opposite fixes.
    const ranOut = remaining() <= 0;
    return fail(
      `The composer never accepted the question — nothing was sent. ` +
        `Sent ${question.length} chars, composer "${COMPOSER}" held ${observed.length} ` +
        `(read from ${source}) after ${attempts} attempt${attempts === 1 ? '' : 's'} ` +
        `over ${Math.round((Date.now() - writeStarted) / 1000)}s` +
        `${stalled ? ', stopped early on an unchanging echo' : ''}` +
        `${ranOut ? `, and the call ran out of budget mid-write — a question this size may simply be too big to type` : ''}. ` +
        `Composer showed: ${JSON.stringify(preview(observed))}`,
      Date.now() - callStarted,
    );
  }

  const started = Date.now();
  await composer.press('Enter');

  // Enter is not proof of submission either. Wait for the app to render our own
  // message back before believing a question is in flight.
  try {
    await page.waitForFunction(
      (p) =>
        [...document.querySelectorAll('[data-message-author-role="user"]')].some((n) =>
          (n as HTMLElement).innerText.includes(p),
        ),
      question.slice(0, 24),
      { timeout: Math.max(1, Math.min(15_000, remaining())) },
    );
  } catch {
    return fail('Pressed Enter but the question never appeared in the thread — treat as NOT sent.', Date.now() - started);
  }

  // Streaming state is read by RE-QUERYING the stop button every poll. Watching
  // one node for detachment does not work: React swaps that node mid-stream, so
  // a detach wait fires early and returns a truncated answer that looks whole.
  // A truncated answer that reports success is the worst failure this can have,
  // so ending the wait needs the stop control gone AND the text settled.
  let sawStream = false;
  let quiet = 0;
  let text = '';
  let previous: string | null = null;

  // On the call's budget, not a fresh one: getting the question in has already
  // spent part of it, and a call that reports its own deadline must honour it.
  while (remaining() > 0) {
    const streaming = await page.evaluate((sel) => !!document.querySelector(sel), STOP_BUTTON);
    text = await readAnswer(page);

    if (streaming) {
      sawStream = true;
      quiet = 0;
    } else if (sawStream || text) {
      quiet++;
    }

    if (quiet >= 5 && text && text === previous) {
      return { ok: true, text, ms: Date.now() - started };
    }
    previous = text;
    await page.waitForTimeout(250);
  }

  return fail(
    `No settled answer: spent ${budgetSpent()}, ${Math.round((Date.now() - started) / 1000)}s of it waiting on the reply.` +
      (text ? ' A partial reply was on screen and has been discarded rather than returned as complete.' : ''),
    Date.now() - started,
  );
}
