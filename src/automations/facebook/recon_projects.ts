// src/automations/facebook/recon_projects.ts

/**---
id:       facebook_recon_projects
domain:   facebook
use_when: the user asks what Facebook prospecting runs have been done, or wants the results of an earlier fb-recon project
effect:   read
needs:    []
---*/

import type { VaultService } from '../../service.js';
import type { ProjectFile } from '../../fb-recon/project.js';

export const run = (svc: VaultService): Promise<ProjectFile[]> =>
  Promise.resolve(svc.fbReconProjects());
