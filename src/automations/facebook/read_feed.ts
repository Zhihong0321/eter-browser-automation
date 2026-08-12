// src/automations/facebook/read_feed.ts

/**---
id:       facebook_read_feed
domain:   facebook
use_when: the user asks what is on their Facebook feed or what other people have been posting
effect:   read
needs:    [session:facebook.com]
---*/

import type { VaultService } from '../../service.js';
import type { FbPost } from '../../facebook.js';

export const run = (svc: VaultService, { limit }: { limit?: number }): Promise<FbPost[]> =>
  svc.fbReadFeed(limit);
