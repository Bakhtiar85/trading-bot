/**
 * Password-protected, READ-ONLY status page for checking on the bot from a phone.
 *
 *   GET /             HTML page: status, equity, check health, recent logs (auto-refreshes)
 *   GET /api/status   the same status as JSON
 *   GET /api/logs     recent log entries as JSON (?lines=200&level=warn)
 *   GET /health       public liveness check, no details (same as src/health.ts)
 *
 * Deliberately has no actions (no pause/resume/trade): a leaked password can't move money, and
 * resuming still requires a config change plus restart. Listens on 127.0.0.1 by default, meant
 * to sit behind an HTTPS reverse proxy (Caddy) — plain HTTP would expose the password.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { errorMessage, logger } from '../logger';
import type { HealthReport, StatusPageConfig, StatusSnapshot } from '../types';

export interface StatusSource {
  health(): HealthReport;
  snapshot(): StatusSnapshot;
}

// ---------------------------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------------------------

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/** Check an HTTP Basic `Authorization` header. Any username is accepted; only the password counts. */
export function checkBasicAuth(header: string | undefined, password: string): boolean {
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep === -1) return false;
  // Hash both sides so the comparison is constant-time regardless of length.
  return timingSafeEqual(sha256(decoded.slice(sep + 1)), sha256(password));
}

/** Blocks a client for BLOCK_MS after MAX_FAILURES wrong passwords within WINDOW_MS. */
export class LoginLimiter {
  static readonly MAX_FAILURES = 5;
  static readonly WINDOW_MS = 15 * 60_000;
  static readonly BLOCK_MS = 15 * 60_000;
  private readonly clients = new Map<string, { failures: number; firstAt: number; blockedUntil: number }>();

  isBlocked(client: string, now = Date.now()): boolean {
    return (this.clients.get(client)?.blockedUntil ?? 0) > now;
  }

  recordFailure(client: string, now = Date.now()): void {
    if (this.clients.size > 1000) this.prune(now);
    let entry = this.clients.get(client);
    if (!entry || now - entry.firstAt > LoginLimiter.WINDOW_MS) {
      entry = { failures: 0, firstAt: now, blockedUntil: 0 };
      this.clients.set(client, entry);
    }
    entry.failures++;
    if (entry.failures >= LoginLimiter.MAX_FAILURES) entry.blockedUntil = now + LoginLimiter.BLOCK_MS;
  }

  recordSuccess(client: string): void {
    this.clients.delete(client);
  }

  private prune(now: number): void {
    for (const [key, e] of this.clients) {
      if (e.blockedUntil <= now && now - e.firstAt > LoginLimiter.WINDOW_MS) this.clients.delete(key);
    }
  }
}

/**
 * Behind a local reverse proxy every request comes from loopback, so use the forwarded address.
 * Take the LAST X-Forwarded-For entry (added by our own proxy); earlier entries are client-supplied
 * and could be faked to dodge the login rate limit.
 */
export function clientAddress(remote: string | undefined, forwarded: string | string[] | undefined): string {
  const addr = remote ?? 'unknown';
  const isLoopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  if (isLoopback && typeof forwarded === 'string' && forwarded.trim() !== '') {
    return forwarded.split(',').pop()?.trim() || addr;
  }
  return addr;
}

// ---------------------------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------------------------

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  meta: Record<string, unknown>;
}

const LEVEL_RANK: Record<string, number> = { error: 0, warn: 1, info: 2, http: 3, verbose: 4, debug: 5, silly: 6 };
export type LogLevelFilter = 'error' | 'warn' | 'info' | 'debug';

export function parseLogLevel(value: string | null): LogLevelFilter {
  return value === 'error' || value === 'warn' || value === 'debug' ? value : 'info';
}

/** Parse the JSON-lines log format written by the file transport. Unparseable lines are skipped. */
export function parseLogLines(text: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const raw: unknown = JSON.parse(line);
      if (typeof raw !== 'object' || raw === null) continue;
      const { timestamp, level, message, ...meta } = raw as Record<string, unknown>;
      entries.push({ timestamp: String(timestamp ?? ''), level: String(level ?? 'info'), message: String(message ?? ''), meta });
    } catch {
      // partial or corrupt line
    }
  }
  return entries;
}

export function filterByLevel(entries: LogEntry[], min: LogLevelFilter): LogEntry[] {
  const max = LEVEL_RANK[min] ?? 2;
  return entries.filter((e) => (LEVEL_RANK[e.level] ?? 2) <= max);
}

const TAIL_BYTES = 1024 * 1024;

async function readTail(file: string, maxBytes: number): Promise<string> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    // Starting mid-file means the first line is probably cut off.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await handle.close();
  }
}

/** Most recent `lines` entries at or above `min`, oldest first, from the two newest log files. */
export async function readRecentLogs(logDir: string, lines: number, min: LogLevelFilter): Promise<LogEntry[]> {
  let files: string[];
  try {
    files = (await fs.promises.readdir(logDir)).filter((f) => /^gridbot-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
  } catch {
    return [];
  }
  const result: LogEntry[] = [];
  // Newest file first; reach into the previous day's file only when needed (e.g. just after midnight).
  for (const file of files.slice(-2).reverse()) {
    const entries = filterByLevel(parseLogLines(await readTail(path.join(logDir, file), TAIL_BYTES)), min);
    result.unshift(...entries);
    if (result.length >= lines) break;
  }
  return result.slice(-lines);
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const fmt = (n: number | null, digits = 2): string => (n === null ? '–' : n.toFixed(digits));

function ago(iso: string | null): string {
  if (iso === null) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${(s / 3600).toFixed(1)} h ago`;
}

export function renderPage(
  health: HealthReport,
  snap: StatusSnapshot | null,
  logs: LogEntry[],
  level: LogLevelFilter,
  lines: number,
): string {
  const statusClass =
    !health.healthy || health.consecutiveFailures > 0 ? 'bad' : health.status === 'RUNNING' ? 'ok' : 'warn';
  const rows: Array<[string, string]> = [
    ['Loop', health.healthy ? 'alive' : 'NOT RESPONDING'],
    ['Last check', `${ago(health.lastAttemptAt)}${health.consecutiveFailures > 0 ? ` — ${health.consecutiveFailures} failing in a row` : ''}`],
    ['Last success', ago(health.lastSuccessAt)],
  ];
  if (snap) {
    rows.push(
      ['Pair', `${snap.symbol}${snap.testnet ? ' (TESTNET)' : ''}`],
      ['Price', fmt(snap.price)],
      ['Range', `${snap.lowerBound} – ${snap.upperBound}`],
      ['Equity', `${fmt(snap.equityUsdt)} / ${snap.capitalUsdt} USDT`],
      ['Drawdown', `${fmt(snap.drawdownPercent)}%`],
      ['Holdings', `${snap.ledger.base} base + ${fmt(snap.ledger.quote)} USDT`],
      ['Filled orders', String(snap.ledger.realizedTrades)],
      ['Working orders', String(snap.workingOrders)],
      ['Uptime', `${fmt(snap.uptimeHours, 1)} h`],
    );
    if (snap.statusReason) rows.push(['Reason', snap.statusReason]);
  }

  const filterLinks = (['info', 'warn', 'error'] as const)
    .map((l) => (l === level ? `<b>${l}</b>` : `<a href="/?level=${l}&lines=${lines}">${l}</a>`))
    .join(' · ');

  const logHtml =
    logs.length === 0
      ? '<p class="muted">No log entries.</p>'
      : logs
          .slice()
          .reverse() // newest first on a phone
          .map((e) => {
            const meta = Object.keys(e.meta).length > 0 ? ` ${JSON.stringify(e.meta)}` : '';
            const time = e.timestamp.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
            return `<div class="log ${escapeHtml(e.level)}"><span class="t">${escapeHtml(time)}</span> <span class="l">${escapeHtml(e.level)}</span> ${escapeHtml(e.message)}<span class="m">${escapeHtml(meta)}</span></div>`;
          })
          .join('\n');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>Grid bot · ${escapeHtml(health.status)}</title>
<style>
  :root { color-scheme: light dark; --ok:#1a7f37; --warn:#9a6700; --bad:#cf222e; --muted:#6e7781; }
  body { font: 15px/1.45 system-ui, sans-serif; margin: 0; padding: 16px; max-width: 900px; margin-inline: auto; }
  h1 { font-size: 22px; margin: 0 0 4px; } .badge { display:inline-block; padding:2px 10px; border-radius:12px; color:#fff; font-weight:600; }
  .badge.ok { background: var(--ok); } .badge.warn { background: var(--warn); } .badge.bad { background: var(--bad); }
  table { border-collapse: collapse; width: 100%; margin: 12px 0 20px; } td { padding: 6px 4px; border-bottom: 1px solid #8884; vertical-align: top; }
  td:first-child { color: var(--muted); white-space: nowrap; width: 1%; padding-right: 16px; }
  .muted { color: var(--muted); } h2 { font-size: 17px; margin: 0 0 6px; }
  .log { font: 12px/1.4 ui-monospace, monospace; padding: 4px 0; border-bottom: 1px solid #8882; word-break: break-word; }
  .log .t { color: var(--muted); } .log .l { font-weight: 700; } .log .m { color: var(--muted); }
  .log.error .l { color: var(--bad); } .log.warn .l { color: var(--warn); }
</style></head><body>
<h1>Grid bot <span class="badge ${statusClass}">${escapeHtml(health.status)}</span></h1>
<div class="muted">Read-only · refreshes every 60 s · ${escapeHtml(new Date().toISOString().replace('T', ' ').slice(0, 19))} UTC</div>
<table>${rows.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('')}</table>
<h2>Logs</h2>
<div class="muted">Level: ${filterLinks} · last ${lines} · newest first</div>
${logHtml}
</body></html>`;
}

// ---------------------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------------------

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
};

const STARTING: HealthReport = { healthy: false, status: 'STARTING', lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0 };

export function startStatusServer(
  config: StatusPageConfig,
  logDir: string,
  getSource: () => StatusSource | null,
): http.Server {
  const limiter = new LoginLimiter();

  const send = (res: http.ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}): void => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, ...extra });
    res.end(body);
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Method not allowed');

    const source = getSource();
    const health = source?.health() ?? STARTING;

    if (url.pathname === '/health') {
      return send(res, health.healthy ? 200 : 503, 'application/json', JSON.stringify(health));
    }

    const client = clientAddress(req.socket.remoteAddress, req.headers['x-forwarded-for']);
    if (limiter.isBlocked(client)) return send(res, 429, 'text/plain', 'Too many failed logins; try again later');
    if (!checkBasicAuth(req.headers.authorization, config.password)) {
      if (req.headers.authorization) {
        limiter.recordFailure(client);
        logger.warn('Status page: wrong password', { client });
      }
      return send(res, 401, 'text/plain', 'Password required', {
        'WWW-Authenticate': 'Basic realm="Grid bot", charset="UTF-8"',
      });
    }
    limiter.recordSuccess(client);

    // Before startup completes there is no state to snapshot yet.
    const snap = source && health.status !== 'STARTING' ? source.snapshot() : null;
    const lines = Math.min(1000, Math.max(1, Number(url.searchParams.get('lines')) || 200));
    const level = parseLogLevel(url.searchParams.get('level'));

    switch (url.pathname) {
      case '/':
        return send(res, 200, 'text/html; charset=utf-8', renderPage(health, snap, await readRecentLogs(logDir, lines, level), level, lines));
      case '/api/status':
        return send(res, 200, 'application/json', JSON.stringify({ health, snapshot: snap }));
      case '/api/logs':
        return send(res, 200, 'application/json', JSON.stringify(await readRecentLogs(logDir, lines, level)));
      default:
        return send(res, 404, 'text/plain', 'Not found');
    }
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      logger.error('Status page request failed', { error: errorMessage(err) });
      if (!res.headersSent) send(res, 500, 'text/plain', 'Internal error');
    });
  });
  // Trading matters more than this page: never let a listen error (e.g. port in use) crash the bot.
  server.on('error', (err) => logger.error('Status page failed; continuing without it', { error: errorMessage(err) }));
  server.listen(config.port, config.host, () => {
    logger.info(`Status page listening on http://${config.host}:${config.port}`);
    if (config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1') {
      logger.warn('Status page is reachable from the network over plain HTTP; put it behind HTTPS (see README)');
    }
  });
  return server;
}
