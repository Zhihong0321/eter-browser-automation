// gmap-recon — the lead store.
//
// This is also the WORK QUEUE. The daemon is one-shot request→response with no job
// model, and a full campaign runs for hours, so instead of bolting a job runner onto
// the daemon every automation does a bounded chunk and all progress lives here on
// disk. A crash costs one chunk, never the run.
//
// node:sqlite is built into Node — the repo runs on three dependencies and this adds
// none. It emits an ExperimentalWarning on startup; that is the whole cost.

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

// ------------------------------------------------------------------- row types

export type SearchStatus = 'pending' | 'done' | 'failed' | 'blocked';
export type EnrichStatus = 'pending' | 'done' | 'no_website' | 'failed';

export interface SearchRow {
  id: string;
  keyword: string;
  place: string;
  status: SearchStatus;
  found: number | null;
  /** 1 when the result count plateaued — this place is saturated and needs splitting. */
  hitCap: number | null;
  ranAt: string | null;
  error: string | null;
}

/** What one feed card yields. Everything here is readable without a detail click. */
export interface BusinessInput {
  placeId: string;
  name: string;
  /** Truncated feed fragment — no city, no postcode. The coords are the precise locator. */
  address: string | null;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  website: string | null;
  category: string | null;
  rating: number | null;
  reviews: number | null;
  hours: string | null;
  mapsUrl: string;
}

export interface EnrichInput {
  email: string | null;
  emails: string[];
  facebook: string | null;
  instagram: string | null;
  whatsapp: string | null;
  linkedin: string | null;
}

export interface BusinessRow extends BusinessInput {
  firstSeenAt: string;
  lastSeenAt: string;
  enrichStatus: EnrichStatus;
  enrichAt: string | null;
  enrichError: string | null;
  email: string | null;
  emails: string | null;
  facebook: string | null;
  instagram: string | null;
  whatsapp: string | null;
  linkedin: string | null;
}

export interface Progress {
  searches: Record<SearchStatus, number>;
  businesses: number;
  enrich: Record<EnrichStatus, number>;
  withPhone: number;
  withEmail: number;
  /** Searches that plateaued — split these places and re-plan to close the gap. */
  saturated: { keyword: string; place: string; found: number }[];
}

/**
 * Result shapes are declared, not inferred. The card's signature is the contract an
 * agent reads before calling it, and `Record<string, unknown>` documents nothing.
 */
export interface PlanResult {
  planned: number;
  existing: number;
}

export interface HarvestResult extends Progress {
  ran: number;
  found: number;
  /** Non-null when the run stopped early — a hard block, or the canary tripping. */
  halted: string | null;
  note?: string;
}

export interface EnrichResult extends Progress {
  attempted: number;
  done: number;
  failed: number;
}

export interface StatusResult extends Progress {
  budget: { lastMinute: number; lastHour: number; today: number };
}

export interface ExportResult {
  file: string;
  rows: number;
}

// ---------------------------------------------------------------------- schema

const SCHEMA = `
CREATE TABLE IF NOT EXISTS searches (
  id         TEXT PRIMARY KEY,
  keyword    TEXT NOT NULL,
  place      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  found      INTEGER,
  hit_cap    INTEGER,
  ran_at     TEXT,
  error      TEXT
);

CREATE TABLE IF NOT EXISTS businesses (
  place_id      TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  address       TEXT,
  lat           REAL,
  lng           REAL,
  phone         TEXT,
  website       TEXT,
  category      TEXT,
  rating        REAL,
  reviews       INTEGER,
  hours         TEXT,
  maps_url      TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  enrich_status TEXT NOT NULL DEFAULT 'pending',
  enrich_at     TEXT,
  enrich_error  TEXT,
  email         TEXT,
  emails        TEXT,
  facebook      TEXT,
  instagram     TEXT,
  whatsapp      TEXT,
  linkedin      TEXT
);

CREATE TABLE IF NOT EXISTS hits (
  search_id TEXT NOT NULL,
  place_id  TEXT NOT NULL,
  rank      INTEGER,
  PRIMARY KEY (search_id, place_id)
);

CREATE INDEX IF NOT EXISTS idx_searches_status ON searches(status);
CREATE INDEX IF NOT EXISTS idx_biz_enrich     ON businesses(enrich_status);
`;

const searchId = (keyword: string, place: string): string =>
  createHash('sha1').update(`${keyword.trim().toLowerCase()}|${place.trim().toLowerCase()}`).digest('hex').slice(0, 16);

const now = (): string => new Date().toISOString();

/** node:sqlite hands back snake_case columns; the rest of the codebase speaks camelCase. */
type Raw = Record<string, string | number | null>;

const toSearch = (r: Raw): SearchRow => ({
  id: r.id as string,
  keyword: r.keyword as string,
  place: r.place as string,
  status: r.status as SearchStatus,
  found: r.found as number | null,
  hitCap: r.hit_cap as number | null,
  ranAt: r.ran_at as string | null,
  error: r.error as string | null,
});

const toBusiness = (r: Raw): BusinessRow => ({
  placeId: r.place_id as string,
  name: r.name as string,
  address: r.address as string | null,
  lat: r.lat as number | null,
  lng: r.lng as number | null,
  phone: r.phone as string | null,
  website: r.website as string | null,
  category: r.category as string | null,
  rating: r.rating as number | null,
  reviews: r.reviews as number | null,
  hours: r.hours as string | null,
  mapsUrl: r.maps_url as string,
  firstSeenAt: r.first_seen_at as string,
  lastSeenAt: r.last_seen_at as string,
  enrichStatus: r.enrich_status as EnrichStatus,
  enrichAt: r.enrich_at as string | null,
  enrichError: r.enrich_error as string | null,
  email: r.email as string | null,
  emails: r.emails as string | null,
  facebook: r.facebook as string | null,
  instagram: r.instagram as string | null,
  whatsapp: r.whatsapp as string | null,
  linkedin: r.linkedin as string | null,
});

// ----------------------------------------------------------------------- store

export class LeadStore {
  readonly #db: DatabaseSync;

  constructor(file: string) {
    this.#db = new DatabaseSync(file);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec(SCHEMA);
  }

  /**
   * Expand keywords × places into pending work. Re-planning is safe and idempotent:
   * a pair already in the table keeps its existing status, so adding one town to the
   * list does not re-run the twenty you already harvested.
   */
  plan(keywords: string[], places: string[]): { planned: number; existing: number } {
    const ins = this.#db.prepare(
      'INSERT INTO searches (id, keyword, place, status) VALUES (?, ?, ?, \'pending\') ON CONFLICT(id) DO NOTHING',
    );
    let planned = 0;
    let existing = 0;
    for (const k of keywords) {
      for (const p of places) {
        const changed = ins.run(searchId(k, p), k.trim(), p.trim()).changes;
        if (Number(changed) > 0) planned++;
        else existing++;
      }
    }
    return { planned, existing };
  }

  pendingSearches(limit: number): SearchRow[] {
    return this.#db
      .prepare("SELECT * FROM searches WHERE status = 'pending' ORDER BY place, keyword LIMIT ?")
      .all(limit)
      .map((r) => toSearch(r as Raw));
  }

  completeSearch(id: string, found: number, hitCap: boolean): void {
    this.#db
      .prepare("UPDATE searches SET status = 'done', found = ?, hit_cap = ?, ran_at = ?, error = NULL WHERE id = ?")
      .run(found, hitCap ? 1 : 0, now(), id);
  }

  /** `blocked` is terminal for the run — the caller stops rather than grinding on. */
  failSearch(id: string, error: string, blocked = false): void {
    this.#db
      .prepare('UPDATE searches SET status = ?, ran_at = ?, error = ? WHERE id = ?')
      .run(blocked ? 'blocked' : 'failed', now(), error.slice(0, 500), id);
  }

  /**
   * Merge one card into the store. COALESCE order matters: a sparser card must never
   * blank a field an earlier, richer one filled. Overlapping searches only ever add.
   */
  upsertBusiness(b: BusinessInput, fromSearch: string, rank: number): void {
    const t = now();
    this.#db
      .prepare(
        `INSERT INTO businesses
           (place_id, name, address, lat, lng, phone, website, category, rating, reviews, hours,
            maps_url, first_seen_at, last_seen_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(place_id) DO UPDATE SET
           last_seen_at = excluded.last_seen_at,
           name     = COALESCE(excluded.name,     businesses.name),
           address  = COALESCE(excluded.address,  businesses.address),
           lat      = COALESCE(excluded.lat,      businesses.lat),
           lng      = COALESCE(excluded.lng,      businesses.lng),
           phone    = COALESCE(excluded.phone,    businesses.phone),
           website  = COALESCE(excluded.website,  businesses.website),
           category = COALESCE(excluded.category, businesses.category),
           rating   = COALESCE(excluded.rating,   businesses.rating),
           reviews  = COALESCE(excluded.reviews,  businesses.reviews),
           hours    = COALESCE(excluded.hours,    businesses.hours)`,
      )
      .run(
        b.placeId, b.name, b.address, b.lat, b.lng, b.phone, b.website,
        b.category, b.rating, b.reviews, b.hours, b.mapsUrl, t, t,
      );

    this.#db
      .prepare('INSERT INTO hits (search_id, place_id, rank) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
      .run(fromSearch, b.placeId, rank);
  }

  /** Only businesses that actually have a site — the rest are settled by #markNoWebsite. */
  pendingEnrich(limit: number): BusinessRow[] {
    this.#db
      .prepare(
        `UPDATE businesses SET enrich_status = 'no_website', enrich_at = ?
         WHERE enrich_status = 'pending' AND (website IS NULL OR website = '')`,
      )
      .run(now());

    return this.#db
      .prepare("SELECT * FROM businesses WHERE enrich_status = 'pending' ORDER BY place_id LIMIT ?")
      .all(limit)
      .map((r) => toBusiness(r as Raw));
  }

  completeEnrich(placeId: string, e: EnrichInput): void {
    this.#db
      .prepare(
        `UPDATE businesses SET
           enrich_status = 'done', enrich_at = ?, enrich_error = NULL,
           email = ?, emails = ?, facebook = ?, instagram = ?, whatsapp = ?, linkedin = ?
         WHERE place_id = ?`,
      )
      .run(
        now(), e.email, e.emails.length ? JSON.stringify(e.emails) : null,
        e.facebook, e.instagram, e.whatsapp, e.linkedin, placeId,
      );
  }

  failEnrich(placeId: string, error: string): void {
    this.#db
      .prepare("UPDATE businesses SET enrich_status = 'failed', enrich_at = ?, enrich_error = ? WHERE place_id = ?")
      .run(now(), error.slice(0, 300), placeId);
  }

  status(): Progress {
    const count = (sql: string, ...p: (string | number)[]): number =>
      Number((this.#db.prepare(sql).get(...p) as Raw).n ?? 0);

    const bucket = <T extends string>(table: string, col: string, keys: readonly T[]): Record<T, number> =>
      Object.fromEntries(
        keys.map((k) => [k, count(`SELECT COUNT(*) n FROM ${table} WHERE ${col} = ?`, k)]),
      ) as Record<T, number>;

    return {
      searches: bucket('searches', 'status', ['pending', 'done', 'failed', 'blocked'] as const),
      businesses: count('SELECT COUNT(*) n FROM businesses'),
      enrich: bucket('businesses', 'enrich_status', ['pending', 'done', 'no_website', 'failed'] as const),
      withPhone: count("SELECT COUNT(*) n FROM businesses WHERE phone IS NOT NULL AND phone != ''"),
      withEmail: count("SELECT COUNT(*) n FROM businesses WHERE email IS NOT NULL AND email != ''"),
      saturated: this.#db
        .prepare('SELECT keyword, place, found FROM searches WHERE hit_cap = 1 ORDER BY found DESC')
        .all()
        .map((r) => {
          const x = r as Raw;
          return { keyword: x.keyword as string, place: x.place as string, found: x.found as number };
        }),
    };
  }

  /**
   * The oldest completed search with a real yield, re-run periodically to tell
   * throttling apart from a genuinely small town. Google's degradation is silent —
   * no captcha, no error, just fewer rows — so a known query with a known baseline
   * is the only honest health signal available.
   */
  canaryBaseline(): { keyword: string; place: string; found: number } | null {
    const r = this.#db
      .prepare("SELECT keyword, place, found FROM searches WHERE status = 'done' AND found > 0 ORDER BY ran_at LIMIT 1")
      .get() as Raw | undefined;
    return r ? { keyword: r.keyword as string, place: r.place as string, found: r.found as number } : null;
  }

  rows(opts: { withPhoneOnly?: boolean; withEmailOnly?: boolean } = {}): BusinessRow[] {
    const where: string[] = [];
    if (opts.withPhoneOnly) where.push("phone IS NOT NULL AND phone != ''");
    if (opts.withEmailOnly) where.push("email IS NOT NULL AND email != ''");
    const sql = `SELECT * FROM businesses ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name`;
    return this.#db.prepare(sql).all().map((r) => toBusiness(r as Raw));
  }

  close(): void {
    this.#db.close();
  }
}

// ---------------------------------------------------------------------- export

const CSV_COLUMNS = [
  'name', 'phone', 'email', 'website', 'address', 'category',
  'rating', 'reviews', 'lat', 'lng', 'hours',
  'facebook', 'instagram', 'whatsapp', 'linkedin',
  'placeId', 'mapsUrl', 'enrichStatus', 'firstSeenAt',
] as const satisfies readonly (keyof BusinessRow)[];

/**
 * A leading =, +, - or @ makes Excel treat a cell as a formula, and plenty of these
 * phone numbers start with +. Prefix those with an apostrophe so the sheet shows the
 * number instead of evaluating it.
 */
const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(rows: BusinessRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => cell(r[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
