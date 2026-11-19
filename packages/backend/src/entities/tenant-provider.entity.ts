import { Entity, Column, PrimaryColumn } from 'typeorm';
import type { AuthType } from 'manifest-shared';
import { timestampType, timestampDefault } from '../common/utils/postgres-sql';
import type { DiscoveredModel } from '../model-discovery/model-fetcher';

@Entity('tenant_providers')
export class TenantProvider {
  @PrimaryColumn('varchar')
  id!: string;

  @Column('varchar')
  tenant_id!: string;

  /** Audit-only: which user connected the provider. Never used for scoping. */
  @Column('varchar', { nullable: true, default: null })
  created_by_user_id!: string | null;

  @Column('varchar', { nullable: true, default: null })
  agent_id!: string | null;

  @Column('varchar')
  provider!: string;

  @Column('varchar', { nullable: true, default: null })
  api_key_encrypted!: string | null;

  @Column('varchar', { nullable: true, default: null })
  key_prefix!: string | null;

  @Column('varchar', { default: 'api_key' })
  auth_type!: AuthType;

  @Column('varchar', { default: 'Default' })
  label!: string;

  @Column('integer', { default: 0 })
  priority!: number;

  @Column('varchar', { nullable: true, default: null })
  region!: string | null;

  @Column('boolean', { default: true })
  is_active!: boolean;

  @Column(timestampType(), { default: timestampDefault() })
  connected_at!: string;

  @Column(timestampType(), { default: timestampDefault() })
  updated_at!: string;

  @Column('simple-json', { nullable: true, default: null })
  cached_models!: DiscoveredModel[] | null;

  @Column(timestampType(), { nullable: true, default: null })
  models_fetched_at!: string | null;

  /**
   * Wallet budget lines (RET-692): daily_usd, weekly_usd, week_anchor_utc,
   * night_window {start, end, offset_minutes}, allow[] — the shape parsed by
   * routing/proxy/wallet-budget.ts. Null = the wallet is ungoverned. Extra
   * keys are tolerated by the parser; only the fields below are typed.
   */
  @Column('jsonb', { nullable: true, default: null })
  budget?: TenantProviderBudget | null;
}

/** The jsonb document stored in `tenant_providers.budget` (RET-692). */
export interface TenantProviderBudget {
  daily_usd?: number | null;
  weekly_usd?: number | null;
  /** "HH:MM" UTC time anchoring the weekly pool reset (Monday-based). */
  week_anchor_utc?: string | null;
  night_window?: {
    start?: string | null;
    end?: string | null;
    offset_minutes?: number | null;
  } | null;
  /** Caller tier/agent names (+ "owner-answer") exempt from the night window. */
  allow?: string[] | null;
}
