// src/ragbucket.ts — client for the RAG Bucket API (Markdown knowledge buckets).
//
// Contract, read off /openapi.json on 2026-08-17:
//
//   POST   /v1/groups                                  {company, slug?, description?, readme?} → 201, 409 if taken
//   GET    /v1/groups/{group}                           group metadata (auth) → 404 when absent
//   PUT    /v1/groups/{group}/README.md                 raw text/markdown, max 512KB
//   PUT    /v1/groups/{group}/documents/{name}.md       raw text/markdown, max 5MB
//   DELETE /v1/groups/{group}/documents/{name}
//   GET    /r/{group}                                   PUBLIC retrieval entrypoint, no auth
//
// Markdown only: the filename is validated against /.+\.md$/ server-side and the body
// content-type is text/markdown. There is no endpoint that accepts HTML, so the
// standalone dossier HTML cannot be hosted here.
//
// Base URL: the service's own docs and the `servers` entry in its openapi.json both
// print `rag-b.up-railway.app`, with a hyphen where the hostname needs a dot. That
// host does not resolve (checked 2026-08-17). The working origin is the one below;
// following their published base URL fails with a DNS error.

import fs from 'node:fs';

try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile('.env');
  }
} catch {
  /* no .env found or already loaded */
}

export const RAG_BUCKET_URL = (process.env.RAG_BUCKET_URL?.trim().replace(/\/$/, '') ||
  'https://rag-b.up.railway.app');

/** Where the personal credential store lives. Not the eter-browser vault. */
const MY_VAULT = process.env.MY_VAULT_PATH?.trim() || 'D:/tools/my-vault/vault.json';
/** The vault entry holding this service's bearer key. */
const VAULT_ENTRY = 'EE_HTML_HOSTING_SERVICE';

/**
 * The bearer key: environment first, then the personal vault.
 *
 * The vault is the fallback rather than the primary so a run can be pointed at a
 * different bucket without editing a credential store, and so CI has a way in.
 */
export function ragApiKey(): string {
  const fromEnv = process.env.RAG_BUCKET_API_KEY?.trim() || process.env.EE_HTML_API_KEY?.trim();
  if (fromEnv) return fromEnv;


  try {
    const vault = JSON.parse(fs.readFileSync(MY_VAULT, 'utf8')) as {
      credentials?: { name?: string; secret?: string }[];
    };
    const hit = vault.credentials?.find((c) => c.name === VAULT_ENTRY)?.secret?.trim();
    if (hit) return hit;
  } catch {
    /* fall through to the error below, which names both places */
  }

  throw new Error(
    `No RAG Bucket API key. Set RAG_BUCKET_API_KEY, or add a "${VAULT_ENTRY}" credential to ${MY_VAULT}.`,
  );
}

interface RagError {
  error?: { code?: string; message?: string };
}

async function call(
  method: string,
  path: string,
  body?: { markdown: string } | { json: unknown },
  key = ragApiKey(),
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  let payload: string | undefined;

  if (body && 'markdown' in body) {
    headers['content-type'] = 'text/markdown; charset=utf-8';
    payload = body.markdown;
  } else if (body && 'json' in body) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body.json);
  }

  const res = await fetch(`${RAG_BUCKET_URL}${path}`, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, text: await res.text() };
}

/** The message the service actually returned, so a 4xx says what was wrong. */
function reason(text: string, status: number): string {
  try {
    const j = JSON.parse(text) as RagError;
    if (j.error?.message) return `${j.error.code ?? status}: ${j.error.message}`;
  } catch {
    /* not JSON */
  }
  return `HTTP ${status}${text ? ` — ${text.slice(0, 200)}` : ''}`;
}

/** `Agriculf Sdn Bhd` → `agriculf-sdn-bhd`. The public URL becomes /r/<slug>. */
export function groupSlug(company: string): string {
  return (
    company
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'company'
  );
}

/**
 * Create the group, or report that it already exists.
 *
 * 409 is a success for our purposes: pushing the same company twice must be safe, and
 * the documents are PUT (replace) rather than POST, so a re-push updates in place.
 */
export async function ensureGroup(input: {
  company: string;
  slug: string;
  description?: string;
  readme?: string;
}): Promise<{ created: boolean }> {
  const { status, text } = await call('POST', '/v1/groups', { json: input });
  if (status === 201) return { created: true };
  if (status === 409) return { created: false };
  throw new Error(`Could not create group "${input.slug}" — ${reason(text, status)}`);
}

export async function putReadme(group: string, markdown: string): Promise<void> {
  const { status, text } = await call('PUT', `/v1/groups/${encodeURIComponent(group)}/README.md`, { markdown });
  if (status !== 200) throw new Error(`README.md push failed for "${group}" — ${reason(text, status)}`);
}

export async function putDocument(
  group: string,
  filename: string,
  markdown: string,
  description?: string,
): Promise<void> {
  if (!filename.endsWith('.md')) throw new Error(`Document name must end in .md — got "${filename}"`);
  // 5MB server cap. Checked here so an oversized brief fails with a useful message
  // rather than a bare 413 after the whole body has been uploaded.
  const bytes = Buffer.byteLength(markdown, 'utf8');
  if (bytes > 5 * 1024 * 1024) {
    throw new Error(`"${filename}" is ${(bytes / 1048576).toFixed(1)}MB — the service caps documents at 5MB`);
  }

  const q = description ? `?description=${encodeURIComponent(description)}` : '';
  const path = `/v1/groups/${encodeURIComponent(group)}/documents/${encodeURIComponent(filename)}${q}`;
  const { status, text } = await call('PUT', path, { markdown });
  if (status !== 200) throw new Error(`"${filename}" push failed for "${group}" — ${reason(text, status)}`);
}

export async function getGroup(group: string): Promise<unknown | null> {
  const { status, text } = await call('GET', `/v1/groups/${encodeURIComponent(group)}`);
  if (status === 404) return null;
  if (status !== 200) throw new Error(`Group lookup failed for "${group}" — ${reason(text, status)}`);
  return JSON.parse(text);
}

/** The public retrieval entrypoint an AI reads. No auth. */
export const publicUrl = (group: string): string => `${RAG_BUCKET_URL}/r/${encodeURIComponent(group)}`;
