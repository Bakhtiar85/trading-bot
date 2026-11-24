/**
 * Structure-break strategy (long-only spot): buy when a candle closes above the most recent swing
 * high, sell when one closes below the most recent swing low.
 *
 * A swing high is a candle whose high is strictly above the highs of the `n` candles on each side
 * (a swing low likewise for lows). It can only be known `n` candles later, so the tracker confirms
 * swings with that delay and never looks at future candles.
 */
import { isBucketClose } from '../data';
import { SimAccount } from '../account';
import type { Candle, SimSettings, StrategyResult } from '../types';

export interface StructureEvent {
  bullishBreak: boolean;
  bearishBreak: boolean;
}

export class StructureTracker {
  private window: Candle[] = [];
  private swingHigh: number | null = null;
  private swingLow: number | null = null;
  /** Each swing level triggers at most one break, so a held breakout doesn't re-signal every candle. */
  private highBroken = false;
  private lowBroken = false;

  constructor(readonly n: number) {
    if (!Number.isInteger(n) || n < 1) throw new Error('Swing size must be an integer >= 1');
  }

  /** Feed the next closed candle; returns whether it broke structure. */
  push(c: Candle): StructureEvent {
    this.window.push(c);
    if (this.window.length > 2 * this.n + 1) this.window.shift();

    // With a full window, the middle candle now has `n` candles on each side: confirm it.
    if (this.window.length === 2 * this.n + 1) {
      const mid = this.window[this.n] as Candle;
      const others = this.window.filter((_, i) => i !== this.n);
      if (others.every((o) => mid.high > o.high)) {
        this.swingHigh = mid.high;
        this.highBroken = false;
      }
      if (others.every((o) => mid.low < o.low)) {
        this.swingLow = mid.low;
        this.lowBroken = false;
      }
    }

    const event: StructureEvent = { bullishBreak: false, bearishBreak: false };
    if (this.swingHigh !== null && !this.highBroken && c.close > this.swingHigh) {
      event.bullishBreak = true;
      this.highBroken = true;
    }
    if (this.swingLow !== null && !this.lowBroken && c.close < this.swingLow) {
      event.bearishBreak = true;
      this.lowBroken = true;
    }
    return event;
  }
}

const iso = (t: number): string => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

/**
 * Run the strategy on `timeframeMinutes` candles built from the 1-minute series. Signals are taken
 * when a timeframe candle closes and executed at the next minute's open; the stop-loss is checked
 * every minute, like the live bot.
 */
export function runStructure(
  candles: Candle[],
  settings: SimSettings,
  timeframeMinutes: number,
  swingSize: number,
  name: string,
  description: string,
): StrategyResult {
  const acct = new SimAccount(settings);
  const tracker = new StructureTracker(swingSize);
  const bucketMs = timeframeMinutes * 60_000;
  let bucket: Candle | null = null;
  let pending: { side: 'BUY' | 'SELL'; reason: string } | null = null;
  let stopped = false;
  let endState = 'RUNNING';
  const holding = (): boolean => acct.base >= settings.minQty;

  for (const c of candles) {
    if (pending) {
      if (pending.side === 'BUY') acct.marketBuy(c.openTime, c.open, pending.reason);
      else acct.marketSellAll(c.openTime, c.open, pending.reason);
      pending = null;
    }

    // Build the timeframe candle; start a fresh one if this minute belongs to a new bucket (gaps).
    if (bucket === null || Math.floor(bucket.openTime / bucketMs) !== Math.floor(c.openTime / bucketMs)) {
      bucket = { ...c };
    } else {
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
    }

    if (isBucketClose(c.openTime, timeframeMinutes)) {
      const event = tracker.push(bucket);
      bucket = null;
      if (!stopped) {
        if (!holding() && event.bullishBreak) pending = { side: 'BUY', reason: `bullish structure break (${timeframeMinutes}m)` };
        else if (holding() && event.bearishBreak) pending = { side: 'SELL', reason: `bearish structure break (${timeframeMinutes}m)` };
      }
    }

    const equity = acct.mark(c.close);
    if (!stopped && acct.stopLossHit(equity)) {
      stopped = true;
      pending = holding() ? { side: 'SELL', reason: 'stop-loss' } : null;
      endState = `STOPPED (stop-loss) at ${iso(c.openTime)}`;
    }
  }

  return {
    name,
    description,
    finalEquity: acct.lastEquity,
    maxDrawdownPercent: acct.maxDrawdownPercent,
    trades: acct.trades,
    feesPaid: acct.feesPaid,
    timeInMarket: acct.timeInMarket(),
    endState,
  };
}
