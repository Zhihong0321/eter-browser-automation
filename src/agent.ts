/**
 * Claude Agent SDK pointed at any Anthropic-compatible Messages endpoint.
 *
 * Two independent axes, deliberately kept separate:
 *
 *   CONNECTION (this file)  — where the tokens come from: base URL, key, model.
 *   ROLE       (roles.ts)   — what the agent is: system prompt, tools, cwd.
 *
 * Any role runs on any connection. Both are resolved from the environment;
 * .env is gitignored.
 *
 *   npx tsx src/agent.ts --profile kimi --role frontend "build me a nav bar"
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ROLE_IDS, resolveRole, type Role } from './roles.js';

/** Repo root: this file sits one level down, in src/ or dist/. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A model endpoint. Everything the SDK needs to reach one provider. */
export interface ConnProfile {
  id: string;
  /** Anthropic-protocol host. The SDK appends /v1/messages itself. */
  baseUrl: string;
  model: string;
  apiKey: string;
}

/**
 * Known providers and their fallbacks. Each reads <ID>_API_KEY, <ID>_BASE_URL
 * and <ID>_MODEL from the environment; only the key is mandatory.
 *
 * Every entry MUST serve the Anthropic wire format (POST /v1/messages). An
 * OpenAI-compatible endpoint does not belong here — that surface is
 * src/fastworker.ts, and pointing the SDK at one produces a 404 on the first
 * call, not a graceful degrade.
 */
const PROFILE_DEFAULTS: Record<string, { baseUrl: string; model: string }> = {
  stepfun: { baseUrl: 'https://api.stepfun.ai/step_plan', model: 'step-3.7-flash' },
  // Measured 2026-08-17 against the key in D:/tools/my-vault: this proxy serves
  // both the OpenAI and the Anthropic surface, and exposes exactly one model.
  // No trailing /v1 — the vault records the OpenAI base URL, but the SDK
  // appends /v1/messages itself and would otherwise post to /v1/v1/messages.
  kimi: { baseUrl: 'https://api2.cmkey.cn', model: 'kimi-k3' },
};

export const PROFILE_IDS = Object.keys(PROFILE_DEFAULTS);
export const DEFAULT_PROFILE = 'stepfun';

/**
 * Resolve one connection from the environment.
 *
 * A FUNCTION, never a module-level const. `main()` calls
 * `process.loadEnvFile('.env')` in its body, but ESM evaluates every import
 * first — so a const captures the environment as it was BEFORE .env loaded,
 * which is empty. That is exactly how the classifier in config.ts silently ran
 * unconfigured for a whole live sweep (see the note at config.ts:44).
 *
 * `||`, not `??`: an env var set to "" must fall back. An empty base URL makes
 * the SDK default to api.anthropic.com and ship a third-party key to Anthropic.
 */
export function connProfile(id: string = DEFAULT_PROFILE): ConnProfile {
  const defaults = PROFILE_DEFAULTS[id];
  if (!defaults) {
    throw new Error(`Unknown connection profile "${id}". Known: ${PROFILE_IDS.join(', ')}`);
  }

  const prefix = id.toUpperCase();
  const apiKey = process.env[`${prefix}_API_KEY`]?.trim();
  if (!apiKey) {
    throw new Error(`${prefix}_API_KEY is not set — add it to .env (gitignored, see .env.example).`);
  }

  return {
    id,
    baseUrl: process.env[`${prefix}_BASE_URL`]?.trim() || defaults.baseUrl,
    model: process.env[`${prefix}_MODEL`]?.trim() || defaults.model,
    apiKey,
  };
}

/** Root of the repo-local Claude homes. Each profile gets its own subdirectory. */
export const AGENT_HOME = path.resolve(
  process.env.AGENT_HOME?.trim() || path.join(REPO_ROOT, '.agent-home'),
);

/**
 * A repo-local Claude home, so a run is identical on every machine.
 *
 * Without this the CLI defaults to ~/.claude on the operator's box and pulls in
 * their CLAUDE.md, their auto-memory (~/.claude/projects/<slug>/memory), their
 * settings and their stored credentials — all of it injected into the prompt
 * and shipped to a third-party provider. `settingSources: []` does NOT prevent
 * that: it gates settings.json files only, not memory or CLAUDE.md.
 *
 * Split per profile so two providers never share session state or history.
 */
export function profileHome(id: string): string {
  return path.join(AGENT_HOME, id);
}

/**
 * Anything Anthropic- or Claude-Code-owned is stripped from the child's
 * environment. This matters most when the SDK is launched from inside a Claude
 * Code session: the host exports CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH and
 * CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH, which make the spawned CLI request a token
 * from the host and ignore ANTHROPIC_AUTH_TOKEN entirely — the run then
 * authenticates against the third-party host with an Anthropic OAuth token and
 * 401s. ANTHROPIC_DEFAULT_*_MODEL would likewise override the model.
 * Keep the git-bash path: it is platform config, not auth.
 *
 * Unconditional, for every profile. It is not a StepFun quirk.
 */
const INHERITED_TO_DROP = /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDECODE|CLAUDE_PID)/;
const KEEP = new Set(['CLAUDE_CODE_GIT_BASH_PATH']);

/**
 * Environment for the SDK subprocess. Scoped to the child so a provider key
 * never lands in this process's own environment.
 *
 * The SDK REPLACES the subprocess environment with whatever `env` holds — it
 * does not merge — so process.env is spread in here deliberately, for PATH.
 */
export function agentEnv(profile: ConnProfile): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!INHERITED_TO_DROP.test(name) || KEEP.has(name)) env[name] = value;
  }

  const home = profileHome(profile.id);
  fs.mkdirSync(home, { recursive: true });

  return {
    ...env,
    // Portability: read config from this repo, never the operator's machine.
    CLAUDE_CONFIG_DIR: home,
    // No usage pings, crash reports or self-updates from a shipped repo.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    ANTHROPIC_BASE_URL: profile.baseUrl,
    ANTHROPIC_AUTH_TOKEN: profile.apiKey,
    // Background work (titles, summaries, compaction) defaults to a Haiku model
    // no third-party host serves, so every tier points at the same model.
    ANTHROPIC_MODEL: profile.model,
    ANTHROPIC_SMALL_FAST_MODEL: profile.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: profile.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: profile.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: profile.model,
  };
}

/**
 * Run one query: a role, on a connection.
 *
 * The defaults here are the cautious ones — no tools, no settings files. A role
 * that needs more says so in its own `options`, and an explicit `overrides`
 * argument beats both.
 */
export function runAgent(
  prompt: string,
  opts: { profile?: ConnProfile | string; role?: Role | string; overrides?: Partial<Options> } = {},
) {
  const profile = typeof opts.profile === 'object' ? opts.profile : connProfile(opts.profile);
  const role = typeof opts.role === 'object' ? opts.role : resolveRole(opts.role);

  return query({
    prompt,
    options: {
      model: profile.model,
      env: agentEnv(profile),
      // Ignore ~/.claude and .claude/ so no Anthropic credentials or unrelated
      // CLAUDE.md instructions leak into a third-party run. A role that wants
      // project conventions sets settingSources: ['project'] and accepts that
      // its CLAUDE.md is sent to whichever provider the profile points at.
      settingSources: [],
      // No built-in tools unless a caller opts in: `allowedTools` only gates
      // permission to call them, it still ships all 26 definitions (~46KB, and
      // Workflow alone is 19KB) on every request. Pass e.g. tools: ['Read'],
      // or { type: 'preset', preset: 'claude_code' } for the full set.
      tools: [],
      ...role.options,
      ...opts.overrides,
    },
  });
}

/** Back-compat: the original single-provider entry point. Used by enrich/agy.ts. */
export function stepfunAgent(prompt: string, overrides: Partial<Options> = {}) {
  return runAgent(prompt, { profile: 'stepfun', overrides });
}

/** Text of every assistant turn, in order. */
export function assistantText(message: SDKMessage): string {
  if (message.type !== 'assistant') return '';
  return message.message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
}

/** `--flag value` out of argv, and the leftover words that form the prompt. */
function parseArgs(argv: string[]): { flags: Record<string, string>; rest: string[] } {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      flags[arg.slice(2)] = argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[++i]! : 'true';
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

async function main(): Promise<void> {
  // Anchored to the repo, not the caller's cwd, so the CLI works from anywhere.
  const envFile = path.join(REPO_ROOT, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile?.(envFile);

  const { flags, rest } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(`
  npx tsx src/agent.ts [options] "prompt"

    --profile <id>   Connection to run on: ${PROFILE_IDS.join(' | ')}   (default: ${DEFAULT_PROFILE})
    --role <id>      Who the agent is: ${ROLE_IDS.join(' | ')}
    --cwd <dir>      Working directory for a role with file tools
`);
    return;
  }

  const profile = connProfile(flags.profile);
  const role = resolveRole(flags.role);
  const overrides: Partial<Options> = flags.cwd ? { cwd: path.resolve(flags.cwd) } : {};

  const prompt = rest.join(' ') || 'Reply with exactly: OK';
  console.log(`[${profile.id}] ${profile.model} via ${profile.baseUrl}`);
  console.log(`[${profile.id}] role: ${role.id} · claude home: ${profileHome(profile.id)}`);

  for await (const message of runAgent(prompt, { profile, role, overrides })) {
    if (message.type === 'assistant') {
      const text = assistantText(message);
      if (text) console.log(text);
    } else if (message.type === 'result') {
      console.log(
        `[${profile.id}] ${message.subtype} · ${message.duration_ms}ms · ` +
          `${message.usage?.input_tokens ?? 0} in / ${message.usage?.output_tokens ?? 0} out`,
      );
      if (message.subtype !== 'success') process.exitCode = 1;
    }
  }
}

if (process.argv[1]?.endsWith('agent.ts') || process.argv[1]?.endsWith('agent.js')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
