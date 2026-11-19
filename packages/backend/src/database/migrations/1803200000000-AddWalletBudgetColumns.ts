import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wallet budgets (RET-692): budgets live ON the wallet.
 *
 * - `tenant_providers.budget` (jsonb, null = ungoverned) carries the
 *   operator-set lines — daily_usd, weekly_usd, week_anchor_utc,
 *   night_window {start, end, offset_minutes}, allow[] — in the shape parsed
 *   by routing/proxy/wallet-budget.ts parseWalletBudget(). The gateway's
 *   admission gate reads it fresh per request, so editing the row changes
 *   behavior on the next request.
 * - `header_tiers.architect_answer_only` (boolean, default false) flags the
 *   tiers that may only spend while answering an owner message (the request
 *   carries an `x-manifest-trigger: owner-…` header).
 *
 * Both columns are additive with defaults, so `up` is rerunnable and `down`
 * reverts cleanly without touching any row data.
 */
export class AddWalletBudgetColumns1803200000000 implements MigrationInterface {
  name = 'AddWalletBudgetColumns1803200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tenant_providers" ADD COLUMN IF NOT EXISTS "budget" jsonb DEFAULT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "header_tiers" ADD COLUMN IF NOT EXISTS "architect_answer_only" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "header_tiers" DROP COLUMN IF EXISTS "architect_answer_only"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_providers" DROP COLUMN IF EXISTS "budget"`,
    );
  }
}
