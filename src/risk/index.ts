/**
 * Hard-coded safety rules. Plain if/else logic only — no network calls, no LLM involvement.
 * The bot loop acts on the decision returned here.
 */
import type { BotStatus, GridConfig, Ledger, RiskConfig, RiskDecision } from '../types';

export { StateStore, createInitialState } from './state';

/** Current value (in USDT) of the funds the bot manages. */
export function computeEquity(ledger: Ledger, price: number): number {
  return ledger.quote + ledger.base * price;
}

/** Percentage lost relative to the allocated capital. Negative when in profit. */
export function computeDrawdownPercent(capitalUsdt: number, equity: number): number {
  return ((capitalUsdt - equity) / capitalUsdt) * 100;
}

export function breakoutDirection(price: number, grid: GridConfig): 'ABOVE' | 'BELOW' | null {
  if (price > grid.upperBound) return 'ABOVE';
  if (price < grid.lowerBound) return 'BELOW';
  return null;
}

export interface LedgerCheck {
  /** Coins the ledger says the bot holds but the account doesn't have (>= 0). */
  baseShortfall: number;
  /** USDT the ledger says the bot holds but the account doesn't have (>= 0). */
  quoteShortfall: number;
  /** Both shortfalls valued in USDT at the current price. */
  shortfallUsdt: number;
  toleranceUsdt: number;
  exceeded: boolean;
}

/**
 * Compare the bot's ledger with the account's actual balances (free + locked). Only a SHORTFALL
 * counts: the account may legitimately hold more than the bot manages (your other funds, BNB-paid
 * fees leaving extra coins), but it must never hold less than the ledger claims. Each asset is
 * checked separately so a surplus in one can't hide a shortfall in the other.
 *
 * Tolerance: the larger of 0.50 USDT and 1% of capital, which absorbs fee-estimate and rounding
 * drift without hiding a missed fill (a single slot is typically ~10% of capital).
 */
export function checkLedgerAgainstAccount(
  ledger: Ledger,
  account: { base: number; quote: number },
  price: number,
  capitalUsdt: number,
): LedgerCheck {
  const baseShortfall = Math.max(0, ledger.base - account.base);
  const quoteShortfall = Math.max(0, ledger.quote - account.quote);
  const shortfallUsdt = baseShortfall * price + quoteShortfall;
  const toleranceUsdt = Math.max(0.5, capitalUsdt * 0.01);
  return { baseShortfall, quoteShortfall, shortfallUsdt, toleranceUsdt, exceeded: shortfallUsdt > toleranceUsdt };
}

export interface RiskInput {
  price: number;
  ledger: Ledger;
  grid: GridConfig;
  risk: RiskConfig;
  status: BotStatus;
  /** True if a BREAKOUT_ALERT (alert-only mode) was already sent for the current excursion. */
  breakoutAlertActive: boolean;
}

/**
 * Evaluate the safety rules in priority order:
 *   1. Stop-loss (applies while RUNNING *and* PAUSED — a paused bot can still hold coins that keep
 *      falling, and liquidating them is protective, not a resumption of trading).
 *   2. Breakout (only while RUNNING).
 * A STOPPED bot never produces further actions.
 */
export function evaluateRisk(input: RiskInput): RiskDecision {
  const { price, ledger, grid, risk, status } = input;
  if (status === 'STOPPED') return { action: 'NONE' };

  const equity = computeEquity(ledger, price);
  const drawdownPercent = computeDrawdownPercent(grid.capitalUsdt, equity);
  if (drawdownPercent >= risk.stopLossPercent) {
    return { action: 'STOP_LOSS', drawdownPercent, equity };
  }

  if (status !== 'RUNNING') return { action: 'NONE' };

  const direction = breakoutDirection(price, grid);
  if (direction === null) return { action: 'NONE' };
  if (risk.breakoutPause) return { action: 'BREAKOUT_PAUSE', direction };
  if (!input.breakoutAlertActive) return { action: 'BREAKOUT_ALERT', direction };
  return { action: 'NONE' };
}
