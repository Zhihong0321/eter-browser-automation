import type { BrowserContext, Page } from 'patchright';
import { humanClick, humanType, pause, sleep } from './human.js';

/**
 * WhatsApp Web.
 *
 * Every selector below was confirmed against the live signed-in app (WhatsApp
 * Business, 2026-08-11). WhatsApp ships obfuscated class names that change per
 * build, so nothing here reads a class — only ARIA roles, `data-icon`,
 * `data-pre-plain-text` and `span[title]`, which have been stable for years.
 *
 * CONFIRMED DOM — do not re-derive this by hand, fix it here if it drifts:
 *
 *   signed in        #pane-side exists (the chat list pane).
 *   signed out       canvas[aria-label*="QR"] and [data-ref] exist, #pane-side does not.
 *                    The signed-out page has ZERO h1/h2/h3 elements and no password
 *                    field, and never leaves "/" — which is exactly why the generic
 *                    heuristics in probe.ts cannot see it and report `ready` on a QR
 *                    screen. That is what SITE_HINTS in probe.ts exists to fix.
 *   auth storage     No auth cookie at all. The only cookie is `wa_web_lang_pref`
 *                    (a language preference). Credentials are the Noise keypair in
 *                    localStorage plus the device record in IndexedDB, both of which
 *                    live in the persistent profile dir. Verified to survive a full
 *                    daemon kill, Chrome exit and relaunch.
 *   chat list row    #pane-side [role="row"]
 *                      span[title][0]                = chat name
 *                      span[title][1]                = last message preview
 *                      [aria-label="N unread messages"] = unread badge
 *   message row      #main [role="row"]
 *                      [data-pre-plain-text="[2:20 PM, 8/11/2026] Zhi Hong Gan: "]
 *                          -> timestamp + author, present on EVERY row including
 *                             continuation rows. This is the reliable anchor.
 *                      [data-icon="tail-out"] or aria-label "You:"  = outgoing
 *                      [data-icon="tail-in"]                       = incoming
 *                      Continuation rows carry no tail at all, so direction is
 *                      inherited from the previous row with the same author.
 *                      The legacy .message-in / .message-out classes are GONE in
 *                      this build — anything written against them silently matches
 *                      nothing.
 *   composer         [role="textbox"][contenteditable="true"]
 *                      The search box is also role=textbox but is NOT contenteditable,
 *                      so this selector is unambiguous.
 *                      aria-label = "Type a message to <chat name>" — it NAMES the
 *                      recipient. That is what makes the wrong-chat guard possible.
 *   search box       [role="textbox"][aria-label*="Search"]
 *   delivery status  aria-label " Sent " / " Delivered " / " Read " inside the row.
 *
 * OPERATIONAL FACTS THAT BITE:
 *   - EXACTLY ONE WhatsApp Web tab may be open. A second tab does not "also work":
 *     WhatsApp allows one active web client per linked device, so the new tab takes
 *     over and the old one drops to "WhatsApp is open in another window". Anything
 *     mid-action in the old tab dies. Every entry point here goes through
 *     resolvePage(), which reuses the existing tab and closes duplicates. NEVER
 *     reach for browser.openTab() for this site — not for enrollment either.
 *   - Cold boot takes ~20-25s after navigate. Never act before waitForApp().
 *   - The daemon idle-closes Chrome (settings.idleTimeoutMs, default 5 min) and
 *     relaunches it on about:blank, so every entry point must navigate itself.
 *     Never assume the app is still on screen from a previous call.
 *   - A "What's new on WhatsApp Web" dialog covers the UI on most loads.
 *     dismissOverlays() must run before anything touches the chat list.
 */

export const APP_URL = 'https://web.whatsapp.com/';

export const READY_SEL = '#pane-side';
export const LOGGED_OUT_SEL = 'canvas[aria-label*="QR" i], [data-ref]';
export const CHAT_ROW_SEL = '#pane-side [role="row"]';
export const MSG_ROW_SEL = '#main [role="row"]';
/** Unambiguous: the search box is role=textbox but not contenteditable. */
export const COMPOSER_SEL = '[role="textbox"][contenteditable="true"]';
export const SEARCH_SEL = '[role="textbox"][aria-label*="Search" i]';

/** Cold boot is slow and highly variable on a busy account. */
const BOOT_MS = 90_000;

export type AppState = 'ready' | 'logged_out';

export interface WaChat {
  index: number;
  name: string;
  preview: string;
  time: string | null;
  unread: number;
  muted: boolean;
}

export interface WaMessage {
  index: number;
  direction: 'in' | 'out';
  author: string | null;
  timestamp: string | null;
  text: string;
  status: string | null;
}

export interface WaSendResult {
  ok: boolean;
  detail: string;
  target: string;
  chat: string | null;
  status: string | null;
}

// ------------------------------------------------------------------ lifecycle

/**
 * The single WhatsApp tab.
 *
 * WhatsApp Web permits one active web client per linked device. Open a second
 * tab and it seizes the connection while the first collapses to "WhatsApp is
 * open in another window" — which silently breaks whatever that tab was doing.
 * So: reuse the tab that already has the app, close any duplicates, and only
 * fall back to the caller's working tab when none exists.
 *
 * Every exported action below funnels through this. It is the reason none of
 * them take a raw Page from the caller.
 */
export async function resolvePage(ctx: BrowserContext, fallback: Page): Promise<Page> {
  const open = ctx.pages().filter((p) => !p.isClosed() && p.url().startsWith(APP_URL));
  if (open.length === 0) return fallback;

  // Keep the oldest; a duplicate is already the loser of the takeover fight.
  for (const extra of open.slice(1)) await extra.close().catch(() => {});
  await open[0].bringToFront().catch(() => {});
  return open[0];
}

/**
 * Navigate to WhatsApp Web if we are not already there, then wait for the app to
 * settle into one of its two terminal states. Both are load-bearing: reporting
 * `logged_out` is how the caller learns to ask the human for a QR scan instead of
 * failing later with a confusing selector error.
 */
export async function waitForApp(page: Page): Promise<AppState> {
  if (!page.url().startsWith(APP_URL)) {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }

  const deadline = Date.now() + BOOT_MS;
  while (Date.now() < deadline) {
    const state = await page.evaluate(
      ([ready, out]) => {
        if (document.querySelector(ready)) return 'ready';
        if (document.querySelector(out)) return 'logged_out';
        return null;
      },
      [READY_SEL, LOGGED_OUT_SEL],
    );
    if (state) return state as AppState;
    await sleep(1000);
  }

  throw new Error(
    `WhatsApp Web did not finish loading within ${Math.round(BOOT_MS / 1000)}s — neither the chat list ` +
      'nor the QR code appeared. The account may be syncing; try again.',
  );
}

/** Same, but turns `logged_out` into the actionable error every action wants. */
async function requireApp(page: Page): Promise<void> {
  const state = await waitForApp(page);
  if (state === 'logged_out') {
    throw new Error(
      'WhatsApp Web is showing the QR code — the browser is not linked. Ask the user to open the ' +
        'dashboard, click WhatsApp, scan the QR with their phone and tick "Stay logged in on this browser".',
    );
  }
}

/**
 * Close the "What's new on WhatsApp Web" dialog and anything like it.
 *
 * It renders over the chat list on most loads, so every click below it would
 * otherwise hit an overlay. Uses a real click; it is an in-app dialog, but there
 * is no reason to be the one thing in this codebase that fires synthetic events.
 */
export async function dismissOverlays(page: Page, max = 3): Promise<number> {
  let closed = 0;
  for (let i = 0; i < max; i++) {
    const dialog = page.locator('[role="dialog"]').first();
    if ((await dialog.count()) === 0) break;
    const close = dialog.getByRole('button', { name: /^close$/i }).first();
    if ((await close.count()) === 0) break;
    try {
      await humanClick(close);
      closed++;
    } catch {
      break; // already gone, or not clickable — not worth thrashing over
    }
    await pause(400, 900);
  }
  return closed;
}

// ----------------------------------------------------------------- chat list

const READ_CHATS = ([sel, limit]: [string, number]) => {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const rows = Array.from(document.querySelectorAll(sel)).slice(0, limit);

  return rows.map((row, index) => {
    const titles = Array.from(row.querySelectorAll('span[title]')).map((s) => s.getAttribute('title') ?? '');
    const unreadLabel = Array.from(row.querySelectorAll('[aria-label]'))
      .map((e) => e.getAttribute('aria-label') ?? '')
      .find((l) => /unread message/i.test(l));
    const lines = ((row as HTMLElement).innerText || '').split('\n').map((l) => l.trim()).filter(Boolean);

    return {
      index,
      name: clean(titles[0]),
      preview: clean(titles[1]),
      // The timestamp is the only line that looks like a clock or a date.
      time: lines.find((l) => /^\d{1,2}:\d{2}\s*(AM|PM)?$/i.test(l) || /^(yesterday|\d{1,2}\/\d{1,2}\/\d{2,4})$/i.test(l)) ?? null,
      unread: unreadLabel ? Number((unreadLabel.match(/\d+/) ?? ['0'])[0]) : 0,
      muted: Array.from(row.querySelectorAll('[aria-label]')).some((e) => /muted/i.test(e.getAttribute('aria-label') ?? '')),
    };
  });
};

/** The chat list, most recent first — the same order WhatsApp shows. */
export async function listChats(page: Page, limit = 20): Promise<WaChat[]> {
  await requireApp(page);
  await dismissOverlays(page);
  await pause(400, 900);
  return (await page.evaluate(READ_CHATS, [CHAT_ROW_SEL, limit] as [string, number])) as WaChat[];
}

// --------------------------------------------------------------- opening chats

/** Bare digits, long enough to be a real number. Used to pick the open strategy. */
function asPhone(target: string): string | null {
  const digits = target.replace(/[\s()+-]/g, '');
  return /^\d{7,15}$/.test(digits) ? digits : null;
}

/** The composer's accessible name, which contains the chat it will send to. */
async function composerLabel(page: Page): Promise<string | null> {
  const box = page.locator(COMPOSER_SEL).first();
  if ((await box.count()) === 0) return null;
  return box.getAttribute('aria-label');
}

/**
 * Open a conversation and return the chat name the composer says it is pointing at.
 *
 * Two strategies, because they have genuinely different reach:
 *   - a phone number goes through the /send deep link, the ONLY way to reach a
 *     number with no existing chat. It reloads the whole app, hence the second
 *     requireApp().
 *   - anything else is treated as a chat name and found through the search box,
 *     which is what works for groups and saved contacts.
 *
 * Never returns without a composer on screen, so callers can trust that typing
 * will land somewhere real.
 */
export async function openChat(page: Page, target: string): Promise<string> {
  const phone = asPhone(target);

  if (phone) {
    await page.goto(`${APP_URL}send?phone=${phone}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await requireApp(page);
    await dismissOverlays(page);
  } else {
    await requireApp(page);
    await dismissOverlays(page);

    const search = page.locator(SEARCH_SEL).first();
    if ((await search.count()) === 0) throw new Error('WhatsApp search box not found — the app may still be loading.');
    await humanType(search, target);
    await pause(1200, 2200);

    const row = page.locator(CHAT_ROW_SEL).filter({ hasText: target }).first();
    if ((await row.count()) === 0) {
      throw new Error(
        `No chat matching "${target}". Call whatsapp_list_chats to see the exact names, or pass a phone ` +
          'number in international format (e.g. 60123456789) to start a new conversation.',
      );
    }
    await humanClick(row);
  }

  await pause(1200, 2400);

  // The composer only exists once a conversation is actually open, so this
  // doubles as the "did it open" check.
  const deadline = Date.now() + 20_000;
  let label: string | null = null;
  while (Date.now() < deadline) {
    label = await composerLabel(page);
    if (label) break;
    await sleep(750);
  }
  if (label === null) {
    throw new Error(
      `Opened "${target}" but no message composer appeared. The chat may not exist, or the number may ` +
        'not be on WhatsApp.',
    );
  }

  // "Type a message to group Eternalgy - Eight Banners" -> "Eternalgy - Eight Banners"
  return label.replace(/^type a message to\s*(group\s*)?/i, '').trim() || label;
}

// ------------------------------------------------------------------- reading

const READ_MESSAGES = ([sel, limit]: [string, number]) => {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const all = Array.from(document.querySelectorAll(sel));
  const rows = all.slice(Math.max(0, all.length - limit));

  const out: {
    index: number;
    direction: 'in' | 'out';
    author: string | null;
    timestamp: string | null;
    text: string;
    status: string | null;
  }[] = [];

  for (const row of rows) {
    // "[2:20 PM, 8/11/2026] Zhi Hong Gan: " — present on continuation rows too,
    // which is why it beats reading the rendered header.
    const pre = row.querySelector('[data-pre-plain-text]')?.getAttribute('data-pre-plain-text') ?? '';
    const m = /^\[(.+?)\]\s*(.*?):\s*$/.exec(pre.trim());
    const timestamp = m ? m[1] : null;
    const author = m ? m[2] : null;

    const icons = Array.from(row.querySelectorAll('[data-icon]')).map((i) => i.getAttribute('data-icon') ?? '');
    const saysYou = Array.from(row.querySelectorAll('[aria-label]')).some((e) =>
      /^You:/.test(e.getAttribute('aria-label') ?? ''),
    );

    let direction: 'in' | 'out' | null = null;
    if (icons.includes('tail-out') || saysYou) direction = 'out';
    else if (icons.includes('tail-in')) direction = 'in';
    else {
      // Continuation row: no tail of its own. Inherit from the previous message
      // by the same author, which is what the tail would have said.
      const prev = [...out].reverse().find((p) => p.author === author);
      direction = prev?.direction ?? 'in';
    }

    const status =
      Array.from(row.querySelectorAll('[aria-label]'))
        .map((e) => clean(e.getAttribute('aria-label')))
        .find((l) => /^(sent|delivered|read|pending)$/i.test(l)) ?? null;

    out.push({
      index: out.length,
      direction,
      author,
      timestamp,
      text: clean((row as HTMLElement).innerText).slice(0, 4000),
      status,
    });
  }

  return out;
};

/**
 * The composer appears before the history finishes rendering, so reading straight
 * after openChat returns a single row instead of the real backlog (measured: 1 row
 * vs 8). Wait for the row count to stop growing rather than guessing a delay.
 */
async function waitForMessages(page: Page): Promise<number> {
  let last = -1;
  for (let i = 0; i < 16; i++) {
    const n = (await page.evaluate((sel) => document.querySelectorAll(sel).length, MSG_ROW_SEL)) as number;
    if (n > 0 && n === last) return n;
    last = n;
    await sleep(500);
  }
  return last;
}

/** Recent messages from one conversation, oldest first. */
export async function readChat(page: Page, target: string, limit = 20): Promise<{ chat: string; messages: WaMessage[] }> {
  const chat = await openChat(page, target);
  await waitForMessages(page);
  const messages = (await page.evaluate(READ_MESSAGES, [MSG_ROW_SEL, limit] as [string, number])) as WaMessage[];
  return { chat, messages };
}

// ------------------------------------------------------------------- sending

/**
 * Send a message, then confirm it actually left.
 *
 * Never reports success on the strength of "we pressed Enter" — a message is
 * only sent once it is back on screen as an OUTGOING row carrying a delivery
 * status. Everything else is reported as ok:false so the caller can tell the
 * human the truth.
 */
export async function sendMessage(page: Page, target: string, text: string): Promise<WaSendResult> {
  const chat = await openChat(page, target);

  // Guard against the composer belonging to a chat left open by a previous
  // action. For a phone number the /send link already pinned the recipient.
  if (!asPhone(target)) {
    const wanted = target.toLowerCase().trim();
    if (!chat.toLowerCase().includes(wanted)) {
      return {
        ok: false,
        detail: `Refusing to send: asked for "${target}" but the open chat is "${chat}".`,
        target,
        chat,
        status: null,
      };
    }
  }

  const box = page.locator(COMPOSER_SEL).first();
  await box.scrollIntoViewIfNeeded();
  await humanType(box, text);
  await pause(500, 1200);
  await box.press('Enter');

  const needle = text.replace(/\s+/g, ' ').trim().slice(0, 60);
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const hit = (await page.evaluate(
      ([sel, want]) => {
        const rows = Array.from(document.querySelectorAll(sel as string));
        for (const row of rows.slice(-8).reverse()) {
          const body = ((row as HTMLElement).innerText || '').replace(/\s+/g, ' ');
          if (!body.includes(want as string)) continue;
          const icons = Array.from(row.querySelectorAll('[data-icon]')).map((i2) => i2.getAttribute('data-icon') ?? '');
          const saysYou = Array.from(row.querySelectorAll('[aria-label]')).some((e) =>
            /^You:/.test(e.getAttribute('aria-label') ?? ''),
          );
          if (!icons.includes('tail-out') && !saysYou) continue;
          const status =
            Array.from(row.querySelectorAll('[aria-label]'))
              .map((e) => (e.getAttribute('aria-label') ?? '').trim())
              .find((l) => /^(sent|delivered|read|pending)$/i.test(l)) ?? null;
          return { found: true, status };
        }
        return { found: false, status: null };
      },
      [MSG_ROW_SEL, needle] as [string, string],
    )) as { found: boolean; status: string | null };

    if (hit.found && hit.status && !/pending/i.test(hit.status)) {
      return { ok: true, detail: `Delivered to "${chat}" (${hit.status})`, target, chat, status: hit.status };
    }
  }

  return {
    ok: false,
    detail:
      `Typed the message into "${chat}" and pressed Enter, but it never came back as a sent outgoing ` +
      'message. Treat as NOT sent and check the browser.',
    target,
    chat,
    status: null,
  };
}
