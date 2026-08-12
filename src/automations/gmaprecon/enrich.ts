// src/automations/gmaprecon/enrich.ts

/**---
id:       gmaprecon_enrich
domain:   gmaprecon
use_when: the user wants email addresses or social media links for the companies already harvested from Google Maps
effect:   write
needs:    []
---*/

import type { VaultService } from '../../service.js';

/**
 * Stage 2. Visits each harvested company's website and pulls emails plus Facebook,
 * Instagram, WhatsApp and LinkedIn links. Bounded per call, resumable, and skips
 * companies with no website.
 *
 * This touches third-party sites, not Google, so it carries none of the harvest's
 * rate risk. Expect roughly half to yield an email — many small businesses run a
 * Facebook page instead of a site.
 */
export const run = (svc: VaultService, { limit }: { limit?: number }) => svc.gmapEnrich(limit);
