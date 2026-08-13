import type { BrowserContext, Page } from 'patchright';
import * as wa from './whatsapp.js';
import type { SessionRecord, SessionStatus } from './vault.js';

export interface ProbeResult {
  status: SessionStatus;
  detail: string;
  cookieExpiresAt?: string;
}

/** Optional one-click starting points. Purely cosmetic — any URL works. */
export const PRESETS: { label: string; url: string }[] = [
  { label: 'Facebook', url: 'https://www.facebook.com/' },
  { label: 'WhatsApp', url: 'https://web.whatsapp.com/' },
  { label: 'Instagram', url: 'https://www.instagram.com/' },
  { label: 'X / Twitter', url: 'https://x.com/home' },
  { label: 'LinkedIn', url: 'https://www.linkedin.com/feed/' },
  { label: 'Gmail', url: 'https://mail.google.com/' },
  { label: 'YouTube', url: 'https://www.youtube.com/' },
];

/**
 * Sites whose login state is invisible to the cookie + heuristic probes below.
 *
 * The generic path assumes "signed out" looks like a redirect to a login path, a
 * password field, or a sign-in heading, and that a session lives in a cookie.
 * Some apps satisfy none of that. WhatsApp Web is the reference case: it keeps
 * its credentials in IndexedDB, sets no auth cookie, stays on "/" when signed
 * out, and renders its QR screen with zero headings and no password field — so
 * every generic signal reports `ready` while the user is staring at a QR code.
 *
 * For these, readiness is decided by a DOM selector instead. Keyed by session id
 * (see describeUrl in vault.ts), so existing manifests pick this up with no
 * migration.
 */
export interface SiteHint {
  readySelector: string;
  loggedOutSelector: string;
  /** How long the app may take to boot before we call it broken. */
  bootMs: number;
  loggedOutHint: string;
}

export const SITE_HINTS: Record<string, SiteHint> = {
  'web-whatsapp-com': {
    readySelector: wa.READY_SEL,
    loggedOutSelector: wa.LOGGED_OUT_SEL,
    bootMs: 90_000,
    loggedOutHint: 'WhatsApp Web is showing the QR code — ask the user to scan it with their phone.',
  },
};

export function hintFor(rec: SessionRecord): SiteHint | undefined {
  return SITE_HINTS[rec.id];
}

const LOGIN_PATH = /(^|\/)(login|log-in|signin|sign-in|sso|auth|authenticate|session\/new|users\/sign_in)(\/|$|\?)/i;
const CHALLENGE_PATH = /(checkpoint|challenge|verify|two[-_]?factor|2fa|captcha|confirmemail)/i;

/**
 * The registrable-ish domain of an origin: "accounting.autocountcloud.com" ->
 * "autocountcloud.com". Naive last-two-labels, widened to three for the common
 * two-part public suffixes, which is enough to keep siblings together without
 * shipping a public-suffix list.
 */
function baseDomain(origin: string): string {
  const host = new URL(origin).hostname.toLowerCase();
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const tail2 = parts.slice(-2).join('.');
  if (/^(co|com|net|org|gov|edu|ac)\.[a-z]{2}$/.test(tail2)) return parts.slice(-3).join('.');
  return tail2;
}

/**
 * Cookies belonging to the site as a whole, not just the exact origin.
 *
 * `ctx.cookies(origin)` only returns what that one host would send, which loses
 * the session entirely on federated logins: AutoCount Cloud is the reference
 * case — the app on accounting.autocountcloud.com holds its OIDC token in
 * sessionStorage and sets no cookie of its own, while the only durable
 * credential is the IdentityServer cookie on auth.autocountcloud.com.
 */
async function siteCookies(ctx: BrowserContext, origin: string) {
  const base = baseDomain(origin);
  const all = await ctx.cookies();
  return all.filter((c) => {
    const d = c.domain.replace(/^\./, '').toLowerCase();
    return d === base || d.endsWith(`.${base}`);
  });
}

/**
 * Cookie names to remember for a session, captured the moment the user confirms
 * they signed in. httpOnly cookies are the session tokens on essentially every
 * site, so preferring them avoids memorising analytics junk that churns.
 */
export async function learnCookies(ctx: BrowserContext, origin: string): Promise<string[]> {
  const cookies = await siteCookies(ctx, origin);
  const httpOnly = cookies.filter((c) => c.httpOnly && c.value).map((c) => c.name);
  if (httpOnly.length) return [...new Set(httpOnly)].sort();
  // Some sites keep the token in a readable cookie; fall back to persistent ones.
  return [...new Set(cookies.filter((c) => c.value && c.expires > 0).map((c) => c.name))].sort();
}

/** Cheap check: are the learned cookies still present and unexpired? No network. */
export async function quickProbe(ctx: BrowserContext, rec: SessionRecord): Promise<ProbeResult> {
  // A hinted site keeps no auth cookie, so any cookie verdict here would be a
  // guess. Say so and let the caller pay for the real page check.
  if (hintFor(rec)) {
    return { status: 'unknown', detail: 'Login state for this site can only be read from the live page' };
  }

  const cookies = await siteCookies(ctx, rec.origin);
  const byName = new Map(cookies.map((c) => [c.name, c]));

  if (!rec.cookieNames.length) {
    if (!cookies.length) return { status: 'logged_out', detail: `No cookies stored for ${rec.origin}` };
    return { status: 'unknown', detail: 'Session not confirmed yet — press "I\'ve signed in"' };
  }

  const missing = rec.cookieNames.filter((n) => !byName.get(n)?.value);
  if (missing.length) {
    return { status: 'logged_out', detail: `Session cookie gone: ${missing.slice(0, 4).join(', ')}` };
  }

  const expiries = rec.cookieNames.map((n) => byName.get(n)?.expires ?? -1).filter((e) => e > 0);
  const cookieExpiresAt = expiries.length ? new Date(Math.min(...expiries) * 1000).toISOString() : undefined;
  if (cookieExpiresAt && new Date(cookieExpiresAt).getTime() < Date.now()) {
    return { status: 'logged_out', detail: 'Session cookie expired', cookieExpiresAt };
  }

  return { status: 'ready', detail: `${rec.cookieNames.length} session cookie(s) present`, cookieExpiresAt };
}

/**
 * Real check: load the page and look for the universal signs of being signed out.
 * Deliberately site-agnostic — a password field or a redirect to a login path
 * means the same thing everywhere, and nothing here needs per-site knowledge.
 */
export async function deepProbe(ctx: BrowserContext, page: Page, rec: SessionRecord): Promise<ProbeResult> {
  const quick = await quickProbe(ctx, rec);
  if (quick.status === 'logged_out') return quick;

  try {
    await page.goto(rec.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } catch (err) {
    return { ...quick, status: 'error', detail: `Could not load ${rec.url}: ${(err as Error).message}` };
  }

  // Hinted sites decide on their own selectors, before the generic heuristics get
  // a chance to be confidently wrong about them.
  const hint = hintFor(rec);
  if (hint) {
    const deadline = Date.now() + hint.bootMs;
    while (Date.now() < deadline) {
      const seen = await page.evaluate(
        ([ready, out]) => {
          if (document.querySelector(ready)) return 'ready';
          if (document.querySelector(out)) return 'logged_out';
          return null;
        },
        [hint.readySelector, hint.loggedOutSelector],
      );
      if (seen === 'ready') return { ...quick, status: 'ready', detail: `Signed in — verified against ${page.url()}` };
      if (seen === 'logged_out') return { ...quick, status: 'logged_out', detail: hint.loggedOutHint };
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { ...quick, status: 'error', detail: `${rec.label} did not finish loading — could not read its login state` };
  }

  const landed = page.url();
  const landedPath = (() => {
    try {
      return new URL(landed).pathname + new URL(landed).search;
    } catch {
      return landed;
    }
  })();

  if (CHALLENGE_PATH.test(landedPath)) {
    return { ...quick, status: 'logged_out', detail: `Site is challenging this session: ${landed}` };
  }
  if (LOGIN_PATH.test(landedPath)) {
    return { ...quick, status: 'logged_out', detail: `Redirected to a login page: ${landed}` };
  }

  const signs = await page.evaluate(() => ({
    password: !!document.querySelector('input[type="password"]'),
    signInText: /\b(sign in|log in|login)\b/i.test((document.querySelector('h1,h2')?.textContent ?? '').slice(0, 120)),
  }));

  if (signs.password) {
    return { ...quick, status: 'logged_out', detail: 'Password field present — the site wants a fresh login' };
  }
  if (signs.signInText) {
    return { ...quick, status: 'logged_out', detail: 'Page heading is a sign-in prompt' };
  }

  return { ...quick, status: 'ready', detail: `Verified against ${landed}` };
}
