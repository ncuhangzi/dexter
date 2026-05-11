import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { finmind } from './finmind-api.js';
import { formatToolResult } from '../types.js';
import { TTL_1H, TTL_24H, normalizeTaiwanTicker } from './utils.js';

const TwStockPriceInputSchema = z.object({
  ticker: z
    .string()
    .describe("Taiwan stock ticker (4-digit code, e.g. '2330' for TSMC, '0050' for the 0050 ETF)."),
});

/**
 * Latest daily OHLCV for a Taiwan stock. FinMind has no point-in-time snapshot
 * endpoint, so we fetch the most recent ~10-day window and return the latest row.
 * 1h TTL is enough during a trading day; daily settle is final after close.
 */
export const getTwStockPrice = new DynamicStructuredTool({
  name: 'get_tw_stock_price',
  description:
    'Latest daily price snapshot for a Taiwan-listed stock (TWSE/TPEx). Returns the most recent OHLCV bar — open, high, low, close, volume, and trading value.',
  schema: TwStockPriceInputSchema,
  func: async (input) => {
    const ticker = normalizeTaiwanTicker(input.ticker);
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 10);
    const params = {
      data_id: ticker,
      start_date: start.toISOString().slice(0, 10),
      end_date: today.toISOString().slice(0, 10),
    };
    const { data, url } = await finmind.get('TaiwanStockPrice', params, {
      cacheable: true,
      ttlMs: TTL_1H,
    });
    const rows = (data.rows as unknown[]) || [];
    const latest = rows.length > 0 ? rows[rows.length - 1] : null;
    return formatToolResult(latest ?? {}, [url]);
  },
});

const TwStockPricesInputSchema = z.object({
  ticker: z
    .string()
    .describe("Taiwan stock ticker (4-digit code, e.g. '2330' for TSMC)."),
  start_date: z.string().describe('Start date in YYYY-MM-DD format. Required.'),
  end_date: z.string().describe('End date in YYYY-MM-DD format. Required.'),
});

export const getTwStockPrices = new DynamicStructuredTool({
  name: 'get_tw_stock_prices',
  description:
    'Historical daily prices for a Taiwan-listed stock (TWSE/TPEx) over a date range. Returns OHLCV bars.',
  schema: TwStockPricesInputSchema,
  func: async (input) => {
    const params = {
      data_id: normalizeTaiwanTicker(input.ticker),
      start_date: input.start_date,
      end_date: input.end_date,
    };
    const endDate = new Date(input.end_date + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // Closed historical windows are immutable — cache for a day.
    const { data, url } = await finmind.get('TaiwanStockPrice', params, {
      cacheable: endDate < today,
      ttlMs: TTL_24H,
    });
    return formatToolResult((data.rows as unknown[]) || [], [url]);
  },
});
