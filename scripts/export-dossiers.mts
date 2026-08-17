// Export each researched company's deep research as its own standalone HTML file.
//
//   npx tsx scripts/export-dossiers.mts                  every project
//   npx tsx scripts/export-dossiers.mts <project-id>     one project
//
// Writes <project>/dossiers/<company>-<id>.html. Each file is self-contained: no
// daemon, no network, no JavaScript. Mail one, or print it to PDF.
import fs from 'node:fs';
import path from 'node:path';
import { renderDossierPage, dossierSlug } from '../src/gmapdossier.js';
import { LeadStore } from '../src/leads.js';
import { projectDir, projectsRoot } from '../src/gmapproject.js';

const ids = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(projectsRoot()).filter((d) => fs.existsSync(path.join(projectsRoot(), d, 'project.json')));

for (const id of ids) {
  const dir = projectDir(id);
  const store = new LeadStore(path.join(dir, 'leads.db'));
  const rows = new Map(store.rows().map((r) => [r.placeId, r]));
  const dossiers = store.allDossiers();

  if (!dossiers.length) {
    console.log(`${id}: no dossiers yet — run deep research first`);
    continue;
  }

  const out = path.join(dir, 'dossiers');
  fs.mkdirSync(out, { recursive: true });

  for (const d of dossiers) {
    const file = path.join(out, `${dossierSlug(d.companyName, d.placeId)}.html`);
    fs.writeFileSync(file, renderDossierPage(d, rows.get(d.placeId)), 'utf8');
    const kb = (fs.statSync(file).size / 1024).toFixed(0);
    console.log(`${kb.padStart(4)}KB  ${path.relative(dir, file)}   ${d.companyName.slice(0, 40)}`);
  }
  console.log(`\n${id}: ${dossiers.length} dossiers → ${out}\n`);
}
