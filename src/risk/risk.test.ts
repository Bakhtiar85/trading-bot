import { describe, expect, it } from 'vitest';
import type { GridConfig, Ledger, RiskConfig } from '../types';
import { checkLedgerAgainstAccount, evaluateRisk } from './index';

const grid: GridConfig = { symbol: 'BTCUSDT', lowerBound: 90000, upperBound: 100000, levels: 10, capitalUsdt: 100 };
const risk: RiskConfig = { stopLossPercent: 15, breakoutPause: true };
const ledger = (quote: number, base: number): Ledger => ({ quote, base, realizedTrades: 0 });

describe('evaluateRisk', () => {
  const base = { grid, risk, breakoutAlertActive: false };

  it('triggers the stop-loss past the threshold, while RUNNING or PAUSED', () => {
    // 50 USDT + 0.0005 BTC @ 60000 = 80 USDT -> 20% drawdown
    const input = { ...base, price: 60000, ledger: ledger(50, 0.0005) };
    expect(evaluateRisk({ ...input, status: 'RUNNING' }).action).toBe('STOP_LOSS');
    expect(evaluateRisk({ ...input, status: 'PAUSED' }).action).toBe('STOP_LOSS');
  });

  it('never acts once STOPPED', () => {
    expect(evaluateRisk({ ...base, price: 1, ledger: ledger(0, 0.001), status: 'STOPPED' }).action).toBe('NONE');
  });

  it('pauses on breakout, or alerts once in alert-only mode', () => {
    const input = { ...base, price: 101000, ledger: ledger(100, 0), status: 'RUNNING' as const };
    expect(evaluateRisk(input)).toEqual({ action: 'BREAKOUT_PAUSE', direction: 'ABOVE' });
    const alertOnly = { ...input, risk: { ...risk, breakoutPause: false } };
    expect(evaluateRisk(alertOnly).action).toBe('BREAKOUT_ALERT');
    expect(evaluateRisk({ ...alertOnly, breakoutAlertActive: true }).action).toBe('NONE');
  });
});

describe('checkLedgerAgainstAccount', () => {
  it('passes when the account holds what the ledger says', () => {
    const r = checkLedgerAgainstAccount(ledger(60, 0.0004), { base: 0.0004, quote: 60 }, 95000, 100);
    expect(r.exceeded).toBe(false);
    expect(r.shortfallUsdt).toBe(0);
  });

  it('ignores surplus funds in the account', () => {
    const r = checkLedgerAgainstAccount(ledger(60, 0.0004), { base: 0.01, quote: 500 }, 95000, 100);
    expect(r.exceeded).toBe(false);
  });

  it('tolerates small fee/rounding drift', () => {
    const r = checkLedgerAgainstAccount(ledger(60, 0.0004), { base: 0.0004, quote: 59.7 }, 95000, 100);
    expect(r.exceeded).toBe(false);
    expect(r.toleranceUsdt).toBe(1); // 1% of 100 USDT
  });

  it('flags missing coins even when surplus USDT would offset them in total value', () => {
    // 0.0003 BTC (~28.5 USDT) is missing; the account's extra 30 USDT must not mask that.
    const r = checkLedgerAgainstAccount(ledger(60, 0.0004), { base: 0.0001, quote: 90 }, 95000, 100);
    expect(r.exceeded).toBe(true);
    expect(r.baseShortfall).toBeCloseTo(0.0003, 10);
    expect(r.shortfallUsdt).toBeCloseTo(28.5, 6);
  });
});
