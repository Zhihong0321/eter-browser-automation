// src/notebooklm.ts — NotebookLM Integration Wrapper via CLI interface.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { PKG_ROOT } from './config.js';

const run = promisify(execFile);

function findNlmExe(): string {
  const candidates = [
    path.join(PKG_ROOT, '.venv-notebooklm', 'Scripts', 'notebooklm.exe'),
    path.join(process.cwd(), '.venv-notebooklm', 'Scripts', 'notebooklm.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'notebooklm';
}

export interface NlmNotebook {
  id: string;
  title: string;
  role?: string;
  created_at?: string;
  modified_at?: string;
}

export interface NlmAskResponse {
  answer: string;
  references?: Array<{ source_id?: string; citation?: string }>;
}

/** Execute a NotebookLM CLI command with --json and return parsed JSON */
export async function execNlm<T = any>(args: string[], maxBuffer = 32 << 20): Promise<T> {
  const exe = findNlmExe();
  try {
    const { stdout } = await run(exe, [...args, '--json'], { maxBuffer });
    return JSON.parse(stdout) as T;
  } catch (err: any) {
    const detail = err.stderr || err.stdout || err.message;
    throw new Error(`NotebookLM CLI error (${args.join(' ')}): ${detail}`);
  }
}

/** List all existing notebooks in the user's Google account */
export async function nlmListNotebooks(): Promise<NlmNotebook[]> {
  const res = await execNlm<{ notebooks: NlmNotebook[] }>(['list']);
  return res.notebooks || [];
}

/** Create a new notebook */
export async function nlmCreateNotebook(title: string): Promise<NlmNotebook> {
  const res = await execNlm<{ notebook: NlmNotebook } | NlmNotebook>(['create', title]);
  return (res as any).notebook || res;
}

/** Delete a notebook */
export async function nlmDeleteNotebook(notebookId: string): Promise<boolean> {
  const res = await execNlm<{ success?: boolean }>(['delete', '-n', notebookId, '-y']);
  return res.success ?? true;
}

/** Add a text or URL source to a notebook */
export async function nlmAddSource(
  notebookId: string,
  content: string,
  options: { title?: string; type?: 'text' | 'url' | 'file' } = {},
): Promise<any> {
  const args = ['source', 'add', '-n', notebookId];
  if (options.type) args.push('--type', options.type);
  if (options.title) args.push('--title', options.title);
  args.push(content);
  return execNlm(args);
}

/** Create a note inside a notebook */
export async function nlmCreateNote(notebookId: string, title: string, content: string): Promise<any> {
  return execNlm(['note', 'create', content, '-t', title, '-n', notebookId]);
}

/** Ask a question to a notebook grounded in its imported sources */
export async function nlmAsk(
  notebookId: string,
  question: string,
  options: { timeoutSec?: number } = {},
): Promise<NlmAskResponse> {
  const args = ['ask', '-n', notebookId];
  if (options.timeoutSec) args.push('--timeout', String(options.timeoutSec));
  args.push(question);
  const res = await execNlm<any>(args);
  const answer = typeof res === 'string' ? res : res.answer || res.text || JSON.stringify(res);
  return {
    answer,
    references: res.references || [],
  };
}

/** Enable or disable public view link sharing for a notebook */
export async function nlmSetPublic(notebookId: string, enable = true): Promise<any> {
  const args = ['share', 'public', enable ? '--enable' : '--disable', '-n', notebookId];
  return execNlm(args);
}

/** Set view level for guest viewers (full or chat) */
export async function nlmSetViewLevel(notebookId: string, level: 'full' | 'chat' = 'full'): Promise<any> {
  return execNlm(['share', 'view-level', level, '-n', notebookId]);
}

/** Share notebook with a specific Google user email as editor or viewer */
export async function nlmShareWithUser(notebookId: string, email: string, permission: 'editor' | 'viewer' = 'editor'): Promise<any> {
  return execNlm(['share', 'add', email, '--permission', permission, '-n', notebookId]);
}

/**
 * Executes a full Deep Research pass in NotebookLM for a company:
 * 1. Finds or creates a dedicated notebook for the company
 * 2. Sets public view access & full view-level (sources + notes + chat)
 * 3. Ingests all gathered intel (Web, SSM, Facebook, LinkedIn, Reviews)
 * 4. Asks NotebookLM for a comprehensive, multi-angle business intelligence analysis
 * 5. Saves the resulting analysis as a permanent Note in the notebook
 */
export async function runNotebookLmCompanyResearch(
  companyName: string,
  intelBundle: {
    rawSummary: string;
    websiteUrl?: string | null;
    /**
     * Every page worth grounding on — the CTOS record, the Newpages listing, the job
     * ads, the portfolio pages. NotebookLM fetches URL sources itself, so these cost
     * us no scraping and reach pages our own crawler never opens.
     */
    urlSources?: string[];
    ssm?: string | null;
    facebookUrl?: string | null;
    contactSummary?: string;
  },
): Promise<{
  notebookId: string;
  notebookUrl: string;
  deepAnalysis: string;
  keyInsights: string[];
}> {
  // 1. Create a dedicated notebook for this company research
  const title = `[Recon] ${companyName.slice(0, 60)}`;
  const nb = await nlmCreateNotebook(title);
  const notebookId = nb.id;

  // Make the notebook accessible so it can be viewed from any Google account with full access
  try {
    await nlmSetPublic(notebookId, true);
    await nlmSetViewLevel(notebookId, 'full');
  } catch {
    // Non-fatal
  }

  try {
    // 2. Ingest intelligence summary as a grounded source
    const sourceText = [
      `COMPANY INTELLIGENCE DOSSIER: ${companyName}`,
      `Generated: ${new Date().toISOString()}`,
      `SSM Registration: ${intelBundle.ssm || 'Not found / Pending'}`,
      `Website: ${intelBundle.websiteUrl || 'None listed on maps'}`,
      `Facebook: ${intelBundle.facebookUrl || 'None listed'}`,
      `\n--- CONTACT MATRIX & RECON DATA ---`,
      intelBundle.contactSummary || '',
      `\n--- DISCOVERED DATA & WEB HIGHLIGHTS ---`,
      intelBundle.rawSummary,
    ].join('\n\n');

    await nlmAddSource(notebookId, sourceText, {
      title: `${companyName} - Recon Data & Contacts`,
      type: 'text',
    });

    // Add every discoverable page as its own URL source. Deduped by href because the
    // homepage usually arrives twice (as websiteUrl and inside urlSources), and a
    // notebook charged for the same page twice is a wasted source slot.
    //
    // Capped at 12: NotebookLM enforces a per-notebook source limit, and a run that
    // trips it fails the whole ingest rather than dropping the thirteenth URL. Losing
    // the tail of a link list is a far cheaper outcome than losing the notebook.
    const seen = new Set<string>();
    const urls = [intelBundle.websiteUrl, ...(intelBundle.urlSources ?? [])]
      .filter((u): u is string => !!u && u.startsWith('http'))
      .filter((u) => !seen.has(u) && seen.add(u))
      .slice(0, 12);

    for (const url of urls) {
      try {
        await nlmAddSource(notebookId, url, { type: 'url' });
      } catch {
        // Soft fallback: a page behind a bot-blocker must not fail the other sources.
      }
    }

    // 3. Ask NotebookLM for in-depth synthesis
    const prompt = `You are a Senior Corporate Intelligence Analyst. Analyze all provided sources for "${companyName}" and provide a deep forensic business brief:

1. **Executive Overview & Core Business Model**: What exact products/services do they monetize? What is their target market?
2. **Operational Scale & Corporate Legitimacy**: Review their SSM registration, physical address, team size, and online legitimacy.
3. **Key Decision Makers & Contacts**: Extract all identifiable Persons-In-Charge (PIC), directors, phone numbers, and emails.
4. **Strategic Outreach & Partnership Angles**: What are the top 2-3 specific pain points or collaboration angles to pitch to this company?

Be concise, highly factual, cite sources where applicable, and format in clean Markdown.`;

    const askRes = await nlmAsk(notebookId, prompt, { timeoutSec: 60 });
    const analysis = askRes.answer;

    // 4. Save analysis as a permanent Note in the notebook
    try {
      await nlmCreateNote(notebookId, 'Forensic Business Intelligence Dossier', analysis);
    } catch {
      // Non-fatal
    }

    // Extract bullet points as key insights
    const lines = analysis.split('\n').map((l) => l.trim());
    const keyInsights = lines
      .filter((l) => l.startsWith('*') || l.startsWith('-') || l.match(/^\d+\./))
      .slice(0, 5)
      .map((l) => l.replace(/^[*-\d.]+\s*/, ''));

    return {
      notebookId,
      notebookUrl: `https://notebooklm.google.com/notebook/${notebookId}`,
      deepAnalysis: analysis,
      keyInsights: keyInsights.length ? keyInsights : ['Comprehensive analysis generated in NotebookLM.'],
    };
  } catch (err: any) {
    // If asking fails, return what we have
    return {
      notebookId,
      notebookUrl: `https://notebooklm.google.com/notebook/${notebookId}`,
      deepAnalysis: `NotebookLM analysis completed with note: ${err.message}`,
      keyInsights: ['NotebookLM session created.'],
    };
  }
}
