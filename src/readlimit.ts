/**
 * Read-side budget for fb-recon.
 *
 * sendlimit.ts deliberately does not throttle reads — for WhatsApp that is
 * correct, because reading a chat you already opened costs nothing. A recon
 * sweep is different: it is hundreds of scroll events and dozens of post
 * navigations against a platform that measures exactly that. So reads get
 * their own budget, shaped the same way as the send budget so the two read
 * alike.
 *
 * Two different clocks are in play. Per-RUN caps bound the blast radius of a
 * single invocation and live in memory. The per-HOUR cap has to survive
 * process restarts — the daemon restarts often, and an in-memory counter would
 * hand back a fresh hourly budget every time it came up — so it persists to
 * disk next to the vault manifest, exactly like send-history.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from './human.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;

export interface ReadLimits {
  /** Posts extracted in one run, across every source. A ceiling on the sweep. */
  postsPerRun: number;
  /** Pass-2 navigations in one run. The genuinely risky number, so it is the smallest. */
  pageOpensPerRun: number;
  /** Pass-2 navigations per rolling hour, across runs. Survives restarts. */
  pageOpensPerHour: number;
  /** Light pacing on the scroll loop, nothing more. */
  scrollsPerMinute: number;
  /** Refuse rather than block longer than this. 0 = wait however long it takes. */
  maxWaitMs: number;
}

export const DEFAULT_READ_LIMITS: ReadLimits = {
  postsPerRun: 200,
  pageOpensPerRun: 40,
  pageOpensPerHour: 60,
  scrollsPerMinute: 20,
  maxWaitMs: 120_000,
};

export interface ReadSnapshot {
  postsThisRun: number;
  opensThisRun: number;
  opensLastHour: number;
  limits: ReadLimits;
}

export class ReadLimiter {
  readonly #limits: ReadLimits;
  #opens: number[] = [];
  #scrolls: number[] = [];
  #postsThisRun = 0;
  #opensThisRun = 0;

  constructor(
    private readonly file: string,
    limits: Partial<ReadLimits> = {},
  ) {
    this.#limits = { ...DEFAULT_READ_LIMITS, ...limits };
    this.#load();
  }

  /** Per-run post ceiling. Returns false instead of throwing: the sweep should
   *  stop cleanly and report what it got, not lose the harvest to an exception. */
  takePost(): boolean {
    if (this.#postsThisRun >= this.#limits.postsPerRun) return false;
    this.#postsThisRun++;
    return true;
  }

  /** Light token bucket on scrolling. Always waits; never refuses. */
  async takeScroll(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.#scrolls = this.#scrolls.filter((t) => now - t < MINUTE);
      if (this.#scrolls.length < this.#limits.scrollsPerMinute) {
        this.#scrolls.push(now);
        return;
      }
      await sleep(MINUTE - (now - this.#scrolls[0]) + 250);
    }
  }

  /**
   * Pass-2 navigation. Throws on the run cap (the caller should stop opening
   * and finish with what it has) and throws rather than blocking forever on the
   * hourly cap.
   */
  async takePageOpen(): Promise<void> {
    if (this.#opensThisRun >= this.#limits.pageOpensPerRun) {
      throw new Error(
        `fb-recon per-run page-open cap reached (${this.#limits.pageOpensPerRun}). ` +
          'Finish this run and start another, or raise pageOpensPerRun.',
      );
    }

    const now = Date.now();
    this.#prune(now);
    if (this.#opens.length >= this.#limits.pageOpensPerHour) {
      const waitMs = HOUR - (now - this.#opens[0]) + 250;
      if (this.#limits.maxWaitMs > 0 && waitMs > this.#limits.maxWaitMs) {
        throw new Error(
          `fb-recon hourly page-open cap reached; would need to wait ${Math.round(waitMs / 1000)}s. ` +
            'Refusing rather than holding the browser hostage.',
        );
      }
      await sleep(waitMs);
      this.#prune(Date.now());
    }

    this.#opens.push(Date.now());
    this.#opensThisRun++;
    this.#save();
  }

  /** Clear per-run counters. The hourly history deliberately survives. */
  resetRun(): void {
    this.#postsThisRun = 0;
    this.#opensThisRun = 0;
  }

  snapshot(): ReadSnapshot {
    this.#prune(Date.now());
    return {
      postsThisRun: this.#postsThisRun,
      opensThisRun: this.#opensThisRun,
      opensLastHour: this.#opens.length,
      limits: this.#limits,
    };
  }

  #prune(now: number): void {
    this.#opens = this.#opens.filter((t) => now - t < HOUR);
  }

  #load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { opens?: number[] };
      this.#opens = (raw.opens ?? []).filter((t) => typeof t === 'number');
      this.#prune(Date.now());
    } catch {
      // No file yet, or unreadable. Starting from an empty budget is the
      // permissive failure; refusing every read because a JSON file is
      // malformed breaks the tool over bookkeeping.
    }
  }

  #save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ opens: this.#opens }, null, 1));
    } catch {
      // Losing the log costs accuracy on the hourly cap; failing the sweep
      // costs the user their harvest. Prefer the former.
    }
  }
}
