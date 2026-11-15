// The HTTP server: routing, authentication, request ids, and the body
// handling the four surfaces share. Handlers live in rest.ts, graphql.ts,
// mcp.ts and gitproto.ts; this module only decides which one answers and
// how its result is written back.
//
// Rules the whole server follows:
//  - /healthz answers without auth; everything else checks the bearer
//    token first, before any routing or body work.
//  - Every response carries a non-empty X-GitHub-Request-Id.
//  - Every REST/GraphQL/MCP reply is application/json, never HTML.
//  - Malformed JSON bodies answer 400 JSON; unknown routes answer 404 JSON.
//  - No handler failure may take the server down: everything is wrapped.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestContext } from './rest.ts';
import { Store } from './store.ts';
import { HttpError, type BinResult, type JsonResult } from './types.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface AppOptions {
  /** The bearer token required on every authenticated route. */
  token: string | undefined;
}

function decodeSegment(segment: string): string {
  // No percent escape, nothing to decode: the common case for the paths
  // the suite drives.
  if (segment.indexOf('%') < 0) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parseQuery(raw: string): Map<string, string> {
  const query = new Map<string, string>();
  if (raw === '') return query;
  for (const pair of raw.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? '' : pair.slice(eq + 1);
    // No escape or plus: the decoded form is the raw form.
    if (key.indexOf('%') < 0 && key.indexOf('+') < 0 && value.indexOf('%') < 0 && value.indexOf('+') < 0) {
      query.set(key, value);
      continue;
    }
    try {
      query.set(decodeURIComponent(key.replace(/\+/g, ' ')), decodeURIComponent(value.replace(/\+/g, ' ')));
    } catch {
      query.set(key, value);
    }
  }
  return query;
}

function splitPath(rawUrl: string): { segments: string[]; query: Map<string, string>; path: string } {
  const q = rawUrl.indexOf('?');
  const rawPath = q < 0 ? rawUrl : rawUrl.slice(0, q);
  const query = parseQuery(q < 0 ? '' : rawUrl.slice(q + 1));
  const trimmed = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  // One pass: split on '/', drop empties, decode. Equivalent to
  // split('/').filter(non-empty).map(decodeSegment) with no intermediates.
  const segments: string[] = [];
  let start = 0;
  for (let i = 0; i <= trimmed.length; i += 1) {
    if (i === trimmed.length || trimmed.charCodeAt(i) === 47) {
      if (i > start) segments.push(decodeSegment(trimmed.slice(start, i)));
      start = i + 1;
    }
  }
  return { segments, query, path: trimmed };
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    let first: Buffer | null = null;
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        rejectPromise(new HttpError(413, 'Request body too large'));
        request.destroy();
        return;
      }
      // The usual case is one chunk: return it directly, no copy.
      if (first === null) first = chunk;
      else chunks.push(chunk);
    });
    request.on('end', () => {
      if (first === null) resolvePromise(EMPTY_BODY);
      else if (chunks.length === 0) resolvePromise(first);
      else resolvePromise(Buffer.concat([first, ...chunks]));
    });
    request.on('error', rejectPromise);
  });
}

/** The shared empty body: no request body, no allocation. */
const EMPTY_BODY = Buffer.alloc(0);

/**
 * Whether a request can carry a body at all. HTTP/1.1 says a request
 * without Content-Length or Transfer-Encoding has none, and
 * Content-Length: 0 means an empty one; skipping the read in those cases
 * leaves no bytes on the socket, so keep-alive is unaffected.
 */
function requestHasBody(request: IncomingMessage): boolean {
  const length = request.headers['content-length'];
  if (length !== undefined) {
    if (Array.isArray(length)) return true;
    if (length !== '0') return true;
  }
  return request.headers['transfer-encoding'] !== undefined;
}

/** Read the request body, or the shared empty buffer when it has none. */
function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  return requestHasBody(request) ? readBody(request) : Promise.resolve(EMPTY_BODY);
}

function parseJsonBody(buffer: Buffer): unknown {
  if (buffer.length === 0) return null;
  try {
    return JSON.parse(buffer.toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
}

export function createApp(options: AppOptions): { server: Server; store: Store } {
  const store = new Store();
  let requestCounter = 0;

  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    requestCounter += 1;
    const requestId = String(requestCounter);
    const sendJson = (result: JsonResult): void => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-github-request-id': requestId,
        ...(result.headers ?? {}),
      };
      // A pre-serialized body goes out as-is: no object rebuild, no
      // stringify, no copy. Handlers serve cached bytes this way.
      if (result.body !== undefined) {
        response.writeHead(result.status, { ...headers, 'content-length': String(result.body.length) });
        response.end(result.body);
        return;
      }
      if (result.json === null) {
        response.writeHead(result.status, headers);
        response.end();
        return;
      }
      const body = Buffer.from(JSON.stringify(result.json), 'utf8');
      response.writeHead(result.status, { ...headers, 'content-length': String(body.length) });
      response.end(body);
    };
    const sendBinary = (result: BinResult): void => {
      response.writeHead(result.status, {
        'content-type': result.contentType,
        'x-github-request-id': requestId,
        'content-length': String(result.body.length),
      });
      response.end(result.body);
    };

    try {
      const method = request.method ?? 'GET';
      const rawUrl = request.url ?? '/';
      const { segments, query, path } = splitPath(rawUrl);
      const host = request.headers.host ?? 'localhost';

      // Health check: no auth, always 200.
      if (method === 'GET' && path === '/healthz') {
        sendJson({ status: 200, json: { ok: true } });
        return;
      }

      // Authentication first, on every other route.
      const expected = options.token;
      const authorization = request.headers.authorization ?? '';
      const authorized =
        authorization.startsWith('Bearer ') &&
        (expected === undefined ? authorization.slice(7).trim() !== '' : authorization === `Bearer ${expected}`);
      if (!authorized) {
        sendJson({ status: 401, json: { message: 'Bad credentials' } });
        return;
      }

      // REST v3.
      if (segments[0] === 'api' && segments[1] === 'v3') {
        const body = parseJsonBody(await readRequestBody(request));
        const ctx: RestContext = {
          store,
          segments: segments.slice(2),
          query,
          host,
          method,
          body,
          origin: `http://${host}`,
        };
        const result: JsonResult = handleRest(ctx);
        sendJson(result);
        return;
      }

      // GraphQL.
      if (method === 'POST' && segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
        const body = parseJsonBody(await readRequestBody(request));
        const result = handleGraphQL(store, body);
        sendJson(result);
        return;
      }

      // MCP.
      if (method === 'POST' && segments[0] === 'mcp' && segments.length === 1) {
        const body = await readRequestBody(request);
        const result = handleMcp(store, body);
        sendJson(result);
        return;
      }

      // Git smart HTTP: /<owner>/<repo>.git/info/refs or
      // /<owner>/<repo>.git/git-upload-pack (or git-receive-pack).
      const isGitPath =
        segments.length >= 3 &&
        segments[1] !== undefined &&
        segments[1].endsWith('.git') &&
        ((segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs') ||
          (segments.length === 3 && (segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack')));
      if (isGitPath) {
        const owner = segments[0] as string;
        const repoName = (segments[1] as string).slice(0, -'.git'.length);
        const service = segments.length === 4 ? 'info/refs' : (segments[2] as string);
        if (service === 'info/refs' && method === 'GET') {
          const result = handleInfoRefs(store, owner, repoName, query.get('service'), request.headers['git-protocol']);
          sendBinary(result);
          return;
        }
        if (service === 'git-upload-pack' && method === 'POST') {
          const body = await readRequestBody(request);
          const result = handleUploadPack(store, owner, repoName, body, request.headers['git-protocol']);
          sendBinary(result);
          return;
        }
        if (service === 'git-receive-pack' && method === 'POST') {
          const body = await readRequestBody(request);
          const result = handleReceivePack(store, owner, repoName, body);
          sendBinary(result);
          return;
        }
      }

      sendJson({ status: 404, json: { message: 'Not Found' } });
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson({ status: err.status, json: { message: err.message } });
        return;
      }
      process.stderr.write(`forge: internal error: ${(err as Error).stack ?? (err as Error).message}\n`);
      if (!response.headersSent) sendJson({ status: 500, json: { message: 'Internal Server Error' } });
      else response.end();
    }
  }

  return { server, store };
}
