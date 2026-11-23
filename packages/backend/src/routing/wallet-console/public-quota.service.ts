import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { readFileSync, renameSync, writeFileSync } from 'fs';
import { ZaiQuotaService } from '../zai-quota/zai-quota.service';
import { ZaiQuotaSnapshot } from '../zai-quota/zai-quota-monitor';
import { readRationState, RationState } from './ration-state';
import { Wallet, WalletMember } from '../../entities/wallet.entity';
import { WalletSettings } from '../../entities/wallet-settings.entity';
import { TenantProvider } from '../../entities/tenant-provider.entity';
import { QUOTA_STALE_AFTER_MS } from './quota-board.service';
import { WORKING_DAY_HOURS } from './budget-daily.service';

/**
 * Public quota feed (ret500-nodupe).
 *
 * The always-served mirror of the owner console's maths: `GET /quota.json`
 * feeds the public `/quota` page and the owner's local quota app. Reading
 * quota NEVER depends on key active-state — parking affects ROUTING, not
 * READING — so a parked wallet keeps its row: day numbers come from the
 * published governor state (independent of key state), provider-own readings
 * come from the quota feed, and when the feed does not carry a wallet (the
 * parked-key blindness this card exists to fix) the wallet's LAST KNOWN
 * values are served WITH `stale: true` + `polled_at`. The feed never 404s,
 * never blanks, and never hides a parked wallet.
 *
 * No auth, no secrets: percentages and wallet names only — no key labels,
 * no account ids, no tenant ids, no key material.
 */

/** The canonical wallet rows this surface serves (wallet NAMES, not key labels). */
export const PUBLIC_WALLET_NAMES = ['MAIN', 'MM', 'BACKUP'] as const;
export type PublicWalletName = (typeof PUBLIC_WALLET_NAMES)[number];

/** Pace status against an even spread of today's line over the working day. */
export type PublicPace = 'ON_PACE' | 'SLOW' | 'FAST';

/** Burn ≥15% faster than even spread is FAST; ≥15% slower is SLOW. */
const PACE_FAST_RATIO = 1.15;
const PACE_SLOW_RATIO = 0.85;
/** Below this expected burn (% points) the day is too young to call a pace. */
const PACE_MIN_EXPECTED_PCT = 0.5;

/** Where the last-known rows persist (env-overridable, like the ration file). */
export const PUBLIC_QUOTA_FILE_DEFAULT = '/opt/data/shared/state/ret500-quota-last-known.json';

export function publicQuotaFilePath(): string {
  return process.env.MANIFEST_PUBLIC_QUOTA_FILE ?? PUBLIC_QUOTA_FILE_DEFAULT;
}

/** The formula strip terms — the governor's own published components. */
export interface PublicQuotaFormula {
  label: 'allowed today';
  base_pct: number | null;
  reserve_pct: number | null;
  rollover_pool_pct: number | null;
  floor_pct: number | null;
  allowed_today_pct: number | null;
}

/** One wallet row of the public feed (wallet grain, no key details). */
export interface PublicQuotaWallet {
  /** Base wallet name (MAIN / MM / BACKUP). */
  name: PublicWalletName;
  /** Display form, e.g. `MAIN (Z.AI Max)`. */
  display_name: string;
  /** Provider plan this wallet draws from (the stable `source` contract). */
  source: 'zai-coding-plan' | 'minimax-token-plan' | 'mixed';
  /** True when the wallet is parked — the row still shows, never hidden. */
  parked: boolean;
  /** True when the governor (or a console park) halts the wallet today. */
  halted: boolean;
  /** Progress bar inputs: used vs allowed today (% of the weekly pool). */
  used_today_pct: number | null;
  allowed_today_pct: number | null;
  /** Provider-own weekly window. */
  weekly_pct_left: number | null;
  weekly_reset_at: string | null;
  /** Provider-own 5h window (the shortest line the wallet actually draws on). */
  five_h_pct_left: number | null;
  five_h_reset_at: string | null;
  /** Governor-published share of the weekly pool already spent. */
  weekly_spent_pct: number | null;
  /** Pace vs even spread + projection (server-computed, never client maths). */
  pace: PublicPace | null;
  pace_pct_per_h: number | null;
  projected_end_pct: number | null;
  working_hours_left: number | null;
  /** Human projection line, e.g. `at this pace: line reached in ~7.3h`. */
  projection: string | null;
  /** The arithmetic spelled out: base + reserve + rollover − floor = allowed. */
  formula: PublicQuotaFormula;
  /** True when any number in this row is a last-known value, not a live read. */
  stale: boolean;
  /** ISO instant of the freshest reading this row was built from. */
  polled_at: string | null;
  /** False only when nothing is known at all (no live read AND no last-known). */
  published: boolean;
  /** Why a row is stale / unpublished (honesty note for the page). */
  note: string | null;
  /** Wallet colour chip from the DB. */
  color: string | null;
}

export interface PublicQuotaFeed {
  /** Keyed by wallet name — MAIN / MM / BACKUP always present. */
  wallets: Record<PublicWalletName, PublicQuotaWallet>;
  /** The governor tick this feed's day maths ride on. */
  tick_at: string | null;
  generated_at: string;
  /** True when the live provider poll failed and last snapshots were used. */
  stale: boolean;
  polled_at: string | null;
  /** Governor state availability, verbatim. */
  ration_available: boolean;
  ration_unavailable_reason: string | null;
}

/** A canonical wallet the pinned tenant owns, with its live row inputs. */
interface PublicWalletEntry {
  name: PublicWalletName;
  walletId: string;
  color: string | null;
  parked: boolean;
  priority: number;
  memberKeys: Array<{ label: string; provider: string }>;
  accountNames: string[];
}

/** Persisted last-known row (what the feed serves when a wallet drops out). */
interface LastKnownFile {
  saved_at: string;
  wallets: Partial<Record<PublicWalletName, { row: PublicQuotaWallet; at: string }>>;
}

/**
 * Canonical wallet key for a DB wallet name.
 *
 * The owner's wallet rows are named for display ("MAIN (Z.AI Max)",
 * "MM (MiniMax)", "BACKUP (Z.AI Pro)"), while the canonical keys this
 * surface serves are MAIN / MM / BACKUP. Strip a trailing parenthetical
 * qualifier before comparing, so the display name in the DB never blanks the
 * row. Display names themselves stay untouched (see `displayNameOf`).
 */
export function canonicalWalletName(raw: string | null | undefined): PublicWalletName | null {
  const base = (raw ?? '')
    .trim()
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim()
    .toUpperCase();
  return (PUBLIC_WALLET_NAMES as readonly string[]).includes(base)
    ? (base as PublicWalletName)
    : null;
}

/** Display form: `MAIN (Z.AI Max)` / `MM (MiniMax)` / `BACKUP (Z.AI Pro)`. */
const PLAN_BY_NAME: Record<string, string> = {
  MAIN: 'Z.AI Max',
  MM: 'MiniMax',
  BACKUP: 'Z.AI Pro',
};

function displayNameOf(name: string): string {
  const plan = PLAN_BY_NAME[name.toUpperCase()];
  return plan ? `${name} (${plan})` : name;
}

/** Stable `source` contract per provider ids of the wallet's member keys. */
function sourceOf(providers: string[]): PublicQuotaWallet['source'] {
  const set = new Set(providers.map((p) => (p ?? '').toLowerCase()));
  const isZai = [...set].some((p) => p.startsWith('zai'));
  const isMinimax = set.has('minimax');
  if (isZai && isMinimax) return 'mixed';
  if (isMinimax) return 'minimax-token-plan';
  if (isZai) return 'zai-coding-plan';
  return 'mixed';
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Null-safe sum: null when both sides null. */
function pickSum(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

/** Null-safe max: null when both sides null. */
function pickMax(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function decNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

@Injectable()
export class PublicQuotaService {
  private readonly logger = new Logger(PublicQuotaService.name);
  /** Last-known rows: in-memory cache mirrored to disk (survives restarts). */
  private lastKnown = new Map<PublicWalletName, { row: PublicQuotaWallet; at: string }>();
  private lastKnownLoaded = false;
  /** Serialise disk writes so concurrent requests cannot interleave. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly quota: ZaiQuotaService,
    @InjectRepository(Wallet)
    private readonly walletRepo: Repository<Wallet>,
    @InjectRepository(WalletMember)
    private readonly memberRepo: Repository<WalletMember>,
    @InjectRepository(TenantProvider)
    private readonly providerRepo: Repository<TenantProvider>,
    @InjectRepository(WalletSettings)
    private readonly settingsRepo: Repository<WalletSettings>,
  ) {}

  /** Build the public feed. Never throws for data reasons — the feed always serves. */
  async feed(): Promise<PublicQuotaFeed> {
    this.ensureLastKnownLoaded();

    // FRESH first — the same discipline as the owner console's quota board:
    // force one provider-own poll cycle, then read the snapshot.
    let staleFeed = false;
    try {
      await this.quota.tick();
    } catch (error) {
      staleFeed = true;
      this.logger.warn(`public-quota: live poll failed, serving last snapshot: ${error}`);
    }
    const snapshot = this.quota.snapshot();
    const ration = readRationState();
    const nowMs = Date.now();

    const listed = await this.listPublicWallets(ration);
    const wallets = {} as Record<PublicQuotaWallet['name'], PublicQuotaWallet>;
    for (const name of PUBLIC_WALLET_NAMES) {
      const entry = listed.find((l) => l.name === name);
      wallets[name] = entry
        ? this.buildRow(name, entry, snapshot, ration, nowMs, staleFeed)
        : this.absentRow(name, listed.length > 0);
    }

    // Roll fresh rows into the last-known cache (parked wallets keep serving).
    this.updateLastKnown(wallets);

    return {
      wallets,
      // The governor publishes its tick under several key names; `ration.tick_at`
      // already walks the fallback chain (enforce_tick → updated_at →
      // generated_at → last_status.at) so the feed is never null while a
      // governor file exists.
      tick_at: ration.tick_at,
      generated_at: new Date().toISOString(),
      stale: staleFeed || Object.values(wallets).every((w) => w.stale),
      polled_at: snapshot.polled_at,
      ration_available: ration.available,
      ration_unavailable_reason: ration.unavailable_reason,
    };
  }

  /**
   * The wallets this surface serves, WITHOUT any owner assertion.
   *
   * The gateway is the owner's single-tenant deployment; to stay deterministic
   * even if stray tenants ever exist, the feed pins to the tenant owning the
   * most canonical wallet names (tie → lexicographically smallest tenant id)
   * and serves only that tenant's rows. No other tenant's rows can leak.
   */
  private async listPublicWallets(ration: RationState): Promise<PublicWalletEntry[]> {
    const canonical = new Set<string>(PUBLIC_WALLET_NAMES);
    const wallets = await this.walletRepo.find();
    const candidates = wallets.filter((w) => canonical.has(canonicalWalletName(w.name) ?? ''));
    if (candidates.length === 0) return [];

    const byTenant = new Map<string, typeof candidates>();
    for (const wallet of candidates) {
      const list = byTenant.get(wallet.tenant_id) ?? [];
      list.push(wallet);
      byTenant.set(wallet.tenant_id, list);
    }
    const pinned = [...byTenant.entries()].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
    )[0];
    const tenantId = pinned[0];

    const members = await this.memberRepo.find({ where: { tenant_id: tenantId } });
    const keys = await this.providerRepo.find({
      where: { tenant_id: tenantId },
      select: ['id', 'label', 'provider'],
    });
    const keyById = new Map(keys.map((k) => [k.id, k]));

    const out: PublicWalletEntry[] = [];
    for (const wallet of pinned[1]) {
      const name = canonicalWalletName(wallet.name);
      if (!name) continue;
      const row = await this.settingsRepo.findOne({ where: { wallet_id: wallet.id } });
      const memberKeys = members
        .filter((m) => m.wallet_id === wallet.id)
        .map((m) => ({
          label: keyById.get(m.tenant_provider_id)?.label ?? '',
          provider: keyById.get(m.tenant_provider_id)?.provider ?? '',
        }))
        .filter((k) => k.label !== '');
      const accountNames = [
        ...new Set(
          memberKeys.map((k) => ration.account_by_key[k.label]).filter((a): a is string => !!a),
        ),
      ];
      out.push({
        name,
        walletId: wallet.id,
        color: wallet.color ?? null,
        parked: row?.parked ?? false,
        priority: row?.priority ?? 0,
        memberKeys,
        accountNames,
      });
    }
    return out.sort(
      (a, b) =>
        PUBLIC_WALLET_NAMES.indexOf(a.name) - PUBLIC_WALLET_NAMES.indexOf(b.name) ||
        a.priority - b.priority,
    );
  }

  /** Build one wallet row from live sources, falling back to last-known. */
  private buildRow(
    name: PublicWalletName,
    entry: PublicWalletEntry,
    snapshot: ZaiQuotaSnapshot,
    ration: RationState,
    nowMs: number,
    staleFeed: boolean,
  ): PublicQuotaWallet {
    const cached = this.lastKnown.get(name) ?? null;
    const notes: string[] = [];
    /** True when any number in this row came from the last-known cache. */
    let substituted = false;

    // --- provider-own readings (from the quota feed) -----------------------
    let weeklyLeft: number | null = null;
    let weeklyReset: string | null = null;
    let fiveHLeft: number | null = null;
    let fiveHReset: string | null = null;
    let polledAt: string | null = null;
    let providerFresh = false;
    for (const key of entry.memberKeys) {
      const reading = snapshot.labels[key.label];
      const seenAt = reading?.seen_at ?? null;
      const seenMs = seenAt ? Date.parse(seenAt) : NaN;
      const isStale = !Number.isFinite(seenMs) || nowMs - seenMs > QUOTA_STALE_AFTER_MS;
      if (isStale) continue;
      providerFresh = true;
      if (polledAt === null || seenMs > Date.parse(polledAt)) polledAt = seenAt;
      if (typeof reading.weekly_pct_left === 'number') {
        weeklyLeft =
          weeklyLeft === null
            ? reading.weekly_pct_left
            : Math.min(weeklyLeft, reading.weekly_pct_left);
      }
      if (typeof reading.five_h_pct_left === 'number') {
        fiveHLeft =
          fiveHLeft === null
            ? reading.five_h_pct_left
            : Math.min(fiveHLeft, reading.five_h_pct_left);
      }
      if (typeof reading.weekly_reset_at === 'string') weeklyReset = reading.weekly_reset_at;
      if (typeof reading.five_h_reset_at === 'string') fiveHReset = reading.five_h_reset_at;
    }
    if (!providerFresh) {
      if (!staleFeed) notes.push('no fresh provider reading for this wallet');
      if (weeklyLeft === null && cached?.row.weekly_pct_left != null) {
        weeklyLeft = cached.row.weekly_pct_left;
        weeklyReset = weeklyReset ?? cached.row.weekly_reset_at;
        substituted = true;
      }
      if (fiveHLeft === null && cached?.row.five_h_pct_left != null) {
        fiveHLeft = cached.row.five_h_pct_left;
        fiveHReset = fiveHReset ?? cached.row.five_h_reset_at;
        substituted = true;
      }
    }

    // --- day maths (the published governor state) --------------------------
    let usedToday: number | null = null;
    let allowedToday: number | null = null;
    let weeklySpent: number | null = null;
    let base: number | null = null;
    let reserve: number | null = null;
    let rollover: number | null = null;
    let floor: number | null = null;
    let haltedByGovernor = false;
    let accountNumbersKnown = false;
    /** The governor's own published usable line, when it publishes one. */
    let governorUsable: number | null = null;
    for (const account of entry.accountNames) {
      const status = ration.accounts[account];
      if (!status) continue;
      const decision = status.decision ?? {};
      accountNumbersKnown = true;
      usedToday = pickSum(usedToday, decNum(decision.spent_today_pct ?? status.spent_today_pct));
      governorUsable = pickSum(governorUsable, decNum(decision.usable_pct ?? decision.available_pct));
      weeklySpent = pickMax(weeklySpent, decNum(status.spent_week_pct));
      base = pickSum(base, decNum(decision.base_pct));
      reserve = pickSum(reserve, decNum(decision.reserve_pct));
      rollover = pickSum(rollover, decNum(decision.rollover_pool_pct));
      floor = pickSum(floor, decNum(decision.floor_pct));
      if (decision.halt === true || decision.allow === false) haltedByGovernor = true;
    }
    if (!accountNumbersKnown) {
      if (ration.available) notes.push('no ration account published for this wallet');
      if (cached) {
        usedToday = usedToday ?? cached.row.used_today_pct;
        allowedToday = allowedToday ?? cached.row.allowed_today_pct;
        weeklySpent = weeklySpent ?? cached.row.weekly_spent_pct;
        base = base ?? cached.row.formula.base_pct;
        reserve = reserve ?? cached.row.formula.reserve_pct;
        rollover = rollover ?? cached.row.formula.rollover_pool_pct;
        floor = floor ?? cached.row.formula.floor_pct;
        if (usedToday !== null || allowedToday !== null) substituted = true;
      }
    }
    // The owner's arithmetic IS the display contract: allowed-today =
    // base + reserve + rollover, and the line is capped by the governor's own
    // published usable value. The governor can publish the reserve and the
    // rollover pool as the SAME money (zai-max day 2: reserve 4.2857 and
    // rollover pool 4.2857, usable 14.2857), so summing all three would
    // double-count it. Allowed = min(governor usable, base+reserve+rollover);
    // the strip then carries base, the reserve, and whatever rollover is left
    // of the line — so the visible sum always equals the published line.
    if (base !== null && reserve !== null && rollover !== null) {
      const sum = base + reserve + rollover;
      allowedToday = governorUsable === null ? sum : Math.min(governorUsable, sum);
      if (allowedToday < base) {
        base = allowedToday;
        reserve = 0;
        rollover = 0;
      } else {
        const reserveRoom = allowedToday - base;
        if (reserve > reserveRoom) reserve = reserveRoom;
        rollover = allowedToday - base - reserve;
      }
    } else if (allowedToday === null) {
      allowedToday = governorUsable;
    }

    // --- pace + projection (mirror of the console's day maths) -------------
    const dayEpoch = ration.day_epoch;
    const elapsedH =
      dayEpoch === null || dayEpoch === undefined
        ? null
        : Math.max(0, (nowMs / 1000 - dayEpoch) / 3600);
    const workingHoursLeft = elapsedH === null ? null : Math.max(0, WORKING_DAY_HOURS - elapsedH);
    const pacePerH =
      elapsedH === null || elapsedH <= 0 || usedToday === null ? null : usedToday / elapsedH;
    const projectedEnd =
      pacePerH === null || workingHoursLeft === null || usedToday === null
        ? null
        : usedToday + pacePerH * workingHoursLeft;
    const pace = this.paceStatus(allowedToday, usedToday, elapsedH);
    const projection =
      allowedToday === null ||
      usedToday === null ||
      pacePerH === null ||
      projectedEnd === null ||
      workingHoursLeft === null
        ? null
        : this.projectionText(allowedToday, usedToday, pacePerH, projectedEnd, workingHoursLeft);

    const row: PublicQuotaWallet = {
      name,
      display_name: displayNameOf(name),
      source: sourceOf(entry.memberKeys.map((k) => k.provider)),
      parked: entry.parked,
      halted: entry.parked || haltedByGovernor,
      used_today_pct: usedToday,
      allowed_today_pct: allowedToday,
      weekly_pct_left: weeklyLeft,
      weekly_reset_at: weeklyReset,
      five_h_pct_left: fiveHLeft,
      five_h_reset_at: fiveHReset,
      weekly_spent_pct: weeklySpent,
      pace,
      pace_pct_per_h: pacePerH === null ? null : round(pacePerH, 4),
      projected_end_pct: projectedEnd === null ? null : round(projectedEnd, 3),
      working_hours_left: workingHoursLeft === null ? null : round(workingHoursLeft, 3),
      projection,
      formula: {
        label: 'allowed today',
        base_pct: base,
        reserve_pct: reserve,
        rollover_pool_pct: rollover,
        floor_pct: floor,
        allowed_today_pct: allowedToday,
      },
      stale: !providerFresh || staleFeed || !accountNumbersKnown,
      polled_at: polledAt ?? cached?.at ?? snapshot.polled_at ?? null,
      published: usedToday !== null || allowedToday !== null || weeklyLeft !== null,
      note: notes.length > 0 ? notes.join(' · ') : null,
      color: entry.color,
    };
    if (substituted) {
      row.note = [row.note, 'last known values shown'].filter(Boolean).join(' · ');
    }
    return row;
  }

  /** Pace status vs an even spread of the allowed line over the working day. */
  private paceStatus(
    allowedToday: number | null,
    usedToday: number | null,
    elapsedH: number | null,
  ): PublicPace | null {
    if (allowedToday === null || usedToday === null || elapsedH === null) return null;
    if (usedToday > allowedToday) return 'FAST';
    const expected = allowedToday * (elapsedH / WORKING_DAY_HOURS);
    if (expected < PACE_MIN_EXPECTED_PCT) return 'ON_PACE';
    const ratio = usedToday / expected;
    if (ratio >= PACE_FAST_RATIO) return 'FAST';
    if (ratio <= PACE_SLOW_RATIO) return 'SLOW';
    return 'ON_PACE';
  }

  /** The owner's projection phrasing, computed server-side. */
  private projectionText(
    allowedToday: number,
    usedToday: number,
    pacePerH: number,
    projectedEnd: number,
    workingHoursLeft: number,
  ): string {
    const remaining = allowedToday - usedToday;
    if (remaining <= 0) return `over today's line by ${Math.abs(remaining).toFixed(1)}%`;
    if (pacePerH <= 0) return `${remaining.toFixed(1)}% left at curfew`;
    const hoursToLine = remaining / pacePerH;
    if (hoursToLine <= workingHoursLeft) {
      return `at this pace: line reached in ~${hoursToLine.toFixed(1)}h`;
    }
    const leftAtCurfew = Math.max(0, allowedToday - projectedEnd);
    return `at this pace: ${leftAtCurfew.toFixed(1)}% left at curfew`;
  }

  /** A canonical wallet with no DB row: present, unpublished, never hidden. */
  private absentRow(name: PublicWalletName, tenantPinned: boolean): PublicQuotaWallet {
    const cached = this.lastKnown.get(name) ?? null;
    if (cached) {
      return { ...cached.row, stale: true, note: 'wallet row missing — last known values shown' };
    }
    return {
      name,
      display_name: displayNameOf(name),
      source: 'mixed',
      parked: false,
      halted: false,
      used_today_pct: null,
      allowed_today_pct: null,
      weekly_pct_left: null,
      weekly_reset_at: null,
      five_h_pct_left: null,
      five_h_reset_at: null,
      weekly_spent_pct: null,
      pace: null,
      pace_pct_per_h: null,
      projected_end_pct: null,
      working_hours_left: null,
      projection: null,
      formula: {
        label: 'allowed today',
        base_pct: null,
        reserve_pct: null,
        rollover_pool_pct: null,
        floor_pct: null,
        allowed_today_pct: null,
      },
      stale: true,
      polled_at: null,
      published: false,
      note: tenantPinned ? 'wallet not configured on this deployment' : 'no wallets configured',
      color: null,
    };
  }

  /** Cache rows that carry numbers; persist atomically; never throw. */
  private updateLastKnown(wallets: Record<PublicQuotaWallet['name'], PublicQuotaWallet>): void {
    const at = new Date().toISOString();
    let dirty = false;
    for (const row of Object.values(wallets)) {
      if (!row.published) continue;
      const prev = this.lastKnown.get(row.name);
      // Never overwrite a fresh cached row with a stale rebuild — but do
      // overwrite with fresh data, or stale-with-fresher-governor-numbers.
      if (prev && prev.row.stale === false && row.stale === true) continue;
      this.lastKnown.set(row.name, { row, at });
      dirty = true;
    }
    if (!dirty) return;
    const payload: LastKnownFile = {
      saved_at: at,
      wallets: Object.fromEntries(
        [...this.lastKnown.entries()].map(([name, entry]) => [name, entry]),
      ) as LastKnownFile['wallets'],
    };
    const path = publicQuotaFilePath();
    this.writeChain = this.writeChain
      .then(() => {
        try {
          const tmp = `${path}.tmp`;
          writeFileSync(tmp, JSON.stringify(payload));
          renameSync(tmp, path);
        } catch (error) {
          this.logger.warn(`public-quota: could not persist last-known rows: ${error}`);
        }
      })
      .catch(() => undefined);
  }

  /** Lazy-load the persisted last-known rows once per process. */
  private ensureLastKnownLoaded(): void {
    if (this.lastKnownLoaded) return;
    this.lastKnownLoaded = true;
    let raw: string;
    try {
      raw = readFileSync(publicQuotaFilePath(), 'utf8');
    } catch {
      return; // No file yet — an empty cache is a valid state.
    }
    try {
      const parsed = JSON.parse(raw) as LastKnownFile;
      for (const [name, entry] of Object.entries(parsed.wallets ?? {})) {
        if (!entry?.row) continue;
        if (!(PUBLIC_WALLET_NAMES as readonly string[]).includes(name)) continue;
        this.lastKnown.set(name as PublicWalletName, { row: entry.row, at: entry.at });
      }
    } catch (error) {
      this.logger.warn(`public-quota: last-known file unreadable, ignoring: ${error}`);
    }
  }
}
