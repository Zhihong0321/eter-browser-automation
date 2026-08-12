import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'patchright';
import { BrowserManager } from './browser.js';
import { commentOnPost, readFeed, readMyPosts, type FbPost } from './facebook.js';
import { humanClick, humanType, pause } from './human.js';
import { deepProbe, hintFor, learnCookies, PRESETS, quickProbe } from './probe.js';
import { describeUrl, Vault, type SessionRecord } from './vault.js';
import * as wa from './whatsapp.js';

/** The host WhatsApp Web is enrolled under. */
const WA_HOST = 'web.whatsapp.com';

export interface SessionView extends SessionRecord {
  ageMinutes: number | null;
  stale: boolean;
}

const STALE_AFTER_MS = 30 * 60_000;

export class VaultService {
  readonly vault: Vault;
  readonly browser: BrowserManager;
  #health: NodeJS.Timeout | null = null;

  constructor(home: string) {
    this.vault = new Vault(home);
    this.browser = new BrowserManager(this.vault);
  }

  // ---------------------------------------------------------------- status

  status() {
    const sessions: SessionView[] = this.vault.sessions().map((s) => {
      const age = s.lastCheckedAt ? Date.now() - new Date(s.lastCheckedAt).getTime() : null;
      return {
        ...s,
        ageMinutes: age === null ? null : Math.round(age / 60_000),
        stale: age === null || age > STALE_AFTER_MS,
      };
    });

    return {
      vaultHome: this.vault.home,
      profileInitialized: this.vault.profileInitialized(),
      browser: this.browser.info,
      sessions,
      presets: PRESETS,
      settings: this.vault.manifest.settings,
    };
  }

  readySessions(): SessionView[] {
    return this.status().sessions.filter((s) => s.status === 'ready');
  }

  // ------------------------------------------------------------ enrollment

  /**
   * Add ANY url. Opens the agent Chrome there so the human can sign in.
   * Nothing about the site needs to be known in advance.
   */
  async addSession(rawUrl: string, label?: string) {
    const rec = this.vault.add(rawUrl, label);
    await this.#showLoginPage(rec);
    return { session: rec, message: `Chrome opened at ${rec.url}. Sign in, then press "I've signed in".` };
  }

  /** Re-open an existing session's page so the user can sign in again. */
  async openSession(id: string) {
    const rec = this.vault.session(id);
    await this.#showLoginPage(rec);
    return { session: rec, message: `Chrome opened at ${rec.url}.` };
  }

  /**
   * Put the site's login page in front of the human.
   *
   * A login gets its own tab so it never commandeers the working tab — but if a
   * tab for that origin is ALREADY open it is reused, because some sites permit
   * only one live tab of themselves. WhatsApp Web is the reference case: a second
   * tab seizes the linked-device session and the first drops to "WhatsApp is open
   * in another window".
   */
  async #showLoginPage(rec: SessionRecord): Promise<void> {
    const existing = await this.browser.run(async (ctx) =>
      ctx.pages().some((p) => !p.isClosed() && p.url().startsWith(rec.origin)),
    );

    const go = async (_ctx: unknown, page: Page) => {
      await page.goto(rec.url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
    };

    if (existing) {
      await this.browser.run(async (ctx, page) => {
        const open = ctx.pages().find((p) => !p.isClosed() && p.url().startsWith(rec.origin)) ?? page;
        await open.bringToFront().catch(() => {});
        return go(ctx, open);
      });
      return;
    }
    await this.browser.openTab(go);
  }

  /**
   * The user says they signed in: learn which cookies the site set, then verify.
   * This is what replaces a hardcoded per-site cookie list.
   */
  async confirmSession(id: string): Promise<SessionRecord> {
    const rec = this.vault.session(id);
    const learned = await this.browser.run((ctx) => learnCookies(ctx, rec.origin));
    // "No cookies" only means "not signed in" for sites that authenticate with
    // cookies. A hinted site (WhatsApp Web) legitimately has none, and rejecting
    // it here would mark a perfectly good session logged_out forever.
    if (!learned.length && !hintFor(rec)) {
      return this.vault.update(id, {
        status: 'logged_out',
        statusDetail: `No cookies were set for ${rec.origin} — did the sign-in complete?`,
        lastCheckedAt: new Date().toISOString(),
      });
    }
    if (learned.length) this.vault.update(id, { cookieNames: learned });
    return this.checkSession(id, true);
  }

  async removeSession(id: string) {
    this.vault.remove(id);
    return { id, removed: true };
  }

  async renameSession(id: string, label: string) {
    return this.vault.update(id, { label: label.trim() || this.vault.session(id).label });
  }

  // --------------------------------------------------------------- probing

  async checkSession(id: string, deep = true): Promise<SessionRecord> {
    const rec = this.vault.session(id);
    // Probes run in a throwaway tab so they never navigate the working tab.
    const result = deep
      ? await this.browser.runIsolated((ctx, page) => deepProbe(ctx, page, rec))
      : await this.browser.run((ctx) => quickProbe(ctx, rec));
    return this.vault.update(id, {
      status: result.status,
      statusDetail: result.detail,
      cookieExpiresAt: result.cookieExpiresAt,
      lastCheckedAt: new Date().toISOString(),
    });
  }

  async checkAll(deep = true): Promise<SessionRecord[]> {
    const out: SessionRecord[] = [];
    for (const s of this.vault.sessions()) out.push(await this.checkSession(s.id, deep));
    return out;
  }

  /** Find the session covering a hostname, e.g. "facebook.com". */
  findByHost(host: string): SessionRecord | undefined {
    const want = describeUrl(host).id;
    return this.vault.sessions().find((s) => s.id === want);
  }

  async requireReady(host: string): Promise<SessionRecord> {
    const rec = this.findByHost(host);
    if (!rec) throw new Error(`No session for ${host}. Add it in the dashboard, or call add_session with its URL.`);

    const age = rec.lastCheckedAt ? Date.now() - new Date(rec.lastCheckedAt).getTime() : Infinity;
    if (rec.status === 'ready' && age < STALE_AFTER_MS) return rec;

    // Cookies first — costs nothing and no navigation. Only pay for a real page
    // load if the cheap check says something is actually wrong.
    const cheap = await this.checkSession(rec.id, false);
    if (cheap.status === 'ready') return cheap;

    const checked = await this.checkSession(rec.id, true);
    if (checked.status === 'ready') return checked;
    throw new Error(
      `Session "${rec.label}" is ${checked.status}: ${checked.statusDetail ?? 'unknown'}. ` +
        `Ask the user to open the dashboard and sign in again.`,
    );
  }

  // ------------------------------------------------------- facebook actions

  async fbReadMyPosts(limit = 5): Promise<FbPost[]> {
    await this.requireReady('facebook.com');
    return this.browser.run((_ctx, page) => readMyPosts(page, limit));
  }

  async fbReadFeed(limit = 5): Promise<FbPost[]> {
    await this.requireReady('facebook.com');
    return this.browser.run((_ctx, page) => readFeed(page, limit));
  }

  async fbComment(postUrl: string, text: string) {
    await this.requireReady('facebook.com');
    await this.browser.limiter.take();
    return this.browser.run((_ctx, page) => commentOnPost(page, postUrl, text));
  }

  // ------------------------------------------------------- whatsapp actions

  /**
   * Every WhatsApp entry point re-navigates and waits for the app itself, because
   * the browser idle-closes between calls and comes back on about:blank.
   *
   * All three go through wa.resolvePage so they share ONE tab. WhatsApp allows a
   * single active web client per linked device — a second tab takes the session
   * over and breaks the first. Never route this site through openTab().
   */
  async waListChats(limit = 20): Promise<wa.WaChat[]> {
    await this.requireReady(WA_HOST);
    return this.browser.run(async (ctx, page) => wa.listChats(await wa.resolvePage(ctx, page), limit));
  }

  async waReadChat(target: string, limit = 20): Promise<{ chat: string; messages: wa.WaMessage[] }> {
    await this.requireReady(WA_HOST);
    return this.browser.run(async (ctx, page) => wa.readChat(await wa.resolvePage(ctx, page), target, limit));
  }

  async waSend(target: string, text: string): Promise<wa.WaSendResult> {
    await this.requireReady(WA_HOST);
    await this.browser.limiter.take();
    return this.browser.run(async (ctx, page) => wa.sendMessage(await wa.resolvePage(ctx, page), target, text));
  }

  // -------------------------------------------------------- generic driving

  async navigate(url: string) {
    return this.browser.run(async (_ctx, page) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      return { url: page.url(), title: await page.title() };
    });
  }

  async readText(maxChars = 8000) {
    return this.browser.run(async (_ctx, page) => {
      const text = await page.evaluate(() => document.body?.innerText ?? '');
      return {
        url: page.url(),
        title: await page.title(),
        text: text.replace(/\n{3,}/g, '\n\n').slice(0, maxChars),
        truncated: text.length > maxChars,
      };
    });
  }

  async clickText(name: string, role?: string) {
    await this.browser.limiter.take();
    return this.browser.run(async (_ctx, page) => {
      const target = role
        ? page.getByRole(role as Parameters<Page['getByRole']>[0], { name: new RegExp(name, 'i') }).first()
        : page.getByText(new RegExp(name, 'i')).first();
      if ((await target.count()) === 0) throw new Error(`Nothing matching "${name}" on ${page.url()}`);
      await humanClick(target);
      await pause(600, 1400);
      return { url: page.url(), clicked: name };
    });
  }

  async typeInto(label: string, text: string, submit = false) {
    await this.browser.limiter.take();
    return this.browser.run(async (_ctx, page) => {
      const field = page
        .getByRole('textbox', { name: new RegExp(label, 'i') })
        .or(page.getByPlaceholder(new RegExp(label, 'i')))
        .or(page.getByLabel(new RegExp(label, 'i')))
        .first();
      if ((await field.count()) === 0) throw new Error(`No input matching "${label}" on ${page.url()}`);
      await humanType(field, text);
      if (submit) {
        await pause(300, 800);
        await field.press('Enter');
        await pause(1000, 2000);
      }
      return { url: page.url(), typedInto: label, submitted: submit };
    });
  }

  /** Arbitrary in-page JS for diagnosing selector drift. Off unless ETER_BROWSER_DEBUG=1. */
  async evaluate(expression: string) {
    if (process.env.ETER_BROWSER_DEBUG !== '1') {
      throw new Error('eval is disabled. Restart the daemon with ETER_BROWSER_DEBUG=1 to enable it.');
    }
    return this.browser.run(async (_ctx, page) => ({
      url: page.url(),
      result: await page.evaluate(`(() => { ${expression} })()`),
    }));
  }

  async screenshot() {
    const dir = path.join(this.vault.home, 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `shot-${Date.now()}.png`);
    await this.browser.run(async (_ctx, page) => page.screenshot({ path: file, fullPage: false }));
    return { path: file };
  }

  // ------------------------------------------------------------- lifecycle

  startHealthLoop(): void {
    const ms = this.vault.manifest.settings.healthIntervalMs;
    if (!ms || this.#health) return;
    this.#health = setInterval(() => {
      if (this.browser.state !== 'running') return;
      // Cookie-only. A background timer must never load pages — that is what was
      // dragging the browser onto unrelated sites mid-task.
      void this.checkAll(false).catch(() => {});
    }, ms);
    this.#health.unref?.();
  }

  async shutdown(): Promise<void> {
    if (this.#health) clearInterval(this.#health);
    this.#health = null;
    await this.browser.close();
  }
}
