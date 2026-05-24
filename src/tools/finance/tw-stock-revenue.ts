import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { finmind } from './finmind-api.js';
import { formatToolResult } from '../types.js';
import { TTL_24H, normalizeTaiwanTicker } from './utils.js';

const TwMonthRevenueInputSchema = z.object({
  ticker: z
    .string()
    .describe("Taiwan stock ticker (4-digit code, e.g. '2330' for TSMC)."),
  start_date: z
    .string()
    .describe('Earliest reporting month (YYYY-MM-DD). 2-3 years back covers 24-36 data points.'),
  end_date: z.string().optional().describe('Latest reporting month (YYYY-MM-DD). Defaults to today.'),
});

/**
 * 月營收 — monthly revenue disclosures. Critical leading indicator for
 * Taiwan-listed companies; YoY/MoM growth is what investors react to.
 */
export const getTwMonthlyRevenue = new DynamicStructuredTool({
  name: 'get_tw_monthly_revenue',
  description:
    'Monthly revenue (月營收) for a Taiwan-listed company. Each row has the month, revenue, YoY growth %, MoM growth %, and cumulative YoY. Use this for revenue momentum and growth trend analysis — TW companies disclose monthly, US companies do not.',
  schema: TwMonthRevenueInputSchema,
  func: async (input) => {
    const params = {
      data_id: normalizeTaiwanTicker(input.ticker),
      start_date: input.start_date,
      end_date: input.end_date ?? new Date().toISOString().slice(0, 10),
    };
    const { data, url } = await finmind.get('TaiwanStockMonthRevenue', params, {
      cacheable: true,
      ttlMs: TTL_24H,
    });
    return formatToolResult((data.rows as unknown[]) ?? [], [url]);
  },
});
