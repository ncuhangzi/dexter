import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { finmind } from './finmind-api.js';
import { formatToolResult } from '../types.js';
import { TTL_24H, normalizeTaiwanTicker } from './utils.js';

const TwInstitutionalInputSchema = z.object({
  ticker: z
    .string()
    .describe("Taiwan stock ticker (4-digit code, e.g. '2330' for TSMC)."),
  start_date: z.string().describe('Start date in YYYY-MM-DD format.'),
  end_date: z.string().optional().describe('End date in YYYY-MM-DD format. Defaults to today.'),
});

/**
 * 三大法人 (foreign investors / investment trusts / dealers) buy-sell records.
 * Returns daily net flows per institution category.
 */
export const getTwInstitutionalTrades = new DynamicStructuredTool({
  name: 'get_tw_institutional_trades',
  description:
    "Daily 三大法人 (Foreign_Investor, Investment_Trust, Dealer) buy/sell activity for a Taiwan-listed stock. Each row is one institution's daily net buy-sell shares and value.",
  schema: TwInstitutionalInputSchema,
  func: async (input) => {
    const params = {
      data_id: normalizeTaiwanTicker(input.ticker),
      start_date: input.start_date,
      end_date: input.end_date ?? new Date().toISOString().slice(0, 10),
    };
    const { data, url } = await finmind.get('TaiwanStockInstitutionalInvestorsBuySell', params, {
      cacheable: true,
      ttlMs: TTL_24H,
    });
    return formatToolResult((data.rows as unknown[]) ?? [], [url]);
  },
});
