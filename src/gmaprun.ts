// gmap-recon — the run loop, shared by the CLI and the dashboard.
//
// One implementation, two front ends. `gmap.mjs` awaits runProject() and prints each
// progress line; the daemon calls startBackground() and lets the UI poll runState(),
// because a harvest lasts minutes to hours and the HTTP layer is request→response.
//
// Exactly ONE run at a time, enforced here. gmap-recon drives a single Chrome
// profile, so two concurrent harvests would fight over the same browser and double
// the traffic Google sees from one identity.

import fs from 'node:fs';
import path from 'node:path';
import type { VaultService } from './service.js';
import { renderReport } from './gmapreport.js';
import { projectDir, saveProject, type ProjectMeta } from './gmapproject.js';
import type { Progress } from './leads.js';

export type ProgressFn = (line: string) => void;

export interface RunState {
  projectId: string | null;
  phase: 'idle' | 'starting' | 'harvesting' | 'enriching' | 'finishing' | 'done' | 'paused' | 'error';
  line: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

const IDLE: RunState = {
  projectId: null, phase: 'idle', line: '', startedAt: null, finishedAt: null, error: null,
};

let active: RunState = { ...IDLE };

export const runState = (): RunState => ({ ...active });
export const isRunning = (): boolean =>
  active.phase !== 'idle' && active.phase !== 'done' && active.phase !== 'error' && active.phase !== 'paused';

/** Copy live counts out of the store onto the project record. */
function syncStats(meta: ProjectMeta, s: Progress): void {
  meta.stats.searchesDone = s.searches.done + s.searches.failed;
  meta.stats.searchesTotal =
    s.searches.done + s.searches.failed + s.searches.pending + s.searches.blocked;
  meta.stats.companies = s.businesses;
  meta.stats.withPhone = s.withPhone;
  meta.stats.withEmail = s.withEmail;
  meta.saturated = s.saturated;
}

/** Write the spreadsheet and the report, and persist the record. */
export function finish(svc: VaultService, meta: ProjectMeta): { csv: string; html: string } {
  const dir = projectDir(meta.id);
  syncStats(meta, svc.gmapStatus());
  const csv = svc.gmapExport(path.join(dir, 'leads.csv'), {}).file;
  const html = path.join(dir, 'report.html');
  fs.writeFileSync(html, renderReport(meta, svc.gmapRows()), 'utf8');
  saveProject(meta);
  return { csv, html };
}

/**
 * Plan, harvest, enrich, export. Safe to call again on the same project: planning is
 * idempotent and finished searches are never re-run, so an interrupted campaign
 * resumes without re-spending a single Google search.
 */
export async function runProject(
  svc: VaultService,
  meta: ProjectMeta,
  log: ProgressFn = () => {},
): Promise<ProjectMeta> {
  svc.gmapUseProject(projectDir(meta.id));

  const plan = svc.gmapPlan(meta.keywords, meta.places);
  log(`${plan.planned} searches to run, ${plan.existing} already done`);

  meta.status = 'harvesting';
  meta.pausedReason = null;
  saveProject(meta);

  for (;;) {
    const r = await svc.gmapHarvest(5);
    syncStats(meta, r);
    saveProject(meta);

    if (r.halted) {
      meta.status = 'paused';
      meta.pausedReason = r.halted;
      finish(svc, meta);
      log(`paused — ${r.halted}`);
      return meta;
    }
    log(`${meta.stats.searchesDone}/${meta.stats.searchesTotal} searches · ${r.businesses} companies`);
    if (r.searches.pending === 0) break;
  }

  if (svc.gmapStatus().enrich.pending > 0) {
    meta.status = 'enriching';
    saveProject(meta);
    for (;;) {
      const r = await svc.gmapEnrich(25);
      syncStats(meta, r);
      saveProject(meta);
      const seen = r.enrich.done + r.enrich.failed + r.enrich.no_website;
      const pct = Math.round((seen / (seen + r.enrich.pending || 1)) * 100);
      log(`websites ${pct}% · ${r.withEmail} emails`);
      if (r.enrich.pending === 0) break;
    }
  }

  meta.status = 'complete';
  finish(svc, meta);
  log(`done — ${meta.stats.companies} companies, ${meta.stats.withEmail} emails`);
  return meta;
}

/**
 * Kick a run off without blocking the HTTP response. Errors are captured into
 * runState rather than thrown, because nobody is awaiting this promise — an
 * unhandled rejection here would take the daemon down.
 */
export function startBackground(svc: VaultService, meta: ProjectMeta): { started: boolean; reason?: string } {
  if (isRunning()) {
    return { started: false, reason: `Already running "${active.projectId}". Only one search can run at a time.` };
  }

  active = {
    projectId: meta.id,
    phase: 'starting',
    line: 'starting…',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };

  void (async () => {
    try {
      await runProject(svc, meta, (line) => {
        active.line = line;
        active.phase = meta.status === 'enriching' ? 'enriching' : 'harvesting';
      });
      active.phase = meta.status === 'paused' ? 'paused' : 'done';
      active.line = meta.pausedReason ?? `${meta.stats.companies} companies`;
    } catch (e) {
      active.phase = 'error';
      active.error = e instanceof Error ? e.message : String(e);
      active.line = active.error;
      try {
        meta.status = 'paused';
        meta.pausedReason = active.error;
        saveProject(meta);
      } catch {
        // The project record is best-effort here; runState still carries the error.
      }
    } finally {
      // Always hand the profile back, even on failure — otherwise one crashed run
      // locks out every later one.
      try { await svc.gmapCloseBrowser(); } catch { /* best effort */ }
      active.finishedAt = new Date().toISOString();
    }
  })();

  return { started: true };
}
