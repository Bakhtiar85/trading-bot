/**
 * Optional HTTP health endpoint. Only started when PORT is set, which hosts such as Render do
 * for web services (they fail the deploy if nothing listens on that port). On a plain VPS with
 * PM2, PORT is normally unset and no port is opened.
 *
 *   GET /health -> 200 when a check succeeded recently, 503 while starting or when checks fail
 */
import http from 'node:http';
import { logger } from './logger';
import type { BotStatus } from './types';

export interface HealthSource {
  health(): { healthy: boolean; status: BotStatus | 'STARTING'; lastCheckAt: string | null };
}

export function startHealthServer(port: number, getSource: () => HealthSource | null): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || (req.url !== '/' && req.url !== '/health')) {
      res.writeHead(404).end();
      return;
    }
    const source = getSource();
    const body = source ? source.health() : { healthy: false, status: 'STARTING', lastCheckAt: null };
    res.writeHead(body.healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  server.listen(port, '0.0.0.0', () => logger.info(`Health endpoint listening on port ${port}`));
  return server;
}
