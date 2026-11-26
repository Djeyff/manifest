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
import { WalletOwnerIntent } from '../../entities/wallet-owner-intent.entity';
import { DecisionLedgerService, MintedRuling } from './decision-ledger.service';
import { readRationState } from './ration-state';

/**
 * Wallet settings service (RET-720 scope a → D-2026-11-22-11/-13).
 *
 * Owner-only surface: every read and write asserts that the authenticated
 * user owns the tenant (`tenants.owner_user_id`). The console is an
 * internal owner surface — no tenant member may steer a money line.
 *
 * Every change writes an audit row AND auto-mints a decisions-ledger ruling
 * (RET-719 doctrine: a UI action is doctrine, zero drift).
 */

/** One wallet→key binding: which registered key serves this wallet per room. */
export interface WalletKeyBinding {
  /** Room the key serves (RCR / CCR / …), derived from the key label. */
  room: string;
  /** The registered provider key (`tenant_providers.id`). */
  tenant_provider_id: string;
  /** Key label, e.g. "RCR" — display only. */
  label: string;
  /** Provider of the key, e.g. "zai" — display only. */
  provider: string;
}

/** A registered key of the tenant that a wallet can be bound to. */
export interface ProviderKeyView {
  id: string;
  label: string;
  provider: string;
  /** Room the key serves (RCR / CCR / OTHER). */
  room: string;
  /** Wallet the key currently belongs to, when it is bound to one. */
  bound_wallet_id: string | null;
}

export interface WalletSettingsView {
  wallet_id: string;
  tenant_id: string;
  drain_day_enabled: boolean;
  priority: number;
  parked: boolean;
  kill_switch_fallback: boolean;
  daily_lines: WalletDailyLines | null;
  /** Owner reserve (% of the weekly pool); null = the governor's own reserve. */
  reserve_pct: number | null;
  /** Rollover on/off. */
  rollover_enabled: boolean;
  /** Cross-class pause rule on/off. */
  cross_class_pause: boolean;
  /** The wallet's key bindings (one per room). */
  key_bindings: WalletKeyBinding[];
  updated_at: string;
  updated_by_user_id: string | null;
}

export interface UpdateWalletSettingsInput {
  drain_day_enabled?: boolean;
  priority?: number;
  parked?: boolean;
  kill_switch_fallback?: boolean;
  daily_lines?: WalletDailyLines | null;
  reserve_pct?: number | null;
  rollover_enabled?: boolean;
  cross_class_pause?: boolean;
  /** The wallet's key bindings (one per room). */
  key_bindings?: Array<{ room: string; tenant_provider_id: string }>;
}

export interface WalletSettingsUpdateResult {
  settings: WalletSettingsView;
  /** False when the payload matched the current state (no audit row, no ruling). */
  changed: boolean;
  audit_id: string | null;
  ruling: MintedRuling | null;
}

/** The intent actions this surface accepts (RET-776-B contract: exactly these two). */
export const WALLET_INTENT_ACTIONS = ['pause', 'resume'] as const;
export type WalletIntentAction = (typeof WALLET_INTENT_ACTIONS)[number];

/** Owner free-text reason cap (RET-776-B D2). */
export const WALLET_INTENT_REASON_MAX = 500;

/** The runtime state a wallet reports (RET-776-B D4). */
export type WalletRuntimeState = 'running' | 'paused_by_owner' | 'parked_by_governor';

/**
 * Wallet state view (RET-776-B D4). The quota numbers are NOT computed here:
 * the CONTROLLER merges them from PublicQuotaService.feed() — a service-only
 * read serves them as null + stale, so line math can never fork from the feed.
 */
export interface WalletStateView {
  wallet_id: string;
  name: string;
  state: WalletRuntimeState;
  daily_left_pct: number | null;
  weekly_left_pct: number | null;
  read_at: string | null;
  numbers_stale: boolean;
  last_intent: { action: string; actor: string; at: string } | null;
  keys_active: boolean;
}

export interface WalletIntentWriteResult {
  changed: boolean;
  action: WalletIntentAction;
  /** The governed accounts the intent rows were written for. */
  accounts: string[];
  intent: { action: string; actor: string; reason: string; at: string } | null;
  audit_id: string | null;
  ruling: MintedRuling | null;
  state: WalletStateView;
}

const PRIORITY_MIN = 0;
const PRIORITY_MAX = 1000;

/** The room a key serves, derived from its label prefix (RCR / CCR / OTHER). */
export function roomOfLabel(label: string): string {
  const upper = (label ?? '').trim().toUpperCase();
  if (upper.startsWith('RCR')) return 'RCR';
  if (upper.startsWith('CCR')) return 'CCR';
  return 'OTHER';
}

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
    @InjectRepository(WalletOwnerIntent)
    private readonly intentRepo: Repository<WalletOwnerIntent>,
  ) {}

  /** Current settings for a wallet (defaults when the wallet was never tuned). */
  async getSettings(
    tenantId: string,
    userId: string | null,
    walletId: string,
  ): Promise<WalletSettingsView> {
    await this.assertOwner(tenantId, userId);
    const wallet = await this.findWallet(tenantId, walletId);
    const row = await this.settingsRepo.findOne({ where: { wallet_id: wallet.id } });
    const bindings = await this.bindingsOf(tenantId, wallet.id);
    return this.toView(wallet.id, tenantId, row, bindings);
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
    const beforeBindings = await this.bindingsOf(tenantId, wallet.id);
    const before = this.toView(wallet.id, tenantId, existing, beforeBindings);
    const patch = await this.validatePatch(tenantId, input);
    const now = new Date().toISOString();

    // Key bindings change the wallet's MEMBERSHIP rows, not the settings row.
    if (patch.key_bindings !== undefined) {
      await this.applyBindings(tenantId, wallet.id, patch.key_bindings);
    }
    const afterBindings =
      patch.key_bindings !== undefined
        ? await this.bindingsOf(tenantId, wallet.id)
        : beforeBindings;

    const after: WalletSettingsView = {
      ...before,
      ...patch,
      key_bindings: afterBindings,
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
      reserve_pct: after.reserve_pct,
      rollover_enabled: after.rollover_enabled,
      cross_class_pause: after.cross_class_pause,
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

  /**
   * Record the owner's pause/resume INTENT (RET-776-B).
   *
   * The intent is a ROW in wallet_owner_intents — keys are NEVER flipped
   * here; the governor + tick (RET-776-A) read the table and park/unpark.
   * One row is inserted per governed account whose LATEST intent differs
   * (insert, not save — every column is a primary column); repeating the
   * same action is a no-op (no row, no audit, no mint). Every write also
   * gets a wallet_settings_audit row + a decisions-ledger ruling, exactly
   * like a settings change.
   */
  async setOwnerIntent(
    tenantId: string,
    userId: string | null,
    walletId: string,
    input: { action?: unknown; reason?: unknown },
  ): Promise<WalletIntentWriteResult> {
    await this.assertOwner(tenantId, userId);
    if (!userId) throw new UnauthorizedException('An authenticated user is required');
    const action = WALLET_INTENT_ACTIONS.find((a) => a === input?.action);
    if (!action) throw new BadRequestException("action must be 'pause' or 'resume'");
    if (input.reason !== undefined && input.reason !== null && typeof input.reason !== 'string') {
      throw new BadRequestException('reason must be a string');
    }
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length > WALLET_INTENT_REASON_MAX) {
      throw new BadRequestException(
        `reason must be at most ${WALLET_INTENT_REASON_MAX} characters`,
      );
    }
    const wallet = await this.findWallet(tenantId, walletId);
    const accounts = await this.governedAccounts(tenantId, wallet.id);
    if (accounts.length === 0) {
      throw new BadRequestException('no governed account behind this wallet');
    }

    const before = await this.stateViewOf(wallet, tenantId);
    const pending: string[] = [];
    const latestByAccount = new Map<string, WalletOwnerIntent | null>();
    for (const account of accounts) {
      const latest = await this.latestIntentFor(account);
      latestByAccount.set(account, latest);
      if (latest?.action !== action) pending.push(account);
    }
    if (pending.length === 0) {
      const last = this.newestOf(latestByAccount);
      return {
        changed: false,
        action,
        accounts,
        intent: last
          ? { action: last.action, actor: last.actor, reason: last.reason, at: last.created_at }
          : null,
        audit_id: null,
        ruling: null,
        state: before,
      };
    }

    const actor: string = userId;
    const now = new Date().toISOString();
    const summary = `owner ${action} intent for wallet ${wallet.name} (${pending.join(', ')})${
      reason ? `: ${reason}` : ''
    }`;
    const ruling = await this.ledger.mint({
      tenant_id: tenantId,
      wallet_id: wallet.id,
      actor_user_id: actor,
      action: `intent.${action}`,
      summary,
      before: { state: before.state } as unknown as Record<string, unknown>,
      after: {
        intent: { action, actor, reason, at: now },
        accounts: pending,
      } as unknown as Record<string, unknown>,
    });

    const audit = Object.assign(new WalletSettingsAudit(), {
      id: randomUUID(),
      wallet_id: wallet.id,
      tenant_id: tenantId,
      actor_user_id: actor,
      action: `intent.${action}`,
      before: { state: before.state } as unknown as Record<string, unknown>,
      after: {
        intent: { action, actor, reason, at: now },
        accounts: pending,
      } as unknown as Record<string, unknown>,
      ruling_id: ruling.id,
      created_at: now,
    });
    await this.auditRepo.save(audit);

    for (const account of pending) {
      // The composite PK includes created_at: nudge the stamp past the newest
      // row this intent replaces so two writes can never collide on it.
      const latest = latestByAccount.get(account);
      const stamp =
        latest && latest.created_at >= now
          ? new Date(Date.parse(latest.created_at) + 1).toISOString()
          : now;
      await this.intentRepo.insert(
        Object.assign(new WalletOwnerIntent(), {
          account,
          action,
          actor,
          reason,
          created_at: stamp,
        }),
      );
    }

    const state = await this.stateViewOf(wallet, tenantId);
    return {
      changed: true,
      action,
      accounts: pending,
      intent: { action, actor, reason, at: now },
      audit_id: audit.id,
      ruling,
      state,
    };
  }

  /**
   * The wallet's runtime state (RET-776-B D4). Quota numbers stay null here —
   * the controller merges them from PublicQuotaService.feed().
   */
  async getWalletState(
    tenantId: string,
    userId: string | null,
    walletId: string,
  ): Promise<WalletStateView> {
    await this.assertOwner(tenantId, userId);
    const wallet = await this.findWallet(tenantId, walletId);
    return this.stateViewOf(wallet, tenantId);
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
      const bindings: WalletKeyBinding[] = memberList
        .map((m) => {
          const key = keyById.get(m.tenant_provider_id);
          return {
            room: roomOfLabel(key?.label ?? ''),
            tenant_provider_id: m.tenant_provider_id,
            label: key?.label ?? 'Unknown',
            provider: key?.provider ?? 'unknown',
          };
        })
        .sort((a, b) => a.room.localeCompare(b.room) || a.label.localeCompare(b.label));
      out.push({
        wallet: {
          id: wallet.id,
          name: wallet.name,
          color: wallet.color,
          member_keys: bindings.map((b) => ({
            tenant_provider_id: b.tenant_provider_id,
            label: b.label,
            provider: b.provider,
          })),
        },
        settings: this.toView(wallet.id, tenantId, row, bindings),
      });
    }
    return out;
  }

  /**
   * The registered keys a wallet can be bound to (D-2026-11-22-13): the
   * tenant's provider keys, each with the room it serves and the wallet it is
   * currently bound to. This is the ONLY place wallet→key bindings change.
   */
  async listProviderKeys(tenantId: string, userId: string | null): Promise<ProviderKeyView[]> {
    await this.assertOwner(tenantId, userId);
    const keys = await this.providerRepo.find({ where: { tenant_id: tenantId } });
    const members = await this.memberRepo.find({ where: { tenant_id: tenantId } });
    const boundBy = new Map<string, string>();
    for (const member of members) {
      boundBy.set(member.tenant_provider_id, member.wallet_id);
    }
    return keys
      .map((key) => ({
        id: key.id,
        label: key.label,
        provider: key.provider,
        room: roomOfLabel(key.label),
        bound_wallet_id: boundBy.get(key.id) ?? null,
      }))
      .sort((a, b) => a.room.localeCompare(b.room) || a.label.localeCompare(b.label));
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

  /**
   * Governed accounts behind a wallet (RET-776-B D2): the unique ration
   * account of each member key — account := ration.account_by_key[label],
   * NEVER the wallet id or the key label. Empty = nothing to govern.
   */
  private async governedAccounts(tenantId: string, walletId: string): Promise<string[]> {
    const members = await this.memberRepo.find({
      where: { wallet_id: walletId, tenant_id: tenantId },
    });
    if (members.length === 0) return [];
    const keys = await this.providerRepo.find({
      where: { tenant_id: tenantId },
      select: ['id', 'label', 'provider'],
    });
    const keyById = new Map(keys.map((k) => [k.id, k]));
    const ration = readRationState();
    const accounts = new Set<string>();
    for (const member of members) {
      const label = keyById.get(member.tenant_provider_id)?.label ?? '';
      const account = ration.account_by_key[label];
      if (account) accounts.add(account);
    }
    return [...accounts].sort();
  }

  /** The newest intent row of one account — the governor's read: latest wins. */
  private latestIntentFor(account: string): Promise<WalletOwnerIntent | null> {
    return this.intentRepo.findOne({ where: { account }, order: { created_at: 'DESC' } });
  }

  /** The newest row across a wallet's governed accounts (null = no intent). */
  private async lastIntentForAccounts(accounts: string[]): Promise<WalletOwnerIntent | null> {
    const rows: WalletOwnerIntent[] = [];
    for (const account of accounts) {
      const row = await this.latestIntentFor(account);
      if (row) rows.push(row);
    }
    return this.newestOf(new Map(rows.map((r) => [r.account, r])));
  }

  private newestOf(byAccount: Map<string, WalletOwnerIntent | null>): WalletOwnerIntent | null {
    let newest: WalletOwnerIntent | null = null;
    for (const row of byAccount.values()) {
      if (row && (newest === null || row.created_at > newest.created_at)) newest = row;
    }
    return newest;
  }

  /**
   * Build the state view. Owner intent outranks governor parking: the owner
   * said pause, the wallet stays paused_by_owner even if the governor also
   * parked it. Quota numbers are merged by the controller from the feed.
   */
  private async stateViewOf(wallet: Wallet, tenantId: string): Promise<WalletStateView> {
    const accounts = await this.governedAccounts(tenantId, wallet.id);
    const lastIntent = accounts.length > 0 ? await this.lastIntentForAccounts(accounts) : null;
    const settings = await this.settingsRepo.findOne({ where: { wallet_id: wallet.id } });
    const members = await this.memberRepo.find({
      where: { wallet_id: wallet.id, tenant_id: tenantId },
    });
    const keys =
      members.length > 0
        ? await this.providerRepo.find({
            where: { tenant_id: tenantId },
            select: ['id', 'label', 'provider', 'is_active'],
          })
        : [];
    const keyById = new Map(keys.map((k) => [k.id, k]));
    const keysActive =
      members.length > 0 &&
      members.every((m) => keyById.get(m.tenant_provider_id)?.is_active === true);
    const governorParked =
      members.length > 0 &&
      members.some((m) => keyById.get(m.tenant_provider_id)?.is_active === false);
    const state: WalletRuntimeState =
      lastIntent?.action === 'pause'
        ? 'paused_by_owner'
        : (settings?.parked ?? false) || governorParked
          ? 'parked_by_governor'
          : 'running';
    return {
      wallet_id: wallet.id,
      name: wallet.name,
      state,
      daily_left_pct: null,
      weekly_left_pct: null,
      read_at: null,
      numbers_stale: true,
      last_intent: lastIntent
        ? { action: lastIntent.action, actor: lastIntent.actor, at: lastIntent.created_at }
        : null,
      keys_active: keysActive,
    };
  }

  /** The wallet's current bindings, resolved against the registered keys. */
  private async bindingsOf(tenantId: string, walletId: string): Promise<WalletKeyBinding[]> {
    const members = await this.memberRepo.find({
      where: { wallet_id: walletId, tenant_id: tenantId },
    });
    if (members.length === 0) return [];
    const keys = await this.providerRepo.find({
      where: { tenant_id: tenantId },
      select: ['id', 'label', 'provider'],
    });
    const keyById = new Map(keys.map((k) => [k.id, k]));
    return members
      .map((m) => {
        const key = keyById.get(m.tenant_provider_id);
        return {
          room: roomOfLabel(key?.label ?? ''),
          tenant_provider_id: m.tenant_provider_id,
          label: key?.label ?? 'Unknown',
          provider: key?.provider ?? 'unknown',
        };
      })
      .sort((a, b) => a.room.localeCompare(b.room) || a.label.localeCompare(b.label));
  }

  /**
   * Apply the wallet's key bindings: the wallet ends up with EXACTLY these
   * keys. A key that moves to this wallet is detached from the wallet it was
   * on before (a key serves one wallet only).
   */
  private async applyBindings(
    tenantId: string,
    walletId: string,
    desired: Array<{ room: string; tenant_provider_id: string }>,
  ): Promise<void> {
    const wanted = new Set(desired.map((d) => d.tenant_provider_id));
    const current = await this.memberRepo.find({
      where: { wallet_id: walletId, tenant_id: tenantId },
    });
    for (const member of current) {
      if (!wanted.has(member.tenant_provider_id)) {
        await this.memberRepo.delete({
          wallet_id: walletId,
          tenant_provider_id: member.tenant_provider_id,
        });
      }
    }
    const have = new Set(current.map((m) => m.tenant_provider_id));
    const now = new Date().toISOString();
    for (const id of wanted) {
      if (have.has(id)) continue;
      // Detach from any other wallet first: one key serves one wallet.
      await this.memberRepo.delete({ tenant_provider_id: id });
      await this.memberRepo.insert(
        Object.assign(new WalletMember(), {
          wallet_id: walletId,
          tenant_provider_id: id,
          tenant_id: tenantId,
          created_at: now,
        }),
      );
    }
  }

  private toView(
    walletId: string,
    tenantId: string,
    row?: WalletSettings | null,
    bindings: WalletKeyBinding[] = [],
  ): WalletSettingsView {
    if (!row) {
      return {
        wallet_id: walletId,
        tenant_id: tenantId,
        drain_day_enabled: true,
        priority: 100,
        parked: false,
        kill_switch_fallback: false,
        daily_lines: null,
        reserve_pct: null,
        rollover_enabled: true,
        cross_class_pause: false,
        key_bindings: bindings,
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
      reserve_pct: row.reserve_pct ?? null,
      rollover_enabled: row.rollover_enabled ?? true,
      cross_class_pause: row.cross_class_pause ?? false,
      key_bindings: bindings,
      updated_at: row.updated_at,
      updated_by_user_id: row.updated_by_user_id ?? null,
    };
  }

  /** Validate the patch at the trust boundary; unknown fields are rejected. */
  private async validatePatch(
    tenantId: string,
    input: UpdateWalletSettingsInput,
  ): Promise<Partial<WalletSettingsView>> {
    const patch: Partial<WalletSettingsView> = {};
    if (input?.drain_day_enabled !== undefined) {
      if (typeof input.drain_day_enabled !== 'boolean') {
        throw new BadRequestException('drain_day_enabled must be a boolean');
      }
      patch.drain_day_enabled = input.drain_day_enabled;
    }
    if (input?.parked !== undefined) {
      if (typeof input.parked !== 'boolean')
        throw new BadRequestException('parked must be a boolean');
      patch.parked = input.parked;
    }
    if (input?.kill_switch_fallback !== undefined) {
      if (typeof input.kill_switch_fallback !== 'boolean') {
        throw new BadRequestException('kill_switch_fallback must be a boolean');
      }
      patch.kill_switch_fallback = input.kill_switch_fallback;
    }
    if (input?.rollover_enabled !== undefined) {
      if (typeof input.rollover_enabled !== 'boolean') {
        throw new BadRequestException('rollover_enabled must be a boolean');
      }
      patch.rollover_enabled = input.rollover_enabled;
    }
    if (input?.cross_class_pause !== undefined) {
      if (typeof input.cross_class_pause !== 'boolean') {
        throw new BadRequestException('cross_class_pause must be a boolean');
      }
      patch.cross_class_pause = input.cross_class_pause;
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
    if (input?.reserve_pct !== undefined) {
      if (input.reserve_pct === null) {
        patch.reserve_pct = null;
      } else {
        const reserve = input.reserve_pct;
        if (typeof reserve !== 'number' || !Number.isFinite(reserve)) {
          throw new BadRequestException('reserve_pct must be a number');
        }
        if (reserve < 0 || reserve > 100) {
          throw new BadRequestException('reserve_pct must be between 0 and 100');
        }
        patch.reserve_pct = reserve;
      }
    }
    if (input?.daily_lines !== undefined) {
      patch.daily_lines = this.validateLines(input.daily_lines);
    }
    if (input?.key_bindings !== undefined) {
      patch.key_bindings = await this.validateBindings(tenantId, input.key_bindings);
    }
    return patch;
  }

  /** Key bindings must name registered keys of THIS tenant, one per room. */
  private async validateBindings(
    tenantId: string,
    raw: Array<{ room: string; tenant_provider_id: string }>,
  ): Promise<WalletKeyBinding[]> {
    if (!Array.isArray(raw)) throw new BadRequestException('key_bindings must be an array');
    const out: WalletKeyBinding[] = [];
    const seenRooms = new Set<string>();
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') {
        throw new BadRequestException('key_bindings entries must be objects');
      }
      const id = entry.tenant_provider_id;
      if (typeof id !== 'string' || id.trim() === '') {
        throw new BadRequestException('key_bindings.tenant_provider_id must be a key id');
      }
      const key = await this.providerRepo.findOne({ where: { id, tenant_id: tenantId } });
      if (!key) throw new BadRequestException(`Unknown provider key: ${id}`);
      const room = roomOfLabel(key.label);
      if (seenRooms.has(room)) {
        throw new BadRequestException(`Only one key per room is allowed (${room})`);
      }
      seenRooms.add(room);
      out.push({
        room,
        tenant_provider_id: id,
        label: key.label,
        provider: key.provider,
      });
    }
    return out.sort((a, b) => a.room.localeCompare(b.room));
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
      before.reserve_pct !== after.reserve_pct ||
      before.rollover_enabled !== after.rollover_enabled ||
      before.cross_class_pause !== after.cross_class_pause ||
      JSON.stringify(before.daily_lines ?? null) !== JSON.stringify(after.daily_lines ?? null) ||
      JSON.stringify(before.key_bindings ?? null) !== JSON.stringify(after.key_bindings ?? null)
    );
  }

  private summarize(before: WalletSettingsView, after: WalletSettingsView): string {
    const parts: string[] = [];
    if (before.drain_day_enabled !== after.drain_day_enabled) {
      parts.push(`drain_day_enabled ${before.drain_day_enabled} -> ${after.drain_day_enabled}`);
    }
    if (before.priority !== after.priority)
      parts.push(`priority ${before.priority} -> ${after.priority}`);
    if (before.parked !== after.parked) parts.push(`parked ${before.parked} -> ${after.parked}`);
    if (before.kill_switch_fallback !== after.kill_switch_fallback) {
      parts.push(
        `kill_switch_fallback ${before.kill_switch_fallback} -> ${after.kill_switch_fallback}`,
      );
    }
    if (before.reserve_pct !== after.reserve_pct) {
      parts.push(
        `reserve_pct ${before.reserve_pct ?? 'governor'} -> ${after.reserve_pct ?? 'governor'}`,
      );
    }
    if (before.rollover_enabled !== after.rollover_enabled) {
      parts.push(`rollover_enabled ${before.rollover_enabled} -> ${after.rollover_enabled}`);
    }
    if (before.cross_class_pause !== after.cross_class_pause) {
      parts.push(`cross_class_pause ${before.cross_class_pause} -> ${after.cross_class_pause}`);
    }
    if (JSON.stringify(before.daily_lines ?? null) !== JSON.stringify(after.daily_lines ?? null)) {
      parts.push('daily_lines updated');
    }
    if (
      JSON.stringify(before.key_bindings ?? null) !== JSON.stringify(after.key_bindings ?? null)
    ) {
      const names = after.key_bindings.map((b) => `${b.room}:${b.label}`).join(', ');
      parts.push(`key bindings updated (${names || 'none'})`);
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
