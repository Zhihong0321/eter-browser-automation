// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
//
// Does Facebook SEARCH actually yield posts for a keyword, using the exact
// extractor fb-recon uses? The feasibility probe measured "1 post in 3 rounds"
// BEFORE the action-bar selector fix. Re-measure it.
//
//   node scripts/fb-search-probe.mjs

import fs from 'node:fs';
import { chromium } from 'patchright';
import { POST_EXTRACT_SRC } from '../dist/fb-recon/extract.js';
import { MESSAGE_SEL } from '../dist/facebook.js';

const PROFILE = 'E:\\eter-browser\\profiles\\agent';
const TOPIC = '太阳能 ATAP';
const URL = `https://www.facebook.com/search/posts?q=${encodeURIComponent(TOPIC)}`;
const ROUNDS = 6;

console.log('step: launch chrome on the agent profile');
const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome', headless: false, viewport: { width: 1100, height: 2000 } });
const page = ctx.pages()[0] ?? (await ctx.newPage());

try {
  console.log('step: goto', URL);
  await page.goto(URL, { waitUntil: 'commit', timeout: 45000 });

  console.log('step: wait for the post-message selector');
  await page.waitForSelector(MESSAGE_SEL, { timeout: 30000 });

  const seen = new Set();
  for (let r = 0; r < ROUNDS; r++) {
    const batch = await page.evaluate(`(${POST_EXTRACT_SRC})()`);
    for (const p of batch) {
      const key = p.permalink ?? `${p.author}::${p.text.slice(0, 120)}`;
      if (key.trim()) seen.add(key);
    }
    console.log(`round ${r + 1}: DOM had ${batch.length} posts, running total ${seen.size}`);
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(2500);
  }

  console.log('\n--- what it actually found ---');
  const batch = await page.evaluate(`(${POST_EXTRACT_SRC})()`);
  for (const p of batch.slice(0, 8)) {
    console.log(`\nauthor: ${p.author}\n  text: ${p.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  console.log(`\nTOTAL unique posts from the SEARCH page for "${TOPIC}": ${seen.size}`);
  await page.screenshot({ path: 'scripts/fb-search-probe.png' });
  console.log('shot: scripts/fb-search-probe.png');
} catch (err) {
  console.log('DIED at url:', page.url());
  console.log(err.message);
  await page.screenshot({ path: 'scripts/fb-search-probe-fail.png' });
  fs.writeFileSync('scripts/fb-search-probe-fail.html', await page.content());
  console.log('shot: scripts/fb-search-probe-fail.png  dom: scripts/fb-search-probe-fail.html');
}

await ctx.close();
