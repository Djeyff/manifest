import { PublicQuotaService, publicQuotaFilePath } from './public-quota.service';
import { writeFileSync, mkdtempSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ZaiQuotaSnapshot } from '../zai-quota/zai-quota-monitor';

/**
 * Receipts for the public quota surface (ret500-nodupe):
 *  1. the owner's day-2 arithmetic is served verbatim (10 + reserve + rollover
 *     = allowed today; 14.4 + 10 = 28.4 cumulative; floor 71.6),
 *  2. the stale drill: a dead provider poll still serves the feed with
 *     `stale: true` and last-known values — never a blank, never a 404,
 *  3. a parked wallet keeps its row with numbers (parked ≠ hidden).
 */

let rationDir: string;
let lastKnownPath: string;

/** Day-2 published governor state matching the owner's own arithmetic. */
function writeRationFile(): string {
  // NOW = 2026-11-22T14:00Z (epoch 1795356000). The ration day started 4h
  // ago at 10:00Z so the pace maths has a real elapsed window to burn in.
  const nowEpoch = 1795356000;
  const dayEpoch = nowEpoch - 4 * 3600; // 2026-11-22T10:00:00Z
  const weekStart = dayEpoch - 86400;
  const state = {
    updated_at: nowEpoch,
    day_start_utc: '10:00',
    week_start: weekStart,
    day_epoch: dayEpoch,
    rollover: { enabled: true, day_epoch: dayEpoch },
    enforce_tick: { at: '2026-11-22T13:55:00.000Z', source: 'test' },
    last_status: {
      week_start: weekStart,
      day_start_utc: '10:00',
      accounts: {
        'zai-max': {
          acct_keys: ['RCR', 'CCR'],
          denomination: 'credits',
          weekly_pool: 140000,
          spent_week_pct: 28.4,
          spent_today_pct: 14.4,
          decision: {
            account: 'zai-max',
            allow: true,
            halt: false,
            usable_pct: 14.4,
            spent_today_pct: 14.4,
            remaining_today_pct: 0,
            base_pct: 10.0,
            reserve_pct: 0.4,
            rollover_pool_pct: 4.0,
            floor_pct: 71.6,
          },
        },
        minimax: {
          acct_keys: ['RCR MM', 'CCR MM'],
          denomination: 'tokens',
          weekly_pool: 100000,
          spent_week_pct: 9.0,
          spent_today_pct: 5.1,
          decision: {
            account: 'minimax',
            allow: true,
            halt: false,
            usable_pct: 11.5,
            spent_today_pct: 5.1,
            base_pct: 10.0,
            reserve_pct: 0.5,
            rollover_pool_pct: 1.0,
            floor_pct: 91.0,
          },
        },
      },
    },
  };
  const path = join(rationDir, 'ret670-ration.json');
  writeFileSync(path, JSON.stringify(state));
  return path;
}

interface LabelOverride {
  weekly_pct_left?: number | null;
  five_h_pct_left?: number | null;
  seen_at?: string | null;
}

function snapshot(
  labels: Record<string, LabelOverride>,
  polledAt: string | null,
): ZaiQuotaSnapshot {
  const built: ZaiQuotaSnapshot['labels'] = {};
  for (const [label, o] of Object.entries(labels)) {
    built[label] = {
      label,
      provider: 'zai',
      five_h_pct_left: o.five_h_pct_left ?? 60,
      weekly_pct_left: o.weekly_pct_left ?? null,
      five_h_reset_at: null,
      weekly_reset_at: null,
      plan_level: 'max',
      subscription_status: 'active',
      seen_at: o.seen_at ?? polledAt,
      error: null,
    } as ZaiQuotaSnapshot['labels'][string];
  }
  return { labels: built, polled_at: polledAt, polls: 1, poll_errors: 0 };
}

const NOW = new Date('2026-11-22T14:00:00.000Z');

function makeRepos(opts?: { parked?: boolean; wallets?: Array<{ id: string; name: string }> }) {
  const wallets = opts?.wallets ?? [
    { id: 'w-main', name: 'MAIN' },
    { id: 'w-mm', name: 'MM' },
    { id: 'w-backup', name: 'BACKUP' },
  ];
  const members = [
    { wallet_id: 'w-main', tenant_provider_id: 'k-rcr', tenant_id: 't1' },
    { wallet_id: 'w-main', tenant_provider_id: 'k-ccr', tenant_id: 't1' },
    { wallet_id: 'w-mm', tenant_provider_id: 'k-mm1', tenant_id: 't1' },
    { wallet_id: 'w-backup', tenant_provider_id: 'k-bkp', tenant_id: 't1' },
  ];
  const keys = [
    { id: 'k-rcr', label: 'RCR', provider: 'zai' },
    { id: 'k-ccr', label: 'CCR', provider: 'zai' },
    { id: 'k-mm1', label: 'RCR MM', provider: 'minimax' },
    { id: 'k-bkp', label: 'RCR Backup', provider: 'zai' },
  ];
  return {
    walletRepo: {
      find: jest.fn(async () => wallets.map((w) => ({ ...w, tenant_id: 't1', color: 'indigo' }))),
    },
    memberRepo: { find: jest.fn(async () => members) },
    providerRepo: { find: jest.fn(async () => keys) },
    settingsRepo: {
      findOne: jest.fn(async ({ where }: { where: { wallet_id: string } }) => ({
        wallet_id: where.wallet_id,
        parked: opts?.parked === true && where.wallet_id === 'w-mm',
        priority: 100,
      })),
    },
  };
}

function makeQuota(snap: ZaiQuotaSnapshot, fail = false) {
  return {
    tick: jest.fn(async () => {
      if (fail) throw new Error('provider unreachable');
    }),
    snapshot: jest.fn(() => snap),
  };
}

function makeService(quota: unknown, repos: ReturnType<typeof makeRepos>) {
  const svc = new PublicQuotaService(
    quota as never,
    repos.walletRepo as never,
    repos.memberRepo as never,
    repos.providerRepo as never,
    repos.settingsRepo as never,
  );
  return svc;
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
  rationDir = mkdtempSync(join(tmpdir(), 'ret500-spec-'));
  writeRationFile();
  lastKnownPath = join(rationDir, 'last-known.json');
  process.env.MANIFEST_RET670_RATION_FILE = join(rationDir, 'ret670-ration.json');
  process.env.MANIFEST_PUBLIC_QUOTA_FILE = lastKnownPath;
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.MANIFEST_RET670_RATION_FILE;
  delete process.env.MANIFEST_PUBLIC_QUOTA_FILE;
});

describe('PublicQuotaService (ret500-nodupe)', () => {
  it('serves the owner day-2 arithmetic on MAIN: 10 + reserve + rollover = allowed, cumulative 28.4, floor 71.6', async () => {
    const repos = makeRepos();
    const quota = makeQuota(
      snapshot(
        {
          RCR: { weekly_pct_left: 71.6 },
          CCR: { weekly_pct_left: 75 },
          'RCR MM': { weekly_pct_left: 90 },
        },
        NOW.toISOString(),
      ),
    );
    const feed = await makeService(quota, repos).feed();

    const main = feed.wallets.MAIN;
    expect(main.formula.base_pct).toBe(10);
    expect(main.formula.reserve_pct).toBeCloseTo(0.4, 6);
    expect(main.formula.rollover_pool_pct).toBe(4);
    // allowed-today = base + reserve + rollover (the owner's own sum)
    expect(
      main.formula.base_pct! + main.formula.reserve_pct! + main.formula.rollover_pool_pct!,
    ).toBeCloseTo(main.allowed_today_pct!, 6);
    expect(main.used_today_pct).toBeCloseTo(14.4, 6);
    // cumulative 14.4 + 10 (yesterday) + 4 = 28.4 spent → 71.6 of the week left
    expect(main.weekly_spent_pct).toBeCloseTo(28.4, 6);
    expect(main.weekly_pct_left).toBeCloseTo(71.6, 6); // min across the wallet's own keys
    expect(main.source).toBe('zai-coding-plan');
    expect(main.parked).toBe(false);
    expect(main.stale).toBe(false);
    expect(main.stale).toBeDefined();
    // the JSON contract fields the owner's local app mirrors
    for (const field of [
      'weekly_pct_left',
      'used_today_pct',
      'allowed_today_pct',
      'pace',
      'parked',
      'stale',
      'polled_at',
      'source',
    ]) {
      expect(main).toHaveProperty(field);
    }
    expect(feed).toHaveProperty('tick_at');
  });

  it('stale drill: a dead provider poll serves last-known values with stale: true — never blanks', async () => {
    const repos = makeRepos();
    const fresh = makeQuota(
      snapshot(
        { RCR: { weekly_pct_left: 71.6 }, 'RCR MM': { weekly_pct_left: 90 } },
        NOW.toISOString(),
      ),
    );
    const first = await makeService(fresh, repos).feed();
    expect(first.wallets.MM.stale).toBe(false);
    expect(first.wallets.MM.used_today_pct).not.toBeNull();

    // Second feed: the provider poll now fails AND the labels are gone —
    // the exact MM-parked failure mode this card fixes. polled_at falls back
    // to the last snapshot stamp (stale) instead of blanking.
    const dead = makeQuota(snapshot({}, new Date(NOW.getTime() - 3_600_000).toISOString()), true);
    const second = await makeService(dead, makeRepos({ parked: true })).feed();
    expect(second.stale).toBe(true);
    for (const name of ['MAIN', 'MM', 'BACKUP'] as const) {
      expect(second.wallets[name]).toBeDefined();
    }
    expect(second.wallets.MAIN.stale).toBe(true);
    expect(second.wallets.MAIN.used_today_pct).not.toBeNull();
    expect(second.wallets.MAIN.polled_at).not.toBeNull();
    // park does not hide the row or blank the numbers
    expect(second.wallets.MM.parked).toBe(true);
  });

  it('parked wallet keeps its full row: parked badge true, numbers present, never hidden', async () => {
    const repos = makeRepos({ parked: true });
    const feed = await makeService(
      makeQuota(
        snapshot(
          { RCR: { weekly_pct_left: 71.6 }, 'RCR MM': { weekly_pct_left: 90 } },
          NOW.toISOString(),
        ),
      ),
      repos,
    ).feed();
    const mm = feed.wallets.MM;
    expect(mm.parked).toBe(true);
    expect(mm.used_today_pct).not.toBeNull();
    expect(mm.allowed_today_pct).not.toBeNull();
    expect(mm.weekly_pct_left).not.toBeNull();
    expect(mm.pace).not.toBeNull();
    expect(mm.source).toBe('minimax-token-plan');
    expect(mm.projection).not.toBeNull();
  });

  it('all three wallet rows always exist even with no DB rows at all', async () => {
    const repos = makeRepos({ wallets: [] });
    const feed = await makeService(makeQuota(snapshot({}, null), true), repos).feed();
    expect(Object.keys(feed.wallets).sort()).toEqual(['BACKUP', 'MAIN', 'MM']);
    expect(feed.stale).toBe(true);
    expect(feed.ration_available).toBe(true);
  });

  it('last-known file persists rows for a restart', async () => {
    const repos = makeRepos();
    await makeService(
      makeQuota(
        snapshot(
          { RCR: { weekly_pct_left: 71.6 }, 'RCR MM': { weekly_pct_left: 90 } },
          NOW.toISOString(),
        ),
      ),
      repos,
    ).feed();
    // the write chain is async fire-and-forget — poll briefly for the file
    for (let i = 0; i < 50 && !existsSync(lastKnownPath); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(existsSync(lastKnownPath)).toBe(true);
    const saved = JSON.parse(readFileSync(lastKnownPath, 'utf8'));
    expect(Object.keys(saved.wallets)).toEqual(expect.arrayContaining(['MAIN', 'MM']));
  });
});
