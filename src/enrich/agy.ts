// src/enrich/agy.ts — Deep Web Research & AI Synthesis Engine.
import type { BusinessRow } from '../leads.js';
import type { ArchiveIntel, ChatGptIntel, ContactMatrix, DomainIntel, FacebookIntel, KeyContact, LinkedInIntel, NewpagesIntel, PageInsightIntel, WebSearchIntel } from './types.js';
import { assistantText, stepfunAgent } from '../agent.js';
import { isDeadDomain } from './domain.js';

export function calculateLegitimacyScore(
  biz: BusinessRow,
  newpages?: NewpagesIntel,
  fb?: FacebookIntel,
  li?: LinkedInIntel,
  chatgpt?: ChatGptIntel,
  domain?: DomainIntel,
  archive?: ArchiveIntel,
): { score: number; verdict: string } {
  let score = 20; // Base score for having an indexed Google Maps business profile

  if (newpages?.found) {
    score += 20;
    if (newpages.ssm) score += 15; // Official SSM verification
  }

  if (biz.website) score += 10;
  if (biz.email) score += 10;
  if (biz.phone) score += 5;
  if (biz.rating && biz.rating >= 4.0 && (biz.reviews ?? 0) > 10) score += 10;

  if (fb?.found) {
    score += 5;
    if (fb.followers) score += 5;
  }

  if (li?.found) {
    score += 5;
    if (li.companySize) score += 5;
  }

  // Everything above scores the PRESENCE of a field, which is why a company with a
  // website and a phone outscored one that is demonstrably trading. These four score
  // what was actually established about the business.
  const facts = chatgpt?.facts;
  if (facts) {
    // A named human is the difference between a lead you can call and a row in a table.
    if (facts.people.length) score += 5;
    // Evidence of current spend — hiring, expansion, new premises.
    if (facts.buyingSignals.length) score += 5;
    // Survived its first two years, which is where most Sdn Bhd registrations stop.
    if (facts.companyAgeYears !== null && facts.companyAgeYears >= 2) score += 5;
    if (facts.clients.length >= 3) score += 5;
    // Research that could not corroborate its own findings should not lift a score.
    if (facts.confidence === 'low') score -= 10;
  }

  // The registry is the one source here nobody can self-publish into. `biz.website`
  // already scored 10 for the mere presence of a URL, which is what let a company
  // whose domain expired outscore one still paying to renew.
  if (domain) {
    if (isDeadDomain(domain)) {
      // Published a website on Maps that nobody owns. That is worse than having no
      // website at all, so it takes back the +10 that presence alone earned.
      score -= 15;
    } else if (domain.registered) {
      // A registrant organisation is a registry-held legal entity name — the
      // strongest identity signal available without an SSM search.
      if (domain.registrantOrganization) score += 10;
      if (domain.ageYears !== undefined && domain.ageYears >= 3) score += 5;
      if (domain.expired) score -= 5;
    }
  }

  // Wayback is the one source here that still has something to say about a domain
  // nobody owns any more. A site captured for a real stretch of time before the
  // domain lapsed was a trading business at some point — worth some of the -15
  // back, rather than reading identically to a domain that was never registered
  // at all. It also stands in for `domain.ageYears` when the registry can't give
  // one (RDAP redaction on a gTLD, a blank MYNIC registrant).
  if (archive?.hasSnapshots && archive.firstCaptureAt) {
    const spanYears = archive.lastCaptureAt
      ? (Date.parse(archive.lastCaptureAt) - Date.parse(archive.firstCaptureAt)) / 31_557_600_000
      : 0;
    if (isDeadDomain(domain) && spanYears >= 1) score += 5;
    if (domain?.registered && domain.ageYears === undefined && spanYears >= 3) score += 5;
  }

  score = Math.max(0, Math.min(100, score));

  let verdict = 'Unverified Local Business';
  if (score >= 80) verdict = 'Verified Corporate / Established SME';
  else if (score >= 60) verdict = 'Active Commercial Business';
  else if (score >= 40) verdict = 'Registered Local Entity';

  return { score, verdict };
}

export function buildContactMatrix(
  biz: BusinessRow,
  newpages?: NewpagesIntel,
  fb?: FacebookIntel,
  li?: LinkedInIntel,
): ContactMatrix {
  const allPhones = new Set<string>();
  if (biz.phone) allPhones.add(biz.phone);
  if (newpages?.tel) allPhones.add(newpages.tel);
  if (newpages?.mobile) allPhones.add(newpages.mobile);
  if (fb?.phone) allPhones.add(fb.phone);

  const allEmails = new Set<string>();
  if (biz.email) allEmails.add(biz.email);
  if (biz.emails) {
    try {
      const parsed = JSON.parse(biz.emails) as string[];
      parsed.forEach((e) => allEmails.add(e));
    } catch {
      // Ignored
    }
  }
  if (newpages?.email) allEmails.add(newpages.email);
  if (fb?.email) allEmails.add(fb.email);

  const addresses = new Set<string>();
  if (biz.address) addresses.add(biz.address);
  if (newpages?.address) addresses.add(newpages.address);
  if (fb?.address) addresses.add(fb.address);

  const socialLinks: { platform: string; url: string }[] = [];
  if (biz.facebook || fb?.pageUrl) socialLinks.push({ platform: 'Facebook', url: (fb?.pageUrl || biz.facebook)! });
  if (biz.instagram) socialLinks.push({ platform: 'Instagram', url: biz.instagram });
  if (biz.whatsapp || newpages?.mobile) socialLinks.push({ platform: 'WhatsApp', url: (biz.whatsapp || (newpages?.mobile ? `https://wa.me/${newpages.mobile}` : ''))! });
  if (biz.linkedin || li?.companyUrl) socialLinks.push({ platform: 'LinkedIn', url: (li?.companyUrl || biz.linkedin)! });

  const keyContacts: KeyContact[] = [];
  if (newpages?.picName) {
    keyContacts.push({
      name: newpages.picName,
      role: 'Person-in-Charge / Representative',
      contact: newpages.mobile || newpages.tel,
      source: 'Newpages Directory',
    });
  }

  if (li?.keyPeople?.length) {
    li.keyPeople.forEach((p) => {
      keyContacts.push({
        name: p.name,
        role: p.title,
        contact: p.profileUrl,
        source: 'LinkedIn',
      });
    });
  }

  return {
    primaryPhone: biz.phone || newpages?.tel || newpages?.mobile || fb?.phone || null,
    allPhones: [...allPhones],
    primaryEmail: biz.email || newpages?.email || fb?.email || null,
    allEmails: [...allEmails],
    whatsapp: biz.whatsapp || (newpages?.mobile ? `https://wa.me/${newpages.mobile}` : null),
    website: biz.website || newpages?.website || null,
    officialAddresses: [...addresses],
    socialLinks,
    keyContacts,
  };
}

export async function synthesizeDossier(
  biz: BusinessRow,
  newpages?: NewpagesIntel,
  fb?: FacebookIntel,
  li?: LinkedInIntel,
  web?: WebSearchIntel,
  chatgpt?: ChatGptIntel,
  pageInsight?: PageInsightIntel,
  domain?: DomainIntel,
  archive?: ArchiveIntel,
): Promise<{ executiveSummary: string; legitimacyScore: number; verdict: string }> {
  const { score, verdict } = calculateLegitimacyScore(biz, newpages, fb, li, chatgpt, domain, archive);
  const facts = chatgpt?.facts;

  // Deterministic summary fallback
  let summary = `### Executive Summary: ${biz.name}\n\n`;
  summary += `**Category:** ${biz.category || 'General Business'}\n`;
  summary += `**Legitimacy Assessment:** ${verdict} (Score: ${score}/100)\n\n`;

  if (newpages?.ssm) {
    summary += `- **SSM Registration:** \`${newpages.ssm}\` (Verified via Malaysian Business Registry)\n`;
  }
  // A dead website leads, because it is published on their Maps listing and anyone
  // working this lead will try it. The registrant organisation earns its place for
  // the opposite reason: it is the one identity claim here that the company could
  // not have self-published.
  if (isDeadDomain(domain)) {
    summary += `- **⚠ Website is a dead domain:** \`${domain?.domain}\` has no registry record and does not resolve — the URL on their Google Maps listing goes nowhere.\n`;
  } else if (domain?.registrantOrganization) {
    summary += `- **Domain Registrant:** ${domain.registrantOrganization}${domain.registrantState ? `, ${domain.registrantState}` : ''} — registry-held holder of \`${domain.domain}\` (self-declared at registration, not SSM-verified)\n`;
  }
  if (domain?.registered && domain.createdAt) {
    summary += `- **Online Since:** ${domain.createdAt.slice(0, 10)}${domain.ageYears !== undefined ? ` (domain is ${domain.ageYears} years old)` : ''}${domain.expired ? ' — **registration has EXPIRED**' : ''}\n`;
  }
  if (domain?.source === 'platform') {
    summary += `- **No Own Domain:** their only web presence is a ${domain.domain} page.\n`;
  }
  // Built as a standalone string for the same reason `speedLine` below is: the LLM
  // branch REPLACES this summary wholesale, and a fact this specific — a dead
  // domain's site was real once, or a redacted domain has an independent age —
  // must not be able to vanish just because a summariser found it uninteresting.
  const archiveLine =
    archive?.hasSnapshots && archive.firstCaptureAt
      ? isDeadDomain(domain)
        ? `- **Wayback History:** the dead domain was archived from ${archive.firstCaptureAt.slice(0, 10)} to ${archive.lastCaptureAt?.slice(0, 10) ?? 'recently'} — it WAS a real, live site before the registration lapsed.\n`
        : `- **Web Footprint Since:** first archived ${archive.firstCaptureAt.slice(0, 10)}, last seen ${archive.lastCaptureAt?.slice(0, 10) ?? '—'}.\n`
      : '';
  if (archiveLine) summary += archiveLine;
  if (facts?.incorporatedOn) {
    summary += `- **Incorporated:** ${facts.incorporatedOn}${facts.companyAgeYears ? ` (${facts.companyAgeYears} years old)` : ''}\n`;
  }
  if (facts?.primaryRevenueLine) {
    summary += `- **Primary Revenue Line:** ${facts.primaryRevenueLine}\n`;
  }
  if (facts?.customerSegment) {
    summary += `- **Sells To:** ${facts.customerSegment}\n`;
  }
  if (facts?.headcount) {
    summary += `- **Headcount:** ${facts.headcount}${facts.headcountSource ? ` (${facts.headcountSource})` : ''}\n`;
  }
  if (newpages?.businessNature || newpages?.classifieds) {
    summary += `- **Business Scope:** ${newpages.businessNature || newpages.classifieds}\n`;
  }
  if (fb?.followers) {
    summary += `- **Social Reach:** ${fb.followers} followers on Facebook\n`;
  }
  if (li?.companySize) {
    summary += `- **Organization Scale:** ${li.companySize} (Industry: ${li.industry || 'Commercial'})\n`;
  }
  if (biz.rating) {
    summary += `- **Customer Reputation:** ${biz.rating}★ across ${biz.reviews || 0} Google Maps reviews\n`;
  }
  // A measured number about their own property is the most concrete opener a caller
  // has, so it goes in the 60-second brief rather than only in the detail cards. The
  // source is named inline: an estimate quoted as Google's grade is a liability the
  // moment the prospect runs PageSpeed themselves.
  //
  // Built as a standalone string because the LLM branch below REPLACES this summary
  // wholesale, and this is the one line in it that is a direct measurement rather
  // than a restatement of the research. Losing it is how a benchmark that ran
  // perfectly still reaches the reader as nothing at all.
  const speedLine =
    pageInsight?.scores.performance == null
      ? ''
      : `- **Website Speed:** ${pageInsight.scores.performance}/100 (` +
        `${pageInsight.source === 'psi' ? `Google PageSpeed ${pageInsight.strategy}` : `local ${pageInsight.strategy} benchmark, estimated`})` +
        `${pageInsight.metrics.lcpMs ? `, LCP ${(pageInsight.metrics.lcpMs / 1000).toFixed(1)}s` : ''}` +
        `${pageInsight.field?.verdict ? ` — real visitors: ${pageInsight.field.verdict}` : ''}`;
  if (speedLine) summary += `${speedLine}\n`;
  if (facts?.people.length) {
    summary += `- **Named People:** ${facts.people.map((p) => `${p.name} (${p.role})`).join(', ')}\n`;
  }
  if (facts?.buyingSignals.length) {
    summary += `\n**Buying signals:**\n${facts.buyingSignals.map((s) => `- ${s.signal}${s.date ? ` — ${s.date}` : ''} [${s.source}]`).join('\n')}\n`;
  }
  if (facts?.risks.length) {
    summary += `\n**Risks:**\n${facts.risks.map((r) => `- ${r}`).join('\n')}\n`;
  }
  if (facts?.unknowns.length) {
    summary += `\n**Not established (${facts.unknowns.length}):** ${facts.unknowns.join('; ')}\n`;
  }

  // If an LLM is configured, use it to COMPRESS the research rather than to pad the
  // structured fields. Handing it the raw record and asking for three paragraphs
  // made it restate its own input in longer sentences; the brief is the thing worth
  // summarising, and it is far too long to read in a modal.
  if (process.env.STEPFUN_API_KEY?.trim()) {
    try {
      const evidence = chatgpt?.ok && chatgpt.brief
        ? `Research brief:\n${chatgpt.brief.slice(0, 24_000)}\n\nStructured record:\n${JSON.stringify({ biz, domain, archive, newpages, fb, li, web, pageInsight }, null, 2)}`
        : `Structured record:\n${JSON.stringify({ biz, domain, archive, newpages, fb, li, web, pageInsight }, null, 2)}`;

      const prompt = `You are a corporate intelligence analyst writing the top of a sales dossier. Compress the evidence below into a briefing a salesperson reads in 60 seconds before a first call.

Rules:
- Lead with what this company SELLS and WHO BUYS IT. Not adjectives about professionalism.
- Name every human found and how to reach them.
- State the strongest reason to call them NOW, citing the dated evidence for it.
- State the single biggest unknown that should be asked on the call.
- Never introduce a fact that is not in the evidence. If the evidence says UNKNOWN, keep it UNKNOWN.
${speedLine ? `- The evidence carries a measured page-speed score for their website. Include it verbatim as its own bullet: "${speedLine}"\n` : ''}${archiveLine ? `- The evidence carries a Wayback Machine capture history for their website. Include it verbatim as its own bullet: "${archiveLine}"\n` : ''}- Clean markdown, under 400 words, bullets over prose.

${evidence}`;

      let aiResponse = '';
      for await (const msg of stepfunAgent(prompt)) {
        if (msg.type === 'assistant') {
          aiResponse += assistantText(msg);
        }
      }
      // Only replace the deterministic summary when the model actually returned a
      // briefing. A short reply here is a truncated or refused generation, and
      // overwriting real structured findings with it is a net loss of information.
      if (aiResponse.trim().length > 400) {
        summary = aiResponse.trim();
        // Asking the model for the line is not the same as getting it. Measured
        // 2026-08-17 on KRCB Eco Majestic: the dossier carried a real PSI score of
        // 32/100 and the rewritten brief mentioned nothing about the website at
        // all. So the line is put back if the model dropped it — a measurement must
        // not be able to vanish because a summariser found it uninteresting.
        if (speedLine && !/website speed|pagespeed|page speed/i.test(summary)) {
          summary += `\n\n${speedLine}`;
        }
        if (archiveLine && !/wayback|web footprint|web archive/i.test(summary)) {
          summary += `\n\n${archiveLine}`;
        }
      }
    } catch {
      // Keep deterministic summary on error
    }
  }

  return { executiveSummary: summary, legitimacyScore: score, verdict };
}
