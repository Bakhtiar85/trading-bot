/**
 * Optional HTTP health endpoint. Only started when PORT is set, which hosts such as Render do
 * for web services (they fail the deploy if nothing listens on that port). On a plain VPS with
 * PM2, PORT is normally unset and no port is opened.
 *
 *   GET /health -> 200 while the check loop is alive, 503 while starting or if the loop has stalled
 *
 * Exchange outages deliberately stay 200: a host restart can't fix the network, and restarting
 * during an outage just crash-loops on the startup price check. Outages are reported by email
 * and visible here via consecutiveFailures / lastSuccessAt.
 */
import http from 'node:http';
import { errorMessage, logger } from './logger';
import type { HealthReport } from './types';

export interface HealthSource {
  health(): HealthReport;
}

const STARTING: HealthReport = {
  healthy: false,
  status: 'STARTING',
  lastAttemptAt: null,
  lastSuccessAt: null,
  consecutiveFailures: 0,
};

export function startHealthServer(port: number, getSource: () => HealthSource | null): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || (req.url !== '/' && req.url !== '/health')) {
      res.writeHead(404).end();
      return;
    }
    const body = getSource()?.health() ?? STARTING;
    res.writeHead(body.healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  // Without a handler, e.g. EADDRINUSE becomes an uncaught exception and takes the bot down.
  // Trading matters more than the endpoint, so log it and carry on without one.
  server.on('error', (err) => {
    logger.error('Health endpoint failed; continuing without it', { port, error: errorMessage(err) });
  });
  server.listen(port, '0.0.0.0', () => logger.info(`Health endpoint listening on port ${port}`));
  return server;
}
