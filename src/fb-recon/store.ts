/**
 * The contact store. One person is one record, however many times we see them.
 *
 * The evidence array is the point of this whole feature. A name and a Messenger
 * link is a cold lead; a name, a Messenger link, and "asked for a 6kW quote in
 * Solar Malaysia on Tuesday" is a warm one. Sightings therefore accumulate
 * rather than overwrite, and nothing here ever deletes.
 *
 * Whole-file load, merge in memory, single rewrite. At a few thousand contacts
 * that is faster than it sounds and it makes the merge rules testable without a
 * filesystem in the loop.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Group Recon's three kinds of person, and nothing else.
 *
 * A topical Facebook group contains exactly three sorts of poster, and which one
 * someone is decides whether you message them at all:
 *
 *   seller — pitching, showing product, "PM me for price". A competitor.
 *   owner  — already bought. Asking how to use it, complaining, showing it off.
 *   buyer  — hasn't bought. Mostly asking questions.
 *
 * `none` means the classifier could not tell, NOT that the person was rejected.
 * Group Recon records everyone; the type is a label on the row, never a filter.
 */
export type Intent = 'seller' | 'owner' | 'buyer' | 'none';
export type SourceKind = 'group' | 'search' | 'thread' | 'feed';
export type Role = 'author' | 'commenter';

export interface Evidence {
  permalink: string;
  /** What they actually said. Kept verbatim — it is the opener. */
  quote: string;
  sourceKind: SourceKind;
  role: Role;
  at: string;
}

export interface FbContact {
  /** Normalised profile identity. The dedupe key. */
  id: string;
  name: string;
  profileUrl: string;
  messenger: string | null;
  phones: string[];
  waLinks: string[];
  emails: string[];
  evidence: Evidence[];
  intent: Intent;
  score: number;
  firstSeen: string;
  lastSeen: string;
}

export type ContactMap = Map<string, FbContact>;

/**
 * Higher wins on merge. Someone who ever asked a buying question stays a buyer
 * even if a later post of theirs reads like idle chat.
 *
 * Read through `rank()`, never indexed directly: ledgers written before this
 * vocabulary existed hold values like "researching", and `undefined > n` is
 * false in a way that silently keeps the wrong label.
 */
const INTENT_RANK: Record<Intent, number> = { none: 0, seller: 1, owner: 2, buyer: 3 };

function rank(intent: Intent): number {
  return INTENT_RANK[intent] ?? 0;
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

/**
 * How two sightings are judged to be the same sighting.
 *
 * A permalink is the right key when there is one. Group posts frequently expose
 * none at all — measured 2026-08-12, 0 of 14 did — and keying on an empty string
 * would make every later sighting of the same person look like a duplicate, so
 * one contact would end up with exactly one piece of evidence no matter how many
 * times they spoke. That is a silent loss of the thing the feature is for, so
 * the fallback keys on what they actually said instead.
 */
function evidenceKey(e: Evidence): string {
  return e.permalink
    ? `${e.permalink}::${e.role}`
    : `${e.sourceKind}::${e.role}::${e.quote.slice(0, 120)}`;
}

export function loadContacts(file: string): ContactMap {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { contacts?: FbContact[] };
    return new Map((raw.contacts ?? []).map((c) => [c.id, c]));
  } catch {
    return new Map();
  }
}

export function saveContacts(file: string, map: ContactMap): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const contacts = [...map.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  fs.writeFileSync(file, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), contacts }, null, 1));
}

/** Returns true if this was a person we had never seen before. */
export function mergeContact(map: ContactMap, incoming: FbContact): boolean {
  const existing = map.get(incoming.id);
  if (!existing) {
    map.set(incoming.id, { ...incoming, evidence: [...incoming.evidence] });
    return true;
  }

  const seen = new Set(existing.evidence.map(evidenceKey));
  for (const e of incoming.evidence) {
    const k = evidenceKey(e);
    if (!seen.has(k)) {
      existing.evidence.push(e);
      seen.add(k);
    }
  }

  existing.name = existing.name || incoming.name;
  existing.messenger = existing.messenger ?? incoming.messenger;
  existing.phones = union(existing.phones, incoming.phones);
  existing.waLinks = union(existing.waLinks, incoming.waLinks);
  existing.emails = union(existing.emails, incoming.emails);
  existing.score = Math.max(existing.score, incoming.score);
  if (rank(incoming.intent) > rank(existing.intent)) existing.intent = incoming.intent;
  if (incoming.firstSeen < existing.firstSeen) existing.firstSeen = incoming.firstSeen;
  if (incoming.lastSeen > existing.lastSeen) existing.lastSeen = incoming.lastSeen;

  return false;
}

const CSV_COLUMNS = ['id', 'name', 'profileUrl', 'messenger', 'phones', 'waLinks', 'emails', 'intent', 'score', 'sightings', 'lastQuote', 'lastPermalink'] as const;

/** RFC4180 quoting: an unescaped quote or newline in a name silently corrupts
 *  every row after it when the file lands in Excel. */
function cell(value: string | number): string {
  const s = String(value).replace(/\r?\n/g, ' ');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(map: ContactMap): string {
  const rows = [...map.values()].sort((a, b) => b.score - a.score);
  const lines = [CSV_COLUMNS.join(',')];
  for (const c of rows) {
    const last = c.evidence[c.evidence.length - 1];
    lines.push([
      cell(c.id), cell(c.name), cell(c.profileUrl), cell(c.messenger ?? ''),
      cell(c.phones.join(' ')), cell(c.waLinks.join(' ')), cell(c.emails.join(' ')),
      cell(c.intent), cell(c.score), cell(c.evidence.length),
      cell(last?.quote ?? ''), cell(last?.permalink ?? ''),
    ].join(','));
  }
  return lines.join('\n');
}
