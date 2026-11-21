import { Injectable } from '@nestjs/common';
import { readRationState, RationDecision } from './ration-state';
import { WalletConsoleService } from './wallet-console.service';

/**
 * Daily budget view (RET-720 scope c).
 *
 * The line math is NOT re-implemented here: today's used-vs-allowed numbers
 * are read from the published RET-670-V3 governor state (base + rollover
 * pool, floor locked, drain-day lift). The console only reports what the
 * governor decided, plus the wallet's own settings, so the console can never
 * disagree with the governor about the line.
 *
 * A wallet parked from the console IS reflected here: `halted` becomes true
 * for the accounts its keys belong to — that is how a settings write lands in
 * the governor state on the next tick.
 */
export interface DailyBudgetAccount {
  account: string;
  keys: string[];
  /** % of the weekly pool allowed today (base + rollover pool). */
  allowed_today_pct: number | null;
  /** % of the weekly pool spent today. */
  used_today_pct: number | null;
  remaining_today_pct: number | null;
  base_pct: number | null;
  rollover_pool_pct: number | null;
  floor_pct: number | null;
  weekly_headroom_pct: number | null;
  five_h_headroom_pct: number | null;
  drain_day: boolean;
  drain_window: boolean;
  allow: boolean;
  halted: boolean;
  day_number: number | null;
  day_index: number | null;
  ration_model: string | null;
  reasons: string[];
  /** Set when a console setting (park) overrides the governor decision. */
  halted_by_console: boolean;
}

export interface DailyBudgetWallet {
  wallet_id: string;
  name: string;
  accounts: string[];
  parked: boolean;
  drain_day_enabled: boolean;
  /** The wallet's own configured lines (null = governor defaults). */
  daily_lines: Record<string, unknown> | null;
}

export interface DailyBudget {
  generated_at: string;
  available: boolean;
  unavailable_reason: string | null;
  ration_updated_at: string | null;
  accounts: DailyBudgetAccount[];
  wallets: DailyBudgetWallet[];
}

@Injectable()
export class BudgetDailyService {
  constructor(private readonly console: WalletConsoleService) {}

  async daily(tenantId: string, userId: string | null): Promise<DailyBudget> {
    await this.console.assertOwner(tenantId, userId);
    const ration = readRationState();
    const listed = await this.console.listWallets(tenantId, userId);

    const parkedAccounts = new Set<string>();
    const wallets: DailyBudgetWallet[] = [];
    for (const entry of listed) {
      const accounts = new Set<string>();
      for (const member of entry.wallet.member_keys) {
        const account = ration.account_by_key[member.label];
        if (account) accounts.add(account);
      }
      if (entry.settings.parked) {
        for (const account of accounts) parkedAccounts.add(account);
      }
      wallets.push({
        wallet_id: entry.wallet.id,
        name: entry.wallet.name,
        accounts: [...accounts],
        parked: entry.settings.parked,
        drain_day_enabled: entry.settings.drain_day_enabled,
        daily_lines: (entry.settings.daily_lines ?? null) as Record<string, unknown> | null,
      });
    }

    const accounts: DailyBudgetAccount[] = Object.entries(ration.accounts).map(
      ([name, status]) => {
        const decision: RationDecision = status.decision ?? {};
        const haltedByConsole = parkedAccounts.has(name);
        return {
          account: name,
          keys: status.acct_keys ?? [],
          allowed_today_pct: decision.usable_pct ?? decision.available_pct ?? null,
          used_today_pct: decision.spent_today_pct ?? status.spent_today_pct ?? null,
          remaining_today_pct: decision.remaining_today_pct ?? null,
          base_pct: decision.base_pct ?? null,
          rollover_pool_pct: decision.rollover_pool_pct ?? null,
          floor_pct: decision.floor_pct ?? null,
          weekly_headroom_pct: decision.weekly_headroom_pct ?? null,
          five_h_headroom_pct: decision.five_h_headroom_pct ?? null,
          drain_day: decision.drain_day ?? false,
          drain_window: decision.drain_window ?? false,
          allow: haltedByConsole ? false : (decision.allow ?? false),
          halted: haltedByConsole ? true : (decision.halt ?? false),
          day_number: decision.day_number ?? null,
          day_index: decision.day_index ?? null,
          ration_model: decision.ration_model ?? null,
          reasons: decision.reasons ?? [],
          halted_by_console: haltedByConsole,
        };
      },
    );

    return {
      generated_at: new Date().toISOString(),
      available: ration.available,
      unavailable_reason: ration.unavailable_reason,
      ration_updated_at: ration.updated_at,
      accounts,
      wallets,
    };
  }
}
