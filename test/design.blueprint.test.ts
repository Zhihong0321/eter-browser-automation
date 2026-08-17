import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { contrast, validate, type Blueprint } from '../src/design/blueprint.js';

/** A blueprint that passes everything, so each test can break exactly one thing. */
function good(over: Partial<Blueprint> = {}): Blueprint {
  return {
    direction: 'Editorial and calm: warm neutrals, oversized headings, generous whitespace.',
    company: { name: 'SolarTapak', whatTheyDo: 'Rooftop solar', audience: 'Homeowners', tone: 'Trustworthy' },
    palette: {
      background: '#fbfaf7',
      surface: '#f2efe9',
      text: '#1a1a1a',
      textMuted: '#565656',
      accent: '#0f5132',
      accentText: '#ffffff',
      border: '#dcd7cd',
    },
    typeScale: [16, 20, 28, 40, 56],
    fonts: { heading: 'Inter', body: 'Inter' },
    spacingScale: [8, 16, 32, 64, 96],
    sections: [
      { id: 'hero', heading: 'Your roof can pay you back', purpose: 'Convert', copy: 'We design and install rooftop solar for homes across Selangor.' },
      { id: 'benefits', heading: 'Why us', purpose: 'Reassure', copy: 'Lower bills, a 25-year warranty, and a SEDA-registered installer.' },
      { id: 'contact', heading: 'Get a quote', purpose: 'Convert', copy: 'Tell us about your home and we will reply within one working day.' },
    ],
    images: [{ path: 'img/hero.png', prompt: 'rooftop solar, no text', alt: 'Solar panels on a rooftop' }],
    ...over,
  };
}

test('contrast matches the WCAG reference values', () => {
  // Black on white is the definitional 21:1; equal colours are 1:1.
  assert.equal(Math.round(contrast('#000000', '#ffffff')), 21);
  assert.equal(contrast('#ffffff', '#ffffff'), 1);
  // A mid grey on white sits just under the 4.5 AA threshold.
  assert.ok(contrast('#949494', '#ffffff') < 4.5);
  assert.ok(contrast('#767676', '#ffffff') >= 4.5);
});

test('a sound blueprint passes clean', () => {
  assert.deepEqual(validate(good()), []);
});

test('body text below AA contrast is rejected with the measured ratio', () => {
  const v = validate(good({ palette: { ...good().palette, text: '#b9b9b9' } }));
  assert.equal(v.length, 1);
  assert.equal(v[0]!.field, 'palette.text');
  assert.match(v[0]!.problem, /below the 4\.5:1 minimum/);
});

test('muted text is still body copy and must clear AA', () => {
  const v = validate(good({ palette: { ...good().palette, textMuted: '#c9c9c9' } }));
  assert.equal(v[0]!.field, 'palette.textMuted');
});

test('an illegible primary button is caught', () => {
  // Near-white text on a pale accent: the one element that must be readable.
  const v = validate(good({ palette: { ...good().palette, accent: '#ffe9a8', accentText: '#ffffff' } }));
  assert.ok(v.some((x) => x.field === 'palette.accentText'));
});

test('a bold multi-hue palette is allowed through — restraint is the skill\'s call, not the validator\'s', () => {
  // Three strong hues, all legible. This must PASS: hard-failing it here would
  // override the frontend-design skill's whole point about not defaulting to
  // safe looks. The validator only owns measurable accessibility.
  const v = validate(
    good({
      palette: {
        background: '#12002e',
        surface: '#1d0a3d',
        text: '#f5f0ff',
        textMuted: '#c9b8e8',
        accent: '#00e5a0',
        accentText: '#00110a',
        border: '#ff4d6d',
      },
    }),
  );
  assert.deepEqual(v, []);
});

test('a type scale without real steps between levels is rejected', () => {
  const v = validate(good({ typeScale: [16, 17, 18, 19, 20] }));
  assert.ok(v.some((x) => x.field === 'typeScale' && /too close to read as a different level/.test(x.problem)));
});

test('body text smaller than 16px is rejected', () => {
  const v = validate(good({ typeScale: [11, 12.7, 14.6, 15, 15.5] }));
  assert.ok(v.some((x) => /No step is at least 16px/.test(x.problem)));
});

test('too few type steps means there is no hierarchy to build with', () => {
  const v = validate(good({ typeScale: [16, 32] }));
  assert.ok(v.some((x) => x.field === 'typeScale' && /no hierarchy/i.test(x.problem)));
});

test('placeholder copy is rejected — real words change the layout they need', () => {
  const s = good().sections;
  s[1] = { ...s[1]!, copy: 'Lorem ipsum dolor sit amet, consectetur.' };
  const v = validate(good({ sections: s }));
  assert.ok(v.some((x) => x.field === 'sections.benefits.copy'));
});

test('a missing art direction is rejected', () => {
  assert.ok(validate(good({ direction: 'Modern.' })).some((x) => x.field === 'direction'));
});

test('a malformed colour short-circuits the colour checks', () => {
  // Reporting "contrast is 0:1" on top of "not a hex colour" is noise.
  const v = validate(good({ palette: { ...good().palette, accent: 'rebeccapurple' } }));
  assert.equal(v.length, 1);
  assert.equal(v[0]!.field, 'palette.accent');
});
