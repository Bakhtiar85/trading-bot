/**
 * Shared TypeScript interfaces used across modules.
 * Keep this file free of runtime logic.
 */

export type Side = 'BUY' | 'SELL';

/** Lifecycle state of the bot. PAUSED and STOPPED are terminal until a manual config change + restart. */
export type BotStatus = 'RUNNING' | 'PAUSED' | 'STOPPED';

export interface GridConfig {
  symbol: string;
  lowerBound: number;
  upperBound: number;
  levels: number;
  capitalUsdt: number;
}

export interface RiskConfig {
  stopLossPercent: number;
  breakoutPause: boolean;
}

export interface BinanceConfig {
  apiKey: string;
  apiSecret: string;
  useTestnet: boolean;
  httpBase: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  to: string;
}

export interface Config {
  binance: BinanceConfig;
  grid: GridConfig;
  risk: RiskConfig;
  checkIntervalSeconds: number;
  heartbeatIntervalHours: number;
  anthropicApiKey: string | null;
  /** null when SMTP is not configured; emails are then only logged. */
  smtp: SmtpConfig | null;
  logLevel: string;
  dataDir: string;
  logDir: string;
}

/** Exchange trading rules for a symbol (from exchangeInfo filters). */
export interface SymbolFilters {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
}

/** A single computed grid slot: buy at `buyPrice`, then sell the same coins at `sellPrice`. */
export interface GridSlotPlan {
  index: number;
  buyPrice: number;
  sellPrice: number;
  /** Base-asset quantity bought at buyPrice (already rounded to stepSize). */
  quantity: number;
}

export interface GridPlan {
  prices: number[];
  slots: GridSlotPlan[];
  quotePerSlot: number;
}

/** Persisted live state of one grid slot. */
export interface OrderState extends GridSlotPlan {
  /** Which order this slot is currently waiting on. */
  side: Side;
  /** Client order id of the working order; set BEFORE the order is sent so a crash can't orphan it. */
  clientOrderId: string | null;
  orderId: number | null;
}

/** Bot-internal accounting of funds under management (not the whole account balance). */
export interface Ledger {
  quote: number;
  base: number;
  realizedTrades: number;
}

export interface InitialBuyState {
  clientOrderId: string;
  quantity: number;
  done: boolean;
}

export interface PersistedState {
  version: 1;
  sessionId: string;
  configFingerprint: string;
  symbol: string;
  status: BotStatus;
  statusReason: string | null;
  statusChangedAt: string;
  createdAt: string;
  ledger: Ledger;
  slots: OrderState[];
  initialBuy: InitialBuyState | null;
  gridPlaced: boolean;
  /** Only meaningful when STOPPED: whether the stop-loss sell completed. Retried on restart if false. */
  liquidationComplete: boolean;
  orderCounter: number;
  lastHeartbeatAt: string | null;
  /** Set true while running; cleared on graceful shutdown. true at startup => previous run crashed. */
  running: boolean;
  lastCrash: { at: string; message: string } | null;
  /** Used when BREAKOUT_PAUSE=false so the alert is sent once per excursion, not every tick. */
  breakoutAlertActive: boolean;
}

export type IncidentType = 'BREAKOUT_PAUSE' | 'BREAKOUT_ALERT' | 'STOP_LOSS' | 'CRASH_RESTART';

/** Structured facts about an incident. Passed to Claude for a summary and rendered into the email. */
export interface IncidentContext {
  type: IncidentType;
  occurredAt: string;
  symbol: string;
  price: number | null;
  lowerBound: number;
  upperBound: number;
  capitalUsdt: number;
  equityUsdt: number | null;
  drawdownPercent: number | null;
  stopLossPercent: number;
  /** Plain-language list of what the bot ALREADY did. */
  actionsTaken: string[];
  resultingStatus: BotStatus;
  testnet: boolean;
  errorMessage?: string;
}

/** Point-in-time status used for heartbeat and startup emails. */
export interface StatusSnapshot {
  status: BotStatus;
  statusReason: string | null;
  symbol: string;
  price: number | null;
  lowerBound: number;
  upperBound: number;
  capitalUsdt: number;
  equityUsdt: number | null;
  drawdownPercent: number | null;
  ledger: Ledger;
  workingOrders: number;
  uptimeHours: number;
  testnet: boolean;
}

export type RiskDecision =
  | { action: 'NONE' }
  | { action: 'STOP_LOSS'; drawdownPercent: number; equity: number }
  | { action: 'BREAKOUT_PAUSE'; direction: 'ABOVE' | 'BELOW' }
  | { action: 'BREAKOUT_ALERT'; direction: 'ABOVE' | 'BELOW' };
