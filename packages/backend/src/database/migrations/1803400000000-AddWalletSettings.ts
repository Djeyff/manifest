import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RET-720: wallet settings + settings audit trail.
 *
 * Both tables are additive and reversible: `down` drops them and nothing else
 * in the schema depends on them (the console endpoints degrade to "no
 * settings" when the rows are gone).
 */
export class AddWalletSettings1803400000000 implements MigrationInterface {
  name = 'AddWalletSettings1803400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "wallet_settings" (
        "wallet_id" varchar NOT NULL,
        "tenant_id" varchar NOT NULL,
        "drain_day_enabled" boolean NOT NULL DEFAULT true,
        "priority" integer NOT NULL DEFAULT 100,
        "parked" boolean NOT NULL DEFAULT false,
        "kill_switch_fallback" boolean NOT NULL DEFAULT false,
        "daily_lines" jsonb DEFAULT NULL,
        "updated_by_user_id" varchar DEFAULT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_wallet_settings" PRIMARY KEY ("wallet_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_wallet_settings_tenant" ON "wallet_settings" ("tenant_id")`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "wallet_settings_audit" (
        "id" uuid NOT NULL,
        "wallet_id" varchar NOT NULL,
        "tenant_id" varchar NOT NULL,
        "actor_user_id" varchar DEFAULT NULL,
        "action" varchar NOT NULL,
        "before" jsonb DEFAULT NULL,
        "after" jsonb DEFAULT NULL,
        "ruling_id" varchar DEFAULT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_wallet_settings_audit" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_wallet_settings_audit_wallet" ON "wallet_settings_audit" ("wallet_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_wallet_settings_audit_tenant" ON "wallet_settings_audit" ("tenant_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "wallet_settings_audit"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "wallet_settings"`);
  }
}
