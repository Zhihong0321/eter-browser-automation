// src/enrich/types.ts — Types for the Deep Research & Business Enrichment Pipeline.

export interface NewpagesIntel {
  found: boolean;
  matchedName?: string;
  ssm?: string;
  address?: string;
  email?: string;
  mobile?: string;
  tel?: string;
  fax?: string;
  website?: string;
  location?: string;
  businessNature?: string;
  classifieds?: string;
  tags?: string;
  picName?: string;
  sourceUrl?: string;
}

export interface FacebookIntel {
  found: boolean;
  pageUrl?: string;
  pageName?: string;
  followers?: string;
  /** Pages that follow far more than they are followed are usually early or inactive. */
  following?: string;
  likes?: string;
  rating?: string;
  reviewsCount?: number;
  messengerUrl?: string;
  verified?: boolean;
  bio?: string;
  phone?: string;
  email?: string;
  address?: string;
  website?: string;
  lastActive?: string;
  recentPostsSummary?: string;
  /**
   * Whether the scrape ran signed in. False means a login wall was over the content,
   * so every absent field below is unread rather than absent — the distinction that
   * separates "this page has no email" from "we could not see the page".
   */
  loggedIn?: boolean;
}

export interface LinkedInIntel {
  found: boolean;
  companyUrl?: string;
  companyName?: string;
  industry?: string;
  companySize?: string;
  headquarters?: string;
  specialties?: string[];
  keyPeople?: { name: string; title: string; profileUrl?: string }[];
  summary?: string;
}

/**
 * What the domain registry says about the company's website.
 *
 * `registrantOrganization` is the field worth the stage: on a .com.my MYNIC leaves
 * it unredacted and it carries the registered business name, which both names the
 * legal entity and separates an incorporated "SDN. BHD." from a sole
 * proprietorship. It is absent on gTLDs (ICANN redacts registrant data) and empty
 * on a plain .my (open to individuals), and those are findings rather than gaps.
 *
 * It is self-declared at registration and never verified against SSM — a strong
 * corroborating hint, not proof, and it must not be presented as a registry number.
 */
export interface DomainIntel {
  /** The registrable name actually queried, e.g. `healthlane.com.my`. */
  domain: string;
  /** Which path answered — or why neither did. */
  source: 'rdap' | 'mynic-whois' | 'platform' | 'unsupported';
  /**
   * False means the registry says nobody owns this name — a Maps listing pointing
   * at an unregistered domain is a staleness signal about the business, and it is
   * the difference between "the crawl found no email" and "there was never a site
   * to crawl". UNDEFINED means no registry was asked (platform page, or a TLD with
   * no RDAP service); conflating that with false is exactly the bug this pipeline's
   * stage log exists to prevent, so read it with `isDeadDomain`, never `!registered`.
   */
  registered?: boolean;
  createdAt?: string;
  expiresAt?: string;
  changedAt?: string;
  /** Years since registration — a floor on how long the business has been online. */
  ageYears?: number;
  /** Registration lapsed without renewal; the name is in its grace window. */
  expired?: boolean;
  registrar?: string;
  registrantOrganization?: string;
  registrantState?: string;
  registrantCountry?: string;
  nameservers?: string[];
  statuses?: string[];
  /** Why this result looks the way it does — redaction, platform page, or no RDAP service. */
  note?: string;
  /** Served from the on-disk cache rather than the registry. */
  cached?: boolean;
}

/**
 * Wayback Machine capture history for the company's website — a source independent
 * of the domain registry, and the only one that still has something to say about a
 * domain that is currently unregistered.
 *
 * `checked: false` means nothing was asked (no website, or a platform page); that
 * is a different fact from `hasSnapshots: false`, which means the Wayback Machine
 * was asked and has never captured this domain at all.
 */
export interface ArchiveIntel {
  domain: string;
  checked: boolean;
  hasSnapshots: boolean;
  /** Earliest indexed capture. A lower bound, not a proven first-ever capture — see src/enrich/archive.ts. */
  firstCaptureAt?: string;
  /** Most recent capture, from the Availability API's "closest to now" answer. */
  lastCaptureAt?: string;
  lastCaptureStatus?: string;
  /** The web.archive.org URL of the last capture — the source `recoverArchivedContacts` reads. */
  lastCaptureUrl?: string;
  note?: string;
  /** Served from the on-disk cache rather than a fresh Wayback query. */
  cached?: boolean;
  /**
   * Set only when the live site could not be read at all and contacts were pulled
   * from the last snapshot instead — shape mirrors `EnrichInput` (src/leads.ts),
   * duplicated here rather than imported to avoid a cross-module type cycle
   * (leads.ts already imports `CompanyDossier` from this file).
   */
  recoveredContacts?: {
    email: string | null;
    emails: string[];
    facebook: string | null;
    instagram: string | null;
    whatsapp: string | null;
    linkedin: string | null;
  };
}

export interface WebSearchSource {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchIntel {
  queriesRun: string[];
  sources: WebSearchSource[];
  newsAndTenders?: string[];
  litigationOrAlerts?: string[];
  keyHighlights?: string[];
}

export interface KeyContact {
  name: string;
  role: string;
  contact?: string;
  source: string;
}

export interface ContactMatrix {
  primaryPhone: string | null;
  allPhones: string[];
  primaryEmail: string | null;
  allEmails: string[];
  whatsapp: string | null;
  website: string | null;
  officialAddresses: string[];
  socialLinks: { platform: string; url: string }[];
  keyContacts: KeyContact[];
}

/**
 * One fixable thing, biggest first. PSI names these itself; the local benchmark
 * derives them from whichever metric scored worst, so both sources fill this.
 */
export interface PageInsightOpportunity {
  title: string;
  detail: string;
  /** Estimated load time saved, in ms. Null when the source states no estimate. */
  savingsMs: number | null;
}

/** A pass/fail on-page check. Cheap, deterministic, and the easiest thing to pitch on. */
export interface PageInsightCheck {
  label: string;
  pass: boolean;
  detail: string;
}

/**
 * How fast and how well-built the company's own website is.
 *
 * Two sources produce this, and which one ran is load-bearing for how the number
 * should be quoted:
 *
 *   'psi'     — Google PageSpeed Insights. The authoritative 0-100 everyone
 *               recognises, plus CrUX field data when the site has enough real
 *               traffic. Needs credentials of its own; the unkeyed shared quota is
 *               exhausted most days (measured 2026-08-17: HTTP 429 in 560ms).
 *   'browser' — Our own Chromium under the Lighthouse mobile throttle. Same
 *               metrics, same scoring curve, but only four of the five inputs
 *               (no Speed Index), so `scores.performance` is an ESTIMATE and must
 *               be labelled as one when shown to a prospect.
 */
export interface PageInsightIntel {
  url: string;
  source: 'psi' | 'browser';
  /**
   * Which credential PSI accepted. Carried because a quota failure and a
   * misconfigured project produce the same 429, and only this tells them apart.
   */
  auth?: 'api-key' | 'service-account' | 'anonymous';
  strategy: 'mobile' | 'desktop';
  fetchedAt: string;
  ok: boolean;
  error?: string;
  /** Wall time for the benchmark, so a slow stage is visible without reading logs. */
  ms: number;
  /** 0-100. Null where the source cannot produce that category — never zero-filled. */
  scores: {
    performance: number | null;
    accessibility: number | null;
    bestPractices: number | null;
    seo: number | null;
  };
  /** True when `scores.performance` came from the four-metric local approximation. */
  performanceEstimated?: boolean;
  /** Lab metrics. Null means unmeasured, not zero. */
  metrics: {
    lcpMs: number | null;
    clsScore: number | null;
    tbtMs: number | null;
    fcpMs: number | null;
    ttfbMs: number | null;
    speedIndexMs: number | null;
    transferBytes: number | null;
    requests: number | null;
  };
  /**
   * Real-user data from the Chrome UX Report — what actual visitors experienced,
   * not a lab run. Only PSI carries it, and only for sites with enough traffic;
   * null is itself a finding (the site is too quiet to be in CrUX).
   */
  field: {
    lcpMs: number | null;
    clsScore: number | null;
    inpMs: number | null;
    verdict: string | null;
  } | null;
  opportunities: PageInsightOpportunity[];
  /** On-page SEO/mobile checks. Filled by the local benchmark; empty from PSI. */
  checks: PageInsightCheck[];
}

export interface NotebookLMIntel {
  notebookId: string;
  notebookUrl: string;
  deepAnalysis: string;
  keyInsights: string[];
  updatedAt: string;
}

/** A person or company found by name. `contact` is null when only the name surfaced. */
export interface ChatGptPerson {
  name: string;
  role: string;
  source: string;
  contact: string | null;
}

export interface ChatGptClient {
  name: string;
  year: string | null;
  delivered: string | null;
}

/** Evidence the company is spending money right now. Undated signals age badly, so the date is carried. */
export interface ChatGptBuyingSignal {
  signal: string;
  date: string | null;
  source: string;
}

/**
 * The JSON tail of the research brief. Every field is nullable because the prompt
 * demands UNKNOWN over a guess — an absent value here is a real finding, not a
 * parse failure, and must never be back-filled with a plausible default.
 */
export interface ChatGptFacts {
  ssm: string | null;
  incorporatedOn: string | null;
  msic: string | null;
  paidUpCapital: string | null;
  companyAgeYears: number | null;
  headcount: string | null;
  headcountSource: string | null;
  primaryRevenueLine: string | null;
  customerSegment: string | null;
  people: ChatGptPerson[];
  clients: ChatGptClient[];
  buyingSignals: ChatGptBuyingSignal[];
  risks: string[];
  extraPhones: string[];
  extraEmails: string[];
  extraUrls: string[];
  unknowns: string[];
  confidence: 'high' | 'medium' | 'low' | null;
}

export interface ChatGptIntel {
  ok: boolean;
  /** Wall time for the ask, so a slow research stage is visible without reading logs. */
  ms: number;
  error?: string;
  /** The full sectioned prose brief — the richest single artefact the pipeline produces. */
  brief: string;
  /** Parsed from the brief's closing schema block. Null when the model emitted none. */
  facts: ChatGptFacts | null;
  /** The brief stopped mid-structure — the prose is usable, the tail is not. */
  truncated?: boolean;
  /** The facts came from a follow-up extraction ask rather than the brief's own tail. */
  repaired?: boolean;
}

/**
 * The second research pass, run through the unrelated `agy` CLI (see
 * src/agycli.ts) with the ChatGPT brief as its baseline. Same FACTS record
 * format as ChatGptFacts by design — the two get merged in the pipeline rather
 * than displayed as two disconnected fact sets.
 */
export interface AgyIntel {
  ok: boolean;
  /** Wall time for the call. */
  ms: number;
  error?: string;
  /** The full sectioned prose brief for this pass. */
  brief: string;
  /** Parsed from the brief's closing schema block. Null when agy emitted none. */
  facts: ChatGptFacts | null;
  /** The brief stopped mid-structure — the prose is usable, the tail is not. */
  truncated?: boolean;
}

/**
 * One line per stage, always written — including for stages that found nothing.
 *
 * Every stage in this pipeline is best-effort behind a bare catch, which means a
 * stage that was never reachable and a stage that ran and came back empty produce
 * an identical dossier. That is precisely the failure that makes a shallow result
 * impossible to diagnose: you cannot tell whether Newpages has no record or
 * whether the store file was missing. Recording the outcome costs nothing and is
 * the only way to answer "why is this thin".
 */
export interface StageLog {
  stage: string;
  status: 'ok' | 'empty' | 'skipped' | 'failed';
  /** What was obtained, or why nothing was. */
  detail: string;
  ms: number;
  /**
   * Milliseconds from the start of the run to when this stage began.
   *
   * Stages overlap, so `ms` alone no longer adds up to the wall time and two rows
   * both taking 30s may have taken 30s together rather than 60s. This is what makes
   * the concurrency visible — and what makes a regression to serial execution show
   * up in the report instead of only in the total.
   */
  startedAt?: number;
}

export interface CompanyDossier {
  placeId: string;
  companyName: string;
  updatedAt: string;
  status: 'in_progress' | 'completed' | 'failed';
  error?: string | null;

  // Synthesized Executive Brief
  executiveSummary: string;
  legitimacyScore: number; // 0 - 100
  verdict: string; // e.g. "Verified Malaysian SME", "Active Commercial Business", "Corporate Enterprise"

  // Sourced Intelligence
  domain?: DomainIntel;
  archive?: ArchiveIntel;
  newpages?: NewpagesIntel;
  facebook?: FacebookIntel;
  linkedin?: LinkedInIntel;
  webSearch?: WebSearchIntel;
  notebooklm?: NotebookLMIntel;
  /** Pristine first-pass output — never mutated, so it stays a true copy of what shipped to research/01-chatgpt-baseline.txt. */
  chatgpt?: ChatGptIntel;
  /** Second research pass — fills gaps in `chatgpt`'s facts, chases news it didn't cover. Also never mutated. */
  agy?: AgyIntel;
  /**
   * `chatgpt.facts` merged additively with `agy.facts` (see mergeFacts in
   * enrich/agyresearch.ts) — this is what scoring, the contact matrix, and the
   * report's fact cards read. Kept separate from `chatgpt.facts` on purpose:
   * the two passes' own fields stay exactly what each pass produced, so this
   * combined view can always be diffed against either original rather than
   * trusted blind.
   */
  combinedFacts?: ChatGptFacts | null;
  pageInsight?: PageInsightIntel;

  // Unified Contact Matrix
  contactMatrix: ContactMatrix;

  /** What each stage actually did. Present on every dossier written by the pipeline. */
  stageLog?: StageLog[];
}
