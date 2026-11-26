import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RET-776-B: the owner wallet pause/resume INTENT table.
 *
 * CONTRACT with the control-room governor lane (RET-776-A): the column
 * names are literal and are read by name — account, action, actor, reason,
 * created_at. Do NOT rename a column and do NOT add a surrogate id: the
 * governor's read is `SELECT account, action, actor, reason, created_at
 * FROM wallet_owner_intents ... ORDER BY created_at DESC LIMIT 1`.
 *
 * Additive and reversible: `down` drops the table and nothing else in the
 * schema depends on it (a missing table = "no intent" for the governor).
 */
export class AddWalletOwnerIntents1803600000000 implements MigrationInterface {
  name = 'AddWalletOwnerIntents1803600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "wallet_owner_intents" (
        "account" text NOT NULL,
        "action" text NOT NULL,
        "actor" text NOT NULL,
        "reason" text NOT NULL DEFAULT '',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_wallet_owner_intents" PRIMARY KEY ("account", "action", "actor", "reason", "created_at")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_wallet_owner_intents_account" ON "wallet_owner_intents" ("account")`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'CHK_wallet_owner_intents_action'
        ) THEN
          ALTER TABLE "wallet_owner_intents"
            ADD CONSTRAINT "CHK_wallet_owner_intents_action"
            CHECK ("action" IN ('pause', 'resume'));
        END IF;
      END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "wallet_owner_intents"`);
  }
}
