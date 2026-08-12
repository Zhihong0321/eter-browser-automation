// gmap-recon — Google Maps page functions.
//
// NOT eter-browser RECON. `src/recon.ts` is the authenticated-SaaS site-mapper and
// hard-blocks google.com by design; nothing here imports it or relaxes it. This is a
// separate subsystem that gathers intel ON COMPANIES from public Maps search.
//
// Everything below is derived from measured probe output (see
// docs/superpowers/specs/2026-08-12-gmap-recon-design.md §1, §5), not from guessing
// at selectors. The two findings that shape this file:
//
//   1. Phone AND website are readable from the search FEED. No detail click. That is
//      ~100 Google requests per campaign instead of ~6,000.
//   2. Google SILENTLY degrades a profile that has been searching: a fresh profile
//      returned 101 results, the same profile minutes later returned 64. No captcha,
//      no error, no empty feed — just a third of the businesses missing. So yield is
//      treated as a health signal, not as ground truth (see SearchLimiter + canary).

import type { BrowserContext, Page } from 'patchright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { BusinessInput, EnrichInput } from './leads.js';

// ------------------------------------------------------------------- selectors

const FEED = 'div[role="feed"]';
const LINK = 'a[href*="/maps/place/"]';
const CARD = 'div[role="feed"] > div';

/** Malaysian formats: 019-207 4988, +60 3-1234 5678, 03-12345678. */
const PHONE_RE = /(?:\+?6?0)\d[\d\s-]{6,}\d/;

/** Coordinates ride in the place href — exact, and free. `!3d<lat>!4d<lng>`. */
const LATLNG_RE = /!3d(-?[\d.]+)!4d(-?[\d.]+)/;
/** Stable place key. The CID pair is preferred; the /g/ feature id is the fallback. */
const CID_RE = /!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i;
const FEATURE_RE = /!16s(%2F[gm]%2F\w+)/i;

const BOOT_MS = 45_000;
/** Confirmation rounds at a flat count before calling it a plateau. Probe-tuned. */
const STABLE_ROUNDS = 10;
const SCROLL_CADENCE_MS = 1_300;
const MAX_SCROLL_ROUNDS = 150;

// ------------------------------------------------------------- challenge gates

/**
 * Checked BEFORE extraction on every navigation. An empty feed is deliberately NOT
 * in here: during a soft block it is indistinguishable from a town with no matches,
 * and writing `found: 0` would silently corrupt the dataset (rule #15).
 */
export function detectChallenge(url: string, bodyText: string): string | null {
  if (/\/sorry\/|\/recaptcha\//.test(url)) return `blocked: sorry-redirect (${url})`;
  if (/consent\.google\.com/.test(url)) return `blocked: consent wall (${url}) — not auto-accepted`;
  if (/unusual traffic|not a robot|systems have detected/i.test(bodyText)) return 'blocked: captcha text in body';
  return null;
}

// -------------------------------------------------------------- rate budgeting

export interface SearchLimits {
  perMinute: number;
  perHour: number;
  perDay: number;
  /** Jittered floor between searches. A fixed interval is itself a bot signal. */
  minGapMs: number;
  maxGapMs: number;
}

export const DEFAULT_LIMITS: SearchLimits = {
  perMinute: 2,
  perHour: 60,
  perDay: 400,
  minGapMs: 15_000,
  maxGapMs: 40_000,
};

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Persisted sliding-window budget, same shape as src/sendlimit.ts and for the same
 * reason: the daemon restarts often, and an in-memory counter hands back a fresh
 * budget every time it comes up.
 */
export class SearchLimiter {
  #history: number[] = [];

  constructor(
    private readonly file: string,
    private readonly limits: SearchLimits = DEFAULT_LIMITS,
  ) {
    try {
      this.#history = JSON.parse(readFileSync(file, 'utf8')) as number[];
    } catch {
      this.#history = [];
    }
  }

  #save(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.#history));
    } catch {
      // A budget that cannot persist still throttles this process; losing the file
      // is not worth failing a harvest over.
    }
  }

  #waitMs(now: number): number {
    const within = (ms: number): number[] => this.#history.filter((t) => now - t < ms);
    const waits: number[] = [];
    const m = within(MINUTE);
    if (m.length >= this.limits.perMinute) waits.push(m[0] + MINUTE - now);
    const h = within(HOUR);
    if (h.length >= this.limits.perHour) waits.push(h[0] + HOUR - now);
    const d = within(DAY);
    if (d.length >= this.limits.perDay) waits.push(d[0] + DAY - now);
    return waits.length ? Math.max(0, Math.max(...waits)) : 0;
  }

  /** Blocks until a slot frees, then adds the jittered human-plausible gap. */
  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.#history = this.#history.filter((t) => now - t < DAY);
      const wait = this.#waitMs(now);
      if (wait <= 0) break;
      // Re-check periodically rather than sleeping the whole span: a long opaque
      // block is indistinguishable from a hang.
      await sleep(Math.min(wait, 15_000));
    }
    const last = this.#history[this.#history.length - 1];
    if (last !== undefined) {
      const { minGapMs, maxGapMs } = this.limits;
      const gap = minGapMs + Math.random() * (maxGapMs - minGapMs);
      const since = Date.now() - last;
      if (since < gap) await sleep(gap - since);
    }
    this.#history.push(Date.now());
    this.#save();
  }

  snapshot(): { lastMinute: number; lastHour: number; today: number } {
    const now = Date.now();
    return {
      lastMinute: this.#history.filter((t) => now - t < MINUTE).length,
      lastHour: this.#history.filter((t) => now - t < HOUR).length,
      today: this.#history.filter((t) => now - t < DAY).length,
    };
  }
}

// ------------------------------------------------------------------ extraction

/**
 * Runs IN PAGE. Fields are matched by SHAPE, not by line index — Maps reorders and
 * omits lines per business, so `lines[3]` is a bug waiting to happen. Mirrors the
 * READ_CHATS idiom in src/whatsapp.ts.
 */
const READ_FEED = ([cardSel, linkSel, phoneSrc]: [string, string, string]) => {
  const phone = new RegExp(phoneSrc);
  const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

  return Array.from(document.querySelectorAll(cardSel))
    .map((card) => {
      const link = card.querySelector(linkSel) as HTMLAnchorElement | null;
      if (!link) return null;

      const lines = ((card as HTMLElement).innerText || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      const phoneLine = lines.find((l) => phone.test(l)) ?? null;
      // The hours line also contains ' · ', so the category line is the first one
      // carrying a separator that is NOT the phone line.
      const metaLine = lines.find((l) => l.includes(' · ') && l !== phoneLine) ?? null;
      const hoursLine = lines.find((l) => /^(open|clos|temporarily|permanently)/i.test(l)) ?? null;

      // Rating and review count share ONE aria-label — "4.7 stars 14 Reviews" — and
      // the visible line concatenates them with no separator: "4.7(14)". Reading a
      // bare number off either puts the rating in the reviews column, which is how
      // 26 businesses came out claiming "5 reviews" when they meant 5.0 stars.
      const stars = (card.querySelector('[aria-label*="star" i]')?.getAttribute('aria-label') ?? '')
        .match(/([\d.]+)\s*stars?\s+([\d,]+)\s*review/i);
      const inline = (lines.find((l) => /^\d(?:\.\d)?\([\d,]+\)$/.test(l)) ?? '')
        .match(/^(\d(?:\.\d)?)\(([\d,]+)\)$/);

      return {
        name: clean(link.getAttribute('aria-label')) || clean(lines[0]),
        href: link.href,
        rating: stars?.[1] ?? inline?.[1] ?? null,
        reviews: stars?.[2] ?? inline?.[2] ?? null,
        category: metaLine ? clean(metaLine.split(' · ')[0]) : null,
        address: metaLine ? clean(metaLine.split(' · ').slice(1).join(' · ')) : null,
        phone: phoneLine ? clean((phoneLine.match(phone) ?? [''])[0]) : null,
        hours: hoursLine ? clean(hoursLine.split(' · ').filter((p) => !phone.test(p)).join(' · ')) : null,
        website:
          Array.from(card.querySelectorAll('a[href]'))
            .map((a) => (a as HTMLAnchorElement).href)
            .find((h) => h && !h.includes('/maps/') && !h.startsWith('#')) ?? null,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);
};

/**
 * Runs IN PAGE on a DETAIL page. Google skips the results list when a query matches
 * one business strongly, navigating straight to /maps/place/ — there is no feed
 * there, which showed up as a 45s selector timeout and a silent zero.
 */
const READ_PLACE = () => {
  const items = Array.from(document.querySelectorAll('[data-item-id]'));
  const byId = (prefix: string): Element | undefined =>
    items.find((e) => (e.getAttribute('data-item-id') ?? '').startsWith(prefix));
  const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

  const phoneEl = byId('phone:tel:');
  const addrEl = byId('address');
  const siteEl = byId('authority');

  return {
    name: clean(document.querySelector('h1')?.textContent),
    address: clean(addrEl?.getAttribute('aria-label')).replace(/^Address:\s*/i, '') || null,
    phone: phoneEl ? (phoneEl.getAttribute('data-item-id') ?? '').replace('phone:tel:', '') : null,
    website: siteEl?.getAttribute('href') ?? null,
    category: clean(document.querySelector('button[jsaction*="category"]')?.textContent) || null,
    stars: document.querySelector('[aria-label*="star" i]')?.getAttribute('aria-label') ?? '',
  };
};

const num = (s: string | null): number | null => {
  if (!s) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** Prefers the CID pair; falls back to the /g/ feature id; last resort is the path. */
function placeKey(href: string): string | null {
  const cid = href.match(CID_RE)?.[1];
  if (cid) return cid;
  const feat = href.match(FEATURE_RE)?.[1];
  if (feat) return decodeURIComponent(feat);
  return href.match(/\/maps\/place\/([^/]+)/)?.[1] ?? null;
}

// --------------------------------------------------------------------- actions

export async function warmPage(ctx: BrowserContext, fallback: Page, pin: (p: Page) => void): Promise<Page> {
  const open = ctx.pages().filter((p) => !p.isClosed());
  const page = open[0] ?? fallback;
  pin(page);
  return page;
}

export interface SearchOutcome {
  businesses: BusinessInput[];
  found: number;
  /** Result count plateaued. Ambiguous on its own — cross-check against the canary. */
  hitCap: boolean;
  curve: number[];
}

/**
 * One keyword × place search, scrolled to plateau.
 *
 * `hitCap` means "the count stopped growing", which is NOT the same as "this town is
 * saturated" — a throttled profile plateaus early and looks identical. The canary in
 * src/service.ts is what disambiguates the two.
 */
export async function searchPlace(page: Page, keyword: string, place: string): Promise<SearchOutcome> {
  const query = `${keyword} ${place}`.trim();
  await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en&gl=my`, {
    waitUntil: 'domcontentloaded',
    timeout: BOOT_MS,
  });

  const gate = detectChallenge(page.url(), await page.evaluate(() => document.body.innerText.slice(0, 2000)));
  if (gate) throw new Error(gate);

  // Readiness is the DATA'S SHAPE — at least one place link inside the feed — never a
  // fixed timeout and never a container's mere presence (rules #13, #14).
  // Single-result redirect: Maps went straight to one business instead of a list.
  if (/\/maps\/place\//.test(page.url())) {
    const one = await readSinglePlace(page);
    return { businesses: one ? [one] : [], found: one ? 1 : 0, hitCap: false, curve: [one ? 1 : 0] };
  }

  try {
    await page.waitForFunction(
      ([f, l]: [string, string]) => (document.querySelector(f)?.querySelectorAll(l).length ?? 0) > 0,
      [FEED, LINK] as [string, string],
      { timeout: BOOT_MS, polling: 250 },
    );
  } catch {
    // A stale Chrome on the same profile answers navigation but renders nothing, so
    // the honest report is "the page never showed results", plus where to look.
    const at = page.url();
    throw new Error(
      `no results feed after ${BOOT_MS / 1000}s at ${at}. Either Google served an ` +
        'unexpected page, or another Chrome is already using the gmaprecon profile ' +
        '(close it and retry).',
    );
  }

  const curve: number[] = [];
  let last = -1;
  let stable = 0;
  let ended = false;

  for (let i = 0; i < MAX_SCROLL_ROUNDS && stable < STABLE_ROUNDS && !ended; i++) {
    const seen = await page.evaluate(
      ([l]: [string]) => ({
        n: document.querySelectorAll(l).length,
        end: /reached the end of the list/i.test(document.body.innerText),
      }),
      [LINK] as [string],
    );
    curve.push(seen.n);
    ended = seen.end;
    stable = seen.n === last ? stable + 1 : 0;
    last = seen.n;
    if (ended) break;

    await page.evaluate((f: string) => {
      const el = document.querySelector(f);
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
    }, FEED);
    // A measurement cadence, not a readiness wait.
    await page.waitForTimeout(SCROLL_CADENCE_MS);
  }

  const cards = await page.evaluate(READ_FEED, [CARD, LINK, PHONE_RE.source] as [string, string, string]);

  const businesses: BusinessInput[] = [];
  for (const c of cards) {
    const placeId = placeKey(c.href);
    if (!placeId || !c.name) continue;
    const ll = c.href.match(LATLNG_RE);
    businesses.push({
      placeId,
      name: c.name,
      address: c.address,
      lat: ll ? Number(ll[1]) : null,
      lng: ll ? Number(ll[2]) : null,
      phone: c.phone,
      website: c.website,
      category: c.category,
      rating: num(c.rating),
      reviews: num(c.reviews),
      hours: c.hours,
      mapsUrl: c.href,
    });
  }

  // `ended` is a real end-of-list marker; a bare plateau is only a soft cap.
  return { businesses, found: businesses.length, hitCap: !ended, curve };
}

/** One business, read off a detail page reached by a single-result redirect. */
async function readSinglePlace(page: Page): Promise<BusinessInput | null> {
  await page
    .waitForFunction(() => !!document.querySelector('[data-item-id]'), null, { timeout: 20_000, polling: 250 })
    .catch(() => {});

  const p = await page.evaluate(READ_PLACE);
  const href = page.url();
  const placeId = placeKey(href);
  if (!placeId || !p.name) return null;

  const ll = href.match(LATLNG_RE);
  const stars = p.stars.match(/([\d.]+)\s*stars?\s+([\d,]+)\s*review/i);
  return {
    placeId,
    name: p.name,
    address: p.address,
    lat: ll ? Number(ll[1]) : null,
    lng: ll ? Number(ll[2]) : null,
    phone: p.phone,
    website: p.website,
    category: p.category,
    rating: num(stars?.[1] ?? null),
    reviews: num(stars?.[2] ?? null),
    hours: null,
    mapsUrl: href,
  };
}

// ------------------------------------------------------- stage 2: website enrich

/**
 * Addresses belonging to embedded platforms rather than the business. Widgets, map
 * embeds, analytics and CMS boilerplate all leave these in the HTML — a live probe
 * pulled `press@google.com` off a solar installer's site, which in a lead list is
 * worse than no email at all.
 */
const PLATFORM_EMAIL =
  /@(?:google|gstatic|googleapis|google-analytics|youtube|facebook|fb|instagram|twitter|wordpress|wix|wixpress|squarespace|shopify|sentry|cloudflare|jquery|bootstrapcdn|schema|w3|example|domain|yourdomain|email|sentry\.io)\./i;
/** Filenames that look like addresses once an @2x asset path is regex-matched. */
const ASSET_EMAIL = /\.(?:png|jpe?g|gif|svg|webp|css|js|woff2?)$|@\dx\./i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

const SOCIALS: { key: keyof Pick<EnrichInput, 'facebook' | 'instagram' | 'whatsapp' | 'linkedin'>; re: RegExp }[] = [
  { key: 'facebook', re: /https?:\/\/(?:www\.)?(?:facebook|fb)\.com\/[^\s"'<>)]+/i },
  { key: 'instagram', re: /https?:\/\/(?:www\.)?instagram\.com\/[^\s"'<>)]+/i },
  { key: 'whatsapp', re: /https?:\/\/(?:wa\.me|api\.whatsapp\.com)\/[^\s"'<>)]+/i },
  { key: 'linkedin', re: /https?:\/\/(?:[a-z]{2}\.)?linkedin\.com\/[^\s"'<>)]+/i },
];

/**
 * Pure over HTML so it is testable without a network or a browser.
 *
 * `siteHost` is the business's own domain. An address on that domain is almost
 * certainly theirs, so those sort first and become the primary `email`; anything
 * else is a fallback, and platform addresses are dropped outright.
 */
export function extractContacts(html: string, siteHost = ''): EnrichInput {
  const own = siteHost.toLowerCase().replace(/^www\./, '');
  const found = [...new Set((html.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))].filter(
    (e) => !PLATFORM_EMAIL.test(e) && !ASSET_EMAIL.test(e),
  );
  const emails = [
    ...found.filter((e) => own && e.endsWith(`@${own}`)),
    ...found.filter((e) => !own || !e.endsWith(`@${own}`)),
  ].slice(0, 10);

  const out: EnrichInput = {
    email: emails[0] ?? null,
    emails,
    facebook: null,
    instagram: null,
    whatsapp: null,
    linkedin: null,
  };
  for (const { key, re } of SOCIALS) out[key] = html.match(re)?.[0] ?? null;
  return out;
}

const CONTACT_PATHS = ['', '/contact', '/contact-us', '/about'];

/**
 * Plain fetch, deliberately not the browser: these are ordinary sites, the repo has
 * exactly ONE Chrome (one user-data-dir), and routing 2,000 site visits through it
 * would block every other automation for hours. Also a different rate domain from
 * Google entirely.
 */
export async function enrichSite(website: string, timeoutMs = 10_000): Promise<EnrichInput> {
  let base: URL;
  try {
    base = new URL(website);
  } catch {
    throw new Error(`unparseable website url: ${website}`);
  }

  let merged: EnrichInput | null = null;
  for (const p of CONTACT_PATHS) {
    const ctl = AbortSignal.timeout(timeoutMs);
    let html: string;
    try {
      const res = await fetch(new URL(p, base), {
        signal: ctl,
        redirect: 'follow',
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0 Safari/537.36' },
      });
      if (!res.ok) continue;
      html = (await res.text()).slice(0, 400_000);
    } catch {
      continue; // one dead path must not sink the whole business
    }

    const found = extractContacts(html, base.hostname);
    merged = merged
      ? {
          email: merged.email ?? found.email,
          emails: [...new Set([...merged.emails, ...found.emails])].slice(0, 10),
          facebook: merged.facebook ?? found.facebook,
          instagram: merged.instagram ?? found.instagram,
          whatsapp: merged.whatsapp ?? found.whatsapp,
          linkedin: merged.linkedin ?? found.linkedin,
        }
      : found;

    if (merged.email) break; // an email is the expensive field; stop once we have one
  }

  if (!merged) throw new Error('no reachable page');
  return merged;
}
