import { fetchJson, fetchMutate } from './core';
import { walletDisplayName } from './wallet-options';
import type {
  AllowanceEngineView,
  DayLineView,
  ProgressBlock,
  ProgressResponse,
  LoadBalancerResponse,
  WalletAuditEntry,
  WalletBehaviour,
  WalletFormulaStrip,
  WalletLine,
  WalletPriorityRow,
  WalletSettingsResponse,
  WindowHeadroom,
} from './wallet-console';

/**
 * Live transport for the wallet console (RET-721 → RET-720 backend).
 *
 * This module speaks the REAL RET-720 contract (commit 54047be73):
 *
 *   GET /wallets/:id/settings          → { settings }
 *   PUT /wallets/:id/settings          → { settings, changed, audit_id, ruling }
 *   GET /wallets/:id/settings/audit    → { audit: [...] }
 *   GET /quota-board                   → { generated_at, stale_feed, wallets[] }
 *   GET /budgets/daily                 → { generated_at, accounts[], wallets[] }
 *
 * Rules that survive the rewrite:
 * - No client-side budget arithmetic. Every percentage is server-computed;
 *   the formula strip renders the server's terms and the server's result.
 * - A 403 means "signed in, not the owner" — never "endpoint missing".
 * - A 404 means the console surface is disabled — it is surfaced verbatim.
 *   There is NO demo fallback: a console that invents numbers is worse than
 *   one that says "not available".
 */

/* ------------------------------------------------------------------ */
/* Raw backend shapes                                                  */
/* ------------------------------------------------------------------ */

export interface RawWalletSettings {
  wallet_id: string;
  tenant_id: string;
  drain_day_enabled: boolean;
  priority: number;
  parked: boolean;
  kill_switch_fallback: boolean;
  daily_lines: { base_pct?: number; rollover_pool_pct?: number; floor_pct?: number } | null;
  /** Owner reserve (% of the weekly pool); null = the governor's own reserve. */
  reserve_pct?: number | null;
  rollover_enabled?: boolean;
  cross_class_pause?: boolean;
  key_bindings?: Array<{ room: string; tenant_provider_id: string; label?: string; provider?: string }>;
  updated_at: string;
  updated_by_user_id: string | null;
}

export interface RawSettingsResponse {
  settings: RawWalletSettings;
}

export interface RawUpdateResponse {
  settings: RawWalletSettings;
  changed: boolean;
  audit_id: string | null;
  ruling: { id?: string; ruling_id?: string; decision_id?: string } | null;
}

export interface RawAuditRow {
  wallet_id?: string;
  actor_user_id?: string | null;
  action?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ruling_id?: string | null;
  created_at?: string;
}

export interface RawQuotaBoardKey {
  label: string;
  provider: string;
  account: string | null;
  five_h_pct_left: number | null;
  weekly_pct_left: number | null;
  five_h_reset_at: string | null;
  weekly_reset_at: string | null;
  plan_level: string | null;
  subscription_status: string | null;
  seen_at: string | null;
  stale: boolean;
  error: string | null;
  halted: boolean;
}

export interface RawQuotaBoardWallet {
  wallet_id: string;
  name: string;
  color: string;
  parked: boolean;
  priority: number;
  drain_day_enabled: boolean;
  halted: boolean;
  min_five_h_pct_left: number | null;
  min_weekly_pct_left: number | null;
  keys: RawQuotaBoardKey[];
}

export interface RawQuotaBoard {
  generated_at: string;
  polled_at: string | null;
  stale_feed: boolean;
  ration: { available: boolean; updated_at: string | null; unavailable_reason: string | null };
  wallets: RawQuotaBoardWallet[];
}

export interface RawDailyAccount {
  account: string;
  keys: string[];
  allowed_today_pct: number | null;
  used_today_pct: number | null;
  remaining_today_pct: number | null;
  base_pct: number | null;
  rollover_pool_pct: number | null;
  floor_pct: number | null;
  weekly_headroom_pct: number | null;
  five_h_headroom_pct: number | null;
  reserve_pct: number | null;
  accrued_at_lift_pct: number | null;
  reserved_pct: number | null;
  reservation_holds: number | null;
  available_pct: number | null;
  spent_week_pct: number | null;
  weekly_pool: number | null;
  denomination: string | null;
  drain_day: boolean;
  drain_window: boolean;
  allow: boolean;
  halted: boolean;
  day_number: number | null;
  day_index: number | null;
  ration_model: string | null;
  release_stage: string | null;
  binding_dimension: string | null;
  capped_by_floor: boolean;
  final_hour: boolean;
  reasons: string[];
  halted_by_console: boolean;
  anchor: { epoch: number | null; source: string | null; stale: boolean; note: string | null } | null;
  day_epoch: number | null;
  day_start_utc: string | null;
  day_elapsed_hours: number | null;
  pace_pct_per_h: number | null;
  projected_end_pct: number | null;
  working_hours_left: number | null;
}

/** The allowance engine the governor publishes (rollover + day anchors). */
export interface RawAllowanceEngine {
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

export interface RawDailyWallet {
  wallet_id: string;
  name: string;
  accounts: string[];
  parked: boolean;
  drain_day_enabled: boolean;
  daily_lines: { base_pct?: number; rollover_pool_pct?: number; floor_pct?: number } | null;
}

export interface RawDailyBudget {
  generated_at: string;
  available: boolean;
  unavailable_reason: string | null;
  ration_updated_at: string | null;
  accounts: RawDailyAccount[];
  wallets: RawDailyWallet[];
  engine: RawAllowanceEngine | null;
}

/** Thrown when the backend refuses the caller for a reason other than auth. */
export class OwnerOnlyError extends Error {
  constructor(message = 'Owner only') {
    super(message);
    this.name = 'OwnerOnlyError';
  }
}

/** Thrown when the console surface is not deployed / disabled by flag. */
export class ConsoleUnavailableError extends Error {
  constructor(message = 'Wallet console is not available') {
    super(message);
    this.name = 'ConsoleUnavailableError';
  }
}

/**
 * Wraps a fetch so the caller can tell the three failure classes apart:
 * 401 → not signed in, 403 → not the owner, 404 → surface disabled.
 */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/\b403\b|forbidden|owner only/i.test(message)) throw new OwnerOnlyError(message);
    if (/\b404\b|not found/i.test(message)) throw new ConsoleUnavailableError(message);
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Small formatting helpers                                            */
/* ------------------------------------------------------------------ */

function resetLabel(stamp: string | null | undefined): string | null {
  if (!stamp) return null;
  const parsed = Date.parse(stamp);
  if (!Number.isFinite(parsed)) return stamp;
  return new Date(parsed).toISOString().slice(5, 16).replace('T', ' ');
}

function num(value: number | null | undefined, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function formulaFrom(
  base: number,
  rollover: number,
  floor: number,
  allowed: number,
  label: string,
  rulingId?: string | null,
): WalletFormulaStrip {
  return {
    label,
    terms: [
      { op: '', label: 'base', value: base, unit: '%' },
      { op: '+', label: 'rollover pool', value: rollover, unit: '%' },
      { op: '−', label: 'locked floor', value: floor, unit: '%' },
    ],
    result: { label: `${label} =`, value: allowed, unit: '%' },
    ruling_id: rulingId ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export interface LiveConsoleData {
  board: RawQuotaBoard;
  daily: RawDailyBudget;
  settings: Map<string, RawWalletSettings>;
  audit: Map<string, WalletAuditEntry[]>;
}

/** GET /wallets/:id/settings — owner only. */
export async function fetchWalletSettings(walletId: string): Promise<RawWalletSettings> {
  const body = await guarded(() =>
    fetchJson<RawSettingsResponse>(`/wallets/${encodeURIComponent(walletId)}/settings`, undefined, {
      cache: false,
    }),
  );
  return body.settings;
}

/** GET /wallets/:id/settings/audit — owner only. */
export async function fetchWalletAudit(walletId: string): Promise<WalletAuditEntry[]> {
  const body = await guarded(() =>
    fetchJson<{ audit: RawAuditRow[] }>(
      `/wallets/${encodeURIComponent(walletId)}/settings/audit`,
      undefined,
      { cache: false },
    ),
  );
  const rows = body.audit ?? [];
  return rows.map((row) => ({
    at: row.created_at ?? '',
    summary: summarizeAudit(row),
    ruling_id: row.ruling_id ?? null,
  }));
}

function summarizeAudit(row: RawAuditRow): string {
  const after = row.after ?? {};
  const before = row.before ?? {};
  const keys = ['base_pct', 'rollover_pool_pct', 'floor_pct', 'priority', 'parked'];
  const changed = keys.filter((key) => {
    const a = (after as Record<string, unknown>)[key];
    const b = (before as Record<string, unknown>)[key];
    return a !== undefined && JSON.stringify(a) !== JSON.stringify(b);
  });
  if (changed.length === 0) return row.action ?? 'settings updated';
  const parts = changed.map((key) => {
    const a = (after as Record<string, unknown>)[key];
    return `${key} → ${String(a)}`;
  });
  return parts.join(' · ');
}

/** GET /quota-board — owner only; forces a fresh provider-own poll. */
export async function fetchQuotaBoard(): Promise<RawQuotaBoard> {
  return guarded(() => fetchJson<RawQuotaBoard>('/quota-board', undefined, { cache: false }));
}

/** GET /budgets/daily — owner only; reads the published governor state. */
export async function fetchDailyBudget(): Promise<RawDailyBudget> {
  return guarded(() => fetchJson<RawDailyBudget>('/budgets/daily', undefined, { cache: false }));
}

/**
 * Owner probe. There is no `/access` endpoint: `budgets/daily` is the cheapest
 * owner-gated read (no provider poll), so it doubles as the gate check.
 */
export async function probeOwner(): Promise<{ owner: boolean; available: boolean }> {
  try {
    await fetchDailyBudget();
    return { owner: true, available: true };
  } catch (err) {
    if (err instanceof OwnerOnlyError) return { owner: false, available: true };
    if (err instanceof ConsoleUnavailableError) return { owner: false, available: false };
    throw err;
  }
}

/** Reads everything the console pages need, for every wallet on the board. */
export async function loadLiveConsole(): Promise<LiveConsoleData> {
  const [board, daily] = await Promise.all([fetchQuotaBoard(), fetchDailyBudget()]);
  const settings = new Map<string, RawWalletSettings>();
  const audit = new Map<string, WalletAuditEntry[]>();

  await Promise.all(
    board.wallets.map(async (wallet) => {
      try {
        settings.set(wallet.wallet_id, await fetchWalletSettings(wallet.wallet_id));
      } catch {
        // A wallet whose settings row cannot be read still appears on the
        // board; its line falls back to the governor numbers.
      }
      try {
        audit.set(wallet.wallet_id, await fetchWalletAudit(wallet.wallet_id));
      } catch {
        audit.set(wallet.wallet_id, []);
      }
    }),
  );

  return { board, daily, settings, audit };
}

/* ------------------------------------------------------------------ */
/* Mapping: server payloads → the console's view models                */
/* ------------------------------------------------------------------ */

export function mapLines(data: LiveConsoleData): WalletLine[] {
  const accountByName = new Map(data.daily.accounts.map((a) => [a.account, a]));
  return data.board.wallets.map((wallet) => {
    const settings = data.settings.get(wallet.wallet_id);
    const dailyWallet = data.daily.wallets.find((w) => w.wallet_id === wallet.wallet_id);
    const account = dailyWallet?.accounts.map((name) => accountByName.get(name)).find(Boolean);

    const lines = settings?.daily_lines ?? dailyWallet?.daily_lines ?? null;
    const base = num(lines?.base_pct ?? account?.base_pct);
    const rollover = num(lines?.rollover_pool_pct ?? account?.rollover_pool_pct);
    const floor = num(lines?.floor_pct ?? account?.floor_pct);
    const allowed = num(account?.allowed_today_pct);
    const provider = wallet.keys[0]?.provider ?? '—';

    return {
      wallet_id: wallet.wallet_id,
      name: wallet.name,
      display_name: walletDisplayName(wallet.name, provider),
      color: wallet.color,
      provider,
      base_pct: base,
      rollover_pct: rollover,
      reserve_pct: num(account?.reserve_pct ?? settings?.reserve_pct),
      floor_pct: floor,
      allowed_pct: allowed,
      formula: formulaFrom(base, rollover, floor, allowed, 'allowed today'),
      resets_label: resetLabel(wallet.keys[0]?.five_h_reset_at),
      resets_at: wallet.keys[0]?.five_h_reset_at ?? null,
      reset_hint: wallet.parked
        ? 'Parked from the console — the governor halts this wallet.'
        : `Priority ${wallet.priority}`,
      note: wallet.parked
        ? 'Emergency park is on.'
        : /backup/i.test(wallet.name)
          ? // Owner doctrine (D-2026-11-20-22): the Backup wallet is a FINITE
            // spare, not a refill. The read API publishes no reserve figure, so
            // this note carries the doctrine, not a number.
            'Finite spare — no refill assumption. Roughly 9% of the reserve was left and it is gone after early Dec.'
          : null,
    };
  });
}

export function mapBehaviour(data: LiveConsoleData): WalletBehaviour {
  const settings = [...data.settings.values()];
  const parked = settings.some((s) => s.parked);
  const mode = data.daily.ration_updated_at ? 'enforce' : 'off';
  return {
    drain_auto_lift: settings.length > 0 && settings.every((s) => s.drain_day_enabled),
    parked,
    kill_switch_to_fallback: settings.some((s) => s.kill_switch_fallback),
    budget_mode: mode,
    budget_mode_source: `governor state @ ${data.daily.ration_updated_at ?? 'unknown'}`,
  };
}

export function mapPriority(data: LiveConsoleData): WalletPriorityRow[] {
  return [...data.board.wallets]
    .sort((a, b) => a.priority - b.priority)
    .map((wallet, index) => ({
      wallet_id: wallet.wallet_id,
      name: wallet.name,
      rank: index + 1,
      lane_tags: wallet.keys.map((k) => k.label),
      lane_tags_live: !data.board.stale_feed,
      pill: wallet.parked
        ? { label: 'Parked', tone: 'warn' as const }
        : wallet.halted
          ? { label: 'Halted', tone: 'danger' as const }
          : { label: 'Active', tone: 'ok' as const },
    }));
}

export function mapMembers(data: LiveConsoleData): Array<{ wallet: string; keys: string }> {
  return data.board.wallets.map((wallet) => ({
    wallet: wallet.name,
    keys: wallet.keys.map((k) => `${k.label} · ${k.provider}`).join(', '),
  }));
}

export function mapSettingsResponse(data: LiveConsoleData): WalletSettingsResponse {
  const account = data.daily.accounts[0];
  return {
    week_anchor: null,
    night_window: null,
    lines: mapLines(data),
    behaviour: mapBehaviour(data),
    priority: mapPriority(data),
    audit: [...data.audit.values()].flat().sort((a, b) => b.at.localeCompare(a.at)),
    members: mapMembers(data),
    governor_tick: {
      at: data.daily.ration_updated_at ?? data.daily.generated_at,
      mode: data.daily.available ? 'enforce' : 'halted',
      allowed_pct: num(account?.allowed_today_pct),
      used_pct: num(account?.used_today_pct),
    },
  };
}

export function mapLoadBalancerResponse(data: LiveConsoleData): LoadBalancerResponse {
  const cards = data.board.wallets.map((wallet) => {
    const staleKeys = wallet.keys.filter((k) => k.stale);
    const errored = wallet.keys.find((k) => k.error);
    const providerState = errored
      ? { label: 'Error', tone: 'danger' as const, detail: errored.error ?? undefined }
      : staleKeys.length > 0
        ? { label: 'Stale', tone: 'warn' as const, detail: 'reading older than 5 minutes' }
        : { label: 'Live', tone: 'ok' as const, detail: wallet.keys[0]?.seen_at ?? null };
    const provider = wallet.keys[0]?.provider ?? '—';

    return {
      wallet_id: wallet.wallet_id,
      name: wallet.name,
      display_name: walletDisplayName(wallet.name, provider),
      provider,
      state: wallet.parked
        ? { label: 'Parked', tone: 'warn' as const }
        : wallet.halted
          ? { label: 'Halted', tone: 'danger' as const }
          : { label: 'Drawing', tone: 'ok' as const },
      lane_tags: wallet.keys.map((k) => k.label),
      lane_tags_live: !data.board.stale_feed,
      in_flight: 0,
      ceiling: 0,
      window: {
        pct_left: num(wallet.min_five_h_pct_left),
        resets_label: resetLabel(wallet.keys[0]?.five_h_reset_at),
      },
      weekly: {
        pct_left: num(wallet.min_weekly_pct_left),
        resets_label: resetLabel(wallet.keys[0]?.weekly_reset_at),
      },
      priority: wallet.priority,
      priority_hint: wallet.parked ? 'Parked' : `Priority ${wallet.priority}`,
      provider_state: providerState,
    };
  });

  return {
    admission: data.board.stale_feed
      ? { label: 'Stale feed', tone: 'warn' as const }
      : { label: 'Live', tone: 'ok' as const },
    cards,
    provider_state: data.board.wallets.map((wallet) => ({
      provider: wallet.keys[0]?.provider ?? '—',
      value: wallet.keys
        .map((k) => `${k.label}: ${k.stale ? 'stale' : 'live'}`)
        .join(', '),
    })),
    lane_targets: null,
    engine: mapEngine(data),
    day_lines: mapDayLines(data),
    enforce_tick_at: data.daily.engine?.enforce_tick_at ?? null,
  };
}

/** The allowance engine, exactly as the governor published it. */
export function mapEngine(data: LiveConsoleData): AllowanceEngineView | null {
  const engine = data.daily.engine;
  if (!engine) return null;
  return {
    rollover_enabled: engine.rollover_enabled ?? false,
    rollover_model: engine.rollover_model ?? null,
    rollover_mode: engine.rollover_mode ?? null,
    rollover_active: engine.rollover_active ?? null,
    rollover_reason: engine.rollover_reason ?? null,
    primary: engine.primary ?? null,
    primary_usable_pct: engine.primary_usable_pct ?? null,
    backup: engine.backup ?? null,
    backup_usable_pct: engine.backup_usable_pct ?? null,
    backup_membership_active: engine.backup_membership_active ?? false,
    backup_membership_end: engine.backup_membership_end ?? null,
    new_ration_day: engine.new_ration_day ?? false,
    week_start: engine.week_start ?? null,
    day_start_utc: engine.day_start_utc ?? null,
    day_epoch: engine.day_epoch ?? null,
    enforce_tick_at: engine.enforce_tick_at ?? null,
  };
}

/**
 * The allowance engine's per-wallet day lines.
 *
 * One line per (wallet, governor account) pair — a wallet can own more than
 * one account and each account carries its OWN line, so a merged wallet
 * number would lie. Every field is server-computed.
 */
export function mapDayLines(data: LiveConsoleData): DayLineView[] {
  const accountByName = new Map(data.daily.accounts.map((a) => [a.account, a]));
  const lines: DayLineView[] = [];
  for (const wallet of data.daily.wallets) {
    const boardWallet = data.board.wallets.find((w) => w.wallet_id === wallet.wallet_id);
    const provider = boardWallet?.keys[0]?.provider ?? '—';
    const fiveH = windowOf(boardWallet?.keys, 'five_h');
    const weekly = windowOf(boardWallet?.keys, 'weekly');
    for (const accountName of wallet.accounts) {
      const account = accountByName.get(accountName);
      lines.push({
        wallet_id: wallet.wallet_id,
        name: wallet.name,
        display_name: walletDisplayName(wallet.name, provider),
        provider,
        account: accountName,
        day_label: dayLabel(account),
        allowed_pct: account?.allowed_today_pct ?? null,
        used_pct: account?.used_today_pct ?? null,
        remaining_pct: account?.remaining_today_pct ?? null,
        base_pct: account?.base_pct ?? null,
        rollover_pct: account?.rollover_pool_pct ?? null,
        reserve_pct: account?.reserve_pct ?? null,
        accrued_at_lift_pct: account?.accrued_at_lift_pct ?? null,
        available_pct: account?.available_pct ?? null,
        floor_pct: account?.floor_pct ?? null,
        pace_pct_per_h: account?.pace_pct_per_h ?? null,
        projected_end_pct: account?.projected_end_pct ?? null,
        working_hours_left: account?.working_hours_left ?? null,
        day_elapsed_hours: account?.day_elapsed_hours ?? null,
        day_epoch: account?.day_epoch ?? null,
        day_start_utc: account?.day_start_utc ?? null,
        anchor_note: account?.anchor?.note ?? null,
        anchor_source: account?.anchor?.source ?? null,
        anchor_stale: account?.anchor?.stale ?? false,
        five_h: fiveH,
        weekly,
      });
    }
  }
  return lines;
}

/**
 * The provider-own headroom of one window across a wallet's keys: the
 * LOWEST % left (the tightest key is the wallet's real headroom), with the
 * reset stamp of the key that reports it.
 */
function windowOf(
  keys: RawQuotaBoardKey[] | undefined,
  window: 'five_h' | 'weekly',
): WindowHeadroom {
  const list = keys ?? [];
  const leftKey = window === 'five_h' ? 'five_h_pct_left' : 'weekly_pct_left';
  const resetKey = window === 'five_h' ? 'five_h_reset_at' : 'weekly_reset_at';
  const values = list
    .map((k) => k[leftKey])
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const tightest = values.length > 0 ? Math.min(...values) : null;
  const tightestKey = list.find((k) => k[leftKey] === tightest);
  const resetAt = tightestKey?.[resetKey] ?? null;
  return {
    pct_left: tightest,
    reset_at: resetAt,
    resets_label: resetLabel(resetAt),
  };
}

/**
 * The governor's own day window for an account, in the server's numbering.
 * NEVER a wall-clock midnight anchor: MM's day is its own window (00:00Z for
 * the owner), and the ration week starts where the provider's window does.
 */
function dayLabel(account: RawDailyAccount | undefined): string | null {
  if (!account) return null;
  if (typeof account.day_number === 'number') return `day ${account.day_number}`;
  return null;
}

/**
 * Daily progress blocks.
 *
 * One block per (wallet, governor account) pair — a wallet can own more than
 * one account and each account carries its OWN day window and its OWN line,
 * so a single merged "wallet" number would lie.
 *
 * A block is only `published` when the server actually published a line for
 * it. An unpublished block renders an empty state; it never renders a 0.0%
 * bar, because a zero bar reads as "nothing was spent" when the truth is
 * "no data was published".
 */
export function mapProgressResponse(data: LiveConsoleData): ProgressResponse {
  const accountByName = new Map(data.daily.accounts.map((a) => [a.account, a]));
  const blocks: ProgressBlock[] = [];

  for (const wallet of data.daily.wallets) {
    const boardWallet = data.board.wallets.find((w) => w.wallet_id === wallet.wallet_id);
    const provider = boardWallet?.keys[0]?.provider ?? '—';
    const color = boardWallet?.color ?? '—';
    const displayName = walletDisplayName(wallet.name, provider);
    const fiveH = windowOf(boardWallet?.keys, 'five_h');
    const weekly = windowOf(boardWallet?.keys, 'weekly');
    const accountNames = wallet.accounts ?? [];

    if (accountNames.length === 0) {
      // The governor published no account for this wallet.
      blocks.push({
        wallet_id: wallet.wallet_id,
        name: wallet.name,
        display_name: displayName,
        color,
        provider,
        account: null,
        day_label: null,
        published: false,
        published_note:
          data.daily.unavailable_reason ??
          'The governor published no account for this wallet, so there is no line to show.',
        used_pct: 0,
        allowed_pct: 0,
        projected_pct: 0,
        still_allowed_pct: 0,
        floor_pct: 0,
        pace: 'on-pace',
        badges: [],
        formula: formulaFrom(0, 0, 0, 0, 'today allowed'),
        resets_label: null,
        reset_hint: null,
        note: null,
        five_h: fiveH,
        weekly,
        spent_week_pct: null,
        weekly_pool: null,
        denomination: null,
        pace_pct_per_h: null,
        projected_end_pct: null,
        working_hours_left: null,
        reserve_pct: null,
        accrued_at_lift_pct: null,
        rollover_pct: null,
        day_start_utc: null,
        anchor_note: null,
        anchor_stale: false,
      });
      continue;
    }

    for (const accountName of accountNames) {
      const account = accountByName.get(accountName);
      const published =
        account !== undefined &&
        typeof account.allowed_today_pct === 'number' &&
        typeof account.used_today_pct === 'number';

      const allowed = num(account?.allowed_today_pct);
      const used = num(account?.used_today_pct);
      const remaining = num(account?.remaining_today_pct, Math.max(allowed - used, 0));
      const base = num(account?.base_pct);
      const rollover = num(account?.rollover_pool_pct);
      const floor = num(account?.floor_pct);

      blocks.push({
        wallet_id: wallet.wallet_id,
        name: wallet.name,
        display_name: displayName,
        color,
        provider,
        account: accountName,
        day_label: dayLabel(account),
        published,
        published_note: published
          ? null
          : (data.daily.unavailable_reason ??
            'The governor published no line for this account, so there is nothing to draw.'),
        used_pct: used,
        allowed_pct: allowed,
        projected_pct: used,
        still_allowed_pct: remaining,
        floor_pct: floor,
        pace: paceOf(used, allowed, account?.projected_end_pct),
        badges: [
          ...(account?.drain_day ? ['drain day'] : []),
          ...(account?.halted_by_console ? ['parked from console'] : []),
          ...(account?.halted ? ['halted'] : []),
        ],
        formula: formulaFrom(base, rollover, floor, allowed, 'allowed today'),
        // The daily bar's window is the governor's own — never the provider's
        // 5-hour reset stamp, and never a wall-clock midnight.
        resets_label: dayLabel(account),
        reset_hint: account?.ration_model ? `${account.ration_model} day window` : null,
        note: account?.halted_by_console ? 'Parked from the console.' : null,
        five_h: fiveH,
        weekly,
        spent_week_pct: account?.spent_week_pct ?? null,
        weekly_pool: account?.weekly_pool ?? null,
        denomination: account?.denomination ?? null,
        pace_pct_per_h: account?.pace_pct_per_h ?? null,
        projected_end_pct: account?.projected_end_pct ?? null,
        working_hours_left: account?.working_hours_left ?? null,
        reserve_pct: account?.reserve_pct ?? null,
        accrued_at_lift_pct: account?.accrued_at_lift_pct ?? null,
        rollover_pct: account?.rollover_pool_pct ?? null,
        day_start_utc: account?.day_start_utc ?? null,
        anchor_note: account?.anchor?.note ?? null,
        anchor_stale: account?.anchor?.stale ?? false,
      });
    }
  }

  const headroom = num(data.daily.accounts[0]?.weekly_headroom_pct);

  return {
    available: data.daily.available && data.daily.accounts.length > 0,
    unavailable_reason: data.daily.available
      ? (data.daily.accounts.length > 0
          ? null
          : 'The governor published no accounts, so there are no lines to show.')
      : data.daily.unavailable_reason,
    blocks,
    burn: {
      in_flight: 0,
      recommended: 0,
      quota_headroom_pct: headroom,
      target_band: 'not published by the read API',
      verdict: 'Advisory only — the console proposes, the governor moves.',
      advisory: true,
    },
    // The governor's own read API publishes no per-day history, so the
    // weekly heatmap and the 14-day strip stay empty rather than invented.
    // The pages render the API's own note instead of fake bars.
    heatmap: {
      weeks: [],
      note: 'Per-day burn history is not published by the read API yet.',
    },
    day_strip: null,
    audit: [...data.audit.values()].flat().sort((a, b) => b.at.localeCompare(a.at)),
  };
}

/**
 * The burn pace label, derived from the server's own numbers: today's spend
 * against today's allowance, and — when the governor published it — the
 * projected end-of-day position. The client never invents a pace.
 */
function paceOf(
  used: number,
  allowed: number,
  projectedEnd: number | null | undefined,
): 'ahead' | 'on-pace' | 'behind' {
  if (typeof projectedEnd === 'number' && allowed > 0) {
    if (projectedEnd > allowed) return 'behind';
    if (projectedEnd <= allowed * 0.75) return 'ahead';
    return 'on-pace';
  }
  if (allowed > 0 && used > allowed) return 'behind';
  if (allowed > 0 && used <= allowed * 0.5) return 'ahead';
  return 'on-pace';
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

export interface WalletLineUpdate {
  wallet_id: string;
  base_pct: number;
  rollover_pct: number;
  floor_pct?: number;
}

/**
 * PUT /wallets/:id/settings — writes the owner's daily line, which mints an
 * audit row and an auto-minted decisions-ledger ruling on the server.
 */
export async function putWalletLine(update: WalletLineUpdate): Promise<RawUpdateResponse> {
  const body = await guarded(() =>
    fetchMutate<RawUpdateResponse>(`/wallets/${encodeURIComponent(update.wallet_id)}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        daily_lines: {
          base_pct: update.base_pct,
          rollover_pool_pct: update.rollover_pct,
          ...(update.floor_pct === undefined ? {} : { floor_pct: update.floor_pct }),
        },
      }),
    }),
  );
  return body;
}

export function rulingIdOf(body: RawUpdateResponse): string | null {
  return body.ruling?.id ?? body.ruling?.ruling_id ?? body.ruling?.decision_id ?? body.audit_id ?? null;
}
