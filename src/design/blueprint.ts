/**
 * The blueprint: every design decision, committed in writing BEFORE any HTML
 * exists — and checked with arithmetic, not with a model's opinion of itself.
 *
 * Why this file is the centre of the quality story:
 *
 * A model asked to "build a nice landing page" invents its palette and type
 * scale as a side effect of writing CSS. The result is always defensible and
 * always forgettable, because nothing ever had to justify itself. Separating
 * the decision from the implementation means the design can be REJECTED while
 * it is still cheap — a failed blueprint costs one call, a failed page costs a
 * build, a publish, two screenshots and two vision reviews.
 *
 * Everything validated here is measurable. Contrast is arithmetic. A type scale
 * either has hierarchy or it does not. Measured repeatedly on 2026-08-17: every
 * time a model was trusted to self-report in this pipeline it was wrong — it
 * silently dropped images, it reported success on empty output, it scored a page
 * with three deleted sections 53/100. So nothing here asks a model whether the
 * design is good.
 */

export interface Palette {
  /** Page background. */
  background: string;
  surface: string;
  /** Body copy colour, measured against `background`. */
  text: string;
  textMuted: string;
  /** The one colour that carries the primary action. */
  accent: string;
  /** Text placed ON the accent. */
  accentText: string;
  border: string;
}

export interface Blueprint {
  /** One sentence naming the art direction, so the build has something to hold. */
  direction: string;
  company: { name: string; whatTheyDo: string; audience: string; tone: string };
  palette: Palette;
  /** px, ascending. Body text is the second entry by convention. */
  typeScale: number[];
  fonts: { heading: string; body: string };
  /** px, ascending. Every margin and padding in the build comes from here. */
  spacingScale: number[];
  sections: { id: string; heading: string; purpose: string; copy: string }[];
  images: { path: string; prompt: string; alt: string }[];
}

/* ------------------------------------------------------------------ colour */

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? m[1]!.split('').map((c) => c + c).join('') : m[1]!;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** WCAG 2.1 relative luminance. */
function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a: string, b: string): number {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return 0;
  const [hi, lo] = [luminance(ca), luminance(cb)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/* -------------------------------------------------------------- validation */

export interface Violation {
  field: string;
  problem: string;
  fix: string;
}

const BODY_MIN_CONTRAST = 4.5; // WCAG AA, normal text
const LARGE_MIN_CONTRAST = 3.0; // WCAG AA, >=24px
const MIN_BODY_PX = 16;
const MIN_STEP_RATIO = 1.15;

/**
 * Every check here is arithmetic on the blueprint's own numbers. Nothing is
 * rendered and no model is consulted, so this runs in microseconds and is the
 * cheapest possible place to reject a bad design.
 */
export function validate(bp: Blueprint): Violation[] {
  const v: Violation[] = [];
  const p = bp.palette;

  for (const [name, value] of Object.entries(p)) {
    if (!parseHex(value)) {
      v.push({ field: `palette.${name}`, problem: `"${value}" is not a hex colour.`, fix: 'Use #rrggbb.' });
    }
  }
  if (v.length) return v; // Later colour checks would be meaningless.

  const bodyContrast = contrast(p.text, p.background);
  if (bodyContrast < BODY_MIN_CONTRAST) {
    v.push({
      field: 'palette.text',
      problem: `Body text on background is ${bodyContrast.toFixed(2)}:1, below the ${BODY_MIN_CONTRAST}:1 minimum.`,
      fix: 'Darken text or lighten background until the ratio clears 4.5:1.',
    });
  }
  const mutedContrast = contrast(p.textMuted, p.background);
  if (mutedContrast < BODY_MIN_CONTRAST) {
    v.push({
      field: 'palette.textMuted',
      problem: `Muted text is ${mutedContrast.toFixed(2)}:1 on the background. Muted is still body copy.`,
      fix: 'Muted means lower emphasis, not unreadable. Keep it at or above 4.5:1.',
    });
  }
  const accentContrast = contrast(p.accentText, p.accent);
  if (accentContrast < LARGE_MIN_CONTRAST) {
    v.push({
      field: 'palette.accentText',
      problem: `Text on the accent is ${accentContrast.toFixed(2)}:1 — the primary button is the one thing that must be legible.`,
      fix: 'Pick accentText as near-white or near-black, whichever clears 4.5:1 against accent.',
    });
  }
  if (contrast(p.surface, p.background) > 1.6) {
    v.push({
      field: 'palette.surface',
      problem: 'Surface and background differ so much they read as two competing page backgrounds.',
      fix: 'Surface should be a subtle lift off the background, not a second theme.',
    });
  }

  // NOTE: there is deliberately no "too many hues" rule here.
  //
  // An earlier version rejected any palette with more than two distinct hues,
  // on the theory that restraint reads as expensive. That rule was removed once
  // Anthropic's frontend-design skill became the taste authority: the skill
  // asks for a deliberate, distinctive point of view and explicitly warns that
  // AI design already defaults to a narrow set of safe looks. A validator that
  // hard-fails a bold palette would enforce exactly the blandness the skill
  // exists to prevent, and the model cannot argue with a thrown violation.
  //
  // The division of labour: this file owns what is MEASURABLE and
  // non-negotiable — contrast, legible sizes, real copy. The skill owns what is
  // a JUDGEMENT — palette, typeface pairing, layout, the signature element.
  // Accessibility is not a matter of taste; restraint is.

  // Type scale.
  const scale = [...bp.typeScale];
  if (scale.length < 4) {
    v.push({
      field: 'typeScale',
      problem: `Only ${scale.length} steps. There is no hierarchy to build with.`,
      fix: 'Provide at least 4 steps, e.g. 16, 20, 28, 40, 56.',
    });
  } else {
    if (!scale.every((n, i) => i === 0 || n > scale[i - 1]!)) {
      v.push({ field: 'typeScale', problem: 'Steps are not strictly ascending.', fix: 'Sort them ascending.' });
    }
    const body = Math.min(...scale.filter((n) => n >= MIN_BODY_PX), Infinity);
    if (!Number.isFinite(body)) {
      v.push({
        field: 'typeScale',
        problem: `No step is at least ${MIN_BODY_PX}px, so body copy would be too small.`,
        fix: `Include a step of ${MIN_BODY_PX}px or more for body text.`,
      });
    }
    for (let i = 1; i < scale.length; i++) {
      const ratio = scale[i]! / scale[i - 1]!;
      if (ratio < MIN_STEP_RATIO) {
        v.push({
          field: 'typeScale',
          problem: `${scale[i - 1]}px → ${scale[i]}px is a ${ratio.toFixed(2)}x step; too close to read as a different level.`,
          fix: `Space steps at least ${MIN_STEP_RATIO}x apart, or drop one.`,
        });
        break;
      }
    }
  }

  if (bp.spacingScale.length < 4) {
    v.push({
      field: 'spacingScale',
      problem: 'Fewer than 4 spacing steps produces either cramped or arbitrary rhythm.',
      fix: 'Provide at least 4, e.g. 8, 16, 32, 64, 96.',
    });
  }

  if (!bp.direction?.trim() || bp.direction.trim().split(/\s+/).length < 4) {
    v.push({
      field: 'direction',
      problem: 'No stated art direction. Without one the build has nothing to be consistent with.',
      fix: 'One sentence naming the visual stance, e.g. "Editorial and calm: warm neutrals, oversized headings, generous whitespace."',
    });
  }

  if (bp.sections.length < 3) {
    v.push({ field: 'sections', problem: 'Fewer than 3 sections is not a page.', fix: 'Plan the real sections.' });
  }
  for (const s of bp.sections) {
    if (/lorem ipsum/i.test(s.copy) || s.copy.trim().length < 20) {
      v.push({
        field: `sections.${s.id}.copy`,
        problem: 'Placeholder or near-empty copy. Real copy changes the layout it needs.',
        fix: "Write the actual words, drawn from the company's own material.",
      });
    }
  }

  return v;
}

/** The violations as the instruction set the model gets back. */
export function asFixBrief(violations: Violation[]): string {
  return [
    'The blueprint failed validation. These are measured facts, not opinions — fix every one.',
    ...violations.map((x, i) => `${i + 1}. [${x.field}] ${x.problem}\n   Fix: ${x.fix}`),
    '',
    'Return the corrected blueprint as one JSON object and nothing else.',
  ].join('\n');
}
