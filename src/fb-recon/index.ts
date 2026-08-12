/**
 * The two-pass sweep.
 *
 * Pass 1 reads each source's list inline and scores every post. No navigation,
 * so it is cheap and safe. Pass 2 opens only what cleared the gate and mines
 * the comment thread, where the highest-intent people actually are — someone
 * asking "how much for 6kW?" under a competitor's post is worth more than
 * whoever wrote the post.
 *
 * The non-obvious constraint is virtualization: Facebook destroys the DOM nodes
 * of posts you have scrolled past. Extraction therefore happens INSIDE the
 * scroll loop, once per round. Scroll-then-extract returns a confident, wrong,
 * much smaller number.
 */
import type { Page } from 'patchright';
import {
  clearTallViewport,
  expandComments,
  expandSeeMore,
  guardPage,
  scrollAndSettle,
  useTallViewport,
} from './browser.js';
import { defaultClassifier, type Classifier, type ClassifyItem } from './classify.js';
import { extractContactFields, messengerLink, profileIdentity } from './contact.js';
import { COMMENT_EXTRACT_SRC, POST_EXTRACT_SRC, type RawComment, type RawPost } from './extract.js';
import { isSweepable, sourceLabel, sourceUrl, type SourceSpec } from './sources.js';
import { DEFAULT_MIN_SCORE, scoreText, type TopicPack } from './topic.js';
import { mergeContact, type ContactMap, type FbContact, type Intent, type Role, type SourceKind } from './store.js';
import type { ReadLimiter } from '../readlimit.js';
import type { RunReporter } from './project.js';
import { MESSAGE_SEL } from '../facebook.js';

export interface ReconOptions {
  topic: string;
  pack: TopicPack;
  sources: SourceSpec[];
  limiter: ReadLimiter;
  contacts: ContactMap;
  classifier?: Classifier;
  minScore?: number;
  /**
   * Post keys already scored IN THIS RUN. Deliberately not persisted across
   * runs: a run is a project and a project is a complete sweep, so carrying a
   * seen-set forward would make the second project on a topic look empty.
   * Not-messaging-someone-twice is the ledger's job, not this set's.
   */
  seen?: Set<string>;
  /** Live progress sink. Absent means the sweep runs silently. */
  reporter?: RunReporter;
}

export interface ReconSummary {
  topic: string;
  scanned: number;
  gated: number;
  opened: number;
  /**
   * Gated posts that could not be opened because they exposed no permalink.
   * Measured 2026-08-12: this was 100% of group posts. Reported rather than
   * swallowed, because "opened: 0" otherwise reads as "nothing was worth
   * opening" when the truth is "nothing COULD be opened".
   */
  skippedNoPermalink: number;
  commentsRead: number;
  newContacts: number;
  totalContacts: number;
  bySource: Record<string, number>;
  problems: string[];
  startedAt: string;
  finishedAt: string;
}

interface Candidate {
  post: RawPost;
  spec: SourceSpec;
  score: number;
}

/** Bounded so a 4,000-character post does not become a 4,000-character CSV cell. */
const QUOTE_MAX = 300;
/** Two consecutive rounds with no new posts means the list is exhausted. */
const DRY_ROUNDS = 2;
/**
 * Hard ceiling on scroll rounds. The dry-round rule is the normal exit; this
 * only stops a group that keeps rendering forever from holding the browser.
 */
const MAX_ROUNDS = 40;

export interface ContactInput {
  name: string;
  profileUrl: string | null;
  text: string;
  permalink: string;
  sourceKind: SourceKind;
  role: Role;
  intent: Intent;
  score: number;
  at: string;
}

/** Null when the "author" is not a person — a group, a page, a photo permalink. */
export function buildContact(input: ContactInput): FbContact | null {
  const identity = profileIdentity(input.profileUrl);
  if (!identity) return null;

  const fields = extractContactFields(input.text);

  return {
    id: identity.id,
    name: input.name || identity.id,
    profileUrl: input.profileUrl!,
    messenger: messengerLink(identity),
    phones: fields.phones,
    waLinks: fields.waLinks,
    emails: fields.emails,
    evidence: [{
      permalink: input.permalink,
      quote: input.text.slice(0, QUOTE_MAX),
      sourceKind: input.sourceKind,
      role: input.role,
      at: input.at,
    }],
    intent: input.intent,
    score: input.score,
    firstSeen: input.at,
    lastSeen: input.at,
  };
}

async function sweepSource(
  page: Page,
  spec: SourceSpec,
  opts: ReconOptions,
  seen: Set<string>,
  problems: string[],
): Promise<Candidate[]> {
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const url = sourceUrl(spec, opts.topic);
  const found: Candidate[] = [];

  opts.reporter?.event('sweep', `${sourceLabel(spec)} — opening`);

  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 45_000 });
    await page.waitForSelector(MESSAGE_SEL, { timeout: 30_000 });
  } catch (err) {
    problems.push(`${sourceLabel(spec)}: could not load — ${(err as Error).message}`);
    opts.reporter?.event('sweep', `${sourceLabel(spec)} — could not load`);
    return found;
  }

  let dry = 0;
  let nodeCount = -1;
  for (let round = 0; dry < DRY_ROUNDS && round < MAX_ROUNDS; round++) {
    // Extract INSIDE the loop: the timeline is virtualized and scrolling past a
    // post destroys its DOM node.
    await expandSeeMore(page);
    let batch: RawPost[] = [];
    try {
      batch = (await page.evaluate(`(${POST_EXTRACT_SRC})()`)) as RawPost[];
    } catch (err) {
      problems.push(`${sourceLabel(spec)}: extractor failed — ${(err as Error).message}`);
      break;
    }

    let fresh = 0;
    let budgetExhausted = false;
    for (const post of batch) {
      const key = post.permalink ?? `${post.author}::${post.text.slice(0, 120)}`;
      if (!key.trim() || seen.has(key)) continue;
      seen.add(key);
      fresh++;

      if (!opts.limiter.takePost()) {
        problems.push(`${sourceLabel(spec)}: stopped at the per-run post cap`);
        budgetExhausted = true;
        break;
      }

      const { score } = scoreText(opts.pack, post.text);
      if (score >= minScore) found.push({ post, spec, score });
    }

    if (budgetExhausted) break;
    dry = fresh === 0 ? dry + 1 : 0;
    // `seen` starts empty per run, so its size IS the run's scanned total.
    opts.reporter?.progress({ scanned: seen.size, gated: found.length });

    let grown = 0;
    try {
      grown = await scrollAndSettle(page, opts.limiter, MESSAGE_SEL);
    } catch (err) {
      problems.push(`${sourceLabel(spec)}: scroll failed — ${(err as Error).message}`);
      break;
    }

    // Waiting on the data's shape, not on a clock. A group that renders slowly
    // hands back an empty round while it is still loading; treating that as
    // "exhausted" ended one measured run at 3 posts where the next returned 33.
    // A round that grew the DOM is a round that was still working.
    if (grown > nodeCount) dry = 0;
    nodeCount = grown;
  }

  opts.reporter?.event('sweep', `${sourceLabel(spec)} — ${found.length} post(s) passed the gate`);
  return found;
}

export async function runReconSweep(page: Page, opts: ReconOptions): Promise<ReconSummary> {
  const startedAt = new Date().toISOString();
  const classifier = opts.classifier ?? defaultClassifier();
  const seen = opts.seen ?? new Set<string>();
  const problems: string[] = [];
  const bySource: Record<string, number> = {};

  guardPage(page);

  // A taller viewport keeps more of the virtualized timeline alive per
  // extraction. See TALL_VIEWPORT in browser.ts for why this shape.
  const viewportProblem = await useTallViewport(page);
  if (viewportProblem) problems.push(viewportProblem);
  opts.reporter?.event('sweep', viewportProblem ?? 'viewport 1440x2480 (portrait 4K @150%)');

  // ---- Pass 1: sweep every sweepable source, gate inline.
  let scanned = 0;
  const candidates: Candidate[] = [];
  for (const spec of opts.sources.filter(isSweepable)) {
    const before = seen.size;
    const hits = await sweepSource(page, spec, opts, seen, problems);
    scanned += seen.size - before;
    bySource[sourceLabel(spec)] = hits.length;
    candidates.push(...hits);
  }

  // ---- Classify the survivors in one batched pass.
  opts.reporter?.progress({ scanned, gated: candidates.length });
  opts.reporter?.event('classify', `${candidates.length} candidate(s) from ${scanned} post(s)`);
  const items: ClassifyItem[] = candidates.map((c, i) => ({ id: String(i), text: c.post.text }));
  const verdicts = await classifier.classify(opts.topic, items);
  const verdictById = new Map(verdicts.map((v) => [v.id, v]));

  const interested = candidates
    .map((c, i) => ({ c, v: verdictById.get(String(i)) }))
    .filter((x) => x.v?.interested && x.v.intent !== 'seller');

  // ---- Build contacts for the post authors themselves.
  let newContacts = 0;
  const at = new Date().toISOString();
  for (const { c, v } of interested) {
    const contact = buildContact({
      name: c.post.author ?? '',
      profileUrl: c.post.authorUrl,
      text: c.post.text,
      permalink: c.post.permalink ?? sourceUrl(c.spec, opts.topic),
      sourceKind: c.spec.kind,
      role: 'author',
      intent: v!.intent,
      score: c.score,
      at,
    });
    if (contact && mergeContact(opts.contacts, contact)) newContacts++;
  }
  opts.reporter?.progress({ totalContacts: opts.contacts.size });
  opts.reporter?.event('classify', `${interested.length} post author(s) kept as leads`);

  // ---- Pass 2: open gate survivors plus any explicit threads, mine commenters.
  //
  // Group posts routinely expose NO permalink — measured 2026-08-12, zero of 14
  // did — so for a group-only run this pass legitimately has nothing to open.
  // That is reported, not hidden: a silent `opened: 0` is indistinguishable from
  // "nothing cleared the gate", and the two call for opposite fixes.
  const skippedNoPermalink = interested.filter((x) => !x.c.post.permalink).length;
  if (skippedNoPermalink > 0) {
    problems.push(
      `${skippedNoPermalink} gated post(s) exposed no permalink, so their comment threads could not ` +
        'be opened. This is normal for group sources — see docs/fb-recon-feasibility-probe.md finding 4.',
    );
  }

  const threads = opts.sources.filter((s) => !isSweepable(s)).map((s) => s.ref);
  const openTargets = [
    ...threads.map((ref) => ({ url: ref, kind: 'thread' as SourceKind })),
    ...interested
      .filter((x) => x.c.post.permalink)
      .sort((a, b) => b.c.score - a.c.score)
      .map((x) => ({ url: x.c.post.permalink!, kind: x.c.spec.kind })),
  ];

  let opened = 0;
  let commentsRead = 0;
  for (const target of openTargets) {
    try {
      await opts.limiter.takePageOpen();
    } catch (err) {
      problems.push((err as Error).message);
      break;
    }

    let comments: RawComment[] = [];
    try {
      await page.goto(target.url, { waitUntil: 'commit', timeout: 45_000 });
      await expandComments(page);
      comments = (await page.evaluate(`(${COMMENT_EXTRACT_SRC})()`)) as RawComment[];
    } catch (err) {
      problems.push(`${target.url}: comment pass failed — ${(err as Error).message}`);
      continue;
    }
    opened++;
    commentsRead += comments.length;
    opts.reporter?.progress({ opened, commentsRead, skippedNoPermalink });
    opts.reporter?.event('open', `${comments.length} comment(s) — ${target.url}`);

    const gated = comments.filter((cm) => scoreText(opts.pack, cm.text).score >= (opts.minScore ?? DEFAULT_MIN_SCORE));
    const cItems: ClassifyItem[] = gated.map((cm, i) => ({ id: String(i), text: cm.text }));
    const cVerdicts = await classifier.classify(opts.topic, cItems);
    const cById = new Map(cVerdicts.map((v) => [v.id, v]));

    for (let i = 0; i < gated.length; i++) {
      const v = cById.get(String(i));
      if (!v?.interested || v.intent === 'seller') continue;
      const contact = buildContact({
        name: gated[i].author ?? '',
        profileUrl: gated[i].authorUrl,
        text: gated[i].text,
        permalink: target.url,
        sourceKind: target.kind,
        role: 'commenter',
        intent: v.intent,
        score: scoreText(opts.pack, gated[i].text).score,
        at,
      });
      if (contact && mergeContact(opts.contacts, contact)) newContacts++;
    }
  }

  await clearTallViewport(page);

  return {
    topic: opts.topic,
    scanned,
    gated: candidates.length,
    opened,
    skippedNoPermalink,
    commentsRead,
    newContacts,
    totalContacts: opts.contacts.size,
    bySource,
    problems,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
