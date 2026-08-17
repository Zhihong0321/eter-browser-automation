/**
 * An image generator, handed to the building model as a callable tool.
 *
 * The builder (kimi-k3) is text-only: it can neither see images nor make them.
 * It CAN write SVG, which is the right answer for icons, logos and flat
 * patterns — crisp at any size, themeable, and a few hundred bytes. It is the
 * wrong answer for photographic or editorial hero imagery, where hand-written
 * SVG reads as a crude diagram.
 *
 * So raster imagery comes from step-image-edit-2 on the StepFun key. Despite
 * the name it generates from a prompt alone (measured 2026-08-17 against
 * /v1/images/generations, which returns a URL to a PNG).
 *
 * Exposed as an in-process MCP tool rather than a pre-generation step, because
 * the model has to decide what the page needs while it is designing it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const DEFAULT_MODEL = 'step-image-edit-2';
const GENERATE_TIMEOUT_MS = 180_000;

/** Sizes the endpoint accepts, named the way a designer picks them. */
const SIZES = {
  square: '1024x1024',
  landscape: '1280x800',
  portrait: '800x1280',
} as const;

export interface ImageConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** A function, not a const — .env loads after ESM evaluates imports. */
export function imageConfig(): ImageConfig | null {
  const apiKey = process.env.STEPFUN_IMAGE_KEY?.trim() || process.env.STEPFUN_API_KEY?.trim();
  if (!apiKey) return null;
  const base = process.env.FASTWORKER_BASE_URL?.trim().replace(/\/+$/, '');
  return {
    apiKey,
    baseUrl: process.env.STEPFUN_IMAGE_BASE_URL?.trim() || base || 'https://api.stepfun.ai/step_plan/v1',
    model: process.env.STEPFUN_IMAGE_MODEL?.trim() || DEFAULT_MODEL,
  };
}

/**
 * Generate one image and write it into the build directory.
 * Returns the path written, relative to `workDir`, ready to drop into an <img>.
 */
export async function generateImage(
  prompt: string,
  workDir: string,
  relPath: string,
  size: keyof typeof SIZES = 'landscape',
): Promise<string> {
  const cfg = imageConfig();
  if (!cfg) throw new Error('No image model configured — set STEPFUN_API_KEY in .env.');

  // The tool argument comes from a model, so it is untrusted input: keep the
  // write inside the build directory rather than wherever it points.
  const safeRel = relPath.replace(/^[/\\]+/, '').replace(/\.\.[/\\]/g, '');
  const target = path.resolve(workDir, safeRel);
  if (!target.startsWith(path.resolve(workDir) + path.sep)) {
    throw new Error(`Refusing to write outside the build directory: ${relPath}`);
  }

  const res = await fetch(`${cfg.baseUrl}/images/generations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    body: JSON.stringify({ model: cfg.model, prompt, size: SIZES[size], n: 1 }),
  });

  const body = (await res.json().catch(() => ({}))) as {
    data?: { url?: string; b64_json?: string }[];
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(`Image API HTTP ${res.status}: ${body.error?.message ?? 'unknown'}`);

  const first = body.data?.[0];
  const bytes = first?.b64_json
    ? Buffer.from(first.b64_json, 'base64')
    : first?.url
      ? Buffer.from(await (await fetch(first.url)).arrayBuffer())
      : null;
  if (!bytes?.length) throw new Error('Image API returned no image.');

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return safeRel;
}

/**
 * The MCP server handed to the builder. Scoped to one build directory, so the
 * model names a relative path and cannot reach outside it.
 */
export function imageServer(workDir: string) {
  return createSdkMcpServer({
    name: 'imagery',
    version: '1.0.0',
    tools: [
      tool(
        'generate_image',
        'Generate a photographic or illustrated image and save it into the site. Use for hero and editorial imagery only — write SVG by hand for icons, logos, and flat patterns.',
        {
          prompt: z
            .string()
            .describe(
              'What to depict, and the visual style. Name the palette and mood. Say "no text" — generated lettering is always malformed.',
            ),
          path: z
            .string()
            .describe('Where to save it, relative to the site root, e.g. "img/hero.png".'),
          size: z.enum(['square', 'landscape', 'portrait']).default('landscape'),
        },
        async (args) => {
          try {
            const written = await generateImage(args.prompt, workDir, args.path, args.size);
            return {
              content: [
                {
                  type: 'text',
                  text: `Saved to ${written}. Reference it with a RELATIVE src, e.g. <img src="${written}" alt="...">. Always write a real alt.`,
                },
              ],
            };
          } catch (error) {
            return {
              content: [{ type: 'text', text: `Image generation failed: ${error instanceof Error ? error.message : error}` }],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
