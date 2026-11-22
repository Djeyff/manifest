import { QuotaBoardService } from './quota-board.service';
import { WalletConsoleService } from './wallet-console.service';

const TENANT = 'tenant-1';
const OWNER = 'user-1';

function fakeQuota(overrides: Record<string, unknown> = {}) {
  return {
    tick: jest.fn(async () => undefined),
    snapshot: jest.fn(() => ({
      labels: {
        RCR: {
          label: 'RCR',
          five_h_pct_left: 42,
          weekly_pct_left: 71,
          five_h_reset_at: '2026-11-21T20:00:00.000Z',
          weekly_reset_at: '2026-11-27T23:13:10.000Z',
          plan_level: 'max',
          subscription_status: 'active',
          seen_at: new Date().toISOString(),
          error: null,
        },
      },
      polled_at: new Date().toISOString(),
      polls: 3,
      poll_errors: 0,
      ...overrides,
    })),
  };
}

function fakeConsole(settings: Record<string, unknown> = {}) {
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
          parked: false,
          kill_switch_fallback: false,
          daily_lines: null,
          updated_at: '2026-11-21T00:00:00.000Z',
          updated_by_user_id: OWNER,
          ...settings,
        },
      },
    ]),
  } as unknown as WalletConsoleService;
}

describe('QuotaBoardService (RET-720)', () => {
  it('forces a fresh provider-own poll before serving numbers', async () => {
    const quota = fakeQuota();
    const service = new QuotaBoardService(quota as never, fakeConsole());
    const board = await service.board(TENANT, OWNER);
    expect(quota.tick).toHaveBeenCalledTimes(1);
    expect(board.wallets.length).toBe(1);
    expect(board.wallets[0].keys[0].five_h_pct_left).toBe(42);
    expect(board.wallets[0].keys[0].weekly_pct_left).toBe(71);
    expect(board.wallets[0].keys[0].seen_at).toBeTruthy();
    expect(board.wallets[0].keys[0].stale).toBe(false);
  });

  it('flags an old reading as stale instead of serving it as live', async () => {
    const staleAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const quota = fakeQuota({
      labels: {
        RCR: {
          label: 'RCR',
          five_h_pct_left: 42,
          weekly_pct_left: 71,
          five_h_reset_at: null,
          weekly_reset_at: null,
          plan_level: null,
          subscription_status: null,
          seen_at: staleAt,
          error: null,
        },
      },
    });
    const service = new QuotaBoardService(quota as never, fakeConsole());
    const board = await service.board(TENANT, OWNER);
    expect(board.wallets[0].keys[0].stale).toBe(true);
    expect(board.wallets[0].keys[0].seen_at).toBe(staleAt);
  });

  it('serves the last snapshot and marks the feed stale when the live poll fails', async () => {
    const quota = fakeQuota();
    quota.tick.mockRejectedValueOnce(new Error('monitor down'));
    const service = new QuotaBoardService(quota as never, fakeConsole());
    const board = await service.board(TENANT, OWNER);
    expect(board.stale_feed).toBe(true);
    expect(board.wallets.length).toBe(1);
  });

  it('marks a parked wallet halted', async () => {
    const quota = fakeQuota();
    const service = new QuotaBoardService(quota as never, fakeConsole({ parked: true }));
    const board = await service.board(TENANT, OWNER);
    expect(board.wallets[0].halted).toBe(true);
    expect(board.wallets[0].keys[0].halted).toBe(true);
  });
});
