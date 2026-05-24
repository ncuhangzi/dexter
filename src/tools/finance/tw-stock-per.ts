import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { finmind } from './finmind-api.js';
import { formatToolResult } from '../types.js';
import { TTL_24H, normalizeTaiwanTicker } from './utils.js';

const TwPerInputSchema = z.object({
  ticker: z
    .string()
    .describe("Taiwan stock ticker (4-digit code, e.g. '2330' for TSMC)."),
  start_date: z.string().describe('Start date (YYYY-MM-DD).'),
  end_date: z.string().optional().describe('End date (YYYY-MM-DD). Defaults to today.'),
});

/**
 * Daily 本益比 (P/E) / 股價淨值比 (P/B) / 現金殖利率 (dividend yield) time series.
 * Use this for valuation history — "is the stock cheap vs its own history?".
 */
export const getTwStockPer = new DynamicStructuredTool({
  name: 'get_tw_stock_per',
  description:
    'Daily 本益比 (P/E), 股價淨值比 (P/B), and 現金殖利率 (dividend yield) for a Taiwan-listed stock. Use for valuation history — comparing current multiples to the stock\'s own historical range.',
  schema: TwPerInputSchema,
  func: async (input) => {
    const params = {
      data_id: normalizeTaiwanTicker(input.ticker),
      start_date: input.start_date,
      end_date: input.end_date ?? new Date().toISOString().slice(0, 10),
    };
    const { data, url } = await finmind.get('TaiwanStockPER', params, {
      cacheable: true,
      ttlMs: TTL_24H,
    });
    return formatToolResult((data.rows as unknown[]) ?? [], [url]);
  },
});
