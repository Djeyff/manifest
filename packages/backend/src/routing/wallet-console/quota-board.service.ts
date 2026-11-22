import { Injectable, Logger } from '@nestjs/common';
import { ZaiQuotaService } from '../zai-quota/zai-quota.service';
import { readRationState, RationState } from './ration-state';
import { WalletConsoleService, WalletSettingsView } from './wallet-console.service';

/**
 * Quota board (RET-720 scope b).
 *
 * HARD RULE: the numbers served here are FRESH provider-own readings. The
 * board forces one live poll cycle of the provider-own quota feed (the same
 * feed the gateway mirror uses) before it reads the snapshot, and it always
 * carries the provider's own `seen_at` per label so a stale reading is
 * visible as stale instead of being passed off as live. The frozen-snapshot
 * defect class (RET-708) can therefore not hide behind this endpoint.
 */
export interface QuotaBoardKey {
  label: string;
  provider: string;
  account: string | null;
  five_h_pct_left: number | null;
  weekly_pct_left: number | null;
  five_h_reset_at: string | null;
  weekly_reset_at: string | null;
  plan_level: string | null;
  subscription_status: string | null;
  /** Provider-own instant of the reading this API served. */
  seen_at: string | null;
  /** True when the reading is older than the staleness budget. */
  stale: boolean;
  error: string | null;
  halted: boolean;
}

export interface QuotaBoardWallet {
  wallet_id: string;
  name: string;
  color: string;
  parked: boolean;
  priority: number;
  drain_day_enabled: boolean;
  keys: QuotaBoardKey[];
  /** Lowest 5h/weekly headroom across the wallet's keys (null when unknown). */
  min_five_h_pct_left: number | null;
  min_weekly_pct_left: number | null;
  halted: boolean;
}

export interface QuotaBoard {
  generated_at: string;
  /** ISO instant of the fresh poll cycle this board was built from. */
  polled_at: string | null;
  /** True when the feed could not be polled and the last snapshot is used. */
  stale_feed: boolean;
  ration: {
    available: boolean;
    updated_at: string | null;
    unavailable_reason: string | null;
  };
  wallets: QuotaBoardWallet[];
}

/** A reading older than this is reported as stale (never silently served). */
export const QUOTA_STALE_AFTER_MS = 5 * 60 * 1000;

@Injectable()
export class QuotaBoardService {
  private readonly logger = new Logger(QuotaBoardService.name);

  constructor(
    private readonly quota: ZaiQuotaService,
    private readonly console: WalletConsoleService,
  ) {}

  async board(tenantId: string, userId: string | null): Promise<QuotaBoard> {
    await this.console.assertOwner(tenantId, userId);

    // FRESH first: force one provider-own poll cycle, then read the snapshot.
    let staleFeed = false;
    try {
      await this.quota.tick();
    } catch (error) {
      staleFeed = true;
      this.logger.warn(`quota-board: live poll failed, serving last snapshot: ${error}`);
    }
    const snapshot = this.quota.snapshot();
    const ration: RationState = readRationState();
    const nowMs = Date.now();

    const listed = await this.console.listWallets(tenantId, userId);
    const wallets: QuotaBoardWallet[] = [];
    for (const entry of listed) {
      const settings: WalletSettingsView = entry.settings;
      const keys: QuotaBoardKey[] = entry.wallet.member_keys.map((member) => {
        const reading = snapshot.labels[member.label];
        const seenAt = reading?.seen_at ?? null;
        const seenMs = seenAt ? Date.parse(seenAt) : NaN;
        const stale = !Number.isFinite(seenMs) || nowMs - seenMs > QUOTA_STALE_AFTER_MS;
        const account = ration.account_by_key[member.label] ?? null;
        const accountHalted = account ? (ration.accounts[account]?.decision?.halt ?? false) : false;
        return {
          label: member.label,
          provider: member.provider,
          account,
          five_h_pct_left: reading?.five_h_pct_left ?? null,
          weekly_pct_left: reading?.weekly_pct_left ?? null,
          five_h_reset_at: reading?.five_h_reset_at ?? null,
          weekly_reset_at: reading?.weekly_reset_at ?? null,
          plan_level: reading?.plan_level ?? null,
          subscription_status: reading?.subscription_status ?? null,
          seen_at: seenAt,
          stale,
          error: reading?.error ?? null,
          halted: settings.parked || accountHalted,
        };
      });
      const fiveH = keys.map((k) => k.five_h_pct_left).filter((v): v is number => v !== null);
      const weekly = keys.map((k) => k.weekly_pct_left).filter((v): v is number => v !== null);
      wallets.push({
        wallet_id: entry.wallet.id,
        name: entry.wallet.name,
        color: entry.wallet.color,
        parked: settings.parked,
        priority: settings.priority,
        drain_day_enabled: settings.drain_day_enabled,
        keys,
        min_five_h_pct_left: fiveH.length > 0 ? Math.min(...fiveH) : null,
        min_weekly_pct_left: weekly.length > 0 ? Math.min(...weekly) : null,
        halted: settings.parked || keys.every((k) => k.halted) && keys.length > 0,
      });
    }

    return {
      generated_at: new Date().toISOString(),
      polled_at: snapshot.polled_at,
      stale_feed: staleFeed,
      ration: {
        available: ration.available,
        updated_at: ration.updated_at,
        unavailable_reason: ration.unavailable_reason,
      },
      wallets,
    };
  }
}
