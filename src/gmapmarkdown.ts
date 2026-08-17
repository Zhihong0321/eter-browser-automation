// src/gmapmarkdown.ts — the dossier as Markdown, in two very different documents.
//
// These two renderers exist because the same research serves two opposed audiences,
// and mixing them is a real hazard rather than an aesthetic one.
//
//   renderRagProfile()   PUBLIC. Feeds the company's OWN customer-facing chatbot and
//                        is served from a public URL. It must read like the company
//                        describing itself: what they do, what they sell, who to
//                        contact. Everything evaluative is stripped.
//
//   renderFullDossier()  INTERNAL. The complete sales-intelligence record, risks and
//                        legitimacy score included — the Markdown twin of the HTML
//                        dossier, for our own retrieval.
//
// What the public profile deliberately omits, and why each one would be a problem in
// a chatbot the company's customers talk to:
//
//   legitimacyScore/verdict  our 0-100 scoring OF them. "Legitimacy 61/100" is an
//                            internal judgement, and it reads as an accusation.
//   risks                    explicitly excluded on instruction, and correctly so.
//   buyingSignals            "they are hiring, so call now" is our sales timing, not
//                            a fact about their business that a customer should hear.
//   unknowns                 a list of what WE could not verify about them.
//   pageInsight              a score saying their own website is slow.
//   dead/expired domain      an infrastructure failing, not company information.
//   stageLog                 our plumbing.
//   per-person contacts      names and roles are ordinary "About us" content, but a
//                            mobile number scraped from a directory is not something
//                            to republish on a public URL under their name. Company
//                            channels go in; personal ones stay out.
//
// Nothing is invented in either document. A field the research could not establish is
// left out of the public profile entirely — a customer-facing page must not carry
// "not established", which is a research artefact and reads as an admission.

import type { BusinessRow } from './leads.js';
import type { CompanyDossier } from './enrich/types.js';

/** Markdown control characters that would break a table cell or invent emphasis. */
const md = (s: unknown): string =>
  String(s ?? '').replace(/([\\`*_[\]<>|])/g, '\\$1').replace(/\r?\n/g, ' ').trim();

/** Body prose keeps its newlines; only pipes and backticks are dangerous there. */
const prose = (s: unknown): string => String(s ?? '').replace(/\r\n/g, '\n').trim();

const section = (title: string, body: string): string => (body.trim() ? `## ${title}\n\n${body.trim()}\n` : '');

/** `- **Label:** value`, dropped entirely when there is no value. */
const bullet = (label: string, value: unknown): string =>
  value === null || value === undefined || value === '' ? '' : `- **${label}:** ${md(value)}\n`;

/* ---- keeping personal contact details out of the public document ------------ */

/** Last nine digits: ignores the +60 prefix and trunk zero, which is what varies. */
const phoneKey = (s: string): string => s.replace(/\D/g, '').slice(-9);

/**
 * Contact details that reached us attached to a named individual.
 *
 * This is not a theoretical precaution. The pipeline folds `facts.extraPhones` — the
 * numbers the research ask found next to a person's name — straight into
 * `contactMatrix.allPhones`, and even sets `primaryPhone` from them when the row had
 * none. Publishing that list wholesale therefore republishes a private mobile on a
 * public URL under the company's name. A switchboard number from the company's own
 * Google Maps listing is public information; a director's handphone scraped out of a
 * directory is not, and the two are indistinguishable once they are in the same array.
 */
function personalContacts(d: CompanyDossier): { phones: Set<string>; emails: Set<string> } {
  const phones = new Set<string>();
  const emails = new Set<string>();
  // Merged facts (chatgpt + agy), not chatgpt's alone — a person agy found on the
  // second pass carries a personal contact exactly as easily as one chatgpt found,
  // and reading only chatgpt.facts here would let that number through unfiltered.
  const facts = d.combinedFacts !== undefined ? d.combinedFacts : d.chatgpt?.facts;
  const attached = [
    ...(facts?.people ?? []).map((p) => p.contact),
    ...d.contactMatrix.keyContacts.map((k) => k.contact),
  ];
  for (const raw of attached) {
    const v = (raw ?? '').trim();
    if (!v) continue;
    if (v.includes('@')) emails.add(v.toLowerCase());
    else if (phoneKey(v).length >= 7) phones.add(phoneKey(v));
  }
  return { phones, emails };
}

/**
 * Channels the company itself would publish, as an allow-list.
 *
 * `contactMatrix.socialLinks` is not a list of social profiles — the pipeline also
 * pushes research sources into it, and a live run put a CTOS credit report URL and a
 * Maukerja job-listing profile in there. Publishing those on the company's own
 * customer-facing page would hand their customers a credit file on them. An
 * allow-list is the right shape rather than a denylist: a source added to the
 * pipeline later stays internal by default instead of leaking the first time it runs.
 *
 * WhatsApp is excluded here because it already has its own line above.
 */
const PUBLIC_PLATFORMS = new Set(['facebook', 'instagram', 'linkedin', 'tiktok', 'youtube', 'twitter', 'x']);

const publicSocials = (links: { platform: string; url: string }[]): { platform: string; url: string }[] =>
  links.filter((s) => PUBLIC_PLATFORMS.has(s.platform.trim().toLowerCase()) && !!s.url);

/** Research placeholders that must not surface as a job title on a public page. */
const cleanRole = (role: string): string =>
  /^(unstated|unknown|n\/?a|not stated|—|-)$/i.test(role.trim()) ? '' : role.trim();

/* ---- the public RAG profile ------------------------------------------------- */

export function renderRagProfile(d: CompanyDossier, biz?: BusinessRow): string {
  // Merged view (chatgpt + agy) — see combinedFacts on CompanyDossier. Only the
  // same fields this function already read are exposed here (MSIC, revenue line,
  // clients, people, …); risks/unknowns/buyingSignals stay excluded exactly as
  // before, regardless of which pass a fact came from.
  const f = d.combinedFacts !== undefined ? d.combinedFacts : (d.chatgpt?.facts ?? null);
  const cm = d.contactMatrix;
  const dom = d.domain;
  const name = d.companyName;

  // Identity: the registry facts that describe the entity, not our opinion of it.
  const identity =
    bullet('Registered name', dom?.registrantOrganization && dom.registrantOrganization.toLowerCase() !== name.toLowerCase()
      ? dom.registrantOrganization
      : null) +
    bullet('SSM registration', f?.ssm ?? d.newpages?.ssm) +
    bullet('Incorporated', f?.incorporatedOn) +
    bullet('Industry classification (MSIC)', f?.msic) +
    bullet('Business type', biz?.category ?? d.linkedin?.industry) +
    // A live registration date is ordinary "established since" content. An expired or
    // unregistered domain is an infrastructure problem and is never published here —
    // the same reason the Wayback line right below is gated off a dead domain too:
    // "online since 2015" reads as a live claim, and the site is not live.
    bullet('Website online since', dom?.registered === true && !dom.expired ? dom.createdAt?.slice(0, 10) : null) +
    bullet('Earliest web presence', d.archive?.hasSnapshots && dom?.registered !== false ? d.archive.firstCaptureAt?.slice(0, 10) : null) +
    bullet('Company size', d.linkedin?.companySize ?? f?.headcount);

  const offering =
    bullet('Primary products and services', f?.primaryRevenueLine) +
    bullet('Customers served', f?.customerSegment) +
    bullet('Specialities', d.linkedin?.specialties?.length ? d.linkedin.specialties.join(', ') : null) +
    bullet('Business scope', d.newpages?.businessNature ?? d.newpages?.classifieds);

  // Company channels only — anything a named person carried is filtered out here,
  // including from `primaryPhone`, which the pipeline may have set from a person.
  const personal = personalContacts(d);
  const phones = cm.allPhones.filter((p) => !personal.phones.has(phoneKey(p)));
  const emails = cm.allEmails.filter((e) => !personal.emails.has(e.toLowerCase()));
  const primaryPhone = phones.includes(cm.primaryPhone ?? '') ? cm.primaryPhone : (phones[0] ?? null);
  const primaryEmail = emails.includes(cm.primaryEmail ?? '') ? cm.primaryEmail : (emails[0] ?? null);
  const otherPhones = phones.filter((p) => p !== primaryPhone);
  const otherEmails = emails.filter((e) => e !== primaryEmail);

  const contact =
    bullet('Phone', primaryPhone) +
    (otherPhones.length ? bullet('Other phone lines', otherPhones.join(', ')) : '') +
    bullet('Email', primaryEmail) +
    (otherEmails.length ? bullet('Other email addresses', otherEmails.join(', ')) : '') +
    bullet('WhatsApp', cm.whatsapp && !personal.phones.has(phoneKey(cm.whatsapp)) ? cm.whatsapp : null) +
    // A dead domain is not offered to customers as a way to reach the company.
    bullet('Website', dom?.registered === false ? null : (cm.website ?? biz?.website)) +
    bullet('Address', cm.officialAddresses[0] ?? biz?.address) +
    (publicSocials(cm.socialLinks).length
      ? `\n${publicSocials(cm.socialLinks).map((s) => `- ${md(s.platform)}: ${md(s.url)}`).join('\n')}\n`
      : '');

  // Names and roles only. Whatever contact detail research attached to a person stays
  // in the internal document — this file is served from a public URL.
  const people = (f?.people ?? [])
    .concat(cm.keyContacts.map((k) => ({ name: k.name, role: k.role, source: k.source, contact: null })))
    .filter((p, i, arr) => arr.findIndex((x) => x.name.toLowerCase() === p.name.toLowerCase()) === i);

  const team = people.length
    ? `| Name | Role |\n| --- | --- |\n${people.map((p) => `| ${md(p.name)} | ${md(cleanRole(p.role))} |`).join('\n')}\n`
    : '';

  const clients = f?.clients.length
    ? f.clients
        .map((c) => `- ${md(c.name)}${c.year ? ` (${md(c.year)})` : ''}${c.delivered ? ` — ${md(c.delivered)}` : ''}`)
        .join('\n') + '\n'
    : '';

  const reputation =
    bullet('Google Maps rating', biz?.rating ? `${biz.rating} out of 5 across ${biz.reviews ?? 0} reviews` : null) +
    bullet('Facebook following', d.facebook?.followers) +
    bullet('Facebook page', d.facebook?.pageUrl) +
    bullet('LinkedIn', d.linkedin?.companyUrl);

  const about = prose(d.facebook?.bio) || prose(d.linkedin?.summary);

  const body = [
    `# ${name}\n`,
    about ? `${about}\n` : '',
    section('Company information', identity),
    section('Products and services', offering),
    section('About', ''),
    section('How to contact us', contact),
    section('Our team', team),
    section('Selected clients and projects', clients),
    section('Presence and reputation', reputation),
  ].filter(Boolean).join('\n');

  return (
    body.replace(/\n{3,}/g, '\n\n').trim() +
    `\n\n---\n\nCompany knowledge base for ${md(name)}. ` +
    `Compiled from public sources on ${d.updatedAt.slice(0, 10)}.\n`
  );
}

/* ---- the internal full dossier ---------------------------------------------- */

export function renderFullDossier(d: CompanyDossier, biz?: BusinessRow): string {
  const f = d.combinedFacts !== undefined ? d.combinedFacts : (d.chatgpt?.facts ?? null);
  const cm = d.contactMatrix;
  const dom = d.domain;

  const domainBlock = !dom
    ? ''
    : dom.registered === false
      ? `**DEAD WEBSITE.** The URL on the Google Maps listing points at \`${md(dom.domain)}\`, which no ` +
        `registry has a record of. It cannot resolve.\n`
      : dom.source === 'platform' || dom.source === 'unsupported'
        ? `${md(dom.note)}\n`
        : bullet('Domain', dom.domain) +
          bullet('Registrant organisation', dom.registrantOrganization ??
            (dom.source === 'rdap'
              ? 'redacted by the registry (ICANN post-GDPR policy)'
              : 'not published for this registration class')) +
          bullet('Registered', dom.createdAt?.slice(0, 10)) +
          bullet('Domain age', dom.ageYears !== undefined ? `${dom.ageYears} years` : null) +
          bullet('Expires', dom.expiresAt?.slice(0, 10)) +
          bullet('Registrar', dom.registrar) +
          bullet('Registrant state', dom.registrantState) +
          (dom.expired ? '- **REGISTRATION EXPIRED**\n' : '') +
          (dom.registrantOrganization
            ? '\n> The registrant organisation is self-declared at registration and is not verified against SSM.\n'
            : '');

  // Wayback is the one source here that still has something to say about a domain
  // nobody owns any more — see the DEAD WEBSITE line above, which this
  // corroborates rather than repeats. Unabridged: every field the pipeline
  // captured, including which contacts came from an archived snapshot rather
  // than the live page, unlike the single curated bullet the public RAG profile
  // gets (renderRagProfile, above).
  const archive = d.archive;
  const archiveSpanYears =
    archive?.firstCaptureAt && archive?.lastCaptureAt
      ? Math.round(((Date.parse(archive.lastCaptureAt) - Date.parse(archive.firstCaptureAt)) / 31_557_600_000) * 10) / 10
      : null;
  const archiveBlock =
    !archive || !archive.checked
      ? ''
      : !archive.hasSnapshots
        ? `${md(archive.note ?? 'no Wayback captures on record')}\n`
        : (dom?.registered === false
            ? `**The dead domain WAS a real, live site** — archived ${md(archive.firstCaptureAt?.slice(0, 10) ?? '—')} ` +
              `through ${md(archive.lastCaptureAt?.slice(0, 10) ?? '—')}, before the registration lapsed.\n\n`
            : '') +
          bullet('Domain', archive.domain) +
          bullet('First captured', archive.firstCaptureAt?.slice(0, 10)) +
          bullet('Last captured', archive.lastCaptureAt?.slice(0, 10)) +
          bullet('Capture span', archiveSpanYears !== null ? `${archiveSpanYears} years` : null) +
          bullet('Last capture status', archive.lastCaptureStatus) +
          bullet('Last snapshot', archive.lastCaptureUrl) +
          (archive.recoveredContacts
            ? `\n> Contacts recovered from this snapshot — the live site could not be read.\n\n` +
              bullet('Recovered email', archive.recoveredContacts.email ?? archive.recoveredContacts.emails[0] ?? null) +
              bullet('Recovered Facebook', archive.recoveredContacts.facebook) +
              bullet('Recovered Instagram', archive.recoveredContacts.instagram) +
              bullet('Recovered WhatsApp', archive.recoveredContacts.whatsapp) +
              bullet('Recovered LinkedIn', archive.recoveredContacts.linkedin)
            : '');

  const body = [
    `# ${d.companyName} — deep research dossier\n`,
    `**Assessment:** ${md(d.verdict)} (${d.legitimacyScore}/100) · researched ${d.updatedAt.slice(0, 10)}\n`,
    section('Executive brief', prose(d.executiveSummary)),
    section(
      'Buying signals',
      (f?.buyingSignals ?? [])
        .map((s) => `- ${md(s.signal)}${s.date ? ` (${md(s.date)})` : ''} — source: ${md(s.source)}`)
        .join('\n'),
    ),
    section(
      'Named people',
      f?.people.length || cm.keyContacts.length
        ? `| Name | Role | Reach | Source |\n| --- | --- | --- | --- |\n` +
          [
            ...(f?.people ?? []).map((p) => ({ ...p, contact: p.contact })),
            ...cm.keyContacts.map((k) => ({ name: k.name, role: k.role, contact: k.contact ?? null, source: k.source })),
          ]
            .filter((p, i, a) => a.findIndex((x) => x.name.toLowerCase() === p.name.toLowerCase()) === i)
            .map((p) => `| ${md(p.name)} | ${md(p.role)} | ${md(p.contact ?? '—')} | ${md(p.source)} |`)
            .join('\n')
        : '',
    ),
    section('Domain registry', domainBlock),
    section('Web archive', archiveBlock),
    section(
      'Company registry',
      bullet('SSM', f?.ssm ?? d.newpages?.ssm) +
        bullet('Incorporated', f?.incorporatedOn) +
        bullet('Company age', f?.companyAgeYears !== null && f?.companyAgeYears !== undefined ? `${f.companyAgeYears} years` : null) +
        bullet('MSIC', f?.msic) +
        bullet('Paid-up capital', f?.paidUpCapital) +
        bullet('Headcount', f?.headcount) +
        bullet('Headcount source', f?.headcountSource),
    ),
    section(
      'Commercial profile',
      bullet('Sells', f?.primaryRevenueLine) +
        bullet('Buyers', f?.customerSegment) +
        (f?.clients.length
          ? `\n${f.clients.map((c) => `- ${md(c.name)}${c.year ? ` (${md(c.year)})` : ''}${c.delivered ? ` — ${md(c.delivered)}` : ''}`).join('\n')}\n`
          : ''),
    ),
    section(
      'Contacts',
      bullet('Phone', cm.primaryPhone) +
        bullet('All phones', cm.allPhones.join(', ') || null) +
        bullet('Email', cm.primaryEmail) +
        bullet('All emails', cm.allEmails.join(', ') || null) +
        bullet('WhatsApp', cm.whatsapp) +
        bullet('Website', cm.website ?? biz?.website) +
        bullet('Address', cm.officialAddresses.join(' · ') || biz?.address),
    ),
    section(
      'Website performance',
      d.pageInsight?.ok
        ? bullet('Performance', d.pageInsight.scores.performance !== null
            ? `${d.pageInsight.scores.performance}/100${d.pageInsight.performanceEstimated ? ' (estimated)' : ''}`
            : null) +
          bullet('SEO', d.pageInsight.scores.seo !== null ? `${d.pageInsight.scores.seo}/100` : null) +
          bullet('LCP', d.pageInsight.metrics.lcpMs !== null ? `${(d.pageInsight.metrics.lcpMs / 1000).toFixed(1)}s` : null) +
          (d.pageInsight.opportunities.length
            ? `\n${d.pageInsight.opportunities.map((o) => `- ${md(o.title)}`).join('\n')}\n`
            : '')
        : '',
    ),
    // Risks are the whole reason the public profile is a separate document.
    section('Risks and red flags', (f?.risks ?? []).map((r) => `- ${md(r)}`).join('\n')),
    section('Not established', f?.unknowns.length ? f.unknowns.map((u) => `- ${md(u)}`).join('\n') : ''),
    section(
      'Stage log',
      d.stageLog?.length
        ? `| Stage | Result | Detail |\n| --- | --- | --- |\n` +
          d.stageLog.map((s) => `| ${md(s.stage)} | ${md(s.status)} | ${md(s.detail)} |`).join('\n')
        : '',
    ),
    d.chatgpt?.ok && d.chatgpt.brief ? section('Full research brief (pass 1, ChatGPT)', prose(d.chatgpt.brief)) : '',
    // Kept as its own section, never blended into pass 1's prose above — same
    // reasoning as the HTML report's separate collapsible section: what agy
    // actually wrote should always be readable on its own, not only through
    // the merged facts above it.
    d.agy?.ok && d.agy.brief ? section('Second-pass research (agy) — gaps & news', prose(d.agy.brief)) : '',
  ].filter(Boolean).join('\n');

  return body.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/* ---- the group retrieval guide ---------------------------------------------- */

/**
 * README.md for the group — the file the RAG service serves first at `/r/{group}`.
 * It tells a retrieving AI which document to read, which is the whole point of the
 * entrypoint, and it must not leak the internal document's framing.
 */
export function renderGroupReadme(d: CompanyDossier, docs: { filename: string; what: string }[]): string {
  return (
    `# ${md(d.companyName)} — knowledge base\n\n` +
    `Company knowledge for ${md(d.companyName)}, for answering questions about the business, ` +
    `its products and services, and how to get in touch.\n\n` +
    `## Documents\n\n` +
    docs.map((x) => `- \`${md(x.filename)}\` — ${md(x.what)}`).join('\n') +
    `\n\n## How to answer\n\n` +
    `- Answer only from these documents. If something is not in them, say so rather than guessing.\n` +
    `- Quote contact details exactly as written.\n` +
    `- Last updated ${d.updatedAt.slice(0, 10)}.\n`
  );
}
