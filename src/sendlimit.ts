import fs from 'node:fs';
import path from 'node:path';
import { sleep } from './human.js';

/**
 * Outbound message budget for WhatsApp.
 *
 * This is a different control from human.ts's RateLimiter, and the difference is the
 * whole point. RateLimiter paces ACTIONS per minute — it stops a burst looking
 * mechanical. It does nothing about the thing that actually gets a WhatsApp number
 * banned, which is not how fast you act but WHO you message: a script that contacts
 * two hundred strangers in an afternoon sails through a 12-per-minute cap at full
 * speed, and the strangers block-and-report, and the block-and-report rate is the
 * signal WhatsApp acts on.
 *
 * So the limits here are shaped like the risk rather than like the clock:
 *
 *   perMinute            light pacing, nothing more.
 *   recipientsPerHour    DISTINCT people per hour. Messaging the same chat ten times
 *                        costs one slot — replying in a live conversation is not the
 *                        risky pattern and should not be throttled like it is.
 *   newRecipientsPerHour people we have never messaged before. This is the ban-risk
 *                        number and it is deliberately the smallest one.
 *   perDay               a ceiling, because WhatsApp reasons in days, not minutes.
 *
 * Reads are NOT limited anywhere, on purpose. Nothing is at stake in reading your own
 * chat list, and throttling it only makes the tool slower.
 *
 * State lives on disk. It has to: the daemon restarts often (six times in one session
 * while this was being built), and an in-memory counter hands back a fresh daily
 * budget every time it comes up, which makes a daily cap worth nothing.
 *
 * None of this makes automating WhatsApp Web permitted — it is against WhatsApp's
 * terms whatever the pacing. It lowers the odds of losing the number; it does not
 * remove them.
 */
export interface SendLimits {
  perMinute: number;
  recipientsPerHour: number;
  newRecipientsPerHour: number;
  perDay: number;
  /** Refuse rather than block longer than this. 0 = wait however long it takes. */
  maxWaitMs: number;
}

interface SendRecord {
  at: number;
  to: string;
  /** Whether `to` had never been messaged before at the moment it was sent. */
  fresh: boolean;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Same person by name and by number counts twice. Acceptable: it errs strict. */
export function recipientKey(target: string): string {
  const digits = target.replace(/[\s()+-]/g, '');
  if (/^\d{7,15}$/.test(digits)) return digits;
  return target.toLowerCase().trim().replace(/\s+/g, ' ');
}

export class SendLimiter {
  #history: SendRecord[] = [];
  /** Everyone ever messaged, so "new" survives the 24h pruning of #history. */
  #known = new Set<string>();

  constructor(
    private readonly file: string,
    private readonly limits: SendLimits,
  ) {
    this.#load();
  }

  /** What the budget looks like right now. For the dashboard and for error messages. */
  snapshot() {
    const now = Date.now();
    this.#prune(now);
    const since = (ms: number) => this.#history.filter((r) => now - r.at < ms);
    const hour = since(HOUR);
    return {
      lastMinute: since(MINUTE).length,
      recipientsThisHour: new Set(hour.map((r) => r.to)).size,
      newRecipientsThisHour: new Set(hour.filter((r) => r.fresh).map((r) => r.to)).size,
      today: since(DAY).length,
      knownRecipients: this.#known.size,
      limits: this.limits,
    };
  }

  /**
   * Block until sending to `target` is within budget, then book the slot.
   *
   * Booking happens here rather than after a successful send on purpose: a send that
   * fails still reached WhatsApp, and pretending it did not is how a retry loop turns
   * one refused message into fifty.
   */
  async take(target: string): Promise<void> {
    const to = recipientKey(target);
    const started = Date.now();

    for (;;) {
      const now = Date.now();
      this.#prune(now);

      const wait = this.#waitFor(now, to);
      if (wait <= 0) {
        this.#history.push({ at: now, to, fresh: !this.#known.has(to) });
        this.#known.add(to);
        this.#save();
        return;
      }

      const waited = now - started;
      if (this.limits.maxWaitMs > 0 && waited + wait > this.limits.maxWaitMs) {
        const s = this.snapshot();
        throw new Error(
          `WhatsApp send budget reached — this message would have to wait ${Math.round(wait / 60_000)} min. ` +
            `Used: ${s.lastMinute}/${this.limits.perMinute} this minute, ` +
            `${s.recipientsThisHour}/${this.limits.recipientsPerHour} people this hour ` +
            `(${s.newRecipientsThisHour}/${this.limits.newRecipientsPerHour} of them new), ` +
            `${s.today}/${this.limits.perDay} today. Nothing was sent. Retry later, or raise the limits ` +
            'in the manifest settings.',
        );
      }

      // Re-check periodically instead of sleeping the whole span: the budget can free
      // up early, and a long opaque block is indistinguishable from a hang.
      await sleep(Math.min(wait, 15_000));
    }
  }

  /** Milliseconds until this send fits every limit. 0 means go now. */
  #waitFor(now: number, to: string): number {
    const within = (ms: number) => this.#history.filter((r) => now - r.at < ms);
    const waits: number[] = [];

    const minute = within(MINUTE);
    if (minute.length >= this.limits.perMinute) waits.push(minute[0].at + MINUTE - now);

    const day = within(DAY);
    if (day.length >= this.limits.perDay) waits.push(day[0].at + DAY - now);

    const hour = within(HOUR);

    // A distinct-recipient slot frees when that recipient's LAST message ages out, so
    // the soonest relief is the minimum of those, not of the oldest record overall.
    const freesAt = (records: SendRecord[]): number => {
      const last = new Map<string, number>();
      for (const r of records) last.set(r.to, r.at);
      return Math.min(...last.values()) + HOUR - now;
    };

    const recipients = new Set(hour.map((r) => r.to));
    if (!recipients.has(to) && recipients.size >= this.limits.recipientsPerHour) {
      waits.push(freesAt(hour));
    }

    if (!this.#known.has(to)) {
      const fresh = hour.filter((r) => r.fresh);
      const freshOnes = new Set(fresh.map((r) => r.to));
      if (freshOnes.size >= this.limits.newRecipientsPerHour) waits.push(freesAt(fresh));
    }

    return waits.length ? Math.max(0, Math.max(...waits)) : 0;
  }

  #prune(now: number): void {
    this.#history = this.#history.filter((r) => now - r.at < DAY);
  }

  #load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as {
        history?: SendRecord[];
        known?: string[];
      };
      this.#history = (raw.history ?? []).filter((r) => typeof r?.at === 'number' && typeof r?.to === 'string');
      this.#known = new Set(raw.known ?? []);
      this.#prune(Date.now());
    } catch {
      // No file yet, or it is unreadable. Starting from an empty budget is the
      // permissive failure, but the alternative — refusing every send because a JSON
      // file is malformed — breaks the tool over bookkeeping.
    }
  }

  #save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // Cap the remembered set so the file cannot grow without bound; the oldest
      // entries are the least likely to be messaged again.
      const known = [...this.#known].slice(-2000);
      fs.writeFileSync(this.file, JSON.stringify({ history: this.#history, known }, null, 1));
    } catch {
      // Losing the log costs accuracy on the daily cap; failing the send costs the
      // user their message. Prefer the former.
    }
  }
}
