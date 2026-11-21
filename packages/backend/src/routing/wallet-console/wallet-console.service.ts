import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Tenant } from '../../entities/tenant.entity';
import { Wallet, WalletMember } from '../../entities/wallet.entity';
import {
  WalletDailyLines,
  WalletSettings,
  WalletSettingsAudit,
} from '../../entities/wallet-settings.entity';
import { TenantProvider } from '../../entities/tenant-provider.entity';
import { DecisionLedgerService, MintedRuling } from './decision-ledger.service';

/**
 * Wallet settings service (RET-720 scope a).
 *
 * Owner-only surface: every read and write asserts that the authenticated
 * user owns the tenant (`tenants.owner_user_id`). The console is an
 * internal owner surface — no tenant member may steer a money line.
 *
 * Every change writes an audit row AND auto-mints a decisions-ledger ruling
 * (RET-719 doctrine: a UI action is doctrine, zero drift).
 */
export interface WalletSettingsView {
  wallet_id: string;
  tenant_id: string;
  drain_day_enabled: boolean;
  priority: number;
  parked: boolean;
  kill_switch_fallback: boolean;
  daily_lines: WalletDailyLines | null;
  updated_at: string;
  updated_by_user_id: string | null;
}

export interface UpdateWalletSettingsInput {
  drain_day_enabled?: boolean;
  priority?: number;
  parked?: boolean;
  kill_switch_fallback?: boolean;
  daily_lines?: WalletDailyLines | null;
}

export interface WalletSettingsUpdateResult {
  settings: WalletSettingsView;
  /** False when the payload matched the current state (no audit row, no ruling). */
  changed: boolean;
  audit_id: string | null;
  ruling: MintedRuling | null;
}

const PRIORITY_MIN = 0;
const PRIORITY_MAX = 1000;

@Injectable()
export class WalletConsoleService {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(Wallet)
    private readonly walletRepo: Repository<Wallet>,
    @InjectRepository(WalletMember)
    private readonly memberRepo: Repository<WalletMember>,
    @InjectRepository(TenantProvider)
    private readonly providerRepo: Repository<TenantProvider>,
    @InjectRepository(WalletSettings)
    private readonly settingsRepo: Repository<WalletSettings>,
    @InjectRepository(WalletSettingsAudit)
    private readonly auditRepo: Repository<WalletSettingsAudit>,
    private readonly ledger: DecisionLedgerService,
  ) {}

  /** Current settings for a wallet (defaults when the wallet was never tuned). */
  async getSettings(tenantId: string, userId: string | null, walletId: string): Promise<WalletSettingsView> {
    await this.assertOwner(tenantId, userId);
    const wallet = await this.findWallet(tenantId, walletId);
    const row = await this.settingsRepo.findOne({ where: { wallet_id: wallet.id } });
    return this.toView(wallet.id, tenantId, row);
  }

  /** Apply a settings change: validate → persist → audit → mint ruling. */
  async updateSettings(
    tenantId: string,
    userId: string | null,
    walletId: string,
    input: UpdateWalletSettingsInput,
  ): Promise<WalletSettingsUpdateResult> {
    await this.assertOwner(tenantId, userId);
    const wallet = await this.findWallet(tenantId, walletId);
    const existing = await this.settingsRepo.findOne({ where: { wallet_id: wallet.id } });
    const before = this.toView(wallet.id, tenantId, existing);
    const patch = this.validatePatch(input);
    const now = new Date().toISOString();

    const after: WalletSettingsView = {
      ...before,
      ...patch,
      updated_at: now,
      updated_by_user_id: userId,
    };
    if (!this.differs(before, after)) {
      return { settings: before, changed: false, audit_id: null, ruling: null };
    }

    const row = Object.assign(new WalletSettings(), {
      wallet_id: wallet.id,
      tenant_id: tenantId,
      drain_day_enabled: after.drain_day_enabled,
      priority: after.priority,
      parked: after.parked,
      kill_switch_fallback: after.kill_switch_fallback,
      daily_lines: after.daily_lines,
      updated_by_user_id: userId,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });
    await this.settingsRepo.save(row);

    const ruling = await this.ledger.mint({
      tenant_id: tenantId,
      wallet_id: wallet.id,
      actor_user_id: userId,
      action: 'settings.update',
      summary: this.summarize(before, after),
      before: before as unknown as Record<string, unknown>,
      after: after as unknown as Record<string, unknown>,
    });

    const audit = Object.assign(new WalletSettingsAudit(), {
      id: randomUUID(),
      wallet_id: wallet.id,
      tenant_id: tenantId,
      actor_user_id: userId,
      action: 'settings.update',
      before: before as unknown as Record<string, unknown>,
      after: after as unknown as Record<string, unknown>,
      ruling_id: ruling.id,
      created_at: now,
    });
    await this.auditRepo.save(audit);

    return { settings: after, changed: true, audit_id: audit.id, ruling };
  }

  /** Audit trail for a wallet (newest first). */
  async listAudit(
    tenantId: string,
    userId: string | null,
    walletId: string,
    limit = 50,
  ): Promise<WalletSettingsAudit[]> {
    await this.assertOwner(tenantId, userId);
    const wallet = await this.findWallet(tenantId, walletId);
    const capped = Math.min(Math.max(limit, 1), 200);
    return this.auditRepo.find({
      where: { wallet_id: wallet.id, tenant_id: tenantId },
      order: { created_at: 'DESC' },
      take: capped,
    });
  }

  /** Wallets of the tenant with their member key labels (console read model). */
  async listWallets(
    tenantId: string,
    userId: string | null,
  ): Promise<Array<{ wallet: WalletViewLite; settings: WalletSettingsView }>> {
    await this.assertOwner(tenantId, userId);
    const wallets = await this.walletRepo.find({ where: { tenant_id: tenantId } });
    if (wallets.length === 0) return [];
    const members = await this.memberRepo.find({ where: { tenant_id: tenantId } });
    const keys = await this.providerRepo.find({
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
    const out: Array<{ wallet: WalletViewLite; settings: WalletSettingsView }> = [];
    for (const wallet of wallets) {
      const row = await this.settingsRepo.findOne({ where: { wallet_id: wallet.id } });
      const memberList = membersByWallet.get(wallet.id) ?? [];
      out.push({
        wallet: {
          id: wallet.id,
          name: wallet.name,
          color: wallet.color,
          member_keys: memberList
            .map((m) => ({
              tenant_provider_id: m.tenant_provider_id,
              label: keyById.get(m.tenant_provider_id)?.label ?? 'Unknown',
              provider: keyById.get(m.tenant_provider_id)?.provider ?? 'unknown',
            }))
            .sort((a, b) => a.label.localeCompare(b.label)),
        },
        settings: this.toView(wallet.id, tenantId, row),
      });
    }
    return out;
  }

  /** Owner-only gate: the authenticated user must own the tenant. */
  async assertOwner(tenantId: string, userId: string | null): Promise<void> {
    if (!tenantId) throw new UnauthorizedException('A tenant-scoped credential is required');
    if (!userId) throw new UnauthorizedException('An authenticated user is required');
    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Tenant not found');
    if (!tenant.owner_user_id || tenant.owner_user_id !== userId) {
      throw new ForbiddenException('Wallet settings are owner-only');
    }
  }

  private async findWallet(tenantId: string, walletId: string): Promise<Wallet> {
    const wallet = await this.walletRepo.findOne({ where: { id: walletId, tenant_id: tenantId } });
    if (!wallet) throw new NotFoundException('Wallet not found');
    return wallet;
  }

  private toView(walletId: string, tenantId: string, row?: WalletSettings | null): WalletSettingsView {
    if (!row) {
      return {
        wallet_id: walletId,
        tenant_id: tenantId,
        drain_day_enabled: true,
        priority: 100,
        parked: false,
        kill_switch_fallback: false,
        daily_lines: null,
        updated_at: null as unknown as string,
        updated_by_user_id: null,
      };
    }
    return {
      wallet_id: row.wallet_id,
      tenant_id: row.tenant_id,
      drain_day_enabled: row.drain_day_enabled,
      priority: row.priority,
      parked: row.parked,
      kill_switch_fallback: row.kill_switch_fallback,
      daily_lines: row.daily_lines ?? null,
      updated_at: row.updated_at,
      updated_by_user_id: row.updated_by_user_id ?? null,
    };
  }

  /** Validate the patch at the trust boundary; unknown fields are rejected. */
  private validatePatch(input: UpdateWalletSettingsInput): Partial<WalletSettingsView> {
    const patch: Partial<WalletSettingsView> = {};
    if (input?.drain_day_enabled !== undefined) {
      if (typeof input.drain_day_enabled !== 'boolean') {
        throw new BadRequestException('drain_day_enabled must be a boolean');
      }
      patch.drain_day_enabled = input.drain_day_enabled;
    }
    if (input?.parked !== undefined) {
      if (typeof input.parked !== 'boolean') throw new BadRequestException('parked must be a boolean');
      patch.parked = input.parked;
    }
    if (input?.kill_switch_fallback !== undefined) {
      if (typeof input.kill_switch_fallback !== 'boolean') {
        throw new BadRequestException('kill_switch_fallback must be a boolean');
      }
      patch.kill_switch_fallback = input.kill_switch_fallback;
    }
    if (input?.priority !== undefined) {
      const priority = input.priority;
      if (typeof priority !== 'number' || !Number.isFinite(priority)) {
        throw new BadRequestException('priority must be a number');
      }
      if (priority < PRIORITY_MIN || priority > PRIORITY_MAX) {
        throw new BadRequestException(
          `priority must be between ${PRIORITY_MIN} and ${PRIORITY_MAX}`,
        );
      }
      patch.priority = Math.trunc(priority);
    }
    if (input?.daily_lines !== undefined) {
      patch.daily_lines = this.validateLines(input.daily_lines);
    }
    return patch;
  }

  private validateLines(raw: WalletDailyLines | null): WalletDailyLines | null {
    if (raw === null) return null;
    if (typeof raw !== 'object') throw new BadRequestException('daily_lines must be an object');
    const out: WalletDailyLines = {};
    for (const key of ['base_pct', 'rollover_pool_pct', 'floor_pct'] as const) {
      const value = raw[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new BadRequestException(`daily_lines.${key} must be a number`);
      }
      if (value < 0 || value > 100) {
        throw new BadRequestException(`daily_lines.${key} must be between 0 and 100`);
      }
      out[key] = value;
    }
    return out;
  }

  private differs(before: WalletSettingsView, after: WalletSettingsView): boolean {
    return (
      before.drain_day_enabled !== after.drain_day_enabled ||
      before.priority !== after.priority ||
      before.parked !== after.parked ||
      before.kill_switch_fallback !== after.kill_switch_fallback ||
      JSON.stringify(before.daily_lines ?? null) !== JSON.stringify(after.daily_lines ?? null)
    );
  }

  private summarize(before: WalletSettingsView, after: WalletSettingsView): string {
    const parts: string[] = [];
    if (before.drain_day_enabled !== after.drain_day_enabled) {
      parts.push(`drain_day_enabled ${before.drain_day_enabled} -> ${after.drain_day_enabled}`);
    }
    if (before.priority !== after.priority) parts.push(`priority ${before.priority} -> ${after.priority}`);
    if (before.parked !== after.parked) parts.push(`parked ${before.parked} -> ${after.parked}`);
    if (before.kill_switch_fallback !== after.kill_switch_fallback) {
      parts.push(`kill_switch_fallback ${before.kill_switch_fallback} -> ${after.kill_switch_fallback}`);
    }
    if (JSON.stringify(before.daily_lines ?? null) !== JSON.stringify(after.daily_lines ?? null)) {
      parts.push('daily_lines updated');
    }
    return parts.length > 0 ? parts.join('; ') : 'settings updated';
  }
}

export interface WalletViewLite {
  id: string;
  name: string;
  color: string;
  member_keys: Array<{ tenant_provider_id: string; label: string; provider: string }>;
}
