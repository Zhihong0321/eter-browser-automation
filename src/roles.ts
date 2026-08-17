/**
 * Roles — what an agent IS, independent of which model it runs on.
 *
 * A role is a system prompt plus the SDK options that make it work. It carries
 * no key, no base URL and no model: see ConnProfile in agent.ts for those. Any
 * role runs on any connection, which is the whole point of splitting them.
 *
 * Add a role by adding one entry to ROLES.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

/** Repo root: this file sits one level down, in src/ or dist/. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Anthropic's frontend-design skill, vendored into the repo rather than read
 * from the operator's ~/.claude/plugins. Same reason agent.ts pins a repo-local
 * Claude home: a run must be identical on every machine, and a path into
 * someone's plugin marketplace is not.
 *
 * Loaded via `plugins`, which is an explicit path — NOT via settingSources,
 * which stays [] so no CLAUDE.md, memory or credential ever reaches a
 * third-party provider.
 */
export const FRONTEND_DESIGN_PLUGIN = path.join(REPO_ROOT, '.agents', 'plugins', 'frontend-design');

export interface Role {
  id: string;
  /** One line, shown in --help. */
  description: string;
  /** Merged over runAgent's cautious defaults, under any explicit overrides. */
  options: Partial<Options>;
}

const FRONTEND_BRIEF = `
You are a frontend web development specialist. Your work is HTML, CSS,
JavaScript/TypeScript, and the component frameworks built on them.

Judgement:
- Semantic HTML first. Reach for a div only when no element carries the meaning.
- Accessibility is part of "done", not a later pass: real labels, keyboard
  reachability, visible focus, contrast that survives both colour schemes.
- Responsive by default. Relative units and flex/grid over fixed pixel layouts.
  No component may force the page to scroll horizontally.
- Match the surrounding code. Read the neighbouring files before writing: its
  framework, its naming, its styling approach, its comment density. Do not
  introduce a new dependency, build step, or styling system to a project that
  already has one.
- Prefer the platform. Use a library when it earns its weight, not by reflex.

Verification, not assertion: when a change is visible, run the project and look
at it, or state plainly that you did not.
`.trim();

/**
 * Taste comes from Anthropic's `frontend-design` skill, vendored at
 * .agents/plugins/frontend-design (Apache 2.0, license retained). Do NOT restate
 * its guidance here.
 *
 * An earlier version of this file carried a hand-written brief — "restrained
 * colour, neutrals carry the page, one accent" and so on. It was deleted
 * because it actively fought the skill: the skill's whole thesis is that a
 * design should take one justified aesthetic risk and must not read as a
 * default, while the hand-written rules optimised for safety. Two system
 * prompts pulling opposite ways produces the blandest of both.
 *
 * Worth knowing why that mattered: the skill names the three looks AI design
 * defaults to, the first being "a warm cream background (near #F4F1EA) with a
 * high-contrast serif display and a terracotta accent". The page this pipeline
 * produced on 2026-08-17, under the hand-written brief, computed to a #faf7f1
 * cream with an #e8a33d gold accent. It generated the documented default
 * verbatim.
 *
 * What remains below is only what the skill CANNOT know: the constraints of
 * this specific host, and the fact that this model is blind and has an image
 * tool. Facts, not taste.
 */
const DESIGNER_CONSTRAINTS = `
FIRST, before anything else: invoke the frontend-design skill and follow it.
It governs every aesthetic decision you make. This is not optional and not
conditional — a skill that is merely available has not been read. Measured
2026-08-17: asked about the skill's contents without invoking it, this model
answered plausibly and wrongly from general knowledge; after invoking it, it
quoted the file exactly.

Everything below is a fact about the delivery target, not design advice.

IMAGERY — you cannot see, so choose the right medium rather than guessing
- Icons, logos, flat patterns, background shapes: WRITE SVG BY HAND. Crisp at
  any size, themeable with currentColor, a few hundred bytes. Never generate a
  raster image for these.
- Hero and editorial imagery: call the generate_image tool if it is available.
  Hand-written SVG at that scale reads as a crude diagram. Name the palette and
  mood in the prompt, and always say "no text" — generated lettering comes out
  malformed.
- Every image needs a real alt attribute and a relative src.
- Never use an external image URL: the host serves static files, and a hotlinked
  asset is a dependency you do not control.

HOSTING CONSTRAINTS — the page is served under /app/<slug>/
- STATIC files only. No server code, no databases. Anything dynamic runs in the
  browser.
- index.html MUST sit at the root of your output directory.
- Asset paths MUST be relative: href="css/app.css", never "/css/app.css". An
  absolute path 404s and the page ships unstyled.
- Client-side routing must use hash or relative routes.

Never claim you have checked how something looks unless you were shown a
screenshot of it.
`.trim();

const ROLES: Record<string, Role> = {
  /**
   * No system prompt and no tools — the original behaviour every existing
   * caller (enrich/agy.ts) depends on. Options stay empty so runAgent's own
   * defaults apply unchanged.
   */
  plain: {
    id: 'plain',
    description: 'Bare prompt-in, text-out. No tools, no system prompt.',
    options: {},
  },

  frontend: {
    id: 'frontend',
    description: 'Frontend web dev specialist. Full tool access, no permission prompts.',
    options: {
      // Every built-in tool. `tools: [...names]` would work too, but the preset
      // tracks new tools as the SDK adds them instead of silently omitting them.
      tools: { type: 'preset', preset: 'claude_code' },
      // Appended to Claude Code's own prompt rather than replacing it: a plain
      // string `systemPrompt` drops all the harness's tool-usage guidance, and
      // a tool-using coding agent without it is measurably worse at the tools.
      systemPrompt: { type: 'preset', preset: 'claude_code', append: FRONTEND_BRIEF },
      // Non-interactive: there is no human on the other end of a permission
      // prompt here, so 'default' would stall and 'dontAsk' would deny every
      // write. The SDK requires the second flag as an explicit acknowledgement.
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    },
  },

  designer: {
    id: 'designer',
    description: "Pro web designer, driven by Anthropic's frontend-design skill.",
    options: {
      tools: { type: 'preset', preset: 'claude_code' },
      // Only the delivery constraints are appended. Taste comes from the skill.
      systemPrompt: { type: 'preset', preset: 'claude_code', append: DESIGNER_CONSTRAINTS },
      plugins: [{ type: 'local', path: FRONTEND_DESIGN_PLUGIN }],
      // Named, not 'all': this agent gets the design skill and nothing else.
      skills: ['frontend-design'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    },
  },
};

export const ROLE_IDS = Object.keys(ROLES);
export const DEFAULT_ROLE = 'plain';

export function resolveRole(id: string = DEFAULT_ROLE): Role {
  const role = ROLES[id];
  if (!role) throw new Error(`Unknown role "${id}". Known: ${ROLE_IDS.join(', ')}`);
  return role;
}
