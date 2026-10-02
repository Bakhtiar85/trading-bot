/**
 * Main orchestration loop. Each tick:
 *   1. fetch the price
 *   2. (RUNNING) detect filled orders, update the ledger, flip filled slots to the opposite side
 *   3. evaluate the hard-coded risk rules and act on them (stop-loss / breakout pause)
 *   4. (RUNNING) place any missing grid orders
 *   5. send the heartbeat email when due
 *
 * Ordering guarantees:
 *   - A halt (PAUSED/STOPPED) is persisted to disk BEFORE any exchange action and BEFORE any
 *     notification, so a crash mid-way can never leave the bot thinking it may trade.
 *   - Notifications (email/Claude) run only after the protective action has been attempted and
 *     can never block or fail it.
 *   - Nothing in this file ever sets status back to RUNNING. A new RUNNING session only starts
 *     when the grid config fingerprint changes and the process restarts (see prepareState).
 */
import { configFingerprint } from '../config';
import { binanceErrorCode, Exchange, OrderSnapshot } from '../exchange';
import {
  computeGridPlan,
  ESTIMATED_FEE_RATE,
  gridSpacingPercent,
  initialBuyQuantity,
  initialSides,
  isSpacingProfitable,
  roundToStep,
  sellQuantity,
} from '../grid';
import { errorMessage, logger } from '../logger';
import { Notifier } from '../notifications';
import { computeDrawdownPercent, computeEquity, createInitialState, evaluateRisk, StateStore } from '../risk';
import type {
  BotStatus,
  Config,
  IncidentContext,
  IncidentType,
  OrderState,
  PersistedState,
  Side,
  StatusSnapshot,
  SymbolFilters,
} from '../types';

const TERMINAL_ORDER_STATUSES = new Set(['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'EXPIRED_IN_MATCH']);
const FAILURE_ALERT_THRESHOLD = 5;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function retry<T>(label: string, fn: () => Promise<T>, attempts = 5, delayMs = 3_000): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      logger.warn(`${label} failed (attempt ${i}/${attempts})`, { error: errorMessage(err) });
      if (i < attempts) await sleep(delayMs * i);
    }
  }
  throw lastErr;
}

export class GridBot {
  private state!: PersistedState;
  private filters!: SymbolFilters;
  private lastPrice: number | null = null;
  private readonly startedAt = Date.now();
  private stopRequested = false;
  private wake: (() => void) | null = null;
  private loopDone: Promise<void> | null = null;
  private consecutiveFailures = 0;
  private failureAlertSent = false;
  private lastTickOkAt: number | null = null;

  constructor(
    private readonly config: Config,
    private readonly exchange: Exchange,
    private readonly store: StateStore,
    private readonly notifier: Notifier,
  ) {}

  get symbol(): string {
    return this.config.grid.symbol;
  }

  // ---------------------------------------------------------------------------------------------
  // Startup
  // ---------------------------------------------------------------------------------------------

  async start(): Promise<void> {
    const { grid } = this.config;
    logger.info('Starting grid bot', {
      symbol: grid.symbol,
      range: `${grid.lowerBound}-${grid.upperBound}`,
      levels: grid.levels,
      capital: grid.capitalUsdt,
      testnet: this.config.binance.useTestnet,
    });

    await retry('Binance ping', () => this.exchange.ping());
    await this.checkApiKeyPermissions();
    this.filters = await retry('Load symbol filters', () => this.exchange.getSymbolFilters(grid.symbol));

    // Validates capital vs. exchange minimums up-front (throws GridError on a bad config).
    const plan = computeGridPlan(grid, this.filters);
    if (!isSpacingProfitable(plan)) {
      logger.warn(
        `Grid spacing ${gridSpacingPercent(plan).toFixed(3)}% is below the round-trip fee ` +
          `(~${(ESTIMATED_FEE_RATE * 200).toFixed(2)}%); trades will likely lose money. Consider fewer levels.`,
      );
    }

    const crashedLastRun = await this.prepareState();
    const price = await retry('Fetch price', () => this.exchange.getPrice(grid.symbol));
    this.lastPrice = price;

    if (crashedLastRun) await this.reportCrashRestart(price);

    if (this.state.status === 'RUNNING') {
      if (!this.state.gridPlaced) await this.initializeGrid(price);
    } else {
      logger.warn(`Bot is ${this.state.status} (${this.state.statusReason ?? 'no reason recorded'}). ` +
        'It will not trade. Change the grid settings in .env and restart to start a new session.');
      // Make sure nothing from this session is still working on the exchange.
      await this.cancelAllGridOrders();
    }

    await this.notifier.status('Started', this.snapshot());
    this.state.lastHeartbeatAt = new Date().toISOString();
    this.save();

    this.loopDone = this.runLoop();
  }

  /** Refuse to run on mainnet with a key that can withdraw funds. */
  private async checkApiKeyPermissions(): Promise<void> {
    if (this.config.binance.useTestnet) return;
    let restrictions;
    try {
      restrictions = await this.exchange.getKeyRestrictions();
    } catch (err) {
      logger.warn('Could not verify API key permissions; make sure withdrawals are DISABLED on this key', {
        error: errorMessage(err),
      });
      return;
    }
    if (restrictions?.enableWithdrawals) {
      throw new Error(
        'This Binance API key has WITHDRAWAL permission enabled. Refusing to run. ' +
          'Edit the key on Binance and disable withdrawals (only "Enable Spot & Margin Trading" is needed).',
      );
    }
    if (restrictions && !restrictions.enableSpotAndMarginTrading) {
      throw new Error('This Binance API key does not have spot trading permission enabled.');
    }
  }

  /**
   * Load persisted state, or start a new session if there is none / the grid config changed.
   * Returns true if the previous process did not shut down cleanly.
   */
  private async prepareState(): Promise<boolean> {
    const fingerprint = configFingerprint(this.config);
    const existing = this.store.load();
    let crashed = false;

    if (existing && existing.configFingerprint === fingerprint) {
      this.state = existing;
      crashed = existing.running;
      logger.info(`Resuming session ${existing.sessionId} (status ${existing.status})`);
    } else {
      if (existing) {
        logger.warn(`Grid config changed since session ${existing.sessionId} (${existing.status}); starting a new session`);
        if (existing.symbol === this.symbol) {
          // Cancel whatever the old session left working. Coins it held stay in the account but
          // are not managed by the new session.
          this.state = existing;
          await this.cancelAllGridOrders();
        } else {
          logger.warn(
            `Previous session traded ${existing.symbol}; cancel any of its open orders (ids starting ` +
              `"gb-${existing.sessionId}-") manually on Binance`,
          );
        }
        const archived = this.store.archive(existing);
        logger.info(`Previous session state archived to ${archived}`);
      }
      this.state = createInitialState(fingerprint, this.symbol, this.config.grid.capitalUsdt);
      logger.info(`New session ${this.state.sessionId}`);
    }

    this.state.running = true;
    this.save();
    return crashed;
  }

  private async reportCrashRestart(price: number): Promise<void> {
    const prev = this.state.lastCrash;
    logger.warn('Previous run did not shut down cleanly; reporting crash restart', { lastCrash: prev });
    const ctx = this.incidentContext('CRASH_RESTART', price, [
      'The bot process stopped unexpectedly and was restarted automatically',
      `Resumed from saved state with status ${this.state.status}`,
      this.state.status === 'RUNNING'
        ? 'Existing grid orders are being re-checked and any fills while it was down will be processed'
        : 'The bot remains halted and will not trade',
    ]);
    if (prev) ctx.errorMessage = `${prev.message} (at ${prev.at})`;
    this.state.lastCrash = null;
    this.save();
    await this.notifier.incident(ctx);
  }

  /** First-time setup: buy the coins needed for sell-side slots, then mark the grid as placed. */
  private async initializeGrid(price: number): Promise<void> {
    const { grid } = this.config;

    if (price < grid.lowerBound || price > grid.upperBound) {
      await this.pause(price, `Price ${price} was outside the grid range at start; no orders were placed`, [
        'Did not place any grid orders because the price is outside the configured range',
      ]);
      return;
    }

    if (this.state.slots.length === 0) {
      // Do every check before touching state: the slots and the initial-buy record must be
      // committed together, or a crash in between could skip the initial buy on restart.
      const balances = await this.exchange.getBalances();
      const freeQuote = balances.get(this.filters.quoteAsset)?.free ?? 0;
      if (freeQuote < grid.capitalUsdt) {
        throw new Error(
          `Insufficient ${this.filters.quoteAsset}: need ${grid.capitalUsdt}, have ${freeQuote} free. ` +
            'Lower CAPITAL_ALLOCATION_USDT or fund the account.',
        );
      }

      const plan = computeGridPlan(grid, this.filters);
      const sides = initialSides(plan, price);
      const qty = initialBuyQuantity(plan, sides, this.filters.stepSize);
      this.state.initialBuy = qty > 0 ? { clientOrderId: this.newClientOrderId('init'), quantity: qty, done: false } : null;
      this.state.slots = plan.slots.map((slot, i) => ({
        ...slot,
        side: sides[i] ?? 'BUY',
        clientOrderId: null,
        orderId: null,
      }));
      this.save();
      logger.info('Grid planned', {
        buySlots: sides.filter((s) => s === 'BUY').length,
        sellSlots: sides.filter((s) => s === 'SELL').length,
        initialBuyQty: qty,
      });
    }

    const init = this.state.initialBuy;
    if (init && !init.done) {
      // The id was persisted before sending, so after a crash we can tell whether it went through.
      let snap = await this.exchange.getOrder(this.symbol, init.clientOrderId);
      if (!snap) {
        logger.info(`Market-buying ${init.quantity} ${this.filters.baseAsset} for sell-side grid slots`);
        snap = await this.exchange.placeMarketOrder({
          filters: this.filters,
          side: 'BUY',
          quantity: init.quantity,
          clientOrderId: init.clientOrderId,
        });
      }
      this.applyExecution('BUY', snap.executedQty, snap.cummulativeQuoteQty);
      init.done = true;
      this.save();
    }

    this.state.gridPlaced = true;
    this.save();
    await this.ensureOrders();
  }

  // ---------------------------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------------------------

  private async runLoop(): Promise<void> {
    while (!this.stopRequested) {
      try {
        await this.tick();
        this.lastTickOkAt = Date.now();
        this.consecutiveFailures = 0;
        this.failureAlertSent = false;
      } catch (err) {
        this.consecutiveFailures++;
        logger.error('Tick failed', { error: errorMessage(err), consecutive: this.consecutiveFailures });
        if (this.consecutiveFailures >= FAILURE_ALERT_THRESHOLD && !this.failureAlertSent) {
          this.failureAlertSent = true;
          await this.notifier.crash(
            new Error(
              `The last ${this.consecutiveFailures} checks failed (latest: ${errorMessage(err)}). ` +
                'The bot is still running and retrying, but risk rules cannot be evaluated while this persists.',
            ),
            this.config.binance.useTestnet,
            this.symbol,
          );
        }
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.config.checkIntervalSeconds * 1000);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  async tick(): Promise<void> {
    const price = await this.exchange.getPrice(this.symbol);
    this.lastPrice = price;

    if (this.state.status === 'RUNNING') {
      try {
        await this.syncOrders();
      } catch (err) {
        // Keep going: risk rules must still run on the last known ledger.
        logger.error('Order sync failed', { error: errorMessage(err) });
      }
    }

    const decision = evaluateRisk({
      price,
      ledger: this.state.ledger,
      grid: this.config.grid,
      risk: this.config.risk,
      status: this.state.status,
      breakoutAlertActive: this.state.breakoutAlertActive,
    });

    switch (decision.action) {
      case 'STOP_LOSS':
        await this.stopLoss(price, decision.drawdownPercent);
        break;
      case 'BREAKOUT_PAUSE':
        await this.pause(price, `Price ${price} broke ${decision.direction.toLowerCase()} the grid range`, []);
        break;
      case 'BREAKOUT_ALERT':
        await this.breakoutAlert(price, decision.direction);
        break;
      case 'NONE':
        if (this.state.breakoutAlertActive && price >= this.config.grid.lowerBound && price <= this.config.grid.upperBound) {
          logger.info('Price is back inside the grid range');
          this.state.breakoutAlertActive = false;
          this.save();
        }
        break;
    }

    if (this.state.status === 'RUNNING') {
      await this.ensureOrders();
    } else if (this.state.status === 'STOPPED' && !this.state.liquidationComplete) {
      await this.retryLiquidation(price);
    }

    const equity = computeEquity(this.state.ledger, price);
    logger.debug('Tick', {
      price,
      status: this.state.status,
      equity: Number(equity.toFixed(2)),
      drawdownPct: Number(computeDrawdownPercent(this.config.grid.capitalUsdt, equity).toFixed(2)),
    });

    await this.maybeHeartbeat();
  }

  // ---------------------------------------------------------------------------------------------
  // Order management
  // ---------------------------------------------------------------------------------------------

  /** Detect fills / external cancellations for every tracked order. */
  private async syncOrders(): Promise<void> {
    const tracked = this.state.slots.filter((s) => s.clientOrderId !== null);
    if (tracked.length === 0) return;

    const open = await this.exchange.getOpenOrders(this.symbol);
    const openIds = new Set(open.map((o) => o.clientOrderId));

    for (const slot of tracked) {
      const id = slot.clientOrderId;
      if (id === null || openIds.has(id)) continue;
      const snap = await this.exchange.getOrder(this.symbol, id);
      this.handleFinishedOrder(slot, snap);
    }
  }

  /** Apply the final state of an order that is no longer open on the exchange. */
  private handleFinishedOrder(slot: OrderState, snap: OrderSnapshot | null): void {
    if (snap === null) {
      // Id was reserved but the order never reached the exchange (e.g. crash between save and send).
      logger.warn(`Slot ${slot.index}: order ${slot.clientOrderId} not found on exchange; will re-place`);
      this.clearOrder(slot);
      return;
    }
    if (!TERMINAL_ORDER_STATUSES.has(snap.status)) return;

    if (snap.status === 'FILLED') {
      this.applyExecution(slot.side, snap.executedQty, snap.cummulativeQuoteQty);
      this.state.ledger.realizedTrades++;
      const next: Side = slot.side === 'BUY' ? 'SELL' : 'BUY';
      logger.info(`Slot ${slot.index}: ${slot.side} filled`, {
        qty: snap.executedQty,
        price: slot.side === 'BUY' ? slot.buyPrice : slot.sellPrice,
        next: `${next} @ ${next === 'BUY' ? slot.buyPrice : slot.sellPrice}`,
      });
      slot.side = next;
    } else {
      if (snap.executedQty > 0) this.applyExecution(slot.side, snap.executedQty, snap.cummulativeQuoteQty);
      logger.warn(`Slot ${slot.index}: order ${snap.clientOrderId} ended as ${snap.status}; will re-place`, {
        executedQty: snap.executedQty,
      });
    }
    this.clearOrder(slot);
  }

  /** Place an order for every slot that doesn't have one. Only ever called while RUNNING. */
  private async ensureOrders(): Promise<void> {
    const pending = this.state.slots.filter((s) => s.clientOrderId === null);
    if (pending.length === 0) return;

    let freeBase: number | null = null;
    if (pending.some((s) => s.side === 'SELL')) {
      const balances = await this.exchange.getBalances();
      freeBase = balances.get(this.filters.baseAsset)?.free ?? 0;
    }

    for (const slot of pending) {
      if (this.state.status !== 'RUNNING' || this.stopRequested) return;

      const price = slot.side === 'BUY' ? slot.buyPrice : slot.sellPrice;
      let quantity = slot.side === 'BUY' ? slot.quantity : sellQuantity(slot.quantity, this.filters.stepSize);
      if (slot.side === 'SELL' && freeBase !== null) {
        quantity = roundToStep(Math.min(quantity, freeBase), this.filters.stepSize, 'down');
      }
      if (quantity < this.filters.minQty || quantity * price < this.filters.minNotional) {
        logger.warn(`Slot ${slot.index}: ${slot.side} quantity ${quantity} too small to place; skipping for now`);
        continue;
      }

      slot.clientOrderId = this.newClientOrderId(`s${slot.index}`);
      this.save(); // persist the id BEFORE sending so a crash can't orphan the order
      try {
        const res = await this.exchange.placeLimitOrder({
          filters: this.filters,
          side: slot.side,
          quantity,
          price,
          clientOrderId: slot.clientOrderId,
        });
        slot.orderId = res.orderId;
        if (slot.side === 'SELL' && freeBase !== null) freeBase -= quantity;
        logger.info(`Slot ${slot.index}: placed ${slot.side} ${quantity} @ ${price}`);
      } catch (err) {
        // A coded Binance error means the exchange rejected it (no order exists). Otherwise the
        // outcome is unknown; keep the id and let the next sync find out.
        if (binanceErrorCode(err) !== null) this.clearOrder(slot);
        logger.error(`Slot ${slot.index}: failed to place ${slot.side} @ ${price}`, { error: errorMessage(err) });
      }
      this.save();
      await sleep(100); // stay well under order rate limits
    }
  }

  /**
   * Cancel every order this session has working. Fills discovered while cancelling are booked
   * into the ledger. Returns human-readable notes about what happened.
   */
  private async cancelAllGridOrders(): Promise<string[]> {
    const notes: string[] = [];
    let cancelled = 0;
    let failures = 0;

    for (const slot of this.state.slots) {
      const id = slot.clientOrderId;
      if (id === null) continue;
      try {
        let snap = await this.exchange.cancelOrder(this.symbol, id);
        // Already gone? Find out whether it filled first.
        if (snap === null) snap = await this.exchange.getOrder(this.symbol, id);
        if (snap && snap.status === 'CANCELED') cancelled++;
        this.handleFinishedOrder(slot, snap);
      } catch (err) {
        failures++;
        logger.error(`Failed to cancel order ${id}`, { error: errorMessage(err) });
      }
    }

    // Sweep for any order from this session that isn't tracked (e.g. crash between send and save).
    try {
      const prefix = `gb-${this.state.sessionId}-`;
      const strays = (await this.exchange.getOpenOrders(this.symbol)).filter((o) => o.clientOrderId.startsWith(prefix));
      for (const o of strays) {
        const snap = await this.exchange.cancelOrder(this.symbol, o.clientOrderId);
        if (snap && snap.executedQty > 0) this.applyExecution(snap.side, snap.executedQty, snap.cummulativeQuoteQty);
        cancelled++;
      }
    } catch (err) {
      failures++;
      logger.error('Failed to sweep open orders', { error: errorMessage(err) });
    }

    this.save();
    if (cancelled > 0) notes.push(`Cancelled ${cancelled} open grid order(s)`);
    if (failures > 0) notes.push(`WARNING: ${failures} order cancellation(s) failed - check open orders on Binance`);
    if (cancelled === 0 && failures === 0) notes.push('No open grid orders needed cancelling');
    return notes;
  }

  // ---------------------------------------------------------------------------------------------
  // Safety actions
  // ---------------------------------------------------------------------------------------------

  /** Rule 1: price left the range -> cancel grid orders, PAUSE, notify. */
  private async pause(price: number, reason: string, extraActions: string[]): Promise<void> {
    logger.warn(`PAUSING: ${reason}`);
    this.setStatus('PAUSED', reason);
    const actions = [...extraActions, ...(await this.cancelAllGridOrders())];
    actions.push('Set the bot to PAUSED; it will not place new orders or resume on its own');
    await this.notifier.incident(this.incidentContext('BREAKOUT_PAUSE', price, actions));
  }

  /** BREAKOUT_PAUSE=false: alert once per excursion, keep the grid as is. */
  private async breakoutAlert(price: number, direction: 'ABOVE' | 'BELOW'): Promise<void> {
    logger.warn(`Price ${price} is ${direction.toLowerCase()} the grid range (BREAKOUT_PAUSE=false, alert only)`);
    this.state.breakoutAlertActive = true;
    this.save();
    await this.notifier.incident(
      this.incidentContext('BREAKOUT_ALERT', price, [
        'Left existing grid orders in place because BREAKOUT_PAUSE is set to false',
        'The stop-loss rule remains active',
      ]),
    );
  }

  /** Rule 2: drawdown exceeded the stop-loss -> STOP, cancel everything, market-sell, notify. */
  private async stopLoss(price: number, drawdownPercent: number): Promise<void> {
    const reason = `Drawdown ${drawdownPercent.toFixed(2)}% exceeded stop-loss ${this.config.risk.stopLossPercent}%`;
    logger.error(`STOP-LOSS: ${reason}`);
    // Persist the halt first; everything after this is best-effort and retried if it fails.
    this.setStatus('STOPPED', reason);
    this.state.liquidationComplete = false;
    this.save();

    const actions = await this.liquidate(price);
    const ctx = this.incidentContext('STOP_LOSS', price, actions);
    ctx.drawdownPercent = drawdownPercent;
    await this.notifier.incident(ctx);
  }

  private async retryLiquidation(price: number): Promise<void> {
    logger.warn('Retrying stop-loss liquidation');
    const actions = await this.liquidate(price);
    if (this.state.liquidationComplete) {
      await this.notifier.incident(
        this.incidentContext('STOP_LOSS', price, ['Completed a stop-loss sell that had previously failed', ...actions]),
      );
    }
  }

  /** Cancel all grid orders and market-sell the bot's coins. Never throws. */
  private async liquidate(price: number): Promise<string[]> {
    const actions: string[] = [];
    try {
      actions.push(...(await this.cancelAllGridOrders()));
    } catch (err) {
      actions.push(`WARNING: cancelling orders failed: ${errorMessage(err)}`);
    }

    try {
      const balances = await this.exchange.getBalances();
      const freeBase = balances.get(this.filters.baseAsset)?.free ?? 0;
      const qty = roundToStep(Math.min(this.state.ledger.base, freeBase), this.filters.stepSize, 'down');

      if (qty < this.filters.minQty || qty * price < this.filters.minNotional) {
        actions.push(
          qty > 0
            ? `Left ${qty} ${this.filters.baseAsset} unsold: below the exchange minimum order size`
            : `No ${this.filters.baseAsset} held by the bot, so nothing to sell`,
        );
      } else {
        const snap = await this.marketSellWithRetry(qty);
        this.applyExecution('SELL', snap.executedQty, snap.cummulativeQuoteQty);
        const avg = snap.executedQty > 0 ? snap.cummulativeQuoteQty / snap.executedQty : price;
        actions.push(
          `Sold ${snap.executedQty} ${this.filters.baseAsset} at market (avg ~${avg.toFixed(2)}) for ` +
            `${snap.cummulativeQuoteQty.toFixed(2)} ${this.filters.quoteAsset}`,
        );
      }
      this.state.liquidationComplete = true;
      actions.push('Set the bot to STOPPED; it will not trade again until reconfigured and restarted');
    } catch (err) {
      logger.error('Stop-loss sell FAILED; will retry every tick', { error: errorMessage(err) });
      actions.push(
        `WARNING: the market sell FAILED (${errorMessage(err)}). The bot is STOPPED and will keep retrying ` +
          'the sell every check. You may want to check your Binance account directly.',
      );
    }
    this.save();
    return actions;
  }

  /** Market sell with retries; checks whether a previous attempt went through before re-sending. */
  private async marketSellWithRetry(quantity: number): Promise<OrderSnapshot> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const clientOrderId = this.newClientOrderId('sl');
      this.save();
      try {
        return await this.exchange.placeMarketOrder({ filters: this.filters, side: 'SELL', quantity, clientOrderId });
      } catch (err) {
        lastErr = err;
        logger.error(`Stop-loss market sell attempt ${attempt} failed`, { error: errorMessage(err) });
        await sleep(2_000 * attempt);
        const existing = await this.exchange.getOrder(this.symbol, clientOrderId).catch(() => null);
        if (existing && existing.status === 'FILLED') return existing;
      }
    }
    throw lastErr;
  }

  // ---------------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------------

  /** Book an execution into the bot's ledger. Fees are estimated at ESTIMATED_FEE_RATE. */
  private applyExecution(side: Side, executedQty: number, quoteQty: number): void {
    const ledger = this.state.ledger;
    if (side === 'BUY') {
      ledger.quote -= quoteQty;
      ledger.base += executedQty * (1 - ESTIMATED_FEE_RATE);
    } else {
      ledger.base = Math.max(0, ledger.base - executedQty);
      ledger.quote += quoteQty * (1 - ESTIMATED_FEE_RATE);
    }
    ledger.base = roundToStep(ledger.base, this.filters.stepSize / 1000, 'nearest');
  }

  private clearOrder(slot: OrderState): void {
    slot.clientOrderId = null;
    slot.orderId = null;
  }

  private setStatus(status: BotStatus, reason: string): void {
    this.state.status = status;
    this.state.statusReason = reason;
    this.state.statusChangedAt = new Date().toISOString();
    this.save();
  }

  /** Binance allows [.A-Za-z0-9:/_-]{1,36}; the session prefix lets us find our own orders. */
  private newClientOrderId(tag: string): string {
    this.state.orderCounter++;
    return `gb-${this.state.sessionId}-${tag}-${this.state.orderCounter}`;
  }

  private save(): void {
    this.store.save(this.state);
  }

  private incidentContext(type: IncidentType, price: number, actionsTaken: string[]): IncidentContext {
    const { grid, risk } = this.config;
    const equity = computeEquity(this.state.ledger, price);
    return {
      type,
      occurredAt: new Date().toISOString(),
      symbol: grid.symbol,
      price,
      lowerBound: grid.lowerBound,
      upperBound: grid.upperBound,
      capitalUsdt: grid.capitalUsdt,
      equityUsdt: Number(equity.toFixed(2)),
      drawdownPercent: Number(computeDrawdownPercent(grid.capitalUsdt, equity).toFixed(2)),
      stopLossPercent: risk.stopLossPercent,
      actionsTaken,
      resultingStatus: this.state.status,
      testnet: this.config.binance.useTestnet,
    };
  }

  snapshot(): StatusSnapshot {
    const { grid } = this.config;
    const equity = this.lastPrice === null ? null : computeEquity(this.state.ledger, this.lastPrice);
    return {
      status: this.state.status,
      statusReason: this.state.statusReason,
      symbol: grid.symbol,
      price: this.lastPrice,
      lowerBound: grid.lowerBound,
      upperBound: grid.upperBound,
      capitalUsdt: grid.capitalUsdt,
      equityUsdt: equity,
      drawdownPercent: equity === null ? null : computeDrawdownPercent(grid.capitalUsdt, equity),
      ledger: { ...this.state.ledger },
      workingOrders: this.state.slots.filter((s) => s.clientOrderId !== null).length,
      uptimeHours: (Date.now() - this.startedAt) / 3_600_000,
      testnet: this.config.binance.useTestnet,
    };
  }

  /**
   * Liveness for the HTTP health endpoint: healthy once a check has succeeded recently.
   * Deliberately exposes no balances or prices, since the endpoint may be public.
   */
  health(): { healthy: boolean; status: BotStatus | 'STARTING'; lastCheckAt: string | null } {
    const maxAgeMs = this.config.checkIntervalSeconds * 1000 * 3 + 60_000;
    const fresh = this.lastTickOkAt !== null && Date.now() - this.lastTickOkAt < maxAgeMs;
    return {
      healthy: fresh,
      status: this.loopDone && this.state ? this.state.status : 'STARTING',
      lastCheckAt: this.lastTickOkAt === null ? null : new Date(this.lastTickOkAt).toISOString(),
    };
  }

  private async maybeHeartbeat(): Promise<void> {
    const last = this.state.lastHeartbeatAt ? Date.parse(this.state.lastHeartbeatAt) : 0;
    if (Date.now() - last < this.config.heartbeatIntervalHours * 3_600_000) return;
    // Record the attempt even if sending fails, so a broken SMTP setup doesn't retry every tick.
    this.state.lastHeartbeatAt = new Date().toISOString();
    this.save();
    await this.notifier.status('Heartbeat', this.snapshot());
  }

  // ---------------------------------------------------------------------------------------------
  // Shutdown / crash
  // ---------------------------------------------------------------------------------------------

  /** Graceful stop: finish the current tick, mark a clean shutdown. Open grid orders stay on the exchange. */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.wake?.();
    if (this.loopDone) await this.loopDone;
    if (this.state) {
      this.state.running = false;
      this.save();
    }
    logger.info('Bot stopped cleanly');
  }

  /** Synchronously record a crash so the next start can report it. Safe to call from crash handlers. */
  recordCrash(err: unknown): void {
    if (!this.state) return;
    try {
      this.state.lastCrash = { at: new Date().toISOString(), message: errorMessage(err) };
      this.save();
    } catch (saveErr) {
      logger.error('Could not persist crash info', { error: errorMessage(saveErr) });
    }
  }
}
