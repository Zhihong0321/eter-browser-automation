// gmap-review-radar — Google Maps REVIEW page functions.
//
// Separate tool from gmap-recon. gmap-recon answers "which companies exist"; radar
// answers "what do their customers actually say". It imports gmap-recon's search and
// budget helpers READ-ONLY and modifies nothing there.
//
// The cost model is the opposite of gmap-recon's. gmap-recon never clicks a business,
// which is what keeps a campaign near 100 Google requests. Reviews are only reachable
// by opening each place and scrolling its review pane, which lazy-loads TEN at a time,
// so radar is inherently a per-company, overnight, resumable job.
//
// Every selector below came out of a live probe (scratchpad probe-reviews /
// probe-scroll, 2026-08-12, buySolar | Solar Panel Malaysia Marketplace, 50 reviews),
// not out of memory. What that probe established:
//
//   1. The outermost [data-review-id] node is the review card. The SAME id is repeated
//      on ~6 nested buttons, so a bare querySelectorAll('[data-review-id]') counts one
//      review six times.
//   2. A review body and an owner's reply are both `.wiI7pd`. The reply lives inside
//      `.CDe7pd`. Reading `.wiI7pd` unscoped puts the company's own marketing copy in
//      the customer-review column — the same class of bug as gmap-recon's rating vs
//      review-count mixup, and far harder to spot in a 5,000-row sheet.
//   3. Truncated text needs TWO different expanders: jsaction `expandReview` for the
//      customer's text and `expandOwnerResponse` for the reply. Expanding only the
//      first silently stores every long review ending in "…".
//   4. The reviews header declares the true total ("50 reviews"). Scroll plateau alone
//      is not proof of completeness — a throttled pane plateaus early and looks
//      identical — so harvested-vs-declared is what decides `complete`.

import type { Page } from 'patchright';
import { detectChallenge } from './gmaprecon.js';

// ------------------------------------------------------------------- row types

export interface ReviewInput {
  reviewId: string;
  placeId: string;
  author: string | null;
  authorUrl: string | null;
  /** Raw byline, e.g. "Local Guide · 52 reviews · 30 photos". */
  authorMeta: string | null;
  localGuide: boolean;
  authorReviews: number | null;
  rating: number | null;
  /** Exactly as Google renders it — "3 years ago". Maps exposes nothing absolute. */
  dateText: string | null;
  /** Derived from dateText at harvest time. APPROXIMATE by construction. */
  approxDate: string | null;
  lang: string | null;
  text: string | null;
  photos: number;
  replyText: string | null;
  replyDateText: string | null;
  harvestedAt: string;
}

export interface ReviewHarvest {
  reviews: ReviewInput[];
  /** What the page says the company has. Null when the header could not be read. */
  declared: number | null;
  harvested: number;
  /** harvested >= declared. False means the sheet is missing reviews — never hide it. */
  complete: boolean;
  curve: number[];
  sortedBy: string | null;
}

// ------------------------------------------------------------------- selectors

const REVIEWS_TAB = '[role="tab"][aria-label^="Reviews for"]';
const SORT_BUTTON = 'button[aria-label="Sort reviews"]';
const SORT_ITEM = '[role="menuitemradio"], [role="menuitem"]';

/**
 * Outermost review cards. Evaluated as a string because both the waiter and the
 * scroller need the same definition and a drifted copy is a silent miscount.
 */
const CARDS = `Array.from(document.querySelectorAll('[data-review-id]'))
  .filter((e) => !e.parentElement || !e.parentElement.closest('[data-review-id]'))`;

const BOOT_MS = 45_000;
const SCROLL_CADENCE_MS = 1_200;
const STABLE_ROUNDS = 5;
/** Flat rounds tolerated while the page still declares more reviews than are loaded. */
const PATIENT_ROUNDS = 20;
/** 10 reviews per lazy batch × 400 rounds ≈ 4,000 reviews. Nothing here goes deeper. */
const MAX_SCROLL_ROUNDS = 400;
const MAX_EXPAND_PASSES = 6;

// ------------------------------------------------------------- relative dates

const UNIT_DAYS: Record<string, number> = {
  minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30.44, year: 365.25,
};

/**
 * "3 years ago" → an ISO date. Approximate ON PURPOSE and named so: Maps renders only
 * relative ages, and "a year ago" covers a twelve-month span. Good enough to sort and
 * to bucket by year; not good enough to claim a review landed on a given day.
 */
export function approxDate(dateText: string | null, at = new Date()): string | null {
  if (!dateText) return null;
  const s = dateText.toLowerCase().trim();
  if (/just now|moments? ago/.test(s)) return at.toISOString().slice(0, 10);
  if (/yesterday/.test(s)) return new Date(at.getTime() - 86_400_000).toISOString().slice(0, 10);

  const m = s.match(/(?:^|\s)(\d+|a|an)\s+(minute|hour|day|week|month|year)s?\s+ago/);
  if (!m) return null;
  const n = m[1] === 'a' || m[1] === 'an' ? 1 : Number(m[1]);
  const days = UNIT_DAYS[m[2]];
  if (!Number.isFinite(n) || !days) return null;
  return new Date(at.getTime() - n * days * 86_400_000).toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ extraction

/**
 * Runs IN PAGE. Reads the reply block FIRST and then treats it as a no-go zone for
 * every other field, because the customer's rating, date and text all have a
 * same-classed twin inside the owner's response.
 */
const READ_REVIEWS = (placeId: string) => {
  const cards = Array.from(document.querySelectorAll('[data-review-id]')).filter(
    (e) => !e.parentElement || !e.parentElement.closest('[data-review-id]'),
  );
  const clean = (s: string | null | undefined): string | null => {
    const t = (s ?? '').replace(/\s+/g, ' ').trim();
    return t || null;
  };
  // The expander leaves its own label glued to the end of the text it expanded.
  const unbutton = (s: string | null): string | null =>
    clean((s ?? '').replace(/\s*(?:…\s*)?\b(?:More|Less)\s*$/, ''));

  return cards.map((card) => {
    // --- the reply block, so everything below can exclude it -------------------
    let reply: Element | null = card.querySelector('div.CDe7pd');
    if (!reply) {
      const label = Array.from(card.querySelectorAll('span')).find((s) =>
        /^response from the owner$/i.test((s.textContent ?? '').trim()),
      );
      reply = label?.closest('div')?.parentElement ?? null;
    }
    const outside = (el: Element | null | undefined): boolean =>
      !!el && (!reply || !reply.contains(el));

    // --- customer fields -------------------------------------------------------
    const starEl = Array.from(card.querySelectorAll('[role="img"][aria-label*="star" i]')).find(outside);
    const ratingText = starEl?.getAttribute('aria-label')?.match(/([\d.]+)\s*star/i)?.[1] ?? null;

    const dateEl =
      Array.from(card.querySelectorAll('span.rsqaWe')).find(outside) ??
      Array.from(card.querySelectorAll('span')).find(
        (s) => outside(s) && /\bago$|^yesterday$|^just now$/i.test((s.textContent ?? '').trim()),
      );

    const bodyEl =
      (Array.from(card.querySelectorAll('div.MyEned')).find(outside) as HTMLElement | undefined) ??
      (Array.from(card.querySelectorAll('.wiI7pd')).find(outside) as HTMLElement | undefined);
    const bodySpan = bodyEl?.querySelector('span.wiI7pd') as HTMLElement | null;

    const byline = card.querySelector('div.RfnDt');
    const metaText = clean(byline?.textContent);
    const contrib = card.querySelector('button[data-href*="/maps/contrib/"]');

    return {
      reviewId: card.getAttribute('data-review-id') ?? '',
      placeId,
      // Measured: the outermost card's aria-label IS the reviewer's name.
      author: clean(card.getAttribute('aria-label')) ?? clean(card.querySelector('div.d4r55')?.textContent),
      authorUrl: contrib?.getAttribute('data-href') ?? null,
      authorMeta: metaText,
      localGuide: /local guide/i.test(metaText ?? ''),
      authorReviews: metaText?.match(/([\d,]+)\s*reviews?/i)?.[1] ?? null,
      rating: ratingText,
      dateText: clean(dateEl?.textContent),
      lang: bodyEl?.getAttribute('lang') ?? bodyEl?.closest('[lang]')?.getAttribute('lang') ?? null,
      text: unbutton(bodySpan?.textContent ?? bodyEl?.textContent ?? null),
      photos: card.querySelectorAll('button[data-photo-index]').length,
      replyText: reply
        ? unbutton(
            (reply.querySelector('.wiI7pd') as HTMLElement | null)?.textContent ??
              (reply as HTMLElement).innerText.replace(/^response from the owner\s*/i, ''),
          )
        : null,
      replyDateText: clean(reply?.querySelector('span.DZSIDd')?.textContent),
    };
  });
};

const num = (s: string | null): number | null => {
  if (!s) return null;
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

// --------------------------------------------------------------------- actions

/** "4.8\n50 reviews" in the pane header — the only trustworthy completeness target. */
function declaredCount(headerText: string): number | null {
  const m = headerText.match(/([\d,]+)\s+reviews?\b/i);
  return m ? num(m[1]) : null;
}

export { declaredCount as parseDeclaredCount };

/**
 * Open one company's review pane, sort it Newest, scroll it out, expand every
 * truncated body, and read the lot.
 *
 * Newest rather than Google's default Most-relevant: if the run is cut short the rows
 * banked are then a clean "everything since date X" slice instead of an unreproducible
 * relevance sample.
 */
export async function readReviews(page: Page, placeId: string, mapsUrl: string): Promise<ReviewHarvest> {
  const url = mapsUrl.includes('hl=') ? mapsUrl : `${mapsUrl}${mapsUrl.includes('?') ? '&' : '?'}hl=en`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: BOOT_MS });

  const gate = detectChallenge(page.url(), await page.evaluate(() => document.body.innerText.slice(0, 2000)));
  if (gate) throw new Error(gate);

  // A locator, never evaluate-after-a-sleep: Maps re-navigates while it boots and
  // destroys whatever execution context a fixed wait happened to land in.
  const tab = page.locator(REVIEWS_TAB).first();
  await tab.waitFor({ state: 'visible', timeout: BOOT_MS });
  await tab.click();

  const header = await page
    .locator('[role="main"]')
    .first()
    .innerText({ timeout: BOOT_MS })
    .catch(() => '');
  const declared = declaredCount(header);

  // A company with no reviews is a real, common outcome — not a failure, and not an
  // empty feed to panic about. Say so and leave.
  if (declared === 0) {
    return { reviews: [], declared: 0, harvested: 0, complete: true, curve: [], sortedBy: null };
  }

  await page.waitForFunction(`${CARDS}.length > 0`, undefined, { timeout: BOOT_MS, polling: 250 });

  // ------------------------------------------------------------------- sort
  let sortedBy: string | null = null;
  try {
    await page.locator(SORT_BUTTON).first().click({ timeout: 10_000 });
    await page.waitForSelector(SORT_ITEM, { timeout: 10_000 });
    sortedBy = await page.evaluate((sel: string) => {
      const items = Array.from(document.querySelectorAll(sel));
      const pick =
        items.find((m) => /^newest$/i.test((m as HTMLElement).innerText.trim())) ??
        items.find((m) => m.getAttribute('data-index') === '1');
      if (!pick) return null;
      (pick as HTMLElement).click();
      return (pick as HTMLElement).innerText.trim();
    }, SORT_ITEM);
    // Re-sorting rebuilds the list; wait for cards to come back rather than assuming.
    await page.waitForFunction(`${CARDS}.length > 0`, undefined, { timeout: BOOT_MS, polling: 250 });
  } catch {
    // Sort is a nicety. Losing it costs ordering, not data, so it must not sink the
    // company — `sortedBy` stays null and the caller can see which rows are ordered.
  }

  // ----------------------------------------------------------------- scroll
  const curve: number[] = [];
  let last = -1;
  let stable = 0;
  for (let i = 0; i < MAX_SCROLL_ROUNDS && stable < STABLE_ROUNDS; i++) {
    const n = Number(await page.evaluate(`${CARDS}.length`));
    curve.push(n);
    stable = n === last ? stable + 1 : 0;
    last = n;
    if (declared !== null && n >= declared) break;

    // Patience is set by the DECLARED count, not by a fixed number of flat rounds.
    // Measured: a 151-review pane stalls for several seconds mid-list, and five flat
    // rounds at 1.2s gave up at 20 of 151. While the page itself says more exist,
    // keep pulling; only a list with no target falls back to the quick plateau.
    if (declared !== null && n < declared && stable < PATIENT_ROUNDS) stable = 0;

    // The scroller is DISCOVERED — the nearest ancestor of a card that actually
    // overflows — because its class (m6QErb DxyBCb kA9KIf dS8AEf) is obfuscated and
    // rotates. Hardcoding it means a silent zero-scroll the day Google reshuffles.
    await page.evaluate(`(() => {
      const card = ${CARDS}[0];
      if (!card) return;
      let el = card.parentElement;
      while (el && !(el.scrollHeight > el.clientHeight + 100 && el.clientHeight > 200)) el = el.parentElement;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
    })()`);
    await page.waitForTimeout(SCROLL_CADENCE_MS);
  }

  // ----------------------------------------------------------------- expand
  // Two distinct expanders, and clicking a batch reveals more, so loop to a fixpoint.
  for (let pass = 0; pass < MAX_EXPAND_PASSES; pass++) {
    const clicked = await page.evaluate(() => {
      // Keyed on jsaction alone: aria-label is user-facing text and a review whose
      // label differs was silently left truncated, ending the stored text in "…".
      const btns = Array.from(
        document.querySelectorAll('button[jsaction*="expandReview"], button[jsaction*="expandOwnerResponse"]'),
      ).filter((b) => b.getAttribute('aria-expanded') !== 'true');
      btns.forEach((b) => (b as HTMLElement).click());
      return btns.length;
    });
    if (!clicked) break;
    await page.waitForTimeout(900);
  }

  // ---------------------------------------------------------------- extract
  const raw = await page.evaluate(READ_REVIEWS, placeId);
  const harvestedAt = new Date().toISOString();
  const at = new Date(harvestedAt);

  const seen = new Set<string>();
  const reviews: ReviewInput[] = [];
  for (const r of raw) {
    if (!r.reviewId || seen.has(r.reviewId)) continue;
    seen.add(r.reviewId);
    reviews.push({
      ...r,
      authorReviews: num(r.authorReviews),
      rating: num(r.rating),
      approxDate: approxDate(r.dateText, at),
      harvestedAt,
    });
  }

  return {
    reviews,
    declared,
    harvested: reviews.length,
    complete: declared !== null && reviews.length >= declared,
    curve,
    sortedBy,
  };
}

// ---------------------------------------------------------------------- export

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // A leading =, + or - makes Excel evaluate the cell as a formula.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv<T extends object>(columns: readonly (keyof T & string)[], rows: T[]): string {
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
