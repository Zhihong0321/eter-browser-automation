// src/automations/facebook/recon.ts

/**---
id:       facebook_recon
domain:   facebook
use_when: the user wants to find people on Facebook who are interested in a topic, and collect their contact details for later outreach
effect:   read
needs:    [session:facebook.com]
---*/

import type { FbReconResult, VaultService } from '../../service.js';

export const run = (
  svc: VaultService,
  { topic, sources, minScore }: { topic: string; sources?: string[]; minScore?: number },
): Promise<FbReconResult> => svc.fbRecon({ topic, sources, minScore });
