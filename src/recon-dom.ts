/**
 * RECON-AGENT — what is on the page, and what may be clicked.
 *
 * Spec: docs/superpowers/specs/2026-08-12-recon-agent-design.md §5, §6.2
 *
 * Selectors are role- and attribute-based, never CSS classes: classes on every
 * site here are obfuscated per build (INDEX.md), so a class selector works
 * until the next deploy and then silently matches nothing.
 */

export interface UiElement {
  role: string;
  name: string;
  tag: string;
  /** A Playwright expression a human or an AI can paste as-is. */
  selector: string;
  strategy: 'testid' | 'aria-label' | 'role-name' | 'css';
  href: string | null;
  disabled: boolean;
  inNav: boolean;
  inForm: boolean;
  /** A submit control lives in the same region — so this may belong to a form. */
  hasSubmitNear: boolean;
  /** aria-expanded, when present: this is a disclosure toggle. */
  expanded: boolean | null;
}

export interface TableShape {
  headers: string[];
  columns: number;
  rows: number;
}

export interface PageDom {
  elements: UiElement[];
  table: TableShape | null;
  /** Same-origin destinations reachable from the nav surface. */
  navLinks: { name: string; href: string }[];
}

/** Runs in the page. Self-contained by necessity — it is serialized to get there. */
export function collectDom(): PageDom {
  const cap = (s: string, n = 80): string => s.replace(/\s+/g, ' ').trim().slice(0, n);

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'button';
    if (tag === 'input') {
      const t = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      return 'textbox';
    }
    return 'generic';
  };

  const nameOf = (el: Element): string => {
    const aria = el.getAttribute('aria-label');
    if (aria?.trim()) return cap(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const txt = by
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
      if (txt.trim()) return cap(txt);
    }
    const id = el.getAttribute('id');
    if (id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lbl?.textContent?.trim()) return cap(lbl.textContent);
    }
    for (const attr of ['title', 'alt', 'placeholder', 'value']) {
      const v = el.getAttribute(attr);
      if (v?.trim()) return cap(v);
    }
    return cap(el.textContent ?? '');
  };

  const quote = (s: string): string => s.replace(/'/g, "\\'");

  const selectorFor = (el: Element, role: string, name: string): Pick<UiElement, 'selector' | 'strategy'> => {
    for (const attr of ['data-testid', 'data-test', 'data-cy', 'data-qa']) {
      const v = el.getAttribute(attr);
      if (v) return { selector: `[${attr}="${v}"]`, strategy: 'testid' };
    }
    const aria = el.getAttribute('aria-label');
    if (aria?.trim()) return { selector: `[aria-label="${aria.trim()}"]`, strategy: 'aria-label' };
    if (role !== 'generic' && name) return { selector: `getByRole('${role}', { name: '${quote(name)}' })`, strategy: 'role-name' };
    const tag = el.tagName.toLowerCase();
    const id = el.getAttribute('id');
    return { selector: id ? `#${id}` : tag, strategy: 'css' };
  };

  const INTERACTIVE =
    'a[href], button, summary, input, select, textarea, [role="tab"], [role="button"], [role="link"], ' +
    '[role="menuitem"], [role="treeitem"], [role="option"], [role="combobox"], [role="radio"], [role="checkbox"], [aria-expanded]';

  const NAV_SEL = 'nav, aside, [role="navigation"], [role="menubar"], [role="menu"], [role="tree"], [role="tablist"]';

  const elements: UiElement[] = [];
  const seen = new Set<string>();

  for (const el of Array.from(document.querySelectorAll(INTERACTIVE))) {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;

    const role = roleOf(el);
    const name = nameOf(el);
    if (!name && role === 'generic') continue;

    const key = `${role}::${name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const form = el.closest('form');
    const region = form ?? el.closest('[role="dialog"], section, [role="region"]') ?? null;
    const expandedAttr = el.getAttribute('aria-expanded');
    const { selector, strategy } = selectorFor(el, role, name);

    elements.push({
      role,
      name,
      tag: el.tagName.toLowerCase(),
      selector,
      strategy,
      href: el.getAttribute('href'),
      disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
      inNav: !!el.closest(NAV_SEL),
      inForm: !!form,
      hasSubmitNear: !!region?.querySelector('button[type="submit"], input[type="submit"]'),
      expanded: expandedAttr === null ? null : expandedAttr === 'true',
    });
    if (elements.length >= 400) break;
  }

  // Table shape: headers plus a settled row count.
  let table: TableShape | null = null;
  const t = document.querySelector('table, [role="grid"], [role="table"]');
  if (t) {
    const headers = Array.from(t.querySelectorAll('thead th, [role="columnheader"]'))
      .map((h) => cap(h.textContent ?? '', 40))
      .filter(Boolean);
    const rows = t.querySelectorAll('tbody tr, [role="row"]').length;
    table = { headers, columns: headers.length, rows: Math.max(0, rows - (headers.length ? 0 : 1)) };
  }

  const navLinks: { name: string; href: string }[] = [];
  const navSeen = new Set<string>();
  // Each part needs its own descendant clause: "a, b c" means "a" OR "b c",
  // so appending to the joined list would only scope the final entry.
  const navLinkSel = NAV_SEL.split(',')
    .map((s) => `${s.trim()} a[href]`)
    .join(', ');
  // A landmark-scoped pass first: on a server-rendered app it finds the menu and
  // nothing else. But an SPA shell often builds its sidebar out of plain divs —
  // AutoCount Cloud renders 39 same-origin links, every one of them inNav=false,
  // so the scoped pass returned 0 and the crawl stopped at one page. Falling back
  // to every same-origin link is noisier, never blinder.
  const collect = (sel: string): void => {
    for (const a of Array.from(document.querySelectorAll(sel))) {
      // SVG anchors expose href as an SVGAnimatedString, not a string.
      const href = (a as HTMLAnchorElement).href;
      if (typeof href !== 'string' || !href.startsWith(location.origin)) continue;
      const clean = href.split('#')[0];
      if (clean === location.href.split('#')[0] || navSeen.has(clean)) continue;
      navSeen.add(clean);
      navLinks.push({ name: nameOf(a) || clean, href: clean });
      if (navLinks.length >= 120) break;
    }
  };

  collect(navLinkSel);
  if (!navLinks.length) collect('a[href]');

  return { elements, table, navLinks };
}

// ---------------------------------------------------------------- policy

export type ClickVerdict = { allowed: true; why: string } | { allowed: false; reason: string };

const PAGINATION = /\b(?:next|prev|previous|first|last|page\s*\d+|\d+)\b/i;

/**
 * Allowlist by ROLE, not denylist by name.
 *
 * A name denylist guesses, and an ERP is dense with destructive controls whose
 * names it would not catch — Post, Void, Commit, Save & New, Confirm Journal.
 * So pass 1 clicks only what is structurally safe, and everything else goes to
 * the human's tick-to-approve list with the reason it was skipped.
 */
export function clickPolicy(el: UiElement): ClickVerdict {
  if (el.disabled) return { allowed: false, reason: 'disabled' };

  if (el.role === 'tab') return { allowed: true, why: 'tab' };

  if (el.expanded !== null && el.inNav) return { allowed: true, why: 'nav disclosure toggle' };

  if (el.role === 'link' && el.inNav) {
    if (el.href && /^(?:javascript|mailto|tel):/i.test(el.href)) return { allowed: false, reason: 'non-navigational link' };
    return { allowed: true, why: 'nav link' };
  }

  if ((el.role === 'button' || el.role === 'link') && PAGINATION.test(el.name) && !el.inForm) {
    return { allowed: true, why: 'pagination' };
  }

  // The one judgement call. A filter that quietly belongs to a form is a
  // mutation, so both checks must pass or it goes to the approve list.
  if (el.role === 'combobox' || el.role === 'radio') {
    if (el.inForm) return { allowed: false, reason: 'filter inside a <form> — may submit' };
    if (el.hasSubmitNear) return { allowed: false, reason: 'filter next to a submit control — may submit' };
    return { allowed: true, why: 'standalone filter' };
  }

  if (el.role === 'button') return { allowed: false, reason: 'button — never clicked in pass 1' };
  if (el.tag === 'input' || el.tag === 'textarea') return { allowed: false, reason: 'input field — recon never types' };
  return { allowed: false, reason: `role ${el.role} not on the allowlist` };
}

export interface SkippedControl {
  role: string;
  name: string;
  selector: string;
  reason: string;
}

export function partitionByPolicy(elements: UiElement[]): { clickable: UiElement[]; skipped: SkippedControl[] } {
  const clickable: UiElement[] = [];
  const skipped: SkippedControl[] = [];
  for (const el of elements) {
    const v = clickPolicy(el);
    if (v.allowed) clickable.push(el);
    else skipped.push({ role: el.role, name: el.name, selector: el.selector, reason: v.reason });
  }
  return { clickable, skipped };
}
