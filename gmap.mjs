// gmap-recon — project runner (command line).
//
//   node gmap.mjs new "solar installer" "Klang, Kajang"   create a project and run it
//   node gmap.mjs list                                     every project and its status
//   node gmap.mjs resume <project-id>                      continue an unfinished one
//   node gmap.mjs report <project-id>                      rebuild and open the report
//
// The same job is available in the dashboard at http://127.0.0.1:7676 — both drive
// the identical run engine in dist/gmaprun.js, so behaviour cannot diverge.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { VaultService } from './dist/service.js';
import { resolveVaultHome } from './dist/config.js';
import { finish, runProject } from './dist/gmaprun.js';
import {
  createProject, findUnfinished, listProjects, loadProject, projectDir, projectsRoot,
} from './dist/gmapproject.js';

const [cmd, ...rest] = process.argv.slice(2);
const asList = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

function usage(msg) {
  if (msg) console.log(`\n  ${msg}`);
  console.log(`
  GMAP-RECON

    node gmap.mjs new "<keywords>" "<towns>"   create a project and run it
    node gmap.mjs list                          every project and its status
    node gmap.mjs resume <project-id>           continue an unfinished project
    node gmap.mjs report <project-id>           rebuild and open the report

  Example

    node gmap.mjs new "solar panel installer" "Petaling Jaya, Shah Alam, Klang"

  Commas separate several keywords or towns. Ctrl+C is safe — resume picks up
  exactly where it stopped and never re-spends a search that already succeeded.
`);
  process.exit(msg ? 1 : 0);
}

const openFile = (file) => {
  try {
    spawn('cmd', ['/c', 'start', '', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    // Opening the browser is a convenience; the file is written either way.
  }
};

async function withService(fn) {
  const svc = new VaultService(resolveVaultHome());
  try {
    return await fn(svc);
  } finally {
    await svc.shutdown();
  }
}

async function run(meta) {
  await withService(async (svc) => {
    console.log(`\n  PROJECT  ${meta.id}`);
    console.log(`  ${meta.keywords.join(', ')}  ×  ${meta.places.join(', ')}\n`);

    await runProject(svc, meta, (line) => console.log(`    ${line}`));

    const html = path.join(projectDir(meta.id), 'report.html');
    console.log(`\n  ${meta.status === 'paused' ? 'PAUSED' : 'DONE'}\n`);
    if (meta.pausedReason) console.log(`    ${meta.pausedReason}\n`);
    console.log(`    companies      ${meta.stats.companies}`);
    console.log(`    with phone     ${meta.stats.withPhone}`);
    console.log(`    with email     ${meta.stats.withEmail}`);
    console.log(`    spreadsheet    ${path.join(projectDir(meta.id), 'leads.csv')}`);
    console.log(`    report         ${html}\n`);

    if (meta.status === 'paused') {
      console.log(`  Continue with:  node gmap.mjs resume ${meta.id}\n`);
    }
    if (meta.saturated.length) {
      console.log('  Some towns were full — companies there were missed. Re-run those');
      console.log('  as smaller areas:');
      for (const x of meta.saturated) console.log(`    - ${x.place} (${x.keyword})`);
      console.log('');
    }
    openFile(html);
  });
}

// ------------------------------------------------------------------ commands

if (!cmd || cmd === 'help' || cmd === '--help') usage();

if (cmd === 'new') {
  const keywords = asList(rest[0]);
  const places = asList(rest[1]);
  if (!keywords.length || !places.length) usage('Need both keywords and towns.');

  const existing = rest.includes('--force') ? null : findUnfinished(keywords, places);
  if (existing) {
    console.log(`\n  That exact search is already running as an unfinished project:`);
    console.log(`    ${existing.id}   (${existing.status}, ${existing.stats.companies} companies so far)\n`);
    console.log(`  Continue it — this does NOT re-spend searches already done:`);
    console.log(`    node gmap.mjs resume ${existing.id}\n`);
    console.log(`  Or start a separate project anyway by adding --force\n`);
    process.exit(1);
  }
  await run(createProject(keywords, places));
} else if (cmd === 'resume') {
  if (!rest[0]) usage('Which project? Run: node gmap.mjs list');
  const meta = loadProject(rest[0]);
  if (meta.status === 'complete') {
    console.log(`\n  ${meta.id} is already complete (${meta.stats.companies} companies).`);
    console.log(`  Report: ${path.join(projectDir(meta.id), 'report.html')}\n`);
    process.exit(0);
  }
  await run(meta);
} else if (cmd === 'list') {
  const all = listProjects();
  if (!all.length) {
    console.log(`\n  No projects yet. Start one:\n    node gmap.mjs new "solar installer" "Klang"\n`);
    process.exit(0);
  }
  console.log(`\n  ${all.length} project(s) in ${projectsRoot()}\n`);
  console.log(`  ${'STATUS'.padEnd(11)}${'COMPANIES'.padEnd(11)}${'PHONE'.padEnd(8)}${'EMAIL'.padEnd(8)}PROJECT`);
  for (const p of all) {
    console.log(
      `  ${p.status.padEnd(11)}${String(p.stats.companies).padEnd(11)}` +
      `${String(p.stats.withPhone).padEnd(8)}${String(p.stats.withEmail).padEnd(8)}${p.id}`,
    );
  }
  console.log('');
} else if (cmd === 'report') {
  if (!rest[0]) usage('Which project? Run: node gmap.mjs list');
  const meta = loadProject(rest[0]);
  await withService(async (svc) => {
    svc.gmapUseProject(projectDir(meta.id));
    const out = finish(svc, meta);
    console.log(`\n  ${out.html}\n`);
    openFile(out.html);
  });
} else {
  usage(`Unknown command "${cmd}".`);
}
