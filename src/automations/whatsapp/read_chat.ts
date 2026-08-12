// src/automations/whatsapp/read_chat.ts

/**---
id:       whatsapp_read_chat
domain:   whatsapp
use_when: the user asks what a specific person or group said on WhatsApp
effect:   read
needs:    [session:web.whatsapp.com]
---*/

import type { VaultService } from '../../service.js';
import type { WaMessage } from '../../whatsapp.js';

export const run = (
  svc: VaultService,
  { target, limit }: { target: string; limit?: number },
): Promise<{ chat: string; messages: WaMessage[] }> => svc.waReadChat(target, limit);
