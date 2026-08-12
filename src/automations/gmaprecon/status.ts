// src/automations/gmaprecon/status.ts

/**---
id:       gmaprecon_status
domain:   gmaprecon
use_when: the user asks how the Google Maps lead search is going, how many companies have been found, or what is left to run
effect:   read
needs:    []
---*/

import type { StatusResult } from '../../leads.js';
import type { VaultService } from '../../service.js';

/**
 * Counts by state, plus the remaining search budget.
 *
 * `saturated` lists searches whose result count plateaued — those towns are hiding
 * businesses behind the cap and should be split into districts and re-planned.
 * That list is the coverage check on the whole campaign.
 */
export const run = (svc: VaultService): StatusResult => svc.gmapStatus();
