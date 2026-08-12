import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'patchright';
import { BrowserManager } from './browser.js';
import { DEFAULT_PROFILE_ID } from './config.js';
import { commentOnPost, readFeed, readMyPosts, type FbPost } from './facebook.js';
import * as gmap from './gmaprecon.js';
import { humanClick, humanType, pause } from './human.js';
import {
  LeadStore,
  toCsv,
  type BusinessRow,
  type EnrichResult,
  type ExportResult,
  type HarvestResult,
  type PlanResult,
  type StatusResult,
} from './leads.js';
import { deepProbe, hintFor, learnCookies, PRESETS, quickProbe } from './probe.js';
import { ReadLimiter, type ReadLimits } from './readlimit.js';
import { runReconSweep } from './fb-recon/index.js';
import { loadPack, savePack, starterPack, type TopicPack } from './fb-recon/topic.js';
import { parseSource, type SourceSpec } from './fb-recon/sources.js';
// `toCsv` is already taken by the gmap lead store, so fb-recon's is aliased.
import { toCsv as contactsToCsv, type ContactMap } from './fb-recon/store.js';
import { listProjects, ProjectRun, reapStaleProjects, type ProjectContact, type ProjectFile } from './fb-recon/project.js';
import { loadLedger, priorProjects, recordProject, saveLedger } from './fb-recon/ledger.js';
import { renderIndex } from './fb-recon/report.js';
import { SendLimiter } from './sendlimit.js';
import { analyzeSettle, assertReconAllowed, captureSettle, detectChallenge } from './recon.js';
import { scanSite, type ScanOptions, type SiteScan } from './recon-scan.js';
import { isVerifiedRead } from './recon-net.js';
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

/**
 * What STARTING an fb-recon run hands back. The sweep is still going: poll
 * `fbReconProject(projectId)` — or just open reportHtml, which refreshes itself —
 * until `project.status` leaves "running".
 */
export interface FbReconResult {
  projectId: string;
  projectDir: string;
  reportHtml: string;
  project: ProjectFile;
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
  #gmapProjectDir: string | null = null;
  /** The id of the fb-recon sweep in flight, if any. One at a time — see fbRecon. */
  #fbReconActive: string | null = null;

  /**
   * One BrowserManager per Chrome profile, created on first use.
   *
   * Chrome takes an exclusive lock on a --user-data-dir, so one profile is one
   * Chrome and one Chrome is one point of failure: everything sharing a profile
   * dies together when it is closed or restarted. Giving a job its own profile
   * is therefore the only real isolation available — it is what gmap-recon
   * already does, and it is what lets a Facebook sweep survive another session
   * restarting the agent browser.
   *
   * There is no cap on how many profiles exist. Each costs a directory under
   * <home>/profiles/<id> (a few hundred MB once Chrome has run) and, while
   * active, one Chrome process.
   */
  #browsers = new Map<string, BrowserManager>();

  constructor(home: string) {
    this.vault = new Vault(home);
    this.browser = new BrowserManager(this.vault);
    this.#browsers.set(DEFAULT_PROFILE_ID, this.browser);
    // On disk, next to the manifest: the daemon restarts often, and an in-memory
    // counter would hand back a fresh daily budget every time it came up.
    this.sendLimiter = new SendLimiter(
      path.join(this.vault.home, 'send-history.json'),
      this.vault.manifest.settings.whatsappSend,
    );
  }

  // -------------------------------------------------------------- profiles

  /** The browser for a profile, launched on first use. */
  browserFor(profileId = DEFAULT_PROFILE_ID): BrowserManager {
    // Fail here rather than at launch: a typo'd profile id would otherwise mint
    // an empty Chrome with no logins and report "logged out" for everything.
    this.vault.profile(profileId);
    let b = this.#browsers.get(profileId);
    if (!b) {
      b = new BrowserManager(this.vault, profileId);
      this.#browsers.set(profileId, b);
    }
    return b;
  }

  /** Every Chrome profile, with its sessions and whether its Chrome is up. */
  listProfiles() {
    return Object.values(this.vault.manifest.profiles).map((p) => ({
      id: p.id,
      label: p.label,
      createdAt: p.createdAt,
      dir: this.vault.profileDir(p.id),
      initialized: this.vault.profileInitialized(p.id),
      browser: this.#browsers.get(p.id)?.info.state ?? 'stopped',
      sessions: Object.values(p.sessions).map((s) => ({ id: s.id, label: s.label, status: s.status })),
    }));
  }

  /**
   * Create a Chrome profile. Idempotent — an existing id is returned untouched,
   * because minting over a live profile would discard its logins.
   */
  createProfile(id: string, label?: string) {
    const clean = id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!clean) throw new Error('A profile id must contain at least one letter or digit.');
    const rec = this.vault.ensureProfile(clean, label?.trim() || clean);
    return { ...rec, dir: this.vault.profileDir(clean), initialized: this.vault.profileInitialized(clean) };
  }

  // ---------------------------------------------------------------- status

  status(profileId = DEFAULT_PROFILE_ID) {
    const sessions: SessionView[] = this.vault.sessions(profileId).map((s) => {
      const age = s.lastCheckedAt ? Date.now() - new Date(s.lastCheckedAt).getTime() : null;
      return {
        ...s,
        ageMinutes: age === null ? null : Math.round(age / 60_000),
        stale: age === null || age > STALE_AFTER_MS,
      };
    });

    return {
      vaultHome: this.vault.home,
      profileId,
      profileInitialized: this.vault.profileInitialized(profileId),
      browser: this.browserFor(profileId).info,
      profiles: this.listProfiles(),
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
  async addSession(rawUrl: string, label?: string, profileId = DEFAULT_PROFILE_ID) {
    const rec = this.vault.add(rawUrl, label, profileId);
    await this.#showLoginPage(rec, profileId);
    return {
      session: rec,
      profileId,
      message: `Chrome (profile "${profileId}") opened at ${rec.url}. Sign in, then press "I've signed in".`,
    };
  }

  /** Re-open an existing session's page so the user can sign in again. */
  async openSession(id: string, profileId = DEFAULT_PROFILE_ID) {
    const rec = this.vault.session(id, profileId);
    await this.#showLoginPage(rec, profileId);
    return { session: rec, profileId, message: `Chrome (profile "${profileId}") opened at ${rec.url}.` };
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
  async #showLoginPage(rec: SessionRecord, profileId = DEFAULT_PROFILE_ID): Promise<void> {
    const browser = this.browserFor(profileId);
    const existing = await browser.run(async (ctx) =>
      ctx.pages().some((p) => !p.isClosed() && p.url().startsWith(rec.origin)),
    );

    const go = async (_ctx: unknown, page: Page) => {
      await page.goto(rec.url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
    };

    if (existing) {
      await browser.run(async (ctx, page) => {
        const open = ctx.pages().find((p) => !p.isClosed() && p.url().startsWith(rec.origin)) ?? page;
        await open.bringToFront().catch(() => {});
        return go(ctx, open);
      });
      return;
    }
    await browser.openTab(go);
  }

  /**
   * The user says they signed in: learn which cookies the site set, then verify.
   * This is what replaces a hardcoded per-site cookie list.
   */
  async confirmSession(id: string, profileId = DEFAULT_PROFILE_ID): Promise<SessionRecord> {
    const rec = this.vault.session(id, profileId);
    const learned = await this.browserFor(profileId).run((ctx) => learnCookies(ctx, rec.origin));
    // "No cookies" only means "not signed in" for sites that authenticate with
    // cookies. A hinted site (WhatsApp Web) legitimately has none, and rejecting
    // it here would mark a perfectly good session logged_out forever.
    if (!learned.length && !hintFor(rec)) {
      return this.vault.update(id, {
        status: 'logged_out',
        statusDetail: `No cookies were set for ${rec.origin} — did the sign-in complete?`,
        lastCheckedAt: new Date().toISOString(),
      }, profileId);
    }
    if (learned.length) this.vault.update(id, { cookieNames: learned }, profileId);
    return this.checkSession(id, true, profileId);
  }

  async removeSession(id: string, profileId = DEFAULT_PROFILE_ID) {
    this.vault.remove(id, profileId);
    return { id, removed: true };
  }

  async renameSession(id: string, label: string, profileId = DEFAULT_PROFILE_ID) {
    return this.vault.update(id, { label: label.trim() || this.vault.session(id, profileId).label }, profileId);
  }

  // --------------------------------------------------------------- probing

  async checkSession(id: string, deep = true, profileId = DEFAULT_PROFILE_ID): Promise<SessionRecord> {
    const rec = this.vault.session(id, profileId);
    const browser = this.browserFor(profileId);
    // Probes run in a throwaway tab so they never navigate the working tab.
    const result = deep
      ? await browser.runIsolated((ctx, page) => deepProbe(ctx, page, rec))
      : await browser.run((ctx) => quickProbe(ctx, rec));
    return this.vault.update(id, {
      status: result.status,
      statusDetail: result.detail,
      cookieExpiresAt: result.cookieExpiresAt,
      lastCheckedAt: new Date().toISOString(),
    }, profileId);
  }

  async checkAll(deep = true, profileId = DEFAULT_PROFILE_ID): Promise<SessionRecord[]> {
    const out: SessionRecord[] = [];
    for (const s of this.vault.sessions(profileId)) out.push(await this.checkSession(s.id, deep, profileId));
    return out;
  }

  /** Find the session covering a hostname, e.g. "facebook.com". */
  findByHost(host: string, profileId = DEFAULT_PROFILE_ID): SessionRecord | undefined {
    const want = describeUrl(host).id;
    return this.vault.sessions(profileId).find((s) => s.id === want);
  }

  async requireReady(host: string, profileId = DEFAULT_PROFILE_ID): Promise<SessionRecord> {
    const rec = this.findByHost(host, profileId);
    if (!rec) {
      throw new Error(
        `No session for ${host} in profile "${profileId}". ` +
          `Sign in there first:  eter-browser login ${host} --profile ${profileId}`,
      );
    }

    const age = rec.lastCheckedAt ? Date.now() - new Date(rec.lastCheckedAt).getTime() : Infinity;
    if (rec.status === 'ready' && age < STALE_AFTER_MS) return rec;

    // Cookies first — costs nothing and no navigation. Only pay for a real page
    // load if the cheap check says something is actually wrong.
    const cheap = await this.checkSession(rec.id, false, profileId);
    if (cheap.status === 'ready') return cheap;

    const checked = await this.checkSession(rec.id, true, profileId);
    if (checked.status === 'ready') return checked;
    throw new Error(
      `Session "${rec.label}" in profile "${profileId}" is ${checked.status}: ` +
        `${checked.statusDetail ?? 'unknown'}. Ask the user to sign in again.`,
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

  /**
   * fb-recon: topic-driven, read-only prospecting.
   *
   * State lives under <home>/fb-recon/ so a re-run resumes rather than
   * re-harvesting: read-history.json holds the hourly page-open budget and
   * topics/ holds the hand-tuned keyword packs. Everything else is per project.
   */
  async fbRecon(opts: {
    topic: string;
    sources?: string[];
    minScore?: number;
    limits?: Partial<ReadLimits>;
    /**
     * Which Chrome profile to sweep in. Give fb-recon its own profile with its
     * own Facebook login and a sweep can no longer be killed by anything that
     * restarts the agent browser — that was the single biggest cause of
     * truncated harvests.
     */
    profile?: string;
  }): Promise<FbReconResult> {
    const profileId = opts.profile ?? DEFAULT_PROFILE_ID;
    const dir = path.join(this.vault.home, 'fb-recon');
    const packDir = path.join(dir, 'topics');
    const projectsRoot = path.join(dir, 'projects');
    const ledgerFile = path.join(dir, 'ledger.json');

    // The pack is generated once and hand-edited forever. A scan never
    // overwrites it — the human's tuning is the most valuable thing in it.
    let pack = loadPack(packDir, opts.topic);
    if (!pack) {
      pack = starterPack(opts.topic);
      savePack(packDir, pack);
    }

    // `feed` is the fallback, NOT a recommendation. Measured on a real account:
    // 16 posts, zero buying questions, and several business Pages that pass as
    // "people". Groups are where the leads are, so a source-less run says so in
    // its own output rather than returning an honest-looking empty harvest.
    const usedDefault = !opts.sources?.length;
    const sourceStrings = usedDefault ? ['feed'] : opts.sources!;
    // Parse BEFORE the project directory exists: a typo in a source is a usage
    // error, and it should not leave a failed project behind.
    const specs = sourceStrings.map(parseSource);

    // One sweep at a time. Two would share one Chrome and one Facebook identity,
    // doubling the traffic that account is judged on — the same reason gmap-recon
    // allows only one harvest.
    if (this.#fbReconActive) {
      throw new Error(
        `An fb-recon sweep is already running ("${this.#fbReconActive}"). ` +
          'Wait for it to finish, or read its progress with fbReconProject().',
      );
    }

    const limiter = new ReadLimiter(path.join(dir, 'read-history.json'), opts.limits ?? {});
    // Correct any project the daemon abandoned before starting a new one, so the
    // catalogue never shows a three-hour-old sweep as still running.
    reapStaleProjects(projectsRoot);
    await this.requireReady('facebook.com', profileId);

    // One run, one project. Created before the browser is touched so that even a
    // sweep that dies on its first navigation leaves a readable record.
    const project = new ProjectRun(projectsRoot, {
      topic: opts.topic,
      sources: sourceStrings,
      minScore: opts.minScore,
    });
    if (usedDefault) {
      project.setProblems([
        'No sources given, so this run swept the home feed only. On a real account the feed carries ' +
          'almost no buying questions — pass group:<url> for the groups you have joined.',
      ]);
    }

    // Kick the sweep off and return. A sweep runs for minutes; HTTP is
    // request→response and every fetch client gives up at 300s, so a blocking
    // call reports "the daemon is not running" on a run that is working
    // perfectly. Same reasoning, same shape as gmap-recon's startBackground().
    // The project file IS the progress channel — it is written live — so there
    // is no second source of truth to keep in sync.
    this.#fbReconActive = project.id;
    void this.#fbReconSweep(
      project,
      { pack: pack!, specs, limiter, minScore: opts.minScore, profileId },
      ledgerFile,
      projectsRoot,
    );

    return {
      projectId: project.id,
      projectDir: project.dir,
      reportHtml: project.htmlPath,
      project: project.snapshot,
    };
  }

  /**
   * The sweep itself. Nobody awaits this, so it must never throw: an unhandled
   * rejection here takes the daemon down and every other job with it.
   */
  async #fbReconSweep(
    project: ProjectRun,
    run: { pack: TopicPack; specs: SourceSpec[]; limiter: ReadLimiter; minScore?: number; profileId: string },
    ledgerFile: string,
    projectsRoot: string,
  ): Promise<void> {
    const contacts: ContactMap = new Map();
    try {
      const summary = await this.browserFor(run.profileId).run(async (_ctx, page) =>
        runReconSweep(page, {
          topic: project.snapshot.topic,
          pack: run.pack,
          sources: run.specs,
          limiter: run.limiter,
          contacts,
          minScore: run.minScore,
          reporter: project,
        }),
      );

      project.setBySource(summary.bySource);
      project.setProblems([...project.snapshot.problems, ...summary.problems]);
      project.progress({
        scanned: summary.scanned,
        gated: summary.gated,
        opened: summary.opened,
        skippedNoPermalink: summary.skippedNoPermalink,
        commentsRead: summary.commentsRead,
      });

      // The ledger is the ONE piece of state that spans projects. It flags a
      // person this account has met before; it never removes them from this
      // project's list, because that would make the list a lie about what this
      // sweep saw.
      const ledger = loadLedger(ledgerFile);
      const harvested = [...contacts.values()];
      const flagged: ProjectContact[] = harvested.map((c) => ({
        ...c,
        priorProjects: priorProjects(ledger, c.id, project.id),
      }));
      project.setContacts(flagged);
      recordProject(ledger, project.id, harvested);
      saveLedger(ledgerFile, ledger);

      fs.writeFileSync(path.join(project.dir, 'contacts.csv'), contactsToCsv(contacts));
      project.finish();
    } catch (err) {
      // Recorded in the project, never rethrown — see the note above.
      project.fail(err);
    } finally {
      this.#fbReconActive = null;
      this.#writeProjectIndex(projectsRoot);
    }
  }

  /** The catalogue page. Rewritten after every run so it is never stale. */
  #writeProjectIndex(projectsRoot: string): void {
    try {
      fs.mkdirSync(projectsRoot, { recursive: true });
      fs.writeFileSync(path.join(projectsRoot, 'index.html'), renderIndex(listProjects(projectsRoot)));
    } catch {
      // The index is a convenience over data that already exists on disk.
      // Failing to write it must not fail a completed harvest.
    }
  }

  /** Every fb-recon project on disk, newest first. */
  fbReconProjects(): ProjectFile[] {
    return listProjects(path.join(this.vault.home, 'fb-recon', 'projects'));
  }

  /**
   * One project by id — the poll target while a sweep is in flight, since the
   * project file is written live.
   */
  fbReconProject(id: string): ProjectFile {
    const found = this.fbReconProjects().find((p) => p.id === id);
    if (!found) throw new Error(`No fb-recon project "${id}".`);
    return found;
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
    this.#leads ??= new LeadStore(this.#gmapProjectDir ? path.join(this.#gmapProjectDir, 'leads.db') : path.join(this.vault.home, 'gmap-leads.db'));
    return this.#leads;
  }

  /**
   * Point the lead store at a project folder, so one campaign's companies never mix
   * with another's. The SEARCH BUDGET deliberately stays global: Google throttles
   * the browser profile, not the project, so a per-project budget would let ten
   * projects each spend a full allowance and burn the profile ten times faster.
   */
  gmapUseProject(dir: string): void {
    this.#leads?.close();
    this.#leads = null;
    this.#gmapProjectDir = dir;
  }

  /**
   * Release gmap-recon's Chrome. One user-data-dir allows exactly ONE Chrome, so a
   * browser left running after a harvest keeps the profile locked: the next launch
   * gets "Opening in existing browser session", attaches to nothing, and dies on a
   * 45s selector timeout that looks like a scraping bug. The daemon must therefore
   * hand the profile back after every run, not only at shutdown.
   */
  async gmapCloseBrowser(): Promise<void> {
    await this.#gmapBrowser?.close();
    this.#gmapBrowser = null;
  }

  /** Rows for a report or a custom export. */
  gmapRows(opts: { withPhoneOnly?: boolean; withEmailOnly?: boolean } = {}): BusinessRow[] {
    return this.#leadStore().rows(opts);
  }

  #gmapBudget(): gmap.SearchLimiter {
    this.#gmapLimiter ??= new gmap.SearchLimiter(path.join(this.vault.home, 'gmap-search-history.json'));
    return this.#gmapLimiter;
  }

  gmapPlan(keywords: string[], places: string[]): PlanResult {
    if (!keywords.length || !places.length) throw new Error('gmap_plan needs at least one keyword and one place');
    return this.#leadStore().plan(keywords, places);
  }

  gmapStatus(): StatusResult {
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
  async gmapHarvest(limit = 5): Promise<HarvestResult> {
    const store = this.#leadStore();
    const pending = store.pendingSearches(limit);
    if (!pending.length) return { ran: 0, found: 0, halted: null, note: 'nothing pending', ...store.status() };

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
  async gmapEnrich(limit = 25): Promise<EnrichResult> {
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

  gmapExport(file: string, opts: { withPhoneOnly?: boolean; withEmailOnly?: boolean } = {}): ExportResult {
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

  /**
   * A recon PROJECT is one scanned host: `<home>/tools/<host>/recon/scan.json`.
   * There is no separate project file — the scan IS the project, so the
   * directory listing is the index and nothing can go stale against it.
   */
  reconProjects(): { domain: string; scannedAt: string; routes: number; failed: number; verified: number; snapshotsOk: number }[] {
    const root = path.join(this.vault.home, 'tools');
    let hosts: string[] = [];
    try {
      hosts = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
    const out = [];
    for (const host of hosts) {
      const scan = this.#readScan(host);
      if (!scan) continue;
      out.push({
        domain: scan.domain || host,
        scannedAt: scan.finishedAt,
        routes: scan.pages.length,
        failed: scan.failed.length,
        verified: scan.pages.reduce((n, p) => n + p.xhr.filter(isVerifiedRead).length, 0),
        // A snapshot counts as OK only when it LOADED — bytes on disk are what
        // once reported 17 unstyled pages as a clean run (buildplan §8 Part 2).
        snapshotsOk: scan.pages.filter((p) => p.snapshot?.file && !p.snapshot.error && (p.snapshot.styleSheets ?? 0) > 0).length,
      });
    }
    return out.sort((a, b) => (a.scannedAt < b.scannedAt ? 1 : -1));
  }

  /** One project's full scan. Row samples are already masked by the scanner. */
  reconProject(domain: string): SiteScan {
    const scan = this.#readScan(domain);
    if (!scan) throw new Error(`No recon scan for "${domain}". Run: recon scan https://${domain}/`);
    return scan;
  }

  #readScan(host: string): SiteScan | null {
    try {
      const raw = fs.readFileSync(path.join(this.vault.home, 'tools', host, 'recon', 'scan.json'), 'utf8');
      const scan = JSON.parse(raw) as SiteScan;
      return Array.isArray(scan?.pages) ? scan : null;
    } catch {
      return null;
    }
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
    for (const b of this.#browsers.values()) await b.close().catch(() => {});
    // gmap-recon's Chrome and store only exist if a harvest ran.
    await this.#gmapBrowser?.close();
    this.#leads?.close();
  }
}
