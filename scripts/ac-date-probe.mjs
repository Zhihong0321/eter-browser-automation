// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
// Question: #agent-date resolves but the click never lands. What is on top of it?
import { chromium } from 'patchright';

const AC = 'https://accounting.autocountcloud.com';
const ctx = await chromium.launchPersistentContext('E:\\eter-browser\\profiles\\agent', {
  channel: 'chrome', headless: false, args: ['--no-sandbox'],
  viewport: null, ignoreDefaultArgs: ['--enable-automation'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

try {
  await page.goto(AC + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  await page.locator('body>div>div>div>div:nth-of-type(2)>div:nth-of-type(4)>div>div>div:nth-of-type(6)>div>div>div>div>table>tbody>tr:nth-of-type(1)>td:nth-of-type(1)>button').click();
  await page.waitForTimeout(9000);
  await page.goto(AC + '/quotation', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  await page.getByRole('button', { name: /New/i }).first().click();
  await page.waitForTimeout(9000);

  const d = await page.evaluate(() => {
    const modals = [...document.querySelectorAll('.modal.show')].map((m) => ({
      cls: m.className, vis: m.offsetParent !== null, txt: m.innerText.slice(0, 40).replace(/\s+/g, ' '),
    }));
    const m = document.querySelector('.modal.show');
    const cands = [...m.querySelectorAll('input')]
      .filter((x) => /^\d{2}\/\d{2}\/\d{4}$/.test(x.value))
      .map((x) => {
        const r = x.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const top = document.elementFromPoint(cx, cy);
        return {
          val: x.value, ro: x.readOnly,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          offsetParentNull: x.offsetParent === null,
          inViewport: r.top >= 0 && r.bottom <= innerHeight,
          topElAtCenter: top ? top.tagName + '.' + String(top.className).slice(0, 60) : 'NONE',
          isSelfOrChild: top ? (top === x || x.contains(top) || top.contains(x)) : false,
        };
      });
    return { modals, cands, viewport: { w: innerWidth, h: innerHeight }, scrollY: scrollY };
  });
  console.log(JSON.stringify(d, null, 1));
} catch (e) {
  console.log('THREW:', String(e).slice(0, 300));
}
await ctx.close();
