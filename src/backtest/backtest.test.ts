import { describe, expect, it } from 'vitest';
import type { SymbolFilters } from '../types';
import { SimAccount } from './account';
import { findGaps, isBucketClose } from './data';
import { computeStats } from './report';
import { runGrid } from './strategies/grid';
import { runHold } from './strategies/hold';
import { runStructure, StructureTracker } from './strategies/structure';
import type { Candle, SimSettings } from './types';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 13, 0, 0);

const settings: SimSettings = {
  capitalUsdt: 40,
  feeRate: 0.001,
  slippage: 0,
  stopLossPercent: 15,
  stepSize: 0.00001,
  minQty: 0.00001,
  minNotional: 5,
};

const filters: SymbolFilters = {
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  tickSize: 0.01,
  stepSize: 0.00001,
  minQty: 0.00001,
  minNotional: 5,
};

/** One 1-minute candle per price, with a small range around it. */
function path(prices: number[], spread = 10): Candle[] {
  return prices.map((p, i) => ({ openTime: T0 + i * MIN, open: p, high: p + spread, low: p - spread, close: p }));
}

/** Linear move from a to b over `steps` minutes. */
const ramp = (a: number, b: number, steps: number): number[] => Array.from({ length: steps }, (_, i) => a + ((b - a) * i) / (steps - 1));

/** Deterministic pseudo-random walk (no Math.random, so tests are repeatable). */
function walk(n: number, seed = 7): Candle[] {
  let s = seed;
  let price = 60000;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const r = s / 2147483648 - 0.5;
    const open = price;
    price = Math.max(1000, price + r * 400);
    out.push({ openTime: T0 + i * MIN, open, high: Math.max(open, price) + Math.abs(r) * 150, low: Math.min(open, price) - Math.abs(r) * 150, close: price });
  }
  return out;
}

describe('StructureTracker', () => {
  it('confirms a swing high only after n candles and signals a close above it once', () => {
    const t = new StructureTracker(2);
    // highs: 10 11 15 12 11 -> swing high 15 confirmed on the 5th candle
    const highs = [10, 11, 15, 12, 11, 13, 16, 17];
    const events = highs.map((h, i) => t.push({ openTime: i, open: h - 1, high: h, low: h - 2, close: h - 0.5 }));
    expect(events.slice(0, 6).some((e) => e.bullishBreak)).toBe(false);
    expect(events[6]?.bullishBreak).toBe(true); // close 15.5 > 15
    expect(events[7]?.bullishBreak).toBe(false); // same swing level never signals twice
  });

  it('never uses future candles: signals up to k are identical whatever comes after k', () => {
    const candles = walk(600);
    const full = new StructureTracker(2);
    const fullEvents = candles.map((c) => full.push(c));

    for (const k of [10, 57, 200, 431, 599]) {
      // Same history up to k, then a completely different future.
      const altered = candles.map((c, i) => (i <= k ? c : { ...c, high: c.high * 3, low: c.low / 3, close: c.close * 2 }));
      const t = new StructureTracker(2);
      const altEvents = altered.map((c) => t.push(c));
      expect(altEvents.slice(0, k + 1)).toEqual(fullEvents.slice(0, k + 1));
    }
  });

  it('rejects an invalid swing size', () => {
    expect(() => new StructureTracker(0)).toThrow();
  });
});

describe('SimAccount', () => {
  it('applies lot rounding, minimum order size and fees, and computes FIFO profit', () => {
    const a = new SimAccount(settings);
    expect(a.buy(T0, 60000, 0.00005, 'too small')).toBe(false); // $3 < $5 minimum
    expect(a.buy(T0, 60000, 0.000129, 'buy')).toBe(true); // rounds down to 0.00012
    expect(a.base).toBeCloseTo(0.00012, 10);
    expect(a.quote).toBeCloseTo(40 - 7.2, 8);
    expect(a.sell(T0 + MIN, 66000, 1, 'sell')).toBe(true); // capped at holdings
    const sell = a.trades.at(-1);
    // proceeds 7.92 - sell fee 0.00792 - cost (7.2 + buy fee 0.0072)
    expect(sell?.pnl).toBeCloseTo(7.92 - 0.00792 - 7.2072, 8);
    expect(a.equityAt(66000)).toBeCloseTo(40 + 0.72 - 0.0072 - 0.00792, 8);
  });

  it('tracks max drawdown from the peak', () => {
    const a = new SimAccount(settings);
    a.marketBuy(T0, 50000, 'all in');
    a.mark(55000);
    a.mark(44000); // 20% below the 55000 peak
    expect(a.maxDrawdownPercent).toBeGreaterThan(19);
    expect(a.maxDrawdownPercent).toBeLessThan(21);
  });
});

describe('grid simulation', () => {
  // Shape of the real Nov 13-21 run: start ~69000, slide through every buy level, keep falling.
  const crash = path([...ramp(69000, 61500, 600), ...ramp(61500, 55000, 600)]);
  const params = { lowerBound: 62000, upperBound: 76000, levels: 6, filters };

  it('live grid: buys all the way down, pauses below the range, then the stop-loss sells', () => {
    const r = runGrid(crash, settings, { ...params, exitOnDownBreak: false }, 'grid', '');
    const gridBuys = r.trades.filter((t) => t.side === 'BUY' && t.reason.startsWith('grid buy'));
    expect(gridBuys.map((t) => t.price)).toEqual([67600, 64800, 62000]);
    expect(r.trades.filter((t) => t.reason.startsWith('grid sell'))).toHaveLength(0);
    expect(r.trades.at(-1)?.reason).toBe('stop-loss');
    expect(r.endState).toMatch(/^STOPPED \(stop-loss/);
    const ret = computeStats(r, settings).returnPercent;
    expect(ret).toBeLessThan(-14);
    expect(ret).toBeGreaterThan(-17);
  });

  it('grid-exit: sells on the break below the range and loses far less', () => {
    const live = runGrid(crash, settings, { ...params, exitOnDownBreak: false }, 'grid', '');
    const exit = runGrid(crash, settings, { ...params, exitOnDownBreak: true }, 'grid-exit', '');
    expect(exit.trades.at(-1)?.reason).toBe('sold on breakout below range');
    expect(exit.finalEquity).toBeGreaterThan(live.finalEquity + 3);
  });

  it('earns from sideways movement inside the range', () => {
    const chop = path(Array.from({ length: 30 }, () => [...ramp(69000, 66500, 50), ...ramp(66500, 71000, 50)]).flat());
    const r = runGrid(chop, settings, { ...params, exitOnDownBreak: false }, 'grid', '');
    expect(r.trades.filter((t) => t.reason.startsWith('grid sell')).length).toBeGreaterThan(10);
    expect(r.finalEquity).toBeGreaterThan(settings.capitalUsdt);
  });

  it('reports why it could not start', () => {
    const r = runGrid(crash, { ...settings, capitalUsdt: 10 }, { ...params, exitOnDownBreak: false }, 'grid', '');
    expect(r.endState).toBe('NOT STARTED');
    expect(r.error).toMatch(/minimum/);
  });
});

describe('structure-break simulation', () => {
  it('buys a breakout, sells the breakdown, and executes on the next candle open', () => {
    // Dip (makes a swing low), rally (breaks the prior swing high), then collapse (breaks the low).
    // .slice(1) avoids repeating each turning point, which would make the turn a tie, not a swing.
    const prices = [
      ...ramp(60000, 60500, 5),
      ...ramp(60500, 59500, 5).slice(1),
      ...ramp(59500, 63000, 20).slice(1),
      ...ramp(63000, 61000, 6).slice(1),
      ...ramp(61000, 55000, 20).slice(1),
    ];
    const candles = path(prices, 5);
    const r = runStructure(candles, { ...settings, stopLossPercent: 0 }, 1, 2, 'bos-1m', '');
    const [buy, sell] = r.trades;
    expect(buy?.side).toBe('BUY');
    expect(sell?.side).toBe('SELL');
    expect(sell?.reason).toMatch(/bearish/);
    // Execution happens at a candle open, i.e. strictly after the signal candle.
    expect(candles.some((c) => c.openTime === buy?.time && c.open === buy?.price)).toBe(true);
  });
});

describe('hold baseline and data helpers', () => {
  it('hold tracks the price move minus one fee', () => {
    const r = runHold(path(ramp(60000, 66000, 10)), settings, 'hold', '');
    expect(computeStats(r, settings).returnPercent).toBeCloseTo(10, 0);
  });

  it('finds gaps and bucket boundaries', () => {
    const c = path([1, 2, 3]);
    c[2] = { ...(c[2] as Candle), openTime: T0 + 5 * MIN };
    expect(findGaps(c)).toEqual([{ after: T0 + MIN, missingMinutes: 3 }]);
    expect(isBucketClose(T0 + 14 * MIN, 15)).toBe(true);
    expect(isBucketClose(T0 + 15 * MIN, 15)).toBe(false);
  });
});
