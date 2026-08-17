// src/enrich/chatgptresearch.ts — the deep-research stage, driven through the
// signed-in ChatGPT web session.
//
// Why this stage exists at all: every other stage in this pipeline reads ONE
// source and stops. websearch.ts runs a single Google query, keeps page one, and
// collects result URLs it never opens — so the CTOS, Experian and Maukerja links
// that actually carry the SSM number, the incorporation date and the headcount are
// captured as strings and thrown away. The ChatGPT session has live web search, so
// it reads those pages. Measured on CL Reno Sdn Bhd, 2026-08-17: the eight-stage
// pipeline produced a 1,580-byte dossier with no SSM, no named humans and no
// buying signals; this one stage produced 19,761 characters carrying the SSM, the
// incorporation date, four named people, eight client projects, six dated job
// posts with salary bands, and a CIDB grade.
//
// The depth is in the PROMPT, not the model. The same session asked the obvious
// way ("tell me everything about X") returns 14,100 characters of readable prose
// with no schema, no gap list and no source discipline. Three rules produced the
// difference, and all three are load-bearing:
//
//   1. Seed what is already known. Without the address, phone and website, the
//      model researches whichever same-named company it finds first, and a wrong
//      company reads exactly like a thin one.
//   2. Name the sources to check, and require an explicit answer for each. "Search
//      the web" is answered by one search; a checklist is answered source by
//      source, and the misses come back labelled instead of silently absent.
//   3. Demand the literal token UNKNOWN and a source per claim. Unprompted, the
//      gaps get filled with plausible industry-average filler, which is worse than
//      an empty field because it cannot be distinguished from a finding. With the
//      rule, the CL Reno brief came back with 19 explicitly enumerated unknowns.

import type { VaultService } from '../service.js';
import type { BusinessRow } from '../leads.js';
import type { ChatGptFacts, ChatGptIntel } from './types.js';
import type { DiscoveredCompanyWeb } from './websearch.js';

/**
 * Budget for the whole ask.
 *
 * Generous on purpose. The prompt is ~4KB in and ~18KB out and the answer requires
 * the session to actually read a dozen pages: observed 111s, 138s, 150s and 232s on
 * identical prompts, so the spread is wide and driven by how busy the far end is.
 * At 300s a slow run failed outright — and failing costs the entire brief, because
 * askChatGpt discards a partial reply rather than return a truncated answer as
 * complete (the right call: a truncated answer that reports success is its worst
 * failure mode). Waiting is cheap here and losing the brief is not.
 */
export const RESEARCH_TIMEOUT_MS = 600_000;

const line = (label: string, value: unknown): string =>
  value ? `${label}: ${value}\n` : '';

/**
 * The known-facts block. This is disambiguation, not decoration: "CL Reno" alone
 * is ambiguous enough that the model can research a different company entirely and
 * return a confident, well-sourced, useless brief.
 */
export function knownBlock(biz: BusinessRow, discovered?: DiscoveredCompanyWeb): string {
  const site = biz.website || discovered?.website;
  const fb = biz.facebook || discovered?.facebookUrl;
  const ig = biz.instagram || discovered?.instagramUrl;
  const li = biz.linkedin || discovered?.linkedinUrl;

  return (
    line('Legal name', biz.name) +
    line('Google Maps category', biz.category) +
    line('Address', biz.address) +
    line('Coordinates', biz.lat && biz.lng ? `${biz.lat}, ${biz.lng}` : '') +
    line('Phone', biz.phone) +
    line('Email', biz.email) +
    line('Website', site) +
    line('Facebook', fb) +
    line('Instagram', ig) +
    line('LinkedIn', li) +
    line('TikTok', discovered?.tiktokUrl) +
    line('SSM (unconfirmed, from search text)', discovered?.ssm) +
    line('CTOS / CreditScan record', discovered?.ctosUrl) +
    line('Maukerja record', discovered?.maukerjaUrl) +
    line(
      'Google rating',
      biz.rating ? `${biz.rating} from ${biz.reviews ?? 0} reviews` : '',
    )
  );
}

/**
 * Exported for tests, and because the prompt IS the feature — it should be
 * reviewable and diffable on its own, not buried inside an async call.
 */
export function buildResearchPrompt(biz: BusinessRow, discovered?: DiscoveredCompanyWeb): string {
  return `You are a B2B corporate intelligence analyst doing pre-sales due diligence on a Malaysian SME. Search the web before answering. Do not rely on memory alone.

## TARGET (already verified by me — use this to disambiguate, do not re-derive)
${knownBlock(biz, discovered)}
## SOURCES YOU MUST CHECK BY NAME
Check each of these and say explicitly if it had nothing:
1. SSM / e-Info, CTOS, CreditScan, Experian Malaysia, MalaysiaData — registration no., incorporation date, MSIC code, paid-up capital, directors/shareholders, status (live/struck off)
2. Their own website — every service page, project/portfolio page, About/team page, testimonials
3. Maukerja, Hiredly, Ricebowl, JobStreet, Jora, LinkedIn Jobs — open roles, salary bands, headcount, office photos
4. LinkedIn company page + LinkedIn people search for anyone listing this company as employer
5. Facebook page + Instagram — post frequency, last post date, follower count, comment engagement
6. Google Maps reviews — recurring praise and recurring complaints, and the DATE of the newest review
7. CIDB registry, any trade association or certification listing
8. Malaysian news, court/litigation records, tender/award announcements, bankruptcy or winding-up notices

## RULES
- Every factual claim gets an inline source name. No source = do not state it.
- Write the literal token UNKNOWN where you could not find something. Never guess, never infer a plausible-sounding value, never fill a gap with an industry average.
- Distinguish company-published claims from independently verifiable facts. Label the former "self-reported".
- Named humans matter more than anything else here. Hunt for founder, directors, PIC, sales contact, anyone quoted in a testimonial or job ad.
- If a URL I supplied above is dead, redirects, or belongs to a different company, say so explicitly.

## OUTPUT — use these exact headings
### 1. REGISTRY
Registration no., incorporation date, company age in years, MSIC code + description, paid-up capital, directors/shareholders, current status.

### 2. WHAT THEY ACTUALLY SELL
The revenue lines, in their own words. Which is the primary one. Who buys it (segment, not adjectives). Their price points if discoverable.

### 3. SCALE
Headcount and the source of that number. Number of projects evidenced. Geographic reach. Any equipment, premises, or fleet visible in photos.

### 4. NAMED PEOPLE
Table: Name | Role | Source | How to reach them. One row per human found, including clients quoted in testimonials.

### 5. CLIENTS AND PROJECTS
Every named client or project, with year if stated, and what was delivered.

### 6. BUYING SIGNALS
Anything indicating they are spending money right now: active job posts (with role + salary + date), new branch, new equipment, rebrand, funding, expanded services, rising post frequency. Date each one.

### 7. RISKS AND RED FLAGS
Dormant socials, address inconsistencies, complaint patterns, litigation, very young entity vs large claimed scope, unverifiable portfolio.

### 8. WHAT I COULD NOT FIND
The explicit gap list.

### 9. FACTS
${FACTS_SPEC}`;
}

/**
 * The machine-readable tail, as one record per line rather than one JSON object.
 *
 * This is not a style preference, it is the only shape that survives being read back.
 * The answer is harvested from the rendered DOM's innerText, and a long fenced block
 * does not read back whole: measured across three live runs of the same prompt on
 * 2026-08-17, a single JSON object was lost three different ways — once complete
 * (19,761 chars), once cut off inside the `people` array, and once with a contiguous
 * chunk missing from the MIDDLE, so the outer brace and every scalar field were gone
 * while the tail was intact. A JSON object is all-or-nothing: any of those losses
 * yields zero structured facts from a brief whose prose was completely usable.
 *
 * One record per line makes a partial read cost only the records it dropped. Every
 * line that arrives is independently parseable, so the failure mode degrades from
 * "no facts at all" to "most of the facts".
 */
export const FACTS_SPEC = `Close with one record per line in exactly this format. No JSON, no code fence, no table, no bullets — just plain lines, because a long fenced block does not survive being copied out.

Repeat these keys as many times as you have records. Use a single hyphen for a field you do not know:
PERSON: name | role | source | contact
CLIENT: name | year | what was delivered
SIGNAL: what they are spending on | date | source
RISK: one risk per line
UNKNOWN: one thing you could not establish per line
PHONE: any phone number not already in my TARGET block
EMAIL: any email not already in my TARGET block
URL: any useful page you found

Write each of these exactly once:
SSM: registration number, or UNKNOWN
INCORPORATED: YYYY-MM-DD, or UNKNOWN
MSIC: code and description, or UNKNOWN
PAIDUP: paid-up capital, or UNKNOWN
AGEYEARS: company age in years as a number, or UNKNOWN
HEADCOUNT: count | source, or UNKNOWN
SELLS: their primary revenue line
BUYERS: who buys it
CONFIDENCE: high, medium, or low`;

const strOrNull = (v: unknown): string | null => {
  if (typeof v !== 'string') return typeof v === 'number' ? String(v) : null;
  const t = v.trim();
  // The prompt asks for the literal token on a miss, so it arrives as data. Treating
  // it as a value puts the string "UNKNOWN" in the SSM column of the report. The bare
  // dash is the same thing for a pipe-separated field, and must be matched WHOLE — a
  // role like "Client - AZ Nursery" is a real value that merely contains one.
  return !t || /^(unknown|unverified|n\/?a|none|null|nil|[-–—]+)$/i.test(t) ? null : t;
};

const numOrNull = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(strOrNull).filter((s): s is string => !!s) : [];

const objList = <T>(v: unknown, map: (o: Record<string, unknown>) => T | null): T[] =>
  Array.isArray(v)
    ? v
        .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
        .map(map)
        .filter((o): o is T => !!o)
    : [];

/** Shape whatever came back into the declared type. A missing array must be [], never undefined. */
function normalizeFacts(raw: Record<string, unknown>): ChatGptFacts {
  const confidence = strOrNull(raw.confidence)?.toLowerCase();
  return {
    ssm: strOrNull(raw.ssm),
    incorporatedOn: strOrNull(raw.incorporatedOn),
    msic: strOrNull(raw.msic),
    paidUpCapital: strOrNull(raw.paidUpCapital),
    companyAgeYears: numOrNull(raw.companyAgeYears),
    headcount: strOrNull(raw.headcount),
    headcountSource: strOrNull(raw.headcountSource),
    primaryRevenueLine: strOrNull(raw.primaryRevenueLine),
    customerSegment: strOrNull(raw.customerSegment),
    people: objList(raw.people, (o) => {
      const name = strOrNull(o.name);
      return name
        ? { name, role: strOrNull(o.role) ?? 'Unstated', source: strOrNull(o.source) ?? 'ChatGPT research', contact: strOrNull(o.contact) }
        : null;
    }),
    clients: objList(raw.clients, (o) => {
      const name = strOrNull(o.name);
      return name ? { name, year: strOrNull(o.year), delivered: strOrNull(o.delivered) } : null;
    }),
    buyingSignals: objList(raw.buyingSignals, (o) => {
      const signal = strOrNull(o.signal);
      return signal ? { signal, date: strOrNull(o.date), source: strOrNull(o.source) ?? 'ChatGPT research' } : null;
    }),
    risks: strList(raw.risks),
    extraPhones: strList(raw.extraPhones),
    extraEmails: strList(raw.extraEmails),
    extraUrls: strList(raw.extraUrls),
    unknowns: strList(raw.unknowns),
    confidence: confidence === 'high' || confidence === 'medium' || confidence === 'low' ? confidence : null,
  };
}

/**
 * Pull the schema block out of the brief.
 *
 * Deliberately NOT fence-based. The answer is read via the rendered DOM's
 * innerText (see readAnswer in chatgpt.ts), which strips the ``` markers and
 * leaves the language label as a bare word — so the block arrives as `JSON\n{…}`
 * and every fence regex returns nothing. Measured 2026-08-17: a fenced-block
 * parser scored zero on a brief that carried a perfectly well-formed object.
 *
 * So: collect every balanced top-level {...} span and take the last one that
 * parses into something schema-shaped. The scan is string-aware because a brace
 * inside a quoted value — common in these briefs, e.g. an address or a quoted
 * job title — would otherwise unbalance the count and swallow the rest of the text.
 */
export function parseFactsTail(text: string): ChatGptFacts | null {
  // Candidate object starts, latest first. Walking backwards means the inner objects
  // of the schema block get tried before its outer brace, and each is rejected on the
  // key check below rather than on a parse error.
  const starts: number[] = [];
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === '{') starts.push(i);
  }

  for (const start of starts) {
    const span = balancedSpanFrom(text, start);
    if (!span) continue;
    try {
      const parsed = JSON.parse(span) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const o = parsed as Record<string, unknown>;
      // Guard against a coincidental object in the prose. Requiring one of the
      // distinctive keys is enough; requiring all of them would reject a brief
      // that legitimately omitted a field.
      if ('unknowns' in o || 'buyingSignals' in o || 'ssm' in o || 'people' in o) {
        return normalizeFacts(o);
      }
    } catch {
      // Prose that merely looked like an object, e.g. a braced address fragment.
    }
  }
  return null;
}

const emptyFacts = (): ChatGptFacts => ({
  ssm: null,
  incorporatedOn: null,
  msic: null,
  paidUpCapital: null,
  companyAgeYears: null,
  headcount: null,
  headcountSource: null,
  primaryRevenueLine: null,
  customerSegment: null,
  people: [],
  clients: [],
  buyingSignals: [],
  risks: [],
  extraPhones: [],
  extraEmails: [],
  extraUrls: [],
  unknowns: [],
  confidence: null,
});

/** Split a record's pipe-separated fields, mapping "-" and UNKNOWN to null. */
function fields(rest: string, count: number): (string | null)[] {
  const parts = rest.split('|').map((p) => p.trim());
  return Array.from({ length: count }, (_, i) => strOrNull(parts[i] ?? ''));
}

/**
 * The first pipe-separated field of a record the spec defines as single-value.
 *
 * The model volunteers a source on these anyway — measured, PHONE came back as
 * "+60 11-3932 2861 | CL Reno website" and SELLS as "Interior design… | CL Reno
 * website / Hiredly". Keeping the whole string puts an unusable phone number in the
 * contact matrix and a citation trail in the middle of a display field, so the value
 * is taken and the volunteered source dropped.
 */
const firstField = (rest: string): string | null => strOrNull(rest.split('|')[0]);

/**
 * Parse the line-oriented FACTS tail.
 *
 * Tolerant of the renderer on purpose: the markdown pass may bold a key, prefix a
 * bullet, or wrap a record in a list item, and a strict matcher would drop the record
 * over formatting that carries no meaning. Returns null only when NO record was found
 * at all, so the caller can tell "the model answered in another shape" from "the model
 * found nothing".
 */
export function parseFactsLines(text: string): ChatGptFacts | null {
  const out = emptyFacts();
  let hits = 0;

  for (const raw of text.split('\n')) {
    // Strip list markers, heading hashes and bold markers before matching.
    const line = raw.replace(/^[\s>*\-–•]+/, '').replace(/\*\*/g, '').replace(/^#+\s*/, '').trim();
    const m = /^([A-Z][A-Z_]{2,14})\s*[:：]\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toUpperCase();
    const rest = m[2].trim();
    if (!rest) continue;

    switch (key) {
      case 'PERSON': {
        const [name, role, source, contact] = fields(rest, 4);
        if (name) {
          hits++;
          out.people.push({ name, role: role ?? 'Unstated', source: source ?? 'ChatGPT research', contact });
        }
        break;
      }
      case 'CLIENT': {
        const [name, year, delivered] = fields(rest, 3);
        if (name) {
          hits++;
          out.clients.push({ name, year, delivered });
        }
        break;
      }
      case 'SIGNAL': {
        const [signal, date, source] = fields(rest, 3);
        if (signal) {
          hits++;
          out.buyingSignals.push({ signal, date, source: source ?? 'ChatGPT research' });
        }
        break;
      }
      case 'RISK':
        if (strOrNull(rest)) { hits++; out.risks.push(rest); }
        break;
      case 'UNKNOWN':
        if (strOrNull(rest)) { hits++; out.unknowns.push(rest); }
        break;
      case 'PHONE': {
        const phone = firstField(rest);
        if (phone && !out.extraPhones.includes(phone)) { hits++; out.extraPhones.push(phone); }
        break;
      }
      case 'EMAIL': {
        const email = firstField(rest);
        if (email && !out.extraEmails.includes(email)) { hits++; out.extraEmails.push(email); }
        break;
      }
      case 'URL': {
        const url = firstField(rest);
        if (url?.startsWith('http') && !out.extraUrls.includes(url)) { hits++; out.extraUrls.push(url); }
        break;
      }
      case 'SSM': out.ssm = firstField(rest); hits++; break;
      case 'INCORPORATED': out.incorporatedOn = firstField(rest); hits++; break;
      case 'MSIC': out.msic = strOrNull(rest); hits++; break;
      case 'PAIDUP': out.paidUpCapital = firstField(rest); hits++; break;
      case 'AGEYEARS': out.companyAgeYears = numOrNull(rest.split('|')[0]); hits++; break;
      case 'HEADCOUNT': {
        const [count, source] = fields(rest, 2);
        out.headcount = count;
        // A source with no count is a citation for a fact we do not have, and it renders
        // as an empty headcount attributed to Maukerja. Drop it with the value.
        out.headcountSource = count ? source : null;
        hits++;
        break;
      }
      case 'SELLS': out.primaryRevenueLine = firstField(rest); hits++; break;
      case 'BUYERS': out.customerSegment = firstField(rest); hits++; break;
      case 'CONFIDENCE': {
        const c = firstField(rest)?.toLowerCase();
        out.confidence = c === 'high' || c === 'medium' || c === 'low' ? c : null;
        hits++;
        break;
      }
      default:
        break;
    }
  }

  return hits ? out : null;
}

/** How much a parse actually recovered — used to pick the better of two readings. */
const factsWeight = (f: ChatGptFacts | null): number =>
  f
    ? f.people.length + f.clients.length + f.buyingSignals.length + f.risks.length + f.unknowns.length +
      [f.ssm, f.incorporatedOn, f.headcount, f.primaryRevenueLine, f.customerSegment].filter(Boolean).length
    : 0;

/**
 * Read the structured tail however it arrived.
 *
 * The line format is what the prompt asks for, but the JSON reader is kept because a
 * model that answers in JSON anyway should not cost us the facts — and because a
 * partial line read and a partial JSON read can recover different amounts. Take
 * whichever recovered more rather than trusting the format we asked for.
 */
export function parseFacts(text: string): ChatGptFacts | null {
  const lines = parseFactsLines(text);
  const json = parseFactsTail(text);
  if (!lines) return json;
  if (!json) return lines;
  return factsWeight(json) > factsWeight(lines) ? json : lines;
}

/**
 * The balanced {...} span beginning at `start`, or null if it never closes.
 *
 * String tracking starts AT the opening brace, and that is the whole point. Tracking
 * it across the entire document instead — the obvious implementation — makes prose
 * quotes part of the state: the briefs quote source text constantly ("no. syarikat",
 * "OTHER SPECIALIZED CONSTRUCTION ACTIVITIES, N.E.C."), and an odd number of quote
 * characters anywhere above the schema block leaves the scanner believing it is
 * inside a string when the block begins, so it skips every brace in it and reports
 * no JSON at all. Measured 2026-08-17: that dropped a complete, perfectly balanced
 * 11-brace schema block on a live run, while an earlier run with an even quote count
 * parsed fine — which is the worst kind of bug, one that looks like model variance.
 */
function balancedSpanFrom(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Did the answer stop mid-structure? An unbalanced brace count is the cheap tell,
 * and it separates "the model wrote no schema block" from "the model was writing one
 * when the generation ended" — which need different responses.
 */
export function looksTruncated(text: string): boolean {
  // ANY unclosed brace, not just the last one. The last brace is typically an inner
  // object that closes perfectly well while the object CONTAINING it was cut off —
  // measured on a live run, the outer schema brace was unclosed at offset 14622 while
  // four inner person objects after it were intact, so testing only the last brace
  // called that answer complete.
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    if (balancedSpanFrom(text, i) === null) return true;
  }
  return false;
}

/**
 * Second ask, extraction only, run only when the brief's own tail did not parse.
 *
 * Needed because the schema block sits at the END of a long answer, which makes it
 * the first thing lost when a generation runs long. Measured 2026-08-17 on CL Reno:
 * the same prompt returned a complete 19,761-char answer on one run and a
 * 15,981-char answer truncated inside the `people` array on the next — the prose was
 * entirely usable both times, but the second run yielded no structured facts at all.
 *
 * Splitting the work fixes that for good: research is hard and wants the long
 * answer, extraction is easy and wants a short one, and making one call do both
 * means the easy half competes for room with the hard half and loses. Each call is a
 * fresh temporary chat with no memory, so the brief has to be sent back as context
 * rather than referred to.
 */
async function extractFactsFromBrief(svc: VaultService, brief: string): Promise<ChatGptFacts | null> {
  const prompt = `Below is a company research brief. Re-express it as records, and output nothing else — no preamble, no commentary, no closing remark.

Rules:
- Copy facts from the brief only. Do not search the web and do not add anything from your own knowledge.
- Write UNKNOWN for anything the brief marks UNKNOWN or does not state. Never invent a value.
- Include every named person and every named client the brief mentions.

${FACTS_SPEC}

BRIEF:
${brief}`;

  try {
    const answer = await svc.chatgptAsk(prompt, RESEARCH_TIMEOUT_MS);
    return answer.ok ? parseFacts(answer.text) : null;
  } catch {
    // The brief is already in hand and is the valuable half. A failed repair
    // downgrades the dossier; it must not fail it.
    return null;
  }
}

/**
 * Run the research stage. Never throws: a failed ask is a recorded outcome, since
 * the caller needs to distinguish "ChatGPT is not signed in" from "the company has
 * no footprint", and those two look identical once an exception is swallowed.
 */
export async function runChatGptResearch(
  svc: VaultService,
  biz: BusinessRow,
  discovered?: DiscoveredCompanyWeb,
): Promise<ChatGptIntel> {
  const prompt = buildResearchPrompt(biz, discovered);
  const started = Date.now();
  try {
    const answer = await svc.chatgptAsk(prompt, RESEARCH_TIMEOUT_MS);
    if (!answer.ok) {
      return { ok: false, ms: answer.ms, error: answer.error ?? 'chatgpt_ask returned no answer', brief: '', facts: null };
    }

    const brief = answer.text;
    const truncated = looksTruncated(brief);
    let facts = parseFacts(brief);
    let repaired = false;

    // Only pay for the second call when the first did not deliver enough. A thin
    // reading — a couple of scalars and no people or signals — means the tail was
    // partially lost, and re-extracting from the prose recovers it; the prose itself
    // is almost always intact even when the structured tail is not.
    if (brief.length > 1_000 && factsWeight(facts) < 6) {
      const rescued = await extractFactsFromBrief(svc, brief);
      if (factsWeight(rescued) > factsWeight(facts)) {
        facts = rescued;
        repaired = true;
      }
    }

    return { ok: true, ms: Date.now() - started, brief, facts, truncated, repaired };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err), brief: '', facts: null };
  }
}
