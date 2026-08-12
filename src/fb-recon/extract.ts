/**
 * In-page extractors.
 *
 * These functions are stringified and evaluated inside the page, so they can
 * close over nothing from Node — every constant is injected by string
 * substitution, the same pattern facebook.ts uses. If a PLACEHOLDER ever
 * survives into the evaluated source the extractor silently returns zero rows,
 * which reads as "quiet day on Facebook" rather than as the bug it is. That is
 * what the unit test guards.
 *
 * The difference from facebook.ts's extractor is small and load-bearing: that
 * one reads the author's NAME off `a[aria-label]` and discards the anchor. We
 * keep its href, because the profile URL is the whole contact.
 *
 * SELECTORS BELOW WILL DRIFT. Facebook reshapes this DOM constantly. They are
 * named constants for exactly that reason — when a sweep starts returning zero
 * comments, this is the file to fix, and it should be a one-line edit.
 */
import { ACTION_SEL, MESSAGE_SEL } from '../facebook.js';

/** Facebook renders each comment as an article labelled "Comment by <name>". */
const COMMENT_SEL = '[role="article"][aria-label*="omment" i]';

declare const MESSAGE_SEL_PLACEHOLDER: string;
declare const COMMENT_SEL_PLACEHOLDER: string;
declare const ACTION_SEL_PLACEHOLDER: string;

export interface RawPost {
  index: number;
  author: string | null;
  authorUrl: string | null;
  text: string;
  permalink: string | null;
  timestamp: string | null;
  truncated: boolean;
}

export interface RawComment {
  index: number;
  author: string | null;
  authorUrl: string | null;
  text: string;
}

const POST_EXTRACT = () => {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const permaRe = /\/(posts|permalink|videos|photo|reel|share)\/|story_fbid=|pfbid|multi_permalinks=/;

  const tidyUrl = (href: string | null): string | null => {
    if (!href) return null;
    try {
      const u = new URL(href, location.origin);
      for (const k of [...u.searchParams.keys()]) if (k.startsWith('__')) u.searchParams.delete(k);
      return u.toString();
    } catch {
      return null;
    }
  };

  /**
   * The author anchor, chosen by HREF SHAPE rather than document order.
   *
   * `root.querySelector('a[aria-label]')` returns whichever aria-labelled anchor
   * comes first, and in a real post that is sometimes a CONTROL: one measured
   * sighting harvested `aria-label="Hide post by Stephenie"` with `href="#"` as
   * the author. Preference order is most-identifying first.
   */
  const findAuthor = (root: HTMLElement): HTMLAnchorElement | null => {
    const anchors = Array.from(root.querySelectorAll('a[href]')) as HTMLAnchorElement[];
    const href = (a: HTMLAnchorElement) => a.getAttribute('href') ?? '';

    /**
     * Within one preference rule, prefer the anchor that CARRIES THE NAME.
     *
     * A post links the same profile at least twice: once around the avatar
     * image, once around the display name. Document order puts the avatar
     * first, and it has no text and no aria-label — so taking the first match
     * yielded a contact whose name was its own user id. Measured 2026-08-12:
     * 27 of 27 harvested group contacts were named after their numeric id.
     */
    const pick = (test: (a: HTMLAnchorElement) => boolean): HTMLAnchorElement | null => {
      const matches = anchors.filter(test);
      return (
        matches.find((a) => ((a.getAttribute('aria-label') ?? a.textContent) ?? '').trim().length > 0) ??
        matches[0] ??
        null
      );
    };

    return (
      // 1. group-scoped member link — the only form group posts expose
      pick((a) => /\/groups\/\d+\/user\/\d+/.test(href(a))) ??
      // 2. numeric profile
      pick((a) => /profile\.php\?id=\d+/.test(href(a))) ??
      // 3. bare vanity handle at path root, nothing else in the path
      pick((a) => /^(https?:\/\/(www\.)?facebook\.com)?\/[\w.-]{3,}\/?(\?|$)/.test(href(a))
        && !permaRe.test(href(a))
        && !/^\/?(groups|photo|watch|reel|stories|marketplace|events|hashtag|search)\b/.test(href(a).replace(/^https?:\/\/(www\.)?facebook\.com/, ''))) ??
      null
    );
  };

  const roots = new Map<Element, HTMLElement>();

  for (const msg of Array.from(document.querySelectorAll(MESSAGE_SEL_PLACEHOLDER))) {
    let node: HTMLElement | null = msg as HTMLElement;
    for (let i = 0; node && i < 16; i++) {
      const authored = node.querySelector('a[aria-label]');
      // ARIA, not innerText. The words "Comment" and "Share" do not appear as
      // rendered text anywhere in a post — see facebook.ts ACTION_SEL.
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
    const authorLink = findAuthor(root);

    const dateRe = /\b(\d{1,2}\s+\w+|\w+\s+\d{1,2}|\d+\s*(m|h|d|w|hr|min)\b|yesterday|today)/i;
    const timeLabel = anchors
      .map((a) => a.getAttribute('aria-label'))
      .find((l) => l && dateRe.test(l) && !/^\s*$/.test(l));

    return {
      index,
      // Group member links carry no aria-label, so fall back to the link text —
      // without this every group contact is named after its own user id.
      author:
        clean(authorLink?.getAttribute('aria-label')) ||
        clean(authorLink?.textContent) ||
        null,
      authorUrl: tidyUrl(authorLink?.getAttribute('href') ?? null),
      text: rawText.slice(0, 4000),
      permalink: perma ? tidyUrl(perma.getAttribute('href')) : null,
      timestamp: clean(timeLabel) || null,
      truncated: rawText.length > 4000 || /\bSee more\b/i.test(rawText),
    };
  });
};

const COMMENT_EXTRACT = () => {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

  const tidyUrl = (href: string | null): string | null => {
    if (!href) return null;
    try {
      const u = new URL(href, location.origin);
      for (const k of [...u.searchParams.keys()]) if (k.startsWith('__')) u.searchParams.delete(k);
      return u.toString();
    } catch {
      return null;
    }
  };

  const nodes = Array.from(document.querySelectorAll(COMMENT_SEL_PLACEHOLDER));

  return nodes.map((node, index) => {
    const el = node as HTMLElement;
    const label = clean(el.getAttribute('aria-label'));
    // "Comment by Ali Bin Abu 2 hours ago" — the name sits between the two.
    const named = /^Comment by (.+?)(?:\s+\d|\s*$)/i.exec(label);
    const authorLink = el.querySelector('a[href*="facebook.com/"], a[href^="/"]') as HTMLAnchorElement | null;

    const body = clean(el.innerText)
      .replace(/^Comment by [^]*?ago\s*/i, '')
      .replace(/\b(Like|Reply|Share|Edited|Top fan|Author)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return {
      index,
      author: named?.[1]?.trim() || clean(authorLink?.textContent) || null,
      authorUrl: tidyUrl(authorLink?.getAttribute('href') ?? null),
      text: body.slice(0, 2000),
    };
  });
};

export const POST_EXTRACT_SRC = POST_EXTRACT.toString()
  .replaceAll('MESSAGE_SEL_PLACEHOLDER', JSON.stringify(MESSAGE_SEL))
  .replaceAll('ACTION_SEL_PLACEHOLDER', JSON.stringify(ACTION_SEL));

export const COMMENT_EXTRACT_SRC = COMMENT_EXTRACT.toString().replaceAll(
  'COMMENT_SEL_PLACEHOLDER',
  JSON.stringify(COMMENT_SEL),
);
