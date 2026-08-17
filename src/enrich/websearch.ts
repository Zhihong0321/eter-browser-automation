// src/enrich/websearch.ts — Google Web Search Discovery Engine for Deep Research.
import type { Page } from 'patchright';
import type { BrowserManager } from '../browser.js';
import type { WebSearchSource } from './types.js';
import { extractSsm } from './newpages.js';

export interface DiscoveredCompanyWeb {
  website: string | null;
  facebookUrl: string | null;
  linkedinUrl: string | null;
  instagramUrl: string | null;
  tiktokUrl: string | null;
  ssm: string | null;
  ctosUrl: string | null;
  maukerjaUrl: string | null;
  sources: WebSearchSource[];
  rawText: string;
  /** Every query issued, in order. Present so a thin result can be traced to what was asked. */
  queriesRun?: string[];
}

const EXCLUDE_DOMAINS = [
  'google.com',
  'google.com.my',
  'googleadservices.com',
  'maps.google.com',
  'waze.com',
  'youtube.com',
  'wikipedia.org',
];

const DIRECTORY_DOMAINS = [
  'ctoscredit.com.my',
  'creditscan.com.my',
  'experian.com.my',
  'maukerja.my',
  'jobstreet.com.my',
  'hiredly.com',
  'newpages.com.my',
  'malaysiabrand.com.my',
  'yellowpages.my',
  'foodpanda.my',
  'grab.com',
  'maptons.com',
  'places.my',
  'malaysiadata.com',
  'cymap.my',
  'cari.com.my',
  'findglocal.com',
  'near-me.my',
  'locate2u.com',
  'tripadvisor.com',
  'foursquare.com',
  'intellect-worldwide.com',
  'zakatselangor.com.my',
];

function isOwnDomain(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    if (EXCLUDE_DOMAINS.some((d) => host.includes(d))) return false;
    if (DIRECTORY_DOMAINS.some((d) => host.includes(d))) return false;
    if (host.includes('facebook.com') || host.includes('fb.com')) return false;
    if (host.includes('instagram.com')) return false;
    if (host.includes('linkedin.com')) return false;
    if (host.includes('tiktok.com')) return false;
    if (host.includes('twitter.com') || host.includes('x.com')) return false;
    return true;
  } catch {
    return false;
  }
}

/** Clean company name by stripping marketing suffixes and noise */
export function cleanCompanyQuery(name: string, location = ''): string {
  let base = name
    .replace(/\(.*?\)/g, '')
    .replace(/\[.*?\]/g, '')
    .replace(/[-|:–—].*$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Extract key town if present
  const townMatch = location.match(/(Eco Majestic|Semenyih|Klang|Subang|Petaling Jaya|Kuala Lumpur|Shah Alam|Cheras|Puchong|Kajang|Bangi|Cyberjaya|Putrajaya|Johor Bahru|Penang|Ipoh)/i);
  const loc = townMatch ? townMatch[1] : '';

  return `${base} ${loc}`.trim();
}

/**
 * Sort one page of results into the channels we care about.
 *
 * Every assignment is first-wins, so this is safe to call once per results page:
 * a later pass can fill a channel the first pass missed but can never overwrite a
 * better, earlier hit with a registry-query artefact.
 */
function classify(out: DiscoveredCompanyWeb, items: WebSearchSource[]): void {
  for (const item of items) {
    const u = item.url.toLowerCase();

    // 1. Official Website (first non-social, non-directory domain)
    if (!out.website && isOwnDomain(item.url)) {
      out.website = item.url;
    }

    // 2. Facebook
    if (!out.facebookUrl && (u.includes('facebook.com') || u.includes('fb.com')) && !u.includes('/search/')) {
      out.facebookUrl = item.url;
    }

    // 3. LinkedIn
    if (!out.linkedinUrl && u.includes('linkedin.com/company/')) {
      out.linkedinUrl = item.url;
    }

    // 4. Instagram
    if (!out.instagramUrl && u.includes('instagram.com/')) {
      out.instagramUrl = item.url;
    }

    // 5. TikTok
    if (!out.tiktokUrl && u.includes('tiktok.com/@')) {
      out.tiktokUrl = item.url;
    }

    // 6. CTOS / CreditScan (often carries SSM in URL or snippet)
    if (u.includes('ctoscredit.com.my') || u.includes('creditscan.com.my')) {
      out.ctosUrl ??= item.url;
      const ssmMatch = item.url.match(/(\d{6,7}[A-Z]|\d{12})/i) || item.snippet.match(/(\d{6,7}[A-Z]|\d{12})/i);
      if (ssmMatch && !out.ssm) out.ssm = ssmMatch[1];
    }

    // 7. Maukerja / Job directory
    if (u.includes('maukerja.my')) {
      out.maukerjaUrl ??= item.url;
    }
  }
}

/** One results page, scraped. Kept separate so a second pass costs one navigation, not one browser acquisition. */
async function scrapeResultsPage(
  page: Page,
  query: string,
): Promise<{ items: WebSearchSource[]; rawText: string }> {
  await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&gl=my`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });

  await page.waitForTimeout(2000);

  return page.evaluate(() => {
    const items: { title: string; url: string; snippet: string }[] = [];
    const rawText = document.body.innerText || '';

    for (const a of Array.from(document.querySelectorAll('a[href]'))) {
      const href = (a as HTMLAnchorElement).href;
      if (!href.startsWith('http') || href.includes('google.com') || href.includes('googleadservices')) continue;
      const h3 = a.querySelector('h3')?.textContent?.trim();
      const parent = a.closest('div.g, div[data-hveid]');
      const snippet = parent ? (parent as HTMLElement).innerText.replace(/\s+/g, ' ').trim() : '';

      if (h3 && href && !items.some((it) => it.url === href)) {
        items.push({ title: h3, url: href, snippet });
      }
    }
    return { items, rawText };
  });
}

/**
 * Searches Google for a company to discover their official website,
 * social channels (Facebook, LinkedIn, TikTok), and corporate registry records (CTOS/SSM).
 *
 * Deliberately NOT a wide query fan-out. Google throttles the browser PROFILE, not
 * the query, and this profile's search budget is the scarcest resource in the whole
 * campaign — spending four searches per company to cover registry, jobs and people
 * angles would throttle the harvest that feeds this pipeline in the first place. The
 * ChatGPT research stage covers those angles on a different account entirely, so the
 * only extra pass worth paying for here is a registry query when the first came back
 * with no SSM: it is the highest-value single field and the cheapest to target.
 */
export async function searchCompanyWeb(
  browserManager: BrowserManager,
  companyName: string,
  location = '',
): Promise<DiscoveredCompanyWeb> {
  const query = cleanCompanyQuery(companyName, location);
  const out: DiscoveredCompanyWeb = {
    website: null,
    facebookUrl: null,
    linkedinUrl: null,
    instagramUrl: null,
    tiktokUrl: null,
    ssm: null,
    ctosUrl: null,
    maukerjaUrl: null,
    sources: [],
    rawText: '',
  };
  /** Every query actually issued, so the dossier can show what was asked. */
  const queries: string[] = [];

  await browserManager.run(async (_ctx, page: Page) => {
    try {
      queries.push(query);
      const scraped = await scrapeResultsPage(page, query);

      out.sources = scraped.items;
      out.rawText = scraped.rawText;

      // Extract SSM from search results or page text
      const ssmFromText = extractSsm(scraped.rawText);
      if (ssmFromText) out.ssm = ssmFromText;

      classify(out, scraped.items);

      // Second pass, only when the first found no registration number. The registry
      // aggregators index by legal name, so quoting it and naming them directly hits
      // the page that carries the number instead of hoping it surfaced organically.
      if (!out.ssm) {
        const registryQuery = `"${companyName.replace(/["]/g, '').slice(0, 70)}" SSM OR "no. syarikat" OR ctos OR creditscan`;
        queries.push(registryQuery);
        const second = await scrapeResultsPage(page, registryQuery);
        const ssmFromSecond = extractSsm(second.rawText);
        if (ssmFromSecond) out.ssm = ssmFromSecond;
        classify(out, second.items);
        // Keep both pages' results: the second pass is where the CTOS and Experian
        // links come from, and those are the URL sources NotebookLM grounds on.
        for (const item of second.items) {
          if (!out.sources.some((s) => s.url === item.url)) out.sources.push(item);
        }
        out.rawText = `${out.rawText}\n\n${second.rawText}`;
      }
    } catch {
      // Soft failure if search navigation fails
    }
  });

  out.queriesRun = queries;
  return out;
}
