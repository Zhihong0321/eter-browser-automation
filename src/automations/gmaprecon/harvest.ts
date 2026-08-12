// src/automations/gmaprecon/harvest.ts

/**---
id:       gmaprecon_harvest
domain:   gmaprecon
use_when: the user wants to run or continue a Google Maps lead search that has already been planned
effect:   write
needs:    []
---*/

import type { HarvestResult } from '../../leads.js';
import type { VaultService } from '../../service.js';

/**
 * Runs a bounded chunk of pending searches and stores the companies found — name,
 * phone, website, category, rating, coordinates. Call it repeatedly until
 * gmaprecon_status reports no pending searches; progress lives on disk, so a crash
 * costs one chunk rather than the run.
 *
 * Returns `halted` with a reason when it stops early. That happens on a hard block,
 * or when the canary re-search shows Google is silently returning short results —
 * in which case nothing is banked, because short results look exactly like success.
 */
export const run = (svc: VaultService, { limit }: { limit?: number }): Promise<HarvestResult> =>
  svc.gmapHarvest(limit);
