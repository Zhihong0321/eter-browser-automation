/**
 * The cross-project ledger: who has this account already found, and where.
 *
 * Projects are self-contained by design, which creates exactly one problem worth
 * solving — the same person surfacing in five projects with nothing to say they
 * were already found, and getting the same cold opener five times. The ledger is
 * the one piece of state that deliberately spans projects, and it holds the
 * minimum needed to prevent that: an identity, a name, and which projects saw
 * them.
 *
 * It FLAGS, it never filters. A repeat sighting is still evidence — someone
 * asking about solar again three months later is a better lead than they were
 * the first time — so the new project keeps the contact and marks them as known.
 * Silently dropping them would make a project's contact list a lie about what
 * that sweep actually saw.
 *
 * No evidence, no quotes, no phone numbers live here. Those stay in the project
 * that harvested them, so this file stays small and the blast radius of losing
 * it is "you lose the cross-run flag", not "you lose the harvest".
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FbContact } from './store.js';

export interface LedgerEntry {
  id: string;
  name: string;
  /** Every project that has harvested this person, oldest first. */
  projects: string[];
  firstSeen: string;
  lastSeen: string;
}

export type Ledger = Map<string, LedgerEntry>;

export function loadLedger(file: string): Ledger {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { people?: LedgerEntry[] };
    return new Map((raw.people ?? []).map((p) => [p.id, p]));
  } catch {
    return new Map();
  }
}

export function saveLedger(file: string, ledger: Ledger): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const people = [...ledger.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  const body = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), people }, null, 1);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

/**
 * Which earlier projects already found this person.
 *
 * The current project is excluded, so a re-render or a resumed write cannot make
 * a project look like it is repeating itself.
 */
export function priorProjects(ledger: Ledger, contactId: string, currentProjectId: string): string[] {
  return (ledger.get(contactId)?.projects ?? []).filter((p) => p !== currentProjectId);
}

/** Fold a finished project's contacts into the ledger. Idempotent per project. */
export function recordProject(
  ledger: Ledger,
  projectId: string,
  contacts: FbContact[],
  at = new Date().toISOString(),
): void {
  for (const c of contacts) {
    const existing = ledger.get(c.id);
    if (!existing) {
      ledger.set(c.id, { id: c.id, name: c.name, projects: [projectId], firstSeen: at, lastSeen: at });
      continue;
    }
    if (!existing.projects.includes(projectId)) existing.projects.push(projectId);
    // A later run usually has the better name: the earlier one may have been
    // harvested before an extractor fix, when names came through as user ids.
    if (c.name && c.name !== c.id) existing.name = c.name;
    if (at > existing.lastSeen) existing.lastSeen = at;
  }
}
