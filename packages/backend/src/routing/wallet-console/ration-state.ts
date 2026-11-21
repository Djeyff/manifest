import { readFileSync } from 'fs';

/**
 * Reader for the RET-670-V3 governor state (RET-720 scope c).
 *
 * The line math (base + rollover pool, floor locked, drain-day lift) lives in
 * the governor (`ret670_ration_governor.py` / `ret670_v3_line.py`) and is
 * published as a JSON state file. This module READS that published state —
 * it never re-implements the math, so the console can never disagree with the
 * governor about today's line.
 *
 * Path: MANIFEST_RET670_RATION_FILE, default /opt/data/shared/state/ret670-ration.json.
 */
export const RET670_RATION_FILE_DEFAULT = '/opt/data/shared/state/ret670-ration.json';

export interface RationDecision {
  account?: string;
  allow?: boolean;
  halt?: boolean;
  usable_pct?: number;
  available_pct?: number;
  spent_today_pct?: number;
  remaining_today_pct?: number;
  reserve_pct?: number;
  base_pct?: number;
  rollover_pool_pct?: number;
  floor_pct?: number;
  drain_day?: boolean;
  drain_window?: boolean;
  day_index?: number;
  day_number?: number;
  ration_model?: string;
  weekly_headroom_pct?: number | null;
  five_h_headroom_pct?: number | null;
  reasons?: string[];
}

export interface RationAccountStatus {
  acct_keys?: string[];
  denomination?: string;
  weekly_pool?: number;
  spent_week_pct?: number;
  spent_today_pct?: number;
  decision?: RationDecision;
}

export interface RationState {
  available: boolean;
  /** Reason the published state is missing/unreadable (null when available). */
  unavailable_reason: string | null;
  updated_at: string | null;
  accounts: Record<string, RationAccountStatus>;
  /** label (acct_key) -> account name. */
  account_by_key: Record<string, string>;
}

export function rationStatePath(): string {
  return process.env.MANIFEST_RET670_RATION_FILE ?? RET670_RATION_FILE_DEFAULT;
}

/** Read the published governor state. Never throws: a missing file is a state. */
export function readRationState(path: string = rationStatePath()): RationState {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      unavailable_reason: `ration state unreadable at ${path}: ${reason}`,
      updated_at: null,
      accounts: {},
      account_by_key: {},
    };
  }
  const lastStatus = (parsed['last_status'] ?? {}) as Record<string, unknown>;
  const rawAccounts = (lastStatus['accounts'] ?? {}) as Record<string, RationAccountStatus>;
  const accounts: Record<string, RationAccountStatus> = {};
  const account_by_key: Record<string, string> = {};
  for (const [name, status] of Object.entries(rawAccounts ?? {})) {
    if (!status || typeof status !== 'object') continue;
    accounts[name] = status;
    for (const key of status.acct_keys ?? []) {
      if (typeof key === 'string' && key.trim() !== '') account_by_key[key.trim()] = name;
    }
  }
  const updatedRaw = parsed['updated_at'];
  const updated_at =
    typeof updatedRaw === 'number' && Number.isFinite(updatedRaw)
      ? new Date(updatedRaw * 1000).toISOString()
      : null;
  return { available: true, unavailable_reason: null, updated_at, accounts, account_by_key };
}
