/**
 * Live Z.AI coding-plan quota truth (RET-595).
 *
 * Zero-LLM source: `GET {monitor}/api/monitor/usage/quota/limit` with the
 * connection's own bearer key returns the rolling 5-hour and weekly window
 * gauges (used %, remaining, nextResetTime) plus the plan level. The gateway
 * holds the only copies of the subscription keys (at-rest encrypted), so this
 * poller lives here — the admission proxy is structurally blind to upstream
 * quota data (proven RET-581: headers never survive the gateway hop, error
 * bodies carry reset timestamps only).
 *
 * This module is deliberately pure (no Nest, no fetch, no crypto) so the
 * payload parser is unit-testable against documented shapes without network
 * or key material.
 */

/** Monitor path (appended to the monitor base URL). */
export const ZAI_MONITOR_QUOTA_PATH = '/api/monitor/usage/quota/limit';

/** Default monitor base (global region; the coding base carries `/api/coding/...`). */
export const ZAI_MONITOR_BASE_DEFAULT = 'https://api.z.ai';

/** One label's live quota snapshot as exposed at the public read model. */
export interface ZaiQuotaLabelSnapshot {
  /** tenant_providers.label, e.g. `RCR` / `RCR Backup` / `CCR` / `CCR Backup`. */
  label: string;
  /** % of the rolling 5-hour window still available (0-100); null while unknown. */
  five_h_pct_left: number | null;
  /** % of the rolling weekly window still available (0-100); null while unknown. */
  weekly_pct_left: number | null;
  /** ISO instant the rolling 5-hour window resets; null while unknown. */
  five_h_reset_at: string | null;
  /** ISO instant the rolling weekly window resets; null while unknown. */
  weekly_reset_at: string | null;
  /** Plan tier reported by the monitor (`lite` / `pro` / `max` ...); null while unknown. */
  plan_level: string | null;
  /** Subscription state from the monitor envelope; null while unknown. */
  subscription_status: string | null;
  /** ISO instant this label's last successful poll landed; null until one lands. */
  seen_at: string | null;
  /** Last poll error for this label (class only, never key or body material). */
  error: string | null;
}

/** Service-wide snapshot served at the public read model. */
export interface ZaiQuotaSnapshot {
  labels: Record<string, ZaiQuotaLabelSnapshot>;
  /** ISO instant the last poll cycle ran (success or not). */
  polled_at: string | null;
  /** Poll cycles executed since boot. */
  polls: number;
  /** Per-label fetch/parse failures since boot. */
  poll_errors: number;
}

/** Parsed quota payload, independent of which connection produced it. */
export interface ParsedZaiQuota {
  five_h_pct_left: number | null;
  weekly_pct_left: number | null;
  five_h_reset_at: string | null;
  weekly_reset_at: string | null;
  plan_level: string | null;
  subscription_status: string | null;
}

/** Documented window identity: unit 3 / number 5 = rolling 5-hour window. */
const WINDOW_FIVE_H = '3:5';
/** Documented window identity: unit 6 / number 1 = rolling weekly window. */
const WINDOW_WEEKLY = '6:1';

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toFiniteInt(value: unknown): number | null {
  const num = toFiniteNumber(value);
  return num === null ? null : Math.trunc(num);
}

/**
 * Route one `data.limits` row to its window by the documented `unit`/`number`
 * pair (`3:5` five-hour, `6:1` weekly). Rows without the pair are ignored
 * here; the legacy no-pair TOKENS_LIMIT shape is handled by the caller.
 */
function routeWindow(row: Record<string, unknown>): 'five_h' | 'weekly' | null {
  const unit = toFiniteInt(row['unit']);
  const number = toFiniteInt(row['number']);
  if (unit === null || number === null) return null;
  const pair = `${unit}:${number}`;
  if (pair === WINDOW_FIVE_H) return 'five_h';
  if (pair === WINDOW_WEEKLY) return 'weekly';
  return null;
}

/** % still available for one row: `percentage` is % USED (0 on a fresh window). */
function pctLeftFromRow(row: Record<string, unknown>): number | null {
  const used = toFiniteNumber(row['percentage']);
  if (used !== null) {
    return Math.min(100, Math.max(0, 100 - used));
  }
  // Fallback: some payloads carry remaining/limit instead of a percentage.
  const remaining = toFiniteNumber(row['remaining']);
  const limit = toFiniteNumber(row['limit']);
  if (remaining !== null && limit !== null && limit > 0) {
    return Math.min(100, Math.max(0, (remaining / limit) * 100));
  }
  return null;
}

/** Reset instant for one row: `nextResetTime` is epoch milliseconds. */
function resetAtFromRow(row: Record<string, unknown>): string | null {
  const ms = toFiniteNumber(row['nextResetTime']);
  if (ms === null || ms <= 0) return null;
  return new Date(ms).toISOString();
}

function pickString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

interface WindowReading {
  pct_left: number | null;
  reset_at: string | null;
}

function readingFromRow(row: Record<string, unknown>): WindowReading {
  return { pct_left: pctLeftFromRow(row), reset_at: resetAtFromRow(row) };
}

/** Prefer a reading that actually knows its %; tie-break on knowing a reset. */
function betterReading(a: WindowReading, b: WindowReading): WindowReading {
  if (a.pct_left === null && b.pct_left !== null) return b;
  return a;
}

/**
 * Parse a `/api/monitor/usage/quota/limit` payload into window readings.
 *
 * Envelope: `{success, code?, msg?, data?}` (verified live: an unauthenticated
 * call answers `{"code":1001,"msg":"Authentication parameter not received in
 * Header...","success":false}`). With `success === false` there is no active
 * coding package — that is a healthy answer about an unfunded key, so it maps
 * to `subscription_status: 'inactive_or_free'` with all gauges null, not an
 * error. The inner `data.limits` array carries one row per window routed by
 * its `unit`/`number` pair; a legacy TOKENS_LIMIT row with no pair predates
 * the windowed shape and reads as the 5-hour window. Never throws on shape
 * surprises — unknown fields simply stay null.
 */
export function parseZaiQuotaLimitPayload(payload: unknown): ParsedZaiQuota {
  const out: ParsedZaiQuota = {
    five_h_pct_left: null,
    weekly_pct_left: null,
    five_h_reset_at: null,
    weekly_reset_at: null,
    plan_level: null,
    subscription_status: null,
  };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return out;
  const envelope = payload as Record<string, unknown>;

  if (envelope['success'] === false) {
    out.subscription_status = 'inactive_or_free';
    return out;
  }

  const data = envelope['data'];
  let limits: unknown[] = [];
  let level: string | null = null;
  let subscriptionStatus: string | null = null;
  if (Array.isArray(data)) {
    limits = data;
  } else if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const rawLimits = record['limits'];
    if (Array.isArray(rawLimits)) limits = rawLimits;
    level = pickString(record, ['level']);
    subscriptionStatus = pickString(record, [
      'subscriptionStatus',
      'subscription_status',
      'packageStatus',
    ]);
  }

  let fiveH: WindowReading | null = null;
  let weekly: WindowReading | null = null;
  let legacyFiveH: WindowReading | null = null;
  for (const raw of limits) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const slot = routeWindow(row);
    if (slot === 'five_h') {
      fiveH = fiveH === null ? readingFromRow(row) : betterReading(fiveH, readingFromRow(row));
    } else if (slot === 'weekly') {
      weekly = weekly === null ? readingFromRow(row) : betterReading(weekly, readingFromRow(row));
    } else if (
      legacyFiveH === null &&
      row['unit'] === undefined &&
      row['number'] === undefined &&
      typeof row['type'] === 'string' &&
      (row['type'] as string).includes('TOKENS_LIMIT')
    ) {
      // Pre-windowed payload shape: the only window reported is the 5-hour one.
      legacyFiveH = readingFromRow(row);
    }
  }
  if (fiveH === null) fiveH = legacyFiveH;

  out.five_h_pct_left = fiveH?.pct_left ?? null;
  out.five_h_reset_at = fiveH?.reset_at ?? null;
  out.weekly_pct_left = weekly?.pct_left ?? null;
  out.weekly_reset_at = weekly?.reset_at ?? null;
  if (level !== null) out.plan_level = level;
  if (subscriptionStatus !== null) out.subscription_status = subscriptionStatus;
  return out;
}

/** A fresh per-label snapshot with everything unknown (seen_at starts null until a poll lands). */
export function emptyLabelSnapshot(label: string): ZaiQuotaLabelSnapshot {
  return {
    label,
    five_h_pct_left: null,
    weekly_pct_left: null,
    five_h_reset_at: null,
    weekly_reset_at: null,
    plan_level: null,
    subscription_status: null,
    seen_at: null,
    error: null,
  };
}
