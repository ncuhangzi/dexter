import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { finmind } from './finmind-api.js';
import { formatToolResult } from '../types.js';
import { normalizeTaiwanTicker } from './utils.js';

const TwSnapshotInputSchema = z.object({
  ticker: z
    .string()
    .describe(
      "Taiwan stock ticker (4-digit code, e.g. '2330' for TSMC). Also accepts 3-digit index codes such as '001' (TAIEX) and '031' (financial sector).",
    ),
});

/**
 * 即時盤價 — intraday tick snapshot. FinMind dataset is `taiwan_stock_tick_snapshot`
 * and is gated to the Sponsor tier — if the caller's token lacks access, the API
 * returns an auth/permission error which we surface as-is so the agent can fall
 * back to `get_tw_stock_price` (latest daily bar).
 *
 * Never cache — the whole point is liveness during trading hours.
 */
export const getTwStockSnapshot = new DynamicStructuredTool({
  name: 'get_tw_stock_snapshot',
  description:
    'Real-time intraday quote (即時盤價) for a Taiwan-listed stock: latest deal price, best bid/ask, intraday OHLC, accumulated volume. Use during trading hours when the user asks about "現價/即時/盤中/now". Requires FinMind Sponsor tier — if it fails with permission error, fall back to get_tw_stock_price for the latest daily close.',
  schema: TwSnapshotInputSchema,
  func: async (input) => {
    const params = { data_id: normalizeTaiwanTicker(input.ticker) };
    // Never cache — must be live.
    const { data, url } = await finmind.get('taiwan_stock_tick_snapshot', params);
    const rows = (data.rows as unknown[]) || [];
    const snapshot = rows.length > 0 ? rows[0] : null;
    return formatToolResult(snapshot ?? {}, [url]);
  },
});
