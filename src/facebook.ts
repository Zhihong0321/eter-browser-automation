import type { Page } from 'patchright';
import { humanClick, humanScroll, humanType, pause, sleep } from './human.js';

/**
 * The enrolled Chrome profile holding the Facebook login.
 *
 * Anything reading a Page must run here, not on the default agent profile. Facebook
 * serves a logged-out visitor a login wall over the content: the page still renders,
 * the scrape still "succeeds", and it returns a thin subset — a follower count and
 * little else — with no error to say why. A stage that quietly returns 20% of the
 * data is worse than one that fails, so the profile is named rather than defaulted.
 */
export const FACEBOOK_PROFILE = 'facebook';

export interface FbPost {
  index: number;
  author: string | null;
  text: string;
  permalink: string | null;
  timestamp: string | null;
  truncated: boolean;
}

/** Where a post's body text actually lives. `[role="article"]` nodes are empty decoys. */
export const MESSAGE_SEL = '[data-ad-preview="message"],[data-ad-comet-preview="message"]';

/**
 * The post action bar, matched by ARIA.
 *
 * Facebook renders Like / Comment / Share as icon buttons: the words live in
 * `aria-label`, and the rendered text contains neither "Comment" nor "Share".
 * The previous rule tested `innerText` against /\b(Comment|Like|Share)\b/ and so
 * never fired — measured 2026-08-12, it found the author link at ancestor level
 * 3 and still rejected every one of the 14 levels, returning zero posts.
 *
 * Measured on the home feed, same session, same scroll pattern:
 *   innerText rule -> 0 posts.   this rule -> 16 posts.
 *
 * See docs/fb-recon-feasibility-probe.md finding 1.
 */
export const ACTION_SEL =
  '[aria-label="Like"],[aria-label="React"],[aria-label*="omment"],[aria-label*="Share"]';

/** Substituted with MESSAGE_SEL when EXTRACT is stringified for the page. */
declare const MESSAGE_SEL_PLACEHOLDER: string;

/** Substituted with ACTION_SEL when EXTRACT is stringified for the page. */
declare const ACTION_SEL_PLACEHOLDER: string;

/**
 * Facebook randomises class names and scrambles visible timestamps with
 * zero-width joiners, so nothing here trusts class names or rendered text order.
 *
 * The reliable structure, confirmed against the live DOM:
 *   - post body  -> [data-ad-preview="message"]
 *   - post root  -> first ancestor of that node which contains BOTH an
 *                   author link (`a[aria-label]`) and the Like/Comment/Share bar,
 *                   while still wrapping exactly one message node
 *   - author     -> that link's aria-label
 *   - permalink  -> first descendant anchor matching a post/photo/reel URL
 */
const EXTRACT = () => {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const permaRe = /\/(posts|permalink|videos|photo|reel|share)\/|story_fbid=|pfbid/;

  const tidyUrl = (href: string): string | null => {
    try {
      const u = new URL(href, location.origin);
      // Strip Facebook's click-tracking noise; keep the identifying params.
      for (const k of [...u.searchParams.keys()]) if (k.startsWith('__')) u.searchParams.delete(k);
      return u.toString();
    } catch {
      return null;
    }
  };

  const roots = new Map<Element, HTMLElement>();

  for (const msg of Array.from(document.querySelectorAll(MESSAGE_SEL_PLACEHOLDER))) {
    let node: HTMLElement | null = msg as HTMLElement;
    for (let i = 0; node && i < 14; i++) {
      const authored = node.querySelector('a[aria-label]');
      const acted = node.querySelector(ACTION_SEL_PLACEHOLDER);
      const msgCount = node.querySelectorAll(MESSAGE_SEL_PLACEHOLDER).length;
      if (authored && acted && msgCount === 1) {
        if (!roots.has(msg)) roots.set(msg, node);
        break;
      }
      node = node.parentElement;
    }
  }

  return [...roots.entries()].map(([msg, root], index) => {
    const rawText = clean((msg as HTMLElement).innerText);
    const anchors = Array.from(root.querySelectorAll('a[href]')) as HTMLAnchorElement[];
    const perma = anchors.find((a) => permaRe.test(a.getAttribute('href') ?? ''));
    const authorLink = root.querySelector('a[aria-label]');

    // Rendered timestamps are deliberately shuffled, so only trust an aria-label
    // that actually looks like a date. Otherwise report null rather than garbage.
    const dateRe = /\b(\d{1,2}\s+\w+|\w+\s+\d{1,2}|\d+\s*(m|h|d|w|hr|min)\b|yesterday|today)/i;
    const timeLabel = anchors
      .map((a) => a.getAttribute('aria-label'))
      .find((l) => l && dateRe.test(l) && !/^\s*$/.test(l));

    return {
      index,
      author: clean(authorLink?.getAttribute('aria-label')) || null,
      text: rawText.slice(0, 4000),
      permalink: perma ? tidyUrl(perma.getAttribute('href')!) : null,
      timestamp: clean(timeLabel) || null,
      truncated: rawText.length > 4000 || /\bSee more\b/i.test(rawText),
    };
  });
};

// page.evaluate serialises the function source, so the selector constant has to be
// inlined into it rather than captured from this module's scope.
const EXTRACT_SRC = EXTRACT.toString()
  .replaceAll('MESSAGE_SEL_PLACEHOLDER', JSON.stringify(MESSAGE_SEL))
  .replaceAll('ACTION_SEL_PLACEHOLDER', JSON.stringify(ACTION_SEL));

/**
 * Long posts render collapsed behind a "See more" control, so the DOM genuinely
 * does not contain the rest of the text until it is clicked.
 */
async function expandSeeMore(page: Page, max = 12): Promise<number> {
  let clicked = 0;
  for (let i = 0; i < max; i++) {
    const button = page.getByRole('button', { name: /^see more$/i }).first();
    if ((await button.count()) === 0) break;
    try {
      await button.click({ timeout: 2500 });
      clicked++;
    } catch {
      break; // offscreen or detached — take what we have rather than thrash
    }
    await pause(200, 550);
  }
  return clicked;
}

async function collect(page: Page, limit: number): Promise<FbPost[]> {
  const seen = new Map<string, FbPost>();

  for (let round = 0; round < 6 && seen.size < limit; round++) {
    await expandSeeMore(page);
    const batch = (await page.evaluate(`(${EXTRACT_SRC})()`)) as FbPost[];
    for (const post of batch) {
      const key = post.permalink ?? `${post.author}::${post.text.slice(0, 120)}`;
      if (!key.trim()) continue;
      if (!seen.has(key)) seen.set(key, { ...post, index: seen.size });
      if (seen.size >= limit) break;
    }
    if (seen.size >= limit) break;
    await humanScroll(page, 2);
  }

  return [...seen.values()].slice(0, limit);
}

/** Posts on the signed-in user's own profile. */
export async function readMyPosts(page: Page, limit = 5): Promise<FbPost[]> {
  await page.goto('https://www.facebook.com/me', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector(MESSAGE_SEL, { timeout: 30_000 }).catch(() => {});
  await pause(1500, 3000);
  return collect(page, limit);
}

/** Posts on the home timeline. */
export async function readFeed(page: Page, limit = 5): Promise<FbPost[]> {
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector(MESSAGE_SEL, { timeout: 30_000 }).catch(() => {});
  await pause(1500, 3000);
  return collect(page, limit);
}

export interface CommentResult {
  ok: boolean;
  detail: string;
  postUrl: string;
}

/**
 * Posts a comment and then confirms it actually rendered.
 * Never reports success on the strength of "we pressed Enter".
 */
export async function commentOnPost(page: Page, postUrl: string, text: string): Promise<CommentResult> {
  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await pause(1800, 3200);

  // Some surfaces hide the composer until the Comment affordance is used.
  const box = page
    .locator('[role="textbox"][contenteditable="true"]')
    .filter({ hasNot: page.locator('[aria-label*="Search" i]') })
    .first();

  if ((await box.count()) === 0) {
    const opener = page.getByRole('button', { name: /^comment$/i }).first();
    if ((await opener.count()) > 0) {
      await humanClick(opener);
      await pause(900, 1800);
    }
  }

  if ((await box.count()) === 0) {
    return { ok: false, detail: 'No comment box found on this page', postUrl };
  }

  await box.scrollIntoViewIfNeeded();
  await humanType(box, text);
  await pause(700, 1600);
  await box.press('Enter');

  // Confirm by looking for the text back on the page.
  const needle = text.slice(0, 60);
  for (let i = 0; i < 12; i++) {
    await sleep(1000);
    const present = await page.evaluate(
      (n) => (document.body.innerText || '').includes(n),
      needle,
    );
    if (present) return { ok: true, detail: 'Comment posted and visible on the page', postUrl };
  }

  return { ok: false, detail: 'Pressed Enter but the comment never appeared — treat as NOT posted', postUrl };
}
