import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { finmind } from './finmind-api.js';
import { formatToolResult } from '../types.js';
import { TTL_24H, normalizeTaiwanTicker } from './utils.js';

const TwMarginInputSchema = z.object({
  ticker: z
    .string()
    .describe("Taiwan stock ticker (4-digit code, e.g. '2330' for TSMC)."),
  start_date: z.string().describe('Start date in YYYY-MM-DD format.'),
  end_date: z.string().optional().describe('End date in YYYY-MM-DD format. Defaults to today.'),
});

/**
 * 融資融券 — daily margin purchase / short sale balances.
 * Useful for sentiment / leverage analysis on TW stocks.
 */
export const getTwMargin = new DynamicStructuredTool({
  name: 'get_tw_margin',
  description:
    'Daily 融資融券 (margin purchase and short sale) balances for a Taiwan-listed stock. Returns margin buy/sell volumes, short volumes, and outstanding balances.',
  schema: TwMarginInputSchema,
  func: async (input) => {
    const params = {
      data_id: normalizeTaiwanTicker(input.ticker),
      start_date: input.start_date,
      end_date: input.end_date ?? new Date().toISOString().slice(0, 10),
    };
    const { data, url } = await finmind.get('TaiwanStockMarginPurchaseShortSale', params, {
      cacheable: true,
      ttlMs: TTL_24H,
    });
    return formatToolResult((data.rows as unknown[]) ?? [], [url]);
  },
});
