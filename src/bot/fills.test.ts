/**
 * Fill handling against a fake exchange: when a buy fills, the bot must book the fee Binance
 * actually charged and size the matching sell from the coins actually received.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Exchange, OrderFees, OrderSnapshot } from '../exchange';
import { Notifier } from '../notifications';
import { createInitialState, StateStore } from '../risk';
import type { Config, PersistedState, SymbolFilters } from '../types';
import { GridBot } from './index';

const filters: SymbolFilters = {
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  tickSize: 0.01,
  stepSize: 0.00001,
  minQty: 0.00001,
  minNotional: 5,
};

const BOUGHT = 0.00008;
const COST = BOUGHT * 82500; // 6.6 USDT

function makeConfig(dataDir: string): Config {
  return {
    binance: { apiKey: 'k', apiSecret: 's', useTestnet: false, httpBase: 'http://unused' },
    grid: { symbol: 'BTCUSDT', lowerBound: 79000, upperBound: 86000, levels: 3, capitalUsdt: 14 },
    risk: { stopLossPercent: 15, breakoutPause: true },
    checkIntervalSeconds: 60,
    heartbeatIntervalHours: 24,
    statusPage: null,
    anthropicApiKey: null,
    smtp: null,
    logLevel: 'error',
    dataDir,
    logDir: dataDir,
  };
}

function fakeExchange(btcInAccount: number, fees: () => Promise<OrderFees>) {
  return {
    getPrice: vi.fn(async () => 83000),
    getOpenOrders: vi.fn(async (): Promise<OrderSnapshot[]> => []),
    getOrder: vi.fn(async (_s: string, id: string): Promise<OrderSnapshot> => ({
      orderId: 42,
      clientOrderId: id,
      side: 'BUY',
      status: 'FILLED',
      price: 82500,
      origQty: BOUGHT,
      executedQty: BOUGHT,
      cummulativeQuoteQty: COST,
    })),
    getOrderFees: vi.fn(fees),
    getBalances: vi.fn(async () => new Map([['BTC', { free: btcInAccount, locked: 0 }], ['USDT', { free: 7.4, locked: 0 }]])),
    placeLimitOrder: vi.fn(async (p: { side: string; quantity: number; price: number; clientOrderId: string }) => ({
      orderId: 43,
      clientOrderId: p.clientOrderId,
      side: p.side,
      status: 'NEW',
      price: p.price,
      origQty: p.quantity,
      executedQty: 0,
      cummulativeQuoteQty: 0,
    })),
  };
}

describe('buy fill -> sell sizing', () => {
  let dir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridbot-fills-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function runBuyFill(ex: ReturnType<typeof fakeExchange>): Promise<PersistedState> {
    const config = makeConfig(dir);
    const bot = new GridBot(config, ex as unknown as Exchange, new StateStore(dir), new Notifier({ send: async () => {} }));
    const state = createInitialState('fp', 'BTCUSDT', 14);
    state.gridPlaced = true;
    state.lastHeartbeatAt = new Date().toISOString();
    state.slots = [
      { index: 1, buyPrice: 82500, sellPrice: 86000, quantity: BOUGHT, side: 'BUY', clientOrderId: 'gb-x-s1-1', orderId: 1 },
    ];
    const internals = bot as unknown as { state: PersistedState; filters: SymbolFilters };
    internals.state = state;
    internals.filters = filters;

    const done = bot.tick();
    await vi.runAllTimersAsync();
    await done;
    return internals.state;
  }

  const placedSell = (ex: ReturnType<typeof fakeExchange>) => ex.placeLimitOrder.mock.calls[0]?.[0];

  it('fee paid in BNB: sells everything bought and books no BTC fee', async () => {
    const ex = fakeExchange(BOUGHT, async () => ({ base: 0, quote: 0, other: { BNB: 0.00001 } }));
    const state = await runBuyFill(ex);

    expect(placedSell(ex)).toMatchObject({ side: 'SELL', price: 86000 });
    expect(placedSell(ex)?.quantity).toBeCloseTo(0.00008, 10);
    expect(state.slots[0]?.heldQuantity).toBeCloseTo(0.00008, 10);
    expect(state.ledger.base).toBeCloseTo(0.00008, 10);
    expect(state.ledger.quote).toBeCloseTo(14 - COST, 8);
  });

  it('fee taken from the BTC: books the exact fee and rounds the sell down to the lot step', async () => {
    const ex = fakeExchange(0.00007992, async () => ({ base: 0.00000008, quote: 0, other: {} }));
    const state = await runBuyFill(ex);

    expect(placedSell(ex)?.quantity).toBeCloseTo(0.00007, 10);
    expect(state.slots[0]?.heldQuantity).toBeCloseTo(0.00007992, 10);
    expect(state.ledger.base).toBeCloseTo(0.00007992, 10);
  });

  it('fee lookup fails: falls back to the 0.1% estimate, never oversells', async () => {
    const ex = fakeExchange(BOUGHT, async () => {
      throw new Error('network down');
    });
    const state = await runBuyFill(ex);

    expect(placedSell(ex)?.quantity).toBeCloseTo(0.00007, 10);
    expect(state.slots[0]?.heldQuantity).toBeNull();
    expect(state.ledger.base).toBeCloseTo(0.00007992, 10);
  });

  it('never sells more than the account actually holds', async () => {
    // Fee says nothing was deducted, but the account only has 0.00007 free (e.g. moved manually).
    const ex = fakeExchange(0.00007, async () => ({ base: 0, quote: 0, other: { BNB: 0.00001 } }));
    await runBuyFill(ex);
    expect(placedSell(ex)?.quantity).toBeCloseTo(0.00007, 10);
  });
});
