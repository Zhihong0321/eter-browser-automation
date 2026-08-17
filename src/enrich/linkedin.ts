// src/enrich/linkedin.ts — LinkedIn Company & Leadership intelligence extractor.
import type { Page } from 'patchright';
import type { BrowserManager } from '../browser.js';
import type { LinkedInIntel } from './types.js';

const LINKEDIN_TIMEOUT_MS = 25_000;

export async function scrapeLinkedInCompany(
  browserManager: BrowserManager,
  companyUrlOrName: string,
  options: { isUrl?: boolean } = {},
): Promise<LinkedInIntel> {
  const result: LinkedInIntel = { found: false };

  await browserManager.run(async (_ctx, page: Page) => {
    let targetUrl = companyUrlOrName.trim();
    if (!options.isUrl && !/^https?:\/\//i.test(targetUrl)) {
      targetUrl = `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(targetUrl)}`;
    }

    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: LINKEDIN_TIMEOUT_MS });

      // If on search page, click the first company result
      if (page.url().includes('/search/results/companies/')) {
        await page.waitForTimeout(2000);
        const firstCompanyHref = await page.evaluate(() => {
          const a = document.querySelector('a[href*="/company/"]') as HTMLAnchorElement | null;
          return a ? a.href : null;
        });

        if (firstCompanyHref) {
          await page.goto(firstCompanyHref, { waitUntil: 'domcontentloaded', timeout: LINKEDIN_TIMEOUT_MS });
        } else {
          return;
        }
      }

      await page.waitForTimeout(2500);

      // Extract Company Details
      const data = await page.evaluate(() => {
        const title = (document.querySelector('h1')?.textContent || document.title || '').replace(/\s*\|\s*LinkedIn.*$/i, '').trim();
        const text = document.body.innerText || '';

        // Industry & Location usually sit in the sub-header. `.inline-block` is a
        // LinkedIn utility class, not a semantic one, so on a logged-out page it
        // matches a wrapper holding the whole top card — and the "industry" then
        // comes back as the blob "Accounting\n1 follower\n2-10 employees", which
        // flows verbatim into the executive summary. Measured on
        // linkedin.com/company/asixteam, 2026-08-17. Try the semantic selectors
        // first and keep the utility class only as a last resort.
        const subheaderRaw =
          document.querySelector(
            '.org-top-card-summary-info-list__info-item, .org-top-card-summary-info-list, [data-test-id="about-us__industry"]',
          )?.textContent ??
          document.querySelector('.inline-block')?.textContent ??
          '';

        // Whatever matched, keep only the industry: the follower and headcount
        // counts are separate fields and are parsed separately below.
        const subheader = subheaderRaw
          .replace(/\s+/g, ' ')
          .trim()
          .split(/\s*(?:·|\||\d[\d,]*\s*(?:followers?|employees))/i)[0]
          .trim()
          .slice(0, 80);

        // Company size regex: "11-50 employees", "201-500 employees"
        const sizeMatch = text.match(/([\d,]+(?:\s*-\s*[\d,]+)?\s*employees)/i);
        const hqMatch = text.match(/(?:Headquarters|HQ)\s*:\s*([^\n]+)/i);

        // About snippet
        const aboutEl = document.querySelector('p.break-words, .org-grid__core-rail--wide p');
        const aboutText = aboutEl?.textContent?.trim() || '';

        return {
          name: title,
          subheader,
          companySize: sizeMatch ? sizeMatch[1] : null,
          headquarters: hqMatch ? hqMatch[1].trim() : null,
          about: aboutText,
          url: window.location.href,
        };
      });

      if (data.name && !data.name.toLowerCase().includes('sign in') && !data.name.toLowerCase().includes('authwall')) {
        result.found = true;
        result.companyUrl = data.url;
        result.companyName = data.name;
        result.companySize = data.companySize || undefined;
        result.headquarters = data.headquarters || undefined;
        result.industry = data.subheader || undefined;
        result.summary = data.about || undefined;
      }
    } catch {
      // Soft failure if LinkedIn page is unreachable
    }
  });

  return result;
}
