// src/automations/whatsapp/list_chats.ts

/**---
id:       whatsapp_list_chats
domain:   whatsapp
use_when: the user asks who has messaged them on WhatsApp, what chats they have, or what is unread
effect:   read
needs:    [session:web.whatsapp.com]
---*/

import type { VaultService } from '../../service.js';
import type { WaChat } from '../../whatsapp.js';

export const run = (svc: VaultService, { limit }: { limit?: number }): Promise<WaChat[]> =>
  svc.waListChats(limit);
