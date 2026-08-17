// src/enrich/domain.ts — Domain registry lookup: who registered the website, and when.
//
// Two paths, because the answer for a Malaysian company lives somewhere different
// than the answer for a .com:
//
//   gTLDs (.com/.net/.org/…)   RDAP over HTTPS, endpoint resolved from the IANA
//                              bootstrap. Dates, registrar and nameservers are
//                              public; the registrant entity is redacted outright
//                              post-GDPR, so "who owns it" is simply not
//                              answerable on this path — measured on three real
//                              rows, the registrant entity is absent entirely.
//
//   .my and .com.my            No RDAP at all: .my is absent from the IANA
//                              bootstrap (checked 2026-08-17, 590 services).
//                              MYNIC answers on port 43 instead, and leaves
//                              `Registrant Organization` UNREDACTED — on a
//                              .com.my that is the registered business name.
//                              That one field is why this stage exists: a
//                              registry-sourced legal entity name, obtained
//                              without an SSM search, which also tells Sdn Bhd
//                              apart from a sole proprietorship.
//
// Plain .my comes back with the org field EMPTY rather than missing — .my is open
// to individuals while .com.my requires business registration — so a blank there is
// a real finding about the registration class, not a parse failure.
//
// TLDs outside those two paths are reported as `unsupported` naming the TLD, never
// as an empty result. A stage that could not look is not a stage that looked and
// found nothing, and collapsing the two is what makes a thin dossier unexplainable.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { resolveVaultHome } from '../config.js';
import type { DomainIntel } from './types.js';

/* ---- name parsing --------------------------------------------------------- */

/**
 * Registry suffixes that take three labels rather than two. Not a full public
 * suffix list — the Malaysian entries are the ones that matter here, and the rest
 * cover the neighbours that turn up in Malaysian lead data.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'com.my', 'net.my', 'org.my', 'gov.my', 'edu.my', 'mil.my', 'name.my',
  'com.sg', 'net.sg', 'org.sg', 'edu.sg', 'gov.sg',
  'com.bn', 'com.au', 'net.au', 'org.au',
  'co.uk', 'org.uk', 'ac.uk',
  'co.id', 'or.id', 'co.th', 'in.th',
  'com.cn', 'com.hk', 'com.tw', 'com.ph', 'com.vn',
]);

/**
 * Hosts that belong to a platform, not to the business. A Malaysian SME very often
 * lists its Facebook page or a Linktree as its "website", and looking that up would
 * return Meta's registration data under the company's name — worse than no answer,
 * because it reads as a real finding. Having no own domain is itself worth
 * recording, so these are reported rather than dropped.
 */
const PLATFORM_HOSTS = new Set([
  'facebook.com', 'fb.com', 'fb.me', 'instagram.com', 'tiktok.com', 'youtube.com',
  'twitter.com', 'x.com', 'linkedin.com', 'wa.me', 'whatsapp.com', 't.me',
  'linktr.ee', 'beacons.ai', 'carrd.co', 'bio.link',
  'google.com', 'business.site', 'blogspot.com', 'sites.google.com',
  'wixsite.com', 'wix.com', 'weebly.com', 'wordpress.com', 'webnode.page',
  'myshopify.com', 'shopify.com', 'shopee.com.my', 'shp.ee', 'lazada.com.my',
  'godaddysites.com', 'square.site', 'canva.site', 'notion.site', 'framer.website',
  'netlify.app', 'vercel.app', 'github.io', 'jimdosite.com', 'page.link',
]);

/**
 * Hostname or URL → the name a registry can actually be asked about.
 * `https://estore.healthlane.com.my/x` → `healthlane.com.my`.
 */
export function registrableDomain(input: string): string | null {
  if (!input) return null;
  let host = input.trim().toLowerCase();

  // Tolerate a bare hostname as readily as a full URL — lead rows carry both.
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(host)) host = `http://${host}`;
  try {
    host = new URL(host).hostname;
  } catch {
    return null;
  }

  host = host.replace(/\.$/, '').replace(/^www\./, '');
  if (!host || net.isIP(host) || !host.includes('.')) return null;
  // A trailing-dot strip can leave an empty label; reject anything malformed.
  if (host.split('.').some((l) => l === '')) return null;

  const labels = host.split('.');
  const lastTwo = labels.slice(-2).join('.');
  const take = MULTI_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  if (labels.length < take) return null;
  return labels.slice(-take).join('.');
}

/** True when the domain belongs to a hosting platform rather than to the business. */
export function isPlatformDomain(domain: string): boolean {
  if (PLATFORM_HOSTS.has(domain)) return true;
  // Subdomain-per-tenant platforms: the registrable domain is the platform itself,
  // so the set above already catches them — this covers the multi-label variants.
  return [...PLATFORM_HOSTS].some((p) => domain === p || domain.endsWith(`.${p}`));
}

export const tldOf = (domain: string): string => domain.slice(domain.lastIndexOf('.') + 1);

/**
 * The registry was asked and answered "nobody owns this".
 *
 * Deliberately not `!d.registered`: a platform page and an unsupported TLD leave
 * `registered` undefined because nothing was asked, and treating those as dead
 * domains would invent a red flag out of a stage that never ran.
 */
export const isDeadDomain = (d: DomainIntel | undefined): boolean => d?.registered === false;

/* ---- shared field helpers ------------------------------------------------- */

/** Registries write "REDACTED FOR PRIVACY" and friends where a value would go. */
const REDACTIONS = /^(redacted|not disclosed|data protected|statutory masking|privacy|please query|n\/a|-+)/i;

const clean = (v: string | undefined | null): string | undefined => {
  const s = (v ?? '').trim();
  if (!s || REDACTIONS.test(s)) return undefined;
  return s;
};

const iso = (v: string | undefined): string | undefined => {
  const s = clean(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
};

/** Whole-ish years since registration — a floor on how long the business has been online. */
function ageYears(createdAt: string | undefined, now: number): number | undefined {
  if (!createdAt) return undefined;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return undefined;
  return Math.round(((now - t) / 31_557_600_000) * 10) / 10;
}

/* ---- MYNIC WHOIS (port 43) ------------------------------------------------ */

const NOT_REGISTERED =
  /(is available for registration|no match for|not found|no data found|no entries found|domain not found)/i;

function whoisField(text: string, key: string): string | undefined {
  // Anchored per line, and the value must be non-empty: MYNIC emits a bare
  // "Registrant Organization:" for a .my registered to an individual, and that
  // empty value is a finding about the registration class, not a missing field.
  const m = text.match(new RegExp(`^\\s*${key}\\s*:[ \\t]*(\\S.*?)\\s*$`, 'im'));
  return clean(m?.[1]);
}

function whoisFieldAll(text: string, key: string): string[] {
  const re = new RegExp(`^\\s*${key}\\s*:[ \\t]*(\\S.*?)\\s*$`, 'gim');
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const v = clean(m[1]);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Parse a MYNIC port-43 response. Pure — the network lives in `lookupDomain`. */
export function parseMynicWhois(domain: string, text: string, now = Date.now()): DomainIntel {
  if (NOT_REGISTERED.test(text)) {
    return {
      domain,
      source: 'mynic-whois',
      registered: false,
      note: 'MYNIC reports this name as unregistered — the listed website cannot resolve.',
    };
  }

  const createdAt = iso(whoisField(text, 'Creation Date'));
  const expiresAt = iso(whoisField(text, 'Registry Expiry Date') ?? whoisField(text, 'Expiry Date'));

  return {
    domain,
    source: 'mynic-whois',
    registered: true,
    createdAt,
    expiresAt,
    changedAt: iso(whoisField(text, 'Updated Date')),
    ageYears: ageYears(createdAt, now),
    expired: expiresAt ? Date.parse(expiresAt) < now : undefined,
    registrar: whoisField(text, 'Registrar'),
    registrantOrganization: whoisField(text, 'Registrant Organization'),
    registrantState: whoisField(text, 'Registrant State/Province'),
    registrantCountry: whoisField(text, 'Registrant Country'),
    nameservers: whoisFieldAll(text, 'Name Server').map((n) => n.toLowerCase()),
    statuses: whoisFieldAll(text, 'Domain Status').map((s) => s.split(/\s+/)[0]),
  };
}

/** Module-level gate: MYNIC publishes no rate limit, so bulk runs are serialised. */
let whoisChain: Promise<unknown> = Promise.resolve();
const MIN_WHOIS_GAP_MS = 1_200;

function whoisQuery(host: string, query: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    let settled = false;
    const sock = net.createConnection({ host, port: 43 }, () => sock.write(`${query}\r\n`));
    sock.setTimeout(timeoutMs);
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(err);
    };
    sock.on('data', (d) => (out += d.toString('utf8')));
    sock.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(out);
    });
    sock.on('timeout', () => fail(new Error(`WHOIS ${host} timed out after ${timeoutMs}ms`)));
    sock.on('error', (e) => fail(new Error(`WHOIS ${host} failed: ${e.message}`)));
  });
}

async function lookupMynic(domain: string, timeoutMs: number): Promise<DomainIntel> {
  const run = whoisChain.then(
    () => new Promise((r) => setTimeout(r, MIN_WHOIS_GAP_MS)),
    () => new Promise((r) => setTimeout(r, MIN_WHOIS_GAP_MS)),
  );
  whoisChain = run;
  await run;
  return parseMynicWhois(domain, await whoisQuery('whois.mynic.my', domain, timeoutMs));
}

/* ---- RDAP ----------------------------------------------------------------- */

interface RdapVCardEntity {
  roles?: string[];
  vcardArray?: [string, unknown[]];
  publicIds?: { type: string; identifier: string }[];
}

interface RdapDomain {
  events?: { eventAction: string; eventDate: string }[];
  entities?: RdapVCardEntity[];
  nameservers?: { ldhName?: string }[];
  status?: string[];
}

/** Pull the formatted name out of a jCard, which nests it four levels deep. */
function vcardName(entity: RdapVCardEntity | undefined): string | undefined {
  const props = entity?.vcardArray?.[1];
  if (!Array.isArray(props)) return undefined;
  for (const p of props) {
    if (Array.isArray(p) && p[0] === 'fn') return clean(String(p[3] ?? ''));
  }
  return undefined;
}

const roled = (d: RdapDomain, role: string): RdapVCardEntity | undefined =>
  (d.entities ?? []).find((e) => (e.roles ?? []).includes(role));

/** Parse an RDAP domain object. Pure — the network lives in `lookupDomain`. */
export function parseRdap(domain: string, body: RdapDomain, now = Date.now()): DomainIntel {
  const events = new Map((body.events ?? []).map((e) => [e.eventAction, e.eventDate]));
  const createdAt = iso(events.get('registration'));
  const expiresAt = iso(events.get('expiration'));
  const registrant = roled(body, 'registrant');

  return {
    domain,
    source: 'rdap',
    registered: true,
    createdAt,
    expiresAt,
    changedAt: iso(events.get('last changed')),
    ageYears: ageYears(createdAt, now),
    expired: expiresAt ? Date.parse(expiresAt) < now : undefined,
    registrar: vcardName(roled(body, 'registrar')),
    // Nearly always absent: ICANN's post-GDPR profile strips registrant contact
    // data from gTLD responses. Present here only when a registry publishes it.
    registrantOrganization: vcardName(registrant),
    registrantCountry: undefined,
    nameservers: (body.nameservers ?? [])
      .map((n) => clean(n.ldhName)?.toLowerCase())
      .filter((n): n is string => !!n),
    statuses: body.status ?? [],
    note: registrant
      ? undefined
      : 'Registrant redacted by the registry (ICANN post-GDPR policy) — owner not obtainable via RDAP.',
  };
}

/* ---- IANA RDAP bootstrap -------------------------------------------------- */

interface Bootstrap {
  fetchedAt: string;
  /** TLD → RDAP base URL. */
  services: Record<string, string>;
}

const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const BOOTSTRAP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const bootstrapFile = (): string => path.join(resolveVaultHome(), 'rdap-bootstrap.json');

let bootstrapMemo: Bootstrap | null = null;

async function loadBootstrap(timeoutMs: number, now = Date.now()): Promise<Record<string, string>> {
  if (bootstrapMemo && now - Date.parse(bootstrapMemo.fetchedAt) < BOOTSTRAP_TTL_MS) {
    return bootstrapMemo.services;
  }

  const file = bootstrapFile();
  try {
    const disk = JSON.parse(fs.readFileSync(file, 'utf8')) as Bootstrap;
    if (now - Date.parse(disk.fetchedAt) < BOOTSTRAP_TTL_MS) {
      bootstrapMemo = disk;
      return disk.services;
    }
  } catch {
    /* no usable cache — fetch below */
  }

  const res = await fetch(BOOTSTRAP_URL, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`IANA RDAP bootstrap returned HTTP ${res.status}`);
  const raw = (await res.json()) as { services: [string[], string[]][] };

  const services: Record<string, string> = {};
  for (const [tlds, urls] of raw.services ?? []) {
    const base = (urls ?? []).find((u) => u.startsWith('https://')) ?? urls?.[0];
    if (!base) continue;
    for (const t of tlds) services[t.toLowerCase()] = base.replace(/\/?$/, '/');
  }

  bootstrapMemo = { fetchedAt: new Date(now).toISOString(), services };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(bootstrapMemo));
  } catch {
    /* cache is an optimisation, not a requirement */
  }
  return services;
}

async function lookupRdap(domain: string, base: string, timeoutMs: number): Promise<DomainIntel> {
  const res = await fetch(`${base}domain/${encodeURIComponent(domain)}`, {
    headers: { accept: 'application/rdap+json' },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.status === 404) {
    return {
      domain,
      source: 'rdap',
      registered: false,
      note: 'The registry has no record of this name — the listed website cannot resolve.',
    };
  }
  if (!res.ok) throw new Error(`RDAP ${base} returned HTTP ${res.status}`);
  return parseRdap(domain, (await res.json()) as RdapDomain);
}

/* ---- cache ---------------------------------------------------------------- */

interface CacheEntry {
  fetchedAt: string;
  intel: DomainIntel;
}

const cacheFile = (): string => path.join(resolveVaultHome(), 'domain-cache.json');
/** Registration data barely moves; an unregistered answer is re-checked far sooner. */
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const CACHE_TTL_UNREGISTERED_MS = 24 * 60 * 60 * 1000;

function readCache(domain: string, now: number): DomainIntel | null {
  try {
    const all = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) as Record<string, CacheEntry>;
    const hit = all[domain];
    if (!hit) return null;
    const ttl = hit.intel.registered ? CACHE_TTL_MS : CACHE_TTL_UNREGISTERED_MS;
    return now - Date.parse(hit.fetchedAt) < ttl ? hit.intel : null;
  } catch {
    return null;
  }
}

function writeCache(domain: string, intel: DomainIntel, now: number): void {
  try {
    const file = cacheFile();
    let all: Record<string, CacheEntry> = {};
    try {
      all = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, CacheEntry>;
    } catch {
      /* first write */
    }
    all[domain] = { fetchedAt: new Date(now).toISOString(), intel };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all, null, 2));
  } catch {
    /* cache is an optimisation, not a requirement */
  }
}

/* ---- entry point ---------------------------------------------------------- */

export async function lookupDomain(
  websiteOrHost: string,
  options: { timeoutMs?: number; useCache?: boolean } = {},
): Promise<DomainIntel> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const now = Date.now();

  const domain = registrableDomain(websiteOrHost);
  if (!domain) {
    return {
      domain: websiteOrHost,
      source: 'unsupported',
      note: `"${websiteOrHost}" is not a domain name that can be looked up.`,
    };
  }

  if (isPlatformDomain(domain)) {
    return {
      domain,
      source: 'platform',
      note: `The listed website is a ${domain} page, not the company's own domain — nothing to look up, and no independent web presence.`,
    };
  }

  if (options.useCache !== false) {
    const hit = readCache(domain, now);
    if (hit) return { ...hit, cached: true };
  }

  const tld = tldOf(domain);
  let intel: DomainIntel;

  if (tld === 'my') {
    intel = await lookupMynic(domain, timeoutMs);
  } else {
    const services = await loadBootstrap(timeoutMs, now);
    const base = services[tld];
    if (!base) {
      // Named, not silent: ".ee has no RDAP service" is an answer, "" is a bug report.
      return {
        domain,
        source: 'unsupported',
        note: `.${tld} publishes no RDAP service in the IANA bootstrap and has no WHOIS parser here — registration data was not checked.`,
      };
    }
    intel = await lookupRdap(domain, base, timeoutMs);
  }

  writeCache(domain, intel, now);
  return intel;
}

/** One line for the stage log — what was actually established, or why nothing was. */
export function describeDomain(d: DomainIntel): { status: 'ok' | 'empty' | 'skipped'; detail: string } {
  if (d.source === 'platform') return { status: 'skipped', detail: d.note ?? 'platform page' };
  if (d.source === 'unsupported') return { status: 'skipped', detail: d.note ?? 'unsupported TLD' };
  if (isDeadDomain(d)) {
    return { status: 'ok', detail: `${d.domain} is NOT REGISTERED — dead website on the lead row` };
  }

  const bits = [
    `created=${d.createdAt?.slice(0, 10) ?? '—'}`,
    d.ageYears !== undefined ? `age=${d.ageYears}y` : '',
    `registrar=${d.registrar ?? '—'}`,
    `owner=${d.registrantOrganization ?? (d.source === 'rdap' ? 'REDACTED (gTLD)' : 'not published')}`,
    d.expired ? 'EXPIRED' : '',
    d.cached ? 'cached' : '',
  ].filter(Boolean);
  return { status: 'ok', detail: `${d.domain} ${bits.join(' ')}` };
}
