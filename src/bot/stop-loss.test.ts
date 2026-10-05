/**
 * Stop-loss sell behaviour against a fake exchange: the bot must never send a second sell while
 * an earlier one's outcome is unknown, and must book exactly what was actually sold.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Exchange, OrderSnapshot } from '../exchange';
import { Notifier, type EmailContent } from '../notifications';
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

const STOP_PRICE = 60000; // 40 USDT + 0.001 BTC @ 60000 = 100 vs 125 capital -> 20% drawdown
const HELD_BTC = 0.001;

function makeConfig(dataDir: string): Config {
  return {
    binance: { apiKey: 'k', apiSecret: 's', useTestnet: true, httpBase: 'http://unused' },
    grid: { symbol: 'BTCUSDT', lowerBound: 50000, upperBound: 70000, levels: 5, capitalUsdt: 125 },
    risk: { stopLossPercent: 15, breakoutPause: true },
    checkIntervalSeconds: 60,
    heartbeatIntervalHours: 24,
    anthropicApiKey: null,
    smtp: null,
    logLevel: 'error',
    dataDir,
    logDir: dataDir,
  };
}

const filled = (clientOrderId: string, qty: number, status = 'FILLED'): OrderSnapshot => ({
  orderId: 1,
  clientOrderId,
  side: 'SELL',
  status,
  price: 0,
  origQty: HELD_BTC,
  executedQty: qty,
  cummulativeQuoteQty: qty * STOP_PRICE,
});

const networkError = (): Error => new Error('socket hang up');
const coded = (code: number): Error => Object.assign(new Error(`binance ${code}`), { code });

/** Minimal fake of the Exchange methods the stop-loss path uses. */
function fakeExchange() {
  let btc = HELD_BTC;
  const ex = {
    btc: () => btc,
    setBtc: (v: number) => {
      btc = v;
    },
    getPrice: vi.fn(async () => STOP_PRICE),
    getOpenOrders: vi.fn(async (): Promise<OrderSnapshot[]> => []),
    cancelOrder: vi.fn(async (): Promise<OrderSnapshot | null> => null),
    getBalances: vi.fn(async () => new Map([['BTC', { free: btc, locked: 0 }], ['USDT', { free: 40, locked: 0 }]])),
    getOrder: vi.fn(async (_symbol: string, _id: string): Promise<OrderSnapshot | null> => null),
    placeMarketOrder: vi.fn(async (p: { quantity: number; clientOrderId: string }): Promise<OrderSnapshot> => {
      btc -= p.quantity;
      return filled(p.clientOrderId, p.quantity);
    }),
  };
  return ex;
}

interface BotInternals {
  state: PersistedState;
  filters: SymbolFilters;
}

describe('stop-loss market sell', () => {
  let dir: string;
  let store: StateStore;
  let ex: ReturnType<typeof fakeExchange>;
  let sent: EmailContent[];
  let bot: GridBot;
  let internals: BotInternals;

  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env.ANTHROPIC_API_KEY; // incident emails use the template, no network
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridbot-test-'));
    store = new StateStore(dir);
    ex = fakeExchange();
    sent = [];
    const notifier = new Notifier({ send: async (e) => void sent.push(e) });
    const config = makeConfig(dir);
    bot = new GridBot(config, ex as unknown as Exchange, store, notifier);

    const state = createInitialState('fp', 'BTCUSDT', config.grid.capitalUsdt);
    state.ledger = { quote: 40, base: HELD_BTC, realizedTrades: 0 };
    state.gridPlaced = true;
    state.lastHeartbeatAt = new Date().toISOString();
    internals = bot as unknown as BotInternals;
    internals.state = state;
    internals.filters = filters;
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function tick(): Promise<void> {
    const done = bot.tick();
    await vi.runAllTimersAsync();
    await done;
  }

  it('sells everything and stops on a normal fill', async () => {
    await tick();
    expect(ex.placeMarketOrder).toHaveBeenCalledTimes(1);
    expect(internals.state.status).toBe('STOPPED');
    expect(internals.state.liquidationComplete).toBe(true);
    expect(internals.state.ledger.base).toBe(0);
    expect(internals.state.pendingSellClientOrderId).toBeNull();
    expect(sent.some((e) => e.subject.includes('Stop-loss'))).toBe(true);
  });

  it('timeout but the sell executed: books it once and does not sell again', async () => {
    ex.placeMarketOrder.mockImplementationOnce(async (p) => {
      ex.setBtc(0); // executed on Binance, but the response was lost
      throw networkError();
    });
    ex.getOrder.mockImplementation(async (_s, id) => filled(id, HELD_BTC));

    await tick();
    expect(ex.placeMarketOrder).toHaveBeenCalledTimes(1);
    expect(internals.state.liquidationComplete).toBe(true);
    expect(internals.state.ledger.base).toBe(0);
    expect(internals.state.ledger.quote).toBeGreaterThan(40);
  });

  it('timeout and Binance unreachable: keeps the sell pending (persisted) and never resends blind', async () => {
    ex.placeMarketOrder.mockImplementationOnce(async () => {
      ex.setBtc(0);
      throw networkError();
    });
    ex.getOrder.mockRejectedValue(networkError());

    await tick();
    expect(ex.placeMarketOrder).toHaveBeenCalledTimes(1);
    expect(internals.state.status).toBe('STOPPED');
    expect(internals.state.liquidationComplete).toBe(false);
    const pending = internals.state.pendingSellClientOrderId;
    expect(pending).not.toBeNull();
    expect(store.load()?.pendingSellClientOrderId).toBe(pending); // survives a restart

    // Next check: Binance answers, the earlier sell turns out to have filled. No new order.
    ex.getOrder.mockReset();
    ex.getOrder.mockImplementation(async (_s, id) => filled(id, HELD_BTC));
    await tick();
    expect(ex.placeMarketOrder).toHaveBeenCalledTimes(1);
    expect(internals.state.liquidationComplete).toBe(true);
    expect(internals.state.pendingSellClientOrderId).toBeNull();
    expect(internals.state.ledger.base).toBe(0);
  });

  it('timeout and the order never reached Binance: retries with a fresh id', async () => {
    ex.placeMarketOrder.mockImplementationOnce(async () => {
      throw networkError();
    });
    ex.getOrder.mockResolvedValue(null); // consistently not found

    await tick();
    expect(ex.placeMarketOrder).toHaveBeenCalledTimes(2);
    const ids = ex.placeMarketOrder.mock.calls.map((c) => c[0].clientOrderId);
    expect(ids[0]).not.toBe(ids[1]);
    expect(internals.state.liquidationComplete).toBe(true);
  });

  it('treats Binance "execution status unknown" codes as unknown, not as rejections', async () => {
    ex.placeMarketOrder.mockImplementationOnce(async () => {
      ex.setBtc(0);
      throw coded(-1007);
    });
    ex.getOrder.mockImplementation(async (_s, id) => filled(id, HELD_BTC));

    await tick();
    expect(ex.placeMarketOrder).toHaveBeenCalledTimes(1);
    expect(internals.state.liquidationComplete).toBe(true);
  });

  it('retries a definite rejection with a fresh id', async () => {
    ex.placeMarketOrder.mockImplementationOnce(async () => {
      throw coded(-1013);
    });

    await tick();
    expect(ex.placeMarketOrder).toHaveBeenCalledTimes(2);
    expect(ex.getOrder).not.toHaveBeenCalled(); // no lookup needed for a definite rejection
    expect(internals.state.liquidationComplete).toBe(true);
  });

  it('partial fill: books what sold and sells the remainder on the next check', async () => {
    ex.placeMarketOrder.mockImplementationOnce(async (p) => {
      ex.setBtc(HELD_BTC / 2);
      return filled(p.clientOrderId, HELD_BTC / 2, 'EXPIRED');
    });

    await tick();
    expect(internals.state.liquidationComplete).toBe(false);
    expect(internals.state.ledger.base).toBeCloseTo(HELD_BTC / 2, 10);

    await tick();
    expect(ex.placeMarketOrder).toHaveBeenCalledTimes(2);
    expect(ex.placeMarketOrder.mock.calls[1]?.[0].quantity).toBeCloseTo(HELD_BTC / 2, 10);
    expect(internals.state.liquidationComplete).toBe(true);
    expect(internals.state.ledger.base).toBe(0);
  });
});
