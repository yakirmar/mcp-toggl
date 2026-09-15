#!/usr/bin/env node
// Streamable HTTP entry point for hosted deployments (e.g. Heroku).
//
// Every MCP session gets its own stdio child running dist/index.js, spawned with
// the Toggl token the client sent in X-Toggl-Api-Key (and, optionally, the default
// workspace from X-Toggl-Default-Workspace-Id). The server never holds a
// Toggl token of its own, so each caller acts as their own Toggl account and
// sessions share no cache or credentials. X-API-Key gates access to the server.
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

interface Session {
  http: StreamableHTTPServerTransport;
  child: StdioClientTransport;
  tokenHash: Buffer;
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

function sendError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
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

async function openSession(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  defaultWorkspaceId: string | undefined
) {
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

  const env: Record<string, string> = { ...getDefaultEnvironment(), TOGGL_API_KEY: token };
  if (defaultWorkspaceId) env.TOGGL_DEFAULT_WORKSPACE_ID = defaultWorkspaceId;
  for (const name of FORWARDED_ENV) {
    const value = process.env[name];
    if (value) env[name] = value;
  }

  const child = new StdioClientTransport({ command: process.execPath, args: [childEntry], env });
  const tokenHash = sha256(token);
  const http = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, { http, child, tokenHash, lastSeen: Date.now() });
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
  if (path === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (path !== MCP_PATH) {
    sendError(res, 404, 'Not found');
    return;
  }

  const providedKey = Buffer.from(header(req, 'x-api-key') ?? '');
  if (
    providedKey.length !== expectedApiKey.length ||
    !timingSafeEqual(providedKey, expectedApiKey)
  ) {
    sendError(res, 401, 'Unauthorized: invalid or missing X-API-Key');
    return;
  }

  const token = header(req, 'x-toggl-api-key');
  if (!token) {
    sendError(res, 401, 'Unauthorized: missing X-Toggl-Api-Key');
    return;
  }

  const sessionId = header(req, 'mcp-session-id');
  if (!sessionId) {
    if (req.method !== 'POST') {
      sendError(res, 400, 'Missing mcp-session-id header');
      return;
    }
    const defaultWorkspaceId = header(req, 'x-toggl-default-workspace-id');
    if (defaultWorkspaceId !== undefined && !/^[1-9]\d*$/.test(defaultWorkspaceId)) {
      sendError(res, 400, 'X-Toggl-Default-Workspace-Id must be a positive integer');
      return;
    }
    await openSession(req, res, token, defaultWorkspaceId);
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    sendError(res, 404, 'Session not found');
    return;
  }
  // A session is bound to the Toggl token that opened it.
  if (!timingSafeEqual(sha256(token), session.tokenHash)) {
    sendError(res, 403, 'Forbidden: X-Toggl-Api-Key does not match this session');
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
