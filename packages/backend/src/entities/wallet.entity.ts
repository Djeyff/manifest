import { Entity, Column, PrimaryColumn, Index } from 'typeorm';
import { timestampType, timestampDefault } from '../common/utils/postgres-sql';
import type { TenantProviderBudget } from './tenant-provider.entity';

/**
 * Wallets (RET-692-FU1): a wallet is a NAMED GROUP of provider keys
 * (e.g. MAIN = RCR + CCR keys). The wallet owns the owner-editable settings:
 * name, color tag, member keys — and the budget lines that govern it.
 *
 * The per-key `tenant_providers.budget` column from the original RET-692
 * build stays as the legacy fallback for keys that do not belong to a wallet;
 * a key that IS a wallet member is governed by its WALLET's budget.
 */
@Entity('wallets')
@Index(['tenant_id'])
export class Wallet {
  @PrimaryColumn('varchar')
  id!: string;

  @Column('varchar')
  tenant_id!: string;

  /** Owner-editable wallet name, e.g. "MAIN". */
  @Column('varchar')
  name!: string;

  /** Owner-editable color tag (a CSS token name or a hex color). */
  @Column('varchar', { default: 'indigo' })
  color!: string;

  /**
   * Budget lines for the WALLET (same shape as `tenant_providers.budget`).
   * Null = the wallet is ungoverned. Parsed by
   * routing/proxy/wallet-budget.ts parseWalletBudget().
   */
  @Column('jsonb', { nullable: true, default: null })
  budget?: TenantProviderBudget | null;

  @Column(timestampType(), { default: timestampDefault() })
  created_at!: string;

  @Column(timestampType(), { default: timestampDefault() })
  updated_at!: string;
}

/**
 * Membership: which provider keys belong to which wallet.
 *
 * A key belongs to AT MOST ONE wallet — the unique index on
 * `tenant_provider_id` is declared in the migration so the Requests page can
 * attribute a serving key to exactly one wallet chip.
 */
@Entity('wallet_members')
@Index(['wallet_id'])
export class WalletMember {
  @PrimaryColumn('varchar')
  wallet_id!: string;

  @PrimaryColumn('varchar')
  tenant_provider_id!: string;

  @Column('varchar')
  tenant_id!: string;

  @Column(timestampType(), { default: timestampDefault() })
  created_at!: string;
}
