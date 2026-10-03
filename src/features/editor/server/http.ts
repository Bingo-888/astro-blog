import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { renderLinkPreview } from '../../../lib/markdown/link-card-template';
import type { OGData } from '../../../lib/markdown/og-fetcher';
import { fetchEditorOG } from './og-service';
import { MAX_URL_LENGTH, parsePublicUrl } from './public-url';

interface HandlerOptions {
  fetchOG?: (url: string) => Promise<OGData>;
  now?: () => number;
  requestsPerMinute?: number;
  maxClients?: number;
}

function sendJson(res: ServerResponse, status: number, data: object) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(JSON.stringify(data));
}

/** Returns false for other routes, allowing dev/CMS middleware to continue. */
export function createEditorOGHandler(options: HandlerOptions = {}) {
  const fetchOG = options.fetchOG ?? fetchEditorOG;
  const now = options.now ?? Date.now;
  const limit = options.requestsPerMinute ?? 120;
  const maxClients = options.maxClients ?? 1024;
  const clients = new Map<string, { count: number; expiresAt: number }>();

  return async function handleEditorOGRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const rawUrl = req.url ?? '';
    if (rawUrl.split('?')[0] !== '/api/editor/og') return false;
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendJson(res, 405, { error: '仅支持 GET 请求' });
      return true;
    }
    if (
      rawUrl.length > MAX_URL_LENGTH * 3 + 64 ||
      req.headers['transfer-encoding'] ||
      Number(req.headers['content-length']) > 0
    ) {
      sendJson(res, 400, { error: '请求仅接受一个网页链接' });
      return true;
    }
    const origin = req.headers.origin;
    let foreignOrigin = false;
    if (origin) {
      try {
        foreignOrigin = new URL(origin).host !== req.headers.host;
      } catch {
        foreignOrigin = true;
      }
    }
    if (foreignOrigin || req.headers['sec-fetch-site'] === 'cross-site') {
      sendJson(res, 403, { error: '请从本站编辑器使用链接预览' });
      return true;
    }

    const currentTime = now();
    for (const [key, entry] of clients) {
      if (entry.expiresAt <= currentTime) clients.delete(key);
    }
    // Ignore spoofable forwarding headers. Behind a proxy this is a shared request budget.
    const clientKey = req.socket.remoteAddress ?? 'unknown';
    let client = clients.get(clientKey);
    if (!client && clients.size < maxClients) {
      client = { count: 0, expiresAt: currentTime + 60_000 };
      clients.set(clientKey, client);
    }
    if (!client || client.count >= limit) {
      res.setHeader('Retry-After', '60');
      sendJson(res, 429, { error: '请求较多，请稍后重试' });
      return true;
    }
    client.count += 1;

    const params = new URL(rawUrl, 'http://editor.local').searchParams;
    if (params.size !== 1 || !params.has('url')) {
      sendJson(res, 400, { error: '请求仅接受一个 url 参数' });
      return true;
    }
    let url: string;
    try {
      url = parsePublicUrl(params.get('url') ?? '').href;
    } catch {
      sendJson(res, 400, { error: '请输入不含登录凭据的 HTTP 或 HTTPS 网页链接' });
      return true;
    }
    try {
      const data = await fetchOG(url);
      sendJson(res, 200, { ...data, html: renderLinkPreview(data) });
    } catch {
      sendJson(res, 503, { error: '链接预览暂时不可用' });
    }
    return true;
  };
}

export const handleEditorOGRequest = createEditorOGHandler();

export function createEditorOGServer() {
  const handle = createEditorOGHandler();
  const server = createServer((req, res) => {
    void handle(req, res)
      .then((handled) => {
        if (!handled) sendJson(res, 404, { error: '未找到此接口' });
      })
      .catch(() => sendJson(res, 503, { error: '链接预览暂时不可用' }));
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 64;
  return server;
}
