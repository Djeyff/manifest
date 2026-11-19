import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { Wallet, WalletMember } from '../../entities/wallet.entity';
import { TenantProvider } from '../../entities/tenant-provider.entity';

/**
 * In-memory stand-ins for the three TypeORM repositories the service uses.
 * Only the handful of methods the service actually calls are implemented.
 */
function fakeRepo<T extends object>() {
  const rows: T[] = [];
  return {
    rows,
    find: jest.fn(async ({ where }: { where?: Partial<T> } = {}) => {
      return rows.filter((row) =>
        Object.entries(where ?? {}).every(
          ([key, value]) => (row as Record<string, unknown>)[key] === value,
        ),
      );
    }),
    findOne: jest.fn(async ({ where }: { where?: Partial<T> } = {}) => {
      return (
        rows.find((row) =>
          Object.entries(where ?? {}).every(
            ([key, value]) => (row as Record<string, unknown>)[key] === value,
          ),
        ) ?? null
      );
    }),
    insert: jest.fn(async (row: T) => {
      rows.push(row);
      return row;
    }),
    save: jest.fn(async (row: T) => {
      const idx = rows.findIndex((r) => (r as Record<string, unknown>).id === (row as Record<string, unknown>).id);
      if (idx >= 0) rows[idx] = row;
      else rows.push(row);
      return row;
    }),
    // TypeORM accepts either FindOptions ({ where }) or a bare where object.
    delete: jest.fn(async (opts: Record<string, unknown> = {}) => {
      const where = (('where' in opts ? opts.where : opts) ?? {}) as Partial<T>;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i] as Record<string, unknown>;
        const match = Object.entries(where).every(([k, v]) => row[k] === v);
        if (match) rows.splice(i, 1);
      }
      return { affected: 1 };
    }),
  };
}

function makeService() {
  const walletRepo = fakeRepo<Wallet>();
  const memberRepo = fakeRepo<WalletMember>();
  const keyRepo = fakeRepo<TenantProvider>();
  const service = new WalletService(
    walletRepo as never,
    memberRepo as never,
    keyRepo as never,
  );
  return { service, walletRepo, memberRepo, keyRepo };
}

const KEY_A = { id: 'tp-a', tenant_id: 't1', label: 'RCR', provider: 'zai' } as TenantProvider;
const KEY_B = { id: 'tp-b', tenant_id: 't1', label: 'CCR', provider: 'zai' } as TenantProvider;

describe('WalletService (RET-692-FU1)', () => {
  it('creates a wallet with a default color and no members', async () => {
    const { service } = makeService();
    const wallet = await service.create('t1', { name: 'MAIN' });
    expect(wallet.name).toBe('MAIN');
    expect(wallet.color).toBe('indigo');
    expect(wallet.member_keys).toEqual([]);
  });

  it('creates a wallet with an owner-chosen color', async () => {
    const { service } = makeService();
    const wallet = await service.create('t1', { name: 'RESERVE', color: 'amber' });
    expect(wallet.color).toBe('amber');
  });

  it('rejects a blank name and a duplicate name (case-insensitive)', async () => {
    const { service } = makeService();
    await service.create('t1', { name: 'MAIN' });
    await expect(service.create('t1', { name: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create('t1', { name: 'main' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('renames a wallet and sets its color', async () => {
    const { service } = makeService();
    const created = await service.create('t1', { name: 'MAIN' });
    const updated = await service.update('t1', created.id, { name: 'PRIMARY', color: 'teal' });
    expect(updated.name).toBe('PRIMARY');
    expect(updated.color).toBe('teal');
  });

  it('adds and removes member keys', async () => {
    const { service, keyRepo } = makeService();
    keyRepo.rows.push(KEY_A, KEY_B);
    const wallet = await service.create('t1', { name: 'MAIN' });
    await service.addMember('t1', wallet.id, 'tp-a');
    await service.addMember('t1', wallet.id, 'tp-b');
    const withMembers = await service.find('t1', wallet.id);
    // Member keys are returned sorted by label (CCR before RCR).
    expect(withMembers.member_keys.map((m) => m.tenant_provider_id)).toEqual(['tp-b', 'tp-a']);
    expect(withMembers.member_keys.map((m) => m.label)).toEqual(['CCR', 'RCR']);

    const afterRemove = await service.removeMember('t1', wallet.id, 'tp-a');
    expect(afterRemove.member_keys.map((m) => m.tenant_provider_id)).toEqual(['tp-b']);
  });

  it('moving a key to another wallet leaves it in exactly one wallet', async () => {
    const { service, keyRepo, memberRepo } = makeService();
    keyRepo.rows.push(KEY_A);
    const main = await service.create('t1', { name: 'MAIN' });
    const reserve = await service.create('t1', { name: 'RESERVE' });
    await service.addMember('t1', main.id, 'tp-a');
    await service.addMember('t1', reserve.id, 'tp-a');
    const memberships = memberRepo.rows.filter((m) => m.tenant_provider_id === 'tp-a');
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.wallet_id).toBe(reserve.id);
  });

  it('refuses a member key from another tenant', async () => {
    const { service, keyRepo } = makeService();
    keyRepo.rows.push({ id: 'tp-x', tenant_id: 'other', label: 'X', provider: 'zai' } as TenantProvider);
    const wallet = await service.create('t1', { name: 'MAIN' });
    await expect(service.addMember('t1', wallet.id, 'tp-x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('scopes every read to the caller tenant', async () => {
    const { service } = makeService();
    await service.create('t1', { name: 'MAIN' });
    await service.create('t2', { name: 'OTHER' });
    const mine = await service.list('t1');
    expect(mine.map((w) => w.name)).toEqual(['MAIN']);
    await expect(service.find('t1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('stores the wallet budget lines and rejects an unusable budget', async () => {
    const { service } = makeService();
    const wallet = await service.create('t1', {
      name: 'MAIN',
      budget: { daily_usd: 12, weekly_usd: 60 },
    });
    expect(wallet.budget).toEqual(expect.objectContaining({ daily_usd: 12, weekly_usd: 60 }));
    await expect(service.create('t1', { name: 'BAD', budget: {} })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('deletes a wallet together with its memberships', async () => {
    const { service, keyRepo, memberRepo } = makeService();
    keyRepo.rows.push(KEY_A);
    const wallet = await service.create('t1', { name: 'MAIN' });
    await service.addMember('t1', wallet.id, 'tp-a');
    await service.remove('t1', wallet.id);
    expect(memberRepo.rows).toHaveLength(0);
    expect(await service.list('t1')).toEqual([]);
  });
});
