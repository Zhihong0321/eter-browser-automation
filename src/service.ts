import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'patchright';
import { BrowserManager } from './browser.js';
import { commentOnPost, readFeed, readMyPosts, type FbPost } from './facebook.js';
import * as gmap from './gmaprecon.js';
import { humanClick, humanType, pause } from './human.js';
import { LeadStore, toCsv } from './leads.js';
import { deepProbe, hintFor, learnCookies, PRESETS, quickProbe } from './probe.js';
import { SendLimiter } from './sendlimit.js';
import { analyzeSettle, assertReconAllowed, captureSettle, detectChallenge } from './recon.js';
import { scanSite, type ScanOptions, type SiteScan } from './recon-scan.js';
import { describeUrl, Vault, type SessionRecord } from './vault.js';
import * as wa from './whatsapp.js';

/** The host WhatsApp Web is enrolled under. */
const WA_HOST = 'web.whatsapp.com';

/** gmap-recon's own disposable Chrome — never the agent profile. See #gmapChrome. */
const GMAP_PROFILE = 'gmaprecon';

export interface SessionView extends SessionRecord {
  ageMinutes: number | null;
  stale: boolean;
}

const STALE_AFTER_MS = 30 * 60_000;

export class VaultService {
  readonly vault: Vault;
  readonly browser: BrowserManager;
  readonly sendLimiter: SendLimiter;
  #health: NodeJS.Timeout | null = null;
  // gmap-recon handles, created on first use — see #gmapChrome.
  #gmapBrowser: BrowserManager | null = null;
  #leads: LeadStore | null = null;
  #gmapLimiter: gmap.SearchLimiter | null = null;

  constructor(home: string) {
    this.vault = new Vault(home);
    this.browser = new BrowserManager(this.vault);
    // On disk, next to the manifest: the daemon restarts often, and an in-memory
    // counter would hand back a fresh daily budget every time it came up.
    this.sendLimiter = new SendLimiter(
      path.join(this.vault.home, 'send-history.json'),
      this.vault.manifest.settings.whatsappSend,
    );
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
      sendBudget: this.sendLimiter.snapshot(),
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
   * the tab may have been closed, crashed or left somewhere else.
   *
   * All three go through wa.warmPage so they share ONE tab. WhatsApp allows a single
   * active web client per linked device — a second tab takes the session over and
   * breaks the first. Never route this site through openTab().
   *
   * warmPage also PINS that tab against the idle shutdown. A WhatsApp client costs
   * 20-30s to boot; letting the idle timer close it meant re-paying that on the first
   * call after any five-minute gap, which dwarfed everything else these actions do.
   */
  #waPage(ctx: BrowserContext, page: Page): Promise<Page> {
    return wa.warmPage(ctx, page, (p) => this.browser.pin(p));
  }

  async waListChats(limit = 20): Promise<wa.WaChat[]> {
    await this.requireReady(WA_HOST);
    return this.browser.run(async (ctx, page) => wa.listChats(await this.#waPage(ctx, page), limit));
  }

  async waReadChat(target: string, limit = 20): Promise<{ chat: string; messages: wa.WaMessage[] }> {
    await this.requireReady(WA_HOST);
    return this.browser.run(async (ctx, page) => wa.readChat(await this.#waPage(ctx, page), target, limit));
  }

  /**
   * Sending is the only WhatsApp action with a budget, and it is NOT the generic
   * per-minute action limiter. See src/sendlimit.ts: what risks the number is how many
   * different people you contact, especially ones who never contacted you — not how
   * fast you click. Reads stay unmetered.
   *
   * The slot is booked before the send, not after a successful one. A send that fails
   * still reached WhatsApp, and a retry loop that only counts successes is how one
   * refused message becomes fifty.
   */
  async waSend(target: string, text: string): Promise<wa.WaSendResult> {
    await this.requireReady(WA_HOST);
    await this.sendLimiter.take(target);
    return this.browser.run(async (ctx, page) => wa.sendMessage(await this.#waPage(ctx, page), target, text));
  }

  /** Current outbound budget — what is left before a send starts waiting. */
  sendBudget() {
    return this.sendLimiter.snapshot();
  }

  // ------------------------------------------------------------- gmap-recon

  /**
   * gmap-recon owns a SEPARATE Chrome, never the agent profile. Two measured
   * reasons: Google silently degrades a profile that has been searching (101
   * results fresh, 64 once used), and Maps work would otherwise open tabs in the
   * context WhatsApp Web lives in, where a second tab seizes the session.
   *
   * All three handles are lazy — the daemon must not pay for a second browser or
   * create a database file unless a harvest actually runs.
   */
  #gmapChrome(): BrowserManager {
    if (!this.#gmapBrowser) {
      this.vault.ensureProfile(GMAP_PROFILE, 'gmap-recon (disposable)');
      this.#gmapBrowser = new BrowserManager(this.vault, GMAP_PROFILE);
    }
    return this.#gmapBrowser;
  }

  #leadStore(): LeadStore {
    this.#leads ??= new LeadStore(path.join(this.vault.home, 'gmap-leads.db'));
    return this.#leads;
  }

  #gmapBudget(): gmap.SearchLimiter {
    this.#gmapLimiter ??= new gmap.SearchLimiter(path.join(this.vault.home, 'gmap-search-history.json'));
    return this.#gmapLimiter;
  }

  gmapPlan(keywords: string[], places: string[]) {
    if (!keywords.length || !places.length) throw new Error('gmap_plan needs at least one keyword and one place');
    return this.#leadStore().plan(keywords, places);
  }

  gmapStatus() {
    return { ...this.#leadStore().status(), budget: this.#gmapBudget().snapshot() };
  }

  /**
   * Harvest a bounded chunk. Bounded because the daemon is request→response and a
   * full campaign runs for hours; the store holds all progress, so a crash costs
   * one chunk and never the run.
   *
   * A canary re-search leads the chunk. Google's throttle produces no captcha and
   * no error — just fewer results — so yield against a known baseline is the only
   * signal that distinguishes "this town is small" from "we are being throttled".
   * Banking short results silently would quietly lose a third of the leads.
   */
  async gmapHarvest(limit = 5): Promise<Record<string, unknown>> {
    const store = this.#leadStore();
    const pending = store.pendingSearches(limit);
    if (!pending.length) return { ran: 0, note: 'nothing pending', ...store.status() };

    const browser = this.#gmapChrome();
    const budget = this.#gmapBudget();
    let ran = 0;
    let found = 0;
    let halted: string | null = null;

    await browser.run(async (ctx, page) => {
      const tab = await gmap.warmPage(ctx, page, (p) => browser.pin(p));

      const canary = store.canaryBaseline();
      if (canary) {
        await budget.take();
        const check = await gmap.searchPlace(tab, canary.keyword, canary.place);
        if (check.found < canary.found * 0.75) {
          halted =
            `throttled: canary "${canary.keyword} ${canary.place}" returned ${check.found} ` +
            `against a baseline of ${canary.found}. Nothing harvested this call — ` +
            `results would be silently short. Let the profile rest and retry later.`;
          return;
        }
      }

      for (const s of pending) {
        await budget.take();
        try {
          const out = await gmap.searchPlace(tab, s.keyword, s.place);
          out.businesses.forEach((b, i) => store.upsertBusiness(b, s.id, i));
          store.completeSearch(s.id, out.found, out.hitCap);
          ran++;
          found += out.found;
        } catch (e) {
          const msg = String((e as Error).message ?? e);
          const blocked = msg.startsWith('blocked:');
          store.failSearch(s.id, msg, blocked);
          // A hard block is terminal for the call. Grinding on is how a temporary
          // throttle becomes a persistent one.
          if (blocked) {
            halted = msg;
            return;
          }
        }
      }
    });

    return { ran, found, halted, ...store.status() };
  }

  /**
   * Stage 2 is plain fetch, not the browser: these are ordinary third-party sites,
   * a different rate domain from Google entirely, and routing thousands of visits
   * through the single Chrome would block every other automation for hours.
   */
  async gmapEnrich(limit = 25): Promise<Record<string, unknown>> {
    const store = this.#leadStore();
    const rows = store.pendingEnrich(limit);
    let done = 0;
    let failed = 0;

    for (const r of rows) {
      if (!r.website) continue;
      try {
        store.completeEnrich(r.placeId, await gmap.enrichSite(r.website));
        done++;
      } catch (e) {
        store.failEnrich(r.placeId, String((e as Error).message ?? e));
        failed++;
      }
    }
    return { attempted: rows.length, done, failed, ...store.status() };
  }

  gmapExport(file: string, opts: { withPhoneOnly?: boolean; withEmailOnly?: boolean } = {}) {
    const rows = this.#leadStore().rows(opts);
    fs.writeFileSync(file, toCsv(rows), 'utf8');
    return { file, rows: rows.length };
  }

  // ------------------------------------------------------------------ recon

  /**
   * Watch one page settle and report what to wait on. Runs in a throwaway tab
   * so it never disturbs whatever the working tab is doing.
   */
  async reconProbe(url: string, windowMs = 8000) {
    const host = new URL(url).hostname;
    assertReconAllowed(host);
    await this.requireReady(host);

    return this.browser.runIsolated(async (_ctx, page) => {
      const trace = await captureSettle(page, url, windowMs);
      const body = await page.evaluate(() => (document.body?.textContent ?? '').slice(0, 2000)).catch(() => '');
      const challenge = detectChallenge(trace.url, trace.title, body);
      if (challenge) throw new Error(`recon aborted: ${challenge} challenge on ${trace.url}. Not retrying.`);
      return { trace, verdict: analyzeSettle(trace) };
    });
  }

  /**
   * Crawl a site and write scan.json. One launch, one throwaway tab, every
   * route — an open/close/reopen loop per page would cost minutes in cold
   * boots alone.
   */
  async reconScan(rootUrl: string, opts: ScanOptions = {}): Promise<SiteScan> {
    const host = new URL(rootUrl).hostname;
    assertReconAllowed(host);
    await this.requireReady(host);
    const outDir = path.join(this.vault.home, 'tools', host, 'recon');
    return this.browser.runIsolated((ctx, page) => scanSite(ctx, page, rootUrl, outDir, opts));
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
    // gmap-recon's Chrome and store only exist if a harvest ran.
    await this.#gmapBrowser?.close();
    this.#leads?.close();
  }
}
