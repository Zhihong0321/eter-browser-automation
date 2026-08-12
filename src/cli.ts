#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { DAEMON_PORT, DAEMON_URL, PKG_ROOT, resolveVaultHome } from './config.js';
import path from 'node:path';

// Optional local secrets. Absent .env is the normal case — the engine and the
// scanner both work without it; only the fast worker needs one.
try {
  process.loadEnvFile(path.join(PKG_ROOT, '.env'));
} catch {
  /* no .env — fine */
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function daemon(method: string, path: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${DAEMON_URL}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    console.error(`Eter Browser daemon is not running.\nStart it with:  eter-browser ui`);
    process.exit(1);
  }
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    console.error(`Error: ${data.error ?? res.statusText}`);
    process.exit(1);
  }
  return data;
}

async function cmdUi(): Promise<void> {
  const home = resolveVaultHome(flag('home'));
  const port = Number(flag('port') ?? DAEMON_PORT);

  const { VaultService } = await import('./service.js');
  const { startServer } = await import('./api.js');

  const svc = new VaultService(home);
  await startServer(svc, port);
  svc.startHealthLoop();

  const url = `http://127.0.0.1:${port}`;
  console.log(`\n  Eter Browser`);
  console.log(`  dashboard : ${url}`);
  console.log(`  vault     : ${home}`);
  console.log(`  profile   : ${svc.vault.profileDir()}`);
  console.log(`\n  Leave this running. Add the MCP server to your agent with:`);
  console.log(`  {"mcpServers":{"eter-browser":{"command":"npx","args":["-y","eter-browser","mcp"]}}}\n`);

  if (!process.argv.includes('--no-open')) {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }

  const bye = async () => {
    console.log('\n  shutting down…');
    await svc.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void bye());
  process.on('SIGTERM', () => void bye());
}

async function cmdStatus(): Promise<void> {
  const s = (await daemon('GET', '/api/status')) as {
    vaultHome: string;
    browser: { state: string };
    sessions: { label: string; status: string; account?: string; ageMinutes: number | null; statusDetail?: string }[];
  };
  console.log(`\n  vault   : ${s.vaultHome}`);
  console.log(`  browser : ${s.browser.state}\n`);
  if (!s.sessions.length) {
    console.log('  No sessions yet.  eter-browser login facebook\n');
    return;
  }
  for (const x of s.sessions) {
    const age = x.ageMinutes === null ? 'never checked' : `${x.ageMinutes}m ago`;
    console.log(`  ${x.status.toUpperCase().padEnd(11)} ${x.label.padEnd(14)} ${x.account ?? ''}  (${age})`);
    if (x.statusDetail) console.log(`  ${''.padEnd(11)} ${x.statusDetail}`);
  }
  console.log('');
}

async function cmdLogin(site: string): Promise<void> {
  const r = (await daemon('POST', `/api/sessions/${site}/login`)) as { message: string };
  console.log(`\n  ${r.message}`);
  console.log(`  Then run:  eter-browser check ${site}\n`);
}

async function cmdCheck(site?: string): Promise<void> {
  if (site) {
    const r = (await daemon('POST', `/api/sessions/${site}/check`, { deep: true })) as {
      status: string;
      statusDetail?: string;
      account?: string;
    };
    console.log(`\n  ${site}: ${r.status}${r.account ? ` (${r.account})` : ''}`);
    if (r.statusDetail) console.log(`  ${r.statusDetail}\n`);
    return;
  }
  await daemon('POST', '/api/check-all', { deep: true });
  await cmdStatus();
}

async function cmdRecon(): Promise<void> {
  const sub = process.argv[3];
  const url = process.argv[4];
  if ((sub !== 'probe' && sub !== 'scan') || !url) {
    console.error('  Usage: eter-browser recon probe <url> [--window 8000] [--json]');
    console.error('         eter-browser recon scan  <url> [--max-pages 40] [--window 8000] [--approve "A,B"] [--json]');
    process.exit(1);
  }
  const windowMs = Number(flag('window') ?? 8000);

  if (sub === 'probe') {
    const r = (await daemon('POST', '/api/recon/probe', { url, windowMs })) as Record<string, unknown>;
    const { formatVerdict } = await import('./recon.js');
    console.log('\n' + formatVerdict(r.trace as never, r.verdict as never) + '\n');
    if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
    return;
  }

  const maxPages = Number(flag('max-pages') ?? 40);
  const approved = (flag('approve') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  console.log(`\n  scanning ${url} … (one launch, up to ${maxPages} routes — this takes a few minutes)`);
  if (approved.length) console.log(`  approved for exploration: ${approved.join(', ')}`);
  const scan = (await daemon('POST', '/api/recon/scan', { url, windowMs, maxPages, approved })) as Record<string, unknown>;
  const { formatScan } = await import('./recon-scan.js');
  console.log(formatScan(scan as never));
  console.log('');
  if (process.argv.includes('--json')) console.log(JSON.stringify(scan, null, 2));
}

async function cmdFastWorker(): Promise<void> {
  const { fastAsk, fastWorkerConfig } = await import('./fastworker.js');
  const cfg = fastWorkerConfig();
  if (!cfg) {
    console.error('  Fast worker not configured. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }
  const question = process.argv.slice(3).join(' ').trim();
  console.log(`\n  model : ${cfg.model}\n  base  : ${cfg.baseUrl}`);
  if (!question) {
    console.log('  status: configured. Pass a question to test it.\n');
    return;
  }
  const a = await fastAsk(question);
  console.log(`  took  : ${a.ms}ms · ${a.outputTokens} out tokens · ${a.reasoningChars} reasoning chars`);
  console.log(`\n${a.text}\n`);
}

const HELP = `
  eter-browser — share your real browser login sessions with AI agents

  eter-browser ui [--port 7676] [--home DIR] [--no-open]
      Start the daemon + dashboard. This owns the agent Chrome. Keep it running.

  eter-browser mcp
      Run the MCP server on stdio. Point your AI agent at this.

  eter-browser login <site>     Open the agent Chrome to sign in  (facebook|instagram|x|linkedin)
  eter-browser check [site]     Re-verify one or all sessions
  eter-browser status           Print session status

  eter-browser recon probe <url> [--window 8000] [--json]
      Watch one page settle and report what to wait on (and what lies).

  eter-browser fastworker [question]
      Show fast-worker config, or ask it something to check it works.
      Optional — the scanner uses no model at all.
`;

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'ui':
      return cmdUi();
    case 'mcp': {
      const { runMcpServer } = await import('./mcp.js');
      return runMcpServer();
    }
    case 'status':
      return cmdStatus();
    case 'login':
      if (!process.argv[3]) {
        console.error('  Usage: eter-browser login <facebook|instagram|x|linkedin>');
        process.exit(1);
      }
      return cmdLogin(process.argv[3]);
    case 'check':
      return cmdCheck(process.argv[3]);
    case 'recon':
      return cmdRecon();
    case 'fastworker':
      return cmdFastWorker();
    default:
      console.log(HELP);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
