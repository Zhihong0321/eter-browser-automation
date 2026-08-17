// Push each researched company's knowledge to the RAG Bucket service.
//
//   npx tsx scripts/push-rag.mts --dry-run              show what would be pushed
//   npx tsx scripts/push-rag.mts                        push every researched company
//   npx tsx scripts/push-rag.mts --project <id>         one project only
//   npx tsx scripts/push-rag.mts --company agriculf     name substring filter
//   npx tsx scripts/push-rag.mts --public-only          skip the internal dossier
//
// Two documents per company, in one group per company:
//
//   README.md                    retrieval guide the AI reads first
//   company-profile.md           PUBLIC — clean profile, no risks or assessment
//   internal-research-dossier.md INTERNAL — full record including risks
//
// --dry-run writes both documents to <project>/rag/<slug>/ and pushes nothing, which
// is the way to read exactly what would be published before it is.
import fs from 'node:fs';
import path from 'node:path';
import { renderFullDossier, renderGroupReadme, renderRagProfile } from '../src/gmapmarkdown.js';
import { ensureGroup, groupSlug, publicUrl, putDocument, putReadme, RAG_BUCKET_URL } from '../src/ragbucket.js';
import { LeadStore } from '../src/leads.js';
import { projectDir, projectsRoot } from '../src/gmapproject.js';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string): boolean => argv.includes(`--${name}`);

const dryRun = has('dry-run');
const publicOnly = has('public-only');
const onlyProject = flag('project');
const onlyCompany = flag('company')?.toLowerCase();

const PUBLIC_DOC = 'company-profile.md';
const INTERNAL_DOC = 'internal-research-dossier.md';

const projects = onlyProject
  ? [onlyProject]
  : fs.readdirSync(projectsRoot()).filter((d) => fs.existsSync(path.join(projectsRoot(), d, 'project.json')));

let pushed = 0;
let skipped = 0;
const failures: string[] = [];

console.log(dryRun ? 'DRY RUN — nothing will be published\n' : `Publishing to ${RAG_BUCKET_URL}\n`);

for (const id of projects) {
  const dir = projectDir(id);
  const store = new LeadStore(path.join(dir, 'leads.db'));
  const rows = new Map(store.rows().map((r) => [r.placeId, r]));

  const dossiers = store
    .allDossiers()
    .filter((d) => !onlyCompany || d.companyName.toLowerCase().includes(onlyCompany));

  if (!dossiers.length) {
    console.log(`${id}: nothing to push`);
    continue;
  }

  for (const d of dossiers) {
    // A failed or partial research run has nothing worth publishing under the
    // company's own name, and a half-written profile is worse than none.
    if (d.status !== 'completed') {
      console.log(`  SKIP  ${d.companyName} — research status is "${d.status}"`);
      skipped++;
      continue;
    }

    const biz = rows.get(d.placeId);
    const slug = groupSlug(d.companyName);
    const profile = renderRagProfile(d, biz);
    const internal = renderFullDossier(d, biz);
    const docs = [
      { filename: PUBLIC_DOC, what: 'company profile, products and services, and contact details' },
      ...(publicOnly ? [] : [{ filename: INTERNAL_DOC, what: 'internal research record' }]),
    ];
    const readme = renderGroupReadme(d, docs);

    const kb = (s: string): string => `${(Buffer.byteLength(s, 'utf8') / 1024).toFixed(0)}KB`;

    if (dryRun) {
      const out = path.join(dir, 'rag', slug);
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'README.md'), readme, 'utf8');
      fs.writeFileSync(path.join(out, PUBLIC_DOC), profile, 'utf8');
      if (!publicOnly) fs.writeFileSync(path.join(out, INTERNAL_DOC), internal, 'utf8');
      console.log(`  WOULD PUSH  /r/${slug}  ${PUBLIC_DOC} ${kb(profile)}${publicOnly ? '' : `, ${INTERNAL_DOC} ${kb(internal)}`}`);
      console.log(`              written to ${path.relative(dir, out)}`);
      pushed++;
      continue;
    }

    try {
      const { created } = await ensureGroup({
        company: d.companyName,
        slug,
        description: `Knowledge base for ${d.companyName}`,
        readme,
      });
      // POST only sets the readme when it creates the group; a re-push must update it.
      if (!created) await putReadme(slug, readme);

      await putDocument(slug, PUBLIC_DOC, profile, 'Company profile, products and services, contact details');
      if (!publicOnly) {
        await putDocument(slug, INTERNAL_DOC, internal, 'Internal research record');
      }

      console.log(`  ${created ? 'CREATED' : 'UPDATED'}  ${publicUrl(slug)}  (${kb(profile)}${publicOnly ? '' : ` + ${kb(internal)}`})`);
      pushed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  FAILED  ${d.companyName} — ${msg}`);
      failures.push(`${d.companyName}: ${msg}`);
    }
  }
}

console.log(
  `\n${dryRun ? 'would push' : 'pushed'} ${pushed}` +
    `${skipped ? `, skipped ${skipped}` : ''}` +
    `${failures.length ? `, FAILED ${failures.length}` : ''}`,
);
if (failures.length) process.exitCode = 1;
