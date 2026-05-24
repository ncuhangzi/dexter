import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { finmind } from './finmind-api.js';
import { formatToolResult } from '../types.js';
import { TTL_24H, normalizeTaiwanTicker } from './utils.js';

const TwShareholdingInputSchema = z.object({
  ticker: z
    .string()
    .describe("Taiwan stock ticker (4-digit code, e.g. '2330' for TSMC)."),
  start_date: z.string().describe('Start date (YYYY-MM-DD).'),
  end_date: z.string().optional().describe('End date (YYYY-MM-DD). Defaults to today.'),
});

/**
 * 外資持股比例 — foreign investor ownership stats. Useful for assessing how
 * fully foreign capital has loaded into a stock vs the regulated ceiling.
 */
export const getTwShareholding = new DynamicStructuredTool({
  name: 'get_tw_shareholding',
  description:
    'Daily foreign investor holdings (外資持股) for a Taiwan-listed stock: foreign-held shares, foreign holding %, and the regulated foreign ownership ceiling. Use to gauge how much foreign capital has accumulated and headroom remaining.',
  schema: TwShareholdingInputSchema,
  func: async (input) => {
    const params = {
      data_id: normalizeTaiwanTicker(input.ticker),
      start_date: input.start_date,
      end_date: input.end_date ?? new Date().toISOString().slice(0, 10),
    };
    const { data, url } = await finmind.get('TaiwanStockShareholding', params, {
      cacheable: true,
      ttlMs: TTL_24H,
    });
    return formatToolResult((data.rows as unknown[]) ?? [], [url]);
  },
});
