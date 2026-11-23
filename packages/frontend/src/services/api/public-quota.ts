/**
 * Public quota feed (ret500-nodupe) — `GET /quota.json`.
 *
 * Root-level path, NOT under /api/v1: this feed is the always-served mirror
 * of the wallet console's maths and must answer with no session at all
 * (the owner's local quota app and the public /quota page both read it).
 * The backend answers 200 with last-known values + `stale: true` when a
 * poll fails — reading quota never depends on key active-state.
 */

export type PublicQuotaPace = 'ON_PACE' | 'SLOW' | 'FAST' | null;
export type PublicQuotaSource = 'zai-coding-plan' | 'minimax-token-plan' | 'mixed';

export interface PublicQuotaFormulaStrip {
  label: 'allowed today';
  base_pct: number | null;
  reserve_pct: number | null;
  rollover_pool_pct: number | null;
  floor_pct: number | null;
  allowed_today_pct: number | null;
}

export interface PublicQuotaWallet {
  name: 'MAIN' | 'MM' | 'BACKUP';
  display_name: string;
  source: PublicQuotaSource;
  parked: boolean;
  halted: boolean;
  used_today_pct: number | null;
  allowed_today_pct: number | null;
  weekly_pct_left: number | null;
  weekly_reset_at: string | null;
  five_h_pct_left: number | null;
  five_h_reset_at: string | null;
  weekly_spent_pct: number | null;
  /** The wallet's OWN ration day number (1-based, the governor's own clock). */
  day_number?: number | null;
  /** The wallet's own ration day index (0-based within the ration week). */
  day_index?: number | null;
  /** UTC clock the ration day starts at (the daily reset clock). */
  day_start_utc?: string | null;
  /** The wallet's own provider-own week reset anchor (its own week clock). */
  week_reset_at?: string | null;
  /** The governor's ration model label, verbatim. */
  ration_model?: string | null;
  pace: PublicQuotaPace;
  pace_pct_per_h: number | null;
  projected_end_pct: number | null;
  working_hours_left: number | null;
  projection: string | null;
  formula: PublicQuotaFormulaStrip;
  stale: boolean;
  polled_at: string | null;
  published: boolean;
  note: string | null;
  color: string | null;
}

export interface PublicQuotaFeed {
  wallets: Record<'MAIN' | 'MM' | 'BACKUP', PublicQuotaWallet>;
  tick_at: string | null;
  generated_at: string;
  stale: boolean;
  polled_at: string | null;
  ration_available: boolean;
  ration_unavailable_reason: string | null;
}

/** Root-level fetch — never goes through the /api/v1 client. */
export async function getPublicQuota(): Promise<PublicQuotaFeed> {
  const res = await fetch('/quota.json', { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`quota feed unavailable (${res.status})`);
  }
  return (await res.json()) as PublicQuotaFeed;
}

export const PUBLIC_WALLET_ORDER = ['MAIN', 'MM', 'BACKUP'] as const;
