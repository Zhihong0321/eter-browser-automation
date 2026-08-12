// src/automations/gmaprecon/plan.ts

/**---
id:       gmaprecon_plan
domain:   gmaprecon
use_when: the user wants to start a Google Maps lead search, or asks to look for companies by keyword across a list of towns or areas
effect:   write
needs:    []
---*/

import type { PlanResult } from '../../leads.js';
import type { VaultService } from '../../service.js';

/**
 * Expands keywords × places into pending work. Instant — nothing is scraped here.
 * Re-planning is idempotent, so adding one town to the list does not re-run the
 * towns already harvested.
 *
 * Maps caps a single search well short of a whole state, so coverage comes from
 * naming sub-places (towns, districts), not from one broad region string.
 */
export const run = (
  svc: VaultService,
  { keywords, places }: { keywords: string[]; places: string[] },
): PlanResult =>
  svc.gmapPlan(keywords, places);
