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

export const DEFAULTS = {
  /** Close the browser after this long with no activity. 0 = keep it open forever. */
  idleTimeoutMs: 5 * 60_000,
  /** Re-probe enrolled sites this often while the browser is up. */
  healthIntervalMs: 15 * 60_000,
  /** Hard ceiling on agent-driven actions, to stay under platform rate heuristics. */
  maxActionsPerMinute: 12,
};
