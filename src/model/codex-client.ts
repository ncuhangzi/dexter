/**
 * Codex chat client — UNOFFICIAL.
 *
 * Subclasses LangChain's ChatOpenAI to talk to OpenAI's Codex backend
 * (`https://chatgpt.com/backend-api/codex/responses`) using a ChatGPT
 * subscription bearer token instead of an API key. We reuse ChatOpenAI's
 * Responses API support so tool calling, streaming, and message format
 * translation come for free.
 *
 * Mechanism:
 * - `useResponsesApi: true` → SDK targets `/responses` instead of `/chat/completions`.
 * - `configuration.baseURL` overrides the host so requests go to the Codex backend.
 * - `configuration.fetch` is a custom fetch that injects a fresh OAuth bearer
 *   token on every request and one-shot retries on 401 with a refreshed token.
 * - Codex-specific headers (`originator`, `chatgpt-account-id`, etc.) match
 *   what the official Codex CLI sends; if OpenAI tightens the auth check
 *   these constants need to be re-synced from a current `codex` build.
 */
import { ChatOpenAI, type ChatOpenAIFields } from '@langchain/openai';
import { getCodexToken, refreshCodexToken, getStoredAccountId } from '../auth/codex-oauth.js';
import { logger } from '../utils/logger.js';
import type { Model } from '../utils/model.js';
import { isCodexModelAllowed } from '../utils/model.js';

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const CODEX_MODELS_URL = `${CODEX_BASE_URL}/models`;

interface ChatCodexOptions {
  model: string;
  /**
   * Ignored — Codex backend mandates `stream: true`. ChatOpenAI's blocking
   * `.invoke()` works fine against a streaming model (it accumulates chunks
   * internally), so we always set streaming on regardless of the caller.
   */
  streaming?: boolean;
}

/**
 * Wrap fetch with a request timeout so a hung Codex backend doesn't compound
 * with langchain's internal retries into a multi-minute black hole. Streaming
 * responses bypass the timeout once the headers arrive (no AbortController on
 * a long-lived stream).
 */
const REQUEST_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reshape the body LangChain produces into what the Codex backend expects.
 *
 * LangChain (>=1.3) puts the system message inside `input[]` with role
 * "developer". Codex demands `instructions` as a top-level field and rejects
 * the request with `{"detail":"Instructions are required"}` otherwise.
 *
 * We:
 *   1. Pull the first `developer`/`system` message out of `input`.
 *   2. Coerce its content (string or content blocks) into a flat string and
 *      assign to `instructions`.
 *   3. Drop the empty `text: {}` field — Codex tolerates it but it's noise.
 */
function reshapeForCodex(body: string): string {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return body;
  }

  if (payload.instructions || !Array.isArray(payload.input)) {
    return body;
  }

  const input = payload.input as Array<Record<string, unknown>>;
  const sysIdx = input.findIndex((msg) => {
    const role = msg.role;
    return role === 'developer' || role === 'system';
  });
  if (sysIdx < 0) return body;

  const sysMsg = input[sysIdx];
  payload.instructions = stringifyMessageContent(sysMsg.content);
  payload.input = input.filter((_, i) => i !== sysIdx);

  if (
    payload.text &&
    typeof payload.text === 'object' &&
    Object.keys(payload.text as object).length === 0
  ) {
    delete payload.text;
  }

  return JSON.stringify(payload);
}

function stringifyMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  // Content blocks: { type: 'input_text' | 'output_text' | 'text', text: '...' }
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (block && typeof block === 'object' && 'text' in block) {
        return String((block as { text: unknown }).text ?? '');
      }
      return '';
    })
    .join('');
}

function buildCodexFetch(): typeof fetch {
  return (async (input, init) => {
    const headers = new Headers(init?.headers);

    const token = await getCodexToken();
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('originator', 'codex_cli_rs');
    headers.set('OpenAI-Beta', 'responses=experimental');
    const accountId = getStoredAccountId();
    if (accountId) headers.set('chatgpt-account-id', accountId);

    let body = init?.body;
    if (typeof body === 'string') {
      body = reshapeForCodex(body);
    }

    if (process.env.DEXTER_CODEX_DEBUG) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const bodyPreview = typeof body === 'string' ? body.slice(0, 1500) : '<non-string body>';
      logger.info(`[Codex DEBUG] → ${init?.method ?? 'GET'} ${url}\n  body: ${bodyPreview}`);
    }

    let response = await fetchWithTimeout(input, { ...init, headers, body }, REQUEST_TIMEOUT_MS);

    if (response.status === 401) {
      logger.warn('[Codex] 401 from backend — refreshing token and retrying once');
      try {
        const fresh = await refreshCodexToken();
        headers.set('Authorization', `Bearer ${fresh}`);
        response = await fetchWithTimeout(input, { ...init, headers, body }, REQUEST_TIMEOUT_MS);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Surface "401" so the agent's retry classifier marks this non-retryable
        // — refreshing more aggressively won't help if the refresh endpoint
        // itself rejected us.
        throw new Error(`[Codex] 401 auth refresh failed: ${msg}`);
      }
    }

    // On a 4xx, peek at the body before returning so the user sees the actual
    // server message instead of LangChain's generic "(no body)" — and so the
    // error classifier has something concrete to work with.
    if (!response.ok && response.status >= 400 && response.status < 500) {
      const cloned = response.clone();
      const detail = await cloned.text().catch(() => '');
      const truncated = detail.slice(0, 600);
      if (truncated.trim()) {
        logger.error(`[Codex] backend ${response.status}: ${truncated}`);
        throw new Error(`[Codex] ${response.status} ${response.statusText}: ${truncated}`);
      }
      logger.error(`[Codex] backend ${response.status} with empty body`);
    }

    return response;
  }) as typeof fetch;
}

/**
 * Fetch the model catalog the current ChatGPT account can use. The endpoint
 * is undocumented but mirrors OpenAI's standard `/v1/models` shape — returns
 * `{ data: [{ id, ... }, ...] }`. Filters to gpt-5.4+ per project policy.
 *
 * Returns null on failure so callers can fall back to the hardcoded list in
 * `src/utils/model.ts`. Best-effort: a network error or an unrecognised
 * payload shape just means we use the bundled list.
 */
export async function fetchCodexModels(): Promise<Model[] | null> {
  let token: string;
  try {
    token = await getCodexToken();
  } catch {
    return null;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    originator: 'codex_cli_rs',
    'OpenAI-Beta': 'responses=experimental',
    Accept: 'application/json',
  };
  const accountId = getStoredAccountId();
  if (accountId) headers['chatgpt-account-id'] = accountId;

  let response: Response;
  try {
    response = await fetch(CODEX_MODELS_URL, { headers });
  } catch (e) {
    logger.warn(`[Codex] models fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }

  if (response.status === 401) {
    try {
      const fresh = await refreshCodexToken();
      headers.Authorization = `Bearer ${fresh}`;
      response = await fetch(CODEX_MODELS_URL, { headers });
    } catch (e) {
      logger.warn(`[Codex] models refresh failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  if (!response.ok) {
    logger.warn(`[Codex] models endpoint returned ${response.status} ${response.statusText}`);
    return null;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }

  // Tolerant extraction: accept `{ data: [...] }`, `{ models: [...] }`, or a
  // bare array. Each entry should have `id` and may have `display_name` / `name`.
  const list = extractModelList(payload);
  if (!list) return null;

  const models: Model[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? obj.id : null;
    if (!id || !isCodexModelAllowed(id)) continue;
    const displayRaw =
      (typeof obj.display_name === 'string' && obj.display_name) ||
      (typeof obj.name === 'string' && obj.name) ||
      id;
    models.push({
      id: `codex:${id}`,
      displayName: `${displayRaw} (ChatGPT 訂閱)`,
    });
  }

  // Newer versions sort to the top so the picker default matches user intent.
  models.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  return models.length > 0 ? models : null;
}

function extractModelList(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  if (Array.isArray(obj.data)) return obj.data;
  if (Array.isArray(obj.models)) return obj.models;
  return null;
}

/**
 * ChatCodex: ChatOpenAI configured for OpenAI's Codex backend with a
 * subscription bearer token. The `apiKey` we pass to the parent is a
 * placeholder — the real bearer token is injected by `buildCodexFetch()`
 * on each request.
 */
export class ChatCodex extends ChatOpenAI {
  constructor(_opts: ChatCodexOptions) {
    const fields: ChatOpenAIFields = {
      model: _opts.model,
      // Codex backend rejects requests with `stream: false` ("Stream must be
      // set to true"), so force streaming. Same for `store: false` ("Store
      // must be set to false") — passed via modelKwargs since it's not a
      // top-level ChatOpenAI option.
      streaming: true,
      modelKwargs: { store: false },
      apiKey: 'codex-oauth-placeholder',
      useResponsesApi: true,
      configuration: {
        baseURL: CODEX_BASE_URL,
        fetch: buildCodexFetch(),
      },
    };
    super(fields);
  }
}
