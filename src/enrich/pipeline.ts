// src/enrich/pipeline.ts — Orchestrator for the Deep Research & Business Enrichment Pipeline.
//
// ---------------------------------------------------------------------------------
// Shape: a short serial spine, then a wide fan-out.
//
//   websearch ──> domain-registry ──┬──> [pageinsight]────────────────────┐
//                                   │                                     │
//                                   └──> website-crawl ──┬──> [facebook] ─┤
//                                                        ├──> [linkedin] ─┤
//                                                        └──> [chatgpt] ──┤
//                                                                         ▼
//                                              join ──> synthesis ──> notebooklm
//
// The spine is serial because each step decides whether the next is worth running:
// the search supplies the URLs, the registry says whether the domain exists at all,
// and the crawl is the only stage that can add an email or a social link to `biz` —
// which `buildResearchPrompt` reads synchronously. Everything in brackets is
// launched and awaited at the join.
//
// What makes the fan-out real rather than cosmetic is that the four stages hold four
// DIFFERENT resources: ChatGPT's Chrome profile, Facebook's Chrome profile, the agent
// Chrome, and plain HTTP. BrowserManager.run() serialises per profile, so two stages
// sharing one profile would queue no matter how they are written — and pageinsight
// falling back to the local benchmark does exactly that against LinkedIn, safely.
//
// The research ask is ~2 minutes and everything else is well under that, so the
// fan-out costs the price of its slowest member and nothing more. Ordering note that
// still holds: the ask must sit AFTER discovery (a bare company name sends the model
// researching a different company of the same name) and BEFORE synthesis, which
// wants its output. Only its neighbours changed, not its position.
// ---------------------------------------------------------------------------------
import type { VaultService } from '../service.js';
import type {
  AgyIntel,
  ArchiveIntel,
  ChatGptIntel,
  CompanyDossier,
  DomainIntel,
  FacebookIntel,
  LinkedInIntel,
  NewpagesIntel,
  NotebookLMIntel,
  PageInsightIntel,
  StageLog,
  WebSearchIntel,
} from './types.js';
import { runPageInsight } from './pageinsight.js';
import { describeDomain, isDeadDomain, lookupDomain } from './domain.js';
import { describeArchive, lookupArchive, recoverArchivedContacts } from './archive.js';
import { lookupNewpages } from './newpages.js';
import { scrapeFacebookPage } from './facebook.js';
import { FACEBOOK_PROFILE } from '../facebook.js';
import { scrapeLinkedInCompany } from './linkedin.js';
import { searchCompanyWeb, type DiscoveredCompanyWeb } from './websearch.js';
import { runChatGptResearch } from './chatgptresearch.js';
import { mergeFacts, runAgySecondPass } from './agyresearch.js';
import { runNotebookLmCompanyResearch } from '../notebooklm.js';
import { buildContactMatrix, synthesizeDossier } from './agy.js';
import { listProjects, projectDir } from '../gmapproject.js';
import { enrichSite } from '../gmaprecon.js';
import type { BusinessRow } from '../leads.js';

/**
 * Is this number already in the list, however it happens to be written?
 *
 * Malaysian numbers arrive in at least three shapes for the same line — "011-3932
 * 2861", "+60 11-3932 2861", "60113932861" — and a string compare treats all three as
 * distinct, so the same phone lands in the matrix repeatedly. Comparing the last nine
 * digits ignores the country prefix and the trunk zero, which is exactly the part that
 * varies, while staying long enough not to collide across real numbers.
 */
function hasPhone(list: string[], candidate: string): boolean {
  const tail = (s: string): string => s.replace(/\D/g, '').slice(-9);
  const want = tail(candidate);
  return want.length < 7 ? list.includes(candidate) : list.some((p) => tail(p) === want);
}

const emptyDiscovery = (): DiscoveredCompanyWeb => ({
  website: null,
  facebookUrl: null,
  linkedinUrl: null,
  instagramUrl: null,
  tiktokUrl: null,
  ssm: null,
  ctosUrl: null,
  maukerjaUrl: null,
  sources: [],
  rawText: '',
});

export async function runCompanyDeepResearch(
  svc: VaultService,
  placeId: string,
  options: {
    enableBrowserScrape?: boolean;
    enableNotebookLm?: boolean;
    enableChatGpt?: boolean;
    enableAgy?: boolean;
    enableNewpages?: boolean;
    enablePageInsight?: boolean;
    enableDomain?: boolean;
  } = {},
): Promise<CompanyDossier> {
  const scrape = options.enableBrowserScrape !== false;
  const useChatGpt = options.enableChatGpt !== false;
  const usePageInsight = options.enablePageInsight !== false;
  // OPT-IN, like NotebookLM below: it depends entirely on the ChatGPT brief as
  // its baseline (no brief, no second pass) and it shells out to a separate CLI
  // running with full tool auto-approval (see agycli.ts) — a deliberate call,
  // not a silent default.
  const useAgy = options.enableAgy === true;
  // Deliberately independent of enableBrowserScrape: the registry lookup is plain
  // HTTPS and a port-43 socket, so it still answers on a run with no browser at all.
  const useDomain = options.enableDomain !== false;
  // NotebookLM is OPT-IN, unlike the other two.
  //
  // It was the slowest stage (~150s, comparable to the research ask) and the only one
  // depending on a separate Google auth that expires on its own schedule — measured
  // 2026-08-17, it succeeded on one run and failed the next with "Authentication
  // expired" needing a human `notebooklm login`. Its value was also the most
  // duplicative: it was handed our own bundle and re-synthesized findings the research
  // brief already carried. Everything downstream of it is unaffected by its absence,
  // so it stays wired and tested but off unless asked for.
  const useNlm = options.enableNotebookLm === true;

  // Every stage records what it did, including the ones that found nothing. A bare
  // catch makes "never ran" and "ran and came back empty" produce the same dossier,
  // which is exactly what makes a thin result impossible to explain.
  const runStartedAt = Date.now();
  const stageLog: StageLog[] = [];
  const track = async <T>(
    stage: string,
    run: () => Promise<T> | T,
    describe: (value: T) => { status: StageLog['status']; detail: string },
  ): Promise<T | undefined> => {
    // The row is reserved NOW and filled in on completion. Stages run concurrently,
    // so pushing on completion would order the log by whichever finished first —
    // shuffling the table between runs of the same pipeline and making two dossiers
    // impossible to diff. A row that is never filled says so rather than vanishing.
    const row: StageLog = {
      stage,
      status: 'failed',
      detail: 'stage did not report a result',
      ms: 0,
      startedAt: Date.now() - runStartedAt,
    };
    stageLog.push(row);

    const at = Date.now();
    try {
      const value = await run();
      const { status, detail } = describe(value);
      row.status = status;
      row.detail = detail;
      row.ms = Date.now() - at;
      return value;
    } catch (err) {
      row.status = 'failed';
      row.detail = err instanceof Error ? err.message : String(err);
      row.ms = Date.now() - at;
      return undefined;
    }
  };
  const skip = (stage: string, why: string): void => {
    stageLog.push({ stage, status: 'skipped', detail: why, ms: 0, startedAt: Date.now() - runStartedAt });
  };

  let store = svc.leadStore();
  let biz: BusinessRow | undefined = store.rows().find((r) => r.placeId === placeId);

  // If not found in active store, search across all projects. Remember where we
  // started: a walk that misses would otherwise leave the daemon pointed at
  // whichever project sorted last, and the next unrelated request reads that one.
  if (!biz) {
    const startedAt = svc.gmapActiveProject();
    for (const p of listProjects()) {
      svc.gmapUseProject(projectDir(p.id));
      store = svc.leadStore();
      biz = store.rows().find((r) => r.placeId === placeId);
      if (biz) break;
    }
    if (!biz) {
      if (startedAt) svc.gmapUseProject(startedAt);
      throw new Error(`Business with placeId "${placeId}" not found in any project lead store.`);
    }
  }

  // 1. Stage 1: Google Web Search Discovery
  let discoveredWeb = emptyDiscovery();
  if (scrape) {
    const found = await track(
      'websearch',
      () => searchCompanyWeb(svc.agentBrowser(), biz!.name, biz!.address || ''),
      (d) => ({
        status: d.sources.length ? 'ok' : 'empty',
        detail: d.sources.length
          ? `${d.sources.length} results; website=${d.website ?? '—'} fb=${d.facebookUrl ? 'y' : 'n'} li=${d.linkedinUrl ? 'y' : 'n'} ssm=${d.ssm ?? '—'}`
          : 'Google returned no parseable results — likely a consent wall or a throttle.',
      }),
    );
    if (found) discoveredWeb = found;
  } else {
    skip('websearch', 'enableBrowserScrape=false');
  }

  // 1b. Stage 1b: Domain registry — who registered the website, and when.
  //
  // Ahead of the crawl, because its answer decides whether the crawl is worth
  // running at all: a name no registry has a record of cannot serve a page, and
  // spending the 10s budget on it yields an `empty` that reads exactly like "the
  // site loaded and had no email". Measured on this project's own rows, two of the
  // websites Google Maps publishes — amwprotech.my and fuzhingdesign.com — are
  // unregistered and resolve to nothing.
  //
  // On a .com.my it also returns the registrant organisation, which is the only
  // registry-sourced legal entity name this pipeline gets without an SSM search.
  const targetWebsite = biz.website || discoveredWeb.website;
  let domain: DomainIntel | undefined;
  if (useDomain && targetWebsite) {
    domain = await track('domain-registry', () => lookupDomain(targetWebsite), describeDomain);
  } else {
    skip('domain-registry', useDomain ? 'no website on the row and none discovered' : 'enableDomain=false');
  }

  // 2b. Stage 2b: Page-speed benchmark on that same website.
  //
  // Only runs when there IS a site — a company with no website is a different pitch,
  // and a benchmark of nothing is not a finding.
  //
  // LAUNCHED here, AWAITED in the join below. It needs the domain verdict and nothing
  // else: not the crawl's output, not the research. When PSI answers it is pure HTTP
  // and competes with no other stage; when it falls back to the local benchmark it
  // takes the agent browser, and BrowserManager.run serialises that against the
  // LinkedIn scrape rather than letting the two interleave.
  let pageInsight: PageInsightIntel | undefined;
  const pageInsightLane = (async (): Promise<void> => {
    if (usePageInsight && targetWebsite && !isDeadDomain(domain)) {
      pageInsight = await track(
        'pageinsight',
        () => runPageInsight(targetWebsite, { browser: scrape ? svc.agentBrowser() : undefined }),
        (p) => ({
          // A benchmark that came back without a performance number is empty, not ok:
          // the score IS the deliverable, and the metrics alone do not carry a pitch.
          status: p.scores.performance == null ? 'empty' : 'ok',
          detail:
            `${p.source === 'psi' ? `PSI via ${p.auth}` : 'local Chromium (no PSI credential — score is an estimate)'} ${p.strategy}: ` +
            `perf=${p.scores.performance ?? '—'} seo=${p.scores.seo ?? '—'} ` +
            `LCP=${p.metrics.lcpMs ? `${(p.metrics.lcpMs / 1000).toFixed(1)}s` : '—'} ` +
            `CLS=${p.metrics.clsScore ?? '—'} TBT=${p.metrics.tbtMs ?? '—'}ms, ` +
            `${p.opportunities.length} fixables${p.field ? `, CrUX field data: ${p.field.verdict}` : ', no CrUX field data'}`,
        }),
      );
    } else {
      skip(
        'pageinsight',
        !usePageInsight
          ? 'enablePageInsight=false'
          : isDeadDomain(domain)
            ? `${domain?.domain} is unregistered — there is no site to benchmark`
            : 'no website to benchmark',
      );
    }
  })();

  // 2. Stage 2: Discovered Website Crawl & Contact Extraction
  let crawledEmails: string[] = [];

  if (targetWebsite && isDeadDomain(domain)) {
    skip('website-crawl', `${domain?.domain} is unregistered — there is no site behind this URL to crawl`);
  } else if (targetWebsite) {
    const contacts = await track(
      'website-crawl',
      () => enrichSite(targetWebsite, 10_000),
      (c) => ({
        status: c.email || c.emails?.length ? 'ok' : 'empty',
        detail: `${targetWebsite} → ${(c.emails ?? []).length} emails, socials: ${[
          c.facebook && 'fb',
          c.instagram && 'ig',
          c.whatsapp && 'wa',
          c.linkedin && 'li',
        ]
          .filter(Boolean)
          .join(',') || 'none'}`,
      }),
    );

    if (contacts) {
      crawledEmails = contacts.emails || (contacts.email ? [contacts.email] : []);
      // Update business row in SQLite so main table reflects newly found website & email
      store.completeEnrich(biz.placeId, contacts);
      biz.website = targetWebsite;
      if (contacts.email) biz.email = contacts.email;
      if (contacts.facebook && !biz.facebook) biz.facebook = contacts.facebook;
      if (contacts.instagram && !biz.instagram) biz.instagram = contacts.instagram;
      if (contacts.whatsapp && !biz.whatsapp) biz.whatsapp = contacts.whatsapp;
      if (contacts.linkedin && !biz.linkedin) biz.linkedin = contacts.linkedin;
    }
  } else {
    skip('website-crawl', 'no website on the row and none discovered');
  }

  // 2c. Stage 2c: Wayback Machine capture history.
  //
  // Runs whenever there's a website to ask about, live or dead — it corroborates
  // site age independently of the registry (useful when RDAP redacts the
  // registrant, or the domain is unregistered and WHOIS has no createdAt at all).
  //
  // When the crawl above came back with nothing — dead domain, site down, or it
  // blocked us — the last snapshot on archive.org is the only other place a
  // contact on this domain could still come from, so it's read as a fallback here.
  let archive: ArchiveIntel | undefined;
  if (targetWebsite) {
    archive = await track('archive-history', () => lookupArchive(targetWebsite), describeArchive);

    if (archive?.hasSnapshots && !crawledEmails.length && !biz.email) {
      const recovered = await track(
        'archive-recovery',
        () => recoverArchivedContacts(archive!),
        (r) => ({
          status: r && (r.email || r.emails.length) ? 'ok' : 'empty',
          detail: r
            ? `pulled from the ${archive!.lastCaptureAt?.slice(0, 10) ?? 'last'} snapshot → ${r.emails.length} emails, socials: ${[
                r.facebook && 'fb',
                r.instagram && 'ig',
                r.whatsapp && 'wa',
                r.linkedin && 'li',
              ]
                .filter(Boolean)
                .join(',') || 'none'}`
            : 'snapshot fetched but carried no extractable contacts',
        }),
      );
      if (recovered) {
        crawledEmails = recovered.emails.length ? recovered.emails : recovered.email ? [recovered.email] : [];
        if (recovered.email && !biz.email) biz.email = recovered.email;
        if (recovered.facebook && !biz.facebook) biz.facebook = recovered.facebook;
        if (recovered.instagram && !biz.instagram) biz.instagram = recovered.instagram;
        if (recovered.whatsapp && !biz.whatsapp) biz.whatsapp = recovered.whatsapp;
        if (recovered.linkedin && !biz.linkedin) biz.linkedin = recovered.linkedin;
        // Kept on the dossier's own archive object, not just merged into `biz` —
        // the report needs to say WHERE a contact came from, and "recovered from a
        // dead site's last snapshot" is a materially different fact than "read off
        // the live page" even though both end up in the same contact matrix.
        if (recovered.email || recovered.emails.length) archive!.recoveredContacts = recovered;
      }
    }
  } else {
    skip('archive-history', 'no website on the row and none discovered');
  }

  // 3. Stage 3: Newpages Registry Lookup — OPT-IN.
  //
  // The local store is 6,890 records scraped for one vertical, so a general campaign
  // misses on nearly every row, and the two things it uniquely contributed are now
  // covered better upstream: SSM comes from the registry search pass and the research
  // brief, and its single "person-in-charge" is superseded by the research stage's
  // named-people list. It stays available for campaigns that overlap the store's
  // vertical, where a directory hit carries a real address and PIC.
  let newpages: NewpagesIntel | undefined;
  if (options.enableNewpages === true) {
    newpages = await track(
      'newpages',
      () => lookupNewpages(biz!.name),
      (n) => ({
        status: n.found ? 'ok' : 'empty',
        detail: n.found
          ? `matched "${n.matchedName}" ssm=${n.ssm ?? '—'} pic=${n.picName ?? '—'}`
          : 'no token-overlap match in the local Newpages store',
      }),
    );
  } else {
    skip('newpages', 'off by default — local store adds nothing the web search did not; pass enableNewpages=true');
  }
  newpages ??= { found: false };

  // If Newpages didn't have SSM, but Google Web Search found it (e.g. from CTOS/CreditScan)
  if (discoveredWeb.ssm) {
    newpages.found = true;
    newpages.ssm = discoveredWeb.ssm;
  }

  // 4. Stage 4: Facebook Page Intelligence.
  //
  // On the facebook profile, NOT the agent one. A logged-out visitor gets a login
  // wall over the page content and the scrape returns a thin subset without ever
  // reporting a failure — measured on this company, the logged-out read produced a
  // follower count and a phone and nothing else.
  // Its URL is read AFTER the crawl, because the crawl is the only stage that can
  // discover a Facebook link the web search missed.
  let fb: FacebookIntel | undefined;
  const fbTarget = biz.facebook || discoveredWeb.facebookUrl;
  const facebookLane = (async (): Promise<void> => {
    if (scrape && fbTarget) {
      fb = await track(
        'facebook',
        () => scrapeFacebookPage(svc.browserFor(FACEBOOK_PROFILE), fbTarget, { isUrl: true }),
        (f) => ({
          // A walled read is reported as empty even when fields came back: treating it
          // as ok is what let a 20%-complete scrape pass for a finished stage.
          status: f.found && f.loggedIn !== false ? 'ok' : 'empty',
          detail:
            f.loggedIn === false
              ? `LOGIN WALL on the "${FACEBOOK_PROFILE}" profile — a human must sign in; fields below are unread, not absent`
              : f.found
                ? `${f.pageName ?? 'page'} followers=${f.followers ?? '—'} phone=${f.phone ?? '—'} email=${f.email ?? '—'}`
                : `page did not resolve: ${fbTarget}`,
        }),
      );
    } else {
      skip('facebook', scrape ? 'no Facebook URL known or discovered' : 'enableBrowserScrape=false');
    }
  })();

  // 5. Stage 5: LinkedIn Company Intelligence. Runs on the agent browser, so it is
  // genuinely parallel with Facebook (its own Chrome) and with the research ask
  // (ChatGPT's own Chrome) — three profiles, three processes, no shared queue.
  let li: LinkedInIntel | undefined;
  const liTarget = biz.linkedin || discoveredWeb.linkedinUrl;
  const linkedinLane = (async (): Promise<void> => {
    if (scrape && liTarget) {
      li = await track(
        'linkedin',
        () => scrapeLinkedInCompany(svc.agentBrowser(), liTarget, { isUrl: true }),
        (l) => ({
          status: l.found ? 'ok' : 'empty',
          detail: l.found
            ? `${l.companyName ?? 'company'} size=${l.companySize ?? '—'} industry=${l.industry ?? '—'}`
            : `hit the auth wall or a dead page: ${liTarget}`,
        }),
      );
    } else {
      skip('linkedin', scrape ? 'no LinkedIn URL known or discovered' : 'enableBrowserScrape=false');
    }
  })();

  // 6. Stage 6: ChatGPT deep research — the only stage that READS the discovered
  // pages rather than just collecting their URLs, and at ~2 minutes the longest by
  // a wide margin. It is launched last and awaited first: it owns the ChatGPT Chrome
  // profile alone, so every other lane above hides completely inside its runtime.
  //
  // It stays BEHIND the crawl rather than beside it. `buildResearchPrompt` reads
  // biz.email and biz.facebook/instagram/linkedin synchronously, and the crawl is
  // what fills those in — starting the ask first would hand the model a thinner
  // brief to disambiguate from, which is the one thing this stage cannot recover.
  let chatgpt: ChatGptIntel | undefined;
  let agy: AgyIntel | undefined;
  const chatgptLane = (async (): Promise<void> => {
    if (useChatGpt) {
      chatgpt = await track(
        'chatgpt-research',
        () => runChatGptResearch(svc, biz!, discoveredWeb),
        (c) => ({
          status: c.ok ? (c.brief.length > 2_000 ? 'ok' : 'empty') : 'failed',
          detail: c.ok
            ? `${c.brief.length} chars${c.truncated ? ' (TRUNCATED)' : ''}, ` +
              `facts=${c.facts ? (c.repaired ? 'parsed via repair ask' : 'parsed') : 'UNPARSED'}, ` +
              `people=${c.facts?.people.length ?? 0}, signals=${c.facts?.buyingSignals.length ?? 0}, ` +
              `ssm=${c.facts?.ssm ?? '—'}, confidence=${c.facts?.confidence ?? '—'}`
            : (c.error ?? 'no answer'),
        }),
      );
    } else {
      skip('chatgpt-research', 'enableChatGpt=false');
    }

    // Second pass lives at the end of THIS lane, not its own — it depends on
    // `chatgpt` being settled, so sequencing it here means it still overlaps
    // with facebook/linkedin/pageinsight instead of adding to the critical path.
    if (!useAgy) {
      skip('agy-research', 'enableAgy=false');
    } else if (!chatgpt?.ok || !chatgpt.brief) {
      skip('agy-research', useChatGpt ? 'first-pass research produced no usable brief to build on' : 'enableChatGpt=false — no baseline for a second pass');
    } else {
      agy = await track(
        'agy-research',
        () => runAgySecondPass(svc, biz!, discoveredWeb, chatgpt!),
        (a) => ({
          status: a.ok ? (a.brief.length > 500 ? 'ok' : 'empty') : 'failed',
          detail: a.ok
            ? `${a.brief.length} chars${a.truncated ? ' (TRUNCATED)' : ''}, ` +
              `facts=${a.facts ? 'parsed' : 'UNPARSED'}, new people=${a.facts?.people.length ?? 0}, ` +
              `still unknown=${a.facts?.unknowns.length ?? 0}`
            : (a.error ?? 'no answer'),
        }),
      );
    }
  })();

  // ---- Join. Nothing below reads a stage result before this line. -------------
  //
  // Promise.all is safe to use as a barrier here specifically because `track`
  // swallows every stage failure into the log: no lane can reject, so this cannot
  // abandon three finished stages because a fourth threw.
  await Promise.all([pageInsightLane, facebookLane, linkedinLane, chatgptLane]);

  // Concurrency makes completion order arbitrary, so the log is put back into a
  // fixed reading order — the order the pipeline is DOCUMENTED in, not the order
  // this particular run happened to finish in. Two dossiers stay diffable, and the
  // startedAt on each row is where the overlap is actually visible.
  const STAGE_ORDER = [
    'websearch',
    'domain-registry',
    'website-crawl',
    'archive-history',
    'archive-recovery',
    'pageinsight',
    'newpages',
    'facebook',
    'linkedin',
    'chatgpt-research',
    'agy-research',
    'notebooklm',
  ];
  const stageRank = (s: string): number => {
    const i = STAGE_ORDER.indexOf(s);
    return i === -1 ? STAGE_ORDER.length : i;
  };
  stageLog.sort((a, b) => stageRank(a.stage) - stageRank(b.stage));

  // The second pass only ever ADDS to or fills gaps in the first — see mergeFacts
  // for exactly how — so everything downstream (legitimacy score, contact matrix,
  // synthesis, the report's fact display) reads this ONE combined view rather than
  // two disconnected fact sets.
  const facts = mergeFacts(chatgpt?.facts ?? null, agy?.facts ?? null);

  // SSM found by research beats an unconfirmed regex hit off a search-results page.
  if (facts?.ssm) {
    newpages.found = true;
    newpages.ssm = facts.ssm;
  }

  // 7. Stage 7: Web Search Intel Object. The news/litigation/highlight fields were
  // declared from the start and never assigned by anything — research fills them.
  const webSearchIntel: WebSearchIntel = {
    queriesRun: discoveredWeb.queriesRun ?? [`${biz.name} ${biz.address || ''}`.trim()],
    sources: discoveredWeb.sources,
    keyHighlights: facts?.buyingSignals.map((s) => `${s.signal}${s.date ? ` (${s.date})` : ''} — ${s.source}`) ?? [],
    litigationOrAlerts: facts?.risks ?? [],
    newsAndTenders: facts?.clients.map((c) => `${c.name}${c.year ? ` (${c.year})` : ''}: ${c.delivered ?? 'scope unstated'}`) ?? [],
  };

  // A dead website is an alert, not a footnote: it is published on the company's
  // Maps listing, so anyone acting on this dossier would try it and find nothing.
  if (isDeadDomain(domain)) {
    webSearchIntel.litigationOrAlerts = [
      `The website published on Google Maps (${targetWebsite}) is an unregistered domain — ${domain?.domain} has no registry record and does not resolve.`,
      ...(webSearchIntel.litigationOrAlerts ?? []),
    ];
  }

  // 8. Stage 8: AI Synthesis & Unified Contact Matrix
  //
  // Scoring and the executive summary read the MERGED facts, not chatgpt's raw
  // ones — synthesizeDossier and calculateLegitimacyScore take a ChatGptIntel
  // rather than a bare facts object, so the merge is threaded through via a
  // shallow copy instead of changing either function's signature.
  const { executiveSummary, legitimacyScore, verdict } = await synthesizeDossier(
    biz,
    newpages,
    fb,
    li,
    webSearchIntel,
    chatgpt ? { ...chatgpt, facts } : undefined,
    pageInsight,
    domain,
    archive,
  );
  const contactMatrix = buildContactMatrix(biz, newpages, fb, li);

  // Merge discovered socials/links into contact matrix
  if (targetWebsite && !contactMatrix.website) contactMatrix.website = targetWebsite;
  if (discoveredWeb.tiktokUrl) contactMatrix.socialLinks.push({ platform: 'TikTok', url: discoveredWeb.tiktokUrl });
  if (discoveredWeb.ctosUrl) contactMatrix.socialLinks.push({ platform: 'CTOS Credit Report', url: discoveredWeb.ctosUrl });
  if (discoveredWeb.maukerjaUrl) contactMatrix.socialLinks.push({ platform: 'Maukerja Profile', url: discoveredWeb.maukerjaUrl });
  crawledEmails.forEach((e) => {
    if (!contactMatrix.allEmails.includes(e)) contactMatrix.allEmails.push(e);
  });

  // Research routinely turns up a second phone line and the humans behind them —
  // the single most valuable thing in the dossier, and the field the pipeline used
  // to leave empty on every single company.
  if (facts) {
    facts.extraPhones.forEach((p) => {
      if (!hasPhone(contactMatrix.allPhones, p)) contactMatrix.allPhones.push(p);
    });
    facts.extraEmails.forEach((e) => {
      if (!contactMatrix.allEmails.some((x) => x.toLowerCase() === e.toLowerCase())) contactMatrix.allEmails.push(e);
    });
    contactMatrix.primaryPhone ??= facts.extraPhones[0] ?? null;
    facts.people.forEach((p) => {
      if (contactMatrix.keyContacts.some((k) => k.name.toLowerCase() === p.name.toLowerCase())) return;
      contactMatrix.keyContacts.push({
        name: p.name,
        role: p.role,
        contact: p.contact ?? undefined,
        source: `ChatGPT research — ${p.source}`,
      });
    });
  }
  if (!contactMatrix.primaryEmail && crawledEmails.length) {
    contactMatrix.primaryEmail = crawledEmails[0];
  }
  contactMatrix.primaryEmail ??= facts?.extraEmails[0] ?? null;

  // 9. Stage 9: NotebookLM Deep Intelligence Synthesis
  let notebooklm: NotebookLMIntel | undefined;
  if (useNlm) {
    const rawIntelPieces: string[] = [];

    // The research brief goes in FIRST and whole. NotebookLM answers strictly from
    // its sources, so feeding it only our own thin summary made it re-synthesize
    // what we already had and call the result deep. Give it real research and its
    // grounding has somewhere to stand.
    if (chatgpt?.ok && chatgpt.brief) {
      rawIntelPieces.push(`Web research brief (ChatGPT with live search):\n${chatgpt.brief}`);
    }
    if (discoveredWeb.sources.length) {
      rawIntelPieces.push(
        'Top Web Search Results:\n' +
          discoveredWeb.sources.map((s) => `- ${s.title}: ${s.snippet} (${s.url})`).join('\n'),
      );
    }
    if (fb?.bio || fb?.recentPostsSummary) {
      rawIntelPieces.push(
        `Facebook Page Intel:\nFollowers: ${fb.followers || 'N/A'}\nBio: ${fb.bio || 'N/A'}\nRecent Activity: ${fb.recentPostsSummary || 'N/A'}`,
      );
    }
    if (li?.summary || li?.specialties?.length) {
      rawIntelPieces.push(
        `LinkedIn Corporate Intel:\nCompany Size: ${li.companySize || 'N/A'}\nIndustry: ${li.industry || 'N/A'}\nSpecialties: ${(li.specialties || []).join(', ')}\nSummary: ${li.summary || 'N/A'}`,
      );
    }
    if (biz.reviews) {
      rawIntelPieces.push(`Google Maps Reputation: ${biz.rating}★ across ${biz.reviews} reviews.`);
    }

    // Hand over every page we know about, not just the homepage. NotebookLM fetches
    // URL sources itself, so the CTOS record and the job listings — the pages our
    // own crawler never opens — become grounded sources at no extra scraping cost.
    const urlSources = [
      targetWebsite,
      discoveredWeb.ctosUrl,
      discoveredWeb.maukerjaUrl,
      newpages.sourceUrl,
      ...(facts?.extraUrls ?? []),
    ].filter((u): u is string => !!u && u.startsWith('http'));

    notebooklm = await track(
      'notebooklm',
      () =>
        runNotebookLmCompanyResearch(biz!.name, {
          rawSummary: rawIntelPieces.join('\n\n') || discoveredWeb.rawText.slice(0, 4000),
          websiteUrl: targetWebsite,
          urlSources,
          ssm: newpages.ssm || discoveredWeb.ssm,
          facebookUrl: fbTarget,
          contactSummary: [
            `Primary Phone: ${contactMatrix.primaryPhone || 'N/A'}`,
            `All Phones: ${contactMatrix.allPhones.join(', ')}`,
            `Primary Email: ${contactMatrix.primaryEmail || 'N/A'}`,
            `Official Addresses: ${contactMatrix.officialAddresses.join('; ')}`,
            `Named people: ${contactMatrix.keyContacts.map((k) => `${k.name} (${k.role})`).join('; ') || 'none found'}`,
          ].join('\n'),
        }),
      (r) => ({
        status: r.deepAnalysis.length > 500 ? 'ok' : 'empty',
        detail: `notebook ${r.notebookId}, ${r.deepAnalysis.length} chars from ${urlSources.length} URL sources`,
      }),
    ).then((res) =>
      res
        ? {
            notebookId: res.notebookId,
            notebookUrl: res.notebookUrl,
            deepAnalysis: res.deepAnalysis,
            keyInsights: res.keyInsights,
            updatedAt: new Date().toISOString(),
          }
        : undefined,
    );
  } else {
    skip('notebooklm', 'off by default — pass enableNotebookLm=true to include it');
  }

  const dossier: CompanyDossier = {
    placeId: biz.placeId,
    companyName: biz.name,
    updatedAt: new Date().toISOString(),
    status: 'completed',
    executiveSummary,
    legitimacyScore,
    verdict,
    domain,
    archive,
    newpages,
    facebook: fb,
    linkedin: li,
    webSearch: webSearchIntel,
    notebooklm,
    chatgpt,
    agy,
    combinedFacts: facts,
    pageInsight,
    contactMatrix,
    stageLog,
  };

  // 10. Persist Dossier
  store.saveDossier(dossier);

  return dossier;
}
