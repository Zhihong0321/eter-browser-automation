// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
// Route probe #2: what is one directory ROW, and what is behind the profile link?
import { chromium } from 'patchright';

const PROFILE = 'E:\\eter-browser\\profiles\\agent';
const LIST = 'https://www.malaysiabrand.com.my/index.php?char=A';
const SHOT = 'E:\\001-browser-use-v2\\scripts\\';

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: false, args: ['--no-sandbox'],
  viewport: null, ignoreDefaultArgs: ['--enable-automation'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

try {
  console.log('STEP 1 listing page A');
  await page.goto(LIST, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  console.log('  title:', await page.title(), '| url:', page.url());
  await page.screenshot({ path: SHOT + 'mb-listA.png' });

  // find the repeating row: the common ancestor of each newpages link
  const rows = await page.evaluate(() => {
    const out = [];
    const anchors = [...document.querySelectorAll('a[href*="newpages.com.my"]')];
    for (const a of anchors.slice(0, 3)) {
      let n = a;
      for (let i = 0; i < 4 && n.parentElement; i++) n = n.parentElement;
      out.push({
        tag: n.tagName + '.' + n.className,
        text: n.innerText.replace(/\s+/g, ' ').slice(0, 400),
        links: [...n.querySelectorAll('a[href]')].map(x => [x.innerText.trim().slice(0, 40), x.getAttribute('href')]),
        html: n.outerHTML.replace(/\s+/g, ' ').slice(0, 900),
      });
    }
    return { count: anchors.length, out };
  });
  console.log('  newpages links on page A:', rows.count);
  for (const r of rows.out) {
    console.log('  --- ROW ---');
    console.log('  container:', r.tag);
    console.log('  text:', r.text);
    console.log('  links:', JSON.stringify(r.links));
    console.log('  html:', r.html);
  }

  console.log('\nSTEP 2 open the first profile');
  const first = await page.evaluate(() => document.querySelector('a[href*="newpages.com.my"]').href);
  console.log('  ->', first);
  await page.goto(first, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  console.log('  title:', await page.title(), '| url:', page.url());
  await page.screenshot({ path: SHOT + 'mb-profile.png', fullPage: true });
  const body = await page.evaluate(() => document.body.innerText);
  console.log('--- PROFILE TEXT (3000) ---');
  console.log(body.replace(/\n{2,}/g, '\n').slice(0, 3000));
  console.log('--- END ---');
  const c = await page.evaluate(() => ({
    mailtel: [...document.querySelectorAll('a[href^="mailto"],a[href^="tel"]')].map(a => a.getAttribute('href')),
    micro: [...document.querySelectorAll('[itemprop]')].map(e => [e.getAttribute('itemprop'), e.innerText.trim().slice(0, 80)]).slice(0, 30),
  }));
  console.log('  mailto/tel:', JSON.stringify(c.mailtel));
  console.log('  itemprop:', JSON.stringify(c.micro));
} catch (e) {
  console.log('DIED:', e.message, '| url:', page.url());
  await page.screenshot({ path: SHOT + 'mb-fail.png' }).catch(() => {});
}
await ctx.close();
