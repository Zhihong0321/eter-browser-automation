/**
 * The freelancer loop: brief in, live URL out.
 *
 *   build → publish → screenshot → critique → revise → publish → ...
 *
 * Two models, because one of them cannot see. The builder is whichever
 * connection profile you pass (kimi-k3 by default: cheap, text-only, good at
 * code). The reviewer is always the fast worker, which is measured multimodal.
 * See critique.ts for why that split is not optional.
 *
 *   npx tsx src/design/freelance.ts --slug acme-landing "brief..."
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assistantText, connProfile, runAgent } from '../agent.js';
import { critique, asRevisionBrief, type Critique } from './critique.js';
import { publish, toSlug } from './host.js';
import { imageServer } from './imagetool.js';
import { optimizeDir, pagePathsOf, writeSeoFiles, formatOptimizeReport, type OptimizeReport } from './optimize.js';
import { shoot } from './shoot.js';
import { verify, asVerifyFixBrief, type VerifyResult } from './verify.js';

export interface FreelanceOptions {
  brief: string;
  /** Directory the agent builds in. Created if absent; reused across rounds. */
  workDir: string;
  slug: string;
  name?: string;
  tags?: string[];
  /** Connection the BUILDER runs on. The reviewer is always the fast worker. */
  profile?: string;
  /** Review-and-revise rounds after the first build. */
  rounds?: number;
  /**
   * Round 0 publishes `workDir` as it stands instead of calling the builder —
   * for bringing an already-built site up to the gate (see `polish()`) rather
   * than building one from a brief.
   */
  skipInitialBuild?: boolean;
  /** Run the Bedrock-style gate (verify.ts) each round. Default true. */
  verify?: boolean;
  onLog?: (line: string) => void;
}

export interface FreelanceResult {
  url: string;
  rounds: number;
  final: Critique;
  /** Null only when `verify: false` was passed, or every attempt errored. */
  verify: VerifyResult | null;
  optimize: OptimizeReport | null;
  history: {
    round: number;
    score: number;
    blockers: number;
    url: string;
    verifyPass: boolean | null;
    perf: number | null;
  }[];
}

/** A round beats another if it clears the gate and the other doesn't; ties break on the design score. */
function betterRound(a: { score: number; pass: boolean }, b: { score: number; pass: boolean }): boolean {
  if (a.pass !== b.pass) return a.pass;
  return a.score > b.score;
}

const BUILD_INSTRUCTIONS = `
Build the site in the current working directory. index.html at the root,
assets in subfolders with RELATIVE paths. Do not create a README, a package.json,
a build step or a git repo — static files only. When you are done, stop.
`.trim();

/** Drain an SDK query, returning the assistant text. Throws on a failed run. */
async function build(prompt: string, profile: string, workDir: string): Promise<string> {
  let text = '';
  for await (const message of runAgent(prompt, {
    profile,
    role: 'designer',
    // The image tool is scoped to this build directory, so it is wired here
    // rather than baked into the role — a role carries no per-run state.
    overrides: { cwd: workDir, mcpServers: { imagery: imageServer(workDir) } },
  })) {
    text += assistantText(message);
    if (message.type === 'result' && message.subtype !== 'success') {
      throw new Error(`Builder run failed: ${message.subtype}`);
    }
  }
  return text;
}

export async function freelance(opts: FreelanceOptions): Promise<FreelanceResult> {
  const log = opts.onLog ?? ((line: string) => console.log(line));
  const rounds = opts.rounds ?? 2;
  const profile = opts.profile ?? 'kimi';
  fs.mkdirSync(opts.workDir, { recursive: true });

  // Fail before spending a build on a connection or a key that is not there.
  const conn = connProfile(profile);
  log(`  builder  : ${conn.id} · ${conn.model}`);
  log(`  reviewer : fast worker (multimodal)`);
  log(`  workdir  : ${opts.workDir}`);

  const history: FreelanceResult['history'] = [];
  let url = '';
  let latest: Critique = { pass: false, score: 0, issues: [], error: 'never reviewed' };

  /**
   * A revision is not guaranteed to be an improvement. Measured 2026-08-17:
   * a 3-round run went 55 → 55 → 53, and the final round emptied three whole
   * sections of the page. Delivering "whatever came last" shipped that.
   *
   * So every round is snapshotted, the best-scoring one wins, and the loop
   * stops as soon as revising stops helping.
   */
  const bestDir = path.join(opts.workDir, '.best');
  let bestScore = -1;
  let bestRound = -1;
  let bestCritique = latest;
  let prevText = 0;

  const snapshot = () => {
    fs.rmSync(bestDir, { recursive: true, force: true });
    fs.cpSync(opts.workDir, bestDir, {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}.shots`) && !src.includes(`${path.sep}.best`),
    });
  };

  for (let round = 0; round <= rounds; round++) {
    const first = round === 0;
    log(`\n  round ${round} — ${first ? 'building' : 'revising'}`);

    await build(
      first ? `${opts.brief}\n\n${BUILD_INSTRUCTIONS}` : asRevisionBrief(latest),
      profile,
      opts.workDir,
    );

    const app = await publish(opts.workDir, { slug: opts.slug, name: opts.name, tags: opts.tags });
    url = app.url;
    log(`  published: ${url}`);

    const shots = await shoot(url, path.join(opts.workDir, '.shots', String(round)));
    for (const s of shots) {
      log(`  shot     : ${s.viewport} · overflow ${s.overflowRatio.toFixed(3)} · ${s.consoleErrors.length} console errors`);
    }

    // Content collapse is measured, not reviewed: a page that lost half its
    // copy is a failed revision however pretty the remainder looks.
    const text = Math.max(...shots.map((s) => s.textLength));
    const gutted = prevText > 0 && text < prevText * 0.6;
    prevText = Math.max(prevText, text);

    latest = await critique(shots, opts.brief);
    const blockers = latest.issues.filter((i) => i.severity === 'blocker' || i.severity === 'major').length;
    history.push({ round, score: latest.score, blockers, url });
    log(
      `  review   : ${latest.score}/100 · ${latest.issues.length} issues (${blockers} blocking) · ${text} chars` +
        `${gutted ? ' · CONTENT COLLAPSED' : ''}${latest.error ? ` · ${latest.error}` : ''}`,
    );

    if (gutted) {
      log(`  reverting: this round destroyed content; keeping round ${bestRound}.`);
      break;
    }

    if (latest.score > bestScore) {
      bestScore = latest.score;
      bestRound = round;
      bestCritique = latest;
      snapshot();
    } else if (round > 0) {
      // Two models disagreeing round to round is noise; a score that will not
      // climb is a signal. Spending more rounds on it only risks the page.
      log(`  plateau  : round ${round} (${latest.score}) did not beat round ${bestRound} (${bestScore}). Stopping.`);
      break;
    }

    if (latest.pass) {
      log(`\n  passed on round ${round}`);
      return { url, rounds: round, final: latest, history };
    }
  }

  // Republish the winner if the last thing uploaded was not it.
  if (bestRound >= 0 && bestRound !== history[history.length - 1]?.round) {
    log(`\n  restoring round ${bestRound} (${bestScore}/100) and republishing`);
    fs.rmSync(path.join(opts.workDir, '.shots'), { recursive: true, force: true });
    fs.cpSync(bestDir, opts.workDir, { recursive: true });
    const app = await publish(opts.workDir, { slug: opts.slug, name: opts.name, tags: opts.tags });
    url = app.url;
    latest = bestCritique;
  }

  log(`\n  delivered round ${bestRound} at ${bestScore}/100`);
  return { url, rounds: history.length - 1, final: latest, history };
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const envFile = path.join(repoRoot, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile?.(envFile);

  const argv = process.argv.slice(2);
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) flags[a.slice(2)] = argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[++i]! : 'true';
    else rest.push(a);
  }

  const brief = rest.join(' ');
  if (!brief) {
    console.log(`
  npx tsx src/design/freelance.ts [options] "the brief"

    --slug <slug>     Published at /app/<slug>/   (default: derived from the brief)
    --name <name>     Display name in the app directory
    --tags <a,b>      Comma-separated; "sales-app" routes it to the Sales Agent
    --profile <id>    Builder connection            (default: kimi)
    --rounds <n>      Review-and-revise rounds      (default: 2)
    --workdir <dir>   Where to build                (default: .design/<slug>)
`);
    process.exitCode = 1;
    return;
  }

  const slug = flags.slug ? toSlug(flags.slug) : toSlug(brief.split(/\s+/).slice(0, 6).join(' '));
  const workDir = path.resolve(flags.workdir || path.join(repoRoot, '.design', slug));

  const result = await freelance({
    brief,
    workDir,
    slug,
    name: flags.name,
    tags: flags.tags ? flags.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
    profile: flags.profile,
    rounds: flags.rounds ? Number(flags.rounds) : undefined,
  });

  console.log(`\n  live: ${result.url}`);
  console.log(`  score history: ${result.history.map((h) => `r${h.round}=${h.score}`).join(' → ')}\n`);
}

if (process.argv[1]?.endsWith('freelance.ts') || process.argv[1]?.endsWith('freelance.js')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
