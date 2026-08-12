/**
 * Claude Agent SDK pointed at StepFun's Anthropic-compatible Messages endpoint.
 *
 * StepFun serves POST /v1/messages in the Anthropic wire format, so the Agent
 * SDK needs no shim — only the base URL, the auth token and the model IDs move.
 * Everything comes from the environment; .env is gitignored.
 *
 *   npx tsx src/agent.ts "your prompt"
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * StepFun's Anthropic-protocol host. The SDK appends /v1/messages itself.
 * `||`, not `??`: an env var set to "" must fall back. An empty base URL makes
 * the SDK default to api.anthropic.com and ship the StepFun key to Anthropic.
 */
const BASE_URL = process.env.STEPFUN_BASE_URL?.trim() || 'https://api.stepfun.ai/step_plan';
const MODEL = process.env.STEPFUN_MODEL?.trim() || 'step-3.7-flash';

/** Repo root: this file sits one level down, in src/ or dist/. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A repo-local Claude home, so a run is identical on every machine.
 *
 * Without this the CLI defaults to ~/.claude on the operator's box and pulls in
 * their CLAUDE.md, their auto-memory (~/.claude/projects/<slug>/memory), their
 * settings and their stored credentials — all of it injected into the prompt
 * and shipped to StepFun. `settingSources: []` does NOT prevent that: it gates
 * settings.json files only, not memory or CLAUDE.md.
 */
export const AGENT_HOME = path.resolve(
  process.env.AGENT_HOME?.trim() || path.join(REPO_ROOT, '.agent-home'),
);

/**
 * Anything Anthropic- or Claude-Code-owned is stripped from the child's
 * environment. This matters most when the SDK is launched from inside a Claude
 * Code session: the host exports CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH and
 * CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH, which make the spawned CLI request a token
 * from the host and ignore ANTHROPIC_AUTH_TOKEN entirely — the run then
 * authenticates against StepFun with an Anthropic OAuth token and 401s.
 * ANTHROPIC_DEFAULT_*_MODEL would likewise override the model.
 * Keep the git-bash path: it is platform config, not auth.
 */
const INHERITED_TO_DROP = /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDECODE|CLAUDE_PID)/;
const KEEP = new Set(['CLAUDE_CODE_GIT_BASH_PATH']);

/**
 * Environment for the SDK subprocess. Scoped to the child so a StepFun key
 * never lands in this process's own environment.
 */
export function stepfunEnv(): Record<string, string | undefined> {
  const key = process.env.STEPFUN_API_KEY?.trim();
  if (!key) {
    throw new Error('STEPFUN_API_KEY is not set — add it to .env (gitignored).');
  }

  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!INHERITED_TO_DROP.test(name) || KEEP.has(name)) env[name] = value;
  }

  fs.mkdirSync(AGENT_HOME, { recursive: true });

  return {
    ...env,
    // Portability: read config from this repo, never the operator's machine.
    CLAUDE_CONFIG_DIR: AGENT_HOME,
    // No usage pings, crash reports or self-updates from a shipped repo.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    ANTHROPIC_BASE_URL: BASE_URL,
    ANTHROPIC_AUTH_TOKEN: key,
    // Background work (titles, summaries, compaction) defaults to a Haiku model
    // StepFun does not serve, so every tier points at the same model.
    ANTHROPIC_MODEL: MODEL,
    ANTHROPIC_SMALL_FAST_MODEL: MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
  };
}

/** Run one Agent SDK query against step-3.7-flash. */
export function stepfunAgent(prompt: string, overrides: Partial<Options> = {}) {
  return query({
    prompt,
    options: {
      model: MODEL,
      env: stepfunEnv(),
      // Ignore ~/.claude and .claude/ so no Anthropic credentials or unrelated
      // CLAUDE.md instructions leak into a StepFun run.
      settingSources: [],
      // No built-in tools unless a caller opts in: `allowedTools` only gates
      // permission to call them, it still ships all 26 definitions (~46KB, and
      // Workflow alone is 19KB) on every request. Pass e.g. tools: ['Read'].
      tools: [],
      ...overrides,
    },
  });
}

/** Text of every assistant turn, in order. */
export function assistantText(message: SDKMessage): string {
  if (message.type !== 'assistant') return '';
  return message.message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
}

async function main(): Promise<void> {
  // Anchored to the repo, not the caller's cwd, so the CLI works from anywhere.
  const envFile = path.join(REPO_ROOT, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile?.(envFile);

  const prompt = process.argv.slice(2).join(' ') || 'Reply with exactly: OK';
  console.log(`[stepfun] ${MODEL} via ${BASE_URL}`);
  console.log(`[stepfun] claude home: ${AGENT_HOME}`);

  for await (const message of stepfunAgent(prompt)) {
    if (message.type === 'assistant') {
      const text = assistantText(message);
      if (text) console.log(text);
    } else if (message.type === 'result') {
      console.log(
        `[stepfun] ${message.subtype} · ${message.duration_ms}ms · ` +
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
