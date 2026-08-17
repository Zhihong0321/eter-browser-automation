// src/agycli.ts — thin wrapper around the `agy` CLI: a second, unrelated agentic
// research tool (its own binary, its own web search, no connection to the
// dossier-synthesis helpers in enrich/agy.ts) used as a follow-up pass after the
// ChatGPT research stage. See enrich/agyresearch.ts for how the pipeline uses it.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

function findAgyExe(): string {
  const local = process.env.LOCALAPPDATA;
  const candidates = local ? [path.join(local, 'agy', 'bin', 'agy.exe')] : [];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Not found at the known install path — trust PATH and let execFile fail loudly
  // if it truly isn't installed.
  return 'agy';
}

export interface AgyAnswer {
  ok: boolean;
  /** The model's reply. Empty when ok is false. */
  text: string;
  /** Wall time for the call. */
  ms: number;
  /** Present only when ok is false. */
  error?: string;
}

/**
 * Run one prompt through `agy`'s print mode (`-p`) and return its answer.
 *
 * agy is an agentic CLI with its own tools (web search, file read, …) gated by a
 * permission prompt. Headless/print mode cannot answer that prompt — a tool call
 * that needs approval is auto-denied and the whole run fails with "no output
 * produced" (observed live against this build, 2026-08-17). The only way past
 * that in this build is `--dangerously-skip-permissions`; there is no narrower
 * per-tool allow flag on the command line. That means every call here runs with
 * full tool auto-approval and nobody watching each individual tool use — so the
 * caller (the pipeline stage in enrich/agyresearch.ts) keeps this opt-in per run
 * rather than defaulting it on.
 *
 * `workDir`, when given, is passed via `--add-dir` so the prompt can point agy at
 * a file (e.g. the baseline research brief) without embedding that file's full
 * text in the prompt argument — large briefs pushed through argv risk Windows'
 * ~32K combined command-line limit, and a file reference does not.
 */
export async function askAgy(
  prompt: string,
  opts: { timeoutMs?: number; workDir?: string } = {},
): Promise<AgyAnswer> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const exe = findAgyExe();
  const args = [
    '-p',
    prompt,
    '--print-timeout',
    `${Math.max(1, Math.round(timeoutMs / 1000))}s`,
    '--output-format',
    'text',
    '--dangerously-skip-permissions',
  ];
  if (opts.workDir) args.push('--add-dir', opts.workDir);

  const started = Date.now();
  try {
    const { stdout } = await execFileAsync(exe, args, {
      // A little slack over the CLI's own --print-timeout so OUR timeout is never
      // the one that fires first and hides agy's actual error message.
      timeout: timeoutMs + 15_000,
      maxBuffer: 64 << 20,
    });
    const text = stdout.trim();
    if (!text) return { ok: false, text: '', ms: Date.now() - started, error: 'agy produced no output' };
    return { ok: true, text, ms: Date.now() - started };
  } catch (err: unknown) {
    const e = err as { stderr?: unknown; stdout?: unknown; message?: string };
    const detail =
      (typeof e.stderr === 'string' && e.stderr.trim()) ||
      (typeof e.stdout === 'string' && e.stdout.trim()) ||
      e.message ||
      String(err);
    return { ok: false, text: '', ms: Date.now() - started, error: detail };
  }
}
