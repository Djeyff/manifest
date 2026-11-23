import { PublicQuotaService, canonicalWalletName } from './public-quota.service';
import { readRationState } from './ration-state';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ZaiQuotaSnapshot } from '../zai-quota/zai-quota-monitor';

/**
 * Receipts for the ret500-nodupe DATA PATH (blank /quota.json + /quota page).
 *
 * Three live failures are pinned here:
 *  1. the DB wallet rows are named for display ("MAIN (Z.AI Max)",
 *     "MM (MiniMax)", "BACKUP (Z.AI Pro)") while the canonical keys are
 *     MAIN / MM / BACKUP — the suffix must not blank the row;
 *  2. the governor file publishes its tick as `generated_at` /
 *     `last_status.at` (not `enforce_tick` / `updated_at`) — `tick_at` must
 *     still be non-null;
 *  3. MM has NO wallet_settings row, so `parked` is false while the
 *     governor halts it (allow=false, halt=true) — the row must show the
 *     halted state WITH numbers.
 */

const NOW = new Date('2026-11-23T10:30:00.000Z');
const NOW_EPOCH = Math.floor(NOW.getTime() / 1000);

let rationDir: string;
let lastKnownPath: string;

/**
 * The governor file as it is published live: `generated_at` + `last_status`,
 * NO `enforce_tick` and NO `updated_at`.
 */
function writeGovernorFile(overrides?: { minimaxDecision?: Record<string, unknown> }): string {
  const dayEpoch = NOW_EPOCH - 4 * 3600; // the ration day started 4h ago
  const state = {
    generated_at: '2026-11-23T10:29:00Z',
    source: 'ret670-enforce-tick',
    rollover: { enabled: true, day_epoch: dayEpoch },
    last_status: {
      at: '2026-11-23T10:29:00Z',
      week_start: dayEpoch - 86400,
      day_start_utc: '10:05',
      accounts: {
        'zai-max': {
          acct_keys: ['RCR', 'CCR'],
          spent_week_pct: 3.7768,
          spent_today_pct: 4.7214,
          decision: {
            account: 'zai-max',
            allow: true,
            halt: false,
            usable_pct: 14.285714,
            spent_today_pct: 4.7214,
            base_pct: 10,
            reserve_pct: 4.285714,
            rollover_pool_pct: 4.285714,
            floor_pct: 4,
            weekly_headroom_pct: 73,
            five_h_headroom_pct: 18.4,
          },
        },
        'zai-pro': {
          acct_keys: ['RCR Backup', 'CCR Backup'],
          spent_week_pct: 1.3676,
          spent_today_pct: 8.072994,
          decision: {
            account: 'zai-pro',
            allow: true,
            halt: false,
            usable_pct: 10,
            spent_today_pct: 8.072994,
            base_pct: 10,
            reserve_pct: 0,
            rollover_pool_pct: 0,
            floor_pct: 4,
            weekly_headroom_pct: 6,
            five_h_headroom_pct: 19.2,
          },
        },
        minimax: {
          acct_keys: ['RCR MM', 'CCR MM'],
          spent_week_pct: 7.7486,
          spent_today_pct: 17.837839,
          decision: {
            account: 'minimax',
            allow: false,
            halt: true,
            usable_pct: 17.837839,
            spent_today_pct: 17.837839,
            base_pct: 10,
            reserve_pct: 0,
            rollover_pool_pct: 0,
            floor_pct: 0,
            weekly_headroom_pct: 88,
            five_h_headroom_pct: null,
            ...(overrides?.minimaxDecision ?? {}),
          },
        },
      },
    },
  };
  const path = join(rationDir, 'ret670-ration.json');
  writeFileSync(path, JSON.stringify(state));
  return path;
}

function snapshot(labels: Record<string, number>, polledAt: string | null): ZaiQuotaSnapshot {
  const built: ZaiQuotaSnapshot['labels'] = {};
  for (const [label, weekly] of Object.entries(labels)) {
    built[label] = {
      label,
      provider: 'zai',
      five_h_pct_left: 99,
      weekly_pct_left: weekly,
      five_h_reset_at: null,
      weekly_reset_at: null,
      plan_level: 'max',
      subscription_status: 'active',
      seen_at: polledAt,
      polled_at: polledAt,
      source: label.includes('MM') ? 'minimax-token-plan' : 'zai-coding-plan',
      error: null,
    } as ZaiQuotaSnapshot['labels'][string];
  }
  return { labels: built, polled_at: polledAt, polls: 1, poll_errors: 0 };
}

/** The live DB rows: display names, and NO wallet_settings row for w-mm. */
function makeRepos() {
  const wallets = [
    { id: 'w-main-zai', name: 'MAIN (Z.AI Max)' },
    { id: 'w-mm', name: 'MM (MiniMax)' },
    { id: 'w-backup', name: 'BACKUP (Z.AI Pro)' },
  ];
  const members = [
    { wallet_id: 'w-main-zai', tenant_provider_id: 'k-rcr', tenant_id: 't1' },
    { wallet_id: 'w-main-zai', tenant_provider_id: 'k-ccr', tenant_id: 't1' },
    { wallet_id: 'w-mm', tenant_provider_id: 'k-rcr-mm', tenant_id: 't1' },
    { wallet_id: 'w-mm', tenant_provider_id: 'k-ccr-mm', tenant_id: 't1' },
    { wallet_id: 'w-backup', tenant_provider_id: 'k-rcr-bkp', tenant_id: 't1' },
  ];
  const keys = [
    { id: 'k-rcr', label: 'RCR', provider: 'zai-coding-plan' },
    { id: 'k-ccr', label: 'CCR', provider: 'zai-coding-plan' },
    { id: 'k-rcr-mm', label: 'RCR MM', provider: 'minimax' },
    { id: 'k-ccr-mm', label: 'CCR MM', provider: 'minimax' },
    { id: 'k-rcr-bkp', label: 'RCR Backup', provider: 'zai-coding-plan' },
  ];
  return {
    walletRepo: {
      find: jest.fn(async () => wallets.map((w) => ({ ...w, tenant_id: 't1', color: 'indigo' }))),
    },
    memberRepo: { find: jest.fn(async () => members) },
    providerRepo: { find: jest.fn(async () => keys) },
    settingsRepo: {
      findOne: jest.fn(async ({ where }: { where: { wallet_id: string } }) => {
        // Only MAIN and BACKUP have a wallet_settings row — MM has none.
        if (where.wallet_id === 'w-mm') return null;
        return { wallet_id: where.wallet_id, parked: false, priority: 100 };
      }),
    },
  };
}

function makeService(quota: unknown, repos: ReturnType<typeof makeRepos>) {
  return new PublicQuotaService(
    quota as never,
    repos.walletRepo as never,
    repos.memberRepo as never,
    repos.providerRepo as never,
    repos.settingsRepo as never,
  );
}

function makeQuota(snap: ZaiQuotaSnapshot) {
  return {
    tick: jest.fn(async () => undefined),
    snapshot: jest.fn(() => snap),
  };
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
  rationDir = mkdtempSync(join(tmpdir(), 'ret500-datapath-'));
  writeGovernorFile();
  lastKnownPath = join(rationDir, 'last-known.json');
  process.env.MANIFEST_RET670_RATION_FILE = join(rationDir, 'ret670-ration.json');
  process.env.MANIFEST_PUBLIC_QUOTA_FILE = lastKnownPath;
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.MANIFEST_RET670_RATION_FILE;
  delete process.env.MANIFEST_PUBLIC_QUOTA_FILE;
});

describe('public quota data path (ret500-nodupe)', () => {
  it('canonicalises the display-named DB wallet rows (MAIN (Z.AI Max) -> MAIN)', () => {
    expect(canonicalWalletName('MAIN (Z.AI Max)')).toBe('MAIN');
    expect(canonicalWalletName('MM (MiniMax)')).toBe('MM');
    expect(canonicalWalletName('BACKUP (Z.AI Pro)')).toBe('BACKUP');
    expect(canonicalWalletName('MAIN')).toBe('MAIN');
    expect(canonicalWalletName('main (zai max)')).toBe('MAIN');
    expect(canonicalWalletName('Hetzner')).toBeNull();
    expect(canonicalWalletName(null)).toBeNull();
  });

  it('serves all three rows WITH numbers when the DB names carry the display suffix', async () => {
    const feed = await makeService(
      makeQuota(
        snapshot(
          { RCR: 72, CCR: 72, 'RCR MM': 87, 'CCR MM': 87, 'RCR Backup': 5 },
          NOW.toISOString(),
        ),
      ),
      makeRepos(),
    ).feed();

    for (const name of ['MAIN', 'MM', 'BACKUP'] as const) {
      const row = feed.wallets[name];
      expect(row.published).toBe(true);
      expect(row.used_today_pct).not.toBeNull();
      expect(row.allowed_today_pct).not.toBeNull();
      expect(row.weekly_pct_left).not.toBeNull();
      expect(row.five_h_pct_left).not.toBeNull();
      expect(row.polled_at).not.toBeNull();
      expect(row.note ?? '').not.toContain('no wallets configured');
    }
    // Display names stay for the page.
    expect(feed.wallets.MAIN.display_name).toBe('MAIN (Z.AI Max)');
    expect(feed.wallets.MM.display_name).toBe('MM (MiniMax)');
    expect(feed.wallets.BACKUP.display_name).toBe('BACKUP (Z.AI Pro)');
  });

  it('tick_at is non-null from the governor file that has neither enforce_tick nor updated_at', async () => {
    const feed = await makeService(
      makeQuota(snapshot({ RCR: 72, 'RCR MM': 87 }, NOW.toISOString())),
      makeRepos(),
    ).feed();
    expect(feed.tick_at).toBe('2026-11-23T10:29:00Z');
    expect(feed.tick_at).not.toBeNull();

    // And the reader itself walks the fallback chain.
    const state = readRationState();
    expect(state.tick_at).toBe('2026-11-23T10:29:00Z');
    expect(state.generated_at).toBe('2026-11-23T10:29:00Z');
  });

  it('tick_at prefers enforce_tick.at, then updated_at, over generated_at', () => {
    const path = join(rationDir, 'chain.json');
    writeFileSync(
      path,
      JSON.stringify({
        generated_at: '2026-01-01T00:00:00Z',
        updated_at: 1790000000,
        enforce_tick: { at: '2026-11-23T09:00:00Z', source: 'test' },
        last_status: { at: '2026-01-02T00:00:00Z' },
      }),
    );
    expect(readRationState(path).tick_at).toBe('2026-11-23T09:00:00Z');

    writeFileSync(
      path,
      JSON.stringify({
        generated_at: '2026-01-01T00:00:00Z',
        updated_at: 1790000000,
        last_status: { at: '2026-01-02T00:00:00Z' },
      }),
    );
    expect(readRationState(path).tick_at).toBe(new Date(1790000000 * 1000).toISOString());

    writeFileSync(
      path,
      JSON.stringify({ generated_at: '2026-01-01T00:00:00Z', last_status: { at: '2026-01-02T00:00:00Z' } }),
    );
    expect(readRationState(path).tick_at).toBe('2026-01-01T00:00:00Z');

    writeFileSync(path, JSON.stringify({ last_status: { at: '2026-01-02T00:00:00Z' } }));
    expect(readRationState(path).tick_at).toBe('2026-01-02T00:00:00Z');
  });

  it('MM shows the governor halt WITH numbers even without a wallet_settings row', async () => {
    const feed = await makeService(
      makeQuota(snapshot({ RCR: 72, 'RCR MM': 87 }, NOW.toISOString())),
      makeRepos(),
    ).feed();

    const mm = feed.wallets.MM;
    expect(mm.parked).toBe(false); // no wallet_settings row at all
    expect(mm.halted).toBe(true); // the governor says allow=false / halt=true
    expect(mm.used_today_pct).toBeCloseTo(17.837839, 6);
    expect(mm.allowed_today_pct).not.toBeNull();
    expect(mm.weekly_pct_left).toBeCloseTo(87, 6);
    expect(mm.published).toBe(true);
    expect(mm.source).toBe('minimax-token-plan');
  });

  it('owner arithmetic holds: allowed today = base + reserve + rollover, capped by the governor line', async () => {
    const feed = await makeService(
      makeQuota(
        snapshot({ RCR: 72, CCR: 72, 'RCR MM': 87, 'RCR Backup': 5 }, NOW.toISOString()),
      ),
      makeRepos(),
    ).feed();

    const main = feed.wallets.MAIN;
    expect(main.formula.base_pct).toBe(10);
    // The visible strip always sums to the served line.
    expect(
      main.formula.base_pct! + main.formula.reserve_pct! + main.formula.rollover_pool_pct!,
    ).toBeCloseTo(main.allowed_today_pct!, 6);
    // zai-max: governor usable 14.285714 = 10 base + 4.285714 reserve.
    expect(main.allowed_today_pct).toBeCloseTo(14.285714, 6);
    expect(main.used_today_pct).toBeCloseTo(4.7214, 6);
    expect(main.weekly_spent_pct).toBeCloseTo(3.7768, 6);

    const backup = feed.wallets.BACKUP;
    expect(
      backup.formula.base_pct! +
        backup.formula.reserve_pct! +
        backup.formula.rollover_pool_pct!,
    ).toBeCloseTo(backup.allowed_today_pct!, 6);
    expect(backup.allowed_today_pct).toBeCloseTo(10, 6);
  });
});
