/**
 * Bedrock's Layer 1: deterministic, content-agnostic, no model involved.
 *
 * Minify, re-encode images to WebP, patch the attributes Lighthouse checks for
 * (width/height, loading, fetchpriority), and emit the SEO files. This runs
 * once the content is final — right before the last publish — so nothing here
 * ever fights a revision round over what the page says. Compare verify.ts,
 * which only measures; this is the half that changes bytes.
 *
 * What Bedrock's own optimize step does that this one cannot: server-side
 * Brotli precompression and security headers. Both are the serving host's job
 * (pipeline/server.mjs in Bedrock), and sites here publish to a third-party
 * static host (host.ts) that accepts a zip and serves it on its own terms —
 * there is no server for this repo to configure. Minifying before the zip is
 * still the whole win on the size side; Brotli on top of already-minified text
 * saves single-digit percent more.
 */
import fs from 'node:fs';
import path from 'node:path';
import { minify as minifyHtml } from 'html-minifier-terser';
import CleanCSS from 'clean-css';
import sharp from 'sharp';

const SKIP_DIRS = new Set(['.shots', '.best', '.verify', 'node_modules']);
/** Below this, re-encoding a raster image is not worth the extra file + a CSS/JS rewrite. */
const WEBP_MIN_BYTES = 8_000;
const WEBP_QUALITY = 80;

export interface OptimizeReport {
  htmlFiles: number;
  cssFiles: number;
  imagesConverted: { from: string; to: string; fromBytes: number; toBytes: number }[];
  imagesDimensioned: number;
  bytesBefore: number;
  bytesAfter: number;
}

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, exts));
    else if (exts.includes(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSizeBytes(full) : fs.statSync(full).size;
  }
  return total;
}

async function minifyHtmlFiles(dir: string): Promise<number> {
  const files = walk(dir, ['.html']);
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    try {
      const out = await minifyHtml(src, {
        collapseWhitespace: true,
        removeComments: true,
        minifyCSS: true,
        minifyJS: true,
        removeRedundantAttributes: true,
        removeEmptyAttributes: true,
        useShortDoctype: true,
        collapseBooleanAttributes: true,
      });
      fs.writeFileSync(file, out);
    } catch (error) {
      // A minify failure on hand-authored HTML is a syntax problem worth
      // seeing, but must not abort the whole optimize pass over one file.
      console.error(`  optimize: HTML minify skipped for ${path.relative(dir, file)}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return files.length;
}

function minifyCssFiles(dir: string): number {
  const files = walk(dir, ['.css']);
  const cleaner = new CleanCSS({});
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const result = cleaner.minify(src);
    if (result.errors.length) {
      console.error(`  optimize: CSS minify skipped for ${path.relative(dir, file)}: ${result.errors.join('; ')}`);
      continue;
    }
    fs.writeFileSync(file, result.styles);
  }
  return files.length;
}

/**
 * Re-encode every raster image over the size threshold to WebP, rewrite every
 * reference to it across the site's HTML/CSS, and delete the original — a
 * clean swap, not a fallback pair, on the judgment that WebP's browser support
 * (React/Baseline-wide since 2020) no longer earns a <picture> tag's
 * complexity for a small brochure site.
 */
async function convertImagesToWebp(dir: string): Promise<OptimizeReport['imagesConverted']> {
  const images = walk(dir, ['.png', '.jpg', '.jpeg']);
  const converted: OptimizeReport['imagesConverted'] = [];
  const htmlFiles = walk(dir, ['.html']);
  const cssFiles = walk(dir, ['.css']);

  for (const file of images) {
    const fromBytes = fs.statSync(file).size;
    if (fromBytes < WEBP_MIN_BYTES) continue;

    const target = file.replace(/\.(png|jpe?g)$/i, '.webp');
    try {
      await sharp(file).webp({ quality: WEBP_QUALITY }).toFile(target);
    } catch (error) {
      console.error(`  optimize: WebP conversion skipped for ${path.relative(dir, file)}: ${error instanceof Error ? error.message : error}`);
      continue;
    }
    const toBytes = fs.statSync(target).size;
    // A bad source (already near-optimal, or synthetic test fixture) can
    // re-encode LARGER; keep the smaller of the two rather than trust the format.
    if (toBytes >= fromBytes) {
      fs.rmSync(target);
      continue;
    }

    const fromName = path.basename(file);
    const toName = path.basename(target);
    for (const ref of [...htmlFiles, ...cssFiles]) {
      const text = fs.readFileSync(ref, 'utf8');
      if (text.includes(fromName)) fs.writeFileSync(ref, text.split(fromName).join(toName));
    }
    fs.rmSync(file);
    converted.push({ from: path.relative(dir, file), to: path.relative(dir, target), fromBytes, toBytes });
  }
  return converted;
}

/**
 * Mark every image after the first as lazy, and give the first image — the
 * page's presumed LCP candidate — fetchpriority="high" plus a <link
 * rel="preload"> in <head>. Width/height is a separate async pass
 * (`dimensionImages`, below) because sharp's metadata read cannot happen
 * inside a synchronous regex-replace callback.
 *
 * Regex over the raw markup, not a DOM parse-and-reserialize: Kimi's own
 * formatting, comments and attribute order survive untouched, which matters
 * because verify.ts's revision loop diffs against what it wrote.
 */
function patchImageAttributes(dir: string): number {
  const htmlFiles = walk(dir, ['.html']);
  let patched = 0;

  for (const file of htmlFiles) {
    let text = fs.readFileSync(file, 'utf8');
    let seenImg = false;
    let preloadHref: string | null = null;

    text = text.replace(/<img\b([^>]*)>/gi, (_whole, attrs: string) => {
      const first = !seenImg;
      seenImg = true;

      const srcMatch = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
      const src = srcMatch?.[1];
      let nextAttrs = attrs;

      if (first) {
        if (!/\bfetchpriority\s*=/i.test(nextAttrs)) nextAttrs += ' fetchpriority="high"';
        if (src) preloadHref = src;
      } else if (!/\bloading\s*=/i.test(nextAttrs)) {
        nextAttrs += ' loading="lazy" decoding="async"';
      }
      patched++;
      return `<img${nextAttrs}>`;
    });

    if (preloadHref && /<head[^>]*>/i.test(text) && !text.includes(`preload" href="${preloadHref}"`)) {
      const ext = path.extname(preloadHref).toLowerCase();
      const type = ext === '.webp' ? 'image/webp' : ext === '.png' ? 'image/png' : ext === '.svg' ? 'image/svg+xml' : 'image/jpeg';
      text = text.replace(/<head([^>]*)>/i, `<head$1>\n<link rel="preload" as="image" href="${preloadHref}" type="${type}">`);
    }

    fs.writeFileSync(file, text);
  }
  return patched;
}

/**
 * Explicit width/height on every <img> that lacks one — a separate async pass
 * because sharp's metadata read is asynchronous and `patchImageAttributes`'s
 * regex replace callback cannot await. Run AFTER `patchImageAttributes` and
 * AFTER `convertImagesToWebp`, so the src it reads is the final one.
 */
async function dimensionImages(dir: string): Promise<number> {
  const htmlFiles = walk(dir, ['.html']);
  let dimensioned = 0;

  for (const file of htmlFiles) {
    let text = fs.readFileSync(file, 'utf8');
    const tags = [...text.matchAll(/<img\b[^>]*>/gi)];
    for (const [tag] of tags) {
      if (/\bwidth\s*=/i.test(tag) && /\bheight\s*=/i.test(tag)) continue;
      const srcMatch = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag);
      if (!srcMatch) continue;
      const abs = path.resolve(path.dirname(file), srcMatch[1]!);
      if (!fs.existsSync(abs)) continue;
      try {
        const meta = await sharp(abs).metadata();
        if (!meta.width || !meta.height) continue;
        const patchedTag = tag.replace(/>$/, ` width="${meta.width}" height="${meta.height}">`);
        text = text.replace(tag, patchedTag);
        dimensioned++;
      } catch {
        // Not every <img src> is a local raster file (data: URIs, remote
        // hotlinks) — those are left exactly as written.
      }
    }
    fs.writeFileSync(file, text);
  }
  return dimensioned;
}

export async function optimizeDir(dir: string): Promise<OptimizeReport> {
  const bytesBefore = dirSizeBytes(dir);

  const imagesConverted = await convertImagesToWebp(dir);
  patchImageAttributes(dir);
  const imagesDimensioned = await dimensionImages(dir);
  const htmlFiles = await minifyHtmlFiles(dir);
  const cssFiles = minifyCssFiles(dir);

  const bytesAfter = dirSizeBytes(dir);

  return { htmlFiles, cssFiles, imagesConverted, imagesDimensioned, bytesBefore, bytesAfter };
}

/**
 * sitemap.xml + robots.txt, Bedrock's minimum SEO file set. llms.txt is
 * skipped: it names sections and policy an operator should write on purpose,
 * not infer from a file list.
 */
export function writeSeoFiles(dir: string, siteUrl: string, pagePaths: string[] = ['/']): void {
  const base = siteUrl.replace(/\/+$/, '');
  const today = new Date().toISOString().slice(0, 10);
  const urls = pagePaths
    .map((p) => `  <url>\n    <loc>${base}${p}</loc>\n    <lastmod>${today}</lastmod>\n  </url>`)
    .join('\n');
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  fs.writeFileSync(path.join(dir, 'sitemap.xml'), sitemap);

  const robots = `User-agent: *\nAllow: /\n\nSitemap: ${base}/sitemap.xml\n`;
  fs.writeFileSync(path.join(dir, 'robots.txt'), robots);
}

/** The report as a line a human reads at the end of a run. */
export function formatOptimizeReport(r: OptimizeReport): string {
  const savedKb = ((r.bytesBefore - r.bytesAfter) / 1024).toFixed(1);
  const pct = r.bytesBefore ? Math.round((1 - r.bytesAfter / r.bytesBefore) * 100) : 0;
  const lines = [
    `  optimize : ${r.htmlFiles} html · ${r.cssFiles} css minified · ${r.imagesConverted.length} image(s) → WebP · ` +
      `${r.imagesDimensioned} <img> dimensioned`,
    `  size     : ${(r.bytesBefore / 1024).toFixed(1)} KB → ${(r.bytesAfter / 1024).toFixed(1)} KB (saved ${savedKb} KB, ${pct}%)`,
  ];
  for (const img of r.imagesConverted) {
    lines.push(`    ${img.from} → ${img.to}: ${(img.fromBytes / 1024).toFixed(1)} KB → ${(img.toBytes / 1024).toFixed(1)} KB`);
  }
  return lines.join('\n');
}
