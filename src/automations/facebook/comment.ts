// src/automations/facebook/comment.ts

/**---
id:       facebook_comment
domain:   facebook
use_when: the user wants to leave a comment on a Facebook post
effect:   destructive
needs:    [session:facebook.com]
---*/

import type { VaultService } from '../../service.js';
import type { CommentResult } from '../../facebook.js';

export const run = (
  svc: VaultService,
  { postUrl, text }: { postUrl: string; text: string },
): Promise<CommentResult> => svc.fbComment(postUrl, text);
