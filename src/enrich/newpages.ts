// src/enrich/newpages.ts — Newpages.com.my directory lookup & SSM registry extractor.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NewpagesIntel } from './types.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NEWPAGES_STORE = path.join(REPO_ROOT, 'newpages', 'store', 'companies.json');

interface NewpagesRecord {
  id: string;
  url: string;
  name?: string;
  address?: string;
  email?: string;
  mobile?: string;
  tel?: string;
  fax?: string;
  website?: string;
  location?: string;
  nature?: string;
  classifieds?: string;
  tags?: string;
}

let cachedCompanies: Record<string, NewpagesRecord> | null = null;

function loadStore(): Record<string, NewpagesRecord> {
  if (cachedCompanies) return cachedCompanies;
  try {
    if (fs.existsSync(NEWPAGES_STORE)) {
      cachedCompanies = JSON.parse(fs.readFileSync(NEWPAGES_STORE, 'utf8')) as Record<string, NewpagesRecord>;
      return cachedCompanies;
    }
  } catch {
    // Return empty if store file is not found
  }
  return {};
}

/** Clean company name to bare alphanumeric tokens for robust comparison */
function cleanTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/\b(sdn|bhd|sdn\.?\s*bhd|enterprise|trading|services|holdings|plt|hq|branch|cawangan)\b/gi, ' ')
    .replace(/[@()[\],.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length >= 2);
}

/** Extract SSM registration number from name or text (e.g. 201401033342 (1109427-X), JM0113400-D, 002134567-V) */
export function extractSsm(text: string): string | undefined {
  // 12-digit new format or old format with parenthesis: 202001012345 (1234567-X)
  const newFormat = text.match(/\b(20\d{10}\s*\(\d{5,7}-[A-Z]\)|\d{12})\b/i);
  if (newFormat) return newFormat[0];

  // Old format: 123456-A or JM 0259590-P or SA0123456-X
  const oldFormat = text.match(/\b([A-Z]{0,3}\s*\d{5,8}\s*-[A-Z])\b/i);
  if (oldFormat) return oldFormat[0].replace(/\s+/g, ' ');

  return undefined;
}

/** Extract Person In Charge (PIC) name attached to contact strings (e.g. "016-7165563 Ken Ng") */
export function extractPic(text: string): { picName?: string; cleanPhone?: string } {
  if (!text) return {};
  const m = text.match(/^([\d\s\-+/()]{7,25})\s+([A-Za-z\s.'-]{2,30})$/);
  if (m) {
    return { cleanPhone: m[1].trim(), picName: m[2].trim() };
  }
  return {};
}

/**
 * Search local Newpages registry cache for a company name.
 * Uses token overlap and fuzzy scoring.
 */
export function lookupNewpages(companyName: string): NewpagesIntel {
  const store = loadStore();
  const targetTokens = cleanTokens(companyName);
  if (!targetTokens.length) return { found: false };

  let bestMatch: NewpagesRecord | null = null;
  let bestScore = 0;

  for (const record of Object.values(store)) {
    if (!record.name) continue;
    const recTokens = cleanTokens(record.name);
    if (!recTokens.length) continue;

    // Calculate token intersection
    let matches = 0;
    for (const token of targetTokens) {
      if (recTokens.some((rt) => rt === token || rt.includes(token) || token.includes(rt))) {
        matches++;
      }
    }

    const score = matches / Math.max(targetTokens.length, recTokens.length);
    // Exact or strong subset match
    if (matches === targetTokens.length && score > bestScore && score >= 0.5) {
      bestScore = score;
      bestMatch = record;
    } else if (score > bestScore && score >= 0.6) {
      bestScore = score;
      bestMatch = record;
    }
  }

  if (!bestMatch || !bestMatch.name) {
    return { found: false };
  }

  const rawName = bestMatch.name;
  const ssm = extractSsm(rawName) || (bestMatch.nature ? extractSsm(bestMatch.nature) : undefined);
  const picFromTel = extractPic(bestMatch.tel || '');
  const picFromMobile = extractPic(bestMatch.mobile || '');

  return {
    found: true,
    matchedName: rawName,
    ssm,
    address: bestMatch.address || undefined,
    email: bestMatch.email || undefined,
    mobile: bestMatch.mobile ? (bestMatch.mobile.startsWith('60') ? bestMatch.mobile : `60${bestMatch.mobile.replace(/^0/, '')}`) : undefined,
    tel: picFromTel.cleanPhone || bestMatch.tel || undefined,
    fax: bestMatch.fax || undefined,
    website: bestMatch.website || undefined,
    location: bestMatch.location || undefined,
    businessNature: bestMatch.nature || undefined,
    classifieds: bestMatch.classifieds || undefined,
    tags: bestMatch.tags || undefined,
    picName: picFromTel.picName || picFromMobile.picName || undefined,
    sourceUrl: bestMatch.url,
  };
}
