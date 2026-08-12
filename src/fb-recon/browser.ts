/**
 * The write fence.
 *
 * fb-recon is read-only, and "read-only" enforced by careful coding is a
 * promise, not a property. This module makes it a property: it is the ONLY
 * place in fb-recon that may click, and it refuses anything not on an
 * allowlist. An allowlist rather than a denylist, for the same reason the recon
 * design uses one — a denylist is a list of the ways you have already been
 * surprised.
 *
 * The practical consequence: fb-recon physically cannot Like, Follow, Join,
 * Reply, or open a comment composer, because none of those words are on the
 * list and there is no second code path.
 */
import type { Page } from 'patchright';
import { humanScroll, pause } from '../human.js';
import type { ReadLimiter } from '../readlimit.js';

/**
 * Anchored on purpose. A substring rule would let "Reply to see more" through
 * on the strength of the words "see more" sitting inside it.
 */
export const CLICK_ALLOWLIST: RegExp[] = [
  /^see more$/i,
  /^see more comments$/i,
  /^view \d* ?more comments?$/i,
  /^view previous comments?$/i,
  /^view all \d+ comments?$/i,
  /^load more comments?$/i,
  /^next$/i,
  /^previous$/i,
  /^page \d+$/i,
];

export function isAllowedClick(name: string): boolean {
  const n = (name ?? '').trim();
  if (!n) return false;
  return CLICK_ALLOWLIST.some((re) => re.test(n));
}

/**
 * The single click chokepoint. Returns false when the control is simply not on
 * the page (a normal, expected outcome) and THROWS when the control exists but
 * is not allowed — that is a programming error and must be loud.
 */
export async function safeClick(
  page: Page,
  name: string,
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  if (!isAllowedClick(name)) {
    throw new Error(
      `fb-recon refused to click ${JSON.stringify(name)}: not on the read-only click allowlist. ` +
        'fb-recon may only expand content, never interact with it.',
    );
  }

  const target = page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).first();
  try {
    if (!(await target.isVisible({ timeout: opts.timeoutMs ?? 1500 }))) return false;
    await target.scrollIntoViewIfNeeded();
    await pause(250, 700);
    await target.click({ delay: 60 });
    await pause(300, 900);
    return true;
  } catch {
    return false;
  }
}

/**
 * Page-level guards. Dialogs are dismissed rather than accepted, and downloads
 * are cancelled — a "Save your data" prompt accepted by accident is exactly the
 * kind of side effect a read-only tool must not have.
 */
export function guardPage(page: Page): void {
  page.on('dialog', (d) => void d.dismiss().catch(() => {}));
  page.on('download', (d) => void d.cancel().catch(() => {}));
}

/**
 * A portrait 4K monitor at 150% Windows scaling — 2160x3840 physical, which a
 * browser reports as a 1440x2560 CSS screen at devicePixelRatio 1.5.
 *
 * The sweep is bounded by how much Facebook has RENDERED, not by how much
 * exists: the timeline is virtualized, so only what is in or near the viewport
 * has DOM nodes. A ~940 CSS px viewport (a maximised window on a 1080p screen)
 * therefore holds very few posts at once — and humanScroll moves 900-1800 CSS
 * px per round, which can exceed a full viewport. Posts can render and be
 * destroyed BETWEEN two extractions, unseen. That is the most likely mechanism
 * behind the measured 47 / 3 / 1 post yields on the same group.
 *
 * A 2480 px viewport makes an 1800 px scroll a partial screen, so consecutive
 * rounds always overlap, and it keeps ~2.6x more posts alive per extraction so
 * a slow-loading group is far less likely to hand back an empty round and trip
 * the dry-round exit early.
 *
 * Why these numbers and not a plain zoom-out: every metric has to agree with
 * every other one. Zooming to 25% gives innerHeight 3760 against a screen
 * height of 1080, and an inner viewport taller than the screen is a trivially
 * detectable tell. A rotated 4K monitor at 150% scaling is a configuration real
 * people sit at, and screen / window / DPR all corroborate each other.
 */
export const TALL_VIEWPORT = {
  width: 1440,
  /** Screen height less ~80 CSS px of tab strip and omnibox. */
  height: 2480,
  deviceScaleFactor: 1.5,
  mobile: false,
  screenWidth: 1440,
  screenHeight: 2560,
} as const;

/**
 * Returns null on success, or a problem string. Deliberately non-fatal: a
 * sweep on a short viewport is a worse sweep, not a failed one, and losing the
 * harvest over a display setting would be absurd.
 */
export async function useTallViewport(page: Page): Promise<string | null> {
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...TALL_VIEWPORT });
    return null;
  } catch (err) {
    return `tall viewport not applied, sweeping at the default window size — ${(err as Error).message}`;
  }
}

/**
 * BrowserManager.run() hands out the profile's one long-lived tab and never
 * closes it, so an override left in place would follow every later task on this
 * profile. Cleared on the way out.
 *
 * This depends on the context being launched with `viewport: null`, which
 * BrowserManager does. Measured 2026-08-12: with viewport null, clearing
 * restores window/screen/DPR coherently. With a Playwright-managed viewport,
 * Playwright implements it via this same override, and clearing leaves
 * innerHeight at 2480 against a screen height of 600 — an incoherent
 * fingerprint, and worse than never having applied it.
 */
export async function clearTallViewport(page: Page): Promise<void> {
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
  } catch {
    // The page is already gone, or CDP is unavailable. Nothing to restore.
  }
}

export async function expandSeeMore(page: Page, rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (!(await safeClick(page, 'See more'))) return;
  }
}

export async function expandComments(page: Page, rounds = 8): Promise<void> {
  const labels = ['View more comments', 'View previous comments', 'Load more comments'];
  for (let i = 0; i < rounds; i++) {
    let clicked = false;
    for (const label of labels) {
      if (await safeClick(page, label)) {
        clicked = true;
        break;
      }
    }
    if (!clicked) return;
  }
}

/**
 * Scroll one round and report how many matching nodes exist afterwards.
 *
 * The caller compares this against the previous round's count: growth means
 * keep going, no growth twice running means the list is exhausted. This is
 * waiting on the DATA'S SHAPE (rule #14) — there is deliberately no
 * waitForTimeout used as a readiness signal anywhere in this file.
 */
export async function scrollAndSettle(page: Page, limiter: ReadLimiter, countSelector: string): Promise<number> {
  await limiter.takeScroll();
  await humanScroll(page, 2);
  return page.evaluate((sel: string) => document.querySelectorAll(sel).length, countSelector);
}
