/**
 * Grid strategy, simulated with the live bot's own planning and risk code (src/grid, src/risk).
 *
 * Fill model: a resting limit buy fills when a candle's low touches its price, a limit sell when
 * the high does, at the limit price. Like the live bot (one check per minute), each slot fills at
 * most once per candle; the opposite order is in place from the next candle.
 */
import { computeGridPlan, initialBuyQuantity, initialSides } from '../../grid';
import { evaluateRisk } from '../../risk';
import type { BotStatus, GridConfig, RiskConfig, Side, SymbolFilters } from '../../types';
import { SimAccount } from '../account';
import type { Candle, SimSettings, StrategyResult } from '../types';

export interface GridParams {
  lowerBound: number;
  upperBound: number;
  levels: number;
  /** false = live behaviour (pause, keep coins); true = sell everything when price breaks below. */
  exitOnDownBreak: boolean;
  filters: SymbolFilters;
}

interface SimSlot {
  buyPrice: number;
  sellPrice: number;
  quantity: number;
  side: Side;
}

const iso = (t: number): string => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

export function runGrid(
  candles: Candle[],
  settings: SimSettings,
  params: GridParams,
  name: string,
  description: string,
): StrategyResult {
  const acct = new SimAccount(settings);
  const result = (endState: string, error?: string): StrategyResult => ({
    name,
    description,
    finalEquity: acct.lastEquity,
    maxDrawdownPercent: acct.maxDrawdownPercent,
    trades: acct.trades,
    feesPaid: acct.feesPaid,
    timeInMarket: acct.timeInMarket(),
    endState,
    ...(error ? { error } : {}),
  });

  const first = candles[0];
  if (!first) return result('NO DATA');

  const grid: GridConfig = {
    symbol: params.filters.symbol,
    lowerBound: params.lowerBound,
    upperBound: params.upperBound,
    levels: params.levels,
    capitalUsdt: settings.capitalUsdt,
  };
  // The live rule treats 0 as "always triggered"; here 0 means "disabled".
  const risk: RiskConfig = {
    stopLossPercent: settings.stopLossPercent > 0 ? settings.stopLossPercent : Number.POSITIVE_INFINITY,
    breakoutPause: true,
  };

  let plan;
  try {
    plan = computeGridPlan(grid, params.filters);
  } catch (err) {
    return result('NOT STARTED', err instanceof Error ? err.message : String(err));
  }

  let status: BotStatus = 'RUNNING';
  let endState = 'RUNNING';
  let slots: SimSlot[] = [];

  const startPrice = first.open;
  if (startPrice < grid.lowerBound || startPrice > grid.upperBound) {
    status = 'PAUSED';
    endState = `PAUSED at start (price ${startPrice} outside range)`;
  } else {
    const sides = initialSides(plan, startPrice);
    const initQty = initialBuyQuantity(plan, sides, params.filters.stepSize);
    if (initQty > 0) acct.buy(first.openTime, startPrice * (1 + settings.slippage), initQty, 'initial buy for sell-side slots');
    slots = plan.slots.map((s, i) => ({ buyPrice: s.buyPrice, sellPrice: s.sellPrice, quantity: s.quantity, side: sides[i] ?? 'BUY' }));
  }

  let pendingSell: string | null = null;

  for (const c of candles) {
    if (pendingSell) {
      acct.marketSellAll(c.openTime, c.open, pendingSell);
      pendingSell = null;
    }

    if (status === 'RUNNING') {
      slots.forEach((slot, i) => {
        if (slot.side === 'BUY' && c.low <= slot.buyPrice) {
          if (acct.buy(c.openTime, slot.buyPrice, slot.quantity, `grid buy (slot ${i})`)) slot.side = 'SELL';
        } else if (slot.side === 'SELL' && c.high >= slot.sellPrice) {
          if (acct.sell(c.openTime, slot.sellPrice, slot.quantity, `grid sell (slot ${i})`)) slot.side = 'BUY';
        }
      });
    }

    acct.mark(c.close);
    if (status === 'STOPPED') continue;

    const decision = evaluateRisk({
      price: c.close,
      // Fees are paid outside the traded balances (BNB); count them against equity like the account does.
      ledger: { quote: acct.quote - acct.feesPaid, base: acct.base, realizedTrades: 0 },
      grid,
      risk,
      status,
      breakoutAlertActive: false,
    });

    if (decision.action === 'STOP_LOSS') {
      status = 'STOPPED';
      pendingSell = 'stop-loss';
      endState = `STOPPED (stop-loss, ${decision.drawdownPercent.toFixed(1)}%) at ${iso(c.openTime)}`;
    } else if (decision.action === 'BREAKOUT_PAUSE') {
      if (params.exitOnDownBreak && decision.direction === 'BELOW') {
        status = 'STOPPED';
        pendingSell = 'sold on breakout below range';
        endState = `STOPPED (sold on break below range) at ${iso(c.openTime)}`;
      } else {
        status = 'PAUSED';
        endState = `PAUSED (break ${decision.direction.toLowerCase()} range) at ${iso(c.openTime)}`;
      }
    }
  }

  return result(endState);
}
