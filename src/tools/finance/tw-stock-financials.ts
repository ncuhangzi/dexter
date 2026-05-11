import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { finmind } from './finmind-api.js';
import { formatToolResult } from '../types.js';
import { TTL_24H, normalizeTaiwanTicker } from './utils.js';

/**
 * FinMind exposes the three statements as separate datasets.
 * Each row is keyed by `date` (report period end) + `type` (account name) + `value`.
 */
const STATEMENT_DATASETS = {
  income: 'TaiwanStockFinancialStatements',
  balance: 'TaiwanStockBalanceSheet',
  cashflow: 'TaiwanStockCashFlowsStatement',
} as const;

const TwFinancialsInputSchema = z.object({
  ticker: z
    .string()
    .describe("Taiwan stock ticker (4-digit code, e.g. '2330' for TSMC)."),
  statement: z
    .enum(['income', 'balance', 'cashflow', 'all'])
    .default('income')
    .describe(
      "Which statement to fetch. 'income' for 損益表, 'balance' for 資產負債表, 'cashflow' for 現金流量表, 'all' for every statement.",
    ),
  start_date: z
    .string()
    .describe(
      "Earliest report date (YYYY-MM-DD). FinMind reports are quarterly; 5 years back covers 20 quarters.",
    ),
  end_date: z
    .string()
    .optional()
    .describe('Latest report date (YYYY-MM-DD). Defaults to today.'),
});

async function fetchStatement(
  dataset: string,
  data_id: string,
  start_date: string,
  end_date: string,
) {
  return finmind.get(
    dataset,
    { data_id, start_date, end_date },
    { cacheable: true, ttlMs: TTL_24H },
  );
}

export const getTwFinancials = new DynamicStructuredTool({
  name: 'get_tw_financials',
  description:
    'Quarterly financial statements (損益表 / 資產負債表 / 現金流量表) for a Taiwan-listed company. Use `statement: "all"` to fetch all three at once.',
  schema: TwFinancialsInputSchema,
  func: async (input) => {
    const ticker = normalizeTaiwanTicker(input.ticker);
    const end_date = input.end_date ?? new Date().toISOString().slice(0, 10);

    if (input.statement === 'all') {
      const [income, balance, cashflow] = await Promise.all([
        fetchStatement(STATEMENT_DATASETS.income, ticker, input.start_date, end_date),
        fetchStatement(STATEMENT_DATASETS.balance, ticker, input.start_date, end_date),
        fetchStatement(STATEMENT_DATASETS.cashflow, ticker, input.start_date, end_date),
      ]);
      return formatToolResult(
        {
          income: income.data.rows ?? [],
          balance: balance.data.rows ?? [],
          cashflow: cashflow.data.rows ?? [],
        },
        [income.url, balance.url, cashflow.url],
      );
    }

    const dataset = STATEMENT_DATASETS[input.statement];
    const { data, url } = await fetchStatement(dataset, ticker, input.start_date, end_date);
    return formatToolResult((data.rows as unknown[]) ?? [], [url]);
  },
});
