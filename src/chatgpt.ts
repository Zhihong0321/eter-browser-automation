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
 * Ask one question, get one answer.
 *
 * Runs on the working tab of the `openai` profile's Chrome, so it must be
 * called through BrowserManager.run() — that queue is what stops two questions
 * from driving the same tab at once.
 */
export async function askChatGpt(page: Page, question: string, timeoutMs = 180_000): Promise<ChatGptAnswer> {
  const fail = (error: string, ms = 0): ChatGptAnswer => ({ ok: false, text: '', ms, error });

  await page.goto(TEMP_CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  try {
    await page.waitForSelector(COMPOSER, { timeout: 60_000 });
  } catch {
    return fail('ChatGPT is not signed in on the "openai" profile — a human must log in.');
  }
  await dismissUpsell(page);

  // The temporary-chat splash overlays the composer, so a real click is refused
  // even though the element is visible and enabled. Focus it directly instead.
  // Then make the composer echo the text back: without this check a silently
  // dropped insert leads to pressing Enter on an empty box and waiting out the
  // full timeout on an answer that was never requested.
  const probe = question.slice(0, 24);
  let typed = false;
  for (let attempt = 0; attempt < 4 && !typed; attempt++) {
    await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement | null)?.focus(), COMPOSER);
    await page.keyboard.insertText(question);
    await page.waitForTimeout(400);
    const echo = await page.evaluate(
      (sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText.trim() ?? '',
      COMPOSER,
    );
    typed = echo.includes(probe);
    if (!typed) await page.waitForTimeout(800);
  }
  if (!typed) return fail('The composer never accepted the question — nothing was sent.');

  const started = Date.now();
  await page.keyboard.press('Enter');

  // Enter is not proof of submission either. Wait for the app to render our own
  // message back before believing a question is in flight.
  try {
    await page.waitForFunction(
      (p) =>
        [...document.querySelectorAll('[data-message-author-role="user"]')].some((n) =>
          (n as HTMLElement).innerText.includes(p),
        ),
      probe,
      { timeout: 15_000 },
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

  while (Date.now() - started < timeoutMs) {
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
    `No settled answer within ${Math.round(timeoutMs / 1000)}s.` +
      (text ? ' A partial reply was on screen and has been discarded rather than returned as complete.' : ''),
    Date.now() - started,
  );
}
