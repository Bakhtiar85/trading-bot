/**
 * Pure grid-calculation functions. No I/O, no exchange calls — everything here is unit-testable.
 *
 * Model: GRID_LEVELS price lines evenly spaced (arithmetic) from lower to upper bound, inclusive.
 * Between each pair of adjacent lines is a "slot". A slot either holds USDT and waits to BUY at its
 * lower line, or holds coins and waits to SELL them at its upper line. Capital is split equally
 * across the (levels - 1) slots.
 */
import type { GridConfig, GridPlan, GridSlotPlan, Side, SymbolFilters } from '../types';

/**
 * Binance spot's default taker/maker fee (0.1%). Used as a conservative estimate: when a buy fills,
 * the fee is usually deducted from the coins received, so each sell is sized slightly smaller.
 */
export const ESTIMATED_FEE_RATE = 0.001;

export class GridError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GridError';
  }
}

/** Number of decimal places implied by a step such as 0.00010000 -> 4. */
export function decimalsOf(step: number): number {
  if (step <= 0) return 8;
  const text = step.toFixed(12).replace(/0+$/, '');
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

export type RoundMode = 'down' | 'up' | 'nearest';

/** Round `value` to a multiple of `step`, avoiding floating-point residue like 0.30000000000000004. */
export function roundToStep(value: number, step: number, mode: RoundMode = 'down'): number {
  if (step <= 0) return value;
  const ratio = value / step;
  // Small epsilon so e.g. 0.3 / 0.1 = 2.9999999999999996 still floors to 3.
  const eps = 1e-9;
  const units =
    mode === 'down' ? Math.floor(ratio + eps) : mode === 'up' ? Math.ceil(ratio - eps) : Math.round(ratio);
  return Number((units * step).toFixed(decimalsOf(step)));
}

/** Format a number for the Binance API using the precision implied by `step`. */
export function formatForExchange(value: number, step: number): string {
  return roundToStep(value, step, 'down').toFixed(decimalsOf(step));
}

/** Evenly spaced grid lines from lower to upper (inclusive), rounded to the symbol's tick size. */
export function computeGridPrices(lower: number, upper: number, levels: number, tickSize: number): number[] {
  if (!(lower > 0) || !(upper > lower)) throw new GridError('Require 0 < lower < upper');
  if (!Number.isInteger(levels) || levels < 2) throw new GridError('Require an integer levels >= 2');

  const spacing = (upper - lower) / (levels - 1);
  const prices: number[] = [];
  for (let i = 0; i < levels; i++) {
    const raw = i === levels - 1 ? upper : lower + spacing * i;
    prices.push(roundToStep(raw, tickSize, 'nearest'));
  }
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1] as number;
    const cur = prices[i] as number;
    if (!(cur > prev)) {
      throw new GridError(`Grid spacing is smaller than the tick size (${tickSize}); use fewer levels or a wider range`);
    }
  }
  return prices;
}

/** Quantity actually offered when selling a slot, after allowing for the buy-side fee. */
export function sellQuantity(buyQuantity: number, stepSize: number, feeRate: number = ESTIMATED_FEE_RATE): number {
  return roundToStep(buyQuantity * (1 - feeRate), stepSize, 'down');
}

/**
 * Build the order ladder for a grid. Throws GridError if any slot would violate the exchange's
 * minimum quantity / minimum notional rules (i.e. capital is too small for this many levels).
 */
export function computeGridPlan(grid: GridConfig, filters: SymbolFilters): GridPlan {
  if (!(grid.capitalUsdt > 0)) throw new GridError('Capital must be > 0');
  const prices = computeGridPrices(grid.lowerBound, grid.upperBound, grid.levels, filters.tickSize);
  const slotCount = prices.length - 1;
  const quotePerSlot = grid.capitalUsdt / slotCount;

  const slots: GridSlotPlan[] = [];
  for (let i = 0; i < slotCount; i++) {
    const buyPrice = prices[i] as number;
    const sellPrice = prices[i + 1] as number;
    const quantity = roundToStep(quotePerSlot / buyPrice, filters.stepSize, 'down');
    const sellQty = sellQuantity(quantity, filters.stepSize);

    if (quantity < filters.minQty || sellQty < filters.minQty) {
      throw new GridError(
        `Slot ${i}: quantity ${quantity} is below the exchange minimum ${filters.minQty}. Increase capital or reduce levels.`,
      );
    }
    if (quantity * buyPrice < filters.minNotional || sellQty * sellPrice < filters.minNotional) {
      throw new GridError(
        `Slot ${i}: order value ~${(quantity * buyPrice).toFixed(2)} ${filters.quoteAsset} is below the exchange minimum ` +
          `${filters.minNotional}. Increase capital or reduce levels.`,
      );
    }
    slots.push({ index: i, buyPrice, sellPrice, quantity });
  }
  return { prices, slots, quotePerSlot };
}

/**
 * Which side each slot starts on, given the current price: slots whose buy line is below the price
 * wait to buy; the rest need coins up-front and wait to sell above the price.
 */
export function initialSides(plan: GridPlan, currentPrice: number): Side[] {
  return plan.slots.map((slot) => (slot.buyPrice < currentPrice ? 'BUY' : 'SELL'));
}

/** Total base-asset quantity to market-buy at start so every SELL-side slot holds its coins. */
export function initialBuyQuantity(plan: GridPlan, sides: Side[], stepSize: number): number {
  let total = 0;
  plan.slots.forEach((slot, i) => {
    if (sides[i] === 'SELL') total += slot.quantity;
  });
  return roundToStep(total, stepSize, 'up');
}

/** Grid spacing as a percentage of the lowest line — the gross profit per completed round trip. */
export function gridSpacingPercent(plan: GridPlan): number {
  const first = plan.slots[0];
  if (!first) return 0;
  return ((first.sellPrice - first.buyPrice) / first.buyPrice) * 100;
}

/** A round trip pays the fee twice; spacing must exceed that to have any chance of profit. */
export function isSpacingProfitable(plan: GridPlan, feeRate: number = ESTIMATED_FEE_RATE): boolean {
  return gridSpacingPercent(plan) > feeRate * 2 * 100;
}
