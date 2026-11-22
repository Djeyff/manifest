import { Entity, Column, PrimaryColumn, Index } from 'typeorm';
import { timestampType, timestampDefault } from '../common/utils/postgres-sql';

/**
 * Wallet settings (RET-720): the owner-editable knobs of the wallet console
 * that live NEXT TO (not inside) the wallet row itself, so an audit trail can
 * be written without touching the money-surface row.
 *
 * Everything here is reversible: a settings row is a plain set of flags/lines
 * and the emergency rollback is the feature flag off (the console endpoints
 * then stop answering and the governor keeps its last published state).
 */
export interface WalletDailyLines {
  /** Owner line: % of the weekly pool allowed per ration day. */
  base_pct?: number;
  /** Rollover pool replayed from completed days (% of the weekly pool). */
  rollover_pool_pct?: number;
  /** Floor locked by the owner (% of the weekly pool, never spent below). */
  floor_pct?: number;
}

@Entity('wallet_settings')
export class WalletSettings {
  @PrimaryColumn('varchar')
  wallet_id!: string;

  @Column('varchar')
  tenant_id!: string;

  /**
   * Drain-day auto-lift toggle (default ON per D-2026-11-20-09): on the last
   * ration day the governor may lift the line to the remaining weekly pool.
   */
  @Column('boolean', { default: true })
  drain_day_enabled!: boolean;

  /** Wallet priority/order — lower runs first when wallets compete for a slot. */
  @Column('int', { default: 100 })
  priority!: number;

  /** Emergency park: the wallet is halted until the owner resumes it. */
  @Column('boolean', { default: false })
  parked!: boolean;

  /** Kill-switch to the fallback account while this wallet is parked. */
  @Column('boolean', { default: false })
  kill_switch_fallback!: boolean;

  /** Daily budget lines (base + rollover + floor). Null = governor defaults. */
  @Column('jsonb', { nullable: true, default: null })
  daily_lines?: WalletDailyLines | null;

  /**
   * Owner reserve for this wallet (% of the weekly pool kept back). Null =
   * the governor's own reserve (the ~4.28%/day accrual it publishes).
   */
  @Column('numeric', {
    nullable: true,
    default: null,
    transformer: {
      to: (value: number | null) => value,
      from: (value: string | null) => (value === null || value === undefined ? null : Number(value)),
    },
  })
  reserve_pct?: number | null;

  /**
   * Rollover on/off (D-2026-11-22-11): when off, the wallet's completed-day
   * surplus is NOT replayed into the next ration day.
   */
  @Column('boolean', { default: true })
  rollover_enabled!: boolean;

  /**
   * Cross-class pause rule (D-2026-11-22-11): when on, a pause of this
   * wallet also pauses the wallet class it belongs to (same provider line).
   */
  @Column('boolean', { default: false })
  cross_class_pause!: boolean;

  @Column('varchar', { nullable: true, default: null })
  updated_by_user_id!: string | null;

  @Column(timestampType(), { default: timestampDefault() })
  created_at!: string;

  @Column(timestampType(), { default: timestampDefault() })
  updated_at!: string;
}

/**
 * Audit row per settings change. Every row carries the decisions-ledger
 * ruling id that was minted for it — a UI action is doctrine (RET-719/720),
 * so the audit trail and the ledger never drift apart.
 */
@Entity('wallet_settings_audit')
@Index(['wallet_id'])
export class WalletSettingsAudit {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('varchar')
  wallet_id!: string;

  @Column('varchar')
  tenant_id!: string;

  @Column('varchar', { nullable: true, default: null })
  actor_user_id!: string | null;

  /** `settings.update` today; the column stays open for future action kinds. */
  @Column('varchar')
  action!: string;

  @Column('jsonb', { nullable: true, default: null })
  before!: Record<string, unknown> | null;

  @Column('jsonb', { nullable: true, default: null })
  after!: Record<string, unknown> | null;

  /** Decisions-ledger ruling id (D-YYYY-MM-DD-NN) minted for this change. */
  @Column('varchar', { nullable: true, default: null })
  ruling_id!: string | null;

  @Column(timestampType(), { default: timestampDefault() })
  created_at!: string;
}
