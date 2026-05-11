import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { finmind } from './finmind-api.js';
import { formatToolResult } from '../types.js';
import { TTL_24H, normalizeTaiwanTicker } from './utils.js';

const TwDividendsInputSchema = z.object({
  ticker: z
    .string()
    .describe("Taiwan stock ticker (4-digit code, e.g. '2330' for TSMC)."),
  start_date: z
    .string()
    .describe('Earliest record date (YYYY-MM-DD). 5 years back is a typical horizon.'),
  end_date: z.string().optional().describe('Latest record date (YYYY-MM-DD). Defaults to today.'),
});

export const getTwDividends = new DynamicStructuredTool({
  name: 'get_tw_dividends',
  description:
    'Cash and stock dividend history for a Taiwan-listed stock (除權息). Returns each event with cash dividend per share, stock dividend ratio, ex-date, and record date.',
  schema: TwDividendsInputSchema,
  func: async (input) => {
    const params = {
      data_id: normalizeTaiwanTicker(input.ticker),
      start_date: input.start_date,
      end_date: input.end_date ?? new Date().toISOString().slice(0, 10),
    };
    const { data, url } = await finmind.get('TaiwanStockDividend', params, {
      cacheable: true,
      ttlMs: TTL_24H,
    });
    return formatToolResult((data.rows as unknown[]) ?? [], [url]);
  },
});
