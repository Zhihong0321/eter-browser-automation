// src/automations/chatgpt/ask.ts

/**---
id:       chatgpt_ask
domain:   chatgpt
use_when: you want a free second opinion, summary, classification or draft from a plain-language question
effect:   read-only
needs:    [session:chatgpt.com]
---*/

import type { VaultService } from '../../service.js';
import type { ChatGptAnswer } from '../../chatgpt.js';

export const run = (svc: VaultService, { question }: { question: string }): Promise<ChatGptAnswer> =>
  svc.chatgptAsk(question);
