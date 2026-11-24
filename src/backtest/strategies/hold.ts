/** Baseline: buy with all capital at the first candle and hold to the end. No stop-loss. */
import { SimAccount } from '../account';
import type { Candle, SimSettings, StrategyResult } from '../types';

export function runHold(candles: Candle[], settings: SimSettings, name: string, description: string): StrategyResult {
  const acct = new SimAccount(settings);
  const first = candles[0];
  if (first) acct.marketBuy(first.openTime, first.open, 'buy and hold');
  for (const c of candles) acct.mark(c.close);
  return {
    name,
    description,
    finalEquity: acct.lastEquity,
    maxDrawdownPercent: acct.maxDrawdownPercent,
    trades: acct.trades,
    feesPaid: acct.feesPaid,
    timeInMarket: acct.timeInMarket(),
    endState: 'HOLDING',
  };
}
