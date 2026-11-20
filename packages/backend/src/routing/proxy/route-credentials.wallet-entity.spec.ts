import {
  resolveRouteCredentials,
  type RouteCredentialDeps,
  type ResolvedRouteCredentials,
} from './route-credentials';
import {
  evaluateWalletBudget,
  parseWalletBudget,
  type ParsedWalletBudget,
  type WalletBudgetConfig,
  type WalletBudgetGate,
  type WalletBudgetMode,
  type WalletGateCallerContext,
  type WalletSpend,
  type WalletTarget,
} from './wallet-budget';
import { WalletBudgetService } from './wallet-budget.service';

type KeyRow = { id: string; label: string; apiKey: string | null; region?: string | null };

/** 14:00Z = 10:00 SDQ — daytime, outside the night window. */
const DAY = new Date('2026-11-19T14:00:00.000Z');

const GOVERNED: WalletBudgetConfig = {
  daily_usd: 12,
  weekly_usd: 60,
  night_window: { start: '00:30', end: '06:05', offset_minutes: -240 },
  allow: ['KaanAssistV2', 'owner-answer'],
};

const ungoverned = (): ParsedWalletBudget => ({ config: null, warnings: [] });
const governed = (config: WalletBudgetConfig = GOVERNED): ParsedWalletBudget => ({
  config,
  warnings: [],
});

/** A wallet: a named group of provider keys with its own budget line. */
type WalletRow = {
  wallet_id: string;
  name: string;
  color: string;
  /** raw wallet budget (jsonb) — null means the wallet has no usable line */
  budget: unknown;
  member_key_ids: string[];
};

/**
 * Wallet-aware fake of the gate: it mirrors the REAL service semantics —
 * a wallet with a usable budget governs its members and is charged the sum
 * over all member keys; a wallet without one leaves each key on its own
 * legacy per-key line.
 */
class WalletFakeGate implements WalletBudgetGate {
  readonly blockedNotes: string[] = [];
  readonly served: string[] = [];
  readonly wallets = new Map<string, WalletRow>();
  /** key id → wallet id */
  readonly keyWallet = new Map<string, string>();
  /** key id → raw legacy per-key budget */
  readonly keyBudgets = new Map<string, unknown>();
  /** key id → spend charged to that key */
  readonly keySpends = new Map<string, WalletSpend>();

  constructor(
    public keys: KeyRow[],
    public modeValue: WalletBudgetMode = 'enforce',
    public now: Date = DAY,
  ) {}

  mode(): WalletBudgetMode {
    return this.modeValue;
  }

  async listProviderKeys(): Promise<KeyRow[]> {
    return this.keys;
  }

  addWallet(wallet: WalletRow): void {
    this.wallets.set(wallet.wallet_id, wallet);
    for (const keyId of wallet.member_key_ids) this.keyWallet.set(keyId, wallet.wallet_id);
  }

  async walletTarget(tenantProviderId: string): Promise<WalletTarget | null> {
    const walletId = this.keyWallet.get(tenantProviderId);
    if (!walletId) return null;
    const wallet = this.wallets.get(walletId)!;
    return {
      wallet_id: wallet.wallet_id,
      name: wallet.name,
      color: wallet.color,
      member_key_ids: wallet.member_key_ids,
      governs: parseWalletBudget(wallet.budget).config !== null,
    };
  }

  async configFor(tenantProviderId: string): Promise<ParsedWalletBudget> {
    const target = await this.walletTarget(tenantProviderId);
    if (target?.governs) {
      const wallet = this.wallets.get(target.wallet_id)!;
      return parseWalletBudget(wallet.budget);
    }
    return parseWalletBudget(this.keyBudgets.get(tenantProviderId));
  }

  async decide(
    config: WalletBudgetConfig,
    tenantProviderId: string,
    caller: WalletGateCallerContext,
  ): Promise<{ spend: WalletSpend; decision: ReturnType<typeof evaluateWalletBudget> }> {
    const target = await this.walletTarget(tenantProviderId);
    let spend: WalletSpend;
    if (target?.governs) {
      // Wallet-wide aggregation: the sum over EVERY member key.
      spend = target.member_key_ids.reduce<WalletSpend>(
        (acc, keyId) => {
          const one = this.keySpends.get(keyId) ?? { day_usd: 0, week_usd: 0 };
          return {
            day_usd: acc.day_usd + one.day_usd,
            week_usd: acc.week_usd + one.week_usd,
          };
        },
        { day_usd: 0, week_usd: 0 },
      );
    } else {
      spend = this.keySpends.get(tenantProviderId) ?? { day_usd: 0, week_usd: 0 };
    }
    return { spend, decision: evaluateWalletBudget(config, spend, caller, this.now) };
  }

  noteBlocked(walletLabel: string): void {
    this.blockedNotes.push(walletLabel);
  }
}

function deps(gate: WalletFakeGate): RouteCredentialDeps {
  return {
    providerKeyService: {
      selectProviderKey: jest.fn(async () => gate.keys[0] ?? null),
      getProviderApiKey: jest.fn(async () => 'sk-reauth'),
    },
    oauth: {},
    walletBudget: gate,
  } as unknown as RouteCredentialDeps;
}

function args(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: 'agent-1',
    tenantId: 'tenant-1',
    provider: 'zai',
    authType: 'api_key',
    providerKeyLabel: 'main-key',
    walletCaller: { agentName: 'autonomous-sweeper' } satisfies WalletGateCallerContext,
    ...overrides,
  };
}

function expectServed(
  value: ResolvedRouteCredentials,
): Extract<ResolvedRouteCredentials, { ok: true }> {
  if (!value.ok) throw new Error(`expected admission, got ${value.reason}`);
  return value;
}

function expectBlocked(
  value: ResolvedRouteCredentials,
): Extract<ResolvedRouteCredentials, { ok: false }> {
  if (value.ok) throw new Error('expected a door rejection');
  return value;
}

const MAIN_A: KeyRow = { id: 'k1', label: 'main-key', apiKey: 'sk-main-a' };
const MAIN_B: KeyRow = { id: 'k2', label: 'main-key-2', apiKey: 'sk-main-b' };
const RESERVE: KeyRow = { id: 'k3', label: 'reserve-key', apiKey: 'sk-reserve' };
const LOOSE: KeyRow = { id: 'k4', label: 'loose-key', apiKey: 'sk-loose' };

describe('resolveRouteCredentials — WALLET-granularity budgets (RET-692-FU1)', () => {
  it('(a) a member key over its wallet line jumps to the NEXT wallet — the refused wallet is never served', async () => {
    const gate = new WalletFakeGate([MAIN_A, MAIN_B, RESERVE]);
    gate.addWallet({
      wallet_id: 'wal-main',
      name: 'MAIN',
      color: 'indigo',
      budget: { daily_usd: 12, weekly_usd: 60 },
      member_key_ids: ['k1', 'k2'],
    });
    gate.addWallet({
      wallet_id: 'wal-reserve',
      name: 'RESERVE',
      color: 'emerald',
      budget: { daily_usd: 50, weekly_usd: 200 },
      member_key_ids: ['k3'],
    });
    // The wallet is over its line (sum over BOTH member keys = 12).
    gate.keySpends.set('k1', { day_usd: 7, week_usd: 20 });
    gate.keySpends.set('k2', { day_usd: 5, week_usd: 10 });

    const result = expectServed(await resolveRouteCredentials(deps(gate), args() as never));

    // The next wallet serves — NOT the second member key of the refused MAIN.
    expect(result.keyLabel).toBe('reserve-key');
    expect(result.tenantProviderId).toBe('k3');
    expect(gate.blockedNotes).toEqual(['MAIN']);
  });

  it('(a2) the same wallet later in the chain is never served again', async () => {
    const gate = new WalletFakeGate([MAIN_A, MAIN_B, LOOSE]);
    gate.addWallet({
      wallet_id: 'wal-main',
      name: 'MAIN',
      color: 'indigo',
      budget: { daily_usd: 12, weekly_usd: 60 },
      member_key_ids: ['k1', 'k2'],
    });
    gate.addWallet({
      wallet_id: 'wal-loose',
      name: 'LOOSE',
      color: 'rose',
      budget: { daily_usd: 50, weekly_usd: 200 },
      member_key_ids: ['k4'],
    });
    gate.keySpends.set('k1', { day_usd: 12, week_usd: 20 });
    gate.keySpends.set('k2', { day_usd: 0, week_usd: 0 });

    const result = expectServed(await resolveRouteCredentials(deps(gate), args() as never));

    // LOOSE (k4) serves; neither MAIN member key is served.
    expect(result.keyLabel).toBe('loose-key');
    expect(result.tenantProviderId).toBe('k4');
    expect(gate.blockedNotes).toEqual(['MAIN']);
  });

  it('(b) every wallet over its line in enforce → M200 naming the WALLET, stamped with the refused key', async () => {
    const gate = new WalletFakeGate([MAIN_A, RESERVE]);
    gate.addWallet({
      wallet_id: 'wal-main',
      name: 'MAIN',
      color: 'indigo',
      budget: { daily_usd: 12, weekly_usd: 60 },
      member_key_ids: ['k1'],
    });
    gate.addWallet({
      wallet_id: 'wal-reserve',
      name: 'RESERVE',
      color: 'emerald',
      budget: { daily_usd: 5, weekly_usd: 60 },
      member_key_ids: ['k3'],
    });
    gate.keySpends.set('k1', { day_usd: 12, week_usd: 20 });
    gate.keySpends.set('k3', { day_usd: 5, week_usd: 20 });

    const blocked = expectBlocked(await resolveRouteCredentials(deps(gate), args() as never));

    expect(blocked.presentation?.code).toBe('M200');
    expect(blocked.reason).toBe('limit_exceeded');
    // The receipt names the WALLET, not the key label.
    expect(blocked.presentation?.message).toContain('MAIN wallet daily cap');
    expect(blocked.presentation?.message).not.toContain('main-key');
    // …and stays stamped with the refused key's tenant_provider_id.
    expect(blocked.presentation?.tenantProviderId).toBe('k1');
    expect(blocked.tenantProviderId).toBe('k1');
    expect(gate.blockedNotes).toEqual(['MAIN', 'RESERVE']);
  });

  it('(c) a wallet with no usable budget falls back to the key own per-key line', async () => {
    const gate = new WalletFakeGate([MAIN_A]);
    gate.addWallet({
      wallet_id: 'wal-main',
      name: 'MAIN',
      color: 'indigo',
      budget: null, // wallet has no line of its own
      member_key_ids: ['k1'],
    });
    // The legacy per-key line governs and it is UNDER the cap → serves.
    gate.keyBudgets.set('k1', { daily_usd: 12, weekly_usd: 60 });
    gate.keySpends.set('k1', { day_usd: 1, week_usd: 2 });

    const served = expectServed(await resolveRouteCredentials(deps(gate), args() as never));
    expect(served.keyLabel).toBe('main-key');

    // Over the per-key line → the key's own line rejects, and the receipt
    // still names the key (the wallet does not govern here).
    gate.keySpends.set('k1', { day_usd: 12, week_usd: 20 });
    const blocked = expectBlocked(await resolveRouteCredentials(deps(gate), args() as never));
    expect(blocked.presentation?.code).toBe('M200');
    expect(blocked.presentation?.message).toContain('main-key wallet daily cap');
  });

  it('(d) shadow mode still serves traffic even when every wallet is over its line', async () => {
    const gate = new WalletFakeGate([MAIN_A, RESERVE], 'shadow');
    gate.addWallet({
      wallet_id: 'wal-main',
      name: 'MAIN',
      color: 'indigo',
      budget: { daily_usd: 12, weekly_usd: 60 },
      member_key_ids: ['k1'],
    });
    gate.addWallet({
      wallet_id: 'wal-reserve',
      name: 'RESERVE',
      color: 'emerald',
      budget: { daily_usd: 5, weekly_usd: 60 },
      member_key_ids: ['k3'],
    });
    gate.keySpends.set('k1', { day_usd: 99, week_usd: 99 });
    gate.keySpends.set('k3', { day_usd: 99, week_usd: 99 });

    const result = expectServed(await resolveRouteCredentials(deps(gate), args() as never));

    expect(result.keyLabel).toBe('main-key');
    expect(gate.blockedNotes).toEqual(['MAIN', 'RESERVE']);
  });

  it('a key with no wallet at all keeps its legacy per-key line', async () => {
    const gate = new WalletFakeGate([LOOSE]);
    gate.keyBudgets.set('k4', { daily_usd: 12, weekly_usd: 60 });
    gate.keySpends.set('k4', { day_usd: 1, week_usd: 2 });

    const result = expectServed(await resolveRouteCredentials(deps(gate), args() as never));

    expect(result.keyLabel).toBe('loose-key');
    expect(gate.blockedNotes).toEqual([]);
  });
});

describe('WalletBudgetService — wallet-level spend aggregation', () => {
  /** Minimal DataSource double: answers the wallet lookup and the spend rollup. */
  function fakeDataSource(
    walletRows: unknown[],
    spendRows: unknown[],
  ): {
    query: jest.Mock;
  } {
    return {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('"wallet_members"')) return walletRows;
        if (sql.includes('"agent_messages"')) return spendRows;
        return [];
      }),
    };
  }

  it('(e) the spend query for a wallet member sums over ALL member key ids', async () => {
    const dataSource = fakeDataSource(
      [
        {
          wallet_id: 'wal-main',
          name: 'MAIN',
          color: 'indigo',
          budget: { daily_usd: 12, weekly_usd: 60 },
          member_key_ids: ['k1', 'k2', 'k7'],
        },
      ],
      [{ day_usd: '9.5', week_usd: '20' }],
    );
    const service = new WalletBudgetService(dataSource as never, {} as never);

    const result = await service.decide(
      { daily_usd: 12, weekly_usd: 60 },
      'k1',
      { agentName: 'autonomous-sweeper' },
      DAY,
    );

    const spendCall = dataSource.query.mock.calls.find((call) =>
      String(call[0]).includes('"agent_messages"'),
    );
    expect(spendCall).toBeDefined();
    const [sql, params] = spendCall as [string, unknown[]];
    expect(sql).toContain('"tenant_provider_id" = ANY($1)');
    // The scope covers the WHOLE member set, not just the paying key.
    expect(params[0]).toEqual(['k1', 'k2', 'k7']);
    expect(result.spend).toEqual({ day_usd: 9.5, week_usd: 20 });
    // 9.5 < 12 → admitted.
    expect(result.decision.allowed).toBe(true);
  });

  it('(e2) a key outside any wallet keeps the legacy per-key spend scope', async () => {
    const dataSource = fakeDataSource([], [{ day_usd: '30', week_usd: '30' }]);
    const service = new WalletBudgetService(dataSource as never, {} as never);

    await service.decide({ daily_usd: 12, weekly_usd: 60 }, 'k9', { agentName: 'a' }, DAY);

    const spendCall = dataSource.query.mock.calls.find((call) =>
      String(call[0]).includes('"agent_messages"'),
    );
    const params = (spendCall as [string, unknown[]])[1];
    expect(params[0]).toEqual(['k9']);
  });

  it('(e3) a wallet without a usable budget leaves the key on its own line', async () => {
    const dataSource = fakeDataSource(
      [
        {
          wallet_id: 'wal-main',
          name: 'MAIN',
          color: 'indigo',
          budget: null,
          member_key_ids: ['k1', 'k2'],
        },
      ],
      [{ day_usd: '1', week_usd: '1' }],
    );
    const service = new WalletBudgetService(dataSource as never, {} as never);

    const parsed = await service.configFor('k1');
    expect(parsed.config).toBeNull();

    await service.decide({ daily_usd: 12, weekly_usd: 60 }, 'k1', { agentName: 'a' }, DAY);

    const spendCall = dataSource.query.mock.calls.find((call) =>
      String(call[0]).includes('"agent_messages"'),
    );
    const params = (spendCall as [string, unknown[]])[1];
    // Per-key scope, not the wallet scope.
    expect(params[0]).toEqual(['k1']);
  });

  it('(e4) walletTarget exposes the wallet name, color and member set', async () => {
    const dataSource = fakeDataSource(
      [
        {
          wallet_id: 'wal-main',
          name: 'MAIN',
          color: 'indigo',
          budget: { daily_usd: 12 },
          member_key_ids: ['k1', 'k2'],
        },
      ],
      [],
    );
    const service = new WalletBudgetService(dataSource as never, {} as never);

    const target = await service.walletTarget('k1');

    expect(target).toEqual({
      wallet_id: 'wal-main',
      name: 'MAIN',
      color: 'indigo',
      member_key_ids: ['k1', 'k2'],
      governs: true,
    });
  });
});

describe('WalletBudgetService — RET-695 final-day drain wiring', () => {
  const drainDataSource = (spendRows: unknown[]) => ({
    query: jest.fn(async (sql: string) => {
      if (sql.includes('"wallet_members"')) return [];
      if (sql.includes('"agent_messages"')) return spendRows;
      return [];
    }),
  });

  const DRAIN_CONFIG = { daily_usd: 10, weekly_usd: 60, week_anchor_utc: '00:00' };
  /** Sunday 2026-11-22T23:00Z — 1h before the Monday 00:00Z reset (final day). */
  const DRAIN_DAY = new Date('2026-11-22T23:00:00.000Z');
  const ENV = 'MANIFEST_WALLET_FINAL_DAY_DRAIN';

  it('(d1) default ON: on the final day the drain opens the daily stop — day past the 10 line serves while the pool has room', async () => {
    delete process.env[ENV];
    const service = new WalletBudgetService(
      drainDataSource([{ day_usd: '15', week_usd: '30' }]) as never,
      {} as never,
    );

    const { decision } = await service.decide(DRAIN_CONFIG, 'k9', { agentName: 'a' }, DRAIN_DAY);

    expect(decision).toEqual({ allowed: true });
  });

  it('(d2) MANIFEST_WALLET_FINAL_DAY_DRAIN=0 kills the drain — the plain daily cap returns', async () => {
    const prev = process.env[ENV];
    process.env[ENV] = '0';
    try {
      const service = new WalletBudgetService(
        drainDataSource([{ day_usd: '15', week_usd: '30' }]) as never,
        {} as never,
      );

      const { decision } = await service.decide(DRAIN_CONFIG, 'k9', { agentName: 'a' }, DRAIN_DAY);

      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.rule).toBe('daily_cap');
        expect(decision.detail).toContain('daily line 10.00 USD');
        expect(decision.drain).toBeUndefined();
      }
    } finally {
      if (prev === undefined) delete process.env[ENV];
      else process.env[ENV] = prev;
    }
  });
});
