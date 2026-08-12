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
