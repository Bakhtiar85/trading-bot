/**
 * Historical 1-minute candles from Binance's public klines endpoint (no API key needed), cached
 * one file per UTC day. Days that are not complete yet are fetched but never cached.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from './types';

const BASE_URL = 'https://api.binance.com/api/v3/klines';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const PAGE = 1000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Parse one kline row: [openTime, open, high, low, close, ...]. */
export function parseKline(row: unknown): Candle {
  if (!Array.isArray(row) || row.length < 5) throw new Error('Unexpected kline row from Binance');
  const [openTime, open, high, low, close] = row.map(Number) as [number, number, number, number, number];
  if (![openTime, open, high, low, close].every(Number.isFinite)) throw new Error('Non-numeric kline row');
  return { openTime, open, high, low, close };
}

/** GET JSON with a few retries, so one network blip doesn't abort a long download. */
async function getJson(url: string, attempts = 4): Promise<unknown> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      lastErr = new Error(`Binance klines ${res.status}: ${(await res.text()).slice(0, 200)}`);
      if (res.status < 500 && res.status !== 429) break; // client errors won't fix themselves
    } catch (err) {
      lastErr = err;
    }
    if (i < attempts) await sleep(1000 * 2 ** i);
  }
  throw lastErr;
}

async function fetchRange(symbol: string, start: number, end: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = start;
  while (cursor < end) {
    const url = `${BASE_URL}?symbol=${symbol}&interval=1m&startTime=${cursor}&endTime=${end - 1}&limit=${PAGE}`;
    const rows = await getJson(url);
    if (!Array.isArray(rows)) throw new Error('Unexpected klines response');
    if (rows.length === 0) break;
    const page = rows.map(parseKline);
    out.push(...page);
    cursor = (page.at(-1)?.openTime ?? end) + MINUTE;
    await sleep(60); // stay far below the request-weight limit
  }
  return out;
}

const toCsv = (candles: Candle[]): string =>
  candles.map((c) => `${c.openTime},${c.open},${c.high},${c.low},${c.close}`).join('\n');

const fromCsv = (text: string): Candle[] =>
  text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const [openTime, open, high, low, close] = l.split(',').map(Number) as [number, number, number, number, number];
      return { openTime, open, high, low, close };
    });

/**
 * 1-minute candles with openTime in [from, to). Reads cached days from `cacheDir`, downloading
 * and caching any complete day that is missing.
 */
export async function loadCandles(
  symbol: string,
  from: number,
  to: number,
  cacheDir: string,
  onProgress?: (msg: string) => void,
): Promise<Candle[]> {
  const dir = path.join(cacheDir, `${symbol}-1m`);
  fs.mkdirSync(dir, { recursive: true });
  const all: Candle[] = [];
  const firstDay = Math.floor(from / DAY) * DAY;

  for (let day = firstDay; day < to; day += DAY) {
    const label = new Date(day).toISOString().slice(0, 10);
    const file = path.join(dir, `${label}.csv`);
    let candles: Candle[];
    if (fs.existsSync(file)) {
      candles = fromCsv(fs.readFileSync(file, 'utf8'));
    } else {
      onProgress?.(`downloading ${symbol} ${label}`);
      candles = await fetchRange(symbol, day, day + DAY);
      if (day + DAY <= Date.now() && candles.length > 0) fs.writeFileSync(file, toCsv(candles), 'utf8');
    }
    all.push(...candles.filter((c) => c.openTime >= from && c.openTime < to));
  }
  return all;
}

/** Missing minutes between consecutive candles (exchange outages, maintenance). */
export function findGaps(candles: Candle[]): Array<{ after: number; missingMinutes: number }> {
  const gaps: Array<{ after: number; missingMinutes: number }> = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1] as Candle;
    const cur = candles[i] as Candle;
    const diff = cur.openTime - prev.openTime;
    if (diff !== MINUTE) gaps.push({ after: prev.openTime, missingMinutes: diff / MINUTE - 1 });
  }
  return gaps;
}

/** True when this 1-minute candle is the last minute of its `minutes`-long UTC bucket (:14, :29, ...). */
export function isBucketClose(openTime: number, minutes: number): boolean {
  return (openTime + MINUTE) % (minutes * MINUTE) === 0;
}
