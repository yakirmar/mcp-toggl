import { ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveTokenKey, sealToken } from '../src/oauth.js';

const entryPoint = resolve('dist/http-server.js');
const API_KEY = 'test-api-key';
const TOKEN_KEY = deriveTokenKey(API_KEY);

function accessToken(toggl: string, ws?: string, ttlSeconds = 60): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return sealToken(TOKEN_KEY, { typ: 'access', toggl, ...(ws ? { ws } : {}), exp });
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'mcp-toggl-test', version: '1.0.0' },
  },
};

function startServer(env: Record<string, string>): Promise<{ proc: ChildProcess; url: string }> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(process.execPath, [entryPoint], {
      env: { ...process.env, TOGGL_API_KEY: '', PORT: '0', ...env },
    });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/listening on port (\d+)/);
      if (match) resolvePromise({ proc, url: `http://127.0.0.1:${match[1]}` });
    });
    proc.on('exit', (code) => reject(new Error(`server exited with ${code}: ${stderr}`)));
  });
}

describe.skipIf(!existsSync(entryPoint))('HTTP server', () => {
  let proc: ChildProcess;
  let url: string;

  beforeAll(async () => {
    ({ proc, url } = await startServer({ MCP_HTTP_API_KEY: API_KEY }));
  });

  afterAll(() => {
    proc?.kill();
  });

  function post(headers: Record<string, string>, body: unknown = INITIALIZE) {
    return fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  it('refuses to start without MCP_HTTP_API_KEY', async () => {
    await expect(startServer({ MCP_HTTP_API_KEY: '' })).rejects.toThrow(
      /MCP_HTTP_API_KEY must be set/
    );
  });

  it('answers unauthenticated requests with a 401 that points at OAuth metadata', async () => {
    const res = await post({});
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      `resource_metadata="${url}/.well-known/oauth-protected-resource"`
    );

    const metadata = (await (
      await fetch(`${url}/.well-known/oauth-protected-resource`)
    ).json()) as {
      resource: string;
    };
    expect(metadata.resource).toBe(`${url}/mcp`);
  });

  it('refuses plain-http requests and adds HSTS when the public URL is https', async () => {
    const { proc: secure, url: secureUrl } = await startServer({
      MCP_HTTP_API_KEY: API_KEY,
      MCP_HTTP_PUBLIC_URL: 'https://mcp.example.com',
    });
    try {
      // No X-Forwarded-Proto means the request didn't come through the TLS proxy.
      const plain = await fetch(`${secureUrl}/health`, { redirect: 'manual' });
      expect(plain.status).toBe(301);
      expect(plain.headers.get('location')).toBe('https://mcp.example.com/health');
      const plainPost = await fetch(`${secureUrl}/mcp`, { method: 'POST' });
      expect(plainPost.status).toBe(400);

      const tls = await fetch(`${secureUrl}/health`, { headers: { 'x-forwarded-proto': 'https' } });
      expect(tls.status).toBe(200);
      expect(tls.headers.get('strict-transport-security')).toContain('max-age=');

      const metadata = (await (
        await fetch(`${secureUrl}/.well-known/oauth-protected-resource`, {
          headers: { 'x-forwarded-proto': 'https', host: 'evil.example' },
        })
      ).json()) as { resource: string };
      expect(metadata.resource).toBe('https://mcp.example.com/mcp');
    } finally {
      secure.kill();
    }
  });

  it('locks out an IP after repeated bad credentials', async () => {
    const attempt = () =>
      post({ 'x-api-key': 'wrong', 'x-toggl-api-key': 'dummy', 'x-forwarded-for': '203.0.113.7' });
    let status = 0;
    for (let i = 0; i < 11 && status !== 429; i++) status = (await attempt()).status;
    expect(status).toBe(429);
    // Valid credentials from another IP still work.
    expect((await post({ 'x-api-key': API_KEY, 'x-toggl-api-key': 'dummy' })).status).toBe(200);
  });

  it('rejects an invalid or expired Bearer token', async () => {
    expect((await post({ authorization: 'Bearer nope' })).status).toBe(401);
    const expired = await post({ authorization: `Bearer ${accessToken('dummy', undefined, -1)}` });
    expect(expired.status).toBe(401);
    expect(expired.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('serves a session from a Bearer token carrying the Toggl grant', async () => {
    const client = new Client({ name: 'mcp-toggl-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${accessToken('dummy-token', '123')}` } },
    });
    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: 'toggl_create_entry',
        arguments: { start: '2026-07-11T09:00:00Z' },
      });
      const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '{}';
      // Default workspace 123 from the token keeps resolution offline; validation runs next.
      expect((JSON.parse(text) as { message: string }).message).toContain(
        'exactly one of end or duration_minutes'
      );
    } finally {
      await client.close();
    }
  });

  it('rejects requests without a valid X-API-Key', async () => {
    expect((await post({ 'x-toggl-api-key': 'dummy-token' })).status).toBe(401);
    expect((await post({ 'x-api-key': 'wrong', 'x-toggl-api-key': 'dummy-token' })).status).toBe(
      401
    );
  });

  it('rejects requests without X-Toggl-Api-Key', async () => {
    expect((await post({ 'x-api-key': API_KEY })).status).toBe(401);
  });

  it('requires a session to start with initialize', async () => {
    const res = await post(
      { 'x-api-key': API_KEY, 'x-toggl-api-key': 'dummy-token' },
      { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    );
    expect(res.status).toBe(400);
  });

  it('serves tools using the Toggl token from the client headers', async () => {
    // The child exits when TOGGL_API_KEY is empty, so a working session proves the header reached it.
    const client = new Client({ name: 'mcp-toggl-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { 'x-api-key': API_KEY, 'x-toggl-api-key': 'dummy-token' } },
    });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.some((tool) => tool.name === 'toggl_check_auth')).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('rejects a non-numeric X-Toggl-Default-Workspace-Id', async () => {
    const res = await post({
      'x-api-key': API_KEY,
      'x-toggl-api-key': 'dummy-token',
      'x-toggl-default-workspace-id': 'abc',
    });
    expect(res.status).toBe(400);
  });

  it('passes X-Toggl-Default-Workspace-Id to the session as its default workspace', async () => {
    async function createEntryMessage(headers: Record<string, string>): Promise<string> {
      const client = new Client({ name: 'mcp-toggl-test', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: { 'x-api-key': API_KEY, 'x-toggl-api-key': 'dummy', ...headers } },
      });
      await client.connect(transport);
      try {
        const result = await client.callTool({
          name: 'toggl_create_entry',
          arguments: { start: '2026-07-11T09:00:00Z' },
        });
        const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '{}';
        return (JSON.parse(text) as { message: string }).message;
      } finally {
        await client.close();
      }
    }

    // With a default workspace, resolution stays offline and interval validation runs next.
    expect(await createEntryMessage({ 'x-toggl-default-workspace-id': '123' })).toContain(
      'exactly one of end or duration_minutes'
    );
    // Without one, the child has to ask Toggl for workspaces, which fails on the dummy token.
    expect(await createEntryMessage({})).not.toContain('exactly one of end or duration_minutes');
  });

  it('binds a session to the Toggl token that opened it', async () => {
    const init = await post({ 'x-api-key': API_KEY, 'x-toggl-api-key': 'token-a' });
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await init.body?.cancel();

    const hijack = await post(
      { 'x-api-key': API_KEY, 'x-toggl-api-key': 'token-b', 'mcp-session-id': sessionId! },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' }
    );
    expect(hijack.status).toBe(403);
  });
});
