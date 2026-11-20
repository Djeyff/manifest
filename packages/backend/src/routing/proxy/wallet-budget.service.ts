import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { ProviderKeyService } from '../routing-core/provider-key.service';
import {
  evaluateWalletBudget,
  isOwnerAnswerTrigger,
  parseWalletBudget,
  resolveWalletBudgetMode,
  resolveWalletFinalDayDrain,
  weekWindowStart,
  dayWindowStart,
  WALLET_BUDGET_MODE_ENV,
  WALLET_FINAL_DAY_DRAIN_ENV,
  WALLET_NIGHT_WINDOW_DEFAULT_OFFSET_MINUTES,
  type ParsedWalletBudget,
  type WalletBudgetConfig,
  type WalletBudgetDecision,
  type WalletBudgetGate,
  type WalletBudgetMode,
  type WalletGateCallerContext,
  type WalletSpend,
  type WalletTarget,
} from './wallet-budget';

/** M200 template variables for the architect answer-only tier policy. */
export interface TierPolicyBlock {
  metric: string;
  used: string;
  threshold: string;
  period: string;
}

/** One `agent_messages` spend rollup row (numeric columns arrive as strings). */
interface SpendRow {
  day_usd: number | string | null;
  week_usd: number | string | null;
}

function toNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Wallet budgets (RET-692) — persistence + Nest lifecycle for the pure
 * decision core in wallet-budget.ts.
 *
 * Admission runs inside resolveRouteCredentials (one choke point for primary
 * AND fallback hops), so every request is charged to the wallet that will
 * actually serve it, checked BEFORE the call. Every read here is fresh: the
 * `budget` column, the tier flag, and the spend rollups are queried per
 * request, so flipping a budget field changes behavior on the next request
 * with no rollout. The posture env knob
 * (MANIFEST_WALLET_BUDGET_MODE=off|shadow|enforce) starts the rollout in
 * shadow: blocks are logged with a `WALLET-BUDGET` prefix but nothing is
 * refused, so a day of shadow numbers can size the real lines before
 * enforcement flips on.
 */
@Injectable()
export class WalletBudgetService implements WalletBudgetGate {
  private readonly logger = new Logger(WalletBudgetService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly providerKeyService: ProviderKeyService,
  ) {}

  mode(): WalletBudgetMode {
    return resolveWalletBudgetMode(process.env[WALLET_BUDGET_MODE_ENV]);
  }

  async listProviderKeys(
    tenantId: string,
    provider: string,
    authType?: string,
    agentId?: string,
  ): Promise<Array<{ id: string; label: string; apiKey: string | null }>> {
    const keys = await this.providerKeyService.getProviderKeys(
      tenantId,
      provider,
      authType as never,
      agentId,
    );
    return keys.map((key) => ({
      id: key.id,
      label: key.label,
      apiKey: key.apiKey,
      region: key.region,
    }));
  }

  /**
   * The wallet that owns a provider key (RET-692-FU1), or null when the key
   * belongs to no wallet.
   *
   * Tenant-scoped: a wallet only ever matches keys of its own tenant, so a
   * cross-tenant key can never inherit another tenant's wallet line.
   */
  async walletTarget(tenantProviderId: string): Promise<WalletTarget | null> {
    const wallet = await this.resolveWallet(tenantProviderId);
    if (!wallet) return null;
    return {
      wallet_id: wallet.wallet_id,
      name: wallet.name,
      color: wallet.color,
      member_key_ids: wallet.member_key_ids,
      governs: wallet.governs,
    };
  }

  /**
   * The budget that GOVERNS this key (RET-692-FU1).
   *
   * Fallback rule (documented contract):
   *  - key in a wallet whose wallet budget is usable → the WALLET budget
   *    governs (the wallet is the unit of policy);
   *  - key in a wallet whose wallet budget is missing/unusable → fall back to
   *    the key's own legacy `tenant_providers.budget` line;
   *  - key in no wallet → the legacy per-key line, as before.
   */
  async configFor(tenantProviderId: string): Promise<ParsedWalletBudget> {
    const wallet = await this.resolveWallet(tenantProviderId);
    if (wallet?.governs) {
      return parseWalletBudget(wallet.budget);
    }
    const rows: Array<{ budget: unknown }> = await this.dataSource.query(
      `SELECT "budget" FROM "tenant_providers" WHERE "id" = $1`,
      [tenantProviderId],
    );
    return parseWalletBudget(rows?.[0]?.budget);
  }

  /**
   * Spend charged to this wallet from the gateway's own numbers
   * (agent_messages.cost_usd, stamped with the serving row's
   * tenant_provider_id at proxy time). Day window opens at SDQ midnight
   * (fixed UTC-4); the week window opens at the config's Monday UTC anchor.
   */
  async spendFor(
    tenantProviderId: string,
    config: WalletBudgetConfig,
    now: Date,
  ): Promise<WalletSpend> {
    return this.spendForScope([tenantProviderId], config, now);
  }

  /**
   * Spend over a SCOPE of provider keys.
   *
   * Per-key scope → the legacy per-key line. Wallet scope → the sum over
   * EVERY member key of the wallet, because the wallet's line is charged by
   * the whole group, not by the key that happens to pay.
   */
  async spendForScope(
    scopeKeyIds: string[],
    config: WalletBudgetConfig,
    now: Date,
  ): Promise<WalletSpend> {
    const dayStart = dayWindowStart(now, WALLET_NIGHT_WINDOW_DEFAULT_OFFSET_MINUTES);
    const weekStart = weekWindowStart(now, config.week_anchor_utc ?? '00:00');
    const rows: SpendRow[] = await this.dataSource.query(
      `SELECT
         COALESCE(SUM("cost_usd") FILTER (WHERE "timestamp" >= $2), 0) AS "day_usd",
         COALESCE(SUM("cost_usd") FILTER (WHERE "timestamp" >= $3), 0) AS "week_usd"
       FROM "agent_messages"
       WHERE "tenant_provider_id" = ANY($1)`,
      [scopeKeyIds, dayStart.toISOString(), weekStart.toISOString()],
    );
    return {
      day_usd: toNumber(rows?.[0]?.day_usd),
      week_usd: toNumber(rows?.[0]?.week_usd),
    };
  }

  async decide(
    config: WalletBudgetConfig,
    tenantProviderId: string,
    caller: WalletGateCallerContext,
    now: Date,
  ): Promise<{ spend: WalletSpend; decision: WalletBudgetDecision }> {
    const wallet = await this.resolveWallet(tenantProviderId);
    // Wallet-governed → the wallet's own lines and the wallet-wide spend
    // scope (sum over all member keys). Otherwise → the legacy per-key line
    // and the per-key spend scope.
    const effectiveConfig = wallet?.governs ? parseWalletBudget(wallet.budget).config! : config;
    const scope = wallet?.governs ? wallet.member_key_ids : [tenantProviderId];
    const spend = await this.spendForScope(scope, effectiveConfig, now);
    return {
      spend,
      decision: evaluateWalletBudget(effectiveConfig, spend, caller, now, {
        // RET-695 kill switch (MANIFEST_WALLET_FINAL_DAY_DRAIN), read fresh
        // per request exactly like the posture mode knob.
        finalDayDrain: resolveWalletFinalDayDrain(process.env[WALLET_FINAL_DAY_DRAIN_ENV]),
      }),
    };
  }

  /** The wallet row (with its raw budget) that owns this key, if any. */
  private async resolveWallet(
    tenantProviderId: string,
  ): Promise<(WalletTarget & { budget: unknown; governs: boolean }) | null> {
    const rows: Array<{
      wallet_id: string;
      name: string;
      color: string;
      budget: unknown;
      member_key_ids: string[] | null;
    }> = await this.dataSource.query(
      `SELECT
         w."id" AS "wallet_id",
         w."name" AS "name",
         w."color" AS "color",
         w."budget" AS "budget",
         (
           SELECT array_agg(m2."tenant_provider_id")
           FROM "wallet_members" m2
           WHERE m2."wallet_id" = w."id"
             AND m2."tenant_id" = w."tenant_id"
         ) AS "member_key_ids"
       FROM "wallet_members" m
       JOIN "wallets" w
         ON w."id" = m."wallet_id"
        AND w."tenant_id" = m."tenant_id"
       WHERE m."tenant_provider_id" = $1
       LIMIT 1`,
      [tenantProviderId],
    );
    const row = rows?.[0];
    if (!row) return null;
    return {
      wallet_id: row.wallet_id,
      name: row.name,
      color: row.color,
      member_key_ids: row.member_key_ids ?? [],
      budget: row.budget,
      governs: parseWalletBudget(row.budget).config !== null,
    };
  }

  noteBlocked(
    walletLabel: string,
    decision: Extract<WalletBudgetDecision, { allowed: false }>,
    config: WalletBudgetConfig,
    spend: WalletSpend,
    caller: WalletGateCallerContext,
  ): void {
    const who = caller.agentName || caller.tierName || 'unknown-caller';
    this.logger.warn(
      `WALLET-BUDGET: wallet="${walletLabel}" rule=${decision.rule} caller=${who} — ` +
        `${decision.detail} (day ${spend.day_usd.toFixed(2)}/${config.daily_usd ?? '—'} USD, ` +
        `week ${spend.week_usd.toFixed(2)}/${config.weekly_usd ?? '—'} USD)`,
    );
  }

  /** Tier display name for allowlist matching; null when tiers are not in play. */
  async tierNameFor(headerTierId: string | null | undefined): Promise<string | null> {
    if (!headerTierId || this.mode() === 'off') return null;
    const rows: Array<{ name: string }> = await this.dataSource.query(
      `SELECT "name" FROM "header_tiers" WHERE "id" = $1`,
      [headerTierId],
    );
    return rows?.[0]?.name ?? null;
  }

  /**
   * Architect answer-only tier policy: a tier flagged `architect_answer_only`
   * may only be used by turns answering an owner message (they carry an
   * `x-manifest-trigger: owner-…` header). Autonomous architect work on the
   * tier is rejected before any credential resolution. Returns M200 template
   * variables, or null when the request may proceed.
   */
  async tierPolicyBlock(
    headerTierId: string | null | undefined,
    caller: WalletGateCallerContext,
  ): Promise<TierPolicyBlock | null> {
    if (!headerTierId || this.mode() === 'off') return null;
    if (isOwnerAnswerTrigger(caller.triggerHeader)) return null;
    const rows: Array<{ name: string; architect_answer_only: boolean }> =
      await this.dataSource.query(
        `SELECT "name", "architect_answer_only" FROM "header_tiers" WHERE "id" = $1`,
        [headerTierId],
      );
    const tier = rows?.[0];
    if (!tier?.architect_answer_only) return null;
    this.logger.warn(
      `WALLET-BUDGET: tier="${tier.name}" architect_answer_only refused caller=` +
        `${caller.agentName || 'unknown-caller'} (no owner-answer trigger header)`,
    );
    return {
      metric: `${tier.name} tier architect answer-only`,
      used: 'blocked',
      threshold: 'owner answers only',
      period: 'autonomous architect work is not allowed',
    };
  }
}
