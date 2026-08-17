/**
 * Intake: everything the designer needs about the client, taken from the client.
 *
 * Entirely mechanical — no model runs here. What comes out is fact: the words
 * they actually use, the colours their CSS actually computes to, the services
 * they actually list. A model asked to "research the company" would invent
 * plausible details instead, and plausible-but-invented copy is the single
 * fastest way to lose a client.
 *
 * The screenshots matter as much as the text: the reviewer later needs to see
 * the site being replaced, and "is this better than what they had" is only
 * answerable against an image.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'patchright';

export interface Intake {
  url: string;
  title: string;
  description: string;
  /** Visible headings in document order — the site's own information hierarchy. */
  headings: { level: number; text: string }[];
  /** Whole-page visible text, collapsed. The source for real copy. */
  bodyText: string;
  /** Colours the browser actually computed, most-used first. */
  colors: { background: string[]; text: string[] };
  fonts: string[];
  contact: { emails: string[]; phones: string[]; whatsapp: string[] };
  /** Internal links, for a human deciding whether to widen the crawl. */
  links: { text: string; href: string }[];
  shots: { viewport: string; file: string }[];
}

/** rgb()/rgba() as the browser reports it → #rrggbb. */
function toHex(css: string): string | null {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(css);
  if (!m) return null;
  // Fully transparent colours are not what the eye sees; ignore them.
  if (/rgba\([^)]*,\s*0(\.0+)?\s*\)$/.test(css)) return null;
  return (
    '#' +
    [m[1], m[2], m[3]]
      .map((n) => Number(n).toString(16).padStart(2, '0'))
      .join('')
  );
}

function rank(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
}

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// Malaysian numbers dominate this repo's use; the shape is loose on purpose.
const PHONE = /(?:\+?6?0?1[0-9][-\s]?\d{3,4}[-\s]?\d{4})|(?:\+?60\s?\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4})/g;

/**
 * Load a site and take everything useful off it.
 *
 * Uses the installed Chrome (channel:'chrome'), like the rest of this repo —
 * patchright's bundled headless shell is never downloaded here.
 */
export async function intake(url: string, outDir: string): Promise<Intake> {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });

  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    // 'load', not 'networkidle': a site with analytics polling never goes idle.
    await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForTimeout(1500);

    // NOTE: no named helper functions inside this callback. tsx compiles via
    // esbuild with keepNames, which injects a `__name` helper into any function
    // it touches — and this body is serialised into the browser, where that
    // helper does not exist. Measured: a `const visible = (el) => ...` in here
    // failed with "__name is not defined". tsc emits no such helper, so the
    // built artifact in dist/ is unaffected; inlining keeps tsx working too.
    // Same defect documented at docs/superpowers/specs/2026-08-12-gmap-recon-design.md:331
    const harvested = await page.evaluate(() => {
      const headings = [...document.querySelectorAll('h1,h2,h3')]
        .filter((el) => {
          const s = getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
        })
        .map((h) => ({ level: Number(h.tagName[1]), text: (h.textContent ?? '').trim() }))
        .filter((h) => h.text.length > 0 && h.text.length < 200);

      // Sample computed style off real content elements, not the whole DOM:
      // wrappers are mostly transparent and would swamp the ranking.
      const sample = [...document.querySelectorAll('body,header,main,section,div,p,h1,h2,h3,a,button')]
        .filter((el) => {
          const s = getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
        })
        .slice(0, 600);
      const background: string[] = [];
      const text: string[] = [];
      const fonts: string[] = [];
      for (const el of sample) {
        const s = getComputedStyle(el);
        background.push(s.backgroundColor);
        text.push(s.color);
        fonts.push(s.fontFamily);
      }

      const links = [...document.querySelectorAll('a[href]')]
        .filter((el) => {
          const s = getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
        })
        .map((a) => ({ text: (a.textContent ?? '').trim().slice(0, 60), href: (a as HTMLAnchorElement).href }))
        .filter((l) => l.text && l.href.startsWith(location.origin))
        .slice(0, 40);

      const waLinks = [...document.querySelectorAll('a[href]')]
        .map((a) => (a as HTMLAnchorElement).href)
        .filter((h) => /wa\.me|api\.whatsapp\.com/.test(h));

      return {
        title: document.title ?? '',
        description:
          document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() ?? '',
        headings,
        bodyText: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 20_000),
        background,
        text,
        fonts,
        links,
        waLinks,
      };
    });

    const shots: Intake['shots'] = [];
    for (const [name, width, height] of [
      ['desktop', 1440, 900],
      ['mobile', 375, 812],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(600);
      const file = path.join(outDir, `source-${name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      shots.push({ viewport: name, file });
    }

    await ctx.close();

    const result: Intake = {
      url,
      title: harvested.title,
      description: harvested.description,
      headings: harvested.headings,
      bodyText: harvested.bodyText,
      colors: {
        background: rank(harvested.background.map(toHex).filter((c): c is string => !!c)).slice(0, 6),
        text: rank(harvested.text.map(toHex).filter((c): c is string => !!c)).slice(0, 6),
      },
      fonts: rank(harvested.fonts).slice(0, 4),
      contact: {
        emails: [...new Set(harvested.bodyText.match(EMAIL) ?? [])].slice(0, 5),
        phones: [...new Set(harvested.bodyText.match(PHONE) ?? [])].slice(0, 5),
        whatsapp: [...new Set(harvested.waLinks)].slice(0, 3),
      },
      links: harvested.links,
      shots,
    };

    fs.writeFileSync(path.join(outDir, 'intake.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(outDir, 'source.md'), asMarkdown(result));
    return result;
  } finally {
    await browser.close();
  }
}

/** The intake as the brief the designer actually reads. */
export function asMarkdown(i: Intake): string {
  return [
    `# ${i.title || i.url}`,
    ``,
    `Source: ${i.url}`,
    i.description ? `\n> ${i.description}` : '',
    ``,
    `## Their own headings, in order`,
    ...i.headings.map((h) => `${'  '.repeat(h.level - 1)}- (h${h.level}) ${h.text}`),
    ``,
    `## Existing brand signals`,
    `- Backgrounds in use: ${i.colors.background.join(', ') || '(none read)'}`,
    `- Text colours in use: ${i.colors.text.join(', ') || '(none read)'}`,
    `- Fonts in use: ${i.fonts.join(' · ') || '(none read)'}`,
    ``,
    `## Contact`,
    `- Email: ${i.contact.emails.join(', ') || '(none found)'}`,
    `- Phone: ${i.contact.phones.join(', ') || '(none found)'}`,
    `- WhatsApp: ${i.contact.whatsapp.join(', ') || '(none found)'}`,
    ``,
    `## Their copy`,
    ``,
    i.bodyText,
    ``,
    `## Screenshots of the site being replaced`,
    ...i.shots.map((s) => `- ${s.viewport}: ${s.file}`),
  ].join('\n');
}
