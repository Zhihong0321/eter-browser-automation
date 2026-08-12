import type { Locator, Page } from 'patchright';

/**
 * Pacing + input helpers. The goal is not to "look human" cosmetically — it is to
 * avoid the two things platforms actually measure: impossible timing and burst rate.
 */

export function rand(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Idle pause between discrete actions. */
export function pause(min = 400, max = 1200): Promise<void> {
  return sleep(rand(min, max));
}

/** Token-bucket limiter so an agent cannot machine-gun a platform. */
export class RateLimiter {
  #stamps: number[] = [];
  constructor(private readonly perMinute: number) {}

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.#stamps = this.#stamps.filter((t) => now - t < 60_000);
      if (this.#stamps.length < this.perMinute) {
        this.#stamps.push(now);
        return;
      }
      const waitMs = 60_000 - (now - this.#stamps[0]) + 250;
      await sleep(waitMs);
    }
  }
}

/** Real CDP mouse input (isTrusted === true), preceded by a scroll into view and a beat. */
export async function humanClick(locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await pause(250, 700);
  await locator.click({ delay: rand(40, 120) });
}

/** Per-character typing with jitter, plus occasional longer "thinking" gaps. */
export async function humanType(locator: Locator, text: string): Promise<void> {
  await locator.click({ delay: rand(40, 110) });
  await pause(200, 600);
  for (const word of text.split(/(\s+)/)) {
    if (!word) continue;
    await locator.pressSequentially(word, { delay: rand(55, 145) });
    if (Math.random() < 0.15) await sleep(rand(180, 520));
  }
}

/** Incremental wheel scrolling — one giant jump to the page bottom is a classic tell. */
export async function humanScroll(page: Page, steps = 3): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, rand(450, 900));
    await pause(600, 1600);
  }
}
