// src/enrich/researchfiles.ts — physical, on-disk copies of each research pass's
// brief, independent of the dossier JSON/SQLite blob.
//
// Two passes get merged into one `facts` object for scoring and display (see
// mergeFacts in agyresearch.ts), and a merge is exactly the kind of step that
// can quietly lose content without anyone noticing until it matters. Writing
// each pass's raw brief to its own file, before any merging happens, means the
// original of either pass can always be diffed against the merged result —
// "did agy's pass actually add to this, or did something get lost" stops being
// a question you have to trust the merge code to answer honestly.
import fs from 'node:fs';
import path from 'node:path';
import type { VaultService } from '../service.js';
import { resolveVaultHome } from '../config.js';

/** placeId is Maps-generated and already filesystem-safe in practice; this is a defensive floor. */
const safeSlug = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, '_') || 'company';

/**
 * One folder per company, per project when a project is active (mirrors how
 * leadStore nests `leads.db` under the project dir — see service.ts#leadStore),
 * falling back to a vault-wide folder for the shared store.
 */
export function researchDirFor(svc: VaultService, placeId: string): string {
  const base = svc.gmapActiveProject() ?? resolveVaultHome();
  const dir = path.join(base, 'research', safeSlug(placeId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write one pass's brief to its own named file. Overwrites on re-run — this is the CURRENT brief, not a history. */
export function writeResearchFile(svc: VaultService, placeId: string, filename: string, content: string): string {
  const file = path.join(researchDirFor(svc, placeId), filename);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

export const CHATGPT_BASELINE_FILE = '01-chatgpt-baseline.txt';
export const AGY_SECONDPASS_FILE = '02-agy-secondpass.txt';
