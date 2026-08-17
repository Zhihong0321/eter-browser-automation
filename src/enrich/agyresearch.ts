// src/enrich/agyresearch.ts — the second research pass, run through the `agy`
// CLI (src/agycli.ts) with the ChatGPT research stage's brief as its baseline.
//
// This is deliberately NOT a repeat of chatgptresearch.ts's ask. Sending the same
// "research this company" prompt to a second model duplicates the 80% both
// sources already agree on and pays the full research budget again for it. This
// stage instead hands agy the first pass's actual brief (as a file, via
// `--add-dir` — see agycli.ts for why the baseline is a file reference rather
// than text pasted into the prompt) and narrows the job to three things the first
// pass is least likely to have nailed:
//
//   1. The first pass's own UNKNOWN list — a second model, searching fresh, is
//      the cheapest way to close a few of those without repeating the whole ask.
//   2. Malaysian news/press coverage specifically. chatgptresearch.ts's source
//      checklist covers registries, socials, and job boards; it does not name a
//      news search, so this is real, not-yet-covered ground.
//   3. Corroborating or contradicting each risk the first pass flagged — a risk
//      backed by two independent passes is worth more than one asserted once.
//
// Same FACTS record format as the first pass on purpose (see FACTS_SPEC, shared
// from chatgptresearch.ts): it lets this reuse that file's parser rather than
// writing a second one, and it means the two fact sets can be merged into one
// rather than displayed as two disconnected schemas.
import type { BusinessRow } from '../leads.js';
import type { VaultService } from '../service.js';
import type { AgyIntel, ChatGptBuyingSignal, ChatGptClient, ChatGptFacts, ChatGptIntel, ChatGptPerson } from './types.js';
import type { DiscoveredCompanyWeb } from './websearch.js';
import { FACTS_SPEC, knownBlock, looksTruncated, parseFacts } from './chatgptresearch.js';
import { askAgy } from '../agycli.js';
import { AGY_SECONDPASS_FILE, CHATGPT_BASELINE_FILE, researchDirFor, writeResearchFile } from './researchfiles.js';

/**
 * Generous but shorter than the first pass's budget: this ask is narrower by
 * design (a gap list, one news search, a handful of risk checks), not a second
 * full research sweep.
 */
export const AGY_SECOND_PASS_TIMEOUT_MS = 300_000;

export function buildSecondPassPrompt(
  biz: BusinessRow,
  discovered: DiscoveredCompanyWeb | undefined,
  baseline: ChatGptIntel,
  briefFile: string,
): string {
  const unknowns = baseline.facts?.unknowns ?? [];
  const risks = baseline.facts?.risks ?? [];

  return `You are a B2B corporate intelligence analyst running a SECOND, follow-up pass of pre-sales due diligence on a Malaysian SME. A first research pass already ran — read its full brief before doing anything else:

FIRST-PASS BRIEF FILE (read this first): ${briefFile}

Do not restate anything that brief already found with a source; treat it as already covered. Your job is only to:

1. Resolve whichever of these the first pass could not establish — try sources it did not, not just the same search again:
${unknowns.length ? unknowns.map((u) => `   - ${u}`).join('\n') : '   - (the first pass left no explicit unknowns — go straight to 2 and 3)'}
2. Search specifically for MALAYSIAN NEWS coverage, press mentions, tenders/awards, incidents, or litigation naming this company or the people in it. The first pass checked registries, the company's own site, socials, and job boards — not news specifically, so this is genuinely new ground.
3. Corroborate or contradict each risk the first pass flagged, citing your own source either way:
${risks.length ? risks.map((r) => `   - ${r}`).join('\n') : '   - (none flagged)'}

## TARGET (already verified — use this to disambiguate, do not re-derive)
${knownBlock(biz, discovered)}
## RULES
- Every factual claim gets an inline source name. No source = do not state it.
- Write the literal token UNKNOWN where you could not establish something. Never guess, never fill a gap with a plausible-sounding value.
- Distinguish company-published claims from independently verifiable facts. Label the former "self-reported".
- If you cannot improve on something the first pass already has, say so briefly instead of re-researching it from scratch — your value here is the gap, not a second opinion on what already has a source.

## OUTPUT — use these exact headings
### 1. WHAT YOU RESOLVED
One line per item from the unknown list above: what you found and its source, or "still UNKNOWN — <what you tried>" if you also could not establish it.

### 2. NEWS AND PRESS
Whatever turned up under rule 2, dated, with source. State explicitly if nothing turned up.

### 3. RISK COROBORATION
For each first-pass risk above: confirmed / contradicted / could not verify, with your source either way.

### 4. FACTS
${FACTS_SPEC}

For this FACTS section specifically: only give a scalar (SSM, INCORPORATED, MSIC, PAIDUP, AGEYEARS, HEADCOUNT) a real value if you found something the first pass did not already have — otherwise write UNKNOWN for it, same as the first pass would. Your UNKNOWN records must list only what is STILL unresolved after this pass — do not repeat something you just resolved above.`;
}

/**
 * Run the second pass. Never throws, for the same reason runChatGptResearch
 * doesn't: the caller needs to tell "agy isn't installed" apart from "agy ran
 * and found nothing new", and an exception collapses that distinction.
 *
 * The baseline brief is written to a PERSISTENT file (research/<placeId>/ —
 * see researchfiles.ts), not a scratch temp file that gets deleted after the
 * call. Two things depend on that: agy reads it via `--add-dir` instead of
 * having the whole brief pasted into its prompt argument, and — the reason it
 * survives the call — it is the baseline half of a before/after comparison a
 * human can open directly, so agy's own output (also persisted alongside it)
 * can be checked against what the first pass actually found rather than only
 * against the merged result.
 */
export async function runAgySecondPass(
  svc: VaultService,
  biz: BusinessRow,
  discovered: DiscoveredCompanyWeb | undefined,
  baseline: ChatGptIntel,
): Promise<AgyIntel> {
  const started = Date.now();
  if (!baseline.ok || !baseline.brief) {
    return { ok: false, ms: 0, error: 'no baseline brief to build on — the first pass did not produce one', brief: '', facts: null };
  }

  const dir = researchDirFor(svc, biz.placeId);
  const briefFile = writeResearchFile(svc, biz.placeId, CHATGPT_BASELINE_FILE, baseline.brief);

  const prompt = buildSecondPassPrompt(biz, discovered, baseline, briefFile);
  try {
    const answer = await askAgy(prompt, { timeoutMs: AGY_SECOND_PASS_TIMEOUT_MS, workDir: dir });
    if (!answer.ok) {
      return { ok: false, ms: answer.ms, error: answer.error ?? 'agy returned no answer', brief: '', facts: null };
    }
    const brief = answer.text;
    writeResearchFile(svc, biz.placeId, AGY_SECONDPASS_FILE, brief);
    return { ok: true, ms: Date.now() - started, brief, facts: parseFacts(brief), truncated: looksTruncated(brief) };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err), brief: '', facts: null };
  }
}

const dedupeStrings = (items: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of items) {
    const key = s.trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  }
  return out;
};

const dedupeByKey = <T>(items: T[], keyOf: (item: T) => string): T[] => {
  const seen = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item).trim().toLowerCase();
    if (key && !seen.has(key)) seen.set(key, item);
  }
  return [...seen.values()];
};

/**
 * Combine the first pass's facts with the second pass's. Purely additive by
 * design, in both directions:
 *
 *   - `base` (the ChatGPT baseline) wins on every scalar it actually has — the
 *     second pass was told not to re-derive what the first already found, so a
 *     value from it only shows up here when the first pass had none.
 *   - Every array unions and dedupes rather than one side replacing the other,
 *     `unknowns` included. An earlier version let the second pass's own
 *     unknown list supersede the first pass's, on the theory that it had
 *     re-assessed the whole thing — but that trusts the second pass to have
 *     actually re-listed every gap it didn't close, and a model that drops one
 *     silently turns a real gap into what looks like a resolved one. Unioning
 *     means the worst case is a duplicate line, never a vanished gap — see
 *     researchfiles.ts for the other half of this guarantee: both passes' raw
 *     briefs are also kept on disk, so "did the merge actually lose something"
 *     is always independently checkable rather than a claim to trust.
 */
export function mergeFacts(base: ChatGptFacts | null, extra: ChatGptFacts | null): ChatGptFacts | null {
  if (!extra) return base;
  if (!base) return extra;

  return {
    ssm: base.ssm ?? extra.ssm,
    incorporatedOn: base.incorporatedOn ?? extra.incorporatedOn,
    msic: base.msic ?? extra.msic,
    paidUpCapital: base.paidUpCapital ?? extra.paidUpCapital,
    companyAgeYears: base.companyAgeYears ?? extra.companyAgeYears,
    headcount: base.headcount ?? extra.headcount,
    headcountSource: base.headcount ? base.headcountSource : extra.headcountSource,
    primaryRevenueLine: base.primaryRevenueLine ?? extra.primaryRevenueLine,
    customerSegment: base.customerSegment ?? extra.customerSegment,
    people: dedupeByKey<ChatGptPerson>([...base.people, ...extra.people], (p) => p.name),
    clients: dedupeByKey<ChatGptClient>([...base.clients, ...extra.clients], (c) => c.name),
    buyingSignals: dedupeByKey<ChatGptBuyingSignal>([...base.buyingSignals, ...extra.buyingSignals], (s) => s.signal),
    risks: dedupeStrings([...base.risks, ...extra.risks]),
    extraPhones: dedupeStrings([...base.extraPhones, ...extra.extraPhones]),
    extraEmails: dedupeStrings([...base.extraEmails, ...extra.extraEmails]),
    extraUrls: dedupeStrings([...base.extraUrls, ...extra.extraUrls]),
    unknowns: dedupeStrings([...base.unknowns, ...extra.unknowns]),
    confidence: base.confidence ?? extra.confidence,
  };
}
