// src/automations/facebook/read_my_posts.ts

/**---
id:       facebook_read_my_posts
domain:   facebook
use_when: the user asks about their own recent Facebook posts
effect:   read
needs:    [session:facebook.com]
---*/

import type { VaultService } from '../../service.js';
import type { FbPost } from '../../facebook.js';

export const run = (svc: VaultService, { limit }: { limit?: number }): Promise<FbPost[]> =>
  svc.fbReadMyPosts(limit);
