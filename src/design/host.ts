/**
 * Client for the HTML Host Engine (https://ee-html.up.railway.app).
 *
 * Static bundles in, public URL out. The engine's rules, enforced here so the
 * agent gets a named error instead of a 400:
 *   - the bundle is a .zip with index.html at its ROOT
 *   - assets use RELATIVE paths, because apps are served under /app/<slug>/
 *   - slugs are lowercase a-z0-9 and hyphens, 1-63 chars, alphanumeric ends
 *
 * The API key must never reach a published page: it authenticates /api/*, and
 * everything under /app/ is public.
 */
import { zipDir } from './zip.js';

const DEFAULT_BASE_URL = 'https://ee-html.up.railway.app';

export interface HostConfig {
  baseUrl: string;
  apiKey: string;
}

export interface HostedApp {
  slug: string;
  name?: string;
  tags?: string[];
  url: string;
  files?: number;
  created?: boolean;
}

/**
 * Read as a function, never a module const — .env is loaded inside main(), long
 * after ESM evaluates imports. See the same note in config.ts:44.
 */
export function hostConfig(): HostConfig {
  const apiKey =
    process.env.EE_HTML_API_KEY?.trim() || process.env.EE_HTML_HOSTING_SERVICE?.trim();
  if (!apiKey) {
    throw new Error('EE_HTML_API_KEY is not set — add it to .env (gitignored, see .env.example).');
  }
  return {
    baseUrl: (process.env.EE_HTML_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey,
  };
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Turn any title into a slug the engine will accept. */
export function toSlug(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  if (!SLUG.test(slug)) throw new Error(`Cannot derive a valid slug from ${JSON.stringify(raw)}.`);
  return slug;
}

async function call(cfg: HostConfig, method: string, path: string, body?: BodyInit): Promise<unknown> {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${cfg.apiKey}` },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    // The engine's own message is more specific than anything invented here.
    throw new Error(`Host engine ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

/**
 * Publish a directory. POST overwrites an existing slug, so this is
 * create-or-replace — the engine documents PUT as requiring the slug to exist,
 * which makes it the wrong verb for a first deploy.
 */
export async function publish(
  dir: string,
  opts: { slug?: string; name?: string; tags?: string[]; cfg?: HostConfig } = {},
): Promise<HostedApp> {
  const cfg = opts.cfg ?? hostConfig();
  if (opts.slug && !SLUG.test(opts.slug)) {
    throw new Error(`Invalid slug ${JSON.stringify(opts.slug)}: lowercase a-z, 0-9 and hyphens, 1-63 chars.`);
  }

  const form = new FormData();
  form.append('bundle', new Blob([new Uint8Array(zipDir(dir))], { type: 'application/zip' }), 'bundle.zip');
  if (opts.slug) form.append('slug', opts.slug);
  if (opts.name) form.append('name', opts.name);
  // Omitting tags on a re-deploy KEEPS the existing ones, which is what we want.
  if (opts.tags?.length) form.append('tags', opts.tags.join(','));

  return (await call(cfg, 'POST', '/api/apps', form)) as HostedApp;
}

export async function listApps(tag?: string, cfg = hostConfig()): Promise<HostedApp[]> {
  const body = (await call(cfg, 'GET', `/api/apps${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`)) as
    | HostedApp[]
    | { apps?: HostedApp[] };
  return Array.isArray(body) ? body : (body.apps ?? []);
}

export async function deleteApp(slug: string, cfg = hostConfig()): Promise<void> {
  await call(cfg, 'DELETE', `/api/apps/${encodeURIComponent(slug)}`);
}
