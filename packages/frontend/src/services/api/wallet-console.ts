import { fetchMutate } from './core';
import {
  loadLiveConsole,
  mapLoadBalancerResponse,
  mapProgressResponse,
  mapSettingsResponse,
  probeOwner,
  putWalletLine,
  rulingIdOf,
} from './wallet-console-live';

/**
 * Wallet console (RET-721 → D-2026-11-22-11) — the owner-only console.
 *
 * Contract notes:
 * - Every budget number in here is SERVER-PROVIDED. The console never does
 *   budget arithmetic on the client: `allowed_pct`, `used_pct` and
 *   `projected_pct` arrive already computed, together with the component
 *   strips that spell the arithmetic out. The UI renders those strips verbatim.
 * - There is NO fixture and NO fallback payload in this module. When the live
 *   API is missing or refuses the caller, the error is surfaced verbatim to
 *   the owner. A console that invents numbers is worse than a console that
 *   says "not available".
 */

export interface WalletFormulaStrip {
  /** Human label for the whole strip, e.g. "today allowed". */
  label: string;
  /** Ordered terms of the formula. `op` is the operator that precedes it. */
  terms: Array<{ op: string; label: string; value: number; unit?: string }>;
  /** The server-computed result of the strip. */
  result: { label: string; value: number; unit?: string };
  /** Ruling that governs this arithmetic, when one applies. */
  ruling_id?: string | null;
}

export interface WalletLine {
  wallet_id: string;
  name: string;
  /** Display form, e.g. "MAIN (Z.AI Max)". */
  display_name: string;
  color: string;
  provider: string;
  /** Component values (server-computed). */
  base_pct: number;
  rollover_pct: number;
  reserve_pct: number;
  floor_pct: number;
  /** Server-computed result of the day's line. */
  allowed_pct: number;
  formula: WalletFormulaStrip;
  /** Underlying USD lines, when the wallet is governed by them. */
  daily_usd?: number | null;
  weekly_usd?: number | null;
  /** Provider-supplied reset stamp. */
  resets_at?: string | null;
  resets_label?: string | null;
  reset_hint?: string | null;
  /** Backup-as-finite-spare notes (owner pick D-2026-11-20-22). */
  note?: string | null;
}

export interface WalletAuditEntry {
  at: string;
  /** Short line describing the change, e.g. "MAIN rollover set 4.3%". */
  summary: string;
  ruling_id?: string | null;
}

export interface WalletBehaviour {
  drain_auto_lift: boolean;
  parked: boolean;
  kill_switch_to_fallback: boolean;
  budget_mode: 'enforce' | 'shadow' | 'off';
  budget_mode_source?: string | null;
}

export interface WalletPriorityRow {
  wallet_id: string;
  name: string;
  rank: number;
  lane_tags: string[];
  lane_tags_live?: boolean;
  pill: { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'drain' | 'info' };
}

export interface WalletSettingsResponse {
  week_anchor?: string | null;
  night_window?: string | null;
  lines: WalletLine[];
  behaviour: WalletBehaviour;
  priority: WalletPriorityRow[];
  audit: WalletAuditEntry[];
  members: Array<{ wallet: string; keys: string }>;
  /** Latest governor tick, so the owner sees the gate re-read the line. */
  governor_tick?: {
    at: string;
    mode: string;
    allowed_pct: number;
    used_pct: number;
  } | null;
}

/** One provider-own window the wallet still has left. */
export interface WindowHeadroom {
  /** % of the window still available (provider-own reading). */
  pct_left: number | null;
  /** Provider-own reset stamp (ISO) — never a wall-clock anchor. */
  reset_at: string | null;
  /** Short label of the reset stamp. */
  resets_label: string | null;
}

/** The allowance engine state the governor publishes. */
export interface AllowanceEngineView {
  rollover_enabled: boolean;
  rollover_model: string | null;
  rollover_mode: string | null;
  rollover_active: string | null;
  rollover_reason: string | null;
  primary: string | null;
  primary_usable_pct: number | null;
  backup: string | null;
  backup_usable_pct: number | null;
  backup_membership_active: boolean;
  backup_membership_end: string | null;
  new_ration_day: boolean;
  week_start: string | null;
  day_start_utc: string | null;
  day_epoch: string | null;
  enforce_tick_at: string | null;
}

/**
 * One wallet's day line as the governor decided it — the balancer's unit.
 * Every field is server-computed; the page renders them verbatim.
 */
export interface DayLineView {
  wallet_id: string;
  name: string;
  display_name: string;
  provider: string;
  account: string | null;
  /** Governor day number ("day 3"), never a wall-clock midnight. */
  day_label: string | null;
  /** % of the weekly pool the governor allows today. */
  allowed_pct: number | null;
  /** % of the weekly pool spent today. */
  used_pct: number | null;
  /** % of the weekly pool still allowed today. */
  remaining_pct: number | null;
  base_pct: number | null;
  rollover_pct: number | null;
  /** Owner reserve held back today (% of the weekly pool). */
  reserve_pct: number | null;
  /** Reserve accrued at the last day lift. */
  accrued_at_lift_pct: number | null;
  /** Usable pool after reservation holds. */
  available_pct: number | null;
  floor_pct: number | null;
  /** Current burn rate (% of the weekly pool per hour). */
  pace_pct_per_h: number | null;
  /** Projected spend at the end of the working day, at the current pace. */
  projected_end_pct: number | null;
  /** Working hours left in the ration day. */
  working_hours_left: number | null;
  /** Hours elapsed inside the ration day. */
  day_elapsed_hours: number | null;
  /** The ration day's reset anchor (epoch, ISO and label). */
  day_epoch: number | null;
  day_start_utc: string | null;
  /** Provider-own anchor note (e.g. the provider reset stamp). */
  anchor_note: string | null;
  anchor_source: string | null;
  anchor_stale: boolean;
  /** Provider-own windows for this wallet. */
  five_h: WindowHeadroom;
  weekly: WindowHeadroom;
}

export interface LoadBalancerCard {
  wallet_id: string;
  name: string;
  display_name: string;
  provider: string;
  state: { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' };
  lane_tags: string[];
  lane_tags_live?: boolean;
  in_flight: number;
  ceiling: number;
  window: { pct_left: number; resets_label?: string | null };
  weekly: { pct_left: number; resets_label?: string | null };
  priority: number;
  priority_hint?: string | null;
  provider_state: { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral'; detail?: string | null };
}

export interface LoadBalancerResponse {
  admission: { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' };
  cards: LoadBalancerCard[];
  provider_state: Array<{ provider: string; value: string }>;
  lane_targets?: { target_band: string } | null;
  /** The allowance engine the governor published (rollover, anchors, ticks). */
  engine: AllowanceEngineView | null;
  /** One day line per wallet — the allowance engine's per-wallet state. */
  day_lines: DayLineView[];
  /** The engine's last enforcement tick. */
  enforce_tick_at: string | null;
}

export interface ProgressBlock {
  wallet_id: string;
  name: string;
  /** Display form, e.g. "MAIN (Z.AI Max)". */
  display_name: string;
  color: string;
  provider: string;
  used_pct: number;
  allowed_pct: number;
  projected_pct: number;
  still_allowed_pct: number;
  floor_pct: number;
  pace: 'ahead' | 'on-pace' | 'behind';
  badges: string[];
  formula: WalletFormulaStrip;
  resets_label?: string | null;
  reset_hint?: string | null;
  note?: string | null;
  /**
   * The governor account this block reports. A wallet can own more than one
   * account, and each account carries its OWN day window — so the console
   * reports one block per account, never one merged number for the wallet.
   */
  account?: string | null;
  /**
   * The wallet's own day window, as the governor numbered it (day N of the
   * ration week). Never a wall-clock midnight anchor.
   */
  day_label?: string | null;
  /**
   * False when the server published no line for this block. A block that is
   * not published renders an empty state — NEVER a 0.0% bar, because a zero
   * bar reads as "nothing was spent" when the truth is "no data".
   */
  published: boolean;
  /** Why the block has no line, in the server's own words. */
  published_note?: string | null;
  /** Provider-own 5-hour window headroom (never polled from the browser). */
  five_h: WindowHeadroom;
  /** Provider-own weekly window headroom. */
  weekly: WindowHeadroom;
  /** % of the weekly pool already spent (provider-own). */
  spent_week_pct: number | null;
  /** The weekly pool in the provider's own denomination. */
  weekly_pool: number | null;
  denomination: string | null;
  /** Burn pace (% of the weekly pool per hour) and the projected reset-day end. */
  pace_pct_per_h: number | null;
  projected_end_pct: number | null;
  working_hours_left: number | null;
  /** Reserve, accrued reserve and the rollover pool for this day. */
  reserve_pct: number | null;
  accrued_at_lift_pct: number | null;
  rollover_pct: number | null;
  /** The ration day's reset anchor. */
  day_start_utc: string | null;
  anchor_note: string | null;
  anchor_stale: boolean;
}

export interface BurnMeter {
  in_flight: number;
  recommended: number;
  quota_headroom_pct: number;
  target_band: string;
  verdict: string;
  /** Advisory only — the gauge proposes, it never moves a lane by itself. */
  advisory: boolean;
}

export interface HeatmapCell {
  /** Percent of weekly allowance burned, or null for a day that hasn't happened. */
  pct: number | null;
  state: 'under' | 'on' | 'over' | 'burn' | 'future';
}

export interface HeatmapWeek {
  label: string;
  cells: HeatmapCell[];
}

export interface ProgressResponse {
  blocks: ProgressBlock[];
  burn: BurnMeter;
  heatmap: { weeks: HeatmapWeek[]; note?: string | null };
  day_strip?: Array<{ day: string; pct: number; over?: boolean; drain?: boolean }> | null;
  /** Audit & rulings, when the server supplies them for this surface. */
  audit?: WalletAuditEntry[] | null;
  /**
   * False when the server has no governor state to report (the ration state
   * is missing or unreadable). The console says so instead of drawing empty
   * bars that look like "nothing was spent".
   */
  available: boolean;
  /** The server's own reason, shown verbatim in the empty state. */
  unavailable_reason?: string | null;
}

export interface AskCrewResponse {
  ok: boolean;
  card_ref?: string | null;
}

export interface WalletConsoleAccess {
  /** True when the signed-in user owns the tenant. */
  owner: boolean;
  /** True when the live console surface answered. */
  available: boolean;
}

/**
 * Transport notes (RET-721 → RET-720).
 *
 * The console reads the REAL backend contract:
 *
 *   GET /wallets/:id/settings(+/audit)  ·  GET /quota-board  ·  GET /budgets/daily
 *
 * Failure classes are kept distinct, because they mean different things to
 * the owner:
 * - 403 → signed in, but not the tenant owner.
 * - 404 → the console surface is not deployed (feature flag off).
 * - anything else → a real error.
 *
 * None of them produce a substitute payload: the owner sees the truth.
 */
export async function getWalletSettings(): Promise<WalletSettingsResponse> {
  return mapSettingsResponse(await loadLiveConsole());
}

export async function getLoadBalancer(): Promise<LoadBalancerResponse> {
  return mapLoadBalancerResponse(await loadLiveConsole());
}

export async function getDailyProgress(): Promise<ProgressResponse> {
  return mapProgressResponse(await loadLiveConsole());
}

/**
 * Owner access check. There is no `/access` endpoint: `budgets/daily` is the
 * cheapest owner-gated read (it makes no provider poll), so it doubles as the
 * gate probe.
 *
 * - 200 → owner, surface available.
 * - 403 → signed in, not the owner: a real verdict.
 * - 404 → the console surface is not deployed: `available: false`, so the UI
 *   can say so instead of showing numbers it does not have.
 */
export async function getWalletConsoleAccess(): Promise<WalletConsoleAccess> {
  try {
    const verdict = await probeOwner();
    if (verdict.owner) return { owner: true, available: true };
    return { owner: false, available: verdict.available };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Unauthorized|Forbidden|session|401|403/i.test(message)) {
      return { owner: false, available: false };
    }
    if (/404|Not Found/i.test(message)) return { owner: false, available: false };
    throw err;
  }
}

export interface UpdateLineInput {
  wallet_id: string;
  base_pct?: number;
  rollover_pct?: number;
}

/**
 * Round-trips one settings line change against the live API.
 *
 * `PUT /wallets/:id/settings` writes the owner's daily line. The server mints
 * the audit row and the auto-minted decisions-ledger ruling; the console then
 * re-reads the board so the governor tick, the audit trail and the ruling id
 * all come from the server rather than from the browser.
 */
export async function updateWalletLine(input: UpdateLineInput): Promise<WalletSettingsResponse> {
  const response = await putWalletLine({
    wallet_id: input.wallet_id,
    base_pct: input.base_pct ?? 0,
    rollover_pct: input.rollover_pct ?? 0,
    // The floor is not sent: it is a locked server-side value and the
    // console only ever displays it.
    floor_pct: undefined,
  });
  const fresh = mapSettingsResponse(await loadLiveConsole());
  const rulingId = rulingIdOf(response);
  if (!rulingId) return fresh;
  // The freshly-read audit trail carries the ruling id when the server
  // published one; when it does not, surface the id the PUT returned so the
  // owner still sees which ruling was minted for this change.
  const audit = fresh.audit.map((entry) =>
    entry.ruling_id === rulingId ? entry : { ...entry, ruling_id: entry.ruling_id ?? rulingId },
  );
  return { ...fresh, audit };
}

/**
 * Files a needs-you card for the crew.
 *
 * When the server publishes no filing route the failure is surfaced to the
 * owner — the console never pretends a card was filed.
 */
export async function askCrew(message: string): Promise<AskCrewResponse> {
  const data = await fetchMutate<AskCrewResponse>('/wallets/console/ask-crew', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  return { ...data, ok: data.ok !== false };
}
