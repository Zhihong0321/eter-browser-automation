/**
 * Live end-to-end check for one connection profile.
 *
 * Everything else about the agent is covered offline by
 * test/agent.profiles.test.ts. This is the part that cannot be faked: does the
 * host actually answer, does it speak the Anthropic wire format, and does a
 * tool-using role really write a file on disk.
 *
 *   npx tsx scripts/agent-smoke.ts             # default profile
 *   npx tsx scripts/agent-smoke.ts kimi
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assistantText, connProfile, runAgent, DEFAULT_PROFILE } from '../src/agent.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(REPO_ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile?.(envFile);

/**
 * A misconfigured profile is the expected first run, not a crash. Without this
 * the operator's introduction to a new provider is a Node stack trace.
 */
let profile;
try {
  profile = connProfile(process.argv[2] || DEFAULT_PROFILE);
} catch (error) {
  console.error(`\n  ${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
}

let failed = 0;

function report(name: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  if (!ok) failed++;
}

/** Drain a query, returning the assistant text and the terminating result. */
async function drain(run: ReturnType<typeof runAgent>) {
  let text = '';
  let result: { subtype: string; duration_ms: number } | undefined;
  for await (const message of run) {
    text += assistantText(message);
    if (message.type === 'result') result = message;
  }
  return { text, result };
}

console.log(`\n  ${profile.id} · ${profile.model} · ${profile.baseUrl}\n`);

// 1. The wire format works and the credentials are accepted.
const plain = await drain(runAgent('Reply with exactly: PONG', { profile }));
report(
  'plain role round-trips',
  plain.result?.subtype === 'success' && /PONG/i.test(plain.text),
  `${plain.result?.subtype ?? 'no result'} · ${plain.result?.duration_ms ?? 0}ms · answered ${JSON.stringify(plain.text.trim().slice(0, 40))}`,
);

// 2. The frontend role's tools, permission mode and system prompt all hold
//    together well enough to produce a real file. A model that only TALKS about
//    writing the file fails here, which is the point.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-smoke-'));
const frontend = await drain(
  runAgent(
    'Create index.html in the current directory containing a single accessible button labelled Save. Then stop.',
    { profile, role: 'frontend', overrides: { cwd: dir } },
  ),
);
const written = path.join(dir, 'index.html');
const html = fs.existsSync(written) ? fs.readFileSync(written, 'utf8') : '';
report(
  'frontend role writes a real file with tools',
  frontend.result?.subtype === 'success' && /<button/i.test(html) && /save/i.test(html),
  html ? `${html.length} bytes at ${written}` : `no file written (${frontend.result?.subtype ?? 'no result'})`,
);
fs.rmSync(dir, { recursive: true, force: true });

console.log(failed ? `\n  ${failed} check(s) failed\n` : '\n  all checks passed\n');
process.exit(failed ? 1 : 0);
