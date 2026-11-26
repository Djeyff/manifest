import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ForbiddenException, BadRequestException, NotFoundException } from '@nestjs/common';
import { WalletConsoleService } from './wallet-console.service';
import { DecisionLedgerService } from './decision-ledger.service';
import { WalletSettings, WalletSettingsAudit } from '../../entities/wallet-settings.entity';
import { WalletOwnerIntent } from '../../entities/wallet-owner-intent.entity';
import { Wallet } from '../../entities/wallet.entity';

const TENANT = 'tenant-1';
const OWNER = 'user-1';
const OTHER = 'user-2';
const WALLET = 'wallet-1';

function walletRow(): Wallet {
  return Object.assign(new Wallet(), {
    id: WALLET,
    tenant_id: TENANT,
    name: 'MAIN',
    color: 'indigo',
    budget: null,
    created_at: '2026-11-21T00:00:00.000Z',
    updated_at: '2026-11-21T00:00:00.000Z',
  });
}

/** In-memory stand-in for the TypeORM repositories the service uses. */
function makeRepo<T extends object>(rows: T[] = []) {
  const state = { rows: [...rows] };
  const matches = (row: T, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => (row as Record<string, unknown>)[key] === value);
  const orderBy = (list: T[], order?: Record<string, string>): T[] =>
    order?.created_at === 'DESC'
      ? [...list].sort((a, b) =>
          String((b as Record<string, unknown>).created_at ?? '').localeCompare(
            String((a as Record<string, unknown>).created_at ?? ''),
          ),
        )
      : list;
  return {
    state,
    find: jest.fn(
      async (options?: { where?: Partial<T>; order?: Record<string, string>; take?: number }) => {
        const list = state.rows.filter((row) =>
          matches(row, (options?.where ?? {}) as Record<string, unknown>),
        );
        const ordered = orderBy(list, options?.order);
        return typeof options?.take === 'number' ? ordered.slice(0, options.take) : ordered;
      },
    ),
    findOne: jest.fn(async (options?: { where?: Partial<T>; order?: Record<string, string> }) => {
      const list = state.rows.filter((row) =>
        matches(row, (options?.where ?? {}) as Record<string, unknown>),
      );
      return orderBy(list, options?.order)[0] ?? null;
    }),
    save: jest.fn(async (row: T) => {
      const index = state.rows.findIndex(
        (r) =>
          (r as Record<string, unknown>).id === (row as Record<string, unknown>).id ||
          (r as Record<string, unknown>).wallet_id === (row as Record<string, unknown>).wallet_id,
      );
      if (index >= 0) state.rows[index] = row;
      else state.rows.push(row);
      return row;
    }),
    insert: jest.fn(async (row: T) => {
      state.rows.push(row);
      return row;
    }),
  };
}

function buildService(
  opts: {
    ledgerFile?: string;
    /** Member key labels of the wallet; empty list = nothing governed. */
    memberLabels?: string[];
    providerIsActive?: boolean;
    settingsParked?: boolean;
  } = {},
) {
  const labels = opts.memberLabels ?? ['RCR'];
  const tenantRepo = makeRepo<{ id: string; owner_user_id: string | null }>([
    { id: TENANT, owner_user_id: OWNER },
  ]);
  const walletRepo = makeRepo<Wallet>([walletRow()]);
  const memberRepo = makeRepo<{
    wallet_id: string;
    tenant_provider_id: string;
    tenant_id: string;
  }>(
    labels.map((label) => ({
      wallet_id: WALLET,
      tenant_provider_id: `tp-${label}`,
      tenant_id: TENANT,
    })),
  );
  const providerRepo = makeRepo<{
    id: string;
    label: string;
    provider: string;
    tenant_id: string;
    is_active: boolean;
  }>(
    labels.map((label) => ({
      id: `tp-${label}`,
      label,
      provider: label.startsWith('MM') ? 'minimax' : 'zai',
      tenant_id: TENANT,
      is_active: opts.providerIsActive ?? true,
    })),
  );
  const settingsRepo = makeRepo<WalletSettings>(
    opts.settingsParked
      ? [
          Object.assign(new WalletSettings(), {
            wallet_id: WALLET,
            tenant_id: TENANT,
            parked: true,
            created_at: '2026-11-21T00:00:00.000Z',
            updated_at: '2026-11-21T00:00:00.000Z',
          }),
        ]
      : [],
  );
  const auditRepo = makeRepo<WalletSettingsAudit>([]);
  const intentRepo = makeRepo<WalletOwnerIntent>([]);
  const ledger = new DecisionLedgerService(
    opts.ledgerFile ?? '/tmp/ret720-ledger-does-not-exist/x.jsonl',
  );
  const service = new WalletConsoleService(
    tenantRepo as never,
    walletRepo as never,
    memberRepo as never,
    providerRepo as never,
    settingsRepo as never,
    auditRepo as never,
    ledger,
    intentRepo as never,
  );
  return { service, tenantRepo, walletRepo, settingsRepo, auditRepo, intentRepo, ledger };
}

describe('WalletConsoleService (RET-720)', () => {
  it('rejects a non-owner caller on settings reads', async () => {
    const { service } = buildService();
    await expect(service.getSettings(TENANT, OTHER, WALLET)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects a caller with no tenant context', async () => {
    const { service } = buildService();
    await expect(service.getSettings('', OWNER, WALLET)).rejects.toThrow();
  });

  it('404s for a wallet of another tenant', async () => {
    const { service } = buildService();
    await expect(service.getSettings(TENANT, OWNER, 'wallet-nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns defaults for a wallet that was never tuned', async () => {
    const { service } = buildService();
    const settings = await service.getSettings(TENANT, OWNER, WALLET);
    expect(settings.drain_day_enabled).toBe(true);
    expect(settings.parked).toBe(false);
    expect(settings.priority).toBe(100);
    expect(settings.daily_lines).toBeNull();
  });

  it('writes an audit row and mints a decision ruling on every change', async () => {
    const { service, settingsRepo, auditRepo } = buildService();
    const result = await service.updateSettings(TENANT, OWNER, WALLET, {
      parked: true,
      priority: 10,
      daily_lines: { base_pct: 12, rollover_pool_pct: 1.5, floor_pct: 4 },
    });
    expect(result.changed).toBe(true);
    expect(result.settings.parked).toBe(true);
    expect(result.settings.priority).toBe(10);
    expect(result.ruling?.id).toMatch(/^D-\d{4}-\d{2}-\d{2}-\d{2}$/);
    expect(result.audit_id).toBeTruthy();
    expect(settingsRepo.save).toHaveBeenCalledTimes(1);
    expect(auditRepo.save).toHaveBeenCalledTimes(1);
    const auditRow = auditRepo.state.rows[0] as unknown as WalletSettingsAudit;
    expect(auditRow.ruling_id).toBe(result.ruling?.id);
    expect(auditRow.actor_user_id).toBe(OWNER);
  });

  it('is a no-op when the payload matches the current state (no audit, no ruling)', async () => {
    const { service, auditRepo } = buildService();
    await service.updateSettings(TENANT, OWNER, WALLET, { parked: true });
    const second = await service.updateSettings(TENANT, OWNER, WALLET, { parked: true });
    expect(second.changed).toBe(false);
    expect(second.ruling).toBeNull();
    expect(auditRepo.state.rows.length).toBe(1);
  });

  it('rejects out-of-range and wrong-typed inputs at the trust boundary', async () => {
    const { service } = buildService();
    await expect(
      service.updateSettings(TENANT, OWNER, WALLET, { priority: 5000 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.updateSettings(TENANT, OWNER, WALLET, { parked: 'yes' as never }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.updateSettings(TENANT, OWNER, WALLET, { daily_lines: { base_pct: 140 } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lists the tenant wallets with their member key labels and settings', async () => {
    const { service } = buildService();
    const wallets = await service.listWallets(TENANT, OWNER);
    expect(wallets.length).toBe(1);
    expect(wallets[0].wallet.name).toBe('MAIN');
    expect(wallets[0].wallet.member_keys[0].label).toBe('RCR');
    expect(wallets[0].settings.parked).toBe(false);
  });
});

/**
 * A published RET-670-V3 governor state, verbatim shape (same fixture as
 * budget-daily.service.spec.ts): key label RCR maps to account zai-max.
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
        },
      },
    },
  },
};

function writeRationFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ret776b-ration-'));
  const file = join(dir, 'ration.json');
  writeFileSync(file, JSON.stringify(RATION_STATE), 'utf8');
  return file;
}

describe('WalletConsoleService owner intent + state (RET-776-B)', () => {
  const previousRation = process.env.MANIFEST_RET670_RATION_FILE;

  afterEach(() => {
    if (previousRation === undefined) delete process.env.MANIFEST_RET670_RATION_FILE;
    else process.env.MANIFEST_RET670_RATION_FILE = previousRation;
  });

  function withRation(): void {
    process.env.MANIFEST_RET670_RATION_FILE = writeRationFile();
  }

  it("rejects anything but 'pause'/'resume' at the trust boundary", async () => {
    withRation();
    const { service } = buildService();
    await expect(
      service.setOwnerIntent(TENANT, OWNER, WALLET, { action: 'halt' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.setOwnerIntent(TENANT, OWNER, WALLET, { action: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a reason longer than 500 characters', async () => {
    withRation();
    const { service } = buildService();
    await expect(
      service.setOwnerIntent(TENANT, OWNER, WALLET, {
        action: 'pause',
        reason: 'x'.repeat(501),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a wallet with no governed account behind it', async () => {
    withRation();
    // A member key whose label is NOT in the governor state maps to no account.
    const { service } = buildService({ memberLabels: ['UNMAPPED'] });
    await expect(
      service.setOwnerIntent(TENANT, OWNER, WALLET, { action: 'pause' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-owner caller (403)', async () => {
    withRation();
    const { service } = buildService();
    await expect(
      service.setOwnerIntent(TENANT, OTHER, WALLET, { action: 'pause' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('writes the contract row literally + audit + ruling, and re-reads the state', async () => {
    withRation();
    const { service, intentRepo, auditRepo } = buildService();
    const result = await service.setOwnerIntent(TENANT, OWNER, WALLET, {
      action: 'pause',
      reason: '  hold the line  ',
    });
    expect(result.changed).toBe(true);
    expect(result.action).toBe('pause');
    expect(result.accounts).toEqual(['zai-max']);
    expect(result.ruling?.id).toMatch(/^D-\d{4}-\d{2}-\d{2}-\d{2}$/);
    expect(result.audit_id).toBeTruthy();
    expect(result.intent).toEqual({
      action: 'pause',
      actor: OWNER,
      reason: 'hold the line',
      at: expect.any(String),
    });
    expect(result.state.state).toBe('paused_by_owner');
    expect(intentRepo.state.rows).toHaveLength(1);
    // RET-776-A read contract — the column names are LITERAL:
    const row = intentRepo.state.rows[0] as unknown as WalletOwnerIntent;
    expect(row.account).toBe('zai-max');
    expect(row.action).toBe('pause');
    expect(row.actor).toBe(OWNER);
    expect(row.reason).toBe('hold the line');
    expect(typeof row.created_at).toBe('string');
    const auditRow = auditRepo.state.rows[0] as unknown as WalletSettingsAudit;
    expect(auditRow.action).toBe('intent.pause');
    expect(auditRow.ruling_id).toBe(result.ruling?.id);
  });

  it('repeating the same action is a no-op (no row, no audit, no ruling)', async () => {
    withRation();
    const { service, intentRepo, auditRepo } = buildService();
    await service.setOwnerIntent(TENANT, OWNER, WALLET, { action: 'pause' });
    const repeat = await service.setOwnerIntent(TENANT, OWNER, WALLET, { action: 'pause' });
    expect(repeat.changed).toBe(false);
    expect(repeat.ruling).toBeNull();
    expect(repeat.audit_id).toBeNull();
    expect(repeat.intent?.action).toBe('pause');
    expect(intentRepo.state.rows).toHaveLength(1);
    expect(auditRepo.state.rows).toHaveLength(1);
  });

  it('resume after pause records the newer intent and flips the state back', async () => {
    withRation();
    const { service, intentRepo } = buildService();
    await service.setOwnerIntent(TENANT, OWNER, WALLET, { action: 'pause' });
    const resume = await service.setOwnerIntent(TENANT, OWNER, WALLET, { action: 'resume' });
    expect(resume.changed).toBe(true);
    expect(resume.intent?.action).toBe('resume');
    expect(intentRepo.state.rows).toHaveLength(2);
    expect(resume.state.state).toBe('running');
    const state = await service.getWalletState(TENANT, OWNER, WALLET);
    expect(state.state).toBe('running');
    expect(state.last_intent?.action).toBe('resume');
  });

  it('reports running with keys_active when no intent exists', async () => {
    withRation();
    const { service } = buildService();
    const state = await service.getWalletState(TENANT, OWNER, WALLET);
    expect(state.state).toBe('running');
    expect(state.keys_active).toBe(true);
    expect(state.last_intent).toBeNull();
    // Numbers are the CONTROLLER's feed merge — the service serves nulls.
    expect(state.daily_left_pct).toBeNull();
    expect(state.weekly_left_pct).toBeNull();
    expect(state.numbers_stale).toBe(true);
  });

  it('paused_by_owner outranks governor parking', async () => {
    withRation();
    const { service } = buildService({ settingsParked: true });
    await service.setOwnerIntent(TENANT, OWNER, WALLET, { action: 'pause' });
    const state = await service.getWalletState(TENANT, OWNER, WALLET);
    expect(state.state).toBe('paused_by_owner');
  });

  it('reports parked_by_governor from the settings park (keys still active)', async () => {
    withRation();
    const { service } = buildService({ settingsParked: true });
    const state = await service.getWalletState(TENANT, OWNER, WALLET);
    expect(state.state).toBe('parked_by_governor');
    expect(state.keys_active).toBe(true);
  });

  it('reports parked_by_governor + keys_active:false when a bound key is inactive', async () => {
    withRation();
    const { service } = buildService({ providerIsActive: false });
    const state = await service.getWalletState(TENANT, OWNER, WALLET);
    expect(state.state).toBe('parked_by_governor');
    expect(state.keys_active).toBe(false);
  });
});
