import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium, type BrowserContext, type Page } from 'patchright';
import { DEFAULT_PROFILE_ID } from './config.js';
import { RateLimiter } from './human.js';
import type { Vault } from './vault.js';

const execFileAsync = promisify(execFile);

/** How long a rescued session cookie is allowed to live once we pin it to disk. */
const SESSION_COOKIE_TTL_MS = 30 * 24 * 60 * 60_000;
const SESSION_COOKIE_FILE = 'session-cookies.json';

/**
 * Chrome's own message when `launchPersistentContext` finds the user-data-dir's
 * singleton lock already held. In this app the lock almost never means "something
 * else is legitimately using this profile" — it means a PREVIOUS run of this same
 * service left a chrome.exe behind (killed service process, crash, restart) that
 * nothing here still has a handle on. #ensure() is the only launcher for this
 * profile, so on that specific failure it is safe to find and kill whatever
 * chrome.exe still points at this exact directory and try once more.
 */
function isProfileLockedByOrphan(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('Opening in existing browser session');
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Kill any chrome.exe whose own command line names this profile directory. Windows only. */
async function killOrphanedChrome(profileDir: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const needle = profileDir.toLowerCase();
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
      ],
      { timeout: 5000 },
    );
    const parsed: unknown = stdout.trim() ? JSON.parse(stdout) : [];
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const pids = rows
      .filter((r): r is { ProcessId: number; CommandLine?: string } => !!r && typeof r === 'object')
      .filter((r) => (r.CommandLine ?? '').toLowerCase().includes(needle))
      .map((r) => r.ProcessId);

    for (const pid of pids) {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 5000 }).catch(() => {});
    }
  } catch {
    /* best effort — if enumeration fails the retry below just fails again with the same error */
  }
}

export type BrowserState = 'stopped' | 'starting' | 'running';

/**
 * Runtime-behaviour flags merged into every launch, on top of whatever the profile
 * manifest recorded.
 *
 * These are deliberately NOT fingerprint flags — they change nothing a site can
 * observe, so the "replay the enrolled launch verbatim" rule in #ensure() still
 * holds. What they do is stop Chrome from throttling a window it thinks nobody is
 * looking at, which matters now that pinned pages keep a tab warm for minutes at a
 * time: an occluded renderer gets its timers clamped, and a clamped renderer means
 * the WhatsApp SPA we are paying to keep hot goes cold anyway. Windows is the worst
 * offender here, hence the native-occlusion opt-out.
 */
const PERF_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
  '--mute-audio',
];

/**
 * Owns the single Chrome process for a profile.
 *
 * One user-data-dir allows exactly one Chrome, so every consumer (dashboard, health
 * checker, MCP tool calls) funnels through this one object and its serialized queue.
 * Nothing else in the codebase is allowed to launch a browser.
 */
/**
 * Combine two arg lists without duplicates, folding every `--disable-features=`
 * into ONE flag. Chrome does not union repeated occurrences — the last one wins —
 * so appending a second copy would silently drop whatever the manifest asked for.
 */
function mergeArgs(base: readonly string[], extra: readonly string[]): string[] {
  const FEATURES = '--disable-features=';
  const features = new Set<string>();
  const out: string[] = [];

  for (const arg of [...base, ...extra]) {
    if (arg.startsWith(FEATURES)) {
      for (const f of arg.slice(FEATURES.length).split(',')) if (f) features.add(f);
    } else if (!out.includes(arg)) {
      out.push(arg);
    }
  }

  if (features.size > 0) out.push(FEATURES + [...features].join(','));
  return out;
}

export class BrowserManager {
  #ctx: BrowserContext | null = null;
  #state: BrowserState = 'stopped';
  #queue: Promise<unknown> = Promise.resolve();
  #idleTimer: NodeJS.Timeout | null = null;
  #startedAt: number | null = null;
  #lastError: string | null = null;
  /** Pages whose existence blocks the idle shutdown. See pin(). */
  #pinned = new Set<Page>();
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

  #cookieCachePath(): string {
    return path.join(this.vault.profileDir(this.profileId), SESSION_COOKIE_FILE);
  }

  /**
   * Carry non-persistent cookies across a Chrome restart.
   *
   * Chrome only writes cookies to disk if the site gave them an expiry, so a
   * site that authenticates with a session cookie is signed out the moment the
   * idle timer closes the browser — and the user is told "session cookie gone"
   * on the next check, which reads like the check destroyed it. AutoCount Cloud
   * is the reference case: its IdentityServer cookie
   * (.AspNetCore.Identity.Application, on auth.autocountcloud.com) is
   * non-persistent unless "remember me" was ticked, so nothing survived a close.
   *
   * We save those cookies ourselves on shutdown and put them back on launch with
   * a real expiry. Persistent cookies are left alone — Chrome already handles
   * them, and rewriting them here would only fight its own store.
   */
  async #saveSessionCookies(ctx: BrowserContext): Promise<void> {
    try {
      const all = await ctx.cookies();
      const transient = all.filter((c) => c.value && (!c.expires || c.expires <= 0));
      const stamped = transient.map((c) => ({ ...c, expires: (Date.now() + SESSION_COOKIE_TTL_MS) / 1000 }));
      fs.writeFileSync(this.#cookieCachePath(), JSON.stringify(stamped));
    } catch {
      /* best effort — never block shutdown on this */
    }
  }

  async #restoreSessionCookies(ctx: BrowserContext): Promise<void> {
    const file = this.#cookieCachePath();
    if (!fs.existsSync(file)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Awaited<ReturnType<BrowserContext['cookies']>>;
      const live = saved.filter((c) => c.expires * 1000 > Date.now());
      if (live.length) await ctx.addCookies(live);
    } catch {
      /* a corrupt cache just means the user signs in again */
    }
  }

  /** Launch (or reuse) the persistent context. Never call outside `run()`. */
  async #ensure(): Promise<BrowserContext> {
    if (this.#ctx) return this.#ctx;

    const profile = this.vault.profile(this.profileId);
    const dir = this.vault.profileDir(this.profileId);
    this.#state = 'starting';
    this.#lastError = null;

    // Replayed verbatim from the manifest so the fingerprint the site enrolled
    // against is the fingerprint it sees on every subsequent run.
    const launch = () =>
      chromium.launchPersistentContext(dir, {
        channel: profile.launch.channel,
        headless: profile.launch.headless,
        args: mergeArgs(profile.launch.args, PERF_ARGS),
        viewport: null,
        ignoreDefaultArgs: ['--enable-automation'],
      });

    try {
      let ctx: BrowserContext;
      try {
        ctx = await launch();
      } catch (err) {
        if (!isProfileLockedByOrphan(err)) throw err;
        // This service's own #ctx is null right now (we're in #ensure()), so any
        // chrome.exe still holding this profile's lock cannot be one we know
        // about — it is left over from a previous run. Clear it and try once more.
        await killOrphanedChrome(dir);
        await delay(500);
        ctx = await launch();
      }

      ctx.on('close', () => {
        this.#ctx = null;
        this.#state = 'stopped';
        this.#startedAt = null;
        this.#pinned.clear();
        this.#clearIdle();
      });

      this.#ctx = ctx;
      this.#state = 'running';
      this.#startedAt = Date.now();
      await this.#restoreSessionCookies(ctx);
      return ctx;
    } catch (err) {
      this.#state = 'stopped';
      this.#lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /**
   * Exempt a page from the idle shutdown for as long as it stays open.
   *
   * The idle timer exists to stop an unused Chrome sitting around forever, and for
   * an ordinary tab that is the right call — reopening one costs a page load. But
   * some tabs are not cheap to recreate. A linked-device WhatsApp Web client takes
   * 20-30s to boot: bundle, IndexedDB, Noise handshake, chat sync. Closing that after
   * five idle minutes means every call that follows a coffee break pays the full boot
   * again, which was by far the largest cost in the whole system.
   *
   * So the owner of such a tab pins it, and the idle timer stops arming until the tab
   * is actually gone. Closed pages are pruned on each check, so a pin can never
   * outlive its page and wedge the browser open forever.
   */
  pin(page: Page): void {
    this.#pinned.add(page);
    page.once('close', () => {
      this.#pinned.delete(page);
      this.#armIdle();
    });
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

  /** Explicit shutdown. Overrides pins — a pin defers the idle timer, not the user. */
  async close(): Promise<void> {
    this.#clearIdle();
    this.#pinned.clear();
    const ctx = this.#ctx;
    this.#ctx = null;
    this.#state = 'stopped';
    this.#startedAt = null;
    if (ctx) {
      await this.#saveSessionCookies(ctx);
      await ctx.close().catch(() => {});
    }
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

    // Prune first: a pin must not outlive the page that asked for it, or a crashed
    // tab would keep Chrome alive indefinitely.
    for (const p of this.#pinned) if (p.isClosed()) this.#pinned.delete(p);
    if (this.#pinned.size > 0) return;

    // Snapshot now as well: if the user closes the Chrome window by hand we never
    // get a shutdown hook, and the in-memory session cookies would be lost.
    if (this.#ctx) void this.#saveSessionCookies(this.#ctx);

    this.#idleTimer = setTimeout(() => void this.close(), ms);
    this.#idleTimer.unref?.();
  }
}
