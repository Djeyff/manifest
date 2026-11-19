import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { ProviderKeyService } from '../routing-core/provider-key.service';
import {
  evaluateWalletBudget,
  isOwnerAnswerTrigger,
  parseWalletBudget,
  resolveWalletBudgetMode,
  weekWindowStart,
  dayWindowStart,
  WALLET_BUDGET_MODE_ENV,
  WALLET_NIGHT_WINDOW_DEFAULT_OFFSET_MINUTES,
  type ParsedWalletBudget,
  type WalletBudgetConfig,
  type WalletBudgetDecision,
  type WalletBudgetGate,
  type WalletBudgetMode,
  type WalletGateCallerContext,
  type WalletSpend,
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

  /** Fresh read + parse of the wallet's `budget` column. Ungoverned → config null. */
  async configFor(tenantProviderId: string): Promise<ParsedWalletBudget> {
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
    const dayStart = dayWindowStart(now, WALLET_NIGHT_WINDOW_DEFAULT_OFFSET_MINUTES);
    const weekStart = weekWindowStart(now, config.week_anchor_utc ?? '00:00');
    const rows: SpendRow[] = await this.dataSource.query(
      `SELECT
         COALESCE(SUM("cost_usd") FILTER (WHERE "timestamp" >= $2), 0) AS "day_usd",
         COALESCE(SUM("cost_usd") FILTER (WHERE "timestamp" >= $3), 0) AS "week_usd"
       FROM "agent_messages"
       WHERE "tenant_provider_id" = $1`,
      [tenantProviderId, dayStart.toISOString(), weekStart.toISOString()],
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
    const spend = await this.spendFor(tenantProviderId, config, now);
    return { spend, decision: evaluateWalletBudget(config, spend, caller, now) };
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
    const rows: Array<{ name: string; architect_answer_only: boolean }> = await this.dataSource.query(
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
