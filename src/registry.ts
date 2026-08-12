// The automation registry — a scan over the cards, not a file anyone maintains.
//
// Implements the registry described in docs/two-mode-agent-design.md: every file
// under src/automations/<domain>/ carries a frontmatter card, and this reads them
// into memory so `search_automations` and `run_automation` can stand in for N typed
// tools. The thing you edit is the thing you document, so the two cannot drift.
//
// WHY IT READS .ts AND IMPORTS .js: tsc strips the card. Each automation's only
// runtime statement is `export const run = ...`, and its `import type` lines are
// elided — the card comment goes with them. So dist/automations/**.js contains the
// code and none of the metadata. The card is therefore parsed from source and the
// callable is imported from the build.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PKG_ROOT } from './config.js';
import type { VaultService } from './service.js';

export type Effect = 'read' | 'write' | 'destructive';

export interface AutomationCard {
  id: string;
  domain: string;
  /** The condition a user's request satisfies — what a model matches against. */
  useWhen: string;
  effect: Effect;
  /** Session dependencies, e.g. ['session:web.whatsapp.com']. Empty is legitimate: gmap-recon runs logged out. */
  needs: string[];
  /** The `run` signature, lifted from source — the argument contract for a caller. */
  signature: string;
  /** Source path, relative to the package root. */
  file: string;
}

const CARD_RE = /\/\*\*---\s*([\s\S]*?)---\*\//;
const RUN_RE = /export\s+(?:const|async\s+function)\s+run\s*[=(]([\s\S]*?)=>|export\s+async\s+function\s+run\s*\(([\s\S]*?)\)\s*[:{]/;
const EFFECTS: readonly Effect[] = ['read', 'write', 'destructive'];

const srcDir = (): string => path.join(PKG_ROOT, 'src', 'automations');
const distDir = (): string => path.join(PKG_ROOT, 'dist', 'automations');

/**
 * Parse one card. Returns null rather than throwing: a malformed file must not take
 * the whole registry down, and the caller reports it as a skip.
 */
export function parseCard(source: string, file: string): AutomationCard | null {
  const block = source.match(CARD_RE)?.[1];
  if (!block) return null;

  const field = (name: string): string =>
    block.match(new RegExp(`^${name}:\\s*(.*)$`, 'm'))?.[1]?.trim() ?? '';

  const id = field('id');
  const domain = field('domain');
  const useWhen = field('use_when');
  const rawEffect = field('effect');
  if (!id || !domain || !useWhen) return null;

  const effect = (EFFECTS as readonly string[]).includes(rawEffect) ? (rawEffect as Effect) : 'write';

  // `needs: []` or `needs: [session:a.com, session:b.com]`
  const needs = (field('needs').match(/\[(.*)\]/)?.[1] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return { id, domain, useWhen, effect, needs, signature: extractSignature(source), file };
}

/**
 * The caller-facing signature: the args object and the return type, with the
 * injected `svc: VaultService` removed so a model does not try to supply one.
 *
 * Depth-counted rather than regex-sliced — every parameter here is a destructured
 * object literal with nested braces, which a non-greedy regex splits in the wrong
 * place. Returns '' when the shape is unrecognised; a wrong signature is worse than
 * none, because a caller would believe it.
 */
export function extractSignature(source: string): string {
  const at = source.search(/export\s+(?:const|async\s+function)\s+run\b/);
  if (at < 0) return '';
  const open = source.indexOf('(', at);
  if (open < 0) return '';

  const PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const stack: string[] = [];
  let close = -1;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (PAIRS[ch]) {
      if (stack.pop() !== PAIRS[ch]) return '';
      if (!stack.length) { close = i; break; }
    }
  }
  if (close < 0) return '';

  // Split the parameter list on TOP-LEVEL commas only.
  const params: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const ch = source[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) { params.push(source.slice(start, i)); start = i + 1; }
  }
  params.push(source.slice(start, close));

  const args = params
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p && !/^svc\s*:/.test(p));

  const ret = returnTypeAt(source, close + 1);
  return `(${args.join(', ')})${ret ? `: ${ret}` : ''}`;
}

/**
 * The declared return type, from just after the parameter list's `)`.
 *
 * Also depth-counted: `Promise<{ chat: string; messages: WaMessage[] }>` contains a
 * brace, so stopping at the first `{` truncates it to `Promise<`. Only a `=>` or a
 * `{` at depth zero actually ends the type.
 */
function returnTypeAt(src: string, from: number): string {
  let i = from;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== ':') return '';

  i += 1;
  let depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (depth === 0 && (ch === '{' || src.startsWith('=>', i))) break;
    if (ch === '<' || ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === '>' || ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
  }
  return src.slice(start, i).replace(/\s+/g, ' ').trim();
}


/** Every card under src/automations/. Cheap enough to call per request. */
export function scanCards(): AutomationCard[] {
  const root = srcDir();
  if (!fs.existsSync(root)) return [];

  const out: AutomationCard[] = [];
  for (const domain of fs.readdirSync(root, { withFileTypes: true })) {
    if (!domain.isDirectory()) continue;
    for (const entry of fs.readdirSync(path.join(root, domain.name))) {
      if (!entry.endsWith('.ts')) continue;
      const rel = path.join('src', 'automations', domain.name, entry);
      const card = parseCard(fs.readFileSync(path.join(root, domain.name, entry), 'utf8'), rel);
      if (card) out.push(card);
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Rank cards against a free-text query. Deliberately simple token overlap weighted
 * toward `use_when`, which is the field written for exactly this purpose. An empty
 * query returns the whole catalogue — that is the "what can you do" case.
 */
export function searchAutomations(query: string, limit = 10): AutomationCard[] {
  const cards = scanCards();
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  if (!terms.length) return cards.slice(0, limit);

  return cards
    .map((c) => {
      const hay = `${c.useWhen} ${c.id} ${c.domain}`.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (c.domain.toLowerCase().includes(t)) score += 3;
        if (c.id.toLowerCase().includes(t)) score += 2;
        if (hay.includes(t)) score += 1;
      }
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.c);
}

/**
 * Dispatch by id. The compiled module is imported lazily so the registry costs
 * nothing until something is actually run, and an automation whose build is stale
 * fails loudly here rather than silently doing nothing.
 */
export async function runAutomation(
  svc: VaultService,
  id: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const card = scanCards().find((c) => c.id === id);
  if (!card) {
    const known = scanCards().map((c) => c.id).join(', ') || '(none)';
    throw new Error(`No automation "${id}". Known: ${known}`);
  }

  const js = path.join(distDir(), path.relative(srcDir(), path.join(PKG_ROOT, card.file)))
    .replace(/\.ts$/, '.js');
  if (!fs.existsSync(js)) {
    throw new Error(`"${id}" is not built — ${path.relative(PKG_ROOT, js)} is missing. Run: npm run build`);
  }

  const mod = (await import(pathToFileURL(js).href)) as { run?: unknown };
  if (typeof mod.run !== 'function') throw new Error(`"${id}" exports no run() function`);

  return (mod.run as (s: VaultService, a: Record<string, unknown>) => unknown)(svc, args);
}
