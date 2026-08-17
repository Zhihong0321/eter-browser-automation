// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
//
// The solar group sweep stopped at 2 posts claiming "the source ran out".
// This asks the page directly: how many posts are in the DOM per round, does
// scrolling grow it, and what does the page actually look like?
//
//   node scripts/solar-group-probe.mjs

import { chromium } from 'patchright';
import { POST_EXTRACT_SRC } from '../dist/fb-recon/extract.js';
import { MESSAGE_SEL } from '../dist/facebook.js';

const PROFILE = 'E:\\eter-browser\\profiles\\fbrecon';
const URL = 'https://www.facebook.com/groups/solarnemdiymalaysia';
const OUT = 'C:/Users/ETERNA~1/AppData/Local/Temp/claude/e--001-browser-use-v2/84582e9c-eadb-4a78-bd1c-9c7de8711d17/scratchpad/';
const ROUNDS = 10;

console.log('step: launch chrome on the fbrecon profile');
const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome', headless: false, viewport: null });
const page = ctx.pages()[0] ?? (await ctx.newPage());

try {
  // Same viewport the sweep uses, so this measures the sweep's conditions.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 2480, deviceScaleFactor: 1.5, mobile: false,
    screenWidth: 1440, screenHeight: 2560,
  });

  console.log('step: goto', URL);
  await page.goto(URL, { waitUntil: 'commit', timeout: 45000 });
  await page.waitForTimeout(6000);

  console.log('step: am I a member? what does the page say?');
  const state = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    joinBtn: !!document.querySelector('[aria-label*="Join" i]'),
    privateWord: /private group|group is private|join this group/i.test(document.body.innerText),
    bodyStart: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400),
  }));
  console.log(JSON.stringify(state, null, 1));

  await page.screenshot({ path: OUT + 'solar-group-top.png' });
  console.log('shot: solar-group-top.png');

  const seen = new Set();
  let prevNodes = -1;
  for (let r = 0; r < ROUNDS; r++) {
    const batch = await page.evaluate(`(${POST_EXTRACT_SRC})()`);
    let fresh = 0;
    for (const p of batch) {
      const key = p.permalink ?? `${p.author}::${p.text.slice(0, 120)}`;
      if (key.trim() && !seen.has(key)) { seen.add(key); fresh++; }
    }
    const nodes = await page.evaluate((s) => document.querySelectorAll(s).length, MESSAGE_SEL);
    const h = await page.evaluate(() => document.body.scrollHeight);
    console.log(`round ${r + 1}: extracted ${batch.length} | fresh ${fresh} | total ${seen.size} | MESSAGE_SEL nodes ${nodes} (prev ${prevNodes}) | scrollHeight ${h}`);
    prevNodes = nodes;
    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(2500);
  }

  await page.screenshot({ path: OUT + 'solar-group-scrolled.png' });
  console.log('shot: solar-group-scrolled.png');
  console.log('TOTAL distinct posts reachable in', ROUNDS, 'rounds:', seen.size);
} catch (err) {
  console.log('FAILED:', err.message);
  await page.screenshot({ path: OUT + 'solar-group-error.png' }).catch(() => {});
} finally {
  await ctx.close();
}
