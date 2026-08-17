// src/enrich/archive.ts — Wayback Machine capture history for a company's website.
//
// Two calls, both free and keyless (measured 2026-08-17):
//
//   CDX API            first capture. `matchType=domain`, ascending (the default),
//                       `limit=1`. The CDX index is sorted by SURT key first and
//                       timestamp second, so across many subdomains/paths this is a
//                       good lower bound rather than a *proven* global minimum —
//                       negative `limit` values were probed for "last N" and turned
//                       out to walk that same SURT ordering, not time order, so they
//                       are NOT used here (see git history for the probe). For the
//                       single-site SME listings this pipeline works, the homepage
//                       dominates the capture history in every case checked.
//
//   Availability API   last capture. The documented way to ask "closest snapshot to
//                       right now" — one authoritative call, no pagination, no SURT
//                       ordering to reason about.
//
// The value over domain-registry (src/enrich/domain.ts): a DEAD domain has no
// `createdAt` at all, so "never had a website" and "had one for a decade, then let
// it lapse" look identical downstream. A capture history tells them apart. It also
// gives a second, independent source for site age when RDAP redacts the registrant
// (every gTLD, post-GDPR) and MYNIC's registrant field is blank (a plain .my open
// to individuals).
//
// `recoverArchivedContacts` is the other half: when the live crawl in
// src/enrich/pipeline.ts finds nothing — because the domain is dead, the site is
// down, or it blocked us — the last snapshot's HTML is still sitting on
// archive.org, and `extractContacts` reads it exactly like a live page.

import fs from 'node:fs';
import path from 'node:path';
import { resolveVaultHome } from '../config.js';
import { registrableDomain, isPlatformDomain } from './domain.js';
import { extractContacts } from '../gmaprecon.js';
import type { ArchiveIntel } from './types.js';
import type { EnrichInput } from '../leads.js';

const CDX_URL = 'https://web.archive.org/cdx/search/cdx';
const AVAILABILITY_URL = 'https://archive.org/wayback/available';

interface CdxRow {
  timestamp: string;
  original: string;
  statuscode: string;
}

function toIso(timestamp: string): string | undefined {
  // Wayback timestamps are `YYYYMMDDhhmmss`, always UTC.
  const m = timestamp.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`).toISOString();
}

async function fetchFirstCapture(domain: string, timeoutMs: number): Promise<CdxRow | null> {
  const url = `${CDX_URL}?url=${encodeURIComponent(domain)}&matchType=domain&output=json&filter=statuscode:200&collapse=digest&limit=1&fl=timestamp,original,statuscode`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Wayback CDX returned HTTP ${res.status}`);
  const rows = (await res.json()) as string[][];
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const [timestamp, original, statuscode] = rows[1]!;
  return { timestamp, original, statuscode };
}

async function fetchLastCapture(
  domain: string,
  timeoutMs: number,
): Promise<{ timestamp: string; url: string; status: string } | null> {
  const res = await fetch(`${AVAILABILITY_URL}?url=${encodeURIComponent(domain)}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Wayback Availability API returned HTTP ${res.status}`);
  const body = (await res.json()) as {
    archived_snapshots?: { closest?: { available?: boolean; url?: string; timestamp?: string; status?: string } };
  };
  const closest = body.archived_snapshots?.closest;
  if (!closest?.available || !closest.timestamp || !closest.url) return null;
  return { timestamp: closest.timestamp, url: closest.url, status: closest.status ?? '200' };
}

/* ---- cache — captures barely change week to week ---------------------- */

interface CacheEntry {
  fetchedAt: string;
  intel: ArchiveIntel;
}

const cacheFile = (): string => path.join(resolveVaultHome(), 'archive-cache.json');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function readCache(domain: string, now: number): ArchiveIntel | null {
  try {
    const all = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) as Record<string, CacheEntry>;
    const hit = all[domain];
    if (!hit) return null;
    return now - Date.parse(hit.fetchedAt) < CACHE_TTL_MS ? hit.intel : null;
  } catch {
    return null;
  }
}

function writeCache(domain: string, intel: ArchiveIntel, now: number): void {
  try {
    const file = cacheFile();
    let all: Record<string, CacheEntry> = {};
    try {
      all = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, CacheEntry>;
    } catch {
      /* first write */
    }
    all[domain] = { fetchedAt: new Date(now).toISOString(), intel };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all, null, 2));
  } catch {
    /* cache is an optimisation, not a requirement */
  }
}

/* ---- entry point -------------------------------------------------------- */

export async function lookupArchive(
  websiteOrHost: string,
  options: { timeoutMs?: number; useCache?: boolean } = {},
): Promise<ArchiveIntel> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const now = Date.now();

  const domain = registrableDomain(websiteOrHost);
  if (!domain) {
    return { domain: websiteOrHost, checked: false, hasSnapshots: false, note: `"${websiteOrHost}" is not a domain name that can be looked up.` };
  }
  if (isPlatformDomain(domain)) {
    return { domain, checked: false, hasSnapshots: false, note: `${domain} is a platform page, not the company's own domain — nothing to archive.` };
  }

  if (options.useCache !== false) {
    const hit = readCache(domain, now);
    if (hit) return { ...hit, cached: true };
  }

  const [first, last] = await Promise.all([
    fetchFirstCapture(domain, timeoutMs).catch(() => null),
    fetchLastCapture(domain, timeoutMs).catch(() => null),
  ]);

  const intel: ArchiveIntel = {
    domain,
    checked: true,
    hasSnapshots: !!(first || last),
    firstCaptureAt: first ? toIso(first.timestamp) : undefined,
    lastCaptureAt: last ? toIso(last.timestamp) : undefined,
    lastCaptureStatus: last?.status,
    lastCaptureUrl: last?.url,
    note: first || last ? undefined : 'no Wayback captures found for this domain',
  };

  writeCache(domain, intel, now);
  return intel;
}

/** One line for the stage log — what capture history was actually found, or why not. */
export function describeArchive(a: ArchiveIntel): { status: 'ok' | 'empty' | 'skipped'; detail: string } {
  if (!a.checked) return { status: 'skipped', detail: a.note ?? 'not checked' };
  if (!a.hasSnapshots) return { status: 'empty', detail: a.note ?? 'no captures on record' };
  const spanYears =
    a.firstCaptureAt && a.lastCaptureAt
      ? Math.round(((Date.parse(a.lastCaptureAt) - Date.parse(a.firstCaptureAt)) / 31_557_600_000) * 10) / 10
      : undefined;
  return {
    status: 'ok',
    detail:
      `first seen ${a.firstCaptureAt?.slice(0, 10) ?? '—'}, last seen ${a.lastCaptureAt?.slice(0, 10) ?? '—'}` +
      `${spanYears !== undefined ? ` (${spanYears}y span)` : ''}${a.cached ? ' cached' : ''}`,
  };
}

/**
 * Pull contacts out of the last snapshot's HTML — the fallback source for a domain
 * the live crawl could not read at all. `id_` is Wayback's raw-content modifier: it
 * serves the captured bytes without the toolbar or link-rewriting Wayback normally
 * injects, which is what `extractContacts`'s regexes expect.
 */
export async function recoverArchivedContacts(archive: ArchiveIntel, timeoutMs = 12_000): Promise<EnrichInput | null> {
  if (!archive.lastCaptureUrl) return null;
  const rawUrl = archive.lastCaptureUrl.replace(
    /^(https?:\/\/web\.archive\.org\/web\/\d+)(?:[a-z_]*)(\/https?:\/\/.*)$/,
    '$1id_$2',
  );
  try {
    const res = await fetch(rawUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0 Safari/537.36' },
    });
    if (!res.ok) return null;
    return extractContacts((await res.text()).slice(0, 400_000), archive.domain);
  } catch {
    return null;
  }
}
