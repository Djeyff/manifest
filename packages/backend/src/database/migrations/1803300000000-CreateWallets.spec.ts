import { CreateWallets1803300000000 } from './1803300000000-CreateWallets';

/** A query runner that records every SQL string it is asked to run. */
async function run(direction: 'up' | 'down'): Promise<string[]> {
  const query = jest.fn(async (sql: string) => []);
  await new CreateWallets1803300000000()[direction]({ query } as never);
  return query.mock.calls.map(([sql]) => String(sql));
}

describe('CreateWallets1803300000000', () => {
  it('creates the wallets and wallet_members tables rerunnably', async () => {
    const sql = await run('up');
    expect(sql).toEqual([
      `CREATE TABLE IF NOT EXISTS "wallets" (
         "id" varchar PRIMARY KEY,
         "tenant_id" varchar NOT NULL,
         "name" varchar NOT NULL,
         "color" varchar NOT NULL DEFAULT 'indigo',
         "budget" jsonb DEFAULT NULL,
         "created_at" timestamptz NOT NULL DEFAULT now(),
         "updated_at" timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS "IDX_wallets_tenant_id" ON "wallets" ("tenant_id")`,
      `CREATE TABLE IF NOT EXISTS "wallet_members" (
         "wallet_id" varchar NOT NULL REFERENCES "wallets" ("id") ON DELETE CASCADE,
         "tenant_provider_id" varchar NOT NULL REFERENCES "tenant_providers" ("id") ON DELETE CASCADE,
         "tenant_id" varchar NOT NULL,
         "created_at" timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY ("wallet_id", "tenant_provider_id")
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_wallet_members_tenant_provider_id"
         ON "wallet_members" ("tenant_provider_id")`,
      `CREATE INDEX IF NOT EXISTS "IDX_wallet_members_wallet_id" ON "wallet_members" ("wallet_id")`,
    ]);
    // Rerunnable: every statement is IF NOT EXISTS.
    for (const statement of sql) expect(statement).toMatch(/IF NOT EXISTS/);
  });

  it('keeps a key in AT MOST ONE wallet (unique index on tenant_provider_id)', async () => {
    const sql = await run('up');
    expect(
      sql.some(
        (s) =>
          s.includes('CREATE UNIQUE INDEX') && s.includes('"wallet_members" ("tenant_provider_id")'),
      ),
    ).toBe(true);
  });

  it('reverts cleanly, members first', async () => {
    expect(await run('down')).toEqual([
      `DROP TABLE IF EXISTS "wallet_members"`,
      `DROP TABLE IF EXISTS "wallets"`,
    ]);
  });
});
