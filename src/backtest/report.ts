/** Turns strategy results into comparable statistics, a terminal table and a CSV of every trade. */
import type { SimSettings, StrategyResult } from './types';

export interface Stats {
  name: string;
  returnPercent: number;
  finalEquity: number;
  maxDrawdownPercent: number;
  fills: number;
  closedSells: number;
  winRatePercent: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  feesPaid: number;
  timeInMarketPercent: number;
  endState: string;
  error?: string;
}

const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

export function computeStats(r: StrategyResult, settings: SimSettings): Stats {
  const pnls = r.trades.filter((t) => t.side === 'SELL' && t.pnl !== undefined).map((t) => t.pnl as number);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  return {
    name: r.name,
    returnPercent: ((r.finalEquity - settings.capitalUsdt) / settings.capitalUsdt) * 100,
    finalEquity: r.finalEquity,
    maxDrawdownPercent: r.maxDrawdownPercent,
    fills: r.trades.length,
    closedSells: pnls.length,
    winRatePercent: pnls.length === 0 ? null : (wins.length / pnls.length) * 100,
    avgWin: mean(wins),
    avgLoss: mean(losses),
    feesPaid: r.feesPaid,
    timeInMarketPercent: r.timeInMarket * 100,
    endState: r.endState,
    ...(r.error ? { error: r.error } : {}),
  };
}

const money = (n: number | null): string => (n === null ? '-' : `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`);
const pct = (n: number | null, signed = false): string => (n === null ? '-' : `${signed && n > 0 ? '+' : ''}${n.toFixed(1)}%`);

export function formatTable(stats: Stats[]): string {
  const headers = ['Strategy', 'Return', 'Final', 'Max DD', 'Fills', 'Sells', 'Win %', 'Avg win', 'Avg loss', 'Fees', 'In mkt', 'End state'];
  const rows = stats.map((s) =>
    s.error
      ? [s.name, 'ERROR', '-', '-', '-', '-', '-', '-', '-', '-', '-', s.error]
      : [
          s.name,
          pct(s.returnPercent, true),
          money(s.finalEquity),
          pct(-s.maxDrawdownPercent),
          String(s.fills),
          String(s.closedSells),
          pct(s.winRatePercent),
          money(s.avgWin),
          money(s.avgLoss),
          money(s.feesPaid),
          pct(s.timeInMarketPercent),
          s.endState,
        ],
  );
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => (i === 0 || i === cells.length - 1 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join('  ');
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

export function tradesCsv(results: StrategyResult[]): string {
  const lines = ['strategy,time,side,price,qty,fee,pnl,reason'];
  for (const r of results) {
    for (const t of r.trades) {
      lines.push(
        [r.name, new Date(t.time).toISOString(), t.side, t.price.toFixed(2), t.qty, t.fee.toFixed(6), t.pnl?.toFixed(4) ?? '', `"${t.reason}"`].join(','),
      );
    }
  }
  return lines.join('\n');
}
