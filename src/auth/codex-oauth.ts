/**
 * Codex OAuth flow — UNOFFICIAL.
 *
 * Lets dexter call OpenAI's Codex backend using a ChatGPT subscription bearer
 * token (the same flow the official `codex` CLI uses). Reverse-engineered from
 * publicly-known constants in the Apache-licensed openai/codex repo and from
 * https://github.com/numman-ali/opencode-openai-codex-auth.
 *
 * ⚠️  Fragile: OpenAI can change the auth check or revoke the client ID at any
 *     time. Anthropic and Google removed equivalent flows in 2026/04. If this
 *     stops working, the request shape (or the constants below) needs to be
 *     updated to match a current `codex` CLI build.
 */
import { createHash, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { createServer } from 'http';
import { dexterPath } from '../utils/paths.js';
import { logger } from '../utils/logger.js';

// Public Codex CLI OAuth client. This is a publicly-known constant baked into
// the official codex binary; not a secret. If OpenAI rotates it, login will
// 400 and this constant must be replaced with the current value.
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_BASE = 'https://auth.openai.com';
const AUTHORIZE_URL = `${AUTH_BASE}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE}/oauth/token`;
const SCOPES = 'openid profile email offline_access';
// Codex CLI listens on a fixed port for the redirect; using a different port
// will not match the registered redirect_uri and the exchange will fail.
const REDIRECT_PORT = 1455;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`;

const DEXTER_TOKEN_PATH = dexterPath('codex-auth.json');

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  account_id?: string;
  /** Epoch ms when access_token expires. */
  expires_at: number;
}

/** Layout used by the official `~/.codex/auth.json` file. */
interface CodexHomeAuth {
  OPENAI_API_KEY?: string | null;
  tokens?: {
    access_token: string;
    refresh_token: string;
    id_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

function codexHomePath(): string {
  const codexHome = process.env.CODEX_HOME;
  if (codexHome) return join(codexHome, 'auth.json');
  return join(homedir(), '.codex', 'auth.json');
}

/**
 * One-shot import of `~/.codex/auth.json` into `.dexter/codex-auth.json`.
 * Refresh tokens can only be used once, so sharing the file with the official
 * `codex` CLI causes "refresh_token_reused" errors when the two race. We copy
 * once on first run, then never touch the home file again.
 */
function importCodexHomeIfMissing(): void {
  if (existsSync(DEXTER_TOKEN_PATH)) return;
  const path = codexHomePath();
  if (!existsSync(path)) return;
  try {
    const auth = JSON.parse(readFileSync(path, 'utf-8')) as CodexHomeAuth;
    if (!auth.tokens?.access_token || !auth.tokens.refresh_token) return;
    writeDexterTokens({
      access_token: auth.tokens.access_token,
      refresh_token: auth.tokens.refresh_token,
      id_token: auth.tokens.id_token,
      account_id: auth.tokens.account_id,
      // Unknown — assume it could be expired so the next call refreshes proactively.
      expires_at: 0,
    });
    logger.info(
      `[Codex OAuth] imported credentials from ${path} into ${DEXTER_TOKEN_PATH}. ` +
      `Future refreshes won't touch the home file.`,
    );
  } catch {
    // Best-effort; if the file is malformed the user can just run the login script.
  }
}

function readDexterTokens(): StoredTokens | null {
  if (!existsSync(DEXTER_TOKEN_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(DEXTER_TOKEN_PATH, 'utf-8')) as StoredTokens;
    if (!parsed.access_token || !parsed.refresh_token) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeDexterTokens(tokens: StoredTokens): void {
  const dir = dirname(DEXTER_TOKEN_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(DEXTER_TOKEN_PATH, JSON.stringify(tokens, null, 2));
}


// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeCodeVerifier(): string {
  return base64url(randomBytes(32));
}

function makeCodeChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

// ---------------------------------------------------------------------------
// OAuth flow
// ---------------------------------------------------------------------------

interface AuthorizationResult {
  code: string;
  state: string;
}

function waitForCallback(expectedState: string): Promise<AuthorizationResult> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://localhost:${REDIRECT_PORT}`);
        if (url.pathname !== '/auth/callback') {
          res.writeHead(404).end('not found');
          return;
        }
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'content-type': 'text/html' }).end(
            `<h1>Login failed</h1><p>${error}</p>`,
          );
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }
        if (!code || state !== expectedState) {
          res.writeHead(400).end('missing or invalid code/state');
          server.close();
          reject(new Error('OAuth callback missing code or state mismatch'));
          return;
        }

        res.writeHead(200, { 'content-type': 'text/html' }).end(
          '<h1>Login successful</h1><p>You can close this tab and return to the terminal.</p>',
        );
        server.close();
        resolve({ code, state });
      } catch (e) {
        server.close();
        reject(e);
      }
    });

    server.on('error', reject);
    server.listen(REDIRECT_PORT, '127.0.0.1');
  });
}

async function exchangeCode(code: string, codeVerifier: string): Promise<StoredTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CODEX_CLIENT_ID,
    code_verifier: codeVerifier,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Token exchange failed: ${res.status} ${res.statusText} ${detail}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    id_token?: string;
    expires_in?: number;
  };
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    id_token: json.id_token,
    expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

/** Distinguishes "token rotated by another client" from generic refresh failures. */
export class CodexRefreshTokenReusedError extends Error {
  constructor(detail: string) {
    // The "401 unauthorized" text is intentional — it lets the agent's
    // generic auth-error classifier mark this as non-retryable so we don't
    // hammer /token three more times before surfacing the message.
    super(
      `401 unauthorized: Codex refresh token was already used by another client (likely the ` +
      `official \`codex\` CLI). Re-run \`bun run scripts/codex-login.ts\` to mint a fresh one. ` +
      `Server said: ${detail}`,
    );
    this.name = 'CodexRefreshTokenReusedError';
  }
}

async function refreshTokens(refreshToken: string): Promise<StoredTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CODEX_CLIENT_ID,
    scope: SCOPES,
  });
  // Refresh shouldn't take long; cap it so a slow network doesn't compound
  // into a 40-second agent hang on top of langchain's retries.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 401 && /refresh_token_reused/i.test(detail)) {
      throw new CodexRefreshTokenReusedError(detail.slice(0, 300));
    }
    throw new Error(`Token refresh failed: ${res.status} ${res.statusText} ${detail.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  };
  return {
    access_token: json.access_token,
    // OpenAI may rotate the refresh token; fall back to the existing one.
    refresh_token: json.refresh_token ?? refreshToken,
    id_token: json.id_token,
    expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

async function openInBrowser(url: string): Promise<void> {
  // Cross-platform browser open without pulling in a dep. macOS uses `open`,
  // Linux uses `xdg-open`, Windows uses `start`. If none are available the
  // user can paste the URL manually — we already log it.
  const { spawn } = await import('child_process');
  const cmd =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32' ? 'start' :
    'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Best-effort; URL is logged so the user can copy it manually.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the interactive Codex OAuth login. Opens a browser, captures the
 * callback on localhost, and writes tokens to `.dexter/codex-auth.json`.
 */
export async function loginCodex(): Promise<void> {
  const codeVerifier = makeCodeVerifier();
  const codeChallenge = makeCodeChallenge(codeVerifier);
  const state = base64url(randomBytes(16));

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CODEX_CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);

  logger.info(`[Codex OAuth] open this URL in a browser if it doesn't open automatically:\n${url.toString()}`);
  void openInBrowser(url.toString());

  const { code } = await waitForCallback(state);
  const tokens = await exchangeCode(code, codeVerifier);
  writeDexterTokens(tokens);
  logger.info(`[Codex OAuth] login successful. Tokens written to ${DEXTER_TOKEN_PATH}`);
}

/**
 * Get a current bearer token for the Codex API. Reads from
 * `.dexter/codex-auth.json` first, falls back to `~/.codex/auth.json`,
 * and refreshes when the access token is within 60s of expiry.
 *
 * Throws if no tokens exist — caller should prompt the user to run
 * `codex login` or the dexter codex-login script.
 */
export async function getCodexToken(): Promise<string> {
  let tokens = (importCodexHomeIfMissing(), readDexterTokens());
  if (!tokens) {
    throw new Error(
      '[Codex OAuth] no credentials found. Run `bun run scripts/codex-login.ts` ' +
      'to log in with your ChatGPT account, or install the official `codex` CLI ' +
      'and run `codex login` first.',
    );
  }

  // Refresh slightly before expiry to avoid mid-call invalidation.
  if (tokens.expires_at && tokens.expires_at - Date.now() < 60_000) {
    try {
      tokens = await refreshTokens(tokens.refresh_token);
      writeDexterTokens(tokens);
    } catch (e) {
      logger.warn(`[Codex OAuth] proactive refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return tokens.access_token;
}

/**
 * Force-refresh after a 401 from the Codex backend. Returns the new access
 * token, or throws if the refresh itself fails (user needs to re-login).
 */
export async function refreshCodexToken(): Promise<string> {
  const tokens = (importCodexHomeIfMissing(), readDexterTokens());
  if (!tokens) throw new Error('[Codex OAuth] no credentials to refresh');
  const fresh = await refreshTokens(tokens.refresh_token);
  writeDexterTokens(fresh);
  return fresh.access_token;
}

export function getStoredAccountId(): string | undefined {
  const tokens = (importCodexHomeIfMissing(), readDexterTokens());
  return tokens?.account_id;
}

/**
 * Cheap "is the user logged in?" check used by the model picker UI to decide
 * whether to run the OAuth flow before applying a `codex:` model selection.
 * Doesn't validate the token with the server — only checks for presence.
 */
export function hasCodexAuth(): boolean {
  importCodexHomeIfMissing();
  return readDexterTokens() !== null;
}
