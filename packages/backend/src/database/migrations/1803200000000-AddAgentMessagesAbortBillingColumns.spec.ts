import { AddAgentMessagesAbortBillingColumns1803200000000 } from './1803200000000-AddAgentMessagesAbortBillingColumns';

describe('AddAgentMessagesAbortBillingColumns1803200000000', () => {
  const migration = new AddAgentMessagesAbortBillingColumns1803200000000();
  const query = jest.fn().mockResolvedValue([]);
  const transactionalQueryRunner = { query, isTransactionActive: true } as never;
  const nonTransactionalQueryRunner = { query, isTransactionActive: false } as never;

  beforeEach(() => jest.clearAllMocks());

  it('adds the nullable abort-billing columns under a bounded lock wait', async () => {
    await migration.up(transactionalQueryRunner);

    const statements = query.mock.calls.map(([sql]) => sql);
    const sql = statements.join(' ');
    expect(statements[0]).toContain("SET LOCAL lock_timeout = '5s'");
    expect(sql).toContain('ALTER TABLE "agent_messages"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "abort_billed" boolean');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "abort_est_tokens" integer');
  });

  it('drops the columns on rollback and resets the lock timeout', async () => {
    await migration.down(nonTransactionalQueryRunner);

    const statements = query.mock.calls.map(([sql]) => sql);
    const sql = statements.join(' ');
    expect(statements[0]).toContain("SET lock_timeout = '5s'");
    expect(sql).toContain('DROP COLUMN IF EXISTS "abort_billed"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "abort_est_tokens"');
    expect(statements.at(-1)).toContain('RESET lock_timeout');
  });

  it('preserves the schema-change error without querying the aborted transaction', async () => {
    const failure = new Error('lock timeout');
    query
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => {
        throw failure;
      });

    await expect(migration.up(transactionalQueryRunner)).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
