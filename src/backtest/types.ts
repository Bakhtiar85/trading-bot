/** Shared types for the backtester. Times are epoch milliseconds (UTC). */

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface SimSettings {
  capitalUsdt: number;
  /** Fee per fill as a fraction (0.001 = 0.1%). Charged in USDT value, as with "pay fees in BNB". */
  feeRate: number;
  /** Adverse price move applied to market orders, as a fraction (0.0002 = 0.02%). */
  slippage: number;
  /** Equity loss (%) that triggers a full sell and stops the strategy. 0 disables it. */
  stopLossPercent: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
}

export type TradeSide = 'BUY' | 'SELL';

export interface SimTrade {
  time: number;
  side: TradeSide;
  price: number;
  qty: number;
  fee: number;
  reason: string;
  /** Realized profit of a sell after fees (FIFO against earlier buys); undefined for buys. */
  pnl?: number;
}

export interface StrategyResult {
  name: string;
  description: string;
  finalEquity: number;
  maxDrawdownPercent: number;
  trades: SimTrade[];
  feesPaid: number;
  /** Fraction of candles that ended with BTC held. */
  timeInMarket: number;
  /** Final state: RUNNING, or e.g. "STOPPED (stop-loss) at <time>". */
  endState: string;
  error?: string;
}
