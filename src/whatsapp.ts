import type { BrowserContext, Locator, Page } from 'patchright';

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
 *   search box       [role="textbox"]:not([contenteditable="true"])
 *                      It has NO aria-label in this build (measured: ""). Never match
 *                      it by label — that is what broke every by-name lookup.
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
 *   - Every entry point still navigates and waits for itself — the tab may have been
 *     closed, crashed, or left on about:blank. But it should rarely have to: the tab
 *     is pinned (browser.pin) so the idle timer cannot reap it, which is what turns a
 *     25s boot from a per-call cost into a once-per-daemon cost.
 *   - A "What's new on WhatsApp Web" dialog covers the UI on most loads.
 *     dismissOverlays() must run before anything touches the chat list.
 *
 * NO SYNTHETIC HUMAN PACING HERE — deliberately, and it is not an oversight:
 *   human.ts exists to defeat timing/burst heuristics on sites that authenticate a
 *   scraped cookie and watch how you behave. Facebook is such a site. WhatsApp Web
 *   is not: it authenticates the Noise linked-device keypair, and the server sees
 *   protocol frames, not DOM events — keystroke cadence inside a contenteditable
 *   never leaves the browser. Padding every action with 1-2s of sleep bought nothing
 *   and cost ~5s per call. The risk that IS real for this site is bulk-send volume,
 *   and that is covered by BrowserManager's RateLimiter, which stays.
 *   Do not reintroduce pause()/humanType()/humanClick() here.
 */

export const APP_URL = 'https://web.whatsapp.com/';

export const READY_SEL = '#pane-side';
export const LOGGED_OUT_SEL = 'canvas[aria-label*="QR" i], [data-ref]';
export const CHAT_ROW_SEL = '#pane-side [role="row"]';
export const MSG_ROW_SEL = '#main [role="row"]';
/** Unambiguous: the search box is role=textbox but not contenteditable. */
export const COMPOSER_SEL = '[role="textbox"][contenteditable="true"]';
/**
 * The search box, identified structurally rather than by its label.
 *
 * It is NOT `[aria-label*="Search"]`. In this WhatsApp build the box carries no
 * aria-label at all — measured live: the two role=textbox nodes on a chat screen come
 * back as label "" (search) and "Type a message to <chat>" (composer). So that
 * selector matched NOTHING, and every by-name lookup died: openChat sat in
 * pressSequentially until the 30s action timeout, then reported "search box not found
 * — the app may still be loading", which reads like a timing problem and is not one.
 * Measured against the original code on a live linked account: readChat by name
 * failed in 31.0s, every subsequent call failed instantly. Only the phone path worked.
 *
 * Not-contenteditable is the durable half of the distinction, and it is the same one
 * COMPOSER_SEL relies on: exactly two role=textbox nodes exist on a chat screen, and
 * only the composer is editable.
 */
export const SEARCH_SEL = '[role="textbox"]:not([contenteditable="true"])';

/** Cold boot is slow and highly variable on a busy account. */
const BOOT_MS = 90_000;

/** How long a chat switch or a delivery ack is allowed to take once the app is up. */
const ACT_MS = 20_000;

export type AppState = 'ready' | 'logged_out';

/**
 * Per-phase stopwatch, printed to stderr as one line per call.
 *
 * Every latency claim about this file used to be inferred from the constants in it,
 * which is how ~5s of sleep per call went unnoticed for so long. Emitting real
 * numbers costs nothing and is the only way to tell a slow network from a slow
 * implementation the next time this feels sluggish. stderr, not the return value, so
 * no caller or MCP schema has to care.
 */
function stopwatch(op: string) {
  const t0 = Date.now();
  let mark = t0;
  const phases: string[] = [];
  return {
    lap(name: string) {
      const now = Date.now();
      phases.push(`${name}=${now - mark}ms`);
      mark = now;
    },
    done() {
      console.error(`[wa] ${op} ${phases.join(' ')} total=${Date.now() - t0}ms`);
    },
  };
}

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
 * The tab every WhatsApp action runs in, kept warm.
 *
 * resolvePage picks it; pin() is what stops the idle timer reaping it five minutes
 * later. Those two together are the difference between paying a 20-30s app boot on
 * every call and paying it once per daemon: rebuilding this tab means re-running the
 * bundle, IndexedDB, the Noise handshake and a chat sync, none of which get faster
 * by being repeated.
 */
export async function warmPage(ctx: BrowserContext, fallback: Page, pin: (p: Page) => void): Promise<Page> {
  const page = await resolvePage(ctx, fallback);
  pin(page);
  return page;
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

  // waitForFunction, not a sleep-poll: the predicate runs INSIDE the page, so it
  // costs no round-trip per attempt and resolves within a frame of the pane
  // appearing instead of up to a second later. On an already-warm tab this returns
  // essentially instantly.
  const handle = await page
    .waitForFunction(
      ([ready, out]) => {
        if (document.querySelector(ready)) return 'ready';
        if (document.querySelector(out)) return 'logged_out';
        return null;
      },
      [READY_SEL, LOGGED_OUT_SEL],
      { timeout: BOOT_MS, polling: 250 },
    )
    .catch(() => null);

  if (!handle) {
    throw new Error(
      `WhatsApp Web did not finish loading within ${Math.round(BOOT_MS / 1000)}s — neither the chat list ` +
        'nor the QR code appeared. The account may be syncing; try again.',
    );
  }

  return (await handle.jsonValue()) as AppState;
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
      await close.click({ timeout: 5_000 });
      closed++;
    } catch {
      break; // already gone, or not clickable — not worth thrashing over
    }
    // Wait for the dialog to actually leave rather than sleeping and hoping; if it
    // lingers, the next iteration's count() sees it and we stop.
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), undefined, { timeout: 3_000 }).catch(() => {});
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
  const t = stopwatch('listChats');
  await requireApp(page);
  t.lap('app');
  await dismissOverlays(page);
  t.lap('overlays');
  const chats = (await page.evaluate(READ_CHATS, [CHAT_ROW_SEL, limit] as [string, number])) as WaChat[];
  t.lap('read');
  t.done();
  return chats;
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

/** "Type a message to group Eternalgy - Eight Banners" -> "Eternalgy - Eight Banners" */
function chatFromLabel(label: string): string {
  return label.replace(/^type a message to\s*(group\s*)?/i, '').trim() || label;
}

/**
 * Put `text` in a field in one shot. Never per-character.
 *
 * fill() handles the common case; insertText is the fallback for an editor fill()
 * does not recognise. Both land the whole string in a single call, which is the
 * whole point — pressSequentially at ~100ms/char is what made this file slow.
 * Clears first, because a leftover value would otherwise be prepended to the new one.
 */
async function fastFill(page: Page, box: Locator, text: string): Promise<void> {
  await box.click();
  await box.press('ControlOrMeta+A');
  await box.press('Backspace');
  try {
    await box.fill(text, { timeout: 3_000 });
  } catch {
    await page.keyboard.insertText(text);
  }
}

/**
 * Find the sidebar row for `target` and return its displayed name, or null.
 *
 * The match must be PROVABLE, because the failure mode here is opening the wrong
 * conversation and, one call later, messaging the wrong person:
 *   - a name matches when the row text contains it (what the old code did);
 *   - a phone number matches only when the row's own digits contain the number.
 * A saved contact usually renders as a name with no digits on the row, so a phone
 * lookup often finds nothing here. That is fine — the caller falls back to the
 * /send deep link, which is unambiguous. Slow and certain beats fast and wrong.
 */
async function findChatRow(page: Page, target: string, phone: string | null): Promise<string | null> {
  const search = page.locator(SEARCH_SEL).first();
  if ((await search.count()) === 0) throw new Error('WhatsApp search box not found — the app may still be loading.');

  await fastFill(page, search, target);

  // Results are re-rendered asynchronously. Wait for a provable match to appear
  // rather than sleeping ~1.7s and hoping the list has caught up.
  const handle = await page
    .waitForFunction(
      ([sel, want, digits]) => {
        const wanted = (want as string).toLowerCase().trim();
        for (const row of Array.from(document.querySelectorAll(sel as string))) {
          const text = ((row as HTMLElement).innerText || '').replace(/\s+/g, ' ');
          const hit = digits
            ? text.replace(/\D/g, '').includes(digits as string)
            : text.toLowerCase().includes(wanted);
          if (!hit) continue;
          const title = row.querySelector('span[title]')?.getAttribute('title') ?? '';
          return title.trim() || text.trim().slice(0, 80);
        }
        return null;
      },
      [CHAT_ROW_SEL, target, phone] as [string, string, string | null],
      { timeout: 6_000, polling: 100 },
    )
    .catch(() => null);

  return handle ? ((await handle.jsonValue()) as string) : null;
}

/**
 * Open a conversation and return the chat name the composer says it is pointing at.
 *
 * Search first, for BOTH names and numbers. Clicking a sidebar row is a client-side
 * chat switch — a few hundred milliseconds. The /send deep link is a full document
 * load that tears the SPA down and re-boots it, so it used to cost 15-25s on every
 * single lookup by phone, warm browser or not. It is now only what it always should
 * have been: the fallback for a number with no existing chat, which is the one case
 * nothing else can reach.
 *
 * Never returns without a composer NAMING THE CHAT WE ASKED FOR. The old version
 * waited for any composer at all and broke on the first one it saw, which on a warm
 * tab is the previous chat's composer, still mounted — so it could return the wrong
 * chat instantly. A blind 1.2-2.4s sleep was the only thing papering over that race.
 * Waiting for the label to match removes the race and the sleep together.
 */
export async function openChat(page: Page, target: string): Promise<string> {
  const t = stopwatch(`openChat(${target})`);
  const phone = asPhone(target);

  await requireApp(page);
  await dismissOverlays(page);
  t.lap('app');

  const rowName = await findChatRow(page, target, phone);
  t.lap('find');

  if (rowName === null && !phone) {
    throw new Error(
      `No chat matching "${target}". Call whatsapp_list_chats to see the exact names, or pass a phone ` +
        'number in international format (e.g. 60123456789) to start a new conversation.',
    );
  }

  let label: string | null = null;

  if (rowName !== null) {
    await page.locator(CHAT_ROW_SEL).filter({ hasText: rowName }).first().click({ timeout: 10_000 });
    // The row's own displayed name is what the composer will echo, so it is a far
    // better wait condition than "a composer exists" — it cannot be satisfied by a
    // composer left over from the chat we were in a moment ago.
    const handle = await page
      .waitForFunction(
        ([sel, want]) => {
          const box = document.querySelector(sel as string);
          const l = box?.getAttribute('aria-label') ?? '';
          return l.toLowerCase().includes((want as string).toLowerCase()) ? l : null;
        },
        [COMPOSER_SEL, rowName] as [string, string],
        { timeout: ACT_MS, polling: 100 },
      )
      .catch(() => null);
    label = handle ? ((await handle.jsonValue()) as string) : null;
  } else {
    // Phone with no existing chat. Only route that can reach a stranger; costs a
    // full app reload, which is exactly why it is last.
    await page.goto(`${APP_URL}send?phone=${phone}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await requireApp(page);
    await dismissOverlays(page);
    // Nothing to match against here — but the navigation guarantees no stale
    // composer survives, so "a composer exists" is sound on this path only.
    const handle = await page
      .waitForFunction((sel) => document.querySelector(sel as string)?.getAttribute('aria-label') ?? null, COMPOSER_SEL, {
        timeout: ACT_MS,
        polling: 100,
      })
      .catch(() => null);
    label = handle ? ((await handle.jsonValue()) as string) : null;
  }

  t.lap('open');
  t.done();

  if (label === null) {
    throw new Error(
      `Opened "${target}" but no message composer appeared. The chat may not exist, or the number may ` +
        'not be on WhatsApp.',
    );
  }

  return chatFromLabel(label);
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
  // Settle detection, entirely in-page: the count has to hold steady for 300ms
  // before we call it done. Same idea as the old count-twice loop, but the clock
  // runs in the page instead of costing a 500ms sleep plus a round-trip per sample,
  // so a chat that renders in 200ms is read after ~500ms rather than ~1s, and a slow
  // one is no longer rounded up to the next half second.
  const SETTLE_MS = 300;
  await page.evaluate(() => {
    const w = window as unknown as { __waN?: number; __waAt?: number };
    w.__waN = -1;
    w.__waAt = Date.now();
  });

  const handle = await page
    .waitForFunction(
      ([sel, settle]) => {
        const w = window as unknown as { __waN?: number; __waAt?: number };
        const n = document.querySelectorAll(sel as string).length;
        if (w.__waN !== n) {
          w.__waN = n;
          w.__waAt = Date.now();
          return null;
        }
        return n > 0 && Date.now() - (w.__waAt ?? 0) >= (settle as number) ? n : null;
      },
      [MSG_ROW_SEL, SETTLE_MS] as [string, number],
      { timeout: 15_000, polling: 100 },
    )
    .catch(() => null);

  // Timing out is not fatal — an empty conversation legitimately never settles on a
  // non-zero count. Report what is actually there and let the caller read it.
  if (handle) return (await handle.jsonValue()) as number;
  return (await page.evaluate((sel) => document.querySelectorAll(sel).length, MSG_ROW_SEL)) as number;
}

/** Recent messages from one conversation, oldest first. */
export async function readChat(page: Page, target: string, limit = 20): Promise<{ chat: string; messages: WaMessage[] }> {
  const t = stopwatch(`readChat(${target})`);
  const chat = await openChat(page, target);
  t.lap('open');
  await waitForMessages(page);
  t.lap('settle');
  const messages = (await page.evaluate(READ_MESSAGES, [MSG_ROW_SEL, limit] as [string, number])) as WaMessage[];
  t.lap('read');
  t.done();
  return { chat, messages };
}

// ------------------------------------------------------------------- sending

/**
 * Put the whole message body into the composer in one shot, and prove it landed.
 *
 * NEVER TYPE INTO WHATSAPP. Per-character entry ran at ~100ms/char: twenty seconds
 * for an ordinary message, and past roughly 370 characters it blew Playwright's 30s
 * action timeout and left a half-written message sitting in the composer — a
 * partial send waiting for someone to hit Enter. Emoji and other multi-byte
 * characters came out mangled too.
 *
 * Clipboard + Ctrl+V is the proven path on this app (the composer is a rich-text
 * editor that ignores naive value-setting). insertText is the fallback for when the
 * clipboard permission is unavailable; it is still one call, not one per character.
 * Either way the composer is read back before returning, because paste is async and
 * pressing Enter on a composer that has not caught up sends an empty or partial
 * message — the one failure this function exists to make impossible.
 */
async function placeInComposer(page: Page, box: Locator, text: string): Promise<void> {
  const landed = () =>
    page
      .waitForFunction(
        ([sel, want]) => {
          const b = document.querySelector(sel as string);
          return !!b && ((b as HTMLElement).innerText || '').replace(/\s+/g, ' ').includes(want as string);
        },
        [COMPOSER_SEL, text.replace(/\s+/g, ' ').trim().slice(0, 40)] as [string, string],
        { timeout: 10_000, polling: 100 },
      )
      .then(() => true)
      .catch(() => false);

  try {
    await page
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_URL.replace(/\/$/, '') });
    await page.evaluate((t2) => navigator.clipboard.writeText(t2), text);
    await box.press('ControlOrMeta+V');
    if (await landed()) return;
  } catch {
    // Fall through — the clipboard route is the fast path, not the only one.
  }

  await box.click();
  await page.keyboard.insertText(text);
  if (await landed()) return;

  throw new Error(
    `Could not get the message into the WhatsApp composer for "${await composerLabel(page)}". ` +
      'Nothing was sent.',
  );
}

/**
 * Send a message, then confirm it actually left.
 *
 * Never reports success on the strength of "we pressed Enter" — a message is
 * only sent once it is back on screen as an OUTGOING row carrying a delivery
 * status. Everything else is reported as ok:false so the caller can tell the
 * human the truth.
 */
export async function sendMessage(page: Page, target: string, text: string): Promise<WaSendResult> {
  const t = stopwatch(`send(${target}, ${text.length}ch)`);
  const chat = await openChat(page, target);
  t.lap('open');

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
  await box.click();

  // A draft left in the composer by an earlier run or a human would otherwise get
  // the new text appended to it, and the whole lot sent as one message.
  await box.press('ControlOrMeta+A');
  await box.press('Backspace');

  await placeInComposer(page, box, text);
  t.lap('compose');

  await box.press('Enter');

  // Sent means it came BACK as an outgoing row carrying a delivery status. Pressing
  // Enter proves nothing. The status regex excludes "pending" — a queued message is
  // not a sent one — so this resolves on the real ack and no sooner.
  //
  // The needle is EMOJI-STRIPPED, and that is not cosmetic. WhatsApp renders emoji as
  // images, so they contribute nothing to innerText: a message beginning "🤖 Automation
  // test" reads back as "Automation test", and a raw-text needle never matches. Measured
  // live — a 669-char message was delivered and read, and this check still reported
  // "treat as NOT sent" after burning the full 20s timeout. That false negative is the
  // dangerous direction: a caller that believes a delivered message failed will send it
  // again. Both sides are normalised identically so the comparison is like-for-like.
  const strip = (s: string) =>
    s
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();

  const needle = strip(text).slice(0, 60);
  // An all-emoji message ("👍") strips to nothing, and includes('') matches everything.
  // Fall back to "a new outgoing row settled after we pressed Enter" rather than
  // accepting a match that means nothing.
  const usable = needle.length >= 4;
  const before = usable ? 0 : ((await page.evaluate((sel) => document.querySelectorAll(sel).length, MSG_ROW_SEL)) as number);

  const status = await page
    .waitForFunction(
      ([sel, want, minRows]) => {
        const rows = Array.from(document.querySelectorAll(sel as string));
        if (rows.length < (minRows as number)) return null;
        const clean = (s: string) =>
          s
            .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
            .replace(/\s+/g, ' ')
            .trim();
        for (const row of rows.slice(-8).reverse()) {
          if (want && !clean((row as HTMLElement).innerText || '').includes(want as string)) continue;
          const icons = Array.from(row.querySelectorAll('[data-icon]')).map((i2) => i2.getAttribute('data-icon') ?? '');
          const saysYou = Array.from(row.querySelectorAll('[aria-label]')).some((e) =>
            /^You:/.test(e.getAttribute('aria-label') ?? ''),
          );
          if (!icons.includes('tail-out') && !saysYou) continue;
          const s = Array.from(row.querySelectorAll('[aria-label]'))
            .map((e) => (e.getAttribute('aria-label') ?? '').trim())
            .find((l) => /^(sent|delivered|read)$/i.test(l));
          if (s) return s;
        }
        return null;
      },
      [MSG_ROW_SEL, usable ? needle : '', usable ? 0 : before + 1] as [string, string, number],
      { timeout: ACT_MS, polling: 200 },
    )
    .then((h) => h.jsonValue() as Promise<string>)
    .catch(() => null);

  t.lap('confirm');
  t.done();

  if (status) {
    return { ok: true, detail: `Delivered to "${chat}" (${status})`, target, chat, status };
  }

  return {
    ok: false,
    detail:
      `Put the message into "${chat}" and pressed Enter, but it never came back as a sent outgoing ` +
      'message. Treat as NOT sent and check the browser.',
    target,
    chat,
    status: null,
  };
}
