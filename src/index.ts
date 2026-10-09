import { GridBot } from './bot';
import { ConfigError, loadConfig } from './config';
import { Exchange } from './exchange';
import { configureLogger, errorMessage, logger } from './logger';
import { startHealthServer } from './health';
import { createMailer, Notifier } from './notifications';
import { StateStore } from './risk';
import { startStatusServer } from './status';
import type { Config } from './types';

let bot: GridBot | null = null;
let notifier: Notifier | null = null;
let config: Config | null = null;
let exiting = false;

/** Last-gasp handler: persist crash info, send one email, exit non-zero so PM2 restarts us. */
async function crash(err: unknown): Promise<void> {
  if (exiting) return;
  exiting = true;
  logger.error('Fatal error; exiting', { error: errorMessage(err), stack: err instanceof Error ? err.stack : undefined });
  bot?.recordCrash(err);
  if (notifier && config) await notifier.crash(err, config.binance.useTestnet, config.grid.symbol);
  // Give the file transport a moment to flush.
  setTimeout(() => process.exit(1), 500);
}

async function shutdown(signal: string): Promise<void> {
  if (exiting) return;
  exiting = true;
  logger.info(`Received ${signal}; shutting down`);
  const force = setTimeout(() => process.exit(1), 30_000);
  try {
    await bot?.stop();
  } finally {
    clearTimeout(force);
    process.exit(0);
  }
}

process.on('uncaughtException', (err) => void crash(err));
process.on('unhandledRejection', (reason) => void crash(reason));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

async function main(): Promise<void> {
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // No email here: SMTP settings may be what's broken. Fix .env and restart.
      logger.error(`Configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  configureLogger(config.logLevel, config.logDir);
  if (!config.binance.useTestnet) logger.warn('*** MAINNET MODE: trading with REAL funds ***');
  if (!config.smtp) logger.warn('SMTP is not configured; notifications will only be logged');
  if (!config.anthropicApiKey) logger.warn('ANTHROPIC_API_KEY not set; incident emails will use a plain template');

  // Listen before the (possibly slow) bot startup so hosts that scan for a port don't time out.
  const port = Number(process.env.PORT);
  if (Number.isInteger(port) && port > 0) startHealthServer(port, () => bot);
  // Started early too, so it can show startup problems in the logs.
  if (config.statusPage) startStatusServer(config.statusPage, config.logDir, () => bot);

  notifier = new Notifier(createMailer(config.smtp));
  bot = new GridBot(config, new Exchange(config.binance), new StateStore(config.dataDir), notifier);
  await bot.start();
}

main().catch((err: unknown) => void crash(err));
