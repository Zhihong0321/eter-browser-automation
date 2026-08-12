/**
 * A run is a PROJECT. One invocation, one id, one directory, one file.
 *
 * The rule this enforces is that nothing is ever appended to a shared harvest:
 * you can hand someone a project directory and it is the whole story of that
 * sweep — what was asked for, what happened while it ran, and what came back.
 * Re-running the same topic produces a second project, never a mutation of the
 * first, so a result you showed someone last week still says what it said.
 *
 * Progress is written DURING the run, not reconstructed at the end. Every phase
 * event and every counter change flushes the file and re-renders the report, so
 * a sweep can be watched live by refreshing the HTML — and, more importantly, a
 * run that hangs or dies still leaves a project that says exactly how far it
 * got. A final-write-only design loses precisely the runs you most want to read.
 *
 * See docs/fb-recon-sop.md for the operating procedure this implements.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { renderProject } from './report.js';
import { slug } from './topic.js';
import type { FbContact } from './store.js';

export type ProjectStatus = 'running' | 'done' | 'failed';

export interface PhaseEvent {
  at: string;
  /** Coarse stage: sweep | classify | open | finish. Renders as the timeline. */
  phase: string;
  detail: string;
}

export interface ProjectCounters {
  scanned: number;
  gated: number;
  opened: number;
  skippedNoPermalink: number;
  commentsRead: number;
  /** People this project harvested who appear in no earlier project. */
  newContacts: number;
  /** People this project harvested who an earlier project already found. */
  knownContacts: number;
  totalContacts: number;
}

export const ZERO_COUNTERS: ProjectCounters = {
  scanned: 0,
  gated: 0,
  opened: 0,
  skippedNoPermalink: 0,
  commentsRead: 0,
  newContacts: 0,
  knownContacts: 0,
  totalContacts: 0,
};

export interface ProjectContact extends FbContact {
  /**
   * Ids of earlier projects that already harvested this person. Empty means
   * first contact. They are FLAGGED rather than filtered: a repeat sighting is
   * still evidence, and the thing you must not do is cold-pitch someone twice
   * without knowing it.
   */
  priorProjects: string[];
}

export interface ProjectFile {
  version: 1;
  id: string;
  topic: string;
  sources: string[];
  minScore: number | null;
  status: ProjectStatus;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  counters: ProjectCounters;
  bySource: Record<string, number>;
  events: PhaseEvent[];
  problems: string[];
  contacts: ProjectContact[];
}

/** What the engine is given so it can report while it works. */
export interface RunReporter {
  event(phase: string, detail: string): void;
  progress(counters: Partial<ProjectCounters>): void;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * `20260812-1430-e-invoice-9f3a`.
 *
 * Sorts chronologically as a plain string, says what it was about without being
 * opened, and carries 2 random bytes so two runs started in the same minute
 * cannot collide.
 */
export function newProjectId(topic: string, now = new Date()): string {
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${stamp}-${slug(topic)}-${randomBytes(2).toString('hex')}`;
}

/** Write-then-rename, so a reader never sees a half-written file. */
function writeAtomic(file: string, body: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

export class ProjectRun {
  readonly id: string;
  readonly dir: string;
  readonly #file: ProjectFile;

  constructor(
    projectsRoot: string,
    meta: { topic: string; sources: string[]; minScore?: number },
    id = newProjectId(meta.topic),
  ) {
    this.id = id;
    this.dir = path.join(projectsRoot, id);
    fs.mkdirSync(this.dir, { recursive: true });

    this.#file = {
      version: 1,
      id,
      topic: meta.topic,
      sources: meta.sources,
      minScore: meta.minScore ?? null,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      counters: { ...ZERO_COUNTERS },
      bySource: {},
      events: [],
      problems: [],
      contacts: [],
    };
    this.event('start', `topic "${meta.topic}" over ${meta.sources.length} source(s)`);
  }

  get jsonPath(): string {
    return path.join(this.dir, 'project.json');
  }

  get htmlPath(): string {
    return path.join(this.dir, 'report.html');
  }

  get snapshot(): ProjectFile {
    return this.#file;
  }

  event(phase: string, detail: string): void {
    this.#file.events.push({ at: new Date().toISOString(), phase, detail });
    this.#flush();
  }

  progress(counters: Partial<ProjectCounters>): void {
    Object.assign(this.#file.counters, counters);
    this.#flush();
  }

  setBySource(bySource: Record<string, number>): void {
    this.#file.bySource = bySource;
    this.#flush();
  }

  setProblems(problems: string[]): void {
    this.#file.problems = problems;
    this.#flush();
  }

  setContacts(contacts: ProjectContact[]): void {
    this.#file.contacts = contacts;
    this.#file.counters.totalContacts = contacts.length;
    this.#file.counters.newContacts = contacts.filter((c) => c.priorProjects.length === 0).length;
    this.#file.counters.knownContacts = contacts.length - this.#file.counters.newContacts;
    this.#flush();
  }

  finish(): ProjectFile {
    this.#file.status = 'done';
    this.#file.finishedAt = new Date().toISOString();
    this.event('finish', `${this.#file.counters.totalContacts} contact(s) harvested`);
    return this.#file;
  }

  /**
   * A crashed sweep is still a project. The failure is recorded in the file
   * rather than only thrown, because the thrown error reaches one caller and
   * then is gone, while the question "what happened to that run?" is asked days
   * later.
   */
  fail(err: unknown): ProjectFile {
    this.#file.status = 'failed';
    this.#file.finishedAt = new Date().toISOString();
    this.#file.error = err instanceof Error ? err.message : String(err);
    this.event('finish', `FAILED: ${this.#file.error}`);
    return this.#file;
  }

  #flush(): void {
    writeAtomic(this.jsonPath, JSON.stringify(this.#file, null, 1));
    writeAtomic(this.htmlPath, renderProject(this.#file));
  }
}

/**
 * Mark long-abandoned `running` projects as failed.
 *
 * `fail()` covers a sweep that throws, but not a daemon that dies underneath it —
 * and that happens for real: killing the daemon leaves Chrome holding the profile
 * lock, the respawned daemon cannot launch, and the project it was writing stays
 * `running` forever. A status of "running" on a sweep from three hours ago is a
 * lie of exactly the kind this tool exists to avoid, so it is corrected on the
 * next run rather than left to be believed.
 *
 * Age-based rather than "any other running project", because two sweeps CAN be in
 * flight at once (they queue on the browser), and falsely failing a live run would
 * be a worse error than a late correction.
 */
export function reapStaleProjects(projectsRoot: string, maxAgeMs = 2 * 3_600_000, now = Date.now()): string[] {
  const reaped: string[] = [];
  for (const p of listProjects(projectsRoot)) {
    if (p.status !== 'running') continue;
    if (now - new Date(p.startedAt).getTime() < maxAgeMs) continue;

    p.status = 'failed';
    p.finishedAt = new Date(now).toISOString();
    p.error = 'The daemon exited before this run finished; it was never completed.';
    p.events.push({ at: p.finishedAt, phase: 'finish', detail: 'FAILED: abandoned — daemon exited mid-run' });
    try {
      const dir = path.join(projectsRoot, p.id);
      writeAtomic(path.join(dir, 'project.json'), JSON.stringify(p, null, 1));
      writeAtomic(path.join(dir, 'report.html'), renderProject(p));
      reaped.push(p.id);
    } catch {
      // A project we cannot rewrite stays as it was. Better a stale label than a
      // refused run.
    }
  }
  return reaped;
}

/** Every project on disk, newest first. Malformed ones are skipped, not fatal. */
export function listProjects(projectsRoot: string): ProjectFile[] {
  if (!fs.existsSync(projectsRoot)) return [];
  const out: ProjectFile[] = [];
  for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = fs.readFileSync(path.join(projectsRoot, entry.name, 'project.json'), 'utf8');
      out.push(JSON.parse(raw) as ProjectFile);
    } catch {
      // A directory without a readable project.json is a run that died before
      // its first flush, or someone's stray folder. Neither should hide the rest.
    }
  }
  return out.sort((a, b) => b.id.localeCompare(a.id));
}
