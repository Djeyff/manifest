import { AddWalletBudgetColumns1803200000000 } from './1803200000000-AddWalletBudgetColumns';

/** A query runner that records every SQL string it is asked to run. */
async function run(direction: 'up' | 'down'): Promise<string[]> {
  const query = jest.fn(async (sql: string) => []);
  await new AddWalletBudgetColumns1803200000000()[direction]({ query } as never);
  return query.mock.calls.map(([sql]) => String(sql));
}

describe('AddWalletBudgetColumns1803200000000', () => {
  it('adds the wallet budget lines and the tier flag, rerunnably', async () => {
    expect(await run('up')).toEqual([
      `ALTER TABLE "tenant_providers" ADD COLUMN IF NOT EXISTS "budget" jsonb DEFAULT NULL`,
      `ALTER TABLE "header_tiers" ADD COLUMN IF NOT EXISTS "architect_answer_only" boolean NOT NULL DEFAULT false`,
    ]);
  });

  it('reverts cleanly in the opposite order', async () => {
    expect(await run('down')).toEqual([
      `ALTER TABLE "header_tiers" DROP COLUMN IF EXISTS "architect_answer_only"`,
      `ALTER TABLE "tenant_providers" DROP COLUMN IF EXISTS "budget"`,
    ]);
  });
});
