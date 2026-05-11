/**
 * Shared utilities for financial tools.
 */

/** Sub-tool timeout in milliseconds. Returns partial results on timeout. */
export const SUB_TOOL_TIMEOUT_MS = 15_000;

/** Cache TTL constants. */
export const TTL_15M = 15 * 60 * 1000;
export const TTL_1H = 60 * 60 * 1000;
export const TTL_6H = 6 * 60 * 60 * 1000;
export const TTL_24H = 24 * 60 * 60 * 1000;

/**
 * Detects Taiwan stock tickers. TWSE (上市) tickers are 4 digits like 2330,
 * TPEx (上櫃) tickers may also use 4 digits. Optional `.TW` / `.TWO` suffix
 * is accepted for compatibility with Yahoo-style notation.
 */
export function isTaiwanTicker(ticker: string): boolean {
  return /^\d{4}([.-]TWO?)?$/i.test(ticker.trim());
}

/** Strip any market suffix and return the bare 4-digit code (e.g. "2330"). */
export function normalizeTaiwanTicker(ticker: string): string {
  return ticker.trim().replace(/[.-]TWO?$/i, '').toUpperCase();
}

/**
 * Race a promise against a timeout. Rejects with a descriptive error
 * if the promise doesn't settle within `ms` milliseconds.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label?: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label ?? 'Operation'} timed out after ${ms / 1000}s`)),
        ms,
      ),
    ),
  ]);
}
