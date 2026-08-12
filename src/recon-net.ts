/**
 * RECON-AGENT — network capture and the API replay probe.
 *
 * Spec: docs/superpowers/specs/2026-08-12-recon-agent-design.md §6.3, §6.4
 *
 * AUTOMATION-PERF.md closes on one open question: does the target render from
 * internal JSON XHR? On a business SaaS the answer is usually yes, and proving
 * it is the highest-value thing recon produces — a read automation that hits
 * the API skips rendering, settle waits, skeleton rows and screenshots
 * entirely.
 *
 * Response VALUES are never stored. Only key names, array lengths and sizes:
 * these are customer records and the scan file lands in a repo.
 */
import type { BrowserContext, Page, Response } from 'patchright';

/** Assets tell us nothing about the app's data layer. */
const STATIC_RE = /\.(?:js|mjs|cjs|css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|map|mp4|webm|wasm)(?:\?|$)/i;

export type Replayable = 'yes' | 'no' | 'auth-failed' | 'not-json' | 'not-tried';

/**
 * Does the endpoint's row count agree with what the screen showed?
 *
 * `'unknown'` is NEVER a pass. An endpoint can answer 200 OK with 200 rows when
 * the screen showed 47, because the UI filtered client-side or via a param that
 * was not replayed — no error anywhere, a confident wrong number through a
 * brand-new door. Same rule as the empty-trace verdict: absence of evidence is
 * `'unknown'`, and unknown does not get to look like agreement.
 */
export type ScreenMatch = 'yes' | 'no' | 'unknown';

export interface XhrRecord {
  method: string;
  url: string;
  /** Numeric and uuid path segments collapsed, query dropped — the shape, for grouping. */
  urlPattern: string;
  status: number;
  contentType: string;
  bytes: number;
  /** Top-level keys of the JSON body. Names only, never values. */
  jsonTopKeys?: string[];
  /** Keys of the first element of the largest array — i.e. the row shape. */
  rowKeys?: string[];
  /** Length of that array, so the brief can say "27 rows came from here". */
  rowCount?: number;
  replayable: Replayable;
  replayNote?: string;
  /** Reconciliation verdict — see {@link ScreenMatch}. Starts, and stays, 'unknown' until proven. */
  matchesScreen: ScreenMatch;
  /**
   * Rows a read automation would get from this endpoint: the STANDALONE replay's
   * count when a replay happened, otherwise the count the page itself received.
   * The replay is the number that matters — it is the one the automation will see.
   */
  apiRowCount: number | null;
  /** The rendered row count this was compared against. null when nothing countable rendered. */
  screenRowCount: number | null;
}

/** /api/invoices/8821/lines?page=2 → /api/invoices/:id/lines */
export function urlPattern(raw: string): string {
  let path: string;
  try {
    path = new URL(raw).pathname;
  } catch {
    path = raw.split('?')[0];
  }
  return path
    .split('/')
    .map((seg) =>
      /^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^[0-9a-f]{24,}$/i.test(seg)
        ? ':id'
        : seg,
    )
    .join('/');
}

/** Names and counts only. Deliberately never returns a value from the body. */
function shapeOf(body: unknown): { jsonTopKeys?: string[]; rowKeys?: string[]; rowCount?: number } {
  if (!body || typeof body !== 'object') return {};
  const out: { jsonTopKeys?: string[]; rowKeys?: string[]; rowCount?: number } = {};

  if (Array.isArray(body)) {
    out.jsonTopKeys = ['(array)'];
    out.rowCount = body.length;
    const first = body[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) out.rowKeys = Object.keys(first).slice(0, 40);
    return out;
  }

  const rec = body as Record<string, unknown>;
  out.jsonTopKeys = Object.keys(rec).slice(0, 40);

  // The rows are usually the biggest array hanging off the envelope.
  let best: unknown[] | null = null;
  for (const v of Object.values(rec)) if (Array.isArray(v) && (!best || v.length > best.length)) best = v;
  if (best) {
    out.rowCount = best.length;
    const first = best[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) out.rowKeys = Object.keys(first).slice(0, 40);
  }
  return out;
}

export interface NetworkCapture {
  records: XhrRecord[];
  /** Awaits in-flight body reads, then stops listening. */
  finish(): Promise<XhrRecord[]>;
}

/**
 * Listen for the life of one page load.
 *
 * `response.body()` has a lifetime — it throws for cached responses and after
 * the page navigates away. So bodies are read inside the handler, guarded, and
 * filtered by content-type before the attempt is even made. Getting this wrong
 * silently loses exactly the JSON endpoints we care most about.
 */
export function captureNetwork(page: Page): NetworkCapture {
  const records: XhrRecord[] = [];
  const pending: Promise<void>[] = [];

  const onResponse = (res: Response): void => {
    const url = res.url();
    if (!/^https?:/i.test(url) || STATIC_RE.test(url)) return;

    const req = res.request();
    const method = req.method();
    const headers = res.headers();
    const contentType = headers['content-type'] ?? '';
    if (req.resourceType() === 'document' && method === 'GET' && !contentType.includes('json')) return;

    const rec: XhrRecord = {
      method,
      url,
      urlPattern: urlPattern(url),
      status: res.status(),
      contentType: contentType.split(';')[0].trim(),
      bytes: Number(headers['content-length'] ?? 0),
      replayable: 'not-tried',
      matchesScreen: 'unknown',
      apiRowCount: null,
      screenRowCount: null,
    };
    records.push(rec);

    if (!contentType.includes('json')) return;
    pending.push(
      (async () => {
        try {
          const text = await res.text();
          rec.bytes = rec.bytes || Buffer.byteLength(text);
          Object.assign(rec, shapeOf(JSON.parse(text)));
        } catch {
          // Cached, torn down, or not really JSON. Not an error worth failing a
          // scan over — the record still carries method, url and status.
        }
      })(),
    );
  };

  page.on('response', onResponse);

  return {
    records,
    async finish() {
      page.off('response', onResponse);
      await Promise.allSettled(pending);
      return records;
    },
  };
}

/**
 * Re-issue captured GETs standalone and see whether they still return the data.
 * If they do, every read automation on this site can skip the DOM entirely.
 *
 * Only GETs are ever replayed. POST/PUT/PATCH/DELETE are recorded and never
 * re-sent — replaying a write would mean recon mutating the user's ERP.
 *
 * Goes through ctx.request so it inherits the authenticated context: the
 * profile's cookies are DPAPI-sealed, so curl and fresh contexts cannot
 * authenticate (INDEX.md:16). It still skips all rendering.
 */
export async function probeReplay(ctx: BrowserContext, records: XhrRecord[], limit = 12): Promise<void> {
  const seen = new Set<string>();
  let tried = 0;

  for (const rec of records) {
    if (tried >= limit) return;
    if (rec.method !== 'GET') continue;
    if (rec.status < 200 || rec.status >= 300) continue;
    if (!rec.contentType.includes('json')) {
      rec.replayable = 'not-json';
      continue;
    }
    if (seen.has(rec.urlPattern)) continue;
    seen.add(rec.urlPattern);
    tried++;

    try {
      const res = await ctx.request.get(rec.url, { timeout: 15_000 });
      if (res.status() === 401 || res.status() === 403) {
        rec.replayable = 'auth-failed';
        rec.replayNote = `standalone request returned ${res.status()} — the UI adds something the bare call lacks`;
        continue;
      }
      if (!res.ok()) {
        rec.replayable = 'no';
        rec.replayNote = `standalone request returned ${res.status()}`;
        continue;
      }
      const body = JSON.parse(await res.text()) as unknown;
      const shape = shapeOf(body);
      const before = (rec.jsonTopKeys ?? []).join(',');
      const after = (shape.jsonTopKeys ?? []).join(',');
      if (before && after && before !== after) {
        rec.replayable = 'no';
        rec.replayNote = 'standalone response has a different shape than the one the page received';
        continue;
      }
      rec.replayable = 'yes';
      // The standalone count, not the page's: this is what an automation would
      // actually receive, and the whole point of reconciliation is that the two
      // can differ silently.
      if (shape.rowCount !== undefined) {
        rec.apiRowCount = shape.rowCount;
        rec.replayNote = `${shape.rowCount} rows without rendering`;
      }
    } catch (err) {
      rec.replayable = 'no';
      rec.replayNote = err instanceof Error ? err.message.slice(0, 120) : 'replay failed';
    }
  }
}

/**
 * Reconcile every captured endpoint against what the screen actually rendered.
 *
 * Pure, so the interesting cases are testable without a browser.
 *
 * `screenRowCounts` is every countable table on the route, main table first —
 * a route's tab states each render their own table, and the XHR that fed any of
 * them was captured in the same trace, so agreement with ANY of them is
 * agreement. On disagreement the closest count is reported, because "200 vs 47"
 * is the sentence that makes the trap obvious.
 *
 * A rendered count of 0 is deliberately discarded: an empty table and a table
 * that never rendered look identical from here, and 0 === 0 would manufacture a
 * pass out of two absences. That is the fails-toward-fine pattern this whole
 * feature exists to eliminate.
 */
export function reconcileRows(records: XhrRecord[], screenRowCounts: (number | null | undefined)[]): void {
  const screens = screenRowCounts.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0);

  for (const rec of records) {
    if (rec.apiRowCount === null || rec.apiRowCount === undefined) rec.apiRowCount = rec.rowCount ?? null;

    const api = rec.apiRowCount;
    if (api === null || screens.length === 0) {
      rec.matchesScreen = 'unknown';
      rec.screenRowCount = screens.length ? screens[0] : null;
      continue;
    }

    if (screens.includes(api)) {
      rec.matchesScreen = 'yes';
      rec.screenRowCount = api;
      continue;
    }

    rec.matchesScreen = 'no';
    rec.screenRowCount = screens.reduce((a, b) => (Math.abs(b - api) < Math.abs(a - api) ? b : a));
  }
}

/** One line for the brief and the terminal report. */
export function reconcileNote(rec: XhrRecord): string {
  if (rec.matchesScreen === 'yes') return `matches screen (${rec.screenRowCount} rows)`;
  if (rec.matchesScreen === 'no') return `DISAGREES — api ${rec.apiRowCount} vs screen ${rec.screenRowCount}`;
  return 'unverified — no row count to compare, do not trust it as a read source';
}

/**
 * The only gate an automation may be written against.
 *
 * Both conditions, explicitly: replayable AND reconciled. `'unknown'` fails
 * here by construction — writing `rec.matchesScreen !== 'no'` would let every
 * unverified endpoint through, the same shape of bug as `if (rec.replayable)`
 * being truthy for `"not-json"`.
 */
export function isVerifiedRead(rec: XhrRecord): boolean {
  return rec.replayable === 'yes' && rec.matchesScreen === 'yes';
}

/** The endpoints worth putting in the brief: distinct, replayable, data-bearing. */
export function usefulEndpoints(records: XhrRecord[]): XhrRecord[] {
  const byPattern = new Map<string, XhrRecord>();
  for (const r of records) {
    if (r.replayable !== 'yes') continue;
    const prev = byPattern.get(r.urlPattern);
    if (!prev || (r.rowCount ?? 0) > (prev.rowCount ?? 0)) byPattern.set(r.urlPattern, r);
  }
  return [...byPattern.values()].sort((a, b) => (b.rowCount ?? 0) - (a.rowCount ?? 0));
}
