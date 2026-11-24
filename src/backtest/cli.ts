/**
 * Backtest entry point. Replays historical 1-minute BTC/USDT candles through each strategy and
 * prints a comparison. Uses only Binance's public market data; no API key, no live trading.
 *
 *   npm run backtest -- --from 2026-05-01 --to 2026-11-21 --capital 40
 *   npm run backtest -- --help
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Exchange } from '../exchange';
import { findGaps, loadCandles } from './data';
import { computeStats, formatTable, tradesCsv } from './report';
import { runGrid } from './strategies/grid';
import { runHold } from './strategies/hold';
import { runStructure } from './strategies/structure';
import type { Candle, SimSettings, StrategyResult } from './types';

const DAY = 86_400_000;
const ALL = ['grid', 'grid-exit', 'bos-1m', 'bos-15m', 'bos-1h', 'hold'] as const;

const HELP = `Usage: npm run backtest -- [options]

  --from <date>        start (UTC), e.g. 2026-05-01 or 2026-11-13T03:57   [default: 30 days ago]
  --to <date>          end (UTC); a plain date includes that whole day       [default: now]
  --symbol <pair>      USDT pair                                             [BTCUSDT]
  --capital <usdt>     starting capital                                      [40]
  --lower <price>      grid lower bound                                      [first price -10%]
  --upper <price>      grid upper bound                                      [first price +10%]
  --levels <n>         grid levels                                           [6]
  --stop-loss <pct>    stop-loss %, 0 = off (not applied to "hold")          [15]
  --fee <pct>          fee per fill, % (0.075 with BNB discount)             [0.1]
  --slippage <pct>     slippage on market orders, %                          [0.02]
  --swing <n>          candles on each side that define a swing              [2]
  --strategies <list>  comma-separated: ${ALL.join(',')}
  --out <dir>          where results are written                             [data/backtests]
`;

function parseDate(value: string | undefined, fallback: number, endOfDay: boolean): number {
  if (!value) return fallback;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value.endsWith('Z') ? value : `${value}Z`);
  if (!Number.isFinite(t)) throw new Error(`Invalid date: ${value}`);
  return endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value) ? t + DAY : t;
}

function num(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      symbol: { type: 'string', default: 'BTCUSDT' },
      capital: { type: 'string' },
      lower: { type: 'string' },
      upper: { type: 'string' },
      levels: { type: 'string' },
      'stop-loss': { type: 'string' },
      fee: { type: 'string' },
      slippage: { type: 'string' },
      swing: { type: 'string' },
      strategies: { type: 'string' },
      out: { type: 'string', default: path.join('data', 'backtests') },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }

  const now = Date.now();
  const to = Math.min(parseDate(values.to, now, true), now);
  const from = parseDate(values.from, to - 30 * DAY, false);
  if (from >= to) throw new Error('--from must be before --to');
  const symbol = values.symbol.toUpperCase();
  const wanted = (values.strategies ?? ALL.join(',')).split(',').map((s) => s.trim());
  for (const s of wanted) if (!(ALL as readonly string[]).includes(s)) throw new Error(`Unknown strategy "${s}"`);

  // Public endpoint: real tick/lot/min-notional rules for the symbol, no API key required.
  const exchange = new Exchange({ apiKey: '', apiSecret: '', useTestnet: false, httpBase: 'https://api.binance.com' });
  const filters = await exchange.getSymbolFilters(symbol);

  console.log(`Loading ${symbol} 1m candles ${new Date(from).toISOString()} .. ${new Date(to).toISOString()}`);
  const candles: Candle[] = await loadCandles(symbol, from, to, path.join('data', 'klines'), (m) => console.log(`  ${m}`));
  if (candles.length === 0) throw new Error('No candles in that period');
  const gaps = findGaps(candles);
  const missing = gaps.reduce((a, g) => a + g.missingMinutes, 0);
  console.log(`  ${candles.length} candles${gaps.length ? `, ${gaps.length} gap(s) totalling ${missing} missing minutes` : ', no gaps'}`);

  const firstPrice = (candles[0] as Candle).open;
  const lastPrice = (candles.at(-1) as Candle).close;
  const settings: SimSettings = {
    capitalUsdt: num(values.capital, 40, 'capital'),
    feeRate: num(values.fee, 0.1, 'fee') / 100,
    slippage: num(values.slippage, 0.02, 'slippage') / 100,
    stopLossPercent: num(values['stop-loss'], 15, 'stop-loss'),
    stepSize: filters.stepSize,
    minQty: filters.minQty,
    minNotional: filters.minNotional,
  };
  const grid = {
    lowerBound: num(values.lower, Math.round((firstPrice * 0.9) / 100) * 100, 'lower'),
    upperBound: num(values.upper, Math.round((firstPrice * 1.1) / 100) * 100, 'upper'),
    levels: num(values.levels, 6, 'levels'),
    filters,
  };
  const swing = num(values.swing, 2, 'swing');
  const gridDesc = `${grid.lowerBound}-${grid.upperBound}, ${grid.levels} levels`;

  const runners: Record<(typeof ALL)[number], () => StrategyResult> = {
    grid: () => runGrid(candles, settings, { ...grid, exitOnDownBreak: false }, 'grid', `live grid (${gridDesc}), pauses on breakout`),
    'grid-exit': () =>
      runGrid(candles, settings, { ...grid, exitOnDownBreak: true }, 'grid-exit', `grid (${gridDesc}), sells all on break below`),
    'bos-1m': () => runStructure(candles, settings, 1, swing, 'bos-1m', `structure break, 1m candles, swing ${swing}`),
    'bos-15m': () => runStructure(candles, settings, 15, swing, 'bos-15m', `structure break, 15m candles, swing ${swing}`),
    'bos-1h': () => runStructure(candles, settings, 60, swing, 'bos-1h', `structure break, 1h candles, swing ${swing}`),
    hold: () => runHold(candles, { ...settings, stopLossPercent: 0 }, 'hold', 'buy at start, hold to end'),
  };

  const results = wanted.map((s) => runners[s as (typeof ALL)[number]]());
  const stats = results.map((r) => computeStats(r, settings));

  console.log(
    `\nPeriod: ${new Date(from).toISOString().slice(0, 16)} .. ${new Date(to).toISOString().slice(0, 16)} UTC   ` +
      `BTC ${firstPrice} -> ${lastPrice} (${(((lastPrice - firstPrice) / firstPrice) * 100).toFixed(1)}%)`,
  );
  console.log(
    `Capital $${settings.capitalUsdt}, fee ${(settings.feeRate * 100).toFixed(3)}%/fill, slippage ${(settings.slippage * 100).toFixed(3)}%, ` +
      `stop-loss ${settings.stopLossPercent || 'off'}${settings.stopLossPercent ? '%' : ''}, grid ${gridDesc}\n`,
  );
  console.log(formatTable(stats));
  console.log('\nMax DD = largest fall from a peak. Sells/Win % count closed positions. Fees are included in Final and Return.');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.mkdirSync(values.out, { recursive: true });
  const base = path.join(values.out, `backtest-${symbol}-${stamp}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify({ symbol, from, to, settings, grid: { ...grid, filters: undefined }, swing, stats }, null, 2));
  fs.writeFileSync(`${base}-trades.csv`, tradesCsv(results));
  console.log(`\nSaved: ${base}.json and ${base}-trades.csv`);
}

main().catch((err: unknown) => {
  console.error(`Backtest failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
