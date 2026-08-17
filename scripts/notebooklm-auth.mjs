/**
 * Hand the vault's Google session to notebooklm-py.
 *
 * notebooklm-py wants its own `storage_state.json` under ~/.notebooklm, and its
 * own `notebooklm login` would open a second browser and make you sign in to
 * Google a second time — which is exactly the duplication this vault exists to
 * avoid. The vault's `google` profile is already signed in to NotebookLM, so we
 * export its cookies and import them instead.
 *
 * We navigate to notebook.google.com before dumping: Google rotates
 * __Secure-1PSIDTS on use, and the copy sitting on disk is stale as soon as the
 * profile has been idle. Loading the page mints a fresh one, and doubles as the
 * signed-in check — no point importing cookies that are already dead.
 *
 * Usage: node scripts/notebooklm-auth.mjs [profileId]   (default: google)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'patchright';

const PROFILE_ID = process.argv[2] || 'google';
const NOTEBOOKLM = path.resolve('.venv-notebooklm/Scripts/notebooklm.exe');
const HOME = JSON.parse(fs.readFileSync('vault.config.json', 'utf8')).home;
const MANIFEST = JSON.parse(fs.readFileSync(path.join(HOME, 'manifest.json'), 'utf8'));

const profile = MANIFEST.profiles[PROFILE_ID];
if (!profile) {
  console.error(`No profile "${PROFILE_ID}" in ${HOME}. Have: ${Object.keys(MANIFEST.profiles).join(', ')}`);
  process.exit(1);
}
if (!fs.existsSync(NOTEBOOKLM)) {
  console.error(`notebooklm CLI not found at ${NOTEBOOKLM} — see docs/notebooklm-setup.md`);
  process.exit(1);
}

const dir = path.join(HOME, 'profiles', PROFILE_ID);
let ctx;
try {
  // Launch replayed verbatim from the manifest, same rule as src/browser.ts: the
  // fingerprint Google enrolled against is the one it must keep seeing.
  ctx = await chromium.launchPersistentContext(dir, {
    channel: profile.launch.channel,
    headless: profile.launch.headless,
    args: profile.launch.args,
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
  });
} catch (err) {
  console.error(`Could not open profile "${PROFILE_ID}": ${err.message}`);
  console.error('One Chrome per user-data-dir — stop the eter-browser daemon (or close that window) and retry.');
  process.exit(1);
}

try {
  // Non-persistent cookies the vault rescued at last shutdown. Google's own auth
  // cookies are persistent, but __Host-GAPSTS is not, so skipping this can cost
  // us a cookie the import validator looks for.
  const cache = path.join(dir, 'session-cookies.json');
  if (fs.existsSync(cache)) {
    const saved = JSON.parse(fs.readFileSync(cache, 'utf8'));
    const live = saved.filter((c) => c.expires * 1000 > Date.now());
    if (live.length) await ctx.addCookies(live);
  }

  const page = await ctx.newPage();
  await page.goto('https://notebook.google.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(5_000); // let the SPA finish its auth round-trip and re-issue -1PSIDTS

  const url = page.url();
  if (/accounts\.google\.com/.test(url)) {
    console.error(`Profile "${PROFILE_ID}" is signed OUT — it landed on ${url}.`);
    console.error('Sign in through the eter-browser dashboard first, then re-run this.');
    process.exit(2);
  }

  const cookies = await ctx.cookies();
  const google = cookies.filter((c) => /(^|\.)google\.com$/.test(c.domain.replace(/^\./, '.')));
  const state = { cookies: google, origins: [] };

  const out = path.join(os.tmpdir(), `notebooklm-storage-${process.pid}.json`);
  fs.writeFileSync(out, JSON.stringify(state), { mode: 0o600 });
  try {
    console.log(`Exported ${google.length} google.com cookies from profile "${PROFILE_ID}".`);
    execFileSync(NOTEBOOKLM, ['auth', 'import-cookies', out], { stdio: 'inherit' });
    execFileSync(NOTEBOOKLM, ['auth', 'check', '--test'], { stdio: 'inherit' });
  } finally {
    fs.rmSync(out, { force: true }); // live Google credentials — never leave them in temp
  }
} finally {
  await ctx.close().catch(() => {});
}
