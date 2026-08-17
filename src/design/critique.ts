/**
 * The design review pass — the step that makes the agent a designer rather than
 * a code generator, because it is the only one that LOOKS at the result.
 *
 * It runs on the fast worker (StepFun step-3.7-flash), NOT on whichever model
 * built the page. That is not a preference, it is a measured constraint:
 * kimi-k3 through the cmkey proxy accepts an image payload, returns HTTP 200,
 * and answers as if no image were attached — on both the Anthropic and the
 * OpenAI surface (measured 2026-08-17). A blind reviewer is worse than none,
 * because its approval reads exactly like a real one.
 *
 * fastworker's multimodal behaviour is measured too — see fastworker.ts:26.
 */
import { fastAsk, imageDataUrl, isFastWorkerReady } from '../fastworker.js';
import type { Shot } from './shoot.js';

export type Severity = 'blocker' | 'major' | 'minor';

export interface Issue {
  severity: Severity;
  viewport: string;
  problem: string;
  fix: string;
}

export interface Critique {
  pass: boolean;
  score: number;
  issues: Issue[];
  /** Set when the model could not be reached or its answer was unusable. */
  error?: string;
}

/**
 * What a review cost. Reported even when the review FAILED — a call that burned
 * 16k tokens and returned nothing still has to appear on the bill, and the
 * empty-answer failure mode is exactly when it would otherwise go unrecorded.
 */
export interface ReviewCost {
  model: string;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

const RUBRIC = `
You are a senior web designer reviewing a page you did not build. Be specific
and be harsh; a vague note is useless to the person fixing it.

Judge only what the screenshot actually shows:
1. HIERARCHY   — does the eye land on the right thing first? Is there one clear
                 primary action, or do several elements compete?
2. TYPE        — consistent scale, comfortable measure (45-80 chars), line
                 height that is not cramped. Flag walls of same-size text.
3. SPACING     — consistent rhythm, related things grouped, generous whitespace.
                 Flag cramped edges and uneven gaps.
4. COLOUR      — restrained palette, adequate contrast for body text, colour
                 carrying meaning rather than decoration.
5. POLISH      — alignment, orphaned elements, default-looking browser widgets,
                 anything that reads as unfinished or as a template.
`.trim();

const FORMAT = `
Answer with ONE JSON object and nothing else. No prose, no code fence.
{"score": <0-100>, "issues": [{"severity":"blocker|major|minor","problem":"...","fix":"..."}]}
"blocker" = the page is broken or unusable. "major" = it looks amateur.
"minor" = polish. Return an empty issues array only if you genuinely find none.
`.trim();

/** Pull the first JSON object out of an answer that may still carry stray prose. */
function parseVerdict(text: string): { score: number; issues: Omit<Issue, 'viewport'>[] } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as {
      score?: number;
      issues?: Omit<Issue, 'viewport'>[];
    };
    if (typeof parsed.score !== 'number' || !Array.isArray(parsed.issues)) return null;
    return { score: parsed.score, issues: parsed.issues };
  } catch {
    return null;
  }
}

/**
 * Review one screenshot. One call per viewport: sending both at once reliably
 * produced a merged critique that named no viewport, which is unactionable.
 */
async function reviewShot(
  shot: Shot,
  brief: string,
): Promise<{ score: number; issues: Issue[]; error?: string; cost?: ReviewCost }> {
  const prompt = [
    RUBRIC,
    ``,
    `The page was built to this brief: ${brief}`,
    `You are looking at the ${shot.viewport} rendering (${shot.viewport === 'mobile' ? '375px' : '1440px'} wide).`,
    ``,
    FORMAT,
  ].join('\n');

  try {
    // 16000, not the 3000 this was first written with. The model ALWAYS
    // reasons, and reasoning length tracks how debatable the question is — a
    // design critique is the most debatable question there is. Measured
    // 2026-08-17: at 3000 the reasoning consumed the entire budget and every
    // review came back empty with finish_reason 'length', scoring every page
    // 0/100. See the same failure documented at fastworker.ts:19.
    const answer = await fastAsk(prompt, {
      images: [imageDataUrl(shot.file)],
      maxTokens: 16_000,
      timeoutMs: 180_000,
      system: 'You are a senior web designer. Output only the JSON object requested.',
    });
    const cost: ReviewCost = {
      model: answer.model,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      ms: answer.ms,
    };
    const verdict = parseVerdict(answer.text);
    if (!verdict) {
      return { score: 0, issues: [], error: `unparseable verdict: ${answer.text.slice(0, 120)}`, cost };
    }
    return {
      score: verdict.score,
      issues: verdict.issues.map((i) => ({ ...i, viewport: shot.viewport })),
      cost,
    };
  } catch (error) {
    return { score: 0, issues: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Review every shot and fold in the defects measured in the browser, which a
 * screenshot cannot reveal.
 */
export async function critique(
  shots: Shot[],
  brief: string,
  /** Called once per model call, including failed ones, so nothing goes unbilled. */
  onCost?: (cost: ReviewCost) => void,
): Promise<Critique> {
  if (!isFastWorkerReady()) {
    return {
      pass: false,
      score: 0,
      issues: [],
      error:
        'No multimodal reviewer configured. Set FASTWORKER_BASE_URL and FASTWORKER_MODEL in .env — ' +
        'the building model cannot review its own work, it cannot see images.',
    };
  }

  const issues: Issue[] = [];
  const scores: number[] = [];
  const errors: string[] = [];

  for (const shot of shots) {
    // Measured facts first: these are not opinions and are not up for a vote.
    if (shot.overflowRatio > 1.01) {
      issues.push({
        severity: 'blocker',
        viewport: shot.viewport,
        problem: `The page is ${Math.round((shot.overflowRatio - 1) * 100)}% wider than the viewport, so it scrolls sideways.`,
        fix: 'Find the element exceeding the viewport width; apply max-width:100% or let the container wrap.',
      });
    }
    for (const err of shot.consoleErrors.slice(0, 3)) {
      issues.push({
        severity: 'blocker',
        viewport: shot.viewport,
        problem: `Console error: ${err}`,
        fix: 'Fix the failing script or the missing asset. Check paths are relative — the app is served under /app/<slug>/.',
      });
    }

    const review = await reviewShot(shot, brief);
    if (review.cost) onCost?.(review.cost);
    issues.push(...review.issues);
    if (review.error) errors.push(`${shot.viewport}: ${review.error}`);
    else scores.push(review.score);
  }

  const score = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  const blocking = issues.filter((i) => i.severity === 'blocker' || i.severity === 'major');

  return {
    // An unreadable review is a failed review. Passing a page because the
    // reviewer broke is exactly the silent-approval trap this file exists for.
    pass: errors.length === 0 && blocking.length === 0 && score >= 75,
    score,
    issues,
    error: errors.length ? errors.join(' · ') : undefined,
  };
}

/** The critique as the instruction set the building model gets back. */
export function asRevisionBrief(c: Critique): string {
  const ranked = [...c.issues].sort(
    (a, b) =>
      ['blocker', 'major', 'minor'].indexOf(a.severity) - ['blocker', 'major', 'minor'].indexOf(b.severity),
  );
  return [
    `A design review of the live page scored it ${c.score}/100. Fix these, highest severity first.`,
    ...ranked.map((i, n) => `${n + 1}. [${i.severity}, ${i.viewport}] ${i.problem}\n   Fix: ${i.fix}`),
    '',
    'Edit the existing files in place. Do not start over, and do not restate the brief back to me.',
  ].join('\n');
}
