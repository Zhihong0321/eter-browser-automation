import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAEMON_PORT } from './config.js';
import type { VaultService } from './service.js';

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

  const routes: [string, RegExp, Handler][] = [
    ['GET', /^\/api\/status$/, async () => svc.status()],
    ['GET', /^\/api\/ready$/, async () => ({ sessions: svc.readySessions() })],

    // Add ANY site: the body carries the URL the user typed.
    ['POST', /^\/api\/sessions$/, async (b) => svc.addSession(str(b.url), b.label as string | undefined)],
    ['POST', /^\/api\/sessions\/([\w.-]+)\/open$/, async (_b, p) => svc.openSession(p[0])],
    ['POST', /^\/api\/sessions\/([\w.-]+)\/confirm$/, async (_b, p) => svc.confirmSession(p[0])],
    ['POST', /^\/api\/sessions\/([\w.-]+)\/check$/, async (b, p) => svc.checkSession(p[0], b.deep !== false)],
    ['POST', /^\/api\/sessions\/([\w.-]+)\/rename$/, async (b, p) => svc.renameSession(p[0], str(b.label))],
    ['DELETE', /^\/api\/sessions\/([\w.-]+)$/, async (_b, p) => svc.removeSession(p[0])],
    ['POST', /^\/api\/check-all$/, async (b) => ({ sessions: await svc.checkAll(b.deep !== false) })],

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

    ['POST', /^\/api\/wa\/chats$/, async (b) => ({ chats: await svc.waListChats(num(b.limit, 20)) })],
    ['POST', /^\/api\/wa\/read$/, async (b) => svc.waReadChat(str(b.target), num(b.limit, 20))],
    ['POST', /^\/api\/wa\/send$/, async (b) => svc.waSend(str(b.target), str(b.text))],

    ['POST', /^\/api\/fb\/my-posts$/, async (b) => ({ posts: await svc.fbReadMyPosts(num(b.limit, 5)) })],
    ['POST', /^\/api\/fb\/feed$/, async (b) => ({ posts: await svc.fbReadFeed(num(b.limit, 5)) })],
    ['POST', /^\/api\/fb\/comment$/, async (b) => svc.fbComment(str(b.postUrl), str(b.text))],
  ];

  return http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname;

      if (pathname === '/health') return send(res, 200, { ok: true, service: 'eter-browser' });

      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const file = uiFile();
        if (!file) return send(res, 500, { error: 'dashboard not found' });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
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
  });
}

export function startServer(svc: VaultService, port = DAEMON_PORT): Promise<http.Server> {
  const server = createServer(svc);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
