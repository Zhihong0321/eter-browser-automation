// Regenerate a gmap project's report.html from its stored rows.
// report.html bakes the renderer in at generation time, so a change to
// src/gmapreport.ts is invisible until the file is rewritten.
import fs from 'node:fs';
import path from 'node:path';
import { renderReport } from '../src/gmapreport.js';
import { LeadStore } from '../src/leads.js';
import { projectDir, projectsRoot } from '../src/gmapproject.js';

const ids = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(projectsRoot()).filter((d) => fs.existsSync(path.join(projectsRoot(), d, 'project.json')));

for (const id of ids) {
  const dir = projectDir(id);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  const store = new LeadStore(path.join(dir, 'leads.db'));
  const rows = store.rows();
  const dossiers = store.allDossiers();
  const out = path.join(dir, 'report.html');
  fs.writeFileSync(out, renderReport(meta, rows, dossiers), 'utf8');
  const kb = (fs.statSync(out).size / 1024).toFixed(0);
  console.log(`rewrote ${out} — ${rows.length} rows, ${dossiers.length} dossiers, ${kb}KB`);
}
