import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HealthReport } from '../types';
import {
  checkBasicAuth,
  clientAddress,
  filterByLevel,
  LoginLimiter,
  parseLogLevel,
  parseLogLines,
  readRecentLogs,
  renderPage,
} from './index';

const basic = (user: string, pass: string): string => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

describe('checkBasicAuth', () => {
  const pw = 'correct horse battery';

  it('accepts the right password with any username', () => {
    expect(checkBasicAuth(basic('me', pw), pw)).toBe(true);
    expect(checkBasicAuth(basic('', pw), pw)).toBe(true);
  });

  it('rejects wrong, missing or malformed credentials', () => {
    expect(checkBasicAuth(basic('me', 'wrong'), pw)).toBe(false);
    expect(checkBasicAuth(basic('me', `${pw}x`), pw)).toBe(false);
    expect(checkBasicAuth(undefined, pw)).toBe(false);
    expect(checkBasicAuth('Bearer abc', pw)).toBe(false);
    expect(checkBasicAuth(`Basic ${Buffer.from('nocolon').toString('base64')}`, pw)).toBe(false);
  });

  it('handles passwords containing colons', () => {
    expect(checkBasicAuth(basic('me', 'a:b:c-long-pass'), 'a:b:c-long-pass')).toBe(true);
  });
});

describe('LoginLimiter', () => {
  it('blocks after repeated failures, per client, and expires', () => {
    const limiter = new LoginLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < LoginLimiter.MAX_FAILURES - 1; i++) limiter.recordFailure('a', t0);
    expect(limiter.isBlocked('a', t0)).toBe(false);
    limiter.recordFailure('a', t0);
    expect(limiter.isBlocked('a', t0)).toBe(true);
    expect(limiter.isBlocked('b', t0)).toBe(false);
    expect(limiter.isBlocked('a', t0 + LoginLimiter.BLOCK_MS + 1)).toBe(false);
  });

  it('a successful login clears the failure count', () => {
    const limiter = new LoginLimiter();
    for (let i = 0; i < LoginLimiter.MAX_FAILURES - 1; i++) limiter.recordFailure('a');
    limiter.recordSuccess('a');
    limiter.recordFailure('a');
    expect(limiter.isBlocked('a')).toBe(false);
  });
});

describe('clientAddress', () => {
  it('uses the proxy-added (last) forwarded address only behind a local proxy', () => {
    expect(clientAddress('127.0.0.1', '1.2.3.4')).toBe('1.2.3.4');
    expect(clientAddress('127.0.0.1', 'spoofed, 1.2.3.4')).toBe('1.2.3.4');
    expect(clientAddress('5.6.7.8', '1.2.3.4')).toBe('5.6.7.8'); // not from our proxy: ignore header
    expect(clientAddress('127.0.0.1', undefined)).toBe('127.0.0.1');
  });
});

describe('log parsing and filtering', () => {
  const text = [
    '{"level":"info","message":"Tick","timestamp":"2026-10-08T10:00:00.000Z","price":1}',
    '{"level":"warn","message":"Slow","timestamp":"2026-10-08T10:01:00.000Z"}',
    'not json',
    '{"level":"error","message":"Boom","timestamp":"2026-10-08T10:02:00.000Z","stack":"x"}',
    '{"level":"debug","message":"Detail","timestamp":"2026-10-08T10:03:00.000Z"}',
  ].join('\n');

  it('parses JSON lines, keeps extra fields as meta, skips junk', () => {
    const entries = parseLogLines(text);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toEqual({ timestamp: '2026-10-08T10:00:00.000Z', level: 'info', message: 'Tick', meta: { price: 1 } });
  });

  it('filters by minimum level', () => {
    const entries = parseLogLines(text);
    expect(filterByLevel(entries, 'error').map((e) => e.message)).toEqual(['Boom']);
    expect(filterByLevel(entries, 'warn').map((e) => e.message)).toEqual(['Slow', 'Boom']);
    expect(filterByLevel(entries, 'info')).toHaveLength(3);
    expect(filterByLevel(entries, 'debug')).toHaveLength(4);
  });

  it('defaults unknown level filters to info', () => {
    expect(parseLogLevel(null)).toBe('info');
    expect(parseLogLevel('nonsense')).toBe('info');
    expect(parseLogLevel('warn')).toBe('warn');
  });

  it('reads the newest entries across the two latest log files, oldest first', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridbot-logs-'));
    try {
      const line = (msg: string): string => `{"level":"info","message":"${msg}","timestamp":"t"}\n`;
      fs.writeFileSync(path.join(dir, 'gridbot-2026-10-06.log'), line('old'));
      fs.writeFileSync(path.join(dir, 'gridbot-2026-10-07.log'), line('y1') + line('y2'));
      fs.writeFileSync(path.join(dir, 'gridbot-2026-10-08.log'), line('t1'));
      fs.writeFileSync(path.join(dir, '.audit.json'), '{}');

      expect((await readRecentLogs(dir, 3, 'info')).map((e) => e.message)).toEqual(['y1', 'y2', 't1']);
      expect((await readRecentLogs(dir, 1, 'info')).map((e) => e.message)).toEqual(['t1']);
      expect(await readRecentLogs(path.join(dir, 'missing'), 10, 'info')).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('renderPage', () => {
  const health: HealthReport = {
    healthy: true,
    status: 'RUNNING',
    lastAttemptAt: new Date().toISOString(),
    lastSuccessAt: new Date().toISOString(),
    consecutiveFailures: 0,
  };

  it('scopes badge colours to the badge so warn/error log rows are not highlighted', () => {
    const html = renderPage(health, null, [], 'info', 200);
    expect(html).toContain('.badge.warn');
    expect(html).not.toMatch(/[^.\w]\.warn\s*\{/);
  });

  it('escapes log content so it cannot inject HTML', () => {
    const html = renderPage(
      health,
      null,
      [{ timestamp: 't', level: 'error', message: '<script>alert(1)</script>', meta: { x: '"><img>' } }],
      'info',
      200,
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('"><img>');
  });
});
