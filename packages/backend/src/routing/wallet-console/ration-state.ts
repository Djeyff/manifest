import { readFileSync } from 'fs';

/**
 * Reader for the RET-670-V3 governor state (RET-720 scope c).
 *
 * The line math (base + rollover pool, floor locked, drain-day lift) lives in
 * the governor (`ret670_ration_governor.py` / `ret670_v3_line.py`) and is
 * published as a JSON state file. This module READS that published state — it
 * never re-implements the math, so the console can never disagree with the
 * governor about today's line.
 *
 * Path: MANIFEST_RET670_RATION_FILE, default /opt/data/shared/state/ret670-ration.json.
 */
export const RET670_RATION_FILE_DEFAULT = '/opt/data/shared/state/ret670-ration.json';

export interface RationAnchor {
  /** Epoch of the provider-own reset anchor the day window is measured from. */
  anchor_epoch?: number;
  /** Where the anchor came from (provider-own feed, codexbar-port, …). */
  source?: string | null;
  /** True when the anchor itself is stale. */
  stale?: boolean;
  /** Human note (usually the provider reset stamp). */
  note?: string | null;
}

export interface RationDecision {
  account?: string;
  allow?: boolean;
  halt?: boolean;
  usable_pct?: number;
  available_pct?: number;
  spent_today_pct?: number;
  remaining_today_pct?: number;
  /** Owner reserve held back this day (% of the weekly pool). */
  reserve_pct?: number;
  /** Reserve accrued at the last day lift ((N-1) x 4.2857%/day). */
  accrued_at_lift_pct?: number;
  /** Reserve currently locked for reservation holds. */
  reserved_pct?: number;
  /** Number of reservation holds riding on this account. */
  reservation_holds?: number;
  /** Tail burn the governor allows on the last hour of the day. */
  burn_tail_pct?: number;
  base_pct?: number;
  rollover_pool_pct?: number;
  floor_pct?: number;
  drain_day?: boolean;
  drain_window?: boolean;
  day_index?: number;
  day_number?: number;
  ration_model?: string;
  release_stage?: string | null;
  binding_dimension?: string | null;
  capped_by_floor?: boolean;
  final_hour?: boolean;
  poll_ok?: boolean;
  anchor?: RationAnchor | null;
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

/** The rollover engine state the governor publishes (RET-670-V3 owner model). */
export interface RationRollover {
  enabled?: boolean;
  model?: string | null;
  /** Epoch of the current ration day (the day the rollover replays into). */
  day_epoch?: number | null;
  day_start_utc?: string | null;
  primary?: string | null;
  backup?: string | null;
  mode?: string | null;
  active?: string | null;
  reason?: string | null;
  primary_allow?: boolean;
  primary_usable_pct?: number | null;
  backup_allow?: boolean;
  backup_usable_pct?: number | null;
  backup_membership_active?: boolean;
  backup_membership_end?: string | null;
  new_ration_day?: boolean;
}

export interface RationState {
  available: boolean;
  /** Reason the published state is missing/unreadable (null when available). */
  unavailable_reason: string | null;
  updated_at: string | null;
  accounts: Record<string, RationAccountStatus>;
  /** label (acct_key) -> account name. */
  account_by_key: Record<string, string>;
  /** Epoch of the ration week start (provider-own week anchor). */
  week_start: number | null;
  /** UTC "HH:MM" the ration day starts at. */
  day_start_utc: string | null;
  /** Epoch of the current ration day, when the governor published one. */
  day_epoch: number | null;
  /** The rollover engine state. */
  rollover: RationRollover | null;
  /** The governor tick that produced this state. */
  enforce_tick: { at: string | null; source: string | null } | null;
}

export function rationStatePath(): string {
  return process.env.MANIFEST_RET670_RATION_FILE ?? RET670_RATION_FILE_DEFAULT;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
      week_start: null,
      day_start_utc: null,
      day_epoch: null,
      rollover: null,
      enforce_tick: null,
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
  const rolloverRaw = parsed['rollover'];
  const rollover: RationRollover | null =
    rolloverRaw && typeof rolloverRaw === 'object' ? (rolloverRaw as RationRollover) : null;
  const tickRaw = parsed['enforce_tick'];
  const enforce_tick =
    tickRaw && typeof tickRaw === 'object'
      ? {
          at: typeof (tickRaw as Record<string, unknown>)['at'] === 'string'
            ? ((tickRaw as Record<string, unknown>)['at'] as string)
            : null,
          source:
            typeof (tickRaw as Record<string, unknown>)['source'] === 'string'
              ? ((tickRaw as Record<string, unknown>)['source'] as string)
              : null,
        }
      : null;
  return {
    available: true,
    unavailable_reason: null,
    updated_at,
    accounts,
    account_by_key,
    week_start: asNumber(lastStatus['week_start']),
    day_start_utc:
      typeof lastStatus['day_start_utc'] === 'string' ? (lastStatus['day_start_utc'] as string) : null,
    day_epoch: asNumber(rollover?.day_epoch),
    rollover,
    enforce_tick,
  };
}
