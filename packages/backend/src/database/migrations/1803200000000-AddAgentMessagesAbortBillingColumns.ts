import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Abort-burn visibility for client-disconnected provider attempts
 * (D-2026-10-30-11).
 *
 * A client abort AFTER the upstream dispatch still costs money: the provider
 * bills the attempt even though no usage ever arrives. Those legs were
 * indistinguishable burn — `cancelled` rows with input_tokens=0. Two nullable
 * columns on agent_messages carry the distinction WITHOUT touching the
 * glossary contract that cancelled rows keep no error fields:
 * - abort_billed: attempt had been dispatched when the caller vanished;
 * - abort_est_tokens: est input tokens (ceil(serialized wire body chars / 4)).
 * NULL on every non-abort row; backfill is impossible (history has no
 * dispatch timing), so existing cancelled rows stay as they are.
 */
export class AddAgentMessagesAbortBillingColumns1803200000000 implements MigrationInterface {
  name = 'AddAgentMessagesAbortBillingColumns1803200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.withBoundedLockWait(queryRunner, async () => {
      await queryRunner.query(`
        ALTER TABLE "agent_messages"
          ADD COLUMN IF NOT EXISTS "abort_billed" boolean,
          ADD COLUMN IF NOT EXISTS "abort_est_tokens" integer
      `);
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.withBoundedLockWait(queryRunner, async () => {
      await queryRunner.query(`
        ALTER TABLE "agent_messages"
          DROP COLUMN IF EXISTS "abort_billed",
          DROP COLUMN IF EXISTS "abort_est_tokens"
      `);
    });
  }

  private async withBoundedLockWait(
    queryRunner: QueryRunner,
    change: () => Promise<void>,
  ): Promise<void> {
    if (queryRunner.isTransactionActive) {
      await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
      await change();
      return;
    }

    await queryRunner.query(`SET lock_timeout = '5s'`);
    try {
      await change();
    } finally {
      await queryRunner.query(`RESET lock_timeout`);
    }
  }
}
