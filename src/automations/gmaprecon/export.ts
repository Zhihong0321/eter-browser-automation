// src/automations/gmaprecon/export.ts

/**---
id:       gmaprecon_export
domain:   gmaprecon
use_when: the user wants the harvested Google Maps companies as a spreadsheet or CSV file
effect:   write
needs:    []
---*/

import type { ExportResult } from '../../leads.js';
import type { VaultService } from '../../service.js';

/**
 * Dumps the store to CSV. Filter to rows that actually carry a phone or an email
 * when the list is for outreach rather than for review.
 *
 * Phone numbers beginning with + are escaped so Excel shows the number instead of
 * evaluating it as a formula.
 */
export const run = (
  svc: VaultService,
  { file, withPhoneOnly, withEmailOnly }: { file: string; withPhoneOnly?: boolean; withEmailOnly?: boolean },
): ExportResult => svc.gmapExport(file, { withPhoneOnly, withEmailOnly });
