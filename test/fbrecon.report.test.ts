import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { esc, renderProject, renderIndex } from '../src/fb-recon/report.js';
import { ZERO_COUNTERS, type ProjectContact, type ProjectFile } from '../src/fb-recon/project.js';

function contact(over: Partial<ProjectContact> = {}): ProjectContact {
  return {
    id: 'ali.bin.abu',
    name: 'Ali Bin Abu',
    profileUrl: 'https://www.facebook.com/ali.bin.abu',
    messenger: 'https://m.me/ali.bin.abu',
    phones: [],
    waLinks: [],
    emails: [],
    evidence: [{ permalink: 'p1', quote: 'berapa harga solar?', sourceKind: 'group', role: 'author', at: 'a' }],
    intent: 'buying',
    score: 9,
    firstSeen: '2026-08-12T00:00:00.000Z',
    lastSeen: '2026-08-12T00:00:00.000Z',
    priorProjects: [],
    ...over,
  };
}

function project(over: Partial<ProjectFile> = {}): ProjectFile {
  return {
    version: 1,
    id: '20260812-1430-solar-9f3a',
    topic: 'solar',
    sources: ['group:https://www.facebook.com/groups/x'],
    minScore: 3,
    status: 'done',
    startedAt: '2026-08-12T14:30:00.000Z',
    finishedAt: '2026-08-12T14:35:00.000Z',
    error: null,
    counters: { ...ZERO_COUNTERS, scanned: 43, totalContacts: 1, newContacts: 1 },
    bySource: { 'group:https://www.facebook.com/groups/x': 12 },
    events: [{ at: '2026-08-12T14:30:01.000Z', phase: 'sweep', detail: 'opening' }],
    problems: [],
    contacts: [contact()],
    ...over,
  };
}

test('esc neutralises every character that can break out of markup', () => {
  assert.equal(esc(`<script>alert("x")&'`), '&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;');
});

test('a hostile display name cannot inject a tag into the report', () => {
  const html = renderProject(project({ contacts: [contact({ name: '<script>alert(1)</script>' })] }));
  assert.ok(!html.includes('<script>alert(1)</script>'), 'display name was not escaped');
  assert.ok(html.includes('&lt;script&gt;'), 'expected the escaped form to be present');
});

test('a hostile quote cannot inject markup either', () => {
  const evil = contact({ evidence: [{ permalink: 'p', quote: '</td></tr><img src=x onerror=alert(1)>', sourceKind: 'group', role: 'author', at: 'a' }] });
  const html = renderProject(project({ contacts: [evil] }));
  assert.ok(!html.includes('<img src=x'), 'quote was not escaped');
});

test('the report is self-contained — no external asset may be referenced', () => {
  const html = renderProject(project());
  for (const bad of ['<script', 'src="http', 'href="http://cdn', '@import', 'fonts.googleapis']) {
    assert.ok(!html.includes(bad), `report must not reference ${bad}`);
  }
  // The only external hrefs allowed are the contact's own profile / Messenger links.
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  for (const h of hrefs) {
    assert.ok(
      h.startsWith('https://www.facebook.com/') || h.startsWith('https://m.me/') || !h.startsWith('http'),
      `unexpected external link: ${h}`,
    );
  }
});

test('a running project auto-refreshes; a finished one does not', () => {
  assert.ok(renderProject(project({ status: 'running' })).includes('http-equiv="refresh"'));
  assert.ok(!renderProject(project({ status: 'done' })).includes('http-equiv="refresh"'));
});

test('a failed project shows the error prominently', () => {
  const html = renderProject(project({ status: 'failed', error: 'browser vanished' }));
  assert.ok(html.includes('browser vanished'));
  assert.ok(html.includes('FAILED'));
});

test('a project with no contacts renders an explicit empty state, not a blank page', () => {
  const html = renderProject(project({ contacts: [], counters: { ...ZERO_COUNTERS } }));
  assert.ok(html.includes('No contacts harvested'));
});

test('contacts seen in earlier projects are visibly flagged', () => {
  const html = renderProject(project({ contacts: [contact({ priorProjects: ['20260101-0900-solar-aaaa'] })] }));
  assert.ok(html.includes('seen in 1'), 'a repeat contact must be flagged in the report');
  assert.ok(html.includes('20260101-0900-solar-aaaa'), 'the earlier project should be identifiable');
});

test('the index links each project to its own report and survives being empty', () => {
  const html = renderIndex([project()]);
  assert.ok(html.includes('href="20260812-1430-solar-9f3a/report.html"'));
  assert.ok(renderIndex([]).includes('No projects yet'));
});

test('every report declares a charset — the harvest is routinely CJK', () => {
  assert.ok(renderProject(project()).includes('charset="utf-8"'));
});

test('the report carries the PDPA handling notice', () => {
  assert.match(renderProject(project()), /PDPA/);
});
