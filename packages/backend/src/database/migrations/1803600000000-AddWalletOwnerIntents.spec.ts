import { AddWalletOwnerIntents1803600000000 } from './1803600000000-AddWalletOwnerIntents';

/** A query runner that records every SQL string it is asked to run. */
async function run(direction: 'up' | 'down'): Promise<string[]> {
  const query = jest.fn(async (sql: string) => []);
  await new AddWalletOwnerIntents1803600000000()[direction]({ query } as never);
  return query.mock.calls.map(([sql]) => String(sql));
}

describe('AddWalletOwnerIntents1803600000000', () => {
  it('creates the contract table rerunnably (RET-776-A reads it by name)', async () => {
    const sql = await run('up');
    expect(sql).toHaveLength(3);
    const [table, index, check] = sql;
    // The column names are LITERAL — the governor's read is
    // SELECT account, action, actor, reason, created_at ... LIMIT 1.
    expect(table).toContain('CREATE TABLE IF NOT EXISTS "wallet_owner_intents"');
    expect(table).toContain('"account" text NOT NULL');
    expect(table).toContain('"action" text NOT NULL');
    expect(table).toContain('"actor" text NOT NULL');
    expect(table).toContain(`"reason" text NOT NULL DEFAULT ''`);
    expect(table).toContain('"created_at" timestamptz NOT NULL DEFAULT now()');
    expect(table).toContain('PRIMARY KEY ("account", "action", "actor", "reason", "created_at")');
    expect(index).toContain('CREATE INDEX IF NOT EXISTS "IDX_wallet_owner_intents_account"');
    expect(check).toContain(`CHECK ("action" IN ('pause', 'resume'))`);
    // Rerunnable: every statement is IF NOT EXISTS (the DO block guards the CHECK).
    for (const statement of sql) expect(statement).toMatch(/IF NOT EXISTS/);
  });

  it('keeps the action constrained to pause/resume', async () => {
    const sql = await run('up');
    expect(sql.some((s) => s.includes('CHK_wallet_owner_intents_action'))).toBe(true);
  });

  it('reverts cleanly by dropping the table', async () => {
    expect(await run('down')).toEqual([`DROP TABLE IF EXISTS "wallet_owner_intents"`]);
  });
});
