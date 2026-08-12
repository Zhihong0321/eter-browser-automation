// gmap-recon projects — one campaign, one folder, everything in it.
//
//   <vault home>/gmap-projects/<id>/
//       project.json   what was searched, how far it got, what it found
//       leads.db       this project's companies only
//       leads.csv      spreadsheet
//       report.html    the presentation
//
// The rate budget deliberately does NOT live here: Google throttles the browser
// profile, not the project, so a per-project budget would let ten projects each
// spend a "full" allowance and get the profile throttled ten times faster.

import fs from 'node:fs';
import path from 'node:path';
import { resolveVaultHome } from './config.js';

export type ProjectStatus = 'planned' | 'harvesting' | 'enriching' | 'complete' | 'paused';

export interface ProjectStats {
  searchesTotal: number;
  searchesDone: number;
  companies: number;
  withPhone: number;
  withEmail: number;
}

export interface ProjectMeta {
  id: string;
  keywords: string[];
  places: string[];
  createdAt: string;
  updatedAt: string;
  status: ProjectStatus;
  /** Why a paused project stopped — throttle, block, or an interrupted run. */
  pausedReason: string | null;
  stats: ProjectStats;
  /** Towns where Google stopped showing more; companies there were missed. */
  saturated: { keyword: string; place: string; found: number }[];
}

export const projectsRoot = (): string => path.join(resolveVaultHome(), 'gmap-projects');
export const projectDir = (id: string): string => path.join(projectsRoot(), id);

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28);

/** e.g. 2026-08-12-solar-installer-klang, or -klang-3-more when the list is long. */
export function makeProjectId(keywords: string[], places: string[], now = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  const k = slug(keywords[0] ?? 'search');
  const p = slug(places[0] ?? 'area');
  const extra = places.length > 1 ? `-${places.length - 1}-more` : '';
  return `${date}-${k}-${p}${extra}`;
}

/** Same id on the same day is the same campaign, so a second one gets a suffix. */
function uniqueId(base: string): string {
  if (!fs.existsSync(projectDir(base))) return base;
  for (let n = 2; n < 100; n++) {
    if (!fs.existsSync(projectDir(`${base}-${n}`))) return `${base}-${n}`;
  }
  return `${base}-${Date.now()}`;
}

const emptyStats = (searchesTotal: number): ProjectStats => ({
  searchesTotal,
  searchesDone: 0,
  companies: 0,
  withPhone: 0,
  withEmail: 0,
});

export function createProject(keywords: string[], places: string[]): ProjectMeta {
  const id = uniqueId(makeProjectId(keywords, places));
  const now = new Date().toISOString();
  const meta: ProjectMeta = {
    id,
    keywords,
    places,
    createdAt: now,
    updatedAt: now,
    status: 'planned',
    pausedReason: null,
    stats: emptyStats(keywords.length * places.length),
    saturated: [],
  };
  fs.mkdirSync(projectDir(id), { recursive: true });
  saveProject(meta);
  return meta;
}

export function saveProject(meta: ProjectMeta): void {
  meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(projectDir(meta.id), 'project.json'), JSON.stringify(meta, null, 2));
}

export function loadProject(id: string): ProjectMeta {
  const file = path.join(projectDir(id), 'project.json');
  if (!fs.existsSync(file)) {
    const known = listProjects().map((p) => p.id).join('\n    ') || '(none yet)';
    throw new Error(`No project "${id}". Existing projects:\n    ${known}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as ProjectMeta;
}

/** Newest first — the one you most likely want is at the top. */
export function listProjects(): ProjectMeta[] {
  const root = projectsRoot();
  if (!fs.existsSync(root)) return [];
  const out: ProjectMeta[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      out.push(loadProject(entry.name));
    } catch {
      // A folder without a readable project.json is not a project. Skip it rather
      // than fail the listing.
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * An unfinished project covering exactly this search. Guards against restarting a
 * half-done overnight run from zero — the Google searches already spent are the
 * scarce resource, not the disk space.
 */
export function findUnfinished(keywords: string[], places: string[]): ProjectMeta | null {
  const key = (k: string[], p: string[]): string =>
    `${[...k].map((x) => x.toLowerCase().trim()).sort().join('|')}::${[...p].map((x) => x.toLowerCase().trim()).sort().join('|')}`;
  const want = key(keywords, places);
  return listProjects().find((p) => p.status !== 'complete' && key(p.keywords, p.places) === want) ?? null;
}
