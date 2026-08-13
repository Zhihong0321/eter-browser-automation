// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
//
// No selectors for the button. Enter key, then raw mouse click on the pixels.

import { chromium } from 'patchright';

const PROFILE = 'E:\\eter-browser\\profiles\\agent';

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: false, args: ['--no-sandbox'],
  viewport: null, ignoreDefaultArgs: ['--enable-automation'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.log('   nav ->', f.url().slice(0, 100)); });

console.log('step: goto');
await page.goto('https://accounting.autocountcloud.com/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);
console.log('   at:', page.url().slice(0, 70), '|', await page.title());

// Tick "Remember me" so the cookie survives Chrome exiting.
console.log('step: tick Remember me');
await page.locator('input[type=checkbox]').first().check({ timeout: 5000 }).then(() => console.log('   checked')).catch((e) => console.log('   FAILED:', e.message.split('\n')[0]));

console.log('step: press Enter in password field');
await page.locator('input[type=password]').first().press('Enter');
await page.waitForTimeout(9000);
console.log('   now:', page.url().slice(0, 70), '|', await page.title());

if ((await page.title()).includes('Log In')) {
  console.log('step: Enter did nothing — mouse-click the blue box');
  const box = await page.evaluate(() => {
    // the blue bar sits directly under the "Remember me" checkbox row
    const cb = document.querySelector('input[type=checkbox]');
    const r = cb.getBoundingClientRect();
    // scan downward for the widest element whose background is blue-ish
    let best = null;
    for (const el of document.querySelectorAll('*')) {
      const b = el.getBoundingClientRect();
      const bg = getComputedStyle(el).backgroundColor;
      const m = bg.match(/\d+/g);
      if (!m) continue;
      const [rr, gg, bb] = m.map(Number);
      if (b.top > r.bottom && b.width > 100 && b.height > 20 && bb > rr + 40 && bb > 100) {
        if (!best || b.top < best.top) best = { x: b.x + b.width / 2, y: b.y + b.height / 2, top: b.top, w: b.width, h: b.height, tag: el.tagName, html: el.outerHTML.slice(0, 200) };
      }
    }
    return best;
  });
  console.log('   blue box:', JSON.stringify(box));
  if (box) {
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(10000);
    console.log('   after mouse click:', page.url().slice(0, 70), '|', await page.title());
  }
}

console.log('step: final state');
console.log('   url   =', page.url());
console.log('   title =', await page.title());
console.log('   text  =', await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 300)));
const cookies = (await ctx.cookies()).filter((c) => c.domain.includes('autocount'));
for (const c of cookies) console.log(`   cookie ${c.domain} ${c.name} ${c.expires === -1 ? 'SESSION' : 'persists ' + new Date(c.expires * 1000).toISOString().slice(0, 10)}`);
await page.screenshot({ path: 'E:\\001-browser-use-v2\\scripts\\ac-after.png' });
process.exit(0);
