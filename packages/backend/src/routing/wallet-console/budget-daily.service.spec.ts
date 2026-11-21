import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BudgetDailyService } from './budget-daily.service';
import { WalletConsoleService } from './wallet-console.service';

const TENANT = 'tenant-1';
const OWNER = 'user-1';

/**
 * A published RET-670-V3 governor state, verbatim shape. `usable_pct` is
 * deliberately NOT base+rollover here — the console must report the
 * governor's number as-is (no forked line math).
 */
const RATION_STATE = {
  updated_at: 1795286724.017969,
  last_status: {
    at: '2026-11-21T18:45:24Z',
    accounts: {
      'zai-max': {
        acct_keys: ['RCR', 'CCR'],
        denomination: 'credits',
        weekly_pool: 140000,
        spent_week_pct: 73.23,
        spent_today_pct: 4.0922,
        decision: {
          account: 'zai-max',
          allow: true,
          halt: false,
          usable_pct: 99.5,
          spent_today_pct: 4.0922,
          remaining_today_pct: 6.651842,
          base_pct: 10,
          rollover_pool_pct: 0.74409,
          floor_pct: 4,
          drain_day: false,
          drain_window: false,
          day_index: 0,
          day_number: 1,
          ration_model: 'owner-v3',
          weekly_headroom_pct: 85,
          five_h_headroom_pct: 19.8,
          reasons: ['OWNER line: base 10% + rollover 0.7441%'],
        },
      },
    },
  },
};

function writeRationFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ret720-ration-'));
  const file = join(dir, 'ration.json');
  writeFileSync(file, JSON.stringify(RATION_STATE), 'utf8');
  return file;
}

function fakeConsole(parked = false) {
  return {
    assertOwner: jest.fn(async () => undefined),
    listWallets: jest.fn(async () => [
      {
        wallet: {
          id: 'wallet-1',
          name: 'MAIN',
          color: 'indigo',
          member_keys: [{ tenant_provider_id: 'tp-1', label: 'RCR', provider: 'zai' }],
        },
        settings: {
          wallet_id: 'wallet-1',
          tenant_id: TENANT,
          drain_day_enabled: true,
          priority: 100,
          parked,
          kill_switch_fallback: false,
          daily_lines: null,
          updated_at: '2026-11-21T00:00:00.000Z',
          updated_by_user_id: OWNER,
        },
      },
    ]),
  } as unknown as WalletConsoleService;
}

describe('BudgetDailyService (RET-720)', () => {
  const previous = process.env.MANIFEST_RET670_RATION_FILE;

  afterEach(() => {
    if (previous === undefined) delete process.env.MANIFEST_RET670_RATION_FILE;
    else process.env.MANIFEST_RET670_RATION_FILE = previous;
  });

  it('reports the governor numbers as-is (no forked line math)', async () => {
    process.env.MANIFEST_RET670_RATION_FILE = writeRationFile();
    const service = new BudgetDailyService(fakeConsole());
    const daily = await service.daily(TENANT, OWNER);
    expect(daily.available).toBe(true);
    const account = daily.accounts.find((a) => a.account === 'zai-max');
    expect(account).toBeTruthy();
    // usable_pct from the governor wins — NOT recomputed from base+rollover.
    expect(account?.allowed_today_pct).toBe(99.5);
    expect(account?.used_today_pct).toBe(4.0922);
    expect(account?.remaining_today_pct).toBe(6.651842);
    expect(account?.base_pct).toBe(10);
    expect(account?.rollover_pool_pct).toBe(0.74409);
    expect(account?.floor_pct).toBe(4);
  });

  it('maps wallet member keys onto the ration accounts', async () => {
    process.env.MANIFEST_RET670_RATION_FILE = writeRationFile();
    const service = new BudgetDailyService(fakeConsole());
    const daily = await service.daily(TENANT, OWNER);
    expect(daily.wallets[0].accounts).toEqual(['zai-max']);
  });

  it('reflects a parked wallet in the governor state (halted on the next tick)', async () => {
    process.env.MANIFEST_RET670_RATION_FILE = writeRationFile();
    const service = new BudgetDailyService(fakeConsole(true));
    const daily = await service.daily(TENANT, OWNER);
    const account = daily.accounts.find((a) => a.account === 'zai-max');
    expect(account?.halted).toBe(true);
    expect(account?.halted_by_console).toBe(true);
    expect(account?.allow).toBe(false);
  });

  it('degrades to an unavailable state when the governor state is missing', async () => {
    process.env.MANIFEST_RET670_RATION_FILE = join(tmpdir(), 'ret720-missing-ration.json');
    const service = new BudgetDailyService(fakeConsole());
    const daily = await service.daily(TENANT, OWNER);
    expect(daily.available).toBe(false);
    expect(daily.unavailable_reason).toBeTruthy();
    expect(daily.accounts.length).toBe(0);
  });
});
