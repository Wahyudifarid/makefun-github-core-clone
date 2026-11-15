// The HTTP server: one process, one store, four surfaces (git smart HTTP, REST v3,
// GraphQL v4, MCP) plus the health probe. Every reply carries X-GitHub-Request-Id.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestReply } from './rest.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The bearer token this process accepts; empty means "any bearer" (local runs only). */
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isAuthorized(req: IncomingMessage): boolean {
  if (EXPECTED_TOKEN === '') return true;
  const header = req.headers.authorization;
  return header === `Bearer ${EXPECTED_TOKEN}`;
}

function sendJson(
  res: ServerResponse,
  store: Store,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const headers: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': store.nextRequestId(),
    ...extraHeaders,
  };
  if (status === 204 || body === null || body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}

function sendRaw(
  res: ServerResponse,
  store: Store,
  status: number,
  contentType: string,
  body: Buffer,
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': store.nextRequestId(),
  });
  res.end(body);
}

function pathOf(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { pathname: url.pathname, query: url.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
  }
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

export function createApp(): { server: Server; store: Store } {
  const store = new Store();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const { pathname, query } = pathOf(req);
        const method = (req.method ?? 'GET').toUpperCase();

        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, store, 200, { ok: true });
          return;
        }

        if (pathname === '/api/graphql' || pathname === '/api/graphql/') {
          if (method !== 'POST') {
            sendJson(res, store, 404, { message: 'Not Found' });
            return;
          }
          if (!isAuthorized(req)) {
            sendJson(res, store, 401, { message: 'Requires authentication' });
            return;
          }
          const raw = await readBody(req);
          let body: unknown;
          try {
            body = raw.length === 0 ? null : (JSON.parse(raw.toString('utf8')) as unknown);
          } catch {
            sendJson(res, store, 400, { data: null, errors: [{ message: 'Problems parsing JSON' }] });
            return;
          }
          const answer = handleGraphQL(store, body);
          sendJson(res, store, answer.status, answer.body);
          return;
        }

        if (pathname === '/mcp' || pathname === '/mcp/') {
          if (method === 'DELETE') {
            res.writeHead(200, { 'x-github-request-id': store.nextRequestId() });
            res.end();
            return;
          }
          if (method !== 'POST') {
            sendJson(res, store, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!isAuthorized(req)) {
            sendJson(res, store, 401, { message: 'Requires authentication' });
            return;
          }
          const raw = await readBody(req);
          const answer = handleMcp(store, raw.toString('utf8'));
          if (answer.status === 202 || answer.body === null) {
            res.writeHead(answer.status, { 'x-github-request-id': store.nextRequestId() });
            res.end();
            return;
          }
          sendJson(res, store, answer.status, answer.body);
          return;
        }

        if (pathname.startsWith('/api/v3')) {
          const tail = pathname.slice('/api/v3'.length);
          const segments = tail.split('/').filter((part) => part !== '');
          const isPublic = segments.length === 0 || (segments.length === 1 && segments[0] === 'meta');
          if (!isPublic && !isAuthorized(req)) {
            sendJson(res, store, 401, { message: 'Requires authentication' });
            return;
          }
          let body: unknown;
          if (method === 'GET' || method === 'HEAD') {
            body = undefined;
          } else {
            const raw = await readBody(req);
            if (raw.length === 0) {
              body = undefined;
            } else {
              try {
                body = JSON.parse(raw.toString('utf8')) as unknown;
              } catch {
                sendJson(res, store, 400, { message: 'Problems parsing JSON' });
                return;
              }
            }
          }
          const reply: RestReply = handleRest(store, method, segments, query, body, originOf(req));
          if (reply.status === 204 || reply.body === null) {
            res.writeHead(204, {
              'content-type': JSON_TYPE,
              'x-github-request-id': store.nextRequestId(),
              ...(reply.headers ?? {}),
            });
            res.end();
            return;
          }
          sendJson(res, store, reply.status, reply.body, reply.headers ?? {});
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repo = decodeURIComponent(gitMatch[2] as string);
          const service = gitMatch[3] as string;
          if (service === 'info/refs' && method === 'GET') {
            const answer = handleInfoRefs(store, owner, repo, query.get('service') ?? '', req.headers['git-protocol']);
            sendRaw(res, store, answer.status, answer.contentType, answer.body);
            return;
          }
          if (service === 'git-upload-pack' && method === 'POST') {
            const raw = await readBody(req);
            const answer = handleUploadPack(store, owner, repo, raw);
            sendRaw(res, store, answer.status, answer.contentType, answer.body);
            return;
          }
          if (service === 'git-receive-pack' && method === 'POST') {
            const raw = await readBody(req);
            const answer = await handleReceivePack(store, owner, repo, raw);
            sendRaw(res, store, answer.status, answer.contentType, answer.body);
            return;
          }
          sendJson(res, store, 404, { message: 'Not Found' });
          return;
        }

        sendJson(res, store, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, store, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.end();
        }
      }
    })();
  });
  return { server, store };
}
