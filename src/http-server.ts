#!/usr/bin/env node
// Streamable HTTP entry point for hosted deployments (e.g. Heroku).
//
// Every MCP session gets its own stdio child running dist/index.js, spawned with
// the caller's Toggl token (and, optionally, default workspace). The server never
// holds a Toggl token of its own, so each caller acts as their own Toggl account and
// sessions share no cache or credentials. Callers authenticate one of two ways:
//
//   1. OAuth (Claude.ai custom connectors, Claude Code): an `Authorization: Bearer`
//      token issued by src/oauth.ts, which sealed the grant the user entered on the
//      /authorize page (server access code, Toggl token, default workspace).
//   2. Headers (mcp-remote, scripts): `X-API-Key` (= MCP_HTTP_API_KEY) plus
//      `X-Toggl-Api-Key` and optional `X-Toggl-Default-Workspace-Id`.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { IncomingMessage, ServerResponse, createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  Grant,
  OAuthContext,
  deriveTokenKey,
  handleOAuthRequest,
  openAccessToken,
  publicBaseUrl,
  requestProtocol,
  wwwAuthenticate,
} from './oauth.js';
import { FailureLimiter, clientIp } from './rate-limit.js';
import { TogglAPI, TogglAPIError } from './toggl-api.js';

const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 1024 * 1024;
// Server-wide tuning knobs forwarded to each child; credentials are never forwarded.
const FORWARDED_ENV = ['TOGGL_CACHE_TTL', 'TOGGL_CACHE_SIZE', 'TOGGL_BATCH_SIZE'];

const apiKey = process.env.MCP_HTTP_API_KEY?.trim();
if (!apiKey) {
  console.error('MCP_HTTP_API_KEY must be set; refusing to expose the server unauthenticated');
  process.exit(1);
}
const expectedApiKey = Buffer.from(apiKey);

const port = Number(process.env.PORT ?? 3000);
const maxSessions = Number(process.env.MCP_HTTP_MAX_SESSIONS ?? 10);
const sessionIdleMs = Number(process.env.MCP_HTTP_SESSION_IDLE_MS ?? 30 * 60 * 1000);
const childEntry = join(dirname(fileURLToPath(import.meta.url)), 'index.js');
const publicUrl = process.env.MCP_HTTP_PUBLIC_URL?.trim() || undefined;
// When the public URL is https, plain-http requests (which Heroku also routes) are refused
// so credentials are never accepted over an unencrypted hop.
const requireHttps = publicUrl?.startsWith('https://') ?? false;
const limiter = new FailureLimiter({ maxFailures: 10, windowMs: 15 * 60 * 1000 });

const oauth: OAuthContext = {
  tokenKey: deriveTokenKey(apiKey),
  accessCode: apiKey,
  publicUrl,
  limiter,
  verifyTogglToken: async (token) => {
    try {
      await new TogglAPI(token).getMe();
      return true;
    } catch (error) {
      if (error instanceof TogglAPIError && (error.status === 401 || error.status === 403)) {
        return false;
      }
      throw error;
    }
  },
};

interface Session {
  http: StreamableHTTPServerTransport;
  child: StdioClientTransport;
  grantHash: Buffer;
  lastSeen: number;
}

const sessions = new Map<string, Session>();
let pendingSessions = 0;

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function closeSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  await Promise.allSettled([session.http.close(), session.child.close()]);
}

/**
 * Resolves the caller's Toggl grant from a Bearer token or the header pair, or
 * writes the appropriate 401 and returns undefined.
 */
function authenticate(req: IncomingMessage, res: ServerResponse): Grant | undefined {
  const baseUrl = publicBaseUrl(req, oauth.publicUrl);
  const ip = clientIp(req);
  if (limiter.isBlocked(ip)) {
    sendError(res, 429, 'Too many failed authentication attempts; try again later');
    return undefined;
  }

  const authorization = header(req, 'authorization');
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    const grant = match && openAccessToken(oauth.tokenKey, match[1]!.trim());
    if (!grant) {
      limiter.recordFailure(ip);
      sendError(res, 401, 'Unauthorized: invalid or expired token', {
        'www-authenticate': wwwAuthenticate(baseUrl, 'invalid_token'),
      });
      return undefined;
    }
    return grant;
  }

  const providedKey = header(req, 'x-api-key');
  if (!providedKey) {
    sendError(res, 401, 'Unauthorized: sign in with OAuth or send X-API-Key', {
      'www-authenticate': wwwAuthenticate(baseUrl),
    });
    return undefined;
  }
  if (!safeEqual(Buffer.from(providedKey), expectedApiKey)) {
    limiter.recordFailure(ip);
    sendError(res, 401, 'Unauthorized: invalid X-API-Key');
    return undefined;
  }
  const toggl = header(req, 'x-toggl-api-key');
  if (!toggl) {
    sendError(res, 401, 'Unauthorized: missing X-Toggl-Api-Key');
    return undefined;
  }
  const ws = header(req, 'x-toggl-default-workspace-id');
  if (ws !== undefined && !/^[1-9]\d*$/.test(ws)) {
    sendError(res, 400, 'X-Toggl-Default-Workspace-Id must be a positive integer');
    return undefined;
  }
  return { toggl, ws };
}

function grantHash(grant: Grant): Buffer {
  return sha256(`${grant.ws ?? ''}\n${grant.toggl}`);
}

async function openSession(req: IncomingMessage, res: ServerResponse, grant: Grant) {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (_error) {
    sendError(res, 400, 'Invalid JSON body');
    return;
  }
  if (!isInitializeRequest(body)) {
    sendError(res, 400, 'Missing mcp-session-id header; start with an initialize request');
    return;
  }
  if (sessions.size + pendingSessions >= maxSessions) {
    sendError(res, 503, 'Too many active sessions; try again later');
    return;
  }

  const env: Record<string, string> = { ...getDefaultEnvironment(), TOGGL_API_KEY: grant.toggl };
  if (grant.ws) env.TOGGL_DEFAULT_WORKSPACE_ID = grant.ws;
  for (const name of FORWARDED_ENV) {
    const value = process.env[name];
    if (value) env[name] = value;
  }

  const child = new StdioClientTransport({ command: process.execPath, args: [childEntry], env });
  const hash = grantHash(grant);
  const http = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, { http, child, grantHash: hash, lastSeen: Date.now() });
    },
  });

  http.onmessage = (message) => {
    child.send(message).catch((error) => console.error('Failed to forward to child:', error));
  };
  child.onmessage = (message) => {
    http.send(message).catch((error) => console.error('Failed to forward to client:', error));
  };
  http.onclose = () => {
    if (http.sessionId) void closeSession(http.sessionId);
  };
  child.onclose = () => {
    if (http.sessionId) void closeSession(http.sessionId);
    else void http.close();
  };
  child.onerror = (error) => console.error('Child transport error:', error);

  pendingSessions++;
  try {
    await child.start();
    await http.handleRequest(req, res, body);
  } catch (error) {
    console.error('Failed to open session:', error);
    await Promise.allSettled([http.close(), child.close()]);
    if (!res.headersSent) sendError(res, 500, 'Failed to start MCP session');
  } finally {
    pendingSessions--;
  }
  if (!http.sessionId) await Promise.allSettled([http.close(), child.close()]);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (requireHttps) {
    if (requestProtocol(req) !== 'https') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        res.writeHead(301, { location: `${publicUrl}${req.url ?? '/'}` });
        res.end();
      } else {
        sendError(res, 400, 'HTTPS is required');
      }
      return;
    }
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
  if (path === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (await handleOAuthRequest(req, res, path, MCP_PATH, oauth)) return;
  if (path !== MCP_PATH) {
    sendError(res, 404, 'Not found');
    return;
  }

  const grant = authenticate(req, res);
  if (!grant) return;

  const sessionId = header(req, 'mcp-session-id');
  if (!sessionId) {
    if (req.method !== 'POST') {
      sendError(res, 400, 'Missing mcp-session-id header');
      return;
    }
    await openSession(req, res, grant);
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    sendError(res, 404, 'Session not found');
    return;
  }
  // A session is bound to the Toggl grant that opened it.
  if (!safeEqual(grantHash(grant), session.grantHash)) {
    sendError(res, 403, 'Forbidden: credentials do not match this session');
    return;
  }
  session.lastSeen = Date.now();
  await session.http.handleRequest(req, res);
}

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error('Request failed:', error);
    if (!res.headersSent) sendError(res, 500, 'Internal server error');
    else res.end();
  });
});

setInterval(() => {
  const cutoff = Date.now() - sessionIdleMs;
  for (const [sessionId, session] of sessions) {
    if (session.lastSeen < cutoff) void closeSession(sessionId);
  }
  limiter.prune();
}, 60 * 1000).unref();

async function shutdown(): Promise<void> {
  server.close();
  await Promise.allSettled([...sessions.keys()].map(closeSession));
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

server.listen(port, () => {
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  console.error(`mcp-toggl HTTP server listening on port ${boundPort}`);
});
