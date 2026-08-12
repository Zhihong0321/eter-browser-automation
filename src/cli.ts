#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { DAEMON_PORT, DAEMON_URL, PKG_ROOT, resolveVaultHome } from './config.js';
import path from 'node:path';
import type { FbReconResult } from './service.js';
import type { ProjectFile } from './fb-recon/project.js';

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

/**
 * Chrome profiles. One profile is one Chrome, one set of logins, and one
 * failure domain: a job in its own profile cannot be killed by another job's
 * browser. There is no limit on how many exist.
 */
async function cmdProfiles(): Promise<void> {
  const sub = process.argv[3];

  if (sub === 'create') {
    const id = process.argv[4];
    if (!id) {
      console.error('  Usage: eter-browser profiles create <id> [label]');
      process.exit(1);
    }
    const r = (await daemon('POST', '/api/profiles', { id, label: process.argv[5] })) as {
      id: string; label: string; dir: string; initialized: boolean;
    };
    console.log(`\n  created : ${r.id}  (${r.label})`);
    console.log(`  dir     : ${r.dir}`);
    console.log(`\n  Now sign in inside it:  eter-browser login facebook --profile ${r.id}\n`);
    return;
  }

  const { profiles } = (await daemon('GET', '/api/profiles')) as {
    profiles: { id: string; label: string; browser: string; initialized: boolean;
      sessions: { id: string; status: string }[] }[];
  };
  console.log('');
  for (const p of profiles) {
    const sessions = p.sessions.map((s) => `${s.id}:${s.status}`).join(', ') || 'no sessions';
    console.log(`  ${p.id.padEnd(14)} ${p.browser.padEnd(9)} ${p.initialized ? 'ready ' : 'unused'}  ${sessions}`);
  }
  console.log('');
}

async function cmdStatus(): Promise<void> {
  const profile = flag('profile');
  const s = (await daemon('GET', profile ? `/api/status/${profile}` : '/api/status')) as {
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

/** "facebook" -> the preset URL; anything else is treated as the URL itself. */
function siteUrl(site: string): string {
  const presets: Record<string, string> = {
    facebook: 'https://www.facebook.com/',
    whatsapp: 'https://web.whatsapp.com/',
    instagram: 'https://www.instagram.com/',
    x: 'https://x.com/home',
    twitter: 'https://x.com/home',
    linkedin: 'https://www.linkedin.com/feed/',
    gmail: 'https://mail.google.com/',
    youtube: 'https://www.youtube.com/',
  };
  return presets[site.toLowerCase()] ?? site;
}

/**
 * Adds the session if the profile does not have it yet, then opens its login
 * page. Add-or-open rather than open-only, because a fresh profile has no
 * sessions at all — that is the whole point of making one.
 */
async function cmdLogin(site: string): Promise<void> {
  const profile = flag('profile');
  const r = (await daemon('POST', '/api/sessions', { url: siteUrl(site), profile })) as {
    message: string;
    session: { id: string };
  };
  console.log(`\n  ${r.message}`);
  console.log(`  Then run:  eter-browser check ${r.session.id}${profile ? ` --profile ${profile}` : ''}\n`);
}

async function cmdCheck(site?: string): Promise<void> {
  const profile = flag('profile');
  if (site && !site.startsWith('--')) {
    const r = (await daemon('POST', `/api/sessions/${site}/check`, { deep: true, profile })) as {
      status: string;
      statusDetail?: string;
      account?: string;
    };
    console.log(`\n  ${site}: ${r.status}${r.account ? ` (${r.account})` : ''}`);
    if (r.statusDetail) console.log(`  ${r.statusDetail}\n`);
    return;
  }
  await daemon('POST', '/api/check-all', { deep: true, profile });
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

/** eter-browser fb-recon --topic solar [--source group:<url>] [--source search] [--min-score 3] [--json] */
async function cmdFbRecon(): Promise<void> {
  const argv = process.argv.slice(3);
  const localFlag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const sources = argv.reduce<string[]>((acc, a, i) => (a === '--source' && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);

  const topic = localFlag('topic');
  if (!topic) {
    console.error('  Usage: eter-browser fb-recon --topic <topic> [--source group:<url>] [--source search] [--min-score 3] [--json]');
    process.exit(1);
  }

  const minScoreRaw = localFlag('min-score');
  const data = await daemon('POST', '/api/fb/recon', {
    topic,
    sources,
    minScore: minScoreRaw ? Number(minScoreRaw) : undefined,
    profile: localFlag('profile'),
  });

  if (argv.includes('--json')) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const started = data as FbReconResult;
  console.log(`\n  project:    ${started.projectId}`);
  console.log(`  report:     ${started.reportHtml}  (refreshes itself while running)\n`);

  // The sweep runs in the daemon; this polls the project file it writes live.
  // A blocking request would be simpler and wrong — every fetch client aborts at
  // 300s, and a sweep routinely runs longer than that.
  const r = await pollProject(started.projectId);
  const c = r.counters;
  console.log(`\n  status:     ${r.status}`);
  console.log(`  topic:      ${r.topic}`);
  console.log(`  scanned:    ${c.scanned} posts`);
  console.log(`  gated:      ${c.gated} passed the keyword gate`);
  console.log(`  opened:     ${c.opened} threads, ${c.commentsRead} comments read`);
  console.log(`  contacts:   ${c.totalContacts} (${c.newContacts} new, ${c.knownContacts} seen in earlier projects)`);
  for (const [src, n] of Object.entries(r.bySource)) console.log(`    ${src}: ${n}`);
  for (const p of r.problems) console.log(`  ! ${p}`);
  if (r.error) console.log(`  ! ${r.error}`);
  console.log(`\n  report:     ${started.reportHtml}`);
  if (argv.includes('--open')) {
    spawn('cmd', ['/c', 'start', '', started.reportHtml], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    console.log(`  (add --open to view it in the browser)\n`);
  }
}

/**
 * Follow a running project to completion, printing each new event as it lands.
 * Polling the file the daemon is already writing beats a long-held connection:
 * Ctrl-C here does not touch the sweep, and the terminal shows live progress.
 */
async function pollProject(id: string): Promise<ProjectFile> {
  let shown = 0;
  for (;;) {
    const p = (await daemon('GET', `/api/fb/recon/projects/${id}`)) as ProjectFile;
    for (const e of p.events.slice(shown)) console.log(`  ${e.at.slice(11, 19)}  ${e.phase.padEnd(8)} ${e.detail}`);
    shown = p.events.length;
    if (p.status !== 'running') return p;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/** eter-browser fb-recon-projects [--json] — every project on disk, newest first. */
async function cmdFbReconProjects(): Promise<void> {
  const data = (await daemon('GET', '/api/fb/recon/projects')) as { projects: ProjectFile[] };

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(data.projects, null, 2));
    return;
  }
  if (!data.projects.length) {
    console.log('\n  No fb-recon projects yet.  eter-browser fb-recon --topic <topic> --source group:<url>\n');
    return;
  }
  console.log('');
  for (const p of data.projects) {
    console.log(
      `  ${p.status.toUpperCase().padEnd(8)} ${p.id.padEnd(34)} ` +
        `${String(p.counters.totalContacts).padStart(4)} contacts  ${p.topic}`,
    );
  }
  console.log('');
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

  eter-browser profiles                    List Chrome profiles, their logins and browser state
  eter-browser profiles create <id> [label]  Make a new Chrome profile (no limit on how many)

  eter-browser login <site> [--profile ID]   Open Chrome to sign in  (facebook|whatsapp|instagram|x|linkedin|gmail|youtube, or any URL)
  eter-browser check [site] [--profile ID]   Re-verify one or all sessions
  eter-browser status [--profile ID]         Print session status

      Each profile is a separate Chrome with its own logins. Work in one profile
      cannot be killed by a browser restart in another — sign Facebook in twice,
      once per profile, if two sessions must run at the same time.

  eter-browser recon probe <url> [--window 8000] [--json]
      Watch one page settle and report what to wait on (and what lies).

  eter-browser fb-recon --topic <topic> [--source group:<url>] [--min-score 3] [--profile ID] [--open] [--json]
      Read-only Facebook prospecting. EVERY RUN IS A NEW PROJECT under
      <home>/fb-recon/projects/<id>/ with its own project.json, contacts.csv and
      report.html. Nothing is ever overwritten. See docs/fb-recon-sop.md.

  eter-browser fb-recon-projects [--json]
      List every fb-recon project, newest first.

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
    case 'profiles':
      return cmdProfiles();
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
    case 'fb-recon':
      return cmdFbRecon();
    case 'fb-recon-projects':
      return cmdFbReconProjects();
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
