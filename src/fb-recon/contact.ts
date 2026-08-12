/**
 * Turning what a person typed into something you can actually contact.
 *
 * Facebook publishes no phone and no email on a post, so the reliable contact
 * channel is Messenger, derived from the profile URL. Everything else in here
 * is opportunistic: in Malaysian buy/sell and interest groups people routinely
 * type their own mobile into a comment ("012-345 6789 pm me"), and that
 * self-published number is the highest-value field we can get. We take it when
 * it is offered and never go looking for it anywhere else.
 */

/** Malaysian mobile: 01x followed by 7 or 8 digits, local or +60 form. */
const PHONE_RE = /(?<![\d])(?:\+?60[\s.-]?|0)1\d[\s.-]?\d{3,4}[\s.-]?\d{4}(?![\d])/g;
const WA_RE = /(?:wa\.me\/|api\.whatsapp\.com\/send\/?\?phone=)(\+?\d{8,15})/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]{2,}/g;

/**
 * Path segments that are Facebook features, not people. Without this every
 * group link and photo permalink becomes a phantom "contact".
 */
const NON_PROFILE = new Set([
  'groups', 'photo', 'photos', 'watch', 'reel', 'reels', 'video', 'videos',
  'marketplace', 'events', 'pages', 'hashtag', 'story.php', 'permalink.php',
  'share', 'posts', 'media', 'search', 'notes', 'help', 'privacy', 'policies',
  'settings', 'bookmarks', 'friends', 'gaming', 'live', 'business', 'ads',
]);

export interface ContactFields {
  /** E.164, +60 normalised. */
  phones: string[];
  /** Numbers behind wa.me / api.whatsapp.com links, E.164 normalised. */
  waLinks: string[];
  emails: string[];
}

export interface ProfileIdentity {
  /** Stable dedupe key: the vanity handle, or the numeric id. */
  id: string;
  handle: string | null;
  /**
   * `group-scoped` is a person seen through a group's member link. The id is
   * still the user id, so the same person found in two different groups merges
   * into one contact — the group is context, not identity.
   */
  kind: 'handle' | 'numeric' | 'group-scoped';
}

/** 0123456789 / +60 12-345 6789 / 60123456789 all collapse to +60123456789. */
function normaliseMy(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, '');
  const local = digits.startsWith('60') ? digits.slice(2) : digits.replace(/^0/, '');
  if (!/^1\d{8,9}$/.test(local)) return null;
  return `+60${local}`;
}

export function extractContactFields(text: string): ContactFields {
  const body = text ?? '';

  const phones = new Set<string>();
  for (const m of body.matchAll(PHONE_RE)) {
    const n = normaliseMy(m[0]);
    if (n) phones.add(n);
  }

  const waLinks = new Set<string>();
  for (const m of body.matchAll(WA_RE)) {
    const n = normaliseMy(m[1]);
    if (n) waLinks.add(n);
  }

  const emails = new Set<string>();
  for (const m of body.matchAll(EMAIL_RE)) emails.add(m[0].toLowerCase());

  return { phones: [...phones], waLinks: [...waLinks], emails: [...emails] };
}

export function profileIdentity(url: string | null): ProfileIdentity | null {
  if (!url) return null;

  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return null;

  const segments = u.pathname.split('/').filter(Boolean);

  /**
   * Group-scoped member link: /groups/<gid>/user/<uid>/.
   *
   * This is the ONLY identity form a group post exposes, and groups are where
   * the leads actually are. Measured 2026-08-12 against a live 46.5K-member
   * group: 14 of 14 harvestable people used this shape, and the segment-length
   * rule below rejected every one of them — a silent total loss that looks
   * exactly like "quiet day on Facebook". See the probe doc, finding 2.
   *
   * The id is the USER id, not the group, so one person seen across several
   * groups merges into a single contact.
   */
  if (segments[0] === 'groups' && segments[2] === 'user' && /^\d+$/.test(segments[3] ?? '')) {
    return { id: segments[3], handle: null, kind: 'group-scoped' };
  }

  const numeric = u.pathname.replace(/\/+$/, '').endsWith('/profile.php')
    ? u.searchParams.get('id')
    : null;
  if (numeric && /^\d+$/.test(numeric)) return { id: numeric, handle: null, kind: 'numeric' };

  if (segments.length !== 1) return null;

  const handle = decodeURIComponent(segments[0]);
  if (NON_PROFILE.has(handle.toLowerCase())) return null;
  // pfbid tokens are post identifiers that happen to sit at path root.
  if (/^pfbid/i.test(handle)) return null;
  if (!/^[\w.-]{3,}$/.test(handle)) return null;

  return { id: handle, handle, kind: 'handle' };
}

export function messengerLink(id: ProfileIdentity): string {
  return `https://m.me/${id.handle ?? id.id}`;
}
