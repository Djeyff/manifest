import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Wallet, WalletMember } from '../../entities/wallet.entity';
import { TenantProvider, type TenantProviderBudget } from '../../entities/tenant-provider.entity';
import { parseWalletBudget } from '../proxy/wallet-budget';

export interface WalletMemberView {
  tenant_provider_id: string;
  label: string;
  provider: string;
}

export interface WalletView {
  id: string;
  name: string;
  color: string;
  budget: TenantProviderBudget | null;
  member_keys: WalletMemberView[];
  created_at: string;
  updated_at: string;
}

export interface CreateWalletInput {
  name: string;
  color?: string;
  budget?: Record<string, unknown> | null;
}

export interface UpdateWalletInput {
  name?: string;
  color?: string;
  budget?: Record<string, unknown> | null;
}

/**
 * Wallets as first-class, owner-editable entities (RET-692-FU1).
 *
 * A wallet is a NAMED GROUP of provider keys with owner-editable settings:
 * name, color tag, member keys, and the budget lines that govern the group.
 * A key belongs to at most ONE wallet (the unique index on
 * `wallet_members.tenant_provider_id`), so the Requests page can attribute a
 * serving key to exactly one wallet chip and the budget gate can attribute
 * spend to exactly one wallet.
 */
@Injectable()
export class WalletService {
  constructor(
    @InjectRepository(Wallet)
    private readonly walletRepo: Repository<Wallet>,
    @InjectRepository(WalletMember)
    private readonly memberRepo: Repository<WalletMember>,
    @InjectRepository(TenantProvider)
    private readonly tenantProviderRepo: Repository<TenantProvider>,
  ) {}

  async list(tenantId: string): Promise<WalletView[]> {
    const wallets = await this.walletRepo.find({
      where: { tenant_id: tenantId },
      order: { created_at: 'ASC' },
    });
    if (wallets.length === 0) return [];
    const members = await this.memberRepo.find({ where: { tenant_id: tenantId } });
    const keys = await this.tenantProviderRepo.find({
      where: { tenant_id: tenantId },
      select: ['id', 'label', 'provider'],
    });
    const keyById = new Map(keys.map((k) => [k.id, k]));
    const membersByWallet = new Map<string, WalletMember[]>();
    for (const member of members) {
      const list = membersByWallet.get(member.wallet_id) ?? [];
      list.push(member);
      membersByWallet.set(member.wallet_id, list);
    }
    return wallets.map((wallet) => this.toView(wallet, membersByWallet.get(wallet.id) ?? [], keyById));
  }

  async find(tenantId: string, id: string): Promise<WalletView> {
    const wallet = await this.findRow(tenantId, id);
    const members = await this.memberRepo.find({ where: { wallet_id: wallet.id, tenant_id: tenantId } });
    const keys = members.length
      ? await this.tenantProviderRepo.find({
          where: { tenant_id: tenantId },
          select: ['id', 'label', 'provider'],
        })
      : [];
    const keyById = new Map(keys.map((k) => [k.id, k]));
    return this.toView(wallet, members, keyById);
  }

  async create(tenantId: string, input: CreateWalletInput): Promise<WalletView> {
    const name = this.validateName(input.name);
    await this.assertNameAvailable(tenantId, name, null);
    const budget = this.validateBudget(input.budget);
    const now = new Date().toISOString();
    const row = Object.assign(new Wallet(), {
      id: randomUUID(),
      tenant_id: tenantId,
      name,
      color: input.color ?? 'indigo',
      budget,
      created_at: now,
      updated_at: now,
    });
    await this.walletRepo.insert(row);
    return this.toView(row, [], new Map());
  }

  async update(tenantId: string, id: string, patch: UpdateWalletInput): Promise<WalletView> {
    const row = await this.findRow(tenantId, id);
    if (patch.name !== undefined) {
      const name = this.validateName(patch.name);
      await this.assertNameAvailable(tenantId, name, row.id);
      row.name = name;
    }
    if (patch.color !== undefined) {
      row.color = patch.color;
    }
    if (patch.budget !== undefined) {
      row.budget = this.validateBudget(patch.budget);
    }
    row.updated_at = new Date().toISOString();
    await this.walletRepo.save(row);
    return this.find(tenantId, id);
  }

  /** Add a provider key to a wallet. A key belongs to at most one wallet. */
  async addMember(tenantId: string, walletId: string, tenantProviderId: string): Promise<WalletView> {
    const wallet = await this.findRow(tenantId, walletId);
    const key = await this.tenantProviderRepo.findOne({
      where: { id: tenantProviderId, tenant_id: tenantId },
    });
    if (!key) throw new NotFoundException('Provider key not found');
    // Moving the key is the owner intent: a key is governed by one wallet.
    await this.memberRepo.delete({ tenant_provider_id: tenantProviderId });
    const existing = await this.memberRepo.findOne({
      where: { wallet_id: wallet.id, tenant_provider_id: tenantProviderId },
    });
    if (!existing) {
      await this.memberRepo.insert(
        Object.assign(new WalletMember(), {
          wallet_id: wallet.id,
          tenant_provider_id: tenantProviderId,
          tenant_id: tenantId,
          created_at: new Date().toISOString(),
        }),
      );
    }
    await this.touch(wallet);
    return this.find(tenantId, walletId);
  }

  async removeMember(tenantId: string, walletId: string, tenantProviderId: string): Promise<WalletView> {
    const wallet = await this.findRow(tenantId, walletId);
    await this.memberRepo.delete({ wallet_id: wallet.id, tenant_provider_id: tenantProviderId });
    await this.touch(wallet);
    return this.find(tenantId, walletId);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const wallet = await this.findRow(tenantId, id);
    await this.memberRepo.delete({ wallet_id: wallet.id });
    await this.walletRepo.delete({ id: wallet.id });
  }

  private async touch(wallet: Wallet): Promise<void> {
    wallet.updated_at = new Date().toISOString();
    await this.walletRepo.save(wallet);
  }

  private async findRow(tenantId: string, id: string): Promise<Wallet> {
    const row = await this.walletRepo.findOne({ where: { id, tenant_id: tenantId } });
    if (!row) throw new NotFoundException('Wallet not found');
    return row;
  }

  private toView(
    wallet: Wallet,
    members: WalletMember[],
    keyById: Map<string, TenantProvider>,
  ): WalletView {
    return {
      id: wallet.id,
      name: wallet.name,
      color: wallet.color,
      budget: wallet.budget ?? null,
      member_keys: members
        .map((member) => {
          const key = keyById.get(member.tenant_provider_id);
          return {
            tenant_provider_id: member.tenant_provider_id,
            label: key?.label ?? 'Unknown',
            provider: key?.provider ?? 'unknown',
          };
        })
        .sort((a, b) => a.label.localeCompare(b.label)),
      created_at: wallet.created_at,
      updated_at: wallet.updated_at,
    };
  }

  private validateName(raw: string): string {
    const name = (raw ?? '').trim();
    if (!name) throw new BadRequestException('Wallet name is required');
    if (name.length > 32) throw new BadRequestException('Wallet name must be 32 characters or fewer');
    return name;
  }

  /** Budget lines are validated by the same parser the gate uses. */
  private validateBudget(raw: Record<string, unknown> | null | undefined): TenantProviderBudget | null {
    if (raw === null || raw === undefined) return null;
    const parsed = parseWalletBudget(raw);
    if (!parsed.config) {
      throw new BadRequestException(
        parsed.warnings[0] ?? 'Budget has no usable lines (daily_usd / weekly_usd / night_window)',
      );
    }
    return parsed.config as TenantProviderBudget;
  }

  private async assertNameAvailable(
    tenantId: string,
    name: string,
    exceptId: string | null,
  ): Promise<void> {
    const rows = await this.walletRepo.find({ where: { tenant_id: tenantId } });
    const clash = rows.some(
      (row) => row.id !== exceptId && row.name.toLowerCase() === name.toLowerCase(),
    );
    if (clash) throw new BadRequestException('A wallet with this name already exists');
  }
}
