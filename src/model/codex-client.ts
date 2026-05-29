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
 * with langchain's internal retries into a multi-minute black hole.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * After headers arrive, the body can still stall — Codex sometimes keeps the
 * connection open without sending more SSE events. Without a body-level
 * watchdog the agent spins forever. 90s is generous enough for legitimate
 * reasoning pauses but bounded enough that the user gets a real error.
 *
 * NOTE: this only catches truly silent stalls. If Codex sends SSE keep-alive
 * comments (`: ping\n\n`) the idle timer resets on every byte and never fires
 * — that's what `BODY_WALL_TIMEOUT_MS` below is for.
 */
const BODY_IDLE_TIMEOUT_MS = 90_000;

/**
 * Absolute upper bound on a single Codex request, regardless of activity.
 * Without this, an SSE stream that keeps trickling keep-alive bytes (or one
 * where LangChain's parser silently consumes events without terminating) can
 * spin the agent forever. 3 minutes is long enough to cover a slow reasoning
 * model response and short enough that the user gets an error rather than an
 * indefinite spinner.
 */
const BODY_WALL_TIMEOUT_MS = 3 * 60_000;

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  headersTimeoutMs: number,
): Promise<Response> {
  // Share the controller between header-fetch and body-read so we can swap a
  // headers timeout for a body-idle timeout once headers arrive. If init.signal
  // is already set (caller's own abort), link both via abort propagation.
  const controller = new AbortController();
  const externalSignal = init?.signal;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener('abort', abortFromExternal, { once: true });
  }

  const headersTimer = setTimeout(() => controller.abort(), headersTimeoutMs);
  let response: Response;
  try {
    response = await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(headersTimer);
  }

  if (externalSignal) {
    externalSignal.removeEventListener('abort', abortFromExternal);
  }

  // Only wrap with watchdogs for actual streaming success responses. Wrapping
  // a 4xx with our pull-based ReadableStream caused `clone().text()` in the
  // error handler to interact badly with the OpenAI SDK's retry path —
  // manifesting as 90s+ of "Connection error" before the user sees the real
  // 404. Plain non-2xx responses don't need a watchdog (body is empty or
  // bounded JSON), so return them as-is.
  if (!response.ok || !response.body) return response;

  return attachStreamWatchdogs(response, controller, BODY_IDLE_TIMEOUT_MS, BODY_WALL_TIMEOUT_MS);
}

/**
 * Stateful SSE rewriter for the Codex backend.
 *
 * Problem: `@langchain/openai`'s Responses converter assumes
 * `response.completed.response.output` is an array of output items
 * (`responses.js:217` does `response.output.map(...)`). OpenAI's official
 * Responses API includes that snapshot. Codex omits it — each item is only
 * delivered through `response.output_item.done` events — so LangChain crashes
 * with `undefined is not an object (evaluating 'response.output.map')`.
 *
 * Fix: track every `output_item.done` payload as it streams past, then when
 * `response.completed` arrives, inject the collected items into
 * `response.output` (if absent) before forwarding the bytes to LangChain.
 *
 * Returned function takes a raw byte chunk and returns the (possibly
 * rewritten) bytes to forward downstream. Buffers partial events at `\n\n`
 * boundaries so chunks split mid-event don't break parsing.
 */
function makeCodexSseRewriter(): (chunk: Uint8Array) => Uint8Array {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const encoder = new TextEncoder();
  const outputItems: unknown[] = [];
  let buffer = '';

  return (chunk: Uint8Array): Uint8Array => {
    buffer += decoder.decode(chunk, { stream: true });
    let out = '';
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, sep + 2);
      buffer = buffer.slice(sep + 2);

      const lines = block.split('\n');
      const eventLine = lines.find((l) => l.startsWith('event:'));
      const dataLine = lines.find((l) => l.startsWith('data:'));
      const event = eventLine ? eventLine.slice(6).trim() : '';

      if (event === 'response.output_item.done' && dataLine) {
        try {
          const parsed = JSON.parse(dataLine.slice(5).trim());
          if (parsed?.item) outputItems.push(parsed.item);
        } catch {
          /* tolerate */
        }
        out += block;
        continue;
      }

      if (event === 'response.completed' && dataLine) {
        try {
          const parsed = JSON.parse(dataLine.slice(5).trim());
          if (parsed?.response && !Array.isArray(parsed.response.output)) {
            parsed.response.output = outputItems;
            const rewritten = block.replace(dataLine, `data: ${JSON.stringify(parsed)}`);
            logger.info(
              `[Codex] injected ${outputItems.length} output items into response.completed ` +
              `(LangChain converter workaround)`,
            );
            out += rewritten;
            continue;
          }
        } catch {
          /* tolerate */
        }
      }

      out += block;
    }

    return encoder.encode(out);
  };
}

/**
 * SSE-aware chunk logger for DEXTER_CODEX_DEBUG=1. Accumulates byte chunks
 * into UTF-8 text, splits on the `\n\n` event boundary, and emits one logger
 * line per event with the event type and a truncated data preview. Helps
 * diagnose cases where LangChain's converter fails (e.g. missing
 * `response.completed`, malformed `response.failed`, etc.).
 */
function makeSseDebugTap(): (chunk: Uint8Array) => void {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buffer = '';
  let eventCount = 0;
  return (chunk) => {
    buffer += decoder.decode(chunk, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      if (!raw.trim()) continue;
      eventCount += 1;
      const eventLine = raw.split('\n').find((l) => l.startsWith('event:'));
      const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
      const event = eventLine ? eventLine.slice(6).trim() : '(none)';
      const dataRaw = dataLine ? dataLine.slice(5).trim() : '';
      // For completed / failed events we need the FULL payload — that's where
      // `response.output` would (or wouldn't) be. Truncate noisy delta events.
      const isImportant = event === 'response.completed' || event === 'response.failed';
      const data = isImportant ? dataRaw : dataRaw.slice(0, 400);
      if (isImportant) {
        try {
          const parsed = JSON.parse(dataRaw);
          const responseKeys = parsed?.response ? Object.keys(parsed.response).sort() : null;
          logger.info(`[Codex DEBUG SSE #${eventCount}] event=${event} response.keys=${JSON.stringify(responseKeys)}`);
        } catch {
          // fall through and dump raw
        }
      }
      logger.info(`[Codex DEBUG SSE #${eventCount}] event=${event} data=${data}`);
    }
  };
}

/**
 * Replace the response body with a passthrough ReadableStream guarded by two
 * watchdogs:
 *   - idle timer: resets on every chunk. Catches truly silent stalls.
 *   - wall timer: never resets. Catches SSE streams that keep dribbling
 *     keep-alives but never terminate, and LangChain parser bugs where the
 *     stream consumer silently spins.
 * Either firing aborts the shared AbortController — underlying body errors,
 * LangChain's stream iterator rejects, agent surfaces a real error.
 *
 * Critical that we use a pull-based ReadableStream (not a TransformStream): a
 * TransformStream's `flush` only fires when upstream closes, which is exactly
 * the case we cannot rely on here. Pull-based gives us control of every read.
 */
function attachStreamWatchdogs(
  response: Response,
  abortController: AbortController,
  idleMs: number,
  wallMs: number,
): Response {
  const reader = response.body!.getReader();
  const debugTap = process.env.DEXTER_CODEX_DEBUG ? makeSseDebugTap() : null;
  // Only enable the rewriter for /responses — `/codex/models` and other JSON
  // endpoints don't need or want SSE munging.
  const isStreamingEndpoint = (response.headers.get('content-type') ?? '').includes('event-stream')
    || isResponsesEndpoint(response.url);
  const rewriter = isStreamingEndpoint ? makeCodexSseRewriter() : null;

  // Pass a named Error as the abort reason so the resulting stream error
  // surfaces *why* it was aborted — formatUserFacingError() falls through to
  // displaying the raw message for unknown errors, so this becomes the
  // user-visible text instead of a generic "aborted" string.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let wallTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    const msg = `[Codex] response stalled — exceeded ${wallMs}ms total elapsed time. The backend may be overloaded or the stream parser failed to terminate.`;
    logger.warn(msg);
    abortController.abort(new Error(msg));
  }, wallMs);

  const startIdle = () => {
    idleTimer = setTimeout(() => {
      const msg = `[Codex] response stalled — no bytes received for ${idleMs}ms.`;
      logger.warn(msg);
      abortController.abort(new Error(msg));
    }, idleMs);
  };
  startIdle();

  const clearAll = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (wallTimer) { clearTimeout(wallTimer); wallTimer = null; }
  };
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    startIdle();
  };

  const wrapped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          clearAll();
          controller.close();
          return;
        }
        resetIdle();
        if (debugTap && value) debugTap(value);
        const forwarded = rewriter && value ? rewriter(value) : value;
        controller.enqueue(forwarded);
      } catch (err) {
        clearAll();
        controller.error(err);
      }
    },
    cancel(reason) {
      clearAll();
      return reader.cancel(reason);
    },
  });

  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
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

  if (!Array.isArray(payload.input)) {
    if (payload.instructions) {
      payload.input = cleanCodexInputItems(payload.input);
      return JSON.stringify(payload);
    }
    return body;
  }

  const input = payload.input as Array<Record<string, unknown>>;

  // Only run the developer→instructions extraction if instructions isn't
  // already set (first turn). On follow-up turns LangChain re-emits the
  // developer message because it lives in the BaseMessage array — pull it
  // back out so we don't send a redundant duplicate alongside instructions.
  const sysIdx = input.findIndex((msg) => {
    const role = msg.role;
    return role === 'developer' || role === 'system';
  });
  if (sysIdx >= 0 && !payload.instructions) {
    payload.instructions = stringifyMessageContent(input[sysIdx].content);
  }
  const withoutSystem = sysIdx >= 0 ? input.filter((_, i) => i !== sysIdx) : input;

  payload.input = cleanCodexInputItems(withoutSystem);

  if (
    payload.text &&
    typeof payload.text === 'object' &&
    Object.keys(payload.text as object).length === 0
  ) {
    delete payload.text;
  }

  return JSON.stringify(payload);
}

/**
 * Strip fields from input items that confuse the Codex backend in stateless
 * (`store: false`) mode:
 *   - `id` on `function_call` / `reasoning` / `message` items: these are
 *     server-side identifiers from the PREVIOUS response. Echoing them back
 *     with `store: false` makes Codex look up something it doesn't have and
 *     return 404 with an empty body.
 *   - `status` on `function_call`: server-side state, not a valid input field.
 *   - empty `reasoning` items (no summary content): just noise.
 * Returns a new array; original input is untouched.
 */
function cleanCodexInputItems(items: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(items)) return [];
  const cleaned: Array<Record<string, unknown>> = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = { ...(raw as Record<string, unknown>) };
    const type = item.type;

    if (type === 'reasoning') {
      const summary = item.summary;
      if (!Array.isArray(summary) || summary.length === 0) {
        continue; // drop empty reasoning items entirely
      }
      delete item.id;
    } else if (type === 'function_call') {
      delete item.id;
      delete item.status;
    } else if (type === 'message') {
      delete item.id;
      delete item.status;
    }
    cleaned.push(item);
  }
  return cleaned;
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

/**
 * Pretty-print a Codex request body for debugging — solves the problem that
 * `tools[]` alone can be 20kB and overwhelms a naive head/tail truncation.
 * Splits the body into top-level keys, summarises bulky ones (`tools`,
 * `instructions`), and dumps the things that actually change between turns
 * (`input`, `model`, `store`) in full so the user can see exactly what they
 * sent.
 */
function logDebugBody(body: string): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    logger.info(`[Codex DEBUG]   body (raw, ${body.length} chars): ${body.slice(0, 2000)}${body.length > 2000 ? '...' : ''}`);
    return;
  }
  const keys = Object.keys(parsed);
  logger.info(`[Codex DEBUG]   body.keys = ${JSON.stringify(keys)}`);
  for (const k of keys) {
    const v = parsed[k];
    if (k === 'tools' && Array.isArray(v)) {
      const names = v.map((t) => (t as { name?: string }).name ?? '?').join(', ');
      logger.info(`[Codex DEBUG]   tools (${v.length}): ${names}`);
    } else if (k === 'instructions' && typeof v === 'string') {
      logger.info(`[Codex DEBUG]   instructions (${v.length} chars): ${v.slice(0, 200)}...`);
    } else {
      const json = JSON.stringify(v, null, 2);
      const truncated = json.length > 4000 ? json.slice(0, 2000) + '\n...[elided]...\n' + json.slice(-2000) : json;
      logger.info(`[Codex DEBUG]   ${k} = ${truncated}`);
    }
  }
}

function isResponsesEndpoint(input: RequestInfo | URL): boolean {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
  return url.includes('/responses');
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
      logger.info(`[Codex DEBUG] → ${init?.method ?? 'GET'} ${url}`);
      if (typeof body === 'string') logDebugBody(body);
      else logger.info('[Codex DEBUG]   body: <non-string body>');
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
      // Empty body 4xx is the worst case — Codex is rejecting silently. Dump
      // the request body we sent so the user can see exactly what shape upset
      // the backend (typically input[] containing function_call_output items).
      logger.error(`[Codex] backend ${response.status} ${response.statusText} with empty body. Request body breakdown:`);
      if (typeof body === 'string') logDebugBody(body);
      else logger.error('[Codex] request body was <non-string body>');
      throw new Error(
        `[Codex] ${response.status} ${response.statusText} (empty body). ` +
        'See logs for the request body that triggered this.',
      );
    }

    // /responses normally comes back as SSE, but the Codex backend often
    // returns an empty/missing content-type header even though the body IS
    // an SSE stream. We can only reliably detect "Codex squeezed an error
    // into the success path" when the response explicitly advertises JSON —
    // otherwise we have to trust the body is SSE (the only way to peek would
    // consume the stream, which we can't do without breaking LangChain).
    if (response.ok && isResponsesEndpoint(input)) {
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      if (contentType.includes('application/json') || contentType.includes('text/plain')) {
        const cloned = response.clone();
        const detail = (await cloned.text().catch(() => '')).slice(0, 600);
        logger.error(
          `[Codex] /responses returned non-SSE content-type '${contentType}': ${detail || '<empty>'}`,
        );
        throw new Error(
          `[Codex] backend returned non-streaming response (content-type: ${contentType}). ` +
            `Body: ${detail || '<empty>'}`,
        );
      }
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
      // Codex 4xx responses are deterministic (auth, validation) — retrying
      // them just multiplies the wait time. Auth refresh is handled inside
      // buildCodexFetch's own 401 retry, so the LangChain/SDK retry loop is
      // pure overhead. 0 disables both.
      maxRetries: 0,
      configuration: {
        baseURL: CODEX_BASE_URL,
        fetch: buildCodexFetch(),
      },
    };
    super(fields);
  }
}
