import { describe, expect, it } from 'vitest';
import type { GridConfig, SymbolFilters } from '../types';
import {
  computeGridPlan,
  computeGridPrices,
  decimalsOf,
  formatForExchange,
  GridError,
  gridSpacingPercent,
  initialBuyQuantity,
  initialSides,
  isSpacingProfitable,
  roundToStep,
  sellQuantity,
} from './index';

const filters: SymbolFilters = {
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  tickSize: 0.01,
  stepSize: 0.00001,
  minQty: 0.00001,
  minNotional: 5,
};

const grid: GridConfig = {
  symbol: 'BTCUSDT',
  lowerBound: 90000,
  upperBound: 100000,
  levels: 11,
  capitalUsdt: 1000,
};

describe('rounding helpers', () => {
  it('derives decimals from a step size', () => {
    expect(decimalsOf(0.01)).toBe(2);
    expect(decimalsOf(0.00001)).toBe(5);
    expect(decimalsOf(1)).toBe(0);
  });

  it('rounds to a step without floating-point residue', () => {
    expect(roundToStep(0.3, 0.1, 'down')).toBe(0.3);
    expect(roundToStep(1.23456, 0.001, 'down')).toBe(1.234);
    expect(roundToStep(1.23411, 0.001, 'up')).toBe(1.235);
    expect(roundToStep(1.2345, 0.01, 'nearest')).toBe(1.23);
  });

  it('formats values for the exchange with fixed precision', () => {
    expect(formatForExchange(0.0123456, 0.00001)).toBe('0.01234');
    expect(formatForExchange(95000, 0.01)).toBe('95000.00');
  });
});

describe('computeGridPrices', () => {
  it('produces evenly spaced, inclusive levels', () => {
    const prices = computeGridPrices(90000, 100000, 11, 0.01);
    expect(prices).toHaveLength(11);
    expect(prices[0]).toBe(90000);
    expect(prices[10]).toBe(100000);
    expect(prices[5]).toBe(95000);
  });

  it('rejects invalid ranges', () => {
    expect(() => computeGridPrices(100, 90, 5, 0.01)).toThrow(GridError);
    expect(() => computeGridPrices(90, 100, 1, 0.01)).toThrow(GridError);
  });

  it('rejects spacing smaller than the tick size', () => {
    expect(() => computeGridPrices(1, 1.02, 10, 0.01)).toThrow(/tick size/);
  });
});

describe('computeGridPlan', () => {
  const plan = computeGridPlan(grid, filters);

  it('creates levels - 1 contiguous slots', () => {
    expect(plan.slots).toHaveLength(10);
    plan.slots.forEach((slot, i) => {
      expect(slot.index).toBe(i);
      expect(slot.sellPrice).toBeGreaterThan(slot.buyPrice);
      if (i > 0) expect(slot.buyPrice).toBe(plan.slots[i - 1]?.sellPrice);
    });
  });

  it('never allocates more than the configured capital', () => {
    expect(plan.quotePerSlot).toBeCloseTo(100);
    const totalQuote = plan.slots.reduce((sum, s) => sum + s.quantity * s.buyPrice, 0);
    expect(totalQuote).toBeLessThanOrEqual(grid.capitalUsdt);
    expect(totalQuote).toBeGreaterThan(grid.capitalUsdt * 0.99);
  });

  it('rounds quantities down to the step size', () => {
    for (const slot of plan.slots) {
      expect(roundToStep(slot.quantity, filters.stepSize, 'down')).toBe(slot.quantity);
    }
  });

  it('throws when capital per slot is below the exchange minimum notional', () => {
    expect(() => computeGridPlan({ ...grid, capitalUsdt: 20 }, filters)).toThrow(/minimum/);
  });

  it('reports spacing and profitability', () => {
    expect(gridSpacingPercent(plan)).toBeCloseTo((1000 / 90000) * 100);
    expect(isSpacingProfitable(plan)).toBe(true);
    const tight = computeGridPlan({ ...grid, lowerBound: 99900, upperBound: 100000, levels: 11 }, filters);
    expect(isSpacingProfitable(tight)).toBe(false);
  });
});

describe('initial placement', () => {
  const plan = computeGridPlan(grid, filters);

  it('buys below the current price and sells above it', () => {
    const sides = initialSides(plan, 95500);
    // Buy lines 90000..95000 are below 95500 -> BUY; 96000.. -> SELL
    expect(sides.slice(0, 6)).toEqual(['BUY', 'BUY', 'BUY', 'BUY', 'BUY', 'BUY']);
    expect(sides.slice(6)).toEqual(['SELL', 'SELL', 'SELL', 'SELL']);
  });

  it('market-buys exactly the coins needed for SELL slots', () => {
    const sides = initialSides(plan, 95500);
    const expected = plan.slots.slice(6).reduce((sum, s) => sum + s.quantity, 0);
    expect(initialBuyQuantity(plan, sides, filters.stepSize)).toBeCloseTo(expected, 8);
  });

  it('needs no initial buy when price is at the top of the range', () => {
    const sides = initialSides(plan, 100000);
    expect(sides.every((s) => s === 'BUY')).toBe(true);
    expect(initialBuyQuantity(plan, sides, filters.stepSize)).toBe(0);
  });

  it('sizes sells below the bought quantity to leave room for fees', () => {
    const slot = plan.slots[0];
    expect(slot).toBeDefined();
    if (!slot) return;
    const qty = sellQuantity(slot.quantity, filters.stepSize);
    // At most the post-fee amount received, and within one lot step of it.
    const afterFee = slot.quantity * 0.999;
    expect(qty).toBeLessThanOrEqual(afterFee);
    expect(qty).toBeGreaterThan(afterFee - filters.stepSize);
  });
});
