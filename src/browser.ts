import { chromium, type BrowserContext, type Page } from 'patchright';
import { DEFAULT_PROFILE_ID } from './config.js';
import { RateLimiter } from './human.js';
import type { Vault } from './vault.js';

export type BrowserState = 'stopped' | 'starting' | 'running';

/**
 * Owns the single Chrome process for a profile.
 *
 * One user-data-dir allows exactly one Chrome, so every consumer (dashboard, health
 * checker, MCP tool calls) funnels through this one object and its serialized queue.
 * Nothing else in the codebase is allowed to launch a browser.
 */
export class BrowserManager {
  #ctx: BrowserContext | null = null;
  #state: BrowserState = 'stopped';
  #queue: Promise<unknown> = Promise.resolve();
  #idleTimer: NodeJS.Timeout | null = null;
  #startedAt: number | null = null;
  #lastError: string | null = null;
  readonly limiter: RateLimiter;

  constructor(
    private readonly vault: Vault,
    private readonly profileId: string = DEFAULT_PROFILE_ID,
  ) {
    this.limiter = new RateLimiter(vault.manifest.settings.maxActionsPerMinute);
  }

  get state(): BrowserState {
    return this.#state;
  }

  get info() {
    return {
      state: this.#state,
      profileId: this.profileId,
      profileDir: this.vault.profileDir(this.profileId),
      startedAt: this.#startedAt ? new Date(this.#startedAt).toISOString() : null,
      lastError: this.#lastError,
      pages: this.#ctx?.pages().length ?? 0,
    };
  }

  /** Launch (or reuse) the persistent context. Never call outside `run()`. */
  async #ensure(): Promise<BrowserContext> {
    if (this.#ctx) return this.#ctx;

    const profile = this.vault.profile(this.profileId);
    const dir = this.vault.profileDir(this.profileId);
    this.#state = 'starting';
    this.#lastError = null;

    try {
      // Replayed verbatim from the manifest so the fingerprint the site enrolled
      // against is the fingerprint it sees on every subsequent run.
      const ctx = await chromium.launchPersistentContext(dir, {
        channel: profile.launch.channel,
        headless: profile.launch.headless,
        args: profile.launch.args,
        viewport: null,
        ignoreDefaultArgs: ['--enable-automation'],
      });

      ctx.on('close', () => {
        this.#ctx = null;
        this.#state = 'stopped';
        this.#startedAt = null;
        this.#clearIdle();
      });

      this.#ctx = ctx;
      this.#state = 'running';
      this.#startedAt = Date.now();
      return ctx;
    } catch (err) {
      this.#state = 'stopped';
      this.#lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /** The working tab. Reuses the tab Chrome already opened rather than spawning more. */
  async page(ctx: BrowserContext): Promise<Page> {
    const open = ctx.pages().filter((p) => !p.isClosed());
    if (open.length > 0) return open[0];
    return ctx.newPage();
  }

  /**
   * Serialized access to the browser. Every caller goes through here, so two agent
   * requests can never drive the same tab at once or corrupt the profile.
   */
  run<T>(fn: (ctx: BrowserContext, page: Page) => Promise<T>): Promise<T> {
    const task = this.#queue.then(async () => {
      this.#clearIdle();
      const ctx = await this.#ensure();
      const page = await this.page(ctx);
      try {
        return await fn(ctx, page);
      } finally {
        this.#armIdle();
      }
    });
    // Keep the chain alive even when a task rejects.
    this.#queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task as Promise<T>;
  }

  /**
   * Opens a NEW tab, focuses it, and leaves it open. For human sign-in flows,
   * so starting a login does not destroy whatever is in the working tab.
   */
  openTab<T>(fn: (ctx: BrowserContext, page: Page) => Promise<T>): Promise<T> {
    const task = this.#queue.then(async () => {
      this.#clearIdle();
      const ctx = await this.#ensure();
      const page = await ctx.newPage();
      try {
        return await fn(ctx, page);
      } finally {
        await page.bringToFront().catch(() => {});
        this.#armIdle();
      }
    });
    this.#queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task as Promise<T>;
  }

  /**
   * Same queue, but the callback gets a THROWAWAY tab that is closed afterwards.
   *
   * Health checks and login probes must never navigate the tab the user or the
   * agent is working in — otherwise a background check silently yanks you off
   * whatever you were doing and onto some unrelated site.
   */
  runIsolated<T>(fn: (ctx: BrowserContext, page: Page) => Promise<T>): Promise<T> {
    const task = this.#queue.then(async () => {
      this.#clearIdle();
      const ctx = await this.#ensure();
      const scratch = await ctx.newPage();
      try {
        return await fn(ctx, scratch);
      } finally {
        await scratch.close().catch(() => {});
        this.#armIdle();
      }
    });
    this.#queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task as Promise<T>;
  }

  async close(): Promise<void> {
    this.#clearIdle();
    const ctx = this.#ctx;
    this.#ctx = null;
    this.#state = 'stopped';
    this.#startedAt = null;
    if (ctx) await ctx.close().catch(() => {});
  }

  #clearIdle(): void {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }

  #armIdle(): void {
    const ms = this.vault.manifest.settings.idleTimeoutMs;
    if (!ms) return; // 0 = keep the browser open
    this.#clearIdle();
    this.#idleTimer = setTimeout(() => void this.close(), ms);
    this.#idleTimer.unref?.();
  }
}
