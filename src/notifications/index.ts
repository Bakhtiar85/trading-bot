/**
 * Email notifications. Composable pieces:
 *   - createMailer(): sends a subject/body (or just logs when SMTP isn't configured)
 *   - summarizeIncident(): Claude summary with a hard timeout, falling back to a template
 *   - format*Email(): pure functions that build email content
 *   - Notifier: convenience wrapper whose methods never throw
 */
import nodemailer from 'nodemailer';
import { DISCLAIMER, generateIncidentSummary } from '../ai';
import { errorMessage, logger } from '../logger';
import type { IncidentContext, SmtpConfig, StatusSnapshot } from '../types';

export interface EmailContent {
  subject: string;
  text: string;
}

export interface Mailer {
  send(email: EmailContent): Promise<void>;
}

export function createMailer(smtp: SmtpConfig | null): Mailer {
  if (smtp === null) {
    return {
      async send(email) {
        logger.warn('SMTP not configured; email not sent', { subject: email.subject });
        logger.info(`[email body]\n${email.text}`);
      },
    };
  }
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
  return {
    async send(email) {
      await transport.sendMail({ from: smtp.user, to: smtp.to, subject: email.subject, text: email.text });
      logger.info('Email sent', { subject: email.subject });
    },
  };
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

const fmt = (n: number | null, digits = 2): string => (n === null ? 'n/a' : n.toFixed(digits));

const INCIDENT_TITLES: Record<IncidentContext['type'], string> = {
  BREAKOUT_PAUSE: 'Price left the grid range - bot PAUSED',
  BREAKOUT_ALERT: 'Price left the grid range (alert only)',
  STOP_LOSS: 'Stop-loss triggered - bot STOPPED',
  CRASH_RESTART: 'Bot restarted after a crash',
};

/** Deterministic summary used when Claude is unavailable, slow, or not configured. */
export function fallbackSummary(ctx: IncidentContext): string {
  const parts = [
    `${INCIDENT_TITLES[ctx.type]} on ${ctx.symbol}${ctx.testnet ? ' (Binance testnet)' : ''} at ${ctx.occurredAt}.`,
    `The price was ${fmt(ctx.price)} USDT against a grid range of ${ctx.lowerBound}-${ctx.upperBound} USDT.`,
  ];
  if (ctx.drawdownPercent !== null) {
    parts.push(
      `Holdings were worth ${fmt(ctx.equityUsdt)} USDT versus ${ctx.capitalUsdt} USDT allocated, a drawdown of ${fmt(ctx.drawdownPercent)}% (stop-loss is ${ctx.stopLossPercent}%).`,
    );
  }
  parts.push(`Actions already taken: ${ctx.actionsTaken.join('; ')}. The bot is now ${ctx.resultingStatus}.`);
  parts.push(DISCLAIMER);
  return parts.join(' ');
}

/** Try Claude with a hard timeout; on any failure, return the template summary instead. */
export async function summarizeIncident(
  ctx: IncidentContext,
  timeoutMs = 45_000,
): Promise<{ text: string; source: 'claude' | 'template' }> {
  try {
    const text = await withTimeout(generateIncidentSummary(ctx), timeoutMs, 'Claude summary');
    return { text, source: 'claude' };
  } catch (err) {
    logger.warn('Claude summary unavailable; using template', { error: errorMessage(err) });
    return { text: fallbackSummary(ctx), source: 'template' };
  }
}

function subjectPrefix(testnet: boolean): string {
  return testnet ? '[GridBot TESTNET]' : '[GridBot LIVE]';
}

export function formatIncidentEmail(ctx: IncidentContext, summary: string): EmailContent {
  const facts = [
    `Type:            ${ctx.type}`,
    `Time:            ${ctx.occurredAt}`,
    `Pair:            ${ctx.symbol}`,
    `Price:           ${fmt(ctx.price)}`,
    `Grid range:      ${ctx.lowerBound} - ${ctx.upperBound}`,
    `Capital:         ${ctx.capitalUsdt} USDT`,
    `Equity:          ${fmt(ctx.equityUsdt)} USDT`,
    `Drawdown:        ${fmt(ctx.drawdownPercent)}% (stop-loss ${ctx.stopLossPercent}%)`,
    `Status now:      ${ctx.resultingStatus}`,
    `Actions taken:`,
    ...ctx.actionsTaken.map((a) => `  - ${a}`),
  ];
  if (ctx.errorMessage) facts.push(`Error:           ${ctx.errorMessage}`);

  const footer =
    ctx.resultingStatus === 'RUNNING'
      ? ''
      : '\n\nThe bot will NOT resume trading on its own. To trade again, review the situation, change the grid ' +
        'settings in .env, and restart the bot (see README).';

  return {
    subject: `${subjectPrefix(ctx.testnet)} ${INCIDENT_TITLES[ctx.type]} (${ctx.symbol})`,
    text: `${summary}\n\n--- Details ---\n${facts.join('\n')}${footer}\n`,
  };
}

export function formatStatusEmail(kind: 'Heartbeat' | 'Started', s: StatusSnapshot): EmailContent {
  const lines = [
    kind === 'Heartbeat' ? 'The grid bot is still running. Current status:' : 'The grid bot has started.',
    '',
    `Status:          ${s.status}${s.statusReason ? ` (${s.statusReason})` : ''}`,
    `Pair:            ${s.symbol}${s.testnet ? ' (testnet)' : ''}`,
    `Price:           ${fmt(s.price)}`,
    `Grid range:      ${s.lowerBound} - ${s.upperBound}`,
    `Capital:         ${s.capitalUsdt} USDT`,
    `Equity:          ${fmt(s.equityUsdt)} USDT`,
    `Drawdown:        ${fmt(s.drawdownPercent)}%`,
    `Holdings:        ${s.ledger.base} base + ${fmt(s.ledger.quote)} USDT (bot-managed)`,
    `Filled orders:   ${s.ledger.realizedTrades}`,
    `Working orders:  ${s.workingOrders}`,
    `Process uptime:  ${fmt(s.uptimeHours, 1)} h`,
  ];
  return { subject: `${subjectPrefix(s.testnet)} ${kind}: ${s.status} (${s.symbol})`, text: lines.join('\n') };
}

export function formatCrashEmail(err: unknown, testnet: boolean, symbol: string): EmailContent {
  const stack = err instanceof Error && err.stack ? err.stack : errorMessage(err);
  return {
    subject: `${subjectPrefix(testnet)} CRASH - bot process exiting (${symbol})`,
    text:
      `The grid bot hit an unhandled error and is exiting. PM2 should restart it automatically; ` +
      `on restart it resumes from its saved state (a PAUSED/STOPPED bot stays halted).\n\n` +
      `Time: ${new Date().toISOString()}\n\n${stack}\n`,
  };
}

export interface ConnectivityEvent {
  kind: 'LOST' | 'RESTORED';
  failures: number;
  /** When the first failed check of this streak happened. */
  since: string;
  lastError: string;
  testnet: boolean;
  symbol: string;
}

/** Repeated failed checks. Unlike a crash, the process keeps running and retrying. */
export function formatConnectivityEmail(e: ConnectivityEvent): EmailContent {
  if (e.kind === 'LOST') {
    return {
      subject: `${subjectPrefix(e.testnet)} Checks failing - bot still running (${e.symbol})`,
      text:
        `The last ${e.failures} checks failed in a row, starting at ${e.since}. The bot is still running ` +
        `and retrying every check, but while this lasts it cannot see the price, process fills, or apply ` +
        `the stop-loss. Existing orders stay on Binance and keep working.\n\n` +
        `Latest error: ${e.lastError}\n\n` +
        `You will get another email when checks succeed again.\n`,
    };
  }
  return {
    subject: `${subjectPrefix(e.testnet)} Checks recovered (${e.symbol})`,
    text:
      `Checks are succeeding again after ${e.failures} failures in a row (first failure at ${e.since}). ` +
      `Fills that happened in the meantime are processed normally and the risk rules are active again.\n\n` +
      `Last error before recovery: ${e.lastError}\n`,
  };
}

/** High-level notifier. Every method swallows and logs its own errors. */
export class Notifier {
  constructor(private readonly mailer: Mailer) {}

  async incident(ctx: IncidentContext): Promise<void> {
    try {
      const summary = await summarizeIncident(ctx);
      await this.mailer.send(formatIncidentEmail(ctx, summary.text));
    } catch (err) {
      logger.error('Failed to send incident email', { error: errorMessage(err), type: ctx.type });
    }
  }

  async status(kind: 'Heartbeat' | 'Started', snapshot: StatusSnapshot): Promise<boolean> {
    try {
      await this.mailer.send(formatStatusEmail(kind, snapshot));
      return true;
    } catch (err) {
      logger.error(`Failed to send ${kind.toLowerCase()} email`, { error: errorMessage(err) });
      return false;
    }
  }

  async connectivity(event: ConnectivityEvent): Promise<void> {
    try {
      await withTimeout(this.mailer.send(formatConnectivityEmail(event)), 20_000, 'Connectivity email');
    } catch (err) {
      logger.error('Failed to send connectivity email', { error: errorMessage(err), kind: event.kind });
    }
  }

  async crash(err: unknown, testnet: boolean, symbol: string): Promise<void> {
    try {
      await withTimeout(this.mailer.send(formatCrashEmail(err, testnet, symbol)), 20_000, 'Crash email');
    } catch (sendErr) {
      logger.error('Failed to send crash email', { error: errorMessage(sendErr) });
    }
  }
}
