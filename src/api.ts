import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAEMON_PORT } from './config.js';
import type { VaultService } from './service.js';
import { runAutomation, searchAutomations } from './registry.js';
import { createProject, findUnfinished, listProjects, loadProject, projectDir } from './gmapproject.js';
import { finish as finishProject, isRunning, runState, startBackground } from './gmaprun.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Works from both src/ (tsx) and dist/ (built) layouts.
const UI_CANDIDATES = [path.join(HERE, 'ui', 'index.html'), path.join(HERE, '..', 'src', 'ui', 'index.html')];

function uiFile(): string | null {
  return UI_CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function send(res: http.ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(payload);
}

type Handler = (body: Record<string, unknown>, params: string[]) => Promise<unknown>;

export function createServer(svc: VaultService): http.Server {
  const num = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
  const str = (v: unknown): string => {
    if (typeof v !== 'string' || !v.trim()) throw new Error('missing required string field');
    return v;
  };

  /** Accepts ["a","b"] or "a, b" — the UI sends a plain text field. */
  const asList = (v: unknown): string[] =>
    (Array.isArray(v) ? v.map(String) : String(v ?? '').split(','))
      .map((x) => x.trim())
      .filter(Boolean);

  /** Project ids reach the filesystem, so '..' must never survive the URL. */
  const safeId = (v: string): string => {
    if (!v || v.includes('..')) throw new Error(`Bad project id "${v}".`);
    return v;
  };

  /** Every session route accepts an optional profile; absent means the agent profile. */
  const prof = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

  const routes: [string, RegExp, Handler][] = [
    ['GET', /^\/api\/status$/, async () => svc.status()],
    ['GET', /^\/api\/status\/([\w.-]+)$/, async (_b, p) => svc.status(p[0])],

    // Chrome profiles. One profile is one Chrome and one set of logins, so a job
    // with its own profile cannot be killed by another job's browser.
    ['GET', /^\/api\/profiles$/, async () => ({ profiles: svc.listProfiles() })],
    ['POST', /^\/api\/profiles$/, async (b) => svc.createProfile(str(b.id), b.label as string | undefined)],
    ['GET', /^\/api\/ready$/, async () => ({ sessions: svc.readySessions() })],

    // Add ANY site: the body carries the URL the user typed.
    ['POST', /^\/api\/sessions$/, async (b) => svc.addSession(str(b.url), b.label as string | undefined, prof(b.profile))],
    ['POST', /^\/api\/sessions\/([\w.-]+)\/open$/, async (b, p) => svc.openSession(p[0], prof(b.profile))],
    ['POST', /^\/api\/sessions\/([\w.-]+)\/confirm$/, async (b, p) => svc.confirmSession(p[0], prof(b.profile))],
    ['POST', /^\/api\/sessions\/([\w.-]+)\/check$/, async (b, p) => svc.checkSession(p[0], b.deep !== false, prof(b.profile))],
    ['POST', /^\/api\/sessions\/([\w.-]+)\/rename$/, async (b, p) => svc.renameSession(p[0], str(b.label), prof(b.profile))],
    ['DELETE', /^\/api\/sessions\/([\w.-]+)$/, async (b, p) => svc.removeSession(p[0], prof(b.profile))],
    ['POST', /^\/api\/check-all$/, async (b) => ({ sessions: await svc.checkAll(b.deep !== false, prof(b.profile)) })],

    ['POST', /^\/api\/browser\/open$/, async () => {
      await svc.navigate('about:blank');
      return svc.browser.info;
    }],
    ['POST', /^\/api\/browser\/close$/, async () => {
      await svc.browser.close();
      return svc.browser.info;
    }],
    ['POST', /^\/api\/browser\/navigate$/, async (b) => svc.navigate(str(b.url))],
    ['POST', /^\/api\/browser\/read$/, async (b) => svc.readText(num(b.maxChars, 8000))],
    ['POST', /^\/api\/browser\/click$/, async (b) => svc.clickText(str(b.name), b.role as string | undefined)],
    ['POST', /^\/api\/browser\/type$/, async (b) => svc.typeInto(str(b.label), str(b.text), b.submit === true)],
    ['POST', /^\/api\/browser\/screenshot$/, async () => svc.screenshot()],
    ['POST', /^\/api\/browser\/eval$/, async (b) => svc.evaluate(str(b.expr))],

    ['GET', /^\/api\/recon\/projects$/, async () => ({ projects: svc.reconProjects() })],
    ['GET', /^\/api\/recon\/projects\/([\w.-]+)$/, async (_b, p) => svc.reconProject(safeId(p[0]))],
    ['GET', /^\/api\/recon\/v3\/projects$/, async () => ({ projects: svc.reconV3Projects() })],
    ['GET', /^\/api\/recon\/v3\/projects\/([\w.-]+)$/, async (_b, p) => svc.reconV3Project(safeId(p[0]))],
    ['POST', /^\/api\/recon\/probe$/, async (b) => svc.reconProbe(str(b.url), num(b.windowMs, 8000))],
    ['POST', /^\/api\/recon\/scan$/, async (b) =>
      svc.reconScan(str(b.url), {
        windowMs: num(b.windowMs, 8000),
        quietMs: num(b.quietMs, 2000),
        maxPages: num(b.maxPages, 40),
        approved: Array.isArray(b.approved) ? (b.approved as string[]) : [],
      })],
    ['POST', /^\/api\/recon\/v3\/scan$/, async (b) =>
      svc.reconV3Scan(str(b.url), {
        maxPages: num(b.maxPages, 40),
        concurrency: num(b.concurrency, 3),
        settleQuietMs: num(b.settleQuietMs, 650),
        settleCapMs: num(b.settleCapMs, 3500),
        replay: b.replay !== false,
        replayConcurrency: num(b.replayConcurrency, 4),
        replayLimit: num(b.replayLimit, 12),
        screenshots: b.screenshots !== false,
        fullPage: b.fullPage === true,
        exploreTabs: b.exploreTabs === true,
      }, prof(b.profile))],

    ['POST', /^\/api\/wa\/chats$/, async (b) => ({ chats: await svc.waListChats(num(b.limit, 20)) })],
    ['POST', /^\/api\/wa\/read$/, async (b) => svc.waReadChat(str(b.target), num(b.limit, 20))],
    ['POST', /^\/api\/wa\/send$/, async (b) => svc.waSend(str(b.target), str(b.text))],

    ['POST', /^\/api\/chatgpt\/ask$/, async (b) => svc.chatgptAsk(str(b.question))],

    ['GET', /^\/api\/nlm\/notebooks$/, async () => ({ notebooks: await svc.nlmListNotebooks() })],
    ['POST', /^\/api\/nlm\/ask$/, async (b) => svc.nlmAsk(str(b.notebookId), str(b.question))],
    ['POST', /^\/api\/nlm\/notebooks$/, async (b) => svc.nlmCreateNotebook(str(b.title))],

    ['POST', /^\/api\/fb\/my-posts$/, async (b) => ({ posts: await svc.fbReadMyPosts(num(b.limit, 5)) })],
    ['POST', /^\/api\/fb\/feed$/, async (b) => ({ posts: await svc.fbReadFeed(num(b.limit, 5)) })],
    ['POST', /^\/api\/fb\/comment$/, async (b) => svc.fbComment(str(b.postUrl), str(b.text))],
    ['POST', /^\/api\/fb\/recon$/, async (b) => svc.fbRecon({
      topic: str(b.topic),
      sources: Array.isArray(b.sources) ? (b.sources as string[]) : undefined,
      minScore: typeof b.minScore === 'number' ? b.minScore : undefined,
      maxRounds: typeof b.maxRounds === 'number' ? b.maxRounds : undefined,
      profile: prof(b.profile),
    })],
    ['POST', /^\/api\/fb\/recon\/stop$/, async () => svc.fbReconStop()],
    ['GET', /^\/api\/fb\/recon\/running$/, async () => svc.fbReconRunning()],
    ['GET', /^\/api\/fb\/recon\/projects$/, async () => ({
      projects: svc.fbReconProjects(),
      run: svc.fbReconRunning(),
    })],
    ['GET', /^\/api\/fb\/recon\/projects\/([\w.-]+)$/, async (_b, p) => svc.fbReconProject(safeId(p[0]))],

    // The automation registry — a scan over the cards under src/automations/.
    // Two generic endpoints stand in for N typed ones, so adding an automation is
    // adding a file, with nothing here to update.
    ['POST', /^\/api\/automations\/search$/, async (b) => ({
      automations: searchAutomations(typeof b.query === 'string' ? b.query : '', num(b.limit, 10)),
    })],
    ['POST', /^\/api\/automations\/run$/, async (b) => ({
      result: await runAutomation(svc, str(b.id), (b.args ?? {}) as Record<string, unknown>),
    })],

    // ---------------------------------------------------------- gmap-recon
    // A harvest lasts minutes to hours, so starting one returns immediately and the
    // UI polls. runState() is the live view; project.json is the durable one.
    ['GET', /^\/api\/gmap\/projects$/, async () => ({ projects: listProjects(), run: runState() })],

    ['POST', /^\/api\/gmap\/projects$/, async (b) => {
      const keywords = asList(b.keywords);
      const places = asList(b.places);
      if (!keywords.length || !places.length) throw new Error('Need at least one keyword and one town.');
      if (isRunning()) throw new Error(runState().projectId
        ? `A search is already running ("${runState().projectId}"). Wait for it to finish.`
        : 'A search is already running.');

      // Guard a half-finished campaign: the Google searches already spent are the
      // scarce resource, not the disk space.
      const open = b.force === true ? null : findUnfinished(keywords, places);
      if (open) return { existing: open, started: false };

      const meta = createProject(keywords, places);
      const r = startBackground(svc, meta);
      if (!r.started) throw new Error(r.reason ?? 'Could not start.');
      return { project: meta, started: true };
    }],

    ['POST', /^\/api\/gmap\/projects\/([\w.-]+)\/resume$/, async (_b, p) => {
      const meta = loadProject(safeId(p[0]));
      if (meta.status === 'complete') throw new Error(`${meta.id} is already complete.`);
      const r = startBackground(svc, meta);
      if (!r.started) throw new Error(r.reason ?? 'Could not start.');
      return { project: meta, started: true };
    }],

    ['POST', /^\/api\/gmap\/projects\/([\w.-]+)\/report$/, async (_b, p) => {
      const meta = loadProject(safeId(p[0]));
      svc.gmapUseProject(projectDir(meta.id));
      return finishProject(svc, meta);
    }],

    ['GET', /^\/api\/gmap\/businesses\/([^/]+)\/dossier$/, async (_b, p) => {
      const placeId = decodeURIComponent(p[0]);
      const dossier = svc.gmapGetDossier(placeId);
      if (!dossier) return { found: false, dossier: null };
      return { found: true, dossier };
    }],

    ['POST', /^\/api\/gmap\/businesses\/([^/]+)\/deep-research$/, async (b, p) => {
      const placeId = decodeURIComponent(p[0]);
      const dossier = await svc.gmapDeepResearch(placeId, {
        enableBrowserScrape: b.enableBrowserScrape !== false,
        // Both opt-in: see the notes in runCompanyDeepResearch.
        enableNotebookLm: b.enableNotebookLm === true,
        enableNewpages: b.enableNewpages === true,
        // The research stage is the slowest by far (~2 min) and the only one that
        // needs the ChatGPT login, so it must be switchable off without losing the
        // rest of the pipeline.
        enableChatGpt: b.enableChatGpt !== false,
        // Second-pass research through agy — opt-in: it needs a ChatGPT brief to
        // build on and shells out to a separate CLI running unattended. See the
        // notes on `useAgy` in runCompanyDeepResearch.
        enableAgy: b.enableAgy === true,
        // On by default: it only fires when the company actually has a website, and
        // it is the one stage that measures something we can sell a fix for.
        enablePageInsight: b.enablePageInsight !== false,
        // On by default: no browser, no auth, ~1.8s worst case, and it is what tells
        // a crawl that found nothing apart from a website that was never there.
        enableDomain: b.enableDomain !== false,
      });
      return { success: true, dossier };
    }],
  ];

  return http.createServer((req, res) => {
    const handled = (async () => {
      // A malformed request line must not be able to take the daemon down.
      // `new URL('//', base)` throws ERR_INVALID_URL, and inside an async
      // handler that surfaces as an unhandled rejection — which killed the
      // whole process mid-sweep, silently, on a request nobody sent on purpose.
      let pathname: string;
      try {
        pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      } catch {
        return send(res, 400, { error: `Bad request path: ${req.url}` });
      }

      if (pathname === '/health') return send(res, 200, { ok: true, service: 'eter-browser' });

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
          'access-control-allow-headers': 'content-type',
        });
        return res.end();
      }

      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const file = uiFile();
        if (!file) return send(res, 500, { error: 'dashboard not found' });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(fs.readFileSync(file));
      }

      // fb-recon project files, served straight from the project directory so the
      // dashboard can open a report the same way it opens a gmap one.
      const FB_ASSETS: Record<string, { file: string; type: string; download?: string }> = {
        report: { file: 'report.html', type: 'text/html; charset=utf-8' },
        csv: { file: 'contacts.csv', type: 'text/csv; charset=utf-8', download: '.csv' },
        // Every message with its sender, one row each — the raw harvest, before
        // it is collapsed into one record per person.
        messages: { file: 'messages.json', type: 'application/json; charset=utf-8' },
      };
      const fbAsset = pathname.match(/^\/fb-recon\/(report|csv|messages)\/([\w.-]+)$/);
      if (req.method === 'GET' && fbAsset) {
        const [, kind, id] = fbAsset;
        if (id.includes('..')) return send(res, 400, { error: 'Bad project id' });
        const spec = FB_ASSETS[kind];
        const file = path.join(svc.vault.home, 'fb-recon', 'projects', id, spec.file);
        if (!fs.existsSync(file)) return send(res, 404, { error: `No ${kind} for "${id}".` });
        res.writeHead(200, {
          'content-type': spec.type,
          'cache-control': 'no-store',
          ...(spec.download ? { 'content-disposition': `attachment; filename="${id}${spec.download}"` } : {}),
        });
        return res.end(fs.readFileSync(file));
      }

      // The report and spreadsheet are generated FILES, not JSON, so they are
      // served directly rather than through the route table.
      // gmap-review-radar writes reviews.html / reviews.csv into the SAME project
      // folder, so it needs no route of its own — only two more filenames here.
      const ASSETS: Record<string, { file: string; type: string; download?: string }> = {
        report: { file: 'report.html', type: 'text/html; charset=utf-8' },
        csv: { file: 'leads.csv', type: 'text/csv; charset=utf-8', download: '.csv' },
        reviews: { file: 'reviews.html', type: 'text/html; charset=utf-8' },
        reviewscsv: { file: 'reviews.csv', type: 'text/csv; charset=utf-8', download: '-reviews.csv' },
      };
      const asset = pathname.match(/^\/gmap\/(report|csv|reviews|reviewscsv)\/([\w.-]+)$/);
      if (req.method === 'GET' && asset) {
        const [, kind, id] = asset;
        if (id.includes('..')) return send(res, 400, { error: 'Bad project id' });
        const spec = ASSETS[kind];
        const file = path.join(projectDir(id), spec.file);
        if (!fs.existsSync(file)) {
          return send(res, 404, {
            error: kind.startsWith('reviews')
              ? `No reviews for "${id}" yet — run: node radar.mjs ${id}`
              : `No ${kind} for "${id}" yet — run the search first.`,
          });
        }
        res.writeHead(200, {
          'content-type': spec.type,
          'cache-control': 'no-store',
          ...(spec.download ? { 'content-disposition': `attachment; filename="${id}${spec.download}"` } : {}),
        });
        return res.end(fs.readFileSync(file));
      }

      for (const [method, re, handler] of routes) {
        const m = re.exec(pathname);
        if (!m) continue;
        if (req.method !== method) continue;
        try {
          const body = method === 'GET' ? {} : await readJson(req);
          return send(res, 200, await handler(body, m.slice(1)));
        } catch (err) {
          return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      }

      send(res, 404, { error: `No route for ${req.method} ${pathname}` });
    })();

    // The last line of defence. Anything that escapes the per-route try above is
    // a bug, but a bug must cost one request, not the daemon and every sweep it
    // is running.
    handled.catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[api] unhandled failure on ${req.method} ${req.url}: ${detail}`);
      if (!res.headersSent) send(res, 500, { error: detail });
      else res.end();
    });
  });
}

export function startServer(svc: VaultService, port = DAEMON_PORT): Promise<http.Server> {
  const server = createServer(svc);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
