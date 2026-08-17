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
import fs from 'node:fs';
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
  /**
   * Checked between every scroll round and every page open. A sweep can run for
   * minutes across hundreds of posts, so "wait for it to finish" is not an
   * acceptable answer to "stop" — the user must be able to end it and keep
   * whatever it has already harvested.
   */
  shouldStop?: () => boolean;
  /**
   * Where to write the raw message list. Absent means the sweep keeps only the
   * merged contacts, which is lossy: contacts collapse one person's five posts
   * into a single record, and the four you lose are usually the interesting ones.
   */
  messagesPath?: string;
  /**
   * Scroll rounds per source before giving up. Defaults to MAX_ROUNDS. The sweep
   * still exits early when the source genuinely runs dry, so raising this costs
   * nothing on a small group and buys depth on a big one.
   */
  maxRounds?: number;
}

/**
 * One message, its sender, and how to reach them. The primary output of Group
 * Recon — flat, one row per message, deliberately NOT deduplicated by person,
 * because reading five posts by the same person is how you decide whether to
 * message them.
 */
export interface GroupMessage {
  n: number;
  type: Intent;
  /** The classifier's reason, in its own words. Empty when unlabelled. */
  why: string;
  name: string;
  profileUrl: string | null;
  /** The whole point: click this to PM them. Null when the author link was not a person. */
  messenger: string | null;
  /** Signed CDN url, free to collect and quick to expire. See RawPost.avatarUrl. */
  avatarUrl: string | null;
  message: string;
  permalink: string;
  source: string;
  score: number;
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
 *
 * Sized from measurement, not taste. A round costs roughly 3-5s (the scroll
 * token bucket allows 20/minute), and yield per round is group-shaped: measured
 * 2026-08-13, an e-invoice group gave ~1.1 posts/round and a solar group with
 * 4000px photo posts gave ~0.65. So 150 rounds is about 10-13 minutes and 100-165
 * posts — which runs into `postsPerRun` (200) before it runs into this.
 *
 * Raise it per run with `maxRounds` rather than editing this: a deep sweep of one
 * group is a decision about that group, not a new default for every source.
 */
const MAX_ROUNDS = 150;

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
  /** Highest document height seen. Monotonic on purpose — see the reset below. */
  let pageHeight = 0;
  let round = 0;
  /**
   * Why the sweep loop ended. Recorded because "63 posts scanned" on its own
   * cannot tell you whether the SOURCE ran out or the CEILING did, and those two
   * call for opposite fixes — a better source vs. a bigger MAX_ROUNDS. Without
   * this the only way to tell them apart is to guess.
   */
  const maxRounds = opts.maxRounds && opts.maxRounds > 0 ? opts.maxRounds : MAX_ROUNDS;
  let why = `hit the ${maxRounds}-round ceiling (more was probably still there)`;
  for (; dry < DRY_ROUNDS && round < maxRounds; round++) {
    // Extract INSIDE the loop: the timeline is virtualized and scrolling past a
    // post destroys its DOM node.
    await expandSeeMore(page);
    let batch: RawPost[] = [];
    try {
      batch = (await page.evaluate(`(${POST_EXTRACT_SRC})()`)) as RawPost[];
    } catch (err) {
      problems.push(`${sourceLabel(spec)}: extractor failed — ${(err as Error).message}`);
      why = 'the post extractor failed';
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
        why = 'hit the per-run post cap';
        budgetExhausted = true;
        break;
      }

      const { score } = scoreText(opts.pack, post.text);
      if (score >= minScore) found.push({ post, spec, score });
    }

    if (opts.shouldStop?.()) {
      problems.push(`${sourceLabel(spec)}: stopped by the user`);
      why = 'was stopped by the user';
      break;
    }

    if (budgetExhausted) break;
    dry = fresh === 0 ? dry + 1 : 0;
    // `seen` starts empty per run, so its size IS the run's scanned total.
    opts.reporter?.progress({ scanned: seen.size, gated: found.length });

    let grown = { nodes: 0, height: 0 };
    try {
      grown = await scrollAndSettle(page, opts.limiter, MESSAGE_SEL);
    } catch (err) {
      problems.push(`${sourceLabel(spec)}: scroll failed — ${(err as Error).message}`);
      why = 'the scroll failed';
      break;
    }

    // Waiting on the data's shape, not on a clock. A group that renders slowly
    // hands back an empty round while it is still loading; treating that as
    // "exhausted" ended one measured run at 3 posts where the next returned 33.
    //
    // PAGE HEIGHT is the signal that survives virtualization. Measured
    // 2026-08-13 on a group whose posts run ~4000px tall against an 1800px
    // scroll: rounds routinely extracted nothing new, and the node count fell to
    // zero, while scrollHeight climbed every single round. Node count alone
    // ended that sweep at 2 posts and called it "the source ran out".
    if (grown.nodes > nodeCount || grown.height > pageHeight) dry = 0;
    nodeCount = grown.nodes;
    pageHeight = Math.max(pageHeight, grown.height);
  }

  if (dry >= DRY_ROUNDS) why = `${DRY_ROUNDS} rounds with nothing new — the source ran out`;

  opts.reporter?.event(
    'sweep',
    `${sourceLabel(spec)} — ${found.length} post(s) passed the gate ` +
      `after ${round} round(s); stopped because it ${why}`,
  );
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
    if (opts.shouldStop?.()) break;
    const before = seen.size;
    const hits = await sweepSource(page, spec, opts, seen, problems);
    scanned += seen.size - before;
    bySource[sourceLabel(spec)] = hits.length;
    candidates.push(...hits);
  }

  // ---- Everything collected gets a sender and a label. Nobody is dropped.
  //
  // The old design classified in order to DELETE — a "seller" verdict removed
  // the person before you ever saw them, so a wrong verdict was invisible and
  // unrecoverable. Group Recon labels instead: the message list below is written
  // whatever the classifier says, and even a classifier that is entirely dead
  // costs you the labels, never the people.
  opts.reporter?.progress({ scanned, gated: candidates.length });
  opts.reporter?.event('classify', `labelling ${candidates.length} message(s) from ${scanned} post(s)`);
  const items: ClassifyItem[] = candidates.map((c, i) => ({ id: String(i), text: c.post.text }));
  const verdicts = await classifier.classify(opts.topic, items);
  const verdictById = new Map(verdicts.map((v) => [v.id, v]));

  const labelled = candidates.map((c, i) => ({ c, v: verdictById.get(String(i)) }));

  // ---- The message list: every message, its sender, and how to reach them.
  const messages: GroupMessage[] = labelled.map(({ c, v }, i) => {
    const identity = profileIdentity(c.post.authorUrl);
    return {
      n: i + 1,
      type: v?.intent ?? 'none',
      why: v?.why ?? '',
      name: c.post.author ?? '',
      profileUrl: c.post.authorUrl,
      messenger: identity ? messengerLink(identity) : null,
      avatarUrl: c.post.avatarUrl,
      message: c.post.text,
      permalink: c.post.permalink ?? sourceUrl(c.spec, opts.topic),
      source: sourceLabel(c.spec),
      score: c.score,
    };
  });
  // Written now and again after the comment pass, so a run that dies opening
  // threads still leaves the posts it already collected.
  const flushMessages = (): void => {
    if (!opts.messagesPath) return;
    try {
      fs.writeFileSync(opts.messagesPath, JSON.stringify(messages, null, 1));
    } catch (err) {
      problems.push(`could not write the message list — ${(err as Error).message}`);
    }
  };
  flushMessages();
  opts.reporter?.event('classify', `message list: ${messages.length} message(s) with sender`);

  const byType = { seller: 0, owner: 0, buyer: 0, none: 0 };
  for (const m of messages) byType[m.type]++;

  // ---- Build contacts for the post authors themselves.
  let newContacts = 0;
  const at = new Date().toISOString();
  for (const { c, v } of labelled) {
    const contact = buildContact({
      name: c.post.author ?? '',
      profileUrl: c.post.authorUrl,
      text: c.post.text,
      permalink: c.post.permalink ?? sourceUrl(c.spec, opts.topic),
      sourceKind: c.spec.kind,
      role: 'author',
      intent: v?.intent ?? 'none',
      score: c.score,
      at,
    });
    if (contact && mergeContact(opts.contacts, contact)) newContacts++;
  }
  opts.reporter?.progress({ totalContacts: opts.contacts.size });
  opts.reporter?.event(
    'classify',
    `${labelled.length} sender(s) recorded — ` +
      `${byType.buyer} buyer, ${byType.owner} owner, ${byType.seller} seller, ${byType.none} unclear`,
  );

  // ---- Pass 2: open gate survivors plus any explicit threads, mine commenters.
  //
  // Group posts routinely expose NO permalink — measured 2026-08-12, zero of 14
  // did — so for a group-only run this pass legitimately has nothing to open.
  // That is reported, not hidden: a silent `opened: 0` is indistinguishable from
  // "nothing cleared the gate", and the two call for opposite fixes.
  const skippedNoPermalink = labelled.filter((x) => !x.c.post.permalink).length;
  if (skippedNoPermalink > 0) {
    problems.push(
      `${skippedNoPermalink} gated post(s) exposed no permalink, so their comment threads could not ` +
        'be opened. This is normal for group sources — see docs/fb-recon-feasibility-probe.md finding 4.',
    );
  }

  const threads = opts.sources.filter((s) => !isSweepable(s)).map((s) => s.ref);
  const openTargets = [
    ...threads.map((ref) => ({ url: ref, kind: 'thread' as SourceKind })),
    ...labelled
      .filter((x) => x.c.post.permalink)
      .sort((a, b) => b.c.score - a.c.score)
      .map((x) => ({ url: x.c.post.permalink!, kind: x.c.spec.kind })),
  ];

  let opened = 0;
  let commentsRead = 0;
  for (const target of openTargets) {
    if (opts.shouldStop?.()) {
      problems.push('Stopped by the user before every thread was opened.');
      break;
    }
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

    // Commenters are recorded on the same terms as posters: labelled, never
    // filtered. A commenter under someone else's post is often the best lead in
    // the thread, and the old rule deleted every one the model called a seller.
    for (let i = 0; i < gated.length; i++) {
      const v = cById.get(String(i));
      const contact = buildContact({
        name: gated[i].author ?? '',
        profileUrl: gated[i].authorUrl,
        text: gated[i].text,
        permalink: target.url,
        sourceKind: target.kind,
        role: 'commenter',
        intent: v?.intent ?? 'none',
        score: scoreText(opts.pack, gated[i].text).score,
        at,
      });
      if (contact && mergeContact(opts.contacts, contact)) newContacts++;
      if (contact) {
        const identity = profileIdentity(gated[i].authorUrl);
        messages.push({
          n: messages.length + 1,
          type: v?.intent ?? 'none',
          why: v?.why ?? '',
          name: gated[i].author ?? '',
          profileUrl: gated[i].authorUrl,
          messenger: identity ? messengerLink(identity) : null,
          avatarUrl: gated[i].avatarUrl,
          message: gated[i].text,
          permalink: target.url,
          source: `comment on ${target.url}`,
          score: scoreText(opts.pack, gated[i].text).score,
        });
      }
    }
  }

  flushMessages();
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
