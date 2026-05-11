import { readCache, writeCache, describeRequest } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';

const BASE_URL = 'https://api.finmindtrade.com/api/v4/data';

export interface FinMindResponse {
  data: Record<string, unknown>;
  url: string;
}

export interface FinMindParams {
  data_id?: string;
  start_date?: string;
  end_date?: string;
  [key: string]: string | number | undefined;
}

function getApiToken(): string {
  return process.env.FINMIND_API_TOKEN || '';
}

/**
 * Issue a GET against FinMind's `data` endpoint. FinMind returns
 * `{ msg, status, data: [...] }`; we wrap it as `{ data: { rows: [...] }, url }`
 * so callers can treat it like the existing Financial Datasets API helper.
 */
async function executeRequest(url: string, label: string): Promise<Record<string, unknown>> {
  const token = getApiToken();
  if (!token) {
    logger.warn(`[FinMind API] call without token: ${label} — set FINMIND_API_TOKEN`);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[FinMind API] network error: ${label} — ${message}`);
    throw new Error(`[FinMind API] request failed for ${label}: ${message}`);
  }

  if (!response.ok) {
    const detail = `${response.status} ${response.statusText}`;
    logger.error(`[FinMind API] error: ${label} — ${detail}`);
    throw new Error(`[FinMind API] request failed: ${detail}`);
  }

  const payload = (await response.json().catch(() => {
    const detail = `invalid JSON (${response.status} ${response.statusText})`;
    logger.error(`[FinMind API] parse error: ${label} — ${detail}`);
    throw new Error(`[FinMind API] request failed: ${detail}`);
  })) as { msg?: string; status?: number; data?: unknown };

  // FinMind reports auth/quota issues with status != 200 in the body even on HTTP 200.
  if (payload.status !== undefined && payload.status !== 200) {
    const msg = payload.msg ?? 'unknown error';
    logger.error(`[FinMind API] body error: ${label} — ${msg}`);
    throw new Error(`[FinMind API] request failed: ${msg}`);
  }

  return { rows: Array.isArray(payload.data) ? payload.data : [] };
}

export const finmind = {
  async get(
    dataset: string,
    params: FinMindParams,
    options?: { cacheable?: boolean; ttlMs?: number },
  ): Promise<FinMindResponse> {
    // Use a `/finmind/{dataset}/` pseudo-endpoint so cache files live
    // alongside Financial Datasets responses but in their own subtree.
    // Surface `data_id` as `ticker` so the cache filename and log labels
    // include the symbol (matches the convention in src/utils/cache.ts).
    const endpoint = `/finmind/${dataset}/`;
    const cacheKey: Record<string, string | number | undefined> = {
      ...params,
      ticker: params.data_id,
    };
    const label = describeRequest(endpoint, cacheKey);

    if (options?.cacheable) {
      const cached = readCache(endpoint, cacheKey, options.ttlMs);
      if (cached) {
        return cached;
      }
    }

    const url = new URL(BASE_URL);
    url.searchParams.set('dataset', dataset);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    const data = await executeRequest(url.toString(), label);

    if (options?.cacheable) {
      writeCache(endpoint, cacheKey, data, url.toString());
    }

    return { data, url: url.toString() };
  },
};
