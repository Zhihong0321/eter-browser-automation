/**
 * RECON-AGENT — the frozen page. One monolith snapshot per route.
 *
 * Spec: docs/recon-agent-buildplan.md §8 Part 2. Every flag and every hazard
 * here is measured, not inferred: docs/monolith-spike-findings.md.
 *
 * The snapshot is not an archive — it is Part 3's annotation surface. A human
 * points at a table on a rendered page instead of picking five entries out of a
 * flat list of 46 buttons. That is why fidelity matters and why the overlay has
 * to be able to run inside it.
 *
 * Snapshots hold REAL customer rows. They live in the vault, never the repo,
 * and nothing here masks anything — that is deliberate and is why the
 * destination is fixed by the caller and never defaults into the project tree.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Measured flag set (spike findings §5). Order is irrelevant; presence is not.
 *
 * `-o -` avoids monolith's tilde panic on `C:\Users\ETERNA~1\…` — Node writes
 * the file, which also makes the CSP rewrite free. `-i -F` is the 207x size
 * cut (26 MB → 126 KB) with layout intact. `-M` keeps repeat captures of the
 * same route diffable. `-C` is deliberately absent: this site serves its CSS
 * unauthenticated, and a bare cookie export would write 28 unrelated logged-in
 * sessions to a plaintext file.
 */
const FLAGS = ['-e', '-j', '-i', '-F', '-v', '-a', '-M', '-q', '-o', '-'];

/**
 * Keeps the frozen page inert while admitting exactly one script: recon's overlay.
 *
 * `style-src` MUST carry `data:`. monolith does not inline CSS as `<style>` — it
 * emits `<link rel="stylesheet" href="data:text/css;base64,…">`, and
 * `'unsafe-inline'` does not cover a data: URL. Measured on the captured
 * payments route: 2 stylesheet links, 0 style blocks. Without `data:` the
 * snapshot renders completely unstyled, silently, and the annotation surface —
 * whose entire value is that a human can point at a rendered table instead of
 * reading a list of 46 buttons — is worthless. Same failure shape as
 * `script-src 'none'`, one layer down.
 */
export function cspFor(nonce: string): string {
  return `default-src 'none'; style-src 'unsafe-inline' data:; img-src data:; script-src 'nonce-${nonce}'`;
}

const CSP_META_RE = /<meta[^>]*http-equiv=["']?Content-Security-Policy["']?[^>]*>/i;

/**
 * monolith emits `script-src 'none'` whenever `-j` is passed, with or without
 * `-I`. Any overlay JavaScript injected into an untouched snapshot silently
 * does not run — no error, no console warning, just a dead page, and the
 * person building the overlay blames their own code.
 *
 * Page JS is already stripped by `-j`, so admitting a nonce costs nothing.
 * Pure so the rewrite is testable without invoking monolith.
 */
export function rewriteCsp(html: string, nonce: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${cspFor(nonce)}">`;
  if (CSP_META_RE.test(html)) return html.replace(CSP_META_RE, meta);
  // No meta at all is worse, not better — an un-neutered page would be free to
  // reach the network. Insert one rather than trusting monolith's flag set.
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`);
  return meta + html;
}

/** https://admin.atap.solar/payments?tab=1 → payments.html; the root → index.html */
export function snapshotFileName(routeUrl: string): string {
  let p: string;
  try {
    p = new URL(routeUrl).pathname;
  } catch {
    p = routeUrl;
  }
  const slug = p
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .toLowerCase();
  return `${slug || 'index'}.html`;
}

/**
 * The binary, in the order that actually works on this machine.
 *
 * The `WinGet\Links\monolith.exe` shim only resolves in a *fresh* shell, so a
 * PATH lookup from a long-lived daemon finds nothing. The real binary under
 * `WinGet\Packages` is checked first. `cargo install monolith` fails here
 * entirely (vendored OpenSSL needs a native Windows perl) — install via winget.
 */
export function findMonolith(): string | null {
  const env = process.env.MONOLITH_PATH;
  if (env && fs.existsSync(env)) return env;

  const local = process.env.LOCALAPPDATA;
  if (local) {
    const pkgs = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const dir of fs.readdirSync(pkgs)) {
        if (!/^Y2Z\.Monolith/i.test(dir)) continue;
        const exe = path.join(pkgs, dir, 'monolith.exe');
        if (fs.existsSync(exe)) return exe;
      }
    } catch {
      // No WinGet packages dir — fall through to PATH.
    }
    const link = path.join(local, 'Microsoft', 'WinGet', 'Links', 'monolith.exe');
    if (fs.existsSync(link)) return link;
  }
  return null;
}

export interface SnapshotRecord {
  /** Path on disk, or null when the capture did not produce one. */
  file: string | null;
  bytes: number;
  /** The nonce the overlay must carry to run inside this snapshot. */
  nonce: string | null;
  /**
   * `document.styleSheets.length` after loading the written file, or null when
   * no render check ran. See `renderCheck` — this is the only field here that
   * reports whether the snapshot is USABLE rather than merely produced.
   */
  styleSheets: number | null;
  error?: string;
}

/**
 * A snapshot that renders unstyled is worth nothing, and every signal short of
 * loading it says the capture succeeded: monolith exits 0, stdout is large, the
 * tag census matches the live DOM, the byte count is in range. That is exactly
 * how 17 blank pages were once recorded as "17/17, 0 failed" — the check was
 * "did the process exit 0", which cannot observe this failure at all.
 *
 * 0 stylesheets is an ERROR, never a pass. Same rule as a rendered row count of
 * 0 in reconciliation: an empty result may not manufacture agreement.
 */
export const NO_STYLESHEETS_ERROR = 'snapshot renders unstyled — 0 stylesheets loaded; check the CSP meta admits data: in style-src';

/**
 * Freeze one settled page.
 *
 * `html` is `page.content()` from the already-settled tab — monolith is never
 * pointed at the URL itself. Two reasons: the session lives in the browser
 * profile and monolith has no access to it, and re-fetching would capture a
 * *different* render than the one this scan measured, inventoried and
 * reconciled. The snapshot has to be the page that was actually observed.
 *
 * Failure is recorded, never thrown: a missing binary is not a reason to lose
 * a completed scan.
 */
export async function captureSnapshot(args: {
  html: string;
  url: string;
  outDir: string;
  fileName: string;
  monolith?: string | null;
  timeoutMs?: number;
  /**
   * Loads the written file in a real browser and returns
   * `document.styleSheets.length`. Injected rather than imported so this module
   * stays browser-free and unit-testable; `scanSite` supplies the real one.
   */
  renderCheck?: (file: string) => Promise<number>;
}): Promise<SnapshotRecord> {
  const bin = args.monolith ?? findMonolith();
  if (!bin) {
    return {
      file: null,
      bytes: 0,
      nonce: null,
      styleSheets: null,
      error: 'monolith not found — winget install --id Y2Z.Monolith, or set MONOLITH_PATH',
    };
  }

  let out: string;
  try {
    out = await runMonolith(bin, args.html, args.url, args.timeoutMs ?? 90_000);
  } catch (err) {
    return { file: null, bytes: 0, nonce: null, styleSheets: null, error: err instanceof Error ? err.message.slice(0, 200) : 'monolith failed' };
  }
  if (!out.trim()) return { file: null, bytes: 0, nonce: null, styleSheets: null, error: 'monolith produced no output' };

  return finalizeSnapshot(out, args);
}

/**
 * Everything after monolith exits: rewrite the CSP, write the file, and check
 * it renders. Split out so the verdict logic is testable without spawning a
 * binary — the failure this guards against was never in monolith.
 */
export async function finalizeSnapshot(
  out: string,
  args: { outDir: string; fileName: string; renderCheck?: (file: string) => Promise<number> },
): Promise<SnapshotRecord> {
  const nonce = crypto.randomBytes(12).toString('base64url');
  const html = rewriteCsp(out, nonce);

  fs.mkdirSync(args.outDir, { recursive: true });
  const file = path.join(args.outDir, args.fileName);
  fs.writeFileSync(file, html, 'utf8');
  const rec: SnapshotRecord = { file, bytes: Buffer.byteLength(html), nonce, styleSheets: null };

  if (!args.renderCheck) return rec;
  try {
    rec.styleSheets = await args.renderCheck(file);
  } catch (err) {
    // The check itself broke. That is not evidence the snapshot is fine, so it
    // is reported rather than swallowed — but the file is kept.
    rec.error = `render check failed: ${err instanceof Error ? err.message.slice(0, 160) : 'unknown'}`;
    return rec;
  }
  if (rec.styleSheets === 0) rec.error = NO_STYLESHEETS_ERROR;
  return rec;
}

function runMonolith(bin: string, html: string, baseUrl: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-', '-b', baseUrl, ...FLAGS], { windowsHide: true });
    const chunks: Buffer[] = [];
    let err = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new Error(`monolith timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // -e means asset errors are already tolerated; a non-zero exit here is a
      // real failure, and stdout would be a partial page.
      if (code !== 0) return reject(new Error(`monolith exited ${code}: ${err.slice(0, 160)}`));
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    child.stdin.on('error', () => {
      /* closed early — the close handler reports it */
    });
    child.stdin.end(html);
  });
}
