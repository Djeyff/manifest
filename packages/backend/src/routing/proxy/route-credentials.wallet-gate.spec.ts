import { resolveRouteCredentials, type RouteCredentialDeps, type ResolvedRouteCredentials } from './route-credentials';
import {
  evaluateWalletBudget,
  type ParsedWalletBudget,
  type WalletBudgetConfig,
  type WalletBudgetGate,
  type WalletBudgetMode,
  type WalletGateCallerContext,
  type WalletSpend,
} from './wallet-budget';

type WalletRow = { id: string; label: string; apiKey: string | null; region?: string | null };

/** 14:00Z = 10:00 SDQ — daytime, outside the night window. */
const DAY = new Date('2026-11-19T14:00:00.000Z');
/** 06:00Z = 02:00 SDQ — inside the 00:30-06:05 night window. */
const NIGHT = new Date('2026-11-19T06:00:00.000Z');

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

const MAIN: WalletRow = { id: 'w1', label: 'main', apiKey: 'sk-main' };
const RESERVE: WalletRow = { id: 'w2', label: 'reserve', apiKey: 'sk-reserve' };

/**
 * Fake WalletBudgetGate backed by the REAL decision core, with a mutable
 * config map — the flip test mutates it between requests to prove budget
 * edits change behavior on the next request without any re-init.
 */
class FakeGate implements WalletBudgetGate {
  readonly blockedNotes: string[] = [];
  readonly reads: string[] = [];
  configs = new Map<string, ParsedWalletBudget>();
  spends = new Map<string, WalletSpend>();

  constructor(
    public keys: WalletRow[],
    public modeValue: WalletBudgetMode = 'enforce',
    public now: Date = DAY,
  ) {}

  mode(): WalletBudgetMode {
    return this.modeValue;
  }

  async listProviderKeys(): Promise<WalletRow[]> {
    return this.keys;
  }

  async configFor(tenantProviderId: string): Promise<ParsedWalletBudget> {
    this.reads.push(tenantProviderId);
    return this.configs.get(tenantProviderId) ?? ungoverned();
  }

  async decide(
    config: WalletBudgetConfig,
    tenantProviderId: string,
    caller: WalletGateCallerContext,
  ): Promise<{ spend: WalletSpend; decision: ReturnType<typeof evaluateWalletBudget> }> {
    // The fake is the injectable clock: prod passes wall-clock `now`
    // (selectServingKey line `const now = new Date()`), tests pin it.
    const spend = this.spends.get(tenantProviderId) ?? { day_usd: 0, week_usd: 0 };
    return { spend, decision: evaluateWalletBudget(config, spend, caller, this.now) };
  }

  noteBlocked(walletLabel: string): void {
    this.blockedNotes.push(walletLabel);
  }
}

function deps(gate: FakeGate): RouteCredentialDeps {
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
    providerKeyLabel: 'main',
    walletCaller: { agentName: 'autonomous-sweeper' } satisfies WalletGateCallerContext,
    ...overrides,
  };
}

function expectServed(value: ResolvedRouteCredentials): Extract<ResolvedRouteCredentials, { ok: true }> {
  if (!value.ok) throw new Error(`expected admission, got ${value.reason}`);
  return value;
}

function expectBlocked(value: ResolvedRouteCredentials): Extract<ResolvedRouteCredentials, { ok: false }> {
  if (value.ok) throw new Error('expected a door rejection');
  return value;
}

describe('resolveRouteCredentials — wallet budget gate (RET-692)', () => {
  it('mode off keeps the legacy single-selection path and never consults the gate', async () => {
    const gate = new FakeGate([MAIN], 'off');
    gate.configs.set(MAIN.id, governed());

    const result = expectServed(await resolveRouteCredentials(deps(gate), args() as never));

    expect(result.keyLabel).toBe('main');
    expect(result.tenantProviderId).toBe('w1');
    expect(gate.reads).toEqual([]);
    expect(gate.blockedNotes).toEqual([]);
  });

  it('enforce: the only wallet over its daily line rejects ANY request at the door with a receipt', async () => {
    const gate = new FakeGate([MAIN]);
    gate.configs.set(MAIN.id, governed());
    gate.spends.set(MAIN.id, { day_usd: 12, week_usd: 20 });
    const routeDeps = deps(gate);

    const blocked = expectBlocked(await resolveRouteCredentials(routeDeps, args() as never));

    expect(blocked.reason).toBe('limit_exceeded');
    expect(blocked.tenantProviderId).toBe('w1');
    expect(blocked.presentation?.code).toBe('M200');
    expect(blocked.presentation?.status).toBe(429);
    expect(blocked.presentation?.message).toContain('main wallet daily cap');
    expect(blocked.presentation?.message).toContain('12.00 USD');
    const parsedBody = JSON.parse(blocked.presentation?.errorBody ?? '{}') as {
      error?: { message?: string };
    };
    expect(parsedBody.error?.message).toContain('daily cap');
    // The gate is the door: legacy key selection never ran, no provider path.
    expect(gate.blockedNotes).toEqual(['main']);
    const legacySelect = routeDeps.providerKeyService.selectProviderKey as unknown as jest.Mock;
    expect(legacySelect).not.toHaveBeenCalled();
  });

  it('enforce: over-line pinned wallet jumps to the next wallet in the owner chain (auto-jump in the router)', async () => {
    const gate = new FakeGate([MAIN, RESERVE]);
    gate.configs.set(MAIN.id, governed());
    gate.spends.set(MAIN.id, { day_usd: 12, week_usd: 20 });
    gate.configs.set(RESERVE.id, ungoverned());

    const result = expectServed(await resolveRouteCredentials(deps(gate), args() as never));

    expect(result.keyLabel).toBe('reserve');
    expect(result.tenantProviderId).toBe('w2');
    expect(gate.blockedNotes).toEqual(['main']);
  });

  it('enforce: every wallet over → receipt names the FIRST blocked wallet, later blocks still logged', async () => {
    const gate = new FakeGate([MAIN, RESERVE]);
    gate.configs.set(MAIN.id, governed());
    gate.spends.set(MAIN.id, { day_usd: 12, week_usd: 20 });
    gate.configs.set(RESERVE.id, governed({ daily_usd: 0.5 }));
    gate.spends.set(RESERVE.id, { day_usd: 1, week_usd: 1 });

    const blocked = expectBlocked(await resolveRouteCredentials(deps(gate), args() as never));

    expect(blocked.presentation?.message).toContain('main wallet daily cap');
    expect(blocked.presentation?.tenantProviderId).toBe('w1');
    expect(gate.blockedNotes).toEqual(['main', 'reserve']);
  });

  it('shadow: over-budget wallets are counted but the chain still serves', async () => {
    const gate = new FakeGate([MAIN, RESERVE], 'shadow');
    gate.configs.set(MAIN.id, governed());
    gate.spends.set(MAIN.id, { day_usd: 12, week_usd: 20 });
    gate.configs.set(RESERVE.id, ungoverned());

    const result = expectServed(await resolveRouteCredentials(deps(gate), args() as never));

    expect(result.keyLabel).toBe('reserve');
    expect(gate.blockedNotes).toEqual(['main']);
  });

  it('shadow: a chain where nothing admits falls back to the top-priority wallet', async () => {
    const gate = new FakeGate([MAIN, RESERVE], 'shadow');
    gate.configs.set(MAIN.id, governed());
    gate.spends.set(MAIN.id, { day_usd: 99, week_usd: 99 });
    gate.configs.set(RESERVE.id, governed({ daily_usd: 0.5 }));
    gate.spends.set(RESERVE.id, { day_usd: 1, week_usd: 1 });

    const result = expectServed(await resolveRouteCredentials(deps(gate), args() as never));

    expect(result.keyLabel).toBe('main');
    expect(gate.blockedNotes).toEqual(['main', 'reserve']);
  });

  it('ungoverned wallet serves exactly as before, even in enforce', async () => {
    const gate = new FakeGate([MAIN]);
    gate.configs.set(MAIN.id, ungoverned());

    const result = expectServed(await resolveRouteCredentials(deps(gate), args() as never));

    expect(result.keyLabel).toBe('main');
    expect(gate.blockedNotes).toEqual([]);
    expect(gate.reads).toEqual(['w1']);
  });

  it('night window: non-allowlisted caller is rejected at the door with the window receipt', async () => {
    const gate = new FakeGate([MAIN], 'enforce', NIGHT);
    gate.configs.set(MAIN.id, governed());
    gate.spends.set(MAIN.id, { day_usd: 1, week_usd: 2 });

    const blocked = expectBlocked(await resolveRouteCredentials(deps(gate), args() as never));

    expect(blocked.reason).toBe('limit_exceeded');
    expect(blocked.presentation?.message).toContain('main wallet night window');
    expect(blocked.presentation?.message).toContain('00:30-06:05');
  });

  it('night window: allowlisted tier passes', async () => {
    const gate = new FakeGate([MAIN], 'enforce', NIGHT);
    gate.configs.set(MAIN.id, governed());
    gate.spends.set(MAIN.id, { day_usd: 1, week_usd: 2 });

    const result = expectServed(
      await resolveRouteCredentials(
        deps(gate),
        args({ walletCaller: { tierName: 'kaanassistv2' } }) as never,
      ),
    );

    expect(result.keyLabel).toBe('main');
  });

  it('night window: architect answering an owner message passes on the owner-answer trigger header', async () => {
    const gate = new FakeGate([MAIN], 'enforce', NIGHT);
    gate.configs.set(MAIN.id, governed());
    gate.spends.set(MAIN.id, { day_usd: 1, week_usd: 2 });

    const result = expectServed(
      await resolveRouteCredentials(
        deps(gate),
        args({
          walletCaller: {
            agentName: 'architect',
            triggerHeader: 'owner-1572776073345634304',
          },
        }) as never,
      ),
    );

    expect(result.keyLabel).toBe('main');
    expect(gate.blockedNotes).toEqual([]);
  });

  it('caps stay hard: an allowlisted caller over the daily line is still rejected', async () => {
    const gate = new FakeGate([MAIN], 'enforce', NIGHT);
    gate.configs.set(MAIN.id, governed());
    gate.spends.set(MAIN.id, { day_usd: 99, week_usd: 20 });

    const blocked = expectBlocked(
      await resolveRouteCredentials(
        deps(gate),
        args({ walletCaller: { tierName: 'KaanAssistV2' } }) as never,
      ),
    );

    expect(blocked.presentation?.message).toContain('main wallet daily cap');
  });

  it('flipping the budget field changes the decision on the NEXT request — no re-init', async () => {
    const gate = new FakeGate([MAIN]);
    gate.configs.set(MAIN.id, governed());
    gate.spends.set(MAIN.id, { day_usd: 12, week_usd: 20 });

    const first = await resolveRouteCredentials(deps(gate), args() as never);
    expect(first.ok).toBe(false);

    gate.configs.set(MAIN.id, governed({ ...GOVERNED, daily_usd: 500 }));

    const second = expectServed(await resolveRouteCredentials(deps(gate), args() as never));
    expect(second.keyLabel).toBe('main');
  });

  it('rows without an apiKey are skipped even when pinned', async () => {
    const gate = new FakeGate([
      { id: 'w0', label: 'disabled', apiKey: null },
      RESERVE,
    ]);
    gate.configs.set(RESERVE.id, governed({ daily_usd: 5 }));
    gate.spends.set(RESERVE.id, { day_usd: 1, week_usd: 1 });

    const result = expectServed(
      await resolveRouteCredentials(deps(gate), args({ providerKeyLabel: 'disabled' }) as never),
    );

    expect(result.keyLabel).toBe('reserve');
  });

  it('failover retargets the subscription pin to the wallet actually serving', async () => {
    const gate = new FakeGate([MAIN, RESERVE]);
    gate.configs.set(MAIN.id, governed());
    gate.spends.set(MAIN.id, { day_usd: 12, week_usd: 20 });
    gate.configs.set(RESERVE.id, governed({ daily_usd: 5 }));
    gate.spends.set(RESERVE.id, { day_usd: 1, week_usd: 1 });

    const result = expectServed(
      await resolveRouteCredentials(deps(gate), args({ authType: 'subscription' }) as never),
    );

    expect(result.keyLabel).toBe('reserve');
    expect(result.tenantProviderId).toBe('w2');
  });

  it('no wallets at all still resolves to the legacy no_provider_key failure', async () => {
    const gate = new FakeGate([]);

    const blocked = expectBlocked(await resolveRouteCredentials(deps(gate), args() as never));

    expect(blocked.reason).toBe('no_provider_key');
    expect(blocked.presentation).toBeUndefined();
  });
});
