/**
 * Persistence of bot state (status, grid slots, ledger) to a local JSON file so PAUSED/STOPPED
 * survives restarts. Writes are atomic (temp file + rename) so a crash mid-write can't corrupt it.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PersistedState } from '../types';

export function createInitialState(configFingerprint: string, symbol: string, capitalUsdt: number): PersistedState {
  const now = new Date().toISOString();
  return {
    version: 1,
    sessionId: randomBytes(4).toString('hex'),
    configFingerprint,
    symbol,
    status: 'RUNNING',
    statusReason: null,
    statusChangedAt: now,
    createdAt: now,
    ledger: { quote: capitalUsdt, base: 0, realizedTrades: 0 },
    slots: [],
    initialBuy: null,
    gridPlaced: false,
    liquidationComplete: false,
    pendingSellClientOrderId: null,
    orderCounter: 0,
    lastHeartbeatAt: null,
    running: false,
    lastCrash: null,
    breakoutAlertActive: false,
  };
}

function isPersistedState(value: unknown): value is PersistedState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<PersistedState>;
  return (
    v.version === 1 &&
    typeof v.sessionId === 'string' &&
    typeof v.configFingerprint === 'string' &&
    typeof v.symbol === 'string' &&
    (v.status === 'RUNNING' || v.status === 'PAUSED' || v.status === 'STOPPED') &&
    typeof v.ledger === 'object' &&
    Array.isArray(v.slots)
  );
}

export class StateStore {
  readonly filePath: string;

  constructor(private readonly dataDir: string) {
    this.filePath = path.join(dataDir, 'state.json');
  }

  load(): PersistedState | null {
    if (!fs.existsSync(this.filePath)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    if (!isPersistedState(parsed)) {
      // Refuse to guess: a corrupt state file could hide a STOPPED status.
      throw new Error(`State file ${this.filePath} is invalid. Inspect it, then move it aside to start fresh.`);
    }
    // Fields added after the first release; default them so existing state files keep loading.
    parsed.pendingSellClientOrderId ??= null;
    return parsed;
  }

  /** Synchronous so it can also be used from crash handlers. */
  save(state: PersistedState): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  /** Move the current state file aside (kept for audit) so a new session can start. */
  archive(state: PersistedState): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(this.dataDir, `state-${state.sessionId}-${state.status}-${stamp}.json`);
    fs.renameSync(this.filePath, target);
    return target;
  }
}
