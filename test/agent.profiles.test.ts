import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import path from 'node:path';
import { agentEnv, connProfile, profileHome, PROFILE_IDS, AGENT_HOME } from '../src/agent.js';
import { resolveRole, ROLE_IDS } from '../src/roles.js';

/**
 * Run `fn` with an exact environment, then put the real one back. Every test
 * here reads process.env, so leaking a variable between them would make results
 * depend on ordering.
 */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
    saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('every known profile is selectable and falls back to its documented default', () => {
  assert.deepEqual(PROFILE_IDS, ['stepfun', 'kimi']);

  const kimi = withEnv(
    { KIMI_API_KEY: 'k-test', KIMI_BASE_URL: undefined, KIMI_MODEL: undefined },
    () => connProfile('kimi'),
  );
  assert.equal(kimi.baseUrl, 'https://api2.cmkey.cn');
  assert.equal(kimi.model, 'kimi-k3');
  assert.equal(kimi.apiKey, 'k-test');
});

test('env overrides the default base URL and model', () => {
  const p = withEnv(
    { KIMI_API_KEY: 'k-test', KIMI_BASE_URL: 'https://elsewhere.test/anthropic', KIMI_MODEL: 'kimi-k3-turbo' },
    () => connProfile('kimi'),
  );
  assert.equal(p.baseUrl, 'https://elsewhere.test/anthropic');
  assert.equal(p.model, 'kimi-k3-turbo');
});

test('an empty base URL falls back instead of defaulting the SDK to Anthropic', () => {
  // `??` here instead of `||` would leave ANTHROPIC_BASE_URL empty, and the SDK
  // would post a third-party key to api.anthropic.com.
  const p = withEnv({ KIMI_API_KEY: 'k-test', KIMI_BASE_URL: '', KIMI_MODEL: '' }, () => connProfile('kimi'));
  assert.equal(p.baseUrl, 'https://api2.cmkey.cn');
  assert.equal(p.model, 'kimi-k3');
});

test('a missing key is a named error, not a silent unauthenticated run', () => {
  assert.throws(
    () => withEnv({ KIMI_API_KEY: undefined }, () => connProfile('kimi')),
    /KIMI_API_KEY is not set/,
  );
});

test('an unknown profile names the ones that exist', () => {
  assert.throws(() => connProfile('gpt5'), /Unknown connection profile "gpt5".*stepfun, kimi/s);
});

test('profiles never share a Claude home', () => {
  assert.notEqual(profileHome('stepfun'), profileHome('kimi'));
  assert.equal(profileHome('kimi'), path.join(AGENT_HOME, 'kimi'));
});

test('host Claude Code and Anthropic variables are stripped from the child env', () => {
  // The failure this prevents: launched from inside a Claude Code session, the
  // child asks the host for an OAuth token, ignores ANTHROPIC_AUTH_TOKEN, and
  // 401s against the third-party host.
  const env = withEnv(
    {
      KIMI_API_KEY: 'k-test',
      ANTHROPIC_API_KEY: 'leaked-anthropic-key',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5',
      CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1',
      CLAUDECODE: '1',
      CLAUDE_CODE_GIT_BASH_PATH: 'C:/git/bash.exe',
    },
    () => agentEnv(connProfile('kimi')),
  );

  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH, undefined);
  assert.equal(env.CLAUDECODE, undefined);
  // Platform config, not auth — it must survive.
  assert.equal(env.CLAUDE_CODE_GIT_BASH_PATH, 'C:/git/bash.exe');
  // The host's model override must not win over the profile's.
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'kimi-k3');
});

test('the child env carries the profile, and every model tier points at it', () => {
  const env = withEnv({ KIMI_API_KEY: 'k-test' }, () => agentEnv(connProfile('kimi')));

  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api2.cmkey.cn');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'k-test');
  assert.equal(env.CLAUDE_CONFIG_DIR, profileHome('kimi'));
  // Background work (titles, compaction) would otherwise ask for a Haiku the
  // provider does not serve.
  for (const tier of [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
  ]) {
    assert.equal(env[tier], 'kimi-k3', tier);
  }
  // PATH must survive: the SDK REPLACES the child environment, it does not merge.
  assert.ok(env.PATH ?? env.Path);
});

test('a provider key never lands in this process environment', () => {
  // Asserting these are absent would be wrong: a Claude Code host exports
  // ANTHROPIC_BASE_URL into the parent already. What matters is that agentEnv
  // builds a scoped object and mutates nothing — the child gets the profile,
  // this process keeps whatever it started with.
  const before = JSON.stringify(process.env);
  withEnv({ KIMI_API_KEY: 'k-test' }, () => agentEnv(connProfile('kimi')));
  assert.equal(JSON.stringify(process.env), before);
  assert.notEqual(process.env.ANTHROPIC_AUTH_TOKEN, 'k-test');
});

test('an ambient host ANTHROPIC_BASE_URL cannot outrank the profile', () => {
  // Measured: running inside Claude Code, the parent carries
  // ANTHROPIC_BASE_URL=https://api.anthropic.com. Inherited unchanged, every
  // request would go to Anthropic carrying a third-party key.
  const env = withEnv(
    { KIMI_API_KEY: 'k-test', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
    () => agentEnv(connProfile('kimi')),
  );
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api2.cmkey.cn');
});

test('two profiles resolved together stay independent', () => {
  const [a, b] = withEnv({ STEPFUN_API_KEY: 's-test', KIMI_API_KEY: 'k-test' }, () => [
    agentEnv(connProfile('stepfun')),
    agentEnv(connProfile('kimi')),
  ]);
  assert.equal(a.ANTHROPIC_AUTH_TOKEN, 's-test');
  assert.equal(b.ANTHROPIC_AUTH_TOKEN, 'k-test');
  assert.notEqual(a.ANTHROPIC_BASE_URL, b.ANTHROPIC_BASE_URL);
  assert.notEqual(a.CLAUDE_CONFIG_DIR, b.CLAUDE_CONFIG_DIR);
});

test('the default role keeps the no-tools behaviour enrich/agy.ts depends on', () => {
  assert.deepEqual(ROLE_IDS, ['plain', 'frontend', 'designer']);
  // Empty options, so runAgent's own cautious defaults (tools: [], no settings)
  // apply unchanged.
  assert.deepEqual(resolveRole().options, {});
  assert.equal(resolveRole().id, 'plain');
});

test('the frontend role opts into every tool and answers its own permission prompts', () => {
  const { options } = resolveRole('frontend');
  assert.deepEqual(options.tools, { type: 'preset', preset: 'claude_code' });
  assert.equal(options.permissionMode, 'bypassPermissions');
  // The SDK rejects bypassPermissions without this acknowledgement.
  assert.equal(options.allowDangerouslySkipPermissions, true);
  // Appended, not replaced: a bare string drops the harness's tool guidance.
  assert.equal((options.systemPrompt as { preset?: string }).preset, 'claude_code');
  assert.match((options.systemPrompt as { append: string }).append, /frontend web development specialist/i);
});

test('an unknown role names the ones that exist', () => {
  assert.throws(() => resolveRole('backend'), /Unknown role "backend".*plain, frontend, designer/s);
});
