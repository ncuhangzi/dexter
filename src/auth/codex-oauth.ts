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
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
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
const DEXTER_LOCK_PATH = `${DEXTER_TOKEN_PATH}.lock`;
/**
 * Stale lock cleanup — if a previous Dexter process crashed mid-refresh and
 * left the lock file behind, we don't want to deadlock forever. 30s is long
 * enough that an in-flight refresh (which is bounded by a 10s fetch timeout)
 * will always complete first.
 */
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_INTERVAL_MS = 100;
const LOCK_MAX_WAIT_MS = 15_000;

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

/**
 * Re-import tokens from `~/.codex/auth.json` when our local refresh failed —
 * the official `codex` CLI may have rotated the refresh_token out from under
 * us in another terminal. Only takes over if the home file is newer than our
 * own and has a different refresh_token; returns the imported tokens or null
 * if there's nothing fresher to use.
 */
function reimportCodexHomeIfNewer(): StoredTokens | null {
  const path = codexHomePath();
  if (!existsSync(path)) return null;
  try {
    const homeStat = statSync(path);
    const localStat = existsSync(DEXTER_TOKEN_PATH) ? statSync(DEXTER_TOKEN_PATH) : null;
    if (localStat && homeStat.mtimeMs <= localStat.mtimeMs) return null;

    const auth = JSON.parse(readFileSync(path, 'utf-8')) as CodexHomeAuth;
    if (!auth.tokens?.access_token || !auth.tokens.refresh_token) return null;

    const existing = readDexterTokens();
    if (existing && existing.refresh_token === auth.tokens.refresh_token) return null;

    const imported: StoredTokens = {
      access_token: auth.tokens.access_token,
      refresh_token: auth.tokens.refresh_token,
      id_token: auth.tokens.id_token,
      account_id: auth.tokens.account_id,
      // Same as importCodexHomeIfMissing — let the next call refresh proactively.
      expires_at: 0,
    };
    writeDexterTokens(imported);
    logger.info(`[Codex OAuth] re-imported fresh tokens from ${path} (codex CLI rotated)`);
    return imported;
  } catch {
    return null;
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

// ---------------------------------------------------------------------------
// Refresh lock — two scopes:
//
// 1. In-process: parallel tool calls all need a token and would otherwise race
//    into `refreshTokens`. First wins, rest get `refresh_token_reused`. The
//    `inFlightRefresh` promise lets all callers share a single refresh.
//
// 2. Cross-process: Dexter and the official `codex` CLI both rotate the same
//    refresh_token. An exclusive-create lock file on disk (with a stale-TTL
//    fallback in case a holder crashed) prevents the race.
// ---------------------------------------------------------------------------

let inFlightRefresh: Promise<StoredTokens> | null = null;

async function acquireFileLock(path: string): Promise<() => void> {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  while (true) {
    try {
      // O_EXCL ("wx") — fails if the file already exists. That's the lock.
      const fd = openSync(path, 'wx');
      // Record holder pid for debugging; we don't actually verify on takeover.
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(path);
        } catch {
          // Lock was already cleared (e.g., stolen via stale-cleanup); ignore.
        }
      };
    } catch (err: unknown) {
      if (!isLockBusy(err)) throw err;
      // Lock exists — check if it's stale and steal it, otherwise wait.
      try {
        const stat = statSync(path);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          logger.warn(`[Codex OAuth] stealing stale lock at ${path}`);
          try { unlinkSync(path); } catch { /* race with another stealer */ }
          continue;
        }
      } catch {
        // stat failed → file vanished, retry the acquire immediately
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`[Codex OAuth] timed out waiting ${LOCK_MAX_WAIT_MS}ms for refresh lock`);
      }
      await sleep(LOCK_RETRY_INTERVAL_MS);
    }
  }
}

function isLockBusy(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  return code === 'EEXIST';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Refresh under both in-process and cross-process locks. Inside the lock we
 * re-read the token file — another holder may have already refreshed for us,
 * in which case we can return their tokens without burning a refresh call.
 */
async function refreshUnderLock(currentRefreshToken: string): Promise<StoredTokens> {
  if (inFlightRefresh) return inFlightRefresh;

  inFlightRefresh = (async () => {
    const release = await acquireFileLock(DEXTER_LOCK_PATH);
    try {
      // Re-read inside the lock — another process may have just refreshed.
      const latest = readDexterTokens();
      if (
        latest &&
        latest.refresh_token !== currentRefreshToken &&
        latest.expires_at &&
        latest.expires_at - Date.now() > 60_000
      ) {
        return latest;
      }

      const tokensToUse = latest ?? null;
      const refreshToken = tokensToUse?.refresh_token ?? currentRefreshToken;
      try {
        const fresh = await refreshTokens(refreshToken);
        writeDexterTokens(fresh);
        return fresh;
      } catch (err) {
        // If the official `codex` CLI rotated the token in another terminal,
        // ~/.codex/auth.json may have a usable refresh_token. Try once before
        // giving up — keeps the user logged in across CLI clients.
        if (err instanceof CodexRefreshTokenReusedError) {
          const reimported = reimportCodexHomeIfNewer();
          if (reimported && reimported.refresh_token !== refreshToken) {
            const fresh = await refreshTokens(reimported.refresh_token);
            writeDexterTokens(fresh);
            return fresh;
          }
        }
        throw err;
      }
    } finally {
      release();
    }
  })();

  try {
    return await inFlightRefresh;
  } finally {
    inFlightRefresh = null;
  }
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
      tokens = await refreshUnderLock(tokens.refresh_token);
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
  const fresh = await refreshUnderLock(tokens.refresh_token);
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
