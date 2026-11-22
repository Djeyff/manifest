import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wallet console rules (D-2026-11-22-11 / D-2026-11-22-13).
 *
 * Adds the owner-editable allowance rules the console writes:
 * - `reserve_pct`   — the wallet's own reserve (% of the weekly pool).
 * - `rollover_enabled` — whether completed-day surplus is replayed.
 * - `cross_class_pause` — whether a pause also pauses the wallet class.
 *
 * The key binding itself lives in the existing `wallet_members` table (one
 * row per wallet→key binding), so it needs no new column here: the console
 * edits those rows and writes the audit trail beside them.
 */
export class AddWalletConsoleRules1803500000000 implements MigrationInterface {
  name = 'AddWalletConsoleRules1803500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "wallet_settings" ADD COLUMN IF NOT EXISTS "reserve_pct" numeric`,
    );
    await queryRunner.query(
      `ALTER TABLE "wallet_settings" ADD COLUMN IF NOT EXISTS "rollover_enabled" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "wallet_settings" ADD COLUMN IF NOT EXISTS "cross_class_pause" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "wallet_settings" DROP COLUMN IF EXISTS "cross_class_pause"`);
    await queryRunner.query(`ALTER TABLE "wallet_settings" DROP COLUMN IF EXISTS "rollover_enabled"`);
    await queryRunner.query(`ALTER TABLE "wallet_settings" DROP COLUMN IF EXISTS "reserve_pct"`);
  }
}
