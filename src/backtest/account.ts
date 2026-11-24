/**
 * Simulated spot account. Every strategy trades through this so fees, slippage, Binance's lot
 * rounding and minimum order size are applied identically, and results are comparable.
 *
 * Fees are modelled the way the live bot pays them (BNB): they don't reduce the USDT or coins
 * being traded, but are accumulated separately and subtracted from equity.
 */
import { roundToStep } from '../grid';
import type { SimSettings, SimTrade } from './types';

interface Lot {
  qty: number;
  /** USDT spent per coin, including the buy fee. */
  unitCost: number;
}

export class SimAccount {
  quote: number;
  base = 0;
  feesPaid = 0;
  readonly trades: SimTrade[] = [];
  private readonly lots: Lot[] = [];
  private peakEquity: number;
  maxDrawdownPercent = 0;
  private candlesSeen = 0;
  private candlesInMarket = 0;
  lastEquity: number;

  constructor(readonly settings: SimSettings) {
    this.quote = settings.capitalUsdt;
    this.peakEquity = settings.capitalUsdt;
    this.lastEquity = settings.capitalUsdt;
  }

  /** Buy `qty` coins at `price`. Returns false (and does nothing) if the order is below Binance minimums or unaffordable. */
  buy(time: number, price: number, qty: number, reason: string): boolean {
    const q = roundToStep(qty, this.settings.stepSize, 'down');
    const cost = q * price;
    const fee = cost * this.settings.feeRate;
    if (q < this.settings.minQty || cost < this.settings.minNotional || cost > this.quote + 1e-9) return false;
    this.quote -= cost;
    this.base += q;
    this.feesPaid += fee;
    this.lots.push({ qty: q, unitCost: (cost + fee) / q });
    this.trades.push({ time, side: 'BUY', price, qty: q, fee, reason });
    return true;
  }

  /** Sell `qty` coins at `price` (capped at what is held). Returns false if below Binance minimums. */
  sell(time: number, price: number, qty: number, reason: string): boolean {
    const q = roundToStep(Math.min(qty, this.base), this.settings.stepSize, 'down');
    const proceeds = q * price;
    if (q < this.settings.minQty || proceeds < this.settings.minNotional) return false;
    const fee = proceeds * this.settings.feeRate;
    this.quote += proceeds;
    this.base -= q;
    if (this.base < 1e-12) this.base = 0;
    this.feesPaid += fee;
    this.trades.push({ time, side: 'SELL', price, qty: q, fee, reason, pnl: proceeds - fee - this.consumeLots(q) });
    return true;
  }

  /** Market buy with as much USDT as `fraction` of the balance allows, at `price` plus slippage. */
  marketBuy(time: number, price: number, reason: string, fraction = 1): boolean {
    const fill = price * (1 + this.settings.slippage);
    return this.buy(time, fill, (this.quote * fraction) / fill, reason);
  }

  /** Market sell everything held, at `price` minus slippage. Leftover below the lot step stays as dust. */
  marketSellAll(time: number, price: number, reason: string): boolean {
    return this.sell(time, price * (1 - this.settings.slippage), this.base, reason);
  }

  /** Account value at `price`, net of all fees paid so far. */
  equityAt(price: number): number {
    return this.quote + this.base * price - this.feesPaid;
  }

  /** Record end-of-candle equity for drawdown and time-in-market statistics. */
  mark(close: number): number {
    const equity = this.equityAt(close);
    this.lastEquity = equity;
    this.candlesSeen++;
    if (this.base * close >= this.settings.minNotional / 10) this.candlesInMarket++;
    if (equity > this.peakEquity) this.peakEquity = equity;
    const dd = ((this.peakEquity - equity) / this.peakEquity) * 100;
    if (dd > this.maxDrawdownPercent) this.maxDrawdownPercent = dd;
    return equity;
  }

  /** True once equity has fallen `stopLossPercent` below starting capital (disabled when 0). */
  stopLossHit(equity: number): boolean {
    const sl = this.settings.stopLossPercent;
    return sl > 0 && equity <= this.settings.capitalUsdt * (1 - sl / 100);
  }

  timeInMarket(): number {
    return this.candlesSeen === 0 ? 0 : this.candlesInMarket / this.candlesSeen;
  }

  /** Cost basis of `qty` coins, taken first-in first-out from earlier buys. */
  private consumeLots(qty: number): number {
    let remaining = qty;
    let cost = 0;
    while (remaining > 1e-12 && this.lots.length > 0) {
      const lot = this.lots[0] as Lot;
      const take = Math.min(lot.qty, remaining);
      cost += take * lot.unitCost;
      lot.qty -= take;
      remaining -= take;
      if (lot.qty <= 1e-12) this.lots.shift();
    }
    return cost;
  }
}
