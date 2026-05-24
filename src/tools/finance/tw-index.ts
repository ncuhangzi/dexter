import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { finmind } from './finmind-api.js';
import { formatToolResult } from '../types.js';
import { TTL_1H, TTL_24H } from './utils.js';

const TwIndexInputSchema = z.object({
  index: z
    .enum(['TAIEX', 'TPEx'])
    .default('TAIEX')
    .describe("Which Taiwan market index — 'TAIEX' (上市加權) or 'TPEx' (上櫃指數)."),
  start_date: z.string().describe('Start date (YYYY-MM-DD).'),
  end_date: z.string().optional().describe('End date (YYYY-MM-DD). Defaults to today.'),
});

/**
 * Taiwan benchmark return index. Use sparingly — typically once per query when
 * the user asks about overall market direction, or when sizing a single stock's
 * move relative to the broad market.
 */
export const getTwIndexPrice = new DynamicStructuredTool({
  name: 'get_tw_index_price',
  description:
    'Taiwan market index (加權指數 TAIEX / 上櫃指數 TPEx) historical levels via TaiwanStockTotalReturnIndex. Use for overall market direction or to contextualize a single stock\'s performance vs the broad market.',
  schema: TwIndexInputSchema,
  func: async (input) => {
    const params = {
      data_id: input.index,
      start_date: input.start_date,
      end_date: input.end_date ?? new Date().toISOString().slice(0, 10),
    };
    const endDate = new Date(params.end_date + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // Closed historical = stable; open today = 1h freshness during trading.
    const { data, url } = await finmind.get('TaiwanStockTotalReturnIndex', params, {
      cacheable: true,
      ttlMs: endDate < today ? TTL_24H : TTL_1H,
    });
    return formatToolResult((data.rows as unknown[]) ?? [], [url]);
  },
});
