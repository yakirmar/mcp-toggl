import { createHash, randomBytes } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OAuthContext,
  REFRESH_TOKEN_TTL_SECONDS,
  deriveTokenKey,
  handleOAuthRequest,
  isAllowedRedirectUri,
  openAccessToken,
  sealToken,
  verifyPkce,
} from '../src/oauth.js';
import { FailureLimiter, clientIp } from '../src/rate-limit.js';

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

describe('isAllowedRedirectUri', () => {
  it('accepts the Claude callback and loopback redirects only', () => {
    expect(isAllowedRedirectUri(CALLBACK)).toBe(true);
    expect(isAllowedRedirectUri('http://localhost:3118/callback')).toBe(true);
    expect(isAllowedRedirectUri('http://127.0.0.1:5000/cb')).toBe(true);
    expect(isAllowedRedirectUri('https://evil.example/callback')).toBe(false);
    expect(isAllowedRedirectUri('https://claude.ai.evil.example/api/mcp/auth_callback')).toBe(
      false
    );
    expect(isAllowedRedirectUri(`${CALLBACK}?next=x`)).toBe(false);
    expect(isAllowedRedirectUri('http://localhost.evil.example/callback')).toBe(false);
    expect(isAllowedRedirectUri('not a url')).toBe(false);
  });
});

describe('sealed tokens', () => {
  const key = deriveTokenKey('secret');

  it('round-trips a grant and rejects the wrong type, key, or expiry', () => {
    const now = Math.floor(Date.now() / 1000);
    const access = sealToken(key, { typ: 'access', toggl: 'tok', ws: '7', exp: now + 60 });
    expect(openAccessToken(key, access)).toEqual({ toggl: 'tok', ws: '7' });
    expect(openAccessToken(deriveTokenKey('other'), access)).toBeUndefined();
    expect(
      openAccessToken(key, sealToken(key, { typ: 'access', toggl: 'tok', exp: now - 1 }))
    ).toBeUndefined();
    expect(
      openAccessToken(
        key,
        sealToken(key, { typ: 'refresh', toggl: 'tok', cid: 'c', exp: now + 60 })
      )
    ).toBeUndefined();
    expect(openAccessToken(key, 'garbage')).toBeUndefined();
  });

  it('verifies S256 PKCE', () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce(`${verifier}x`, challenge)).toBe(false);
  });
});

describe('FailureLimiter', () => {
  it('blocks an IP after maxFailures inside the window and forgets old failures', () => {
    const limiter = new FailureLimiter({ maxFailures: 3, windowMs: 1000 });
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) {
      expect(limiter.isBlocked('1.2.3.4', t0 + i)).toBe(false);
      limiter.recordFailure('1.2.3.4', t0 + i);
    }
    expect(limiter.isBlocked('1.2.3.4', t0 + 10)).toBe(true);
    expect(limiter.isBlocked('5.6.7.8', t0 + 10)).toBe(false);
    expect(limiter.isBlocked('1.2.3.4', t0 + 1001)).toBe(false);
  });

  it('takes the proxy-appended (last) X-Forwarded-For entry as the client IP', () => {
    const req = {
      headers: { 'x-forwarded-for': 'spoofed, 203.0.113.9' },
      socket: { remoteAddress: '10.0.0.1' },
    } as unknown as IncomingMessage;
    expect(clientIp(req)).toBe('203.0.113.9');
    expect(
      clientIp({ headers: {}, socket: { remoteAddress: '10.0.0.1' } } as IncomingMessage)
    ).toBe('10.0.0.1');
  });
});

describe('OAuth endpoints', () => {
  const ctx: OAuthContext = {
    tokenKey: deriveTokenKey('server-key'),
    accessCode: 'server-key',
    verifyTogglToken: async (token) => token === 'good-toggl-token',
    publicUrl: 'https://mcp.example.com',
    limiter: new FailureLimiter({ maxFailures: 100, windowMs: 60_000 }),
  };
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      handleOAuthRequest(req, res, path, '/mcp', ctx).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(() => {
    server.close();
  });

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorizeQuery = (extra: Record<string, string> = {}) =>
    new URLSearchParams({
      response_type: 'code',
      client_id: 'client-1',
      redirect_uri: CALLBACK,
      state: 'xyz',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...extra,
    });

  async function submitAuthorize(fields: Record<string, string>) {
    const form = authorizeQuery();
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    return fetch(`${url}/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
    });
  }

  async function exchange(body: Record<string, string>) {
    const res = await fetch(`${url}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('serves discovery metadata pointing at itself', async () => {
    const resource = (await (
      await fetch(`${url}/.well-known/oauth-protected-resource`)
    ).json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(resource.resource).toBe('https://mcp.example.com/mcp');
    expect(resource.authorization_servers).toEqual(['https://mcp.example.com']);

    const as = (await (await fetch(`${url}/.well-known/oauth-authorization-server`)).json()) as {
      issuer: string;
      registration_endpoint: string;
      code_challenge_methods_supported: string[];
    };
    expect(as.issuer).toBe('https://mcp.example.com');
    expect(as.registration_endpoint).toBe('https://mcp.example.com/register');
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('registers clients only with allowed redirect URIs', async () => {
    const ok = await fetch(`${url}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK] }),
    });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { client_id: string }).client_id).toBeTruthy();

    const bad = await fetch(`${url}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }),
    });
    expect(bad.status).toBe(400);
  });

  it('shows the login form and refuses disallowed redirects or missing PKCE', async () => {
    const form = await fetch(`${url}/authorize?${authorizeQuery()}`);
    expect(form.status).toBe(200);
    const html = await form.text();
    expect(html).toContain('name="toggl_api_key"');
    expect(html).toContain('name="access_code"');
    expect(html).toContain('name="workspace_id"');

    const badRedirect = await fetch(
      `${url}/authorize?${authorizeQuery({ redirect_uri: 'https://evil.example/cb' })}`
    );
    expect(badRedirect.status).toBe(400);

    const noPkce = authorizeQuery();
    noPkce.delete('code_challenge');
    expect((await fetch(`${url}/authorize?${noPkce}`)).status).toBe(400);
  });

  it('rejects a wrong access code or Toggl token without redirecting', async () => {
    const wrongCode = await submitAuthorize({
      access_code: 'nope',
      toggl_api_key: 'good-toggl-token',
    });
    expect(wrongCode.status).toBe(400);
    expect(await wrongCode.text()).toContain('access code is not valid');

    const wrongToggl = await submitAuthorize({
      access_code: 'server-key',
      toggl_api_key: 'bad-toggl-token',
    });
    expect(wrongToggl.status).toBe(400);
    expect(await wrongToggl.text()).toContain('Toggl rejected');
  });

  it('issues a code, exchanges it once with PKCE, and refreshes', async () => {
    const redirect = await submitAuthorize({
      access_code: 'server-key',
      toggl_api_key: 'good-toggl-token',
      workspace_id: '42',
    });
    expect(redirect.status).toBe(302);
    const location = new URL(redirect.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
    expect(location.searchParams.get('state')).toBe('xyz');
    const code = location.searchParams.get('code')!;
    expect(code).toBeTruthy();

    const wrongVerifier = await exchange({
      grant_type: 'authorization_code',
      code,
      code_verifier: 'wrong',
      redirect_uri: CALLBACK,
      client_id: 'client-1',
    });
    expect(wrongVerifier.status).toBe(400);
    expect(wrongVerifier.body.error).toBe('invalid_grant');

    const tokens = await exchange({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: CALLBACK,
      client_id: 'client-1',
    });
    expect(tokens.status).toBe(200);
    expect(tokens.body.token_type).toBe('Bearer');
    expect(openAccessToken(ctx.tokenKey, tokens.body.access_token as string)).toEqual({
      toggl: 'good-toggl-token',
      ws: '42',
    });

    const replay = await exchange({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: CALLBACK,
      client_id: 'client-1',
    });
    expect(replay.body.error).toBe('invalid_grant');

    const refreshed = await exchange({
      grant_type: 'refresh_token',
      refresh_token: tokens.body.refresh_token as string,
      client_id: 'client-1',
    });
    expect(refreshed.status).toBe(200);
    expect(openAccessToken(ctx.tokenKey, refreshed.body.access_token as string)).toEqual({
      toggl: 'good-toggl-token',
      ws: '42',
    });

    const badRefresh = await exchange({ grant_type: 'refresh_token', refresh_token: 'nope' });
    expect(badRefresh.body.error).toBe('invalid_grant');
  });

  it('caps refreshed tokens at the absolute expiry fixed when the user signed in', async () => {
    // A refresh token about to expire yields an access token that expires with it, not later.
    const soon = Math.floor(Date.now() / 1000) + 30;
    const refreshToken = sealToken(ctx.tokenKey, {
      typ: 'refresh',
      toggl: 'good-toggl-token',
      cid: 'client-1',
      exp: soon,
    });
    const refreshed = await exchange({ grant_type: 'refresh_token', refresh_token: refreshToken });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.expires_in as number).toBeLessThanOrEqual(30);
    expect(refreshed.body.expires_in as number).toBeLessThan(REFRESH_TOKEN_TTL_SECONDS);
  });

  it('locks out an IP that keeps failing the access code', async () => {
    const strict: OAuthContext = {
      ...ctx,
      limiter: new FailureLimiter({ maxFailures: 2, windowMs: 60_000 }),
    };
    const local = createServer((req: IncomingMessage, res: ServerResponse) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      void handleOAuthRequest(req, res, path, '/mcp', strict);
    });
    await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
    const address = local.address();
    const localUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    try {
      const attempt = (ip: string) =>
        fetch(`${localUrl}/authorize`, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'x-forwarded-for': ip,
          },
          body: authorizeQuery({
            access_code: 'wrong',
            toggl_api_key: 'good-toggl-token',
          }).toString(),
          redirect: 'manual',
        });
      expect((await attempt('198.51.100.1')).status).toBe(400);
      expect((await attempt('198.51.100.1')).status).toBe(400);
      expect((await attempt('198.51.100.1')).status).toBe(429);
      // Other IPs are unaffected, and so is the token endpoint until it fails on its own.
      expect((await attempt('198.51.100.2')).status).toBe(400);
      const blockedToken = await fetch(`${localUrl}/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-forwarded-for': '198.51.100.1',
        },
        body: 'grant_type=refresh_token&refresh_token=nope',
      });
      expect(blockedToken.status).toBe(429);
    } finally {
      local.close();
    }
  });
});
