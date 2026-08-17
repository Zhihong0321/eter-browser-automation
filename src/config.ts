import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Port the daemon listens on. The MCP server talks to this. */
export const DAEMON_PORT = Number(process.env.ETER_BROWSER_PORT ?? 7676);
export const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;

/**
 * Where profiles and the manifest live.
 * Resolution order: --home flag > ETER_BROWSER_HOME > vault.config.json > ~/.eter-browser
 */
export function resolveVaultHome(flagHome?: string): string {
  if (flagHome) return path.resolve(flagHome);
  if (process.env.ETER_BROWSER_HOME) return path.resolve(process.env.ETER_BROWSER_HOME);

  const cfgPath = path.join(PKG_ROOT, 'vault.config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { home?: string };
      if (cfg.home) return path.resolve(cfg.home);
    } catch {
      /* fall through to default */
    }
  }
  return path.join(os.homedir(), '.eter-browser');
}

/** Default profile every install starts with. */
export const DEFAULT_PROFILE_ID = 'agent';

/**
 * The classifier that puts a type on every message. Any OpenAI-compatible
 * /chat/completions endpoint works.
 *
 * It falls back to the fast worker the repo is already configured with, because
 * requiring a SECOND set of variables for the same endpoint is how this ended up
 * silently disabled: measured 2026-08-13, every contact ever harvested carried
 * the fallback label, and nothing anywhere said the classifier had never run.
 * Unset everything and fb-recon still collects every message and sender — you
 * lose the seller/owner/buyer labels, never the people.
 *
 * Read as a FUNCTION, never as a module-level const. cli.ts calls
 * `process.loadEnvFile('.env')` in its body, but ESM evaluates every import
 * first — so a const here captures the environment as it was BEFORE .env was
 * loaded, which is empty. Measured 2026-08-13: that alone silently disabled the
 * classifier for a whole live sweep, and the only reason it was caught is that
 * every row carried "no classifier configured" in its `why`.
 */
export function fbReconLlm(): { url: string; key: string; model: string } {
  const fast = process.env.FASTWORKER_BASE_URL?.trim().replace(/\/$/, '') ?? '';
  return {
    url: process.env.FBRECON_LLM_URL?.trim() || (fast ? `${fast}/chat/completions` : ''),
    key: process.env.FBRECON_LLM_KEY?.trim() || process.env.STEPFUN_API_KEY?.trim() || '',
    model: process.env.FBRECON_LLM_MODEL?.trim() || process.env.FASTWORKER_MODEL?.trim() || '',
  };
}

export const DEFAULTS = {
  /** Close the browser after this long with no activity. 0 = keep it open forever. */
  idleTimeoutMs: 5 * 60_000,
  /** Re-probe enrolled sites this often while the browser is up. */
  healthIntervalMs: 15 * 60_000,
  /** Hard ceiling on agent-driven actions, to stay under platform rate heuristics. */
  maxActionsPerMinute: 12,
  /**
   * Outbound WhatsApp message budget. See src/sendlimit.ts for why these are shaped
   * around distinct recipients rather than around the clock. Conservative on purpose —
   * raise them once real usage is known, rather than discovering the ceiling by
   * losing the number.
   */
  whatsappSend: {
    perMinute: 6,
    recipientsPerHour: 15,
    newRecipientsPerHour: 5,
    perDay: 100,
    /** Wait out short pacing gaps; refuse rather than block for a quarter hour. */
    maxWaitMs: 15 * 60_000,
  },
};
