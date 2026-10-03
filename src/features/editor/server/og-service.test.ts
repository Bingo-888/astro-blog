import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { createEditorOGHandler } from './http';
import { createEditorOGService, type OGServiceOptions } from './og-service';
import { isPublicIpAddress, parsePublicUrl } from './public-url';

const publicAddresses = [{ address: '93.184.216.34', family: 4 }];
const resolve: NonNullable<OGServiceOptions['resolve']> = async () => publicAddresses;
const htmlHeaders = { 'content-type': 'text/html; charset=utf-8' };
const response = (body = '<title>Example</title>', init: ResponseInit = {}) => ({
  response: new Response(body, { headers: htmlHeaders, ...init }),
  async dispose() {},
});
const extract: NonNullable<OGServiceOptions['extract']> = async () => ({ title: 'Example' });
const defaults: OGServiceOptions = { resolve, extract, request: async () => response() };

test('rejects non-public IPv4, IPv6, mapped IPv4 and alternate literal forms', () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '192.0.2.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
    '2002:7f00:1::',
  ]) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
  assert.equal(isPublicIpAddress('93.184.216.34'), true);
  assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true);
  assert.equal(isPublicIpAddress(parsePublicUrl('http://2130706433').hostname), false);
  assert.equal(isPublicIpAddress(parsePublicUrl('http://0x7f000001').hostname), false);
});

test('rejects credentials, non-HTTP protocols, long URLs and non-web ports', async () => {
  let calls = 0;
  const fetchOG = createEditorOGService({
    ...defaults,
    request: async () => {
      calls += 1;
      return response();
    },
  });
  for (const url of [
    'file:///etc/passwd',
    'http://user:secret@example.com',
    'http://example.com:22',
    `https://example.com/${'x'.repeat(4096)}`,
  ]) {
    assert.ok((await fetchOG(url)).error);
  }
  assert.equal(calls, 0);
});

test('rejects any mixed private/public DNS answer before sending a request', async () => {
  let calls = 0;
  const fetchOG = createEditorOGService({
    ...defaults,
    resolve: async () => [...publicAddresses, { address: '10.1.2.3', family: 4 }],
    request: async () => {
      calls += 1;
      return response();
    },
  });
  assert.match((await fetchOG('https://example.com')).error ?? '', /公开网络/);
  assert.equal(calls, 0);
});

test('validates every redirect and passes only verified addresses to the transport', async () => {
  let calls = 0;
  let disposed = false;
  const fetchOG = createEditorOGService({
    ...defaults,
    request: async (_url, addresses) => {
      calls += 1;
      assert.deepEqual(addresses, publicAddresses);
      return {
        response: new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }),
        async dispose() {
          disposed = true;
        },
      };
    },
  });
  assert.match((await fetchOG('https://example.com')).error ?? '', /公开网络/);
  assert.equal(calls, 1);
  assert.equal(disposed, true);
});

test('caps redirects and uses the final URL for relative metadata extraction', async () => {
  let calls = 0;
  const endless = createEditorOGService({
    ...defaults,
    request: async () => {
      calls += 1;
      return response('', { status: 302, headers: { location: '/loop' } });
    },
  });
  assert.match((await endless('https://example.com')).error ?? '', /重定向过多/);
  assert.equal(calls, 6);
  let finalUrl = '';
  const redirected = createEditorOGService({
    ...defaults,
    request: async (url) =>
      url.pathname === '/' ? response('', { status: 301, headers: { location: '/final' } }) : response(),
    extract: async (_html, url) => {
      finalUrl = url;
      return { title: 'Final' };
    },
  });
  const result = await redirected('https://example.com');
  assert.equal(finalUrl, 'https://example.com/final');
  assert.equal(result.originUrl, 'https://example.com/');
  assert.equal(result.url, finalUrl);
});

test('rejects non-HTML and oversized streams even without content-length', async () => {
  const notHtml = createEditorOGService({
    ...defaults,
    request: async () => response('binary', { headers: { 'content-type': 'application/octet-stream' } }),
  });
  assert.match((await notHtml('https://example.com')).error ?? '', /未返回网页/);
  const tooLarge = createEditorOGService({ ...defaults, maxHtmlBytes: 8, request: async () => response('123456789') });
  assert.match((await tooLarge('https://example.com')).error ?? '', /网页过大/);
});

test('deadline includes unresolved DNS and a stalled body stream', async () => {
  const dns = createEditorOGService({ ...defaults, timeoutMs: 15, resolve: () => new Promise(() => {}) });
  assert.match((await dns('https://example.com')).error ?? '', /超时/);
  let cancelled = false;
  const body = createEditorOGService({
    ...defaults,
    timeoutMs: 15,
    request: async () => ({
      response: new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: htmlHeaders },
      ),
      async dispose() {},
    }),
  });
  assert.match((await body('https://example.com')).error ?? '', /超时/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test('same URL is deduplicated in flight; new requests over concurrency limit fail promptly', async () => {
  let unblock = () => {};
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let calls = 0;
  const fetchOG = createEditorOGService({
    ...defaults,
    maxConcurrent: 1,
    request: async () => {
      calls += 1;
      await gate;
      return response();
    },
  });
  const first = fetchOG('https://example.com/#a');
  const same = fetchOG('https://example.com/#b');
  assert.match((await fetchOG('https://other.example')).error ?? '', /繁忙/);
  unblock();
  const results = await Promise.all([first, same]);
  assert.equal(calls, 1);
  assert.deepEqual(results[0], results[1]);
});

test('TTL expires, cache stays bounded and callers cannot mutate cached data', async () => {
  let time = 0;
  let calls = 0;
  const fetchOG = createEditorOGService({
    ...defaults,
    now: () => time,
    maxCacheEntries: 1,
    successTtlMs: 100,
    request: async () => {
      calls += 1;
      return response();
    },
  });
  const first = await fetchOG('https://example.com/a');
  first.title = 'Changed';
  assert.equal((await fetchOG('https://example.com/a')).title, 'Example');
  assert.equal(calls, 1);
  time = 101;
  await fetchOG('https://example.com/a');
  assert.equal(calls, 2);
  await fetchOG('https://example.com/b');
  await fetchOG('https://example.com/a');
  assert.equal(calls, 4);
});

test('failures have a short cache lifetime and never expose upstream details', async () => {
  let time = 0;
  let calls = 0;
  const fetchOG = createEditorOGService({
    ...defaults,
    now: () => time,
    failureTtlMs: 10,
    request: async () => {
      calls += 1;
      throw new Error('secret: internal network stack trace');
    },
  });
  const data = await fetchOG('https://example.com');
  assert.equal(data.error, '暂时无法获取链接预览');
  await fetchOG('https://example.com');
  assert.equal(calls, 1);
  time = 11;
  await fetchOG('https://example.com');
  assert.equal(calls, 2);
});

test('real metadata parser extracts bounded fields without fetching icons', async () => {
  let calls = 0;
  const fetchOG = createEditorOGService({
    request: async () => {
      calls += 1;
      return response(
        '<html><head><title>Sample article</title><meta name="description" content="A description"><meta property="og:image" content="http://127.0.0.1/private"><link rel="icon" href="http://localhost/icon"></head></html>',
      );
    },
    resolve: async (host) => (host === 'localhost' ? [{ address: '127.0.0.1', family: 4 }] : publicAddresses),
  });
  const data = await fetchOG('https://example.com');
  assert.equal(data.error, undefined);
  assert.equal(data.title, 'Sample article');
  assert.equal(data.description, 'A description');
  assert.equal(data.image, undefined);
  assert.equal(data.logo, undefined);
  assert.equal(calls, 1);
});

function mockHttp(url: string, options: { method?: string; headers?: Record<string, string>; address?: string } = {}) {
  let body = '';
  let status = 0;
  const headers: Record<string, string> = {};
  const req = {
    url,
    method: options.method ?? 'GET',
    headers: { host: 'editor.example', ...options.headers },
    socket: { remoteAddress: options.address ?? '127.0.0.1' },
  } as IncomingMessage;
  const res = {
    setHeader(key: string, value: string) {
      headers[key] = value;
    },
    writeHead(code: number, values: Record<string, string>) {
      status = code;
      Object.assign(headers, values);
    },
    end(value: string) {
      body = value;
    },
  } as unknown as ServerResponse;
  return { req, res, result: () => ({ status, headers, data: body ? JSON.parse(body) : undefined }) };
}

test('HTTP only serves the OG route, rejects bodies and does not expose CMS/cache routes', async () => {
  const handle = createEditorOGHandler({ fetchOG: async (url) => ({ originUrl: url, url, title: 'Article' }) });
  for (const route of ['/api/cms/write', '/api/cms/og-cache', '/api/editor/og-cache']) {
    const request = mockHttp(route);
    assert.equal(await handle(request.req, request.res), false);
  }
  const rejectedRequests: Array<Parameters<typeof mockHttp>[1]> = [
    { method: 'POST' },
    { headers: { 'content-length': '1' } },
    { headers: { origin: 'https://attacker.example' } },
  ];
  for (const options of rejectedRequests) {
    const request = mockHttp('/api/editor/og?url=https://example.com', options);
    assert.equal(await handle(request.req, request.res), true);
    assert.ok(request.result().status >= 400);
  }
  const request = mockHttp('/api/editor/og?url=https://example.com');
  await handle(request.req, request.res);
  assert.equal(request.result().status, 200);
  assert.match(request.result().data.html, /link-preview-block/);
  assert.equal(request.result().headers['Cache-Control'], 'no-store');
});

test('HTTP rate limit resets and never trusts attacker-supplied forwarded IPs', async () => {
  let time = 0;
  const handle = createEditorOGHandler({
    now: () => time,
    requestsPerMinute: 1,
    fetchOG: async (url) => ({ originUrl: url, url, error: 'Unavailable' }),
  });
  const first = mockHttp('/api/editor/og?url=https://example.com');
  await handle(first.req, first.res);
  const next = mockHttp('/api/editor/og?url=https://example.com', { headers: { 'x-forwarded-for': '8.8.8.8' } });
  await handle(next.req, next.res);
  assert.equal(next.result().status, 429);
  time = 60_001;
  const reset = mockHttp('/api/editor/og?url=https://example.com');
  await handle(reset.req, reset.res);
  assert.equal(reset.result().status, 200);
});
