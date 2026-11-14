/**
 * Live MiniMax M Plan quota truth (RET-598-FU7-GW).
 *
 * Zero-LLM source: `GET {base}/v1/token_plan/remains` with the connection's
 * own bearer key — the documented M Plan usage endpoint (MiniMax docs "How
 * can I check M Plan usage?"), verified live 2026-11-12 against the crew's
 * `RCR MM` / `CCR MM` keys. The payload carries the same two rolling windows
 * the z.ai monitor reports — a 5-hour interval (`current_interval_*`) and a
 * weekly window (`current_weekly_*`) — each with a remaining percent and an
 * epoch-ms reset instant, so `<ROOM> MM` rows land in the SAME feed shape as
 * the zai seats (`five_h_pct_left` / `weekly_pct_left`).
 *
 * Envelope: `{model_remains: [...], base_resp: {status_code, status_msg}}`;
 * `status_code 0` is success, non-zero (e.g. 2049 invalid api key) means the
 * key itself is rejected — that is a per-label error, not a healthy empty
 * poll. This module is deliberately pure (no Nest, no fetch, no crypto) so
 * the payload parser is unit-testable against the documented shape without
 * network or key material.
 */

/** Monitor path (appended to the monitor base URL). */
export const MINIMAX_QUOTA_PATH = '/v1/token_plan/remains';

/**
 * Default monitor base. `https://api.minimax.io` and `https://www.minimax.io`
 * both serve this path for global-region keys (verified live 2026-11-12);
 * the api origin is the default because the stored subscription blob's
 * resource URL is an `api.minimax.io` origin. `minimaxi.com` hosts are the
 * CN region and reject global keys with `status_code 2049`.
 */
export const MINIMAX_QUOTA_BASE_DEFAULT = 'https://api.minimax.io';

/** MiniMax plan-envelope success code (`base_resp.status_code === 0`). */
const MINIMAX_STATUS_OK = 0;

/** Parsed quota payload, independent of which connection produced it. */
export interface ParsedMinimaxQuota {
  five_h_pct_left: number | null;
  weekly_pct_left: number | null;
  five_h_reset_at: string | null;
  weekly_reset_at: string | null;
  /** Always null today — the remains payload carries no tier name. */
  plan_level: string | null;
  /** `active` on a success envelope; null when the envelope itself failed. */
  subscription_status: string | null;
  /** Envelope status code (0 = ok); null when the envelope is unshaped. */
  plan_status_code: number | null;
  /** Envelope status message when present (diagnostics only, never the feed). */
  plan_status_msg: string | null;
}

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

/** Clamp a remaining-percent gauge into the documented 0-100 feed range. */
function clampPct(value: unknown): number | null {
  const pct = toFiniteNumber(value);
  if (pct === null) return null;
  return Math.min(100, Math.max(0, pct));
}

/** Epoch-ms instant to ISO string; null when absent or non-positive. */
function resetAt(value: unknown): string | null {
  const ms = toFiniteNumber(value);
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

/**
 * Prefer the `general` row (the text-model bucket every M Plan key shares);
 * fall back to the first shaped row. Malformed rows are skipped.
 */
function pickRemainsRow(payload: Record<string, unknown>): Record<string, unknown> | null {
  const raw = payload['model_remains'];
  if (!Array.isArray(raw)) return null;
  let first: Record<string, unknown> | null = null;
  for (const row of raw) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    if (first === null) first = record;
    if (record['model_name'] === 'general') return record;
  }
  return first;
}

/**
 * Parse a `/v1/token_plan/remains` payload into window readings.
 *
 * A non-zero `base_resp.status_code` (e.g. 2049 invalid api key) fills
 * `plan_status_code`/`plan_status_msg` and leaves every gauge null — the
 * caller turns that into a per-label error. Never throws on shape surprises;
 * unknown fields simply stay null.
 */
export function parseMinimaxTokenPlanRemainsPayload(payload: unknown): ParsedMinimaxQuota {
  const out: ParsedMinimaxQuota = {
    five_h_pct_left: null,
    weekly_pct_left: null,
    five_h_reset_at: null,
    weekly_reset_at: null,
    plan_level: null,
    subscription_status: null,
    plan_status_code: null,
    plan_status_msg: null,
  };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return out;
  const envelope = payload as Record<string, unknown>;

  const baseResp = envelope['base_resp'];
  if (baseResp && typeof baseResp === 'object' && !Array.isArray(baseResp)) {
    const record = baseResp as Record<string, unknown>;
    const code = toFiniteInt(record['status_code']);
    if (code !== null) {
      out.plan_status_code = code;
      out.plan_status_msg = pickString(record, ['status_msg']);
    }
  }

  const row = pickRemainsRow(envelope);
  if (row === null) return out;

  out.five_h_pct_left = clampPct(row['current_interval_remaining_percent']);
  out.weekly_pct_left = clampPct(row['current_weekly_remaining_percent']);
  out.five_h_reset_at = resetAt(row['end_time']);
  out.weekly_reset_at = resetAt(row['weekly_end_time']);
  if (out.plan_status_code === MINIMAX_STATUS_OK) {
    out.subscription_status = 'active';
  }
  return out;
}

/**
 * One stored MiniMax subscription credential's usable parts. The gateway
 * stores these as encrypted JSON blobs `{t, r, e, u}` (access token, refresh
 * token, absolute expiry, resource URL) — the quota poller needs the access
 * token and the resource origin only.
 */
export interface MinimaxBlobParts {
  accessToken: string;
  resourceOrigin: string | null;
}

/**
 * Extract the bearer token + resource origin from a decrypted blob string.
 * Returns null when the plaintext is not a usable OAuth blob (wrong shape or
 * no access token) — a per-label error class for the caller, never a throw.
 */
export function parseMinimaxSubscriptionBlob(raw: string): MinimaxBlobParts | null {
  let blob: unknown;
  try {
    blob = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return null;
  const record = blob as Record<string, unknown>;
  const accessToken = record['t'];
  if (typeof accessToken !== 'string' || accessToken.trim() === '') return null;
  let resourceOrigin: string | null = null;
  if (typeof record['u'] === 'string' && record['u'].trim() !== '') {
    try {
      const url = new URL(record['u']);
      if (url.protocol === 'https:') resourceOrigin = url.origin;
    } catch {
      // Unusable resource URL falls back to the default base.
    }
  }
  return { accessToken, resourceOrigin };
}
