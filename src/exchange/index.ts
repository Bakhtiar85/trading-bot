/**
 * Thin, fully typed wrapper around binance-api-node for the handful of spot endpoints the bot uses.
 *
 * Some of the library's typings don't match its runtime behaviour (e.g. `prices()` returns a
 * `{ SYMBOL: price }` map, `exchangeInfo()` is typed `any`, and `apiRestrictions()` is untyped).
 * Those responses are treated as `unknown` and validated here instead of trusting the typings.
 */
import Binance, { OrderSide, OrderType, TimeInForce } from 'binance-api-node';
import type { BinanceRest } from 'binance-api-node';
import { formatForExchange } from '../grid';
import type { BinanceConfig, Side, SymbolFilters } from '../types';

/** Binance error codes the bot reacts to. */
export const BINANCE_ERR = {
  UNKNOWN_ORDER: -2011, // cancel on an order that no longer exists
  NO_SUCH_ORDER: -2013, // query on an order that never existed
  INSUFFICIENT_BALANCE: -2010,
} as const;

export interface OrderSnapshot {
  orderId: number;
  clientOrderId: string;
  side: Side;
  status: string;
  price: number;
  origQty: number;
  executedQty: number;
  cummulativeQuoteQty: number;
}

export interface Balance {
  free: number;
  locked: number;
}

export interface KeyRestrictions {
  enableWithdrawals: boolean;
  enableSpotAndMarginTrading: boolean;
}

/** Runtime shape of library methods whose published typings are wrong or missing. */
interface UntypedEndpoints {
  prices(payload: { symbol: string }): Promise<unknown>;
  exchangeInfo(payload: { symbol: string }): Promise<unknown>;
  apiRestrictions(): Promise<unknown>;
}

export function binanceErrorCode(err: unknown): number | null {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = Number((err as { code: unknown }).code);
    return Number.isFinite(code) ? code : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toNumber(value: unknown, field: string): number {
  // json-bigint may hand back BigNumber objects for large integers; Number() handles those too.
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Unexpected non-numeric ${field} from Binance: ${String(value)}`);
  return n;
}

interface RawOrder {
  orderId: unknown;
  clientOrderId: string;
  side: string;
  status: string;
  price: string;
  origQty: string;
  executedQty: string;
  cummulativeQuoteQty: string;
}

function toSnapshot(raw: RawOrder, clientOrderIdOverride?: string): OrderSnapshot {
  return {
    orderId: toNumber(raw.orderId, 'orderId'),
    clientOrderId: clientOrderIdOverride ?? raw.clientOrderId,
    side: raw.side === 'SELL' ? 'SELL' : 'BUY',
    status: String(raw.status),
    price: toNumber(raw.price, 'price'),
    origQty: toNumber(raw.origQty, 'origQty'),
    executedQty: toNumber(raw.executedQty, 'executedQty'),
    cummulativeQuoteQty: toNumber(raw.cummulativeQuoteQty, 'cummulativeQuoteQty'),
  };
}

export class Exchange {
  private readonly client: BinanceRest;
  private readonly untyped: UntypedEndpoints;
  readonly testnet: boolean;

  constructor(config: BinanceConfig) {
    this.client = Binance({ apiKey: config.apiKey, apiSecret: config.apiSecret, httpBase: config.httpBase });
    // Same object, viewed through corrected signatures for the endpoints described above.
    this.untyped = this.client as unknown as UntypedEndpoints;
    this.testnet = config.useTestnet;
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  async getPrice(symbol: string): Promise<number> {
    const result = await this.untyped.prices({ symbol });
    if (!isRecord(result) || result[symbol] === undefined) {
      throw new Error(`No price returned for ${symbol}`);
    }
    const price = toNumber(result[symbol], 'price');
    if (price <= 0) throw new Error(`Invalid price ${price} for ${symbol}`);
    return price;
  }

  async getSymbolFilters(symbol: string): Promise<SymbolFilters> {
    const info = await this.untyped.exchangeInfo({ symbol });
    const symbols = isRecord(info) && Array.isArray(info.symbols) ? (info.symbols as unknown[]) : [];
    const entry = symbols.find((s) => isRecord(s) && s.symbol === symbol);
    if (!isRecord(entry)) throw new Error(`Symbol ${symbol} not found on exchange`);
    if (entry.status !== 'TRADING') throw new Error(`Symbol ${symbol} is not trading (status ${String(entry.status)})`);

    const filters = Array.isArray(entry.filters) ? (entry.filters as unknown[]).filter(isRecord) : [];
    const byType = (type: string): Record<string, unknown> | undefined => filters.find((f) => f.filterType === type);

    const priceFilter = byType('PRICE_FILTER');
    const lotSize = byType('LOT_SIZE');
    const notional = byType('NOTIONAL') ?? byType('MIN_NOTIONAL');
    if (!priceFilter || !lotSize) throw new Error(`Missing PRICE_FILTER/LOT_SIZE for ${symbol}`);

    return {
      symbol,
      baseAsset: String(entry.baseAsset),
      quoteAsset: String(entry.quoteAsset),
      tickSize: toNumber(priceFilter.tickSize, 'tickSize'),
      stepSize: toNumber(lotSize.stepSize, 'stepSize'),
      minQty: toNumber(lotSize.minQty, 'minQty'),
      minNotional: notional ? toNumber(notional.minNotional, 'minNotional') : 0,
    };
  }

  async getBalances(): Promise<Map<string, Balance>> {
    const account = await this.client.accountInfo();
    const map = new Map<string, Balance>();
    for (const b of account.balances) {
      map.set(b.asset, { free: toNumber(b.free, 'free'), locked: toNumber(b.locked, 'locked') });
    }
    return map;
  }

  /**
   * Returns the API key's permission flags, or null where the endpoint isn't available
   * (the Spot Testnet does not serve /sapi endpoints).
   */
  async getKeyRestrictions(): Promise<KeyRestrictions | null> {
    if (this.testnet) return null;
    const r = await this.untyped.apiRestrictions();
    if (!isRecord(r)) return null;
    return {
      enableWithdrawals: r.enableWithdrawals === true,
      enableSpotAndMarginTrading: r.enableSpotAndMarginTrading === true,
    };
  }

  async placeLimitOrder(params: {
    filters: SymbolFilters;
    side: Side;
    quantity: number;
    price: number;
    clientOrderId: string;
  }): Promise<OrderSnapshot> {
    const { filters } = params;
    const res = await this.client.order({
      symbol: filters.symbol,
      side: params.side === 'BUY' ? OrderSide.BUY : OrderSide.SELL,
      type: OrderType.LIMIT,
      timeInForce: TimeInForce.GTC,
      quantity: formatForExchange(params.quantity, filters.stepSize),
      price: formatForExchange(params.price, filters.tickSize),
      newClientOrderId: params.clientOrderId,
    });
    return toSnapshot(res);
  }

  async placeMarketOrder(params: {
    filters: SymbolFilters;
    side: Side;
    quantity: number;
    clientOrderId: string;
  }): Promise<OrderSnapshot> {
    const { filters } = params;
    const res = await this.client.order({
      symbol: filters.symbol,
      side: params.side === 'BUY' ? OrderSide.BUY : OrderSide.SELL,
      type: OrderType.MARKET,
      quantity: formatForExchange(params.quantity, filters.stepSize),
      newClientOrderId: params.clientOrderId,
      newOrderRespType: 'FULL',
    });
    return toSnapshot(res);
  }

  /** Look up an order by client id; null if the exchange has no record of it. */
  async getOrder(symbol: string, clientOrderId: string): Promise<OrderSnapshot | null> {
    try {
      const res = await this.client.getOrder({ symbol, origClientOrderId: clientOrderId });
      return toSnapshot(res);
    } catch (err) {
      if (binanceErrorCode(err) === BINANCE_ERR.NO_SUCH_ORDER) return null;
      throw err;
    }
  }

  async getOpenOrders(symbol: string): Promise<OrderSnapshot[]> {
    const res = await this.client.openOrders({ symbol });
    return res.map((o) => toSnapshot(o));
  }

  /**
   * Cancel by client id. Returns the final order snapshot (so partial fills can be accounted for),
   * or null if the order was already gone.
   */
  async cancelOrder(symbol: string, clientOrderId: string): Promise<OrderSnapshot | null> {
    try {
      const res = await this.client.cancelOrder({ symbol, origClientOrderId: clientOrderId });
      // On cancel, `clientOrderId` is a fresh id for the cancel request; the original is in origClientOrderId.
      return toSnapshot(res, res.origClientOrderId);
    } catch (err) {
      const code = binanceErrorCode(err);
      if (code === BINANCE_ERR.UNKNOWN_ORDER || code === BINANCE_ERR.NO_SUCH_ORDER) return null;
      throw err;
    }
  }
}
