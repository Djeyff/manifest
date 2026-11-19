import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wallets as first-class entities (RET-692-FU1).
 *
 * - `wallets` — the named group of provider keys with owner-editable
 *   settings: `name`, `color` (the chip color shown on the Requests page)
 *   and `budget` (the wallet-level lines that govern every member key).
 * - `wallet_members` — which provider keys belong to which wallet. A key
 *   belongs to at most ONE wallet (unique index on tenant_provider_id), so a
 *   request maps to exactly one wallet chip.
 *
 * Additive and rerunnable: `up` uses IF NOT EXISTS, `down` drops the tables
 * it created. Existing per-key `tenant_providers.budget` rows keep working —
 * a key with no wallet membership falls back to its own budget line.
 */
export class CreateWallets1803300000000 implements MigrationInterface {
  name = 'CreateWallets1803300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "wallets" (
         "id" varchar PRIMARY KEY,
         "tenant_id" varchar NOT NULL,
         "name" varchar NOT NULL,
         "color" varchar NOT NULL DEFAULT 'indigo',
         "budget" jsonb DEFAULT NULL,
         "created_at" timestamptz NOT NULL DEFAULT now(),
         "updated_at" timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_wallets_tenant_id" ON "wallets" ("tenant_id")`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "wallet_members" (
         "wallet_id" varchar NOT NULL REFERENCES "wallets" ("id") ON DELETE CASCADE,
         "tenant_provider_id" varchar NOT NULL REFERENCES "tenant_providers" ("id") ON DELETE CASCADE,
         "tenant_id" varchar NOT NULL,
         "created_at" timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY ("wallet_id", "tenant_provider_id")
       )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_wallet_members_tenant_provider_id"
         ON "wallet_members" ("tenant_provider_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_wallet_members_wallet_id" ON "wallet_members" ("wallet_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "wallet_members"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "wallets"`);
  }
}
