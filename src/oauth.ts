// Minimal OAuth 2.1 authorization server so the HTTP server works as a Claude custom
// connector, which authenticates each user with OAuth rather than custom headers.
//
// The "login" page asks for the server access code, the user's Toggl API token, and an
// optional default workspace. Codes and tokens are AES-256-GCM sealed blobs carrying
// that grant, so nothing is stored server-side: they survive dyno restarts, and rotating
// MCP_HTTP_API_KEY (from which the sealing key is derived) revokes every issued token.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { FailureLimiter, clientIp } from './rate-limit.js';

export const CODE_TTL_SECONDS = 5 * 60;
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const MAX_FORM_BYTES = 64 * 1024;

export interface Grant {
  toggl: string;
  ws?: string;
}

interface CodePayload extends Grant {
  typ: 'code';
  cid: string;
  ruri: string;
  cc: string;
  exp: number;
}

interface AccessPayload extends Grant {
  typ: 'access';
  exp: number;
}

interface RefreshPayload extends Grant {
  typ: 'refresh';
  cid: string;
  exp: number;
}

type Payload = CodePayload | AccessPayload | RefreshPayload;

export interface OAuthContext {
  /** Key from deriveTokenKey(MCP_HTTP_API_KEY). */
  tokenKey: Buffer;
  /** The access code users must enter on the authorize page (MCP_HTTP_API_KEY). */
  accessCode: string;
  /** Resolves false when Toggl rejects the token; throws when Toggl can't be reached. */
  verifyTogglToken: (token: string) => Promise<boolean>;
  /** Overrides the base URL derived from request headers. */
  publicUrl?: string;
  /** Locks out IPs that keep failing the access code or presenting bad codes/tokens. */
  limiter: FailureLimiter;
  /** Exact redirect URIs to allow besides Claude's callback and loopback (other MCP clients). */
  extraRedirectUris?: string[];
}

export function deriveTokenKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'mcp-toggl', 'oauth-token-key', 32));
}

export function sealToken(key: Buffer, payload: Payload): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

function openToken<T extends Payload['typ']>(
  key: Buffer,
  token: string,
  typ: T
): Extract<Payload, { typ: T }> | undefined {
  try {
    const raw = Buffer.from(token, 'base64url');
    if (raw.length < 29) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    const payload = JSON.parse(json.toString('utf8')) as Payload;
    if (payload.typ !== typ || payload.exp < nowSeconds()) return undefined;
    return payload as Extract<Payload, { typ: T }>;
  } catch (_error) {
    return undefined;
  }
}

/** Returns the grant behind a valid, unexpired access token. */
export function openAccessToken(key: Buffer, token: string): Grant | undefined {
  const payload = openToken(key, token, 'access');
  return payload && { toggl: payload.toggl, ws: payload.ws };
}

export function isAllowedRedirectUri(value: string, extraRedirectUris: string[] = []): boolean {
  if (extraRedirectUris.includes(value)) return true;
  let url: URL;
  try {
    url = new URL(value);
  } catch (_error) {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (`${url.origin}${url.pathname}` === CLAUDE_CALLBACK) return !url.search;
  // Claude Code and other native clients use a loopback redirect on an ephemeral port.
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  const expected = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const actual = Buffer.from(challenge);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** The scheme the client used, as reported by the platform's TLS-terminating proxy. */
export function requestProtocol(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-proto'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || 'http';
}

/**
 * Base URL used in discovery documents and 401 challenges. Set MCP_HTTP_PUBLIC_URL in
 * production so this never depends on a client-controlled Host header.
 */
export function publicBaseUrl(req: IncomingMessage, override?: string): string {
  if (override) return override.replace(/\/+$/, '');
  return `${requestProtocol(req)}://${req.headers.host ?? 'localhost'}`;
}

export function wwwAuthenticate(baseUrl: string, error?: 'invalid_token'): string {
  const metadata = `resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`;
  return error ? `Bearer error="${error}", ${metadata}` : `Bearer ${metadata}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Authorization codes are single-use; remember redeemed ones until they would expire anyway.
const redeemedCodes = new Map<string, number>();

function redeemCode(code: string, exp: number): boolean {
  const now = nowSeconds();
  for (const [key, expiry] of redeemedCodes) if (expiry < now) redeemedCodes.delete(key);
  const id = createHash('sha256').update(code).digest('base64url');
  if (redeemedCodes.has(id)) return false;
  redeemedCodes.set(id, exp);
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_FORM_BYTES) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readParams(req: IncomingMessage): Promise<Record<string, string>> {
  const text = await readBody(req);
  if ((req.headers['content-type'] ?? '').includes('application/json')) {
    const parsed = JSON.parse(text || '{}') as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    );
  }
  return Object.fromEntries(new URLSearchParams(text));
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!
  );
}

interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
}

function validateAuthorizeParams(
  params: Record<string, string | undefined>,
  extraRedirectUris: string[] = []
): AuthorizeParams | string {
  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method } = params;
  if (!client_id) return 'Missing client_id.';
  if (!redirect_uri || !isAllowedRedirectUri(redirect_uri, extraRedirectUris)) {
    if (redirect_uri) console.error(`OAuth: rejected redirect_uri ${redirect_uri}`);
    return 'This redirect_uri is not allowed.';
  }
  if (response_type !== 'code') return 'response_type must be "code".';
  if (!code_challenge || code_challenge_method !== 'S256') {
    return 'A PKCE code_challenge with code_challenge_method=S256 is required.';
  }
  return { client_id, redirect_uri, state: params.state ?? '', code_challenge };
}

function renderPage(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
  });
  res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect Toggl</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; background: #f6f5f2; color: #1f1d1a; margin: 0; padding: 40px 16px; }
  main { max-width: 420px; margin: 0 auto; background: #fff; border: 1px solid #e4e1da; border-radius: 12px; padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p { margin: 0 0 18px; color: #5c5850; }
  label { display: block; font-weight: 600; margin: 14px 0 4px; }
  small { font-weight: 400; color: #7a756b; }
  input { box-sizing: border-box; width: 100%; padding: 9px 10px; border: 1px solid #cfcac0; border-radius: 8px; font: inherit; }
  button { margin-top: 22px; width: 100%; padding: 10px; border: 0; border-radius: 8px; background: #c1440e; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  .error { background: #fdecea; color: #8a1c10; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
  a { color: #c1440e; }
</style>
</head>
<body><main>${body}</main></body>
</html>`);
}

function renderAuthorizeForm(
  res: ServerResponse,
  params: AuthorizeParams,
  error?: string,
  workspaceId = ''
): void {
  const hidden = Object.entries({ ...params, response_type: 'code', code_challenge_method: 'S256' })
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
    .join('\n');
  const redirectHost = new URL(params.redirect_uri).host;
  renderPage(
    res,
    error ? 400 : 200,
    `<h1>Connect Toggl Track</h1>
<p>After you continue, you'll be sent back to <strong>${escapeHtml(redirectHost)}</strong> with access to your Toggl account.</p>
${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
<form method="post" action="/authorize">
${hidden}
<label for="access_code">Access code <small>from the server owner</small></label>
<input id="access_code" name="access_code" type="password" autocomplete="off" required>
<label for="toggl_api_key">Toggl API token <small><a href="https://track.toggl.com/profile" target="_blank" rel="noopener noreferrer">find it in your profile</a></small></label>
<input id="toggl_api_key" name="toggl_api_key" type="password" autocomplete="off" required>
<label for="workspace_id">Default workspace ID <small>optional</small></label>
<input id="workspace_id" name="workspace_id" inputmode="numeric" pattern="[1-9][0-9]*" value="${escapeHtml(workspaceId)}">
<button type="submit">Connect</button>
</form>`
  );
}

async function handleAuthorize(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: OAuthContext
): Promise<void> {
  const isPost = req.method === 'POST';
  const params = isPost
    ? await readParams(req)
    : Object.fromEntries(new URL(req.url ?? '/', 'http://localhost').searchParams);
  const valid = validateAuthorizeParams(params, ctx.extraRedirectUris);
  if (typeof valid === 'string') {
    renderPage(res, 400, `<h1>Can't connect</h1><p>${escapeHtml(valid)}</p>`);
    return;
  }
  if (!isPost) {
    renderAuthorizeForm(res, valid);
    return;
  }

  const togglToken = params.toggl_api_key?.trim() ?? '';
  const workspaceId = params.workspace_id?.trim() ?? '';
  const ip = clientIp(req);
  if (ctx.limiter.isBlocked(ip)) {
    renderPage(res, 429, `<h1>Too many attempts</h1><p>Wait a while, then try again.</p>`);
    return;
  }
  if (!safeEqual(params.access_code?.trim() ?? '', ctx.accessCode)) {
    ctx.limiter.recordFailure(ip);
    renderAuthorizeForm(res, valid, 'That access code is not valid.', workspaceId);
    return;
  }
  if (workspaceId && !/^[1-9]\d*$/.test(workspaceId)) {
    renderAuthorizeForm(res, valid, 'Workspace ID must be a positive number.', workspaceId);
    return;
  }
  try {
    if (!togglToken || !(await ctx.verifyTogglToken(togglToken))) {
      renderAuthorizeForm(res, valid, 'Toggl rejected that API token.', workspaceId);
      return;
    }
  } catch (_error) {
    renderAuthorizeForm(
      res,
      valid,
      "Couldn't reach Toggl to check the token. Try again.",
      workspaceId
    );
    return;
  }

  const code = sealToken(ctx.tokenKey, {
    typ: 'code',
    toggl: togglToken,
    ...(workspaceId ? { ws: workspaceId } : {}),
    cid: valid.client_id,
    ruri: valid.redirect_uri,
    cc: valid.code_challenge,
    exp: nowSeconds() + CODE_TTL_SECONDS,
  });
  const location = new URL(valid.redirect_uri);
  location.searchParams.set('code', code);
  if (valid.state) location.searchParams.set('state', valid.state);
  res.writeHead(302, { location: location.toString(), 'cache-control': 'no-store' });
  res.end();
}

/**
 * Issues an access token plus a refresh token. Refresh tokens carry an absolute expiry
 * fixed at sign-in (`refreshExp`), so a grant can't be refreshed forever without the
 * user re-entering their credentials.
 */
function issueTokens(
  res: ServerResponse,
  ctx: OAuthContext,
  grant: Grant,
  clientId: string,
  refreshExp: number
): void {
  const base = { toggl: grant.toggl, ...(grant.ws ? { ws: grant.ws } : {}) };
  const accessExp = Math.min(nowSeconds() + ACCESS_TOKEN_TTL_SECONDS, refreshExp);
  sendJson(res, 200, {
    access_token: sealToken(ctx.tokenKey, { typ: 'access', ...base, exp: accessExp }),
    token_type: 'Bearer',
    expires_in: accessExp - nowSeconds(),
    refresh_token: sealToken(ctx.tokenKey, {
      typ: 'refresh',
      ...base,
      cid: clientId,
      exp: refreshExp,
    }),
  });
}

async function handleToken(req: IncomingMessage, res: ServerResponse, ctx: OAuthContext) {
  const ip = clientIp(req);
  if (ctx.limiter.isBlocked(ip)) {
    sendJson(res, 429, { error: 'invalid_request', error_description: 'Too many attempts' });
    return;
  }
  const params = await readParams(req);
  const invalidGrant = () => {
    ctx.limiter.recordFailure(ip);
    sendJson(res, 400, { error: 'invalid_grant' });
  };

  if (params.grant_type === 'authorization_code') {
    const { code, code_verifier, redirect_uri, client_id } = params;
    if (!code || !code_verifier || !redirect_uri || !client_id) {
      sendJson(res, 400, { error: 'invalid_request' });
      return;
    }
    const payload = openToken(ctx.tokenKey, code, 'code');
    if (
      !payload ||
      payload.cid !== client_id ||
      payload.ruri !== redirect_uri ||
      !verifyPkce(code_verifier, payload.cc) ||
      !redeemCode(code, payload.exp)
    ) {
      invalidGrant();
      return;
    }
    issueTokens(res, ctx, payload, client_id, nowSeconds() + REFRESH_TOKEN_TTL_SECONDS);
    return;
  }

  if (params.grant_type === 'refresh_token') {
    const payload =
      params.refresh_token && openToken(ctx.tokenKey, params.refresh_token, 'refresh');
    if (!payload || (params.client_id && params.client_id !== payload.cid)) {
      invalidGrant();
      return;
    }
    issueTokens(res, ctx, payload, payload.cid, payload.exp);
    return;
  }

  sendJson(res, 400, { error: 'unsupported_grant_type' });
}

async function handleRegister(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: OAuthContext
): Promise<void> {
  let body: { redirect_uris?: unknown; client_name?: unknown };
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch (_error) {
    sendJson(res, 400, { error: 'invalid_client_metadata' });
    return;
  }
  const redirectUris = body.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    !redirectUris.every(
      (uri) => typeof uri === 'string' && isAllowedRedirectUri(uri, ctx.extraRedirectUris)
    )
  ) {
    // Logged so the owner can add a new client's callback to MCP_HTTP_OAUTH_REDIRECT_URIS.
    console.error(`OAuth: rejected registration redirect_uris ${JSON.stringify(redirectUris)}`);
    sendJson(res, 400, { error: 'invalid_redirect_uri' });
    return;
  }
  // Nothing to store: /authorize checks every redirect_uri against the same allowlist.
  sendJson(res, 201, {
    client_id: randomUUID(),
    client_id_issued_at: nowSeconds(),
    ...(typeof body.client_name === 'string'
      ? { client_name: body.client_name.slice(0, 200) }
      : {}),
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
}

/**
 * Serves OAuth discovery, registration, authorization, and token endpoints.
 * Returns false when the path is not an OAuth route.
 */
export async function handleOAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  mcpPath: string,
  ctx: OAuthContext
): Promise<boolean> {
  const baseUrl = publicBaseUrl(req, ctx.publicUrl);
  const { method } = req;

  if (
    method === 'GET' &&
    (path === '/.well-known/oauth-protected-resource' ||
      path === `/.well-known/oauth-protected-resource${mcpPath}`)
  ) {
    sendJson(res, 200, {
      resource: `${baseUrl}${mcpPath}`,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ['header'],
    });
    return true;
  }
  if (method === 'GET' && path === '/.well-known/oauth-authorization-server') {
    sendJson(res, 200, {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
    });
    return true;
  }

  try {
    if (path === '/authorize' && (method === 'GET' || method === 'POST')) {
      await handleAuthorize(req, res, ctx);
      return true;
    }
    if (path === '/token' && method === 'POST') {
      await handleToken(req, res, ctx);
      return true;
    }
    if (path === '/register' && method === 'POST') {
      await handleRegister(req, res, ctx);
      return true;
    }
  } catch (_error) {
    if (!res.headersSent) sendJson(res, 400, { error: 'invalid_request' });
    return true;
  }
  return false;
}
