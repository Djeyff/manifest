import { ForbiddenException, BadRequestException, NotFoundException } from '@nestjs/common';
import { WalletConsoleService } from './wallet-console.service';
import { DecisionLedgerService } from './decision-ledger.service';
import { WalletSettings, WalletSettingsAudit } from '../../entities/wallet-settings.entity';
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
  return {
    state,
    find: jest.fn(async (options?: { where?: Partial<T> }) => {
      const where = (options?.where ?? {}) as Record<string, unknown>;
      return state.rows.filter((row) =>
        Object.entries(where).every(([key, value]) => (row as Record<string, unknown>)[key] === value),
      );
    }),
    findOne: jest.fn(async (options?: { where?: Partial<T> }) => {
      const where = (options?.where ?? {}) as Record<string, unknown>;
      const found = state.rows.find((row) =>
        Object.entries(where).every(([key, value]) => (row as Record<string, unknown>)[key] === value),
      );
      return found ?? null;
    }),
    save: jest.fn(async (row: T) => {
      const index = state.rows.findIndex((r) => (r as Record<string, unknown>).id === (row as Record<string, unknown>).id
        || (r as Record<string, unknown>).wallet_id === (row as Record<string, unknown>).wallet_id);
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

function buildService(opts: { ledgerFile?: string } = {}) {
  const tenantRepo = makeRepo<{ id: string; owner_user_id: string | null }>([
    { id: TENANT, owner_user_id: OWNER },
  ]);
  const walletRepo = makeRepo<Wallet>([walletRow()]);
  const memberRepo = makeRepo<{ wallet_id: string; tenant_provider_id: string; tenant_id: string }>([
    { wallet_id: WALLET, tenant_provider_id: 'tp-1', tenant_id: TENANT },
  ]);
  const providerRepo = makeRepo<{ id: string; label: string; provider: string; tenant_id: string }>([
    { id: 'tp-1', label: 'RCR', provider: 'zai', tenant_id: TENANT },
  ]);
  const settingsRepo = makeRepo<WalletSettings>([]);
  const auditRepo = makeRepo<WalletSettingsAudit>([]);
  const ledger = new DecisionLedgerService(opts.ledgerFile ?? '/tmp/ret720-ledger-does-not-exist/x.jsonl');
  const service = new WalletConsoleService(
    tenantRepo as never,
    walletRepo as never,
    memberRepo as never,
    providerRepo as never,
    settingsRepo as never,
    auditRepo as never,
    ledger,
  );
  return { service, tenantRepo, walletRepo, settingsRepo, auditRepo, ledger };
}

describe('WalletConsoleService (RET-720)', () => {
  it('rejects a non-owner caller on settings reads', async () => {
    const { service } = buildService();
    await expect(service.getSettings(TENANT, OTHER, WALLET)).rejects.toBeInstanceOf(ForbiddenException);
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
