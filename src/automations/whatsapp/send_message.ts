// src/automations/whatsapp/send_message.ts

/**---
id:       whatsapp_send_message
domain:   whatsapp
use_when: the user wants to send a WhatsApp message to a person or chat
effect:   destructive
needs:    [session:web.whatsapp.com]
---*/

import type { VaultService } from '../../service.js';
import type { WaSendResult } from '../../whatsapp.js';

export const run = (
  svc: VaultService,
  { target, text }: { target: string; text: string },
): Promise<WaSendResult> => svc.waSend(target, text);
