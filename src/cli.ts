#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { DAEMON_PORT, DAEMON_URL, resolveVaultHome } from './config.js';

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

const HELP = `
  eter-browser — share your real browser login sessions with AI agents

  eter-browser ui [--port 7676] [--home DIR] [--no-open]
      Start the daemon + dashboard. This owns the agent Chrome. Keep it running.

  eter-browser mcp
      Run the MCP server on stdio. Point your AI agent at this.

  eter-browser login <site>     Open the agent Chrome to sign in  (facebook|instagram|x|linkedin)
  eter-browser check [site]     Re-verify one or all sessions
  eter-browser status           Print session status
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
    default:
      console.log(HELP);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
