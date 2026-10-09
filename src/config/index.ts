import { createHash } from 'node:crypto';
import path from 'node:path';
import dotenv from 'dotenv';
import type { Config, SmtpConfig, StatusPageConfig } from '../types';

const MAINNET_HTTP_BASE = 'https://api.binance.com';
// Binance Spot Testnet (keys from https://testnet.binance.vision). Note: binance-api-node's own
// `testnet: true` flag points at demo-api.binance.com (Demo Trading), which uses different keys,
// so we set httpBase explicitly instead.
const TESTNET_HTTP_BASE = 'https://testnet.binance.vision';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

function str(env: Env, key: string, required: boolean): string {
  const raw = env[key];
  const value = raw === undefined ? '' : raw.trim();
  if (required && value === '') throw new ConfigError(`Missing required env var ${key}`);
  return value;
}

function num(env: Env, key: string, fallback?: number): number {
  const raw = str(env, key, fallback === undefined);
  if (raw === '' && fallback !== undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ConfigError(`Env var ${key} must be a number, got "${raw}"`);
  return value;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = str(env, key, false).toLowerCase();
  if (raw === '') return fallback;
  if (['true', '1', 'yes'].includes(raw)) return true;
  if (['false', '0', 'no'].includes(raw)) return false;
  throw new ConfigError(`Env var ${key} must be true/false, got "${raw}"`);
}

function loadSmtp(env: Env): SmtpConfig | null {
  const keys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'NOTIFY_EMAIL_TO'];
  const present = keys.filter((k) => str(env, k, false) !== '');
  if (present.length === 0) return null;
  if (present.length !== keys.length) {
    const missing = keys.filter((k) => !present.includes(k));
    throw new ConfigError(`SMTP is partially configured; missing: ${missing.join(', ')}`);
  }
  return {
    host: str(env, 'SMTP_HOST', true),
    port: num(env, 'SMTP_PORT'),
    user: str(env, 'SMTP_USER', true),
    pass: str(env, 'SMTP_PASS', true),
    to: str(env, 'NOTIFY_EMAIL_TO', true),
  };
}

function loadStatusPage(env: Env): StatusPageConfig | null {
  const password = str(env, 'STATUS_PASSWORD', false);
  if (password === '') return null;
  if (password.length < 12) throw new ConfigError('STATUS_PASSWORD must be at least 12 characters');
  const port = num(env, 'STATUS_PORT', 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError('STATUS_PORT must be 1-65535');
  // Loopback by default: put an HTTPS reverse proxy (e.g. Caddy) in front. See README.
  return { password, host: str(env, 'STATUS_HOST', false) || '127.0.0.1', port };
}

/** Parse and validate an env map into a typed Config. Pure apart from reading `env`. */
export function parseConfig(env: Env): Config {
  const useTestnet = bool(env, 'BINANCE_USE_TESTNET', true);
  const lowerBound = num(env, 'GRID_LOWER_BOUND');
  const upperBound = num(env, 'GRID_UPPER_BOUND');
  const levels = num(env, 'GRID_LEVELS', 10);
  const capitalUsdt = num(env, 'CAPITAL_ALLOCATION_USDT');
  const stopLossPercent = num(env, 'STOP_LOSS_PERCENT', 15);
  const checkIntervalSeconds = num(env, 'CHECK_INTERVAL_SECONDS', 60);
  const heartbeatIntervalHours = num(env, 'HEARTBEAT_INTERVAL_HOURS', 24);

  if (lowerBound <= 0) throw new ConfigError('GRID_LOWER_BOUND must be > 0');
  if (upperBound <= lowerBound) throw new ConfigError('GRID_UPPER_BOUND must be greater than GRID_LOWER_BOUND');
  if (!Number.isInteger(levels) || levels < 2 || levels > 200) {
    throw new ConfigError('GRID_LEVELS must be an integer between 2 and 200');
  }
  if (capitalUsdt <= 0) throw new ConfigError('CAPITAL_ALLOCATION_USDT must be > 0');
  if (stopLossPercent <= 0 || stopLossPercent >= 100) {
    throw new ConfigError('STOP_LOSS_PERCENT must be between 0 and 100 (exclusive)');
  }
  if (checkIntervalSeconds < 10) throw new ConfigError('CHECK_INTERVAL_SECONDS must be >= 10');
  if (heartbeatIntervalHours <= 0) throw new ConfigError('HEARTBEAT_INTERVAL_HOURS must be > 0');

  const symbol = str(env, 'TRADING_PAIR', true).toUpperCase();
  if (!/^[A-Z0-9]+USDT$/.test(symbol)) {
    // Capital, drawdown and summaries are all denominated in USDT.
    throw new ConfigError('TRADING_PAIR must be a USDT-quoted pair, e.g. BTCUSDT');
  }

  const anthropicApiKey = str(env, 'ANTHROPIC_API_KEY', false);
  const dataDir = path.resolve(str(env, 'DATA_DIR', false) || 'data');
  const logDir = path.resolve(str(env, 'LOG_DIR', false) || 'logs');

  return {
    binance: {
      apiKey: str(env, 'BINANCE_API_KEY', true),
      apiSecret: str(env, 'BINANCE_API_SECRET', true),
      useTestnet,
      httpBase: useTestnet ? TESTNET_HTTP_BASE : MAINNET_HTTP_BASE,
    },
    grid: { symbol, lowerBound, upperBound, levels, capitalUsdt },
    risk: { stopLossPercent, breakoutPause: bool(env, 'BREAKOUT_PAUSE', true) },
    checkIntervalSeconds,
    heartbeatIntervalHours,
    statusPage: loadStatusPage(env),
    anthropicApiKey: anthropicApiKey === '' ? null : anthropicApiKey,
    smtp: loadSmtp(env),
    logLevel: str(env, 'LOG_LEVEL', false) || 'info',
    dataDir,
    logDir,
  };
}

/** Load .env from the working directory and return a validated Config. */
export function loadConfig(): Config {
  dotenv.config({ quiet: true });
  return parseConfig(process.env);
}

/**
 * Fingerprint of every setting that defines a grid session. If this changes between runs, the
 * previous (possibly PAUSED/STOPPED) session is archived and a new one starts. This is the ONLY
 * way the bot resumes trading after a halt: a manual config change plus a restart.
 */
export function configFingerprint(config: Config): string {
  const relevant = {
    symbol: config.grid.symbol,
    lower: config.grid.lowerBound,
    upper: config.grid.upperBound,
    levels: config.grid.levels,
    capital: config.grid.capitalUsdt,
    stopLoss: config.risk.stopLossPercent,
    testnet: config.binance.useTestnet,
  };
  return createHash('sha256').update(JSON.stringify(relevant)).digest('hex').slice(0, 16);
}
