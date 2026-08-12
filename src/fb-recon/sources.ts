/**
 * Where to look. Four sources, one shape.
 *
 * They differ only in how you arrive and how the next screenful appears;
 * everything after extraction is shared. Ordered by intent quality:
 *
 *   thread — commenters under a known competitor or viral post. Highest intent,
 *            narrowest reach, and pass-2 only: there is no list to sweep.
 *   group  — where buying questions actually get asked. Requires membership.
 *   search — broadest reach, noisiest, and the most heavily gated by Facebook.
 *            Expect this one to break first.
 *   feed   — whatever Facebook decided to show you. Topic coverage is
 *            accidental; useful as a passive trickle, weak as a primary source.
 */
import type { SourceKind } from './store.js';

export interface SourceSpec {
  kind: SourceKind;
  /** Group URL, search query, or post permalink. Empty for feed. */
  ref: string;
}

const NEEDS_URL: SourceKind[] = ['group', 'thread'];

function assertFacebookUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`fb-recon source is not a valid URL: ${raw}`);
  }
  if (!/(^|\.)facebook\.com$/i.test(u.hostname)) {
    throw new Error(`fb-recon sources must be on facebook.com, got: ${u.hostname}`);
  }
}

/** CLI form: "group:<url>", "thread:<url>", "search[:<query>]", "feed". */
export function parseSource(raw: string): SourceSpec {
  const trimmed = (raw ?? '').trim();
  const idx = trimmed.indexOf(':');
  const kind = (idx === -1 ? trimmed : trimmed.slice(0, idx)).toLowerCase() as SourceKind;
  const ref = idx === -1 ? '' : trimmed.slice(idx + 1).trim();

  if (!['group', 'search', 'thread', 'feed'].includes(kind)) {
    throw new Error(`fb-recon: unknown source kind ${JSON.stringify(kind)}. Use group:<url>, search[:<query>], thread:<url>, or feed.`);
  }
  if (NEEDS_URL.includes(kind)) {
    if (!ref) throw new Error(`fb-recon: source "${kind}" requires a url, e.g. ${kind}:https://www.facebook.com/...`);
    assertFacebookUrl(ref);
  }

  return { kind, ref };
}

export function sourceUrl(spec: SourceSpec, topic: string): string {
  switch (spec.kind) {
    case 'group':
    case 'thread':
      return spec.ref;
    case 'search':
      return `https://www.facebook.com/search/posts?q=${encodeURIComponent(spec.ref || topic)}`;
    case 'feed':
      return 'https://www.facebook.com/';
  }
}

export function sourceLabel(spec: SourceSpec): string {
  return spec.ref ? `${spec.kind}:${spec.ref}` : spec.kind;
}

/** A thread has no list to scroll — it goes straight to pass 2. */
export function isSweepable(spec: SourceSpec): boolean {
  return spec.kind !== 'thread';
}
