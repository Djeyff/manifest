import { Injectable } from '@nestjs/common';
import { readRationState, RationDecision, RationRollover, RationState } from './ration-state';
import { WalletConsoleService } from './wallet-console.service';

/**
 * Daily budget view (RET-720 scope c → D-2026-11-22-11).
 *
 * The line math is NOT re-implemented here: today's used-vs-allowed numbers
 * are read from the published RET-670-V3 governor state (base + rollover
 * pool, floor locked, drain-day lift). The console only reports what the
 * governor decided, plus the wallet's own settings, so the console can never
 * disagree with the governor about the line.
 *
 * The allowance-engine state (reserve, rollover accumulation, the reset-day
 * anchor and the projected end-of-day position) is derived HERE, on the
 * server, from the governor's own published numbers — the browser never does
 * budget arithmetic.
 *
 * A wallet parked from the console IS reflected here: `halted` becomes true
 * for the accounts its keys belong to — that is how a settings write lands in
 * the governor state on the next tick.
 */

/** The governor's own working day length (it publishes "over the ~18h working day"). */
export const WORKING_DAY_HOURS = 18;

export interface DailyBudgetAccount {
  account: string;
  keys: string[];
  /** % of the weekly pool allowed today (base + rollover pool). */
  allowed_today_pct: number | null;
  /** % of the weekly pool spent today. */
  used_today_pct: number | null;
  remaining_today_pct: number | null;
  base_pct: number | null;
  rollover_pool_pct: number | null;
  floor_pct: number | null;
  /** Owner reserve held back today (% of the weekly pool). */
  reserve_pct: number | null;
  /** Reserve accrued at the last day lift ((N-1) x 4.2857%/day). */
  accrued_at_lift_pct: number | null;
  /** Reserve locked by reservation holds. */
  reserved_pct: number | null;
  reservation_holds: number | null;
  /** Usable pool the governor publishes (allowed minus holds). */
  available_pct: number | null;
  weekly_headroom_pct: number | null;
  five_h_headroom_pct: number | null;
  /** % of the weekly pool already spent (provider-own). */
  spent_week_pct: number | null;
  /** Denomination of the pool (credits / tokens). */
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
  /** Set when a console setting (park) overrides the governor decision. */
  halted_by_console: boolean;
  /** Reset anchor of this wallet's own window (provider-own). */
  anchor: {
    epoch: number | null;
    source: string | null;
    stale: boolean;
    note: string | null;
  } | null;
  /** Epoch the current ration day started (the day-window anchor). */
  day_epoch: number | null;
  /** UTC "HH:MM" the ration day starts at. */
  day_start_utc: string | null;
  /** Hours elapsed inside the current ration day. */
  day_elapsed_hours: number | null;
  /** Current burn rate in % of the weekly pool per hour. */
  pace_pct_per_h: number | null;
  /** Projected spend at the end of the working day, at the current pace. */
  projected_end_pct: number | null;
  /** Working hours left in the day. */
  working_hours_left: number | null;
}

/** The allowance engine (rollover + membership) as the governor publishes it. */
export interface AllowanceEngine {
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

export interface DailyBudgetWallet {
  wallet_id: string;
  name: string;
  accounts: string[];
  parked: boolean;
  drain_day_enabled: boolean;
  /** The wallet's own configured lines (null = governor defaults). */
  daily_lines: Record<string, unknown> | null;
}

export interface DailyBudget {
  generated_at: string;
  available: boolean;
  unavailable_reason: string | null;
  ration_updated_at: string | null;
  accounts: DailyBudgetAccount[];
  wallets: DailyBudgetWallet[];
  /** Allowance-engine state (rollover / membership / anchors). */
  engine: AllowanceEngine | null;
}

function isoOrNull(epoch: number | null | undefined): string | null {
  if (typeof epoch !== 'number' || !Number.isFinite(epoch)) return null;
  return new Date(epoch * 1000).toISOString();
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

@Injectable()
export class BudgetDailyService {
  constructor(private readonly console: WalletConsoleService) {}

  async daily(tenantId: string, userId: string | null): Promise<DailyBudget> {
    await this.console.assertOwner(tenantId, userId);
    const ration = readRationState();
    const listed = await this.console.listWallets(tenantId, userId);

    const parkedAccounts = new Set<string>();
    const crossPausedAccounts = new Set<string>();
    /**
     * The owner's own rules, per ration account. The console is the only
     * place these live (wallet_settings), so the gateway applies them on top
     * of the governor's published numbers: an owner reserve overrides the
     * governor's reserve for the accounts of that wallet, and rollover off
     * drops the rollover pool for those accounts.
     */
    const ownerRules = new Map<
      string,
      { reserve_pct: number | null; rollover_enabled: boolean }
    >();
    const wallets: DailyBudgetWallet[] = [];
    /** Any wallet of this tenant parked → wallets with the cross-class rule on pause too. */
    const anyWalletParked = listed.some((entry) => entry.settings.parked);
    for (const entry of listed) {
      const accounts = new Set<string>();
      for (const member of entry.wallet.member_keys) {
        const account = ration.account_by_key[member.label];
        if (account) accounts.add(account);
      }
      if (entry.settings.parked) {
        for (const account of accounts) parkedAccounts.add(account);
      }
      for (const account of accounts) {
        if (ownerRules.has(account)) continue;
        ownerRules.set(account, {
          reserve_pct: entry.settings.reserve_pct ?? null,
          rollover_enabled: entry.settings.rollover_enabled !== false,
        });
      }
      // Cross-class pause rule: when another wallet of this tenant is parked,
      // this wallet's accounts pause as well.
      if (entry.settings.cross_class_pause && anyWalletParked && !entry.settings.parked) {
        for (const account of accounts) crossPausedAccounts.add(account);
      }
      wallets.push({
        wallet_id: entry.wallet.id,
        name: entry.wallet.name,
        accounts: [...accounts],
        parked: entry.settings.parked,
        drain_day_enabled: entry.settings.drain_day_enabled,
        daily_lines: (entry.settings.daily_lines ?? null) as Record<string, unknown> | null,
      });
    }

    const nowMs = Date.now();
    const accounts: DailyBudgetAccount[] = Object.entries(ration.accounts).map(
      ([name, status]) => {
        const decision: RationDecision = status.decision ?? {};
        const rules = ownerRules.get(name);
        const ownerReserve = rules?.reserve_pct ?? null;
        const rolloverOff = rules !== undefined && rules.rollover_enabled === false;
        const haltedByConsole = parkedAccounts.has(name) || crossPausedAccounts.has(name);
        const reasons = [...(decision.reasons ?? [])];
        if (ownerReserve !== null) reasons.push(`OWNER reserve ${ownerReserve}% of the weekly pool`);
        if (rolloverOff) reasons.push('OWNER rollover disabled for this wallet');
        if (crossPausedAccounts.has(name)) {
          reasons.push('OWNER cross-class pause: another wallet is parked');
        }

        const dayEpoch = ration.day_epoch ?? null;
        const elapsedHours =
          dayEpoch === null ? null : Math.max(0, (nowMs / 1000 - dayEpoch) / 3600);
        const used = num(decision.spent_today_pct ?? status.spent_today_pct);
        const workingHoursLeft =
          elapsedHours === null ? null : Math.max(0, WORKING_DAY_HOURS - elapsedHours);
        const pace =
          elapsedHours === null || elapsedHours <= 0 || used === null
            ? null
            : used / elapsedHours;
        const projected =
          pace === null || workingHoursLeft === null || used === null
            ? null
            : used + pace * workingHoursLeft;

        const anchor = decision.anchor ?? null;

        return {
          account: name,
          keys: status.acct_keys ?? [],
          allowed_today_pct: decision.usable_pct ?? decision.available_pct ?? null,
          used_today_pct: decision.spent_today_pct ?? status.spent_today_pct ?? null,
          remaining_today_pct: decision.remaining_today_pct ?? null,
          base_pct: decision.base_pct ?? null,
          rollover_pool_pct: rolloverOff ? 0 : (decision.rollover_pool_pct ?? null),
          floor_pct: decision.floor_pct ?? null,
          reserve_pct: ownerReserve ?? decision.reserve_pct ?? null,
          accrued_at_lift_pct: decision.accrued_at_lift_pct ?? null,
          reserved_pct: decision.reserved_pct ?? null,
          reservation_holds: decision.reservation_holds ?? null,
          available_pct: decision.available_pct ?? null,
          weekly_headroom_pct: decision.weekly_headroom_pct ?? null,
          five_h_headroom_pct: decision.five_h_headroom_pct ?? null,
          spent_week_pct: status.spent_week_pct ?? null,
          weekly_pool: status.weekly_pool ?? null,
          denomination: status.denomination ?? null,
          drain_day: decision.drain_day ?? false,
          drain_window: decision.drain_window ?? false,
          allow: haltedByConsole ? false : (decision.allow ?? false),
          halted: haltedByConsole ? true : (decision.halt ?? false),
          day_number: decision.day_number ?? null,
          day_index: decision.day_index ?? null,
          ration_model: decision.ration_model ?? null,
          release_stage: decision.release_stage ?? null,
          binding_dimension: decision.binding_dimension ?? null,
          capped_by_floor: decision.capped_by_floor ?? false,
          final_hour: decision.final_hour ?? false,
          reasons,
          halted_by_console: haltedByConsole,
          anchor: anchor
            ? {
                epoch: num(anchor.anchor_epoch),
                source: anchor.source ?? null,
                stale: anchor.stale ?? false,
                note: anchor.note ?? null,
              }
            : null,
          day_epoch: dayEpoch,
          day_start_utc: ration.day_start_utc,
          day_elapsed_hours: elapsedHours === null ? null : Number(elapsedHours.toFixed(3)),
          pace_pct_per_h: pace === null ? null : Number(pace.toFixed(4)),
          projected_end_pct: projected === null ? null : Number(projected.toFixed(3)),
          working_hours_left:
            workingHoursLeft === null ? null : Number(workingHoursLeft.toFixed(3)),
        };
      },
    );

    return {
      generated_at: new Date().toISOString(),
      available: ration.available,
      unavailable_reason: ration.unavailable_reason,
      ration_updated_at: ration.updated_at,
      accounts,
      wallets,
      engine: this.engine(ration),
    };
  }

  /** The allowance engine as published: rollover membership + the day anchors. */
  private engine(ration: RationState): AllowanceEngine | null {
    const rollover: RationRollover | null = ration.rollover;
    if (!ration.available) return null;
    return {
      rollover_enabled: rollover?.enabled ?? false,
      rollover_model: rollover?.model ?? null,
      rollover_mode: rollover?.mode ?? null,
      rollover_active: rollover?.active ?? null,
      rollover_reason: rollover?.reason ?? null,
      primary: rollover?.primary ?? null,
      primary_usable_pct: rollover?.primary_usable_pct ?? null,
      backup: rollover?.backup ?? null,
      backup_usable_pct: rollover?.backup_usable_pct ?? null,
      backup_membership_active: rollover?.backup_membership_active ?? false,
      backup_membership_end: rollover?.backup_membership_end ?? null,
      new_ration_day: rollover?.new_ration_day ?? false,
      week_start: isoOrNull(ration.week_start),
      day_start_utc: ration.day_start_utc,
      day_epoch: isoOrNull(ration.day_epoch),
      enforce_tick_at: ration.enforce_tick?.at ?? null,
    };
  }
}
